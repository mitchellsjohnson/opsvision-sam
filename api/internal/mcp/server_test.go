package mcp_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/httpapi"
	"opsvision/internal/mcp"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/store/memstore"
)

// ---- fixture -------------------------------------------------------------------

const testSecret = "0123456789abcdef0123456789abcdef"

// testNow is the fixed clock: the demo data runs through 2026-M10.
var testNow = time.Date(2026, time.November, 15, 12, 0, 0, 0, time.UTC)

// env is the whole API over the demo tenant, with dev tokens for its users
// keyed by role ("admin", "contributor", "viewer").
type env struct {
	srv    *httptest.Server
	store  *memstore.Store
	objs   *objects.Mem
	tokens map[string]string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	st := memstore.New()
	if _, err := demo.Seed(ctx, st, period.Calendar{FiscalYearStartMonth: time.January}); err != nil {
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
	authMW, err := auth.Middleware(auth.Config{Mode: auth.ModeDev, DevSecret: testSecret, Now: func() time.Time { return testNow }}, st)
	if err != nil {
		t.Fatal(err)
	}
	objs := objects.NewMem("http://objects.test", objects.Signer(testSecret))
	n := 0
	s := httpapi.NewServer(httpapi.Deps{
		Store: st, Objects: objs,
		Now:   func() time.Time { return testNow },
		NewID: func() string { n++; return fmt.Sprintf("id-%04d", n) },
	})
	srv := httptest.NewServer(httpapi.NewHandler(s, authMW))
	t.Cleanup(srv.Close)
	return &env{srv: srv, store: st, objs: objs, tokens: tokens}
}

// post sends a raw body to /v1/mcp.
func (e *env) post(t *testing.T, token, body string, header http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/mcp", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range header {
		req.Header[k] = v
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolResult struct {
	Content           []content      `json:"content"`
	StructuredContent map[string]any `json:"structuredContent"`
	IsError           bool           `json:"isError"`
}

func (r toolResult) text() string {
	var parts []string
	for _, c := range r.Content {
		parts = append(parts, c.Text)
	}
	return strings.Join(parts, "\n")
}

func decodeRPC(t *testing.T, resp *http.Response) rpcResponse {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, raw)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content type %q", ct)
	}
	var out rpcResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	if out.JSONRPC != "2.0" {
		t.Fatalf("jsonrpc = %q", out.JSONRPC)
	}
	return out
}

// rpc calls method with id 1 and returns the response.
func (e *env) rpc(t *testing.T, token, method string, params any) rpcResponse {
	t.Helper()
	req := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		req["params"] = params
	}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	out := decodeRPC(t, e.post(t, token, string(raw), nil))
	if string(out.ID) != "1" {
		t.Fatalf("id = %s", out.ID)
	}
	return out
}

// callTool calls a tool and requires a result (not a protocol error).
func (e *env) callTool(t *testing.T, token, name string, args map[string]any) toolResult {
	t.Helper()
	out := e.rpc(t, token, "tools/call", map[string]any{"name": name, "arguments": args})
	if out.Error != nil {
		t.Fatalf("tools/call %s: error %+v", name, out.Error)
	}
	var res toolResult
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// get calls the REST API directly.
func (e *env) get(t *testing.T, token, path string) []byte {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.srv.URL+"/v1"+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: %d %s", path, resp.StatusCode, raw)
	}
	return raw
}

func (e *env) audits(t *testing.T) []domain.AuditEntry {
	t.Helper()
	out, err := e.store.ListAudit(context.Background(), demo.TenantID, time.Time{}, testNow.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// ---- protocol ------------------------------------------------------------------

func TestInitialize(t *testing.T) {
	e := newEnv(t)
	for _, tc := range []struct{ asked, want string }{
		{"2025-06-18", "2025-06-18"},
		{"2025-03-26", "2025-03-26"},
		{"1999-01-01", mcp.LatestProtocolVersion},
	} {
		out := e.rpc(t, e.tokens["viewer"], "initialize", map[string]any{
			"protocolVersion": tc.asked, "capabilities": map[string]any{},
			"clientInfo": map[string]any{"name": "test", "version": "1"},
		})
		if out.Error != nil {
			t.Fatalf("error %+v", out.Error)
		}
		var res struct {
			ProtocolVersion string                     `json:"protocolVersion"`
			Capabilities    map[string]json.RawMessage `json:"capabilities"`
			ServerInfo      struct{ Name, Version string }
		}
		if err := json.Unmarshal(out.Result, &res); err != nil {
			t.Fatal(err)
		}
		if res.ProtocolVersion != tc.want {
			t.Errorf("asked %s: protocolVersion %s, want %s", tc.asked, res.ProtocolVersion, tc.want)
		}
		if res.ServerInfo.Name != "opsvision" || res.ServerInfo.Version == "" {
			t.Errorf("serverInfo = %+v", res.ServerInfo)
		}
		if _, ok := res.Capabilities["tools"]; !ok {
			t.Errorf("capabilities = %v", res.Capabilities)
		}
	}
	if !slices.Contains(mcp.ProtocolVersions, mcp.LatestProtocolVersion) {
		t.Error("latest version is not supported")
	}
}

func TestNotificationsAreAccepted(t *testing.T) {
	e := newEnv(t)
	resp := e.post(t, e.tokens["viewer"], `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil)
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusAccepted || len(raw) != 0 {
		t.Fatalf("status %d body %q", resp.StatusCode, raw)
	}
}

func TestPing(t *testing.T) {
	e := newEnv(t)
	out := e.rpc(t, e.tokens["viewer"], "ping", nil)
	if out.Error != nil || string(out.Result) != "{}" {
		t.Fatalf("ping = %+v %s", out.Error, out.Result)
	}
}

func TestUnknownMethod(t *testing.T) {
	e := newEnv(t)
	out := e.rpc(t, e.tokens["viewer"], "resources/list", nil)
	if out.Error == nil || out.Error.Code != -32601 {
		t.Fatalf("error = %+v", out.Error)
	}
}

func TestMalformedRequests(t *testing.T) {
	e := newEnv(t)
	for _, tc := range []struct {
		name, body   string
		status, code int
		header       http.Header
	}{
		{"batch", `[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, 400, -32600, nil},
		{"parse", `{"jsonrpc":`, 400, -32700, nil},
		{"version", `{"jsonrpc":"1.0","id":1,"method":"ping"}`, 400, -32600, nil},
		{"no method", `{"jsonrpc":"2.0","id":1}`, 400, -32600, nil},
		{"null id", `{"jsonrpc":"2.0","id":null,"method":"ping"}`, 400, -32600, nil},
		{"protocol header", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, 400, -32600, http.Header{"Mcp-Protocol-Version": {"1999-01-01"}}},
		{"bad params", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":[1]}`, 200, -32602, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := e.post(t, e.tokens["viewer"], tc.body, tc.header)
			raw, _ := io.ReadAll(resp.Body)
			var out rpcResponse
			if err := json.Unmarshal(raw, &out); err != nil {
				t.Fatalf("decode %s: %v", raw, err)
			}
			if resp.StatusCode != tc.status || out.Error == nil || out.Error.Code != tc.code {
				t.Fatalf("status %d error %+v, want %d code %d", resp.StatusCode, out.Error, tc.status, tc.code)
			}
		})
	}
	// A supported protocol header is fine.
	out := decodeRPC(t, e.post(t, e.tokens["viewer"], `{"jsonrpc":"2.0","id":"a","method":"ping"}`,
		http.Header{"Mcp-Protocol-Version": {"2025-06-18"}}))
	if out.Error != nil || string(out.ID) != `"a"` {
		t.Fatalf("ping = %+v", out)
	}
}

func TestGetIsNotAllowed(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+e.tokens["viewer"])
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "POST" {
		t.Fatalf("status %d allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
}

func TestUnauthenticated(t *testing.T) {
	e := newEnv(t)
	resp := e.post(t, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", resp.StatusCode)
	}
	resp = e.post(t, "ovs_pat_not-a-real-token", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown token: status %d", resp.StatusCode)
	}
}

// ---- tools ---------------------------------------------------------------------

func TestToolsList(t *testing.T) {
	e := newEnv(t)
	out := e.rpc(t, e.tokens["viewer"], "tools/list", map[string]any{})
	var res struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
			Annotations map[string]any `json:"annotations"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	if want := len(apiTools(t)) + 1; len(res.Tools) != want {
		t.Fatalf("%d tools, want %d", len(res.Tools), want)
	}
	if len(out.Result) > mcp.ResultLimit {
		t.Errorf("the tool list is %d bytes", len(out.Result))
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
		if tool.Description == "" || tool.InputSchema["type"] != "object" {
			t.Errorf("tool %s = %+v", tool.Name, tool)
		}
	}
	for _, want := range []string{"get_scorecard_view", "import_records_csv", "publish_report"} {
		if !slices.Contains(names, want) {
			t.Errorf("no %s", want)
		}
	}
	for _, op := range secretOps {
		if slices.Contains(names, mcp.SnakeCase(op)) {
			t.Errorf("%s is listed", op)
		}
	}
}

func viewArgs(periods ...string) map[string]any {
	ps := make([]any, len(periods))
	for i, p := range periods {
		ps[i] = p
	}
	return map[string]any{"sc": demo.ScorecardID, "periods": ps}
}

func TestToolCallMatchesAPI(t *testing.T) {
	e := newEnv(t)
	tok := e.tokens["contributor"]
	res := e.callTool(t, tok, "get_scorecard_view", viewArgs("2026-M09", "2026-Q3"))
	if res.IsError {
		t.Fatalf("isError: %s", res.text())
	}
	q := url.Values{"periods": {"2026-M09", "2026-Q3"}}
	direct := e.get(t, tok, "/scorecards/"+demo.ScorecardID+"/view?"+q.Encode())
	if len(res.Content) != 1 || res.Content[0].Type != "text" {
		t.Fatalf("content = %+v", res.Content)
	}
	if got, want := strings.TrimSpace(res.Content[0].Text), strings.TrimSpace(string(direct)); got != want {
		t.Fatalf("tool text differs from the API\n got %.300s\nwant %.300s", got, want)
	}
	var want map[string]any
	if err := json.Unmarshal(direct, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res.StructuredContent, want) {
		t.Error("structuredContent differs from the API response")
	}
}

func TestToolCallForbidden(t *testing.T) {
	e := newEnv(t)
	res := e.callTool(t, e.tokens["viewer"], "create_item_kind", map[string]any{"body": map[string]any{"id": "widgets", "name": "Widgets"}})
	if !res.IsError {
		t.Fatalf("not an error: %s", res.text())
	}
	if txt := res.text(); !strings.Contains(txt, "tenant admin role required") || !strings.Contains(txt, "403") {
		t.Fatalf("text = %q", txt)
	}
}

func TestToolCallArgumentErrors(t *testing.T) {
	e := newEnv(t)
	res := e.callTool(t, e.tokens["viewer"], "get_scorecard_view", map[string]any{"periods": []any{"2026-M09"}})
	if !res.IsError || !strings.Contains(res.text(), "sc") {
		t.Fatalf("missing path argument: %+v", res)
	}
	res = e.callTool(t, e.tokens["viewer"], "get_scorecard_view", map[string]any{"sc": ".."})
	if !res.IsError {
		t.Fatalf("dot path argument accepted: %+v", res)
	}
	// The API's own validation applies.
	res = e.callTool(t, e.tokens["viewer"], "get_scorecard_view", map[string]any{"sc": demo.ScorecardID})
	if !res.IsError || !strings.Contains(res.text(), "400") {
		t.Fatalf("view without columns: %+v", res)
	}
}

func TestUnknownAndExcludedTools(t *testing.T) {
	e := newEnv(t)
	for _, name := range []string{"no_such_tool", "create_my_token", "list_my_tokens"} {
		out := e.rpc(t, e.tokens["admin"], "tools/call", map[string]any{"name": name, "arguments": map[string]any{}})
		if out.Error == nil || out.Error.Code != -32602 {
			t.Errorf("%s: error = %+v", name, out.Error)
		}
	}
}

func TestWritesAreAuditedAsMCP(t *testing.T) {
	e := newEnv(t)
	res := e.callTool(t, e.tokens["admin"], "create_item_kind", map[string]any{"body": map[string]any{"id": "widgets", "name": "Widgets"}})
	if res.IsError {
		t.Fatalf("isError: %s", res.text())
	}
	if res.StructuredContent["id"] != "widgets" {
		t.Errorf("result = %v", res.StructuredContent)
	}

	// An access token's MCP writes are MCP writes too.
	secret, hash, prefix, err := auth.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.store.PutToken(context.Background(), domain.AccessToken{
		ID: "tok1", TenantID: demo.TenantID, UserID: "dev|admin", Name: "MCP", Prefix: prefix, Hash: hash,
		CreatedAt: testNow, ExpiresAt: testNow.Add(24 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	res = e.callTool(t, secret, "create_item_kind", map[string]any{"body": map[string]any{"id": "gadgets", "name": "Gadgets"}})
	if res.IsError {
		t.Fatalf("token: isError: %s", res.text())
	}

	got := map[string]string{}
	for _, a := range e.audits(t) {
		if a.Action == "item_kind.create" {
			got[a.TargetID] = a.Channel + " " + a.ActorID
		}
	}
	want := map[string]string{"widgets": "mcp dev|admin", "gadgets": "mcp dev|admin"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("audit = %v, want %v", got, want)
	}
}

// The outer response may be compressed; the API response inside a tool
// result never is.
func TestToolResultIsNotCompressed(t *testing.T) {
	e := newEnv(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_scorecard_view","arguments":{"sc":"` +
		demo.ScorecardID + `","periods":["2026-M09"]}}}`
	resp := e.post(t, e.tokens["viewer"], body, http.Header{"Accept-Encoding": {"gzip"}})
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("outer response not compressed: %v", resp.Header)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var out rpcResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	var res toolResult
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	if res.IsError || !json.Valid([]byte(res.Content[0].Text)) {
		t.Fatalf("tool text is not plain JSON: %.200q", res.Content[0].Text)
	}
}

// A two-year view through MCP fits the load balancer's response limit:
// truncated with a note when it is over the budget, never an error.
func TestLargeViewFitsTheResponseLimit(t *testing.T) {
	e := newEnv(t)
	var periods []string
	for fy := 2025; fy <= 2026; fy++ {
		for m := 1; m <= 12; m++ {
			periods = append(periods, fmt.Sprintf("%d-M%02d", fy, m))
		}
	}
	args := viewArgs(periods...)
	args["structure"] = "current"
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "get_scorecard_view", "arguments": args}})
	resp := e.post(t, e.tokens["admin"], string(raw), nil)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || len(body) >= 1<<20 {
		t.Fatalf("status %d, %d bytes", resp.StatusCode, len(body))
	}
	var out rpcResponse
	if err := json.Unmarshal(body, &out); err != nil || out.Error != nil {
		t.Fatalf("response %v %+v", err, out.Error)
	}
	var res toolResult
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("isError: %.300s", res.text())
	}
	if len(res.Content) == 2 && res.Content[1].Text != mcp.TruncatedNote {
		t.Fatalf("second block = %q", res.Content[1].Text)
	}
	if len(res.Content) != 2 && len(res.Content) != 1 {
		t.Fatalf("%d content blocks", len(res.Content))
	}
	t.Logf("24-month view: %d bytes over MCP, %d content blocks", len(body), len(res.Content))
}

// ---- results (fake dispatcher) --------------------------------------------------

type fakeDispatcher struct {
	status int
	body   []byte
}

func (f fakeDispatcher) Call(context.Context, mcp.Tool, map[string]any) (int, []byte, error) {
	return f.status, f.body, nil
}

var bigTool = mcp.Tool{Name: "get_big", Description: "Big", Method: "GET", PathTemplate: "/big",
	InputSchema: map[string]any{"type": "object", "properties": map[string]any{}}}

func callFake(t *testing.T, d mcp.Dispatcher) toolResult {
	t.Helper()
	h := mcp.NewHandler([]mcp.Tool{bigTool}, d, nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_big","arguments":{}}}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if rec.Body.Len() >= 1<<20 {
		t.Fatalf("response is %d bytes", rec.Body.Len())
	}
	var out rpcResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var res toolResult
	if err := json.Unmarshal(out.Result, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func TestResultOverLimitIsTruncated(t *testing.T) {
	big := []byte(`{"rows":"` + strings.Repeat("é\"x", mcp.ResultLimit/3) + `"}`)
	res := callFake(t, fakeDispatcher{status: 200, body: big})
	if res.IsError || res.StructuredContent != nil {
		t.Fatalf("isError %v structured %v", res.IsError, res.StructuredContent != nil)
	}
	if len(res.Content) != 2 {
		t.Fatalf("%d content blocks", len(res.Content))
	}
	if got := res.Content[1].Text; got != "Result truncated at 512 KB; narrow the request (fewer periods or a smaller scope)." {
		t.Fatalf("note = %q", got)
	}
	head := res.Content[0].Text
	if !utf8.ValidString(head) || !strings.HasPrefix(string(big), head) || len(head) == 0 {
		t.Fatal("truncated text is not a valid prefix of the result")
	}
	enc, _ := json.Marshal(head)
	if len(enc) > mcp.ResultLimit {
		t.Fatalf("encoded text is %d bytes, over the limit", len(enc))
	}
}

func TestResultUnderLimitIsWhole(t *testing.T) {
	body := []byte(`{"rows":[1,2,3]}` + "\n")
	res := callFake(t, fakeDispatcher{status: 200, body: body})
	if res.IsError || len(res.Content) != 1 || res.Content[0].Text != `{"rows":[1,2,3]}` {
		t.Fatalf("result = %+v", res)
	}
	if !reflect.DeepEqual(res.StructuredContent, map[string]any{"rows": []any{1.0, 2.0, 3.0}}) {
		t.Fatalf("structured = %v", res.StructuredContent)
	}
	res = callFake(t, fakeDispatcher{status: 204})
	if res.IsError || len(res.Content) != 1 || !strings.Contains(res.Content[0].Text, "204") {
		t.Fatalf("204 result = %+v", res)
	}
}

func TestErrorResultCarriesDetails(t *testing.T) {
	body := []byte(`{"error":{"code":"invalid","message":"request validation failed","details":[{"path":"periods","message":"at most 24"}]}}`)
	res := callFake(t, fakeDispatcher{status: 400, body: body})
	if !res.IsError {
		t.Fatal("not an error")
	}
	txt := res.text()
	for _, want := range []string{"400", "invalid", "request validation failed", "periods: at most 24"} {
		if !strings.Contains(txt, want) {
			t.Errorf("text %q lacks %q", txt, want)
		}
	}
	if res.StructuredContent["error"] == nil {
		t.Errorf("structured = %v", res.StructuredContent)
	}
}

func TestHTTPDispatcherRequiresPrincipal(t *testing.T) {
	d := mcp.NewHTTPDispatcher(http.NotFoundHandler(), auth.ChannelMCP)
	if _, _, err := d.Call(context.Background(), bigTool, nil); err == nil {
		t.Fatal("no error without a principal")
	}
}

func TestHTTPDispatcherBuildsTheRequest(t *testing.T) {
	var got *http.Request
	var gotBody []byte
	var gotChannel string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		gotBody, _ = io.ReadAll(r.Body)
		p, _ := auth.FromContext(r.Context())
		gotChannel = p.Channel
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	tool := mcp.Tool{Name: "put_x", Method: "PUT", PathTemplate: "/scorecards/{sc}/reports/{period}/summary",
		PathParams: []string{"sc", "period"}, QueryParams: []string{"tags", "full"}, HasBody: true}
	ctx := auth.WithPrincipal(context.Background(), auth.Principal{UserID: "u1", Channel: auth.ChannelToken})
	status, body, err := mcp.NewHTTPDispatcher(h, auth.ChannelMCP).Call(ctx, tool, map[string]any{
		"sc": "a b/c", "period": "2026-M09", "tags": []any{"x", "y"}, "full": true, "body": map[string]any{"text": "hi"},
	})
	if err != nil || status != 201 || string(body) != `{"ok":true}` {
		t.Fatalf("call = %d %s %v", status, body, err)
	}
	if got.Method != "PUT" || got.URL.EscapedPath() != "/v1/scorecards/a%20b%2Fc/reports/2026-M09/summary" {
		t.Errorf("request %s %s", got.Method, got.URL.EscapedPath())
	}
	if q := got.URL.Query(); !slices.Equal(q["tags"], []string{"x", "y"}) || q.Get("full") != "true" {
		t.Errorf("query = %v", q)
	}
	if !bytes.Equal(bytes.TrimSpace(gotBody), []byte(`{"text":"hi"}`)) || got.Header.Get("Content-Type") != "application/json" {
		t.Errorf("body %q type %q", gotBody, got.Header.Get("Content-Type"))
	}
	if gotChannel != auth.ChannelMCP {
		t.Errorf("channel = %q", gotChannel)
	}
}
