package legacy

import (
	"fmt"
	"math"
	"regexp"
	"strings"

	"opsvision/internal/period"
)

// convIn is what a converter sees: the generic parse of the cell (which has
// Raw, for row-specific re-parsing), the fiscal calendar and the period the
// cell is reported for.
type convIn struct {
	p   Parsed
	cal period.Calendar
	per period.Period
}

// convOut is a converter's result. vals holds a value per role. na, when
// non-empty, means the cell is not applicable: every role is written as an NA
// point carrying this reason. status is the status the workbook recorded
// ("G", "Y", "R" or ""). reported is the metric-level number the workbook
// showed, in the metric's units, for comparison with the computed value; nil
// when it cannot be compared (for example a ratio, whose percentage is derived).
type convOut struct {
	vals     map[string]float64
	na       string
	status   string
	reported *float64
}

type converter func(convIn) (convOut, error)

var converters = map[string]converter{
	ConvertRatio:          convRatio,
	ConvertValue:          convValue,
	ConvertMoneyK:         convMoneyK,
	ConvertUptimePercent:  convUptimePercent,
	ConvertUptimeFraction: convUptimeFraction,
	ConvertScoreOfMax:     convScoreOfMax,
	ConvertDailyAverage:   convDailyAverage,
	ConvertMoneyMTriple:   convMoneyMTriple,
	ConvertPctSlashCount:  convPctSlashCount,
}

// zeroOverZero is the reason written for a 0/0 ratio.
const zeroOverZero = "Not applicable (0/0)"

func round6(x float64) float64 { return math.Round(x*1e6) / 1e6 }

func mismatch(want string, p Parsed) error {
	if p.Kind == Unparsed {
		return fmt.Errorf("expected %s but the text is not in a known format", want)
	}
	return fmt.Errorf("expected %s but found a %s", want, strings.ToLower(p.Kind.String()))
}

func single(role string, v float64, p Parsed) convOut {
	return convOut{vals: map[string]float64{role: v}, status: p.Status, reported: &v}
}

func convRatio(in convIn) (convOut, error) {
	p := in.p
	var num, den float64
	switch p.Kind {
	case Ratio:
		num, den = *p.Num, *p.Den
	case ScoreOfMax:
		// A bare "3|4" or "0|0" is read as a score out of a maximum; in a ratio
		// row it is a numerator and a denominator.
		num, den = *p.Value, *p.Max
	default:
		return convOut{}, mismatch("a ratio like 48|66", p)
	}
	switch {
	case den == 0 && num == 0:
		return convOut{na: zeroOverZero, status: p.Status}, nil
	case den <= 0 || num < 0:
		return convOut{}, fmt.Errorf("ratio %v/%v has a zero or negative denominator or a negative numerator", num, den)
	}
	return convOut{vals: map[string]float64{"num": num, "den": den}, status: p.Status}, nil
}

func convValue(in convIn) (convOut, error) {
	p := in.p
	switch p.Kind {
	case Percent, Number, ScoreChange:
		return single("value", *p.Value, p), nil
	}
	return convOut{}, mismatch("a number or percent", p)
}

func convMoneyK(in convIn) (convOut, error) {
	if in.p.Kind != Money {
		return convOut{}, mismatch("an amount in thousands like $8,234k", in.p)
	}
	return single("value", *in.p.Value, in.p), nil
}

// uptimeOut turns an availability fraction (0..1) into down and period seconds.
func uptimeOut(in convIn, fraction float64, reported float64) convOut {
	sec := float64(in.cal.Seconds(in.per))
	down := math.Round((1 - fraction) * sec)
	if down < 0 {
		down = 0
	}
	return convOut{vals: map[string]float64{"down": down, "period": sec}, status: in.p.Status, reported: &reported}
}

func convUptimePercent(in convIn) (convOut, error) {
	p := in.p
	if p.Kind != Percent && p.Kind != Number {
		return convOut{}, mismatch("an uptime percent like 99.64%", p)
	}
	v := *p.Value
	if v < 0 || v > 100 {
		return convOut{}, fmt.Errorf("uptime %v%% is outside 0..100", v)
	}
	return uptimeOut(in, v/100, v), nil
}

func convUptimeFraction(in convIn) (convOut, error) {
	p := in.p
	if p.Kind != Number {
		return convOut{}, mismatch("an uptime fraction like 0.9964", p)
	}
	v := *p.Value
	if v < 0 || v > 1 {
		return convOut{}, fmt.Errorf("uptime fraction %v is outside 0..1", v)
	}
	// reported is in percent (0..100), like uptime_percent and the metric.
	return uptimeOut(in, v, v*100), nil
}

func convScoreOfMax(in convIn) (convOut, error) {
	p := in.p
	if p.Kind != ScoreOfMax {
		return convOut{}, mismatch("a score out of a maximum like 7 | 10", p)
	}
	if *p.Max <= 0 {
		return convOut{}, fmt.Errorf("maximum %v is not positive", *p.Max)
	}
	return convOut{vals: map[string]float64{"value": *p.Value, "max": *p.Max}, status: p.Status}, nil
}

func convDailyAverage(in convIn) (convOut, error) {
	p := in.p
	if p.Kind != Number {
		return convOut{}, mismatch("a daily average number", p)
	}
	days := float64(in.cal.Seconds(in.per)) / 86400
	v := *p.Value
	return convOut{vals: map[string]float64{"sum": round6(v * days), "days": days}, status: p.Status, reported: &v}, nil
}

var (
	// "$1.25M | +0.10M | +8%" (the "$" is optional, signs may be + - or ±),
	// optionally followed by a status, which splitStatus has already removed.
	moneyMTripleRe = regexp.MustCompile(`(?i)^\$?\s*(` + numPat + `)\s*m\s*\|\s*[±+-]?\s*\$?\s*` + numPat + `\s*m\s*\|\s*[±+-]?\s*` + numPat + `\s*%$`)
	// "85% / 12" (a percent and a count), status already removed.
	pctSlashCountRe = regexp.MustCompile(`^(` + numPat + `)\s*%\s*/\s*[\d,]+$`)
)

// splitStatus separates a trailing status token from normalized cell text.
func splitStatus(raw string) (body, status string) {
	s := strings.TrimSpace(cellNormalizer.Replace(raw))
	if m := statusRe.FindStringSubmatchIndex(s); m != nil {
		return strings.TrimSpace(s[:m[0]]), strings.ToUpper(s[m[4]:m[5]])
	}
	return s, ""
}

// convMoneyMTriple reads "$N.NNM | ±N.NNM | ±P%" and keeps the amount, in
// thousands. Unlike the general parser it also accepts the form without "$".
func convMoneyMTriple(in convIn) (convOut, error) {
	body, status := splitStatus(in.p.Raw)
	m := moneyMTripleRe.FindStringSubmatch(body)
	if m == nil {
		return convOut{}, fmt.Errorf("expected an amount in millions like $1.25M | +0.10M | +8%%")
	}
	v := parseNum(m[1])
	if v == nil {
		return convOut{}, fmt.Errorf("cannot read the amount %q", m[1])
	}
	k := round6(*v * 1000)
	return convOut{vals: map[string]float64{"value": k}, status: status, reported: &k}, nil
}

// convPctSlashCount reads "P% / n / S" and keeps P.
func convPctSlashCount(in convIn) (convOut, error) {
	body, status := splitStatus(in.p.Raw)
	m := pctSlashCountRe.FindStringSubmatch(body)
	if m == nil {
		return convOut{}, fmt.Errorf("expected a percent and a count like 85%% / 12 / Y")
	}
	v := parseNum(m[1])
	if v == nil {
		return convOut{}, fmt.Errorf("cannot read the percent %q", m[1])
	}
	return convOut{vals: map[string]float64{"value": *v}, status: status, reported: v}, nil
}
