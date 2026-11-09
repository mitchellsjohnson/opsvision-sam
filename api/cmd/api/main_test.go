package main

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"opsvision/internal/objects"
	"opsvision/internal/store/memstore"
	"opsvision/internal/webui"
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

func serveWebEnv() map[string]string {
	e := validEnv()
	delete(e, "ALLOWED_ORIGIN")
	e["OPSVISION_EVENT_SOURCE"] = "alb"
	e["OPSVISION_SERVE_WEB"] = "1"
	e["OPSVISION_WEB_AUTH0_CLIENT_ID"] = "example-client-id"
	e["AWS_REGION"] = "us-east-1"
	return e
}

func TestServeWebConfig(t *testing.T) {
	cfg, err := loadConfig(env(validEnv()))
	if err != nil || cfg.ServeWeb {
		t.Errorf("default: ServeWeb = %v, %v; want off", cfg.ServeWeb, err)
	}

	cfg, err = loadConfig(env(serveWebEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ServeWeb || cfg.WebAuth0ClientID != "example-client-id" ||
		cfg.UploadsOrigin != "https://opsvision-uploads-test.s3.us-east-1.amazonaws.com" {
		t.Errorf("cfg = %+v", cfg)
	}

	e := serveWebEnv()
	e["OPSVISION_UPLOADS_ORIGIN"] = "https://uploads.ops.example.test"
	if cfg, err := loadConfig(env(e)); err != nil || cfg.UploadsOrigin != "https://uploads.ops.example.test" {
		t.Errorf("uploads origin override: %q, %v", cfg.UploadsOrigin, err)
	}

	e = serveWebEnv()
	delete(e, "OPSVISION_WEB_AUTH0_CLIENT_ID")
	if _, err := loadConfig(env(e)); err == nil || !strings.Contains(err.Error(), "OPSVISION_WEB_AUTH0_CLIENT_ID") {
		t.Errorf("without client ID: err = %v, want it to name OPSVISION_WEB_AUTH0_CLIENT_ID", err)
	}

	// The default uploads origin needs the region; an explicit origin does not.
	e = serveWebEnv()
	delete(e, "AWS_REGION")
	if _, err := loadConfig(env(e)); err == nil || !strings.Contains(err.Error(), "OPSVISION_UPLOADS_ORIGIN") {
		t.Errorf("without region: err = %v, want it to name OPSVISION_UPLOADS_ORIGIN", err)
	}
	e["OPSVISION_UPLOADS_ORIGIN"] = "https://uploads.ops.example.test"
	if _, err := loadConfig(env(e)); err != nil {
		t.Errorf("explicit uploads origin without region: %v", err)
	}

	// The client ID is only needed when the web app is served.
	e = validEnv()
	if _, err := loadConfig(env(e)); err != nil {
		t.Errorf("API only, no client ID: %v", err)
	}

	for _, bad := range []string{"true", "yes", "2", " 1", "on"} {
		e := serveWebEnv()
		e["OPSVISION_SERVE_WEB"] = bad
		if _, err := loadConfig(env(e)); err == nil || !strings.Contains(err.Error(), "OPSVISION_SERVE_WEB") {
			t.Errorf("OPSVISION_SERVE_WEB=%q: err = %v, want a refusal naming it", bad, err)
		}
	}
	e = serveWebEnv()
	e["OPSVISION_SERVE_WEB"] = "0"
	if cfg, err := loadConfig(env(e)); err != nil || cfg.ServeWeb {
		t.Errorf("OPSVISION_SERVE_WEB=0: ServeWeb = %v, %v", cfg.ServeWeb, err)
	}
}

func TestServeWebRouting(t *testing.T) {
	cfg, err := loadConfig(env(serveWebEnv()))
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, memstore.New(), objects.NewMem("", nil))
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, target string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, target, nil))
		return w
	}

	// /v1/ is the API: it wants a token and answers with problem JSON.
	w := do(http.MethodGet, "/v1/me")
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Header().Get("Content-Type"), "json") {
		t.Errorf("GET /v1/me = %d %q, want the API's 401", w.Code, w.Header().Get("Content-Type"))
	}
	if w.Header().Get("Content-Security-Policy") != "" {
		t.Error("API response carries the web app's CSP")
	}

	w = do(http.MethodGet, "/healthz")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
		t.Errorf("GET /healthz = %d %q", w.Code, w.Body.String())
	}

	// Everything else is the web app.
	for _, target := range []string{"/", "/scorecards/01HX", "/v1x"} {
		w = do(http.MethodGet, target)
		if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") ||
			w.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("GET %s = %d %q, CSP %q; want the web app", target, w.Code, w.Header().Get("Content-Type"),
				w.Header().Get("Content-Security-Policy"))
		}
	}
	if csp := do(http.MethodGet, "/").Header().Get("Content-Security-Policy"); !strings.Contains(csp,
		"connect-src 'self' https://opsvision-demo.us.auth0.com https://opsvision-uploads-test.s3.us-east-1.amazonaws.com;") {
		t.Errorf("CSP = %q", csp)
	}

	w = do(http.MethodGet, "/config.json")
	const wantConfig = `{"authMode":"auth0","auth0Domain":"opsvision-demo.us.auth0.com","auth0ClientId":"example-client-id",` +
		`"auth0Audience":"https://api.opsvision.test","apiUrl":""}`
	if got := strings.TrimSpace(w.Body.String()); w.Code != http.StatusOK || got != wantConfig {
		t.Errorf("GET /config.json = %d %s", w.Code, got)
	}

	// Same origin: no CORS headers, even for a preflight-shaped request.
	r := httptest.NewRequest(http.MethodOptions, "/v1/scorecards", nil)
	r.Header.Set("Origin", "https://ops.example.test")
	r.Header.Set("Access-Control-Request-Method", "GET")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want none", got)
	}

	// The dev endpoints still do not exist: /dev/* is not the API.
	if w := do(http.MethodPost, "/dev/login"); w.Code == http.StatusOK {
		t.Error("POST /dev/login must not succeed on the Lambda entrypoint")
	}
}

// Every embedded web file must fit through the load balancer for a browser,
// which always accepts gzip.
func TestEmbeddedWebFitsLoadBalancer(t *testing.T) {
	cfg, err := loadConfig(env(serveWebEnv()))
	if err != nil {
		t.Fatal(err)
	}
	h, err := newHandler(cfg, memstore.New(), objects.NewMem("", nil))
	if err != nil {
		t.Fatal(err)
	}
	serve := lambdaHandler(cfg.EventSource, h).(func(context.Context, events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error))
	n := 0
	err = fs.WalkDir(webui.Files(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		n++
		resp, err := serve(context.Background(), events.ALBTargetGroupRequest{
			HTTPMethod: http.MethodGet,
			Path:       "/" + p,
			MultiValueHeaders: map[string][]string{
				"Accept-Encoding": {"gzip, deflate, br"},
			},
		})
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Errorf("GET /%s through the load balancer = %d %v %.200s", p, resp.StatusCode, err, resp.Body)
		}
		return nil
	})
	if err != nil || n == 0 {
		t.Fatalf("walked %d embedded files: %v", n, err)
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
