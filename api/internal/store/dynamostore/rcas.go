package dynamostore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// rcaItem is one RCA note in its scorecard's partition.
type rcaItem struct {
	keys
	Period    string `dynamodbav:"Period"`
	MetricKey string `dynamodbav:"MetricKey"`
	SubjectID string `dynamodbav:"SubjectID"`
	Body      string `dynamodbav:"Body"` // JSON domain.CellRCA
	Revision  int    `dynamodbav:"Revision"`
}

func (i rcaItem) domain() (domain.CellRCA, error) {
	var r domain.CellRCA
	if err := json.Unmarshal([]byte(i.Body), &r); err != nil {
		return domain.CellRCA{}, fmt.Errorf("dynamostore: decode RCA note: %w", err)
	}
	r.Revision = i.Revision
	return r, nil
}

// GetRCA implements store.RCAStore.
func (s *Store) GetRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) (domain.CellRCA, error) {
	it, err := get[rcaItem](ctx, s, rcaPK(tenantID, scorecardID), rcaSK(p, metricKey, subjectID))
	if err != nil {
		return domain.CellRCA{}, err
	}
	return it.domain()
}

// PutRCA implements store.RCAStore, conditioned on the stored revision.
func (s *Store) PutRCA(ctx context.Context, tenantID string, r domain.CellRCA, expectedRevision int) (domain.CellRCA, error) {
	if expectedRevision < 0 {
		return domain.CellRCA{}, store.ErrConflict
	}
	r.Revision = expectedRevision + 1
	body, err := json.Marshal(r)
	if err != nil {
		return domain.CellRCA{}, err
	}
	item := rcaItem{
		keys:      keys{PK: rcaPK(tenantID, r.ScorecardID), SK: rcaSK(r.Period, r.MetricKey, r.SubjectID)},
		Period:    r.Period.String(),
		MetricKey: r.MetricKey,
		SubjectID: r.SubjectID,
		Body:      string(body),
		Revision:  r.Revision,
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	if err := s.put(ctx, item, cond, names, values); errors.Is(err, errConditionFailed) {
		return domain.CellRCA{}, store.ErrConflict
	} else if err != nil {
		return domain.CellRCA{}, err
	}
	return item.domain()
}

// DeleteRCA implements store.RCAStore. The note is read first so a missing
// note (ErrNotFound) is told apart from a stale revision (ErrConflict).
func (s *Store) DeleteRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period, expectedRevision int) error {
	pk, sk := rcaPK(tenantID, scorecardID), rcaSK(p, metricKey, subjectID)
	cur, err := get[rcaItem](ctx, s, pk, sk)
	if err != nil {
		return err
	}
	if cur.Revision != expectedRevision {
		return store.ErrConflict
	}
	_, err = s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:                 &s.table,
		Key:                       s.keyOf(pk, sk),
		ConditionExpression:       ptrTo("#r = :r"),
		ExpressionAttributeNames:  map[string]string{"#r": "Revision"},
		ExpressionAttributeValues: avMap{":r": num(expectedRevision)},
	})
	if isConditionFailed(err) {
		return store.ErrConflict
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete RCA note: %w", err)
	}
	return nil
}

// ListRCAs implements store.RCAStore.
func (s *Store) ListRCAs(ctx context.Context, tenantID, scorecardID string, p period.Period) ([]domain.CellRCA, error) {
	raw, err := s.queryPK(ctx, rcaPK(tenantID, scorecardID), rcaPeriodPrefix(p), true)
	if err != nil {
		return nil, err
	}
	return rcasOf(raw)
}

// ListRCAsRange implements store.RCAStore with one range query on the sort
// key, which starts with the month each period ends in.
func (s *Store) ListRCAsRange(ctx context.Context, tenantID, scorecardID string, from, to period.Period) ([]domain.CellRCA, error) {
	lo, hi := rcaRangeBounds(from, to)
	raw, err := s.queryAll(ctx, &dynamodb.QueryInput{
		ConsistentRead:         ptrTo(true),
		KeyConditionExpression: ptrTo("PK = :pk AND SK BETWEEN :lo AND :hi"),
		ExpressionAttributeValues: avMap{
			":pk": str(rcaPK(tenantID, scorecardID)),
			":lo": str(lo),
			":hi": str(hi),
		},
	})
	if err != nil {
		return nil, err
	}
	return rcasOf(raw)
}

func rcasOf(raw []avMap) ([]domain.CellRCA, error) {
	items, err := unmarshalAll[rcaItem](raw)
	if err != nil {
		return nil, err
	}
	out := make([]domain.CellRCA, 0, len(items))
	for _, it := range items {
		r, err := it.domain()
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	store.SortRCAs(out)
	return out, nil
}
