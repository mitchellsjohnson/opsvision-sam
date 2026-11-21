package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
)

const demoReportDraft = demoOctReport + "/summary/draft"

func metricDraftPath(metric, p string) string { return summaryPath(metric, p) + "/draft" }

type metricDraftBody struct {
	ID       string   `json:"id"`
	Pending  bool     `json:"pending"`
	Text     *string  `json:"text"`
	Error    *string  `json:"error"`
	Warnings []string `json:"warnings"`
}

// newDemoDraftEnv is the demo API with drafts run in process by a fake
// provider; the demo admin's key is saved. The queue is nil with
// recording set: jobs are only recorded.
func newDemoDraftEnv(t *testing.T, recording bool) (*testEnv, *assistant.InProcessQueue, *recordingQueue, *draftProvider) {
	t.Helper()
	sealer := testSealer(t)
	prov := &draftProvider{text: "Webhooks lost 7h to a saturated queue (INC-2041) and a crash loop (INC-2047); 0.09 pts on Webhooks is not explained."}
	var runner *assistant.Runner
	var q *assistant.InProcessQueue
	var rq *recordingQueue
	env := newDemoEnvDeps(t, func(d *Deps) {
		d.Sealer, d.Provider = sealer, prov
		if recording {
			rq = &recordingQueue{}
			d.Queue = rq
			return
		}
		q = assistant.NewInProcessQueue(func(ctx context.Context, ref assistant.TurnRef) {
			if err := runner.Run(ctx, ref); err != nil {
				t.Errorf("Run: %v", err)
			}
		})
		d.Queue = q
	})
	var err error
	if runner, err = env.api.AssistantRunner(); err != nil {
		t.Fatal(err)
	}
	saveKey(t, env, sealer, demo.TenantID, "dev|admin")
	return env, q, rq, prov
}

func TestDraftMetricSummaryEndToEnd(t *testing.T) {
	e, q, _, prov := newDemoDraftEnv(t, false)
	admin := e.tokens["admin"]
	before, _ := storedSummary(t, e, "uptime", oct2026)
	countsBefore := listMetricSummariesAs(t, e, admin, "period=2026-M10&countsOnly=true").Counts
	auditsBefore := len(demoAudits(t, e))

	var started metricDraftBody
	e.expect(t, http.StatusAccepted, admin, "POST", metricDraftPath("uptime", "2026-M10"), nil, &started)
	if started.ID == "" || !started.Pending || started.Text != nil || started.Error != nil || started.Warnings == nil || len(started.Warnings) != 0 {
		t.Fatalf("started = %+v", started)
	}
	q.Wait()
	var got metricDraftBody
	e.expect(t, http.StatusOK, admin, "GET", metricDraftPath("uptime", "2026-M10")+"/"+started.ID, nil, &got)
	if got.Pending || got.Text == nil || *got.Text != prov.text || got.Error != nil || len(got.Warnings) != 0 {
		t.Fatalf("draft = %+v", got)
	}

	// The prompt is the metric's: rules, version, the company standing, the
	// worst services' lines, their incidents and the unexplained rest.
	req := prov.last(t)
	if !strings.Contains(req.System, "(Prompt sam-metric-summary-v1.)") || len(req.Tools) != 0 {
		t.Fatalf("system = %q, tools %d", req.System, len(req.Tools))
	}
	msg := req.Messages[0].Content[0].Text
	for _, want := range []string{
		"Metric: Uptime",
		"Period: 2026-M10 (October 2026)",
		"Gap: 13 of 21 services below 100% · worst Webhooks 99.06%",
		"- Webhooks: 99.06% Red, 0.94 pts. INC-2041 + 2 more · 0.09 pts not explained",
		"Attribution on Webhooks: 0.94 pts short of 100% · 7h 00m down",
		"- INC-2041 · ",
		"- INC-2047 · ",
		"- INC-2049 · ",
		"Not explained: 0.09 pts · 40m of the 7h 00m reported",
		"Current exec summary: " + before.Text,
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message lacks %q:\n%s", want, msg)
		}
	}

	// The draft is not the summary: nothing stored, counted or audited.
	after, _ := storedSummary(t, e, "uptime", oct2026)
	if after.Text != before.Text || after.Revision != before.Revision {
		t.Fatalf("summary changed: %+v", after)
	}
	if c := listMetricSummariesAs(t, e, admin, "period=2026-M10&countsOnly=true").Counts; c != countsBefore {
		t.Fatalf("counts %+v → %+v", countsBefore, c)
	}
	if n := len(demoAudits(t, e)); n != auditsBefore {
		t.Fatalf("audit entries %d → %d", auditsBefore, n)
	}
}

// A draft of a missing summary does not count as written: the month stays
// unpublishable.
func TestDraftOfAMissingSummaryIsNotWritten(t *testing.T) {
	e, q, _, prov := newDemoDraftEnv(t, false)
	admin := e.tokens["admin"]
	prov.text = "Six deployments were below 100%; nothing linked explains Notification Relay."
	var d metricDraftBody
	e.expect(t, http.StatusAccepted, admin, "POST", metricDraftPath("deployment_uptime", "2026-M10"), nil, &d)
	q.Wait()
	missing := listMetricSummariesAs(t, e, admin, "period=2026-M10")
	if got := listCells(missing); !slices.Equal(got, demo.SummaryMissing) {
		t.Fatalf("missing = %+v", got)
	}
	got := expectBlocked(t, e, demoOctReport)
	if !slices.ContainsFunc(got.Missing, func(m MetricSummary) bool { return m.MetricKey == "deployment_uptime" && m.Text == nil }) {
		t.Fatalf("blocked = %+v", got.Missing)
	}
}

func TestDraftMetricSummaryWarnings(t *testing.T) {
	e, q, _, prov := newDemoDraftEnv(t, false)
	prov.text = "Webhooks lost 7h (INC-2041, INC-9999)."
	var d metricDraftBody
	e.expect(t, http.StatusAccepted, e.tokens["admin"], "POST", metricDraftPath("uptime", "2026-M10"), nil, &d)
	q.Wait()
	e.expect(t, http.StatusOK, e.tokens["admin"], "GET", metricDraftPath("uptime", "2026-M10")+"/"+d.ID, nil, &d)
	if !slices.Equal(d.Warnings, []string{"INC-9999"}) {
		t.Fatalf("warnings = %q", d.Warnings)
	}
}

func TestDraftMetricSummaryIsAdminOnly(t *testing.T) {
	e, _, rq, prov := newDemoDraftEnv(t, true)
	sealer := testSealer(t)
	for _, u := range []string{"dev|contributor", "dev|viewer"} {
		saveKey(t, e, sealer, demo.TenantID, u)
	}
	for _, role := range []string{"contributor", "viewer"} {
		e.expectError(t, http.StatusForbidden, "forbidden", e.tokens[role], "POST", metricDraftPath("uptime", "2026-M10"), nil)
		e.expectError(t, http.StatusForbidden, "forbidden", e.tokens[role], "GET", metricDraftPath("uptime", "2026-M10")+"/id-0001", nil)
	}
	if rq.count() != 0 || len(prov.calls) != 0 {
		t.Fatalf("enqueued %d, provider calls %d", rq.count(), len(prov.calls))
	}
	for _, u := range []string{"dev|contributor", "dev|viewer"} {
		if ds, _ := e.store.ListDrafts(context.Background(), demo.TenantID, u); len(ds) != 0 {
			t.Fatalf("drafts stored for %s: %+v", u, ds)
		}
	}
}

func TestDraftMetricSummaryRequests(t *testing.T) {
	e, _, rq, _ := newDemoDraftEnv(t, true)
	admin := e.tokens["admin"]
	e.expectError(t, http.StatusNotFound, "not_found", admin, "POST", metricDraftPath("no_such_metric", "2026-M10"), nil)
	e.expectError(t, http.StatusBadRequest, "invalid", admin, "POST", metricDraftPath("concepts_expected_value", "2026-M10"), nil)
	e.expectError(t, http.StatusNotFound, "not_found", admin, "POST", "/scorecards/nope/metric-summaries/uptime/2026-M10/draft", nil)
	if rq.count() != 0 {
		t.Fatalf("enqueued %d", rq.count())
	}
	// A quarterly metric drafts at its quarter.
	var d metricDraftBody
	e.expect(t, http.StatusAccepted, admin, "POST", metricDraftPath("concepts_expected_value", "2026-Q3"), nil, &d)
	ds, err := e.store.ListDrafts(context.Background(), demo.TenantID, "dev|admin")
	if err != nil || len(ds) != 1 || ds[0].Kind != domain.DraftKindMetricSummary || ds[0].MetricKey != "concepts_expected_value" || ds[0].Period != "2026-Q3" {
		t.Fatalf("drafts = %+v %v", ds, err)
	}
	if rq.refs[0] != (assistant.TurnRef{Kind: assistant.KindDraft, TenantID: demo.TenantID, UserID: "dev|admin", DraftID: d.ID}) {
		t.Fatalf("enqueued %+v", rq.refs)
	}
}

// Spec §9.3: every draft read and check filters by kind.
func TestDraftKindsAreSeparate(t *testing.T) {
	e, _, rq, _ := newDemoDraftEnv(t, true)
	admin := e.tokens["admin"]
	var metric metricDraftBody
	e.expect(t, http.StatusAccepted, admin, "POST", metricDraftPath("uptime", "2026-M10"), nil, &metric)

	// One pending per metric-period, of its own kind.
	ce := e.expectError(t, http.StatusConflict, "conflict", admin, "POST", metricDraftPath("uptime", "2026-M10"), nil)
	if ce.Error.Message != msgStillDraftingExecSummary {
		t.Fatalf("message = %q", ce.Error.Message)
	}
	e.expect(t, http.StatusAccepted, admin, "POST", metricDraftPath("deployment_uptime", "2026-M10"), nil, nil)

	// A pending exec summary draft does not block the report summary draft.
	var rep reportDraftBody
	e.expect(t, http.StatusAccepted, admin, "POST", demoReportDraft, nil, &rep)
	if rq.count() != 3 {
		t.Fatalf("enqueued %d", rq.count())
	}

	// Each kind's GET sees only its own kind.
	e.expectError(t, http.StatusNotFound, "not_found", admin, "GET", demoReportDraft+"/"+metric.ID, nil)
	e.expectError(t, http.StatusNotFound, "not_found", admin, "GET", metricDraftPath("uptime", "2026-M10")+"/"+rep.ID, nil)
	e.expect(t, http.StatusOK, admin, "GET", demoReportDraft+"/"+rep.ID, nil, nil)
	e.expect(t, http.StatusOK, admin, "GET", metricDraftPath("uptime", "2026-M10")+"/"+metric.ID, nil, nil)
	// Another metric or period in the path is not this draft.
	e.expectError(t, http.StatusNotFound, "not_found", admin, "GET", metricDraftPath("deployment_uptime", "2026-M10")+"/"+metric.ID, nil)
	e.expectError(t, http.StatusNotFound, "not_found", admin, "GET", metricDraftPath("uptime", "2026-M09")+"/"+metric.ID, nil)
}

// MaxDraftsPerUser and eviction apply per kind.
func TestDraftEvictionIsPerKind(t *testing.T) {
	e, _, _, _ := newDemoDraftEnv(t, true)
	ctx := context.Background()
	put := func(id, kind, metric, p string, age time.Duration) {
		d := domain.AssistantDraft{ID: id, UserID: "dev|admin", Kind: kind, MetricKey: metric, ScorecardID: demo.ScorecardID, Period: p,
			Status: domain.AssistantStatusDone, Text: "x", CreatedAt: demoNow.Add(-age), UpdatedAt: demoNow.Add(-age)}
		if err := e.store.PutDraft(ctx, demo.TenantID, d, 0); err != nil {
			t.Fatal(err)
		}
	}
	for i := range assistant.MaxDraftsPerUser {
		put(fmt.Sprintf("r-%d", i), "", "", fmt.Sprintf("2026-M0%d", i+1), time.Duration(20-i)*time.Hour)
		put(fmt.Sprintf("m-%d", i), domain.DraftKindMetricSummary, "uptime", fmt.Sprintf("2026-M0%d", i+1), time.Duration(10-i)*time.Hour)
	}
	var d metricDraftBody
	e.expect(t, http.StatusAccepted, e.tokens["admin"], "POST", metricDraftPath("uptime", "2026-M10"), nil, &d)
	ds, err := e.store.ListDrafts(ctx, demo.TenantID, "dev|admin")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, x := range ds {
		ids = append(ids, x.ID)
	}
	want := []string{d.ID, "m-4", "m-3", "m-2", "m-1", "r-4", "r-3", "r-2", "r-1", "r-0"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("drafts kept = %v, want %v", ids, want)
	}

	// And a report draft evicts only report drafts.
	var r reportDraftBody
	e.expect(t, http.StatusAccepted, e.tokens["admin"], "POST", demoReportDraft, nil, &r)
	ds, _ = e.store.ListDrafts(ctx, demo.TenantID, "dev|admin")
	ids = ids[:0]
	for _, x := range ds {
		ids = append(ids, x.ID)
	}
	want = []string{r.ID, d.ID, "m-4", "m-3", "m-2", "m-1", "r-4", "r-3", "r-2", "r-1"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("after a report draft: %v, want %v", ids, want)
	}
}

// The draft operations are neither MCP tools nor SAM's.
func TestMetricSummaryDraftIsNoTool(t *testing.T) {
	catalog, err := Tools()
	if err != nil {
		t.Fatal(err)
	}
	for _, tl := range catalog {
		if tl.Name == "draft_metric_summary" || tl.Name == "get_metric_summary_draft" {
			t.Fatalf("%s is an MCP tool", tl.Name)
		}
	}
	for _, tl := range assistant.ToolSet(catalog) {
		if strings.Contains(tl.Name, "draft") {
			t.Fatalf("SAM can call %s", tl.Name)
		}
	}
}
