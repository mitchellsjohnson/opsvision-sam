package httpapi

import (
	"context"
	"strconv"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// ListMembers lists the tenant's members, including pending invitations. Any
// member of the tenant may read it.
func (s *Server) ListMembers(ctx context.Context, _ ListMembersRequestObject) (ListMembersResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	ms, err := s.store.ListMemberships(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	return ListMembers200JSONResponse{Members: apiMemberships(ms)}, nil
}

// UpdateMember changes a member's role and/or scope. Admins only. A tenant
// always keeps at least one admin who has signed in.
func (s *Server) UpdateMember(ctx context.Context, req UpdateMemberRequestObject) (UpdateMemberResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	body := *req.Body
	tenantID := p.Tenant.ID

	var pr problems
	if !validUserID(req.UserId) {
		pr.add("userId", "must be non-empty and must not contain '#'")
	}
	if body.Role == nil && body.Scope == nil {
		pr.add("", "role or scope is required")
	}
	if body.Role != nil {
		pr.role("role", domain.Role(*body.Role))
	}
	var units map[string]bool
	if body.Scope != nil {
		if body.Scope.OrgUnitIds == nil || body.Scope.MetricKeys == nil {
			pr.add("scope", "orgUnitIds and metricKeys are both required (use [] for everything)")
		}
		us, err := s.store.ListOrgUnits(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		units = make(map[string]bool, len(us))
		for _, u := range us {
			units[u.ID] = true
		}
		for i, id := range body.Scope.OrgUnitIds {
			path := "scope.orgUnitIds[" + strconv.Itoa(i) + "]"
			switch {
			case !validID(id):
				pr.add(path, "%s", idRule)
			case !units[id]:
				pr.add(path, "org unit %q does not exist", id)
			}
		}
		for i, k := range body.Scope.MetricKeys {
			pr.key("scope.metricKeys["+strconv.Itoa(i)+"]", k)
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	current, err := s.store.GetMembership(ctx, tenantID, req.UserId)
	if err != nil {
		return nil, err // ErrNotFound -> 404
	}
	updated := current
	if body.Role != nil {
		updated.Role = domain.Role(*body.Role)
	}
	if body.Scope != nil {
		updated.Scope = domainScope(*body.Scope)
	}

	if current.Role == domain.RoleAdmin && updated.Role != domain.RoleAdmin {
		others, err := s.otherSignedInAdmins(ctx, tenantID, current.UserID)
		if err != nil {
			return nil, err
		}
		if others == 0 {
			return nil, badRequest("tenant must keep at least one admin")
		}
	}

	if err := s.store.PutMembership(ctx, tenantID, updated); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "member.update", "member", updated.UserID, apiMembership(current), apiMembership(updated)); err != nil {
		return nil, err
	}
	return UpdateMember200JSONResponse(apiMembership(updated)), nil
}

// otherSignedInAdmins counts admins other than userID who can act: pending
// invitations do not count, since nobody can use one until it is claimed.
func (s *Server) otherSignedInAdmins(ctx context.Context, tenantID, userID string) (int, error) {
	ms, err := s.store.ListMemberships(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, m := range ms {
		if m.Role == domain.RoleAdmin && m.UserID != userID && !strings.HasPrefix(m.UserID, store.PendingUserPrefix) {
			n++
		}
	}
	return n, nil
}
