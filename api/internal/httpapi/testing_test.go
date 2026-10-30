package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store/memstore"
)

// testSecret is a synthetic dev-mode signing secret (32 bytes).
const testSecret = "0123456789abcdef0123456789abcdef"

// testNow is the fixed clock of the test server: mid fiscal year 2026 for a
// January fiscal-year start (month 2026-M10).
var testNow = time.Date(2026, time.October, 15, 12, 0, 0, 0, time.UTC)

// testEnv is a running test API with its backing store.
type testEnv struct {
	srv    *httptest.Server
	store  *memstore.Store
	tokens map[string]string
}

// newTestAPI starts the API over an in-memory store with dev-mode auth and
// returns the server plus tokens keyed "operator" and "<tenant>-<role>"
// (t1-admin, t1-contributor, t1-viewer, t2-admin, ...). Tenants t1 and t2
// have Auth0 organizations org_t1 and org_t2.
func newTestAPI(t *testing.T) (*httptest.Server, map[string]string) {
	t.Helper()
	env := newTestEnv(t)
	return env.srv, env.tokens
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	st := memstore.New()
	ctx := context.Background()
	tokens := map[string]string{}

	cfg := auth.Config{Mode: auth.ModeDev, DevSecret: testSecret}
	mint := func(name, userID, orgID string, op bool) {
		tok, err := auth.IssueDevToken(testSecret, userID, userID+"@example.test", "User "+userID, orgID, op)
		if err != nil {
			t.Fatal(err)
		}
		tokens[name] = tok
	}

	for _, id := range []string{"t1", "t2"} {
		tenant := domain.Tenant{
			ID:                   id,
			Name:                 "Tenant " + id,
			Auth0OrgID:           "org_" + id,
			FiscalYearStartMonth: time.January,
			StatusScale:          domain.DefaultStatusScale(),
			DefaultRole:          domain.RoleViewer,
			CreatedAt:            testNow,
		}
		if err := st.CreateTenant(ctx, tenant); err != nil {
			t.Fatal(err)
		}
		for _, role := range []domain.Role{domain.RoleAdmin, domain.RoleContributor, domain.RoleViewer} {
			userID := fmt.Sprintf("u-%s-%s", id, role)
			m := domain.Membership{
				UserID:    userID,
				Email:     userID + "@example.test",
				Name:      "User " + userID,
				Role:      role,
				Scope:     domain.Scope{OrgUnitIDs: []string{}, MetricKeys: []string{}},
				CreatedAt: testNow,
			}
			if err := st.PutMembership(ctx, id, m); err != nil {
				t.Fatal(err)
			}
			mint(id+"-"+string(role), userID, "org_"+id, false)
		}
	}
	mint("operator", "u-operator", "", true)

	authMW, err := auth.Middleware(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	var n atomic.Int64
	s := NewServer(Deps{
		Store: st,
		Now:   func() time.Time { return testNow },
		NewID: func() string { return fmt.Sprintf("id-%04d", n.Add(1)) },
	})
	srv := httptest.NewServer(NewHandler(s, authMW))
	t.Cleanup(srv.Close)
	return &testEnv{srv: srv, store: st, tokens: tokens}
}

// call sends a request to the API under /v1. body may be nil, a string (sent
// verbatim), or a value to encode as JSON.
func (e *testEnv) call(t *testing.T, token, method, path string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rdr = bytes.NewBufferString(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.srv.URL+"/v1"+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if rdr != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, raw
}

// expect calls the API, requires the wanted status, and decodes the JSON
// response into out (when non-nil).
func (e *testEnv) expect(t *testing.T, want int, token, method, path string, body, out any) {
	t.Helper()
	status, raw := e.call(t, token, method, path, body)
	if status != want {
		t.Fatalf("%s %s: status %d, want %d; body %s", method, path, status, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: decode %s: %v", method, path, raw, err)
		}
	}
}

// apiErrorBody is the decoded error envelope.
type apiErrorBody struct {
	Error struct {
		Code    string   `json:"code"`
		Message string   `json:"message"`
		Details []detail `json:"details"`
	} `json:"error"`
}

// expectError requires the wanted status and error code.
func (e *testEnv) expectError(t *testing.T, wantStatus int, wantCode, token, method, path string, body any) apiErrorBody {
	t.Helper()
	status, raw := e.call(t, token, method, path, body)
	var got apiErrorBody
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("%s %s: response is not an error envelope: %s", method, path, raw)
	}
	if status != wantStatus || got.Error.Code != wantCode {
		t.Fatalf("%s %s: got %d %q (%s), want %d %q", method, path, status, got.Error.Code, got.Error.Message, wantStatus, wantCode)
	}
	return got
}

// audits lists every audit entry of a tenant.
func (e *testEnv) audits(t *testing.T, tenantID string) []domain.AuditEntry {
	t.Helper()
	out, err := e.store.ListAudit(context.Background(), tenantID, time.Time{}, testNow.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return out
}
