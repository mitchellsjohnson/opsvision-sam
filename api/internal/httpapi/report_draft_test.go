package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/auth"
	"opsvision/internal/domain"
)

const draftPath = "/scorecards/delivery/reports/2026-M10/summary/draft"

type reportDraftBody struct {
	ID        string              `json:"id"`
	Pending   bool                `json:"pending"`
	Text      *string             `json:"text"`
	Error     *string             `json:"error"`
	CreatedAt time.Time           `json:"createdAt"`
	Usage     *assistantUsageBody `json:"usage"`
}

// draftProvider answers every draft with text and records the requests.
type draftProvider struct {
	mu    sync.Mutex
	calls []assistant.MessagesRequest
	text  string
}

func (p *draftProvider) Messages(_ context.Context, _ string, req assistant.MessagesRequest) (assistant.MessagesResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, req)
	return assistant.MessagesResponse{Content: []assistant.Block{{Type: "text", Text: p.text}}, StopReason: "end_turn",
		Usage: assistant.Usage{InputTokens: 700, OutputTokens: 60}}, nil
}

func (p *draftProvider) last(t *testing.T) assistant.MessagesRequest {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.calls) == 0 {
		t.Fatal("the provider was never called")
	}
	return p.calls[len(p.calls)-1]
}

// newDraftEnv is a test API whose drafts run in process with a fake
// provider, over the delivery scorecard with September and October data.
// t1's admin and viewer have keys saved.
func newDraftEnv(t *testing.T) (*testEnv, *assistant.InProcessQueue, *draftProvider) {
	t.Helper()
	sealer := testSealer(t)
	prov := &draftProvider{text: "October was mixed. On-time delivery slipped to 84.3% (Yellow)."}
	var runner *assistant.Runner
	q := assistant.NewInProcessQueue(func(ctx context.Context, ref assistant.TurnRef) {
		if err := runner.Run(ctx, ref); err != nil {
			t.Errorf("Run: %v", err)
		}
	})
	env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = prov; d.Queue = q })
	var err error
	if runner, err = env.api.AssistantRunner(); err != nil {
		t.Fatal(err)
	}
	seedDelivery(t, env)
	saveSplit(t, env)
	env.expect(t, 200, env.tokens["t1-admin"], "POST", "/scorecards/delivery/data:batch", batchBody(
		wr("on_time", "prod-1", "2026-M09", 230, 0), wr("committed", "prod-1", "2026-M09", 240, 0),
		wr("on_time", "prod-2", "2026-M09", 270, 0), wr("committed", "prod-2", "2026-M09", 282, 0),
	), nil)
	saveKey(t, env, sealer, "t1", "u-t1-admin")
	saveKey(t, env, sealer, "t1", "u-t1-viewer")
	return env, q, prov
}

func TestDraftReportSummaryIsAdminOnly(t *testing.T) {
	env, q, prov := newDraftEnv(t)
	saveKey(t, env, testSealer(t), "t1", "u-t1-contributor")
	for _, role := range []string{"t1-viewer", "t1-contributor"} {
		env.expectError(t, http.StatusForbidden, "forbidden", env.tokens[role], "POST", draftPath, nil)
		env.expectError(t, http.StatusForbidden, "forbidden", env.tokens[role], "GET", draftPath+"/id-0001", nil)
	}
	env.expectError(t, http.StatusUnauthorized, "unauthorized", "", "POST", draftPath, nil)
	env.expectError(t, http.StatusForbidden, "forbidden", env.tokens["operator"], "POST", draftPath, nil)
	q.Wait()
	if len(prov.calls) != 0 {
		t.Fatalf("a non-admin started %d drafts", len(prov.calls))
	}
	drafts, err := env.store.ListDrafts(context.Background(), "t1", "u-t1-viewer")
	if err != nil || len(drafts) != 0 {
		t.Fatalf("drafts stored for a viewer: %+v %v", drafts, err)
	}
}

func TestDraftReportSummaryEndToEnd(t *testing.T) {
	env, q, prov := newDraftEnv(t)
	admin := env.tokens["t1-admin"]
	env.expect(t, 200, admin, "PUT", "/scorecards/delivery/reports/2026-M10/summary",
		map[string]any{"text": "Shipped on time.", "expectedRevision": 0}, nil)
	auditsBefore := len(env.audits(t, "t1"))

	var started reportDraftBody
	env.expect(t, http.StatusAccepted, admin, "POST", draftPath, nil, &started)
	if started.ID == "" || !started.Pending || started.Text != nil || started.Error != nil || !started.CreatedAt.Equal(testNow) || started.Usage != nil {
		t.Fatalf("started = %+v", started)
	}
	q.Wait()

	var got reportDraftBody
	env.expect(t, http.StatusOK, admin, "GET", draftPath+"/"+started.ID, nil, &got)
	if got.Pending || got.Error != nil || got.Text == nil || *got.Text != prov.text || got.ID != started.ID {
		t.Fatalf("draft = %+v", got)
	}
	if got.Usage == nil || *got.Usage != (assistantUsageBody{Model: domain.DefaultAssistantModel, InputTokens: 700, OutputTokens: 60}) {
		t.Fatalf("usage = %+v", got.Usage)
	}

	// The draft is not the summary, and nothing was audited.
	var sum struct {
		Text     string `json:"text"`
		Revision int    `json:"revision"`
	}
	env.expect(t, http.StatusOK, admin, "GET", "/scorecards/delivery/reports/2026-M10/summary", nil, &sum)
	if sum.Text != "Shipped on time." || sum.Revision != 1 {
		t.Fatalf("summary changed: %+v", sum)
	}
	if n := len(env.audits(t, "t1")); n != auditsBefore {
		t.Fatalf("audit entries %d → %d", auditsBefore, n)
	}

	// The prompt carries the company report: its facts, what needs
	// attention, and each category's values.
	req := prov.last(t)
	if len(req.Tools) != 0 || !strings.Contains(req.System, assistant.DraftPromptVersion) {
		t.Fatalf("request tools %d, system %q", len(req.Tools), req.System)
	}
	data := req.Messages[0].Content[0].Text
	for _, want := range []string{
		"Scorecard: Scorecard delivery",
		"Month: 2026-M10 (October 2026)",
		"Scope: the whole company (Tenant t1)",
		"Months shown, oldest first: 2026-M05, 2026-M06, 2026-M07, 2026-M08, 2026-M09, 2026-M10",
		"- not reported: ",
		"Needs attention, most urgent first:\n- On-time delivery (Flow): Yellow in 2026-M10.",
		"2026-M09 95.8% Green; 2026-M10 84.3% Yellow.",
		"Values by category, at company scope:\nFlow\n- On-time delivery: Yellow in 2026-M10.",
		"- Open defects: not reported in 2026-M10.",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("report data lacks %q:\n%s", want, data)
		}
	}
	for _, not := range []string{"Segment A", "Product One"} {
		if strings.Contains(data, not) {
			t.Errorf("report data names %q, which is not company scope:\n%s", not, data)
		}
	}
}

func TestDraftReportSummaryIsCompanyScopeOnly(t *testing.T) {
	env, q, prov := newDraftEnv(t)
	admin := env.tokens["t1-admin"]
	e := env.expectError(t, http.StatusBadRequest, "invalid", admin, "POST", draftPath, map[string]any{"scope": "seg-a"})
	if len(e.Error.Details) != 1 || e.Error.Details[0].Path != "scope" {
		t.Fatalf("details = %+v", e.Error.Details)
	}
	q.Wait()
	if len(prov.calls) != 0 {
		t.Fatal("a segment draft ran")
	}
	// Empty is the company, as is no body.
	var d reportDraftBody
	env.expect(t, http.StatusAccepted, admin, "POST", draftPath, map[string]any{"scope": ""}, &d)
	q.Wait()
	if !strings.Contains(prov.last(t).Messages[0].Content[0].Text, "Scope: the whole company") {
		t.Fatal("the draft did not read company scope")
	}
}

func TestDraftReportSummaryPreconditions(t *testing.T) {
	t.Run("no key", func(t *testing.T) {
		env, _, _ := newDraftEnv(t)
		if err := env.store.DeleteCredential(context.Background(), "t1", "u-t1-admin"); err != nil {
			t.Fatal(err)
		}
		e := env.expectError(t, http.StatusConflict, "conflict", env.tokens["t1-admin"], "POST", draftPath, nil)
		if e.Error.Message != "Add your Claude API key in My settings → Ask SAM to draft with SAM." {
			t.Fatalf("message = %q", e.Error.Message)
		}
		if ds, _ := env.store.ListDrafts(context.Background(), "t1", "u-t1-admin"); len(ds) != 0 {
			t.Fatalf("drafts stored: %+v", ds)
		}
	})
	t.Run("turned off", func(t *testing.T) {
		env, _, _ := newDraftEnv(t)
		admin := env.tokens["t1-admin"]
		env.expect(t, http.StatusOK, admin, "PUT", "/assistant/settings", map[string]any{"enabled": false, "model": "claude-haiku-5-5"}, nil)
		e := env.expectError(t, http.StatusConflict, "conflict", admin, "POST", draftPath, nil)
		if e.Error.Message != "Ask SAM is turned off for this organization." {
			t.Fatalf("message = %q", e.Error.Message)
		}
	})
	t.Run("no queue", func(t *testing.T) {
		sealer := testSealer(t)
		env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = &fakeProvider{} })
		seedDelivery(t, env)
		saveKey(t, env, sealer, "t1", "u-t1-admin")
		env.expectError(t, http.StatusServiceUnavailable, "assistant_unavailable", env.tokens["t1-admin"], "POST", draftPath, nil)
		if ds, _ := env.store.ListDrafts(context.Background(), "t1", "u-t1-admin"); len(ds) != 0 {
			t.Fatalf("drafts stored without a queue: %+v", ds)
		}
	})
	t.Run("enqueue fails", func(t *testing.T) {
		sealer := testSealer(t)
		q := &recordingQueue{err: errors.New("queue down")}
		env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = &fakeProvider{}; d.Queue = q })
		seedDelivery(t, env)
		saveKey(t, env, sealer, "t1", "u-t1-admin")
		admin := env.tokens["t1-admin"]
		e := env.expectError(t, http.StatusServiceUnavailable, "assistant_unavailable", admin, "POST", draftPath, nil)
		if e.Error.Message != msgCouldNotStart {
			t.Fatalf("message = %q", e.Error.Message)
		}
		ds, err := env.store.ListDrafts(context.Background(), "t1", "u-t1-admin")
		if err != nil || len(ds) != 1 || ds[0].Status != domain.AssistantStatusError || ds[0].Error != msgCouldNotStart {
			t.Fatalf("drafts = %+v %v, want the draft marked failed", ds, err)
		}
		// The failed draft does not block the next one.
		q.err = nil
		var d reportDraftBody
		env.expect(t, http.StatusAccepted, admin, "POST", draftPath, nil, &d)
		if q.count() != 1 || q.refs[0] != (assistant.TurnRef{Kind: assistant.KindDraft, TenantID: "t1", UserID: "u-t1-admin", DraftID: d.ID}) {
			t.Fatalf("enqueued = %+v", q.refs)
		}
	})
	t.Run("bad month or scorecard", func(t *testing.T) {
		env, _, _ := newDraftEnv(t)
		admin := env.tokens["t1-admin"]
		env.expectError(t, http.StatusBadRequest, "invalid", admin, "POST", "/scorecards/delivery/reports/2026-Q3/summary/draft", nil)
		env.expectError(t, http.StatusNotFound, "not_found", admin, "POST", "/scorecards/nope/reports/2026-M10/summary/draft", nil)
		env.expectError(t, http.StatusNotFound, "not_found", env.tokens["t2-admin"], "POST", draftPath, nil)
	})
}

func TestDraftReportSummaryOnePendingPerMonth(t *testing.T) {
	sealer := testSealer(t)
	q := &recordingQueue{}
	env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = &fakeProvider{}; d.Queue = q })
	seedDelivery(t, env)
	saveKey(t, env, sealer, "t1", "u-t1-admin")
	admin := env.tokens["t1-admin"]

	env.expect(t, http.StatusAccepted, admin, "POST", draftPath, nil, nil)
	e := env.expectError(t, http.StatusConflict, "conflict", admin, "POST", draftPath, nil)
	if e.Error.Message != msgStillDrafting || q.count() != 1 {
		t.Fatalf("message %q, enqueued %d", e.Error.Message, q.count())
	}
	// Another month is fine.
	env.expect(t, http.StatusAccepted, admin, "POST", "/scorecards/delivery/reports/2026-M09/summary/draft", nil, nil)
	if q.count() != 2 {
		t.Fatalf("enqueued %d", q.count())
	}
}

// putDraft stores a draft of the admin's directly.
func putDraft(t *testing.T, e *testEnv, d domain.AssistantDraft) {
	t.Helper()
	if d.UserID == "" {
		d.UserID = "u-t1-admin"
	}
	if d.ScorecardID == "" {
		d.ScorecardID, d.Period = "delivery", "2026-M10"
	}
	if d.UpdatedAt.IsZero() {
		d.UpdatedAt = d.CreatedAt
	}
	if err := e.store.PutDraft(context.Background(), "t1", d, 0); err != nil {
		t.Fatal(err)
	}
}

func TestReportSummaryDraftsArePrivateAndExpire(t *testing.T) {
	env, _, _ := newDraftEnv(t)
	admin := env.tokens["t1-admin"]
	putDraft(t, env, domain.AssistantDraft{ID: "d-fresh", Status: domain.AssistantStatusDone, Text: "Fresh.", CreatedAt: testNow.Add(-23 * time.Hour)})
	putDraft(t, env, domain.AssistantDraft{ID: "d-old", Status: domain.AssistantStatusDone, Text: "Old.", CreatedAt: testNow.Add(-assistant.DraftTTL)})
	putDraft(t, env, domain.AssistantDraft{ID: "d-stuck", Status: domain.AssistantStatusPending, CreatedAt: testNow.Add(-assistant.StalePending)})

	var got reportDraftBody
	env.expect(t, http.StatusOK, admin, "GET", draftPath+"/d-fresh", nil, &got)
	if got.Pending || got.Text == nil || *got.Text != "Fresh." {
		t.Fatalf("fresh draft = %+v", got)
	}
	env.expectError(t, http.StatusNotFound, "not_found", admin, "GET", draftPath+"/d-old", nil)
	var stuck reportDraftBody
	env.expect(t, http.StatusOK, admin, "GET", draftPath+"/d-stuck", nil, &stuck)
	if stuck.Pending || stuck.Error == nil || *stuck.Error != "SAM took too long. Try again." || stuck.Text != nil {
		t.Fatalf("stuck draft = %+v", stuck)
	}
	// A stuck draft does not block a new one.
	env.expect(t, http.StatusAccepted, admin, "POST", draftPath, nil, nil)

	// Another scorecard or month in the path is not this draft.
	env.expectError(t, http.StatusNotFound, "not_found", admin, "GET", "/scorecards/delivery/reports/2026-M09/summary/draft/d-fresh", nil)
	seedScorecard(t, env, "other")
	env.expectError(t, http.StatusNotFound, "not_found", admin, "GET", "/scorecards/other/reports/2026-M10/summary/draft/d-fresh", nil)

	// Another admin of the tenant cannot read it.
	if err := env.store.PutMembership(context.Background(), "t1", domain.Membership{
		UserID: "u-t1-admin2", Email: "u-t1-admin2@example.test", Name: "Second Admin", Role: domain.RoleAdmin,
		Scope: domain.Scope{OrgUnitIDs: []string{}, MetricKeys: []string{}}, CreatedAt: testNow,
	}); err != nil {
		t.Fatal(err)
	}
	other, err := auth.IssueDevToken(testSecret, "u-t1-admin2", "u-t1-admin2@example.test", "Second Admin", "org_t1", false)
	if err != nil {
		t.Fatal(err)
	}
	env.expectError(t, http.StatusNotFound, "not_found", other, "GET", draftPath+"/d-fresh", nil)
	env.expectError(t, http.StatusNotFound, "not_found", env.tokens["t2-admin"], "GET", draftPath+"/d-fresh", nil)
}

func TestReportSummaryDraftsAreCapped(t *testing.T) {
	sealer := testSealer(t)
	q := &recordingQueue{}
	env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = &fakeProvider{}; d.Queue = q })
	seedDelivery(t, env)
	saveKey(t, env, sealer, "t1", "u-t1-admin")
	putDraft(t, env, domain.AssistantDraft{ID: "d-expired", Status: domain.AssistantStatusDone, Text: "x", CreatedAt: testNow.Add(-25 * time.Hour)})
	for i := range assistant.MaxDraftsPerUser {
		putDraft(t, env, domain.AssistantDraft{
			ID: fmt.Sprintf("d-%d", i), Status: domain.AssistantStatusDone, Text: "x",
			ScorecardID: "delivery", Period: fmt.Sprintf("2026-M0%d", i+1), CreatedAt: testNow.Add(-time.Duration(10-i) * time.Hour),
		})
	}
	var d reportDraftBody
	env.expect(t, http.StatusAccepted, env.tokens["t1-admin"], "POST", draftPath, nil, &d)
	ds, err := env.store.ListDrafts(context.Background(), "t1", "u-t1-admin")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, x := range ds {
		ids = append(ids, x.ID)
	}
	want := []string{d.ID, "d-4", "d-3", "d-2", "d-1"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("drafts kept = %v, want %v", ids, want)
	}
}

// The needs-attention list follows the report page: the worst status first
// (furthest past its band first), then statuses that dropped since last
// month, then the rest, at most three; a metric with no company row takes
// the worst of its children.
func TestDraftReportNeedsAttentionOrder(t *testing.T) {
	bands := &StatusRule{Type: Bands, Bands: &[]Band{{Status: "G", Op: ">=", Value: 90}, {Status: "Y", Op: ">=", Value: 80}, {Status: "R"}}}
	cell := func(p, display, status string, v *float64) Cell {
		return Cell{Period: Period(p), Display: display, Status: status, Value: v, Rule: bands}
	}
	row := func(key, name, cat, subject string, kind ViewRowSubjectKind, depth int, cells ...Cell) ViewRow {
		return ViewRow{MetricKey: key, MetricName: name, CategoryId: cat, SubjectId: subject, SubjectName: subject,
			SubjectKind: kind, Depth: depth, Direction: HigherBetter, Format: MetricFormat(domain.FormatPercent1), Cells: cells}
	}
	co := func(key, name, cat string, prior, cur Cell) ViewRow {
		return row(key, name, cat, "co", Unit, 0, prior, cur)
	}
	v := ScorecardView{
		Periods:    []Period{"2026-M09", "2026-M10"},
		Categories: []Category{{Id: "late", Name: "Late", Order: 2}, {Id: "early", Name: "Early", Order: 1}},
		Rows: []ViewRow{
			co("near", "Near red", "early", cell("2026-M09", "79.0%", "R", pf(79)), cell("2026-M10", "78.0%", "R", pf(78))),
			co("far", "Far red", "late", cell("2026-M09", "50.0%", "R", pf(50)), cell("2026-M10", "40.0%", "R", pf(40))),
			co("dropped", "Dropped", "early", cell("2026-M09", "95.0%", "G", pf(95)), cell("2026-M10", "85.0%", "Y", pf(85))),
			co("steady", "Steady yellow", "early", cell("2026-M09", "85.0%", "Y", pf(85)), cell("2026-M10", "85.0%", "Y", pf(85))),
			co("fine", "Fine", "early", cell("2026-M09", "95.0%", "G", pf(95)), cell("2026-M10", "96.0%", "G", pf(96))),
			row("svc", "Service uptime", "ops", "svc-1", Item, 1, cell("2026-M10", "99.0%", "G", pf(99))),
			row("svc", "Service uptime", "ops", "svc-2", Item, 1, cell("2026-M10", "70.0%", "R", pf(70))),
		},
	}
	got := draftReport(v, "2026-M10", domain.DefaultStatusScale())
	var names []string
	for _, m := range got.NeedsAttention {
		names = append(names, m.Name)
	}
	if strings.Join(names, ",") != "Far red,Near red,Service uptime" {
		t.Fatalf("needs attention = %v", names)
	}
	if svc := got.NeedsAttention[2]; svc.Status != "Red" || svc.Caption != "worst of 2 items" || svc.Category != "Other" {
		t.Fatalf("service = %+v", svc)
	}
	var cats []string
	for _, c := range got.Categories {
		var ms []string
		for _, m := range c.Metrics {
			ms = append(ms, m.Name)
		}
		cats = append(cats, c.Name+":"+strings.Join(ms, "|"))
	}
	if strings.Join(cats, " / ") != "Early:Near red|Dropped|Steady yellow|Fine / Late:Far red / Other:Service uptime" {
		t.Fatalf("categories = %v", cats)
	}

	// With the reds gone, the drop comes before the steady yellow.
	v.Rows = slices.DeleteFunc(v.Rows, func(r ViewRow) bool { return r.MetricKey == "near" || r.MetricKey == "far" || r.MetricKey == "svc" })
	got = draftReport(v, "2026-M10", domain.DefaultStatusScale())
	names = nil
	for _, m := range got.NeedsAttention {
		names = append(names, m.Name)
	}
	if strings.Join(names, ",") != "Dropped,Steady yellow" {
		t.Fatalf("needs attention = %v", names)
	}
}

func TestReportSummaryDraftIsNotASAMTool(t *testing.T) {
	catalog, err := Tools()
	if err != nil {
		t.Fatal(err)
	}
	all, sam := map[string]bool{}, map[string]bool{}
	for _, tl := range catalog {
		all[tl.Name] = true
	}
	for _, tl := range assistant.ToolSet(catalog) {
		sam[tl.Name] = true
	}
	if !all["draft_report_summary"] || !all["get_report_summary_draft"] {
		t.Fatal("the draft operations are not MCP tools")
	}
	if sam["draft_report_summary"] || sam["get_report_summary_draft"] {
		t.Fatal("SAM can call the draft operations")
	}
}
