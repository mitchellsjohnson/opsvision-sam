// Package orgtree answers "as of month M" questions about a tenant's org
// hierarchy. Units may be reparented effective from a month, and may be
// retired from a month, so the same unit can roll up to different parents in
// different months.
//
// A Tree is immutable after New and safe for concurrent use.
package orgtree

import (
	"fmt"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// move is a validated reparenting, keyed by its month ordinal.
type move struct {
	key    int // monthKey of the effective month
	parent string
}

// Tree is an effective-dated org hierarchy.
type Tree struct {
	units map[string]domain.OrgUnit
	// moves holds each unit's reparentings sorted by effective month.
	moves map[string][]move
	// retiredKey is the month ordinal from which a unit is inactive.
	retiredKey map[string]int
	// candidates maps a parent ID ("" for roots) to every unit that has that
	// parent at some month, sorted by (Name, ID). Per-month queries filter it.
	candidates map[string][]string
}

// monthKey orders Month-grain periods by (FY, Index).
func monthKey(p period.Period) int { return p.FY*12 + (p.Index - 1) }

// isMonth reports whether p is a well-formed Month-grain period.
func isMonth(p period.Period) bool {
	return p.Grain == period.Month && p.Index >= 1 && p.Index <= 12
}

// initialKey sorts before every real month; it selects the pre-move state.
const initialKey = -1 << 62

// New builds a Tree. It returns an error for duplicate or empty unit IDs,
// unknown parents or move targets, non-Month effective/retirement periods,
// two moves of one unit in the same month, and any cycle (including a move
// into the unit's own descendant) at the initial state or at any month in
// which a move takes effect.
//
// A unit's parent at month M is the NewParentID of its latest move with
// EffectiveMonth <= M, otherwise OrgUnit.ParentID. An empty parent means root.
// The inputs are copied; later mutation by the caller does not affect the Tree.
func New(units []domain.OrgUnit, moves []domain.OrgMove) (*Tree, error) {
	t := &Tree{
		units:      make(map[string]domain.OrgUnit, len(units)),
		moves:      make(map[string][]move),
		retiredKey: make(map[string]int),
		candidates: make(map[string][]string),
	}
	for _, u := range units {
		if u.ID == "" {
			return nil, fmt.Errorf("orgtree: unit %q has empty id", u.Name)
		}
		if _, dup := t.units[u.ID]; dup {
			return nil, fmt.Errorf("orgtree: duplicate unit id %q", u.ID)
		}
		u.SourceKeys = append([]string(nil), u.SourceKeys...)
		if u.RetiredFrom != nil {
			r := *u.RetiredFrom
			if !isMonth(r) {
				return nil, fmt.Errorf("orgtree: unit %q: RetiredFrom %s is not a month", u.ID, r)
			}
			u.RetiredFrom = &r
			t.retiredKey[u.ID] = monthKey(r)
		}
		t.units[u.ID] = u
	}
	for _, u := range units {
		if u.ParentID != "" {
			if _, ok := t.units[u.ParentID]; !ok {
				return nil, fmt.Errorf("orgtree: unit %q: unknown parent %q", u.ID, u.ParentID)
			}
		}
	}

	monthSet := map[int]bool{initialKey: true}
	for _, m := range moves {
		if _, ok := t.units[m.UnitID]; !ok {
			return nil, fmt.Errorf("orgtree: move of unknown unit %q", m.UnitID)
		}
		if m.NewParentID != "" {
			if _, ok := t.units[m.NewParentID]; !ok {
				return nil, fmt.Errorf("orgtree: move of %q: unknown parent %q", m.UnitID, m.NewParentID)
			}
		}
		if !isMonth(m.EffectiveMonth) {
			return nil, fmt.Errorf("orgtree: move of %q: effective month %s is not a month", m.UnitID, m.EffectiveMonth)
		}
		k := monthKey(m.EffectiveMonth)
		for _, prev := range t.moves[m.UnitID] {
			if prev.key == k {
				return nil, fmt.Errorf("orgtree: unit %q has two moves effective %s", m.UnitID, m.EffectiveMonth)
			}
		}
		t.moves[m.UnitID] = append(t.moves[m.UnitID], move{key: k, parent: m.NewParentID})
		monthSet[k] = true
	}
	for id := range t.moves {
		ms := t.moves[id]
		sort.Slice(ms, func(i, j int) bool { return ms[i].key < ms[j].key })
	}

	// Validate acyclicity at the initial state and at every month in which
	// the tree changes. Between those months the tree is constant.
	keys := make([]int, 0, len(monthSet))
	for k := range monthSet {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, k := range keys {
		for id := range t.units {
			if err := t.checkAcyclic(id, k); err != nil {
				return nil, err
			}
		}
	}

	// Index every (parent -> child) relationship that ever exists.
	seen := make(map[[2]string]bool)
	for id, u := range t.units {
		add := func(parent string) {
			if !seen[[2]string{parent, id}] {
				seen[[2]string{parent, id}] = true
				t.candidates[parent] = append(t.candidates[parent], id)
			}
		}
		add(u.ParentID)
		for _, m := range t.moves[id] {
			add(m.parent)
		}
	}
	for p := range t.candidates {
		t.sortByName(t.candidates[p])
	}
	return t, nil
}

// checkAcyclic walks up from id at month key k and fails if it revisits a unit.
func (t *Tree) checkAcyclic(id string, k int) error {
	cur := id
	for steps := 0; steps <= len(t.units); steps++ {
		p := t.parentAtKey(cur, k)
		if p == "" {
			return nil
		}
		if p == id {
			return fmt.Errorf("orgtree: cycle through unit %q%s", id, atDesc(k))
		}
		cur = p
	}
	return fmt.Errorf("orgtree: cycle above unit %q%s", id, atDesc(k))
}

func atDesc(k int) string {
	if k == initialKey {
		return " in the initial hierarchy"
	}
	return fmt.Sprintf(" at %s", period.Period{Grain: period.Month, FY: floorDiv(k, 12), Index: k - floorDiv(k, 12)*12 + 1})
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// parentAtKey returns the parent of a known unit at month key k.
func (t *Tree) parentAtKey(id string, k int) string {
	ms := t.moves[id]
	// First move strictly after k; the one before it (if any) is in effect.
	i := sort.Search(len(ms), func(i int) bool { return ms[i].key > k })
	if i == 0 {
		return t.units[id].ParentID
	}
	return ms[i-1].parent
}

func (t *Tree) sortByName(ids []string) {
	sort.Slice(ids, func(i, j int) bool {
		a, b := t.units[ids[i]], t.units[ids[j]]
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ID < b.ID
	})
}

func (t *Tree) activeAtKey(id string, k int) bool {
	if _, ok := t.units[id]; !ok {
		return false
	}
	r, retired := t.retiredKey[id]
	return !retired || k < r
}

// Unit returns a copy of the unit with the given ID. OrgUnit.ParentID is the
// parent before any move; use ParentAt for the effective parent.
func (t *Tree) Unit(id string) (domain.OrgUnit, bool) {
	u, ok := t.units[id]
	if !ok {
		return domain.OrgUnit{}, false
	}
	u.SourceKeys = append([]string(nil), u.SourceKeys...)
	if u.RetiredFrom != nil {
		r := *u.RetiredFrom
		u.RetiredFrom = &r
	}
	return u, true
}

// ParentAt returns the parent of unitID at month ("" for a root). The bool is
// false if the unit is unknown or month is not a Month-grain period. ParentAt
// still answers for a retired unit (it returns the parent the unit had).
func (t *Tree) ParentAt(unitID string, month period.Period) (string, bool) {
	if _, ok := t.units[unitID]; !ok || !isMonth(month) {
		return "", false
	}
	return t.parentAtKey(unitID, monthKey(month)), true
}

// ActiveAt reports whether the unit exists and is not retired at month
// (RetiredFrom <= month means inactive). Unknown units and non-Month periods
// yield false.
func (t *Tree) ActiveAt(unitID string, month period.Period) bool {
	if !isMonth(month) {
		return false
	}
	return t.activeAtKey(unitID, monthKey(month))
}

// ChildrenAt returns the active direct children of unitID at month, sorted by
// name (ties by ID). It returns nil for an unknown unit or non-Month period.
// Asking about a retired unit still lists its active children; retired units
// never appear as children.
func (t *Tree) ChildrenAt(unitID string, month period.Period) []string {
	if _, ok := t.units[unitID]; !ok || !isMonth(month) {
		return nil
	}
	return t.childrenAtKey(unitID, monthKey(month))
}

func (t *Tree) childrenAtKey(parent string, k int) []string {
	var out []string
	for _, c := range t.candidates[parent] {
		if t.activeAtKey(c, k) && t.parentAtKey(c, k) == parent {
			out = append(out, c)
		}
	}
	return out
}

// DescendantsAt returns all active descendants of unitID at month in
// depth-first pre-order, visiting children in ChildrenAt order. It returns nil
// for an unknown unit or non-Month period. A retired unit does not
// contribute its subtree when reached as a descendant.
func (t *Tree) DescendantsAt(unitID string, month period.Period) []string {
	if _, ok := t.units[unitID]; !ok || !isMonth(month) {
		return nil
	}
	k := monthKey(month)
	var out []string
	var walk func(id string)
	walk = func(id string) {
		for _, c := range t.childrenAtKey(id, k) {
			out = append(out, c)
			walk(c)
		}
	}
	walk(unitID)
	return out
}

// RootsAt returns the active units with no parent at month, sorted by name.
// It returns nil for a non-Month period.
func (t *Tree) RootsAt(month period.Period) []string {
	if !isMonth(month) {
		return nil
	}
	return t.childrenAtKey("", monthKey(month))
}
