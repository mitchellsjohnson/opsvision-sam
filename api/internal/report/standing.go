package report

import (
	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// SchemaVersion is the version of new snapshots: 2 adds Document.Standing.
// A stored Document without one (0) is version 1.
const SchemaVersion = 2

// standingMonths is the Overview's trend window in months.
const standingMonths = 12

// coarseSpans lists the coarse grains in column order, each with the number
// of its periods the Overview shows (the web's COARSE_SPAN).
var coarseSpans = []struct {
	freq  domain.Frequency
	grain period.Grain
	span  int
}{
	{domain.FrequencyQuarterly, period.Quarter, 4},
	{domain.FrequencyBiannual, period.Half, 2},
	{domain.FrequencyAnnual, period.Year, 3},
}

// StandingPeriods are the columns the Overview asks for at month: the 12
// months ending at it, then, for each grain of freqs coarser than a month,
// that grain's periods closed by month (the web's windowColumns: the grain's
// period holding month, stepped back one when it ends after month, and the
// ones before it), oldest first.
func StandingPeriods(cal period.Calendar, month period.Period, freqs []domain.Frequency) []period.Period {
	out := make([]period.Period, standingMonths)
	m := month
	for i := standingMonths - 1; i >= 0; i-- {
		out[i] = m
		m = cal.Prev(m)
	}
	used := map[domain.Frequency]bool{}
	for _, f := range freqs {
		used[f] = true
	}
	for _, c := range coarseSpans {
		if !used[c.freq] {
			continue
		}
		last := cal.Parent(month, c.grain)
		if cal.End(last).After(cal.End(month)) {
			last = cal.Prev(last)
		}
		ps := make([]period.Period, c.span)
		for i := c.span - 1; i >= 0; i-- {
			ps[i] = last
			last = cal.Prev(last)
		}
		out = append(out, ps...)
	}
	return out
}
