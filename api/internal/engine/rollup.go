package engine

import (
	"math"
	"sort"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// NotApplicable is the reason reported when a value is not applicable and no
// single reason applies (none was given, or contributors disagree).
const NotApplicable = "Not applicable"

// Value is the result of aggregating a measure over a subject and a set of
// slots.
type Value struct {
	// V is the aggregated value. It is 0 when NAReason is set.
	V float64
	// Have is the number of slots that contributed a value.
	Have int
	// Expected is the number of slots requested.
	Expected int
	// NAReason is set (and V is 0) when no slot had a value but at least one
	// was not applicable.
	NAReason string
	// Direct is true iff every contributing slot used a data point entered
	// directly on the subject rather than a rollup of children/items.
	Direct bool
}

type pointKey struct {
	measure string
	subject string
	period  period.Period
}

// Index answers measure queries. It is read-only after NewIndex and safe for
// concurrent use.
type Index struct {
	cal  period.Calendar
	tree *orgtree.Tree
	// items holds every tracked item by ID.
	items map[string]domain.TrackedItem
	// itemsByUnit maps an org unit ID to the IDs of its attached tracked
	// items, sorted by ID so that results are deterministic.
	itemsByUnit map[string][]string
	// points holds one data point per (measure, subject, period).
	points map[pointKey]domain.DataPoint
	// overrides holds the winning manual override per (metric, subject,
	// period).
	overrides map[overrideKey]domain.Override
}

type overrideKey struct {
	metric  string
	subject string
	period  period.Period
}

// NewIndex indexes in.Data for O(1) lookup by (measure, subject, period).
//
// Data points for subjects that are neither org units in the tree nor tracked
// items are ignored, as are points whose value is NaN or infinite. If several
// points share a (measure, subject, period), the highest Revision wins, with
// ties broken by the latest EnteredAt (and then by input order, later first).
func NewIndex(in *Input) *Index {
	ix := &Index{
		items:       map[string]domain.TrackedItem{},
		itemsByUnit: map[string][]string{},
		points:      map[pointKey]domain.DataPoint{},
		overrides:   map[overrideKey]domain.Override{},
	}
	if in == nil {
		return ix
	}
	ix.cal = in.Cal
	ix.tree = in.Tree
	for _, it := range in.Items {
		if it.ID == "" {
			continue
		}
		if _, dup := ix.items[it.ID]; dup {
			continue
		}
		ix.items[it.ID] = it
		if it.OrgUnitID != "" {
			ix.itemsByUnit[it.OrgUnitID] = append(ix.itemsByUnit[it.OrgUnitID], it.ID)
		}
	}
	for _, ids := range ix.itemsByUnit {
		sort.Strings(ids)
	}
	for _, dp := range in.Data {
		if !ix.known(dp.SubjectID) {
			continue
		}
		if dp.Value != nil && (math.IsNaN(*dp.Value) || math.IsInf(*dp.Value, 0)) {
			continue
		}
		k := pointKey{dp.MeasureKey, dp.SubjectID, dp.Period}
		if prev, ok := ix.points[k]; ok && !supersedes(dp, prev) {
			continue
		}
		if dp.Value != nil {
			v := *dp.Value
			dp.Value = &v
		}
		ix.points[k] = dp
	}
	// If several overrides share a (metric, subject, period), the latest At
	// wins; on a tie the later one in input order.
	for _, ov := range in.Overrides {
		if ov.Value != nil {
			if math.IsNaN(*ov.Value) || math.IsInf(*ov.Value, 0) {
				ov.Value = nil
			} else {
				val := *ov.Value
				ov.Value = &val
			}
		}
		k := overrideKey{ov.MetricKey, ov.SubjectID, ov.Period}
		if prev, ok := ix.overrides[k]; ok && ov.At.Before(prev.At) {
			continue
		}
		ix.overrides[k] = ov
	}
	return ix
}

// supersedes reports whether a replaces b for the same key.
func supersedes(a, b domain.DataPoint) bool {
	if a.Revision != b.Revision {
		return a.Revision > b.Revision
	}
	return !a.EnteredAt.Before(b.EnteredAt)
}

func (ix *Index) isUnit(id string) bool {
	if ix.tree == nil {
		return false
	}
	_, ok := ix.tree.Unit(id)
	return ok
}

func (ix *Index) known(id string) bool {
	if id == "" {
		return false
	}
	_, isItem := ix.items[id]
	return isItem || ix.isUnit(id)
}

// Slots returns the periods of grain g whose constituent months all lie
// within months, in chronological order. For g == period.Month it returns a
// copy of months (in the order given). Non-month entries in months are
// ignored for coarser grains.
func Slots(cal period.Calendar, g period.Grain, months []period.Period) []period.Period {
	if g == period.Month {
		return append([]period.Period(nil), months...)
	}
	have := make(map[period.Period]bool, len(months))
	for _, m := range months {
		if m.Grain == period.Month {
			have[m] = true
		}
	}
	seen := map[period.Period]bool{}
	var out []period.Period
	for _, m := range months {
		if m.Grain != period.Month || m.Index < 1 || m.Index > 12 {
			continue
		}
		p := cal.Parent(m, g)
		if seen[p] {
			continue
		}
		seen[p] = true
		whole := true
		ms := cal.Months(p)
		if len(ms) == 0 {
			continue
		}
		for _, pm := range ms {
			if !have[pm] {
				whole = false
				break
			}
		}
		if whole {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FY != out[j].FY {
			return out[i].FY < out[j].FY
		}
		return out[i].Index < out[j].Index
	})
	return out
}

// state of a slot value.
type state int

const (
	stNone  state = iota // no data
	stValue              // has a numeric value
	stNA                 // only not-applicable data
)

// slotVal is the value of one subject in one slot.
type slotVal struct {
	st     state
	v      float64
	na     string
	direct bool
	// at is the EnteredAt of the data behind the value (the newest, if
	// several); used by OrgAgg latest.
	at time.Time
}

// Measure aggregates measure m for subjectID over slots.
//
// slots are periods at the data's grain (months for monthly data, quarters for
// quarterly data); callers build them with Slots. For each slot the value is
// the data point entered directly on the subject for exactly that period if
// there is one (a not-applicable point makes the slot not applicable);
// otherwise it is m.OrgAgg over the subject's children as of the slot's last
// month — plus, when rollItems is true, the tracked items attached to the
// subject — each computed the same way. OrgAgg none disables rollup, so only
// direct values count. Children with no data are skipped; not-applicable
// children are skipped unless all contributors are not applicable.
//
// OrgAgg latest picks the contributor with the most recent EnteredAt; this is
// not meaningful across an org and exists for completeness.
//
// Slot values then combine with m.TimeAgg (latest = last slot with a value;
// average = mean of slots with a value). Not-applicable slots are excluded.
// TimeAgg none yields a value only for a single slot.
//
// ok is false when subjectID is unknown or no slot has any data. When no slot
// has a value but some are not applicable, the Value carries NAReason.
func (ix *Index) Measure(m domain.Measure, subjectID string, slots []period.Period, rollItems bool) (Value, bool) {
	if !ix.known(subjectID) || len(slots) == 0 {
		return Value{}, false
	}
	vals := make([]slotVal, 0, len(slots))
	for _, s := range slots {
		sv := ix.slotValue(m, subjectID, s, rollItems)
		if sv.st != stNone {
			vals = append(vals, sv)
		}
	}
	if len(vals) == 0 {
		return Value{}, false
	}
	agg := m.TimeAgg
	if agg == domain.AggNone && len(slots) == 1 {
		agg = domain.AggSum
	}
	out := combine(agg, vals, true)
	if out.st == stNone {
		return Value{}, false
	}
	res := Value{Expected: len(slots)}
	if out.st == stNA {
		res.NAReason = out.na
		return res, true
	}
	res.V = out.v
	res.Direct = out.direct
	for _, sv := range vals {
		if sv.st == stValue {
			res.Have++
		}
	}
	return res, true
}

// slotValue computes the value of subject in one slot.
func (ix *Index) slotValue(m domain.Measure, subject string, slot period.Period, rollItems bool) slotVal {
	if sv, ok := ix.direct(m.Key, subject, slot); ok {
		return sv
	}
	if _, isItem := ix.items[subject]; isItem && !ix.isUnit(subject) {
		return slotVal{} // tracked items have no children
	}
	switch m.OrgAgg {
	case domain.AggSum, domain.AggMin, domain.AggMax, domain.AggAverage, domain.AggLatest:
	default:
		return slotVal{} // none (or invalid): no rollup
	}
	months := ix.cal.Months(slot)
	if len(months) == 0 || ix.tree == nil {
		return slotVal{}
	}
	last := months[len(months)-1]
	children := ix.tree.ChildrenAt(subject, last)
	var contrib []slotVal
	for _, c := range children {
		if sv := ix.slotValue(m, c, slot, rollItems); sv.st != stNone {
			contrib = append(contrib, sv)
		}
	}
	if rollItems {
		for _, id := range ix.itemsByUnit[subject] {
			if sv, ok := ix.direct(m.Key, id, slot); ok {
				contrib = append(contrib, sv)
			}
		}
	}
	if len(contrib) == 0 {
		return slotVal{}
	}
	out := combine(m.OrgAgg, contrib, false)
	out.direct = false
	return out
}

// direct returns the data point entered on subject for exactly slot.
func (ix *Index) direct(measure, subject string, slot period.Period) (slotVal, bool) {
	dp, ok := ix.points[pointKey{measure, subject, slot}]
	if !ok {
		return slotVal{}, false
	}
	if dp.Value == nil {
		reason := dp.NAReason
		if reason == "" {
			reason = NotApplicable
		}
		return slotVal{st: stNA, na: reason, direct: true, at: dp.EnteredAt}, true
	}
	return slotVal{st: stValue, v: *dp.Value, direct: true, at: dp.EnteredAt}, true
}

// combine aggregates vals (none of which is stNone) with agg. Values win over
// not-applicable entries; if there are no values the result is not
// applicable, with the shared reason or NotApplicable when reasons differ.
// byOrder selects what AggLatest means: the last entry (time) or the entry
// with the newest EnteredAt (org). The result is Direct only if every value
// that contributed was direct.
func combine(agg domain.Agg, vals []slotVal, byOrder bool) slotVal {
	var nums []slotVal
	var nas []slotVal
	for _, sv := range vals {
		switch sv.st {
		case stValue:
			nums = append(nums, sv)
		case stNA:
			nas = append(nas, sv)
		}
	}
	if len(nums) == 0 {
		if len(nas) == 0 {
			return slotVal{}
		}
		reason := nas[0].na
		for _, n := range nas[1:] {
			if n.na != reason {
				reason = NotApplicable
				break
			}
		}
		return slotVal{st: stNA, na: reason}
	}
	out := slotVal{st: stValue, direct: true}
	for _, sv := range nums {
		if !sv.direct {
			out.direct = false
		}
		if sv.at.After(out.at) {
			out.at = sv.at
		}
	}
	switch agg {
	case domain.AggSum, domain.AggAverage:
		var sum float64
		for _, sv := range nums {
			sum += sv.v
		}
		if agg == domain.AggAverage {
			sum /= float64(len(nums))
		}
		out.v = sum
	case domain.AggMin:
		out.v = nums[0].v
		for _, sv := range nums[1:] {
			out.v = math.Min(out.v, sv.v)
		}
	case domain.AggMax:
		out.v = nums[0].v
		for _, sv := range nums[1:] {
			out.v = math.Max(out.v, sv.v)
		}
	case domain.AggLatest:
		pick := nums[len(nums)-1]
		if !byOrder {
			pick = nums[0]
			for _, sv := range nums[1:] {
				if sv.at.After(pick.at) {
					pick = sv
				}
			}
		}
		out.v = pick.v
	default:
		return slotVal{} // none or invalid aggregation: nothing to combine
	}
	return out
}
