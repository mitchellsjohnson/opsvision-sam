package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

func metricOf(key string) domain.Metric {
	return domain.Metric{
		Key:        key,
		Name:       "Metric " + key,
		CategoryID: "quality",
		Formula:    "a / b",
		Format:     domain.FormatPercent1,
		Direction:  domain.DirectionHigherBetter,
		Frequency:  domain.FrequencyMonthly,
		Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
			{Status: "G", Op: ">=", Value: 90}, {Status: "R"},
		}},
		Definition: "Def",
		Source:     "Src",
	}
}

func methodologyOf(ms ...domain.Metric) domain.Methodology {
	return domain.Methodology{Metrics: ms}
}

func TestDiffMethodologyIdentical(t *testing.T) {
	m := methodologyOf(metricOf("a"), metricOf("b"))
	d := DiffMethodology(m, m)
	if d.Added == nil || d.Removed == nil || d.Changed == nil {
		t.Fatalf("diff slices must be non-nil: %#v", d)
	}
	if len(d.Added)+len(d.Removed)+len(d.Changed) != 0 {
		t.Errorf("identical diff = %+v", d)
	}
}

func TestDiffMethodologyAddedRemovedSorted(t *testing.T) {
	a := methodologyOf(metricOf("zeta"), metricOf("beta"), metricOf("keep"))
	b := methodologyOf(metricOf("keep"), metricOf("omega"), metricOf("alpha"))
	d := DiffMethodology(a, b)
	if !reflect.DeepEqual(d.Added, []string{"alpha", "omega"}) {
		t.Errorf("added = %v", d.Added)
	}
	if !reflect.DeepEqual(d.Removed, []string{"beta", "zeta"}) {
		t.Errorf("removed = %v", d.Removed)
	}
	if len(d.Changed) != 0 {
		t.Errorf("changed = %+v", d.Changed)
	}
}

func TestDiffMethodologyFieldChanges(t *testing.T) {
	base := metricOf("m")
	cases := []struct {
		field    string
		mutate   func(*domain.Metric)
		from, to any
	}{
		{"name", func(m *domain.Metric) { m.Name = "Renamed" }, "Metric m", "Renamed"},
		{"category", func(m *domain.Metric) { m.CategoryID = "speed" }, "quality", "speed"},
		{"formula", func(m *domain.Metric) { m.Formula = "a / (b + 1)" }, "a / b", "a / (b + 1)"},
		{"direction", func(m *domain.Metric) { m.Direction = domain.DirectionLowerBetter }, "higher_better", "lower_better"},
		{"frequency", func(m *domain.Metric) { m.Frequency = domain.FrequencyQuarterly }, "monthly", "quarterly"},
		{"format", func(m *domain.Metric) { m.Format = domain.FormatNumber0 }, "percent1", "number0"},
		{"definition", func(m *domain.Metric) { m.Definition = "New" }, "Def", "New"},
		{"source", func(m *domain.Metric) { m.Source = "Other" }, "Src", "Other"},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			changed := base
			tc.mutate(&changed)
			d := DiffMethodology(methodologyOf(base), methodologyOf(changed))
			if len(d.Changed) != 1 || d.Changed[0].Key != "m" || len(d.Changed[0].Fields) != 1 {
				t.Fatalf("diff = %+v", d)
			}
			f := d.Changed[0].Fields[0]
			if f.Field != tc.field || f.From != tc.from || f.To != tc.to {
				t.Errorf("field change = %+v, want %s %v -> %v", f, tc.field, tc.from, tc.to)
			}
		})
	}
}

func TestDiffMethodologyRuleAndTargets(t *testing.T) {
	a := metricOf("m")
	b := metricOf("m")
	b.Rule = domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{{Status: "G", Op: ">=", Value: 95}, {Status: "R"}}}
	b.Targets = []domain.Target{{Label: "FY", From: period.Period{Grain: period.Year, FY: 2026}, Value: 97}}

	d := DiffMethodology(methodologyOf(a), methodologyOf(b))
	if len(d.Changed) != 1 || len(d.Changed[0].Fields) != 2 {
		t.Fatalf("diff = %+v", d)
	}
	// Fields come in the documented order: rule before targets.
	if d.Changed[0].Fields[0].Field != "rule" || d.Changed[0].Fields[1].Field != "targets" {
		t.Errorf("fields = %+v", d.Changed[0].Fields)
	}
	for _, f := range d.Changed[0].Fields {
		if _, err := json.Marshal(f); err != nil {
			t.Errorf("%s is not JSON-serializable: %v", f.Field, err)
		}
	}
	rule, ok := d.Changed[0].Fields[0].To.(domain.StatusRule)
	if !ok || rule.Bands[0].Value != 95 {
		t.Errorf("rule to = %#v", d.Changed[0].Fields[0].To)
	}
}

func TestDiffMethodologyNilAndEmptyAreEqual(t *testing.T) {
	a := metricOf("m")
	b := metricOf("m")
	a.Targets = nil
	b.Targets = []domain.Target{}
	a.Rule.PerSubject = nil
	b.Rule.PerSubject = []domain.SubjectBands{}
	if d := DiffMethodology(methodologyOf(a), methodologyOf(b)); len(d.Changed) != 0 {
		t.Errorf("nil vs empty reported as change: %+v", d.Changed)
	}
}

func TestDiffMethodologyIgnoresUncomparedFields(t *testing.T) {
	a := metricOf("m")
	b := metricOf("m")
	b.Notes, b.Example, b.Link, b.RollItemsToOrg = "n", "e", "l", true
	if d := DiffMethodology(methodologyOf(a), methodologyOf(b)); len(d.Changed) != 0 {
		t.Errorf("uncompared fields produced changes: %+v", d.Changed)
	}
}

func TestDiffMethodologyChangedSortedByKey(t *testing.T) {
	var ms, ns []domain.Metric
	for _, k := range []string{"c", "a", "b"} {
		m := metricOf(k)
		n := metricOf(k)
		n.Name = "New " + k
		ms, ns = append(ms, m), append(ns, n)
	}
	d := DiffMethodology(methodologyOf(ms...), methodologyOf(ns...))
	var keys []string
	for _, c := range d.Changed {
		keys = append(keys, c.Key)
	}
	if !reflect.DeepEqual(keys, []string{"a", "b", "c"}) {
		t.Errorf("changed keys = %v", keys)
	}
}
