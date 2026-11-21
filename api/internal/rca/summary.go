package rca

import (
	"cmp"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
)

// Requirement says whether a metric-month needs an exec summary and, when it
// does, why: "Red", "Below 100% (99.97%)", "1 of 24 services below 100%".
type Requirement struct {
	Required bool
	Reason   string
}

// NounForms is a subject noun in both numbers: service / services.
type NounForms struct{ One, Many string }

// SubjectFacts is one reporting subject's cell, with the subject's own rule
// (per-subject bands applied).
type SubjectFacts struct {
	ID, Name string
	Cell     CellFacts
	Rule     domain.StatusRule
}

// SummaryInput is one metric-month at company scope: the company (root
// unit) cell and its rule, the reporting subjects (the company standing when
// the company has no value, as for uptime across services), the tenant's
// scale, and the noun for the subjects. A coarse metric (quarterly, twice
// yearly, yearly) is judged at its own period, and only the month that
// closes that period (ClosesInMonth) needs its summary. ComparedLabel names
// a change rule's comparison (Sep) in the headline.
type SummaryInput struct {
	Metric                domain.Metric
	Company               *CellFacts
	CompanyRule           domain.StatusRule
	Reporting             []SubjectFacts
	Scale                 []domain.StatusLevel
	Coarse, ClosesInMonth bool
	Noun                  NounForms
	ComparedLabel         string
}

// SummaryRequired says whether the metric-month needs an exec summary: when
// the company cell is not at its best status, or its displayed value is
// short of the ideal even at its best status; with no company value, when
// any rated reporting subject is. A metric-month with nothing rated at its
// company standing (not reported, not applicable, not rated, not due) and a
// perfect one are optional, as is a coarse period in a month that does not
// close it. It is a tenant fact: pass every subject, not what a reader sees.
func SummaryRequired(in SummaryInput) Requirement {
	if in.Coarse && !in.ClosesInMonth {
		return Requirement{}
	}
	if c := in.Company; hasStanding(c) {
		if reason, short := imperfect(in.Metric, *c, in.CompanyRule, in.Scale); short {
			return Requirement{Required: true, Reason: reason}
		}
		return Requirement{}
	}
	k, n, _ := subjectGaps(in)
	if k == 0 {
		return Requirement{}
	}
	return Requirement{Required: true, Reason: fmt.Sprintf("%d of %d %s %s", k, n, nouns(in).Many, shortOf(in))}
}

// CompanyHeadline is the company standing's gap in one line: the gap
// headline of the company cell ("6 pts short of 100%", "138 above the Green
// line (450 or less)") or, with no company value, the count of reporting
// subjects with a gap and the worst one ("6 of 24 services below 100% ·
// worst Webhooks 99.06%"). Empty when the metric-month is perfect or not
// rated.
func CompanyHeadline(in SummaryInput) string {
	if c := in.Company; hasStanding(c) {
		if _, short := imperfect(in.Metric, *c, in.CompanyRule, in.Scale); !short {
			return ""
		}
		best := BestStatus(in.CompanyRule, in.Scale)
		if c.Status == best && DowntimeMetric(in.Metric) {
			if units, ok := GapUnits(100, c.Display, Decimals(in.Metric.Format)); ok && units > 0 {
				return unitsText(units, Decimals(in.Metric.Format)) + " pts short of 100%"
			}
		}
		m := in.Metric
		m.Rule = in.CompanyRule
		return GapOf(GapInput{Metric: m, Cell: *c, StatusLabel: scaleLabel(in.Scale), BestStatus: best, ComparedLabel: in.ComparedLabel}).Headline
	}
	k, n, worst := subjectGaps(in)
	if k == 0 {
		return ""
	}
	return fmt.Sprintf("%d of %d %s %s · worst %s %s", k, n, nouns(in).Many, shortOf(in), worst.Name, worst.Cell.Display)
}

// CompanyStanding is the displayed value and status the summary is written
// against: the company cell's, or, with no company value, the worst rated
// reporting subject's.
func CompanyStanding(in SummaryInput) (display, status string) {
	if c := in.Company; hasStanding(c) {
		return c.Display, c.Status
	}
	if _, _, worst := subjectGaps(in); worst != nil {
		return worst.Cell.Display, worst.Cell.Status
	}
	return "", ""
}

// SubjectsShort lists the IDs of the rated reporting subjects short of
// perfect, each judged by its own rule, in the order given.
func SubjectsShort(in SummaryInput) []string {
	out := []string{}
	for _, s := range in.Reporting {
		if _, short := imperfect(in.Metric, s.Cell, s.Rule, in.Scale); short {
			out = append(out, s.ID)
		}
	}
	return out
}

// hasStanding reports whether the company cell has a value or a status of
// its own.
func hasStanding(c *CellFacts) bool {
	return c != nil && (c.Display != "" || c.Value != nil || c.Status != "")
}

// imperfect says whether a rated cell is short of perfect, and why: its
// status when that is not the best its rule can give, else its displayed
// value against the metric's ideal (below 100%, or over 100% of plan).
func imperfect(m domain.Metric, c CellFacts, rule domain.StatusRule, scale []domain.StatusLevel) (string, bool) {
	if c.Status == "" {
		return "", false
	}
	if best := BestStatus(rule, scale); best != "" && c.Status != best {
		return scaleLabel(scale)(c.Status), true
	}
	units, ok := GapUnits(100, c.Display, Decimals(m.Format))
	switch {
	case !ok:
	case engine.ChartKind(m) == "money_plan" && units < 0:
		return "Above 100% (" + c.Display + ")", true
	case engine.ChartKind(m) != "money_plan" && DowntimeMetric(m) && units > 0:
		return "Below 100% (" + c.Display + ")", true
	}
	return "", false
}

// subjectGaps counts the rated reporting subjects (n), those short of
// perfect (k), and returns the worst rated subject: the worst status, then
// the largest gap, then the name.
func subjectGaps(in SummaryInput) (k, n int, worst *SubjectFacts) {
	rank := func(status string) int {
		for _, l := range in.Scale {
			if l.Key == status {
				return l.Rank
			}
		}
		return 0
	}
	d := Decimals(in.Metric.Format)
	gap := func(s SubjectFacts) int64 {
		u, ok := displayedUnits(s.Cell.Display, d)
		switch {
		case !ok:
			return 0
		case in.Metric.Direction == domain.DirectionLowerBetter || engine.ChartKind(in.Metric) == "money_plan":
			return u
		}
		return -u
	}
	var rated []SubjectFacts
	for _, s := range in.Reporting {
		if s.Cell.Status == "" {
			continue
		}
		rated = append(rated, s)
		if _, short := imperfect(in.Metric, s.Cell, s.Rule, in.Scale); short {
			k++
		}
	}
	if len(rated) == 0 {
		return 0, 0, nil
	}
	w := slices.MinFunc(rated, func(a, b SubjectFacts) int {
		return cmp.Or(cmp.Compare(rank(b.Cell.Status), rank(a.Cell.Status)), cmp.Compare(gap(b), gap(a)), cmp.Compare(a.Name, b.Name))
	})
	return k, len(rated), &w
}

// shortOf is how a subject falls short in a count: below 100%, over plan,
// or not at the best status.
func shortOf(in SummaryInput) string {
	switch {
	case engine.ChartKind(in.Metric) == "money_plan":
		return "over plan"
	case DowntimeMetric(in.Metric):
		return "below 100%"
	}
	return "not " + scaleLabel(in.Scale)(BestStatus(in.Metric.Rule, in.Scale))
}

func nouns(in SummaryInput) NounForms {
	if in.Noun.Many == "" {
		return Nouns("", "item")
	}
	return in.Noun
}

// scaleLabel names a status key by the tenant's scale, else the key itself.
func scaleLabel(scale []domain.StatusLevel) func(string) string {
	return func(key string) string {
		for _, l := range scale {
			if l.Key == key && l.Label != "" {
				return l.Label
			}
		}
		return key
	}
}

// Noun endings: singularS reads as singular though it ends in s (class,
// status, analysis); the others choose a plural's or singular's ending.
var (
	singularS  = regexp.MustCompile(`(ss|us|is)$`)
	pluralEs   = regexp.MustCompile(`(sses|xes|ches|shes)$`)
	consonantY = regexp.MustCompile(`[^aeiou]y$`)
	sibilant   = regexp.MustCompile(`(s|x|ch|sh)$`)
)

// Nouns is a kind or level name as a lowercased noun in both numbers:
// Repositories and Repository both give repository / repositories. An empty
// name falls back to fallback ("item" or "unit"), as the web does.
func Nouns(name, fallback string) NounForms {
	word := strings.ToLower(strings.TrimSpace(name))
	if word == "" {
		return NounForms{One: fallback, Many: fallback + "s"}
	}
	if strings.HasSuffix(word, "s") && !singularS.MatchString(word) {
		var one string
		switch {
		case strings.HasSuffix(word, "ies"):
			one = word[:len(word)-3] + "y"
		case pluralEs.MatchString(word):
			one = word[:len(word)-2]
		default:
			one = word[:len(word)-1]
		}
		if one != "" {
			return NounForms{One: one, Many: word}
		}
		return NounForms{One: fallback, Many: fallback + "s"}
	}
	switch {
	case consonantY.MatchString(word):
		return NounForms{One: word, Many: word[:len(word)-1] + "ies"}
	case sibilant.MatchString(word):
		return NounForms{One: word, Many: word + "es"}
	}
	return NounForms{One: word, Many: word + "s"}
}
