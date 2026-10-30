package legacy

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"opsvision/internal/domain"
)

// bound is one comparison, such as ">= 90".
type bound struct {
	op  string
	val float64
}

// threshold is a parsed threshold text: an optional lower and upper bound.
type threshold struct {
	lo, hi *bound
}

var (
	bandNum = `(\d+(?:\.\d+)?|\.\d+)`
	cmpRe   = regexp.MustCompile(`^(>=|<=|>|<)\s*` + bandNum + `\s*%?`)
	rangeRe = regexp.MustCompile(`^-\s*` + bandNum + `\s*%?`)
	// A bare number is only understood with the word "uptime" ("99.9% uptime").
	bareRe   = regexp.MustCompile(`^` + bandNum + `\s*%?\s*uptime$`)
	rangeAbs = regexp.MustCompile(`^` + bandNum + `\s*%?\s*-\s*` + bandNum + `\s*%?$`)
	plusRe   = regexp.MustCompile(`^` + bandNum + `\s*%?\s*\+$`)
)

// parseThreshold parses one threshold text. The whole text must be consumed.
func parseThreshold(text string) (threshold, error) {
	s := strings.ToLower(strings.TrimSpace(cellNormalizer.Replace(text)))
	s = strings.NewReplacer("≥", ">=", "≤", "<=").Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	var t threshold
	if s == "" {
		return t, fmt.Errorf("empty threshold text")
	}
	// Whole-text forms first: "99.9% uptime", "18+", "14 - 17".
	if m := bareRe.FindStringSubmatch(s); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		t.lo = &bound{">=", v}
		return t, nil
	}
	if m := plusRe.FindStringSubmatch(s); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		t.lo = &bound{">=", v}
		return t, nil
	}
	if m := rangeAbs.FindStringSubmatch(s); m != nil {
		a, _ := strconv.ParseFloat(m[1], 64)
		b, _ := strconv.ParseFloat(m[2], 64)
		if a > b {
			return t, fmt.Errorf("threshold %q: range is reversed", text)
		}
		t.lo, t.hi = &bound{">=", a}, &bound{"<=", b}
		return t, nil
	}
	// Comparisons, optionally followed by "- N" (an inclusive upper bound).
	rest := s
	for rest != "" {
		if m := cmpRe.FindStringSubmatch(rest); m != nil {
			v, _ := strconv.ParseFloat(m[2], 64)
			b := &bound{m[1], v}
			if m[1][0] == '>' {
				if t.lo != nil {
					return t, fmt.Errorf("threshold %q: two lower bounds", text)
				}
				t.lo = b
			} else {
				if t.hi != nil {
					return t, fmt.Errorf("threshold %q: two upper bounds", text)
				}
				t.hi = b
			}
			rest = strings.TrimSpace(rest[len(m[0]):])
			continue
		}
		if m := rangeRe.FindStringSubmatch(rest); m != nil && t.lo != nil && t.hi == nil {
			v, _ := strconv.ParseFloat(m[1], 64)
			t.hi = &bound{"<=", v}
			rest = strings.TrimSpace(rest[len(m[0]):])
			continue
		}
		return t, fmt.Errorf("cannot parse threshold text %q", text)
	}
	return t, nil
}

// ParseBandText turns the green, yellow and red threshold texts of a legacy
// metric into status bands (G, Y, then R as the else band) and the inferred
// direction. The G band comes from the green text's single bound, the Y band
// from the yellow text's bound farther from green. Change-style texts and
// grade scales are rejected; those are set manually.
func ParseBandText(green, yellow, red string) ([]domain.Band, domain.Direction, error) {
	g, err := parseThreshold(green)
	if err != nil {
		return nil, "", fmt.Errorf("green: %w", err)
	}
	if (g.lo == nil) == (g.hi == nil) {
		return nil, "", fmt.Errorf("green: %q must have exactly one bound", green)
	}
	y, err := parseThreshold(yellow)
	if err != nil {
		return nil, "", fmt.Errorf("yellow: %w", err)
	}
	dir := domain.DirectionHigherBetter
	gb, yb := g.lo, y.lo
	if g.hi != nil {
		dir = domain.DirectionLowerBetter
		gb, yb = g.hi, y.hi
	}
	if yb == nil {
		return nil, "", fmt.Errorf("yellow: %q has no bound on the far side of green", yellow)
	}
	if !beyond(dir, *yb, *gb) {
		return nil, "", fmt.Errorf("yellow %q is not on the far side of green %q", yellow, green)
	}
	// Red is the else band, so free text is fine. Text that does parse must
	// agree with the bands above it.
	if r, err := parseThreshold(red); err == nil {
		if dir == domain.DirectionHigherBetter && (r.hi == nil || r.hi.val > yb.val) ||
			dir == domain.DirectionLowerBetter && (r.lo == nil || r.lo.val < yb.val) {
			return nil, "", fmt.Errorf("red %q contradicts yellow %q", red, yellow)
		}
	}
	return []domain.Band{
		{Status: "G", Op: gb.op, Value: gb.val},
		{Status: "Y", Op: yb.op, Value: yb.val},
		{Status: "R", Op: "", Value: 0},
	}, dir, nil
}

// beyond reports whether y lies strictly beyond g, away from the good side:
// below g for higher-is-better, above g for lower-is-better. Equal values
// count only when green's comparison is strict and yellow's is inclusive.
func beyond(dir domain.Direction, y, g bound) bool {
	if y.val == g.val {
		return (g.op == ">" || g.op == "<") && (y.op == ">=" || y.op == "<=")
	}
	if dir == domain.DirectionHigherBetter {
		return y.val < g.val
	}
	return y.val > g.val
}
