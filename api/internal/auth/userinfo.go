package auth

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	userInfoTimeout = 5 * time.Second
	// userInfoMaxBytes bounds the /userinfo response the API will read.
	userInfoMaxBytes = 64 << 10
	// userInfoCacheSize bounds the /userinfo results kept in memory.
	userInfoCacheSize = 1000
)

// errUserInfoRefused is /userinfo answering 401 or 403 for the caller's own,
// already verified token: the token cannot read the profile (it lacks the
// openid scope, say), which retrying will not fix.
var errUserInfoRefused = errors.New("the identity provider refused the token")

// UserInfo looks up the caller's email at the identity provider's OIDC
// /userinfo endpoint, using the caller's own access token.
type UserInfo struct {
	url     string
	client  *http.Client
	timeout time.Duration
}

// NewUserInfo returns a UserInfo for the endpoint at url, using a copy of
// client (a nil client means a default one). Redirects are never followed,
// whatever the client's policy, and every request is limited to 5 seconds,
// whatever the client's own timeout.
func NewUserInfo(url string, client *http.Client) *UserInfo {
	c := http.Client{Timeout: userInfoTimeout}
	if client != nil {
		c = *client
	}
	// The request carries the caller's token; never send it on.
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &UserInfo{url: url, client: &c, timeout: userInfoTimeout}
}

// identity is what /userinfo says about the caller.
type identity struct {
	sub      string
	email    string
	verified bool
	name     string
}

// Email returns the email /userinfo reports for token's user, and whether the
// identity provider marks it verified (only a JSON true counts). Any failure
// to get a well-formed 200 response within the timeout is an error.
func (u *UserInfo) Email(ctx context.Context, token string) (email string, verified bool, err error) {
	id, err := u.lookup(ctx, token)
	if err != nil {
		return "", false, err
	}
	return id.email, id.verified, nil
}

func (u *UserInfo) lookup(ctx context.Context, token string) (identity, error) {
	ctx, cancel := context.WithTimeout(ctx, u.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.url, nil)
	if err != nil {
		return identity{}, fmt.Errorf("userinfo: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := u.client.Do(req)
	if err != nil {
		return identity{}, fmt.Errorf("userinfo: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return identity{}, fmt.Errorf("userinfo: HTTP %d: %w", resp.StatusCode, errUserInfoRefused)
	default:
		return identity{}, fmt.Errorf("userinfo: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, userInfoMaxBytes+1))
	if err != nil {
		return identity{}, fmt.Errorf("userinfo: read: %w", err)
	}
	if len(body) > userInfoMaxBytes {
		return identity{}, errors.New("userinfo: response larger than 64 KiB")
	}
	var info struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return identity{}, fmt.Errorf("userinfo: decode: %w", err)
	}
	return identity{
		sub:      info.Sub,
		email:    strings.TrimSpace(info.Email),
		verified: info.EmailVerified == true,
		name:     strings.TrimSpace(info.Name),
	}, nil
}

// identityCache holds /userinfo results by subject until the token they were
// fetched with expires. It keeps at most size entries, evicting the oldest
// first. It is safe for concurrent use.
type identityCache struct {
	mu    sync.Mutex
	size  int
	now   func() time.Time
	order *list.List // of *cachedIdentity, oldest at the front
	bySub map[string]*list.Element
}

type cachedIdentity struct {
	sub     string
	id      identity
	expires time.Time
}

func newIdentityCache(size int, now func() time.Time) *identityCache {
	if now == nil {
		now = time.Now
	}
	return &identityCache{size: size, now: now, order: list.New(), bySub: make(map[string]*list.Element)}
}

func (c *identityCache) get(sub string) (identity, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.bySub[sub]
	if !ok {
		return identity{}, false
	}
	e := el.Value.(*cachedIdentity)
	if !c.now().Before(e.expires) {
		c.remove(el)
		return identity{}, false
	}
	return e.id, true
}

// put stores id for sub until expires; a stored entry becomes the newest.
func (c *identityCache) put(sub string, id identity, expires time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.bySub[sub]; ok {
		c.remove(el)
	}
	if !c.now().Before(expires) {
		return
	}
	c.bySub[sub] = c.order.PushBack(&cachedIdentity{sub: sub, id: id, expires: expires})
	for c.order.Len() > c.size {
		c.remove(c.order.Front())
	}
}

func (c *identityCache) remove(el *list.Element) {
	delete(c.bySub, el.Value.(*cachedIdentity).sub)
	c.order.Remove(el)
}

func (c *identityCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}
