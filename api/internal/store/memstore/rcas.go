package memstore

import (
	"context"
	"slices"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

type rcaKey struct {
	scorecard, metric, subject string
	period                     period.Period
}

func rcaKeyOf(r domain.CellRCA) rcaKey {
	return rcaKey{r.ScorecardID, r.MetricKey, r.SubjectID, r.Period}
}

// copyRCA returns r with its slices and pointers copied, so neither the
// caller nor the store shares them.
func copyRCA(r domain.CellRCA) domain.CellRCA {
	r.Links = slices.Clone(r.Links)
	r.Basis.Evidence = slices.Clone(r.Basis.Evidence)
	if r.Basis.ReportedMinutes != nil {
		m := *r.Basis.ReportedMinutes
		r.Basis.ReportedMinutes = &m
	}
	return r
}

// GetRCA implements store.RCAStore.
func (s *Store) GetRCA(_ context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) (domain.CellRCA, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.read(tenantID).rcas[rcaKey{scorecardID, metricKey, subjectID, p}]
	if !ok {
		return domain.CellRCA{}, store.ErrNotFound
	}
	return copyRCA(r), nil
}

// PutRCA implements store.RCAStore.
func (s *Store) PutRCA(_ context.Context, tenantID string, r domain.CellRCA, expectedRevision int) (domain.CellRCA, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	if td.rcas == nil {
		td.rcas = map[rcaKey]domain.CellRCA{}
	}
	key := rcaKeyOf(r)
	cur, exists := td.rcas[key]
	switch {
	case expectedRevision < 0:
		return domain.CellRCA{}, store.ErrConflict
	case expectedRevision == 0 && exists:
		return domain.CellRCA{}, store.ErrConflict
	case expectedRevision > 0 && (!exists || cur.Revision != expectedRevision):
		return domain.CellRCA{}, store.ErrConflict
	}
	r = copyRCA(r)
	r.Revision = expectedRevision + 1
	td.rcas[key] = r
	return copyRCA(r), nil
}

// DeleteRCA implements store.RCAStore.
func (s *Store) DeleteRCA(_ context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period, expectedRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	key := rcaKey{scorecardID, metricKey, subjectID, p}
	cur, ok := td.rcas[key]
	switch {
	case !ok:
		return store.ErrNotFound
	case cur.Revision != expectedRevision:
		return store.ErrConflict
	}
	delete(td.rcas, key)
	return nil
}

// ListRCAs implements store.RCAStore.
func (s *Store) ListRCAs(_ context.Context, tenantID, scorecardID string, p period.Period) ([]domain.CellRCA, error) {
	return s.listRCAs(tenantID, scorecardID, func(q period.Period) bool { return q == p }), nil
}

// ListRCAsRange implements store.RCAStore.
func (s *Store) ListRCAsRange(_ context.Context, tenantID, scorecardID string, from, to period.Period) ([]domain.CellRCA, error) {
	return s.listRCAs(tenantID, scorecardID, func(q period.Period) bool { return store.RCAInRange(q, from, to) }), nil
}

func (s *Store) listRCAs(tenantID, scorecardID string, keep func(period.Period) bool) []domain.CellRCA {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.CellRCA{}
	for k, r := range s.read(tenantID).rcas {
		if k.scorecard == scorecardID && keep(k.period) {
			out = append(out, copyRCA(r))
		}
	}
	store.SortRCAs(out)
	return out
}
