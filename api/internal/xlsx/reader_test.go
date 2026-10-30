package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"opsvision/internal/xlsx/xlsxtest"
)

// ---- helpers ---------------------------------------------------------------

type part struct{ name, body string }

func zipParts(t *testing.T, parts ...part) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, p := range parts {
		w, err := zw.Create(p.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, p.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const (
	xmlHdr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
	nsMain = `http://schemas.openxmlformats.org/spreadsheetml/2006/main`
	nsRel  = `http://schemas.openxmlformats.org/officeDocument/2006/relationships`
	nsPkg  = `http://schemas.openxmlformats.org/package/2006/relationships`
)

// workbookParts returns workbook.xml and its rels for one sheet named "S"
// whose relationship Target is target.
func workbookParts(target string) []part {
	return []part{
		{"xl/workbook.xml", xmlHdr + `<workbook xmlns="` + nsMain + `" xmlns:r="` + nsRel + `"><sheets>` +
			`<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", xmlHdr + `<Relationships xmlns="` + nsPkg + `">` +
			`<Relationship Id="rId1" Type="` + nsRel + `/worksheet" Target="` + target + `"/></Relationships>`},
	}
}

func sheetXML(sheetData string) string {
	return xmlHdr + `<worksheet xmlns="` + nsMain + `"><sheetData>` + sheetData + `</sheetData></worksheet>`
}

// minimal builds a one-sheet package; extra parts are appended.
func minimal(t *testing.T, sheetData string, extra ...part) []byte {
	t.Helper()
	parts := append(workbookParts("worksheets/sheet1.xml"), part{"xl/worksheets/sheet1.xml", sheetXML(sheetData)})
	return zipParts(t, append(parts, extra...)...)
}

func mustOpen(t *testing.T, b []byte) *Workbook {
	t.Helper()
	wb, err := Open(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return wb
}

func openErr(t *testing.T, b []byte) error {
	t.Helper()
	wb, err := Open(bytes.NewReader(b), int64(len(b)))
	if err == nil {
		t.Fatalf("expected error, got workbook with %d sheets", len(wb.Sheets))
	}
	return err
}

func mustContain(t *testing.T, err error, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !strings.Contains(err.Error(), s) {
			t.Errorf("error %q does not mention %q", err, s)
		}
	}
}

func cell(t *testing.T, s Sheet, ref string) Cell {
	t.Helper()
	c, ok := s.Cells[ref]
	if !ok {
		t.Fatalf("cell %s missing", ref)
	}
	return c
}

// ---- required tests --------------------------------------------------------

func TestReadsStringsAndNumbers(t *testing.T) {
	b := xlsxtest.Build(t, []xlsxtest.Sheet{{
		Name: "Metrics",
		Rows: [][]any{
			{"Metric", 0.9989, 46023, true, nil, 5},
			{"Metric", false},
		},
	}})
	wb := mustOpen(t, b)
	if len(wb.Sheets) != 1 || wb.Sheets[0].Name != "Metrics" || wb.Sheets[0].Hidden {
		t.Fatalf("unexpected sheets: %+v", wb.Sheets)
	}
	s := wb.Sheets[0]
	if c := cell(t, s, "A1"); c.Text != "Metric" || c.Number != nil || c.Ref != "A1" {
		t.Errorf("A1 = %+v", c)
	}
	if c := cell(t, s, "B1"); c.Text != "0.9989" || c.Number == nil || *c.Number != 0.9989 {
		t.Errorf("B1 = %+v", c)
	}
	if c := cell(t, s, "C1"); c.Text != "46023" || c.Number == nil || *c.Number != 46023 {
		t.Errorf("C1 = %+v", c)
	}
	if c := cell(t, s, "D1"); c.Text != "TRUE" || c.Number != nil {
		t.Errorf("D1 = %+v", c)
	}
	if _, ok := s.Cells["E1"]; ok {
		t.Errorf("empty cell E1 should not be present")
	}
	if c := cell(t, s, "F1"); c.Text != "5" || c.Number == nil || *c.Number != 5 {
		t.Errorf("F1 = %+v", c)
	}
	if c := cell(t, s, "B2"); c.Text != "FALSE" {
		t.Errorf("B2 = %+v", c)
	}
	if c := cell(t, s, "A2"); c.Text != "Metric" {
		t.Errorf("A2 = %+v", c)
	}
}

func TestHiddenSheets(t *testing.T) {
	b := xlsxtest.Build(t, []xlsxtest.Sheet{
		{Name: "Visible"}, {Name: "Secret", Hidden: true}, {Name: "Also Visible"},
	})
	wb := mustOpen(t, b)
	got := []bool{}
	for _, s := range wb.Sheets {
		got = append(got, s.Hidden)
	}
	if len(got) != 3 || got[0] || !got[1] || got[2] {
		t.Fatalf("hidden flags = %v", got)
	}
	if wb.Sheets[1].Name != "Secret" {
		t.Errorf("order not preserved: %+v", wb.Sheets)
	}
}

func TestVeryHiddenSheet(t *testing.T) {
	parts := workbookParts("worksheets/sheet1.xml")
	parts[0].body = strings.Replace(parts[0].body, `sheetId="1"`, `sheetId="1" state="veryHidden"`, 1)
	parts = append(parts, part{"xl/worksheets/sheet1.xml", sheetXML("")})
	wb := mustOpen(t, zipParts(t, parts...))
	if !wb.Sheets[0].Hidden {
		t.Fatal("veryHidden sheet should be Hidden")
	}
}

func TestThreadedCommentsWithAuthors(t *testing.T) {
	at := time.Date(2026, 1, 5, 14, 30, 0, 0, time.UTC)
	reply1 := time.Date(2026, 1, 6, 9, 0, 0, 0, time.UTC)
	b := xlsxtest.Build(t, []xlsxtest.Sheet{{
		Name: "S",
		Rows: [][]any{{"x", 1}},
		Comments: []xlsxtest.Comment{
			{Ref: "A1", Author: "Alice Example", Text: "Why is this low?", At: at, Replies: []xlsxtest.Comment{
				{Author: "Bob Example", Text: "Outage in March.", At: reply1},
				{Author: "Alice Example", Text: "Thanks."},
			}},
			{Ref: "B1", Author: "Carol Legacy", Text: "Old style note", LegacyOnly: true},
		},
	}})
	wb := mustOpen(t, b)
	cm := wb.Sheets[0].Comments

	a1 := cm["A1"]
	if len(a1) != 3 {
		t.Fatalf("A1 comments = %+v (legacy mirror must not be duplicated)", a1)
	}
	want := []struct{ author, text string }{
		{"Alice Example", "Why is this low?"}, {"Bob Example", "Outage in March."}, {"Alice Example", "Thanks."},
	}
	for i, w := range want {
		if a1[i].Author != w.author || a1[i].Text != w.text {
			t.Errorf("A1[%d] = %+v, want %+v", i, a1[i], w)
		}
	}
	if a1[0].At == nil || !a1[0].At.Equal(at) {
		t.Errorf("A1[0].At = %v, want %v", a1[0].At, at)
	}
	if a1[1].At == nil || !a1[1].At.Equal(reply1) {
		t.Errorf("A1[1].At = %v, want %v", a1[1].At, reply1)
	}
	if a1[2].At != nil {
		t.Errorf("A1[2].At = %v, want nil", a1[2].At)
	}

	b1 := cm["B1"]
	if len(b1) != 1 || b1[0].Author != "Carol Legacy" || b1[0].Text != "Old style note" || b1[0].At != nil {
		t.Errorf("B1 legacy = %+v", b1)
	}
}

func TestThreadedReplyOrderFollowsParent(t *testing.T) {
	// File order: root1, root2, reply-to-root1. Reply must follow root1.
	tc := xmlHdr + `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">` +
		`<threadedComment ref="A1" personId="p1" id="r1"><text>root1</text></threadedComment>` +
		`<threadedComment ref="A1" personId="p1" id="r2"><text>root2</text></threadedComment>` +
		`<threadedComment ref="A1" personId="p1" id="c1" parentId="r1"><text>reply</text></threadedComment>` +
		`</ThreadedComments>`
	persons := xmlHdr + `<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">` +
		`<person displayName="P One" id="p1" userId="u" providerId="None"/></personList>`
	rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `"><Relationship Id="rId1" ` +
		`Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="/xl/threadedComments/t1.xml"/></Relationships>`
	b := minimal(t, "",
		part{"xl/worksheets/_rels/sheet1.xml.rels", rels},
		part{"xl/threadedComments/t1.xml", tc},
		part{"xl/persons/person.xml", persons},
	)
	got := mustOpen(t, b).Sheets[0].Comments["A1"]
	var texts []string
	for _, c := range got {
		texts = append(texts, c.Text)
		if c.Author != "P One" {
			t.Errorf("author = %q", c.Author)
		}
	}
	if strings.Join(texts, ",") != "root1,reply,root2" {
		t.Fatalf("order = %v", texts)
	}
}

func TestSerialToDate(t *testing.T) {
	utc := func(y int, m time.Month, d, h, mi, s int) time.Time { return time.Date(y, m, d, h, mi, s, 0, time.UTC) }
	tests := []struct {
		serial float64
		want   time.Time
	}{
		{46023, utc(2026, 1, 1, 0, 0, 0)},
		{46023.5, utc(2026, 1, 1, 12, 0, 0)},
		{46023.75, utc(2026, 1, 1, 18, 0, 0)},
		{1, utc(1900, 1, 1, 0, 0, 0)},
		{59, utc(1900, 2, 28, 0, 0, 0)},
		{61, utc(1900, 3, 1, 0, 0, 0)},
		{25569, utc(1970, 1, 1, 0, 0, 0)},
	}
	for _, tc := range tests {
		got := SerialToDate(tc.serial)
		if !got.Equal(tc.want) || got.Location() != time.UTC {
			t.Errorf("SerialToDate(%v) = %v, want %v", tc.serial, got, tc.want)
		}
	}
	// Serial 60 is the fictitious 1900-02-29: it must not panic and must land
	// between serial 59 and serial 61.
	d60 := SerialToDate(60)
	if d60.Before(SerialToDate(59)) || d60.After(SerialToDate(61)) {
		t.Errorf("SerialToDate(60) = %v out of order", d60)
	}
}

func TestRejectsNonZip(t *testing.T) {
	b := []byte("this is definitely not a zip file")
	err := openErr(t, b)
	mustContain(t, err, "xlsx")
}

func TestRejectsOversizedPart(t *testing.T) {
	// Header-declared size over the limit: the part really is 21 MiB.
	pad := strings.Repeat(" ", 21<<20)
	big := xmlHdr + `<worksheet xmlns="` + nsMain + `"><sheetData>` + pad + `</sheetData></worksheet>`
	parts := append(workbookParts("worksheets/sheet1.xml"), part{"xl/worksheets/sheet1.xml", big})
	err := openErr(t, zipParts(t, parts...))
	mustContain(t, err, "MaxPartBytes", "xl/worksheets/sheet1.xml")
}

func TestRejectsPartWhoseHeaderUnderstatesSize(t *testing.T) {
	// A hostile archive claims a small size in its central directory while
	// the compressed stream inflates far beyond it.
	pad := strings.Repeat(" ", 21<<20)
	big := xmlHdr + `<worksheet xmlns="` + nsMain + `"><sheetData>` + pad + `</sheetData></worksheet>`
	parts := append(workbookParts("worksheets/sheet1.xml"), part{"xl/worksheets/sheet1.xml", big})
	b := zipParts(t, parts...)

	// Patch the central directory record of the sheet part: uncompressed
	// size lives at offset 24 of the PK\x01\x02 record.
	name := []byte("xl/worksheets/sheet1.xml")
	patched := false
	for i := 0; i+46 < len(b); i++ {
		if b[i] == 'P' && b[i+1] == 'K' && b[i+2] == 1 && b[i+3] == 2 {
			nlen := int(binary.LittleEndian.Uint16(b[i+28:]))
			if bytes.Equal(b[i+46:i+46+nlen], name) {
				binary.LittleEndian.PutUint32(b[i+24:], 1024)
				patched = true
			}
		}
	}
	if !patched {
		t.Fatal("central directory record not found")
	}
	err := openErr(t, b)
	mustContain(t, err, "xl/worksheets/sheet1.xml")
}

func TestReadLimitedStopsOnActualBytes(t *testing.T) {
	// An endless reader must be cut off by the limit regardless of headers.
	_, err := readLimited(endless{}, 1024, "xl/x.xml")
	if err == nil {
		t.Fatal("expected error")
	}
	mustContain(t, err, "MaxPartBytes", "xl/x.xml")

	got, err := readLimited(strings.NewReader("abc"), 1024, "p")
	if err != nil || string(got) != "abc" {
		t.Fatalf("got %q, %v", got, err)
	}
}

type endless struct{}

func (endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

// ---- additional tests ------------------------------------------------------

func TestRichTextSharedString(t *testing.T) {
	sst := xmlHdr + `<sst xmlns="` + nsMain + `"><si>` +
		`<r><rPr><b/></rPr><t>Hel</t></r>` +
		`<r><t xml:space="preserve">lo </t></r>` +
		`<r><t>World</t></r>` +
		`<rPh sb="0" eb="1"><t>PHONETIC</t></rPh>` +
		`<phoneticPr fontId="1"/></si>` +
		`<si><t>Plain</t><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si></sst>`
	rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `">` +
		`<Relationship Id="rId1" Type="` + nsRel + `/worksheet" Target="worksheets/sheet1.xml"/>` +
		`<Relationship Id="rId2" Type="` + nsRel + `/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
	parts := workbookParts("worksheets/sheet1.xml")
	parts[1].body = rels
	parts = append(parts,
		part{"xl/worksheets/sheet1.xml", sheetXML(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`)},
		part{"xl/sharedStrings.xml", sst})
	s := mustOpen(t, zipParts(t, parts...)).Sheets[0]
	if c := cell(t, s, "A1"); c.Text != "Hello World" {
		t.Errorf("A1 = %q", c.Text)
	}
	if c := cell(t, s, "B1"); c.Text != "Plain" {
		t.Errorf("B1 = %q", c.Text)
	}
}

func TestInlineStringErrorAndFormulaCells(t *testing.T) {
	data := `<row r="1">` +
		`<c r="A1" t="inlineStr"><is><t>inline</t></is></c>` +
		`<c r="B1" t="inlineStr"><is><r><t>ri</t></r><r><t>ch</t></r></is></c>` +
		`<c r="C1" t="e"><v>#N/A</v></c>` +
		`<c r="D1"><f>SUM(A2:A3)</f><v>42.5</v></c>` +
		`<c r="E1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>` +
		`<c r="F1" t="b"><v>1</v></c>` +
		`</row>`
	s := mustOpen(t, minimal(t, data)).Sheets[0]
	if c := cell(t, s, "A1"); c.Text != "inline" || c.Number != nil {
		t.Errorf("A1 = %+v", c)
	}
	if c := cell(t, s, "B1"); c.Text != "rich" {
		t.Errorf("B1 = %+v", c)
	}
	if c := cell(t, s, "C1"); c.Text != "#N/A" || c.Number != nil {
		t.Errorf("C1 = %+v", c)
	}
	if c := cell(t, s, "D1"); c.Formula != "SUM(A2:A3)" || c.Text != "42.5" || c.Number == nil || *c.Number != 42.5 {
		t.Errorf("D1 = %+v", c)
	}
	if c := cell(t, s, "E1"); c.Formula != `"a"&"b"` || c.Text != "ab" || c.Number != nil {
		t.Errorf("E1 = %+v", c)
	}
	if c := cell(t, s, "F1"); c.Text != "TRUE" {
		t.Errorf("F1 = %+v", c)
	}
}

func TestAbsoluteRelationshipTarget(t *testing.T) {
	parts := append(workbookParts("/xl/worksheets/sheet1.xml"),
		part{"xl/worksheets/sheet1.xml", sheetXML(`<row r="1"><c r="A1"><v>7</v></c></row>`)})
	s := mustOpen(t, zipParts(t, parts...)).Sheets[0]
	if c := cell(t, s, "A1"); c.Text != "7" {
		t.Errorf("A1 = %+v", c)
	}
}

func TestParentRelativeTargetIsResolved(t *testing.T) {
	// Real workbooks reference ../comments1.xml from xl/worksheets/_rels.
	cm := xmlHdr + `<comments xmlns="` + nsMain + `"><authors><author>Dana</author></authors><commentList>` +
		`<comment ref="A1" authorId="0"><text><r><t>note </t></r><r><t>text</t></r></text></comment>` +
		`<comment ref="A2" authorId="0"><text><t>[Threaded comment]

mirror</t></text></comment>` +
		`</commentList></comments>`
	rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `"><Relationship Id="rId1" Type="` + nsRel +
		`/comments" Target="../comments1.xml"/></Relationships>`
	b := minimal(t, "", part{"xl/worksheets/_rels/sheet1.xml.rels", rels}, part{"xl/comments1.xml", cm})
	got := mustOpen(t, b).Sheets[0].Comments
	if len(got["A1"]) != 1 || got["A1"][0].Text != "note text" || got["A1"][0].Author != "Dana" {
		t.Errorf("A1 = %+v", got["A1"])
	}
	if _, ok := got["A2"]; ok {
		t.Errorf("legacy mirror of threaded comment must be skipped: %+v", got["A2"])
	}
}

func TestRejectsDotDotPaths(t *testing.T) {
	t.Run("entry name", func(t *testing.T) {
		parts := append(workbookParts("worksheets/sheet1.xml"),
			part{"xl/worksheets/sheet1.xml", sheetXML("")},
			part{"xl/../evil.xml", "<x/>"})
		err := openErr(t, zipParts(t, parts...))
		mustContain(t, err, "..")
	})
	t.Run("target escaping package", func(t *testing.T) {
		parts := append(workbookParts("../../../etc/passwd"), part{"xl/worksheets/sheet1.xml", sheetXML("")})
		err := openErr(t, zipParts(t, parts...))
		mustContain(t, err, "..")
	})
}

func TestMalformedXMLNamesPart(t *testing.T) {
	parts := append(workbookParts("worksheets/sheet1.xml"),
		part{"xl/worksheets/sheet1.xml", xmlHdr + `<worksheet xmlns="` + nsMain + `"><sheetData><row r="1"><c r="A1"><v>1</v></c></sheetData>`})
	err := openErr(t, zipParts(t, parts...))
	mustContain(t, err, "xl/worksheets/sheet1.xml")

	parts = []part{
		{"xl/workbook.xml", `<workbook><sheets><sheet name="S" r:id=`},
	}
	err = openErr(t, zipParts(t, parts...))
	mustContain(t, err, "xl/workbook.xml")
}

func TestMissingWorkbookIsError(t *testing.T) {
	err := openErr(t, zipParts(t, part{"foo.txt", "hi"}))
	mustContain(t, err, "xl/workbook.xml")
}

func TestMissingRefAttributesInferred(t *testing.T) {
	data := `<row><c><v>1</v></c><c><v>2</v></c><c r="D1"><v>4</v></c><c><v>5</v></c></row>` +
		`<row r="5"><c><v>6</v></c></row>` +
		`<row><c><v>7</v></c><c r="C6"><v>8</v></c><c><v>9</v></c></row>`
	s := mustOpen(t, minimal(t, data)).Sheets[0]
	want := map[string]string{"A1": "1", "B1": "2", "D1": "4", "E1": "5", "A5": "6", "A6": "7", "C6": "8", "D6": "9"}
	if len(s.Cells) != len(want) {
		t.Errorf("cells = %v", s.Cells)
	}
	for ref, text := range want {
		if c := cell(t, s, ref); c.Text != text || c.Ref != ref {
			t.Errorf("%s = %+v, want text %s", ref, c, text)
		}
	}
}

func TestRejectsTooManySheets(t *testing.T) {
	var sheets []xlsxtest.Sheet
	for i := 0; i < MaxSheets+1; i++ {
		sheets = append(sheets, xlsxtest.Sheet{Name: "s" + strings.Repeat("x", i%5) + string(rune('a'+i%26)) + string(rune('a'+i/26%26))})
	}
	err := openErr(t, xlsxtest.Build(t, sheets))
	mustContain(t, err, "MaxSheets")

	ok := xlsxtest.Build(t, sheets[:MaxSheets])
	if got := len(mustOpen(t, ok).Sheets); got != MaxSheets {
		t.Errorf("sheets = %d", got)
	}
}

func TestRejectsTooManyCells(t *testing.T) {
	b := minimal(t, `<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>`)
	lim := defaultLimits
	lim.maxCells = 2
	_, err := openWithLimits(bytes.NewReader(b), int64(len(b)), lim)
	if err == nil {
		t.Fatal("expected error")
	}
	mustContain(t, err, "MaxCellsPerSheet")
}

func TestRejectsTotalBytesOverLimit(t *testing.T) {
	b := minimal(t, `<row r="1"><c r="A1"><v>1</v></c></row>`)
	lim := defaultLimits
	lim.maxTotal = 200
	_, err := openWithLimits(bytes.NewReader(b), int64(len(b)), lim)
	if err == nil {
		t.Fatal("expected error")
	}
	mustContain(t, err, "MaxTotalBytes")
}

func TestLimitConstants(t *testing.T) {
	if MaxPartBytes != 20<<20 || MaxTotalBytes != 200<<20 || MaxSheets != 200 || MaxCellsPerSheet != 2_000_000 ||
		MaxCellsPerWorkbook != 3_000_000 || MaxXMLDepth != 64 {
		t.Fatal("limit constants changed")
	}
}

func TestNumberTextIsPlainDecimal(t *testing.T) {
	data := `<row r="1"><c r="A1"><v>1234567</v></c><c r="B1"><v>0.9989</v></c>` +
		`<c r="C1"><v>1E+21</v></c><c r="D1"><v>1.5e-5</v></c><c r="E1"><v>-42.25</v></c></row>`
	s := mustOpen(t, minimal(t, data)).Sheets[0]
	want := map[string]string{
		"A1": "1234567", "B1": "0.9989", "C1": "1000000000000000000000", "D1": "0.000015", "E1": "-42.25",
	}
	for ref, text := range want {
		if c := cell(t, s, ref); c.Text != text || c.Number == nil {
			t.Errorf("%s = %+v, want text %q", ref, c, text)
		}
	}
}

func TestRejectsDeeplyNestedXML(t *testing.T) {
	deep := strings.Repeat("<a>", MaxXMLDepth+10) + strings.Repeat("</a>", MaxXMLDepth+10)
	t.Run("in sheet data", func(t *testing.T) {
		err := openErr(t, minimal(t, deep))
		mustContain(t, err, "xl/worksheets/sheet1.xml", "MaxXMLDepth")
	})
	t.Run("inside skipped cell child", func(t *testing.T) {
		err := openErr(t, minimal(t, `<row r="1"><c r="A1"><x>`+deep+`</x></c></row>`))
		mustContain(t, err, "xl/worksheets/sheet1.xml", "MaxXMLDepth")
	})
	t.Run("in shared strings", func(t *testing.T) {
		rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `">` +
			`<Relationship Id="rId1" Type="` + nsRel + `/worksheet" Target="worksheets/sheet1.xml"/>` +
			`<Relationship Id="rId2" Type="` + nsRel + `/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
		parts := workbookParts("worksheets/sheet1.xml")
		parts[1].body = rels
		parts = append(parts, part{"xl/worksheets/sheet1.xml", sheetXML("")},
			part{"xl/sharedStrings.xml", xmlHdr + `<sst xmlns="` + nsMain + `"><si>` + deep + `</si></sst>`})
		err := openErr(t, zipParts(t, parts...))
		mustContain(t, err, "xl/sharedStrings.xml", "MaxXMLDepth")
	})
	t.Run("at the limit is fine", func(t *testing.T) {
		// worksheet > sheetData occupy two levels.
		n := MaxXMLDepth - 2
		ok := strings.Repeat("<a>", n) + strings.Repeat("</a>", n)
		mustOpen(t, minimal(t, ok))
	})
}

func TestRejectsTooManyCellsPerWorkbook(t *testing.T) {
	b := xlsxtest.Build(t, []xlsxtest.Sheet{
		{Name: "A", Rows: [][]any{{1, 2}}},
		{Name: "B", Rows: [][]any{{3, 4}}},
	})
	lim := defaultLimits
	lim.maxWbCells = 3 // each sheet (2 cells) is under maxCells; the workbook (4) is over.
	_, err := openWithLimits(bytes.NewReader(b), int64(len(b)), lim)
	if err == nil {
		t.Fatal("expected error")
	}
	mustContain(t, err, "MaxCellsPerWorkbook")

	lim.maxWbCells = 4
	if _, err := openWithLimits(bytes.NewReader(b), int64(len(b)), lim); err != nil {
		t.Fatalf("at the limit should pass: %v", err)
	}
}

func TestCellRefsAreCanonicalised(t *testing.T) {
	data := `<row r="5"><c r="a5"><v>1</v></c><c r="aB5"><v>2</v></c><c r="XFD5"><v>3</v></c></row>` +
		`<row r="6"><c><v>4</v></c></row>`
	s := mustOpen(t, minimal(t, data)).Sheets[0]
	for ref, text := range map[string]string{"A5": "1", "AB5": "2", "XFD5": "3", "A6": "4"} {
		if c := cell(t, s, ref); c.Text != text || c.Ref != ref {
			t.Errorf("%s = %+v", ref, c)
		}
	}
	if _, ok := s.Cells["a5"]; ok || len(s.Cells) != 4 {
		t.Errorf("non-canonical keys present: %v", s.Cells)
	}
}

func TestCommentRefsAreCanonicalised(t *testing.T) {
	cm := xmlHdr + `<comments xmlns="` + nsMain + `"><authors><author>Dana</author></authors><commentList>` +
		`<comment ref="b2" authorId="0"><text><t>hi</t></text></comment></commentList></comments>`
	rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `"><Relationship Id="rId1" Type="` + nsRel +
		`/comments" Target="../comments1.xml"/></Relationships>`
	b := minimal(t, "", part{"xl/worksheets/_rels/sheet1.xml.rels", rels}, part{"xl/comments1.xml", cm})
	got := mustOpen(t, b).Sheets[0].Comments
	if len(got["B2"]) != 1 || len(got) != 1 {
		t.Errorf("comments = %+v", got)
	}
}

func TestRejectsInvalidCellRefs(t *testing.T) {
	refs := []string{
		"A+5", "A05", "A0", "+A5", "A-5", "5A", "A", "5", "A5 ", "A 5", "XFE1", "ZZZZZZZZZZZZZZZZ1",
		"A1048577", "A99999999999999999999", "A1.5", "$A$1",
	}
	for _, ref := range refs {
		t.Run(ref, func(t *testing.T) {
			err := openErr(t, minimal(t, `<row r="1"><c r="`+ref+`"><v>1</v></c></row>`))
			mustContain(t, err, "xl/worksheets/sheet1.xml", "invalid cell reference")
		})
	}
	for _, r := range []string{"+5", "05", "0", "-1", "1048577", "x", "99999999999999999999"} {
		t.Run("row "+r, func(t *testing.T) {
			err := openErr(t, minimal(t, `<row r="`+r+`"><c><v>1</v></c></row>`))
			mustContain(t, err, "xl/worksheets/sheet1.xml", "invalid row number")
		})
	}
}

func TestRejectsOutOfRangeSharedStringIndex(t *testing.T) {
	for _, idx := range []string{"0", "5", "-1", "x", ""} {
		t.Run("idx "+idx, func(t *testing.T) {
			// No sharedStrings part at all, so every index is out of range.
			err := openErr(t, minimal(t, `<row r="1"><c r="A1" t="s"><v>`+idx+`</v></c></row>`))
			mustContain(t, err, "xl/worksheets/sheet1.xml", "shared string index")
		})
	}
}

func TestThreadedCommentZonelessAndBadTimestamps(t *testing.T) {
	tc := xmlHdr + `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">` +
		`<threadedComment ref="A1" dT="2026-01-05T14:30:00.00" personId="p1" id="a"><text>zoneless</text></threadedComment>` +
		`<threadedComment ref="A1" dT="2026-01-05T14:30:00+02:00" personId="p1" id="b"><text>zoned</text></threadedComment>` +
		`<threadedComment ref="A1" dT="not a time" personId="p1" id="c"><text>bad</text></threadedComment>` +
		`</ThreadedComments>`
	rels := xmlHdr + `<Relationships xmlns="` + nsPkg + `"><Relationship Id="rId1" ` +
		`Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/t1.xml"/></Relationships>`
	b := minimal(t, "", part{"xl/worksheets/_rels/sheet1.xml.rels", rels}, part{"xl/threadedComments/t1.xml", tc})
	got := mustOpen(t, b).Sheets[0].Comments["A1"]
	if len(got) != 3 {
		t.Fatalf("comments = %+v", got)
	}
	if want := time.Date(2026, 1, 5, 14, 30, 0, 0, time.UTC); got[0].At == nil || !got[0].At.Equal(want) {
		t.Errorf("zoneless At = %v, want %v UTC", got[0].At, want)
	}
	if want := time.Date(2026, 1, 5, 12, 30, 0, 0, time.UTC); got[1].At == nil || !got[1].At.Equal(want) {
		t.Errorf("zoned At = %v, want %v", got[1].At, want)
	}
	if got[2].At != nil {
		t.Errorf("bad dT should give nil At, got %v", got[2].At)
	}
}

// TestReadsRealWorkbook is an opt-in smoke test against a private local file.
// It asserts only structural facts and never logs or asserts content.
func TestReadsRealWorkbook(t *testing.T) {
	path := os.Getenv("OPSVISION_REAL_WORKBOOK")
	if path == "" {
		t.Skip("OPSVISION_REAL_WORKBOOK not set")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open workbook: %v", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	wb, err := Open(f, st.Size())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(wb.Sheets) < 1 {
		t.Fatal("expected at least one sheet")
	}
	hidden, comments := 0, 0
	for _, s := range wb.Sheets {
		if s.Hidden {
			hidden++
		}
		for _, cs := range s.Comments {
			comments += len(cs)
		}
	}
	t.Logf("sheets=%d hidden=%d comments=%d", len(wb.Sheets), hidden, comments)
}
