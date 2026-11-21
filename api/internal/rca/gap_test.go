package rca_test

import (
	"strings"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/rca"
)

func label(s string) string {
	return map[string]string{"G": "Green", "Y": "Yellow", "R": "Red", "B": "Blue"}[s]
}

func bands(bs ...domain.Band) domain.StatusRule {
	return domain.StatusRule{Type: domain.RuleBands, Bands: bs}
}

var (
	uptimeMetric = domain.Metric{Key: "uptime", Name: "Uptime", Formula: "(1 - seconds_down / seconds_in_period) * 100",
		Format: domain.FormatPercent2, Direction: domain.DirectionHigherBetter, ChartKind: "uptime",
		Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 99.9}, domain.Band{Status: "Y", Op: ">=", Value: 99.5}, domain.Band{Status: "R"})}
	epicsMetric = domain.Metric{Key: "epics_on_time", Name: "Epics delivered on time", Formula: "epics_on_time / epics_committed * 100",
		Format: domain.FormatPercent0, Direction: domain.DirectionHigherBetter, ChartKind: "ratio",
		Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 90}, domain.Band{Status: "Y", Op: ">=", Value: 80}, domain.Band{Status: "R"})}
	backlogMetric = domain.Metric{Key: "support_backlog", Formula: "open_tickets", Format: domain.FormatNumber0, Direction: domain.DirectionLowerBetter,
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 450}, domain.Band{Status: "Y", Op: "<=", Value: 600}, domain.Band{Status: "R"})}
	spendMetric = domain.Metric{Key: "spend_vs_plan", Formula: "actual_spend / planned_spend * 100", Format: domain.FormatPercent0,
		Direction: domain.DirectionLowerBetter, ChartKind: "money_plan",
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 100}, domain.Band{Status: "Y", Op: "<=", Value: 105}, domain.Band{Status: "R"})}
	defectMetric = domain.Metric{Key: "weighted_defects", Formula: "defect_points / days", Format: domain.FormatNumber1,
		Direction: domain.DirectionLowerBetter, ChartKind: "change",
		Rule: domain.StatusRule{Type: domain.RuleChange, Compare: domain.ComparePriorPeriod, Bands: []domain.Band{
			{Status: "G", Op: ">", Value: 0}, {Status: "Y", Op: ">=", Value: -10}, {Status: "R"}}}}
)

// TestGapAtTheDisplayBoundary: the engine judges the exact value, so a cell
// can be past its best edge while its displayed value sits on it. Its card
// must still explain a gap.
func TestGapAtTheDisplayBoundary(t *testing.T) {
	churn := domain.Metric{Formula: "churn", Format: domain.FormatPercent0, Direction: domain.DirectionLowerBetter,
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 10}, domain.Band{Status: "Y", Op: "<=", Value: 20}, domain.Band{Status: "R"})}
	under500 := domain.Metric{Formula: "open_tickets", Format: domain.FormatNumber0, Direction: domain.DirectionLowerBetter,
		Rule: bands(domain.Band{Status: "G", Op: "<", Value: 500}, domain.Band{Status: "R"})}
	releases := domain.Metric{Formula: "releases", Format: domain.FormatNumber0, Direction: domain.DirectionHigherBetter,
		Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 20}, domain.Band{Status: "Y", Op: ">=", Value: 10}, domain.Band{Status: "R"})}
	age := domain.Metric{Formula: "age_days / ideas", Format: domain.FormatDays0, Direction: domain.DirectionLowerBetter, ChartKind: "days",
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 14}, domain.Band{Status: "R"})}
	score := domain.Metric{Formula: "score", Format: domain.FormatNumber1, Direction: domain.DirectionHigherBetter,
		Rule: domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 4}, {Status: "Y", Min: 0}}}}
	cases := []struct {
		name     string
		m        domain.Metric
		cell     rca.CellFacts
		kind     string
		headline string
	}{
		{"10.4% churn shows 10% but is Yellow", churn, rca.CellFacts{Display: "10%", Status: "Y", Value: fp(10.4)}, "band", "Just above the Green line (10% or less)"},
		{"exclusive edge", under500, rca.CellFacts{Display: "500", Status: "R", Value: fp(500)}, "band", "Just above the Green line (less than 500)"},
		{"higher is better", releases, rca.CellFacts{Display: "20", Status: "Y", Value: fp(19.6)}, "band", "Just below the Green line (20 or more)"},
		{"days", age, rca.CellFacts{Display: "14 days", Status: "R", Value: fp(14.3)}, "days", "Just past the Green line (14 days or fewer)"},
		{"scale step", score, rca.CellFacts{Display: "4.0", Status: "Y", Value: fp(3.96)}, "scale", "Just below the Green step (4.0 or more)"},
		{"no status, judged on the exact value", churn, rca.CellFacts{Display: "10%", Value: fp(10.4)}, "band", "Just above the Green line (10% or less)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := rca.GapOf(rca.GapInput{Metric: tc.m, Cell: tc.cell, StatusLabel: label})
			if g.Kind != tc.kind || g.Headline != tc.headline || g.Units == nil || *g.Units != 1 {
				t.Fatalf("GapOf = %+v (units %v), want %s %q with 1 unit", g, g.Units, tc.kind, tc.headline)
			}
		})
	}
	// At the best status there is nothing to explain, whatever the display.
	for _, c := range []rca.CellFacts{{Display: "10%", Status: "G", Value: fp(10)}, {Display: "10%", Value: fp(9.6)}} {
		if g := rca.GapOf(rca.GapInput{Metric: churn, Cell: c, StatusLabel: label}); g.Kind != "none" || g.Headline != "" {
			t.Fatalf("best cell %+v = %+v", c, g)
		}
	}
	if g := rca.GapOf(rca.GapInput{Metric: score, Cell: rca.CellFacts{Display: "4.0", Status: "G", Value: fp(4)}, StatusLabel: label}); g.Kind != "none" {
		t.Fatalf("best scale cell = %+v", g)
	}
}

func TestDowntimeNeedsAnAvailabilityMetric(t *testing.T) {
	errorRate := domain.Metric{Key: "error_rate", Formula: "errors / requests * 100", Format: domain.FormatPercent2, Direction: domain.DirectionLowerBetter,
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 0.5}, domain.Band{Status: "R"})}
	g := rca.GapOf(rca.GapInput{Metric: errorRate, Cell: rca.CellFacts{Display: "0.94%", Status: "R"}, StatusLabel: label,
		Downtime: &rca.Downtime{PeriodMinutes: 44640, ReportedMinutes: 420}})
	if g.Kind != "band" || g.Headline != "0.44 pts above the Green line (0.50% or less)" {
		t.Fatalf("lower-is-better percent with incidents = %+v", g)
	}
	count := domain.Metric{Key: "outages", Formula: "outages", Format: domain.FormatNumber0, Direction: domain.DirectionLowerBetter, ChartKind: "uptime",
		Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 2}, domain.Band{Status: "R"})}
	if g := rca.GapOf(rca.GapInput{Metric: count, Cell: rca.CellFacts{Display: "5", Status: "R"}, StatusLabel: label}); g.Kind != "band" || g.Headline != "3 above the Green line (2 or less)" {
		t.Fatalf("uptime chart on a count = %+v", g)
	}
	if _, ok := rca.Ideal(count); ok {
		t.Error("an uptime chart on a count has an ideal")
	}
	for m, want := range map[*domain.Metric]bool{&uptimeMetric: true, &epicsMetric: true, &errorRate: false, &count: false, &backlogMetric: false} {
		if got := rca.DowntimeMetric(*m); got != want {
			t.Errorf("DowntimeMetric(%s) = %v, want %v", m.Key, got, want)
		}
	}
}

func TestPercentScaleRuleIsAScaleGap(t *testing.T) {
	m := domain.Metric{Formula: "score_pct", Format: domain.FormatPercent0, Direction: domain.DirectionHigherBetter,
		Rule: domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 90}, {Status: "Y", Min: 80}, {Status: "R", Min: 0}}}}
	g := rca.GapOf(rca.GapInput{Metric: m, Cell: rca.CellFacts{Display: "85%", Status: "Y"}, StatusLabel: label})
	if g.Kind != "scale" || g.Headline != "5 pts below the Green step (90% or more)" || g.Ideal != nil {
		t.Fatalf("percent scale rule = %+v", g)
	}
}

func TestGapUnitsFromTheDisplayedValue(t *testing.T) {
	display := engine.Format(domain.FormatPercent2, 99.865)
	if display != "99.87%" {
		t.Fatalf("99.865 displays as %q", display)
	}
	if u, ok := rca.GapUnits(100, display, 2); !ok || u != 13 {
		t.Fatalf("GapUnits(100, %q, 2) = %d, %v; want 13 (not 14 from the exact value)", display, u, ok)
	}
	for in, want := range map[string]int64{"73%": 27, "94.5%": 55, "$1,200k": -1100, "16 days": 84, "-5%": 105} {
		dec := 0
		if strings.Contains(in, ".") {
			dec = 1
		}
		if u, ok := rca.GapUnits(100, in, dec); !ok || u != want {
			t.Errorf("GapUnits(100, %q) = %d, %v; want %d", in, u, ok, want)
		}
	}
	if _, ok := rca.GapUnits(100, "n/a", 2); ok {
		t.Error("GapUnits of n/a succeeded")
	}
}

func TestIdealAndDecimals(t *testing.T) {
	for _, m := range []domain.Metric{uptimeMetric, epicsMetric, spendMetric,
		{Format: domain.FormatPercent1, Direction: domain.DirectionHigherBetter, Formula: "trained_pct"}} {
		if v, ok := rca.Ideal(m); !ok || v != 100 {
			t.Errorf("Ideal(%s) = %v, %v", m.Key, v, ok)
		}
	}
	for _, m := range []domain.Metric{backlogMetric, defectMetric,
		{Format: domain.FormatPercent0, Direction: domain.DirectionLowerBetter, Formula: "churn"},
		{Format: domain.FormatMoneyK, Direction: domain.DirectionLowerBetter, Formula: "cost"},
		{Key: "pct_change", Format: domain.FormatPercent1, Direction: domain.DirectionHigherBetter, Formula: "a / b * 100",
			Rule: domain.StatusRule{Type: domain.RuleChange, Compare: domain.ComparePriorPeriod, Bands: []domain.Band{{Status: "G", Op: ">", Value: 0}, {Status: "R"}}}},
		{Key: "pct_scale", Format: domain.FormatPercent0, Direction: domain.DirectionHigherBetter, Formula: "score_pct",
			Rule: domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 90}, {Status: "R", Min: 0}}}}} {
		if _, ok := rca.Ideal(m); ok {
			t.Errorf("Ideal(%s %s) has an ideal", m.Format, m.Direction)
		}
	}
	for f, want := range map[string]int{domain.FormatPercent0: 0, domain.FormatPercent1: 1, domain.FormatPercent2: 2,
		domain.FormatNumber0: 0, domain.FormatNumber1: 1, domain.FormatNumber2: 2, domain.FormatMoneyK: 0, domain.FormatDays0: 0} {
		if got := rca.Decimals(f); got != want {
			t.Errorf("Decimals(%s) = %d, want %d", f, got, want)
		}
	}
}

func TestGapOf(t *testing.T) {
	cases := []struct {
		name             string
		in               rca.GapInput
		kind             string
		headline, detail string
		units            int64
	}{
		{
			name: "downtime",
			in: rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "99.06%", Status: "R"},
				Threshold: "Green at 99.90% or better", Downtime: &rca.Downtime{PeriodMinutes: 44640, ReportedMinutes: 420}},
			kind: "downtime", headline: "0.94 pts short of 100% · 7h 00m down", detail: "Red · Green at 99.90% or better", units: 94,
		},
		{
			name: "downtime from the value",
			in: rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "99.50%", Status: "R"},
				Threshold: "Green at 99.90% or better", Downtime: &rca.Downtime{PeriodMinutes: 43200, ReportedMinutes: 216}, FromValue: true},
			kind: "downtime", headline: "0.50 pts short of 100% · 3h 36m down (from the value)", detail: "Red · Green at 99.90% or better", units: 50,
		},
		{
			name: "downtime at its best status",
			in: rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "99.97%", Status: "G"},
				Threshold: "Green at 99.90% or better", Downtime: &rca.Downtime{PeriodMinutes: 44640, ReportedMinutes: 13.4}},
			kind: "downtime", headline: "0.03 pts short of 100% · 13m down", detail: "Green · Green at 99.90% or better", units: 3,
		},
		{
			name: "ratio",
			in: rca.GapInput{Metric: epicsMetric, Cell: rca.CellFacts{Display: "73%", Status: "R",
				Components: map[string]float64{"epics_on_time": 8, "epics_committed": 11}},
				Threshold: "Green at 90% or better · Red below 80%", Records: &rca.RecordSummary{Noun: "epics", Misses: 3, Denominator: 11}},
			kind: "ratio", headline: "27 pts short of 100% · 3 of 11 epics missed",
			detail: "Red · Green at 90% or better · Red below 80% · each miss costs 9.1 pts", units: 27,
		},
		{
			name: "ratio without records uses the parts",
			in: rca.GapInput{Metric: epicsMetric, Cell: rca.CellFacts{Display: "73%", Status: "R",
				Components: map[string]float64{"epics_on_time": 8, "epics_committed": 11}}, Threshold: "Green at 90% or better"},
			kind: "ratio", headline: "27 pts short of 100% · 3 of 11 missed", detail: "Red · Green at 90% or better · each miss costs 9.1 pts", units: 27,
		},
		{
			name: "percent, not a ratio",
			in: rca.GapInput{Metric: domain.Metric{Formula: "trained_pct", Format: domain.FormatPercent1, Direction: domain.DirectionHigherBetter,
				Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 98}, domain.Band{Status: "R"})},
				Cell: rca.CellFacts{Display: "94.5%", Status: "R"}, Threshold: "Green at 98.0% or better"},
			kind: "percent", headline: "5.5 pts short of 100%", detail: "Red · Green at 98.0% or better", units: 55,
		},
		{
			name: "percent, lower is better",
			in: rca.GapInput{Metric: domain.Metric{Formula: "churn", Format: domain.FormatPercent0, Direction: domain.DirectionLowerBetter,
				Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 10}, domain.Band{Status: "Y", Op: "<=", Value: 20}, domain.Band{Status: "R"})},
				Cell: rca.CellFacts{Display: "14%", Status: "Y"}},
			kind: "band", headline: "4 pts above the Green line (10% or less)", detail: "Yellow", units: 4,
		},
		{
			name: "bands, lower is better",
			in:   rca.GapInput{Metric: backlogMetric, Cell: rca.CellFacts{Display: "588", Status: "Y"}, Threshold: "Lower is better · Yellow above 450 · Red above 600"},
			kind: "band", headline: "138 above the Green line (450 or less)", detail: "Yellow · Lower is better · Yellow above 450 · Red above 600", units: 138,
		},
		{
			name: "bands, higher is better",
			in: rca.GapInput{Metric: domain.Metric{Formula: "releases", Format: domain.FormatNumber0, Direction: domain.DirectionHigherBetter,
				Rule: bands(domain.Band{Status: "G", Op: ">=", Value: 20}, domain.Band{Status: "Y", Op: ">=", Value: 10}, domain.Band{Status: "R"})},
				Cell: rca.CellFacts{Display: "16", Status: "Y"}},
			kind: "band", headline: "4 below the Green line (20 or more)", units: 4, detail: "Yellow",
		},
		{
			name: "days",
			in: rca.GapInput{Metric: domain.Metric{Formula: "age_days / ideas", Format: domain.FormatDays0, Direction: domain.DirectionLowerBetter, ChartKind: "days",
				Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 14}, domain.Band{Status: "Y", Op: "<=", Value: 30}, domain.Band{Status: "R"})},
				Cell: rca.CellFacts{Display: "17 days", Status: "Y"}},
			kind: "days", headline: "3 days past the Green line (14 days or fewer)", units: 3, detail: "Yellow",
		},
		{
			name: "money plan",
			in: rca.GapInput{Metric: spendMetric, Cell: rca.CellFacts{Display: "104%", Status: "Y",
				Components: map[string]float64{"actual_spend": 1196, "planned_spend": 1150}}},
			kind: "plan", headline: "4% over plan · $46k over", units: 4, detail: "Yellow",
		},
		{
			name: "money",
			in: rca.GapInput{Metric: domain.Metric{Formula: "cost", Format: domain.FormatMoneyK, Direction: domain.DirectionLowerBetter,
				Rule: bands(domain.Band{Status: "G", Op: "<=", Value: 800}, domain.Band{Status: "Y", Op: "<=", Value: 1000}, domain.Band{Status: "R"})},
				Cell: rca.CellFacts{Display: "$920k", Status: "Y"}},
			kind: "money", headline: "$120k above the Green line ($800k or less)", units: 120, detail: "Yellow",
		},
		{
			name: "scale rule",
			in: rca.GapInput{Metric: domain.Metric{Formula: "score", Format: domain.FormatNumber1, Direction: domain.DirectionHigherBetter,
				Rule: domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "R", Min: 0}, {Status: "G", Min: 4}, {Status: "Y", Min: 3}}}},
				Cell: rca.CellFacts{Display: "3.4", Status: "Y"}},
			kind: "scale", headline: "0.6 below the Green step (4.0 or more)", units: 6, detail: "Yellow",
		},
		{
			name: "change rule",
			in: rca.GapInput{Metric: defectMetric, Cell: rca.CellFacts{Display: "18.2", Status: "R", Change: fp(-26)},
				ComparedLabel: "Sep", Threshold: "Lower is better · judged on change vs the prior month"},
			kind: "change", headline: "26% worse than Sep · Green needs any improvement",
			detail: "Red · Lower is better · judged on change vs the prior month", units: 0,
		},
		{
			name: "at 100%",
			in:   rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "100.00%", Status: "G"}},
			kind: "none", headline: "", detail: "Green",
		},
		{
			name: "under plan",
			in: rca.GapInput{Metric: spendMetric, Cell: rca.CellFacts{Display: "96%", Status: "G",
				Components: map[string]float64{"actual_spend": 1104, "planned_spend": 1150}}},
			kind: "none", headline: "", detail: "Green",
		},
		{
			name: "no value",
			in:   rca.GapInput{Metric: backlogMetric, Cell: rca.CellFacts{}},
			kind: "none",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			in.StatusLabel = label
			g := rca.GapOf(in)
			if g.Kind != tc.kind || g.Headline != tc.headline || g.Detail != tc.detail {
				t.Fatalf("GapOf = {%q %q %q}, want {%q %q %q}", g.Kind, g.Headline, g.Detail, tc.kind, tc.headline, tc.detail)
			}
			if tc.units != 0 && (g.Units == nil || *g.Units != tc.units) {
				t.Fatalf("units = %v, want %d", g.Units, tc.units)
			}
		})
	}

	g := rca.GapOf(rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "99.06%", Status: "R"}, StatusLabel: label})
	if g.Ideal == nil || *g.Ideal != 100 || g.Decimals != 2 || g.Headline != "0.94 pts short of 100%" {
		t.Fatalf("downtime without minutes = %+v", g)
	}
	if b := rca.GapOf(rca.GapInput{Metric: backlogMetric, Cell: rca.CellFacts{Display: "588", Status: "Y"}, StatusLabel: label}); b.Ideal != nil {
		t.Fatalf("band gap has an ideal: %+v", b)
	}
	// Without a label function the status key is used.
	if d := rca.GapOf(rca.GapInput{Metric: backlogMetric, Cell: rca.CellFacts{Display: "588", Status: "Y"}}); d.Detail != "Y" ||
		d.Headline != "138 above the G line (450 or less)" {
		t.Fatalf("no labels = %+v", d)
	}
	// Green below 100% states its gap whatever the best status: an exec
	// summary is required there.
	if d := rca.GapOf(rca.GapInput{Metric: uptimeMetric, Cell: rca.CellFacts{Display: "99.97%", Status: "G"}, StatusLabel: label,
		BestStatus: "B", Downtime: &rca.Downtime{PeriodMinutes: 44640, ReportedMinutes: 13.4}}); d.Headline != "0.03 pts short of 100% · 13m down" {
		t.Fatalf("G under a best of B = %q", d.Headline)
	}
	// Per-subject bands are the caller's: pass them as the metric's bands.
	own := backlogMetric
	own.Rule = bands(domain.Band{Status: "G", Op: "<", Value: 500}, domain.Band{Status: "R"})
	if d := rca.GapOf(rca.GapInput{Metric: own, Cell: rca.CellFacts{Display: "588", Status: "R"}, StatusLabel: label}); d.Headline != "88 above the Green line (less than 500)" {
		t.Fatalf("exclusive edge = %q", d.Headline)
	}
}
