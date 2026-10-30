// Package period models reporting periods (month, quarter, half, fiscal year)
// and the fiscal calendar that maps them onto wall-clock time.
//
// Fiscal years are labeled by the calendar year in which they END. All times
// are UTC and period ends are exclusive.
package period

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Grain is the granularity of a Period.
type Grain int

// Supported grains, from finest to coarsest.
const (
	Month Grain = iota
	Quarter
	Half
	Year
)

// monthsPer is the number of months spanned by each grain.
var monthsPer = map[Grain]int{Month: 1, Quarter: 3, Half: 6, Year: 12}

// Period identifies a month, quarter, half, or fiscal year.
// Index is 1-based within the fiscal year; it is 0 for Year.
type Period struct {
	Grain Grain
	FY    int
	Index int
}

// String formats a Period as 2026-M10, 2026-Q3, 2026-H2, or 2026-FY.
func (p Period) String() string {
	switch p.Grain {
	case Month:
		return fmt.Sprintf("%d-M%02d", p.FY, p.Index)
	case Quarter:
		return fmt.Sprintf("%d-Q%d", p.FY, p.Index)
	case Half:
		return fmt.Sprintf("%d-H%d", p.FY, p.Index)
	case Year:
		return fmt.Sprintf("%d-FY", p.FY)
	}
	return fmt.Sprintf("%d-?%d", p.FY, p.Index)
}

// MarshalText encodes a Period as its String form. The zero Period encodes as
// the empty string so that unset Period fields round-trip through JSON.
func (p Period) MarshalText() ([]byte, error) {
	if p == (Period{}) {
		return []byte{}, nil
	}
	return []byte(p.String()), nil
}

// UnmarshalText decodes the String form of a Period. The empty string decodes
// to the zero Period.
func (p *Period) UnmarshalText(b []byte) error {
	if len(b) == 0 {
		*p = Period{}
		return nil
	}
	v, err := Parse(string(b))
	if err != nil {
		return err
	}
	*p = v
	return nil
}

// Parse parses the String form of a Period.
func Parse(s string) (Period, error) {
	i := strings.IndexByte(s, '-')
	if i <= 0 || i == len(s)-1 {
		return Period{}, fmt.Errorf("period %q: want <fy>-<M|Q|H><n> or <fy>-FY", s)
	}
	fy, err := parseDigits(s[:i])
	if err != nil {
		return Period{}, fmt.Errorf("period %q: invalid fiscal year: %w", s, err)
	}
	rest := s[i+1:]
	if rest == "FY" {
		return Period{Grain: Year, FY: fy}, nil
	}
	var g Grain
	var max int
	switch rest[0] {
	case 'M':
		g, max = Month, 12
	case 'Q':
		g, max = Quarter, 4
	case 'H':
		g, max = Half, 2
	default:
		return Period{}, fmt.Errorf("period %q: unknown grain %q", s, rest[:1])
	}
	idx, err := parseDigits(rest[1:])
	if err != nil {
		return Period{}, fmt.Errorf("period %q: invalid index: %w", s, err)
	}
	if idx < 1 || idx > max {
		return Period{}, fmt.Errorf("period %q: index %d out of range 1..%d", s, idx, max)
	}
	return Period{Grain: g, FY: fy, Index: idx}, nil
}

// parseDigits parses a non-empty string of ASCII digits.
func parseDigits(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty number")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("non-digit %q", r)
		}
	}
	return strconv.Atoi(s)
}

// Calendar maps periods to wall-clock time. The zero value is a calendar year
// starting in January.
type Calendar struct {
	// FiscalYearStartMonth is the first month of the fiscal year.
	// The zero value is treated as January.
	FiscalYearStartMonth time.Month
}

func (c Calendar) startMonth() time.Month {
	if c.FiscalYearStartMonth < time.January || c.FiscalYearStartMonth > time.December {
		return time.January
	}
	return c.FiscalYearStartMonth
}

// fyStart returns the first instant of fiscal year fy.
func (c Calendar) fyStart(fy int) time.Time {
	s := c.startMonth()
	if s == time.January {
		return time.Date(fy, time.January, 1, 0, 0, 0, 0, time.UTC)
	}
	return time.Date(fy-1, s, 1, 0, 0, 0, 0, time.UTC)
}

// MonthOf returns the fiscal month containing t (interpreted in UTC).
func (c Calendar) MonthOf(t time.Time) Period {
	t = t.UTC()
	s := c.startMonth()
	m := t.Month()
	fy := t.Year()
	if s != time.January && m >= s {
		fy++
	}
	idx := (int(m)-int(s)+12)%12 + 1
	return Period{Grain: Month, FY: fy, Index: idx}
}

// firstMonthIndex returns the 1-based index of the first month of p within its fiscal year.
func firstMonthIndex(p Period) int {
	if p.Grain == Year {
		return 1
	}
	return (p.Index-1)*monthsPer[p.Grain] + 1
}

// Months returns the constituent months of p in order. For a Month it returns
// []Period{p}. It returns nil for an invalid period.
func (c Calendar) Months(p Period) []Period {
	n, ok := monthsPer[p.Grain]
	if !ok {
		return nil
	}
	if p.Grain != Year && (p.Index < 1 || p.Index > 12/n) {
		return nil
	}
	first := firstMonthIndex(p)
	out := make([]Period, n)
	for i := range out {
		out[i] = Period{Grain: Month, FY: p.FY, Index: first + i}
	}
	return out
}

// Contains reports whether month is one of the months of outer.
func (c Calendar) Contains(outer, month Period) bool {
	if month.Grain != Month {
		return false
	}
	for _, m := range c.Months(outer) {
		if m == month {
			return true
		}
	}
	return false
}

// YTD returns the months from the start of month's fiscal year through month, inclusive.
func (c Calendar) YTD(month Period) []Period {
	if month.Grain != Month || month.Index < 1 || month.Index > 12 {
		return nil
	}
	out := make([]Period, month.Index)
	for i := range out {
		out[i] = Period{Grain: Month, FY: month.FY, Index: i + 1}
	}
	return out
}

// Prev returns the immediately preceding period of the same grain.
func (c Calendar) Prev(p Period) Period {
	if p.Grain == Year {
		return Period{Grain: Year, FY: p.FY - 1}
	}
	if p.Index > 1 {
		return Period{Grain: p.Grain, FY: p.FY, Index: p.Index - 1}
	}
	return Period{Grain: p.Grain, FY: p.FY - 1, Index: 12 / monthsPer[p.Grain]}
}

// SameLastYear returns the same period one fiscal year earlier.
func (c Calendar) SameLastYear(p Period) Period {
	p.FY--
	return p
}

// Start returns the first instant of p (UTC).
func (c Calendar) Start(p Period) time.Time {
	return c.fyStart(p.FY).AddDate(0, firstMonthIndex(p)-1, 0)
}

// End returns the exclusive end of p (UTC).
func (c Calendar) End(p Period) time.Time {
	return c.fyStart(p.FY).AddDate(0, firstMonthIndex(p)-1+monthsPer[p.Grain], 0)
}

// Seconds returns the length of p in seconds.
func (c Calendar) Seconds(p Period) int64 {
	return int64(c.End(p).Sub(c.Start(p)) / time.Second)
}

// Parent returns the period of grain g that contains month. Parent(month, Month)
// returns month itself.
func (c Calendar) Parent(month Period, g Grain) Period {
	if g == Year {
		return Period{Grain: Year, FY: month.FY}
	}
	n := monthsPer[g]
	return Period{Grain: g, FY: month.FY, Index: (firstMonthIndex(month)-1)/n + 1}
}
