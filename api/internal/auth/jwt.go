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

	"github.com/auth0/go-jwt-middleware/v2/jwks"
	"github.com/auth0/go-jwt-middleware/v2/validator"
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
	EmailVerified *bool // nil when the claim is absent
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

// keyError marks a failure to obtain verification keys (for example the JWKS
// endpoint being unreachable). It is not the caller's fault.
type keyError struct{ err error }

func (e *keyError) Error() string { return "verification keys unavailable: " + e.err.Error() }
func (e *keyError) Unwrap() error { return e.err }

// newValidator builds the token validator for cfg: RS256 against the issuer's
// JWKS in auth0 mode, HS256 against DevSecret in dev mode. The algorithm is
// fixed by mode; a token signed with any other algorithm is rejected.
func newValidator(cfg Config) (*validator.Validator, error) {
	ns := cfg.claimNamespace()
	custom := validator.WithCustomClaims(func() validator.CustomClaims { return &tokenClaims{ns: ns} })
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
		provider := jwks.NewCachingProvider(issuerURL, jwksCacheTTL,
			jwks.WithCustomJWKSURI(jwksURL),
			jwks.WithCustomClient(&http.Client{Timeout: jwksTimeout}),
			// Refresh in the request path so a rotated signing key is
			// picked up on the first request after the TTL.
			jwks.WithSynchronousRefresh(true),
		)
		keyFunc := func(ctx context.Context) (interface{}, error) {
			k, err := provider.KeyFunc(ctx)
			if err != nil {
				return nil, &keyError{err}
			}
			return k, nil
		}
		return validator.New(keyFunc, validator.RS256, issuer, []string{cfg.Audience}, skew, custom)

	case ModeDev:
		if len(cfg.DevSecret) < MinDevSecretBytes {
			return nil, fmt.Errorf("auth: dev secret must be at least %d bytes", MinDevSecretBytes)
		}
		secret := []byte(cfg.DevSecret)
		keyFunc := func(context.Context) (interface{}, error) { return secret, nil }
		return validator.New(keyFunc, validator.HS256, DevIssuer, []string{cfg.devAudience()}, skew, custom)
	}
	return nil, fmt.Errorf("auth: unknown mode %q (want %q or %q)", cfg.Mode, ModeAuth0, ModeDev)
}

// tokenValidator is the part of *validator.Validator the middleware uses.
type tokenValidator interface {
	ValidateToken(ctx context.Context, tokenString string) (interface{}, error)
}

// verified is the outcome of validating a token.
type verified struct {
	subject string
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
	if vc.RegisteredClaims.Expiry == 0 {
		return verified{}, fmt.Errorf("%w: no exp claim", errInvalidToken)
	}
	if vc.RegisteredClaims.Subject == "" {
		return verified{}, fmt.Errorf("%w: no sub claim", errInvalidToken)
	}
	return verified{subject: vc.RegisteredClaims.Subject, claims: tc}, nil
}
