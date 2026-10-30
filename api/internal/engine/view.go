package engine

import (
	"fmt"
	"sort"

	"opsvision/internal/domain"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
)

// Structure values for ViewRequest.Structure.
const (
	// StructureAsOf shows each period under the org structure of that period.
	StructureAsOf = "as_of"
	// StructureCurrent shows all periods under the structure at the latest
	// month in the view, as if today's org had always existed.
	StructureCurrent = "current"
)

// Cell reasons for columns that cannot show a metric.
const (
	reasonNoMethodology = "No methodology in force"
	reasonNotMeasured   = "Not measured under "
)

// ViewRequest selects what a scorecard view contains.
type ViewRequest struct {
	// Periods are the columns to show, of any grain.
	Periods []period.Period
	// YTD are fiscal year-to-date columns, each given by the month it runs
	// through. They follow the Periods columns.
	YTD []period.Period
	// SubjectIDs, when non-empty, keeps only rows for the listed subjects.
	SubjectIDs []string
	// Restate is a methodology version ID (any status) used for every
	// column; "" selects the version in force for each column.
	Restate string
	// Structure is "as_of" (or "", the default) or "current".
	Structure string
}

// Row is one metric for one subject across all columns. Cells holds one cell
// per ViewRequest.Periods entry, then one per ViewRequest.YTD entry.
type Row struct {
	MetricKey   string
	MetricName  string
	CategoryID  string
	SubjectID   string
	SubjectName string
	Format      string
	// Depth is indentation: distance from the root for org units; for
	// tracked items one more than the unit they are attached to, or 0 when
	// unattached.
	Depth     int
	Direction domain.Direction
	Cells     []Cell
}

// View is the table a scorecard renders.
type View struct {
	Periods    []period.Period
	YTD        []period.Period
	Categories []domain.Category
	Rows       []Row
	// VersionByPeriod maps each column to the ID of the methodology version
	// it was computed under: the period's String() for Periods columns and
	// "YTD:<through>" for YTD columns. Columns with no version are omitted.
	VersionByPeriod map[string]string
}

// column is one computed column of a view.
type column struct {
	p   period.Period
	ytd bool
	key string
	// last is the last month the column covers; lastOK is false for an
	// invalid period.
	last   period.Period
	lastOK bool
	// ver indexes viewState.used, or -1 when no version applies.
	ver int
}

// Compute builds the scorecard for req: metrics x subjects x columns. Each
// column is computed under the methodology version in force at its last
// month (or the Restate version), against the org structure of its months
// (or the current structure). Nothing stored is modified, so a restated view
// leaves the as-published view unchanged.
func Compute(in *Input, req ViewRequest) (View, error) {
	switch req.Structure {
	case "", StructureAsOf, StructureCurrent:
	default:
		return View{}, fmt.Errorf("engine: invalid structure %q (want %q or %q)", req.Structure, StructureAsOf, StructureCurrent)
	}
	if in == nil {
		in = &Input{}
	}
	var restate *domain.MethodologyVersion
	if req.Restate != "" {
		for i := range in.Versions {
			if in.Versions[i].ID == req.Restate {
				restate = &in.Versions[i]
				break
			}
		}
		if restate == nil {
			return View{}, fmt.Errorf("engine: unknown methodology version %q", req.Restate)
		}
	}

	cal := in.Cal
	view := View{
		Periods:         append([]period.Period(nil), req.Periods...),
		YTD:             append([]period.Period(nil), req.YTD...),
		VersionByPeriod: map[string]string{},
	}

	// Columns, and the version each is computed under.
	var cols []column
	for _, p := range req.Periods {
		cols = append(cols, newColumn(cal, p, false))
	}
	for _, p := range req.YTD {
		cols = append(cols, newColumn(cal, p, true))
	}
	var used []domain.MethodologyVersion
	usedAt := map[string]int{}
	use := func(v domain.MethodologyVersion) int {
		if i, ok := usedAt[v.ID]; ok {
			return i
		}
		used = append(used, v)
		usedAt[v.ID] = len(used) - 1
		return len(used) - 1
	}
	latest := -1
	for i := range cols {
		c := &cols[i]
		c.ver = -1
		switch {
		case restate != nil:
			c.ver = use(*restate)
		case c.lastOK:
			if v, ok := VersionFor(in.Versions, c.last, cal); ok {
				c.ver = use(v)
			}
		}
		if c.ver >= 0 {
			view.VersionByPeriod[c.key] = used[c.ver].ID
		}
		if c.lastOK && (latest < 0 || monthOrdinal(c.last) > monthOrdinal(cols[latest].last)) {
			latest = i
		}
	}
	if latest < 0 {
		return view, nil // no valid columns: nothing to show
	}
	asOfMonth := cols[latest].last

	// The org structure the whole view is computed against.
	tree := in.Tree
	if req.Structure == StructureCurrent && tree != nil {
		cur, err := currentTree(tree, asOfMonth)
		if err != nil {
			return View{}, err
		}
		tree = cur
	}
	calcIn := *in
	calcIn.Tree = tree
	ix := NewIndex(&calcIn)

	// Which version supplies each metric's row metadata (and each category's
	// definition): the latest column's version if it has it, else the most
	// recent used version that does.
	primary := cols[latest].ver
	pick := func(has func(domain.MethodologyVersion) bool) int {
		if primary >= 0 && has(used[primary]) {
			return primary
		}
		best := -1
		for i, v := range used {
			if has(v) && (best < 0 || newerVersion(cal, v, used[best])) {
				best = i
			}
		}
		return best
	}

	metricsBy := make([]map[string]domain.Metric, len(used))
	for i, v := range used {
		metricsBy[i] = make(map[string]domain.Metric, len(v.Content.Metrics))
		for _, m := range v.Content.Metrics {
			if _, dup := metricsBy[i][m.Key]; !dup {
				metricsBy[i][m.Key] = m
			}
		}
	}

	// Rows are the union of metrics across the versions used.
	type metricRef struct {
		m    domain.Metric
		meta int
	}
	var keys []string
	seenKey := map[string]bool{}
	for _, v := range used {
		for _, m := range v.Content.Metrics {
			if !seenKey[m.Key] {
				seenKey[m.Key] = true
				keys = append(keys, m.Key)
			}
		}
	}
	refs := make(map[string]metricRef, len(keys))
	for _, k := range keys {
		meta := pick(func(v domain.MethodologyVersion) bool {
			for _, m := range v.Content.Metrics {
				if m.Key == k {
					return true
				}
			}
			return false
		})
		refs[k] = metricRef{m: metricsBy[meta][k], meta: meta}
	}

	// Categories: union by ID, defined by the same selection rule.
	var catIDs []string
	seenCat := map[string]bool{}
	for _, v := range used {
		for _, c := range v.Content.Categories {
			if !seenCat[c.ID] {
				seenCat[c.ID] = true
				catIDs = append(catIDs, c.ID)
			}
		}
	}
	catByID := make(map[string]domain.Category, len(catIDs))
	for _, id := range catIDs {
		i := pick(func(v domain.MethodologyVersion) bool {
			for _, c := range v.Content.Categories {
				if c.ID == id {
					return true
				}
			}
			return false
		})
		for _, c := range used[i].Content.Categories {
			if c.ID == id {
				catByID[id] = c
				break
			}
		}
	}
	for _, c := range catByID {
		view.Categories = append(view.Categories, c)
	}
	sort.Slice(view.Categories, func(i, j int) bool {
		a, b := view.Categories[i], view.Categories[j]
		if a.Order != b.Order {
			return a.Order < b.Order
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ID < b.ID
	})
	catRank := make(map[string]int, len(view.Categories))
	for i, c := range view.Categories {
		catRank[c.ID] = i
	}

	// Order metrics: category, then position in the primary version's metric
	// list, then (for metrics it lacks) key order.
	pos := map[string]int{}
	if primary >= 0 {
		for i, m := range used[primary].Content.Metrics {
			if _, ok := pos[m.Key]; !ok {
				pos[m.Key] = i
			}
		}
	}
	rank := func(cat string) int {
		if r, ok := catRank[cat]; ok {
			return r
		}
		return len(catRank) // unknown category sorts last
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, b := refs[keys[i]].m, refs[keys[j]].m
		if ra, rb := rank(a.CategoryID), rank(b.CategoryID); ra != rb {
			return ra < rb
		}
		if a.CategoryID != b.CategoryID {
			return a.CategoryID < b.CategoryID // both unknown categories
		}
		pa, oka := pos[a.Key]
		pb, okb := pos[b.Key]
		switch {
		case oka && okb:
			return pa < pb
		case oka != okb:
			return oka
		}
		return a.Key < b.Key
	})

	org := listOrg(tree, asOfMonth)
	keep := map[string]bool{}
	for _, id := range req.SubjectIDs {
		keep[id] = true
	}

	type rowSpec struct {
		key string
		s   subject
	}
	var specs []rowSpec
	for _, k := range keys {
		for _, s := range subjectsFor(refs[k].m, org, in.Items) {
			if len(keep) > 0 && !keep[s.id] {
				continue
			}
			specs = append(specs, rowSpec{k, s})
		}
	}
	ix.reserve(len(specs) * len(cols))
	view.Rows = make([]Row, 0, len(specs))
	// All cells share one backing array: one allocation instead of one per row.
	cells := make([]Cell, len(specs)*len(cols))
	for i, sp := range specs {
		ref := refs[sp.key]
		row := Row{
			MetricKey: sp.key, MetricName: ref.m.Name, CategoryID: ref.m.CategoryID,
			SubjectID: sp.s.id, SubjectName: sp.s.name, Format: ref.m.Format,
			Depth: sp.s.depth, Direction: ref.m.Direction,
			Cells: cells[i*len(cols) : (i+1)*len(cols) : (i+1)*len(cols)],
		}
		for j, c := range cols {
			row.Cells[j] = cellFor(ix, c, used, metricsBy, sp.key, sp.s.id)
		}
		view.Rows = append(view.Rows, row)
	}
	return view, nil
}

func newColumn(cal period.Calendar, p period.Period, ytd bool) column {
	c := column{p: p, ytd: ytd, key: p.String()}
	if ytd {
		c.key = "YTD:" + p.String()
	}
	if ms := cal.Months(p); len(ms) > 0 {
		c.last, c.lastOK = ms[len(ms)-1], true
	}
	return c
}

// cellFor computes one cell, or a placeholder when the column's version does
// not apply or does not define the metric.
func cellFor(ix *Index, c column, used []domain.MethodologyVersion, metricsBy []map[string]domain.Metric, key, subject string) Cell {
	if c.ver < 0 {
		return Cell{MetricKey: key, SubjectID: subject, Period: c.p, YTD: c.ytd, NAReason: reasonNoMethodology}
	}
	v := used[c.ver]
	m, ok := metricsBy[c.ver][key]
	if !ok {
		return Cell{MetricKey: key, SubjectID: subject, Period: c.p, YTD: c.ytd, VersionID: v.ID, NAReason: reasonNotMeasured + v.Name}
	}
	if c.ytd {
		return ix.CellYTD(v, m, subject, c.p)
	}
	return ix.Cell(v, m, subject, c.p)
}

// subject is one row subject.
type subject struct {
	id, name string
	depth    int
}

// orgListing is the org tree flattened in pre-order as of one month.
type orgListing struct {
	units  []subject
	level  map[string]string // unit ID -> level ID
	parent map[string]string // unit ID -> parent ID ("" for roots)
	depth  map[string]int
}

func listOrg(tree *orgtree.Tree, at period.Period) orgListing {
	l := orgListing{level: map[string]string{}, parent: map[string]string{}, depth: map[string]int{}}
	if tree == nil {
		return l
	}
	var walk func(id, parent string, depth int)
	walk = func(id, parent string, depth int) {
		u, ok := tree.Unit(id)
		if !ok {
			return
		}
		l.units = append(l.units, subject{id: id, name: u.Name, depth: depth})
		l.level[id], l.parent[id], l.depth[id] = u.LevelID, parent, depth
		for _, c := range tree.ChildrenAt(id, at) {
			walk(c, id, depth+1)
		}
	}
	for _, r := range tree.RootsAt(at) {
		walk(r, "", 0)
	}
	return l
}

// subjectsFor lists the rows for metric m: org units at its reported levels
// plus their ancestors in tree order, then tracked items of its reported
// kinds.
func subjectsFor(m domain.Metric, org orgListing, items []domain.TrackedItem) []subject {
	levels, kinds := map[string]bool{}, map[string]bool{}
	for _, s := range m.ReportedAt {
		switch s.Kind {
		case domain.SubjectLevel:
			levels[s.ID] = true
		case domain.SubjectItemKind:
			kinds[s.ID] = true
		}
	}
	include := map[string]bool{}
	for _, u := range org.units {
		if !levels[org.level[u.id]] {
			continue
		}
		for id := u.id; id != "" && !include[id]; id = org.parent[id] {
			include[id] = true
		}
	}
	var out []subject
	for _, u := range org.units {
		if include[u.id] {
			out = append(out, u)
		}
	}
	var its []domain.TrackedItem
	for _, it := range items {
		if kinds[it.KindID] {
			its = append(its, it)
		}
	}
	sort.SliceStable(its, func(i, j int) bool {
		a, b := its[i], its[j]
		if a.KindID != b.KindID {
			return a.KindID < b.KindID
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ID < b.ID
	})
	for _, it := range its {
		depth := 0
		if d, ok := org.depth[it.OrgUnitID]; ok && it.OrgUnitID != "" {
			depth = d + 1
		}
		out = append(out, subject{id: it.ID, name: it.Name, depth: depth})
	}
	return out
}

// currentTree returns a tree with no moves in which every unit has the parent
// it has at month at. Units not active at that month keep their original
// parent.
func currentTree(tree *orgtree.Tree, at period.Period) (*orgtree.Tree, error) {
	var units []domain.OrgUnit
	collect := func(id string) {
		u, ok := tree.Unit(id)
		if !ok {
			return
		}
		if tree.ActiveAt(id, at) {
			if p, ok := tree.ParentAt(id, at); ok {
				u.ParentID = p
			}
		}
		units = append(units, u)
	}
	for _, id := range tree.UnitIDs() {
		collect(id)
	}
	cur, err := orgtree.New(units, nil)
	if err != nil {
		return nil, fmt.Errorf("engine: current org structure: %w", err)
	}
	return cur, nil
}
