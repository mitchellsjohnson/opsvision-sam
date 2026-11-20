package rca_test

import (
	"math"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/rca"
)

var cal = period.Calendar{}

func month(y, m int) period.Period { return period.Period{Grain: period.Month, FY: y, Index: m} }

func ts(s string) time.Time {
	t, err := time.Parse("2006-01-02T15:04", s)
	if err != nil {
		panic(err)
	}
	return t
}

func tp(s string) *time.Time { t := ts(s); return &t }

func date(s string) domain.Date {
	d, err := domain.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

func dp(s string) *domain.Date { d := date(s); return &d }

func fp(f float64) *float64 { return &f }

var farCutoff = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)

// inc is a done incident from the tracker with a start and an end, all UTC.
func inc(key, start, end string, impact float64) rca.Incident {
	return rca.Incident{
		Source: "tracker", ExternalID: key, Key: key, State: domain.StateDone,
		Start: tp(start), End: tp(end), Impact: impact,
		CreatedAt: date(start[:10]), Cutoff: farCutoff,
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func item(t *testing.T, d rca.Downtime, key string) rca.Counted {
	t.Helper()
	for _, c := range d.Items {
		if c.Incident.Key == key {
			return c
		}
	}
	t.Fatalf("no item %s in %+v", key, d.Items)
	return rca.Counted{}
}

func TestPeriodWindow(t *testing.T) {
	w := rca.PeriodWindow(cal, month(2026, 9), time.UTC)
	if !w.Start.Equal(ts("2026-09-01T00:00")) || !w.End.Equal(ts("2026-10-01T00:00")) || w.Minutes() != 43200 {
		t.Fatalf("Sep window = %+v (%v min)", w, w.Minutes())
	}
	q := rca.PeriodWindow(cal, period.Period{Grain: period.Quarter, FY: 2026, Index: 3}, time.UTC)
	if !q.Start.Equal(ts("2026-07-01T00:00")) || !q.End.Equal(ts("2026-10-01T00:00")) {
		t.Fatalf("Q3 window = %+v", q)
	}
	// A fiscal year starting in April: month 1 is April.
	fy := period.Calendar{FiscalYearStartMonth: time.April}
	if w := rca.PeriodWindow(fy, month(2027, 1), time.UTC); !w.Start.Equal(ts("2026-04-01T00:00")) {
		t.Fatalf("FY April month 1 = %+v", w)
	}
	// Another location moves the boundaries to its midnight.
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	if w := rca.PeriodWindow(cal, month(2026, 10), ny); !w.Start.Equal(ts("2026-10-01T04:00")) || !w.End.Equal(ts("2026-11-01T04:00")) {
		t.Fatalf("New York Oct window = %+v", w)
	}
	if w := rca.PeriodWindow(cal, month(2026, 10), nil); !w.Start.Equal(ts("2026-10-01T00:00")) {
		t.Fatalf("nil location should be UTC: %+v", w)
	}
}

func TestCutoff(t *testing.T) {
	c := rca.Cutoff(date("2026-11-14"))
	if !c.Equal(ts("2026-11-15T00:00")) || c.Location() != time.UTC {
		t.Fatalf("Cutoff(Nov 14) = %v", c)
	}
}

func TestWorkedExample(t *testing.T) {
	sep := rca.PeriodWindow(cal, month(2026, 9), time.UTC)
	d := rca.CountDowntime(sep, 43200, 216, []rca.Incident{
		inc("INC-1203", "2026-09-30T23:05", "2026-10-01T00:50", 1),
		inc("INC-1187", "2026-09-09T13:12", "2026-09-09T15:42", 1),
	})
	if len(d.Items) != 2 || d.Items[0].Incident.Key != "INC-1187" || d.Items[1].Incident.Key != "INC-1203" {
		t.Fatalf("items = %+v", d.Items)
	}
	a, b := d.Items[0], d.Items[1]
	if a.Minutes != 150 || a.TotalMinutes != 150 || a.EndedAfter || a.StartedBefore {
		t.Fatalf("INC-1187 = %+v", a)
	}
	if b.Minutes != 55 || b.TotalMinutes != 105 || !b.EndedAfter || b.StartedBefore {
		t.Fatalf("INC-1203 = %+v", b)
	}
	if d.PeriodMinutes != 43200 || d.ReportedMinutes != 216 || d.Explained != 205 || d.Unexplained != 11 || d.Excess != 0 {
		t.Fatalf("totals = %+v", d)
	}
	if d.WithinTolerance {
		t.Fatal("11 of 216 is not within tolerance")
	}

	// The same incident in October counts the rest of its minutes and started before.
	oct := rca.CountDowntime(rca.PeriodWindow(cal, month(2026, 10), time.UTC), 44640, 50, []rca.Incident{
		inc("INC-1203", "2026-09-30T23:05", "2026-10-01T00:50", 1),
	})
	if c := oct.Items[0]; c.Minutes != 50 || c.TotalMinutes != 105 || !c.StartedBefore || c.EndedAfter {
		t.Fatalf("INC-1203 in Oct = %+v", c)
	}
}

func TestOverlapCountedOnce(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	d := rca.CountDowntime(oct, 44640, 420, []rca.Incident{
		inc("INC-2049", "2026-10-17T11:20", "2026-10-17T11:50", 1),
		inc("INC-2041", "2026-10-03T14:05", "2026-10-03T18:15", 1),
		inc("INC-2047", "2026-10-17T09:40", "2026-10-17T11:45", 1),
	})
	var keys []string
	var mins []float64
	for _, c := range d.Items {
		keys = append(keys, c.Incident.Key)
		mins = append(mins, c.Minutes)
	}
	if len(keys) != 3 || keys[0] != "INC-2041" || keys[1] != "INC-2047" || keys[2] != "INC-2049" {
		t.Fatalf("order = %v", keys)
	}
	if !near(mins[0], 250) || !near(mins[1], 112.5) || !near(mins[2], 17.5) {
		t.Fatalf("minutes = %v, want 250, 112.5, 17.5", mins)
	}
	if got := item(t, d, "INC-2047").Overlaps["INC-2049"]; got != 25 {
		t.Fatalf("INC-2047 overlaps INC-2049 for %v, want 25", got)
	}
	if got := item(t, d, "INC-2049").Overlaps["INC-2047"]; got != 25 {
		t.Fatalf("INC-2049 overlaps INC-2047 for %v, want 25", got)
	}
	if len(item(t, d, "INC-2041").Overlaps) != 0 {
		t.Fatalf("INC-2041 overlaps nothing: %v", item(t, d, "INC-2041").Overlaps)
	}
	if !near(d.Explained, 380) || !near(d.Unexplained, 40) || d.Excess != 0 {
		t.Fatalf("explained %v, unexplained %v, excess %v", d.Explained, d.Unexplained, d.Excess)
	}
}

func TestOverlapSplitByImpact(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	d := rca.CountDowntime(oct, 44640, 75, []rca.Incident{
		inc("A", "2026-10-20T10:00", "2026-10-20T11:00", 1),
		inc("B", "2026-10-20T10:30", "2026-10-20T11:30", 0.5),
	})
	a, b := item(t, d, "A"), item(t, d, "B")
	// 10:00–10:30 A 30; 10:30–11:00 down 30, split A 20 / B 10; 11:00–11:30 B 15.
	if !near(a.Minutes, 50) || !near(b.Minutes, 25) || !near(d.Explained, 75) {
		t.Fatalf("A %v, B %v, explained %v; want 50, 25, 75", a.Minutes, b.Minutes, d.Explained)
	}
	if a.Overlaps["B"] != 30 || b.Overlaps["A"] != 30 {
		t.Fatalf("overlaps = %v, %v", a.Overlaps, b.Overlaps)
	}
	if d.Unexplained != 0 || d.Excess != 0 || !d.WithinTolerance {
		t.Fatalf("totals = %+v", d)
	}
}

func TestThreeWayOverlap(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	d := rca.CountDowntime(oct, 44640, 60, []rca.Incident{
		inc("X", "2026-10-05T10:00", "2026-10-05T11:00", 1),
		inc("Y", "2026-10-05T10:00", "2026-10-05T11:00", 1),
		inc("Z", "2026-10-05T10:00", "2026-10-05T11:00", 1),
	})
	for _, k := range []string{"X", "Y", "Z"} {
		if c := item(t, d, k); !near(c.Minutes, 20) || c.Overlaps["X"]+c.Overlaps["Y"]+c.Overlaps["Z"] != 120 {
			t.Fatalf("%s = %+v", k, c)
		}
	}
	if !near(d.Explained, 60) {
		t.Fatalf("explained %v, want the union 60", d.Explained)
	}
	// Equal counted minutes and starts fall back to key order.
	if d.Items[0].Incident.Key != "X" || d.Items[2].Incident.Key != "Z" {
		t.Fatalf("order = %v, %v, %v", d.Items[0].Incident.Key, d.Items[1].Incident.Key, d.Items[2].Incident.Key)
	}
}

// pointsAndRemainder lists each item's exact points in evidence order, then
// the remainder's.
func pointsAndRemainder(d rca.Downtime) []float64 {
	var out []float64
	for _, c := range d.Items {
		out = append(out, c.Minutes/d.PeriodMinutes*100)
	}
	return append(out, d.Unexplained/d.PeriodMinutes*100)
}

func sumUnits(parts []float64, decimals int) int64 {
	var n int64
	for _, p := range parts {
		n += int64(math.Round(p * math.Pow10(decimals)))
	}
	return n
}

// TestCountDowntimeMixed is Review Focus 1: overlapping incidents with
// unequal impact, one across the month boundary, one ongoing at its source's
// cutoff, a tie in rounding, and rounded parts equal to the displayed gap.
func TestCountDowntimeMixed(t *testing.T) {
	ongoing := rca.Incident{
		Source: "oncall", ExternalID: "88533", Key: "88533", State: domain.StateOpen,
		Start: tp("2026-10-31T22:00"), CreatedAt: date("2026-10-31"), Cutoff: rca.Cutoff(date("2026-11-14")),
	}
	incs := []rca.Incident{
		inc("INC-2041", "2026-10-03T14:05", "2026-10-03T18:15", 1),
		inc("INC-2047", "2026-10-17T09:40", "2026-10-17T11:45", 1),
		inc("INC-2049", "2026-10-17T11:20", "2026-10-17T11:50", 1),
		inc("A", "2026-10-20T10:00", "2026-10-20T11:00", 1),
		inc("B", "2026-10-20T10:30", "2026-10-20T11:30", 0.5),
		inc("INC-1203", "2026-09-30T23:05", "2026-10-01T00:50", 1),
		ongoing,
	}

	oct := rca.CountDowntime(rca.PeriodWindow(cal, month(2026, 10), time.UTC), 44640, 640, incs)
	o := item(t, oct, "88533")
	if o.Minutes != 120 || !o.Ongoing || !o.EndedAfter {
		t.Fatalf("ongoing in Oct = %+v", o)
	}
	if c := item(t, oct, "INC-1203"); c.Minutes != 50 || !c.StartedBefore {
		t.Fatalf("INC-1203 in Oct = %+v", c)
	}
	// 250 + 112.5 + 17.5 + 50 + 25 + 50 + 120.
	if !near(oct.Explained, 625) || !near(oct.Unexplained, 15) {
		t.Fatalf("Oct explained %v, unexplained %v", oct.Explained, oct.Unexplained)
	}

	nov := rca.CountDowntime(rca.PeriodWindow(cal, month(2026, 11), time.UTC), 43200, 20200, incs)
	if len(nov.Items) != 1 {
		t.Fatalf("Nov items = %+v", nov.Items)
	}
	n := nov.Items[0]
	if n.Minutes != 14*24*60 || !n.Ongoing || !n.StartedBefore || n.EndedAfter {
		t.Fatalf("ongoing in Nov = %+v (want counted to Nov 15 00:00)", n)
	}
	if n.TotalMinutes != 14*24*60+120 {
		t.Fatalf("ongoing total = %v", n.TotalMinutes)
	}

	for _, d := range []rca.Downtime{oct, nov} {
		value := 100 - d.ReportedMinutes/d.PeriodMinutes*100
		display := engine.Format(domain.FormatPercent2, value)
		units, ok := rca.GapUnits(100, display, 2)
		if !ok {
			t.Fatalf("GapUnits(%q) failed", display)
		}
		parts := rca.RoundParts(pointsAndRemainder(d), float64(units)/100, 2)
		if got := sumUnits(parts, 2); got != units {
			t.Fatalf("%s: rounded parts %v sum to %d hundredths, want the displayed gap %d", display, parts, got, units)
		}
		mins := []float64{}
		for _, c := range d.Items {
			mins = append(mins, c.Minutes)
		}
		mins = append(mins, d.Unexplained)
		if got := sumUnits(rca.RoundParts(mins, math.Round(d.ReportedMinutes), 0), 0); got != int64(math.Round(d.ReportedMinutes)) {
			t.Fatalf("%s: rounded minutes sum to %d, want %v", display, got, d.ReportedMinutes)
		}
	}
	// The tie in Oct: INC-2047 (112.5) and INC-2049 (17.5) both have .5; the
	// one with more counted minutes takes the unit.
	mins := []float64{}
	for _, c := range oct.Items {
		mins = append(mins, c.Minutes)
	}
	rounded := rca.RoundParts(append(mins, oct.Unexplained), 640, 0)
	for i, c := range oct.Items {
		switch c.Incident.Key {
		case "INC-2047":
			if rounded[i] != 113 {
				t.Errorf("INC-2047 rounds to %v, want 113", rounded[i])
			}
		case "INC-2049":
			if rounded[i] != 17 {
				t.Errorf("INC-2049 rounds to %v, want 17", rounded[i])
			}
		}
	}
}

func TestRemainderWithinTolerance(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	ten := inc("INC-1", "2026-10-05T00:00", "2026-10-05T09:55", 1) // 595 minutes
	d := rca.CountDowntime(oct, 44640, 600, []rca.Incident{ten})
	if d.Unexplained != 5 || !d.WithinTolerance || d.Excess != 0 {
		t.Fatalf("595 of 600: %+v", d)
	}
	d = rca.CountDowntime(oct, 44640, 600, []rca.Incident{inc("INC-1", "2026-10-05T00:00", "2026-10-05T09:50", 1)})
	if d.Unexplained != 10 || d.WithinTolerance {
		t.Fatalf("590 of 600: %+v", d)
	}
	d = rca.CountDowntime(oct, 44640, 75, []rca.Incident{inc("INC-2052", "2026-10-22T02:10", "2026-10-22T03:40", 1)})
	if d.Excess != 15 || d.Unexplained != 0 || d.WithinTolerance {
		t.Fatalf("90 of 75: %+v", d)
	}
	// One minute either way is always within tolerance.
	d = rca.CountDowntime(oct, 44640, 31, []rca.Incident{inc("INC-1", "2026-10-05T00:00", "2026-10-05T00:30", 1)})
	if d.Unexplained != 1 || !d.WithinTolerance {
		t.Fatalf("30 of 31: %+v", d)
	}
}

func TestSameWindowAcrossSources(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	tracker := inc("INC-2041", "2026-10-03T14:05", "2026-10-03T18:15", 1)
	page := inc("sp-7h1q", "2026-10-03T14:00", "2026-10-03T18:20", 1)
	page.Source = "status-page"
	other := inc("INC-2042", "2026-10-03T17:00", "2026-10-03T20:00", 1) // same source as INC-2041, and under 80%
	d := rca.CountDowntime(oct, 44640, 300, []rca.Incident{tracker, page, other})
	a, b := item(t, d, "INC-2041"), item(t, d, "sp-7h1q")
	if len(a.SameWindowAs) != 1 || a.SameWindowAs[0] != "sp-7h1q" || len(b.SameWindowAs) != 1 || b.SameWindowAs[0] != "INC-2041" {
		t.Fatalf("same window: %v / %v", a.SameWindowAs, b.SameWindowAs)
	}
	if len(item(t, d, "INC-2042").SameWindowAs) != 0 {
		t.Fatalf("INC-2042 = %v", item(t, d, "INC-2042").SameWindowAs)
	}
	two := rca.CountDowntime(oct, 44640, 260, []rca.Incident{tracker, page})
	if !near(two.Explained, 260) {
		t.Fatalf("explained %v, want the union 260", two.Explained)
	}
}

func TestDurationOnlyAndUnknown(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	nov := rca.PeriodWindow(cal, month(2026, 11), time.UTC)

	durationOnly := rca.Incident{Source: "tracker", ExternalID: "D-1", Key: "D-1", State: domain.StateDone,
		Minutes: fp(45), CreatedAt: date("2026-10-09"), Cutoff: farCutoff}
	d := rca.CountDowntime(oct, 44640, 45, []rca.Incident{durationOnly})
	if c := item(t, d, "D-1"); c.Minutes != 45 || c.TotalMinutes != 45 || !c.DurationOnly || c.Unknown {
		t.Fatalf("duration-only = %+v", c)
	}
	if got := rca.CountDowntime(nov, 43200, 0, []rca.Incident{durationOnly}); len(got.Items) != 0 {
		t.Fatalf("duration-only counted in Nov: %+v", got.Items)
	}

	// Month by the UTC date of the start, not the local created date.
	byStart := rca.Incident{Source: "oncall", ExternalID: "D-2", Key: "D-2", State: domain.StateDone,
		Minutes: fp(30), Start: tp("2026-11-01T01:00"), CreatedAt: date("2026-10-31"), Cutoff: farCutoff}
	if got := rca.CountDowntime(oct, 44640, 0, []rca.Incident{byStart}); len(got.Items) != 0 {
		t.Fatalf("counted in Oct: %+v", got.Items)
	}
	if c := item(t, rca.CountDowntime(nov, 43200, 30, []rca.Incident{byStart}), "D-2"); c.Minutes != 30 || !c.DurationOnly {
		t.Fatalf("by start in Nov = %+v", c)
	}

	// Partial impact weights a duration-only incident too.
	half := durationOnly
	half.Impact = 0.4
	if c := rca.CountDowntime(oct, 44640, 18, []rca.Incident{half}).Items[0]; !near(c.Minutes, 18) {
		t.Fatalf("40%% of 45m = %v", c.Minutes)
	}

	unknown := rca.Incident{Source: "tracker", ExternalID: "U-1", Key: "U-1", State: domain.StateDone,
		CreatedAt: date("2026-10-12"), Cutoff: farCutoff}
	d = rca.CountDowntime(oct, 44640, 30, []rca.Incident{unknown})
	if c := item(t, d, "U-1"); c.Minutes != 0 || !c.Unknown || c.DurationOnly {
		t.Fatalf("unknown = %+v", c)
	}
	if d.Explained != 0 || d.Unexplained != 30 {
		t.Fatalf("unknown totals = %+v", d)
	}

	doneNoEnd := rca.Incident{Source: "tracker", ExternalID: "N-1", Key: "N-1", State: domain.StateDone,
		Start: tp("2026-10-04T20:00"), CompletedAt: dp("2026-10-04"), CreatedAt: date("2026-10-04"), Cutoff: farCutoff}
	if c := item(t, rca.CountDowntime(oct, 44640, 240, []rca.Incident{doneNoEnd}), "N-1"); c.Minutes != 240 || c.Ongoing {
		t.Fatalf("done without an end = %+v (want counted to Oct 5 00:00)", c)
	}
	// A start, no end, done, but minutes: the minutes, placed by the start.
	withMinutes := doneNoEnd
	withMinutes.Minutes = fp(15)
	if c := rca.CountDowntime(oct, 44640, 15, []rca.Incident{withMinutes}).Items[0]; c.Minutes != 15 || !c.DurationOnly {
		t.Fatalf("done with minutes = %+v", c)
	}
}

func TestCancelledAndOutside(t *testing.T) {
	oct := rca.PeriodWindow(cal, month(2026, 10), time.UTC)
	cancelled := inc("INC-2058", "2026-10-28T03:00", "2026-10-28T03:30", 1)
	cancelled.State = domain.StateCancelled
	september := inc("INC-1187", "2026-09-09T13:12", "2026-09-09T15:42", 1)
	d := rca.CountDowntime(oct, 44640, 0, []rca.Incident{cancelled, september})
	if len(d.Items) != 0 || d.Explained != 0 {
		t.Fatalf("items = %+v", d.Items)
	}
	// An incident that ends exactly at the window start does not overlap it.
	edge := inc("E-1", "2026-09-30T23:00", "2026-10-01T00:00", 1)
	if got := rca.CountDowntime(oct, 44640, 0, []rca.Incident{edge}); len(got.Items) != 0 {
		t.Fatalf("edge = %+v", got.Items)
	}
	// A zero-length incident inside the window is listed with 0 counted.
	zero := inc("Z-1", "2026-10-10T10:00", "2026-10-10T10:00", 1)
	if got := rca.CountDowntime(oct, 44640, 0, []rca.Incident{zero}); len(got.Items) != 1 || got.Items[0].Minutes != 0 {
		t.Fatalf("zero-length = %+v", got.Items)
	}
	// An incident starting after its source's cutoff is not counted.
	late := inc("L-1", "2026-10-20T10:00", "2026-10-20T11:00", 1)
	late.Cutoff = ts("2026-10-15T00:00")
	if got := rca.CountDowntime(oct, 44640, 0, []rca.Incident{late}); len(got.Items) != 0 {
		t.Fatalf("after cutoff = %+v", got.Items)
	}
}

func TestFromRecord(t *testing.T) {
	f := domain.RecordFields{
		SubjectKey: "Webhooks", GroupKey: "INC-2049", Title: "Regional DNS resolution failures", URL: "https://tracker.example/browse/INC-2049",
		Priority: "SEV2", State: domain.StateDone, CreatedAt: date("2026-10-17"), CompletedAt: dp("2026-10-18"),
		Attributes: map[string]any{"startedAt": "2026-10-17T11:20:00Z", "endedAt": "2026-10-17T11:50:00Z", "impactPct": float64(50), "minutesDown": float64(30)},
	}
	cut := rca.Cutoff(date("2026-11-01"))
	in, err := rca.FromRecord("incident-tracker", "INC-2049@Webhooks", f, cut)
	if err != nil {
		t.Fatal(err)
	}
	if in.Key != "INC-2049" || in.ExternalID != "INC-2049@Webhooks" || in.Source != "incident-tracker" || in.Severity != "SEV2" ||
		in.Title != f.Title || in.URL != f.URL || in.State != domain.StateDone || !in.Cutoff.Equal(cut) {
		t.Fatalf("incident = %+v", in)
	}
	if in.Start == nil || !in.Start.Equal(ts("2026-10-17T11:20")) || in.End == nil || !in.End.Equal(ts("2026-10-17T11:50")) {
		t.Fatalf("times = %v, %v", in.Start, in.End)
	}
	if in.Minutes == nil || *in.Minutes != 30 || in.Impact != 0.5 || in.CompletedAt.String() != "2026-10-18" {
		t.Fatalf("incident = %+v", in)
	}
	bare, err := rca.FromRecord("oncall", "88533", domain.RecordFields{State: domain.StateOpen, CreatedAt: date("2026-10-30")}, cut)
	if err != nil || bare.Key != "88533" || bare.Start != nil || bare.Minutes != nil || bare.Impact != 0 {
		t.Fatalf("bare = %+v, %v", bare, err)
	}
	if _, err := rca.FromRecord("x", "y", domain.RecordFields{Attributes: map[string]any{"startedAt": 5}}, cut); err == nil {
		t.Fatal("a wrong-typed startedAt did not fail")
	}
}
