package lambdahttp_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/google/go-cmp/cmp"

	"opsvision/internal/lambdahttp"
)

func callALB(t *testing.T, h http.Handler, req events.ALBTargetGroupRequest) events.ALBTargetGroupResponse {
	t.Helper()
	resp, err := lambdahttp.ALBHandler(h)(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return resp
}

func TestALBRoundTrip(t *testing.T) {
	t.Run("GET with multi-value query and headers", func(t *testing.T) {
		var got seen
		h := capture(&got, func(w http.ResponseWriter) {
			w.Header().Add("Set-Cookie", "a=1")
			w.Header().Add("Set-Cookie", "b=2")
			okJSON(w)
		})
		resp := callALB(t, h, events.ALBTargetGroupRequest{
			HTTPMethod: "GET",
			Path:       "/v1/scorecards",
			MultiValueQueryStringParameters: map[string][]string{
				"periods": {"2026-M10", "2026-M09"},
				"label":   {"a%20b"}, // the load balancer does not decode query strings
			},
			MultiValueHeaders: map[string][]string{
				"authorization":   {"Bearer abc"},
				"accept-encoding": {"gzip"},
				"x-multi":         {"one", "two"},
				"host":            {"ops.example.test"},
				"x-forwarded-for": {"198.51.100.7, 203.0.113.9"},
				"x-amzn-trace-id": {"Root=1-abc"},
			},
		})
		if got.Method != "GET" || got.Path != "/v1/scorecards" {
			t.Errorf("method/path = %s %s", got.Method, got.Path)
		}
		wantQ := map[string][]string{"periods": {"2026-M10", "2026-M09"}, "label": {"a b"}}
		if d := cmp.Diff(wantQ, got.Query); d != "" {
			t.Errorf("query (-want +got):\n%s", d)
		}
		if a := got.Header.Get("Authorization"); a != "Bearer abc" {
			t.Errorf("Authorization = %q (header names must be canonicalized)", a)
		}
		if d := cmp.Diff([]string{"one", "two"}, got.Header.Values("X-Multi")); d != "" {
			t.Errorf("X-Multi (-want +got):\n%s", d)
		}
		if got.RequestID != "Root=1-abc" {
			t.Errorf("RequestID = %q, want the trace id", got.RequestID)
		}
		if got.RemoteAddr != "203.0.113.9" {
			t.Errorf("RemoteAddr = %q, want the address the load balancer saw", got.RemoteAddr)
		}
		if resp.StatusCode != 200 || resp.StatusDescription != "200 OK" || resp.Body != `{"ok":true}` || resp.IsBase64Encoded {
			t.Errorf("resp = %d %q %q b64=%v", resp.StatusCode, resp.StatusDescription, resp.Body, resp.IsBase64Encoded)
		}
		if d := cmp.Diff([]string{"a=1", "b=2"}, resp.MultiValueHeaders["Set-Cookie"]); d != "" {
			t.Errorf("Set-Cookie (-want +got):\n%s", d)
		}
		if resp.Headers != nil {
			t.Errorf("Headers must stay unset when multi-value headers are enabled: %v", resp.Headers)
		}
	})

	t.Run("a percent-encoded path keeps both forms", func(t *testing.T) {
		var got seen
		callALB(t, capture(&got, okJSON), events.ALBTargetGroupRequest{
			HTTPMethod: "GET", Path: "/v1/org/units/a%2Fb",
		})
		if got.Path != "/v1/org/units/a/b" || got.EscPath != "/v1/org/units/a%2Fb" {
			t.Errorf("path = %q, escaped = %q", got.Path, got.EscPath)
		}
	})

	t.Run("no stage prefix is stripped", func(t *testing.T) {
		var got seen
		callALB(t, capture(&got, okJSON), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/Prod/x"})
		if got.Path != "/Prod/x" {
			t.Errorf("path = %q", got.Path)
		}
	})

	t.Run("JSON POST body", func(t *testing.T) {
		var got seen
		resp := callALB(t, capture(&got, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"x"}`))
		}), events.ALBTargetGroupRequest{
			HTTPMethod:        "POST",
			Path:              "/v1/org/units",
			MultiValueHeaders: map[string][]string{"content-type": {"application/json"}},
			Body:              `{"name":"Payments"}`,
		})
		if string(got.Body) != `{"name":"Payments"}` || got.Header.Get("Content-Type") != "application/json" {
			t.Errorf("body = %q, content-type = %q", got.Body, got.Header.Get("Content-Type"))
		}
		if resp.StatusCode != http.StatusCreated || resp.StatusDescription != "201 Created" {
			t.Errorf("status = %d %q", resp.StatusCode, resp.StatusDescription)
		}
	})

	t.Run("text types stay plain", func(t *testing.T) {
		for _, ct := range []string{
			"text/csv; charset=utf-8", "text/html", "application/json; charset=utf-8", "application/problem+json",
			"application/javascript", "text/javascript", "image/svg+xml",
		} {
			resp := callALB(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", ct)
				_, _ = w.Write([]byte("hello"))
			}), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/x"})
			if resp.IsBase64Encoded || resp.Body != "hello" {
				t.Errorf("%s: b64=%v body=%q", ct, resp.IsBase64Encoded, resp.Body)
			}
		}
	})

	t.Run("an untyped body is sniffed; no body for HEAD or 204", func(t *testing.T) {
		resp := callALB(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("plain words"))
		}), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/x"})
		if ct := resp.MultiValueHeaders["Content-Type"]; len(ct) != 1 || !strings.HasPrefix(ct[0], "text/plain") || resp.IsBase64Encoded {
			t.Errorf("content-type = %v b64=%v", ct, resp.IsBase64Encoded)
		}
		resp = callALB(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}), events.ALBTargetGroupRequest{HTTPMethod: "DELETE", Path: "/x"})
		if resp.StatusCode != 204 || resp.Body != "" {
			t.Errorf("204 resp = %d %q", resp.StatusCode, resp.Body)
		}
	})

	t.Run("invalid base64 body is a 400, not a crash", func(t *testing.T) {
		var got seen
		resp := callALB(t, capture(&got, okJSON), events.ALBTargetGroupRequest{
			HTTPMethod: "POST", Path: "/v1/x", Body: "!!!not base64!!!", IsBase64Encoded: true,
		})
		if resp.StatusCode != http.StatusBadRequest || got.Method != "" {
			t.Errorf("status = %d, handler ran = %v", resp.StatusCode, got.Method != "")
		}
	})

	t.Run("a handler panic is a 500", func(t *testing.T) {
		resp := callALB(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("boom")
		}), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/x"})
		if resp.StatusCode != http.StatusInternalServerError || strings.Contains(resp.Body, "boom") {
			t.Errorf("resp = %d %q", resp.StatusCode, resp.Body)
		}
	})
}

func TestALBBinaryRoundTrip(t *testing.T) {
	raw := []byte{'P', 'K', 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80}
	var zbuf bytes.Buffer
	zw := gzip.NewWriter(&zbuf)
	_, _ = zw.Write([]byte(`{"big":"payload"}`))
	_ = zw.Close()
	compressed := zbuf.Bytes()

	var got seen
	resp := callALB(t, capture(&got, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(compressed)
	}), events.ALBTargetGroupRequest{
		HTTPMethod: "PUT",
		Path:       "/v1/imports/abc/file",
		MultiValueHeaders: map[string][]string{
			"content-type": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		},
		Body:            base64.StdEncoding.EncodeToString(raw),
		IsBase64Encoded: true,
	})
	if !bytes.Equal(got.Body, raw) {
		t.Errorf("request body = %x, want %x", got.Body, raw)
	}
	if !resp.IsBase64Encoded {
		t.Fatal("a Content-Encoding response must be base64 encoded")
	}
	dec, err := base64.StdEncoding.DecodeString(resp.Body)
	if err != nil || !bytes.Equal(dec, compressed) {
		t.Fatalf("decoded body differs, err %v", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(dec))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if string(plain) != `{"big":"payload"}` {
		t.Errorf("gunzipped = %q", plain)
	}
	if d := cmp.Diff([]string{"gzip"}, resp.MultiValueHeaders["Content-Encoding"]); d != "" {
		t.Errorf("Content-Encoding (-want +got):\n%s", d)
	}

	// A binary content type without Content-Encoding is base64 too.
	resp = callALB(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		_, _ = w.Write(raw)
	}), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/v1/export"})
	if dec, err := base64.StdEncoding.DecodeString(resp.Body); !resp.IsBase64Encoded || err != nil || !bytes.Equal(dec, raw) {
		t.Errorf("binary response: b64=%v err=%v", resp.IsBase64Encoded, err)
	}
}

func TestALBTooLarge(t *testing.T) {
	assertTooLarge := func(t *testing.T, resp events.ALBTargetGroupResponse) {
		t.Helper()
		if resp.StatusCode != http.StatusBadGateway || resp.StatusDescription != "502 Bad Gateway" {
			t.Fatalf("status = %d %q, want 502", resp.StatusCode, resp.StatusDescription)
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(resp.Body), &body); err != nil || body.Error.Code != "response_too_large" {
			t.Errorf("body = %q, err %v", resp.Body, err)
		}
		if resp.IsBase64Encoded || len(resp.Body) > 1000 {
			t.Errorf("the error itself must be small plain JSON")
		}
		if d := cmp.Diff([]string{"application/json"}, resp.MultiValueHeaders["Content-Type"]); d != "" {
			t.Errorf("Content-Type (-want +got):\n%s", d)
		}
	}
	serveN := func(ct string, n int) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", ct)
			_, _ = w.Write(bytes.Repeat([]byte("a"), n))
		})
	}
	req := events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/v1/x"}

	t.Run("text over 1,000,000 bytes", func(t *testing.T) {
		assertTooLarge(t, callALB(t, serveN("application/json", 1_000_001), req))
	})
	t.Run("text of exactly 1,000,000 bytes passes", func(t *testing.T) {
		resp := callALB(t, serveN("application/json", 1_000_000), req)
		if resp.StatusCode != 200 || len(resp.Body) != 1_000_000 {
			t.Errorf("status = %d, body %d bytes", resp.StatusCode, len(resp.Body))
		}
	})
	t.Run("binary is measured after base64 encoding", func(t *testing.T) {
		// 750,000 raw bytes encode to exactly 1,000,000; one more byte tips it over.
		if resp := callALB(t, serveN("application/octet-stream", 750_000), req); resp.StatusCode != 200 {
			t.Errorf("750000 raw bytes: status = %d", resp.StatusCode)
		}
		assertTooLarge(t, callALB(t, serveN("application/octet-stream", 750_001), req))
	})
}
