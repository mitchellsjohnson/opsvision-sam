package recordimport

import (
	"slices"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

func never(period.Period) bool { return false }

func (f *fixture) recalc(use []CellRef) []store.DataWrite {
	f.t.Helper()
	ws, err := Recalculate(f.ctx, f.st, acme, scID, never, use)
	if err != nil {
		f.t.Fatalf("Recalculate: %v", err)
	}
	return ws
}

func TestRecalculateAfterApplyIsNoOp(t *testing.T) {
	f := newFixture(t)
	f.load(octoberEpics(), "2026-10-31")
	if ws := f.recalc(nil); len(ws) != 0 {
		t.Errorf("recalculating right after apply writes %+v", ws)
	}
}

func TestRecalcSkipsTypedSlots(t *testing.T) {
	f := newFixture(t)
	f.typed("epics_committed", "checkout", oct, 5)
	p := f.load(octoberEpics(), "2026-10-31")
	if w, ok := writeFor(p.Writes, "epics_committed", "checkout", oct); ok {
		t.Errorf("plan overwrites a typed value: %+v", w)
	}
	if v, src, _ := f.value("epics_committed", "checkout", oct); v != 5 || src != domain.SourceGrid {
		t.Errorf("typed value = %v (%s), want 5 from the grid", v, src)
	}
	if v, src, _ := f.value("epics_on_time", "checkout", oct); v != 2 || src != domain.SourceRecords {
		t.Errorf("the untyped measure = %v (%s), want 2 from records", v, src)
	}
	if ws := f.recalc(nil); len(ws) != 0 {
		t.Errorf("recalculation touches typed slots: %+v", ws)
	}
}

func TestUseRecordsOverridesTyped(t *testing.T) {
	f := newFixture(t)
	f.typed("epics_committed", "checkout", oct, 5)
	cell := CellRef{MeasureKey: "epics_committed", SubjectID: "checkout", Period: oct}
	ans := Answers{UseRecords: []CellRef{cell}}
	p := f.build(octoberEpics(), "2026-10-31", ans)
	w, ok := writeFor(p.Writes, "epics_committed", "checkout", oct)
	if !ok || *w.Point.Value != 2 || w.Point.Source != domain.SourceRecords || w.ExpectedRevision != store.Unconditional {
		t.Fatalf("use records: write = %+v (%v)", w, ok)
	}
	for _, tv := range p.Story.Typed {
		if tv.CellRef == cell {
			t.Errorf("a cell the admin chose records for is still listed as typed: %+v", tv)
		}
	}
	f.apply(p, ans)
	if v, src, _ := f.value("epics_committed", "checkout", oct); v != 2 || src != domain.SourceRecords {
		t.Errorf("after apply = %v (%s), want 2 from records", v, src)
	}
	if ws := f.recalc(nil); len(ws) != 0 {
		t.Errorf("recalculation after use-records writes %+v", ws)
	}
}

func TestDeleteWhenNoLongerDerived(t *testing.T) {
	f := newFixture(t)
	f.typed("incidents", "billing", oct, 1)
	f.load(octoberEpics(), "2026-10-31")
	if _, _, ok := f.value("epics_committed", "billing", oct); !ok {
		t.Fatalf("billing has no derived value to remove")
	}

	// Billing loses its source key, so it no longer gets derived values.
	billing := f.unit("billing")
	billing.SourceKeys = nil
	if err := f.st.PutOrgUnit(f.ctx, acme.ID, billing); err != nil {
		t.Fatal(err)
	}
	ws := f.recalc(nil)
	if len(ws) != 2 {
		t.Fatalf("writes = %+v, want two deletes", ws)
	}
	for _, w := range ws {
		if !w.Delete || w.Point.SubjectID != "billing" || w.ExpectedRevision != store.Unconditional {
			t.Errorf("write = %+v, want an unconditional delete on billing", w)
		}
	}
	if _, err := f.st.PutDataPoints(f.ctx, acme.ID, scID, ws); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := f.value("epics_committed", "billing", oct); ok {
		t.Errorf("billing's derived value is still there")
	}
	if v, src, _ := f.value("incidents", "billing", oct); v != 1 || src != domain.SourceGrid {
		t.Errorf("entered incidents = %v (%s), want the typed 1 untouched", v, src)
	}
}

func TestRecalcCoarserGrain(t *testing.T) {
	f := newFixture(t)
	v, err := f.st.GetVersion(f.ctx, acme.ID, scID, "v1")
	if err != nil {
		t.Fatal(err)
	}
	q := v.Content.Metrics[0]
	q.Key, q.Name, q.Frequency = "on_time_q", "On-time delivery (quarterly)", domain.FrequencyQuarterly
	v.Content.Metrics = append(v.Content.Metrics, q)
	if err := f.st.PutVersion(f.ctx, acme.ID, v, v.Revision); err != nil {
		t.Fatal(err)
	}
	p := f.load(octoberEpics(), "2026-10-31")
	q4 := period.Period{Grain: period.Quarter, FY: 2026, Index: 4}
	if w, ok := writeFor(p.Writes, "epics_committed", "checkout", q4); !ok || *w.Point.Value != 2 {
		t.Errorf("quarterly value = %+v (%v), want 2 for Q4", w, ok)
	}
	if _, ok := writeFor(p.Writes, "epics_committed", "checkout", period.Period{Grain: period.Year, FY: 2026}); ok {
		t.Errorf("no metric reports yearly, but a yearly value was derived")
	}
	if ws := f.recalc(nil); len(ws) != 0 {
		t.Errorf("recalculation after apply writes %+v", ws)
	}
}

func TestDraftPreview(t *testing.T) {
	f := newFixture(t)
	f.load(octoberEpics(), "2026-10-31")
	v, err := f.st.GetVersion(f.ctx, acme.ID, scID, "v1")
	if err != nil {
		t.Fatal(err)
	}
	draft := v
	draft.ID, draft.Name, draft.Status, draft.PublishedAt = "v2", "2026 draft", domain.VersionDraft, nil
	draft.Content.Measures = append(append([]domain.Measure(nil), v.Content.Measures...),
		derivedMeasure("epics_done", "Epics done", domain.DeriveRule{RecordType: "epic", Op: domain.OpCount, BucketBy: "completedAt", Where: "state == 'done'"}))
	done := domain.Metric{Key: "epics_delivered", Name: "Epics delivered", CategoryID: "delivery", Formula: "epics_done",
		Format: domain.FormatNumber0, Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
		ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
		Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{{Status: "G", Op: ">=", Value: 1}, {Status: "R"}}}}
	draft.Content.Metrics = append(append([]domain.Metric(nil), v.Content.Metrics...), done)

	if p := f.build(octoberEpics(), "2026-10-31", Answers{}); !p.Story.NothingChanged {
		t.Fatalf("without the draft the re-upload should change nothing")
	}
	p, err := Build(f.ctx, f.st, acme, scID, f.tpl, octoberEpics(), day("2026-10-31"), Answers{}, &draft)
	if err != nil {
		t.Fatal(err)
	}
	if w, ok := writeFor(p.Writes, "epics_done", "checkout", oct); !ok || *w.Point.Value != 2 {
		t.Errorf("draft measure for checkout = %+v (%v), want 2", w, ok)
	}
	if w, ok := writeFor(p.Writes, "epics_done", "billing", oct); !ok || *w.Point.Value != 0 {
		t.Errorf("draft measure for billing = %+v (%v), want 0", w, ok)
	}
	if p.Story.NothingChanged {
		t.Errorf("the draft's new values are a change")
	}
	var line *StoryLine
	for i, l := range p.Story.Lines {
		if l.MetricKey == "epics_delivered" && l.SubjectID == "checkout" && l.Period == oct {
			line = &p.Story.Lines[i]
		}
	}
	if line == nil || line.BeforeDisplay != "" || line.AfterDisplay != "2" || line.AfterStatus != "G" {
		t.Errorf("story line for the draft metric = %+v", line)
	}
	if vs, _ := f.st.ListVersions(f.ctx, acme.ID, scID); len(vs) != 1 {
		t.Errorf("Build stored the draft")
	}
	if _, _, ok := f.value("epics_done", "checkout", oct); ok {
		t.Errorf("Build stored a draft value")
	}
}

// editVersion replaces v1's content with edit's result, bypassing publish
// validation, as a record type edit after publishing would leave it.
func (f *fixture) editVersion(scorecardID string, edit func(*domain.Methodology)) {
	f.t.Helper()
	v, err := f.st.GetVersion(f.ctx, acme.ID, scorecardID, "v1")
	if err != nil {
		f.t.Fatal(err)
	}
	edit(&v.Content)
	if err := f.st.PutVersion(f.ctx, acme.ID, v, v.Revision); err != nil {
		f.t.Fatal(err)
	}
}

func TestBadMeasureDoesNotStopTheOthers(t *testing.T) {
	f := newFixture(t)
	f.editVersion(scID, func(m *domain.Methodology) {
		m.Measures = append(m.Measures,
			// triagedAt is not a field of epics: this measure cannot be derived.
			derivedMeasure("epics_triaged", "Epics triaged", domain.DeriveRule{RecordType: "epic", Op: domain.OpCount, BucketBy: "triagedAt"}),
			derivedMeasure("epic_points", "Epic points", domain.DeriveRule{RecordType: "epic", Op: domain.OpDailyOpenWeighted, Weights: map[string]float64{"none": 1}}))
	})
	// A records point the bad measure got before is kept, not deleted.
	kept := 7.0
	if _, err := f.st.PutDataPoints(f.ctx, acme.ID, scID, []store.DataWrite{{Point: domain.DataPoint{
		MeasureKey: "epics_triaged", SubjectID: "checkout", Period: oct, Value: &kept, Source: domain.SourceRecords},
		ExpectedRevision: store.Unconditional}}); err != nil {
		t.Fatal(err)
	}
	// P0 is added to epics after the weighted rule was published.
	if err := f.st.PutRecordType(f.ctx, acme.ID, domain.RecordType{ID: "epic", Name: "Epic", Priorities: []string{"P0"},
		TrackedFrom: map[string]period.Period{"tracker": oct}}, 1); err != nil {
		t.Fatal(err)
	}

	p := f.build(octoberEpics(), "2026-10-31", Answers{})
	if w, ok := writeFor(p.Writes, "epics_on_time", "checkout", oct); !ok || *w.Point.Value != 2 {
		t.Errorf("epics_on_time checkout = %+v (%v), want 2", w, ok)
	}
	for _, w := range p.Writes {
		if w.Point.MeasureKey == "epics_triaged" {
			t.Errorf("the bad measure got a write: %+v", w)
		}
	}
	want := []string{
		"P0 has no weight in Epic points, so it counts as 0. Add a weight in the methodology.",
		"We couldn't work out Epics triaged from records, so its values stay as they are. Check its rule in the methodology.",
	}
	got := append([]string(nil), p.Story.Warnings...)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("warnings = %q, want %q", got, want)
	}
	f.apply(p, Answers{})
	if v, src, ok := f.value("epics_triaged", "checkout", oct); !ok || v != 7 || src != domain.SourceRecords {
		t.Errorf("epics_triaged after apply = %v (%s, %v), want the stored 7 kept", v, src, ok)
	}
	if v, _, _ := f.value("epics_on_time", "checkout", oct); v != 2 {
		t.Errorf("epics_on_time after apply = %v, want 2", v)
	}
	if ws := f.recalc(nil); len(ws) != 0 {
		t.Errorf("recalculating after apply writes %+v", ws)
	}
}

func TestApplyRecalculatesEveryScorecard(t *testing.T) {
	f := newFixture(t)
	if err := f.st.PutScorecard(f.ctx, acme.ID, domain.Scorecard{ID: "sc2", Name: "Portfolio"}); err != nil {
		t.Fatal(err)
	}
	v, err := f.st.GetVersion(f.ctx, acme.ID, scID, "v1")
	if err != nil {
		t.Fatal(err)
	}
	v.ScorecardID, v.Revision = "sc2", 0
	if err := f.st.PutVersion(f.ctx, acme.ID, v, 0); err != nil {
		t.Fatal(err)
	}
	f.load(octoberEpics(), "2026-10-31")
	for _, sc := range []string{scID, "sc2"} {
		pts, _, err := f.st.ListData(f.ctx, acme.ID, sc, []int{2026})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, dp := range pts {
			if dp.MeasureKey == "epics_on_time" && dp.SubjectID == "checkout" && dp.Period == oct {
				found = dp.Value != nil && *dp.Value == 2 && dp.Source == domain.SourceRecords && dp.EnteredBy == "admin-1"
			}
		}
		if !found {
			t.Errorf("scorecard %s: epics_on_time checkout October missing or wrong in %+v", sc, pts)
		}
	}
	if ws, err := Recalculate(f.ctx, f.st, acme, "sc2", never, nil); err != nil || len(ws) != 0 {
		t.Errorf("sc2 recalculation after apply = %+v, %v; want nothing to do", ws, err)
	}
}

func TestLoadDeriveInputDropsOrphanRevisions(t *testing.T) {
	f := newFixture(t)
	f.load(octoberEpics(), "2026-10-31")
	// A revision whose snapshot was never stored (a failed partial apply).
	orphan := store.RecordRevisionWrite{Source: "tracker", ExternalID: "CHK-9", Type: "epic",
		Rev: domain.RecordRevision{AsOf: day("2026-10-31"), SnapshotID: "lost", Fields: domain.RecordFields{SubjectKey: "Checkout", State: domain.StateOpen}}}
	if err := f.st.ApplySnapshot(f.ctx, acme.ID, domain.Snapshot{ID: "tmp", RecordType: "epic", Source: "tracker", AsOf: day("2026-10-31")}, []store.RecordRevisionWrite{orphan}); err != nil {
		t.Fatal(err)
	}
	in, err := LoadDeriveInput(f.ctx, f.st, acme, scID)
	if err != nil {
		t.Fatal(err)
	}
	if in.Tree == nil || len(in.Types) != 1 || in.LatestAsOf["epic"].String() != "2026-10-31" {
		t.Fatalf("input = %+v", in)
	}
	ids := map[string]bool{}
	for _, r := range in.Records {
		ids[r.ExternalID] = true
		for _, rv := range r.Revisions {
			if rv.SnapshotID == "lost" {
				t.Errorf("orphan revision kept on %s", r.ExternalID)
			}
		}
	}
	if !ids["CHK-1"] || !ids["BIL-1"] {
		t.Errorf("records = %v", ids)
	}
}
