package httpapi

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
)

// gzipMinBytes is the smallest JSON response worth compressing.
const gzipMinBytes = 1024

// gzipMiddleware compresses JSON responses over gzipMinBytes for clients
// that accept gzip. Smaller or non-JSON responses pass through unchanged.
//
// It buffers each response before deciding, which is fine here: handlers
// already encode their JSON into memory, and request bodies and list sizes
// are bounded.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept-Encoding")
		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		bw := &bufferedResponse{header: http.Header{}, status: http.StatusOK}
		for k, v := range w.Header() {
			bw.header[k] = v
		}
		next.ServeHTTP(bw, r)

		h := w.Header()
		for k, v := range bw.header {
			h[k] = v
		}
		body := bw.body.Bytes()
		if bw.status != http.StatusNoContent && bw.status != http.StatusNotModified &&
			len(body) > gzipMinBytes &&
			h.Get("Content-Encoding") == "" &&
			strings.HasPrefix(h.Get("Content-Type"), "application/json") {
			var zbuf bytes.Buffer
			zw := gzip.NewWriter(&zbuf)
			if _, err := zw.Write(body); err == nil && zw.Close() == nil {
				body = zbuf.Bytes()
				h.Set("Content-Encoding", "gzip")
			}
		}
		h.Del("Content-Length")
		if len(body) > 0 {
			h.Set("Content-Length", strconv.Itoa(len(body)))
		}
		w.WriteHeader(bw.status)
		_, _ = w.Write(body)
	})
}

// acceptsGzip reports whether an Accept-Encoding value lists gzip with a
// non-zero quality.
func acceptsGzip(v string) bool {
	for _, part := range strings.Split(v, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		params = strings.ReplaceAll(params, " ", "")
		if q, ok := strings.CutPrefix(strings.ToLower(params), "q="); ok {
			if f, err := strconv.ParseFloat(q, 64); err == nil && f == 0 {
				return false
			}
		}
		return true
	}
	return false
}

// bufferedResponse captures a handler's response.
type bufferedResponse struct {
	header http.Header
	status int
	wrote  bool
	body   bytes.Buffer
}

func (b *bufferedResponse) Header() http.Header { return b.header }

func (b *bufferedResponse) WriteHeader(status int) {
	if !b.wrote {
		b.status, b.wrote = status, true
	}
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	b.wrote = true
	return b.body.Write(p)
}
