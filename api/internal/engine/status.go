package engine

import (
	"math"
	"sort"

	"opsvision/internal/domain"
)

// EvalStatus derives a status from a metric value under rule. subjectID picks
// PerSubject bands (which replace the rule's own bands for that subject).
//
// Bands rules compare value against the bands in order; the first match wins,
// and the final band with Op "" matches anything. A rule with no matching band
// yields "".
//
// Scale rules take the step with the highest Min that value reaches.
//
// Change rules judge improvement instead of the raw value: comparison is the
// reference (prior period, prior-year average or baseline) and the bands are
// evaluated on the improvement percentage, which is also returned as change.
// With no comparison, or a zero reference and a non-zero value (a percentage
// of zero is undefined), the status is "" and change is nil. For non-change
// rules change is always nil.
func EvalStatus(rule domain.StatusRule, dir domain.Direction, subjectID string, value float64, comparison *float64) (status string, change *float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", nil
	}
	switch rule.Type {
	case domain.RuleBands:
		return evalBands(bandsFor(rule, subjectID), value), nil
	case domain.RuleScale:
		return evalScale(rule.Scale, value), nil
	case domain.RuleChange:
		if comparison == nil {
			return "", nil
		}
		imp, ok := improvement(dir, value, *comparison)
		if !ok {
			return "", nil
		}
		return evalBands(bandsFor(rule, subjectID), imp), &imp
	}
	return "", nil
}

// improvement returns the percentage by which cur is better than cmp, where
// "better" is lower for DirectionLowerBetter and higher otherwise. The
// percentage is relative to the magnitude of cmp, so that a move in the better
// direction is always positive even when cmp is negative. cmp == 0 gives 0 when
// cur is also 0 and is undefined (ok false) otherwise.
func improvement(dir domain.Direction, cur, cmp float64) (imp float64, ok bool) {
	if math.IsNaN(cur) || math.IsInf(cur, 0) || math.IsNaN(cmp) || math.IsInf(cmp, 0) {
		return 0, false
	}
	if cmp == 0 {
		if cur == 0 {
			return 0, true
		}
		return 0, false
	}
	diff := cur - cmp
	if dir == domain.DirectionLowerBetter {
		diff = cmp - cur
	}
	imp = diff / math.Abs(cmp) * 100
	if math.IsNaN(imp) || math.IsInf(imp, 0) {
		return 0, false
	}
	return imp, true
}

func bandsFor(rule domain.StatusRule, subjectID string) []domain.Band {
	for _, ps := range rule.PerSubject {
		if ps.SubjectID == subjectID {
			return ps.Bands
		}
	}
	return rule.Bands
}

func evalBands(bands []domain.Band, v float64) string {
	for _, b := range bands {
		switch b.Op {
		case "":
			return b.Status
		case ">=":
			if v >= b.Value {
				return b.Status
			}
		case ">":
			if v > b.Value {
				return b.Status
			}
		case "<=":
			if v <= b.Value {
				return b.Status
			}
		case "<":
			if v < b.Value {
				return b.Status
			}
		}
	}
	return ""
}

func evalScale(scale []domain.ScaleStep, v float64) string {
	steps := append([]domain.ScaleStep(nil), scale...)
	sort.SliceStable(steps, func(i, j int) bool { return steps[i].Min > steps[j].Min })
	for _, s := range steps {
		if v >= s.Min {
			return s.Status
		}
	}
	return ""
}
