package httpapi

import (
	"context"
	"log/slog"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/importer"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
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

// restateDerived re-derives, in memory, the derived measures of version
// restate for a view computed under it: in the loaded fiscal years, every
// records point of those measures is replaced by what the restate version's
// rules give. Typed points (any other source) are kept and still win. Nothing
// is stored. in must come from loadInput for this request.
func (s *Server) restateDerived(ctx context.Context, tenant domain.Tenant, scorecardID string, in *engine.Input, restate string, years []int) error {
	var v *domain.MethodologyVersion
	for i := range in.Versions {
		if in.Versions[i].ID == restate {
			v = &in.Versions[i]
		}
	}
	if v == nil {
		return nil
	}
	derived := map[string]domain.Measure{}
	for _, m := range v.Content.Measures {
		if m.Source == domain.MeasureDerived && m.Derive != nil {
			derived[m.Key] = m
		}
	}
	if len(derived) == 0 {
		return nil
	}

	type slot struct {
		measure, subject string
		p                period.Period
	}
	kept := make([]domain.DataPoint, 0, len(in.Data))
	typed := map[slot]bool{}
	for _, dp := range in.Data {
		if _, ok := derived[dp.MeasureKey]; ok {
			if dp.Source == domain.SourceRecords {
				continue
			}
			typed[slot{dp.MeasureKey, dp.SubjectID, dp.Period}] = true
		}
		kept = append(kept, dp)
	}

	din, err := recordimport.LoadDeriveInput(ctx, s.store, tenant, scorecardID)
	if err != nil {
		return err
	}
	grains := reportGrains(v.Content)
	keys := make([]string, 0, len(derived))
	for k := range derived {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		vals, err := records.Derive(din, derived[key], restatePeriods(in.Cal, years, grains[key]))
		if err != nil {
			// The measure gets no restated values; the others still do.
			slog.Warn("httpapi: restatement: a derived measure could not be derived", "tenant", tenant.ID, "version", restate, "measure", key, "err", err)
			continue
		}
		for _, d := range vals {
			if typed[slot{d.MeasureKey, d.SubjectID, d.Period}] {
				continue
			}
			value := d.Value
			kept = append(kept, domain.DataPoint{MeasureKey: d.MeasureKey, SubjectID: d.SubjectID, Period: d.Period,
				Value: &value, Source: domain.SourceRecords, Revision: 1})
		}
	}
	in.Data = kept
	return nil
}

// reportGrains maps each measure key of m to the grains coarser than a month
// at which a metric using it reports, as recalculation derives them.
func reportGrains(m domain.Methodology) map[string][]period.Grain {
	out := map[string][]period.Grain{}
	for _, mt := range m.Metrics {
		g, ok := frequencyGrain(mt.Frequency)
		if !ok || g == period.Month {
			continue
		}
		ids, err := formula.Identifiers(mt.Formula)
		if err != nil {
			continue
		}
		for _, id := range ids {
			if !hasGrain(out[id], g) {
				out[id] = append(out[id], g)
			}
		}
	}
	return out
}

func hasGrain(gs []period.Grain, g period.Grain) bool {
	for _, x := range gs {
		if x == g {
			return true
		}
	}
	return false
}

// restatePeriods lists every month of the fiscal years, then each quarter,
// half, or year of them at the given grains.
func restatePeriods(cal period.Calendar, years []int, grains []period.Grain) []period.Period {
	var out []period.Period
	seen := map[period.Period]bool{}
	for _, fy := range years {
		for i := 1; i <= 12; i++ {
			m := period.Period{Grain: period.Month, FY: fy, Index: i}
			out = append(out, m)
			for _, g := range grains {
				if p := cal.Parent(m, g); !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
	}
	return out
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
