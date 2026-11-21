package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"opsvision/internal/assistant"
	"opsvision/internal/domain"
	"opsvision/internal/mcp"
)

type assistantContextBody struct {
	ScorecardID string `json:"scorecardId,omitempty"`
	Period      string `json:"period,omitempty"`
	Scope       string `json:"scope,omitempty"`
	MetricKey   string `json:"metricKey,omitempty"`
	Page        string `json:"page"`
}

type assistantUsageBody struct {
	Model        string `json:"model"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
	ToolCalls    int    `json:"toolCalls"`
}

type assistantMessageBody struct {
	ID        string              `json:"id"`
	Role      string              `json:"role"`
	Text      string              `json:"text"`
	Status    string              `json:"status"`
	Error     *string             `json:"error"`
	CreatedAt time.Time           `json:"createdAt"`
	Usage     *assistantUsageBody `json:"usage"`
}

type assistantThreadBody struct {
	ID        string                 `json:"id"`
	Title     string                 `json:"title"`
	CreatedAt time.Time              `json:"createdAt"`
	UpdatedAt time.Time              `json:"updatedAt"`
	Context   *assistantContextBody  `json:"context"`
	Messages  []assistantMessageBody `json:"messages"`
}

type threadListBody struct {
	Threads []struct {
		ID        string    `json:"id"`
		Title     string    `json:"title"`
		CreatedAt time.Time `json:"createdAt"`
		UpdatedAt time.Time `json:"updatedAt"`
	} `json:"threads"`
}

// recordingQueue records turns without running them.
type recordingQueue struct {
	mu   sync.Mutex
	refs []assistant.TurnRef
	err  error
}

func (q *recordingQueue) Enqueue(_ context.Context, ref assistant.TurnRef) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.err != nil {
		return q.err
	}
	q.refs = append(q.refs, ref)
	return nil
}

func (q *recordingQueue) count() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.refs)
}

func testSealer(t *testing.T) assistant.Sealer {
	t.Helper()
	s, err := assistant.NewAESSealer(bytes.Repeat([]byte{4}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// saveKey stores a sealed key for a user, as PUT /me/assistant/credential would.
func saveKey(t *testing.T, e *testEnv, sealer assistant.Sealer, tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	sealed, err := sealer.Seal(ctx, []byte(exampleAPIKey), assistant.CredentialContext(tenantID, userID))
	if err != nil {
		t.Fatal(err)
	}
	if err := e.store.PutCredential(ctx, tenantID, userID, domain.AssistantCredential{Sealed: sealed, Last4: "WXYZ", UpdatedAt: testNow}); err != nil {
		t.Fatal(err)
	}
}

// newThreadEnv is a test API whose assistant turns are recorded, not run.
// t1's viewer and admin have keys saved.
func newThreadEnv(t *testing.T) (*testEnv, *recordingQueue) {
	t.Helper()
	sealer := testSealer(t)
	q := &recordingQueue{}
	env := newTestEnvDeps(t, nil, func(d *Deps) {
		d.Sealer = sealer
		d.Provider = &fakeProvider{}
		d.Queue = q
	})
	saveKey(t, env, sealer, "t1", "u-t1-viewer")
	saveKey(t, env, sealer, "t1", "u-t1-admin")
	return env, q
}

func (e *testEnv) newThread(t *testing.T, token string, body any) assistantThreadBody {
	t.Helper()
	var th assistantThreadBody
	e.expect(t, http.StatusCreated, token, "POST", "/assistant/threads", body, &th)
	return th
}

func TestAssistantThreadsArePrivate(t *testing.T) {
	env, _ := newThreadEnv(t)
	viewer, admin, other := env.tokens["t1-viewer"], env.tokens["t1-admin"], env.tokens["t2-admin"]

	ctxBody := map[string]any{"context": map[string]any{"scorecardId": "delivery", "period": "2026-M09", "scope": "seg-a", "metricKey": "on_time_pct", "page": "overview"}}
	th := env.newThread(t, viewer, ctxBody)
	if th.ID == "" || th.Title != "New chat" || len(th.Messages) != 0 || !th.CreatedAt.Equal(testNow) || !th.UpdatedAt.Equal(testNow) {
		t.Fatalf("created = %+v", th)
	}
	if th.Context == nil || *th.Context != (assistantContextBody{ScorecardID: "delivery", Period: "2026-M09", Scope: "seg-a", MetricKey: "on_time_pct", Page: "overview"}) {
		t.Fatalf("context = %+v", th.Context)
	}
	if raw := mustCall(t, env, viewer, "POST", "/assistant/threads", nil, http.StatusCreated); strings.Contains(raw, `"context"`) {
		t.Fatalf("a thread created without a body has a context: %s", raw)
	}

	var list threadListBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads", nil, &list)
	if len(list.Threads) != 2 {
		t.Fatalf("viewer list = %+v", list)
	}
	env.expect(t, http.StatusOK, admin, "GET", "/assistant/threads", nil, &list)
	if len(list.Threads) != 0 {
		t.Fatalf("admin sees another user's threads: %+v", list)
	}

	path := "/assistant/threads/" + th.ID
	for _, tok := range []string{admin, other} {
		env.expectError(t, http.StatusNotFound, "not_found", tok, "GET", path, nil)
		env.expectError(t, http.StatusNotFound, "not_found", tok, "DELETE", path, nil)
		env.expectError(t, http.StatusNotFound, "not_found", tok, "POST", path+"/messages", map[string]any{"text": "hi"})
	}
	var got assistantThreadBody
	env.expect(t, http.StatusOK, viewer, "GET", path, nil, &got)
	if got.ID != th.ID {
		t.Fatalf("get = %+v", got)
	}
	env.expect(t, http.StatusNoContent, viewer, "DELETE", path, nil, nil)
	env.expectError(t, http.StatusNotFound, "not_found", viewer, "GET", path, nil)
	env.expectError(t, http.StatusNotFound, "not_found", viewer, "DELETE", path, nil)

	env.expectError(t, http.StatusUnauthorized, "unauthorized", "", "GET", "/assistant/threads", nil)
	env.expectError(t, http.StatusForbidden, "forbidden", env.tokens["operator"], "GET", "/assistant/threads", nil)
}

func mustCall(t *testing.T, e *testEnv, token, method, path string, body any, want int) string {
	t.Helper()
	status, raw := e.call(t, token, method, path, body)
	if status != want {
		t.Fatalf("%s %s: %d %s, want %d", method, path, status, raw, want)
	}
	return string(raw)
}

func TestPostAssistantMessage(t *testing.T) {
	env, q := newThreadEnv(t)
	viewer := env.tokens["t1-viewer"]
	th := env.newThread(t, viewer, map[string]any{"context": map[string]any{"page": "overview", "scorecardId": "delivery"}})
	path := "/assistant/threads/" + th.ID + "/messages"

	var got assistantThreadBody
	env.expect(t, http.StatusAccepted, viewer, "POST", path, map[string]any{
		"text":    "  Why is on time red this month? I need to know before the review, please explain it in detail  \n",
		"context": map[string]any{"page": "focus", "scorecardId": "delivery", "period": "2026-M10", "metricKey": "on_time_pct"},
	}, &got)
	if len(got.Messages) != 2 {
		t.Fatalf("messages = %+v", got.Messages)
	}
	question, answer := got.Messages[0], got.Messages[1]
	if question.Role != "user" || question.Status != "done" || question.Text != "Why is on time red this month? I need to know before the review, please explain it in detail" {
		t.Fatalf("question = %+v", question)
	}
	if answer.Role != "assistant" || answer.Status != "pending" || answer.Text != "" || answer.Error != nil || answer.Usage != nil {
		t.Fatalf("answer = %+v", answer)
	}
	if got.Title != "Why is on time red this month? I need to know before the…" {
		t.Fatalf("title = %q", got.Title)
	}
	if got.Context == nil || got.Context.Page != "focus" || got.Context.MetricKey != "on_time_pct" || got.Context.Period != "2026-M10" {
		t.Fatalf("context not replaced: %+v", got.Context)
	}
	if q.count() != 1 || q.refs[0] != (assistant.TurnRef{TenantID: "t1", UserID: "u-t1-viewer", ThreadID: th.ID, MessageID: answer.ID}) {
		t.Fatalf("enqueued = %+v", q.refs)
	}

	// One pending answer per thread.
	e := env.expectError(t, http.StatusConflict, "conflict", viewer, "POST", path, map[string]any{"text": "Hello?"})
	if e.Error.Message != msgStillAnswering {
		t.Fatalf("second post message = %q", e.Error.Message)
	}
	if q.count() != 1 {
		t.Fatal("a second turn was enqueued")
	}
	var again assistantThreadBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads/"+th.ID, nil, &again)
	if len(again.Messages) != 2 || again.Messages[1].Status != "pending" {
		t.Fatalf("thread after the rejected post = %+v", again.Messages)
	}

	// The thread moves to the top of the list.
	other := env.newThread(t, viewer, nil)
	_ = other
	var list threadListBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads", nil, &list)
	if len(list.Threads) != 2 || list.Threads[1].ID != th.ID || list.Threads[1].Title != got.Title {
		t.Fatalf("list = %+v", list)
	}
}

func TestPostAssistantMessageValidation(t *testing.T) {
	env, q := newThreadEnv(t)
	viewer := env.tokens["t1-viewer"]
	th := env.newThread(t, viewer, nil)
	path := "/assistant/threads/" + th.ID + "/messages"
	for name, body := range map[string]any{
		"empty":       map[string]any{"text": "   "},
		"too long":    map[string]any{"text": strings.Repeat("é", 4001)},
		"no page":     map[string]any{"text": "hi", "context": map[string]any{"scorecardId": "delivery"}},
		"bad page":    map[string]any{"text": "hi", "context": map[string]any{"page": "home"}},
		"bad period":  map[string]any{"text": "hi", "context": map[string]any{"page": "table", "period": "Sept"}},
		"bad scope":   map[string]any{"text": "hi", "context": map[string]any{"page": "table", "scope": "a b"}},
		"bad metric":  map[string]any{"text": "hi", "context": map[string]any{"page": "table", "metricKey": "On Time"}},
		"bad card":    map[string]any{"text": "hi", "context": map[string]any{"page": "table", "scorecardId": "x#y"}},
		"not an obj":  `"hi"`,
		"bad context": map[string]any{"text": "hi", "context": "overview"},
	} {
		t.Run(name, func(t *testing.T) {
			env.expectError(t, http.StatusBadRequest, "invalid", viewer, "POST", path, body)
		})
	}
	env.expectError(t, http.StatusBadRequest, "invalid", viewer, "POST", "/assistant/threads", map[string]any{"context": map[string]any{"page": "nope"}})
	if q.count() != 0 {
		t.Fatal("an invalid post was enqueued")
	}
	// 4000 characters is allowed.
	env.expect(t, http.StatusAccepted, viewer, "POST", path, map[string]any{"text": strings.Repeat("é", 4000)}, nil)
}

func TestPostAssistantMessagePreconditions(t *testing.T) {
	t.Run("no key", func(t *testing.T) {
		env, q := newThreadEnv(t)
		tok := env.tokens["t1-contributor"]
		th := env.newThread(t, tok, nil)
		e := env.expectError(t, http.StatusConflict, "conflict", tok, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "hi"})
		if e.Error.Message != "Add your Claude API key in My settings → Ask SAM." || q.count() != 0 {
			t.Fatalf("message %q, enqueued %d", e.Error.Message, q.count())
		}
	})
	t.Run("turned off", func(t *testing.T) {
		env, q := newThreadEnv(t)
		tok := env.tokens["t1-viewer"]
		th := env.newThread(t, tok, nil)
		env.expect(t, http.StatusOK, env.tokens["t1-admin"], "PUT", "/assistant/settings", map[string]any{"enabled": false, "model": "claude-haiku-5-5"}, nil)
		e := env.expectError(t, http.StatusConflict, "conflict", tok, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "hi"})
		if e.Error.Message != "Ask SAM is turned off for this organization." || q.count() != 0 {
			t.Fatalf("message %q, enqueued %d", e.Error.Message, q.count())
		}
	})
	t.Run("no queue", func(t *testing.T) {
		sealer := testSealer(t)
		env := newTestEnvDeps(t, nil, func(d *Deps) { d.Sealer = sealer; d.Provider = &fakeProvider{} })
		saveKey(t, env, sealer, "t1", "u-t1-viewer")
		tok := env.tokens["t1-viewer"]
		th := env.newThread(t, tok, nil)
		env.expectError(t, http.StatusServiceUnavailable, "assistant_unavailable", tok, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "hi"})
		var got assistantThreadBody
		env.expect(t, http.StatusOK, tok, "GET", "/assistant/threads/"+th.ID, nil, &got)
		if len(got.Messages) != 0 {
			t.Fatalf("messages stored without a queue: %+v", got.Messages)
		}
	})
	t.Run("enqueue fails", func(t *testing.T) {
		env, q := newThreadEnv(t)
		q.err = errors.New("queue down")
		tok := env.tokens["t1-viewer"]
		th := env.newThread(t, tok, nil)
		env.expectError(t, http.StatusServiceUnavailable, "assistant_unavailable", tok, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "hi"})
		var got assistantThreadBody
		env.expect(t, http.StatusOK, tok, "GET", "/assistant/threads/"+th.ID, nil, &got)
		if len(got.Messages) != 2 || got.Messages[1].Status != "error" || got.Messages[1].Error == nil || *got.Messages[1].Error != msgCouldNotStart {
			t.Fatalf("messages = %+v, want the answer marked failed", got.Messages)
		}
		// The failed answer does not block the next question.
		q.err = nil
		env.expect(t, http.StatusAccepted, tok, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "again"}, nil)
	})
}

func TestAssistantThreadLimit(t *testing.T) {
	env, _ := newThreadEnv(t)
	viewer := env.tokens["t1-viewer"]
	var ids []string
	for range 51 {
		ids = append(ids, env.newThread(t, viewer, nil).ID)
	}
	var list threadListBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads", nil, &list)
	if len(list.Threads) != 50 {
		t.Fatalf("%d threads kept, want 50", len(list.Threads))
	}
	for _, l := range list.Threads {
		if l.ID == ids[0] {
			t.Fatal("the oldest thread was kept")
		}
	}
	if list.Threads[0].ID != ids[50] {
		t.Fatalf("newest first: got %s, want %s", list.Threads[0].ID, ids[50])
	}
	env.expectError(t, http.StatusNotFound, "not_found", viewer, "GET", "/assistant/threads/"+ids[0], nil)
	// Another user's threads are untouched.
	env.newThread(t, env.tokens["t1-admin"], nil)
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads", nil, &list)
	if len(list.Threads) != 50 {
		t.Fatalf("viewer has %d threads after the admin's create", len(list.Threads))
	}
}

// putThread stores a thread for t1's viewer directly.
func putThread(t *testing.T, e *testEnv, id string, msgs []domain.AssistantMessage) {
	t.Helper()
	th := domain.AssistantThread{ID: id, UserID: "u-t1-viewer", Title: "Old", CreatedAt: testNow.Add(-time.Hour), UpdatedAt: testNow.Add(-time.Hour)}
	if err := e.store.PutThread(context.Background(), "t1", th, msgs, 0); err != nil {
		t.Fatal(err)
	}
}

func TestStalePendingReadsAsError(t *testing.T) {
	env, q := newThreadEnv(t)
	viewer := env.tokens["t1-viewer"]
	asked := testNow.Add(-assistant.StalePending)
	putThread(t, env, "th-stale", []domain.AssistantMessage{
		{ID: "m-1", Role: "user", Text: "Why?", Status: "done", CreatedAt: asked},
		{ID: "m-2", Role: "assistant", Status: "pending", CreatedAt: asked},
	})
	putThread(t, env, "th-fresh", []domain.AssistantMessage{
		{ID: "m-1", Role: "user", Text: "Why?", Status: "done", CreatedAt: asked.Add(time.Second)},
		{ID: "m-2", Role: "assistant", Status: "pending", CreatedAt: asked.Add(time.Second)},
	})

	var got assistantThreadBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads/th-stale", nil, &got)
	if m := got.Messages[1]; m.Status != "error" || m.Error == nil || *m.Error != "SAM took too long. Try again." {
		t.Fatalf("stale answer = %+v", m)
	}
	var fresh assistantThreadBody
	env.expect(t, http.StatusOK, viewer, "GET", "/assistant/threads/th-fresh", nil, &fresh)
	if m := fresh.Messages[1]; m.Status != "pending" || m.Error != nil {
		t.Fatalf("fresh answer = %+v", m)
	}
	env.expectError(t, http.StatusConflict, "conflict", viewer, "POST", "/assistant/threads/th-fresh/messages", map[string]any{"text": "hi"})

	// A stale answer does not block a new question, and is stored as failed.
	var posted assistantThreadBody
	env.expect(t, http.StatusAccepted, viewer, "POST", "/assistant/threads/th-stale/messages", map[string]any{"text": "Try again"}, &posted)
	if len(posted.Messages) != 4 || posted.Messages[1].Status != "error" || posted.Messages[3].Status != "pending" || q.count() != 1 {
		t.Fatalf("messages = %+v", posted.Messages)
	}
	stored, err := env.store.GetThread(context.Background(), "t1", "u-t1-viewer", "th-stale")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Messages[1].Status != domain.AssistantStatusError || stored.Messages[1].Error != assistant.MsgStale {
		t.Fatalf("stored stale answer = %+v", stored.Messages[1])
	}
}

func TestAssistantThreadFull(t *testing.T) {
	env, q := newThreadEnv(t)
	var msgs []domain.AssistantMessage
	for i := range maxThreadMessages - 1 {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		msgs = append(msgs, domain.AssistantMessage{ID: fmt.Sprintf("m-%03d", i), Role: role, Text: "x", Status: "done", CreatedAt: testNow})
	}
	putThread(t, env, "th-full", msgs)
	e := env.expectError(t, http.StatusConflict, "conflict", env.tokens["t1-viewer"], "POST", "/assistant/threads/th-full/messages", map[string]any{"text": "one more"})
	if e.Error.Message != msgThreadFull || q.count() != 0 {
		t.Fatalf("message %q, enqueued %d", e.Error.Message, q.count())
	}
}

func TestAssistantToolSetOverTheAPICatalog(t *testing.T) {
	catalog, err := Tools()
	if err != nil {
		t.Fatal(err)
	}
	set := assistant.ToolSet(catalog)
	names := map[string]bool{}
	for _, tl := range set {
		names[tl.Name] = true
		if tl.Method != http.MethodGet {
			t.Errorf("%s is %s", tl.Name, tl.Method)
		}
		for _, p := range []string{"/members", "/me", "/assistant", "/audit", "/operator"} {
			if tl.PathTemplate == p || strings.HasPrefix(tl.PathTemplate, p+"/") {
				t.Errorf("%s (%s) is under %s", tl.Name, tl.PathTemplate, p)
			}
		}
	}
	for _, want := range []string{"get_scorecard_view", "list_org_units", "get_report_document", "list_versions"} {
		if !names[want] {
			t.Errorf("SAM cannot call %s", want)
		}
	}
	for _, not := range []string{"update_org_unit", "create_org_unit", "list_members", "get_me", "list_audit", "list_assistant_threads", "get_assistant_settings", "post_assistant_message", mcp.ImportCSVToolName} {
		if names[not] {
			t.Errorf("SAM can call %s", not)
		}
	}
	// The thread operations are still MCP tools.
	all := map[string]bool{}
	for _, tl := range catalog {
		all[tl.Name] = true
	}
	for _, want := range []string{"list_assistant_threads", "create_assistant_thread", "get_assistant_thread", "delete_assistant_thread", "post_assistant_message"} {
		if !all[want] {
			t.Errorf("MCP lacks %s", want)
		}
	}
}

// turnProvider asks for the view of seg-a and for three writes on a
// question, then answers once the tool results come back.
type turnProvider struct {
	mu    sync.Mutex
	calls []assistant.MessagesRequest
}

func (p *turnProvider) Messages(_ context.Context, _ string, req assistant.MessagesRequest) (assistant.MessagesResponse, error) {
	p.mu.Lock()
	p.calls = append(p.calls, req)
	p.mu.Unlock()
	if req.MaxTokens == 1 {
		return assistant.MessagesResponse{Content: []assistant.Block{{Type: "text", Text: "ok"}}}, nil
	}
	last := req.Messages[len(req.Messages)-1]
	if last.Content[0].Type == "tool_result" {
		return assistant.MessagesResponse{Content: []assistant.Block{{Type: "text", Text: "On time for Segment A was 84.3% (Yellow) in 2026-M10."}},
			StopReason: "end_turn", Usage: assistant.Usage{InputTokens: 50, OutputTokens: 9}}, nil
	}
	return assistant.MessagesResponse{Content: []assistant.Block{
		{Type: "tool_use", ID: "tu-view", Name: "get_scorecard_view", Input: json.RawMessage(`{"sc":"delivery","periods":["2026-M10"],"subjects":["seg-a"],"metrics":["on_time_pct"]}`)},
		{Type: "tool_use", ID: "tu-del", Name: "delete_org_unit", Input: json.RawMessage(`{"id":"seg-b"}`)},
		{Type: "tool_use", ID: "tu-upd", Name: "update_org_unit", Input: json.RawMessage(`{"id":"seg-b","body":{"name":"Renamed by data","levelId":"segment","parentId":"acme","sourceKeys":[]}}`)},
		{Type: "tool_use", ID: "tu-put", Name: "put_assistant_settings", Input: json.RawMessage(`{"body":{"enabled":false,"model":"x"}}`)},
	}, StopReason: "tool_use", Usage: assistant.Usage{InputTokens: 40, OutputTokens: 7}}, nil
}

func (p *turnProvider) lastResults() []assistant.Block {
	p.mu.Lock()
	defer p.mu.Unlock()
	req := p.calls[len(p.calls)-1]
	return req.Messages[len(req.Messages)-1].Content
}

func TestAssistantTurnEndToEnd(t *testing.T) {
	sealer := testSealer(t)
	prov := &turnProvider{}
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
	saveKey(t, env, sealer, "t1", "u-t1-admin")
	saveKey(t, env, sealer, "t1", "u-t1-viewer")
	setScope(t, env, domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"seg-b"}})
	auditsBefore := len(env.audits(t, "t1"))

	ask := func(token string) (assistantMessageBody, []assistant.Block) {
		t.Helper()
		th := env.newThread(t, token, map[string]any{"context": map[string]any{"page": "overview", "scorecardId": "delivery", "period": "2026-M10"}})
		env.expect(t, http.StatusAccepted, token, "POST", "/assistant/threads/"+th.ID+"/messages", map[string]any{"text": "How is on time for Segment A?"}, nil)
		q.Wait()
		var got assistantThreadBody
		env.expect(t, http.StatusOK, token, "GET", "/assistant/threads/"+th.ID, nil, &got)
		return got.Messages[1], prov.lastResults()
	}

	// An admin's turn reads what the admin can see, and writes nothing.
	answer, results := ask(env.tokens["t1-admin"])
	if answer.Status != "done" || answer.Text != "On time for Segment A was 84.3% (Yellow) in 2026-M10." {
		t.Fatalf("answer = %+v", answer)
	}
	if answer.Usage == nil || *answer.Usage != (assistantUsageBody{Model: domain.DefaultAssistantModel, InputTokens: 90, OutputTokens: 16, ToolCalls: 4}) {
		t.Fatalf("usage = %+v", answer.Usage)
	}
	if len(results) != 4 || results[0].IsError || !strings.Contains(results[0].Content, "84.3%") {
		t.Fatalf("view result = %+v", results)
	}
	for _, r := range results[1:] {
		if !r.IsError || !strings.Contains(r.Content, "not available") {
			t.Fatalf("write tool result = %+v, want refused", r)
		}
	}
	var units struct {
		Units []unitJSON `json:"units"`
	}
	env.expect(t, http.StatusOK, env.tokens["t1-admin"], "GET", "/org/units", nil, &units)
	found := false
	for _, u := range units.Units {
		if u.ID == "seg-b" {
			found = true
			if u.Name != "Segment B" {
				t.Fatalf("seg-b was renamed to %q", u.Name)
			}
		}
	}
	if !found {
		t.Fatal("seg-b was deleted")
	}
	settings, err := env.store.GetAssistantSettings(context.Background(), "t1")
	if err != nil || !settings.Enabled {
		t.Fatalf("settings changed: %+v %v", settings, err)
	}
	if n := len(env.audits(t, "t1")); n != auditsBefore {
		t.Fatalf("audit entries %d → %d: the turn wrote something", auditsBefore, n)
	}

	// A viewer scoped to seg-b gets no seg-a numbers through SAM.
	answer, results = ask(env.tokens["t1-viewer"])
	if answer.Status != "done" {
		t.Fatalf("viewer answer = %+v", answer)
	}
	if results[0].IsError || strings.Contains(results[0].Content, "84.3%") || !strings.Contains(results[0].Content, `"rows":[]`) {
		t.Fatalf("the viewer's tool result shows seg-a's value: %s", results[0].Content)
	}
}

// The runner drafts both kinds: report summaries from the report, exec
// summaries from the attribution.
func TestAssistantRunnerHasDraftSources(t *testing.T) {
	env := newTestEnv(t)
	r, err := env.api.AssistantRunner()
	if err != nil {
		t.Fatal(err)
	}
	if r.Reports == nil || r.Summaries == nil {
		t.Fatalf("runner sources: reports %v, summaries %v", r.Reports, r.Summaries)
	}
}
