package domain

import (
	"time"

	"opsvision/internal/period"
)

// Scorecard groups a family of methodology versions.
type Scorecard struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// VersionStatus is the lifecycle state of a methodology version.
type VersionStatus string

// Methodology version lifecycle states.
const (
	VersionDraft      VersionStatus = "draft"
	VersionInReview   VersionStatus = "in_review"
	VersionPublished  VersionStatus = "published"
	VersionSuperseded VersionStatus = "superseded"
)

// MethodologyVersion is one revisioned snapshot of a scorecard's methodology.
type MethodologyVersion struct {
	ID            string        `json:"id"`
	ScorecardID   string        `json:"scorecardId"`
	Name          string        `json:"name"`
	Status        VersionStatus `json:"status"`
	EffectiveFrom period.Period `json:"effectiveFrom"`
	PublishedAt   *time.Time    `json:"publishedAt,omitempty"`
	Revision      int           `json:"revision"`
	Content       Methodology   `json:"content"`
}

// Methodology is the full definition of what is measured and how it is judged.
type Methodology struct {
	Categories []Category `json:"categories"`
	Measures   []Measure  `json:"measures"`
	Metrics    []Metric   `json:"metrics"`
}

// Category groups metrics for display.
type Category struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
}

// Agg is an aggregation function applied across org units or across time.
type Agg string

// Supported aggregations.
const (
	AggSum     Agg = "sum"
	AggMin     Agg = "min"
	AggMax     Agg = "max"
	AggLatest  Agg = "latest"
	AggAverage Agg = "average"
	AggNone    Agg = "none"
)

// Valid reports whether a is a known aggregation.
func (a Agg) Valid() bool {
	switch a {
	case AggSum, AggMin, AggMax, AggLatest, AggAverage, AggNone:
		return true
	}
	return false
}

// Measure is a raw input quantity that formulas reference by Key. Source is
// "" or "entered" for values that are typed or imported, and "derived" for
// values computed from records by Derive; the empty string keeps all stored
// methodology JSON valid.
type Measure struct {
	Key     string      `json:"key"`
	Name    string      `json:"name"`
	Unit    string      `json:"unit"`
	OrgAgg  Agg         `json:"orgAgg"`
	TimeAgg Agg         `json:"timeAgg"`
	Source  string      `json:"source,omitempty"`
	Derive  *DeriveRule `json:"derive,omitempty"`
}

// Direction says which way is better for a metric.
type Direction string

// Supported directions.
const (
	DirectionHigherBetter Direction = "higher_better"
	DirectionLowerBetter  Direction = "lower_better"
)

// Valid reports whether d is a known direction.
func (d Direction) Valid() bool {
	return d == DirectionHigherBetter || d == DirectionLowerBetter
}

// Frequency is how often a metric is reported.
type Frequency string

// Supported frequencies.
const (
	FrequencyMonthly   Frequency = "monthly"
	FrequencyQuarterly Frequency = "quarterly"
	FrequencyBiannual  Frequency = "biannual"
	FrequencyAnnual    Frequency = "annual"
)

// Valid reports whether f is a known frequency.
func (f Frequency) Valid() bool {
	switch f {
	case FrequencyMonthly, FrequencyQuarterly, FrequencyBiannual, FrequencyAnnual:
		return true
	}
	return false
}

// Subject kinds for Subject.Kind.
const (
	SubjectLevel    = "level"
	SubjectItemKind = "item_kind"
)

// Subject names what a metric is reported at: an org level or an item kind.
type Subject struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// Metric display formats for Metric.Format.
const (
	FormatPercent0 = "percent0"
	FormatPercent1 = "percent1"
	FormatPercent2 = "percent2"
	FormatNumber0  = "number0"
	FormatNumber1  = "number1"
	FormatNumber2  = "number2"
	FormatMoneyK   = "money_k"
	FormatDays0    = "days0"
)

// ValidFormat reports whether s is a known metric format code.
func ValidFormat(s string) bool {
	switch s {
	case FormatPercent0, FormatPercent1, FormatPercent2,
		FormatNumber0, FormatNumber1, FormatNumber2,
		FormatMoneyK, FormatDays0:
		return true
	}
	return false
}

// Metric is a judged indicator computed from measures by Formula.
type Metric struct {
	Key            string     `json:"key"`
	Name           string     `json:"name"`
	CategoryID     string     `json:"categoryId"`
	Formula        string     `json:"formula"`
	Format         string     `json:"format"`
	Direction      Direction  `json:"direction"`
	Frequency      Frequency  `json:"frequency"`
	ReportedAt     []Subject  `json:"reportedAt"`
	RollItemsToOrg bool       `json:"rollItemsToOrg"`
	Rule           StatusRule `json:"rule"`
	Targets        []Target   `json:"targets"`
	Definition     string     `json:"definition"`
	Notes          string     `json:"notes"`
	Example        string     `json:"example"`
	Source         string     `json:"source"`
	Link           string     `json:"link"`
	ChartKind      string     `json:"chartKind,omitempty"`
}

// RuleType selects how a StatusRule derives status.
type RuleType string

// Supported rule types.
const (
	RuleBands  RuleType = "bands"
	RuleChange RuleType = "change"
	RuleScale  RuleType = "scale"
)

// Valid reports whether t is a known rule type.
func (t RuleType) Valid() bool {
	return t == RuleBands || t == RuleChange || t == RuleScale
}

// Comparison is the reference point for a change rule.
type Comparison string

// Supported comparisons.
const (
	ComparePriorPeriod      Comparison = "prior_period"
	ComparePriorYearAverage Comparison = "prior_year_average"
	CompareBaseline         Comparison = "baseline"
)

// Valid reports whether c is a known comparison.
func (c Comparison) Valid() bool {
	return c == ComparePriorPeriod || c == ComparePriorYearAverage || c == CompareBaseline
}

// StatusRule derives a status from a metric value.
type StatusRule struct {
	Type       RuleType       `json:"type"`
	Bands      []Band         `json:"bands,omitempty"`
	Compare    Comparison     `json:"compare,omitempty"`
	PerSubject []SubjectBands `json:"perSubject,omitempty"`
	Scale      []ScaleStep    `json:"scale,omitempty"`
}

// Band maps a value range to a status. Bands are evaluated in order and the
// first match wins; Op "" is the else band and matches anything.
type Band struct {
	Status string  `json:"status"`
	Op     string  `json:"op"`
	Value  float64 `json:"value"`
}

// SubjectBands overrides the rule's bands for one subject.
type SubjectBands struct {
	SubjectID string `json:"subjectId"`
	Bands     []Band `json:"bands"`
}

// ScaleStep maps a minimum value to a status for scale rules.
type ScaleStep struct {
	Status string  `json:"status"`
	Min    float64 `json:"min"`
}

// Target is a goal value for a metric over a span of periods.
type Target struct {
	Label     string        `json:"label"`
	From      period.Period `json:"from"`
	To        period.Period `json:"to"`
	Value     float64       `json:"value"`
	SubjectID string        `json:"subjectId"`
}
