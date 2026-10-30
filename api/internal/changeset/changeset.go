// Package changeset defines the reviewable set of changes that an import
// produces, and applies it to a tenant's store.
//
// A change set is built (for example by the legacy workbook adapter), shown to
// a person for review, and only then applied. It carries data writes,
// "as reported" status overrides, methodology text for draft versions, legacy
// notes, and findings: anything the importer was unsure about is recorded as a
// finding instead of being silently accepted.
package changeset

import (
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Change set sources.
const (
	// SourceLegacyWorkbook marks a change set parsed from a legacy workbook.
	SourceLegacyWorkbook = "legacy_workbook"
)

// Change set statuses.
const (
	// StatusParsed is a change set that has been built but not yet applied.
	StatusParsed = "parsed"
)

// Finding severities.
const (
	SeverityInfo  = "info"
	SeverityWarn  = "warn"
	SeverityError = "error"
)

// Version text fields.
const (
	FieldDefinition = "definition"
	FieldNotes      = "notes"
	FieldExample    = "example"
	FieldSource     = "source"
	FieldLink       = "link"
	FieldFrequency  = "frequency"
	// FieldBands carries a JSON-encoded BandsValue.
	FieldBands = "bands"
)

// ChangeSet is everything an import wants to change.
type ChangeSet struct {
	ID        string    `json:"id"`
	Source    string    `json:"source"`
	CreatedBy string    `json:"createdBy"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`

	Data        []store.DataWrite   `json:"data"`
	Overrides   []domain.Override   `json:"overrides"`
	VersionText []VersionTextChange `json:"versionText"`
	Notes       []LegacyNote        `json:"notes"`
	Findings    []Finding           `json:"findings"`
}

// Finding is something the importer noticed. Severity is info, warn or error.
// Sheet and Cell locate it in the source workbook when they apply (Cell is an
// A1-style reference such as "I50").
type Finding struct {
	Severity string `json:"severity"`
	Sheet    string `json:"sheet,omitempty"`
	Cell     string `json:"cell,omitempty"`
	Message  string `json:"message"`
}

// HasErrors reports whether any finding has severity error.
func HasErrors(fs []Finding) bool {
	for _, f := range fs {
		if f.Severity == SeverityError {
			return true
		}
	}
	return false
}

// VersionTextChange sets one text field of one metric in a (draft) methodology
// version. Field is one of definition, notes, example, source, link, frequency
// or bands; for bands, Value is a JSON-encoded BandsValue.
type VersionTextChange struct {
	VersionID string `json:"versionId"`
	MetricKey string `json:"metricKey"`
	Field     string `json:"field"`
	Value     string `json:"value"`
}

// BandsValue is the JSON payload of a VersionTextChange with Field "bands".
type BandsValue struct {
	Bands     []domain.Band    `json:"bands"`
	Direction domain.Direction `json:"direction"`
}

// LegacyNote is a comment found on a legacy workbook cell. Phase 1 carries
// notes in the change set and reports their count; they are not stored.
type LegacyNote struct {
	MetricKey string        `json:"metricKey"`
	SubjectID string        `json:"subjectId"`
	Period    period.Period `json:"period"`
	Author    string        `json:"author"`
	Text      string        `json:"text"`
	At        *time.Time    `json:"at,omitempty"`
}
