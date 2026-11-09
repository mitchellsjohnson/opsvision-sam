package webui

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const indexHTML = `<!doctype html><html><body><div id="root"></div></body></html>`

var exampleConfig = Config{
	AuthMode:      "auth0",
	Auth0Domain:   "example.us.auth0.com",
	Auth0ClientID: "example-client-id",
	Auth0Audience: "https://ops.example.test/api",
	UploadsOrigin: "https://uploads-example.s3.us-east-1.amazonaws.com",
}

const exampleCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; connect-src 'self' https://example.us.auth0.com https://uploads-example.s3.us-east-1.amazonaws.com; " +
	"frame-src https://example.us.auth0.com; frame-ancestors 'none'; base-uri 'self'; " +
	"form-action 'self' https://example.us.auth0.com"

func testFiles() fstest.MapFS {
	return fstest.MapFS{
		"index.html":                {Data: []byte(indexHTML)},
		"assets/index-Ab12Cd34.js":  {Data: []byte(strings.Repeat("console.log('opsvision');\n", 400))},
		"assets/index-Ef56Gh78.css": {Data: []byte("body{margin:0}")},
		"brand/sam/sam-mark.svg":    {Data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)},
	}
}

func get(t *testing.T, h http.Handler, method, target string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSPAFallback(t *testing.T) {
	h := Handler(testFiles(), exampleConfig)
	for _, target := range []string{"/", "/index.html", "/scorecards", "/scorecards/01HX/records", "/admin/import?step=2", "/brand"} {
		w := get(t, h, http.MethodGet, target, nil)
		if w.Code != http.StatusOK || w.Body.String() != indexHTML {
			t.Errorf("GET %s = %d %q, want index.html", target, w.Code, w.Body.String())
			continue
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s Content-Type = %q", target, ct)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("GET %s Cache-Control = %q, want no-cache", target, cc)
		}
	}

	w := get(t, h, http.MethodHead, "/scorecards", nil)
	if w.Code != http.StatusOK {
		t.Errorf("HEAD /scorecards = %d", w.Code)
	}
}

func TestMissingAssetIs404(t *testing.T) {
	h := Handler(testFiles(), exampleConfig)
	for _, target := range []string{"/assets/index-missing.js", "/favicon.ico", "/brand/sam/other.svg", "/robots.txt"} {
		w := get(t, h, http.MethodGet, target, nil)
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", target, w.Code)
		}
		if strings.Contains(w.Body.String(), "root") {
			t.Errorf("GET %s fell back to index.html", target)
		}
	}
}

func TestOnlyGetAndHead(t *testing.T) {
	h := Handler(testFiles(), exampleConfig)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodOptions} {
		w := get(t, h, method, "/", nil)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
			t.Errorf("%s / = %d, Allow %q; want 405 with Allow: GET, HEAD", method, w.Code, w.Header().Get("Allow"))
		}
	}
}

func TestAssetCaching(t *testing.T) {
	h := Handler(testFiles(), exampleConfig)
	for target, want := range map[string]string{
		"/assets/index-Ab12Cd34.js":  "public, max-age=31536000, immutable",
		"/assets/index-Ef56Gh78.css": "public, max-age=31536000, immutable",
		"/index.html":                "no-cache",
		"/":                          "no-cache",
		"/config.json":               "no-cache",
		"/brand/sam/sam-mark.svg":    "no-cache",
	} {
		w := get(t, h, http.MethodGet, target, nil)
		if w.Code != http.StatusOK {
			t.Errorf("GET %s = %d", target, w.Code)
		}
		if got := w.Header().Get("Cache-Control"); got != want {
			t.Errorf("GET %s Cache-Control = %q, want %q", target, got, want)
		}
	}

	w := get(t, h, http.MethodGet, "/assets/index-Ab12Cd34.js", nil)
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Errorf("js Content-Type = %q", ct)
	}
	w = get(t, h, http.MethodGet, "/assets/index-Ef56Gh78.css", nil)
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Errorf("css Content-Type = %q", ct)
	}
}

func TestGzipWhenAccepted(t *testing.T) {
	files := testFiles()
	h := Handler(files, exampleConfig)
	want := files["assets/index-Ab12Cd34.js"].Data

	w := get(t, h, http.MethodGet, "/assets/index-Ab12Cd34.js", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", w.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(w.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", w.Header().Get("Vary"))
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(zr)
	if err != nil || !bytes.Equal(got, want) {
		t.Errorf("decompressed body differs (err %v)", err)
	}

	// A second request is served the same (cached) bytes.
	w2 := get(t, h, http.MethodGet, "/assets/index-Ab12Cd34.js", map[string]string{"Accept-Encoding": "gzip"})
	if w2.Header().Get("Content-Encoding") != "gzip" || w2.Body.Len() == 0 {
		t.Errorf("second gzip request: encoding %q, %d bytes", w2.Header().Get("Content-Encoding"), w2.Body.Len())
	}

	for _, ae := range []string{"", "identity", "gzip;q=0"} {
		w := get(t, h, http.MethodGet, "/assets/index-Ab12Cd34.js", map[string]string{"Accept-Encoding": ae})
		if w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), want) {
			t.Errorf("Accept-Encoding %q: got encoding %q, want the plain file", ae, w.Header().Get("Content-Encoding"))
		}
	}

	// Small files are not worth compressing.
	w = get(t, h, http.MethodGet, "/assets/index-Ef56Gh78.css", map[string]string{"Accept-Encoding": "gzip"})
	if w.Header().Get("Content-Encoding") != "" || w.Body.String() != "body{margin:0}" {
		t.Errorf("small css: encoding %q body %q", w.Header().Get("Content-Encoding"), w.Body.String())
	}
}

func TestConfigJSON(t *testing.T) {
	w := get(t, Handler(testFiles(), exampleConfig), http.MethodGet, "/config.json", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /config.json = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	const want = `{"authMode":"auth0","auth0Domain":"example.us.auth0.com","auth0ClientId":"example-client-id",` +
		`"auth0Audience":"https://ops.example.test/api","apiUrl":""}`
	if got := strings.TrimSpace(w.Body.String()); got != want {
		t.Errorf("config.json =\n%s\nwant\n%s", got, want)
	}

	withOrg := exampleConfig
	withOrg.Organization = "org_example"
	w = get(t, Handler(testFiles(), withOrg), http.MethodGet, "/config.json", nil)
	const wantOrg = `{"authMode":"auth0","auth0Domain":"example.us.auth0.com","auth0ClientId":"example-client-id",` +
		`"auth0Audience":"https://ops.example.test/api","organization":"org_example","apiUrl":""}`
	if got := strings.TrimSpace(w.Body.String()); got != wantOrg {
		t.Errorf("config.json with organization =\n%s\nwant\n%s", got, wantOrg)
	}

	// A config.json in the files never replaces the runtime configuration.
	files := testFiles()
	files["config.json"] = &fstest.MapFile{Data: []byte(`{"authMode":"dev"}`)}
	w = get(t, Handler(files, exampleConfig), http.MethodGet, "/config.json", nil)
	if got := strings.TrimSpace(w.Body.String()); got != want {
		t.Errorf("config.json from files was served: %s", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	h := Handler(testFiles(), exampleConfig)
	for _, tc := range []struct{ method, target string }{
		{http.MethodGet, "/"},
		{http.MethodGet, "/scorecards"},
		{http.MethodGet, "/assets/index-Ab12Cd34.js"},
		{http.MethodGet, "/config.json"},
		{http.MethodGet, "/assets/missing.js"},
		{http.MethodPost, "/"},
	} {
		w := get(t, h, tc.method, tc.target, nil)
		for name, want := range map[string]string{
			"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
			"X-Content-Type-Options":    "nosniff",
			"Referrer-Policy":           "strict-origin-when-cross-origin",
			"Content-Security-Policy":   exampleCSP,
		} {
			if got := w.Header().Get(name); got != want {
				t.Errorf("%s %s (%d): %s = %q, want %q", tc.method, tc.target, w.Code, name, got, want)
			}
		}
	}
}

func TestCSPWithoutUploadsOrigin(t *testing.T) {
	cfg := exampleConfig
	cfg.UploadsOrigin = ""
	w := get(t, Handler(testFiles(), cfg), http.MethodGet, "/", nil)
	const want = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; connect-src 'self' https://example.us.auth0.com; " +
		"frame-src https://example.us.auth0.com; frame-ancestors 'none'; base-uri 'self'; " +
		"form-action 'self' https://example.us.auth0.com"
	if got := w.Header().Get("Content-Security-Policy"); got != want {
		t.Errorf("CSP = %q, want %q", got, want)
	}
}

func TestFilesEmbedsIndex(t *testing.T) {
	b, err := fs.ReadFile(Files(), "index.html")
	if err != nil {
		t.Fatalf("embedded index.html: %v", err)
	}
	if !bytes.Contains(b, []byte("<html")) {
		t.Errorf("embedded index.html is not HTML: %q", b)
	}
}
