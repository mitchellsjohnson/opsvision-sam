package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"opsvision/internal/period"
)

// validMethodology returns a minimal methodology that passes validation.
func validMethodology() Methodology {
	return Methodology{
		Categories: []Category{{ID: "quality", Name: "Quality", Order: 1}},
		Measures: []Measure{
			{Key: "a", Name: "A", Unit: "count", OrgAgg: AggSum, TimeAgg: AggSum},
			{Key: "b", Name: "B", Unit: "count", OrgAgg: AggSum, TimeAgg: AggSum},
		},
		Metrics: []Metric{{
			Key: "ratio", Name: "Ratio", CategoryID: "quality", Formula: "a / b",
			Format: FormatPercent1, Direction: DirectionHigherBetter, Frequency: FrequencyMonthly,
			Rule: StatusRule{Type: RuleBands, Bands: []Band{
				{Status: "G", Op: ">=", Value: 0.9},
				{Status: "Y", Op: ">=", Value: 0.7},
				{Status: "R"},
			}},
		}},
	}
}

func hasError(errs []ValidationError, path, contains string) bool {
	for _, e := range errs {
		if e.Path == path && strings.Contains(e.Message, contains) {
			return true
		}
	}
	return false
}

func requireError(t *testing.T, m Methodology, path, contains string) {
	t.Helper()
	errs := m.Validate(DefaultStatusScale())
	if !hasError(errs, path, contains) {
		t.Errorf("want error at %q containing %q, got %+v", path, contains, errs)
	}
}

func TestValidateAcceptsValid(t *testing.T) {
	if errs := validMethodology().Validate(DefaultStatusScale()); len(errs) != 0 {
		t.Fatalf("unexpected errors: %+v", errs)
	}
}

func TestValidateRejectsUnknownMeasure(t *testing.T) {
	m := validMethodology()
	m.Measures = m.Measures[:1] // only "a"
	requireError(t, m, "metrics[0].formula", `unknown measure "b"`)
}

func TestValidateRejectsUnsafeFormula(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Formula = "len(a)"
	requireError(t, m, "metrics[0].formula", "")
}

func TestValidateRejectsEmptyFormula(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Formula = ""
	requireError(t, m, "metrics[0].formula", "")
}

func TestValidateBandsNeedElse(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.Bands = []Band{{Status: "G", Op: ">=", Value: 1}, {Status: "R", Op: "<", Value: 1}}
	requireError(t, m, "metrics[0].rule.bands", "bands must end with an else band")
}

func TestValidateElseBandOnlyLast(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.Bands = []Band{{Status: "G"}, {Status: "R", Op: "<", Value: 1}, {Status: "Y"}}
	requireError(t, m, "metrics[0].rule.bands[0]", "else band")
}

func TestValidateBadBandOp(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.Bands[0].Op = "=="
	requireError(t, m, "metrics[0].rule.bands[0].op", `invalid operator "=="`)
}

func TestValidateEmptyBands(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.Bands = nil
	requireError(t, m, "metrics[0].rule.bands", "bands must end with an else band")
}

func TestValidateStatusInScale(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.Bands[1].Status = "B"
	requireError(t, m, "metrics[0].rule.bands[1].status", `unknown status "B"`)
}

func TestValidatePerSubjectBands(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule.PerSubject = []SubjectBands{
		{SubjectID: "s1", Bands: []Band{{Status: "G", Op: ">=", Value: 1}}},
		{SubjectID: "s2", Bands: []Band{{Status: "Q"}}},
	}
	requireError(t, m, "metrics[0].rule.perSubject[0].bands", "bands must end with an else band")
	requireError(t, m, "metrics[0].rule.perSubject[1].bands[0].status", `unknown status "Q"`)
}

func TestValidateDuplicateKeys(t *testing.T) {
	m := validMethodology()
	m.Measures = []Measure{
		{Key: "x", OrgAgg: AggSum, TimeAgg: AggSum},
		{Key: "x", OrgAgg: AggSum, TimeAgg: AggSum},
	}
	m.Metrics[0].Formula = "x"
	requireError(t, m, "measures[1].key", "duplicate")

	m = validMethodology()
	m.Metrics = append(m.Metrics, m.Metrics[0])
	requireError(t, m, "metrics[1].key", "duplicate")

	m = validMethodology()
	m.Categories = append(m.Categories, m.Categories[0])
	requireError(t, m, "categories[1].id", "duplicate")
}

func TestValidateKeyPattern(t *testing.T) {
	for _, k := range []string{"", "Bad", "1a", "a-b", "min", "max", "abs", "a b"} {
		m := validMethodology()
		m.Measures[0].Key = k
		m.Metrics[0].Formula = "b"
		requireError(t, m, "measures[0].key", "")
	}
	m := validMethodology()
	m.Metrics[0].Key = "Bad Key"
	requireError(t, m, "metrics[0].key", "")
}

func TestValidateChangeRuleNeedsCompare(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule = StatusRule{Type: RuleChange, Bands: []Band{{Status: "G"}}}
	requireError(t, m, "metrics[0].rule.compare", "")

	m.Metrics[0].Rule.Compare = "yesterday"
	requireError(t, m, "metrics[0].rule.compare", "")

	m.Metrics[0].Rule.Compare = ComparePriorPeriod
	if errs := m.Validate(DefaultStatusScale()); len(errs) != 0 {
		t.Errorf("unexpected errors: %+v", errs)
	}
}

func TestValidateScaleRule(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Rule = StatusRule{Type: RuleScale}
	requireError(t, m, "metrics[0].rule.scale", "")

	m.Metrics[0].Rule.Scale = []ScaleStep{{Status: "G", Min: 3}, {Status: "Z", Min: 1}}
	requireError(t, m, "metrics[0].rule.scale[1].status", `unknown status "Z"`)

	m.Metrics[0].Rule.Scale[1].Status = "Y"
	if errs := m.Validate(DefaultStatusScale()); len(errs) != 0 {
		t.Errorf("unexpected errors: %+v", errs)
	}
}

func TestValidateEnums(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Format = "percent9"
	m.Metrics[0].Direction = "sideways"
	m.Metrics[0].Frequency = "weekly"
	m.Metrics[0].Rule.Type = "magic"
	m.Measures[0].OrgAgg = "median"
	m.Measures[1].TimeAgg = ""
	for _, c := range []struct{ path, msg string }{
		{"metrics[0].format", "percent9"},
		{"metrics[0].direction", "sideways"},
		{"metrics[0].frequency", "weekly"},
		{"metrics[0].rule.type", "magic"},
		{"measures[0].orgAgg", "median"},
		{"measures[1].timeAgg", ""},
	} {
		requireError(t, m, c.path, c.msg)
	}
}

func TestValidateCategoryMustExist(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].CategoryID = "nope"
	requireError(t, m, "metrics[0].categoryId", `unknown category "nope"`)
}

func TestValidateCategoryID(t *testing.T) {
	m := validMethodology()
	m.Categories[0].ID = ""
	m.Metrics[0].CategoryID = ""
	requireError(t, m, "categories[0].id", "")
}

func TestValidateSubjectKind(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].ReportedAt = []Subject{{Kind: "planet", ID: "x"}, {Kind: SubjectLevel}}
	requireError(t, m, "metrics[0].reportedAt[0].kind", `"planet"`)
	requireError(t, m, "metrics[0].reportedAt[1].id", "")
}

func TestValidateReportsAllProblems(t *testing.T) {
	m := validMethodology()
	m.Metrics[0].Formula = "a / zzz"
	m.Metrics[0].Format = "bad"
	if errs := m.Validate(DefaultStatusScale()); len(errs) < 2 {
		t.Errorf("want multiple errors, got %+v", errs)
	}
}

func TestDefaultStatusScale(t *testing.T) {
	s := DefaultStatusScale()
	want := []StatusLevel{
		{Key: "G", Label: "Green", Color: "#137A3A", Rank: 1},
		{Key: "Y", Label: "Yellow", Color: "#8A5A00", Rank: 2},
		{Key: "R", Label: "Red", Color: "#B42318", Rank: 3},
	}
	if len(s) != len(want) {
		t.Fatalf("len = %d", len(s))
	}
	for i := range want {
		if s[i] != want[i] {
			t.Errorf("scale[%d] = %+v, want %+v", i, s[i], want[i])
		}
	}
}

func TestJSONShape(t *testing.T) {
	v := MethodologyVersion{
		ID: "v1", ScorecardID: "sc1", Name: "FY26", Status: VersionDraft,
		EffectiveFrom: period.Period{Grain: period.Month, FY: 2026, Index: 1},
		Content:       validMethodology(),
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{`"scorecardId":"sc1"`, `"effectiveFrom":"2026-M01"`, `"status":"draft"`, `"categoryId":"quality"`, `"orgAgg":"sum"`} {
		if !strings.Contains(s, want) {
			t.Errorf("JSON missing %s: %s", want, s)
		}
	}
	var back MethodologyVersion
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.EffectiveFrom != v.EffectiveFrom || back.Content.Metrics[0].Formula != "a / b" {
		t.Errorf("round trip mismatch: %+v", back)
	}

	tb, _ := json.Marshal(Tenant{FiscalYearStartMonth: time.October})
	if !strings.Contains(string(tb), `"fiscalYearStartMonth":10`) {
		t.Errorf("tenant JSON: %s", tb)
	}
}
