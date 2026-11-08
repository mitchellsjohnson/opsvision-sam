package records

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"opsvision/internal/xlsx"
)

// Upload limits for records files.
const (
	// MaxFileBytes is the largest file ReadCSV accepts.
	MaxFileBytes = 20 << 20
	// MaxRows is the most data rows a CSV or sheet may hold.
	MaxRows = 200_000
	// MaxColumns is the most columns a CSV or sheet header may hold.
	MaxColumns = 500
)

// Table is the rows of one export, whatever the file format. Rows are padded
// to len(Headers); RowNums holds each row's number in the file (the line a CSV
// row starts on, or the sheet row), for messages. Format is "csv" or "xlsx".
type Table struct {
	Headers []string
	Rows    [][]string
	RowNums []int
	Format  string
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// ReadCSV reads a CSV export whose header is on line 1. See ReadCSVHeader.
func ReadCSV(r io.Reader) (Table, error) { return ReadCSVHeader(r, 1) }

// ReadCSVHeader reads a CSV export whose header is on the given line (1 is
// the first). A leading UTF-8 byte order mark is dropped, the delimiter is
// sniffed from the header line among comma, semicolon, and tab, headers are
// trimmed, and blank rows are skipped. It fails on files over MaxFileBytes,
// more than MaxRows data rows, or more than MaxColumns columns.
func ReadCSVHeader(r io.Reader, headerRow int) (Table, error) {
	if headerRow < 1 {
		headerRow = 1
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxFileBytes+1))
	if err != nil {
		return Table{}, fmt.Errorf("read file: %w", err)
	}
	if len(data) > MaxFileBytes {
		return Table{}, fmt.Errorf("file is larger than %d MiB", MaxFileBytes>>20)
	}
	data = bytes.TrimPrefix(data, utf8BOM)

	cr := csv.NewReader(bytes.NewReader(data))
	cr.Comma = sniffDelimiter(data, headerRow)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	tbl := Table{Format: "csv"}
	haveHeader := false
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Table{}, fmt.Errorf("read csv: %w", err)
		}
		line, _ := cr.FieldPos(0)
		if len(rec) > MaxColumns {
			return Table{}, fmt.Errorf("row %d has %d columns; the limit is %d", line, len(rec), MaxColumns)
		}
		if !haveHeader {
			if line < headerRow {
				continue
			}
			haveHeader = true
			tbl.Headers = trimAll(rec)
			continue
		}
		if blankRow(rec) {
			continue
		}
		if len(tbl.Rows) >= MaxRows {
			return Table{}, fmt.Errorf("file has more than %d rows", MaxRows)
		}
		tbl.Rows = append(tbl.Rows, fit(rec, len(tbl.Headers)))
		tbl.RowNums = append(tbl.RowNums, line)
	}
	if !haveHeader {
		return Table{}, errors.New("file has no header row")
	}
	return tbl, nil
}

// sniffDelimiter picks the delimiter that occurs most often, outside quotes, on
// the header line (line headerRow). Ties and no delimiter at all mean comma.
func sniffDelimiter(data []byte, headerRow int) rune {
	candidates := []rune{',', ';', '\t'}
	counts := map[rune]int{}
	line, inQuotes := 1, false
	for _, b := range data {
		switch {
		case b == '"':
			inQuotes = !inQuotes
		case b == '\n' && !inQuotes:
			line++
			if line > headerRow {
				return best(candidates, counts)
			}
		case line == headerRow && !inQuotes:
			for _, c := range candidates {
				if rune(b) == c {
					counts[c]++
				}
			}
		}
	}
	return best(candidates, counts)
}

func best(candidates []rune, counts map[rune]int) rune {
	pick := ','
	for _, c := range candidates {
		if counts[c] > counts[pick] {
			pick = c
		}
	}
	return pick
}

// ReadSheet reads one worksheet of wb as a table. sheet names it (exact, then
// case-insensitive); empty means the first visible sheet. headerRow is the
// 1-based sheet row holding the headers (0 means 1). Cell text is used as
// is, so serial dates arrive as numbers; Format is "xlsx" so the parser knows
// to read them. The same row and column limits as CSV apply.
func ReadSheet(wb *xlsx.Workbook, sheet string, headerRow int) (Table, error) {
	if headerRow < 1 {
		headerRow = 1
	}
	sh, err := pickSheet(wb, sheet)
	if err != nil {
		return Table{}, err
	}

	byRow := map[int]map[int]string{}
	maxRow := 0
	for ref, c := range sh.Cells {
		col, row, ok := splitCellRef(ref)
		if !ok || strings.TrimSpace(c.Text) == "" {
			continue
		}
		if byRow[row] == nil {
			byRow[row] = map[int]string{}
		}
		byRow[row][col] = c.Text
		if row > maxRow {
			maxRow = row
		}
	}

	head := byRow[headerRow]
	width := 0
	for col := range head {
		if col > width {
			width = col
		}
	}
	if width == 0 {
		return Table{}, fmt.Errorf("sheet %q has no header on row %d", sh.Name, headerRow)
	}
	if width > MaxColumns {
		return Table{}, fmt.Errorf("sheet %q has %d columns; the limit is %d", sh.Name, width, MaxColumns)
	}
	tbl := Table{Format: "xlsx", Headers: make([]string, width)}
	for col, text := range head {
		tbl.Headers[col-1] = strings.TrimSpace(text)
	}

	nums := make([]int, 0, len(byRow))
	for row := range byRow {
		if row > headerRow {
			nums = append(nums, row)
		}
	}
	sort.Ints(nums)
	if len(nums) > MaxRows {
		return Table{}, fmt.Errorf("sheet %q has more than %d rows", sh.Name, MaxRows)
	}
	for _, row := range nums {
		cells := make([]string, width)
		for col, text := range byRow[row] {
			if col <= width {
				cells[col-1] = text
			}
		}
		if blankRow(cells) {
			continue
		}
		tbl.Rows = append(tbl.Rows, cells)
		tbl.RowNums = append(tbl.RowNums, row)
	}
	return tbl, nil
}

func pickSheet(wb *xlsx.Workbook, name string) (*xlsx.Sheet, error) {
	if wb == nil || len(wb.Sheets) == 0 {
		return nil, errors.New("workbook has no sheets")
	}
	if name == "" {
		for i := range wb.Sheets {
			if !wb.Sheets[i].Hidden {
				return &wb.Sheets[i], nil
			}
		}
		return &wb.Sheets[0], nil
	}
	for i := range wb.Sheets {
		if wb.Sheets[i].Name == name {
			return &wb.Sheets[i], nil
		}
	}
	for i := range wb.Sheets {
		if strings.EqualFold(wb.Sheets[i].Name, name) {
			return &wb.Sheets[i], nil
		}
	}
	names := make([]string, len(wb.Sheets))
	for i, s := range wb.Sheets {
		names[i] = s.Name
	}
	return nil, fmt.Errorf("workbook has no sheet %q (sheets: %s)", name, strings.Join(names, ", "))
}

// splitCellRef parses an A1-style reference into 1-based column and row.
func splitCellRef(ref string) (col, row int, ok bool) {
	i := 0
	for ; i < len(ref); i++ {
		c := ref[i] &^ 0x20
		if c < 'A' || c > 'Z' {
			break
		}
		col = col*26 + int(c-'A') + 1
		if col > 16384 {
			return 0, 0, false
		}
	}
	if i == 0 || i == len(ref) {
		return 0, 0, false
	}
	for ; i < len(ref); i++ {
		if ref[i] < '0' || ref[i] > '9' {
			return 0, 0, false
		}
		row = row*10 + int(ref[i]-'0')
		if row > 1_048_576 {
			return 0, 0, false
		}
	}
	return col, row, row > 0
}

func trimAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.TrimSpace(s)
	}
	return out
}

func blankRow(cells []string) bool {
	for _, c := range cells {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// fit pads or truncates rec to n cells.
func fit(rec []string, n int) []string {
	out := make([]string, n)
	copy(out, rec)
	return out
}
