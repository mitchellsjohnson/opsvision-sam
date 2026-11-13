package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"opsvision/internal/domain"
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
