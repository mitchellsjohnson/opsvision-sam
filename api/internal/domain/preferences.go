package domain

// UserPreferences are one user's personal settings in one tenant.
// DefaultScope is an org unit ID; empty means the whole company.
type UserPreferences struct {
	DefaultScope string
}
