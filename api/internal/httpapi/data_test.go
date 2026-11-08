package httpapi

import (
	"context"
	"math"
	"net/url"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

// ---- wire types -----------------------------------------------------------

type pointJSON struct {
	MeasureKey string   `json:"measureKey"`
	SubjectID  string   `json:"subjectId"`
	Period     string   `json:"period"`
	Value      *float64 `json:"value"`
	NAReason   string   `json:"naReason"`
	Source     string   `json:"source"`
	EnteredBy  string   `json:"enteredBy"`
	Revision   int      `json:"revision"`
}

type savedJSON struct {
	Saved []pointJSON `json:"saved"`
}

type conflictsJSON struct {
	Conflicts []struct {
		Write struct {
			MeasureKey       string `json:"measureKey"`
			SubjectID        string `json:"subjectId"`
			ExpectedRevision int    `json:"expectedRevision"`
		} `json:"write"`
		Current *pointJSON `json:"current"`
	} `json:"conflicts"`
}

type entryRowJSON struct {
	MeasureKey  string   `json:"measureKey"`
	MeasureName string   `json:"measureName"`
	MetricKeys  []string `json:"metricKeys"`
	SubjectID   string   `json:"subjectId"`
	SubjectName string   `json:"subjectName"`
	Period      string   `json:"period"`
	Value       *float64 `json:"value"`
	NAReason    string   `json:"naReason"`
	Revision    int      `json:"revision"`
	CanEdit     bool     `json:"canEdit"`
	// Derived rows only.
	Derived      *bool    `json:"derived"`
	Source       *string  `json:"source"`
	RecordsValue *float64 `json:"recordsValue"`
}

type entryJSON struct {
	Period string         `json:"period"`
	Rows   []entryRowJSON `json:"rows"`
}

// ---- fixture ---------------------------------------------------------------

// deliveryMethodology measures delivery flow: a monthly percentage per
// product, a quarterly review count per product, and a monthly defect count
// per application.
func deliveryMethodology() domain.Methodology {
	sum := func(key, name string) domain.Measure {
		return domain.Measure{Key: key, Name: name, Unit: "count", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
	}
	return domain.Methodology{
		Categories: []domain.Category{{ID: "flow", Name: "Flow", Order: 1}},
		Measures: []domain.Measure{
			sum("on_time", "On time"), sum("committed", "Committed"), sum("reviews", "Reviews"), sum("defects", "Defects"),
		},
		Metrics: []domain.Metric{
			{
				Key: "on_time_pct", Name: "On-time delivery", CategoryID: "flow",
				Formula: "100 * on_time / committed", Format: domain.FormatPercent1,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 90}, {Status: "Y", Op: ">=", Value: 80}, {Status: "R"},
				}},
				Targets: []domain.Target{},
			},
			{
				Key: "reviews_score", Name: "Reviews held", CategoryID: "flow",
				Formula: "reviews", Format: domain.FormatNumber0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyQuarterly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}},
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: ">=", Value: 4}, {Status: "R"},
				}},
				Targets: []domain.Target{},
			},
			{
				Key: "app_defects", Name: "Open defects", CategoryID: "flow",
				Formula: "defects", Format: domain.FormatNumber0,
				Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectItemKind, ID: "app"}},
				Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
					{Status: "G", Op: "<=", Value: 5}, {Status: "R"},
				}},
				Targets: []domain.Target{},
			},
		},
	}
}

// seedDelivery builds tenant t1's org (acme > seg-a > prod-1, prod-2; seg-b),
// items (shop: unattached app; pay: app attached to prod-1) and the published
// "delivery" scorecard, effective from 2026-M01.
func seedDelivery(t *testing.T, e *testEnv) versionJSON {
	t.Helper()
	seedOrg(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 201, admin, "POST", "/org/units", unitJSON{
		ID: "prod-2", Name: "Product Two", LevelID: "product", ParentID: "seg-a", SourceKeys: []string{},
	}, nil)
	seedKinds(t, e)
	e.expect(t, 201, admin, "POST", "/items", map[string]any{"id": "shop", "kindId": "app", "name": "Shop", "orgUnitId": "", "sourceKeys": []string{}}, nil)
	e.expect(t, 201, admin, "POST", "/items", map[string]any{"id": "pay", "kindId": "app", "name": "Pay", "orgUnitId": "prod-1", "sourceKeys": []string{}}, nil)
	seedScorecard(t, e, "delivery")
	return publishedVersion(t, e, "delivery", "Delivery v1", "2026-M01", deliveryMethodology())
}

// setScope replaces the scope of tenant t1's member of the given role.
func setScope(t *testing.T, e *testEnv, role domain.Role, scope domain.Scope) {
	t.Helper()
	ctx := context.Background()
	userID := "u-t1-" + string(role)
	m, err := e.store.GetMembership(ctx, "t1", userID)
	if err != nil {
		t.Fatal(err)
	}
	if scope.OrgUnitIDs == nil {
		scope.OrgUnitIDs = []string{}
	}
	if scope.MetricKeys == nil {
		scope.MetricKeys = []string{}
	}
	m.Scope = scope
	if err := e.store.PutMembership(ctx, "t1", m); err != nil {
		t.Fatal(err)
	}
}

func wr(measure, subject, p string, value float64, rev int) map[string]any {
	return map[string]any{"measureKey": measure, "subjectId": subject, "period": p, "value": value, "expectedRevision": rev}
}

func batchBody(writes ...map[string]any) map[string]any {
	if writes == nil {
		writes = []map[string]any{}
	}
	return map[string]any{"writes": writes}
}

// saveSplit saves the 440/522 on-time split for October 2026 across the two
// products of seg-a.
func saveSplit(t *testing.T, e *testEnv) {
	t.Helper()
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 200, 0), wr("committed", "prod-1", "2026-M10", 240, 0),
		wr("on_time", "prod-2", "2026-M10", 240, 0), wr("committed", "prod-2", "2026-M10", 282, 0),
	), nil)
}

func pf(v float64) *float64 { return &v }

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// ---- tests -------------------------------------------------------------------

func TestBatchSaveAndView(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]

	var saved savedJSON
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 200, 0), wr("committed", "prod-1", "2026-M10", 240, 0),
		wr("on_time", "prod-2", "2026-M10", 240, 0), wr("committed", "prod-2", "2026-M10", 282, 0),
	), &saved)
	if len(saved.Saved) != 4 {
		t.Fatalf("saved = %+v", saved)
	}
	for _, p := range saved.Saved {
		if p.Revision != 1 || p.Source != "grid" || p.EnteredBy != "u-t1-admin" || p.Value == nil {
			t.Errorf("saved point = %+v", p)
		}
	}

	var v viewJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	seg := v.cell(t, "on_time_pct", "seg-a", 0)
	if seg.Display != "84.3%" || seg.Status != "Y" {
		t.Fatalf("segment cell = %+v, want 84.3%% / Y", seg)
	}
	if got := seg.Components["on_time"]; got != 440 {
		t.Errorf("segment on_time component = %v, want 440", got)
	}
	if got := seg.Components["committed"]; got != 522 {
		t.Errorf("segment committed component = %v, want 522", got)
	}
	if c := v.cell(t, "on_time_pct", "prod-1", 0); c.Display != "83.3%" {
		t.Errorf("prod-1 display = %q", c.Display)
	}

	// One audit entry for the whole batch.
	var batchAudits int
	for _, a := range e.audits(t, "t1") {
		if a.Action == "data.batch" {
			batchAudits++
			if !strings.Contains(string(a.After), "on_time/prod-1/2026-M10") || !strings.Contains(string(a.After), `"count":4`) {
				t.Errorf("audit after = %s", a.After)
			}
		}
	}
	if batchAudits != 1 {
		t.Errorf("data.batch audit entries = %d, want 1", batchAudits)
	}
}

func TestBatchConflict(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 10, 0)), nil)

	// A stale write (expects "new") plus a fresh one: nothing may be saved.
	var c conflictsJSON
	e.expect(t, 409, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 99, 0),
		wr("committed", "prod-1", "2026-M10", 20, 0),
	), &c)
	if len(c.Conflicts) != 1 || c.Conflicts[0].Write.MeasureKey != "on_time" {
		t.Fatalf("conflicts = %+v", c)
	}
	cur := c.Conflicts[0].Current
	if cur == nil || cur.Revision != 1 || cur.Value == nil || *cur.Value != 10 {
		t.Fatalf("current = %+v", cur)
	}

	var h struct{ History []pointJSON }
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/history?measure=committed&subject=prod-1&period=2026-M10", nil, &h)
	if len(h.History) != 0 {
		t.Errorf("committed was saved despite the conflict: %+v", h.History)
	}
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=2026-M10", nil, &h)
	if len(h.History) != 1 || *h.History[0].Value != 10 {
		t.Errorf("on_time history = %+v", h.History)
	}
	for _, a := range e.audits(t, "t1") {
		if a.Action == "data.batch" && strings.Contains(string(a.After), `"count":2`) {
			t.Errorf("conflicting batch was audited: %s", a.After)
		}
	}
}

func TestBatchForbiddenOutsideScope(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	setScope(t, e, domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"prod-1"}})
	contrib := e.tokens["t1-contributor"]

	// In scope: allowed.
	e.expect(t, 200, contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 5, 0)), nil)

	// One forbidden row forbids the batch, and the in-scope row is not saved.
	got := e.expectError(t, 403, "forbidden", contrib, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("committed", "prod-1", "2026-M10", 6, 0),
		wr("committed", "prod-2", "2026-M10", 7, 0),
	))
	if len(got.Error.Details) != 1 || got.Error.Details[0].Path != "writes[1]" {
		t.Errorf("details = %+v, want only writes[1]", got.Error.Details)
	}
	var h struct{ History []pointJSON }
	e.expect(t, 200, contrib, "GET", "/scorecards/delivery/history?measure=committed&subject=prod-1&period=2026-M10", nil, &h)
	if len(h.History) != 0 {
		t.Errorf("in-scope row of a forbidden batch was saved: %+v", h.History)
	}

	// A viewer may not write at all; preview has the same rules.
	e.expectError(t, 403, "forbidden", e.tokens["t1-viewer"], "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 5, 0)))
	e.expectError(t, 403, "forbidden", contrib, "POST", "/scorecards/delivery/preview", batchBody(wr("committed", "prod-2", "2026-M10", 7, 0)))
}

func TestBatchValidation(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	na := func(m map[string]any, reason string) map[string]any { m["naReason"] = reason; return m }
	delete1 := func(m map[string]any) map[string]any { delete(m, "value"); return m }

	long := strings.Repeat("x", 201)
	for name, w := range map[string]map[string]any{
		"unknown measure":          wr("nope", "prod-1", "2026-M10", 1, 0),
		"unknown subject":          wr("on_time", "ghost", "2026-M10", 1, 0),
		"bad period":               wr("on_time", "prod-1", "2026-13", 1, 0),
		"no methodology yet":       wr("on_time", "prod-1", "2025-M10", 1, 0),
		"neither value nor reason": delete1(wr("on_time", "prod-1", "2026-M10", 1, 0)),
		"both value and reason":    na(wr("on_time", "prod-1", "2026-M10", 1, 0), "closed"),
		"reason too long":          na(delete1(wr("on_time", "prod-1", "2026-M10", 1, 0)), long),
		"negative revision":        wr("on_time", "prod-1", "2026-M10", 1, -1),
	} {
		got := e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/data:batch", batchBody(w))
		if len(got.Error.Details) == 0 || !strings.HasPrefix(got.Error.Details[0].Path, "writes[0]") {
			t.Errorf("%s: details = %+v", name, got.Error.Details)
		}
	}
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/data:batch", batchBody())
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 1, 0), wr("on_time", "prod-1", "2026-M10", 2, 0)))

	// A not-applicable write carries its reason.
	var saved savedJSON
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch",
		batchBody(na(delete1(wr("on_time", "prod-1", "2026-M10", 0, 0)), "Team on leave")), &saved)
	if len(saved.Saved) != 1 || saved.Saved[0].Value != nil || saved.Saved[0].NAReason != "Team on leave" {
		t.Errorf("saved = %+v", saved)
	}
}

func TestBatchContributorScopedByMetricKeys(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	setScope(t, e, domain.RoleContributor, domain.Scope{MetricKeys: []string{"on_time_pct"}})
	contrib := e.tokens["t1-contributor"]

	e.expect(t, 200, contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 5, 0)), nil)
	// "reviews" feeds only reviews_score, which is out of scope.
	got := e.expectError(t, 403, "forbidden", contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("reviews", "prod-1", "2026-Q4", 3, 0)))
	if len(got.Error.Details) != 1 {
		t.Errorf("details = %+v", got.Error.Details)
	}

	// The entry grid says the same through canEdit.
	var g entryJSON
	e.expect(t, 200, contrib, "GET", "/scorecards/delivery/entry?period=2026-M12", nil, &g)
	for _, r := range g.Rows {
		want := r.MeasureKey == "on_time" || r.MeasureKey == "committed"
		if r.CanEdit != want {
			t.Errorf("row %s/%s canEdit = %v, want %v", r.MeasureKey, r.SubjectID, r.CanEdit, want)
		}
	}
}

func TestBatchUnattachedItemRequiresAdmin(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	contrib := e.tokens["t1-contributor"]

	e.expectError(t, 403, "forbidden", contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("defects", "shop", "2026-M10", 3, 0)))
	// An attached item follows its unit.
	e.expect(t, 200, contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("defects", "pay", "2026-M10", 3, 0)), nil)
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/delivery/data:batch", batchBody(wr("defects", "shop", "2026-M10", 3, 0)), nil)

	// A contributor scoped to a unit cannot write items outside it.
	setScope(t, e, domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"seg-b"}})
	e.expectError(t, 403, "forbidden", contrib, "POST", "/scorecards/delivery/data:batch", batchBody(wr("defects", "pay", "2026-M10", 4, 1)))
}

func TestPreviewDoesNotPersist(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	auditsBefore := len(e.audits(t, "t1"))

	var pv struct{ Cells []cellJSON }
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/preview", batchBody(
		wr("on_time", "prod-1", "2026-M10", 200, 0), wr("committed", "prod-1", "2026-M10", 240, 0),
	), &pv)
	if len(pv.Cells) == 0 {
		t.Fatal("preview returned no cells")
	}

	var v viewJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	if c := v.cell(t, "on_time_pct", "prod-1", 0); c.Value != nil {
		t.Errorf("preview leaked into the view: %+v", c)
	}
	var h struct{ History []pointJSON }
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=2026-M10", nil, &h)
	if len(h.History) != 0 {
		t.Errorf("preview saved a point: %+v", h.History)
	}
	if n := len(e.audits(t, "t1")); n != auditsBefore {
		t.Errorf("preview wrote %d audit entries", n-auditsBefore)
	}
}

func TestPreviewReturnsAffectedCells(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	// prod-2 already has stored data; the preview replaces prod-1's on_time.
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-2", "2026-M10", 240, 0), wr("committed", "prod-2", "2026-M10", 282, 0),
		wr("committed", "prod-1", "2026-M10", 240, 0), wr("on_time", "prod-1", "2026-M10", 1, 0),
	), nil)

	var pv struct{ Cells []cellJSON }
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/preview", batchBody(wr("on_time", "prod-1", "2026-M10", 200, 1)), &pv)

	got := map[string]cellJSON{}
	for _, c := range pv.Cells {
		got[c.MetricKey+"/"+c.SubjectID+"/"+c.Period] = c
	}
	// prod-1 plus its ancestors, only for the metric using on_time, only at
	// the written period.
	for _, k := range []string{"on_time_pct/prod-1/2026-M10", "on_time_pct/seg-a/2026-M10", "on_time_pct/acme/2026-M10"} {
		if _, ok := got[k]; !ok {
			t.Errorf("missing cell %s; got %v", k, keys(got))
		}
	}
	if len(got) != 3 {
		t.Errorf("cells = %v, want exactly prod-1, seg-a, acme", keys(got))
	}
	if c := got["on_time_pct/prod-1/2026-M10"]; c.Display != "83.3%" || c.Status != "Y" {
		t.Errorf("prod-1 = %+v, want the merged 200/240", c)
	}
	if c := got["on_time_pct/seg-a/2026-M10"]; c.Display != "84.3%" {
		t.Errorf("seg-a = %+v, want 84.3%% from merged and stored data", c)
	}
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestHistoryNewestFirst(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	for i, v := range []float64{10, 20, 30} {
		e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", v, i)), nil)
	}
	var h struct{ History []pointJSON }
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=2026-M10", nil, &h)
	if len(h.History) != 3 {
		t.Fatalf("history = %+v", h.History)
	}
	for i, want := range []float64{30, 20, 10} {
		if h.History[i].Value == nil || *h.History[i].Value != want || h.History[i].Revision != 3-i {
			t.Errorf("history[%d] = %+v, want value %v revision %d", i, h.History[i], want, 3-i)
		}
	}

	// Empty history is [], not null; a viewer scoped away from the subject
	// cannot read it.
	var empty struct{ History []pointJSON }
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-2&period=2026-M10", nil, &empty)
	if empty.History == nil {
		t.Error("empty history decoded as null")
	}
	setScope(t, e, domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"seg-b"}})
	e.expectError(t, 403, "forbidden", e.tokens["t1-viewer"], "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=2026-M10", nil)
	e.expectError(t, 404, "not_found", admin, "GET", "/scorecards/delivery/history?measure=on_time&subject=ghost&period=2026-M10", nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=bad", nil)
}

func TestOverrideFootnoteFields(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin := e.tokens["t1-admin"]

	var ov struct {
		MetricKey string   `json:"metricKey"`
		Value     *float64 `json:"value"`
		Status    string   `json:"status"`
		Reason    string   `json:"reason"`
		By        string   `json:"by"`
	}
	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/overrides", map[string]any{
		"metricKey": "on_time_pct", "subjectId": "seg-a", "period": "2026-M10", "value": 95.0, "reason": "Excluded the October outage",
	}, &ov)
	if ov.By != "u-t1-admin" || ov.Reason == "" || ov.Value == nil || ov.Status != "" {
		t.Fatalf("override = %+v", ov)
	}

	var v viewJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	c := v.cell(t, "on_time_pct", "seg-a", 0)
	if c.Override == nil || c.Override.Reason != "Excluded the October outage" || c.Override.By != "u-t1-admin" {
		t.Fatalf("override fields = %+v", c.Override)
	}
	if c.Computed == nil || c.Computed.Status != "Y" || c.Computed.Value == nil || !approx(*c.Computed.Value, 440.0/522.0*100) {
		t.Fatalf("computed fields = %+v", c.Computed)
	}
	if c.Display != "95.0%" || c.Status != "G" {
		t.Errorf("overridden cell = %+v, want 95.0%% / G", c)
	}
	// Unaffected cells carry neither field.
	if o := v.cell(t, "on_time_pct", "prod-1", 0); o.Override != nil || o.Computed != nil {
		t.Errorf("prod-1 = %+v", o)
	}

	// Replace with a status-only override, then delete it.
	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/overrides", map[string]any{
		"metricKey": "on_time_pct", "subjectId": "seg-a", "period": "2026-M10", "status": "R", "reason": "Under review",
	}, nil)
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	if c := v.cell(t, "on_time_pct", "seg-a", 0); c.Status != "R" || c.Display != "84.3%" {
		t.Errorf("status-only override = %+v", c)
	}
	q := "?metricKey=on_time_pct&subjectId=seg-a&period=2026-M10"
	if status, _ := e.call(t, admin, "DELETE", "/scorecards/delivery/overrides"+q, nil); status != 204 {
		t.Fatalf("delete status %d", status)
	}
	v = viewJSON{} // decoding into a reused struct would keep the old override
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &v)
	if c := v.cell(t, "on_time_pct", "seg-a", 0); c.Override != nil || c.Status != "Y" {
		t.Errorf("after delete = %+v", c)
	}
	e.expectError(t, 404, "not_found", admin, "DELETE", "/scorecards/delivery/overrides"+q, nil)

	actions := map[string]int{}
	for _, a := range e.audits(t, "t1") {
		actions[a.Action]++
	}
	if actions["override.put"] != 2 || actions["override.delete"] != 1 {
		t.Errorf("audit actions = %v", actions)
	}
}

func TestOverrideValidationAndAuthorization(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	body := func(mod func(map[string]any)) map[string]any {
		m := map[string]any{"metricKey": "on_time_pct", "subjectId": "seg-a", "period": "2026-M10", "status": "R", "reason": "why"}
		mod(m)
		return m
	}
	put := func(want int, code, token string, b map[string]any) {
		t.Helper()
		e.expectError(t, want, code, token, "PUT", "/scorecards/delivery/overrides", b)
	}
	put(400, "invalid", admin, body(func(m map[string]any) { m["status"] = "PURPLE" }))
	put(400, "invalid", admin, body(func(m map[string]any) { delete(m, "status") }))
	put(400, "invalid", admin, body(func(m map[string]any) { m["metricKey"] = "ghost" }))
	put(400, "invalid", admin, body(func(m map[string]any) { m["subjectId"] = "ghost" }))
	put(400, "invalid", admin, body(func(m map[string]any) { m["period"] = "2025-M10" })) // no methodology yet
	put(400, "invalid", admin, body(func(m map[string]any) { m["period"] = "nonsense" }))
	put(403, "forbidden", e.tokens["t1-contributor"], body(func(map[string]any) {}))
	put(403, "forbidden", e.tokens["t1-viewer"], body(func(map[string]any) {}))
	e.expectError(t, 403, "forbidden", e.tokens["t1-contributor"], "DELETE", "/scorecards/delivery/overrides?metricKey=on_time_pct&subjectId=seg-a&period=2026-M10", nil)
	e.expectError(t, 404, "not_found", admin, "PUT", "/scorecards/ghost/overrides", body(func(map[string]any) {}))
}

func TestOverrideStatusMustBeInTenantScale(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	got := e.expectError(t, 400, "invalid", e.tokens["t1-admin"], "PUT", "/scorecards/delivery/overrides", map[string]any{
		"metricKey": "on_time_pct", "subjectId": "seg-a", "period": "2026-M10", "status": "BLUE", "reason": "x",
	})
	if len(got.Error.Details) != 1 || got.Error.Details[0].Path != "status" {
		t.Errorf("details = %+v", got.Error.Details)
	}
}

func TestEntryRowsAndOrdering(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 7, 0)), nil)

	var g entryJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/entry?period=2026-M10", nil, &g)
	if g.Period != "2026-M10" {
		t.Errorf("period = %q", g.Period)
	}
	var order []string
	for _, r := range g.Rows {
		order = append(order, r.MeasureKey+"/"+r.SubjectID)
		if r.Period != "2026-M10" {
			t.Errorf("row %+v has period %q", r, r.Period)
		}
		if r.MetricKeys == nil || !r.CanEdit {
			t.Errorf("row %+v", r)
		}
	}
	// on_time_pct's measures at each product, then app_defects' at each app
	// (items follow org units; sorted by name). No quarterly rows in M10.
	want := "on_time/prod-1 on_time/prod-2 committed/prod-1 committed/prod-2 defects/pay defects/shop"
	if strings.Join(order, " ") != want {
		t.Errorf("order = %v\nwant    %s", order, want)
	}
	r := g.Rows[0]
	if r.Value == nil || *r.Value != 7 || r.Revision != 1 || r.MeasureName != "On time" || r.SubjectName != "Product One" || len(r.MetricKeys) != 1 || r.MetricKeys[0] != "on_time_pct" {
		t.Errorf("first row = %+v", r)
	}
	if r := g.Rows[1]; r.Value != nil || r.Revision != 0 {
		t.Errorf("empty row = %+v", r)
	}

	// A viewer scoped to prod-2 sees only prod-2's rows, none editable.
	setScope(t, e, domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"prod-2"}})
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/entry?period=2026-M10", nil, &g)
	if len(g.Rows) != 2 {
		t.Fatalf("viewer rows = %+v", g.Rows)
	}
	for _, r := range g.Rows {
		if r.SubjectID != "prod-2" || r.CanEdit {
			t.Errorf("viewer row = %+v", r)
		}
	}

	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/entry?period=2026-Q4", nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/entry?period=junk", nil)
}

func TestEntryIncludesQuarterlyMetricAtQuarterEndOnly(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]

	quarterly := func(g entryJSON) []entryRowJSON {
		var out []entryRowJSON
		for _, r := range g.Rows {
			if r.MeasureKey == "reviews" {
				out = append(out, r)
			}
		}
		return out
	}
	for _, month := range []string{"2026-M10", "2026-M11"} {
		var g entryJSON
		e.expect(t, 200, admin, "GET", "/scorecards/delivery/entry?period="+month, nil, &g)
		if rows := quarterly(g); len(rows) != 0 {
			t.Errorf("%s includes quarterly rows %+v", month, rows)
		}
	}
	var g entryJSON
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/entry?period=2026-M12", nil, &g)
	rows := quarterly(g)
	if len(rows) != 2 {
		t.Fatalf("2026-M12 quarterly rows = %+v", rows)
	}
	for _, r := range rows {
		if r.Period != "2026-Q4" {
			t.Errorf("quarterly row period = %q, want 2026-Q4", r.Period)
		}
	}
	// The row's own period is what the grid sends back to save it.
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(wr("reviews", rows[0].SubjectID, rows[0].Period, 4, rows[0].Revision)), nil)
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/entry?period=2026-M12", nil, &g)
	if got := quarterly(g)[0]; got.Revision != 1 || got.Value == nil || *got.Value != 4 {
		t.Errorf("after save = %+v", got)
	}
}

func TestCrossTenantScorecard(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	other := e.tokens["t2-admin"]
	for _, tc := range []struct{ method, path string }{
		{"GET", "/scorecards/delivery/view?periods=2026-M10"},
		{"GET", "/scorecards/delivery/entry?period=2026-M10"},
		{"GET", "/scorecards/delivery/history?measure=on_time&subject=prod-1&period=2026-M10"},
		{"DELETE", "/scorecards/delivery/overrides?metricKey=on_time_pct&subjectId=seg-a&period=2026-M10"},
	} {
		e.expectError(t, 404, "not_found", other, tc.method, tc.path, nil)
	}
	e.expectError(t, 404, "not_found", other, "POST", "/scorecards/delivery/data:batch", batchBody(wr("on_time", "prod-1", "2026-M10", 1, 0)))
	e.expectError(t, 404, "not_found", other, "POST", "/scorecards/delivery/preview", batchBody(wr("on_time", "prod-1", "2026-M10", 1, 0)))
	e.expectError(t, 404, "not_found", other, "PUT", "/scorecards/delivery/overrides", map[string]any{
		"metricKey": "on_time_pct", "subjectId": "seg-a", "period": "2026-M10", "status": "R",
	})
	e.expectError(t, 403, "forbidden", e.tokens["operator"], "GET", "/scorecards/delivery/view?periods=2026-M10", nil)
}

// q builds a query string.
func q(kv ...string) string {
	v := url.Values{}
	for i := 0; i < len(kv); i += 2 {
		v.Add(kv[i], kv[i+1])
	}
	return "?" + v.Encode()
}

// ---- derived rows ------------------------------------------------------------------

func entryRow(t *testing.T, e *testEnv, token, measure, subject string) entryRowJSON {
	t.Helper()
	var g struct {
		Rows []entryRowJSON `json:"rows"`
	}
	e.expect(t, 200, token, "GET", "/scorecards/sc/entry?period=2026-M09", nil, &g)
	for _, r := range g.Rows {
		if r.MeasureKey == measure && r.SubjectID == subject {
			return r
		}
	}
	t.Fatalf("no entry row %s/%s in %+v", measure, subject, g.Rows)
	return entryRowJSON{}
}

func TestEntryDerivedRows(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	admin, contributor := e.tokens["t1-admin"], e.tokens["t1-contributor"]
	write := func(rev int, extra map[string]any) map[string]any {
		w := map[string]any{"measureKey": "defect_points_sum", "subjectId": "checkout", "period": "2026-M09", "expectedRevision": rev}
		for k, v := range extra {
			w[k] = v
		}
		return map[string]any{"writes": []any{w}}
	}

	// Contributors see the derived value from records and cannot edit it.
	r := entryRow(t, e, contributor, "defect_points_sum", "checkout")
	if r.Derived == nil || !*r.Derived || r.CanEdit || r.Source == nil || *r.Source != "records" || r.Value == nil || *r.Value != 832 {
		t.Fatalf("contributor row = %+v, want derived 832 from records, not editable", r)
	}
	e.expectError(t, 403, "forbidden", contributor, "POST", "/scorecards/sc/data:batch", write(r.Revision, map[string]any{"value": 5}))
	e.expectError(t, 403, "forbidden", contributor, "POST", "/scorecards/sc/data:batch", write(r.Revision, map[string]any{"clear": true}))

	// Admins may type over it; the row then shows the typed value beside the records one.
	r = entryRow(t, e, admin, "defect_points_sum", "checkout")
	if !r.CanEdit {
		t.Fatalf("admin row = %+v, want editable", r)
	}
	e.expect(t, 200, admin, "POST", "/scorecards/sc/data:batch", write(r.Revision, map[string]any{"value": 900}), nil)
	r = entryRow(t, e, admin, "defect_points_sum", "checkout")
	if r.Value == nil || *r.Value != 900 || *r.Source != "grid" || r.RecordsValue == nil || *r.RecordsValue != 832 {
		t.Fatalf("typed row = %+v, want 900 typed, records give 832", r)
	}
	// A clear sends no value.
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/sc/data:batch", write(r.Revision, map[string]any{"clear": true, "value": 1}))

	// Use records: clearing the typed value brings the derived one back at once.
	var saved struct {
		Saved []map[string]any `json:"saved"`
	}
	e.expect(t, 200, admin, "POST", "/scorecards/sc/data:batch", write(r.Revision, map[string]any{"clear": true}), &saved)
	if len(saved.Saved) != 1 || saved.Saved[0]["value"] != 832.0 || saved.Saved[0]["source"] != "records" {
		t.Errorf("saved = %+v, want the records value back", saved.Saved)
	}
	r = entryRow(t, e, admin, "defect_points_sum", "checkout")
	if r.Value == nil || *r.Value != 832 || *r.Source != "records" || r.RecordsValue != nil {
		t.Errorf("row after use records = %+v, want 832 from records", r)
	}
}
