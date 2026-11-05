package httpapi

import (
	"context"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/importer"
	"opsvision/internal/period"
)

// loadInput reads everything the engine needs for one scorecard of a tenant:
// the org tree, tracked items, every methodology version, and the data points
// and overrides of the given fiscal years (none when years is empty).
//
// It builds a fresh Input on every call. An engine.Index memoizes values
// computed from the input, so one must never outlive the request that read
// the data it was built from.
func (s *Server) loadInput(ctx context.Context, tenant domain.Tenant, scorecardID string, years []int) (*engine.Input, error) {
	return importer.LoadInput(ctx, s.store, tenant, s.calendar(tenant), scorecardID, years)
}

// fiscalYears returns the sorted distinct fiscal years of ps. With withPrior
// it also includes each year before, which comparisons (prior period, same
// point last year) read.
func fiscalYears(withPrior bool, ps ...period.Period) []int {
	seen := map[int]bool{}
	for _, p := range ps {
		seen[p.FY] = true
		if withPrior {
			seen[p.FY-1] = true
		}
	}
	out := make([]int, 0, len(seen))
	for y := range seen {
		out = append(out, y)
	}
	sort.Ints(out)
	return out
}

// lastMonth returns the final month of p; false for an invalid period.
func lastMonth(cal period.Calendar, p period.Period) (period.Period, bool) {
	ms := cal.Months(p)
	if len(ms) == 0 {
		return period.Period{}, false
	}
	return ms[len(ms)-1], true
}

// monthBefore reports whether month a is earlier than month b.
func monthBefore(a, b period.Period) bool {
	return a.FY < b.FY || (a.FY == b.FY && a.Index < b.Index)
}
