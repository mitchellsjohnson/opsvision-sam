package lambdahttp_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/google/go-cmp/cmp"

	"opsvision/internal/lambdahttp"
)

// seen is what the stub handler observed.
type seen struct {
	Method     string
	Path       string
	EscPath    string
	Host       string
	RequestURI string
	RawQuery   string
	Query      map[string][]string
	Header     http.Header
	Body       []byte
	RemoteAddr string
	RequestID  string
}

func capture(into *seen, respond func(w http.ResponseWriter)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*into = seen{
			Method:     r.Method,
			Path:       r.URL.Path,
			EscPath:    r.URL.EscapedPath(),
			Host:       r.URL.Host,
			RequestURI: r.RequestURI,
			RawQuery:   r.URL.RawQuery,
			Query:      r.URL.Query(),
			Header:     r.Header.Clone(),
			Body:       body,
			RemoteAddr: r.RemoteAddr,
			RequestID:  lambdahttp.RequestID(r.Context()),
		}
		respond(w)
	})
}

func okJSON(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func call(t *testing.T, h http.Handler, req events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	t.Helper()
	resp, err := lambdahttp.Handler(h)(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return resp
}

func TestAdapterRoundTrip(t *testing.T) {
	t.Run("GET with multi-value query and headers", func(t *testing.T) {
		var got seen
		h := capture(&got, func(w http.ResponseWriter) {
			w.Header().Add("Set-Cookie", "a=1")
			w.Header().Add("Set-Cookie", "b=2")
			okJSON(w)
		})
		resp := call(t, h, events.APIGatewayProxyRequest{
			HTTPMethod: "GET",
			Path:       "/v1/scorecards/service-fulfillment/view",
			MultiValueQueryStringParameters: map[string][]string{
				"periods": {"2026-M10", "2026-M09"},
				"restate": {"v2025"},
			},
			QueryStringParameters: map[string]string{"periods": "2026-M09"}, // ignored: multi-value wins
			MultiValueHeaders: map[string][]string{
				"authorization":   {"Bearer abc"},
				"Accept-Encoding": {"gzip"},
				"X-Multi":         {"one", "two"},
			},
			RequestContext: events.APIGatewayProxyRequestContext{
				RequestID: "req-123",
				Identity:  events.APIGatewayRequestIdentity{SourceIP: "203.0.113.9"},
			},
		})
		if got.Method != "GET" || got.Path != "/v1/scorecards/service-fulfillment/view" {
			t.Errorf("method/path = %s %s", got.Method, got.Path)
		}
		wantQ := map[string][]string{"periods": {"2026-M10", "2026-M09"}, "restate": {"v2025"}}
		if d := cmp.Diff(wantQ, got.Query); d != "" {
			t.Errorf("query (-want +got):\n%s", d)
		}
		if a := got.Header.Get("Authorization"); a != "Bearer abc" {
			t.Errorf("Authorization = %q (header names must be canonicalized)", a)
		}
		if d := cmp.Diff([]string{"one", "two"}, got.Header.Values("X-Multi")); d != "" {
			t.Errorf("X-Multi (-want +got):\n%s", d)
		}
		if got.RemoteAddr != "203.0.113.9" {
			t.Errorf("RemoteAddr = %q", got.RemoteAddr)
		}
		if got.RequestID != "req-123" {
			t.Errorf("RequestID = %q", got.RequestID)
		}
		if resp.StatusCode != 200 || resp.Body != `{"ok":true}` || resp.IsBase64Encoded {
			t.Errorf("resp = %d %q b64=%v", resp.StatusCode, resp.Body, resp.IsBase64Encoded)
		}
		if d := cmp.Diff([]string{"a=1", "b=2"}, resp.MultiValueHeaders["Set-Cookie"]); d != "" {
			t.Errorf("Set-Cookie (-want +got):\n%s", d)
		}
	})

	t.Run("falls back to single-value query and headers", func(t *testing.T) {
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
			HTTPMethod:            "GET",
			Path:                  "/v1/me",
			QueryStringParameters: map[string]string{"q": "a b"},
			Headers:               map[string]string{"x-single": "v"},
		})
		if d := cmp.Diff(map[string][]string{"q": {"a b"}}, got.Query); d != "" {
			t.Errorf("query (-want +got):\n%s", d)
		}
		if got.Header.Get("X-Single") != "v" {
			t.Errorf("X-Single = %q", got.Header.Get("X-Single"))
		}
	})

	t.Run("JSON POST body", func(t *testing.T) {
		var got seen
		resp := call(t, capture(&got, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"x"}`))
		}), events.APIGatewayProxyRequest{
			HTTPMethod:        "POST",
			Path:              "/v1/org/units",
			MultiValueHeaders: map[string][]string{"Content-Type": {"application/json"}},
			Body:              `{"name":"Payments"}`,
		})
		if string(got.Body) != `{"name":"Payments"}` {
			t.Errorf("body = %q", got.Body)
		}
		if resp.StatusCode != http.StatusCreated {
			t.Errorf("status = %d", resp.StatusCode)
		}
	})

	t.Run("base64 xlsx request body is decoded", func(t *testing.T) {
		raw := []byte{'P', 'K', 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80}
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
			HTTPMethod: "PUT",
			Path:       "/v1/imports/abc/file",
			MultiValueHeaders: map[string][]string{
				"Content-Type": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
			},
			Body:            base64.StdEncoding.EncodeToString(raw),
			IsBase64Encoded: true,
		})
		if !bytes.Equal(got.Body, raw) {
			t.Errorf("body = %x, want %x", got.Body, raw)
		}
	})

	t.Run("invalid base64 body is a 400, not a crash", func(t *testing.T) {
		var got seen
		resp := call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
			HTTPMethod: "POST", Path: "/v1/x", Body: "!!!not base64!!!", IsBase64Encoded: true,
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", resp.StatusCode)
		}
		if got.Method != "" {
			t.Error("handler must not run for an undecodable body")
		}
	})

	t.Run("binary response is base64 encoded", func(t *testing.T) {
		raw := []byte{0x00, 0x01, 0xfe, 0xff}
		resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
			_, _ = w.Write(raw)
		}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/export"})
		if !resp.IsBase64Encoded {
			t.Fatal("IsBase64Encoded = false for a binary content type")
		}
		got, err := base64.StdEncoding.DecodeString(resp.Body)
		if err != nil || !bytes.Equal(got, raw) {
			t.Errorf("decoded body = %x, err %v", got, err)
		}
	})

	t.Run("text and problem+json responses stay plain", func(t *testing.T) {
		for _, ct := range []string{"text/csv; charset=utf-8", "text/plain", "application/json; charset=utf-8", "application/problem+json"} {
			resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", ct)
				_, _ = w.Write([]byte("hello"))
			}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})
			if resp.IsBase64Encoded || resp.Body != "hello" {
				t.Errorf("%s: b64=%v body=%q", ct, resp.IsBase64Encoded, resp.Body)
			}
		}
	})
}

func TestAdapterGzipResponseIsBase64(t *testing.T) {
	var zbuf bytes.Buffer
	zw := gzip.NewWriter(&zbuf)
	_, _ = zw.Write([]byte(`{"big":"payload"}`))
	_ = zw.Close()
	compressed := zbuf.Bytes()

	resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(compressed)
	}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})

	if !resp.IsBase64Encoded {
		t.Fatal("a Content-Encoding response must be base64 encoded")
	}
	raw, err := base64.StdEncoding.DecodeString(resp.Body)
	if err != nil || !bytes.Equal(raw, compressed) {
		t.Fatalf("body does not round-trip: err %v", err)
	}
	if got := resp.MultiValueHeaders["Content-Encoding"]; len(got) != 1 || got[0] != "gzip" {
		t.Errorf("Content-Encoding = %v", got)
	}
}

func TestAdapterStagePrefix(t *testing.T) {
	cases := []struct {
		name, path, stage, want string
	}{
		{"Prod stripped", "/Prod/v1/me", "Prod", "/v1/me"},
		{"Prod stripped without stage in context", "/Prod/v1/me", "", "/v1/me"},
		{"custom stage stripped", "/beta/v1/me", "beta", "/v1/me"},
		{"plain v1 untouched", "/v1/me", "Prod", "/v1/me"},
		{"v1 path never stripped even if stage is v1", "/v1/me", "v1", "/v1/me"},
		{"Prod alone", "/Prod", "Prod", "/"},
		{"unrelated prefix untouched", "/Production/v1/me", "Prod", "/Production/v1/me"},
		{"dev path untouched", "/dev/users", "", "/dev/users"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got seen
			call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
				HTTPMethod: "GET", Path: tc.path,
				RequestContext: events.APIGatewayProxyRequestContext{Stage: tc.stage},
			})
			if got.Path != tc.want {
				t.Errorf("path = %q, want %q", got.Path, tc.want)
			}
		})
	}
}

func TestAdapterRecoversFromPanic(t *testing.T) {
	resp := call(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }),
		events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})
	if resp.StatusCode != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", resp.StatusCode)
	}
}

func TestAdapterURLHandling(t *testing.T) {
	t.Run("double leading slash is a path, not a host", func(t *testing.T) {
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "//v1/me"})
		if got.Path != "//v1/me" || got.Host != "" {
			t.Errorf("path = %q host = %q, want path //v1/me and no host", got.Path, got.Host)
		}
		if got.RequestURI != "//v1/me" {
			t.Errorf("RequestURI = %q", got.RequestURI)
		}
	})

	t.Run("percent-encoded path keeps its encoding", func(t *testing.T) {
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
			HTTPMethod: "GET", Path: "/v1/org/units/a%20b",
			MultiValueQueryStringParameters: map[string][]string{"q": {"x y"}},
		})
		if got.Path != "/v1/org/units/a b" {
			t.Errorf("Path = %q, want decoded", got.Path)
		}
		if got.EscPath != "/v1/org/units/a%20b" {
			t.Errorf("EscapedPath = %q, want the original encoding", got.EscPath)
		}
		if got.RequestURI != "/v1/org/units/a%20b?q=x+y" {
			t.Errorf("RequestURI = %q", got.RequestURI)
		}
	})

	t.Run("a literal percent that is not an escape stays literal", func(t *testing.T) {
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/100%"})
		if got.Path != "/v1/100%" {
			t.Errorf("Path = %q", got.Path)
		}
	})

	t.Run("query is encoded onto the URL", func(t *testing.T) {
		var got seen
		call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
			HTTPMethod:                      "GET",
			Path:                            "/v1/x",
			MultiValueQueryStringParameters: map[string][]string{"periods": {"2026-M10", "2026-M09"}},
		})
		if got.RawQuery != "periods=2026-M10&periods=2026-M09" {
			t.Errorf("RawQuery = %q", got.RawQuery)
		}
	})
}

func TestAdapterBadRequestMessages(t *testing.T) {
	var got seen
	resp := call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{
		HTTPMethod: "POST", Path: "/v1/x", Body: "!!!", IsBase64Encoded: true,
	})
	if resp.StatusCode != 400 || !strings.Contains(resp.Body, "base64") {
		t.Errorf("bad base64: %d %s", resp.StatusCode, resp.Body)
	}

	resp = call(t, capture(&got, okJSON), events.APIGatewayProxyRequest{HTTPMethod: "BAD METHOD", Path: "/v1/x"})
	if resp.StatusCode != 400 {
		t.Fatalf("bad method: status %d", resp.StatusCode)
	}
	if strings.Contains(resp.Body, "base64") {
		t.Errorf("a bad method must not be reported as a base64 error: %s", resp.Body)
	}
	if got.Method != "" {
		t.Error("handler must not run")
	}
}

func TestAdapterContentTypeSniffing(t *testing.T) {
	t.Run("untyped text body stays plain and gets a sniffed type", func(t *testing.T) {
		resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("hello, world"))
		}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})
		if resp.IsBase64Encoded || resp.Body != "hello, world" {
			t.Errorf("b64=%v body=%q", resp.IsBase64Encoded, resp.Body)
		}
		if got := resp.MultiValueHeaders["Content-Type"]; len(got) != 1 || got[0] != "text/plain; charset=utf-8" {
			t.Errorf("Content-Type = %v", got)
		}
	})

	t.Run("untyped binary body is base64", func(t *testing.T) {
		raw := []byte{0x00, 0x01, 0x02, 0xfe, 0xff}
		resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write(raw)
		}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})
		if !resp.IsBase64Encoded {
			t.Fatal("binary sniffed body must be base64")
		}
		if got, _ := base64.StdEncoding.DecodeString(resp.Body); !bytes.Equal(got, raw) {
			t.Errorf("body = %x", got)
		}
		if got := resp.MultiValueHeaders["Content-Type"]; len(got) != 1 || got[0] != "application/octet-stream" {
			t.Errorf("Content-Type = %v", got)
		}
	})

	t.Run("an explicit type is never overridden", func(t *testing.T) {
		resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("<html>"))
		}), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/v1/x"})
		if got := resp.MultiValueHeaders["Content-Type"]; len(got) != 1 || got[0] != "application/json" {
			t.Errorf("Content-Type = %v", got)
		}
	})

	t.Run("empty untyped body gets no type", func(t *testing.T) {
		resp := call(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
		}), events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/v1/x"})
		if resp.IsBase64Encoded || resp.Body != "" || len(resp.MultiValueHeaders["Content-Type"]) != 0 {
			t.Errorf("resp = %+v", resp)
		}
	})
}

func TestAdapterDropsBodyWhereHTTPForbidsIt(t *testing.T) {
	write := func(status int) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"x":1}`))
		})
	}
	for _, tc := range []struct {
		name, method string
		status       int
		wantBody     bool
	}{
		{"HEAD", "HEAD", 200, false},
		{"204", "GET", 204, false},
		{"304", "GET", 304, false},
		{"GET 200 keeps body", "GET", 200, true},
		{"POST 201 keeps body", "POST", 201, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := call(t, write(tc.status), events.APIGatewayProxyRequest{HTTPMethod: tc.method, Path: "/v1/x"})
			if (resp.Body != "") != tc.wantBody {
				t.Errorf("body = %q, want body present = %v", resp.Body, tc.wantBody)
			}
			if resp.StatusCode != tc.status {
				t.Errorf("status = %d", resp.StatusCode)
			}
			if tc.method == "HEAD" && len(resp.MultiValueHeaders["Content-Type"]) != 1 {
				t.Errorf("HEAD must keep its headers: %v", resp.MultiValueHeaders)
			}
		})
	}
}
