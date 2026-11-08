package recordimport

import (
	"context"
	"fmt"
	"math"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/importer"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/records"
	"opsvision/internal/store"
)

// CellRef names one data point slot: a measure for a subject in a period.
type CellRef struct {
	MeasureKey, SubjectID string
	Period                period.Period
}

// world is everything derivation reads, as stored or as a plan would leave
// it. Records hold every record type, without orphan revisions.
type world struct {
	cal       period.Calendar
	levels    []domain.Level
	units     []domain.OrgUnit
	moves     []domain.OrgMove
	tree      *orgtree.Tree
	items     []domain.TrackedItem
	versions  []domain.MethodologyVersion
	types     []domain.RecordType
	records   []domain.Record
	snapshots map[string][]domain.Snapshot // by record type, newest as-of first
	latest    map[string]domain.Date       // by record type
	// draft, when set, is evaluated for every period in place of the
	// version in force.
	draft *domain.MethodologyVersion
}

// loadWorld reads the tenant's org, methodology, record types, records and
// snapshots. Revisions whose snapshot is not stored are left over from a
// failed partial apply and are dropped.
func loadWorld(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string) (*world, error) {
	w := &world{cal: importer.CalendarOf(tenant), snapshots: map[string][]domain.Snapshot{}, latest: map[string]domain.Date{}}
	var err error
	if w.levels, err = st.ListLevels(ctx, tenant.ID); err != nil {
		return nil, err
	}
	if w.units, err = st.ListOrgUnits(ctx, tenant.ID); err != nil {
		return nil, err
	}
	if w.moves, err = st.ListOrgMoves(ctx, tenant.ID); err != nil {
		return nil, err
	}
	if w.items, err = st.ListTrackedItems(ctx, tenant.ID); err != nil {
		return nil, err
	}
	if w.versions, err = st.ListVersions(ctx, tenant.ID, scorecardID); err != nil {
		return nil, err
	}
	if w.types, err = st.ListRecordTypes(ctx, tenant.ID); err != nil {
		return nil, err
	}
	for _, rt := range w.types {
		snaps, err := st.ListSnapshots(ctx, tenant.ID, rt.ID)
		if err != nil {
			return nil, err
		}
		w.snapshots[rt.ID] = snaps
		stored := make(map[string]bool, len(snaps))
		for _, s := range snaps {
			stored[s.ID] = true
		}
		if len(snaps) > 0 {
			w.latest[rt.ID] = snaps[0].AsOf
		}
		recs, err := st.ListRecords(ctx, tenant.ID, rt.ID)
		if err != nil {
			return nil, err
		}
		for _, r := range recs {
			kept := r.Revisions[:0:0]
			for _, rv := range r.Revisions {
				if stored[rv.SnapshotID] {
					kept = append(kept, rv)
				}
			}
			if len(kept) > 0 {
				r.Revisions = kept
				w.records = append(w.records, r)
			}
		}
	}
	return w, w.buildTree()
}

func (w *world) buildTree() error {
	tree, err := orgtree.New(w.units, w.moves)
	if err != nil {
		return fmt.Errorf("build org tree: %w", err)
	}
	w.tree = tree
	return nil
}

func (w *world) deriveInput() records.DeriveInput {
	return records.DeriveInput{Cal: w.cal, Tree: w.tree, Items: w.items, Types: w.types, Records: w.records, LatestAsOf: w.latest}
}

// versionFor returns the methodology version a period is derived and shown
// under: the draft when previewing one, else the version in force.
func (w *world) versionFor(p period.Period) (domain.MethodologyVersion, bool) {
	if w.draft != nil {
		return *w.draft, true
	}
	return engine.VersionFor(w.versions, p, w.cal)
}

// span returns the months derivation covers: from the earliest tracked-from
// month of any record type through the month of the latest snapshot. ok is
// false when no record type is tracked or none has a snapshot.
func (w *world) span() (from, to period.Period, ok bool) {
	var first, last domain.Date
	for _, rt := range w.types {
		for _, p := range rt.TrackedFrom {
			if s := (domain.Date{Time: w.cal.Start(p)}); first.IsZero() || s.Before(first) {
				first = s
			}
		}
		if d := w.latest[rt.ID]; !d.IsZero() && (last.IsZero() || last.Before(d)) {
			last = d
		}
	}
	if first.IsZero() || last.IsZero() || last.Before(first) {
		return period.Period{}, period.Period{}, false
	}
	return w.cal.MonthOf(first.Time), w.cal.MonthOf(last.Time), true
}

// dataYears lists the fiscal years whose data points derivation compares
// against (and the year before the first, for the story's prior periods).
func (w *world) dataYears() []int {
	seen := map[int]bool{}
	from, to, ok := w.span()
	if ok {
		for fy := from.FY - 1; fy <= to.FY; fy++ {
			seen[fy] = true
		}
	}
	for _, rt := range w.types {
		for _, p := range rt.TrackedFrom {
			seen[p.FY] = true
		}
	}
	out := make([]int, 0, len(seen))
	for fy := range seen {
		out = append(out, fy)
	}
	sort.Ints(out)
	return out
}

// grainOf maps a metric's reporting frequency to the grain its data is
// entered at, as the engine reads it.
func grainOf(f domain.Frequency) (period.Grain, bool) {
	switch f {
	case domain.FrequencyMonthly:
		return period.Month, true
	case domain.FrequencyQuarterly:
		return period.Quarter, true
	case domain.FrequencyBiannual:
		return period.Half, true
	case domain.FrequencyAnnual:
		return period.Year, true
	}
	return 0, false
}

// metricUses maps each measure key of v to the metrics whose formulas
// reference it. Formulas that do not parse reference nothing.
func metricUses(v domain.MethodologyVersion) map[string][]domain.Metric {
	out := map[string][]domain.Metric{}
	for _, m := range v.Content.Metrics {
		ids, err := formula.Identifiers(m.Formula)
		if err != nil {
			continue
		}
		for _, id := range ids {
			out[id] = append(out[id], m)
		}
	}
	return out
}

func isDerived(m domain.Measure) bool { return m.Source == domain.MeasureDerived && m.Derive != nil }

// derived is every derived value by slot.
type derived map[CellRef]records.Derived

// deriveAll derives every derived measure for each month of the span, and for
// each quarter, half and year containing one of those months at which a metric
// using the measure reports, each under its period's version.
func (w *world) deriveAll() (derived, error) {
	out := derived{}
	from, to, ok := w.span()
	if !ok {
		return out, nil
	}
	var periods []period.Period
	seen := map[period.Period]bool{}
	add := func(p period.Period) {
		if !seen[p] {
			seen[p] = true
			periods = append(periods, p)
		}
	}
	for m := from; store.ComparePeriod(m, to) <= 0; m = next(m) {
		add(m)
		for _, g := range []period.Grain{period.Quarter, period.Half, period.Year} {
			add(w.cal.Parent(m, g))
		}
	}

	type group struct {
		m       domain.Measure
		periods []period.Period
	}
	groups := map[string]*group{}
	var order []string
	uses := map[string]map[string][]domain.Metric{}
	for _, p := range periods {
		v, ok := w.versionFor(p)
		if !ok {
			continue
		}
		if _, done := uses[v.ID]; !done {
			uses[v.ID] = metricUses(v)
		}
		for _, m := range v.Content.Measures {
			if !isDerived(m) || !reportsAt(uses[v.ID][m.Key], p.Grain) {
				continue
			}
			gk := v.ID + "\x00" + m.Key
			g, ok := groups[gk]
			if !ok {
				g = &group{m: m}
				groups[gk] = g
				order = append(order, gk)
			}
			g.periods = append(g.periods, p)
		}
	}
	in := w.deriveInput()
	for _, gk := range order {
		g := groups[gk]
		vals, err := records.Derive(in, g.m, g.periods)
		if err != nil {
			return nil, err
		}
		for _, d := range vals {
			out[CellRef{d.MeasureKey, d.SubjectID, d.Period}] = d
		}
	}
	return out, nil
}

// reportsAt reports whether a measure gets values at grain g: always for
// months, and for a coarser grain when one of the metrics using it reports at
// that grain.
func reportsAt(metrics []domain.Metric, g period.Grain) bool {
	if g == period.Month {
		return true
	}
	for _, m := range metrics {
		if mg, ok := grainOf(m.Frequency); ok && mg == g {
			return true
		}
	}
	return false
}

func next(m period.Period) period.Period {
	if m.Index == 12 {
		return period.Period{Grain: period.Month, FY: m.FY + 1, Index: 1}
	}
	return period.Period{Grain: period.Month, FY: m.FY, Index: m.Index + 1}
}

// sameValue compares derived numbers, allowing for float noise.
func sameValue(a, b float64) bool {
	return a == b || math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

func refOf(dp domain.DataPoint) CellRef { return CellRef{dp.MeasureKey, dp.SubjectID, dp.Period} }

// writesFor returns the writes that bring the stored points cur to the
// derived values want, skipping locked periods. A slot whose point did not
// come from records keeps it unless use lists the slot. A records point no
// longer derived is deleted. Writes are unconditional, ordered by period,
// measure, then subject.
func writesFor(want derived, cur map[CellRef]domain.DataPoint, locked func(period.Period) bool, use map[CellRef]bool) []store.DataWrite {
	var out []store.DataWrite
	for k, d := range want {
		if locked(k.Period) {
			continue
		}
		if dp, ok := cur[k]; ok {
			if dp.Source != domain.SourceRecords && !use[k] {
				continue
			}
			if dp.Source == domain.SourceRecords && dp.Value != nil && sameValue(*dp.Value, d.Value) {
				continue
			}
		}
		v := d.Value
		out = append(out, store.DataWrite{
			Point:            domain.DataPoint{MeasureKey: k.MeasureKey, SubjectID: k.SubjectID, Period: k.Period, Value: &v, Source: domain.SourceRecords},
			ExpectedRevision: store.Unconditional,
		})
	}
	for k, dp := range cur {
		if _, ok := want[k]; ok || dp.Source != domain.SourceRecords || locked(k.Period) {
			continue
		}
		out = append(out, store.DataWrite{
			Point:            domain.DataPoint{MeasureKey: k.MeasureKey, SubjectID: k.SubjectID, Period: k.Period, Source: domain.SourceRecords},
			ExpectedRevision: store.Unconditional,
			Delete:           true,
		})
	}
	sort.Slice(out, func(i, j int) bool { return lessRef(refOf(out[i].Point), refOf(out[j].Point)) })
	return out
}

func lessRef(a, b CellRef) bool {
	if c := store.ComparePeriod(a.Period, b.Period); c != 0 {
		return c < 0
	}
	if a.MeasureKey != b.MeasureKey {
		return a.MeasureKey < b.MeasureKey
	}
	return a.SubjectID < b.SubjectID
}

func useSet(use []CellRef) map[CellRef]bool {
	out := make(map[CellRef]bool, len(use))
	for _, c := range use {
		out[c] = true
	}
	return out
}

func pointsBySlot(pts []domain.DataPoint) map[CellRef]domain.DataPoint {
	out := make(map[CellRef]domain.DataPoint, len(pts))
	for _, dp := range pts {
		out[refOf(dp)] = dp
	}
	return out
}

// Recalculate returns the writes that bring a scorecard's derived points up
// to date with the stored records. Each period is derived under the
// methodology version in force for it, for every derived measure, for the
// months from the earliest tracked-from month through the latest snapshot
// month, plus the quarters, halves and years containing them that a metric
// using the measure reports at. Periods for which locked is true are
// skipped. Changed values are written as records points with
// ExpectedRevision Unconditional, and records points that are no longer
// derived are deleted. A slot whose current point did not come from records
// (a typed value) is left alone unless use lists it. EnteredBy and EnteredAt
// are left for the caller to stamp. Phase 1 has no month lock: pass a locked
// that is always false.
func Recalculate(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, locked func(period.Period) bool, use []CellRef) ([]store.DataWrite, error) {
	w, err := loadWorld(ctx, st, tenant, scorecardID)
	if err != nil {
		return nil, err
	}
	want, err := w.deriveAll()
	if err != nil {
		return nil, err
	}
	pts, _, err := st.ListData(ctx, tenant.ID, scorecardID, w.dataYears())
	if err != nil {
		return nil, err
	}
	return writesFor(want, pointsBySlot(pts), locked, useSet(use)), nil
}
