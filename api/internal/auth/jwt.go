package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/auth0/go-jwt-middleware/v3/core"
	"github.com/auth0/go-jwt-middleware/v3/jwks"
	"github.com/auth0/go-jwt-middleware/v3/validator"

	"opsvision/internal/store"
)

// Auth modes.
const (
	// ModeAuth0 validates RS256 access tokens issued by Auth0.
	ModeAuth0 = "auth0"
	// ModeDev validates HS256 tokens signed with a shared secret. For local
	// development only: anyone holding DevSecret can mint any identity.
	ModeDev = "dev"
)

// Defaults and fixed parameters.
const (
	// DefaultClaimNamespace prefixes the custom email and name claims.
	DefaultClaimNamespace = "https://opsvision/"
	// DevIssuer is the iss of dev tokens.
	DevIssuer = "opsvision-dev"
	// DevAudience is the default aud of dev tokens.
	DevAudience = "opsvision-dev"
	// MinDevSecretBytes is the minimum length of Config.DevSecret.
	MinDevSecretBytes = 32
	// PermissionOperator marks a platform operator.
	PermissionOperator = "operate:platform"

	clockSkew    = 60 * time.Second
	jwksCacheTTL = 5 * time.Minute
	jwksTimeout  = 10 * time.Second
)

// Config configures token validation.
type Config struct {
	// Mode is ModeAuth0 ("auth0") or ModeDev ("dev").
	Mode string
	// Domain is the Auth0 tenant domain (for example example.us.auth0.com).
	// It determines the issuer, https://<Domain>/, unless IssuerURL is set.
	Domain string
	// Audience is the expected aud. Required in auth0 mode; defaults to
	// "opsvision-dev" in dev mode.
	Audience string
	// ClaimNamespace prefixes the email and name claims. Defaults to
	// "https://opsvision/".
	ClaimNamespace string
	// DevSecret signs and verifies dev-mode tokens (at least 32 bytes).
	DevSecret string
	// IssuerURL overrides the expected issuer and JWKS location in auth0
	// mode (default https://<Domain>/). A trailing slash is added if missing.
	// It exists so tests can point at an httptest JWKS server.
	IssuerURL string

	// SingleTenantID enables single-organization sign-in: every caller whose
	// sub starts with one of TrustedSubPrefixes belongs to this tenant, and
	// org_id is ignored. Empty keeps the multi-tenant model.
	SingleTenantID string
	// TrustedSubPrefixes are the sub prefixes admitted in single-organization
	// mode, each ending in "|" (for example "oidc|corp-employees|").
	// Required with SingleTenantID.
	TrustedSubPrefixes []string
	// BootstrapAdmins are emails that become admins on their first sign-in in
	// single-organization mode. Compared case-insensitively. A demotion is
	// kept, but a deleted membership is re-created as admin; revoke one by
	// removing the email from this list.
	BootstrapAdmins []string
	// UserInfoURL is the identity provider's OIDC /userinfo endpoint, used in
	// single-organization mode to provision a first sign-in whose token has no
	// email claim. Defaults to https://<Domain>/userinfo.
	UserInfoURL string

	// now overrides the clock of the JWKS and /userinfo caches; tests only.
	now func() time.Time
	// userInfoTimeout overrides the /userinfo timeout; tests only.
	userInfoTimeout time.Duration
}

func (c Config) claimNamespace() string {
	if c.ClaimNamespace == "" {
		return DefaultClaimNamespace
	}
	return c.ClaimNamespace
}

func (c Config) devAudience() string {
	if c.Audience == "" {
		return DevAudience
	}
	return c.Audience
}

func (c Config) issuerURL() string {
	u := strings.TrimSpace(c.IssuerURL)
	if u == "" {
		u = "https://" + strings.Trim(strings.TrimSpace(c.Domain), "/")
	}
	if !strings.HasSuffix(u, "/") {
		u += "/"
	}
	return u
}

// tokenClaims are the custom claims OpsVision reads from a validated token.
type tokenClaims struct {
	ns            string
	OrgID         string
	Permissions   []string
	Email         string
	Name          string
	EmailVerified *bool // nil when the claim is absent; only true allows invitation binding
}

// Validate implements validator.CustomClaims. All checks are done by the
// validator or the middleware; there is nothing further to verify here.
func (c *tokenClaims) Validate(context.Context) error { return nil }

// UnmarshalJSON extracts the claims whose names depend on the namespace.
func (c *tokenClaims) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	str := func(key string, dst *string) error {
		v, ok := raw[key]
		if !ok {
			return nil
		}
		if err := json.Unmarshal(v, dst); err != nil {
			return fmt.Errorf("claim %q: %w", key, err)
		}
		return nil
	}
	if err := str("org_id", &c.OrgID); err != nil {
		return err
	}
	if err := str(c.ns+"email", &c.Email); err != nil {
		return err
	}
	if err := str(c.ns+"name", &c.Name); err != nil {
		return err
	}
	if v, ok := raw["permissions"]; ok {
		if err := json.Unmarshal(v, &c.Permissions); err != nil {
			return fmt.Errorf("claim \"permissions\": %w", err)
		}
	}
	if v, ok := raw[c.ns+"email_verified"]; ok {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			return fmt.Errorf("claim %q: %w", c.ns+"email_verified", err)
		}
		c.EmailVerified = &b
	}
	return nil
}

func (c *tokenClaims) isOperator() bool {
	for _, p := range c.Permissions {
		if p == PermissionOperator {
			return true
		}
	}
	return false
}

// isKeyFetchError reports whether err means verification keys could not be
// obtained (for example the JWKS endpoint being unreachable). That is not the
// caller's fault.
func isKeyFetchError(err error) bool {
	var ve *core.ValidationError
	return errors.As(err, &ve) && ve.Code == core.ErrorCodeJWKSFetchFailed
}

// newValidator builds the token validator for cfg: RS256 against the issuer's
// JWKS in auth0 mode, HS256 against DevSecret in dev mode. The algorithm is
// fixed by mode; a token signed with any other algorithm is rejected.
func newValidator(cfg Config) (*validator.Validator, error) {
	ns := cfg.claimNamespace()
	custom := validator.WithCustomClaims(func() *tokenClaims { return &tokenClaims{ns: ns} })
	skew := validator.WithAllowedClockSkew(clockSkew)

	switch cfg.Mode {
	case ModeAuth0:
		if cfg.Audience == "" {
			return nil, errors.New("auth: audience is required in auth0 mode")
		}
		if cfg.IssuerURL == "" && strings.TrimSpace(cfg.Domain) == "" {
			return nil, errors.New("auth: domain (or issuer URL) is required in auth0 mode")
		}
		issuer := cfg.issuerURL()
		issuerURL, err := url.Parse(issuer)
		if err != nil || issuerURL.Host == "" {
			return nil, fmt.Errorf("auth: invalid issuer URL %q", issuer)
		}
		jwksURL, err := url.Parse(issuer + ".well-known/jwks.json")
		if err != nil {
			return nil, fmt.Errorf("auth: invalid JWKS URL: %w", err)
		}
		// The library's non-caching provider fetches; our fixed-TTL cache
		// bounds key lifetime (the library's own cache would extend it to
		// whatever Cache-Control max-age the JWKS endpoint sends).
		fetcher, err := jwks.NewProvider(
			jwks.WithIssuerURL(issuerURL),
			jwks.WithCustomJWKSURI(jwksURL),
			jwks.WithCustomClient(&http.Client{Timeout: jwksTimeout}),
		)
		if err != nil {
			return nil, fmt.Errorf("auth: JWKS provider: %w", err)
		}
		provider, err := jwks.NewCachingProvider(
			jwks.WithIssuerURL(issuerURL),
			jwks.WithCustomJWKSURI(jwksURL),
			jwks.WithCache(newFixedTTLCache(fetcher.KeyFunc, jwksCacheTTL, cfg.now)),
		)
		if err != nil {
			return nil, fmt.Errorf("auth: JWKS provider: %w", err)
		}
		return validator.New(
			validator.WithKeyFunc(provider.KeyFunc),
			validator.WithAlgorithm(validator.RS256),
			validator.WithIssuer(issuer),
			validator.WithAudience(cfg.Audience),
			skew, custom,
		)

	case ModeDev:
		if len(cfg.DevSecret) < MinDevSecretBytes {
			return nil, fmt.Errorf("auth: dev secret must be at least %d bytes", MinDevSecretBytes)
		}
		secret := []byte(cfg.DevSecret)
		return validator.New(
			validator.WithKeyFunc(func(context.Context) (any, error) { return secret, nil }),
			validator.WithAlgorithm(validator.HS256),
			validator.WithIssuer(DevIssuer),
			validator.WithAudience(cfg.devAudience()),
			skew, custom,
		)
	}
	return nil, fmt.Errorf("auth: unknown mode %q (want %q or %q)", cfg.Mode, ModeAuth0, ModeDev)
}

// tokenValidator is the part of *validator.Validator the middleware uses.
type tokenValidator interface {
	ValidateToken(ctx context.Context, tokenString string) (any, error)
}

// verified is the outcome of validating a token.
type verified struct {
	subject string
	expiry  time.Time
	claims  *tokenClaims
}

var errInvalidToken = errors.New("invalid token")

// verify validates tokenString and returns its identity. Beyond the
// validator's checks (signature, algorithm, issuer, audience, exp/nbf with
// leeway) it requires an expiry and a subject, which the validator treats as
// optional.
func verify(ctx context.Context, v tokenValidator, tokenString string) (verified, error) {
	out, err := v.ValidateToken(ctx, tokenString)
	if err != nil {
		return verified{}, err
	}
	vc, ok := out.(*validator.ValidatedClaims)
	if !ok {
		return verified{}, errInvalidToken
	}
	tc, ok := vc.CustomClaims.(*tokenClaims)
	if !ok || tc == nil {
		return verified{}, errInvalidToken
	}
	// A DPoP-bound token (cnf claim) is only safe when its proof is checked.
	// This API does not verify proofs, so it must not accept such a token as
	// a plain bearer token.
	if vc.ConfirmationClaim != nil {
		return verified{}, fmt.Errorf("%w: sender-constrained token", errInvalidToken)
	}
	if vc.RegisteredClaims.Expiry == 0 {
		return verified{}, fmt.Errorf("%w: no exp claim", errInvalidToken)
	}
	if vc.RegisteredClaims.Subject == "" {
		return verified{}, fmt.Errorf("%w: no sub claim", errInvalidToken)
	}
	// Membership IDs with this prefix are invitations awaiting a sign-in. A
	// token must never be able to name one as its own identity.
	if strings.HasPrefix(vc.RegisteredClaims.Subject, store.PendingUserPrefix) {
		return verified{}, fmt.Errorf("%w: reserved sub prefix", errInvalidToken)
	}
	return verified{
		subject: vc.RegisteredClaims.Subject,
		expiry:  time.Unix(vc.RegisteredClaims.Expiry, 0),
		claims:  tc,
	}, nil
}
