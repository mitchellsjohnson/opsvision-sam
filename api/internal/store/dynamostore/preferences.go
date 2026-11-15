package dynamostore

import (
	"context"

	"opsvision/internal/domain"
)

// preferencesItem stores one user's preferences in the tenant partition.
type preferencesItem struct {
	keys
	UserID       string `dynamodbav:"UserID"`
	DefaultScope string `dynamodbav:"DefaultScope"`
}

// GetPreferences implements store.PreferenceStore.
func (s *Store) GetPreferences(ctx context.Context, tenantID, userID string) (domain.UserPreferences, error) {
	it, err := get[preferencesItem](ctx, s, tenantPK(tenantID), preferencesSK(userID))
	if err != nil {
		return domain.UserPreferences{}, err
	}
	return domain.UserPreferences{DefaultScope: it.DefaultScope}, nil
}

// PutPreferences implements store.PreferenceStore.
func (s *Store) PutPreferences(ctx context.Context, tenantID, userID string, p domain.UserPreferences) error {
	return s.put(ctx, preferencesItem{
		keys:         keys{PK: tenantPK(tenantID), SK: preferencesSK(userID)},
		UserID:       userID,
		DefaultScope: p.DefaultScope,
	}, "", nil, nil)
}
