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

// rcaForbidden is the 403 of an RCA write outside the caller's reach.
const rcaForbidden = "You can write RCAs only for your own units."

// Audit of RCA notes.
const (
	auditRCA        = "rca"
	auditRCACreate  = "create"
	auditRCAUpdate  = "update"
	auditRCAConfirm = "confirm"
	auditRCADelete  = "delete"
)

func rcaAuditID(metric, subject string, p period.Period) string {
	return metric + "|" + subject + "|" + p.String()
}

func apiRcaLinks(ls []domain.RCALink) []RcaLink {
	out := make([]RcaLink, 0, len(ls))
	for _, l := range ls {
		out = append(out, RcaLink{Title: l.Title, Url: l.URL})
	}
	return out
}

func apiRcaNote(r domain.CellRCA) RcaNote {
	return RcaNote{
		Text: r.Text, Links: apiRcaLinks(r.Links), AuthorId: r.AuthorID, AuthorName: r.AuthorName,
		Channel: RcaNoteChannel(r.Channel), UpdatedAt: r.UpdatedAt, Revision: r.Revision,
	}
}

// rcaConflict is the 409 body of a stale write: the note as stored now, if any.
func (s *Server) rcaConflict(ctx context.Context, tenantID, sc, metric, subject string, p period.Period) (CellRcaConflict, error) {
	out := CellRcaConflict{}
	out.Error.Code = CellRcaConflictErrorCode(codeConflict)
	out.Error.Message = "Someone else changed this RCA while you were editing."
	cur, err := s.store.GetRCA(ctx, tenantID, sc, metric, subject, p)
	switch {
	case err == nil:
		note := apiRcaNote(cur)
		out.Current = &note
	case !errors.Is(err, store.ErrNotFound):
		return out, err
	}
	return out, nil
}

// rcaCell checks that a cell exists in the methodology in force for its
// period, at the metric's own grain, and that p may write it. A caller
// whose role cannot write data, or who may not write this cell, gets the
// RCA 403.
func (s *Server) rcaCell(ctx context.Context, p auth.Principal, sc, metric, subject string, per period.Period) error {
	if dataWriter(p) != nil {
		return forbidden(rcaForbidden)
	}
	in, err := s.loadInput(ctx, *p.Tenant, sc, nil)
	if err != nil {
		return err
	}
	acc := newAccess(p, in)
	var pr problems
	if _, ok := acc.unitOf(subject); !ok {
		pr.add("subject", "%q is not an org unit or tracked item", subject)
	}
	v, ok := engine.VersionFor(in.Versions, per, in.Cal)
	if !ok {
		pr.add("period", "no methodology version is in force for %s", per)
		return pr.err()
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if mi < 0 {
		pr.add("metric", "metric %q is not in the methodology in force for %s", metric, per)
	} else if g, ok := frequencyGrain(v.Content.Metrics[mi].Frequency); ok && g != per.Grain {
		pr.add("period", "%s is reported for whole %s periods", metric, grainName(g))
	}
	if err := pr.err(); err != nil {
		return err
	}
	month, _ := lastMonth(in.Cal, per)
	if !acc.canWrite(subject, []string{metric}, month) {
		return forbidden(rcaForbidden)
	}
	return nil
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

// PutCellRca writes or updates one cell's RCA note, storing the cell's
// current basis with it. Saving the same text and links is a confirm.
func (s *Server) PutCellRca(ctx context.Context, req PutCellRcaRequestObject) (PutCellRcaResponseObject, error) {
	p, err := member(ctx)
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
	pr.key("metric", b.Metric)
	pr.id("subject", b.Subject)
	per, _ := parsePeriod(&pr, "period", b.Period)
	if b.ExpectedRevision < 0 {
		pr.add("expectedRevision", "must be 0 or greater")
	}
	note := domain.CellRCA{Text: b.Text, Links: make([]domain.RCALink, 0, len(b.Links))}
	for _, l := range b.Links {
		note.Links = append(note.Links, domain.RCALink{Title: l.Title, URL: l.Url})
	}
	for _, e := range note.Validate() {
		pr.add(e.Path, "%s", e.Message)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	if err := s.rcaCell(ctx, p, sc.ID, b.Metric, b.Subject, per); err != nil {
		return nil, err
	}
	basis, err := s.cellBasis(ctx, p, sc.ID, b.Metric, b.Subject, per)
	var ae *apiError
	if errors.As(err, &ae) && ae.code == codeNotFound {
		return nil, badRequest("request validation failed", detail{Path: "subject", Message: ae.message})
	} else if err != nil {
		return nil, err
	}

	before, err := s.store.GetRCA(ctx, tenantID, sc.ID, b.Metric, b.Subject, per)
	exists := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	now := s.now()
	note.ScorecardID, note.MetricKey, note.SubjectID, note.Period = sc.ID, b.Metric, b.Subject, per
	note.AuthorID, note.AuthorName, note.Channel = p.UserID, cmp.Or(p.Membership.Name, p.Name), domain.RCAChannel(p.Channel)
	note.CreatedAt, note.UpdatedAt, note.Basis = now, now, basis
	if exists && b.ExpectedRevision > 0 {
		note.CreatedAt = before.CreatedAt
	}
	note = note.Normalize()
	stored, err := s.store.PutRCA(ctx, tenantID, note, b.ExpectedRevision)
	if errors.Is(err, store.ErrConflict) {
		c, err := s.rcaConflict(ctx, tenantID, sc.ID, b.Metric, b.Subject, per)
		if err != nil {
			return nil, err
		}
		return PutCellRca409JSONResponse(c), nil
	}
	if err != nil {
		return nil, err
	}

	action, auditBefore := auditRCACreate, any(nil)
	if b.ExpectedRevision > 0 {
		action, auditBefore = auditRCAUpdate, before
		if before.Text == stored.Text && slices.Equal(before.Links, stored.Links) {
			action = auditRCAConfirm
		}
	}
	if err := s.audit(ctx, p, tenantID, action, auditRCA, rcaAuditID(b.Metric, b.Subject, per), auditBefore, stored); err != nil {
		return nil, err
	}
	return PutCellRca200JSONResponse(apiRcaNote(stored)), nil
}

// DeleteCellRca removes one cell's RCA note. Who may delete is who may write
// it; the audit entry keeps the text.
func (s *Server) DeleteCellRca(ctx context.Context, req DeleteCellRcaRequestObject) (DeleteCellRcaResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	q := req.Params
	var pr problems
	pr.key("metric", q.Metric)
	pr.id("subject", q.Subject)
	per, _ := parsePeriod(&pr, "period", q.Period)
	if q.ExpectedRevision < 1 {
		pr.add("expectedRevision", "must be 1 or greater")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	if err := s.rcaCell(ctx, p, sc.ID, q.Metric, q.Subject, per); err != nil {
		return nil, err
	}
	before, err := s.store.GetRCA(ctx, tenantID, sc.ID, q.Metric, q.Subject, per)
	if errors.Is(err, store.ErrNotFound) {
		return nil, notFound("this cell has no RCA")
	} else if err != nil {
		return nil, err
	}
	switch err := s.store.DeleteRCA(ctx, tenantID, sc.ID, q.Metric, q.Subject, per, q.ExpectedRevision); {
	case errors.Is(err, store.ErrConflict):
		c, err := s.rcaConflict(ctx, tenantID, sc.ID, q.Metric, q.Subject, per)
		if err != nil {
			return nil, err
		}
		return DeleteCellRca409JSONResponse(c), nil
	case errors.Is(err, store.ErrNotFound):
		return nil, notFound("this cell has no RCA")
	case err != nil:
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, auditRCADelete, auditRCA, rcaAuditID(q.Metric, q.Subject, per), before, nil); err != nil {
		return nil, err
	}
	return DeleteCellRca204Response{}, nil
}
