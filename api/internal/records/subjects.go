package records

import (
	"sort"
	"strings"

	"opsvision/internal/period"
)

// Subject problems returned by ResolveSubject.
const (
	SubjectUnmatched = "unmatched"
	SubjectParent    = "parent"
	SubjectAmbiguous = "ambiguous"
)

// ResolveSubject returns the org unit or tracked item whose source keys
// include key, compared case-insensitively after trimming. problem is
// "unmatched" when nothing matches, "ambiguous" when more than one subject
// does, and "parent" (with the unit's ID) when the unit has child units in
// month. Otherwise problem is "". Org units not active in month are ignored.
// It builds a Resolver for one answer; build one with NewResolver to resolve
// many keys.
func ResolveSubject(in DeriveInput, key string, month period.Period) (subjectID string, problem string) {
	return NewResolver(in).Resolve(key, month)
}

// subjectRef is one org unit or tracked item that carries a source key.
type subjectRef struct {
	id   string
	unit bool
}

type resolveKey struct {
	key   string
	month period.Period
}

type resolution struct {
	id, problem string
}

// Resolver indexes the source keys of in's org units and tracked items and
// caches answers by (key, month). Derivation and import previews share it so
// they agree on every match. It is not safe for concurrent use.
type Resolver struct {
	in    DeriveInput
	byKey map[string][]subjectRef
	cache map[resolveKey]resolution
}

func normKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// NewResolver indexes in's source keys.
func NewResolver(in DeriveInput) *Resolver {
	r := &Resolver{in: in, byKey: map[string][]subjectRef{}, cache: map[resolveKey]resolution{}}
	add := func(ref subjectRef, keys []string) {
		seen := map[string]bool{}
		for _, k := range keys {
			if k = normKey(k); k != "" && !seen[k] {
				seen[k] = true
				r.byKey[k] = append(r.byKey[k], ref)
			}
		}
	}
	if in.Tree != nil {
		for _, id := range in.Tree.UnitIDs() {
			u, _ := in.Tree.Unit(id)
			add(subjectRef{id: id, unit: true}, u.SourceKeys)
		}
	}
	for _, it := range in.Items {
		add(subjectRef{id: it.ID}, it.SourceKeys)
	}
	return r
}

// Resolve answers ResolveSubject for key in month.
func (r *Resolver) Resolve(key string, month period.Period) (subjectID string, problem string) {
	ck := resolveKey{normKey(key), month}
	if res, ok := r.cache[ck]; ok {
		return res.id, res.problem
	}
	var refs []subjectRef
	for _, ref := range r.byKey[ck.key] {
		if !ref.unit || r.in.Tree.ActiveAt(ref.id, month) {
			refs = append(refs, ref)
		}
	}
	var res resolution
	switch {
	case len(refs) == 0:
		res.problem = SubjectUnmatched
	case len(refs) > 1:
		res.problem = SubjectAmbiguous
	default:
		res.id = refs[0].id
		if refs[0].unit && len(r.in.Tree.ChildrenAt(res.id, month)) > 0 {
			res.problem = SubjectParent
		}
	}
	r.cache[ck] = res
	return res.id, res.problem
}

// cellSubjects returns the subjects that get a derived value in a period
// made of months, sorted by ID: tracked items with a source key, and org
// units with a source key that are active in at least one of the months and
// have child units in none of them.
func cellSubjects(in DeriveInput, months []period.Period) []string {
	var out []string
	hasKey := func(keys []string) bool {
		for _, k := range keys {
			if normKey(k) != "" {
				return true
			}
		}
		return false
	}
	if in.Tree != nil {
		for _, id := range in.Tree.UnitIDs() {
			if u, _ := in.Tree.Unit(id); !hasKey(u.SourceKeys) {
				continue
			}
			active, parent := false, false
			for _, m := range months {
				active = active || in.Tree.ActiveAt(id, m)
				parent = parent || len(in.Tree.ChildrenAt(id, m)) > 0
			}
			if active && !parent {
				out = append(out, id)
			}
		}
	}
	for _, it := range in.Items {
		if hasKey(it.SourceKeys) {
			out = append(out, it.ID)
		}
	}
	sort.Strings(out)
	return out
}
