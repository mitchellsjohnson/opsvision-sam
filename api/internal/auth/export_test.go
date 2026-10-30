package auth

import "time"

// SetClock overrides the JWKS cache clock for tests.
func (c *Config) SetClock(now func() time.Time) { c.now = now }
