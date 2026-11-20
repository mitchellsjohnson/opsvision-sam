// Package rca is the arithmetic behind a cell's "Why?": which cells expect an
// RCA, the gap between the displayed value and its ideal or best band, the
// incident minutes that explain a downtime gap, the records that explain the
// rest, rounding that keeps every part adding up to the headline, and when a
// written note has gone stale. It reads nothing and stores nothing.
package rca

import (
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// Window is a period's span, Start inclusive and End exclusive.
type Window struct{ Start, End time.Time }

// Minutes is the window's length in minutes.
func (w Window) Minutes() float64 { return w.End.Sub(w.Start).Minutes() }

// PeriodWindow returns p's calendar boundaries at midnight in loc (UTC when
// nil). v1 callers pass time.UTC for every tenant.
func PeriodWindow(cal period.Calendar, p period.Period, loc *time.Location) Window {
	if loc == nil {
		loc = time.UTC
	}
	at := func(t time.Time) time.Time {
		y, m, d := t.Date()
		return time.Date(y, m, d, 0, 0, 0, 0, loc)
	}
	return Window{Start: at(cal.Start(p)), End: at(cal.End(p))}
}

// Cutoff is the instant an incident source's data runs to: its latest
// snapshot's as-of date plus 24 hours, in UTC (as of Nov 14 covers through
// Nov 14 23:59:59).
func Cutoff(asOf domain.Date) time.Time {
	y, m, d := asOf.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
}
