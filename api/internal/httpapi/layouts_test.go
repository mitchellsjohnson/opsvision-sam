package httpapi

import (
	"encoding/json"
	"testing"
)

type layoutJSON struct {
	Items           []layoutItemJSON `json:"items"`
	Revision        int              `json:"revision"`
	Source          string           `json:"source"`
	DefaultRevision int              `json:"defaultRevision"`
}

type layoutItemJSON struct {
	ID     string `json:"id"`
	Size   string `json:"size"`
	Hidden bool   `json:"hidden"`
}

func TestLayoutMemberPutGet(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	contrib := e.tokens["t1-contributor"]
	seedScorecard(t, e, "delivery")

	items := []map[string]any{
		{"id": "metric:closure_rate", "size": "small", "hidden": false},
		{"id": "widget:health", "size": "wide", "hidden": false},
	}
	var saved layoutJSON
	e.expect(t, 200, contrib, "PUT", "/me/layouts/delivery", map[string]any{
		"items": items, "expectedRevision": 0,
	}, &saved)
	if saved.Source != "user" || saved.Revision != 1 {
		t.Fatalf("put: %+v", saved)
	}
	if len(saved.Items) != 2 || saved.Items[0].ID != "metric:closure_rate" {
		t.Fatalf("put items: %+v", saved.Items)
	}

	var got layoutJSON
	e.expect(t, 200, contrib, "GET", "/me/layouts/delivery", nil, &got)
	if got.Source != "user" || got.Revision != 1 {
		t.Fatalf("get: %+v", got)
	}
	if len(got.Items) != 2 {
		t.Fatalf("get items: %+v", got.Items)
	}

	// Stale revision stays 409 and GET keeps the first write.
	items2 := []map[string]any{{"id": "section:quality", "size": "wide", "hidden": true}}
	e.expectError(t, 409, "conflict", contrib, "PUT", "/me/layouts/delivery", map[string]any{
		"items": items2, "expectedRevision": 0,
	})
	e.expect(t, 200, contrib, "GET", "/me/layouts/delivery", nil, &got)
	if got.Revision != 1 || got.Items[0].ID != "metric:closure_rate" {
		t.Fatalf("after stale put: %+v", got)
	}

	e.expect(t, 200, contrib, "PUT", "/me/layouts/delivery", map[string]any{
		"items": items2, "expectedRevision": 1,
	}, &saved)
	e.expect(t, 200, contrib, "GET", "/me/layouts/delivery", nil, &got)
	if got.Revision != 2 || got.Items[0].Hidden != true {
		t.Fatalf("after good put: %+v", got)
	}

	// Admin default is visible to a user with no personal layout.
	defItems := []map[string]any{{"id": "widget:ribbon", "size": "wide", "hidden": false}}
	var def layoutJSON
	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/default-layout", map[string]any{
		"items": defItems, "expectedRevision": 0,
	}, &def)
	if def.Source != "default" || def.Revision != 1 {
		t.Fatalf("default put: %+v", def)
	}

	viewer := e.tokens["t1-viewer"]
	e.expectError(t, 403, "forbidden", viewer, "PUT", "/scorecards/delivery/default-layout", map[string]any{
		"items": defItems, "expectedRevision": 0,
	})

	var fromDefault layoutJSON
	e.expect(t, 200, viewer, "GET", "/me/layouts/delivery", nil, &fromDefault)
	if fromDefault.Source != "default" || fromDefault.Revision != 0 || fromDefault.DefaultRevision != 1 {
		t.Fatalf("viewer default get: %+v", fromDefault)
	}
	if len(fromDefault.Items) != 1 || fromDefault.Items[0].ID != "widget:ribbon" {
		t.Fatalf("viewer default items: %+v", fromDefault.Items)
	}

	var adminGet layoutJSON
	e.expect(t, 200, admin, "GET", "/me/layouts/delivery", nil, &adminGet)
	if adminGet.DefaultRevision != 1 {
		t.Fatalf("defaultRevision on user layout: %+v", adminGet)
	}

	// Unknown scorecard.
	e.expectError(t, 404, "not_found", contrib, "GET", "/me/layouts/missing", nil)
}

func TestLayoutTooManyItems(t *testing.T) {
	e := newTestEnv(t)
	contrib := e.tokens["t1-contributor"]
	seedScorecard(t, e, "delivery")

	items := make([]map[string]any, 201)
	for i := range items {
		items[i] = map[string]any{"id": "metric:m", "size": "small", "hidden": false}
	}
	errBody := e.expectError(t, 400, "invalid", contrib, "PUT", "/me/layouts/delivery", map[string]any{
		"items": items, "expectedRevision": 0,
	})
	if len(errBody.Error.Details) == 0 {
		t.Fatalf("expected validation details: %+v", errBody)
	}
}

func TestLayoutEmpty(t *testing.T) {
	e := newTestEnv(t)
	contrib := e.tokens["t1-contributor"]
	seedScorecard(t, e, "delivery")

	var got layoutJSON
	e.expect(t, 200, contrib, "GET", "/me/layouts/delivery", nil, &got)
	if got.Source != "empty" || got.Revision != 0 || got.DefaultRevision != 0 {
		t.Fatalf("empty: %+v", got)
	}
	if got.Items == nil {
		t.Fatal("items must not be null")
	}
	if len(got.Items) != 0 {
		t.Fatalf("items: %+v", got.Items)
	}
	raw, _ := json.Marshal(got)
	if string(raw) == "" {
		t.Fatal("marshal")
	}
}
