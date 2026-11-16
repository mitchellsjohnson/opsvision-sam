package domain

import "time"

// AccessToken is a personal access token: a bearer credential for one user in
// one tenant. Only the SHA-256 Hash of the secret is stored; the secret is
// shown once, at creation. Prefix is the start of the secret, kept so people
// can tell their tokens apart. LastUsedAt is nil until the token is first
// used.
type AccessToken struct {
	ID         string
	TenantID   string
	UserID     string
	Name       string
	Prefix     string
	Hash       [32]byte
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastUsedAt *time.Time
}
