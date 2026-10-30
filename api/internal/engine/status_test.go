package engine

import (
	"math"
	"testing"

	"opsvision/internal/domain"
)

func band(status, op string, v float64) domain.Band {
	return domain.Band{Status: status, Op: op, Value: v}
}

func bandsRule(bands ...domain.Band) domain.StatusRule {
	return domain.StatusRule{Type: domain.RuleBands, Bands: bands}
}

func changeRule(cmp domain.Comparison, bands ...domain.Band) domain.StatusRule {
	return domain.StatusRule{Type: domain.RuleChange, Compare: cmp, Bands: bands}
}

func TestEvalStatusBands(t *testing.T) {
	higher := bandsRule(band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0))
	lower := bandsRule(band("G", "<=", 110), band("Y", "<=", 120), band("R", "", 0))
	strict := bandsRule(band("G", ">", 10), band("Y", "<", 5), band("R", "", 0))
	noElse := bandsRule(band("G", ">=", 90))

	tests := []struct {
		name string
		rule domain.StatusRule
		v    float64
		want string
	}{
		{"higher green at boundary", higher, 90, "G"},
		{"higher yellow", higher, 84.3, "Y"},
		{"higher yellow at boundary", higher, 80, "Y"},
		{"higher red", higher, 79.99, "R"},
		{"lower green at boundary", lower, 110, "G"},
		{"lower yellow", lower, 114.2, "Y"},
		{"lower red", lower, 160, "R"},
		{"strict greater", strict, 10.0001, "G"},
		{"strict greater fails at equal", strict, 10, "R"},
		{"strict less", strict, 4.99, "Y"},
		{"strict less fails at equal", strict, 5, "R"},
		{"no matching band and no else", noElse, 10, ""},
		{"no bands", bandsRule(), 10, ""},
	}
	for _, tt := range tests {
		got, change := EvalStatus(tt.rule, domain.DirectionHigherBetter, "gateway", tt.v, nil)
		if got != tt.want {
			t.Errorf("%s: status = %q, want %q", tt.name, got, tt.want)
		}
		if change != nil {
			t.Errorf("%s: bands rule returned change %v, want nil", tt.name, *change)
		}
	}
}

func TestEvalStatusPerSubject(t *testing.T) {
	rule := bandsRule(band("G", ">=", 98), band("Y", ">=", 95), band("R", "", 0))
	rule.PerSubject = []domain.SubjectBands{
		{SubjectID: "svc-a", Bands: []domain.Band{band("G", ">=", 90), band("Y", ">=", 80), band("R", "", 0)}},
	}
	if got, _ := EvalStatus(rule, domain.DirectionHigherBetter, "svc-a", 92, nil); got != "G" {
		t.Errorf("svc-a 92: %q, want G", got)
	}
	if got, _ := EvalStatus(rule, domain.DirectionHigherBetter, "svc-b", 92, nil); got != "R" {
		t.Errorf("svc-b 92: %q, want R (metric bands)", got)
	}
}

func TestEvalStatusScale(t *testing.T) {
	// Deliberately unsorted: evaluation order must not depend on slice order.
	rule := domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{
		{Status: "Y", Min: 3},
		{Status: "G", Min: 4},
		{Status: "R", Min: 0},
	}}
	tests := []struct {
		v    float64
		want string
	}{
		{5, "G"}, {4, "G"}, {3.99, "Y"}, {3, "Y"}, {2.9, "R"}, {0, "R"}, {-0.1, ""},
	}
	for _, tt := range tests {
		got, change := EvalStatus(rule, domain.DirectionHigherBetter, "gateway", tt.v, nil)
		if got != tt.want || change != nil {
			t.Errorf("scale %v: (%q, %v), want (%q, nil)", tt.v, got, change, tt.want)
		}
	}
	// The caller's slice must not be reordered.
	if rule.Scale[0].Status != "Y" {
		t.Error("EvalStatus mutated the rule's scale")
	}
}

func TestEvalStatusChange(t *testing.T) {
	rule := changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("Y", ">=", -5), band("R", "", 0))
	tests := []struct {
		name       string
		dir        domain.Direction
		cur, cmp   float64
		wantStatus string
		wantChange float64
	}{
		{"lower better got worse", domain.DirectionLowerBetter, 696, 597, "R", (597.0 - 696) / 597 * 100},
		{"lower better improved", domain.DirectionLowerBetter, 644, 664, "G", (664.0 - 644) / 664 * 100},
		{"lower better slightly worse", domain.DirectionLowerBetter, 641, 627, "Y", (627.0 - 641) / 627 * 100},
		{"unchanged", domain.DirectionLowerBetter, 2, 2, "Y", 0},
		{"higher better improved", domain.DirectionHigherBetter, 110, 100, "G", 10},
		{"higher better worse", domain.DirectionHigherBetter, 80, 100, "R", -20},
		{"both zero", domain.DirectionHigherBetter, 0, 0, "Y", 0},
		// A negative reference uses its magnitude so that "better" still
		// reads as a positive change.
		{"higher better negative reference improved", domain.DirectionHigherBetter, -5, -10, "G", 50},
		{"lower better negative reference improved", domain.DirectionLowerBetter, -15, -10, "G", 50},
	}
	for _, tt := range tests {
		cmp := tt.cmp
		status, change := EvalStatus(rule, tt.dir, "gateway", tt.cur, &cmp)
		if status != tt.wantStatus {
			t.Errorf("%s: status = %q, want %q", tt.name, status, tt.wantStatus)
		}
		if change == nil || math.Abs(*change-tt.wantChange) > 1e-9 {
			t.Errorf("%s: change = %v, want %v", tt.name, change, tt.wantChange)
		}
	}
}

func TestEvalStatusChangeNoStatus(t *testing.T) {
	rule := changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("R", "", 0))

	// No comparison available.
	if s, c := EvalStatus(rule, domain.DirectionHigherBetter, "gateway", 10, nil); s != "" || c != nil {
		t.Errorf("nil comparison: (%q, %v), want (\"\", nil)", s, c)
	}
	// Reference of zero with a non-zero current value: percentage undefined.
	zero := 0.0
	if s, c := EvalStatus(rule, domain.DirectionHigherBetter, "gateway", 10, &zero); s != "" || c != nil {
		t.Errorf("zero reference: (%q, %v), want (\"\", nil)", s, c)
	}
}

func TestEvalStatusChangePerSubject(t *testing.T) {
	rule := changeRule(domain.ComparePriorPeriod, band("G", ">", 0), band("R", "", 0))
	rule.PerSubject = []domain.SubjectBands{
		{SubjectID: "svc-a", Bands: []domain.Band{band("G", ">=", -50), band("R", "", 0)}},
	}
	cmp := 100.0
	if s, _ := EvalStatus(rule, domain.DirectionHigherBetter, "svc-a", 80, &cmp); s != "G" {
		t.Errorf("svc-a: %q, want G", s)
	}
	if s, _ := EvalStatus(rule, domain.DirectionHigherBetter, "svc-b", 80, &cmp); s != "R" {
		t.Errorf("svc-b: %q, want R", s)
	}
}

func TestEvalStatusUnknownType(t *testing.T) {
	rule := domain.StatusRule{Type: "bogus", Bands: []domain.Band{band("G", "", 0)}}
	if s, c := EvalStatus(rule, domain.DirectionHigherBetter, "x", 1, nil); s != "" || c != nil {
		t.Errorf("unknown rule type: (%q, %v), want (\"\", nil)", s, c)
	}
}
