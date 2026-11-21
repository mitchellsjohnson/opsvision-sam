package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/mcp"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Turn limits.
const (
	// TurnBudget bounds a whole turn: every model call and tool call.
	TurnBudget = 90 * time.Second
	// MaxToolRounds is how many times a turn runs the tools the model asks
	// for; a turn that wants more stops with RoundsNote.
	MaxToolRounds = 8
	// MaxOutputTokens bounds each model call's reply.
	MaxOutputTokens = 2000
	// StalePending is the age at which a pending answer counts as failed:
	// the turn crashed or never ran. Reads report it as MsgStale.
	StalePending = 3 * time.Minute
	// MaxAnswerRunes bounds a stored answer; a longer one is cut with
	// CutNote.
	MaxAnswerRunes = 12000
	// historyMessages is how many earlier messages of the thread a turn
	// sends to the model.
	historyMessages = 20
	// finishTimeout bounds writing the outcome, which happens even after the
	// turn's budget is spent.
	finishTimeout = 10 * time.Second
	// minTurnBudget is the least time worth calling the model with; a job
	// with less left before it reads as stale is marked stale instead.
	minTurnBudget = 15 * time.Second
	// ToolResultLimit bounds a tool result sent to the model, in bytes of
	// encoded JSON text; a longer one is cut with mcp.TruncationNote. It is
	// well under MCP's limit: every result is sent again on each later
	// round of the turn.
	ToolResultLimit = 64 << 10
)

// RoundsNote ends an answer whose turn wanted more than MaxToolRounds rounds
// of tools.
var RoundsNote = fmt.Sprintf("_I stopped after %d rounds of looking things up. Ask a narrower question for a complete answer._", MaxToolRounds)

// CutNote ends an answer cut at MaxAnswerRunes.
const CutNote = "_(Answer cut short.)_"

// Reasons a turn fails, as shown to the user.
const (
	MsgBadKey        = "Your Claude key was rejected. Update it in My settings → Ask SAM."
	MsgNoKey         = "Add your Claude API key in My settings → Ask SAM."
	MsgKeyUnreadable = "Your Claude key could not be read. Save it again in My settings → Ask SAM."
	MsgDisabled      = "Ask SAM is turned off for this organization."
	MsgNotMember     = "You are no longer a member of this organization."
	MsgRateLimited   = "Claude is rate limiting your key. Try again in a minute."
	MsgUnavailable   = "Claude could not be reached. Try again in a minute."
	MsgTimeout       = "SAM ran out of time. Try a narrower question."
	MsgNoAnswer      = "SAM didn't produce an answer. Try asking again."
	MsgStale         = "SAM took too long. Try again."
	msgFailed        = "SAM couldn't finish. Try again."
)

// Runner runs turns: it answers a pending assistant message with the user's
// own key, reading data through the API as the user.
type Runner struct {
	Store    store.Store
	Sealer   Sealer
	Provider Provider
	// Catalog is the API tool catalog. A turn offers and runs only
	// ToolSet(Catalog), whatever the model asks for.
	Catalog []mcp.Tool
	// Dispatcher serves tool calls; the call's context carries the turn's
	// user (mcp.NewHTTPDispatcher on the API router, channel assistant).
	Dispatcher mcp.Dispatcher
	// Reports builds the report a summary draft is written from.
	Reports ReportSource
	// Summaries builds the data an exec summary draft is written from.
	Summaries MetricSummarySource
	// AppHosts are the app's own hosts, which answers may always link to,
	// besides the hosts of the turn's tool results.
	AppHosts []string
	// Now is the clock; time.Now when nil.
	Now func() time.Time
	// Budget overrides TurnBudget when positive.
	Budget time.Duration
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

// turnFailure is a turn that ends with an error message for the user.
type turnFailure struct{ msg string }

func (f *turnFailure) Error() string { return f.msg }

func fail(msg string) error { return &turnFailure{msg} }

// Run answers the pending assistant message ref names, or writes the
// pending summary draft for a KindDraft ref. It returns an error only when
// the job should be retried (the store could not be read); every other
// outcome, including provider failures, is written to the message or
// draft. One that is no longer pending, or deleted, is nothing to do, so a
// redelivered job is harmless.
func (r *Runner) Run(ctx context.Context, ref TurnRef) error {
	switch ref.Kind {
	case "":
	case KindDraft:
		return r.runAnyDraft(ctx, ref)
	default:
		slog.Error("assistant: dropping a job of an unknown kind", "kind", ref.Kind, "tenant", ref.TenantID)
		return nil
	}
	th, err := r.Store.GetThread(ctx, ref.TenantID, ref.UserID, ref.ThreadID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("assistant: load thread: %w", err)
	}
	idx := messageIndex(th.Messages, ref.MessageID)
	if idx < 0 || th.Messages[idx].Status != domain.AssistantStatusPending {
		return nil
	}
	created := th.Messages[idx].CreatedAt
	stale := func(m *domain.AssistantMessage) { m.Status, m.Error = domain.AssistantStatusError, MsgStale }
	budget, ok := r.budget(created)
	if !ok {
		return r.finish(ctx, ref, stale)
	}
	tctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	text, hosts, usage, err := r.answer(tctx, ref, th, idx)
	var tf *turnFailure
	switch {
	case r.readsStale(created):
		return r.finish(ctx, ref, func(m *domain.AssistantMessage) { stale(m); m.Usage = usage })
	case err == nil:
		return r.finish(ctx, ref, func(m *domain.AssistantMessage) {
			m.Status, m.Text, m.Usage, m.AllowedHosts = domain.AssistantStatusDone, text, usage, hosts
		})
	case errors.As(err, &tf):
		return r.finish(ctx, ref, func(m *domain.AssistantMessage) {
			m.Status, m.Error, m.Usage = domain.AssistantStatusError, tf.msg, usage
		})
	default:
		return err
	}
}

// budget is the time a job asked at created may run: TurnBudget (or
// r.Budget), cut so that it is written before reads report it as stale.
// ok is false when less than minTurnBudget is left: mark it stale instead.
func (r *Runner) budget(created time.Time) (time.Duration, bool) {
	budget := TurnBudget
	if r.Budget > 0 {
		budget = r.Budget
	}
	left := StalePending - r.now().Sub(created) - finishTimeout
	if left <= minTurnBudget {
		return 0, false
	}
	return min(budget, left), true
}

// readsStale reports whether a job asked at created already reads as stale,
// so its outcome must be written as stale too.
func (r *Runner) readsStale(created time.Time) bool {
	return r.now().Sub(created) >= StalePending
}

func messageIndex(ms []domain.AssistantMessage, id string) int {
	for i, m := range ms {
		if m.ID == id {
			return i
		}
	}
	return -1
}

// answer runs the model and tool loop for the message at idx, and returns
// the answer and the hosts its links may go to. A *turnFailure is a reason
// to show the user; any other error is to retry.
func (r *Runner) answer(ctx context.Context, ref TurnRef, th domain.AssistantThread, idx int) (string, []string, *domain.AssistantUsage, error) {
	js, err := r.start(ctx, ref, MsgNoKey, nil)
	if err != nil {
		return "", nil, nil, err
	}
	tenant, m, settings, key, p := js.tenant, js.membership, js.settings, js.key, js.principal
	tools := ToolSet(r.Catalog)
	allowed := make(map[string]mcp.Tool, len(tools))
	for _, t := range tools {
		allowed[t.Name] = t
	}
	req := MessagesRequest{
		Model: settings.Model,
		System: SystemPrompt(PromptInput{
			Today: r.now(), Calendar: period.Calendar{FiscalYearStartMonth: tenant.FiscalYearStartMonth},
			Organization: tenant.Name, Role: m.Role, Context: th.Context,
		}),
		Messages:  history(th.Messages[:idx]),
		Tools:     toolDefs(tools),
		MaxTokens: MaxOutputTokens,
	}
	usage := &domain.AssistantUsage{Model: settings.Model}
	pctx := auth.WithPrincipal(ctx, p)
	hosts := addHosts(nil, r.AppHosts...)
	for round := 1; ; round++ {
		resp, err := r.Provider.Messages(ctx, key, req)
		if err != nil {
			return "", nil, usage, fail(providerFailure(ctx, err, settings.Model))
		}
		usage.InputTokens += resp.Usage.InputTokens
		usage.OutputTokens += resp.Usage.OutputTokens
		var text []string
		var uses []Block
		for _, b := range resp.Content {
			switch b.Type {
			case "text":
				if s := strings.TrimSpace(b.Text); s != "" {
					text = append(text, s)
				}
			case "tool_use":
				uses = append(uses, b)
			}
		}
		answer := RewriteAnswerLinks(strings.Join(text, "\n\n"), hosts)
		if len(uses) == 0 {
			if answer == "" {
				return "", nil, usage, fail(MsgNoAnswer)
			}
			return cut(answer), hosts, usage, nil
		}
		if round > MaxToolRounds {
			if answer == "" {
				return RoundsNote, hosts, usage, nil
			}
			return cut(answer) + "\n\n" + RoundsNote, hosts, usage, nil
		}
		assistantTurn := replayable(resp.Content)
		results := make([]Block, 0, len(uses))
		for _, u := range uses {
			usage.ToolCalls++
			res, named := r.callTool(pctx, allowed, u)
			results = append(results, res)
			hosts = addHosts(hosts, named...)
		}
		req.Messages = append(req.Messages,
			Message{Role: "assistant", Content: assistantTurn},
			Message{Role: "user", Content: results})
	}
}

// addHosts appends the hosts in more that hosts lacks, lowercase.
func addHosts(hosts []string, more ...string) []string {
	for _, h := range more {
		if h = strings.ToLower(h); h != "" && !slices.Contains(hosts, h) {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

// replayable is the model's reply as it is sent back on the next round:
// without empty text blocks, which the provider refuses, and with every
// tool use's input a JSON object.
func replayable(content []Block) []Block {
	out := make([]Block, 0, len(content))
	for _, b := range content {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
		case "tool_use":
			if t := bytes.TrimSpace(b.Input); len(t) == 0 || t[0] != '{' || !json.Valid(t) {
				b.Input = json.RawMessage("{}")
			}
		}
		out = append(out, b)
	}
	return out
}

// jobStart is what every job needs before it calls the model.
type jobStart struct {
	tenant     domain.Tenant
	membership domain.Membership
	settings   domain.AssistantSettings
	key        string
	// principal is the job's user on the assistant channel.
	principal auth.Principal
}

// start loads the job's tenant, the user's current membership, the
// tenant's settings, and the user's key. A removed user, a turned-off
// assistant, and a missing (noKey) or unreadable key are failures. allow,
// when set, checks the user before the key is opened; its error ends the
// job.
func (r *Runner) start(ctx context.Context, ref TurnRef, noKey string, allow func(auth.Principal) error) (jobStart, error) {
	var js jobStart
	tenant, err := r.Store.GetTenant(ctx, ref.TenantID)
	if errors.Is(err, store.ErrNotFound) {
		return js, fail(MsgNotMember)
	}
	if err != nil {
		return js, err
	}
	m, err := r.Store.GetMembership(ctx, ref.TenantID, ref.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return js, fail(MsgNotMember)
	}
	if err != nil {
		return js, err
	}
	settings, err := r.Store.GetAssistantSettings(ctx, ref.TenantID)
	if err != nil {
		return js, err
	}
	if !settings.Enabled {
		return js, fail(MsgDisabled)
	}
	js = jobStart{tenant: tenant, membership: m, settings: settings}
	js.principal = auth.Principal{
		UserID: ref.UserID, Email: m.Email, Name: m.Name,
		Tenant: &js.tenant, Membership: &js.membership, Channel: auth.ChannelAssistant,
	}
	if allow != nil {
		if err := allow(js.principal); err != nil {
			return js, err
		}
	}
	if js.key, err = r.openKey(ctx, ref, noKey); err != nil {
		return js, err
	}
	return js, nil
}

// openKey reads and opens the user's credential. A key that is missing
// (noKey), or cannot be opened (the server's credential key changed), is a
// failure the user can fix by saving the key again.
func (r *Runner) openKey(ctx context.Context, ref TurnRef, noKey string) (string, error) {
	cred, err := r.Store.GetCredential(ctx, ref.TenantID, ref.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return "", fail(noKey)
	}
	if err != nil {
		return "", err
	}
	if r.Sealer == nil {
		return "", fail(MsgKeyUnreadable)
	}
	plain, err := r.Sealer.Open(ctx, cred.Sealed, CredentialContext(ref.TenantID, ref.UserID))
	if err != nil {
		slog.Warn("assistant: a saved key could not be opened", "tenant", ref.TenantID, "err", err)
		return "", fail(MsgKeyUnreadable)
	}
	return string(plain), nil
}

// history turns the thread's earlier messages into the conversation sent to
// the model: answered questions and answers only, at most historyMessages,
// starting with a question, consecutive messages of one role merged.
func history(ms []domain.AssistantMessage) []Message {
	var out []Message
	for _, m := range ms {
		if m.Status != domain.AssistantStatusDone || strings.TrimSpace(m.Text) == "" {
			continue
		}
		role := "user"
		if m.Role == domain.AssistantRoleAssistant {
			role = "assistant"
		}
		b := Block{Type: "text", Text: m.Text}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, b)
			continue
		}
		out = append(out, Message{Role: role, Content: []Block{b}})
	}
	if len(out) > historyMessages {
		out = out[len(out)-historyMessages:]
	}
	for len(out) > 0 && out[0].Role != "user" {
		out = out[1:]
	}
	return out
}

// callTool runs one tool_use block and returns its tool_result and the hosts
// of the URL fields of a successful result (URLHosts), which the answer may
// link to. Only tools in allowed and the help tools run; anything else is
// refused here, before any request is made.
func (r *Runner) callTool(ctx context.Context, allowed map[string]mcp.Tool, u Block) (Block, []string) {
	result := func(content string, isErr bool) (Block, []string) {
		var hosts []string
		if !isErr {
			hosts = URLHosts(content)
		}
		if head, cut := mcp.TruncateAt(content, ToolResultLimit); cut {
			content = head + "\n\n" + mcp.TruncationNote(ToolResultLimit)
		}
		return Block{Type: "tool_result", ToolUseID: u.ID, Content: content, IsError: isErr}, hosts
	}
	args := map[string]any{}
	if len(u.Input) > 0 {
		dec := json.NewDecoder(bytes.NewReader(u.Input))
		dec.UseNumber()
		if err := dec.Decode(&args); err != nil {
			return result("Invalid arguments: they must be a JSON object.", true)
		}
	}
	if u.Name == SearchHelpTool || u.Name == GetHelpTopicTool {
		return result(runHelp(u.Name, args))
	}
	t, ok := allowed[u.Name]
	if !ok {
		return result(fmt.Sprintf("Tool %q is not available. SAM can only read scorecard data and help topics.", u.Name), true)
	}
	status, body, err := r.Dispatcher.Call(ctx, t, args)
	var ae *mcp.ArgumentError
	switch {
	case errors.As(err, &ae):
		return result("Invalid "+err.Error(), true)
	case err != nil:
		slog.Error("assistant: tool call failed", "tool", t.Name, "err", err)
		return result("The tool failed. Try a different request.", true)
	case status == http.StatusNoContent:
		return result("Done (HTTP 204, no content).", false)
	case status >= 200 && status <= 299:
		return result(strings.TrimSpace(string(body)), false)
	}
	return result(fmt.Sprintf("Error: HTTP %d: %s", status, strings.TrimSpace(string(body))), true)
}

// providerFailure is the user-facing reason for a failed model call.
func providerFailure(ctx context.Context, err error, model string) string {
	var ae *APIError
	switch {
	case errors.Is(err, ErrBadKey):
		return MsgBadKey
	case ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded):
		return MsgTimeout
	case errors.Is(err, ErrRateLimited):
		return MsgRateLimited
	case errors.Is(err, ErrUnavailable):
		return MsgUnavailable
	case errors.As(err, &ae):
		slog.Warn("assistant: the provider refused a turn", "model", model, "status", ae.Status, "type", ae.Type)
		if ae.RefusesModel(model) {
			return "The model " + model + " was not accepted by Claude. An admin can change the model in Ask SAM settings."
		}
		return "Claude did not accept the request: " + ae.ShownMessage()
	}
	slog.Error("assistant: model call failed", "err", err)
	return msgFailed
}

// cut bounds an answer at MaxAnswerRunes.
func cut(s string) string {
	if utf8.RuneCountInString(s) <= MaxAnswerRunes {
		return s
	}
	return string([]rune(s)[:MaxAnswerRunes]) + "\n\n" + CutNote
}

// finish writes the outcome to the message if it is still pending, retrying
// on a concurrent save. It runs on its own deadline, so a turn that ran out
// of time still records why.
func (r *Runner) finish(ctx context.Context, ref TurnRef, set func(*domain.AssistantMessage)) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finishTimeout)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		th, err := r.Store.GetThread(ctx, ref.TenantID, ref.UserID, ref.ThreadID)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("assistant: load thread: %w", err)
		}
		i := messageIndex(th.Messages, ref.MessageID)
		if i < 0 || th.Messages[i].Status != domain.AssistantStatusPending {
			return nil
		}
		m := th.Messages[i]
		set(&m)
		th.UpdatedAt = r.now()
		err = r.Store.PutThread(ctx, ref.TenantID, th, []domain.AssistantMessage{m}, th.Revision)
		if errors.Is(err, store.ErrConflict) {
			continue
		}
		if err != nil {
			return fmt.Errorf("assistant: save answer: %w", err)
		}
		return nil
	}
	return fmt.Errorf("assistant: save answer: the thread kept changing")
}
