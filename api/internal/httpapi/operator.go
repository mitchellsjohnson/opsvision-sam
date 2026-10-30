package httpapi

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// ListOperatorTenants lists every tenant. Operators only.
func (s *Server) ListOperatorTenants(ctx context.Context, _ ListOperatorTenantsRequestObject) (ListOperatorTenantsResponseObject, error) {
	if _, err := operator(ctx); err != nil {
		return nil, err
	}
	ts, err := s.store.ListTenants(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Tenant, 0, len(ts))
	for _, t := range ts {
		out = append(out, apiTenant(t))
	}
	return ListOperatorTenants200JSONResponse{Tenants: out}, nil
}

// CreateOperatorTenant creates a tenant and invites its first admin. The
// invitation is a pending admin membership that binds to the admin's account
// at first sign-in (see the auth package).
func (s *Server) CreateOperatorTenant(ctx context.Context, req CreateOperatorTenantRequestObject) (CreateOperatorTenantResponseObject, error) {
	p, err := operator(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body

	var pr problems
	pr.nonEmpty("name", b.Name)
	pr.nonEmpty("auth0OrgId", b.Auth0OrgId)
	if b.FiscalYearStartMonth < int(time.January) || b.FiscalYearStartMonth > int(time.December) {
		pr.add("fiscalYearStartMonth", "must be between 1 and 12")
	}
	email, ok := normalizeEmail(b.AdminEmail)
	if !ok {
		pr.add("adminEmail", "must be a plain email address such as admin@example.com")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	now := s.now()
	tenant := domain.Tenant{
		ID:                   s.newID(),
		Name:                 strings.TrimSpace(b.Name),
		Auth0OrgID:           strings.TrimSpace(b.Auth0OrgId),
		FiscalYearStartMonth: time.Month(b.FiscalYearStartMonth),
		StatusScale:          domain.DefaultStatusScale(),
		DefaultRole:          domain.RoleViewer,
		CreatedAt:            now,
	}
	if err := s.store.CreateTenant(ctx, tenant); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, conflict("a tenant for this Auth0 organization already exists")
		}
		return nil, err
	}

	invite := domain.Membership{
		UserID:    store.PendingUserPrefix + email,
		Email:     email,
		Role:      domain.RoleAdmin,
		Scope:     domain.Scope{OrgUnitIDs: []string{}, MetricKeys: []string{}},
		CreatedAt: now,
	}
	if err := s.store.PutMembership(ctx, tenant.ID, invite); err != nil {
		return nil, err
	}

	if err := s.audit(ctx, p, tenant.ID, "tenant.create", "tenant", tenant.ID, nil, apiTenant(tenant)); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenant.ID, "member.create", "member", invite.UserID, nil, apiMembership(invite)); err != nil {
		return nil, err
	}
	return CreateOperatorTenant201JSONResponse(apiTenant(tenant)), nil
}

// normalizeEmail accepts a bare address (no display name, no '#', which the
// store reserves) and returns it lowercased, the form used in pending user
// IDs.
func normalizeEmail(s string) (string, bool) {
	s = strings.TrimSpace(s)
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || strings.Contains(s, "#") {
		return "", false
	}
	return strings.ToLower(s), true
}
