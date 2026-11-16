package dynamostore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// assistantDraftItem is one report summary draft in the tenant partition.
type assistantDraftItem struct {
	keys
	DraftID  string `dynamodbav:"DraftID"`
	UserID   string `dynamodbav:"UserID"`
	Body     string `dynamodbav:"Body"` // JSON domain.AssistantDraft
	Revision int    `dynamodbav:"Revision"`
}

func (i assistantDraftItem) domain() (domain.AssistantDraft, error) {
	var d domain.AssistantDraft
	if err := json.Unmarshal([]byte(i.Body), &d); err != nil {
		return domain.AssistantDraft{}, fmt.Errorf("dynamostore: decode draft: %w", err)
	}
	d.Revision = i.Revision
	return d, nil
}

// PutDraft implements store.AssistantDraftStore, conditioned on the stored
// revision.
func (s *Store) PutDraft(ctx context.Context, tenantID string, d domain.AssistantDraft, expectedRevision int) error {
	if expectedRevision < 0 {
		return store.ErrConflict
	}
	body, err := json.Marshal(d)
	if err != nil {
		return err
	}
	item := assistantDraftItem{
		keys:     keys{PK: tenantPK(tenantID), SK: assistantDraftSK(d.UserID, d.ID)},
		DraftID:  d.ID,
		UserID:   d.UserID,
		Body:     string(body),
		Revision: expectedRevision + 1,
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	err = s.put(ctx, item, cond, names, values)
	if errors.Is(err, errConditionFailed) {
		return store.ErrConflict
	}
	return err
}

// GetDraft implements store.AssistantDraftStore.
func (s *Store) GetDraft(ctx context.Context, tenantID, userID, id string) (domain.AssistantDraft, error) {
	it, err := get[assistantDraftItem](ctx, s, tenantPK(tenantID), assistantDraftSK(userID, id))
	if err != nil {
		return domain.AssistantDraft{}, err
	}
	return it.domain()
}

// ListDrafts implements store.AssistantDraftStore.
func (s *Store) ListDrafts(ctx context.Context, tenantID, userID string) ([]domain.AssistantDraft, error) {
	items, err := listPrefix[assistantDraftItem](ctx, s, tenantPK(tenantID), assistantDraftPrefix(userID))
	if err != nil {
		return nil, err
	}
	out := make([]domain.AssistantDraft, 0, len(items))
	for _, it := range items {
		d, err := it.domain()
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	store.SortDrafts(out)
	return out, nil
}

// DeleteDraft implements store.AssistantDraftStore.
func (s *Store) DeleteDraft(ctx context.Context, tenantID, userID, id string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           &s.table,
		Key:                 s.keyOf(tenantPK(tenantID), assistantDraftSK(userID, id)),
		ConditionExpression: ptrTo("attribute_exists(PK)"),
	})
	if isConditionFailed(err) {
		return store.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete draft: %w", err)
	}
	return nil
}
