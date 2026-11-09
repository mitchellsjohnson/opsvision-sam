package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	jwtmiddleware "github.com/auth0/go-jwt-middleware/v3"
	"github.com/auth0/go-jwt-middleware/v3/core"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// Middleware returns HTTP middleware that authenticates the request's bearer
// token, resolves the caller's tenant and membership from the token alone, and
// stores the resulting Principal in the request context (see FromContext).
//
// Failures use the API error envelope:
//   - missing or invalid token: 401 "unauthorized"
//   - org_id not provisioned, or no org_id and not an operator: 403 "forbidden"
//   - verification keys or the store unavailable: 503 / 500
//
// A caller with a valid org_id and no membership is provisioned one on first
// sign-in: the pending invitation for its email if there is one, else a
// membership with the tenant's DefaultRole. Operators are never auto-provisioned
// into a tenant.
//
// With Config.SingleTenantID set, org_id is ignored instead:
//   - sub without a trusted prefix: 403 "forbidden"
//   - the configured tenant missing: 403 "forbidden" (tenant not provisioned)
//   - no email claim and /userinfo failing: 503 "identity_unavailable"
//
// and first sign-in binds the invitation for the email, else makes a bootstrap
// admin email an admin, else uses the tenant's DefaultRole. A trusted caller's
// email counts as verified whatever email_verified says: the trusted
// connection is the organization's own directory.
//
// Middleware returns an error for an invalid Config (including a dev secret
// shorter than 32 bytes, or single-organization mode without trusted
// prefixes) or a nil store.
func Middleware(cfg Config, ts store.TenantStore) (func(http.Handler) http.Handler, error) {
	if ts == nil {
		return nil, errors.New("auth: tenant store is required")
	}
	v, err := newValidator(cfg)
	if err != nil {
		return nil, err
	}
	single, err := newSingleOrg(cfg)
	if err != nil {
		return nil, err
	}
	if cfg.Mode == ModeDev {
		slog.Warn("auth: dev mode enabled; tokens are signed with a shared secret. Never use outside local development")
	}
	a := &authenticator{validator: v, ts: ts, single: single}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, herr := a.authenticate(r)
			if herr != nil {
				herr.write(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
		})
	}, nil
}

type authenticator struct {
	validator tokenValidator
	ts        store.TenantStore
	single    *singleOrg // nil in the multi-tenant model
}

// httpError is an error already shaped for the client.
type httpError struct {
	status  int
	code    string
	message string
}

var (
	errUnauthorized = &httpError{http.StatusUnauthorized, "unauthorized", "missing or invalid token"}
	errUnavailable  = &httpError{http.StatusServiceUnavailable, "unavailable", "authentication is temporarily unavailable"}
	errInternal     = &httpError{http.StatusInternalServerError, "internal", "internal error"}
)

func forbidden(msg string) *httpError { return &httpError{http.StatusForbidden, "forbidden", msg} }

func (e *httpError) write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	if e.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="opsvision"`)
	}
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": e.code, "message": e.message},
	})
}

func (a *authenticator) authenticate(r *http.Request) (Principal, *httpError) {
	ctx := r.Context()

	extracted, err := jwtmiddleware.AuthHeaderTokenExtractor(r)
	// Only the Bearer scheme is accepted: a DPoP-scheme token would require
	// proof-of-possession checks this API does not perform.
	if err != nil || extracted.Token == "" || extracted.Scheme != core.AuthSchemeBearer {
		return Principal{}, errUnauthorized
	}
	v, err := verify(ctx, a.validator, extracted.Token)
	if err != nil {
		if isKeyFetchError(err) {
			slog.Error("auth: cannot fetch verification keys", "err", err)
			return Principal{}, errUnavailable
		}
		slog.Debug("auth: token rejected", "err", err)
		return Principal{}, errUnauthorized
	}

	c := v.claims
	p := Principal{
		UserID:     v.subject,
		Email:      c.Email,
		Name:       c.Name,
		IsOperator: c.isOperator(),
	}
	if a.single != nil {
		return a.authenticateSingle(ctx, extracted.Token, v, p)
	}

	if c.OrgID == "" {
		if !p.IsOperator {
			return Principal{}, forbidden("no organization in token")
		}
		return p, nil
	}

	tenant, err := a.ts.TenantByAuth0Org(ctx, c.OrgID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return Principal{}, forbidden("organization is not provisioned")
	case err != nil:
		slog.Error("auth: tenant lookup failed", "err", err)
		return Principal{}, errInternal
	}
	p.Tenant = &tenant
	return a.withMembership(ctx, p, c.EmailVerified != nil && *c.EmailVerified, false)
}

// withMembership attaches the caller's membership in p.Tenant, provisioning
// one on first sign-in (see provision).
func (a *authenticator) withMembership(ctx context.Context, p Principal, emailVerified, bootstrapAdmin bool) (Principal, *httpError) {
	tenant := *p.Tenant
	m, err := a.ts.GetMembership(ctx, tenant.ID, p.UserID)
	switch {
	case err == nil:
		p.Membership = &m
	case !errors.Is(err, store.ErrNotFound):
		slog.Error("auth: membership lookup failed", "tenant", tenant.ID, "err", err)
		return Principal{}, errInternal
	case p.IsOperator:
		// Operators run the platform; they get tenant rights only through an
		// explicit membership, never by signing in.
	default:
		m, err := a.provision(ctx, tenant, p, emailVerified, bootstrapAdmin)
		if err != nil {
			slog.Error("auth: first sign-in provisioning failed", "tenant", tenant.ID, "err", err)
			return Principal{}, errInternal
		}
		p.Membership = &m
	}
	return p, nil
}

// provision creates the caller's membership on first sign-in.
//
// If an invitation exists for the caller's email (a pending membership keyed
// PendingUserPrefix+lowercase(email)) it is bound to the caller's user ID,
// keeping its role, scope, and creation time. Otherwise the caller gets admin
// when bootstrapAdmin is set, else the tenant's default role. The invitation
// is honored only when the email is verified (in a token, <ns>email_verified
// present and true); an unverified address proves nothing about who holds it.
// The membership is written only when none exists, so a later demotion is
// never undone by signing in again.
func (a *authenticator) provision(ctx context.Context, tenant domain.Tenant, p Principal, emailVerified, bootstrapAdmin bool) (domain.Membership, error) {
	email := normalizeEmail(p.Email)
	if email != "" && emailVerified {
		pendingID := store.PendingUserPrefix + email
		pending, err := a.ts.GetMembership(ctx, tenant.ID, pendingID)
		switch {
		case err == nil:
			bound := pending
			bound.UserID = p.UserID
			bound.Email = p.Email
			if p.Name != "" {
				bound.Name = p.Name
			}
			if err := a.ts.PutMembership(ctx, tenant.ID, bound); err != nil {
				return domain.Membership{}, fmt.Errorf("bind pending membership: %w", err)
			}
			// The binding is in place. If cleanup fails or a concurrent
			// request already removed the invitation, the request still
			// succeeds.
			if err := a.ts.DeleteMembership(ctx, tenant.ID, pendingID); err != nil && !errors.Is(err, store.ErrNotFound) {
				slog.Warn("auth: bound pending membership but could not delete it",
					"tenant", tenant.ID, "pending", pendingID, "err", err)
			}
			return bound, nil
		case !errors.Is(err, store.ErrNotFound):
			return domain.Membership{}, fmt.Errorf("look up pending membership: %w", err)
		}
	}

	// Another request may have created (or bound) this membership since our
	// first read; never overwrite it with the default role.
	switch existing, err := a.ts.GetMembership(ctx, tenant.ID, p.UserID); {
	case err == nil:
		return existing, nil
	case !errors.Is(err, store.ErrNotFound):
		return domain.Membership{}, fmt.Errorf("re-read membership: %w", err)
	}

	role := tenant.DefaultRole
	if !role.Valid() {
		role = domain.RoleViewer
	}
	if bootstrapAdmin {
		role = domain.RoleAdmin
	}
	m := domain.Membership{
		UserID:    p.UserID,
		Email:     p.Email,
		Name:      p.Name,
		Role:      role,
		CreatedAt: time.Now().UTC(),
	}
	if err := a.ts.PutMembership(ctx, tenant.ID, m); err != nil {
		return domain.Membership{}, fmt.Errorf("create membership: %w", err)
	}
	if bootstrapAdmin {
		slog.Info("auth: bootstrap admin signed in for the first time", "tenant", tenant.ID, "user", p.UserID)
	}
	return m, nil
}
