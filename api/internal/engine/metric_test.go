package engine

import (
	"math"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// Measures local to the metric tests.
var (
	spend    = domain.Measure{Key: "spend", Name: "Spend", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	budget   = domain.Measure{Key: "budget", Name: "Budget", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	measured = domain.Measure{Key: "measured", Name: "Measured", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	within   = domain.Measure{Key: "within", Name: "Within", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	defects  = domain.Measure{Key: "defect_score", Name: "Defect score", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
)

func versionOf(ms ...domain.Measure) domain.MethodologyVersion {
	return domain.MethodologyVersion{ID: "v1", Content: domain.Methodology{Measures: ms}}
}

func metricOf(key, formula, format string, dir domain.Direction, rule domain.StatusRule) domain.Metric {
	return domain.Metric{
		Key: key, Name: key, Formula: formula, Format: format,
		Direction: dir, Frequency: domain.FrequencyMonthly, Rule: rule,
	}
}

func approx(t *testing.T, label string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s = nil, want %v", label, want)
	}
	if math.Abs(*got-want) > 1e-6 {
		t.Errorf("%s = %v, want %v", label, *got, want)
	}
}

func newIndexT(t *testing.T, data ...domain.DataPoint) *Index {
	t.Helper()
	return NewIndex(fixtureInput(t, data...))
}

// TestBandsOnTime: 440/522 against higher-is-better bands.
func TestBandsOnTime(t *testing.T) {
	ix := newIndexT(t, pt("on_time", "gateway", month(2026, 3), 440), pt("committed", "gateway", month(2026, 3), 522))
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)))
	c := ix.Cell(versionOf(onTime, committed), m, "gateway", month(2026, 3))

	approx(t, "Value", c.Value, 440.0/522*100)
	if c.Display != "84.3%" || c.Status != "Y" {
		t.Errorf("Display, Status = %q, %q; want 84.3%%, Y", c.Display, c.Status)
	}
	if c.MetricKey != "on_time_pct" || c.SubjectID != "gateway" || c.Period != month(2026, 3) || c.VersionID != "v1" || c.YTD {
		t.Errorf("identity fields wrong: %+v", c)
	}
	if c.Components["on_time"] != 440 || c.Components["committed"] != 522 || len(c.Components) != 2 {
		t.Errorf("Components = %v", c.Components)
	}
	if c.Coverage != [2]int{1, 1} {
		t.Errorf("Coverage = %v, want [1 1]", c.Coverage)
	}
	if c.NAReason != "" || c.Override != nil || c.Computed != nil {
		t.Errorf("unexpected NAReason/Override/Computed: %+v", c)
	}
}

func TestSpendLowerBetter(t *testing.T) {
	m := metricOf("spend_pct", "spend / budget * 100", domain.FormatPercent1, domain.DirectionLowerBetter,
		bandsRule(band("G", "<=", 110), band("Y", "<=", 120), band("R", "", 0)))
	v := versionOf(spend, budget)

	ix := newIndexT(t,
		pt("spend", "gateway", month(2026, 3), 828), pt("budget", "gateway", month(2026, 3), 725),
		pt("spend", "storage", month(2026, 3), 552), pt("budget", "storage", month(2026, 3), 345),
	)
	c := ix.Cell(v, m, "gateway", month(2026, 3))
	if c.Display != "114.2%" || c.Status != "Y" {
		t.Errorf("gateway: %q %q, want 114.2%% Y", c.Display, c.Status)
	}
	c = ix.Cell(v, m, "storage", month(2026, 3))
	if c.Status != "R" {
		t.Errorf("storage: Status = %q, want R", c.Status)
	}
}

func TestUptime(t *testing.T) {
	// June in a January fiscal year is month 6 and has 30 days (2,592,000 s).
	m := metricOf("uptime", "(2592000 - seconds_down) / 2592000 * 100", domain.FormatPercent2, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 99.9), band("Y", ">=", 99.8), band("R", "", 0)))
	v := versionOf(secondsDown)

	ix := newIndexT(t, pt("seconds_down", "gateway", month(2026, 6), 300), pt("seconds_down", "storage", month(2026, 6), 9331))
	c := ix.Cell(v, m, "gateway", month(2026, 6))
	if c.Display != "99.99%" || c.Status != "G" {
		t.Errorf("gateway: %q %q, want 99.99%% G", c.Display, c.Status)
	}
	c = ix.Cell(v, m, "storage", month(2026, 6))
	if c.Display != "99.64%" || c.Status != "R" {
		t.Errorf("storage: %q %q, want 99.64%% R", c.Display, c.Status)
	}
}

func TestChangeRuleDefectScore(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	v := versionOf(defects)
	tests := []struct {
		cur, prior float64
		want       string
	}{
		{696, 597, "R"},
		{644, 664, "G"},
		{641, 627, "Y"},
		{2, 2, "Y"},
	}
	for _, tt := range tests {
		ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 5), tt.prior), pt("defect_score", "gateway", month(2026, 6), tt.cur))
		c := ix.Cell(v, m, "gateway", month(2026, 6))
		if c.Status != tt.want {
			t.Errorf("%v vs %v: Status = %q, want %q", tt.cur, tt.prior, c.Status, tt.want)
		}
		if c.ChangeKind != "improvement_pct" {
			t.Errorf("%v vs %v: ChangeKind = %q", tt.cur, tt.prior, c.ChangeKind)
		}
		approx(t, "Change", c.Change, (tt.prior-tt.cur)/tt.prior*100)
	}
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 5), 597), pt("defect_score", "gateway", month(2026, 6), 696))
	approx(t, "Change(696 vs 597)", ix.Cell(v, m, "gateway", month(2026, 6)).Change, -16.5829145728643)
}

func TestChangeRuleNoPrior(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("R", "", 0)))
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 6), 696))
	c := ix.Cell(versionOf(defects), m, "gateway", month(2026, 6))
	if c.Value == nil || c.Display != "696" {
		t.Fatalf("value missing: %+v", c)
	}
	if c.Status != "" || c.Change != nil || c.ChangeKind != "" {
		t.Errorf("no prior: Status=%q Change=%v Kind=%q, want empty", c.Status, c.Change, c.ChangeKind)
	}
}

func TestChangeRulePriorYearAverage(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorYearAverage, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	v := versionOf(defects)
	// Prior FY has values in only three months: 100 + 200 + 300. The reference
	// is the metric over the whole prior year (600), not a per-month mean.
	data := []domain.DataPoint{
		pt("defect_score", "gateway", month(2025, 2), 100),
		pt("defect_score", "gateway", month(2025, 7), 200),
		pt("defect_score", "gateway", month(2025, 12), 300),
		pt("defect_score", "gateway", month(2026, 1), 400),
		pt("defect_score", "gateway", month(2026, 2), 150),
		pt("defect_score", "gateway", month(2026, 3), 630),
		pt("defect_score", "gateway", month(2026, 4), 700),
	}
	ix := newIndexT(t, data...)

	// Monthly cell vs the prior-year value.
	c := ix.Cell(v, m, "gateway", month(2026, 2))
	if c.Status != "G" || c.ChangeKind != "improvement_pct" {
		t.Errorf("M02: Status=%q Kind=%q, want G improvement_pct", c.Status, c.ChangeKind)
	}
	approx(t, "M02 Change", c.Change, 75) // (600-150)/600
	if got := ix.Cell(v, m, "gateway", month(2026, 3)).Status; got != "Y" {
		t.Errorf("M03 (630 vs 600 = -5%%): %q, want Y", got)
	}
	if got := ix.Cell(v, m, "gateway", month(2026, 4)).Status; got != "R" {
		t.Errorf("M04 (700 vs 600): %q, want R", got)
	}

	// YTD cell vs the same prior-year value: 400+150 = 550 through M02.
	y := ix.CellYTD(v, m, "gateway", month(2026, 2))
	approx(t, "YTD value", y.Value, 550)
	approx(t, "YTD Change", y.Change, (600.0-550)/600*100)
	if y.Status != "G" {
		t.Errorf("YTD M02: %q, want G", y.Status)
	}
	// YTD through M04 totals 1880: far worse than the whole prior year.
	y = ix.CellYTD(v, m, "gateway", month(2026, 4))
	if y.Status != "R" {
		t.Errorf("YTD M04 (1880 vs 600): %q, want R", y.Status)
	}

	// No data at all in the prior fiscal year => no status.
	ix = newIndexT(t, pt("defect_score", "gateway", month(2026, 4), 150))
	c = ix.Cell(v, m, "gateway", month(2026, 4))
	if c.Status != "" || c.Change != nil || c.ChangeKind != "" {
		t.Errorf("no prior-year data: %+v", c)
	}
}

// A summed metric's YTD total must be compared with a full prior year, not a
// monthly average (which would make every YTD total look like a regression).
func TestPriorYearReferenceSummedYTD(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorYearAverage, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	var data []domain.DataPoint
	for i := 1; i <= 12; i++ {
		data = append(data, pt("defect_score", "gateway", month(2025, i), 100)) // year total 1200
	}
	for i := 1; i <= 6; i++ {
		data = append(data, pt("defect_score", "gateway", month(2026, i), 90)) // YTD 540
	}
	c := newIndexT(t, data...).CellYTD(versionOf(defects), m, "gateway", month(2026, 6))
	approx(t, "Value", c.Value, 540)
	if c.Status != "G" {
		t.Errorf("Status = %q, want G (540 vs 1200)", c.Status)
	}
	approx(t, "Change", c.Change, 55)
}

// For a ratio metric the reference is the ratio of prior-year totals, not an
// average of monthly ratios.
func TestPriorYearReferenceRatioMetric(t *testing.T) {
	m := metricOf("daily_score", "points / days", domain.FormatNumber2, domain.DirectionHigherBetter,
		changeRule(domain.ComparePriorYearAverage, band("G", ">", 0), band("R", "", 0)))
	v := versionOf(points, days)
	ix := newIndexT(t,
		// Prior year: 100/10 = 10 and 300/20 = 15 (mean of ratios 12.5);
		// year totals 400/30.
		pt("points", "gateway", month(2025, 1), 100), pt("days", "gateway", month(2025, 1), 10),
		pt("points", "gateway", month(2025, 6), 300), pt("days", "gateway", month(2025, 6), 20),
		pt("points", "gateway", month(2026, 1), 40), pt("days", "gateway", month(2026, 1), 3),
	)
	ref := 400.0 / 30
	c := ix.Cell(v, m, "gateway", month(2026, 1))
	approx(t, "Value", c.Value, 40.0/3)
	approx(t, "Change", c.Change, (40.0/3-ref)/ref*100)
	y := ix.CellYTD(v, m, "gateway", month(2026, 1))
	approx(t, "YTD Change", y.Change, (40.0/3-ref)/ref*100)
	// 13.0 would beat the mean of ratios (12.5) but not the true reference.
	ix = newIndexT(t,
		pt("points", "gateway", month(2025, 1), 100), pt("days", "gateway", month(2025, 1), 10),
		pt("points", "gateway", month(2025, 6), 300), pt("days", "gateway", month(2025, 6), 20),
		pt("points", "gateway", month(2026, 1), 39), pt("days", "gateway", month(2026, 1), 3),
	)
	if got := ix.Cell(v, m, "gateway", month(2026, 1)).Status; got != "R" {
		t.Errorf("13.0 vs 13.33: %q, want R", got)
	}
}

func TestChangeRuleBaseline(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.CompareBaseline, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	m.Targets = []domain.Target{
		{Label: "Goal", From: month(2026, 1), To: month(2026, 12), Value: 50},
		{Label: "BASELINE", From: month(2026, 1), To: month(2026, 12), Value: 400},
		{Label: "Baseline", SubjectID: "storage", From: month(2026, 1), To: month(2026, 12), Value: 100},
	}
	v := versionOf(defects)
	ix := newIndexT(t,
		pt("defect_score", "gateway", month(2026, 3), 300),
		pt("defect_score", "storage", month(2026, 3), 300),
	)
	c := ix.Cell(v, m, "gateway", month(2026, 3))
	if c.Status != "G" {
		t.Errorf("gateway: Status=%q, want G (300 vs baseline 400)", c.Status)
	}
	approx(t, "gateway Change", c.Change, 25)
	approx(t, "gateway Target", c.Target, 50) // the non-baseline target
	if c := ix.Cell(v, m, "storage", month(2026, 3)); c.Status != "R" {
		t.Errorf("storage: Status=%q, want R (subject baseline 100)", c.Status)
	}

	// No baseline applicable to the period => no status.
	ix = newIndexT(t, pt("defect_score", "gateway", month(2027, 3), 300))
	if c := ix.Cell(v, m, "gateway", month(2027, 3)); c.Status != "" || c.Change != nil {
		t.Errorf("no baseline: Status=%q Change=%v", c.Status, c.Change)
	}
}

func TestDeltaChangeForBandsRule(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	v := versionOf(onTime, committed)
	ix := newIndexT(t,
		pt("on_time", "gateway", month(2026, 2), 80), pt("committed", "gateway", month(2026, 2), 100),
		pt("on_time", "gateway", month(2026, 3), 90), pt("committed", "gateway", month(2026, 3), 100),
		pt("on_time", "gateway", month(2026, 5), 50), pt("committed", "gateway", month(2026, 5), 100),
	)
	c := ix.Cell(v, m, "gateway", month(2026, 3))
	if c.ChangeKind != "delta" {
		t.Fatalf("ChangeKind = %q, want delta", c.ChangeKind)
	}
	approx(t, "Change", c.Change, 10)

	// M05's prior (M04) has no data => no change.
	c = ix.Cell(v, m, "gateway", month(2026, 5))
	if c.Change != nil || c.ChangeKind != "" {
		t.Errorf("M05: Change=%v Kind=%q, want nil/empty", c.Change, c.ChangeKind)
	}
}

// January's prior period is December of the previous fiscal year.
func TestDeltaAcrossFiscalYear(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		bandsRule(band("G", "<=", 100), band("R", "", 0)))
	ix := newIndexT(t, pt("defect_score", "gateway", month(2025, 12), 90), pt("defect_score", "gateway", month(2026, 1), 75))
	c := ix.Cell(versionOf(defects), m, "gateway", month(2026, 1))
	approx(t, "Change", c.Change, -15)
}

func TestZeroDenominatorIsNotApplicable(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	reason := "No initiatives ended this month"
	ix := newIndexT(t,
		na("on_time", "gateway", month(2026, 3), reason),
		na("committed", "gateway", month(2026, 3), reason),
	)
	c := ix.Cell(versionOf(onTime, committed), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != reason || c.Display != "" {
		t.Errorf("got %+v, want nil value, empty status, reason %q", c, reason)
	}
}

func TestZeroDenominatorNumeric(t *testing.T) {
	m := metricOf("pct", "measured / within * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	ix := newIndexT(t, pt("measured", "gateway", month(2026, 3), 0), pt("within", "gateway", month(2026, 3), 0))
	c := ix.Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != NotApplicable || NotApplicable != "Not applicable" {
		t.Errorf("got Value=%v Status=%q NAReason=%q, want nil, \"\", Not applicable", c.Value, c.Status, c.NAReason)
	}
}

func TestMissingInputIsBlank(t *testing.T) {
	m := metricOf("pct", "measured / within * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	// "within" has no data at all.
	ix := newIndexT(t, pt("measured", "gateway", month(2026, 3), 5))
	c := ix.Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != "" || c.Display != "" {
		t.Errorf("got %+v, want a blank cell", c)
	}
	// Blank also wins over a not-applicable sibling.
	ix = newIndexT(t, na("measured", "gateway", month(2026, 3), "Paused"))
	c = ix.Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != "" {
		t.Errorf("missing + NA: %+v, want blank", c)
	}
}

func TestNotApplicableInputWithValueSibling(t *testing.T) {
	m := metricOf("pct", "measured / within * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	ix := newIndexT(t, pt("measured", "gateway", month(2026, 3), 5), na("within", "gateway", month(2026, 3), "Not tracked"))
	c := ix.Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != "Not tracked" {
		t.Errorf("got %+v, want NA with reason Not tracked", c)
	}
	if c.Components["measured"] != 5 || len(c.Components) != 1 {
		t.Errorf("Components = %v, want only measured", c.Components)
	}
}

func TestUnknownMeasureOrBadFormulaIsBlank(t *testing.T) {
	ix := newIndexT(t, pt("on_time", "gateway", month(2026, 3), 5))
	rule := bandsRule(band("G", ">=", 90), band("R", "", 0))
	// Formula references a measure the version does not define.
	m := metricOf("x", "on_time / ghost", domain.FormatNumber1, domain.DirectionHigherBetter, rule)
	c := ix.Cell(versionOf(onTime), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.NAReason != "" {
		t.Errorf("unknown measure: %+v", c)
	}
	// Unparseable formula.
	m = metricOf("x", "on_time +", domain.FormatNumber1, domain.DirectionHigherBetter, rule)
	c = ix.Cell(versionOf(onTime), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" {
		t.Errorf("bad formula: %+v", c)
	}
	// Unknown subject.
	m = metricOf("x", "on_time", domain.FormatNumber1, domain.DirectionHigherBetter, rule)
	c = ix.Cell(versionOf(onTime), m, "nobody", month(2026, 3))
	if c.Value != nil {
		t.Errorf("unknown subject: %+v", c)
	}
}

func TestFormulaOverflowIsNotAValue(t *testing.T) {
	ix := newIndexT(t, pt("spend", "gateway", month(2026, 3), 1e308), pt("budget", "gateway", month(2026, 3), 1e308))
	m := metricOf("x", "spend * budget", domain.FormatNumber1, domain.DirectionHigherBetter, bandsRule(band("G", "", 0)))
	c := ix.Cell(versionOf(spend, budget), m, "gateway", month(2026, 3))
	if c.Value != nil || c.Status != "" || c.Display != "" {
		t.Errorf("overflow: %+v, want no value", c)
	}
}

func TestPerSubjectBands(t *testing.T) {
	rule := bandsRule(band("G", ">=", 98), band("Y", ">=", 95), band("R", "", 0))
	rule.PerSubject = []domain.SubjectBands{
		{SubjectID: "svc-a", Bands: []domain.Band{band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)}},
	}
	m := metricOf("health", "health", domain.FormatPercent0, domain.DirectionHigherBetter, rule)
	health := domain.Measure{Key: "health", OrgAgg: domain.AggAverage, TimeAgg: domain.AggAverage}
	ix := newIndexT(t, pt("health", "svc-a", month(2026, 3), 92), pt("health", "svc-b", month(2026, 3), 92))
	v := versionOf(health)
	if got := ix.Cell(v, m, "svc-a", month(2026, 3)).Status; got != "G" {
		t.Errorf("svc-a: %q, want G", got)
	}
	if got := ix.Cell(v, m, "svc-b", month(2026, 3)).Status; got != "R" {
		t.Errorf("svc-b: %q, want R", got)
	}
}

func TestScaleRuleCell(t *testing.T) {
	m := metricOf("score", "defect_score", domain.FormatNumber1, domain.DirectionHigherBetter,
		domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "R", Min: 0}, {Status: "Y", Min: 3}, {Status: "G", Min: 4}}})
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 3), 3.5), pt("defect_score", "storage", month(2026, 3), -1))
	v := versionOf(defects)
	if got := ix.Cell(v, m, "gateway", month(2026, 3)).Status; got != "Y" {
		t.Errorf("gateway: %q, want Y", got)
	}
	c := ix.Cell(v, m, "storage", month(2026, 3))
	if c.Status != "" || c.Display != "-1.0" {
		t.Errorf("storage: Status=%q Display=%q, want empty and -1.0", c.Status, c.Display)
	}
}

func TestOverrideReplacesStatus(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)))
	in := fixtureInput(t, pt("on_time", "gateway", month(2026, 3), 440), pt("committed", "gateway", month(2026, 3), 522))
	at := time.Date(2026, 4, 2, 9, 0, 0, 0, time.UTC)
	in.Overrides = []domain.Override{
		{MetricKey: "on_time_pct", SubjectID: "gateway", Period: month(2026, 3), Status: "G", Reason: "As reported in legacy workbook", By: "u1", At: at},
		// Different period, subject and metric: must not apply.
		{MetricKey: "on_time_pct", SubjectID: "gateway", Period: month(2026, 4), Status: "R", Reason: "other period"},
		{MetricKey: "on_time_pct", SubjectID: "storage", Period: month(2026, 3), Status: "R", Reason: "other subject"},
		{MetricKey: "other", SubjectID: "gateway", Period: month(2026, 3), Status: "R", Reason: "other metric"},
	}
	ix := NewIndex(in)
	c := ix.Cell(versionOf(onTime, committed), m, "gateway", month(2026, 3))
	if c.Status != "G" {
		t.Errorf("Status = %q, want G", c.Status)
	}
	if c.Computed == nil || c.Computed.Status != "Y" {
		t.Fatalf("Computed = %+v, want status Y", c.Computed)
	}
	approx(t, "Computed.Value", c.Computed.Value, 440.0/522*100)
	if c.Override == nil || c.Override.Reason != "As reported in legacy workbook" || c.Override.By != "u1" {
		t.Errorf("Override = %+v", c.Override)
	}
	// Value is not overridden.
	approx(t, "Value", c.Value, 440.0/522*100)
	if c.Display != "84.3%" {
		t.Errorf("Display = %q", c.Display)
	}
}

func TestOverrideReplacesValue(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)))
	in := fixtureInput(t, pt("on_time", "gateway", month(2026, 3), 440), pt("committed", "gateway", month(2026, 3), 522))
	in.Overrides = []domain.Override{{MetricKey: "on_time_pct", SubjectID: "gateway", Period: month(2026, 3), Value: f(95), Reason: "Corrected"}}
	c := NewIndex(in).Cell(versionOf(onTime, committed), m, "gateway", month(2026, 3))
	approx(t, "Value", c.Value, 95)
	if c.Display != "95.0%" {
		t.Errorf("Display = %q, want 95.0%%", c.Display)
	}
	// Status was not overridden, so it is re-evaluated from the new value.
	if c.Status != "G" {
		t.Errorf("Status = %q, want G (re-evaluated from 95)", c.Status)
	}
	// Computed keeps the engine's own result.
	if c.Computed == nil || c.Computed.Status != "Y" {
		t.Fatalf("Computed = %+v", c.Computed)
	}
	approx(t, "Computed.Value", c.Computed.Value, 440.0/522*100)
	if c.Override == nil {
		t.Error("Override not set")
	}
}

// An override that sets both keeps its explicit status.
func TestOverrideValueAndStatus(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)))
	in := fixtureInput(t, pt("on_time", "gateway", month(2026, 3), 440), pt("committed", "gateway", month(2026, 3), 522))
	in.Overrides = []domain.Override{{MetricKey: "on_time_pct", SubjectID: "gateway", Period: month(2026, 3), Value: f(95), Status: "R", Reason: "Manual"}}
	c := NewIndex(in).Cell(versionOf(onTime, committed), m, "gateway", month(2026, 3))
	approx(t, "Value", c.Value, 95)
	if c.Status != "R" {
		t.Errorf("Status = %q, want the override's R", c.Status)
	}
	if c.Computed == nil || c.Computed.Status != "Y" {
		t.Errorf("Computed = %+v", c.Computed)
	}
}

// Overriding the value of a change-rule metric re-derives status and change.
func TestOverrideValueChangeRule(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	in := fixtureInput(t, pt("defect_score", "gateway", month(2026, 5), 100), pt("defect_score", "gateway", month(2026, 6), 130))
	in.Overrides = []domain.Override{{MetricKey: "defect_score", SubjectID: "gateway", Period: month(2026, 6), Value: f(80), Reason: "Corrected"}}
	c := NewIndex(in).Cell(versionOf(defects), m, "gateway", month(2026, 6))
	if c.Status != "G" || c.ChangeKind != "improvement_pct" {
		t.Errorf("Status=%q Kind=%q, want G improvement_pct", c.Status, c.ChangeKind)
	}
	approx(t, "Change", c.Change, 20)
	if c.Computed == nil || c.Computed.Status != "R" {
		t.Errorf("Computed = %+v, want engine status R", c.Computed)
	}
	approx(t, "Computed.Value", c.Computed.Value, 130)
}

// Overriding the value of a cell the engine could not judge supplies a status
// and, for a change rule, the comparison is fetched for the new value.
func TestOverrideValueOnBlankChangeCell(t *testing.T) {
	m := metricOf("pct", "measured / within * 100", domain.FormatNumber0, domain.DirectionHigherBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("R", "", 0)))
	in := fixtureInput(t,
		pt("measured", "gateway", month(2026, 2), 50), pt("within", "gateway", month(2026, 2), 100),
		pt("measured", "gateway", month(2026, 3), 0), pt("within", "gateway", month(2026, 3), 0),
	)
	in.Overrides = []domain.Override{{MetricKey: "pct", SubjectID: "gateway", Period: month(2026, 3), Value: f(60), Reason: "Manual"}}
	c := NewIndex(in).Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	if c.Status != "G" {
		t.Errorf("Status = %q, want G (60 vs 50)", c.Status)
	}
	approx(t, "Change", c.Change, 20)
}

// Status is judged on the value as displayed.
func TestStatusUsesDisplayPrecision(t *testing.T) {
	rule := bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0))
	health := domain.Measure{Key: "health", OrgAgg: domain.AggAverage, TimeAgg: domain.AggAverage}
	v := versionOf(health)
	tests := []struct {
		format string
		val    float64
		disp   string
		want   string
	}{
		{domain.FormatPercent1, 89.96, "90.0%", "G"},
		{domain.FormatPercent1, 89.94, "89.9%", "Y"},
		{domain.FormatPercent1, 89.95, "90.0%", "G"},
		{domain.FormatPercent0, 89.5, "90%", "G"},
		{domain.FormatPercent0, 89.49, "89%", "Y"},
		{domain.FormatPercent2, 89.996, "90.00%", "G"},
		{domain.FormatPercent2, 89.994, "89.99%", "Y"},
		{domain.FormatNumber0, 79.5, "80", "Y"},
	}
	for _, tt := range tests {
		m := metricOf("h", "health", tt.format, domain.DirectionHigherBetter, rule)
		c := newIndexT(t, pt("health", "gateway", month(2026, 3), tt.val)).Cell(v, m, "gateway", month(2026, 3))
		if c.Display != tt.disp || c.Status != tt.want {
			t.Errorf("%s %v: Display=%q Status=%q, want %q %q", tt.format, tt.val, c.Display, c.Status, tt.disp, tt.want)
		}
		approx(t, "Value stays unrounded", c.Value, tt.val)
	}
	// Lower-is-better bands and scale rules round the same way.
	low := metricOf("s", "spend / budget * 100", domain.FormatPercent1, domain.DirectionLowerBetter,
		bandsRule(band("G", "<=", 110), band("R", "", 0)))
	c := newIndexT(t, pt("spend", "gateway", month(2026, 3), 110.04), pt("budget", "gateway", month(2026, 3), 100)).
		Cell(versionOf(spend, budget), low, "gateway", month(2026, 3))
	if c.Display != "110.0%" || c.Status != "G" {
		t.Errorf("lower: %q %q, want 110.0%% G", c.Display, c.Status)
	}
	sc := metricOf("sc", "health", domain.FormatNumber1, domain.DirectionHigherBetter,
		domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 4}, {Status: "R", Min: 0}}})
	c = newIndexT(t, pt("health", "gateway", month(2026, 3), 3.96)).Cell(v, sc, "gateway", month(2026, 3))
	if c.Display != "4.0" || c.Status != "G" {
		t.Errorf("scale: %q %q, want 4.0 G", c.Display, c.Status)
	}
}

// Change rules compute improvement from unrounded values.
func TestChangeRuleUsesUnroundedValues(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0)))
	// Both display as 100, but the value did improve by 0.4%.
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 5), 100.2), pt("defect_score", "gateway", month(2026, 6), 99.8))
	c := ix.Cell(versionOf(defects), m, "gateway", month(2026, 6))
	if c.Display != "100" || c.Status != "G" {
		t.Errorf("Display=%q Status=%q, want 100 G", c.Display, c.Status)
	}
	approx(t, "Change", c.Change, (100.2-99.8)/100.2*100)
}

// An override can supply a value where the engine has none.
func TestOverrideFillsBlankCell(t *testing.T) {
	m := metricOf("pct", "measured / within * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	in := fixtureInput(t, pt("measured", "gateway", month(2026, 3), 0), pt("within", "gateway", month(2026, 3), 0))
	in.Overrides = []domain.Override{{MetricKey: "pct", SubjectID: "gateway", Period: month(2026, 3), Value: f(100), Status: "G", Reason: "Manual"}}
	c := NewIndex(in).Cell(versionOf(measured, within), m, "gateway", month(2026, 3))
	approx(t, "Value", c.Value, 100)
	if c.Display != "100.0%" || c.Status != "G" || c.NAReason != "" {
		t.Errorf("got Display=%q Status=%q NAReason=%q", c.Display, c.Status, c.NAReason)
	}
	if c.Computed == nil || c.Computed.Value != nil || c.Computed.Status != "" {
		t.Errorf("Computed = %+v, want empty", c.Computed)
	}
}

func TestLatestOverrideWins(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	in := fixtureInput(t, pt("defect_score", "gateway", month(2026, 3), 5))
	in.Overrides = []domain.Override{
		{MetricKey: "defect_score", SubjectID: "gateway", Period: month(2026, 3), Status: "R", Reason: "old", At: time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)},
		{MetricKey: "defect_score", SubjectID: "gateway", Period: month(2026, 3), Status: "G", Reason: "new", At: time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC)},
	}
	c := NewIndex(in).Cell(versionOf(defects), m, "gateway", month(2026, 3))
	if c.Status != "G" || c.Override == nil || c.Override.Reason != "new" {
		t.Errorf("got Status=%q Override=%+v, want the newest", c.Status, c.Override)
	}
}

// Overridden prior values feed the change shown for the next period.
func TestChangeUsesOverriddenValues(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	in := fixtureInput(t, pt("defect_score", "gateway", month(2026, 2), 10), pt("defect_score", "gateway", month(2026, 3), 30))
	in.Overrides = []domain.Override{{MetricKey: "defect_score", SubjectID: "gateway", Period: month(2026, 2), Value: f(20), Reason: "fix"}}
	c := NewIndex(in).Cell(versionOf(defects), m, "gateway", month(2026, 3))
	approx(t, "Change", c.Change, 10)
}

func TestTargetLookup(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("R", "", 0)))
	m.Targets = []domain.Target{{Label: "H1 goal", From: half(2026, 1), To: half(2026, 1), Value: 90}}
	v := versionOf(onTime, committed)
	ix := newIndexT(t,
		pt("on_time", "gateway", month(2026, 3), 9), pt("committed", "gateway", month(2026, 3), 10),
		pt("on_time", "gateway", month(2026, 7), 9), pt("committed", "gateway", month(2026, 7), 10),
	)
	approx(t, "M03 target", ix.Cell(v, m, "gateway", month(2026, 3)).Target, 90)
	if got := ix.Cell(v, m, "gateway", month(2026, 7)).Target; got != nil {
		t.Errorf("M07 target = %v, want nil", *got)
	}
}

func TestTargetSelection(t *testing.T) {
	v := versionOf(defects)
	rule := bandsRule(band("Y", "", 0))
	base := metricOf("d", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, rule)
	data := []domain.DataPoint{pt("defect_score", "gateway", month(2026, 3), 5)}

	t.Run("subject target beats global regardless of order", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{
			{Label: "global", From: month(2026, 1), To: month(2026, 12), Value: 10},
			{Label: "gateway goal", SubjectID: "gateway", From: month(2026, 1), To: month(2026, 12), Value: 20},
		}
		approx(t, "Target", newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target, 20)
	})
	t.Run("other subject's target ignored", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{{Label: "storage goal", SubjectID: "storage", From: month(2026, 1), To: month(2026, 12), Value: 20}}
		if got := newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target; got != nil {
			t.Errorf("Target = %v, want nil", *got)
		}
	})
	t.Run("first in slice order among equals", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{
			{Label: "a", From: month(2026, 1), To: month(2026, 12), Value: 1},
			{Label: "b", From: month(2026, 1), To: month(2026, 12), Value: 2},
		}
		approx(t, "Target", newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target, 1)
	})
	t.Run("baseline never the status target", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{
			{Label: "Baseline", From: month(2026, 1), To: month(2026, 12), Value: 1},
			{Label: "Goal", From: month(2026, 1), To: month(2026, 12), Value: 2},
		}
		approx(t, "Target", newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target, 2)
		m.Targets = m.Targets[:1]
		if got := newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target; got != nil {
			t.Errorf("only a baseline: Target = %v, want nil", *got)
		}
	})
	t.Run("open-ended bounds", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{{Label: "forever", Value: 7}}
		approx(t, "unbounded", newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target, 7)
		m.Targets = []domain.Target{{Label: "until", To: month(2026, 3), Value: 8}}
		approx(t, "no From", newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target, 8)
		m.Targets = []domain.Target{{Label: "since", From: month(2026, 4), Value: 9}}
		if got := newIndexT(t, data...).Cell(v, m, "gateway", month(2026, 3)).Target; got != nil {
			t.Errorf("From after period: Target = %v, want nil", *got)
		}
	})
	t.Run("fiscal year boundary", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{{Label: "fy26", From: period.Period{Grain: period.Year, FY: 2026}, To: period.Period{Grain: period.Year, FY: 2026}, Value: 3}}
		ix := newIndexT(t, pt("defect_score", "gateway", month(2025, 12), 5), pt("defect_score", "gateway", month(2026, 1), 5))
		if got := ix.Cell(v, m, "gateway", month(2025, 12)).Target; got != nil {
			t.Errorf("2025-M12 Target = %v, want nil", *got)
		}
		approx(t, "2026-M01", ix.Cell(v, m, "gateway", month(2026, 1)).Target, 3)
	})
	t.Run("a quarter cell needs every month covered", func(t *testing.T) {
		m := base
		m.Targets = []domain.Target{{Label: "Q1 goal", From: month(2026, 1), To: month(2026, 2), Value: 4}}
		ix := newIndexT(t, data...)
		if got := ix.Cell(v, m, "gateway", quarter(2026, 1)).Target; got != nil {
			t.Errorf("Q1 Target = %v, want nil (M03 is outside)", *got)
		}
		m.Targets[0].To = month(2026, 3)
		approx(t, "Q1 covered", ix.Cell(v, m, "gateway", quarter(2026, 1)).Target, 4)
	})
}

func TestCellYTD(t *testing.T) {
	m := metricOf("on_time_pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)))
	m.Targets = []domain.Target{{Label: "FY goal", From: period.Period{Grain: period.Year, FY: 2026}, To: period.Period{Grain: period.Year, FY: 2026}, Value: 90}}
	v := versionOf(onTime, committed)
	var data []domain.DataPoint
	for i, vals := range [][2]float64{{8, 10}, {9, 10}, {10, 10}} { // 2026 M01-M03: 27/30 = 90%
		data = append(data, pt("on_time", "gateway", month(2026, i+1), vals[0]), pt("committed", "gateway", month(2026, i+1), vals[1]))
	}
	for i, vals := range [][2]float64{{6, 10}, {7, 10}, {8, 10}} { // 2025 M01-M03: 21/30 = 70%
		data = append(data, pt("on_time", "gateway", month(2025, i+1), vals[0]), pt("committed", "gateway", month(2025, i+1), vals[1]))
	}
	// Data after the YTD cut-off must not leak in.
	data = append(data, pt("on_time", "gateway", month(2026, 4), 0), pt("committed", "gateway", month(2026, 4), 100))
	in := fixtureInput(t, data...)
	// Overrides never apply to YTD cells.
	in.Overrides = []domain.Override{{MetricKey: "on_time_pct", SubjectID: "gateway", Period: month(2026, 3), Status: "R", Reason: "x"}}
	ix := NewIndex(in)

	c := ix.CellYTD(v, m, "gateway", month(2026, 3))
	if !c.YTD || c.Period != month(2026, 3) {
		t.Errorf("YTD=%v Period=%v", c.YTD, c.Period)
	}
	approx(t, "Value", c.Value, 90)
	if c.Display != "90.0%" || c.Status != "G" || c.Override != nil || c.Computed != nil {
		t.Errorf("got Display=%q Status=%q Override=%v Computed=%v", c.Display, c.Status, c.Override, c.Computed)
	}
	if c.Coverage != [2]int{3, 3} {
		t.Errorf("Coverage = %v, want [3 3]", c.Coverage)
	}
	if c.Components["on_time"] != 27 || c.Components["committed"] != 30 {
		t.Errorf("Components = %v", c.Components)
	}
	approx(t, "Target", c.Target, 90)
	if c.ChangeKind != "delta" {
		t.Errorf("ChangeKind = %q, want delta", c.ChangeKind)
	}
	approx(t, "Change vs last year's YTD", c.Change, 20)

	// The non-YTD cell for the same month is a different thing, and is overridden.
	n := ix.Cell(v, m, "gateway", month(2026, 3))
	if n.YTD || n.Status != "R" {
		t.Errorf("monthly cell: YTD=%v Status=%q, want false/R", n.YTD, n.Status)
	}
	// Last year's YTD has no prior.
	p := ix.CellYTD(v, m, "gateway", month(2025, 3))
	if p.Change != nil || p.ChangeKind != "" {
		t.Errorf("2025 YTD: Change=%v Kind=%q", p.Change, p.ChangeKind)
	}
}

func TestCellYTDChangeRule(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionLowerBetter,
		changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("R", "", 0)))
	ix := newIndexT(t,
		pt("defect_score", "gateway", month(2025, 1), 100), pt("defect_score", "gateway", month(2025, 2), 100),
		pt("defect_score", "gateway", month(2026, 1), 90), pt("defect_score", "gateway", month(2026, 2), 90),
	)
	c := ix.CellYTD(versionOf(defects), m, "gateway", month(2026, 2))
	approx(t, "Value", c.Value, 180)
	if c.Status != "G" || c.ChangeKind != "improvement_pct" {
		t.Errorf("Status=%q Kind=%q", c.Status, c.ChangeKind)
	}
	approx(t, "Change", c.Change, 10)
}

func TestCellYTDNotAMonth(t *testing.T) {
	m := metricOf("d", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	c := newIndexT(t, pt("defect_score", "gateway", month(2026, 1), 1)).CellYTD(versionOf(defects), m, "gateway", quarter(2026, 1))
	if c.Value != nil || !c.YTD {
		t.Errorf("got %+v, want blank YTD cell", c)
	}
}

func TestQuarterlyMetric(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter,
		bandsRule(band("G", ">=", 10), band("R", "", 0)))
	m.Frequency = domain.FrequencyQuarterly
	ix := newIndexT(t,
		pt("defect_score", "gateway", quarter(2026, 1), 12),
		pt("defect_score", "gateway", quarter(2026, 2), 8),
	)
	v := versionOf(defects)
	c := ix.Cell(v, m, "gateway", quarter(2026, 2))
	approx(t, "Q2", c.Value, 8)
	if c.Status != "R" || c.ChangeKind != "delta" {
		t.Errorf("Q2: Status=%q Kind=%q", c.Status, c.ChangeKind)
	}
	approx(t, "Q2 Change", c.Change, -4)
	if c.Coverage != [2]int{1, 1} {
		t.Errorf("Coverage = %v", c.Coverage)
	}
	// Quarterly data cannot answer for a single month.
	if got := ix.Cell(v, m, "gateway", month(2026, 2)); got.Value != nil {
		t.Errorf("month cell of a quarterly metric has value %v", *got.Value)
	}
	// YTD through M06 covers Q1 and Q2 (sum).
	y := ix.CellYTD(v, m, "gateway", month(2026, 6))
	approx(t, "YTD", y.Value, 20)
	// YTD through M05 covers only Q1 (Q2 is incomplete).
	y = ix.CellYTD(v, m, "gateway", month(2026, 5))
	approx(t, "YTD M05", y.Value, 12)
}

func TestMonthlyMetricOverQuarterCoverage(t *testing.T) {
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 1), 1), pt("defect_score", "gateway", month(2026, 3), 3))
	c := ix.Cell(versionOf(defects), m, "gateway", quarter(2026, 1))
	approx(t, "Value", c.Value, 4)
	if c.Coverage != [2]int{2, 3} {
		t.Errorf("Coverage = %v, want [2 3]", c.Coverage)
	}
}

func TestCoverageIsMinAcrossMeasures(t *testing.T) {
	m := metricOf("pct", "on_time / committed * 100", domain.FormatPercent1, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	ix := newIndexT(t,
		pt("on_time", "gateway", month(2026, 1), 1), pt("on_time", "gateway", month(2026, 2), 1), pt("on_time", "gateway", month(2026, 3), 1),
		pt("committed", "gateway", month(2026, 1), 2), pt("committed", "gateway", month(2026, 2), 2),
	)
	c := ix.Cell(versionOf(onTime, committed), m, "gateway", quarter(2026, 1))
	if c.Coverage != [2]int{2, 3} {
		t.Errorf("Coverage = %v, want [2 3]", c.Coverage)
	}
}

func TestRollupThroughCell(t *testing.T) {
	// Platform rolls up its products and attached services as configured.
	m := metricOf("defect_score", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	ix := newIndexT(t,
		pt("defect_score", "gateway", month(2026, 3), 5), pt("defect_score", "storage", month(2026, 3), 7),
		pt("defect_score", "svc-a", month(2026, 3), 100),
	)
	c := ix.Cell(versionOf(defects), m, "platform", month(2026, 3))
	approx(t, "without items", c.Value, 12)
	m.RollItemsToOrg = true
	c = ix.Cell(versionOf(defects), m, "platform", month(2026, 3))
	approx(t, "with items", c.Value, 112)
}

func TestInvalidPeriodOrFrequencyIsBlank(t *testing.T) {
	m := metricOf("d", "defect_score", domain.FormatNumber0, domain.DirectionHigherBetter, bandsRule(band("Y", "", 0)))
	ix := newIndexT(t, pt("defect_score", "gateway", month(2026, 3), 1))
	if c := ix.Cell(versionOf(defects), m, "gateway", period.Period{}); c.Value != nil {
		t.Errorf("zero period: %+v", c)
	}
	m.Frequency = "weekly"
	if c := ix.Cell(versionOf(defects), m, "gateway", month(2026, 3)); c.Value != nil {
		t.Errorf("bad frequency: %+v", c)
	}
}
