package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"opsvision/internal/store"
)

// singleOrg is single-organization sign-in (Config.SingleTenantID): one
// organization runs its own instance and signs employees in through its
// existing identity provider connection. Trust comes from the token's sub
// prefix, the tenant from configuration, and the email from the token or the
// identity provider's /userinfo endpoint.
type singleOrg struct {
	tenantID string
	prefixes []string
	admins   map[string]bool
	userInfo *UserInfo
	cache    *identityCache
}

var errIdentityUnavailable = &httpError{http.StatusServiceUnavailable, "identity_unavailable", "the identity provider is temporarily unavailable"}

// newSingleOrg validates cfg's single-organization settings. It returns nil
// when the mode is off.
func newSingleOrg(cfg Config) (*singleOrg, error) {
	if cfg.SingleTenantID == "" {
		if len(cfg.TrustedSubPrefixes) > 0 || len(cfg.BootstrapAdmins) > 0 || cfg.UserInfoURL != "" {
			return nil, errors.New("auth: trusted sub prefixes, bootstrap admins and the userinfo URL need a single tenant ID")
		}
		return nil, nil
	}
	if len(cfg.TrustedSubPrefixes) == 0 {
		return nil, errors.New("auth: single-organization mode needs at least one trusted sub prefix")
	}
	for _, p := range cfg.TrustedSubPrefixes {
		// Without the separator, "oidc|corp" would also trust "oidc|corp-contractors|...".
		if len(p) < 2 || !strings.HasSuffix(p, "|") || strings.TrimSpace(p) != p {
			return nil, fmt.Errorf("auth: trusted sub prefix %q must be non-empty and end with \"|\"", p)
		}
	}
	admins := make(map[string]bool, len(cfg.BootstrapAdmins))
	for _, a := range cfg.BootstrapAdmins {
		email := normalizeEmail(a)
		if email == "" {
			return nil, errors.New("auth: bootstrap admin emails must not be empty")
		}
		admins[email] = true
	}
	endpoint := cfg.UserInfoURL
	if endpoint == "" {
		domain := strings.Trim(strings.TrimSpace(cfg.Domain), "/")
		if domain == "" {
			return nil, errors.New("auth: single-organization mode needs a domain or a userinfo URL")
		}
		endpoint = "https://" + domain + "/userinfo"
	}
	if u, err := url.Parse(endpoint); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, fmt.Errorf("auth: invalid userinfo URL %q", endpoint)
	}
	ui := NewUserInfo(endpoint, nil)
	if cfg.userInfoTimeout > 0 {
		ui.timeout = cfg.userInfoTimeout
	}
	return &singleOrg{
		tenantID: cfg.SingleTenantID,
		prefixes: append([]string(nil), cfg.TrustedSubPrefixes...),
		admins:   admins,
		userInfo: ui,
		cache:    newIdentityCache(userInfoCacheSize, cfg.now),
	}, nil
}

func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func (s *singleOrg) trusted(sub string) bool {
	for _, p := range s.prefixes {
		if strings.HasPrefix(sub, p) {
			return true
		}
	}
	return false
}

// identity is the caller's email, whether it is verified, and name: from the
// token when it has an email claim, else from /userinfo (cached by sub until
// the token expires). A name in the token wins over the /userinfo one.
func (s *singleOrg) identity(ctx context.Context, token string, v verified) (identity, error) {
	c := v.claims
	if c.Email != "" {
		return identity{email: c.Email, verified: c.EmailVerified != nil && *c.EmailVerified, name: c.Name}, nil
	}
	id, ok := s.cache.get(v.subject)
	if !ok {
		var err error
		if id, err = s.userInfo.lookup(ctx, token); err != nil {
			return identity{}, err
		}
		// OIDC requires /userinfo to name the token's own subject; anything
		// else (a misconfigured endpoint, say) says nothing about this caller.
		if id.sub != v.subject {
			return identity{}, errors.New("userinfo: response is for a different subject")
		}
		s.cache.put(v.subject, id, v.expiry)
	}
	if c.Name != "" {
		id.name = c.Name
	}
	return id, nil
}

// authenticateSingle resolves a verified token in single-organization mode.
func (a *authenticator) authenticateSingle(ctx context.Context, token string, v verified, p Principal) (Principal, *httpError) {
	s := a.single
	if !s.trusted(p.UserID) {
		slog.Debug("auth: subject not from a trusted connection")
		return Principal{}, forbidden("sign-in source is not trusted")
	}
	tenant, err := a.ts.GetTenant(ctx, s.tenantID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		slog.Error("auth: the configured tenant does not exist", "tenant", s.tenantID)
		return Principal{}, forbidden("tenant not provisioned")
	case err != nil:
		slog.Error("auth: tenant lookup failed", "tenant", s.tenantID, "err", err)
		return Principal{}, errInternal
	}
	p.Tenant = &tenant

	id, err := s.identity(ctx, token, v)
	if err != nil {
		slog.Error("auth: cannot look up the caller's email", "err", err)
		return Principal{}, errIdentityUnavailable
	}
	p.Email, p.Name = id.email, id.name
	// The trusted connection is the organization's own directory, so its
	// emails count as verified whatever email_verified says.
	return a.withMembership(ctx, p, true, s.admins[normalizeEmail(id.email)])
}
