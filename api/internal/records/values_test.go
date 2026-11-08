package records

import (
	"math"
	"strings"
	"testing"
)

func TestDateFormats(t *testing.T) {
	both := []string{"2006-01-02 15:04", "02/Jan/06 3:04 PM"}
	tests := []struct {
		name    string
		in      string
		formats []string
		serial  bool
		want    string // "" means an error is expected
	}{
		{"first format", "2026-09-03 14:22", both, false, "2026-09-03"},
		{"second format in same column", "05/Sep/26 2:15 PM", both, false, "2026-09-05"},
		{"plain ISO", "2026-09-03", nil, false, "2026-09-03"},
		{"ISO date-time truncates, no formats", "2026-09-03 14:22", nil, false, "2026-09-03"},
		{"ISO T date-time with seconds", "2026-09-03T14:22:09", nil, false, "2026-09-03"},
		{"zoned date-time keeps the written date", "2026-09-03T23:30:00-05:00", nil, false, "2026-09-03"},
		{"month only ISO", "2026-03", nil, false, "2026-03-01"},
		{"month only short name", "Mar 2026", nil, false, "2026-03-01"},
		{"month only long name", "March 2026", nil, false, "2026-03-01"},
		{"serial when allowed", "46023", nil, true, "2026-01-01"},
		{"serial with time of day", "46023.75", nil, true, "2026-01-01"},
		{"serial refused for csv", "46023", nil, false, ""},
		{"small number is not a serial", "2026", nil, true, ""},
		{"surrounding space", "  2026-09-03  ", nil, false, "2026-09-03"},
		{"custom layout, day first", "03/09/2026", []string{"02/01/2006"}, false, "2026-09-03"},
		{"not a date", "soon", both, true, ""},
		{"impossible date", "2026-02-30", nil, false, ""},
		{"empty", "  ", nil, true, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseDate(tc.in, tc.formats, tc.serial)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("ParseDate(%q) = %s, want an error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDate(%q): %v", tc.in, err)
			}
			if got.String() != tc.want {
				t.Fatalf("ParseDate(%q) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestDateFormatsOrder(t *testing.T) {
	// 03/04/2026 is ambiguous; the first listed layout wins.
	dayFirst, err := ParseDate("03/04/2026", []string{"02/01/2006", "01/02/2006"}, false)
	if err != nil || dayFirst.String() != "2026-04-03" {
		t.Fatalf("day-first = %s, %v; want 2026-04-03", dayFirst, err)
	}
	monthFirst, err := ParseDate("03/04/2026", []string{"01/02/2006", "02/01/2006"}, false)
	if err != nil || monthFirst.String() != "2026-03-04" {
		t.Fatalf("month-first = %s, %v; want 2026-03-04", monthFirst, err)
	}
}

func TestNumberForms(t *testing.T) {
	good := []struct {
		in   string
		want float64
	}{
		{"84%", 84},
		{"1,234", 1234},
		{"1,234,567.5", 1234567.5},
		{" 12 ", 12},
		{"$10k", 10000},
		{"-5", -5},
		{"+5", 5},
		{"$-5", -5},
		{"-$5", -5},
		{"1.1k", 1100},
		{"3m", 3000000},
		{"3M", 3000000},
		{".5", 0.5},
		{"5.", 5},
		{"0", 0},
		{"-0", 0},
		{"\u22125", -5},
		{"1234", 1234},
	}
	for _, tc := range good {
		got, err := ParseNumber(tc.in)
		if err != nil {
			t.Errorf("ParseNumber(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want || (tc.want == 0 && math.Signbit(got)) {
			t.Errorf("ParseNumber(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}

	bad := []string{"", "  ", "abc", "1.2.3", "$5%", "1,23", "12,34,567", "--5", "-5-", "$", "%", "5 %", "1e3", "n/a", "12abc", "$ 10k"}
	for _, in := range bad {
		if got, err := ParseNumber(in); err == nil {
			t.Errorf("ParseNumber(%q) = %v, want an error", in, got)
		}
	}
}

func TestNumberMessages(t *testing.T) {
	_, err := ParseNumber("1,23")
	if err == nil || !strings.Contains(err.Error(), "comma") {
		t.Errorf("1,23: want a comma message, got %v", err)
	}
	_, err = ParseNumber("$5%")
	if err == nil || !strings.Contains(err.Error(), "percent") {
		t.Errorf("$5%%: want a percent message, got %v", err)
	}
}
