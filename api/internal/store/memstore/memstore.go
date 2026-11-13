// Package memstore is an in-memory store.Store. It backs unit tests and local
// development, and it defines the reference behavior that other
// implementations are held to by the storetest contract suite.
//
// All values are deep-copied on write and on read, so callers can never reach
// into the store's state. A single RWMutex guards everything.
package memstore

import (
	"cmp"
	"context"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Store is the in-memory implementation of store.Store.
type Store struct {
	mu      sync.RWMutex
	tenants map[string]domain.Tenant
	byOrg   map[string]string // Auth0OrgID -> tenant ID
	data    map[string]*tenantData
}

var _ store.Store = (*Store)(nil)

// New returns an empty store.
func New() *Store {
	return &Store{
		tenants: map[string]domain.Tenant{},
		byOrg:   map[string]string{},
		data:    map[string]*tenantData{},
	}
}

type moveKey struct {
	unit  string
	month period.Period
}

type versionKey struct{ scorecard, id string }

type pointKey struct {
	measure, subject string
	period           period.Period
}

type overrideKey struct {
	metric, subject string
	period          period.Period
}

// scorecardData holds one scorecard's data. history is oldest first; the last
// element is the current revision.
type scorecardData struct {
	history   map[pointKey][]domain.DataPoint
	overrides map[overrideKey]domain.Override
}

type tenantData struct {
	members         map[string]domain.Membership
	levels          []domain.Level
	units           map[string]domain.OrgUnit
	moves           map[moveKey]domain.OrgMove
	kinds           map[string]domain.ItemKind
	items           map[string]domain.TrackedItem
	scorecards      map[string]domain.Scorecard
	versions        map[versionKey]domain.MethodologyVersion
	scData          map[string]*scorecardData
	audit           []domain.AuditEntry
	imports         map[string]store.Import
	templates       map[string]store.Template
	recTypes        map[string]domain.RecordType
	snapshots       map[snapshotKey]domain.Snapshot
	records         map[string]map[recordKey]*domain.Record // by record type
	layouts         map[layoutKey]domain.Layout
	defaultLayouts  map[string]domain.Layout
	reportSummaries map[reportSummaryKey]domain.ReportSummary
	reportRevisions map[reportRevisionKey]domain.ReportRevision
}

type snapshotKey struct{ recordType, id string }

type recordKey struct{ source, externalID string }

type layoutKey struct{ userID, scorecardID string }

// tenant returns the tenant's data for writing, creating it if needed.
// Callers must hold the write lock.
func (s *Store) tenant(id string) *tenantData {
	td := s.data[id]
	if td == nil {
		td = &tenantData{
			members:        map[string]domain.Membership{},
			units:          map[string]domain.OrgUnit{},
			moves:          map[moveKey]domain.OrgMove{},
			kinds:          map[string]domain.ItemKind{},
			items:          map[string]domain.TrackedItem{},
			scorecards:     map[string]domain.Scorecard{},
			versions:       map[versionKey]domain.MethodologyVersion{},
			scData:         map[string]*scorecardData{},
			imports:        map[string]store.Import{},
			templates:      map[string]store.Template{},
			recTypes:       map[string]domain.RecordType{},
			snapshots:      map[snapshotKey]domain.Snapshot{},
			records:        map[string]map[recordKey]*domain.Record{},
			layouts:        map[layoutKey]domain.Layout{},
			defaultLayouts: map[string]domain.Layout{},
		}
		s.data[id] = td
	}
	return td
}

// empty is a tenantData with nothing in it, used for reads of unknown tenants.
var empty = &tenantData{}

// read returns the tenant's data for reading; an unknown tenant reads as
// empty (nil maps are safe to read). Callers must hold a lock.
func (s *Store) read(id string) *tenantData {
	if td := s.data[id]; td != nil {
		return td
	}
	return empty
}

func (td *tenantData) scorecardData(id string) *scorecardData {
	sd := td.scData[id]
	if sd == nil {
		sd = &scorecardData{
			history:   map[pointKey][]domain.DataPoint{},
			overrides: map[overrideKey]domain.Override{},
		}
		td.scData[id] = sd
	}
	return sd
}

// --- deep copies -----------------------------------------------------------

func cloneSlice[T any](in []T, f func(T) T) []T {
	if in == nil {
		return nil
	}
	out := make([]T, len(in))
	for i, v := range in {
		out[i] = f(v)
	}
	return out
}

func same[T any](v T) T { return v }

func cloneStrings(in []string) []string { return cloneSlice(in, same[string]) }

func cloneRaw(in json.RawMessage) json.RawMessage {
	if in == nil {
		return nil
	}
	return append(json.RawMessage{}, in...)
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneTenant(t domain.Tenant) domain.Tenant {
	t.StatusScale = cloneSlice(t.StatusScale, same[domain.StatusLevel])
	return t
}

func cloneMembership(m domain.Membership) domain.Membership {
	m.Scope.OrgUnitIDs = cloneStrings(m.Scope.OrgUnitIDs)
	m.Scope.MetricKeys = cloneStrings(m.Scope.MetricKeys)
	return m
}

func cloneUnit(u domain.OrgUnit) domain.OrgUnit {
	u.SourceKeys = cloneStrings(u.SourceKeys)
	u.RetiredFrom = clonePtr(u.RetiredFrom)
	return u
}

func cloneItem(it domain.TrackedItem) domain.TrackedItem {
	it.SourceKeys = cloneStrings(it.SourceKeys)
	return it
}

func cloneBands(bs []domain.Band) []domain.Band { return cloneSlice(bs, same[domain.Band]) }

func cloneMetric(m domain.Metric) domain.Metric {
	m.ReportedAt = cloneSlice(m.ReportedAt, same[domain.Subject])
	m.Targets = cloneSlice(m.Targets, same[domain.Target])
	m.Rule.Bands = cloneBands(m.Rule.Bands)
	m.Rule.Scale = cloneSlice(m.Rule.Scale, same[domain.ScaleStep])
	m.Rule.PerSubject = cloneSlice(m.Rule.PerSubject, func(sb domain.SubjectBands) domain.SubjectBands {
		sb.Bands = cloneBands(sb.Bands)
		return sb
	})
	return m
}

func cloneVersion(v domain.MethodologyVersion) domain.MethodologyVersion {
	v.PublishedAt = clonePtr(v.PublishedAt)
	v.Content.Categories = cloneSlice(v.Content.Categories, same[domain.Category])
	v.Content.Measures = cloneSlice(v.Content.Measures, same[domain.Measure])
	v.Content.Metrics = cloneSlice(v.Content.Metrics, cloneMetric)
	return v
}

func cloneRecordType(rt domain.RecordType) domain.RecordType {
	rt.Priorities = cloneStrings(rt.Priorities)
	rt.Attributes = cloneSlice(rt.Attributes, same[domain.AttributeDef])
	if rt.TrackedFrom != nil {
		rt.TrackedFrom = maps.Clone(rt.TrackedFrom)
	}
	return rt
}

func cloneFields(f domain.RecordFields) domain.RecordFields {
	f.CommittedAt = clonePtr(f.CommittedAt)
	f.DueAt = clonePtr(f.DueAt)
	f.CompletedAt = clonePtr(f.CompletedAt)
	f.MeasuredAt = clonePtr(f.MeasuredAt)
	f.Planned = clonePtr(f.Planned)
	f.Actual = clonePtr(f.Actual)
	f.ExpectedValue = clonePtr(f.ExpectedValue)
	f.DeliveredValue = clonePtr(f.DeliveredValue)
	f.PriorDueDates = cloneSlice(f.PriorDueDates, same[domain.Date])
	if f.Attributes != nil {
		// Attribute values are scalars (string, number, bool, date text).
		f.Attributes = maps.Clone(f.Attributes)
	}
	return f
}

func cloneRevision(r domain.RecordRevision) domain.RecordRevision {
	r.Fields = cloneFields(r.Fields)
	return r
}

func cloneRecord(r domain.Record) domain.Record {
	r.Revisions = cloneSlice(r.Revisions, cloneRevision)
	return r
}

func cloneSnapshot(sn domain.Snapshot) domain.Snapshot {
	if sn.Counts != nil {
		sn.Counts = maps.Clone(sn.Counts)
	}
	return sn
}

func clonePoint(p domain.DataPoint) domain.DataPoint {
	p.Value = clonePtr(p.Value)
	return p
}

func clonePointPtr(p *domain.DataPoint) *domain.DataPoint {
	if p == nil {
		return nil
	}
	c := clonePoint(*p)
	return &c
}

func cloneOverride(o domain.Override) domain.Override {
	o.Value = clonePtr(o.Value)
	return o
}

func cloneAudit(e domain.AuditEntry) domain.AuditEntry {
	e.Before = cloneRaw(e.Before)
	e.After = cloneRaw(e.After)
	return e
}

func cloneImport(im store.Import) store.Import {
	im.ChangeSet = cloneRaw(im.ChangeSet)
	return im
}

func cloneTemplate(t store.Template) store.Template {
	t.Body = cloneRaw(t.Body)
	t.LastUsed = clonePtr(t.LastUsed)
	return t
}

// sortedValues returns copies of a map's values, sorted with cmpf. The result
// is never nil.
func sortedValues[K comparable, V any](m map[K]V, clone func(V) V, cmpf func(a, b V) int) []V {
	out := make([]V, 0, len(m))
	for _, v := range m {
		out = append(out, clone(v))
	}
	slices.SortFunc(out, cmpf)
	return out
}

// --- TenantStore -----------------------------------------------------------

// CreateTenant implements store.TenantStore.
func (s *Store) CreateTenant(_ context.Context, t domain.Tenant) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.tenants[t.ID]; ok {
		return store.ErrConflict
	}
	if t.Auth0OrgID != "" {
		if _, ok := s.byOrg[t.Auth0OrgID]; ok {
			return store.ErrConflict
		}
		s.byOrg[t.Auth0OrgID] = t.ID
	}
	s.tenants[t.ID] = cloneTenant(t)
	return nil
}

// GetTenant implements store.TenantStore.
func (s *Store) GetTenant(_ context.Context, id string) (domain.Tenant, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.tenants[id]
	if !ok {
		return domain.Tenant{}, store.ErrNotFound
	}
	return cloneTenant(t), nil
}

// TenantByAuth0Org implements store.TenantStore.
func (s *Store) TenantByAuth0Org(_ context.Context, orgID string) (domain.Tenant, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byOrg[orgID]
	if !ok || orgID == "" {
		return domain.Tenant{}, store.ErrNotFound
	}
	return cloneTenant(s.tenants[id]), nil
}

// ListTenants implements store.TenantStore.
func (s *Store) ListTenants(_ context.Context) ([]domain.Tenant, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.tenants, cloneTenant, func(a, b domain.Tenant) int {
		return cmp.Or(strings.Compare(a.Name, b.Name), strings.Compare(a.ID, b.ID))
	}), nil
}

// PutMembership implements store.TenantStore.
func (s *Store) PutMembership(_ context.Context, tenantID string, m domain.Membership) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).members[m.UserID] = cloneMembership(m)
	return nil
}

// GetMembership implements store.TenantStore.
func (s *Store) GetMembership(_ context.Context, tenantID, userID string) (domain.Membership, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.read(tenantID).members[userID]
	if !ok {
		return domain.Membership{}, store.ErrNotFound
	}
	return cloneMembership(m), nil
}

// DeleteMembership implements store.TenantStore.
func (s *Store) DeleteMembership(_ context.Context, tenantID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.read(tenantID)
	if _, ok := td.members[userID]; !ok {
		return store.ErrNotFound
	}
	delete(td.members, userID)
	return nil
}

// ListMemberships implements store.TenantStore.
func (s *Store) ListMemberships(_ context.Context, tenantID string) ([]domain.Membership, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).members, cloneMembership, func(a, b domain.Membership) int {
		return strings.Compare(a.UserID, b.UserID)
	}), nil
}

// TenantsForUser implements store.TenantStore.
func (s *Store) TenantsForUser(_ context.Context, userID string) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []string{}
	for id, td := range s.data {
		if _, ok := td.members[userID]; ok {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out, nil
}

// --- OrgStore --------------------------------------------------------------

// PutLevels implements store.OrgStore.
func (s *Store) PutLevels(_ context.Context, tenantID string, ls []domain.Level) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).levels = cloneSlice(ls, same[domain.Level])
	return nil
}

// ListLevels implements store.OrgStore.
func (s *Store) ListLevels(_ context.Context, tenantID string) ([]domain.Level, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]domain.Level{}, s.read(tenantID).levels...)
	slices.SortFunc(out, func(a, b domain.Level) int {
		return cmp.Or(cmp.Compare(a.Depth, b.Depth), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

// PutOrgUnit implements store.OrgStore.
func (s *Store) PutOrgUnit(_ context.Context, tenantID string, u domain.OrgUnit) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).units[u.ID] = cloneUnit(u)
	return nil
}

// ListOrgUnits implements store.OrgStore.
func (s *Store) ListOrgUnits(_ context.Context, tenantID string) ([]domain.OrgUnit, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).units, cloneUnit, func(a, b domain.OrgUnit) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// PutOrgMove implements store.OrgStore.
func (s *Store) PutOrgMove(_ context.Context, tenantID string, m domain.OrgMove) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).moves[moveKey{m.UnitID, m.EffectiveMonth}] = m
	return nil
}

// ListOrgMoves implements store.OrgStore.
func (s *Store) ListOrgMoves(_ context.Context, tenantID string) ([]domain.OrgMove, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).moves, same[domain.OrgMove], func(a, b domain.OrgMove) int {
		return cmp.Or(strings.Compare(a.UnitID, b.UnitID), store.ComparePeriod(a.EffectiveMonth, b.EffectiveMonth))
	}), nil
}

// PutItemKind implements store.OrgStore.
func (s *Store) PutItemKind(_ context.Context, tenantID string, k domain.ItemKind) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).kinds[k.ID] = k
	return nil
}

// ListItemKinds implements store.OrgStore.
func (s *Store) ListItemKinds(_ context.Context, tenantID string) ([]domain.ItemKind, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).kinds, same[domain.ItemKind], func(a, b domain.ItemKind) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// PutTrackedItem implements store.OrgStore.
func (s *Store) PutTrackedItem(_ context.Context, tenantID string, it domain.TrackedItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).items[it.ID] = cloneItem(it)
	return nil
}

// ListTrackedItems implements store.OrgStore.
func (s *Store) ListTrackedItems(_ context.Context, tenantID string) ([]domain.TrackedItem, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).items, cloneItem, func(a, b domain.TrackedItem) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// --- MethodologyStore ------------------------------------------------------

// PutScorecard implements store.MethodologyStore.
func (s *Store) PutScorecard(_ context.Context, tenantID string, sc domain.Scorecard) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).scorecards[sc.ID] = sc
	return nil
}

// GetScorecard implements store.MethodologyStore.
func (s *Store) GetScorecard(_ context.Context, tenantID, id string) (domain.Scorecard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sc, ok := s.read(tenantID).scorecards[id]
	if !ok {
		return domain.Scorecard{}, store.ErrNotFound
	}
	return sc, nil
}

// ListScorecards implements store.MethodologyStore.
func (s *Store) ListScorecards(_ context.Context, tenantID string) ([]domain.Scorecard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).scorecards, same[domain.Scorecard], func(a, b domain.Scorecard) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// PutVersion implements store.MethodologyStore.
func (s *Store) PutVersion(_ context.Context, tenantID string, v domain.MethodologyVersion, expectedRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	key := versionKey{v.ScorecardID, v.ID}
	cur, exists := td.versions[key]
	switch {
	case expectedRevision == 0:
		if exists {
			return store.ErrConflict
		}
	case expectedRevision < 0 || !exists || cur.Revision != expectedRevision:
		return store.ErrConflict
	}
	c := cloneVersion(v)
	c.Revision = expectedRevision + 1
	td.versions[key] = c
	return nil
}

// GetVersion implements store.MethodologyStore.
func (s *Store) GetVersion(_ context.Context, tenantID, scorecardID, versionID string) (domain.MethodologyVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.read(tenantID).versions[versionKey{scorecardID, versionID}]
	if !ok {
		return domain.MethodologyVersion{}, store.ErrNotFound
	}
	return cloneVersion(v), nil
}

// ListVersions implements store.MethodologyStore.
func (s *Store) ListVersions(_ context.Context, tenantID, scorecardID string) ([]domain.MethodologyVersion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.MethodologyVersion{}
	for k, v := range s.read(tenantID).versions {
		if k.scorecard == scorecardID {
			out = append(out, cloneVersion(v))
		}
	}
	slices.SortFunc(out, func(a, b domain.MethodologyVersion) int {
		return cmp.Or(store.ComparePeriod(a.EffectiveFrom, b.EffectiveFrom), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

// --- DataStore -------------------------------------------------------------

// currentOf returns the newest revision in h, which may be a tombstone, or
// nil when h is empty. Use live to ask whether the point exists.
func currentOf(h []domain.DataPoint) *domain.DataPoint {
	if len(h) == 0 {
		return nil
	}
	return &h[len(h)-1]
}

// live returns the newest revision when it is not a tombstone, else nil.
func live(h []domain.DataPoint) *domain.DataPoint {
	if cur := currentOf(h); cur != nil && !cur.Deleted {
		return cur
	}
	return nil
}

// PutDataPoints implements store.DataStore. The batch is applied to scratch
// histories first, so writes later in a batch see earlier ones, and nothing is
// stored unless every write passes its revision check.
func (s *Store) PutDataPoints(_ context.Context, tenantID, scorecardID string, pts []store.DataWrite) ([]domain.DataPoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	sd := td.scorecardData(scorecardID)

	scratch := map[pointKey][]domain.DataPoint{}
	saved := make([]domain.DataPoint, 0, len(pts))
	var conflicts []store.DataConflict

	for _, w := range pts {
		key := pointKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period}
		hist, touched := scratch[key]
		if !touched {
			hist = sd.history[key]
		}
		cur := live(hist) // nil when the point is missing or deleted

		ok := true
		switch {
		case w.ExpectedRevision == store.Unconditional:
		case w.ExpectedRevision == store.MustNotExist:
			ok = cur == nil
		case w.ExpectedRevision > 0:
			ok = cur != nil && cur.Revision == w.ExpectedRevision
		default:
			ok = false // any other negative value is invalid
		}
		if !ok {
			conflicts = append(conflicts, store.DataConflict{
				Write:   store.DataWrite{Point: clonePoint(w.Point), ExpectedRevision: w.ExpectedRevision, Delete: w.Delete},
				Current: clonePointPtr(cur),
			})
			continue
		}

		p := clonePoint(w.Point)
		p.Deleted = false
		if w.Delete {
			if cur == nil {
				// Deleting a missing point is a no-op.
				p.Deleted, p.Revision = true, 0
				saved = append(saved, p)
				continue
			}
			p.Deleted, p.Source, p.Value = true, domain.SourceRecords, nil
		}
		// Revisions keep counting past a tombstone, so history is never
		// overwritten.
		p.Revision = 1
		if last := currentOf(hist); last != nil {
			p.Revision = last.Revision + 1
		}
		// Copy before appending so the stored history is never aliased.
		next := append(slices.Clone(hist), p)
		scratch[key] = next
		saved = append(saved, clonePoint(p))
	}

	if len(conflicts) > 0 {
		return nil, &store.ConflictError{Conflicts: conflicts}
	}
	for key, hist := range scratch {
		sd.history[key] = hist
	}
	return saved, nil
}

// ListData implements store.DataStore.
func (s *Store) ListData(_ context.Context, tenantID, scorecardID string, fiscalYears []int) ([]domain.DataPoint, []domain.Override, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	pts := []domain.DataPoint{}
	ovs := []domain.Override{}
	sd := s.read(tenantID).scData[scorecardID]
	if sd == nil {
		return pts, ovs, nil
	}
	for key, hist := range sd.history {
		if cur := live(hist); cur != nil && slices.Contains(fiscalYears, key.period.FY) {
			pts = append(pts, clonePoint(*cur))
		}
	}
	for key, o := range sd.overrides {
		if slices.Contains(fiscalYears, key.period.FY) {
			ovs = append(ovs, cloneOverride(o))
		}
	}
	slices.SortFunc(pts, func(a, b domain.DataPoint) int {
		return cmp.Or(
			strings.Compare(a.MeasureKey, b.MeasureKey),
			strings.Compare(a.SubjectID, b.SubjectID),
			store.ComparePeriod(a.Period, b.Period),
		)
	})
	slices.SortFunc(ovs, func(a, b domain.Override) int {
		return cmp.Or(
			strings.Compare(a.MetricKey, b.MetricKey),
			strings.Compare(a.SubjectID, b.SubjectID),
			store.ComparePeriod(a.Period, b.Period),
		)
	})
	return pts, ovs, nil
}

// LatestDataMonth implements store.DataStore.
func (s *Store) LatestDataMonth(_ context.Context, tenantID, scorecardID string, notAfter period.Period) (period.Period, bool, error) {
	if notAfter.Grain != period.Month {
		return period.Period{}, false, nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	sd := s.read(tenantID).scData[scorecardID]
	if sd == nil {
		return period.Period{}, false, nil
	}
	var latest period.Period
	found := false
	for key, hist := range sd.history {
		p := key.period
		if p.Grain != period.Month || p.FY < notAfter.FY-1 || store.ComparePeriod(p, notAfter) > 0 || live(hist) == nil {
			continue
		}
		if !found || store.ComparePeriod(p, latest) > 0 {
			latest, found = p, true
		}
	}
	return latest, found, nil
}

// History implements store.DataStore.
func (s *Store) History(_ context.Context, tenantID, scorecardID, measureKey, subjectID string, p period.Period) ([]domain.DataPoint, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.DataPoint{}
	sd := s.read(tenantID).scData[scorecardID]
	if sd == nil {
		return out, nil
	}
	hist := sd.history[pointKey{measureKey, subjectID, p}]
	for i := len(hist) - 1; i >= 0; i-- {
		out = append(out, clonePoint(hist[i]))
	}
	return out, nil
}

// PutOverride implements store.DataStore.
func (s *Store) PutOverride(_ context.Context, tenantID, scorecardID string, o domain.Override) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sd := s.tenant(tenantID).scorecardData(scorecardID)
	sd.overrides[overrideKey{o.MetricKey, o.SubjectID, o.Period}] = cloneOverride(o)
	return nil
}

// DeleteOverride implements store.DataStore.
func (s *Store) DeleteOverride(_ context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sd := s.read(tenantID).scData[scorecardID]
	if sd == nil {
		return store.ErrNotFound
	}
	key := overrideKey{metricKey, subjectID, p}
	if _, ok := sd.overrides[key]; !ok {
		return store.ErrNotFound
	}
	delete(sd.overrides, key)
	return nil
}

// --- AuditStore ------------------------------------------------------------

// AppendAudit implements store.AuditStore.
func (s *Store) AppendAudit(_ context.Context, tenantID string, e domain.AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	td.audit = append(td.audit, cloneAudit(e))
	return nil
}

// ListAudit implements store.AuditStore.
func (s *Store) ListAudit(_ context.Context, tenantID string, from, to time.Time) ([]domain.AuditEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.AuditEntry{}
	for _, e := range s.read(tenantID).audit {
		if !e.At.Before(from) && e.At.Before(to) {
			out = append(out, cloneAudit(e))
		}
	}
	slices.SortStableFunc(out, func(a, b domain.AuditEntry) int {
		return cmp.Or(a.At.Compare(b.At), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}

// --- ImportStore -----------------------------------------------------------

// PutImport implements store.ImportStore.
func (s *Store) PutImport(_ context.Context, tenantID string, im store.Import) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenant(tenantID).imports[im.ID] = cloneImport(im)
	return nil
}

// GetImport implements store.ImportStore.
func (s *Store) GetImport(_ context.Context, tenantID, id string) (store.Import, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	im, ok := s.read(tenantID).imports[id]
	if !ok {
		return store.Import{}, store.ErrNotFound
	}
	return cloneImport(im), nil
}

// PutTemplate implements store.ImportStore. The revision increments only
// when the content changes (store.TemplateContentChanged).
func (s *Store) PutTemplate(_ context.Context, tenantID string, t store.Template) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	c := cloneTemplate(t)
	prev, exists := td.templates[t.ID]
	c.Revision = prev.Revision
	if !exists || store.TemplateContentChanged(prev, t) {
		c.Revision++ // 1 when new
	}
	td.templates[t.ID] = c
	return nil
}

// DeleteTemplate implements store.ImportStore.
func (s *Store) DeleteTemplate(_ context.Context, tenantID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.tenant(tenantID)
	if _, ok := t.templates[id]; !ok {
		return store.ErrNotFound
	}
	delete(t.templates, id)
	return nil
}

// ListTemplates implements store.ImportStore.
func (s *Store) ListTemplates(_ context.Context, tenantID string) ([]store.Template, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).templates, cloneTemplate, func(a, b store.Template) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// --- LayoutStore -----------------------------------------------------------

func cloneLayoutItems(items []domain.LayoutItem) []domain.LayoutItem {
	if len(items) == 0 {
		return []domain.LayoutItem{}
	}
	out := make([]domain.LayoutItem, len(items))
	copy(out, items)
	return out
}

func cloneLayout(l domain.Layout) domain.Layout {
	return domain.Layout{Items: cloneLayoutItems(l.Items), Revision: l.Revision}
}

func putLayoutRevision(td *tenantData, key layoutKey, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	cur, exists := td.layouts[key]
	switch {
	case expectedRevision == 0:
		if exists {
			return domain.Layout{}, store.ErrConflict
		}
	case expectedRevision < 0 || !exists || cur.Revision != expectedRevision:
		return domain.Layout{}, store.ErrConflict
	}
	stored := domain.Layout{Items: cloneLayoutItems(items), Revision: expectedRevision + 1}
	td.layouts[key] = stored
	return cloneLayout(stored), nil
}

func putDefaultLayoutRevision(td *tenantData, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	cur, exists := td.defaultLayouts[scorecardID]
	switch {
	case expectedRevision == 0:
		if exists {
			return domain.Layout{}, store.ErrConflict
		}
	case expectedRevision < 0 || !exists || cur.Revision != expectedRevision:
		return domain.Layout{}, store.ErrConflict
	}
	stored := domain.Layout{Items: cloneLayoutItems(items), Revision: expectedRevision + 1}
	td.defaultLayouts[scorecardID] = stored
	return cloneLayout(stored), nil
}

// GetLayout implements store.LayoutStore.
func (s *Store) GetLayout(_ context.Context, tenantID, userID, scorecardID string) (domain.Layout, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	l, ok := s.read(tenantID).layouts[layoutKey{userID, scorecardID}]
	if !ok {
		return domain.Layout{}, store.ErrNotFound
	}
	return cloneLayout(l), nil
}

// PutLayout implements store.LayoutStore.
func (s *Store) PutLayout(_ context.Context, tenantID, userID, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return putLayoutRevision(s.tenant(tenantID), layoutKey{userID, scorecardID}, items, expectedRevision)
}

// GetDefaultLayout implements store.LayoutStore.
func (s *Store) GetDefaultLayout(_ context.Context, tenantID, scorecardID string) (domain.Layout, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	l, ok := s.read(tenantID).defaultLayouts[scorecardID]
	if !ok {
		return domain.Layout{}, store.ErrNotFound
	}
	return cloneLayout(l), nil
}

// PutDefaultLayout implements store.LayoutStore.
func (s *Store) PutDefaultLayout(_ context.Context, tenantID, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return putDefaultLayoutRevision(s.tenant(tenantID), scorecardID, items, expectedRevision)
}

// --- RecordStore -----------------------------------------------------------

// PutRecordType implements store.RecordStore.
func (s *Store) PutRecordType(_ context.Context, tenantID string, rt domain.RecordType, expectedRevision int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	cur, exists := td.recTypes[rt.ID]
	switch {
	case expectedRevision == 0:
		if exists {
			return store.ErrConflict
		}
	case expectedRevision < 0 || !exists || cur.Revision != expectedRevision:
		return store.ErrConflict
	}
	c := cloneRecordType(rt)
	c.Revision = expectedRevision + 1
	td.recTypes[rt.ID] = c
	return nil
}

// ListRecordTypes implements store.RecordStore.
func (s *Store) ListRecordTypes(_ context.Context, tenantID string) ([]domain.RecordType, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedValues(s.read(tenantID).recTypes, cloneRecordType, func(a, b domain.RecordType) int {
		return strings.Compare(a.ID, b.ID)
	}), nil
}

// ApplySnapshot implements store.RecordStore. It is atomic.
func (s *Store) ApplySnapshot(_ context.Context, tenantID string, sn domain.Snapshot, revs []store.RecordRevisionWrite) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	td := s.tenant(tenantID)
	key := snapshotKey{sn.RecordType, sn.ID}
	if _, ok := td.snapshots[key]; ok {
		return store.ErrConflict
	}
	for _, w := range revs {
		byKey := td.records[w.Type]
		if byKey == nil {
			byKey = map[recordKey]*domain.Record{}
			td.records[w.Type] = byKey
		}
		rk := recordKey{w.Source, w.ExternalID}
		rec := byKey[rk]
		if rec == nil {
			rec = &domain.Record{Source: w.Source, ExternalID: w.ExternalID, Type: w.Type}
			byKey[rk] = rec
		}
		r := cloneRevision(w.Rev)
		if i := slices.IndexFunc(rec.Revisions, func(x domain.RecordRevision) bool { return x.AsOf.Equal(r.AsOf.Time) }); i >= 0 {
			rec.Revisions[i] = r
		} else {
			rec.Revisions = append(rec.Revisions, r)
		}
	}
	td.snapshots[key] = cloneSnapshot(sn)
	return nil
}

// ListRecords implements store.RecordStore.
func (s *Store) ListRecords(_ context.Context, tenantID, recordType string) ([]domain.Record, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Record{}
	for _, rec := range s.read(tenantID).records[recordType] {
		c := cloneRecord(*rec)
		slices.SortFunc(c.Revisions, func(a, b domain.RecordRevision) int { return a.AsOf.Compare(b.AsOf.Time) })
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b domain.Record) int {
		return cmp.Or(strings.Compare(a.Source, b.Source), strings.Compare(a.ExternalID, b.ExternalID))
	})
	return out, nil
}

// ListSnapshots implements store.RecordStore.
func (s *Store) ListSnapshots(_ context.Context, tenantID, recordType string) ([]domain.Snapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Snapshot{}
	for k, sn := range s.read(tenantID).snapshots {
		if k.recordType == recordType {
			out = append(out, cloneSnapshot(sn))
		}
	}
	slices.SortFunc(out, func(a, b domain.Snapshot) int {
		return cmp.Or(b.AsOf.Compare(a.AsOf.Time), b.CreatedAt.Compare(a.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	return out, nil
}
