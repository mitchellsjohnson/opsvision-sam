// Package store defines the persistence interfaces the OpsVision API depends
// on. Implementations (in-memory, DynamoDB) must satisfy the shared contract
// suite in package storetest.
//
// Every tenant-scoped method takes the tenant ID immediately after the
// context, and an implementation must never return or modify another
// tenant's data.
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// Sentinel errors. Implementations return them (possibly wrapped) so callers
// can test with errors.Is.
var (
	// ErrNotFound means the requested item does not exist (in that tenant).
	ErrNotFound = errors.New("not found")
	// ErrConflict means a uniqueness or optimistic-concurrency check failed.
	ErrConflict = errors.New("conflict")
)

// PendingUserPrefix prefixes the UserID of an invited member who has not yet
// signed in. The full UserID is PendingUserPrefix + lowercase(email).
const PendingUserPrefix = "pending:"

// ExpectedRevision values for DataWrite.
const (
	// MustNotExist requires that no data point exists yet.
	MustNotExist = 0
	// Unconditional writes regardless of the current revision (imports).
	Unconditional = -1
)

// TenantStore manages tenants and their memberships.
type TenantStore interface {
	// CreateTenant stores a new tenant. A duplicate ID, or a duplicate
	// non-empty Auth0OrgID, returns ErrConflict.
	CreateTenant(ctx context.Context, t domain.Tenant) error
	GetTenant(ctx context.Context, id string) (domain.Tenant, error)
	TenantByAuth0Org(ctx context.Context, orgID string) (domain.Tenant, error)
	// ListTenants returns all tenants sorted by Name then ID.
	ListTenants(ctx context.Context) ([]domain.Tenant, error)

	// PutMembership upserts a membership by UserID.
	PutMembership(ctx context.Context, tenantID string, m domain.Membership) error
	GetMembership(ctx context.Context, tenantID, userID string) (domain.Membership, error)
	// DeleteMembership returns ErrNotFound if the membership is absent.
	DeleteMembership(ctx context.Context, tenantID, userID string) error
	// ListMemberships returns memberships sorted by UserID.
	ListMemberships(ctx context.Context, tenantID string) ([]domain.Membership, error)
	// TenantsForUser returns the sorted IDs of tenants the user belongs to.
	TenantsForUser(ctx context.Context, userID string) ([]string, error)
}

// OrgStore manages the org model: levels, units, moves, item kinds, items.
// All Put methods upsert by ID (moves by UnitID + EffectiveMonth); all List
// methods return a non-nil slice.
type OrgStore interface {
	// PutLevels replaces the full set of levels.
	PutLevels(ctx context.Context, tenantID string, ls []domain.Level) error
	// ListLevels returns levels sorted by Depth, then ID.
	ListLevels(ctx context.Context, tenantID string) ([]domain.Level, error)

	PutOrgUnit(ctx context.Context, tenantID string, u domain.OrgUnit) error
	// ListOrgUnits returns units sorted by ID.
	ListOrgUnits(ctx context.Context, tenantID string) ([]domain.OrgUnit, error)

	PutOrgMove(ctx context.Context, tenantID string, m domain.OrgMove) error
	// ListOrgMoves returns moves sorted by UnitID then EffectiveMonth.
	ListOrgMoves(ctx context.Context, tenantID string) ([]domain.OrgMove, error)

	PutItemKind(ctx context.Context, tenantID string, k domain.ItemKind) error
	// ListItemKinds returns kinds sorted by ID.
	ListItemKinds(ctx context.Context, tenantID string) ([]domain.ItemKind, error)

	PutTrackedItem(ctx context.Context, tenantID string, it domain.TrackedItem) error
	// ListTrackedItems returns items sorted by ID.
	ListTrackedItems(ctx context.Context, tenantID string) ([]domain.TrackedItem, error)
}

// MethodologyStore manages scorecards and their revisioned versions.
type MethodologyStore interface {
	PutScorecard(ctx context.Context, tenantID string, s domain.Scorecard) error
	GetScorecard(ctx context.Context, tenantID, id string) (domain.Scorecard, error)
	// ListScorecards returns scorecards sorted by ID.
	ListScorecards(ctx context.Context, tenantID string) ([]domain.Scorecard, error)

	// PutVersion saves a version with optimistic concurrency. With
	// expectedRevision 0 the version must not exist and is stored with
	// Revision 1. Otherwise expectedRevision must equal the stored Revision,
	// and the stored Revision becomes expectedRevision+1. A mismatch, or an
	// existing version on create, returns ErrConflict. The Revision field of v
	// is ignored. A non-create write to a missing version returns ErrConflict.
	PutVersion(ctx context.Context, tenantID string, v domain.MethodologyVersion, expectedRevision int) error
	GetVersion(ctx context.Context, tenantID, scorecardID, versionID string) (domain.MethodologyVersion, error)
	// ListVersions returns versions sorted by EffectiveFrom then ID.
	ListVersions(ctx context.Context, tenantID, scorecardID string) ([]domain.MethodologyVersion, error)
}

// DataWrite is one data point write with its concurrency expectation.
type DataWrite struct {
	Point domain.DataPoint
	// ExpectedRevision: 0 (MustNotExist) = the point must not exist;
	// -1 (Unconditional) = write regardless; n>0 = must equal the current
	// Revision.
	ExpectedRevision int
	// Delete removes the current point instead of writing Point's value. Only
	// Point's identity (MeasureKey, SubjectID, Period) and its EnteredBy and
	// EnteredAt are used. The revision check is the same as for a write: a
	// stale ExpectedRevision conflicts and Unconditional deletes regardless.
	// The history gains a tombstone revision (Deleted true, Source records,
	// no value), and the point disappears from ListData. Deleting a point
	// that does not exist is a no-op, unless its ExpectedRevision is a
	// positive revision, which conflicts like any write against a missing
	// point.
	Delete bool
}

// DataConflict describes one rejected write. Current is the stored point, or
// nil when none exists (an expected revision n>0 against a missing point).
type DataConflict struct {
	Write   DataWrite
	Current *domain.DataPoint
}

// ConflictError is returned by PutDataPoints when one or more writes fail
// their revision check. It matches ErrConflict under errors.Is.
type ConflictError struct {
	Conflicts []DataConflict
}

// Error implements error.
func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict: %d data point(s) changed", len(e.Conflicts))
}

// Is makes errors.Is(err, ErrConflict) true.
func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

// DataStore manages data points, their revision history, and overrides.
type DataStore interface {
	// PutDataPoints saves points with per-point revision checks. The saved
	// Revision is current+1 (1 if new); EnteredAt etc. are stored as given.
	// If any write conflicts, nothing is saved (in memstore) and a
	// *ConflictError is returned. Returns the saved points in input order.
	// A deleted point is returned as its tombstone (Deleted true); a no-op
	// delete is returned with Deleted true and Revision 0. A point written
	// after a delete continues the revision numbering past the tombstone and
	// behaves as new (it satisfies MustNotExist).
	PutDataPoints(ctx context.Context, tenantID, scorecardID string, pts []DataWrite) ([]domain.DataPoint, error)
	// ListData returns current points and overrides whose Period.FY is in
	// fiscalYears. Deleted points are not listed. Both slices are non-nil.
	ListData(ctx context.Context, tenantID, scorecardID string, fiscalYears []int) ([]domain.DataPoint, []domain.Override, error)
	// History returns every revision (including the current one) of a point,
	// newest first. A deleted point's history ends with its tombstone.
	History(ctx context.Context, tenantID, scorecardID, measureKey, subjectID string, p period.Period) ([]domain.DataPoint, error)
	// PutOverride upserts by (MetricKey, SubjectID, Period).
	PutOverride(ctx context.Context, tenantID, scorecardID string, o domain.Override) error
	// DeleteOverride returns ErrNotFound if the override is absent.
	DeleteOverride(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) error
}

// AuditStore holds the append-only audit log.
type AuditStore interface {
	AppendAudit(ctx context.Context, tenantID string, e domain.AuditEntry) error
	// ListAudit returns entries with from <= At < to sorted by At then ID.
	ListAudit(ctx context.Context, tenantID string, from, to time.Time) ([]domain.AuditEntry, error)
}

// Import is the record of one bulk data import.
type Import struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	ObjectKey  string          `json:"objectKey"`
	Profile    string          `json:"profile"`
	TemplateID string          `json:"templateId"`
	CreatedBy  string          `json:"createdBy"`
	CreatedAt  time.Time       `json:"createdAt"`
	ChangeSet  json.RawMessage `json:"changeSet,omitempty"`
}

// Template is a saved import mapping. Revision counts the saves of the
// template (1 after the first); the store assigns it. LastUsed is the last
// time the template was applied, set by the caller.
type Template struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Profile  string          `json:"profile"`
	Body     json.RawMessage `json:"body,omitempty"`
	Revision int             `json:"revision,omitempty"`
	LastUsed *time.Time      `json:"lastUsed,omitempty"`
}

// TemplateContentChanged reports whether next differs from prev in content,
// that is in Name, Profile or Body. ID, Revision and LastUsed are not content.
// Bodies are compared as JSON after compaction, so whitespace differences do
// not count; a Body that is not valid JSON is compared byte for byte, and an
// empty Body equals a nil one. Stores use it to decide whether PutTemplate
// increments Revision.
func TemplateContentChanged(prev, next Template) bool {
	if prev.Name != next.Name || prev.Profile != next.Profile {
		return true
	}
	return !bytes.Equal(compactJSON(prev.Body), compactJSON(next.Body))
}

func compactJSON(b json.RawMessage) []byte {
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		return b
	}
	return buf.Bytes()
}

// ImportStore holds imports and import templates. Puts upsert by ID.
type ImportStore interface {
	PutImport(ctx context.Context, tenantID string, im Import) error
	GetImport(ctx context.Context, tenantID, id string) (Import, error)
	// PutTemplate upserts a template. A new template is stored with Revision
	// 1. For an existing one the Revision increments only when the content
	// changes (see TemplateContentChanged: Name, Profile or Body); a save that
	// changes only LastUsed keeps the stored Revision. The Revision field of
	// t is ignored. LastUsed is stored as given, so a caller that edits a
	// template must carry the stored value forward.
	PutTemplate(ctx context.Context, tenantID string, t Template) error
	// ListTemplates returns templates sorted by ID.
	ListTemplates(ctx context.Context, tenantID string) ([]Template, error)
	// DeleteTemplate removes a template; ErrNotFound if it does not exist.
	DeleteTemplate(ctx context.Context, tenantID, id string) error
}

// RecordRevisionWrite is one record revision to store with a snapshot. The
// record is identified by (Source, ExternalID) within record type Type; Rev
// carries the revision's AsOf, SnapshotID and fields.
type RecordRevisionWrite struct {
	Source, ExternalID, Type string
	Rev                      domain.RecordRevision
}

// RecordStore holds record types, records (one stored item per revision),
// and upload snapshots.
type RecordStore interface {
	// PutRecordType saves a record type with optimistic concurrency and the
	// same semantics as PutVersion: expectedRevision 0 creates it with
	// Revision 1; otherwise expectedRevision must equal the stored Revision,
	// which becomes expectedRevision+1. A mismatch, an existing type on
	// create, or a non-create write to a missing type returns ErrConflict.
	// The Revision field of rt is ignored.
	PutRecordType(ctx context.Context, tenantID string, rt domain.RecordType, expectedRevision int) error
	// ListRecordTypes returns record types sorted by ID.
	ListRecordTypes(ctx context.Context, tenantID string) ([]domain.RecordType, error)

	// ApplySnapshot stores the snapshot and the record revisions revs. A
	// snapshot whose ID already exists for its record type returns
	// ErrConflict and stores nothing. A revision is keyed by (Type, Source,
	// ExternalID, AsOf), so writing one again replaces it; when several of
	// revs share a key the last wins. The write is not atomic in DynamoDB:
	// revisions are written before the snapshot, so after a partial failure
	// the snapshot is absent and applying again (with the same or a new ID)
	// is safe.
	ApplySnapshot(ctx context.Context, tenantID string, s domain.Snapshot, revs []RecordRevisionWrite) error
	// ListRecords returns the records of one type sorted by Source then
	// ExternalID, each with its revisions sorted by AsOf (oldest first).
	ListRecords(ctx context.Context, tenantID, recordType string) ([]domain.Record, error)
	// ListSnapshots returns the snapshots of one record type, newest AsOf
	// first (ties: newest CreatedAt first, then ID).
	ListSnapshots(ctx context.Context, tenantID, recordType string) ([]domain.Snapshot, error)
}

// Store is the full persistence surface.
type Store interface {
	TenantStore
	OrgStore
	MethodologyStore
	DataStore
	AuditStore
	ImportStore
	RecordStore
}

// ComparePeriod orders periods by fiscal year, then grain, then index. It
// returns a negative, zero, or positive number.
func ComparePeriod(a, b period.Period) int {
	switch {
	case a.FY != b.FY:
		return a.FY - b.FY
	case a.Grain != b.Grain:
		return int(a.Grain) - int(b.Grain)
	}
	return a.Index - b.Index
}
