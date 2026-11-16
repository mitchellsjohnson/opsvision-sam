package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/domain"
	"opsvision/internal/store"
)

const exampleAPIKey = "sk-example-0123456789-abcdWXYZ"

// fakeProvider records Messages calls and answers with err (or a short
// text reply when err is nil).
type fakeProvider struct {
	mu    sync.Mutex
	calls []providerCall
	err   error
}

type providerCall struct {
	apiKey string
	req    assistant.MessagesRequest
}

func (f *fakeProvider) Messages(_ context.Context, apiKey string, req assistant.MessagesRequest) (assistant.MessagesResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, providerCall{apiKey, req})
	if f.err != nil {
		return assistant.MessagesResponse{}, f.err
	}
	return assistant.MessagesResponse{Content: []assistant.Block{{Type: "text", Text: "h"}}, StopReason: "max_tokens"}, nil
}

func (f *fakeProvider) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type credentialStatusBody struct {
	Configured bool       `json:"configured"`
	Last4      *string    `json:"last4"`
	UpdatedAt  *time.Time `json:"updatedAt"`
}

type assistantSettingsBody struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model"`
}

// newAssistantEnv is a test API with an AES sealer and a fake provider.
func newAssistantEnv(t *testing.T) (*testEnv, *fakeProvider, assistant.Sealer) {
	t.Helper()
	sealer, err := assistant.NewAESSealer(bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	fp := &fakeProvider{}
	env := newTestEnvDeps(t, nil, func(d *Deps) {
		d.Sealer = sealer
		d.Provider = fp
	})
	return env, fp, sealer
}

func TestAssistantCredentialLifecycle(t *testing.T) {
	env, fp, sealer := newAssistantEnv(t)
	tok := env.tokens["t1-viewer"]
	ctx := context.Background()

	var st credentialStatusBody
	env.expect(t, http.StatusOK, tok, "GET", "/me/assistant/credential", nil, &st)
	if st.Configured || st.Last4 != nil || st.UpdatedAt != nil {
		t.Fatalf("initial status = %+v, want not configured", st)
	}

	status, raw := env.call(t, tok, "PUT", "/me/assistant/credential", map[string]string{"apiKey": "  " + exampleAPIKey + "\n"})
	if status != http.StatusOK {
		t.Fatalf("PUT: status %d: %s", status, raw)
	}
	if strings.Contains(string(raw), exampleAPIKey) {
		t.Fatal("PUT response contains the key")
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatal(err)
	}
	if !st.Configured || st.Last4 == nil || *st.Last4 != "WXYZ" || st.UpdatedAt == nil || !st.UpdatedAt.Equal(testNow) {
		t.Fatalf("PUT status = %+v", st)
	}

	// Validated with one minimal call on the tenant's model.
	if fp.callCount() != 1 {
		t.Fatalf("provider calls = %d, want 1", fp.callCount())
	}
	call := fp.calls[0]
	if call.apiKey != exampleAPIKey || call.req.Model != domain.DefaultAssistantModel || call.req.MaxTokens != 1 ||
		len(call.req.Messages) != 1 || len(call.req.Tools) != 0 {
		t.Fatalf("validation call = %+v", call)
	}

	// Stored sealed, bound to the tenant and user.
	cred, err := env.store.GetCredential(ctx, "t1", "u-t1-viewer")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(cred.Sealed, []byte(exampleAPIKey)) || bytes.Contains(cred.Sealed, []byte("0123456789")) {
		t.Fatal("the store holds the key in plaintext")
	}
	if cred.Last4 != "WXYZ" || !cred.UpdatedAt.Equal(testNow) {
		t.Fatalf("stored = %+v", cred)
	}
	plain, err := sealer.Open(ctx, cred.Sealed, assistant.CredentialContext("t1", "u-t1-viewer"))
	if err != nil || string(plain) != exampleAPIKey {
		t.Fatalf("Open = %q, %v", plain, err)
	}
	if _, err := sealer.Open(ctx, cred.Sealed, assistant.CredentialContext("t1", "u-t1-admin")); err == nil {
		t.Fatal("the sealed key opens under another user's context")
	}

	status, raw = env.call(t, tok, "GET", "/me/assistant/credential", nil)
	if status != http.StatusOK || strings.Contains(string(raw), exampleAPIKey) {
		t.Fatalf("GET: %d %s", status, raw)
	}
	var got credentialStatusBody
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if !got.Configured || *got.Last4 != "WXYZ" || !got.UpdatedAt.Equal(testNow) {
		t.Fatalf("GET status = %+v", got)
	}

	// Another user in the tenant has none.
	env.expect(t, http.StatusOK, env.tokens["t1-admin"], "GET", "/me/assistant/credential", nil, &got)
	if got.Configured {
		t.Fatal("another user sees a configured key")
	}

	env.expect(t, http.StatusNoContent, tok, "DELETE", "/me/assistant/credential", nil, nil)
	env.expect(t, http.StatusOK, tok, "GET", "/me/assistant/credential", nil, &got)
	if got.Configured {
		t.Fatal("still configured after DELETE")
	}
	env.expectError(t, http.StatusNotFound, codeNotFound, tok, "DELETE", "/me/assistant/credential", nil)

	// Audited without the key.
	var actions []string
	for _, e := range env.audits(t, "t1") {
		if e.TargetType != "assistant_credential" {
			continue
		}
		actions = append(actions, e.Action)
		if e.ActorID != "u-t1-viewer" || e.TargetID != "u-t1-viewer" || e.Channel != channelUI {
			t.Errorf("audit entry = %+v", e)
		}
		for _, b := range [][]byte{e.Before, e.After} {
			if bytes.Contains(b, []byte(exampleAPIKey)) || bytes.Contains(b, []byte("WXYZ")) {
				t.Errorf("audit %s carries the key or its last 4: %s", e.Action, b)
			}
		}
	}
	if strings.Join(actions, ",") != "assistant_credential.put,assistant_credential.delete" {
		t.Fatalf("audit actions = %v", actions)
	}
}

func TestAssistantCredentialUsesTenantModel(t *testing.T) {
	env, fp, _ := newAssistantEnv(t)
	env.expect(t, http.StatusOK, env.tokens["t1-admin"], "PUT", "/assistant/settings",
		assistantSettingsBody{Enabled: true, Model: "claude-sonnet-5-5"}, nil)
	env.expect(t, http.StatusOK, env.tokens["t1-contributor"], "PUT", "/me/assistant/credential",
		map[string]string{"apiKey": exampleAPIKey}, nil)
	if fp.callCount() != 1 || fp.calls[0].req.Model != "claude-sonnet-5-5" || fp.calls[0].req.MaxTokens != 1 {
		t.Fatalf("validation call = %+v", fp.calls)
	}
}

func TestAssistantCredentialProviderFailures(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{"bad key", fmt.Errorf("%w: HTTP 401", assistant.ErrBadKey), http.StatusBadRequest, codeInvalid, "That key was rejected by the provider."},
		{"rate limited", fmt.Errorf("%w: HTTP 429", assistant.ErrRateLimited), http.StatusServiceUnavailable, codeAssistantUnavailable, ""},
		{"unavailable", fmt.Errorf("%w: HTTP 503", assistant.ErrUnavailable), http.StatusServiceUnavailable, codeAssistantUnavailable, ""},
		{"timeout", fmt.Errorf("%w: %w", assistant.ErrUnavailable, context.DeadlineExceeded), http.StatusServiceUnavailable, codeAssistantUnavailable, ""},
		{"unknown model", &assistant.APIError{Status: 404, Type: "not_found_error", Message: "model: x"}, http.StatusBadRequest, codeInvalid, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env, fp, _ := newAssistantEnv(t)
			fp.err = c.err
			tok := env.tokens["t1-viewer"]
			got := env.expectError(t, c.wantStatus, c.wantCode, tok, "PUT", "/me/assistant/credential", map[string]string{"apiKey": exampleAPIKey})
			if c.wantMsg != "" && got.Error.Message != c.wantMsg {
				t.Errorf("message = %q, want %q", got.Error.Message, c.wantMsg)
			}
			if strings.Contains(got.Error.Message, exampleAPIKey) {
				t.Error("error message contains the key")
			}
			if _, err := env.store.GetCredential(context.Background(), "t1", "u-t1-viewer"); !errors.Is(err, store.ErrNotFound) {
				t.Errorf("a key was stored after a failed validation: %v", err)
			}
			if n := len(env.audits(t, "t1")); n != 0 {
				t.Errorf("audit entries = %d, want 0", n)
			}
		})
	}
}

func TestAssistantCredentialBadKeyKeepsPrevious(t *testing.T) {
	env, fp, _ := newAssistantEnv(t)
	tok := env.tokens["t1-viewer"]
	env.expect(t, http.StatusOK, tok, "PUT", "/me/assistant/credential", map[string]string{"apiKey": exampleAPIKey}, nil)
	fp.err = assistant.ErrBadKey
	env.expectError(t, http.StatusBadRequest, codeInvalid, tok, "PUT", "/me/assistant/credential", map[string]string{"apiKey": "sk-example-other-key-9999"})
	var st credentialStatusBody
	env.expect(t, http.StatusOK, tok, "GET", "/me/assistant/credential", nil, &st)
	if !st.Configured || *st.Last4 != "WXYZ" {
		t.Fatalf("status = %+v, want the previous key kept", st)
	}
}

func TestAssistantCredentialValidation(t *testing.T) {
	env, fp, _ := newAssistantEnv(t)
	tok := env.tokens["t1-viewer"]
	for name, body := range map[string]any{
		"empty":          map[string]string{"apiKey": ""},
		"spaces":         map[string]string{"apiKey": "   "},
		"inner space":    map[string]string{"apiKey": "sk-example with-space"},
		"control":        map[string]string{"apiKey": "sk-example\x00key"},
		"non-ascii":      map[string]string{"apiKey": "sk-exampleé"},
		"too long":       map[string]string{"apiKey": strings.Repeat("k", 513)},
		"missing apiKey": map[string]string{},
	} {
		got := env.expectError(t, http.StatusBadRequest, codeInvalid, tok, "PUT", "/me/assistant/credential", body)
		if name != "missing apiKey" && (len(got.Error.Details) != 1 || got.Error.Details[0].Path != "apiKey") {
			t.Errorf("%s: details = %+v", name, got.Error.Details)
		}
	}
	if fp.callCount() != 0 {
		t.Fatalf("provider called %d times for invalid input", fp.callCount())
	}
}

func TestAssistantCredentialUnavailableWithoutSealer(t *testing.T) {
	fp := &fakeProvider{}
	env := newTestEnvDeps(t, nil, func(d *Deps) { d.Provider = fp })
	tok := env.tokens["t1-viewer"]
	env.expectError(t, http.StatusServiceUnavailable, codeAssistantUnavailable, tok, "PUT", "/me/assistant/credential",
		map[string]string{"apiKey": exampleAPIKey})
	if fp.callCount() != 0 {
		t.Fatal("the provider was called with no way to store the key")
	}
	// Reading and removing still work.
	var st credentialStatusBody
	env.expect(t, http.StatusOK, tok, "GET", "/me/assistant/credential", nil, &st)
	if st.Configured {
		t.Fatal("configured without a sealer")
	}

	// No provider either.
	sealer, err := assistant.NewAESSealer(bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	env = newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer })
	env.expectError(t, http.StatusServiceUnavailable, codeAssistantUnavailable, env.tokens["t1-viewer"], "PUT", "/me/assistant/credential",
		map[string]string{"apiKey": exampleAPIKey})
}

func TestAssistantCredentialRequiresMembership(t *testing.T) {
	env, fp, _ := newAssistantEnv(t)
	env.expectError(t, http.StatusUnauthorized, codeUnauthorized, "", "GET", "/me/assistant/credential", nil)
	env.expectError(t, http.StatusForbidden, codeForbidden, env.tokens["operator"], "PUT", "/me/assistant/credential",
		map[string]string{"apiKey": exampleAPIKey})
	env.expectError(t, http.StatusForbidden, codeForbidden, env.tokens["operator"], "DELETE", "/me/assistant/credential", nil)
	if fp.callCount() != 0 {
		t.Fatal("the provider was called for a non-member")
	}
}

// TestAssistantCredentialNeverLogged runs every credential path, failures
// included, and requires that nothing logged carries the key.
func TestAssistantCredentialNeverLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	sealer, err := assistant.NewAESSealer(bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	fp := &fakeProvider{}
	failPut := true
	env := newTestEnvDeps(t, func(s store.Store) store.Store {
		return &failingCredentialStore{Store: s, fail: &failPut}
	}, func(d *Deps) {
		d.Sealer = sealer
		d.Provider = fp
	})
	tok := env.tokens["t1-viewer"]
	body := map[string]string{"apiKey": exampleAPIKey}
	env.expectError(t, http.StatusInternalServerError, codeInternal, tok, "PUT", "/me/assistant/credential", body)
	failPut = false
	for _, err := range []error{assistant.ErrBadKey, assistant.ErrRateLimited, assistant.ErrUnavailable, &assistant.APIError{Status: 400}, nil} {
		fp.err = err
		env.call(t, tok, "PUT", "/me/assistant/credential", body)
	}
	env.call(t, tok, "GET", "/me/assistant/credential", nil)
	env.call(t, tok, "DELETE", "/me/assistant/credential", nil)
	if buf.Len() == 0 {
		t.Fatal("expected the store failure to be logged")
	}
	if strings.Contains(buf.String(), exampleAPIKey) {
		t.Fatalf("the key was logged:\n%s", buf.String())
	}
}

// failingCredentialStore fails PutCredential while *fail is true.
type failingCredentialStore struct {
	store.Store
	fail *bool
}

func (s *failingCredentialStore) PutCredential(ctx context.Context, tenantID, userID string, c domain.AssistantCredential) error {
	if *s.fail {
		return errors.New("store unavailable")
	}
	return s.Store.PutCredential(ctx, tenantID, userID, c)
}

func TestAssistantSettings(t *testing.T) {
	env, _, _ := newAssistantEnv(t)

	var got assistantSettingsBody
	for _, role := range []string{"t1-viewer", "t1-contributor", "t1-admin"} {
		env.expect(t, http.StatusOK, env.tokens[role], "GET", "/assistant/settings", nil, &got)
		if got != (assistantSettingsBody{Enabled: true, Model: "claude-haiku-5-5"}) {
			t.Fatalf("%s: defaults = %+v", role, got)
		}
	}

	next := assistantSettingsBody{Enabled: false, Model: "claude-sonnet-5-5"}
	for _, role := range []string{"t1-viewer", "t1-contributor"} {
		env.expectError(t, http.StatusForbidden, codeForbidden, env.tokens[role], "PUT", "/assistant/settings", next)
	}
	env.expectError(t, http.StatusForbidden, codeForbidden, env.tokens["operator"], "GET", "/assistant/settings", nil)
	if n := len(env.audits(t, "t1")); n != 0 {
		t.Fatalf("audit entries after rejected writes = %d", n)
	}

	env.expect(t, http.StatusOK, env.tokens["t1-admin"], "PUT", "/assistant/settings", next, &got)
	if got != next {
		t.Fatalf("PUT = %+v", got)
	}
	env.expect(t, http.StatusOK, env.tokens["t1-viewer"], "GET", "/assistant/settings", nil, &got)
	if got != next {
		t.Fatalf("GET after PUT = %+v", got)
	}
	// Per tenant.
	env.expect(t, http.StatusOK, env.tokens["t2-viewer"], "GET", "/assistant/settings", nil, &got)
	if got != (assistantSettingsBody{Enabled: true, Model: "claude-haiku-5-5"}) {
		t.Fatalf("t2 settings = %+v", got)
	}

	audits := env.audits(t, "t1")
	if len(audits) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(audits))
	}
	e := audits[0]
	if e.Action != "assistant_settings.update" || e.TargetType != "assistant_settings" || e.TargetID != "t1" || e.ActorID != "u-t1-admin" {
		t.Errorf("audit = %+v", e)
	}
	var before, after assistantSettingsBody
	if err := json.Unmarshal(e.Before, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(e.After, &after); err != nil {
		t.Fatal(err)
	}
	if before != (assistantSettingsBody{Enabled: true, Model: "claude-haiku-5-5"}) || after != next {
		t.Errorf("audit before %+v after %+v", before, after)
	}
}

func TestAssistantSettingsModelValidation(t *testing.T) {
	env, _, _ := newAssistantEnv(t)
	admin := env.tokens["t1-admin"]
	for _, model := range []string{"", "Claude-Haiku", "claude haiku", "claude_haiku", "claude/haiku", " claude-haiku-5-5", strings.Repeat("a", 101), "modèle"} {
		got := env.expectError(t, http.StatusBadRequest, codeInvalid, admin, "PUT", "/assistant/settings", assistantSettingsBody{Enabled: true, Model: model})
		if len(got.Error.Details) != 1 || got.Error.Details[0].Path != "model" {
			t.Errorf("model %q: details = %+v", model, got.Error.Details)
		}
	}
	for _, model := range []string{"claude-haiku-5-5", "claude-sonnet-5-5", "a", "model.v2-0", strings.Repeat("a", 100)} {
		var got assistantSettingsBody
		env.expect(t, http.StatusOK, admin, "PUT", "/assistant/settings", assistantSettingsBody{Enabled: true, Model: model}, &got)
		if got.Model != model {
			t.Errorf("model %q stored as %q", model, got.Model)
		}
	}
	env.expectError(t, http.StatusBadRequest, codeInvalid, admin, "PUT", "/assistant/settings", map[string]any{"enabled": true})
}

func TestAssistantCredentialOperationsNotInMCPCatalog(t *testing.T) {
	tools, err := Tools()
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.Name] = true
		if strings.HasPrefix(tool.PathTemplate, "/me/assistant/credential") {
			t.Errorf("credential operation %s is an MCP tool", tool.Name)
		}
	}
	for _, n := range []string{"get_my_assistant_credential", "put_my_assistant_credential", "delete_my_assistant_credential"} {
		if names[n] {
			t.Errorf("%s is in the MCP catalog", n)
		}
	}
	for _, n := range []string{"get_assistant_settings", "put_assistant_settings"} {
		if !names[n] {
			t.Errorf("%s is missing from the MCP catalog", n)
		}
	}
}
