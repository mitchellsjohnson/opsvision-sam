// Package engine computes measure and metric values from raw data points.
//
// Raw measures are entered at org units and tracked items. The engine rolls
// them up the org tree (using the tree as it was in each period) and then
// over time, producing the numbers that scorecards display.
package engine

import (
	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// Input is everything the engine needs to compute values for one tenant.
// It is read once by NewIndex; callers must not mutate the referenced slices
// while an Index built from it is in use.
type Input struct {
	Cal       period.Calendar
	Tree      *orgtree.Tree
	Items     []domain.TrackedItem
	Versions  []domain.MethodologyVersion
	Data      []domain.DataPoint
	Overrides []domain.Override
}
