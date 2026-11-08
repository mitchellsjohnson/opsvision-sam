package records

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"opsvision/internal/domain"
)

// ColumnGuess is OpsVision's guess that one column holds one record field.
// Confidence runs from 0 to 1: 0.95 for a header that is a known synonym, 0.75
// for one that ends in a synonym ("Epic key") or an ID-shaped column, lower for
// guesses from content alone. Samples are up to three distinct non-empty values
// from the file, so the user can see why.
type ColumnGuess struct {
	Field      string
	Column     string
	Confidence float64
	Samples    []string
}

// ValueCount is one distinct raw value in a column, the number of rows that
// carry it, and the suggested meaning ("P1", "done", or empty for no
// suggestion). The empty Value is the blank cells.
type ValueCount struct {
	Value     string
	Count     int
	Suggested string
}

// SavedTemplate is a template the tenant already saved. The caller builds it
// from the stored row (ID, Revision, LastUsed, and the parsed body).
type SavedTemplate struct {
	ID       string
	Revision int
	LastUsed *time.Time
	T        Template
}

// Inspection is everything the guided setup shows about a dropped file.
//
//   - Guesses holds one entry per guessed field, in field order; "state" is
//     guessed from the same column as "status".
//   - Values lists the distinct values of the priority and state columns, and
//     of the subjectKey column (counts only, no suggestions), keyed by field.
//   - DateFormats lists the Go layouts that read each guessed date column,
//     keyed by header; AmbiguousDates names the columns where day-first and
//     month-first both fit every value (both layouts are listed, month first).
//   - Draft is a complete template built from the guesses, or, when the file
//     was recognized, a copy of the saved template, so a preview can run at once.
//   - MatchedTemplateID is the saved template this file looks like. Added are
//     the file's columns that template does not use; Missing are the columns it
//     uses that the file lacks (all optional ones, or the file is not a match).
type Inspection struct {
	Headers           []string
	RowCount          int
	Samples           [][]string
	SuggestedType     string
	Guesses           []ColumnGuess
	Values            map[string][]ValueCount
	DateFormats       map[string][]string
	AmbiguousDates    []string
	Draft             Template
	MatchedTemplateID string
	Added, Missing    []string
}

// Confidence levels.
const (
	confSynonym   = 0.95 // header is a known synonym
	confSuffix    = 0.75 // header ends with a synonym
	confKeyShaped = 0.75 // unique, ID-shaped values (CHK-101)
	confUnique    = 0.6  // unique values without spaces
	confDateFull  = 0.6  // a date column filled on nearly every row
	confDateSpars = 0.5  // a date column left blank on many rows
	confWeak      = 0.5  // header says date, values do not look like dates
	confUniqueTxt = 0.4  // unique text with spaces
)

const (
	// dateShare is the share of values that must read as dates (or, for fill,
	// the share of rows that must have a value) for a column to count.
	dateShare = 0.9
	// maxDistinct caps the distinct values kept per column, so a 200,000-row
	// ID column cannot cost much memory. Counts for columns with fewer
	// distinct values are exact.
	maxDistinct = 10_000
	// dateSampleSize is how many distinct values the date-like test reads.
	dateSampleSize = 200
	// layoutSampleSize is how many distinct values layout detection reads.
	layoutSampleSize = 2000
	// sampleRows is how many rows Inspection.Samples holds.
	sampleRows = 5
)

type fieldSynonyms struct {
	field string
	syns  []string
}

// synonymTable is the header synonyms, in the order fields claim columns; a
// field prefers an earlier synonym over a later one. Synonyms are written in
// normalized form (lowercase words).
var synonymTable = []fieldSynonyms{
	{"externalId", []string{"issue key", "key", "id", "issue id", "ticket"}},
	{"title", []string{"summary", "title", "name"}},
	{"subjectKey", []string{"product", "component", "components", "team", "project", "application"}},
	{"category", []string{"issue type", "type", "category"}},
	{"priority", []string{"priority", "severity"}},
	{"status", []string{"status"}},
	{"createdAt", []string{"created", "created date", "opened", "submitted"}},
	{"completedAt", []string{"resolved", "resolution date", "done date", "closed", "completed"}},
	{"dueAt", []string{"due date", "due", "target date", "end date"}},
	{"committedAt", []string{"committed", "commit date", "planned start"}},
	{"url", []string{"url", "link"}},
}

var dateFields = map[string]bool{"createdAt": true, "completedAt": true, "dueAt": true, "committedAt": true}

// Inspect looks at a dropped file and returns what the guided setup needs: a
// guess for each column, suggested meanings for priority and status values,
// date formats, the record type it probably is, and the saved template it
// matches, if any. types are the tenant's record types, in a stable order (the
// first matching type is suggested). It never fails; weak guesses carry a low
// confidence and missing ones are simply absent.
func Inspect(tbl Table, types []domain.RecordType, saved []SavedTemplate) Inspection {
	ins := &inspector{tbl: tbl, allowSerial: tbl.Format == "xlsx", cols: map[int]*colInfo{}}
	in := Inspection{
		Headers:     tbl.Headers,
		RowCount:    len(tbl.Rows),
		Values:      map[string][]ValueCount{},
		DateFormats: map[string][]string{},
	}
	for i := 0; i < len(tbl.Rows) && i < sampleRows; i++ {
		in.Samples = append(in.Samples, append([]string(nil), tbl.Rows[i]...))
	}

	byField := ins.guess()
	for _, spec := range fieldSpecs {
		if g, ok := byField[spec.name]; ok {
			in.Guesses = append(in.Guesses, g)
		}
	}

	// Date columns: the layouts that read them, and which are ambiguous.
	layoutsFor := map[string][]string{} // header -> layouts, before choosing among ambiguous ones
	for _, g := range in.Guesses {
		if !dateFields[g.Field] {
			continue
		}
		if _, done := layoutsFor[g.Column]; done {
			continue
		}
		layouts, ambiguous := ins.dateLayouts(ins.index[g.Column])
		layoutsFor[g.Column] = layouts
		if len(layouts) > 0 {
			in.DateFormats[g.Column] = layouts
		}
		if ambiguous {
			in.AmbiguousDates = append(in.AmbiguousDates, g.Column)
		}
	}
	sort.Slice(in.AmbiguousDates, func(i, j int) bool { return ins.index[in.AmbiguousDates[i]] < ins.index[in.AmbiguousDates[j]] })

	match, added, missing := recognize(tbl.Headers, saved)
	if match != nil {
		in.MatchedTemplateID = match.ID
		in.Added, in.Missing = added, missing
	}

	switch {
	case match != nil && match.T.RecordType != "":
		in.SuggestedType = match.T.RecordType
	default:
		in.SuggestedType = suggestType(byField, types)
	}
	var rt *domain.RecordType
	for i := range types {
		if types[i].ID == in.SuggestedType && in.SuggestedType != "" {
			rt = &types[i]
			break
		}
	}
	// Priorities are offered from the suggested type; when none is suggested but
	// the caller passed exactly one type (the one the user chose), from that.
	pt := rt
	if pt == nil && len(types) == 1 {
		pt = &types[0]
	}
	var allowed []string
	if pt != nil {
		allowed = pt.AllPriorities()
	}

	if g, ok := byField["priority"]; ok {
		in.Values["priority"] = ins.valueCounts(ins.index[g.Column], true, func(v string) string { return suggestPriority(v, allowed) })
	}
	if g, ok := byField["state"]; ok {
		in.Values["state"] = ins.valueCounts(ins.index[g.Column], true, suggestState)
	}
	if g, ok := byField["subjectKey"]; ok {
		in.Values["subjectKey"] = ins.valueCounts(ins.index[g.Column], false, func(string) string { return "" })
	}

	if match != nil {
		in.Draft = cloneTemplate(match.T)
	} else {
		in.Draft = draftTemplate(tbl, rt, in)
	}
	return in
}

// inspector holds the lazily computed per-column statistics for one file.
type inspector struct {
	tbl         Table
	allowSerial bool
	index       map[string]int // trimmed header -> first column with it
	cols        map[int]*colInfo
}

// colInfo is what is known about one column's cells.
type colInfo struct {
	counts   map[string]int // distinct non-empty value -> rows
	order    []string       // distinct values in first-seen order
	nonEmpty int
	empty    int
	dup      bool // some value appears twice
	dateLike *bool
}

func (ins *inspector) info(col int) *colInfo {
	if ci, ok := ins.cols[col]; ok {
		return ci
	}
	ci := &colInfo{counts: map[string]int{}}
	for _, row := range ins.tbl.Rows {
		v := ""
		if col < len(row) {
			v = strings.TrimSpace(row[col])
		}
		if v == "" {
			ci.empty++
			continue
		}
		ci.nonEmpty++
		if _, seen := ci.counts[v]; seen {
			ci.counts[v]++
			ci.dup = true
		} else if len(ci.order) < maxDistinct {
			ci.counts[v] = 1
			ci.order = append(ci.order, v)
		}
	}
	ins.cols[col] = ci
	return ci
}

func (ci *colInfo) samples() []string {
	n := min(3, len(ci.order))
	return append([]string(nil), ci.order[:n]...)
}

// fill is the share of rows with a value.
func (ci *colInfo) fill() float64 {
	if total := ci.nonEmpty + ci.empty; total > 0 {
		return float64(ci.nonEmpty) / float64(total)
	}
	return 0
}

// isDateLike reports whether at least 90% of a sample of the column's
// distinct values read as dates. It stops at the first sign it will not.
func (ins *inspector) isDateLike(col int) bool {
	ci := ins.info(col)
	if ci.dateLike != nil {
		return *ci.dateLike
	}
	vals := ci.order[:min(len(ci.order), dateSampleSize)]
	allowedBad := int(float64(len(vals)) * (1 - dateShare))
	bad, like := 0, len(vals) > 0
	for _, v := range vals {
		if !ins.isDateValue(v) {
			bad++
			if bad > allowedBad {
				like = false
				break
			}
		}
	}
	ci.dateLike = &like
	return like
}

// Spreadsheet serials read as dates in a column only when they fall in
// 1990..2100; a smaller or larger number is more likely money or a count.
const (
	minGuessSerial = 32874
	maxGuessSerial = 73415
)

func (ins *inspector) isDateValue(v string) bool {
	if serialPattern.MatchString(v) {
		if !ins.allowSerial {
			return false
		}
		f, err := strconv.ParseFloat(v, 64)
		return err == nil && f >= minGuessSerial && f <= maxGuessSerial
	}
	_, err := ParseDate(v, guessLayouts, false)
	return err == nil
}

// guess assigns fields to columns: by exact header synonym, then by header
// ending in a synonym, then by content. A column belongs to one field; state
// shares status's column.
func (ins *inspector) guess() map[string]ColumnGuess {
	ins.index = map[string]int{}
	var addressable []int // columns that can be named: non-blank, first with their header
	for i, h := range ins.tbl.Headers {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if _, dup := ins.index[h]; dup {
			continue
		}
		ins.index[h] = i
		addressable = append(addressable, i)
	}
	header := func(i int) string { return strings.TrimSpace(ins.tbl.Headers[i]) }

	claimed := map[int]bool{}
	got := map[string]ColumnGuess{}
	assign := func(field string, col int, conf float64) {
		claimed[col] = true
		got[field] = ColumnGuess{Field: field, Column: header(col), Confidence: conf, Samples: ins.info(col).samples()}
	}

	norm := make([]string, len(ins.tbl.Headers))
	for _, i := range addressable {
		norm[i] = normHeader(header(i))
	}

	// Exact synonyms, then "<synonym> name" for products and teams
	// ("Product name", "Team name").
	exact := func(field string, syns []string, suffix string) {
		for _, syn := range syns {
			if _, done := got[field]; done {
				break
			}
			for _, i := range addressable {
				if !claimed[i] && norm[i] == syn+suffix {
					assign(field, i, confSynonym)
					break
				}
			}
		}
	}
	for _, fs := range synonymTable {
		exact(fs.field, fs.syns, "")
		if fs.field == "subjectKey" {
			exact(fs.field, fs.syns, " name")
		}
	}

	// Headers that end in a synonym ("Epic key"), unless they also contain
	// another field's synonym ("Product name" is not a title).
	for _, fs := range synonymTable {
		for _, syn := range fs.syns {
			if _, done := got[fs.field]; done {
				break
			}
			for _, i := range addressable {
				if claimed[i] || !strings.HasSuffix(norm[i], " "+syn) || containsOtherSynonym(norm[i], fs.field) {
					continue
				}
				if fs.field == "externalId" && ins.info(i).dup {
					continue // "Customer ticket" repeats; an ID does not
				}
				assign(fs.field, i, confSuffix)
				break
			}
		}
	}

	// Content: a column of unique, non-date values is the ID.
	if _, ok := got["externalId"]; !ok {
		bestCol, bestConf := -1, 0.0
		for _, i := range addressable {
			if claimed[i] {
				continue
			}
			ci := ins.info(i)
			if ci.nonEmpty < 2 || ci.dup || ci.fill() < dateShare || ins.isDateLike(i) {
				continue
			}
			if conf := uniqueConfidence(ci); conf > bestConf {
				bestCol, bestConf = i, conf
			}
		}
		if bestCol >= 0 {
			assign("externalId", bestCol, bestConf)
		}
	}
	// Content: the fullest date column is the created date; a date column left
	// blank on many rows is the completed date.
	if _, ok := got["createdAt"]; !ok {
		bestCol, bestFill := -1, 0.0
		for _, i := range addressable {
			if claimed[i] || !ins.isDateLike(i) {
				continue
			}
			if f := ins.info(i).fill(); f >= dateShare && f > bestFill {
				bestCol, bestFill = i, f
			}
		}
		if bestCol >= 0 {
			assign("createdAt", bestCol, confDateFull)
		}
	}
	if _, ok := got["completedAt"]; !ok {
		for _, i := range addressable {
			if claimed[i] || !ins.isDateLike(i) || ins.info(i).fill() >= dateShare {
				continue
			}
			assign("completedAt", i, confDateSpars)
			break
		}
	}

	// A date header over values that are not dates is a weak guess.
	for field, g := range got {
		if !dateFields[field] {
			continue
		}
		col := ins.index[g.Column]
		if ins.info(col).nonEmpty > 0 && !ins.isDateLike(col) && g.Confidence > confWeak {
			g.Confidence = confWeak
			got[field] = g
		}
	}

	// The status column is also the state column.
	if g, ok := got["status"]; ok {
		g.Field = "state"
		g.Samples = append([]string(nil), g.Samples...)
		got["state"] = g
	}
	return got
}

// pluralMark is a "/s" plural marker, as in "Component/s".
var pluralMark = regexp.MustCompile(`(?i)([a-z])/s\b`)

// normHeader is a header as lowercase words, with "x/s" read as "x".
func normHeader(h string) string {
	return strings.Join(words(pluralMark.ReplaceAllString(h, "$1")), " ")
}

// containsOtherSynonym reports whether the normalized header contains, as whole
// words, a synonym of a field other than field.
func containsOtherSynonym(norm, field string) bool {
	padded := " " + norm + " "
	for _, fs := range synonymTable {
		if fs.field == field {
			continue
		}
		for _, syn := range fs.syns {
			if strings.Contains(padded, " "+syn+" ") {
				return true
			}
		}
	}
	return false
}

var keyShape = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*-\d+(-\d+)*$`)

// uniqueConfidence rates a column of unique values as an ID: key-shaped values
// (CHK-101) best, other values without spaces next, text with spaces last.
func uniqueConfidence(ci *colInfo) float64 {
	keyed, spaced := true, false
	for _, v := range ci.order {
		if !keyShape.MatchString(v) {
			keyed = false
		}
		if strings.ContainsFunc(v, unicode.IsSpace) {
			spaced = true
		}
	}
	switch {
	case keyed:
		return confKeyShaped
	case !spaced:
		return confUnique
	}
	return confUniqueTxt
}

// suggestType picks a record type from the guessed fields: a priority and a
// completed date suggest a type that has priorities (defects); a due date
// suggests one without (work units). The first matching type wins.
func suggestType(guesses map[string]ColumnGuess, types []domain.RecordType) string {
	_, hasPriority := guesses["priority"]
	_, hasCompleted := guesses["completedAt"]
	_, hasDue := guesses["dueAt"]
	var wantPriorities bool
	switch {
	case hasPriority && hasCompleted:
		wantPriorities = true
	case hasDue:
		wantPriorities = false
	default:
		return ""
	}
	for _, rt := range types {
		if (len(rt.Priorities) > 0) == wantPriorities {
			return rt.ID
		}
	}
	return ""
}

// valueCounts lists the column's distinct values with row counts, biggest
// first (ties by value), blank cells last when withBlank is set.
func (ins *inspector) valueCounts(col int, withBlank bool, suggest func(string) string) []ValueCount {
	ci := ins.info(col)
	out := make([]ValueCount, 0, len(ci.order)+1)
	for _, v := range ci.order {
		out = append(out, ValueCount{Value: v, Count: ci.counts[v], Suggested: suggest(v)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if withBlank && ci.empty > 0 {
		out = append(out, ValueCount{Value: "", Count: ci.empty, Suggested: suggest("")})
	}
	return out
}

// normValue lowercases a cell for keyword lookup: apostrophes are dropped
// (Won't, Won’t, Wont) and other punctuation becomes a space.
func normValue(s string) string {
	s = strings.NewReplacer("'", "", "\u2019", "", "\u2018", "", "`", "").Replace(s)
	return strings.Join(words(s), " ")
}

var priorityKeywords = map[string]string{
	"highest": "P1", "critical": "P1", "blocker": "P1", "p1": "P1", "urgent": "P1",
	"high": "P2", "major": "P2", "p2": "P2",
	"medium": "P3", "normal": "P3", "p3": "P3",
	"low": "P4", "minor": "P4", "p4": "P4",
	"lowest": domain.PriorityNone, "trivial": domain.PriorityNone, "none": domain.PriorityNone,
}

// suggestPriority maps a raw priority to one of allowed (the record type's
// priorities and none; nil means no type is known, so any). A value that is
// already one of the type's priorities maps to itself; blank means none. It
// returns "" when it has no suggestion.
func suggestPriority(raw string, allowed []string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return domain.PriorityNone
	}
	for _, p := range allowed {
		if strings.EqualFold(p, v) {
			return p
		}
	}
	target, ok := priorityKeywords[normValue(v)]
	if !ok {
		return ""
	}
	if allowed != nil && !contains(allowed, target) {
		return ""
	}
	return target
}

var (
	doneKeywords      = keywordSet("done", "closed", "resolved", "complete", "completed", "released")
	cancelledKeywords = keywordSet("won't do", "wont do", "cancelled", "canceled", "duplicate", "rejected", "obsolete")
)

func keywordSet(ks ...string) map[string]bool {
	m := map[string]bool{}
	for _, k := range ks {
		m[normValue(k)] = true
	}
	return m
}

// suggestState maps a raw status to a record state: finished words are done,
// abandoned ones cancelled, anything else (and blank) open.
func suggestState(raw string) string {
	v := normValue(raw)
	switch {
	case doneKeywords[v]:
		return string(domain.StateDone)
	case cancelledKeywords[v]:
		return string(domain.StateCancelled)
	}
	return string(domain.StateOpen)
}

// guessLayouts are the date layouts tried on a column: date part times time
// part. Padded forms come before unpadded ones and month-first before
// day-first, so a tie picks the stricter, more common reading.
var guessLayouts = buildLayouts()

func buildLayouts() []string {
	dates := []string{
		"2006-01-02", "2006/01/02",
		"01/02/2006", "02/01/2006", "1/2/2006", "2/1/2006",
		"02/Jan/06", "2/Jan/06", "02/Jan/2006", "2/Jan/2006",
		"02-Jan-06", "2-Jan-06", "02-Jan-2006", "2-Jan-2006",
		"02 Jan 2006", "2 Jan 2006",
		"Jan 02, 2006", "Jan 2, 2006", "January 02, 2006", "January 2, 2006",
		"02.01.2006", "2.1.2006",
	}
	times := []string{"", " 15:04", " 15:04:05", " 3:04 PM", " 3:04:05 PM"}
	out := make([]string, 0, len(dates)*len(times))
	for _, d := range dates {
		for _, t := range times {
			out = append(out, d+t)
		}
	}
	return out
}

// slashDate matches numeric slash dates with a four-digit year, and an
// optional time.
var slashDate = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/\d{4}(?: \d{1,2}:\d{2}(?::\d{2})?(?: ?[AaPp][Mm])?)?$`)

// Month-first and day-first spellings of the numeric slash layouts.
var slashPairs = [][2]string{{"01/02/2006", "02/01/2006"}, {"1/2/2006", "2/1/2006"}}

// dateLayouts returns the Go layouts that read the column's values: the
// fewest, chosen greedily by how many rows each covers, ties to the earlier
// layout. Values the lenient parser reads on its own (ISO forms, month-only,
// serials) need none. ambiguous is set when every value is a numeric slash date
// whose two parts are both 12 or less, so day-first and month-first both fit;
// the layouts are then month-first and its day-first twin.
func (ins *inspector) dateLayouts(col int) (layouts []string, ambiguous bool) {
	ci := ins.info(col)
	vals := ci.order[:min(len(ci.order), layoutSampleSize)]
	if len(vals) == 0 {
		return nil, false
	}

	cover := make([][]int, len(guessLayouts)) // layout -> indexes of values it reads
	for li, layout := range guessLayouts {
		for vi, v := range vals {
			if _, err := time.Parse(layout, v); err == nil {
				cover[li] = append(cover[li], vi)
			}
		}
	}
	uncovered := make([]bool, len(vals))
	for i := range uncovered {
		uncovered[i] = true
	}
	for {
		best, bestWeight := -1, 0
		for li := range guessLayouts {
			w := 0
			for _, vi := range cover[li] {
				if uncovered[vi] {
					w += ci.counts[vals[vi]]
				}
			}
			if w > bestWeight {
				best, bestWeight = li, w
			}
		}
		if best < 0 {
			break
		}
		layouts = append(layouts, guessLayouts[best])
		for _, vi := range cover[best] {
			uncovered[vi] = false
		}
	}
	if len(layouts) == 0 {
		return nil, false
	}

	ambiguous = true
	for _, v := range vals {
		m := slashDate.FindStringSubmatch(v)
		if m == nil {
			ambiguous = false
			break
		}
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		if a < 1 || a > 12 || b < 1 || b > 12 {
			ambiguous = false
			break
		}
	}
	if ambiguous {
		first := layouts[0]
		for _, p := range slashPairs {
			switch {
			case strings.HasPrefix(first, p[0]):
				return []string{first, p[1] + first[len(p[0]):]}, true
			case strings.HasPrefix(first, p[1]):
				return []string{p[0] + first[len(p[1]):], first}, true
			}
		}
		ambiguous = false
	}
	return layouts, ambiguous
}

// draftTemplate builds a template from the guesses: columns for every guessed
// field, date layouts, priority and state maps from the suggestions. rt is the
// suggested type, or nil.
func draftTemplate(tbl Table, rt *domain.RecordType, in Inspection) Template {
	t := Template{
		Name:   "Tracker export",
		Source: "tracker",
		File:   FileSpec{Format: tbl.Format, HeaderRow: 1},
		Fields: map[string]FieldMap{},
	}
	if t.File.Format == "" {
		t.File.Format = "csv"
	}
	if rt != nil {
		t.RecordType = rt.ID
		t.Name = rt.Name + " export"
	}
	for _, g := range in.Guesses {
		fm := FieldMap{Column: g.Column}
		switch {
		case dateFields[g.Field]:
			if layouts := in.DateFormats[g.Column]; len(layouts) > 0 {
				if contains(in.AmbiguousDates, g.Column) {
					layouts = layouts[:1] // commit to month first until the user answers
				}
				fm.DateFormats = append([]string(nil), layouts...)
			}
		case g.Field == "priority":
			fm.Default = domain.PriorityNone
			for _, vc := range in.Values["priority"] {
				if vc.Value != "" && vc.Suggested != "" {
					if fm.Map == nil {
						fm.Map = map[string]string{}
					}
					fm.Map[vc.Value] = vc.Suggested
				}
			}
		case g.Field == "state":
			fm.Map = map[string]string{"*": string(domain.StateOpen)}
			for _, vc := range in.Values["state"] {
				if vc.Value == "" {
					fm.Default = string(domain.StateOpen)
					continue
				}
				fm.Map[vc.Value] = vc.Suggested
			}
		}
		t.Fields[g.Field] = fm
	}
	return t
}

func cloneTemplate(t Template) Template {
	out := t
	out.Fields = cloneFields(t.Fields)
	out.Attributes = cloneFields(t.Attributes)
	out.SkipRows = nil
	for _, r := range t.SkipRows {
		out.SkipRows = append(out.SkipRows, SkipRule{Column: r.Column, In: append([]string(nil), r.In...)})
	}
	return out
}

func cloneFields(in map[string]FieldMap) map[string]FieldMap {
	if in == nil {
		return nil
	}
	out := make(map[string]FieldMap, len(in))
	for k, fm := range in {
		if fm.Map != nil {
			m := make(map[string]string, len(fm.Map))
			for mk, mv := range fm.Map {
				m[mk] = mv
			}
			fm.Map = m
		}
		fm.DateFormats = append([]string(nil), fm.DateFormats...)
		if len(fm.DateFormats) == 0 {
			fm.DateFormats = nil
		}
		out[k] = fm
	}
	return out
}

// templateColumns lists the file columns a template reads, trimmed and without
// repeats: fields in field order, then other fields and attributes by name,
// then skip rules. required are the columns of required fields that have no
// default; Normalize cannot run without them.
func templateColumns(t Template) (all []string, required map[string]bool) {
	required = map[string]bool{}
	seen := map[string]bool{}
	add := func(c string) {
		if c = strings.TrimSpace(c); c != "" && !seen[c] {
			seen[c] = true
			all = append(all, c)
		}
	}
	addMap := func(fm FieldMap) {
		add(fm.Column)
		for _, m := range placeholder.FindAllStringSubmatch(fm.Template, -1) {
			add(m[1])
		}
	}
	known := map[string]bool{}
	for _, spec := range fieldSpecs {
		known[spec.name] = true
		fm, ok := t.Fields[spec.name]
		if !ok {
			continue
		}
		addMap(fm)
		if spec.required && strings.TrimSpace(fm.Column) != "" && fm.Default == "" {
			required[strings.TrimSpace(fm.Column)] = true
		}
	}
	for _, name := range sortedKeys(t.Fields) {
		if !known[name] {
			addMap(t.Fields[name])
		}
	}
	for _, name := range sortedKeys(t.Attributes) {
		addMap(t.Attributes[name])
	}
	for _, r := range t.SkipRows {
		add(r.Column)
	}
	return all, required
}

// ColumnChanges compares template t with a file's headers (trimmed, as
// Normalize reads them): added are the file's columns t does not use, in file
// order, and missing the columns t uses that the file lacks, in template
// order. It is the comparison Inspect reports for a recognized template.
func ColumnChanges(t Template, headers []string) (added, missing []string) {
	cols, _ := templateColumns(t)
	present, used := map[string]bool{}, map[string]bool{}
	for _, c := range cols {
		used[c] = true
	}
	for _, h := range headers {
		if h = strings.TrimSpace(h); h != "" && !present[h] {
			present[h] = true
			if !used[h] {
				added = append(added, h)
			}
		}
	}
	for _, c := range cols {
		if !present[c] {
			missing = append(missing, c)
		}
	}
	return added, missing
}

// SuggestValue suggests the meaning of a raw value no map covers: a priority
// of rt (or none) for "priority", a state for "state", and "" otherwise or when
// there is no suggestion.
func SuggestValue(field, raw string, rt domain.RecordType) string {
	switch field {
	case "priority":
		return suggestPriority(raw, rt.AllPriorities())
	case "state":
		return suggestState(raw)
	}
	return ""
}

// recognize finds the saved template this file's headers fit: every column of
// its required fields is in the file (headers compared exactly, after
// trimming, as Normalize reads them). The one that reads the most columns of
// the file wins; ties go to fewer missing columns, then the more recently
// used, then the lower ID. added are the file's columns the template does not
// use and missing the columns it uses that the file lacks.
func recognize(headers []string, saved []SavedTemplate) (best *SavedTemplate, added, missing []string) {
	present := map[string]bool{}
	var fileCols []string
	for _, h := range headers {
		if h = strings.TrimSpace(h); h != "" && !present[h] {
			present[h] = true
			fileCols = append(fileCols, h)
		}
	}

	type cand struct {
		st             *SavedTemplate
		used, missing  []string
		usedN, missedN int
	}
	var winner *cand
	for i := range saved {
		st := &saved[i]
		cols, required := templateColumns(st.T)
		if len(cols) == 0 {
			continue
		}
		ok := true
		for c := range required {
			if !present[c] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		c := &cand{st: st}
		for _, col := range cols {
			if present[col] {
				c.used = append(c.used, col)
			} else {
				c.missing = append(c.missing, col)
			}
		}
		c.usedN, c.missedN = len(c.used), len(c.missing)
		if c.usedN == 0 {
			continue
		}
		if winner == nil || better(c.st, c.usedN, c.missedN, winner.st, winner.usedN, winner.missedN) {
			winner = c
		}
	}
	if winner == nil {
		return nil, nil, nil
	}
	used := map[string]bool{}
	for _, c := range winner.used {
		used[c] = true
	}
	for _, h := range fileCols {
		if !used[h] {
			added = append(added, h)
		}
	}
	return winner.st, added, winner.missing
}

func better(a *SavedTemplate, aUsed, aMissed int, b *SavedTemplate, bUsed, bMissed int) bool {
	switch {
	case aUsed != bUsed:
		return aUsed > bUsed
	case aMissed != bMissed:
		return aMissed < bMissed
	case a.LastUsed != nil && b.LastUsed == nil:
		return true
	case a.LastUsed == nil && b.LastUsed != nil:
		return false
	case a.LastUsed != nil && b.LastUsed != nil && !a.LastUsed.Equal(*b.LastUsed):
		return a.LastUsed.After(*b.LastUsed)
	}
	return a.ID < b.ID
}
