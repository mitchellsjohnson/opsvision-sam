package legacy

import (
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"

	"opsvision/internal/xlsx"
)

func fp(v float64) *float64 { return &v }

func eq(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return math.Abs(*a-*b) < 1e-9
}

func TestParseCell(t *testing.T) {
	tests := []struct {
		name   string
		in     string
		kind   Kind
		num    *float64
		den    *float64
		value  *float64
		max    *float64
		change *float64
		status string
		na     string
	}{
		{name: "pipe ratio", in: "48|66 | 72% | Y", kind: Ratio, num: fp(48), den: fp(66), status: "Y"},
		{name: "pipe ratio money k", in: "8234k|10471k | 79% | G", kind: Ratio, num: fp(8234), den: fp(10471), status: "G"},
		{name: "pipe ratio commas", in: "1,234|2,000 | 62% | r", kind: Ratio, num: fp(1234), den: fp(2000), status: "R"},
		{name: "pipe ratio no spaces", in: "5|10|50%|G", kind: Ratio, num: fp(5), den: fp(10), status: "G"},
		{name: "pct then paren ratio", in: "87% (172/198)", kind: Ratio, num: fp(172), den: fp(198)},
		{name: "ratio then pct", in: "74/98 (75.5%)", kind: Ratio, num: fp(74), den: fp(98)},
		{name: "ratio then pct tight", in: "100/133(75.2%)", kind: Ratio, num: fp(100), den: fp(133)},
		{name: "unclosed paren", in: " 100% (2/2", kind: Ratio, num: fp(2), den: fp(2)},
		{name: "na with zero ratio", in: "N/A (0/0)", kind: Ratio, num: fp(0), den: fp(0)},
		{name: "bare zero ratio", in: "0/0 ", kind: Ratio, num: fp(0), den: fp(0)},
		{name: "ratio with status", in: "3/4 | Y", kind: Ratio, num: fp(3), den: fp(4), status: "Y"},
		{name: "money dollar k", in: "$10471k", kind: Money, value: fp(10471)},
		{name: "money k only", in: "250k", kind: Money, value: fp(250)},
		{name: "money with status", in: "$1,250k | G", kind: Money, value: fp(1250), status: "G"},
		{name: "percent status", in: "99.64% | R", kind: Percent, value: fp(99.64), status: "R"},
		{name: "percent tight", in: "97.83%|R", kind: Percent, value: fp(97.83), status: "R"},
		{name: "percent bang typo", in: "99.6% ! R", kind: Percent, value: fp(99.6), status: "R"},
		{name: "percent no sign", in: "99.36 | R", kind: Percent, value: fp(99.36), status: "R"},
		{name: "percent alone", in: "72%", kind: Percent, value: fp(72)},
		{name: "percent spaced sign", in: "72.5 %", kind: Percent, value: fp(72.5)},
		{name: "fraction number", in: "0.9989", kind: Number, value: fp(0.9989)},
		{name: "integer", in: "42", kind: Number, value: fp(42)},
		{name: "number commas", in: "1,587", kind: Number, value: fp(1587)},
		{name: "score increase", in: "1587 | 12% Quality Increase | G", kind: ScoreChange, value: fp(1587), change: fp(12), status: "G"},
		{name: "score improvement", in: "20 | 5% improvement | g", kind: ScoreChange, value: fp(20), change: fp(5), status: "G"},
		{name: "score decline", in: "696 | 17% Quality Decline | R", kind: ScoreChange, value: fp(696), change: fp(-17), status: "R"},
		{name: "score no change", in: "2 | No Change | Y", kind: ScoreChange, value: fp(2), change: fp(0), status: "Y"},
		{name: "score no change lower", in: "2|no change|y", kind: ScoreChange, value: fp(2), change: fp(0), status: "Y"},
		{name: "number status", in: "16 | Y", kind: Number, value: fp(16), status: "Y"},
		{name: "number status tight", in: "17|Y", kind: Number, value: fp(17), status: "Y"},
		{name: "score of max", in: "4.8 | 7 | Y", kind: ScoreOfMax, value: fp(4.8), max: fp(7), status: "Y"},
		{name: "score of max tight", in: "4.4| 7 | Y", kind: ScoreOfMax, value: fp(4.4), max: fp(7), status: "Y"},
		{name: "slash separator pct count", in: "80% / 5 / G", kind: Percent, value: fp(80), status: "G"},
		{name: "slash separator tight", in: "99.5%/3 /r", kind: Percent, value: fp(99.5), status: "R"},
		{name: "slash separator pct only", in: "99.5% / Y", kind: Percent, value: fp(99.5), status: "Y"},
		{name: "slash separator two numbers", in: "350 / 100 / G", kind: ScoreOfMax, value: fp(350), max: fp(100), status: "G"},
		{name: "space separated status", in: "3/4 R", kind: Ratio, num: fp(3), den: fp(4), status: "R"},
		{name: "space separated status pct", in: "99.5% G", kind: Percent, value: fp(99.5), status: "G"},
		{name: "pct paren pipe ratio", in: "75% (3|4)", kind: Ratio, num: fp(3), den: fp(4)},
		{name: "pct paren ratio with note", in: "33% (1/3; note about it)", kind: Ratio, num: fp(1), den: fp(3)},
		{name: "pipe ratio space pct", in: "4|5 80%", kind: Ratio, num: fp(4), den: fp(5)},
		{name: "slash ratio pipe pct", in: "4/12 | 33% | R", kind: Ratio, num: fp(4), den: fp(12), status: "R"},
		{name: "money millions only", in: "$2m", kind: Money, value: fp(2000)},
		{name: "money millions triple", in: "0.38M | -0.43M | -53% | G", kind: Money, value: fp(380), change: fp(-53), status: "G"},
		{name: "score pct unsigned", in: "1869 | 14%", kind: ScoreChange, value: fp(1869), change: fp(14)},
		{name: "score pct paren", in: "2824 | (10%)", kind: ScoreChange, value: fp(2824), change: fp(10)},
		{name: "score pct status", in: "1901 | 24% | G", kind: ScoreChange, value: fp(1901), change: fp(24), status: "G"},
		{name: "score decline no pct", in: "2 | Quality Decline | R", kind: ScoreChange, value: fp(2), status: "R"},
		{name: "score decrease typo", in: "2656 | 3% Quality Decine | R", kind: ScoreChange, value: fp(2656), change: fp(-3), status: "R"},
		{name: "score new", in: "8 | New Addition | Y", kind: ScoreChange, value: fp(8), status: "Y"},
		{name: "multi-line breakdown", in: "Team A - 52k | 9k | 20% | R \n Team B - 30k | 2k | 6% | Y", kind: Unparsed},
		{name: "sum shape", in: "4/2=6", kind: Unparsed},
		{name: "na phrase 1", in: "No big initiatives", kind: NotApplicable, na: "No big initiatives"},
		{name: "na phrase 2", in: "No epics", kind: NotApplicable, na: "No epics"},
		{name: "na phrase 3", in: "Measured Quarterly", kind: NotApplicable, na: "Measured Quarterly"},
		{name: "na dash", in: "N/A - Migrated to new platform", kind: NotApplicable, na: "N/A - Migrated to new platform"},
		{name: "na dash with digits", in: "N/A - moved to 2 teams", kind: NotApplicable, na: "N/A - moved to 2 teams"},
		{name: "na trimmed", in: "  Moved under Data \n", kind: NotApplicable, na: "Moved under Data"},
		{name: "na bare", in: "N/A", kind: NotApplicable, na: "N/A"},
		{name: "err na", in: "#N/A", kind: Unparsed},
		{name: "err ref", in: "#REF!", kind: Unparsed},
		{name: "err div", in: "#DIV/0!", kind: Unparsed},
		{name: "err value", in: "#VALUE!", kind: Unparsed},
		{name: "empty", in: "", kind: Empty},
		{name: "whitespace", in: " \t\n", kind: Empty},
		{name: "digits no pattern", in: "see 3 items in 2 groups", kind: Unparsed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseCell(tc.in)
			if got.Kind != tc.kind {
				t.Fatalf("kind = %v, want %v (%+v)", got.Kind, tc.kind, got)
			}
			if !eq(got.Num, tc.num) || !eq(got.Den, tc.den) || !eq(got.Value, tc.value) ||
				!eq(got.Max, tc.max) || !eq(got.Change, tc.change) {
				t.Errorf("numbers = %+v, want num=%v den=%v value=%v max=%v change=%v",
					got, tc.num, tc.den, tc.value, tc.max, tc.change)
			}
			if got.Status != tc.status {
				t.Errorf("status = %q, want %q", got.Status, tc.status)
			}
			if got.NAReason != tc.na {
				t.Errorf("naReason = %q, want %q", got.NAReason, tc.na)
			}
			if tc.kind == Unparsed && got.Raw != tc.in {
				t.Errorf("raw = %q, want %q", got.Raw, tc.in)
			}
		})
	}
}

func TestKindString(t *testing.T) {
	if Ratio.String() != "Ratio" || Unparsed.String() != "Unparsed" {
		t.Fatalf("unexpected Kind strings: %s %s", Ratio, Unparsed)
	}
}

func colIndex(ref string) int {
	n := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		n = n*26 + int(r-'A') + 1
	}
	return n
}

// TestParseRealWorkbookHistogram is a local-only check against a real legacy
// workbook. It logs only counts of Kind per sheet index.
func TestParseRealWorkbookHistogram(t *testing.T) {
	path := os.Getenv("OPSVISION_REAL_WORKBOOK")
	if path == "" {
		t.Skip("OPSVISION_REAL_WORKBOOK not set")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	wb, err := xlsx.Open(f, st.Size())
	if err != nil {
		t.Fatal(err)
	}
	for i, sh := range wb.Sheets {
		counts := map[string]int{}
		for ref, c := range sh.Cells {
			if col := colIndex(ref); col < 2 || col > 18 {
				continue
			}
			counts[ParseCell(c.Text).Kind.String()]++
		}
		keys := make([]string, 0, len(counts))
		for k := range counts {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, k+"="+strconv.Itoa(counts[k]))
		}
		t.Logf("sheet[%d]: %s", i, strings.Join(parts, " "))
	}
}
