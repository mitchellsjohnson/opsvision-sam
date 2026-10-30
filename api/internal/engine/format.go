package engine

import (
	"math"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// Format renders v for display according to one of the domain.Format* codes:
//
//	percent0 "84%"   percent1 "84.3%"   percent2 "99.99%"
//	number0 "1,587"  number1 "1,587.3"  number2 "1,587.25"
//	money_k "$8,234k" (v is already in thousands)
//	days0 "16 days" ("1 day" when the rounded value is 1)
//
// Rounding is half away from zero, performed on the shortest decimal
// representation of v so that 1.005 displays as 1.01 rather than falling to
// binary floating-point noise. Integer parts use comma thousands separators.
// A negative value keeps a leading minus ("-5%", "-$12k"), except that a value
// that rounds to zero is shown unsigned. Format returns "" for NaN and
// infinities, and an unrounded plain number for an unknown format code.
func Format(format string, v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return ""
	}
	switch format {
	case domain.FormatPercent0:
		return signed(v, 0, "", "%")
	case domain.FormatPercent1:
		return signed(v, 1, "", "%")
	case domain.FormatPercent2:
		return signed(v, 2, "", "%")
	case domain.FormatNumber0:
		return signed(v, 0, "", "")
	case domain.FormatNumber1:
		return signed(v, 1, "", "")
	case domain.FormatNumber2:
		return signed(v, 2, "", "")
	case domain.FormatMoneyK:
		return signed(v, 0, "$", "k")
	case domain.FormatDays0:
		s := signed(v, 0, "", "")
		if strings.TrimPrefix(s, "-") == "1" {
			return s + " day"
		}
		return s + " days"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// signed formats v with d decimals as prefix+number+suffix, putting a minus
// sign in front of the whole thing for negative values that do not round to
// zero.
func signed(v float64, d int, prefix, suffix string) string {
	digits := roundedDigits(math.Abs(v), d)
	neg := v < 0 && strings.Trim(digits, "0") != ""
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	b.WriteString(prefix)
	intPart, frac := digits[:len(digits)-d], digits[len(digits)-d:]
	b.WriteString(groupThousands(intPart))
	if d > 0 {
		b.WriteByte('.')
		b.WriteString(frac)
	}
	b.WriteString(suffix)
	return b.String()
}

// roundedDigits returns abs (>= 0) scaled by 10^d and rounded half up, as a
// string of decimal digits with at least d+1 digits (so the last d digits are
// the fraction and the rest the integer part).
func roundedDigits(abs float64, d int) string {
	s := strconv.FormatFloat(abs, 'f', -1, 64)
	intPart, frac, _ := strings.Cut(s, ".")
	roundUp := false
	if len(frac) > d {
		roundUp = frac[d] >= '5'
		frac = frac[:d]
	} else {
		frac += strings.Repeat("0", d-len(frac))
	}
	digits := []byte(intPart + frac)
	if roundUp {
		i := len(digits) - 1
		for ; i >= 0; i-- {
			if digits[i] == '9' {
				digits[i] = '0'
				continue
			}
			digits[i]++
			break
		}
		if i < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	// Guarantee an integer digit ("0.5" at d=2 is "050", but ".5" never occurs
	// because FormatFloat always emits a leading digit).
	for len(digits) < d+1 {
		digits = append([]byte{'0'}, digits...)
	}
	return string(digits)
}

// groupThousands inserts commas into a string of digits.
func groupThousands(s string) string {
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	first := len(s) % 3
	if first > 0 {
		b.WriteString(s[:first])
	}
	for i := first; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
