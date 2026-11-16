package dynamostore

import (
	"cmp"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// tokenItem stores one access token in its tenant partition, under its user.
// GSI1 indexes it by secret hash for authentication.
type tokenItem struct {
	keys
	TenantID   string     `dynamodbav:"TenantID"`
	UserID     string     `dynamodbav:"UserID"`
	ID         string     `dynamodbav:"ID"`
	Name       string     `dynamodbav:"Name"`
	Prefix     string     `dynamodbav:"Prefix"`
	Hash       string     `dynamodbav:"Hash"` // lowercase hex SHA-256 of the secret
	CreatedAt  time.Time  `dynamodbav:"CreatedAt"`
	ExpiresAt  time.Time  `dynamodbav:"ExpiresAt"`
	LastUsedAt *time.Time `dynamodbav:"LastUsedAt,omitempty"`
}

func newTokenItem(t domain.AccessToken) tokenItem {
	return tokenItem{
		keys: keys{
			PK: tenantPK(t.TenantID), SK: tokenSK(t.UserID, t.ID),
			GSI1PK: gsiTokenPK(t.Hash), GSI1SK: gsiTenantSK(t.TenantID),
		},
		TenantID:   t.TenantID,
		UserID:     t.UserID,
		ID:         t.ID,
		Name:       t.Name,
		Prefix:     t.Prefix,
		Hash:       hex.EncodeToString(t.Hash[:]),
		CreatedAt:  t.CreatedAt,
		ExpiresAt:  t.ExpiresAt,
		LastUsedAt: clonePtr(t.LastUsedAt),
	}
}

func (i tokenItem) domain() (domain.AccessToken, error) {
	t := domain.AccessToken{
		ID:         i.ID,
		TenantID:   i.TenantID,
		UserID:     i.UserID,
		Name:       i.Name,
		Prefix:     i.Prefix,
		CreatedAt:  i.CreatedAt,
		ExpiresAt:  i.ExpiresAt,
		LastUsedAt: clonePtr(i.LastUsedAt),
	}
	raw, err := hex.DecodeString(i.Hash)
	if err != nil || len(raw) != len(t.Hash) {
		return domain.AccessToken{}, fmt.Errorf("dynamostore: token %s has a malformed hash", i.ID)
	}
	copy(t.Hash[:], raw)
	return t, nil
}

// PutToken implements store.TokenStore.
func (s *Store) PutToken(ctx context.Context, t domain.AccessToken) error {
	return s.putPlain(ctx, newTokenItem(t))
}

// TokenByHash implements store.TokenStore. Candidates come from GSI1
// (eventually consistent, so a just-created token can be briefly unknown);
// each is confirmed with a strongly consistent read of the base item, so a
// deleted token is never returned.
func (s *Store) TokenByHash(ctx context.Context, hash [32]byte) (domain.AccessToken, error) {
	raw, err := s.queryGSI(ctx, gsiTokenPK(hash))
	if err != nil {
		return domain.AccessToken{}, err
	}
	want := hex.EncodeToString(hash[:])
	for _, m := range raw {
		it, err := get[tokenItem](ctx, s, strAttr(m, "PK"), strAttr(m, "SK"))
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return domain.AccessToken{}, err
		}
		// The index can lag a PutToken that replaced the hash.
		if it.Hash == want {
			return it.domain()
		}
	}
	return domain.AccessToken{}, store.ErrNotFound
}

// ListTokens implements store.TokenStore.
func (s *Store) ListTokens(ctx context.Context, tenantID, userID string) ([]domain.AccessToken, error) {
	items, err := listPrefix[tokenItem](ctx, s, tenantPK(tenantID), tokenPrefix(userID))
	if err != nil {
		return nil, err
	}
	out := make([]domain.AccessToken, 0, len(items))
	for _, it := range items {
		t, err := it.domain()
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	slices.SortFunc(out, func(a, b domain.AccessToken) int {
		return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

// DeleteToken implements store.TokenStore.
func (s *Store) DeleteToken(ctx context.Context, tenantID, userID, id string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           &s.table,
		Key:                 s.keyOf(tenantPK(tenantID), tokenSK(userID, id)),
		ConditionExpression: ptrTo("attribute_exists(PK)"),
	})
	if isConditionFailed(err) {
		return store.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete token: %w", err)
	}
	return nil
}

// TouchToken implements store.TokenStore. It rewrites the item on condition
// that it still exists, so a concurrent DeleteToken wins.
func (s *Store) TouchToken(ctx context.Context, tenantID, userID, id string, at time.Time) error {
	it, err := get[tokenItem](ctx, s, tenantPK(tenantID), tokenSK(userID, id))
	if err != nil {
		return err
	}
	it.LastUsedAt = &at
	if err := s.put(ctx, it, "attribute_exists(PK)", nil, nil); errors.Is(err, errConditionFailed) {
		return store.ErrNotFound
	} else if err != nil {
		return err
	}
	return nil
}
