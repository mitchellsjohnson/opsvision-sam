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
	revs := r.Revisions
	if len(revs) == 0 {
		return domain.RecordFields{}
	}
	d := dayOf(day)
	i := sort.Search(len(revs), func(i int) bool { return dayOf(revs[i].AsOf).After(d) })
	if i == 0 {
		return revs[0].Fields
	}
	return revs[i-1].Fields
}

// dayOf returns d's calendar date at UTC midnight, so dates compare by day
// whatever their time of day or location.
func dayOf(d domain.Date) time.Time {
	y, m, dd := d.Date()
	return time.Date(y, m, dd, 0, 0, 0, 0, time.UTC)
}
