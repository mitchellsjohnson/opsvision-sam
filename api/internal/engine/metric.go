package engine

import (
	"errors"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/formula"
	"opsvision/internal/period"
)

// Values of Cell.ChangeKind.
const (
	// ChangeImprovementPct: Change is the improvement percentage used by
	// change-type status rules (positive is better).
	ChangeImprovementPct = "improvement_pct"
	// ChangeDelta: Change is current minus prior, in the metric's display
	// units.
	ChangeDelta = "delta"
)

// Computed is what the engine calculated before a manual override was applied.
type Computed struct {
	Value  *float64 `json:"value"`
	Status string   `json:"status"`
}

// Cell is one metric's result for one subject and period: the number, how to
// show it, how it is judged, and where it came from.
type Cell struct {
	MetricKey string        `json:"metricKey"`
	SubjectID string        `json:"subjectId"`
	Period    period.Period `json:"period"`
	// YTD is true for a fiscal year-to-date cell; Period is then the month
	// the year-to-date runs through.
	YTD bool `json:"ytd"`
	// Value is nil when the cell is blank (missing input) or not applicable.
	Value   *float64 `json:"value"`
	Display string   `json:"display"`
	// Status is "" when there is no value or no rule outcome.
	Status string `json:"status"`
	// NAReason is set only for not-applicable cells; a blank cell (missing
	// input) has no NAReason.
	NAReason string `json:"naReason"`
	// Components holds the rolled-up value of each measure the formula
	// references (only those that have a value).
	Components map[string]float64 `json:"components"`
	// Coverage is [slots with data, slots expected], taking the measure with
	// the least data.
	Coverage [2]int `json:"coverage"`
	// Change is described by ChangeKind; nil when there is nothing to compare.
	Change     *float64 `json:"change"`
	ChangeKind string   `json:"changeKind"`
	// Target is the goal applicable to this cell, if any.
	Target    *float64         `json:"target"`
	VersionID string           `json:"versionId"`
	Override  *domain.Override `json:"override,omitempty"`
	// Computed is set only when an override applied.
	Computed *Computed `json:"computed,omitempty"`
}

// span is the set of months a cell covers.
type span struct {
	months []period.Period
	// period is what Cell.Period reports.
	period period.Period
	ytd    bool
}

func (ix *Index) monthSpan(p period.Period) span {
	return span{months: ix.cal.Months(p), period: p}
}

func (ix *Index) ytdSpan(through period.Period) span {
	return span{months: ix.cal.YTD(through), period: through, ytd: true}
}

// prior is the span of the preceding comparable period: the previous period
// for a normal cell, the same year-to-date point one fiscal year earlier for a
// YTD cell.
func (ix *Index) prior(s span) span {
	if s.ytd {
		return ix.ytdSpan(ix.cal.SameLastYear(s.period))
	}
	return ix.monthSpan(ix.cal.Prev(s.period))
}

// Cell computes metric m for subjectID over period p (any grain) using the
// definitions in v. Overrides recorded for exactly (m, subjectID, p) apply.
func (ix *Index) Cell(v domain.MethodologyVersion, m domain.Metric, subjectID string, p period.Period) Cell {
	return ix.cell(v, m, subjectID, ix.monthSpan(p))
}

// CellYTD computes metric m for subjectID over the fiscal year to date,
// through the month through. Cell.Period is through and Cell.YTD is true.
// Overrides never apply to year-to-date cells.
func (ix *Index) CellYTD(v domain.MethodologyVersion, m domain.Metric, subjectID string, through period.Period) Cell {
	return ix.cell(v, m, subjectID, ix.ytdSpan(through))
}

func (ix *Index) cell(v domain.MethodologyVersion, m domain.Metric, subjectID string, sp span) Cell {
	c := ix.base(v, m, subjectID, sp)
	isChange := m.Rule.Type == domain.RuleChange

	var ov *domain.Override
	if !sp.ytd {
		if o, ok := ix.overrides[overrideKey{m.Key, subjectID, sp.period}]; ok {
			ov = &o
		}
	}
	// The value the cell will show: the override's, if it sets one.
	final := c.Value
	if ov != nil && ov.Value != nil {
		final = ov.Value
	}

	// Reference value for change rules, fetched whenever there is a value to
	// judge. A prior cell's value is read as displayed (overrides included),
	// here and for deltas below.
	var cmp *float64
	if isChange && final != nil {
		cmp = ix.comparison(v, m, subjectID, sp)
	}
	engineStatus := judge(m, subjectID, c.Value, cmp)
	c.Status = engineStatus

	if ov != nil {
		c.Computed = &Computed{Value: copyFloat(c.Value), Status: engineStatus}
		o := *ov
		o.Value = copyFloat(ov.Value)
		c.Override = &o
		if ov.Value != nil {
			c.Value = copyFloat(ov.Value)
			c.Display = Format(m.Format, *ov.Value)
			c.NAReason = ""
			// A new value is re-judged through the normal rule path.
			c.Status = judge(m, subjectID, c.Value, cmp)
		}
		if ov.Status != "" {
			c.Status = ov.Status
		}
	}

	switch {
	case isChange:
		if c.Value != nil && cmp != nil {
			if imp, ok := improvement(m.Direction, *c.Value, *cmp); ok {
				c.Change, c.ChangeKind = &imp, ChangeImprovementPct
			}
		}
	case c.Value != nil:
		if prior := ix.valueOf(v, m, subjectID, ix.prior(sp)); prior != nil {
			d := *c.Value - *prior
			c.Change, c.ChangeKind = &d, ChangeDelta
		}
	}
	return c
}

// judge derives a status for value val under m's rule. Bands and scale rules
// are judged on the value rounded to the metric's display precision, so a
// status always agrees with the number shown. Change rules use the unrounded
// value and reference, because improvement percentages are computed from the
// underlying numbers.
func judge(m domain.Metric, subjectID string, val, cmp *float64) string {
	if val == nil {
		return ""
	}
	x := *val
	if m.Rule.Type != domain.RuleChange {
		x = roundForDisplay(m.Format, x)
	}
	status, _ := EvalStatus(m.Rule, m.Direction, subjectID, x, cmp)
	return status
}

func copyFloat(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// valueOf returns the displayed value of metric m over sp (override included
// for non-YTD spans), without computing status or change.
func (ix *Index) valueOf(v domain.MethodologyVersion, m domain.Metric, subjectID string, sp span) *float64 {
	c := ix.base(v, m, subjectID, sp)
	if !sp.ytd {
		if ov, ok := ix.overrides[overrideKey{m.Key, subjectID, sp.period}]; ok && ov.Value != nil {
			return copyFloat(ov.Value)
		}
	}
	return c.Value
}

// comparison returns the reference value for a change rule, or nil when it is
// not available.
func (ix *Index) comparison(v domain.MethodologyVersion, m domain.Metric, subjectID string, sp span) *float64 {
	switch m.Rule.Compare {
	case domain.ComparePriorPeriod:
		return ix.valueOf(v, m, subjectID, ix.prior(sp))
	case domain.ComparePriorYearAverage:
		return ix.priorYearValue(v, m, subjectID, sp)
	case domain.CompareBaseline:
		if t, ok := ix.pickTarget(m.Targets, subjectID, sp.months, true); ok {
			val := t.Value
			return &val
		}
	}
	return nil
}

// priorYearValue is the metric's own value over the whole previous fiscal
// year: the formula applied to full-year rolled-up measures, which is the base
// value of the year-to-date cell through the last month of that year. It is
// the same reference whatever the grain of the cell being judged (month,
// quarter, half or YTD), so sums and ratios are compared like for like.
func (ix *Index) priorYearValue(v domain.MethodologyVersion, m domain.Metric, subjectID string, sp span) *float64 {
	last := period.Period{Grain: period.Month, FY: sp.period.FY - 1, Index: 12}
	return ix.base(v, m, subjectID, ix.ytdSpan(last)).Value
}

// grainOf maps a metric's reporting frequency to the grain its data is
// entered at.
func grainOf(f domain.Frequency) (period.Grain, bool) {
	switch f {
	case domain.FrequencyMonthly:
		return period.Month, true
	case domain.FrequencyQuarterly:
		return period.Quarter, true
	case domain.FrequencyBiannual:
		return period.Half, true
	case domain.FrequencyAnnual:
		return period.Year, true
	}
	return 0, false
}

// base computes everything about a cell that does not depend on status rules
// or overrides: identity, value, display, not-applicable reason, components,
// coverage and target.
func (ix *Index) base(v domain.MethodologyVersion, m domain.Metric, subjectID string, sp span) Cell {
	c := Cell{
		MetricKey: m.Key,
		SubjectID: subjectID,
		Period:    sp.period,
		YTD:       sp.ytd,
		VersionID: v.ID,
	}
	if t, ok := ix.pickTarget(m.Targets, subjectID, sp.months, false); ok {
		val := t.Value
		c.Target = &val
	}

	grain, ok := grainOf(m.Frequency)
	if !ok {
		return c
	}
	slots := Slots(ix.cal, grain, sp.months)
	if len(slots) == 0 {
		return c
	}
	cm := ix.compiledFor(v, m)
	if cm.err != nil {
		return c // an uncomputable metric is blank, never a wrong number
	}
	f, defs, idents := cm.f, cm.defs, cm.idents

	vars := make(map[string]float64, len(idents))
	have := len(slots)
	missing := false
	var naReasons []string
	for _, id := range idents {
		def, ok := defs[id]
		if !ok {
			missing = true
			have = 0
			continue
		}
		val, ok := ix.Measure(def, subjectID, slots, m.RollItemsToOrg)
		switch {
		case !ok:
			missing = true
			have = 0
		case val.NAReason != "":
			naReasons = append(naReasons, val.NAReason)
			have = 0
		default:
			vars[id] = val.V
			have = min(have, val.Have)
		}
	}
	c.Coverage = [2]int{have, len(slots)}
	if len(vars) > 0 {
		c.Components = make(map[string]float64, len(vars))
		for id, val := range vars {
			c.Components[id] = val
		}
	}
	if missing {
		return c
	}
	if len(naReasons) > 0 {
		c.NAReason = naReasons[0]
		for _, r := range naReasons[1:] {
			if r != c.NAReason {
				c.NAReason = NotApplicable
				break
			}
		}
		return c
	}

	res, err := f.Eval(vars)
	if err != nil {
		if errors.Is(err, formula.ErrDivByZero) || errors.Is(err, formula.ErrNotFinite) {
			c.NAReason = NotApplicable
		}
		return c
	}
	c.Value = &res
	c.Display = Format(m.Format, res)
	return c
}

// compiledMetric is a metric's formula compiled against its version's
// measures, with the pieces base needs on every call.
type compiledMetric struct {
	f      *formula.Formula
	defs   map[string]domain.Measure
	idents []string
	err    error
}

// compiledKey identifies a compiled metric. The formula text is part of the
// key so a metric edited under an unchanged version ID cannot reuse a stale
// compilation.
type compiledKey struct {
	version string
	metric  string
	formula string
}

// compiledFor returns m's compiled formula under v, compiling at most once per
// (version ID, metric key) for the life of the Index. Failures are cached too.
// A version ID is assumed to name immutable content within one Index; the
// stored compiledMetric is read-only.
func (ix *Index) compiledFor(v domain.MethodologyVersion, m domain.Metric) *compiledMetric {
	k := compiledKey{v.ID, m.Key, m.Formula}
	if c, ok := ix.compiled.Load(k); ok {
		return c.(*compiledMetric)
	}
	cm := &compiledMetric{}
	cm.defs = make(map[string]domain.Measure, len(v.Content.Measures))
	keys := make([]string, 0, len(v.Content.Measures))
	for _, def := range v.Content.Measures {
		cm.defs[def.Key] = def
		keys = append(keys, def.Key)
	}
	if cm.f, cm.err = formula.Compile(m.Formula, keys); cm.err == nil {
		cm.idents, cm.err = formula.Identifiers(m.Formula)
	}
	actual, _ := ix.compiled.LoadOrStore(k, cm)
	return actual.(*compiledMetric)
}

// isBaseline reports whether a target is the reference for change rules
// rather than a goal.
func isBaseline(t domain.Target) bool {
	return strings.EqualFold(strings.TrimSpace(t.Label), "baseline")
}

// pickTarget finds the target applying to subjectID over months: baselines if
// baseline is true, otherwise goals. A target for the subject beats a global
// one; within each, the first in slice order wins.
func (ix *Index) pickTarget(targets []domain.Target, subjectID string, months []period.Period, baseline bool) (domain.Target, bool) {
	var global *domain.Target
	for i := range targets {
		t := &targets[i]
		if isBaseline(*t) != baseline || !ix.targetCovers(*t, months) {
			continue
		}
		switch {
		case t.SubjectID == "":
			if global == nil {
				global = t
			}
		case t.SubjectID == subjectID:
			return *t, true
		}
	}
	if global != nil {
		return *global, true
	}
	return domain.Target{}, false
}

// monthOrdinal numbers fiscal months consecutively across years.
func monthOrdinal(p period.Period) int { return p.FY*12 + p.Index }

// targetCovers reports whether every month in months lies within the target's
// [From, To] range. A zero From or To leaves that side open.
func (ix *Index) targetCovers(t domain.Target, months []period.Period) bool {
	if len(months) == 0 {
		return false
	}
	var lo, hi int
	hasLo, hasHi := t.From != (period.Period{}), t.To != (period.Period{})
	if hasLo {
		fm := ix.cal.Months(t.From)
		if len(fm) == 0 {
			return false
		}
		lo = monthOrdinal(fm[0])
	}
	if hasHi {
		tm := ix.cal.Months(t.To)
		if len(tm) == 0 {
			return false
		}
		hi = monthOrdinal(tm[len(tm)-1])
	}
	for _, mo := range months {
		o := monthOrdinal(mo)
		if (hasLo && o < lo) || (hasHi && o > hi) {
			return false
		}
	}
	return true
}
