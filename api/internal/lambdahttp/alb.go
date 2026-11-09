package lambdahttp

import (
	"bytes"
	"context"
	"encoding/base64"
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

// maxALBResponseBytes is the most a Lambda target may return to an
// Application Load Balancer (1 MB). It is measured on the encoded body: a
// base64 body counts its encoded length.
const maxALBResponseBytes = 1_000_000

// ALBHandler returns a Lambda handler function that serves Application Load
// Balancer target group events with h. Pass the result to lambda.Start.
//
// The target group must have multi-value headers enabled: requests then carry
// multiValueHeaders and multiValueQueryStringParameters, and responses must
// answer with multiValueHeaders (single-value fields are used only as a
// fallback for requests). Unlike API Gateway, the load balancer sends the
// request path as the client sent it, with no stage prefix, and does not
// decode query strings; the adapter does both.
//
// A response whose encoded body exceeds 1,000,000 bytes cannot be returned
// through the load balancer; it becomes a 502 "response_too_large" error
// instead of an opaque load balancer failure.
func ALBHandler(h http.Handler) func(context.Context, events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error) {
	return func(ctx context.Context, ev events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error) {
		start := time.Now()
		header := albHeader(ev)
		traceID := header.Get("X-Amzn-Trace-Id")
		ctx = context.WithValue(ctx, requestIDKey{}, traceID)

		req, err := newALBRequest(ctx, ev, header)
		if err != nil {
			slog.WarnContext(ctx, "lambdahttp: bad request event", "requestId", traceID, "err", err)
			msg := "invalid request"
			if errors.Is(err, errBadBase64) {
				msg = "request body is not valid base64"
			}
			return albError(http.StatusBadRequest, "invalid", msg), nil
		}

		rec := &recorder{header: http.Header{}, status: http.StatusOK}
		serve(h, rec, req)

		resp := albResponse(rec, req.Method)
		if len(resp.Body) > maxALBResponseBytes {
			slog.WarnContext(ctx, "lambdahttp: response too large for the load balancer",
				"requestId", traceID, "method", req.Method, "path", req.URL.Path, "bytes", len(resp.Body))
			resp = albError(http.StatusBadGateway, "response_too_large", "response is too large to return")
		}
		slog.InfoContext(ctx, "request",
			"requestId", traceID,
			"method", req.Method,
			"path", req.URL.Path,
			"status", resp.StatusCode,
			"ms", time.Since(start).Milliseconds(),
		)
		return resp, nil
	}
}

// albHeader returns the request headers: the multi-value form when present,
// else the single-value form.
func albHeader(ev events.ALBTargetGroupRequest) http.Header {
	header := http.Header{}
	if len(ev.MultiValueHeaders) > 0 {
		for k, vs := range ev.MultiValueHeaders {
			for _, v := range vs {
				header.Add(k, v)
			}
		}
		return header
	}
	for k, v := range ev.Headers {
		header.Add(k, v)
	}
	return header
}

// newALBRequest builds the *http.Request for ev.
func newALBRequest(ctx context.Context, ev events.ALBTargetGroupRequest, header http.Header) (*http.Request, error) {
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

	// The load balancer passes query strings through still percent-encoded.
	query := url.Values{}
	if len(ev.MultiValueQueryStringParameters) > 0 {
		for k, vs := range ev.MultiValueQueryStringParameters {
			k = queryUnescape(k)
			for _, v := range vs {
				query.Add(k, queryUnescape(v))
			}
		}
	} else {
		for k, v := range ev.QueryStringParameters {
			query.Add(queryUnescape(k), queryUnescape(v))
		}
	}

	method := ev.HTTPMethod
	if method == "" {
		method = http.MethodGet
	}
	path := ev.Path
	if path == "" {
		path = "/"
	}
	// As in newRequest, the URL is assembled by hand so a path like //v1/x is
	// never re-parsed with a host.
	req, err := http.NewRequestWithContext(ctx, method, "/", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}
	req.URL, req.RequestURI = requestURL(path, query.Encode())
	req.Header = header
	req.ContentLength = int64(len(body))
	req.RemoteAddr = lastForwardedFor(header)
	if host := header.Get("Host"); host != "" {
		req.Host = host
	}
	return req, nil
}

// queryUnescape decodes one query component, leaving it as is if it is not a
// valid encoding.
func queryUnescape(s string) string {
	if dec, err := url.QueryUnescape(s); err == nil {
		return dec
	}
	return s
}

// lastForwardedFor returns the last X-Forwarded-For entry: the address the
// load balancer itself saw. Earlier entries are supplied by the client.
func lastForwardedFor(h http.Header) string {
	vals := h.Values("X-Forwarded-For")
	if len(vals) == 0 {
		return ""
	}
	parts := strings.Split(vals[len(vals)-1], ",")
	return strings.TrimSpace(parts[len(parts)-1])
}

// albResponse converts the recorded response to a target group response made
// for a request with method. Like net/http, it sends no body for HEAD or for
// statuses that forbid one, and it sniffs a Content-Type for an untyped body.
func albResponse(r *recorder, method string) events.ALBTargetGroupResponse {
	body := r.body.Bytes()
	if method == http.MethodHead || !bodyAllowed(r.status) {
		body = nil
	}
	h := r.header.Clone()
	if h.Get("Content-Type") == "" && len(body) > 0 && h.Get("Content-Encoding") == "" {
		h.Set("Content-Type", http.DetectContentType(body))
	}
	// The load balancer frames the response itself.
	h.Del("Content-Length")
	resp := events.ALBTargetGroupResponse{
		StatusCode:        r.status,
		StatusDescription: statusDescription(r.status),
		MultiValueHeaders: map[string][]string(h),
	}
	if isText(h) || len(body) == 0 {
		resp.Body = string(body)
	} else {
		resp.Body = base64.StdEncoding.EncodeToString(body)
		resp.IsBase64Encoded = true
	}
	return resp
}

// isText reports whether a response may travel as a plain string: a text,
// JSON, JavaScript or SVG type with no Content-Encoding.
func isText(h http.Header) bool {
	if h.Get("Content-Encoding") != "" {
		return false
	}
	mt, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil {
		return false
	}
	switch {
	case strings.HasPrefix(mt, "text/"),
		mt == "application/json", strings.HasSuffix(mt, "+json"),
		mt == "application/javascript", mt == "application/ecmascript",
		mt == "image/svg+xml":
		return true
	}
	return false
}

func statusDescription(status int) string {
	return fmt.Sprintf("%d %s", status, http.StatusText(status))
}

func albError(status int, code, message string) events.ALBTargetGroupResponse {
	return events.ALBTargetGroupResponse{
		StatusCode:        status,
		StatusDescription: statusDescription(status),
		MultiValueHeaders: map[string][]string{"Content-Type": {"application/json"}},
		Body:              errorBody(code, message),
	}
}
