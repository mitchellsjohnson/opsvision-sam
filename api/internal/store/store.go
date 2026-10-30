// Package store defines the persistence interfaces the OpsVision API depends
// on. Implementations (in-memory, DynamoDB) must satisfy the shared contract
// suite in package storetest.
//
// Every tenant-scoped method takes the tenant ID immediately after the
// context, and an implementation must never return or modify another
// tenant's data.
package store

import (
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
	PutDataPoints(ctx context.Context, tenantID, scorecardID string, pts []DataWrite) ([]domain.DataPoint, error)
	// ListData returns current points and overrides whose Period.FY is in
	// fiscalYears. Both slices are non-nil.
	ListData(ctx context.Context, tenantID, scorecardID string, fiscalYears []int) ([]domain.DataPoint, []domain.Override, error)
	// History returns every revision (including the current one) of a point,
	// newest first.
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

// Template is a saved import mapping.
type Template struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Profile string          `json:"profile"`
	Body    json.RawMessage `json:"body,omitempty"`
}

// ImportStore holds imports and import templates. Puts upsert by ID.
type ImportStore interface {
	PutImport(ctx context.Context, tenantID string, im Import) error
	GetImport(ctx context.Context, tenantID, id string) (Import, error)
	PutTemplate(ctx context.Context, tenantID string, t Template) error
	// ListTemplates returns templates sorted by ID.
	ListTemplates(ctx context.Context, tenantID string) ([]Template, error)
}

// Store is the full persistence surface.
type Store interface {
	TenantStore
	OrgStore
	MethodologyStore
	DataStore
	AuditStore
	ImportStore
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
