package report_test

import (
	"slices"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/report"
)

func month(fy, idx int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: idx} }

func periodStrings(ps []period.Period) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.String()
	}
	return out
}

var twelveMonthsToOct2026 = []string{
	"2025-M11", "2025-M12", "2026-M01", "2026-M02", "2026-M03", "2026-M04",
	"2026-M05", "2026-M06", "2026-M07", "2026-M08", "2026-M09", "2026-M10",
}

func TestStandingPeriodsJanuaryYear(t *testing.T) {
	cal := period.Calendar{FiscalYearStartMonth: time.January}
	for _, tc := range []struct {
		name  string
		freqs []domain.Frequency
		extra []string
	}{
		{"monthly only", []domain.Frequency{domain.FrequencyMonthly}, nil},
		{"none", nil, nil},
		{"coarse", []domain.Frequency{domain.FrequencyMonthly, domain.FrequencyQuarterly, domain.FrequencyBiannual},
			[]string{"2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2025-H2", "2026-H1"}},
		{"annual", []domain.Frequency{domain.FrequencyAnnual, domain.FrequencyMonthly},
			[]string{"2023-FY", "2024-FY", "2025-FY"}},
		{"repeated and unordered", []domain.Frequency{domain.FrequencyBiannual, domain.FrequencyQuarterly, domain.FrequencyQuarterly},
			[]string{"2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2025-H2", "2026-H1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := periodStrings(report.StandingPeriods(cal, month(2026, 10), tc.freqs))
			want := append(slices.Clone(twelveMonthsToOct2026), tc.extra...)
			if !slices.Equal(got, want) {
				t.Fatalf("StandingPeriods = %v, want %v", got, want)
			}
		})
	}
}

// The web's coarseColumns gives the same periods: the grain's period holding
// the month, stepped back one when it ends after the month.
func TestStandingPeriodsMatchTheWebsWindow(t *testing.T) {
	all := []domain.Frequency{domain.FrequencyQuarterly, domain.FrequencyBiannual, domain.FrequencyAnnual}
	// A July fiscal year: October 2026 is month 4 of FY2027.
	july := period.Calendar{FiscalYearStartMonth: time.July}
	got := periodStrings(report.StandingPeriods(july, month(2027, 4), all))
	want := []string{
		"2026-M05", "2026-M06", "2026-M07", "2026-M08", "2026-M09", "2026-M10",
		"2026-M11", "2026-M12", "2027-M01", "2027-M02", "2027-M03", "2027-M04",
		"2026-Q2", "2026-Q3", "2026-Q4", "2027-Q1",
		"2026-H1", "2026-H2",
		"2024-FY", "2025-FY", "2026-FY",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("July year = %v, want %v", got, want)
	}
	// The last quarter is the one that ends in September 2026.
	if q := report.StandingPeriods(july, month(2027, 4), all)[15]; july.End(q) != time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("last quarter %s ends %s, want the end of Sep 2026", q, july.End(q))
	}

	// A month that closes its quarter, half and year counts them (coarseColumns('2026-M12', 'year', 1, 1) is 2026-FY).
	jan := period.Calendar{FiscalYearStartMonth: time.January}
	tail := periodStrings(report.StandingPeriods(jan, month(2026, 12), all)[12:])
	if want := []string{"2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4", "2026-H1", "2026-H2", "2024-FY", "2025-FY", "2026-FY"}; !slices.Equal(tail, want) {
		t.Fatalf("Dec 2026 coarse = %v, want %v", tail, want)
	}
	// coarseColumns('2026-M02', 'quarter', 1, 4) is 2025-Q4; with four quarters it ends there.
	april := period.Calendar{FiscalYearStartMonth: time.April}
	quarters := periodStrings(report.StandingPeriods(april, month(2026, 2), []domain.Frequency{domain.FrequencyQuarterly})[12:])
	if want := []string{"2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"}; !slices.Equal(quarters, want) {
		t.Fatalf("April year quarters = %v, want %v", quarters, want)
	}
}
