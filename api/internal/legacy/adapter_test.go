package legacy

import (
	"bytes"
	"encoding/json"
	"flag"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/store"
	"opsvision/internal/xlsx"
	"opsvision/internal/xlsx/xlsxtest"
)

// update rewrites testdata/legacy_sample.xlsx from sampleSheets:
//
//	go test ./internal/legacy -run TestSampleFixtureUpToDate -update
var update = flag.Bool("update", false, "rewrite testdata/legacy_sample.xlsx")

const sampleFile = "testdata/legacy_sample.xlsx"

// ---- shared helpers ---------------------------------------------------------

func mon(idx int) period.Period { return period.Period{Grain: period.Month, FY: 2025, Index: idx} }

func qtr(idx int) period.Period { return period.Period{Grain: period.Quarter, FY: 2025, Index: idx} }

var utc = time.UTC

func bands(gv, yv float64, higher bool) []domain.Band {
	op := ">="
	if !higher {
		op = "<="
	}
	return []domain.Band{{Status: "G", Op: op, Value: gv}, {Status: "Y", Op: op, Value: yv}, {Status: "R"}}
}

func orgTree(t *testing.T) *orgtree.Tree {
	t.Helper()
	tree, err := orgtree.New([]domain.OrgUnit{
		{ID: "company", Name: "Company", LevelID: "co"},
		{ID: "north", Name: "North Segment", LevelID: "seg", ParentID: "company"},
		{ID: "south", Name: "South Segment", LevelID: "seg", ParentID: "company"},
	}, nil)
	if err != nil {
		t.Fatalf("orgtree.New: %v", err)
	}
	return tree
}

func measure(key string) domain.Measure {
	return domain.Measure{Key: key, Name: key, OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}
}

func metric(key, formula, format string, freq domain.Frequency, bs []domain.Band) domain.Metric {
	return domain.Metric{
		Key: key, Name: key, Formula: formula, Format: format,
		Direction: domain.DirectionHigherBetter, Frequency: freq,
		Rule: domain.StatusRule{Type: domain.RuleBands, Bands: bs},
	}
}

// versions returns a published version in force for fiscal year 2025 and a
// draft copy, both holding the given measures and metrics.
func versions(measures []string, metrics []domain.Metric) []domain.MethodologyVersion {
	content := domain.Methodology{Metrics: metrics}
	for _, k := range measures {
		content.Measures = append(content.Measures, measure(k))
	}
	pub := time.Date(2025, 1, 1, 0, 0, 0, 0, utc)
	return []domain.MethodologyVersion{
		{ID: "v1", ScorecardID: "sc", Name: "v1", Status: domain.VersionPublished, PublishedAt: &pub,
			EffectiveFrom: period.Period{Grain: period.Year, FY: 2025}, Revision: 1, Content: content},
		{ID: "v2-draft", ScorecardID: "sc", Name: "v2", Status: domain.VersionDraft,
			EffectiveFrom: period.Period{Grain: period.Year, FY: 2026}, Revision: 1, Content: content},
	}
}

func baseInput(t *testing.T, vs []domain.MethodologyVersion) *engine.Input {
	t.Helper()
	return &engine.Input{
		Cal:      period.Calendar{FiscalYearStartMonth: time.January},
		Tree:     orgTree(t),
		Items:    []domain.TrackedItem{{ID: "svc-1", KindID: "service", Name: "Service One", OrgUnitID: "north"}},
		Versions: vs,
	}
}

func openSheets(t *testing.T, sheets []xlsxtest.Sheet) *xlsx.Workbook {
	t.Helper()
	b := xlsxtest.Build(t, sheets)
	wb, err := xlsx.Open(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("xlsx.Open: %v", err)
	}
	return wb
}

func point(cs changeset.ChangeSet, measureKey, subject string, p period.Period) (domain.DataPoint, bool) {
	for _, w := range cs.Data {
		if w.Point.MeasureKey == measureKey && w.Point.SubjectID == subject && w.Point.Period == p {
			return w.Point, true
		}
	}
	return domain.DataPoint{}, false
}

func wantValue(t *testing.T, cs changeset.ChangeSet, measureKey, subject string, p period.Period, want float64) {
	t.Helper()
	dp, ok := point(cs, measureKey, subject, p)
	if !ok {
		t.Errorf("no write for %s/%s/%s; findings: %+v", measureKey, subject, p, cs.Findings)
		return
	}
	if dp.Value == nil || math.Abs(*dp.Value-want) > 1e-9 {
		t.Errorf("%s/%s/%s = %v, want %v", measureKey, subject, p, dp.Value, want)
	}
}

func findingsOf(cs changeset.ChangeSet, severity string) []changeset.Finding {
	var out []changeset.Finding
	for _, f := range cs.Findings {
		if f.Severity == severity {
			out = append(out, f)
		}
	}
	return out
}

// wantFinding reports whether a finding of the severity exists at sheet/cell
// (cell "" matches any) whose message contains substr.
func hasFinding(cs changeset.ChangeSet, severity, sheet, cell, substr string) bool {
	for _, f := range cs.Findings {
		if f.Severity == severity && (sheet == "" || f.Sheet == sheet) && (cell == "" || f.Cell == cell) && strings.Contains(f.Message, substr) {
			return true
		}
	}
	return false
}

func noErrors(t *testing.T, cs changeset.ChangeSet) {
	t.Helper()
	if es := findingsOf(cs, changeset.SeverityError); len(es) > 0 {
		t.Errorf("unexpected error findings: %+v", es)
	}
}

// ---- the sample workbook ------------------------------------------------------

func scRow(label string, baseline, goal, jan, feb, mar any) []any {
	return []any{label, baseline, goal, nil, nil, jan, feb, mar, nil}
}

// sampleSheets is the synthetic legacy workbook: a data sheet with two
// sections (the same two segment labels appear under both), and a methodology
// sheet.
func sampleSheets() []xlsxtest.Sheet {
	return []xlsxtest.Sheet{
		{
			Name: "Scorecard",
			Rows: [][]any{
				{"Metric", "Baseline", "Goal", nil, nil, "Jan", "Feb", "Mar", "YTD"},
				scRow("Epics on time", nil, nil, nil, nil, nil),
				scRow("North Segment", "70%", "80%", "48|66 | 73% | Y", "50|60 | 83% | G", "0|0 | 0%"),
				scRow("South Segment", "70%", "80%", "20|40 | 50% | G", "30|40 | 75% | Y", "10|20 | 50% | R"),
				scRow("Uptime", nil, nil, nil, nil, nil),
				scRow("North Segment", "99.5%", "99.9%", "99.64%", "99.95% | G", "#N/A"),
				scRow("South Segment", "99.5%", "99.9%", "99.91%", "99.2% | R", "99.97%"),
			},
			Comments: []xlsxtest.Comment{
				{Ref: "G3", Author: "Pat Example", Text: "Two epics slipped because of a vendor delay.", At: time.Date(2025, 3, 4, 10, 0, 0, 0, utc)},
				{Ref: "B3", Author: "Pat Example", Text: "Baseline carried over from last year.", At: time.Date(2025, 3, 4, 10, 5, 0, 0, utc)},
			},
		},
		{
			Name: "Methodology",
			Rows: [][]any{
				{"Metric", "Frequency", "Definition", "Green", "Yellow", "Red", "Source", "Notes", "Link"},
				{"Epics on time", "Monthly", "Share of epics delivered by the committed date.", ">=80%", ">=60% <80%", "<60%", nil, nil, nil},
				{"Uptime", " monthly ", "Share of time the service was available.", ">=99.9%", ">=99.5% <99.9%", "<99.5%",
					"Monitoring export", "Planned maintenance is excluded.", "https://example.com/uptime"},
			},
		},
	}
}

func sampleMetrics() []domain.Metric {
	return []domain.Metric{
		metric("epics_on_time", "epics_done / epics_total * 100", domain.FormatPercent0, domain.FrequencyMonthly, bands(80, 60, true)),
		metric("uptime", "(1 - seconds_down / seconds_in_period) * 100", domain.FormatPercent2, domain.FrequencyMonthly, bands(99.9, 99.5, true)),
	}
}

func sampleBase(t *testing.T) *engine.Input {
	return baseInput(t, versions([]string{"epics_done", "epics_total", "seconds_down", "seconds_in_period"}, sampleMetrics()))
}

func sampleTemplate() Template {
	ratio := map[string]string{"num": "epics_done", "den": "epics_total"}
	up := map[string]string{"down": "seconds_down", "period": "seconds_in_period"}
	return Template{
		Sheets: []SheetMap{{
			Sheet: "Scorecard", FiscalYear: 2025, LabelColumn: "A",
			MonthColumns: map[string]int{"F": 1, "G": 2, "H": 3},
		}},
		Rows: []RowMap{
			{Sheet: "Scorecard", Label: "Epics on time"},
			{Sheet: "Scorecard", Section: "Epics on time", Label: "North Segment", Metric: "epics_on_time", Subject: "north", Convert: "ratio", Measures: ratio},
			{Sheet: "Scorecard", Section: "Epics on time", Label: "South Segment", Metric: "epics_on_time", Subject: "south", Convert: "ratio", Measures: ratio},
			{Sheet: "Scorecard", Label: "Uptime"},
			{Sheet: "Scorecard", Section: "Uptime", Label: "North Segment", Metric: "uptime", Subject: "north", Convert: "uptime_percent", Measures: up},
			{Sheet: "Scorecard", Section: "Uptime", Label: "South Segment", Metric: "uptime", Subject: "south", Convert: "uptime_percent", Measures: up},
		},
		Methodology: []MethodologyMap{{
			Sheet: "Methodology", VersionID: "v2-draft",
			Rows: map[string]string{"Epics on time": "epics_on_time", "Uptime": "uptime"},
			Columns: map[string]string{"B": "frequency", "C": "definition", "D": "green", "E": "yellow", "F": "red",
				"G": "source", "H": "notes", "I": "link"},
		}},
	}
}

const sampleTemplateJSON = `{
  "sheets": [{"sheet": "Scorecard", "fiscalYear": 2025, "labelColumn": "A",
              "monthColumns": {"F": 1, "G": 2, "H": 3}}],
  "rows": [
    {"sheet": "Scorecard", "label": "Epics on time"},
    {"sheet": "Scorecard", "section": "Epics on time", "label": "North Segment", "metric": "epics_on_time", "subject": "north",
     "convert": "ratio", "measures": {"num": "epics_done", "den": "epics_total"}},
    {"sheet": "Scorecard", "section": "Epics on time", "label": "South Segment", "metric": "epics_on_time", "subject": "south",
     "convert": "ratio", "measures": {"num": "epics_done", "den": "epics_total"}},
    {"sheet": "Scorecard", "label": "Uptime"},
    {"sheet": "Scorecard", "section": "Uptime", "label": "North Segment", "metric": "uptime", "subject": "north",
     "convert": "uptime_percent", "measures": {"down": "seconds_down", "period": "seconds_in_period"}},
    {"sheet": "Scorecard", "section": "Uptime", "label": "South Segment", "metric": "uptime", "subject": "south",
     "convert": "uptime_percent", "measures": {"down": "seconds_down", "period": "seconds_in_period"}}
  ],
  "methodology": [{"sheet": "Methodology", "versionId": "v2-draft",
    "rows": {"Epics on time": "epics_on_time", "Uptime": "uptime"},
    "columns": {"B": "frequency", "C": "definition", "D": "green", "E": "yellow", "F": "red",
                "G": "source", "H": "notes", "I": "link"}}]
}`

func TestSampleFixtureUpToDate(t *testing.T) {
	want := xlsxtest.Build(t, sampleSheets())
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(sampleFile, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(sampleFile)
	if err != nil {
		t.Fatalf("%v (generate it with: go test ./internal/legacy -run TestSampleFixtureUpToDate -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is out of date with sampleSheets; regenerate with: go test ./internal/legacy -run TestSampleFixtureUpToDate -update", sampleFile)
	}
}

func sampleChangeSet(t *testing.T) changeset.ChangeSet {
	t.Helper()
	f, err := os.Open(sampleFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	wb, err := xlsx.Open(f, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	return ParseWorkbook(wb, sampleTemplate(), sampleBase(t))
}

func TestSampleChangeSetBasics(t *testing.T) {
	cs := sampleChangeSet(t)
	if cs.Source != changeset.SourceLegacyWorkbook || cs.Status != changeset.StatusParsed {
		t.Errorf("source/status = %q/%q", cs.Source, cs.Status)
	}
	if cs.ID != "" || cs.CreatedBy != "" || !cs.CreatedAt.IsZero() {
		t.Errorf("ID/CreatedBy/CreatedAt must be left to the caller: %+v", cs)
	}
	if cs.Data == nil || cs.Overrides == nil || cs.VersionText == nil || cs.Notes == nil || cs.Findings == nil {
		t.Errorf("slices must be non-nil: %+v", cs)
	}
	noErrors(t, cs)
}

func TestRatioRowsBecomeMeasures(t *testing.T) {
	cs := sampleChangeSet(t)
	wantValue(t, cs, "epics_done", "north", mon(1), 48)
	wantValue(t, cs, "epics_total", "north", mon(1), 66)
	wantValue(t, cs, "epics_done", "south", mon(2), 30)
	wantValue(t, cs, "epics_total", "south", mon(2), 40)
	for _, w := range cs.Data {
		if w.ExpectedRevision != store.Unconditional || w.Point.Source != domain.SourceLegacy {
			t.Fatalf("write %+v: want unconditional legacy write", w)
		}
	}
	// 6 ratio cells x 2 measures + 5 uptime cells (one is #N/A) x 2 measures.
	if len(cs.Data) != 22 {
		t.Errorf("writes = %d, want 22", len(cs.Data))
	}
}

func TestSectionScoping(t *testing.T) {
	cs := sampleChangeSet(t)
	// "North Segment" appears under both sections and maps to different metrics.
	wantValue(t, cs, "epics_done", "north", mon(1), 48)
	wantValue(t, cs, "seconds_in_period", "north", mon(1), 2678400)
	if _, ok := point(cs, "seconds_down", "north", mon(3)); ok {
		t.Error("the #N/A uptime cell was written")
	}
}

func TestUptimePercentConversion(t *testing.T) {
	cs := sampleChangeSet(t)
	wantValue(t, cs, "seconds_in_period", "north", mon(1), 2678400)
	wantValue(t, cs, "seconds_down", "north", mon(1), 9642)
	// February 2025 has 28 days.
	wantValue(t, cs, "seconds_in_period", "north", mon(2), 2419200)
	wantValue(t, cs, "seconds_down", "north", mon(2), 1210)
}

func TestMismatchBecomesOverride(t *testing.T) {
	cs := sampleChangeSet(t)
	// 20/40 is 50%, which the methodology judges R; the workbook said G. Every
	// other recorded status agrees with the methodology.
	if len(cs.Overrides) != 1 {
		t.Fatalf("overrides = %+v, want exactly one", cs.Overrides)
	}
	o := cs.Overrides[0]
	if o.MetricKey != "epics_on_time" || o.SubjectID != "south" || o.Period != mon(1) || o.Status != "G" ||
		o.Reason != "As reported in legacy workbook" || o.Value != nil {
		t.Errorf("override = %+v", o)
	}
}

func TestZeroOverZeroIsNA(t *testing.T) {
	cs := sampleChangeSet(t)
	for _, k := range []string{"epics_done", "epics_total"} {
		dp, ok := point(cs, k, "north", mon(3))
		if !ok {
			t.Fatalf("no NA point for %s", k)
		}
		if dp.Value != nil || dp.NAReason == "" {
			t.Errorf("%s = %+v, want an NA point with a reason", k, dp)
		}
	}
}

func TestUnparsedCellFinding(t *testing.T) {
	cs := sampleChangeSet(t)
	if !hasFinding(cs, changeset.SeverityWarn, "Scorecard", "H6", "#N/A") {
		t.Errorf("no warn finding for Scorecard!H6: %+v", cs.Findings)
	}
	for _, f := range cs.Findings {
		if f.Cell == "H6" && !strings.Contains(f.Message, "Scorecard!H6") {
			t.Errorf("message should carry the Sheet!A1 reference: %q", f.Message)
		}
	}
}

func TestCommentsBecomeLegacyNotes(t *testing.T) {
	cs := sampleChangeSet(t)
	if len(cs.Notes) != 1 {
		t.Fatalf("notes = %+v, want one", cs.Notes)
	}
	n := cs.Notes[0]
	if n.MetricKey != "epics_on_time" || n.SubjectID != "north" || n.Period != mon(2) ||
		n.Author != "Pat Example" || n.Text != "Two epics slipped because of a vendor delay." {
		t.Errorf("note = %+v", n)
	}
	if n.At == nil || !n.At.Equal(time.Date(2025, 3, 4, 10, 0, 0, 0, utc)) {
		t.Errorf("note time = %v", n.At)
	}
	// The comment on the baseline column is not mapped: counted, not imported.
	if !hasFinding(cs, changeset.SeverityInfo, "Scorecard", "", "1 comment") {
		t.Errorf("no info finding for the unmapped comment: %+v", cs.Findings)
	}
}

func TestMethodologyTextToDraft(t *testing.T) {
	cs := sampleChangeSet(t)
	get := func(metricKey, field string) (string, bool) {
		for _, c := range cs.VersionText {
			if c.VersionID == "v2-draft" && c.MetricKey == metricKey && c.Field == field {
				return c.Value, true
			}
		}
		return "", false
	}
	if v, ok := get("epics_on_time", "definition"); !ok || v != "Share of epics delivered by the committed date." {
		t.Errorf("definition = %q, %v", v, ok)
	}
	if v, ok := get("uptime", "frequency"); !ok || v != "monthly" {
		t.Errorf("frequency = %q, %v (text is trimmed and case-insensitive)", v, ok)
	}
	for _, f := range []string{"source", "notes", "link"} {
		if _, ok := get("epics_on_time", f); ok {
			t.Errorf("empty %s cell produced a change", f)
		}
	}
	if v, _ := get("uptime", "link"); v != "https://example.com/uptime" {
		t.Errorf("link = %q", v)
	}
	raw, ok := get("epics_on_time", "bands")
	if !ok {
		t.Fatal("no bands change")
	}
	var bv changeset.BandsValue
	if err := json.Unmarshal([]byte(raw), &bv); err != nil {
		t.Fatal(err)
	}
	wantBands := []domain.Band{{Status: "G", Op: ">=", Value: 80}, {Status: "Y", Op: ">=", Value: 60}, {Status: "R"}}
	if !reflect.DeepEqual(bv.Bands, wantBands) || bv.Direction != domain.DirectionHigherBetter {
		t.Errorf("bands = %+v", bv)
	}
	// 3 changes for the first row, 6 for the second.
	if len(cs.VersionText) != 9 {
		t.Errorf("version text changes = %d, want 9: %+v", len(cs.VersionText), cs.VersionText)
	}
	noErrors(t, cs)
}

// ---- in-memory workbooks --------------------------------------------------------

var allMeasures = []string{"num", "den", "val", "mx", "down", "per", "sum", "days"}

// dataTemplate maps sheet "Data" (labels in A, Jan-Mar in B-D, optional YTD
// in E) to the given rows.
func dataTemplate(rows ...RowMap) Template {
	for i := range rows {
		rows[i].Sheet = "Data"
	}
	return Template{
		Sheets: []SheetMap{{Sheet: "Data", FiscalYear: 2025, LabelColumn: "A", MonthColumns: map[string]int{"B": 1, "C": 2, "D": 3}, YTDColumn: "E"}},
		Rows:   rows,
	}
}

func row(label, metricKey, subject, convert string, measures map[string]string) RowMap {
	return RowMap{Label: label, Metric: metricKey, Subject: subject, Convert: convert, Measures: measures}
}

func dataSheet(rows ...[]any) []xlsxtest.Sheet {
	return []xlsxtest.Sheet{{Name: "Data", Rows: append([][]any{{"Metric", "Jan", "Feb", "Mar", "YTD"}}, rows...)}}
}

func parse(t *testing.T, sheets []xlsxtest.Sheet, tpl Template, base *engine.Input) changeset.ChangeSet {
	t.Helper()
	return ParseWorkbook(openSheets(t, sheets), tpl, base)
}

func valueMetric(key string) domain.Metric {
	return metric(key, "val", domain.FormatNumber0, domain.FrequencyMonthly, bands(50, 20, true))
}

func TestPeriodColumnsQuarterly(t *testing.T) {
	q := metric("retention", "val", domain.FormatPercent0, domain.FrequencyQuarterly, bands(90, 80, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{q}))
	tpl := dataTemplate(row("Retention", "retention", "north", "value", map[string]string{"value": "val"}))
	tpl.Sheets[0].PeriodColumns = map[string]string{"B": "2025-Q4"} // wins over MonthColumns B=1
	cs := parse(t, dataSheet([]any{"Retention", "85%"}), tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", qtr(4), 85)
	if _, ok := point(cs, "val", "north", mon(1)); ok {
		t.Error("explicit period column also wrote the month")
	}
	if len(cs.Data) != 1 {
		t.Errorf("writes = %d, want 1", len(cs.Data))
	}
	// 85% is below the 90 green line: the workbook's Y is what the engine says, no override.
	if len(cs.Overrides) != 0 {
		t.Errorf("overrides = %+v", cs.Overrides)
	}
}

func TestFrequencyGrainMismatchIsError(t *testing.T) {
	q := metric("retention", "val", domain.FormatPercent0, domain.FrequencyQuarterly, bands(90, 80, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{q}))
	tpl := dataTemplate(row("Retention", "retention", "north", "value", map[string]string{"value": "val"}))
	cs := parse(t, dataSheet([]any{"Retention", "85%"}), tpl, base) // a monthly column for a quarterly metric
	if !hasFinding(cs, changeset.SeverityError, "Data", "B2", "quarterly") {
		t.Errorf("no grain mismatch error: %+v", cs.Findings)
	}
	if len(cs.Data) != 0 || len(cs.Overrides) != 0 {
		t.Errorf("a mismatched cell still produced writes: %+v", cs)
	}

	// And the other way round: a monthly metric under an explicit quarter column.
	mm := valueMetric("m")
	base = baseInput(t, versions(allMeasures, []domain.Metric{mm}))
	tpl = dataTemplate(row("M", "m", "north", "value", map[string]string{"value": "val"}))
	tpl.Sheets[0].PeriodColumns = map[string]string{"B": "2025-Q1"}
	cs = parse(t, dataSheet([]any{"M", "40"}), tpl, base)
	if !hasFinding(cs, changeset.SeverityError, "Data", "B2", "monthly") || len(cs.Data) != 0 {
		t.Errorf("monthly metric on a quarter column: %+v", cs)
	}
}

func TestDuplicateWriteIsError(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
	meas := map[string]string{"value": "val"}
	tpl := dataTemplate(
		row("First", "m", "north", "value", meas),
		row("Second", "m", "north", "value", meas),
	)
	cs := parse(t, dataSheet([]any{"First", "40", "41"}, []any{"Second", "10", "42"}), tpl, base)
	wantValue(t, cs, "val", "north", mon(1), 40) // the first row wins
	wantValue(t, cs, "val", "north", mon(2), 41)
	if len(cs.Data) != 2 {
		t.Errorf("writes = %d, want 2", len(cs.Data))
	}
	if !hasFinding(cs, changeset.SeverityError, "Data", "B3", "Data!B2") || !hasFinding(cs, changeset.SeverityError, "Data", "C3", "Data!C2") {
		t.Errorf("duplicate findings missing or without the first reference: %+v", cs.Findings)
	}
}

func TestUnknownSubjectAndAbsentMeasure(t *testing.T) {
	base := baseInput(t, versions([]string{"val"}, []domain.Metric{valueMetric("m")}))
	tpl := dataTemplate(
		row("Ghost", "m", "nowhere", "value", map[string]string{"value": "val"}),
		row("Item", "m", "svc-1", "value", map[string]string{"value": "val"}),
		row("NoMeasure", "m", "north", "value", map[string]string{"value": "not_a_measure"}),
		row("NoMetric", "unknown_metric", "north", "value", map[string]string{"value": "val"}),
	)
	cs := parse(t, dataSheet([]any{"Ghost", "40"}, []any{"Item", "41"}, []any{"NoMeasure", "42"}, []any{"NoMetric", "43"}), tpl, base)
	if !hasFinding(cs, changeset.SeverityError, "Data", "", "nowhere") {
		t.Errorf("no unknown-subject error: %+v", cs.Findings)
	}
	if !hasFinding(cs, changeset.SeverityError, "Data", "B4", "not_a_measure") {
		t.Errorf("no absent-measure error: %+v", cs.Findings)
	}
	if !hasFinding(cs, changeset.SeverityError, "Data", "B5", "unknown_metric") {
		t.Errorf("no unknown-metric error: %+v", cs.Findings)
	}
	wantValue(t, cs, "val", "svc-1", mon(1), 41) // a tracked item is a valid subject
	if len(cs.Data) != 1 {
		t.Errorf("writes = %+v, want only the tracked-item write", cs.Data)
	}
}

func TestNoVersionInForceIsError(t *testing.T) {
	vs := versions(allMeasures, []domain.Metric{valueMetric("m")})
	vs = vs[1:] // only the draft remains
	cs := parse(t, dataSheet([]any{"M", "40"}), dataTemplate(row("M", "m", "north", "value", map[string]string{"value": "val"})), baseInput(t, vs))
	if !hasFinding(cs, changeset.SeverityError, "Data", "B2", "in force") || len(cs.Data) != 0 {
		t.Errorf("findings = %+v, data = %+v", cs.Findings, cs.Data)
	}
}

func TestYTDMismatchWarns(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m"), valueMetric("n")}))
	meas := map[string]string{"value": "val"}
	tpl := dataTemplate(row("Good", "m", "north", "value", meas), row("Bad", "m", "south", "value", meas))
	cs := parse(t, dataSheet(
		[]any{"Good", "10", "20", nil, "30"}, // 10 + 20 = 30 through Feb
		[]any{"Bad", "10", "20", nil, "31"},
	), tpl, base)
	noErrors(t, cs)
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "E3", "YTD") {
		t.Errorf("no YTD warning on E3: %+v", cs.Findings)
	}
	if hasFinding(cs, changeset.SeverityWarn, "Data", "E2", "") {
		t.Errorf("matching YTD warned: %+v", cs.Findings)
	}
	if len(cs.Overrides) != 0 {
		t.Errorf("a YTD mismatch must not create an override: %+v", cs.Overrides)
	}
}

func TestMoneyMTripleConverter(t *testing.T) {
	m := metric("revenue", "val", domain.FormatMoneyK, domain.FrequencyMonthly, bands(1200, 1000, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{m}))
	meas := map[string]string{"value": "val"}
	tpl := dataTemplate(
		row("Triple", "revenue", "north", "money_m_triple", meas),
		row("Plain", "revenue", "south", "money_k", meas),
	)
	cs := parse(t, dataSheet(
		[]any{"Triple", "$1.25M | +0.10M | +8% | G", "1.50M | -0.05M | -3%", "n/a"},
		[]any{"Plain", "1.50M | -0.05M | -3%"},
	), tpl, base)
	wantValue(t, cs, "val", "north", mon(1), 1250)
	wantValue(t, cs, "val", "north", mon(2), 1500) // no-$ form is accepted only by money_m_triple
	if _, ok := point(cs, "val", "south", mon(1)); ok {
		t.Error("the no-$ triple was accepted by money_k")
	}
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "B3", "") {
		t.Errorf("no warning for the money_k cell: %+v", cs.Findings)
	}
	if dp, ok := point(cs, "val", "north", mon(3)); !ok || dp.Value != nil || dp.NAReason == "" {
		t.Errorf("n/a cell = %+v, %v", dp, ok)
	}
	if len(cs.Overrides) != 0 { // the recorded G on 1250 agrees with the bands
		t.Errorf("overrides = %+v", cs.Overrides)
	}
}

func TestPctSlashCountConverter(t *testing.T) {
	m := metric("coverage", "val", domain.FormatPercent0, domain.FrequencyMonthly, bands(90, 70, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{m}))
	tpl := dataTemplate(row("Coverage", "coverage", "north", "pct_slash_count", map[string]string{"value": "val"}))
	cs := parse(t, dataSheet([]any{"Coverage", "85% / 12 / Y", "60% / 5 / G", "92% / 30"}), tpl, base)
	noErrors(t, cs)
	wantValue(t, cs, "val", "north", mon(1), 85)
	wantValue(t, cs, "val", "north", mon(2), 60)
	wantValue(t, cs, "val", "north", mon(3), 92)
	if len(cs.Overrides) != 1 || cs.Overrides[0].Period != mon(2) || cs.Overrides[0].Status != "G" {
		t.Errorf("overrides = %+v, want only Feb's reported G", cs.Overrides)
	}
}

func TestConverters(t *testing.T) {
	tests := []struct {
		name    string
		convert string
		measure map[string]string
		cell    string
		want    map[string]float64
	}{
		{"value percent", "value", map[string]string{"value": "val"}, "72%", map[string]float64{"val": 72}},
		{"value score with change", "value", map[string]string{"value": "val"}, "75 | 12% Increase", map[string]float64{"val": 75}},
		{"money_k", "money_k", map[string]string{"value": "val"}, "$8,234k", map[string]float64{"val": 8234}},
		{"ratio with k", "ratio", map[string]string{"num": "num", "den": "den"}, "8234k|10471k | 79% | G", map[string]float64{"num": 8234, "den": 10471}},
		{"uptime_percent 100", "uptime_percent", map[string]string{"down": "down", "period": "per"}, "100%", map[string]float64{"down": 0, "per": 2678400}},
		{"uptime_fraction", "uptime_fraction", map[string]string{"down": "down", "period": "per"}, "0.9964", map[string]float64{"down": 9642, "per": 2678400}},
		{"score_of_max", "score_of_max", map[string]string{"value": "val", "max": "mx"}, "7 | 10", map[string]float64{"val": 7, "mx": 10}},
		{"daily_average", "daily_average", map[string]string{"sum": "sum", "days": "days"}, "4.5", map[string]float64{"sum": 139.5, "days": 31}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
			tpl := dataTemplate(row("M", "m", "north", tt.convert, tt.measure))
			cs := parse(t, dataSheet([]any{"M", tt.cell}), tpl, base)
			noErrors(t, cs)
			if len(cs.Data) != len(tt.want) {
				t.Errorf("writes = %d, want %d: %+v", len(cs.Data), len(tt.want), cs.Data)
			}
			for k, v := range tt.want {
				wantValue(t, cs, k, "north", mon(1), v)
			}
		})
	}
}

func TestKindMismatchWarns(t *testing.T) {
	cases := []struct {
		convert, cell string
		measures      map[string]string
	}{
		{"ratio", "72%", map[string]string{"num": "num", "den": "den"}},
		{"uptime_percent", "48|66 | 72% | Y", map[string]string{"down": "down", "period": "per"}},
		{"uptime_percent", "120%", map[string]string{"down": "down", "period": "per"}},
		{"uptime_fraction", "99.6%", map[string]string{"down": "down", "period": "per"}},
		{"score_of_max", "72%", map[string]string{"value": "val", "max": "mx"}},
		{"ratio", "5|0 | 0% | R", map[string]string{"num": "num", "den": "den"}},
	}
	for _, c := range cases {
		base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
		cs := parse(t, dataSheet([]any{"M", c.cell}), dataTemplate(row("M", "m", "north", c.convert, c.measures)), base)
		if !hasFinding(cs, changeset.SeverityWarn, "Data", "B2", "") || len(cs.Data) != 0 {
			t.Errorf("%s %q: findings %+v, data %+v", c.convert, c.cell, cs.Findings, cs.Data)
		}
	}
}

func TestRecordedStatusWithNoEngineStatusOverrides(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{
		metric("m", "num / den * 100", domain.FormatPercent0, domain.FrequencyMonthly, bands(80, 60, true))}))
	tpl := dataTemplate(row("M", "m", "north", "ratio", map[string]string{"num": "num", "den": "den"}))
	cs := parse(t, dataSheet([]any{"M", "0|0 | 0% | G"}), tpl, base)
	if dp, ok := point(cs, "num", "north", mon(1)); !ok || dp.Value != nil {
		t.Errorf("0/0 point = %+v, %v", dp, ok)
	}
	if len(cs.Overrides) != 1 || cs.Overrides[0].Status != "G" || cs.Overrides[0].Value != nil {
		t.Errorf("overrides = %+v, want a status-only override", cs.Overrides)
	}
}

func TestMismatchUsesImportedValuesNotExistingOnes(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{
		metric("m", "num / den * 100", domain.FormatPercent0, domain.FrequencyMonthly, bands(80, 60, true))}))
	// Existing data would judge R (10/100); the import replaces it with 90/100 (G).
	base.Data = []domain.DataPoint{
		{MeasureKey: "num", SubjectID: "north", Period: mon(1), Value: ptr(10), Revision: 5},
		{MeasureKey: "den", SubjectID: "north", Period: mon(1), Value: ptr(100), Revision: 5},
	}
	tpl := dataTemplate(row("M", "m", "north", "ratio", map[string]string{"num": "num", "den": "den"}))
	cs := parse(t, dataSheet([]any{"M", "90|100 | 90% | G"}), tpl, base)
	if len(cs.Overrides) != 0 {
		t.Errorf("overrides = %+v, want none", cs.Overrides)
	}
}

func ptr(v float64) *float64 { return &v }

func TestExistingOverrideIsFlagged(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{
		metric("m", "num / den * 100", domain.FormatPercent0, domain.FrequencyMonthly, bands(80, 60, true))}))
	base.Overrides = []domain.Override{{MetricKey: "m", SubjectID: "north", Period: mon(1), Status: "R", Reason: "manual"}}
	tpl := dataTemplate(row("M", "m", "north", "ratio", map[string]string{"num": "num", "den": "den"}))
	cs := parse(t, dataSheet([]any{"M", "90|100 | 90% | G"}), tpl, base)
	if len(cs.Overrides) != 0 {
		t.Errorf("overrides = %+v", cs.Overrides)
	}
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "B2", "existing override") {
		t.Errorf("no warning about the existing override: %+v", cs.Findings)
	}
}

func TestValueMismatchWarnsWithoutOverride(t *testing.T) {
	// The metric doubles the value, so the workbook's 10 disagrees with the engine's 20.
	doubled := metric("m", "val * 2", domain.FormatNumber0, domain.FrequencyMonthly, bands(50, 20, true))
	// Rounded for display, 33.3 and 33.4 are the same percent: no warning.
	pct := metric("p", "val", domain.FormatPercent0, domain.FrequencyMonthly, bands(50, 20, true))
	base := baseInput(t, versions(allMeasures, []domain.Metric{doubled, pct}))
	meas := map[string]string{"value": "val"}
	tpl := dataTemplate(row("M", "m", "north", "value", meas), row("P", "p", "north", "value", meas))
	// Different measure keys are not needed: the rows write the same measure
	// "val" for the same subject, so give P its own subject.
	tpl.Rows[1].Subject = "south"
	cs := parse(t, dataSheet([]any{"M", "10"}, []any{"P", "33.3%"}), tpl, base)
	noErrors(t, cs)
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "B2", "20") {
		t.Errorf("no value mismatch warning on B2: %+v", cs.Findings)
	}
	if hasFinding(cs, changeset.SeverityWarn, "Data", "B3", "") {
		t.Errorf("rounding-level difference warned: %+v", cs.Findings)
	}
	if len(cs.Overrides) != 0 {
		t.Errorf("value differences must not create overrides: %+v", cs.Overrides)
	}
}

func TestUnmatchedMappingsWarn(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
	tpl := dataTemplate(
		row("M", "m", "north", "value", map[string]string{"value": "val"}),
		row("Missing row", "m", "south", "value", map[string]string{"value": "val"}),
	)
	// A section-scoped mapping does not match a row outside the section.
	tpl.Rows = append(tpl.Rows, RowMap{Sheet: "Data", Label: "Section"},
		RowMap{Sheet: "Data", Section: "Section", Label: "Scoped", Metric: "m", Subject: "svc-1", Convert: "value", Measures: map[string]string{"value": "val"}})
	cs := parse(t, dataSheet([]any{"Scoped", "40"}, []any{"M", "41"}), tpl, base)
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "", `"Missing row"`) {
		t.Errorf("no warning for the unmatched row mapping: %+v", cs.Findings)
	}
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "", `"Scoped"`) {
		t.Errorf("no warning for the section-scoped mapping: %+v", cs.Findings)
	}
	if !hasFinding(cs, changeset.SeverityWarn, "Data", "", `"Section"`) {
		t.Errorf("no warning for the missing section header: %+v", cs.Findings)
	}
	if _, ok := point(cs, "val", "svc-1", mon(1)); ok {
		t.Error("a scoped mapping matched outside its section")
	}
	wantValue(t, cs, "val", "north", mon(1), 41)
}

func TestMissingSheetIsError(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
	tpl := dataTemplate(row("M", "m", "north", "value", map[string]string{"value": "val"}))
	tpl.Methodology = []MethodologyMap{{Sheet: "Nope", VersionID: "v2-draft", Rows: map[string]string{"M": "m"}, Columns: map[string]string{"B": "definition"}}}
	wb := openSheets(t, []xlsxtest.Sheet{{Name: "Other", Rows: [][]any{{"x"}}}})
	cs := ParseWorkbook(wb, tpl, base)
	if !hasFinding(cs, changeset.SeverityError, "Data", "", "not found") || !hasFinding(cs, changeset.SeverityError, "Nope", "", "not found") {
		t.Errorf("findings = %+v", cs.Findings)
	}
}

func TestInvalidTemplateProducesOnlyErrors(t *testing.T) {
	base := baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
	tpl := dataTemplate(row("M", "m", "north", "frobnicate", map[string]string{"value": "val"}))
	cs := parse(t, dataSheet([]any{"M", "40"}), tpl, base)
	if len(cs.Data) != 0 || !hasFinding(cs, changeset.SeverityError, "", "", "frobnicate") {
		t.Errorf("cs = %+v", cs)
	}
	if cs.Source != changeset.SourceLegacyWorkbook || cs.Status != changeset.StatusParsed {
		t.Errorf("source/status = %q/%q", cs.Source, cs.Status)
	}
}

func TestNilBaseDoesNotPanic(t *testing.T) {
	cs := parse(t, dataSheet([]any{"M", "40"}), dataTemplate(row("M", "m", "north", "value", map[string]string{"value": "val"})), nil)
	if len(cs.Data) != 0 || len(findingsOf(cs, changeset.SeverityError)) == 0 {
		t.Errorf("cs = %+v", cs)
	}
}

// ---- methodology edge cases ---------------------------------------------------

func methodologyBase(t *testing.T) *engine.Input {
	return baseInput(t, versions(allMeasures, []domain.Metric{valueMetric("m")}))
}

func methodologyTemplate(version string) Template {
	return Template{Methodology: []MethodologyMap{{
		Sheet: "Methodology", VersionID: version,
		Rows:    map[string]string{"M": "m", "Gone": "gone"},
		Columns: map[string]string{"B": "frequency", "C": "definition", "D": "green", "E": "yellow", "F": "red"},
	}}}
}

func methodologySheet(rows ...[]any) []xlsxtest.Sheet {
	return []xlsxtest.Sheet{{Name: "Methodology", Rows: append([][]any{{"Metric", "Frequency", "Definition", "Green", "Yellow", "Red"}}, rows...)}}
}

func TestMethodologyBadBandsWarn(t *testing.T) {
	cs := parse(t, methodologySheet([]any{"M", "Fortnightly", "Def", "good", ">=50%", "<50%"}), methodologyTemplate("v2-draft"), methodologyBase(t))
	if !hasFinding(cs, changeset.SeverityWarn, "Methodology", "D2", "") {
		t.Errorf("no band warning: %+v", cs.Findings)
	}
	if !hasFinding(cs, changeset.SeverityWarn, "Methodology", "B2", "Fortnightly") {
		t.Errorf("no frequency warning: %+v", cs.Findings)
	}
	if len(cs.VersionText) != 1 || cs.VersionText[0].Field != "definition" {
		t.Errorf("version text = %+v, want only the definition", cs.VersionText)
	}
}

func TestMethodologyPartialBandsWarn(t *testing.T) {
	cs := parse(t, methodologySheet([]any{"M", nil, nil, ">=80%", nil, "<60%"}), methodologyTemplate("v2-draft"), methodologyBase(t))
	if !hasFinding(cs, changeset.SeverityWarn, "Methodology", "", "bands") || len(cs.VersionText) != 0 {
		t.Errorf("cs = %+v", cs)
	}
}

func TestMethodologyVersionChecks(t *testing.T) {
	sheet := methodologySheet([]any{"M", "Monthly", "Def", nil, nil, nil})
	cs := parse(t, sheet, methodologyTemplate("v1"), methodologyBase(t))
	if !hasFinding(cs, changeset.SeverityError, "Methodology", "", "draft") || len(cs.VersionText) != 0 {
		t.Errorf("published version: %+v", cs)
	}
	cs = parse(t, sheet, methodologyTemplate("nope"), methodologyBase(t))
	if !hasFinding(cs, changeset.SeverityError, "Methodology", "", "nope") || len(cs.VersionText) != 0 {
		t.Errorf("unknown version: %+v", cs)
	}
	cs = parse(t, methodologySheet([]any{"Gone", "Monthly", "Def", nil, nil, nil}), methodologyTemplate("v2-draft"), methodologyBase(t))
	if !hasFinding(cs, changeset.SeverityError, "Methodology", "A2", "gone") || len(cs.VersionText) != 0 {
		t.Errorf("metric missing from the draft: %+v", cs)
	}
}

// ---- template ---------------------------------------------------------------------

func TestParseTemplateJSON(t *testing.T) {
	got, fs, err := ParseTemplate([]byte(sampleTemplateJSON))
	if err != nil || len(fs) != 0 {
		t.Fatalf("err %v findings %+v", err, fs)
	}
	if !reflect.DeepEqual(got, sampleTemplate()) {
		t.Errorf("parsed template differs from sampleTemplate:\n%+v\n%+v", got, sampleTemplate())
	}
	for name, doc := range map[string]string{
		"unknown field": `{"sheets": [], "bogus": 1}`,
		"trailing data": sampleTemplateJSON + ` {}`,
		"not json":      `[`,
	} {
		if _, _, err := ParseTemplate([]byte(doc)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if _, _, err := ParseTemplate(make([]byte, MaxTemplateBytes+1)); err == nil {
		t.Error("oversized template accepted")
	}
}

func TestTemplateValidation(t *testing.T) {
	if fs := sampleTemplate().Validate(); len(fs) != 0 {
		t.Fatalf("sample template invalid: %+v", fs)
	}
	tests := []struct {
		name   string
		mutate func(*Template)
		want   string
	}{
		{"unknown converter", func(t *Template) { t.Rows[1].Convert = "magic" }, "magic"},
		{"missing measure for role", func(t *Template) { delete(t.Rows[1].Measures, "den") }, `"den"`},
		{"unknown role", func(t *Template) { t.Rows[1].Measures["extra"] = "x" }, `"extra"`},
		{"same measure twice", func(t *Template) { t.Rows[1].Measures["den"] = "epics_done" }, "same measure"},
		{"bad month column", func(t *Template) { t.Sheets[0].MonthColumns["6"] = 4 }, `"6"`},
		{"bad period column", func(t *Template) { t.Sheets[0].PeriodColumns = map[string]string{"1": "2025-Q1"} }, `"1"`},
		{"bad label column", func(t *Template) { t.Sheets[0].LabelColumn = "A1" }, "labelColumn"},
		{"bad ytd column", func(t *Template) { t.Sheets[0].YTDColumn = "!" }, "ytdColumn"},
		{"duplicate months", func(t *Template) { t.Sheets[0].MonthColumns["I"] = 1 }, "both map to period 2025-M01"},
		{"month out of range", func(t *Template) { t.Sheets[0].MonthColumns["I"] = 13 }, "not 1..12"},
		{"bad period text", func(t *Template) { t.Sheets[0].PeriodColumns = map[string]string{"I": "Q4-2025"} }, "Q4-2025"},
		{"no fiscal year", func(t *Template) { t.Sheets[0].FiscalYear = 0 }, "fiscalYear"},
		{"unknown sheet", func(t *Template) { t.Rows[1].Sheet = "Nowhere" }, "Nowhere"},
		{"unknown section", func(t *Template) { t.Rows[1].Section = "No such section" }, "No such section"},
		{"duplicate row", func(t *Template) { t.Rows = append(t.Rows, t.Rows[1]) }, "twice"},
		{"no subject", func(t *Template) { t.Rows[1].Subject = "" }, "subject"},
		{"section header with metric fields", func(t *Template) { t.Rows[0].Convert = "ratio" }, "section header"},
		{"unknown methodology field", func(t *Template) { t.Methodology[0].Columns["J"] = "colour" }, "colour"},
		{"bad methodology column", func(t *Template) { t.Methodology[0].Columns["9"] = "notes" }, `"9"`},
		{"partial bands", func(t *Template) { delete(t.Methodology[0].Columns, "F") }, "green, yellow and red"},
		{"no version", func(t *Template) { t.Methodology[0].VersionID = "" }, "versionId"},
		{"empty template", func(t *Template) { *t = Template{} }, "nothing to import"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tpl := cloneTemplate(t, sampleTemplate())
			tt.mutate(&tpl)
			fs := tpl.Validate()
			if len(fs) == 0 {
				t.Fatal("no findings")
			}
			ok := false
			for _, f := range fs {
				if f.Severity != changeset.SeverityError {
					t.Errorf("finding %+v is not an error", f)
				}
				ok = ok || strings.Contains(f.Message, tt.want)
			}
			if !ok {
				t.Errorf("no finding mentions %q: %+v", tt.want, fs)
			}
		})
	}
}

func cloneTemplate(t *testing.T, in Template) Template {
	t.Helper()
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out Template
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
