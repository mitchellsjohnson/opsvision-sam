package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
)

type accessTokenJSON struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	Token      string     `json:"token"`
}

type tokenListJSON struct {
	Tokens []accessTokenJSON `json:"tokens"`
}

const day = 24 * time.Hour

// createToken creates an access token as the caller and returns it.
func (e *testEnv) createToken(t *testing.T, caller, name string) accessTokenJSON {
	t.Helper()
	var out accessTokenJSON
	e.expect(t, 201, caller, "POST", "/me/tokens", map[string]any{"name": name}, &out)
	return out
}

func TestCreateTokenReturnsSecretOnce(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]

	var created accessTokenJSON
	e.expect(t, 201, viewer, "POST", "/me/tokens", map[string]any{"name": "Laptop", "expiresInDays": 30}, &created)
	if !strings.HasPrefix(created.Token, "ovs_pat_") || len(created.Token) != 8+43 {
		t.Fatalf("token = %q", created.Token)
	}
	if created.ID == "" || created.Name != "Laptop" || created.Prefix != created.Token[:12] {
		t.Fatalf("created = %+v", created)
	}
	if !created.CreatedAt.Equal(testNow) || !created.ExpiresAt.Equal(testNow.Add(30*day)) || created.LastUsedAt != nil {
		t.Fatalf("times = %v %v %v", created.CreatedAt, created.ExpiresAt, created.LastUsedAt)
	}

	stored, err := e.store.TokenByHash(context.Background(), sha256.Sum256([]byte(created.Token)))
	if err != nil {
		t.Fatalf("token not stored by hash: %v", err)
	}
	if stored.TenantID != "t1" || stored.UserID != "u-t1-viewer" || stored.ID != created.ID {
		t.Fatalf("stored = %+v", stored)
	}

	status, raw := e.call(t, viewer, "GET", "/me/tokens", nil)
	if status != 200 {
		t.Fatalf("list: status %d %s", status, raw)
	}
	if strings.Contains(string(raw), created.Token) || strings.Contains(string(raw), created.Token[12:]) {
		t.Fatal("list response contains the secret")
	}
	var generic struct {
		Tokens []map[string]any `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	if len(generic.Tokens) != 1 {
		t.Fatalf("list = %s", raw)
	}
	for _, k := range []string{"token", "hash"} {
		if _, ok := generic.Tokens[0][k]; ok {
			t.Fatalf("list item has %q: %s", k, raw)
		}
	}
	var list tokenListJSON
	e.expect(t, 200, viewer, "GET", "/me/tokens", nil, &list)
	got := list.Tokens[0]
	if got.ID != created.ID || got.Name != "Laptop" || got.Prefix != created.Prefix || !got.ExpiresAt.Equal(created.ExpiresAt) {
		t.Fatalf("listed = %+v", got)
	}
}

func TestTokenLifetimeBounds(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]
	for _, days := range []int{0, -1, 366} {
		e.expectError(t, 400, "invalid", viewer, "POST", "/me/tokens", map[string]any{"name": "x", "expiresInDays": days})
	}
	for _, body := range []any{
		map[string]any{"name": ""},
		map[string]any{"name": "   "},
		map[string]any{"name": strings.Repeat("n", 101)},
		map[string]any{},
		"{",
	} {
		e.expectError(t, 400, "invalid", viewer, "POST", "/me/tokens", body)
	}
	var list tokenListJSON
	e.expect(t, 200, viewer, "GET", "/me/tokens", nil, &list)
	if len(list.Tokens) != 0 {
		t.Fatalf("rejected creates stored tokens: %+v", list.Tokens)
	}

	def := e.createToken(t, viewer, "Default")
	if !def.ExpiresAt.Equal(testNow.Add(90 * day)) {
		t.Fatalf("default expiresAt = %v, want 90 days", def.ExpiresAt)
	}
	for _, days := range []int{1, 365} {
		var out accessTokenJSON
		e.expect(t, 201, viewer, "POST", "/me/tokens", map[string]any{"name": "Edge", "expiresInDays": days}, &out)
		if !out.ExpiresAt.Equal(testNow.Add(time.Duration(days) * day)) {
			t.Fatalf("%d days: expiresAt = %v", days, out.ExpiresAt)
		}
	}
	var trimmed accessTokenJSON
	e.expect(t, 201, viewer, "POST", "/me/tokens", map[string]any{"name": "  CI runner  "}, &trimmed)
	if trimmed.Name != "CI runner" {
		t.Fatalf("name = %q, want trimmed", trimmed.Name)
	}
}

func TestTokenLimit(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]
	// An expired token does not count toward the limit.
	if err := e.store.PutToken(context.Background(), domain.AccessToken{
		ID: "old", TenantID: "t1", UserID: "u-t1-viewer", Name: "Old", Prefix: "ovs_pat_old0",
		Hash: sha256.Sum256([]byte("old")), CreatedAt: testNow.Add(-100 * day), ExpiresAt: testNow,
	}); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := range 10 {
		ids = append(ids, e.createToken(t, viewer, fmt.Sprintf("Token %d", i)).ID)
	}
	e.expectError(t, 409, "conflict", viewer, "POST", "/me/tokens", map[string]any{"name": "Eleventh"})
	// The limit is per user.
	e.createToken(t, e.tokens["t1-admin"], "Admin token")

	e.expect(t, 204, viewer, "DELETE", "/me/tokens/"+ids[0], nil, nil)
	e.createToken(t, viewer, "Replacement")
	e.expectError(t, 409, "conflict", viewer, "POST", "/me/tokens", map[string]any{"name": "Twelfth"})
}

func TestDeleteTokenOtherUser404(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]
	tok := e.createToken(t, viewer, "Mine")

	e.expectError(t, 404, "not_found", e.tokens["t1-admin"], "DELETE", "/me/tokens/"+tok.ID, nil)
	e.expectError(t, 404, "not_found", e.tokens["t2-viewer"], "DELETE", "/me/tokens/"+tok.ID, nil)
	var list tokenListJSON
	e.expect(t, 200, e.tokens["t1-admin"], "GET", "/me/tokens", nil, &list)
	if len(list.Tokens) != 0 {
		t.Fatalf("another user lists %+v", list.Tokens)
	}
	e.expect(t, 200, viewer, "GET", "/me/tokens", nil, &list)
	if len(list.Tokens) != 1 {
		t.Fatalf("owner lists %d tokens, want 1", len(list.Tokens))
	}

	e.expect(t, 204, viewer, "DELETE", "/me/tokens/"+tok.ID, nil, nil)
	e.expectError(t, 404, "not_found", viewer, "DELETE", "/me/tokens/"+tok.ID, nil)
	e.expectError(t, 404, "not_found", viewer, "DELETE", "/me/tokens/missing", nil)
}

func TestTokenAudited(t *testing.T) {
	e := newTestEnv(t)
	viewer := e.tokens["t1-viewer"]
	a := e.createToken(t, viewer, "A")
	b := e.createToken(t, viewer, "B")
	e.expect(t, 204, viewer, "DELETE", "/me/tokens/"+a.ID, nil, nil)
	// A token-authenticated write is audited on the token channel.
	e.expect(t, 204, b.Token, "DELETE", "/me/tokens/"+b.ID, nil, nil)

	var entries []domain.AuditEntry
	for _, en := range e.audits(t, "t1") {
		if en.TargetType == "access_token" {
			entries = append(entries, en)
		}
	}
	if len(entries) != 4 {
		t.Fatalf("access_token audit entries = %d, want 4: %+v", len(entries), entries)
	}
	want := []struct{ action, target, channel string }{
		{"access_token.create", a.ID, "ui"},
		{"access_token.create", b.ID, "ui"},
		{"access_token.delete", a.ID, "ui"},
		{"access_token.delete", b.ID, "token"},
	}
	for i, w := range want {
		en := entries[i]
		if en.Action != w.action || en.TargetID != w.target || en.Channel != w.channel || en.ActorID != "u-t1-viewer" {
			t.Errorf("entry %d = %s %s %s by %s, want %s %s %s", i, en.Action, en.TargetID, en.Channel, en.ActorID, w.action, w.target, w.channel)
		}
	}
	for i, en := range entries {
		for _, raw := range []json.RawMessage{en.Before, en.After} {
			s := string(raw)
			if strings.Contains(s, a.Token[8:]) || strings.Contains(s, b.Token[8:]) {
				t.Fatalf("entry %d contains a secret: %s", i, s)
			}
			if len(raw) == 0 {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			for _, k := range []string{"token", "hash"} {
				if _, ok := m[k]; ok {
					t.Fatalf("entry %d has %q: %s", i, k, s)
				}
			}
		}
	}
	if len(entries[0].Before) != 0 || len(entries[0].After) == 0 {
		t.Fatalf("create entry before/after = %s / %s", entries[0].Before, entries[0].After)
	}
	if len(entries[2].Before) == 0 || len(entries[2].After) != 0 {
		t.Fatalf("delete entry before/after = %s / %s", entries[2].Before, entries[2].After)
	}
	var after accessTokenJSON
	if err := json.Unmarshal(entries[0].After, &after); err != nil || after.ID != a.ID || after.Name != "A" || after.Prefix != a.Prefix {
		t.Fatalf("create after = %s (%v)", entries[0].After, err)
	}
}

func TestTokenAuthenticatesAPI(t *testing.T) {
	e := newTestEnv(t)
	tok := e.createToken(t, e.tokens["t1-contributor"], "Script")

	var me struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	e.expect(t, 200, tok.Token, "GET", "/me", nil, &me)
	if me.UserID != "u-t1-contributor" || me.Role != "contributor" {
		t.Fatalf("me = %+v", me)
	}
	// The role is read on each request.
	e.expectError(t, 403, "forbidden", tok.Token, "GET", "/members", nil)
	m, err := e.store.GetMembership(context.Background(), "t1", "u-t1-contributor")
	if err != nil {
		t.Fatal(err)
	}
	m.Role = domain.RoleAdmin
	if err := e.store.PutMembership(context.Background(), "t1", m); err != nil {
		t.Fatal(err)
	}
	e.expect(t, 200, tok.Token, "GET", "/members", nil, nil)

	var list tokenListJSON
	e.expect(t, 200, tok.Token, "GET", "/me/tokens", nil, &list)
	if len(list.Tokens) != 1 || list.Tokens[0].LastUsedAt == nil || !list.Tokens[0].LastUsedAt.Equal(testNow) {
		t.Fatalf("lastUsedAt after use = %+v", list.Tokens)
	}
}

func TestTokenStopsWorking(t *testing.T) {
	ctx := context.Background()
	t.Run("revoked", func(t *testing.T) {
		e := newTestEnv(t)
		tok := e.createToken(t, e.tokens["t1-viewer"], "Revoke me")
		e.expect(t, 200, tok.Token, "GET", "/me", nil, nil)
		e.expect(t, 204, e.tokens["t1-viewer"], "DELETE", "/me/tokens/"+tok.ID, nil, nil)
		e.expectError(t, 401, "unauthorized", tok.Token, "GET", "/me", nil)
	})
	t.Run("expired", func(t *testing.T) {
		e := newTestEnv(t)
		tok := e.createToken(t, e.tokens["t1-viewer"], "Expire me")
		stored, err := e.store.TokenByHash(ctx, sha256.Sum256([]byte(tok.Token)))
		if err != nil {
			t.Fatal(err)
		}
		stored.ExpiresAt = testNow
		if err := e.store.PutToken(ctx, stored); err != nil {
			t.Fatal(err)
		}
		e.expectError(t, 401, "unauthorized", tok.Token, "GET", "/me", nil)
	})
	t.Run("member removed", func(t *testing.T) {
		e := newTestEnv(t)
		tok := e.createToken(t, e.tokens["t1-viewer"], "Remove me")
		if err := e.store.DeleteMembership(ctx, "t1", "u-t1-viewer"); err != nil {
			t.Fatal(err)
		}
		e.expectError(t, 403, "forbidden", tok.Token, "GET", "/me", nil)
	})
}

func TestTokenCannotCreateToken(t *testing.T) {
	e := newTestEnv(t)
	tok := e.createToken(t, e.tokens["t1-viewer"], "Script")
	e.expectError(t, 403, "forbidden", tok.Token, "POST", "/me/tokens", map[string]any{"name": "Child"})
	var list tokenListJSON
	e.expect(t, 200, tok.Token, "GET", "/me/tokens", nil, &list)
	if len(list.Tokens) != 1 {
		t.Fatalf("tokens = %d, want 1", len(list.Tokens))
	}
}

func TestTokensRequireMembership(t *testing.T) {
	e := newTestEnv(t)
	e.expectError(t, 401, "unauthorized", "", "GET", "/me/tokens", nil)
	e.expectError(t, 401, "unauthorized", "", "POST", "/me/tokens", map[string]any{"name": "x"})
	e.expectError(t, 401, "unauthorized", "", "DELETE", "/me/tokens/x", nil)
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "GET", "/me/tokens", nil)
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "POST", "/me/tokens", map[string]any{"name": "x"})
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "DELETE", "/me/tokens/x", nil)
}
