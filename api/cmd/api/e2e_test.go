package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"opsvision/internal/domain"
	"opsvision/internal/objects"
	"opsvision/internal/store/memstore"
)

const (
	e2eDomain   = "example.us.auth0.com"
	e2eAudience = "https://api.opsvision.test"
	e2eTenant   = "t-example"
	e2ePrefix   = "oidc|example-employees|"
	e2eAdminSub = e2ePrefix + "u-admin"
)

// identityProvider is a local stand-in for the identity provider at
// https://example.us.auth0.com: a JWKS for a test RSA key and a /userinfo
// that names the bearer token's own subject.
type identityProvider struct {
	key           *rsa.PrivateKey
	userInfoHits  atomic.Int32
	userInfoEmail string
}

// newIdentityProvider serves the provider over https and points
// http.DefaultTransport (which the API's JWKS and /userinfo clients use) at it
// for the duration of the test.
func newIdentityProvider(t *testing.T, userInfoEmail string) *identityProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &identityProvider{key: key, userInfoEmail: userInfoEmail}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "e2e",
			"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("GET /userinfo", func(w http.ResponseWriter, r *http.Request) {
		idp.userInfoHits.Add(1)
		sub, err := unverifiedSubject(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"sub": sub, "email": idp.userInfoEmail, "name": "Avery Admin"})
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)

	// Every connection goes to srv, verified against its certificate (issued
	// for example.com), whatever host the API asks for.
	tr := srv.Client().Transport.(*http.Transport).Clone()
	tr.TLSClientConfig.ServerName = "example.com"
	addr := srv.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	saved := http.DefaultTransport
	http.DefaultTransport = tr
	t.Cleanup(func() { http.DefaultTransport = saved })
	return idp
}

// token signs an access token for sub as the provider would issue it: no
// org_id and no email claim.
func (idp *identityProvider) token(t *testing.T, sub string) string {
	t.Helper()
	now := time.Now()
	enc := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	input := enc(map[string]string{"alg": "RS256", "typ": "JWT", "kid": "e2e"}) + "." + enc(map[string]any{
		"iss": "https://" + e2eDomain + "/", "aud": e2eAudience, "sub": sub,
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, idp.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func unverifiedSubject(tok string) (string, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("not a JWS")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	var c struct {
		Sub string `json:"sub"`
	}
	err = json.Unmarshal(raw, &c)
	return c.Sub, err
}

func e2eEnv() map[string]string {
	return map[string]string{
		"OPSVISION_AUTH_MODE":            "auth0",
		"OPSVISION_EVENT_SOURCE":         "alb",
		"OPSVISION_SERVE_WEB":            "1",
		"OPSVISION_WEB_AUTH0_CLIENT_ID":  "example-client-id",
		"OPSVISION_TENANT_ID":            e2eTenant,
		"OPSVISION_TRUSTED_SUB_PREFIXES": e2ePrefix,
		"OPSVISION_BOOTSTRAP_ADMINS":     "admin@example.test",
		"TABLE_NAME":                     "opsvision-example",
		"UPLOADS_BUCKET":                 "opsvision-example-uploads",
		"AUTH0_DOMAIN":                   e2eDomain,
		"AUTH0_AUDIENCE":                 e2eAudience,
		"AWS_REGION":                     "us-east-1",
	}
}

// TestLoadBalancerEndToEnd drives load balancer events through the real
// cmd/api handler in single-organization mode, serving the web app.
func TestLoadBalancerEndToEnd(t *testing.T) {
	idp := newIdentityProvider(t, "Admin@Example.test")
	cfg, err := loadConfig(env(e2eEnv()))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	st := memstore.New()
	if err := st.CreateTenant(ctx, domain.Tenant{ID: e2eTenant, Name: "Example Co", DefaultRole: domain.RoleViewer}); err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, st, objects.NewMem("", nil))
	if err != nil {
		t.Fatal(err)
	}
	serve, ok := lambdaHandler(cfg.EventSource, h).(func(context.Context, events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error))
	if !ok {
		t.Fatal("OPSVISION_EVENT_SOURCE=alb must serve load balancer events")
	}
	get := func(t *testing.T, path string, headers map[string]string) events.ALBTargetGroupResponse {
		t.Helper()
		mv := map[string][]string{"Host": {"ops.example.test"}, "X-Forwarded-Proto": {"https"}}
		for k, v := range headers {
			mv[k] = []string{v}
		}
		resp, err := serve(ctx, events.ALBTargetGroupRequest{HTTPMethod: http.MethodGet, Path: path, MultiValueHeaders: mv})
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		return resp
	}
	header := func(resp events.ALBTargetGroupResponse, name string) string {
		return http.Header(resp.MultiValueHeaders).Get(name)
	}
	adminToken := idp.token(t, e2eAdminSub)
	bearer := map[string]string{"Authorization": "Bearer " + adminToken}

	t.Run("bootstrap admin signs in", func(t *testing.T) {
		resp := get(t, "/v1/me", bearer)
		if resp.StatusCode != http.StatusOK || resp.IsBase64Encoded {
			t.Fatalf("GET /v1/me = %d (base64 %v): %s", resp.StatusCode, resp.IsBase64Encoded, resp.Body)
		}
		var me struct {
			UserID string `json:"userId"`
			Email  string `json:"email"`
			Role   string `json:"role"`
			Tenant struct {
				ID string `json:"id"`
			} `json:"tenant"`
		}
		if err := json.Unmarshal([]byte(resp.Body), &me); err != nil {
			t.Fatalf("GET /v1/me body: %v: %s", err, resp.Body)
		}
		if me.UserID != e2eAdminSub || me.Role != "admin" || me.Tenant.ID != e2eTenant || me.Email != "Admin@Example.test" {
			t.Errorf("GET /v1/me = %+v, want the bootstrap admin in %s", me, e2eTenant)
		}
		if got := header(resp, "Strict-Transport-Security"); !strings.HasPrefix(got, "max-age=") {
			t.Errorf("API Strict-Transport-Security = %q", got)
		}

		// Signed in again, the member needs no /userinfo call.
		if resp := get(t, "/v1/me", bearer); resp.StatusCode != http.StatusOK || !strings.Contains(resp.Body, "Admin@Example.test") {
			t.Errorf("second GET /v1/me = %d: %s", resp.StatusCode, resp.Body)
		}
		if n := idp.userInfoHits.Load(); n != 1 {
			t.Errorf("/userinfo called %d times, want 1 (the first sign-in)", n)
		}
	})

	t.Run("web app", func(t *testing.T) {
		resp := get(t, "/", nil)
		if resp.StatusCode != http.StatusOK || !strings.HasPrefix(header(resp, "Content-Type"), "text/html") ||
			!strings.Contains(strings.ToLower(resp.Body), "<!doctype html") {
			t.Fatalf("GET / = %d %q: %.200s", resp.StatusCode, header(resp, "Content-Type"), resp.Body)
		}
		for name, want := range map[string]string{
			"Strict-Transport-Security": "max-age=31536000",
			"X-Content-Type-Options":    "nosniff",
			"Referrer-Policy":           "strict-origin-when-cross-origin",
			"Content-Security-Policy":   "frame-ancestors 'none'",
		} {
			if got := header(resp, name); !strings.Contains(got, want) {
				t.Errorf("GET / %s = %q, want it to contain %q", name, got, want)
			}
		}
	})

	t.Run("runtime config", func(t *testing.T) {
		resp := get(t, "/config.json", nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /config.json = %d: %s", resp.StatusCode, resp.Body)
		}
		var got map[string]string
		if err := json.Unmarshal([]byte(resp.Body), &got); err != nil {
			t.Fatalf("GET /config.json body: %v: %s", err, resp.Body)
		}
		want := map[string]string{
			"authMode": "auth0", "auth0Domain": e2eDomain, "auth0ClientId": "example-client-id",
			"auth0Audience": e2eAudience, "apiUrl": "",
		}
		if len(got) != len(want) {
			t.Errorf("GET /config.json = %v, want exactly %v", got, want)
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("config %s = %q, want %q", k, got[k], v)
			}
		}
	})

	t.Run("health check", func(t *testing.T) {
		if resp := get(t, "/healthz", nil); resp.StatusCode != http.StatusOK || strings.TrimSpace(resp.Body) != `{"status":"ok"}` {
			t.Errorf("GET /healthz = %d %q", resp.StatusCode, resp.Body)
		}
	})

	t.Run("untrusted sub", func(t *testing.T) {
		hits := idp.userInfoHits.Load()
		for _, sub := range []string{"auth0|u-1", "oidc|example-contractors|u-1"} {
			resp := get(t, "/v1/me", map[string]string{"Authorization": "Bearer " + idp.token(t, sub)})
			if resp.StatusCode != http.StatusForbidden || !strings.Contains(resp.Body, `"forbidden"`) {
				t.Errorf("sub %s: GET /v1/me = %d %s, want 403", sub, resp.StatusCode, resp.Body)
			}
		}
		if n := idp.userInfoHits.Load(); n != hits {
			t.Errorf("/userinfo called for an untrusted sub")
		}
	})

	t.Run("large JSON is gzipped", func(t *testing.T) {
		// Enough members that the list is over the load balancer's 1 MB
		// limit uncompressed.
		const n = 6000
		for i := 0; i < n; i++ {
			if err := st.PutMembership(ctx, e2eTenant, domain.Membership{
				UserID: fmt.Sprintf("%su-%05d", e2ePrefix, i), Email: fmt.Sprintf("member-%05d@example.test", i),
				Name: fmt.Sprintf("Example Member Number %05d", i), Role: domain.RoleViewer,
				CreatedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
			}); err != nil {
				t.Fatal(err)
			}
		}

		resp := get(t, "/v1/members", map[string]string{"Authorization": "Bearer " + adminToken, "Accept-Encoding": "gzip, deflate, br"})
		if resp.StatusCode != http.StatusOK || !resp.IsBase64Encoded || header(resp, "Content-Encoding") != "gzip" {
			t.Fatalf("GET /v1/members = %d, base64 %v, Content-Encoding %q: %.200s",
				resp.StatusCode, resp.IsBase64Encoded, header(resp, "Content-Encoding"), resp.Body)
		}
		raw, err := base64.StdEncoding.DecodeString(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		plain, err := io.ReadAll(zr)
		if err != nil {
			t.Fatal(err)
		}
		if len(plain) <= 1_000_000 {
			t.Fatalf("uncompressed list is %d bytes; the test needs it over 1 MB", len(plain))
		}
		var list struct {
			Members []json.RawMessage `json:"members"`
		}
		if err := json.Unmarshal(plain, &list); err != nil || len(list.Members) != n+1 {
			t.Errorf("decoded %d members (%v), want %d", len(list.Members), err, n+1)
		}

		// Without gzip the same list cannot cross the load balancer.
		resp = get(t, "/v1/members", bearer)
		if resp.StatusCode != http.StatusBadGateway || !strings.Contains(resp.Body, "response_too_large") {
			t.Errorf("GET /v1/members without gzip = %d %.200s, want 502 response_too_large", resp.StatusCode, resp.Body)
		}
	})
}
