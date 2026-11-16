package memstore

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type tokenKey struct{ userID, id string }

// tokenRef locates a token from the hash index.
type tokenRef struct {
	tenantID string
	key      tokenKey
}

func cloneToken(t domain.AccessToken) domain.AccessToken {
	t.LastUsedAt = clonePtr(t.LastUsedAt)
	return t
}

// PutToken implements store.TokenStore.
func (s *Store) PutToken(_ context.Context, t domain.AccessToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(t.TenantID)
	if td.tokens == nil {
		td.tokens = map[tokenKey]domain.AccessToken{}
	}
	if s.tokenHashes == nil {
		s.tokenHashes = map[[32]byte]tokenRef{}
	}
	key := tokenKey{t.UserID, t.ID}
	if prev, ok := td.tokens[key]; ok {
		delete(s.tokenHashes, prev.Hash)
	}
	td.tokens[key] = cloneToken(t)
	s.tokenHashes[t.Hash] = tokenRef{t.TenantID, key}
	return nil
}

// TokenByHash implements store.TokenStore.
func (s *Store) TokenByHash(_ context.Context, hash [32]byte) (domain.AccessToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ref, ok := s.tokenHashes[hash]
	if !ok {
		return domain.AccessToken{}, store.ErrNotFound
	}
	t, ok := s.read(ref.tenantID).tokens[ref.key]
	if !ok {
		return domain.AccessToken{}, store.ErrNotFound
	}
	return cloneToken(t), nil
}

// ListTokens implements store.TokenStore.
func (s *Store) ListTokens(_ context.Context, tenantID, userID string) ([]domain.AccessToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.AccessToken{}
	for key, t := range s.read(tenantID).tokens {
		if key.userID == userID {
			out = append(out, cloneToken(t))
		}
	}
	slices.SortFunc(out, func(a, b domain.AccessToken) int {
		return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

// DeleteToken implements store.TokenStore.
func (s *Store) DeleteToken(_ context.Context, tenantID, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	key := tokenKey{userID, id}
	t, ok := td.tokens[key]
	if !ok {
		return store.ErrNotFound
	}
	delete(td.tokens, key)
	delete(s.tokenHashes, t.Hash)
	return nil
}

// TouchToken implements store.TokenStore.
func (s *Store) TouchToken(_ context.Context, tenantID, userID, id string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	key := tokenKey{userID, id}
	t, ok := td.tokens[key]
	if !ok {
		return store.ErrNotFound
	}
	t.LastUsedAt = &at
	td.tokens[key] = t
	return nil
}
