package recordimport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/records"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

// The fixture is a small synthetic Acme Demo tenant: the Commerce segment with
// the Checkout and Billing products, an epic record type tracked from October
// 2026, and one published methodology version with derived epics_committed and
// epics_on_time (commitments), an on-time metric with bands, and an entered
// incidents measure.

const scID = "sc"

var acme = domain.Tenant{ID: "acme", Name: "Acme Demo", FiscalYearStartMonth: time.January, StatusScale: domain.DefaultStatusScale()}

func mon(fy, i int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: i} }

func day(s string) domain.Date {
	d, err := domain.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

var oct, nov = mon(2026, 10), mon(2026, 11)

func derivedMeasure(key, name string, rule domain.DeriveRule) domain.Measure {
	return domain.Measure{Key: key, Name: name, Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
		Source: domain.MeasureDerived, Derive: &rule}
}

func methodology() domain.Methodology {
	return domain.Methodology{
		Categories: []domain.Category{{ID: "delivery", Name: "Delivery", Order: 1}},
		Measures: []domain.Measure{
			derivedMeasure("epics_committed", "Epics committed", domain.DeriveRule{RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeResolved}),
			derivedMeasure("epics_on_time", "Epics on time", domain.DeriveRule{RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeMet}),
			{Key: "incidents", Name: "Incidents", Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum},
		},
		Metrics: []domain.Metric{
			{Key: "on_time", Name: "On-time delivery", CategoryID: "delivery", Formula: "epics_on_time / epics_committed * 100",
				Format: domain.FormatPercent0, Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 90}, {Status: "Y", Op: ">=", Value: 80}, {Status: "R"}}}},
			{Key: "incident_count", Name: "Incidents", CategoryID: "delivery", Formula: "incidents",
				Format: domain.FormatNumber0, Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{{Status: "G", Op: "<=", Value: 2}, {Status: "R"}}}},
		},
	}
}

type fixture struct {
	t   *testing.T
	ctx context.Context
	st  store.Store
	tpl records.Template
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, ctx: context.Background(), st: memstore.New(), tpl: epicTemplate()}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(f.st.CreateTenant(f.ctx, acme))
	must(f.st.PutLevels(f.ctx, acme.ID, []domain.Level{{ID: "segment", Name: "Segment", Depth: 0}, {ID: "product", Name: "Product", Depth: 1}}))
	for _, u := range []domain.OrgUnit{
		{ID: "commerce", Name: "Commerce", LevelID: "segment", SourceKeys: []string{"Commerce"}},
		{ID: "checkout", Name: "Checkout", LevelID: "product", ParentID: "commerce", SourceKeys: []string{"Checkout", "CHK"}},
		{ID: "billing", Name: "Billing", LevelID: "product", ParentID: "commerce", SourceKeys: []string{"Billing"}},
	} {
		must(f.st.PutOrgUnit(f.ctx, acme.ID, u))
	}
	must(f.st.PutScorecard(f.ctx, acme.ID, domain.Scorecard{ID: scID, Name: "Delivery"}))
	must(f.st.PutRecordType(f.ctx, acme.ID, domain.RecordType{ID: "epic", Name: "Epic",
		TrackedFrom: map[string]period.Period{"tracker": oct}}, 0))
	published := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	must(f.st.PutVersion(f.ctx, acme.ID, domain.MethodologyVersion{ID: "v1", ScorecardID: scID, Name: "2026",
		Status: domain.VersionPublished, EffectiveFrom: mon(2026, 1), PublishedAt: &published, Content: methodology()}, 0))
	return f
}

func epicTemplate() records.Template {
	dates := []string{"2006-01-02"}
	return records.Template{
		Name: "Tracker epics export", RecordType: "epic", Source: "tracker",
		File: records.FileSpec{Format: "csv", HeaderRow: 1},
		Fields: map[string]records.FieldMap{
			"externalId":  {Column: "Key"},
			"title":       {Column: "Summary"},
			"subjectKey":  {Column: "Product"},
			"status":      {Column: "Status"},
			"state":       {Column: "Status", Map: map[string]string{"Done": "done", "Won't Do": "cancelled", "*": "open"}},
			"createdAt":   {Column: "Created", DateFormats: dates},
			"dueAt":       {Column: "Due date", DateFormats: dates},
			"completedAt": {Column: "Resolved", DateFormats: dates},
		},
	}
}

// epic is one row of the synthetic tracker export.
type epic struct{ id, product, status, created, due, resolved string }

func openEpic(id, product, due string) epic {
	return epic{id, product, "In Progress", "2026-09-01", due, ""}
}

func doneEpic(id, product, due, resolved string) epic {
	return epic{id, product, "Done", "2026-09-01", due, resolved}
}

var epicHeaders = []string{"Key", "Summary", "Product", "Status", "Created", "Due date", "Resolved"}

func epicTable(rows ...epic) records.Table {
	var b strings.Builder
	b.WriteString(strings.Join(epicHeaders, ",") + "\n")
	for _, r := range rows {
		fmt.Fprintf(&b, "%s,Epic %s,%s,%s,%s,%s,%s\n", r.id, r.id, r.product, r.status, r.created, r.due, r.resolved)
	}
	tbl, err := records.ReadCSV(strings.NewReader(b.String()))
	if err != nil {
		panic(err)
	}
	return tbl
}

func (f *fixture) build(tbl records.Table, asOf string, ans Answers) Plan {
	f.t.Helper()
	p, err := Build(f.ctx, f.st, acme, scID, f.tpl, tbl, day(asOf), ans, nil)
	if err != nil {
		f.t.Fatalf("Build: %v", err)
	}
	return p
}

func (f *fixture) apply(p Plan, ans Answers) {
	f.t.Helper()
	if err := Apply(f.ctx, f.st, acme, scID, p, ans, "admin-1"); err != nil {
		f.t.Fatalf("Apply: %v", err)
	}
}

// load builds and applies an export with no answers.
func (f *fixture) load(tbl records.Table, asOf string) Plan {
	f.t.Helper()
	p := f.build(tbl, asOf, Answers{})
	f.apply(p, Answers{})
	return p
}

func (f *fixture) records() map[string]domain.Record {
	f.t.Helper()
	recs, err := f.st.ListRecords(f.ctx, acme.ID, "epic")
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]domain.Record{}
	for _, r := range recs {
		out[r.ExternalID] = r
	}
	return out
}

func pointKey(measure, subject string, p period.Period) string {
	return measure + "/" + subject + "/" + p.String()
}

func (f *fixture) points() map[string]domain.DataPoint {
	f.t.Helper()
	pts, _, err := f.st.ListData(f.ctx, acme.ID, scID, []int{2025, 2026, 2027})
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]domain.DataPoint{}
	for _, p := range pts {
		out[pointKey(p.MeasureKey, p.SubjectID, p.Period)] = p
	}
	return out
}

func (f *fixture) value(measure, subject string, p period.Period) (float64, string, bool) {
	f.t.Helper()
	dp, ok := f.points()[pointKey(measure, subject, p)]
	if !ok || dp.Value == nil {
		return 0, dp.Source, ok
	}
	return *dp.Value, dp.Source, true
}

func (f *fixture) typed(measure, subject string, p period.Period, v float64) {
	f.t.Helper()
	_, err := f.st.PutDataPoints(f.ctx, acme.ID, scID, []store.DataWrite{{Point: domain.DataPoint{
		MeasureKey: measure, SubjectID: subject, Period: p, Value: &v, Source: domain.SourceGrid,
		EnteredBy: "pm-1", EnteredAt: time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)}, ExpectedRevision: store.Unconditional}})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) unit(id string) domain.OrgUnit {
	f.t.Helper()
	units, err := f.st.ListOrgUnits(f.ctx, acme.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, u := range units {
		if u.ID == id {
			return u
		}
	}
	f.t.Fatalf("no unit %q", id)
	return domain.OrgUnit{}
}

func writeFor(ws []store.DataWrite, measure, subject string, p period.Period) (store.DataWrite, bool) {
	for _, w := range ws {
		if w.Point.MeasureKey == measure && w.Point.SubjectID == subject && w.Point.Period == p {
			return w, true
		}
	}
	return store.DataWrite{}, false
}

func revisionIDs(revs []store.RecordRevisionWrite) []string {
	var out []string
	for _, r := range revs {
		out = append(out, r.ExternalID)
	}
	slices.Sort(out)
	return out
}

// octoberEpics: two Checkout epics delivered on time, one Billing epic still open.
func octoberEpics() records.Table {
	return epicTable(
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
		doneEpic("CHK-2", "Checkout", "2026-10-12", "2026-10-12"),
		openEpic("BIL-1", "Billing", "2026-10-28"),
	)
}

func TestReuploadIsNoOp(t *testing.T) {
	f := newFixture(t)
	first := f.build(octoberEpics(), "2026-10-31", Answers{})
	if first.Counts.New != 3 || first.Story.NothingChanged {
		t.Fatalf("first upload counts = %+v, nothing changed = %v", first.Counts, first.Story.NothingChanged)
	}
	if len(first.Writes) == 0 {
		t.Fatalf("first upload derives no values")
	}
	f.apply(first, Answers{})
	if v, src, _ := f.value("epics_on_time", "checkout", oct); v != 2 || src != domain.SourceRecords {
		t.Errorf("checkout on time October = %v (%s), want 2 from records", v, src)
	}
	// BIL-1 is due October 28 and not done by the October 31 upload: missed.
	if v, _, _ := f.value("epics_committed", "billing", oct); v != 1 {
		t.Errorf("billing committed October = %v, want 1", v)
	}

	again := f.build(octoberEpics(), "2026-10-31", Answers{})
	if !again.Story.NothingChanged {
		t.Errorf("re-upload: nothing changed = false; revisions %v, writes %+v", revisionIDs(again.Revisions), again.Writes)
	}
	if again.Counts != (Counts{Unchanged: 3}) {
		t.Errorf("re-upload counts = %+v, want 3 unchanged", again.Counts)
	}
	if len(again.Story.Lines) != 0 || len(again.Story.Typed) != 0 {
		t.Errorf("re-upload story = %+v", again.Story)
	}
	if again.Snapshot.ID == first.Snapshot.ID || again.Snapshot.ID == "" {
		t.Errorf("snapshot IDs %q and %q: each plan needs a fresh one", first.Snapshot.ID, again.Snapshot.ID)
	}
}

func TestReuploadLaterAsOf(t *testing.T) {
	f := newFixture(t)
	f.load(octoberEpics(), "2026-11-01")

	// The same export, uploaded a few days later: only the date moves. No
	// epic is due in November, so no derived value changes either.
	later := f.build(octoberEpics(), "2026-11-04", Answers{})
	if later.Counts != (Counts{Unchanged: 3}) || len(later.Revisions) != 0 || len(later.Writes) != 0 {
		t.Fatalf("later re-upload counts = %+v, revisions %v, writes %+v", later.Counts, revisionIDs(later.Revisions), later.Writes)
	}
	if later.Story.NothingChanged || !later.Story.SameRecords {
		t.Errorf("later re-upload: nothingChanged = %v, sameRecords = %v; want false, true", later.Story.NothingChanged, later.Story.SameRecords)
	}
	if prev := later.Story.PreviousAsOf; prev == nil || prev.String() != "2026-11-01" {
		t.Errorf("previousAsOf = %v, want 2026-11-01", prev)
	}
	f.apply(later, Answers{})
	in, err := LoadDeriveInput(f.ctx, f.st, acme, scID)
	if err != nil || in.LatestAsOf["epic"].String() != "2026-11-04" {
		t.Fatalf("latest as-of after apply = %v (%v), want 2026-11-04", in.LatestAsOf, err)
	}

	// The same date again changes nothing at all.
	again := f.build(octoberEpics(), "2026-11-04", Answers{})
	if !again.Story.NothingChanged || again.Story.SameRecords {
		t.Errorf("same-date re-upload: nothingChanged = %v, sameRecords = %v; want true, false", again.Story.NothingChanged, again.Story.SameRecords)
	}
}

func TestApplyRecordsAuditAndRefusesTwice(t *testing.T) {
	f := newFixture(t)
	p := f.load(octoberEpics(), "2026-10-31")
	if err := Apply(f.ctx, f.st, acme, scID, p, Answers{}, "admin-1"); !errors.Is(err, store.ErrConflict) {
		t.Errorf("second apply of one plan = %v, want a conflict", err)
	}
	entries, err := f.st.ListAudit(f.ctx, acme.ID, time.Time{}, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var found []domain.AuditEntry
	for _, e := range entries {
		if e.Action == AuditAction {
			found = append(found, e)
		}
	}
	if len(found) != 1 {
		t.Fatalf("audit entries %s = %d, want 1", AuditAction, len(found))
	}
	e := found[0]
	if e.ActorID != "admin-1" || e.TargetID != p.Snapshot.ID {
		t.Errorf("audit entry = %+v", e)
	}
	var counts map[string]int
	if err := json.Unmarshal(e.After, &counts); err != nil || counts["new"] != 3 || counts["dataPoints"] == 0 {
		t.Errorf("audit counts = %s (%v)", e.After, err)
	}
	snaps, _ := f.st.ListSnapshots(f.ctx, acme.ID, "epic")
	if len(snaps) != 1 || snaps[0].CreatedBy != "admin-1" || snaps[0].Counts["new"] != 3 || snaps[0].Source != "tracker" {
		t.Errorf("snapshots = %+v", snaps)
	}
}

func TestOverlappingExportsDedupe(t *testing.T) {
	f := newFixture(t)
	f.load(epicTable(
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
		doneEpic("CHK-2", "Checkout", "2026-10-12", "2026-10-12"),
	), "2026-10-15")
	p := f.build(epicTable(
		doneEpic("CHK-2", "Checkout", "2026-10-12", "2026-10-12"),
		openEpic("CHK-3", "Checkout", "2026-10-30"),
	), "2026-10-31", Answers{})
	if p.Counts != (Counts{New: 1, Unchanged: 1}) {
		t.Errorf("counts = %+v, want 1 new and 1 unchanged", p.Counts)
	}
	if got := revisionIDs(p.Revisions); !reflect.DeepEqual(got, []string{"CHK-3"}) {
		t.Errorf("revisions = %v, want only CHK-3", got)
	}
	f.apply(p, Answers{})
	recs := f.records()
	if len(recs) != 3 || len(recs["CHK-2"].Revisions) != 1 {
		t.Errorf("records = %d, CHK-2 revisions = %d; want 3 and 1", len(recs), len(recs["CHK-2"].Revisions))
	}
}

func TestChangedRowNewRevision(t *testing.T) {
	f := newFixture(t)
	f.load(epicTable(openEpic("CHK-1", "Checkout", "2026-10-20")), "2026-10-15")
	p := f.build(epicTable(doneEpic("CHK-1", "Checkout", "2026-10-20", "2026-10-19")), "2026-10-31", Answers{})
	if p.Counts != (Counts{Changed: 1}) {
		t.Fatalf("counts = %+v, want 1 changed", p.Counts)
	}
	r := p.Revisions[0]
	if r.Rev.AsOf != day("2026-10-31") || r.Rev.SnapshotID != p.Snapshot.ID || r.Rev.Fields.State != domain.StateDone {
		t.Errorf("revision = %+v", r)
	}
	f.apply(p, Answers{})
	if revs := f.records()["CHK-1"].Revisions; len(revs) != 2 {
		t.Errorf("CHK-1 revisions = %d, want 2", len(revs))
	}
	if v, _, _ := f.value("epics_on_time", "checkout", oct); v != 1 {
		t.Errorf("checkout on time October = %v, want 1", v)
	}
}

func TestOutOfOrderSnapshot(t *testing.T) {
	f := newFixture(t)
	f.load(epicTable(doneEpic("CHK-1", "Checkout", "2026-11-25", "2026-11-20")), "2026-11-30")
	before := f.points()

	// The older October export arrives after November's.
	p := f.build(epicTable(openEpic("CHK-1", "Checkout", "2026-11-25")), "2026-10-31", Answers{})
	if p.Counts != (Counts{Changed: 1}) {
		t.Fatalf("counts = %+v, want 1 changed", p.Counts)
	}
	if len(p.Writes) != 0 {
		t.Errorf("an older snapshot changed derived values: %+v", p.Writes)
	}
	f.apply(p, Answers{})
	revs := f.records()["CHK-1"].Revisions
	if len(revs) != 2 || revs[0].AsOf != day("2026-10-31") || revs[1].Fields.State != domain.StateDone {
		t.Errorf("revisions = %+v, want October then November (done)", revs)
	}
	if got := records.Latest(f.records()["CHK-1"]).State; got != domain.StateDone {
		t.Errorf("latest state = %s, want done (newest as-of wins)", got)
	}
	if after := f.points(); !reflect.DeepEqual(keysOf(before), keysOf(after)) {
		t.Errorf("points changed: %v -> %v", keysOf(before), keysOf(after))
	}
	if v, _, _ := f.value("epics_on_time", "checkout", nov); v != 1 {
		t.Errorf("checkout on time November = %v, want 1", v)
	}
	if again := f.build(epicTable(openEpic("CHK-1", "Checkout", "2026-11-25")), "2026-10-31", Answers{}); !again.Story.NothingChanged {
		t.Errorf("re-uploading the October export changed something: %+v", again.Counts)
	}
}

func keysOf(m map[string]domain.DataPoint) []string {
	var out []string
	for k, p := range m {
		out = append(out, fmt.Sprintf("%s=%v", k, *p.Value))
	}
	slices.Sort(out)
	return out
}

func TestUnmatchedNotStored(t *testing.T) {
	f := newFixture(t)
	p := f.build(epicTable(
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
		openEpic("CHK-9", "Checkout Svc", "2026-10-20"),
		openEpic("CHK-10", "Checkout Svc", "2026-10-21"),
	), "2026-10-31", Answers{})
	if p.Counts.New != 1 || p.Counts.Unmatched != 2 {
		t.Errorf("counts = %+v, want 1 new and 2 unmatched", p.Counts)
	}
	if len(p.Unmatched) != 1 {
		t.Fatalf("unmatched = %+v, want one group", p.Unmatched)
	}
	if u := p.Unmatched[0]; u.Value != "Checkout Svc" || u.Rows != 2 || u.SubjectID != "checkout" {
		t.Errorf("unmatched = %+v, want Checkout Svc x2 suggesting checkout", u)
	}
	if got := revisionIDs(p.Revisions); !reflect.DeepEqual(got, []string{"CHK-1"}) {
		t.Errorf("revisions = %v, want only CHK-1", got)
	}
	f.apply(p, Answers{})
	if _, ok := f.records()["CHK-9"]; ok {
		t.Errorf("unmatched CHK-9 was stored")
	}
}

func TestParentMatchReported(t *testing.T) {
	f := newFixture(t)
	p := f.build(epicTable(
		openEpic("PAY-1", "Commerce", "2026-10-20"),
		openEpic("PAY-2", "commerce", "2026-10-22"),
		openEpic("CHK-1", "Checkout", "2026-10-20"),
	), "2026-10-31", Answers{})
	if want := []ParentMatch{{Value: "Commerce", Rows: 2, UnitID: "commerce"}}; !reflect.DeepEqual(p.Parents, want) {
		t.Errorf("parents = %+v, want %+v", p.Parents, want)
	}
	if p.Counts.Errors != 2 || p.Counts.New != 1 {
		t.Errorf("counts = %+v, want 2 errors and 1 new", p.Counts)
	}
	if got := revisionIDs(p.Revisions); !reflect.DeepEqual(got, []string{"CHK-1"}) {
		t.Errorf("revisions = %v, want only CHK-1", got)
	}
}

func TestAmbiguousSubjectReported(t *testing.T) {
	f := newFixture(t)
	billing := f.unit("billing")
	billing.SourceKeys = append(billing.SourceKeys, "CHK")
	if err := f.st.PutOrgUnit(f.ctx, acme.ID, billing); err != nil {
		t.Fatal(err)
	}
	p := f.build(epicTable(openEpic("CHK-1", "chk", "2026-10-20")), "2026-10-31", Answers{})
	if p.Counts != (Counts{Errors: 1}) || len(p.Problems) != 1 || p.Problems[0].Kind != ProblemAmbiguousSubject || p.Problems[0].RowNum != 2 {
		t.Errorf("counts = %+v, problems = %+v", p.Counts, p.Problems)
	}
}

func TestCreateSharedUnit(t *testing.T) {
	f := newFixture(t)
	tbl := epicTable(
		openEpic("PAY-1", "Commerce", "2026-10-20"),
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
	)
	ans := Answers{CreateShared: []string{"commerce"}}
	p := f.build(tbl, "2026-10-31", ans)
	if len(p.Parents) != 0 || p.Counts.New != 2 {
		t.Fatalf("with a shared unit: parents = %+v, counts = %+v", p.Parents, p.Counts)
	}
	if w, ok := writeFor(p.Writes, "epics_committed", SharedUnitID("commerce"), oct); !ok || *w.Point.Value != 1 {
		t.Errorf("preview has no committed value for the shared unit: %+v", p.Writes)
	}
	f.apply(p, ans)

	shared := f.unit(SharedUnitID("commerce"))
	if shared.Name != "Commerce (shared)" || shared.ParentID != "commerce" || shared.LevelID != "product" ||
		!reflect.DeepEqual(shared.SourceKeys, []string{"Commerce"}) {
		t.Errorf("shared unit = %+v", shared)
	}
	if keys := f.unit("commerce").SourceKeys; len(keys) != 0 {
		t.Errorf("parent still holds source keys %v", keys)
	}
	if v, src, ok := f.value("epics_committed", SharedUnitID("commerce"), oct); !ok || v != 1 || src != domain.SourceRecords {
		t.Errorf("shared unit committed = %v (%s, %v), want 1 from records", v, src, ok)
	}
	if _, _, ok := f.value("epics_committed", "commerce", oct); ok {
		t.Errorf("a derived value was written on the parent unit")
	}
	if again := f.build(tbl, "2026-10-31", Answers{}); !again.Story.NothingChanged {
		t.Errorf("re-upload after creating the shared unit: %+v, writes %+v", again.Counts, again.Writes)
	}
}

func TestAnswersSaveSourceKeys(t *testing.T) {
	f := newFixture(t)
	tbl := epicTable(openEpic("CHK-9", "Checkout Svc", "2026-10-20"))
	ans := Answers{SourceKeys: map[string]string{"Checkout Svc": "checkout"}}
	p := f.build(tbl, "2026-10-31", ans)
	if p.Counts.New != 1 || p.Counts.Unmatched != 0 {
		t.Fatalf("counts = %+v, want the answered row matched", p.Counts)
	}
	f.apply(p, ans)
	if keys := f.unit("checkout").SourceKeys; !slices.Contains(keys, "Checkout Svc") {
		t.Errorf("checkout source keys = %v, want Checkout Svc added", keys)
	}
	if again := f.build(tbl, "2026-10-31", Answers{}); !again.Story.NothingChanged {
		t.Errorf("re-upload without answers changed something: %+v", again.Counts)
	}
}

func TestSourceKeyHeldElsewhereRefused(t *testing.T) {
	f := newFixture(t)
	ans := Answers{SourceKeys: map[string]string{" billing": "checkout"}}
	p := f.build(epicTable(openEpic("CHK-9", "Checkout Svc", "2026-10-20")), "2026-10-31", ans)
	err := Apply(f.ctx, f.st, acme, scID, p, ans, "admin-1")
	if err == nil || !strings.Contains(err.Error(), "Billing (billing)") {
		t.Fatalf("Apply = %v, want an error naming billing", err)
	}
	if snaps, _ := f.st.ListSnapshots(f.ctx, acme.ID, "epic"); len(snaps) != 0 {
		t.Errorf("a refused apply stored a snapshot")
	}
	if keys := f.unit("checkout").SourceKeys; slices.Contains(keys, " billing") {
		t.Errorf("refused key saved: %v", keys)
	}

	// One key answered for two subjects is refused too.
	ans = Answers{SourceKeys: map[string]string{"Checkout Svc": "checkout", "checkout svc ": "billing"}}
	p = f.build(epicTable(openEpic("CHK-9", "Checkout Svc", "2026-10-20")), "2026-10-31", ans)
	if err := Apply(f.ctx, f.st, acme, scID, p, ans, "admin-1"); err == nil || !strings.Contains(err.Error(), "both") {
		t.Errorf("Apply = %v, want the conflicting answers refused", err)
	}
	if keys := f.unit("billing").SourceKeys; len(keys) != 1 {
		t.Errorf("billing keys = %v", keys)
	}
}

func TestMissingFullExportCancel(t *testing.T) {
	f := newFixture(t)
	f.tpl.FullExport = true
	f.load(epicTable(
		openEpic("CHK-1", "Checkout", "2026-11-20"),
		openEpic("CHK-2", "Checkout", "2026-11-21"),
		doneEpic("CHK-3", "Checkout", "2026-10-10", "2026-10-08"),
	), "2026-10-15")
	next := epicTable(openEpic("CHK-1", "Checkout", "2026-11-20"))

	p := f.build(next, "2026-10-31", Answers{})
	if !reflect.DeepEqual(p.Missing, []string{"CHK-2"}) || p.Counts.Missing != 1 {
		t.Errorf("missing = %v (count %d), want CHK-2 (done CHK-3 is not missing)", p.Missing, p.Counts.Missing)
	}
	if len(p.Revisions) != 0 {
		t.Errorf("missing records written without the answer: %v", revisionIDs(p.Revisions))
	}

	ans := Answers{MarkMissingCancelled: true}
	p = f.build(next, "2026-10-31", ans)
	if got := revisionIDs(p.Revisions); !reflect.DeepEqual(got, []string{"CHK-2"}) {
		t.Fatalf("revisions = %v, want CHK-2 cancelled", got)
	}
	fl := p.Revisions[0].Rev.Fields
	if fl.State != domain.StateCancelled || fl.CompletedAt == nil || *fl.CompletedAt != day("2026-10-31") || fl.Title != "Epic CHK-2" {
		t.Errorf("cancel revision = %+v", fl)
	}
	f.apply(p, ans)
	if got := records.Latest(f.records()["CHK-2"]).State; got != domain.StateCancelled {
		t.Errorf("CHK-2 state = %s, want cancelled", got)
	}

	// Without fullExport nothing is missing.
	f.tpl.FullExport = false
	if p := f.build(next, "2026-11-01", Answers{}); len(p.Missing) != 0 {
		t.Errorf("not a full export, missing = %v", p.Missing)
	}
}

func TestMissingNeedsTheFile(t *testing.T) {
	f := newFixture(t)
	f.tpl.FullExport = true
	f.load(epicTable(openEpic("CHK-1", "Checkout", "2026-11-20")), "2026-10-15")
	// A row with an unreadable date is still in the file, so not missing.
	bad := epicTable(epic{"CHK-1", "Checkout", "In Progress", "not a date", "2026-11-20", ""})
	p := f.build(bad, "2026-10-31", Answers{MarkMissingCancelled: true})
	if len(p.Missing) != 0 || len(p.Revisions) != 0 || p.Counts.Errors != 1 || len(p.Problems) != 1 {
		t.Errorf("missing = %v, revisions = %v, counts = %+v", p.Missing, revisionIDs(p.Revisions), p.Counts)
	}
}

func TestDateOrderAnswer(t *testing.T) {
	f := newFixture(t)
	f.tpl.Fields["createdAt"] = records.FieldMap{Column: "Created"}
	tbl := epicTable(epic{"CHK-1", "Checkout", "In Progress", "03/04/2026", "2026-11-20", ""})
	if p := f.build(tbl, "2026-10-31", Answers{}); p.Counts.Errors != 1 {
		t.Fatalf("no date order: counts = %+v", p.Counts)
	}
	for order, want := range map[string]string{"dmy": "2026-04-03", "mdy": "2026-03-04"} {
		p := f.build(tbl, "2026-10-31", Answers{DateOrder: order})
		if len(p.Revisions) != 1 || p.Revisions[0].Rev.Fields.CreatedAt != day(want) {
			t.Errorf("date order %s: revisions = %+v, want createdAt %s", order, p.Revisions, want)
		}
	}
}

func TestValueAnswersAndNewValues(t *testing.T) {
	f := newFixture(t)
	st := f.tpl.Fields["state"]
	st.Map = map[string]string{"Done": "done", "In Progress": "open"} // no fallback
	f.tpl.Fields["state"] = st
	tbl := epicTable(
		openEpic("CHK-1", "Checkout", "2026-11-20"),
		epic{"CHK-2", "Checkout", "Won't Do", "2026-09-01", "2026-11-20", "2026-10-02"},
		epic{"CHK-3", "Checkout", "Won't Do", "2026-09-01", "2026-11-21", "2026-10-03"},
	)
	p := f.build(tbl, "2026-10-31", Answers{})
	want := []records.ValueCount{{Value: "Won't Do", Count: 2, Suggested: "cancelled"}}
	if !reflect.DeepEqual(p.NewValues["state"], want) || p.Counts.New != 1 {
		t.Errorf("new values = %+v, counts = %+v; want %+v", p.NewValues, p.Counts, want)
	}
	p = f.build(tbl, "2026-10-31", Answers{ValueMaps: map[string]map[string]string{"state": {"Won't Do": "cancelled"}}})
	if p.Counts.New != 3 || len(p.NewValues) != 0 {
		t.Errorf("answered: counts = %+v, new values = %+v", p.Counts, p.NewValues)
	}
}

func TestIgnoreValuesSkipRows(t *testing.T) {
	f := newFixture(t)
	p := f.build(epicTable(
		openEpic("CHK-1", "Checkout", "2026-11-20"),
		openEpic("ANL-1", "Analytics Sandbox", "2026-11-20"),
	), "2026-10-31", Answers{IgnoreValues: []string{" analytics sandbox"}})
	if p.Counts != (Counts{New: 1, Skipped: 1}) || len(p.Unmatched) != 0 {
		t.Errorf("counts = %+v, unmatched = %+v", p.Counts, p.Unmatched)
	}
}

func TestColumnChangesReported(t *testing.T) {
	f := newFixture(t)
	tbl, err := records.ReadCSV(strings.NewReader("Key,Summary,Product,Status,Created,Due date,Sprint\nCHK-1,Epic,Checkout,In Progress,2026-09-01,2026-11-20,S4\n"))
	if err != nil {
		t.Fatal(err)
	}
	p := f.build(tbl, "2026-10-31", Answers{})
	if !reflect.DeepEqual(p.ColumnsAdded, []string{"Sprint"}) || !reflect.DeepEqual(p.ColumnsMissing, []string{"Resolved"}) {
		t.Errorf("columns added %v, missing %v", p.ColumnsAdded, p.ColumnsMissing)
	}
	if p.Counts.New != 1 {
		t.Errorf("counts = %+v; the preview should proceed", p.Counts)
	}
}

func TestPriorityNoneUnchanged(t *testing.T) {
	f := newFixture(t)
	f.load(epicTable(openEpic("CHK-1", "Checkout", "2026-11-20")), "2026-10-15")
	// Another writer stored the same record with priority "none".
	recs := f.records()
	fl := records.Latest(recs["CHK-1"])
	fl.Priority = domain.PriorityNone
	if err := f.st.ApplySnapshot(f.ctx, acme.ID, domain.Snapshot{ID: "api-1", RecordType: "epic", Source: "tracker", AsOf: day("2026-10-20")},
		[]store.RecordRevisionWrite{{Source: "tracker", ExternalID: "CHK-1", Type: "epic", Rev: domain.RecordRevision{AsOf: day("2026-10-20"), SnapshotID: "api-1", Fields: fl}}}); err != nil {
		t.Fatal(err)
	}
	if p := f.build(epicTable(openEpic("CHK-1", "Checkout", "2026-11-20")), "2026-10-31", Answers{}); p.Counts != (Counts{Unchanged: 1}) {
		t.Errorf("counts = %+v, want unchanged (none equals no priority)", p.Counts)
	}
}

// orphanStore hides one snapshot, as if its apply failed after writing revisions.
type orphanStore struct {
	store.Store
	hide string
}

func (s orphanStore) ListSnapshots(ctx context.Context, tenantID, recordType string) ([]domain.Snapshot, error) {
	all, err := s.Store.ListSnapshots(ctx, tenantID, recordType)
	return slices.DeleteFunc(all, func(sn domain.Snapshot) bool { return sn.ID == s.hide }), err
}

func TestOrphanRevisionsIgnored(t *testing.T) {
	f := newFixture(t)
	p := f.load(epicTable(openEpic("CHK-1", "Checkout", "2026-10-20")), "2026-10-15")
	f.st = orphanStore{Store: f.st, hide: p.Snapshot.ID}
	again := f.build(epicTable(openEpic("CHK-1", "Checkout", "2026-10-20")), "2026-10-15", Answers{})
	if again.Counts != (Counts{New: 1}) {
		t.Errorf("counts = %+v, want CHK-1 new (its only revision is an orphan)", again.Counts)
	}
	ws, err := Recalculate(f.ctx, f.st, acme, scID, never, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) == 0 || !ws[0].Delete {
		t.Errorf("recalculation without the orphan should delete the derived points, got %+v", ws)
	}
}

func TestBuildDoesNotStore(t *testing.T) {
	f := newFixture(t)
	f.build(octoberEpics(), "2026-10-31", Answers{CreateShared: []string{"commerce"}, SourceKeys: map[string]string{"Checkout Svc": "checkout"}})
	if len(f.records()) != 0 || len(f.points()) != 0 {
		t.Errorf("Build stored records or points")
	}
	if u := f.unit("checkout"); slices.Contains(u.SourceKeys, "Checkout Svc") {
		t.Errorf("Build saved a source key")
	}
	if units, _ := f.st.ListOrgUnits(f.ctx, acme.ID); len(units) != 3 {
		t.Errorf("Build created units: %d", len(units))
	}
}

func TestTemplateWithAnswers(t *testing.T) {
	rt := domain.RecordType{ID: "epic", Name: "Epic"}
	got, err := TemplateWithAnswers(epicTemplate(), rt, Answers{DateOrder: "dmy", ValueMaps: map[string]map[string]string{"state": {"Shelved": "cancelled"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Fields["state"].Map["Shelved"] != "cancelled" || got.Fields["state"].Map["Done"] != "done" {
		t.Errorf("state map = %v", got.Fields["state"].Map)
	}
	if fm := got.Fields["dueAt"].DateFormats; len(fm) != 3 || fm[0] != "02/01/2006" || fm[2] != "2006-01-02" {
		t.Errorf("dueAt formats = %v", fm)
	}
	if _, ok := epicTemplate().Fields["state"].Map["Shelved"]; ok {
		t.Error("the input template was modified")
	}
	if _, err := TemplateWithAnswers(epicTemplate(), rt, Answers{ValueMaps: map[string]map[string]string{"priority": {"x": "P1"}}}); err == nil {
		t.Error("an answer for an unmapped field did not fail")
	}
}
