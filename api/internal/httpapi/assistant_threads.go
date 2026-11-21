package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"opsvision/internal/assistant"
	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/mcp"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Assistant thread limits.
const (
	// maxThreadsPerUser is how many threads a user keeps; creating another
	// deletes the least recently used.
	maxThreadsPerUser = 50
	// maxThreadMessages bounds a thread so that it reads back well under
	// the load balancer's response limit (questions are at most
	// maxQuestionRunes and answers at most assistant.MaxAnswerRunes).
	maxThreadMessages = 60
	maxQuestionRunes  = 4000
	maxTitleRunes     = 60
	maxScopeLen       = 64
	newThreadTitle    = "New chat"
)

// Answers to a question SAM cannot take now.
const (
	msgStillAnswering = "SAM is still answering. Wait for the reply before asking again."
	msgThreadFull     = "This chat is full. Start a new chat."
	msgCouldNotStart  = "SAM couldn't start. Try again in a minute."
	msgNotSetUp       = "Ask SAM is not set up on this server."
)

var assistantPages = map[string]bool{"overview": true, "table": true, "report": true, "focus": true, "other": true}

// AssistantRunner returns the runner of assistant turns and summary drafts
// for this server: its store, sealer and provider, the API catalog
// dispatched through the router as the turn's user on the assistant
// channel, and the server's reports and attribution for drafts.
func (s *Server) AssistantRunner() (*assistant.Runner, error) {
	catalog, err := Tools()
	if err != nil {
		return nil, err
	}
	return &assistant.Runner{
		Store:      s.store,
		Sealer:     s.sealer,
		Provider:   s.provider,
		Catalog:    catalog,
		Dispatcher: mcp.NewHTTPDispatcher(DispatchHandler(s), auth.ChannelAssistant),
		Reports:    s,
		Summaries:  s,
		Now:        s.now,
	}, nil
}

func apiAssistantContext(c *domain.AssistantContext) *AssistantContext {
	if c == nil {
		return nil
	}
	return &AssistantContext{
		ScorecardId: optString(c.ScorecardID),
		Period:      optString(c.Period),
		Scope:       optString(c.Scope),
		MetricKey:   optString(c.MetricKey),
		Page:        AssistantContextPage(c.Page),
	}
}

// assistantContext validates an API context; problems go to pr under path.
func assistantContext(pr *problems, path string, c *AssistantContext) *domain.AssistantContext {
	if c == nil {
		return nil
	}
	val := func(p *string) string {
		if p == nil {
			return ""
		}
		return strings.TrimSpace(*p)
	}
	out := &domain.AssistantContext{
		ScorecardID: val(c.ScorecardId),
		Period:      val(c.Period),
		Scope:       val(c.Scope),
		MetricKey:   val(c.MetricKey),
		Page:        string(c.Page),
	}
	if !assistantPages[out.Page] {
		pr.add(path+".page", "must be one of overview, table, report, focus, other")
	}
	if out.ScorecardID != "" && !validID(out.ScorecardID) {
		pr.add(path+".scorecardId", "%s", idRule)
	}
	if out.Period != "" {
		if _, err := period.Parse(out.Period); err != nil {
			pr.add(path+".period", "must be a period such as 2026-M10")
		}
	}
	if out.Scope != "" && (len(out.Scope) > maxScopeLen || !validID(out.Scope)) {
		pr.add(path+".scope", "must be empty or %s", idRule)
	}
	if out.MetricKey != "" && !validKey(out.MetricKey) {
		pr.add(path+".metricKey", "%s", keyRule)
	}
	return out
}

// stale reports whether m is a pending answer old enough to count as failed.
func stale(m domain.AssistantMessage, now time.Time) bool {
	return m.Status == domain.AssistantStatusPending && now.Sub(m.CreatedAt) >= assistant.StalePending
}

func apiAssistantMessage(m domain.AssistantMessage, now time.Time) AssistantMessage {
	if stale(m, now) {
		m.Status, m.Error = domain.AssistantStatusError, assistant.MsgStale
	}
	out := AssistantMessage{
		Id: m.ID, Role: AssistantMessageRole(m.Role), Text: m.Text,
		Status: AssistantMessageStatus(m.Status), Error: optString(m.Error), CreatedAt: m.CreatedAt,
	}
	if u := m.Usage; u != nil {
		out.Usage = &AssistantUsage{Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, ToolCalls: u.ToolCalls}
	}
	return out
}

func apiAssistantThread(t domain.AssistantThread, now time.Time) AssistantThread {
	out := AssistantThread{
		Id: t.ID, Title: t.Title, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
		Context: apiAssistantContext(t.Context), Messages: make([]AssistantMessage, 0, len(t.Messages)),
	}
	for _, m := range t.Messages {
		out.Messages = append(out.Messages, apiAssistantMessage(m, now))
	}
	return out
}

// threadTitle is the start of the first question: its words on one line,
// cut at a word before maxTitleRunes.
func threadTitle(text string) string {
	s := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(s) <= maxTitleRunes {
		return s
	}
	r := []rune(s)[:maxTitleRunes]
	if i := strings.LastIndex(string(r), " "); i > maxTitleRunes/2 {
		return strings.TrimRight(string(r)[:i], " ,;:") + "…"
	}
	return string(r) + "…"
}

func (s *Server) loadThread(ctx context.Context, p auth.Principal, id string) (domain.AssistantThread, error) {
	th, err := s.store.GetThread(ctx, p.Tenant.ID, p.UserID, id)
	if errors.Is(err, store.ErrNotFound) {
		return th, notFound("no such thread")
	}
	return th, err
}

// ListAssistantThreads lists the caller's threads, most recently used first.
func (s *Server) ListAssistantThreads(ctx context.Context, _ ListAssistantThreadsRequestObject) (ListAssistantThreadsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.store.ListThreads(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	out := make([]AssistantThreadSummary, 0, len(list))
	for _, t := range list {
		out = append(out, AssistantThreadSummary{Id: t.ID, Title: t.Title, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt})
	}
	return ListAssistantThreads200JSONResponse{Threads: out}, nil
}

// CreateAssistantThread starts an empty thread for the caller, first
// deleting the least recently used threads beyond the per-user limit.
func (s *Server) CreateAssistantThread(ctx context.Context, req CreateAssistantThreadRequestObject) (CreateAssistantThreadResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	var pr problems
	var c *domain.AssistantContext
	if req.Body != nil {
		c = assistantContext(&pr, "context", req.Body.Context)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	list, err := s.store.ListThreads(ctx, p.Tenant.ID, p.UserID)
	if err != nil {
		return nil, err
	}
	for i := maxThreadsPerUser - 1; i < len(list); i++ {
		if err := s.store.DeleteThread(ctx, p.Tenant.ID, p.UserID, list[i].ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	now := s.now()
	th := domain.AssistantThread{ID: s.newID(), UserID: p.UserID, Title: newThreadTitle, Context: c, CreatedAt: now, UpdatedAt: now}
	if err := s.store.PutThread(ctx, p.Tenant.ID, th, nil, 0); err != nil {
		return nil, err
	}
	return CreateAssistantThread201JSONResponse(apiAssistantThread(th, now)), nil
}

// GetAssistantThread returns one of the caller's threads.
func (s *Server) GetAssistantThread(ctx context.Context, req GetAssistantThreadRequestObject) (GetAssistantThreadResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	th, err := s.loadThread(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	return GetAssistantThread200JSONResponse(apiAssistantThread(th, s.now())), nil
}

// DeleteAssistantThread deletes one of the caller's threads.
func (s *Server) DeleteAssistantThread(ctx context.Context, req DeleteAssistantThreadRequestObject) (DeleteAssistantThreadResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteThread(ctx, p.Tenant.ID, p.UserID, req.Id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, notFound("no such thread")
		}
		return nil, err
	}
	return DeleteAssistantThread204Response{}, nil
}

// PostAssistantMessage stores the caller's question and a pending answer and
// enqueues the turn that answers it.
func (s *Server) PostAssistantMessage(ctx context.Context, req PostAssistantMessageRequestObject) (PostAssistantMessageResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	text := strings.TrimSpace(req.Body.Text)
	switch n := utf8.RuneCountInString(text); {
	case n == 0:
		pr.add("text", "must not be empty")
	case n > maxQuestionRunes:
		pr.add("text", "must be at most %d characters", maxQuestionRunes)
	}
	c := assistantContext(&pr, "context", req.Body.Context)
	if err := pr.err(); err != nil {
		return nil, err
	}
	th, err := s.loadThread(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	if s.queue == nil || s.sealer == nil || s.provider == nil {
		return nil, assistantUnavailable(msgNotSetUp)
	}
	settings, err := s.store.GetAssistantSettings(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, conflict(assistant.MsgDisabled)
	}
	if _, err := s.store.GetCredential(ctx, p.Tenant.ID, p.UserID); errors.Is(err, store.ErrNotFound) {
		return nil, conflict(assistant.MsgNoKey)
	} else if err != nil {
		return nil, err
	}

	now := s.now()
	var writes []domain.AssistantMessage
	asked := false
	for _, m := range th.Messages {
		switch {
		case stale(m, now):
			m.Status, m.Error = domain.AssistantStatusError, assistant.MsgStale
			writes = append(writes, m)
		case m.Status == domain.AssistantStatusPending:
			return nil, conflict(msgStillAnswering)
		}
		asked = asked || m.Role == domain.AssistantRoleUser
	}
	if len(th.Messages)+2 > maxThreadMessages {
		return nil, conflict(msgThreadFull)
	}
	question := domain.AssistantMessage{ID: s.newID(), Role: domain.AssistantRoleUser, Text: text, Status: domain.AssistantStatusDone, CreatedAt: now}
	answer := domain.AssistantMessage{ID: s.newID(), Role: domain.AssistantRoleAssistant, Status: domain.AssistantStatusPending, CreatedAt: now}
	writes = append(writes, question, answer)
	if !asked && th.Title == newThreadTitle {
		th.Title = threadTitle(text)
	}
	if c != nil {
		th.Context = c
	}
	th.UpdatedAt = now
	if err := s.store.PutThread(ctx, p.Tenant.ID, th, writes, th.Revision); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, conflict(msgStillAnswering)
		}
		return nil, err
	}
	th.Revision++
	th.Messages = mergeMessages(th.Messages, writes)

	ref := assistant.TurnRef{TenantID: p.Tenant.ID, UserID: p.UserID, ThreadID: th.ID, MessageID: answer.ID}
	if err := s.queue.Enqueue(ctx, ref); err != nil {
		slog.Error("httpapi: could not enqueue an assistant turn", "tenant", p.Tenant.ID, "thread", th.ID, "err", err)
		answer.Status, answer.Error = domain.AssistantStatusError, msgCouldNotStart
		if err := s.store.PutThread(ctx, p.Tenant.ID, th, []domain.AssistantMessage{answer}, th.Revision); err != nil {
			slog.Error("httpapi: could not mark an unstarted assistant turn failed", "thread", th.ID, "err", err)
		}
		return nil, assistantUnavailable(msgCouldNotStart)
	}
	return PostAssistantMessage202JSONResponse(apiAssistantThread(th, now)), nil
}

// mergeMessages returns ms with writes applied by message ID, in thread
// order.
func mergeMessages(ms, writes []domain.AssistantMessage) []domain.AssistantMessage {
	out := make([]domain.AssistantMessage, 0, len(ms)+len(writes))
	byID := map[string]int{}
	for _, m := range ms {
		byID[m.ID] = len(out)
		out = append(out, m)
	}
	for _, w := range writes {
		if i, ok := byID[w.ID]; ok {
			out[i] = w
			continue
		}
		out = append(out, w)
	}
	store.SortMessages(out)
	return out
}
