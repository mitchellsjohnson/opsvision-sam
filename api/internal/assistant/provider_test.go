package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testAPIKey = "sk-example-test-key-0123456789"

func TestProviderRequestShape(t *testing.T) {
	var gotHeader http.Header
	var gotPath, gotMethod string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader, gotPath, gotMethod = r.Header.Clone(), r.URL.Path, r.Method
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &gotBody); err != nil {
			t.Errorf("request body is not JSON: %s", raw)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
			"content": [
				{"type": "text", "text": "Looking that up."},
				{"type": "tool_use", "id": "toolu_1", "name": "get_scorecard_view", "input": {"sc": "delivery"}}
			],
			"stop_reason": "tool_use",
			"usage": {"input_tokens": 120, "output_tokens": 34}
		}`)
	}))
	defer srv.Close()

	p := NewHTTPProvider(srv.URL, nil)
	resp, err := p.Messages(context.Background(), testAPIKey, MessagesRequest{
		Model:     "claude-haiku-5-5",
		System:    "You are SAM.",
		MaxTokens: 2000,
		Messages: []Message{
			{Role: "user", Content: []Block{{Type: "text", Text: "How is delivery doing?"}}},
			{Role: "assistant", Content: []Block{{Type: "tool_use", ID: "toolu_0", Name: "list_scorecards", Input: json.RawMessage(`{}`)}}},
			{Role: "user", Content: []Block{{Type: "tool_result", ToolUseID: "toolu_0", Content: "[]", IsError: true}}},
		},
		Tools: []ToolDef{{Name: "get_scorecard_view", Description: "View", InputSchema: map[string]any{"type": "object"}}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if gotMethod != http.MethodPost || gotPath != "/v1/messages" {
		t.Errorf("request = %s %s, want POST /v1/messages", gotMethod, gotPath)
	}
	for k, want := range map[string]string{
		"X-Api-Key":         testAPIKey,
		"Anthropic-Version": "2023-06-01",
		"Content-Type":      "application/json",
	} {
		if got := gotHeader.Get(k); got != want {
			t.Errorf("header %s = %q, want %q", k, got, want)
		}
	}
	if gotHeader.Get("Authorization") != "" {
		t.Error("the key must go in x-api-key only, not Authorization")
	}

	wantBody := map[string]any{
		"model":      "claude-haiku-5-5",
		"system":     "You are SAM.",
		"max_tokens": float64(2000),
		"messages": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "How is delivery doing?"}}},
			map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "toolu_0", "name": "list_scorecards", "input": map[string]any{}}}},
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_0", "content": "[]", "is_error": true}}},
		},
		"tools": []any{map[string]any{"name": "get_scorecard_view", "description": "View", "input_schema": map[string]any{"type": "object"}}},
	}
	gotJSON, _ := json.Marshal(gotBody)
	wantJSON, _ := json.Marshal(wantBody)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("body =\n%s\nwant\n%s", gotJSON, wantJSON)
	}

	if resp.StopReason != "tool_use" || resp.Usage != (Usage{InputTokens: 120, OutputTokens: 34}) {
		t.Errorf("resp = %+v", resp)
	}
	if len(resp.Content) != 2 || resp.Content[0].Text != "Looking that up." ||
		resp.Content[1].Type != "tool_use" || resp.Content[1].ID != "toolu_1" || resp.Content[1].Name != "get_scorecard_view" ||
		string(resp.Content[1].Input) != `{"sc": "delivery"}` {
		t.Errorf("content = %+v", resp.Content)
	}
}

func TestProviderOmitsEmptyOptionalFields(t *testing.T) {
	var raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ = io.ReadAll(r.Body)
		_, _ = io.WriteString(w, `{"content": [], "stop_reason": "max_tokens", "usage": {"input_tokens": 1, "output_tokens": 1}}`)
	}))
	defer srv.Close()
	_, err := NewHTTPProvider(srv.URL+"/", nil).Messages(context.Background(), testAPIKey, MessagesRequest{
		Model: "m", MaxTokens: 1, Messages: []Message{{Role: "user", Content: []Block{{Type: "text", Text: "hi"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"max_tokens":1}`
	if string(raw) != want {
		t.Errorf("body = %s, want %s", raw, want)
	}
}

func TestProviderErrorMapping(t *testing.T) {
	cases := []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrBadKey},
		{http.StatusForbidden, ErrBadKey},
		{http.StatusTooManyRequests, ErrRateLimited},
		{http.StatusInternalServerError, ErrUnavailable},
		{http.StatusBadGateway, ErrUnavailable},
		{529, ErrUnavailable},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(c.status)
			// A hostile or buggy upstream echoing the key must not leak it.
			_, _ = io.WriteString(w, `{"type":"error","error":{"type":"x","message":"bad key `+r.Header.Get("x-api-key")+`"}}`)
		}))
		_, err := NewHTTPProvider(srv.URL, nil).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
		srv.Close()
		if !errors.Is(err, c.want) {
			t.Errorf("HTTP %d: err = %v, want %v", c.status, err, c.want)
			continue
		}
		if strings.Contains(err.Error(), testAPIKey) {
			t.Errorf("HTTP %d: error leaks the key: %v", c.status, err)
		}
	}
}

func TestProviderOtherClientErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"not_found_error","message":"model: no-such-model `+r.Header.Get("x-api-key")+`"}}`)
	}))
	defer srv.Close()
	_, err := NewHTTPProvider(srv.URL, nil).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "no-such-model", MaxTokens: 1})
	var ae *APIError
	if !errors.As(err, &ae) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if ae.Status != http.StatusNotFound || ae.Type != "not_found_error" || !strings.Contains(ae.Message, "no-such-model") {
		t.Errorf("APIError = %+v", ae)
	}
	for _, sentinel := range []error{ErrBadKey, ErrRateLimited, ErrUnavailable} {
		if errors.Is(err, sentinel) {
			t.Errorf("404 matched %v", sentinel)
		}
	}
	if strings.Contains(err.Error(), testAPIKey) || strings.Contains(ae.Message, testAPIKey) {
		t.Errorf("error leaks the key: %v", err)
	}
}

func TestProviderTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	hc := &http.Client{Timeout: 50 * time.Millisecond}
	_, err := NewHTTPProvider(srv.URL, hc).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("client timeout: err = %v, want ErrUnavailable", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = NewHTTPProvider(srv.URL, nil).Messages(ctx, testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
	if !errors.Is(err, ErrUnavailable) || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("context deadline: err = %v, want ErrUnavailable wrapping DeadlineExceeded", err)
	}
}

func TestProviderUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	_, err := NewHTTPProvider(url, nil).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

func TestProviderMalformedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `<html>not json</html>`)
	}))
	defer srv.Close()
	_, err := NewHTTPProvider(srv.URL, nil).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}

func TestProviderDoesNotFollowRedirects(t *testing.T) {
	var leaked string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("x-api-key")
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/v1/messages", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	hc := &http.Client{}
	_, err := NewHTTPProvider(srv.URL, hc).Messages(context.Background(), testAPIKey, MessagesRequest{Model: "m", MaxTokens: 1})
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
	if leaked != "" {
		t.Error("the key was sent to the redirect target")
	}
	if hc.CheckRedirect != nil {
		t.Error("NewHTTPProvider modified the caller's client")
	}
}

func TestProviderDefaultBaseURL(t *testing.T) {
	p := NewHTTPProvider("", nil).(*httpProvider)
	if p.url != "https://api.anthropic.com/v1/messages" {
		t.Errorf("url = %q", p.url)
	}
}
