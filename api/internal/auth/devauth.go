package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
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
	now := time.Now()
	ns := cfg.claimNamespace()
	claims := map[string]any{
		"iss":        DevIssuer,
		"aud":        cfg.devAudience(),
		"sub":        userID,
		"iat":        now.Unix(),
		"exp":        now.Add(devTokenTTL).Unix(),
		ns + "email": email,
		ns + "name":  name,
	}
	if orgID != "" {
		claims["org_id"] = orgID
	}
	if operator {
		claims["permissions"] = []string{PermissionOperator}
	}
	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", fmt.Errorf("auth: encode dev token header: %w", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("auth: encode dev token claims: %w", err)
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(cfg.DevSecret))
	mac.Write([]byte(signingInput))
	return signingInput + "." + enc.EncodeToString(mac.Sum(nil)), nil
}
