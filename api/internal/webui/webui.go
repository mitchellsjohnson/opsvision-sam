// Package webui serves the built web app (web/dist) and its runtime
// configuration, /config.json, from the API binary.
//
// The files are embedded from dist/, dotfiles included. The committed dist/index.html is a
// placeholder; `make package` copies the web build over it before compiling
// the Lambda binary.
package webui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

//go:embed all:dist
var dist embed.FS

// Files returns the embedded web app, rooted at its index.html.
func Files() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // dist is embedded at build time; it cannot be missing
	}
	return sub
}

// Config is what the web app needs to know about its deployment. All but
// UploadsOrigin are published to the browser as /config.json.
type Config struct {
	AuthMode, Auth0Domain, Auth0ClientID, Auth0Audience, Organization string
	// UploadsOrigin is the origin browsers upload files to with presigned
	// URLs (the uploads bucket). It is allowed by the CSP, not published.
	UploadsOrigin string
}

// runtimeConfig is the JSON form of Config. apiUrl is always empty: the API
// is on the web app's own origin.
type runtimeConfig struct {
	AuthMode      string `json:"authMode"`
	Auth0Domain   string `json:"auth0Domain"`
	Auth0ClientID string `json:"auth0ClientId"`
	Auth0Audience string `json:"auth0Audience"`
	Organization  string `json:"organization,omitempty"`
	APIURL        string `json:"apiUrl"`
}

const (
	configPath = "config.json"
	indexPath  = "index.html"
	// assetsDir holds the build's content-hashed files, which never change
	// under the same name.
	assetsDir = "assets/"

	cacheImmutable  = "public, max-age=31536000, immutable"
	cacheRevalidate = "no-cache"

	hsts = "max-age=31536000; includeSubDomains"

	// gzipMinBytes is the smallest file worth compressing.
	gzipMinBytes = 1024
)

// csp is the Content-Security-Policy for cfg: the app's own origin, plus the
// Auth0 domain (sign-in redirects, silent authentication in an iframe, token
// requests) and the uploads origin (presigned PUTs).
func (cfg Config) csp() string {
	auth0 := "https://" + cfg.Auth0Domain
	connect := "'self' " + auth0
	if cfg.UploadsOrigin != "" {
		connect += " " + cfg.UploadsOrigin
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"connect-src " + connect,
		"frame-src " + auth0,
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self' " + auth0,
	}, "; ")
}

// Handler serves files as a single-page app configured by cfg, for GET and
// HEAD only:
//
//   - /config.json is cfg, never a file of that name in files.
//   - A path whose last segment has no "." and is not a file is a client-side
//     route and gets index.html; a missing path with an extension is 404.
//   - Files under assets/ are cached as immutable; everything else, including
//     index.html and /config.json, is revalidated on every use.
//   - Text files are gzip-compressed for clients that accept it, which keeps
//     the bundle within the load balancer's response limit.
//
// Every response carries HSTS, nosniff, a strict referrer policy and the CSP.
func Handler(files fs.FS, cfg Config) http.Handler {
	b, err := json.Marshal(runtimeConfig{
		AuthMode:      cfg.AuthMode,
		Auth0Domain:   cfg.Auth0Domain,
		Auth0ClientID: cfg.Auth0ClientID,
		Auth0Audience: cfg.Auth0Audience,
		Organization:  cfg.Organization,
	})
	if err != nil {
		panic(err) // a struct of strings always marshals
	}
	return &handler{
		files:  files,
		csp:    cfg.csp(),
		config: newEntry(configPath, append(b, '\n')),
	}
}

type handler struct {
	files  fs.FS
	csp    string
	config *entry
	// cache maps file names to their *entry. Only files that exist are
	// cached, so requests for arbitrary paths cannot grow it.
	cache sync.Map
}

// entry is one servable file, with its compressed form prepared once.
type entry struct {
	data        []byte
	gzipped     []byte // nil when the file is not worth compressing
	contentType string
}

func newEntry(name string, data []byte) *entry {
	e := &entry{data: data, contentType: mime.TypeByExtension(path.Ext(name))}
	if e.contentType == "" {
		e.contentType = http.DetectContentType(data)
	}
	if len(data) >= gzipMinBytes && compressible(e.contentType) {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if _, err := zw.Write(data); err == nil && zw.Close() == nil && buf.Len() < len(data) {
			e.gzipped = buf.Bytes()
		}
	}
	return e
}

func compressible(contentType string) bool {
	mt, _, _ := strings.Cut(contentType, ";")
	mt = strings.TrimSpace(mt)
	return strings.HasPrefix(mt, "text/") ||
		mt == "application/javascript" || mt == "application/json" ||
		strings.HasSuffix(mt, "+json") || strings.HasSuffix(mt, "+xml")
}

// SetSecurityHeaders sets the HSTS, nosniff and referrer-policy headers every
// response on the web app's origin carries, API responses included.
func SetSecurityHeaders(hd http.Header) {
	hd.Set("Strict-Transport-Security", hsts)
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Referrer-Policy", "strict-origin-when-cross-origin")
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hd := w.Header()
	SetSecurityHeaders(hd)
	hd.Set("Content-Security-Policy", h.csp)

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		hd.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == configPath {
		h.serve(w, r, h.config, cacheRevalidate)
		return
	}
	if name == "" {
		name = indexPath
	}
	e, ok := h.lookup(name)
	if !ok {
		if strings.Contains(path.Base(name), ".") {
			http.NotFound(w, r)
			return
		}
		name = indexPath
		if e, ok = h.lookup(name); !ok {
			http.NotFound(w, r)
			return
		}
	}
	cache := cacheRevalidate
	if strings.HasPrefix(name, assetsDir) {
		cache = cacheImmutable
	}
	h.serve(w, r, e, cache)
}

// lookup returns the file name, or false if it is missing or a directory.
func (h *handler) lookup(name string) (*entry, bool) {
	if v, ok := h.cache.Load(name); ok {
		return v.(*entry), true
	}
	data, err := fs.ReadFile(h.files, name)
	if err != nil {
		return nil, false
	}
	v, _ := h.cache.LoadOrStore(name, newEntry(name, data))
	return v.(*entry), true
}

func (h *handler) serve(w http.ResponseWriter, r *http.Request, e *entry, cacheControl string) {
	hd := w.Header()
	hd.Set("Content-Type", e.contentType)
	hd.Set("Cache-Control", cacheControl)
	body := e.data
	if e.gzipped != nil {
		hd.Add("Vary", "Accept-Encoding")
		if acceptsGzip(r.Header.Get("Accept-Encoding")) {
			body = e.gzipped
			hd.Set("Content-Encoding", "gzip")
		}
	}
	hd.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// acceptsGzip reports whether an Accept-Encoding header value lists gzip
// with a non-zero quality.
func acceptsGzip(header string) bool {
	for _, coding := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(coding, ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		for _, p := range strings.Split(params, ";") {
			k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
			if strings.EqualFold(strings.TrimSpace(k), "q") {
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				return err != nil || q > 0
			}
		}
		return true
	}
	return false
}
