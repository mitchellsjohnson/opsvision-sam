package domain

// Layout is a scorecard overview layout with optimistic concurrency.
type Layout struct {
	Items    []LayoutItem
	Revision int
}

// LayoutItem is one tile on the overview grid. IDs are opaque (metrics,
// sections, widgets). Size is "small" or "wide".
type LayoutItem struct {
	ID     string
	Size   string
	Hidden bool
}
