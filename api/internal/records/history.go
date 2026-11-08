// Package records holds the pure logic that derivation runs over records:
// which revision a rule reads, where conditions, and commitments.
package records

import (
	"sort"
	"time"

	"opsvision/internal/domain"
)

// Latest returns the fields of r's latest revision, or zero fields when r
// has none. Revisions are sorted by AsOf, oldest first.
func Latest(r domain.Record) domain.RecordFields {
	if len(r.Revisions) == 0 {
		return domain.RecordFields{}
	}
	return r.Revisions[len(r.Revisions)-1].Fields
}

// FieldsOn returns the fields of the revision in force on day: the latest
// revision with AsOf on or before day, or the earliest revision when day is
// before the first one. It returns zero fields when r has no revisions.
func FieldsOn(r domain.Record, day domain.Date) domain.RecordFields {
	if len(r.Revisions) == 0 {
		return domain.RecordFields{}
	}
	return r.Revisions[revisionOn(r.Revisions, dayOf(day))].Fields
}

// revisionOn returns the index of the revision in force on day d (see
// FieldsOn). revs must be non-empty.
func revisionOn(revs []domain.RecordRevision, d time.Time) int {
	i := sort.Search(len(revs), func(i int) bool { return dayOf(revs[i].AsOf).After(d) })
	if i == 0 {
		return 0
	}
	return i - 1
}

// dayOf returns d's calendar date at UTC midnight, so dates compare by day
// whatever their time of day or location.
func dayOf(d domain.Date) time.Time {
	y, m, dd := d.Date()
	return time.Date(y, m, dd, 0, 0, 0, 0, time.UTC)
}
