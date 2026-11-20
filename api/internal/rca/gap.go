package rca

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/engine"
)

// Gap kinds, as in the API.
const (
	KindDowntime = "downtime"
	KindRatio    = "ratio"
	KindPercent  = "percent"
	KindPlan     = "plan"
	KindMoney    = "money"
	KindBand     = "band"
	KindDays     = "days"
	KindScale    = "scale"
	KindChange   = "change"
	KindNone     = "none"
)

// Gap is a cell's gap: its kind, the ideal (nil when the metric has none),
// the displayed gap in whole units of the display precision (nil for change
// rules and when there is no gap), and the card's two lines.
type Gap struct {
	Kind             string
	Ideal            *float64
	Units            *int64
	Decimals         int
	Headline, Detail string
}

// CellFacts is what GapOf reads from a cell: its displayed value and
// status, the exact value, its components, and the change that judged it
// (an improvement percentage, positive when better) for change rules.
type CellFacts struct {
	Display, Status string
	Value           *float64
	Components      map[string]float64
	Change          *float64
}

// RecordSummary is the records behind a ratio: Misses of Denominator records
// missed, Noun the record type's plural (epics).
type RecordSummary struct {
	Noun                string
	Misses, Denominator int
}

// GapInput is everything GapOf needs. Metric carries the cell's rule (with
// the subject's own bands in place of the rule's). StatusLabel names a status
// key (nil, or an empty answer, shows the key). Threshold is the sentence
// that decides the status (the web's thresholdText at the focus surface).
// Downtime, when set, gives the reported minutes; FromValue says they were
// derived from the displayed value rather than read from a measure.
// ComparedLabel names a change rule's comparison period (Sep).
type GapInput struct {
	Metric        domain.Metric
	Cell          CellFacts
	StatusLabel   func(string) string
	Threshold     string
	Downtime      *Downtime
	FromValue     bool
	Records       *RecordSummary
	ComparedLabel string
}

// GapOf returns the cell's gap, measured from its displayed value: points
// short of 100% for downtime, ratio and higher-is-better percent metrics;
// percent over plan for money plans (only when over); the distance past the
// best band's edge for the rest, the best step's minimum for scale rules,
// and the change that set the status for change rules. A cell at its best
// status but short of 100% says no RCA is needed. A cell with no gap, or no
// readable value, is KindNone with an empty headline.
func GapOf(in GapInput) Gap {
	m := in.Metric
	d := Decimals(m.Format)
	label := func(s string) string {
		if in.StatusLabel != nil {
			if l := in.StatusLabel(s); l != "" {
				return l
			}
		}
		return s
	}
	var detail []string
	if in.Cell.Status != "" {
		detail = append(detail, label(in.Cell.Status))
	}
	if in.Threshold != "" {
		detail = append(detail, in.Threshold)
	}
	g := Gap{Kind: KindNone, Decimals: d, Detail: strings.Join(detail, " · ")}
	higher := m.Direction != domain.DirectionLowerBetter

	switch {
	case m.ChartKind == "uptime" || in.Downtime != nil:
		return idealGap(g, in, KindDowntime, label)
	case m.Rule.Type == domain.RuleChange:
		return changeGap(g, in, label)
	case m.ChartKind == "money_plan":
		return planGap(g, in)
	case strings.HasPrefix(m.Format, "percent") && higher:
		if _, _, ok := RatioParts(m.Formula); ok {
			return idealGap(g, in, KindRatio, label)
		}
		return idealGap(g, in, KindPercent, label)
	case m.Rule.Type == domain.RuleScale:
		return scaleGap(g, in, label)
	}
	return bandGap(g, in, higher, label)
}

// idealGap is the gap to 100% for downtime, ratio and percent metrics.
func idealGap(g Gap, in GapInput, kind string, label func(string) string) Gap {
	units, ok := GapUnits(100, in.Cell.Display, g.Decimals)
	if !ok || units <= 0 {
		return g
	}
	ideal := 100.0
	g.Kind, g.Ideal, g.Units = kind, &ideal, &units
	head := unitsText(units, g.Decimals) + " pts short of 100%"
	m := in.Metric
	best, _, _, hasBest := bestBand(m.Rule.Bands, true)
	if m.Rule.Type == domain.RuleBands && hasBest && in.Cell.Status == best {
		g.Headline = head + " · no RCA needed"
		return g
	}
	switch kind {
	case KindDowntime:
		if in.Downtime != nil {
			head += " · " + Duration(in.Downtime.ReportedMinutes) + " down"
			if in.FromValue {
				head += " (from the value)"
			}
		}
	case KindRatio:
		num, den, _ := RatioParts(m.Formula)
		denominator := 0.0
		switch {
		case in.Records != nil:
			denominator = float64(in.Records.Denominator)
			head += fmt.Sprintf(" · %d of %d %s missed", in.Records.Misses, in.Records.Denominator, in.Records.Noun)
		case hasComponents(in.Cell.Components, num, den):
			denominator = in.Cell.Components[den]
			short := denominator - in.Cell.Components[num]
			head += fmt.Sprintf(" · %s of %s missed", trimmed(short, 2), trimmed(denominator, 2))
		}
		if denominator > 0 {
			g.Detail = joinDetail(g.Detail, "each miss costs "+trimmed(100/denominator, g.Decimals+1)+" pts")
		}
	}
	g.Headline = head
	return g
}

// planGap is percent over plan, only when over, with the amount over.
func planGap(g Gap, in GapInput) Gap {
	units, ok := GapUnits(100, in.Cell.Display, g.Decimals)
	if !ok || units >= 0 {
		return g
	}
	over := -units
	ideal := 100.0
	g.Kind, g.Ideal, g.Units = KindPlan, &ideal, &over
	head := unitsText(over, g.Decimals) + "% over plan"
	if num, den, ok := RatioParts(in.Metric.Formula); ok && hasComponents(in.Cell.Components, num, den) {
		if amount := in.Cell.Components[num] - in.Cell.Components[den]; amount > 0 {
			head += " · " + engine.Format(domain.FormatMoneyK, amount) + " over"
		}
	}
	g.Headline = head
	return g
}

// bandGap is the distance past the best band's edge.
func bandGap(g Gap, in GapInput, higher bool, label func(string) string) Gap {
	m := in.Metric
	best, edge, inclusive, ok := bestBand(m.Rule.Bands, higher)
	du, okD := displayedUnits(in.Cell.Display, g.Decimals)
	if !ok || !okD {
		return g
	}
	scale := math.Pow10(g.Decimals)
	edgeUnits := int64(math.Round(edge * scale))
	dist := du - edgeUnits
	if higher {
		dist = edgeUnits - du
	}
	if dist <= 0 {
		return g
	}
	g.Units = &dist
	edgeText := engine.Format(m.Format, edge)
	distText := distanceText(m.Format, dist, g.Decimals)
	switch {
	case m.Format == domain.FormatMoneyK:
		g.Kind = KindMoney
	case m.Format == domain.FormatDays0:
		g.Kind = KindDays
	default:
		g.Kind = KindBand
	}
	switch {
	case higher:
		g.Headline = fmt.Sprintf("%s below the %s line (%s)", distText, label(best), bound(edgeText, inclusive, "or more", "more than"))
	case g.Kind == KindDays:
		g.Headline = fmt.Sprintf("%s past the %s line (%s)", distText, label(best), bound(edgeText, inclusive, "or fewer", "fewer than"))
	default:
		g.Headline = fmt.Sprintf("%s above the %s line (%s)", distText, label(best), bound(edgeText, inclusive, "or less", "less than"))
	}
	return g
}

// scaleGap is the distance to the best step's minimum (the highest step).
func scaleGap(g Gap, in GapInput, label func(string) string) Gap {
	m := in.Metric
	if len(m.Rule.Scale) == 0 {
		return g
	}
	best := slices.MaxFunc(m.Rule.Scale, func(a, b domain.ScaleStep) int { return cmp.Compare(a.Min, b.Min) })
	du, ok := displayedUnits(in.Cell.Display, g.Decimals)
	if !ok {
		return g
	}
	dist := int64(math.Round(best.Min*math.Pow10(g.Decimals))) - du
	if dist <= 0 {
		return g
	}
	g.Kind, g.Units = KindScale, &dist
	g.Headline = fmt.Sprintf("%s below the %s step (%s or more)", distanceText(m.Format, dist, g.Decimals), label(best.Status), engine.Format(m.Format, best.Min))
	return g
}

// changeGap states the change that set the status, and what the best band
// needs.
func changeGap(g Gap, in GapInput, label func(string) string) Gap {
	g.Kind = KindChange
	if in.Cell.Change == nil {
		return g
	}
	ch := *in.Cell.Change
	against := cmp.Or(in.ComparedLabel, "the comparison")
	p := trimmed(math.Abs(ch), 1)
	switch {
	case p == "0":
		g.Headline = "No change from " + against
	case ch < 0:
		g.Headline = fmt.Sprintf("%s%% worse than %s", p, against)
	default:
		g.Headline = fmt.Sprintf("%s%% better than %s", p, against)
	}
	if best, lo, inclusive, ok := bestBand(in.Metric.Rule.Bands, true); ok {
		g.Headline += fmt.Sprintf(" · %s needs %s", label(best), improvementRange(lo, inclusive))
	}
	return g
}

// improvementRange phrases the best band of a change rule, which runs from
// lo up: any improvement, 5% better or more, no more than 5% worse.
func improvementRange(lo float64, inclusive bool) string {
	pct := trimmed(math.Abs(lo), 1) + "%"
	switch {
	case lo == 0:
		return "any improvement"
	case lo > 0 && inclusive:
		return pct + " better or more"
	case lo > 0:
		return "more than " + pct + " better"
	case inclusive:
		return "no more than " + pct + " worse"
	}
	return "less than " + pct + " worse"
}

// bestBand finds the band status at the good extreme (+∞ when higher is
// better, −∞ when lower is) and the edge where it ends: the threshold value,
// and whether the edge value itself is still in the best band. ok is false
// with no bands, or when the best status covers every value.
func bestBand(bands []domain.Band, higher bool) (status string, edge float64, inclusive, ok bool) {
	toward, away := math.Inf(1), math.Inf(-1)
	if !higher {
		toward, away = away, toward
	}
	status = statusAt(bands, toward)
	if status == "" {
		return "", 0, false, false
	}
	var vals []float64
	for _, b := range bands {
		if b.Op != "" {
			vals = append(vals, b.Value)
		}
	}
	slices.Sort(vals)
	vals = slices.Compact(vals)
	if higher {
		slices.Reverse(vals)
	}
	for _, t := range vals {
		if statusAt(bands, t) != status {
			return status, t, false, true
		}
		if statusAt(bands, math.Nextafter(t, away)) != status {
			return status, t, true, true
		}
	}
	return status, 0, false, false
}

// statusAt is the status of the first band matching v, as the engine
// evaluates bands.
func statusAt(bands []domain.Band, v float64) string {
	for _, b := range bands {
		switch {
		case b.Op == "",
			b.Op == ">=" && v >= b.Value,
			b.Op == ">" && v > b.Value,
			b.Op == "<=" && v <= b.Value,
			b.Op == "<" && v < b.Value:
			return b.Status
		}
	}
	return ""
}

// distanceText formats a distance of whole units in the metric's terms:
// points for percents, money and days as the format shows them, else a
// number.
func distanceText(format string, units int64, decimals int) string {
	v := float64(units) / math.Pow10(decimals)
	switch {
	case strings.HasPrefix(format, "percent"):
		return engine.Format("number"+strconv.Itoa(decimals), v) + " pts"
	case format == domain.FormatMoneyK || format == domain.FormatDays0:
		return engine.Format(format, v)
	}
	return engine.Format("number"+strconv.Itoa(decimals), v)
}

// bound is "450 or less" for an inclusive edge, "less than 450" otherwise.
func bound(edge string, inclusive bool, after, before string) string {
	if inclusive {
		return edge + " " + after
	}
	return before + " " + edge
}

func joinDetail(detail, more string) string {
	if detail == "" {
		return more
	}
	return detail + " · " + more
}

func hasComponents(c map[string]float64, keys ...string) bool {
	for _, k := range keys {
		if _, ok := c[k]; !ok {
			return false
		}
	}
	return len(keys) > 0
}
