package legacy

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/period"
	"opsvision/internal/store"
	"opsvision/internal/xlsx"
)

// OverrideReason is the reason recorded on overrides created from a workbook.
const OverrideReason = "As reported in legacy workbook"

// ParseWorkbook turns the mapped parts of a legacy workbook into a change set:
// data writes, "as reported" status overrides, methodology text for draft
// versions, legacy notes from cell comments, and findings for everything it
// was not sure about. Nothing is stored; the change set is reviewed and then
// applied with changeset.Apply.
//
// base carries the tenant's calendar, org tree, tracked items, methodology
// versions and existing data and overrides. The caller sets ID, CreatedBy and
// CreatedAt on the result.
//
// Cells are never guessed at: an unreadable or wrong-shaped cell, an unknown
// subject, a measure the methodology in force does not have, a metric whose
// frequency does not fit the column, or two rows writing the same value all
// become findings, and the affected cell is skipped. A recorded G/Y/R status
// that the methodology does not produce from the imported numbers becomes an
// override; a differing number only becomes a warning.
func ParseWorkbook(wb *xlsx.Workbook, t Template, base *engine.Input) changeset.ChangeSet {
	cs := changeset.ChangeSet{
		Source:      changeset.SourceLegacyWorkbook,
		Status:      changeset.StatusParsed,
		Data:        []store.DataWrite{},
		Overrides:   []domain.Override{},
		VersionText: []changeset.VersionTextChange{},
		Notes:       []changeset.LegacyNote{},
		Findings:    []changeset.Finding{},
	}
	if fs := t.Validate(); len(fs) > 0 {
		cs.Findings = append(cs.Findings, fs...)
		return cs
	}
	if base == nil {
		base = &engine.Input{}
	}
	p := &parser{
		wb: wb, t: t, base: base, cs: &cs,
		sheets:   map[string]*xlsx.Sheet{},
		seen:     map[writeKey]string{},
		consumed: map[string]map[string]bool{},
	}
	for i := range wb.Sheets {
		p.sheets[norm(wb.Sheets[i].Name)] = &wb.Sheets[i]
	}
	for _, sm := range t.Sheets {
		p.dataSheet(sm)
	}
	for _, mm := range t.Methodology {
		p.methodology(mm)
	}
	p.compare()
	p.unmappedComments()
	return cs
}

type writeKey struct {
	measure, subject string
	period           period.Period
}

type cellKey struct {
	metric, subject string
	period          period.Period
}

// importedCell is one workbook cell that produced writes.
type importedCell struct {
	sheet, ref string
	version    domain.MethodologyVersion
	metric     domain.Metric
	subject    string
	period     period.Period
	status     string
	reported   *float64
}

// ytdCheck is a year-to-date workbook value to compare with the engine's.
type ytdCheck struct {
	sheet, ref string
	version    domain.MethodologyVersion
	metric     domain.Metric
	subject    string
	through    period.Period
	reported   float64
}

type parser struct {
	wb   *xlsx.Workbook
	t    Template
	base *engine.Input
	cs   *changeset.ChangeSet

	sheets   map[string]*xlsx.Sheet
	seen     map[writeKey]string // first workbook cell that wrote each point
	consumed map[string]map[string]bool

	imported []importedCell
	ytd      []ytdCheck
}

func (p *parser) find(severity, sheet, cell, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if sheet != "" && cell != "" {
		msg = sheet + "!" + cell + ": " + msg
	}
	p.cs.Findings = append(p.cs.Findings, changeset.Finding{Severity: severity, Sheet: sheet, Cell: cell, Message: msg})
}

func (p *parser) sheet(name string) *xlsx.Sheet { return p.sheets[norm(name)] }

// known reports whether id is an org unit or a tracked item.
func (p *parser) known(id string) bool {
	if p.base.Tree != nil {
		if _, ok := p.base.Tree.Unit(id); ok {
			return true
		}
	}
	for _, it := range p.base.Items {
		if it.ID == id {
			return true
		}
	}
	return false
}

// ---- sheets and rows ----------------------------------------------------------------

// colPeriod is a mapped period column.
type colPeriod struct {
	col string // upper-case letters
	p   period.Period
}

// resolveColumns lists the sheet's period columns in column order. Template
// validation has already checked them.
func resolveColumns(sm SheetMap) []colPeriod {
	byCol := map[string]period.Period{}
	for col, n := range sm.MonthColumns {
		byCol[strings.ToUpper(col)] = period.Period{Grain: period.Month, FY: sm.FiscalYear, Index: n}
	}
	for col, text := range sm.PeriodColumns {
		if pp, err := period.Parse(text); err == nil {
			byCol[strings.ToUpper(col)] = pp
		}
	}
	out := make([]colPeriod, 0, len(byCol))
	for col, pp := range byCol {
		out = append(out, colPeriod{col, pp})
	}
	sort.Slice(out, func(i, j int) bool { return colNumber(out[i].col) < colNumber(out[j].col) })
	return out
}

// resolveRowColumns lists a row's own period columns in column order. They
// replace the sheet's columns for that row. Template validation has already
// checked them.
func resolveRowColumns(rm RowMap) []colPeriod {
	out := make([]colPeriod, 0, len(rm.PeriodColumns))
	for col, text := range rm.PeriodColumns {
		if pp, err := period.Parse(text); err == nil {
			out = append(out, colPeriod{strings.ToUpper(col), pp})
		}
	}
	sort.Slice(out, func(i, j int) bool { return colNumber(out[i].col) < colNumber(out[j].col) })
	return out
}

// rowOf returns the row number of a canonical cell reference.
func rowOf(ref string) (int, bool) {
	i := 0
	for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
		i++
	}
	n, err := strconv.Atoi(ref[i:])
	return n, i > 0 && err == nil && n > 0
}

// rowNumbers returns the sheet's non-empty row numbers in ascending order.
func rowNumbers(sh *xlsx.Sheet) []int {
	seen := map[int]bool{}
	for ref := range sh.Cells {
		if n, ok := rowOf(ref); ok {
			seen[n] = true
		}
	}
	rows := make([]int, 0, len(seen))
	for n := range seen {
		rows = append(rows, n)
	}
	sort.Ints(rows)
	return rows
}

func ref(col string, row int) string { return strings.ToUpper(col) + strconv.Itoa(row) }

func (p *parser) dataSheet(sm SheetMap) {
	sh := p.sheet(sm.Sheet)
	if sh == nil {
		p.find(changeset.SeverityError, sm.Sheet, "", "sheet %q not found in the workbook", sm.Sheet)
		return
	}
	cols := resolveColumns(sm)

	var rows []RowMap
	for _, rm := range p.t.Rows {
		if norm(rm.Sheet) == norm(sm.Sheet) {
			rows = append(rows, rm)
		}
	}
	matched := make([]bool, len(rows))

	// Explicit row mappings apply to exactly one worksheet row; label mappings
	// walk the sheet and track sections.
	explicit := map[int]int{}
	for i, rm := range rows {
		if rm.Row > 0 {
			explicit[rm.Row] = i
		}
	}

	section := ""
	for _, r := range rowNumbers(sh) {
		if i, ok := explicit[r]; ok {
			matched[i] = true
			p.explicitRow(sh, sm, rows[i], r, cols)
			continue
		}
		label := norm(sh.Cells[ref(sm.LabelColumn, r)].Text)
		if label == "" {
			continue
		}
		if i := sectionHeader(rows, label); i >= 0 {
			section = label
			matched[i] = true
			continue
		}
		i := matchRow(rows, label, section)
		if i < 0 {
			continue
		}
		matched[i] = true
		p.importRow(sh, sm, rows[i], r, cols)
	}
	for i, rm := range rows {
		if matched[i] {
			continue
		}
		switch {
		case rm.Row > 0:
			p.find(changeset.SeverityWarn, sh.Name, "", "row %d (%q) was not found: the row is empty or past the end of the sheet", rm.Row, rm.Label)
		case rm.Metric == "":
			p.find(changeset.SeverityWarn, sh.Name, "", "section header %q was not found in column %s", rm.Label, strings.ToUpper(sm.LabelColumn))
		case rm.Section != "":
			p.find(changeset.SeverityWarn, sh.Name, "", "row %q under section %q was not found", rm.Label, rm.Section)
		default:
			p.find(changeset.SeverityWarn, sh.Name, "", "row %q was not found in column %s", rm.Label, strings.ToUpper(sm.LabelColumn))
		}
	}
}

// sectionHeader returns the index of the section header row mapping with the
// normalized label, or -1.
func sectionHeader(rows []RowMap, label string) int {
	for i, rm := range rows {
		if rm.Row == 0 && rm.Metric == "" && norm(rm.Label) == label {
			return i
		}
	}
	return -1
}

// matchRow returns the index of the row mapping for a label inside the
// current section: one scoped to that section wins over an unscoped one.
func matchRow(rows []RowMap, label, section string) int {
	for i, rm := range rows {
		if rm.Row == 0 && rm.Metric != "" && rm.Section != "" && section != "" && norm(rm.Section) == section && norm(rm.Label) == label {
			return i
		}
	}
	for i, rm := range rows {
		if rm.Row == 0 && rm.Metric != "" && rm.Section == "" && norm(rm.Label) == label {
			return i
		}
	}
	return -1
}

// rowYTD tracks the latest month a row imported, for its YTD comparison.
type rowYTD struct {
	ok    bool
	fy    int
	month int
	ic    importedCell
}

// explicitRow imports a row selected by number. A label on the mapping is a
// guard: when the sheet's label differs, the row is skipped with an error.
func (p *parser) explicitRow(sh *xlsx.Sheet, sm SheetMap, rm RowMap, r int, cols []colPeriod) {
	if want := strings.TrimSpace(cellNormalizer.Replace(rm.Label)); want != "" {
		cref := ref(sm.LabelColumn, r)
		got := strings.TrimSpace(cellNormalizer.Replace(sh.Cells[cref].Text))
		if norm(got) != norm(want) {
			p.find(changeset.SeverityError, sh.Name, cref, "row %d label is %q, expected %q: row not imported", r, got, want)
			return
		}
	}
	p.importRow(sh, sm, rm, r, cols)
}

func (p *parser) importRow(sh *xlsx.Sheet, sm SheetMap, rm RowMap, r int, cols []colPeriod) {
	if !p.known(rm.Subject) {
		p.find(changeset.SeverityError, sh.Name, ref(sm.LabelColumn, r), "subject %q is not an org unit or tracked item", rm.Subject)
		return
	}
	if len(rm.PeriodColumns) > 0 {
		cols = resolveRowColumns(rm)
	}
	var last rowYTD
	for _, cp := range cols {
		cref := ref(cp.col, r)
		cell, ok := sh.Cells[cref]
		if !ok {
			continue
		}
		ic, ok := p.importCell(sh.Name, rm, cp, cref, cell)
		if !ok {
			continue // notes are kept only for cells that were imported
		}
		p.noteComments(sh, rm, cp.p, cref)
		if cp.p.Grain == period.Month && ic.reported != nil && (cp.p.FY > last.fy || (cp.p.FY == last.fy && cp.p.Index >= last.month)) {
			last = rowYTD{ok: true, fy: cp.p.FY, month: cp.p.Index, ic: ic}
		}
	}
	if sm.YTDColumn == "" || !last.ok {
		return
	}
	p.ytdCell(sh, sm, rm, r, last)
}

// noteComments turns the comments on a mapped cell into legacy notes.
func (p *parser) noteComments(sh *xlsx.Sheet, rm RowMap, per period.Period, cref string) {
	cms := sh.Comments[cref]
	if len(cms) == 0 {
		return
	}
	if p.consumed[sh.Name] == nil {
		p.consumed[sh.Name] = map[string]bool{}
	}
	p.consumed[sh.Name][cref] = true
	for _, c := range cms {
		p.cs.Notes = append(p.cs.Notes, changeset.LegacyNote{
			MetricKey: rm.Metric, SubjectID: rm.Subject, Period: per,
			Author: c.Author, Text: c.Text, At: c.At,
		})
	}
}

// metricOf returns the version in force for per and its metric key.
func (p *parser) metricOf(sheet, cref, key string, per period.Period) (domain.MethodologyVersion, domain.Metric, bool) {
	v, ok := engine.VersionFor(p.base.Versions, per, p.base.Cal)
	if !ok {
		p.find(changeset.SeverityError, sheet, cref, "no published methodology version is in force for %s", per)
		return v, domain.Metric{}, false
	}
	for _, m := range v.Content.Metrics {
		if m.Key == key {
			return v, m, true
		}
	}
	p.find(changeset.SeverityError, sheet, cref, "metric %q is not in methodology version %s (in force for %s)", key, v.ID, per)
	return v, domain.Metric{}, false
}

func frequencyGrain(f domain.Frequency) (period.Grain, bool) {
	switch f {
	case domain.FrequencyMonthly:
		return period.Month, true
	case domain.FrequencyQuarterly:
		return period.Quarter, true
	case domain.FrequencyBiannual:
		return period.Half, true
	case domain.FrequencyAnnual:
		return period.Year, true
	}
	return 0, false
}

func grainName(g period.Grain) string {
	return [...]string{"monthly", "quarterly", "biannual", "annual"}[g]
}

// convert runs the row's converter on a cell, turning the "not applicable"
// kind into an NA result without involving the converter.
func (p *parser) convert(rm RowMap, parsed Parsed, per period.Period) (convOut, error) {
	if parsed.Kind == NotApplicable {
		reason := strings.TrimSpace(parsed.NAReason)
		if reason == "" {
			reason = engine.NotApplicable
		}
		return convOut{na: reason}, nil
	}
	return converters[rm.Convert](convIn{p: parsed, cal: p.base.Cal, per: per})
}

// importCell imports one cell. The bool is true when it produced writes.
func (p *parser) importCell(sheet string, rm RowMap, cp colPeriod, cref string, cell xlsx.Cell) (importedCell, bool) {
	parsed := ParseCell(cell.Text)
	if parsed.Kind == Empty {
		return importedCell{}, false
	}
	ver, m, ok := p.metricOf(sheet, cref, rm.Metric, cp.p)
	if !ok {
		return importedCell{}, false
	}
	grain, ok := frequencyGrain(m.Frequency)
	if !ok || grain != cp.p.Grain {
		p.find(changeset.SeverityError, sheet, cref, "metric %q is %s but this column is for %s (%s): not imported",
			m.Key, m.Frequency, cp.p, grainName(cp.p.Grain))
		return importedCell{}, false
	}
	out, err := p.convert(rm, parsed, cp.p)
	if err != nil {
		p.find(changeset.SeverityWarn, sheet, cref, "cannot import %q with converter %s: %v", strings.TrimSpace(cell.Text), rm.Convert, err)
		return importedCell{}, false
	}

	measures := map[string]bool{}
	for _, ms := range ver.Content.Measures {
		measures[ms.Key] = true
	}
	var writes []store.DataWrite
	problems := 0
	for _, role := range converterRoles[rm.Convert] {
		key := rm.Measures[role]
		if !measures[key] {
			p.find(changeset.SeverityError, sheet, cref, "measure %q is not in methodology version %s (in force for %s)", key, ver.ID, cp.p)
			problems++
			continue
		}
		wk := writeKey{key, rm.Subject, cp.p}
		if first, dup := p.seen[wk]; dup {
			p.find(changeset.SeverityError, sheet, cref, "%s for %s in %s was already written from %s: keeping the first", key, rm.Subject, cp.p, first)
			problems++
			continue
		}
		dp := domain.DataPoint{MeasureKey: key, SubjectID: rm.Subject, Period: cp.p, Source: domain.SourceLegacy}
		if out.na != "" {
			dp.NAReason = out.na
		} else {
			v := out.vals[role]
			dp.Value = &v
		}
		writes = append(writes, store.DataWrite{Point: dp, ExpectedRevision: store.Unconditional})
	}
	if problems > 0 {
		return importedCell{}, false
	}
	loc := sheet + "!" + cref
	for _, w := range writes {
		p.seen[writeKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period}] = loc
		p.cs.Data = append(p.cs.Data, w)
	}
	ic := importedCell{sheet: sheet, ref: cref, version: ver, metric: m, subject: rm.Subject, period: cp.p, status: out.status}
	if out.na == "" {
		ic.reported = out.reported
	}
	p.imported = append(p.imported, ic)
	return ic, true
}

// ytdCell queues the comparison of a row's YTD cell with the computed YTD
// through the latest month the row imported.
func (p *parser) ytdCell(sh *xlsx.Sheet, sm SheetMap, rm RowMap, r int, last rowYTD) {
	yref := ref(sm.YTDColumn, r)
	cell, ok := sh.Cells[yref]
	if !ok {
		return
	}
	parsed := ParseCell(cell.Text)
	if parsed.Kind == Empty || parsed.Kind == NotApplicable {
		return
	}
	through := period.Period{Grain: period.Month, FY: last.fy, Index: last.month}
	out, err := p.convert(rm, parsed, through)
	if err != nil {
		p.find(changeset.SeverityWarn, sh.Name, yref, "cannot read the YTD value %q with converter %s: %v", strings.TrimSpace(cell.Text), rm.Convert, err)
		return
	}
	if out.reported == nil { // a derived value, such as a ratio's percent, is not compared
		return
	}
	p.ytd = append(p.ytd, ytdCheck{sheet: sh.Name, ref: yref, version: last.ic.version, metric: last.ic.metric,
		subject: rm.Subject, through: through, reported: *out.reported})
}

// ---- comparing with the engine ----------------------------------------------------------

// compare builds the engine input as it would be after applying the writes,
// then checks each imported cell against what the methodology computes.
func (p *parser) compare() {
	if len(p.imported) == 0 {
		return
	}
	in := *p.base
	in.Data = make([]domain.DataPoint, 0, len(p.base.Data)+len(p.cs.Data))
	for _, dp := range p.base.Data {
		if _, replaced := p.seen[writeKey{dp.MeasureKey, dp.SubjectID, dp.Period}]; !replaced {
			in.Data = append(in.Data, dp)
		}
	}
	for _, w := range p.cs.Data {
		in.Data = append(in.Data, w.Point)
	}
	cellKeys := map[cellKey]bool{}
	for _, ic := range p.imported {
		cellKeys[cellKey{ic.metric.Key, ic.subject, ic.period}] = true
	}
	existing := map[cellKey]domain.Override{}
	in.Overrides = nil
	for _, o := range p.base.Overrides {
		k := cellKey{o.MetricKey, o.SubjectID, o.Period}
		if cellKeys[k] {
			existing[k] = o // judged without it: the workbook is compared with the methodology
			continue
		}
		in.Overrides = append(in.Overrides, o)
	}
	ix := engine.NewIndex(&in)

	for _, ic := range p.imported {
		c := ix.Cell(ic.version, ic.metric, ic.subject, ic.period)
		k := cellKey{ic.metric.Key, ic.subject, ic.period}
		overridden := false
		if (ic.status == "G" || ic.status == "Y" || ic.status == "R") && c.Status != ic.status {
			p.cs.Overrides = append(p.cs.Overrides, domain.Override{
				MetricKey: ic.metric.Key, SubjectID: ic.subject, Period: ic.period,
				Status: ic.status, Reason: OverrideReason,
			})
			overridden = true
		}
		if ex, ok := existing[k]; ok && !overridden {
			p.find(changeset.SeverityWarn, ic.sheet, ic.ref,
				"an existing override (status %q, reason %q) stays in place for %s %s %s", ex.Status, ex.Reason, ic.metric.Key, ic.subject, ic.period)
		}
		if ic.reported != nil {
			p.compareValue(ic.sheet, ic.ref, ic.metric.Format, *ic.reported, c.Value, "")
		}
	}
	for _, y := range p.ytd {
		c := ix.CellYTD(y.version, y.metric, y.subject, y.through)
		p.compareValue(y.sheet, y.ref, y.metric.Format, y.reported, c.Value, "YTD ")
	}
}

// compareValue warns when the workbook's number and the computed number differ
// once both are rounded the way the metric is displayed.
func (p *parser) compareValue(sheet, cref, format string, reported float64, computed *float64, what string) {
	if computed == nil {
		p.find(changeset.SeverityWarn, sheet, cref, "workbook shows %s%s but the methodology computes no value",
			what, engine.Format(format, reported))
		return
	}
	if engine.Format(format, reported) != engine.Format(format, *computed) {
		p.find(changeset.SeverityWarn, sheet, cref, "workbook %sshows %s but the methodology computes %s",
			what, engine.Format(format, reported), engine.Format(format, *computed))
	}
}

// unmappedComments counts, per sheet, the comments that were not imported.
func (p *parser) unmappedComments() {
	for _, sh := range p.wb.Sheets {
		n := 0
		for cref, cms := range sh.Comments {
			if !p.consumed[sh.Name][cref] {
				n += len(cms)
			}
		}
		if n > 0 {
			p.find(changeset.SeverityInfo, sh.Name, "", "%d comment(s) not on an imported data cell were not imported", n)
		}
	}
}
