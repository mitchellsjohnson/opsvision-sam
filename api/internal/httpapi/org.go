package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

const (
	msgChildrenFirst = "move or retire child units first"
	msgRetiredParent = "parent unit would be retired while this unit is still its child"
)

// orgState is a tenant's org model as stored.
type orgState struct {
	levels []domain.Level
	units  []domain.OrgUnit
	moves  []domain.OrgMove
}

func (s *Server) loadOrg(ctx context.Context, tenantID string) (orgState, error) {
	var st orgState
	var err error
	if st.levels, err = s.store.ListLevels(ctx, tenantID); err != nil {
		return st, err
	}
	if st.units, err = s.store.ListOrgUnits(ctx, tenantID); err != nil {
		return st, err
	}
	st.moves, err = s.store.ListOrgMoves(ctx, tenantID)
	return st, err
}

func (o orgState) unit(id string) (domain.OrgUnit, bool) {
	for _, u := range o.units {
		if u.ID == id {
			return u, true
		}
	}
	return domain.OrgUnit{}, false
}

func (o orgState) hasLevel(id string) bool {
	_, ok := levelDepth(o.levels, id)
	return ok
}

// levelDepth returns the depth of the level with the given ID.
func levelDepth(levels []domain.Level, id string) (int, bool) {
	for _, l := range levels {
		if l.ID == id {
			return l.Depth, true
		}
	}
	return 0, false
}

// depthViolations lists every parent/child pair, involving unit `only` (or
// any unit when only is ""), whose levels are not strictly deeper below than
// above. A pair is a unit and one of its parents: the one it was created
// with or any it moves to. Pairs whose level is unknown are skipped; the
// level checks report those.
func depthViolations(levels []domain.Level, units []domain.OrgUnit, moves []domain.OrgMove, only string) []string {
	byID := make(map[string]domain.OrgUnit, len(units))
	for _, u := range units {
		byID[u.ID] = u
	}
	var out []string
	seen := map[[2]string]bool{}
	check := func(child, parent string) {
		if parent == "" || seen[[2]string{child, parent}] {
			return
		}
		seen[[2]string{child, parent}] = true
		if only != "" && child != only && parent != only {
			return
		}
		c, cok := byID[child]
		p, pok := byID[parent]
		if !cok || !pok {
			return
		}
		cd, cok := levelDepth(levels, c.LevelID)
		pd, pok := levelDepth(levels, p.LevelID)
		if cok && pok && cd <= pd {
			out = append(out, fmt.Sprintf("org unit %s (level %s, depth %d) must be deeper than its parent %s (level %s, depth %d)",
				child, c.LevelID, cd, parent, p.LevelID, pd))
		}
	}
	for _, u := range units {
		check(u.ID, u.ParentID)
	}
	for _, m := range moves {
		check(m.UnitID, m.NewParentID)
	}
	return out
}

// candidate builds the tree that would result from units and moves, turning
// any structural problem (cycle, unknown reference, duplicate move) into a
// 400. Callers validate a change against it before writing anything.
func candidate(units []domain.OrgUnit, moves []domain.OrgMove) (*orgtree.Tree, error) {
	t, err := orgtree.New(units, moves)
	if err != nil {
		return nil, badRequest(err.Error())
	}
	return t, nil
}

// strandsChildren reports whether the retired unit id would be the parent of
// an active unit at its retirement month, or at a later month in which a move
// puts a unit under it.
func strandsChildren(t *orgtree.Tree, moves []domain.OrgMove, id string) bool {
	u, ok := t.Unit(id)
	if !ok || u.RetiredFrom == nil {
		return false
	}
	r := *u.RetiredFrom
	if len(t.ChildrenAt(id, r)) > 0 {
		return true
	}
	for _, m := range moves {
		if m.NewParentID == id && store.ComparePeriod(m.EffectiveMonth, r) >= 0 && len(t.ChildrenAt(id, m.EffectiveMonth)) > 0 {
			return true
		}
	}
	return false
}

// ListOrgLevels lists the hierarchy levels, shallowest first.
func (s *Server) ListOrgLevels(ctx context.Context, _ ListOrgLevelsRequestObject) (ListOrgLevelsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	ls, err := s.store.ListLevels(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	return ListOrgLevels200JSONResponse{Levels: apiLevels(ls)}, nil
}

// PutOrgLevels replaces the hierarchy levels. Admins only. A level that org
// units still use cannot be dropped.
func (s *Server) PutOrgLevels(ctx context.Context, req PutOrgLevelsRequestObject) (PutOrgLevelsResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil || req.Body.Levels == nil {
		return nil, badRequest("levels is required")
	}
	tenantID := p.Tenant.ID

	var pr problems
	levels := make([]domain.Level, 0, len(req.Body.Levels))
	seen := map[string]bool{}
	depths := map[int]string{}
	for i, l := range req.Body.Levels {
		path := "levels[" + strconv.Itoa(i) + "]"
		pr.id(path+".id", l.Id)
		pr.nonEmpty(path+".name", l.Name)
		if l.Depth < 0 {
			pr.add(path+".depth", "must be 0 or greater")
		}
		if seen[l.Id] {
			pr.add(path+".id", "duplicate level id %q", l.Id)
		}
		seen[l.Id] = true
		if other, dup := depths[l.Depth]; dup && l.Depth >= 0 {
			pr.add(path+".depth", "depth %d is already used by level %q", l.Depth, other)
		}
		depths[l.Depth] = l.Id
		levels = append(levels, domain.Level{ID: l.Id, Name: strings.TrimSpace(l.Name), Depth: l.Depth})
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	before, err := s.loadOrg(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, u := range before.units {
		if !seen[u.LevelID] {
			return nil, conflict("level " + u.LevelID + " is still used by org unit " + u.ID)
		}
	}

	if vs := depthViolations(levels, before.units, before.moves, ""); len(vs) > 0 {
		for _, v := range vs {
			pr.add("levels", "%s", v)
		}
		return nil, pr.err()
	}

	if err := s.store.PutLevels(ctx, tenantID, levels); err != nil {
		return nil, err
	}
	stored, err := s.store.ListLevels(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "org_levels.replace", "org_levels", "levels", apiLevels(before.levels), apiLevels(stored)); err != nil {
		return nil, err
	}
	return PutOrgLevels200JSONResponse{Levels: apiLevels(stored)}, nil
}

// ListOrgUnits lists every org unit, retired ones included.
func (s *Server) ListOrgUnits(ctx context.Context, _ ListOrgUnitsRequestObject) (ListOrgUnitsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	us, err := s.store.ListOrgUnits(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	return ListOrgUnits200JSONResponse{Units: apiOrgUnits(us)}, nil
}

// CreateOrgUnit adds an org unit. Admins only.
func (s *Server) CreateOrgUnit(ctx context.Context, req CreateOrgUnitRequestObject) (CreateOrgUnitResponseObject, error) {
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
	pr.nonEmpty("name", b.Name)
	pr.id("levelId", b.LevelId)
	pr.optionalID("parentId", b.ParentId)
	keys := trimKeys(&pr, "sourceKeys", b.SourceKeys)
	var retired *period.Period
	if b.RetiredFrom != nil {
		if m, ok := pr.month("retiredFrom", *b.RetiredFrom); ok {
			retired = &m
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	st, err := s.loadOrg(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	owners, err := s.sourceKeyOwners(ctx, tenantID, st.units, "", "")
	if err != nil {
		return nil, err
	}
	checkKeyConflicts(&pr, "sourceKeys", keys, owners)
	if _, exists := st.unit(b.Id); exists {
		return nil, conflict("org unit " + b.Id + " already exists")
	}
	if !st.hasLevel(b.LevelId) {
		pr.add("levelId", "level %q does not exist", b.LevelId)
	}
	if b.ParentId != "" {
		parent, ok := st.unit(b.ParentId)
		if !ok {
			pr.add("parentId", "org unit %q does not exist", b.ParentId)
		} else if cd, ok := levelDepth(st.levels, b.LevelId); ok {
			if pd, ok := levelDepth(st.levels, parent.LevelID); ok && cd <= pd {
				pr.add("levelId", "level depth %d must be greater than the parent's level depth %d", cd, pd)
			}
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	unit := domain.OrgUnit{
		ID:          b.Id,
		Name:        strings.TrimSpace(b.Name),
		LevelID:     b.LevelId,
		ParentID:    b.ParentId,
		SourceKeys:  keys,
		RetiredFrom: retired,
	}
	tree, err := candidate(append(append([]domain.OrgUnit{}, st.units...), unit), st.moves)
	if err != nil {
		return nil, err
	}
	for _, id := range []string{unit.ID, unit.ParentID} {
		if id != "" && strandsChildren(tree, st.moves, id) {
			return nil, badRequest(msgRetiredParent, detail{Path: "parentId", Message: "parent is retired while this unit would still be its child"})
		}
	}

	if err := s.store.PutOrgUnit(ctx, tenantID, unit); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "org_unit.create", "org_unit", unit.ID, nil, apiOrgUnit(unit)); err != nil {
		return nil, err
	}
	return CreateOrgUnit201JSONResponse(apiOrgUnit(unit)), nil
}

// UpdateOrgUnit renames, re-keys, or retires an org unit. Admins only.
func (s *Server) UpdateOrgUnit(ctx context.Context, req UpdateOrgUnitRequestObject) (UpdateOrgUnitResponseObject, error) {
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
	if b.Name == nil && b.LevelId == nil && b.SourceKeys == nil && b.RetiredFrom == nil {
		pr.add("", "name, levelId, sourceKeys, or retiredFrom is required")
	}
	if b.Name != nil {
		pr.nonEmpty("name", *b.Name)
	}
	if b.LevelId != nil {
		pr.id("levelId", *b.LevelId)
	}
	var keys []string
	if b.SourceKeys != nil {
		keys = trimKeys(&pr, "sourceKeys", *b.SourceKeys)
	}
	var retired *period.Period
	if b.RetiredFrom != nil {
		if m, ok := pr.month("retiredFrom", *b.RetiredFrom); ok {
			retired = &m
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	st, err := s.loadOrg(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	current, ok := st.unit(req.Id)
	if !ok {
		return nil, notFound("org unit not found")
	}

	if b.LevelId != nil && !st.hasLevel(*b.LevelId) {
		pr.add("levelId", "level %q does not exist", *b.LevelId)
	}
	if b.SourceKeys != nil {
		owners, err := s.sourceKeyOwners(ctx, tenantID, st.units, current.ID, "")
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
	if b.LevelId != nil {
		updated.LevelID = *b.LevelId
	}
	if b.SourceKeys != nil {
		updated.SourceKeys = keys
	}
	if retired != nil {
		updated.RetiredFrom = retired
	}

	units := make([]domain.OrgUnit, 0, len(st.units))
	for _, u := range st.units {
		if u.ID == updated.ID {
			u = updated
		}
		units = append(units, u)
	}
	tree, err := candidate(units, st.moves)
	if err != nil {
		return nil, err
	}
	if retired != nil && strandsChildren(tree, st.moves, updated.ID) {
		return nil, badRequest(msgChildrenFirst)
	}
	if b.LevelId != nil && updated.LevelID != current.LevelID {
		if vs := depthViolations(st.levels, units, st.moves, updated.ID); len(vs) > 0 {
			for _, v := range vs {
				pr.add("levelId", "%s", v)
			}
			return nil, pr.err()
		}
	}

	if err := s.store.PutOrgUnit(ctx, tenantID, updated); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "org_unit.update", "org_unit", updated.ID, apiOrgUnit(current), apiOrgUnit(updated)); err != nil {
		return nil, err
	}
	return UpdateOrgUnit200JSONResponse(apiOrgUnit(updated)), nil
}

// CreateOrgMove reparents a unit from a month. Admins only. The new parent
// must exist and be active in that month, and the resulting hierarchy must be
// acyclic in every month.
func (s *Server) CreateOrgMove(ctx context.Context, req CreateOrgMoveRequestObject) (CreateOrgMoveResponseObject, error) {
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
	pr.id("newParentId", b.NewParentId)
	month, _ := pr.month("effectiveMonth", b.EffectiveMonth)
	note := ""
	if b.Note != nil {
		note = *b.Note
	}
	if len(note) > maxNoteBytes {
		pr.add("note", "must be at most %d bytes", maxNoteBytes)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	st, err := s.loadOrg(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if _, ok := st.unit(req.Id); !ok {
		return nil, notFound("org unit not found")
	}
	for _, m := range st.moves {
		if m.UnitID == req.Id && m.EffectiveMonth == month {
			return nil, conflict("org unit " + req.Id + " already has a move effective " + month.String())
		}
	}
	if _, ok := st.unit(b.NewParentId); !ok {
		return nil, badRequest("new parent does not exist", detail{Path: "newParentId", Message: "org unit " + b.NewParentId + " does not exist"})
	}

	if vs := depthViolations(st.levels, st.units, []domain.OrgMove{{UnitID: req.Id, NewParentID: b.NewParentId}}, req.Id); len(vs) > 0 {
		// Only the new move's pair can be reported here: the stored pairs
		// were valid when written.
		last := vs[len(vs)-1]
		return nil, badRequest("new parent is not at a shallower level", detail{Path: "newParentId", Message: last})
	}

	move := domain.OrgMove{UnitID: req.Id, NewParentID: b.NewParentId, EffectiveMonth: month, Note: note}
	moves := append(append([]domain.OrgMove{}, st.moves...), move)
	tree, err := candidate(st.units, moves)
	if err != nil {
		return nil, err
	}
	if !tree.ActiveAt(b.NewParentId, month) {
		return nil, badRequest("new parent is retired at the effective month", detail{Path: "newParentId", Message: "org unit " + b.NewParentId + " is retired in " + month.String()})
	}
	if strandsChildren(tree, moves, b.NewParentId) {
		return nil, badRequest(msgRetiredParent, detail{Path: "newParentId", Message: "org unit " + b.NewParentId + " is retired while this unit would still be its child"})
	}

	// The parent the unit had just before the move, for the audit record.
	old, err := candidate(st.units, st.moves)
	if err != nil {
		return nil, err
	}
	prevParent, _ := old.ParentAt(req.Id, month)

	if err := s.store.PutOrgMove(ctx, tenantID, move); err != nil {
		return nil, err
	}
	before := map[string]string{"unitId": req.Id, "parentId": prevParent, "asOf": month.String()}
	if err := s.audit(ctx, p, tenantID, "org_unit.move", "org_unit", req.Id, before, apiOrgMove(move)); err != nil {
		return nil, err
	}
	return CreateOrgMove201JSONResponse(apiOrgMove(move)), nil
}

// GetOrgTree returns the hierarchy as it stood in a month (default: the
// current month on the tenant's fiscal calendar). Retired units are omitted.
func (s *Server) GetOrgTree(ctx context.Context, req GetOrgTreeRequestObject) (GetOrgTreeResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	var month period.Period
	if req.Params.Month != nil {
		var pr problems
		m, _ := pr.month("month", *req.Params.Month)
		if err := pr.err(); err != nil {
			return nil, err
		}
		month = m
	} else {
		month = s.calendar(*p.Tenant).MonthOf(s.now())
	}

	st, err := s.loadOrg(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	tree, err := orgtree.New(st.units, st.moves)
	if err != nil {
		// Stored state the API itself would have refused: not the caller's fault.
		return nil, errors.New("stored org model is inconsistent: " + err.Error())
	}
	var build func(id string) OrgTreeNode
	build = func(id string) OrgTreeNode {
		u, _ := tree.Unit(id)
		children := tree.ChildrenAt(id, month)
		n := OrgTreeNode{Id: u.ID, Name: u.Name, LevelId: u.LevelID, Children: make([]OrgTreeNode, 0, len(children))}
		for _, c := range children {
			n.Children = append(n.Children, build(c))
		}
		return n
	}
	roots := tree.RootsAt(month)
	out := OrgTree{Month: month.String(), Roots: make([]OrgTreeNode, 0, len(roots))}
	for _, r := range roots {
		out.Roots = append(out.Roots, build(r))
	}
	return GetOrgTree200JSONResponse(out), nil
}

// maxNoteBytes bounds a move's free-text note.
const maxNoteBytes = 1000

// trimKeys trims source-system names and reports blank ones. The result has
// the same length and order as in (blank entries stay "" and are errors), so
// indexes in later messages match the request.
func trimKeys(pr *problems, path string, in []string) []string {
	out := make([]string, len(in))
	for i, k := range in {
		out[i] = strings.TrimSpace(k)
		if out[i] == "" {
			pr.add(path+"["+strconv.Itoa(i)+"]", "must not be empty")
		}
	}
	return out
}
