package auth_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

func TestNewTokenFormat(t *testing.T) {
	if auth.TokenPrefix != "ovs_pat_" {
		t.Fatalf("TokenPrefix = %q", auth.TokenPrefix)
	}
	secret, hash, prefix, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(secret, auth.TokenPrefix) {
		t.Fatalf("secret %q lacks the prefix", secret[:12])
	}
	if len(secret) != len(auth.TokenPrefix)+43 {
		t.Fatalf("secret length = %d, want %d", len(secret), len(auth.TokenPrefix)+43)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(secret, auth.TokenPrefix))
	if err != nil || len(raw) != 32 {
		t.Fatalf("secret body is not 32 base64url bytes: %d bytes, %v", len(raw), err)
	}
	if prefix != secret[:12] {
		t.Fatalf("prefix = %q, want the first 12 characters of the secret", prefix)
	}
	if hash != sha256.Sum256([]byte(secret)) {
		t.Fatal("hash is not sha256(secret)")
	}
	if auth.HashToken(secret) != hash {
		t.Fatal("HashToken disagrees with NewToken")
	}
	other, _, _, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if other == secret {
		t.Fatal("two tokens are equal")
	}
}

// patNow is the fixed clock of the access-token middleware tests.
var patNow = time.Date(2026, time.October, 15, 12, 0, 0, 0, time.UTC)

// touchCounter counts TouchToken calls.
type touchCounter struct {
	*memstore.Store
	touches atomic.Int32
}

func (c *touchCounter) TouchToken(ctx context.Context, tenantID, userID, id string, at time.Time) error {
	c.touches.Add(1)
	return c.Store.TouchToken(ctx, tenantID, userID, id, at)
}

// patFixture is a store with tenant t1, contributor u-1, and one access token
// for u-1 valid from a day before patNow to a day after.
type patFixture struct {
	st     *touchCounter
	secret string
	tok    domain.AccessToken
	clock  time.Time
}

func newPATFixture(t *testing.T) *patFixture {
	t.Helper()
	ctx := context.Background()
	st := &touchCounter{Store: memstore.New()}
	if err := st.CreateTenant(ctx, domain.Tenant{ID: "t1", Name: "Tenant One", Auth0OrgID: "org_1", DefaultRole: domain.RoleViewer}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutMembership(ctx, "t1", domain.Membership{
		UserID: "u-1", Email: "u-1@example.test", Name: "User One", Role: domain.RoleContributor,
		Scope: domain.Scope{OrgUnitIDs: []string{}, MetricKeys: []string{}}, CreatedAt: patNow,
	}); err != nil {
		t.Fatal(err)
	}
	secret, hash, prefix, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	tok := domain.AccessToken{
		ID: "tok-1", TenantID: "t1", UserID: "u-1", Name: "Laptop", Prefix: prefix, Hash: hash,
		CreatedAt: patNow.Add(-24 * time.Hour), ExpiresAt: patNow.Add(24 * time.Hour),
	}
	if err := st.PutToken(ctx, tok); err != nil {
		t.Fatal(err)
	}
	return &patFixture{st: st, secret: secret, tok: tok, clock: patNow}
}

func (f *patFixture) config() auth.Config {
	return auth.Config{Mode: auth.ModeDev, DevSecret: devSecret, Now: func() time.Time { return f.clock }}
}

func TestBearerTokenAuthenticates(t *testing.T) {
	f := newPATFixture(t)
	rec, p := run(t, f.config(), f.st, f.secret)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	if p.UserID != "u-1" || p.Email != "u-1@example.test" || p.Name != "User One" || p.IsOperator {
		t.Fatalf("principal = %+v", p)
	}
	if auth.ChannelToken != "token" || p.Channel != auth.ChannelToken || p.Interactive {
		t.Fatalf("channel = %q, interactive %v; want token, not interactive", p.Channel, p.Interactive)
	}
	if p.Tenant == nil || p.Tenant.ID != "t1" || p.Membership == nil || p.Membership.Role != domain.RoleContributor {
		t.Fatalf("tenant/membership = %+v / %+v", p.Tenant, p.Membership)
	}

	// The current role applies on every request.
	m, _ := f.st.GetMembership(context.Background(), "t1", "u-1")
	m.Role = domain.RoleAdmin
	if err := f.st.PutMembership(context.Background(), "t1", m); err != nil {
		t.Fatal(err)
	}
	_, p = run(t, f.config(), f.st, f.secret)
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("after promotion principal = %+v", p)
	}
}

func TestIdentityProviderTokenChannelIsEmpty(t *testing.T) {
	f := newPATFixture(t)
	jwt, err := auth.IssueDevToken(devSecret, "u-1", "u-1@example.test", "User One", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	_, p := run(t, f.config(), f.st, jwt)
	if p == nil || p.Channel != "" || !p.Interactive {
		t.Fatalf("principal = %+v, want an empty channel, interactive", p)
	}
}

func TestRevokedTokenRejected(t *testing.T) {
	f := newPATFixture(t)
	if rec, _ := run(t, f.config(), f.st, f.secret); rec.Code != http.StatusNoContent {
		t.Fatalf("before revoke: status %d", rec.Code)
	}
	if err := f.st.DeleteToken(context.Background(), "t1", "u-1", "tok-1"); err != nil {
		t.Fatal(err)
	}
	rec, p := run(t, f.config(), f.st, f.secret)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Fatal("handler reached")
	}
}

func TestMiddlewareWarnsWithoutTokenStore(t *testing.T) {
	f := newPATFixture(t)
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if _, err := auth.Middleware(f.config(), f.st); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), "access tokens") {
		t.Fatalf("warned with a token store: %s", logs.String())
	}
	if _, err := auth.Middleware(f.config(), tenantOnlyStore{f.st.Store}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), "access tokens") {
		t.Fatalf("no warning without a token store: %s", logs.String())
	}
}

func TestUnknownTokenRejected(t *testing.T) {
	f := newPATFixture(t)
	other, _, _, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	for _, bearer := range []string{other, auth.TokenPrefix, f.secret + "x"} {
		rec, p := run(t, f.config(), f.st, bearer)
		wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
		if p != nil {
			t.Fatalf("%q: handler reached", bearer)
		}
	}
}

func TestExpiredTokenRejected(t *testing.T) {
	f := newPATFixture(t)
	f.clock = f.tok.ExpiresAt.Add(-time.Second)
	if rec, _ := run(t, f.config(), f.st, f.secret); rec.Code != http.StatusNoContent {
		t.Fatalf("just before expiry: status %d", rec.Code)
	}
	f.clock = f.tok.ExpiresAt
	rec, p := run(t, f.config(), f.st, f.secret)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Fatal("handler reached")
	}
}

func TestRemovedMemberTokenRejected(t *testing.T) {
	f := newPATFixture(t)
	ctx := context.Background()
	if err := f.st.DeleteMembership(ctx, "t1", "u-1"); err != nil {
		t.Fatal(err)
	}
	// Removal deletes the user's tokens; one left behind (a removal that
	// failed part-way) still does not authenticate.
	if err := f.st.PutToken(ctx, f.tok); err != nil {
		t.Fatal(err)
	}
	rec, p := run(t, f.config(), f.st, f.secret)
	wantError(t, rec, http.StatusForbidden, "forbidden", "")
	if p != nil {
		t.Fatal("handler reached")
	}
	// A token never provisions a membership.
	if _, err := f.st.GetMembership(ctx, "t1", "u-1"); err == nil {
		t.Fatal("membership re-created by a token request")
	}
}

func TestTokenTouchThrottled(t *testing.T) {
	f := newPATFixture(t)
	ctx := context.Background()
	lastUsed := func() *time.Time {
		t.Helper()
		got, err := f.st.TokenByHash(ctx, f.tok.Hash)
		if err != nil {
			t.Fatal(err)
		}
		return got.LastUsedAt
	}

	run(t, f.config(), f.st, f.secret)
	if n := f.st.touches.Load(); n != 1 {
		t.Fatalf("touches after first use = %d, want 1", n)
	}
	if lu := lastUsed(); lu == nil || !lu.Equal(patNow) {
		t.Fatalf("lastUsedAt = %v, want %v", lu, patNow)
	}

	f.clock = patNow.Add(59 * time.Second)
	run(t, f.config(), f.st, f.secret)
	if n := f.st.touches.Load(); n != 1 {
		t.Fatalf("touches within a minute = %d, want 1", n)
	}

	f.clock = patNow.Add(61 * time.Second)
	run(t, f.config(), f.st, f.secret)
	if n := f.st.touches.Load(); n != 2 {
		t.Fatalf("touches after a minute = %d, want 2", n)
	}
	if lu := lastUsed(); lu == nil || !lu.Equal(f.clock) {
		t.Fatalf("lastUsedAt = %v, want %v", lu, f.clock)
	}
}

// failingTouchStore fails every TouchToken.
type failingTouchStore struct{ *memstore.Store }

func (failingTouchStore) TouchToken(context.Context, string, string, string, time.Time) error {
	return context.DeadlineExceeded
}

func TestTokenTouchFailureDoesNotFailRequest(t *testing.T) {
	f := newPATFixture(t)
	rec, p := run(t, f.config(), failingTouchStore{f.st.Store}, f.secret)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d", rec.Code)
	}
}

// tenantOnlyStore hides the token methods of a store.
type tenantOnlyStore struct{ store.TenantStore }

func TestTokenRejectedWithoutTokenStore(t *testing.T) {
	f := newPATFixture(t)
	rec, p := run(t, f.config(), tenantOnlyStore{f.st.Store}, f.secret)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Fatal("handler reached")
	}
}
