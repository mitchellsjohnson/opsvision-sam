package memstore

import (
	"context"
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type draftKey struct{ userID, id string }

func cloneDraft(d domain.AssistantDraft) domain.AssistantDraft {
	if d.Usage != nil {
		u := *d.Usage
		d.Usage = &u
	}
	d.Warnings = slices.Clone(d.Warnings)
	return d
}

// PutDraft implements store.AssistantDraftStore.
func (s *Store) PutDraft(_ context.Context, tenantID string, d domain.AssistantDraft, expectedRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	if td.drafts == nil {
		td.drafts = map[draftKey]domain.AssistantDraft{}
	}
	k := draftKey{d.UserID, d.ID}
	cur, ok := td.drafts[k]
	switch {
	case expectedRevision == 0 && ok,
		expectedRevision != 0 && (!ok || cur.Revision != expectedRevision):
		return store.ErrConflict
	}
	next := cloneDraft(d)
	next.Revision = expectedRevision + 1
	td.drafts[k] = next
	return nil
}

// GetDraft implements store.AssistantDraftStore.
func (s *Store) GetDraft(_ context.Context, tenantID, userID, id string) (domain.AssistantDraft, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.read(tenantID).drafts[draftKey{userID, id}]
	if !ok {
		return domain.AssistantDraft{}, store.ErrNotFound
	}
	return cloneDraft(d), nil
}

// ListDrafts implements store.AssistantDraftStore.
func (s *Store) ListDrafts(_ context.Context, tenantID, userID string) ([]domain.AssistantDraft, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.AssistantDraft{}
	for k, d := range s.read(tenantID).drafts {
		if k.userID == userID {
			out = append(out, cloneDraft(d))
		}
	}
	store.SortDrafts(out)
	return out, nil
}

// DeleteDraft implements store.AssistantDraftStore.
func (s *Store) DeleteDraft(_ context.Context, tenantID, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	k := draftKey{userID, id}
	if _, ok := td.drafts[k]; !ok {
		return store.ErrNotFound
	}
	delete(td.drafts, k)
	return nil
}
