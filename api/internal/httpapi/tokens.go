package httpapi

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// Access token limits.
const (
	maxActiveTokens      = 10
	maxTokenNameLen      = 100
	defaultTokenLifetime = 90
	maxTokenLifetime     = 365
)

// apiAccessToken is the listed form of a token. It never carries the secret
// or its hash, so it is also what the audit log records.
func apiAccessToken(t domain.AccessToken) AccessToken {
	return AccessToken{
		Id: t.ID, Name: t.Name, Prefix: t.Prefix,
		CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt, LastUsedAt: t.LastUsedAt,
	}
}

// ListMyTokens lists the caller's access tokens in the active tenant.
func (s *Server) ListMyTokens(ctx context.Context, _ ListMyTokensRequestObject) (ListMyTokensResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	toks, err := s.store.ListTokens(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	out := make([]AccessToken, len(toks))
	for i, t := range toks {
		out[i] = apiAccessToken(t)
	}
	return ListMyTokens200JSONResponse{Tokens: out}, nil
}

// CreateMyToken creates an access token for the caller in the active tenant
// and returns its secret, once. A request authenticated by an access token
// cannot create one, so a leaked token cannot outlive its own expiry, and a
// secret never reaches an MCP client or the model.
func (s *Server) CreateMyToken(ctx context.Context, req CreateMyTokenRequestObject) (CreateMyTokenResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if p.Channel != "" {
		return nil, forbidden("access tokens can only be created in the web app")
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	name := strings.TrimSpace(req.Body.Name)
	days := defaultTokenLifetime
	if req.Body.ExpiresInDays != nil {
		days = *req.Body.ExpiresInDays
	}
	var pr problems
	pr.nonEmpty("name", name)
	if utf8.RuneCountInString(name) > maxTokenNameLen {
		pr.add("name", "must be at most %d characters", maxTokenNameLen)
	}
	if days < 1 || days > maxTokenLifetime {
		pr.add("expiresInDays", "must be between 1 and %d", maxTokenLifetime)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	now := s.now()
	existing, err := s.store.ListTokens(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	active := 0
	for _, t := range existing {
		if now.Before(t.ExpiresAt) {
			active++
		}
	}
	if active >= maxActiveTokens {
		return nil, conflict("you already have the maximum of 10 active access tokens; revoke one first")
	}

	secret, hash, prefix, err := auth.NewToken()
	if err != nil {
		return nil, err
	}
	tok := domain.AccessToken{
		ID: s.newID(), TenantID: p.Tenant.ID, UserID: p.UserID, Name: name, Prefix: prefix, Hash: hash,
		CreatedAt: now, ExpiresAt: now.Add(time.Duration(days) * 24 * time.Hour),
	}
	if err := s.store.PutToken(ctx, tok); err != nil {
		return nil, err
	}
	listed := apiAccessToken(tok)
	if err := s.audit(ctx, p, p.Tenant.ID, "access_token.create", "access_token", tok.ID, nil, listed); err != nil {
		return nil, err
	}
	return CreateMyToken201JSONResponse{
		Id: listed.Id, Name: listed.Name, Prefix: listed.Prefix,
		CreatedAt: listed.CreatedAt, ExpiresAt: listed.ExpiresAt,
		Token: secret,
	}, nil
}

// DeleteMyToken revokes one of the caller's access tokens. Another user's
// token is not found.
func (s *Server) DeleteMyToken(ctx context.Context, req DeleteMyTokenRequestObject) (DeleteMyTokenResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	toks, err := s.store.ListTokens(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	var before *AccessToken
	for _, t := range toks {
		if t.ID == req.Id {
			a := apiAccessToken(t)
			before = &a
			break
		}
	}
	if before == nil {
		return nil, notFound("access token not found")
	}
	if err := s.store.DeleteToken(ctx, p.Tenant.ID, p.UserID, req.Id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, notFound("access token not found")
		}
		return nil, err
	}
	if err := s.audit(ctx, p, p.Tenant.ID, "access_token.delete", "access_token", req.Id, before, nil); err != nil {
		return nil, err
	}
	return DeleteMyToken204Response{}, nil
}
