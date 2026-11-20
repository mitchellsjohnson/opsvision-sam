package rca

import "regexp"

// ratioFormula is a ratio of two measures, optionally scaled: a / b or
// a / b * 100. It matches RATIO in web/src/features/scorecard/viewHelpers.ts.
var ratioFormula = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*/\s*([A-Za-z0-9_.-]+)\s*(?:\*\s*[0-9.]+\s*)?$`)

// RatioParts returns the numerator and denominator measure keys of a ratio
// formula, and false for any other formula. The web's ratioParts also
// requires the cell to carry exactly those two components; callers that
// need that check it themselves.
func RatioParts(formula string) (numerator, denominator string, ok bool) {
	m := ratioFormula.FindStringSubmatch(formula)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}
