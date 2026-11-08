package records

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
)

// workType has no priorities: epics and other work units. defectType (with P1
// to P4) is shared with the other tests.
var workType = domain.RecordType{ID: "epic", Name: "Epic"}

func guessFor(in Inspection, field string) (ColumnGuess, bool) {
	for _, g := range in.Guesses {
		if g.Field == field {
			return g, true
		}
	}
	return ColumnGuess{}, false
}

func valuesOf(in Inspection, field string) map[string]ValueCount {
	out := map[string]ValueCount{}
	for _, vc := range in.Values[field] {
		out[vc.Value] = vc
	}
	return out
}

func TestGuessTrackerHeaders(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	in := Inspect(tbl, []domain.RecordType{workType, defectType}, nil)

	want := map[string]string{
		"externalId":  "Issue key",
		"title":       "Summary",
		"category":    "Issue Type",
		"priority":    "Priority",
		"status":      "Status",
		"state":       "Status",
		"subjectKey":  "Product",
		"createdAt":   "Created",
		"completedAt": "Resolved",
	}
	for field, col := range want {
		g, ok := guessFor(in, field)
		if !ok {
			t.Errorf("no guess for %s", field)
			continue
		}
		if g.Column != col {
			t.Errorf("%s guessed from %q, want %q", field, g.Column, col)
		}
		if g.Confidence < 0.9 {
			t.Errorf("%s confidence %.2f, want at least 0.9", field, g.Confidence)
		}
		if len(g.Samples) != 3 {
			t.Errorf("%s has %d samples, want 3: %q", field, len(g.Samples), g.Samples)
		}
	}
	if len(in.Guesses) != len(want) {
		t.Errorf("got %d guesses, want %d: %+v", len(in.Guesses), len(want), in.Guesses)
	}
	if g, ok := guessFor(in, "priority"); ok {
		if !reflect.DeepEqual(g.Samples, []string{"Highest", "High", "Medium"}) {
			t.Errorf("priority samples = %q", g.Samples)
		}
	}
	// Samples skip empty cells.
	if g, ok := guessFor(in, "completedAt"); ok {
		if !reflect.DeepEqual(g.Samples, []string{"2026-08-19 16:40", "2026-07-30 11:00", "2026-07-01 08:45"}) {
			t.Errorf("completedAt samples = %q", g.Samples)
		}
	}
	for _, g := range in.Guesses {
		if g.Column == "Linked tickets" {
			t.Errorf("Linked tickets should not be guessed, got field %s", g.Field)
		}
	}

	if in.RowCount != 11 || !reflect.DeepEqual(in.Headers, tbl.Headers) {
		t.Errorf("RowCount = %d, Headers = %q", in.RowCount, in.Headers)
	}
	if len(in.Samples) == 0 || len(in.Samples) > 5 || len(in.Samples[0]) != len(tbl.Headers) || in.Samples[0][0] != "CHK-101" {
		t.Errorf("Samples = %q", in.Samples)
	}

	wantFormats := []string{"2006-01-02 15:04", "02/Jan/06 3:04 PM"}
	if got := in.DateFormats["Created"]; !reflect.DeepEqual(got, wantFormats) {
		t.Errorf("Created formats = %q, want %q", got, wantFormats)
	}
	if len(in.AmbiguousDates) != 0 {
		t.Errorf("AmbiguousDates = %q", in.AmbiguousDates)
	}
}

// The draft is complete enough to preview straight away: valid for the
// suggested type, and normalizing the very file it was guessed from.
func TestDraftFromGuessesNormalizes(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	in := Inspect(tbl, []domain.RecordType{workType, defectType}, nil)

	if in.SuggestedType != "defect" || in.Draft.RecordType != "defect" {
		t.Fatalf("SuggestedType = %q, Draft.RecordType = %q", in.SuggestedType, in.Draft.RecordType)
	}
	if errs := in.Draft.Validate(defectType); len(errs) != 0 {
		t.Fatalf("draft invalid: %v", errs)
	}
	if in.Draft.File.Format != "csv" || in.Draft.File.HeaderRow != 1 {
		t.Errorf("File = %+v", in.Draft.File)
	}
	if in.Draft.Fields["state"].Column != "Status" || in.Draft.Fields["state"].Map["Won't Do"] != "cancelled" {
		t.Errorf("state = %+v", in.Draft.Fields["state"])
	}
	if in.Draft.Fields["priority"].Map["Highest"] != "P1" || in.Draft.Fields["priority"].Default != "none" {
		t.Errorf("priority = %+v", in.Draft.Fields["priority"])
	}
	if got := in.Draft.Fields["createdAt"].DateFormats; !reflect.DeepEqual(got, in.DateFormats["Created"]) {
		t.Errorf("createdAt formats = %q", got)
	}

	rows, skipped, problems := Normalize(in.Draft, defectType, tbl)
	if len(problems) != 0 || len(rows) != 11 || skipped != 0 {
		t.Fatalf("rows = %d, skipped = %d, problems = %+v", len(rows), skipped, problems)
	}
	byID := map[string]Row{}
	for _, r := range rows {
		byID[r.ExternalID] = r
	}
	if r := byID["BIL-202"]; r.Fields.State != domain.StateCancelled || r.Fields.Priority != "P4" {
		t.Errorf("BIL-202 = %+v", r.Fields)
	}
	if r := byID["BIL-203"]; r.Fields.Priority != "" {
		t.Errorf("BIL-203 priority = %q, want none", r.Fields.Priority)
	}
	if got := byID["CHK-103"].Fields.CreatedAt.String(); got != "2026-09-05" {
		t.Errorf("CHK-103 created = %s", got)
	}
}

func TestGuessEpicsFixture(t *testing.T) {
	tbl := readFixtureCSV(t, "epics.csv")
	in := Inspect(tbl, []domain.RecordType{defectType, workType}, nil)

	want := map[string]string{
		"externalId":  "Epic key",
		"title":       "Epic name",
		"subjectKey":  "Product",
		"status":      "Status",
		"state":       "Status",
		"createdAt":   "Created",
		"dueAt":       "Due date",
		"completedAt": "Done date",
	}
	for field, col := range want {
		g, ok := guessFor(in, field)
		if !ok || g.Column != col {
			t.Errorf("%s = %+v (ok=%v), want column %q", field, g, ok, col)
		}
	}
	// "Earlier due dates" is a list column, not the due date.
	if g, _ := guessFor(in, "dueAt"); g.Column != "Due date" {
		t.Errorf("dueAt = %q", g.Column)
	}
	if in.SuggestedType != "epic" {
		t.Errorf("SuggestedType = %q, want epic", in.SuggestedType)
	}
	// A match on the last word of a header is weaker than an exact synonym.
	if g, _ := guessFor(in, "title"); g.Confidence >= 0.9 || g.Confidence < 0.6 {
		t.Errorf("title confidence = %.2f, want between 0.6 and 0.9", g.Confidence)
	}
}

func TestGuessSynonymsAreCaseAndPunctuationInsensitive(t *testing.T) {
	tbl := csvTable(
		[]string{"  ISSUE_KEY ", "TITLE", "Team", "Date-Created", "Target Date"},
		[]string{"A-1", "one", "X", "2026-01-02", "2026-02-01"},
		[]string{"A-2", "two", "Y", "2026-01-03", "2026-02-02"},
	)
	in := Inspect(tbl, nil, nil)
	for field, col := range map[string]string{
		"externalId": "ISSUE_KEY", "title": "TITLE", "subjectKey": "Team",
		"createdAt": "Date-Created", "dueAt": "Target Date",
	} {
		if g, ok := guessFor(in, field); !ok || g.Column != col {
			t.Errorf("%s = %+v (ok=%v), want %q", field, g, ok, col)
		}
	}
	if g, _ := guessFor(in, "externalId"); g.Confidence < 0.9 {
		t.Errorf("ISSUE_KEY confidence = %.2f", g.Confidence)
	}
}

func TestGuessSynonymPriority(t *testing.T) {
	// Both look like an ID; the stronger synonym wins whatever the order.
	tbl := csvTable([]string{"ID", "Issue key", "Product", "Created"},
		[]string{"1", "CHK-1", "Checkout", "2026-01-01"},
		[]string{"2", "CHK-2", "Checkout", "2026-01-02"},
	)
	in := Inspect(tbl, nil, nil)
	if g, _ := guessFor(in, "externalId"); g.Column != "Issue key" {
		t.Errorf("externalId = %q, want Issue key", g.Column)
	}
	// A column is claimed by one field only (except status, which also feeds state).
	seen := map[string]string{}
	for _, g := range in.Guesses {
		if g.Field == "state" {
			continue
		}
		if other, dup := seen[g.Column]; dup {
			t.Errorf("column %q guessed for both %s and %s", g.Column, other, g.Field)
		}
		seen[g.Column] = g.Field
	}
}

func TestGuessByContent(t *testing.T) {
	tbl := csvTable(
		[]string{"Ref", "Notes", "Group", "Opened on", "Wrapped up"},
		[]string{"CHK-1", "needs review", "a", "2026-03-02", ""},
		[]string{"CHK-2", "needs review", "b", "2026-03-04", "2026-04-01"},
		[]string{"CHK-3", "blocked", "a", "2026-03-09", ""},
		[]string{"CHK-4", "blocked", "b", "2026-03-10", ""},
		[]string{"CHK-5", "later", "a", "2026-03-11", "2026-04-09"},
	)
	in := Inspect(tbl, nil, nil)

	id, ok := guessFor(in, "externalId")
	if !ok || id.Column != "Ref" {
		t.Fatalf("externalId = %+v (ok=%v), want Ref", id, ok)
	}
	if id.Confidence <= 0 || id.Confidence >= 0.9 {
		t.Errorf("content guess confidence = %.2f, want below header-synonym confidence", id.Confidence)
	}
	created, ok := guessFor(in, "createdAt")
	if !ok || created.Column != "Opened on" {
		t.Errorf("createdAt = %+v (ok=%v), want Opened on", created, ok)
	}
	done, ok := guessFor(in, "completedAt")
	if !ok || done.Column != "Wrapped up" || done.Confidence >= created.Confidence {
		t.Errorf("completedAt = %+v (ok=%v)", done, ok)
	}
	if !reflect.DeepEqual(done.Samples, []string{"2026-04-01", "2026-04-09"}) {
		t.Errorf("completedAt samples = %q", done.Samples)
	}
	for _, g := range in.Guesses {
		if g.Column == "Notes" || g.Column == "Group" {
			t.Errorf("%s should not be guessed (field %s)", g.Column, g.Field)
		}
	}
}

func TestContentRulesRejectNonCandidates(t *testing.T) {
	// A column of repeated values is not an ID; a column of dates is not an ID
	// even though its values are unique.
	tbl := csvTable([]string{"Label", "Day"},
		[]string{"x", "2026-01-01"},
		[]string{"x", "2026-01-02"},
		[]string{"y", "2026-01-03"},
	)
	in := Inspect(tbl, nil, nil)
	if g, ok := guessFor(in, "externalId"); ok {
		t.Errorf("externalId = %+v, want none", g)
	}
	if g, ok := guessFor(in, "createdAt"); !ok || g.Column != "Day" {
		t.Errorf("createdAt = %+v (ok=%v)", g, ok)
	}

	// A header that says "created" but holds text is a weak guess.
	tbl = csvTable([]string{"Created"}, []string{"yesterday"}, []string{"last week"})
	in = Inspect(tbl, nil, nil)
	if g, ok := guessFor(in, "createdAt"); !ok || g.Confidence >= 0.9 {
		t.Errorf("createdAt = %+v (ok=%v), want a low-confidence guess", g, ok)
	}

	// A suffix match such as "Customer ticket" is not an ID unless its values are unique.
	tbl = csvTable([]string{"Customer ticket", "Product"},
		[]string{"SUP-1", "A"}, []string{"SUP-1", "B"}, []string{"SUP-2", "C"})
	in = Inspect(tbl, nil, nil)
	if g, ok := guessFor(in, "externalId"); ok {
		t.Errorf("externalId = %+v, want none", g)
	}
}

func TestGuessXlsxSerialDates(t *testing.T) {
	tbl := Table{
		Format:  "xlsx",
		Headers: []string{"Item", "Opened", "Budget"},
		Rows: [][]string{
			{"R-1", "46000", "25000"},
			{"R-2", "46010", "30000"},
			{"R-3", "46020", "41000"},
		},
		RowNums: []int{2, 3, 4},
	}
	in := Inspect(tbl, nil, nil)
	if g, ok := guessFor(in, "createdAt"); !ok || g.Column != "Opened" {
		t.Errorf("createdAt = %+v (ok=%v), want Opened", g, ok)
	}
	// 25000 is also a valid serial, but it is not the plausible-year range
	// and the header says nothing.
	for _, g := range in.Guesses {
		if g.Column == "Budget" {
			t.Errorf("Budget guessed as %s", g.Field)
		}
	}
	if in.Draft.File.Format != "xlsx" {
		t.Errorf("Draft format = %q", in.Draft.File.Format)
	}
}

func TestSuggestPriorityValues(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	in := Inspect(tbl, []domain.RecordType{defectType}, nil)

	got := in.Values["priority"]
	want := []ValueCount{
		{"Low", 3, "P4"}, {"Medium", 3, "P3"}, {"High", 2, "P2"}, {"Highest", 2, "P1"}, {"", 1, "none"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("priority values = %+v\nwant %+v", got, want)
	}
}

func TestPriorityKeywords(t *testing.T) {
	cases := map[string]string{
		"Highest": "P1", "Critical": "P1", "BLOCKER": "P1", "p1": "P1", "Urgent": "P1",
		"High": "P2", "Major": "P2", "P2": "P2",
		"Medium": "P3", "Normal": "P3", "P3": "P3",
		"Low": "P4", "Minor": "P4", "P4": "P4",
		"Lowest": "none", "Trivial": "none", "None": "none", "": "none",
		"Sev 2": "", "whenever": "",
	}
	var rows [][]string
	i := 0
	for v := range cases {
		i++
		rows = append(rows, []string{"K-" + string(rune('a'+i)), "P", v, "2026-01-01"})
	}
	// Row numbers are irrelevant; Go map order is random, so results must not depend on it.
	tbl := csvTable([]string{"Key", "Product", "Priority", "Created"}, rows...)
	in := Inspect(tbl, []domain.RecordType{defectType}, nil)
	got := valuesOf(in, "priority")
	for raw, want := range cases {
		vc, ok := got[raw]
		if !ok {
			t.Errorf("value %q missing from %+v", raw, in.Values["priority"])
			continue
		}
		if vc.Suggested != want {
			t.Errorf("%q suggested %q, want %q", raw, vc.Suggested, want)
		}
	}
}

func TestPriorityOnlyOffersThePriorityTheTypeHas(t *testing.T) {
	small := domain.RecordType{ID: "bug", Name: "Bug", Priorities: []string{"P1", "P2"}}
	tbl := csvTable([]string{"Key", "Product", "Priority", "Created"},
		[]string{"K-1", "P", "Highest", "2026-01-01"},
		[]string{"K-2", "P", "Medium", "2026-01-01"},
		[]string{"K-3", "P", "Trivial", "2026-01-01"},
		[]string{"K-4", "P", "", "2026-01-01"},
	)
	got := valuesOf(Inspect(tbl, []domain.RecordType{small}, nil), "priority")
	if got["Highest"].Suggested != "P1" || got["Medium"].Suggested != "" ||
		got["Trivial"].Suggested != "none" || got[""].Suggested != "none" {
		t.Errorf("suggestions = %+v", got)
	}

	// A value that is already one of the type's own priorities maps to itself.
	custom := domain.RecordType{ID: "inc", Name: "Incident", Priorities: []string{"Sev1", "Sev2"}}
	tbl = csvTable([]string{"Key", "Product", "Priority", "Created"},
		[]string{"K-1", "P", "sev1", "2026-01-01"},
		[]string{"K-2", "P", "Sev2", "2026-01-01"},
		[]string{"K-3", "P", "Highest", "2026-01-01"},
	)
	in := Inspect(tbl, []domain.RecordType{custom}, nil)
	got = valuesOf(in, "priority")
	if got["sev1"].Suggested != "Sev1" || got["Sev2"].Suggested != "Sev2" || got["Highest"].Suggested != "" {
		t.Errorf("suggestions = %+v", got)
	}
	// Only suggested values enter the draft's map; the rest stay unmapped to be asked.
	if m := in.Draft.Fields["priority"].Map; m["sev1"] != "Sev1" || len(m) != 2 {
		t.Errorf("draft priority map = %v", m)
	}
}

func TestStateSuggestions(t *testing.T) {
	statuses := map[string]string{
		"Done": "done", "Closed": "done", "Resolved": "done", "Complete": "done",
		"Completed": "done", "Released": "done",
		"Won't Do": "cancelled", "Wont Do": "cancelled", "Won\u2019t Do": "cancelled",
		"Cancelled": "cancelled", "Canceled": "cancelled", "Duplicate": "cancelled",
		"Rejected": "cancelled", "Obsolete": "cancelled",
		"In Progress": "open", "Open": "open", "In Review": "open", "Reopened": "open", "": "open",
	}
	var rows [][]string
	i := 0
	for v := range statuses {
		i++
		rows = append(rows, []string{"K-" + string(rune('a'+i)), "P", v, "2026-01-01"})
	}
	tbl := csvTable([]string{"Key", "Product", "Status", "Created"}, rows...)
	in := Inspect(tbl, []domain.RecordType{defectType}, nil)
	got := valuesOf(in, "state")
	for raw, want := range statuses {
		vc, ok := got[raw]
		if !ok {
			t.Errorf("status %q missing from %+v", raw, in.Values["state"])
			continue
		}
		if vc.Suggested != want {
			t.Errorf("status %q suggested %q, want %q", raw, vc.Suggested, want)
		}
	}

	state := in.Draft.Fields["state"]
	if state.Column != "Status" || state.Map["*"] != "open" || state.Map["Closed"] != "done" || state.Map["Canceled"] != "cancelled" {
		t.Errorf("draft state = %+v", state)
	}
	if state.Default != "open" {
		t.Errorf("blank status should default to open, got %q", state.Default)
	}
	if errs := in.Draft.Validate(defectType); len(errs) != 0 {
		for _, e := range errs {
			if strings.HasPrefix(e.Path, "fields.state") {
				t.Errorf("state invalid: %v", e)
			}
		}
	}
}

func TestSubjectValuesAreCounted(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	in := Inspect(tbl, nil, nil)
	got := in.Values["subjectKey"]
	if len(got) == 0 || got[0].Value != "Checkout" || got[0].Count != 4 || got[0].Suggested != "" {
		t.Errorf("subject values = %+v", got)
	}
}

func TestAmbiguousDateDetected(t *testing.T) {
	tbl := csvTable([]string{"Key", "Product", "Created", "Resolved"},
		[]string{"A-1", "X", "03/04/2026", "05/06/2026"},
		[]string{"A-2", "X", "01/02/2026", "13/06/2026"},
		[]string{"A-3", "X", "11/12/2026", ""},
	)
	in := Inspect(tbl, nil, nil)
	if !reflect.DeepEqual(in.AmbiguousDates, []string{"Created"}) {
		t.Fatalf("AmbiguousDates = %q, want [Created]", in.AmbiguousDates)
	}
	// Both readings are offered, month first; the draft commits to the first.
	if got, want := in.DateFormats["Created"], []string{"01/02/2006", "02/01/2006"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Created formats = %q, want %q", got, want)
	}
	if got := in.Draft.Fields["createdAt"].DateFormats; !reflect.DeepEqual(got, []string{"01/02/2006"}) {
		t.Errorf("draft createdAt formats = %q", got)
	}
	// A 13 in the column settles it: day first, so not ambiguous.
	if got := in.DateFormats["Resolved"]; !reflect.DeepEqual(got, []string{"02/01/2006"}) {
		t.Errorf("Resolved formats = %q, want day first", got)
	}
}

func TestAmbiguousDateRules(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   bool
	}{
		{"all small", []string{"03/04/2026", "05/06/2026"}, true},
		{"padded and not", []string{"3/4/2026", "05/06/2026"}, true},
		{"a day over 12", []string{"03/04/2026", "25/06/2026"}, false},
		{"a month over 12", []string{"03/04/2026", "06/25/2026"}, false},
		{"iso", []string{"2026-03-04", "2026-05-06"}, false},
		{"with a time", []string{"03/04/2026 10:15", "05/06/2026 11:00"}, true},
	}
	for _, c := range cases {
		var rows [][]string
		for i, v := range c.values {
			rows = append(rows, []string{"K-" + string(rune('a'+i)), "P", v})
		}
		in := Inspect(csvTable([]string{"Key", "Product", "Created"}, rows...), nil, nil)
		if got := len(in.AmbiguousDates) == 1; got != c.want {
			t.Errorf("%s: ambiguous = %v, want %v (formats %q)", c.name, got, c.want, in.DateFormats["Created"])
		}
	}
}

func TestDateFormatDetection(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   []string
	}{
		{"iso date", []string{"2026-03-04", "2026-05-06"}, []string{"2006-01-02"}},
		{"iso with time", []string{"2026-03-04 10:15", "2026-05-06 11:00"}, []string{"2006-01-02 15:04"}},
		{"tracker style", []string{"04/Mar/26 2:15 PM", "06/May/26 11:00 AM"}, []string{"02/Jan/06 3:04 PM"}},
		{"day month year words", []string{"4 Mar 2026", "16 May 2026"}, []string{"2 Jan 2006"}},
		{"month day year words", []string{"Mar 4, 2026", "May 16, 2026"}, []string{"Jan 2, 2006"}},
		{"dots", []string{"04.03.2026", "16.05.2026"}, []string{"02.01.2006"}},
	}
	for _, c := range cases {
		var rows [][]string
		for i, v := range c.values {
			rows = append(rows, []string{"K-" + string(rune('a'+i)), "P", v})
		}
		in := Inspect(csvTable([]string{"Key", "Product", "Created"}, rows...), nil, nil)
		if got := in.DateFormats["Created"]; !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: formats = %q, want %q", c.name, got, c.want)
		}
		if len(in.AmbiguousDates) != 0 {
			t.Errorf("%s: unexpectedly ambiguous", c.name)
		}
	}
}

func TestSuggestedType(t *testing.T) {
	withPriorities := domain.RecordType{ID: "defect", Name: "Defect", Priorities: []string{"P1"}}
	without := domain.RecordType{ID: "epic", Name: "Epic"}
	types := []domain.RecordType{without, withPriorities}

	mk := func(headers ...string) Table {
		return csvTable(headers, make([]string, len(headers)), make([]string, len(headers)))
	}
	cases := []struct {
		name    string
		headers []string
		types   []domain.RecordType
		want    string
	}{
		{"priority and resolved", []string{"Key", "Product", "Priority", "Resolved", "Created"}, types, "defect"},
		{"due date", []string{"Key", "Product", "Due date", "Created"}, types, "epic"},
		{"priority, resolved and a due date", []string{"Key", "Product", "Priority", "Resolved", "Due date"}, types, "defect"},
		{"priority only", []string{"Key", "Product", "Priority", "Created"}, types, ""},
		{"nothing to go on", []string{"Key", "Product", "Created"}, types, ""},
		{"no matching type", []string{"Key", "Product", "Priority", "Resolved"}, []domain.RecordType{without}, ""},
		{"no types", []string{"Key", "Product", "Due date"}, nil, ""},
	}
	for _, c := range cases {
		in := Inspect(mk(c.headers...), c.types, nil)
		if in.SuggestedType != c.want {
			t.Errorf("%s: SuggestedType = %q, want %q", c.name, in.SuggestedType, c.want)
		}
		if in.Draft.RecordType != c.want {
			t.Errorf("%s: Draft.RecordType = %q, want %q", c.name, in.Draft.RecordType, c.want)
		}
	}

	// With two matching types the first one given wins, so the answer is stable.
	two := []domain.RecordType{
		{ID: "bug", Name: "Bug", Priorities: []string{"P1"}},
		{ID: "defect", Name: "Defect", Priorities: []string{"P1"}},
	}
	in := Inspect(mk("Key", "Product", "Priority", "Resolved"), two, nil)
	if in.SuggestedType != "bug" {
		t.Errorf("SuggestedType = %q, want bug", in.SuggestedType)
	}
}

var defectColumns = FieldMap{Column: "Issue key"}

func savedDefects(id string, rev int, extra map[string]FieldMap) SavedTemplate {
	t := Template{
		Name: "Defects export " + id, RecordType: "defect", Source: "tracker",
		File: FileSpec{Format: "csv", HeaderRow: 1},
		Fields: map[string]FieldMap{
			"externalId": {Column: "Issue key"},
			"subjectKey": {Column: "Product"},
			"state":      {Column: "Status", Map: map[string]string{"Done": "done", "*": "open"}},
			"createdAt":  {Column: "Created"},
		},
	}
	for k, v := range extra {
		t.Fields[k] = v
	}
	return SavedTemplate{ID: id, Revision: rev, T: t}
}

func TestRecognizeSavedTemplate(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	types := []domain.RecordType{workType, defectType}

	small := savedDefects("small", 1, nil)
	full := savedDefects("full", 3, map[string]FieldMap{
		"title":       {Column: "Summary"},
		"priority":    {Column: "Priority", Map: map[string]string{"Highest": "P1"}},
		"completedAt": {Column: "Resolved"},
	})
	// Needs a column the file does not have: not a match.
	sprint := savedDefects("sprint", 1, map[string]FieldMap{"title": {Column: "Sprint"}})
	sprint.T.Fields["externalId"] = FieldMap{Column: "Sprint key"}
	// Other shaped export entirely.
	other := SavedTemplate{ID: "other", T: Template{
		Name: "Other", RecordType: "epic", Source: "tracker", File: FileSpec{Format: "csv"},
		Fields: map[string]FieldMap{
			"externalId": {Column: "Epic key"}, "subjectKey": {Column: "Product"},
			"state": {Column: "Status"}, "createdAt": {Column: "Created"},
		},
	}}

	in := Inspect(tbl, types, []SavedTemplate{small, sprint, other, full})
	if in.MatchedTemplateID != "full" {
		t.Fatalf("MatchedTemplateID = %q, want full", in.MatchedTemplateID)
	}
	if in.SuggestedType != "defect" {
		t.Errorf("SuggestedType = %q", in.SuggestedType)
	}
	if !reflect.DeepEqual(in.Draft, full.T) {
		t.Errorf("Draft should be the recognized template:\n got %+v\nwant %+v", in.Draft, full.T)
	}
	// Guesses are still reported, so the wizard can show them if the user wants to remap.
	if _, ok := guessFor(in, "externalId"); !ok {
		t.Error("guesses missing on a recognized file")
	}

	// Order of the saved list does not matter.
	again := Inspect(tbl, types, []SavedTemplate{full, other, sprint, small})
	if again.MatchedTemplateID != "full" {
		t.Errorf("reordered: MatchedTemplateID = %q", again.MatchedTemplateID)
	}

	// Nothing matches: guesses build the draft.
	none := Inspect(tbl, types, []SavedTemplate{sprint, other})
	if none.MatchedTemplateID != "" || none.Draft.Fields["externalId"].Column != "Issue key" {
		t.Errorf("no match: MatchedTemplateID = %q, Draft = %+v", none.MatchedTemplateID, none.Draft.Fields["externalId"])
	}
	if len(none.Added) != 0 || len(none.Missing) != 0 {
		t.Errorf("no match should report no diff: Added=%q Missing=%q", none.Added, none.Missing)
	}
}

func TestRecognitionTieBreaks(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	older := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

	a, b := savedDefects("a", 1, nil), savedDefects("b", 1, nil)
	a.LastUsed, b.LastUsed = &older, &newer
	if got := Inspect(tbl, nil, []SavedTemplate{a, b}).MatchedTemplateID; got != "b" {
		t.Errorf("most recently used should win, got %q", got)
	}

	c, d := savedDefects("c", 1, nil), savedDefects("d", 1, nil)
	if got := Inspect(tbl, nil, []SavedTemplate{d, c}).MatchedTemplateID; got != "c" {
		t.Errorf("with nothing else to go on the lowest ID wins, got %q", got)
	}
	// Used beats never used.
	e, f := savedDefects("e", 1, nil), savedDefects("f", 1, nil)
	f.LastUsed = &older
	if got := Inspect(tbl, nil, []SavedTemplate{e, f}).MatchedTemplateID; got != "f" {
		t.Errorf("used template should beat unused, got %q", got)
	}
}

func TestHeaderDiff(t *testing.T) {
	tbl := csvTable(
		[]string{"Issue key", "Product", "Status", "Created", "Reporter", "Sprint", "Summary"},
		[]string{"A-1", "X", "Done", "2026-01-02", "pat", "S1", "one"},
	)
	st := savedDefects("t", 1, map[string]FieldMap{
		"title":    {Column: "Summary"},
		"priority": {Column: "Severity"},                      // optional column the file lost
		"url":      {Template: "https://x/{Issue key}/{Env}"}, // one placeholder present, one not
	})
	st.T.Attributes = map[string]FieldMap{"customerTicket": {Column: "Linked tickets"}}
	st.T.SkipRows = []SkipRule{{Column: "Issue Type", In: []string{"Sub-task"}}}

	in := Inspect(tbl, nil, []SavedTemplate{st})
	if in.MatchedTemplateID != "t" {
		t.Fatalf("MatchedTemplateID = %q; optional columns may be missing", in.MatchedTemplateID)
	}
	if want := []string{"Reporter", "Sprint"}; !reflect.DeepEqual(in.Added, want) {
		t.Errorf("Added = %q, want %q", in.Added, want)
	}
	if want := []string{"Severity", "Env", "Linked tickets", "Issue Type"}; !reflect.DeepEqual(in.Missing, want) {
		t.Errorf("Missing = %q, want %q", in.Missing, want)
	}

	// ColumnChanges reports the same lists for one template.
	added, missing := ColumnChanges(st.T, tbl.Headers)
	if !reflect.DeepEqual(added, in.Added) || !reflect.DeepEqual(missing, in.Missing) {
		t.Errorf("ColumnChanges = %q, %q; want %q, %q", added, missing, in.Added, in.Missing)
	}

	// A missing required column is not recognized.
	tbl2 := csvTable([]string{"Product", "Status", "Created"}, []string{"X", "Done", "2026-01-02"})
	in = Inspect(tbl2, nil, []SavedTemplate{st})
	if in.MatchedTemplateID != "" || len(in.Missing) != 0 {
		t.Errorf("missing Issue key: MatchedTemplateID = %q, Missing = %q", in.MatchedTemplateID, in.Missing)
	}

	// Column names must match exactly, as Normalize reads them (after trimming).
	tbl3 := csvTable([]string{"issue key", "Product", "Status", "Created"}, []string{"A-1", "X", "Done", "2026-01-02"})
	if got := Inspect(tbl3, nil, []SavedTemplate{st}).MatchedTemplateID; got != "" {
		t.Errorf("case-differing header matched %q", got)
	}
}

func TestRecognitionSkipsRequiredFieldsWithADefaultOrConstant(t *testing.T) {
	st := SavedTemplate{ID: "c", T: Template{
		Name: "Const", RecordType: "defect", Source: "tracker", File: FileSpec{Format: "csv"},
		Fields: map[string]FieldMap{
			"externalId": {Column: "Key"},
			"subjectKey": {Constant: "Checkout"},
			"state":      {Column: "Status", Default: "open"},
			"createdAt":  {Column: "Created"},
		},
	}}
	tbl := csvTable([]string{"Key", "Created"}, []string{"A-1", "2026-01-02"})
	in := Inspect(tbl, nil, []SavedTemplate{st})
	if in.MatchedTemplateID != "c" || !reflect.DeepEqual(in.Missing, []string{"Status"}) {
		t.Errorf("MatchedTemplateID = %q, Missing = %q", in.MatchedTemplateID, in.Missing)
	}
	// A template that names no columns at all would match every file; it never does.
	empty := SavedTemplate{ID: "e", T: Template{Name: "E", Fields: map[string]FieldMap{"subjectKey": {Constant: "X"}}}}
	if got := Inspect(tbl, nil, []SavedTemplate{empty}).MatchedTemplateID; got != "" {
		t.Errorf("column-less template matched %q", got)
	}
}

func TestInspectDeterministic(t *testing.T) {
	tbl := readFixtureCSV(t, "defects.csv")
	types := []domain.RecordType{defectType, workType}
	first := Inspect(tbl, types, nil)
	for i := 0; i < 20; i++ {
		if got := Inspect(tbl, types, nil); !reflect.DeepEqual(got, first) {
			t.Fatalf("run %d differs:\n%+v\n%+v", i, got, first)
		}
	}
}

func TestInspectEmptyAndOddTables(t *testing.T) {
	for _, tbl := range []Table{
		{},
		{Headers: []string{"", "", ""}, Format: "csv"},
		csvTable([]string{"Key", "Key", "Product"}, []string{"A", "B", "C"}),
		csvTable([]string{"Priority", "Status", "Created"}),
	} {
		in := Inspect(tbl, nil, nil)
		if in.Values == nil || in.DateFormats == nil {
			t.Errorf("maps should be non-nil for %+v", tbl.Headers)
		}
	}
	// Duplicate headers use the first.
	in := Inspect(csvTable([]string{"Key", "Key", "Product"}, []string{"A", "B", "C"}, []string{"D", "E", "F"}), nil, nil)
	if g, _ := guessFor(in, "externalId"); g.Column != "Key" || g.Samples[0] != "A" {
		t.Errorf("externalId = %+v", g)
	}
}

func TestSuffixMatchSkipsHeadersNamingAnotherField(t *testing.T) {
	// "Product name" says product, not title; "Epic name" has nothing else in it.
	tbl := csvTable([]string{"Key", "Product name", "Epic name", "Created"},
		[]string{"A-1", "X", "one", "2026-01-02"}, []string{"A-2", "Y", "two", "2026-01-03"})
	in := Inspect(tbl, nil, nil)
	if g, _ := guessFor(in, "title"); g.Column != "Epic name" {
		t.Errorf("title = %q, want Epic name", g.Column)
	}
	if g, ok := guessFor(in, "subjectKey"); ok {
		t.Errorf("subjectKey = %+v; a Product name header is not matched by synonym rules", g)
	}
}

// A maximum-size file must be inspected without trouble (200,000 rows, many columns).
func TestInspectLargeFile(t *testing.T) {
	const rows, cols = 200_000, 40
	headers := make([]string, cols)
	headers[0], headers[1], headers[2] = "Key", "Product", "Created"
	for i := 3; i < cols; i++ {
		headers[i] = "Field " + strconv.Itoa(i)
	}
	tbl := Table{Headers: headers, Format: "csv"}
	for r := 0; r < rows; r++ {
		row := make([]string, cols)
		row[0], row[1], row[2] = "K-"+strconv.Itoa(r), "P"+strconv.Itoa(r%7), "2026-03-04"
		for c := 3; c < cols; c++ {
			row[c] = "v" + strconv.Itoa((r+c)%97)
		}
		tbl.Rows = append(tbl.Rows, row)
		tbl.RowNums = append(tbl.RowNums, r+2)
	}
	start := time.Now()
	in := Inspect(tbl, nil, nil)
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("Inspect took %s", d)
	}
	if g, ok := guessFor(in, "externalId"); !ok || g.Column != "Key" {
		t.Errorf("externalId = %+v", g)
	}
}

func TestSuggestValue(t *testing.T) {
	rt := domain.RecordType{ID: "defect", Priorities: []string{"P1", "P2", "P3", "P4"}}
	cases := []struct{ field, raw, want string }{
		{"priority", "Urgent", "P1"},
		{"priority", "Whenever", ""},
		{"state", "Won't Do", "cancelled"},
		{"state", "Triage", "open"},
		{"category", "bug", ""},
	}
	for _, c := range cases {
		if got := SuggestValue(c.field, c.raw, rt); got != c.want {
			t.Errorf("SuggestValue(%q, %q) = %q, want %q", c.field, c.raw, got, c.want)
		}
	}
}
