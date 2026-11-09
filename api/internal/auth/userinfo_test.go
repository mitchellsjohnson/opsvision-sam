package auth_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
)

func TestUserInfoCachedUntilExp(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	ts := newStore(t)
	start := time.Now()
	clock := start
	cfg := singleOrgConfig(f, u)
	cfg.SetClock(func() time.Time { return clock })
	mw, err := auth.Middleware(cfg, ts)
	if err != nil {
		t.Fatal(err)
	}
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	call := func(label, tok string, wantHits int32) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/x", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", label, rec.Code, rec.Body.String())
		}
		if n := u.hits.Load(); n != wantHits {
			t.Fatalf("%s: /userinfo called %d times, want %d", label, n, wantHits)
		}
	}

	first := f.token(t, tokOpts{subject: employeeSub, expiry: time.Hour})
	for i := 0; i < 3; i++ {
		call("repeat", first, 1)
	}
	clock = start.Add(59 * time.Minute)
	call("before exp", first, 1)

	// Another user is looked up separately.
	call("other user", f.token(t, tokOpts{subject: trustedPrefix + "u-200"}), 2)

	// Past the first token's exp the entry is gone, even for a newer token.
	clock = start.Add(time.Hour + time.Second)
	later := f.token(t, tokOpts{subject: employeeSub, expiry: 2 * time.Hour})
	call("after exp", later, 3)
	call("cached again", later, 3)
}

func TestUserInfoFailureIsNotCached(t *testing.T) {
	f := newRSAFixture(t, "kid-1")
	u := newUserInfoFixture(t, verifiedEmail("pat@example.test"))
	u.status.Store(http.StatusBadGateway)
	cfg := singleOrgConfig(f, u)
	ts := newStore(t)
	mw, err := auth.Middleware(cfg, ts)
	if err != nil {
		t.Fatal(err)
	}
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	tok := employeeToken(t, f, nil)
	do := func() int {
		req := httptest.NewRequest(http.MethodGet, "/v1/x", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := do(); c != http.StatusServiceUnavailable {
		t.Fatalf("status %d during the outage, want 503", c)
	}
	u.status.Store(0)
	if c := do(); c != http.StatusOK {
		t.Fatalf("status %d after recovery, want 200", c)
	}
}

// slowServer answers only after the client has given up (or after a second).
func slowServer(t *testing.T) *httptest.Server {
	t.Helper()
	done := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-done:
		case <-time.After(time.Second):
		}
		_, _ = w.Write([]byte(`{"email":"late@example.test","email_verified":true}`))
	}))
	t.Cleanup(func() { close(done); s.Close() })
	return s
}

func TestUserInfoTimeoutFailsClosed(t *testing.T) {
	if got := auth.NewUserInfo("https://example.us.auth0.com/userinfo", nil).Timeout(); got != 5*time.Second {
		t.Errorf("default timeout = %v, want 5s", got)
	}

	// The timeout applies even when the supplied client has none.
	s := slowServer(t)
	ui := auth.NewUserInfo(s.URL, &http.Client{})
	ui.SetTimeout(50 * time.Millisecond)
	began := time.Now()
	email, verified, err := ui.Email(context.Background(), "tok")
	if err == nil || email != "" || verified {
		t.Fatalf("Email = %q, %v, %v; want a timeout error", email, verified, err)
	}
	if d := time.Since(began); d > 900*time.Millisecond {
		t.Errorf("Email took %v, want it to give up at the timeout", d)
	}

	// Through the middleware: 503 and no membership.
	f := newRSAFixture(t, "kid-1")
	cfg := auth0Config(f)
	cfg.SingleTenantID, cfg.TrustedSubPrefixes, cfg.UserInfoURL = "t1", []string{trustedPrefix}, s.URL
	cfg.SetUserInfoTimeout(50 * time.Millisecond)
	ts := newStore(t)
	rec, p := run(t, cfg, ts, employeeToken(t, f, nil))
	wantError(t, rec, http.StatusServiceUnavailable, "identity_unavailable", "")
	if p != nil {
		t.Error("handler reached")
	}
	if ms, _ := ts.ListMemberships(context.Background(), "t1"); len(ms) != 0 {
		t.Errorf("memberships = %+v, want none", ms)
	}
}

func TestUserInfoEmail(t *testing.T) {
	var gotAuth, gotAccept string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotAccept = r.Header.Get("Authorization"), r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"x","email":" Pat@Example.test ","email_verified":true,"extra":{"a":1}}`))
	}))
	t.Cleanup(s.Close)
	email, verified, err := auth.NewUserInfo(s.URL, nil).Email(context.Background(), "tok-123")
	if err != nil || email != "Pat@Example.test" || !verified {
		t.Fatalf("Email = %q, %v, %v", email, verified, err)
	}
	if gotAuth != "Bearer tok-123" || !strings.Contains(gotAccept, "application/json") {
		t.Errorf("Authorization = %q, Accept = %q", gotAuth, gotAccept)
	}
}

func TestUserInfoEmailVerifiedOnlyWhenTrue(t *testing.T) {
	for _, v := range []string{`false`, `"true"`, `1`, `null`} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = fmt.Fprintf(w, `{"email":"pat@example.test","email_verified":%s}`, v)
		}))
		_, verified, err := auth.NewUserInfo(s.URL, nil).Email(context.Background(), "tok")
		s.Close()
		if err != nil || verified {
			t.Errorf("email_verified %s: verified = %v, err = %v; want unverified, no error", v, verified, err)
		}
	}
}

func TestUserInfoRejectsBadResponses(t *testing.T) {
	big := `{"email":"pat@example.test","pad":"` + strings.Repeat("x", 64<<10) + `"}`
	cases := map[string]http.HandlerFunc{
		"non-200": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusUnauthorized) },
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://elsewhere.example.test/userinfo", http.StatusFound)
		},
		"not JSON":     func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>")) },
		"over 64 KiB":  func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(big)) },
		"email number": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"email":42}`)) },
	}
	for name, h := range cases {
		s := httptest.NewServer(h)
		email, verified, err := auth.NewUserInfo(s.URL, nil).Email(context.Background(), "tok")
		s.Close()
		if err == nil || email != "" || verified {
			t.Errorf("%s: Email = %q, %v, %v; want an error", name, email, verified, err)
		}
	}
}

func TestUserInfoNeverFollowsRedirects(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHits.Add(1)
		_, _ = w.Write([]byte(`{"email":"pat@example.test"}`))
	}))
	t.Cleanup(target.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	follows := func(*http.Request, []*http.Request) error { return nil }
	clients := map[string]*http.Client{
		"nil client":                 nil,
		"client without a policy":    {},
		"client that would redirect": {CheckRedirect: follows},
	}
	for name, client := range clients {
		email, _, err := auth.NewUserInfo(redirector.URL, client).Email(context.Background(), "tok")
		if err == nil || email != "" {
			t.Errorf("%s: Email = %q, %v; want an error for the redirect", name, email, err)
		}
	}
	if n := targetHits.Load(); n != 0 {
		t.Errorf("redirect target received %d requests carrying the token, want 0", n)
	}
	// The caller's client is not modified.
	if clients["client without a policy"].CheckRedirect != nil {
		t.Error("NewUserInfo changed the caller's client")
	}
}

func TestUserInfoAcceptsResponseAtLimit(t *testing.T) {
	head, tail := `{"email":"pat@example.test","pad":"`, `"}`
	body := head + strings.Repeat("x", 64<<10-len(head)-len(tail)) + tail
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
	t.Cleanup(s.Close)
	if email, _, err := auth.NewUserInfo(s.URL, nil).Email(context.Background(), "tok"); err != nil || email != "pat@example.test" {
		t.Fatalf("64 KiB response: %q, %v", email, err)
	}
}

func TestUserInfoCacheBoundedOldestEvicted(t *testing.T) {
	if auth.UserInfoCacheSize != 1000 {
		t.Errorf("cache size = %d, want 1000", auth.UserInfoCacheSize)
	}
	now := time.Now()
	c := auth.NewEmailCache(3, func() time.Time { return now })
	exp := now.Add(time.Hour)
	for _, sub := range []string{"a", "b", "c"} {
		c.Put(sub, sub+"@example.test", exp)
	}
	c.Put("a", "a2@example.test", exp) // a refreshed entry counts as the newest
	c.Put("d", "d@example.test", exp)
	if c.Len() != 3 {
		t.Fatalf("Len = %d, want 3", c.Len())
	}
	if _, ok := c.Get("b"); ok {
		t.Error("b, the oldest entry, was not evicted")
	}
	for sub, want := range map[string]string{"a": "a2@example.test", "c": "c@example.test", "d": "d@example.test"} {
		if got, ok := c.Get(sub); !ok || got != want {
			t.Errorf("Get(%q) = %q, %v; want %q", sub, got, ok, want)
		}
	}

	// An entry already past its expiry is not stored; an expired one is dropped.
	c.Put("e", "e@example.test", now.Add(-time.Second))
	if _, ok := c.Get("e"); ok {
		t.Error("stored an already-expired entry")
	}
	now = exp
	if _, ok := c.Get("a"); ok || c.Len() != 2 {
		t.Errorf("expired entry served or kept: Len = %d", c.Len())
	}
}

func TestUserInfoCacheConcurrent(t *testing.T) {
	c := auth.NewEmailCache(50, time.Now)
	exp := time.Now().Add(time.Hour)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				sub := fmt.Sprintf("s%d", (g*500+i)%120)
				c.Put(sub, sub, exp)
				c.Get(sub)
			}
		}()
	}
	wg.Wait()
	if c.Len() > 50 {
		t.Errorf("Len = %d, want at most 50", c.Len())
	}
}
