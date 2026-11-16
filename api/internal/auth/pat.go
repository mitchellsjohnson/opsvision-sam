package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// TokenPrefix starts every personal access token secret. A bearer credential
// with this prefix is looked up as an access token, never parsed as a JWT.
const TokenPrefix = "ovs_pat_"

// tokenDisplayLen is how much of a secret is kept as its display prefix.
const tokenDisplayLen = 12

// tokenTouchInterval is the most often an access token's LastUsedAt is written.
const tokenTouchInterval = time.Minute

// NewToken returns a new access token secret (TokenPrefix plus 32 random bytes,
// base64url without padding), its SHA-256 hash, and its display prefix (the
// first 12 characters). Only the hash and prefix may be stored.
func NewToken() (secret string, hash [32]byte, prefix string, err error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", hash, "", fmt.Errorf("auth: generate token: %w", err)
	}
	secret = TokenPrefix + base64.RawURLEncoding.EncodeToString(b[:])
	return secret, HashToken(secret), secret[:tokenDisplayLen], nil
}

// HashToken returns the SHA-256 hash under which an access token is stored.
func HashToken(secret string) [32]byte { return sha256.Sum256([]byte(secret)) }

// authenticateToken resolves an access token to its owner. The tenant and the
// owner's membership are read on every request, so a role change or removal
// applies at once; a token never provisions a membership. An unknown,
// revoked, or expired token is 401; a missing tenant or membership is 403.
func (a *authenticator) authenticateToken(ctx context.Context, secret string) (Principal, *httpError) {
	if a.tokens == nil {
		return Principal{}, errUnauthorized
	}
	tok, err := a.tokens.TokenByHash(ctx, HashToken(secret))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return Principal{}, errUnauthorized
	case err != nil:
		slog.Error("auth: access token lookup failed", "err", err)
		return Principal{}, errInternal
	}
	now := a.now()
	if !now.Before(tok.ExpiresAt) {
		slog.Debug("auth: access token expired", "token", tok.ID)
		return Principal{}, errUnauthorized
	}

	tenant, err := a.ts.GetTenant(ctx, tok.TenantID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return Principal{}, forbidden("organization is not provisioned")
	case err != nil:
		slog.Error("auth: tenant lookup failed", "tenant", tok.TenantID, "err", err)
		return Principal{}, errInternal
	}
	p := Principal{UserID: tok.UserID, Tenant: &tenant, Channel: ChannelToken}
	m, herr := a.membership(ctx, p)
	switch {
	case herr != nil:
		return Principal{}, herr
	case m == nil:
		return Principal{}, forbidden("not a member of this organization")
	}
	p.Membership = m
	p.Email = m.Email
	p.Name = m.Name

	a.touch(ctx, tok, now)
	return p, nil
}

// touch records that tok was used at now, at most once per tokenTouchInterval.
// A failure is logged; it never fails the request.
func (a *authenticator) touch(ctx context.Context, tok domain.AccessToken, now time.Time) {
	if tok.LastUsedAt != nil && now.Sub(*tok.LastUsedAt) < tokenTouchInterval {
		return
	}
	if err := a.tokens.TouchToken(ctx, tok.TenantID, tok.UserID, tok.ID, now); err != nil {
		slog.Warn("auth: could not record access token use", "tenant", tok.TenantID, "token", tok.ID, "err", err)
	}
}
