package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const goodSecret = "0123456789abcdef0123456789abcdef" // 32 bytes

func devOpts() options {
	return options{
		addr: ":8080", store: "memory", auth: "dev", seed: "demo",
		devSecret: goodSecret, allowedOrigin: "http://localhost:5173",
	}
}

func TestDevServerRefusesNoSecret(t *testing.T) {
	for name, secret := range map[string]string{
		"missing":   "",
		"too short": strings.Repeat("x", 31),
	} {
		o := devOpts()
		o.devSecret = secret
		if _, err := newHandler(context.Background(), o); err == nil {
			t.Errorf("%s secret: newHandler succeeded, want a refusal", name)
		}
	}

	// The flag wins, and the environment is the fallback.
	o, err := parseFlags([]string{"-auth", "dev"}, func(k string) string {
		if k == "OPSVISION_DEV_SECRET" {
			return goodSecret
		}
		return ""
	})
	if err != nil || o.devSecret != goodSecret {
		t.Errorf("env fallback: %+v, %v", o, err)
	}
	if _, err := parseFlags([]string{"-auth", "dev"}, func(string) string { return "" }); err == nil {
		t.Error("parseFlags accepted dev auth without a secret")
	}
	if _, err := parseFlags([]string{"-auth", "dev", "-dev-secret", "short"}, func(string) string { return "" }); err == nil {
		t.Error("parseFlags accepted a short secret")
	}
}

func TestParseFlagsDefaultsAndValidation(t *testing.T) {
	noEnv := func(k string) string {
		if k == "OPSVISION_DEV_SECRET" {
			return goodSecret
		}
		return ""
	}
	o, err := parseFlags(nil, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if o.addr != "127.0.0.1:8080" || o.store != "memory" || o.auth != "dev" || o.seed != "demo" || o.allowedOrigin != "http://localhost:5173" {
		t.Errorf("defaults = %+v", o)
	}
	for _, args := range [][]string{
		{"-store", "sqlite"},
		{"-auth", "none"},
		{"-seed", "everything"},
		{"-store", "dynamo"}, // needs -table
		{"-auth", "auth0"},   // needs a domain and audience
	} {
		if _, err := parseFlags(args, noEnv); err == nil {
			t.Errorf("parseFlags(%v) succeeded, want an error", args)
		}
	}
	if _, err := parseFlags([]string{"-store", "dynamo", "-table", "t"}, noEnv); err != nil {
		t.Errorf("dynamo with table: %v", err)
	}
}

func serve(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestDevServerLoginAndScorecards(t *testing.T) {
	h, err := newHandler(context.Background(), devOpts())
	if err != nil {
		t.Fatal(err)
	}

	// Users are listed without authentication.
	w := serve(h, "GET", "/dev/users", "", "")
	if w.Code != 200 {
		t.Fatalf("GET /dev/users = %d: %s", w.Code, w.Body)
	}
	var users []struct{ UserID, Email, Name, Role string }
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("users: %v: %s", err, w.Body)
	}
	if len(users) != 3 || users[0].UserID != "dev|admin" || users[0].Role != "admin" || users[0].Email != "admin@demo.test" {
		t.Errorf("users = %+v", users)
	}

	// Without a token the API refuses.
	if w := serve(h, "GET", "/v1/scorecards", "", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("GET /v1/scorecards without token = %d, want 401", w.Code)
	}

	// Log in by user ID and by email; both open the demo tenant.
	for _, id := range []string{"dev|admin", "admin@demo.test", "dev|viewer", "dev|contributor"} {
		w := serve(h, "POST", "/dev/login", `{"userId":"`+id+`"}`, "")
		if w.Code != 200 {
			t.Fatalf("login %s = %d: %s", id, w.Code, w.Body)
		}
		var out struct{ Token string }
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Token == "" {
			t.Fatalf("login %s body %s: %v", id, w.Body, err)
		}
		w = serve(h, "GET", "/v1/scorecards", "", out.Token)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "service-fulfillment") {
			t.Errorf("%s: GET /v1/scorecards = %d: %s", id, w.Code, w.Body)
		}
	}

	// Unknown users and bad bodies are refused.
	if w := serve(h, "POST", "/dev/login", `{"userId":"dev|nobody"}`, ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown user = %d, want 404", w.Code)
	}
	if w := serve(h, "POST", "/dev/login", `{`, ""); w.Code != http.StatusBadRequest {
		t.Errorf("malformed body = %d, want 400", w.Code)
	}
	if w := serve(h, "POST", "/dev/login", `{}`, ""); w.Code != http.StatusBadRequest {
		t.Errorf("empty userId = %d, want 400", w.Code)
	}
}

func TestDevServerCORSForTheWebApp(t *testing.T) {
	h, err := newHandler(context.Background(), devOpts())
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodOptions, "/dev/login", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.Header.Set("Access-Control-Request-Method", "POST")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Errorf("preflight = %d, Allow-Origin %q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestDevServerSeedNone(t *testing.T) {
	o := devOpts()
	o.seed = "none"
	h, err := newHandler(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	w := serve(h, "POST", "/dev/login", `{"userId":"dev|admin"}`, "")
	var out struct{ Token string }
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	// The demo tenant does not exist, so its token opens nothing.
	if w := serve(h, "GET", "/v1/scorecards", "", out.Token); w.Code != http.StatusForbidden {
		t.Errorf("unseeded GET /v1/scorecards = %d, want 403", w.Code)
	}
}

func TestDevEndpointsOnlyInDevAuth(t *testing.T) {
	o := devOpts()
	o.auth = "auth0"
	o.devSecret = ""
	o.auth0Domain = "opsvision-demo.us.auth0.com"
	o.auth0Audience = "https://api.opsvision.test"
	h, err := newHandler(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if w := serve(h, "GET", "/dev/users", "", ""); w.Code == 200 {
		t.Errorf("/dev/users answered 200 in auth0 mode")
	}
	if w := serve(h, "POST", "/dev/login", `{"userId":"dev|admin"}`, ""); w.Code == 200 {
		t.Errorf("/dev/login answered 200 in auth0 mode")
	}
}

func TestNonLoopbackAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:8080": false,
		"localhost:8080": false,
		"[::1]:8080":     false,
		":8080":          true,
		"0.0.0.0:8080":   true,
		"192.168.1.5:80": true,
		"example.test:1": true,
		"garbage":        true,
	} {
		if got := nonLoopback(addr); got != want {
			t.Errorf("nonLoopback(%q) = %v, want %v", addr, got, want)
		}
	}
}
