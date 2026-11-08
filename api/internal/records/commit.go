package records

import (
	"time"

	"opsvision/internal/domain"
)

// Outcome is how one commitment turned out.
type Outcome string

// Commitment outcomes.
const (
	OutcomeMet     Outcome = "met"
	OutcomeMissed  Outcome = "missed"
	OutcomePending Outcome = "pending"
	OutcomeDropped Outcome = "dropped"
)

// Commitment is one committed due date of a record and its outcome. Slipped
// is set when the date was missed because it moved to a later date.
type Commitment struct {
	Due     domain.Date
	Outcome Outcome
	Slipped bool
}

// Commitments returns r's commitments in date-history order. Every committed
// due date is its own commitment: the latest revision's prior due dates, then
// each revision's due date that is not one of them, with consecutive repeats
// removed. A date that
// moves later is missed and slipped; a date that moves earlier is replaced
// without an entry. The record's latest state decides the last date: done on
// or before it is met, cancelled on or before it is dropped, otherwise it is
// missed once cutoff reaches it and pending before that.
func Commitments(r domain.Record, cutoff domain.Date) []Commitment {
	latest := Latest(r)
	dates := dueDates(r, latest)
	if len(dates) == 0 {
		return nil
	}
	var completed time.Time
	hasCompleted := latest.CompletedAt != nil && !latest.CompletedAt.IsZero()
	if hasCompleted {
		completed = dayOf(*latest.CompletedAt)
	}
	completedBy := func(d time.Time) bool { return hasCompleted && !completed.After(d) }
	cut := dayOf(cutoff)

	var out []Commitment
	for i, d := range dates {
		due := domain.Date{Time: d}
		hasNext := i+1 < len(dates)
		if hasNext && dates[i+1].Before(d) {
			continue // pulled in: the earlier date replaces this one
		}
		if latest.State == domain.StateDone && completedBy(d) {
			out = append(out, Commitment{Due: due, Outcome: OutcomeMet})
			break
		}
		if hasNext {
			out = append(out, Commitment{Due: due, Outcome: OutcomeMissed, Slipped: true})
			continue
		}
		switch {
		case latest.State == domain.StateCancelled && completedBy(d):
			out = append(out, Commitment{Due: due, Outcome: OutcomeDropped})
		case !d.After(cut):
			out = append(out, Commitment{Due: due, Outcome: OutcomeMissed})
		default:
			out = append(out, Commitment{Due: due, Outcome: OutcomePending})
		}
	}
	return out
}

// dueDates returns latest's prior due dates followed by each revision's due
// date in AsOf order that is not already a prior due date, as calendar days,
// with consecutive repeats removed. Prior due dates can repeat dates the
// revisions also tracked; each date counts once.
func dueDates(r domain.Record, latest domain.RecordFields) []time.Time {
	var out []time.Time
	add := func(t time.Time) {
		if n := len(out); n > 0 && out[n-1].Equal(t) {
			return
		}
		out = append(out, t)
	}
	prior := make(map[time.Time]bool, len(latest.PriorDueDates))
	for _, d := range latest.PriorDueDates {
		if d.IsZero() {
			continue
		}
		t := dayOf(d)
		prior[t] = true
		add(t)
	}
	for _, rv := range r.Revisions {
		if d := rv.Fields.DueAt; d != nil && !d.IsZero() && !prior[dayOf(*d)] {
			add(dayOf(*d))
		}
	}
	return out
}
