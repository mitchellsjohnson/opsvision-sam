package httpapi

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

func getSummary(t *testing.T, e *testEnv, token, metric, p string) MetricSummary {
	t.Helper()
	var out MetricSummary
	e.expect(t, 200, token, "GET", summaryPath(metric, p), nil, &out)
	return out
}

func listMetricSummariesAs(t *testing.T, e *testEnv, token, query string) MetricSummaryList {
	t.Helper()
	var out MetricSummaryList
	e.expect(t, 200, token, "GET", demoSummaries+"?"+query, nil, &out)
	return out
}

func listCells(l MetricSummaryList) []demo.SummaryCell {
	out := []demo.SummaryCell{}
	for _, it := range l.Items {
		p, _ := period.Parse(it.Period)
		out = append(out, demo.SummaryCell{MetricKey: it.MetricKey, Period: p})
	}
	return out
}

// typeCountingStore counts record reads by record type: deriving measures
// reads the epic and defect types, loading incidents the incident type.
type typeCountingStore struct {
	store.Store
	mu    sync.Mutex
	reads map[string]int
}

func (c *typeCountingStore) ListRecords(ctx context.Context, tenantID, typeID string) ([]domain.Record, error) {
	c.mu.Lock()
	c.reads[typeID]++
	c.mu.Unlock()
	return c.Store.ListRecords(ctx, tenantID, typeID)
}

func TestGetMetricSummary(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]

	up := getSummary(t, e, admin, "uptime", "2026-M10")
	whole, _ := storedSummary(t, e, "uptime", oct2026)
	if up.State != SummaryStateWritten || up.Requirement != MetricSummaryRequirementRequired || up.Stale || len(up.StaleReasons) != 0 ||
		up.LinksTotal != 4 || len(up.Links) != 4 || up.Text == nil || *up.Text != whole.Text || up.AuthorName == nil || *up.AuthorName != "Avery Admin" ||
		up.Channel == nil || *up.Channel != MetricSummaryChannelWeb || up.Revision == nil || *up.Revision != 1 || !up.CanEdit {
		t.Errorf("uptime = %+v", up)
	}
	if up.RequirementReason == nil || *up.RequirementReason != "13 of 21 services below 100%" ||
		up.Standing != (MetricSummaryStanding{Display: "99.06%", Status: "R", Headline: "13 of 21 services below 100% · worst Webhooks 99.06%"}) {
		t.Errorf("uptime standing = %+v, reason %v", up.Standing, up.RequirementReason)
	}
	// Top company evidence: the worst service's incidents.
	if up.Evidence == nil || len(*up.Evidence) != 3 || (*up.Evidence)[0] != (RcaEvidenceKey{Key: "INC-2041",
		Title: "Webhook delivery queue saturated after config deploy", Url: "https://tracker.example/browse/INC-2041", PointsDisplay: "0.56 pts"}) {
		t.Errorf("uptime evidence = %+v", up.Evidence)
	}

	sp := getSummary(t, e, admin, "spend_vs_plan", "2026-M10")
	if sp.State != SummaryStateStale || !sp.Stale || !slices.Equal(sp.StaleReasons, []string{"The value changed from 102% to 104%."}) {
		t.Errorf("spend_vs_plan = %s %v %q", sp.State, sp.Stale, sp.StaleReasons)
	}

	dep := getSummary(t, e, admin, "deployment_uptime", "2026-M10")
	if dep.State != SummaryStateMissing || dep.Requirement != MetricSummaryRequirementRequired || dep.Text != nil ||
		dep.RequirementReason == nil || *dep.RequirementReason != "6 of 9 deployments below 100%" || len(dep.Links) != 0 {
		t.Errorf("deployment_uptime = %+v", dep)
	}

	st := getSummary(t, e, admin, "security_training", "2026-M10")
	if st.State != SummaryStateMissing || st.RequirementReason == nil || *st.RequirementReason != "Below 100% (91%)" ||
		st.Standing.Headline != "9 pts short of 100%" || st.Standing.Status != "G" {
		t.Errorf("security_training = %+v", st)
	}

	// A company ratio's headline names its records, as its children's do.
	if ep := getSummary(t, e, admin, "epics_on_time", "2026-M10"); ep.Standing.Headline != "21 pts short of 100% · 7 of 33 epics missed" {
		t.Errorf("epics_on_time headline = %q", ep.Standing.Headline)
	}

	// A quarterly metric is read at its quarter; its month is refused.
	q := getSummary(t, e, admin, "concepts_expected_value", "2026-Q3")
	if q.State != SummaryStateWritten || q.Period != "2026-Q3" {
		t.Errorf("concepts_expected_value 2026-Q3 = %+v", q)
	}
	e.expectError(t, 400, "invalid", admin, "GET", summaryPath("concepts_expected_value", "2026-M09"), nil)

	// Contributors read; scoped viewers who cannot read the company do not.
	if c := getSummary(t, e, e.tokens["contributor"], "uptime", "2026-M10"); c.CanEdit || c.State != SummaryStateWritten || len(c.Links) != 4 {
		t.Errorf("contributor = %+v", c)
	}
	e.expectError(t, 403, "forbidden", scopedViewer(t, e, "mobile"), "GET", summaryPath("uptime", "2026-M10"), nil)
	e.expectError(t, 404, "not_found", admin, "GET", summaryPath("no_such_metric", "2026-M10"), nil)
	e.expectError(t, 404, "not_found", admin, "GET", summaryPath("uptime", "2026-M10")+"?revision=1", nil)
}

func TestListMetricSummaries(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]

	missing := listMetricSummariesAs(t, e, admin, "period=2026-M10")
	if got := listCells(missing); !slices.Equal(got, demo.SummaryMissing) {
		t.Errorf("missing = %+v, want %+v", got, demo.SummaryMissing)
	}
	// Written counts the quarterly metric's Q3 summary, which October shows
	// but does not require.
	c := missing.Counts
	if c.Missing != len(demo.SummaryMissing) || c.Stale != len(demo.SummaryStale) || c.Written != len(demo.SummaryWritten)+1 ||
		c.Required != len(demo.SummaryMissing)+len(demo.SummaryStale)+len(demo.SummaryWritten) || c.Optional != 4 {
		t.Errorf("counts = %+v", c)
	}
	if missing.Period != "2026-M10" || missing.NextCursor != nil {
		t.Errorf("list = %s, cursor %v", missing.Period, missing.NextCursor)
	}
	// The counts are the gate's.
	gate := demoGate(t, e, oct2026)
	if n := len(gateCells(gate, summaryMissing)); n != c.Missing {
		t.Errorf("gate missing %d, list %d", n, c.Missing)
	}

	all := listMetricSummariesAs(t, e, admin, "period=2026-M10&state=all")
	if len(all.Items) != 16 {
		t.Fatalf("all = %d items, want every metric (16)", len(all.Items))
	}
	order := map[SummaryState]int{SummaryStateMissing: 0, SummaryStateStale: 1, SummaryStateWritten: 2, SummaryStateOptional: 3}
	for i := 1; i < len(all.Items); i++ {
		if order[all.Items[i-1].State] > order[all.Items[i].State] {
			t.Errorf("item %d (%s %s) after %s %s", i, all.Items[i].MetricKey, all.Items[i].State, all.Items[i-1].MetricKey, all.Items[i-1].State)
		}
	}
	if last := all.Items[len(all.Items)-1]; last.State != SummaryStateOptional || last.Requirement != MetricSummaryRequirementOptional {
		t.Errorf("last = %+v", last)
	}
	for _, it := range all.Items {
		if it.Text != nil && (utf8.RuneCountInString(*it.Text) > 64 || len(it.Links) > 3) {
			t.Errorf("%s is not an excerpt: %q, %d links", it.MetricKey, *it.Text, len(it.Links))
		}
		if it.CanEdit != true {
			t.Errorf("admin canEdit on %s = false", it.MetricKey)
		}
	}
	written := listMetricSummariesAs(t, e, admin, "period=2026-M10&state=written")
	if got := listCells(written); len(got) != len(demo.SummaryWritten)+1 {
		t.Errorf("written = %+v", got)
	}
	stale := listMetricSummariesAs(t, e, admin, "period=2026-M10&state=stale")
	if got := listCells(stale); !slices.Equal(got, demo.SummaryStale) || !slices.Equal(stale.Items[0].StaleReasons, []string{"The value changed from 102% to 104%."}) {
		t.Errorf("stale = %+v", stale.Items)
	}

	// full: whole texts and every link, 16 to a page.
	full := listMetricSummariesAs(t, e, admin, "period=2026-M10&state=all&full=true")
	if len(full.Items) != 16 || full.NextCursor != nil {
		t.Fatalf("full = %d items, cursor %v", len(full.Items), full.NextCursor)
	}
	whole, _ := storedSummary(t, e, "uptime", oct2026)
	for _, it := range full.Items {
		if it.MetricKey == "uptime" && (it.Text == nil || *it.Text != whole.Text || len(it.Links) != 4) {
			t.Errorf("full uptime = %+v", it)
		}
	}

	// A contributor reads every row, and edits none.
	contrib := listMetricSummariesAs(t, e, e.tokens["contributor"], "period=2026-M10&state=all")
	if len(contrib.Items) != 16 || contrib.Counts != all.Counts {
		t.Errorf("contributor: %d items, counts %+v", len(contrib.Items), contrib.Counts)
	}
	for _, it := range contrib.Items {
		if it.CanEdit {
			t.Errorf("contributor canEdit on %s", it.MetricKey)
		}
	}
	// A viewer scoped below the company reads no row, and no count reveals one.
	scoped := listMetricSummariesAs(t, e, scopedViewer(t, e, "mobile"), "period=2026-M10&state=all")
	if len(scoped.Items) != 0 || scoped.Counts.Missing != 0 || scoped.Counts.Required != 0 {
		t.Errorf("scoped viewer: %d items, counts %+v", len(scoped.Items), scoped.Counts)
	}

	e.expectError(t, 400, "invalid", admin, "GET", demoSummaries+"?period=2026-Q4", nil)
	e.expectError(t, 404, "not_found", admin, "GET", demoSummaries+"?period=2026-M09&revision=1", nil)
}

// TestListCountedCoarsePeriods: a coarse metric's slot in a month is its
// counted period, the latest one the month has closed, as on the Overview
// (spec §4.1). Only the month that closes the period requires it.
func TestListCountedCoarsePeriods(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	slot := func(month, metric string) MetricSummary {
		t.Helper()
		for _, it := range listMetricSummariesAs(t, e, admin, "period="+month+"&state=all").Items {
			if it.MetricKey == metric {
				return it
			}
		}
		t.Fatalf("%s has no %s slot", month, metric)
		return MetricSummary{}
	}

	// October closes no quarter or half: it shows Q3's written summary and
	// H1's slot, neither required this month.
	q := slot("2026-M10", "concepts_expected_value")
	if q.Period != "2026-Q3" || q.State != SummaryStateWritten || q.Requirement != MetricSummaryRequirementOptional || q.Text == nil {
		t.Errorf("Oct concepts_expected_value = %+v", q)
	}
	h := slot("2026-M10", "accessibility_compliance")
	if h.Period != "2026-H1" || h.State != SummaryStateOptional || h.Requirement != MetricSummaryRequirementOptional || h.Standing.Headline == "" {
		t.Errorf("Oct accessibility_compliance = %+v", h)
	}
	// September closes Q3, which it requires; H1 closed in June.
	if q := slot("2026-M09", "concepts_expected_value"); q.Period != "2026-Q3" || q.Requirement != MetricSummaryRequirementRequired || q.State != SummaryStateWritten {
		t.Errorf("Sep concepts_expected_value = %+v", q)
	}
	if h := slot("2026-M09", "accessibility_compliance"); h.Period != "2026-H1" || h.Requirement != MetricSummaryRequirementOptional {
		t.Errorf("Sep accessibility_compliance = %+v", h)
	}
	// June closes H1 and requires its summary.
	if h := slot("2026-M06", "accessibility_compliance"); h.Period != "2026-H1" || h.Requirement != MetricSummaryRequirementRequired || h.State != SummaryStateMissing {
		t.Errorf("Jun accessibility_compliance = %+v", h)
	}

	// The October gate is unchanged: the counted coarse slots never block.
	for _, it := range demoGate(t, e, oct2026) {
		if (it.MetricKey == "concepts_expected_value" || it.MetricKey == "accessibility_compliance") && it.Requirement.Required {
			t.Errorf("Oct gate requires %+v", it)
		}
	}

	// October's published revision freezes the counted Q3 summary, which the
	// Report and its downloads read.
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, nil)
	frozen := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1")
	if !slices.ContainsFunc(frozen.Items, func(it MetricSummary) bool {
		return it.MetricKey == "concepts_expected_value" && it.Period == "2026-Q3"
	}) {
		t.Errorf("Oct revision 1 froze %+v, want the Q3 summary", listCells(frozen))
	}
}

// TestCountedPeriodHelpers: the latest period a month has closed, and the
// months a period's report may still be outstanding in.
func TestCountedPeriodHelpers(t *testing.T) {
	cal := period.Calendar{FiscalYearStartMonth: time.January}
	m := func(i int) period.Period { return period.Period{Grain: period.Month, FY: 2026, Index: i} }
	q := func(fy, i int) period.Period { return period.Period{Grain: period.Quarter, FY: fy, Index: i} }
	h := func(fy, i int) period.Period { return period.Period{Grain: period.Half, FY: fy, Index: i} }
	for _, c := range []struct {
		month period.Period
		g     period.Grain
		want  period.Period
	}{
		{m(9), period.Quarter, q(2026, 3)},
		{m(10), period.Quarter, q(2026, 3)},
		{m(2), period.Quarter, q(2025, 4)},
		{m(6), period.Half, h(2026, 1)},
		{m(10), period.Half, h(2026, 1)},
		{m(5), period.Half, h(2025, 2)},
		{m(10), period.Year, period.Period{Grain: period.Year, FY: 2025}},
		{m(12), period.Year, period.Period{Grain: period.Year, FY: 2026}},
	} {
		if got := closedBy(cal, c.month, c.g); got != c.want {
			t.Errorf("closedBy(%s, %v) = %s, want %s", c.month, c.g, got, c.want)
		}
	}
	for month, want := range map[int]bool{9: true, 10: true, 11: false, 8: false} {
		if got := inGrace(cal, q(2026, 3), m(month)); got != want {
			t.Errorf("inGrace(Q3, M%02d) = %v, want %v", month, got, want)
		}
	}
	rows := []engine.Row{{MetricKey: "a", Cells: []engine.Cell{{}, {NAReason: "paused"}}}, {MetricKey: "b", Cells: []engine.Cell{{Display: "5"}, {}}}}
	if accounted(colRef{rows: rows, col: 0}, "a") || !accounted(colRef{rows: rows, col: 1}, "a") || !accounted(colRef{rows: rows, col: 0}, "b") {
		t.Error("accounted: want a reported or not-applicable cell of the metric")
	}
}

// TestSummaryStaleSubjects: a summary written when other services were short
// of 100%, and before an incident counted, says which, by name (spec §8.4).
func TestSummaryStaleSubjects(t *testing.T) {
	e := newDemoEnv(t)
	r, _ := storedSummary(t, e, "uptime", oct2026)
	var ev []string
	for _, k := range r.Basis.Evidence {
		if k != "subject:search" && k != "subject:webhooks" && k != "incident-tracker:INC-2052@Analytics Ingest" {
			ev = append(ev, k)
		}
	}
	r.Basis.Evidence = append([]string{"subject:checkout-api"}, ev...)
	if _, err := e.store.PutRCA(context.Background(), demo.TenantID, r, r.Revision); err != nil {
		t.Fatal(err)
	}
	s := getSummary(t, e, e.tokens["contributor"], "uptime", "2026-M10")
	want := []string{
		"2 more services are below 100%: Search, Webhooks.",
		"Checkout API is no longer below 100%.",
		"1 new incident since it was written: INC-2052.",
	}
	if s.State != SummaryStateStale || !slices.Equal(s.StaleReasons, want) {
		t.Errorf("stale reasons = %q, want %q", s.StaleReasons, want)
	}
}

// TestListMetricSummariesCountsOnly: the pill's request returns counts and
// no items, and derives nothing.
func TestListMetricSummariesCountsOnly(t *testing.T) {
	e := newDemoEnv(t)
	counting := &typeCountingStore{Store: e.store, reads: map[string]int{}}
	s := NewServer(Deps{Store: counting, Now: func() time.Time { return demoNow }})
	tenant, err := e.store.GetTenant(context.Background(), demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	m, err := e.store.GetMembership(context.Background(), demo.TenantID, "dev|admin")
	if err != nil {
		t.Fatal(err)
	}
	ctx := withMember(tenant, m)
	yes, state := true, ListMetricSummariesStateAll
	res, err := s.ListMetricSummaries(ctx, ListMetricSummariesRequestObject{Sc: demo.ScorecardID,
		Params: ListMetricSummariesParams{Period: "2026-M10", State: &state, CountsOnly: &yes}})
	if err != nil {
		t.Fatal(err)
	}
	l := MetricSummaryList(res.(ListMetricSummaries200JSONResponse))
	if len(l.Items) != 0 || l.Counts.Missing != 3 || l.Counts.Stale != 1 || l.Counts.Written != 8 {
		t.Errorf("countsOnly = %d items, counts %+v", len(l.Items), l.Counts)
	}
	for typ, n := range counting.reads {
		if typ != "incident" {
			t.Errorf("countsOnly read %d records of %s", n, typ)
		}
	}
	if !strings.Contains(strings.Join(mapKeys(counting.reads), ","), "incident") {
		t.Errorf("countsOnly should read incidents for full staleness, read %v", counting.reads)
	}
}

// withMember is a request context authenticated as member m of tenant.
func withMember(tenant domain.Tenant, m domain.Membership) context.Context {
	return auth.WithPrincipal(context.Background(), auth.Principal{UserID: m.UserID, Email: m.Email, Name: m.Name, Tenant: &tenant, Membership: &m})
}

func mapKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
