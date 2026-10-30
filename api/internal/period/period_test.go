package period

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func mustParse(t *testing.T, s string) Period {
	t.Helper()
	p, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return p
}

func date(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestCalendarJanuaryStart(t *testing.T) {
	c := Calendar{}
	if got := c.MonthOf(date(2026, time.October, 15)).String(); got != "2026-M10" {
		t.Errorf("MonthOf = %s, want 2026-M10", got)
	}
	if got := c.Parent(mustParse(t, "2026-M10"), Quarter).String(); got != "2026-Q4" {
		t.Errorf("Parent quarter = %s, want 2026-Q4", got)
	}
	if got := c.Parent(mustParse(t, "2026-M10"), Half).String(); got != "2026-H2" {
		t.Errorf("Parent half = %s, want 2026-H2", got)
	}
	if got := c.Parent(mustParse(t, "2026-M10"), Year).String(); got != "2026-FY" {
		t.Errorf("Parent year = %s, want 2026-FY", got)
	}
	if got := c.Parent(mustParse(t, "2026-M10"), Month).String(); got != "2026-M10" {
		t.Errorf("Parent month = %s, want 2026-M10", got)
	}
	if got := c.Seconds(mustParse(t, "2026-M06")); got != 2592000 {
		t.Errorf("Seconds = %d, want 2592000", got)
	}
	if got := c.Seconds(mustParse(t, "2026-FY")); got != 365*86400 {
		t.Errorf("Seconds FY = %d, want %d", got, 365*86400)
	}
}

func TestCalendarJulyStart(t *testing.T) {
	c := Calendar{FiscalYearStartMonth: time.July}
	if got := c.MonthOf(date(2026, time.July, 1)).String(); got != "2027-M01" {
		t.Errorf("MonthOf = %s, want 2027-M01", got)
	}
	if got := c.MonthOf(date(2026, time.June, 30)).String(); got != "2026-M12" {
		t.Errorf("MonthOf = %s, want 2026-M12", got)
	}
	if got, want := c.Start(mustParse(t, "2027-FY")), date(2026, time.July, 1); !got.Equal(want) {
		t.Errorf("Start = %v, want %v", got, want)
	}
	if got, want := c.End(mustParse(t, "2027-FY")), date(2027, time.July, 1); !got.Equal(want) {
		t.Errorf("End = %v, want %v", got, want)
	}
	ytd := c.YTD(mustParse(t, "2027-M03"))
	if len(ytd) != 3 {
		t.Fatalf("YTD len = %d, want 3", len(ytd))
	}
	for i, p := range ytd {
		wantStart := date(2026, time.July+time.Month(i), 1)
		if got := c.Start(p); !got.Equal(wantStart) {
			t.Errorf("YTD[%d] start = %v, want %v", i, got, wantStart)
		}
	}
}

func TestMonthsContainsYTD(t *testing.T) {
	c := Calendar{}
	want := []Period{
		mustParse(t, "2026-M04"), mustParse(t, "2026-M05"), mustParse(t, "2026-M06"),
	}
	if diff := cmp.Diff(want, c.Months(mustParse(t, "2026-Q2"))); diff != "" {
		t.Errorf("Months(Q2) mismatch (-want +got):\n%s", diff)
	}
	m := mustParse(t, "2026-M10")
	if diff := cmp.Diff([]Period{m}, c.Months(m)); diff != "" {
		t.Errorf("Months(month) mismatch (-want +got):\n%s", diff)
	}
	if got := len(c.Months(mustParse(t, "2026-H2"))); got != 6 {
		t.Errorf("Months(H2) len = %d, want 6", got)
	}
	if got := len(c.Months(mustParse(t, "2026-FY"))); got != 12 {
		t.Errorf("Months(FY) len = %d, want 12", got)
	}
	if !c.Contains(mustParse(t, "2026-Q4"), m) {
		t.Error("Q4 should contain M10")
	}
	if c.Contains(mustParse(t, "2026-Q3"), m) {
		t.Error("Q3 should not contain M10")
	}
	if c.Contains(mustParse(t, "2025-FY"), m) {
		t.Error("2025-FY should not contain 2026-M10")
	}
	if !c.Contains(m, m) {
		t.Error("month should contain itself")
	}
	if got := c.YTD(m); len(got) != 10 || got[0].String() != "2026-M01" || got[9] != m {
		t.Errorf("YTD(M10) = %v", got)
	}
}

func TestPrevAcrossYear(t *testing.T) {
	c := Calendar{}
	tests := []struct{ in, prev string }{
		{"2026-M01", "2025-M12"},
		{"2026-M05", "2026-M04"},
		{"2026-Q1", "2025-Q4"},
		{"2026-Q3", "2026-Q2"},
		{"2026-H1", "2025-H2"},
		{"2026-H2", "2026-H1"},
		{"2026-FY", "2025-FY"},
	}
	for _, tc := range tests {
		if got := c.Prev(mustParse(t, tc.in)).String(); got != tc.prev {
			t.Errorf("Prev(%s) = %s, want %s", tc.in, got, tc.prev)
		}
	}
	if got := c.SameLastYear(mustParse(t, "2026-H2")).String(); got != "2025-H2" {
		t.Errorf("SameLastYear(H2) = %s, want 2025-H2", got)
	}
	if got := c.SameLastYear(mustParse(t, "2026-FY")).String(); got != "2025-FY" {
		t.Errorf("SameLastYear(FY) = %s, want 2025-FY", got)
	}
}

func TestStartEnd(t *testing.T) {
	c := Calendar{}
	if got, want := c.End(mustParse(t, "2026-M12")), date(2027, time.January, 1); !got.Equal(want) {
		t.Errorf("End(M12) = %v, want %v", got, want)
	}
	if got, want := c.Start(mustParse(t, "2026-Q3")), date(2026, time.July, 1); !got.Equal(want) {
		t.Errorf("Start(Q3) = %v, want %v", got, want)
	}
	if got, want := c.End(mustParse(t, "2026-Q3")), date(2026, time.October, 1); !got.Equal(want) {
		t.Errorf("End(Q3) = %v, want %v", got, want)
	}
	if got := c.Start(mustParse(t, "2026-M02")).Location(); got != time.UTC {
		t.Errorf("Start location = %v, want UTC", got)
	}
	if got := c.Seconds(mustParse(t, "2024-M02")); got != 29*86400 {
		t.Errorf("Seconds(leap Feb) = %d", got)
	}
}

func TestMonthOfNonUTC(t *testing.T) {
	c := Calendar{}
	loc := time.FixedZone("x", -5*3600)
	// 2026-10-31 22:00 at UTC-5 is 2026-11-01 03:00 UTC.
	got := c.MonthOf(time.Date(2026, time.October, 31, 22, 0, 0, 0, loc))
	if got.String() != "2026-M11" {
		t.Errorf("MonthOf = %s, want 2026-M11", got)
	}
}

func TestParseRoundTrip(t *testing.T) {
	for _, s := range []string{"2026-M10", "2026-Q3", "2026-H2", "2026-FY"} {
		p, err := Parse(s)
		if err != nil {
			t.Fatalf("Parse(%q): %v", s, err)
		}
		if got := p.String(); got != s {
			t.Errorf("round trip %q -> %q", s, got)
		}
	}
	if p := mustParse(t, "2026-FY"); p.Grain != Year || p.Index != 0 || p.FY != 2026 {
		t.Errorf("Parse FY = %+v", p)
	}
}

func TestParseErrors(t *testing.T) {
	for _, s := range []string{
		"2026-M13", "2026-M0", "2026-Q5", "2026-Q0", "2026-H3", "2026-H0",
		"", "2026", "2026-", "2026-X1", "abc-M1", "2026-M", "2026-FY1", "2026-M-1", "2026-M1x",
	} {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) expected error", s)
		}
	}
}

func TestPeriodJSON(t *testing.T) {
	type wrap struct {
		P  Period  `json:"p"`
		Pp *Period `json:"pp,omitempty"`
	}
	in := wrap{P: mustParse(t, "2026-Q3"), Pp: &Period{Grain: Month, FY: 2026, Index: 10}}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"p":"2026-Q3","pp":"2026-M10"}`; string(b) != want {
		t.Fatalf("Marshal = %s, want %s", b, want)
	}
	var out wrap
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.P != in.P || out.Pp == nil || *out.Pp != *in.Pp {
		t.Errorf("round trip = %+v, want %+v", out, in)
	}
	// The zero Period round-trips as the empty string.
	b, err = json.Marshal(wrap{})
	if err != nil || string(b) != `{"p":""}` {
		t.Fatalf("zero Marshal = %s, %v", b, err)
	}
	if err := json.Unmarshal(b, &out); err != nil || out.P != (Period{}) {
		t.Errorf("zero Unmarshal = %+v, %v", out.P, err)
	}
	if err := json.Unmarshal([]byte(`{"p":"2026-M13"}`), &out); err == nil {
		t.Error("expected error for invalid period")
	}
}
