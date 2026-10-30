package engine

import (
	"math"
	"testing"

	"opsvision/internal/domain"
)

func TestFormat(t *testing.T) {
	tests := []struct {
		format string
		v      float64
		want   string
	}{
		{domain.FormatPercent0, 84.3, "84%"},
		{domain.FormatPercent0, 84.5, "85%"},
		{domain.FormatPercent0, -5, "-5%"},
		{domain.FormatPercent1, 84.29118, "84.3%"},
		{domain.FormatPercent1, 114.2068, "114.2%"},
		{domain.FormatPercent2, 99.9884, "99.99%"},
		{domain.FormatPercent2, 99.64, "99.64%"},
		{domain.FormatPercent2, 100, "100.00%"},
		{domain.FormatNumber0, 1587.4, "1,587"},
		{domain.FormatNumber0, 1587.5, "1,588"},
		{domain.FormatNumber0, 0, "0"},
		{domain.FormatNumber0, 1234567, "1,234,567"},
		{domain.FormatNumber0, 999.5, "1,000"},
		{domain.FormatNumber1, 1587.25, "1,587.3"},
		{domain.FormatNumber1, 1587, "1,587.0"},
		{domain.FormatNumber2, 1587.25, "1,587.25"},
		{domain.FormatNumber2, 1587.255, "1,587.26"},
		{domain.FormatNumber2, 1.005, "1.01"},
		{domain.FormatNumber2, 0.125, "0.13"},
		{domain.FormatMoneyK, 8234, "$8,234k"},
		{domain.FormatMoneyK, 8234.5, "$8,235k"},
		{domain.FormatMoneyK, -12, "-$12k"},
		{domain.FormatDays0, 16, "16 days"},
		{domain.FormatDays0, 1, "1 day"},
		{domain.FormatDays0, 1.4, "1 day"},
		{domain.FormatDays0, 0, "0 days"},
		{domain.FormatDays0, 1500, "1,500 days"},
		// Half rounds away from zero, in both directions.
		{domain.FormatNumber0, -2.5, "-3"},
		{domain.FormatNumber0, 2.5, "3"},
		{domain.FormatNumber1, -0.25, "-0.3"},
		// A negative value that rounds to zero shows no minus sign.
		{domain.FormatPercent0, -0.4, "0%"},
		{domain.FormatNumber1, -0.04, "0.0"},
		{domain.FormatMoneyK, -0.2, "$0k"},
		// Tiny and very large values stay in plain decimal notation.
		{domain.FormatNumber2, 1e-9, "0.00"},
		{domain.FormatNumber0, 1e15, "1,000,000,000,000,000"},
	}
	for _, tt := range tests {
		if got := Format(tt.format, tt.v); got != tt.want {
			t.Errorf("Format(%q, %v) = %q, want %q", tt.format, tt.v, got, tt.want)
		}
	}
}

func TestFormatNonFinite(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if got := Format(domain.FormatNumber1, v); got != "" {
			t.Errorf("Format(number1, %v) = %q, want empty", v, got)
		}
	}
}
