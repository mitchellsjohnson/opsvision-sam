package memstore

import (
	"context"
	"slices"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

type reportSummaryKey struct {
	scorecard, period string
}

type reportRevisionKey struct {
	scorecard, period string
	revision          int
}

func (s *Store) initReports(td *tenantData) {
	if td.reportSummaries == nil {
		td.reportSummaries = map[reportSummaryKey]domain.ReportSummary{}
	}
	if td.reportRevisions == nil {
		td.reportRevisions = map[reportRevisionKey]domain.ReportRevision{}
	}
}

// GetReportSummary implements store.ReportStore.
func (s *Store) GetReportSummary(_ context.Context, tenantID, scorecardID, period string) (domain.ReportSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := reportSummaryKey{scorecardID, period}
	sum, ok := s.read(tenantID).reportSummaries[key]
	if !ok {
		return domain.ReportSummary{}, store.ErrNotFound
	}
	return sum, nil
}

// PutReportSummary implements store.ReportStore.
func (s *Store) PutReportSummary(_ context.Context, tenantID, scorecardID, period, text, by string, expectedRevision int, at time.Time) (domain.ReportSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	s.initReports(td)
	key := reportSummaryKey{scorecardID, period}
	cur, exists := td.reportSummaries[key]
	if expectedRevision == 0 {
		if exists {
			return domain.ReportSummary{}, store.ErrConflict
		}
	} else if !exists || cur.Revision != expectedRevision {
		return domain.ReportSummary{}, store.ErrConflict
	}
	stored := domain.ReportSummary{
		Text: text, Revision: expectedRevision + 1, UpdatedBy: by, UpdatedAt: at,
	}
	td.reportSummaries[key] = stored
	return stored, nil
}

// ListReportRevisions implements store.ReportStore.
func (s *Store) ListReportRevisions(_ context.Context, tenantID, scorecardID string) ([]domain.ReportRevision, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	td := s.read(tenantID)
	if td.reportRevisions == nil {
		return []domain.ReportRevision{}, nil
	}
	var out []domain.ReportRevision
	for k, rev := range td.reportRevisions {
		if k.scorecard != scorecardID {
			continue
		}
		out = append(out, rev)
	}
	slices.SortFunc(out, func(a, b domain.ReportRevision) int {
		if a.Period != b.Period {
			if a.Period > b.Period {
				return -1
			}
			return 1
		}
		return b.Revision - a.Revision
	})
	return out, nil
}

// PutReportRevision implements store.ReportStore.
func (s *Store) PutReportRevision(_ context.Context, tenantID, scorecardID string, rev domain.ReportRevision) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	s.initReports(td)
	key := reportRevisionKey{scorecardID, rev.Period, rev.Revision}
	if _, exists := td.reportRevisions[key]; exists {
		return store.ErrConflict
	}
	td.reportRevisions[key] = rev
	return nil
}
