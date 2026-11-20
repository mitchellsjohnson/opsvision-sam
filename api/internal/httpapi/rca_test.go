package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"opsvision/internal/demo"
	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

const demoRCA = "/scorecards/" + demo.ScorecardID + "/rca"

var oct2026 = period.Period{Grain: period.Month, FY: 2026, Index: 10}

type rcaNoteJSON struct {
	Text       string `json:"text"`
	Links      []struct{ Title, URL string }
	AuthorID   string    `json:"authorId"`
	AuthorName string    `json:"authorName"`
	Channel    string    `json:"channel"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Revision   int       `json:"revision"`
}

type rcaConflictJSON struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Current *rcaNoteJSON `json:"current"`
}

type rcaLink = map[string]string

func rcaBody(metric, subject, text string, links []rcaLink, rev int) map[string]any {
	if links == nil {
		links = []rcaLink{}
	}
	return map[string]any{"metric": metric, "subject": subject, "period": "2026-M10", "text": text, "links": links, "expectedRevision": rev}
}

func rcaQuery(metric, subject string, rev int) string {
	q := url.Values{"metric": {metric}, "subject": {subject}, "period": {"2026-M10"}}
	if rev >= 0 {
		q.Set("expectedRevision", fmt.Sprint(rev))
	}
	return demoRCA + "?" + q.Encode()
}

func storedRCA(t *testing.T, e *testEnv, metric, subject string) (domain.CellRCA, bool) {
	t.Helper()
	r, err := e.store.GetRCA(context.Background(), demo.TenantID, demo.ScorecardID, metric, subject, oct2026)
	if errors.Is(err, store.ErrNotFound) {
		return r, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return r, true
}

// clearDemoRCAs deletes the notes the demo seeds, for tests that write those
// cells from scratch.
func clearDemoRCAs(t *testing.T, e *testEnv) {
	t.Helper()
	for _, c := range demo.RCAExamples {
		if err := e.store.DeleteRCA(context.Background(), demo.TenantID, demo.ScorecardID, c.MetricKey, c.SubjectID, c.Period, 1); err != nil {
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

func TestPutCellRcaPermissions(t *testing.T) {
	e := newDemoEnv(t)
	clearDemoRCAs(t, e)
	ctx := context.Background()
	if err := e.store.PutTrackedItem(ctx, demo.TenantID, domain.TrackedItem{ID: "orphan-svc", KindID: "services", Name: "Orphan service"}); err != nil {
		t.Fatal(err)
	}
	contributor, viewer := e.tokens["contributor"], e.tokens["viewer"]

	// The Payments contributor writes a Payments product, a service of
	// Payments at 100% (nothing to explain), and the Payments roll-up.
	var note rcaNoteJSON
	for _, c := range [][2]string{{"epics_on_time", "checkout"}, {"uptime", "checkout-api"}, {"epics_on_time", "payments"}} {
		e.expect(t, 200, contributor, "PUT", demoRCA, rcaBody(c[0], c[1], "Two epics slipped behind the gateway migration.", nil, 0), &note)
		if note.Revision != 1 || note.AuthorID != "dev|contributor" || note.AuthorName != "Casey Contributor" || note.Channel != "web" {
			t.Fatalf("%v: note = %+v", c, note)
		}
	}
	audited := len(demoAudits(t, e))
	if audited != 3 {
		t.Fatalf("%d audit entries after three writes", audited)
	}

	// Outside the contributor's units: another segment's service, the
	// company roll-up, and an item attached to no unit.
	const msg = "You can write RCAs only for your own units."
	for _, c := range [][2]string{{"uptime", "webhooks"}, {"epics_on_time", "acme"}, {"uptime", "orphan-svc"}} {
		got := e.expectError(t, 403, "forbidden", contributor, "PUT", demoRCA, rcaBody(c[0], c[1], "Not mine.", nil, 0))
		if got.Error.Message != msg {
			t.Errorf("%v: message %q, want %q", c, got.Error.Message, msg)
		}
		e.expectError(t, 403, "forbidden", contributor, "DELETE", rcaQuery(c[0], c[1], 1), nil)
		if _, ok := storedRCA(t, e, c[0], c[1]); ok {
			t.Errorf("%v: a refused write was stored", c)
		}
	}
	// The viewer writes nothing, not even inside its scope.
	for _, c := range [][2]string{{"epics_on_time", "checkout"}, {"uptime", "webhooks"}, {"epics_on_time", "acme"}} {
		got := e.expectError(t, 403, "forbidden", viewer, "PUT", demoRCA, rcaBody(c[0], c[1], "Viewer note.", nil, 1))
		if got.Error.Message != msg {
			t.Errorf("viewer %v: message %q", c, got.Error.Message)
		}
		e.expectError(t, 403, "forbidden", viewer, "DELETE", rcaQuery(c[0], c[1], 1), nil)
	}
	if r, _ := storedRCA(t, e, "epics_on_time", "checkout"); r.Revision != 1 {
		t.Errorf("checkout note = %+v after the viewer's refused writes", r)
	}

	// A stale expectedRevision is 409 carrying the note as stored.
	for _, rev := range []int{0, 2} {
		status, raw := e.call(t, contributor, "PUT", demoRCA, rcaBody("epics_on_time", "checkout", "Mine is newer.", nil, rev))
		var c rcaConflictJSON
		if err := json.Unmarshal(raw, &c); err != nil || status != 409 || c.Error.Code != "conflict" {
			t.Fatalf("stale put %d: %d %s", rev, status, raw)
		}
		if c.Current == nil || c.Current.Revision != 1 || c.Current.Text != "Two epics slipped behind the gateway migration." {
			t.Fatalf("stale put %d: current = %+v", rev, c.Current)
		}
	}
	status, raw := e.call(t, contributor, "DELETE", rcaQuery("epics_on_time", "checkout", 4), nil)
	var c rcaConflictJSON
	if err := json.Unmarshal(raw, &c); err != nil || status != 409 || c.Current == nil || c.Current.Revision != 1 {
		t.Fatalf("stale delete: %d %s", status, raw)
	}
	e.expectError(t, 404, "not_found", contributor, "DELETE", rcaQuery("epics_on_time", "billing", 1), nil)

	if n := len(demoAudits(t, e)); n != audited {
		t.Fatalf("rejected writes added %d audit entries", n-audited)
	}

	// The admin writes anywhere, the company cell included.
	e.expect(t, 200, e.tokens["admin"], "PUT", demoRCA, rcaBody("epics_on_time", "acme", "Company roll-up note.", nil, 0), nil)
	e.expect(t, 200, e.tokens["admin"], "PUT", demoRCA, rcaBody("uptime", "orphan-svc", "Unattached.", nil, 0), nil)
}

func TestPutCellRcaValidation(t *testing.T) {
	e := newDemoEnv(t)
	clearDemoRCAs(t, e)
	admin := e.tokens["admin"]
	ok := rcaLink{"title": "Postmortem", "url": "https://docs.example/pm/2041"}
	long := "https://docs.example/" + strings.Repeat("a", 2049-len("https://docs.example/"))
	big := func(i int) rcaLink {
		return rcaLink{"title": fmt.Sprintf("Link %d", i), "url": fmt.Sprintf("https://docs.example/%d/", i) + strings.Repeat("b", 900)}
	}
	cases := []struct {
		name  string
		text  string
		links []rcaLink
		path  string
		msg   string
	}{
		{"javascript URL", "Gap.", []rcaLink{ok, {"title": "Click", "url": "javascript:alert(1)"}}, "links[1].url", "Use a link that starts with https://"},
		{"http URL", "Gap.", []rcaLink{ok, {"title": "Plain", "url": "http://docs.example/a"}}, "links[1].url", "Use a link that starts with https://"},
		{"user and password", "Gap.", []rcaLink{ok, {"title": "Creds", "url": "https://user:secret@docs.example/a"}}, "links[1].url", "Use a link that starts with https://"},
		{"space", "Gap.", []rcaLink{ok, {"title": "Space", "url": "https://docs.example/a b"}}, "links[1].url", "Use a link that starts with https://"},
		{"2049-byte URL", "Gap.", []rcaLink{ok, {"title": "Long", "url": long}}, "links[1].url", "This link is too long; use one up to 2,048 characters"},
		{"over 4 KB together", "Gap.", []rcaLink{big(1), big(2), big(3), big(4), big(5)}, "links", "These links are too long together; shorten or remove one"},
		{"six links", "Gap.", []rcaLink{big(1), ok, {"title": "c", "url": "https://docs.example/c"}, {"title": "d", "url": "https://docs.example/d"}, {"title": "e", "url": "https://docs.example/e"}, {"title": "f", "url": "https://docs.example/f"}}, "links", "Up to 5 links"},
		{"duplicate", "Gap.", []rcaLink{ok, {"title": "Again", "url": "HTTPS://docs.example/pm/2041"}}, "links[1].url", "This link is already listed"},
		{"no title", "Gap.", []rcaLink{ok, {"title": "  ", "url": "https://docs.example/x"}}, "links[1].title", "Add a title for this link"},
		{"281 code points", strings.Repeat("é", 281), nil, "text", "Write up to 280 characters"},
		{"only newlines", "\n\n\n", nil, "text", "Write what caused the gap"},
	}
	for _, c := range cases {
		got := e.expectError(t, 400, "invalid", admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", c.text, c.links, 0))
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
	// The request itself: keys, ids, periods and the cell.
	for _, b := range []map[string]any{
		{"metric": "Uptime", "subject": "webhooks", "period": "2026-M10", "text": "x", "links": []any{}, "expectedRevision": 0},
		{"metric": "uptime", "subject": "web hooks", "period": "2026-M10", "text": "x", "links": []any{}, "expectedRevision": 0},
		{"metric": "uptime", "subject": "webhooks", "period": "2026-10", "text": "x", "links": []any{}, "expectedRevision": 0},
		{"metric": "uptime", "subject": "webhooks", "period": "2026-M10", "text": "x", "links": []any{}, "expectedRevision": -1},
		{"metric": "no_such_metric", "subject": "webhooks", "period": "2026-M10", "text": "x", "links": []any{}, "expectedRevision": 0},
		{"metric": "uptime", "subject": "no-such-subject", "period": "2026-M10", "text": "x", "links": []any{}, "expectedRevision": 0},
		{"metric": "uptime", "subject": "webhooks", "period": "2026-Q4", "text": "x", "links": []any{}, "expectedRevision": 0},
	} {
		e.expectError(t, 400, "invalid", admin, "PUT", demoRCA, b)
	}
	if len(demoAudits(t, e)) != 0 {
		t.Fatal("a rejected write was audited")
	}

	// Plain text passes as written; the scheme is stored lowercased and
	// whitespace collapsed.
	img := `<img src=x onerror="alert(1)">`
	var note rcaNoteJSON
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", "  Queue saturated\n\nafter  a deploy "+img, []rcaLink{
		{"title": " " + img + " ", "url": "HTTPS://docs.example/a"},
	}, 0), &note)
	if note.Text != "Queue saturated after a deploy "+img || len(note.Links) != 1 || note.Links[0].URL != "https://docs.example/a" || note.Links[0].Title != img {
		t.Fatalf("note = %+v", note)
	}
	stored, _ := storedRCA(t, e, "uptime", "webhooks")
	if stored.Links[0].URL != "https://docs.example/a" || stored.Text != note.Text {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestPutCellRcaAudit(t *testing.T) {
	e := newDemoEnv(t)
	clearDemoRCAs(t, e)
	admin := e.tokens["admin"]
	links := []rcaLink{{"title": "Postmortem", "url": "https://docs.example/pm/2041"}}
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", "Queue saturated.", links, 0), nil)
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", "Queue saturated after a deploy.", links, 1), nil)
	var note rcaNoteJSON
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", " Queue saturated after a deploy. ", links, 2), &note)
	if note.Revision != 3 {
		t.Fatalf("confirm = %+v", note)
	}
	status, raw := e.call(t, admin, "DELETE", rcaQuery("uptime", "webhooks", 3), nil)
	if status != 204 || len(raw) != 0 {
		t.Fatalf("delete: %d %s", status, raw)
	}
	if _, ok := storedRCA(t, e, "uptime", "webhooks"); ok {
		t.Fatal("deleted note still stored")
	}

	entries := demoAudits(t, e)
	var actions []string
	for _, a := range entries {
		if a.TargetType != "rca" || a.TargetID != "uptime|webhooks|2026-M10" || a.ActorID != "dev|admin" {
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

	// The note records the channel: an access token is api, MCP is mcp.
	tok := e.createToken(t, admin, "Script")
	e.expect(t, 200, tok.Token, "PUT", demoRCA, rcaBody("uptime", "search", "Regional DNS failures.", nil, 0), &note)
	if note.Channel != "api" {
		t.Errorf("token channel = %q", note.Channel)
	}
	out := mcpToolCall(t, e, admin, "put_cell_rca", map[string]any{
		"sc": demo.ScorecardID, "body": rcaBody("uptime", "analytics-ingest", "Ingest lag from a partition rebalance.", nil, 0),
	})
	if out.IsError {
		t.Fatalf("put_cell_rca: %s", out.Text)
	}
	r, ok := storedRCA(t, e, "uptime", "analytics-ingest")
	if !ok || r.Channel != "mcp" {
		t.Fatalf("MCP note = %+v", r)
	}
	last := demoAudits(t, e)
	if a := last[len(last)-1]; a.Channel != "mcp" || a.Action != "create" {
		t.Errorf("MCP audit = %+v", a)
	}
}

func TestPutCellRcaBasis(t *testing.T) {
	e := newDemoEnv(t)
	clearDemoRCAs(t, e)
	admin := e.tokens["admin"]

	// The demo's linked incidents are counted: a cancelled incident and
	// September's never count, and INC-2049 counts here and for Search.
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "webhooks", "Queue saturated.", nil, 0), nil)
	r, _ := storedRCA(t, e, "uptime", "webhooks")
	if r.Basis.Display != "99.06%" || r.Basis.Status != "R" || r.Basis.ReportedMinutes == nil || *r.Basis.ReportedMinutes != 420 {
		t.Fatalf("basis = %+v (minutes %v)", r.Basis, r.Basis.ReportedMinutes)
	}
	// The tracker template fans every row out per component, so the keys
	// may carry the component.
	if ev := r.Basis.Evidence; len(ev) != 3 || !strings.HasPrefix(ev[0], "incident-tracker:INC-2041") ||
		!strings.HasPrefix(ev[1], "incident-tracker:INC-2047") || !strings.HasPrefix(ev[2], "incident-tracker:INC-2049") {
		t.Fatalf("evidence = %v", ev)
	}
	if !r.CreatedAt.Equal(demoNow) || !r.UpdatedAt.Equal(demoNow) {
		t.Errorf("times = %v %v", r.CreatedAt, r.UpdatedAt)
	}

	// Planned maintenance is filtered by the link.
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("uptime", "search", "DNS failures.", nil, 0), nil)
	r, _ = storedRCA(t, e, "uptime", "search")
	if len(r.Basis.Evidence) != 1 || !strings.HasPrefix(r.Basis.Evidence[0], "incident-tracker:INC-2049") || *r.Basis.ReportedMinutes != 60 {
		t.Fatalf("search basis = %+v", r.Basis)
	}

	// A metric with no downtime has no reported minutes.
	e.expect(t, 200, admin, "PUT", demoRCA, rcaBody("epics_on_time", "checkout", "Two epics slipped.", nil, 0), nil)
	r, _ = storedRCA(t, e, "epics_on_time", "checkout")
	if r.Basis.ReportedMinutes != nil || r.Basis.Display == "" || len(r.Basis.Evidence) != 0 {
		t.Fatalf("epics basis = %+v", r.Basis)
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

func TestRcaStubs(t *testing.T) {
	e := newDemoEnv(t)
	admin := e.tokens["admin"]
	e.expectError(t, 501, "not_implemented", admin, "GET", rcaQuery("uptime", "webhooks", -1), nil)
	e.expectError(t, 501, "not_implemented", admin, "GET", "/scorecards/"+demo.ScorecardID+"/rcas?period=2026-M10", nil)
	e.expectError(t, 501, "not_implemented", admin, "POST", demoRCA+"/draft", map[string]any{"metric": "uptime", "subject": "webhooks", "period": "2026-M10"})
	e.expectError(t, 501, "not_implemented", admin, "GET", demoRCA+"/draft/id-1", nil)
}
