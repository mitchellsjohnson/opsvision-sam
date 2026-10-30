package httpapi

import (
	"strings"
	"testing"

	"opsvision/internal/domain"
)

func TestValidID(t *testing.T) {
	long := strings.Repeat("a", 64)
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"team-alpha", true},
		{"A_b-9", true},
		{long, true},
		{long + "a", false},
		{"", false},
		{"has space", false},
		{"bad!id", false},
		{"a#b", false},
		{"a/b", false},
		{"é", false},
	} {
		if got := validID(tc.in); got != tc.ok {
			t.Errorf("validID(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}

func TestValidKey(t *testing.T) {
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"open_defects", true},
		{"a", true},
		{"a1_b2", true},
		{"", false},
		{"Open", false},
		{"1abc", false},
		{"_abc", false},
		{"a-b", false},
		{"a b", false},
	} {
		if got := validKey(tc.in); got != tc.ok {
			t.Errorf("validKey(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}

func TestValidUserID(t *testing.T) {
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"auth0|abc123", true},
		{"pending:admin@example.test", true},
		{"", false},
		{"a#b", false},
		{"#", false},
	} {
		if got := validUserID(tc.in); got != tc.ok {
			t.Errorf("validUserID(%q) = %v, want %v", tc.in, got, tc.ok)
		}
	}
}

func TestProblemsMonth(t *testing.T) {
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{"2026-M07", true},
		{"2026-M7", true}, // period.Parse accepts it; normalized on output
		{"2026-Q3", false},
		{"2026-FY", false},
		{"2026-M13", false},
		{"nope", false},
		{"", false},
	} {
		var p problems
		_, ok := p.month("m", tc.in)
		if ok != tc.ok || (ok && p.err() != nil) || (!ok && p.err() == nil) {
			t.Errorf("month(%q): ok=%v err=%v, want ok=%v", tc.in, ok, p.err(), tc.ok)
		}
	}
}

func TestProblemsCollectsDetails(t *testing.T) {
	var p problems
	p.id("levels[0].id", "bad id")
	p.key("scope.metricKeys[1]", "Bad")
	p.role("role", domain.Role("root"))
	p.nonEmpty("name", "   ")
	err := p.err()
	ae, ok := err.(*apiError)
	if !ok || ae.status != 400 || ae.code != codeInvalid {
		t.Fatalf("err = %#v, want 400 invalid apiError", err)
	}
	if len(ae.details) != 4 {
		t.Fatalf("details = %+v, want 4", ae.details)
	}
	if ae.details[0].Path != "levels[0].id" {
		t.Errorf("first detail path = %q", ae.details[0].Path)
	}
	var none problems
	if none.err() != nil {
		t.Error("empty problems must yield a nil error")
	}
}
