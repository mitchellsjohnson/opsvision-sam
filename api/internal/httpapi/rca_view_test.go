package httpapi

import (
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"opsvision/internal/demo"
)

// overviewQuery is the web Overview's request for 2026-M10: twelve months,
// the four quarters and two halves the month closes, and year to date.
func overviewQuery() string {
	q := url.Values{}
	for _, p := range []string{"2025-M11", "2025-M12", "2026-M01", "2026-M02", "2026-M03", "2026-M04", "2026-M05", "2026-M06",
		"2026-M07", "2026-M08", "2026-M09", "2026-M10", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2025-H2", "2026-H1"} {
		q.Add("periods", p)
	}
	q.Set("ytd", "2026-M10")
	return q.Encode()
}

const demoView = "/scorecards/" + demo.ScorecardID + "/view"

func getView(t *testing.T, e *testEnv, token, query string) ScorecardView {
	t.Helper()
	var v ScorecardView
	e.expect(t, 200, token, "GET", demoView+"?"+query, nil, &v)
	return v
}

// summaryAt is the summary state of (metric, subject) in the column of
// period p (not year to date), nil when there is none.
func summaryAt(t *testing.T, v ScorecardView, metric, subject, p string) *MetricSummaryState {
	t.Helper()
	for _, r := range v.Rows {
		if r.MetricKey != metric || r.SubjectId != subject {
			continue
		}
		for _, c := range r.Cells {
			if c.Period == p && !c.Ytd {
				return c.Summary
			}
		}
		t.Fatalf("row %s/%s has no %s column", metric, subject, p)
	}
	t.Fatalf("no row %s/%s", metric, subject)
	return nil
}

func hasRow(v ScorecardView, metric, subject string) bool {
	for _, r := range v.Rows {
		if r.MetricKey == metric && r.SubjectId == subject {
			return true
		}
	}
	return false
}

// TestSummaryView: the live Overview carries exec summary state on
// company-root cells only, and nothing for perfect metrics with no summary.
func TestSummaryView(t *testing.T) {
	e := newDemoEnv(t)
	v := getView(t, e, e.tokens["admin"], overviewQuery())

	// Item metrics (uptime, deployment uptime) have no company row in a
	// view, so no cell carries their summary state; listMetricSummaries does.
	for _, key := range []string{"uptime", "deployment_uptime"} {
		if hasRow(v, key, "acme") {
			t.Errorf("%s has a company row", key)
		}
	}
	ep := summaryAt(t, v, "epics_on_time", "acme", "2026-M10")
	whole, _ := storedSummary(t, e, "epics_on_time", oct2026)
	if ep == nil || ep.State != SummaryStateWritten || ep.Excerpt == nil || utf8.RuneCountInString(*ep.Excerpt) > 64 ||
		!strings.HasSuffix(*ep.Excerpt, "…") || !strings.HasPrefix(whole.Text, strings.TrimSuffix(*ep.Excerpt, "…")) ||
		ep.Author == nil || *ep.Author != "Avery Admin" {
		t.Errorf("epics_on_time Oct = %+v", ep)
	}
	for _, key := range []string{"support_backlog", "security_training"} {
		if d := summaryAt(t, v, key, "acme", "2026-M10"); d == nil || d.State != SummaryStateMissing || d.Excerpt != nil || d.Author != nil {
			t.Errorf("%s Oct = %+v", key, d)
		}
	}
	if s := summaryAt(t, v, "spend_vs_plan", "acme", "2026-M10"); s == nil || s.State != SummaryStateStale || s.Excerpt == nil {
		t.Errorf("spend_vs_plan Oct = %+v", s)
	}
	// September is fully written.
	for _, c := range demo.SummarySeptember {
		if !hasRow(v, c.MetricKey, "acme") {
			continue
		}
		col := c.Period.String()
		if s := summaryAt(t, v, c.MetricKey, "acme", col); s == nil || s.State != SummaryStateWritten {
			t.Errorf("%s %s = %+v", c.MetricKey, col, s)
		}
	}
	// Perfect, not reported or not closed, and none written: nothing.
	for _, key := range []string{"customer_feedback_slo", "roadmap_evidence", "design_review_coverage", "concepts_expected_value", "accessibility_compliance"} {
		if s := summaryAt(t, v, key, "acme", "2026-M10"); s != nil {
			t.Errorf("%s Oct = %+v, want none", key, s)
		}
	}
	// The quarterly metric's summary is on its quarter column.
	if s := summaryAt(t, v, "concepts_expected_value", "acme", "2026-Q3"); s == nil || s.State != SummaryStateWritten {
		t.Errorf("concepts_expected_value Q3 = %+v", s)
	}

	var withSummary int
	for _, r := range v.Rows {
		for _, c := range r.Cells {
			if c.Summary == nil {
				continue
			}
			withSummary++
			switch {
			case r.SubjectId != "acme" || r.SubjectKind != Unit:
				t.Errorf("summary on %s/%s %s", r.MetricKey, r.SubjectId, c.Period)
			case c.Ytd:
				t.Errorf("summary on the year-to-date cell of %s", r.MetricKey)
			}
		}
		switch r.MetricKey {
		case "uptime", "deployment_uptime", "security_training", "epics_on_time":
			if r.RcaIdeal == nil || *r.RcaIdeal != 100 {
				t.Errorf("%s/%s rcaIdeal = %v, want 100", r.MetricKey, r.SubjectId, r.RcaIdeal)
			}
		case "support_backlog", "weighted_defect_score", "customer_feedback_slo":
			if r.RcaIdeal != nil {
				t.Errorf("%s rcaIdeal = %v, want none", r.MetricKey, *r.RcaIdeal)
			}
		}
	}
	if withSummary == 0 {
		t.Fatal("no summary state on the Overview")
	}

	// A viewer reads the same states; a viewer scoped below the company
	// has no company row to carry one.
	if vv := summaryAt(t, getView(t, e, e.tokens["viewer"], overviewQuery()), "epics_on_time", "acme", "2026-M10"); vv == nil || vv.State != SummaryStateWritten {
		t.Errorf("viewer epics_on_time = %+v", vv)
	}
	for _, r := range getView(t, e, scopedViewer(t, e, "mobile"), overviewQuery()).Rows {
		for _, c := range r.Cells {
			if c.Summary != nil {
				t.Errorf("scoped viewer sees a summary on %s/%s", r.MetricKey, r.SubjectId)
			}
		}
	}
}

// TestSummaryViewRestated: a restated view keeps written summaries but
// computes no stale state.
func TestSummaryViewRestated(t *testing.T) {
	e := newDemoEnv(t)
	v := getView(t, e, e.tokens["admin"], overviewQuery()+"&restate=v2026")
	if s := summaryAt(t, v, "spend_vs_plan", "acme", "2026-M10"); s == nil || s.State != SummaryStateWritten {
		t.Errorf("restated spend_vs_plan = %+v, want written", s)
	}
	if d := summaryAt(t, v, "security_training", "acme", "2026-M10"); d == nil || d.State != SummaryStateMissing {
		t.Errorf("restated security_training = %+v", d)
	}
}

// TestSummaryViewFiltered: a view of a few subjects or metrics still judges
// the requirement from every subject.
func TestSummaryViewFiltered(t *testing.T) {
	e := newDemoEnv(t)
	v := getView(t, e, e.tokens["admin"], "periods=2026-M10&subjects=acme&metrics=epics_on_time&metrics=security_training")
	if s := summaryAt(t, v, "epics_on_time", "acme", "2026-M10"); s == nil || s.State != SummaryStateWritten {
		t.Errorf("filtered epics_on_time = %+v", s)
	}
	if s := summaryAt(t, v, "security_training", "acme", "2026-M10"); s == nil || s.State != SummaryStateMissing {
		t.Errorf("filtered security_training = %+v", s)
	}
}
