package httpapi

import (
	"slices"

	"opsvision/internal/domain"
)

// gateStale reports whether a stored basis differs from the current one in
// what the gate computes: the standing's value and status, the reported
// downtime (when both have it) and the subjects short of perfect.
func gateStale(stored, current domain.RCABasis) bool {
	if stored.Display != current.Display || stored.Status != current.Status {
		return true
	}
	if s, c := stored.ReportedMinutes, current.ReportedMinutes; s != nil && c != nil && *s != *c {
		return true
	}
	return !slices.Equal(subjectEvidence(stored.Evidence), subjectEvidence(current.Evidence))
}
