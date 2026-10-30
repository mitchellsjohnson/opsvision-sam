package httpapi

import (
	"context"
	"fmt"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/orgtree"
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
	units, err := s.store.ListOrgUnits(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	moves, err := s.store.ListOrgMoves(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	tree, err := orgtree.New(units, moves)
	if err != nil {
		return nil, fmt.Errorf("httpapi: build org tree: %w", err)
	}
	items, err := s.store.ListTrackedItems(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	versions, err := s.store.ListVersions(ctx, tenant.ID, scorecardID)
	if err != nil {
		return nil, err
	}
	in := &engine.Input{
		Cal:       s.calendar(tenant),
		Tree:      tree,
		Items:     items,
		Versions:  versions,
		Data:      []domain.DataPoint{},
		Overrides: []domain.Override{},
	}
	if len(years) > 0 {
		in.Data, in.Overrides, err = s.store.ListData(ctx, tenant.ID, scorecardID, years)
		if err != nil {
			return nil, err
		}
	}
	return in, nil
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
