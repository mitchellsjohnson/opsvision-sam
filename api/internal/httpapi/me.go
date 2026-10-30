package httpapi

import (
	"context"
	"errors"

	"opsvision/internal/store"
)

// GetMe returns the caller's identity, active tenant, and every tenant the
// caller belongs to.
func (s *Server) GetMe(ctx context.Context, _ GetMeRequestObject) (GetMeResponseObject, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	me := Me{
		UserId:     p.UserID,
		Name:       p.Name,
		Email:      p.Email,
		IsOperator: p.IsOperator,
		Tenants:    []TenantSummary{},
	}
	if p.Tenant != nil {
		t := apiTenant(*p.Tenant)
		me.Tenant = &t
	}
	if p.Membership != nil {
		role := Role(p.Membership.Role)
		scope := apiScope(p.Membership.Scope)
		me.Role = &role
		me.Scope = &scope
	}

	ids, err := s.store.TenantsForUser(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		t, err := s.store.GetTenant(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		me.Tenants = append(me.Tenants, TenantSummary{Id: t.ID, Name: t.Name})
	}
	return GetMe200JSONResponse(me), nil
}
