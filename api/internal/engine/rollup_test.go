package engine

import (
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

func mustMeasure(t *testing.T, ix *Index, m domain.Measure, subject string, slots []period.Period, rollItems bool) Value {
	t.Helper()
	v, ok := ix.Measure(m, subject, slots, rollItems)
	if !ok {
		t.Fatalf("Measure(%s, %s) ok=false, want a value", m.Key, subject)
	}
	return v
}

func TestRollupSumAcrossChildren(t *testing.T) {
	m1 := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		pt("on_time", "gateway", m1, 10), pt("committed", "gateway", m1, 12),
		pt("on_time", "storage", m1, 5), pt("committed", "storage", m1, 8),
	))
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m1}, false)
	if got.V != 15 {
		t.Errorf("on_time = %v, want 15", got.V)
	}
	got = mustMeasure(t, ix, committed, "platform", []period.Period{m1}, false)
	if got.V != 20 {
		t.Errorf("committed = %v, want 20", got.V)
	}
	if got.Direct {
		t.Errorf("rolled value must not be Direct")
	}
	// And on up to the root.
	if got := mustMeasure(t, ix, onTime, "company", []period.Period{m1}, false); got.V != 15 {
		t.Errorf("company on_time = %v, want 15", got.V)
	}
}

func TestRollupAsOfMove(t *testing.T) {
	var data []domain.DataPoint
	for _, m := range monthsOf(period.Period{Grain: period.Year, FY: 2026}) {
		data = append(data, pt("on_time", "analytics", m, 4), pt("on_time", "warehouse", m, 1))
	}
	ix := NewIndex(fixtureInput(t, data...))
	h1 := Slots(cal, period.Month, monthsOf(half(2026, 1)))
	h2 := Slots(cal, period.Month, monthsOf(half(2026, 2)))

	// Before the move Analytics (24) + Warehouse (6) roll into Data.
	if got := mustMeasure(t, ix, onTime, "data", h1, false); got.V != 30 {
		t.Errorf("data H1 = %v, want 30", got.V)
	}
	// After the move only Warehouse remains under Data.
	if got := mustMeasure(t, ix, onTime, "data", h2, false); got.V != 6 {
		t.Errorf("data H2 = %v, want 6", got.V)
	}
	// Platform gets Analytics from M07 only.
	if _, ok := ix.Measure(onTime, "platform", h1, false); ok {
		t.Errorf("platform H1 should have no data")
	}
	if got := mustMeasure(t, ix, onTime, "platform", h2, false); got.V != 24 {
		t.Errorf("platform H2 = %v, want 24", got.V)
	}
	// Whole-year company total is unaffected by the move.
	year := Slots(cal, period.Month, monthsOf(period.Period{Grain: period.Year, FY: 2026}))
	if got := mustMeasure(t, ix, onTime, "company", year, false); got.V != 12*5 {
		t.Errorf("company FY = %v, want 60", got.V)
	}

	// Ranges that cross the move must sum as-of monthly rollups, not resolve
	// the tree once at the end of the range.
	// Data: M01-M06 Analytics 4 + Warehouse 1 = 30, M07-M12 Warehouse 1 = 6.
	if got := mustMeasure(t, ix, onTime, "data", year, false); got.V != 36 || got.Have != 12 || got.Expected != 12 {
		t.Errorf("data FY = %+v, want V=36 Have=12 Expected=12", got)
	}
	// Platform: Analytics only from M07 = 6 months * 4.
	if got := mustMeasure(t, ix, onTime, "platform", year, false); got.V != 24 || got.Have != 6 || got.Expected != 12 {
		t.Errorf("platform FY = %+v, want V=24 Have=6 Expected=12", got)
	}
	// Data YTD through M09: 30 + 3 Warehouse months = 33.
	ytd := cal.YTD(month(2026, 9))
	if got := mustMeasure(t, ix, onTime, "data", Slots(cal, period.Month, ytd), false); got.V != 33 {
		t.Errorf("data YTD-M09 = %v, want 33", got.V)
	}
}

func TestRollupUsesLastMonthOfSlot(t *testing.T) {
	// Quarterly data: Analytics moves at M07 = first month of Q3, so Q3 is
	// entirely post-move, Q2 entirely pre-move.
	q2, q3 := quarter(2026, 2), quarter(2026, 3)
	ix := NewIndex(fixtureInput(t, pt("points", "analytics", q2, 7), pt("points", "analytics", q3, 9)))
	if got := mustMeasure(t, ix, points, "data", []period.Period{q2}, false); got.V != 7 {
		t.Errorf("data Q2 = %v, want 7", got.V)
	}
	if _, ok := ix.Measure(points, "data", []period.Period{q3}, false); ok {
		t.Errorf("data Q3 should be empty after the move")
	}
	if got := mustMeasure(t, ix, points, "platform", []period.Period{q3}, false); got.V != 9 {
		t.Errorf("platform Q3 = %v, want 9", got.V)
	}
}

func TestRollupStraddlingSlotFollowsLastMonth(t *testing.T) {
	// A fiscal-year slot straddles the M07 move; the org as of its last month
	// (M12) decides where the annual value rolls up.
	fy := period.Period{Grain: period.Year, FY: 2026}
	ix := NewIndex(fixtureInput(t, pt("points", "analytics", fy, 12)))
	if _, ok := ix.Measure(points, "data", []period.Period{fy}, false); ok {
		t.Errorf("data FY should be empty: analytics is under platform at M12")
	}
	if got := mustMeasure(t, ix, points, "platform", []period.Period{fy}, false); got.V != 12 {
		t.Errorf("platform FY = %v, want 12", got.V)
	}
}

func TestDaysMaxAcrossUnits(t *testing.T) {
	m1 := month(2026, 1)
	ix := NewIndex(fixtureInput(t, pt("days", "gateway", m1, 31), pt("days", "storage", m1, 31)))
	if got := mustMeasure(t, ix, days, "platform", []period.Period{m1}, false); got.V != 31 {
		t.Errorf("days = %v, want 31", got.V)
	}
}

func TestDirectValueWins(t *testing.T) {
	m := month(2026, 3)
	ix := NewIndex(fixtureInput(t,
		pt("trained", "company", m, 200),
		pt("trained", "platform", m, 100), pt("trained", "data", m, 50),
	))
	got := mustMeasure(t, ix, trained, "company", []period.Period{m}, false)
	if got.V != 200 || !got.Direct {
		t.Errorf("got %+v, want V=200 Direct", got)
	}
}

func TestLatestOverTime(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		pt("trained", "company", month(2026, 1), 90),
		pt("trained", "company", month(2026, 2), 92),
		pt("trained", "company", month(2026, 3), 95),
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	got := mustMeasure(t, ix, trained, "company", slots, false)
	want := Value{V: 95, Have: 3, Expected: 3, Direct: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("(-want +got)\n%s", diff)
	}
}

func TestLatestSkipsTrailingGaps(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		pt("trained", "company", month(2026, 1), 90),
		pt("trained", "company", month(2026, 2), 92),
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	got := mustMeasure(t, ix, trained, "company", slots, false)
	if got.V != 92 || got.Have != 2 || got.Expected != 3 {
		t.Errorf("got %+v, want V=92 Have=2 Expected=3", got)
	}
}

func TestNoneDoesNotRollUp(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		pt("seconds_down", "svc-a", m, 30), pt("seconds_down", "svc-b", m, 60),
	))
	for _, roll := range []bool{false, true} {
		if _, ok := ix.Measure(secondsDown, "platform", []period.Period{m}, roll); ok {
			t.Errorf("rollItems=%v: platform should have no value for an OrgAgg none measure", roll)
		}
	}
	// Items themselves still have their own values.
	if got := mustMeasure(t, ix, secondsDown, "svc-a", []period.Period{m}, false); got.V != 30 || !got.Direct {
		t.Errorf("svc-a = %+v, want 30 Direct", got)
	}
	// A direct value on the unit is still returned for none.
	ix = NewIndex(fixtureInput(t, pt("seconds_down", "platform", m, 5)))
	if got := mustMeasure(t, ix, secondsDown, "platform", []period.Period{m}, false); got.V != 5 {
		t.Errorf("direct none = %v, want 5", got.V)
	}
}

func TestAllNotApplicable(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		na("on_time", "gateway", m, "No initiatives ended"),
		na("on_time", "storage", m, "No initiatives ended"),
	))
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, false)
	if got.NAReason != "No initiatives ended" || got.Have != 0 || got.Expected != 1 {
		t.Errorf("got %+v, want NA reason, Have 0, Expected 1", got)
	}
}

func TestNotApplicableReasonsDiffer(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		na("on_time", "gateway", m, "reason one"),
		na("on_time", "storage", m, "reason two"),
	))
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, false)
	if got.NAReason != "Not applicable" {
		t.Errorf("NAReason = %q, want %q", got.NAReason, "Not applicable")
	}
}

func TestNotApplicableChildSkipped(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		pt("on_time", "gateway", m, 10),
		na("on_time", "storage", m, "none ended"),
	))
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, false)
	if got.V != 10 || got.NAReason != "" {
		t.Errorf("got %+v, want V=10 and no NA reason", got)
	}
}

func TestDirectNotApplicableOverridesChildren(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		na("on_time", "platform", m, "frozen"),
		pt("on_time", "gateway", m, 10),
	))
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, false)
	if got.NAReason != "frozen" || got.V != 0 {
		t.Errorf("got %+v, want NA 'frozen'", got)
	}
}

func TestNotApplicableMonthsExcludedOverTime(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		pt("on_time", "gateway", month(2026, 1), 4),
		na("on_time", "gateway", month(2026, 2), "n/a"),
		pt("on_time", "gateway", month(2026, 3), 6),
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	got := mustMeasure(t, ix, onTime, "gateway", slots, false)
	if got.V != 10 || got.Have != 2 || got.Expected != 3 || got.NAReason != "" {
		t.Errorf("got %+v, want V=10 Have=2 Expected=3", got)
	}
}

func TestAllMonthsNotApplicableOverTime(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		na("on_time", "gateway", month(2026, 1), "n/a"),
		na("on_time", "gateway", month(2026, 2), "n/a"),
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	got := mustMeasure(t, ix, onTime, "gateway", slots, false)
	if got.NAReason != "n/a" || got.Have != 0 || got.Expected != 3 {
		t.Errorf("got %+v, want NA 'n/a' Have 0 Expected 3", got)
	}
}

func TestNoDataIsNotOK(t *testing.T) {
	ix := NewIndex(fixtureInput(t))
	if _, ok := ix.Measure(onTime, "company", []period.Period{month(2026, 1)}, false); ok {
		t.Errorf("ok = true with no data")
	}
	if _, ok := ix.Measure(onTime, "company", nil, false); ok {
		t.Errorf("ok = true with no slots")
	}
}

func TestUnknownSubject(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t, pt("on_time", "ghost", m, 99), pt("on_time", "gateway", m, 1)))
	if _, ok := ix.Measure(onTime, "ghost", []period.Period{m}, false); ok {
		t.Errorf("unknown subject returned ok")
	}
	// Data for the unknown subject does not leak into anyone's rollup.
	if got := mustMeasure(t, ix, onTime, "company", []period.Period{m}, false); got.V != 1 {
		t.Errorf("company = %v, want 1", got.V)
	}
}

func TestRollItems(t *testing.T) {
	m := month(2026, 1)
	ix := NewIndex(fixtureInput(t,
		pt("on_time", "svc-a", m, 3), pt("on_time", "svc-b", m, 4),
		pt("on_time", "gateway", m, 10),
	))
	if got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, false); got.V != 10 {
		t.Errorf("rollItems=false platform = %v, want 10", got.V)
	}
	got := mustMeasure(t, ix, onTime, "platform", []period.Period{m}, true)
	if got.V != 17 || got.Direct {
		t.Errorf("rollItems=true platform = %+v, want 17 not direct", got)
	}
	// Items roll up through the tree too.
	if got := mustMeasure(t, ix, onTime, "company", []period.Period{m}, true); got.V != 17 {
		t.Errorf("rollItems=true company = %v, want 17", got.V)
	}
	// Item values never leak without rollItems.
	if got := mustMeasure(t, ix, onTime, "company", []period.Period{m}, false); got.V != 10 {
		t.Errorf("rollItems=false company = %v, want 10", got.V)
	}
}

func TestOrgAggMinMaxAverageLatest(t *testing.T) {
	m := month(2026, 1)
	at := func(h int) time.Time { return time.Date(2026, 2, 1, h, 0, 0, 0, time.UTC) }
	a := pt("x", "gateway", m, 2)
	a.EnteredAt = at(9)
	b := pt("x", "storage", m, 8)
	b.EnteredAt = at(7)
	ix := NewIndex(fixtureInput(t, a, b))
	cases := []struct {
		agg  domain.Agg
		want float64
	}{
		{domain.AggMin, 2}, {domain.AggMax, 8}, {domain.AggSum, 10},
		{domain.AggAverage, 5}, {domain.AggLatest, 2}, // gateway entered last
	}
	for _, c := range cases {
		meas := domain.Measure{Key: "x", OrgAgg: c.agg, TimeAgg: domain.AggSum}
		if got := mustMeasure(t, ix, meas, "platform", []period.Period{m}, false); got.V != c.want {
			t.Errorf("OrgAgg %s = %v, want %v", c.agg, got.V, c.want)
		}
	}
}

func TestTimeAggs(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		pt("x", "gateway", month(2026, 1), 2),
		pt("x", "gateway", month(2026, 2), 8),
		// month 3 missing
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	cases := []struct {
		agg  domain.Agg
		want float64
	}{
		{domain.AggSum, 10}, {domain.AggMin, 2}, {domain.AggMax, 8},
		{domain.AggAverage, 5}, // mean of months WITH data, not of 3
		{domain.AggLatest, 8},
	}
	for _, c := range cases {
		meas := domain.Measure{Key: "x", OrgAgg: domain.AggSum, TimeAgg: c.agg}
		got := mustMeasure(t, ix, meas, "gateway", slots, false)
		if got.V != c.want || got.Have != 2 || got.Expected != 3 {
			t.Errorf("TimeAgg %s = %+v, want V=%v Have=2 Expected=3", c.agg, got, c.want)
		}
	}
}

func TestDirectFlagOverTime(t *testing.T) {
	// M01 direct on platform, M02 only from children: not wholly Direct.
	ix := NewIndex(fixtureInput(t,
		pt("on_time", "platform", month(2026, 1), 10),
		pt("on_time", "gateway", month(2026, 2), 5),
	))
	slots := Slots(cal, period.Month, monthsOf(quarter(2026, 1)))
	got := mustMeasure(t, ix, onTime, "platform", slots, false)
	if got.V != 15 || got.Direct {
		t.Errorf("got %+v, want V=15 Direct=false", got)
	}
}

func TestRetiredChildExcluded(t *testing.T) {
	in := fixtureInput(t, pt("on_time", "gateway", month(2026, 1), 10), pt("on_time", "gateway", month(2026, 9), 10),
		pt("on_time", "storage", month(2026, 9), 1))
	r := month(2026, 6)
	units := []domain.OrgUnit{
		{ID: "company", Name: "Company"},
		{ID: "platform", Name: "Platform", ParentID: "company"},
		{ID: "gateway", Name: "Gateway", ParentID: "platform", RetiredFrom: &r},
		{ID: "storage", Name: "Storage", ParentID: "platform"},
	}
	tr := newTree(t, units)
	in.Tree = tr
	ix := NewIndex(in)
	if got := mustMeasure(t, ix, onTime, "platform", []period.Period{month(2026, 1)}, false); got.V != 10 {
		t.Errorf("before retirement = %v, want 10", got.V)
	}
	if got := mustMeasure(t, ix, onTime, "platform", []period.Period{month(2026, 9)}, false); got.V != 1 {
		t.Errorf("after retirement = %v, want 1 (retired unit excluded)", got.V)
	}
}

func TestDuplicatePointsLatestRevisionWins(t *testing.T) {
	m := month(2026, 1)
	a := pt("on_time", "gateway", m, 1)
	a.Revision = 1
	b := pt("on_time", "gateway", m, 2)
	b.Revision = 2
	ix := NewIndex(fixtureInput(t, b, a))
	if got := mustMeasure(t, ix, onTime, "gateway", []period.Period{m}, false); got.V != 2 {
		t.Errorf("got %v, want revision 2 value", got.V)
	}
}

func TestSlots(t *testing.T) {
	h1 := monthsOf(half(2026, 1))
	if diff := cmp.Diff([]period.Period{quarter(2026, 1), quarter(2026, 2)}, Slots(cal, period.Quarter, h1)); diff != "" {
		t.Errorf("quarters of H1 (-want +got)\n%s", diff)
	}
	// YTD through M05 contains only one full quarter.
	ytd := cal.YTD(month(2026, 5))
	if diff := cmp.Diff([]period.Period{quarter(2026, 1)}, Slots(cal, period.Quarter, ytd)); diff != "" {
		t.Errorf("quarters of YTD-M05 (-want +got)\n%s", diff)
	}
	if got := Slots(cal, period.Quarter, ytd[:2]); len(got) != 0 {
		t.Errorf("two months contain no quarter, got %v", got)
	}
	if diff := cmp.Diff(ytd, Slots(cal, period.Month, ytd)); diff != "" {
		t.Errorf("month slots (-want +got)\n%s", diff)
	}
	// Returned months slice is a copy.
	out := Slots(cal, period.Month, ytd)
	out[0] = month(1999, 1)
	if ytd[0] == out[0] {
		t.Errorf("Slots(Month) aliased its input")
	}
	// Half and Year grains.
	fy := monthsOf(period.Period{Grain: period.Year, FY: 2026})
	if diff := cmp.Diff([]period.Period{half(2026, 1), half(2026, 2)}, Slots(cal, period.Half, fy)); diff != "" {
		t.Errorf("halves (-want +got)\n%s", diff)
	}
	if diff := cmp.Diff([]period.Period{{Grain: period.Year, FY: 2026}}, Slots(cal, period.Year, fy)); diff != "" {
		t.Errorf("year (-want +got)\n%s", diff)
	}
	if got := Slots(cal, period.Year, fy[:11]); len(got) != 0 {
		t.Errorf("11 months contain no year, got %v", got)
	}
	// Across fiscal years, chronological, with duplicates collapsed.
	two := append(monthsOf(quarter(2027, 1)), monthsOf(quarter(2026, 4))...)
	two = append(two, month(2026, 10))
	want := []period.Period{quarter(2026, 4), quarter(2027, 1)}
	if diff := cmp.Diff(want, Slots(cal, period.Quarter, two)); diff != "" {
		t.Errorf("cross-FY (-want +got)\n%s", diff)
	}
}

func TestQuarterlyData(t *testing.T) {
	ix := NewIndex(fixtureInput(t,
		pt("points", "gateway", quarter(2026, 1), 10),
		pt("points", "storage", quarter(2026, 1), 5),
		pt("points", "gateway", quarter(2026, 2), 20),
	))
	slots := Slots(cal, period.Quarter, monthsOf(half(2026, 1)))
	got := mustMeasure(t, ix, points, "platform", slots, false)
	if got.V != 35 || got.Have != 2 || got.Expected != 2 {
		t.Errorf("got %+v, want V=35 Have=2 Expected=2", got)
	}
}

func TestConcurrentReads(t *testing.T) {
	var data []domain.DataPoint
	for _, m := range monthsOf(period.Period{Grain: period.Year, FY: 2026}) {
		data = append(data, pt("on_time", "gateway", m, 1), pt("on_time", "analytics", m, 2))
	}
	ix := NewIndex(fixtureInput(t, data...))
	slots := Slots(cal, period.Month, monthsOf(period.Period{Grain: period.Year, FY: 2026}))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if v, ok := ix.Measure(onTime, "company", slots, true); !ok || v.V != 36 {
					t.Errorf("got %+v ok=%v, want 36", v, ok)
					return
				}
			}
		}()
	}
	wg.Wait()
}
