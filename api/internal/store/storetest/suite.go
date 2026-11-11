// Package storetest is the contract suite every store.Store implementation
// must pass. Each subtest creates fresh tenant IDs so the suite can run
// against a shared real table as well as an in-memory store.
package storetest

import (
	stdcmp "cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

var seq atomic.Int64

// uid returns an ID that is unique across subtests, runs, and processes.
func uid(prefix string) string {
	return fmt.Sprintf("%s-%x-%d", prefix, time.Now().UnixNano(), seq.Add(1))
}

func ptr(f float64) *float64 { return &f }

func month(fy, idx int) period.Period {
	return period.Period{Grain: period.Month, FY: fy, Index: idx}
}

func at(day int) time.Time { return time.Date(2026, time.October, day, 12, 0, 0, 0, time.UTC) }

// Run executes the contract suite against stores produced by newStore.
func Run(t *testing.T, newStore func(t *testing.T) store.Store) {
	cases := []struct {
		name string
		fn   func(t *testing.T, s store.Store)
	}{
		{"TenantRoundTrip", tenantRoundTrip},
		{"Auth0OrgLookup", auth0OrgLookup},
		{"MembershipsScopedByTenant", membershipsScopedByTenant},
		{"PendingMembershipLifecycle", pendingMembershipLifecycle},
		{"OrgModelRoundTrip", orgModelRoundTrip},
		{"VersionOptimisticConcurrency", versionOptimisticConcurrency},
		{"DataRevisionsAppend", dataRevisionsAppend},
		{"ConflictOnStaleRevision", conflictOnStaleRevision},
		{"ConflictErrorCarriesCurrent", conflictErrorCarriesCurrent},
		{"DataAllOrNothing", dataAllOrNothing},
		{"UnconditionalWrite", unconditionalWrite},
		{"ListDataByFiscalYear", listDataByFiscalYear},
		{"OverridesRoundTrip", overridesRoundTrip},
		{"ImportsAndTemplates", importsAndTemplates},
		{"TenantIsolation", tenantIsolation},
		{"AuditRange", auditRange},
		{"DeleteMissing", deleteMissing},
		{"ListsAreSorted", listsAreSorted},
		{"ReturnedValuesAreCopies", returnedValuesAreCopies},
		{"ConcurrentWritersOneWins", concurrentWritersOneWins},
		{"TemplateRevisionIncrements", templateRevisionIncrements},
		{"TemplateLastUsedKeepsRevision", templateLastUsedKeepsRevision},
		{"LayoutRevision", layoutRevision},
		{"ReportSummaryRevision", reportSummaryRevision},
		{"RecordTypeRevision", recordTypeRevision},
		{"ApplySnapshotGroupsRevisions", applySnapshotGroupsRevisions},
		{"ApplySnapshotLargeBatch", applySnapshotLargeBatch},
		{"ApplySnapshotDuplicateIDConflict", applySnapshotDuplicateIDConflict},
		{"SnapshotsNewestFirst", snapshotsNewestFirst},
		{"RecordsCrossTenant", recordsCrossTenant},
		{"ExternalIDWithHash", externalIDWithHash},
		{"DeleteDataPoint", deleteDataPoint},
		{"DeleteDataPointRevisionChecks", deleteDataPointRevisionChecks},
		{"DeleteDataPointCrossTenant", deleteDataPointCrossTenant},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { c.fn(t, newStore(t)) })
	}
}

// --- helpers ---------------------------------------------------------------

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}

// wantEq compares with cmpopts.EquateEmpty: a nil and an empty slice or map
// are equal, because stores are not required to preserve that distinction.
func wantEq[T any](t *testing.T, what string, got, want T) {
	t.Helper()
	sameDate := cmp.Comparer(func(a, b domain.Date) bool { return a.Time.Equal(b.Time) })
	if d := cmp.Diff(want, got, cmpopts.EquateEmpty(), sameDate); d != "" {
		t.Fatalf("%s mismatch (-want +got):\n%s", what, d)
	}
}

// wantEmpty requires a non-nil, zero-length slice (and no error).
func wantEmpty[T any](t *testing.T, what string, got []T, err error) {
	t.Helper()
	must(t, err)
	if got == nil || len(got) != 0 {
		t.Fatalf("%s = %#v, want empty non-nil slice", what, got)
	}
}

func newTenant(t *testing.T, s store.Store) string {
	t.Helper()
	id := uid("tenant")
	must(t, s.CreateTenant(context.Background(), domain.Tenant{
		ID:                   id,
		Name:                 "Tenant " + id,
		Auth0OrgID:           uid("org"),
		FiscalYearStartMonth: time.October,
		StatusScale:          domain.DefaultStatusScale(),
		DefaultRole:          domain.RoleViewer,
		CreatedAt:            at(1),
	}))
	return id
}

func point(measure, subject string, p period.Period, v float64) domain.DataPoint {
	return domain.DataPoint{
		MeasureKey: measure, SubjectID: subject, Period: p, Value: ptr(v),
		Source: domain.SourceGrid, EnteredBy: "user-1", EnteredAt: at(2),
	}
}

func current(t *testing.T, s store.Store, tenant, sc string, fy int) []domain.DataPoint {
	t.Helper()
	pts, _, err := s.ListData(context.Background(), tenant, sc, []int{fy})
	must(t, err)
	return pts
}

func sortPoints(pts []domain.DataPoint) {
	slices.SortFunc(pts, func(a, b domain.DataPoint) int {
		return stdcmp.Or(
			strings.Compare(a.MeasureKey, b.MeasureKey),
			strings.Compare(a.SubjectID, b.SubjectID),
			store.ComparePeriod(a.Period, b.Period),
		)
	})
}

func sortOverrides(os []domain.Override) {
	slices.SortFunc(os, func(a, b domain.Override) int {
		return stdcmp.Or(
			strings.Compare(a.MetricKey, b.MetricKey),
			strings.Compare(a.SubjectID, b.SubjectID),
			store.ComparePeriod(a.Period, b.Period),
		)
	})
}

// --- tenants & memberships -------------------------------------------------

func tenantRoundTrip(t *testing.T, s store.Store) {
	ctx := context.Background()
	id := uid("tenant")
	want := domain.Tenant{
		ID: id, Name: "Acme Operations", Auth0OrgID: uid("org"),
		FiscalYearStartMonth: time.October,
		StatusScale:          domain.DefaultStatusScale(),
		DefaultRole:          domain.RoleContributor,
		CreatedAt:            at(3),
	}
	must(t, s.CreateTenant(ctx, want))
	got, err := s.GetTenant(ctx, id)
	must(t, err)
	wantEq(t, "tenant", got, want)

	_, err = s.GetTenant(ctx, uid("missing"))
	wantErr(t, err, store.ErrNotFound)

	dup := want
	dup.Auth0OrgID = uid("org")
	wantErr(t, s.CreateTenant(ctx, dup), store.ErrConflict)

	// The failed duplicate must not have changed the stored tenant.
	got, err = s.GetTenant(ctx, id)
	must(t, err)
	wantEq(t, "tenant after duplicate", got, want)

	all, err := s.ListTenants(ctx)
	must(t, err)
	if !slices.ContainsFunc(all, func(x domain.Tenant) bool { return x.ID == id }) {
		t.Fatalf("ListTenants missing %s", id)
	}
}

func auth0OrgLookup(t *testing.T, s store.Store) {
	ctx := context.Background()
	org := uid("org")
	a := domain.Tenant{ID: uid("tenant"), Name: "A", Auth0OrgID: org, DefaultRole: domain.RoleViewer}
	must(t, s.CreateTenant(ctx, a))

	got, err := s.TenantByAuth0Org(ctx, org)
	must(t, err)
	wantEq(t, "tenant by org", got, a)

	_, err = s.TenantByAuth0Org(ctx, uid("org"))
	wantErr(t, err, store.ErrNotFound)

	// Same Auth0 org on a different tenant ID conflicts.
	b := domain.Tenant{ID: uid("tenant"), Name: "B", Auth0OrgID: org}
	wantErr(t, s.CreateTenant(ctx, b), store.ErrConflict)
	_, err = s.GetTenant(ctx, b.ID)
	wantErr(t, err, store.ErrNotFound)

	// Several tenants may leave Auth0OrgID empty.
	c := domain.Tenant{ID: uid("tenant"), Name: "C"}
	d := domain.Tenant{ID: uid("tenant"), Name: "D"}
	must(t, s.CreateTenant(ctx, c))
	must(t, s.CreateTenant(ctx, d))
	_, err = s.TenantByAuth0Org(ctx, "")
	wantErr(t, err, store.ErrNotFound)
}

func membershipsScopedByTenant(t *testing.T, s store.Store) {
	ctx := context.Background()
	ta, tb := newTenant(t, s), newTenant(t, s)
	shared, onlyA := uid("user"), uid("user")

	ma := domain.Membership{
		UserID: shared, Email: "shared@example.test", Name: "Shared", Role: domain.RoleAdmin,
		Scope:     domain.Scope{OrgUnitIDs: []string{"u1"}, MetricKeys: []string{"m1"}},
		CreatedAt: at(4),
	}
	mb := domain.Membership{UserID: shared, Email: "shared@example.test", Name: "Shared", Role: domain.RoleViewer, CreatedAt: at(4)}
	mo := domain.Membership{UserID: onlyA, Email: "a@example.test", Role: domain.RoleContributor, CreatedAt: at(4)}
	must(t, s.PutMembership(ctx, ta, ma))
	must(t, s.PutMembership(ctx, tb, mb))
	must(t, s.PutMembership(ctx, ta, mo))

	got, err := s.GetMembership(ctx, ta, shared)
	must(t, err)
	wantEq(t, "membership in A", got, ma)
	got, err = s.GetMembership(ctx, tb, shared)
	must(t, err)
	wantEq(t, "membership in B", got, mb)

	_, err = s.GetMembership(ctx, tb, onlyA)
	wantErr(t, err, store.ErrNotFound)

	list, err := s.ListMemberships(ctx, ta)
	must(t, err)
	want := []domain.Membership{ma, mo}
	slices.SortFunc(want, func(x, y domain.Membership) int { return strings.Compare(x.UserID, y.UserID) })
	wantEq(t, "memberships in A", list, want)

	list, err = s.ListMemberships(ctx, tb)
	must(t, err)
	wantEq(t, "memberships in B", list, []domain.Membership{mb})

	ids, err := s.TenantsForUser(ctx, shared)
	must(t, err)
	wantEq(t, "tenants for shared user", ids, sorted(ta, tb))
	ids, err = s.TenantsForUser(ctx, onlyA)
	must(t, err)
	wantEq(t, "tenants for A-only user", ids, []string{ta})
	ids, err = s.TenantsForUser(ctx, uid("nobody"))
	wantEmpty(t, "tenants for unknown user", ids, err)

	// Upsert replaces by UserID.
	ma.Role = domain.RoleViewer
	ma.Name = "Renamed"
	must(t, s.PutMembership(ctx, ta, ma))
	got, err = s.GetMembership(ctx, ta, shared)
	must(t, err)
	wantEq(t, "upserted membership", got, ma)
	list, err = s.ListMemberships(ctx, ta)
	must(t, err)
	if len(list) != 2 {
		t.Fatalf("upsert created a duplicate: %d memberships, want 2", len(list))
	}

	// Deleting in A leaves B alone.
	must(t, s.DeleteMembership(ctx, ta, shared))
	_, err = s.GetMembership(ctx, ta, shared)
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetMembership(ctx, tb, shared)
	must(t, err)
	ids, err = s.TenantsForUser(ctx, shared)
	must(t, err)
	wantEq(t, "tenants after delete", ids, []string{tb})
}

func sorted(ss ...string) []string {
	out := slices.Clone(ss)
	slices.Sort(out)
	return out
}

func pendingMembershipLifecycle(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	email := uid("invitee") + "@example.test"
	pendingID := "pending:" + strings.ToLower(email)

	pending := domain.Membership{UserID: pendingID, Email: email, Role: domain.RoleContributor, CreatedAt: at(5)}
	must(t, s.PutMembership(ctx, tn, pending))

	got, err := s.GetMembership(ctx, tn, pendingID)
	must(t, err)
	wantEq(t, "pending membership", got, pending)
	ids, err := s.TenantsForUser(ctx, pendingID)
	must(t, err)
	wantEq(t, "tenants for pending user", ids, []string{tn})

	// Acceptance: the real membership replaces the pending one.
	userID := uid("user")
	real := domain.Membership{UserID: userID, Email: email, Name: "Invitee", Role: domain.RoleContributor, CreatedAt: at(6)}
	must(t, s.PutMembership(ctx, tn, real))
	must(t, s.DeleteMembership(ctx, tn, pendingID))

	_, err = s.GetMembership(ctx, tn, pendingID)
	wantErr(t, err, store.ErrNotFound)
	list, err := s.ListMemberships(ctx, tn)
	must(t, err)
	wantEq(t, "memberships after acceptance", list, []domain.Membership{real})
	ids, err = s.TenantsForUser(ctx, pendingID)
	wantEmpty(t, "tenants for pending user after acceptance", ids, err)
	ids, err = s.TenantsForUser(ctx, userID)
	must(t, err)
	wantEq(t, "tenants for accepted user", ids, []string{tn})

	wantErr(t, s.DeleteMembership(ctx, tn, pendingID), store.ErrNotFound)
}

// --- org model -------------------------------------------------------------

func orgModelRoundTrip(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	levels := []domain.Level{{ID: "team", Name: "Team", Depth: 1}, {ID: "div", Name: "Division", Depth: 0}}
	must(t, s.PutLevels(ctx, tn, levels))
	gotL, err := s.ListLevels(ctx, tn)
	must(t, err)
	wantEq(t, "levels", gotL, []domain.Level{levels[1], levels[0]})

	// PutLevels replaces the full set.
	must(t, s.PutLevels(ctx, tn, []domain.Level{{ID: "org", Name: "Org", Depth: 0}}))
	gotL, err = s.ListLevels(ctx, tn)
	must(t, err)
	wantEq(t, "levels after replace", gotL, []domain.Level{{ID: "org", Name: "Org", Depth: 0}})

	retired := month(2027, 3)
	units := []domain.OrgUnit{
		{ID: "u-root", Name: "Root", LevelID: "org", SourceKeys: []string{"R1", "R2"}},
		{ID: "u-east", Name: "East", LevelID: "div", ParentID: "u-root", SourceKeys: []string{}, RetiredFrom: &retired},
	}
	for _, u := range units {
		must(t, s.PutOrgUnit(ctx, tn, u))
	}
	gotU, err := s.ListOrgUnits(ctx, tn)
	must(t, err)
	wantEq(t, "units", gotU, []domain.OrgUnit{units[1], units[0]})

	// Upsert by ID.
	units[0].Name = "Root Renamed"
	must(t, s.PutOrgUnit(ctx, tn, units[0]))
	gotU, err = s.ListOrgUnits(ctx, tn)
	must(t, err)
	wantEq(t, "units after upsert", gotU, []domain.OrgUnit{units[1], units[0]})

	m1 := domain.OrgMove{UnitID: "u-east", NewParentID: "u-west", EffectiveMonth: month(2027, 1), Note: "reorg"}
	m2 := domain.OrgMove{UnitID: "u-east", NewParentID: "u-root", EffectiveMonth: month(2026, 11)}
	must(t, s.PutOrgMove(ctx, tn, m1))
	must(t, s.PutOrgMove(ctx, tn, m2))
	m1.Note = "updated"
	must(t, s.PutOrgMove(ctx, tn, m1)) // upsert by UnitID+EffectiveMonth
	gotM, err := s.ListOrgMoves(ctx, tn)
	must(t, err)
	wantEq(t, "moves", gotM, []domain.OrgMove{m2, m1})

	kinds := []domain.ItemKind{{ID: "k-b", Name: "Service"}, {ID: "k-a", Name: "Application"}}
	for _, k := range kinds {
		must(t, s.PutItemKind(ctx, tn, k))
	}
	gotK, err := s.ListItemKinds(ctx, tn)
	must(t, err)
	wantEq(t, "kinds", gotK, []domain.ItemKind{kinds[1], kinds[0]})

	items := []domain.TrackedItem{
		{ID: "i-2", KindID: "k-a", Name: "Beta", OrgUnitID: "u-east", SourceKeys: []string{"B"}},
		{ID: "i-1", KindID: "k-a", Name: "Alpha", OrgUnitID: "u-root", SourceKeys: []string{"A"}},
	}
	for _, it := range items {
		must(t, s.PutTrackedItem(ctx, tn, it))
	}
	items[0].Name = "Beta Renamed"
	must(t, s.PutTrackedItem(ctx, tn, items[0]))
	gotI, err := s.ListTrackedItems(ctx, tn)
	must(t, err)
	wantEq(t, "items", gotI, []domain.TrackedItem{items[1], items[0]})
}

// --- methodology -----------------------------------------------------------

func version(sc, id, name string, eff period.Period) domain.MethodologyVersion {
	return domain.MethodologyVersion{
		ID: id, ScorecardID: sc, Name: name, Status: domain.VersionDraft, EffectiveFrom: eff,
		Content: domain.Methodology{
			Categories: []domain.Category{{ID: "c1", Name: "Cat", Order: 1}},
			Measures:   []domain.Measure{{Key: "m1", Name: "Measure", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum}},
			Metrics: []domain.Metric{{
				Key: "x", Name: "X", CategoryID: "c1", Formula: "m1", Format: domain.FormatNumber0,
				Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "div"}},
				Rule:       domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{{Status: "G", Op: ">=", Value: 90}, {Status: "R"}}},
				Targets:    []domain.Target{{Label: "FY", From: month(2026, 1), To: month(2026, 12), Value: 95}},
			}},
		},
	}
}

func versionOptimisticConcurrency(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	sc := domain.Scorecard{ID: "sc-1", Name: "Operations"}
	must(t, s.PutScorecard(ctx, tn, sc))
	got, err := s.GetScorecard(ctx, tn, "sc-1")
	must(t, err)
	wantEq(t, "scorecard", got, sc)
	_, err = s.GetScorecard(ctx, tn, "sc-missing")
	wantErr(t, err, store.ErrNotFound)

	v := version("sc-1", "v-1", "First", month(2026, 1))
	must(t, s.PutVersion(ctx, tn, v, 0))
	stored, err := s.GetVersion(ctx, tn, "sc-1", "v-1")
	must(t, err)
	v.Revision = 1
	wantEq(t, "created version", stored, v)

	// Creating again conflicts.
	wantErr(t, s.PutVersion(ctx, tn, v, 0), store.ErrConflict)

	// Update from revision 1 succeeds and bumps the revision.
	v2 := v
	v2.Name = "Second"
	v2.Status = domain.VersionInReview
	must(t, s.PutVersion(ctx, tn, v2, 1))
	stored, err = s.GetVersion(ctx, tn, "sc-1", "v-1")
	must(t, err)
	v2.Revision = 2
	wantEq(t, "updated version", stored, v2)

	// A stale writer still holding revision 1 conflicts and changes nothing.
	stale := v
	stale.Name = "Stale"
	wantErr(t, s.PutVersion(ctx, tn, stale, 1), store.ErrConflict)
	stored, err = s.GetVersion(ctx, tn, "sc-1", "v-1")
	must(t, err)
	wantEq(t, "version after stale write", stored, v2)

	// A revision ahead of the stored one also conflicts.
	wantErr(t, s.PutVersion(ctx, tn, v2, 5), store.ErrConflict)

	// Chain continues.
	v3 := v2
	v3.Name = "Third"
	must(t, s.PutVersion(ctx, tn, v3, 2))
	stored, err = s.GetVersion(ctx, tn, "sc-1", "v-1")
	must(t, err)
	if stored.Revision != 3 || stored.Name != "Third" {
		t.Fatalf("stored = rev %d %q, want rev 3 Third", stored.Revision, stored.Name)
	}

	// Updating a version that does not exist conflicts.
	wantErr(t, s.PutVersion(ctx, tn, version("sc-1", "v-none", "None", month(2026, 1)), 1), store.ErrConflict)
	_, err = s.GetVersion(ctx, tn, "sc-1", "v-none")
	wantErr(t, err, store.ErrNotFound)

	// The same version ID under another scorecard is a different version.
	other := version("sc-2", "v-1", "Other", month(2026, 1))
	must(t, s.PutVersion(ctx, tn, other, 0))
	stored, err = s.GetVersion(ctx, tn, "sc-2", "v-1")
	must(t, err)
	if stored.Name != "Other" || stored.Revision != 1 {
		t.Fatalf("sc-2 version = %q rev %d, want Other rev 1", stored.Name, stored.Revision)
	}
	_, err = s.GetVersion(ctx, tn, "sc-3", "v-1")
	wantErr(t, err, store.ErrNotFound)
}

// --- data ------------------------------------------------------------------

func dataRevisionsAppend(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 3)

	var wantHist []domain.DataPoint
	for rev := 1; rev <= 3; rev++ {
		pt := point("m1", "u1", p, float64(rev*10))
		pt.EnteredAt = at(rev)
		saved, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: pt, ExpectedRevision: rev - 1}})
		must(t, err)
		if len(saved) != 1 || saved[0].Revision != rev {
			t.Fatalf("saved = %+v, want one point at revision %d", saved, rev)
		}
		pt.Revision = rev
		wantEq(t, "returned point", saved[0], pt)
		wantHist = append([]domain.DataPoint{pt}, wantHist...) // newest first
	}

	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	wantEq(t, "history", hist, wantHist)

	cur := current(t, s, tn, "sc", 2026)
	wantEq(t, "current points", cur, []domain.DataPoint{wantHist[0]})

	// Different subject/period/scorecard have independent histories.
	hist, err = s.History(ctx, tn, "sc", "m1", "u2", p)
	wantEmpty(t, "history for other subject", hist, err)
	hist, err = s.History(ctx, tn, "sc-other", "m1", "u1", p)
	wantEmpty(t, "history in other scorecard", hist, err)

	// N/A points (nil value) round-trip.
	na := domain.DataPoint{MeasureKey: "m2", SubjectID: "u1", Period: p, NAReason: "not tracked", Source: domain.SourceImport, EnteredBy: "imp", EnteredAt: at(9)}
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: na, ExpectedRevision: store.MustNotExist}})
	must(t, err)
	hist, err = s.History(ctx, tn, "sc", "m2", "u1", p)
	must(t, err)
	na.Revision = 1
	wantEq(t, "n/a history", hist, []domain.DataPoint{na})
}

func conflictOnStaleRevision(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 4)

	_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 1), ExpectedRevision: 0}})
	must(t, err)

	// Two writers both read revision 1.
	first := point("m1", "u1", p, 100)
	first.EnteredBy = "writer-1"
	second := point("m1", "u1", p, 200)
	second.EnteredBy = "writer-2"

	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: first, ExpectedRevision: 1}})
	must(t, err)
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: second, ExpectedRevision: 1}})
	wantErr(t, err, store.ErrConflict)

	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || cur[0].Value == nil || *cur[0].Value != 100 || cur[0].EnteredBy != "writer-1" || cur[0].Revision != 2 {
		t.Fatalf("stored = %+v, want the first writer's value at revision 2", cur)
	}
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	if len(hist) != 2 {
		t.Fatalf("history has %d revisions, want 2 (the rejected write must not append)", len(hist))
	}

	// Creating something that already exists conflicts too.
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: second, ExpectedRevision: 0}})
	wantErr(t, err, store.ErrConflict)
}

func conflictErrorCarriesCurrent(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 5)

	_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 1), ExpectedRevision: 0}})
	must(t, err)
	winner := point("m1", "u1", p, 42)
	winner.EnteredBy = "winner"
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: winner, ExpectedRevision: 1}})
	must(t, err)

	loser := store.DataWrite{Point: point("m1", "u1", p, 7), ExpectedRevision: 1}
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{loser})
	wantErr(t, err, store.ErrConflict)

	var ce *store.ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("error %v (%T) is not a *store.ConflictError", err, err)
	}
	if len(ce.Conflicts) != 1 {
		t.Fatalf("conflicts = %d, want 1", len(ce.Conflicts))
	}
	c := ce.Conflicts[0]
	wantEq(t, "conflict write", c.Write, loser)
	if c.Current == nil {
		t.Fatal("conflict Current is nil, want the stored point")
	}
	winner.Revision = 2
	wantEq(t, "conflict current", *c.Current, winner)

	// Expecting a revision for a point that does not exist: Current is nil.
	ghost := store.DataWrite{Point: point("m9", "u1", p, 1), ExpectedRevision: 3}
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{ghost})
	wantErr(t, err, store.ErrConflict)
	ce = nil
	if !errors.As(err, &ce) || len(ce.Conflicts) != 1 {
		t.Fatalf("want one conflict for missing point, got %v", err)
	}
	if ce.Conflicts[0].Current != nil {
		t.Fatalf("Current = %+v for a missing point, want nil", ce.Conflicts[0].Current)
	}

	// The error must not leak a mutable view into the store.
	c.Current.Revision = 99
	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || cur[0].Revision != 2 {
		t.Fatalf("stored point changed through a ConflictError: %+v", cur)
	}
}

func dataAllOrNothing(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 6)

	_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m2", "u1", p, 5), ExpectedRevision: 0}})
	must(t, err)

	batch := []store.DataWrite{
		{Point: point("m1", "u1", p, 1), ExpectedRevision: 0},
		{Point: point("m2", "u1", p, 2), ExpectedRevision: 0}, // exists: conflict
		{Point: point("m3", "u1", p, 3), ExpectedRevision: 0},
	}
	saved, err := s.PutDataPoints(ctx, tn, "sc", batch)
	wantErr(t, err, store.ErrConflict)
	if saved != nil {
		t.Fatalf("saved = %+v on conflict, want nil", saved)
	}
	var ce *store.ConflictError
	if !errors.As(err, &ce) || len(ce.Conflicts) != 1 || ce.Conflicts[0].Write.Point.MeasureKey != "m2" {
		t.Fatalf("want exactly the m2 conflict, got %v", err)
	}

	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || cur[0].MeasureKey != "m2" || *cur[0].Value != 5 || cur[0].Revision != 1 {
		t.Fatalf("store after rejected batch = %+v, want only the original m2", cur)
	}
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	wantEmpty(t, "history of m1 after rejected batch", hist, err)

	// Multiple conflicts are all reported.
	batch[0].ExpectedRevision = 4
	_, err = s.PutDataPoints(ctx, tn, "sc", batch)
	ce = nil
	if !errors.As(err, &ce) || len(ce.Conflicts) != 2 {
		t.Fatalf("want two conflicts, got %v", err)
	}

	// The corrected batch then succeeds in full, in input order.
	batch = []store.DataWrite{
		{Point: point("m1", "u1", p, 1), ExpectedRevision: 0},
		{Point: point("m2", "u1", p, 2), ExpectedRevision: 1},
		{Point: point("m3", "u1", p, 3), ExpectedRevision: 0},
	}
	saved, err = s.PutDataPoints(ctx, tn, "sc", batch)
	must(t, err)
	var keys []string
	var revs []int
	for _, sp := range saved {
		keys = append(keys, sp.MeasureKey)
		revs = append(revs, sp.Revision)
	}
	wantEq(t, "saved order", keys, []string{"m1", "m2", "m3"})
	wantEq(t, "saved revisions", revs, []int{1, 2, 1})
	if got := current(t, s, tn, "sc", 2026); len(got) != 3 {
		t.Fatalf("current points = %d, want 3", len(got))
	}
}

func unconditionalWrite(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 7)

	// Unconditional creates a missing point at revision 1.
	saved, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 1), ExpectedRevision: store.Unconditional}})
	must(t, err)
	if saved[0].Revision != 1 {
		t.Fatalf("revision = %d, want 1", saved[0].Revision)
	}

	// And overwrites an existing one regardless of its revision.
	for i, want := range []int{2, 3} {
		saved, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, float64(10+i)), ExpectedRevision: -1}})
		must(t, err)
		if saved[0].Revision != want {
			t.Fatalf("revision = %d, want %d", saved[0].Revision, want)
		}
	}
	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || *cur[0].Value != 11 || cur[0].Revision != 3 {
		t.Fatalf("current = %+v, want value 11 at revision 3", cur)
	}
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	if len(hist) != 3 || hist[0].Revision != 3 || hist[2].Revision != 1 {
		t.Fatalf("history = %+v, want revisions 3,2,1", hist)
	}
}

func listDataByFiscalYear(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	var writes []store.DataWrite
	for _, fy := range []int{2025, 2026, 2027} {
		writes = append(writes, store.DataWrite{Point: point("m1", "u1", month(fy, 1), float64(fy)), ExpectedRevision: 0})
		writes = append(writes, store.DataWrite{Point: point("m1", "u1", period.Period{Grain: period.Year, FY: fy}, float64(fy)), ExpectedRevision: 0})
	}
	_, err := s.PutDataPoints(ctx, tn, "sc", writes)
	must(t, err)
	// A different scorecard's data must not appear, even for a fiscal year
	// that is in the queried set (2027).
	otherPoint := point("m1", "u1", month(2027, 1), 999)
	_, err = s.PutDataPoints(ctx, tn, "sc-other", []store.DataWrite{{Point: otherPoint, ExpectedRevision: 0}})
	must(t, err)
	must(t, s.PutOverride(ctx, tn, "sc-other", domain.Override{MetricKey: "x", SubjectID: "u1", Period: month(2027, 2), Status: "R", Reason: "other scorecard", By: "u", At: at(1)}))

	for _, fy := range []int{2025, 2026, 2027} {
		must(t, s.PutOverride(ctx, tn, "sc", domain.Override{MetricKey: "x", SubjectID: "u1", Period: month(fy, 2), Status: "Y", Reason: "r", By: "u", At: at(1)}))
	}

	pts, ovs, err := s.ListData(ctx, tn, "sc", []int{2025, 2027})
	must(t, err)
	sortPoints(pts)
	sortOverrides(ovs)
	if len(pts) != 4 || len(ovs) != 2 {
		t.Fatalf("got %d points, %d overrides; want 4, 2", len(pts), len(ovs))
	}
	for _, p := range pts {
		if p.Period.FY != 2025 && p.Period.FY != 2027 {
			t.Fatalf("point outside requested fiscal years: %+v", p)
		}
		if *p.Value == 999 {
			t.Fatalf("point from another scorecard leaked: %+v", p)
		}
	}
	for _, o := range ovs {
		if o.Period.FY != 2025 && o.Period.FY != 2027 {
			t.Fatalf("override outside requested fiscal years: %+v", o)
		}
		if o.Reason == "other scorecard" {
			t.Fatalf("override from another scorecard leaked: %+v", o)
		}
	}

	// The other scorecard sees only its own data.
	pts, ovs, err = s.ListData(ctx, tn, "sc-other", []int{2025, 2027})
	must(t, err)
	if len(pts) != 1 || *pts[0].Value != 999 || len(ovs) != 1 || ovs[0].Reason != "other scorecard" {
		t.Fatalf("sc-other data = %+v / %+v, want its own point and override only", pts, ovs)
	}

	pts, ovs, err = s.ListData(ctx, tn, "sc", []int{2030})
	wantEmpty(t, "points for unused fiscal year", pts, err)
	wantEmpty(t, "overrides for unused fiscal year", ovs, nil)

	pts, ovs, err = s.ListData(ctx, tn, "sc", nil)
	wantEmpty(t, "points for no fiscal years", pts, err)
	wantEmpty(t, "overrides for no fiscal years", ovs, nil)
}

func overridesRoundTrip(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 8)

	o := domain.Override{MetricKey: "x", SubjectID: "u1", Period: p, Value: ptr(55), Status: "Y", Reason: "known outage", By: "user-1", At: at(7)}
	must(t, s.PutOverride(ctx, tn, "sc", o))
	_, ovs, err := s.ListData(ctx, tn, "sc", []int{2026})
	must(t, err)
	wantEq(t, "overrides", ovs, []domain.Override{o})

	// Upsert by (MetricKey, SubjectID, Period).
	o.Status = "R"
	o.Value = nil
	o.Reason = "revised"
	must(t, s.PutOverride(ctx, tn, "sc", o))
	other := domain.Override{MetricKey: "x", SubjectID: "u2", Period: p, Status: "G", Reason: "other subject", By: "user-1", At: at(8)}
	must(t, s.PutOverride(ctx, tn, "sc", other))
	_, ovs, err = s.ListData(ctx, tn, "sc", []int{2026})
	must(t, err)
	sortOverrides(ovs)
	wantEq(t, "overrides after upsert", ovs, []domain.Override{o, other})

	// Overrides do not disturb data points.
	pts := current(t, s, tn, "sc", 2026)
	wantEmpty(t, "points", pts, nil)

	must(t, s.DeleteOverride(ctx, tn, "sc", "x", "u1", p))
	_, ovs, err = s.ListData(ctx, tn, "sc", []int{2026})
	must(t, err)
	wantEq(t, "overrides after delete", ovs, []domain.Override{other})
	wantErr(t, s.DeleteOverride(ctx, tn, "sc", "x", "u1", p), store.ErrNotFound)
}

// --- imports ---------------------------------------------------------------

func importsAndTemplates(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	im := store.Import{
		ID: "imp-1", Status: "uploaded", ObjectKey: "tenants/x/imp-1.xlsx", Profile: "workbook",
		TemplateID: "t-1", CreatedBy: "user-1", CreatedAt: at(10),
		ChangeSet: json.RawMessage(`{"adds":3}`),
	}
	must(t, s.PutImport(ctx, tn, im))
	got, err := s.GetImport(ctx, tn, "imp-1")
	must(t, err)
	wantEq(t, "import", got, im)

	im.Status = "applied"
	im.ChangeSet = json.RawMessage(`{"adds":3,"applied":true}`)
	must(t, s.PutImport(ctx, tn, im))
	got, err = s.GetImport(ctx, tn, "imp-1")
	must(t, err)
	wantEq(t, "import after upsert", got, im)

	_, err = s.GetImport(ctx, tn, "imp-missing")
	wantErr(t, err, store.ErrNotFound)

	tpls := []store.Template{
		{ID: "t-b", Name: "B", Profile: "workbook", Body: json.RawMessage(`{"cols":[1]}`)},
		{ID: "t-a", Name: "A", Profile: "csv", Body: json.RawMessage(`{"cols":[2]}`)},
	}
	for _, tp := range tpls {
		must(t, s.PutTemplate(ctx, tn, tp))
	}
	tpls[0].Name = "B renamed"
	must(t, s.PutTemplate(ctx, tn, tpls[0]))
	list, err := s.ListTemplates(ctx, tn)
	must(t, err)
	// The store assigns Revision: t-b was saved twice, t-a once.
	tpls[0].Revision, tpls[1].Revision = 2, 1
	wantEq(t, "templates", list, []store.Template{tpls[1], tpls[0]})

	// DeleteTemplate removes one template; a missing one is ErrNotFound.
	must(t, s.DeleteTemplate(ctx, tn, "t-a"))
	list, err = s.ListTemplates(ctx, tn)
	must(t, err)
	wantEq(t, "templates after delete", list, []store.Template{tpls[0]})
	wantErr(t, s.DeleteTemplate(ctx, tn, "t-a"), store.ErrNotFound)
	wantErr(t, s.DeleteTemplate(ctx, newTenant(t, s), "t-b"), store.ErrNotFound)
}

// --- isolation -------------------------------------------------------------

func tenantIsolation(t *testing.T, s store.Store) {
	ctx := context.Background()
	a, b := newTenant(t, s), newTenant(t, s)
	user := uid("user")
	p := month(2026, 2)

	// Populate every store area in tenant A.
	must(t, s.PutMembership(ctx, a, domain.Membership{UserID: user, Email: "u@example.test", Role: domain.RoleAdmin, CreatedAt: at(1)}))
	must(t, s.PutLevels(ctx, a, []domain.Level{{ID: "l", Name: "L", Depth: 0}}))
	must(t, s.PutOrgUnit(ctx, a, domain.OrgUnit{ID: "u1", Name: "U1", LevelID: "l"}))
	must(t, s.PutOrgMove(ctx, a, domain.OrgMove{UnitID: "u1", NewParentID: "u0", EffectiveMonth: p}))
	must(t, s.PutItemKind(ctx, a, domain.ItemKind{ID: "k", Name: "K"}))
	must(t, s.PutTrackedItem(ctx, a, domain.TrackedItem{ID: "i", KindID: "k", Name: "I"}))
	must(t, s.PutScorecard(ctx, a, domain.Scorecard{ID: "sc", Name: "SC"}))
	must(t, s.PutVersion(ctx, a, version("sc", "v1", "V1", p), 0))
	_, err := s.PutDataPoints(ctx, a, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 1), ExpectedRevision: 0}})
	must(t, err)
	must(t, s.PutOverride(ctx, a, "sc", domain.Override{MetricKey: "x", SubjectID: "u1", Period: p, Status: "G", Reason: "r", By: "u", At: at(1)}))
	must(t, s.AppendAudit(ctx, a, domain.AuditEntry{ID: "a1", ActorID: "u", Action: "x", At: at(2)}))
	must(t, s.PutImport(ctx, a, store.Import{ID: "imp", Status: "uploaded", CreatedAt: at(1)}))
	must(t, s.PutTemplate(ctx, a, store.Template{ID: "t", Name: "T"}))

	// Every read in tenant B sees nothing.
	_, err = s.GetMembership(ctx, b, user)
	wantErr(t, err, store.ErrNotFound)
	ms, err := s.ListMemberships(ctx, b)
	wantEmpty(t, "memberships", ms, err)
	ids, err := s.TenantsForUser(ctx, user)
	must(t, err)
	wantEq(t, "tenants for user", ids, []string{a})
	wantErr(t, s.DeleteMembership(ctx, b, user), store.ErrNotFound)

	ls, err := s.ListLevels(ctx, b)
	wantEmpty(t, "levels", ls, err)
	us, err := s.ListOrgUnits(ctx, b)
	wantEmpty(t, "units", us, err)
	mv, err := s.ListOrgMoves(ctx, b)
	wantEmpty(t, "moves", mv, err)
	ks, err := s.ListItemKinds(ctx, b)
	wantEmpty(t, "kinds", ks, err)
	is, err := s.ListTrackedItems(ctx, b)
	wantEmpty(t, "items", is, err)

	_, err = s.GetScorecard(ctx, b, "sc")
	wantErr(t, err, store.ErrNotFound)
	scs, err := s.ListScorecards(ctx, b)
	wantEmpty(t, "scorecards", scs, err)
	_, err = s.GetVersion(ctx, b, "sc", "v1")
	wantErr(t, err, store.ErrNotFound)
	vs, err := s.ListVersions(ctx, b, "sc")
	wantEmpty(t, "versions", vs, err)

	pts, ovs, err := s.ListData(ctx, b, "sc", []int{2026})
	wantEmpty(t, "points", pts, err)
	wantEmpty(t, "overrides", ovs, nil)
	hist, err := s.History(ctx, b, "sc", "m1", "u1", p)
	wantEmpty(t, "history", hist, err)
	wantErr(t, s.DeleteOverride(ctx, b, "sc", "x", "u1", p), store.ErrNotFound)

	au, err := s.ListAudit(ctx, b, at(1), at(30))
	wantEmpty(t, "audit", au, err)
	_, err = s.GetImport(ctx, b, "imp")
	wantErr(t, err, store.ErrNotFound)
	ts, err := s.ListTemplates(ctx, b)
	wantEmpty(t, "templates", ts, err)

	// Writes in B with the same keys neither conflict with nor alter A.
	must(t, s.PutScorecard(ctx, b, domain.Scorecard{ID: "sc", Name: "B's scorecard"}))
	must(t, s.PutVersion(ctx, b, version("sc", "v1", "B's V1", p), 0))
	_, err = s.PutDataPoints(ctx, b, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 777), ExpectedRevision: 0}})
	must(t, err)
	must(t, s.PutLevels(ctx, b, []domain.Level{{ID: "other", Name: "Other", Depth: 0}}))
	must(t, s.PutOrgUnit(ctx, b, domain.OrgUnit{ID: "u1", Name: "B's U1"}))
	must(t, s.PutImport(ctx, b, store.Import{ID: "imp", Status: "applied", CreatedAt: at(5)}))
	must(t, s.AppendAudit(ctx, b, domain.AuditEntry{ID: "a1", Action: "b-action", At: at(2)}))

	sc, err := s.GetScorecard(ctx, a, "sc")
	must(t, err)
	wantEq(t, "A scorecard", sc.Name, "SC")
	v, err := s.GetVersion(ctx, a, "sc", "v1")
	must(t, err)
	if v.Name != "V1" || v.Revision != 1 {
		t.Fatalf("A version = %q rev %d, want V1 rev 1", v.Name, v.Revision)
	}
	cur := current(t, s, a, "sc", 2026)
	if len(cur) != 1 || *cur[0].Value != 1 || cur[0].Revision != 1 {
		t.Fatalf("A data = %+v, want value 1 at revision 1", cur)
	}
	ls, err = s.ListLevels(ctx, a)
	must(t, err)
	wantEq(t, "A levels", ls, []domain.Level{{ID: "l", Name: "L", Depth: 0}})
	us, err = s.ListOrgUnits(ctx, a)
	must(t, err)
	if len(us) != 1 || us[0].Name != "U1" {
		t.Fatalf("A units = %+v", us)
	}
	im, err := s.GetImport(ctx, a, "imp")
	must(t, err)
	wantEq(t, "A import status", im.Status, "uploaded")
	au, err = s.ListAudit(ctx, a, at(1), at(30))
	must(t, err)
	if len(au) != 1 || au[0].Action != "x" {
		t.Fatalf("A audit = %+v", au)
	}

	// Data is also scoped by scorecard within a tenant.
	pts, _, err = s.ListData(ctx, a, "sc-other", []int{2026})
	wantEmpty(t, "points in other scorecard", pts, err)
}

// --- audit -----------------------------------------------------------------

func auditRange(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	entries := []domain.AuditEntry{
		{ID: "e3", ActorID: "u", Channel: "web", Action: "c", TargetType: "t", TargetID: "1", At: at(10)},
		{ID: "e1", ActorID: "u", Channel: "web", Action: "a", TargetType: "t", TargetID: "1", At: at(10)},
		{ID: "e2", ActorID: "u", Channel: "api", Action: "b", TargetType: "t", TargetID: "2", At: at(5), Before: json.RawMessage(`{"v":1}`), After: json.RawMessage(`{"v":2}`)},
		{ID: "e0", ActorID: "u", Channel: "web", Action: "z", TargetType: "t", TargetID: "3", At: at(1)},
		{ID: "e4", ActorID: "u", Channel: "web", Action: "d", TargetType: "t", TargetID: "4", At: at(20)},
	}
	for _, e := range entries {
		must(t, s.AppendAudit(ctx, tn, e))
	}

	got, err := s.ListAudit(ctx, tn, at(5), at(20)) // from inclusive, to exclusive
	must(t, err)
	wantEq(t, "audit [5,20)", got, []domain.AuditEntry{entries[2], entries[1], entries[0]})

	got, err = s.ListAudit(ctx, tn, at(1), at(21))
	must(t, err)
	if len(got) != 5 || got[0].ID != "e0" || got[4].ID != "e4" {
		t.Fatalf("audit [1,21) = %+v", got)
	}

	got, err = s.ListAudit(ctx, tn, at(11), at(19))
	wantEmpty(t, "audit [11,19)", got, err)
	got, err = s.ListAudit(ctx, tn, at(10), at(10))
	wantEmpty(t, "audit empty range", got, err)
}

// --- deletes, ordering, copies --------------------------------------------

func deleteMissing(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	wantErr(t, s.DeleteMembership(ctx, tn, uid("user")), store.ErrNotFound)
	wantErr(t, s.DeleteMembership(ctx, uid("tenant"), uid("user")), store.ErrNotFound)
	wantErr(t, s.DeleteOverride(ctx, tn, "sc", "x", "u1", month(2026, 1)), store.ErrNotFound)

	// An override on another period/subject does not satisfy the delete.
	must(t, s.PutOverride(ctx, tn, "sc", domain.Override{MetricKey: "x", SubjectID: "u1", Period: month(2026, 2), Status: "G", At: at(1)}))
	wantErr(t, s.DeleteOverride(ctx, tn, "sc", "x", "u1", month(2026, 1)), store.ErrNotFound)
	wantErr(t, s.DeleteOverride(ctx, tn, "sc", "x", "u2", month(2026, 2)), store.ErrNotFound)
	wantErr(t, s.DeleteOverride(ctx, tn, "sc-other", "x", "u1", month(2026, 2)), store.ErrNotFound)

	// Every Get on an empty tenant is ErrNotFound.
	_, err := s.GetMembership(ctx, tn, "nobody")
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetScorecard(ctx, tn, "nope")
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetVersion(ctx, tn, "sc", "nope")
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetImport(ctx, tn, "nope")
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetTenant(ctx, uid("tenant"))
	wantErr(t, err, store.ErrNotFound)
}

func listsAreSorted(t *testing.T, s store.Store) {
	ctx := context.Background()

	// Tenants: by Name then ID.
	base := uid("sorted")
	for _, tn := range []domain.Tenant{
		{ID: base + "-z", Name: base + " alpha"},
		{ID: base + "-a", Name: base + " beta"},
		{ID: base + "-y", Name: base + " alpha"},
	} {
		must(t, s.CreateTenant(ctx, tn))
	}
	all, err := s.ListTenants(ctx)
	must(t, err)
	var mine []string
	for i, tn := range all {
		if i > 0 {
			prev := all[i-1]
			if c := cmpStrings(prev.Name, tn.Name, prev.ID, tn.ID); c > 0 {
				t.Fatalf("ListTenants out of order: %q/%s before %q/%s", prev.Name, prev.ID, tn.Name, tn.ID)
			}
		}
		if strings.HasPrefix(tn.ID, base) {
			mine = append(mine, tn.ID)
		}
	}
	wantEq(t, "tenant order", mine, []string{base + "-y", base + "-z", base + "-a"})

	tn := newTenant(t, s)

	// Memberships by UserID; tenants for user sorted.
	for _, u := range []string{"u-c", "u-a", "pending:b@example.test", "u-b"} {
		must(t, s.PutMembership(ctx, tn, domain.Membership{UserID: u, Role: domain.RoleViewer, CreatedAt: at(1)}))
	}
	ms, err := s.ListMemberships(ctx, tn)
	must(t, err)
	var uids []string
	for _, m := range ms {
		uids = append(uids, m.UserID)
	}
	wantEq(t, "membership order", uids, []string{"pending:b@example.test", "u-a", "u-b", "u-c"})

	user := uid("user")
	var tenants []string
	for range 3 {
		id := newTenant(t, s)
		tenants = append(tenants, id)
		must(t, s.PutMembership(ctx, id, domain.Membership{UserID: user, Role: domain.RoleViewer}))
	}
	ids, err := s.TenantsForUser(ctx, user)
	must(t, err)
	wantEq(t, "tenants for user order", ids, sorted(tenants...))

	// Org model: levels by depth, others by ID, moves by unit then month.
	must(t, s.PutLevels(ctx, tn, []domain.Level{{ID: "c", Depth: 2}, {ID: "a", Depth: 0}, {ID: "b", Depth: 1}}))
	ls, err := s.ListLevels(ctx, tn)
	must(t, err)
	wantEq(t, "level depths", []int{ls[0].Depth, ls[1].Depth, ls[2].Depth}, []int{0, 1, 2})

	// Levels with equal depth are ordered by ID.
	must(t, s.PutLevels(ctx, tn, []domain.Level{{ID: "z", Depth: 1}, {ID: "m", Depth: 0}, {ID: "b", Depth: 1}, {ID: "a", Depth: 1}}))
	ls, err = s.ListLevels(ctx, tn)
	must(t, err)
	var lids []string
	for _, l := range ls {
		lids = append(lids, l.ID)
	}
	wantEq(t, "level order with ties", lids, []string{"m", "a", "b", "z"})

	for _, id := range []string{"u3", "u1", "u2"} {
		must(t, s.PutOrgUnit(ctx, tn, domain.OrgUnit{ID: id}))
		must(t, s.PutItemKind(ctx, tn, domain.ItemKind{ID: id}))
		must(t, s.PutTrackedItem(ctx, tn, domain.TrackedItem{ID: id}))
		must(t, s.PutScorecard(ctx, tn, domain.Scorecard{ID: id}))
		must(t, s.PutTemplate(ctx, tn, store.Template{ID: id}))
	}
	us, err := s.ListOrgUnits(ctx, tn)
	must(t, err)
	ks, err := s.ListItemKinds(ctx, tn)
	must(t, err)
	is, err := s.ListTrackedItems(ctx, tn)
	must(t, err)
	scs, err := s.ListScorecards(ctx, tn)
	must(t, err)
	tps, err := s.ListTemplates(ctx, tn)
	must(t, err)
	for what, got := range map[string][]string{
		"units":      {us[0].ID, us[1].ID, us[2].ID},
		"kinds":      {ks[0].ID, ks[1].ID, ks[2].ID},
		"items":      {is[0].ID, is[1].ID, is[2].ID},
		"scorecards": {scs[0].ID, scs[1].ID, scs[2].ID},
		"templates":  {tps[0].ID, tps[1].ID, tps[2].ID},
	} {
		wantEq(t, what+" order", got, []string{"u1", "u2", "u3"})
	}

	type mv struct {
		Unit string
		M    int
	}
	for _, m := range []mv{{"u2", 3}, {"u1", 12}, {"u1", 2}, {"u2", 1}} {
		must(t, s.PutOrgMove(ctx, tn, domain.OrgMove{UnitID: m.Unit, EffectiveMonth: month(2026, m.M)}))
	}
	moves, err := s.ListOrgMoves(ctx, tn)
	must(t, err)
	var gotMoves []mv
	for _, m := range moves {
		gotMoves = append(gotMoves, mv{m.UnitID, m.EffectiveMonth.Index})
	}
	wantEq(t, "move order", gotMoves, []mv{{"u1", 2}, {"u1", 12}, {"u2", 1}, {"u2", 3}})

	// Versions by EffectiveFrom then ID.
	for _, v := range []struct {
		id string
		p  period.Period
	}{{"v-c", month(2026, 5)}, {"v-b", month(2026, 5)}, {"v-a", month(2026, 9)}, {"v-d", month(2025, 12)}} {
		must(t, s.PutVersion(ctx, tn, version("sc-v", v.id, v.id, v.p), 0))
	}
	vs, err := s.ListVersions(ctx, tn, "sc-v")
	must(t, err)
	var vids []string
	for _, v := range vs {
		vids = append(vids, v.ID)
	}
	wantEq(t, "version order", vids, []string{"v-d", "v-b", "v-c", "v-a"})

	// Audit by At then ID.
	for _, e := range []domain.AuditEntry{{ID: "b", At: at(2)}, {ID: "a", At: at(2)}, {ID: "z", At: at(1)}} {
		must(t, s.AppendAudit(ctx, tn, e))
	}
	au, err := s.ListAudit(ctx, tn, at(1), at(3))
	must(t, err)
	var aids []string
	for _, e := range au {
		aids = append(aids, e.ID)
	}
	wantEq(t, "audit order", aids, []string{"z", "a", "b"})
}

func cmpStrings(a1, b1, a2, b2 string) int {
	if c := strings.Compare(a1, b1); c != 0 {
		return c
	}
	return strings.Compare(a2, b2)
}

// returnedValuesAreCopies checks that callers cannot reach into the store by
// mutating what they passed in or what they got back.
func returnedValuesAreCopies(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 9)

	// Mutating inputs after a write does not change stored data.
	val := 1.0
	pt := domain.DataPoint{MeasureKey: "m1", SubjectID: "u1", Period: p, Value: &val, Source: domain.SourceGrid, EnteredAt: at(1)}
	_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: pt, ExpectedRevision: 0}})
	must(t, err)
	val = 500

	unit := domain.OrgUnit{ID: "u1", SourceKeys: []string{"k1", "k2"}}
	must(t, s.PutOrgUnit(ctx, tn, unit))
	unit.SourceKeys[0] = "mutated"

	imp := store.Import{ID: "i1", ChangeSet: json.RawMessage(`{"a":1}`)}
	must(t, s.PutImport(ctx, tn, imp))
	imp.ChangeSet[2] = 'z'

	v := version("sc", "v1", "V", p)
	must(t, s.PutVersion(ctx, tn, v, 0))
	v.Content.Metrics[0].Targets[0].Value = -1
	v.Content.Metrics[0].Rule.Bands[0].Value = -1

	// Mutating outputs does not change stored data either.
	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || *cur[0].Value != 1 {
		t.Fatalf("stored value changed through an input pointer: %+v", cur)
	}
	*cur[0].Value = 600
	cur = current(t, s, tn, "sc", 2026)
	if *cur[0].Value != 1 {
		t.Fatalf("stored value changed through a returned pointer: %v", *cur[0].Value)
	}
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	*hist[0].Value = 700
	hist, err = s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	if *hist[0].Value != 1 {
		t.Fatalf("history changed through a returned pointer: %v", *hist[0].Value)
	}

	us, err := s.ListOrgUnits(ctx, tn)
	must(t, err)
	wantEq(t, "unit source keys", us[0].SourceKeys, []string{"k1", "k2"})
	us[0].SourceKeys[1] = "mutated"
	us, err = s.ListOrgUnits(ctx, tn)
	must(t, err)
	wantEq(t, "unit source keys after output mutation", us[0].SourceKeys, []string{"k1", "k2"})

	gi, err := s.GetImport(ctx, tn, "i1")
	must(t, err)
	wantEq(t, "change set", string(gi.ChangeSet), `{"a":1}`)
	gi.ChangeSet[2] = 'q'
	gi, err = s.GetImport(ctx, tn, "i1")
	must(t, err)
	wantEq(t, "change set after output mutation", string(gi.ChangeSet), `{"a":1}`)

	gv, err := s.GetVersion(ctx, tn, "sc", "v1")
	must(t, err)
	if gv.Content.Metrics[0].Targets[0].Value != 95 || gv.Content.Metrics[0].Rule.Bands[0].Value != 90 {
		t.Fatalf("version changed through input mutation: %+v", gv.Content.Metrics[0])
	}
	gv.Content.Metrics[0].Targets[0].Value = -2
	gv.Content.Measures[0].Key = "mutated"
	gv, err = s.GetVersion(ctx, tn, "sc", "v1")
	must(t, err)
	if gv.Content.Metrics[0].Targets[0].Value != 95 || gv.Content.Measures[0].Key != "m1" {
		t.Fatalf("version changed through output mutation: %+v", gv.Content)
	}
}

// --- concurrency -----------------------------------------------------------

const writers = 8

// race runs fn on writers goroutines at once and returns each call's error.
func race(fn func(i int) error) []error {
	errs := make([]error, writers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs[i] = fn(i)
		}()
	}
	close(start)
	wg.Wait()
	return errs
}

// oneWinner requires exactly one nil error and ErrConflict for all the rest,
// and returns the index of the winner.
func oneWinner(t *testing.T, what string, errs []error) int {
	t.Helper()
	winner := -1
	for i, err := range errs {
		switch {
		case err == nil:
			if winner >= 0 {
				t.Fatalf("%s: writers %d and %d both succeeded, want exactly one", what, winner, i)
			}
			winner = i
		case !errors.Is(err, store.ErrConflict):
			t.Fatalf("%s: writer %d error = %v, want nil or ErrConflict", what, i, err)
		}
	}
	if winner < 0 {
		t.Fatalf("%s: no writer succeeded, want exactly one", what)
	}
	return winner
}

// concurrentWritersOneWins checks that create-if-absent is atomic: writers
// racing to create the same data point, version, or tenant produce exactly
// one success and ErrConflict for the others, and the loser leaves no trace.
func concurrentWritersOneWins(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	// Data point at revision 1 / must-not-exist.
	p := month(2026, 10)
	errs := race(func(i int) error {
		_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, float64(i+1)), ExpectedRevision: store.MustNotExist}})
		return err
	})
	w := oneWinner(t, "data point", errs)
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	if len(hist) != 1 || hist[0].Revision != 1 || *hist[0].Value != float64(w+1) {
		t.Fatalf("history = %+v, want exactly the winner's value %d at revision 1", hist, w+1)
	}
	cur := current(t, s, tn, "sc", 2026)
	if len(cur) != 1 || cur[0].Revision != 1 || *cur[0].Value != float64(w+1) {
		t.Fatalf("current = %+v, want exactly the winner's value %d at revision 1", cur, w+1)
	}
	for i, err := range errs {
		if i == w {
			continue
		}
		var ce *store.ConflictError
		if !errors.As(err, &ce) || len(ce.Conflicts) != 1 {
			t.Fatalf("loser %d error = %v, want a *ConflictError with one conflict", i, err)
		}
	}

	// Methodology version create.
	errs = race(func(i int) error {
		return s.PutVersion(ctx, tn, version("sc", "v-race", fmt.Sprintf("writer-%d", i), month(2026, 1)), 0)
	})
	w = oneWinner(t, "version", errs)
	got, err := s.GetVersion(ctx, tn, "sc", "v-race")
	must(t, err)
	if got.Revision != 1 || got.Name != fmt.Sprintf("writer-%d", w) {
		t.Fatalf("version = rev %d %q, want rev 1 writer-%d", got.Revision, got.Name, w)
	}

	// Tenant create with a duplicate ID (distinct Auth0 orgs).
	id := uid("tenant")
	orgs := make([]string, writers)
	for i := range orgs {
		orgs[i] = uid("org")
	}
	errs = race(func(i int) error {
		return s.CreateTenant(ctx, domain.Tenant{ID: id, Name: fmt.Sprintf("writer-%d", i), Auth0OrgID: orgs[i], DefaultRole: domain.RoleViewer})
	})
	w = oneWinner(t, "tenant", errs)
	gt, err := s.GetTenant(ctx, id)
	must(t, err)
	if gt.Name != fmt.Sprintf("writer-%d", w) || gt.Auth0OrgID != orgs[w] {
		t.Fatalf("tenant = %q org %q, want the winner's (writer-%d)", gt.Name, gt.Auth0OrgID, w)
	}
	for i, org := range orgs {
		bt, err := s.TenantByAuth0Org(ctx, org)
		if i == w {
			must(t, err)
			wantEq(t, "winner's org lookup", bt.ID, id)
			continue
		}
		wantErr(t, err, store.ErrNotFound) // a losing create must not claim its org
	}
}

// --- templates, record types, records, snapshots ---------------------------

func templateRevisionIncrements(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn, other := newTenant(t, s), newTenant(t, s)
	used := at(20)

	list := func(tenant string) map[string]store.Template {
		t.Helper()
		ts, err := s.ListTemplates(ctx, tenant)
		must(t, err)
		out := map[string]store.Template{}
		for _, tp := range ts {
			out[tp.ID] = tp
		}
		return out
	}

	// The first save is revision 1, whatever the caller sends.
	must(t, s.PutTemplate(ctx, tn, store.Template{ID: "a", Name: "A", Revision: 99}))
	wantEq(t, "first save", list(tn)["a"].Revision, 1)

	must(t, s.PutTemplate(ctx, tn, store.Template{ID: "a", Name: "A2", Revision: 1}))
	must(t, s.PutTemplate(ctx, tn, store.Template{ID: "a", Name: "A3", LastUsed: &used}))
	got := list(tn)["a"]
	wantEq(t, "third save revision", got.Revision, 3)
	wantEq(t, "name", got.Name, "A3")
	if got.LastUsed == nil || !got.LastUsed.Equal(used) {
		t.Fatalf("LastUsed = %v, want %v", got.LastUsed, used)
	}

	// Revisions are per template and per tenant.
	must(t, s.PutTemplate(ctx, tn, store.Template{ID: "b", Name: "B"}))
	wantEq(t, "other template", list(tn)["b"].Revision, 1)
	must(t, s.PutTemplate(ctx, other, store.Template{ID: "a", Name: "Other A"}))
	wantEq(t, "other tenant", list(other)["a"].Revision, 1)
	wantEq(t, "tenant unchanged", list(tn)["a"].Revision, 3)

	// Delete then recreate starts over.
	must(t, s.DeleteTemplate(ctx, tn, "a"))
	must(t, s.PutTemplate(ctx, tn, store.Template{ID: "a", Name: "Again"}))
	wantEq(t, "recreated", list(tn)["a"].Revision, 1)
}

func templateLastUsedKeepsRevision(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	get := func() store.Template {
		t.Helper()
		ts, err := s.ListTemplates(ctx, tn)
		must(t, err)
		wantEq(t, "template count", len(ts), 1)
		return ts[0]
	}

	tpl := store.Template{ID: "a", Name: "A", Profile: "csv", Body: json.RawMessage(`{"cols":[1]}`)}
	must(t, s.PutTemplate(ctx, tn, tpl))
	wantEq(t, "first save", get().Revision, 1)

	// Touching only LastUsed keeps the revision and updates LastUsed.
	used := at(20)
	tpl.LastUsed = &used
	must(t, s.PutTemplate(ctx, tn, tpl))
	got := get()
	wantEq(t, "revision after touch", got.Revision, 1)
	if got.LastUsed == nil || !got.LastUsed.Equal(used) {
		t.Fatalf("LastUsed = %v, want %v", got.LastUsed, used)
	}
	used2 := at(21)
	tpl.LastUsed = &used2
	must(t, s.PutTemplate(ctx, tn, tpl))
	got = get()
	wantEq(t, "revision after second touch", got.Revision, 1)
	if !got.LastUsed.Equal(used2) {
		t.Fatalf("LastUsed = %v, want %v", got.LastUsed, used2)
	}

	// Re-saving the same Body with different whitespace is not a change.
	tpl.Body = json.RawMessage(`{ "cols": [ 1 ] }`)
	must(t, s.PutTemplate(ctx, tn, tpl))
	wantEq(t, "revision after whitespace-only body edit", get().Revision, 1)

	// Changing the body, name or profile increments, and LastUsed rides along.
	tpl.Body = json.RawMessage(`{"cols":[1,2]}`)
	must(t, s.PutTemplate(ctx, tn, tpl))
	wantEq(t, "revision after body change", get().Revision, 2)
	tpl.Name = "A renamed"
	must(t, s.PutTemplate(ctx, tn, tpl))
	wantEq(t, "revision after name change", get().Revision, 3)
	tpl.Profile = "workbook"
	must(t, s.PutTemplate(ctx, tn, tpl))
	got = get()
	wantEq(t, "revision after profile change", got.Revision, 4)
	if !got.LastUsed.Equal(used2) {
		t.Fatalf("LastUsed = %v, want %v", got.LastUsed, used2)
	}

	// Clearing LastUsed alone is also not a content change.
	tpl.LastUsed = nil
	must(t, s.PutTemplate(ctx, tn, tpl))
	got = get()
	wantEq(t, "revision after clearing LastUsed", got.Revision, 4)
	if got.LastUsed != nil {
		t.Fatalf("LastUsed = %v, want nil", got.LastUsed)
	}
}

func layoutRevision(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	must(t, s.PutScorecard(ctx, tn, domain.Scorecard{ID: "delivery", Name: "Delivery"}))

	userA, userB := "user-a", "user-b"
	items1 := []domain.LayoutItem{
		{ID: "metric:closure_rate", Size: "small", Hidden: false},
		{ID: "widget:health", Size: "wide", Hidden: false},
	}
	items2 := []domain.LayoutItem{{ID: "section:quality", Size: "wide", Hidden: true}}

	got, err := s.PutLayout(ctx, tn, userA, "delivery", items1, 0)
	must(t, err)
	if got.Revision != 1 {
		t.Fatalf("create revision = %d, want 1", got.Revision)
	}
	wantEq(t, "created items", got.Items, items1)

	_, err = s.PutLayout(ctx, tn, userA, "delivery", items1, 0)
	wantErr(t, err, store.ErrConflict)

	read, err := s.GetLayout(ctx, tn, userA, "delivery")
	must(t, err)
	wantEq(t, "get user layout", read, got)

	got, err = s.PutLayout(ctx, tn, userA, "delivery", items2, 1)
	must(t, err)
	wantEq(t, "updated items", got.Items, items2)
	if got.Revision != 2 {
		t.Fatalf("update revision = %d, want 2", got.Revision)
	}

	_, err = s.PutLayout(ctx, tn, userA, "delivery", items2, 1)
	wantErr(t, err, store.ErrConflict)

	defItems := []domain.LayoutItem{{ID: "widget:ribbon", Size: "wide", Hidden: false}}
	def, err := s.PutDefaultLayout(ctx, tn, "delivery", defItems, 0)
	must(t, err)
	if def.Revision != 1 {
		t.Fatalf("default revision = %d, want 1", def.Revision)
	}
	wantEq(t, "default items", def.Items, defItems)

	read, err = s.GetLayout(ctx, tn, userA, "delivery")
	must(t, err)
	wantEq(t, "user layout after default", read, got)

	defGot, err := s.GetDefaultLayout(ctx, tn, "delivery")
	must(t, err)
	wantEq(t, "default unchanged by user", defGot, def)

	_, err = s.GetLayout(ctx, tn, userB, "delivery")
	wantErr(t, err, store.ErrNotFound)

	userBLayout, err := s.PutLayout(ctx, tn, userB, "delivery", items1, 0)
	must(t, err)
	defGot, err = s.GetDefaultLayout(ctx, tn, "delivery")
	must(t, err)
	wantEq(t, "default after other user layout", defGot, def)

	_, err = s.PutDefaultLayout(ctx, tn, "delivery", defItems, 0)
	wantErr(t, err, store.ErrConflict)
	_, err = s.PutDefaultLayout(ctx, tn, "delivery", defItems, 1)
	must(t, err)
	wantEq(t, "user B unchanged", userBLayout.Revision, 1)

	other := newTenant(t, s)
	must(t, s.PutScorecard(ctx, other, domain.Scorecard{ID: "delivery", Name: "Theirs"}))
	_, err = s.GetLayout(ctx, other, userA, "delivery")
	wantErr(t, err, store.ErrNotFound)
	_, err = s.GetDefaultLayout(ctx, other, "delivery")
	wantErr(t, err, store.ErrNotFound)
}

func recordType(id, name string) domain.RecordType {
	return domain.RecordType{
		ID: id, Name: name,
		Priorities: []string{"high", "low"},
		Attributes: []domain.AttributeDef{{Key: "customerTicket", Name: "Customer ticket", Type: domain.AttrString}},
		TrackedFrom: map[string]period.Period{
			"tracker-a": month(2026, 4),
		},
	}
}

func recordTypeRevision(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	rt := recordType("defect", "Defect")
	rt.Revision = 42 // ignored
	must(t, s.PutRecordType(ctx, tn, rt, 0))
	wantErr(t, s.PutRecordType(ctx, tn, rt, 0), store.ErrConflict) // exists

	got, err := s.ListRecordTypes(ctx, tn)
	must(t, err)
	want := recordType("defect", "Defect")
	want.Revision = 1
	wantEq(t, "created", got, []domain.RecordType{want})

	rt.Name = "Defect v2"
	rt.TrackedFrom = map[string]period.Period{"tracker-a": month(2026, 4), "tracker-b": month(2026, 7)}
	must(t, s.PutRecordType(ctx, tn, rt, 1))
	got, err = s.ListRecordTypes(ctx, tn)
	must(t, err)
	want.Name, want.TrackedFrom, want.Revision = rt.Name, rt.TrackedFrom, 2
	wantEq(t, "updated", got, []domain.RecordType{want})

	wantErr(t, s.PutRecordType(ctx, tn, rt, 1), store.ErrConflict)                         // stale
	wantErr(t, s.PutRecordType(ctx, tn, rt, 5), store.ErrConflict)                         // too new
	wantErr(t, s.PutRecordType(ctx, tn, rt, -1), store.ErrConflict)                        // unconditional is not allowed
	wantErr(t, s.PutRecordType(ctx, tn, recordType("epic", "Epic"), 3), store.ErrConflict) // missing
	got, err = s.ListRecordTypes(ctx, tn)
	must(t, err)
	wantEq(t, "unchanged by conflicts", got, []domain.RecordType{want})

	// Listed by ID; another tenant sees none and can use the same ID.
	must(t, s.PutRecordType(ctx, tn, recordType("bug", "Bug"), 0))
	got, err = s.ListRecordTypes(ctx, tn)
	must(t, err)
	wantEq(t, "ids", []string{got[0].ID, got[1].ID}, []string{"bug", "defect"})

	other := newTenant(t, s)
	got, err = s.ListRecordTypes(ctx, other)
	wantEmpty(t, "other tenant types", got, err)
	must(t, s.PutRecordType(ctx, other, recordType("defect", "Theirs"), 0))
	got, err = s.ListRecordTypes(ctx, tn)
	must(t, err)
	wantEq(t, "own tenant unchanged", got[1].Name, "Defect v2")
}

func date(t *testing.T, s string) domain.Date {
	t.Helper()
	d, err := domain.ParseDate(s)
	must(t, err)
	return d
}

func fields(t *testing.T, subject, title, createdAt string) domain.RecordFields {
	t.Helper()
	due := date(t, "2026-11-15")
	planned := 3.5
	return domain.RecordFields{
		SubjectKey: subject, Title: title, Priority: "high", Status: "In progress",
		State:         domain.StateOpen,
		CreatedAt:     date(t, createdAt),
		DueAt:         &due,
		PriorDueDates: []domain.Date{date(t, "2026-11-01")},
		Planned:       &planned,
		Attributes:    map[string]any{"customerTicket": "PAY-7", "escalated": true, "points": 5.0},
	}
}

func revWrite(t *testing.T, typ, source, ext, snap, asOf, title string) store.RecordRevisionWrite {
	t.Helper()
	return store.RecordRevisionWrite{
		Source: source, ExternalID: ext, Type: typ,
		Rev: domain.RecordRevision{AsOf: date(t, asOf), SnapshotID: snap, Fields: fields(t, "checkout", title, "2026-10-01")},
	}
}

func snapshot(t *testing.T, id, typ, source, asOf string, created int) domain.Snapshot {
	t.Helper()
	return domain.Snapshot{
		ID: id, RecordType: typ, Source: source, TemplateID: "tpl-1", TemplateRevision: 2,
		AsOf: date(t, asOf), FileName: id + ".csv", CreatedBy: "user-1", CreatedAt: at(created),
		Counts: map[string]int{"added": 2, "updated": 1},
	}
}

func applySnapshotGroupsRevisions(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	s1 := snapshot(t, "snap-1", "defect", "tracker-a", "2026-10-05", 5)
	r1 := []store.RecordRevisionWrite{
		revWrite(t, "defect", "tracker-b", "CHK-2", "snap-1", "2026-10-05", "b2 first"),
		revWrite(t, "defect", "tracker-a", "CHK-10", "snap-1", "2026-10-05", "a10 first"),
		revWrite(t, "defect", "tracker-a", "CHK-9", "snap-1", "2026-10-05", "a9 first"),
		revWrite(t, "epic", "tracker-a", "CHK-1", "snap-1", "2026-10-05", "an epic"),
	}
	must(t, s.ApplySnapshot(ctx, tn, s1, r1))

	s2 := snapshot(t, "snap-2", "defect", "tracker-a", "2026-10-12", 12)
	r2 := []store.RecordRevisionWrite{
		revWrite(t, "defect", "tracker-a", "CHK-9", "snap-2", "2026-10-12", "a9 second"),
	}
	must(t, s.ApplySnapshot(ctx, tn, s2, r2))

	// Applying a revision for an existing (record, asOf) replaces it.
	s3 := snapshot(t, "snap-3", "defect", "tracker-a", "2026-10-12", 13)
	r3 := []store.RecordRevisionWrite{
		revWrite(t, "defect", "tracker-a", "CHK-9", "snap-3", "2026-10-12", "a9 second, corrected"),
	}
	must(t, s.ApplySnapshot(ctx, tn, s3, r3))

	got, err := s.ListRecords(ctx, tn, "defect")
	must(t, err)
	// Sorted by Source then ExternalID (CHK-10 < CHK-9 as strings); revisions by AsOf.
	want := []domain.Record{
		{Source: "tracker-a", ExternalID: "CHK-10", Type: "defect", Revisions: []domain.RecordRevision{r1[1].Rev}},
		{Source: "tracker-a", ExternalID: "CHK-9", Type: "defect", Revisions: []domain.RecordRevision{r1[2].Rev, r3[0].Rev}},
		{Source: "tracker-b", ExternalID: "CHK-2", Type: "defect", Revisions: []domain.RecordRevision{r1[0].Rev}},
	}
	wantEq(t, "defect records", got, want)

	epics, err := s.ListRecords(ctx, tn, "epic")
	must(t, err)
	wantEq(t, "epic records", epics, []domain.Record{
		{Source: "tracker-a", ExternalID: "CHK-1", Type: "epic", Revisions: []domain.RecordRevision{r1[3].Rev}},
	})

	none, err := s.ListRecords(ctx, tn, "story")
	wantEmpty(t, "unknown type", none, err)

	snaps, err := s.ListSnapshots(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "snapshots", snaps, []domain.Snapshot{s3, s2, s1})

	// Returned values are copies: mutating them never reaches the store.
	got[0].Revisions[0].Fields.Title = "mutated"
	*got[0].Revisions[0].Fields.DueAt = date(t, "2030-01-01")
	got[0].Revisions[0].Fields.Attributes["customerTicket"] = "mutated"
	got[0].Revisions[0].Fields.PriorDueDates[0] = date(t, "2030-01-01")
	snaps[0].Counts["added"] = 99
	again, err := s.ListRecords(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "records after caller mutation", again, want)
	snapsAgain, err := s.ListSnapshots(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "snapshots after caller mutation", snapsAgain, []domain.Snapshot{s3, s2, s1})
}

func applySnapshotLargeBatch(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	const n = 130 // more than any single DynamoDB batch or transaction holds
	snap := snapshot(t, "snap-big", "defect", "tracker-a", "2026-10-05", 5)
	revs := make([]store.RecordRevisionWrite, 0, n+1)
	for i := range n {
		revs = append(revs, revWrite(t, "defect", "tracker-a", fmt.Sprintf("CHK-%03d", i), "snap-big", "2026-10-05", "t"))
	}
	// A repeated key inside one batch must not break the write; the last wins.
	dup := revWrite(t, "defect", "tracker-a", "CHK-000", "snap-big", "2026-10-05", "last wins")
	revs = append(revs, dup)
	must(t, s.ApplySnapshot(ctx, tn, snap, revs))

	got, err := s.ListRecords(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "record count", len(got), n)
	wantEq(t, "first record", got[0].Revisions, []domain.RecordRevision{dup.Rev})
	for i, r := range got {
		wantEq(t, "id order", r.ExternalID, fmt.Sprintf("CHK-%03d", i))
		wantEq(t, "revisions per record", len(r.Revisions), 1)
	}
}

func applySnapshotDuplicateIDConflict(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	s1 := snapshot(t, "snap-1", "defect", "tracker-a", "2026-10-05", 5)
	first := []store.RecordRevisionWrite{revWrite(t, "defect", "tracker-a", "CHK-1", "snap-1", "2026-10-05", "first")}
	must(t, s.ApplySnapshot(ctx, tn, s1, first))

	// Same ID again: conflict, and none of its revisions are stored.
	dup := snapshot(t, "snap-1", "defect", "tracker-a", "2026-10-19", 19)
	second := []store.RecordRevisionWrite{
		revWrite(t, "defect", "tracker-a", "CHK-1", "snap-1", "2026-10-19", "second"),
		revWrite(t, "defect", "tracker-a", "CHK-2", "snap-1", "2026-10-19", "new record"),
	}
	wantErr(t, s.ApplySnapshot(ctx, tn, dup, second), store.ErrConflict)

	recs, err := s.ListRecords(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "records unchanged", recs, []domain.Record{
		{Source: "tracker-a", ExternalID: "CHK-1", Type: "defect", Revisions: []domain.RecordRevision{first[0].Rev}},
	})
	snaps, err := s.ListSnapshots(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "snapshots unchanged", snaps, []domain.Snapshot{s1})

	// The same ID in another record type or tenant is a different snapshot.
	must(t, s.ApplySnapshot(ctx, tn, snapshot(t, "snap-1", "epic", "tracker-a", "2026-10-05", 5), nil))
	must(t, s.ApplySnapshot(ctx, newTenant(t, s), s1, first))

	// A new ID for the same upload applies cleanly (the retry path).
	retry := snapshot(t, "snap-1b", "defect", "tracker-a", "2026-10-19", 20)
	must(t, s.ApplySnapshot(ctx, tn, retry, second))
	recs, err = s.ListRecords(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "record count after retry", len(recs), 2)
	wantEq(t, "revisions after retry", len(recs[0].Revisions), 2)
}

func snapshotsNewestFirst(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	in := []domain.Snapshot{
		snapshot(t, "mid", "defect", "tracker-a", "2026-10-12", 12),
		snapshot(t, "old", "defect", "tracker-a", "2026-10-05", 30),
		snapshot(t, "new", "defect", "tracker-b", "2026-10-19", 1),
		snapshot(t, "tie-later", "defect", "tracker-b", "2026-10-12", 14),
		snapshot(t, "other-type", "epic", "tracker-a", "2026-10-30", 3),
	}
	for _, sn := range in {
		must(t, s.ApplySnapshot(ctx, tn, sn, nil))
	}
	got, err := s.ListSnapshots(ctx, tn, "defect")
	must(t, err)
	var ids []string
	for _, sn := range got {
		ids = append(ids, sn.ID)
	}
	wantEq(t, "newest first", ids, []string{"new", "tie-later", "mid", "old"})
	wantEq(t, "full snapshot", got[2], in[0])

	none, err := s.ListSnapshots(ctx, tn, "story")
	wantEmpty(t, "unknown type", none, err)
}

func recordsCrossTenant(t *testing.T, s store.Store) {
	ctx := context.Background()
	a, b := newTenant(t, s), newTenant(t, s)

	must(t, s.PutRecordType(ctx, a, recordType("defect", "Defect"), 0))
	snap := snapshot(t, "snap-1", "defect", "tracker-a", "2026-10-05", 5)
	revs := []store.RecordRevisionWrite{revWrite(t, "defect", "tracker-a", "CHK-1", "snap-1", "2026-10-05", "mine")}
	must(t, s.ApplySnapshot(ctx, a, snap, revs))

	rts, err := s.ListRecordTypes(ctx, b)
	wantEmpty(t, "types", rts, err)
	recs, err := s.ListRecords(ctx, b, "defect")
	wantEmpty(t, "records", recs, err)
	snaps, err := s.ListSnapshots(ctx, b, "defect")
	wantEmpty(t, "snapshots", snaps, err)

	// The same keys in B neither conflict with nor alter A.
	theirs := []store.RecordRevisionWrite{revWrite(t, "defect", "tracker-a", "CHK-1", "snap-1", "2026-10-05", "theirs")}
	must(t, s.ApplySnapshot(ctx, b, snap, theirs))
	recs, err = s.ListRecords(ctx, a, "defect")
	must(t, err)
	wantEq(t, "A's records", recs, []domain.Record{
		{Source: "tracker-a", ExternalID: "CHK-1", Type: "defect", Revisions: []domain.RecordRevision{revs[0].Rev}},
	})
	recs, err = s.ListRecords(ctx, b, "defect")
	must(t, err)
	wantEq(t, "B's records", recs, []domain.Record{
		{Source: "tracker-a", ExternalID: "CHK-1", Type: "defect", Revisions: []domain.RecordRevision{theirs[0].Rev}},
	})
}

func externalIDWithHash(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)

	// IDs and sources containing '#', '/', '%' and spaces must stay distinct
	// records and round-trip unchanged.
	type key struct{ source, ext string }
	keys := []key{
		{"tracker-a", "CHK#1"},
		{"tracker-a", "CHK"},
		{"tracker-a", "CHK#1#2"},
		{"tracker-a#CHK", "1"},
		{"tracker-a", "CHK%231"},
		{"tracker a", "path/with slash"},
		{"tracker-a", "CHK#1" + "#"},
	}
	snap := snapshot(t, "snap-1", "defect", "tracker-a", "2026-10-05", 5)
	var revs []store.RecordRevisionWrite
	for _, k := range keys {
		revs = append(revs, revWrite(t, "defect", k.source, k.ext, "snap-1", "2026-10-05", k.source+"|"+k.ext))
	}
	must(t, s.ApplySnapshot(ctx, tn, snap, revs))

	got, err := s.ListRecords(ctx, tn, "defect")
	must(t, err)
	wantEq(t, "record count", len(got), len(keys))
	byKey := map[key]domain.Record{}
	for _, r := range got {
		byKey[key{r.Source, r.ExternalID}] = r
	}
	for _, k := range keys {
		r, ok := byKey[k]
		if !ok {
			t.Fatalf("record %q/%q missing from %d records", k.source, k.ext, len(got))
		}
		wantEq(t, "title for "+k.source+"|"+k.ext, r.Revisions[0].Fields.Title, k.source+"|"+k.ext)
	}
}

func deleteDataPoint(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 3)
	keep := point("m2", "u1", p, 20)

	saved, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{
		{Point: point("m1", "u1", p, 10), ExpectedRevision: store.MustNotExist},
		{Point: keep, ExpectedRevision: store.MustNotExist},
	})
	must(t, err)
	wantEq(t, "initial revision", saved[0].Revision, 1)

	del := point("m1", "u1", p, 0)
	del.EnteredBy, del.EnteredAt = "deleter", at(9)
	out, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: del, ExpectedRevision: 1, Delete: true}})
	must(t, err)
	wantEq(t, "one result", len(out), 1)
	if !out[0].Deleted || out[0].Revision != 2 {
		t.Fatalf("delete result = %+v, want a tombstone at revision 2", out[0])
	}

	// Gone from ListData; the other point is untouched.
	cur := current(t, s, tn, "sc", 2026)
	wantEq(t, "current points", len(cur), 1)
	wantEq(t, "remaining point", cur[0].MeasureKey, "m2")
	wantEq(t, "remaining value", *cur[0].Value, 20.0)

	// History keeps the original and ends with a tombstone.
	hist, err := s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	wantEq(t, "history length", len(hist), 2)
	tomb := hist[0]
	if !tomb.Deleted || tomb.Revision != 2 || tomb.Source != domain.SourceRecords || tomb.Value != nil {
		t.Fatalf("tombstone = %+v", tomb)
	}
	wantEq(t, "tombstone actor", tomb.EnteredBy, "deleter")
	wantEq(t, "tombstone identity", [3]any{tomb.MeasureKey, tomb.SubjectID, tomb.Period}, [3]any{"m1", "u1", p})
	if hist[1].Deleted || hist[1].Revision != 1 || *hist[1].Value != 10 {
		t.Fatalf("original revision = %+v", hist[1])
	}

	// Deleting a missing point is a no-op: no error, no new history.
	for _, exp := range []int{store.Unconditional, store.MustNotExist} {
		out, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: del, ExpectedRevision: exp, Delete: true}})
		must(t, err)
		wantEq(t, "no-op result count", len(out), 1)
		wantEq(t, "no-op result revision", out[0].Revision, 0)
	}
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("never", "u1", p, 0), ExpectedRevision: store.Unconditional, Delete: true}})
	must(t, err)
	hist, err = s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	wantEq(t, "history after no-op deletes", len(hist), 2)
	hist, err = s.History(ctx, tn, "sc", "never", "u1", p)
	wantEmpty(t, "history of never-written point", hist, err)

	// A later write behaves as new and continues the numbering past the
	// tombstone, so history is never overwritten.
	stale := point("m1", "u1", p, 77)
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: stale, ExpectedRevision: 1}})
	wantErr(t, err, store.ErrConflict) // the pre-delete revision is gone
	var ce *store.ConflictError
	if !errors.As(err, &ce) || len(ce.Conflicts) != 1 || ce.Conflicts[0].Current != nil {
		t.Fatalf("conflict = %+v, want Current nil for a deleted point", ce)
	}
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: stale, ExpectedRevision: 2}})
	wantErr(t, err, store.ErrConflict) // the tombstone is not a live revision

	out, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: stale, ExpectedRevision: store.MustNotExist}})
	must(t, err)
	wantEq(t, "recreated revision", out[0].Revision, 3)
	if out[0].Deleted {
		t.Fatal("a live write must not be a tombstone")
	}
	cur = current(t, s, tn, "sc", 2026)
	wantEq(t, "current after recreate", len(cur), 2)
	hist, err = s.History(ctx, tn, "sc", "m1", "u1", p)
	must(t, err)
	wantEq(t, "history after recreate", len(hist), 3)
	wantEq(t, "history tombstone kept", hist[1].Deleted, true)
	wantEq(t, "history newest value", *hist[0].Value, 77.0)
}

func deleteDataPointRevisionChecks(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	p := month(2026, 3)

	_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{
		{Point: point("m1", "u1", p, 1), ExpectedRevision: store.MustNotExist},
		{Point: point("m2", "u1", p, 2), ExpectedRevision: store.MustNotExist},
	})
	must(t, err)
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 11), ExpectedRevision: 1}})
	must(t, err) // m1 is now revision 2

	// A stale revision conflicts like a write and carries the current point.
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 0), ExpectedRevision: 1, Delete: true}})
	wantErr(t, err, store.ErrConflict)
	var ce *store.ConflictError
	if !errors.As(err, &ce) || len(ce.Conflicts) != 1 {
		t.Fatalf("error = %v, want one conflict", err)
	}
	if c := ce.Conflicts[0]; !c.Write.Delete || c.Current == nil || c.Current.Revision != 2 {
		t.Fatalf("conflict = %+v", c)
	}
	// MustNotExist against an existing point conflicts too; a positive
	// revision against a missing point conflicts.
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 0), ExpectedRevision: store.MustNotExist, Delete: true}})
	wantErr(t, err, store.ErrConflict)
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("missing", "u1", p, 0), ExpectedRevision: 1, Delete: true}})
	wantErr(t, err, store.ErrConflict)
	wantEq(t, "nothing deleted by conflicts", len(current(t, s, tn, "sc", 2026)), 2)

	// A conflict anywhere in the batch deletes nothing.
	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{
		{Point: point("m2", "u1", p, 0), ExpectedRevision: 1, Delete: true},
		{Point: point("m1", "u1", p, 5), ExpectedRevision: 1},
	})
	wantErr(t, err, store.ErrConflict)
	wantEq(t, "batch rolled back", len(current(t, s, tn, "sc", 2026)), 2)
	hist, err := s.History(ctx, tn, "sc", "m2", "u1", p)
	must(t, err)
	wantEq(t, "m2 history untouched", len(hist), 1)

	// Writes in a batch see earlier deletes: delete then re-create at the
	// next revision, then Unconditional delete of the result.
	out, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{
		{Point: point("m2", "u1", p, 0), ExpectedRevision: 1, Delete: true},
		{Point: point("m2", "u1", p, 3), ExpectedRevision: store.MustNotExist},
	})
	must(t, err)
	wantEq(t, "batch revisions", []int{out[0].Revision, out[1].Revision}, []int{2, 3})
	cur := current(t, s, tn, "sc", 2026)
	wantEq(t, "m2 live again", len(cur), 2)

	_, err = s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m2", "u1", p, 0), ExpectedRevision: store.Unconditional, Delete: true}})
	must(t, err)
	cur = current(t, s, tn, "sc", 2026)
	wantEq(t, "unconditional delete", len(cur), 1)
	wantEq(t, "survivor", cur[0].MeasureKey, "m1")
	hist, err = s.History(ctx, tn, "sc", "m2", "u1", p)
	must(t, err)
	wantEq(t, "m2 history", []int{hist[0].Revision, hist[1].Revision, hist[2].Revision, hist[3].Revision}, []int{4, 3, 2, 1})
	wantEq(t, "m2 tombstones", []bool{hist[0].Deleted, hist[1].Deleted, hist[2].Deleted, hist[3].Deleted}, []bool{true, false, true, false})
}

func deleteDataPointCrossTenant(t *testing.T, s store.Store) {
	ctx := context.Background()
	a, b := newTenant(t, s), newTenant(t, s)
	p := month(2026, 3)
	for _, tn := range []string{a, b} {
		_, err := s.PutDataPoints(ctx, tn, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 1), ExpectedRevision: store.MustNotExist}})
		must(t, err)
	}
	_, err := s.PutDataPoints(ctx, a, "sc", []store.DataWrite{{Point: point("m1", "u1", p, 0), ExpectedRevision: 1, Delete: true}})
	must(t, err)
	wantEq(t, "A's points", len(current(t, s, a, "sc", 2026)), 0)
	cur := current(t, s, b, "sc", 2026)
	wantEq(t, "B's points", len(cur), 1)
	wantEq(t, "B's revision", cur[0].Revision, 1)
	hist, err := s.History(ctx, b, "sc", "m1", "u1", p)
	must(t, err)
	wantEq(t, "B's history", len(hist), 1)
}

func reportSummaryRevision(t *testing.T, s store.Store) {
	ctx := context.Background()
	tn := newTenant(t, s)
	must(t, s.PutScorecard(ctx, tn, domain.Scorecard{ID: "delivery", Name: "Delivery"}))
	per := "2026-M10"
	at := at(10)

	got, err := s.PutReportSummary(ctx, tn, "delivery", per, "first", "user-a", 0, at)
	must(t, err)
	if got.Revision != 1 || got.Text != "first" {
		t.Fatalf("create = %+v", got)
	}

	read, err := s.GetReportSummary(ctx, tn, "delivery", per)
	must(t, err)
	wantEq(t, "round trip", read, got)

	_, err = s.PutReportSummary(ctx, tn, "delivery", per, "first", "user-a", 0, at)
	wantErr(t, err, store.ErrConflict)

	got, err = s.PutReportSummary(ctx, tn, "delivery", per, "second", "user-b", 1, at.Add(time.Hour))
	must(t, err)
	if got.Revision != 2 {
		t.Fatalf("update revision = %d", got.Revision)
	}

	rev := domain.ReportRevision{
		Period: per, Revision: 1, PublishedBy: "user-a", PublishedAt: at, ObjectKey: "obj-1",
	}
	must(t, s.PutReportRevision(ctx, tn, "delivery", rev))
	err = s.PutReportRevision(ctx, tn, "delivery", rev)
	wantErr(t, err, store.ErrConflict)

	list, err := s.ListReportRevisions(ctx, tn, "delivery")
	must(t, err)
	wantEq(t, "list", list, []domain.ReportRevision{rev})

	other := newTenant(t, s)
	must(t, s.PutScorecard(ctx, other, domain.Scorecard{ID: "delivery", Name: "Theirs"}))
	_, err = s.GetReportSummary(ctx, other, "delivery", per)
	wantErr(t, err, store.ErrNotFound)
}
