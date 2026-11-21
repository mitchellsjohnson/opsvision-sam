package records

import (
	"fmt"

	"opsvision/internal/domain"
)

// IncidentTypeID is the ID of the incident record type preset.
const IncidentTypeID = "incident"

// Attribute keys of the incident preset.
const (
	AttrStartedAt   = "startedAt"
	AttrEndedAt     = "endedAt"
	AttrMinutesDown = "minutesDown"
	AttrImpactPct   = "impactPct"
)

// IncidentPreset returns the incident record type created by "Add incident
// type": severities SEV1 to SEV4, start and end instants, an optional
// duration in minutes, and an optional impact percentage (0 < x ≤ 100,
// default 100).
func IncidentPreset() domain.RecordType {
	return domain.RecordType{
		ID:         IncidentTypeID,
		Name:       "Incident",
		Priorities: []string{"SEV1", "SEV2", "SEV3", "SEV4"},
		Attributes: []domain.AttributeDef{
			{Key: AttrStartedAt, Name: "Started", Type: domain.AttrDateTime},
			{Key: AttrEndedAt, Name: "Ended", Type: domain.AttrDateTime},
			{Key: AttrMinutesDown, Name: "Minutes down", Type: domain.AttrNumber},
			{Key: AttrImpactPct, Name: "Impact (%)", Type: domain.AttrNumber},
		},
	}
}

// isIncidentType reports whether rt is the incident preset or shaped like it
// (a startedAt date-time attribute), so its rows get the incident checks.
func isIncidentType(rt domain.RecordType) bool {
	if rt.ID == IncidentTypeID {
		return true
	}
	k, ok := rt.FieldKind(AttrStartedAt)
	return ok && k == domain.AttrDateTime
}

// incidentChecks adds the incident row errors: an end before the start, a
// negative duration, and an impact outside (0, 100].
func (b *rowBuilder) incidentChecks(f domain.RecordFields) {
	start, okS, errS := FieldDateTime(f, AttrStartedAt)
	end, okE, errE := FieldDateTime(f, AttrEndedAt)
	if errS == nil && errE == nil && okS && okE && end.Before(start) {
		fm := b.n.t.Attributes[AttrEndedAt]
		b.problem(ProblemError, fm, AttrEndedAt, b.n.raw(fm, b.cells), "Ended before it started")
	}
	if v, ok := f.Attributes[AttrMinutesDown].(float64); ok && v < 0 {
		fm := b.n.t.Attributes[AttrMinutesDown]
		b.problem(ProblemError, fm, AttrMinutesDown, b.n.raw(fm, b.cells), "Minutes down must be 0 or more")
	}
	if v, ok := f.Attributes[AttrImpactPct].(float64); ok && (v <= 0 || v > 100) {
		fm := b.n.t.Attributes[AttrImpactPct]
		b.problem(ProblemError, fm, AttrImpactPct, b.n.raw(fm, b.cells), "Impact must be more than 0 and at most 100")
	}
}

// ValidateExplainWhere compiles the where condition of each of rt's explain
// links against rt and returns the problems, at explains[i].where.
func ValidateExplainWhere(rt domain.RecordType) []domain.ValidationError {
	var errs []domain.ValidationError
	for i, l := range rt.Explains {
		if _, err := CompileWhere(l.Where, rt); err != nil {
			errs = append(errs, domain.ValidationError{Path: fmt.Sprintf("explains[%d].where", i), Message: err.Error()})
		}
	}
	return errs
}
