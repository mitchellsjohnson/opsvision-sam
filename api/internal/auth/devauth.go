package auth

import (
	"fmt"
	"time"

	"gopkg.in/go-jose/go-jose.v2"
	"gopkg.in/go-jose/go-jose.v2/jwt"
)

// devTokenTTL is the lifetime of tokens from IssueDevToken.
const devTokenTTL = 12 * time.Hour

// IssueDevToken mints an HS256 token for dev mode: issuer "opsvision-dev",
// audience "opsvision-dev", the default claim namespace, valid for 12 hours.
// orgID may be empty; operator adds the operate:platform permission. It
// returns an error if secret is shorter than 32 bytes.
//
// Use IssueDevTokenFor when the validating Config customizes Audience or
// ClaimNamespace.
func IssueDevToken(secret, userID, email, name, orgID string, operator bool) (string, error) {
	return IssueDevTokenFor(Config{Mode: ModeDev, DevSecret: secret}, userID, email, name, orgID, operator)
}

// IssueDevTokenFor is IssueDevToken using cfg's DevSecret, Audience (default
// "opsvision-dev") and ClaimNamespace (default "https://opsvision/").
func IssueDevTokenFor(cfg Config, userID, email, name, orgID string, operator bool) (string, error) {
	if len(cfg.DevSecret) < MinDevSecretBytes {
		return "", fmt.Errorf("auth: dev secret must be at least %d bytes", MinDevSecretBytes)
	}
	if userID == "" {
		return "", fmt.Errorf("auth: user ID is required")
	}
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.HS256, Key: []byte(cfg.DevSecret)},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		return "", fmt.Errorf("auth: dev signer: %w", err)
	}
	now := time.Now()
	std := jwt.Claims{
		Issuer:   DevIssuer,
		Audience: jwt.Audience{cfg.devAudience()},
		Subject:  userID,
		IssuedAt: jwt.NewNumericDate(now),
		Expiry:   jwt.NewNumericDate(now.Add(devTokenTTL)),
	}
	ns := cfg.claimNamespace()
	custom := map[string]any{
		ns + "email": email,
		ns + "name":  name,
	}
	if orgID != "" {
		custom["org_id"] = orgID
	}
	if operator {
		custom["permissions"] = []string{PermissionOperator}
	}
	tok, err := jwt.Signed(signer).Claims(std).Claims(custom).CompactSerialize()
	if err != nil {
		return "", fmt.Errorf("auth: sign dev token: %w", err)
	}
	return tok, nil
}
