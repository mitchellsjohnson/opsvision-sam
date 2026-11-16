package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"opsvision/internal/auth"
)

// Dispatcher calls the API operation behind a tool with the tool's
// arguments, returning the HTTP status and response body. err is for a call
// that could not be made; an API error is a status and its error envelope.
type Dispatcher interface {
	Call(ctx context.Context, t Tool, args map[string]any) (status int, body []byte, err error)
}

// ErrNoPrincipal is returned by an HTTP dispatcher whose context carries no
// authenticated caller.
var ErrNoPrincipal = errors.New("mcp: no authenticated caller in the context")

// ArgumentError is a tool argument that cannot be sent; the model can fix it.
type ArgumentError struct{ Name, Message string }

func (e *ArgumentError) Error() string { return "argument " + e.Name + ": " + e.Message }

// NewHTTPDispatcher returns a Dispatcher that serves each call with h, which
// must route /v1 paths and must not authenticate: the request carries the
// caller of ctx (auth.FromContext) with Principal.Channel set to channel, so
// the API authorizes and audits it as that caller arriving on that channel.
// The response is recorded in memory and never compressed.
func NewHTTPDispatcher(h http.Handler, channel string) Dispatcher {
	return httpDispatcher{h: h, channel: channel}
}

type httpDispatcher struct {
	h       http.Handler
	channel string
}

func (d httpDispatcher) Call(ctx context.Context, t Tool, args map[string]any) (int, []byte, error) {
	p, ok := auth.FromContext(ctx)
	if !ok {
		return 0, nil, ErrNoPrincipal
	}
	p.Channel = d.channel
	req, err := newRequest(auth.WithPrincipal(ctx, p), t, args)
	if err != nil {
		return 0, nil, err
	}
	rec := &recorder{header: http.Header{}}
	d.h.ServeHTTP(rec, req)
	if rec.status == 0 {
		rec.status = http.StatusOK
	}
	return rec.status, rec.body.Bytes(), nil
}

// newRequest builds the API request of a tool call under /v1: path arguments
// fill the path template (each escaped as one segment), query arguments
// become the query (a list repeats the name), and the "body" argument is
// encoded as the JSON body. A missing or unusable path argument, or an
// argument of a shape the query cannot carry, is an *ArgumentError.
func newRequest(ctx context.Context, t Tool, args map[string]any) (*http.Request, error) {
	raw, escaped := t.PathTemplate, t.PathTemplate
	for _, name := range t.PathParams {
		v, ok := args[name]
		if !ok || v == nil {
			return nil, &ArgumentError{name, "is required"}
		}
		s, err := scalar(v)
		if err != nil {
			return nil, &ArgumentError{name, err.Error()}
		}
		if s == "" || s == "." || s == ".." {
			return nil, &ArgumentError{name, fmt.Sprintf("%q is not a valid value", s)}
		}
		raw = strings.ReplaceAll(raw, "{"+name+"}", s)
		escaped = strings.ReplaceAll(escaped, "{"+name+"}", url.PathEscape(s))
	}
	q := url.Values{}
	for _, name := range t.QueryParams {
		v, ok := args[name]
		if !ok || v == nil {
			continue
		}
		if list, isList := v.([]any); isList {
			for _, x := range list {
				s, err := scalar(x)
				if err != nil {
					return nil, &ArgumentError{name, err.Error()}
				}
				q.Add(name, s)
			}
			continue
		}
		s, err := scalar(v)
		if err != nil {
			return nil, &ArgumentError{name, err.Error()}
		}
		q.Set(name, s)
	}
	var body io.Reader = http.NoBody
	if b, ok := args[bodyArg]; ok && t.HasBody && b != nil {
		enc, err := json.Marshal(b)
		if err != nil {
			return nil, &ArgumentError{bodyArg, "cannot be encoded as JSON"}
		}
		body = bytes.NewReader(enc)
	}
	u := &url.URL{Path: "/v1" + raw, RawPath: "/v1" + escaped, RawQuery: q.Encode()}
	req, err := http.NewRequestWithContext(ctx, t.Method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != http.NoBody {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// scalar formats a string, number or boolean argument for a path or query.
func scalar(v any) (string, error) {
	switch x := v.(type) {
	case string:
		return x, nil
	case bool:
		return strconv.FormatBool(x), nil
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), nil
	case json.Number:
		return x.String(), nil
	case int:
		return strconv.Itoa(x), nil
	}
	return "", errors.New("must be a string, number, or boolean")
}

// recorder captures a response in memory.
type recorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *recorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(p)
}
