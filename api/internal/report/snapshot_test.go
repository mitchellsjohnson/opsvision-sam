package report

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

func defaultScale() []domain.StatusLevel {
	return domain.DefaultStatusScale()
}

func cell(period, status string, value *float64) FactsCell {
	return FactsCell{Period: period, Status: status, Value: value}
}

func row(metric, name, subject string, depth int, cells ...FactsCell) FactsRow {
	return FactsRow{MetricKey: metric, MetricName: name, SubjectID: subject, Depth: depth, Cells: cells}
}

func view(reportMonth string, rows ...FactsRow) FactsView {
	return FactsView{ReportPeriod: reportMonth, RootSubjectID: "co", Rows: rows}
}

// An item row (depth 0, id sorting first) must not stand in for the company.
func TestFactsUseTheGivenRoot(t *testing.T) {
	v := view("2026-M03",
		row("a", "Alpha", "aaa-item", 0,
			cell("2026-M02", "G", pf(99)),
			cell("2026-M03", "R", pf(10)),
		),
		row("a", "Alpha", "co", 0,
			cell("2026-M02", "G", pf(95)),
			cell("2026-M03", "G", pf(96)),
		),
	)
	if got := Facts(v, defaultScale()); len(got) != 0 {
		t.Fatalf("facts = %#v, want none from the company row", got)
	}
	v.RootSubjectID = ""
	if got := Facts(v, defaultScale()); len(got) != 0 {
		t.Fatalf("facts without a root = %#v, want none", got)
	}
}

func TestFactsTurnedRed(t *testing.T) {
	v := view("2026-M03",
		row("a", "Alpha", "co", 0,
			cell("2026-M02", "Y", pf(80)),
			cell("2026-M03", "R", pf(50)),
		),
		row("b", "Beta", "co", 0,
			cell("2026-M02", "G", pf(95)),
			cell("2026-M03", "G", pf(96)),
		),
	)
	got := Facts(v, defaultScale())
	if len(got) != 1 || !strings.Contains(got[0], "turned red") || !strings.Contains(got[0], "Alpha") {
		t.Fatalf("facts = %#v", got)
	}
}

func TestFactsFirstGreenInThree(t *testing.T) {
	v := view("2026-M04",
		row("a", "Alpha", "co", 0,
			cell("2026-M02", "Y", pf(80)),
			cell("2026-M03", "Y", pf(75)),
			cell("2026-M04", "G", pf(99)),
		),
	)
	got := Facts(v, defaultScale())
	if len(got) != 1 || !strings.Contains(got[0], "first green in 3 months") || !strings.Contains(got[0], "Alpha") {
		t.Fatalf("facts = %#v", got)
	}
}

func TestFactsNotReported(t *testing.T) {
	v := view("2026-M02",
		row("a", "Alpha", "co", 0, cell("2026-M02", "G", pf(90))),
		row("b", "Beta", "co", 0, cell("2026-M02", "", nil)),
	)
	got := Facts(v, defaultScale())
	if len(got) != 1 || !strings.Contains(got[0], "not reported") || !strings.Contains(got[0], "Beta") {
		t.Fatalf("facts = %#v", got)
	}
}

// A quarterly metric has no month cell by design: it is not "not reported".
func TestFactsLeaveCoarseMetricsOutOfNotReported(t *testing.T) {
	quarterly := row("q", "Quarterly value", "co", 0, cell("2026-M02", "", nil))
	quarterly.Frequency = domain.FrequencyQuarterly
	monthly := row("b", "Beta", "co", 0, cell("2026-M02", "", nil))
	monthly.Frequency = domain.FrequencyMonthly
	unset := row("c", "Gamma", "co", 0, cell("2026-M02", "", nil))
	got := Facts(view("2026-M02", quarterly, monthly, unset), defaultScale())
	if len(got) != 1 || got[0] != "not reported: Beta, Gamma" {
		t.Fatalf("facts = %#v, want only the monthly metrics not reported", got)
	}
}

func TestFactsAllGreenNoTurnedRed(t *testing.T) {
	v := view("2026-M02",
		row("a", "Alpha", "co", 0,
			cell("2026-M01", "G", pf(90)),
			cell("2026-M02", "G", pf(91)),
		),
		row("b", "Beta", "co", 0,
			cell("2026-M01", "G", pf(95)),
			cell("2026-M02", "G", pf(96)),
		),
	)
	got := Facts(v, defaultScale())
	for _, s := range got {
		if strings.Contains(s, "turned red") {
			t.Fatalf("unexpected turned red in %#v", got)
		}
	}
	if got == nil {
		t.Fatal("Facts returned nil slice")
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "[]" {
		t.Fatalf("marshal = %s, want []", raw)
	}
}

func pf(v float64) *float64 { return &v }

func summarySnap(metric, p, text string) SummarySnapshot {
	return SummarySnapshot{
		MetricKey: metric, MetricName: metric, Period: p, Requirement: RequirementRequired, RequirementReason: "Red",
		Standing: SummaryStanding{Display: "57%", Status: "R", Headline: "43 pts short of 100%"},
		Text:     text, Links: []domain.RCALink{}, AuthorName: "Avery Admin", Channel: domain.RCAChannelWeb, Revision: 1,
	}
}

// A version 3 document carries an exec summary for every required metric,
// and never a placeholder in a summary slot.
func TestDocumentValidateSummaries(t *testing.T) {
	required := []SummaryRef{{MetricKey: "epics", Period: "2026-M10"}, {MetricKey: "concepts", Period: "2026-Q3"}}
	ok := Document{SchemaVersion: SchemaVersion, Period: "2026-M10", Summaries: []SummarySnapshot{
		summarySnap("epics", "2026-M10", "Three epics slipped."),
		summarySnap("concepts", "2026-Q3", "Two concepts missed."),
		summarySnap("optional_one", "2026-M10", "Written though not required."),
	}}
	if SchemaVersion != 3 {
		t.Fatalf("SchemaVersion = %d, want 3", SchemaVersion)
	}
	if err := ok.Validate(required); err != nil {
		t.Fatalf("Validate = %v", err)
	}

	missing := ok
	missing.Summaries = ok.Summaries[:1]
	err := missing.Validate(required)
	if !errors.Is(err, ErrSummaryMissing) || !strings.Contains(err.Error(), "a required exec summary is missing") ||
		!strings.Contains(err.Error(), "concepts 2026-Q3") {
		t.Fatalf("missing: %v", err)
	}

	// A slot with no text is a placeholder, not a summary.
	blank := ok
	blank.Summaries = []SummarySnapshot{ok.Summaries[0], summarySnap("concepts", "2026-Q3", "  ")}
	if err := blank.Validate(required); !errors.Is(err, ErrSummaryMissing) {
		t.Fatalf("blank text: %v", err)
	}
	optionalBlank := ok
	optionalBlank.Summaries = append(slices.Clone(ok.Summaries), summarySnap("other", "2026-M10", ""))
	if err := optionalBlank.Validate(required); !errors.Is(err, ErrSummaryMissing) {
		t.Fatalf("blank optional slot: %v", err)
	}

	// The same metric in another period does not count.
	wrongPeriod := ok
	wrongPeriod.Summaries = []SummarySnapshot{ok.Summaries[0], summarySnap("concepts", "2026-M09", "Elsewhere.")}
	if err := wrongPeriod.Validate(required); !errors.Is(err, ErrSummaryMissing) {
		t.Fatalf("wrong period: %v", err)
	}

	old := ok
	old.SchemaVersion = 2
	if err := old.Validate(nil); err == nil {
		t.Fatal("a new document must be version 3")
	}
}

// Summaries are left out of a document that has none, so earlier readers
// and sizes are unchanged.
func TestDocumentSummariesJSON(t *testing.T) {
	raw, err := json.Marshal(Document{SchemaVersion: SchemaVersion, Period: "2026-M10"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "summaries") || !strings.Contains(string(raw), `"schemaVersion":3`) {
		t.Fatalf("document = %s", raw)
	}
	s := summarySnap("epics", "2026-M10", "Three epics slipped.")
	s.Evidence = []SummaryEvidence{{Key: "CHK-113", Title: "Checkout redesign", URL: "https://tracker.example/browse/CHK-113", PointsDisplay: ""}}
	raw, err = json.Marshal(Document{SchemaVersion: SchemaVersion, Summaries: []SummarySnapshot{s}})
	if err != nil {
		t.Fatal(err)
	}
	var back Document
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if len(back.Summaries) != 1 || back.Summaries[0].Text != s.Text || back.Summaries[0].Evidence[0].Key != "CHK-113" ||
		back.Summaries[0].Standing != s.Standing {
		t.Fatalf("round trip = %+v", back.Summaries)
	}
}
