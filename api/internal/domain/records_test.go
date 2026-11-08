package domain

import (
	"encoding/json"
	"strings"
	"testing"

	"opsvision/internal/period"
)

func TestDateJSONRoundTrip(t *testing.T) {
	d, err := ParseDate("2026-09-03")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `"2026-09-03"` {
		t.Fatalf("marshal = %s", b)
	}
	var back Date
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if !back.Equal(d.Time) {
		t.Fatalf("round trip = %v, want %v", back, d)
	}

	for _, bad := range []string{"2026-9-3", "2026-09-03T10:00:00Z", "09/03/2026", "2026-02-30", "x"} {
		if _, err := ParseDate(bad); err == nil {
			t.Errorf("ParseDate(%q) succeeded", bad)
		}
	}
	if err := json.Unmarshal([]byte(`123`), &back); err == nil {
		t.Error("unmarshal of a number succeeded")
	}
}

func TestDateInRecordFields(t *testing.T) {
	d, _ := ParseDate("2026-09-03")
	due, _ := ParseDate("2026-10-01")
	f := RecordFields{SubjectKey: "Checkout", State: StateOpen, CreatedAt: d, DueAt: &due}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"createdAt":"2026-09-03"`, `"dueAt":"2026-10-01"`, `"completedAt":null`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("json %s missing %s", b, want)
		}
	}
	var back RecordFields
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.DueAt == nil || !back.DueAt.Equal(due.Time) || back.CompletedAt != nil {
		t.Fatalf("round trip = %+v", back)
	}
}

func TestDateArithmetic(t *testing.T) {
	a, _ := ParseDate("2026-10-30")
	b := a.AddDays(3)
	if b.String() != "2026-11-02" {
		t.Fatalf("AddDays = %s", b)
	}
	if a.AddDays(-30).String() != "2026-09-30" {
		t.Fatalf("AddDays(-30) = %s", a.AddDays(-30))
	}
	if !a.Before(b) || b.Before(a) || a.Before(a) {
		t.Fatal("Before is wrong")
	}
}

func validRecordType() RecordType {
	return RecordType{
		ID: "defect", Name: "Defect",
		Priorities: []string{"P1", "P2", "P3", "P4"},
		Attributes: []AttributeDef{{Key: "customer_ticket", Name: "Customer ticket", Type: AttrBool}},
	}
}

func TestRecordTypeValidate(t *testing.T) {
	if errs := validRecordType().Validate(); errs != nil {
		t.Fatalf("valid record type rejected: %v", errs)
	}

	cases := []struct {
		name   string
		mutate func(*RecordType)
		path   string
	}{
		{"empty id", func(r *RecordType) { r.ID = "" }, "id"},
		{"bad id", func(r *RecordType) { r.ID = "Defect!" }, "id"},
		{"empty name", func(r *RecordType) { r.Name = "" }, "name"},
		{"empty priority", func(r *RecordType) { r.Priorities = []string{"P1", ""} }, "priorities[1]"},
		{"duplicate priority", func(r *RecordType) { r.Priorities = []string{"P1", "P2", "P1"} }, "priorities[2]"},
		{"bad attribute key", func(r *RecordType) { r.Attributes[0].Key = "Customer Ticket" }, "attributes[0].key"},
		{"empty attribute key", func(r *RecordType) { r.Attributes[0].Key = "" }, "attributes[0].key"},
		{"built-in attribute key", func(r *RecordType) { r.Attributes[0].Key = "title" }, "attributes[0].key"},
		{"duplicate attribute key", func(r *RecordType) {
			r.Attributes = append(r.Attributes, AttributeDef{Key: "customer_ticket", Name: "Again", Type: AttrString})
		}, "attributes[1].key"},
		{"unknown attribute type", func(r *RecordType) { r.Attributes[0].Type = "money" }, "attributes[0].type"},
		{"empty attribute name", func(r *RecordType) { r.Attributes[0].Name = "" }, "attributes[0].name"},
		{"tracked-from not a month", func(r *RecordType) {
			r.TrackedFrom = map[string]period.Period{"tracker": {Grain: period.Quarter, FY: 2026, Index: 3}}
		}, "trackedFrom.tracker"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt := validRecordType()
			rt.Attributes = append([]AttributeDef(nil), rt.Attributes...)
			tc.mutate(&rt)
			errs := rt.Validate()
			if !hasPath(errs, tc.path) {
				t.Fatalf("want error at %q, got %v", tc.path, errs)
			}
		})
	}

	rt := validRecordType()
	rt.TrackedFrom = map[string]period.Period{"tracker": {Grain: period.Month, FY: 2026, Index: 10}}
	rt.Priorities = []string{"P1", PriorityNone}
	if errs := rt.Validate(); errs != nil {
		t.Fatalf("month tracked-from and explicit none rejected: %v", errs)
	}
}

func TestRecordTypeAllPriorities(t *testing.T) {
	got := RecordType{Priorities: []string{"P1", "P2"}}.AllPriorities()
	if strings.Join(got, ",") != "P1,P2,none" {
		t.Fatalf("got %v", got)
	}
	got = RecordType{Priorities: []string{"P1", "none"}}.AllPriorities()
	if strings.Join(got, ",") != "P1,none" {
		t.Fatalf("got %v", got)
	}
}

func hasPath(errs []ValidationError, path string) bool {
	for _, e := range errs {
		if e.Path == path {
			return true
		}
	}
	return false
}

func derivedMethodology(d *DeriveRule) Methodology {
	m := validMethodology()
	m.Measures[0].Source = MeasureDerived
	m.Measures[0].Derive = d
	return m
}

func TestDerivedMeasureNeedsRule(t *testing.T) {
	m := validMethodology()
	m.Measures[1].Source = MeasureDerived
	errs := m.Validate(DefaultStatusScale())
	if !hasPath(errs, "measures[1].derive") {
		t.Fatalf("want error at measures[1].derive, got %v", errs)
	}

	// With a rule it is structurally fine; type checks belong to ValidateDerive.
	m.Measures[1].Derive = &DeriveRule{RecordType: "defect", Op: OpDaysInPeriod}
	if errs := m.Validate(DefaultStatusScale()); errs != nil {
		t.Fatalf("derived measure with rule rejected: %v", errs)
	}
}

func TestEnteredMeasureRejectsDerive(t *testing.T) {
	rule := &DeriveRule{RecordType: "defect", Op: OpDaysInPeriod}
	for _, src := range []string{"", MeasureEntered} {
		m := validMethodology()
		m.Measures[0].Source = src
		m.Measures[0].Derive = rule
		if errs := m.Validate(DefaultStatusScale()); !hasPath(errs, "measures[0].derive") {
			t.Fatalf("source %q: want error at measures[0].derive, got %v", src, errs)
		}
	}
}

func TestMeasureSourceInvalid(t *testing.T) {
	m := validMethodology()
	m.Measures[0].Source = "magic"
	if errs := m.Validate(DefaultStatusScale()); !hasPath(errs, "measures[0].source") {
		t.Fatalf("want error at measures[0].source, got %v", errs)
	}
}

func TestMeasureSourceJSONBackwardsCompatible(t *testing.T) {
	var m Measure
	if err := json.Unmarshal([]byte(`{"key":"a","name":"A","unit":"count","orgAgg":"sum","timeAgg":"sum"}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Source != "" || m.Derive != nil {
		t.Fatalf("legacy measure = %+v", m)
	}
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "source") || strings.Contains(string(b), "derive") {
		t.Fatalf("entered measure leaks derive fields: %s", b)
	}
}

func TestDeriveOpParams(t *testing.T) {
	types := []RecordType{
		{
			ID: "defect", Name: "Defect", Priorities: []string{"P1", "P2"},
			Attributes: []AttributeDef{
				{Key: "cost", Name: "Cost", Type: AttrNumber},
				{Key: "reviewed_on", Name: "Reviewed on", Type: AttrDate},
				{Key: "customer_ticket", Name: "Customer ticket", Type: AttrBool},
			},
		},
	}
	full := map[string]float64{"P1": 64, "P2": 16, "none": 1}

	cases := []struct {
		name string
		rule DeriveRule
		path string // "" means valid
	}{
		{"count ok", DeriveRule{RecordType: "defect", Op: OpCount, BucketBy: "dueAt"}, ""},
		{"count with date attribute", DeriveRule{RecordType: "defect", Op: OpCount, BucketBy: "reviewed_on"}, ""},
		{"count needs bucketBy", DeriveRule{RecordType: "defect", Op: OpCount}, "measures[0].derive.bucketBy"},
		{"count bucketBy not a date", DeriveRule{RecordType: "defect", Op: OpCount, BucketBy: "title"}, "measures[0].derive.bucketBy"},
		{"count bucketBy unknown", DeriveRule{RecordType: "defect", Op: OpCount, BucketBy: "nope"}, "measures[0].derive.bucketBy"},
		{"count bucketBy bool attribute", DeriveRule{RecordType: "defect", Op: OpCount, BucketBy: "customer_ticket"}, "measures[0].derive.bucketBy"},

		{"sum ok field", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt", Field: "planned"}, ""},
		{"sum ok attribute", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt", Field: "cost"}, ""},
		{"sum needs field", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt"}, "measures[0].derive.field"},
		{"sum field not number", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt", Field: "title"}, "measures[0].derive.field"},
		{"sum field bool attribute", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt", Field: "customer_ticket"}, "measures[0].derive.field"},
		{"sum field unknown", DeriveRule{RecordType: "defect", Op: OpSum, BucketBy: "completedAt", Field: "nope"}, "measures[0].derive.field"},
		{"sum needs bucketBy", DeriveRule{RecordType: "defect", Op: OpSum, Field: "planned"}, "measures[0].derive.bucketBy"},

		{"daily ok", DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted, Weights: full}, ""},
		{"daily missing priority", DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted,
			Weights: map[string]float64{"P1": 64, "none": 1}}, "measures[0].derive.weights"},
		{"daily missing none", DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted,
			Weights: map[string]float64{"P1": 64, "P2": 16}}, "measures[0].derive.weights"},
		{"daily no weights", DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted}, "measures[0].derive.weights"},
		{"daily unknown priority", DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted,
			Weights: map[string]float64{"P1": 64, "P2": 16, "none": 1, "P9": 3}}, "measures[0].derive.weights.P9"},

		{"commitments resolved", DeriveRule{RecordType: "defect", Op: OpCommitments, Outcome: OutcomeResolved}, ""},
		{"commitments met", DeriveRule{RecordType: "defect", Op: OpCommitments, Outcome: OutcomeMet}, ""},
		{"commitments needs outcome", DeriveRule{RecordType: "defect", Op: OpCommitments}, "measures[0].derive.outcome"},
		{"commitments bad outcome", DeriveRule{RecordType: "defect", Op: OpCommitments, Outcome: "missed"}, "measures[0].derive.outcome"},

		{"days_in_period ok", DeriveRule{RecordType: "defect", Op: OpDaysInPeriod}, ""},

		{"age_sum ok", DeriveRule{RecordType: "defect", Op: OpAgeSum, BucketBy: "completedAt", AgeFrom: "createdAt", AgeTo: "completedAt"}, ""},
		{"age_sum open ended", DeriveRule{RecordType: "defect", Op: OpAgeSum, BucketBy: "createdAt", AgeFrom: "createdAt"}, ""},
		{"age_sum needs ageFrom", DeriveRule{RecordType: "defect", Op: OpAgeSum, BucketBy: "completedAt"}, "measures[0].derive.ageFrom"},
		{"age_sum needs bucketBy", DeriveRule{RecordType: "defect", Op: OpAgeSum, AgeFrom: "createdAt"}, "measures[0].derive.bucketBy"},
		{"age_sum bad ageTo", DeriveRule{RecordType: "defect", Op: OpAgeSum, BucketBy: "completedAt", AgeFrom: "createdAt", AgeTo: "planned"}, "measures[0].derive.ageTo"},
		{"age_sum bad ageFrom", DeriveRule{RecordType: "defect", Op: OpAgeSum, BucketBy: "completedAt", AgeFrom: "nope"}, "measures[0].derive.ageFrom"},

		{"invalid op", DeriveRule{RecordType: "defect", Op: "median"}, "measures[0].derive.op"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rule := tc.rule
			errs := ValidateDerive(derivedMethodology(&rule), types)
			if tc.path == "" {
				if errs != nil {
					t.Fatalf("want valid, got %v", errs)
				}
				return
			}
			if !hasPath(errs, tc.path) {
				t.Fatalf("want error at %q, got %v", tc.path, errs)
			}
		})
	}
}

func TestDeriveUnknownRecordType(t *testing.T) {
	m := derivedMethodology(&DeriveRule{RecordType: "epic", Op: OpDaysInPeriod})
	errs := ValidateDerive(m, []RecordType{validRecordType()})
	if !hasPath(errs, "measures[0].derive.recordType") {
		t.Fatalf("want error at measures[0].derive.recordType, got %v", errs)
	}
	if errs := ValidateDerive(m, nil); !hasPath(errs, "measures[0].derive.recordType") {
		t.Fatalf("no types: got %v", errs)
	}
}

func TestValidateDeriveSkipsEnteredMeasures(t *testing.T) {
	if errs := ValidateDerive(validMethodology(), nil); errs != nil {
		t.Fatalf("entered methodology produced errors: %v", errs)
	}
}

func TestDeriveErrorsAreDeterministic(t *testing.T) {
	m := derivedMethodology(&DeriveRule{RecordType: "defect", Op: OpDailyOpenWeighted,
		Weights: map[string]float64{"P1": 1, "none": 1, "X1": 1, "X2": 1, "X3": 1}})
	types := []RecordType{validRecordType()}
	first := ValidateDerive(m, types)
	for i := 0; i < 20; i++ {
		got := ValidateDerive(m, types)
		if len(got) != len(first) {
			t.Fatalf("length changed: %v vs %v", got, first)
		}
		for j := range got {
			if got[j] != first[j] {
				t.Fatalf("order changed: %v vs %v", got, first)
			}
		}
	}
}

func TestSourceRecordsValid(t *testing.T) {
	if SourceRecords != "records" {
		t.Fatalf("SourceRecords = %q", SourceRecords)
	}
	if !ValidSource(SourceRecords) {
		t.Fatal("records is not a valid source")
	}
	if ValidSource("bogus") {
		t.Fatal("bogus is a valid source")
	}
}

func TestDataPointDeletedJSON(t *testing.T) {
	b, _ := json.Marshal(DataPoint{MeasureKey: "a"})
	if strings.Contains(string(b), "deleted") {
		t.Fatalf("live point leaks deleted: %s", b)
	}
	b, _ = json.Marshal(DataPoint{MeasureKey: "a", Deleted: true})
	if !strings.Contains(string(b), `"deleted":true`) {
		t.Fatalf("tombstone missing deleted: %s", b)
	}
}
