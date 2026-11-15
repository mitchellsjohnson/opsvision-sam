package httpapi

import (
	"context"
	"errors"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// GetMyPreferences returns the caller's preferences in the active tenant, or
// the defaults (company scope) when none were saved.
func (s *Server) GetMyPreferences(ctx context.Context, _ GetMyPreferencesRequestObject) (GetMyPreferencesResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	prefs, err := s.store.GetPreferences(ctx, p.Tenant.ID, p.UserID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	return GetMyPreferences200JSONResponse{DefaultScope: prefs.DefaultScope}, nil
}

// PutMyPreferences saves the caller's preferences. The default scope must be
// empty (company) or an org unit of the tenant that is active this month.
func (s *Server) PutMyPreferences(ctx context.Context, req PutMyPreferencesRequestObject) (PutMyPreferencesResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	scope := req.Body.DefaultScope
	if scope != "" {
		units, err := s.store.ListOrgUnits(ctx, p.Tenant.ID)
		if err != nil {
			return nil, err
		}
		thisMonth := s.calendar(*p.Tenant).MonthOf(s.now())
		var pr problems
		u, ok := orgState{units: units}.unit(scope)
		switch {
		case !ok:
			pr.add("defaultScope", "unknown org unit %q", scope)
		case u.RetiredFrom != nil && store.ComparePeriod(*u.RetiredFrom, thisMonth) <= 0:
			pr.add("defaultScope", "org unit %q is retired", scope)
		}
		if err := pr.err(); err != nil {
			return nil, err
		}
	}
	prefs := domain.UserPreferences{DefaultScope: scope}
	if err := s.store.PutPreferences(ctx, p.Tenant.ID, p.UserID, prefs); err != nil {
		return nil, err
	}
	return PutMyPreferences200JSONResponse{DefaultScope: prefs.DefaultScope}, nil
}
