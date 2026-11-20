package rca

import (
	"fmt"
	"strings"

	"opsvision/internal/domain"
)

// StaleReasons compares the basis a note was written against with the
// cell's current one and returns why the note may be out of date, in order:
// the value, the status, incidents that now count, incidents that no longer
// count, and the reported downtime (only when both bases have it). Equal
// bases give none. Callers pass bases built over readable evidence only.
func StaleReasons(stored, current domain.RCABasis, statusLabel func(string) string) []string {
	label := func(s string) string {
		if statusLabel != nil {
			if l := statusLabel(s); l != "" {
				return l
			}
		}
		return s
	}
	var out []string
	if stored.Display != current.Display {
		out = append(out, fmt.Sprintf("The value changed from %s to %s.", stored.Display, current.Display))
	}
	if stored.Status != current.Status {
		out = append(out, fmt.Sprintf("The status changed from %s to %s.", label(stored.Status), label(current.Status)))
	}
	added, removed := evidenceDiff(stored.Evidence, current.Evidence)
	switch len(added) {
	case 0:
	case 1:
		out = append(out, fmt.Sprintf("1 new incident since it was written: %s.", added[0]))
	default:
		out = append(out, fmt.Sprintf("%d new incidents since it was written: %s.", len(added), strings.Join(added, ", ")))
	}
	switch len(removed) {
	case 0:
	case 1:
		out = append(out, fmt.Sprintf("%s no longer counts.", removed[0]))
	default:
		out = append(out, fmt.Sprintf("%s no longer count.", listKeys(removed)))
	}
	if s, c := stored.ReportedMinutes, current.ReportedMinutes; s != nil && c != nil && *s != *c {
		out = append(out, fmt.Sprintf("The reported downtime changed from %s to %s.", Duration(float64(*s)), Duration(float64(*c))))
	}
	return out
}

// evidenceDiff returns the keys of the evidence entries ("source:externalId")
// only in current (added) and only in stored (removed), each in the order
// given, without the source.
func evidenceDiff(stored, current []string) (added, removed []string) {
	inStored := make(map[string]bool, len(stored))
	for _, e := range stored {
		inStored[e] = true
	}
	inCurrent := make(map[string]bool, len(current))
	for _, e := range current {
		inCurrent[e] = true
		if !inStored[e] {
			added = append(added, evidenceKey(e))
		}
	}
	for _, e := range stored {
		if !inCurrent[e] {
			removed = append(removed, evidenceKey(e))
		}
	}
	return added, removed
}

// evidenceKey is the external ID of a "source:externalId" entry.
func evidenceKey(e string) string {
	if _, id, ok := strings.Cut(e, ":"); ok {
		return id
	}
	return e
}
