package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }

func tenantWithFYStart(m int) domain.Tenant {
	return domain.Tenant{FiscalYearStartMonth: time.Month(m)}
}

func TestUnimplementedOperationReturns501Envelope(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct{ method, path string }{
		{"GET", "/audit?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z"},
		{"POST", "/imports/uploads"},
		{"GET", "/import-templates"},
	} {
		got := e.expectError(t, 501, "not_implemented", e.tokens["t1-admin"], tc.method, tc.path, nil)
		if got.Error.Message == "" {
			t.Errorf("%s %s: empty message", tc.method, tc.path)
		}
	}
	// Still behind authentication.
	e.expectError(t, 401, "unauthorized", "", "GET", "/scorecards", nil)
}

func TestMalformedJSONIsInvalidEnvelope(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	for _, body := range []string{`{`, `not json`, `[]`, `{"levels": "x"}`, ``} {
		e.expectError(t, 400, "invalid", admin, "PUT", "/org/levels", body)
	}
	// The response does not echo the offending bytes.
	got := e.expectError(t, 400, "invalid", admin, "POST", "/org/units", `{"id": "SECRET-ish`)
	if strings.Contains(got.Error.Message, "SECRET") {
		t.Errorf("message echoes the request: %q", got.Error.Message)
	}
}

func TestOversizedBodyIsRejected(t *testing.T) {
	e := newTestEnv(t)
	big := `{"name":"` + strings.Repeat("x", maxBodyBytes+10) + `"}`
	e.expectError(t, 400, "invalid", e.tokens["t1-admin"], "PATCH", "/org/units/acme", big)
}

func TestResponseErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"api error", conflict("dup"), 409, "conflict"},
		{"wrapped api error", fmt.Errorf("ctx: %w", forbidden("no")), 403, "forbidden"},
		{"store not found", fmt.Errorf("get: %w", store.ErrNotFound), 404, "not_found"},
		{"store conflict", fmt.Errorf("put: %w", store.ErrConflict), 409, "conflict"},
		{"conflict error type", &store.ConflictError{}, 409, "conflict"},
		{"other", errors.New("dynamodb: secret table name leaked"), 500, "internal"},
	} {
		rec := httptest.NewRecorder()
		responseErrorHandler(rec, httptest.NewRequest(http.MethodGet, "/v1/x", nil), tc.err)
		var got apiErrorBody
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: %v (%s)", tc.name, err, rec.Body)
		}
		if rec.Code != tc.wantStatus || got.Error.Code != tc.wantCode {
			t.Errorf("%s: got %d %q, want %d %q", tc.name, rec.Code, got.Error.Code, tc.wantStatus, tc.wantCode)
		}
		if tc.wantStatus == 500 && strings.Contains(rec.Body.String(), "secret") {
			t.Errorf("%s: internal error leaks detail: %s", tc.name, rec.Body)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: content type %q", tc.name, ct)
		}
	}
}

func TestNewServerDefaults(t *testing.T) {
	s := NewServer(Deps{Store: newTestEnv(t).store})
	id1, id2 := s.newID(), s.newID()
	if len(id1) != 26 || id1 == id2 {
		t.Errorf("default IDs = %q, %q; want distinct 26-char ULIDs", id1, id2)
	}
	if now := s.now(); now.Location().String() != "UTC" || now.IsZero() {
		t.Errorf("default now = %v", now)
	}
	if got := s.calendar(tenantWithFYStart(4)).FiscalYearStartMonth; got != 4 {
		t.Errorf("default calendar start = %v, want April", got)
	}
}

func TestNewServerAndHandlerRequireDeps(t *testing.T) {
	mustPanic := func(name string, f func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Errorf("%s did not panic", name)
			}
		}()
		f()
	}
	mustPanic("NewServer without store", func() { NewServer(Deps{}) })
	mustPanic("NewHandler without auth", func() { NewHandler(NewServer(Deps{Store: newTestEnv(t).store}), nil) })
}
