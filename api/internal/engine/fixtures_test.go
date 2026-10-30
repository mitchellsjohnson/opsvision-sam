package engine

import (
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// Org fixture (synthetic):
//
//	company
//	├── platform ── gateway, storage        (products)
//	└── data ────── analytics, warehouse    (analytics moves to platform at 2026-M07)
//
// Fiscal year starts in January.
var cal = period.Calendar{FiscalYearStartMonth: time.January}

// Measures from the brief.
var (
	onTime      = domain.Measure{Key: "on_time", Name: "On time", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	committed   = domain.Measure{Key: "committed", Name: "Committed", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	points      = domain.Measure{Key: "points", Name: "Points", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	days        = domain.Measure{Key: "days", Name: "Days", OrgAgg: domain.AggMax, TimeAgg: domain.AggSum}
	secondsDown = domain.Measure{Key: "seconds_down", Name: "Seconds down", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum}
	trained     = domain.Measure{Key: "trained", Name: "Trained", OrgAgg: domain.AggSum, TimeAgg: domain.AggLatest}
)

func month(fy, idx int) period.Period {
	return period.Period{Grain: period.Month, FY: fy, Index: idx}
}

func quarter(fy, idx int) period.Period {
	return period.Period{Grain: period.Quarter, FY: fy, Index: idx}
}

func half(fy, idx int) period.Period {
	return period.Period{Grain: period.Half, FY: fy, Index: idx}
}

func fixtureTree(t *testing.T) *orgtree.Tree {
	t.Helper()
	units := []domain.OrgUnit{
		{ID: "company", Name: "Company", LevelID: "co"},
		{ID: "platform", Name: "Platform", LevelID: "seg", ParentID: "company"},
		{ID: "data", Name: "Data", LevelID: "seg", ParentID: "company"},
		{ID: "analytics", Name: "Analytics", LevelID: "prod", ParentID: "data"},
		{ID: "warehouse", Name: "Warehouse", LevelID: "prod", ParentID: "data"},
		{ID: "gateway", Name: "Gateway", LevelID: "prod", ParentID: "platform"},
		{ID: "storage", Name: "Storage", LevelID: "prod", ParentID: "platform"},
	}
	moves := []domain.OrgMove{
		{UnitID: "analytics", NewParentID: "platform", EffectiveMonth: month(2026, 7)},
	}
	tree, err := orgtree.New(units, moves)
	if err != nil {
		t.Fatalf("orgtree.New: %v", err)
	}
	return tree
}

func newTree(t *testing.T, units []domain.OrgUnit) *orgtree.Tree {
	t.Helper()
	tree, err := orgtree.New(units, nil)
	if err != nil {
		t.Fatalf("orgtree.New: %v", err)
	}
	return tree
}

// fixtureInput returns an Input with the fixture tree, two tracked services
// attached to platform, and the given data points.
func fixtureInput(t *testing.T, data ...domain.DataPoint) *Input {
	t.Helper()
	return &Input{
		Cal:  cal,
		Tree: fixtureTree(t),
		Items: []domain.TrackedItem{
			{ID: "svc-a", KindID: "service", Name: "Service A", OrgUnitID: "platform"},
			{ID: "svc-b", KindID: "service", Name: "Service B", OrgUnitID: "platform"},
		},
		Data: data,
	}
}

func f(v float64) *float64 { return &v }

// pt builds a numeric data point.
func pt(measure, subject string, p period.Period, v float64) domain.DataPoint {
	return domain.DataPoint{MeasureKey: measure, SubjectID: subject, Period: p, Value: f(v)}
}

// na builds a not-applicable data point.
func na(measure, subject string, p period.Period, reason string) domain.DataPoint {
	return domain.DataPoint{MeasureKey: measure, SubjectID: subject, Period: p, NAReason: reason}
}

// monthsOf returns Month slots for p.
func monthsOf(p period.Period) []period.Period { return cal.Months(p) }
