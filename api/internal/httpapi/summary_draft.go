package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

const msgStillDraftingExecSummary = "SAM is still drafting this exec summary. Wait for the draft before asking again."

func apiMetricSummaryDraft(d domain.AssistantDraft, now time.Time) MetricSummaryDraft {
	r := apiReportSummaryDraft(d, now)
	out := MetricSummaryDraft{Id: r.Id, Pending: r.Pending, CreatedAt: r.CreatedAt, Text: r.Text, Error: r.Error, Usage: r.Usage, Warnings: []string{}}
	if r.Text != nil && len(d.Warnings) > 0 {
		out.Warnings = slices.Clone(d.Warnings)
	}
	return out
}

// draftSlot checks that metric is in the methodology in force for per at its
// own grain, reading the org tree and the versions only (no data).
func (s *Server) draftSlot(ctx context.Context, tenant domain.Tenant, sc, metric string, per period.Period) error {
	in, err := s.loadInput(ctx, tenant, sc, nil)
	if err != nil {
		return err
	}
	v, ok := engine.VersionFor(in.Versions, per, in.Cal)
	if !ok {
		return notFound("no methodology version is in force for " + per.String())
	}
	i := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if i < 0 {
		return notFound("metric not found")
	}
	if g, ok := frequencyGrain(v.Content.Metrics[i].Frequency); ok && g != per.Grain {
		return badRequest("request validation failed",
			detail{Path: "period", Message: fmt.Sprintf("%s is reported for whole %s periods", metric, grainName(g))})
	}
	if month, ok := lastMonth(in.Cal, per); !ok || reportRoot(in, month) == "" {
		return notFound("the organization has no single top-level unit in " + per.String())
	}
	return nil
}

// DraftMetricSummary stores a pending SAM draft of one metric's exec summary
// for the calling admin and enqueues the job that writes it. The draft is a
// suggestion: it is never the summary, and nothing reads it but its owner.
func (s *Server) DraftMetricSummary(ctx context.Context, req DraftMetricSummaryRequestObject) (DraftMetricSummaryResponseObject, error) {
	p, err := tenantAdmin(ctx)
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
	if err := pr.err(); err != nil {
		return nil, err
	}
	if err := s.draftSlot(ctx, *p.Tenant, sc.ID, req.Metric, per); err != nil {
		return nil, err
	}
	d := domain.AssistantDraft{UserID: p.UserID, Kind: domain.DraftKindMetricSummary, ScorecardID: sc.ID, MetricKey: req.Metric, Period: per.String()}
	d, err = s.startDraft(ctx, p, d, msgStillDraftingExecSummary)
	if err != nil {
		return nil, err
	}
	return DraftMetricSummary202JSONResponse(apiMetricSummaryDraft(d, d.CreatedAt)), nil
}

// GetMetricSummaryDraft returns one of the calling admin's exec summary
// drafts of the metric and period in the path.
func (s *Server) GetMetricSummaryDraft(ctx context.Context, req GetMetricSummaryDraftRequestObject) (GetMetricSummaryDraftResponseObject, error) {
	p, err := tenantAdmin(ctx)
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
	if err := pr.err(); err != nil {
		return nil, err
	}
	now := s.now()
	d, err := s.store.GetDraft(ctx, p.Tenant.ID, p.UserID, req.Id)
	if errors.Is(err, store.ErrNotFound) || err == nil && (d.DraftKind() != domain.DraftKindMetricSummary ||
		d.ScorecardID != sc.ID || d.MetricKey != req.Metric || d.Period != per.String() || draftExpired(d, now)) {
		return nil, notFound("no such draft")
	}
	if err != nil {
		return nil, err
	}
	return GetMetricSummaryDraft200JSONResponse(apiMetricSummaryDraft(d, now)), nil
}

// MetricSummaryDraftData implements assistant.MetricSummarySource: the
// metric's company standing for the period, the company cell's attribution
// and its worst contributors' (spec §9.5: attribution at full for the
// company cell and its worst children), and the current summary, as p may
// read them. store.ErrNotFound when the scorecard, the metric or the company
// is gone.
func (s *Server) MetricSummaryDraftData(ctx context.Context, p auth.Principal, scorecardID, metric, per string) (assistant.MetricSummaryData, error) {
	if p.Tenant == nil || p.Membership == nil {
		return assistant.MetricSummaryData{}, errors.New("httpapi: an exec summary draft needs a member")
	}
	sc, err := s.store.GetScorecard(ctx, p.Tenant.ID, scorecardID)
	if err != nil {
		return assistant.MetricSummaryData{}, err
	}
	q, err := period.Parse(per)
	if err != nil {
		return assistant.MetricSummaryData{}, fmt.Errorf("httpapi: an exec summary draft needs a period, not %q", per)
	}
	e, err := s.newExplainer(ctx, p, sc.ID, []period.Period{q}, explainOpts{})
	if err != nil {
		return assistant.MetricSummaryData{}, err
	}
	month, ok := lastMonth(e.in.Cal, q)
	root := reportRoot(e.in, month)
	if !ok || root == "" {
		return assistant.MetricSummaryData{}, store.ErrNotFound
	}
	sum, err := e.summary(metric, q, true)
	if err != nil {
		return assistant.MetricSummaryData{}, notFoundAsStore(err)
	}
	a, err := e.attribution(metric, root, q, depthFull, attributionCursors{})
	if err != nil {
		return assistant.MetricSummaryData{}, notFoundAsStore(err)
	}
	label := scaleLabelOf(e.base.scale)
	out := assistant.MetricSummaryData{
		Organization: p.Tenant.Name, ScorecardName: sc.Name, Metric: sum.MetricName,
		Period: q.String(), PeriodLabel: draftPeriodLabel(e.in.Cal, q),
		Standing: sum.Standing.Display, Threshold: a.Gap.Detail, Headline: sum.Standing.Headline,
	}
	if ev, ok := draftEvidence("the company", a); ok {
		out.Evidence = append(out.Evidence, ev)
	}
	for _, c := range a.Children {
		out.Contributors = append(out.Contributors, assistant.DraftContributor{
			Name: c.SubjectName, Standing: strings.TrimSpace(c.Display + " " + label(c.Status)), Impact: c.ImpactDisplay, Line: c.AttributionLine,
		})
		ca, err := e.attribution(metric, c.SubjectId, q, depthSummary, attributionCursors{})
		if err != nil {
			return assistant.MetricSummaryData{}, err
		}
		if ev, ok := draftEvidence(c.SubjectName, ca); ok {
			out.Evidence = append(out.Evidence, ev)
		}
	}
	for _, l := range sum.Links {
		out.LinkTitles = append(out.LinkTitles, l.Title)
	}
	if sum.Text != nil {
		out.Current = *sum.Text
	}
	return out, nil
}

// draftEvidence is a cell's attribution as a draft reads it; ok is false
// when the cell has nothing to explain.
func draftEvidence(scope string, a CellAttribution) (assistant.DraftEvidence, bool) {
	if a.Attribution != CellAttributionAttributionAvailable {
		return assistant.DraftEvidence{}, false
	}
	ev := assistant.DraftEvidence{Scope: scope, Headline: a.Gap.Headline, IncidentsTotal: a.IncidentsTotal, RecordsTotal: a.RecordsTotal}
	for _, in := range a.Incidents {
		ev.Incidents = append(ev.Incidents, assistant.DraftIncident{
			Key: in.Key, Title: in.Title, Severity: in.Severity, Minutes: in.CountedDisplay, Points: in.PointsDisplay, Notes: in.Notes,
		})
	}
	for _, r := range a.Records {
		dr := assistant.DraftRecord{Key: r.Contribution.ExternalId, Title: r.Contribution.Title, Note: r.Note}
		if r.ImpactDisplay != nil {
			dr.Impact = *r.ImpactDisplay
		}
		ev.Records = append(ev.Records, dr)
	}
	if a.RecordsSummary != nil {
		ev.RecordsSummary = *a.RecordsSummary
	}
	if a.Unexplained != nil {
		ev.Unexplained = a.Unexplained.Display
	}
	if a.Excess != nil {
		ev.Excess = a.Excess.Display
	}
	return ev, true
}

// draftPeriodLabel names a period by its calendar months: "October 2026",
// or "July 2026 to September 2026" for a coarse period.
func draftPeriodLabel(cal period.Calendar, p period.Period) string {
	start := cal.Start(p).Format("January 2006")
	if p.Grain == period.Month {
		return start
	}
	if last, ok := lastMonth(cal, p); ok {
		return start + " to " + cal.Start(last).Format("January 2006")
	}
	return start
}

// notFoundAsStore turns a 404 from the explainer (the metric is gone) into
// store.ErrNotFound, which a draft reports as such.
func notFoundAsStore(err error) error {
	var ae *apiError
	if errors.As(err, &ae) && ae.status == http.StatusNotFound {
		return fmt.Errorf("%w: %s", store.ErrNotFound, ae.message)
	}
	return err
}
