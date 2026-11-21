package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

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

	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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

	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
					writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
	writeMissingSummaries(t, e, admin, "delivery", "2026-M10")
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
	return newDemoEnvDeps(t, nil)
}

// newDemoEnvDeps is newDemoEnv with configure applied to its dependencies.
func newDemoEnvDeps(t *testing.T, configure func(*Deps)) *testEnv {
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
	deps := Deps{
		Store: st, Objects: objs,
		Now:   func() time.Time { return demoNow },
		NewID: func() string { return fmt.Sprintf("id-%04d", n.Add(1)) },
	}
	if configure != nil {
		configure(&deps)
	}
	s := NewServer(deps)
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
	if obj.SchemaVersion != 3 || len(obj.Standing) == 0 {
		t.Fatalf("stored schemaVersion %d with %d bytes of standing; want 3 and a standing view", obj.SchemaVersion, len(obj.Standing))
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

// ---- the publish gate (spec §9.7) ------------------------------------------------

const demoOctReport = "/scorecards/" + demo.ScorecardID + "/reports/2026-M10"

// writeMissingSummaries writes, as token's admin, an exec summary for every
// required metric of month that has none, so the month can be published.
func writeMissingSummaries(t *testing.T, e *testEnv, token, sc, month string) []string {
	t.Helper()
	var l MetricSummaryList
	e.expect(t, 200, token, "GET", "/scorecards/"+sc+"/metric-summaries?period="+month+"&state=missing", nil, &l)
	var keys []string
	for _, it := range l.Items {
		e.expect(t, 200, token, "PUT", "/scorecards/"+sc+"/metric-summaries/"+it.MetricKey+"/"+string(it.Period),
			summaryBody("Written for the test: "+it.MetricName+".", []rcaLink{{"title": "Postmortem", "url": "https://docs.example/" + it.MetricKey}}, 0), nil)
		keys = append(keys, it.MetricKey)
	}
	return keys
}

type publishBlockedJSON struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Missing []MetricSummary `json:"missing"`
	Stale   *int            `json:"stale"`
}

func expectBlocked(t *testing.T, e *testEnv, path string) publishBlockedJSON {
	t.Helper()
	status, raw := e.call(t, e.tokens["admin"], "POST", path+"/publish", map[string]any{})
	var got publishBlockedJSON
	if err := json.Unmarshal(raw, &got); err != nil || status != http.StatusConflict || got.Error.Code != "summaries_missing" {
		t.Fatalf("publish %s: %d %s, want 409 summaries_missing", path, status, raw)
	}
	return got
}

func missingCells(b publishBlockedJSON) []demo.SummaryCell {
	return listCells(MetricSummaryList{Items: b.Missing})
}

func demoRevisions(t *testing.T, e *testEnv, month string) []domain.ReportRevision {
	t.Helper()
	all, err := e.store.ListReportRevisions(context.Background(), demo.TenantID, demo.ScorecardID)
	if err != nil {
		t.Fatal(err)
	}
	var out []domain.ReportRevision
	for _, r := range all {
		if r.Period == month {
			out = append(out, r)
		}
	}
	return out
}

func storedDocument(t *testing.T, e *testEnv, month string, rev int) (report.Document, []byte) {
	t.Helper()
	rc, _, err := e.objs.Get(context.Background(), report.ObjectKey(demo.TenantID, demo.ScorecardID, month, rev))
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	raw, _ := io.ReadAll(rc)
	var doc report.Document
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc, raw
}

// cellsWithSummary counts the cells of a stored view that carry summary
// state, which published views never do.
func cellsWithSummary(t *testing.T, raw json.RawMessage) int {
	t.Helper()
	var v struct {
		Rows []struct {
			Cells []map[string]json.RawMessage `json:"cells"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range v.Rows {
		for _, c := range r.Cells {
			if _, ok := c["summary"]; ok {
				n++
			}
		}
	}
	return n
}

func TestPublishGateBlocksMissingSummaries(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	auditsBefore := len(demoAudits(t, e))

	got := expectBlocked(t, e, demoOctReport)
	if got.Error.Message != "3 exec summaries are missing for Oct 2026." {
		t.Errorf("message = %q", got.Error.Message)
	}
	if cells := missingCells(got); !slices.Equal(cells, demo.SummaryMissing) {
		t.Errorf("missing = %+v, want %+v", cells, demo.SummaryMissing)
	}
	for _, m := range got.Missing {
		if m.State != SummaryStateMissing || m.Requirement != MetricSummaryRequirementRequired || m.Standing.Headline == "" ||
			m.RequirementReason == nil || *m.RequirementReason == "" || m.Text != nil {
			t.Errorf("missing %s = %+v", m.MetricKey, m)
		}
	}
	if got.Stale == nil || *got.Stale != 1 {
		t.Errorf("stale = %v, want 1", got.Stale)
	}
	// Nothing is stored or audited.
	if revs := demoRevisions(t, e, "2026-M10"); len(revs) != 0 {
		t.Fatalf("revisions stored: %+v", revs)
	}
	if _, _, err := e.objs.Get(context.Background(), report.ObjectKey(demo.TenantID, demo.ScorecardID, "2026-M10", 1)); err == nil {
		t.Fatal("a snapshot was stored")
	}
	if n := len(demoAudits(t, e)); n != auditsBefore {
		t.Fatalf("audit entries %d → %d", auditsBefore, n)
	}

	// Once an admin writes the three, the month publishes.
	if keys := writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10"); len(keys) != 3 {
		t.Fatalf("wrote %v", keys)
	}
	var pub PublishReportResponse
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, &pub)
	if pub.Revision != 1 {
		t.Fatalf("publish = %+v", pub)
	}

	doc, _ := storedDocument(t, e, "2026-M10", 1)
	if doc.SchemaVersion != 3 {
		t.Fatalf("schemaVersion = %d", doc.SchemaVersion)
	}
	var all MetricSummaryList
	e.expect(t, 200, admin, "GET", demoSummaries+"?period=2026-M10&state=all&full=true", nil, &all)
	frozen := map[string]report.SummarySnapshot{}
	for _, s := range doc.Summaries {
		frozen[s.MetricKey+"|"+s.Period] = s
	}
	required := 0
	for _, it := range all.Items {
		s, ok := frozen[it.MetricKey+"|"+string(it.Period)]
		if it.Text == nil {
			if ok {
				t.Errorf("%s has a frozen summary but no live one", it.MetricKey)
			}
			if it.Requirement == MetricSummaryRequirementRequired {
				t.Errorf("required %s has no summary", it.MetricKey)
			}
			continue
		}
		if it.Requirement == MetricSummaryRequirementRequired {
			required++
		}
		if !ok || s.Text != *it.Text || len(s.Links) != it.LinksTotal || s.Requirement != string(it.Requirement) ||
			s.Standing.Headline != it.Standing.Headline || s.AuthorName == "" || s.Revision == 0 {
			t.Errorf("%s frozen = %+v, live %+v", it.MetricKey, s, it)
		}
	}
	if required != len(demo.SummaryWritten)+len(demo.SummaryStale)+len(demo.SummaryMissing) || len(doc.Summaries) != required {
		t.Errorf("frozen %d summaries, %d required", len(doc.Summaries), required)
	}
	if up := frozen["uptime|2026-M10"]; len(up.Links) != 4 || len(up.Evidence) != 3 || up.Evidence[0].Key != "INC-2041" {
		t.Errorf("uptime frozen = %+v", up)
	}
	if n := cellsWithSummary(t, doc.View) + cellsWithSummary(t, doc.Standing); n != 0 {
		t.Errorf("%d stored cells carry summary state", n)
	}
}

// The check runs inside the publish request: a summary deleted after the
// Report read the counts is caught, and nothing is stored.
func TestPublishGateCatchesASummaryDeletedMeanwhile(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	var counts MetricSummaryList
	e.expect(t, 200, admin, "GET", demoSummaries+"?period=2026-M10&countsOnly=true", nil, &counts)
	if counts.Counts.Missing != 0 {
		t.Fatalf("counts = %+v", counts.Counts)
	}
	r, _ := storedSummary(t, e, "security_training", oct2026)
	e.expect(t, 204, admin, "DELETE", summaryPath("security_training", "2026-M10")+fmt.Sprintf("?expectedRevision=%d", r.Revision), nil, nil)

	got := expectBlocked(t, e, demoOctReport)
	if cells := missingCells(got); len(cells) != 1 || cells[0].MetricKey != "security_training" ||
		got.Error.Message != "1 exec summary is missing for Oct 2026." {
		t.Fatalf("blocked = %+v %q", cells, got.Error.Message)
	}
	if revs := demoRevisions(t, e, "2026-M10"); len(revs) != 0 {
		t.Fatalf("revisions stored: %+v", revs)
	}
}

// Republishing is gated the same way; the earlier revision keeps its copy.
func TestPublishGateRepublish(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, nil)

	r, _ := storedSummary(t, e, "deployment_uptime", oct2026)
	e.expect(t, 204, admin, "DELETE", summaryPath("deployment_uptime", "2026-M10")+fmt.Sprintf("?expectedRevision=%d", r.Revision), nil, nil)
	got := expectBlocked(t, e, demoOctReport)
	if cells := missingCells(got); len(cells) != 1 || cells[0].MetricKey != "deployment_uptime" {
		t.Fatalf("blocked = %+v", cells)
	}
	if revs := demoRevisions(t, e, "2026-M10"); len(revs) != 1 {
		t.Fatalf("revisions = %+v, want only revision 1", revs)
	}
	doc, _ := storedDocument(t, e, "2026-M10", 1)
	if !slices.ContainsFunc(doc.Summaries, func(s report.SummarySnapshot) bool { return s.MetricKey == "deployment_uptime" }) {
		t.Fatal("revision 1 lost its frozen copy")
	}

	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	var pub PublishReportResponse
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, &pub)
	if pub.Revision != 2 {
		t.Fatalf("republish = %+v", pub)
	}
}

// MCP's publish_report gets the same 409, with the list in its result.
func TestPublishGateOverMCP(t *testing.T) {
	e := newDemoEnv(t)
	res := mcpToolCall(t, e, e.tokens["admin"], "publish_report", map[string]any{"sc": demo.ScorecardID, "period": "2026-M10", "body": map[string]any{}})
	if !res.IsError {
		t.Fatalf("publish_report = %s", res.Text)
	}
	for _, want := range []string{"HTTP 409 summaries_missing: 3 exec summaries are missing for Oct 2026.",
		"- missing[0]: Weighted support backlog (support_backlog, 2026-M10)", "(deployment_uptime, 2026-M10)", "(security_training, 2026-M10)",
		"Required: Below 100% (91%)."} {
		if !strings.Contains(res.Text, want) {
			t.Errorf("tool result lacks %s: %.400s", want, res.Text)
		}
	}
	if revs := demoRevisions(t, e, "2026-M10"); len(revs) != 0 {
		t.Fatalf("revisions stored: %+v", revs)
	}
}

// A quarterly metric's summary gates the month that closes its quarter
// (Sep for 2026-Q3), not the months after it.
func TestPublishGateQuarterlyMetric(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	q3 := period.Period{Grain: period.Quarter, FY: 2026, Index: 3}
	r, ok := storedSummary(t, e, "concepts_expected_value", q3)
	if !ok {
		t.Fatal("the demo has no 2026-Q3 summary for concepts_expected_value")
	}
	e.expect(t, 204, admin, "DELETE", summaryPath("concepts_expected_value", "2026-Q3")+fmt.Sprintf("?expectedRevision=%d", r.Revision), nil, nil)

	got := expectBlocked(t, e, demoReport)
	if cells := missingCells(got); len(cells) != 1 || cells[0] != (demo.SummaryCell{MetricKey: "concepts_expected_value", Period: q3}) {
		t.Fatalf("Sep blocked by %+v", cells)
	}
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, nil)
}

// Review Focus 5: publishing with every metric summarized stays inside the
// spec's 10 s.
func TestPublishWithEverySummary(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	var all MetricSummaryList
	e.expect(t, 200, admin, "GET", demoSummaries+"?period=2026-M10&state=optional", nil, &all)
	if len(all.Items) == 0 {
		t.Fatal("no optional metric to summarize")
	}
	for _, it := range all.Items {
		e.expect(t, 200, admin, "PUT", summaryPath(it.MetricKey, string(it.Period)), summaryBody("Perfect this month.", nil, 0), nil)
	}
	start := time.Now()
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, nil)
	took := time.Since(start)
	t.Logf("publish with every metric summarized: %v", took)
	if took > 10*time.Second {
		t.Errorf("publish took %v, want under 10 s", took)
	}
	doc, _ := storedDocument(t, e, "2026-M10", 1)
	optional := 0
	for _, s := range doc.Summaries {
		if s.Requirement == report.RequirementOptional {
			optional++
		}
	}
	if optional != len(all.Items) {
		t.Errorf("%d optional summaries frozen, want %d", optional, len(all.Items))
	}
}

// Review Focus 3: a month with a missing required summary, sent past the
// gate, is refused when the snapshot is validated, so no stored revision
// holds a placeholder.
func TestPublishBypassingTheGateIsRefused(t *testing.T) {
	e := newDemoEnv(t)
	ctx := context.Background()
	tenant, err := e.store.GetTenant(ctx, demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	m, err := e.store.GetMembership(ctx, demo.TenantID, "dev|admin")
	if err != nil {
		t.Fatal(err)
	}
	actx := withMember(tenant, m)
	p, _ := auth.FromContext(actx)
	_, err = e.api.publishMonth(actx, p, demo.ScorecardID, oct2026, "", false)
	if !errors.Is(err, report.ErrSummaryMissing) || !strings.Contains(err.Error(), "a required exec summary is missing") {
		t.Fatalf("publish past the gate = %v", err)
	}
	if revs := demoRevisions(t, e, "2026-M10"); len(revs) != 0 {
		t.Fatalf("revisions stored: %+v", revs)
	}
	if _, _, err := e.objs.Get(ctx, report.ObjectKey(demo.TenantID, demo.ScorecardID, "2026-M10", 1)); err == nil {
		t.Fatal("a snapshot was stored")
	}
}

// ---- frozen summaries (spec §10.9) -------------------------------------------------

func TestFrozenSummaries(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	writeMissingSummaries(t, e, admin, demo.ScorecardID, "2026-M10")
	e.expect(t, 200, admin, "POST", demoOctReport+"/publish", map[string]any{}, nil)
	doc, _ := storedDocument(t, e, "2026-M10", 1)
	was, _ := storedSummary(t, e, "uptime", oct2026)

	rev1 := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1&full=true")
	if len(rev1.Items) != len(doc.Summaries) || rev1.Counts.Written != len(doc.Summaries) || rev1.Counts.Missing != 0 ||
		rev1.Counts.Required != len(demo.SummaryWritten)+len(demo.SummaryStale)+len(demo.SummaryMissing) {
		t.Fatalf("revision 1: %d items, counts %+v; %d frozen", len(rev1.Items), rev1.Counts, len(doc.Summaries))
	}
	byKey := map[string]MetricSummary{}
	for _, it := range rev1.Items {
		byKey[it.MetricKey] = it
		if it.State != SummaryStateWritten || it.Stale || len(it.StaleReasons) != 0 || it.Text == nil {
			t.Errorf("frozen %s = %+v", it.MetricKey, it)
		}
	}
	if up := byKey["uptime"]; *up.Text != was.Text || len(up.Links) != 4 || up.LinksTotal != 4 || up.Revision == nil || *up.Revision != was.Revision ||
		up.Evidence == nil || (*up.Evidence)[0].Key != "INC-2041" {
		t.Errorf("frozen uptime = %+v", up)
	}

	// Editing the live summary leaves the published copy as it was.
	e.expect(t, 200, admin, "PUT", summaryPath("uptime", "2026-M10"), summaryBody("Rewritten after publication.", nil, was.Revision), nil)
	again := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1&full=true")
	for _, it := range again.Items {
		if it.MetricKey == "uptime" && (*it.Text != was.Text || len(it.Links) != 4) {
			t.Errorf("revision 1 uptime changed: %+v", it)
		}
	}
	if live := getSummary(t, e, admin, "uptime", "2026-M10"); *live.Text != "Rewritten after publication." || *live.Revision != was.Revision+1 {
		t.Errorf("live uptime = %+v", live)
	}
	var one MetricSummary
	e.expect(t, 200, admin, "GET", summaryPath("uptime", "2026-M10")+"?revision=1", nil, &one)
	if *one.Text != was.Text || len(one.Links) != 4 || one.State != SummaryStateWritten {
		t.Errorf("getMetricSummary revision 1 = %+v", one)
	}

	// Without full: excerpts and the first 3 links; the state filter applies.
	short := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1")
	for _, it := range short.Items {
		if it.MetricKey == "uptime" && (len(it.Links) != 3 || it.LinksTotal != 4 || utf8.RuneCountInString(*it.Text) > 64) {
			t.Errorf("short uptime = %+v", it)
		}
	}
	if len(short.Items) != len(doc.Summaries) {
		t.Errorf("a revision lists every frozen summary by default: %d", len(short.Items))
	}
	if m := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1&state=missing"); len(m.Items) != 0 || m.Counts.Written != len(doc.Summaries) {
		t.Errorf("missing in a revision = %+v", m)
	}
	if c := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1&countsOnly=true"); len(c.Items) != 0 || c.Counts != rev1.Counts {
		t.Errorf("countsOnly = %+v", c)
	}
	page := listMetricSummariesAs(t, e, admin, "period=2026-M10&revision=1&full=true&state=all")
	if page.NextCursor != nil {
		t.Errorf("one page holds %d: cursor %v", len(page.Items), page.NextCursor)
	}

	// Readers of the company cell read them; a viewer scoped below it reads none.
	if c := listMetricSummariesAs(t, e, e.tokens["contributor"], "period=2026-M10&revision=1"); len(c.Items) != len(doc.Summaries) || c.Items[0].CanEdit {
		t.Errorf("contributor = %d items", len(c.Items))
	}
	scoped := scopedViewer(t, e, "mobile")
	if s := listMetricSummariesAs(t, e, scoped, "period=2026-M10&revision=1"); len(s.Items) != 0 || s.Counts.Required != 0 || s.Counts.Written != 0 {
		t.Errorf("scoped viewer = %+v", s)
	}
	e.expectError(t, 403, "forbidden", scoped, "GET", summaryPath("uptime", "2026-M10")+"?revision=1", nil)

	e.expectError(t, 404, "not_found", admin, "GET", demoSummaries+"?period=2026-M10&revision=2", nil)
	e.expectError(t, 404, "not_found", admin, "GET", summaryPath("uptime", "2026-M10")+"?revision=2", nil)
	e.expectError(t, 404, "not_found", admin, "GET", summaryPath("concepts_expected_value", "2026-Q4")+"?revision=1", nil)
	e.expectError(t, 400, "invalid", admin, "GET", demoSummaries+"?period=2026-M10&revision=0", nil)
}

// A revision published before summaries were required has none.
func TestFrozenSummariesOfAnEarlierVersion(t *testing.T) {
	e := newDemoEnv(t)
	e.publishDemo(t)
	ctx := context.Background()
	key := report.ObjectKey(demo.TenantID, demo.ScorecardID, "2026-M09", 1)
	_, raw := storedDocument(t, e, "2026-M09", 1)
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	if _, ok := obj["summaries"]; !ok {
		t.Fatal("the Sep snapshot has no summaries to remove")
	}
	delete(obj, "summaries")
	obj["schemaVersion"] = json.RawMessage("2")
	v2, _ := json.Marshal(obj)
	if err := e.objs.Put(ctx, key, "application/json", v2); err != nil {
		t.Fatal(err)
	}
	l := listMetricSummariesAs(t, e, e.tokens["admin"], "period=2026-M09&revision=1&full=true")
	if l.Items == nil || len(l.Items) != 0 || l.Counts.Written != 0 || l.Counts.Required != 0 {
		t.Fatalf("v2 revision = %+v", l)
	}
	_, body := e.call(t, e.tokens["admin"], "GET", demoSummaries+"?period=2026-M09&revision=1", nil)
	if !strings.Contains(string(body), `"items":[]`) {
		t.Fatalf("items must be [] for a v2 revision: %s", body)
	}
	e.expectError(t, 404, "not_found", e.tokens["admin"], "GET", summaryPath("uptime", "2026-M09")+"?revision=1", nil)
	// The v2 revision still reads with its standing.
	var doc reportDocJSON
	e.expect(t, 200, e.tokens["admin"], "GET", demoReport+"?standing=true", nil, &doc)
	if doc.Standing == nil {
		t.Fatal("a v2 revision lost its standing")
	}
}
