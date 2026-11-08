package records

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"opsvision/internal/xlsx"
	"opsvision/internal/xlsx/xlsxtest"
)

var updateFixtures = flag.Bool("update", false, "regenerate testdata/epics_dec.xlsx")

func TestCSVDelimiterAndBOM(t *testing.T) {
	want := []string{"Issue key", "Summary", "Product"}
	for name, in := range map[string]string{
		"comma":             "Issue key,Summary,Product\nCHK-101,Refund rounds,Checkout\n",
		"semicolon":         "Issue key;Summary;Product\nCHK-101;Refund rounds;Checkout\n",
		"tab":               "Issue key\tSummary\tProduct\nCHK-101\tRefund rounds\tCheckout\n",
		"bom comma":         "\ufeffIssue key,Summary,Product\r\nCHK-101,Refund rounds,Checkout\r\n",
		"bom semicolon":     "\ufeffIssue key;Summary;Product\nCHK-101;Refund rounds;Checkout",
		"padded headers":    " Issue key ,Summary , Product\nCHK-101,Refund rounds,Checkout\n",
		"commas in quotes":  "Issue key;Summary;Product\nCHK-101;\"Refund, rounds\";Checkout\n",
		"quoted delimiters": "\"Issue key\";\"Summary\";\"Product\"\n\"CHK-101\";\"Refund rounds\";\"Checkout\"\n",
	} {
		t.Run(name, func(t *testing.T) {
			tbl, err := ReadCSV(strings.NewReader(in))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tbl.Headers, want) {
				t.Fatalf("headers = %q, want %q", tbl.Headers, want)
			}
			if len(tbl.Rows) != 1 || tbl.Rows[0][0] != "CHK-101" || tbl.Rows[0][2] != "Checkout" {
				t.Fatalf("rows = %q", tbl.Rows)
			}
			if tbl.Format != "csv" {
				t.Fatalf("format = %q, want csv", tbl.Format)
			}
		})
	}
}

func TestCSVRowShape(t *testing.T) {
	in := "A,B,C\n\n1,2\n  , ,\n4,5,6,7\n\"multi\nline\",x,y\n"
	tbl, err := ReadCSV(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	wantRows := [][]string{{"1", "2", ""}, {"4", "5", "6"}, {"multi\nline", "x", "y"}}
	if !reflect.DeepEqual(tbl.Rows, wantRows) {
		t.Fatalf("rows = %q, want %q", tbl.Rows, wantRows)
	}
	// Row numbers are the lines the rows start on; blank rows still count.
	if want := []int{3, 5, 6}; !reflect.DeepEqual(tbl.RowNums, want) {
		t.Fatalf("row numbers = %v, want %v", tbl.RowNums, want)
	}
}

func TestCSVHeaderRow(t *testing.T) {
	in := "Export of defects\nA;B\n1;2\n"
	tbl, err := ReadCSVHeader(strings.NewReader(in), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tbl.Headers, []string{"A", "B"}) || len(tbl.Rows) != 1 || tbl.RowNums[0] != 3 {
		t.Fatalf("got headers %q rows %q nums %v", tbl.Headers, tbl.Rows, tbl.RowNums)
	}
}

func TestCSVEmpty(t *testing.T) {
	for _, in := range []string{"", "\ufeff", "\n\n"} {
		if _, err := ReadCSV(strings.NewReader(in)); err == nil {
			t.Errorf("ReadCSV(%q): want an error for a file with no header", in)
		}
	}
}

func TestCSVLimits(t *testing.T) {
	cols := func(n int) string {
		h := make([]string, n)
		for i := range h {
			h[i] = "c"
		}
		return strings.Join(h, ",")
	}
	t.Run("500 columns ok", func(t *testing.T) {
		if _, err := ReadCSV(strings.NewReader(cols(MaxColumns) + "\n")); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("501 columns rejected", func(t *testing.T) {
		_, err := ReadCSV(strings.NewReader(cols(MaxColumns+1) + "\n"))
		if err == nil || !strings.Contains(err.Error(), "500") {
			t.Fatalf("want a column limit error naming 500, got %v", err)
		}
	})
	t.Run("a wide data row is rejected", func(t *testing.T) {
		_, err := ReadCSV(strings.NewReader("a,b\n" + cols(MaxColumns+1) + "\n"))
		if err == nil {
			t.Fatal("want a column limit error")
		}
	})

	rows := func(n int) string {
		var b strings.Builder
		b.WriteString("id\n")
		for i := 0; i < n; i++ {
			b.WriteString("x\n")
		}
		return b.String()
	}
	t.Run("200000 rows ok", func(t *testing.T) {
		tbl, err := ReadCSV(strings.NewReader(rows(MaxRows)))
		if err != nil || len(tbl.Rows) != MaxRows {
			t.Fatalf("rows = %d, err = %v", len(tbl.Rows), err)
		}
	})
	t.Run("200001 rows rejected", func(t *testing.T) {
		_, err := ReadCSV(strings.NewReader(rows(MaxRows + 1)))
		if err == nil || !strings.Contains(err.Error(), "200000") {
			t.Fatalf("want a row limit error naming 200000, got %v", err)
		}
	})

	t.Run("over 20 MiB rejected", func(t *testing.T) {
		big := "id\n" + strings.Repeat("x", MaxFileBytes)
		_, err := ReadCSV(strings.NewReader(big))
		if err == nil || !strings.Contains(err.Error(), "20 MiB") {
			t.Fatalf("want a size limit error naming 20 MiB, got %v", err)
		}
	})
}

// serialOf is the spreadsheet serial of a date after 1900-03-01.
func serialOf(s string) float64 {
	d := day(s)
	base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	return float64(int(d.Sub(base).Hours() / 24))
}

// epicsDecSheets is the content of testdata/epics_dec.xlsx: a December export
// with a title row above the headers and a blank row between epics.
func epicsDecSheets() []xlsxtest.Sheet {
	return []xlsxtest.Sheet{
		{Name: "Notes", Hidden: true, Rows: [][]any{{"Not the export"}}},
		{Name: "Epics", Rows: [][]any{
			{"Epic export - December 2026"},
			{"Epic key", "Epic name", "Product", "Status", "Created", "Due date", "Done date", "Planned spend"},
			{"CHK-9", "Saved payment methods", "Checkout", "Done", serialOf("2026-01-12"), serialOf("2026-12-15"), serialOf("2026-11-20"), 1200},
			{"BIL-4", "Usage-based invoicing", "Billing", "In Progress", serialOf("2026-02-03"), serialOf("2027-02-10"), nil, 240.5},
			{},
			{"ANL-7", "Saved report schedules", "Analytics", "To Do", serialOf("2026-03-18"), serialOf("2027-03-31"), nil, nil},
		}},
	}
}

func openEpicsDec(t *testing.T) *xlsx.Workbook {
	t.Helper()
	path := filepath.Join("testdata", "epics_dec.xlsx")
	if *updateFixtures {
		if err := os.WriteFile(path, xlsxtest.Build(t, epicsDecSheets()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (regenerate with go test ./internal/records -run TestReadSheetFixture -update)", err)
	}
	wb, err := xlsx.Open(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	return wb
}

func TestReadSheetFixture(t *testing.T) {
	wb := openEpicsDec(t)

	tbl, err := ReadSheet(wb, "Epics", 2)
	if err != nil {
		t.Fatal(err)
	}
	wantHeaders := []string{"Epic key", "Epic name", "Product", "Status", "Created", "Due date", "Done date", "Planned spend"}
	if !reflect.DeepEqual(tbl.Headers, wantHeaders) {
		t.Fatalf("headers = %q", tbl.Headers)
	}
	if tbl.Format != "xlsx" {
		t.Fatalf("format = %q, want xlsx", tbl.Format)
	}
	if len(tbl.Rows) != 3 {
		t.Fatalf("rows = %d, want 3 (the blank row is skipped)", len(tbl.Rows))
	}
	if want := []int{3, 4, 6}; !reflect.DeepEqual(tbl.RowNums, want) {
		t.Fatalf("row numbers = %v, want %v", tbl.RowNums, want)
	}
	if got := tbl.Rows[0]; got[0] != "CHK-9" || got[4] != "46034" || got[7] != "1200" {
		t.Fatalf("row 3 = %q", got)
	}
	if got := tbl.Rows[1]; got[6] != "" || got[7] != "240.5" {
		t.Fatalf("row 4 = %q", got)
	}
	for _, r := range tbl.Rows {
		if len(r) != len(tbl.Headers) {
			t.Fatalf("row %q is not padded to %d columns", r, len(tbl.Headers))
		}
	}

	// An empty sheet name means the first visible sheet, and names match any case.
	if byDefault, err := ReadSheet(wb, "", 2); err != nil || !reflect.DeepEqual(byDefault, tbl) {
		t.Fatalf("default sheet differs from Epics: %v", err)
	}
	if byCase, err := ReadSheet(wb, "epics", 2); err != nil || !reflect.DeepEqual(byCase, tbl) {
		t.Fatalf("case-insensitive sheet name: %v", err)
	}

	if _, err := ReadSheet(wb, "Missing", 2); err == nil || !strings.Contains(err.Error(), "Epics") {
		t.Fatalf("want an error listing the sheets, got %v", err)
	}
	if _, err := ReadSheet(wb, "Epics", 9); err == nil {
		t.Fatal("want an error when the header row is empty")
	}
}

func TestReadSheetNormalizesSerialDates(t *testing.T) {
	tbl, err := ReadSheet(openEpicsDec(t), "Epics", 2)
	if err != nil {
		t.Fatal(err)
	}
	tpl := Template{
		Name: "Epics", RecordType: "epic", Source: "tracker",
		File: FileSpec{Format: "xlsx", Sheet: "Epics", HeaderRow: 2},
		Fields: map[string]FieldMap{
			"externalId":  {Column: "Epic key"},
			"title":       {Column: "Epic name"},
			"subjectKey":  {Column: "Product"},
			"state":       {Column: "Status", Map: map[string]string{"Done": "done", "*": "open"}},
			"createdAt":   {Column: "Created"},
			"dueAt":       {Column: "Due date"},
			"completedAt": {Column: "Done date"},
			"planned":     {Column: "Planned spend"},
		},
	}
	rows, skipped, problems := Normalize(tpl, epicType, tbl)
	if len(problems) != 0 || skipped != 0 || len(rows) != 3 {
		t.Fatalf("rows=%d skipped=%d problems=%v", len(rows), skipped, problems)
	}
	first := rows[0]
	if first.Fields.CreatedAt.String() != "2026-01-12" || first.Fields.DueAt.String() != "2026-12-15" ||
		first.Fields.CompletedAt.String() != "2026-11-20" || *first.Fields.Planned != 1200 {
		t.Fatalf("first row = %+v", first.Fields)
	}
	if rows[1].RowNum != 4 || *rows[1].Fields.Planned != 240.5 || rows[2].RowNum != 6 || rows[2].Fields.Planned != nil {
		t.Fatalf("rows = %+v", rows)
	}

	// The same serial in a CSV is not a date.
	csvTbl := tbl
	csvTbl.Format = "csv"
	rows, _, problems = Normalize(tpl, epicType, csvTbl)
	if len(rows) != 0 || len(problems) == 0 {
		t.Fatalf("csv with serial dates: rows=%d problems=%v", len(rows), problems)
	}
}
