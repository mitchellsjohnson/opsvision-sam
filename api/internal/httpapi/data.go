package httpapi

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/orgtree"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Limits on data entry.
const (
	maxBatchWrites   = 500
	maxNAReasonRunes = 200
	maxReasonRunes   = 1000
	// maxPreviewPeriods bounds how many distinct periods one preview
	// recomputes: its cost grows with periods x affected subjects.
	maxPreviewPeriods = 24
	// A fiscal-year label outside this range is a typo, not a period.
	minFiscalYear = 1970
	maxFiscalYear = 2200
)

func indexPath(name string, i int) string { return fmt.Sprintf("%s[%d]", name, i) }

// parsePeriod parses a client-supplied period and records a problem under
// path when it is malformed or implausible.
func parsePeriod(pr *problems, path, s string) (period.Period, bool) {
	p, err := period.Parse(s)
	if err != nil || p.FY < minFiscalYear || p.FY > maxFiscalYear {
		pr.add(path, "must be a period such as 2026-M07, 2026-Q3, 2026-H1, or 2026-FY (fiscal years %d-%d)", minFiscalYear, maxFiscalYear)
		return period.Period{}, false
	}
	return p, true
}

// ---- methodology lookups -------------------------------------------------------

// versionIndex answers "which metrics use this measure" for one version.
type versionIndex struct {
	v          domain.MethodologyVersion
	measureIdx map[string]int
	// uses maps a measure key to the keys of the metrics whose formula
	// references it, in metric order.
	uses map[string][]string
	// idents maps a metric key to the measures its formula references that
	// the version defines, sorted.
	idents map[string][]string
}

func newVersionIndex(v domain.MethodologyVersion) *versionIndex {
	vi := &versionIndex{
		v:          v,
		measureIdx: make(map[string]int, len(v.Content.Measures)),
		uses:       map[string][]string{},
		idents:     map[string][]string{},
	}
	for i, m := range v.Content.Measures {
		if _, dup := vi.measureIdx[m.Key]; !dup {
			vi.measureIdx[m.Key] = i
		}
	}
	for _, m := range v.Content.Metrics {
		ids, err := formula.Identifiers(m.Formula)
		if err != nil {
			continue // an uncomputable metric uses nothing
		}
		for _, id := range ids {
			if _, ok := vi.measureIdx[id]; !ok {
				continue
			}
			vi.uses[id] = append(vi.uses[id], m.Key)
			vi.idents[m.Key] = append(vi.idents[m.Key], id)
		}
	}
	return vi
}

func (vi *versionIndex) hasMetric(key string) bool {
	for _, m := range vi.v.Content.Metrics {
		if m.Key == key {
			return true
		}
	}
	return false
}

// versionLookup finds the methodology version in force for a period, caching
// the per-version indexes for the life of one request.
type versionLookup struct {
	in    *engine.Input
	cache map[string]*versionIndex
}

func newVersionLookup(in *engine.Input) *versionLookup {
	return &versionLookup{in: in, cache: map[string]*versionIndex{}}
}

func (l *versionLookup) at(p period.Period) (*versionIndex, bool) {
	v, ok := engine.VersionFor(l.in.Versions, p, l.in.Cal)
	if !ok {
		return nil, false
	}
	if vi, ok := l.cache[v.ID]; ok {
		return vi, true
	}
	vi := newVersionIndex(v)
	l.cache[v.ID] = vi
	return vi, true
}

// ---- authorization ---------------------------------------------------------------

// access answers data:read and data:write questions about subjects, which are
// org units or tracked items.
type access struct {
	p     auth.Principal
	tree  *orgtree.Tree
	items map[string]domain.TrackedItem
}

func newAccess(p auth.Principal, in *engine.Input) *access {
	a := &access{p: p, tree: in.Tree, items: make(map[string]domain.TrackedItem, len(in.Items))}
	for _, it := range in.Items {
		a.items[it.ID] = it
	}
	return a
}

// unitOf resolves a subject to the org unit its data belongs to: the unit
// itself, or the unit an item is attached to ("" for an unattached item). The
// bool is false for an unknown subject.
func (a *access) unitOf(subjectID string) (string, bool) {
	if _, ok := a.tree.Unit(subjectID); ok {
		return subjectID, true
	}
	if it, ok := a.items[subjectID]; ok {
		return it.OrgUnitID, true
	}
	return "", false
}

func (a *access) canRead(subjectID string, metricKeys []string, month period.Period) bool {
	return a.allowed(auth.ActionDataRead, subjectID, metricKeys, month)
}

func (a *access) canWrite(subjectID string, metricKeys []string, month period.Period) bool {
	return a.allowed(auth.ActionDataWrite, subjectID, metricKeys, month)
}

// allowed applies action to a subject for any of metricKeys, as of month.
//
//   - An unattached item belongs to no org unit, so scope cannot cover it:
//     admins may do anything with it, contributors may read it, nobody else
//     may do anything.
//   - Scope by metric key needs at least one in-scope metric. With no metric
//     (a measure no formula uses) a caller whose scope names metrics is
//     denied, except a contributor reading, which is unrestricted.
func (a *access) allowed(action auth.Action, subjectID string, metricKeys []string, month period.Period) bool {
	m := a.p.Membership
	if m == nil {
		return false
	}
	unit, known := a.unitOf(subjectID)
	if !known {
		return false
	}
	if m.Role == domain.RoleAdmin {
		return true
	}
	if unit == "" {
		return m.Role == domain.RoleContributor && action == auth.ActionDataRead
	}
	if len(metricKeys) == 0 {
		if len(m.Scope.MetricKeys) > 0 && !(m.Role == domain.RoleContributor && action == auth.ActionDataRead) {
			return false
		}
		return auth.Can(a.p, action, auth.Resource{OrgUnitID: unit}, a.tree, month)
	}
	for _, k := range metricKeys {
		if auth.Can(a.p, action, auth.Resource{OrgUnitID: unit, MetricKey: k}, a.tree, month) {
			return true
		}
	}
	return false
}

// dataWriter returns the caller if its role can write data at all. Whether it
// may write a particular row is decided by access.canWrite.
func dataWriter(p auth.Principal) error {
	if p.Membership.Role != domain.RoleAdmin && p.Membership.Role != domain.RoleContributor {
		return forbidden("data entry requires the contributor or admin role")
	}
	return nil
}

// ---- batch validation --------------------------------------------------------------

// writeSet is a validated, authorized batch of data writes.
type writeSet struct {
	in      *engine.Input
	acc     *access
	vers    *versionLookup
	writes  []store.DataWrite
	periods []period.Period
}

// prepareWrites validates every write of a batch and authorizes the caller
// for each. Validation problems are a 400 with per-row details; any row the
// caller may not write makes the whole batch a 403 that lists those rows.
// withData also loads the stored data of the affected fiscal years (and the
// year before each), which a preview recomputes against.
func (s *Server) prepareWrites(ctx context.Context, p auth.Principal, scorecardID string, body *DataBatchRequest, withData bool) (*writeSet, error) {
	if err := dataWriter(p); err != nil {
		return nil, err
	}
	if body == nil {
		return nil, badRequest("request body is required")
	}
	if n := len(body.Writes); n < 1 || n > maxBatchWrites {
		return nil, badRequest("request validation failed", detail{Path: "writes", Message: fmt.Sprintf("must contain 1 to %d writes", maxBatchWrites)})
	}

	var pr problems
	ws := &writeSet{writes: make([]store.DataWrite, len(body.Writes)), periods: make([]period.Period, len(body.Writes))}
	type key struct {
		measure, subject string
		p                period.Period
	}
	first := map[key]int{}
	for i, w := range body.Writes {
		path := indexPath("writes", i)
		pr.key(path+".measureKey", w.MeasureKey)
		pr.id(path+".subjectId", w.SubjectId)
		per, ok := parsePeriod(&pr, path+".period", w.Period)
		if w.ExpectedRevision < 0 {
			pr.add(path+".expectedRevision", "must be 0 or greater")
		}
		reason := strings.TrimSpace(derefString(w.NaReason))
		if utf8.RuneCountInString(reason) > maxNAReasonRunes {
			pr.add(path+".naReason", "must be at most %d characters", maxNAReasonRunes)
		}
		switch {
		case w.Value != nil && (math.IsNaN(*w.Value) || math.IsInf(*w.Value, 0)):
			pr.add(path+".value", "must be a finite number")
		case w.Value != nil && reason != "":
			pr.add(path, "set either value or naReason, not both")
		case w.Value == nil && reason == "":
			pr.add(path, "value or naReason is required")
		}
		if ok {
			k := key{w.MeasureKey, w.SubjectId, per}
			if j, dup := first[k]; dup {
				pr.add(path, "repeats %s", indexPath("writes", j))
			} else {
				first[k] = i
			}
		}
		ws.periods[i] = per
		ws.writes[i] = store.DataWrite{
			Point: domain.DataPoint{
				MeasureKey: w.MeasureKey,
				SubjectID:  w.SubjectId,
				Period:     per,
				Value:      copyValue(w.Value),
				NAReason:   reason,
				Source:     domain.SourceGrid,
				EnteredBy:  p.UserID,
				EnteredAt:  s.now(),
			},
			ExpectedRevision: w.ExpectedRevision,
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	var years []int
	if withData {
		years = fiscalYears(true, ws.periods...)
	}
	in, err := s.loadInput(ctx, *p.Tenant, scorecardID, years)
	if err != nil {
		return nil, err
	}
	ws.in, ws.acc, ws.vers = in, newAccess(p, in), newVersionLookup(in)

	var forbiddenRows []detail
	for i, w := range ws.writes {
		path := indexPath("writes", i)
		per := ws.periods[i]
		month, _ := lastMonth(in.Cal, per)
		vi, ok := ws.vers.at(per)
		if !ok {
			pr.add(path+".period", "no methodology version is in force for %s", per)
		} else if _, ok := vi.measureIdx[w.Point.MeasureKey]; !ok {
			pr.add(path+".measureKey", "measure %q is not defined in the methodology in force for %s", w.Point.MeasureKey, per)
		}
		if _, ok := ws.acc.unitOf(w.Point.SubjectID); !ok {
			pr.add(path+".subjectId", "subject %q is not an org unit or tracked item", w.Point.SubjectID)
		}
		if len(pr.list) > 0 {
			continue
		}
		if !ws.acc.canWrite(w.Point.SubjectID, vi.uses[w.Point.MeasureKey], month) {
			forbiddenRows = append(forbiddenRows, detail{Path: path, Message: fmt.Sprintf("not permitted to write %s for %s", w.Point.MeasureKey, w.Point.SubjectID)})
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	if len(forbiddenRows) > 0 {
		return nil, &apiError{status: http.StatusForbidden, code: codeForbidden, message: "you may not write one or more of these data points", details: forbiddenRows}
	}
	return ws, nil
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func copyValue(v *float64) *float64 {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

func apiPoint(dp domain.DataPoint) DataPoint {
	return DataPoint{
		MeasureKey: dp.MeasureKey,
		SubjectId:  dp.SubjectID,
		Period:     periodString(dp.Period),
		Value:      dp.Value,
		NaReason:   dp.NAReason,
		Source:     DataPointSource(dp.Source),
		EnteredBy:  dp.EnteredBy,
		EnteredAt:  dp.EnteredAt,
		Revision:   dp.Revision,
	}
}

func apiWrite(w store.DataWrite) DataWrite {
	out := DataWrite{
		MeasureKey:       w.Point.MeasureKey,
		SubjectId:        w.Point.SubjectID,
		Period:           periodString(w.Point.Period),
		Value:            w.Point.Value,
		ExpectedRevision: w.ExpectedRevision,
	}
	if w.Point.NAReason != "" {
		r := w.Point.NAReason
		out.NaReason = &r
	}
	return out
}

func writeKey(dp domain.DataPoint) string {
	return dp.MeasureKey + "/" + dp.SubjectID + "/" + dp.Period.String()
}

// BatchSaveData saves data points all or nothing.
func (s *Server) BatchSaveData(ctx context.Context, req BatchSaveDataRequestObject) (BatchSaveDataResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	ws, err := s.prepareWrites(ctx, p, sc.ID, req.Body, false)
	if err != nil {
		return nil, err
	}

	saved, err := s.store.PutDataPoints(ctx, p.Tenant.ID, sc.ID, ws.writes)
	var ce *store.ConflictError
	if errors.As(err, &ce) {
		out := DataBatchConflicts{Conflicts: make([]DataConflict, 0, len(ce.Conflicts))}
		for _, c := range ce.Conflicts {
			dc := DataConflict{Write: apiWrite(c.Write)}
			if c.Current != nil {
				cur := apiPoint(*c.Current)
				dc.Current = &cur
			}
			out.Conflicts = append(out.Conflicts, dc)
		}
		return BatchSaveData409JSONResponse(out), nil
	}
	if err != nil {
		return nil, err
	}

	keys := make([]string, 0, len(saved))
	resp := BatchSaveData200JSONResponse{Saved: make([]DataPoint, 0, len(saved))}
	for _, dp := range saved {
		resp.Saved = append(resp.Saved, apiPoint(dp))
		keys = append(keys, writeKey(dp))
	}
	after := struct {
		Count int      `json:"count"`
		Keys  []string `json:"keys"`
	}{len(saved), keys}
	if err := s.audit(ctx, p, p.Tenant.ID, "data.batch", "scorecard", sc.ID, nil, after); err != nil {
		return nil, err
	}
	return resp, nil
}

// PreviewData computes the cells a batch would change, saving nothing.
func (s *Server) PreviewData(ctx context.Context, req PreviewDataRequestObject) (PreviewDataResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	ws, err := s.prepareWrites(ctx, p, sc.ID, req.Body, true)
	if err != nil {
		return nil, err
	}
	in := ws.in

	// Merge the unsaved writes over the stored points they replace.
	type pointKey struct {
		measure, subject string
		p                period.Period
	}
	written := make(map[pointKey]bool, len(ws.writes))
	for _, w := range ws.writes {
		written[pointKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period}] = true
	}
	merged := make([]domain.DataPoint, 0, len(in.Data)+len(ws.writes))
	for _, dp := range in.Data {
		if !written[pointKey{dp.MeasureKey, dp.SubjectID, dp.Period}] {
			merged = append(merged, dp)
		}
	}
	for _, w := range ws.writes {
		dp := w.Point
		dp.Revision = 1
		merged = append(merged, dp)
	}
	in.Data = merged

	// The cells to return: metrics whose formula uses a written measure, for
	// the written subject and the org units above it, at the written period.
	type cellKey struct {
		metric, subject string
		p               period.Period
	}
	affected := map[cellKey]bool{}
	subjectSet := map[string]bool{}
	periodSet := map[period.Period]bool{}
	for i, w := range ws.writes {
		per := ws.periods[i]
		vi, _ := ws.vers.at(per)
		month, _ := lastMonth(in.Cal, per)
		subjects := ws.chainOf(w.Point.SubjectID, month)
		for _, metric := range vi.uses[w.Point.MeasureKey] {
			for _, sub := range subjects {
				affected[cellKey{metric, sub, per}] = true
			}
		}
		for _, sub := range subjects {
			subjectSet[sub] = true
		}
		periodSet[per] = true
	}
	if len(periodSet) > maxPreviewPeriods {
		return nil, badRequest("request validation failed", detail{Path: "writes", Message: fmt.Sprintf("a preview covers at most %d distinct periods", maxPreviewPeriods)})
	}
	vr := engine.ViewRequest{Structure: engine.StructureAsOf}
	for per := range periodSet {
		vr.Periods = append(vr.Periods, per)
	}
	sort.Slice(vr.Periods, func(i, j int) bool { return store.ComparePeriod(vr.Periods[i], vr.Periods[j]) < 0 })
	for sub := range subjectSet {
		vr.SubjectIDs = append(vr.SubjectIDs, sub)
	}
	sort.Strings(vr.SubjectIDs)

	view, err := engine.Compute(in, vr)
	if err != nil {
		return nil, err
	}
	resp := PreviewData200JSONResponse{Cells: []Cell{}}
	for _, row := range view.Rows {
		for j, c := range row.Cells {
			if affected[cellKey{row.MetricKey, row.SubjectID, vr.Periods[j]}] {
				resp.Cells = append(resp.Cells, apiCell(c))
			}
		}
	}
	return resp, nil
}

// chainOf lists a subject and everything it rolls up into as of month: for an
// item, the item, its unit, and the unit's ancestors; for a unit, the unit and
// its ancestors.
func (ws *writeSet) chainOf(subjectID string, month period.Period) []string {
	out := []string{subjectID}
	unit, _ := ws.acc.unitOf(subjectID)
	if unit == "" {
		return out
	}
	if unit != subjectID {
		out = append(out, unit)
	}
	tree := ws.in.Tree
	bound := len(tree.UnitIDs())
	for steps, cur := 0, unit; steps <= bound; steps++ {
		parent, ok := tree.ParentAt(cur, month)
		if !ok || parent == "" {
			break
		}
		out = append(out, parent)
		cur = parent
	}
	return out
}

// ---- history -----------------------------------------------------------------------

// GetDataHistory lists every stored revision of a data point, newest first.
func (s *Server) GetDataHistory(ctx context.Context, req GetDataHistoryRequestObject) (GetDataHistoryResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.key("measure", req.Params.Measure)
	pr.id("subject", req.Params.Subject)
	per, _ := parsePeriod(&pr, "period", req.Params.Period)
	if err := pr.err(); err != nil {
		return nil, err
	}
	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, nil)
	if err != nil {
		return nil, err
	}
	acc := newAccess(p, in)
	if _, ok := acc.unitOf(req.Params.Subject); !ok {
		return nil, notFound("subject not found")
	}
	month, _ := lastMonth(in.Cal, per)
	var metricKeys []string
	if vi, ok := newVersionLookup(in).at(per); ok {
		metricKeys = vi.uses[req.Params.Measure]
	}
	if !acc.canRead(req.Params.Subject, metricKeys, month) {
		return nil, forbidden("you may not read this data point")
	}
	pts, err := s.store.History(ctx, p.Tenant.ID, sc.ID, req.Params.Measure, req.Params.Subject, per)
	if err != nil {
		return nil, err
	}
	resp := GetDataHistory200JSONResponse{History: make([]DataPoint, 0, len(pts))}
	for _, dp := range pts {
		resp.History = append(resp.History, apiPoint(dp))
	}
	return resp, nil
}

// ---- entry grid ----------------------------------------------------------------------

// frequencyGrain is the grain a metric's data is entered at.
func frequencyGrain(f domain.Frequency) (period.Grain, bool) {
	switch f {
	case domain.FrequencyMonthly:
		return period.Month, true
	case domain.FrequencyQuarterly:
		return period.Quarter, true
	case domain.FrequencyBiannual:
		return period.Half, true
	case domain.FrequencyAnnual:
		return period.Year, true
	}
	return 0, false
}

// entrySubject is a candidate subject of the entry grid.
type entrySubject struct {
	id, name, level, kind string
	order                 int
}

// entrySubjects lists the org units active at month in tree order, then the
// tracked items by kind, name, and ID.
func entrySubjects(in *engine.Input, month period.Period) []entrySubject {
	var out []entrySubject
	var walk func(id string)
	walk = func(id string) {
		if u, ok := in.Tree.Unit(id); ok {
			out = append(out, entrySubject{id: id, name: u.Name, level: u.LevelID, order: len(out)})
		}
		for _, c := range in.Tree.ChildrenAt(id, month) {
			walk(c)
		}
	}
	for _, r := range in.Tree.RootsAt(month) {
		walk(r)
	}
	items := append([]domain.TrackedItem(nil), in.Items...)
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.KindID != b.KindID {
			return a.KindID < b.KindID
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.ID < b.ID
	})
	for _, it := range items {
		out = append(out, entrySubject{id: it.ID, name: it.Name, kind: it.KindID, order: len(out)})
	}
	return out
}

// GetDataEntry lists the data-entry rows of one month: every measure of the
// metrics reported then, at each subject the metric is reported at. Quarterly,
// biannual, and annual metrics are reported in the last month of their period
// and carry that period.
func (s *Server) GetDataEntry(ctx context.Context, req GetDataEntryRequestObject) (GetDataEntryResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	month, ok := parsePeriod(&pr, "period", req.Params.Period)
	if ok && month.Grain != period.Month {
		pr.add("period", "must be a month such as 2026-M10")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, []int{month.FY})
	if err != nil {
		return nil, err
	}
	grid := EntryGrid{Period: month.String(), Rows: []EntryRow{}}
	vi, ok := newVersionLookup(in).at(month)
	if !ok {
		return GetDataEntry200JSONResponse(grid), nil
	}

	type pointKey struct {
		measure, subject string
		p                period.Period
	}
	stored := make(map[pointKey]domain.DataPoint, len(in.Data))
	for _, dp := range in.Data {
		stored[pointKey{dp.MeasureKey, dp.SubjectID, dp.Period}] = dp
	}

	type rowKey = pointKey
	type rowAcc struct {
		key       rowKey
		metricIdx int
		measure   int
		subject   entrySubject
		metrics   []string
	}
	subjects := entrySubjects(in, month)
	byKey := map[rowKey]*rowAcc{}
	var rows []*rowAcc
	for mi, m := range vi.v.Content.Metrics {
		g, ok := frequencyGrain(m.Frequency)
		if !ok {
			continue
		}
		dataPeriod := in.Cal.Parent(month, g)
		if end, ok := lastMonth(in.Cal, dataPeriod); !ok || end != month {
			continue
		}
		levels, kinds := map[string]bool{}, map[string]bool{}
		for _, r := range m.ReportedAt {
			switch r.Kind {
			case domain.SubjectLevel:
				levels[r.ID] = true
			case domain.SubjectItemKind:
				kinds[r.ID] = true
			}
		}
		for _, sub := range subjects {
			if !(sub.level != "" && levels[sub.level]) && !(sub.kind != "" && kinds[sub.kind]) {
				continue
			}
			for _, measure := range vi.idents[m.Key] {
				k := rowKey{measure, sub.id, dataPeriod}
				r, exists := byKey[k]
				if !exists {
					r = &rowAcc{key: k, metricIdx: mi, measure: vi.measureIdx[measure], subject: sub}
					byKey[k] = r
					rows = append(rows, r)
				}
				r.metrics = append(r.metrics, m.Key)
			}
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.metricIdx != b.metricIdx {
			return a.metricIdx < b.metricIdx
		}
		if a.measure != b.measure {
			return a.measure < b.measure
		}
		return a.subject.order < b.subject.order
	})

	acc := newAccess(p, in)
	for _, r := range rows {
		if !acc.canRead(r.subject.id, r.metrics, month) {
			continue
		}
		row := EntryRow{
			MeasureKey:  r.key.measure,
			MeasureName: vi.v.Content.Measures[r.measure].Name,
			MetricKeys:  append([]string{}, r.metrics...),
			SubjectId:   r.subject.id,
			SubjectName: r.subject.name,
			Period:      periodString(r.key.p),
			CanEdit:     acc.canWrite(r.subject.id, vi.uses[r.key.measure], month),
		}
		if dp, ok := stored[r.key]; ok {
			row.Value, row.NaReason, row.Revision = copyValue(dp.Value), dp.NAReason, dp.Revision
		}
		grid.Rows = append(grid.Rows, row)
	}
	return GetDataEntry200JSONResponse(grid), nil
}

// ---- overrides ---------------------------------------------------------------------

// overrideAdmin returns the caller if it may write overrides.
func overrideAdmin(p auth.Principal) error {
	if !auth.Can(p, auth.ActionOverrideWrite, auth.Resource{}, nil, period.Period{}) {
		return forbidden("admin role required to manage overrides")
	}
	return nil
}

func overrideTarget(o domain.Override) string {
	return o.MetricKey + "/" + o.SubjectID + "/" + o.Period.String()
}

// PutOverride creates or replaces an override on a metric cell. Admins only.
func (s *Server) PutOverride(ctx context.Context, req PutOverrideRequestObject) (PutOverrideResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	if err := overrideAdmin(p); err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body

	var pr problems
	pr.key("metricKey", b.MetricKey)
	pr.id("subjectId", b.SubjectId)
	per, periodOK := parsePeriod(&pr, "period", b.Period)
	status := strings.TrimSpace(derefString(b.Status))
	reason := strings.TrimSpace(derefString(b.Reason))
	if b.Value != nil && (math.IsNaN(*b.Value) || math.IsInf(*b.Value, 0)) {
		pr.add("value", "must be a finite number")
	}
	if b.Value == nil && status == "" {
		pr.add("", "value or status is required")
	}
	if status != "" {
		inScale := false
		for _, l := range p.Tenant.StatusScale {
			if l.Key == status {
				inScale = true
				break
			}
		}
		if !inScale {
			pr.add("status", "%q is not in this organization's status scale", status)
		}
	}
	if utf8.RuneCountInString(reason) > maxReasonRunes {
		pr.add("reason", "must be at most %d characters", maxReasonRunes)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, nil)
	if err != nil {
		return nil, err
	}
	if _, ok := newAccess(p, in).unitOf(b.SubjectId); !ok {
		pr.add("subjectId", "subject %q is not an org unit or tracked item", b.SubjectId)
	}
	if periodOK {
		if vi, ok := newVersionLookup(in).at(per); !ok {
			pr.add("period", "no methodology version is in force for %s", per)
		} else if !vi.hasMetric(b.MetricKey) {
			pr.add("metricKey", "metric %q is not defined in the methodology in force for %s", b.MetricKey, per)
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	o := domain.Override{
		MetricKey: b.MetricKey,
		SubjectID: b.SubjectId,
		Period:    per,
		Value:     copyValue(b.Value),
		Status:    status,
		Reason:    reason,
		By:        p.UserID,
		At:        s.now(),
	}
	if err := s.store.PutOverride(ctx, p.Tenant.ID, sc.ID, o); err != nil {
		return nil, err
	}
	out := apiOverride(o)
	if err := s.audit(ctx, p, p.Tenant.ID, "override.put", "override", overrideTarget(o), nil, out); err != nil {
		return nil, err
	}
	return PutOverride200JSONResponse(out), nil
}

// DeleteOverride removes an override from a metric cell. Admins only.
func (s *Server) DeleteOverride(ctx context.Context, req DeleteOverrideRequestObject) (DeleteOverrideResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, p.Tenant.ID, req.Sc)
	if err != nil {
		return nil, err
	}
	if err := overrideAdmin(p); err != nil {
		return nil, err
	}
	var pr problems
	pr.key("metricKey", req.Params.MetricKey)
	pr.id("subjectId", req.Params.SubjectId)
	per, _ := parsePeriod(&pr, "period", req.Params.Period)
	if err := pr.err(); err != nil {
		return nil, err
	}
	if err := s.store.DeleteOverride(ctx, p.Tenant.ID, sc.ID, req.Params.MetricKey, req.Params.SubjectId, per); err != nil {
		return nil, err // ErrNotFound is a 404
	}
	target := domain.Override{MetricKey: req.Params.MetricKey, SubjectID: req.Params.SubjectId, Period: per}
	before := struct {
		MetricKey string `json:"metricKey"`
		SubjectID string `json:"subjectId"`
		Period    string `json:"period"`
	}{target.MetricKey, target.SubjectID, per.String()}
	if err := s.audit(ctx, p, p.Tenant.ID, "override.delete", "override", overrideTarget(target), before, nil); err != nil {
		return nil, err
	}
	return DeleteOverride204Response{}, nil
}
