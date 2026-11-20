package httpapi

import (
	"context"
	"log/slog"
	"math"
	"slices"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/rca"
	"opsvision/internal/records"
)

// incidentLinks are, per metric of one scorecard, the explain links of the
// tenant's record types that name it.
type incidentLinks map[string][]domain.ExplainLink

// downtime reports whether a link explains metric's downtime, and the down
// measure of the first downtime link that names one.
func (l incidentLinks) downtime(metric string) (linked bool, downMeasure string) {
	for _, x := range l[metric] {
		if x.Mode == domain.ExplainDowntime {
			linked = true
			if downMeasure == "" {
				downMeasure = x.DownMeasure
			}
		}
	}
	return linked, downMeasure
}

// loadIncidents returns the incidents of every record type whose explain
// links name one of metricKeys of scorecard sc, by metric and then by the
// subject they resolve to, each filtered by its link's where and clipped
// by its own source's cutoff (the source's latest snapshot as-of plus 24
// hours). Revisions of unstored snapshots are ignored, as derivation
// ignores them; cancelled incidents are kept for the arithmetic to drop.
func (s *Server) loadIncidents(ctx context.Context, tenantID, sc string, metricKeys []string) (map[string]map[string][]rca.Incident, error) {
	tenant, err := s.store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	in, err := s.loadInput(ctx, tenant, sc, nil)
	if err != nil {
		return nil, err
	}
	out, _, err := s.incidentsFor(ctx, tenantID, sc, metricKeys, in)
	return out, err
}

// incidentsFor is loadIncidents over an engine input already loaded for the
// request, returning the links it read as well.
func (s *Server) incidentsFor(ctx context.Context, tenantID, sc string, metricKeys []string, in *engine.Input) (map[string]map[string][]rca.Incident, incidentLinks, error) {
	out := map[string]map[string][]rca.Incident{}
	links := incidentLinks{}
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	var res *records.Resolver
	for _, rt := range types {
		type link struct {
			domain.ExplainLink
			cond *records.Cond
		}
		var ls []link
		for _, l := range rt.Explains {
			if l.ScorecardID != sc || !slices.Contains(metricKeys, l.MetricKey) {
				continue
			}
			cond, err := records.CompileWhere(l.Where, rt)
			if err != nil {
				// Checked on save; a later edit of the type can still break it.
				slog.Warn("httpapi: an explain link's condition does not compile", "tenant", tenantID, "recordType", rt.ID, "metric", l.MetricKey, "err", err)
				continue
			}
			ls = append(ls, link{l, cond})
			links[l.MetricKey] = append(links[l.MetricKey], l)
		}
		if len(ls) == 0 {
			continue
		}
		snaps, err := s.store.ListSnapshots(ctx, tenantID, rt.ID)
		if err != nil {
			return nil, nil, err
		}
		stored := make(map[string]bool, len(snaps))
		cutoff := map[string]time.Time{}
		for _, sn := range snaps { // newest first
			stored[sn.ID] = true
			if _, ok := cutoff[sn.Source]; !ok && !sn.AsOf.IsZero() {
				cutoff[sn.Source] = rca.Cutoff(sn.AsOf)
			}
		}
		recs, err := s.store.ListRecords(ctx, tenantID, rt.ID)
		if err != nil {
			return nil, nil, err
		}
		if res == nil {
			res = records.NewResolver(records.DeriveInput{Cal: in.Cal, Tree: in.Tree, Items: in.Items})
		}
		for _, r := range recs {
			kept := r.Revisions[:0:0]
			for _, rv := range r.Revisions {
				if stored[rv.SnapshotID] {
					kept = append(kept, rv)
				}
			}
			if len(kept) == 0 {
				continue
			}
			r.Revisions = kept
			f := records.Latest(r)
			inc, err := rca.FromRecord(r.Source, r.ExternalID, f, cutoff[r.Source])
			if err != nil {
				continue // a mistyped date-time is no incident
			}
			at := f.CreatedAt.Time
			if inc.Start != nil {
				at = *inc.Start
			}
			subject, problem := res.Resolve(f.SubjectKey, in.Cal.MonthOf(at))
			if problem != "" {
				continue
			}
			inc.SubjectID = subject
			for _, l := range ls {
				if ok, err := l.cond.Match(f); err != nil || !ok {
					continue
				}
				if out[l.MetricKey] == nil {
					out[l.MetricKey] = map[string][]rca.Incident{}
				}
				out[l.MetricKey][subject] = append(out[l.MetricKey][subject], inc)
			}
		}
	}
	return out, links, nil
}

// cellBasis is what a note on one cell is written against: the cell's
// displayed value and status, the incidents counted in it (sorted
// "source:externalId", over the leaves below a roll-up that p may read),
// and, for a downtime metric, the reported downtime in whole minutes: the
// link's down measure converted by its unit, else derived from the
// displayed value.
func (s *Server) cellBasis(ctx context.Context, p auth.Principal, sc, metric, subject string, per period.Period) (domain.RCABasis, error) {
	in, err := s.loadInput(ctx, *p.Tenant, sc, fiscalYears(true, per))
	if err != nil {
		return domain.RCABasis{}, err
	}
	v, ok := engine.VersionFor(in.Versions, per, in.Cal)
	if !ok {
		return domain.RCABasis{}, notFound("no methodology version is in force for " + per.String())
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if mi < 0 {
		return domain.RCABasis{}, notFound("metric " + metric + " is not in the methodology in force for " + per.String())
	}
	m := v.Content.Metrics[mi]
	view, err := engine.Compute(in, engine.ViewRequest{
		Periods: []period.Period{per}, SubjectIDs: []string{subject}, MetricKeys: []string{metric}, Structure: engine.StructureAsOf,
	})
	if err != nil {
		return domain.RCABasis{}, err
	}
	var cell *engine.Cell
	for _, r := range view.Rows {
		if r.MetricKey == metric && r.SubjectID == subject && len(r.Cells) > 0 {
			cell = &r.Cells[0]
		}
	}
	if cell == nil {
		return domain.RCABasis{}, notFound(metric + " is not shown for " + subject + " in " + per.String())
	}
	basis := domain.RCABasis{Display: cell.Display, Status: cell.Status, Evidence: []string{}}

	byMetric, links, err := s.incidentsFor(ctx, p.Tenant.ID, sc, []string{metric}, in)
	if err != nil {
		return domain.RCABasis{}, err
	}
	linked, downMeasure := links.downtime(metric)
	w := rca.PeriodWindow(in.Cal, per, time.UTC)
	if (linked || engine.ChartKind(m) == "uptime") && cell.Value != nil {
		if mins, ok := reportedMinutes(v, m, *cell, downMeasure, w.Minutes()); ok {
			basis.ReportedMinutes = &mins
		}
	}

	if incs := byMetric[metric]; len(incs) > 0 {
		acc := newAccess(p, in)
		month, _ := lastMonth(in.Cal, per)
		seen := map[string]bool{}
		for _, id := range cellSubjects(in, subject, month, true) {
			if len(incs[id]) == 0 || !acc.canRead(id, []string{metric}, month) {
				continue
			}
			for _, c := range rca.CountDowntime(w, w.Minutes(), 0, incs[id]).Items {
				if linked && c.Minutes <= 0 {
					continue // a downtime link counts minutes; a list link lists
				}
				seen[c.Incident.Source+":"+c.Incident.ExternalID] = true
			}
		}
		for k := range seen {
			basis.Evidence = append(basis.Evidence, k)
		}
		slices.Sort(basis.Evidence)
	}
	return basis, nil
}

// reportedMinutes is a downtime cell's reported downtime in whole minutes:
// the down measure from the cell's components, converted by the measure's
// unit (s, min or h), when the link names one the cell has; else the
// displayed gap to 100% as a share of the period.
func reportedMinutes(v domain.MethodologyVersion, m domain.Metric, c engine.Cell, downMeasure string, periodMinutes float64) (int, bool) {
	if raw, ok := c.Components[downMeasure]; ok && downMeasure != "" {
		i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == downMeasure })
		if i >= 0 {
			switch v.Content.Measures[i].Unit {
			case "s":
				return int(math.Round(raw / 60)), true
			case "min":
				return int(math.Round(raw)), true
			case "h":
				return int(math.Round(raw * 60)), true
			}
		}
	}
	d := rca.Decimals(m.Format)
	units, ok := rca.GapUnits(100, c.Display, d)
	if !ok || units < 0 {
		return 0, false
	}
	return int(math.Round(float64(units) / math.Pow10(d) / 100 * periodMinutes)), true
}
