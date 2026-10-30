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
	if d := cmp.Diff(want, got, cmpopts.EquateEmpty()); d != "" {
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
	wantEq(t, "templates", list, []store.Template{tpls[1], tpls[0]})
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
