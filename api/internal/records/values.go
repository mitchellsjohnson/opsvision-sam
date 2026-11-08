package records

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/xlsx"
)

// minSerialDate is the smallest spreadsheet serial read as a date when serial
// dates are allowed: 1950-01-01. Smaller whole numbers (a year such as 2026, a
// count) are far more likely to be mistakes than 1900s dates, and the parser
// never guesses.
const minSerialDate = 18264

// maxSerialDate is the serial of 9999-12-31.
const maxSerialDate = 2958465

// isoDateTimeLayouts are the date-time forms always accepted; they truncate to
// the written date (the clock time and any zone are ignored).
var isoDateTimeLayouts = []string{
	"2006-01-02T15:04:05Z07:00",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
}

// monthOnlyLayouts are month-only forms; they read as the first of the month.
var monthOnlyLayouts = []string{"2006-01", "Jan 2006", "January 2006"}

var serialPattern = regexp.MustCompile(`^\d+(\.\d+)?$`)

// ParseDate reads a calendar date from an export cell. It tries formats (Go
// layouts) in order, then ISO 2006-01-02, then ISO date-times, then
// month-only forms (2006-01, Jan 2006, January 2006, read as the first of the
// month), then, when allowSerial is set, a spreadsheet serial number. Date-times
// truncate to the date as written; time zones are ignored. It is more lenient
// than domain.ParseDate, which accepts only YYYY-MM-DD.
func ParseDate(s string, formats []string, allowSerial bool) (domain.Date, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return domain.Date{}, fmt.Errorf("date is empty")
	}
	for _, layout := range formats {
		if t, err := time.Parse(layout, s); err == nil {
			return calendarDate(t), nil
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return calendarDate(t), nil
	}
	for _, layout := range isoDateTimeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return calendarDate(t), nil
		}
	}
	for _, layout := range monthOnlyLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return calendarDate(t), nil
		}
	}
	if allowSerial && serialPattern.MatchString(s) {
		if f, err := strconv.ParseFloat(s, 64); err == nil && f >= minSerialDate && f <= maxSerialDate {
			if t := xlsx.SerialToDate(f); !t.IsZero() {
				return calendarDate(t), nil
			}
		}
	}
	return domain.Date{}, fmt.Errorf("%q is not a date I can read", s)
}

// calendarDate is the date t was written as (its own zone, not converted),
// at UTC midnight.
func calendarDate(t time.Time) domain.Date {
	y, m, d := t.Date()
	return domain.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC)}
}

// numberEntry mirrors ENTRY and NUMBER in web/src/features/entry/pasteParser.ts:
// an optional sign (before or after one optional $), digits with optional
// thousands groups of exactly three or a bare fraction, and an optional k, m
// or % suffix.
var numberEntry = regexp.MustCompile(`(?i)^([+-])?\$?([+-])?(\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d+(?:\.\d*)?|\.\d+)([km%])?$`)

// ParseNumber reads a number the way the entry grid does: 84% is 84, 1,234 is
// 1234, $10k is 10000, 3m is 3000000, -5 is -5. Surrounding spaces are
// ignored. Anything else, including blank text, 1.2.3, abc, and $5%, is an
// error; it never reads text as zero.
func ParseNumber(s string) (float64, error) {
	text := strings.TrimSpace(strings.ReplaceAll(s, "\u2212", "-"))
	if text == "" {
		return 0, fmt.Errorf("number is empty")
	}
	m := numberEntry.FindStringSubmatch(text)
	if m == nil {
		stripped := strings.ReplaceAll(text, ",", "")
		if strings.Contains(text, ",") && numberEntry.MatchString(stripped) {
			return 0, fmt.Errorf("%q has misplaced commas; use them only between groups of three digits", text)
		}
		return 0, fmt.Errorf("%q is not a number", text)
	}
	lead, trail, digits, suffix := m[1], m[2], m[3], strings.ToLower(m[4])
	if lead != "" && trail != "" {
		return 0, fmt.Errorf("%q has two signs", text)
	}
	if suffix == "%" && strings.Contains(text, "$") {
		return 0, fmt.Errorf("%q mixes a currency sign and a percent sign", text)
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(digits, ",", ""), 64)
	if err != nil || math.IsInf(v, 0) {
		return 0, fmt.Errorf("%q is too large", text)
	}
	switch suffix {
	case "k":
		v = scaled(v, 1_000)
	case "m":
		v = scaled(v, 1_000_000)
	}
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, fmt.Errorf("%q is too large", text)
	}
	if (lead+trail) == "-" && v != 0 {
		v = -v
	}
	return v, nil
}

// scaled multiplies v by k and rounds to 15 significant digits so that scaling
// adds no binary noise (1.1 * 1000 stays 1100), as the entry grid does.
func scaled(v, k float64) float64 {
	p := v * k
	if math.IsInf(p, 0) {
		return p
	}
	r, err := strconv.ParseFloat(strconv.FormatFloat(p, 'g', 15, 64), 64)
	if err != nil {
		return p
	}
	return r
}

// parseBool reads a yes/no cell.
func parseBool(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "yes", "y", "1", "t", "x":
		return true, true
	case "false", "no", "n", "0", "f":
		return false, true
	}
	return false, false
}
