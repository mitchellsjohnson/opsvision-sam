package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"strconv"

	"opsvision/internal/engine"
	"opsvision/internal/period"
)

// List pages (spec §9.2, §9.6): full rows 16 to a page; default rows
// (excerpts, first 3 links) as many as fit under the byte budget, which
// keeps a page under MCP's 512 KB cut whatever the links weigh.
const (
	fullSummariesPage = 16
	listPageBytes     = 360 * 1024
)

// GetMetricSummary is one metric's exec summary for a period, whole, with
// its state, standing and top evidence. Readers of the company cell; a
// published revision's copy is not served yet.
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
	if err := pr.err(); err != nil {
		return nil, err
	}
	if req.Params.Revision != nil {
		return nil, errNotImplemented
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
// counts alone and derives nothing.
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
	if err := pr.err(); err != nil {
		return nil, err
	}
	if q.Revision != nil {
		return nil, errNotImplemented
	}
	full := q.Full != nil && *q.Full
	countsOnly := q.CountsOnly != nil && *q.CountsOnly

	out := MetricSummaryList{Period: month.String(), Items: []MetricSummary{}}
	e, err := s.newExplainer(ctx, p, sc.ID, []period.Period{month}, explainOpts{})
	if err != nil {
		return nil, err
	}
	its, err := e.items(month)
	if err != nil {
		return nil, err
	}
	v, _ := engine.VersionFor(e.in.Versions, month, e.in.Cal)
	categoryOrder := map[string]int{}
	for _, c := range v.Content.Categories {
		categoryOrder[c.ID] = c.Order
	}
	metricOrder := map[string]int{}
	var rows []metricItem
	for i, it := range its {
		if !e.acc.canRead(it.root, []string{it.m.Key}, month) {
			continue
		}
		metricOrder[it.m.Key] = i
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

	size := 0
	for i := min(offset, len(rows)); i < len(rows); i++ {
		if full && len(out.Items) == fullSummariesPage {
			next := strconv.Itoa(i)
			out.NextCursor = &next
			break
		}
		it := rows[i]
		ms := e.summaryOf(it, full)
		if err := e.addEvidence(&ms, it); err != nil {
			return nil, err
		}
		if !full {
			b, err := json.Marshal(ms)
			if err != nil {
				return nil, err
			}
			if size+len(b) > listPageBytes && len(out.Items) > 0 {
				next := strconv.Itoa(i)
				out.NextCursor = &next
				break
			}
			size += len(b) + 1
		}
		out.Items = append(out.Items, ms)
	}
	return ListMetricSummaries200JSONResponse(out), nil
}
