package legacy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"opsvision/internal/changeset"
	"opsvision/internal/period"
)

// Template maps a legacy workbook onto the metrics model. It is a JSON
// document uploaded next to the workbook; see ParseTemplate.
type Template struct {
	Sheets      []SheetMap       `json:"sheets"`
	Rows        []RowMap         `json:"rows"`
	Methodology []MethodologyMap `json:"methodology"`
}

// SheetMap says where a data sheet keeps its row labels and period columns.
type SheetMap struct {
	Sheet string `json:"sheet"`
	// FiscalYear is the fiscal year (labeled by the calendar year it ends in)
	// that MonthColumns refer to.
	FiscalYear  int    `json:"fiscalYear"`
	LabelColumn string `json:"labelColumn"`
	// MonthColumns maps a column letter to a fiscal month, 1..12.
	MonthColumns map[string]int `json:"monthColumns"`
	// PeriodColumns maps a column letter to an explicit period such as
	// "2025-Q4". It wins over MonthColumns for the same column.
	PeriodColumns map[string]string `json:"periodColumns"`
	// YTDColumn, when set, holds a year-to-date value that is compared with
	// the computed one. It is never imported.
	YTDColumn string `json:"ytdColumn"`
}

// RowMap maps one labelled row to a metric and subject. A RowMap with an
// empty Metric is a section header: it starts a section, and later RowMaps
// whose Section equals its label only match rows below it. A RowMap with an
// empty Section matches a row with its label anywhere on the sheet.
//
// A RowMap with Row set is different: it applies to exactly that worksheet
// row, whatever sections the sheet has, so labels that repeat across blocks
// can be told apart. Its Label, if any, is only a guard (see Row).
type RowMap struct {
	Sheet string `json:"sheet"`
	// Section scopes a label mapping to the rows below a section header. It
	// is ignored when Row is set.
	Section string `json:"section"`
	// Label is the row's label in the sheet's label column. With Row set it
	// is optional and guards the mapping: when the row's label (trimmed,
	// case-insensitive) differs, the row is skipped with an error finding.
	Label string `json:"label"`
	// Row is an optional 1-based worksheet row number. See the type comment.
	Row    int    `json:"row,omitempty"`
	Metric string `json:"metric"`
	// Subject is the ID of an existing org unit or tracked item.
	Subject string `json:"subject"`
	// Convert names the converter that turns cell text into measures.
	Convert string `json:"convert"`
	// Measures maps each role of the converter to a measure key.
	Measures map[string]string `json:"measures"`
	// PeriodColumns maps a column letter to a period such as "2025-Q1". When
	// set it replaces the sheet's MonthColumns and PeriodColumns for this
	// row entirely: only the listed columns are imported for the row. Use it
	// for a row whose columns are quarters on a sheet whose columns are months.
	PeriodColumns map[string]string `json:"periodColumns,omitempty"`
}

// MethodologyMap says where a sheet keeps methodology text for the metrics of
// one (draft) version.
type MethodologyMap struct {
	Sheet     string `json:"sheet"`
	VersionID string `json:"versionId"`
	// LabelColumn holds the row labels; it defaults to "A".
	LabelColumn string `json:"labelColumn,omitempty"`
	// Rows maps a row label to a metric key.
	Rows map[string]string `json:"rows"`
	// Columns maps a column letter to a field: definition, notes, example,
	// source, link, frequency, green, yellow or red.
	Columns map[string]string `json:"columns"`
}

// Converters.
const (
	ConvertRatio          = "ratio"
	ConvertValue          = "value"
	ConvertMoneyK         = "money_k"
	ConvertUptimePercent  = "uptime_percent"
	ConvertUptimeFraction = "uptime_fraction"
	ConvertScoreOfMax     = "score_of_max"
	ConvertDailyAverage   = "daily_average"
	ConvertMoneyMTriple   = "money_m_triple"
	ConvertPctSlashCount  = "pct_slash_count"
)

// converterRoles lists, per converter, the roles a RowMap must map to measures.
var converterRoles = map[string][]string{
	ConvertRatio:          {"num", "den"},
	ConvertValue:          {"value"},
	ConvertMoneyK:         {"value"},
	ConvertUptimePercent:  {"down", "period"},
	ConvertUptimeFraction: {"down", "period"},
	ConvertScoreOfMax:     {"value", "max"},
	ConvertDailyAverage:   {"sum", "days"},
	ConvertMoneyMTriple:   {"value"},
	ConvertPctSlashCount:  {"value"},
}

// Methodology column fields.
const (
	fieldGreen  = "green"
	fieldYellow = "yellow"
	fieldRed    = "red"
)

// textFields are the methodology fields that map one cell to one text change.
var textFields = map[string]bool{
	changeset.FieldDefinition: true, changeset.FieldNotes: true, changeset.FieldExample: true,
	changeset.FieldSource: true, changeset.FieldLink: true, changeset.FieldFrequency: true,
}

// MaxTemplateBytes bounds the size of a template document.
const MaxTemplateBytes = 1 << 20

// ParseTemplate decodes a template document, rejecting unknown fields and
// trailing data, then validates it. The returned findings are all errors; the
// template is only usable when there are none.
func ParseTemplate(data []byte) (Template, []changeset.Finding, error) {
	var t Template
	if len(data) > MaxTemplateBytes {
		return t, nil, fmt.Errorf("template is larger than %d bytes", MaxTemplateBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return Template{}, nil, fmt.Errorf("template is not valid: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return Template{}, nil, fmt.Errorf("template has data after the JSON document")
	}
	return t, t.Validate(), nil
}

var colRe = regexp.MustCompile(`^[A-Za-z]{1,3}$`)

func validColumn(s string) bool { return colRe.MatchString(s) }

// norm normalizes a label for matching: trimmed, inner whitespace collapsed,
// case-insensitive.
func norm(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(cellNormalizer.Replace(s)), " "))
}

// colNumber converts column letters to a 1-based number (A=1, AA=27).
func colNumber(s string) int {
	n := 0
	for _, c := range strings.ToUpper(s) {
		n = n*26 + int(c-'A') + 1
	}
	return n
}

// Validate checks the template and returns one error finding per problem
// (nil when the template is sound).
func (t Template) Validate() []changeset.Finding {
	var out []changeset.Finding
	bad := func(sheet, format string, a ...any) {
		out = append(out, changeset.Finding{Severity: changeset.SeverityError, Sheet: sheet, Message: "template: " + fmt.Sprintf(format, a...)})
	}

	if len(t.Sheets) == 0 && len(t.Methodology) == 0 {
		bad("", "has no sheets and no methodology; nothing to import")
	}

	sheets := map[string]bool{}
	for _, sm := range t.Sheets {
		name := sm.Sheet
		if strings.TrimSpace(name) == "" {
			bad("", "a sheet entry has no sheet name")
			continue
		}
		if sheets[norm(name)] {
			bad(name, "sheet is listed twice")
		}
		sheets[norm(name)] = true
		out = append(out, validateSheetMap(sm)...)
	}

	type labelKey struct{ sheet, section, label string }
	seen := map[labelKey]bool{}
	type rowKey struct {
		sheet string
		row   int
	}
	seenRows := map[rowKey]bool{}
	headers := map[[2]string]bool{}
	for _, rm := range t.Rows {
		if rm.Metric == "" && rm.Row == 0 {
			headers[[2]string{norm(rm.Sheet), norm(rm.Label)}] = true
		}
	}
	headerIdx := map[[2]string]int{}
	for i, rm := range t.Rows {
		if rm.Metric == "" && rm.Row == 0 {
			headerIdx[[2]string{norm(rm.Sheet), norm(rm.Label)}] = i + 1
		}
	}
	for i, rm := range t.Rows {
		where := fmt.Sprintf("row mapping %d (%q)", i+1, rm.Label)
		if rm.Row != 0 {
			where = fmt.Sprintf("row mapping %d (row %d)", i+1, rm.Row)
		}
		if !sheets[norm(rm.Sheet)] {
			bad(rm.Sheet, "%s names sheet %q, which has no sheet entry", where, rm.Sheet)
			continue
		}
		if rm.Row < 0 {
			bad(rm.Sheet, "%s has row %d; rows are numbered from 1", where, rm.Row)
			continue
		}
		if rm.Row == 0 && norm(rm.Label) == "" {
			bad(rm.Sheet, "row mapping %d has no label (or row number)", i+1)
			continue
		}
		if rm.Row > 0 {
			rk := rowKey{norm(rm.Sheet), rm.Row}
			if seenRows[rk] {
				bad(rm.Sheet, "%s: row %d is listed twice on the sheet", where, rm.Row)
			}
			seenRows[rk] = true
			if rm.Metric == "" {
				bad(rm.Sheet, "%s has no metric; a row number cannot mark a section header", where)
				continue
			}
		} else {
			k := labelKey{norm(rm.Sheet), norm(rm.Section), norm(rm.Label)}
			if seen[k] {
				bad(rm.Sheet, "%s is listed twice in the same section", where)
			}
			seen[k] = true
			if h, clash := headerIdx[[2]string{norm(rm.Sheet), norm(rm.Label)}]; clash && rm.Metric != "" {
				bad(rm.Sheet, "%s has the same label as section header mapping %d (%q), so the row would be read as a section header", where, h, t.Rows[h-1].Label)
			}
			if rm.Section != "" && !headers[[2]string{norm(rm.Sheet), norm(rm.Section)}] {
				bad(rm.Sheet, "%s names section %q, which is not a section header row mapping", where, rm.Section)
			}
		}
		if rm.Metric == "" {
			if rm.Section != "" || rm.Subject != "" || rm.Convert != "" || len(rm.Measures) > 0 || len(rm.PeriodColumns) > 0 {
				bad(rm.Sheet, "%s is a section header (no metric) and must only set sheet and label", where)
			}
			continue
		}
		if sm, ok := sheetByName(t.Sheets, rm.Sheet); ok {
			out = append(out, validateRowPeriodColumns(where, sm, rm)...)
		}
		if rm.Subject == "" {
			bad(rm.Sheet, "%s has no subject", where)
		}
		roles, ok := converterRoles[rm.Convert]
		if !ok {
			bad(rm.Sheet, "%s has unknown convert %q", where, rm.Convert)
			continue
		}
		want := map[string]bool{}
		for _, r := range roles {
			want[r] = true
			if rm.Measures[r] == "" {
				bad(rm.Sheet, "%s: converter %s needs a measure for %q", where, rm.Convert, r)
			}
		}
		keys := map[string]string{}
		for _, r := range sortedKeys(rm.Measures) {
			if !want[r] {
				bad(rm.Sheet, "%s: converter %s has no role %q", where, rm.Convert, r)
				continue
			}
			if prev, dup := keys[rm.Measures[r]]; dup && rm.Measures[r] != "" {
				bad(rm.Sheet, "%s: roles %q and %q use the same measure %q", where, prev, r, rm.Measures[r])
			}
			keys[rm.Measures[r]] = r
		}
	}

	for i, mm := range t.Methodology {
		out = append(out, validateMethodologyMap(i, mm)...)
	}
	return out
}

func sheetByName(sheets []SheetMap, name string) (SheetMap, bool) {
	for _, sm := range sheets {
		if norm(sm.Sheet) == norm(name) {
			return sm, true
		}
	}
	return SheetMap{}, false
}

// validateRowPeriodColumns checks a row's own period columns. Whether a
// period's grain fits the metric's frequency is only known once the metric is
// looked up, so the importer checks that per cell, as for sheet columns.
func validateRowPeriodColumns(where string, sm SheetMap, rm RowMap) []changeset.Finding {
	var out []changeset.Finding
	bad := func(format string, a ...any) {
		out = append(out, changeset.Finding{Severity: changeset.SeverityError, Sheet: rm.Sheet, Message: "template: " + fmt.Sprintf(format, a...)})
	}
	cols := map[string]period.Period{}
	periods := map[period.Period]string{}
	for _, col := range sortedKeys(rm.PeriodColumns) {
		if !validColumn(col) {
			bad("%s has an invalid period column %q", where, col)
			continue
		}
		up := strings.ToUpper(col)
		p, err := period.Parse(rm.PeriodColumns[col])
		if err != nil {
			bad("%s column %s: %v", where, up, err)
			continue
		}
		if _, dup := cols[up]; dup {
			bad("%s lists period column %s twice", where, up)
			continue
		}
		cols[up] = p
		if prev, dup := periods[p]; dup {
			bad("%s: columns %s and %s both map to period %s", where, prev, up, p)
		}
		periods[p] = up
		if strings.EqualFold(up, sm.LabelColumn) {
			bad("%s: period column %s is the label column", where, up)
		}
		if sm.YTDColumn != "" && strings.EqualFold(up, sm.YTDColumn) {
			bad("%s: period column %s is the sheet's ytdColumn", where, up)
		}
	}
	return out
}

func validateSheetMap(sm SheetMap) []changeset.Finding {
	var out []changeset.Finding
	bad := func(format string, a ...any) {
		out = append(out, changeset.Finding{Severity: changeset.SeverityError, Sheet: sm.Sheet, Message: "template: " + fmt.Sprintf(format, a...)})
	}
	if sm.FiscalYear < 1 {
		bad("sheet %q needs a fiscalYear", sm.Sheet)
	}
	if !validColumn(sm.LabelColumn) {
		bad("sheet %q has an invalid labelColumn %q", sm.Sheet, sm.LabelColumn)
	}
	if sm.YTDColumn != "" && !validColumn(sm.YTDColumn) {
		bad("sheet %q has an invalid ytdColumn %q", sm.Sheet, sm.YTDColumn)
	}
	if len(sm.MonthColumns)+len(sm.PeriodColumns) == 0 {
		bad("sheet %q has no monthColumns or periodColumns", sm.Sheet)
	}
	periods := map[period.Period]string{}

	// Resolved columns: an explicit period column replaces a month column.
	resolved := map[string]period.Period{}
	explicit := map[string]bool{}
	for _, col := range sortedKeys(sm.MonthColumns) {
		n := sm.MonthColumns[col]
		if !validColumn(col) {
			bad("sheet %q has an invalid month column %q", sm.Sheet, col)
			continue
		}
		if n < 1 || n > 12 {
			bad("sheet %q column %s: month %d is not 1..12", sm.Sheet, col, n)
			continue
		}
		up := strings.ToUpper(col)
		if _, dup := resolved[up]; dup {
			bad("sheet %q lists month column %s twice", sm.Sheet, up)
		}
		resolved[up] = period.Period{Grain: period.Month, FY: sm.FiscalYear, Index: n}
	}
	for _, col := range sortedKeys(sm.PeriodColumns) {
		if !validColumn(col) {
			bad("sheet %q has an invalid period column %q", sm.Sheet, col)
			continue
		}
		p, err := period.Parse(sm.PeriodColumns[col])
		if err != nil {
			bad("sheet %q column %s: %v", sm.Sheet, col, err)
			continue
		}
		up := strings.ToUpper(col)
		if _, dup := explicit[up]; dup {
			bad("sheet %q lists period column %s twice", sm.Sheet, up)
		}
		explicit[up] = true
		resolved[up] = p
	}
	for _, col := range sortedKeys(resolved) {
		p := resolved[col]
		if prev, dup := periods[p]; dup {
			bad("sheet %q: columns %s and %s both map to period %s", sm.Sheet, prev, col, p)
		}
		periods[p] = col
	}
	if sm.YTDColumn != "" {
		if _, clash := resolved[strings.ToUpper(sm.YTDColumn)]; clash {
			bad("sheet %q: ytdColumn %s is also a period column", sm.Sheet, sm.YTDColumn)
		}
		if strings.EqualFold(sm.YTDColumn, sm.LabelColumn) {
			bad("sheet %q: ytdColumn is the label column", sm.Sheet)
		}
	}
	for col := range resolved {
		if strings.EqualFold(col, sm.LabelColumn) {
			bad("sheet %q: period column %s is the label column", sm.Sheet, col)
		}
	}
	return out
}

func validateMethodologyMap(i int, mm MethodologyMap) []changeset.Finding {
	var out []changeset.Finding
	bad := func(format string, a ...any) {
		out = append(out, changeset.Finding{Severity: changeset.SeverityError, Sheet: mm.Sheet, Message: "template: " + fmt.Sprintf(format, a...)})
	}
	where := fmt.Sprintf("methodology mapping %d", i+1)
	if strings.TrimSpace(mm.Sheet) == "" {
		bad("%s has no sheet name", where)
	}
	if mm.VersionID == "" {
		bad("%s has no versionId", where)
	}
	if mm.LabelColumn != "" && !validColumn(mm.LabelColumn) {
		bad("%s has an invalid labelColumn %q", where, mm.LabelColumn)
	}
	if len(mm.Rows) == 0 {
		bad("%s has no rows", where)
	}
	for _, label := range sortedKeys(mm.Rows) {
		if norm(label) == "" || mm.Rows[label] == "" {
			bad("%s has a row with an empty label or metric", where)
		}
	}
	if len(mm.Columns) == 0 {
		bad("%s has no columns", where)
	}
	fields := map[string]string{}
	for _, col := range sortedKeys(mm.Columns) {
		f := mm.Columns[col]
		if !validColumn(col) {
			bad("%s has an invalid column %q", where, col)
		}
		if !textFields[f] && f != fieldGreen && f != fieldYellow && f != fieldRed {
			bad("%s: column %s has unknown field %q", where, col, f)
			continue
		}
		if prev, dup := fields[f]; dup {
			bad("%s: field %q is mapped from columns %s and %s", where, f, prev, col)
		}
		fields[f] = col
	}
	n := 0
	for _, f := range []string{fieldGreen, fieldYellow, fieldRed} {
		if fields[f] != "" {
			n++
		}
	}
	if n != 0 && n != 3 {
		bad("%s: bands need green, yellow and red columns together", where)
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
