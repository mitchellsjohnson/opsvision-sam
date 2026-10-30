package auth

import (
	"context"
	"sync"
	"time"

	"github.com/auth0/go-jwt-middleware/v3/jwks"
)

// failureBackoff is how long a failed JWKS fetch is remembered, so an outage
// does not make every request wait out a fetch timeout in turn.
const failureBackoff = 5 * time.Second

// fixedTTLCache is a jwks.Cache whose entries live exactly ttl, whatever
// Cache-Control the JWKS endpoint sends. Bounding the lifetime bounds how long
// a withdrawn signing key keeps validating tokens. Past the TTL the keys are
// refetched; if that fails the request fails (no stale keys are served).
type fixedTTLCache struct {
	fetch func(ctx context.Context) (any, error)
	ttl   time.Duration
	now   func() time.Time

	mu        sync.Mutex
	keys      map[string]cachedKeys
	failedAt  map[string]time.Time
	failedErr map[string]error
}

type cachedKeys struct {
	set       jwks.KeySet
	expiresAt time.Time
}

func newFixedTTLCache(fetch func(ctx context.Context) (any, error), ttl time.Duration, now func() time.Time) *fixedTTLCache {
	if now == nil {
		now = time.Now
	}
	return &fixedTTLCache{
		fetch:     fetch,
		ttl:       ttl,
		now:       now,
		keys:      map[string]cachedKeys{},
		failedAt:  map[string]time.Time{},
		failedErr: map[string]error{},
	}
}

// Get implements jwks.Cache. The fetch is serialized, so concurrent callers
// after an expiry share one refetch.
func (c *fixedTTLCache) Get(ctx context.Context, jwksURI string) (jwks.KeySet, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	if k, ok := c.keys[jwksURI]; ok && now.Before(k.expiresAt) {
		return k.set, nil
	}
	if at, ok := c.failedAt[jwksURI]; ok && now.Sub(at) < failureBackoff {
		return nil, c.failedErr[jwksURI]
	}
	set, err := c.fetch(ctx)
	if err != nil {
		delete(c.keys, jwksURI)
		c.failedAt[jwksURI] = now
		c.failedErr[jwksURI] = err
		return nil, err
	}
	delete(c.failedAt, jwksURI)
	delete(c.failedErr, jwksURI)
	c.keys[jwksURI] = cachedKeys{set: set, expiresAt: now.Add(c.ttl)}
	return set, nil
}
