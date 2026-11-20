package recordimport

import (
	"fmt"
	"maps"
	"math"
	"reflect"
	"slices"
	"sort"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/period"
	"opsvision/internal/rca"
	"opsvision/internal/records"
	"opsvision/internal/store"
)

// Reasons a record changes a story line.
const (
	ReasonSlipped         = "slipped"
	ReasonMet             = "met"
	ReasonMissed          = "missed"
	ReasonNewlyOpen       = "newly_open"
	ReasonClosed          = "closed"
	ReasonPriorityChanged = "priority_changed"
	ReasonAdded           = "added"
	ReasonRemoved         = "removed"
)

// maxStoryLines is how many lines a story lists before counting the rest.
const maxStoryLines = 50

// StoryLine is one metric cell the import changes. Reasons lists, by reason,
// the records whose part in the cell changed (their contributions after the
// import, or before it for removed ones).
type StoryLine struct {
	Period                                                                                                period.Period
	MetricKey, MetricName, SubjectID, SubjectName, BeforeDisplay, AfterDisplay, BeforeStatus, AfterStatus string
	Reasons                                                                                               map[string][]records.Contribution
}

// TypedVsRecords is a typed value for a derived measure next to the value
// records give, with the records behind it.
type TypedVsRecords struct {
	CellRef
	Typed         float64
	TypedSource   string
	Records       float64
	Contributions []records.Contribution
}

// IncidentLine is one cell whose incidents an import changes, for a metric
// incidents explain the downtime of: how many incidents count minutes in it,
// the minutes they explain, and the whole minutes of downtime the cell
// reports (nil when it has no value). Text is the line as the preview shows
// it: "Oct · Webhooks · 3 incidents explain 6h 20m of 7h 00m reported".
type IncidentLine struct {
	Period                            period.Period
	MetricKey, SubjectID, SubjectName string
	Incidents                         int
	Explained                         float64
	Reported                          *int
	Text                              string
}

// Story is what an import changes on the scorecard. Lines are ordered by
// status change (worse first), then by how much the value moves; More counts
// lines beyond the first 50. Incidents lists the cells whose incidents the
// import changes, by period, metric and subject name; IncidentsMore counts
// those beyond the first 50. Typed lists, for each subject and period where a
// typed value disagrees with records, every typed derived measure there.
// LockedWaiting is empty in phase 1, which has no month lock.
//
// NothingChanged is true only when applying would change nothing at all,
// not even how far the data runs. SameRecords is true when the upload has
// no new or changed records but runs later than the last upload from its
// source, whose as-of date is PreviousAsOf. Warnings say, in plain
// language, what derivation worked around (a priority with no weight) or
// could not derive. Rows still waiting for an answer rule out SameRecords.
type Story struct {
	NothingChanged bool
	SameRecords    bool
	PreviousAsOf   *domain.Date
	Lines          []StoryLine
	More           int
	Incidents      []IncidentLine
	IncidentsMore  int
	Typed          []TypedVsRecords
	LockedWaiting  []StoryLine
	Warnings       []string
}

type storyInput struct {
	tenant                domain.Tenant
	before, after         *world
	data                  []domain.DataPoint
	overrides             []domain.Override
	cur                   map[CellRef]domain.DataPoint
	use                   map[CellRef]bool
	wantBefore, wantAfter derived
	writes                []store.DataWrite
	newIDs                map[string]bool
}

type metricCell struct {
	metric, subject string
	p               period.Period
}

// scoredLine is a story line with the values it is ordered by.
type scoredLine struct {
	StoryLine
	before, after *float64
}

func buildStory(in storyInput) (Story, error) {
	s := Story{Typed: typedVsRecords(in)}
	var err error
	if s.Incidents, s.IncidentsMore, err = incidentLines(in); err != nil {
		return s, err
	}
	if len(in.writes) == 0 {
		return s, nil
	}
	w := in.after

	// The metric cells the writes reach: metrics at the write's grain whose
	// formulas use the written measure, for the subject and everything it
	// rolls up into.
	affected := map[metricCell]domain.Metric{}
	subjects, periods := map[string]bool{}, map[period.Period]bool{}
	uses := map[string]map[string][]domain.Metric{}
	for _, wr := range in.writes {
		p := wr.Point.Period
		v, ok := w.versionFor(p)
		if !ok {
			continue
		}
		if _, done := uses[v.ID]; !done {
			uses[v.ID] = metricUses(v)
		}
		month, ok := lastMonth(w.cal, p)
		if !ok {
			continue
		}
		chain := rollsInto(w, wr.Point.SubjectID, month)
		for _, m := range uses[v.ID][wr.Point.MeasureKey] {
			if g, ok := grainOf(m.Frequency); !ok || g != p.Grain {
				continue
			}
			for _, sub := range chain {
				affected[metricCell{m.Key, sub, p}] = m
				subjects[sub] = true
			}
			periods[p] = true
		}
	}
	if len(affected) == 0 {
		return s, nil
	}

	vr := engine.ViewRequest{Structure: engine.StructureAsOf}
	for p := range periods {
		vr.Periods = append(vr.Periods, p)
	}
	sort.Slice(vr.Periods, func(i, j int) bool { return store.ComparePeriod(vr.Periods[i], vr.Periods[j]) < 0 })
	for sub := range subjects {
		vr.SubjectIDs = append(vr.SubjectIDs, sub)
	}
	sort.Strings(vr.SubjectIDs)
	versions := w.versions
	if w.draft != nil {
		versions = append(slices.Clone(versions), *w.draft)
		vr.Restate = w.draft.ID
	}

	beforeIn := &engine.Input{Cal: w.cal, Tree: in.before.tree, Items: in.before.items, Versions: versions,
		Data: in.data, Overrides: in.overrides}
	afterIn := &engine.Input{Cal: w.cal, Tree: w.tree, Items: w.items, Versions: versions,
		Data: mergeWrites(in.data, in.writes), Overrides: in.overrides}
	beforeView, err := engine.Compute(beforeIn, vr)
	if err != nil {
		return s, err
	}
	afterView, err := engine.Compute(afterIn, vr)
	if err != nil {
		return s, err
	}
	type rowCell struct {
		cell engine.Cell
		name string
	}
	index := func(v engine.View) map[metricCell]rowCell {
		out := map[metricCell]rowCell{}
		for _, row := range v.Rows {
			for j, c := range row.Cells {
				out[metricCell{row.MetricKey, row.SubjectID, vr.Periods[j]}] = rowCell{c, row.SubjectName}
			}
		}
		return out
	}
	bc, ac := index(beforeView), index(afterView)

	var lines []scoredLine
	for k, m := range affected {
		b, hasB := bc[k]
		a, hasA := ac[k]
		if !hasB && !hasA {
			continue
		}
		if b.cell.Display == a.cell.Display && b.cell.Status == a.cell.Status && b.cell.NAReason == a.cell.NAReason {
			continue
		}
		name := a.name
		if !hasA {
			name = b.name
		}
		lines = append(lines, scoredLine{
			StoryLine: StoryLine{
				Period: k.p, MetricKey: k.metric, MetricName: m.Name, SubjectID: k.subject, SubjectName: name,
				BeforeDisplay: b.cell.Display, AfterDisplay: a.cell.Display,
				BeforeStatus: b.cell.Status, AfterStatus: a.cell.Status,
				Reasons: in.lineReasons(m, k),
			},
			before: b.cell.Value, after: a.cell.Value,
		})
	}
	s.Lines, s.More = orderLines(lines, statusRanks(in.tenant), maxStoryLines)
	return s, nil
}

// lastMonth is the last month of p.
func lastMonth(cal period.Calendar, p period.Period) (period.Period, bool) {
	ms := cal.Months(p)
	if len(ms) == 0 {
		return period.Period{}, false
	}
	return ms[len(ms)-1], true
}

// rollsInto lists a subject and everything it rolls up into as of month: for
// an item, the item, its unit and the unit's ancestors; for a unit, the unit
// and its ancestors.
func rollsInto(w *world, subjectID string, month period.Period) []string {
	out := []string{subjectID}
	unit := subjectID
	if _, ok := w.tree.Unit(subjectID); !ok {
		unit = ""
		for _, it := range w.items {
			if it.ID == subjectID {
				unit = it.OrgUnitID
			}
		}
		if unit == "" {
			return out
		}
		out = append(out, unit)
	}
	for steps := 0; steps <= len(w.units); steps++ {
		parent, ok := w.tree.ParentAt(unit, month)
		if !ok || parent == "" {
			break
		}
		out = append(out, parent)
		unit = parent
	}
	return out
}

// mergeWrites returns data with the writes applied: a write replaces the
// point in its slot, and a delete removes it.
func mergeWrites(data []domain.DataPoint, writes []store.DataWrite) []domain.DataPoint {
	written := make(map[CellRef]bool, len(writes))
	for _, wr := range writes {
		written[refOf(wr.Point)] = true
	}
	out := make([]domain.DataPoint, 0, len(data)+len(writes))
	for _, dp := range data {
		if !written[refOf(dp)] {
			out = append(out, dp)
		}
	}
	for _, wr := range writes {
		if wr.Delete {
			continue
		}
		dp := wr.Point
		dp.Revision = 1
		out = append(out, dp)
	}
	return out
}

// contributorsOf lists the subjects whose derived values make up subject's
// value as of month: the subject, the units below it, and, when the metric
// rolls items into the org, the items attached to any of them.
func contributorsOf(w *world, subjectID string, month period.Period, rollItems bool) []string {
	out := []string{subjectID}
	if _, ok := w.tree.Unit(subjectID); !ok {
		return out
	}
	out = append(out, w.tree.DescendantsAt(subjectID, month)...)
	if rollItems {
		units := map[string]bool{}
		for _, id := range out {
			units[id] = true
		}
		for _, it := range w.items {
			if units[it.OrgUnitID] {
				out = append(out, it.ID)
			}
		}
	}
	return out
}

// lineReasons diffs, for each derived measure in m's formula, the
// contributions behind cell k before and after the import, and merges the
// reasons. A record is listed once per reason.
func (in storyInput) lineReasons(m domain.Metric, k metricCell) map[string][]records.Contribution {
	v, ok := in.after.versionFor(k.p)
	month, okm := lastMonth(in.after.cal, k.p)
	if !ok || !okm {
		return nil
	}
	ids, err := formula.Identifiers(m.Formula)
	if err != nil {
		return nil
	}
	derivedKeys := map[string]bool{}
	for _, ms := range v.Content.Measures {
		if isDerived(ms) {
			derivedKeys[ms.Key] = true
		}
	}
	subjects := contributorsOf(in.after, k.subject, month, m.RollItemsToOrg)
	out := map[string][]records.Contribution{}
	seen := map[string]map[string]bool{}
	for _, id := range ids {
		if !derivedKeys[id] {
			continue
		}
		var before, after []records.Contribution
		for _, sub := range subjects {
			ref := CellRef{id, sub, k.p}
			before = append(before, in.wantBefore[ref].Contributions...)
			after = append(after, in.wantAfter[ref].Contributions...)
		}
		for reason, cs := range contributionReasons(before, after, in.newIDs) {
			if seen[reason] == nil {
				seen[reason] = map[string]bool{}
			}
			for _, c := range cs {
				if ck := contributionKey(c); !seen[reason][ck] {
					seen[reason][ck] = true
					out[reason] = append(out[reason], c)
				}
			}
		}
	}
	for _, cs := range out {
		sort.SliceStable(cs, func(i, j int) bool {
			if cs[i].Source != cs[j].Source {
				return cs[i].Source < cs[j].Source
			}
			return cs[i].ExternalID < cs[j].ExternalID
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// contributionKey identifies one record's part in a cell: the record, and for
// commitments the due date judged (a record can have two in one quarter).
func contributionKey(c records.Contribution) string {
	return identity(c.Source, c.ExternalID) + "/" + c.Dates["dueAt"].String()
}

func samePriority(a, b string) bool {
	norm := func(s string) string {
		if s == domain.PriorityNone {
			return ""
		}
		return s
	}
	return norm(a) == norm(b)
}

// contributionReasons says why each record's part in a cell changed, given
// its contributions before and after. Pending commitments count for nothing
// yet and are ignored. newIDs holds the source/externalId of records the
// import creates. In order of precedence: a commitment now slipped, met or
// missed; a priority change; a record no longer open (closed); a new
// contribution from a new open record (newly_open) or otherwise (added); a
// contribution gone (removed). A record whose part only grew or shrank (an
// open defect's days) has no reason.
func contributionReasons(before, after []records.Contribution, newIDs map[string]bool) map[string][]records.Contribution {
	index := func(cs []records.Contribution) ([]string, map[string]records.Contribution) {
		var order []string
		out := map[string]records.Contribution{}
		for _, c := range cs {
			if c.Reason == records.ReasonPending {
				continue
			}
			k := contributionKey(c)
			if _, dup := out[k]; !dup {
				order = append(order, k)
			}
			out[k] = c
		}
		return order, out
	}
	bOrder, bs := index(before)
	aOrder, as := index(after)
	out := map[string][]records.Contribution{}
	for _, k := range aOrder {
		a := as[k]
		b, had := bs[k]
		switch {
		case (a.Reason == records.ReasonSlipped || a.Reason == records.ReasonMet || a.Reason == records.ReasonMissed) && (!had || b.Reason != a.Reason):
			out[a.Reason] = append(out[a.Reason], a)
		case had && !samePriority(b.Priority, a.Priority):
			out[ReasonPriorityChanged] = append(out[ReasonPriorityChanged], a)
		case had && b.State == domain.StateOpen && a.State != domain.StateOpen:
			out[ReasonClosed] = append(out[ReasonClosed], a)
		case !had && newIDs[identity(a.Source, a.ExternalID)] && a.State == domain.StateOpen:
			out[ReasonNewlyOpen] = append(out[ReasonNewlyOpen], a)
		case !had:
			out[ReasonAdded] = append(out[ReasonAdded], a)
		}
	}
	for _, k := range bOrder {
		if _, ok := as[k]; !ok {
			out[ReasonRemoved] = append(out[ReasonRemoved], bs[k])
		}
	}
	return out
}

// statusRanks maps the tenant's status keys to their rank (higher is worse).
func statusRanks(t domain.Tenant) map[string]int {
	scale := t.StatusScale
	if len(scale) == 0 {
		scale = domain.DefaultStatusScale()
	}
	out := make(map[string]int, len(scale))
	for _, l := range scale {
		out[l.Key] = l.Rank
	}
	return out
}

// orderLines sorts lines that got worse first (most ranks first), then lines
// that got better (most ranks first), then lines whose status did not change
// or was not judged on both sides; within each, by how much the value moved
// (a value appearing or disappearing moves most), then by period, metric and
// subject. It returns at most limit lines and the number left out.
func orderLines(ls []scoredLine, ranks map[string]int, limit int) ([]StoryLine, int) {
	delta := func(l scoredLine) int {
		b, okb := ranks[l.BeforeStatus]
		a, oka := ranks[l.AfterStatus]
		if !okb || !oka {
			return 0
		}
		return a - b
	}
	group := func(d int) int {
		switch {
		case d > 0:
			return 0
		case d < 0:
			return 1
		}
		return 2
	}
	moved := func(l scoredLine) float64 {
		if l.before == nil || l.after == nil {
			if l.before == nil && l.after == nil {
				return 0
			}
			return math.Inf(1)
		}
		return math.Abs(*l.after - *l.before)
	}
	sort.SliceStable(ls, func(i, j int) bool {
		a, b := ls[i], ls[j]
		da, db := delta(a), delta(b)
		if ga, gb := group(da), group(db); ga != gb {
			return ga < gb
		}
		if abs(da) != abs(db) {
			return abs(da) > abs(db)
		}
		if ma, mb := moved(a), moved(b); ma != mb {
			return ma > mb
		}
		if c := store.ComparePeriod(a.Period, b.Period); c != 0 {
			return c < 0
		}
		if a.MetricKey != b.MetricKey {
			return a.MetricKey < b.MetricKey
		}
		return a.SubjectID < b.SubjectID
	})
	out := make([]StoryLine, 0, min(len(ls), limit))
	for i := 0; i < len(ls) && i < limit; i++ {
		out = append(out, ls[i].StoryLine)
	}
	return out, len(ls) - len(out)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Text says how many file rows read and, when rows fan out to several
// subjects, how many records they make: "6 rows → 7 records".
func (c RowCounts) Text() string {
	s := countNoun(c.Source, "row", "rows")
	if c.Records != c.Source {
		s += " → " + countNoun(c.Records, "record", "records")
	}
	return s
}

func countNoun(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// maxIncidentMonths bounds the months one incident is placed in.
const maxIncidentMonths = 36

// downtimeLink is an explain link that counts downtime, with its condition
// compiled.
type downtimeLink struct {
	domain.ExplainLink
	cond *records.Cond
}

// downtimeLinks returns rt's downtime links to scorecard sc whose conditions
// compile.
func downtimeLinks(rt domain.RecordType, sc string) []downtimeLink {
	var out []downtimeLink
	for _, l := range rt.Explains {
		if l.ScorecardID != sc || l.Mode != domain.ExplainDowntime {
			continue
		}
		cond, err := records.CompileWhere(l.Where, rt)
		if err != nil {
			continue
		}
		out = append(out, downtimeLink{l, cond})
	}
	return out
}

// scorecardOf is the scorecard the world's methodology belongs to.
func scorecardOf(w *world) string {
	if w.draft != nil {
		return w.draft.ScorecardID
	}
	if len(w.versions) > 0 {
		return w.versions[0].ScorecardID
	}
	return ""
}

// sourceCutoffs returns, by source, the instant incidents are counted to:
// the latest as-of date of the source's snapshots, or of its records'
// revisions (which include the plan's), plus a day.
func sourceCutoffs(snaps []domain.Snapshot, recs []domain.Record) map[string]time.Time {
	latest := map[string]time.Time{}
	see := func(source string, d domain.Date) {
		if d.Time.After(latest[source]) {
			latest[source] = d.Time
		}
	}
	for _, s := range snaps {
		see(s.Source, s.AsOf)
	}
	for _, r := range recs {
		for _, rv := range r.Revisions {
			see(r.Source, rv.AsOf)
		}
	}
	out := make(map[string]time.Time, len(latest))
	for src, d := range latest {
		out[src] = rca.Cutoff(domain.Date{Time: d})
	}
	return out
}

// placeIncident reads a record's fields as an incident and resolves its
// subject in the month it started (else the month it was created). ok is
// false when its times do not read or its subject does not resolve to one
// subject.
func placeIncident(res *records.Resolver, cal period.Calendar, r domain.Record, f domain.RecordFields, cutoff time.Time) (rca.Incident, bool) {
	inc, err := rca.FromRecord(r.Source, r.ExternalID, f, cutoff)
	if err != nil {
		return rca.Incident{}, false
	}
	at := f.CreatedAt.Time
	if inc.Start != nil {
		at = *inc.Start
	}
	subject, problem := res.Resolve(f.SubjectKey, cal.MonthOf(at))
	if problem != "" {
		return rca.Incident{}, false
	}
	inc.SubjectID = subject
	return inc, true
}

// incidentMonths lists the months an incident can count minutes in: from
// its start through its end, an ongoing one through its cutoff, one done
// without an end through its completion day; one with only a duration, or
// no times, in the month of its start (else of its creation).
func incidentMonths(cal period.Calendar, inc rca.Incident) []period.Period {
	start := inc.CreatedAt.Time
	if inc.Start != nil {
		start = *inc.Start
	}
	end := start
	switch {
	case inc.Start == nil || inc.Minutes != nil && inc.End == nil:
	case inc.End != nil:
		end = *inc.End
	case inc.State == domain.StateOpen && !inc.Cutoff.IsZero():
		end = inc.Cutoff
	case inc.CompletedAt != nil:
		end = inc.CompletedAt.Time.AddDate(0, 0, 1)
	}
	if !inc.Cutoff.IsZero() && end.After(inc.Cutoff) {
		end = inc.Cutoff
	}
	first := cal.MonthOf(start)
	last := first
	if end.After(start) {
		last = cal.MonthOf(end.Add(-time.Nanosecond))
	}
	out := []period.Period{first}
	for m := first; store.ComparePeriod(m, last) < 0 && len(out) < maxIncidentMonths; {
		m = next(m)
		out = append(out, m)
	}
	return out
}

// incidentLines lists the cells whose incidents the import changes. For each
// record type with downtime links to the scorecard, every record the import
// adds or changes is placed, as it was and as it will be, at the subject it
// resolves to in each month it overlaps (cancelled incidents place nothing),
// for each link whose condition it meets. Each such cell, at its metric's
// grain, then counts every incident it has after the import against the
// downtime it reports. At most 50 lines are listed; the rest are counted.
func incidentLines(in storyInput) ([]IncidentLine, int, error) {
	w := in.after
	sc := scorecardOf(w)
	if sc == "" {
		return nil, 0, nil
	}
	type cellKey struct {
		metric, subject string
		p               period.Period
	}
	key := func(r domain.Record) string { return r.Type + "\x00" + identity(r.Source, r.ExternalID) }
	before := map[string]domain.Record{}
	for _, r := range in.before.records {
		before[key(r)] = r
	}
	res := records.NewResolver(records.DeriveInput{Cal: w.cal, Tree: w.tree, Items: w.items})
	incs := map[string]map[string][]rca.Incident{}
	downMeasure := map[string]string{}
	months := map[cellKey]bool{}
	for _, rt := range w.types {
		links := downtimeLinks(rt, sc)
		if len(links) == 0 {
			continue
		}
		var recs []domain.Record
		touched := map[int]bool{}
		for _, r := range w.records {
			if r.Type != rt.ID {
				continue
			}
			if b, had := before[key(r)]; !had || !reflect.DeepEqual(b.Revisions, r.Revisions) {
				touched[len(recs)] = true
			}
			recs = append(recs, r)
		}
		if len(touched) == 0 {
			continue
		}
		cutoff := sourceCutoffs(in.before.snapshots[rt.ID], recs)
		place := func(r domain.Record, f domain.RecordFields, count, mark bool) {
			inc, ok := placeIncident(res, w.cal, r, f, cutoff[r.Source])
			if !ok {
				return
			}
			for _, l := range links {
				if ok, err := l.cond.Match(f); err != nil || !ok {
					continue
				}
				if count {
					if incs[l.MetricKey] == nil {
						incs[l.MetricKey] = map[string][]rca.Incident{}
					}
					incs[l.MetricKey][inc.SubjectID] = append(incs[l.MetricKey][inc.SubjectID], inc)
				}
				if mark && inc.State != domain.StateCancelled {
					for _, m := range incidentMonths(w.cal, inc) {
						months[cellKey{l.MetricKey, inc.SubjectID, m}] = true
					}
				}
			}
		}
		for i, r := range recs {
			place(r, records.Latest(r), true, touched[i])
			if b, had := before[key(r)]; had && touched[i] {
				place(b, records.Latest(b), false, true)
			}
		}
		for _, l := range links {
			if downMeasure[l.MetricKey] == "" {
				downMeasure[l.MetricKey] = l.DownMeasure
			}
		}
	}
	if len(months) == 0 {
		return nil, 0, nil
	}

	// Each month at the grain its metric reports at, under the version in force.
	type target struct {
		m domain.Metric
		v domain.MethodologyVersion
	}
	cells := map[cellKey]target{}
	periods, subjects, metrics := map[period.Period]bool{}, map[string]bool{}, map[string]bool{}
	for k := range months {
		v, ok := w.versionFor(k.p)
		if !ok {
			continue
		}
		mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == k.metric })
		if mi < 0 {
			continue
		}
		m := v.Content.Metrics[mi]
		g, ok := grainOf(m.Frequency)
		if !ok {
			continue
		}
		p := k.p
		if g != period.Month {
			p = w.cal.Parent(k.p, g)
		}
		cells[cellKey{k.metric, k.subject, p}] = target{m, v}
		periods[p], subjects[k.subject], metrics[k.metric] = true, true, true
	}
	if len(cells) == 0 {
		return nil, 0, nil
	}
	vr := engine.ViewRequest{Structure: engine.StructureAsOf,
		Periods: slices.SortedFunc(maps.Keys(periods), store.ComparePeriod), SubjectIDs: slices.Sorted(maps.Keys(subjects)),
		MetricKeys: slices.Sorted(maps.Keys(metrics))}
	versions := w.versions
	if w.draft != nil {
		versions = append(slices.Clone(versions), *w.draft)
		vr.Restate = w.draft.ID
	}
	view, err := engine.Compute(&engine.Input{Cal: w.cal, Tree: w.tree, Items: w.items, Versions: versions,
		Data: mergeWrites(in.data, in.writes), Overrides: in.overrides}, vr)
	if err != nil {
		return nil, 0, err
	}

	var out []IncidentLine
	for _, row := range view.Rows {
		for j, c := range row.Cells {
			k := cellKey{row.MetricKey, row.SubjectID, vr.Periods[j]}
			t, ok := cells[k]
			if !ok {
				continue
			}
			win := rca.PeriodWindow(w.cal, k.p, time.UTC)
			l := IncidentLine{Period: k.p, MetricKey: k.metric, SubjectID: k.subject, SubjectName: row.SubjectName}
			reported := 0.0
			if c.Value != nil {
				if mins, ok := reportedMinutes(t.v, t.m, c, downMeasure[k.metric], win.Minutes()); ok {
					l.Reported, reported = &mins, float64(mins)
				}
			}
			d := rca.CountDowntime(win, win.Minutes(), reported, incs[k.metric][k.subject])
			for _, it := range d.Items {
				if it.Minutes > 0 {
					l.Incidents++
				}
			}
			l.Explained = d.Explained
			out = append(out, l)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if c := store.ComparePeriod(a.Period, b.Period); c != 0 {
			return c < 0
		}
		if a.MetricKey != b.MetricKey {
			return a.MetricKey < b.MetricKey
		}
		if a.SubjectName != b.SubjectName {
			return a.SubjectName < b.SubjectName
		}
		return a.SubjectID < b.SubjectID
	})
	more := 0
	if len(out) > maxStoryLines {
		out, more = out[:maxStoryLines], len(out)-maxStoryLines
	}
	if len(out) > 0 {
		newest := w.cal.Start(out[len(out)-1].Period).Year()
		for i := range out {
			out[i].Text = incidentText(w.cal, out[i], newest)
		}
	}
	return out, more, nil
}

// incidentText is the line for l: its period (a month by name, with the
// year when it is not the newest line's), subject, the incidents and the
// minutes they explain, and the reported downtime when there is a value.
func incidentText(cal period.Calendar, l IncidentLine, newestYear int) string {
	label := l.Period.String()
	if l.Period.Grain == period.Month {
		start := cal.Start(l.Period)
		label = start.Format("Jan")
		if start.Year() != newestYear {
			label = start.Format("Jan 2006")
		}
	}
	verb := "explain"
	if l.Incidents == 1 {
		verb = "explains"
	}
	s := fmt.Sprintf("%s · %s · %s %s %s", label, l.SubjectName, countNoun(l.Incidents, "incident", "incidents"), verb, rca.Duration(l.Explained))
	if l.Reported != nil {
		s += " of " + rca.Duration(float64(*l.Reported)) + " reported"
	}
	return s
}

// reportedMinutes is a downtime cell's reported downtime in whole minutes:
// the link's down measure from the cell's components, converted by the
// measure's unit (s, min or h), when the cell has it; else the displayed gap
// to 100% as a share of the period.
func reportedMinutes(v domain.MethodologyVersion, m domain.Metric, c engine.Cell, downMeasure string, periodMinutes float64) (int, bool) {
	if raw, ok := c.Components[downMeasure]; ok && downMeasure != "" {
		if i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == downMeasure }); i >= 0 {
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

// typedVsRecords lists typed values of derived measures beside the values
// records give, for every subject and period where at least one typed value
// differs. Slots the admin chose records for are left out: their typed value
// is about to be replaced.
func typedVsRecords(in storyInput) []TypedVsRecords {
	type group struct {
		subject string
		p       period.Period
	}
	byGroup := map[group][]TypedVsRecords{}
	differs := map[group]bool{}
	for k, d := range in.wantAfter {
		dp, ok := in.cur[k]
		if !ok || dp.Source == domain.SourceRecords || dp.Value == nil || in.use[k] {
			continue
		}
		g := group{k.SubjectID, k.Period}
		byGroup[g] = append(byGroup[g], TypedVsRecords{CellRef: k, Typed: *dp.Value, TypedSource: dp.Source,
			Records: d.Value, Contributions: d.Contributions})
		if !sameValue(*dp.Value, d.Value) {
			differs[g] = true
		}
	}
	var out []TypedVsRecords
	for g, tvs := range byGroup {
		if differs[g] {
			out = append(out, tvs...)
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessRef(out[i].CellRef, out[j].CellRef) })
	return out
}
