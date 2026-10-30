package httpapi

import (
	"strings"
	"testing"
)

type itemJSON struct {
	ID         string   `json:"id"`
	KindID     string   `json:"kindId"`
	Name       string   `json:"name"`
	OrgUnitID  string   `json:"orgUnitId"`
	SourceKeys []string `json:"sourceKeys"`
}

func seedKinds(t *testing.T, e *testEnv) {
	t.Helper()
	admin := e.tokens["t1-admin"]
	e.expect(t, 201, admin, "POST", "/item-kinds", map[string]any{"id": "app", "name": "Application"}, nil)
	e.expect(t, 201, admin, "POST", "/item-kinds", map[string]any{"id": "svc", "name": "Service"}, nil)
}

func TestItemKindsAndItemsCRUD(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	seedKinds(t, e)
	admin := e.tokens["t1-admin"]

	var kinds struct{ ItemKinds []struct{ ID, Name string } }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/item-kinds", nil, &kinds)
	if len(kinds.ItemKinds) != 2 || kinds.ItemKinds[0].ID != "app" {
		t.Fatalf("kinds = %+v", kinds)
	}
	e.expectError(t, 409, "conflict", admin, "POST", "/item-kinds", map[string]any{"id": "app", "name": "Again"})

	var it itemJSON
	e.expect(t, 201, admin, "POST", "/items", map[string]any{
		"id": "shop", "kindId": "app", "name": "Shop", "orgUnitId": "prod-1", "sourceKeys": []string{"shop-web"},
	}, &it)
	if it.ID != "shop" || it.OrgUnitID != "prod-1" || len(it.SourceKeys) != 1 {
		t.Fatalf("item = %+v", it)
	}
	e.expect(t, 201, admin, "POST", "/items", map[string]any{"id": "pay", "kindId": "svc", "name": "Pay", "orgUnitId": "", "sourceKeys": []string{}}, nil)
	e.expectError(t, 409, "conflict", admin, "POST", "/items", map[string]any{"id": "pay", "kindId": "svc", "name": "Pay", "orgUnitId": "", "sourceKeys": []string{}})

	var list struct{ Items []itemJSON }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/items", nil, &list)
	if len(list.Items) != 2 {
		t.Fatalf("items = %+v", list)
	}
	e.expect(t, 200, admin, "GET", "/items?kind=svc", nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != "pay" {
		t.Fatalf("kind filter = %+v", list)
	}
	e.expect(t, 200, admin, "GET", "/items?kind=none", nil, &list)
	if list.Items == nil || len(list.Items) != 0 {
		t.Fatalf("empty filter = %#v", list.Items)
	}
	e.expectError(t, 400, "invalid", admin, "GET", "/items?kind=bad!id", nil)

	e.expect(t, 200, admin, "PATCH", "/items/shop", map[string]any{"name": "Shop Web", "orgUnitId": ""}, &it)
	if it.Name != "Shop Web" || it.OrgUnitID != "" || it.KindID != "app" || len(it.SourceKeys) != 1 {
		t.Fatalf("updated = %+v", it)
	}
	e.expectError(t, 404, "not_found", admin, "PATCH", "/items/ghost", map[string]any{"name": "x"})
	e.expectError(t, 404, "not_found", e.tokens["t2-admin"], "PATCH", "/items/shop", map[string]any{"name": "x"})

	// Audit entries.
	var actions []string
	for _, en := range e.audits(t, "t1") {
		if strings.HasPrefix(en.Action, "item") {
			actions = append(actions, en.Action)
		}
	}
	if got := strings.Join(actions, ","); !strings.Contains(got, "item_kind.create") || !strings.Contains(got, "item.create") || !strings.Contains(got, "item.update") {
		t.Fatalf("item audit actions = %s", got)
	}
}

func TestItemValidationAndAuthz(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	seedKinds(t, e)
	admin := e.tokens["t1-admin"]
	base := func() map[string]any {
		return map[string]any{"id": "x", "kindId": "app", "name": "X", "orgUnitId": "", "sourceKeys": []string{}}
	}
	for name, mutate := range map[string]func(map[string]any){
		"bad id":       func(b map[string]any) { b["id"] = "bad id" },
		"empty name":   func(b map[string]any) { b["name"] = "" },
		"unknown kind": func(b map[string]any) { b["kindId"] = "nope" },
		"unknown unit": func(b map[string]any) { b["orgUnitId"] = "nope" },
		"blank key":    func(b map[string]any) { b["sourceKeys"] = []string{" "} },
	} {
		b := base()
		mutate(b)
		if got := e.expectError(t, 400, "invalid", admin, "POST", "/items", b); len(got.Error.Details) == 0 {
			t.Errorf("%s: no details", name)
		}
	}
	e.expectError(t, 400, "invalid", admin, "PATCH", "/items/x", map[string]any{})
	e.expectError(t, 400, "invalid", admin, "POST", "/item-kinds", map[string]any{"id": "bad id", "name": "x"})
	e.expectError(t, 400, "invalid", admin, "POST", "/item-kinds", map[string]any{"id": "ok", "name": " "})
	for _, role := range []string{"t1-contributor", "t1-viewer"} {
		tok := e.tokens[role]
		e.expectError(t, 403, "forbidden", tok, "POST", "/items", base())
		e.expectError(t, 403, "forbidden", tok, "PATCH", "/items/x", map[string]any{"name": "y"})
		e.expectError(t, 403, "forbidden", tok, "POST", "/item-kinds", map[string]any{"id": "k", "name": "K"})
	}
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "GET", "/items", nil)
}

// keyPaths returns the detail paths and the messages of an error.
func keyDetail(t *testing.T, got apiErrorBody, path, mustName string) {
	t.Helper()
	for _, d := range got.Error.Details {
		if d.Path == path && strings.Contains(d.Message, mustName) {
			return
		}
	}
	t.Fatalf("no detail at %q naming %q in %+v", path, mustName, got.Error.Details)
}

func TestSourceKeysUniqueAcrossUnitsAndItems(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	seedKinds(t, e)
	admin := e.tokens["t1-admin"]
	unit := func(id string, keys ...string) unitJSON {
		return unitJSON{ID: id, Name: id, LevelID: "product", ParentID: "acme", SourceKeys: keys}
	}
	item := func(id string, keys ...string) map[string]any {
		return map[string]any{"id": id, "kindId": "app", "name": id, "orgUnitId": "", "sourceKeys": keys}
	}

	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"sourceKeys": []string{"Alpha"}}, nil)
	e.expect(t, 201, admin, "POST", "/items", item("svc-1", "Gamma"), nil)

	// Unit vs unit: case-insensitive and trimmed; the detail names the other unit and the key's index.
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "POST", "/org/units", unit("u1", "fresh", "  ALPHA ")), "sourceKeys[1]", "seg-a")
	// Unit vs item.
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "POST", "/org/units", unit("u2", "gamma")), "sourceKeys[0]", "svc-1")
	// Item vs unit, and item vs item.
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "POST", "/items", item("i1", "alpha")), "sourceKeys[0]", "seg-a")
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "POST", "/items", item("i2", "ok", "GAMMA")), "sourceKeys[1]", "svc-1")
	// Updates.
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"sourceKeys": []string{"gamma"}}), "sourceKeys[0]", "svc-1")
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"sourceKeys": []string{"ALPHA"}}), "sourceKeys[0]", "seg-a")
	e.expect(t, 201, admin, "POST", "/items", item("svc-2", "Delta"), nil)
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "PATCH", "/items/svc-2", map[string]any{"sourceKeys": []string{"alpha"}}), "sourceKeys[0]", "seg-a")
	keyDetail(t, e.expectError(t, 400, "invalid", admin, "PATCH", "/items/svc-2", map[string]any{"sourceKeys": []string{"x", "gamma"}}), "sourceKeys[1]", "svc-1")
	// Duplicates inside one list.
	e.expectError(t, 400, "invalid", admin, "POST", "/items", item("i3", "dup", " DUP"))
	e.expectError(t, 400, "invalid", admin, "PATCH", "/org/units/seg-b", map[string]any{"sourceKeys": []string{"one", "ONE"}})

	// An entity may keep or re-state its own keys.
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"sourceKeys": []string{"alpha", "extra"}}, nil)
	e.expect(t, 200, admin, "PATCH", "/items/svc-1", map[string]any{"sourceKeys": []string{"GAMMA"}}, nil)
	// A rename alone never trips on keys.
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-a", map[string]any{"name": "Renamed"}, nil)
	// Released keys can be reused.
	e.expect(t, 200, admin, "PATCH", "/items/svc-1", map[string]any{"sourceKeys": []string{}}, nil)
	e.expect(t, 200, admin, "PATCH", "/org/units/seg-b", map[string]any{"sourceKeys": []string{"gamma"}}, nil)

	// Other tenants are independent.
	t2 := e.tokens["t2-admin"]
	e.expect(t, 200, t2, "PUT", "/org/levels", map[string]any{"levels": []map[string]any{{"id": "company", "name": "Company", "depth": 0}}}, nil)
	e.expect(t, 201, t2, "POST", "/org/units", unitJSON{ID: "other", Name: "Other", LevelID: "company", SourceKeys: []string{"alpha", "gamma"}}, nil)

	// Rejected writes stored nothing.
	var units struct{ Units []unitJSON }
	e.expect(t, 200, admin, "GET", "/org/units", nil, &units)
	for _, u := range units.Units {
		if u.ID == "u1" || u.ID == "u2" {
			t.Fatalf("rejected unit %s was stored", u.ID)
		}
	}
}
