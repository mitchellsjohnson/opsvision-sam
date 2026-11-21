package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
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

const kb = 1024

// maxLinks are 25 links whose titles and URLs total exactly the 16,384-byte
// budget, each title 80 runes.
func maxLinks(t *testing.T, tag string) []domain.RCALink {
	t.Helper()
	out := make([]domain.RCALink, 0, domain.MaxRCALinks)
	left := domain.MaxRCALinkBytes
	for i := range domain.MaxRCALinks {
		title := fmt.Sprintf("%s link %02d ", tag, i+1)
		title += strings.Repeat("t", 80-len(title))
		share := left / (domain.MaxRCALinks - i)
		u := fmt.Sprintf("https://tracker.example/browse/%s-%02d?q=", tag, i+1)
		u += strings.Repeat("a", share-len(title)-len(u))
		out = append(out, domain.RCALink{Title: title, URL: u})
		left -= len(title) + len(u)
	}
	r := domain.CellRCA{Text: "x", Links: out}
	if errs := r.Validate(); len(errs) != 0 {
		t.Fatalf("maximum links do not validate: %v", errs)
	}
	return out
}

// maxText is 280 two-byte runes.
var maxText = strings.Repeat("é", domain.MaxRCATextRunes)

// putSummary stores a summary on the demo company directly.
func putSummary(t *testing.T, e *testEnv, metric string, p period.Period, text string, links []domain.RCALink) {
	t.Helper()
	ctx := context.Background()
	rev := 0
	if r, ok := storedSummary(t, e, metric, p); ok {
		rev = r.Revision
	}
	r := domain.CellRCA{ScorecardID: demo.ScorecardID, MetricKey: metric, SubjectID: "acme", Period: p, Text: text, Links: links,
		AuthorID: "dev|admin", AuthorName: "Avery Admin", Channel: domain.RCAChannelWeb, CreatedAt: demoNow, UpdatedAt: demoNow,
		Basis: domain.RCABasis{Display: "1%", Status: "R", Evidence: []string{}}}
	if _, err := e.store.PutRCA(ctx, demo.TenantID, r, rev); err != nil {
		t.Fatal(err)
	}
}

func gzipped(t *testing.T, b []byte) int {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Len()
}

// fastest runs f n times and returns its fastest time and last result.
func fastest(t *testing.T, n int, f func() []byte) (time.Duration, []byte) {
	t.Helper()
	best := time.Duration(1<<63 - 1)
	var out []byte
	for range n {
		start := time.Now()
		out = f()
		best = min(best, time.Since(start))
	}
	return best, out
}

// TestBudgetOverview: summary state grows the demo Overview's gzipped body by
// at most 2% and its raw body by at most 1%, keeps it under 1 MB as sent,
// and costs at most half again the time of the view without it. The view
// without summary state is already over 512 KB raw (every subject, 18
// columns and year to date), so that limit is the view's, not this state's.
func TestBudgetOverview(t *testing.T) {
	e := newDemoEnv(t)
	tenant, _ := e.store.GetTenant(context.Background(), demo.TenantID)
	m, err := e.store.GetMembership(context.Background(), demo.TenantID, "dev|admin")
	if err != nil {
		t.Fatal(err)
	}
	ctx := withMember(tenant, m)
	var params GetScorecardViewParams
	months := []string{"2025-M11", "2025-M12", "2026-M01", "2026-M02", "2026-M03", "2026-M04", "2026-M05", "2026-M06",
		"2026-M07", "2026-M08", "2026-M09", "2026-M10", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2025-H2", "2026-H1"}
	ytd := []string{"2026-M10"}
	params.Periods, params.Ytd = &months, &ytd
	req := GetScorecardViewRequestObject{Sc: demo.ScorecardID, Params: params}
	view := func(summaries bool) func() []byte {
		return func() []byte {
			v, err := e.api.scorecardView(ctx, req, summaries)
			if err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			return b
		}
	}
	view(true)() // warm up
	without, plain := fastest(t, 7, view(false))
	with, annotated := fastest(t, 7, view(true))
	if !bytes.Contains(annotated, []byte(`"summary"`)) || bytes.Contains(plain, []byte(`"summary"`)) {
		t.Fatal("the annotated view should carry summary state and the plain one none")
	}
	gzPlain, gzAnnotated := gzipped(t, plain), gzipped(t, annotated)
	t.Logf("Overview: raw %d → %d bytes, gzipped %d → %d (%.2f%%), %v → %v (%.2f×)", len(plain), len(annotated), gzPlain, gzAnnotated,
		100*float64(gzAnnotated-gzPlain)/float64(gzPlain), without, with, float64(with)/float64(without))
	if float64(gzAnnotated) > 1.02*float64(gzPlain) {
		t.Errorf("gzipped Overview grows from %d to %d bytes, over 2%%", gzPlain, gzAnnotated)
	}
	if float64(len(annotated)) > 1.01*float64(len(plain)) {
		t.Errorf("raw Overview grows from %d to %d bytes, over 1%%", len(plain), len(annotated))
	}
	if gzAnnotated >= 1024*kb {
		t.Errorf("Overview is %d bytes as sent, want under 1 MB", gzAnnotated)
	}
	if float64(with) > 1.5*float64(without) {
		t.Errorf("Overview with summary state takes %v, over 1.5× the %v without", with, without)
	}
}

// TestBudgetMetricSummary: a summary at the maximum (280 runes, 25 links at
// the 16 KB cap, evidence) reads under 24 KB.
func TestBudgetMetricSummary(t *testing.T) {
	e := newDemoEnv(t)
	putSummary(t, e, "uptime", oct2026, maxText, maxLinks(t, "MAX"))
	status, raw := e.call(t, e.tokens["admin"], "GET", summaryPath("uptime", "2026-M10"), nil)
	var s MetricSummary
	if status != 200 || json.Unmarshal(raw, &s) != nil || len(s.Links) != 25 || s.Evidence == nil {
		t.Fatalf("status %d: %.300s", status, raw)
	}
	t.Logf("getMetricSummary at the maximum: %d bytes", len(raw))
	if len(raw) >= 24*kb {
		t.Errorf("getMetricSummary at the maximum is %d bytes, want under 24 KB", len(raw))
	}
}

// TestBudgetAttribution: with 120 incidents with long titles and a summary at
// the maximum, the first page reads under 32 KB and a page of 50 under 64 KB.
func TestBudgetAttribution(t *testing.T) {
	e := newDemoEnv(t)
	putSummary(t, e, "uptime", oct2026, maxText, maxLinks(t, "MAX"))
	addIncidents(t, e, "Billing Worker", "LONG", 120, func(i int) string {
		return fmt.Sprintf("Incident %03d: ", i+1) + strings.Repeat("a long imported incident title ", 6)
	})
	admin := e.tokens["admin"]
	status, raw := e.call(t, admin, "GET", attributionPath("uptime", "billing-worker", "2026-M10"), nil)
	var first CellAttribution
	if status != 200 || json.Unmarshal(raw, &first) != nil || len(first.Incidents) != 5 || first.Summary == nil {
		t.Fatalf("first page: status %d: %.300s", status, raw)
	}
	t.Logf("attribution first page: %d bytes", len(raw))
	if len(raw) >= 32*kb {
		t.Errorf("first page is %d bytes, want under 32 KB", len(raw))
	}
	status, raw = e.call(t, admin, "GET", attributionPath("uptime", "billing-worker", "2026-M10", "incidentsCursor", "5"), nil)
	var page CellAttribution
	if status != 200 || json.Unmarshal(raw, &page) != nil {
		t.Fatalf("page: status %d: %.300s", status, raw)
	}
	if len(page.Incidents) != 50 || page.IncidentsCursor == nil || *page.IncidentsCursor != "55" || page.IncidentsTotal != 120 {
		t.Errorf("page of 50: %d incidents of %d, cursor %v", len(page.Incidents), page.IncidentsTotal, page.IncidentsCursor)
	}
	t.Logf("attribution page of 50: %d bytes", len(raw))
	if len(raw) >= 64*kb {
		t.Errorf("a page of 50 is %d bytes, want under 64 KB", len(raw))
	}
}

// addCopies publishes a version from 2026-M10 with the demo's metrics plus
// copies of security training (Green below 100%, so each is required) up to
// n metrics, and returns the keys of the copies.
func addCopies(t *testing.T, e *testEnv, n int) []string {
	t.Helper()
	ctx := context.Background()
	versions, err := e.store.ListVersions(ctx, demo.TenantID, demo.ScorecardID)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(versions, func(v domain.MethodologyVersion) bool { return v.ID == "v2026-2" })
	if i < 0 {
		t.Fatal("no version v2026-2")
	}
	v := versions[i]
	v.ID, v.Name, v.Revision = "v2026-3", "2026 v3", 0
	v.EffectiveFrom = oct2026
	at := time.Date(2026, time.October, 2, 0, 0, 0, 0, time.UTC)
	v.PublishedAt = &at
	j := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == "security_training" })
	base := v.Content.Metrics[j]
	metrics := slices.Clone(v.Content.Metrics)
	var keys []string
	for k := len(metrics); k < n; k++ {
		m := base
		m.Key, m.Name = fmt.Sprintf("training_copy_%03d", k), fmt.Sprintf("Training completion copy %03d", k)
		metrics = append(metrics, m)
		keys = append(keys, m.Key)
	}
	v.Content.Metrics = metrics
	if err := e.store.PutVersion(ctx, demo.TenantID, v, store.MustNotExist); err != nil {
		t.Fatal(err)
	}
	return keys
}

// TestBudgetList: 200 metrics list under 384 KB and 2 s; at the maximum the
// list pages to stay under 384 KB; a full page of 16 maximum summaries reads
// under 480 KB.
func TestBudgetList(t *testing.T) {
	e := newDemoEnv(t)
	copies := addCopies(t, e, 200)
	typical := []domain.RCALink{
		{Title: "Training completion report", URL: "https://docs.example/training/report-2026-10"},
		{Title: "Reminder plan", URL: "https://docs.example/training/reminders"},
		{Title: "Exceptions", URL: "https://tracker.example/browse/SEC-912"},
		{Title: "Owner list", URL: "https://docs.example/training/owners"},
	}
	text := strings.Repeat("Training lagged in two products after the October joiners started; reminders go out weekly. ", 4)[:280]
	for _, key := range copies {
		putSummary(t, e, key, oct2026, text, typical)
	}
	admin := e.tokens["admin"]

	start := time.Now()
	status, raw := e.call(t, admin, "GET", demoSummaries+"?period=2026-M10&state=all", nil)
	took := time.Since(start)
	var l MetricSummaryList
	if status != 200 || json.Unmarshal(raw, &l) != nil {
		t.Fatalf("status %d: %.300s", status, raw)
	}
	t.Logf("listMetricSummaries, %d metrics: %d bytes in %v", len(l.Items), len(raw), took)
	if len(l.Items) != 200 || l.NextCursor != nil {
		t.Errorf("list has %d items, cursor %v; want 200 in one page", len(l.Items), l.NextCursor)
	}
	if len(raw) >= 384*kb || took >= 2*time.Second {
		t.Errorf("list of 200 is %d bytes in %v, want under 384 KB and 2 s", len(raw), took)
	}

	// At the maximum, the list pages rather than grow past its budget.
	links := maxLinks(t, "MAX")
	for _, key := range append(copies, "spend_vs_plan") {
		putSummary(t, e, key, oct2026, maxText, links)
	}
	seen := map[string]bool{}
	cursor := ""
	for pages := 0; ; pages++ {
		q := demoSummaries + "?period=2026-M10&state=all"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		status, raw := e.call(t, admin, "GET", q, nil)
		var page MetricSummaryList
		if status != 200 || json.Unmarshal(raw, &page) != nil || pages > 10 {
			t.Fatalf("page %d: status %d: %.300s", pages, status, raw)
		}
		t.Logf("maximum list page %d: %d items, %d bytes", pages, len(page.Items), len(raw))
		if len(raw) >= 384*kb {
			t.Errorf("page %d is %d bytes, want under 384 KB", pages, len(raw))
		}
		for _, it := range page.Items {
			seen[it.MetricKey] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 200 {
		t.Errorf("pages list %d metrics, want 200", len(seen))
	}

	// The stale ones are the copies and spend vs plan, all at the maximum.
	status, raw = e.call(t, admin, "GET", demoSummaries+"?period=2026-M10&state=stale&full=true", nil)
	var full MetricSummaryList
	if status != 200 || json.Unmarshal(raw, &full) != nil {
		t.Fatalf("full: status %d: %.300s", status, raw)
	}
	t.Logf("full page: %d items, %d bytes", len(full.Items), len(raw))
	if len(full.Items) != 16 || full.NextCursor == nil || len(full.Items[0].Links) == 0 {
		t.Errorf("full page has %d items, cursor %v", len(full.Items), full.NextCursor)
	}
	maxRows := 0
	for _, it := range full.Items {
		if it.LinksTotal == 25 && len(it.Links) == 25 {
			maxRows++
		}
	}
	if maxRows != 16 {
		t.Errorf("%d of the page's rows are at the maximum, want 16", maxRows)
	}
	if len(raw) >= 480*kb {
		t.Errorf("a full page of 16 maximum summaries is %d bytes, want under 480 KB", len(raw))
	}
}
