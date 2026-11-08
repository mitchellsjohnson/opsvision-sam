package recordimport

import (
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
