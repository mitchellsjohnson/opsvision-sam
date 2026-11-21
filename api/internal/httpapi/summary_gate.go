package httpapi

import (
	"context"
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/rca"
)

// Summary states, as in the API.
const (
	summaryMissing  = string(SummaryStateMissing)
	summaryWritten  = string(SummaryStateWritten)
	summaryStale    = string(SummaryStateStale)
	summaryOptional = string(SummaryStateOptional)
)

// GateItem is one metric of a month in the publish gate: the period its
// summary belongs to (the month, or the quarter, half or year of a coarse
// metric), whether that summary is required to publish the month, its state
// and the company standing.
type GateItem struct {
	MetricKey, MetricName string
	Period                period.Period
	Requirement           rca.Requirement
	// State is missing, written, stale or optional. Missing is exact and is
	// what blocks publishing. Stale is partial: it compares the standing,
	// the reported downtime and the subjects short of perfect, never
	// incidents, so the publish check must recompute full staleness (§8.4)
	// for written items before counting PublishBlocked.stale.
	State    string
	Standing MetricSummaryStanding
}

// summaryGate judges every metric of the methodology in force for month at
// company scope, in the methodology's order. It is cheap: one engine
// compute over data points for the month and the coarse periods its metrics
// report at, and one ListRCAs per period; it derives nothing and reads no
// records, so a stale state here compares the standing, the reported
// downtime and which reporting subjects are short of perfect, not
// incidents. A coarse metric's summary is required only in the month that
// closes its period. The requirement is a tenant fact, so no reader's scope
// applies. A month with no methodology in force, or an organization with no
// single top-level unit (no summary can be written there), has no items and
// so never blocks (spec §9.7).
func (s *Server) summaryGate(ctx context.Context, tenant domain.Tenant, sc string, month period.Period) ([]GateItem, error) {
	if month.Grain != period.Month {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "must be a month"})
	}
	in, err := s.loadInput(ctx, tenant, sc, fiscalYears(true, month))
	if err != nil {
		return nil, err
	}
	v, ok := engine.VersionFor(in.Versions, month, in.Cal)
	root := reportRoot(in, month)
	if !ok || root == "" {
		return []GateItem{}, nil
	}
	periodOf := func(m domain.Metric) period.Period {
		if g, ok := frequencyGrain(m.Frequency); ok && g != period.Month {
			return in.Cal.Parent(month, g)
		}
		return month
	}
	periods := []period.Period{month}
	for _, m := range v.Content.Metrics {
		if p := periodOf(m); !slices.Contains(periods, p) {
			periods = append(periods, p)
		}
	}
	view, err := engine.Compute(in, engine.ViewRequest{Periods: periods, Structure: engine.StructureAsOf})
	if err != nil {
		return nil, err
	}
	c, err := s.newSummaryContext(ctx, tenant, sc, in, root)
	if err != nil {
		return nil, err
	}
	type key struct {
		metric string
		p      period.Period
	}
	stored := map[key]domain.CellRCA{}
	for _, p := range periods {
		rs, err := s.store.ListRCAs(ctx, tenant.ID, sc, p)
		if err != nil {
			return nil, err
		}
		for _, r := range rs {
			if r.SubjectID == root {
				stored[key{r.MetricKey, r.Period}] = r
			}
		}
	}

	out := make([]GateItem, 0, len(v.Content.Metrics))
	for _, m := range v.Content.Metrics {
		per := periodOf(m)
		last, _ := lastMonth(in.Cal, per)
		f := c.facts(v, m, per, view.Rows, slices.Index(periods, per), per != month, last == month)
		it := GateItem{MetricKey: m.Key, MetricName: m.Name, Period: per, Requirement: f.req, Standing: f.standing, State: summaryOptional}
		switch r, ok := stored[key{m.Key, per}]; {
		case ok && gateStale(r.Basis, f.basis(nil)):
			it.State = summaryStale
		case ok:
			it.State = summaryWritten
		case f.req.Required:
			it.State = summaryMissing
		}
		out = append(out, it)
	}
	return out, nil
}

// gateStale reports whether a stored basis differs from the current one in
// what the gate computes: the standing's value and status, the reported
// downtime (when both have it) and the subjects short of perfect.
func gateStale(stored, current domain.RCABasis) bool {
	if stored.Display != current.Display || stored.Status != current.Status {
		return true
	}
	if s, c := stored.ReportedMinutes, current.ReportedMinutes; s != nil && c != nil && *s != *c {
		return true
	}
	return !slices.Equal(subjectEvidence(stored.Evidence), subjectEvidence(current.Evidence))
}
