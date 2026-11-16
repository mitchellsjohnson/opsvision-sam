package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"
)

// Server identity and protocol versions.
const (
	ServerName    = "opsvision"
	ServerVersion = "1.0.0"
	// LatestProtocolVersion is answered to a client asking for a version
	// this server does not support.
	LatestProtocolVersion = "2025-11-25"
)

// ProtocolVersions are the MCP protocol versions this server speaks. Tools
// over Streamable HTTP with JSON responses are the same in each.
var ProtocolVersions = []string{LatestProtocolVersion, "2025-06-18", "2025-03-26", "2024-11-05"}

// ResultLimit is the largest tool result text, in bytes once encoded twice:
// as a JSON string in the response, and again when the load balancer's
// Lambda integration encodes the whole response as a JSON string. It keeps
// a whole response inside the load balancer's 1 MB limit.
const ResultLimit = 512 << 10

// structuredLimit bounds a result's text and structuredContent together, in
// bytes through the load balancer; over it, structuredContent is left out.
const structuredLimit = 600 << 10

// TruncatedNote follows a result cut at ResultLimit.
var TruncatedNote = TruncationNote(ResultLimit)

// TruncationNote is the note that follows a result cut at limit bytes.
func TruncationNote(limit int) string {
	return fmt.Sprintf("Result truncated at %d KB; narrow the request (fewer periods or a smaller scope).", limit>>10)
}

// maxRequestBytes bounds a JSON-RPC request.
const maxRequestBytes = 4 << 20

// JSON-RPC error codes.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
)

// instructions tell the client's model how to use the tools.
const instructions = "Each tool calls one OpsVision API operation as you, with your role and scope: " +
	"you can read and change only what you could in the web app. Periods are strings such as " +
	"2026-M10 (month), 2026-Q3, 2026-H2 and 2026-FY. Start with get_me and list_scorecards. " +
	"Large views are truncated at 512 KB; ask for fewer periods, subjects or metrics."

// ExtraTool is a tool served by its own function rather than one API
// operation. Run returns what an API call would: a status and a JSON body
// (an error envelope for a failure).
type ExtraTool struct {
	Tool
	Run func(ctx context.Context, args map[string]any) (status int, body []byte, err error)
}

// NewHandler serves MCP over Streamable HTTP at the path it is mounted on:
// POST takes one JSON-RPC 2.0 message and answers with JSON (a request) or
// 202 (a notification or a response); any other method is 405, since the
// server never streams. Batches are refused. There are no sessions.
//
// tools are dispatched through d with the request's context, which must
// carry the authenticated caller; extra tools run their own function. An
// HTTP error from the API becomes a tool result with isError, carrying the
// error message, and a result over ResultLimit is truncated with
// TruncatedNote.
func NewHandler(tools []Tool, d Dispatcher, extra []ExtraTool) http.Handler {
	h := &handler{d: d, byName: map[string]int{}}
	listed := make([]map[string]any, 0, len(tools)+len(extra))
	add := func(t Tool, run func(context.Context, map[string]any) (int, []byte, error)) {
		if _, dup := h.byName[t.Name]; dup {
			panic("mcp: two tools are named " + t.Name)
		}
		h.byName[t.Name] = len(h.tools)
		h.tools = append(h.tools, entry{tool: t, run: run})
		item := map[string]any{"name": t.Name, "description": t.Description, "inputSchema": t.InputSchema}
		if len(t.Annotations) > 0 {
			item["annotations"] = t.Annotations
		}
		listed = append(listed, item)
	}
	for _, t := range tools {
		add(t, nil)
	}
	for _, x := range extra {
		add(x.Tool, x.Run)
	}
	raw, err := json.Marshal(map[string]any{"tools": listed})
	if err != nil {
		panic("mcp: encode the tool list: " + err.Error())
	}
	h.list = raw
	return h
}

type entry struct {
	tool Tool
	run  func(context.Context, map[string]any) (int, []byte, error)
}

type handler struct {
	d      Dispatcher
	tools  []entry
	byName map[string]int
	list   json.RawMessage
}

// message is an incoming JSON-RPC message: a request, a notification (no
// id), or a response to the server (result or error, no method).
type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, nil, codeInvalidRequest, "use POST: this server answers with JSON and does not stream")
		return
	}
	if v := r.Header.Get("Mcp-Protocol-Version"); v != "" && !slices.Contains(ProtocolVersions, v) {
		writeError(w, http.StatusBadRequest, nil, codeInvalidRequest, "unsupported MCP-Protocol-Version "+v)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, nil, codeInvalidRequest, fmt.Sprintf("the request is larger than %d MiB", tooLarge.Limit>>20))
		return
	case err != nil:
		writeError(w, http.StatusBadRequest, nil, codeInvalidRequest, "the request body could not be read")
		return
	}
	if t := bytes.TrimLeft(raw, " \t\r\n"); len(t) > 0 && t[0] == '[' {
		writeError(w, http.StatusBadRequest, nil, codeInvalidRequest, "batch requests are not supported")
		return
	}
	var msg message
	if err := json.Unmarshal(raw, &msg); err != nil {
		writeError(w, http.StatusBadRequest, nil, codeParseError, "the request is not a JSON-RPC message")
		return
	}
	id := msg.ID
	if id != nil && !validID(id) {
		writeError(w, http.StatusBadRequest, nil, codeInvalidRequest, "id must be a string or a number")
		return
	}
	if msg.JSONRPC != "2.0" {
		writeError(w, http.StatusBadRequest, id, codeInvalidRequest, `jsonrpc must be "2.0"`)
		return
	}
	if msg.Method == "" {
		if id != nil && (msg.Result != nil || msg.Error != nil) {
			w.WriteHeader(http.StatusAccepted) // a response to the server; it sends no requests
			return
		}
		writeError(w, http.StatusBadRequest, id, codeInvalidRequest, "method is required")
		return
	}
	if id == nil {
		w.WriteHeader(http.StatusAccepted) // a notification needs no answer
		return
	}

	var result any
	var rerr *rpcError
	switch msg.Method {
	case "initialize":
		result, rerr = initialize(msg.Params)
	case "ping":
		result = struct{}{}
	case "tools/list":
		result = h.list
	case "tools/call":
		result, rerr = h.call(r.Context(), msg.Params)
	default:
		rerr = &rpcError{codeMethodNotFound, "method not found: " + msg.Method}
	}
	if rerr != nil {
		writeError(w, http.StatusOK, id, rerr.Code, rerr.Message)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// validID reports whether a request id is a string or a number.
func validID(id json.RawMessage) bool {
	var v any
	if json.Unmarshal(id, &v) != nil {
		return false
	}
	switch v.(type) {
	case string, float64:
		return true
	}
	return false
}

func initialize(params json.RawMessage) (any, *rpcError) {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcError{codeInvalidParams, "params must be an object"}
		}
	}
	version := LatestProtocolVersion
	if slices.Contains(ProtocolVersions, p.ProtocolVersion) {
		version = p.ProtocolVersion
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": ServerName, "title": "OpsVision", "version": ServerVersion},
		"instructions":    instructions,
	}, nil
}

func (h *handler) call(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	dec := json.NewDecoder(bytes.NewReader(params))
	dec.UseNumber()
	if len(params) == 0 || dec.Decode(&p) != nil {
		return nil, &rpcError{codeInvalidParams, "params must be an object with a tool name and arguments"}
	}
	i, ok := h.byName[p.Name]
	if !ok {
		return nil, &rpcError{codeInvalidParams, "unknown tool: " + p.Name}
	}
	e := h.tools[i]
	args := p.Arguments
	if args == nil {
		args = map[string]any{}
	}
	var status int
	var body []byte
	var err error
	if e.run != nil {
		status, body, err = e.run(ctx, args)
	} else {
		status, body, err = h.d.Call(ctx, e.tool, args)
	}
	var ae *ArgumentError
	switch {
	case errors.As(err, &ae):
		return ToolResult(http.StatusBadRequest, envelope("invalid", "invalid argument "+ae.Name+": "+ae.Message)), nil
	case err != nil:
		slog.Error("mcp: tool call failed", "tool", p.Name, "err", err)
		return nil, &rpcError{codeInternalError, "the tool call failed"}
	}
	return ToolResult(status, body), nil
}

// envelope is an API error envelope.
func envelope(code, message string) []byte {
	raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "message": message}})
	return raw
}

// ToolResult converts an API response to an MCP tool result. A 2xx body is
// the text content and, when it is a JSON object that fits the budget
// twice over, structuredContent as well; another status is an isError
// result whose text states the status, the error code and message, and each
// detail. Text over ResultLimit is truncated and followed by TruncatedNote.
func ToolResult(status int, body []byte) map[string]any {
	body = bytes.TrimSpace(body)
	failed := status < 200 || status > 299
	var text string
	switch {
	case failed:
		text = errorText(status, body)
	case len(body) == 0:
		text = fmt.Sprintf("Done (HTTP %d, no content).", status)
	default:
		text = string(body)
	}
	head, truncated := Truncate(text)
	out := map[string]any{"isError": failed}
	if truncated {
		out["content"] = []any{textContent(head), textContent(TruncatedNote)}
		return out
	}
	out["content"] = []any{textContent(text)}
	if len(body) == 0 || body[0] != '{' {
		return out
	}
	// Through the load balancer the text is encoded twice and the
	// structured copy, JSON in the response, once.
	textSize := encodedLen(text, 2)
	if textSize+len(body) > structuredLimit {
		return out
	}
	var obj map[string]any
	if json.Unmarshal(body, &obj) != nil {
		return out
	}
	if raw, err := json.Marshal(obj); err == nil && textSize+encodedLen(string(raw), 1) <= structuredLimit {
		out["structuredContent"] = obj
	}
	return out
}

func textContent(s string) map[string]any { return map[string]any{"type": "text", "text": s} }

// errorText describes an API error response.
func errorText(status int, body []byte) string {
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details []struct {
				Path    string `json:"path"`
				Message string `json:"message"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) != nil || env.Error.Message == "" {
		s := fmt.Sprintf("Error: HTTP %d %s", status, http.StatusText(status))
		if len(body) > 0 {
			s += ": " + string(body)
		}
		return s
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Error: HTTP %d %s: %s", status, env.Error.Code, env.Error.Message)
	for _, d := range env.Error.Details {
		if d.Path != "" {
			fmt.Fprintf(&b, "\n- %s: %s", d.Path, d.Message)
		} else {
			fmt.Fprintf(&b, "\n- %s", d.Message)
		}
	}
	return b.String()
}

// Truncate cuts s, at a character boundary, to the longest prefix that fits
// ResultLimit once encoded twice (see ResultLimit), and reports whether it
// cut. The size counts the escapes encoding/json writes (including its HTML
// escapes), so a result of quotes or markup cannot overflow the budget.
func Truncate(s string) (string, bool) { return truncate(s, ResultLimit, 2) }

// TruncateAt cuts s, at a character boundary, to the longest prefix whose
// encoding as one JSON string fits limit bytes, and reports whether it cut.
func TruncateAt(s string, limit int) (string, bool) { return truncate(s, limit, 1) }

func truncate(s string, limit, times int) (string, bool) {
	n := quotesLen(times)
	for i, r := range s {
		w := escapedLen(r, s[i:], times)
		if n+w > limit {
			return s[:i], true
		}
		n += w
	}
	return s, false
}

// encodedLen is the size of s encoded as a JSON string times times (1 or 2).
func encodedLen(s string, times int) int {
	n := quotesLen(times)
	for i, r := range s {
		n += escapedLen(r, s[i:], times)
	}
	return n
}

// quotesLen is the size of a JSON string's quotes encoded times times: the
// second encoding escapes the inner pair.
func quotesLen(times int) int {
	if times > 1 {
		return 6
	}
	return 2
}

// escapedLen is the length of the rune r starting rest encoded as JSON
// string content times times (1 or 2). The second encoding escapes the
// backslash and quote of the first one's escapes, not their letters.
func escapedLen(r rune, rest string, times int) int {
	again := times > 1
	switch {
	case r == '"' || r == '\\':
		if again {
			return 4
		}
		return 2
	case r == '\n' || r == '\r' || r == '\t':
		if again {
			return 3
		}
		return 2
	case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029':
		if again {
			return 7
		}
		return 6
	case r == utf8.RuneError:
		if _, size := utf8.DecodeRuneInString(rest); size == 1 {
			// An invalid byte, written as \ufffd.
			if again {
				return 7
			}
			return 6
		}
	}
	return utf8.RuneLen(r)
}

func writeError(w http.ResponseWriter, status int, id json.RawMessage, code int, message string) {
	if id == nil {
		id = json.RawMessage("null")
	}
	writeJSON(w, status, map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{code, message}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		slog.Error("mcp: encode response", "err", err)
		raw = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"internal error"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
