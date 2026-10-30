package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"opsvision/internal/objects"
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

// ---- uploads ------------------------------------------------------------------

// startUpload logs in as the demo admin and starts an import; it returns the
// object store, the key, and the signed upload URL path (with query).
func startUpload(t *testing.T, h http.Handler, objs objects.Store) (key, requestURI string) {
	t.Helper()
	w := serve(h, "POST", "/dev/login", `{"userId":"dev|admin"}`, "")
	var login struct{ Token string }
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil || login.Token == "" {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	w = serve(h, "POST", "/v1/imports/uploads", "", login.Token)
	if w.Code != http.StatusCreated {
		t.Fatalf("create upload = %d: %s", w.Code, w.Body)
	}
	var up struct{ ImportID, UploadURL string }
	if err := json.Unmarshal(w.Body.Bytes(), &up); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(up.UploadURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme+"://"+u.Host != "http://localhost:8080" {
		t.Errorf("upload URL origin = %s://%s, want the dev server's own origin", u.Scheme, u.Host)
	}
	return strings.TrimPrefix(u.Path, objects.DevObjectsPath), u.RequestURI()
}

func put(h http.Handler, requestURI, contentType string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPut, requestURI, bytes.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestDevObjectsUpload(t *testing.T) {
	h, objs, err := newHandlerObjects(context.Background(), devOpts())
	if err != nil {
		t.Fatal(err)
	}
	key, uri := startUpload(t, h, objs)
	if !strings.HasPrefix(key, "t/") || !strings.HasSuffix(key, ".xlsx") {
		t.Fatalf("key = %q", key)
	}

	if w := put(h, uri, objects.ContentTypeXLSX, []byte("workbook bytes")); w.Code != http.StatusOK {
		t.Fatalf("PUT = %d: %s", w.Code, w.Body)
	}
	rc, size, err := objs.Get(context.Background(), key)
	if err != nil || size != 14 {
		t.Fatalf("Get after PUT: %d, %v", size, err)
	}
	rc.Close()

	// The browser PUT is cross-origin: the preflight must pass.
	r := httptest.NewRequest(http.MethodOptions, uri, nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.Header.Set("Access-Control-Request-Method", "PUT")
	r.Header.Set("Access-Control-Request-Headers", "content-type")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Errorf("preflight = %d, Allow-Origin %q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestDevObjectsRejectsBadSignatures(t *testing.T) {
	h, objs, err := newHandlerObjects(context.Background(), devOpts())
	if err != nil {
		t.Fatal(err)
	}
	key, uri := startUpload(t, h, objs)
	u, _ := url.Parse(uri)
	exp, sig := u.Query().Get("exp"), u.Query().Get("sig")

	signed := func(secret, key string, exp time.Time) string {
		q := url.Values{"exp": {strconv.FormatInt(exp.Unix(), 10)}, "sig": {objects.Signer(secret)(key, exp)}}
		return objects.DevObjectsPath + key + "?" + q.Encode()
	}
	future := time.Now().Add(time.Hour)
	cases := map[string]string{
		"no signature":        objects.DevObjectsPath + key,
		"empty signature":     objects.DevObjectsPath + key + "?exp=" + exp + "&sig=",
		"wrong signature":     objects.DevObjectsPath + key + "?exp=" + exp + "&sig=" + strings.Repeat("0", len(sig)),
		"signature of a key":  objects.DevObjectsPath + key + "?exp=" + strconv.FormatInt(future.Unix(), 10) + "&sig=" + objects.Signer(goodSecret)(key+"x", future),
		"another secret":      signed(strings.Repeat("z", 32), key, time.Now().Add(time.Hour)),
		"tampered expiry":     objects.DevObjectsPath + key + "?exp=" + strconv.FormatInt(time.Now().Add(48*time.Hour).Unix(), 10) + "&sig=" + sig,
		"expired":             signed(goodSecret, key, time.Now().Add(-time.Second)),
		"another keys upload": objects.DevObjectsPath + "t/other/imports/x.xlsx?exp=" + exp + "&sig=" + sig,
	}
	for name, target := range cases {
		w := put(h, target, objects.ContentTypeXLSX, []byte("x"))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: PUT = %d, want 403", name, w.Code)
		}
	}
	if _, _, err := objs.Get(context.Background(), key); err == nil {
		t.Error("a rejected PUT stored an object")
	}
}

func TestDevObjectsRejectsWrongTypeAndOversize(t *testing.T) {
	h, objs, err := newHandlerObjects(context.Background(), devOpts())
	if err != nil {
		t.Fatal(err)
	}
	key, uri := startUpload(t, h, objs)
	if w := put(h, uri, "text/csv", []byte("a,b")); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("wrong content type = %d, want 415", w.Code)
	}
	if w := put(h, uri, "", []byte("a,b")); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("no content type = %d, want 415", w.Code)
	}
	if w := put(h, uri, objects.ContentTypeXLSX, make([]byte, objects.MaxUploadBytes+1)); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize = %d, want 413", w.Code)
	}
	if _, _, err := objs.Get(context.Background(), key); err == nil {
		t.Error("a rejected PUT stored an object")
	}
	// Exactly the limit is fine.
	if w := put(h, uri, objects.ContentTypeXLSX, make([]byte, objects.MaxUploadBytes)); w.Code != http.StatusOK {
		t.Errorf("a file of exactly the limit = %d, want 200", w.Code)
	}
}

func TestDevObjectsOnlyInDevAuth(t *testing.T) {
	o := devOpts()
	o.auth = "auth0"
	o.devSecret = ""
	o.auth0Domain = "opsvision-demo.us.auth0.com"
	o.auth0Audience = "https://api.opsvision.test"
	h, err := newHandler(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(time.Hour)
	target := objects.DevObjectsPath + "t/t1/imports/x.xlsx?exp=" + strconv.FormatInt(exp.Unix(), 10) + "&sig=" + objects.Signer("")("t/t1/imports/x.xlsx", exp)
	if w := put(h, target, objects.ContentTypeXLSX, []byte("x")); w.Code == http.StatusOK {
		t.Error("dev uploads answered 200 in auth0 mode")
	}
}

func TestObjectsFlags(t *testing.T) {
	env := func(k string) string {
		if k == "OPSVISION_DEV_SECRET" {
			return goodSecret
		}
		return ""
	}
	o, err := parseFlags(nil, env)
	if err != nil || o.objects != "mem" {
		t.Fatalf("default objects = %q, %v", o.objects, err)
	}
	for _, args := range [][]string{
		{"-objects", "disk"},
		{"-objects", "s3"}, // needs a bucket
	} {
		if _, err := parseFlags(args, env); err == nil {
			t.Errorf("parseFlags(%v) succeeded, want an error", args)
		}
	}
	o, err = parseFlags([]string{"-store", "dynamo", "-table", "t", "-objects", "s3", "-uploads-bucket", "uploads-test"}, env)
	if err != nil || o.objects != "s3" || o.uploadsBucket != "uploads-test" {
		t.Errorf("s3: %+v, %v", o, err)
	}
	o, err = parseFlags([]string{"-objects", "s3"}, func(k string) string {
		if k == "UPLOADS_BUCKET" {
			return "from-env"
		}
		return env(k)
	})
	if err != nil || o.uploadsBucket != "from-env" {
		t.Errorf("bucket from the environment: %+v, %v", o, err)
	}
}

func TestOriginOf(t *testing.T) {
	for addr, want := range map[string]string{
		"127.0.0.1:8080": "http://127.0.0.1:8080",
		"localhost:9000": "http://localhost:9000",
		":8080":          "http://localhost:8080",
		"0.0.0.0:8080":   "http://localhost:8080",
		"[::]:8080":      "http://localhost:8080",
		"[::1]:8080":     "http://[::1]:8080",
		"nonsense":       "http://localhost:8080",
	} {
		if got := originOf(addr); got != want {
			t.Errorf("originOf(%q) = %q, want %q", addr, got, want)
		}
	}
}
