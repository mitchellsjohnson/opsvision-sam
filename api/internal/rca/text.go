package rca

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// Duration formats whole minutes: 45m, 3h 36m, 1d 2h 05m (minutes
// zero-padded after hours). Negative minutes read as 0m.
func Duration(minutes float64) string {
	m := int64(math.Round(math.Max(minutes, 0)))
	days, hours, mins := m/(24*60), m/60%24, m%60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh %02dm", days, hours, mins)
	case hours > 0:
		return fmt.Sprintf("%dh %02dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}

// fixed formats v with exactly decimals places.
func fixed(v float64, decimals int) string {
	return strconv.FormatFloat(v, 'f', max(decimals, 0), 64)
}

// unitsText formats whole units of 10^-decimals as a decimal: 94 at 2 is 0.94.
func unitsText(units int64, decimals int) string {
	return fixed(float64(units)/math.Pow10(decimals), decimals)
}

// trimmed formats v with at most decimals places, dropping trailing zeros:
// 9.0909 at 1 is 9.1, 25.0 is 25.
func trimmed(v float64, decimals int) string {
	s := fixed(v, decimals)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" {
		return "0"
	}
	return s
}

// signedTrimmed is trimmed with a + for values above zero.
func signedTrimmed(v float64, decimals int) string {
	s := trimmed(v, decimals)
	if s != "0" && !strings.HasPrefix(s, "-") {
		return "+" + s
	}
	return s
}

// shortDate formats a calendar date as Oct 15.
func shortDate(d domain.Date) string { return d.UTC().Format("Jan 2") }

// days is the whole number of calendar days from a to b.
func days(a, b domain.Date) int {
	return int(math.Round(b.UTC().Sub(a.UTC()).Hours() / 24))
}

// dayCount is "1 day" or "3 days".
func dayCount(n int) string {
	if n == 1 {
		return "1 day"
	}
	return fmt.Sprintf("%d days", n)
}

// listKeys joins keys as "A", "A and B", or "A, B and C".
func listKeys(keys []string) string {
	switch len(keys) {
	case 0:
		return ""
	case 1:
		return keys[0]
	}
	return strings.Join(keys[:len(keys)-1], ", ") + " and " + keys[len(keys)-1]
}
