package records

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/xlsx"
)

// Row problem kinds.
const (
	// ProblemError is a row that cannot be turned into a record.
	ProblemError = "error"
	// ProblemUnmappedValue is a value no map covers; the row waits for an answer.
	ProblemUnmappedValue = "unmapped_value"
	// ProblemDuplicateID is an identity that appears on more than one row.
	ProblemDuplicateID = "duplicate_id"
)

// Row is one normalized record from an export, before it is matched to a
// subject or compared with history.
type Row struct {
	RowNum     int
	Source     string
	ExternalID string
	Type       string
	Fields     domain.RecordFields
}

// RowProblem is one thing wrong with one row. RowNum is the row's number in the
// file; it is 0 for a problem with the file's columns as a whole. Column is
// the header it came from, Field the record field or attribute, and Value the
// raw cell.
type RowProblem struct {
	RowNum  int
	Kind    string
	Column  string
	Field   string
	Value   string
	Message string
}

var placeholder = regexp.MustCompile(`\{([^{}]+)\}`)

// Normalize turns each row of tbl into a record using template t for record
// type rt. Rows dropped by skipRows are counted in skipped, not reported. A row
// with an error or unmapped_value problem is left out of rows (an unmapped
// value is left out until it is answered), and both rows of a duplicate ID
// are left out. A missing column behind a required field is a single problem
// on row 0 and no rows. Rows come back in file order.
//
// When subjectKey has a separator, each row fans out to one record per listed
// subject (each listed once, ignoring case), with external ID
// "{key}@{subject as written}" and GroupKey "{key}"; the records share the
// row's number and every other field.
func Normalize(t Template, rt domain.RecordType, tbl Table) (rows []Row, skipped int, problems []RowProblem) {
	loc, ok := t.location()
	if !ok {
		return nil, 0, []RowProblem{{Kind: ProblemError, Field: "timeZone", Value: t.TimeZone,
			Message: fmt.Sprintf("time zone %q is not an IANA name such as UTC or America/New_York", t.TimeZone)}}
	}
	n := &normalizer{t: t, rt: rt, tbl: tbl, cols: map[string]int{}, allowSerial: tbl.Format == "xlsx", loc: loc}
	for i, h := range tbl.Headers {
		h = strings.TrimSpace(h)
		if _, dup := n.cols[h]; !dup && h != "" {
			n.cols[h] = i
		}
	}

	for _, spec := range fieldSpecs {
		fm, ok := t.Fields[spec.name]
		if !spec.required || !ok || fm.Column == "" || fm.Default != "" {
			continue
		}
		if _, found := n.cols[strings.TrimSpace(fm.Column)]; !found {
			problems = append(problems, RowProblem{
				Kind: ProblemError, Column: fm.Column, Field: spec.name,
				Message: fmt.Sprintf("column %q (for %s) is not in the file", fm.Column, spec.name),
			})
		}
	}
	if len(problems) > 0 {
		return nil, 0, problems
	}

	type built struct {
		row      Row
		excluded bool
	}
	var all []built
	for i, cells := range tbl.Rows {
		num := i + 1
		if i < len(tbl.RowNums) {
			num = tbl.RowNums[i]
		}
		if n.skip(cells) {
			skipped++
			continue
		}
		out, probs := n.row(num, cells)
		problems = append(problems, probs...)
		for _, row := range out {
			all = append(all, built{row: row, excluded: len(probs) > 0})
		}
	}

	// Duplicate identities, judged over every kept row that has an ID, so a
	// row that also has other problems still reports its twin.
	byID := map[string][]int{}
	for i, b := range all {
		if b.row.ExternalID != "" {
			byID[b.row.ExternalID] = append(byID[b.row.ExternalID], i)
		}
	}
	dupAt := map[int]bool{}
	for i, b := range all {
		group := byID[b.row.ExternalID]
		if b.row.ExternalID == "" || len(group) < 2 {
			continue
		}
		dupAt[i] = true
		others := make([]string, 0, len(group)-1)
		for _, j := range group {
			if j != i {
				others = append(others, fmt.Sprint(all[j].row.RowNum))
			}
		}
		fm := t.Fields["externalId"]
		problems = append(problems, RowProblem{
			RowNum: b.row.RowNum, Kind: ProblemDuplicateID, Column: fm.Column, Field: "externalId",
			Value:   b.row.ExternalID,
			Message: fmt.Sprintf("%q is also on row %s", b.row.ExternalID, strings.Join(others, ", ")),
		})
	}

	for i, b := range all {
		if !b.excluded && !dupAt[i] {
			rows = append(rows, b.row)
		}
	}
	sortProblems(problems)
	return rows, skipped, problems
}

// sortProblems orders problems by row number (file-level problems first),
// keeping the order within a row. Only the duplicate-ID pass appends out of
// order.
func sortProblems(ps []RowProblem) {
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].RowNum < ps[j].RowNum })
}

type normalizer struct {
	t           Template
	rt          domain.RecordType
	tbl         Table
	cols        map[string]int
	allowSerial bool
	loc         *time.Location
}

// cell returns the trimmed text of the named column in cells, "" when the
// column is not in the file.
func (n *normalizer) cell(cells []string, column string) string {
	i, ok := n.cols[strings.TrimSpace(column)]
	if !ok || i >= len(cells) {
		return ""
	}
	return strings.TrimSpace(cells[i])
}

// sourceMissing reports that fm reads from the file, but none of the columns it
// names are in the file's headers: its column, or every {Column} placeholder of
// its template. Constants never read the file.
func (n *normalizer) sourceMissing(fm FieldMap) bool {
	has := func(column string) bool {
		_, ok := n.cols[strings.TrimSpace(column)]
		return ok
	}
	switch {
	case fm.Column != "":
		return !has(fm.Column)
	case fm.Template != "":
		names := placeholder.FindAllStringSubmatch(fm.Template, -1)
		if len(names) == 0 {
			return false
		}
		for _, m := range names {
			if has(m[1]) {
				return false
			}
		}
		return true
	}
	return false
}

func (n *normalizer) skip(cells []string) bool {
	for _, rule := range n.t.SkipRows {
		v := n.cell(cells, rule.Column)
		for _, in := range rule.In {
			if strings.EqualFold(v, strings.TrimSpace(in)) {
				return true
			}
		}
	}
	return false
}

// raw reads a field's source text: a column cell, the constant, or the
// template with each {Column} replaced by that row's cell. A template whose
// placeholders are all empty renders as empty.
func (n *normalizer) raw(fm FieldMap, cells []string) string {
	switch {
	case fm.Column != "":
		return n.cell(cells, fm.Column)
	case fm.Constant != "":
		return strings.TrimSpace(fm.Constant)
	case fm.Template != "":
		seen := false
		out := placeholder.ReplaceAllStringFunc(fm.Template, func(m string) string {
			v := n.cell(cells, m[1:len(m)-1])
			if v != "" {
				seen = true
			}
			return v
		})
		if !seen && placeholder.MatchString(fm.Template) {
			return ""
		}
		return strings.TrimSpace(out)
	}
	return ""
}

// mapLookup finds raw in m: exact, then ignoring case (keys in sorted order,
// so the answer never depends on map order), then the "*" fallback.
func mapLookup(m map[string]string, raw string) (string, bool) {
	if v, ok := m[raw]; ok {
		return v, true
	}
	for _, k := range sortedKeys(m) {
		if k != "*" && strings.EqualFold(strings.TrimSpace(k), raw) {
			return m[k], true
		}
	}
	v, ok := m["*"]
	return v, ok
}

// rowBuilder collects one row's fields and problems.
type rowBuilder struct {
	n     *normalizer
	num   int
	cells []string
	probs []RowProblem
}

func (b *rowBuilder) problem(kind string, fm FieldMap, field, value, format string, args ...any) {
	b.probs = append(b.probs, RowProblem{
		RowNum: b.num, Kind: kind, Column: fm.Column, Field: field, Value: value,
		Message: fmt.Sprintf(format, args...),
	})
}

// where describes the source of a value for messages.
func where(fm FieldMap) string {
	if fm.Column != "" {
		return fmt.Sprintf(" in column %q", fm.Column)
	}
	return ""
}

// text resolves a field's value to a string: the default when the cell is
// empty, otherwise the cell passed through the map. unmapped reports a value
// that a map is present for but does not cover (and no "*").
func (b *rowBuilder) text(fm FieldMap) (val, rawVal string, unmapped bool) {
	rawVal = b.n.raw(fm, b.cells)
	if rawVal == "" {
		return strings.TrimSpace(fm.Default), "", false
	}
	if fm.Map == nil {
		return rawVal, rawVal, false
	}
	v, ok := mapLookup(fm.Map, rawVal)
	if !ok {
		return "", rawVal, true
	}
	return strings.TrimSpace(v), rawVal, false
}

func (b *rowBuilder) unmapped(fm FieldMap, field, raw string) {
	b.problem(ProblemUnmappedValue, fm, field, raw, "value %q%s has no mapping for %s", raw, where(fm), field)
}

func (n *normalizer) row(num int, cells []string) ([]Row, []RowProblem) {
	b := &rowBuilder{n: n, num: num, cells: cells}
	f := domain.RecordFields{}
	var id string
	var fanOut []subjectPart

	for _, spec := range fieldSpecs {
		fm, ok := n.t.Fields[spec.name]
		if !ok {
			continue
		}
		switch spec.kind {
		case vkText:
			if spec.name == "subjectKey" && fm.Separator != "" {
				fanOut = b.subjects(fm)
				continue
			}
			val, raw, unmapped := b.text(fm)
			switch {
			case unmapped:
				b.unmapped(fm, spec.name, raw)
			case val == "" && spec.required:
				b.requiredProblem(fm, spec.name)
			default:
				b.setText(&f, &id, spec.name, val)
			}
		case vkPriority:
			f.Priority = b.priority(fm)
		case vkState:
			f.State = b.state(fm)
		case vkDate:
			d, set := b.date(fm, spec.name, spec.required)
			if set {
				b.setDate(&f, spec.name, d)
			}
		case vkDateList:
			f.PriorDueDates = b.dateList(fm, spec.name)
		case vkNumber:
			if v, set := b.number(fm, spec.name); set {
				b.setNumber(&f, spec.name, v)
			}
		}
	}

	if f.State == domain.StateDone || f.State == domain.StateCancelled {
		if f.CompletedAt == nil && !b.hasProblemFor("completedAt") {
			fm := n.t.Fields["completedAt"]
			b.problem(ProblemError, fm, "completedAt", "",
				"completedAt is required when the record is %s, but there is no completed date%s", f.State, where(fm))
		}
	}

	if len(n.t.Attributes) > 0 {
		defs := make(map[string]domain.AttributeDef, len(n.rt.Attributes))
		for _, a := range n.rt.Attributes {
			defs[a.Key] = a
		}
		for _, key := range sortedKeys(n.t.Attributes) {
			def, ok := defs[key]
			if !ok {
				continue
			}
			if v, set := b.attribute(n.t.Attributes[key], def); set {
				if f.Attributes == nil {
					f.Attributes = map[string]any{}
				}
				f.Attributes[key] = v
			}
		}
	}
	if isIncidentType(n.rt) {
		b.incidentChecks(f)
	}

	row := Row{RowNum: num, Source: n.t.Source, ExternalID: id, Type: n.t.RecordType, Fields: f}
	if fanOut == nil {
		return []Row{row}, b.probs
	}
	rows := make([]Row, len(fanOut))
	for i, part := range fanOut {
		r := row
		r.Fields.Attributes = maps.Clone(f.Attributes)
		r.Fields.PriorDueDates = slices.Clone(f.PriorDueDates)
		r.Fields.SubjectKey = part.subject
		if id != "" {
			r.ExternalID = id + "@" + part.written
			r.Fields.GroupKey = id
		}
		rows[i] = r
	}
	return rows, b.probs
}

// subjectPart is one subject a fanned-out row lists: as written, and after
// the map.
type subjectPart struct{ written, subject string }

// subjects splits a subjectKey on fm.Separator: each part trimmed, empty ones
// dropped, each listed once ignoring case, and each passed through the map.
// A row that lists none, or a part no map covers, is a problem; the parts
// that read are still returned so a duplicate ID is still reported.
func (b *rowBuilder) subjects(fm FieldMap) []subjectPart {
	rawVal := b.n.raw(fm, b.cells)
	if rawVal == "" {
		rawVal = strings.TrimSpace(fm.Default)
	}
	var out []subjectPart
	seen := map[string]bool{}
	for _, part := range strings.Split(rawVal, fm.Separator) {
		part = strings.TrimSpace(part)
		if part == "" || seen[strings.ToLower(part)] {
			continue
		}
		seen[strings.ToLower(part)] = true
		subject := part
		if fm.Map != nil {
			v, ok := mapLookup(fm.Map, part)
			if !ok {
				b.unmapped(fm, "subjectKey", part)
				continue
			}
			subject = strings.TrimSpace(v)
		}
		if subject == "" {
			b.requiredProblem(fm, "subjectKey")
			continue
		}
		out = append(out, subjectPart{written: part, subject: subject})
	}
	if len(out) == 0 && !b.hasProblemFor("subjectKey") {
		b.requiredProblem(fm, "subjectKey")
	}
	if out == nil {
		return []subjectPart{}
	}
	return out
}

func (b *rowBuilder) hasProblemFor(field string) bool {
	for _, p := range b.probs {
		if p.Field == field {
			return true
		}
	}
	return false
}

func (b *rowBuilder) requiredProblem(fm FieldMap, field string) {
	b.problem(ProblemError, fm, field, "", "%s is required, but the cell%s is empty", field, where(fm))
}

func (b *rowBuilder) setText(f *domain.RecordFields, id *string, name, val string) {
	switch name {
	case "externalId":
		*id = val
	case "subjectKey":
		f.SubjectKey = val
	case "title":
		f.Title = val
	case "category":
		f.Category = val
	case "status":
		f.Status = val
	case "url":
		f.URL = val
	}
}

func (b *rowBuilder) setDate(f *domain.RecordFields, name string, d domain.Date) {
	switch name {
	case "createdAt":
		f.CreatedAt = d
	case "committedAt":
		f.CommittedAt = &d
	case "dueAt":
		f.DueAt = &d
	case "completedAt":
		f.CompletedAt = &d
	case "measuredAt":
		f.MeasuredAt = &d
	}
}

func (b *rowBuilder) setNumber(f *domain.RecordFields, name string, v float64) {
	switch name {
	case "planned":
		f.Planned = &v
	case "actual":
		f.Actual = &v
	case "expectedValue":
		f.ExpectedValue = &v
	case "deliveredValue":
		f.DeliveredValue = &v
	}
}

// priority resolves the priority: through the map when there is one, otherwise
// the value must already be one of the type's priorities (any case). The
// implicit "none" is stored as absent.
func (b *rowBuilder) priority(fm FieldMap) string {
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, "priority", raw)
		return ""
	}
	if val == "" {
		return ""
	}
	allowed := b.n.rt.AllPriorities()
	for _, p := range allowed {
		if strings.EqualFold(p, val) {
			if p == domain.PriorityNone {
				return ""
			}
			return p
		}
	}
	if fm.Map == nil && raw != "" {
		b.unmapped(fm, "priority", raw)
		return ""
	}
	b.problem(ProblemError, fm, "priority", raw, "priority %q%s is not one of %s", val, where(fm), strings.Join(allowed, ", "))
	return ""
}

// state resolves the state like priority: through the map, or the value must
// be open, done, or cancelled.
func (b *rowBuilder) state(fm FieldMap) domain.RecordState {
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, "state", raw)
		return ""
	}
	if val == "" {
		b.requiredProblem(fm, "state")
		return ""
	}
	if s := domain.RecordState(strings.ToLower(val)); s.Valid() {
		return s
	}
	if fm.Map == nil {
		b.unmapped(fm, "state", raw)
		return ""
	}
	b.problem(ProblemError, fm, "state", raw, "state %q%s is not open, done, or cancelled", val, where(fm))
	return ""
}

// date reads a date field; set is false when the cell is empty or unreadable
// (an unreadable date and a missing required one add a problem).
func (b *rowBuilder) date(fm FieldMap, field string, required bool) (domain.Date, bool) {
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, field, raw)
		return domain.Date{}, false
	}
	if val == "" {
		if required {
			b.requiredProblem(fm, field)
		}
		return domain.Date{}, false
	}
	d, err := ParseDate(val, fm.DateFormats, b.n.allowSerial)
	if err != nil {
		b.problem(ProblemError, fm, field, val, "%s%s: %v", field, where(fm), err)
		return domain.Date{}, false
	}
	return d, true
}

// dateList reads priorDueDates: dates separated by fm.Separator (comma when
// empty), oldest first as written.
func (b *rowBuilder) dateList(fm FieldMap, field string) []domain.Date {
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, field, raw)
		return nil
	}
	if val == "" {
		return nil
	}
	sep := fm.Separator
	if sep == "" {
		sep = ","
	}
	var out []domain.Date
	for _, part := range strings.Split(val, sep) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		d, err := ParseDate(part, fm.DateFormats, b.n.allowSerial)
		if err != nil {
			b.problem(ProblemError, fm, field, part, "%s%s: %v", field, where(fm), err)
			return nil
		}
		out = append(out, d)
	}
	return out
}

func isNotApplicable(s string) bool {
	return strings.EqualFold(s, "n/a") || strings.EqualFold(s, "na")
}

// number reads a number field; empty and n/a cells are absent.
func (b *rowBuilder) number(fm FieldMap, field string) (float64, bool) {
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, field, raw)
		return 0, false
	}
	if val == "" || isNotApplicable(val) {
		return 0, false
	}
	v, err := ParseNumber(val)
	if err != nil {
		b.problem(ProblemError, fm, field, val, "%s%s: %v", field, where(fm), err)
		return 0, false
	}
	return v, true
}

// attribute reads one custom attribute as its declared type. set is false when
// the cell is empty (the attribute is then absent) or has a problem.
func (b *rowBuilder) attribute(fm FieldMap, def domain.AttributeDef) (any, bool) {
	key := def.Key
	tr := transformFor(fm, def.Type)
	if tr == TransformNonEmpty {
		// A column the file does not have says nothing about the row, so the
		// attribute is absent rather than false.
		if b.n.sourceMissing(fm) {
			return nil, false
		}
		return b.n.raw(fm, b.cells) != "", true
	}
	val, raw, unmapped := b.text(fm)
	if unmapped {
		b.unmapped(fm, key, raw)
		return nil, false
	}
	if val == "" {
		return nil, false
	}
	switch tr {
	case TransformNumber:
		if isNotApplicable(val) {
			return nil, false
		}
		v, err := ParseNumber(val)
		if err != nil {
			b.problem(ProblemError, fm, key, val, "%s%s: %v", key, where(fm), err)
			return nil, false
		}
		if per, ok := durationUnits[fm.Unit]; ok {
			v = scaled(v, per)
		}
		return v, true
	case TransformBool:
		v, ok := parseBool(val)
		if !ok {
			if fm.Map == nil {
				b.unmapped(fm, key, raw)
			} else {
				b.problem(ProblemError, fm, key, val, "%s%s: %q is not yes or no", key, where(fm), val)
			}
			return nil, false
		}
		return v, true
	case TransformDate:
		d, err := ParseDate(val, fm.DateFormats, b.n.allowSerial)
		if err != nil {
			b.problem(ProblemError, fm, key, val, "%s%s: %v", key, where(fm), err)
			return nil, false
		}
		return d, true
	case TransformDateTime:
		at, err := ParseDateTime(val, fm.DateFormats, b.n.loc, b.n.allowSerial)
		if err != nil {
			b.problem(ProblemError, fm, key, val, "%s%s: %v", key, where(fm), err)
			return nil, false
		}
		return at.UTC().Format(time.RFC3339), true
	}
	return val, true
}

// zonedLayouts are the date-time forms always accepted with an offset.
var zonedLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00"}

// localLayouts are the date-time forms always accepted without an offset;
// they are read in the template's zone. A date alone is not among them.
var localLayouts = []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"}

// ParseDateTime reads an instant from an export cell. It tries formats (Go
// layouts) in order, then RFC 3339 with an offset, then ISO date-times
// without one, then, when allowSerial is set, a spreadsheet serial with a
// time of day. A value with an offset keeps it; one without is read in loc
// (UTC when nil). Only an explicit format may read a date alone, as midnight.
func ParseDateTime(s string, formats []string, loc *time.Location, allowSerial bool) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, fmt.Errorf("date and time is empty")
	}
	if loc == nil {
		loc = time.UTC
	}
	for _, layout := range formats {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}
	for _, layout := range zonedLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	for _, layout := range localLayouts {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, nil
		}
	}
	if allowSerial && serialPattern.MatchString(s) {
		if f, err := strconv.ParseFloat(s, 64); err == nil && f >= minSerialDate && f <= maxSerialDate {
			if t := xlsx.SerialToDate(f); !t.IsZero() {
				return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc), nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("%q is not a date and time I can read", s)
}
