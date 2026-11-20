package rca

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// Expectation says whether the RCAs view chases a cell.
type Expectation string

// Expectations, as in the API.
const (
	Needed    Expectation = "needed"
	Available Expectation = "available"
	None      Expectation = "none"
)

// ExpectInput is what Expect needs to know about one cell. Status is after
// overrides. DisplayedUnits and IdealUnits are the displayed value and the
// ideal in whole units of the display precision (nil when the metric has no
// ideal); Higher says the ideal is approached from below (else the cell is
// short of it when above, as over plan). WorstChild is the expectation of
// the subject's worst readable child, for a cell with no value of its own.
type ExpectInput struct {
	YTD, NotDue, NA, NotRated, HasValueOrStatus, HasReadableChildren, AtReportingSubject bool
	Status, BestStatus                                                                   string
	DisplayedUnits, IdealUnits                                                           *int64
	Higher                                                                               bool
	WorstChild                                                                           *Expectation
}

// Expect returns the cell's expectation by the first matching row of the
// RCA design's table: none for YTD, not due, not applicable and not rated
// cells; a cell with no value judged by its worst readable child (available
// when that child expects anything), else none; needed when the status is
// not the best at a reporting subject, available elsewhere; available when
// at the best status but short of the ideal; else none.
func Expect(in ExpectInput) Expectation {
	switch {
	case in.YTD || in.NotDue || in.NA || in.NotRated:
		return None
	case !in.HasValueOrStatus && in.HasReadableChildren:
		if in.WorstChild != nil && *in.WorstChild != None {
			return Available
		}
		return None
	case !in.HasValueOrStatus:
		return None
	case in.Status != in.BestStatus && in.AtReportingSubject:
		return Needed
	case in.Status != in.BestStatus:
		return Available
	case in.DisplayedUnits != nil && in.IdealUnits != nil:
		if (in.Higher && *in.DisplayedUnits < *in.IdealUnits) || (!in.Higher && *in.DisplayedUnits > *in.IdealUnits) {
			return Available
		}
	}
	return None
}

// BestStatus returns the best-ranked status (lowest rank in scale) the rule
// can produce: its band statuses for bands and change rules, its step
// statuses for scale rules. Pass the cell's rule, with its subject's own
// bands in place of the rule's. Statuses outside scale are ignored; "" when
// none is left.
func BestStatus(rule domain.StatusRule, scale []domain.StatusLevel) string {
	var produced []string
	switch rule.Type {
	case domain.RuleScale:
		for _, s := range rule.Scale {
			produced = append(produced, s.Status)
		}
	default:
		for _, b := range rule.Bands {
			produced = append(produced, b.Status)
		}
	}
	best, bestRank := "", 0
	for _, s := range produced {
		for _, l := range scale {
			if l.Key == s && (best == "" || l.Rank < bestRank) {
				best, bestRank = s, l.Rank
			}
		}
	}
	return best
}

// IsReportingSubject reports whether a subject is where metric m's RCA is
// chased: it sits at one of m's reportedAt levels (by depth in levels) or is
// an item of a reportedAt item kind, and no reportedAt entry is deeper
// (items are deeper than any unit). subjectDepth is the unit's level depth.
func IsReportingSubject(m domain.Metric, levels []domain.Level, subjectDepth int, isItem bool) bool {
	depthOf := map[string]int{}
	for _, l := range levels {
		depthOf[l.ID] = l.Depth
	}
	deepest, hasItems, atLevel := -1, false, false
	for _, s := range m.ReportedAt {
		switch s.Kind {
		case domain.SubjectItemKind:
			hasItems = true
		case domain.SubjectLevel:
			d, ok := depthOf[s.ID]
			if !ok {
				continue
			}
			deepest = max(deepest, d)
			if d == subjectDepth {
				atLevel = true
			}
		}
	}
	if isItem {
		return hasItems
	}
	return atLevel && !hasItems && subjectDepth == deepest
}

// Ideal returns the metric's ideal value: 100 for percent metrics where
// higher is better (uptime, ratios) and for money plans (100% of plan);
// none for the rest, whose gap is measured from the best band's edge.
func Ideal(m domain.Metric) (float64, bool) {
	if m.ChartKind == "money_plan" {
		return 100, true
	}
	if m.ChartKind == "uptime" || (strings.HasPrefix(m.Format, "percent") && m.Direction != domain.DirectionLowerBetter) {
		return 100, true
	}
	return 0, false
}

// Decimals is the number of decimals a metric format displays (2 for an
// unknown format, as the web does).
func Decimals(format string) int {
	switch format {
	case domain.FormatPercent0, domain.FormatNumber0, domain.FormatMoneyK, domain.FormatDays0:
		return 0
	case domain.FormatPercent1, domain.FormatNumber1:
		return 1
	}
	return 2
}

// displayedNumber matches the number in a displayed value: 99.87%, $1,200k,
// 16 days, -5%.
var displayedNumber = regexp.MustCompile(`^(-)?\$?([0-9][0-9,]*(?:\.[0-9]+)?)`)

// displayedUnits reads a displayed value as whole units of 10^-decimals.
func displayedUnits(displayed string, decimals int) (int64, bool) {
	m := displayedNumber.FindStringSubmatch(strings.TrimSpace(displayed))
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(m[2], ",", ""), 64)
	if err != nil {
		return 0, false
	}
	u := int64(math.Round(v * math.Pow10(max(decimals, 0))))
	if m[1] == "-" {
		u = -u
	}
	return u, true
}

// GapUnits is ideal minus the displayed value in whole units of the display
// precision, read from the displayed text so the gap agrees with the number
// beside it (99.865 displays 99.87%, so the gap is 13 hundredths, not 14).
func GapUnits(ideal float64, displayed string, decimals int) (int64, bool) {
	d, ok := displayedUnits(displayed, decimals)
	if !ok {
		return 0, false
	}
	return int64(math.Round(ideal*math.Pow10(max(decimals, 0)))) - d, true
}
