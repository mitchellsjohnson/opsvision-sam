package records

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

var epicType = domain.RecordType{ID: "epic", Name: "Epic"}

func readFixtureCSV(t testing.TB, name string) Table {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tbl, err := ReadCSV(f)
	if err != nil {
		t.Fatal(err)
	}
	return tbl
}

// csvTable builds a CSV-format table; row numbers start at 2.
func csvTable(headers []string, rows ...[]string) Table {
	tbl := Table{Headers: headers, Format: "csv"}
	for i, r := range rows {
		tbl.Rows = append(tbl.Rows, fit(r, len(headers)))
		tbl.RowNums = append(tbl.RowNums, i+2)
	}
	return tbl
}

// miniTemplate maps Key, Product, Status, Created, and optional extras for the
// defect type.
func miniTemplate(extra map[string]FieldMap) Template {
	tpl := Template{
		Name: "Mini", RecordType: "defect", Source: "tracker",
		File: FileSpec{Format: "csv", HeaderRow: 1},
		Fields: map[string]FieldMap{
			"externalId":  {Column: "Key"},
			"subjectKey":  {Column: "Product"},
			"state":       {Column: "Status", Map: map[string]string{"Done": "done", "Cancelled": "cancelled", "*": "open"}},
			"createdAt":   {Column: "Created"},
			"completedAt": {Column: "Resolved"},
		},
	}
	for k, v := range extra {
		tpl.Fields[k] = v
	}
	return tpl
}

var miniHeaders = []string{"Key", "Product", "Status", "Created", "Resolved", "Priority", "Planned"}

func TestNormalizeDefectsFixture(t *testing.T) {
	tpl := specTemplate(t)
	if errs := tpl.Validate(defectType); errs != nil {
		t.Fatal(errs)
	}
	tbl := readFixtureCSV(t, "defects.csv")
	if want := []string{"Issue key", "Summary", "Issue Type", "Priority", "Status", "Product", "Created", "Resolved", "Linked tickets"}; !reflect.DeepEqual(tbl.Headers, want) {
		t.Fatalf("headers = %q", tbl.Headers)
	}
	if len(tbl.Rows) != 11 {
		t.Fatalf("fixture rows = %d, want 11", len(tbl.Rows))
	}

	rows, skipped, problems := Normalize(tpl, defectType, tbl)
	if len(problems) != 0 {
		t.Fatalf("problems = %+v", problems)
	}
	if skipped != 1 || len(rows) != 10 {
		t.Fatalf("rows = %d, skipped = %d; want 10 and 1 (the Sub-task)", len(rows), skipped)
	}

	byID := map[string]Row{}
	for _, r := range rows {
		byID[r.ExternalID] = r
		if r.Source != "tracker" || r.Type != "defect" {
			t.Fatalf("%s: source/type = %q/%q, want tracker/defect", r.ExternalID, r.Source, r.Type)
		}
	}

	first := byID["CHK-101"]
	f := first.Fields
	if first.RowNum != 2 || f.SubjectKey != "Checkout" || f.Title != "Refund total rounds incorrectly, off by a cent" ||
		f.Category != "Bug" || f.Status != "In Review" || f.State != domain.StateOpen ||
		f.CreatedAt.String() != "2026-09-03" || f.CompletedAt != nil ||
		f.URL != "https://tracker.example/browse/CHK-101" {
		t.Fatalf("CHK-101 = %+v", first)
	}
	if f.Priority != "P1" {
		t.Errorf("Highest maps to %q, want P1", f.Priority)
	}
	if byID["CHK-102"].Fields.Priority != "P2" || byID["BIL-201"].Fields.Priority != "P3" || byID["BIL-202"].Fields.Priority != "P4" {
		t.Errorf("priorities = %q %q %q", byID["CHK-102"].Fields.Priority, byID["BIL-201"].Fields.Priority, byID["BIL-202"].Fields.Priority)
	}
	if got := byID["BIL-203"].Fields.Priority; got != "" {
		t.Errorf("blank priority = %q, want absent (none)", got)
	}

	if wd := byID["BIL-202"].Fields; wd.State != domain.StateCancelled || wd.CompletedAt == nil || wd.CompletedAt.String() != "2026-07-01" {
		t.Errorf("Won't Do = %+v, want cancelled on 2026-07-01", wd)
	}
	if got := byID["BIL-201"].Fields.State; got != domain.StateDone {
		t.Errorf("Closed = %q, want done", got)
	}
	if got := byID["CHK-103"].Fields.CreatedAt.String(); got != "2026-09-05" {
		t.Errorf("second date format: created = %s, want 2026-09-05", got)
	}

	ticket := func(id string) any { return byID[id].Fields.Attributes["customerTicket"] }
	if ticket("CHK-101") != true || ticket("CHK-104") != true || ticket("BIL-201") != true {
		t.Errorf("rows with linked tickets should have customerTicket true")
	}
	if ticket("CHK-102") != false || ticket("ANL-301") != false {
		t.Errorf("rows without linked tickets should have customerTicket false, got %v and %v", ticket("CHK-102"), ticket("ANL-301"))
	}

	if _, ok := byID["CHK-101-1"]; ok {
		t.Error("the Sub-task row should be skipped")
	}
	// File order is kept.
	for i := 1; i < len(rows); i++ {
		if rows[i-1].RowNum >= rows[i].RowNum {
			t.Fatalf("rows out of file order at %d", i)
		}
	}
}

func TestNormalizeEpicsFixture(t *testing.T) {
	tbl := readFixtureCSV(t, "epics.csv")
	tpl := Template{
		Name: "Epics export", RecordType: "epic", Source: "tracker", File: FileSpec{Format: "csv", HeaderRow: 1},
		Fields: map[string]FieldMap{
			"externalId":    {Column: "Epic key"},
			"title":         {Column: "Epic name"},
			"subjectKey":    {Column: "Product"},
			"state":         {Column: "Status", Map: map[string]string{"Done": "done", "Cancelled": "cancelled", "*": "open"}},
			"createdAt":     {Column: "Created"},
			"dueAt":         {Column: "Due date"},
			"priorDueDates": {Column: "Earlier due dates", Separator: ";"},
			"completedAt":   {Column: "Done date"},
			"planned":       {Column: "Planned spend"},
			"actual":        {Column: "Actual spend"},
		},
	}
	if errs := tpl.Validate(epicType); errs != nil {
		t.Fatal(errs)
	}
	rows, skipped, problems := Normalize(tpl, epicType, tbl)
	if len(problems) != 0 || skipped != 0 || len(rows) != 4 {
		t.Fatalf("rows=%d skipped=%d problems=%+v", len(rows), skipped, problems)
	}
	chk := rows[0].Fields
	if chk.State != domain.StateDone || chk.DueAt.String() != "2026-12-15" || *chk.Planned != 1200 || *chk.Actual != 1100 {
		t.Fatalf("CHK-9 = %+v", chk)
	}
	if want := []domain.Date{day("2026-09-30"), day("2026-10-31")}; !reflect.DeepEqual(chk.PriorDueDates, want) {
		t.Fatalf("priorDueDates = %v, want %v", chk.PriorDueDates, want)
	}
	if got := rows[1].Fields.PriorDueDates; len(got) != 1 || got[0].String() != "2026-12-15" {
		t.Fatalf("single prior date = %v", got)
	}
	if rows[2].Fields.PriorDueDates != nil || rows[2].Fields.Planned != nil || rows[2].Fields.CompletedAt != nil {
		t.Fatalf("ANL-7 = %+v", rows[2].Fields)
	}
	if rows[3].Fields.State != domain.StateCancelled {
		t.Fatalf("PIP-2 = %+v", rows[3].Fields)
	}
}

func TestPriorDueDatesSeparator(t *testing.T) {
	headers := []string{"Key", "Product", "Status", "Created", "History"}
	table := csvTable(headers,
		[]string{"E-1", "Checkout", "Open", "2026-01-01", "2026-03-01 | 2026-05-01 | "},
		[]string{"E-2", "Checkout", "Open", "2026-01-01", "2026-03-01|bad"},
	)
	tpl := miniTemplate(map[string]FieldMap{"priorDueDates": {Column: "History", Separator: "|"}})
	rows, _, problems := Normalize(tpl, epicType, table)
	if len(rows) != 1 || len(problems) != 1 || problems[0].RowNum != 3 || problems[0].Field != "priorDueDates" || problems[0].Kind != ProblemError {
		t.Fatalf("rows=%d problems=%+v", len(rows), problems)
	}
	if !strings.Contains(problems[0].Value, "bad") {
		t.Errorf("problem should name the bad part, got %+v", problems[0])
	}
	want := []domain.Date{day("2026-03-01"), day("2026-05-01")}
	if !reflect.DeepEqual(rows[0].Fields.PriorDueDates, want) {
		t.Fatalf("E-1 priorDueDates = %v, want %v", rows[0].Fields.PriorDueDates, want)
	}
	// With no separator set, a comma splits.
	tpl.Fields["priorDueDates"] = FieldMap{Column: "History"}
	rows, _, problems = Normalize(tpl, epicType, csvTable(headers, []string{"E-3", "Checkout", "Open", "2026-01-01", "2026-03-01, 2026-05-01"}))
	if len(problems) != 0 || len(rows) != 1 || len(rows[0].Fields.PriorDueDates) != 2 {
		t.Fatalf("comma default: rows=%+v problems=%+v", rows, problems)
	}
}

func TestValueMapFallback(t *testing.T) {
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Done", "2026-05-01", "2026-05-09"},
		[]string{"D-2", "Checkout", "done", "2026-05-01", "2026-05-09"}, // case-insensitive
		[]string{"D-3", "Checkout", "Blocked", "2026-05-01", ""},        // falls to "*"
		[]string{"D-4", "Checkout", "  Cancelled ", "2026-05-01", "2026-05-02"},
	)
	rows, _, problems := Normalize(miniTemplate(nil), defectType, tbl)
	if len(problems) != 0 {
		t.Fatalf("problems = %+v", problems)
	}
	var got []domain.RecordState
	for _, r := range rows {
		got = append(got, r.Fields.State)
	}
	want := []domain.RecordState{domain.StateDone, domain.StateDone, domain.StateOpen, domain.StateCancelled}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("states = %v, want %v", got, want)
	}

	// Without a map, the raw value must already be a state.
	tpl := miniTemplate(map[string]FieldMap{"state": {Column: "Status"}})
	rows, _, problems = Normalize(tpl, defectType, csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "DONE", "2026-05-01", "2026-05-09"},
		[]string{"D-2", "Checkout", "Blocked", "2026-05-01", ""},
	))
	if len(rows) != 1 || rows[0].Fields.State != domain.StateDone || len(problems) != 1 || problems[0].Kind != ProblemUnmappedValue {
		t.Fatalf("rows=%d problems=%+v", len(rows), problems)
	}
}

func TestUnmappedValueProblem(t *testing.T) {
	tpl := miniTemplate(map[string]FieldMap{
		"priority": {Column: "Priority", Map: map[string]string{"Highest": "P1", "High": "P2"}, Default: "none"},
	})
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "", "Highest"},
		[]string{"D-2", "Checkout", "Open", "2026-05-01", "", "Urgent"},
		[]string{"D-3", "Checkout", "Open", "2026-05-01", "", ""},
	)
	rows, _, problems := Normalize(tpl, defectType, tbl)
	if len(rows) != 2 || rows[0].ExternalID != "D-1" || rows[1].ExternalID != "D-3" {
		t.Fatalf("rows = %+v; the row with the new value waits for an answer", rows)
	}
	if len(problems) != 1 {
		t.Fatalf("problems = %+v", problems)
	}
	p := problems[0]
	if p.Kind != ProblemUnmappedValue || p.RowNum != 3 || p.Column != "Priority" || p.Field != "priority" || p.Value != "Urgent" {
		t.Fatalf("problem = %+v", p)
	}
	if !strings.Contains(p.Message, "Urgent") || !strings.Contains(p.Message, "Priority") {
		t.Fatalf("message %q should name the value and the column", p.Message)
	}
	if rows[1].Fields.Priority != "" {
		t.Errorf("blank cell takes the default none, stored as absent; got %q", rows[1].Fields.Priority)
	}
}

func TestMappedValueMustBeValid(t *testing.T) {
	// A map that points at something the type does not have is a row error, not
	// a question for the admin.
	tpl := miniTemplate(map[string]FieldMap{
		"priority": {Column: "Priority", Map: map[string]string{"Urgent": "P0"}},
	})
	rows, _, problems := Normalize(tpl, defectType, csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "", "Urgent"}))
	if len(rows) != 0 || len(problems) != 1 || problems[0].Kind != ProblemError || problems[0].Field != "priority" {
		t.Fatalf("rows=%d problems=%+v", len(rows), problems)
	}
}

func TestDatesInRows(t *testing.T) {
	tpl := miniTemplate(map[string]FieldMap{
		"createdAt":   {Column: "Created", DateFormats: []string{"2006-01-02 15:04", "02/Jan/06 3:04 PM"}},
		"completedAt": {Column: "Resolved"},
		"measuredAt":  {Column: "Planned"}, // read as a date, for the month-only forms
	})
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-09-03 14:22", "", "", "2026-03"},
		[]string{"D-2", "Checkout", "Open", "05/Sep/26 2:15 PM", "", "", "Mar 2026"},
		[]string{"D-3", "Checkout", "Done", "2026-09-03", "2026-09-04 08:00", "", ""},
		[]string{"D-4", "Checkout", "Open", "46023", "", "", ""},
		[]string{"D-5", "Checkout", "Open", "", "", "", ""},
		[]string{"D-6", "Checkout", "Open", "9/3/2026", "", "", ""},
	)
	rows, _, problems := Normalize(tpl, defectType, tbl)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want D-1..D-3; problems = %+v", len(rows), problems)
	}
	if rows[0].Fields.CreatedAt.String() != "2026-09-03" || rows[0].Fields.CompletedAt != nil {
		t.Errorf("D-1 = %+v (a blank Resolved on an open row is fine)", rows[0].Fields)
	}
	if rows[0].Fields.MeasuredAt.String() != "2026-03-01" || rows[1].Fields.MeasuredAt.String() != "2026-03-01" {
		t.Errorf("month-only dates = %v, %v; want 2026-03-01", rows[0].Fields.MeasuredAt, rows[1].Fields.MeasuredAt)
	}
	if rows[1].Fields.CreatedAt.String() != "2026-09-05" {
		t.Errorf("D-2 created = %s", rows[1].Fields.CreatedAt)
	}
	if rows[2].Fields.CompletedAt.String() != "2026-09-04" {
		t.Errorf("D-3 completed = %v, want 2026-09-04", rows[2].Fields.CompletedAt)
	}

	// D-4 (serial in a CSV), D-5 (blank required date), and D-6 (unlisted layout)
	// are row errors.
	want := map[int]string{5: "createdAt", 6: "createdAt", 7: "createdAt"}
	if len(problems) != 3 {
		t.Fatalf("problems = %+v", problems)
	}
	for _, p := range problems {
		if p.Kind != ProblemError || want[p.RowNum] != p.Field || p.Column != "Created" {
			t.Errorf("problem = %+v", p)
		}
	}
	if problems[0].Value != "46023" || problems[2].Value != "9/3/2026" {
		t.Errorf("problems should carry the raw value: %+v", problems)
	}
}

func TestNumbersInRows(t *testing.T) {
	tpl := miniTemplate(map[string]FieldMap{"planned": {Column: "Planned"}})
	var got []string
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "", "", "1,234"},
		[]string{"D-2", "Checkout", "Open", "2026-05-01", "", "", "$10k"},
		[]string{"D-3", "Checkout", "Open", "2026-05-01", "", "", "84%"},
		[]string{"D-4", "Checkout", "Open", "2026-05-01", "", "", "n/a"},
		[]string{"D-5", "Checkout", "Open", "2026-05-01", "", "", ""},
		[]string{"D-6", "Checkout", "Open", "2026-05-01", "", "", "1.2.3"},
	)
	rows, _, problems := Normalize(tpl, defectType, tbl)
	for _, r := range rows {
		if r.Fields.Planned == nil {
			got = append(got, r.ExternalID+"=nil")
		} else {
			got = append(got, r.ExternalID+"="+formatFloat(*r.Fields.Planned))
		}
	}
	want := []string{"D-1=1234", "D-2=10000", "D-3=84", "D-4=nil", "D-5=nil"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if len(problems) != 1 || problems[0].RowNum != 7 || problems[0].Field != "planned" || problems[0].Value != "1.2.3" {
		t.Fatalf("problems = %+v", problems)
	}
}

func formatFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func TestSkipRows(t *testing.T) {
	tpl := miniTemplate(nil)
	tpl.SkipRows = []SkipRule{
		{Column: "Priority", In: []string{"Sub-task", " wontfix "}},
		{Column: "Product", In: []string{"Test Harness"}},
		{Column: "No such column", In: []string{"x"}},
	}
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "", "High"},
		[]string{"D-2", "Checkout", "Open", "not a date", "", "sub-task"}, // skipped before validation
		[]string{"D-3", "Test Harness", "Open", "2026-05-01", "", ""},
		[]string{"D-4", "Checkout", "Open", "2026-05-01", "", "WontFix"},
	)
	rows, skipped, problems := Normalize(tpl, defectType, tbl)
	if skipped != 3 || len(rows) != 1 || rows[0].ExternalID != "D-1" || len(problems) != 0 {
		t.Fatalf("rows=%+v skipped=%d problems=%+v", rows, skipped, problems)
	}
}

func TestDuplicateIDsInFile(t *testing.T) {
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01"},
		[]string{"D-2", "Billing", "Open", "2026-05-01"},
		[]string{"D-1", "Billing", "Open", "2026-05-01"},
		[]string{"D-3", "Billing", "Open", "2026-05-01"},
		[]string{"D-1", "Analytics", "Open", "2026-05-01"},
	)
	rows, _, problems := Normalize(miniTemplate(nil), defectType, tbl)
	if len(rows) != 2 || rows[0].ExternalID != "D-2" || rows[1].ExternalID != "D-3" {
		t.Fatalf("rows = %+v; every row sharing an ID is excluded", rows)
	}
	if len(problems) != 3 {
		t.Fatalf("problems = %+v", problems)
	}
	for i, wantRow := range []int{2, 4, 6} {
		p := problems[i]
		if p.Kind != ProblemDuplicateID || p.RowNum != wantRow || p.Value != "D-1" || p.Field != "externalId" || p.Column != "Key" {
			t.Fatalf("problem %d = %+v", i, p)
		}
	}
	if !strings.Contains(problems[0].Message, "4") || !strings.Contains(problems[0].Message, "6") {
		t.Errorf("message %q should list the other rows", problems[0].Message)
	}

	// A duplicate that also has another problem still reports the duplicate.
	tbl = csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01"},
		[]string{"D-1", "Checkout", "Open", "bad date"},
	)
	rows, _, problems = Normalize(miniTemplate(nil), defectType, tbl)
	kinds := map[string]int{}
	for _, p := range problems {
		kinds[p.Kind]++
	}
	if len(rows) != 0 || kinds[ProblemDuplicateID] != 2 || kinds[ProblemError] != 1 {
		t.Fatalf("rows=%d kinds=%v", len(rows), kinds)
	}
}

func TestDoneNeedsCompletedAt(t *testing.T) {
	tpl := miniTemplate(nil)
	tbl := csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Done", "2026-05-01", ""},
		[]string{"D-2", "Checkout", "Cancelled", "2026-05-01", ""},
		[]string{"D-3", "Checkout", "Done", "2026-05-01", "2026-05-03"},
		[]string{"D-4", "Checkout", "Open", "2026-05-01", ""},
	)
	rows, _, problems := Normalize(tpl, defectType, tbl)
	if len(rows) != 2 || rows[0].ExternalID != "D-3" || rows[1].ExternalID != "D-4" {
		t.Fatalf("rows = %+v", rows)
	}
	if len(problems) != 2 {
		t.Fatalf("problems = %+v", problems)
	}
	for i, wantRow := range []int{2, 3} {
		p := problems[i]
		if p.Kind != ProblemError || p.RowNum != wantRow || p.Field != "completedAt" || p.Column != "Resolved" {
			t.Fatalf("problem %d = %+v", i, p)
		}
	}

	// With no completedAt mapping at all, a done row cannot be valid either.
	noCompleted := miniTemplate(nil)
	delete(noCompleted.Fields, "completedAt")
	_, _, problems = Normalize(noCompleted, defectType, csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Done", "2026-05-01", "2026-05-03"}))
	if len(problems) != 1 || problems[0].Field != "completedAt" {
		t.Fatalf("problems = %+v", problems)
	}

	// An unreadable completed date is one problem, not two.
	_, _, problems = Normalize(tpl, defectType, csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Done", "2026-05-01", "sometime"}))
	if len(problems) != 1 || problems[0].Value != "sometime" {
		t.Fatalf("problems = %+v", problems)
	}
}

func TestRequiredFieldsPerRow(t *testing.T) {
	tbl := csvTable(miniHeaders,
		[]string{"", "Checkout", "Open", "2026-05-01"},
		[]string{"D-2", "", "Open", "2026-05-01"},
		[]string{"D-3", "Checkout", "", "2026-05-01"},
		[]string{"D-4", "Checkout", "Open", ""},
	)
	rows, _, problems := Normalize(miniTemplate(nil), defectType, tbl)
	if len(rows) != 0 || len(problems) != 4 {
		t.Fatalf("rows=%d problems=%+v", len(rows), problems)
	}
	for i, field := range []string{"externalId", "subjectKey", "state", "createdAt"} {
		if problems[i].Field != field || problems[i].Kind != ProblemError || problems[i].RowNum != i+2 {
			t.Errorf("problem %d = %+v, want a %s error on row %d", i, problems[i], field, i+2)
		}
	}
}

func TestMissingRequiredColumn(t *testing.T) {
	tbl := csvTable([]string{"Key", "Status", "Created"},
		[]string{"D-1", "Open", "2026-05-01"})
	rows, _, problems := Normalize(miniTemplate(nil), defectType, tbl)
	if len(rows) != 0 || len(problems) != 1 {
		t.Fatalf("rows=%d problems=%+v", len(rows), problems)
	}
	p := problems[0]
	if p.RowNum != 0 || p.Kind != ProblemError || p.Column != "Product" || p.Field != "subjectKey" || !strings.Contains(p.Message, "Product") {
		t.Fatalf("problem = %+v", p)
	}

	// A missing optional column just leaves that field empty.
	tpl := miniTemplate(map[string]FieldMap{"title": {Column: "Summary"}, "dueAt": {Column: "Due date"}})
	tbl = csvTable([]string{"Key", "Product", "Status", "Created"}, []string{"D-1", "Checkout", "Open", "2026-05-01"})
	rows, _, problems = Normalize(tpl, defectType, tbl)
	if len(rows) != 1 || len(problems) != 0 || rows[0].Fields.Title != "" || rows[0].Fields.DueAt != nil {
		t.Fatalf("rows=%+v problems=%+v", rows, problems)
	}
}

func TestConstantsDefaultsAndTemplates(t *testing.T) {
	tpl := miniTemplate(map[string]FieldMap{
		"category": {Constant: "bug"},
		"title":    {Template: "{Key}: {Product} ({Priority})"},
		"url":      {Template: "https://tracker.example/browse/{Resolved}"},
		"status":   {Column: "Priority", Default: "Unknown"},
	})
	rows, _, problems := Normalize(tpl, defectType, csvTable(miniHeaders,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "", ""}))
	if len(problems) != 0 || len(rows) != 1 {
		t.Fatalf("problems = %+v", problems)
	}
	f := rows[0].Fields
	if f.Category != "bug" || f.Title != "D-1: Checkout ()" || f.Status != "Unknown" {
		t.Errorf("fields = %+v", f)
	}
	if f.URL != "" {
		t.Errorf("a template whose placeholders are all empty should be empty, got %q", f.URL)
	}
}

func TestAttributeTransforms(t *testing.T) {
	rt := domain.RecordType{ID: "defect", Name: "Defect", Priorities: []string{"P1"}, Attributes: []domain.AttributeDef{
		{Key: "withinBudget", Name: "Within budget", Type: domain.AttrBool},
		{Key: "severity", Name: "Severity", Type: domain.AttrNumber},
		{Key: "team", Name: "Team", Type: domain.AttrString},
		{Key: "reviewedAt", Name: "Reviewed", Type: domain.AttrDate},
	}}
	tpl := miniTemplate(nil)
	tpl.Attributes = map[string]FieldMap{
		"withinBudget": {Column: "Budget", Map: map[string]string{"On track": "yes", "Over": "no"}},
		"severity":     {Column: "Sev"},
		"team":         {Column: "Squad"},
		"reviewedAt":   {Column: "Reviewed"},
	}
	headers := []string{"Key", "Product", "Status", "Created", "Budget", "Sev", "Squad", "Reviewed"}
	rows, _, problems := Normalize(tpl, rt, csvTable(headers,
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "On track", "3", "Payments", "2026-06-01"},
		[]string{"D-2", "Checkout", "Open", "2026-05-01", "Over", "$1k", "", ""},
		[]string{"D-3", "Checkout", "Open", "2026-05-01", "", "", "", ""},
		[]string{"D-4", "Checkout", "Open", "2026-05-01", "Maybe", "", "", ""},
		[]string{"D-5", "Checkout", "Open", "2026-05-01", "", "lots", "", "never"},
	))
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3; problems = %+v", len(rows), problems)
	}
	a := rows[0].Fields.Attributes
	if a["withinBudget"] != true || a["severity"] != float64(3) || a["team"] != "Payments" || a["reviewedAt"] != day("2026-06-01") {
		t.Errorf("D-1 attributes = %#v", a)
	}
	if b := rows[1].Fields.Attributes; b["withinBudget"] != false || b["severity"] != float64(1000) || len(b) != 2 {
		t.Errorf("D-2 attributes = %#v", b)
	}
	if rows[2].Fields.Attributes != nil {
		t.Errorf("empty cells leave the attributes absent, got %#v", rows[2].Fields.Attributes)
	}

	var kinds []string
	for _, p := range problems {
		kinds = append(kinds, p.Kind+":"+p.Field)
	}
	want := []string{"error:reviewedAt", "error:severity"}
	if len(problems) != 3 || problems[0].Kind != ProblemUnmappedValue || problems[0].Value != "Maybe" ||
		!reflect.DeepEqual(kinds[1:], want) {
		t.Fatalf("problems = %v", kinds)
	}
}

func TestNonEmptyTransform(t *testing.T) {
	tpl := miniTemplate(nil)
	tpl.Attributes = map[string]FieldMap{"customerTicket": {Column: "Linked", Transform: "nonEmpty"}}
	rows, _, _ := Normalize(tpl, defectType, csvTable([]string{"Key", "Product", "Status", "Created", "Linked"},
		[]string{"D-1", "Checkout", "Open", "2026-05-01", "SUP-1"},
		[]string{"D-2", "Checkout", "Open", "2026-05-01", "  "},
	))
	if len(rows) != 2 || rows[0].Fields.Attributes["customerTicket"] != true || rows[1].Fields.Attributes["customerTicket"] != false {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestNonEmptyMissingColumnIsAbsent(t *testing.T) {
	headers := []string{"Key", "Product", "Status", "Created"} // no Linked tickets column
	tbl := csvTable(headers,
		[]string{"D-1", "Checkout", "Open", "2026-05-01"},
		[]string{"D-2", "Billing", "Open", "2026-05-02"},
	)

	t.Run("column", func(t *testing.T) {
		tpl := miniTemplate(nil)
		tpl.Attributes = map[string]FieldMap{"customerTicket": {Column: "Linked tickets", Transform: "nonEmpty"}}
		rows, _, problems := Normalize(tpl, defectType, tbl)
		if len(rows) != 2 || len(problems) != 0 {
			t.Fatalf("rows=%d problems=%+v; a missing optional column should not stop the file", len(rows), problems)
		}
		for _, r := range rows {
			if v, ok := r.Fields.Attributes["customerTicket"]; ok || r.Fields.Attributes != nil {
				t.Errorf("%s: customerTicket = %v (present=%v), want absent", r.ExternalID, v, ok)
			}
		}
	})

	t.Run("template", func(t *testing.T) {
		tpl := miniTemplate(nil)
		tpl.Attributes = map[string]FieldMap{"customerTicket": {Template: "{Linked tickets}{Escalation}", Transform: "nonEmpty"}}
		rows, _, _ := Normalize(tpl, defectType, tbl)
		if len(rows) != 2 || rows[0].Fields.Attributes != nil || rows[1].Fields.Attributes != nil {
			t.Fatalf("rows = %+v; a template with no placeholder column in the file is absent", rows)
		}
	})

	t.Run("template with one column present", func(t *testing.T) {
		tpl := miniTemplate(nil)
		tpl.Attributes = map[string]FieldMap{"customerTicket": {Template: "{Linked tickets}{Escalation}", Transform: "nonEmpty"}}
		rows, _, _ := Normalize(tpl, defectType, csvTable(append(headers, "Escalation"),
			[]string{"D-1", "Checkout", "Open", "2026-05-01", "ESC-1"},
			[]string{"D-2", "Billing", "Open", "2026-05-02", ""},
		))
		if len(rows) != 2 || rows[0].Fields.Attributes["customerTicket"] != true || rows[1].Fields.Attributes["customerTicket"] != false {
			t.Fatalf("rows = %+v; with a placeholder column present the answer is definite", rows)
		}
	})

	t.Run("column present but empty is still false", func(t *testing.T) {
		tpl := miniTemplate(nil)
		tpl.Attributes = map[string]FieldMap{"customerTicket": {Column: "Linked tickets", Transform: "nonEmpty"}}
		rows, _, _ := Normalize(tpl, defectType, csvTable(append(headers, "Linked tickets"),
			[]string{"D-1", "Checkout", "Open", "2026-05-01", ""}))
		if len(rows) != 1 || rows[0].Fields.Attributes["customerTicket"] != false {
			t.Fatalf("rows = %+v", rows)
		}
	})
}

func TestRowNumbersFallBack(t *testing.T) {
	// A table without RowNums numbers rows from 1.
	tbl := Table{Headers: miniHeaders, Format: "csv", Rows: [][]string{{"D-1", "Checkout", "Open", "2026-05-01", "", "", ""}}}
	rows, _, _ := Normalize(miniTemplate(nil), defectType, tbl)
	if len(rows) != 1 || rows[0].RowNum != 1 {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestMapLookupIgnoringCaseIsDeterministic(t *testing.T) {
	m := map[string]string{"HIGH": "P1", "High ": "P2", "high!": "P3", "*": "P4"}
	for range 50 {
		if v, ok := mapLookup(m, "high"); !ok || v != "P1" {
			t.Fatalf("mapLookup(high) = %q, %v; want P1 from the first key in sorted order", v, ok)
		}
	}
	if v, _ := mapLookup(m, "low"); v != "P4" {
		t.Errorf("fallback = %q, want P4", v)
	}
}
