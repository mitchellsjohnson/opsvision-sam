package recordimport

import (
	"math"
	"slices"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/period"
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

// Story is what an import changes on the scorecard. Lines are ordered by
// status change (worse first), then by how much the value moves; More counts
// lines beyond the first 50. Typed lists, for each subject and period where a
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
