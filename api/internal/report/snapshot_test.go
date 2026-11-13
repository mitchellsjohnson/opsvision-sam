package report

import (
	"encoding/json"
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
