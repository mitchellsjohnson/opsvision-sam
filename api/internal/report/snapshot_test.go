package report

import (
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
	return FactsView{ReportPeriod: reportMonth, Rows: rows}
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
}

func pf(v float64) *float64 { return &v }
