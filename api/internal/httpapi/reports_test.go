package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/report"
	"opsvision/internal/store/memstore"
)

func TestReportSummaryPutGet(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin, member, viewer := e.tokens["t1-admin"], e.tokens["t1-contributor"], e.tokens["t1-viewer"]

	var saved struct {
		Text     string `json:"text"`
		Revision int    `json:"revision"`
	}
	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": "October went well.", "expectedRevision": 0}, &saved)
	if saved.Text != "October went well." || saved.Revision != 1 {
		t.Fatalf("put summary: %+v", saved)
	}

	var got struct {
		Text     string `json:"text"`
		Revision int    `json:"revision"`
	}
	e.expect(t, 200, member, "GET", "/scorecards/delivery/reports/2026-M10/summary", nil, &got)
	if got.Text != "October went well." || got.Revision != 1 {
		t.Fatalf("get summary: %+v", got)
	}

	e.expectError(t, 403, "forbidden", viewer, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": "nope", "expectedRevision": 0})

	e.expectError(t, 409, "conflict", admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": "stale", "expectedRevision": 0})
}

func TestReportPublishAndList(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin := e.tokens["t1-admin"]

	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": "Shipped on time.", "expectedRevision": 0}, nil)

	var pub1 struct {
		Revision int  `json:"revision"`
		Unlocked bool `json:"unlocked"`
	}
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, &pub1)
	if pub1.Revision != 1 || !pub1.Unlocked {
		t.Fatalf("publish 1: %+v", pub1)
	}

	var pub2 struct {
		Revision int `json:"revision"`
	}
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, &pub2)
	if pub2.Revision != 2 {
		t.Fatalf("publish 2: %+v", pub2)
	}

	var list struct {
		Months []struct {
			Period   string `json:"period"`
			Status   string `json:"status"`
			Revision int    `json:"revision"`
		} `json:"months"`
	}
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/reports", nil, &list)
	var m10 *struct {
		Period   string `json:"period"`
		Status   string `json:"status"`
		Revision int    `json:"revision"`
	}
	for i := range list.Months {
		if list.Months[i].Period == "2026-M10" {
			m10 = &list.Months[i]
			break
		}
	}
	if m10 == nil || m10.Status != "published" || m10.Revision != 2 {
		t.Fatalf("list M10: %+v", m10)
	}
}

func TestReportDataRevised(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin, viewer := e.tokens["t1-admin"], e.tokens["t1-viewer"]

	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, nil)

	var before viewJSON
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/view?periods=2026-M10", nil, &before)
	oldDisplay := before.cell(t, "on_time_pct", "seg-a", 0).Display

	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 220, 1), wr("committed", "prod-1", "2026-M10", 240, 1),
	), nil)

	var doc map[string]any
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/reports/2026-M10", nil, &doc)
	if doc["live"] != false || doc["dataRevised"] != true {
		t.Fatalf("published doc: %+v", doc)
	}
	view, _ := doc["view"].(map[string]any)
	rows, _ := view["rows"].([]any)
	foundOld := false
	for _, r := range rows {
		row, _ := r.(map[string]any)
		if row["metricKey"] == "on_time_pct" && row["subjectId"] == "seg-a" {
			cells, _ := row["cells"].([]any)
			for _, c := range cells {
				cell, _ := c.(map[string]any)
				if cell["period"] == "2026-M10" && cell["display"] == oldDisplay {
					foundOld = true
				}
			}
		}
	}
	if !foundOld {
		t.Fatalf("snapshot view missing old display %q", oldDisplay)
	}

	var live map[string]any
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/reports/2026-M10?revision=live", nil, &live)
	if live["live"] != true || live["dataRevised"] != false {
		t.Fatalf("live doc: %+v", live)
	}
}

func TestReportInvalidPeriod(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	e.expectError(t, 400, "invalid", admin, "GET", "/scorecards/delivery/reports/2026-Q4/summary", nil)
}

func TestReportSummaryMissingNot404(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	var got map[string]any
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/reports/2026-M09/summary", nil, &got)
	if got["text"] != "" {
		raw, _ := json.Marshal(got["text"])
		if string(raw) != `""` && got["text"] != nil {
			t.Fatalf("text = %#v", got["text"])
		}
	}
	if rev, ok := got["revision"].(float64); !ok || int(rev) != 0 {
		t.Fatalf("revision = %#v", got["revision"])
	}
}

func TestReportPublishAudit(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, nil)
	entries := e.audits(t, "t1")
	var found bool
	for _, ent := range entries {
		if ent.Action == "report.publish" {
			found = true
		}
	}
	if !found {
		t.Fatalf("audit missing report.publish among %#v", entries)
	}
}

func TestReportLiveAllGreenFactsEmptyArray(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	// Strong on-time numbers yield green rollup with no fact sentences for M10.
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M10", 240, 0), wr("committed", "prod-1", "2026-M10", 250, 0),
		wr("on_time", "prod-2", "2026-M10", 280, 0), wr("committed", "prod-2", "2026-M10", 290, 0),
		wr("reviews", "prod-1", "2026-Q4", 5, 0), wr("reviews", "prod-2", "2026-Q4", 5, 0),
		wr("defects", "pay", "2026-M10", 1, 0), wr("defects", "shop", "2026-M10", 1, 0),
	), nil)
	// Company-level facts read the root row; quarterly reviews need an explicit root cell for M10.
	e.expect(t, 200, admin, "PUT", "/scorecards/delivery/overrides", map[string]any{
		"metricKey": "reviews_score", "subjectId": "acme", "period": "2026-M10",
		"value": 5, "status": "G", "reason": "fixture",
	}, nil)
	_, raw := e.call(t, e.tokens["t1-viewer"], "GET", "/scorecards/delivery/reports/2026-M10?revision=live", nil)
	if strings.Contains(string(raw), `"facts":null`) {
		t.Fatalf("facts must not be null: %s", raw)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	facts, ok := doc["facts"].([]any)
	if !ok {
		t.Fatalf("facts type = %T", doc["facts"])
	}
	if len(facts) != 0 {
		t.Fatalf("facts = %#v, want empty for all-green month", facts)
	}
}

func TestReportPublishedUndriftedChangesEmptyArray(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, nil)
	_, raw := e.call(t, admin, "GET", "/scorecards/delivery/reports/2026-M10", nil)
	if strings.Contains(string(raw), `"changes":null`) {
		t.Fatalf("changes must not be null: %s", raw)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	changes, ok := doc["changes"].([]any)
	if !ok {
		t.Fatalf("changes type = %T", doc["changes"])
	}
	if len(changes) != 0 {
		t.Fatalf("changes = %#v, want empty when data undrifted", changes)
	}
}

func TestReportPublishedViewerScopeFiltersRows(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	saveSplit(t, e)
	setScope(t, e, domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"prod-1"}})
	admin, viewer := e.tokens["t1-admin"], e.tokens["t1-viewer"]
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, nil)

	var adminDoc, viewerDoc map[string]any
	e.expect(t, 200, admin, "GET", "/scorecards/delivery/reports/2026-M10", nil, &adminDoc)
	e.expect(t, 200, viewer, "GET", "/scorecards/delivery/reports/2026-M10", nil, &viewerDoc)
	adminRows := reportRowSubjects(t, adminDoc)
	viewerRows := reportRowSubjects(t, viewerDoc)
	for subj := range viewerRows {
		if subj == "prod-2" || subj == "seg-b" {
			t.Fatalf("viewer sees out-of-scope subject %q", subj)
		}
	}
	if len(viewerRows) >= len(adminRows) {
		t.Fatalf("viewer rows %#v should be fewer than admin %#v", viewerRows, adminRows)
	}
}

func reportRowSubjects(t *testing.T, doc map[string]any) map[string]struct{} {
	t.Helper()
	view, _ := doc["view"].(map[string]any)
	rows, _ := view["rows"].([]any)
	out := map[string]struct{}{}
	for _, r := range rows {
		row, _ := r.(map[string]any)
		out[row["subjectId"].(string)] = struct{}{}
	}
	return out
}

func reportFacts(t *testing.T, doc map[string]any) []string {
	t.Helper()
	raw, ok := doc["facts"].([]any)
	if !ok {
		t.Fatalf("facts type = %T", doc["facts"])
	}
	out := make([]string, 0, len(raw))
	for _, f := range raw {
		out = append(out, f.(string))
	}
	return out
}

// Facts name metrics; a viewer scoped to one metric must not learn the
// status of the others, and a viewer who cannot read the company row gets
// none.
func TestReportFactsRespectViewerScope(t *testing.T) {
	hidden := []string{"Reviews held", "Open defects"}
	mentions := func(facts []string) bool {
		for _, f := range facts {
			for _, h := range hidden {
				if strings.Contains(f, h) {
					return true
				}
			}
		}
		return false
	}
	for _, mode := range []struct {
		name string
		path string
	}{
		{"live", "/scorecards/delivery/reports/2026-M10?revision=live"},
		{"published", "/scorecards/delivery/reports/2026-M10"},
	} {
		for _, sc := range []struct {
			name  string
			scope domain.Scope
			check func(t *testing.T, facts []string)
		}{
			{"metric-scoped", domain.Scope{MetricKeys: []string{"on_time_pct"}}, func(t *testing.T, facts []string) {
				if mentions(facts) {
					t.Fatalf("facts %q name out-of-scope metrics", facts)
				}
			}},
			{"subject-scoped", domain.Scope{OrgUnitIDs: []string{"prod-1"}}, func(t *testing.T, facts []string) {
				if len(facts) != 0 {
					t.Fatalf("facts = %q, want none without the company row", facts)
				}
			}},
		} {
			t.Run(mode.name+"/"+sc.name, func(t *testing.T) {
				e := newTestEnv(t)
				seedDelivery(t, e)
				saveSplit(t, e)
				admin, viewer := e.tokens["t1-admin"], e.tokens["t1-viewer"]
				setScope(t, e, domain.RoleViewer, sc.scope)
				// Reviews held (quarterly) turns red at the company in October.
				for _, o := range []struct {
					period, status string
					value          float64
				}{{"2026-M09", "G", 5}, {"2026-M10", "R", 1}} {
					e.expect(t, 200, admin, "PUT", "/scorecards/delivery/overrides", map[string]any{
						"metricKey": "reviews_score", "subjectId": "acme", "period": o.period,
						"value": o.value, "status": o.status, "reason": "fixture",
					}, nil)
				}
				if mode.name == "published" {
					e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish", map[string]any{}, nil)
				}
				var adminDoc, viewerDoc map[string]any
				e.expect(t, 200, admin, "GET", mode.path, nil, &adminDoc)
				e.expect(t, 200, viewer, "GET", mode.path, nil, &viewerDoc)
				if af := reportFacts(t, adminDoc); !mentions(af) {
					t.Fatalf("admin facts %q should name another metric, or the test proves nothing", af)
				}
				sc.check(t, reportFacts(t, viewerDoc))
			})
		}
	}
}

func TestReportPublishSummaryLength(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	_, raw := e.call(t, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish",
		map[string]any{"summary": strings.Repeat("é", 8001)})
	if !strings.Contains(string(raw), `"summary"`) {
		t.Fatalf("publish with a long summary: %s, want a problem at path summary", raw)
	}
	e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/reports/2026-M10/publish",
		map[string]any{"summary": strings.Repeat("é", 8001)})
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/reports/2026-M10/publish",
		map[string]any{"summary": strings.Repeat("é", 8000)}, nil)
}

func TestReportSummaryLength(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	long := strings.Repeat("x", 8001)
	e.expectError(t, 400, "invalid", admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": long, "expectedRevision": 0})
}

// ---- published reports over the demo tenant ------------------------------------

// demoNow is a fixed clock after the demo's last month (2026-M10).
var demoNow = time.Date(2026, time.November, 15, 12, 0, 0, 0, time.UTC)

const demoReport = "/scorecards/" + demo.ScorecardID + "/reports/2026-M09"

// newDemoEnv is the API over the demo tenant, with dev tokens for its users
// keyed by role: "admin", "contributor" (scoped to Payments) and "viewer".
func newDemoEnv(t *testing.T) *testEnv {
	t.Helper()
	st := memstore.New()
	if _, err := demo.Seed(context.Background(), st, period.Calendar{FiscalYearStartMonth: time.January}); err != nil {
		t.Fatal(err)
	}
	tokens := map[string]string{}
	for _, u := range demo.Users {
		tok, err := auth.IssueDevToken(testSecret, u.UserID, u.Email, u.Name, demo.Auth0OrgID, false)
		if err != nil {
			t.Fatal(err)
		}
		tokens[string(u.Role)] = tok
	}
	authMW, err := auth.Middleware(auth.Config{Mode: auth.ModeDev, DevSecret: testSecret, Now: func() time.Time { return demoNow }}, st)
	if err != nil {
		t.Fatal(err)
	}
	objs := objects.NewMem("http://objects.test", objects.Signer(testSecret))
	var n atomic.Int64
	s := NewServer(Deps{
		Store: st, Objects: objs,
		Now:   func() time.Time { return demoNow },
		NewID: func() string { return fmt.Sprintf("id-%04d", n.Add(1)) },
	})
	srv := httptest.NewServer(NewHandler(s, authMW))
	t.Cleanup(srv.Close)
	return &testEnv{srv: srv, api: s, store: st, objs: objs, tokens: tokens}
}

type reportDocJSON struct {
	DataRevised bool `json:"dataRevised"`
	Changes     []struct {
		MetricKey string `json:"metricKey"`
		SubjectID string `json:"subjectId"`
		Period    string `json:"period"`
		Was       string `json:"was"`
		Now       string `json:"now"`
	} `json:"changes"`
	View     reportViewJSON  `json:"view"`
	Standing *reportViewJSON `json:"standing"`
}

type reportViewJSON struct {
	Periods []string `json:"periods"`
	Ytd     []string `json:"ytd"`
	Rows    []struct {
		MetricKey   string `json:"metricKey"`
		SubjectID   string `json:"subjectId"`
		SubjectKind string `json:"subjectKind"`
		Depth       int    `json:"depth"`
		Cells       []struct {
			Period string   `json:"period"`
			Ytd    bool     `json:"ytd"`
			Value  *float64 `json:"value"`
		} `json:"cells"`
	} `json:"rows"`
}

// companyRoot is the subject of the view's depth-0 org unit rows.
func (v reportViewJSON) companyRoot(t *testing.T) string {
	t.Helper()
	for _, r := range v.Rows {
		if r.SubjectKind == "unit" && r.Depth == 0 {
			return r.SubjectID
		}
	}
	t.Fatal("no company row")
	return ""
}

// cell returns a row's cell for a period (not year to date).
func (v reportViewJSON) cell(metric, subject, p string) (value *float64, found bool) {
	for _, r := range v.Rows {
		if r.MetricKey != metric || r.SubjectID != subject {
			continue
		}
		for _, c := range r.Cells {
			if c.Period == p && !c.Ytd {
				return c.Value, true
			}
		}
	}
	return nil, false
}

func (e *testEnv) publishDemo(t *testing.T) {
	t.Helper()
	e.expect(t, 200, e.tokens["admin"], "POST", demoReport+"/publish", map[string]any{}, nil)
}

// Every published report read "Data revised" once its YTD cells stood in
// for the report month's cells.
func TestPublishThenReadIsNotRevised(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	for _, role := range []string{"admin", "contributor", "viewer"} {
		for _, q := range []string{"", "?standing=true"} {
			var doc reportDocJSON
			e.expect(t, 200, e.tokens[role], "GET", demoReport+q, nil, &doc)
			if doc.DataRevised || len(doc.Changes) != 0 {
				t.Fatalf("%s%s: dataRevised %v with %d changes, first %+v", role, q, doc.DataRevised, len(doc.Changes), doc.Changes[:min(1, len(doc.Changes))])
			}
		}
	}
}

func TestStandingIsOptIn(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	admin := e.tokens["admin"]

	_, raw := e.call(t, admin, "GET", demoReport, nil)
	var plain map[string]json.RawMessage
	if err := json.Unmarshal(raw, &plain); err != nil {
		t.Fatal(err)
	}
	if _, ok := plain["standing"]; ok {
		t.Fatal("standing returned without standing=true")
	}
	if _, ok := plain["summary"]; !ok {
		t.Fatal("no summary")
	}

	var doc reportDocJSON
	e.expect(t, 200, admin, "GET", demoReport+"?standing=true", nil, &doc)
	st := doc.Standing
	if st == nil {
		t.Fatal("no standing with standing=true")
	}
	for _, want := range []string{"2025-M10", "2026-M09", "2025-Q4", "2026-Q3", "2025-H2", "2026-H1"} {
		if !strings.Contains(strings.Join(st.Periods, ","), want) {
			t.Errorf("standing periods %v lack %s", st.Periods, want)
		}
	}
	if len(st.Periods) != 12+4+2 || len(st.Ytd) != 1 || st.Ytd[0] != "2026-M09" {
		t.Errorf("standing periods %v, ytd %v; want 12 months, 4 quarters, 2 halves and YTD through 2026-M09", st.Periods, st.Ytd)
	}
	if len(doc.View.Periods) != 6 {
		t.Errorf("view periods %v, want the six months", doc.View.Periods)
	}
	root := st.companyRoot(t)
	if v, ok := st.cell("concepts_expected_value", root, "2026-Q3"); !ok || v == nil {
		t.Errorf("concepts_expected_value at %s: Q3 cell %v (found %v), want a value", root, v, ok)
	}
	if _, ok := st.cell("epics_on_time", root, "2026-Q3"); ok {
		t.Error("a monthly metric keeps its 2026-Q3 cell; coarse cells belong to coarse rows only")
	}
	if _, ok := st.cell("epics_on_time", root, "2025-M10"); !ok {
		t.Error("a monthly metric has no 2025-M10 cell")
	}

	rc, _, err := e.objs.Get(context.Background(), report.ObjectKey(demo.TenantID, demo.ScorecardID, "2026-M09", 1))
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	stored, _ := io.ReadAll(rc)
	var obj struct {
		SchemaVersion int             `json:"schemaVersion"`
		Standing      json.RawMessage `json:"standing"`
	}
	if err := json.Unmarshal(stored, &obj); err != nil {
		t.Fatal(err)
	}
	if obj.SchemaVersion != 2 || len(obj.Standing) == 0 {
		t.Fatalf("stored schemaVersion %d with %d bytes of standing; want 2 and a standing view", obj.SchemaVersion, len(obj.Standing))
	}
}

// Standing is filtered exactly as view. The demo contributor's Payments
// scope limits writes, not reads, so a viewer scoped to Payments reads it.
func TestStandingIsFilteredForScopedReaders(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	ctx := context.Background()
	m, err := e.store.GetMembership(ctx, demo.TenantID, "dev|viewer")
	if err != nil {
		t.Fatal(err)
	}
	m.Scope = domain.Scope{OrgUnitIDs: []string{"payments"}, MetricKeys: []string{}}
	if err := e.store.PutMembership(ctx, demo.TenantID, m); err != nil {
		t.Fatal(err)
	}

	var admin, payments, contributor reportDocJSON
	e.expect(t, 200, e.tokens["admin"], "GET", demoReport+"?standing=true", nil, &admin)
	e.expect(t, 200, e.tokens["viewer"], "GET", demoReport+"?standing=true", nil, &payments)
	e.expect(t, 200, e.tokens["contributor"], "GET", demoReport+"?standing=true", nil, &contributor)
	if contributor.Standing == nil || len(contributor.Standing.Rows) != len(contributor.View.Rows) {
		t.Fatalf("contributor: standing and view rows differ")
	}
	if payments.Standing == nil || len(payments.Standing.Rows) == 0 {
		t.Fatal("the Payments viewer gets no standing rows")
	}
	if len(payments.Standing.Rows) >= len(admin.Standing.Rows) || len(payments.Standing.Rows) != len(payments.View.Rows) {
		t.Fatalf("Payments viewer standing rows %d, view rows %d, admin %d: want as many as its view, fewer than the admin's",
			len(payments.Standing.Rows), len(payments.View.Rows), len(admin.Standing.Rows))
	}
	readable := map[string]bool{}
	for _, r := range payments.View.Rows {
		readable[r.SubjectID] = true
	}
	outside := map[string]bool{
		admin.Standing.companyRoot(t): true,
		"platform":                    true, "data": true, "mobile": true,
		"identity": true, "messaging": true, "analytics": true, "pipelines": true,
	}
	sawPayments := false
	for _, r := range payments.Standing.Rows {
		if outside[r.SubjectID] || !readable[r.SubjectID] {
			t.Fatalf("Payments viewer standing has %s/%s, outside Payments", r.MetricKey, r.SubjectID)
		}
		sawPayments = sawPayments || r.SubjectID == "payments"
	}
	if !sawPayments {
		t.Fatal("Payments viewer standing has no Payments row")
	}
}

// A revision stored before standing existed reads as it always did.
func TestV1SnapshotReadsWithoutStanding(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	ctx := context.Background()
	key := report.ObjectKey(demo.TenantID, demo.ScorecardID, "2026-M09", 1)
	rc, _, err := e.objs.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(rc)
	rc.Close()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	delete(obj, "schemaVersion")
	delete(obj, "standing")
	v1, _ := json.Marshal(obj)
	if err := e.objs.Put(ctx, key, "application/json", v1); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"", "?standing=true"} {
		status, body := e.call(t, e.tokens["admin"], "GET", demoReport+q, nil)
		if status != 200 {
			t.Fatalf("v1%s: status %d %s", q, status, body)
		}
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(body, &doc); err != nil {
			t.Fatal(err)
		}
		if _, ok := doc["standing"]; ok {
			t.Fatalf("v1%s: standing returned for a snapshot without one", q)
		}
		var typed reportDocJSON
		_ = json.Unmarshal(body, &typed)
		if typed.DataRevised || len(typed.Changes) != 0 {
			t.Fatalf("v1%s: dataRevised %v with %d changes", q, typed.DataRevised, len(typed.Changes))
		}
	}
}

func TestRevisedQuarterIsReported(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	var was reportDocJSON
	e.expect(t, 200, e.tokens["admin"], "GET", demoReport+"?standing=true", nil, &was)
	if was.Standing == nil {
		t.Fatal("no standing")
	}
	root := was.Standing.companyRoot(t)

	data, _, err := e.store.ListData(context.Background(), demo.TenantID, demo.ScorecardID, []int{2026})
	if err != nil {
		t.Fatal(err)
	}
	rev := -1
	var measured float64
	for _, dp := range data {
		if dp.SubjectID == "checkout" && dp.Period.String() == "2026-Q3" && dp.Value != nil {
			switch dp.MeasureKey {
			case "ev_delivered":
				rev = dp.Revision
			case "ev_measured":
				measured = *dp.Value
			}
		}
	}
	if rev < 0 || measured == 0 {
		t.Fatalf("no 2026-Q3 expected-value data for checkout (revision %d, measured %v)", rev, measured)
	}
	// None of checkout's assessed concepts delivered the value expected.
	e.expect(t, 200, e.tokens["admin"], "POST", "/scorecards/"+demo.ScorecardID+"/data:batch",
		batchBody(wr("ev_delivered", "checkout", "2026-Q3", 0, rev)), nil)

	var doc reportDocJSON
	e.expect(t, 200, e.tokens["admin"], "GET", demoReport, nil, &doc)
	if !doc.DataRevised {
		t.Fatal("dataRevised false after a quarterly point changed")
	}
	found := false
	for _, c := range doc.Changes {
		p, err := period.Parse(c.Period)
		if err != nil {
			t.Fatalf("change period %q: %v", c.Period, err)
		}
		// Only a quarter changed. A month line would be a year-to-date cell labelled with its month.
		if p.Grain == period.Month {
			t.Errorf("change %+v is a month line", c)
		}
		if c.MetricKey == "concepts_expected_value" && c.SubjectID == root && c.Period == "2026-Q3" && c.Was != c.Now {
			found = true
		}
	}
	if !found {
		t.Fatalf("no 2026-Q3 change for the company row among %+v", doc.Changes)
	}
}

func TestPublishedDocumentSize(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	get := func(q string, gzipped bool) (int, string) {
		req, err := http.NewRequest("GET", e.srv.URL+"/v1"+demoReport+q, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+e.tokens["admin"])
		if gzipped {
			req.Header.Set("Accept-Encoding", "gzip")
		} else {
			req.Header.Set("Accept-Encoding", "identity")
		}
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: %d", q, resp.StatusCode)
		}
		return len(body), resp.Header.Get("Content-Encoding")
	}
	n, enc := get("", false)
	t.Logf("default response: %d bytes raw", n)
	if enc != "" || n >= 900_000 {
		t.Errorf("default response: %d bytes (encoding %q), want under 900 KB raw", n, enc)
	}
	n, enc = get("?standing=true", true)
	t.Logf("standing response: %d bytes gzip-encoded", n)
	if enc != "gzip" || n >= 400_000 {
		t.Errorf("standing response: %d bytes (encoding %q), want under 400 KB gzip-encoded", n, enc)
	}
}
