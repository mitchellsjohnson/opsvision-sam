// Package xlsxtest builds minimal, valid .xlsx packages for tests of the
// xlsx reader. It is test support only and is not meant for production use.
package xlsxtest

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Sheet describes one worksheet to write.
type Sheet struct {
	Name   string
	Hidden bool
	// Rows holds cell values: string, float64, int, bool or nil (empty cell).
	Rows     [][]any
	Comments []Comment
}

// Comment is a comment anchored to a cell. By default it is written as a
// threaded comment (plus the legacy mirror Excel writes alongside it).
// Replies are written as threaded replies to this comment.
type Comment struct {
	Ref    string
	Author string
	Text   string
	At     time.Time
	// LegacyOnly writes only a classic comments part entry (no threaded
	// comment, no person). Replies are ignored for legacy-only comments.
	LegacyOnly bool
	Replies    []Comment
}

const (
	nsMain = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
	nsRel  = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
	nsPkg  = "http://schemas.openxmlformats.org/package/2006/relationships"
	nsTC   = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
	relTC  = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
	relPer = "http://schemas.microsoft.com/office/2017/10/relationships/person"
	relCmt = nsRel + "/comments"
)

// Build returns the bytes of a minimal valid .xlsx containing sheets.
func Build(t *testing.T, sheets []Sheet) []byte {
	t.Helper()
	parts := newParts()

	// Shared strings, de-duplicated in first-use order.
	var sst []string
	sstIdx := map[string]int{}
	intern := func(s string) int {
		if i, ok := sstIdx[s]; ok {
			return i
		}
		sstIdx[s] = len(sst)
		sst = append(sst, s)
		return len(sst) - 1
	}

	persons := map[string]string{} // author -> person id
	var personOrder []string
	personID := func(author string) string {
		if id, ok := persons[author]; ok {
			return id
		}
		id := fmt.Sprintf("{00000000-0000-0000-0000-%012d}", len(persons)+1)
		persons[author] = id
		personOrder = append(personOrder, author)
		return id
	}

	ct := &strings.Builder{}
	ct.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		`<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`)

	wb := &strings.Builder{}
	wb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<workbook xmlns="` + nsMain + `" xmlns:r="` + nsRel + `"><sheets>`)
	wbRels := &strings.Builder{}
	wbRels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="` + nsPkg + `">`)

	threadedN, legacyN := 0, 0
	for i, sh := range sheets {
		n := i + 1
		state := ""
		if sh.Hidden {
			state = ` state="hidden"`
		}
		fmt.Fprintf(wb, `<sheet name="%s" sheetId="%d"%s r:id="rId%d"/>`, esc(sh.Name), n, state, n)
		fmt.Fprintf(wbRels, `<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>`, n, nsRel, n)
		fmt.Fprintf(ct, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, n)

		// Sheet XML.
		sx := &strings.Builder{}
		sx.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<worksheet xmlns="` + nsMain + `"><sheetData>`)
		for ri, row := range sh.Rows {
			fmt.Fprintf(sx, `<row r="%d">`, ri+1)
			for ci, v := range row {
				ref := colName(ci) + strconv.Itoa(ri+1)
				switch x := v.(type) {
				case nil:
				case string:
					fmt.Fprintf(sx, `<c r="%s" t="s"><v>%d</v></c>`, ref, intern(x))
				case float64:
					fmt.Fprintf(sx, `<c r="%s"><v>%s</v></c>`, ref, strconv.FormatFloat(x, 'g', -1, 64))
				case int:
					fmt.Fprintf(sx, `<c r="%s"><v>%d</v></c>`, ref, x)
				case bool:
					b := 0
					if x {
						b = 1
					}
					fmt.Fprintf(sx, `<c r="%s" t="b"><v>%d</v></c>`, ref, b)
				default:
					t.Fatalf("xlsxtest: unsupported cell type %T at %s", v, ref)
				}
			}
			sx.WriteString(`</row>`)
		}
		sx.WriteString(`</sheetData></worksheet>`)
		parts.add(fmt.Sprintf("xl/worksheets/sheet%d.xml", n), sx.String())

		// Comments + per-sheet rels.
		if len(sh.Comments) == 0 {
			continue
		}
		var threaded, legacy []comment
		for _, c := range sh.Comments {
			if c.LegacyOnly {
				legacy = append(legacy, comment{c: c})
				continue
			}
			threadedN++
			id := fmt.Sprintf("{10000000-0000-0000-0000-%012d}", threadedN)
			threaded = append(threaded, comment{c: c, id: id})
			legacy = append(legacy, comment{c: c, mirror: true})
			for _, r := range c.Replies {
				threadedN++
				rid := fmt.Sprintf("{10000000-0000-0000-0000-%012d}", threadedN)
				r.Ref = c.Ref
				threaded = append(threaded, comment{c: r, id: rid, parent: id})
			}
		}
		rels := &strings.Builder{}
		rels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Relationships xmlns="` + nsPkg + `">`)
		if len(legacy) > 0 {
			legacyN++
			name := fmt.Sprintf("comments%d.xml", legacyN)
			parts.add("xl/"+name, legacyXML(legacy))
			fmt.Fprintf(rels, `<Relationship Id="rId1" Type="%s" Target="../%s"/>`, relCmt, name)
			fmt.Fprintf(ct, `<Override PartName="/xl/%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`, name)
		}
		if len(threaded) > 0 {
			name := fmt.Sprintf("threadedComment%d.xml", n)
			parts.add("xl/threadedComments/"+name, threadedXML(threaded, personID))
			fmt.Fprintf(rels, `<Relationship Id="rId2" Type="%s" Target="../threadedComments/%s"/>`, relTC, name)
			fmt.Fprintf(ct, `<Override PartName="/xl/threadedComments/%s" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>`, name)
		}
		rels.WriteString(`</Relationships>`)
		parts.add(fmt.Sprintf("xl/worksheets/_rels/sheet%d.xml.rels", n), rels.String())
	}
	wb.WriteString(`</sheets></workbook>`)

	// Persons part, referenced from the workbook rels.
	next := len(sheets) + 1
	if len(personOrder) > 0 {
		px := &strings.Builder{}
		px.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<personList xmlns="` + nsTC + `">`)
		for _, a := range personOrder {
			fmt.Fprintf(px, `<person displayName="%s" id="%s" userId="%s" providerId="None"/>`, esc(a), persons[a], esc(a))
		}
		px.WriteString(`</personList>`)
		parts.add("xl/persons/person.xml", px.String())
		fmt.Fprintf(wbRels, `<Relationship Id="rId%d" Type="%s" Target="persons/person.xml"/>`, next, relPer)
		fmt.Fprintf(ct, `<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>`)
		next++
	}
	fmt.Fprintf(wbRels, `<Relationship Id="rId%d" Type="%s/sharedStrings" Target="sharedStrings.xml"/>`, next, nsRel)
	wbRels.WriteString(`</Relationships>`)
	ct.WriteString(`</Types>`)

	ss := &strings.Builder{}
	fmt.Fprintf(ss, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<sst xmlns="%s" count="%d" uniqueCount="%d">`, nsMain, len(sst), len(sst))
	for _, s := range sst {
		fmt.Fprintf(ss, `<si>%s</si>`, tElem(s))
	}
	ss.WriteString(`</sst>`)

	root := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="` + nsPkg + `">` +
		`<Relationship Id="rId1" Type="` + nsRel + `/officeDocument" Target="xl/workbook.xml"/></Relationships>`

	// Content types must be first in the archive.
	out := newParts()
	out.add("[Content_Types].xml", ct.String())
	out.add("_rels/.rels", root)
	out.add("xl/workbook.xml", wb.String())
	out.add("xl/_rels/workbook.xml.rels", wbRels.String())
	out.add("xl/sharedStrings.xml", ss.String())
	out.names = append(out.names, parts.names...)
	for k, v := range parts.data {
		out.data[k] = v
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range out.names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("xlsxtest: create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(out.data[name])); err != nil {
			t.Fatalf("xlsxtest: write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("xlsxtest: close zip: %v", err)
	}
	return buf.Bytes()
}

type parts struct {
	names []string
	data  map[string]string
}

func newParts() *parts { return &parts{data: map[string]string{}} }

func (p *parts) add(name, content string) {
	p.names = append(p.names, name)
	p.data[name] = content
}

type comment struct {
	c      Comment
	id     string
	parent string
	mirror bool
}

func legacyXML(cs []comment) string {
	var authors []string
	idx := map[string]int{}
	for _, c := range cs {
		if _, ok := idx[c.c.Author]; !ok {
			idx[c.c.Author] = len(authors)
			authors = append(authors, c.c.Author)
		}
	}
	b := &strings.Builder{}
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="` + nsMain + `"><authors>`)
	for _, a := range authors {
		fmt.Fprintf(b, `<author>%s</author>`, esc(a))
	}
	b.WriteString(`</authors><commentList>`)
	for _, c := range cs {
		text := c.c.Text
		if c.mirror {
			text = "[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; " +
				"however, any edits to it will get removed if the file is opened in a newer version of Excel.\n\nComment:\n    " + c.c.Text
		}
		fmt.Fprintf(b, `<comment ref="%s" authorId="%d"><text><r><rPr><sz val="9"/></rPr>%s</r></text></comment>`,
			esc(c.c.Ref), idx[c.c.Author], tElem(text))
	}
	b.WriteString(`</commentList></comments>`)
	return b.String()
}

func threadedXML(cs []comment, personID func(string) string) string {
	b := &strings.Builder{}
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ThreadedComments xmlns="` + nsTC + `">`)
	for _, c := range cs {
		dt := ""
		if !c.c.At.IsZero() {
			dt = ` dT="` + c.c.At.UTC().Format(time.RFC3339) + `"`
		}
		parent := ""
		if c.parent != "" {
			parent = ` parentId="` + c.parent + `"`
		}
		fmt.Fprintf(b, `<threadedComment ref="%s"%s personId="%s" id="%s"%s><text>%s</text></threadedComment>`,
			esc(c.c.Ref), dt, personID(c.c.Author), c.id, parent, esc(c.c.Text))
	}
	b.WriteString(`</ThreadedComments>`)
	return b.String()
}

// tElem renders a <t> element, preserving surrounding whitespace.
func tElem(s string) string {
	return `<t xml:space="preserve">` + esc(s) + `</t>`
}

func esc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// colName converts a zero-based column index to letters (0 -> A, 26 -> AA).
func colName(i int) string {
	s := ""
	for i++; i > 0; i = (i - 1) / 26 {
		s = string(rune('A'+(i-1)%26)) + s
	}
	return s
}
