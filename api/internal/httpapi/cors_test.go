package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func corsFixture(allowed string) (http.Handler, *int) {
	reached := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached++
		w.WriteHeader(http.StatusUnauthorized) // stands in for the auth middleware
	})
	return CORS(allowed)(next), &reached
}

func preflight(h http.Handler, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodOptions, "/v1/scorecards", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	r.Header.Set("Access-Control-Request-Method", "POST")
	r.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCORSPreflightAllowsOnlyConfiguredOrigin(t *testing.T) {
	const allowed = "https://app.example.test"
	h, reached := corsFixture(allowed)

	w := preflight(h, allowed)
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", w.Code)
	}
	if *reached != 0 {
		t.Fatal("preflight must be answered before the auth middleware")
	}
	want := map[string]string{
		"Access-Control-Allow-Origin":  allowed,
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age":       "600",
	}
	for k, v := range want {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Allow-Credentials = %q, want unset (bearer tokens, no cookies)", got)
	}
	if v := w.Header().Values("Vary"); len(v) == 0 {
		t.Error("Vary: Origin missing")
	}

	for _, origin := range []string{
		"https://evil.example.test",
		"https://app.example.test.evil.test",
		"http://app.example.test",
		"https://APP.example.test",
		"https://app.example.test/",
		"null",
		"",
	} {
		w := preflight(h, origin)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q: Allow-Origin = %q, want none", origin, got)
		}
		if got := w.Header().Get("Access-Control-Allow-Methods"); got != "" {
			t.Errorf("origin %q: Allow-Methods = %q, want none", origin, got)
		}
		if w.Code != http.StatusNoContent {
			t.Errorf("origin %q: status = %d, want 204", origin, w.Code)
		}
	}
}

func TestCORSSimpleRequests(t *testing.T) {
	const allowed = "https://app.example.test"
	h, reached := corsFixture(allowed)

	r := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	r.Header.Set("Origin", allowed)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if *reached != 1 || w.Code != http.StatusUnauthorized {
		t.Fatalf("actual request must reach the handler: reached=%d code=%d", *reached, w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != allowed {
		t.Errorf("Allow-Origin on actual response = %q, want %q (errors included)", got, allowed)
	}

	r = httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	r.Header.Set("Origin", "https://evil.example.test")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin for foreign origin = %q, want none", got)
	}
}

func TestCORSEmptyAllowedOriginAllowsNone(t *testing.T) {
	h, _ := corsFixture("")
	for _, origin := range []string{"https://app.example.test", "*", ""} {
		w := preflight(h, origin)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q: Allow-Origin = %q, want none", origin, got)
		}
	}
}

func TestCORSNeverReflectsWildcard(t *testing.T) {
	h, _ := corsFixture("*")
	w := preflight(h, "https://app.example.test")
	if got := w.Header().Get("Access-Control-Allow-Origin"); got == "*" || got == "https://app.example.test" {
		t.Errorf("a wildcard configuration must not allow arbitrary origins, got %q", got)
	}
}
