package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
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

func TestReportSummaryLength(t *testing.T) {
	e := newTestEnv(t)
	seedDelivery(t, e)
	admin := e.tokens["t1-admin"]
	long := strings.Repeat("x", 8001)
	e.expectError(t, 400, "invalid", admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": long, "expectedRevision": 0})
}
