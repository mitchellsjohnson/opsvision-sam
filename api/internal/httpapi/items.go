package httpapi

import (
	"context"
	"errors"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// ListItemKinds lists the tenant's item kinds.
func (s *Server) ListItemKinds(ctx context.Context, _ ListItemKindsRequestObject) (ListItemKindsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	ks, err := s.store.ListItemKinds(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	out := make([]ItemKind, 0, len(ks))
	for _, k := range ks {
		out = append(out, ItemKind{Id: k.ID, Name: k.Name})
	}
	return ListItemKinds200JSONResponse{ItemKinds: out}, nil
}

// CreateItemKind adds an item kind. Admins only.
func (s *Server) CreateItemKind(ctx context.Context, req CreateItemKindRequestObject) (CreateItemKindResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	var pr problems
	pr.id("id", req.Body.Id)
	pr.nonEmpty("name", req.Body.Name)
	if err := pr.err(); err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	kinds, err := s.store.ListItemKinds(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, k := range kinds {
		if k.ID == req.Body.Id {
			return nil, conflict("item kind " + k.ID + " already exists")
		}
	}
	kind := domain.ItemKind{ID: req.Body.Id, Name: strings.TrimSpace(req.Body.Name)}
	if err := s.store.PutItemKind(ctx, tenantID, kind); err != nil {
		return nil, err
	}
	out := ItemKind{Id: kind.ID, Name: kind.Name}
	if err := s.audit(ctx, p, tenantID, "item_kind.create", "item_kind", kind.ID, nil, out); err != nil {
		return nil, err
	}
	return CreateItemKind201JSONResponse(out), nil
}

func apiItem(it domain.TrackedItem) TrackedItem {
	return TrackedItem{
		Id:         it.ID,
		KindId:     it.KindID,
		Name:       it.Name,
		OrgUnitId:  it.OrgUnitID,
		SourceKeys: append([]string{}, it.SourceKeys...),
	}
}

// ListItems lists tracked items, optionally of one kind.
func (s *Server) ListItems(ctx context.Context, req ListItemsRequestObject) (ListItemsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	kind := ""
	if req.Params.Kind != nil {
		kind = *req.Params.Kind
		var pr problems
		pr.id("kind", kind)
		if err := pr.err(); err != nil {
			return nil, err
		}
	}
	items, err := s.store.ListTrackedItems(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	out := make([]TrackedItem, 0, len(items))
	for _, it := range items {
		if kind == "" || it.KindID == kind {
			out = append(out, apiItem(it))
		}
	}
	return ListItems200JSONResponse{Items: out}, nil
}

// CreateItem adds a tracked item. Admins only.
func (s *Server) CreateItem(ctx context.Context, req CreateItemRequestObject) (CreateItemResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	tenantID := p.Tenant.ID

	var pr problems
	pr.id("id", b.Id)
	pr.id("kindId", b.KindId)
	pr.nonEmpty("name", b.Name)
	pr.optionalID("orgUnitId", b.OrgUnitId)
	keys := trimKeys(&pr, "sourceKeys", b.SourceKeys)
	if err := pr.err(); err != nil {
		return nil, err
	}

	kinds, err := s.store.ListItemKinds(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	units, err := s.store.ListOrgUnits(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	existing, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, it := range existing {
		if it.ID == b.Id {
			return nil, conflict("item " + b.Id + " already exists")
		}
	}
	if !hasKind(kinds, b.KindId) {
		pr.add("kindId", "item kind %q does not exist", b.KindId)
	}
	if b.OrgUnitId != "" && !hasUnit(units, b.OrgUnitId) {
		pr.add("orgUnitId", "org unit %q does not exist", b.OrgUnitId)
	}
	owners, err := s.sourceKeyOwners(ctx, tenantID, units, "", "")
	if err != nil {
		return nil, err
	}
	checkKeyConflicts(&pr, "sourceKeys", keys, owners)
	if err := pr.err(); err != nil {
		return nil, err
	}

	item := domain.TrackedItem{ID: b.Id, KindID: b.KindId, Name: strings.TrimSpace(b.Name), OrgUnitID: b.OrgUnitId, SourceKeys: keys}
	if err := s.store.PutTrackedItem(ctx, tenantID, item); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "item.create", "item", item.ID, nil, apiItem(item)); err != nil {
		return nil, err
	}
	return CreateItem201JSONResponse(apiItem(item)), nil
}

// UpdateItem renames, re-attaches, or re-keys a tracked item. Admins only.
// An empty orgUnitId detaches the item.
func (s *Server) UpdateItem(ctx context.Context, req UpdateItemRequestObject) (UpdateItemResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	tenantID := p.Tenant.ID

	var pr problems
	pr.id("id", req.Id)
	if b.Name == nil && b.OrgUnitId == nil && b.SourceKeys == nil {
		pr.add("", "name, orgUnitId, or sourceKeys is required")
	}
	if b.Name != nil {
		pr.nonEmpty("name", *b.Name)
	}
	if b.OrgUnitId != nil {
		pr.optionalID("orgUnitId", *b.OrgUnitId)
	}
	var keys []string
	if b.SourceKeys != nil {
		keys = trimKeys(&pr, "sourceKeys", *b.SourceKeys)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	items, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var current domain.TrackedItem
	found := false
	for _, it := range items {
		if it.ID == req.Id {
			current, found = it, true
		}
	}
	if !found {
		return nil, notFound("item not found")
	}
	units, err := s.store.ListOrgUnits(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if b.OrgUnitId != nil && *b.OrgUnitId != "" && !hasUnit(units, *b.OrgUnitId) {
		pr.add("orgUnitId", "org unit %q does not exist", *b.OrgUnitId)
	}
	if b.SourceKeys != nil {
		owners, err := s.sourceKeyOwners(ctx, tenantID, units, "", current.ID)
		if err != nil {
			return nil, err
		}
		checkKeyConflicts(&pr, "sourceKeys", keys, owners)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	updated := current
	if b.Name != nil {
		updated.Name = strings.TrimSpace(*b.Name)
	}
	if b.OrgUnitId != nil {
		updated.OrgUnitID = *b.OrgUnitId
	}
	if b.SourceKeys != nil {
		updated.SourceKeys = keys
	}
	if err := s.store.PutTrackedItem(ctx, tenantID, updated); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, notFound("item not found")
		}
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "item.update", "item", updated.ID, apiItem(current), apiItem(updated)); err != nil {
		return nil, err
	}
	return UpdateItem200JSONResponse(apiItem(updated)), nil
}

func hasKind(ks []domain.ItemKind, id string) bool {
	for _, k := range ks {
		if k.ID == id {
			return true
		}
	}
	return false
}

func hasUnit(us []domain.OrgUnit, id string) bool {
	for _, u := range us {
		if u.ID == id {
			return true
		}
	}
	return false
}
