package records

import (
	"testing"
	"time"

	"opsvision/internal/domain"
)

// day parses a YYYY-MM-DD test date.
func day(s string) domain.Date {
	d, err := domain.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

// dp returns a pointer to the test date s.
func dp(s string) *domain.Date {
	d := day(s)
	return &d
}

func num(v float64) *float64 { return &v }

func rev(asOf string, f domain.RecordFields) domain.RecordRevision {
	return domain.RecordRevision{AsOf: day(asOf), SnapshotID: "snap-" + asOf, Fields: f}
}

func defect(revs ...domain.RecordRevision) domain.Record {
	return domain.Record{Source: "tracker", ExternalID: "CHK-101", Type: "defect", Revisions: revs}
}

func TestLatest(t *testing.T) {
	r := defect(
		rev("2026-10-31", domain.RecordFields{SubjectKey: "checkout", Priority: "P3"}),
		rev("2026-11-30", domain.RecordFields{SubjectKey: "checkout", Priority: "P1"}),
	)
	if got := Latest(r).Priority; got != "P1" {
		t.Fatalf("Latest priority = %q, want P1", got)
	}
	if got := Latest(domain.Record{}); got.SubjectKey != "" || got.State != "" {
		t.Fatalf("Latest of a record without revisions = %+v, want zero fields", got)
	}
}

func TestFieldsOnBeforeFirstSnapshot(t *testing.T) {
	r := defect(
		rev("2026-10-31", domain.RecordFields{Priority: "P3"}),
		rev("2026-11-30", domain.RecordFields{Priority: "P1"}),
	)
	if got := FieldsOn(r, day("2026-10-01")).Priority; got != "P3" {
		t.Fatalf("FieldsOn before first snapshot = %q, want the earliest revision (P3)", got)
	}
	if got := FieldsOn(domain.Record{}, day("2026-10-01")); got.Priority != "" {
		t.Fatalf("FieldsOn of a record without revisions = %+v, want zero fields", got)
	}
}

func TestFieldsOnPriorityByDay(t *testing.T) {
	r := defect(
		rev("2026-10-31", domain.RecordFields{Priority: "P3"}),
		rev("2026-11-30", domain.RecordFields{Priority: "P1"}),
	)
	cases := []struct {
		day  domain.Date
		want string
	}{
		{day("2026-10-31"), "P3"},
		{day("2026-11-15"), "P3"},
		{day("2026-11-29"), "P3"},
		{day("2026-11-30"), "P1"},
		{day("2026-12-15"), "P1"},
		// A day that is not at UTC midnight still means its calendar date.
		{domain.Date{Time: time.Date(2026, 11, 30, 18, 30, 0, 0, time.UTC)}, "P1"},
		{domain.Date{Time: time.Date(2026, 11, 29, 23, 59, 0, 0, time.UTC)}, "P3"},
	}
	for _, c := range cases {
		if got := FieldsOn(r, c.day).Priority; got != c.want {
			t.Errorf("FieldsOn(%s) priority = %q, want %q", c.day.Time, got, c.want)
		}
	}
}
