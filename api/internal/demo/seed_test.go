package demo_test

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
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

	// Scorecard and two published versions.
	scs, _ := st.ListScorecards(ctx, id)
	if len(scs) != 1 || scs[0].ID != "service-fulfillment" || scs[0].Name != "Service Fulfillment" {
		t.Errorf("scorecards = %+v", scs)
	}
	vers, _ := st.ListVersions(ctx, id, demo.ScorecardID)
	if len(vers) != 2 {
		t.Fatalf("versions = %d, want 2", len(vers))
	}
	eff := map[string]string{}
	for _, v := range vers {
		if v.Status != domain.VersionPublished || v.PublishedAt == nil {
			t.Errorf("version %s status %q publishedAt %v, want published", v.ID, v.Status, v.PublishedAt)
		}
		eff[v.ID] = v.EffectiveFrom.String()
	}
	if eff["v2025"] != "2025-M01" || eff["v2026"] != "2026-M01" {
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
	for _, v := range vers {
		if errs := v.Content.Validate(tn.StatusScale); len(errs) != 0 {
			t.Errorf("version %s invalid: %v", v.ID, errs)
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
		for _, cell := range r.Cells {
			if cell.Status != "" {
				status[cell.Status] = true
			}
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
