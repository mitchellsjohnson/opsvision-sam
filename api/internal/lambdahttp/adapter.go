// Package lambdahttp runs an http.Handler behind Amazon API Gateway REST APIs
// (Lambda proxy integration, payload format 1.0, events.APIGatewayProxyRequest).
//
// It is a deliberately small adapter: it maps the proxy event to an
// *http.Request, runs the handler against an in-memory response, and maps the
// result back. It does not support HTTP APIs (payload 2.0) or streaming.
//
// Binary payloads. For API Gateway to hand the function base64 request bodies
// and to decode base64 responses, the REST API must list the content types in
// its BinaryMediaTypes. The adapter decodes request bodies flagged
// IsBase64Encoded and base64-encodes any response that is compressed (has a
// Content-Encoding) or whose Content-Type is not text/*, application/json, or
// application/problem+json.
package lambdahttp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

// Handler returns a Lambda handler function that serves proxy events with h.
// Pass the result to lambda.Start.
func Handler(h http.Handler) func(context.Context, events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	return func(ctx context.Context, ev events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
		start := time.Now()
		ctx = context.WithValue(ctx, requestIDKey{}, ev.RequestContext.RequestID)

		req, err := newRequest(ctx, ev)
		if err != nil {
			slog.WarnContext(ctx, "lambdahttp: bad request event", "requestId", ev.RequestContext.RequestID, "err", err)
			msg := "invalid request"
			if errors.Is(err, errBadBase64) {
				msg = "request body is not valid base64"
			}
			return jsonError(http.StatusBadRequest, "invalid", msg), nil
		}

		rec := &recorder{header: http.Header{}, status: http.StatusOK}
		serve(h, rec, req)

		resp := rec.response(req.Method)
		slog.InfoContext(ctx, "request",
			"requestId", ev.RequestContext.RequestID,
			"method", req.Method,
			"path", req.URL.Path,
			"status", resp.StatusCode,
			"ms", time.Since(start).Milliseconds(),
		)
		return resp, nil
	}
}

// errBadBase64 marks a body flagged IsBase64Encoded that does not decode.
var errBadBase64 = errors.New("body is not valid base64")

type requestIDKey struct{}

// RequestID returns the API Gateway request ID of the invocation serving ctx,
// or "" outside the adapter.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// stagePrefix is the stage SAM deploys to by default.
const stagePrefix = "Prod"

// apiPrefix is the API's own path prefix; a path starting with it already
// excludes the stage.
const apiPrefix = "/v1"

// routePath returns the path the handler routes on.
//
// API Gateway REST proxy events carry the stage in the path when the API is
// reached on its default execute-api domain (/Prod/v1/...) but not behind a
// custom domain (/v1/...). A leading stage segment ("/Prod", or the event's
// own stage name) is stripped, but only when the path does not already start
// with /v1, so a custom domain mapping can never lose a real /v1 route.
func routePath(p, stage string) string {
	if p == "" {
		return "/"
	}
	if strings.HasPrefix(p, apiPrefix) {
		return p
	}
	for _, s := range []string{stagePrefix, stage} {
		if s == "" {
			continue
		}
		pre := "/" + s
		if p == pre {
			return "/"
		}
		if rest, ok := strings.CutPrefix(p, pre+"/"); ok {
			return "/" + rest
		}
	}
	return p
}

// newRequest builds the *http.Request for ev.
func newRequest(ctx context.Context, ev events.APIGatewayProxyRequest) (*http.Request, error) {
	var body []byte
	if ev.IsBase64Encoded {
		b, err := base64.StdEncoding.DecodeString(ev.Body)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", errBadBase64, err)
		}
		body = b
	} else {
		body = []byte(ev.Body)
	}

	query := url.Values{}
	if len(ev.MultiValueQueryStringParameters) > 0 {
		for k, vs := range ev.MultiValueQueryStringParameters {
			query[k] = append([]string(nil), vs...)
		}
	} else {
		for k, v := range ev.QueryStringParameters {
			query.Add(k, v)
		}
	}

	header := http.Header{}
	if len(ev.MultiValueHeaders) > 0 {
		for k, vs := range ev.MultiValueHeaders {
			for _, v := range vs {
				header.Add(k, v)
			}
		}
	} else {
		for k, v := range ev.Headers {
			header.Add(k, v)
		}
	}

	method := ev.HTTPMethod
	if method == "" {
		method = http.MethodGet
	}
	// The URL is assembled by hand, never rendered to a string and parsed
	// again: a path like //v1/x would re-parse as host "v1".
	req, err := http.NewRequestWithContext(ctx, method, "/", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}
	req.URL, req.RequestURI = requestURL(routePath(ev.Path, ev.RequestContext.Stage), query.Encode())
	req.Header = header
	req.ContentLength = int64(len(body))
	req.RemoteAddr = ev.RequestContext.Identity.SourceIP
	if host := header.Get("Host"); host != "" {
		req.Host = host
	}
	return req, nil
}

// requestURL returns the URL and RequestURI for a route path and an encoded
// query. The path may arrive percent-encoded: a valid encoding is decoded into
// Path and kept verbatim in RawPath so handlers see both forms. A path that is
// not a valid encoding (a bare "%") is used literally.
func requestURL(p, rawQuery string) (*url.URL, string) {
	u := &url.URL{Path: p, RawQuery: rawQuery}
	if dec, err := url.PathUnescape(p); err == nil {
		u.Path = dec
		if (&url.URL{Path: dec}).EscapedPath() != p {
			u.RawPath = p
		}
	}
	uri := u.EscapedPath()
	if rawQuery != "" {
		uri += "?" + rawQuery
	}
	return u, uri
}

// serve runs h, turning a panic into a 500 so one bad request cannot take the
// invocation down.
func serve(h http.Handler, rec *recorder, req *http.Request) {
	defer func() {
		if p := recover(); p != nil {
			slog.ErrorContext(req.Context(), "lambdahttp: handler panic",
				"requestId", RequestID(req.Context()), "panic", fmt.Sprint(p))
			*rec = recorder{header: http.Header{}, status: http.StatusInternalServerError}
			rec.header.Set("Content-Type", "application/json")
			rec.body.WriteString(errorBody("internal", "internal error"))
		}
	}()
	h.ServeHTTP(rec, req)
}

// recorder is the http.ResponseWriter the handler writes to.
type recorder struct {
	header http.Header
	status int
	wrote  bool
	body   bytes.Buffer
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(status int) {
	if !r.wrote {
		r.status, r.wrote = status, true
	}
}

func (r *recorder) Write(p []byte) (int, error) {
	r.wrote = true
	return r.body.Write(p)
}

// bodyAllowed reports whether HTTP permits a body with status.
func bodyAllowed(status int) bool {
	return !(status >= 100 && status < 200) && status != http.StatusNoContent && status != http.StatusNotModified
}

// response converts the recorded response to a proxy response for a request
// made with method. Like net/http, it sends no body for HEAD or for statuses
// that forbid one, and it sniffs a Content-Type for an untyped body.
func (r *recorder) response(method string) events.APIGatewayProxyResponse {
	body := r.body.Bytes()
	if method == http.MethodHead || !bodyAllowed(r.status) {
		body = nil
	}
	h := r.header.Clone()
	if h.Get("Content-Type") == "" && len(body) > 0 && h.Get("Content-Encoding") == "" {
		h.Set("Content-Type", http.DetectContentType(body))
	}
	resp := events.APIGatewayProxyResponse{
		StatusCode:        r.status,
		MultiValueHeaders: map[string][]string(h),
	}
	if isBinary(h, len(body)) {
		resp.Body = base64.StdEncoding.EncodeToString(body)
		resp.IsBase64Encoded = true
	} else {
		resp.Body = string(body)
	}
	return resp
}

// isBinary reports whether a response must travel base64 encoded.
func isBinary(h http.Header, n int) bool {
	if h.Get("Content-Encoding") != "" {
		return true
	}
	ct := h.Get("Content-Type")
	if ct == "" {
		// Only an empty body is left untyped (response sniffed one already).
		return n > 0
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return true
	}
	switch {
	case strings.HasPrefix(mt, "text/"), mt == "application/json", mt == "application/problem+json":
		return false
	}
	return true
}

func errorBody(code, message string) string {
	b, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": message}})
	return string(b)
}

func jsonError(status int, code, message string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode:        status,
		MultiValueHeaders: map[string][]string{"Content-Type": {"application/json"}},
		Body:              errorBody(code, message),
	}
}
