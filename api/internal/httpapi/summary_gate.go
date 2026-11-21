package httpapi

import (
	"context"
	"slices"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
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
	// for written items before counting PublishBlocked.stale; the
	// explainer's required does.
	State    string
	Standing MetricSummaryStanding
}

// summaryGate judges every metric of the methodology in force for month at
// company scope, in the methodology's order, through the explainer at its
// cheapest: one engine compute over data points for the month and the
// coarse periods its metrics report at, and one ListRCAsRange; it derives
// nothing and reads no records, so a stale state here compares the
// standing, the reported downtime and which reporting subjects are short of
// perfect, not incidents. A coarse metric's summary is required only in the
// month that closes its period. The requirement is a tenant fact, so no
// reader's scope applies. A month with no methodology in force, or an
// organization with no single top-level unit (no summary can be written
// there), has no items and so never blocks (spec §9.7). listMetricSummaries'
// counts come from the same judgement, with full staleness.
func (s *Server) summaryGate(ctx context.Context, tenant domain.Tenant, sc string, month period.Period) ([]GateItem, error) {
	if month.Grain != period.Month {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "must be a month"})
	}
	e, err := s.newExplainer(ctx, auth.Principal{Tenant: &tenant}, sc, []period.Period{month}, explainOpts{gate: true})
	if err != nil {
		return nil, err
	}
	its, err := e.items(month)
	if err != nil {
		return nil, err
	}
	out := make([]GateItem, 0, len(its))
	for _, it := range its {
		out = append(out, GateItem{MetricKey: it.m.Key, MetricName: it.m.Name, Period: it.per, Requirement: it.facts.req,
			Standing: it.facts.standing, State: string(it.state)})
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
