// Package xlsx is a minimal, read-only .xlsx reader built on archive/zip and
// encoding/xml. It exists for the legacy-workbook importer: it extracts sheet
// names, hidden flags, cell values and formulas, and cell comments (legacy and
// threaded). It does not interpret styles, so dates arrive as serial numbers;
// use SerialToDate to convert them.
//
// Uploaded workbooks are untrusted. Open enforces hard limits (see the Max*
// constants) on part size, total bytes read, sheet count and cells per sheet,
// rejects path traversal, and only ever reads parts it needs.
package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"strconv"
	"strings"
	"time"
)

// Hard limits applied to every workbook opened with Open.
const (
	// MaxPartBytes is the maximum uncompressed size of any single package part.
	MaxPartBytes = 20 << 20
	// MaxTotalBytes is the maximum uncompressed bytes read across all parts.
	MaxTotalBytes = 200 << 20
	// MaxSheets is the maximum number of sheets in a workbook.
	MaxSheets = 200
	// MaxCellsPerSheet is the maximum number of <c> elements in one sheet.
	MaxCellsPerSheet = 2_000_000
	// MaxCellsPerWorkbook is the maximum number of <c> elements across all
	// sheets of a workbook.
	MaxCellsPerWorkbook = 3_000_000
	// MaxXMLDepth is the maximum element nesting depth in any XML part. Real
	// OOXML nests fewer than ~15 levels.
	MaxXMLDepth = 64
)

// Workbook is the parsed content of an .xlsx file.
type Workbook struct {
	Sheets []Sheet
}

// Sheet is one worksheet. Cells and Comments are keyed by A1-style reference.
// Cells that carry neither a value nor a formula are omitted.
type Sheet struct {
	Name     string
	Hidden   bool // state is hidden or veryHidden
	Cells    map[string]Cell
	Comments map[string][]Comment
}

// Cell is a single cell. Text is always set: shared/inline/formula strings
// verbatim, numbers in shortest plain decimal form (no exponent), booleans as TRUE/FALSE, and
// errors (e.g. #N/A) as their text. Number is non-nil only for numeric cells.
// Formula holds the formula text (without a leading '='), if any; Text/Number
// are the cached result.
type Cell struct {
	Ref     string
	Text    string
	Number  *float64
	Formula string
}

// Comment is one comment on a cell. For threaded comments, replies follow
// their parent. At is nil when the source carries no timestamp (legacy).
type Comment struct {
	Author string
	Text   string
	At     *time.Time
}

type limits struct {
	maxPart, maxTotal int64
	maxSheets         int
	maxCells          int
	maxWbCells        int
}

var defaultLimits = limits{
	maxPart:    MaxPartBytes,
	maxTotal:   MaxTotalBytes,
	maxSheets:  MaxSheets,
	maxCells:   MaxCellsPerSheet,
	maxWbCells: MaxCellsPerWorkbook,
}

// Open reads the workbook in r (an .xlsx zip of the given size).
func Open(r io.ReaderAt, size int64) (*Workbook, error) {
	return openWithLimits(r, size, defaultLimits)
}

func openWithLimits(r io.ReaderAt, size int64, lim limits) (*Workbook, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("xlsx: not a valid zip archive: %w", err)
	}
	p := &pkg{files: make(map[string]*zip.File, len(zr.File)), lim: lim}
	for _, f := range zr.File {
		if strings.Contains(f.Name, "..") {
			return nil, fmt.Errorf("xlsx: archive entry %q contains '..'", f.Name)
		}
		if _, dup := p.files[f.Name]; dup {
			return nil, fmt.Errorf("xlsx: duplicate archive entry %q", f.Name)
		}
		p.files[f.Name] = f
	}

	const wbPath = "xl/workbook.xml"
	wbData, err := p.read(wbPath)
	if err != nil {
		return nil, err
	}
	sheetRefs, err := parseWorkbook(wbPath, wbData, lim.maxSheets)
	if err != nil {
		return nil, err
	}
	wbRels, err := p.rels(wbPath)
	if err != nil {
		return nil, err
	}

	sst, err := p.sharedStrings(wbRels)
	if err != nil {
		return nil, err
	}
	persons, err := p.persons(wbRels)
	if err != nil {
		return nil, err
	}

	wb := &Workbook{Sheets: make([]Sheet, 0, len(sheetRefs))}
	wbCells := 0
	for i, sr := range sheetRefs {
		rel, ok := wbRels.byID[sr.rid]
		if !ok || rel.external {
			return nil, fmt.Errorf("xlsx: sheet #%d has no usable relationship %q in %s", i+1, sr.rid, wbPath)
		}
		sheetPath, err := resolveTarget("xl", rel.target)
		if err != nil {
			return nil, err
		}
		sh := Sheet{
			Name:     sr.name,
			Hidden:   sr.state == "hidden" || sr.state == "veryHidden",
			Cells:    map[string]Cell{},
			Comments: map[string][]Comment{},
		}
		if strings.HasSuffix(rel.typ, "/worksheet") {
			data, err := p.read(sheetPath)
			if err != nil {
				return nil, err
			}
			sh.Cells, err = parseSheet(sheetPath, data, sst, lim.maxCells, &wbCells, lim.maxWbCells)
			if err != nil {
				return nil, err
			}
			sh.Comments, err = p.comments(sheetPath, persons)
			if err != nil {
				return nil, err
			}
		}
		wb.Sheets = append(wb.Sheets, sh)
	}
	return wb, nil
}

// ---- package access --------------------------------------------------------

type pkg struct {
	files map[string]*zip.File
	lim   limits
	total int64
}

// read returns the uncompressed bytes of the named part, enforcing the part
// and total limits against both the declared and the actual size.
func (p *pkg) read(name string) ([]byte, error) {
	f, ok := p.files[name]
	if !ok {
		return nil, fmt.Errorf("xlsx: required part %q is missing", name)
	}
	if f.UncompressedSize64 > uint64(p.lim.maxPart) {
		return nil, fmt.Errorf("xlsx: part %q declares %d bytes, exceeding MaxPartBytes (%d)",
			name, f.UncompressedSize64, p.lim.maxPart)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("xlsx: open part %q: %w", name, err)
	}
	defer rc.Close()
	data, err := readLimited(rc, p.lim.maxPart, name)
	if err != nil {
		return nil, err
	}
	p.total += int64(len(data))
	if p.total > p.lim.maxTotal {
		return nil, fmt.Errorf("xlsx: reading part %q exceeds MaxTotalBytes (%d)", name, p.lim.maxTotal)
	}
	return data, nil
}

func (p *pkg) has(name string) bool { _, ok := p.files[name]; return ok }

// readLimited reads at most limit bytes from r and fails if there is more.
func readLimited(r io.Reader, limit int64, name string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, fmt.Errorf("xlsx: read part %q: %w", name, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("xlsx: part %q exceeds MaxPartBytes (%d)", name, limit)
	}
	return data, nil
}

type relationship struct {
	typ, target string
	external    bool
}

type relSet struct {
	byID  map[string]relationship
	order []relationship
}

func (rs relSet) ofType(suffix string) []relationship {
	var out []relationship
	for _, r := range rs.order {
		if !r.external && strings.HasSuffix(r.typ, suffix) {
			out = append(out, r)
		}
	}
	return out
}

// rels loads the relationships of a part; a missing .rels part yields an
// empty set.
func (p *pkg) rels(partPath string) (relSet, error) {
	dir, base := path.Split(partPath)
	name := dir + "_rels/" + base + ".rels"
	rs := relSet{byID: map[string]relationship{}}
	if !p.has(name) {
		return rs, nil
	}
	data, err := p.read(name)
	if err != nil {
		return rs, err
	}
	dec := newDecoder(data)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return rs, nil
		}
		if err != nil {
			return rs, parseErr(name, err)
		}
		if se, ok := tok.(startElement); ok && se.Name.Local == "Relationship" {
			a := attrs(se)
			rel := relationship{typ: a["Type"], target: a["Target"], external: a["TargetMode"] == "External"}
			rs.byID[a["Id"]] = rel
			rs.order = append(rs.order, rel)
		}
	}
}

// resolveTarget resolves a relationship target against the directory of the
// source part. Absolute targets are rooted at the package. Targets that would
// leave the package (via '..') are rejected.
func resolveTarget(baseDir, target string) (string, error) {
	if target == "" {
		return "", errors.New("xlsx: empty relationship target")
	}
	var p string
	if strings.HasPrefix(target, "/") {
		if strings.Contains(target, "..") {
			return "", fmt.Errorf("xlsx: relationship target %q contains '..'", target)
		}
		p = path.Clean(strings.TrimPrefix(target, "/"))
	} else {
		p = path.Join(baseDir, target)
	}
	if p == ".." || strings.HasPrefix(p, "../") || p == "." || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("xlsx: relationship target %q escapes the package ('..')", target)
	}
	return p, nil
}

func (p *pkg) sharedStrings(wbRels relSet) ([]string, error) {
	name := "xl/sharedStrings.xml"
	if rs := wbRels.ofType("/sharedStrings"); len(rs) > 0 {
		var err error
		if name, err = resolveTarget("xl", rs[0].target); err != nil {
			return nil, err
		}
	}
	if !p.has(name) {
		return nil, nil
	}
	data, err := p.read(name)
	if err != nil {
		return nil, err
	}
	return parseSharedStrings(name, data)
}

func (p *pkg) persons(wbRels relSet) (map[string]string, error) {
	name := "xl/persons/person.xml"
	if rs := wbRels.ofType("/person"); len(rs) > 0 {
		var err error
		if name, err = resolveTarget("xl", rs[0].target); err != nil {
			return nil, err
		}
	}
	out := map[string]string{}
	if !p.has(name) {
		return out, nil
	}
	data, err := p.read(name)
	if err != nil {
		return nil, err
	}
	dec := newDecoder(data)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		if se, ok := tok.(startElement); ok && se.Name.Local == "person" {
			a := attrs(se)
			out[a["id"]] = a["displayName"]
		}
	}
}

// ---- comments --------------------------------------------------------------

const threadedMirrorPrefix = "[Threaded comment]"

func (p *pkg) comments(sheetPath string, persons map[string]string) (map[string][]Comment, error) {
	out := map[string][]Comment{}
	rs, err := p.rels(sheetPath)
	if err != nil {
		return nil, err
	}
	dir := path.Dir(sheetPath)

	// Threaded comments take precedence per cell.
	for _, rel := range rs.ofType("/threadedComment") {
		name, err := resolveTarget(dir, rel.target)
		if err != nil {
			return nil, err
		}
		if !p.has(name) {
			continue
		}
		data, err := p.read(name)
		if err != nil {
			return nil, err
		}
		tcs, err := parseThreaded(name, data, persons)
		if err != nil {
			return nil, err
		}
		for ref, list := range tcs {
			out[ref] = append(out[ref], list...)
		}
	}

	for _, rel := range rs.ofType("/comments") {
		name, err := resolveTarget(dir, rel.target)
		if err != nil {
			return nil, err
		}
		if !p.has(name) {
			continue
		}
		data, err := p.read(name)
		if err != nil {
			return nil, err
		}
		legacy, err := parseLegacyComments(name, data)
		if err != nil {
			return nil, err
		}
		threadedRefs := map[string]bool{}
		for ref := range out {
			threadedRefs[ref] = true
		}
		for _, lc := range legacy {
			if threadedRefs[lc.ref] || strings.HasPrefix(lc.c.Text, threadedMirrorPrefix) {
				continue
			}
			out[lc.ref] = append(out[lc.ref], lc.c)
		}
	}
	return out, nil
}

type refComment struct {
	ref string
	c   Comment
}

func parseLegacyComments(name string, data []byte) ([]refComment, error) {
	dec := newDecoder(data)
	var authors []string
	var out []refComment
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		se, ok := tok.(startElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "author":
			s, err := plainText(dec)
			if err != nil {
				return nil, parseErr(name, err)
			}
			authors = append(authors, s)
		case "comment":
			a := attrs(se)
			text, err := commentText(dec)
			if err != nil {
				return nil, parseErr(name, err)
			}
			c := Comment{Text: text}
			if id, err := strconv.Atoi(a["authorId"]); err == nil && id >= 0 && id < len(authors) {
				c.Author = authors[id]
			}
			out = append(out, refComment{ref: canonicalRef(a["ref"]), c: c})
		}
	}
}

// commentText reads a <comment> element to its end, concatenating all <t>
// runs under <text> and ignoring phonetic runs.
func commentText(dec decoder) (string, error) {
	return tRuns(dec)
}

type threaded struct {
	id, parent string
	c          Comment
}

// parseThreaded returns ref -> comments, ordered with replies after parents.
func parseThreaded(name string, data []byte, persons map[string]string) (map[string][]Comment, error) {
	dec := newDecoder(data)
	byRef := map[string][]threaded{}
	var refOrder []string
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		se, ok := tok.(startElement)
		if !ok || se.Name.Local != "threadedComment" {
			continue
		}
		a := attrs(se)
		tc := threaded{id: a["id"], parent: a["parentId"], c: Comment{Author: persons[a["personId"]]}}
		if at, ok := parseTime(a["dT"]); ok {
			tc.c.At = &at
		}
		// Read children: the <text> element carries the body.
		for {
			t2, err := dec.Token()
			if err != nil {
				return nil, parseErr(name, err)
			}
			if c, ok := t2.(startElement); ok {
				if c.Name.Local == "text" {
					s, err := plainText(dec)
					if err != nil {
						return nil, parseErr(name, err)
					}
					tc.c.Text = s
				} else if err := dec.Skip(); err != nil {
					return nil, parseErr(name, err)
				}
				continue
			}
			if _, ok := t2.(endElement); ok {
				break
			}
		}
		ref := canonicalRef(a["ref"])
		if _, seen := byRef[ref]; !seen {
			refOrder = append(refOrder, ref)
		}
		byRef[ref] = append(byRef[ref], tc)
	}
	out := make(map[string][]Comment, len(byRef))
	for _, ref := range refOrder {
		out[ref] = orderThread(byRef[ref])
	}
	return out, nil
}

// orderThread orders comments depth-first: each root in file order followed by
// its replies in file order. Replies whose parent is absent are treated as
// roots; anything unreachable (cycles) is appended in file order.
func orderThread(list []threaded) []Comment {
	ids := make(map[string]bool, len(list))
	for _, t := range list {
		if t.id != "" {
			ids[t.id] = true
		}
	}
	children := map[string][]int{}
	var roots []int
	for i, t := range list {
		if t.parent != "" && ids[t.parent] {
			children[t.parent] = append(children[t.parent], i)
		} else {
			roots = append(roots, i)
		}
	}
	out := make([]Comment, 0, len(list))
	visited := make([]bool, len(list))
	visit := func(start int) {
		stack := []int{start}
		for len(stack) > 0 {
			i := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if visited[i] {
				continue
			}
			visited[i] = true
			out = append(out, list[i].c)
			kids := children[list[i].id]
			for k := len(kids) - 1; k >= 0; k-- {
				stack = append(stack, kids[k])
			}
		}
	}
	for _, r := range roots {
		visit(r)
	}
	for i := range list {
		if !visited[i] {
			visit(i)
		}
	}
	return out
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	// Excel commonly omits the zone designator; treat as UTC.
	if t, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", s, time.UTC); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// ---- workbook / shared strings / sheets -----------------------------------

type sheetRef struct{ name, state, rid string }

func parseWorkbook(name string, data []byte, maxSheets int) ([]sheetRef, error) {
	dec := newDecoder(data)
	var out []sheetRef
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		se, ok := tok.(startElement)
		if !ok || se.Name.Local != "sheet" {
			continue
		}
		if len(out) >= maxSheets {
			return nil, fmt.Errorf("xlsx: %s has more than MaxSheets (%d) sheets", name, maxSheets)
		}
		var sr sheetRef
		for _, a := range se.Attr {
			switch a.Name.Local {
			case "name":
				sr.name = a.Value
			case "state":
				sr.state = a.Value
			case "id": // r:id
				sr.rid = a.Value
			}
		}
		out = append(out, sr)
	}
}

func parseSharedStrings(name string, data []byte) ([]string, error) {
	dec := newDecoder(data)
	var out []string
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		if se, ok := tok.(startElement); ok && se.Name.Local == "si" {
			s, err := tRuns(dec)
			if err != nil {
				return nil, parseErr(name, err)
			}
			out = append(out, s)
		}
	}
}

// parseSheet parses one worksheet. wbCells is the running count of <c>
// elements across all sheets of the workbook, capped at maxWbCells.
func parseSheet(name string, data []byte, sst []string, maxCells int, wbCells *int, maxWbCells int) (map[string]Cell, error) {
	dec := newDecoder(data)
	cells := map[string]Cell{}
	rowNum, colNum, count := 0, 0, 0
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return cells, nil
		}
		if err != nil {
			return nil, parseErr(name, err)
		}
		se, ok := tok.(startElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "row":
			rowNum++
			colNum = 0
			for _, a := range se.Attr {
				if a.Name.Local == "r" {
					n, ok := parseIndex(a.Value, maxRow)
					if !ok {
						return nil, fmt.Errorf("xlsx: %s: invalid row number %q", name, a.Value)
					}
					rowNum = n
				}
			}
		case "c":
			count++
			if count > maxCells {
				return nil, fmt.Errorf("xlsx: %s has more than MaxCellsPerSheet (%d) cells", name, maxCells)
			}
			*wbCells++
			if *wbCells > maxWbCells {
				return nil, fmt.Errorf("xlsx: %s: workbook has more than MaxCellsPerWorkbook (%d) cells", name, maxWbCells)
			}
			var ref, typ string
			for _, a := range se.Attr {
				switch a.Name.Local {
				case "r":
					ref = a.Value
				case "t":
					typ = a.Value
				}
			}
			if ref != "" {
				col, row, ok := splitRef(ref)
				if !ok {
					return nil, fmt.Errorf("xlsx: %s: invalid cell reference %q", name, ref)
				}
				colNum, rowNum = col, row
			} else {
				colNum++
				if rowNum == 0 {
					rowNum = 1
				}
				if colNum > maxCol {
					return nil, fmt.Errorf("xlsx: %s: too many cells in a row", name)
				}
			}
			// Canonical key: upper-case letters, no padding, built from (col,row).
			ref = colName(colNum) + strconv.Itoa(rowNum)
			cell, has, err := parseCell(dec, ref, typ, sst)
			if err != nil {
				return nil, parseErr(name, err)
			}
			if has {
				cells[ref] = cell
			}
		}
	}
}

// parseCell reads the children of a <c> element (already opened).
func parseCell(dec decoder, ref, typ string, sst []string) (Cell, bool, error) {
	c := Cell{Ref: ref}
	var v, inline string
	hasV, hasIS := false, false
	for {
		tok, err := dec.Token()
		if err != nil {
			return c, false, err
		}
		switch t := tok.(type) {
		case startElement:
			switch t.Name.Local {
			case "v":
				if v, err = plainText(dec); err != nil {
					return c, false, err
				}
				hasV = true
			case "f":
				if c.Formula, err = plainText(dec); err != nil {
					return c, false, err
				}
			case "is":
				if inline, err = tRuns(dec); err != nil {
					return c, false, err
				}
				hasIS = true
			default:
				if err := dec.Skip(); err != nil {
					return c, false, err
				}
			}
		case endElement:
			goto done
		}
	}
done:
	switch typ {
	case "s":
		if !hasV {
			break
		}
		idx, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || idx < 0 || idx >= len(sst) {
			return c, false, fmt.Errorf("cell %s: invalid shared string index %q", ref, v)
		}
		c.Text = sst[idx]
	case "inlineStr":
		if hasIS {
			c.Text = inline
		} else {
			c.Text = v
		}
	case "str", "e", "d":
		c.Text = v
	case "b":
		if hasV {
			if strings.TrimSpace(v) == "1" || strings.EqualFold(strings.TrimSpace(v), "true") {
				c.Text = "TRUE"
			} else {
				c.Text = "FALSE"
			}
		}
	default: // "n" or absent
		if hasV {
			f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
				c.Number = &f
				c.Text = strconv.FormatFloat(f, 'f', -1, 64)
			} else {
				c.Text = v
			}
		}
	}
	has := hasV || hasIS || c.Formula != ""
	return c, has, nil
}

// ---- xml helpers -----------------------------------------------------------

func parseErr(name string, err error) error {
	return fmt.Errorf("xlsx: parse %s: %w", name, err)
}

// attrs flattens attributes by local name.
func attrs(se startElement) map[string]string {
	m := make(map[string]string, len(se.Attr))
	for _, a := range se.Attr {
		m[a.Name.Local] = a.Value
	}
	return m
}

// plainText reads the current element (already opened) to its end, returning
// all character data inside it.
func plainText(dec decoder) (string, error) {
	var sb strings.Builder
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case charData:
			sb.Write(t)
		case startElement:
			depth++
		case endElement:
			if depth == 0 {
				return sb.String(), nil
			}
			depth--
		}
	}
}

// tRuns reads the current element (already opened) to its end and returns the
// concatenation of its <t> descendants, ignoring phonetic (<rPh>) runs.
func tRuns(dec decoder) (string, error) {
	var sb strings.Builder
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case startElement:
			switch t.Name.Local {
			case "t":
				s, err := plainText(dec)
				if err != nil {
					return "", err
				}
				sb.WriteString(s)
			case "rPh":
				if err := dec.Skip(); err != nil {
					return "", err
				}
			default:
				depth++
			}
		case endElement:
			if depth == 0 {
				return sb.String(), nil
			}
			depth--
		}
	}
}

// ---- cell references -------------------------------------------------------

const (
	maxCol = 16384
	maxRow = 1048576
)

// splitRef parses "AB12" into 1-based column and row.
func splitRef(ref string) (col, row int, ok bool) {
	i := 0
	for i < len(ref) && (ref[i] >= 'A' && ref[i] <= 'Z' || ref[i] >= 'a' && ref[i] <= 'z') {
		c := int(ref[i] &^ 0x20) // upper-case
		col = col*26 + (c - 'A' + 1)
		if col > maxCol {
			return 0, 0, false
		}
		i++
	}
	if i == 0 || i == len(ref) {
		return 0, 0, false
	}
	n, ok := parseIndex(ref[i:], maxRow)
	if !ok {
		return 0, 0, false
	}
	return col, n, true
}

// parseIndex parses a canonical positive decimal in [1, max]: ASCII digits
// only, no sign, no leading zero.
func parseIndex(s string, max int) (int, bool) {
	if s == "" || s[0] == '0' || len(s) > 9 {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int(s[i]-'0')
	}
	if n < 1 || n > max {
		return 0, false
	}
	return n, true
}

// canonicalRef returns ref upper-cased and normalised when it is a valid cell
// reference, otherwise ref unchanged.
func canonicalRef(ref string) string {
	if col, row, ok := splitRef(ref); ok {
		return colName(col) + strconv.Itoa(row)
	}
	return ref
}

// colName converts a 1-based column number to letters (1 -> A, 27 -> AA).
func colName(n int) string {
	var b []byte
	for ; n > 0; n = (n - 1) / 26 {
		b = append([]byte{byte('A' + (n-1)%26)}, b...)
	}
	return string(b)
}

// ---- dates -----------------------------------------------------------------

// SerialToDate converts an Excel serial date (1900 date system) to a UTC time.
// The integer part is days and the fraction is the time of day. Serial 60 is
// the fictitious 1900-02-29 that Excel inherited from Lotus 1-2-3; it has no
// real date, so it maps to 1900-02-28 (and serial 61 is 1900-03-01). Values
// that are not finite or are absurdly large return the zero time.
func SerialToDate(serial float64) time.Time {
	if math.IsNaN(serial) || math.IsInf(serial, 0) || math.Abs(serial) > 1e7 {
		return time.Time{}
	}
	days := math.Floor(serial)
	frac := serial - days
	d := int(days)
	var base time.Time
	switch {
	case d < 60:
		// Before the phantom leap day: serial 1 is 1900-01-01.
		base = time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC)
	case d == 60:
		base = time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC)
		d = 59
	default:
		// Serial 61 is 1900-03-01.
		base = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	}
	ms := time.Duration(math.Round(frac*86_400_000)) * time.Millisecond
	return base.AddDate(0, 0, d).Add(ms)
}

type (
	startElement = xml.StartElement
	endElement   = xml.EndElement
	charData     = xml.CharData
	decoder      = *depthDecoder
)

// depthDecoder wraps xml.Decoder and fails once element nesting exceeds
// MaxXMLDepth, so a tiny but deeply nested part cannot exhaust memory.
type depthDecoder struct {
	d     *xml.Decoder
	depth int
}

// newDecoder returns a strict streaming decoder over data. encoding/xml does
// not expand custom entities or fetch external resources, so it is safe for
// untrusted input; non-UTF-8 charsets are rejected (no CharsetReader).
func newDecoder(data []byte) decoder {
	return &depthDecoder{d: xml.NewDecoder(bytes.NewReader(data))}
}

// Token returns the next token, tracking element depth.
func (d *depthDecoder) Token() (xml.Token, error) {
	tok, err := d.d.Token()
	if err != nil {
		return tok, err
	}
	switch tok.(type) {
	case xml.StartElement:
		d.depth++
		if d.depth > MaxXMLDepth {
			return nil, fmt.Errorf("XML nesting exceeds MaxXMLDepth (%d)", MaxXMLDepth)
		}
	case xml.EndElement:
		d.depth--
	}
	return tok, nil
}

// Skip consumes tokens through the end of the element whose start tag was
// just returned by Token.
func (d *depthDecoder) Skip() error {
	n := 0
	for {
		tok, err := d.Token()
		if err != nil {
			return err
		}
		switch tok.(type) {
		case xml.StartElement:
			n++
		case xml.EndElement:
			if n == 0 {
				return nil
			}
			n--
		}
	}
}
