package httpapi

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

const maxLayoutItems = 200

var layoutItemIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9:_-]{0,80}$`)

func domainLayoutItems(items []LayoutItem) []domain.LayoutItem {
	out := make([]domain.LayoutItem, len(items))
	for i, it := range items {
		out[i] = domain.LayoutItem{ID: it.Id, Size: string(it.Size), Hidden: it.Hidden}
	}
	return out
}

func apiLayoutResponse(items []domain.LayoutItem, revision int, source LayoutResponseSource) LayoutResponse {
	out := LayoutResponse{
		Items:    make([]LayoutItem, len(items)),
		Revision: revision,
		Source:   source,
	}
	for i, it := range items {
		out.Items[i] = LayoutItem{Id: it.ID, Size: LayoutItemSize(it.Size), Hidden: it.Hidden}
	}
	return out
}

func validateLayoutItems(pr *problems, items []LayoutItem) {
	if len(items) > maxLayoutItems {
		pr.add("items", "must contain at most %d items", maxLayoutItems)
	}
	seen := map[string]struct{}{}
	for i, it := range items {
		path := indexPath("items", i)
		if !layoutItemIDPattern.MatchString(it.Id) {
			pr.add(path+".id", "must match %s", layoutItemIDPattern.String())
		}
		if it.Size != Small && it.Size != Wide {
			pr.add(path+".size", "must be small or wide")
		}
		if _, dup := seen[it.Id]; dup {
			pr.add(path+".id", "duplicate id %q", it.Id)
		} else {
			seen[it.Id] = struct{}{}
		}
	}
}

// GetMyLayout returns the caller's layout, else the tenant default, else empty.
func (s *Server) GetMyLayout(ctx context.Context, req GetMyLayoutRequestObject) (GetMyLayoutResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	userLayout, err := s.store.GetLayout(ctx, p.Tenant.ID, p.UserID, req.Sc)
	if err == nil {
		return GetMyLayout200JSONResponse(apiLayoutResponse(userLayout.Items, userLayout.Revision, User)), nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	def, err := s.store.GetDefaultLayout(ctx, p.Tenant.ID, req.Sc)
	if err == nil {
		return GetMyLayout200JSONResponse(apiLayoutResponse(def.Items, 0, Default)), nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	return GetMyLayout200JSONResponse(apiLayoutResponse([]domain.LayoutItem{}, 0, Empty)), nil
}

func (s *Server) putLayout(ctx context.Context, tenantID, userID, scorecardID string, b PutLayoutRequest, source LayoutResponseSource) (LayoutResponse, error) {
	var pr problems
	if b.ExpectedRevision < 0 {
		pr.add("expectedRevision", "must not be negative")
	}
	validateLayoutItems(&pr, b.Items)
	if err := pr.err(); err != nil {
		return LayoutResponse{}, err
	}
	items := domainLayoutItems(b.Items)
	stored, err := s.store.PutLayout(ctx, tenantID, userID, scorecardID, items, b.ExpectedRevision)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return LayoutResponse{}, conflict("the layout changed since it was loaded; reload it and try again")
		}
		return LayoutResponse{}, err
	}
	return apiLayoutResponse(stored.Items, stored.Revision, source), nil
}

// PutMyLayout saves the caller's layout for a scorecard.
func (s *Server) PutMyLayout(ctx context.Context, req PutMyLayoutRequestObject) (PutMyLayoutResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	out, err := s.putLayout(ctx, p.Tenant.ID, p.UserID, req.Sc, *req.Body, User)
	if err != nil {
		return nil, err
	}
	return PutMyLayout200JSONResponse(out), nil
}

func (s *Server) putDefaultLayout(ctx context.Context, tenantID, scorecardID string, b PutLayoutRequest) (LayoutResponse, error) {
	var pr problems
	if b.ExpectedRevision < 0 {
		pr.add("expectedRevision", "must not be negative")
	}
	validateLayoutItems(&pr, b.Items)
	if err := pr.err(); err != nil {
		return LayoutResponse{}, err
	}
	items := domainLayoutItems(b.Items)
	stored, err := s.store.PutDefaultLayout(ctx, tenantID, scorecardID, items, b.ExpectedRevision)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return LayoutResponse{}, conflict(fmt.Sprintf("the default layout for %s changed since it was loaded; reload it and try again", scorecardID))
		}
		return LayoutResponse{}, err
	}
	return apiLayoutResponse(stored.Items, stored.Revision, Default), nil
}

// PutDefaultLayout saves the tenant default layout. Admins only.
func (s *Server) PutDefaultLayout(ctx context.Context, req PutDefaultLayoutRequestObject) (PutDefaultLayoutResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc); err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	out, err := s.putDefaultLayout(ctx, p.Tenant.ID, req.Sc, *req.Body)
	if err != nil {
		return nil, err
	}
	return PutDefaultLayout200JSONResponse(out), nil
}
