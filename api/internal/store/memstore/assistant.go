package memstore

import (
	"bytes"
	"context"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

func cloneCredential(c domain.AssistantCredential) domain.AssistantCredential {
	c.Sealed = bytes.Clone(c.Sealed)
	return c
}

// PutCredential implements store.AssistantStore.
func (s *Store) PutCredential(_ context.Context, tenantID, userID string, c domain.AssistantCredential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	if td.credentials == nil {
		td.credentials = map[string]domain.AssistantCredential{}
	}
	td.credentials[userID] = cloneCredential(c)
	return nil
}

// GetCredential implements store.AssistantStore.
func (s *Store) GetCredential(_ context.Context, tenantID, userID string) (domain.AssistantCredential, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.read(tenantID).credentials[userID]
	if !ok {
		return domain.AssistantCredential{}, store.ErrNotFound
	}
	return cloneCredential(c), nil
}

// DeleteCredential implements store.AssistantStore.
func (s *Store) DeleteCredential(_ context.Context, tenantID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	if _, ok := td.credentials[userID]; !ok {
		return store.ErrNotFound
	}
	delete(td.credentials, userID)
	return nil
}

// GetAssistantSettings implements store.AssistantStore.
func (s *Store) GetAssistantSettings(_ context.Context, tenantID string) (domain.AssistantSettings, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if a := s.read(tenantID).assistant; a != nil {
		return *a, nil
	}
	return domain.DefaultAssistantSettings(), nil
}

// PutAssistantSettings implements store.AssistantStore.
func (s *Store) PutAssistantSettings(_ context.Context, tenantID string, a domain.AssistantSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).assistant = &a
	return nil
}
