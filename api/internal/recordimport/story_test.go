package recordimport

import (
	"fmt"
	"reflect"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/records"
)

func ids(cs []records.Contribution) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.ExternalID
	}
	return out
}

func TestStorySlippedEpics(t *testing.T) {
	f := newFixture(t)
	f.load(epicTable(
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
		doneEpic("CHK-2", "Checkout", "2026-10-12", "2026-10-12"),
		openEpic("CHK-3", "Checkout", "2026-10-20"),
		openEpic("CHK-4", "Checkout", "2026-10-25"),
		openEpic("CHK-5", "Checkout", "2026-10-28"),
	), "2026-10-15")

	// By October 31 the three open epics have moved into November.
	p := f.build(epicTable(
		doneEpic("CHK-1", "Checkout", "2026-10-10", "2026-10-08"),
		doneEpic("CHK-2", "Checkout", "2026-10-12", "2026-10-12"),
		openEpic("CHK-3", "Checkout", "2026-11-15"),
		openEpic("CHK-4", "Checkout", "2026-11-20"),
		openEpic("CHK-5", "Checkout", "2026-11-25"),
	), "2026-10-31", Answers{})

	var lines []StoryLine
	for _, l := range p.Story.Lines {
		if l.MetricKey == "on_time" && l.SubjectID == "checkout" {
			lines = append(lines, l)
		}
	}
	if len(lines) != 1 {
		t.Fatalf("checkout on-time lines = %+v, want one", lines)
	}
	l := lines[0]
	want := StoryLine{Period: oct, MetricKey: "on_time", MetricName: "On-time delivery", SubjectID: "checkout", SubjectName: "Checkout",
		BeforeDisplay: "100%", AfterDisplay: "40%", BeforeStatus: "G", AfterStatus: "R"}
	got := l
	got.Reasons = nil
	if !reflect.DeepEqual(got, want) {
		t.Errorf("line = %+v, want %+v", got, want)
	}
	if len(l.Reasons) != 1 || !reflect.DeepEqual(ids(l.Reasons[ReasonSlipped]), []string{"CHK-3", "CHK-4", "CHK-5"}) {
		t.Errorf("reasons = %+v, want slipped CHK-3, CHK-4, CHK-5", l.Reasons)
	}
	if first := p.Story.Lines[0]; first.BeforeStatus != "G" || first.AfterStatus != "R" {
		t.Errorf("first line = %+v, want the worst status change first", first)
	}
	if p.Story.More != 0 || len(p.Story.LockedWaiting) != 0 {
		t.Errorf("more = %d, locked = %+v", p.Story.More, p.Story.LockedWaiting)
	}
}

func TestTypedVsRecords(t *testing.T) {
	f := newFixture(t)
	f.typed("epics_committed", "checkout", oct, 66)
	f.typed("epics_on_time", "checkout", oct, 48)
	var rows []epic
	for i := 1; i <= 66; i++ {
		due := fmt.Sprintf("2026-10-%02d", i%28+1)
		resolved := due // on time
		if i > 47 {
			resolved = "2026-10-30" // late
		}
		rows = append(rows, doneEpic(fmt.Sprintf("CHK-%d", i), "Checkout", due, resolved))
	}
	p := f.build(epicTable(rows...), "2026-10-31", Answers{})

	byMeasure := map[string]TypedVsRecords{}
	for _, tv := range p.Story.Typed {
		if tv.SubjectID == "checkout" && tv.Period == oct {
			byMeasure[tv.MeasureKey] = tv
		}
	}
	on := byMeasure["epics_on_time"]
	if on.Typed != 48 || on.Records != 47 || on.TypedSource != domain.SourceGrid || len(on.Contributions) != 66 {
		t.Errorf("on time = typed %v (%s), records %v, %d contributions; want 48 vs 47 with 66",
			on.Typed, on.TypedSource, on.Records, len(on.Contributions))
	}
	if c := byMeasure["epics_committed"]; c.Typed != 66 || c.Records != 66 || len(c.Contributions) != 66 {
		t.Errorf("committed = %+v, want 66 vs 66", c)
	}
	for _, m := range []string{"epics_committed", "epics_on_time"} {
		if w, ok := writeFor(p.Writes, m, "checkout", oct); ok {
			t.Errorf("typed %s overwritten: %+v", m, w)
		}
	}
	// Billing has no typed values, so it is not listed.
	for _, tv := range p.Story.Typed {
		if tv.SubjectID == "billing" {
			t.Errorf("billing listed as typed: %+v", tv)
		}
	}
}

func TestTypedEqualToRecordsNotListed(t *testing.T) {
	f := newFixture(t)
	f.typed("epics_committed", "checkout", oct, 2)
	f.typed("epics_on_time", "checkout", oct, 2)
	if p := f.build(octoberEpics(), "2026-10-31", Answers{}); len(p.Story.Typed) != 0 {
		t.Errorf("typed values that agree with records are listed: %+v", p.Story.Typed)
	}
}

func con(id, reason, pri string, state domain.RecordState, amount float64) records.Contribution {
	return records.Contribution{Source: "tracker", ExternalID: id, Reason: reason, Priority: pri, State: state, Amount: amount}
}

func TestContributionReasons(t *testing.T) {
	open, done := domain.StateOpen, domain.StateDone
	before := []records.Contribution{
		con("CHK-1", records.ReasonPending, "", open, 0),    // becomes met
		con("CHK-2", records.ReasonPending, "", open, 0),    // becomes missed
		con("CHK-3", records.ReasonOpenDays, "P3", open, 4), // P3 -> P1
		con("CHK-4", records.ReasonOpenDays, "P2", open, 16),
		con("CHK-5", records.ReasonOpenDays, "P2", open, 16), // gone
		con("CHK-6", records.ReasonOpenDays, "none", open, 1),
		con("CHK-7", records.ReasonOpenDays, "P4", open, 2), // only more days
	}
	after := []records.Contribution{
		con("CHK-1", records.ReasonMet, "", done, 1),
		con("CHK-2", records.ReasonMissed, "", open, 1),
		con("CHK-3", records.ReasonOpenDays, "P1", open, 64),
		con("CHK-4", records.ReasonOpenDays, "P2", done, 8),
		con("CHK-6", records.ReasonOpenDays, "", open, 1), // none and "" are the same
		con("CHK-7", records.ReasonOpenDays, "P4", open, 4),
		con("CHK-8", records.ReasonOpenDays, "P1", open, 64), // new record
		con("CHK-9", records.ReasonOpenDays, "P2", open, 16), // existing record, new here
	}
	got := map[string][]string{}
	for reason, cs := range contributionReasons(before, after, map[string]bool{"tracker/CHK-8": true}) {
		got[reason] = ids(cs)
	}
	want := map[string][]string{
		ReasonMet:             {"CHK-1"},
		ReasonMissed:          {"CHK-2"},
		ReasonPriorityChanged: {"CHK-3"},
		ReasonClosed:          {"CHK-4"},
		ReasonRemoved:         {"CHK-5"},
		ReasonNewlyOpen:       {"CHK-8"},
		ReasonAdded:           {"CHK-9"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("reasons = %v, want %v", got, want)
	}
}

func TestStoryLineOrderAndLimit(t *testing.T) {
	ranks := statusRanks(acme)
	f := func(v float64) *float64 { return &v }
	ls := []scoredLine{
		{StoryLine: StoryLine{MetricKey: "a", BeforeStatus: "G", AfterStatus: "G"}, before: f(90), after: f(99)},
		{StoryLine: StoryLine{MetricKey: "b", BeforeStatus: "G", AfterStatus: "Y"}, before: f(90), after: f(85)},
		{StoryLine: StoryLine{MetricKey: "c", BeforeStatus: "R", AfterStatus: "G"}, before: f(10), after: f(95)},
		{StoryLine: StoryLine{MetricKey: "d", BeforeStatus: "G", AfterStatus: "R"}, before: f(95), after: f(40)},
		{StoryLine: StoryLine{MetricKey: "e", BeforeStatus: "G", AfterStatus: "G"}, before: f(95), after: f(94)},
	}
	lines, more := orderLines(ls, ranks, 50)
	var keys []string
	for _, l := range lines {
		keys = append(keys, l.MetricKey)
	}
	if want := []string{"d", "b", "c", "a", "e"}; !reflect.DeepEqual(keys, want) || more != 0 {
		t.Errorf("order = %v (more %d), want %v", keys, more, want)
	}
	if lines, more := orderLines(ls, ranks, 2); len(lines) != 2 || more != 3 {
		t.Errorf("limit 2: %d lines, more %d", len(lines), more)
	}
}

func TestStoryOnlyChangedMeasures(t *testing.T) {
	f := newFixture(t)
	f.typed("incidents", "checkout", oct, 3)
	p := f.build(octoberEpics(), "2026-10-31", Answers{})
	for _, l := range p.Story.Lines {
		if l.MetricKey == "incident_count" {
			t.Errorf("incidents did not change but has a line: %+v", l)
		}
	}
	if len(p.Story.Lines) == 0 {
		t.Errorf("no story lines for the first upload")
	}
}
