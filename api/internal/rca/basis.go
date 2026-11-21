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
	if len(added) == 0 && len(removed) == 0 && !sameSet(stored.Evidence, current.Evidence) {
		out = append(out, "The attribution changed since it was written.")
	}
	if s, c := stored.ReportedMinutes, current.ReportedMinutes; s != nil && c != nil && *s != *c {
		out = append(out, fmt.Sprintf("The reported downtime changed from %s to %s.", Duration(float64(*s)), Duration(float64(*c))))
	}
	return out
}

// evidenceDiff returns the keys (evidenceKey) only in current (added) and
// only in stored (removed), each once, in the order given. An incident that
// fanned out counts as one key, so one that moved between services is in
// neither.
func evidenceDiff(stored, current []string) (added, removed []string) {
	return keysOnlyIn(current, stored), keysOnlyIn(stored, current)
}

// keysOnlyIn returns the keys of a's entries that no entry of b has.
func keysOnlyIn(a, b []string) []string {
	inB := make(map[string]bool, len(b))
	for _, e := range b {
		inB[evidenceKey(e)] = true
	}
	var out []string
	for _, e := range a {
		if k := evidenceKey(e); !inB[k] {
			inB[k] = true
			out = append(out, k)
		}
	}
	return out
}

// evidenceKey is the key a "source:externalId" entry is shown by: the
// external ID without the source, and without the "@{service}" a fan-out
// adds ("{key}@{service}"), so INC-2049@Search reads as INC-2049.
func evidenceKey(e string) string {
	id := e
	if _, rest, ok := strings.Cut(e, ":"); ok {
		id = rest
	}
	if i := strings.LastIndex(id, "@"); i > 0 {
		id = id[:i]
	}
	return id
}

func sameSet(a, b []string) bool {
	set := func(xs []string) map[string]bool {
		m := make(map[string]bool, len(xs))
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	sa, sb := set(a), set(b)
	if len(sa) != len(sb) {
		return false
	}
	for x := range sa {
		if !sb[x] {
			return false
		}
	}
	return true
}
