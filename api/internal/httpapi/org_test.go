package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Wire shapes used by the tests (the generated types would also work; these
// keep the tests independent of pointer-heavy generated fields).
type unitJSON struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	LevelID     string   `json:"levelId"`
	ParentID    string   `json:"parentId"`
	SourceKeys  []string `json:"sourceKeys"`
	RetiredFrom *string  `json:"retiredFrom"`
}

type treeNodeJSON struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	LevelID  string         `json:"levelId"`
	Children []treeNodeJSON `json:"children"`
}

type treeJSON struct {
	Month string         `json:"month"`
	Roots []treeNodeJSON `json:"roots"`
}

// seedOrg gives tenant t1 three levels and a small hierarchy:
//
//	acme (Company)
//	  seg-a (Segment)
//	    prod-1 (Product)
//	  seg-b (Segment)
func seedOrg(t *testing.T, e *testEnv) {
	t.Helper()
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "company", "name": "Company", "depth": 0},
		{"id": "segment", "name": "Segment", "depth": 1},
		{"id": "product", "name": "Product", "depth": 2},
	}}, nil)
	for _, u := range []unitJSON{
		{ID: "acme", Name: "Acme", LevelID: "company", ParentID: ""},
		{ID: "seg-a", Name: "Segment A", LevelID: "segment", ParentID: "acme"},
		{ID: "seg-b", Name: "Segment B", LevelID: "segment", ParentID: "acme"},
		{ID: "prod-1", Name: "Product One", LevelID: "product", ParentID: "seg-a"},
	} {
		u.SourceKeys = []string{}
		e.expect(t, 201, admin, "POST", "/org/units", u, nil)
	}
}

func childIDs(n treeNodeJSON) []string {
	ids := []string{}
	for _, c := range n.Children {
		ids = append(ids, c.ID)
	}
	return ids
}

// findNode returns the node with the given ID anywhere in the tree.
func findNode(roots []treeNodeJSON, id string) (treeNodeJSON, bool) {
	for _, n := range roots {
		if n.ID == id {
			return n, true
		}
		if got, ok := findNode(n.Children, id); ok {
			return got, true
		}
	}
	return treeNodeJSON{}, false
}

func TestOrgUnitsCRUDAndMove(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	var levels struct{ Levels []struct{ ID string } }
	e.expect(t, 200, admin, "GET", "/org/levels", nil, &levels)
	if len(levels.Levels) != 3 || levels.Levels[0].ID != "company" || levels.Levels[2].ID != "product" {
		t.Fatalf("levels = %+v", levels)
	}

	var units struct{ Units []unitJSON }
	e.expect(t, 200, admin, "GET", "/org/units", nil, &units)
	if len(units.Units) != 4 {
		t.Fatalf("units = %+v", units)
	}

	// Rename and re-key.
	var renamed unitJSON
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{
		"name": "Segment Alpha", "sourceKeys": []string{"SEG-A", "alpha"},
	}, &renamed)
	if renamed.Name != "Segment Alpha" || len(renamed.SourceKeys) != 2 || renamed.ParentID != "acme" {
		t.Fatalf("renamed = %+v", renamed)
	}

	// Move prod-1 from seg-a to seg-b, effective 2026-M07.
	var mv struct {
		UnitID, NewParentID, EffectiveMonth, Note string
	}
	e.expect(t, 201, admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "seg-b", "effectiveMonth": "2026-M07", "note": "re-org",
	}, &mv)
	if mv.UnitID != "prod-1" || mv.NewParentID != "seg-b" || mv.EffectiveMonth != "2026-M07" || mv.Note != "re-org" {
		t.Fatalf("move = %+v", mv)
	}

	check := func(month, wantParent string) {
		t.Helper()
		var tree treeJSON
		e.expect(t, 200, admin, "GET", "/org/tree?month="+month, nil, &tree)
		if tree.Month != month {
			t.Fatalf("tree month = %q, want %q", tree.Month, month)
		}
		if len(tree.Roots) != 1 || tree.Roots[0].ID != "acme" {
			t.Fatalf("roots = %+v", tree.Roots)
		}
		parent, ok := findNode(tree.Roots, wantParent)
		if !ok {
			t.Fatalf("%s: parent %s missing", month, wantParent)
		}
		if got := childIDs(parent); len(got) != 1 || got[0] != "prod-1" {
			t.Fatalf("%s: %s children = %v, want [prod-1]", month, wantParent, got)
		}
		other := "seg-b"
		if wantParent == "seg-b" {
			other = "seg-a"
		}
		if n, _ := findNode(tree.Roots, other); len(n.Children) != 0 {
			t.Fatalf("%s: %s children = %v, want none", month, other, childIDs(n))
		}
	}
	check("2026-M06", "seg-a")
	check("2026-M07", "seg-b")

	// With no month the tree is for the current month (2026-M10 on the test
	// clock), after the move.
	var cur treeJSON
	e.expect(t, 200, admin, "GET", "/org/tree", nil, &cur)
	if cur.Month != "2026-M10" {
		t.Fatalf("default month = %q, want 2026-M10", cur.Month)
	}
	if n, _ := findNode(cur.Roots, "seg-b"); len(childIDs(n)) != 1 {
		t.Fatalf("default tree: seg-b children = %v", childIDs(n))
	}

	// A move on the same unit and month is a conflict.
	e.expectError(t, 409, "conflict", admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "seg-a", "effectiveMonth": "2026-M07",
	})
}

func TestMoveIntoDescendantRejected(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	// seg-a cannot move under its own descendant prod-1.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/seg-a/moves", map[string]any{
		"newParentId": "prod-1", "effectiveMonth": "2026-M07",
	})
	// Nor under itself.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/seg-a/moves", map[string]any{
		"newParentId": "seg-a", "effectiveMonth": "2026-M07",
	})
	// Nothing was recorded.
	moves, err := e.store.ListOrgMoves(context.Background(), "t1")
	if err != nil || len(moves) != 0 {
		t.Fatalf("moves = %+v, err %v; want none", moves, err)
	}
}

func TestMoveParentRules(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	e.expect(t, 200, admin, "PATCH", "/org/units/seg-b", map[string]any{"retiredFrom": "2026-M05"}, nil)

	// Unknown new parent.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "nowhere", "effectiveMonth": "2026-M07",
	})
	// New parent retired at the effective month.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "seg-b", "effectiveMonth": "2026-M07",
	})
	// New parent active at the effective month but retired before the unit
	// would leave it: the unit would still be a child at the retirement.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "seg-b", "effectiveMonth": "2026-M04",
	})
	// Not a month.
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/prod-1/moves", map[string]any{
		"newParentId": "seg-a", "effectiveMonth": "2026-Q3",
	})
	// Unknown unit.
	e.expectError(t, 404, "not_found", admin, "POST", "/org/units/ghost/moves", map[string]any{
		"newParentId": "seg-a", "effectiveMonth": "2026-M07",
	})
}

func TestRetireRules(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	// seg-a still has an active child in 2026-M08.
	got := e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-a", map[string]any{"retiredFrom": "2026-M08"})
	if got.Error.Message != "move or retire child units first" {
		t.Fatalf("message = %q", got.Error.Message)
	}
	// Retire the child first, then the parent in the same month: the child
	// is already inactive then.
	e.expect(t, 200, admin, "PATCH", "/org/units/prod-1", map[string]any{"retiredFrom": "2026-M08"}, nil)
	var seg unitJSON
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"retiredFrom": "2026-M08"}, &seg)
	if seg.RetiredFrom == nil || *seg.RetiredFrom != "2026-M08" {
		t.Fatalf("retiredFrom = %v", seg.RetiredFrom)
	}

	var before, after treeJSON
	e.expect(t, 200, admin, "GET", "/org/tree?month=2026-M07", nil, &before)
	e.expect(t, 200, admin, "GET", "/org/tree?month=2026-M08", nil, &after)
	if _, ok := findNode(before.Roots, "prod-1"); !ok {
		t.Error("prod-1 missing from 2026-M07")
	}
	if _, ok := findNode(after.Roots, "seg-a"); ok {
		t.Error("seg-a still present in 2026-M08")
	}

	// A retirement month that is not a month is invalid.
	e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"retiredFrom": "2026-FY"})
	// An empty patch is invalid.
	e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{})
	// A retirement that would strand a child that moves in later is invalid:
	// prod-2 moves under seg-b effective M09, so seg-b cannot retire in M08.
	e.expect(t, 201, admin, "POST", "/org/units", unitJSON{ID: "prod-2", Name: "Product Two", LevelID: "product", ParentID: "acme", SourceKeys: []string{}}, nil)
	e.expect(t, 201, admin, "POST", "/org/units/prod-2/moves", map[string]any{"newParentId": "seg-b", "effectiveMonth": "2026-M09"}, nil)
	e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"retiredFrom": "2026-M08"})
}

func TestOrgUnitValidation(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	base := func() unitJSON {
		return unitJSON{ID: "new-unit", Name: "New", LevelID: "segment", ParentID: "acme", SourceKeys: []string{}}
	}

	for name, mutate := range map[string]func(*unitJSON){
		"bad id":         func(u *unitJSON) { u.ID = "bad id!" },
		"id too long":    func(u *unitJSON) { u.ID = strings.Repeat("x", 65) },
		"empty name":     func(u *unitJSON) { u.Name = "  " },
		"unknown level":  func(u *unitJSON) { u.LevelID = "galaxy" },
		"bad level id":   func(u *unitJSON) { u.LevelID = "bad level" },
		"unknown parent": func(u *unitJSON) { u.ParentID = "nowhere" },
		"bad parent id":  func(u *unitJSON) { u.ParentID = "a#b" },
		"self parent":    func(u *unitJSON) { u.ParentID = u.ID },
		"retired quarter": func(u *unitJSON) {
			q := "2026-Q3"
			u.RetiredFrom = &q
		},
	} {
		u := base()
		mutate(&u)
		got := e.expectError(t, 400, "invalid", admin, "POST", "/org/units", u)
		if name != "self parent" && len(got.Error.Details) == 0 {
			t.Errorf("%s: no details in %+v", name, got)
		}
	}

	e.expect(t, 201, admin, "POST", "/org/units", base(), nil)
	e.expectError(t, 409, "conflict", admin, "POST", "/org/units", base())

	// A parent retired in the past cannot take new children.
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-b", map[string]any{"retiredFrom": "2026-M01"}, nil)
	u := base()
	u.ID = "late"
	u.LevelID = "product"
	u.ParentID = "seg-b"
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units", u)

	// Malformed ID in the path.
	e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/bad!id", map[string]any{"name": "x"})
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units/bad!id/moves", map[string]any{"newParentId": "acme", "effectiveMonth": "2026-M07"})
	// Bad month in the tree query.
	e.expectError(t, 400, "invalid", admin, "GET", "/org/tree?month=2026-Q3", nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/org/tree?month=garbage", nil)
}

func TestPutOrgLevelsRules(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "a", "name": "A", "depth": 0}, {"id": "a", "name": "A2", "depth": 1},
	}})
	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "bad id", "name": "A", "depth": 0},
	}})
	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "a", "name": "", "depth": 0},
	}})
	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "a", "name": "A", "depth": -1},
	}})
	// Dropping a level that units use is a conflict.
	e.expectError(t, 409, "conflict", admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "company", "name": "Company", "depth": 0},
		{"id": "segment", "name": "Segment", "depth": 1},
	}})
	// Renaming is fine.
	var out struct{ Levels []struct{ ID, Name string } }
	e.expect(t, 200, admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "company", "name": "Firm", "depth": 0},
		{"id": "segment", "name": "Segment", "depth": 1},
		{"id": "product", "name": "Product", "depth": 2},
	}}, &out)
	if out.Levels[0].Name != "Firm" {
		t.Fatalf("levels = %+v", out)
	}
}

func TestCrossTenantOrgUnit(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	t2 := e.tokens["t2-admin"]

	e.expectError(t, 404, "not_found", t2, "PATCH", "/org/units/seg-a", map[string]any{"name": "Hijacked"})
	e.expectError(t, 404, "not_found", t2, "POST", "/org/units/seg-a/moves", map[string]any{"newParentId": "acme", "effectiveMonth": "2026-M07"})

	var units struct{ Units []unitJSON }
	e.expect(t, 200, t2, "GET", "/org/units", nil, &units)
	if len(units.Units) != 0 {
		t.Fatalf("t2 sees units: %+v", units.Units)
	}
	var tree treeJSON
	e.expect(t, 200, t2, "GET", "/org/tree?month=2026-M10", nil, &tree)
	if len(tree.Roots) != 0 {
		t.Fatalf("t2 sees tree: %+v", tree.Roots)
	}
	// t2 can reuse an ID t1 uses without a conflict.
	e.expect(t, 200, t2, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{{"id": "company", "name": "Company", "depth": 0}}}, nil)
	e.expect(t, 201, t2, "POST", "/org/units", unitJSON{ID: "acme", Name: "Other Acme", LevelID: "company", SourceKeys: []string{}}, nil)

	// t1's unit is untouched.
	var t1 struct{ Units []unitJSON }
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/org/units", nil, &t1)
	for _, u := range t1.Units {
		if u.ID == "seg-a" && u.Name != "Segment A" {
			t.Fatalf("seg-a renamed: %+v", u)
		}
		if u.ID == "acme" && u.Name != "Acme" {
			t.Fatalf("acme overwritten: %+v", u)
		}
	}
}

func TestOrgWritesAdminOnly(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	for _, role := range []string{"t1-contributor", "t1-viewer"} {
		tok := e.tokens[role]
		e.expectError(t, 403, "forbidden", tok, "PUT", "/org/levels", map[string]any{"levels": []any{}})
		e.expectError(t, 403, "forbidden", tok, "POST", "/org/units", unitJSON{ID: "x", Name: "X", LevelID: "company", SourceKeys: []string{}})
		e.expectError(t, 403, "forbidden", tok, "PATCH", "/org/units/seg-a", map[string]any{"name": "x"})
		e.expectError(t, 403, "forbidden", tok, "POST", "/org/units/seg-a/moves", map[string]any{"newParentId": "seg-b", "effectiveMonth": "2026-M07"})
		// Reads are open to every member.
		e.expect(t, 200, tok, "GET", "/org/units", nil, nil)
		e.expect(t, 200, tok, "GET", "/org/levels", nil, nil)
		e.expect(t, 200, tok, "GET", "/org/tree", nil, nil)
	}
	// An operator without an organization has no tenant access.
	op := e.tokens["operator"]
	e.expectError(t, 403, "forbidden", op, "GET", "/org/units", nil)
	e.expectError(t, 403, "forbidden", op, "POST", "/org/units", unitJSON{ID: "x", Name: "X", LevelID: "company", SourceKeys: []string{}})
	// No token at all.
	e.expectError(t, 401, "unauthorized", "", "GET", "/org/units", nil)
}

func TestOrgListsNeverNull(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	for path, want := range map[string]string{
		"/org/levels":              `{"levels":[]}`,
		"/org/units":               `{"units":[]}`,
		"/org/tree?month=2026-M10": `{"month":"2026-M10","roots":[]}`,
	} {
		_, raw := e.call(t, admin, "GET", path, nil)
		if got := strings.TrimSpace(string(raw)); got != want {
			t.Errorf("GET %s = %s, want %s", path, got, want)
		}
	}
	// A unit created without sourceKeys reads back with [].
	e.expect(t, 200, admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{{"id": "company", "name": "Company", "depth": 0}}}, nil)
	_, raw := e.call(t, admin, "POST", "/org/units", `{"id":"acme","name":"Acme","levelId":"company","parentId":""}`)
	if !strings.Contains(string(raw), `"sourceKeys":[]`) {
		t.Errorf("created unit = %s, want sourceKeys []", raw)
	}
}

func TestAuditOnWrite(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{
		{"id": "company", "name": "Company", "depth": 0}, {"id": "segment", "name": "Segment", "depth": 1},
	}}, nil)
	e.expect(t, 201, admin, "POST", "/org/units", unitJSON{ID: "acme", Name: "Acme", LevelID: "company", SourceKeys: []string{}}, nil)
	e.expect(t, 201, admin, "POST", "/org/units", unitJSON{ID: "seg-a", Name: "Seg A", LevelID: "segment", ParentID: "acme", SourceKeys: []string{}}, nil)
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"name": "Seg Alpha"}, nil)
	e.expect(t, 201, admin, "POST", "/org/units/seg-a/moves", map[string]any{"newParentId": "acme", "effectiveMonth": "2026-M07"}, nil)

	byAction := map[string][]int{}
	entries := e.audits(t, "t1")
	for i, en := range entries {
		byAction[en.Action] = append(byAction[en.Action], i)
	}
	for _, a := range []string{"org_levels.replace", "org_unit.create", "org_unit.update", "org_unit.move"} {
		if len(byAction[a]) == 0 {
			t.Fatalf("no %s entry in %+v", a, byAction)
		}
	}

	create := entries[byAction["org_unit.create"][0]]
	if create.ActorID != "u-t1-admin" || create.Channel != "ui" || create.TargetType != "org_unit" || create.TargetID != "acme" {
		t.Fatalf("create entry = %+v", create)
	}
	if len(create.Before) != 0 && string(create.Before) != "null" {
		t.Fatalf("create before = %s, want null", create.Before)
	}
	var after unitJSON
	if err := json.Unmarshal(create.After, &after); err != nil || after.ID != "acme" || after.Name != "Acme" {
		t.Fatalf("create after = %s (%v)", create.After, err)
	}
	if !create.At.Equal(testNow) || create.ID == "" {
		t.Fatalf("create at/id = %v / %q", create.At, create.ID)
	}

	upd := entries[byAction["org_unit.update"][0]]
	var b, a unitJSON
	if json.Unmarshal(upd.Before, &b) != nil || json.Unmarshal(upd.After, &a) != nil || b.Name != "Seg A" || a.Name != "Seg Alpha" {
		t.Fatalf("update before/after = %s / %s", upd.Before, upd.After)
	}
	if mv := entries[byAction["org_unit.move"][0]]; mv.TargetID != "seg-a" {
		t.Fatalf("move entry = %+v", mv)
	}

	// Rejected writes leave no audit entry, and t2 has none of t1's.
	n := len(entries)
	e.expectError(t, 400, "invalid", admin, "POST", "/org/units", unitJSON{ID: "bad id", Name: "x", LevelID: "company", SourceKeys: []string{}})
	if got := len(e.audits(t, "t1")); got != n {
		t.Fatalf("rejected write added audit entries: %d -> %d", n, got)
	}
	if got := len(e.audits(t, "t2")); got != 0 {
		t.Fatalf("t2 audit entries = %d", got)
	}
}

func TestHierarchyDepthRules(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	unit := func(id, level, parent string) unitJSON {
		return unitJSON{ID: id, Name: id, LevelID: level, ParentID: parent, SourceKeys: []string{}}
	}
	depthErr := func(path string, got apiErrorBody) {
		t.Helper()
		for _, d := range got.Error.Details {
			if d.Path == path {
				return
			}
		}
		t.Fatalf("no detail at %q in %+v", path, got.Error.Details)
	}

	// Create: the level must be strictly deeper than the parent's.
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "POST", "/org/units", unit("same", "segment", "seg-a")))
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "POST", "/org/units", unit("up", "company", "seg-a")))
	// A deeper level may skip tiers (product directly under company).
	e.expect(t, 201, admin, "POST", "/org/units", unit("skip", "product", "acme"), nil)
	// Root units may sit at any level.
	e.expect(t, 201, admin, "POST", "/org/units", unit("root-product", "product", ""), nil)
	e.expect(t, 201, admin, "POST", "/org/units", unit("root-segment", "segment", ""), nil)

	// Moves: the unit must be deeper than its new parent.
	for _, mv := range []struct{ unit, parent string }{
		{"prod-1", "skip"},        // product under product
		{"seg-b", "root-product"}, // segment under product
		{"seg-b", "seg-a"},        // segment under segment
		{"acme", "root-segment"},  // company under segment
	} {
		got := e.expectError(t, 400, "invalid", admin, "POST", "/org/units/"+mv.unit+"/moves", map[string]any{
			"newParentId": mv.parent, "effectiveMonth": "2026-M07",
		})
		depthErr("newParentId", got)
	}
	e.expect(t, 201, admin, "POST", "/org/units/prod-1/moves", map[string]any{"newParentId": "seg-b", "effectiveMonth": "2026-M07"}, nil)
	e.expect(t, 201, admin, "POST", "/org/units/seg-b/moves", map[string]any{"newParentId": "acme", "effectiveMonth": "2026-M08"}, nil)

	// PATCH levelId: against the parent and against children.
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-a", map[string]any{"levelId": "company"})) // not deeper than acme
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/acme", map[string]any{"levelId": "segment"}))  // seg-a is no deeper
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"levelId": "product"})) // prod-1 (moved under seg-b) is no deeper
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-a", map[string]any{"levelId": "nowhere"})) // unknown level
	var got unitJSON
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"levelId": "segment", "name": "Segment A2"}, &got)
	if got.LevelID != "segment" || got.Name != "Segment A2" {
		t.Fatalf("patched = %+v", got)
	}
	// Historical parents count: prod-1 was created under seg-a, so seg-a
	// cannot drop to prod-1's level even though prod-1 has moved away.
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-a", map[string]any{"levelId": "product"}))
	// A unit with no relations can change level within the rules.
	e.expect(t, 200, admin, "PATCH", "/org/units/skip", map[string]any{"levelId": "segment"}, &got)
	if got.LevelID != "segment" {
		t.Fatalf("patched = %+v", got)
	}
	depthErr("levelId", e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/skip", map[string]any{"levelId": "company"}))
}

func TestPutOrgLevelsDepthRules(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	lv := func(depths ...int) map[string]any {
		ids := []string{"company", "segment", "product"}
		var ls []map[string]any
		for i, d := range depths {
			ls = append(ls, map[string]any{"id": ids[i], "name": ids[i], "depth": d})
		}
		return map[string]any{"levels": ls}
	}
	// Duplicate depth values.
	got := e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", lv(0, 1, 1))
	if len(got.Error.Details) == 0 || got.Error.Details[0].Path != "levels[2].depth" {
		t.Fatalf("details = %+v", got.Error.Details)
	}
	// Changes that invalidate existing units: segment deeper than product
	// puts prod-1 (product) under seg-a (segment) the wrong way round.
	got = e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", lv(0, 3, 2))
	if len(got.Error.Details) == 0 {
		t.Fatalf("no details: %+v", got)
	}
	// Flattening depths below a parent likewise.
	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", lv(5, 1, 2))
	// Order-preserving changes are fine, and nothing was stored by the failures.
	var out struct {
		Levels []struct {
			ID    string
			Depth int
		}
	}
	e.expect(t, 200, admin, "PUT", "/org/levels", lv(0, 10, 20), &out)
	if len(out.Levels) != 3 || out.Levels[2].Depth != 20 {
		t.Fatalf("levels = %+v", out)
	}
	// Moves count too: a move that is valid today constrains later changes.
	e.expect(t, 201, admin, "POST", "/org/units/prod-1/moves", map[string]any{"newParentId": "seg-b", "effectiveMonth": "2026-M07"}, nil)
	e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", lv(0, 25, 20))
}
