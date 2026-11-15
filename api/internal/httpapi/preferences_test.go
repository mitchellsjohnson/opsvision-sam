package httpapi

import (
	"context"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

type preferencesJSON struct {
	DefaultScope *string `json:"defaultScope"`
}

func scopeOf(t *testing.T, p preferencesJSON) string {
	t.Helper()
	if p.DefaultScope == nil {
		t.Fatal("defaultScope must not be null")
	}
	return *p.DefaultScope
}

func TestPreferencesDefaultIsCompany(t *testing.T) {
	e := newTestEnv(t)
	var got preferencesJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "" {
		t.Fatalf("defaultScope = %q, want empty", s)
	}
}

func TestPreferencesRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	viewer := e.tokens["t1-viewer"]

	var saved preferencesJSON
	e.expect(t, 200, viewer, "PUT", "/me/preferences", map[string]any{"defaultScope": "seg-a"}, &saved)
	if s := scopeOf(t, saved); s != "seg-a" {
		t.Fatalf("put defaultScope = %q", s)
	}
	var got preferencesJSON
	e.expect(t, 200, viewer, "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "seg-a" {
		t.Fatalf("get defaultScope = %q", s)
	}

	e.expect(t, 200, viewer, "PUT", "/me/preferences", map[string]any{"defaultScope": "prod-1"}, nil)
	e.expect(t, 200, viewer, "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "prod-1" {
		t.Fatalf("after second put = %q", s)
	}

	e.expect(t, 200, viewer, "PUT", "/me/preferences", map[string]any{"defaultScope": ""}, &saved)
	if s := scopeOf(t, saved); s != "" {
		t.Fatalf("cleared put = %q", s)
	}
	e.expect(t, 200, viewer, "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "" {
		t.Fatalf("cleared get = %q", s)
	}
}

func TestPreferencesValidation(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	ctx := context.Background()
	retired := func(id, from string) {
		t.Helper()
		p, err := period.Parse(from)
		if err != nil {
			t.Fatal(err)
		}
		if err := e.store.PutOrgUnit(ctx, "t1", domain.OrgUnit{
			ID: id, Name: "Unit " + id, LevelID: "segment", ParentID: "acme", SourceKeys: []string{}, RetiredFrom: &p,
		}); err != nil {
			t.Fatal(err)
		}
	}
	retired("seg-old", "2026-M08")
	retired("seg-later", "2026-M12")
	contrib := e.tokens["t1-contributor"]

	e.expectError(t, 400, "invalid", contrib, "PUT", "/me/preferences", map[string]any{"defaultScope": "missing"})
	e.expectError(t, 400, "invalid", contrib, "PUT", "/me/preferences", map[string]any{"defaultScope": "seg-old"})
	e.expectError(t, 400, "invalid", contrib, "PUT", "/me/preferences", "{")

	var got preferencesJSON
	e.expect(t, 200, contrib, "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "" {
		t.Fatalf("rejected puts must not store: %q", s)
	}
	e.expect(t, 200, contrib, "PUT", "/me/preferences", map[string]any{"defaultScope": "seg-later"}, &got)
	if s := scopeOf(t, got); s != "seg-later" {
		t.Fatalf("unit retiring later = %q", s)
	}
}

func TestPreferencesIsolation(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	ctx := context.Background()
	if err := e.store.PutLevels(ctx, "t2", []domain.Level{{ID: "company", Name: "Company", Depth: 0}}); err != nil {
		t.Fatal(err)
	}
	if err := e.store.PutOrgUnit(ctx, "t2", domain.OrgUnit{ID: "t2-root", Name: "Example Co", LevelID: "company", SourceKeys: []string{}}); err != nil {
		t.Fatal(err)
	}

	e.expect(t, 200, e.tokens["t1-viewer"], "PUT", "/me/preferences", map[string]any{"defaultScope": "seg-a"}, nil)

	var got preferencesJSON
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "" {
		t.Fatalf("other user sees %q", s)
	}
	e.expect(t, 200, e.tokens["t2-viewer"], "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "" {
		t.Fatalf("other tenant sees %q", s)
	}

	// A unit of another tenant is not a valid scope.
	e.expectError(t, 400, "invalid", e.tokens["t1-viewer"], "PUT", "/me/preferences", map[string]any{"defaultScope": "t2-root"})
	e.expectError(t, 400, "invalid", e.tokens["t2-viewer"], "PUT", "/me/preferences", map[string]any{"defaultScope": "seg-a"})
	e.expect(t, 200, e.tokens["t2-viewer"], "PUT", "/me/preferences", map[string]any{"defaultScope": "t2-root"}, nil)

	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/me/preferences", nil, &got)
	if s := scopeOf(t, got); s != "seg-a" {
		t.Fatalf("t1 viewer = %q", s)
	}
}

func TestPreferencesRequireMembership(t *testing.T) {
	e := newTestEnv(t)
	e.expectError(t, 401, "unauthorized", "", "GET", "/me/preferences", nil)
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "GET", "/me/preferences", nil)
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "PUT", "/me/preferences", map[string]any{"defaultScope": ""})
}
