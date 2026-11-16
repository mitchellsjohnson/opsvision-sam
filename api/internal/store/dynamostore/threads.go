package dynamostore

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// maxTxItems is DynamoDB's limit on items in one TransactWriteItems call.
const maxTxItems = 100

// assistantThreadItem is a thread header in the tenant partition.
type assistantThreadItem struct {
	keys
	ThreadID  string    `dynamodbav:"ThreadID"`
	UserID    string    `dynamodbav:"UserID"`
	Title     string    `dynamodbav:"Title"`
	Context   string    `dynamodbav:"Context,omitempty"` // JSON domain.AssistantContext
	CreatedAt time.Time `dynamodbav:"CreatedAt"`
	UpdatedAt time.Time `dynamodbav:"UpdatedAt"`
	Revision  int       `dynamodbav:"Revision"`
}

// assistantMessageItem is one message of a thread.
type assistantMessageItem struct {
	keys
	ThreadID string `dynamodbav:"ThreadID"`
	UserID   string `dynamodbav:"UserID"`
	Body     string `dynamodbav:"Body"` // JSON domain.AssistantMessage
}

func (i assistantThreadItem) domain() (domain.AssistantThread, error) {
	t := domain.AssistantThread{
		ID: i.ThreadID, UserID: i.UserID, Title: i.Title,
		CreatedAt: i.CreatedAt, UpdatedAt: i.UpdatedAt, Revision: i.Revision,
	}
	if i.Context != "" {
		var c domain.AssistantContext
		if err := json.Unmarshal([]byte(i.Context), &c); err != nil {
			return domain.AssistantThread{}, fmt.Errorf("dynamostore: decode thread context: %w", err)
		}
		t.Context = &c
	}
	return t, nil
}

// PutThread implements store.AssistantThreadStore. The header and the
// messages are written in one transaction, conditioned on the header's
// revision.
func (s *Store) PutThread(ctx context.Context, tenantID string, t domain.AssistantThread, msgs []domain.AssistantMessage, expectedRevision int) error {
	if expectedRevision < 0 {
		return store.ErrConflict
	}
	byID := map[string]domain.AssistantMessage{}
	var order []string
	for _, m := range msgs {
		if _, ok := byID[m.ID]; !ok {
			order = append(order, m.ID)
		}
		byID[m.ID] = m
	}
	if len(order) >= maxTxItems {
		return fmt.Errorf("dynamostore: put thread: %d messages in one write, limit is %d", len(order), maxTxItems-1)
	}
	header := assistantThreadItem{
		keys:      keys{PK: tenantPK(tenantID), SK: assistantThreadSK(t.UserID, t.ID)},
		ThreadID:  t.ID,
		UserID:    t.UserID,
		Title:     t.Title,
		CreatedAt: t.CreatedAt,
		UpdatedAt: t.UpdatedAt,
		Revision:  expectedRevision + 1,
	}
	if t.Context != nil {
		raw, err := json.Marshal(t.Context)
		if err != nil {
			return err
		}
		header.Context = string(raw)
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	hp, err := putTx(s.table, header, cond, names, values)
	if err != nil {
		return err
	}
	items := []types.TransactWriteItem{hp}
	for _, id := range order {
		body, err := json.Marshal(byID[id])
		if err != nil {
			return err
		}
		mp, err := putTx(s.table, assistantMessageItem{
			keys:     keys{PK: tenantPK(tenantID), SK: assistantMessageSK(t.UserID, t.ID, id)},
			ThreadID: t.ID,
			UserID:   t.UserID,
			Body:     string(body),
		}, "", nil, nil)
		if err != nil {
			return err
		}
		items = append(items, mp)
	}
	if err := s.transact(ctx, items); err != nil {
		if ce := asCanceled(err); ce != nil && ce.conditionFailed() {
			return store.ErrConflict
		}
		return fmt.Errorf("dynamostore: put thread: %w", err)
	}
	return nil
}

// GetThread implements store.AssistantThreadStore.
func (s *Store) GetThread(ctx context.Context, tenantID, userID, id string) (domain.AssistantThread, error) {
	h, err := get[assistantThreadItem](ctx, s, tenantPK(tenantID), assistantThreadSK(userID, id))
	if err != nil {
		return domain.AssistantThread{}, err
	}
	t, err := h.domain()
	if err != nil {
		return domain.AssistantThread{}, err
	}
	items, err := listPrefix[assistantMessageItem](ctx, s, tenantPK(tenantID), assistantMessagePrefix(userID, id))
	if err != nil {
		return domain.AssistantThread{}, err
	}
	t.Messages = make([]domain.AssistantMessage, 0, len(items))
	for _, it := range items {
		var m domain.AssistantMessage
		if err := json.Unmarshal([]byte(it.Body), &m); err != nil {
			return domain.AssistantThread{}, fmt.Errorf("dynamostore: decode thread message: %w", err)
		}
		t.Messages = append(t.Messages, m)
	}
	store.SortMessages(t.Messages)
	return t, nil
}

// ListThreads implements store.AssistantThreadStore.
func (s *Store) ListThreads(ctx context.Context, tenantID, userID string) ([]domain.AssistantThread, error) {
	items, err := listPrefix[assistantThreadItem](ctx, s, tenantPK(tenantID), assistantThreadPrefix(userID))
	if err != nil {
		return nil, err
	}
	out := make([]domain.AssistantThread, 0, len(items))
	for _, it := range items {
		t, err := it.domain()
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	store.SortThreads(out)
	return out, nil
}

// DeleteThread implements store.AssistantThreadStore. The header (on the
// condition that it exists) and the messages go in one transaction; a thread
// with more messages than one transaction holds loses the rest afterwards.
func (s *Store) DeleteThread(ctx context.Context, tenantID, userID, id string) error {
	msgs, err := s.queryPK(ctx, tenantPK(tenantID), assistantMessagePrefix(userID, id), true)
	if err != nil {
		return err
	}
	pk := tenantPK(tenantID)
	header := s.deleteTx(pk, assistantThreadSK(userID, id))
	header.Delete.ConditionExpression = ptrTo("attribute_exists(PK)")
	var rest []types.TransactWriteItem
	for _, m := range msgs {
		rest = append(rest, s.deleteTx(pk, strAttr(m, "SK")))
	}
	n := min(len(rest), maxTxItems-1)
	if err := s.transact(ctx, append([]types.TransactWriteItem{header}, rest[:n]...)); err != nil {
		if ce := asCanceled(err); ce != nil && ce.conditionFailed() {
			return store.ErrNotFound
		}
		return fmt.Errorf("dynamostore: delete thread: %w", err)
	}
	for chunk := range slices.Chunk(rest[n:], maxTxItems) {
		if err := s.transact(ctx, chunk); err != nil {
			return fmt.Errorf("dynamostore: delete thread messages: %w", err)
		}
	}
	return nil
}
