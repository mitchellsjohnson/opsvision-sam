package domain

import "opsvision/internal/period"

// Level is one tier of the org hierarchy (for example Division or Team).
// Depth 0 is the root tier.
type Level struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Depth int    `json:"depth"`
}

// OrgUnit is a node in the org hierarchy.
type OrgUnit struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	LevelID     string         `json:"levelId"`
	ParentID    string         `json:"parentId"`
	SourceKeys  []string       `json:"sourceKeys"`
	RetiredFrom *period.Period `json:"retiredFrom,omitempty"`
}

// OrgMove reparents an org unit effective from a month.
type OrgMove struct {
	UnitID         string        `json:"unitId"`
	NewParentID    string        `json:"newParentId"`
	EffectiveMonth period.Period `json:"effectiveMonth"`
	Note           string        `json:"note"`
}

// ItemKind is a category of tracked item (for example Application).
type ItemKind struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// TrackedItem is a non-org subject that metrics can be reported against.
type TrackedItem struct {
	ID         string   `json:"id"`
	KindID     string   `json:"kindId"`
	Name       string   `json:"name"`
	OrgUnitID  string   `json:"orgUnitId"`
	SourceKeys []string `json:"sourceKeys"`
}
