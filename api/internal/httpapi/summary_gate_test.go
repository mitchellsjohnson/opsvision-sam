package httpapi

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/rca"
	"opsvision/internal/store"
)

// Summary states, as in the API.
const (
	summaryMissing  = string(SummaryStateMissing)
	summaryWritten  = string(SummaryStateWritten)
	summaryStale    = string(SummaryStateStale)
	summaryOptional = string(SummaryStateOptional)
)

// GateItem is one metric of a month in the publish gate: the period of its
// summary slot (the month, or a coarse metric's counted period), whether
// that summary is required to publish the month, its state (stale judged as
// the gate's cheap check does) and the company standing.
type GateItem struct {
	MetricKey, MetricName string
	Period                period.Period
	Requirement           rca.Requirement
	State                 string
	Standing              MetricSummaryStanding
}

// summaryGate judges every metric of the methodology in force for month at
// company scope, as the publish gate does, through the explainer at its
// cheapest: it derives nothing and reads no records.
func (s *Server) summaryGate(ctx context.Context, tenant domain.Tenant, sc string, month period.Period) ([]GateItem, error) {
	if month.Grain != period.Month {
		return nil, badRequest("request validation failed", detail{Path: "period", Message: "must be a month"})
	}
	e, err := s.newExplainer(ctx, auth.Principal{Tenant: &tenant}, sc, []period.Period{month}, explainOpts{gate: true})
	if err != nil {
		return nil, err
	}
	its, err := e.items(month)
	if err != nil {
		return nil, err
	}
	out := make([]GateItem, 0, len(its))
	for _, it := range its {
		out = append(out, GateItem{MetricKey: it.m.Key, MetricName: it.m.Name, Period: it.per, Requirement: it.facts.req,
			Standing: it.facts.standing, State: string(it.state)})
	}
	return out, nil
}

// countingStore counts the reads of records and snapshots: what deriving
// measures and loading incidents cost, and what the gate must not do.
type countingStore struct {
	store.Store
	records, snapshots atomic.Int64
}

func (c *countingStore) ListRecords(ctx context.Context, tenantID, typeID string) ([]domain.Record, error) {
	c.records.Add(1)
	return c.Store.ListRecords(ctx, tenantID, typeID)
}

func (c *countingStore) ListSnapshots(ctx context.Context, tenantID, typeID string) ([]domain.Snapshot, error) {
	c.snapshots.Add(1)
	return c.Store.ListSnapshots(ctx, tenantID, typeID)
}

func gateByMetric(items []GateItem) map[string]GateItem {
	out := make(map[string]GateItem, len(items))
	for _, it := range items {
		out[it.MetricKey] = it
	}
	return out
}

func demoGate(t *testing.T, e *testEnv, month period.Period) []GateItem {
	t.Helper()
	tenant, err := e.store.GetTenant(context.Background(), demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	items, err := e.api.summaryGate(context.Background(), tenant, demo.ScorecardID, month)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func TestSummaryGate(t *testing.T) {
	e := newDemoEnv(t)
	clearSummaries(t, e)
	admin := e.tokens["admin"]

	// Fixtures until the demo seeds company summaries: two written through
	// the API (their basis is current) and one stored with a basis whose
	// display differs.
	e.expect(t, 200, admin, "PUT", summaryPath("uptime", "2026-M10"), summaryBody("Webhooks lost 7h to a queue saturation.", nil, 0), nil)
	e.expect(t, 200, admin, "PUT", summaryPath("epics_on_time", "2026-M10"), summaryBody("Two epics slipped.", nil, 0), nil)
	root := demoRootID(t, e)
	stale := domain.CellRCA{ScorecardID: demo.ScorecardID, MetricKey: "spend_vs_plan", SubjectID: root, Period: oct2026,
		Text: "Spend ran over on two concepts.", Links: []domain.RCALink{}, AuthorID: "dev|admin", AuthorName: "Avery Admin",
		Channel: domain.RCAChannelWeb, CreatedAt: demoNow, UpdatedAt: demoNow,
		Basis: domain.RCABasis{Display: "1%", Status: "G", Evidence: []string{}}}
	if _, err := e.store.PutRCA(context.Background(), demo.TenantID, stale, 0); err != nil {
		t.Fatal(err)
	}

	items := demoGate(t, e, oct2026)
	tenant, _ := e.store.GetTenant(context.Background(), demo.TenantID)
	in, err := e.api.loadInput(context.Background(), tenant, demo.ScorecardID, nil)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := engine.VersionFor(in.Versions, oct2026, in.Cal)
	if !ok {
		t.Fatal("no version in force for 2026-M10")
	}
	var metrics []string
	for _, m := range v.Content.Metrics {
		metrics = append(metrics, m.Key)
	}
	if len(items) == 0 || len(items) != len(metrics) {
		t.Fatalf("gate lists %d metrics, the version has %d", len(items), len(metrics))
	}
	for i, it := range items {
		if it.MetricKey != metrics[i] {
			t.Errorf("item %d is %s, want the version's order (%s)", i, it.MetricKey, metrics[i])
		}
		if it.MetricName == "" {
			t.Errorf("%s has no name", it.MetricKey)
		}
		switch it.State {
		case "missing":
			if !it.Requirement.Required {
				t.Errorf("%s is missing but not required", it.MetricKey)
			}
		case "optional":
			if it.Requirement.Required {
				t.Errorf("%s is optional but required (%s)", it.MetricKey, it.Requirement.Reason)
			}
		case "written", "stale":
		default:
			t.Errorf("%s state %q", it.MetricKey, it.State)
		}
		if it.Requirement.Required != (it.Requirement.Reason != "") {
			t.Errorf("%s requirement %+v", it.MetricKey, it.Requirement)
		}
	}
	by := gateByMetric(items)
	if u := by["uptime"]; u.State != "written" || !u.Requirement.Required || u.Standing.Display != "99.06%" || u.Standing.Status != "R" || u.Period != oct2026 {
		t.Errorf("uptime = %+v", u)
	}
	if ep := by["epics_on_time"]; ep.State != "written" {
		t.Errorf("epics_on_time = %+v", ep)
	}
	if sp := by["spend_vs_plan"]; sp.State != "stale" {
		t.Errorf("spend_vs_plan = %+v", sp)
	}
	if d := by["deployment_uptime"]; d.State != "missing" || d.Requirement.Reason != "6 of 9 deployments below 100%" ||
		d.Standing.Headline != "6 of 9 deployments below 100% · worst Notification Relay - Multi-Region Active 99.63%" {
		t.Errorf("deployment_uptime = %+v", d)
	}
	// Green, but over plan.
	if sp := by["spend_vs_plan"]; sp.Requirement.Reason != "Above 100% (104%)" || sp.Standing.Status != "G" {
		t.Errorf("spend_vs_plan = %+v", sp)
	}
	if wd := by["weighted_defect_score"]; wd.State != "missing" || wd.Requirement.Reason != "Red" ||
		wd.Standing.Headline != "26% worse than Sep · Green needs any improvement" {
		t.Errorf("weighted_defect_score = %+v", wd)
	}
	if u := by["uptime"]; u.Requirement.Reason != "13 of 21 services below 100%" || u.Standing.Headline != "13 of 21 services below 100% · worst Webhooks 99.06%" {
		t.Errorf("uptime = %+v", u)
	}
	if st := by["security_training"]; st.State != "missing" || st.Requirement.Reason != "Below 100% ("+st.Standing.Display+")" || st.Standing.Status != "G" {
		t.Errorf("security_training = %+v", st)
	}
	for _, key := range demo.NotReported {
		if it := by[key]; it.State != "optional" {
			t.Errorf("not reported %s = %+v", key, it)
		}
	}
	// A quarterly metric is judged at its quarter, and only the month that
	// closes the quarter needs its summary: October shows Q3, the quarter it
	// counts, and does not require it.
	if q := by["concepts_expected_value"]; q.Period != (period.Period{Grain: period.Quarter, FY: 2026, Index: 3}) || q.Requirement.Required {
		t.Errorf("quarterly in Oct = %+v", q)
	}
	sep := gateByMetric(demoGate(t, e, period.Period{Grain: period.Month, FY: 2026, Index: 9}))
	if q := sep["concepts_expected_value"]; q.Period != (period.Period{Grain: period.Quarter, FY: 2026, Index: 3}) ||
		q.Requirement != (rca.Requirement{Required: true, Reason: "Yellow"}) || q.State != "missing" {
		t.Errorf("quarterly in Sep = %+v", q)
	}

	// Deleting a summary makes it missing again.
	e.expect(t, 204, admin, "DELETE", summaryPath("uptime", "2026-M10")+"?expectedRevision=1", nil, nil)
	if u := gateByMetric(demoGate(t, e, oct2026))["uptime"]; u.State != "missing" {
		t.Errorf("uptime after delete = %+v", u)
	}
}

// TestSummaryGateIsCheap: the gate computes the month once from data points
// and reads no records or snapshots, so it never derives measures or loads
// incidents.
func TestSummaryGateIsCheap(t *testing.T) {
	e := newDemoEnv(t)
	counting := &countingStore{Store: e.store}
	s := NewServer(Deps{Store: counting, Now: func() time.Time { return demoNow }})
	tenant, err := e.store.GetTenant(context.Background(), demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	items, err := s.summaryGate(context.Background(), tenant, demo.ScorecardID, oct2026)
	took := time.Since(start)
	if err != nil || len(items) == 0 {
		t.Fatalf("gate: %d items, %v", len(items), err)
	}
	if n, m := counting.records.Load(), counting.snapshots.Load(); n != 0 || m != 0 {
		t.Errorf("the gate read records %d times and snapshots %d times", n, m)
	}
	if took > 2*time.Second {
		t.Errorf("the gate took %v, want under 2s", took)
	}
}

// TestFactsInferMoneyPlan: a money plan whose chart kind is left to the
// engine is judged as a money plan, not as a percent short of 100%: Green
// under plan is perfect, Green over plan needs a summary.
func TestFactsInferMoneyPlan(t *testing.T) {
	tree, err := orgtree.New([]domain.OrgUnit{{ID: "co", Name: "Company", LevelID: "company"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &summaryContext{
		in:     &engine.Input{Cal: period.Calendar{FiscalYearStartMonth: time.January}, Tree: tree},
		root:   "co",
		levels: []domain.Level{{ID: "company", Name: "Company"}}, depth: map[string]int{"company": 0},
		levelName: map[string]string{"company": "Company"}, kindName: map[string]string{},
		scale: domain.DefaultStatusScale(), links: incidentLinks{},
	}
	m := domain.Metric{Key: "spend", Name: "Spend vs plan", Formula: "actual_k / planned_k * 100", Format: domain.FormatPercent0,
		Frequency: domain.FrequencyMonthly, ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "company"}},
		Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
			{Status: "R", Op: ">", Value: 110}, {Status: "Y", Op: ">", Value: 105}, {Status: "Y", Op: "<", Value: 90}, {Status: "G"},
		}}}
	if m.ChartKind != "" || engine.ChartKind(m) != "money_plan" {
		t.Fatalf("the metric should be an inferred money plan, got %q", engine.ChartKind(m))
	}
	judge := func(display string, value float64) summaryFacts {
		rows := []engine.Row{{MetricKey: "spend", SubjectID: "co", SubjectName: "Company", SubjectKind: engine.SubjectUnit,
			Cells: []engine.Cell{{Display: display, Status: "G", Value: &value}}}}
		return c.facts(domain.MethodologyVersion{}, m, oct2026, rows, 0, false, true)
	}
	if f := judge("97%", 97); f.req.Required || f.standing.Headline != "" {
		t.Errorf("97%% of plan = %+v, %q; want optional", f.req, f.standing.Headline)
	}
	if f := judge("104%", 104); f.req != (rca.Requirement{Required: true, Reason: "Above 100% (104%)"}) || f.standing.Headline != "4% over plan" {
		t.Errorf("104%% of plan = %+v, %q; want required, over plan", f.req, f.standing.Headline)
	}
}
