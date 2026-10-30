package httpapi

import "opsvision/internal/domain"

// This file converts between domain types and generated API types. Response
// arrays and objects the contract marks required are never null: every slice
// that leaves through this layer is built non-nil.

func apiTenant(t domain.Tenant) Tenant {
	scale := make([]StatusLevel, 0, len(t.StatusScale))
	for _, l := range t.StatusScale {
		scale = append(scale, StatusLevel{Key: l.Key, Label: l.Label, Color: l.Color, Rank: l.Rank})
	}
	return Tenant{
		Id:                   t.ID,
		Name:                 t.Name,
		Auth0OrgId:           t.Auth0OrgID,
		FiscalYearStartMonth: int(t.FiscalYearStartMonth),
		StatusScale:          scale,
		DefaultRole:          Role(t.DefaultRole),
		CreatedAt:            t.CreatedAt,
	}
}

func apiScope(s domain.Scope) Scope {
	return Scope{
		OrgUnitIds: append([]Id{}, s.OrgUnitIDs...),
		MetricKeys: append([]Key{}, s.MetricKeys...),
	}
}

func domainScope(s Scope) domain.Scope {
	return domain.Scope{
		OrgUnitIDs: append([]string{}, s.OrgUnitIds...),
		MetricKeys: append([]string{}, s.MetricKeys...),
	}
}

func apiMembership(m domain.Membership) Membership {
	return Membership{
		UserId:    m.UserID,
		Email:     m.Email,
		Name:      m.Name,
		Role:      Role(m.Role),
		Scope:     apiScope(m.Scope),
		CreatedAt: m.CreatedAt,
	}
}

func apiMemberships(ms []domain.Membership) []Membership {
	out := make([]Membership, 0, len(ms))
	for _, m := range ms {
		out = append(out, apiMembership(m))
	}
	return out
}

func apiLevel(l domain.Level) Level {
	return Level{Id: l.ID, Name: l.Name, Depth: l.Depth}
}

func apiLevels(ls []domain.Level) []Level {
	out := make([]Level, 0, len(ls))
	for _, l := range ls {
		out = append(out, apiLevel(l))
	}
	return out
}

func apiOrgUnit(u domain.OrgUnit) OrgUnit {
	out := OrgUnit{
		Id:         u.ID,
		Name:       u.Name,
		LevelId:    u.LevelID,
		ParentId:   u.ParentID,
		SourceKeys: append([]string{}, u.SourceKeys...),
	}
	if u.RetiredFrom != nil {
		s := u.RetiredFrom.String()
		out.RetiredFrom = &s
	}
	return out
}

func apiOrgUnits(us []domain.OrgUnit) []OrgUnit {
	out := make([]OrgUnit, 0, len(us))
	for _, u := range us {
		out = append(out, apiOrgUnit(u))
	}
	return out
}

func apiOrgMove(m domain.OrgMove) OrgMove {
	return OrgMove{
		UnitId:         m.UnitID,
		NewParentId:    m.NewParentID,
		EffectiveMonth: m.EffectiveMonth.String(),
		Note:           m.Note,
	}
}
