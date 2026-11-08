package records

import (
	"fmt"
	"math/rand"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

func mon(fy, idx int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: idx} }

// Acme Demo fixture: Commerce is a parent of Checkout, Billing, and Analytics.
// Analytics has no source keys. iOS App is a tracked item.
var deriveUnits = []domain.OrgUnit{
	{ID: "commerce", Name: "Commerce", SourceKeys: []string{"Commerce"}},
	{ID: "checkout", Name: "Checkout", ParentID: "commerce", SourceKeys: []string{"Checkout", "CHK"}},
	{ID: "billing", Name: "Billing", ParentID: "commerce", SourceKeys: []string{"Billing"}},
	{ID: "analytics", Name: "Analytics", ParentID: "commerce"},
}

var deriveItems = []domain.TrackedItem{
	{ID: "ios", KindID: "app", Name: "iOS App", OrgUnitID: "commerce", SourceKeys: []string{"iOS App"}},
}

var deriveTypes = []domain.RecordType{
	{ID: "defect", Name: "Defect", Priorities: []string{"P1", "P2", "P3", "P4"},
		TrackedFrom: map[string]period.Period{"tracker": mon(2026, 10)}},
	{ID: "epic", Name: "Epic", TrackedFrom: map[string]period.Period{"tracker": mon(2026, 11)}},
	{ID: "concept", Name: "Concept", TrackedFrom: map[string]period.Period{"tracker": mon(2026, 10)}},
	{ID: "idea", Name: "Idea", TrackedFrom: map[string]period.Period{"tracker": mon(2026, 10)}},
}

var defectWeights = map[string]float64{"P1": 64, "P2": 16, "P3": 4, "P4": 2, "none": 1}

func deriveInput(t testing.TB, latest map[string]string, recs ...domain.Record) DeriveInput {
	t.Helper()
	tree, err := orgtree.New(deriveUnits, nil)
	if err != nil {
		t.Fatal(err)
	}
	asOf := map[string]domain.Date{}
	for k, v := range latest {
		asOf[k] = day(v)
	}
	return DeriveInput{Tree: tree, Items: deriveItems, Types: deriveTypes, Records: recs, LatestAsOf: asOf}
}

func rec(typ, id string, revs ...domain.RecordRevision) domain.Record {
	return domain.Record{Source: "tracker", ExternalID: id, Type: typ, Revisions: revs}
}

// openDefect is a defect on subject key sk, opened 2026-10-01.
func openDefect(sk, pri string) domain.RecordFields {
	return domain.RecordFields{SubjectKey: sk, Category: "bug", Priority: pri, State: domain.StateOpen, CreatedAt: day("2026-10-01")}
}

func measure(key string, d domain.DeriveRule) domain.Measure {
	return domain.Measure{Key: key, Name: key, Unit: "count", OrgAgg: "sum", TimeAgg: "sum", Source: domain.MeasureDerived, Derive: &d}
}

var (
	pointsSum  = measure("defect_points_sum", domain.DeriveRule{RecordType: "defect", Op: domain.OpDailyOpenWeighted, Weights: defectWeights})
	defectDays = measure("defect_days", domain.DeriveRule{RecordType: "defect", Op: domain.OpDaysInPeriod})
	committed  = measure("epics_committed", domain.DeriveRule{RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeResolved})
	onTime     = measure("epics_on_time", domain.DeriveRule{RecordType: "epic", Op: domain.OpCommitments, Outcome: domain.OutcomeMet})
)

func derive(t *testing.T, in DeriveInput, m domain.Measure, periods ...period.Period) []Derived {
	t.Helper()
	out, err := Derive(in, m, periods)
	if err != nil {
		t.Fatalf("Derive(%s): %v", m.Key, err)
	}
	return out
}

// cell returns the derived value for subject in p, failing when it is absent.
func cell(t *testing.T, out []Derived, subject string, p period.Period) Derived {
	t.Helper()
	for _, d := range out {
		if d.SubjectID == subject && d.Period == p {
			return d
		}
	}
	t.Fatalf("no derived value for %s %s; got %v", subject, p, cellKeys(out))
	return Derived{}
}

func hasCell(out []Derived, subject string, p period.Period) bool {
	for _, d := range out {
		if d.SubjectID == subject && d.Period == p {
			return true
		}
	}
	return false
}

func cellKeys(out []Derived) []string {
	keys := make([]string, len(out))
	for i, d := range out {
		keys[i] = d.SubjectID + "@" + d.Period.String()
	}
	return keys
}

func wantValue(t *testing.T, out []Derived, subject string, p period.Period, want float64) Derived {
	t.Helper()
	d := cell(t, out, subject, p)
	if d.Value != want {
		t.Errorf("%s %s %s = %v, want %v", d.MeasureKey, subject, p, d.Value, want)
	}
	return d
}

func sevenDefects() []domain.Record {
	pris := []string{"P1", "P2", "P3", "P3", "P3", "P3", "P3"}
	out := make([]domain.Record, len(pris))
	for i, p := range pris {
		out[i] = rec("defect", fmt.Sprintf("CHK-%d", 101+i), rev("2026-10-31", openDefect("Checkout", p)))
	}
	return out
}

func TestDefectExample100PerDay(t *testing.T) {
	nov := mon(2026, 11)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, sevenDefects()...)
	d := wantValue(t, derive(t, in, pointsSum, nov), "checkout", nov, 3000)
	if d.Cutoff != day("2026-11-30") {
		t.Errorf("cutoff = %s, want 2026-11-30", d.Cutoff)
	}
	wantValue(t, derive(t, in, defectDays, nov), "checkout", nov, 30)
}

func TestDailyPriorityChange(t *testing.T) {
	nov := mon(2026, 11)
	p1 := openDefect("Checkout", "P1")
	story := p1
	story.Category = "story"
	r := rec("defect", "CHK-201",
		rev("2026-10-31", openDefect("Checkout", "P3")),
		rev("2026-11-15", p1),
		rev("2026-11-25", story),
	)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, r)

	// Nov 1-14 at P3 (14 x 4), Nov 15-30 at P1 (16 x 64).
	wantValue(t, derive(t, in, pointsSum, nov), "checkout", nov, 14*4+16*64)

	// The where condition reads each day's revision: from Nov 25 it is a story.
	bugs := measure("bug_points_sum", domain.DeriveRule{RecordType: "defect", Op: domain.OpDailyOpenWeighted,
		Weights: defectWeights, Where: "category in ['bug','defect']"})
	wantValue(t, derive(t, in, bugs, nov), "checkout", nov, 14*4+10*64)
}

func TestCutoffMidMonth(t *testing.T) {
	nov := mon(2026, 11)
	resolvedLater := openDefect("Checkout", "P4")
	resolvedLater.State = domain.StateDone
	resolvedLater.CompletedAt = dp("2026-11-20")
	in := deriveInput(t, map[string]string{"defect": "2026-11-14"},
		rec("defect", "CHK-301", rev("2026-11-14", openDefect("Checkout", "P3"))),
		// Completed after the cutoff: still open on every day through it.
		rec("defect", "CHK-302", rev("2026-11-14", resolvedLater)),
	)
	d := wantValue(t, derive(t, in, pointsSum, nov), "checkout", nov, 14*4+14*2)
	if d.Cutoff != day("2026-11-14") {
		t.Errorf("cutoff = %s, want 2026-11-14", d.Cutoff)
	}
	days := wantValue(t, derive(t, in, defectDays, nov), "checkout", nov, 14)
	if days.Cutoff != day("2026-11-14") {
		t.Errorf("days cutoff = %s, want 2026-11-14", days.Cutoff)
	}
}

func TestPeriodAfterLatestSnapshotAbsent(t *testing.T) {
	in := deriveInput(t, map[string]string{"defect": "2026-11-14"}, sevenDefects()...)
	out := derive(t, in, pointsSum, mon(2026, 11), mon(2026, 12))
	cell(t, out, "checkout", mon(2026, 11))
	if hasCell(out, "checkout", mon(2026, 12)) {
		t.Fatalf("December is after the latest snapshot; got %v", cellKeys(out))
	}

	// A record type with no snapshot at all gets no values.
	in.LatestAsOf = nil
	if out := derive(t, in, pointsSum, mon(2026, 11)); len(out) != 0 {
		t.Fatalf("no snapshot: got %v, want none", cellKeys(out))
	}
}

func concept(id, sk string, state domain.RecordState, completed string, planned float64) domain.Record {
	f := domain.RecordFields{SubjectKey: sk, State: state, CreatedAt: day("2026-09-01"), Planned: num(planned)}
	if completed != "" {
		f.CompletedAt = dp(completed)
	}
	return rec("concept", id, rev("2026-12-31", f))
}

func conceptRecords() []domain.Record {
	return []domain.Record{
		concept("BIL-1", "Billing", domain.StateDone, "2026-10-20", 3),
		concept("BIL-2", "Billing", domain.StateDone, "2026-11-02", 10.5),
		concept("BIL-3", "billing", domain.StateDone, "2026-11-30", 4),
		concept("BIL-4", "Billing", domain.StateCancelled, "2026-11-12", 100),
		concept("BIL-5", "Billing", domain.StateOpen, "", 50),
		concept("BIL-6", "Billing", domain.StateDone, "2026-12-05", 7),
		concept("BIL-7", "Billing", domain.StateDone, "2026-09-30", 9),
	}
}

func TestCountBucket(t *testing.T) {
	m := measure("concepts_measured", domain.DeriveRule{RecordType: "concept", Op: domain.OpCount,
		BucketBy: "completedAt", Where: "state == 'done'"})
	in := deriveInput(t, map[string]string{"concept": "2026-12-31"}, conceptRecords()...)
	out := derive(t, in, m, mon(2026, 10), mon(2026, 11), mon(2026, 12))
	wantValue(t, out, "billing", mon(2026, 10), 1)
	wantValue(t, out, "billing", mon(2026, 11), 2)
	wantValue(t, out, "billing", mon(2026, 12), 1)
}

func TestSumPlanned(t *testing.T) {
	m := measure("planned_spend_k", domain.DeriveRule{RecordType: "concept", Op: domain.OpSum,
		BucketBy: "completedAt", Field: "planned", Where: "state == 'done'"})
	in := deriveInput(t, map[string]string{"concept": "2026-12-31"}, conceptRecords()...)
	out := derive(t, in, m, mon(2026, 11))
	wantValue(t, out, "billing", mon(2026, 11), 14.5)
}

func TestAgeSum(t *testing.T) {
	idea := func(id, created, completed string) domain.Record {
		f := domain.RecordFields{SubjectKey: "iOS App", State: domain.StateOpen, CreatedAt: day(created)}
		if completed != "" {
			f.State, f.CompletedAt = domain.StateDone, dp(completed)
		}
		return rec("idea", id, rev("2026-11-14", f))
	}
	m := measure("idea_age_days_sum", domain.DeriveRule{RecordType: "idea", Op: domain.OpAgeSum,
		BucketBy: "createdAt", AgeFrom: "createdAt", AgeTo: "completedAt"})
	in := deriveInput(t, map[string]string{"idea": "2026-11-14"},
		idea("ANL-1", "2026-11-01", "2026-11-05"), // 4 days to first response
		idea("ANL-2", "2026-11-10", ""),           // open: ages to the cutoff, Nov 14
		idea("ANL-3", "2026-10-20", ""),           // October bucket
	)
	out := derive(t, in, m, mon(2026, 10), mon(2026, 11))
	nov := wantValue(t, out, "ios", mon(2026, 11), 8)
	for _, c := range nov.Contributions {
		if c.Reason != "age_days" || c.Amount != 4 {
			t.Errorf("contribution %s: reason %q amount %v, want age_days 4", c.ExternalID, c.Reason, c.Amount)
		}
	}
	if len(nov.Contributions) != 2 {
		t.Fatalf("contributions = %+v, want ANL-1 and ANL-2", nov.Contributions)
	}
	if _, ok := nov.Contributions[1].Dates["completedAt"]; ok {
		t.Errorf("open idea %s lists a completedAt date", nov.Contributions[1].ExternalID)
	}
	// ANL-3's October cell ends on Oct 31: 11 days.
	wantValue(t, out, "ios", mon(2026, 10), 11)
}

func TestAgeSumClampsToCutoff(t *testing.T) {
	// ANL-4 opened in October and closed in November: its October cell ages it
	// only through October 31, because it was still open then.
	f := domain.RecordFields{SubjectKey: "iOS App", State: domain.StateDone, CreatedAt: day("2026-10-20"), CompletedAt: dp("2026-11-05")}
	m := measure("idea_age_days_sum", domain.DeriveRule{RecordType: "idea", Op: domain.OpAgeSum,
		BucketBy: "createdAt", AgeFrom: "createdAt", AgeTo: "completedAt"})
	in := deriveInput(t, map[string]string{"idea": "2026-11-14"}, rec("idea", "ANL-4", rev("2026-11-14", f)))
	oct := wantValue(t, derive(t, in, m, mon(2026, 10)), "ios", mon(2026, 10), 11)
	if got := oct.Contributions[0].Dates["completedAt"]; got.String() != "2026-11-05" {
		t.Errorf("contribution completedAt = %s, want the record's 2026-11-05", got)
	}

	// A record bucketed by completion in the period is never past the cutoff.
	m.Derive.BucketBy = "completedAt"
	wantValue(t, derive(t, in, m, mon(2026, 11)), "ios", mon(2026, 11), 16)
}

func slipEpic() domain.Record {
	return rec("epic", "PAY-12",
		rev("2026-11-30", domain.RecordFields{SubjectKey: "Checkout", State: domain.StateOpen, CreatedAt: day("2026-11-01"), DueAt: dp("2026-12-15")}),
		rev("2027-01-05", domain.RecordFields{SubjectKey: "Checkout", State: domain.StateOpen, CreatedAt: day("2026-11-01"), DueAt: dp("2027-02-10")}),
		rev("2027-02-28", domain.RecordFields{SubjectKey: "Checkout", State: domain.StateDone, CreatedAt: day("2026-11-01"),
			DueAt: dp("2027-02-10"), CompletedAt: dp("2027-02-08")}),
	)
}

func TestCommitmentsAcrossMonths(t *testing.T) {
	dec, jan, feb := mon(2026, 12), mon(2027, 1), mon(2027, 2)
	in := deriveInput(t, map[string]string{"epic": "2027-02-28"}, slipEpic())

	res := derive(t, in, committed, dec, jan, feb)
	wantValue(t, res, "checkout", dec, 1)
	wantValue(t, res, "checkout", jan, 0)
	wantValue(t, res, "checkout", feb, 1)

	met := derive(t, in, onTime, dec, jan, feb)
	wantValue(t, met, "checkout", dec, 0)
	wantValue(t, met, "checkout", feb, 1)
}

func TestPendingCount(t *testing.T) {
	nov := mon(2026, 11)
	epicDue := func(id, due string) domain.Record {
		return rec("epic", id, rev("2026-11-14", domain.RecordFields{SubjectKey: "Billing", State: domain.StateOpen,
			CreatedAt: day("2026-10-01"), DueAt: dp(due)}))
	}
	in := deriveInput(t, map[string]string{"epic": "2026-11-14"},
		epicDue("BIL-10", "2026-11-10"), // passed without completion: missed
		epicDue("BIL-11", "2026-11-25"), // still due this month
	)
	d := wantValue(t, derive(t, in, committed, nov), "billing", nov, 1)
	if d.Pending != 1 {
		t.Errorf("pending = %d, want 1", d.Pending)
	}
	if d := wantValue(t, derive(t, in, onTime, nov), "billing", nov, 0); d.Pending != 1 {
		t.Errorf("on-time pending = %d, want 1", d.Pending)
	}
}

func TestNoSourceKeyIsAbsent(t *testing.T) {
	nov := mon(2026, 11)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, sevenDefects()...)
	out := derive(t, in, pointsSum, nov)
	if hasCell(out, "analytics", nov) {
		t.Errorf("Analytics has no source keys but got a value")
	}
	if hasCell(out, "commerce", nov) {
		t.Errorf("Commerce is a parent unit but got a value")
	}
	if got, want := len(out), 3; got != want { // checkout, billing, ios
		t.Errorf("cells = %v, want checkout, billing, and ios", cellKeys(out))
	}
}

func TestZeroWhenTracked(t *testing.T) {
	nov := mon(2026, 11)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, sevenDefects()...)
	d := wantValue(t, derive(t, in, pointsSum, nov), "billing", nov, 0)
	if len(d.Contributions) != 0 {
		t.Errorf("billing contributions = %v, want none", d.Contributions)
	}
	wantValue(t, derive(t, in, pointsSum, nov), "ios", nov, 0)
}

func TestBeforeTrackedFromAbsent(t *testing.T) {
	sep, oct := mon(2026, 9), mon(2026, 10)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, sevenDefects()...)
	out := derive(t, in, pointsSum, sep, oct)
	if hasCell(out, "checkout", sep) {
		t.Errorf("September is before tracked-from (October); got %v", cellKeys(out))
	}
	cell(t, out, "checkout", oct)

	// The earliest tracked-from month across sources applies.
	types := append([]domain.RecordType(nil), deriveTypes...)
	types[0].TrackedFrom = map[string]period.Period{"tracker": mon(2026, 10), "helpdesk": mon(2026, 8)}
	in.Types = types
	cell(t, derive(t, in, pointsSum, sep), "checkout", sep)
}

func TestParentMatchSkipped(t *testing.T) {
	nov := mon(2026, 11)
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"},
		rec("defect", "CHK-401", rev("2026-10-31", openDefect("Commerce", "P1"))),
		rec("defect", "CHK-402", rev("2026-10-31", openDefect("Nowhere", "P1"))),
		rec("defect", "CHK-403", rev("2026-10-31", openDefect("  chk ", "P4"))),
	)
	out := derive(t, in, pointsSum, nov)
	if hasCell(out, "commerce", nov) {
		t.Errorf("parent unit got a value")
	}
	wantValue(t, out, "checkout", nov, 30*2)

	cases := []struct{ key, id, problem string }{
		{"Commerce", "commerce", "parent"},
		{"Nowhere", "", "unmatched"},
		{"", "", "unmatched"},
		{" CHECKOUT ", "checkout", ""},
		{"ios app", "ios", ""},
	}
	for _, c := range cases {
		id, problem := ResolveSubject(in, c.key, nov)
		if id != c.id || problem != c.problem {
			t.Errorf("ResolveSubject(%q) = (%q, %q), want (%q, %q)", c.key, id, problem, c.id, c.problem)
		}
	}

	// A key on two subjects is ambiguous.
	in.Items = append([]domain.TrackedItem{{ID: "android", Name: "Android App", SourceKeys: []string{"billing"}}}, deriveItems...)
	if id, problem := ResolveSubject(in, "Billing", nov); id != "" || problem != "ambiguous" {
		t.Errorf("ResolveSubject(Billing) = (%q, %q), want ambiguous", id, problem)
	}
}

func TestParentByMonth(t *testing.T) {
	// Billing gains a child unit from December: a leaf in November, a parent after.
	units := append(append([]domain.OrgUnit(nil), deriveUnits...),
		domain.OrgUnit{ID: "billing_core", Name: "Billing Core", ParentID: "commerce", SourceKeys: []string{"BIL-CORE"}})
	tree, err := orgtree.New(units, []domain.OrgMove{{UnitID: "billing_core", NewParentID: "billing", EffectiveMonth: mon(2026, 12)}})
	if err != nil {
		t.Fatal(err)
	}
	in := deriveInput(t, map[string]string{"defect": "2026-12-31"},
		rec("defect", "BIL-501", rev("2026-10-31", openDefect("Billing", "P3"))))
	in.Tree = tree
	out := derive(t, in, pointsSum, mon(2026, 11), mon(2026, 12))
	wantValue(t, out, "billing", mon(2026, 11), 30*4)
	if hasCell(out, "billing", mon(2026, 12)) {
		t.Errorf("billing is a parent in December but got a value")
	}
	if _, problem := ResolveSubject(in, "Billing", mon(2026, 12)); problem != "parent" {
		t.Errorf("ResolveSubject(Billing, Dec) problem = %q, want parent", problem)
	}
}

func TestQuarterGrainBuckets(t *testing.T) {
	q3 := period.Period{Grain: period.Quarter, FY: 2026, Index: 3}
	q4 := period.Period{Grain: period.Quarter, FY: 2026, Index: 4}
	m := measure("concepts_measured", domain.DeriveRule{RecordType: "concept", Op: domain.OpCount,
		BucketBy: "completedAt", Where: "state == 'done'"})
	in := deriveInput(t, map[string]string{"concept": "2026-12-31"}, conceptRecords()...)
	out := derive(t, in, m, q3, q4)
	// Oct 20, Nov 2, Nov 30, Dec 5; the Sep 30 completion is Q3, before tracked-from.
	d := wantValue(t, out, "billing", q4, 4)
	if d.Cutoff != day("2026-12-31") {
		t.Errorf("Q4 cutoff = %s, want 2026-12-31", d.Cutoff)
	}
	if hasCell(out, "billing", q3) {
		t.Errorf("Q3 starts before tracked-from; got %v", cellKeys(out))
	}

	// days_in_period at quarter grain counts every day of the quarter.
	wantValue(t, derive(t, in, measure("concept_days", domain.DeriveRule{RecordType: "concept", Op: domain.OpDaysInPeriod}), q4), "billing", q4, 92)
}

func TestEpicOneDayLate(t *testing.T) {
	nov, dec := mon(2026, 11), mon(2026, 12)
	r := rec("epic", "PAY-40",
		rev("2026-11-15", domain.RecordFields{SubjectKey: "Checkout", State: domain.StateOpen, CreatedAt: day("2026-10-01"), DueAt: dp("2026-11-30")}),
		rev("2026-12-31", domain.RecordFields{SubjectKey: "Checkout", State: domain.StateDone, CreatedAt: day("2026-10-01"),
			DueAt: dp("2026-11-30"), CompletedAt: dp("2026-12-01")}),
	)
	in := deriveInput(t, map[string]string{"epic": "2026-12-31"}, r)
	res := derive(t, in, committed, nov, dec)
	wantValue(t, res, "checkout", nov, 1)
	wantValue(t, res, "checkout", dec, 0)
	met := derive(t, in, onTime, nov, dec)
	d := wantValue(t, met, "checkout", nov, 0)
	if len(d.Contributions) != 1 || d.Contributions[0].Reason != "missed" || d.Contributions[0].Amount != 0 {
		t.Errorf("on-time contributions = %+v, want PAY-40 missed 0", d.Contributions)
	}
}

func TestContributionsListed(t *testing.T) {
	nov := mon(2026, 11)
	recs := sevenDefects()
	recs[0].Revisions[0].Fields.Title = "Card form rejects valid expiry"
	recs[0].Revisions[0].Fields.URL = "https://tracker.example/CHK-101"
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"}, recs...)
	d := cell(t, derive(t, in, pointsSum, nov), "checkout", nov)
	if len(d.Contributions) != 7 {
		t.Fatalf("contributions = %d, want 7", len(d.Contributions))
	}
	c := d.Contributions[0]
	if c.ExternalID != "CHK-101" || c.Source != "tracker" || c.Reason != "open_days" || c.Amount != 64*30 ||
		c.Priority != "P1" || c.State != domain.StateOpen || c.Title != "Card form rejects valid expiry" ||
		c.URL != "https://tracker.example/CHK-101" || c.Dates["createdAt"] != day("2026-10-01") {
		t.Errorf("first contribution = %+v", c)
	}
	for i, want := range []string{"CHK-101", "CHK-102", "CHK-103", "CHK-104", "CHK-105", "CHK-106", "CHK-107"} {
		if d.Contributions[i].ExternalID != want {
			t.Errorf("contribution %d = %s, want %s", i, d.Contributions[i].ExternalID, want)
		}
	}

	// Commitments list each commitment with why it counts.
	ein := deriveInput(t, map[string]string{"epic": "2027-02-28"}, slipEpic())
	dec := cell(t, derive(t, ein, committed, mon(2026, 12)), "checkout", mon(2026, 12))
	if len(dec.Contributions) != 1 || dec.Contributions[0].Reason != "slipped" || dec.Contributions[0].Amount != 1 ||
		dec.Contributions[0].Dates["dueAt"] != day("2026-12-15") {
		t.Errorf("December contributions = %+v, want PAY-12 slipped 1 due 2026-12-15", dec.Contributions)
	}
	feb := cell(t, derive(t, ein, onTime, mon(2027, 2)), "checkout", mon(2027, 2))
	if len(feb.Contributions) != 1 || feb.Contributions[0].Reason != "met" || feb.Contributions[0].Amount != 1 {
		t.Errorf("February contributions = %+v, want PAY-12 met 1", feb.Contributions)
	}

	// Counts list matched records with amount 1.
	cm := measure("concepts_measured", domain.DeriveRule{RecordType: "concept", Op: domain.OpCount,
		BucketBy: "completedAt", Where: "state == 'done'"})
	cin := deriveInput(t, map[string]string{"concept": "2026-12-31"}, conceptRecords()...)
	cn := cell(t, derive(t, cin, cm, nov), "billing", nov)
	if len(cn.Contributions) != 2 || cn.Contributions[0].ExternalID != "BIL-2" || cn.Contributions[0].Reason != "matched" ||
		cn.Contributions[0].Amount != 1 || cn.Contributions[0].Dates["completedAt"] != day("2026-11-02") {
		t.Errorf("count contributions = %+v", cn.Contributions)
	}
}

func TestDeriveRejectsBadRule(t *testing.T) {
	in := deriveInput(t, map[string]string{"defect": "2026-11-30"})
	bad := []domain.Measure{
		{Key: "entered"},
		measure("unknown_type", domain.DeriveRule{RecordType: "release", Op: domain.OpCount, BucketBy: "createdAt"}),
		measure("bad_where", domain.DeriveRule{RecordType: "defect", Op: domain.OpCount, BucketBy: "createdAt", Where: "nope == 1"}),
	}
	for _, m := range bad {
		if _, err := Derive(in, m, []period.Period{mon(2026, 11)}); err == nil {
			t.Errorf("Derive(%s): want an error", m.Key)
		}
	}
}

// benchInput is 50,000 defects over 8 subjects through FY2026, each with two
// revisions (a priority change), and the 12 months of FY2026.
func benchInput(b *testing.B) (DeriveInput, []period.Period) {
	names := []string{"Identity", "Messaging", "Checkout", "Billing", "Analytics", "Pipelines", "iOS App", "Android App"}
	units := []domain.OrgUnit{{ID: "acme", Name: "Acme Demo"}}
	for _, n := range names {
		units = append(units, domain.OrgUnit{ID: n, Name: n, ParentID: "acme", SourceKeys: []string{n}})
	}
	tree, err := orgtree.New(units, nil)
	if err != nil {
		b.Fatal(err)
	}
	rnd := rand.New(rand.NewSource(1))
	pris := []string{"P1", "P2", "P3", "P4", ""}
	cats := []string{"bug", "defect", "story"}
	start := day("2025-07-01")
	recs := make([]domain.Record, 50000)
	for i := range recs {
		created := start.AddDays(rnd.Intn(540))
		f := domain.RecordFields{SubjectKey: names[i%len(names)], Category: cats[rnd.Intn(len(cats))],
			Priority: pris[rnd.Intn(len(pris))], State: domain.StateOpen, CreatedAt: created}
		g := f
		g.Priority = pris[rnd.Intn(len(pris))]
		if rnd.Intn(3) > 0 {
			g.State = domain.StateDone
			g.CompletedAt = func() *domain.Date { d := created.AddDays(1 + rnd.Intn(90)); return &d }()
		}
		recs[i] = rec("defect", fmt.Sprintf("CHK-%d", i), rev(created.AddDays(10).String(), f), rev(created.AddDays(40).String(), g))
	}
	types := []domain.RecordType{{ID: "defect", Name: "Defect", Priorities: []string{"P1", "P2", "P3", "P4"},
		TrackedFrom: map[string]period.Period{"tracker": mon(2026, 1)}}}
	in := DeriveInput{Tree: tree, Types: types, Records: recs, LatestAsOf: map[string]domain.Date{"defect": day("2026-12-31")}}
	var periods []period.Period
	for m := 1; m <= 12; m++ {
		periods = append(periods, mon(2026, m))
	}
	return in, periods
}

func BenchmarkDerive(b *testing.B) {
	in, periods := benchInput(b)
	m := measure("defect_points_sum", domain.DeriveRule{RecordType: "defect", Op: domain.OpDailyOpenWeighted,
		Weights: defectWeights, Where: "category in ['bug','defect']"})
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		out, err := Derive(in, m, periods)
		if err != nil {
			b.Fatal(err)
		}
		if len(out) != 8*12 {
			b.Fatalf("cells = %d, want 96", len(out))
		}
	}
}
