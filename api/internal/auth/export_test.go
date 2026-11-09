package auth

import "time"

// SetClock overrides the JWKS cache clock for tests.
func (c *Config) SetClock(now func() time.Time) { c.now = now }

// SetUserInfoTimeout overrides the /userinfo timeout for tests.
func (c *Config) SetUserInfoTimeout(d time.Duration) { c.userInfoTimeout = d }

// Timeout reports the /userinfo request timeout.
func (u *UserInfo) Timeout() time.Duration { return u.timeout }

// SetTimeout overrides the /userinfo request timeout for tests.
func (u *UserInfo) SetTimeout(d time.Duration) { u.timeout = d }

// UserInfoCacheSize is the most /userinfo results the middleware keeps.
const UserInfoCacheSize = userInfoCacheSize

// EmailCache exposes the /userinfo result cache to tests.
type EmailCache struct{ c *identityCache }

func NewEmailCache(size int, now func() time.Time) EmailCache {
	return EmailCache{newIdentityCache(size, now)}
}

func (e EmailCache) Put(sub, email string, expires time.Time) {
	e.c.put(sub, identity{email: email}, expires)
}

func (e EmailCache) Get(sub string) (string, bool) {
	id, ok := e.c.get(sub)
	return id.email, ok
}

func (e EmailCache) Len() int { return e.c.len() }
