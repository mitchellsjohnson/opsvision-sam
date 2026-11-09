package auth_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

const (
	trustedPrefix = "oidc|corp-employees|"
	employeeSub   = trustedPrefix + "u-100"
)

// userInfoFixture is an identity provider /userinfo endpoint.
type userInfoFixture struct {
	server *httptest.Server
	hits   atomic.Int32
	// body is the JSON document served; status overrides 200 when non-zero.
	body   atomic.Value // map[string]any
	status atomic.Int32
	// lastAuth is the Authorization header of the last request.
	lastAuth atomic.Value // string
}

func newUserInfoFixture(t *testing.T, body map[string]any) *userInfoFixture {
	t.Helper()
	u := &userInfoFixture{}
	u.body.Store(body)
	u.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.hits.Add(1)
		bearer := r.Header.Get("Authorization")
		u.lastAuth.Store(bearer)
		if s := u.status.Load(); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		// Like an identity provider, answer for the token's own subject
		// unless the body names one.
		out := map[string]any{"sub": tokenSubject(t, strings.TrimPrefix(bearer, "Bearer "))}
		for k, v := range u.body.Load().(map[string]any) {
			out[k] = v
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(u.server.Close)
	return u
}

func (u *userInfoFixture) url() string { return u.server.URL + "/userinfo" }

// tokenSubject reads the sub of a compact JWS without verifying it.
func tokenSubject(t *testing.T, tok string) string {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Errorf("token payload: %v", err)
		return ""
	}
	var c struct {
		Sub string `json:"sub"`
	}
	_ = json.Unmarshal(raw, &c)
	return c.Sub
}

func verifiedEmail(email string) map[string]any {
	return map[string]any{"email": email, "email_verified": true, "name": "Pat Example"}
}

func singleOrgConfig(f *rsaFixture, u *userInfoFixture) auth.Config {
	cfg := auth0Config(f)
	cfg.SingleTenantID = "t1"
	cfg.TrustedSubPrefixes = []string{"samlp|other-idp|", trustedPrefix}
	cfg.BootstrapAdmins = []string{"boss@example.test"}
	cfg.UserInfoURL = u.url()
	return cfg
}

// employeeToken has no org_id and no email claim, like a token from a
// tenant with no post-login action.
func employeeToken(t *testing.T, f *rsaFixture, extra map[string]any) string {
	t.Helper()
	return f.token(t, tokOpts{subject: employeeSub, extra: extra})
}

func TestSingleOrgTrustedMember(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	ts := newStore(t)
	created := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if err := ts.PutMembership(context.Background(), "t1", domain.Membership{
		UserID: employeeSub, Email: "pat@example.test", Role: domain.RoleContributor, CreatedAt: created,
	}); err != nil {
		t.Fatal(err)
	}

	tok := employeeToken(t, f, nil)
	rec, p := run(t, singleOrgConfig(f, u), ts, tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if p.Tenant == nil || p.Tenant.ID != "t1" {
		t.Fatalf("Tenant = %+v, want t1", p.Tenant)
	}
	if p.Membership == nil || p.Membership.Role != domain.RoleContributor || !p.Membership.CreatedAt.Equal(created) {
		t.Errorf("Membership = %+v, want the existing contributor", p.Membership)
	}
	if p.Email != "pat@example.test" {
		t.Errorf("Email = %q, want the /userinfo email", p.Email)
	}
	if got, _ := u.lastAuth.Load().(string); got != "Bearer "+tok {
		t.Errorf("/userinfo Authorization = %q, want the caller's bearer token", got)
	}
}

func TestSingleOrgUntrustedSubForbidden(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("boss@example.test"))
	ts := newStore(t)
	cfg := singleOrgConfig(f, u)
	for _, sub := range []string{
		"auth0|u-100",
		"oidc|corp-contractors|u-100",
		"oidc|corp-employees", // the prefix without its separator
		"OIDC|corp-employees|u-100",
		"x" + employeeSub,
	} {
		rec, p := run(t, cfg, ts, f.token(t, tokOpts{subject: sub, extra: orgClaims(nil)}))
		wantError(t, rec, http.StatusForbidden, "forbidden", "")
		if p != nil {
			t.Errorf("sub %q: handler reached", sub)
		}
	}
	ms, err := ts.ListMemberships(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 0 {
		t.Errorf("memberships = %+v, want none for untrusted callers", ms)
	}
	if n := u.hits.Load(); n != 0 {
		t.Errorf("/userinfo called %d times for untrusted callers, want 0", n)
	}
}

func TestSingleOrgBootstrapAdmin(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("Boss@Example.test"))
	ts := newStore(t)
	cfg := singleOrgConfig(f, u)
	ctx := context.Background()

	_, p := run(t, cfg, ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("principal = %+v, want a bootstrap admin", p)
	}
	stored, err := ts.GetMembership(ctx, "t1", employeeSub)
	if err != nil || stored.Role != domain.RoleAdmin || stored.Email != "Boss@Example.test" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}

	// Another admin demotes them; signing in again never re-elevates.
	stored.Role = domain.RoleViewer
	if err := ts.PutMembership(ctx, "t1", stored); err != nil {
		t.Fatal(err)
	}
	_, p = run(t, cfg, ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want the demoted viewer", p)
	}
	if again, _ := ts.GetMembership(ctx, "t1", employeeSub); again.Role != domain.RoleViewer {
		t.Errorf("stored role = %q after second sign-in, want viewer", again.Role)
	}
}

// unverifiedEmailSources are the ways a trusted caller's email can arrive
// without email_verified true: /userinfo or the token claim, false or absent.
func unverifiedEmailSources(t *testing.T, f *rsaFixture, email string) map[string]struct {
	userInfo map[string]any
	token    string
} {
	return map[string]struct {
		userInfo map[string]any
		token    string
	}{
		"userinfo false":  {map[string]any{"email": email, "email_verified": false}, employeeToken(t, f, nil)},
		"userinfo absent": {map[string]any{"email": email}, employeeToken(t, f, nil)},
		"claim false": {map[string]any{}, employeeToken(t, f, map[string]any{
			testNS + "email": email, testNS + "email_verified": false,
		})},
		"claim absent": {map[string]any{}, employeeToken(t, f, map[string]any{testNS + "email": email})},
	}
}

// The trusted connection is the organization's own directory, so its emails
// count as verified in single-organization mode.
func TestSingleOrgBootstrapAdminUnverifiedEmail(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	for name, src := range unverifiedEmailSources(t, f, "Boss@Example.test") {
		u := newUserInfoFixture(t, src.userInfo)
		_, p := run(t, singleOrgConfig(f, u), newStore(t), src.token)
		if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
			t.Errorf("%s: principal = %+v, want a bootstrap admin", name, p)
		}
	}
}

func TestSingleOrgInviteBindsUnverifiedEmail(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ctx := context.Background()
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	for name, src := range unverifiedEmailSources(t, f, "Jane.Doe@Example.test") {
		u := newUserInfoFixture(t, src.userInfo)
		ts := newStore(t)
		if err := ts.PutMembership(ctx, "t1", domain.Membership{UserID: pendingID, Role: domain.RoleContributor}); err != nil {
			t.Fatal(err)
		}
		_, p := run(t, singleOrgConfig(f, u), ts, src.token)
		if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleContributor || p.Membership.UserID != employeeSub {
			t.Errorf("%s: principal = %+v, want the bound invitation", name, p)
		}
		if _, err := ts.GetMembership(ctx, "t1", pendingID); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("%s: invitation not removed: %v", name, err)
		}
	}
}

func TestSingleOrgNoEmailGetsDefaultRole(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, map[string]any{})
	ts := newStore(t)
	// A pending record under the empty email must never be bound.
	_ = ts.PutMembership(context.Background(), "t1", domain.Membership{UserID: store.PendingUserPrefix, Role: domain.RoleAdmin})
	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want the default viewer", p)
	}
}

func TestSingleOrgPendingInviteBinds(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("Jane.Doe@Example.test"))
	ts := newStore(t)
	ctx := context.Background()
	invited := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	if err := ts.PutMembership(ctx, "t1", domain.Membership{
		UserID: pendingID, Email: "jane.doe@example.test", Role: domain.RoleContributor,
		Scope: domain.Scope{OrgUnitIDs: []string{"payments"}}, CreatedAt: invited,
	}); err != nil {
		t.Fatal(err)
	}

	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil {
		t.Fatalf("principal = %+v", p)
	}
	m := p.Membership
	if m.UserID != employeeSub || m.Role != domain.RoleContributor || !m.CreatedAt.Equal(invited) ||
		len(m.Scope.OrgUnitIDs) != 1 || m.Scope.OrgUnitIDs[0] != "payments" {
		t.Errorf("membership = %+v, want the bound invitation", m)
	}
	if _, err := ts.GetMembership(ctx, "t1", pendingID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("invitation not removed: %v", err)
	}
}

func TestSingleOrgPendingInviteWinsOverBootstrapAdmin(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("boss@example.test"))
	ts := newStore(t)
	pendingID := store.PendingUserPrefix + "boss@example.test"
	if err := ts.PutMembership(context.Background(), "t1", domain.Membership{UserID: pendingID, Role: domain.RoleViewer}); err != nil {
		t.Fatal(err)
	}
	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want the invitation's viewer role", p)
	}
}

func TestSingleOrgDefaultRole(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	ts := memstore.New()
	if err := ts.CreateTenant(context.Background(), domain.Tenant{ID: "t1", Name: "Corp", DefaultRole: domain.RoleContributor}); err != nil {
		t.Fatal(err)
	}
	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleContributor {
		t.Fatalf("principal = %+v, want the tenant's default contributor", p)
	}
	m, err := ts.GetMembership(context.Background(), "t1", employeeSub)
	if err != nil || m.Role != domain.RoleContributor || m.Email != "pat@example.test" || m.Name != "Pat Example" {
		t.Errorf("stored = %+v, %v", m, err)
	}
}

func TestSingleOrgIgnoresOrgID(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	ts := newStore(t)
	if err := ts.CreateTenant(context.Background(), domain.Tenant{ID: "t2", Name: "Other", Auth0OrgID: "org_2"}); err != nil {
		t.Fatal(err)
	}
	for _, org := range []string{"org_2", "org_unknown"} {
		_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, map[string]any{"org_id": org}))
		if p == nil || p.Tenant == nil || p.Tenant.ID != "t1" {
			t.Fatalf("org_id %q: principal = %+v, want tenant t1", org, p)
		}
	}
	if _, err := ts.GetMembership(context.Background(), "t2", employeeSub); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("membership created in the tenant named by org_id: %v", err)
	}
}

func TestSingleOrgTenantNotProvisioned(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	cfg := singleOrgConfig(f, u)
	cfg.SingleTenantID = "t-missing"
	rec, p := run(t, cfg, newStore(t), employeeToken(t, f, nil))
	wantError(t, rec, http.StatusForbidden, "forbidden", "tenant not provisioned")
	if p != nil {
		t.Error("handler reached")
	}
}

func TestSingleOrgTokenEmailSkipsUserInfo(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("other@example.test"))
	ts := newStore(t)
	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, map[string]any{
		testNS + "email":          "boss@example.test",
		testNS + "email_verified": true,
	}))
	if p == nil || p.Email != "boss@example.test" || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("principal = %+v, want the token's email and a bootstrap admin", p)
	}
	if n := u.hits.Load(); n != 0 {
		t.Errorf("/userinfo called %d times, want 0 when the token has an email", n)
	}
}

func TestSingleOrgUserInfoFailureIs503(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	for _, status := range []int{http.StatusInternalServerError, http.StatusUnauthorized, http.StatusTooManyRequests} {
		u := newUserInfoFixture(t, nil)
		u.status.Store(int32(status))
		ts := newStore(t)
		rec, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
		wantError(t, rec, http.StatusServiceUnavailable, "identity_unavailable", "")
		if p != nil {
			t.Errorf("/userinfo %d: handler reached", status)
		}
		if ms, _ := ts.ListMemberships(context.Background(), "t1"); len(ms) != 0 {
			t.Errorf("/userinfo %d: memberships = %+v, want none", status, ms)
		}
	}
}

func TestSingleOrgUserInfoForAnotherSubjectIs503(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	for name, sub := range map[string]any{"other user": trustedPrefix + "u-999", "no sub": ""} {
		body := verifiedEmail("boss@example.test")
		body["sub"] = sub
		u := newUserInfoFixture(t, body)
		ts := newStore(t)
		rec, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, nil))
		wantError(t, rec, http.StatusServiceUnavailable, "identity_unavailable", "")
		if p != nil {
			t.Errorf("%s: handler reached", name)
		}
		if ms, _ := ts.ListMemberships(context.Background(), "t1"); len(ms) != 0 {
			t.Errorf("%s: memberships = %+v, want none", name, ms)
		}
	}
}

func TestSingleOrgOperatorNotAutoProvisioned(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("boss@example.test"))
	ts := newStore(t)
	_, p := run(t, singleOrgConfig(f, u), ts, employeeToken(t, f, map[string]any{"permissions": []string{"operate:platform"}}))
	if p == nil || !p.IsOperator || p.Tenant == nil || p.Membership != nil {
		t.Fatalf("principal = %+v, want an operator in t1 without a membership", p)
	}
}

func TestSingleOrgConfigRequiresPrefixes(t *testing.T) {
	ts := memstore.New()
	base := auth.Config{Mode: "auth0", Domain: "example.us.auth0.com", Audience: testAudience}
	cases := map[string]func(*auth.Config){
		"no prefixes":       func(c *auth.Config) { c.SingleTenantID = "t1" },
		"empty prefix list": func(c *auth.Config) { c.SingleTenantID = "t1"; c.TrustedSubPrefixes = []string{} },
		"empty prefix":      func(c *auth.Config) { c.SingleTenantID = "t1"; c.TrustedSubPrefixes = []string{trustedPrefix, ""} },
		"prefix without |":  func(c *auth.Config) { c.SingleTenantID = "t1"; c.TrustedSubPrefixes = []string{"oidc|corp-employees"} },
		"blank bootstrap": func(c *auth.Config) {
			c.SingleTenantID = "t1"
			c.TrustedSubPrefixes = []string{trustedPrefix}
			c.BootstrapAdmins = []string{" "}
		},
		"bad userinfo URL": func(c *auth.Config) {
			c.SingleTenantID = "t1"
			c.TrustedSubPrefixes = []string{trustedPrefix}
			c.UserInfoURL = "not a url"
		},
		"prefixes, no tenant": func(c *auth.Config) { c.TrustedSubPrefixes = []string{trustedPrefix} },
		"admins, no tenant":   func(c *auth.Config) { c.BootstrapAdmins = []string{"boss@example.test"} },
		"userinfo, no tenant": func(c *auth.Config) { c.UserInfoURL = "https://example.us.auth0.com/userinfo" },
		"no domain or userinfo": func(c *auth.Config) {
			c.Mode, c.DevSecret, c.Domain = "dev", devSecret, ""
			c.SingleTenantID, c.TrustedSubPrefixes = "t1", []string{trustedPrefix}
		},
	}
	for name, mutate := range cases {
		cfg := base
		mutate(&cfg)
		if _, err := auth.Middleware(cfg, ts); err == nil {
			t.Errorf("%s: want a configuration error, got nil", name)
		}
	}

	cfg := base
	cfg.SingleTenantID, cfg.TrustedSubPrefixes = "t1", []string{trustedPrefix}
	if _, err := auth.Middleware(cfg, ts); err != nil {
		t.Errorf("valid single-organization config (default /userinfo): %v", err)
	}
}

func TestSingleOrgBootstrapAdminsAreNormalized(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("boss@example.test"))
	cfg := singleOrgConfig(f, u)
	cfg.BootstrapAdmins = []string{"  BOSS@Example.TEST "}
	_, p := run(t, cfg, newStore(t), employeeToken(t, f, nil))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("principal = %+v, want an admin", p)
	}
}

func TestSingleOrgNameFromUserInfo(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	_, p := run(t, singleOrgConfig(f, u), newStore(t), employeeToken(t, f, nil))
	if p == nil || p.Name != "Pat Example" {
		t.Fatalf("principal = %+v, want the /userinfo name", p)
	}
	// A name in the token wins.
	_, p = run(t, singleOrgConfig(f, u), newStore(t), employeeToken(t, f, map[string]any{testNS + "name": "Token Name"}))
	if p == nil || p.Name != "Token Name" {
		t.Fatalf("principal = %+v, want the token's name", p)
	}
}

func TestMultiTenantIgnoresUserInfo(t *testing.T) {
	// Without SingleTenantID nothing changes: org_id is required and no
	// trusted prefix applies.
	f := newRSAFixture(t, "kid-1")
	rec, _ := run(t, auth0Config(f), newStore(t), employeeToken(t, f, nil))
	wantError(t, rec, http.StatusForbidden, "forbidden", "no organization in token")
}
