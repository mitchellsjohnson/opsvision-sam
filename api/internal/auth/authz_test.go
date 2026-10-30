package auth_test

import (
	"testing"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

func month(fy, idx int) period.Period { return period.Period{Grain: period.Month, FY: fy, Index: idx} }

// testTree: Company > {Payments > {Checkout, Billing}, Platform}, Analytics
// (Analytics starts under Platform and moves under Payments in 2026-M07).
func testTree(t *testing.T) *orgtree.Tree {
	t.Helper()
	units := []domain.OrgUnit{
		{ID: "Company", Name: "Company"},
		{ID: "Payments", Name: "Payments", ParentID: "Company"},
		{ID: "Platform", Name: "Platform", ParentID: "Company"},
		{ID: "Checkout", Name: "Checkout", ParentID: "Payments"},
		{ID: "Billing", Name: "Billing", ParentID: "Payments"},
		{ID: "Analytics", Name: "Analytics", ParentID: "Platform"},
	}
	moves := []domain.OrgMove{{UnitID: "Analytics", NewParentID: "Payments", EffectiveMonth: month(2026, 7)}}
	tree, err := orgtree.New(units, moves)
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

func principal(role domain.Role, scope domain.Scope) auth.Principal {
	return auth.Principal{
		UserID:     "u1",
		Tenant:     &domain.Tenant{ID: "t1"},
		Membership: &domain.Membership{UserID: "u1", Role: role, Scope: scope},
	}
}

var allActions = []auth.Action{
	auth.ActionTenantAdmin, auth.ActionMethodologyWrite, auth.ActionDataWrite,
	auth.ActionDataRead, auth.ActionOverrideWrite,
}

func TestActionValues(t *testing.T) {
	want := map[auth.Action]string{
		auth.ActionTenantAdmin:      "tenant:admin",
		auth.ActionMethodologyWrite: "methodology:write",
		auth.ActionDataWrite:        "data:write",
		auth.ActionDataRead:         "data:read",
		auth.ActionOverrideWrite:    "override:write",
	}
	for a, s := range want {
		if string(a) != s {
			t.Errorf("%v = %q, want %q", a, string(a), s)
		}
	}
}

func TestAdminCanDoEverything(t *testing.T) {
	tree := testTree(t)
	// Even a (meaningless) scope on an admin never restricts.
	p := principal(domain.RoleAdmin, domain.Scope{OrgUnitIDs: []string{"Platform"}, MetricKeys: []string{"x"}})
	for _, a := range allActions {
		if !auth.Can(p, a, auth.Resource{OrgUnitID: "Checkout", MetricKey: "y"}, tree, month(2026, 6)) {
			t.Errorf("admin denied %s", a)
		}
	}
	if auth.Can(p, auth.Action("bogus:thing"), auth.Resource{}, tree, month(2026, 6)) {
		t.Error("admin allowed an unknown action")
	}
}

func TestContributorScope(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Payments"}})
	w := func(unit string, m period.Period) bool {
		return auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: unit}, tree, m)
	}
	if !w("Checkout", month(2026, 6)) {
		t.Error("cannot write Checkout (under Payments)")
	}
	if !w("Payments", month(2026, 6)) {
		t.Error("cannot write Payments itself")
	}
	if w("Analytics", month(2026, 6)) {
		t.Error("can write Analytics in 2026-M06 (still under Platform)")
	}
	if !w("Analytics", month(2026, 7)) {
		t.Error("cannot write Analytics in 2026-M07 (moved under Payments)")
	}
	if w("Platform", month(2026, 7)) || w("Company", month(2026, 7)) {
		t.Error("wrote outside the scoped subtree")
	}
	if w("Unknown", month(2026, 7)) || w("", month(2026, 7)) {
		t.Error("wrote to an unknown/empty unit with a scoped membership")
	}
}

func TestContributorReadsEverywhere(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Payments"}, MetricKeys: []string{"uptime"}})
	for _, unit := range []string{"Payments", "Platform", "Company", "Analytics", "Unknown"} {
		if !auth.Can(p, auth.ActionDataRead, auth.Resource{OrgUnitID: unit, MetricKey: "other"}, tree, month(2026, 6)) {
			t.Errorf("contributor cannot read %s", unit)
		}
	}
}

func TestContributorHasNothingElse(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{})
	for _, a := range []auth.Action{auth.ActionTenantAdmin, auth.ActionMethodologyWrite, auth.ActionOverrideWrite} {
		if auth.Can(p, a, auth.Resource{OrgUnitID: "Checkout"}, tree, month(2026, 6)) {
			t.Errorf("contributor allowed %s", a)
		}
	}
	if !auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Anything"}, tree, month(2026, 6)) {
		t.Error("empty-scope contributor should write anywhere")
	}
}

func TestContributorMetricScope(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{MetricKeys: []string{"uptime", "latency"}})
	can := func(metric string) bool {
		return auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout", MetricKey: metric}, tree, month(2026, 6))
	}
	if !can("uptime") || !can("latency") {
		t.Error("listed metric denied")
	}
	if can("revenue") {
		t.Error("unlisted metric allowed")
	}
	if !can("") {
		t.Error("resource without a metric key should pass the metric scope")
	}
}

func TestUnitAndMetricBothRequired(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Payments"}, MetricKeys: []string{"uptime"}})
	cases := []struct {
		unit, metric string
		want         bool
	}{
		{"Checkout", "uptime", true},
		{"Checkout", "revenue", false},
		{"Platform", "uptime", false},
		{"Platform", "revenue", false},
	}
	for _, c := range cases {
		got := auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: c.unit, MetricKey: c.metric}, tree, month(2026, 6))
		if got != c.want {
			t.Errorf("write %s/%s = %v, want %v", c.unit, c.metric, got, c.want)
		}
	}
}

func TestViewerCannotWrite(t *testing.T) {
	tree := testTree(t)
	for _, scope := range []domain.Scope{{}, {OrgUnitIDs: []string{"Payments"}}} {
		p := principal(domain.RoleViewer, scope)
		for _, a := range []auth.Action{auth.ActionTenantAdmin, auth.ActionMethodologyWrite, auth.ActionDataWrite, auth.ActionOverrideWrite} {
			if auth.Can(p, a, auth.Resource{OrgUnitID: "Checkout"}, tree, month(2026, 6)) {
				t.Errorf("viewer %+v allowed %s", scope, a)
			}
		}
	}
}

func TestViewerReadsOnlyInScope(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleViewer, domain.Scope{OrgUnitIDs: []string{"Payments"}, MetricKeys: []string{"uptime"}})
	read := func(unit, metric string, m period.Period) bool {
		return auth.Can(p, auth.ActionDataRead, auth.Resource{OrgUnitID: unit, MetricKey: metric}, tree, m)
	}
	if !read("Checkout", "uptime", month(2026, 6)) {
		t.Error("viewer cannot read in-scope data")
	}
	if read("Platform", "uptime", month(2026, 6)) {
		t.Error("viewer read out-of-scope unit")
	}
	if read("Checkout", "revenue", month(2026, 6)) {
		t.Error("viewer read out-of-scope metric")
	}
	if read("Analytics", "uptime", month(2026, 6)) || !read("Analytics", "uptime", month(2026, 7)) {
		t.Error("viewer scope must follow the org as of the month")
	}

	all := principal(domain.RoleViewer, domain.Scope{})
	if !auth.Can(all, auth.ActionDataRead, auth.Resource{OrgUnitID: "Platform", MetricKey: "x"}, tree, month(2026, 6)) {
		t.Error("empty-scope viewer cannot read")
	}
}

func TestNoMembershipNoAccess(t *testing.T) {
	tree := testTree(t)
	operator := auth.Principal{UserID: "ops", IsOperator: true}
	operatorInTenant := auth.Principal{UserID: "ops", IsOperator: true, Tenant: &domain.Tenant{ID: "t1"}}
	for _, p := range []auth.Principal{operator, operatorInTenant, {}} {
		for _, a := range allActions {
			if auth.Can(p, a, auth.Resource{OrgUnitID: "Checkout"}, tree, month(2026, 6)) {
				t.Errorf("principal without membership allowed %s: %+v", a, p)
			}
		}
	}
}

func TestInvalidRoleDenied(t *testing.T) {
	tree := testTree(t)
	for _, role := range []domain.Role{"", "superuser"} {
		p := principal(role, domain.Scope{})
		for _, a := range allActions {
			if auth.Can(p, a, auth.Resource{OrgUnitID: "Checkout"}, tree, month(2026, 6)) {
				t.Errorf("role %q allowed %s", role, a)
			}
		}
	}
}

func TestNilTree(t *testing.T) {
	// Empty scope still works without a tree.
	open := principal(domain.RoleContributor, domain.Scope{})
	if !auth.Can(open, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout"}, nil, month(2026, 6)) {
		t.Error("empty-scope write denied with nil tree")
	}
	// A unit scope cannot be evaluated without a tree: deny (fail closed).
	scoped := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Payments"}})
	if auth.Can(scoped, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout"}, nil, month(2026, 6)) {
		t.Error("unit-scoped write allowed with nil tree")
	}
	// Metric-only scope does not need a tree.
	metric := principal(domain.RoleContributor, domain.Scope{MetricKeys: []string{"uptime"}})
	if !auth.Can(metric, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout", MetricKey: "uptime"}, nil, month(2026, 6)) {
		t.Error("metric-only scope denied listed metric with nil tree")
	}
	if auth.Can(metric, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout", MetricKey: "x"}, nil, month(2026, 6)) {
		t.Error("metric-only scope allowed unlisted metric with nil tree")
	}
}

func TestNonMonthPeriodFailsClosedForScopedUnit(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Payments"}})
	q := period.Period{Grain: period.Quarter, FY: 2026, Index: 3}
	// A direct match needs no ancestor walk; a descendant does, and a
	// non-month period cannot answer ParentAt.
	if !auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Payments"}, tree, q) {
		t.Error("direct scoped unit denied")
	}
	if auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: "Checkout"}, tree, q) {
		t.Error("descendant allowed with a non-month period")
	}
}

func TestMultipleScopedUnits(t *testing.T) {
	tree := testTree(t)
	p := principal(domain.RoleContributor, domain.Scope{OrgUnitIDs: []string{"Billing", "Platform"}})
	for unit, want := range map[string]bool{"Billing": true, "Analytics": true, "Platform": true, "Checkout": false, "Payments": false} {
		if got := auth.Can(p, auth.ActionDataWrite, auth.Resource{OrgUnitID: unit}, tree, month(2026, 6)); got != want {
			t.Errorf("write %s = %v, want %v", unit, got, want)
		}
	}
}
