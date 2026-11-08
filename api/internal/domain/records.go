package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"time"

	"opsvision/internal/period"
)

// dateLayout is the wire form of a Date.
const dateLayout = "2006-01-02"

// Date is a calendar date at UTC midnight. Its JSON form is "YYYY-MM-DD";
// the zero Date encodes as the empty string. Time zones are ignored.
type Date struct{ time.Time }

// ParseDate parses a "YYYY-MM-DD" calendar date.
func ParseDate(s string) (Date, error) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return Date{}, fmt.Errorf("date %q: want YYYY-MM-DD", s)
	}
	return Date{t.UTC()}, nil
}

// String formats d as YYYY-MM-DD; the zero Date formats as "".
func (d Date) String() string {
	if d.IsZero() {
		return ""
	}
	return d.UTC().Format(dateLayout)
}

// MarshalJSON encodes d as a "YYYY-MM-DD" string.
func (d Date) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

// UnmarshalJSON decodes a "YYYY-MM-DD" string. null and "" decode to the zero Date.
func (d *Date) UnmarshalJSON(b []byte) error {
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("date: want a YYYY-MM-DD string")
	}
	if s == "" {
		*d = Date{}
		return nil
	}
	v, err := ParseDate(s)
	if err != nil {
		return err
	}
	*d = v
	return nil
}

// Before reports whether d is strictly earlier than o.
func (d Date) Before(o Date) bool { return d.Time.Before(o.Time) }

// AddDays returns the date n calendar days after d (before d when n < 0).
func (d Date) AddDays(n int) Date { return Date{d.Time.AddDate(0, 0, n)} }

// RecordState is the normalized lifecycle state of a record.
type RecordState string

// Record states.
const (
	StateOpen      RecordState = "open"
	StateDone      RecordState = "done"
	StateCancelled RecordState = "cancelled"
)

// Valid reports whether s is a known record state.
func (s RecordState) Valid() bool {
	return s == StateOpen || s == StateDone || s == StateCancelled
}

// AttrType is the type of a custom record attribute.
type AttrType string

// Attribute types.
const (
	AttrString AttrType = "string"
	AttrNumber AttrType = "number"
	AttrBool   AttrType = "bool"
	AttrDate   AttrType = "date"
)

// Valid reports whether t is a known attribute type.
func (t AttrType) Valid() bool {
	switch t {
	case AttrString, AttrNumber, AttrBool, AttrDate:
		return true
	}
	return false
}

// AttributeDef declares one custom attribute of a record type.
type AttributeDef struct {
	Key  string   `json:"key"`
	Name string   `json:"name"`
	Type AttrType `json:"type"`
}

// PriorityNone is the implicit priority of a record with no priority.
const PriorityNone = "none"

// RecordType is a tenant-level kind of record (defect, epic, ...). TrackedFrom
// is keyed by record source; PriorityNone is always an implicit priority.
type RecordType struct {
	ID          string                   `json:"id"`
	Name        string                   `json:"name"`
	Priorities  []string                 `json:"priorities"`
	Attributes  []AttributeDef           `json:"attributes"`
	TrackedFrom map[string]period.Period `json:"trackedFrom"`
	Revision    int                      `json:"revision"`
}

// recordFieldKinds maps the built-in record field names usable in rule
// conditions, buckets, and sums to their kinds. Attributes are separate.
var recordFieldKinds = map[string]AttrType{
	"subjectKey":     AttrString,
	"title":          AttrString,
	"category":       AttrString,
	"priority":       AttrString,
	"status":         AttrString,
	"state":          AttrString,
	"url":            AttrString,
	"createdAt":      AttrDate,
	"committedAt":    AttrDate,
	"dueAt":          AttrDate,
	"completedAt":    AttrDate,
	"measuredAt":     AttrDate,
	"planned":        AttrNumber,
	"actual":         AttrNumber,
	"expectedValue":  AttrNumber,
	"deliveredValue": AttrNumber,
}

// FieldKind returns the kind of the built-in field or custom attribute named
// name, and whether it exists.
func (rt RecordType) FieldKind(name string) (AttrType, bool) {
	if k, ok := recordFieldKinds[name]; ok {
		return k, true
	}
	for _, a := range rt.Attributes {
		if a.Key == name {
			return a.Type, true
		}
	}
	return "", false
}

// AllPriorities returns the type's priorities plus PriorityNone, without
// duplicates, in declared order with none last when it was not declared.
func (rt RecordType) AllPriorities() []string {
	out := make([]string, 0, len(rt.Priorities)+1)
	seen := map[string]bool{}
	for _, p := range rt.Priorities {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if !seen[PriorityNone] {
		out = append(out, PriorityNone)
	}
	return out
}

// attributeKeyPattern allows camelCase and snake_case attribute keys such as
// customerTicket and within_budget.
var attributeKeyPattern = regexp.MustCompile(`^[a-z][A-Za-z0-9_]*$`)

// checkAttributeKey validates a custom attribute key's shape. Unlike measure
// keys it may contain capitals, matching the camelCase built-in field names.
func (v *validator) checkAttributeKey(path, key string) {
	switch {
	case key == "":
		v.add(path, "key is required")
	case reservedKeys[key]:
		v.add(path, "key %q is reserved", key)
	case !attributeKeyPattern.MatchString(key):
		v.add(path, "key %q must match %s", key, attributeKeyPattern)
	}
}

// Validate returns every problem found in the record type, or nil. Paths are
// like priorities[1], attributes[0].key, trackedFrom.tracker.
func (rt RecordType) Validate() []ValidationError {
	v := &validator{}
	v.checkKey("id", rt.ID)
	if rt.Name == "" {
		v.add("name", "name is required")
	}

	seenPri := make(map[string]bool, len(rt.Priorities))
	for i, p := range rt.Priorities {
		path := fmt.Sprintf("priorities[%d]", i)
		switch {
		case p == "":
			v.add(path, "priority is required")
		case seenPri[p]:
			v.add(path, "duplicate priority %q", p)
		}
		seenPri[p] = true
	}

	seenAttr := make(map[string]bool, len(rt.Attributes))
	for i, a := range rt.Attributes {
		path := fmt.Sprintf("attributes[%d]", i)
		v.checkAttributeKey(path+".key", a.Key)
		if _, builtin := recordFieldKinds[a.Key]; builtin {
			v.add(path+".key", "key %q is a built-in record field", a.Key)
		}
		if a.Key != "" {
			if seenAttr[a.Key] {
				v.add(path+".key", "duplicate attribute key %q", a.Key)
			}
			seenAttr[a.Key] = true
		}
		if a.Name == "" {
			v.add(path+".name", "name is required")
		}
		if !a.Type.Valid() {
			v.add(path+".type", "invalid attribute type %q", a.Type)
		}
	}

	sources := make([]string, 0, len(rt.TrackedFrom))
	for src := range rt.TrackedFrom {
		sources = append(sources, src)
	}
	sort.Strings(sources)
	for _, src := range sources {
		p := rt.TrackedFrom[src]
		path := "trackedFrom." + src
		if src == "" {
			v.add("trackedFrom", "source is required")
		}
		if p.Grain != period.Month || p.Index < 1 || p.Index > 12 {
			v.add(path, "tracked-from must be a month, got %q", p.String())
		}
	}

	if len(v.errs) == 0 {
		return nil
	}
	return v.errs
}

// RecordFields is the canonical record format: one record's state as of one
// snapshot.
type RecordFields struct {
	SubjectKey     string         `json:"subjectKey"`
	Title          string         `json:"title,omitempty"`
	Category       string         `json:"category,omitempty"`
	Priority       string         `json:"priority,omitempty"`
	Status         string         `json:"status,omitempty"`
	URL            string         `json:"url,omitempty"`
	State          RecordState    `json:"state"`
	CreatedAt      Date           `json:"createdAt"`
	CommittedAt    *Date          `json:"committedAt"`
	DueAt          *Date          `json:"dueAt"`
	PriorDueDates  []Date         `json:"priorDueDates,omitempty"`
	CompletedAt    *Date          `json:"completedAt"`
	MeasuredAt     *Date          `json:"measuredAt"`
	Planned        *float64       `json:"planned"`
	Actual         *float64       `json:"actual"`
	ExpectedValue  *float64       `json:"expectedValue"`
	DeliveredValue *float64       `json:"deliveredValue"`
	Attributes     map[string]any `json:"attributes,omitempty"`
}

// RecordRevision is a record's fields as of one snapshot.
type RecordRevision struct {
	AsOf       Date         `json:"asOf"`
	SnapshotID string       `json:"snapshotId"`
	Fields     RecordFields `json:"fields"`
}

// Record is one defect or work unit, identified by (Source, ExternalID).
// Revisions are sorted by AsOf, oldest first.
type Record struct {
	Source     string           `json:"source"`
	ExternalID string           `json:"externalId"`
	Type       string           `json:"type"`
	Revisions  []RecordRevision `json:"revisions"`
}

// Snapshot is one upload of records for a record type and source.
type Snapshot struct {
	ID               string         `json:"id"`
	RecordType       string         `json:"recordType"`
	Source           string         `json:"source"`
	TemplateID       string         `json:"templateId"`
	TemplateRevision int            `json:"templateRevision"`
	AsOf             Date           `json:"asOf"`
	FileName         string         `json:"fileName"`
	CreatedBy        string         `json:"createdBy"`
	CreatedAt        time.Time      `json:"createdAt"`
	Counts           map[string]int `json:"counts"`
}

// DeriveOp is the operation a derivation rule applies to records.
type DeriveOp string

// Derivation operations.
const (
	OpCount             DeriveOp = "count"
	OpSum               DeriveOp = "sum"
	OpDailyOpenWeighted DeriveOp = "daily_open_weighted"
	OpCommitments       DeriveOp = "commitments"
	OpDaysInPeriod      DeriveOp = "days_in_period"
	OpAgeSum            DeriveOp = "age_sum"
)

// Valid reports whether o is a known derivation operation.
func (o DeriveOp) Valid() bool {
	switch o {
	case OpCount, OpSum, OpDailyOpenWeighted, OpCommitments, OpDaysInPeriod, OpAgeSum:
		return true
	}
	return false
}

// Commitment outcomes for DeriveRule.Outcome.
const (
	OutcomeResolved = "resolved"
	OutcomeMet      = "met"
)

// Measure sources for Measure.Source. The empty string means entered.
const (
	MeasureEntered = "entered"
	MeasureDerived = "derived"
)

// DeriveRule turns records into a measure's value per subject per period.
type DeriveRule struct {
	RecordType string             `json:"recordType"`
	Op         DeriveOp           `json:"op"`
	BucketBy   string             `json:"bucketBy,omitempty"`
	Field      string             `json:"field,omitempty"`
	Where      string             `json:"where,omitempty"`
	Outcome    string             `json:"outcome,omitempty"`
	AgeFrom    string             `json:"ageFrom,omitempty"`
	AgeTo      string             `json:"ageTo,omitempty"`
	Weights    map[string]float64 `json:"weights,omitempty"`
}

// ValidateDerive checks the derive rule of every measure in m against types
// and returns every problem found, or nil. It checks structure only: the
// where expression is compiled elsewhere. Measures without a derive rule are
// skipped (Methodology.Validate reports source/derive mismatches).
func ValidateDerive(m Methodology, types []RecordType) []ValidationError {
	byID := make(map[string]RecordType, len(types))
	for _, t := range types {
		byID[t.ID] = t
	}
	v := &validator{}
	for i, ms := range m.Measures {
		if ms.Derive == nil {
			continue
		}
		v.checkDerive(fmt.Sprintf("measures[%d].derive", i), *ms.Derive, byID)
	}
	if len(v.errs) == 0 {
		return nil
	}
	return v.errs
}

func (v *validator) checkDerive(path string, d DeriveRule, types map[string]RecordType) {
	if !d.Op.Valid() {
		v.add(path+".op", "invalid operation %q", d.Op)
		return
	}
	rt, ok := types[d.RecordType]
	if !ok {
		v.add(path+".recordType", "unknown record type %q", d.RecordType)
		return
	}

	// dateField checks that name, when required or set, is a date field.
	dateField := func(field, name string, required bool) {
		if name == "" {
			if required {
				v.add(path+"."+field, "%s is required for %s", field, d.Op)
			}
			return
		}
		switch k, found := rt.FieldKind(name); {
		case !found:
			v.add(path+"."+field, "unknown field %q on record type %q", name, rt.ID)
		case k != AttrDate:
			v.add(path+"."+field, "%q is not a date field", name)
		}
	}

	switch d.Op {
	case OpCount:
		dateField("bucketBy", d.BucketBy, true)
	case OpSum:
		dateField("bucketBy", d.BucketBy, true)
		switch k, found := rt.FieldKind(d.Field); {
		case d.Field == "":
			v.add(path+".field", "field is required for sum")
		case !found:
			v.add(path+".field", "unknown field %q on record type %q", d.Field, rt.ID)
		case k != AttrNumber:
			v.add(path+".field", "%q is not a number field", d.Field)
		}
	case OpAgeSum:
		dateField("bucketBy", d.BucketBy, true)
		dateField("ageFrom", d.AgeFrom, true)
		dateField("ageTo", d.AgeTo, false)
	case OpCommitments:
		if d.Outcome != OutcomeResolved && d.Outcome != OutcomeMet {
			v.add(path+".outcome", "outcome must be %s or %s, got %q", OutcomeResolved, OutcomeMet, d.Outcome)
		}
	case OpDailyOpenWeighted:
		known := map[string]bool{}
		for _, p := range rt.AllPriorities() {
			known[p] = true
			if _, ok := d.Weights[p]; !ok {
				v.add(path+".weights", "missing weight for priority %q", p)
			}
		}
		extra := make([]string, 0, len(d.Weights))
		for p := range d.Weights {
			if !known[p] {
				extra = append(extra, p)
			}
		}
		sort.Strings(extra)
		for _, p := range extra {
			v.add(path+".weights."+p, "unknown priority %q for record type %q", p, rt.ID)
		}
	}
}
