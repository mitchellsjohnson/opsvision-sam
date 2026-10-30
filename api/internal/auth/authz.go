package auth

import (
	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// Action is something a principal may be allowed to do within its tenant.
type Action string

// Actions.
const (
	ActionTenantAdmin      Action = "tenant:admin"
	ActionMethodologyWrite Action = "methodology:write"
	ActionDataWrite        Action = "data:write"
	ActionDataRead         Action = "data:read"
	ActionOverrideWrite    Action = "override:write"
)

func (a Action) known() bool {
	switch a {
	case ActionTenantAdmin, ActionMethodologyWrite, ActionDataWrite, ActionDataRead, ActionOverrideWrite:
		return true
	}
	return false
}

// Resource names what an action targets.
//
// OrgUnitID is the org unit the data belongs to. For a tracked-item subject
// the caller passes the item's attached OrgUnitID (TrackedItem.OrgUnitID), so
// scope follows the org unit the item currently rolls up to. MetricKey is the
// metric concerned, or "" when the action is not about one metric.
type Resource struct {
	OrgUnitID string
	MetricKey string
}

// maxAncestorSteps bounds the walk up the hierarchy. The orgtree package
// guarantees acyclic hierarchies; the bound is defense in depth so a
// malformed tree can never hang a request.
const maxAncestorSteps = 1024

// Can reports whether p may perform a on res, evaluating the org hierarchy as
// of month (a Month-grain period).
//
//   - A principal without a membership in its tenant can do nothing. That
//     includes operators: operating the platform is not tenant access.
//   - admin: every action, unrestricted by scope.
//   - contributor: data:read anywhere; data:write inside its scope; nothing else.
//   - viewer: data:read inside its scope; nothing else.
//
// Scope: the unit is in scope when Scope.OrgUnitIDs is empty, or res.OrgUnitID
// is a scoped unit or has a scoped unit as an ancestor as of month; the metric
// is in scope when Scope.MetricKeys is empty, res.MetricKey is "", or it is
// listed. Both must hold. A non-empty unit scope that cannot be evaluated
// (nil tree, unknown unit, non-Month period) denies.
func Can(p Principal, a Action, res Resource, tree *orgtree.Tree, month period.Period) bool {
	m := p.Membership
	if m == nil || !a.known() {
		return false
	}
	switch m.Role {
	case domain.RoleAdmin:
		return true
	case domain.RoleContributor:
		switch a {
		case ActionDataRead:
			return true
		case ActionDataWrite:
			return inScope(m.Scope, res, tree, month)
		}
	case domain.RoleViewer:
		if a == ActionDataRead {
			return inScope(m.Scope, res, tree, month)
		}
	}
	return false
}

func inScope(s domain.Scope, res Resource, tree *orgtree.Tree, month period.Period) bool {
	return metricInScope(s.MetricKeys, res.MetricKey) && unitInScope(s.OrgUnitIDs, res.OrgUnitID, tree, month)
}

func metricInScope(keys []string, key string) bool {
	if len(keys) == 0 || key == "" {
		return true
	}
	for _, k := range keys {
		if k == key {
			return true
		}
	}
	return false
}

func unitInScope(scoped []string, unit string, tree *orgtree.Tree, month period.Period) bool {
	if len(scoped) == 0 {
		return true
	}
	if tree == nil || unit == "" {
		return false
	}
	want := make(map[string]struct{}, len(scoped))
	for _, id := range scoped {
		want[id] = struct{}{}
	}
	cur := unit
	for steps := 0; steps <= maxAncestorSteps; steps++ {
		if _, ok := want[cur]; ok {
			return true
		}
		parent, ok := tree.ParentAt(cur, month)
		if !ok || parent == "" {
			return false
		}
		cur = parent
	}
	return false
}
