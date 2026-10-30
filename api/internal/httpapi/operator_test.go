package httpapi

import (
	"context"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type tenantJSON struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Auth0OrgID           string `json:"auth0OrgId"`
	FiscalYearStartMonth int    `json:"fiscalYearStartMonth"`
	StatusScale          []struct {
		Key  string `json:"key"`
		Rank int    `json:"rank"`
	} `json:"statusScale"`
	DefaultRole string    `json:"defaultRole"`
	CreatedAt   time.Time `json:"createdAt"`
}

func validTenantBody() map[string]any {
	return map[string]any{
		"name": "Northwind Test", "auth0OrgId": "org_northwind", "fiscalYearStartMonth": 7, "adminEmail": "Admin@Example.test",
	}
}

func TestOperatorCreatesTenant(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()

	var got tenantJSON
	e.expect(t, 201, e.tokens["operator"], "POST", "/operator/tenants", validTenantBody(), &got)
	if got.ID == "" || got.Name != "Northwind Test" || got.Auth0OrgID != "org_northwind" ||
		got.FiscalYearStartMonth != 7 || got.DefaultRole != "viewer" || len(got.StatusScale) != 3 || !got.CreatedAt.Equal(testNow) {
		t.Fatalf("tenant = %+v", got)
	}

	// Stored with the default scale, and a pending admin membership keyed by
	// the lowercase email.
	tenant, err := e.store.GetTenant(ctx, got.ID)
	if err != nil || tenant.DefaultRole != domain.RoleViewer || len(tenant.StatusScale) != 3 || tenant.FiscalYearStartMonth != time.July {
		t.Fatalf("stored tenant = %+v, %v", tenant, err)
	}
	m, err := e.store.GetMembership(ctx, got.ID, store.PendingUserPrefix+"admin@example.test")
	if err != nil {
		t.Fatalf("pending admin membership: %v", err)
	}
	if m.Role != domain.RoleAdmin || m.Email != "admin@example.test" {
		t.Fatalf("pending membership = %+v", m)
	}

	// Writes are audited under the new tenant.
	actions := map[string]bool{}
	for _, en := range e.audits(t, got.ID) {
		actions[en.Action] = true
		if en.ActorID != "u-operator" || en.Channel != "ui" {
			t.Fatalf("audit entry = %+v", en)
		}
	}
	if !actions["tenant.create"] || !actions["member.create"] {
		t.Fatalf("audit actions = %v", actions)
	}

	// The invited admin signs in with a verified email and is bound to the
	// pending admin membership.
	tok, err := auth.IssueDevToken(testSecret, "u-new-admin", "admin@example.test", "New Admin", "org_northwind", false)
	if err != nil {
		t.Fatal(err)
	}
	var me struct {
		Role   string `json:"role"`
		Tenant struct{ ID string }
	}
	e.expect(t, 200, tok, "GET", "/me", nil, &me)
	if me.Role != "admin" || me.Tenant.ID != got.ID {
		t.Fatalf("me = %+v", me)
	}

	// The operator sees all tenants.
	var list struct{ Tenants []tenantJSON }
	e.expect(t, 200, e.tokens["operator"], "GET", "/operator/tenants", nil, &list)
	if len(list.Tenants) != 3 {
		t.Fatalf("operator sees %d tenants, want 3", len(list.Tenants))
	}
}

func TestOperatorEndpointsRequireOperator(t *testing.T) {
	e := newTestEnv(t)
	for _, role := range []string{"t1-admin", "t1-contributor", "t1-viewer"} {
		e.expectError(t, 403, "forbidden", e.tokens[role], "POST", "/operator/tenants", validTenantBody())
		e.expectError(t, 403, "forbidden", e.tokens[role], "GET", "/operator/tenants", nil)
	}
	e.expectError(t, 401, "unauthorized", "", "POST", "/operator/tenants", validTenantBody())
	// Nothing was created.
	ts, err := e.store.ListTenants(context.Background())
	if err != nil || len(ts) != 2 {
		t.Fatalf("tenants = %d, err %v; want 2", len(ts), err)
	}
}

func TestOperatorCreateTenantRules(t *testing.T) {
	e := newTestEnv(t)
	op := e.tokens["operator"]

	e.expect(t, 201, op, "POST", "/operator/tenants", validTenantBody(), nil)
	// A duplicate Auth0 organization is a conflict, and creates nothing.
	e.expectError(t, 409, "conflict", op, "POST", "/operator/tenants", validTenantBody())
	// So is org_t1, which the fixtures already use.
	b := validTenantBody()
	b["auth0OrgId"] = "org_t1"
	e.expectError(t, 409, "conflict", op, "POST", "/operator/tenants", b)
	ts, _ := e.store.ListTenants(context.Background())
	if len(ts) != 3 {
		t.Fatalf("tenants = %d, want 3", len(ts))
	}

	for name, mutate := range map[string]func(map[string]any){
		"empty name":      func(b map[string]any) { b["name"] = " " },
		"empty org":       func(b map[string]any) { b["auth0OrgId"] = "" },
		"month 0":         func(b map[string]any) { b["fiscalYearStartMonth"] = 0 },
		"month 13":        func(b map[string]any) { b["fiscalYearStartMonth"] = 13 },
		"empty email":     func(b map[string]any) { b["adminEmail"] = "" },
		"not an email":    func(b map[string]any) { b["adminEmail"] = "nobody" },
		"display address": func(b map[string]any) { b["adminEmail"] = "Boss <boss@example.test>" },
		"hash in email":   func(b map[string]any) { b["adminEmail"] = "a#b@example.test" },
	} {
		b := validTenantBody()
		b["auth0OrgId"] = "org_" + name
		mutate(b)
		got := e.expectError(t, 400, "invalid", op, "POST", "/operator/tenants", b)
		if len(got.Error.Details) == 0 {
			t.Errorf("%s: no details", name)
		}
	}
}

func TestGetMe(t *testing.T) {
	e := newTestEnv(t)
	var me struct {
		UserID     string `json:"userId"`
		Email      string `json:"email"`
		Name       string `json:"name"`
		IsOperator bool   `json:"isOperator"`
		Role       string `json:"role"`
		Scope      *struct {
			OrgUnitIDs []string `json:"orgUnitIds"`
			MetricKeys []string `json:"metricKeys"`
		} `json:"scope"`
		Tenant  *tenantJSON `json:"tenant"`
		Tenants []struct{ ID, Name string }
	}
	e.expect(t, 200, e.tokens["t1-contributor"], "GET", "/me", nil, &me)
	if me.UserID != "u-t1-contributor" || me.Email != "u-t1-contributor@example.test" || me.IsOperator ||
		me.Role != "contributor" || me.Tenant == nil || me.Tenant.ID != "t1" || me.Tenant.Name != "Tenant t1" ||
		me.Scope == nil || me.Scope.OrgUnitIDs == nil || me.Scope.MetricKeys == nil {
		t.Fatalf("me = %+v", me)
	}
	if len(me.Tenants) != 1 || me.Tenants[0].ID != "t1" || me.Tenants[0].Name != "Tenant t1" {
		t.Fatalf("tenants = %+v", me.Tenants)
	}
	e.expectError(t, 401, "unauthorized", "", "GET", "/me", nil)
}

func TestGetMeOperatorWithoutOrg(t *testing.T) {
	e := newTestEnv(t)
	status, raw := e.call(t, e.tokens["operator"], "GET", "/me", nil)
	if status != 200 {
		t.Fatalf("status %d: %s", status, raw)
	}
	var me map[string]any
	if err := jsonUnmarshal(raw, &me); err != nil {
		t.Fatal(err)
	}
	if me["isOperator"] != true || me["userId"] != "u-operator" {
		t.Fatalf("me = %s", raw)
	}
	for _, k := range []string{"tenant", "role", "scope"} {
		if _, ok := me[k]; ok {
			t.Errorf("operator without org has %q: %s", k, raw)
		}
	}
	tenants, ok := me["tenants"].([]any)
	if !ok || len(tenants) != 0 {
		t.Fatalf("tenants = %#v, want []", me["tenants"])
	}
}

func TestGetMeListsTenantsWithNames(t *testing.T) {
	e := newTestEnv(t)
	// An operator who is also a member of both tenants lists both by name.
	ctx := context.Background()
	for _, id := range []string{"t1", "t2"} {
		err := e.store.PutMembership(ctx, id, domain.Membership{
			UserID: "u-operator", Role: domain.RoleViewer, Scope: domain.Scope{}, CreatedAt: testNow,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var me struct {
		Tenants []struct{ ID, Name string }
		Tenant  *tenantJSON
	}
	e.expect(t, 200, e.tokens["operator"], "GET", "/me", nil, &me)
	if len(me.Tenants) != 2 || me.Tenants[0].Name != "Tenant t1" || me.Tenants[1].Name != "Tenant t2" || me.Tenant != nil {
		t.Fatalf("me = %+v", me)
	}
}
