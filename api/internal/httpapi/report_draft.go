package httpapi

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strings"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

const msgStillDrafting = "SAM is still drafting this summary. Wait for the draft before asking again."

// draftNeedsAttention is how many metrics the report's needs-attention list
// shows.
const draftNeedsAttention = 3

func draftExpired(d domain.AssistantDraft, now time.Time) bool {
	return now.Sub(d.CreatedAt) >= assistant.DraftTTL
}

func draftStale(d domain.AssistantDraft, now time.Time) bool {
	return d.Status == domain.AssistantStatusPending && now.Sub(d.CreatedAt) >= assistant.StalePending
}

func apiReportSummaryDraft(d domain.AssistantDraft, now time.Time) ReportSummaryDraft {
	if draftStale(d, now) {
		d.Status, d.Error = domain.AssistantStatusError, assistant.MsgStale
	}
	out := ReportSummaryDraft{Id: d.ID, Pending: d.Status == domain.AssistantStatusPending, CreatedAt: d.CreatedAt}
	switch d.Status {
	case domain.AssistantStatusDone:
		out.Text = &d.Text
	case domain.AssistantStatusError:
		out.Error = &d.Error
	}
	if u := d.Usage; u != nil {
		out.Usage = &AssistantUsage{Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, ToolCalls: u.ToolCalls}
	}
	return out
}

// DraftReportSummary stores a pending draft of the month's company-scope
// summary for the calling admin and enqueues the job that writes it.
func (s *Server) DraftReportSummary(ctx context.Context, req DraftReportSummaryRequestObject) (DraftReportSummaryResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	mo, ok := parseReportMonth(&pr, "period", req.Period)
	if req.Body != nil && req.Body.Scope != nil && strings.TrimSpace(*req.Body.Scope) != "" {
		pr.add("scope", "must be empty: the summary is written for the whole company")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	if !ok {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "invalid"})
	}
	if s.queue == nil || s.sealer == nil || s.provider == nil {
		return nil, assistantUnavailable(msgNotSetUp)
	}
	settings, err := s.store.GetAssistantSettings(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, conflict(assistant.MsgDisabled)
	}
	if _, err := s.store.GetCredential(ctx, p.Tenant.ID, p.UserID); errors.Is(err, store.ErrNotFound) {
		return nil, conflict(assistant.MsgDraftNoKey)
	} else if err != nil {
		return nil, err
	}

	now := s.now()
	drafts, err := s.store.ListDrafts(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	var kept, gone []domain.AssistantDraft
	for _, d := range drafts {
		if draftExpired(d, now) {
			gone = append(gone, d)
			continue
		}
		if d.Status == domain.AssistantStatusPending && !draftStale(d, now) && d.ScorecardID == sc.ID && d.Period == mo.String() {
			return nil, conflict(msgStillDrafting)
		}
		kept = append(kept, d)
	}
	if len(kept) >= assistant.MaxDraftsPerUser {
		gone = append(gone, kept[assistant.MaxDraftsPerUser-1:]...)
	}
	for _, d := range gone {
		if err := s.store.DeleteDraft(ctx, p.Tenant.ID, p.UserID, d.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}

	d := domain.AssistantDraft{
		ID: s.newID(), UserID: p.UserID, ScorecardID: sc.ID, Period: mo.String(),
		Status: domain.AssistantStatusPending, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.PutDraft(ctx, p.Tenant.ID, d, 0); err != nil {
		return nil, err
	}
	ref := assistant.TurnRef{Kind: assistant.KindDraft, TenantID: p.Tenant.ID, UserID: p.UserID, DraftID: d.ID}
	if err := s.queue.Enqueue(ctx, ref); err != nil {
		slog.Error("httpapi: could not enqueue a summary draft", "tenant", p.Tenant.ID, "draft", d.ID, "err", err)
		d.Status, d.Error = domain.AssistantStatusError, msgCouldNotStart
		if err := s.store.PutDraft(ctx, p.Tenant.ID, d, 1); err != nil {
			slog.Error("httpapi: could not mark an unstarted summary draft failed", "draft", d.ID, "err", err)
		}
		return nil, assistantUnavailable(msgCouldNotStart)
	}
	return DraftReportSummary202JSONResponse(apiReportSummaryDraft(d, now)), nil
}

// GetReportSummaryDraft returns one of the calling admin's drafts of the
// month's summary.
func (s *Server) GetReportSummaryDraft(ctx context.Context, req GetReportSummaryDraftRequestObject) (GetReportSummaryDraftResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	mo, ok := parseReportMonth(&pr, "period", req.Period)
	if err := pr.err(); err != nil {
		return nil, err
	}
	if !ok {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "invalid"})
	}
	now := s.now()
	d, err := s.store.GetDraft(ctx, p.Tenant.ID, p.UserID, req.Id)
	if errors.Is(err, store.ErrNotFound) || err == nil && (d.ScorecardID != sc.ID || d.Period != mo.String() || draftExpired(d, now)) {
		return nil, notFound("no such draft")
	}
	if err != nil {
		return nil, err
	}
	return GetReportSummaryDraft200JSONResponse(apiReportSummaryDraft(d, now)), nil
}

// DraftReport implements assistant.ReportSource: the live company-scope
// report of the month as p may read it, the same rows and facts the report
// page shows at company scope.
func (s *Server) DraftReport(ctx context.Context, p auth.Principal, scorecardID, month string) (assistant.DraftReport, error) {
	if p.Tenant == nil || p.Membership == nil {
		return assistant.DraftReport{}, errors.New("httpapi: a draft report needs a member")
	}
	sc, err := s.store.GetScorecard(ctx, p.Tenant.ID, scorecardID)
	if err != nil {
		return assistant.DraftReport{}, err
	}
	mo, err := period.Parse(month)
	if err != nil || mo.Grain != period.Month {
		return assistant.DraftReport{}, fmt.Errorf("httpapi: a draft report needs a month, not %q", month)
	}
	view, facts, err := s.memberReportView(ctx, p, sc.ID, mo)
	if err != nil {
		return assistant.DraftReport{}, err
	}
	out := draftReport(view, mo.String(), statusScale(*p.Tenant))
	out.Organization, out.ScorecardName, out.Facts = p.Tenant.Name, sc.Name, facts
	out.MonthLabel = s.calendar(*p.Tenant).Start(mo).Format("January 2006")
	return out, nil
}

// draftMetric is one metric's rows as the report page reads them: the
// shallowest org-unit row is the scope (the company at company scope) and
// the rows one level below are its children. A metric with no org-unit row
// has no scope; all its rows are children.
type draftMetric struct {
	key      string
	category Category
	scope    *ViewRow
	children []ViewRow
	head     ViewRow
}

func draftMetrics(v ScorecardView) []draftMetric {
	cats := slices.Clone(v.Categories)
	slices.SortStableFunc(cats, func(a, b Category) int { return cmp.Compare(a.Order, b.Order) })
	byCat := map[string][]*draftMetric{}
	byKey := map[string]*draftMetric{}
	var unknown []string
	known := map[string]bool{}
	for _, c := range cats {
		known[c.Id] = true
	}
	for _, r := range v.Rows {
		m := byKey[r.MetricKey]
		if m == nil {
			m = &draftMetric{key: r.MetricKey, category: Category{Id: r.CategoryId, Name: "Other"}}
			byKey[r.MetricKey] = m
			if !known[r.CategoryId] && byCat[r.CategoryId] == nil {
				unknown = append(unknown, r.CategoryId)
			}
			byCat[r.CategoryId] = append(byCat[r.CategoryId], m)
		}
		m.children = append(m.children, r)
	}
	var out []draftMetric
	add := func(id string, c *Category) {
		for _, m := range byCat[id] {
			if c != nil {
				m.category = *c
			}
			rows := m.children
			m.head, m.children = rows[0], rows
			for i := range rows {
				if rows[i].SubjectKind == Unit && (m.scope == nil || rows[i].Depth < m.scope.Depth) {
					m.scope = &rows[i]
				}
			}
			if m.scope != nil {
				m.head = *m.scope
				m.children = slices.DeleteFunc(slices.Clone(rows), func(r ViewRow) bool { return r.Depth != m.scope.Depth+1 })
			}
			out = append(out, *m)
		}
	}
	for i := range cats {
		add(cats[i].Id, &cats[i])
	}
	for _, id := range unknown {
		add(id, nil)
	}
	return out
}

func monthCell(r *ViewRow, p string) *Cell {
	if r == nil {
		return nil
	}
	for i := range r.Cells {
		if !r.Cells[i].Ytd && string(r.Cells[i].Period) == p {
			return &r.Cells[i]
		}
	}
	return nil
}

func cellReported(c *Cell) bool {
	return c != nil && (c.Value != nil || c.Status != "" && c.NaReason == "")
}

// statusAt is the metric's status in month p: the scope's when reported,
// else the worst of its reported children, with a caption saying so.
func (m draftMetric) statusAt(p string, rank map[string]int) (status, caption string) {
	if c := monthCell(m.scope, p); cellReported(c) {
		return c.Status, ""
	}
	n, worst := 0, -1
	for i := range m.children {
		c := monthCell(&m.children[i], p)
		if !cellReported(c) {
			continue
		}
		n++
		if r := rank[c.Status]; r > worst {
			worst, status = r, c.Status
		}
	}
	if n == 0 {
		return "", ""
	}
	noun := "items"
	switch {
	case m.head.ChartKind == "uptime":
		noun = "services"
	case m.scope != nil && len(m.children) > 0:
		noun = "segments"
	}
	if n == 1 {
		noun = strings.TrimSuffix(noun, "s")
	}
	return status, fmt.Sprintf("worst of %d %s", n, noun)
}

// draftReport is the report page's company-scope content for month: each
// category's metrics with their months, and the needs-attention list.
func draftReport(v ScorecardView, month string, scale []domain.StatusLevel) assistant.DraftReport {
	rank, label := map[string]int{}, map[string]string{}
	best, worst := math.MaxInt, math.MinInt
	for _, l := range scale {
		rank[l.Key], label[l.Key] = l.Rank, l.Label
		best, worst = min(best, l.Rank), max(worst, l.Rank)
	}
	labelOf := func(status string) string {
		if l, ok := label[status]; ok && l != "" {
			return l
		}
		return status
	}
	var months []string
	for _, p := range v.Periods {
		months = append(months, string(p))
	}
	prior := ""
	if i := slices.Index(months, month); i > 0 {
		prior = months[i-1]
	}

	out := assistant.DraftReport{Period: month, Months: months}
	type attention struct {
		metric                   assistant.DraftMetric
		tier, lost, order, index int
		distance                 float64
	}
	var items []attention
	lastCategory := ""
	for _, m := range draftMetrics(v) {
		status, caption := m.statusAt(month, rank)
		dm := assistant.DraftMetric{Name: m.head.MetricName, Category: m.category.Name, Status: labelOf(status), Caption: caption}
		for _, p := range months {
			st, _ := m.statusAt(p, rank)
			pt := assistant.DraftPoint{Period: p, Status: labelOf(st)}
			if c := monthCell(m.scope, p); c != nil {
				pt.NAReason = c.NaReason
				if c.NaReason == "" {
					pt.Value = c.Display
				} else {
					pt.Status = ""
				}
			}
			dm.Points = append(dm.Points, pt)
		}
		cur := monthCell(m.scope, month)
		if m.scope != nil {
			for _, c := range m.scope.Cells {
				if c.Ytd && c.Display != "" {
					dm.YTD = c.Display
				}
			}
		}
		if cur != nil && cur.Target != nil {
			dm.Target = engine.Format(string(m.head.Format), *cur.Target)
		}
		if len(out.Categories) == 0 || m.category.Id != lastCategory {
			out.Categories = append(out.Categories, assistant.DraftCategory{Name: m.category.Name})
			lastCategory = m.category.Id
		}
		cat := &out.Categories[len(out.Categories)-1]
		cat.Metrics = append(cat.Metrics, dm)

		if status == "" {
			continue
		}
		r := rank[status]
		priorStatus := ""
		if c := monthCell(m.scope, prior); prior != "" && c != nil {
			priorStatus = c.Status
		}
		lost := 0
		if priorStatus != "" {
			lost = r - rank[priorStatus]
		}
		tier := 0
		switch {
		case r == best:
			continue
		case r == worst:
			tier = 1
		case priorStatus != "" && lost >= 1:
			tier = 2
		case r > best && r < worst:
			tier = 3
		default:
			continue
		}
		items = append(items, attention{
			metric: dm, tier: tier, lost: lost, order: m.category.Order, index: len(items),
			distance: distancePastWorst(cur, m.head.Direction, scale, rank, worst),
		})
	}
	slices.SortStableFunc(items, func(a, b attention) int {
		if a.tier != b.tier {
			return cmp.Compare(a.tier, b.tier)
		}
		switch a.tier {
		case 1:
			if a.distance != b.distance {
				return cmp.Compare(b.distance, a.distance)
			}
		case 2:
			if a.lost != b.lost {
				return cmp.Compare(b.lost, a.lost)
			}
			if a.distance != b.distance {
				return cmp.Compare(b.distance, a.distance)
			}
		}
		return cmp.Compare(a.order, b.order)
	})
	for i := 0; i < len(items) && i < draftNeedsAttention; i++ {
		out.NeedsAttention = append(out.NeedsAttention, items[i].metric)
	}
	return out
}

// distancePastWorst is how far a month's value is past the threshold of
// the worst band, in band widths (or the size of the change for a change
// rule), as the report page ranks its needs-attention list.
func distancePastWorst(c *Cell, dir Direction, scale []domain.StatusLevel, rank map[string]int, worst int) float64 {
	if c == nil || c.Value == nil || c.Rule == nil {
		return 0
	}
	if c.Rule.Type == Change {
		if c.Change == nil {
			return 0
		}
		return math.Abs(*c.Change)
	}
	if c.Rule.Type != Bands || c.Rule.Bands == nil || len(*c.Rule.Bands) == 0 {
		return 0
	}
	worstKey := ""
	for _, l := range scale {
		if l.Rank == worst {
			worstKey = l.Key
			break
		}
	}
	bands := *c.Rule.Bands
	wi := slices.IndexFunc(bands, func(b Band) bool { return b.Status == worstKey })
	if worstKey == "" || wi < 0 {
		return 0
	}
	wb := bands[wi]
	threshold := wb.Value
	if wb.Op == "" {
		if wi == 0 {
			return 0
		}
		threshold = bands[wi-1].Value
	}
	width := 10.0
	switch {
	case wb.Op == "" && wi >= 2:
		width = orTen(math.Abs(bands[wi-2].Value - threshold))
	case wb.Op == "" && wi >= 1:
		width = orTen(math.Abs(bands[wi-1].Value - threshold))
	case wb.Op != "" && wi >= 1:
		width = orTen(math.Abs(threshold - bands[wi-1].Value))
	}
	v := *c.Value
	if dir == HigherBetter {
		if v >= threshold {
			return 0
		}
		return (threshold - v) / width
	}
	if v <= threshold {
		return 0
	}
	return (v - threshold) / width
}

func orTen(w float64) float64 {
	if w == 0 {
		return 10
	}
	return w
}
