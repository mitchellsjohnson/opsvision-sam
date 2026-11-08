package records

import (
	"reflect"
	"testing"
	"time"

	"opsvision/internal/domain"
)

func epic(revs ...domain.RecordRevision) domain.Record {
	return domain.Record{Source: "tracker", ExternalID: "BIL-7", Type: "epic", Revisions: revs}
}

func open(due string) domain.RecordFields {
	return domain.RecordFields{SubjectKey: "billing", State: domain.StateOpen, DueAt: dp(due)}
}

func closed(state domain.RecordState, due, completed string) domain.RecordFields {
	return domain.RecordFields{SubjectKey: "billing", State: state, DueAt: dp(due), CompletedAt: dp(completed)}
}

func checkCommitments(t *testing.T, got, want []Commitment) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commitments:\n got %v\nwant %v", got, want)
	}
}

func TestCommitmentSlip(t *testing.T) {
	r := epic(
		rev("2026-11-30", open("2026-12-15")),
		rev("2027-01-05", open("2027-02-10")),
		rev("2027-02-28", closed(domain.StateDone, "2027-02-10", "2027-02-08")),
	)
	checkCommitments(t, Commitments(r, day("2027-02-28")), []Commitment{
		{Due: day("2026-12-15"), Outcome: OutcomeMissed, Slipped: true},
		{Due: day("2027-02-10"), Outcome: OutcomeMet},
	})
}

func TestCommitmentLateNoReplan(t *testing.T) {
	r := epic(
		rev("2026-12-31", open("2026-12-31")),
		rev("2027-01-31", closed(domain.StateDone, "2026-12-31", "2027-01-01")),
	)
	checkCommitments(t, Commitments(r, day("2027-01-31")), []Commitment{
		{Due: day("2026-12-31"), Outcome: OutcomeMissed},
	})
}

func TestPullInNoDing(t *testing.T) {
	r := epic(
		rev("2026-12-31", open("2027-02-10")),
		rev("2027-01-10", open("2027-01-20")),
		rev("2027-01-31", closed(domain.StateDone, "2027-01-20", "2027-01-15")),
	)
	checkCommitments(t, Commitments(r, day("2027-01-31")), []Commitment{
		{Due: day("2027-01-20"), Outcome: OutcomeMet},
	})
}

func TestCancelledBeforeDueDrops(t *testing.T) {
	r := epic(
		rev("2026-12-31", open("2027-01-31")),
		rev("2027-01-31", closed(domain.StateCancelled, "2027-01-31", "2027-01-10")),
	)
	checkCommitments(t, Commitments(r, day("2027-01-31")), []Commitment{
		{Due: day("2027-01-31"), Outcome: OutcomeDropped},
	})
}

func TestCancelledAfterSlipKeepsMiss(t *testing.T) {
	r := epic(
		rev("2026-11-30", open("2026-12-15")),
		rev("2026-12-31", open("2027-02-10")),
		rev("2027-01-31", closed(domain.StateCancelled, "2027-02-10", "2027-01-20")),
	)
	checkCommitments(t, Commitments(r, day("2027-01-31")), []Commitment{
		{Due: day("2026-12-15"), Outcome: OutcomeMissed, Slipped: true},
		{Due: day("2027-02-10"), Outcome: OutcomeDropped},
	})
}

func TestCancelledAfterDueMisses(t *testing.T) {
	r := epic(
		rev("2026-12-31", open("2026-12-15")),
		rev("2027-01-31", closed(domain.StateCancelled, "2026-12-15", "2027-01-10")),
	)
	checkCommitments(t, Commitments(r, day("2027-01-31")), []Commitment{
		{Due: day("2026-12-15"), Outcome: OutcomeMissed},
	})
}

func TestPendingBeforeCutoff(t *testing.T) {
	r := epic(rev("2027-01-31", open("2027-03-31")))
	checkCommitments(t, Commitments(r, day("2027-02-28")), []Commitment{
		{Due: day("2027-03-31"), Outcome: OutcomePending},
	})
	// Once the cutoff reaches the due date, an unmet commitment is missed.
	checkCommitments(t, Commitments(r, day("2027-03-31")), []Commitment{
		{Due: day("2027-03-31"), Outcome: OutcomeMissed},
	})
}

func TestPriorDueDatesPrepended(t *testing.T) {
	latest := closed(domain.StateDone, "2026-12-15", "2026-12-10")
	latest.PriorDueDates = []domain.Date{day("2026-10-15"), day("2026-11-15")}
	r := epic(
		rev("2026-11-30", open("2026-11-15")), // repeats the last prior date
		rev("2026-12-31", latest),
	)
	checkCommitments(t, Commitments(r, day("2026-12-31")), []Commitment{
		{Due: day("2026-10-15"), Outcome: OutcomeMissed, Slipped: true},
		{Due: day("2026-11-15"), Outcome: OutcomeMissed, Slipped: true},
		{Due: day("2026-12-15"), Outcome: OutcomeMet},
	})
}

func TestCommitmentsIgnoreTimeOfDay(t *testing.T) {
	// The same calendar date at two times of day is one date, not a slip.
	noon := domain.Date{Time: time.Date(2026, 12, 15, 12, 0, 0, 0, time.UTC)}
	r := epic(
		rev("2026-11-30", open("2026-12-15")),
		rev("2026-12-31", domain.RecordFields{State: domain.StateDone, DueAt: &noon, CompletedAt: dp("2026-12-15")}),
	)
	checkCommitments(t, Commitments(r, day("2026-12-31")), []Commitment{
		{Due: day("2026-12-15"), Outcome: OutcomeMet},
	})
}

func TestNoDueDateNoCommitments(t *testing.T) {
	r := epic(rev("2026-11-30", domain.RecordFields{State: domain.StateOpen}))
	if got := Commitments(r, day("2026-12-31")); len(got) != 0 {
		t.Fatalf("commitments = %v, want none", got)
	}
}
