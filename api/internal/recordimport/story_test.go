package recordimport

import (
	"fmt"
	"reflect"
	"slices"
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

// uptimeFixture is the incident fixture with an uptime metric on the
// services, the incident type's downtime link to it (planned maintenance
// filtered out), and October's reported downtime: Webhooks 420 minutes,
// Search 60 and Analytics Ingest 75.
func uptimeFixture(t *testing.T) *fixture {
	t.Helper()
	f := incidentFixture(t)
	f.editVersion(scID, func(m *domain.Methodology) {
		m.Categories = append(m.Categories, domain.Category{ID: "engineering", Name: "Engineering", Order: 2})
		m.Measures = append(m.Measures,
			domain.Measure{Key: "seconds_down", Name: "Seconds down", Unit: "s", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum},
			domain.Measure{Key: "seconds_in_period", Name: "Seconds in period", Unit: "s", OrgAgg: domain.AggNone, TimeAgg: domain.AggSum})
		m.Metrics = append(m.Metrics, domain.Metric{Key: "uptime", Name: "Uptime", CategoryID: "engineering",
			Formula: "(1 - seconds_down / seconds_in_period) * 100", Format: domain.FormatPercent2,
			Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
			ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
			Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
				{Status: "G", Op: ">=", Value: 99.9}, {Status: "Y", Op: ">", Value: 99.8}, {Status: "R"}}}})
	})
	rt := records.IncidentPreset()
	rt.Explains = []domain.ExplainLink{{ScorecardID: scID, MetricKey: "uptime", Mode: domain.ExplainDowntime,
		DownMeasure: "seconds_down", Where: "category != 'Maintenance'"}}
	if err := f.st.PutRecordType(f.ctx, acme.ID, rt, 1); err != nil {
		t.Fatal(err)
	}
	for subject, down := range map[string]float64{"webhooks": 420, "search": 60, "analytics-ingest": 75} {
		f.typed("seconds_down", subject, oct, down*60)
		f.typed("seconds_in_period", subject, oct, 31*86400)
	}
	return f
}

func incidentTexts(s Story) []string {
	var out []string
	for _, l := range s.Incidents {
		out = append(out, l.Text)
	}
	return out
}

func TestStoryIncidentLines(t *testing.T) {
	f := uptimeFixture(t)
	tpl, tbl := incidentSample(t, "tracker", "incidents_tracker.csv")
	f.tpl = tpl
	p := f.build(tbl, "2026-11-01", Answers{})

	// INC-2041 250m, INC-2047 and INC-2049 overlapping (counted once), the
	// cancelled false alarm never counts, and planned maintenance is filtered.
	want := []string{
		"Oct · Analytics Ingest · 1 incident explains 1h 30m of 1h 15m reported",
		"Oct · Search · 1 incident explains 30m of 1h 00m reported",
		"Oct · Webhooks · 3 incidents explain 6h 20m of 7h 00m reported",
	}
	if got := incidentTexts(p.Story); !reflect.DeepEqual(got, want) {
		t.Fatalf("incident lines = %q, want %q", got, want)
	}
	l := p.Story.Incidents[2]
	if l.Period != oct || l.MetricKey != "uptime" || l.SubjectID != "webhooks" || l.SubjectName != "Webhooks" ||
		l.Incidents != 3 || l.Explained != 380 || l.Reported == nil || *l.Reported != 420 {
		t.Errorf("Webhooks line = %+v", l)
	}
	if got := p.Rows.Text(); got != "6 rows → 7 records" {
		t.Errorf("rows = %q, want 6 rows → 7 records", got)
	}
	// Incidents change no value, so there is no value line.
	if len(p.Writes) != 0 || len(p.Story.Lines) != 0 || p.Story.NothingChanged {
		t.Errorf("writes %d, lines %+v, nothing changed %v", len(p.Writes), p.Story.Lines, p.Story.NothingChanged)
	}

	f.apply(p, Answers{})
	again := f.build(tbl, "2026-11-01", Answers{})
	if !again.Story.NothingChanged || len(again.Story.Incidents) != 0 || again.Story.IncidentsMore != 0 {
		t.Errorf("re-preview: nothing changed %v, incident lines %q", again.Story.NothingChanged, incidentTexts(again.Story))
	}
}

func TestStoryIncidentLinesOnlyForChangedIncidents(t *testing.T) {
	f := uptimeFixture(t)
	tpl, tbl := incidentSample(t, "tracker", "incidents_tracker.csv")
	f.tpl = tpl
	f.load(tbl, "2026-11-01")

	// INC-2047 now ends an hour later, covering INC-2049: Webhooks gets a
	// line counting every incident it has (250 + 185 minutes); Search and
	// Analytics Ingest are unchanged.
	const end = 7
	row := slices.IndexFunc(tbl.Rows, func(r []string) bool { return r[0] == "INC-2047" })
	later := tbl
	later.Rows = slices.Clone(tbl.Rows)
	later.Rows[row] = slices.Clone(tbl.Rows[row])
	later.Rows[row][end] = "2026-10-17 12:45"
	p := f.build(later, "2026-11-08", Answers{})
	want := []string{"Oct · Webhooks · 3 incidents explain 7h 15m of 7h 00m reported"}
	if got := incidentTexts(p.Story); !reflect.DeepEqual(got, want) {
		t.Errorf("incident lines = %q, want %q", got, want)
	}
}

func TestStoryIncidentLineWithoutValue(t *testing.T) {
	f := uptimeFixture(t)
	tpl, tbl := incidentSample(t, "oncall", "incidents_oncall.csv")
	f.tpl = tpl
	p := f.build(tbl, "2026-11-01", Answers{})

	// These services report no downtime, so the lines have no reported
	// figure. The Media CDN incident is still open: it counts to the cutoff
	// (the as-of date plus a day), in October and in November.
	got := incidentTexts(p.Story)
	want := []string{
		"Oct · Checkout API · 1 incident explains 44m",
		"Oct · Media CDN · 1 incident explains 1d 7h 20m",
		"Oct · Push Gateway · 1 incident explains 1h 45m",
		"Nov · Media CDN · 1 incident explains 1d 0h 00m",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("incident lines = %q, want %q", got, want)
	}
}

func TestRowCountsText(t *testing.T) {
	for _, c := range []struct {
		rc   RowCounts
		want string
	}{
		{RowCounts{Source: 6, Records: 7}, "6 rows → 7 records"},
		{RowCounts{Source: 3, Records: 3}, "3 rows"},
		{RowCounts{Source: 1, Records: 1}, "1 row"},
		{RowCounts{Source: 1, Records: 2}, "1 row → 2 records"},
		{RowCounts{}, "0 rows"},
	} {
		if got := c.rc.Text(); got != c.want {
			t.Errorf("%+v = %q, want %q", c.rc, got, c.want)
		}
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
