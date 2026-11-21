package httpapi

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/period"
	"opsvision/internal/rca"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
)

// explainDepth is how much the explainer computes for a cell: the summary
// state (standing, requirement, stale), the summary with its top evidence,
// or the full attribution.
type explainDepth int

const (
	depthState explainDepth = iota
	depthSummary
	depthFull
)

// Attribution pages and excerpts (spec §6.6, §9.2).
const (
	firstIncidents  = 5
	firstRecords    = 10
	attributionPage = 50
	maxChildren     = 3
	maxEvidence     = 5
	linksShown      = 3
	excerptRunes    = 60
)

// explainOpts reuse what the request already loaded and say how stale is
// judged. in must be the live (not restated) input; view, when set, a live,
// as-of view over in with every subject and metric.
type explainOpts struct {
	in   *engine.Input
	view *engine.View
	// noStale reads every stored summary as written (restated views).
	noStale bool
	// gate judges stale as the publish gate's cheap check does, from the
	// standing and subjects only, so nothing reads records.
	gate bool
}

// attributionCursors are the offsets of the incidents or records page asked
// for; both nil for the first page.
type attributionCursors struct {
	incidents, records *int
}

type colRef struct {
	rows []engine.Row
	col  int
}

type summaryKey struct {
	metric string
	p      period.Period
}

type factsKey struct {
	metric   string
	p, month period.Period
}

type deriveKey struct {
	version, measure string
	p                period.Period
}

// explainer answers attribution and exec summary questions for one request
// (spec §9.5): it loads the engine input and computes the view for its
// periods once, reads the summaries with one ListRCAsRange, loads incidents
// only for the metrics that need them, and derives records lazily, once per
// measure and period.
type explainer struct {
	s      *Server
	ctx    context.Context
	p      auth.Principal
	tenant domain.Tenant
	sc     string
	in     *engine.Input
	acc    *access
	opts   explainOpts
	admin  bool
	base   *summaryContext
	names  map[string]string

	cols      map[period.Period]colRef
	stored    map[summaryKey]domain.CellRCA
	facts     map[factsKey]summaryFacts
	incidents map[string]map[string][]rca.Incident
	loaded    map[string]bool
	din       *records.DeriveInput
	derived   map[deriveKey][]records.Derived
}

// newExplainer prepares the explainer for periods (months, or coarse
// periods) of scorecard sc, as read by p.
func (s *Server) newExplainer(ctx context.Context, p auth.Principal, sc string, periods []period.Period, opts explainOpts) (*explainer, error) {
	if p.Tenant == nil {
		return nil, forbidden("this endpoint requires an organization")
	}
	e := &explainer{s: s, ctx: ctx, p: p, tenant: *p.Tenant, sc: sc, opts: opts, in: opts.in,
		cols: map[period.Period]colRef{}, stored: map[summaryKey]domain.CellRCA{}, facts: map[factsKey]summaryFacts{},
		incidents: map[string]map[string][]rca.Incident{}, loaded: map[string]bool{}, derived: map[deriveKey][]records.Derived{}}
	if e.in == nil {
		in, err := s.loadInput(ctx, e.tenant, sc, fiscalYears(true, periods...))
		if err != nil {
			return nil, err
		}
		e.in = in
	}
	e.acc = newAccess(p, e.in)
	e.admin = p.Membership != nil && auth.Can(p, auth.ActionTenantAdmin, auth.Resource{}, nil, period.Period{})
	e.names = map[string]string{}
	for _, id := range e.in.Tree.UnitIDs() {
		u, _ := e.in.Tree.Unit(id)
		e.names[id] = u.Name
	}
	for _, it := range e.in.Items {
		e.names[it.ID] = it.Name
	}

	need := e.needed(periods)
	if opts.view != nil {
		for i, q := range opts.view.Periods {
			if slices.Contains(need, q) {
				e.cols[q] = colRef{rows: opts.view.Rows, col: i}
			}
		}
	}
	if err := e.compute(need); err != nil {
		return nil, err
	}
	base, err := s.newSummaryContext(ctx, e.tenant, sc, e.in, "")
	if err != nil {
		return nil, err
	}
	e.base = base
	if len(need) > 0 {
		from, to := need[0], need[0]
		for _, q := range need {
			if first := e.in.Cal.Months(q); len(first) > 0 && monthBefore(first[0], e.in.Cal.Months(from)[0]) {
				from = q
			}
			if last, ok := lastMonth(e.in.Cal, q); ok {
				if cur, _ := lastMonth(e.in.Cal, to); monthBefore(cur, last) {
					to = q
				}
			}
		}
		rs, err := s.store.ListRCAsRange(ctx, e.tenant.ID, sc, from, to)
		if err != nil {
			return nil, err
		}
		for _, r := range rs {
			if last, ok := lastMonth(e.in.Cal, r.Period); ok && r.SubjectID == reportRoot(e.in, last) {
				e.stored[summaryKey{r.MetricKey, r.Period}] = r
			}
		}
	}
	return e, nil
}

// needed is periods plus, for each month, the coarse periods of the metrics
// in force that month (a quarterly metric's quarter), in a stable order.
func (e *explainer) needed(periods []period.Period) []period.Period {
	var out []period.Period
	add := func(q period.Period) {
		if !slices.Contains(out, q) {
			out = append(out, q)
		}
	}
	for _, q := range periods {
		add(q)
		if q.Grain != period.Month {
			continue
		}
		v, ok := engine.VersionFor(e.in.Versions, q, e.in.Cal)
		if !ok {
			continue
		}
		for _, m := range v.Content.Metrics {
			if g, ok := frequencyGrain(m.Frequency); ok && g != period.Month {
				add(e.in.Cal.Parent(q, g))
			}
		}
	}
	return out
}

// compute computes, in one view, the periods not yet computed.
func (e *explainer) compute(ps []period.Period) error {
	var missing []period.Period
	for _, q := range ps {
		if _, ok := e.cols[q]; !ok && !slices.Contains(missing, q) {
			missing = append(missing, q)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	v, err := engine.Compute(e.in, engine.ViewRequest{Periods: missing, Structure: engine.StructureAsOf})
	if err != nil {
		return err
	}
	for i, q := range missing {
		e.cols[q] = colRef{rows: v.Rows, col: i}
	}
	return nil
}

func (e *explainer) column(q period.Period) (colRef, error) {
	if err := e.compute([]period.Period{q}); err != nil {
		return colRef{}, err
	}
	return e.cols[q], nil
}

// ctxFor is the summary context with the company root of month.
func (e *explainer) ctxFor(root string) *summaryContext {
	c := *e.base
	c.root = root
	return &c
}

// periodOf is the period metric m's summary belongs to in month: the month,
// or its coarse period.
func (e *explainer) periodOf(m domain.Metric, month period.Period) period.Period {
	if g, ok := frequencyGrain(m.Frequency); ok && g != period.Month {
		return e.in.Cal.Parent(month, g)
	}
	return month
}

// factsOf judges metric m (of version v) at company scope for period per, as
// month sees it: a coarse period is required only in the month that closes
// it.
func (e *explainer) factsOf(v domain.MethodologyVersion, m domain.Metric, per, month period.Period) (summaryFacts, error) {
	k := factsKey{m.Key, per, month}
	if f, ok := e.facts[k]; ok {
		return f, nil
	}
	ref, err := e.column(per)
	if err != nil {
		return summaryFacts{}, err
	}
	last, _ := lastMonth(e.in.Cal, per)
	f := e.ctxFor(reportRoot(e.in, last)).facts(v, m, per, ref.rows, ref.col, per != month, last == month)
	e.facts[k] = f
	return f, nil
}

// metricItem is one metric's summary slot in a month: its facts, its stored
// summary (if any), its state and, when stale, why.
type metricItem struct {
	v       domain.MethodologyVersion
	m       domain.Metric
	per     period.Period
	month   period.Period
	root    string
	facts   summaryFacts
	stored  *domain.CellRCA
	state   SummaryState
	reasons []string
}

// item judges metric m of version v in month (or, for a coarse column, the
// month that closes it).
func (e *explainer) item(v domain.MethodologyVersion, m domain.Metric, per, month period.Period) (metricItem, error) {
	f, err := e.factsOf(v, m, per, month)
	if err != nil {
		return metricItem{}, err
	}
	last, _ := lastMonth(e.in.Cal, per)
	it := metricItem{v: v, m: m, per: per, month: month, root: reportRoot(e.in, last), facts: f, state: SummaryStateOptional, reasons: []string{}}
	r, ok := e.stored[summaryKey{m.Key, per}]
	switch {
	case ok:
		it.stored, it.state = &r, SummaryStateWritten
		reasons, err := e.staleReasons(f, r)
		if err != nil {
			return metricItem{}, err
		}
		if len(reasons) > 0 {
			it.state, it.reasons = SummaryStateStale, reasons
		}
	case f.req.Required:
		it.state = SummaryStateMissing
	}
	return it, nil
}

// items judges every metric of the methodology in force for month, in its
// order. Empty when no methodology is in force or there is no single root.
func (e *explainer) items(month period.Period) ([]metricItem, error) {
	v, ok := engine.VersionFor(e.in.Versions, month, e.in.Cal)
	if !ok || reportRoot(e.in, month) == "" {
		return []metricItem{}, nil
	}
	if err := e.preloadIncidents(v, func(m domain.Metric) period.Period { return e.periodOf(m, month) }); err != nil {
		return nil, err
	}
	out := make([]metricItem, 0, len(v.Content.Metrics))
	for _, m := range v.Content.Metrics {
		it, err := e.item(v, m, e.periodOf(m, month), month)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

// preloadIncidents loads, in one pass, the incidents of every metric of v
// whose summary (in the period perOf gives) is stored and that incidents
// explain, so judging stale reads incident records once per request.
func (e *explainer) preloadIncidents(v domain.MethodologyVersion, perOf func(domain.Metric) period.Period) error {
	if e.opts.noStale || e.opts.gate {
		return nil
	}
	var keys []string
	for _, m := range v.Content.Metrics {
		if _, ok := e.stored[summaryKey{m.Key, perOf(m)}]; ok && len(e.base.links[m.Key]) > 0 {
			keys = append(keys, m.Key)
		}
	}
	return e.loadIncidents(keys...)
}

// required is the publish gate's data for month: every required metric-month
// (a coarse metric's when month closes its period) with its state, stale
// judged in full; summaries as excerpts with their first 3 links.
func (e *explainer) required(month period.Period) ([]MetricSummary, error) {
	if month.Grain != period.Month {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "must be a month"})
	}
	its, err := e.items(month)
	if err != nil {
		return nil, err
	}
	out := []MetricSummary{}
	for _, it := range its {
		if it.facts.req.Required {
			out = append(out, e.summaryOf(it, false))
		}
	}
	return out, nil
}

// summary is metric's exec summary for per (a month, or the metric's coarse
// period), with full staleness and its top evidence: the whole text and
// every link when full, else an excerpt and the first 3 links. Readers who
// cannot read the company cell get 403.
func (e *explainer) summary(metric string, per period.Period, full bool) (MetricSummary, error) {
	month, ok := lastMonth(e.in.Cal, per)
	v, vok := engine.VersionFor(e.in.Versions, per, e.in.Cal)
	if !ok || !vok {
		return MetricSummary{}, notFound("no methodology version is in force for " + per.String())
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if mi < 0 {
		return MetricSummary{}, notFound("metric not found")
	}
	m := v.Content.Metrics[mi]
	if g, ok := frequencyGrain(m.Frequency); ok && g != per.Grain {
		return MetricSummary{}, badRequest("request validation failed",
			detail{Path: "period", Message: fmt.Sprintf("%s is reported for whole %s periods", metric, grainName(g))})
	}
	root := reportRoot(e.in, month)
	if root == "" {
		return MetricSummary{}, notFound("the organization has no single top-level unit in " + month.String())
	}
	if !e.acc.canRead(root, []string{metric}, month) {
		return MetricSummary{}, forbidden("you may not read this exec summary")
	}
	if err := e.loadIncidents(metric); err != nil {
		return MetricSummary{}, err
	}
	it, err := e.item(v, m, per, month)
	if err != nil {
		return MetricSummary{}, err
	}
	out := e.summaryOf(it, full)
	if err := e.addEvidence(&out, it); err != nil {
		return MetricSummary{}, err
	}
	return out, nil
}

// summaryOf is an item's summary slot: whole, or an excerpt with the first
// 3 links.
func (e *explainer) summaryOf(it metricItem, full bool) MetricSummary {
	links := -1
	if !full {
		links = linksShown
	}
	out := apiMetricSummary(it.facts, it.stored, it.reasons, e.admin, links)
	if !full && out.Text != nil {
		ex := excerpt(*out.Text)
		out.Text = &ex
	}
	return out
}

// excerpt is text cut at 60 runes plus an ellipsis (the web's rcaExcerpt).
func excerpt(text string) string {
	if utf8.RuneCountInString(text) <= excerptRunes {
		return text
	}
	r := []rune(text)
	return strings.TrimRight(string(r[:excerptRunes]), " \t\n") + "…"
}

// addEvidence sets the summary's top company-level evidence: the company
// cell's incidents or records, or, for a metric with no company value, the
// worst reporting subject's.
func (e *explainer) addEvidence(out *MetricSummary, it metricItem) error {
	subject := it.root
	if !hasCellStanding(it.facts.in.Company) {
		w := worstSubject(it.facts.in)
		if w == nil {
			return nil
		}
		subject = w.ID
	}
	if !e.acc.canRead(subject, []string{it.m.Key}, it.month) {
		return nil
	}
	a, err := e.core(it.v, it.m, subject, it.per, false)
	if err != nil || a.Attribution != CellAttributionAttributionAvailable {
		return err
	}
	ev := []RcaEvidenceKey{}
	for _, in := range a.Incidents {
		if len(ev) == maxEvidence {
			break
		}
		ev = append(ev, RcaEvidenceKey{Key: in.Key, Title: in.Title, Url: in.Url, PointsDisplay: in.PointsDisplay})
	}
	for _, r := range a.Records {
		if len(ev) == maxEvidence {
			break
		}
		points := ""
		if r.ImpactDisplay != nil {
			points = *r.ImpactDisplay
		}
		ev = append(ev, RcaEvidenceKey{Key: r.Contribution.ExternalId, Title: r.Contribution.Title, Url: httpsOnly(r.Contribution.Url), PointsDisplay: points})
	}
	if len(ev) > 0 {
		out.Evidence = &ev
	}
	return nil
}

func hasCellStanding(c *rca.CellFacts) bool {
	return c != nil && (c.Display != "" || c.Value != nil || c.Status != "")
}

// ---- staleness ---------------------------------------------------------------

// staleReasons compares a stored summary's basis with the current one (spec
// §8.4): fully (subjects and incidents) unless the explainer judges as the
// gate does or reads every summary as written.
func (e *explainer) staleReasons(f summaryFacts, r domain.CellRCA) ([]string, error) {
	switch {
	case e.opts.noStale:
		return nil, nil
	case e.opts.gate:
		if gateStale(r.Basis, f.basis(nil)) {
			return []string{"The attribution changed since it was written."}, nil
		}
		return nil, nil
	}
	incidents, err := e.incidentEvidence(f)
	if err != nil {
		return nil, err
	}
	return e.reasons(f, r.Basis, f.basis(incidents)), nil
}

// incidentEvidence is Server.incidentEvidence over the incidents the
// explainer loaded.
func (e *explainer) incidentEvidence(f summaryFacts) ([]string, error) {
	out := []string{}
	if len(e.base.links[f.metric.Key]) == 0 {
		return out, nil
	}
	incs, err := e.incidentsOf(f.metric.Key)
	if err != nil {
		return nil, err
	}
	linked, _ := e.base.links.downtime(f.metric.Key)
	w := rca.PeriodWindow(e.in.Cal, f.period, time.UTC)
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

// reasons are the stale sentences of spec §8.4, in order: the value, the
// status, the subjects that became or stopped being short of perfect, the
// incidents, and the reported downtime. A change the reader cannot read
// reads as "The attribution changed since it was written."
func (e *explainer) reasons(f summaryFacts, stored, current domain.RCABasis) []string {
	const changed = "The attribution changed since it was written."
	label := scaleLabelOf(e.base.scale)
	month, _ := lastMonth(e.in.Cal, f.period)
	readable := func(id string) bool { return e.acc.canRead(id, []string{f.metric.Key}, month) }

	split := func(b domain.RCABasis) (subjects, incidents []string) {
		for _, k := range b.Evidence {
			if id, ok := strings.CutPrefix(k, "subject:"); ok {
				subjects = append(subjects, id)
			} else {
				incidents = append(incidents, k)
			}
		}
		return subjects, incidents
	}
	sOld, iOld := split(stored)
	sNew, iNew := split(current)
	added, removed := onlyIn(sNew, sOld), onlyIn(sOld, sNew)

	subjectsOf := map[string]string{}
	for _, bySubject := range e.incidents[f.metric.Key] {
		for _, in := range bySubject {
			subjectsOf[in.Source+":"+in.ExternalID] = in.SubjectID
		}
	}
	hidden := false
	for _, id := range slices.Concat(added, removed) {
		hidden = hidden || !readable(id)
	}
	// An incident whose record is gone has no subject left to check; only
	// readers who read every subject (admins, contributors) see its key.
	for _, k := range slices.Concat(onlyIn(iNew, iOld), onlyIn(iOld, iNew)) {
		id, ok := subjectsOf[k]
		hidden = hidden || (ok && !readable(id)) || (!ok && e.p.Membership != nil && e.p.Membership.Role == domain.RoleViewer)
	}

	strip := func(b domain.RCABasis, incidents []string) domain.RCABasis {
		b.Evidence = incidents
		return b
	}
	if hidden {
		out := rca.StaleReasons(strip(stored, nil), strip(current, nil), label)
		if !slices.Equal(stored.Evidence, current.Evidence) {
			out = append(out, changed)
		}
		return nonNil(out)
	}
	out := rca.StaleReasons(strip(stored, iOld), strip(current, iNew), label)
	lead := 0
	for lead < len(out) && (strings.HasPrefix(out[lead], "The value changed") || strings.HasPrefix(out[lead], "The status changed")) {
		lead++
	}
	var subj []string
	short := shortOfText(f.metric, label, e.base.scale)
	noun := e.base.noun(f.metric)
	names := func(ids []string) []string {
		out := make([]string, len(ids))
		for i, id := range ids {
			out[i] = cmp.Or(e.names[id], id)
		}
		return out
	}
	if n := len(added); n > 0 {
		word, verb := noun.Many, "are"
		if n == 1 {
			word, verb = noun.One, "is"
		}
		subj = append(subj, fmt.Sprintf("%d more %s %s %s: %s.", n, word, verb, short, strings.Join(names(added), ", ")))
	}
	if n := len(removed); n > 0 {
		verb := "are"
		if n == 1 {
			verb = "is"
		}
		subj = append(subj, fmt.Sprintf("%s %s no longer %s.", joinNames(names(removed)), verb, short))
	}
	out = slices.Concat(out[:lead], subj, out[lead:])
	return nonNil(out)
}

// shortOfText is how a subject falls short in a count: below 100%, over
// plan, or not at the best status (rca's shortOf).
func shortOfText(m domain.Metric, label func(string) string, scale []domain.StatusLevel) string {
	switch {
	case engine.ChartKind(m) == "money_plan":
		return "over plan"
	case rca.DowntimeMetric(m):
		return "below 100%"
	}
	return "not " + label(rca.BestStatus(m.Rule, scale))
}

func joinNames(ns []string) string {
	if len(ns) <= 1 {
		return strings.Join(ns, "")
	}
	return strings.Join(ns[:len(ns)-1], ", ") + " and " + ns[len(ns)-1]
}

func onlyIn(a, b []string) []string {
	var out []string
	for _, x := range a {
		if !slices.Contains(b, x) {
			out = append(out, x)
		}
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ---- incidents and records ----------------------------------------------------

// loadIncidents loads, in one pass over the record types, the incidents of
// the metrics not loaded yet.
func (e *explainer) loadIncidents(metrics ...string) error {
	var want []string
	for _, m := range metrics {
		if !e.loaded[m] && !slices.Contains(want, m) {
			want = append(want, m)
		}
	}
	if len(want) == 0 {
		return nil
	}
	byMetric, _, err := e.s.incidentsFor(e.ctx, e.tenant.ID, e.sc, want, e.in)
	if err != nil {
		return err
	}
	for _, m := range want {
		e.loaded[m] = true
		e.incidents[m] = byMetric[m]
	}
	return nil
}

func (e *explainer) incidentsOf(metric string) (map[string][]rca.Incident, error) {
	if err := e.loadIncidents(metric); err != nil {
		return nil, err
	}
	return e.incidents[metric], nil
}

// deriveOf derives measure ms for period per once per request.
func (e *explainer) deriveOf(v domain.MethodologyVersion, ms domain.Measure, per period.Period) ([]records.Derived, error) {
	k := deriveKey{v.ID, ms.Key, per}
	if d, ok := e.derived[k]; ok {
		return d, nil
	}
	if e.din == nil {
		din, err := recordimport.LoadDeriveInput(e.ctx, e.s.store, e.tenant, e.sc)
		if err != nil {
			return nil, err
		}
		e.din = &din
	}
	d, err := records.Derive(*e.din, ms, []period.Period{per})
	if err != nil {
		d = nil // one bad rule leaves its records out; the value stands
	}
	e.derived[k] = d
	return d, nil
}

func (e *explainer) recordType(id string) (domain.RecordType, bool) {
	if e.din == nil {
		return domain.RecordType{}, false
	}
	i := slices.IndexFunc(e.din.Types, func(rt domain.RecordType) bool { return rt.ID == id })
	if i < 0 {
		return domain.RecordType{}, false
	}
	return e.din.Types[i], true
}

// ---- attribution ---------------------------------------------------------------

// attribution is one cell's card (spec §9.2): its gap, evidence and remainder,
// at the first page (5 incidents, 10 records, the worst 3 children and the
// metric's summary as context) or a later page of 50 incidents or records.
func (e *explainer) attribution(metric, subject string, per period.Period, d explainDepth, c attributionCursors) (CellAttribution, error) {
	month, ok := lastMonth(e.in.Cal, per)
	v, vok := engine.VersionFor(e.in.Versions, per, e.in.Cal)
	if !ok || !vok {
		return CellAttribution{}, notFound("no methodology version is in force for " + per.String())
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == metric })
	if mi < 0 {
		return CellAttribution{}, notFound("metric not found")
	}
	m := v.Content.Metrics[mi]
	if _, ok := e.acc.unitOf(subject); !ok {
		return CellAttribution{}, notFound("subject not found")
	}
	if !e.acc.canRead(subject, []string{metric}, month) {
		return CellAttribution{}, forbidden("you may not read this cell")
	}
	first := c.incidents == nil && c.records == nil
	out, err := e.core(v, m, subject, per, first && d == depthFull)
	if err != nil {
		return CellAttribution{}, err
	}
	incs, recs := out.Incidents, out.Records
	out.IncidentsTotal, out.RecordsTotal = len(incs), len(recs)
	page := func(n, from, size int) (lo, hi int, next *string) {
		lo = min(from, n)
		hi = min(lo+size, n)
		if hi < n {
			s := strconv.Itoa(hi)
			next = &s
		}
		return lo, hi, next
	}
	switch {
	case c.incidents != nil:
		lo, hi, next := page(len(incs), *c.incidents, attributionPage)
		out.Incidents, out.IncidentsCursor, out.Records = incs[lo:hi], next, []RcaRecord{}
	case c.records != nil:
		lo, hi, next := page(len(recs), *c.records, attributionPage)
		out.Records, out.RecordsCursor, out.Incidents = recs[lo:hi], next, []RcaIncident{}
	default:
		lo, hi, next := page(len(incs), 0, firstIncidents)
		out.Incidents, out.IncidentsCursor = incs[lo:hi], next
		lo, hi, next = page(len(recs), 0, firstRecords)
		out.Records, out.RecordsCursor = recs[lo:hi], next
		if d == depthFull {
			s, err := e.cardSummary(v, m, per, month)
			if err != nil {
				return CellAttribution{}, err
			}
			out.Summary = s
		}
	}
	return out, nil
}

// cardSummary is the metric's summary shown as context on a cell's card: the
// counted period's (a quarterly metric's quarter on a month cell), as an
// excerpt, or nil when the reader cannot read the company cell or the
// period has no summary of the metric's grain.
func (e *explainer) cardSummary(v domain.MethodologyVersion, m domain.Metric, per, month period.Period) (*MetricSummary, error) {
	sp := per
	if g, ok := frequencyGrain(m.Frequency); ok && g != per.Grain {
		if per.Grain != period.Month {
			return nil, nil
		}
		sp = e.in.Cal.Parent(per, g)
	}
	last, _ := lastMonth(e.in.Cal, sp)
	root := reportRoot(e.in, last)
	if root == "" || !e.acc.canRead(root, []string{m.Key}, last) {
		return nil, nil
	}
	it, err := e.item(v, m, sp, month)
	if err != nil {
		return nil, err
	}
	s := e.summaryOf(it, false)
	return &s, nil
}

// core computes a cell's attribution with every incident and record (not
// paged), and, when children is set, its worst three readable children.
func (e *explainer) core(v domain.MethodologyVersion, m domain.Metric, subject string, per period.Period, children bool) (CellAttribution, error) {
	month, _ := lastMonth(e.in.Cal, per)
	ref, err := e.column(per)
	if err != nil {
		return CellAttribution{}, err
	}
	var cell engine.Cell
	name := e.names[subject]
	i := slices.IndexFunc(ref.rows, func(r engine.Row) bool { return r.MetricKey == m.Key && r.SubjectID == subject })
	if i >= 0 && ref.col < len(ref.rows[i].Cells) {
		cell, name = ref.rows[i].Cells[ref.col], ref.rows[i].SubjectName
	}
	below := e.reportingBelow(m, subject, ref, month)
	if i < 0 && len(below) == 0 {
		return CellAttribution{}, notFound("this metric has no cell for this subject")
	}

	rule := m.Rule
	if cell.Rule.Type != "" {
		rule = cell.Rule
	}
	mm := m
	mm.ChartKind, mm.Rule = engine.ChartKind(m), rule
	scale := e.base.scale
	label := scaleLabelOf(scale)
	facts := rca.CellFacts{Display: cell.Display, Status: cell.Status, Value: cell.Value, Components: cell.Components, Change: cell.Change}
	out := CellAttribution{MetricKey: m.Key, SubjectId: subject, SubjectName: name, Period: per.String(), Display: cell.Display, Status: cell.Status,
		Attribution: CellAttributionAttributionNone, Incidents: []RcaIncident{}, Records: []RcaRecord{}, Children: []RcaChild{}}
	if o := cell.Override; o != nil {
		reason, by := o.Reason, o.By
		out.Override = &struct {
			By     *string `json:"by,omitempty"`
			Reason *string `json:"reason,omitempty"`
		}{By: &by, Reason: &reason}
	}
	threshold := thresholdText(mm, rule, label)
	linked, downMeasure := e.base.links.downtime(m.Key)
	downtime := rca.DowntimeMetric(mm) && (mm.ChartKind == "uptime" || linked)
	ideal, hasIdeal := rca.Ideal(mm)

	if !hasCellStanding(&facts) && len(below) > 0 {
		// A roll-up with no value of its own (uptime across services).
		in := rca.SummaryInput{Metric: mm, CompanyRule: rule, Reporting: below, Scale: scale, Noun: e.base.noun(m)}
		out.Display, out.Status = rca.CompanyStanding(in)
		head := rca.CompanyHeadline(in)
		kind := RcaGapKindNone
		if w := worstSubject(in); head != "" && w != nil {
			out.Attribution = CellAttributionAttributionAvailable
			wm := mm
			wm.Rule = w.Rule
			gi := rca.GapInput{Metric: wm, Cell: w.Cell}
			if downtime {
				gi.Downtime = &rca.Downtime{}
			}
			kind = RcaGapKind(rca.GapOf(gi).Kind)
		}
		out.Gap = RcaGap{Kind: kind, Headline: head, Detail: joinNonEmpty(label(out.Status), threshold)}
		if head != "" && hasIdeal {
			out.Gap.Ideal = &ideal
		}
		if downtime {
			if err := e.rollupIncidents(&out, m, below, per); err != nil {
				return CellAttribution{}, err
			}
		}
		if children {
			e.addChildren(&out, v, m, below, per)
		}
		return out, nil
	}

	gin := rca.GapInput{Metric: mm, Cell: facts, StatusLabel: label, Threshold: threshold,
		ComparedLabel: comparedLabel(e.in.Cal, rule, per)}
	available := cellShort(mm, facts, rule, scale)
	var dt *rca.Downtime
	switch {
	case downtime && len(below) == 0:
		w := rca.PeriodWindow(e.in.Cal, per, time.UTC)
		pm := periodMinutesOf(v, m, cell, downMeasure, w)
		if reported, from, ok := reportedOf(v, m, cell, downMeasure, pm); ok {
			incs, err := e.incidentsOf(m.Key)
			if err != nil {
				return CellAttribution{}, err
			}
			d := rca.CountDowntime(w, pm, reported, incs[subject])
			dt, gin.Downtime, gin.FromValue = &d, &d, from == RcaGapReportedFromValue
			pmf, rmf := float32(pm), float32(reported)
			out.Gap.PeriodMinutes, out.Gap.ReportedMinutes, out.Gap.ReportedFrom = &pmf, &rmf, &from
		}
	case downtime:
		if err := e.rollupIncidents(&out, m, below, per); err != nil {
			return CellAttribution{}, err
		}
	default:
		if err := e.recordsEvidence(&out, &gin, v, mm, subject, per, month, len(below) == 0); err != nil {
			return CellAttribution{}, err
		}
	}
	g := rca.GapOf(gin)
	pm, rm, rf := out.Gap.PeriodMinutes, out.Gap.ReportedMinutes, out.Gap.ReportedFrom
	out.Gap = RcaGap{Kind: RcaGapKind(g.Kind), Headline: g.Headline, Detail: g.Detail, Ideal: g.Ideal, Decimals: &g.Decimals,
		PeriodMinutes: pm, ReportedMinutes: rm, ReportedFrom: rf}
	if g.Units != nil {
		u := int(*g.Units)
		out.Gap.Units = &u
	}
	if available && g.Kind != rca.KindNone && g.Headline != "" {
		out.Attribution = CellAttributionAttributionAvailable
	} else {
		out.Gap = RcaGap{Kind: RcaGapKindNone, Detail: g.Detail, Decimals: &g.Decimals, PeriodMinutes: pm, ReportedMinutes: rm, ReportedFrom: rf}
	}
	if dt != nil {
		e.downtimeRows(&out, *dt, g, subject, per)
	}
	if children && len(below) > 0 {
		e.addChildren(&out, v, m, below, per)
	}
	return out, nil
}

// cellShort says whether a rated cell is short of perfect: not at its best
// status, or (at it) below 100% or over plan (rca's imperfect).
func cellShort(m domain.Metric, c rca.CellFacts, rule domain.StatusRule, scale []domain.StatusLevel) bool {
	if c.Status == "" {
		return false
	}
	if best := rca.BestStatus(rule, scale); best != "" && c.Status != best {
		return true
	}
	units, ok := rca.GapUnits(100, c.Display, rca.Decimals(m.Format))
	switch {
	case !ok:
		return false
	case engine.ChartKind(m) == "money_plan":
		return units < 0
	}
	return rca.DowntimeMetric(m) && units > 0
}

// reportingBelow lists the readable reporting subjects of m strictly below
// subject (the units under it, and the items attached to them), each with
// its own rule. An item has none.
func (e *explainer) reportingBelow(m domain.Metric, subject string, ref colRef, month period.Period) []rca.SubjectFacts {
	if _, ok := e.in.Tree.Unit(subject); !ok {
		return nil
	}
	under := map[string]bool{subject: true}
	for _, id := range e.in.Tree.DescendantsAt(subject, month) {
		under[id] = true
	}
	var out []rca.SubjectFacts
	for _, r := range ref.rows {
		if r.MetricKey != m.Key || r.SubjectID == subject || ref.col >= len(r.Cells) {
			continue
		}
		isItem := r.SubjectKind == engine.SubjectItem
		d := -1
		if isItem {
			if !under[e.acc.items[r.SubjectID].OrgUnitID] {
				continue
			}
		} else {
			if !under[r.SubjectID] {
				continue
			}
			if u, ok := e.in.Tree.Unit(r.SubjectID); ok {
				if ld, ok := e.base.depth[u.LevelID]; ok {
					d = ld
				}
			}
		}
		if !rca.IsReportingSubject(m, e.base.levels, d, isItem) || !e.acc.canRead(r.SubjectID, []string{m.Key}, month) {
			continue
		}
		c := r.Cells[ref.col]
		rule := m.Rule
		if c.Rule.Type != "" {
			rule = c.Rule
		}
		out = append(out, rca.SubjectFacts{ID: r.SubjectID, Name: r.SubjectName, Rule: rule,
			Cell: rca.CellFacts{Display: c.Display, Status: c.Status, Value: c.Value, Components: c.Components, Change: c.Change}})
	}
	return out
}

// worstSubject is the worst rated reporting subject: worst status, then the
// largest gap, then name; nil when none is rated.
func worstSubject(in rca.SummaryInput) *rca.SubjectFacts {
	var rated []rca.SubjectFacts
	for _, s := range in.Reporting {
		if s.Cell.Status != "" {
			rated = append(rated, s)
		}
	}
	if len(rated) == 0 {
		return nil
	}
	ranked := rankSubjects(in.Metric, in.Scale, rated, nil)
	return &ranked[0]
}

// rankSubjects orders subjects worst first: status rank, then impact (when
// given, by ID; else the gap from the displayed value), then name.
func rankSubjects(m domain.Metric, scale []domain.StatusLevel, subs []rca.SubjectFacts, impact map[string]float64) []rca.SubjectFacts {
	rank := func(status string) int {
		for _, l := range scale {
			if l.Key == status {
				return l.Rank
			}
		}
		return math.MinInt
	}
	d := rca.Decimals(m.Format)
	gap := func(s rca.SubjectFacts) float64 {
		if impact != nil {
			return impact[s.ID]
		}
		u, ok := rca.GapUnits(0, s.Cell.Display, d) // −displayed
		switch {
		case !ok:
			return math.Inf(-1)
		case m.Direction == domain.DirectionLowerBetter || engine.ChartKind(m) == "money_plan":
			return float64(-u)
		}
		return float64(u)
	}
	out := slices.Clone(subs)
	slices.SortStableFunc(out, func(a, b rca.SubjectFacts) int {
		return cmp.Or(cmp.Compare(rank(b.Cell.Status), rank(a.Cell.Status)), cmp.Compare(gap(b), gap(a)), cmp.Compare(a.Name, b.Name))
	})
	return out
}

// addChildren sets the worst three readable children that have attribution
// (spec §4.6), each with its own attribution line, and how many there are.
func (e *explainer) addChildren(out *CellAttribution, v domain.MethodologyVersion, m domain.Metric, below []rca.SubjectFacts, per period.Period) {
	mm := m
	mm.ChartKind = engine.ChartKind(m)
	scale := e.base.scale
	d := rca.Decimals(m.Format)
	num, den, ratio := rca.RatioParts(m.Formula)
	sumRatio := ratio && measureAgg(v, num) == domain.AggSum && measureAgg(v, den) == domain.AggSum
	impact := map[string]float64{}
	shown := map[string]string{}
	var cands []rca.SubjectFacts
	for _, s := range below {
		sm := mm
		sm.Rule = s.Rule
		if !cellShort(sm, s.Cell, s.Rule, scale) {
			continue
		}
		cands = append(cands, s)
		if c := s.Cell.Components; sumRatio && c != nil {
			if mm.ChartKind == "money_plan" {
				over := c[num] - c[den]
				impact[s.ID], shown[s.ID] = over, engine.Format(domain.FormatMoneyK, over)+" over"
				continue
			}
			miss := c[den] - c[num]
			impact[s.ID], shown[s.ID] = miss, trimNumber(miss, 2)+" missed"
			continue
		}
		g := rca.GapOf(rca.GapInput{Metric: sm, Cell: s.Cell})
		if g.Units != nil {
			impact[s.ID] = float64(*g.Units)
			txt := fixedDec(float64(*g.Units)/math.Pow10(d), d)
			if strings.HasPrefix(m.Format, "percent") {
				txt += " pts"
			}
			shown[s.ID] = txt
		}
	}
	ranked := rankSubjects(mm, scale, cands, impact)
	out.ChildrenTotal = len(ranked)
	for _, s := range ranked[:min(len(ranked), maxChildren)] {
		line := ""
		if a, err := e.core(v, m, s.ID, per, false); err == nil {
			line = attributionLine(a)
		}
		out.Children = append(out.Children, RcaChild{SubjectId: s.ID, SubjectName: s.Name, Display: s.Cell.Display, Status: s.Cell.Status,
			ImpactDisplay: shown[s.ID], AttributionLine: line})
	}
}

func measureAgg(v domain.MethodologyVersion, key string) domain.Agg {
	i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == key })
	if i < 0 {
		return ""
	}
	return v.Content.Measures[i].OrgAgg
}

// attributionLine is a child's top evidence in one line: "INC-2041 + 2 more ·
// 0.09 pts not explained", "INC-2052 · 15m more than reported", "3 of 11
// epics missed · CHK-226 + 2 more"; empty when nothing is linked.
func attributionLine(a CellAttribution) string {
	var parts []string
	more := func(key string, n int) string {
		if n > 1 {
			return fmt.Sprintf("%s + %d more", key, n-1)
		}
		return key
	}
	switch {
	case len(a.Incidents) > 0:
		parts = append(parts, more(a.Incidents[0].Key, len(a.Incidents)))
		switch {
		case a.Unexplained != nil:
			pts, _, _ := strings.Cut(a.Unexplained.Display, " · ")
			parts = append(parts, pts+" not explained")
		case a.Excess != nil:
			parts = append(parts, rca.Duration(float64(a.Excess.Minutes))+" more than reported")
		}
	case len(a.Records) > 0:
		if a.RecordsSummary != nil {
			parts = append(parts, *a.RecordsSummary)
		}
		parts = append(parts, more(a.Records[0].Contribution.ExternalId, len(a.Records)))
	}
	return strings.Join(parts, " · ")
}

// periodMinutesOf is the period's minutes from the cell's components (the
// longest measure of the formula in s, min or h other than the down
// measure, as seconds_in_period is), else the window's.
func periodMinutesOf(v domain.MethodologyVersion, m domain.Metric, c engine.Cell, downMeasure string, w rca.Window) float64 {
	best := 0.0
	if ids, err := formula.Identifiers(m.Formula); err == nil {
		for _, id := range ids {
			if mins, ok := componentMinutes(v, c, id); ok && id != downMeasure && mins > best {
				best = mins
			}
		}
	}
	if best > 0 {
		return best
	}
	return w.Minutes()
}

// componentMinutes reads measure key of the cell's components in minutes,
// when its unit is s, min or h.
func componentMinutes(v domain.MethodologyVersion, c engine.Cell, key string) (float64, bool) {
	raw, ok := c.Components[key]
	if !ok || key == "" {
		return 0, false
	}
	i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == key })
	if i < 0 {
		return 0, false
	}
	switch v.Content.Measures[i].Unit {
	case "s":
		return raw / 60, true
	case "min":
		return raw, true
	case "h":
		return raw * 60, true
	}
	return 0, false
}

// reportedOf is a downtime cell's reported downtime in minutes: the link's
// down measure from the cell's components when it has one, else the
// displayed gap to 100% as a share of the period ("from the value").
func reportedOf(v domain.MethodologyVersion, m domain.Metric, c engine.Cell, downMeasure string, periodMinutes float64) (float64, RcaGapReportedFrom, bool) {
	if mins, ok := componentMinutes(v, c, downMeasure); ok {
		return mins, RcaGapReportedFromMeasure, true
	}
	d := rca.Decimals(m.Format)
	units, ok := rca.GapUnits(100, c.Display, d)
	if !ok || units < 0 {
		return 0, "", false
	}
	return float64(units) / math.Pow10(d) / 100 * periodMinutes, RcaGapReportedFromValue, true
}

// downtimeRows sets a downtime cell's incidents, remainder and excess, with
// points and minutes rounded by the largest remainder method so the parts
// add up to the displayed gap and the reported minutes (spec §5.2, §5.6,
// §5.7).
func (e *explainer) downtimeRows(out *CellAttribution, dt rca.Downtime, g rca.Gap, subject string, per period.Period) {
	d := g.Decimals
	n := len(dt.Items)
	pts := make([]float64, 0, n+1)
	mins := make([]float64, 0, n+1)
	for _, it := range dt.Items {
		pts = append(pts, it.Minutes/dt.PeriodMinutes*100)
		mins = append(mins, it.Minutes)
	}
	excess := dt.Excess >= 0.5
	withPoints := g.Units != nil
	var ptsR, minsR []float64
	if excess {
		ptsR = rca.RoundParts(pts, sum(pts), d)
		minsR = rca.RoundParts(mins, math.Round(sum(mins)), 0)
	} else {
		pts = append(pts, dt.Unexplained/dt.PeriodMinutes*100)
		mins = append(mins, dt.Unexplained)
		total := sum(pts)
		if withPoints {
			total = float64(*g.Units) / math.Pow10(d)
		}
		ptsR = rca.RoundParts(pts, total, d)
		minsR = rca.RoundParts(mins, math.Round(dt.ReportedMinutes), 0)
	}
	sources := map[string]string{}
	for _, it := range dt.Items {
		sources[it.Incident.Key] = it.Incident.Source
	}
	label := periodLabel(e.in.Cal, per)
	for i, it := range dt.Items {
		points := ""
		if withPoints {
			points = fixedDec(ptsR[i], d) + " pts"
		}
		out.Incidents = append(out.Incidents, apiIncident(it.Incident, it.Minutes, rca.Duration(minsR[i]), points,
			incidentNotes(it, minsR[i], sources, label), []string{subject}))
	}
	if !withPoints {
		return
	}
	reported := rca.Duration(dt.ReportedMinutes)
	switch {
	case excess:
		out.Excess = &RcaRemainder{Minutes: float32(dt.Excess), WithinTolerance: dt.WithinTolerance,
			Display: fmt.Sprintf("%s pts · %s more than the %s reported", fixedDec(sum(ptsR), d), rca.Duration(dt.Excess), reported)}
	case dt.Unexplained >= 0.5:
		out.Unexplained = &RcaRemainder{Minutes: float32(dt.Unexplained), WithinTolerance: dt.WithinTolerance,
			Display: fmt.Sprintf("%s pts · %s of the %s reported", fixedDec(ptsR[n], d), rca.Duration(minsR[n]), reported)}
	}
}

// rollupIncidents lists, at a roll-up, the incidents of the readable
// reporting subjects below, once per group key (one incident that hit three
// services is listed once, "3 services"), with minutes summed per service
// and no roll-up points (spec §4.6).
func (e *explainer) rollupIncidents(out *CellAttribution, m domain.Metric, below []rca.SubjectFacts, per period.Period) error {
	incs, err := e.incidentsOf(m.Key)
	if err != nil {
		return err
	}
	w := rca.PeriodWindow(e.in.Cal, per, time.UTC)
	type group struct {
		c        rca.Counted
		minutes  float64
		subjects []string
	}
	byKey := map[string]*group{}
	var order []string
	for _, s := range below {
		for _, c := range rca.CountDowntime(w, w.Minutes(), 0, incs[s.ID]).Items {
			g, ok := byKey[c.Incident.Key]
			if !ok {
				g = &group{c: c}
				byKey[c.Incident.Key] = g
				order = append(order, c.Incident.Key)
			}
			g.minutes += c.Minutes
			if !slices.Contains(g.subjects, s.ID) {
				g.subjects = append(g.subjects, s.ID)
			}
		}
	}
	slices.SortStableFunc(order, func(a, b string) int {
		ga, gb := byKey[a], byKey[b]
		if c := cmp.Compare(math.Round(gb.minutes*1e6), math.Round(ga.minutes*1e6)); c != 0 {
			return c
		}
		if sa, sb := ga.c.Incident.Start, gb.c.Incident.Start; sa != nil && sb != nil && !sa.Equal(*sb) {
			return sa.Compare(*sb)
		}
		return cmp.Compare(a, b)
	})
	noun := e.base.noun(m)
	for _, k := range order {
		g := byKey[k]
		slices.Sort(g.subjects)
		note := cmp.Or(e.names[g.subjects[0]], g.subjects[0])
		if len(g.subjects) > 1 {
			note = fmt.Sprintf("%d %s", len(g.subjects), noun.Many)
		}
		out.Incidents = append(out.Incidents, apiIncident(g.c.Incident, g.minutes, rca.Duration(g.minutes), "", []string{note}, g.subjects))
	}
	return nil
}

func apiIncident(in rca.Incident, minutes float64, counted, points string, notes, subjects []string) RcaIncident {
	state := RcaIncidentState(in.State)
	if !state.Valid() {
		state = RcaIncidentStateDone
	}
	return RcaIncident{Source: in.Source, ExternalId: in.ExternalID, Key: in.Key, Title: in.Title, Url: httpsOnly(in.URL),
		Severity: in.Severity, State: state, StartedAt: in.Start, EndedAt: in.End, CountedMinutes: float32(minutes),
		CountedDisplay: counted, PointsDisplay: points, Notes: nonNil(notes), SubjectIds: subjects}
}

// incidentNotes are an incident's notes as the card shows them (spec §5.2–§5.4).
func incidentNotes(it rca.Counted, counted float64, sources map[string]string, label string) []string {
	var out []string
	keys := make([]string, 0, len(it.Overlaps))
	for k := range it.Overlaps {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		out = append(out, fmt.Sprintf("Overlaps %s for %s", k, rca.Duration(it.Overlaps[k])))
	}
	for _, k := range it.SameWindowAs {
		out = append(out, fmt.Sprintf("Same window as %s (%s)", k, sources[k]))
	}
	in := it.Incident
	whole := rca.Duration(it.TotalMinutes)
	switch {
	case it.StartedBefore && in.Start != nil:
		out = append(out, fmt.Sprintf("Started %s · %s of %s fell in %s", in.Start.UTC().Format("Jan 2, 15:04"), rca.Duration(counted), whole, label))
	case it.EndedAfter && !it.Ongoing && in.End != nil:
		out = append(out, fmt.Sprintf("Ended %s · %s of %s fell in %s", in.End.UTC().Format("Jan 2, 15:04"), rca.Duration(counted), whole, label))
	}
	switch {
	case it.Ongoing:
		note := "Ongoing"
		if !in.Cutoff.IsZero() {
			note += " · counted to " + in.Cutoff.Add(-time.Nanosecond).UTC().Format("Jan 2") + " (latest incident import)"
		}
		out = append(out, note)
	case it.DurationOnly:
		out = append(out, fmt.Sprintf("No start or end time · counts its %s in %s", whole, label))
	case it.Unknown:
		out = append(out, "Duration unknown")
	case in.Start != nil && in.End == nil && in.CompletedAt != nil:
		out = append(out, "No end time · counted to "+in.CompletedAt.UTC().Format("Jan 2")+", 23:59 UTC")
	}
	if in.Impact > 0 && in.Impact < 1 {
		out = append(out, fmt.Sprintf("%s%% impact · counts %s of %s", trimNumber(in.Impact*100, 1), rca.Duration(counted), whole))
	}
	return out
}

// recordsEvidence sets the records behind a derived cell (spec §6): a
// ratio's misses (priority, then days late), a money plan's overruns, a
// change rule's changes against the compared period, or the largest
// contributions; and, at a leaf, whether the value was typed.
func (e *explainer) recordsEvidence(out *CellAttribution, gin *rca.GapInput, v domain.MethodologyVersion, m domain.Metric, subject string, per, month period.Period, leaf bool) error {
	measures := derivedMeasuresOf(v, m)
	if len(measures) == 0 {
		return nil
	}
	byKey := map[string]domain.Measure{}
	for _, ms := range measures {
		byKey[ms.Key] = ms
	}
	leaves := map[string]bool{}
	for _, id := range cellSubjects(e.in, subject, month, m.RollItemsToOrg) {
		if e.acc.canRead(id, []string{m.Key}, month) {
			leaves[id] = true
		}
	}
	subjectOf := map[[2]string]string{}
	contribs := func(ms domain.Measure, q period.Period) ([]records.Contribution, int, error) {
		ds, err := e.deriveOf(v, ms, q)
		if err != nil {
			return nil, 0, err
		}
		var cs []records.Contribution
		pending := 0
		for _, d := range ds {
			if !leaves[d.SubjectID] {
				continue
			}
			pending += d.Pending
			for _, c := range d.Contributions {
				subjectOf[[2]string{c.Source, c.ExternalID}] = d.SubjectID
				cs = append(cs, c)
			}
		}
		return cs, pending, nil
	}
	if leaf {
		for _, dp := range e.in.Data {
			if dp.SubjectID == subject && dp.Period == per && dp.Source != domain.SourceRecords {
				if _, ok := byKey[dp.MeasureKey]; ok {
					typed := true
					out.Typed = &typed
				}
			}
		}
	}
	num, den, ratio := rca.RatioParts(m.Formula)
	numM, numOK := byKey[num]
	denM, denOK := byKey[den]
	cell := gin.Cell
	per1 := 1.0
	unit := ""
	if ratio {
		if c, ok := cell.Components[den]; ok && c > 0 {
			per1 = c
		}
		if i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == den }); i >= 0 && v.Content.Measures[i].Unit == "days" {
			unit = " a day"
		}
	}
	var ranked []rca.Ranked
	switch {
	case m.Rule.Type == domain.RuleChange && numOK:
		cur, _, err := contribs(numM, per)
		if err != nil {
			return err
		}
		var prior []records.Contribution
		if m.Rule.Compare == domain.ComparePriorPeriod {
			if prior, _, err = contribs(numM, e.in.Cal.Prev(per)); err != nil {
				return err
			}
		}
		ranked = rca.RankChange(cur, prior, per1)
	case ratio && numOK && denOK && engine.ChartKind(m) == "money_plan":
		actual, _, err := contribs(numM, per)
		if err != nil {
			return err
		}
		planned, _, err := contribs(denM, per)
		if err != nil {
			return err
		}
		ranked = rca.RankOverPlan(rca.PlanOverruns(planned, actual))
	case ratio && numOK && denOK && strings.HasPrefix(m.Format, "percent") && m.Direction != domain.DirectionLowerBetter:
		met, _, err := contribs(numM, per)
		if err != nil {
			return err
		}
		all, pending, err := contribs(denM, per)
		if err != nil {
			return err
		}
		// A record can count more than once in a period (two commitments due
		// in it), so misses are the denominator's entries beyond what the
		// numerator counts per record, met ones matched first.
		hits := map[[2]string]int{}
		for _, c := range met {
			if c.Amount > 0 {
				hits[[2]string{c.Source, c.ExternalID}]++
			}
		}
		missed := func(c records.Contribution) bool {
			return c.Reason == records.ReasonMissed || c.Reason == records.ReasonSlipped
		}
		var misses []records.Contribution
		denominator := 0
		for _, late := range []bool{false, true} {
			for _, c := range all {
				if c.Amount <= 0 || missed(c) != late {
					continue
				}
				denominator++
				if id := [2]string{c.Source, c.ExternalID}; hits[id] > 0 {
					hits[id]--
					continue
				}
				misses = append(misses, c)
			}
		}
		rt, _ := e.recordType(denM.Derive.RecordType)
		noun := rca.Nouns(rt.Name, "record").Many
		ranked = rca.RankRatio(misses, rt.AllPriorities())
		for i := range ranked {
			ranked[i].ImpactDisplay = ""
		}
		gin.Records = &rca.RecordSummary{Noun: noun, Misses: len(misses), Denominator: denominator}
		summary := fmt.Sprintf("%d of %d %s missed", len(misses), denominator, noun)
		if pending > 0 && per.Grain == period.Month {
			summary += fmt.Sprintf(" · %d still due this month", pending)
		}
		out.RecordsSummary = &summary
	default:
		ms := measures[0]
		if numOK {
			ms = numM
		}
		cs, _, err := contribs(ms, per)
		if err != nil {
			return err
		}
		ranked = rca.RankAmounts(per1, cs)
	}
	for _, r := range ranked {
		rec := RcaRecord{Contribution: apiContribution(r.C, subjectOf[[2]string{r.C.Source, r.C.ExternalID}]), Note: r.Note}
		if r.ImpactDisplay != "" {
			s := r.ImpactDisplay + unit
			rec.ImpactDisplay = &s
		}
		out.Records = append(out.Records, rec)
	}
	return nil
}

// ---- text ----------------------------------------------------------------------

func sum(xs []float64) float64 {
	t := 0.0
	for _, x := range xs {
		t += x
	}
	return t
}

func fixedDec(v float64, d int) string { return strconv.FormatFloat(v, 'f', max(d, 0), 64) }

// trimNumber formats v with at most d decimals and no trailing zeros.
func trimNumber(v float64, d int) string {
	s := fixedDec(v, d)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" {
		return "0"
	}
	return s
}

func joinNonEmpty(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " · ")
}

// httpsOnly keeps an https URL and drops any other.
func httpsOnly(u string) string {
	if len(u) >= 8 && strings.EqualFold(u[:8], "https://") {
		return u
	}
	return ""
}

// periodLabel names a period in a note: Oct for a month, else 2026-Q4.
func periodLabel(cal period.Calendar, p period.Period) string {
	if p.Grain == period.Month {
		return cal.Start(p).Format("Jan")
	}
	return p.String()
}

// ---- threshold text --------------------------------------------------------------

// band runs, as the web's statusText intervals: a run of values sharing one
// status, from lo to hi (infinite at the open ends).
type bandRun struct {
	status     string
	lo, hi     float64
	loIn, hiIn bool
}

func ruleBands(rule domain.StatusRule) []domain.Band {
	if rule.Type == domain.RuleScale {
		steps := slices.Clone(rule.Scale)
		slices.SortFunc(steps, func(a, b domain.ScaleStep) int { return cmp.Compare(b.Min, a.Min) })
		out := make([]domain.Band, 0, len(steps))
		for _, s := range steps {
			out = append(out, domain.Band{Status: s.Status, Op: ">=", Value: s.Min})
		}
		return out
	}
	return rule.Bands
}

func evalBands(bands []domain.Band, v float64) string {
	for _, b := range bands {
		switch {
		case b.Op == "", b.Op == ">=" && v >= b.Value, b.Op == ">" && v > b.Value, b.Op == "<=" && v <= b.Value, b.Op == "<" && v < b.Value:
			return b.Status
		}
	}
	return ""
}

func bandRuns(bands []domain.Band) []bandRun {
	var cuts []float64
	for _, b := range bands {
		if b.Op != "" && !slices.Contains(cuts, b.Value) {
			cuts = append(cuts, b.Value)
		}
	}
	slices.Sort(cuts)
	if len(cuts) == 0 {
		return nil
	}
	var pieces []bandRun
	add := func(lo, hi float64, loIn, hiIn bool, probe float64) {
		pieces = append(pieces, bandRun{evalBands(bands, probe), lo, hi, loIn, hiIn})
	}
	add(math.Inf(-1), cuts[0], false, false, cuts[0]-1)
	for i, c := range cuts {
		add(c, c, true, true, c)
		if i+1 == len(cuts) {
			add(c, math.Inf(1), false, false, c+1)
		} else {
			add(c, cuts[i+1], false, false, (c+cuts[i+1])/2)
		}
	}
	var merged []bandRun
	for _, p := range pieces {
		if n := len(merged); n > 0 && merged[n-1].status == p.status {
			merged[n-1].hi, merged[n-1].hiIn = p.hi, p.hiIn
			continue
		}
		merged = append(merged, p)
	}
	return slices.DeleteFunc(merged, func(r bandRun) bool { return r.status == "" })
}

// thresholdValue formats a threshold in the metric's format, with the
// decimals it needs when it is finer than the format shows.
func thresholdValue(format string, v float64) string {
	need := 2
	for d := range 2 {
		s := v * math.Pow10(d)
		if math.Abs(s-math.Round(s)) < 1e-9 {
			need = d
			break
		}
	}
	for _, p := range []string{"percent", "number"} {
		if rest, ok := strings.CutPrefix(format, p); ok {
			if have, err := strconv.Atoi(rest); err == nil && need > have {
				return engine.Format(p+strconv.Itoa(need), v)
			}
		}
	}
	return engine.Format(format, v)
}

func pctText(n float64) string { return trimNumber(math.Abs(n), 1) + "%" }

func changeRangeText(r bandRun) string {
	switch {
	case math.IsInf(r.hi, 1):
		switch {
		case r.lo == 0:
			return "any improvement"
		case r.lo > 0 && r.loIn:
			return pctText(r.lo) + " better or more"
		case r.lo > 0:
			return "more than " + pctText(r.lo) + " better"
		case r.loIn:
			return "no more than " + pctText(r.lo) + " worse"
		}
		return "less than " + pctText(r.lo) + " worse"
	case math.IsInf(r.lo, -1):
		switch {
		case r.hi == 0 && r.hiIn:
			return "no change or worse"
		case r.hi == 0:
			return "any decline"
		case r.hi < 0 && r.hiIn:
			return pctText(r.hi) + " worse or more"
		case r.hi < 0:
			return "more than " + pctText(r.hi) + " worse"
		case r.hiIn:
			return "up to " + pctText(r.hi) + " better or worse"
		}
		return "less than " + pctText(r.hi) + " better or worse"
	case r.hi <= 0:
		if r.hi == 0 {
			return "up to " + pctText(r.lo) + " worse"
		}
		return pctText(r.hi) + " to " + pctText(r.lo) + " worse"
	case r.lo >= 0:
		if r.lo == 0 {
			return "up to " + pctText(r.hi) + " better"
		}
		return pctText(r.lo) + " to " + pctText(r.hi) + " better"
	}
	return "between " + pctText(r.lo) + " worse and " + pctText(r.hi) + " better"
}

// thresholdText is the sentence that decides a cell's status, as the web's
// thresholdText writes it at the focus surface (dashboard §3.5): "Green at
// 99.90% or better", "Lower is better · Yellow above 450 · Red above 600",
// "Lower is better · judged on change vs the prior month · Green: any
// improvement · …", prefixed "Reported quarterly" for coarse metrics. The
// rule is the cell's own (per-subject bands applied).
func thresholdText(m domain.Metric, rule domain.StatusRule, label func(string) string) string {
	var parts []string
	switch m.Frequency {
	case domain.FrequencyQuarterly:
		parts = append(parts, "Reported quarterly")
	case domain.FrequencyBiannual:
		parts = append(parts, "Reported twice a year")
	case domain.FrequencyAnnual:
		parts = append(parts, "Reported yearly")
	}
	chart := engine.ChartKind(m)
	direction := "Higher is better"
	if m.Direction == domain.DirectionLowerBetter {
		switch chart {
		case "days":
			direction = "Fewer days is better"
		case "money_plan":
			direction = "Under plan is fine"
		default:
			direction = "Lower is better"
		}
	}
	runs := bandRuns(ruleBands(rule))
	if rule.Type == domain.RuleChange {
		unit := map[domain.Frequency]string{domain.FrequencyMonthly: "month", domain.FrequencyQuarterly: "quarter",
			domain.FrequencyBiannual: "half", domain.FrequencyAnnual: "year"}[m.Frequency]
		against := "the prior " + cmp.Or(unit, "month")
		switch rule.Compare {
		case domain.ComparePriorYearAverage:
			against = "the prior year's average"
		case domain.CompareBaseline:
			against = "the baseline"
		}
		parts = append(parts, direction, "judged on change vs "+against)
		for i := len(runs) - 1; i >= 0; i-- {
			parts = append(parts, label(runs[i].status)+": "+changeRangeText(runs[i]))
		}
		return strings.Join(parts, " · ")
	}
	if m.Direction == domain.DirectionLowerBetter {
		parts = append(parts, direction)
	}
	return strings.Join(append(parts, bandClauses(runs, m.Format, m.Direction, chart, label)...), " · ")
}

func bandClauses(runs []bandRun, format string, dir domain.Direction, chart string, label func(string) string) []string {
	if len(runs) < 2 {
		return nil
	}
	value := func(v float64) string { return thresholdValue(format, v) }
	lowest, highest := runs[0], runs[len(runs)-1]
	bestOnly := chart == "uptime"
	pick := func(in bool, yes, no string) string {
		if in {
			return yes
		}
		return no
	}
	if dir != domain.DirectionLowerBetter {
		best := label(highest.status) + " " + pick(highest.loIn, "at "+value(highest.lo)+" or better", "above "+value(highest.lo))
		if bestOnly {
			return []string{best}
		}
		return []string{best, label(lowest.status) + " " + pick(lowest.hiIn, "at "+value(lowest.hi)+" or below", "below "+value(lowest.hi))}
	}
	if chart == "days" {
		best := label(lowest.status) + " " + pick(lowest.hiIn, "at "+value(lowest.hi)+" or fewer", "below "+value(lowest.hi))
		if bestOnly {
			return []string{best}
		}
		return []string{best, label(highest.status) + " " + pick(highest.loIn, "at "+value(highest.lo)+" or more", "above "+value(highest.lo))}
	}
	if bestOnly {
		return []string{label(lowest.status) + " " + pick(lowest.hiIn, "at "+value(lowest.hi)+" or below", "below "+value(lowest.hi))}
	}
	var out []string
	for _, r := range runs[1:] {
		out = append(out, label(r.status)+" "+pick(r.loIn, "at "+value(r.lo)+" or above", "above "+value(r.lo)))
	}
	return out
}

// GetCellAttribution is one cell's attribution card. Any member who may read
// the cell; the metric's exec summary comes along only for readers of the
// company cell.
func (s *Server) GetCellAttribution(ctx context.Context, req GetCellAttributionRequestObject) (GetCellAttributionResponseObject, error) {
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
	var c attributionCursors
	cursor := func(path string, v *string) *int {
		if v == nil || *v == "" {
			return nil
		}
		n, err := strconv.Atoi(*v)
		if err != nil || n < 0 {
			pr.add(path, "must be the %s of an earlier page", path)
			return nil
		}
		return &n
	}
	c.incidents = cursor("incidentsCursor", q.IncidentsCursor)
	c.records = cursor("recordsCursor", q.RecordsCursor)
	if c.incidents != nil && c.records != nil {
		pr.add("recordsCursor", "send incidentsCursor or recordsCursor, not both")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	e, err := s.newExplainer(ctx, p, sc.ID, []period.Period{per}, explainOpts{})
	if err != nil {
		return nil, err
	}
	a, err := e.attribution(q.Metric, q.Subject, per, depthFull, c)
	if err != nil {
		return nil, err
	}
	return GetCellAttribution200JSONResponse(a), nil
}
