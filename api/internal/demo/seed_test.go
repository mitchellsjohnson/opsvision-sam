package demo_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

var cal = period.Calendar{FiscalYearStartMonth: 1}

func mustPeriod(t testing.TB, s string) period.Period {
	t.Helper()
	p, err := period.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func seeded(t testing.TB) (store.Store, string) {
	t.Helper()
	st := memstore.New()
	id, err := demo.Seed(context.Background(), st, cal)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	return st, id
}

// input loads what the engine needs, the way the API does.
func input(t testing.TB, st store.Store, tenantID string) *engine.Input {
	t.Helper()
	ctx := context.Background()
	units, err := st.ListOrgUnits(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	moves, err := st.ListOrgMoves(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	tree, err := orgtree.New(units, moves)
	if err != nil {
		t.Fatalf("org tree: %v", err)
	}
	items, err := st.ListTrackedItems(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := st.ListVersions(ctx, tenantID, demo.ScorecardID)
	if err != nil {
		t.Fatal(err)
	}
	data, overrides, err := st.ListData(ctx, tenantID, demo.ScorecardID, []int{2025, 2026})
	if err != nil {
		t.Fatal(err)
	}
	return &engine.Input{Cal: cal, Tree: tree, Items: items, Versions: versions, Data: data, Overrides: overrides}
}

func TestSeedReturnsTenantAndModel(t *testing.T) {
	st, id := seeded(t)
	if id != "acme-demo" {
		t.Fatalf("tenant ID = %q, want acme-demo", id)
	}
	ctx := context.Background()

	tn, err := st.GetTenant(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if tn.Name != "Acme Demo" || tn.Auth0OrgID != "org_acme_demo" || tn.FiscalYearStartMonth != 1 {
		t.Errorf("tenant = %+v", tn)
	}
	byOrg, err := st.TenantByAuth0Org(ctx, "org_acme_demo")
	if err != nil || byOrg.ID != id {
		t.Errorf("TenantByAuth0Org: %+v, %v", byOrg, err)
	}

	levels, _ := st.ListLevels(ctx, id)
	var lv []string
	for _, l := range levels {
		lv = append(lv, l.Name)
	}
	if want := []string{"Company", "Segment", "Product"}; !reflect.DeepEqual(lv, want) {
		t.Errorf("levels = %v, want %v", lv, want)
	}

	// Structure as of 2026-M06 and 2026-M07: Analytics moves Data -> Platform.
	in := input(t, st, id)
	nameOf := func(uid string) string {
		u, _ := in.Tree.Unit(uid)
		return u.Name
	}
	childrenOf := func(parent string, m string) []string {
		var out []string
		for _, c := range in.Tree.ChildrenAt(parent, mustPeriod(t, m)) {
			out = append(out, nameOf(c))
		}
		return out
	}
	segs := map[string][]string{}
	for _, root := range in.Tree.RootsAt(mustPeriod(t, "2026-M06")) {
		for _, s := range in.Tree.ChildrenAt(root, mustPeriod(t, "2026-M06")) {
			segs[nameOf(s)] = childrenOf(s, "2026-M06")
		}
	}
	if len(segs) != 4 {
		t.Fatalf("segments = %v, want Platform, Payments, Data, Mobile", segs)
	}
	for seg, want := range map[string][]string{
		"Platform": {"Identity", "Messaging"},
		"Payments": {"Billing", "Checkout"},
		"Data":     {"Analytics", "Pipelines"},
		"Mobile":   {"Android App", "iOS App"},
	} {
		if got := segs[seg]; !reflect.DeepEqual(got, want) {
			t.Errorf("2026-M06 %s children = %v, want %v", seg, got, want)
		}
	}
	var platform, data string
	for _, root := range in.Tree.RootsAt(mustPeriod(t, "2026-M07")) {
		for _, s := range in.Tree.ChildrenAt(root, mustPeriod(t, "2026-M07")) {
			switch nameOf(s) {
			case "Platform":
				platform = s
			case "Data":
				data = s
			}
		}
	}
	if got := childrenOf(platform, "2026-M07"); !reflect.DeepEqual(got, []string{"Analytics", "Identity", "Messaging"}) {
		t.Errorf("2026-M07 Platform children = %v", got)
	}
	if got := childrenOf(data, "2026-M07"); !reflect.DeepEqual(got, []string{"Pipelines"}) {
		t.Errorf("2026-M07 Data children = %v", got)
	}

	// Services item kind with three items attached to Platform.
	kinds, _ := st.ListItemKinds(ctx, id)
	if len(kinds) != 1 || kinds[0].Name != "Services" {
		t.Errorf("item kinds = %+v", kinds)
	}
	items, _ := st.ListTrackedItems(ctx, id)
	var names []string
	for _, it := range items {
		names = append(names, it.Name)
		if it.OrgUnitID != platform {
			t.Errorf("item %s attached to %q, want Platform (%s)", it.Name, it.OrgUnitID, platform)
		}
	}
	if want := []string{"Public API", "Status Page", "Web App"}; !reflect.DeepEqual(names, want) {
		t.Errorf("items = %v, want %v", names, want)
	}

	// Scorecard and three published versions: 2025, 2026, and 2026 v2, which
	// derives four measures from records.
	scs, _ := st.ListScorecards(ctx, id)
	if len(scs) != 1 || scs[0].ID != "service-fulfillment" || scs[0].Name != "Service Fulfillment" {
		t.Errorf("scorecards = %+v", scs)
	}
	vers, _ := st.ListVersions(ctx, id, demo.ScorecardID)
	if len(vers) != 3 {
		t.Fatalf("versions = %d, want 3", len(vers))
	}
	eff := map[string]string{}
	for _, v := range vers {
		if v.Status != domain.VersionPublished || v.PublishedAt == nil {
			t.Errorf("version %s status %q publishedAt %v, want published", v.ID, v.Status, v.PublishedAt)
		}
		eff[v.ID] = v.EffectiveFrom.String()
	}
	if eff["v2025"] != "2025-M01" || eff["v2026"] != "2026-M01" || eff["v2026-2"] != "2026-M07" {
		t.Errorf("effective-from = %v", eff)
	}
}

func TestSeedMethodologyIsValidAndComplete(t *testing.T) {
	st, id := seeded(t)
	tn, _ := st.GetTenant(context.Background(), id)
	vers, _ := st.ListVersions(context.Background(), id, demo.ScorecardID)
	want := []string{
		"Epics delivered on time", "Concepts delivered on budget", "Spend vs plan",
		"Concepts delivered expected value", "Weighted defect score", "Uptime",
		"Security training completion", "Customer feedback SLO", "Accessibility compliance",
		"Open-source risk SLO",
	}
	types, err := st.ListRecordTypes(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vers {
		if errs := v.Content.Validate(tn.StatusScale); len(errs) != 0 {
			t.Errorf("version %s invalid: %v", v.ID, errs)
		}
		if errs := domain.ValidateDerive(v.Content, types); len(errs) != 0 {
			t.Errorf("version %s derive rules invalid: %v", v.ID, errs)
		}
		var got []string
		for _, m := range v.Content.Metrics {
			got = append(got, m.Name)
			if m.Name == "Open-source risk SLO" {
				if m.Formula != "oss_within_slo / oss_due * 100" {
					t.Errorf("%s: SLO formula = %q", v.ID, m.Formula)
				}
				r := m.Rule
				if r.Type != domain.RuleBands || len(r.Bands) != 3 ||
					r.Bands[0] != (domain.Band{Status: "G", Op: ">=", Value: 90}) ||
					r.Bands[1] != (domain.Band{Status: "Y", Op: ">=", Value: 80}) ||
					r.Bands[2].Status != "R" || r.Bands[2].Op != "" {
					t.Errorf("%s: SLO rule = %+v", v.ID, r)
				}
				if len(m.ReportedAt) != 1 || m.ReportedAt[0] != (domain.Subject{Kind: domain.SubjectLevel, ID: "segment"}) {
					t.Errorf("%s: SLO reportedAt = %+v", v.ID, m.ReportedAt)
				}
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("version %s metrics = %v, want %v", v.ID, got, want)
		}
	}
}

// viewOf computes the view the tests judge: month 2026-M10, the quarter and
// half that metrics at those grains report in, and YTD through 2026-M10.
func viewOf(t testing.TB, in *engine.Input, restate string, periods ...string) engine.View {
	t.Helper()
	req := engine.ViewRequest{Restate: restate}
	for _, s := range periods {
		req.Periods = append(req.Periods, mustPeriod(t, s))
	}
	v, err := engine.Compute(in, req)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	return v
}

func TestSeedComputes(t *testing.T) {
	st, id := seeded(t)
	in := input(t, st, id)

	// 2026-M10 for monthly metrics; 2026-Q3 and 2026-H1 are the latest
	// complete quarter and half (quarterly and biannual metrics hold data at
	// their own grain).
	v, err := engine.Compute(in, engine.ViewRequest{
		Periods: []period.Period{mustPeriod(t, "2026-M10"), mustPeriod(t, "2026-Q3"), mustPeriod(t, "2026-H1")},
		YTD:     []period.Period{mustPeriod(t, "2026-M10")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Rows) == 0 {
		t.Fatal("view has no rows")
	}

	freq := map[string]domain.Frequency{}
	vers, _ := st.ListVersions(context.Background(), id, demo.ScorecardID)
	for _, ver := range vers {
		if ver.ID == "v2026" {
			for _, m := range ver.Content.Metrics {
				freq[m.Key] = m.Frequency
			}
		}
	}
	col := map[domain.Frequency]int{domain.FrequencyMonthly: 0, domain.FrequencyQuarterly: 1, domain.FrequencyBiannual: 2}

	status := map[string]bool{}
	for _, r := range v.Rows {
		c := r.Cells[col[freq[r.MetricKey]]]
		if c.Status == "" && c.NAReason == "" {
			t.Errorf("%s / %s (%s): blank cell for %s (value %v)", r.MetricName, r.SubjectName, freq[r.MetricKey], c.Period, c.Value)
		}
		// The mix must show in the 2026-M10 column itself.
		if s := r.Cells[0].Status; s != "" {
			status[s] = true
		}
		// YTD through M10 is judged for every row of every grain.
		if y := r.Cells[3]; y.Status == "" && y.NAReason == "" {
			t.Errorf("%s / %s: blank YTD cell", r.MetricName, r.SubjectName)
		}
	}
	for _, s := range []string{"G", "Y", "R"} {
		if !status[s] {
			t.Errorf("no %s status anywhere in the 2026-M10 view; got %v", s, status)
		}
	}
	// The explicit not-applicable data point carries its reason.
	na := demo.NotApplicable
	found := false
	for _, r := range v.Rows {
		if r.MetricKey == na.MetricKey && r.SubjectID == na.SubjectID {
			c := r.Cells[col[freq[r.MetricKey]]]
			found = c.NAReason == na.Reason && c.Status == "" && c.Value == nil
		}
	}
	if !found {
		t.Errorf("expected %s / %s to be not applicable with reason %q in %s", na.MetricKey, na.SubjectID, na.Reason, na.Period)
	}
}

func TestSeedZeroOverZeroMonthIsNotApplicable(t *testing.T) {
	st, id := seeded(t)
	in := input(t, st, id)
	z := demo.ZeroOverZero

	// The raw inputs really are 0 and 0.
	zeros := 0
	for _, dp := range in.Data {
		if dp.SubjectID == z.SubjectID && dp.Period == z.Period && z.Measures[dp.MeasureKey] {
			if dp.Value == nil || *dp.Value != 0 {
				t.Errorf("%s = %v, want 0", dp.MeasureKey, dp.Value)
			}
			zeros++
		}
	}
	if zeros != len(z.Measures) {
		t.Fatalf("found %d of %d zero inputs", zeros, len(z.Measures))
	}

	v, err := engine.Compute(in, engine.ViewRequest{Periods: []period.Period{z.Period}})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range v.Rows {
		if r.MetricKey == z.MetricKey && r.SubjectID == z.SubjectID {
			c := r.Cells[0]
			if c.Value != nil || c.Status != "" || c.NAReason == "" {
				t.Errorf("0/0 cell = value %v status %q reason %q, want not applicable", c.Value, c.Status, c.NAReason)
			}
			return
		}
	}
	t.Fatalf("no row for %s / %s", z.MetricKey, z.SubjectID)
}

func TestSeedRestatementChangesStatus(t *testing.T) {
	st, id := seeded(t)
	in := input(t, st, id)

	published := viewOf(t, in, "", "2025-M06")
	restated := viewOf(t, in, "v2026", "2025-M06")
	if len(published.Rows) != len(restated.Rows) {
		t.Fatalf("row counts differ: %d vs %d", len(published.Rows), len(restated.Rows))
	}
	for _, r := range published.Rows {
		if v := r.Cells[0].VersionID; v != "" && v != "v2025" {
			t.Fatalf("2025-M06 published under %q, want v2025", v)
		}
	}
	changed := 0
	for i, r := range published.Rows {
		rr := restated.Rows[i]
		if r.MetricKey != rr.MetricKey || r.SubjectID != rr.SubjectID {
			t.Fatalf("row %d identity differs", i)
		}
		if r.Cells[0].Status != rr.Cells[0].Status {
			changed++
		}
	}
	if changed == 0 {
		t.Error("restating 2025-M06 under v2026 changed no status; thresholds must differ visibly")
	}
}

func TestSeedIsDeterministic(t *testing.T) {
	a, ida := seeded(t)
	b, idb := seeded(t)
	da, _, _ := a.ListData(context.Background(), ida, demo.ScorecardID, []int{2025, 2026})
	db, _, _ := b.ListData(context.Background(), idb, demo.ScorecardID, []int{2025, 2026})
	if len(da) == 0 || len(da) != len(db) {
		t.Fatalf("data point counts: %d vs %d", len(da), len(db))
	}
	// Order and EnteredAt are the store's; compare the values.
	type k struct {
		m, s string
		p    period.Period
	}
	index := func(pts []domain.DataPoint) map[k]string {
		out := map[k]string{}
		for _, p := range pts {
			s := p.NAReason
			if p.Value != nil {
				s = strconv.FormatFloat(*p.Value, 'g', -1, 64)
			}
			out[k{p.MeasureKey, p.SubjectID, p.Period}] = s
		}
		return out
	}
	if !reflect.DeepEqual(index(da), index(db)) {
		t.Error("two seeds produced different data")
	}
}

func TestSeedTwiceIsSafe(t *testing.T) {
	st, id := seeded(t)
	ctx := context.Background()
	before, _, _ := st.ListData(ctx, id, demo.ScorecardID, []int{2025, 2026})

	id2, err := demo.Seed(ctx, st, cal)
	if err != nil {
		t.Fatalf("second Seed: %v", err)
	}
	if id2 != id {
		t.Errorf("second Seed returned %q, want %q", id2, id)
	}
	after, _, _ := st.ListData(ctx, id, demo.ScorecardID, []int{2025, 2026})
	if len(after) != len(before) {
		t.Errorf("data points %d -> %d after re-seed", len(before), len(after))
	}
	for _, p := range after {
		if p.Revision != 1 {
			t.Fatalf("%s/%s %s revision %d after re-seed, want 1", p.MeasureKey, p.SubjectID, p.Period, p.Revision)
		}
	}
}

func TestSeedDemoUsers(t *testing.T) {
	st, id := seeded(t)
	ctx := context.Background()
	want := []struct {
		userID, email, role string
		scoped              bool
	}{
		{"dev|admin", "admin@demo.test", "admin", false},
		{"dev|contributor", "contributor@demo.test", "contributor", true},
		{"dev|viewer", "viewer@demo.test", "viewer", false},
	}
	if len(demo.Users) != len(want) {
		t.Fatalf("demo.Users = %+v", demo.Users)
	}
	for i, w := range want {
		u := demo.Users[i]
		if u.UserID != w.userID || u.Email != w.email || string(u.Role) != w.role || u.Name == "" {
			t.Errorf("demo.Users[%d] = %+v", i, u)
		}
		m, err := st.GetMembership(ctx, id, w.userID)
		if err != nil {
			t.Fatalf("membership %s: %v", w.userID, err)
		}
		if m.Email != w.email || string(m.Role) != w.role {
			t.Errorf("membership %s = %+v", w.userID, m)
		}
		if w.scoped {
			if len(m.Scope.OrgUnitIDs) != 1 || m.Scope.OrgUnitIDs[0] != "payments" {
				t.Errorf("contributor scope = %+v, want Payments only", m.Scope)
			}
		} else if len(m.Scope.OrgUnitIDs) != 0 || len(m.Scope.MetricKeys) != 0 {
			t.Errorf("%s must be unscoped, got %+v", w.userID, m.Scope)
		}
	}
	if _, err := st.GetMembership(ctx, id, "nobody"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unexpected membership: %v", err)
	}
}

func TestSeedUsesFictionalNamesOnly(t *testing.T) {
	st, id := seeded(t)
	ctx := context.Background()
	tn, _ := st.GetTenant(ctx, id)
	if tn.Name != "Acme Demo" {
		t.Errorf("tenant name %q", tn.Name)
	}
	for _, u := range demo.Users {
		if !strings.HasSuffix(u.Email, "@demo.test") {
			t.Errorf("email %q must use the reserved demo.test domain", u.Email)
		}
	}
}

// --- records ---------------------------------------------------------------

var derivedMeasures = []string{"epics_committed", "epics_on_time", "defect_points_sum", "defect_days"}

func TestSeedRecordTypesAndSnapshots(t *testing.T) {
	st, id := seeded(t)
	ctx := context.Background()

	types, err := st.ListRecordTypes(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]domain.RecordType{}
	for _, rt := range types {
		byID[rt.ID] = rt
		if errs := rt.Validate(); len(errs) != 0 {
			t.Errorf("record type %s invalid: %v", rt.ID, errs)
		}
		if got := rt.TrackedFrom["tracker"]; got != mustPeriod(t, "2026-M07") {
			t.Errorf("%s tracked from %v, want 2026-M07", rt.ID, got)
		}
	}
	defect, ok := byID["defect"]
	if !ok || byID["epic"].ID == "" || len(byID) != 2 {
		t.Fatalf("record types = %+v, want defect and epic", byID)
	}
	if !reflect.DeepEqual(defect.Priorities, []string{"P1", "P2", "P3", "P4"}) {
		t.Errorf("defect priorities = %v", defect.Priorities)
	}
	if len(defect.Attributes) != 1 || defect.Attributes[0] != (domain.AttributeDef{Key: "customerTicket", Name: "Customer ticket", Type: domain.AttrBool}) {
		t.Errorf("defect attributes = %+v", defect.Attributes)
	}

	// One snapshot per month end, July through October, for each type, and
	// every product has records.
	wantDates := []string{"2026-10-31", "2026-09-30", "2026-08-31", "2026-07-31"}
	units, _ := st.ListOrgUnits(ctx, id)
	nameOf := map[string]string{}
	for _, u := range units {
		nameOf[u.ID] = u.Name
	}
	for _, typ := range []string{"epic", "defect"} {
		snaps, err := st.ListSnapshots(ctx, id, typ)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, s := range snaps {
			got = append(got, s.AsOf.String())
			if s.Source != "tracker" || s.RecordType != typ {
				t.Errorf("snapshot %+v", s)
			}
		}
		if !reflect.DeepEqual(got, wantDates) {
			t.Errorf("%s snapshot dates = %v, want %v", typ, got, wantDates)
		}
		recs, err := st.ListRecords(ctx, id, typ)
		if err != nil {
			t.Fatal(err)
		}
		products := map[string]bool{}
		for _, r := range recs {
			products[r.Revisions[0].Fields.SubjectKey] = true
			if r.Source != "tracker" || len(r.Revisions) == 0 {
				t.Errorf("record %+v", r)
			}
		}
		for _, p := range []string{"Identity", "Messaging", "Checkout", "Billing", "Analytics", "Pipelines", "iOS App", "Android App"} {
			if !products[p] {
				t.Errorf("no %s records for %s", typ, p)
			}
		}
	}
}

func TestSeedDerivedMonths(t *testing.T) {
	st, id := seeded(t)
	in := input(t, st, id)

	type slot struct {
		measure, subject string
		p                period.Period
	}
	pts := map[slot]domain.DataPoint{}
	for _, dp := range in.Data {
		pts[slot{dp.MeasureKey, dp.SubjectID, dp.Period}] = dp
	}
	products := []string{"identity", "messaging", "checkout", "billing", "analytics", "pipelines", "ios-app", "android-app"}
	for _, measure := range derivedMeasures {
		for idx := 1; idx <= 10; idx++ {
			p := month2026(idx)
			for _, sub := range products {
				dp, ok := pts[slot{measure, sub, p}]
				if !ok || dp.Value == nil {
					t.Errorf("%s / %s / %s: no value", measure, sub, p)
					continue
				}
				if idx >= 7 && dp.Source != domain.SourceRecords {
					t.Errorf("%s / %s / %s: source %q, want records", measure, sub, p, dp.Source)
				}
				if idx < 7 && dp.Source == domain.SourceRecords {
					t.Errorf("%s / %s / %s: earlier months stay entered, got records", measure, sub, p)
				}
			}
		}
	}
	// Nothing derived is written on parent units, and every point of these
	// measures from July on comes from records.
	isProduct := map[string]bool{}
	for _, s := range products {
		isProduct[s] = true
	}
	for _, dp := range in.Data {
		if !slices.Contains(derivedMeasures, dp.MeasureKey) || dp.Source != domain.SourceRecords {
			continue
		}
		if dp.Period.Index < 7 || dp.Period.FY != 2026 {
			t.Errorf("records point %s/%s outside 2026-M07..M10: %s", dp.MeasureKey, dp.SubjectID, dp.Period)
		}
		if !isProduct[dp.SubjectID] {
			switch dp.SubjectID {
			case "public-api", "web-app", "status-page": // tracked items with source keys
			default:
				t.Errorf("derived point on parent unit %s: %s/%s", dp.SubjectID, dp.MeasureKey, dp.Period)
			}
		}
	}
	for _, dp := range in.Data {
		if slices.Contains(derivedMeasures, dp.MeasureKey) && dp.Period.FY == 2026 && dp.Period.Grain == period.Month &&
			dp.Period.Index >= 7 && dp.Source != domain.SourceRecords {
			t.Errorf("entered value %s/%s/%s from 2026-M07", dp.MeasureKey, dp.SubjectID, dp.Period)
		}
	}

	// Days in the period are calendar days through the month end.
	for idx, days := range map[int]float64{7: 31, 8: 31, 9: 30, 10: 31} {
		if v := *pts[slot{"defect_days", "checkout", month2026(idx)}].Value; v != days {
			t.Errorf("defect_days 2026-M%02d = %v, want %v", idx, v, days)
		}
	}
	for _, sub := range products {
		for idx := 7; idx <= 10; idx++ {
			c, o := *pts[slot{"epics_committed", sub, month2026(idx)}].Value, *pts[slot{"epics_on_time", sub, month2026(idx)}].Value
			if c < 1 || o < 0 || o > c {
				t.Errorf("%s 2026-M%02d: %v on time of %v committed", sub, idx, o, c)
			}
		}
	}

	// The view under 2026 v2 shows derived metrics for each product in
	// M07..M10, and the version in force is v2.
	v := viewOf(t, in, "", "2026-M07", "2026-M10")
	seen := map[string]bool{}
	for _, r := range v.Rows {
		if r.MetricKey != "epics_on_time" && r.MetricKey != "weighted_defect_score" {
			continue
		}
		for _, c := range r.Cells {
			if c.VersionID != "v2026-2" {
				t.Errorf("%s / %s %s published under %q, want v2026-2", r.MetricName, r.SubjectName, c.Period, c.VersionID)
			}
		}
		if c := r.Cells[1]; c.Status == "" && c.NAReason == "" {
			t.Errorf("%s / %s: blank 2026-M10 cell", r.MetricName, r.SubjectName)
		}
		seen[r.MetricKey] = true
	}
	if len(seen) != 2 {
		t.Errorf("metrics in the view = %v", seen)
	}
}

func month2026(idx int) period.Period {
	return period.Period{Grain: period.Month, FY: 2026, Index: idx}
}

// --- November fixtures -----------------------------------------------------

// trackerTemplate maps a Jira-style export (Issue key, Summary, Issue Type,
// Priority, Status, Product, Created, Resolved, Due date, Linked tickets) to
// the demo's epic or defect record type.
func trackerTemplate(recordType string) records.Template {
	dates := []string{"2006-01-02"}
	t := records.Template{
		Name: "Tracker " + recordType + " export", RecordType: recordType, Source: "tracker",
		File: records.FileSpec{Format: "csv", HeaderRow: 1},
		Fields: map[string]records.FieldMap{
			"externalId":  {Column: "Issue key"},
			"title":       {Column: "Summary"},
			"subjectKey":  {Column: "Product"},
			"status":      {Column: "Status"},
			"state":       {Column: "Status", Map: map[string]string{"Done": "done", "Closed": "done", "Won't Do": "cancelled", "*": "open"}},
			"url":         {Template: "https://tracker.example.test/browse/{Issue key}"},
			"createdAt":   {Column: "Created", DateFormats: dates},
			"dueAt":       {Column: "Due date", DateFormats: dates},
			"completedAt": {Column: "Resolved", DateFormats: dates},
		},
	}
	if recordType == "defect" {
		delete(t.Fields, "dueAt")
		t.Fields["category"] = records.FieldMap{Column: "Issue Type", Map: map[string]string{"Bug": "bug", "Defect": "defect"}}
		t.Fields["priority"] = records.FieldMap{Column: "Priority", Map: map[string]string{"Highest": "P1", "High": "P2", "Medium": "P3", "Low": "P4"}}
		t.Attributes = map[string]records.FieldMap{"customerTicket": {Column: "Linked tickets", Transform: records.TransformNonEmpty}}
	}
	return t
}

func readFixture(t testing.TB, name string) records.Table {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tbl, err := records.ReadCSV(f)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return tbl
}

func previewNovember(t testing.TB, st store.Store, tenantID, recordType, file string) recordimport.Plan {
	t.Helper()
	tn, err := st.GetTenant(context.Background(), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	asOf, err := domain.ParseDate("2026-11-14")
	if err != nil {
		t.Fatal(err)
	}
	p, err := recordimport.Build(context.Background(), st, tn, demo.ScorecardID, trackerTemplate(recordType), readFixture(t, file), asOf, recordimport.Answers{}, nil)
	if err != nil {
		t.Fatalf("Build %s: %v", file, err)
	}
	if len(p.Problems) != 0 || p.Counts.Errors != 0 || p.Counts.Unmatched != 0 || len(p.Unmatched) != 0 || len(p.Parents) != 0 || len(p.NewValues) != 0 {
		t.Fatalf("%s: problems %+v unmatched %+v counts %+v new values %+v", file, p.Problems, p.Unmatched, p.Counts, p.NewValues)
	}
	if p.Snapshot.AsOf.String() != "2026-11-14" {
		t.Errorf("%s: as-of %s", file, p.Snapshot.AsOf)
	}
	return p
}

func storyLine(p recordimport.Plan, metric, subject, per string) (recordimport.StoryLine, bool) {
	for _, l := range p.Story.Lines {
		if l.MetricKey == metric && l.SubjectID == subject && l.Period.String() == per {
			return l, true
		}
	}
	return recordimport.StoryLine{}, false
}

func ids(cs []records.Contribution) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.ExternalID)
	}
	slices.Sort(out)
	return out
}

func TestNovemberFixturePreview(t *testing.T) {
	st, id := seeded(t)

	// Epics: three Checkout epics move their due date later, so they slip.
	ep := previewNovember(t, st, id, "epic", "acme_epics_nov.csv")
	if c := ep.Counts; c.New != 1 || c.Changed != 4 || c.Unchanged != 1 {
		t.Errorf("epic counts = %+v, want 1 new, 4 changed, 1 unchanged", c)
	}
	line, ok := storyLine(ep, "epics_on_time", "checkout", "2026-M11")
	if !ok {
		t.Fatalf("no 2026-M11 on-time story line for Checkout; lines %+v", ep.Story.Lines)
	}
	if got, want := ids(line.Reasons["slipped"]), []string{"CHK-241", "CHK-243", "CHK-247"}; !reflect.DeepEqual(got, want) {
		t.Errorf("slipped = %v, want %v", got, want)
	}
	if line.AfterStatus != "R" {
		t.Errorf("Checkout November on time = %q (%s), want red with every commitment slipped", line.AfterDisplay, line.AfterStatus)
	}
	if bl, ok := storyLine(ep, "epics_on_time", "billing", "2026-M11"); !ok || !slices.Contains(ids(bl.Reasons["met"]), "BIL-231") {
		t.Errorf("Billing line = %+v (%v), want BIL-231 met", bl, ok)
	}

	// Defects: derived through the as-of date, with one new P1.
	df := previewNovember(t, st, id, "defect", "acme_defects_nov.csv")
	if c := df.Counts; c.New != 3 || c.Changed != 2 || c.Unchanged != 1 {
		t.Errorf("defect counts = %+v, want 3 new, 2 changed, 1 unchanged", c)
	}
	nov := month2026(11)
	var days *float64
	for _, w := range df.Writes {
		if w.Point.MeasureKey == "defect_days" && w.Point.SubjectID == "checkout" && w.Point.Period == nov {
			days = w.Point.Value
		}
	}
	if days == nil || *days != 14 {
		t.Errorf("November defect days = %v, want 14 (through 2026-11-14)", days)
	}
	var p1 bool
	for _, r := range df.Revisions {
		if r.ExternalID == "PAY-912" {
			p1 = r.Rev.Fields.Priority == "P1" && r.Rev.Fields.State == domain.StateOpen
		}
	}
	if !p1 {
		t.Error("the new open P1 defect PAY-912 is not in the plan")
	}
	dl, ok := storyLine(df, "weighted_defect_score", "checkout", "2026-M11")
	if !ok || !slices.Equal(ids(dl.Reasons["newly_open"]), []string{"PAY-912"}) {
		t.Errorf("Checkout defect line = %+v (%v), want PAY-912 newly open", dl, ok)
	}

	// Previews store nothing.
	if recs, _ := st.ListRecords(context.Background(), id, "defect"); slices.ContainsFunc(recs, func(r domain.Record) bool { return r.ExternalID == "PAY-912" }) {
		t.Error("preview stored a record")
	}
}
