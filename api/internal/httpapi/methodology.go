package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
	"opsvision/internal/store"
)

const msgPublishedImmutable = "published versions are immutable"

// methodologyAdmin returns the caller if it may change methodology.
func methodologyAdmin(ctx context.Context) (auth.Principal, error) {
	p, err := member(ctx)
	if err != nil {
		return p, err
	}
	if !auth.Can(p, auth.ActionMethodologyWrite, auth.Resource{}, nil, period.Period{}) {
		return p, forbidden("tenant admin role required")
	}
	return p, nil
}

// statusScale is the scale a tenant's methodology is validated against: its
// own, or the default when it has none.
func statusScale(t domain.Tenant) []domain.StatusLevel {
	if len(t.StatusScale) == 0 {
		return domain.DefaultStatusScale()
	}
	return t.StatusScale
}

// versionAudit is what the audit trail records about a version. The content
// is left out: it can be large, and GET .../diff recovers what changed
// between published versions.
type versionAudit struct {
	ID            string               `json:"id"`
	ScorecardID   string               `json:"scorecardId"`
	Name          string               `json:"name"`
	Status        domain.VersionStatus `json:"status"`
	EffectiveFrom string               `json:"effectiveFrom"`
	PublishedAt   *time.Time           `json:"publishedAt,omitempty"`
	Revision      int                  `json:"revision"`
	Counts        map[string]int       `json:"counts"`
}

func auditOfVersion(v domain.MethodologyVersion) versionAudit {
	return versionAudit{
		ID:            v.ID,
		ScorecardID:   v.ScorecardID,
		Name:          v.Name,
		Status:        v.Status,
		EffectiveFrom: periodString(v.EffectiveFrom),
		PublishedAt:   v.PublishedAt,
		Revision:      v.Revision,
		Counts: map[string]int{
			"categories": len(v.Content.Categories),
			"measures":   len(v.Content.Measures),
			"metrics":    len(v.Content.Metrics),
		},
	}
}

// deriveProblems checks content's derive rules against the tenant's record
// types: domain.ValidateDerive, then each where condition compiled against
// its record type, reported at measures[i].derive.where.
func (s *Server) deriveProblems(ctx context.Context, tenantID string, content domain.Methodology) ([]domain.ValidationError, error) {
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	errs := domain.ValidateDerive(content, types)
	byID := make(map[string]domain.RecordType, len(types))
	for _, rt := range types {
		byID[rt.ID] = rt
	}
	for i, m := range content.Measures {
		if m.Derive == nil || m.Derive.Where == "" {
			continue
		}
		rt, ok := byID[m.Derive.RecordType]
		if !ok {
			continue // ValidateDerive reports the unknown record type
		}
		if _, err := records.CompileWhere(m.Derive.Where, rt); err != nil {
			errs = append(errs, domain.ValidationError{Path: fmt.Sprintf("measures[%d].derive.where", i), Message: err.Error()})
		}
	}
	return errs, nil
}

// methodologyProblems is everything validate and publish report: the
// content's own rules and its derive rules.
func (s *Server) methodologyProblems(ctx context.Context, tenant domain.Tenant, content domain.Methodology) ([]domain.ValidationError, error) {
	derive, err := s.deriveProblems(ctx, tenant.ID, content)
	if err != nil {
		return nil, err
	}
	return append(content.Validate(statusScale(tenant)), derive...), nil
}

// scorecardOf loads a scorecard of the tenant, or reports 404.
func (s *Server) scorecardOf(ctx context.Context, tenantID, id string) (domain.Scorecard, error) {
	sc, err := s.store.GetScorecard(ctx, tenantID, id)
	if errors.Is(err, store.ErrNotFound) {
		return sc, notFound("scorecard not found")
	}
	return sc, err
}

// versionOf loads a version of a scorecard of the tenant, or reports 404.
func (s *Server) versionOf(ctx context.Context, tenantID, scorecardID, id string) (domain.MethodologyVersion, error) {
	v, err := s.store.GetVersion(ctx, tenantID, scorecardID, id)
	if errors.Is(err, store.ErrNotFound) {
		return v, notFound("version not found")
	}
	return v, err
}

// saveVersion writes v under optimistic concurrency and returns the stored
// version, whose revision the store assigned. A lost race is a 409.
func (s *Server) saveVersion(ctx context.Context, tenantID string, v domain.MethodologyVersion, expectedRevision int) (domain.MethodologyVersion, error) {
	if err := s.store.PutVersion(ctx, tenantID, v, expectedRevision); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return v, conflict("the version changed while saving; reload it and try again")
		}
		return v, err
	}
	return s.versionOf(ctx, tenantID, v.ScorecardID, v.ID)
}

// ListScorecards lists the tenant's scorecards.
func (s *Server) ListScorecards(ctx context.Context, _ ListScorecardsRequestObject) (ListScorecardsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	scs, err := s.store.ListScorecards(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	cal := s.calendar(*p.Tenant)
	fy := cal.MonthOf(s.now()).FY
	out := make([]ScorecardSummary, 0, len(scs))
	for _, sc := range scs {
		latest, err := s.latestDataMonth(ctx, p.Tenant.ID, sc.ID, []int{fy, fy - 1})
		if err != nil {
			return nil, err
		}
		out = append(out, ScorecardSummary{Id: sc.ID, Name: sc.Name, LatestDataMonth: latest})
	}
	return ListScorecards200JSONResponse{Scorecards: out}, nil
}

// latestDataMonth is the newest month-grain period with a stored data point
// for the scorecard in the given fiscal years, or nil when there is none.
func (s *Server) latestDataMonth(ctx context.Context, tenantID, scorecardID string, fiscalYears []int) (*MonthPeriod, error) {
	pts, _, err := s.store.ListData(ctx, tenantID, scorecardID, fiscalYears)
	if err != nil {
		return nil, err
	}
	var latest period.Period
	found := false
	for _, pt := range pts {
		if pt.Period.Grain != period.Month {
			continue
		}
		if !found || store.ComparePeriod(pt.Period, latest) > 0 {
			latest, found = pt.Period, true
		}
	}
	if !found {
		return nil, nil
	}
	m := latest.String()
	return &m, nil
}

// CreateScorecard adds a scorecard. Admins only.
func (s *Server) CreateScorecard(ctx context.Context, req CreateScorecardRequestObject) (CreateScorecardResponseObject, error) {
	p, err := methodologyAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	pr.id("id", req.Body.Id)
	pr.nonEmpty("name", req.Body.Name)
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	switch _, err := s.store.GetScorecard(ctx, tenantID, req.Body.Id); {
	case err == nil:
		return nil, conflict("scorecard " + req.Body.Id + " already exists")
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}
	sc := domain.Scorecard{ID: req.Body.Id, Name: strings.TrimSpace(req.Body.Name)}
	if err := s.store.PutScorecard(ctx, tenantID, sc); err != nil {
		return nil, err
	}
	out := Scorecard{Id: sc.ID, Name: sc.Name}
	if err := s.audit(ctx, p, tenantID, "scorecard.create", "scorecard", sc.ID, nil, out); err != nil {
		return nil, err
	}
	return CreateScorecard201JSONResponse(out), nil
}

// ListVersions lists a scorecard's versions, newest first: unpublished
// versions, then published ones by descending effective period.
func (s *Server) ListVersions(ctx context.Context, req ListVersionsRequestObject) (ListVersionsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.id("sc", req.Sc)
	if err := pr.err(); err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	vs, err := s.store.ListVersions(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(vs, func(a, b domain.MethodologyVersion) int {
		aUnset, bUnset := a.EffectiveFrom == (period.Period{}), b.EffectiveFrom == (period.Period{})
		switch {
		case aUnset && !bUnset:
			return -1
		case !aUnset && bUnset:
			return 1
		}
		if c := store.ComparePeriod(b.EffectiveFrom, a.EffectiveFrom); c != 0 {
			return c
		}
		return strings.Compare(b.ID, a.ID)
	})
	return ListVersions200JSONResponse{Versions: apiVersions(vs)}, nil
}

// CreateVersion adds a draft, empty or cloned from another version of the
// same scorecard. Admins only.
func (s *Server) CreateVersion(ctx context.Context, req CreateVersionRequestObject) (CreateVersionResponseObject, error) {
	p, err := methodologyAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	var pr problems
	pr.id("sc", req.Sc)
	pr.nonEmpty("name", b.Name)
	if b.CloneFrom != nil {
		pr.id("cloneFrom", *b.CloneFrom)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	if _, err := s.scorecardOf(ctx, tenantID, req.Sc); err != nil {
		return nil, err
	}

	content := domainMethodology(Methodology{}, &pr)
	if b.CloneFrom != nil {
		src, err := s.store.GetVersion(ctx, tenantID, req.Sc, *b.CloneFrom)
		if errors.Is(err, store.ErrNotFound) {
			pr.add("cloneFrom", "must be an existing version of scorecard %s", req.Sc)
			return nil, pr.err()
		}
		if err != nil {
			return nil, err
		}
		content = domainMethodology(apiMethodology(src.Content), &pr)
		if err := pr.err(); err != nil {
			return nil, err
		}
	}

	draft := domain.MethodologyVersion{
		ID:          s.newID(),
		ScorecardID: req.Sc,
		Name:        strings.TrimSpace(b.Name),
		Status:      domain.VersionDraft,
		Content:     content,
	}
	stored, err := s.saveVersion(ctx, tenantID, draft, 0)
	if err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "version.create", "version", stored.ID, nil, auditOfVersion(stored)); err != nil {
		return nil, err
	}
	return CreateVersion201JSONResponse(apiVersion(stored)), nil
}

// GetVersion returns one version.
func (s *Server) GetVersion(ctx context.Context, req GetVersionRequestObject) (GetVersionResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.id("sc", req.Sc)
	pr.id("v", req.V)
	if err := pr.err(); err != nil {
		return nil, err
	}
	v, err := s.versionOf(ctx, p.Tenant.ID, req.Sc, req.V)
	if err != nil {
		return nil, err
	}
	return GetVersion200JSONResponse(apiVersion(v)), nil
}

// PutVersion saves a draft's name and content. The content is stored as
// sent, however incomplete: a draft is work in progress, and the validate
// operation checks it. Admins only.
func (s *Server) PutVersion(ctx context.Context, req PutVersionRequestObject) (PutVersionResponseObject, error) {
	p, err := methodologyAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	var pr problems
	pr.id("sc", req.Sc)
	pr.id("v", req.V)
	if b.Revision < 0 {
		pr.add("revision", "must not be negative")
	}
	if b.Name != nil {
		pr.nonEmpty("name", *b.Name)
	}
	content := domainMethodology(b.Content, &pr)
	if err := pr.err(); err != nil {
		return nil, err
	}

	tenantID := p.Tenant.ID
	cur, err := s.versionOf(ctx, tenantID, req.Sc, req.V)
	if err != nil {
		return nil, err
	}
	if cur.Status != domain.VersionDraft {
		return nil, conflict(msgPublishedImmutable)
	}
	if b.Revision != cur.Revision {
		return nil, conflict("revision is stale; reload the version and try again")
	}

	updated := cur
	updated.Content = content
	if b.Name != nil {
		updated.Name = strings.TrimSpace(*b.Name)
	}
	stored, err := s.saveVersion(ctx, tenantID, updated, cur.Revision)
	if err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "version.update", "version", stored.ID, auditOfVersion(cur), auditOfVersion(stored)); err != nil {
		return nil, err
	}
	return PutVersion200JSONResponse(apiVersion(stored)), nil
}

// ValidateVersion checks a version's content against the tenant's status
// scale and its derive rules against the tenant's record types. Always 200
// for an existing version; problems are in the body. Admins only.
func (s *Server) ValidateVersion(ctx context.Context, req ValidateVersionRequestObject) (ValidateVersionResponseObject, error) {
	p, err := methodologyAdmin(ctx)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.id("sc", req.Sc)
	pr.id("v", req.V)
	if err := pr.err(); err != nil {
		return nil, err
	}
	v, err := s.versionOf(ctx, p.Tenant.ID, req.Sc, req.V)
	if err != nil {
		return nil, err
	}
	found, err := s.methodologyProblems(ctx, *p.Tenant, v.Content)
	if err != nil {
		return nil, err
	}
	errs := validationDetails(found)
	out := make([]ErrorDetail, 0, len(errs))
	for _, d := range errs {
		out = append(out, ErrorDetail{Path: d.Path, Message: d.Message})
	}
	return ValidateVersion200JSONResponse{Valid: len(out) == 0, Errors: out}, nil
}

func validationDetails(errs []domain.ValidationError) []detail {
	out := make([]detail, 0, len(errs))
	for _, e := range errs {
		out = append(out, detail{Path: e.Path, Message: e.Message})
	}
	return out
}

// inForce reports whether a version is one the engine may select for
// history: published, or superseded by a later one.
func inForce(v domain.MethodologyVersion) bool {
	return v.Status == domain.VersionPublished || v.Status == domain.VersionSuperseded
}

// PublishVersion makes a draft effective from a month. Published versions
// are immutable. The version in force immediately before the new month, if
// still marked published, becomes superseded. Derived values of open periods
// are then recalculated under the versions now in force. The publish stands
// if recalculation fails: the response reports the failure, which is logged,
// and the next records apply or publish recalculates again. Admins only.
func (s *Server) PublishVersion(ctx context.Context, req PublishVersionRequestObject) (PublishVersionResponseObject, error) {
	p, err := methodologyAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	pr.id("sc", req.Sc)
	pr.id("v", req.V)
	month, _ := pr.month("effectiveFrom", req.Body.EffectiveFrom)
	if err := pr.err(); err != nil {
		return nil, err
	}

	tenantID := p.Tenant.ID
	cur, err := s.versionOf(ctx, tenantID, req.Sc, req.V)
	if err != nil {
		return nil, err
	}
	if inForce(cur) {
		return nil, conflict("version is already published")
	}
	errs, err := s.methodologyProblems(ctx, *p.Tenant, cur.Content)
	if err != nil {
		return nil, err
	}
	if len(errs) > 0 {
		return nil, badRequest("methodology is invalid", validationDetails(errs)...)
	}

	all, err := s.store.ListVersions(ctx, tenantID, req.Sc)
	if err != nil {
		return nil, err
	}
	var predecessor *domain.MethodologyVersion
	for i, other := range all {
		if other.ID == cur.ID || !inForce(other) {
			continue
		}
		switch c := store.ComparePeriod(other.EffectiveFrom, month); {
		case c == 0:
			return nil, conflict(fmt.Sprintf("version %s is already effective from %s", other.ID, month))
		case c < 0 && (predecessor == nil || store.ComparePeriod(other.EffectiveFrom, predecessor.EffectiveFrom) > 0):
			predecessor = &all[i]
		}
	}

	now := s.now()
	published := cur
	published.Status = domain.VersionPublished
	published.EffectiveFrom = month
	published.PublishedAt = &now
	stored, err := s.saveVersion(ctx, tenantID, published, cur.Revision)
	if err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "version.publish", "version", stored.ID, auditOfVersion(cur), auditOfVersion(stored)); err != nil {
		return nil, err
	}

	// The new version is stored first: if marking the predecessor fails, the
	// status is stale but informational, and the engine treats published and
	// superseded alike.
	if predecessor != nil && predecessor.Status == domain.VersionPublished {
		old := *predecessor
		old.Status = domain.VersionSuperseded
		saved, err := s.saveVersion(ctx, tenantID, old, predecessor.Revision)
		if err != nil {
			return nil, err
		}
		if err := s.audit(ctx, p, tenantID, "version.supersede", "version", saved.ID, auditOfVersion(*predecessor), auditOfVersion(saved)); err != nil {
			return nil, err
		}
	}

	v := apiVersion(stored)
	out := PublishVersion200JSONResponse{
		Id: v.Id, ScorecardId: v.ScorecardId, Name: v.Name, Status: v.Status, EffectiveFrom: v.EffectiveFrom,
		PublishedAt: v.PublishedAt, Revision: v.Revision, Content: v.Content,
	}
	n, err := s.recalculate(ctx, p, req.Sc, stored.ID)
	if err != nil {
		slog.Error("httpapi: recalculation after publish failed", "tenant", tenantID, "scorecard", req.Sc, "version", stored.ID, "err", err)
		msg := "derived values could not be recalculated; they update with the next records upload or publish"
		out.RecalculationError = &msg
	}
	out.Recalculated = n
	return out, nil
}

// recalculate brings a scorecard's derived points up to date with the stored
// records under the versions in force, and returns the number of points
// written or removed. Phase 1 has no month lock, so every period is open.
// The writes are audited against the version whose publication caused them.
func (s *Server) recalculate(ctx context.Context, p auth.Principal, scorecardID, versionID string) (int, error) {
	tenantID := p.Tenant.ID
	writes, err := recordimport.Recalculate(ctx, s.store, *p.Tenant, scorecardID, func(period.Period) bool { return false }, nil)
	if err != nil {
		return 0, fmt.Errorf("httpapi: recalculate derived values: %w", err)
	}
	if len(writes) == 0 {
		return 0, nil
	}
	now := s.now()
	for i := range writes {
		writes[i].Point.EnteredBy, writes[i].Point.EnteredAt = p.UserID, now
	}
	if _, err := s.store.PutDataPoints(ctx, tenantID, scorecardID, writes); err != nil {
		return 0, fmt.Errorf("httpapi: save recalculated derived values: %w", err)
	}
	if err := s.audit(ctx, p, tenantID, "records.recalculate", "version", versionID, nil, map[string]int{"dataPoints": len(writes)}); err != nil {
		return len(writes), err
	}
	return len(writes), nil
}

// GetVersionDiff compares a version with another version of the scorecard,
// by default the published one currently in force.
func (s *Server) GetVersionDiff(ctx context.Context, req GetVersionDiffRequestObject) (GetVersionDiffResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.id("sc", req.Sc)
	pr.id("v", req.V)
	if req.Params.Against != nil {
		pr.id("against", *req.Params.Against)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	v, err := s.versionOf(ctx, tenantID, req.Sc, req.V)
	if err != nil {
		return nil, err
	}
	all, err := s.store.ListVersions(ctx, tenantID, req.Sc)
	if err != nil {
		return nil, err
	}

	var against *domain.MethodologyVersion
	if req.Params.Against != nil {
		for i := range all {
			if all[i].ID == *req.Params.Against {
				against = &all[i]
			}
		}
		if against == nil {
			pr.add("against", "must be an existing version of scorecard %s", req.Sc)
			return nil, pr.err()
		}
	} else {
		against = versionInForce(all)
		if against == nil {
			pr.add("against", "no published version to compare with; pass one")
			return nil, pr.err()
		}
	}

	d := DiffMethodology(against.Content, v.Content)
	return GetVersionDiff200JSONResponse(apiDiff(against.ID, v.ID, d, metricsByKey(against.Content), metricsByKey(v.Content))), nil
}

// newerPublication reports whether a is the later publication than b: the
// later effective month, then the later publication time, then the greater ID.
func newerPublication(a, b domain.MethodologyVersion) bool {
	if c := store.ComparePeriod(a.EffectiveFrom, b.EffectiveFrom); c != 0 {
		return c > 0
	}
	switch {
	case a.PublishedAt != nil && b.PublishedAt != nil && !a.PublishedAt.Equal(*b.PublishedAt):
		return a.PublishedAt.After(*b.PublishedAt)
	case a.PublishedAt != nil && b.PublishedAt == nil:
		return true
	case a.PublishedAt == nil && b.PublishedAt != nil:
		return false
	}
	return a.ID > b.ID
}

// versionInForce returns the published or superseded version with the latest
// effective month (ties go to the later publication, then the greater ID), or
// nil when none exists.
func versionInForce(all []domain.MethodologyVersion) *domain.MethodologyVersion {
	var best *domain.MethodologyVersion
	for i := range all {
		v := &all[i]
		if !inForce(*v) {
			continue
		}
		if best == nil || newerPublication(*v, *best) {
			best = v
		}
	}
	return best
}
