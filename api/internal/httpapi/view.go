package httpapi

import (
	"context"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
)

// Limits of a scorecard view request (see the spec).
const (
	maxViewPeriods  = 24
	maxViewYTD      = 2
	maxViewSubjects = 200
)

// apiOverride converts a stored override.
func apiOverride(o domain.Override) Override {
	return Override{
		MetricKey: o.MetricKey,
		SubjectId: o.SubjectID,
		Period:    periodString(o.Period),
		Value:     o.Value,
		Status:    o.Status,
		Reason:    o.Reason,
		By:        o.By,
		At:        o.At,
	}
}

// apiCell converts an engine cell. Everything the contract marks required is
// non-null: components is {} and coverage a two-element array even for blank
// cells.
func apiCell(c engine.Cell) Cell {
	out := Cell{
		MetricKey:  c.MetricKey,
		SubjectId:  c.SubjectID,
		Period:     periodString(c.Period),
		Ytd:        c.YTD,
		Value:      c.Value,
		Display:    c.Display,
		Status:     c.Status,
		NaReason:   c.NAReason,
		Components: make(map[string]float64, len(c.Components)),
		Coverage:   []int{c.Coverage[0], c.Coverage[1]},
		Change:     c.Change,
		ChangeKind: c.ChangeKind,
		Target:     c.Target,
		VersionId:  c.VersionID,
	}
	for k, v := range c.Components {
		out.Components[k] = v
	}
	if c.Override != nil {
		o := apiOverride(*c.Override)
		out.Override = &o
	}
	if c.Computed != nil {
		out.Computed = &CellComputed{Value: c.Computed.Value, Status: c.Computed.Status}
	}
	return out
}

// apiView converts an engine view, keeping only the rows keep accepts (all
// rows when keep is nil).
func apiView(v engine.View, keep func(engine.Row) bool) ScorecardView {
	out := ScorecardView{
		Periods:         make([]Period, 0, len(v.Periods)),
		Ytd:             make([]MonthPeriod, 0, len(v.YTD)),
		Categories:      make([]Category, 0, len(v.Categories)),
		Rows:            make([]ViewRow, 0, len(v.Rows)),
		VersionByPeriod: make(map[string]ServerId, len(v.VersionByPeriod)),
	}
	for _, p := range v.Periods {
		out.Periods = append(out.Periods, p.String())
	}
	for _, p := range v.YTD {
		out.Ytd = append(out.Ytd, p.String())
	}
	for _, c := range v.Categories {
		out.Categories = append(out.Categories, Category{Id: c.ID, Name: c.Name, Order: c.Order})
	}
	for k, id := range v.VersionByPeriod {
		out.VersionByPeriod[k] = id
	}
	for _, r := range v.Rows {
		if keep != nil && !keep(r) {
			continue
		}
		row := ViewRow{
			MetricKey:   r.MetricKey,
			MetricName:  r.MetricName,
			CategoryId:  r.CategoryID,
			SubjectId:   r.SubjectID,
			SubjectName: r.SubjectName,
			Format:      MetricFormat(r.Format),
			Depth:       r.Depth,
			Direction:   Direction(r.Direction),
			Cells:       make([]Cell, 0, len(r.Cells)),
		}
		for _, c := range r.Cells {
			row.Cells = append(row.Cells, apiCell(c))
		}
		out.Rows = append(out.Rows, row)
	}
	return out
}

// GetScorecardView computes the scorecard table. Viewers see only the rows
// whose subject and metric are in their scope.
func (s *Server) GetScorecardView(ctx context.Context, req GetScorecardViewRequestObject) (GetScorecardViewResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}

	var pr problems
	vr := engine.ViewRequest{Structure: engine.StructureAsOf}
	params := req.Params
	if params.Periods != nil {
		if len(*params.Periods) > maxViewPeriods {
			pr.add("periods", "at most %d periods", maxViewPeriods)
		}
		for i, v := range *params.Periods {
			if q, ok := parsePeriod(&pr, indexPath("periods", i), v); ok {
				vr.Periods = append(vr.Periods, q)
			}
		}
	}
	if params.Ytd != nil {
		if len(*params.Ytd) > maxViewYTD {
			pr.add("ytd", "at most %d year-to-date columns", maxViewYTD)
		}
		for i, v := range *params.Ytd {
			q, ok := parsePeriod(&pr, indexPath("ytd", i), v)
			if !ok {
				continue
			}
			if q.Grain != period.Month {
				pr.add(indexPath("ytd", i), "must be a month such as 2026-M07")
				continue
			}
			vr.YTD = append(vr.YTD, q)
		}
	}
	if len(vr.Periods)+len(vr.YTD) == 0 && len(pr.list) == 0 {
		pr.add("periods", "at least one column is required in periods or ytd")
	}
	if params.Subjects != nil {
		if len(*params.Subjects) > maxViewSubjects {
			pr.add("subjects", "at most %d subjects", maxViewSubjects)
		}
		for i, id := range *params.Subjects {
			if !validID(id) {
				pr.add(indexPath("subjects", i), "%s", idRule)
				continue
			}
			vr.SubjectIDs = append(vr.SubjectIDs, id)
		}
	}
	if params.Structure != nil {
		switch st := string(*params.Structure); st {
		case engine.StructureAsOf, engine.StructureCurrent:
			vr.Structure = st
		default:
			pr.add("structure", "must be %q or %q", engine.StructureAsOf, engine.StructureCurrent)
		}
	}
	if params.Restate != nil {
		vr.Restate = *params.Restate
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	cols := append(append([]period.Period{}, vr.Periods...), vr.YTD...)
	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, fiscalYears(true, cols...))
	if err != nil {
		return nil, err
	}
	if vr.Restate != "" {
		found := false
		for _, v := range in.Versions {
			if v.ID == vr.Restate {
				found = true
				break
			}
		}
		if !found {
			return nil, badRequest("request validation failed", detail{Path: "restate", Message: "not a methodology version of this scorecard"})
		}
	}
	view, err := engine.Compute(in, vr)
	if err != nil {
		return nil, err
	}

	// Scope is evaluated as of the latest month the view shows.
	var asOf period.Period
	for _, c := range cols {
		if m, ok := lastMonth(in.Cal, c); ok && (asOf == (period.Period{}) || monthBefore(asOf, m)) {
			asOf = m
		}
	}
	acc := newAccess(p, in)
	return GetScorecardView200JSONResponse(apiView(view, func(r engine.Row) bool {
		return acc.canRead(r.SubjectID, []string{r.MetricKey}, asOf)
	})), nil
}
