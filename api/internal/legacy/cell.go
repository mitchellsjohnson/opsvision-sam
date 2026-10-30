// Package legacy parses the hand-typed text found in a legacy metrics
// workbook: value cells such as "48|66 | 72% | Y" and threshold text such as
// ">=80% < 90%". The parsers turn that text into numbers, statuses,
// not-applicable reasons and status bands for the legacy importer.
package legacy

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Kind classifies a parsed cell.
type Kind int

// Cell kinds.
const (
	// Empty is a blank or whitespace-only cell.
	Empty Kind = iota
	// Ratio is a numerator and denominator (Num, Den); Value is nil.
	Ratio
	// Percent is a percentage; Value is the percent number (99.64, not 0.9964).
	Percent
	// Money is an amount in thousands; Value is the amount in k.
	Money
	// Number is a bare number, kept as written.
	Number
	// ScoreOfMax is a score out of a maximum (Value, Max).
	ScoreOfMax
	// ScoreChange is a score and its signed percent change (Value, Change).
	ScoreChange
	// NotApplicable is explanatory text with no value; see NAReason.
	NotApplicable
	// Unparsed is text containing digits that matched no known pattern.
	Unparsed
)

var kindNames = [...]string{"Empty", "Ratio", "Percent", "Money", "Number",
	"ScoreOfMax", "ScoreChange", "NotApplicable", "Unparsed"}

// String returns the name of the kind.
func (k Kind) String() string {
	if k < 0 || int(k) >= len(kindNames) {
		return "Kind(" + strconv.Itoa(int(k)) + ")"
	}
	return kindNames[k]
}

// Parsed is the result of parsing one cell. Pointer fields are nil when not
// applicable to Kind. Status is "G", "Y" or "R" when the cell carried one.
// Raw is the input text as given.
type Parsed struct {
	Kind     Kind
	Num      *float64
	Den      *float64
	Value    *float64
	Max      *float64
	Change   *float64
	Status   string
	NAReason string
	Raw      string
}

// numPat matches one number: optional sign, digits (with well-formed thousands
// commas: groups of exactly three), optional decimals, or leading-dot decimals.
const numPat = `-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`

var (
	// trailing status token: "| Y", "|Y", "! R" (typo for the pipe), "/ G"
	// (slash used as the separator) or a bare " G".
	statusRe = regexp.MustCompile(`(?i)(\s*[|!/]\s*|\s+)([GYR])\s*$`)
	// "<num>[%] | <num>[%] | <num>[%]" or "<num>[k] | <num>[k]" with k suffix.
	pipeRatioRe = regexp.MustCompile(`^\$?(` + numPat + `)\s*k?\s*\|\s*\$?(` + numPat + `)\s*k?\s*(?:\|\s*|\s+)` + numPat + `\s*%?$`)
	// two-part pipe where either side carries the k (thousands) suffix.
	pipeRatioKRe = regexp.MustCompile(`(?i)^\$?(` + numPat + `)\s*k\s*\|\s*\$?(` + numPat + `)\s*k?$|^\$?(` + numPat + `)\s*k?\s*\|\s*\$?(` + numPat + `)\s*k$`)
	// "<num>[%] (<n>/<d>[)]" and "N/A (<n>/<d>)".
	// The ratio may use "|" for the slash and may carry a trailing note
	// after ";" or ",".
	pctParenRatioRe = regexp.MustCompile(`(?i)^(?:` + numPat + `\s*%?|n/a)\s*\(\s*\$?(` + numPat + `)\s*k?\s*[/|]\s*\$?(` + numPat + `)\s*k?\s*(?:[;,][^)]*)?\)?$`)
	// "<n>/<d> [(<pct>[%])]" or "<n>/<d> | <pct>%". No spaces around the slash:
	// "350 / 100" is ambiguous (a score and a count) and stays unparsed.
	slashRatioRe = regexp.MustCompile(`^\$?(` + numPat + `)k?/\$?(` + numPat + `)k?\s*(?:(?:\(\s*|\|\s*)` + numPat + `\s*%?\s*\)?)?$`)
	// "<score> | <pct>% <words> Increase|Improvement|Decline|Decrease",
	// "No Change", or "New ..." (no baseline, so no change).
	scoreChangeRe = regexp.MustCompile(`(?i)^(` + numPat + `)\s*\|\s*(?:(` + numPat + `)\s*%?\s*)?(?:[a-z]+\s+)*?(increase|improvement|decline|decrease|decine|no\s+change|new)(?:\s+[a-z]+)*$`)
	// "<score> | <pct>%" or "<score> | (<pct>%)": the direction is unstated,
	// so the percent is not kept (Change stays nil).
	scoreChangePctRe = regexp.MustCompile(`^(` + numPat + `)\s*\|\s*\(?\s*(` + numPat + `)\s*%\s*\)?$`)
	// "<pct>% | <count>": a percent with an extra count, which is dropped.
	pctCountRe = regexp.MustCompile(`^(` + numPat + `)\s*%\s*\|\s*` + numPat + `$`)
	// "$<n>M | <delta>M | <pct>%": an amount in millions, its change, and the
	// percent change. The "$" is required.
	moneyMRe = regexp.MustCompile(`(?i)^\$(` + numPat + `)\s*m\s*\|\s*\$?` + numPat + `\s*m\s*\|\s*(` + numPat + `)\s*%$`)
	// "<score> | <max>".
	scoreOfMaxRe = regexp.MustCompile(`^(` + numPat + `)\s*\|\s*(` + numPat + `)$`)
	// "$<n>k" or "<n>k": thousands. A bare "$<n>" has no unit marker and is
	// not parsed.
	moneyRe = regexp.MustCompile(`(?i)^(?:\$\s*(` + numPat + `)\s*k|(` + numPat + `)\s*k)$`)
	// "$<n>M": millions, stored in thousands. The "$" is required ("5m" alone
	// could be minutes).
	moneyMOnlyRe = regexp.MustCompile(`(?i)^\$\s*(` + numPat + `)\s*m$`)
	// "<n>%".
	percentRe = regexp.MustCompile(`^(` + numPat + `)\s*%$`)
	// "<n>".
	numberRe = regexp.MustCompile(`^(` + numPat + `)$`)

	naPrefixRe = regexp.MustCompile(`(?i)^n/a\b`)
	digitRe    = regexp.MustCompile(`\d`)
)

// plainPercentMin is the smallest un-signed decimal value that is treated as a
// percentage when a status accompanies it ("99.36 | R"). Smaller decimals
// ("4.8 | Y") stay plain numbers.
const plainPercentMin = 50

func parseNum(s string) *float64 {
	f, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	if err != nil {
		return nil
	}
	return &f
}

// cellNormalizer maps typographic variants to the ASCII forms the patterns use.
var cellNormalizer = strings.NewReplacer(
	"\u00a0", " ", // no-break space
	"\u202f", " ", // narrow no-break space
	"\u2013", "-", // en dash
	"\u2014", "-", // em dash
	"\u2212", "-", // minus sign
)

// ParseCell parses the text of one legacy workbook cell. Text that is
// ambiguous or matches no pattern comes back as Unparsed with only Raw set.
func ParseCell(raw string) Parsed {
	unparsed := Parsed{Kind: Unparsed, Raw: raw}
	s := strings.TrimSpace(cellNormalizer.Replace(raw))
	if s == "" {
		return Parsed{Kind: Empty, Raw: raw}
	}
	if strings.HasPrefix(s, "#") {
		return unparsed
	}
	if !digitRe.MatchString(s) {
		return Parsed{Kind: NotApplicable, NAReason: strings.TrimSpace(raw), Raw: raw}
	}

	body, status := s, ""
	if m := statusRe.FindStringSubmatchIndex(s); m != nil {
		status = strings.ToUpper(s[m[4]:m[5]])
		body = strings.TrimSpace(s[:m[0]])
	}

	p := Parsed{Raw: raw, Status: status}
	if matchCell(&p, body) {
		return p
	}
	if naPrefixRe.MatchString(s) {
		rest := strings.TrimLeft(s[3:], " \t")
		if strings.HasPrefix(rest, "-") || rest == "" || !strings.ContainsAny(rest[:1], "0123456789($") {
			return Parsed{Kind: NotApplicable, NAReason: strings.TrimSpace(raw), Raw: raw}
		}
	}
	return unparsed
}

// matchCell tries each pattern in order against body and fills p on a match.
func matchCell(p *Parsed, body string) bool {
	if m := pipeRatioRe.FindStringSubmatch(body); m != nil {
		return setRatio(p, m[1], m[2])
	}
	if m := pipeRatioKRe.FindStringSubmatch(body); m != nil {
		if m[1] != "" {
			return setRatio(p, m[1], m[2])
		}
		return setRatio(p, m[3], m[4])
	}
	if m := pctParenRatioRe.FindStringSubmatch(body); m != nil {
		return setRatio(p, m[1], m[2])
	}
	if m := slashRatioRe.FindStringSubmatch(body); m != nil {
		return setRatio(p, m[1], m[2])
	}
	if m := moneyMRe.FindStringSubmatch(body); m != nil {
		p.Kind = Money
		v := parseNum(m[1])
		c := parseNum(m[2])
		if v == nil || c == nil {
			return false
		}
		k := *v * 1000
		p.Value, p.Change = &k, c
		return true
	}
	if m := scoreChangeRe.FindStringSubmatch(body); m != nil {
		return setScoreChange(p, m)
	}
	if m := scoreChangePctRe.FindStringSubmatch(body); m != nil {
		// Direction unstated ("(10%)" is often a decline): keep the score only.
		p.Kind = ScoreChange
		p.Value = parseNum(m[1])
		return p.Value != nil
	}
	if m := pctCountRe.FindStringSubmatch(body); m != nil {
		p.Kind = Percent
		p.Value = parseNum(m[1])
		return p.Value != nil
	}
	if m := scoreOfMaxRe.FindStringSubmatch(body); m != nil {
		p.Kind = ScoreOfMax
		p.Value, p.Max = parseNum(m[1]), parseNum(m[2])
		return p.Value != nil && p.Max != nil
	}
	if m := moneyRe.FindStringSubmatch(body); m != nil {
		p.Kind = Money
		p.Value = parseNum(m[1] + m[2])
		return p.Value != nil
	}
	if m := moneyMOnlyRe.FindStringSubmatch(body); m != nil {
		p.Kind = Money
		v := parseNum(m[1])
		if v == nil {
			return false
		}
		k := *v * 1000
		p.Value = &k
		return true
	}
	if m := percentRe.FindStringSubmatch(body); m != nil {
		p.Kind = Percent
		p.Value = parseNum(m[1])
		return p.Value != nil
	}
	if m := numberRe.FindStringSubmatch(body); m != nil {
		p.Value = parseNum(m[1])
		if p.Value == nil {
			return false
		}
		p.Kind = Number
		if p.Status != "" && strings.Contains(m[1], ".") && *p.Value >= plainPercentMin && *p.Value <= 100 {
			p.Kind = Percent
		}
		return true
	}
	return false
}

func setRatio(p *Parsed, num, den string) bool {
	p.Kind = Ratio
	p.Num, p.Den = parseNum(num), parseNum(den)
	return p.Num != nil && p.Den != nil
}

func setScoreChange(p *Parsed, m []string) bool {
	p.Kind = ScoreChange
	p.Value = parseNum(m[1])
	if p.Value == nil {
		return false
	}
	word := strings.ToLower(m[3])
	switch {
	case strings.HasPrefix(word, "no"):
		// "No Change": zero, any number is ignored.
		zero := 0.0
		p.Change = &zero
	case word == "new":
		// New to tracking: no baseline, so no change.
	default:
		pct := parseNum(m[2])
		if pct == nil {
			// Direction without a size ("Quality Decline"): no change value.
			return true
		}
		// The direction word decides the sign; a typed sign is ignored.
		change := math.Abs(*pct)
		if strings.HasPrefix(word, "dec") {
			change = -change
		}
		p.Change = &change
	}
	return true
}
