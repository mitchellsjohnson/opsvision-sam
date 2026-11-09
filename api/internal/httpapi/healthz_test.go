package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHealthz(t *testing.T) {
	e := newTestEnv(t)

	// No token: the load balancer's health check carries none.
	resp, err := http.Get(e.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /healthz = %d, want 200", resp.StatusCode)
	}
	if got := strings.TrimSpace(string(body)); got != `{"status":"ok"}` {
		t.Errorf("body = %q", got)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}

	// Only GET (and HEAD) is served; /v1 stays behind authentication.
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/healthz", nil)
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /healthz = %d, want 405", r2.StatusCode)
	}
	e.expectError(t, 401, "unauthorized", "", "GET", "/scorecards", nil)
}
