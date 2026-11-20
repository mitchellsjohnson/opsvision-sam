package rca_test

import (
	"testing"

	"opsvision/internal/rca"
)

func TestRatioParts(t *testing.T) {
	cases := []struct {
		formula, num, den string
		ok                bool
	}{
		{"epics_on_time / epics_committed * 100", "epics_on_time", "epics_committed", true},
		{"a/b", "a", "b", true},
		{"  actual_spend / planned_spend*100.0 ", "actual_spend", "planned_spend", true},
		{"people_trained / people", "people_trained", "people", true},
		{"(1 - seconds_down / seconds_in_period) * 100", "", "", false},
		{"a / b / c", "", "", false},
		{"a + b", "", "", false},
		{"a / b * c", "", "", false},
		{"100 * a / b", "", "", false},
		{"a", "", "", false},
		{"", "", "", false},
	}
	for _, tc := range cases {
		num, den, ok := rca.RatioParts(tc.formula)
		if num != tc.num || den != tc.den || ok != tc.ok {
			t.Errorf("RatioParts(%q) = %q, %q, %v; want %q, %q, %v", tc.formula, num, den, ok, tc.num, tc.den, tc.ok)
		}
	}
}
