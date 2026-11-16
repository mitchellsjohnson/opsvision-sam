package dynamostore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// assistantCredentialItem stores one user's sealed assistant credential in
// the tenant partition.
type assistantCredentialItem struct {
	keys
	UserID    string    `dynamodbav:"UserID"`
	Sealed    []byte    `dynamodbav:"Sealed"`
	Last4     string    `dynamodbav:"Last4"`
	UpdatedAt time.Time `dynamodbav:"UpdatedAt"`
}

// assistantSettingsItem stores the tenant's assistant settings.
type assistantSettingsItem struct {
	keys
	Enabled bool   `dynamodbav:"Enabled"`
	Model   string `dynamodbav:"Model"`
}

// PutCredential implements store.AssistantStore.
func (s *Store) PutCredential(ctx context.Context, tenantID, userID string, c domain.AssistantCredential) error {
	return s.putPlain(ctx, assistantCredentialItem{
		keys:      keys{PK: tenantPK(tenantID), SK: assistantCredentialSK(userID)},
		UserID:    userID,
		Sealed:    c.Sealed,
		Last4:     c.Last4,
		UpdatedAt: c.UpdatedAt,
	})
}

// GetCredential implements store.AssistantStore.
func (s *Store) GetCredential(ctx context.Context, tenantID, userID string) (domain.AssistantCredential, error) {
	it, err := get[assistantCredentialItem](ctx, s, tenantPK(tenantID), assistantCredentialSK(userID))
	if err != nil {
		return domain.AssistantCredential{}, err
	}
	return domain.AssistantCredential{Sealed: it.Sealed, Last4: it.Last4, UpdatedAt: it.UpdatedAt}, nil
}

// DeleteCredential implements store.AssistantStore.
func (s *Store) DeleteCredential(ctx context.Context, tenantID, userID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           &s.table,
		Key:                 s.keyOf(tenantPK(tenantID), assistantCredentialSK(userID)),
		ConditionExpression: ptrTo("attribute_exists(PK)"),
	})
	if isConditionFailed(err) {
		return store.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete assistant credential: %w", err)
	}
	return nil
}

// GetAssistantSettings implements store.AssistantStore.
func (s *Store) GetAssistantSettings(ctx context.Context, tenantID string) (domain.AssistantSettings, error) {
	it, err := get[assistantSettingsItem](ctx, s, tenantPK(tenantID), skAssistantSettings)
	if errors.Is(err, store.ErrNotFound) {
		return domain.DefaultAssistantSettings(), nil
	}
	if err != nil {
		return domain.AssistantSettings{}, err
	}
	return domain.AssistantSettings{Enabled: it.Enabled, Model: it.Model}, nil
}

// PutAssistantSettings implements store.AssistantStore.
func (s *Store) PutAssistantSettings(ctx context.Context, tenantID string, a domain.AssistantSettings) error {
	return s.putPlain(ctx, assistantSettingsItem{
		keys:    keys{PK: tenantPK(tenantID), SK: skAssistantSettings},
		Enabled: a.Enabled,
		Model:   a.Model,
	})
}
