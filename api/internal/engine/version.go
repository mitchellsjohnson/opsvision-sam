package engine

import (
	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// inForce reports whether a version may be selected for historical periods.
// Drafts and versions in review are only ever used by explicit restatement.
func inForce(v domain.MethodologyVersion) bool {
	return v.Status == domain.VersionPublished || v.Status == domain.VersionSuperseded
}

// startOrdinal numbers the first month a version is effective from; ok is
// false when EffectiveFrom is not a valid period.
func startOrdinal(cal period.Calendar, v domain.MethodologyVersion) (int, bool) {
	ms := cal.Months(v.EffectiveFrom)
	if len(ms) == 0 {
		return 0, false
	}
	return monthOrdinal(ms[0]), true
}

// newerVersion reports whether a is more recent than b: later EffectiveFrom,
// then later PublishedAt (an unpublished version loses), then greater ID so
// the answer never depends on input order.
func newerVersion(cal period.Calendar, a, b domain.MethodologyVersion) bool {
	ao, _ := startOrdinal(cal, a)
	bo, _ := startOrdinal(cal, b)
	if ao != bo {
		return ao > bo
	}
	switch {
	case a.PublishedAt != nil && b.PublishedAt != nil:
		if !a.PublishedAt.Equal(*b.PublishedAt) {
			return a.PublishedAt.After(*b.PublishedAt)
		}
	case a.PublishedAt != nil:
		return true
	case b.PublishedAt != nil:
		return false
	}
	return a.ID > b.ID
}

// VersionFor returns the methodology version in force for a period: among
// published and superseded versions, the one with the greatest EffectiveFrom
// at or before the last month of last (ties go to the later PublishedAt).
// The bool is false when no version was in force yet, or last is not a valid
// period. For a year-to-date column pass the month it runs through.
func VersionFor(versions []domain.MethodologyVersion, last period.Period, cal period.Calendar) (domain.MethodologyVersion, bool) {
	ms := cal.Months(last)
	if len(ms) == 0 {
		return domain.MethodologyVersion{}, false
	}
	end := monthOrdinal(ms[len(ms)-1])
	var best domain.MethodologyVersion
	found := false
	for _, v := range versions {
		if !inForce(v) {
			continue
		}
		o, ok := startOrdinal(cal, v)
		if !ok || o > end {
			continue
		}
		if !found || newerVersion(cal, v, best) {
			best, found = v, true
		}
	}
	return best, found
}
