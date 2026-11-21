package httpapi

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/records"
	"opsvision/internal/store"
)

const demoAttribution = "/scorecards/" + demo.ScorecardID + "/attribution"

func attributionPath(metric, subject, p string, extra ...string) string {
	q := url.Values{"metric": {metric}, "subject": {subject}, "period": {p}}
	for i := 0; i+1 < len(extra); i += 2 {
		q.Set(extra[i], extra[i+1])
	}
	return demoAttribution + "?" + q.Encode()
}

func getAttribution(t *testing.T, e *testEnv, token, metric, subject, p string, extra ...string) CellAttribution {
	t.Helper()
	var out CellAttribution
	e.expect(t, 200, token, "GET", attributionPath(metric, subject, p, extra...), nil, &out)
	return out
}

type incidentRow struct {
	key, points, counted string
}

func incidentRows(a CellAttribution) []incidentRow {
	out := make([]incidentRow, 0, len(a.Incidents))
	for _, in := range a.Incidents {
		out = append(out, incidentRow{in.Key, in.PointsDisplay, in.CountedDisplay})
	}
	return out
}

func incidentByKey(t *testing.T, a CellAttribution, key string) RcaIncident {
	t.Helper()
	for _, in := range a.Incidents {
		if in.Key == key {
			return in
		}
	}
	t.Fatalf("no incident %s in %+v", key, incidentRows(a))
	return RcaIncident{}
}

// scopedViewer adds a viewer scoped to one org unit to the demo tenant and
// returns its token.
func scopedViewer(t *testing.T, e *testEnv, unit string) string {
	t.Helper()
	m := domain.Membership{UserID: "dev|viewer-" + unit, Email: unit + "-viewer@demo.test", Name: "Scoped Viewer", Role: domain.RoleViewer,
		Scope: domain.Scope{OrgUnitIDs: []string{unit}, MetricKeys: []string{}}, CreatedAt: demoNow}
	if err := e.store.PutMembership(context.Background(), demo.TenantID, m); err != nil {
		t.Fatal(err)
	}
	tok, err := auth.IssueDevToken(testSecret, m.UserID, m.Email, m.Name, demo.Auth0OrgID, false)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// addIncidents stores n one-minute October incidents on one service in a
// snapshot of its own, from the demo's incident source, each titled by title.
func addIncidents(t *testing.T, e *testEnv, service, prefix string, n int, title func(i int) string) {
	t.Helper()
	asOf := domain.Date{Time: time.Date(2026, time.November, 1, 0, 0, 0, 0, time.UTC)}
	sn := domain.Snapshot{ID: "snap-" + prefix, RecordType: records.IncidentTypeID, Source: "incident-tracker", AsOf: asOf,
		FileName: prefix + ".csv", CreatedBy: "dev|admin", CreatedAt: demoNow, Counts: map[string]int{}}
	revs := make([]store.RecordRevisionWrite, 0, n)
	for i := range n {
		start := time.Date(2026, time.October, 1+i%28, 6+i/28, 0, 0, 0, time.UTC)
		day := domain.Date{Time: time.Date(2026, time.October, 1+i%28, 0, 0, 0, 0, time.UTC)}
		key := fmt.Sprintf("%s-%03d", prefix, i+1)
		f := domain.RecordFields{SubjectKey: service, Title: title(i), Category: "incident", Priority: "SEV3", Status: "Resolved",
			URL: "https://tracker.example/browse/" + key, State: domain.StateDone, CreatedAt: day, CompletedAt: &day,
			Attributes: map[string]any{
				records.AttrStartedAt: start.Format(time.RFC3339), records.AttrEndedAt: start.Add(time.Minute).Format(time.RFC3339),
				records.AttrImpactPct: 100.0,
			}}
		revs = append(revs, store.RecordRevisionWrite{Source: "incident-tracker", ExternalID: key, Type: records.IncidentTypeID,
			Rev: domain.RecordRevision{AsOf: asOf, SnapshotID: sn.ID, Fields: f}})
	}
	if err := e.store.ApplySnapshot(context.Background(), demo.TenantID, sn, revs); err != nil {
		t.Fatal(err)
	}
}

// TestAttributionWebhooks: three incidents, two overlapping, and 40 minutes
// no incident explains, in the cell's own units, under the company Uptime
// summary's excerpt.
func TestAttributionWebhooks(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "uptime", "webhooks", "2026-M10")
	if a.Attribution != CellAttributionAttributionAvailable || a.Display != "99.06%" || a.Status != "R" || a.SubjectName != "Webhooks" {
		t.Fatalf("cell = %s %s %s %s", a.Attribution, a.Display, a.Status, a.SubjectName)
	}
	g := a.Gap
	if g.Kind != RcaGapKindDowntime || g.Headline != "0.94 pts short of 100% · 7h 00m down" || g.Detail != "Red · Green at 99.90% or better" {
		t.Errorf("gap = %q %q %q", g.Kind, g.Headline, g.Detail)
	}
	if g.Units == nil || *g.Units != 94 || g.Decimals == nil || *g.Decimals != 2 || g.Ideal == nil || *g.Ideal != 100 {
		t.Errorf("gap units = %v, decimals %v, ideal %v", g.Units, g.Decimals, g.Ideal)
	}
	if g.ReportedMinutes == nil || *g.ReportedMinutes != 420 || g.PeriodMinutes == nil || *g.PeriodMinutes != 44640 ||
		g.ReportedFrom == nil || *g.ReportedFrom != RcaGapReportedFromMeasure {
		t.Errorf("gap minutes = reported %v, period %v, from %v", g.ReportedMinutes, g.PeriodMinutes, g.ReportedFrom)
	}
	want := []incidentRow{{"INC-2041", "0.56 pts", "4h 10m"}, {"INC-2047", "0.25 pts", "1h 53m"}, {"INC-2049", "0.04 pts", "17m"}}
	if got := incidentRows(a); !slices.Equal(got, want) {
		t.Errorf("incidents = %+v, want %+v", got, want)
	}
	if a.IncidentsTotal != 3 || a.IncidentsCursor != nil {
		t.Errorf("incidents total %d, cursor %v", a.IncidentsTotal, a.IncidentsCursor)
	}
	if n := incidentByKey(t, a, "INC-2047"); !slices.Contains(n.Notes, "Overlaps INC-2049 for 25m") || n.CountedMinutes != 112.5 ||
		n.Url != "https://tracker.example/browse/INC-2047" || n.Severity != "SEV3" || n.State != RcaIncidentStateDone ||
		!slices.Equal(n.SubjectIds, []string{"webhooks"}) {
		t.Errorf("INC-2047 = %+v", n)
	}
	if n := incidentByKey(t, a, "INC-2049"); n.ExternalId != "INC-2049@Webhooks" || !slices.Contains(n.Notes, "Overlaps INC-2047 for 25m") {
		t.Errorf("INC-2049 = %+v", n)
	}
	if a.Unexplained == nil || a.Unexplained.Display != "0.09 pts · 40m of the 7h 00m reported" || a.Unexplained.Minutes != 40 ||
		a.Unexplained.WithinTolerance || a.Excess != nil {
		t.Errorf("unexplained = %+v, excess %+v", a.Unexplained, a.Excess)
	}
	if len(a.Children) != 0 || a.ChildrenTotal != 0 || len(a.Records) != 0 || a.RecordsTotal != 0 {
		t.Errorf("children %d/%d, records %d/%d", len(a.Children), a.ChildrenTotal, len(a.Records), a.RecordsTotal)
	}

	// The company's Uptime summary, as an excerpt with its first 3 links.
	s := a.Summary
	if s == nil {
		t.Fatal("no summary on the card")
	}
	whole, _ := storedSummary(t, e, "uptime", oct2026)
	if s.MetricKey != "uptime" || s.Period != "2026-M10" || s.State != SummaryStateWritten || s.Requirement != MetricSummaryRequirementRequired ||
		s.LinksTotal != 4 || len(s.Links) != 3 || s.Links[0].Url != whole.Links[0].URL || !s.CanEdit {
		t.Errorf("summary = %+v", s)
	}
	if s.Text == nil || !strings.HasSuffix(*s.Text, "…") || utf8.RuneCountInString(*s.Text) > 64 ||
		!strings.HasPrefix(whole.Text, strings.TrimSuffix(*s.Text, "…")) {
		t.Errorf("summary text = %v, want an excerpt of %q", s.Text, whole.Text)
	}
}

// TestAttributionSearchTie: the incident and the remainder tie at 6.72
// hundredths; the incident, first in evidence order, gets the spare one.
func TestAttributionSearchTie(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "uptime", "search", "2026-M10")
	if a.Gap.Headline != "0.13 pts short of 100% · 1h 00m down" || a.Status != "Y" {
		t.Errorf("gap = %q (%s)", a.Gap.Headline, a.Status)
	}
	// The planned failover is maintenance, filtered out by the link.
	if got := incidentRows(a); !slices.Equal(got, []incidentRow{{"INC-2049", "0.07 pts", "30m"}}) {
		t.Errorf("incidents = %+v", got)
	}
	if a.Unexplained == nil || a.Unexplained.Display != "0.06 pts · 30m of the 1h 00m reported" {
		t.Errorf("unexplained = %+v", a.Unexplained)
	}
}

// TestAttributionExcess: incidents add up to more than the reported downtime;
// the value stands, no remainder, and the excess is stated.
func TestAttributionExcess(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "uptime", "analytics-ingest", "2026-M10")
	if a.Gap.Headline != "0.17 pts short of 100% · 1h 15m down" {
		t.Errorf("headline = %q", a.Gap.Headline)
	}
	if got := incidentRows(a); !slices.Equal(got, []incidentRow{{"INC-2052", "0.20 pts", "1h 30m"}}) {
		t.Errorf("incidents = %+v", got)
	}
	if a.Unexplained != nil || a.Excess == nil || a.Excess.Display != "0.20 pts · 15m more than the 1h 15m reported" || a.Excess.Minutes != 15 {
		t.Errorf("unexplained %+v, excess %+v", a.Unexplained, a.Excess)
	}
}

// TestAttributionAcrossMonthBoundary: the deployment's incident from late
// September counts only its October minutes and says so.
func TestAttributionAcrossMonthBoundary(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "deployment_uptime", "dep-notify-multi", "2026-M10")
	if a.Attribution != CellAttributionAttributionAvailable || a.Gap.Headline != "0.37 pts short of 100% · 2h 45m down" {
		t.Fatalf("attribution = %s %q", a.Attribution, a.Gap.Headline)
	}
	if got, want := incidentRows(a), []incidentRow{{"INC-2044", "0.16 pts", "1h 12m"}, {"INC-2036", "0.16 pts", "1h 10m"}}; !slices.Equal(got, want) {
		t.Errorf("incidents = %+v, want %+v", got, want)
	}
	if n := incidentByKey(t, a, "INC-2036").Notes; !slices.Equal(n, []string{"Started Sep 30, 23:10 · 1h 10m of 2h 00m fell in Oct"}) {
		t.Errorf("INC-2036 notes = %q", n)
	}
	if n := incidentByKey(t, a, "INC-2044").Notes; !slices.Equal(n, []string{"40% impact · counts 1h 12m of 3h 00m"}) {
		t.Errorf("INC-2044 notes = %q", n)
	}
	if a.Unexplained == nil || a.Unexplained.Display != "0.05 pts · 23m of the 2h 45m reported" {
		t.Errorf("unexplained = %+v", a.Unexplained)
	}
	assertPartsAddUp(t, a)
}

// assertPartsAddUp checks that the shown points of the incidents and the
// remainder add up to the displayed gap, and their minutes to the reported
// downtime (or, with an excess, to what the incidents count).
func assertPartsAddUp(t *testing.T, a CellAttribution) {
	t.Helper()
	g := a.Gap
	if g.Units == nil || g.Decimals == nil || g.ReportedMinutes == nil {
		t.Fatalf("gap without units or minutes: %+v", g)
	}
	scale := 1.0
	for range *g.Decimals {
		scale *= 10
	}
	var units, mins int
	read := func(display string) {
		pts, dur, _ := strings.Cut(display, " · ")
		var p float64
		fmt.Sscanf(pts, "%f pts", &p)
		units += int(p*scale + 0.5)
		mins += minutesOf(t, dur)
	}
	for _, in := range a.Incidents {
		read(in.PointsDisplay + " · " + in.CountedDisplay)
	}
	if a.Excess != nil {
		return
	}
	if a.Unexplained != nil {
		pts, rest, _ := strings.Cut(a.Unexplained.Display, " · ")
		dur, _, _ := strings.Cut(rest, " of the ")
		read(pts + " · " + dur)
	}
	if units != *g.Units || mins != int(*g.ReportedMinutes+0.5) {
		t.Errorf("parts add up to %d units and %d minutes, want %d and %v", units, mins, *g.Units, *g.ReportedMinutes)
	}
}

// minutesOf reads a duration as the API writes it: 45m, 3h 36m, 1d 2h 05m.
func minutesOf(t *testing.T, s string) int {
	t.Helper()
	total := 0
	for _, f := range strings.Fields(s) {
		var n int
		var unit string
		if _, err := fmt.Sscanf(f, "%d%s", &n, &unit); err != nil {
			t.Fatalf("duration %q: %v", s, err)
		}
		switch unit {
		case "d":
			total += n * 1440
		case "h":
			total += n * 60
		case "m":
			total += n
		}
	}
	return total
}

// TestAttributionRecords: a product's epics on time lists the epics it
// missed, with the unit cost stated once in the detail and no points on the
// rows.
func TestAttributionRecords(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "epics_on_time", "checkout", "2026-M10")
	if a.Attribution != CellAttributionAttributionAvailable || a.Gap.Kind != RcaGapKindRatio {
		t.Fatalf("attribution = %s, gap %+v", a.Attribution, a.Gap)
	}
	// 57% is 4 of 7 epics on time: 3 missed, each costing 100/7 points.
	if a.Display != "57%" || a.Status != "R" || a.RecordsSummary == nil || *a.RecordsSummary != "3 of 7 epics missed" || a.RecordsTotal != 3 {
		t.Fatalf("cell %s %s, records summary %v of %d", a.Display, a.Status, a.RecordsSummary, a.RecordsTotal)
	}
	if a.Gap.Headline != "43 pts short of 100% · 3 of 7 epics missed" || a.Gap.Units == nil || *a.Gap.Units != 43 ||
		a.Gap.Detail != "Red · Green at 90% or better · Red below 80% · each miss costs 14.3 pts" {
		t.Errorf("gap = %q / %q", a.Gap.Headline, a.Gap.Detail)
	}
	type rec struct{ key, note string }
	var got []rec
	for _, r := range a.Records {
		got = append(got, rec{r.Contribution.ExternalId, r.Note})
	}
	// No priorities, so most days late first, then key.
	if want := []rec{{"CHK-113", "Slipped Oct 15 → Oct 24"}, {"CHK-116", "Late by 9 days"}, {"CHK-117", "Slipped Oct 21"}}; !slices.Equal(got, want) {
		t.Errorf("records = %+v, want %+v", got, want)
	}
	for _, r := range a.Records {
		if r.ImpactDisplay != nil {
			t.Errorf("%s has impact %q; ratio rows carry no points", r.Contribution.ExternalId, *r.ImpactDisplay)
		}
		if r.Contribution.Reason != records.ReasonMissed && r.Contribution.Reason != records.ReasonSlipped {
			t.Errorf("%s reason %q", r.Contribution.ExternalId, r.Contribution.Reason)
		}
		if r.Contribution.SubjectId == nil || *r.Contribution.SubjectId != "checkout" || r.Note == "" {
			t.Errorf("%s = %+v", r.Contribution.ExternalId, r)
		}
	}
	if a.Incidents == nil || len(a.Incidents) != 0 || a.Typed != nil && *a.Typed {
		t.Errorf("incidents %v, typed %v", a.Incidents, a.Typed)
	}

	// The company roll-up: 26 of 33, its products as children by misses.
	co := getAttribution(t, e, e.tokens["admin"], "epics_on_time", "acme", "2026-M10")
	if co.Gap.Headline != "21 pts short of 100% · 7 of 33 epics missed" || co.RecordsTotal != 7 || co.ChildrenTotal != 4 {
		t.Errorf("company = %q, %d records, %d children", co.Gap.Headline, co.RecordsTotal, co.ChildrenTotal)
	}
	type child struct{ id, impact, line string }
	var kids []child
	for _, c := range co.Children {
		kids = append(kids, child{c.SubjectId, c.ImpactDisplay, c.AttributionLine})
	}
	if want := []child{{"checkout", "3 missed", "3 of 7 epics missed · CHK-113 + 2 more"}, {"billing", "2 missed", "2 of 4 epics missed · BIL-118 + 1 more"},
		{"android-app", "1 missed", "1 of 4 epics missed · AND-117"}}; !slices.Equal(kids, want) {
		t.Errorf("children = %+v, want %+v", kids, want)
	}
}

// TestAttributionCompanyUptime: the Uptime company cell has no value; its
// card counts the services below 100% and names the worst three with their
// own attribution lines.
func TestAttributionCompanyUptime(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["admin"], "uptime", "acme", "2026-M10")
	if a.Attribution != CellAttributionAttributionAvailable || a.Display != "99.06%" || a.Status != "R" {
		t.Errorf("cell = %s %s %s", a.Attribution, a.Display, a.Status)
	}
	if a.Gap.Headline != "13 of 21 services below 100% · worst Webhooks 99.06%" || a.Gap.Kind != RcaGapKindDowntime ||
		a.Gap.Detail != "Red · Green at 99.90% or better" {
		t.Errorf("gap = %+v", a.Gap)
	}
	type child struct{ id, display, impact, line string }
	var got []child
	for _, c := range a.Children {
		got = append(got, child{c.SubjectId, c.Display, c.ImpactDisplay, c.AttributionLine})
	}
	want := []child{
		{"webhooks", "99.06%", "0.94 pts", "INC-2041 + 2 more · 0.09 pts not explained"},
		{"analytics-ingest", "99.83%", "0.17 pts", "INC-2052 · 15m more than reported"},
		{"search", "99.87%", "0.13 pts", "INC-2049 · 0.06 pts not explained"},
	}
	if !slices.Equal(got, want) || a.ChildrenTotal != 13 {
		t.Errorf("children = %+v (of %d), want %+v (of 13)", got, a.ChildrenTotal, want)
	}
	// Incidents at a roll-up are listed once, with no roll-up points.
	in := incidentByKey(t, a, "INC-2049")
	if !slices.Equal(in.SubjectIds, []string{"search", "webhooks"}) || in.PointsDisplay != "" || !slices.Contains(in.Notes, "2 services") || in.CountedMinutes != 47.5 {
		t.Errorf("INC-2049 at the company = %+v", in)
	}
	if a.Unexplained != nil || a.Excess != nil {
		t.Errorf("a roll-up has no remainder: %+v %+v", a.Unexplained, a.Excess)
	}
	if a.Summary == nil || a.Summary.State != SummaryStateWritten {
		t.Errorf("summary = %+v", a.Summary)
	}
}

// TestAttributionPaging: a service with 37 incidents shows 5, then the rest
// in pages of 50; the arithmetic covers all 37 on every page.
func TestAttributionPaging(t *testing.T) {
	e := newDemoEnv(t)
	addIncidents(t, e, "Billing Worker", "BUS", 37, func(i int) string { return fmt.Sprintf("Event bus partition stall %d", i+1) })
	admin := e.tokens["admin"]
	first := getAttribution(t, e, admin, "uptime", "billing-worker", "2026-M10")
	if first.Attribution != CellAttributionAttributionAvailable {
		t.Fatalf("billing-worker should be below 100%% in Oct: %s %s", first.Display, first.Attribution)
	}
	if len(first.Incidents) != 5 || first.IncidentsTotal != 37 || first.IncidentsCursor == nil || *first.IncidentsCursor != "5" {
		t.Fatalf("first page: %d incidents of %d, cursor %v", len(first.Incidents), first.IncidentsTotal, first.IncidentsCursor)
	}
	next := getAttribution(t, e, admin, "uptime", "billing-worker", "2026-M10", "incidentsCursor", "5")
	if len(next.Incidents) != 32 || next.IncidentsTotal != 37 || next.IncidentsCursor != nil || next.Summary != nil || len(next.Children) != 0 {
		t.Fatalf("second page: %d incidents of %d, cursor %v", len(next.Incidents), next.IncidentsTotal, next.IncidentsCursor)
	}
	keys := map[string]bool{}
	var counted float32
	for _, in := range slices.Concat(first.Incidents, next.Incidents) {
		keys[in.Key] = true
		counted += in.CountedMinutes
	}
	if len(keys) != 37 || counted != 37 {
		t.Errorf("pages list %d incidents counting %vm, want 37 and 37m", len(keys), counted)
	}
	reported := *first.Gap.ReportedMinutes
	switch {
	case reported >= 37:
		if first.Unexplained == nil || first.Unexplained.Minutes != reported-37 || next.Unexplained == nil || next.Unexplained.Minutes != reported-37 {
			t.Errorf("unexplained = %+v / %+v, want %vm on both pages", first.Unexplained, next.Unexplained, reported-37)
		}
	default:
		if first.Excess == nil || first.Excess.Minutes != 37-reported {
			t.Errorf("excess = %+v, want %vm", first.Excess, 37-reported)
		}
	}
	if first.Gap.Headline != next.Gap.Headline {
		t.Errorf("headlines differ between pages: %q, %q", first.Gap.Headline, next.Gap.Headline)
	}
	e.expectError(t, 400, "invalid", admin, "GET", attributionPath("uptime", "billing-worker", "2026-M10", "incidentsCursor", "x"), nil)
	past := getAttribution(t, e, admin, "uptime", "billing-worker", "2026-M10", "incidentsCursor", "9223372036854775807")
	if len(past.Incidents) != 0 || past.IncidentsCursor != nil || past.IncidentsTotal != 37 {
		t.Errorf("a cursor past the end = %d incidents, cursor %v", len(past.Incidents), past.IncidentsCursor)
	}
}

// TestAttributionScopedViewer: a viewer scoped to Mobile reads Mobile's
// cells, sees no company summary, and only Mobile's services as children.
func TestAttributionScopedViewer(t *testing.T) {
	e := newDemoEnv(t)
	mobile := scopedViewer(t, e, "mobile")
	a := getAttribution(t, e, mobile, "uptime", "mobile", "2026-M10")
	if a.Summary != nil {
		t.Errorf("a Mobile viewer got the company summary: %+v", a.Summary)
	}
	tenant, _ := e.store.GetTenant(context.Background(), demo.TenantID)
	in, err := e.api.loadInput(context.Background(), tenant, demo.ScorecardID, nil)
	if err != nil {
		t.Fatal(err)
	}
	mobileItems := map[string]bool{}
	for _, it := range in.Items {
		if it.OrgUnitID == "mobile" {
			mobileItems[it.ID] = true
		}
	}
	if len(a.Children) == 0 {
		t.Fatalf("no children: %+v", a)
	}
	for _, c := range a.Children {
		if !mobileItems[c.SubjectId] {
			t.Errorf("child %s is not a Mobile service", c.SubjectId)
		}
	}
	for _, inc := range a.Incidents {
		for _, id := range inc.SubjectIds {
			if !mobileItems[id] {
				t.Errorf("incident %s names %s", inc.Key, id)
			}
		}
	}
	// Mobile's two services reporting in October; Push Gateway stopped in September.
	if a.Gap.Headline != "1 of 2 services below 100% · worst Mobile Backend 99.96%" || len(a.Children) != 1 || a.Children[0].SubjectId != "mobile-backend" {
		t.Errorf("headline = %q, children %+v", a.Gap.Headline, a.Children)
	}
	e.expectError(t, 403, "forbidden", mobile, "GET", attributionPath("uptime", "acme", "2026-M10"), nil)
	e.expectError(t, 403, "forbidden", mobile, "GET", attributionPath("uptime", "webhooks", "2026-M10"), nil)
}

// TestAttributionFromTheValue: with no incident link the reported downtime
// comes from the displayed value, and the headline says so.
func TestAttributionFromTheValue(t *testing.T) {
	e := newDemoEnv(t)
	ctx := context.Background()
	types, err := e.store.ListRecordTypes(ctx, demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(types, func(rt domain.RecordType) bool { return rt.ID == records.IncidentTypeID })
	if i < 0 {
		t.Fatal("the demo has no incident type")
	}
	rt := types[i]
	rev := rt.Revision
	rt.Explains = nil
	if err := e.store.PutRecordType(ctx, demo.TenantID, rt, rev); err != nil {
		t.Fatal(err)
	}
	a := getAttribution(t, e, e.tokens["admin"], "uptime", "webhooks", "2026-M10")
	if a.Gap.Headline != "0.94 pts short of 100% · 7h 00m down (from the value)" || a.Gap.ReportedFrom == nil || *a.Gap.ReportedFrom != RcaGapReportedFromValue {
		t.Errorf("gap = %q from %v", a.Gap.Headline, a.Gap.ReportedFrom)
	}
	if len(a.Incidents) != 0 || a.Unexplained == nil || a.Unexplained.Display != "0.94 pts · 7h 00m of the 7h 00m reported" {
		t.Errorf("incidents %d, unexplained %+v", len(a.Incidents), a.Unexplained)
	}
}

// TestAttributionNothingToExplain: a service at 100.00% has no attribution.
func TestAttributionNothingToExplain(t *testing.T) {
	e := newDemoEnv(t)
	a := getAttribution(t, e, e.tokens["viewer"], "uptime", "checkout-api", "2026-M10")
	if a.Attribution != CellAttributionAttributionNone || a.Display != "100.00%" || a.Gap.Kind != RcaGapKindNone || a.Gap.Headline != "" {
		t.Errorf("attribution = %s %s %+v", a.Attribution, a.Display, a.Gap)
	}
	if a.Summary == nil || a.Summary.CanEdit {
		t.Errorf("viewer summary = %+v", a.Summary)
	}
}

func TestAttributionErrors(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	e.expectError(t, 404, "not_found", admin, "GET", attributionPath("no_such_metric", "webhooks", "2026-M10"), nil)
	e.expectError(t, 404, "not_found", admin, "GET", attributionPath("uptime", "no-such-subject", "2026-M10"), nil)
	e.expectError(t, 400, "invalid", admin, "GET", attributionPath("uptime", "webhooks", "2026-M13"), nil)
	e.expectError(t, 404, "not_found", admin, "GET", "/scorecards/nope/attribution?metric=uptime&subject=webhooks&period=2026-M10", nil)
}
