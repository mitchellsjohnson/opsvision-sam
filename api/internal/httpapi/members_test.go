package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type membershipJSON struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Scope  struct {
		OrgUnitIDs []string `json:"orgUnitIds"`
		MetricKeys []string `json:"metricKeys"`
	} `json:"scope"`
}

func TestMembersAdminOnly(t *testing.T) {
	e := newTestEnv(t)
	for _, role := range []string{"t1-contributor", "t1-viewer"} {
		e.expectError(t, 403, "forbidden", e.tokens[role], "PATCH", "/members/u-t1-viewer", map[string]any{"role": "admin"})
		e.expectError(t, 403, "forbidden", e.tokens[role], "GET", "/members", nil)
	}
	// Nothing changed.
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/members", nil, &list)
	for _, m := range list.Members {
		if m.UserID == "u-t1-viewer" && m.Role != "viewer" {
			t.Fatalf("viewer role changed to %s", m.Role)
		}
	}
	// An operator without an organization is not a tenant admin.
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "PATCH", "/members/u-t1-viewer", map[string]any{"role": "admin"})
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "GET", "/members", nil)
	e.expectError(t, 401, "unauthorized", "", "GET", "/members", nil)
}

func TestListMembers(t *testing.T) {
	e := newTestEnv(t)
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/members", nil, &list)
	if len(list.Members) != 3 {
		t.Fatalf("admin sees %d members, want 3", len(list.Members))
	}
	for _, m := range list.Members {
		if !strings.HasPrefix(m.UserID, "u-t1-") {
			t.Fatalf("admin sees foreign member %s", m.UserID)
		}
		if m.Scope.OrgUnitIDs == nil || m.Scope.MetricKeys == nil {
			t.Fatalf("member %s has null scope arrays", m.UserID)
		}
	}
	// Admin of another tenant sees only its own members.
	e.expect(t, 200, e.tokens["t2-admin"], "GET", "/members", nil, &list)
	for _, m := range list.Members {
		if !strings.HasPrefix(m.UserID, "u-t2-") {
			t.Fatalf("t2 admin sees foreign member %s", m.UserID)
		}
	}
}

func TestUpdateMemberRoleAndScope(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	var got membershipJSON
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-viewer", map[string]any{
		"role":  "contributor",
		"scope": map[string]any{"orgUnitIds": []string{"seg-a"}, "metricKeys": []string{"open_defects"}},
	}, &got)
	if got.Role != "contributor" || len(got.Scope.OrgUnitIDs) != 1 || got.Scope.MetricKeys[0] != "open_defects" {
		t.Fatalf("updated = %+v", got)
	}

	// Role only: the scope is unchanged.
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-viewer", map[string]any{"role": "viewer"}, &got)
	if got.Role != "viewer" || len(got.Scope.OrgUnitIDs) != 1 {
		t.Fatalf("after role-only update = %+v", got)
	}
	// Scope only, clearing it with empty lists.
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-viewer", map[string]any{
		"scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}},
	}, &got)
	if got.Role != "viewer" || len(got.Scope.OrgUnitIDs) != 0 || got.Scope.OrgUnitIDs == nil {
		t.Fatalf("after scope-only update = %+v", got)
	}

	// The change is visible to the member on its next request.
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, admin, "GET", "/members", nil, &list)

	// An audit entry records before and after.
	var found bool
	for _, en := range e.audits(t, "t1") {
		if en.Action == "member.update" && en.TargetID == "u-t1-viewer" {
			var b, a membershipJSON
			if json.Unmarshal(en.Before, &b) != nil || json.Unmarshal(en.After, &a) != nil {
				t.Fatalf("audit before/after = %s / %s", en.Before, en.After)
			}
			if b.Role == "viewer" && a.Role == "contributor" {
				found = true
			}
			if en.ActorID != "u-t1-admin" || en.Channel != "ui" || en.TargetType != "member" {
				t.Fatalf("audit entry = %+v", en)
			}
		}
	}
	if !found {
		t.Fatal("no member.update audit entry for viewer -> contributor")
	}
}

func TestUpdateMemberValidation(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	patch := func(body any) {
		t.Helper()
		e.expectError(t, 400, "invalid", admin, "PATCH", "/members/u-t1-viewer", body)
	}
	patch(map[string]any{})
	patch(map[string]any{"role": "owner"})
	patch(map[string]any{"role": ""})
	patch(map[string]any{"scope": map[string]any{"orgUnitIds": []string{"nowhere"}, "metricKeys": []string{}}})
	patch(map[string]any{"scope": map[string]any{"orgUnitIds": []string{"bad id"}, "metricKeys": []string{}}})
	patch(map[string]any{"scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{"Bad-Key"}}})
	// Scope given without both lists is incomplete.
	patch(map[string]any{"scope": map[string]any{"orgUnitIds": []string{}}})

	// A user ID with '#' is rejected before any lookup.
	e.expectError(t, 400, "invalid", admin, "PATCH", "/members/a%23b", map[string]any{"role": "viewer"})
	// An unknown member is 404.
	e.expectError(t, 404, "not_found", admin, "PATCH", "/members/ghost", map[string]any{"role": "viewer"})
}

func TestUpdateMemberCrossTenant(t *testing.T) {
	e := newTestEnv(t)
	e.expectError(t, 404, "not_found", e.tokens["t2-admin"], "PATCH", "/members/u-t1-viewer", map[string]any{"role": "admin"})
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, e.tokens["t2-admin"], "GET", "/members", nil, &list)
	for _, m := range list.Members {
		if strings.Contains(m.UserID, "t1") {
			t.Fatalf("t2 sees %s", m.UserID)
		}
	}
}

func TestLastAdminCannotBeDemoted(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]

	got := e.expectError(t, 400, "invalid", admin, "PATCH", "/members/u-t1-admin", map[string]any{"role": "viewer"})
	if got.Error.Message != "tenant must keep at least one admin" {
		t.Fatalf("message = %q", got.Error.Message)
	}
	// Demoting while changing nothing else of consequence is still blocked,
	// and the role is unchanged.
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, admin, "GET", "/members", nil, &list)
	for _, m := range list.Members {
		if m.UserID == "u-t1-admin" && m.Role != "admin" {
			t.Fatal("last admin was demoted")
		}
	}
	// A scope-only change to the last admin is fine.
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-admin", map[string]any{
		"scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}},
	}, nil)
	// Keeping the role admin is fine.
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-admin", map[string]any{"role": "admin"}, nil)

	// With a second admin the first can step down.
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-contributor", map[string]any{"role": "admin"}, nil)
	e.expect(t, 200, admin, "PATCH", "/members/u-t1-admin", map[string]any{"role": "viewer"}, nil)
	// Now u-t1-contributor is the last admin.
	e.expectError(t, 400, "invalid", e.tokens["t1-contributor"], "PATCH", "/members/u-t1-contributor", map[string]any{"role": "contributor"})
	// The former admin's token no longer authorizes admin writes.
	e.expectError(t, 403, "forbidden", admin, "PATCH", "/members/u-t1-viewer", map[string]any{"role": "viewer"})
}

func TestPendingAdminDoesNotCountAsAdmin(t *testing.T) {
	e := newTestEnv(t)
	// An invitation for a second admin exists but has not been claimed.
	err := e.store.PutMembership(context.Background(), "t1", domain.Membership{
		UserID: store.PendingUserPrefix + "later@example.test", Email: "later@example.test",
		Role: domain.RoleAdmin, Scope: domain.Scope{}, CreatedAt: testNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The only admin who can act is still the last one.
	e.expectError(t, 400, "invalid", e.tokens["t1-admin"], "PATCH", "/members/u-t1-admin", map[string]any{"role": "viewer"})

	// A pending member can be edited by its (URL-encoded) user ID.
	var got membershipJSON
	e.expect(t, 200, e.tokens["t1-admin"], "PATCH", "/members/pending:later@example.test", map[string]any{"role": "contributor"}, &got)
	if got.UserID != store.PendingUserPrefix+"later@example.test" || got.Role != "contributor" {
		t.Fatalf("pending member = %+v", got)
	}
}

func TestInviteMember(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]

	var got membershipJSON
	e.expect(t, 201, admin, "POST", "/members", map[string]any{
		"email": "  New.Person@Example.Test ",
		"role":  "contributor",
		"scope": map[string]any{"orgUnitIds": []string{"seg-a"}, "metricKeys": []string{"open_defects"}},
	}, &got)
	if got.UserID != store.PendingUserPrefix+"new.person@example.test" || got.Email != "New.Person@Example.Test" {
		t.Fatalf("invited = %+v", got)
	}
	if got.Role != "contributor" || len(got.Scope.OrgUnitIDs) != 1 || got.Scope.MetricKeys[0] != "open_defects" {
		t.Fatalf("invited = %+v", got)
	}

	// It is listed, and an audit entry records it.
	var list struct{ Members []membershipJSON }
	e.expect(t, 200, admin, "GET", "/members", nil, &list)
	found := false
	for _, m := range list.Members {
		found = found || m.UserID == got.UserID
	}
	if !found {
		t.Fatal("invited member not listed")
	}
	audited := false
	for _, en := range e.audits(t, "t1") {
		if en.Action == "member.invite" && en.TargetID == got.UserID && en.TargetType == "member" && en.ActorID == "u-t1-admin" {
			audited = true
		}
	}
	if !audited {
		t.Fatal("no member.invite audit entry")
	}

	// Another tenant can invite the same address.
	e.expect(t, 201, e.tokens["t2-admin"], "POST", "/members", map[string]any{
		"email": "new.person@example.test", "role": "viewer",
		"scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}},
	}, nil)
}

func TestInviteMemberConflicts(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	body := func(email string) map[string]any {
		return map[string]any{"email": email, "role": "viewer", "scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}}}
	}
	e.expect(t, 201, admin, "POST", "/members", body("dup@example.test"), nil)
	// Pending duplicate, in any case.
	e.expectError(t, 409, "conflict", admin, "POST", "/members", body("DUP@example.test"))
	// A bound member already has this email, in any case.
	e.expectError(t, 409, "conflict", admin, "POST", "/members", body("U-T1-VIEWER@example.test"))
}

func TestInviteMemberValidation(t *testing.T) {
	e := newTestEnv(t)
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	scope := map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}}
	bad := func(body map[string]any, path string) {
		t.Helper()
		got := e.expectError(t, 400, "invalid", admin, "POST", "/members", body)
		for _, d := range got.Error.Details {
			if d.Path == path {
				return
			}
		}
		t.Fatalf("no detail at %q: %+v", path, got.Error.Details)
	}
	bad(map[string]any{"email": "", "role": "viewer", "scope": scope}, "email")
	bad(map[string]any{"email": "nobody", "role": "viewer", "scope": scope}, "email")
	bad(map[string]any{"email": "a b@example.test", "role": "viewer", "scope": scope}, "email")
	bad(map[string]any{"email": "a@b", "role": "viewer", "scope": scope}, "email")
	bad(map[string]any{"email": "a@example.test", "role": "owner", "scope": scope}, "role")
	bad(map[string]any{"email": "a@example.test", "role": "viewer",
		"scope": map[string]any{"orgUnitIds": []string{"nowhere"}, "metricKeys": []string{}}}, "scope.orgUnitIds[0]")
	bad(map[string]any{"email": "a@example.test", "role": "viewer",
		"scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{"Bad-Key"}}}, "scope.metricKeys[0]")
	bad(map[string]any{"email": "a@example.test", "role": "viewer", "scope": map[string]any{"orgUnitIds": []string{}}}, "scope")
}

func TestInviteMemberAdminOnly(t *testing.T) {
	e := newTestEnv(t)
	body := map[string]any{"email": "x@example.test", "role": "viewer", "scope": map[string]any{"orgUnitIds": []string{}, "metricKeys": []string{}}}
	for _, role := range []string{"t1-contributor", "t1-viewer", "operator"} {
		e.expectError(t, 403, "forbidden", e.tokens[role], "POST", "/members", body)
	}
	e.expectError(t, 401, "unauthorized", "", "POST", "/members", body)
}
