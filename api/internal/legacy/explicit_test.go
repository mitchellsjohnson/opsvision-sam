package legacy

import (
	"os"
	"strings"
	"testing"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/xlsx/xlsxtest"
)

// Tests for explicit row mappings (RowMap.Row), per-row period columns
// (RowMap.PeriodColumns) and the tolerant converters. All data is synthetic.

func TestExplicitRowDisambiguatesRepeatedLabels(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{
		metric("rev", "val", domain.FormatNumber0, domain.FrequencyMonthly, bands(50, 20, true)),
		metric("cost", "mx", domain.FormatNumber0, domain.FrequencyMonthly, bands(50, 20, true)),
	}))
	sheets := dataSheet(
		[]any{"Revenue", nil, nil, nil},  // 2
		[]any{"North", "10", "11", "12"}, // 3
		[]any{"South", "20", "21", "22"}, // 4
		[]any{"Cost", nil, nil, nil},     // 5
		[]any{"North", "30", "31", "32"}, // 6
		[]any{"South", "40", "41", "42"}, // 7
	)
	revMeas, costMeas := map[string]string{"value": "val"}, map[string]string{"value": "mx"}
	mk := func(rowNum int, label, metricKey, subject string, meas map[string]string) RowMap {
		rm := row(label, metricKey, subject, "value", meas)
		rm.Row = rowNum
		return rm
	}

	tpl := dataTemplate(
		mk(3, "North", "rev", "north", revMeas),
		mk(4, "South", "rev", "south", revMeas),
		mk(6, "North", "cost", "north", costMeas),
		mk(7, "South", "cost", "south", costMeas),
	)
	cs := parse(t, sheets, tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", mon(1), 10)
	wantValue(t, cs, "val", "south", mon(3), 22)
	wantValue(t, cs, "mx", "north", mon(1), 30)
	wantValue(t, cs, "mx", "south", mon(2), 41)
	if len(cs.Data) != 12 {
		t.Errorf("writes = %d, want 12", len(cs.Data))
	}

	// Without a label the row number alone selects the row, and Section is ignored.
	tpl = dataTemplate(mk(6, "", "cost", "north", costMeas))
	tpl.Rows[0].Section = "Nothing"
	cs = parse(t, sheets, tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "mx", "north", mon(3), 32)

	// A label guard that does not match the row is an error and writes nothing.
	tpl = dataTemplate(
		mk(3, " north ", "rev", "north", revMeas), // trimmed, case-insensitive: fine
		mk(4, "North", "rev", "south", revMeas),   // row 4 is South
	)
	cs = parse(t, sheets, tpl, base)
	if !hasFinding(cs, changeset.SeverityError, "Data", "A4", `row 4 label is "South", expected "North"`) {
		t.Errorf("no label guard error: %+v", cs.Findings)
	}
	if _, ok := point(cs, "val", "south", mon(1)); ok {
		t.Error("a row whose label guard failed was still imported")
	}
	wantValue(t, cs, "val", "north", mon(1), 10)
	if len(cs.Data) != 3 {
		t.Errorf("writes = %d, want 3 (only row 3)", len(cs.Data))
	}

	// A row that is not on the sheet is reported, not silently skipped.
	tpl = dataTemplate(mk(40, "North", "rev", "north", revMeas))
	cs = parse(t, sheets, tpl, base)
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "", "row 40") || len(cs.Data) != 0 {
		t.Errorf("missing explicit row: %+v", cs)
	}
}

// An explicit row mapping does not disturb label mappings on other rows.
func TestExplicitRowCoexistsWithLabelRows(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m"), valueMetric("n")}))
	sheets := dataSheet(
		[]any{"Alpha", "1", "2", "3"}, // 2
		[]any{"Beta", "4", "5", "6"},  // 3
	)
	byRow := row("Beta", "n", "north", "value", map[string]string{"value": "mx"})
	byRow.Row = 3
	tpl := dataTemplate(row("Alpha", "m", "north", "value", map[string]string{"value": "val"}), byRow)
	cs := parse(t, sheets, tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", mon(2), 2)
	wantValue(t, cs, "mx", "north", mon(2), 5)
}

// monthsSheet is a "Data" sheet with labels in A and fiscal months 1..12 in F..Q.
func monthsSheet(rows ...[]any) []xlsxtest.Sheet {
	return []xlsxtest.Sheet{{Name: "Data", Rows: append([][]any{{"Metric"}}, rows...)}}
}

func monthsRow(label string, cells map[string]string) []any {
	r := make([]any, 17) // A..Q
	r[0] = label
	for col, text := range cells {
		r[colNumber(col)-1] = text
	}
	return r
}

func monthsTemplate(rows ...RowMap) Template {
	mc := map[string]int{}
	for i, col := range []string{"F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"} {
		mc[col] = i + 1
	}
	for i := range rows {
		rows[i].Sheet = "Data"
	}
	return Template{
		Sheets: []SheetMap{{Sheet: "Data", FiscalYear: 2025, LabelColumn: "A", MonthColumns: mc}},
		Rows:   rows,
	}
}

func TestRowPeriodColumnsOverrideSheet(t *testing.T) {
	q := metric("retention", "val", domain.FormatPercent0, domain.FrequencyQuarterly, bands(90, 80, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m"), q}))
	sheets := monthsSheet(
		monthsRow("Uptime", map[string]string{"F": "40", "G": "41"}),                                         // 2
		monthsRow("Retention", map[string]string{"F": "85%", "G": "99%", "I": "88%", "J": "77%", "Q": "1%"}), // 3
	)
	monthly := row("Uptime", "m", "north", "value", map[string]string{"value": "val"})
	quarterly := row("Retention", "retention", "north", "value", map[string]string{"value": "mx"})
	quarterly.PeriodColumns = map[string]string{"F": "2025-Q1", "i": "2025-Q2"}
	tpl := monthsTemplate(monthly, quarterly)

	cs := parse(t, sheets, tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", mon(1), 40) // the sheet's months still serve other rows
	wantValue(t, cs, "val", "north", mon(2), 41)
	wantValue(t, cs, "mx", "north", qtr(1), 85)
	wantValue(t, cs, "mx", "north", qtr(2), 88)
	var quarters int
	for _, w := range cs.Data {
		if w.Point.MeasureKey == "mx" {
			quarters++
			if w.Point.Period.Grain != qtr(1).Grain {
				t.Errorf("non-quarter point from the quarterly row: %+v", w.Point)
			}
		}
	}
	if quarters != 2 {
		t.Errorf("quarterly row wrote %d points, want 2 (only F and I)", quarters)
	}

	// A period whose grain does not fit the metric is an error finding.
	quarterly.PeriodColumns = map[string]string{"F": "2025-M03"}
	cs = parse(t, sheets, monthsTemplate(quarterly), base)
	if !hasFinding(cs, changeset.SeverityError, "Data", "F3", "quarterly") {
		t.Errorf("no grain error: %+v", cs.Findings)
	}
	if len(cs.Data) != 0 {
		t.Errorf("a grain-mismatched cell was imported: %+v", cs.Data)
	}
}

func TestRowPeriodColumnsOnSheetWithoutMonths(t *testing.T) {
	// A sheet that only has row-level periods still needs at least one sheet
	// column mapping; the sheet's own columns are not used for the row.
	q := metric("retention", "val", domain.FormatPercent0, domain.FrequencyQuarterly, bands(90, 80, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{q}))
	quarterly := row("Retention", "retention", "north", "value", map[string]string{"value": "val"})
	quarterly.PeriodColumns = map[string]string{"G": "2025-Q3"}
	cs := parse(t, monthsSheet(monthsRow("Retention", map[string]string{"F": "10%", "G": "95%"})), monthsTemplate(quarterly), base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", qtr(3), 95)
	if len(cs.Data) != 1 {
		t.Errorf("writes = %d, want 1", len(cs.Data))
	}
}

func TestDailyAverageAcceptsScoreChange(t *testing.T) {
	m := metric("defects", "sum / days", domain.FormatNumber0, domain.FrequencyMonthly, bands(2000, 1000, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{m}))
	tpl := dataTemplate(row("Defects", "defects", "north", "daily_average", map[string]string{"sum": "sum", "days": "days"}))
	cs := parse(t, dataSheet([]any{"Defects", "1587 | 12% Quality Increase | G"}), tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "sum", "north", mon(1), 1587*31)
	wantValue(t, cs, "days", "north", mon(1), 31)
	// 1587 is below the yellow line of 1000..2000 (Y); the recorded G is an override.
	if len(cs.Overrides) != 1 || cs.Overrides[0].Status != "G" || cs.Overrides[0].Period != mon(1) {
		t.Errorf("overrides = %+v, want the recorded G", cs.Overrides)
	}
	if len(findingsOf(cs, changeset.SeverityWarn)) != 0 {
		t.Errorf("unexpected warnings: %+v", cs.Findings)
	}
}

func TestConvertersAcceptRecordedStatusShapes(t *testing.T) {
	tests := []struct {
		name, convert, cell string
		measures            map[string]string
		want                map[string]float64
		ok                  bool
	}{
		{"daily_average percent with status", "daily_average", "99.5 | G", map[string]string{"sum": "sum", "days": "days"}, map[string]float64{"sum": 99.5 * 31, "days": 31}, true},
		{"daily_average bare number", "daily_average", "4.5", map[string]string{"sum": "sum", "days": "days"}, map[string]float64{"sum": 139.5, "days": 31}, true},
		{"daily_average percent without status", "daily_average", "50%", map[string]string{"sum": "sum", "days": "days"}, nil, false},
		{"daily_average ratio", "daily_average", "3/4", map[string]string{"sum": "sum", "days": "days"}, nil, false},
		{"money_k score change", "money_k", "8234 | 3% Increase | Y", map[string]string{"value": "val"}, map[string]float64{"val": 8234}, true},
		{"money_k number with status", "money_k", "8234 | G", map[string]string{"value": "val"}, map[string]float64{"val": 8234}, true},
		{"money_k bare number", "money_k", "8234", map[string]string{"value": "val"}, nil, false},
		{"money_k plain", "money_k", "$8,234k", map[string]string{"value": "val"}, map[string]float64{"val": 8234}, true},
		{"value score change", "value", "1587 | 12% Quality Increase | G", map[string]string{"value": "val"}, map[string]float64{"val": 1587}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := metric("m", "val", domain.FormatNumber0, domain.FrequencyMonthly, bands(50, 20, true))
			if tt.convert == "daily_average" {
				m.Formula = "sum / days"
			}
			base := baseInput(t, versions(allMeasures, []domain.Metric{m}))
			cs := parse(t, dataSheet([]any{"M", tt.cell}), dataTemplate(row("M", "m", "north", tt.convert, tt.measures)), base)
			if !tt.ok {
				if len(cs.Data) != 0 || !hasFinding(cs, changeset.SeverityWarn, "Data", "B2", "") {
					t.Errorf("want a warning and no writes: %+v", cs)
				}
				return
			}
			noErrors(t, cs)
			if len(cs.Data) != len(tt.want) {
				t.Errorf("writes = %d, want %d", len(cs.Data), len(tt.want))
			}
			for k, v := range tt.want {
				wantValue(t, cs, k, "north", mon(1), v)
			}
		})
	}
}

func TestValidateRejectsDuplicateRowMappings(t *testing.T) {
	meas := map[string]string{"value": "val"}
	mk := func(rowNum int, label string) RowMap {
		rm := row(label, "m", "north", "value", meas)
		rm.Row = rowNum
		return rm
	}
	hasMsg := func(fs []changeset.Finding, substr string) bool {
		for _, f := range fs {
			if f.Severity == changeset.SeverityError && strings.Contains(f.Message, substr) {
				return true
			}
		}
		return false
	}

	// The same row twice, even under different labels.
	fs := dataTemplate(mk(5, "North"), mk(5, "South")).Validate()
	if !hasMsg(fs, "row 5") || !hasMsg(fs, "twice") {
		t.Errorf("duplicate (sheet, row) accepted: %+v", fs)
	}

	// Different rows with the same label are fine: that is what Row is for.
	if fs := dataTemplate(mk(5, "North"), mk(9, "North")).Validate(); len(fs) != 0 {
		t.Errorf("repeated label on different rows rejected: %+v", fs)
	}

	// A label-based and a row-based mapping may share a label.
	if fs := dataTemplate(row("North", "m", "north", "value", meas), mk(9, "North")).Validate(); len(fs) != 0 {
		t.Errorf("label + row mapping rejected: %+v", fs)
	}

	// Row without a label is fine; row < 1 is not.
	if fs := dataTemplate(mk(5, "")).Validate(); len(fs) != 0 {
		t.Errorf("row without label rejected: %+v", fs)
	}
	if fs := dataTemplate(mk(-1, "North")).Validate(); !hasMsg(fs, "row") {
		t.Errorf("negative row accepted: %+v", fs)
	}

	// An explicit row must map a metric (it cannot be a section header).
	hdr := RowMap{Row: 3, Label: "Block"}
	if fs := dataTemplate(hdr).Validate(); !hasMsg(fs, "metric") {
		t.Errorf("row mapping without a metric accepted: %+v", fs)
	}

	// Same row on different sheets is fine.
	a, b := mk(5, "North"), mk(5, "North")
	tpl := Template{
		Sheets: []SheetMap{
			{Sheet: "One", FiscalYear: 2025, LabelColumn: "A", MonthColumns: map[string]int{"B": 1}},
			{Sheet: "Two", FiscalYear: 2025, LabelColumn: "A", MonthColumns: map[string]int{"B": 1}},
		},
		Rows: []RowMap{a, b},
	}
	tpl.Rows[0].Sheet, tpl.Rows[1].Sheet = "One", "Two"
	if fs := tpl.Validate(); len(fs) != 0 {
		t.Errorf("same row on two sheets rejected: %+v", fs)
	}
}

func TestValidateRowPeriodColumns(t *testing.T) {
	meas := map[string]string{"value": "val"}
	withPeriods := func(pc map[string]string) []changeset.Finding {
		rm := row("Retention", "m", "north", "value", meas)
		rm.PeriodColumns = pc
		return dataTemplate(rm).Validate()
	}
	cases := map[string]map[string]string{
		"bad column":       {"1": "2025-Q1"},
		"bad period":       {"F": "Q1 2025"},
		"duplicate period": {"F": "2025-Q1", "G": "2025-Q1"},
		"duplicate column": {"F": "2025-Q1", "f": "2025-Q2"},
		"label column":     {"A": "2025-Q1"},
		"ytd column":       {"E": "2025-Q1"},
	}
	for name, pc := range cases {
		if fs := withPeriods(pc); len(fs) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
	if fs := withPeriods(map[string]string{"F": "2025-Q1", "I": "2025-Q2"}); len(fs) != 0 {
		t.Errorf("valid row periodColumns rejected: %+v", fs)
	}
}

func TestParseTemplateAcceptsRowFields(t *testing.T) {
	const doc = `{
	  "sheets": [{"sheet": "Data", "fiscalYear": 2025, "labelColumn": "A", "monthColumns": {"B": 1}}],
	  "rows": [{"sheet": "Data", "row": 4, "label": "North", "metric": "m", "subject": "north",
	    "convert": "value", "measures": {"value": "val"}, "periodColumns": {"C": "2025-Q1"}}]
	}`
	tpl, fs, err := ParseTemplate([]byte(doc))
	if err != nil || len(fs) != 0 {
		t.Fatalf("err = %v, findings = %+v", err, fs)
	}
	if tpl.Rows[0].Row != 4 || tpl.Rows[0].PeriodColumns["C"] != "2025-Q1" {
		t.Errorf("row = %+v", tpl.Rows[0])
	}
}

// The template example in the bootstrap guide must stay a valid template.
func TestDocTemplateExampleValidates(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/deploy/local-bootstrap.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(doc)
	i := strings.Index(text, "## Import template reference")
	if i < 0 {
		t.Fatal("no template reference in the doc")
	}
	text = text[i:]
	const open = "```json\n"
	i = strings.Index(text, open)
	if i < 0 {
		t.Fatal("no json example in the template reference")
	}
	text = text[i+len(open):]
	j := strings.Index(text, "```")
	if j < 0 {
		t.Fatal("unterminated json example")
	}
	tpl, fs, err := ParseTemplate([]byte(text[:j]))
	if err != nil || len(fs) != 0 {
		t.Fatalf("documented template is not valid: err = %v, findings = %+v", err, fs)
	}
	if len(tpl.Rows) != 5 || tpl.Rows[4].Row != 9 {
		t.Errorf("rows = %+v", tpl.Rows)
	}
}
