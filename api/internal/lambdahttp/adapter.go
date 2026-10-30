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
			return jsonError(http.StatusBadRequest, "invalid", "request body is not valid base64"), nil
		}

		rec := &recorder{header: http.Header{}, status: http.StatusOK}
		serve(h, rec, req)

		resp := rec.response()
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
			return nil, fmt.Errorf("decode body: %w", err)
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
	u := &url.URL{
		Path:     routePath(ev.Path, ev.RequestContext.Stage),
		RawQuery: query.Encode(),
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = header
	req.ContentLength = int64(len(body))
	req.RemoteAddr = ev.RequestContext.Identity.SourceIP
	if host := header.Get("Host"); host != "" {
		req.Host = host
	}
	return req, nil
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

// response converts the recorded response to a proxy response.
func (r *recorder) response() events.APIGatewayProxyResponse {
	resp := events.APIGatewayProxyResponse{
		StatusCode:        r.status,
		MultiValueHeaders: map[string][]string(r.header.Clone()),
	}
	if isBinary(r.header, r.body.Len()) {
		resp.Body = base64.StdEncoding.EncodeToString(r.body.Bytes())
		resp.IsBase64Encoded = true
	} else {
		resp.Body = r.body.String()
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
		// Nothing to interpret: an empty body is text; an untyped body is
		// treated as binary rather than risking corruption.
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
