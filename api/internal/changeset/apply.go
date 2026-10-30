package changeset

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/oklog/ulid/v2"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// AuditAction is the audit action recorded when a change set is applied.
const AuditAction = "import.apply"

// auditChannel is the channel recorded on the audit entry.
const auditChannel = "import"

// Hooks for tests.
var (
	now   = func() time.Time { return time.Now().UTC() }
	newID = func() string { return ulid.Make().String() }
)

// ApplyResult counts what Apply stored. Findings holds problems found while
// applying version text (for example a metric missing from the draft); those
// changes were skipped.
type ApplyResult struct {
	// Status is StatusApplied on success. Apply does not modify the change
	// set it is given: the caller stores this status on its copy (Task 20 does
	// so when it saves the import), which is what makes a second Apply refuse.
	Status      string    `json:"status"`
	DataPoints  int       `json:"dataPoints"`
	Overrides   int       `json:"overrides"`
	VersionText int       `json:"versionText"`
	Findings    []Finding `json:"findings"`
}

// Apply stores a change set for one scorecard. The change set must have
// status "parsed" and no error findings; otherwise Apply returns an error and
// writes nothing. It stores: all data writes, all overrides,
// then the version text (into draft versions only), and finally one audit
// entry. LegacyNotes are not stored in phase 1; they are only counted in the
// audit entry.
//
// Every version the change set names is read and checked to be a draft before
// anything is written; if any is not, Apply returns an error and writes
// nothing. After that point the writes are not transactional: a store failure
// part-way returns the error with the earlier writes already saved (data
// writes are unconditional and overrides upsert, so applying again is safe).
//
// Data points and overrides that have no EnteredBy/By or EnteredAt/At are
// stamped with actor and the current time.
func Apply(ctx context.Context, st store.Store, tenantID, scorecardID string, cs ChangeSet, actor string) (ApplyResult, error) {
	res := ApplyResult{Findings: []Finding{}}

	// Only a parsed change set with no error findings may be applied.
	if cs.Status != StatusParsed {
		return res, fmt.Errorf("change set %q has status %q: only a %q change set can be applied", cs.ID, cs.Status, StatusParsed)
	}
	for _, f := range cs.Findings {
		if f.Severity == SeverityError {
			return res, fmt.Errorf("change set %q has error findings and cannot be applied (first: %s)", cs.ID, f.Message)
		}
	}

	// Check every referenced version before writing anything.
	var versionOrder []string
	byVersion := map[string][]VersionTextChange{}
	for _, c := range cs.VersionText {
		if _, seen := byVersion[c.VersionID]; !seen {
			versionOrder = append(versionOrder, c.VersionID)
		}
		byVersion[c.VersionID] = append(byVersion[c.VersionID], c)
	}
	for _, id := range versionOrder {
		v, err := st.GetVersion(ctx, tenantID, scorecardID, id)
		if err != nil {
			return res, fmt.Errorf("version %q: %w", id, err)
		}
		if v.Status != domain.VersionDraft {
			return res, fmt.Errorf("version %q is %s: legacy text can only be applied to a draft version", id, v.Status)
		}
	}

	at := now()

	if len(cs.Data) > 0 {
		writes := make([]store.DataWrite, len(cs.Data))
		for i, w := range cs.Data {
			if w.Point.EnteredBy == "" {
				w.Point.EnteredBy = actor
			}
			if w.Point.EnteredAt.IsZero() {
				w.Point.EnteredAt = at
			}
			writes[i] = w
		}
		saved, err := st.PutDataPoints(ctx, tenantID, scorecardID, writes)
		if err != nil {
			return res, fmt.Errorf("saving data points: %w", err)
		}
		res.DataPoints = len(saved)
	}

	for _, o := range cs.Overrides {
		if o.By == "" {
			o.By = actor
		}
		if o.At.IsZero() {
			o.At = at
		}
		if err := st.PutOverride(ctx, tenantID, scorecardID, o); err != nil {
			return res, fmt.Errorf("saving override for %s: %w", o.MetricKey, err)
		}
		res.Overrides++
	}

	for _, id := range versionOrder {
		applied, fs, err := applyVersionText(ctx, st, tenantID, scorecardID, id, byVersion[id])
		res.VersionText += applied
		res.Findings = append(res.Findings, fs...)
		if err != nil {
			return res, err
		}
	}

	after, err := json.Marshal(map[string]int{
		"dataPoints":  res.DataPoints,
		"overrides":   res.Overrides,
		"versionText": res.VersionText,
		"notes":       len(cs.Notes),
		"findings":    len(res.Findings),
	})
	if err != nil {
		return res, err
	}
	entry := domain.AuditEntry{
		ID:         newID(),
		ActorID:    actor,
		Channel:    auditChannel,
		Action:     AuditAction,
		TargetType: "change_set",
		TargetID:   cs.ID,
		After:      after,
		At:         at,
	}
	if err := st.AppendAudit(ctx, tenantID, entry); err != nil {
		return res, fmt.Errorf("recording audit entry: %w", err)
	}
	res.Status = StatusApplied
	return res, nil
}

// applyVersionText applies changes to one draft version and saves it once.
// It returns how many changes were applied.
func applyVersionText(ctx context.Context, st store.Store, tenantID, scorecardID, versionID string, changes []VersionTextChange) (int, []Finding, error) {
	v, err := st.GetVersion(ctx, tenantID, scorecardID, versionID)
	if err != nil {
		return 0, nil, fmt.Errorf("version %q: %w", versionID, err)
	}
	if v.Status != domain.VersionDraft {
		return 0, nil, fmt.Errorf("version %q is %s: legacy text can only be applied to a draft version", versionID, v.Status)
	}
	var fs []Finding
	applied := 0
	for _, c := range changes {
		idx := -1
		for i := range v.Content.Metrics {
			if v.Content.Metrics[i].Key == c.MetricKey {
				idx = i
				break
			}
		}
		if idx < 0 {
			fs = append(fs, Finding{Severity: SeverityError,
				Message: fmt.Sprintf("version %s has no metric %q; %s not applied", versionID, c.MetricKey, c.Field)})
			continue
		}
		if err := setField(&v.Content.Metrics[idx], c); err != nil {
			fs = append(fs, Finding{Severity: SeverityError,
				Message: fmt.Sprintf("version %s metric %s: %v", versionID, c.MetricKey, err)})
			continue
		}
		applied++
	}
	if applied == 0 {
		return 0, fs, nil
	}
	if err := st.PutVersion(ctx, tenantID, v, v.Revision); err != nil {
		return 0, fs, fmt.Errorf("saving version %q: %w", versionID, err)
	}
	return applied, fs, nil
}

// setField sets one text field of m.
func setField(m *domain.Metric, c VersionTextChange) error {
	switch c.Field {
	case FieldDefinition:
		m.Definition = c.Value
	case FieldNotes:
		m.Notes = c.Value
	case FieldExample:
		m.Example = c.Value
	case FieldSource:
		m.Source = c.Value
	case FieldLink:
		m.Link = c.Value
	case FieldFrequency:
		f := domain.Frequency(c.Value)
		if !f.Valid() {
			return fmt.Errorf("frequency %q is not monthly, quarterly, biannual or annual", c.Value)
		}
		m.Frequency = f
	case FieldBands:
		var bv BandsValue
		if err := json.Unmarshal([]byte(c.Value), &bv); err != nil {
			return fmt.Errorf("bands value is not valid JSON: %w", err)
		}
		if len(bv.Bands) == 0 || !bv.Direction.Valid() {
			return fmt.Errorf("bands value needs bands and a direction")
		}
		// The imported thresholds replace the metric-level rule. Per-subject
		// bands are kept: they are separate exceptions the text does not cover.
		m.Rule = domain.StatusRule{Type: domain.RuleBands, Bands: bv.Bands, PerSubject: m.Rule.PerSubject}
		m.Direction = bv.Direction
	default:
		return fmt.Errorf("unknown field %q", c.Field)
	}
	return nil
}
