package orgtree

import (
	"sync"
	"testing"

	"github.com/google/go-cmp/cmp"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

func mp(t *testing.T, s string) period.Period {
	t.Helper()
	p, err := period.Parse(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return p
}

func fixture(t *testing.T) ([]domain.OrgUnit, []domain.OrgMove) {
	t.Helper()
	units := []domain.OrgUnit{
		{ID: "co", Name: "Company", LevelID: "l0"},
		{ID: "plat", Name: "Platform", LevelID: "l1", ParentID: "co"},
		{ID: "data", Name: "Data", LevelID: "l1", ParentID: "co"},
		{ID: "ana", Name: "Analytics", LevelID: "l2", ParentID: "data"},
	}
	moves := []domain.OrgMove{
		{UnitID: "ana", NewParentID: "plat", EffectiveMonth: mp(t, "2026-M07")},
	}
	return units, moves
}

func newTree(t *testing.T) *Tree {
	t.Helper()
	u, m := fixture(t)
	tr, err := New(u, m)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return tr
}

func TestParentBeforeAndAfterMove(t *testing.T) {
	tr := newTree(t)
	for _, c := range []struct {
		month, want string
	}{
		{"2026-M01", "data"}, {"2026-M06", "data"}, {"2026-M07", "plat"}, {"2026-M12", "plat"}, {"2027-M01", "plat"},
	} {
		got, ok := tr.ParentAt("ana", mp(t, c.month))
		if !ok || got != c.want {
			t.Errorf("ParentAt(ana,%s) = %q,%v want %q", c.month, got, ok, c.want)
		}
	}
	if p, ok := tr.ParentAt("co", mp(t, "2026-M07")); !ok || p != "" {
		t.Errorf("root parent = %q,%v want \"\",true", p, ok)
	}
}

func TestChildrenAt(t *testing.T) {
	tr := newTree(t)
	m7 := mp(t, "2026-M07")
	if got := tr.ChildrenAt("data", m7); len(got) != 0 {
		t.Errorf("ChildrenAt(data, M07) = %v want empty", got)
	}
	if diff := cmp.Diff([]string{"ana"}, tr.ChildrenAt("plat", m7)); diff != "" {
		t.Errorf("ChildrenAt(plat, M07): %s", diff)
	}
	if diff := cmp.Diff([]string{"ana"}, tr.ChildrenAt("data", mp(t, "2026-M06"))); diff != "" {
		t.Errorf("ChildrenAt(data, M06): %s", diff)
	}
	// Sorted by name: Data before Platform.
	if diff := cmp.Diff([]string{"data", "plat"}, tr.ChildrenAt("co", m7)); diff != "" {
		t.Errorf("ChildrenAt(co): %s", diff)
	}
}

func TestChildrenSortTieBreakByID(t *testing.T) {
	units := []domain.OrgUnit{
		{ID: "r", Name: "Root"},
		{ID: "b", Name: "Same", ParentID: "r"},
		{ID: "a", Name: "Same", ParentID: "r"},
	}
	tr, err := New(units, nil)
	if err != nil {
		t.Fatal(err)
	}
	if diff := cmp.Diff([]string{"a", "b"}, tr.ChildrenAt("r", mp(t, "2026-M01"))); diff != "" {
		t.Error(diff)
	}
}

func TestDescendantsAtPreOrder(t *testing.T) {
	tr := newTree(t)
	if diff := cmp.Diff([]string{"data", "ana", "plat"}, tr.DescendantsAt("co", mp(t, "2026-M06"))); diff != "" {
		t.Errorf("M06: %s", diff)
	}
	if diff := cmp.Diff([]string{"data", "plat", "ana"}, tr.DescendantsAt("co", mp(t, "2026-M07"))); diff != "" {
		t.Errorf("M07: %s", diff)
	}
	if got := tr.DescendantsAt("ana", mp(t, "2026-M07")); len(got) != 0 {
		t.Errorf("leaf descendants = %v", got)
	}
}

func TestRootsAt(t *testing.T) {
	tr := newTree(t)
	if diff := cmp.Diff([]string{"co"}, tr.RootsAt(mp(t, "2026-M07"))); diff != "" {
		t.Error(diff)
	}
}

func TestMoveToRoot(t *testing.T) {
	u, _ := fixture(t)
	moves := []domain.OrgMove{{UnitID: "ana", NewParentID: "", EffectiveMonth: mp(t, "2026-M03")}}
	tr, err := New(u, moves)
	if err != nil {
		t.Fatal(err)
	}
	if diff := cmp.Diff([]string{"ana", "co"}, tr.RootsAt(mp(t, "2026-M03"))); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff([]string{"co"}, tr.RootsAt(mp(t, "2026-M02"))); diff != "" {
		t.Error(diff)
	}
}

func TestMultipleMovesLatestWins(t *testing.T) {
	u, _ := fixture(t)
	moves := []domain.OrgMove{ // deliberately out of order
		{UnitID: "ana", NewParentID: "co", EffectiveMonth: mp(t, "2026-M09")},
		{UnitID: "ana", NewParentID: "plat", EffectiveMonth: mp(t, "2026-M07")},
	}
	tr, err := New(u, moves)
	if err != nil {
		t.Fatal(err)
	}
	for m, want := range map[string]string{"2026-M06": "data", "2026-M08": "plat", "2026-M09": "co", "2027-M01": "co"} {
		if got, _ := tr.ParentAt("ana", mp(t, m)); got != want {
			t.Errorf("ParentAt(%s) = %q want %q", m, got, want)
		}
	}
}

func TestFiscalYearOrdering(t *testing.T) {
	u, _ := fixture(t)
	moves := []domain.OrgMove{{UnitID: "ana", NewParentID: "plat", EffectiveMonth: mp(t, "2027-M02")}}
	tr, _ := New(u, moves)
	if got, _ := tr.ParentAt("ana", mp(t, "2026-M12")); got != "data" {
		t.Errorf("2026-M12 parent = %q", got)
	}
	if got, _ := tr.ParentAt("ana", mp(t, "2027-M02")); got != "plat" {
		t.Errorf("2027-M02 parent = %q", got)
	}
}

func TestRejectsCycle(t *testing.T) {
	u, m := fixture(t)
	m = append(m, domain.OrgMove{UnitID: "co", NewParentID: "ana", EffectiveMonth: mp(t, "2026-M08")})
	if _, err := New(u, m); err == nil {
		t.Fatal("expected cycle error")
	}
}

func TestRejectsMoveIntoDescendant(t *testing.T) {
	u, _ := fixture(t)
	m := []domain.OrgMove{{UnitID: "data", NewParentID: "ana", EffectiveMonth: mp(t, "2026-M05")}}
	if _, err := New(u, m); err == nil {
		t.Fatal("expected error moving a unit under its own descendant")
	}
}

func TestRejectsCycleOnlyAtLaterMonth(t *testing.T) {
	// Individually fine moves that combine into a cycle at M09:
	// M07 ana -> plat; M09 plat -> ana.
	u, m := fixture(t)
	m = append(m, domain.OrgMove{UnitID: "plat", NewParentID: "ana", EffectiveMonth: mp(t, "2026-M09")})
	if _, err := New(u, m); err == nil {
		t.Fatal("expected cycle error at later month")
	}
}

func TestRejectsInitialCycle(t *testing.T) {
	units := []domain.OrgUnit{
		{ID: "a", Name: "A", ParentID: "b"},
		{ID: "b", Name: "B", ParentID: "a"},
	}
	if _, err := New(units, nil); err == nil {
		t.Fatal("expected cycle error")
	}
	if _, err := New([]domain.OrgUnit{{ID: "a", Name: "A", ParentID: "a"}}, nil); err == nil {
		t.Fatal("expected self-parent error")
	}
}

func TestRejectsBadInput(t *testing.T) {
	u, _ := fixture(t)
	cases := map[string]struct {
		units []domain.OrgUnit
		moves []domain.OrgMove
	}{
		"unknown parent": {units: []domain.OrgUnit{{ID: "a", Name: "A", ParentID: "zzz"}}},
		"empty id":       {units: []domain.OrgUnit{{Name: "A"}}},
		"duplicate id":   {units: []domain.OrgUnit{{ID: "a", Name: "A"}, {ID: "a", Name: "B"}}},
		"move unknown unit": {units: u, moves: []domain.OrgMove{
			{UnitID: "nope", NewParentID: "co", EffectiveMonth: mp(t, "2026-M01")}}},
		"move unknown parent": {units: u, moves: []domain.OrgMove{
			{UnitID: "ana", NewParentID: "nope", EffectiveMonth: mp(t, "2026-M01")}}},
		"move non-month grain": {units: u, moves: []domain.OrgMove{
			{UnitID: "ana", NewParentID: "plat", EffectiveMonth: mp(t, "2026-Q3")}}},
		"duplicate move month": {units: u, moves: []domain.OrgMove{
			{UnitID: "ana", NewParentID: "plat", EffectiveMonth: mp(t, "2026-M01")},
			{UnitID: "ana", NewParentID: "co", EffectiveMonth: mp(t, "2026-M01")}}},
		"retired non-month grain": {units: []domain.OrgUnit{
			{ID: "a", Name: "A", RetiredFrom: ptr(mp(t, "2026-FY"))}}},
	}
	for name, c := range cases {
		if _, err := New(c.units, c.moves); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func ptr(p period.Period) *period.Period { return &p }

func retiredTree(t *testing.T) *Tree {
	t.Helper()
	units := []domain.OrgUnit{
		{ID: "co", Name: "Company"},
		{ID: "old", Name: "Old", ParentID: "co", RetiredFrom: ptr(mp(t, "2026-M04"))},
		{ID: "kid", Name: "Kid", ParentID: "old"},
		{ID: "live", Name: "Live", ParentID: "co"},
	}
	tr, err := New(units, nil)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestRetired(t *testing.T) {
	tr := retiredTree(t)
	m3, m4 := mp(t, "2026-M03"), mp(t, "2026-M04")
	if !tr.ActiveAt("old", m3) {
		t.Error("old should be active at M03")
	}
	if tr.ActiveAt("old", m4) {
		t.Error("old should be inactive at M04")
	}
	if tr.ActiveAt("old", mp(t, "2027-M01")) {
		t.Error("old should stay inactive")
	}
	if diff := cmp.Diff([]string{"live", "old"}, tr.ChildrenAt("co", m3)); diff != "" {
		t.Errorf("M03 children: %s", diff)
	}
	if diff := cmp.Diff([]string{"live"}, tr.ChildrenAt("co", m4)); diff != "" {
		t.Errorf("M04 children: %s", diff)
	}
	if diff := cmp.Diff([]string{"live"}, tr.DescendantsAt("co", m4)); diff != "" {
		t.Errorf("M04 descendants: %s", diff)
	}
	if p, ok := tr.ParentAt("old", m4); !ok || p != "co" {
		t.Errorf("ParentAt(retired) = %q,%v want co,true", p, ok)
	}
	// Asked directly, the retired unit still reports its (active) children.
	if diff := cmp.Diff([]string{"kid"}, tr.ChildrenAt("old", m4)); diff != "" {
		t.Errorf("ChildrenAt(retired): %s", diff)
	}
}

func TestRootsExcludeRetired(t *testing.T) {
	units := []domain.OrgUnit{
		{ID: "a", Name: "A", RetiredFrom: ptr(mp(t, "2026-M02"))},
		{ID: "b", Name: "B"},
	}
	tr, err := New(units, nil)
	if err != nil {
		t.Fatal(err)
	}
	if diff := cmp.Diff([]string{"a", "b"}, tr.RootsAt(mp(t, "2026-M01"))); diff != "" {
		t.Error(diff)
	}
	if diff := cmp.Diff([]string{"b"}, tr.RootsAt(mp(t, "2026-M02"))); diff != "" {
		t.Error(diff)
	}
}

func TestUnknownIDs(t *testing.T) {
	tr := newTree(t)
	m := mp(t, "2026-M07")
	if p, ok := tr.ParentAt("nope", m); ok || p != "" {
		t.Errorf("ParentAt unknown = %q,%v", p, ok)
	}
	if got := tr.ChildrenAt("nope", m); got != nil {
		t.Errorf("ChildrenAt unknown = %v", got)
	}
	if got := tr.DescendantsAt("nope", m); got != nil {
		t.Errorf("DescendantsAt unknown = %v", got)
	}
	if tr.ActiveAt("nope", m) {
		t.Error("ActiveAt unknown = true")
	}
	if _, ok := tr.Unit("nope"); ok {
		t.Error("Unit unknown ok")
	}
}

func TestNonMonthQuery(t *testing.T) {
	tr := newTree(t)
	q := mp(t, "2026-Q3")
	if _, ok := tr.ParentAt("ana", q); ok {
		t.Error("ParentAt with quarter should be false")
	}
	if tr.ChildrenAt("co", q) != nil || tr.DescendantsAt("co", q) != nil || tr.RootsAt(q) != nil || tr.ActiveAt("co", q) {
		t.Error("non-month queries should yield nothing")
	}
}

func TestUnit(t *testing.T) {
	tr := newTree(t)
	u, ok := tr.Unit("ana")
	if !ok || u.Name != "Analytics" || u.ParentID != "data" {
		t.Errorf("Unit = %+v,%v", u, ok)
	}
}

func TestNewDoesNotAliasInput(t *testing.T) {
	u, m := fixture(t)
	tr, err := New(u, m)
	if err != nil {
		t.Fatal(err)
	}
	u[3].ParentID = "co"
	m[0].NewParentID = "co"
	if got, _ := tr.ParentAt("ana", mp(t, "2026-M08")); got != "plat" {
		t.Errorf("tree mutated by caller: %q", got)
	}
}

func TestConcurrentReads(t *testing.T) {
	tr := newTree(t)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				m := mp(t, "2026-M07")
				tr.ChildrenAt("co", m)
				tr.DescendantsAt("co", m)
				tr.RootsAt(m)
				tr.ParentAt("ana", m)
				tr.ActiveAt("ana", m)
			}
		}()
	}
	wg.Wait()
}

func TestUnitIDsSortedAndIncludesRetired(t *testing.T) {
	gone := mp(t, "2026-M03")
	tr, err := New([]domain.OrgUnit{
		{ID: "b", Name: "B"},
		{ID: "a", Name: "A", ParentID: "b", RetiredFrom: &gone},
		{ID: "c", Name: "C"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := tr.UnitIDs()
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("UnitIDs = %v, want [a b c]", got)
	}
}
