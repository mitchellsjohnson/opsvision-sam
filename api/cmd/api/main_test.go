package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"opsvision/internal/objects"
	"opsvision/internal/store/memstore"
)

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func validEnv() map[string]string {
	return map[string]string{
		"OPSVISION_AUTH_MODE": "auth0",
		"TABLE_NAME":          "opsvision-test",
		"UPLOADS_BUCKET":      "opsvision-uploads-test",
		"AUTH0_DOMAIN":        "opsvision-demo.us.auth0.com",
		"AUTH0_AUDIENCE":      "https://api.opsvision.test",
		"ALLOWED_ORIGIN":      "https://app.opsvision.test",
	}
}

func TestLoadConfigRefusesNonAuth0Mode(t *testing.T) {
	const want = "refusing to start: OPSVISION_AUTH_MODE must be auth0"
	for _, mode := range []string{"", "dev", "DEV", "Auth0", "auth0 ", "none", "off"} {
		e := validEnv()
		e["OPSVISION_AUTH_MODE"] = mode
		_, err := loadConfig(env(e))
		if err == nil || err.Error() != want {
			t.Errorf("mode %q: err = %v, want %q", mode, err, want)
		}
	}

	e := validEnv()
	delete(e, "OPSVISION_AUTH_MODE")
	if _, err := loadConfig(env(e)); err == nil || err.Error() != want {
		t.Errorf("unset mode: err = %v, want %q", err, want)
	}
}

func TestLoadConfig(t *testing.T) {
	cfg, err := loadConfig(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Table != "opsvision-test" || cfg.UploadsBucket != "opsvision-uploads-test" || cfg.Auth0Domain != "opsvision-demo.us.auth0.com" ||
		cfg.Auth0Audience != "https://api.opsvision.test" || cfg.AllowedOrigin != "https://app.opsvision.test" {
		t.Errorf("cfg = %+v", cfg)
	}
	if cfg.ClaimNamespace != "https://opsvision/" {
		t.Errorf("ClaimNamespace default = %q", cfg.ClaimNamespace)
	}

	e := validEnv()
	e["CLAIM_NAMESPACE"] = "https://example.test/claims/"
	cfg, err = loadConfig(env(e))
	if err != nil || cfg.ClaimNamespace != "https://example.test/claims/" {
		t.Errorf("custom namespace: %q, %v", cfg.ClaimNamespace, err)
	}

	for _, missing := range []string{"TABLE_NAME", "UPLOADS_BUCKET", "AUTH0_DOMAIN", "AUTH0_AUDIENCE"} {
		e := validEnv()
		delete(e, missing)
		if _, err := loadConfig(env(e)); err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("without %s: err = %v, want it to name the variable", missing, err)
		}
	}
}

func TestEventSourceConfig(t *testing.T) {
	for _, tc := range []struct {
		value string
		set   bool
		want  string
	}{
		{set: false, want: "apigateway"},
		{value: "", set: true, want: "apigateway"},
		{value: "apigateway", set: true, want: "apigateway"},
		{value: "alb", set: true, want: "alb"},
	} {
		e := validEnv()
		if tc.set {
			e["OPSVISION_EVENT_SOURCE"] = tc.value
		}
		cfg, err := loadConfig(env(e))
		if err != nil || cfg.EventSource != tc.want {
			t.Errorf("event source %q (set=%v): got %q, %v; want %q", tc.value, tc.set, cfg.EventSource, err, tc.want)
		}
	}

	for _, bad := range []string{"foo", "ALB", "alb ", "apigw", "function-url"} {
		e := validEnv()
		e["OPSVISION_EVENT_SOURCE"] = bad
		_, err := loadConfig(env(e))
		if err == nil || !strings.Contains(err.Error(), "OPSVISION_EVENT_SOURCE") {
			t.Errorf("event source %q: err = %v, want a refusal naming OPSVISION_EVENT_SOURCE", bad, err)
		}
	}

	// The auth-mode refusal still comes first.
	e := validEnv()
	e["OPSVISION_EVENT_SOURCE"] = "foo"
	e["OPSVISION_AUTH_MODE"] = "dev"
	if _, err := loadConfig(env(e)); err != errNotAuth0 {
		t.Errorf("err = %v, want errNotAuth0", err)
	}
}

func TestLambdaHandlerFollowsEventSource(t *testing.T) {
	h := http.NotFoundHandler()
	if _, ok := lambdaHandler("alb", h).(func(context.Context, events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error)); !ok {
		t.Error("alb must serve load balancer events")
	}
	if _, ok := lambdaHandler("apigateway", h).(func(context.Context, events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error)); !ok {
		t.Error("apigateway must serve API Gateway proxy events")
	}
}

func TestHealthzIsUnauthenticated(t *testing.T) {
	cfg, err := loadConfig(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, memstore.New(), objects.NewMem("", nil))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
		t.Errorf("GET /healthz = %d %q", w.Code, w.Body.String())
	}
}

func TestHandlerCORSAndAuth(t *testing.T) {
	cfg, err := loadConfig(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, memstore.New(), objects.NewMem("", nil))
	if err != nil {
		t.Fatal(err)
	}

	// Preflight is answered before authentication.
	r := httptest.NewRequest(http.MethodOptions, "/v1/scorecards", nil)
	r.Header.Set("Origin", "https://app.opsvision.test")
	r.Header.Set("Access-Control-Request-Method", "GET")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "https://app.opsvision.test" {
		t.Errorf("preflight = %d, Allow-Origin %q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}

	// Other origins get no CORS headers.
	r = httptest.NewRequest(http.MethodOptions, "/v1/scorecards", nil)
	r.Header.Set("Origin", "https://evil.test")
	r.Header.Set("Access-Control-Request-Method", "GET")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("foreign origin got Allow-Origin %q", got)
	}

	// Real requests require a token, and the 401 stays readable cross-origin.
	r = httptest.NewRequest(http.MethodGet, "/v1/scorecards", nil)
	r.Header.Set("Origin", "https://app.opsvision.test")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated GET = %d, want 401", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "https://app.opsvision.test" {
		t.Error("401 response lacks Allow-Origin")
	}

	// The dev endpoints do not exist on this entrypoint.
	r = httptest.NewRequest(http.MethodGet, "/dev/users", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code == http.StatusOK {
		t.Error("/dev/users must not exist on the Lambda entrypoint")
	}
}
