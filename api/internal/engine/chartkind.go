package engine

import "opsvision/internal/domain"

var validChartKinds = map[string]bool{
	"ratio": true, "money_plan": true, "change": true, "uptime": true,
	"days": true, "discrete": true, "line": true,
}

// ChartKind picks how a metric should be charted. Order: explicit chartKind;
// else non-monthly → discrete; days0 → days; change rule → change;
// percent2 with item kinds → uptime; money-plan bands → money_plan;
// percent with bands → ratio; else line.
func ChartKind(m domain.Metric) string {
	if validChartKinds[m.ChartKind] {
		return m.ChartKind
	}
	if m.Frequency != domain.FrequencyMonthly && m.Frequency.Valid() {
		return "discrete"
	}
	if m.Format == domain.FormatDays0 {
		return "days"
	}
	if m.Rule.Type == domain.RuleChange {
		return "change"
	}
	if m.Format == domain.FormatPercent2 {
		for _, s := range m.ReportedAt {
			if s.Kind == domain.SubjectItemKind {
				return "uptime"
			}
		}
	}
	if m.Rule.Type == domain.RuleBands && MoneyPlanBands(m.Rule.Bands) {
		return "money_plan"
	}
	if isPercentFormat(m.Format) && m.Rule.Type == domain.RuleBands {
		return "ratio"
	}
	return "line"
}

func isPercentFormat(f string) bool {
	switch f {
	case domain.FormatPercent0, domain.FormatPercent1, domain.FormatPercent2:
		return true
	}
	return false
}

// MoneyPlanBands reports whether bands look like plan-vs-actual money thresholds:
// only comparison ops, at least one upper and one lower bound, every threshold
// in [50, 150], and at least one in [90, 110].
func MoneyPlanBands(bands []domain.Band) bool {
	if len(bands) == 0 {
		return false
	}
	var upper, lower bool
	var inMid bool
	for _, b := range bands {
		if b.Op == "" {
			continue
		}
		switch b.Op {
		case ">=", ">":
			upper = true
		case "<=", "<":
			lower = true
		default:
			return false
		}
		if b.Value < 50 || b.Value > 150 {
			return false
		}
		if b.Value >= 90 && b.Value <= 110 {
			inMid = true
		}
	}
	return upper && lower && inMid
}

// ResolveRule returns a copy of rule with per-subject bands applied for
// subjectID. When a per-subject entry matches, its bands replace Bands and
// PerSubject is cleared.
func ResolveRule(rule domain.StatusRule, subjectID string) domain.StatusRule {
	out := rule
	for _, ps := range rule.PerSubject {
		if ps.SubjectID == subjectID {
			out.Bands = append([]domain.Band(nil), ps.Bands...)
			break
		}
	}
	out.PerSubject = nil
	return out
}
