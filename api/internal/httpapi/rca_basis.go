package httpapi

import (
	"context"
	"log/slog"
	"math"
	"slices"
	"strings"
	"time"

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

// compiledLink is an explain link with its where condition compiled.
type compiledLink struct {
	domain.ExplainLink
	cond *records.Cond
}

// linksOf returns record type rt's explain links that name one of
// metricKeys of scorecard sc (every metric when metricKeys is nil), with
// their conditions compiled. A link whose condition no longer compiles is
// skipped with a warning.
func linksOf(tenantID, sc string, rt domain.RecordType, metricKeys []string) []compiledLink {
	var out []compiledLink
	for _, l := range rt.Explains {
		if l.ScorecardID != sc || (metricKeys != nil && !slices.Contains(metricKeys, l.MetricKey)) {
			continue
		}
		cond, err := records.CompileWhere(l.Where, rt)
		if err != nil {
			// Checked on save; a later edit of the type can still break it.
			slog.Warn("httpapi: an explain link's condition does not compile", "tenant", tenantID, "recordType", rt.ID, "metric", l.MetricKey, "err", err)
			continue
		}
		out = append(out, compiledLink{l, cond})
	}
	return out
}

// explainLinks reads the explain links of scorecard sc from the tenant's
// record types, without their records.
func (s *Server) explainLinks(ctx context.Context, tenantID, sc string) (incidentLinks, error) {
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	out := incidentLinks{}
	for _, rt := range types {
		for _, l := range linksOf(tenantID, sc, rt, nil) {
			out[l.MetricKey] = append(out[l.MetricKey], l.ExplainLink)
		}
	}
	return out, nil
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
		ls := linksOf(tenantID, sc, rt, metricKeys)
		for _, l := range ls {
			links[l.MetricKey] = append(links[l.MetricKey], l.ExplainLink)
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

// summaryContext is what judging the metrics of one scorecard at company
// scope needs beyond a computed view: the company root, how deep each level
// sits, the subject nouns, the tenant's scale and the explain links.
type summaryContext struct {
	in        *engine.Input
	root      string
	levels    []domain.Level
	depth     map[string]int
	levelName map[string]string
	kindName  map[string]string
	scale     []domain.StatusLevel
	links     incidentLinks
}

func (s *Server) newSummaryContext(ctx context.Context, tenant domain.Tenant, sc string, in *engine.Input, root string) (*summaryContext, error) {
	levels, err := s.store.ListLevels(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	kinds, err := s.store.ListItemKinds(ctx, tenant.ID)
	if err != nil {
		return nil, err
	}
	links, err := s.explainLinks(ctx, tenant.ID, sc)
	if err != nil {
		return nil, err
	}
	c := &summaryContext{in: in, root: root, levels: levels, depth: map[string]int{}, levelName: map[string]string{}, kindName: map[string]string{},
		scale: statusScale(tenant), links: links}
	for _, l := range levels {
		c.depth[l.ID], c.levelName[l.ID] = l.Depth, l.Name
	}
	for _, k := range kinds {
		c.kindName[k.ID] = k.Name
	}
	return c, nil
}

// summaryFacts is one metric-month's company standing.
type summaryFacts struct {
	metric   domain.Metric
	period   period.Period
	in       rca.SummaryInput
	req      rca.Requirement
	standing MetricSummaryStanding
	// subjects are the "subject:{id}" evidence keys of the reporting
	// subjects short of perfect, sorted.
	subjects []string
	// reportedMinutes is the company cell's reported downtime, for a
	// downtime metric with a company value.
	reportedMinutes *int
	// rowSubjects are the subjects the metric has rows for.
	rowSubjects map[string]bool
}

// basis is the summary basis the facts give, with incident evidence keys
// (sorted "source:externalId") after the subjects.
func (f summaryFacts) basis(incidents []string) domain.RCABasis {
	return domain.RCABasis{Display: f.standing.Display, Status: f.standing.Status,
		Evidence: capEvidence(f.subjects, incidents), ReportedMinutes: f.reportedMinutes}
}

// facts judges metric m at company scope from the rows of a view (column
// col holds the metric's period per). coarse and closes are as in
// rca.SummaryInput.
func (c *summaryContext) facts(v domain.MethodologyVersion, m domain.Metric, per period.Period, rows []engine.Row, col int, coarse, closes bool) summaryFacts {
	in := rca.SummaryInput{Metric: m, CompanyRule: m.Rule, Scale: c.scale, Coarse: coarse, ClosesInMonth: closes, Noun: c.noun(m),
		ComparedLabel: comparedLabel(c.in.Cal, m.Rule, per)}
	var company *engine.Cell
	rowSubjects := map[string]bool{}
	for i := range rows {
		r := &rows[i]
		if r.MetricKey != m.Key || col >= len(r.Cells) {
			continue
		}
		rowSubjects[r.SubjectID] = true
		cell := r.Cells[col]
		rule := m.Rule
		if cell.Rule.Type != "" {
			rule = cell.Rule
		}
		facts := rca.CellFacts{Display: cell.Display, Status: cell.Status, Value: cell.Value, Components: cell.Components, Change: cell.Change}
		isItem := r.SubjectKind == engine.SubjectItem
		if !isItem && r.SubjectID == c.root {
			company = &r.Cells[col]
			in.Company, in.CompanyRule = &facts, rule
		}
		d := -1
		if u, ok := c.in.Tree.Unit(r.SubjectID); ok && !isItem {
			if ld, ok := c.depth[u.LevelID]; ok {
				d = ld
			}
		}
		if rca.IsReportingSubject(m, c.levels, d, isItem) {
			in.Reporting = append(in.Reporting, rca.SubjectFacts{ID: r.SubjectID, Name: r.SubjectName, Cell: facts, Rule: rule})
		}
	}
	f := summaryFacts{metric: m, period: per, in: in, req: rca.SummaryRequired(in), rowSubjects: rowSubjects}
	f.standing.Display, f.standing.Status = rca.CompanyStanding(in)
	f.standing.Headline = rca.CompanyHeadline(in)
	f.subjects = []string{}
	for _, id := range rca.SubjectsShort(in) {
		f.subjects = append(f.subjects, "subject:"+id)
	}
	slices.Sort(f.subjects)
	if linked, downMeasure := c.links.downtime(m.Key); company != nil && company.Value != nil && (linked || engine.ChartKind(m) == "uptime") {
		w := rca.PeriodWindow(c.in.Cal, per, time.UTC)
		if mins, ok := reportedMinutes(v, m, *company, downMeasure, w.Minutes()); ok {
			f.reportedMinutes = &mins
		}
	}
	return f
}

// comparedLabel names what a change rule compares period per with: the
// month before (Sep), the period before, last year's average or the
// baseline. Empty for other rules.
func comparedLabel(cal period.Calendar, rule domain.StatusRule, per period.Period) string {
	if rule.Type != domain.RuleChange {
		return ""
	}
	switch rule.Compare {
	case domain.ComparePriorPeriod:
		prev := cal.Prev(per)
		if per.Grain == period.Month {
			return cal.Start(prev).Format("Jan")
		}
		return prev.String()
	case domain.ComparePriorYearAverage:
		return "last year's average"
	case domain.CompareBaseline:
		return "the baseline"
	}
	return ""
}

// noun is the noun of metric m's reporting subjects: its item kind's name,
// or its deepest reported level's.
func (c *summaryContext) noun(m domain.Metric) rca.NounForms {
	depth, level := -1, ""
	for _, s := range m.ReportedAt {
		if s.Kind == domain.SubjectItemKind {
			return rca.Nouns(c.kindName[s.ID], "item")
		}
		for _, l := range c.levels {
			if l.ID == s.ID && l.Depth > depth {
				depth, level = l.Depth, l.ID
			}
		}
	}
	return rca.Nouns(c.levelName[level], "unit")
}

// incidentEvidence is the sorted "source:externalId" of the incidents that
// count in the facts' metric and period on the subjects the metric has rows
// for: with a downtime link those with counted minutes, with list links
// every one listed.
func (s *Server) incidentEvidence(ctx context.Context, tenantID, sc string, in *engine.Input, f summaryFacts) ([]string, error) {
	m, per := f.metric, f.period
	byMetric, links, err := s.incidentsFor(ctx, tenantID, sc, []string{m.Key}, in)
	if err != nil {
		return nil, err
	}
	incs := byMetric[m.Key]
	out := []string{}
	if len(incs) == 0 {
		return out, nil
	}
	linked, _ := links.downtime(m.Key)
	w := rca.PeriodWindow(in.Cal, per, time.UTC)
	seen := map[string]bool{}
	for id := range f.rowSubjects {
		for _, c := range rca.CountDowntime(w, w.Minutes(), 0, incs[id]).Items {
			if linked && c.Minutes <= 0 {
				continue
			}
			seen[c.Incident.Source+":"+c.Incident.ExternalID] = true
		}
	}
	for k := range seen {
		out = append(out, k)
	}
	slices.Sort(out)
	return out, nil
}

// capEvidence joins subject and incident evidence keys, subjects first, and
// keeps at most domain.MaxRCAEvidence of them. It never returns nil.
func capEvidence(subjects, incidents []string) []string {
	out := make([]string, 0, min(len(subjects)+len(incidents), domain.MaxRCAEvidence))
	out = append(out, subjects[:min(len(subjects), domain.MaxRCAEvidence)]...)
	return append(out, incidents[:min(len(incidents), domain.MaxRCAEvidence-len(out))]...)
}

// subjectEvidence keeps the "subject:" keys of evidence.
func subjectEvidence(evidence []string) []string {
	out := []string{}
	for _, k := range evidence {
		if strings.HasPrefix(k, "subject:") {
			out = append(out, k)
		}
	}
	return out
}

// staleReasons compares a summary's stored basis with the current one: the
// value, status, incident and downtime sentences of rca.StaleReasons, and a
// change in which subjects are short of perfect.
func staleReasons(stored, current domain.RCABasis, label func(string) string) []string {
	withoutSubjects := func(b domain.RCABasis) domain.RCABasis {
		ev := []string{}
		for _, k := range b.Evidence {
			if !strings.HasPrefix(k, "subject:") {
				ev = append(ev, k)
			}
		}
		b.Evidence = ev
		return b
	}
	out := rca.StaleReasons(withoutSubjects(stored), withoutSubjects(current), label)
	const changed = "The attribution changed since it was written."
	if !slices.Equal(subjectEvidence(stored.Evidence), subjectEvidence(current.Evidence)) && !slices.Contains(out, changed) {
		out = append(out, changed)
	}
	if out == nil {
		out = []string{}
	}
	return out
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
