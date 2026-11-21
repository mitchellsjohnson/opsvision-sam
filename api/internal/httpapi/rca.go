package httpapi

import (
	"cmp"
	"context"
	"errors"
	"slices"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// summaryForbidden is the 403 of an exec summary write by anyone but an
// admin, on every channel.
const summaryForbidden = "Only admins can write exec summaries."

// Audit of exec summaries.
const (
	auditSummary        = "metric_summary"
	auditSummaryCreate  = "create"
	auditSummaryUpdate  = "update"
	auditSummaryConfirm = "confirm"
	auditSummaryDelete  = "delete"
)

func summaryAuditID(metric string, p period.Period) string {
	return metric + "|" + p.String()
}

// summaryAdmin returns the caller if it is an admin of its tenant; anyone
// else gets the exec summary 403.
func summaryAdmin(ctx context.Context) (auth.Principal, error) {
	p, err := member(ctx)
	if err != nil {
		return p, err
	}
	if !auth.Can(p, auth.ActionTenantAdmin, auth.Resource{}, nil, period.Period{}) {
		return p, forbidden(summaryForbidden)
	}
	return p, nil
}

func apiRcaLinks(ls []domain.RCALink) []RcaLink {
	out := make([]RcaLink, 0, len(ls))
	for _, l := range ls {
		out = append(out, RcaLink{Title: l.Title, Url: l.URL})
	}
	return out
}

// apiMetricSummary is a metric-month's summary slot: the summary r when one
// is stored (stale when reasons are given), else missing or optional by the
// requirement. links caps the links returned (all when negative).
func apiMetricSummary(f summaryFacts, r *domain.CellRCA, reasons []string, canEdit bool, links int) MetricSummary {
	out := MetricSummary{
		MetricKey: f.metric.Key, MetricName: f.metric.Name, Period: f.period.String(),
		Requirement: MetricSummaryRequirementOptional, State: SummaryStateOptional, Standing: f.standing,
		Links: []RcaLink{}, StaleReasons: []string{}, CanEdit: canEdit,
	}
	if f.metric.CategoryID != "" {
		out.CategoryId = &f.metric.CategoryID
	}
	if f.req.Required {
		out.Requirement, out.State, out.RequirementReason = MetricSummaryRequirementRequired, SummaryStateMissing, &f.req.Reason
	}
	if r == nil {
		return out
	}
	text, author, channel, updated, rev := r.Text, r.AuthorName, MetricSummaryChannel(r.Channel), r.UpdatedAt, r.Revision
	out.Text, out.AuthorName, out.Channel, out.UpdatedAt, out.Revision = &text, &author, &channel, &updated, &rev
	out.LinksTotal = len(r.Links)
	ls := r.Links
	if links >= 0 && len(ls) > links {
		ls = ls[:links]
	}
	out.Links = apiRcaLinks(ls)
	out.State = SummaryStateWritten
	if len(reasons) > 0 {
		out.State, out.Stale, out.StaleReasons = SummaryStateStale, true, reasons
	}
	return out
}

// summaryCell is one metric-period at company scope, ready to write: its
// facts and its current basis (with incident evidence).
type summaryCell struct {
	facts summaryFacts
	basis domain.RCABasis
	root  string
	scale []domain.StatusLevel
}

// summaryCellOf checks that metric is in the methodology in force for per,
// at the metric's own grain, and computes its company standing and basis.
func (s *Server) summaryCellOf(ctx context.Context, tenant domain.Tenant, sc, metric string, per period.Period) (summaryCell, error) {
	in, err := s.loadInput(ctx, tenant, sc, fiscalYears(true, per))
	if err != nil {
		return summaryCell{}, err
	}
	var pr problems
	v, ok := engine.VersionFor(in.Versions, per, in.Cal)
	if !ok {
		pr.add("period", "no methodology version is in force for %s", per)
		return summaryCell{}, pr.err()
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if mi < 0 {
		pr.add("metric", "metric %q is not in the methodology in force for %s", metric, per)
		return summaryCell{}, pr.err()
	}
	m := v.Content.Metrics[mi]
	if g, ok := frequencyGrain(m.Frequency); ok && g != per.Grain {
		pr.add("period", "%s is reported for whole %s periods", metric, grainName(g))
		return summaryCell{}, pr.err()
	}
	month, _ := lastMonth(in.Cal, per)
	root := reportRoot(in, month)
	if root == "" {
		pr.add("period", "the organization has no single top-level unit in %s", month)
		return summaryCell{}, pr.err()
	}
	view, err := engine.Compute(in, engine.ViewRequest{Periods: []period.Period{per}, MetricKeys: []string{metric}, Structure: engine.StructureAsOf})
	if err != nil {
		return summaryCell{}, err
	}
	c, err := s.newSummaryContext(ctx, tenant, sc, in, root)
	if err != nil {
		return summaryCell{}, err
	}
	f := c.facts(v, m, per, view.Rows, 0, false, true)
	incidents, err := s.incidentEvidence(ctx, tenant.ID, sc, in, f)
	if err != nil {
		return summaryCell{}, err
	}
	return summaryCell{facts: f, basis: f.basis(incidents), root: root, scale: c.scale}, nil
}

func grainName(g period.Grain) string {
	switch g {
	case period.Quarter:
		return "quarter"
	case period.Half:
		return "half-year"
	case period.Year:
		return "year"
	}
	return "month"
}

// summaryConflict is the 409 body of a stale write: the summary as stored
// now, if any. cell is nil when the metric-period no longer resolves.
func (s *Server) summaryConflict(ctx context.Context, tenantID, sc, metric, root string, per period.Period, cell *summaryCell) (MetricSummaryConflict, error) {
	out := MetricSummaryConflict{}
	out.Error.Code = MetricSummaryConflictErrorCode(codeConflict)
	out.Error.Message = "Someone else changed this exec summary while you were editing."
	cur, err := s.store.GetRCA(ctx, tenantID, sc, metric, root, per)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return out, nil
	case err != nil:
		return out, err
	}
	var f summaryFacts
	var reasons []string
	if cell != nil {
		f = cell.facts
		reasons = staleReasons(cur.Basis, cell.basis, scaleLabelOf(cell.scale))
	} else {
		f = summaryFacts{metric: domain.Metric{Key: metric, Name: metric}, period: per,
			standing: MetricSummaryStanding{Display: cur.Basis.Display, Status: cur.Basis.Status}}
	}
	current := apiMetricSummary(f, &cur, reasons, true, -1)
	out.Current = &current
	return out, nil
}

func scaleLabelOf(scale []domain.StatusLevel) func(string) string {
	return func(key string) string {
		for _, l := range scale {
			if l.Key == key {
				return l.Label
			}
		}
		return key
	}
}

// PutMetricSummary writes or updates one metric's exec summary for a
// period, on the company, storing the company standing as its basis.
// Saving the same text and links is a confirm. Only admins.
func (s *Server) PutMetricSummary(ctx context.Context, req PutMetricSummaryRequestObject) (PutMetricSummaryResponseObject, error) {
	p, err := summaryAdmin(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	var pr problems
	pr.key("metric", req.Metric)
	per, _ := parsePeriod(&pr, "period", req.Period)
	if b.ExpectedRevision < 0 {
		pr.add("expectedRevision", "must be 0 or greater")
	}
	summary := domain.CellRCA{Text: b.Text, Links: make([]domain.RCALink, 0, len(b.Links))}
	for _, l := range b.Links {
		summary.Links = append(summary.Links, domain.RCALink{Title: l.Title, URL: l.Url})
	}
	for _, e := range summary.Validate() {
		pr.add(e.Path, "%s", e.Message)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	cell, err := s.summaryCellOf(ctx, *p.Tenant, sc.ID, req.Metric, per)
	if err != nil {
		return nil, err
	}
	before, err := s.store.GetRCA(ctx, tenantID, sc.ID, req.Metric, cell.root, per)
	exists := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	now := s.now()
	summary.ScorecardID, summary.MetricKey, summary.SubjectID, summary.Period = sc.ID, req.Metric, cell.root, per
	summary.AuthorID, summary.AuthorName, summary.Channel = p.UserID, cmp.Or(p.Membership.Name, p.Name), domain.RCAChannel(p.Channel)
	summary.CreatedAt, summary.UpdatedAt, summary.Basis = now, now, cell.basis
	if exists && b.ExpectedRevision > 0 {
		summary.CreatedAt = before.CreatedAt
	}
	summary = summary.Normalize()
	stored, err := s.store.PutRCA(ctx, tenantID, summary, b.ExpectedRevision)
	if errors.Is(err, store.ErrConflict) {
		c, err := s.summaryConflict(ctx, tenantID, sc.ID, req.Metric, cell.root, per, &cell)
		if err != nil {
			return nil, err
		}
		return PutMetricSummary409JSONResponse(c), nil
	}
	if err != nil {
		return nil, err
	}

	action, auditBefore := auditSummaryCreate, any(nil)
	if b.ExpectedRevision > 0 {
		action, auditBefore = auditSummaryUpdate, before
		if before.Text == stored.Text && slices.Equal(before.Links, stored.Links) {
			action = auditSummaryConfirm
		}
	}
	if err := s.audit(ctx, p, tenantID, action, auditSummary, summaryAuditID(req.Metric, per), auditBefore, stored); err != nil {
		return nil, err
	}
	return PutMetricSummary200JSONResponse(apiMetricSummary(cell.facts, &stored, nil, true, -1)), nil
}

// DeleteMetricSummary removes one metric's exec summary for a period. Only
// admins; the audit entry keeps the text. A summary of a metric no longer in
// force can still be deleted.
func (s *Server) DeleteMetricSummary(ctx context.Context, req DeleteMetricSummaryRequestObject) (DeleteMetricSummaryResponseObject, error) {
	p, err := summaryAdmin(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.key("metric", req.Metric)
	per, _ := parsePeriod(&pr, "period", req.Period)
	if req.Params.ExpectedRevision < 1 {
		pr.add("expectedRevision", "must be 1 or greater")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, nil)
	if err != nil {
		return nil, err
	}
	month, ok := lastMonth(in.Cal, per)
	root := reportRoot(in, month)
	if !ok || root == "" {
		return nil, notFound("this metric has no exec summary for " + per.String())
	}
	before, err := s.store.GetRCA(ctx, tenantID, sc.ID, req.Metric, root, per)
	if errors.Is(err, store.ErrNotFound) {
		return nil, notFound("this metric has no exec summary for " + per.String())
	} else if err != nil {
		return nil, err
	}
	switch err := s.store.DeleteRCA(ctx, tenantID, sc.ID, req.Metric, root, per, req.Params.ExpectedRevision); {
	case errors.Is(err, store.ErrConflict):
		var cellp *summaryCell
		if cell, err := s.summaryCellOf(ctx, *p.Tenant, sc.ID, req.Metric, per); err == nil {
			cellp = &cell
		}
		c, err := s.summaryConflict(ctx, tenantID, sc.ID, req.Metric, root, per, cellp)
		if err != nil {
			return nil, err
		}
		return DeleteMetricSummary409JSONResponse(c), nil
	case errors.Is(err, store.ErrNotFound):
		return nil, notFound("this metric has no exec summary for " + per.String())
	case err != nil:
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, auditSummaryDelete, auditSummary, summaryAuditID(req.Metric, per), before, nil); err != nil {
		return nil, err
	}
	return DeleteMetricSummary204Response{}, nil
}
