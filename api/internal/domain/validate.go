package domain

import (
	"fmt"
	"regexp"
	"strings"

	"opsvision/internal/formula"
)

// ValidationError locates one problem in a methodology. Path uses the form
// metrics[0].formula, metrics[2].rule.bands, measures[1].key.
type ValidationError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func (e ValidationError) Error() string { return e.Path + ": " + e.Message }

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func validChartKind(s string) bool {
	switch s {
	case "ratio", "money_plan", "change", "uptime", "days", "discrete", "line":
		return true
	}
	return false
}

// reservedKeys are formula function names and cannot be used as keys.
var reservedKeys = map[string]bool{"min": true, "max": true, "abs": true}

// validator accumulates errors.
type validator struct {
	errs  []ValidationError
	scale map[string]bool
}

func (v *validator) add(path, format string, args ...any) {
	v.errs = append(v.errs, ValidationError{Path: path, Message: fmt.Sprintf(format, args...)})
}

// checkKey validates a measure or metric key's shape.
func (v *validator) checkKey(path, key string) {
	switch {
	case key == "":
		v.add(path, "key is required")
	case reservedKeys[key]:
		v.add(path, "key %q is reserved", key)
	case !keyPattern.MatchString(key):
		v.add(path, "key %q must match %s", key, keyPattern)
	}
}

// Validate checks the methodology against scale and returns every problem
// found, or nil when it is valid.
func (m Methodology) Validate(scale []StatusLevel) []ValidationError {
	v := &validator{scale: make(map[string]bool, len(scale))}
	for _, s := range scale {
		v.scale[s.Key] = true
	}

	categories := make(map[string]bool, len(m.Categories))
	for i, c := range m.Categories {
		path := fmt.Sprintf("categories[%d].id", i)
		switch {
		case c.ID == "":
			v.add(path, "id is required")
		case categories[c.ID]:
			v.add(path, "duplicate category id %q", c.ID)
		}
		categories[c.ID] = true
	}

	measureKeys := make([]string, 0, len(m.Measures))
	seenMeasures := make(map[string]bool, len(m.Measures))
	for i, ms := range m.Measures {
		path := fmt.Sprintf("measures[%d]", i)
		v.checkKey(path+".key", ms.Key)
		if ms.Key != "" {
			if seenMeasures[ms.Key] {
				v.add(path+".key", "duplicate measure key %q", ms.Key)
			} else {
				seenMeasures[ms.Key] = true
				if keyPattern.MatchString(ms.Key) && !reservedKeys[ms.Key] {
					measureKeys = append(measureKeys, ms.Key)
				}
			}
		}
		if !ms.OrgAgg.Valid() {
			v.add(path+".orgAgg", "invalid aggregation %q", ms.OrgAgg)
		}
		if !ms.TimeAgg.Valid() {
			v.add(path+".timeAgg", "invalid aggregation %q", ms.TimeAgg)
		}
		switch ms.Source {
		case "", MeasureEntered:
			if ms.Derive != nil {
				v.add(path+".derive", "derive is only allowed on derived measures")
			}
		case MeasureDerived:
			if ms.Derive == nil {
				v.add(path+".derive", "derived measures need a derive rule")
			}
		default:
			v.add(path+".source", "invalid source %q", ms.Source)
		}
	}

	seenMetrics := make(map[string]bool, len(m.Metrics))
	for i, mt := range m.Metrics {
		path := fmt.Sprintf("metrics[%d]", i)
		v.checkKey(path+".key", mt.Key)
		if mt.Key != "" {
			if seenMetrics[mt.Key] {
				v.add(path+".key", "duplicate metric key %q", mt.Key)
			}
			seenMetrics[mt.Key] = true
		}
		if !categories[mt.CategoryID] || mt.CategoryID == "" {
			v.add(path+".categoryId", "unknown category %q", mt.CategoryID)
		}
		if strings.TrimSpace(mt.Formula) == "" {
			v.add(path+".formula", "formula is required")
		} else if _, err := formula.Compile(mt.Formula, measureKeys); err != nil {
			v.add(path+".formula", "%s", err.Error())
		}
		if !ValidFormat(mt.Format) {
			v.add(path+".format", "invalid format %q", mt.Format)
		}
		if !mt.Direction.Valid() {
			v.add(path+".direction", "invalid direction %q", mt.Direction)
		}
		if !mt.Frequency.Valid() {
			v.add(path+".frequency", "invalid frequency %q", mt.Frequency)
		}
		if mt.ChartKind != "" && !validChartKind(mt.ChartKind) {
			v.add(path+".chartKind", "invalid chart kind %q", mt.ChartKind)
		}
		for j, s := range mt.ReportedAt {
			sp := fmt.Sprintf("%s.reportedAt[%d]", path, j)
			if s.Kind != SubjectLevel && s.Kind != SubjectItemKind {
				v.add(sp+".kind", "invalid subject kind %q", s.Kind)
			}
			if s.ID == "" {
				v.add(sp+".id", "id is required")
			}
		}
		v.checkRule(path+".rule", mt.Rule)
	}

	if len(v.errs) == 0 {
		return nil
	}
	return v.errs
}

func (v *validator) checkRule(path string, r StatusRule) {
	if !r.Type.Valid() {
		v.add(path+".type", "invalid rule type %q", r.Type)
		return
	}
	switch r.Type {
	case RuleBands:
		v.checkBands(path+".bands", r.Bands)
	case RuleChange:
		if r.Compare == "" {
			v.add(path+".compare", "compare is required for change rules")
		} else if !r.Compare.Valid() {
			v.add(path+".compare", "invalid comparison %q", r.Compare)
		}
		v.checkBands(path+".bands", r.Bands)
	case RuleScale:
		if len(r.Scale) == 0 {
			v.add(path+".scale", "scale rules need at least one step")
		}
		for i, s := range r.Scale {
			v.checkStatus(fmt.Sprintf("%s.scale[%d].status", path, i), s.Status)
		}
	}
	for i, ps := range r.PerSubject {
		pp := fmt.Sprintf("%s.perSubject[%d]", path, i)
		if ps.SubjectID == "" {
			v.add(pp+".subjectId", "subjectId is required")
		}
		v.checkBands(pp+".bands", ps.Bands)
	}
}

func (v *validator) checkStatus(path, status string) {
	if !v.scale[status] {
		v.add(path, "unknown status %q", status)
	}
}

// checkBands requires every status to be in the scale, every operator to be
// valid, and an else band (Op "") to appear exactly once, last.
func (v *validator) checkBands(path string, bands []Band) {
	for i, b := range bands {
		bp := fmt.Sprintf("%s[%d]", path, i)
		v.checkStatus(bp+".status", b.Status)
		switch b.Op {
		case ">=", ">", "<=", "<":
		case "":
			if i != len(bands)-1 {
				v.add(bp, "else band must be last")
			}
		default:
			v.add(bp+".op", "invalid operator %q", b.Op)
		}
	}
	if len(bands) == 0 || bands[len(bands)-1].Op != "" {
		v.add(path, "bands must end with an else band")
	}
}
