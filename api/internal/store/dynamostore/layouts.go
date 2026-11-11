package dynamostore

import (
	"context"
	"encoding/json"
	"errors"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// layoutItem stores one user or default layout in the tenant partition.
type layoutItem struct {
	keys
	ScorecardID string `dynamodbav:"ScorecardID"`
	UserID      string `dynamodbav:"UserID,omitempty"`
	Revision    int    `dynamodbav:"Revision"`
	Body        string `dynamodbav:"Body"` // JSON []domain.LayoutItem
}

func newLayoutItem(tid string, sk string, scorecardID, userID string, items []domain.LayoutItem, revision int) (layoutItem, error) {
	body, err := json.Marshal(items)
	if err != nil {
		return layoutItem{}, err
	}
	return layoutItem{
		keys:        keys{PK: tenantPK(tid), SK: sk},
		ScorecardID: scorecardID,
		UserID:      userID,
		Revision:    revision,
		Body:        string(body),
	}, nil
}

func (i layoutItem) domain() (domain.Layout, error) {
	var items []domain.LayoutItem
	if err := json.Unmarshal([]byte(i.Body), &items); err != nil {
		return domain.Layout{}, err
	}
	if items == nil {
		items = []domain.LayoutItem{}
	}
	return domain.Layout{Items: items, Revision: i.Revision}, nil
}

func (s *Store) putLayout(ctx context.Context, tenantID, sk, scorecardID, userID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	if expectedRevision < 0 {
		return domain.Layout{}, store.ErrConflict
	}
	it, err := newLayoutItem(tenantID, sk, scorecardID, userID, items, expectedRevision+1)
	if err != nil {
		return domain.Layout{}, err
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	if err := s.put(ctx, it, cond, names, values); errors.Is(err, errConditionFailed) {
		return domain.Layout{}, store.ErrConflict
	} else if err != nil {
		return domain.Layout{}, err
	}
	return it.domain()
}

// GetLayout implements store.LayoutStore.
func (s *Store) GetLayout(ctx context.Context, tenantID, userID, scorecardID string) (domain.Layout, error) {
	it, err := get[layoutItem](ctx, s, tenantPK(tenantID), layoutSK(userID, scorecardID))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return domain.Layout{}, store.ErrNotFound
		}
		return domain.Layout{}, err
	}
	return it.domain()
}

// PutLayout implements store.LayoutStore.
func (s *Store) PutLayout(ctx context.Context, tenantID, userID, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	return s.putLayout(ctx, tenantID, layoutSK(userID, scorecardID), scorecardID, userID, items, expectedRevision)
}

// GetDefaultLayout implements store.LayoutStore.
func (s *Store) GetDefaultLayout(ctx context.Context, tenantID, scorecardID string) (domain.Layout, error) {
	it, err := get[layoutItem](ctx, s, tenantPK(tenantID), layoutDefaultSK(scorecardID))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return domain.Layout{}, store.ErrNotFound
		}
		return domain.Layout{}, err
	}
	return it.domain()
}

// PutDefaultLayout implements store.LayoutStore.
func (s *Store) PutDefaultLayout(ctx context.Context, tenantID, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	return s.putLayout(ctx, tenantID, layoutDefaultSK(scorecardID), scorecardID, "", items, expectedRevision)
}
