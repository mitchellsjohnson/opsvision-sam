// Package recordimport turns a parsed tracker export into an import plan
// (which records are new, changed or unchanged, what needs the admin's input,
// the derived values that would change, and the story of what changes on the
// scorecard) and applies it. Nothing is stored until Apply.
package recordimport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"opsvision/internal/domain"
	"opsvision/internal/importer"
	"opsvision/internal/period"
	"opsvision/internal/records"
	"opsvision/internal/store"
)

// AuditAction is the audit action recorded when a plan is applied.
const AuditAction = "records.import"

// auditChannel is the channel recorded on the audit entry.
const auditChannel = "import"

// ProblemAmbiguousSubject is a row whose product or team value matches more
// than one subject.
const ProblemAmbiguousSubject = "ambiguous_subject"

// ErrAlreadyApplied is returned by Apply for a plan whose snapshot is already
// stored. It wraps store.ErrConflict.
var ErrAlreadyApplied = fmt.Errorf("the plan was already applied: %w", store.ErrConflict)

// Hooks for tests.
var (
	now   = func() time.Time { return time.Now().UTC() }
	newID = func() string { return ulid.Make().String() }
)

// Answers are the admin's replies to a preview.
//
//   - SourceKeys maps a product or team value to the org unit or tracked item
//     it means; Apply saves each as a source key.
//   - IgnoreValues are product or team values whose rows are skipped.
//   - ValueMaps adds raw-value translations per template field or attribute
//     (for example state: {"Won't Do": "cancelled"}).
//   - DateOrder settles ambiguous dates: "mdy", "dmy", or "" for neither.
//   - UseRecords lists typed slots the derived value should replace.
//   - MarkMissingCancelled cancels records a full export no longer lists.
//   - CreateShared lists parent units that get a "<name> (shared)" child,
//     which takes over the parent's source keys.
type Answers struct {
	SourceKeys           map[string]string
	IgnoreValues         []string
	ValueMaps            map[string]map[string]string
	DateOrder            string /* "mdy"|"dmy"|"" */
	UseRecords           []CellRef
	MarkMissingCancelled bool
	CreateShared         []string
}

// Counts summarizes a plan's rows. Missing counts records, not rows.
type Counts struct{ New, Changed, Unchanged, Skipped, Missing, Unmatched, Errors int }

// ParentMatch is a product or team value that matches a parent unit, with
// the number of rows carrying it.
type ParentMatch struct {
	Value  string
	Rows   int
	UnitID string
}

// Plan is the preview of one import. Revisions and Writes are what Apply
// stores; the rest is what the preview shows.
type Plan struct {
	Snapshot  domain.Snapshot
	Revisions []store.RecordRevisionWrite
	Counts    Counts
	Problems  []records.RowProblem
	Unmatched []records.SubjectSuggestion
	Parents   []ParentMatch
	// NewValues lists, by field, the raw values no map covers.
	NewValues map[string][]records.ValueCount
	// Missing lists the open records a full export no longer has.
	Missing []string
	// ColumnsAdded are the file's columns the template does not use;
	// ColumnsMissing the template's columns the file lacks.
	ColumnsAdded, ColumnsMissing []string
	Writes                       []store.DataWrite
	Story                        Story
}

var dateOrderLayouts = map[string][]string{
	"mdy": {"01/02/2006", "01/02/2006 15:04"},
	"dmy": {"02/01/2006", "02/01/2006 15:04"},
}

var dateFieldNames = []string{"createdAt", "committedAt", "dueAt", "priorDueDates", "completedAt", "measuredAt"}

// cloneTemplate copies t deeply enough to edit its field maps.
func cloneTemplate(t records.Template) records.Template {
	c := t
	cp := func(in map[string]records.FieldMap) map[string]records.FieldMap {
		if in == nil {
			return nil
		}
		out := make(map[string]records.FieldMap, len(in))
		for k, fm := range in {
			fm.Map = maps.Clone(fm.Map)
			fm.DateFormats = slices.Clone(fm.DateFormats)
			out[k] = fm
		}
		return out
	}
	c.Fields, c.Attributes = cp(t.Fields), cp(t.Attributes)
	c.SkipRows = slices.Clone(t.SkipRows)
	return c
}

// withAnswers applies the date order and value answers to a copy of t.
func withAnswers(t records.Template, rt domain.RecordType, ans Answers) (records.Template, error) {
	t = cloneTemplate(t)
	if ans.DateOrder != "" {
		layouts, ok := dateOrderLayouts[ans.DateOrder]
		if !ok {
			return t, fmt.Errorf("date order %q: want mdy or dmy", ans.DateOrder)
		}
		prepend := func(fm records.FieldMap) records.FieldMap {
			fm.DateFormats = append(slices.Clone(layouts), fm.DateFormats...)
			return fm
		}
		for _, name := range dateFieldNames {
			if fm, ok := t.Fields[name]; ok {
				t.Fields[name] = prepend(fm)
			}
		}
		for _, a := range rt.Attributes {
			if fm, ok := t.Attributes[a.Key]; ok && a.Type == domain.AttrDate && (fm.Transform == "" || fm.Transform == records.TransformDate) {
				t.Attributes[a.Key] = prepend(fm)
			}
		}
	}
	for _, field := range slices.Sorted(maps.Keys(ans.ValueMaps)) {
		answers := ans.ValueMaps[field]
		target, attr := t.Fields, false
		fm, ok := t.Fields[field]
		if !ok {
			target, attr = t.Attributes, true
			fm, ok = t.Attributes[field]
		}
		if !ok {
			return t, fmt.Errorf("value answers for %q: the template does not map that field", field)
		}
		if fm.Map == nil {
			// Values that read without a map must keep reading once there is one.
			fm.Map = map[string]string{}
			for _, v := range identityValues(field, attr, rt) {
				fm.Map[v] = v
			}
		}
		for raw, v := range answers {
			fm.Map[raw] = v
		}
		target[field] = fm
	}
	return t, nil
}

// TemplateWithAnswers returns a copy of t that reads the file the way Build
// reads it with ans: the date order's layouts first on every date field and
// date attribute, and the answered values in each field's map. Saving it
// keeps the answers for the next upload.
func TemplateWithAnswers(t records.Template, rt domain.RecordType, ans Answers) (records.Template, error) {
	return withAnswers(t, rt, ans)
}

// identityValues are the values a field accepts as written when it has no map.
func identityValues(field string, attr bool, rt domain.RecordType) []string {
	if attr {
		for _, a := range rt.Attributes {
			if a.Key == field && a.Type == domain.AttrBool {
				return []string{"true", "yes", "y", "1", "t", "x", "false", "no", "n", "0", "f"}
			}
		}
		return nil
	}
	switch field {
	case "priority":
		return rt.AllPriorities()
	case "state":
		return []string{string(domain.StateOpen), string(domain.StateDone), string(domain.StateCancelled)}
	}
	return nil
}

// SharedUnitID is the ID of the "<name> (shared)" child created for a parent unit.
func SharedUnitID(parentID string) string { return parentID + "-shared" }

func normKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func hasKey(keys []string, key string) bool {
	k := normKey(key)
	for _, s := range keys {
		if normKey(s) == k {
			return true
		}
	}
	return false
}

// answeredOrg returns copies of units and items with the answers' shared units
// created and source keys added, as Apply will save them. A source key
// answered for a parent that gets a shared unit goes to the shared unit.
func answeredOrg(units []domain.OrgUnit, items []domain.TrackedItem, levels []domain.Level, ans Answers) ([]domain.OrgUnit, []domain.TrackedItem, error) {
	us := make([]domain.OrgUnit, len(units))
	for i, u := range units {
		u.SourceKeys = slices.Clone(u.SourceKeys)
		us[i] = u
	}
	its := make([]domain.TrackedItem, len(items))
	for i, it := range items {
		it.SourceKeys = slices.Clone(it.SourceKeys)
		its[i] = it
	}
	unitAt := func(id string) int {
		return slices.IndexFunc(us, func(u domain.OrgUnit) bool { return u.ID == id })
	}

	shared := map[string]string{}
	for _, pid := range ans.CreateShared {
		pi := unitAt(pid)
		if pi < 0 {
			return nil, nil, fmt.Errorf("shared unit: org unit %q does not exist", pid)
		}
		sid := SharedUnitID(pid)
		shared[pid] = sid
		si := unitAt(sid)
		if si < 0 {
			us = append(us, domain.OrgUnit{ID: sid, Name: us[pi].Name + " (shared)", LevelID: childLevel(us, levels, us[pi]), ParentID: pid})
			si = len(us) - 1
		}
		for _, k := range us[pi].SourceKeys {
			if !hasKey(us[si].SourceKeys, k) {
				us[si].SourceKeys = append(us[si].SourceKeys, k)
			}
		}
		us[pi].SourceKeys = nil
	}

	for _, key := range slices.Sorted(maps.Keys(ans.SourceKeys)) {
		target := ans.SourceKeys[key]
		if sid, ok := shared[target]; ok {
			target = sid
		}
		k := strings.TrimSpace(key)
		if k == "" {
			return nil, nil, fmt.Errorf("source key for %q is blank", target)
		}
		if i := unitAt(target); i >= 0 {
			if !hasKey(us[i].SourceKeys, k) {
				us[i].SourceKeys = append(us[i].SourceKeys, k)
			}
			continue
		}
		i := slices.IndexFunc(its, func(it domain.TrackedItem) bool { return it.ID == target })
		if i < 0 {
			return nil, nil, fmt.Errorf("source key %q: %q is not an org unit or tracked item", k, target)
		}
		if !hasKey(its[i].SourceKeys, k) {
			its[i].SourceKeys = append(its[i].SourceKeys, k)
		}
	}
	return us, its, nil
}

// childLevel is the level for a new child of parent: that of an existing
// child, else the level one deeper than the parent's, else the parent's.
func childLevel(units []domain.OrgUnit, levels []domain.Level, parent domain.OrgUnit) string {
	ids := []string{}
	byID := map[string]domain.OrgUnit{}
	for _, u := range units {
		if u.ParentID == parent.ID && u.LevelID != "" {
			ids = append(ids, u.ID)
			byID[u.ID] = u
		}
	}
	if len(ids) > 0 {
		sort.Strings(ids)
		return byID[ids[0]].LevelID
	}
	for _, l := range levels {
		if l.ID == parent.LevelID {
			for _, c := range levels {
				if c.Depth == l.Depth+1 {
					return c.ID
				}
			}
		}
	}
	return parent.LevelID
}

// subjectMatch is how a row's product or team value resolves over the
// months of the record's life.
type subjectMatch struct {
	id, problem string
}

type lifeKey struct {
	key      string
	from, to period.Period
}

// matcher resolves product or team values over a record's life.
type matcher struct {
	cal   period.Calendar
	res   *records.Resolver
	cache map[lifeKey]subjectMatch
}

// maxLifeMonths bounds the months a row's value is checked over.
const maxLifeMonths = 1200

// match resolves key for a record whose life runs from month from to month
// to: a parent unit in any month is "parent", else ambiguous in any month is
// "ambiguous", else no match in any month is "unmatched". A match reports
// the subject of the last matched month.
func (m *matcher) match(key string, from, to period.Period) subjectMatch {
	lk := lifeKey{normKey(key), from, to}
	if r, ok := m.cache[lk]; ok {
		return r
	}
	var out subjectMatch
	ambiguous, matched := false, false
	n := 0
	for mo := from; store.ComparePeriod(mo, to) <= 0 && n < maxLifeMonths; mo, n = next(mo), n+1 {
		id, problem := m.res.Resolve(key, mo)
		switch problem {
		case records.SubjectParent:
			out = subjectMatch{id: id, problem: records.SubjectParent}
			m.cache[lk] = out
			return out
		case records.SubjectAmbiguous:
			ambiguous = true
		case "":
			matched, out.id = true, id
		}
	}
	switch {
	case ambiguous:
		out = subjectMatch{problem: records.SubjectAmbiguous}
	case !matched:
		out = subjectMatch{problem: records.SubjectUnmatched}
	}
	m.cache[lk] = out
	return out
}

// life returns the months a row's subject must resolve in: from its creation
// (or the as-of date, if earlier) through the latest of the as-of date, its
// due date, and its completion.
func life(cal period.Calendar, f domain.RecordFields, asOf domain.Date) (from, to period.Period) {
	first, last := asOf, asOf
	if !f.CreatedAt.IsZero() && f.CreatedAt.Before(first) {
		first = f.CreatedAt
	}
	for _, d := range []*domain.Date{f.DueAt, f.CompletedAt} {
		if d != nil && !d.IsZero() && last.Before(*d) {
			last = *d
		}
	}
	from, to = cal.MonthOf(first.Time), cal.MonthOf(last.Time)
	if span := (to.FY-from.FY)*12 + to.Index - from.Index; span >= maxLifeMonths {
		from = to
		for range maxLifeMonths - 1 {
			from = prev(from)
		}
	}
	return from, to
}

func prev(m period.Period) period.Period {
	if m.Index == 1 {
		return period.Period{Grain: period.Month, FY: m.FY - 1, Index: 12}
	}
	return period.Period{Grain: period.Month, FY: m.FY, Index: m.Index - 1}
}

// canonical returns a copy of f in a form where equal records compare equal:
// priority none is empty, and empty lists and maps are nil.
func canonical(f domain.RecordFields) []byte {
	if f.Priority == domain.PriorityNone {
		f.Priority = ""
	}
	if len(f.PriorDueDates) == 0 {
		f.PriorDueDates = nil
	}
	if len(f.Attributes) == 0 {
		f.Attributes = nil
	}
	b, err := json.Marshal(f)
	if err != nil {
		return []byte(fmt.Sprint(f))
	}
	return b
}

func sameFields(a, b domain.RecordFields) bool { return string(canonical(a)) == string(canonical(b)) }

// inForceAt returns the revision of r in force on day, and false when r's
// first revision is later.
func inForceAt(r domain.Record, day domain.Date) (domain.RecordRevision, bool) {
	var out domain.RecordRevision
	found := false
	for _, rv := range r.Revisions {
		if day.Before(rv.AsOf) {
			break
		}
		out, found = rv, true
	}
	return out, found
}

var placeholder = regexp.MustCompile(`\{([^{}]+)\}`)

// fileIDs reads the external ID of every row of tbl, whether or not the row
// normalizes, so a full export's missing records are judged on the file as
// written.
func fileIDs(t records.Template, tbl records.Table) map[string]bool {
	fm := t.Fields["externalId"]
	cols := map[string]int{}
	for i, h := range tbl.Headers {
		if h = strings.TrimSpace(h); h != "" {
			if _, dup := cols[h]; !dup {
				cols[h] = i
			}
		}
	}
	cell := func(row []string, col string) string {
		if i, ok := cols[strings.TrimSpace(col)]; ok && i < len(row) {
			return strings.TrimSpace(row[i])
		}
		return ""
	}
	out := map[string]bool{}
	for _, row := range tbl.Rows {
		var id string
		switch {
		case fm.Column != "":
			id = cell(row, fm.Column)
		case fm.Template != "":
			id = placeholder.ReplaceAllStringFunc(fm.Template, func(m string) string { return cell(row, m[1:len(m)-1]) })
		}
		if id = strings.TrimSpace(id); id != "" {
			out[id] = true
		}
	}
	return out
}

func identity(source, externalID string) string { return source + "/" + externalID }

// trackedFromDefault returns the tracked-from month a record type gets for a
// source that has none: the month of that source's first snapshot, counting
// one taken as of asOf.
func trackedFromDefault(cal period.Calendar, snaps []domain.Snapshot, source string, asOf domain.Date) period.Period {
	first := asOf
	for _, s := range snaps {
		if s.Source == source && s.AsOf.Before(first) {
			first = s.AsOf
		}
	}
	return cal.MonthOf(first.Time)
}

// Build previews importing tbl with template t as of asOf, with the admin's
// answers. Nothing is stored. It normalizes the rows, resolves each row's
// product or team over the record's life, compares each matched row with the
// record's revision in force at asOf (new, changed, unchanged), lists what
// needs input (unmatched and parent values, new values, row errors, records a
// full export no longer has), derives every derived measure as the plan would
// leave the records, and tells the story of what changes on the scorecard.
// draft, when set, is evaluated in place of the version in force (wizard
// preview). Each plan gets a fresh snapshot ID.
func Build(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, t records.Template, tbl records.Table, asOf domain.Date, ans Answers, draft *domain.MethodologyVersion) (Plan, error) {
	if asOf.IsZero() {
		return Plan{}, errors.New("build plan: the as-of date is required")
	}
	before, err := loadWorld(ctx, st, tenant, scorecardID)
	if err != nil {
		return Plan{}, err
	}
	before.draft = draft
	ti := slices.IndexFunc(before.types, func(rt domain.RecordType) bool { return rt.ID == t.RecordType })
	if ti < 0 {
		return Plan{}, fmt.Errorf("build plan: record type %q does not exist", t.RecordType)
	}
	rt := before.types[ti]
	tpl, err := withAnswers(t, rt, ans)
	if err != nil {
		return Plan{}, err
	}

	p := Plan{NewValues: map[string][]records.ValueCount{}}
	p.ColumnsAdded, p.ColumnsMissing = records.ColumnChanges(t, tbl.Headers)
	rows, skipped, problems := records.Normalize(tpl, rt, tbl)
	p.Counts.Skipped = skipped
	p.Problems = problems
	fileProblem := false
	errRows := map[int]bool{}
	newValues := map[string]map[string]int{}
	for _, pr := range problems {
		switch {
		case pr.RowNum == 0:
			fileProblem = true
		case pr.Kind == records.ProblemUnmappedValue:
			if newValues[pr.Field] == nil {
				newValues[pr.Field] = map[string]int{}
			}
			newValues[pr.Field][pr.Value]++
		default:
			errRows[pr.RowNum] = true
		}
	}
	p.Counts.Errors = len(errRows)
	for _, field := range slices.Sorted(maps.Keys(newValues)) {
		var vcs []records.ValueCount
		for v, n := range newValues[field] {
			vcs = append(vcs, records.ValueCount{Value: v, Count: n, Suggested: records.SuggestValue(field, v, rt)})
		}
		sort.Slice(vcs, func(i, j int) bool {
			if vcs[i].Count != vcs[j].Count {
				return vcs[i].Count > vcs[j].Count
			}
			return vcs[i].Value < vcs[j].Value
		})
		p.NewValues[field] = vcs
	}

	// The world as the plan leaves it: answered org, then the new revisions.
	after := *before
	after.units, after.items, err = answeredOrg(before.units, before.items, before.levels, ans)
	if err != nil {
		return Plan{}, err
	}
	if err := after.buildTree(); err != nil {
		return Plan{}, err
	}

	m := &matcher{cal: before.cal, res: records.NewResolver(after.deriveInput()), cache: map[lifeKey]subjectMatch{}}
	ignore := map[string]bool{}
	for _, v := range ans.IgnoreValues {
		ignore[normKey(v)] = true
	}
	existing := map[string]domain.Record{}
	otherType := map[string]string{}
	for _, r := range before.records {
		if r.Type == rt.ID {
			existing[identity(r.Source, r.ExternalID)] = r
		} else {
			otherType[identity(r.Source, r.ExternalID)] = r.Type
		}
	}

	p.Snapshot = domain.Snapshot{ID: newID(), RecordType: rt.ID, Source: t.Source, AsOf: asOf}
	revision := func(r records.Row, f domain.RecordFields) store.RecordRevisionWrite {
		return store.RecordRevisionWrite{Source: r.Source, ExternalID: r.ExternalID, Type: rt.ID,
			Rev: domain.RecordRevision{AsOf: asOf, SnapshotID: p.Snapshot.ID, Fields: f}}
	}
	type group struct {
		value string
		rows  int
		id    string
	}
	unmatched, parents := map[string]*group{}, map[string]*group{}
	var unmatchedOrder, parentOrder []string
	tally := func(gs map[string]*group, order *[]string, value, id string) {
		k := normKey(value)
		g, ok := gs[k]
		if !ok {
			g = &group{value: value, id: id}
			gs[k] = g
			*order = append(*order, k)
		}
		g.rows++
	}
	newIDs := map[string]bool{}
	for _, r := range rows {
		if ignore[normKey(r.Fields.SubjectKey)] {
			p.Counts.Skipped++
			continue
		}
		if typ, ok := otherType[identity(r.Source, r.ExternalID)]; ok {
			p.Problems = append(p.Problems, records.RowProblem{RowNum: r.RowNum, Kind: records.ProblemError,
				Column: tpl.Fields["externalId"].Column, Field: "externalId", Value: r.ExternalID,
				Message: fmt.Sprintf("%q is already a %s record, not a %s", r.ExternalID, typ, rt.ID)})
			p.Counts.Errors++
			continue
		}
		from, to := life(before.cal, r.Fields, asOf)
		switch sm := m.match(r.Fields.SubjectKey, from, to); sm.problem {
		case records.SubjectUnmatched:
			tally(unmatched, &unmatchedOrder, r.Fields.SubjectKey, "")
			p.Counts.Unmatched++
			continue
		case records.SubjectParent:
			tally(parents, &parentOrder, r.Fields.SubjectKey, sm.id)
			p.Counts.Errors++
			continue
		case records.SubjectAmbiguous:
			p.Problems = append(p.Problems, records.RowProblem{RowNum: r.RowNum, Kind: ProblemAmbiguousSubject,
				Column: tpl.Fields["subjectKey"].Column, Field: "subjectKey", Value: r.Fields.SubjectKey,
				Message: fmt.Sprintf("%q matches more than one product or team", r.Fields.SubjectKey)})
			p.Counts.Errors++
			continue
		}
		rec, ok := existing[identity(r.Source, r.ExternalID)]
		if !ok {
			newIDs[identity(r.Source, r.ExternalID)] = true
			p.Revisions = append(p.Revisions, revision(r, r.Fields))
			p.Counts.New++
			continue
		}
		if sameFields(records.FieldsOn(rec, asOf), r.Fields) {
			p.Counts.Unchanged++
			continue
		}
		p.Revisions = append(p.Revisions, revision(r, r.Fields))
		p.Counts.Changed++
	}
	sort.SliceStable(p.Problems, func(i, j int) bool { return p.Problems[i].RowNum < p.Problems[j].RowNum })
	for _, k := range parentOrder {
		g := parents[k]
		p.Parents = append(p.Parents, ParentMatch{Value: g.value, Rows: g.rows, UnitID: g.id})
	}
	if len(unmatched) > 0 {
		values := map[string]int{}
		for _, k := range unmatchedOrder {
			values[unmatched[k].value] = unmatched[k].rows
		}
		p.Unmatched = records.SuggestSubjects(values, after.units, after.items)
	}

	if tpl.FullExport && !fileProblem {
		inFile := fileIDs(tpl, tbl)
		for _, r := range rows {
			inFile[r.ExternalID] = true
		}
		for _, k := range slices.Sorted(maps.Keys(existing)) {
			rec := existing[k]
			if rec.Source != t.Source || inFile[rec.ExternalID] {
				continue
			}
			rv, ok := inForceAt(rec, asOf)
			if !ok || rv.Fields.State != domain.StateOpen {
				continue
			}
			p.Missing = append(p.Missing, rec.ExternalID)
			if ans.MarkMissingCancelled {
				f := cloneFields(rv.Fields)
				f.State, f.CompletedAt = domain.StateCancelled, &asOf
				p.Revisions = append(p.Revisions, store.RecordRevisionWrite{Source: rec.Source, ExternalID: rec.ExternalID, Type: rt.ID,
					Rev: domain.RecordRevision{AsOf: asOf, SnapshotID: p.Snapshot.ID, Fields: f}})
			}
		}
		p.Counts.Missing = len(p.Missing)
	}
	p.Snapshot.Counts = countsMap(p.Counts)

	after.records = mergeRevisions(before.records, p.Revisions)
	after.latest = maps.Clone(before.latest)
	if cur := after.latest[rt.ID]; cur.Before(asOf) {
		after.latest[rt.ID] = asOf
	}
	after.types = slices.Clone(before.types)
	if _, ok := rt.TrackedFrom[t.Source]; !ok {
		nt := rt
		nt.TrackedFrom = maps.Clone(rt.TrackedFrom)
		if nt.TrackedFrom == nil {
			nt.TrackedFrom = map[string]period.Period{}
		}
		nt.TrackedFrom[t.Source] = trackedFromDefault(before.cal, before.snapshots[rt.ID], t.Source, asOf)
		after.types[ti] = nt
	}

	wantBefore, _ := before.deriveAll()
	wantAfter, notes := after.deriveAll()
	years := slices.Compact(slices.Sorted(slices.Values(append(before.dataYears(), after.dataYears()...))))
	pts, ovs, err := st.ListData(ctx, tenant.ID, scorecardID, years)
	if err != nil {
		return Plan{}, err
	}
	cur := pointsBySlot(pts)
	use := useSet(ans.UseRecords)
	p.Writes = writesFor(wantAfter, notes, cur, func(period.Period) bool { return false }, use)

	p.Story, err = buildStory(storyInput{
		tenant: tenant, before: before, after: &after, data: pts, overrides: ovs, cur: cur, use: use,
		wantBefore: wantBefore, wantAfter: wantAfter, writes: p.Writes, newIDs: newIDs,
	})
	if err != nil {
		return Plan{}, err
	}
	p.Story.Warnings = notes.warnings
	prev, hasPrev := lastUpload(before.snapshots[rt.ID], t.Source)
	if hasPrev {
		p.Story.PreviousAsOf = &prev
	}
	laterDate := hasPrev && prev.Before(asOf)
	p.Story.SameRecords = len(p.Revisions) == 0 && laterDate && p.Counts.Unchanged > 0 && p.Counts.Unmatched == 0
	p.Story.NothingChanged = len(p.Revisions) == 0 && len(p.Writes) == 0 && !laterDate
	return p, nil
}

// lastUpload is the as-of date of the newest snapshot from source, and
// false when there is none. snaps are newest as-of first.
func lastUpload(snaps []domain.Snapshot, source string) (domain.Date, bool) {
	for _, s := range snaps {
		if s.Source == source {
			return s.AsOf, true
		}
	}
	return domain.Date{}, false
}

func countsMap(c Counts) map[string]int {
	return map[string]int{
		"new": c.New, "changed": c.Changed, "unchanged": c.Unchanged, "skipped": c.Skipped,
		"missing": c.Missing, "unmatched": c.Unmatched, "errors": c.Errors,
	}
}

func cloneFields(f domain.RecordFields) domain.RecordFields {
	f.PriorDueDates = slices.Clone(f.PriorDueDates)
	f.Attributes = maps.Clone(f.Attributes)
	return f
}

// mergeRevisions returns recs with revs stored the way ApplySnapshot stores
// them: a revision at an existing as-of date replaces it, records stay
// sorted by source and external ID and revisions by as-of. recs is not
// modified.
func mergeRevisions(recs []domain.Record, revs []store.RecordRevisionWrite) []domain.Record {
	out := make([]domain.Record, len(recs))
	at := map[string]int{}
	for i, r := range recs {
		out[i] = r
		at[r.Type+"\x00"+identity(r.Source, r.ExternalID)] = i
	}
	touched := map[int]bool{}
	for _, w := range revs {
		k := w.Type + "\x00" + identity(w.Source, w.ExternalID)
		i, ok := at[k]
		if !ok {
			out = append(out, domain.Record{Source: w.Source, ExternalID: w.ExternalID, Type: w.Type})
			i = len(out) - 1
			at[k] = i
		}
		if !touched[i] {
			out[i].Revisions = slices.Clone(out[i].Revisions)
			touched[i] = true
		}
		r := &out[i]
		if j := slices.IndexFunc(r.Revisions, func(x domain.RecordRevision) bool { return x.AsOf.Equal(w.Rev.AsOf.Time) }); j >= 0 {
			r.Revisions[j] = w.Rev
		} else {
			r.Revisions = append(r.Revisions, w.Rev)
		}
		sort.SliceStable(r.Revisions, func(a, b int) bool { return r.Revisions[a].AsOf.Before(r.Revisions[b].AsOf) })
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return out[i].ExternalID < out[j].ExternalID
	})
	return out
}

// Apply stores a plan built with ans: in order, the shared units (each
// "<Parent name> (shared)" child takes over its parent's source keys), the
// answered source keys, the record type's tracked-from month when its
// source has none, the snapshot with its revisions, and the derived values of
// every scorecard of the tenant recalculated from the stored records (typed
// values are kept unless ans.UseRecords, which names slots of scorecardID,
// lists them). It then appends one audit entry, records.import,
// with the counts. A source key another subject already holds is refused
// before anything is written. Applying the same plan twice fails at the
// snapshot with ErrAlreadyApplied (a store.ErrConflict); the org writes
// before it are idempotent. Other conflicts are races with an edit.
func Apply(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, p Plan, ans Answers, actor string) error {
	if p.Snapshot.ID == "" {
		return errors.New("apply plan: the plan has no snapshot")
	}
	levels, err := st.ListLevels(ctx, tenant.ID)
	if err != nil {
		return err
	}
	units, err := st.ListOrgUnits(ctx, tenant.ID)
	if err != nil {
		return err
	}
	items, err := st.ListTrackedItems(ctx, tenant.ID)
	if err != nil {
		return err
	}
	shared := map[string]string{}
	for _, id := range ans.CreateShared {
		shared[id] = SharedUnitID(id)
	}
	// Who would hold each answered key once the shared units take over
	// their parents' keys.
	moved, _, err := answeredOrg(units, items, levels, Answers{CreateShared: ans.CreateShared})
	if err != nil {
		return err
	}
	answered := map[string]string{}
	for _, key := range slices.Sorted(maps.Keys(ans.SourceKeys)) {
		target := ans.SourceKeys[key]
		if sid, ok := shared[target]; ok {
			target = sid
		}
		if prev, ok := answered[normKey(key)]; ok && prev != target {
			return fmt.Errorf("apply plan: source key %q is answered for both %s and %s", strings.TrimSpace(key), prev, target)
		}
		answered[normKey(key)] = target
		if holder, ok := domain.SourceKeyHolder(moved, items, key); ok && holder != target {
			return fmt.Errorf("apply plan: source key %q already belongs to %s", strings.TrimSpace(key), subjectName(moved, items, holder))
		}
	}
	newUnits, newItems, err := answeredOrg(units, items, levels, ans)
	if err != nil {
		return err
	}

	// Org: new units first, then changed ones, then items.
	oldUnits := map[string]domain.OrgUnit{}
	for _, u := range units {
		oldUnits[u.ID] = u
	}
	slices.SortStableFunc(newUnits, func(a, b domain.OrgUnit) int {
		_, ao := oldUnits[a.ID]
		_, bo := oldUnits[b.ID]
		switch {
		case ao == bo:
			return 0
		case !ao:
			return -1
		}
		return 1
	})
	for _, u := range newUnits {
		if old, ok := oldUnits[u.ID]; ok && reflect.DeepEqual(old, u) {
			continue
		}
		if err := st.PutOrgUnit(ctx, tenant.ID, u); err != nil {
			return fmt.Errorf("apply plan: saving org unit %s: %w", u.ID, err)
		}
	}
	for i, it := range newItems {
		if reflect.DeepEqual(items[i], it) {
			continue
		}
		if err := st.PutTrackedItem(ctx, tenant.ID, it); err != nil {
			return fmt.Errorf("apply plan: saving tracked item %s: %w", it.ID, err)
		}
	}

	if err := ensureTrackedFrom(ctx, st, tenant, p.Snapshot); err != nil {
		return err
	}

	at := now()
	sn := p.Snapshot
	sn.CreatedBy, sn.CreatedAt = actor, at
	if sn.Counts == nil {
		sn.Counts = countsMap(p.Counts)
	}
	if err := st.ApplySnapshot(ctx, tenant.ID, sn, p.Revisions); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return fmt.Errorf("apply plan: snapshot %s: %w", sn.ID, ErrAlreadyApplied)
		}
		return fmt.Errorf("apply plan: saving snapshot %s: %w", sn.ID, err)
	}

	// Records belong to the tenant, so every scorecard's derived values move.
	// The typed slots the admin chose records for are the previewed
	// scorecard's.
	cards, err := st.ListScorecards(ctx, tenant.ID)
	if err != nil {
		return err
	}
	ids := []string{scorecardID}
	for _, sc := range cards {
		if sc.ID != scorecardID {
			ids = append(ids, sc.ID)
		}
	}
	written := 0
	for _, id := range ids {
		var use []CellRef
		if id == scorecardID {
			use = ans.UseRecords
		}
		writes, err := Recalculate(ctx, st, tenant, id, func(period.Period) bool { return false }, use)
		if err != nil {
			return fmt.Errorf("apply plan: recalculating derived values of scorecard %s: %w", id, err)
		}
		for i := range writes {
			writes[i].Point.EnteredBy, writes[i].Point.EnteredAt = actor, at
		}
		if len(writes) > 0 {
			if _, err := st.PutDataPoints(ctx, tenant.ID, id, writes); err != nil {
				return fmt.Errorf("apply plan: saving derived values of scorecard %s: %w", id, err)
			}
		}
		written += len(writes)
	}

	counts := countsMap(p.Counts)
	counts["revisions"] = len(p.Revisions)
	counts["dataPoints"] = written
	after, err := json.Marshal(counts)
	if err != nil {
		return err
	}
	entry := domain.AuditEntry{
		ID: newID(), ActorID: actor, Channel: auditChannel, Action: AuditAction,
		TargetType: "snapshot", TargetID: sn.ID, After: after, At: at,
	}
	if err := st.AppendAudit(ctx, tenant.ID, entry); err != nil {
		return fmt.Errorf("apply plan: recording audit entry: %w", err)
	}
	return nil
}

// ensureTrackedFrom gives the snapshot's record type a tracked-from month for
// its source when it has none, as Build assumed.
func ensureTrackedFrom(ctx context.Context, st store.Store, tenant domain.Tenant, sn domain.Snapshot) error {
	types, err := st.ListRecordTypes(ctx, tenant.ID)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(types, func(rt domain.RecordType) bool { return rt.ID == sn.RecordType })
	if i < 0 {
		return fmt.Errorf("apply plan: record type %q does not exist", sn.RecordType)
	}
	rt := types[i]
	if _, ok := rt.TrackedFrom[sn.Source]; ok {
		return nil
	}
	snaps, err := st.ListSnapshots(ctx, tenant.ID, rt.ID)
	if err != nil {
		return err
	}
	rt.TrackedFrom = maps.Clone(rt.TrackedFrom)
	if rt.TrackedFrom == nil {
		rt.TrackedFrom = map[string]period.Period{}
	}
	rt.TrackedFrom[sn.Source] = trackedFromDefault(importer.CalendarOf(tenant), snaps, sn.Source, sn.AsOf)
	if err := st.PutRecordType(ctx, tenant.ID, rt, rt.Revision); err != nil {
		return fmt.Errorf("apply plan: saving tracked-from month: %w", err)
	}
	return nil
}

func subjectName(units []domain.OrgUnit, items []domain.TrackedItem, id string) string {
	for _, u := range units {
		if u.ID == id {
			return fmt.Sprintf("%s (%s)", u.Name, id)
		}
	}
	for _, it := range items {
		if it.ID == id {
			return fmt.Sprintf("%s (%s)", it.Name, id)
		}
	}
	return id
}
