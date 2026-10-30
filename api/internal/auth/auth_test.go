package auth_test

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
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
	testAudience = "https://api.opsvision.example.test"
	testNS       = "https://opsvision/"
	devSecret    = "0123456789abcdef0123456789abcdef" // 32 bytes, synthetic
)

// rsaFixture is a signing key plus a JWKS server publishing its public half.
type rsaFixture struct {
	key    *rsa.PrivateKey
	kid    string
	server *httptest.Server
	hits   atomic.Int32
}

func newRSAFixture(t *testing.T, kid string) *rsaFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &rsaFixture{key: key, kid: kid}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		// A long max-age must not extend the cache beyond the fixed cap.
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_ = json.NewEncoder(w).Encode(jwksFor(&key.PublicKey, kid))
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *rsaFixture) issuer() string { return f.server.URL + "/" }

// claims builds a custom-claims map; zero-value options are valid tokens.
type tokOpts struct {
	issuer    string
	audience  string
	subject   string
	expiry    time.Duration // relative to now; default +1h
	notBefore time.Duration
	extra     map[string]any
	noExp     bool
}

func (o tokOpts) build() map[string]any {
	now := time.Now()
	exp := o.expiry
	if exp == 0 {
		exp = time.Hour
	}
	m := map[string]any{
		"iss": o.issuer,
		"aud": o.audience,
		"sub": o.subject,
		"iat": now.Add(-time.Minute).Unix(),
	}
	if !o.noExp {
		m["exp"] = now.Add(exp).Unix()
	}
	if o.notBefore != 0 {
		m["nbf"] = now.Add(o.notBefore).Unix()
	}
	for k, v := range o.extra {
		m[k] = v
	}
	return m
}

// jwksFor builds a JWKS document by hand (no JOSE library) for an RSA key.
func jwksFor(pub *rsa.PublicKey, kid string) map[string]any {
	return map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
		"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}}
}

// sign builds a compact JWS by hand. alg is "RS256" (key *rsa.PrivateKey) or
// "HS256" (key []byte).
func sign(t *testing.T, alg string, key any, kid string, claims map[string]any) string {
	t.Helper()
	hdr := map[string]string{"alg": alg, "typ": "JWT"}
	if kid != "" {
		hdr["kid"] = kid
	}
	hb, err := json.Marshal(hdr)
	if err != nil {
		t.Fatal(err)
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	input := b64(hb) + "." + b64(cb)
	var sig []byte
	switch alg {
	case "RS256":
		sum := sha256.Sum256([]byte(input))
		sig, err = rsa.SignPKCS1v15(rand.Reader, key.(*rsa.PrivateKey), crypto.SHA256, sum[:])
		if err != nil {
			t.Fatal(err)
		}
	case "HS256":
		mac := hmac.New(sha256.New, key.([]byte))
		mac.Write([]byte(input))
		sig = mac.Sum(nil)
	default:
		t.Fatalf("unsupported alg %q", alg)
	}
	return input + "." + b64(sig)
}

func (f *rsaFixture) token(t *testing.T, o tokOpts) string {
	t.Helper()
	if o.issuer == "" {
		o.issuer = f.issuer()
	}
	if o.audience == "" {
		o.audience = testAudience
	}
	if o.subject == "" {
		o.subject = "auth0|user-1"
	}
	return sign(t, "RS256", f.key, f.kid, o.build())
}

func newStore(t *testing.T) store.TenantStore {
	t.Helper()
	ts := memstore.New()
	err := ts.CreateTenant(context.Background(), domain.Tenant{
		ID: "t1", Name: "Tenant One", Auth0OrgID: "org_1", DefaultRole: domain.RoleViewer,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ts
}

func auth0Config(f *rsaFixture) auth.Config {
	return auth.Config{
		Mode:           "auth0",
		Domain:         "tenant.example.test",
		IssuerURL:      f.issuer(),
		Audience:       testAudience,
		ClaimNamespace: testNS,
	}
}

// run sends a request with the bearer token through the middleware and returns
// the recorded response plus the principal the downstream handler saw (if it
// was reached).
func run(t *testing.T, cfg auth.Config, ts store.TenantStore, bearer string) (*httptest.ResponseRecorder, *auth.Principal) {
	t.Helper()
	mw, err := auth.Middleware(cfg, ts)
	if err != nil {
		t.Fatalf("Middleware: %v", err)
	}
	var got *auth.Principal
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := auth.FromContext(r.Context())
		if !ok {
			t.Error("principal missing from context")
			return
		}
		got = &p
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/x", nil)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, got
}

type envelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, code, message string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body not an error envelope: %v: %s", err, rec.Body.String())
	}
	if env.Error.Code != code {
		t.Errorf("code = %q, want %q", env.Error.Code, code)
	}
	if message != "" && env.Error.Message != message {
		t.Errorf("message = %q, want %q", env.Error.Message, message)
	}
}

func orgClaims(extra map[string]any) map[string]any {
	m := map[string]any{
		"org_id":         "org_1",
		testNS + "email": "Jane.Doe@Example.test",
		testNS + "name":  "Jane Doe",
		// Verified by default; tests override or delete (nil) to vary it.
		testNS + "email_verified": true,
	}
	for k, v := range extra {
		if v == nil {
			delete(m, k)
			continue
		}
		m[k] = v
	}
	return m
}

func TestRS256ValidToken(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	tok := f.token(t, tokOpts{extra: orgClaims(nil)})

	rec, p := run(t, auth0Config(f), ts, tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if p.UserID != "auth0|user-1" {
		t.Errorf("UserID = %q", p.UserID)
	}
	if p.Tenant == nil || p.Tenant.ID != "t1" {
		t.Fatalf("Tenant = %+v, want t1", p.Tenant)
	}
	if p.Email != "Jane.Doe@Example.test" || p.Name != "Jane Doe" {
		t.Errorf("Email/Name = %q/%q", p.Email, p.Name)
	}
	if p.IsOperator {
		t.Error("IsOperator = true, want false")
	}
	if p.Membership == nil || p.Membership.UserID != "auth0|user-1" {
		t.Errorf("Membership = %+v", p.Membership)
	}
}

func TestJWKSCacheIsCappedAtFiveMinutes(t *testing.T) {
	f := newRSAFixture(t, "kid-1") // serves Cache-Control: max-age=86400
	ts := newStore(t)
	clock := time.Now()
	cfg := auth0Config(f)
	cfg.SetClock(func() time.Time { return clock })
	mw, err := auth.Middleware(cfg, ts)
	if err != nil {
		t.Fatal(err)
	}
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	call := func(label string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+f.token(t, tokOpts{extra: orgClaims(nil)}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", label, rec.Code, rec.Body.String())
		}
	}
	for i := 0; i < 3; i++ {
		call("initial")
	}
	if n := f.hits.Load(); n != 1 {
		t.Fatalf("JWKS fetched %d times, want 1 (cached)", n)
	}
	clock = clock.Add(5*time.Minute - time.Second)
	call("just before cap")
	if n := f.hits.Load(); n != 1 {
		t.Fatalf("JWKS fetched %d times just before the cap, want 1", n)
	}
	clock = clock.Add(2 * time.Second)
	call("just after cap")
	if n := f.hits.Load(); n != 2 {
		t.Fatalf("JWKS fetched %d times after the cap, want 2 (despite max-age=86400)", n)
	}
	call("cached again")
	if n := f.hits.Load(); n != 2 {
		t.Fatalf("JWKS fetched %d times, want 2", n)
	}
}

func TestJWKSNoStaleKeysPastCap(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	clock := time.Now()
	cfg := auth0Config(f)
	cfg.SetClock(func() time.Time { return clock })
	tok := f.token(t, tokOpts{extra: orgClaims(nil)})
	mw, _ := auth.Middleware(cfg, newStore(t))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	do := func() int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := do(); c != http.StatusOK {
		t.Fatalf("status %d", c)
	}
	f.server.Close()
	clock = clock.Add(6 * time.Minute)
	if c := do(); c != http.StatusServiceUnavailable {
		t.Fatalf("status %d past the cap with the JWKS endpoint down, want 503 (no stale keys)", c)
	}
}

func TestRejectsMissingOrMalformedToken(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	cfg := auth0Config(f)

	rec, p := run(t, cfg, ts, "")
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("handler reached without a token")
	}
	rec, p = run(t, cfg, ts, "not-a-jwt")
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("handler reached with a garbage token")
	}

	// Wrong scheme.
	mw, _ := auth.Middleware(cfg, ts)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("reached") }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Basic abc")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	wantError(t, rr, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsWrongAudience(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{audience: "https://other.example.test", extra: orgClaims(nil)})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("handler reached")
	}
}

func TestRejectsWrongIssuer(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{issuer: "https://evil.example.test/", extra: orgClaims(nil)})
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsExpired(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	// Beyond the 60s leeway.
	tok := f.token(t, tokOpts{expiry: -5 * time.Minute, extra: orgClaims(nil)})
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestAcceptsExpiryWithinLeeway(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{expiry: -30 * time.Second, extra: orgClaims(nil)})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRejectsNotYetValid(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{notBefore: 10 * time.Minute, extra: orgClaims(nil)})
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsTokenWithoutExpiry(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{noExp: true, extra: orgClaims(nil)})
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsTokenWithoutSubject(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	claims := tokOpts{issuer: f.issuer(), audience: testAudience, extra: orgClaims(nil)}.build()
	delete(claims, "sub")
	tok := sign(t, "RS256", f.key, f.kid, claims)
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsWrongSigningKey(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := tokOpts{issuer: f.issuer(), audience: testAudience, subject: "u", extra: orgClaims(nil)}.build()
	tok := sign(t, "RS256", other, "kid-1", claims)
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestRejectsHS256InAuth0Mode(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	// A dev token (HS256) with otherwise-correct issuer/audience claims.
	claims := tokOpts{issuer: f.issuer(), audience: testAudience, subject: "u", extra: orgClaims(nil)}.build()
	tok := sign(t, "HS256", []byte(devSecret), "", claims)
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("handler reached")
	}

	// And a genuine IssueDevToken token.
	dev, err := auth.IssueDevToken(devSecret, "u", "a@example.test", "A", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	rec, p = run(t, auth0Config(f), newStore(t), dev)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("dev token accepted in auth0 mode")
	}
}

func TestRejectsRS256InDevMode(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	cfg := auth.Config{Mode: "dev", DevSecret: devSecret, Audience: "opsvision-dev", ClaimNamespace: testNS}
	claims := tokOpts{issuer: "opsvision-dev", audience: "opsvision-dev", subject: "u", extra: orgClaims(nil)}.build()
	tok := sign(t, "RS256", f.key, f.kid, claims)
	rec, p := run(t, cfg, newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("RS256 token accepted in dev mode")
	}
}

func TestRejectsAlgNone(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	// header {"alg":"none"} . claims . (empty signature)
	hdr := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"
	body, _ := json.Marshal(tokOpts{issuer: f.issuer(), audience: testAudience, subject: "u", extra: orgClaims(nil)}.build())
	tok := hdr + "." + b64(body) + "."
	rec, _ := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestUnknownOrganizationIs403(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{"org_id": "org_unknown"})})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusForbidden, "forbidden", "organization is not provisioned")
	if p != nil {
		t.Error("handler reached")
	}
}

func TestNoOrgNonOperatorIs403(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: map[string]any{testNS + "email": "x@example.test"}})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusForbidden, "forbidden", "no organization in token")
	if p != nil {
		t.Error("handler reached")
	}
}

func TestOperatorPermission(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: map[string]any{
		"permissions":    []string{"operate:platform"},
		testNS + "email": "ops@example.test",
		testNS + "name":  "Ops Person",
	}})
	ts := newStore(t)
	rec, p := run(t, auth0Config(f), ts, tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !p.IsOperator {
		t.Error("IsOperator = false")
	}
	if p.Tenant != nil || p.Membership != nil {
		t.Errorf("Tenant/Membership = %+v/%+v, want nil", p.Tenant, p.Membership)
	}
}

func TestOtherPermissionsDoNotMakeOperator(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{"permissions": []string{"read:stuff", "operate:platformx"}})})
	_, p := run(t, auth0Config(f), newStore(t), tok)
	if p == nil || p.IsOperator {
		t.Fatalf("principal = %+v, want non-operator", p)
	}
}

func TestOperatorWithOrgGetsNoAutoMembership(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	tok := f.token(t, tokOpts{subject: "auth0|ops", extra: orgClaims(map[string]any{"permissions": []string{"operate:platform"}})})
	rec, p := run(t, auth0Config(f), ts, tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if p.Tenant == nil || p.Tenant.ID != "t1" || !p.IsOperator {
		t.Fatalf("principal = %+v", p)
	}
	if p.Membership != nil {
		t.Errorf("operator was auto-provisioned a membership: %+v", p.Membership)
	}
	if _, err := ts.GetMembership(context.Background(), "t1", "auth0|ops"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("membership stored for operator: err=%v", err)
	}
}

func TestFirstLoginCreatesDefaultMembership(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	tok := f.token(t, tokOpts{extra: orgClaims(nil)})

	before := time.Now()
	_, p := run(t, auth0Config(f), ts, tok)
	if p == nil || p.Membership == nil {
		t.Fatalf("principal = %+v", p)
	}
	if p.Membership.Role != domain.RoleViewer {
		t.Errorf("role = %q, want viewer", p.Membership.Role)
	}
	m, err := ts.GetMembership(context.Background(), "t1", "auth0|user-1")
	if err != nil {
		t.Fatal(err)
	}
	if m.Role != domain.RoleViewer || m.Email != "Jane.Doe@Example.test" || m.Name != "Jane Doe" {
		t.Errorf("stored membership = %+v", m)
	}
	if m.CreatedAt.Before(before.Add(-time.Second)) {
		t.Errorf("CreatedAt = %v, want ~now", m.CreatedAt)
	}

	// Second login does not rewrite the membership.
	created := m.CreatedAt
	_, p = run(t, auth0Config(f), ts, tok)
	if p == nil || !p.Membership.CreatedAt.Equal(created) {
		t.Errorf("second login changed membership: %+v", p)
	}
}

func TestFirstLoginUsesTenantDefaultRole(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := memstore.New()
	if err := ts.CreateTenant(context.Background(), domain.Tenant{ID: "t1", Auth0OrgID: "org_1", DefaultRole: domain.RoleContributor}); err != nil {
		t.Fatal(err)
	}
	_, p := run(t, auth0Config(f), ts, f.token(t, tokOpts{extra: orgClaims(nil)}))
	if p == nil || p.Membership.Role != domain.RoleContributor {
		t.Fatalf("principal = %+v", p)
	}
}

func TestFirstLoginEmptyDefaultRoleIsViewer(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := memstore.New()
	if err := ts.CreateTenant(context.Background(), domain.Tenant{ID: "t1", Auth0OrgID: "org_1"}); err != nil {
		t.Fatal(err)
	}
	_, p := run(t, auth0Config(f), ts, f.token(t, tokOpts{extra: orgClaims(nil)}))
	if p == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v", p)
	}
}

func TestPendingMembershipBoundByEmail(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	ctx := context.Background()
	invited := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	err := ts.PutMembership(ctx, "t1", domain.Membership{
		UserID: pendingID, Email: "jane.doe@example.test", Role: domain.RoleAdmin,
		Scope:     domain.Scope{OrgUnitIDs: []string{"payments"}, MetricKeys: []string{"uptime"}},
		CreatedAt: invited,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Token email has different case from the invited address.
	_, p := run(t, auth0Config(f), ts, f.token(t, tokOpts{extra: orgClaims(nil)}))
	if p == nil || p.Membership == nil {
		t.Fatalf("principal = %+v", p)
	}
	m := p.Membership
	if m.UserID != "auth0|user-1" || m.Role != domain.RoleAdmin {
		t.Errorf("membership = %+v, want sub-bound admin", m)
	}
	if len(m.Scope.OrgUnitIDs) != 1 || m.Scope.OrgUnitIDs[0] != "payments" || len(m.Scope.MetricKeys) != 1 {
		t.Errorf("scope not preserved: %+v", m.Scope)
	}
	if m.Email != "Jane.Doe@Example.test" || m.Name != "Jane Doe" {
		t.Errorf("email/name not taken from token: %+v", m)
	}
	if !m.CreatedAt.Equal(invited) {
		t.Errorf("CreatedAt = %v, want invite time %v", m.CreatedAt, invited)
	}
	if _, err := ts.GetMembership(ctx, "t1", pendingID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("pending membership not deleted: %v", err)
	}
	stored, err := ts.GetMembership(ctx, "t1", "auth0|user-1")
	if err != nil || stored.Role != domain.RoleAdmin {
		t.Errorf("stored = %+v, err=%v", stored, err)
	}
}

func TestPendingBindingSkippedWhenEmailUnverified(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	ctx := context.Background()
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	_ = ts.PutMembership(ctx, "t1", domain.Membership{UserID: pendingID, Role: domain.RoleAdmin})

	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{testNS + "email_verified": false})})
	_, p := run(t, auth0Config(f), ts, tok)
	if p == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want default viewer", p)
	}
	if _, err := ts.GetMembership(ctx, "t1", pendingID); err != nil {
		t.Errorf("pending membership must remain: %v", err)
	}
}

func TestPendingBindingSkippedWhenEmailVerifiedClaimMissing(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	ctx := context.Background()
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	_ = ts.PutMembership(ctx, "t1", domain.Membership{UserID: pendingID, Role: domain.RoleAdmin})

	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{testNS + "email_verified": nil})})
	_, p := run(t, auth0Config(f), ts, tok)
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want default viewer when email_verified is absent", p)
	}
	if _, err := ts.GetMembership(ctx, "t1", pendingID); err != nil {
		t.Errorf("pending membership must remain: %v", err)
	}
}

func TestDevTokenBindsPendingInvitation(t *testing.T) {
	ts := newStore(t)
	ctx := context.Background()
	pendingID := store.PendingUserPrefix + "alice@example.test"
	_ = ts.PutMembership(ctx, "t1", domain.Membership{UserID: pendingID, Role: domain.RoleAdmin})
	tok, err := auth.IssueDevToken(devSecret, "dev|alice", "Alice@Example.test", "Alice", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	_, p := run(t, auth.Config{Mode: "dev", DevSecret: devSecret}, ts, tok)
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin || p.Membership.UserID != "dev|alice" {
		t.Fatalf("principal = %+v, want bound admin (dev tokens emit email_verified)", p)
	}
}

func TestRejectsPendingPrefixedSubject(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	sub := store.PendingUserPrefix + "jane.doe@example.test"

	rec, p := run(t, auth0Config(f), newStore(t), f.token(t, tokOpts{subject: sub, extra: orgClaims(nil)}))
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("auth0 mode accepted a pending: subject")
	}

	dev, err := auth.IssueDevToken(devSecret, sub, "jane.doe@example.test", "J", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	rec, p = run(t, auth.Config{Mode: "dev", DevSecret: devSecret}, newStore(t), dev)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("dev mode accepted a pending: subject")
	}
}

func TestRejectsHS256SignedWithRSAPublicKey(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	der, err := x509.MarshalPKIXPublicKey(&f.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	claims := tokOpts{issuer: f.issuer(), audience: testAudience, subject: "u", extra: orgClaims(nil)}.build()
	for name, secret := range map[string][]byte{"pem": pemKey, "der": der, "modulus": f.key.PublicKey.N.Bytes()} {
		for _, kid := range []string{"", f.kid} {
			tok := sign(t, "HS256", secret, kid, claims)
			rec, p := run(t, auth0Config(f), newStore(t), tok)
			if rec.Code != http.StatusUnauthorized || p != nil {
				t.Errorf("%s/kid=%q: status %d, handler reached=%v; want 401", name, kid, rec.Code, p != nil)
			}
		}
	}
}

func TestRejectsUnknownKid(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	claims := tokOpts{issuer: f.issuer(), audience: testAudience, subject: "u", extra: orgClaims(nil)}.build()
	tok := sign(t, "RS256", f.key, "kid-unknown", claims)
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("handler reached")
	}
}

func TestAcceptsAudienceArrayContainingOurs(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{"aud": []string{"https://other.example.test", testAudience}})})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	tok = f.token(t, tokOpts{extra: orgClaims(map[string]any{"aud": []string{"https://other.example.test"}})})
	rec, _ = run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestMissingEmailSkipsPendingLookup(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	ctx := context.Background()
	// A pending record under the empty email must never be bound.
	_ = ts.PutMembership(ctx, "t1", domain.Membership{UserID: store.PendingUserPrefix, Role: domain.RoleAdmin})

	tok := f.token(t, tokOpts{extra: map[string]any{"org_id": "org_1"}})
	_, p := run(t, auth0Config(f), ts, tok)
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleViewer {
		t.Fatalf("principal = %+v, want default viewer", p)
	}
}

// failingDeleteStore wraps a TenantStore so DeleteMembership fails.
type failingDeleteStore struct{ store.TenantStore }

func (failingDeleteStore) DeleteMembership(context.Context, string, string) error {
	return errors.New("boom")
}

func TestPendingDeleteFailureDoesNotFailRequest(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	base := newStore(t)
	ctx := context.Background()
	pendingID := store.PendingUserPrefix + "jane.doe@example.test"
	_ = base.PutMembership(ctx, "t1", domain.Membership{UserID: pendingID, Role: domain.RoleAdmin})

	rec, p := run(t, auth0Config(f), failingDeleteStore{base}, f.token(t, tokOpts{extra: orgClaims(nil)}))
	if rec.Code != http.StatusNoContent || p == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("status = %d principal = %+v", rec.Code, p)
	}
}

// racingStore simulates a concurrent request that bound the pending
// membership between this request's first GetMembership and its fallback.
type racingStore struct {
	store.TenantStore
	gets int
}

func (r *racingStore) GetMembership(ctx context.Context, tenantID, userID string) (domain.Membership, error) {
	r.gets++
	if r.gets == 1 {
		// First read sees nothing; then the "other request" completes its
		// bind (put admin, delete pending) before we continue.
		_, err := r.TenantStore.GetMembership(ctx, tenantID, userID)
		_ = r.TenantStore.PutMembership(ctx, tenantID, domain.Membership{UserID: userID, Role: domain.RoleAdmin})
		_ = r.TenantStore.DeleteMembership(ctx, tenantID, store.PendingUserPrefix+"jane.doe@example.test")
		return domain.Membership{}, err
	}
	return r.TenantStore.GetMembership(ctx, tenantID, userID)
}

func TestConcurrentBindDoesNotDowngrade(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	base := newStore(t)
	rs := &racingStore{TenantStore: base}
	_, p := run(t, auth0Config(f), rs, f.token(t, tokOpts{extra: orgClaims(nil)}))
	if p == nil || p.Membership == nil || p.Membership.Role != domain.RoleAdmin {
		t.Fatalf("principal = %+v, want the concurrently bound admin membership kept", p)
	}
	m, _ := base.GetMembership(context.Background(), "t1", "auth0|user-1")
	if m.Role != domain.RoleAdmin {
		t.Errorf("stored role = %q, want admin", m.Role)
	}
}

// errStore fails tenant lookups with a non-NotFound error.
type errStore struct{ store.TenantStore }

func (errStore) TenantByAuth0Org(context.Context, string) (domain.Tenant, error) {
	return domain.Tenant{}, errors.New("dynamo unavailable")
}

func TestStoreFailureIs500NotForbidden(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	rec, p := run(t, auth0Config(f), errStore{newStore(t)}, f.token(t, tokOpts{extra: orgClaims(nil)}))
	wantError(t, rec, http.StatusInternalServerError, "internal", "")
	if strings.Contains(rec.Body.String(), "dynamo") {
		t.Error("internal error detail leaked to client")
	}
	if p != nil {
		t.Error("handler reached")
	}
}

func TestClaimNamespaceDefault(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	cfg := auth0Config(f)
	cfg.ClaimNamespace = ""
	_, p := run(t, cfg, newStore(t), f.token(t, tokOpts{extra: orgClaims(nil)}))
	if p == nil || p.Email != "Jane.Doe@Example.test" {
		t.Fatalf("principal = %+v", p)
	}
}

func TestIdentityComesOnlyFromToken(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	ts := newStore(t)
	tok := f.token(t, tokOpts{extra: orgClaims(nil)})
	mw, _ := auth.Middleware(auth0Config(f), ts)
	var got auth.Principal
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got, _ = auth.FromContext(r.Context()) }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("X-Tenant-Id", "t-other")
	req.Header.Set("X-User-Id", "attacker")
	req.URL.RawQuery = "tenant=t-other&user=attacker"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got.Tenant == nil || got.Tenant.ID != "t1" || got.UserID != "auth0|user-1" {
		t.Fatalf("principal = %+v", got)
	}
}

func TestMiddlewareConfigErrors(t *testing.T) {
	ts := memstore.New()
	cases := map[string]auth.Config{
		"short secret":      {Mode: "dev", DevSecret: "too-short"},
		"empty secret":      {Mode: "dev"},
		"31 byte secret":    {Mode: "dev", DevSecret: strings.Repeat("a", 31)},
		"unknown mode":      {Mode: "basic"},
		"empty mode":        {},
		"auth0 no domain":   {Mode: "auth0", Audience: testAudience},
		"auth0 no audience": {Mode: "auth0", Domain: "tenant.example.test"},
	}
	for name, cfg := range cases {
		if _, err := auth.Middleware(cfg, ts); err == nil {
			t.Errorf("%s: want error, got nil", name)
		}
	}
	if _, err := auth.Middleware(auth.Config{Mode: "dev", DevSecret: strings.Repeat("a", 32)}, ts); err != nil {
		t.Errorf("32-byte secret rejected: %v", err)
	}
	if _, err := auth.Middleware(auth.Config{Mode: "dev", DevSecret: strings.Repeat("a", 32)}, nil); err == nil {
		t.Error("nil store: want error")
	}
}

func TestIssueDevTokenRoundTrip(t *testing.T) {
	ts := newStore(t)
	cfg := auth.Config{Mode: "dev", DevSecret: devSecret}
	tok, err := auth.IssueDevToken(devSecret, "dev|alice", "alice@example.test", "Alice", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	rec, p := run(t, cfg, ts, tok)
	if rec.Code != http.StatusNoContent || p == nil {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if p.UserID != "dev|alice" || p.Email != "alice@example.test" || p.Name != "Alice" || p.Tenant == nil || p.Tenant.ID != "t1" || p.IsOperator {
		t.Errorf("principal = %+v", p)
	}

	// Operator token without an org.
	tok, err = auth.IssueDevToken(devSecret, "dev|ops", "ops@example.test", "Ops", "", true)
	if err != nil {
		t.Fatal(err)
	}
	_, p = run(t, cfg, ts, tok)
	if p == nil || !p.IsOperator || p.Tenant != nil {
		t.Errorf("operator principal = %+v", p)
	}
}

func TestIssueDevTokenExpiryIs12h(t *testing.T) {
	tok, err := auth.IssueDevToken(devSecret, "u", "e@example.test", "N", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	// Verify the HS256 signature independently of the middleware.
	mac := hmac.New(sha256.New, []byte(devSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if got := b64(mac.Sum(nil)); got != parts[2] {
		t.Errorf("signature mismatch")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Iss string `json:"iss"`
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if c.Iss != "opsvision-dev" || c.Aud != "opsvision-dev" {
		t.Errorf("iss/aud = %q/%q", c.Iss, c.Aud)
	}
	d := time.Until(time.Unix(c.Exp, 0))
	if d < 11*time.Hour+59*time.Minute || d > 12*time.Hour+time.Minute {
		t.Errorf("expiry in %v, want ~12h", d)
	}
}

func TestIssueDevTokenRejectsShortSecret(t *testing.T) {
	if _, err := auth.IssueDevToken("short", "u", "", "", "", false); err == nil {
		t.Error("want error for short secret")
	}
}

func TestDevModeCustomAudience(t *testing.T) {
	ts := newStore(t)
	cfg := auth.Config{Mode: "dev", DevSecret: devSecret, Audience: "custom-aud", ClaimNamespace: "https://ns.example.test/"}
	tok, err := auth.IssueDevTokenFor(cfg, "dev|bob", "bob@example.test", "Bob", "org_1", false)
	if err != nil {
		t.Fatal(err)
	}
	_, p := run(t, cfg, ts, tok)
	if p == nil || p.Email != "bob@example.test" {
		t.Fatalf("principal = %+v", p)
	}
	// The default-audience token must not be accepted by this config.
	def, _ := auth.IssueDevToken(devSecret, "dev|bob", "bob@example.test", "Bob", "org_1", false)
	rec, _ := run(t, cfg, ts, def)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestDevTokenWrongSecretRejected(t *testing.T) {
	ts := newStore(t)
	tok, _ := auth.IssueDevToken(strings.Repeat("z", 32), "u", "e@example.test", "N", "org_1", false)
	rec, _ := run(t, auth.Config{Mode: "dev", DevSecret: devSecret}, ts, tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestWithPrincipalRoundTrip(t *testing.T) {
	if _, ok := auth.FromContext(context.Background()); ok {
		t.Fatal("empty context has a principal")
	}
	want := auth.Principal{UserID: "u1", Email: "u1@example.test"}
	got, ok := auth.FromContext(auth.WithPrincipal(context.Background(), want))
	if !ok || got.UserID != "u1" {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func TestRejectsSenderConstrainedToken(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	tok := f.token(t, tokOpts{extra: orgClaims(map[string]any{"cnf": map[string]string{"jkt": "abc"}})})
	rec, p := run(t, auth0Config(f), newStore(t), tok)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
	if p != nil {
		t.Error("DPoP-bound token accepted as bearer")
	}
}

func TestRejectsDPoPScheme(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	mw, _ := auth.Middleware(auth0Config(f), newStore(t))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("reached") }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "DPoP "+f.token(t, tokOpts{extra: orgClaims(nil)}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	wantError(t, rec, http.StatusUnauthorized, "unauthorized", "")
}

func TestJWKSOutageIs503(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	cfg := auth0Config(f)
	tok := f.token(t, tokOpts{extra: orgClaims(nil)})
	f.server.Close()
	rec, p := run(t, cfg, newStore(t), tok)
	wantError(t, rec, http.StatusServiceUnavailable, "unavailable", "")
	if p != nil {
		t.Error("handler reached")
	}
}
