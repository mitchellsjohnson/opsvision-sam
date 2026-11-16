package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

var draftRef = TurnRef{Kind: KindDraft, TenantID: "t1", UserID: "u1", DraftID: "d-1"}

// fakeReports returns report for any scorecard and period, or err.
type fakeReports struct {
	mu     sync.Mutex
	report DraftReport
	err    error
	calls  []fakeReportCall
}

type fakeReportCall struct {
	p                   auth.Principal
	scorecardID, period string
}

func (f *fakeReports) DraftReport(ctx context.Context, p auth.Principal, scorecardID, period string) (DraftReport, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeReportCall{p, scorecardID, period})
	return f.report, f.err
}

func exampleDraftReport() DraftReport {
	onTime := DraftMetric{
		Name: "On-time delivery", Category: "Flow", Status: "Yellow",
		Points: []DraftPoint{
			{Period: "2026-M09", Value: "91.0%", Status: "Green"},
			{Period: "2026-M10", Value: "84.3%", Status: "Yellow"},
		},
		YTD: "87.6%", Target: "90.0%",
	}
	defects := DraftMetric{
		Name: "Open defects", Category: "Flow", Status: "Red", Caption: "worst of 2 items",
		Points: []DraftPoint{
			{Period: "2026-M09", Status: "Green"},
			{Period: "2026-M10", Status: "Red"},
		},
	}
	reviews := DraftMetric{
		Name: "Reviews held", Category: "Flow",
		Points: []DraftPoint{
			{Period: "2026-M09", NAReason: "Quarterly metric"},
			{Period: "2026-M10"},
		},
	}
	return DraftReport{
		Organization: "Example Co", ScorecardName: "Delivery", Period: "2026-M10", MonthLabel: "October 2026",
		Months:         []string{"2026-M09", "2026-M10"},
		Facts:          []string{"1 metric turned red: Open defects", "not reported: Reviews held"},
		NeedsAttention: []DraftMetric{defects, onTime},
		Categories:     []DraftCategory{{Name: "Flow", Metrics: []DraftMetric{onTime, defects, reviews}}},
	}
}

type draftEnv struct {
	st       *memstore.Store
	provider *scriptProvider
	reports  *fakeReports
	runner   *Runner
}

func newDraftEnv(t *testing.T, role domain.Role, replies ...func(context.Context, MessagesRequest) (MessagesResponse, error)) *draftEnv {
	t.Helper()
	ctx := context.Background()
	st := memstore.New()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(st.CreateTenant(ctx, domain.Tenant{
		ID: "t1", Name: "Example Co", FiscalYearStartMonth: time.January,
		StatusScale: domain.DefaultStatusScale(), DefaultRole: domain.RoleViewer, CreatedAt: runnerNow,
	}))
	must(st.PutMembership(ctx, "t1", domain.Membership{
		UserID: "u1", Email: "u1@example.test", Name: "User One", Role: role,
		Scope: domain.Scope{OrgUnitIDs: []string{}, MetricKeys: []string{}}, CreatedAt: runnerNow,
	}))
	sealer, err := NewAESSealer(bytes.Repeat([]byte{5}, 32))
	must(err)
	sealed, err := sealer.Seal(ctx, []byte(runnerKey), CredentialContext("t1", "u1"))
	must(err)
	must(st.PutCredential(ctx, "t1", "u1", domain.AssistantCredential{Sealed: sealed, Last4: "WXYZ", UpdatedAt: runnerNow}))
	must(st.PutDraft(ctx, "t1", domain.AssistantDraft{
		ID: "d-1", UserID: "u1", ScorecardID: "delivery", Period: "2026-M10",
		Status: domain.AssistantStatusPending, CreatedAt: runnerNow.Add(-5 * time.Second), UpdatedAt: runnerNow.Add(-5 * time.Second),
	}, 0))
	p := &scriptProvider{replies: replies}
	reports := &fakeReports{report: exampleDraftReport()}
	return &draftEnv{st: st, provider: p, reports: reports, runner: &Runner{
		Store: st, Sealer: sealer, Provider: p, Reports: reports,
		Now: func() time.Time { return runnerNow },
	}}
}

func (e *draftEnv) run(t *testing.T) domain.AssistantDraft {
	t.Helper()
	if err := e.runner.Run(context.Background(), draftRef); err != nil {
		t.Fatalf("Run: %v", err)
	}
	return e.draft(t)
}

func (e *draftEnv) draft(t *testing.T) domain.AssistantDraft {
	t.Helper()
	d, err := e.st.GetDraft(context.Background(), "t1", "u1", "d-1")
	if err != nil {
		t.Fatal(err)
	}
	return d
}

const exampleDraftText = "October was mixed for Example Co. On-time delivery slipped to 84.3% (Yellow) from 91.0% (Green) in September. Open defects turned red. Reviews held was not reported."

func TestDraftWritesTheSummaryFromTheReport(t *testing.T) {
	e := newDraftEnv(t, domain.RoleAdmin, textReply("  "+exampleDraftText+"\n", 900, 80))
	got := e.run(t)

	if got.Status != domain.AssistantStatusDone || got.Text != exampleDraftText || got.Error != "" {
		t.Fatalf("draft = %+v", got)
	}
	wantUsage := domain.AssistantUsage{Model: domain.DefaultAssistantModel, InputTokens: 900, OutputTokens: 80}
	if got.Usage == nil || *got.Usage != wantUsage {
		t.Fatalf("usage = %+v, want %+v", got.Usage, wantUsage)
	}
	if got.Revision != 2 || !got.UpdatedAt.Equal(runnerNow) {
		t.Fatalf("draft revision %d, updated %v", got.Revision, got.UpdatedAt)
	}

	// The report is read as the user, for the draft's scorecard and month.
	if len(e.reports.calls) != 1 {
		t.Fatalf("report calls = %+v", e.reports.calls)
	}
	rc := e.reports.calls[0]
	if rc.scorecardID != "delivery" || rc.period != "2026-M10" || rc.p.UserID != "u1" || rc.p.Channel != auth.ChannelAssistant ||
		rc.p.Membership == nil || rc.p.Membership.Role != domain.RoleAdmin || rc.p.Tenant == nil || rc.p.Tenant.ID != "t1" {
		t.Fatalf("report call = %+v", rc)
	}

	// One model call: the user's key, the tenant model, no tools.
	if len(e.provider.calls) != 1 || e.provider.keys[0] != runnerKey {
		t.Fatalf("provider calls = %d, keys %v", len(e.provider.calls), e.provider.keys)
	}
	req := e.provider.calls[0]
	if req.Model != domain.DefaultAssistantModel || req.MaxTokens != MaxOutputTokens || len(req.Tools) != 0 {
		t.Fatalf("request model %q, max %d, tools %d", req.Model, req.MaxTokens, len(req.Tools))
	}
	if !strings.Contains(req.System, DraftPromptVersion) || !strings.Contains(req.System, "3 to 6 sentences") ||
		!strings.Contains(req.System, "Never invent") || !strings.Contains(req.System, "Example Co") {
		t.Fatalf("system prompt = %s", req.System)
	}
	if len(req.Messages) != 1 || req.Messages[0].Role != "user" || len(req.Messages[0].Content) != 1 {
		t.Fatalf("messages = %+v", req.Messages)
	}
	data := req.Messages[0].Content[0].Text
	for _, want := range []string{
		"Scorecard: Delivery",
		"Month: 2026-M10 (October 2026)",
		"the whole company (Example Co)",
		"- 1 metric turned red: Open defects",
		"- not reported: Reviews held",
		"Needs attention, most urgent first:\n- Open defects (Flow): Red in 2026-M10 (worst of 2 items)",
		"- On-time delivery (Flow): Yellow in 2026-M10",
		"Flow\n- On-time delivery: Yellow in 2026-M10. By month: 2026-M09 91.0% Green; 2026-M10 84.3% Yellow. Year to date 87.6%. Target 90.0%.",
		"- Reviews held: not reported in 2026-M10. By month: 2026-M09 not applicable (Quarterly metric); 2026-M10 not reported.",
	} {
		if !strings.Contains(data, want) {
			t.Errorf("report data lacks %q:\n%s", want, data)
		}
	}
	if runnerKeyIn(req) {
		t.Fatal("the key was sent to the model")
	}
}

func runnerKeyIn(req MessagesRequest) bool {
	raw, _ := json.Marshal(req)
	return strings.Contains(string(raw), runnerKey)
}

func TestDraftDataWhenNothingNeedsAttention(t *testing.T) {
	r := exampleDraftReport()
	r.Facts, r.NeedsAttention = nil, nil
	data := DraftData(r)
	for _, want := range []string{"Facts OpsVision computed for the month:\n- none", "Needs attention, most urgent first:\n- nothing"} {
		if !strings.Contains(data, want) {
			t.Errorf("data lacks %q:\n%s", want, data)
		}
	}
}

func TestDraftDataIsBounded(t *testing.T) {
	r := exampleDraftReport()
	var many []DraftMetric
	for range 2000 {
		many = append(many, DraftMetric{Name: strings.Repeat("Long metric name ", 4), Category: "Flow", Points: r.Categories[0].Metrics[0].Points})
	}
	r.Categories = []DraftCategory{{Name: "Flow", Metrics: many}}
	data := DraftData(r)
	if n := len([]rune(data)); n > MaxDraftDataRunes+200 {
		t.Fatalf("data is %d runes, want about %d at most", n, MaxDraftDataRunes)
	}
	if !strings.Contains(data, DraftDataCutNote) {
		t.Fatal("a cut report does not say it was cut")
	}
}

func TestDraftFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T, e *draftEnv)
		role  domain.Role
		reply func(context.Context, MessagesRequest) (MessagesResponse, error)
		want  string
	}{
		{"not an admin", nil, domain.RoleContributor, nil, MsgDraftNotAdmin},
		{"removed", func(t *testing.T, e *draftEnv) {
			if err := e.st.DeleteMembership(context.Background(), "t1", "u1"); err != nil {
				t.Fatal(err)
			}
		}, domain.RoleAdmin, nil, MsgNotMember},
		{"turned off", func(t *testing.T, e *draftEnv) {
			if err := e.st.PutAssistantSettings(context.Background(), "t1", domain.AssistantSettings{Enabled: false, Model: "m"}); err != nil {
				t.Fatal(err)
			}
		}, domain.RoleAdmin, nil, MsgDisabled},
		{"no key", func(t *testing.T, e *draftEnv) {
			if err := e.st.DeleteCredential(context.Background(), "t1", "u1"); err != nil {
				t.Fatal(err)
			}
		}, domain.RoleAdmin, nil, MsgDraftNoKey},
		{"scorecard gone", func(t *testing.T, e *draftEnv) { e.reports.err = store.ErrNotFound }, domain.RoleAdmin, nil, MsgDraftNoScorecard},
		{"report fails", func(t *testing.T, e *draftEnv) { e.reports.err = errors.New("engine exploded") }, domain.RoleAdmin, nil, msgDraftFailed},
		{"bad key", nil, domain.RoleAdmin, errReply(ErrBadKey), MsgBadKey},
		{"rate limited", nil, domain.RoleAdmin, errReply(ErrRateLimited), MsgRateLimited},
		{"empty answer", nil, domain.RoleAdmin, textReply("  ", 5, 0), MsgDraftNoText},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply := tc.reply
			if reply == nil {
				reply = textReply(exampleDraftText, 1, 1)
			}
			e := newDraftEnv(t, tc.role, reply)
			if tc.setup != nil {
				tc.setup(t, e)
			}
			got := e.run(t)
			if got.Status != domain.AssistantStatusError || got.Error != tc.want || got.Text != "" {
				t.Fatalf("draft = %+v, want error %q", got, tc.want)
			}
			if tc.reply == nil && len(e.provider.calls) != 0 {
				t.Fatalf("the provider was called %d times", len(e.provider.calls))
			}
		})
	}
}

func TestDraftTimesOut(t *testing.T) {
	e := newDraftEnv(t, domain.RoleAdmin, func(ctx context.Context, _ MessagesRequest) (MessagesResponse, error) {
		<-ctx.Done()
		return MessagesResponse{}, ctx.Err()
	})
	e.runner.Budget = 20 * time.Millisecond
	if got := e.run(t); got.Status != domain.AssistantStatusError || got.Error != MsgTimeout {
		t.Fatalf("draft = %+v", got)
	}
}

func TestDraftIsCutToTheSummaryLimit(t *testing.T) {
	e := newDraftEnv(t, domain.RoleAdmin, textReply(strings.Repeat("é", MaxDraftRunes+50), 1, 1))
	got := e.run(t)
	if got.Status != domain.AssistantStatusDone || len([]rune(got.Text)) != MaxDraftRunes {
		t.Fatalf("draft is %d runes, status %s", len([]rune(got.Text)), got.Status)
	}
}

func TestDraftRunIsIdempotentAndStaleAware(t *testing.T) {
	t.Run("finished", func(t *testing.T) {
		e := newDraftEnv(t, domain.RoleAdmin, textReply(exampleDraftText, 1, 1))
		first := e.run(t)
		second := e.run(t)
		if len(e.provider.calls) != 1 || second.Revision != first.Revision {
			t.Fatalf("a redelivered draft ran again: %d calls, revision %d → %d", len(e.provider.calls), first.Revision, second.Revision)
		}
	})
	t.Run("deleted", func(t *testing.T) {
		e := newDraftEnv(t, domain.RoleAdmin, textReply(exampleDraftText, 1, 1))
		if err := e.st.DeleteDraft(context.Background(), "t1", "u1", "d-1"); err != nil {
			t.Fatal(err)
		}
		if err := e.runner.Run(context.Background(), draftRef); err != nil {
			t.Fatal(err)
		}
		if len(e.provider.calls) != 0 {
			t.Fatal("a deleted draft was run")
		}
		if _, err := e.st.GetDraft(context.Background(), "t1", "u1", "d-1"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("the deleted draft came back: %v", err)
		}
	})
	t.Run("stale", func(t *testing.T) {
		e := newDraftEnv(t, domain.RoleAdmin, textReply(exampleDraftText, 1, 1))
		e.runner.Now = func() time.Time { return runnerNow.Add(StalePending) }
		got := e.run(t)
		if got.Status != domain.AssistantStatusError || got.Error != MsgStale || len(e.provider.calls) != 0 {
			t.Fatalf("draft = %+v, provider calls %d", got, len(e.provider.calls))
		}
	})
}

func TestDraftRefsTravelTheQueue(t *testing.T) {
	var got []TurnRef
	h := SQSHandler(func(_ context.Context, ref TurnRef) error {
		got = append(got, ref)
		return nil
	})
	body, err := json.Marshal(draftRef)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"kind":"draft","tenantId":"t1","userId":"u1","draftId":"d-1"}` {
		t.Fatalf("draft ref JSON = %s", body)
	}
	resp, err := h(context.Background(), events.SQSEvent{Records: []events.SQSMessage{
		{MessageId: "a", Body: string(body)},
		{MessageId: "b", Body: `{"kind":"draft","tenantId":"t1","userId":"u1"}`},
		{MessageId: "c", Body: `{"kind":"poem","tenantId":"t1","userId":"u1","draftId":"d-1"}`},
	}})
	if err != nil || len(resp.BatchItemFailures) != 0 {
		t.Fatalf("handler: %v %+v", err, resp)
	}
	if len(got) != 1 || got[0] != draftRef {
		t.Fatalf("ran %+v, want only the complete draft ref", got)
	}
}
