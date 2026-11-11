package dynamostore

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type reportSummaryItem struct {
	keys
	ScorecardID string `dynamodbav:"ScorecardID"`
	Period      string `dynamodbav:"Period"`
	Text        string `dynamodbav:"Text"`
	Revision    int    `dynamodbav:"Revision"`
	UpdatedBy   string `dynamodbav:"UpdatedBy"`
	UpdatedAt   string `dynamodbav:"UpdatedAt"`
}

type reportRevisionItem struct {
	keys
	ScorecardID string `dynamodbav:"ScorecardID"`
	Period      string `dynamodbav:"Period"`
	Revision    int    `dynamodbav:"Revision"`
	PublishedBy string `dynamodbav:"PublishedBy"`
	PublishedAt string `dynamodbav:"PublishedAt"`
	ObjectKey   string `dynamodbav:"ObjectKey"`
}

func reportSummarySK(scorecardID, period string) string {
	return prefixReportSummary + scorecardID + "#" + period
}

func reportRevisionSK(scorecardID, period string, revision int) string {
	return prefixReportRev + scorecardID + "#" + period + "#" + strconv.Itoa(revision)
}

// GetReportSummary implements store.ReportStore.
func (s *Store) GetReportSummary(ctx context.Context, tenantID, scorecardID, period string) (domain.ReportSummary, error) {
	it, err := get[reportSummaryItem](ctx, s, tenantPK(tenantID), reportSummarySK(scorecardID, period))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return domain.ReportSummary{}, store.ErrNotFound
		}
		return domain.ReportSummary{}, err
	}
	at, err := time.Parse(time.RFC3339Nano, it.UpdatedAt)
	if err != nil {
		return domain.ReportSummary{}, err
	}
	return domain.ReportSummary{Text: it.Text, Revision: it.Revision, UpdatedBy: it.UpdatedBy, UpdatedAt: at}, nil
}

// PutReportSummary implements store.ReportStore.
func (s *Store) PutReportSummary(ctx context.Context, tenantID, scorecardID, period, text, by string, expectedRevision int, at time.Time) (domain.ReportSummary, error) {
	if expectedRevision < 0 {
		return domain.ReportSummary{}, store.ErrConflict
	}
	rev := expectedRevision + 1
	it := reportSummaryItem{
		keys:        keys{PK: tenantPK(tenantID), SK: reportSummarySK(scorecardID, period)},
		ScorecardID: scorecardID, Period: period, Text: text, Revision: rev,
		UpdatedBy: by, UpdatedAt: at.UTC().Format(time.RFC3339Nano),
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	if err := s.put(ctx, it, cond, names, values); errors.Is(err, errConditionFailed) {
		return domain.ReportSummary{}, store.ErrConflict
	} else if err != nil {
		return domain.ReportSummary{}, err
	}
	return domain.ReportSummary{Text: text, Revision: rev, UpdatedBy: by, UpdatedAt: at}, nil
}

// ListReportRevisions implements store.ReportStore.
func (s *Store) ListReportRevisions(ctx context.Context, tenantID, scorecardID string) ([]domain.ReportRevision, error) {
	prefix := prefixReportRev + scorecardID + "#"
	items, err := listPrefix[reportRevisionItem](ctx, s, tenantPK(tenantID), prefix)
	if err != nil {
		return nil, err
	}
	revisions := make([]domain.ReportRevision, 0, len(items))
	for _, it := range items {
		at, err := time.Parse(time.RFC3339Nano, it.PublishedAt)
		if err != nil {
			return nil, err
		}
		revisions = append(revisions, domain.ReportRevision{
			Period: it.Period, Revision: it.Revision, PublishedBy: it.PublishedBy,
			PublishedAt: at, ObjectKey: it.ObjectKey,
		})
	}
	slices.SortFunc(revisions, func(a, b domain.ReportRevision) int {
		if a.Period != b.Period {
			if a.Period > b.Period {
				return -1
			}
			return 1
		}
		return b.Revision - a.Revision
	})
	return revisions, nil
}

// PutReportRevision implements store.ReportStore.
func (s *Store) PutReportRevision(ctx context.Context, tenantID, scorecardID string, rev domain.ReportRevision) error {
	it := reportRevisionItem{
		keys:        keys{PK: tenantPK(tenantID), SK: reportRevisionSK(scorecardID, rev.Period, rev.Revision)},
		ScorecardID: scorecardID, Period: rev.Period, Revision: rev.Revision,
		PublishedBy: rev.PublishedBy, PublishedAt: rev.PublishedAt.UTC().Format(time.RFC3339Nano),
		ObjectKey: rev.ObjectKey,
	}
	if err := s.put(ctx, it, notExists, nil, nil); errors.Is(err, errConditionFailed) {
		return store.ErrConflict
	} else if err != nil {
		return err
	}
	return nil
}
