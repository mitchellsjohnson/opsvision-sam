package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/report"
)

// List pages (spec §9.2, §9.6): full rows 16 to a page; default rows
// (excerpts, first 3 links) as many as fit under the byte budget, which
// keeps a page under MCP's 512 KB cut whatever the links weigh.
const (
	fullSummariesPage = 16
	listPageBytes     = 360 * 1024
)

// GetMetricSummary is one metric's exec summary for a period, whole, with
// its state, standing and top evidence. Readers of the company cell. With
// revision, the copy frozen in that published revision of the report month
// the period ends in.
func (s *Server) GetMetricSummary(ctx context.Context, req GetMetricSummaryRequestObject) (GetMetricSummaryResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.key("metric", req.Metric)
	per, _ := parsePeriod(&pr, "period", req.Period)
	if req.Params.Revision != nil && *req.Params.Revision < 1 {
		pr.add("revision", "must be a positive integer")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	if req.Params.Revision != nil {
		f, err := s.loadFrozen(ctx, p, sc.ID, per, *req.Params.Revision)
		if err != nil {
			return nil, err
		}
		// Access first: whether a metric has a frozen summary tells which
		// metrics were not perfect at company level.
		if !f.readable(report.SummarySnapshot{MetricKey: req.Metric}) {
			return nil, forbidden("you may not read this exec summary")
		}
		i := slices.IndexFunc(f.doc.Summaries, func(x report.SummarySnapshot) bool {
			return x.MetricKey == req.Metric && x.Period == per.String()
		})
		if i < 0 {
			return nil, notFound("this revision has no exec summary for " + req.Metric + " in " + per.String())
		}
		return GetMetricSummary200JSONResponse(f.summary(f.doc.Summaries[i], true)), nil
	}
	e, err := s.newExplainer(ctx, p, sc.ID, []period.Period{per}, explainOpts{})
	if err != nil {
		return nil, err
	}
	out, err := e.summary(req.Metric, per, true)
	if err != nil {
		return nil, err
	}
	return GetMetricSummary200JSONResponse(out), nil
}

// summaryStateOrder sorts list rows: missing, stale, written, optional.
var summaryStateOrder = map[SummaryState]int{SummaryStateMissing: 0, SummaryStateStale: 1, SummaryStateWritten: 2, SummaryStateOptional: 3}

// ListMetricSummaries lists a month's exec summary slots, one per metric of
// the methodology in force, at company scope: the rows the caller may read
// (the company cell), filtered by state (missing by default), sorted
// missing, stale, written, optional, then worst status, then category and
// metric order; with counts over the same rows. countsOnly returns the
// counts alone and derives nothing. With revision, the summaries frozen in
// that published revision instead (every state by default), none for a
// revision published before summaries were required.
func (s *Server) ListMetricSummaries(ctx context.Context, req ListMetricSummariesRequestObject) (ListMetricSummariesResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	q := req.Params
	var pr problems
	month, ok := parsePeriod(&pr, "period", q.Period)
	if ok && month.Grain != period.Month {
		pr.add("period", "must be a month such as 2026-M10")
	}
	state := ListMetricSummariesStateMissing
	if q.Revision != nil {
		state = ListMetricSummariesStateAll
	}
	if q.State != nil {
		state = *q.State
		if !state.Valid() {
			pr.add("state", "must be missing, stale, written, optional or all")
		}
	}
	offset := 0
	if q.Cursor != nil && *q.Cursor != "" {
		n, err := strconv.Atoi(*q.Cursor)
		if err != nil || n < 0 {
			pr.add("cursor", "must be a nextCursor from an earlier page")
		}
		offset = n
	}
	if q.Revision != nil && *q.Revision < 1 {
		pr.add("revision", "must be a positive integer")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	full := q.Full != nil && *q.Full
	countsOnly := q.CountsOnly != nil && *q.CountsOnly

	out := MetricSummaryList{Period: month.String(), Items: []MetricSummary{}}
	if q.Revision != nil {
		f, err := s.loadFrozen(ctx, p, sc.ID, month, *q.Revision)
		if err != nil {
			return nil, err
		}
		var rows []report.SummarySnapshot
		for _, x := range f.doc.Summaries {
			if !f.readable(x) {
				continue
			}
			rows = append(rows, x)
			out.Counts.Written++
			if x.Requirement == report.RequirementRequired {
				out.Counts.Required++
			}
		}
		if countsOnly {
			return ListMetricSummaries200JSONResponse(out), nil
		}
		if state != ListMetricSummariesStateAll && state != ListMetricSummariesStateWritten {
			rows = nil
		}
		out.Items, out.NextCursor, err = pageSummaries(len(rows), offset, full, func(i int) (MetricSummary, error) {
			return f.summary(rows[i], full), nil
		})
		if err != nil {
			return nil, err
		}
		return ListMetricSummaries200JSONResponse(out), nil
	}

	e, err := s.newExplainer(ctx, p, sc.ID, []period.Period{month}, explainOpts{})
	if err != nil {
		return nil, err
	}
	its, err := e.items(month)
	if err != nil {
		return nil, err
	}
	var rows []metricItem
	for _, it := range its {
		if !e.acc.canRead(it.root, []string{it.m.Key}, month) {
			continue
		}
		rows = append(rows, it)
		if it.facts.req.Required {
			out.Counts.Required++
		}
		switch it.state {
		case SummaryStateMissing:
			out.Counts.Missing++
		case SummaryStateStale:
			out.Counts.Stale++
		case SummaryStateWritten:
			out.Counts.Written++
		case SummaryStateOptional:
			out.Counts.Optional++
		}
	}
	if countsOnly {
		return ListMetricSummaries200JSONResponse(out), nil
	}

	if state != ListMetricSummariesStateAll {
		rows = slices.DeleteFunc(rows, func(it metricItem) bool { return string(it.state) != string(state) })
	}
	e.sortItems(rows, month)
	out.Items, out.NextCursor, err = pageSummaries(len(rows), offset, full, func(i int) (MetricSummary, error) {
		ms := e.summaryOf(rows[i], full)
		return ms, e.addEvidence(&ms, rows[i])
	})
	if err != nil {
		return nil, err
	}
	return ListMetricSummaries200JSONResponse(out), nil
}

// sortItems sorts summary slots as the list serves them: missing, stale,
// written, optional; then the worst status; then category order; then
// methodology order.
func (e *explainer) sortItems(rows []metricItem, month period.Period) {
	v, _ := engine.VersionFor(e.in.Versions, month, e.in.Cal)
	categoryOrder := map[string]int{}
	for _, c := range v.Content.Categories {
		categoryOrder[c.ID] = c.Order
	}
	metricOrder := map[string]int{}
	for i, m := range v.Content.Metrics {
		metricOrder[m.Key] = i
	}
	rank := func(status string) int {
		for _, l := range e.base.scale {
			if l.Key == status {
				return l.Rank
			}
		}
		return -1
	}
	slices.SortStableFunc(rows, func(a, b metricItem) int {
		return cmp.Or(
			cmp.Compare(summaryStateOrder[a.state], summaryStateOrder[b.state]),
			cmp.Compare(rank(b.facts.standing.Status), rank(a.facts.standing.Status)),
			cmp.Compare(categoryOrder[a.m.CategoryID], categoryOrder[b.m.CategoryID]),
			cmp.Compare(metricOrder[a.m.Key], metricOrder[b.m.Key]),
		)
	})
}

// pageSummaries is the page of n rows from offset that at builds: 16 when
// full, else as many as fit listPageBytes (at least one); with the cursor of
// the next page when rows remain.
func pageSummaries(n, offset int, full bool, at func(i int) (MetricSummary, error)) ([]MetricSummary, *string, error) {
	items := []MetricSummary{}
	size := 0
	for i := min(offset, n); i < n; i++ {
		if full && len(items) == fullSummariesPage {
			next := strconv.Itoa(i)
			return items, &next, nil
		}
		ms, err := at(i)
		if err != nil {
			return nil, nil, err
		}
		if !full {
			b, err := json.Marshal(ms)
			if err != nil {
				return nil, nil, err
			}
			if size+len(b) > listPageBytes && len(items) > 0 {
				next := strconv.Itoa(i)
				return items, &next, nil
			}
			size += len(b) + 1
		}
		items = append(items, ms)
	}
	return items, nil, nil
}

// frozen is one published revision's exec summaries, read for p.
type frozen struct {
	doc   report.Document
	acc   *access
	root  string
	month period.Period
	admin bool
}

// loadFrozen reads the published revision of scorecard sc's report for the
// month per ends in (per itself for a month). 404 when there is no such
// revision. It reads the snapshot and the org tree, no data.
func (s *Server) loadFrozen(ctx context.Context, p auth.Principal, sc string, per period.Period, revision int) (frozen, error) {
	cal := s.calendar(*p.Tenant)
	month, ok := lastMonth(cal, per)
	if !ok {
		return frozen{}, badRequest("request validation failed", detail{Path: "period", Message: "invalid"})
	}
	revisions, err := s.store.ListReportRevisions(ctx, p.Tenant.ID, sc)
	if err != nil {
		return frozen{}, err
	}
	i := slices.IndexFunc(revisions, func(r domain.ReportRevision) bool { return r.Period == month.String() && r.Revision == revision })
	if i < 0 {
		return frozen{}, notFound("report revision not found")
	}
	objs, err := s.objectStore()
	if err != nil {
		return frozen{}, err
	}
	doc, err := loadReportDocument(ctx, objs, revisions[i].ObjectKey)
	if errors.Is(err, objects.ErrNotFound) {
		return frozen{}, notFound("report revision not found")
	}
	if err != nil {
		return frozen{}, err
	}
	in, err := s.loadInput(ctx, *p.Tenant, sc, nil)
	if err != nil {
		return frozen{}, err
	}
	return frozen{doc: doc, acc: newAccess(p, in), root: reportRoot(in, month), month: month,
		admin: auth.Can(p, auth.ActionTenantAdmin, auth.Resource{}, nil, period.Period{})}, nil
}

// readable says whether the reader may read a frozen summary: one who reads
// the company cell of its metric in the report month.
func (f frozen) readable(x report.SummarySnapshot) bool {
	return f.root != "" && f.acc.canRead(f.root, []string{x.MetricKey}, f.month)
}

// summary is a frozen summary as the API serves it: written, never stale,
// whole when full, else an excerpt and the first 3 links.
func (f frozen) summary(x report.SummarySnapshot, full bool) MetricSummary {
	text, author, channel, updated, rev := x.Text, x.AuthorName, MetricSummaryChannel(x.Channel), x.UpdatedAt, x.Revision
	out := MetricSummary{
		MetricKey: x.MetricKey, MetricName: x.MetricName, Period: x.Period,
		Requirement: MetricSummaryRequirement(x.Requirement), State: SummaryStateWritten,
		Standing: MetricSummaryStanding{Display: x.Standing.Display, Status: x.Standing.Status, Headline: x.Standing.Headline}, StaleReasons: []string{}, CanEdit: f.admin,
		Text: &text, AuthorName: &author, Channel: &channel, UpdatedAt: &updated, Revision: &rev,
		LinksTotal: len(x.Links),
	}
	if x.CategoryID != "" {
		out.CategoryId = &x.CategoryID
	}
	if x.RequirementReason != "" {
		out.RequirementReason = &x.RequirementReason
	}
	ls := x.Links
	if !full {
		if len(ls) > linksShown {
			ls = ls[:linksShown]
		}
		ex := excerpt(text)
		out.Text = &ex
	}
	out.Links = apiRcaLinks(ls)
	if len(x.Evidence) > 0 {
		ev := make([]RcaEvidenceKey, 0, len(x.Evidence))
		for _, k := range x.Evidence {
			ev = append(ev, RcaEvidenceKey{Key: k.Key, Title: k.Title, Url: k.URL, PointsDisplay: k.PointsDisplay})
		}
		out.Evidence = &ev
	}
	return out
}

// loadReportDocument reads a stored revision's document without decoding
// its views.
func loadReportDocument(ctx context.Context, objs objects.Store, key string) (report.Document, error) {
	rc, _, err := objs.Get(ctx, key)
	if err != nil {
		return report.Document{}, err
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return report.Document{}, err
	}
	var doc report.Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return report.Document{}, err
	}
	return doc, nil
}
