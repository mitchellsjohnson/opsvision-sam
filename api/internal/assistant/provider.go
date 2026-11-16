package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is the model provider's API origin.
const DefaultBaseURL = "https://api.anthropic.com"

// providerVersion is the provider API version every request pins.
const providerVersion = "2023-06-01"

// maxResponseBytes bounds a provider response body.
const maxResponseBytes = 4 << 20

// defaultTimeout bounds one provider call when the caller supplies no client.
const defaultTimeout = 60 * time.Second

// Provider failures. A call fails with one of these (wrapped), with an
// *APIError for any other rejection, or with a context error.
var (
	// ErrBadKey means the provider rejected the API key (HTTP 401 or 403).
	ErrBadKey = errors.New("assistant: the provider rejected the API key")
	// ErrRateLimited means the provider is rate limiting the key (HTTP 429).
	ErrRateLimited = errors.New("assistant: the provider is rate limiting this key")
	// ErrUnavailable means the provider could not be reached or failed
	// (HTTP 5xx, a timeout, a network error, or an unreadable response).
	ErrUnavailable = errors.New("assistant: the provider is unavailable")
)

// APIError is a provider rejection other than ErrBadKey and ErrRateLimited,
// such as an unknown model (HTTP 404) or a malformed request (HTTP 400).
// Message is the provider's, with the API key removed.
type APIError struct {
	Status        int
	Type, Message string
}

// Error implements error.
func (e *APIError) Error() string {
	return fmt.Sprintf("assistant: the provider returned HTTP %d %s: %s", e.Status, e.Type, e.Message)
}

// Provider calls the model provider's Messages API with a user's API key.
type Provider interface {
	Messages(ctx context.Context, apiKey string, req MessagesRequest) (MessagesResponse, error)
}

// MessagesRequest is one Messages API call.
type MessagesRequest struct {
	Model     string    `json:"model"`
	System    string    `json:"system,omitempty"`
	Messages  []Message `json:"messages"`
	Tools     []ToolDef `json:"tools,omitempty"`
	MaxTokens int       `json:"max_tokens"`
}

// Message is one conversation turn: Role "user" or "assistant".
type Message struct {
	Role    string  `json:"role"`
	Content []Block `json:"content"`
}

// Block is a content block. Type "text" uses Text; "tool_use" uses ID, Name
// and Input; "tool_result" uses ToolUseID, Content and IsError.
type Block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

// ToolDef is a tool offered to the model. InputSchema is a JSON Schema
// object.
type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema"`
}

// MessagesResponse is the model's reply.
type MessagesResponse struct {
	Content    []Block `json:"content"`
	StopReason string  `json:"stop_reason"`
	Usage      Usage   `json:"usage"`
}

// Usage is the token count of one call.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type httpProvider struct {
	url string
	hc  *http.Client
}

// NewHTTPProvider returns a Provider that POSTs to baseURL + "/v1/messages"
// (DefaultBaseURL when baseURL is empty) with hc (a client with a 60 s
// timeout when nil). Redirects are never followed, so the key goes only to
// baseURL; hc itself is not modified.
func NewHTTPProvider(baseURL string, hc *http.Client) Provider {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	c := &http.Client{Timeout: defaultTimeout}
	if hc != nil {
		cp := *hc
		c = &cp
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &httpProvider{url: strings.TrimRight(baseURL, "/") + "/v1/messages", hc: c}
}

func (p *httpProvider) Messages(ctx context.Context, apiKey string, req MessagesRequest) (MessagesResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return MessagesResponse{}, fmt.Errorf("assistant: encode request: %w", err)
	}
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return MessagesResponse{}, fmt.Errorf("assistant: build request: %w", err)
	}
	hr.Header.Set("x-api-key", apiKey)
	hr.Header.Set("anthropic-version", providerVersion)
	hr.Header.Set("content-type", "application/json")

	resp, err := p.hc.Do(hr)
	if err != nil {
		return MessagesResponse{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return MessagesResponse{}, fmt.Errorf("%w: read response: %w", ErrUnavailable, err)
	}
	if len(raw) > maxResponseBytes {
		return MessagesResponse{}, fmt.Errorf("%w: response over %d bytes", ErrUnavailable, maxResponseBytes)
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		errType, msg := providerError(raw, apiKey)
		switch {
		case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
			return MessagesResponse{}, fmt.Errorf("%w: HTTP %d %s", ErrBadKey, resp.StatusCode, errType)
		case resp.StatusCode == http.StatusTooManyRequests:
			return MessagesResponse{}, fmt.Errorf("%w: HTTP %d %s", ErrRateLimited, resp.StatusCode, errType)
		case resp.StatusCode >= 500 || resp.StatusCode < 400:
			return MessagesResponse{}, fmt.Errorf("%w: HTTP %d %s", ErrUnavailable, resp.StatusCode, errType)
		}
		return MessagesResponse{}, &APIError{Status: resp.StatusCode, Type: errType, Message: msg}
	}

	var out MessagesResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return MessagesResponse{}, fmt.Errorf("%w: decode response: %w", ErrUnavailable, err)
	}
	return out, nil
}

// providerError extracts the type and message of a provider error body,
// with apiKey removed in case the provider echoes it.
func providerError(raw []byte, apiKey string) (errType, msg string) {
	var body struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	redact := func(s string) string {
		if apiKey == "" {
			return s
		}
		return strings.ReplaceAll(s, apiKey, "[redacted]")
	}
	return redact(body.Error.Type), redact(body.Error.Message)
}
