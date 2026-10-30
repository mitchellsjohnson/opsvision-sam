package engine

import (
	"math"
	"math/rand"
	"strconv"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

// The functions below are the original, allocation-heavy formatting
// implementations, kept as an oracle for the optimized ones in format.go.

// ref_roundForDisplay rounds v to the precision Format shows for the format code,
// using the same half-away-from-zero rule, so that what a status was judged on
// is what the reader sees. Unknown formats and non-finite values are returned
// unchanged.
func ref_roundForDisplay(format string, v float64) float64 {
	d, ok := displayDecimals(format)
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	digits := ref_roundedDigits(math.Abs(v), d)
	s := digits[:len(digits)-d]
	if d > 0 {
		s += "." + digits[len(digits)-d:]
	}
	r, err := strconv.ParseFloat(s, 64)
	if err != nil || r == 0 {
		return 0 * r // 0, never -0
	}
	if v < 0 {
		return -r
	}
	return r
}

// signed formats v with d decimals as prefix+number+suffix, putting a minus
// sign in front of the whole thing for negative values that do not round to
// zero.
func ref_signed(v float64, d int, prefix, suffix string) string {
	digits := ref_roundedDigits(math.Abs(v), d)
	neg := v < 0 && strings.Trim(digits, "0") != ""
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	b.WriteString(prefix)
	intPart, frac := digits[:len(digits)-d], digits[len(digits)-d:]
	b.WriteString(ref_groupThousands(intPart))
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
func ref_roundedDigits(abs float64, d int) string {
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
func ref_groupThousands(s string) string {
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

func TestFormatMatchesReference(t *testing.T) {
	formats := []string{domain.FormatPercent0, domain.FormatPercent1, domain.FormatPercent2,
		domain.FormatNumber0, domain.FormatNumber1, domain.FormatNumber2, domain.FormatMoneyK, domain.FormatDays0}
	vals := []float64{0, 0.004, 0.005, 0.5, 1, 1.005, 9.995, 99.95, 99.999, 999.5, 1234567.891, 1e15, 1e16, 123456789012345678,
		-0.004, -0.5, -1.005, -99.95, -1234.5, 1e-9, 5e-324, 1e300, 0.1 + 0.2}
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 20000; i++ {
		v := (rng.Float64() - 0.3) * math.Pow(10, float64(rng.Intn(12)-3))
		if i%3 == 0 {
			v = math.Round(v*100) / 100
		}
		vals = append(vals, v)
	}
	for _, v := range vals {
		for _, f := range formats {
			d, _ := displayDecimals(f)
			if got, want := roundForDisplay(f, v), ref_roundForDisplay(f, v); got != want || math.Signbit(got) != math.Signbit(want) {
				t.Fatalf("roundForDisplay(%s, %v) = %v, want %v", f, v, got, want)
			}
			if got, want := signed(v, d, "$", "k"), ref_signed(v, d, "$", "k"); got != want {
				t.Fatalf("signed(%v, %d) = %q, want %q", v, d, got, want)
			}
		}
	}
}
