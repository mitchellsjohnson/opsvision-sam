package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

const demoSummaries = "/scorecards/" + demo.ScorecardID + "/metric-summaries"

var oct2026 = period.Period{Grain: period.Month, FY: 2026, Index: 10}

const onlyAdmins = "Only admins can write exec summaries."

type metricSummaryJSON struct {
	MetricKey         string `json:"metricKey"`
	MetricName        string `json:"metricName"`
	CategoryID        string `json:"categoryId"`
	Period            string `json:"period"`
	Requirement       string `json:"requirement"`
	RequirementReason string `json:"requirementReason"`
	State             string `json:"state"`
	Standing          struct {
		Display  string `json:"display"`
		Status   string `json:"status"`
		Headline string `json:"headline"`
	} `json:"standing"`
	Text         string    `json:"text"`
	Links        []rcaLink `json:"links"`
	LinksTotal   int       `json:"linksTotal"`
	AuthorName   string    `json:"authorName"`
	Channel      string    `json:"channel"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Revision     int       `json:"revision"`
	Stale        bool      `json:"stale"`
	StaleReasons []string  `json:"staleReasons"`
	CanEdit      bool      `json:"canEdit"`
}

type summaryConflictJSON struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Current *metricSummaryJSON `json:"current"`
}

type rcaLink = map[string]string

func summaryPath(metric string, p string) string { return demoSummaries + "/" + metric + "/" + p }

func summaryBody(text string, links []rcaLink, rev int) map[string]any {
	if links == nil {
		links = []rcaLink{}
	}
	return map[string]any{"text": text, "links": links, "expectedRevision": rev}
}

// demoRootID is the demo's company: the org tree's single root in 2026-M10.
func demoRootID(t *testing.T, e *testEnv) string {
	t.Helper()
	tenant, err := e.store.GetTenant(context.Background(), demo.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	in, err := e.api.loadInput(context.Background(), tenant, demo.ScorecardID, nil)
	if err != nil {
		t.Fatal(err)
	}
	root := reportRoot(in, oct2026)
	if root == "" {
		t.Fatal("the demo has no single root")
	}
	return root
}

// storedSummary is the metric's summary of p, stored on the company.
func storedSummary(t *testing.T, e *testEnv, metric string, p period.Period) (domain.CellRCA, bool) {
	t.Helper()
	r, err := e.store.GetRCA(context.Background(), demo.TenantID, demo.ScorecardID, metric, demoRootID(t, e), p)
	if errors.Is(err, store.ErrNotFound) {
		return r, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return r, true
}

// clearSummaries deletes every summary and note the demo seeds for fiscal
// 2026, for tests that write from scratch.
func clearSummaries(t *testing.T, e *testEnv) {
	t.Helper()
	ctx := context.Background()
	all, err := e.store.ListRCAsRange(ctx, demo.TenantID, demo.ScorecardID,
		period.Period{Grain: period.Month, FY: 2026, Index: 1}, period.Period{Grain: period.Month, FY: 2026, Index: 12})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range all {
		if err := e.store.DeleteRCA(ctx, demo.TenantID, demo.ScorecardID, r.MetricKey, r.SubjectID, r.Period, r.Revision); err != nil {
			t.Fatal(err)
		}
	}
}

// demoAudits lists every audit entry of the demo tenant, whose clock is demoNow.
func demoAudits(t *testing.T, e *testEnv) []domain.AuditEntry {
	t.Helper()
	out, err := e.store.ListAudit(context.Background(), demo.TenantID, time.Time{}, demoNow.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPutMetricSummaryAdminOnly(t *testing.T) {
	e := newDemoEnv(t)
	clearSummaries(t, e)
	admin, contributor, viewer := e.tokens["admin"], e.tokens["contributor"], e.tokens["viewer"]
	root := demoRootID(t, e)

	// The admin's browser session.
	var got metricSummaryJSON
	e.expect(t, 200, admin, "PUT", summaryPath("uptime", "2026-M10"), summaryBody("Webhooks lost 7h to a queue saturation (INC-2041).", nil, 0), &got)
	if got.MetricKey != "uptime" || got.MetricName != "Uptime" || got.Period != "2026-M10" || got.Revision != 1 || got.Channel != "web" ||
		got.AuthorName != "Avery Admin" || got.State != "written" || got.Stale || got.StaleReasons == nil || !got.CanEdit || got.LinksTotal != 0 {
		t.Fatalf("admin put = %+v", got)
	}
	// 21 of the demo's 24 services report in October; 13 are below 100%.
	if got.Requirement != "required" || got.RequirementReason != "13 of 21 services below 100%" {
		t.Errorf("requirement = %q %q", got.Requirement, got.RequirementReason)
	}
	if got.Standing.Display != "99.06%" || got.Standing.Status != "R" || got.Standing.Headline != "13 of 21 services below 100% · worst Webhooks 99.06%" {
		t.Errorf("standing = %+v", got.Standing)
	}
	r, ok := storedSummary(t, e, "uptime", oct2026)
	if !ok || r.SubjectID != root || r.Revision != 1 || r.Channel != "web" || r.AuthorID != "dev|admin" {
		t.Fatalf("stored = %+v", r)
	}

	// The admin's access token is api; the admin through MCP is mcp.
	tok := e.createToken(t, admin, "Script")
	e.expect(t, 200, tok.Token, "PUT", summaryPath("deployment_uptime", "2026-M10"), summaryBody("Two regional deployments lost their checks.", nil, 0), &got)
	if got.Channel != "api" {
		t.Errorf("token channel = %q", got.Channel)
	}
	out := mcpToolCall(t, e, admin, "put_metric_summary", map[string]any{
		"sc": demo.ScorecardID, "metric": "security_training", "period": "2026-M10", "body": summaryBody("Six new starters are still in training.", nil, 0),
	})
	if out.IsError {
		t.Fatalf("put_metric_summary: %s", out.Text)
	}
	if r, ok := storedSummary(t, e, "security_training", oct2026); !ok || r.Channel != "mcp" || r.SubjectID != root {
		t.Fatalf("MCP summary = %+v", r)
	}
	var channels []string
	for _, a := range demoAudits(t, e) {
		if a.TargetType == "metric_summary" {
			channels = append(channels, a.Channel)
		}
	}
	if strings.Join(channels, ",") != "ui,token,mcp" {
		t.Fatalf("audit channels after three writes = %v", channels)
	}

	// Everyone else gets 403 on every channel, and nothing is stored or audited.
	ctok := e.createToken(t, contributor, "Contributor script")
	vtok := e.createToken(t, viewer, "Viewer script")
	audited := demoAudits(t, e)
	for name, caller := range map[string]string{"contributor session": contributor, "contributor token": ctok.Token, "viewer session": viewer, "viewer token": vtok.Token} {
		for _, metric := range []string{"epics_on_time", "uptime"} {
			got := e.expectError(t, 403, "forbidden", caller, "PUT", summaryPath(metric, "2026-M10"), summaryBody("Not mine to write.", nil, 0))
			if got.Error.Message != onlyAdmins {
				t.Errorf("%s put %s: message %q", name, metric, got.Error.Message)
			}
			got = e.expectError(t, 403, "forbidden", caller, "DELETE", summaryPath(metric, "2026-M10")+"?expectedRevision=1", nil)
			if got.Error.Message != onlyAdmins {
				t.Errorf("%s delete %s: message %q", name, metric, got.Error.Message)
			}
		}
	}
	for _, caller := range []string{contributor, viewer} {
		out := mcpToolCall(t, e, caller, "put_metric_summary", map[string]any{
			"sc": demo.ScorecardID, "metric": "epics_on_time", "period": "2026-M10", "body": summaryBody("Through MCP.", nil, 0),
		})
		if !out.IsError || !strings.Contains(out.Text, onlyAdmins) {
			t.Errorf("MCP put by a non-admin: %+v", out)
		}
	}
	// A malformed body from a non-admin is still 403, not a validation answer.
	e.expectError(t, 403, "forbidden", contributor, "PUT", summaryPath("uptime", "2026-M10"), summaryBody("", []rcaLink{{"title": "x", "url": "javascript:x"}}, -1))
	if _, ok := storedSummary(t, e, "epics_on_time", oct2026); ok {
		t.Fatal("a refused write was stored")
	}
	if r, _ := storedSummary(t, e, "uptime", oct2026); r.Revision != 1 {
		t.Fatalf("uptime summary = %+v after refused writes", r)
	}
	if n := len(demoAudits(t, e)); n != len(audited) {
		t.Fatalf("refused writes added %d audit entries", n-len(audited))
	}
}

func TestPutMetricSummaryLinks(t *testing.T) {
	e := newDemoEnv(t)
	clearSummaries(t, e)
	admin := e.tokens["admin"]
	path := summaryPath("uptime", "2026-M10")
	ticket := func(i int) rcaLink {
		return rcaLink{"title": fmt.Sprintf("INC-%d", 2000+i), "url": fmt.Sprintf("https://tracker.example/browse/INC-%d", 2000+i)}
	}
	var links []rcaLink
	for i := range 25 {
		links = append(links, ticket(i))
	}
	var got metricSummaryJSON
	e.expect(t, 200, admin, "PUT", path, summaryBody("Twenty-five tickets.", links, 0), &got)
	if len(got.Links) != 25 || got.LinksTotal != 25 || got.Links[24]["url"] != "https://tracker.example/browse/INC-2024" {
		t.Fatalf("25 links: %d stored, total %d", len(got.Links), got.LinksTotal)
	}

	ok := rcaLink{"title": "Postmortem", "url": "https://docs.example/pm/2041"}
	long := func(i int) rcaLink {
		u := fmt.Sprintf("https://docs.example/%02d/", i)
		return rcaLink{"title": "T", "url": u + strings.Repeat("x", 700)}
	}
	var tooLong []rcaLink
	for i := range 25 {
		tooLong = append(tooLong, long(i))
	}
	const https = "Use a link that starts with https://"
	cases := []struct {
		name  string
		text  string
		links []rcaLink
		path  string
		msg   string
	}{
		{"26 links", "Gap.", append(slices.Clone(links), ticket(25)), "links", "Up to 25 links"},
		{"25 links over 16 KB", "Gap.", tooLong, "links", "These links are too long together; shorten or remove some"},
		{"javascript URL", "Gap.", []rcaLink{ok, {"title": "Click", "url": "javascript:alert(1)"}}, "links[1].url", https},
		{"http URL", "Gap.", []rcaLink{ok, {"title": "Plain", "url": "http://docs.example/a"}}, "links[1].url", https},
		{"user and password", "Gap.", []rcaLink{ok, {"title": "Creds", "url": "https://user:secret@docs.example/a"}}, "links[1].url", https},
		{"whitespace", "Gap.", []rcaLink{ok, {"title": "Space", "url": "https://docs.example/a b"}}, "links[1].url", https},
		{"duplicate", "Gap.", []rcaLink{ok, {"title": "Again", "url": "HTTPS://docs.example/pm/2041"}}, "links[1].url", "This link is already listed"},
		{"no title", "Gap.", []rcaLink{ok, {"title": "  ", "url": "https://docs.example/x"}}, "links[1].title", "Add a title for this link"},
		{"281 code points", strings.Repeat("é", 281), nil, "text", "Write up to 280 characters"},
		{"only newlines", "\n\n\n", nil, "text", "Write what drove this metric this month"},
	}
	for _, c := range cases {
		got := e.expectError(t, 400, "invalid", admin, "PUT", path, summaryBody(c.text, c.links, 1))
		found := false
		for _, d := range got.Error.Details {
			if d.Path == c.path && d.Message == c.msg {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: details %+v, want %s %q", c.name, got.Error.Details, c.path, c.msg)
		}
	}

	// The request itself: the metric, the period, its grain and the revision.
	for _, c := range []struct{ metric, period string }{
		{"Uptime", "2026-M10"}, {"uptime", "2026-10"}, {"no_such_metric", "2026-M10"}, {"uptime", "2026-Q4"},
	} {
		e.expectError(t, 400, "invalid", admin, "PUT", summaryPath(c.metric, c.period), summaryBody("x", nil, 0))
	}
	e.expectError(t, 400, "invalid", admin, "PUT", path, summaryBody("x", nil, -1))
	e.expectError(t, 404, "not_found", admin, "PUT", "/scorecards/no-such-scorecard/metric-summaries/uptime/2026-M10", summaryBody("x", nil, 0))

	// Plain text passes as written; the scheme is stored lowercased and
	// whitespace collapsed.
	img := `<img src=x onerror="alert(1)">`
	e.expect(t, 200, admin, "PUT", path, summaryBody("  Queue saturated\n\nafter  a deploy "+img, []rcaLink{
		{"title": " " + img + " ", "url": "HTTPS://docs.example/a"},
	}, 1), &got)
	if got.Text != "Queue saturated after a deploy "+img || len(got.Links) != 1 || got.Links[0]["url"] != "https://docs.example/a" || got.Links[0]["title"] != img {
		t.Fatalf("summary = %+v", got)
	}
	stored, _ := storedSummary(t, e, "uptime", oct2026)
	if stored.Links[0].URL != "https://docs.example/a" || stored.Text != got.Text || stored.Revision != 2 {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestMetricSummaryRevisionsAndAudit(t *testing.T) {
	e := newDemoEnv(t)
	clearSummaries(t, e)
	admin := e.tokens["admin"]
	path := summaryPath("uptime", "2026-M10")
	links := []rcaLink{{"title": "Postmortem", "url": "https://docs.example/pm/2041"}}
	e.expect(t, 200, admin, "PUT", path, summaryBody("Queue saturated.", links, 0), nil)
	e.expect(t, 200, admin, "PUT", path, summaryBody("Queue saturated after a deploy.", links, 1), nil)
	var got metricSummaryJSON
	e.expect(t, 200, admin, "PUT", path, summaryBody(" Queue saturated after a deploy. ", links, 2), &got)
	if got.Revision != 3 {
		t.Fatalf("confirm = %+v", got)
	}

	// A stale expectedRevision is 409 with the summary as stored now.
	for _, rev := range []int{0, 2, 4} {
		status, raw := e.call(t, admin, "PUT", path, summaryBody("Mine is newer.", nil, rev))
		var c summaryConflictJSON
		if err := json.Unmarshal(raw, &c); err != nil || status != 409 || c.Error.Code != "conflict" {
			t.Fatalf("stale put %d: %d %s", rev, status, raw)
		}
		if c.Error.Message != "Someone else changed this exec summary while you were editing." {
			t.Errorf("conflict message %q", c.Error.Message)
		}
		if c.Current == nil || c.Current.Revision != 3 || c.Current.Text != "Queue saturated after a deploy." || c.Current.MetricKey != "uptime" ||
			c.Current.State != "written" || len(c.Current.Links) != 1 {
			t.Fatalf("stale put %d: current = %+v", rev, c.Current)
		}
	}
	status, raw := e.call(t, admin, "DELETE", path+"?expectedRevision=2", nil)
	var c summaryConflictJSON
	if err := json.Unmarshal(raw, &c); err != nil || status != 409 || c.Current == nil || c.Current.Revision != 3 {
		t.Fatalf("stale delete: %d %s", status, raw)
	}

	status, raw = e.call(t, admin, "DELETE", path+"?expectedRevision=3", nil)
	if status != 204 || len(raw) != 0 {
		t.Fatalf("delete: %d %s", status, raw)
	}
	if _, ok := storedSummary(t, e, "uptime", oct2026); ok {
		t.Fatal("deleted summary still stored")
	}
	e.expectError(t, 404, "not_found", admin, "DELETE", path+"?expectedRevision=1", nil)
	e.expectError(t, 400, "invalid", admin, "DELETE", path+"?expectedRevision=0", nil)

	entries := demoAudits(t, e)
	var actions []string
	for _, a := range entries {
		if a.TargetType != "metric_summary" || a.TargetID != "uptime|2026-M10" || a.ActorID != "dev|admin" {
			t.Errorf("entry = %+v", a)
		}
		actions = append(actions, a.Action)
	}
	if strings.Join(actions, ",") != "create,update,confirm,delete" {
		t.Fatalf("actions = %v", actions)
	}
	if entries[0].Before != nil || entries[3].After != nil {
		t.Errorf("create before %s, delete after %s", entries[0].Before, entries[3].After)
	}
	var deleted struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(entries[3].Before, &deleted); err != nil || deleted.Text != "Queue saturated after a deploy." {
		t.Errorf("delete keeps %s", entries[3].Before)
	}
}

func TestMetricSummaryBasis(t *testing.T) {
	e := newDemoEnv(t)
	clearSummaries(t, e)
	admin := e.tokens["admin"]

	// Uptime has no company value: its standing is the worst service, its
	// evidence the services below 100% and the incidents counted on them.
	e.expect(t, 200, admin, "PUT", summaryPath("uptime", "2026-M10"), summaryBody("Queue saturated.", nil, 0), nil)
	r, _ := storedSummary(t, e, "uptime", oct2026)
	if r.Basis.Display != "99.06%" || r.Basis.Status != "R" {
		t.Fatalf("basis = %+v", r.Basis)
	}
	ev := r.Basis.Evidence
	var subjects, incidents []string
	for _, k := range ev {
		switch {
		case strings.HasPrefix(k, "subject:"):
			if len(incidents) > 0 {
				t.Errorf("subject %s after incidents: %v", k, ev)
			}
			subjects = append(subjects, strings.TrimPrefix(k, "subject:"))
		default:
			incidents = append(incidents, k)
		}
	}
	for _, want := range []string{"webhooks", "search", "analytics-ingest"} {
		if !slices.Contains(subjects, want) {
			t.Errorf("subject evidence %v lacks %s", subjects, want)
		}
	}
	if !slices.IsSorted(subjects) || !slices.IsSorted(incidents) {
		t.Errorf("evidence not sorted: %v", ev)
	}
	// The tracker template fans rows out per component; cancelled and
	// planned-maintenance incidents never count.
	for _, want := range []string{"incident-tracker:INC-2041@Webhooks", "incident-tracker:INC-2047@Webhooks", "incident-tracker:INC-2049@Webhooks", "incident-tracker:INC-2049@Search"} {
		if !slices.Contains(incidents, want) {
			t.Errorf("incident evidence %v lacks %s", incidents, want)
		}
	}
	// Only incidents on services count for uptime: the deployment incidents
	// explain deployment uptime.
	for _, k := range incidents {
		if strings.Contains(k, "INC-2058") || strings.Contains(k, "INC-2055") || strings.Contains(k, "Notification Relay") {
			t.Errorf("incident evidence counts %s", k)
		}
	}
	if !r.CreatedAt.Equal(demoNow) || !r.UpdatedAt.Equal(demoNow) {
		t.Errorf("times = %v %v", r.CreatedAt, r.UpdatedAt)
	}

	// A metric with a company value is judged on it.
	var got metricSummaryJSON
	e.expect(t, 200, admin, "PUT", summaryPath("epics_on_time", "2026-M10"), summaryBody("Two epics slipped.", nil, 0), &got)
	r, _ = storedSummary(t, e, "epics_on_time", oct2026)
	if r.Basis.ReportedMinutes != nil || r.Basis.Display == "" || r.Basis.Display != got.Standing.Display || r.Basis.Status != got.Standing.Status {
		t.Fatalf("epics basis = %+v, standing %+v", r.Basis, got.Standing)
	}
	for _, k := range r.Basis.Evidence {
		if !strings.HasPrefix(k, "subject:") {
			t.Errorf("epics evidence has %s", k)
		}
	}
}

func TestCapEvidence(t *testing.T) {
	var subjects, incidents []string
	for i := range 150 {
		subjects = append(subjects, fmt.Sprintf("subject:s%03d", i))
		incidents = append(incidents, fmt.Sprintf("src:INC-%03d", i))
	}
	got := capEvidence(subjects, incidents)
	if len(got) != domain.MaxRCAEvidence || got[0] != "subject:s000" || got[149] != "subject:s149" || got[150] != "src:INC-000" || got[199] != "src:INC-049" {
		t.Fatalf("capEvidence = %d entries, %v … %v", len(got), got[:2], got[len(got)-2:])
	}
	if got := capEvidence(nil, nil); got == nil || len(got) != 0 {
		t.Fatalf("capEvidence(nil, nil) = %#v", got)
	}
}

func TestLoadIncidents(t *testing.T) {
	e := newDemoEnv(t)
	got, err := e.api.loadIncidents(context.Background(), demo.TenantID, demo.ScorecardID, []string{"uptime", "deployment_uptime"})
	if err != nil {
		t.Fatal(err)
	}
	keys := func(metric, subject string) string {
		var out []string
		for _, in := range got[metric][subject] {
			out = append(out, in.ExternalID)
			if !in.Cutoff.Equal(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)) || in.SubjectID != subject || in.Source != "incident-tracker" {
				t.Errorf("%s = %+v", in.ExternalID, in)
			}
		}
		return strings.Join(out, ",")
	}
	// Every row fans out per component. Cancelled incidents are left to the
	// arithmetic, which drops them; planned maintenance is filtered by the
	// link's where.
	if k := keys("uptime", "webhooks"); k != "INC-2003@Webhooks,INC-2041@Webhooks,INC-2047@Webhooks,INC-2049@Webhooks,INC-2058@Webhooks" {
		t.Errorf("webhooks incidents = %v", k)
	}
	if k := keys("uptime", "search"); k != "INC-2049@Search" {
		t.Errorf("search incidents = %v", k)
	}
	const relay = "@Notification Relay - Multi-Region Active"
	if k := keys("deployment_uptime", "dep-notify-multi"); k != "INC-2036"+relay+",INC-2044"+relay {
		t.Errorf("deployment incidents = %v", k)
	}
	none, err := e.api.loadIncidents(context.Background(), demo.TenantID, demo.ScorecardID, []string{"epics_on_time"})
	if err != nil || len(none) != 0 {
		t.Errorf("unlinked metric: %v %v", none, err)
	}
}

func TestStubs(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	sc := "/scorecards/" + demo.ScorecardID
	e.expectError(t, 501, "not_implemented", admin, "GET", sc+"/attribution?metric=uptime&subject=webhooks&period=2026-M10", nil)
	e.expectError(t, 501, "not_implemented", admin, "GET", summaryPath("uptime", "2026-M10"), nil)
	e.expectError(t, 501, "not_implemented", admin, "GET", demoSummaries+"?period=2026-M10", nil)
	e.expectError(t, 501, "not_implemented", admin, "POST", summaryPath("uptime", "2026-M10")+"/draft", nil)
	e.expectError(t, 501, "not_implemented", admin, "GET", summaryPath("uptime", "2026-M10")+"/draft/id-1", nil)
}
