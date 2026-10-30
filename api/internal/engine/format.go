package engine

import (
	"bytes"
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

// displayDecimals returns how many decimals Format shows for a format code.
func displayDecimals(format string) (int, bool) {
	switch format {
	case domain.FormatPercent0, domain.FormatNumber0, domain.FormatMoneyK, domain.FormatDays0:
		return 0, true
	case domain.FormatPercent1, domain.FormatNumber1:
		return 1, true
	case domain.FormatPercent2, domain.FormatNumber2:
		return 2, true
	}
	return 0, false
}

// pow10 holds 10^d for the decimals Format can show.
var pow10 = [...]float64{1, 10, 100}

// roundForDisplay rounds v to the precision Format shows for the format code,
// using the same half-away-from-zero rule, so that what a status was judged on
// is what the reader sees. Unknown formats and non-finite values are returned
// unchanged.
func roundForDisplay(format string, v float64) float64 {
	d, ok := displayDecimals(format)
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	var tmp [64]byte
	digits := appendRoundedDigits(tmp[:0], math.Abs(v), d)
	var r float64
	if len(digits) <= 15 {
		// An integer below 2^53 over an exact power of ten is correctly
		// rounded, so this equals parsing the decimal string.
		n := 0
		for _, c := range digits {
			n = n*10 + int(c-'0')
		}
		r = float64(n) / pow10[d]
	} else {
		s := string(digits[:len(digits)-d])
		if d > 0 {
			s += "." + string(digits[len(digits)-d:])
		}
		var err error
		if r, err = strconv.ParseFloat(s, 64); err != nil {
			return 0
		}
	}
	if r == 0 {
		return 0 // 0, never -0
	}
	if v < 0 {
		return -r
	}
	return r
}

// signed formats v with d decimals as prefix+number+suffix, putting a minus
// sign in front of the whole thing for negative values that do not round to
// zero.
func signed(v float64, d int, prefix, suffix string) string {
	var tmp [64]byte
	digits := appendRoundedDigits(tmp[:0], math.Abs(v), d)
	neg := false
	if v < 0 {
		for _, c := range digits {
			if c != '0' {
				neg = true
				break
			}
		}
	}
	var out [96]byte
	b := out[:0]
	if neg {
		b = append(b, '-')
	}
	b = append(b, prefix...)
	n := len(digits) - d
	b = appendGrouped(b, digits[:n])
	if d > 0 {
		b = append(b, '.')
		b = append(b, digits[n:]...)
	}
	b = append(b, suffix...)
	return string(b)
}

// appendRoundedDigits appends abs (>= 0) scaled by 10^d and rounded half up,
// as decimal digits: at least d+1 of them (FormatFloat always emits an
// integer digit), the last d being the fraction and the rest the integer
// part. It works on the shortest decimal representation of abs.
func appendRoundedDigits(dst []byte, abs float64, d int) []byte {
	var tmp [64]byte
	b := strconv.AppendFloat(tmp[:0], abs, 'f', -1, 64)
	intPart, frac := b, []byte(nil)
	if dot := bytes.IndexByte(b, '.'); dot >= 0 {
		intPart, frac = b[:dot], b[dot+1:]
	}
	start := len(dst)
	dst = append(dst, intPart...)
	roundUp := false
	if len(frac) > d {
		roundUp = frac[d] >= '5'
		frac = frac[:d]
	}
	dst = append(dst, frac...)
	for i := len(frac); i < d; i++ {
		dst = append(dst, '0')
	}
	if roundUp {
		digits := dst[start:]
		i := len(digits) - 1
		for ; i >= 0; i-- {
			if digits[i] == '9' {
				digits[i] = '0'
				continue
			}
			digits[i]++
			break
		}
		if i < 0 { // carried out of the top digit: 99.9 -> 100.0
			dst = append(dst, 0)
			digits = dst[start:]
			copy(digits[1:], digits)
			digits[0] = '1'
		}
	}
	return dst
}

// appendGrouped appends a string of digits with commas inserted.
func appendGrouped(b []byte, s []byte) []byte {
	if len(s) <= 3 {
		return append(b, s...)
	}
	wrote := false
	first := len(s) % 3
	if first > 0 {
		b = append(b, s[:first]...)
		wrote = true
	}
	for i := first; i < len(s); i += 3 {
		if wrote {
			b = append(b, ',')
		}
		b = append(b, s[i:i+3]...)
		wrote = true
	}
	return b
}
