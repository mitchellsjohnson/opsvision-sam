// Package domain defines the shared vocabulary of OpsVision: tenants, org
// structure, methodology, and data. It holds types and methodology validation
// only; persistence, calculation, and transport live in other packages.
package domain

import "time"

// Role is a member's permission level within a tenant.
type Role string

// Supported roles.
const (
	RoleAdmin       Role = "admin"
	RoleContributor Role = "contributor"
	RoleViewer      Role = "viewer"
)

// Valid reports whether r is a known role.
func (r Role) Valid() bool {
	switch r {
	case RoleAdmin, RoleContributor, RoleViewer:
		return true
	}
	return false
}

// StatusLevel is one level of a tenant's status scale (for example Green).
// A higher Rank is worse.
type StatusLevel struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Color string `json:"color"`
	Rank  int    `json:"rank"`
}

// DefaultStatusScale returns the standard green/yellow/red scale.
func DefaultStatusScale() []StatusLevel {
	return []StatusLevel{
		{Key: "G", Label: "Green", Color: "#137A3A", Rank: 1},
		{Key: "Y", Label: "Yellow", Color: "#8A5A00", Rank: 2},
		{Key: "R", Label: "Red", Color: "#B42318", Rank: 3},
	}
}

// Tenant is an isolated customer workspace.
type Tenant struct {
	ID                   string        `json:"id"`
	Name                 string        `json:"name"`
	Auth0OrgID           string        `json:"auth0OrgId"`
	FiscalYearStartMonth time.Month    `json:"fiscalYearStartMonth"`
	StatusScale          []StatusLevel `json:"statusScale"`
	DefaultRole          Role          `json:"defaultRole"`
	CreatedAt            time.Time     `json:"createdAt"`
}

// Scope restricts what a membership can see or edit. An empty list means
// everything.
type Scope struct {
	OrgUnitIDs []string `json:"orgUnitIds"`
	MetricKeys []string `json:"metricKeys"`
}

// Membership grants a user a role within a tenant.
type Membership struct {
	UserID    string    `json:"userId"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      Role      `json:"role"`
	Scope     Scope     `json:"scope"`
	CreatedAt time.Time `json:"createdAt"`
}
