package memstore

import (
	"context"
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type threadKey struct{ userID, id string }

// storedThread is a thread header with its messages by ID.
type storedThread struct {
	header   domain.AssistantThread
	messages map[string]domain.AssistantMessage
}

func cloneThreadHeader(t domain.AssistantThread) domain.AssistantThread {
	if t.Context != nil {
		c := *t.Context
		t.Context = &c
	}
	t.Messages = nil
	return t
}

func cloneMessage(m domain.AssistantMessage) domain.AssistantMessage {
	if m.Usage != nil {
		u := *m.Usage
		m.Usage = &u
	}
	m.AllowedHosts = slices.Clone(m.AllowedHosts)
	return m
}

// PutThread implements store.AssistantThreadStore.
func (s *Store) PutThread(_ context.Context, tenantID string, t domain.AssistantThread, msgs []domain.AssistantMessage, expectedRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	if td.threads == nil {
		td.threads = map[threadKey]*storedThread{}
	}
	k := threadKey{t.UserID, t.ID}
	cur := td.threads[k]
	switch {
	case expectedRevision == 0 && cur != nil,
		expectedRevision != 0 && (cur == nil || cur.header.Revision != expectedRevision):
		return store.ErrConflict
	}
	next := &storedThread{messages: map[string]domain.AssistantMessage{}}
	if cur != nil {
		for id, m := range cur.messages {
			next.messages[id] = m
		}
	}
	next.header = cloneThreadHeader(t)
	next.header.Revision = expectedRevision + 1
	for _, m := range msgs {
		next.messages[m.ID] = cloneMessage(m)
	}
	td.threads[k] = next
	return nil
}

// GetThread implements store.AssistantThreadStore.
func (s *Store) GetThread(_ context.Context, tenantID, userID, id string) (domain.AssistantThread, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.read(tenantID).threads[threadKey{userID, id}]
	if st == nil {
		return domain.AssistantThread{}, store.ErrNotFound
	}
	out := cloneThreadHeader(st.header)
	out.Messages = make([]domain.AssistantMessage, 0, len(st.messages))
	for _, m := range st.messages {
		out.Messages = append(out.Messages, cloneMessage(m))
	}
	store.SortMessages(out.Messages)
	return out, nil
}

// ListThreads implements store.AssistantThreadStore.
func (s *Store) ListThreads(_ context.Context, tenantID, userID string) ([]domain.AssistantThread, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.AssistantThread{}
	for k, st := range s.read(tenantID).threads {
		if k.userID == userID {
			out = append(out, cloneThreadHeader(st.header))
		}
	}
	store.SortThreads(out)
	return out, nil
}

// DeleteThread implements store.AssistantThreadStore.
func (s *Store) DeleteThread(_ context.Context, tenantID, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	k := threadKey{userID, id}
	if td.threads[k] == nil {
		return store.ErrNotFound
	}
	delete(td.threads, k)
	return nil
}
