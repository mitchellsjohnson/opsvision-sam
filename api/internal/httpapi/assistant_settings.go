package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// Assistant credential and settings limits.
const (
	minAPIKeyLen = 16
	maxAPIKeyLen = 512
	// keyCheckTimeout bounds the provider call that checks a key, so the
	// request answers within the API's own timeout.
	keyCheckTimeout = 20 * time.Second
)

// assistantModelPattern is what a model id may look like.
var assistantModelPattern = regexp.MustCompile(`^[a-z0-9.-]{1,100}$`)

// msgKeyRejected is the answer to a key the provider refuses.
const msgKeyRejected = "That key was rejected by the provider."

// credentialStatus is the API form of a stored credential. It carries the
// last 4 characters of the key and never the key.
func credentialStatus(c domain.AssistantCredential) AssistantCredentialStatus {
	last4, at := c.Last4, c.UpdatedAt
	return AssistantCredentialStatus{Configured: true, Last4: &last4, UpdatedAt: &at}
}

// credentialAudit is what the audit log records of a credential: that one
// is configured and when, not any part of the key.
type credentialAudit struct {
	Configured bool      `json:"configured"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// GetMyAssistantCredential reports whether the caller has an assistant key in
// the active tenant.
func (s *Server) GetMyAssistantCredential(ctx context.Context, _ GetMyAssistantCredentialRequestObject) (GetMyAssistantCredentialResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	c, err := s.store.GetCredential(ctx, p.Tenant.ID, p.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return GetMyAssistantCredential200JSONResponse{Configured: false}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetMyAssistantCredential200JSONResponse(credentialStatus(c)), nil
}

// PutMyAssistantCredential checks the caller's key with one minimal provider
// call on the tenant's model, then stores it sealed under the caller's
// tenant and user.
func (s *Server) PutMyAssistantCredential(ctx context.Context, req PutMyAssistantCredentialRequestObject) (PutMyAssistantCredentialResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	key := strings.TrimSpace(req.Body.ApiKey)
	var pr problems
	switch {
	case key == "":
		pr.add("apiKey", "must not be empty")
	case len(key) < minAPIKeyLen || len(key) > maxAPIKeyLen:
		pr.add("apiKey", "must be %d to %d characters", minAPIKeyLen, maxAPIKeyLen)
	case !printableASCII(key):
		pr.add("apiKey", "must be printable ASCII with no spaces")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	if s.sealer == nil || s.provider == nil {
		return nil, assistantUnavailable("The assistant is not configured on this server.")
	}

	settings, err := s.store.GetAssistantSettings(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	if err := s.checkKey(ctx, key, settings.Model); err != nil {
		return nil, err
	}

	sealed, err := s.sealer.Seal(ctx, []byte(key), assistant.CredentialContext(p.Tenant.ID, p.UserID))
	if err != nil {
		return nil, err
	}
	var before *credentialAudit
	prev, err := s.store.GetCredential(ctx, p.Tenant.ID, p.UserID)
	switch {
	case err == nil:
		before = &credentialAudit{Configured: true, UpdatedAt: prev.UpdatedAt}
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}
	cred := domain.AssistantCredential{Sealed: sealed, Last4: key[len(key)-4:], UpdatedAt: s.now()}
	if err := s.store.PutCredential(ctx, p.Tenant.ID, p.UserID, cred); err != nil {
		return nil, err
	}
	after := credentialAudit{Configured: true, UpdatedAt: cred.UpdatedAt}
	if err := s.audit(ctx, p, p.Tenant.ID, "assistant_credential.put", "assistant_credential", p.UserID, before, after); err != nil {
		return nil, err
	}
	return PutMyAssistantCredential200JSONResponse(credentialStatus(cred)), nil
}

// checkKey makes one minimal provider call with key on model and maps its
// failure to the API error the caller sees. Nothing logged carries the key.
func (s *Server) checkKey(ctx context.Context, key, model string) error {
	ctx, cancel := context.WithTimeout(ctx, keyCheckTimeout)
	defer cancel()
	_, err := s.provider.Messages(ctx, key, assistant.MessagesRequest{
		Model:     model,
		MaxTokens: 1,
		Messages:  []assistant.Message{{Role: "user", Content: []assistant.Block{{Type: "text", Text: "ping"}}}},
	})
	var ae *assistant.APIError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, assistant.ErrBadKey):
		return badRequest(msgKeyRejected)
	case errors.Is(err, assistant.ErrRateLimited):
		return assistantUnavailable("The provider is rate limiting this key; try again in a minute.")
	case errors.As(err, &ae):
		slog.Warn("httpapi: assistant key check refused", "model", model, "err", err)
		return badRequest("The provider did not accept a request for model " + model +
			"; a tenant admin can change the model in assistant settings.")
	default:
		slog.Warn("httpapi: assistant key check failed", "err", err)
		return assistantUnavailable("The provider could not be reached; try again later.")
	}
}

// printableASCII reports whether s is all printable ASCII other than space.
func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] <= ' ' || s[i] > '~' {
			return false
		}
	}
	return true
}

// DeleteMyAssistantCredential removes the caller's assistant key.
func (s *Server) DeleteMyAssistantCredential(ctx context.Context, _ DeleteMyAssistantCredentialRequestObject) (DeleteMyAssistantCredentialResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	prev, err := s.store.GetCredential(ctx, p.Tenant.ID, p.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, notFound("no assistant key is saved")
	}
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteCredential(ctx, p.Tenant.ID, p.UserID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, notFound("no assistant key is saved")
		}
		return nil, err
	}
	before := credentialAudit{Configured: true, UpdatedAt: prev.UpdatedAt}
	if err := s.audit(ctx, p, p.Tenant.ID, "assistant_credential.delete", "assistant_credential", p.UserID, before, nil); err != nil {
		return nil, err
	}
	return DeleteMyAssistantCredential204Response{}, nil
}

func apiAssistantSettings(a domain.AssistantSettings) AssistantSettings {
	return AssistantSettings{Enabled: a.Enabled, Model: a.Model}
}

// GetAssistantSettings returns the active tenant's assistant settings to any
// member.
func (s *Server) GetAssistantSettings(ctx context.Context, _ GetAssistantSettingsRequestObject) (GetAssistantSettingsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	a, err := s.store.GetAssistantSettings(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	return GetAssistantSettings200JSONResponse(apiAssistantSettings(a)), nil
}

// PutAssistantSettings saves the active tenant's assistant settings (tenant
// admin).
func (s *Server) PutAssistantSettings(ctx context.Context, req PutAssistantSettingsRequestObject) (PutAssistantSettingsResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	if !assistantModelPattern.MatchString(req.Body.Model) {
		pr.add("model", "must be 1 to 100 characters of a-z, 0-9, '.' and '-'")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	before, err := s.store.GetAssistantSettings(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	next := domain.AssistantSettings{Enabled: req.Body.Enabled, Model: req.Body.Model}
	if err := s.store.PutAssistantSettings(ctx, p.Tenant.ID, next); err != nil {
		return nil, err
	}
	out := apiAssistantSettings(next)
	if err := s.audit(ctx, p, p.Tenant.ID, "assistant_settings.update", "assistant_settings", p.Tenant.ID, apiAssistantSettings(before), out); err != nil {
		return nil, err
	}
	return PutAssistantSettings200JSONResponse(out), nil
}
