package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/report"
	"opsvision/internal/store"
)

const (
	maxReportSummaryRunes = 8000
	reportMonthsBack      = 11
	reportMonthsCap       = 36
	reportTrendMonths     = 5
	reportJSON            = "application/json"
)

func parseReportMonth(pr *problems, path string, s Period) (period.Period, bool) {
	p, ok := parsePeriod(pr, path, string(s))
	if !ok {
		return period.Period{}, false
	}
	if p.Grain != period.Month {
		pr.add(path, "must be a month such as 2026-M10")
		return period.Period{}, false
	}
	return p, true
}

func apiReportSummary(s domain.ReportSummary) ReportSummary {
	out := ReportSummary{Text: s.Text, Revision: s.Revision}
	if s.Revision > 0 {
		out.UpdatedBy = &s.UpdatedBy
		out.UpdatedAt = &s.UpdatedAt
	}
	return out
}

// GetReportSummary returns the company-scope summary for a month.
func (s *Server) GetReportSummary(ctx context.Context, req GetReportSummaryRequestObject) (GetReportSummaryResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
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
	sum, err := s.store.GetReportSummary(ctx, p.Tenant.ID, req.Sc, mo.String())
	if errors.Is(err, store.ErrNotFound) {
		return GetReportSummary200JSONResponse(ReportSummary{Text: "", Revision: 0}), nil
	}
	if err != nil {
		return nil, err
	}
	return GetReportSummary200JSONResponse(apiReportSummary(sum)), nil
}

// PutReportSummary saves the company-scope summary. Admins only.
func (s *Server) PutReportSummary(ctx context.Context, req PutReportSummaryRequestObject) (PutReportSummaryResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	mo, ok := parseReportMonth(&pr, "period", req.Period)
	if !ok {
		if err := pr.err(); err != nil {
			return nil, err
		}
	}
	b := *req.Body
	if b.ExpectedRevision < 0 {
		pr.add("expectedRevision", "must not be negative")
	}
	if utf8.RuneCountInString(b.Text) > maxReportSummaryRunes {
		pr.add("text", "must be at most %d characters", maxReportSummaryRunes)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	before, _ := s.store.GetReportSummary(ctx, p.Tenant.ID, req.Sc, mo.String())
	stored, err := s.store.PutReportSummary(ctx, p.Tenant.ID, req.Sc, mo.String(), b.Text, p.UserID, b.ExpectedRevision, s.now())
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, conflict("the summary changed since it was loaded; reload it and try again")
		}
		return nil, err
	}
	out := apiReportSummary(stored)
	var beforeAPI any
	if before.Revision > 0 {
		beforeAPI = apiReportSummary(before)
	}
	if err := s.audit(ctx, p, p.Tenant.ID, "report.summary", "report", mo.String(), beforeAPI, out); err != nil {
		return nil, err
	}
	return PutReportSummary200JSONResponse(out), nil
}

// ListReportMonths lists months in the report history window.
func (s *Server) ListReportMonths(ctx context.Context, req ListReportMonthsRequestObject) (ListReportMonthsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	revisions, err := s.store.ListReportRevisions(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	byPeriod := latestRevisionsByPeriod(revisions)
	cal := s.calendar(*p.Tenant)
	months := reportHistoryMonths(cal, s.now(), revisions)
	out := make([]ReportMonth, 0, len(months))
	for _, mo := range months {
		ps := mo.String()
		entry := ReportMonth{Period: MonthPeriod(ps), Status: ReportMonthStatusLive, Revision: 0}
		if rev, ok := byPeriod[ps]; ok {
			entry.Status = ReportMonthStatusPublished
			entry.Revision = rev.Revision
			pb := UserId(rev.PublishedBy)
			entry.PublishedBy = &pb
			at := rev.PublishedAt
			entry.PublishedAt = &at
		}
		out = append(out, entry)
	}
	return ListReportMonths200JSONResponse(ReportMonthList{Months: out}), nil
}

func latestRevisionsByPeriod(revisions []domain.ReportRevision) map[string]domain.ReportRevision {
	out := map[string]domain.ReportRevision{}
	for _, r := range revisions {
		cur, ok := out[r.Period]
		if !ok || r.Revision > cur.Revision {
			out[r.Period] = r
		}
	}
	return out
}

func reportHistoryMonths(cal period.Calendar, now time.Time, published []domain.ReportRevision) []period.Period {
	cur := cal.MonthOf(now)
	latest := cur
	if len(published) > 0 {
		if p, err := period.Parse(published[0].Period); err == nil && monthBefore(latest, p) {
			latest = p
		}
	}
	start := latest
	for i := 0; i < reportMonthsBack; i++ {
		start = cal.Prev(start)
	}
	var out []period.Period
	for m := start; len(out) < reportMonthsCap; m = monthAfter(cal, m) {
		out = append(out, m)
		if m == latest {
			break
		}
	}
	return out
}

func monthAfter(cal period.Calendar, m period.Period) period.Period {
	// Inverse of Prev for months: try next index, else next FY M01.
	if m.Index < 12 {
		return period.Period{Grain: period.Month, FY: m.FY, Index: m.Index + 1}
	}
	return period.Period{Grain: period.Month, FY: m.FY + 1, Index: 1}
}

// PublishReport freezes a company-scope snapshot for the month.
func (s *Server) PublishReport(ctx context.Context, req PublishReportRequestObject) (PublishReportResponseObject, error) {
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
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	summaryText := ""
	if req.Body != nil && req.Body.Summary != nil {
		summaryText = *req.Body.Summary
	} else if sum, err := s.store.GetReportSummary(ctx, p.Tenant.ID, req.Sc, mo.String()); err == nil {
		summaryText = sum.Text
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	apiView, err := s.companyReportView(ctx, *p.Tenant, sc.ID, mo)
	if err != nil {
		return nil, err
	}
	facts := reportStrings(report.Facts(factsViewFromAPI(apiView, mo.String()), statusScale(*p.Tenant)))
	verIDs := reportStrings(versionIDsFromView(apiView))
	viewRaw, err := json.Marshal(apiView)
	if err != nil {
		return nil, err
	}
	doc := report.Document{
		Period: mo.String(), GeneratedAt: s.now(), Summary: summaryText,
		Facts: facts, VersionIds: verIDs, View: viewRaw,
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	revNum, err := s.nextReportRevision(ctx, p.Tenant.ID, req.Sc, mo.String())
	if err != nil {
		return nil, err
	}
	key := report.ObjectKey(p.Tenant.ID, req.Sc, mo.String(), revNum)
	if err := objs.Put(ctx, key, reportJSON, raw); err != nil {
		return nil, err
	}
	rev := domain.ReportRevision{
		Period: mo.String(), Revision: revNum, PublishedBy: p.UserID,
		PublishedAt: s.now(), ObjectKey: key,
	}
	if err := s.store.PutReportRevision(ctx, p.Tenant.ID, req.Sc, rev); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, p.Tenant.ID, "report.publish", "report", mo.String(), nil, map[string]any{
		"period": mo.String(), "revision": revNum,
	}); err != nil {
		return nil, err
	}
	return PublishReport200JSONResponse(PublishReportResponse{Revision: revNum, Unlocked: true}), nil
}

func (s *Server) nextReportRevision(ctx context.Context, tenantID, scorecardID, period string) (int, error) {
	revisions, err := s.store.ListReportRevisions(ctx, tenantID, scorecardID)
	if err != nil {
		return 0, err
	}
	max := 0
	for _, r := range revisions {
		if r.Period == period && r.Revision > max {
			max = r.Revision
		}
	}
	return max + 1, nil
}

// GetReportDocument returns a live or published report.
func (s *Server) GetReportDocument(ctx context.Context, req GetReportDocumentRequestObject) (GetReportDocumentResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
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
	forceLive := false
	var wantRev int
	if req.Params.Revision != nil {
		switch *req.Params.Revision {
		case "live":
			forceLive = true
		default:
			n, err := strconv.Atoi(*req.Params.Revision)
			if err != nil || n < 1 {
				pr.add("revision", "must be live or a positive integer")
				if err := pr.err(); err != nil {
					return nil, err
				}
			}
			wantRev = n
		}
	}
	if forceLive {
		return s.liveReportDocument(ctx, p, req.Sc, mo)
	}
	if wantRev > 0 {
		return s.publishedReportDocument(ctx, p, req.Sc, mo, wantRev)
	}
	rev, ok, err := latestPublishedRevision(ctx, s.store, p.Tenant.ID, req.Sc, mo.String())
	if err != nil {
		return nil, err
	}
	if ok {
		return s.publishedReportDocument(ctx, p, req.Sc, mo, rev.Revision)
	}
	return s.liveReportDocument(ctx, p, req.Sc, mo)
}

func latestPublishedRevision(ctx context.Context, st store.Store, tenantID, scorecardID, period string) (domain.ReportRevision, bool, error) {
	revisions, err := st.ListReportRevisions(ctx, tenantID, scorecardID)
	if err != nil {
		return domain.ReportRevision{}, false, err
	}
	var best *domain.ReportRevision
	for i := range revisions {
		r := revisions[i]
		if r.Period != period {
			continue
		}
		if best == nil || r.Revision > best.Revision {
			best = &r
		}
	}
	if best == nil {
		return domain.ReportRevision{}, false, nil
	}
	return *best, true, nil
}

func (s *Server) liveReportDocument(ctx context.Context, p auth.Principal, scorecardID string, mo period.Period) (GetReportDocumentResponseObject, error) {
	summaryText := ""
	if sum, err := s.store.GetReportSummary(ctx, p.Tenant.ID, scorecardID, mo.String()); err == nil {
		summaryText = sum.Text
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	apiView, facts, err := s.memberReportView(ctx, p, scorecardID, mo)
	if err != nil {
		return nil, err
	}
	return GetReportDocument200JSONResponse(ReportDocument{
		Live: true, Revision: 0, DataRevised: false, Changes: reportChanges(nil),
		Summary: summaryText, Facts: reportStrings(facts), View: apiView, GeneratedAt: s.now(),
		SummaryScope: Company,
	}), nil
}

func (s *Server) publishedReportDocument(ctx context.Context, p auth.Principal, scorecardID string, mo period.Period, revision int) (GetReportDocumentResponseObject, error) {
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	revisions, err := s.store.ListReportRevisions(ctx, p.Tenant.ID, scorecardID)
	if err != nil {
		return nil, err
	}
	var meta *domain.ReportRevision
	for i := range revisions {
		r := revisions[i]
		if r.Period == mo.String() && r.Revision == revision {
			meta = &r
			break
		}
	}
	if meta == nil {
		return nil, notFound("report revision not found")
	}
	doc, snapView, err := loadReportSnapshot(ctx, objs, meta.ObjectKey)
	if err != nil {
		if errors.Is(err, objects.ErrNotFound) {
			return nil, notFound("report revision not found")
		}
		return nil, err
	}
	filteredSnap, err := s.filterScorecardView(ctx, p, scorecardID, mo, snapView)
	if err != nil {
		return nil, err
	}
	freshView, _, err := s.memberReportView(ctx, p, scorecardID, mo)
	if err != nil {
		return nil, err
	}
	dataRevised, changes := diffReportViews(filteredSnap, freshView)
	return GetReportDocument200JSONResponse(ReportDocument{
		Live: false, Revision: revision, DataRevised: dataRevised, Changes: reportChanges(changes),
		Summary: doc.Summary, Facts: reportStrings(doc.Facts), View: filteredSnap, GeneratedAt: doc.GeneratedAt,
		SummaryScope: Company,
	}), nil
}

func loadReportSnapshot(ctx context.Context, objs objects.Store, key string) (report.Document, ScorecardView, error) {
	rc, _, err := objs.Get(ctx, key)
	if err != nil {
		return report.Document{}, ScorecardView{}, err
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return report.Document{}, ScorecardView{}, err
	}
	var doc report.Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return report.Document{}, ScorecardView{}, err
	}
	var view ScorecardView
	if err := json.Unmarshal(doc.View, &view); err != nil {
		return report.Document{}, ScorecardView{}, err
	}
	return doc, view, nil
}

func (s *Server) companyReportView(ctx context.Context, tenant domain.Tenant, scorecardID string, mo period.Period) (ScorecardView, error) {
	vr, cols, err := reportViewRequest(tenant, scorecardID, mo)
	if err != nil {
		return ScorecardView{}, err
	}
	in, err := s.loadInput(ctx, tenant, scorecardID, fiscalYears(true, cols...))
	if err != nil {
		return ScorecardView{}, err
	}
	view, err := engine.Compute(in, vr)
	if err != nil {
		return ScorecardView{}, err
	}
	cutoffs, err := s.viewCutoffs(ctx, tenant.ID, in, vr.Periods)
	if err != nil {
		return ScorecardView{}, err
	}
	return apiView(view, nil, cutoffs), nil
}

func (s *Server) memberReportView(ctx context.Context, p auth.Principal, scorecardID string, mo period.Period) (ScorecardView, []string, error) {
	vr, cols, err := reportViewRequest(*p.Tenant, scorecardID, mo)
	if err != nil {
		return ScorecardView{}, nil, err
	}
	in, err := s.loadInput(ctx, *p.Tenant, scorecardID, fiscalYears(true, cols...))
	if err != nil {
		return ScorecardView{}, nil, err
	}
	view, err := engine.Compute(in, vr)
	if err != nil {
		return ScorecardView{}, nil, err
	}
	cutoffs, err := s.viewCutoffs(ctx, p.Tenant.ID, in, vr.Periods)
	if err != nil {
		return ScorecardView{}, nil, err
	}
	asOf := mo
	acc := newAccess(p, in)
	filtered := apiView(view, func(r engine.Row) bool {
		return acc.canRead(r.SubjectID, []string{r.MetricKey}, asOf)
	}, cutoffs)
	company := apiView(view, nil, cutoffs)
	facts := reportStrings(report.Facts(factsViewFromAPI(company, mo.String()), statusScale(*p.Tenant)))
	return filtered, facts, nil
}

func (s *Server) filterScorecardView(ctx context.Context, p auth.Principal, scorecardID string, mo period.Period, v ScorecardView) (ScorecardView, error) {
	in, err := s.loadInput(ctx, *p.Tenant, scorecardID, fiscalYears(true, mo))
	if err != nil {
		return ScorecardView{}, err
	}
	acc := newAccess(p, in)
	keep := map[string]struct{}{}
	for _, r := range v.Rows {
		if acc.canRead(r.SubjectId, []string{r.MetricKey}, mo) {
			keep[r.MetricKey+"/"+r.SubjectId] = struct{}{}
		}
	}
	out := v
	out.Rows = slices.DeleteFunc(slices.Clone(v.Rows), func(r ViewRow) bool {
		_, ok := keep[r.MetricKey+"/"+r.SubjectId]
		return !ok
	})
	return out, nil
}

func reportStrings(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}

func reportChanges(cc []ReportChange) []ReportChange {
	if cc == nil {
		return []ReportChange{}
	}
	return cc
}

func reportViewRequest(tenant domain.Tenant, scorecardID string, mo period.Period) (engine.ViewRequest, []period.Period, error) {
	cal := period.Calendar{FiscalYearStartMonth: tenant.FiscalYearStartMonth}
	months := []period.Period{mo}
	m := mo
	for i := 0; i < reportTrendMonths; i++ {
		m = cal.Prev(m)
		months = append([]period.Period{m}, months...)
	}
	vr := engine.ViewRequest{
		Structure: engine.StructureAsOf,
		Periods:   months,
		YTD:       []period.Period{mo},
	}
	return vr, append(months, mo), nil
}

func factsViewFromAPI(v ScorecardView, reportPeriod string) report.FactsView {
	out := report.FactsView{ReportPeriod: reportPeriod, Rows: make([]report.FactsRow, 0, len(v.Rows))}
	for _, r := range v.Rows {
		row := report.FactsRow{
			MetricKey: r.MetricKey, MetricName: r.MetricName,
			SubjectID: r.SubjectId, Depth: r.Depth,
		}
		for _, c := range r.Cells {
			if c.Ytd {
				continue
			}
			row.Cells = append(row.Cells, report.FactsCell{
				Period: string(c.Period), Value: c.Value, Display: c.Display,
				Status: string(c.Status), NAReason: c.NaReason,
			})
		}
		out.Rows = append(out.Rows, row)
	}
	return out
}

func versionIDsFromView(v ScorecardView) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, id := range v.VersionByPeriod {
		s := string(id)
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func diffReportViews(was, live ScorecardView) (bool, []ReportChange) {
	type cellKey struct {
		metric, subject, period string
	}
	wasCells := map[cellKey]Cell{}
	for _, r := range was.Rows {
		for _, c := range r.Cells {
			wasCells[cellKey{r.MetricKey, r.SubjectId, string(c.Period)}] = c
		}
	}
	changes := make([]ReportChange, 0)
	for _, r := range live.Rows {
		for _, c := range r.Cells {
			if c.Ytd {
				continue
			}
			k := cellKey{r.MetricKey, r.SubjectId, string(c.Period)}
			old, ok := wasCells[k]
			if !ok {
				continue
			}
			if !cellValueEqual(old, c) {
				changes = append(changes, ReportChange{
					MetricKey: r.MetricKey, SubjectId: r.SubjectId, Period: c.Period,
					Was: cellDisplayLabel(old), Now: cellDisplayLabel(c),
				})
			}
		}
	}
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Period != changes[j].Period {
			return changes[i].Period < changes[j].Period
		}
		if changes[i].MetricKey != changes[j].MetricKey {
			return changes[i].MetricKey < changes[j].MetricKey
		}
		return changes[i].SubjectId < changes[j].SubjectId
	})
	return len(changes) > 0, changes
}

func cellValueEqual(a, b Cell) bool {
	if a.Value == nil && b.Value != nil || a.Value != nil && b.Value == nil {
		return false
	}
	if a.Value != nil && b.Value != nil && *a.Value != *b.Value {
		return false
	}
	return string(a.Status) == string(b.Status)
}

func cellDisplayLabel(c Cell) string {
	if c.Display == "" && c.Status == "" {
		return ""
	}
	if c.Status == "" {
		return c.Display
	}
	if c.Display == "" {
		return string(c.Status)
	}
	return fmt.Sprintf("%s %s", c.Display, c.Status)
}
