package httpapi

import (
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/rca"
)

// annotateSummaries sets Cell.summary on the company-root cells of a live
// view (spec §9.2): on a month column, the state of the metric's summary as
// that month sees it (a coarse metric's period, required only in the month
// that closes it); on a coarse column, the summaries of the metrics
// reported at that grain. Only metric-months that need a summary or have
// one get a state; never service, product or year-to-date cells.
func annotateSummaries(v *ScorecardView, e *explainer) error {
	periods := make([]period.Period, len(v.Periods))
	for i, s := range v.Periods {
		q, err := period.Parse(s)
		if err != nil {
			return err
		}
		periods[i] = q
	}
	if !e.opts.noStale {
		var keys []string
		for k := range e.stored {
			if len(e.base.links[k.metric]) > 0 && !slices.Contains(keys, k.metric) {
				keys = append(keys, k.metric)
			}
		}
		slices.Sort(keys)
		if err := e.loadIncidents(keys...); err != nil {
			return err
		}
	}
	for ri := range v.Rows {
		r := &v.Rows[ri]
		if r.SubjectKind != Unit {
			continue
		}
		for ci, per := range periods {
			if ci >= len(r.Cells) || r.Cells[ci].Ytd {
				continue
			}
			month, ok := lastMonth(e.in.Cal, per)
			if !ok || r.SubjectId != reportRoot(e.in, month) {
				continue
			}
			ver, ok := engine.VersionFor(e.in.Versions, per, e.in.Cal)
			if !ok {
				continue
			}
			mi := slices.IndexFunc(ver.Content.Metrics, func(m domain.Metric) bool { return m.Key == r.MetricKey })
			if mi < 0 {
				continue
			}
			m := ver.Content.Metrics[mi]
			itemPer := per
			if per.Grain == period.Month {
				itemPer = e.periodOf(m, per)
			} else if g, ok := frequencyGrain(m.Frequency); !ok || g != per.Grain {
				continue
			}
			it, err := e.item(ver, m, itemPer, month)
			if err != nil {
				return err
			}
			if it.state == SummaryStateOptional {
				continue
			}
			st := &MetricSummaryState{State: it.state}
			if it.stored != nil {
				ex, author := excerpt(it.stored.Text), it.stored.AuthorName
				st.Excerpt, st.Author = &ex, &author
			}
			r.Cells[ci].Summary = st
		}
	}
	return nil
}

// hasCompanyRows reports whether the view has a row of the company root of
// any of its columns, the only rows annotateSummaries touches.
func hasCompanyRows(v ScorecardView, in *engine.Input, periods []period.Period) bool {
	roots := map[string]bool{}
	for _, q := range periods {
		if m, ok := lastMonth(in.Cal, q); ok {
			if r := reportRoot(in, m); r != "" {
				roots[r] = true
			}
		}
	}
	for _, r := range v.Rows {
		if r.SubjectKind == Unit && roots[r.SubjectId] {
			return true
		}
	}
	return false
}

// setRcaIdeal sets ViewRow.rcaIdeal on the rows of metrics with an ideal
// (100 for percent metrics where higher is better and for money plans),
// judged under the version of the view's latest column (or the restating
// version).
func setRcaIdeal(v *ScorecardView, in *engine.Input, vr engine.ViewRequest) {
	var ver domain.MethodologyVersion
	found := false
	if vr.Restate != "" {
		if i := slices.IndexFunc(in.Versions, func(x domain.MethodologyVersion) bool { return x.ID == vr.Restate }); i >= 0 {
			ver, found = in.Versions[i], true
		}
	} else {
		var latest period.Period
		for _, c := range slices.Concat(vr.Periods, vr.YTD) {
			if m, ok := lastMonth(in.Cal, c); ok && (latest == (period.Period{}) || monthBefore(latest, m)) {
				latest = m
			}
		}
		if latest != (period.Period{}) {
			ver, found = engine.VersionFor(in.Versions, latest, in.Cal)
		}
	}
	if !found {
		return
	}
	ideals := map[string]float64{}
	for _, m := range ver.Content.Metrics {
		if ideal, ok := rca.Ideal(m); ok {
			ideals[m.Key] = ideal
		}
	}
	for i := range v.Rows {
		if ideal, ok := ideals[v.Rows[i].MetricKey]; ok {
			v.Rows[i].RcaIdeal = &ideal
		}
	}
}
