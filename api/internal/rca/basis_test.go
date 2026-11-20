package rca_test

import (
	"reflect"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/rca"
)

func ip(n int) *int { return &n }

func TestStaleReasons(t *testing.T) {
	stored := domain.RCABasis{Display: "99.12%", Status: "Y", Evidence: []string{"incident-tracker:INC-2033", "incident-tracker:INC-2041"}, ReportedMinutes: ip(400)}
	current := domain.RCABasis{Display: "99.06%", Status: "R", Evidence: []string{"incident-tracker:INC-2041", "incident-tracker:INC-2049"}, ReportedMinutes: ip(420)}
	got := rca.StaleReasons(stored, current, label)
	want := []string{
		"The value changed from 99.12% to 99.06%.",
		"The status changed from Yellow to Red.",
		"1 new incident since it was written: INC-2049.",
		"INC-2033 no longer counts.",
		"The reported downtime changed from 6h 40m to 7h 00m.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reasons =\n%q\nwant\n%q", got, want)
	}

	if r := rca.StaleReasons(stored, stored, label); len(r) != 0 {
		t.Fatalf("equal bases: %q", r)
	}
	// Evidence order does not matter.
	shuffled := stored
	shuffled.Evidence = []string{"incident-tracker:INC-2041", "incident-tracker:INC-2033"}
	if r := rca.StaleReasons(stored, shuffled, label); len(r) != 0 {
		t.Fatalf("reordered evidence: %q", r)
	}

	plural := stored
	plural.Evidence = []string{"incident-tracker:INC-2041", "incident-tracker:INC-2049", "oncall:88412"}
	got = rca.StaleReasons(domain.RCABasis{Display: "99.12%", Status: "Y", Evidence: []string{"a:X-1", "a:X-2"}}, plural, label)
	want = []string{
		"3 new incidents since it was written: INC-2041, INC-2049, 88412.",
		"X-1 and X-2 no longer count.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plural reasons = %q, want %q", got, want)
	}

	// Reported minutes appearing or disappearing is not a reason by itself.
	noMinutes := stored
	noMinutes.ReportedMinutes = nil
	if r := rca.StaleReasons(stored, noMinutes, label); len(r) != 0 {
		t.Fatalf("minutes gone: %q", r)
	}
	// Without labels the status keys are used.
	if r := rca.StaleReasons(domain.RCABasis{Status: "Y"}, domain.RCABasis{Status: "R"}, nil); !reflect.DeepEqual(r, []string{"The status changed from Y to R."}) {
		t.Fatalf("no labels: %q", r)
	}
}
