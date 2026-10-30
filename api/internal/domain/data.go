package domain

import (
	"encoding/json"
	"time"

	"opsvision/internal/period"
)

// Data sources for DataPoint.Source. DataPoint.Source is a plain string (the
// wire form), so these are untyped string constants.
const (
	SourceGrid   = "grid"
	SourceImport = "import"
	SourceAPI    = "api"
	SourceSAM    = "sam"
	SourceLegacy = "legacy"
)

// ValidSource reports whether s is a known data source.
func ValidSource(s string) bool {
	switch s {
	case SourceGrid, SourceImport, SourceAPI, SourceSAM, SourceLegacy:
		return true
	}
	return false
}

// DataPoint is a measure value for one subject in one period. A nil Value
// means not applicable, with the reason in NAReason.
type DataPoint struct {
	MeasureKey string        `json:"measureKey"`
	SubjectID  string        `json:"subjectId"`
	Period     period.Period `json:"period"`
	Value      *float64      `json:"value"`
	NAReason   string        `json:"naReason"`
	Source     string        `json:"source"`
	EnteredBy  string        `json:"enteredBy"`
	EnteredAt  time.Time     `json:"enteredAt"`
	Revision   int           `json:"revision"`
}

// Override replaces a computed metric value and/or status for a subject and
// period, with a recorded reason.
type Override struct {
	MetricKey string        `json:"metricKey"`
	SubjectID string        `json:"subjectId"`
	Period    period.Period `json:"period"`
	Value     *float64      `json:"value"`
	Status    string        `json:"status"`
	Reason    string        `json:"reason"`
	By        string        `json:"by"`
	At        time.Time     `json:"at"`
}

// AuditEntry records a change to tenant state.
type AuditEntry struct {
	ID         string          `json:"id"`
	ActorID    string          `json:"actorId"`
	Channel    string          `json:"channel"`
	Action     string          `json:"action"`
	TargetType string          `json:"targetType"`
	TargetID   string          `json:"targetId"`
	Before     json.RawMessage `json:"before,omitempty"`
	After      json.RawMessage `json:"after,omitempty"`
	At         time.Time       `json:"at"`
}
