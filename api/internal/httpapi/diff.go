package httpapi

import (
	"bytes"
	"encoding/json"
	"slices"

	"opsvision/internal/domain"
)

// Diff is the difference between two methodologies, by metric key.
type Diff struct {
	// Added lists metric keys present only in the second methodology, sorted.
	Added []string
	// Removed lists metric keys present only in the first, sorted.
	Removed []string
	// Changed lists metrics present in both whose compared fields differ,
	// sorted by key.
	Changed []MetricChange
}

// MetricChange is the set of differing fields of one metric.
type MetricChange struct {
	Key    string
	Fields []FieldChange
}

// FieldChange is one differing field. From and To are JSON-serializable: a
// string for scalar fields, a domain.StatusRule for "rule", and a
// []domain.Target for "targets".
type FieldChange struct {
	Field    string
	From, To any
}

// metricField reads one compared field of a metric. The value is what a
// FieldChange carries; the same value is compared by its JSON encoding, so a
// nil slice and an empty one are the same.
type metricField struct {
	name string
	get  func(domain.Metric) any
}

// metricFields lists the compared fields in report order. Categories,
// measures, and the remaining metric fields (notes, example, link,
// reportedAt, rollItemsToOrg) are not part of the comparison.
var metricFields = []metricField{
	{"name", func(m domain.Metric) any { return m.Name }},
	{"category", func(m domain.Metric) any { return m.CategoryID }},
	{"formula", func(m domain.Metric) any { return m.Formula }},
	{"direction", func(m domain.Metric) any { return string(m.Direction) }},
	{"frequency", func(m domain.Metric) any { return string(m.Frequency) }},
	{"format", func(m domain.Metric) any { return m.Format }},
	{"rule", func(m domain.Metric) any { return m.Rule }},
	{"targets", func(m domain.Metric) any {
		if m.Targets == nil {
			return []domain.Target{}
		}
		return m.Targets
	}},
	{"definition", func(m domain.Metric) any { return m.Definition }},
	{"source", func(m domain.Metric) any { return m.Source }},
}

// DiffMethodology compares the metrics of a and b. It reports the metrics b
// adds and removes relative to a, and for each metric in both which of the
// compared fields (name, category, formula, direction, frequency, format,
// rule, targets, definition, source) differ. The result's slices are never
// nil.
func DiffMethodology(a, b domain.Methodology) Diff {
	d := Diff{Added: []string{}, Removed: []string{}, Changed: []MetricChange{}}
	am, bm := metricsByKey(a), metricsByKey(b)

	for key := range bm {
		if _, ok := am[key]; !ok {
			d.Added = append(d.Added, key)
		}
	}
	for key, was := range am {
		is, ok := bm[key]
		if !ok {
			d.Removed = append(d.Removed, key)
			continue
		}
		var fields []FieldChange
		for _, f := range metricFields {
			from, to := f.get(was), f.get(is)
			if !sameJSON(from, to) {
				fields = append(fields, FieldChange{Field: f.name, From: from, To: to})
			}
		}
		if len(fields) > 0 {
			d.Changed = append(d.Changed, MetricChange{Key: key, Fields: fields})
		}
	}
	slices.Sort(d.Added)
	slices.Sort(d.Removed)
	slices.SortFunc(d.Changed, func(x, y MetricChange) int {
		switch {
		case x.Key < y.Key:
			return -1
		case x.Key > y.Key:
			return 1
		}
		return 0
	})
	return d
}

// metricsByKey indexes a methodology's metrics. For a duplicate key (an
// invalid methodology) the first metric wins.
func metricsByKey(m domain.Methodology) map[string]domain.Metric {
	out := make(map[string]domain.Metric, len(m.Metrics))
	for _, mt := range m.Metrics {
		if _, dup := out[mt.Key]; !dup {
			out[mt.Key] = mt
		}
	}
	return out
}

// sameJSON reports whether two values encode to the same JSON. Values that
// cannot be encoded compare as different.
func sameJSON(a, b any) bool {
	ab, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bb, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return bytes.Equal(ab, bb)
}

// apiDiff renders a Diff as the API's list of path-addressed changes: added
// metrics, then removed ones, then field changes, each group sorted by key.
// A path looks like metrics[closure_rate] or metrics[closure_rate].rule.
// from and to are the version IDs compared; was and is index the metrics of
// the first and second methodology.
func apiDiff(from, to string, d Diff, was, is map[string]domain.Metric) VersionDiff {
	out := VersionDiff{From: from, To: to, Changes: []VersionChange{}}
	for _, key := range d.Added {
		out.Changes = append(out.Changes, VersionChange{
			Path: "metrics[" + key + "]", Kind: Added, After: apiMetric(is[key]),
		})
	}
	for _, key := range d.Removed {
		out.Changes = append(out.Changes, VersionChange{
			Path: "metrics[" + key + "]", Kind: Removed, Before: apiMetric(was[key]),
		})
	}
	for _, c := range d.Changed {
		for _, f := range c.Fields {
			out.Changes = append(out.Changes, VersionChange{
				Path: "metrics[" + c.Key + "]." + f.Field, Kind: Changed, Before: f.From, After: f.To,
			})
		}
	}
	return out
}
