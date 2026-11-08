package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/engine"
	"opsvision/internal/formula"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/recordimport"
	"opsvision/internal/records"
	"opsvision/internal/store"
	"opsvision/internal/xlsx"
)

// contributionsPageSize is how many records one page of contributions lists.
const contributionsPageSize = 100

// ---- record types ------------------------------------------------------------------

func apiRecordType(rt domain.RecordType) RecordType {
	out := RecordType{
		Id:          rt.ID,
		Name:        rt.Name,
		Priorities:  append([]string{}, rt.Priorities...),
		Attributes:  make([]AttributeDef, 0, len(rt.Attributes)),
		TrackedFrom: make(map[string]MonthPeriod, len(rt.TrackedFrom)),
		Revision:    rt.Revision,
	}
	for _, a := range rt.Attributes {
		out.Attributes = append(out.Attributes, AttributeDef{Key: a.Key, Name: a.Name, Type: AttributeDefType(a.Type)})
	}
	for src, p := range rt.TrackedFrom {
		out.TrackedFrom[src] = p.String()
	}
	return out
}

// ListRecordTypes lists the tenant's record types.
func (s *Server) ListRecordTypes(ctx context.Context, _ ListRecordTypesRequestObject) (ListRecordTypesResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	types, err := s.store.ListRecordTypes(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	out := make([]RecordType, 0, len(types))
	for _, rt := range types {
		out = append(out, apiRecordType(rt))
	}
	return ListRecordTypes200JSONResponse{RecordTypes: out}, nil
}

// PutRecordType creates a record type (revision 0) or replaces the one the
// client loaded. Attribute keys follow the domain rule, so camelCase is
// allowed. Admins only.
func (s *Server) PutRecordType(ctx context.Context, req PutRecordTypeRequestObject) (PutRecordTypeResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	var pr problems
	pr.key("id", req.Id)
	if b.Id != req.Id {
		pr.add("id", "must equal the id in the path (%q)", req.Id)
	}
	if b.Revision < 0 {
		pr.add("revision", "must not be negative")
	}
	rt := domain.RecordType{
		ID:          b.Id,
		Name:        strings.TrimSpace(b.Name),
		Priorities:  append([]string{}, b.Priorities...),
		Attributes:  make([]domain.AttributeDef, 0, len(b.Attributes)),
		TrackedFrom: make(map[string]period.Period, len(b.TrackedFrom)),
	}
	for _, a := range b.Attributes {
		rt.Attributes = append(rt.Attributes, domain.AttributeDef{Key: a.Key, Name: strings.TrimSpace(a.Name), Type: domain.AttrType(a.Type)})
	}
	for _, src := range slices.Sorted(maps.Keys(b.TrackedFrom)) {
		m, err := period.Parse(b.TrackedFrom[src])
		if err != nil {
			pr.add("trackedFrom."+src, "must be a month such as 2026-M07")
			continue
		}
		rt.TrackedFrom[src] = m
	}
	for _, e := range rt.Validate() {
		pr.add(e.Path, "%s", e.Message)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	tenantID := p.Tenant.ID
	before, _, err := s.recordType(ctx, tenantID, rt.ID)
	if err != nil {
		return nil, err
	}
	if before != nil {
		msg, err := s.recordTypeEditInUse(ctx, tenantID, *before, rt)
		if err != nil {
			return nil, err
		}
		if msg != "" {
			return nil, conflict(msg)
		}
	}
	if err := s.store.PutRecordType(ctx, tenantID, rt, b.Revision); err != nil {
		if errors.Is(err, store.ErrConflict) {
			if b.Revision == 0 {
				return nil, conflict("record type " + rt.ID + " already exists")
			}
			return nil, conflict("the record type changed since it was loaded; reload it and try again")
		}
		return nil, err
	}
	stored, _, err := s.recordType(ctx, tenantID, rt.ID)
	if err != nil {
		return nil, err
	}
	var auditBefore any
	if before != nil {
		auditBefore = apiRecordType(*before)
	}
	out := apiRecordType(*stored)
	if err := s.audit(ctx, p, tenantID, "record_type.put", "record_type", rt.ID, auditBefore, out); err != nil {
		return nil, err
	}
	return PutRecordType200JSONResponse(out), nil
}

// recordTypeEditInUse returns a plain message naming the first derive rule,
// in any methodology version of any scorecard, that uses a priority or
// attribute the edit from before to after removes or renames (or an
// attribute whose type it changes), and "" when there is none.
func (s *Server) recordTypeEditInUse(ctx context.Context, tenantID string, before, after domain.RecordType) (string, error) {
	gone := map[string]bool{}
	for _, pr := range before.Priorities {
		if pr != domain.PriorityNone && !slices.Contains(after.Priorities, pr) {
			gone[pr] = true
		}
	}
	changed := map[string]string{} // attribute key -> its name before
	for _, a := range before.Attributes {
		i := slices.IndexFunc(after.Attributes, func(x domain.AttributeDef) bool { return x.Key == a.Key })
		if i < 0 || after.Attributes[i].Type != a.Type {
			changed[a.Key] = a.Name
		}
	}
	if len(gone) == 0 && len(changed) == 0 {
		return "", nil
	}
	cards, err := s.store.ListScorecards(ctx, tenantID)
	if err != nil {
		return "", err
	}
	for _, sc := range cards {
		versions, err := s.store.ListVersions(ctx, tenantID, sc.ID)
		if err != nil {
			return "", err
		}
		for _, v := range versions {
			vname := v.Name
			if vname == "" {
				vname = v.ID
			}
			for _, m := range v.Content.Measures {
				if m.Derive == nil || m.Derive.RecordType != before.ID {
					continue
				}
				mname := m.Name
				if mname == "" {
					mname = m.Key
				}
				pris, fields := records.DeriveRefs(*m.Derive)
				for _, pr := range pris {
					if gone[pr] {
						return fmt.Sprintf("%s in %s uses priority %s. Change that rule before removing or renaming the priority.", mname, vname, pr), nil
					}
				}
				for _, f := range fields {
					if name, ok := changed[f]; ok {
						return fmt.Sprintf("%s in %s uses %s. Change that rule before removing, renaming, or retyping it.", mname, vname, name), nil
					}
				}
			}
		}
	}
	return "", nil
}

// recordValuesLimit is how many distinct values ListRecordValues returns.
const recordValuesLimit = 100

// ListRecordValues lists the distinct non-empty values one field holds
// across the stored records of a type (each as of its latest revision), most
// common first, for the condition builder's value pickers. Revisions whose
// snapshot is not stored are left over from a failed partial apply and are
// ignored, as derivation ignores them. Admins only.
func (s *Server) ListRecordValues(ctx context.Context, req ListRecordValuesRequestObject) (ListRecordValuesResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	rt, _, err := s.recordType(ctx, tenantID, req.Id)
	if err != nil {
		return nil, err
	}
	if rt == nil {
		return nil, notFound("record type " + req.Id + " not found")
	}
	kind, ok := rt.FieldKind(req.Params.Field)
	if !ok {
		var pr problems
		pr.add("field", "unknown field %q on record type %q", req.Params.Field, rt.ID)
		return nil, pr.err()
	}

	snaps, err := s.store.ListSnapshots(ctx, tenantID, rt.ID)
	if err != nil {
		return nil, err
	}
	stored := make(map[string]bool, len(snaps))
	for _, sn := range snaps {
		stored[sn.ID] = true
	}
	recs, err := s.store.ListRecords(ctx, tenantID, rt.ID)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, r := range recs {
		kept := make([]domain.RecordRevision, 0, len(r.Revisions))
		for _, rv := range r.Revisions {
			if stored[rv.SnapshotID] {
				kept = append(kept, rv)
			}
		}
		if len(kept) == 0 {
			continue
		}
		r.Revisions = kept
		v, ok, err := records.FieldText(records.Latest(r), req.Params.Field, kind)
		if err != nil || !ok {
			continue // a mistyped attribute value is no value
		}
		counts[v]++
	}

	out := make([]RecordValueCount, 0, len(counts))
	for v, n := range counts {
		out = append(out, RecordValueCount{Value: v, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if len(out) > recordValuesLimit {
		out = out[:recordValuesLimit]
	}
	return ListRecordValues200JSONResponse{Values: out}, nil
}

// recordType returns the tenant's record type id (nil when there is none)
// and all of its record types.
func (s *Server) recordType(ctx context.Context, tenantID, id string) (*domain.RecordType, []domain.RecordType, error) {
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	for i := range types {
		if types[i].ID == id {
			return &types[i], types, nil
		}
	}
	return nil, types, nil
}

// ---- records templates ------------------------------------------------------------

// decodeRecordTemplate decodes the body of a records template. Unknown fields
// are refused.
func decodeRecordTemplate(raw []byte) (records.Template, error) {
	var t records.Template
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return t, err
	}
	if dec.More() {
		return t, errors.New("unexpected data after the template")
	}
	return t, nil
}

// validateRecordTemplate records every problem of t against the tenant's
// record types under path (for example "body.").
func validateRecordTemplate(pr *problems, path string, t records.Template, types []domain.RecordType) {
	if strings.TrimSpace(t.RecordType) == "" {
		pr.add(path+"recordType", "record type is required")
		return
	}
	i := slices.IndexFunc(types, func(rt domain.RecordType) bool { return rt.ID == t.RecordType })
	if i < 0 {
		pr.add(path+"recordType", "record type %q does not exist", t.RecordType)
		return
	}
	for _, e := range t.Validate(types[i]) {
		pr.add(path+e.Path, "%s", e.Message)
	}
}

// savedRecordTemplates lists the tenant's records templates with readable
// bodies, for recognition.
func savedRecordTemplates(tpls []store.Template) []records.SavedTemplate {
	var out []records.SavedTemplate
	for _, t := range tpls {
		if t.Profile != profileRecords {
			continue
		}
		body, err := decodeRecordTemplate(t.Body)
		if err != nil {
			continue
		}
		out = append(out, records.SavedTemplate{ID: t.ID, Revision: t.Revision, LastUsed: t.LastUsed, T: body})
	}
	return out
}

// recordsTemplateOf converts an inline template of a request.
func recordsTemplateOf(t RecordTemplate) (records.Template, error) {
	raw, err := json.Marshal(t)
	if err != nil {
		return records.Template{}, err
	}
	return decodeRecordTemplate(raw)
}

func apiRecordTemplate(t records.Template) (RecordTemplate, error) {
	var out RecordTemplate
	raw, err := json.Marshal(t)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	if out.Fields == nil {
		out.Fields = map[string]RecordFieldMap{}
	}
	return out, nil
}

// touchTemplate sets a template's last-used time from a fresh read, so an
// edit made since the preview is kept. A template deleted since is skipped.
func (s *Server) touchTemplate(ctx context.Context, tenantID, id string, at time.Time) error {
	tpls, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return err
	}
	for _, t := range tpls {
		if t.ID == id {
			t.LastUsed = &at
			return s.store.PutTemplate(ctx, tenantID, t)
		}
	}
	return nil
}

// ---- reading uploads ---------------------------------------------------------------

// readRecordsTable loads an uploaded export as a table: a CSV file with its
// header on file.HeaderRow, or file.Sheet of a workbook. The format follows
// the upload, not the template.
func readRecordsTable(ctx context.Context, objs objects.Store, key string, file records.FileSpec) (records.Table, error) {
	data, err := readUpload(ctx, objs, key)
	if err != nil {
		return records.Table{}, err
	}
	if isCSVUpload(key) {
		tbl, err := records.ReadCSVHeader(bytes.NewReader(data), file.HeaderRow)
		if err != nil {
			return records.Table{}, badRequest("the file cannot be read: " + err.Error())
		}
		return tbl, nil
	}
	wb, err := xlsx.Open(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return records.Table{}, badRequest(err.Error())
	}
	tbl, err := records.ReadSheet(wb, file.Sheet, file.HeaderRow)
	if err != nil {
		return records.Table{}, badRequest("the file cannot be read: " + err.Error())
	}
	return tbl, nil
}

// recordsImport loads an import that may still be inspected or previewed.
func (s *Server) recordsImport(ctx context.Context, tenantID, id string) (store.Import, error) {
	im, err := s.loadImport(ctx, tenantID, id)
	if err != nil {
		return im, err
	}
	if im.Status != importUploaded && im.Status != importParsed {
		return im, conflict(fmt.Sprintf("import is %s; only an uploaded or previewed import can be previewed", im.Status))
	}
	return im, nil
}

// ---- inspect -----------------------------------------------------------------------

// InspectImport looks at an uploaded records export for the guided setup.
// Nothing is stored. Admins only.
func (s *Server) InspectImport(ctx context.Context, req InspectImportRequestObject) (InspectImportResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	im, err := s.recordsImport(ctx, tenantID, req.Id)
	if err != nil {
		return nil, err
	}
	tbl, err := readRecordsTable(ctx, objs, im.ObjectKey, records.FileSpec{HeaderRow: 1})
	if err != nil {
		return nil, err
	}
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	tpls, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	units, err := s.store.ListOrgUnits(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	saved := savedRecordTemplates(tpls)
	ins := records.Inspect(tbl, types, saved)
	values := map[string]int{}
	for _, vc := range ins.Values["subjectKey"] {
		values[vc.Value] += vc.Count
	}
	out, err := apiInspection(ins)
	if err != nil {
		return nil, err
	}
	if out.LastUploadAsOf, err = s.lastUploadAsOf(ctx, tenantID, ins.MatchedTemplateID, saved); err != nil {
		return nil, err
	}
	return InspectImport200JSONResponse{Inspection: out, Subjects: apiSubjectSuggestions(records.SuggestSubjects(values, units, items))}, nil
}

// lastUploadAsOf is the as-of date of the newest snapshot of the matched
// template's record type and source, or nil when no template matched or no
// snapshot exists.
func (s *Server) lastUploadAsOf(ctx context.Context, tenantID, templateID string, saved []records.SavedTemplate) (*Date, error) {
	i := slices.IndexFunc(saved, func(t records.SavedTemplate) bool { return t.ID == templateID })
	if templateID == "" || i < 0 {
		return nil, nil
	}
	t := saved[i].T
	snaps, err := s.store.ListSnapshots(ctx, tenantID, t.RecordType)
	if err != nil {
		return nil, err
	}
	// Newest as-of first.
	for _, sn := range snaps {
		if sn.Source == t.Source {
			return &Date{Time: sn.AsOf.Time}, nil
		}
	}
	return nil, nil
}

func apiInspection(in records.Inspection) (RecordInspection, error) {
	draft, err := apiRecordTemplate(in.Draft)
	if err != nil {
		return RecordInspection{}, err
	}
	out := RecordInspection{
		Headers:           strs(in.Headers),
		RowCount:          in.RowCount,
		Samples:           make([][]string, 0, len(in.Samples)),
		SuggestedType:     in.SuggestedType,
		Guesses:           make([]ColumnGuess, 0, len(in.Guesses)),
		Values:            make(map[string][]ValueCount, len(in.Values)),
		DateFormats:       make(map[string][]string, len(in.DateFormats)),
		AmbiguousDates:    strs(in.AmbiguousDates),
		Draft:             draft,
		MatchedTemplateId: in.MatchedTemplateID,
		Added:             strs(in.Added),
		Missing:           strs(in.Missing),
	}
	for _, row := range in.Samples {
		out.Samples = append(out.Samples, strs(row))
	}
	for _, g := range in.Guesses {
		out.Guesses = append(out.Guesses, ColumnGuess{Field: g.Field, Column: g.Column, Confidence: g.Confidence, Samples: strs(g.Samples)})
	}
	for field, vcs := range in.Values {
		out.Values[field] = apiValueCounts(vcs)
	}
	for col, layouts := range in.DateFormats {
		out.DateFormats[col] = strs(layouts)
	}
	return out, nil
}

// strs copies a string slice, never returning nil.
func strs(in []string) []string { return append([]string{}, in...) }

func apiValueCounts(vcs []records.ValueCount) []ValueCount {
	out := make([]ValueCount, 0, len(vcs))
	for _, v := range vcs {
		out = append(out, ValueCount{Value: v.Value, Count: v.Count, Suggested: v.Suggested})
	}
	return out
}

func apiSubjectSuggestions(ss []records.SubjectSuggestion) []SubjectSuggestion {
	out := make([]SubjectSuggestion, 0, len(ss))
	for _, s := range ss {
		out = append(out, SubjectSuggestion{Value: s.Value, Rows: s.Rows, SubjectId: s.SubjectID, Score: s.Score, Candidates: strs(s.Candidates)})
	}
	return out
}

// ---- answers -------------------------------------------------------------------------

// domainAnswers converts and checks the answers of a request; problems are
// recorded under "answers.".
func domainAnswers(in *RecordAnswers, pr *problems) recordimport.Answers {
	var a recordimport.Answers
	if in == nil {
		return a
	}
	if in.SourceKeys != nil {
		for _, k := range slices.Sorted(maps.Keys(*in.SourceKeys)) {
			target := (*in.SourceKeys)[k]
			path := "answers.sourceKeys." + k
			switch {
			case strings.TrimSpace(k) == "":
				pr.add("answers.sourceKeys", "a product or team value is blank")
			case !validID(target):
				pr.add(path, "%s", idRule)
			}
			if a.SourceKeys == nil {
				a.SourceKeys = map[string]string{}
			}
			a.SourceKeys[k] = target
		}
	}
	if in.IgnoreValues != nil {
		a.IgnoreValues = append([]string{}, *in.IgnoreValues...)
	}
	if in.ValueMaps != nil {
		for field, m := range *in.ValueMaps {
			if a.ValueMaps == nil {
				a.ValueMaps = map[string]map[string]string{}
			}
			a.ValueMaps[field] = maps.Clone(m)
		}
	}
	if in.DateOrder != nil {
		switch *in.DateOrder {
		case "", "mdy", "dmy":
			a.DateOrder = *in.DateOrder
		default:
			pr.add("answers.dateOrder", "must be mdy, dmy, or empty")
		}
	}
	if in.UseRecords != nil {
		for i, c := range *in.UseRecords {
			path := indexPath("answers.useRecords", i)
			pr.key(path+".measureKey", c.MeasureKey)
			pr.id(path+".subjectId", c.SubjectId)
			per, _ := parsePeriod(pr, path+".period", c.Period)
			a.UseRecords = append(a.UseRecords, recordimport.CellRef{MeasureKey: c.MeasureKey, SubjectID: c.SubjectId, Period: per})
		}
	}
	if in.MarkMissingCancelled != nil {
		a.MarkMissingCancelled = *in.MarkMissingCancelled
	}
	if in.CreateShared != nil {
		for i, id := range *in.CreateShared {
			pr.id(indexPath("answers.createShared", i), id)
		}
		a.CreateShared = append([]string{}, *in.CreateShared...)
	}
	return a
}

// canonicalAnswers is a form of a in which answers that mean the same
// compare equal: lists sorted and deduplicated, empty lists and maps absent.
func canonicalAnswers(a recordimport.Answers) string {
	norm := func(in []string) []string {
		if len(in) == 0 {
			return nil
		}
		return slices.Compact(slices.Sorted(slices.Values(in)))
	}
	c := a
	c.IgnoreValues, c.CreateShared = norm(a.IgnoreValues), norm(a.CreateShared)
	if len(a.SourceKeys) == 0 {
		c.SourceKeys = nil
	}
	c.ValueMaps = nil
	for field, m := range a.ValueMaps {
		if len(m) == 0 {
			continue
		}
		if c.ValueMaps == nil {
			c.ValueMaps = map[string]map[string]string{}
		}
		c.ValueMaps[field] = m
	}
	c.UseRecords = nil
	if len(a.UseRecords) > 0 {
		c.UseRecords = slices.Clone(a.UseRecords)
		sort.Slice(c.UseRecords, func(i, j int) bool {
			x, y := c.UseRecords[i], c.UseRecords[j]
			if cmp := store.ComparePeriod(x.Period, y.Period); cmp != 0 {
				return cmp < 0
			}
			if x.MeasureKey != y.MeasureKey {
				return x.MeasureKey < y.MeasureKey
			}
			return x.SubjectID < y.SubjectID
		})
		c.UseRecords = slices.Compact(c.UseRecords)
	}
	raw, _ := json.Marshal(c) // maps marshal with sorted keys
	return string(raw)
}

// checkAnswers records answers that do not fit the template or the org:
// value answers for fields the template does not map, and source keys or
// shared units naming subjects that do not exist.
func checkAnswers(pr *problems, a recordimport.Answers, t records.Template, units []domain.OrgUnit, items []domain.TrackedItem) {
	unit := func(id string) bool {
		return slices.ContainsFunc(units, func(u domain.OrgUnit) bool { return u.ID == id })
	}
	item := func(id string) bool {
		return slices.ContainsFunc(items, func(it domain.TrackedItem) bool { return it.ID == id })
	}
	for i, id := range a.CreateShared {
		if !unit(id) {
			pr.add(indexPath("answers.createShared", i), "org unit %q does not exist", id)
		}
	}
	for _, k := range slices.Sorted(maps.Keys(a.SourceKeys)) {
		target := a.SourceKeys[k]
		if !unit(target) && !item(target) {
			pr.add("answers.sourceKeys."+k, "%q is not an org unit or tracked item", target)
		}
	}
	for _, field := range slices.Sorted(maps.Keys(a.ValueMaps)) {
		_, inFields := t.Fields[field]
		_, inAttrs := t.Attributes[field]
		if !inFields && !inAttrs {
			pr.add("answers.valueMaps."+field, "the template does not map %q", field)
		}
	}
}

// heldSourceKey returns the first answered source key another subject
// already holds, once the answered shared units take over their parents'
// keys, with a description of the holder.
func heldSourceKey(a recordimport.Answers, units []domain.OrgUnit, items []domain.TrackedItem) (key, holder string, held bool) {
	shared := map[string]bool{}
	for _, id := range a.CreateShared {
		shared[id] = true
	}
	for _, k := range slices.Sorted(maps.Keys(a.SourceKeys)) {
		target := a.SourceKeys[k]
		if shared[target] {
			target = recordimport.SharedUnitID(target)
		}
		id, ok := domain.SourceKeyHolder(units, items, k)
		if !ok {
			continue
		}
		if shared[id] {
			id = recordimport.SharedUnitID(id)
		}
		if id != target {
			return strings.TrimSpace(k), holderName(units, items, id, k), true
		}
	}
	return "", "", false
}

// ---- preview -------------------------------------------------------------------------

// recordsPlanKey is the object key of an import's stored records preview.
func recordsPlanKey(tenantID, importID string) string {
	return "t/" + tenantID + "/imports/" + importID + ".records-plan.json"
}

// storedRecordsPlan is the document saved at recordsPlanKey: the plan, the
// template and answers it was built with, and where it writes. A plan is too
// large for the import's database item, so it lives in the object store.
type storedRecordsPlan struct {
	ScorecardID      string               `json:"scorecardId"`
	TemplateID       string               `json:"templateId,omitempty"`
	TemplateRevision int                  `json:"templateRevision,omitempty"`
	Template         records.Template     `json:"template"`
	Answers          recordimport.Answers `json:"answers"`
	Plan             recordimport.Plan    `json:"plan"`
}

// PreviewRecordsImport previews importing an uploaded records export with a
// saved or inline template and the admin's answers. Nothing is applied: the
// plan and its answers are stored for apply. Admins only.
func (s *Server) PreviewRecordsImport(ctx context.Context, req PreviewRecordsImportRequestObject) (PreviewRecordsImportResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	var pr problems
	pr.id("scorecardId", b.ScorecardId)
	switch {
	case (b.TemplateId == nil) == (b.Template == nil):
		pr.add("templateId", "give exactly one of templateId and template")
	case b.TemplateId != nil:
		pr.id("templateId", *b.TemplateId)
	}
	if b.DraftVersionId != nil {
		pr.id("draftVersionId", *b.DraftVersionId)
	}
	asOf := domain.Date{Time: b.AsOf.Time}
	if asOf.IsZero() {
		pr.add("asOf", "is required")
	}
	ans := domainAnswers(b.Answers, &pr)
	if err := pr.err(); err != nil {
		return nil, err
	}

	tenantID := p.Tenant.ID
	im, err := s.recordsImport(ctx, tenantID, req.Id)
	if err != nil {
		return nil, err
	}
	sc, err := s.scorecardOf(ctx, tenantID, b.ScorecardId)
	if err != nil {
		return nil, err
	}
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	var tpl records.Template
	templateID, templateRev := "", 0
	if b.TemplateId != nil {
		templateID = *b.TemplateId
		tpls, err := s.store.ListTemplates(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		i := slices.IndexFunc(tpls, func(t store.Template) bool { return t.ID == templateID })
		switch {
		case i < 0:
			return nil, badRequest("request validation failed", detail{Path: "templateId", Message: fmt.Sprintf("template %q does not exist", templateID)})
		case tpls[i].Profile != profileRecords:
			return nil, badRequest("request validation failed", detail{Path: "templateId", Message: fmt.Sprintf("template %q is not a records template", templateID)})
		}
		if tpl, err = decodeRecordTemplate(tpls[i].Body); err != nil {
			return nil, badRequest("request validation failed", detail{Path: "templateId", Message: "the stored template cannot be read: " + err.Error()})
		}
		templateRev = tpls[i].Revision
		var tp problems
		validateRecordTemplate(&tp, "", tpl, types)
		for _, d := range tp.list {
			pr.add("templateId", "%s: %s", d.Path, d.Message)
		}
	} else {
		if tpl, err = recordsTemplateOf(*b.Template); err != nil {
			return nil, badRequest("request validation failed", detail{Path: "template", Message: err.Error()})
		}
		validateRecordTemplate(&pr, "template.", tpl, types)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	var draft *domain.MethodologyVersion
	if b.DraftVersionId != nil {
		v, err := s.store.GetVersion(ctx, tenantID, sc.ID, *b.DraftVersionId)
		switch {
		case errors.Is(err, store.ErrNotFound):
			pr.add("draftVersionId", "must be a version of scorecard %s", sc.ID)
		case err != nil:
			return nil, err
		case v.Status != domain.VersionDraft:
			pr.add("draftVersionId", "version %s is %s, not a draft", v.ID, v.Status)
		default:
			draft = &v
		}
	}
	units, err := s.store.ListOrgUnits(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	checkAnswers(&pr, ans, tpl, units, items)
	if key, holder, held := heldSourceKey(ans, units, items); held {
		pr.add("answers.sourceKeys."+key, "source key %q already belongs to %s", key, holder)
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	tbl, err := readRecordsTable(ctx, objs, im.ObjectKey, tpl.File)
	if err != nil {
		return nil, err
	}
	plan, err := recordimport.Build(ctx, s.store, *p.Tenant, sc.ID, tpl, tbl, asOf, ans, draft)
	if err != nil {
		return nil, fmt.Errorf("httpapi: preview records import %s: %w", im.ID, err)
	}
	plan.Snapshot.TemplateID, plan.Snapshot.TemplateRevision = templateID, templateRev

	raw, err := json.Marshal(storedRecordsPlan{ScorecardID: sc.ID, TemplateID: templateID, TemplateRevision: templateRev,
		Template: tpl, Answers: ans, Plan: plan})
	if err != nil {
		return nil, err
	}
	if err := objs.Put(ctx, recordsPlanKey(tenantID, im.ID), "application/json", raw); err != nil {
		return nil, err
	}
	im.Status = importParsed
	im.Profile = profileRecords
	im.TemplateID = templateID
	im.ChangeSet = nil
	if err := s.store.PutImport(ctx, tenantID, im); err != nil {
		return nil, err
	}
	out := apiRecordsPreview(plan)
	if err := s.audit(ctx, p, tenantID, "import.parse", "import", im.ID, nil, map[string]any{
		"profile": profileRecords, "templateId": templateID, "scorecardId": sc.ID, "asOf": asOf.String(), "counts": out.Counts,
	}); err != nil {
		return nil, err
	}
	return PreviewRecordsImport200JSONResponse(out), nil
}

func apiRecordCounts(c recordimport.Counts) RecordCounts {
	return RecordCounts{New: c.New, Changed: c.Changed, Unchanged: c.Unchanged, Skipped: c.Skipped,
		Missing: c.Missing, Unmatched: c.Unmatched, Errors: c.Errors}
}

func apiContribution(c records.Contribution, subjectID string) RecordContribution {
	out := RecordContribution{
		Source: c.Source, ExternalId: c.ExternalID, Title: c.Title, Url: c.URL, Priority: c.Priority,
		State: RecordContributionState(c.State), Amount: c.Amount, Reason: c.Reason,
		Dates: make(map[string]Date, len(c.Dates)),
	}
	for k, d := range c.Dates {
		out.Dates[k] = Date{Time: d.Time}
	}
	if subjectID != "" {
		out.SubjectId = &subjectID
	}
	return out
}

func apiContributions(cs []records.Contribution) []RecordContribution {
	out := make([]RecordContribution, 0, len(cs))
	for _, c := range cs {
		out = append(out, apiContribution(c, ""))
	}
	return out
}

func apiStoryLines(ls []recordimport.StoryLine) []RecordStoryLine {
	out := make([]RecordStoryLine, 0, len(ls))
	for _, l := range ls {
		line := RecordStoryLine{
			Period: periodString(l.Period), MetricKey: l.MetricKey, MetricName: l.MetricName,
			SubjectId: l.SubjectID, SubjectName: l.SubjectName,
			BeforeDisplay: l.BeforeDisplay, AfterDisplay: l.AfterDisplay, BeforeStatus: l.BeforeStatus, AfterStatus: l.AfterStatus,
			Reasons: make(map[string][]RecordContribution, len(l.Reasons)),
		}
		for reason, cs := range l.Reasons {
			line.Reasons[reason] = apiContributions(cs)
		}
		out = append(out, line)
	}
	return out
}

func apiRecordsPreview(p recordimport.Plan) RecordsPreview {
	out := RecordsPreview{
		PlanId: p.Snapshot.ID,
		Counts: apiRecordCounts(p.Counts),
		Story: RecordStory{
			NothingChanged: p.Story.NothingChanged,
			SameRecords:    p.Story.SameRecords,
			Lines:          apiStoryLines(p.Story.Lines),
			More:           p.Story.More,
			Typed:          make([]TypedVsRecords, 0, len(p.Story.Typed)),
			LockedWaiting:  apiStoryLines(p.Story.LockedWaiting),
			Warnings:       strs(p.Story.Warnings),
		},
		Problems:       make([]RecordRowProblem, 0, len(p.Problems)),
		Unmatched:      apiSubjectSuggestions(p.Unmatched),
		Parents:        make([]ParentMatch, 0, len(p.Parents)),
		NewValues:      make(map[string][]ValueCount, len(p.NewValues)),
		Missing:        strs(p.Missing),
		ColumnsAdded:   strs(p.ColumnsAdded),
		ColumnsMissing: strs(p.ColumnsMissing),
	}
	if p.Story.PreviousAsOf != nil {
		out.Story.PreviousAsOf = &Date{Time: p.Story.PreviousAsOf.Time}
	}
	for _, t := range p.Story.Typed {
		out.Story.Typed = append(out.Story.Typed, TypedVsRecords{
			MeasureKey: t.MeasureKey, SubjectId: t.SubjectID, Period: periodString(t.Period),
			Typed: t.Typed, TypedSource: t.TypedSource, Records: t.Records, Contributions: apiContributions(t.Contributions),
		})
	}
	for _, rp := range p.Problems {
		out.Problems = append(out.Problems, RecordRowProblem{Row: rp.RowNum, Kind: rp.Kind, Column: rp.Column, Field: rp.Field, Value: rp.Value, Message: rp.Message})
	}
	for _, pm := range p.Parents {
		out.Parents = append(out.Parents, ParentMatch{Value: pm.Value, Rows: pm.Rows, UnitId: pm.UnitID})
	}
	for field, vcs := range p.NewValues {
		out.NewValues[field] = apiValueCounts(vcs)
	}
	return out
}

// ---- apply -----------------------------------------------------------------------------

// applyRecords applies a records import's stored preview. The posted planId
// must name that preview (a later preview replaces it) and the posted answers
// must be the previewed ones; the stored plan is applied with them. The
// previewed template's last-used time is set, and saveTemplate saves the
// template with the answers' value maps and date order.
func (s *Server) applyRecords(ctx context.Context, p auth.Principal, objs objects.Store, im store.Import, body *ApplyImportRequest) (ApplyImportResponseObject, error) {
	tenantID := p.Tenant.ID
	var pr problems
	var ans recordimport.Answers
	var planID string
	var save *struct {
		Id   Id     `json:"id"`
		Name string `json:"name"`
	}
	if body != nil {
		if body.PlanId != nil {
			planID = *body.PlanId
		}
		ans = domainAnswers(body.Answers, &pr)
		if save = body.SaveTemplate; save != nil {
			pr.id("saveTemplate.id", save.Id)
			pr.nonEmpty("saveTemplate.name", save.Name)
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	rc, _, err := objs.Get(ctx, recordsPlanKey(tenantID, im.ID))
	if errors.Is(err, objects.ErrNotFound) {
		return nil, previewOutOfDate("the preview is missing; preview the import again")
	}
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var doc storedRecordsPlan
	if err := json.NewDecoder(io.LimitReader(rc, objects.MaxUploadBytes*8)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("httpapi: decode records plan of import %s: %w", im.ID, err)
	}
	// Previews can overlap; only the one the caller saw may be applied.
	if planID == "" || planID != doc.Plan.Snapshot.ID {
		return nil, previewOutOfDate("preview is out of date: this is not the latest preview of the import; preview the import again")
	}
	if canonicalAnswers(ans) != canonicalAnswers(doc.Answers) {
		return nil, previewOutOfDate("preview is out of date: these answers differ from the previewed ones; preview the import again")
	}

	units, err := s.store.ListOrgUnits(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListTrackedItems(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if key, holder, held := heldSourceKey(doc.Answers, units, items); held {
		return nil, conflict(fmt.Sprintf("source key %q now belongs to %s; preview the import again", key, holder))
	}
	var saved records.Template
	if save != nil {
		tpls, err := s.store.ListTemplates(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		if i := slices.IndexFunc(tpls, func(t store.Template) bool { return t.ID == save.Id }); i >= 0 && tpls[i].Profile != profileRecords {
			return nil, conflict(fmt.Sprintf("template %s is a %s template; save the records template under another ID", save.Id, tpls[i].Profile))
		}
		rt, _, err := s.recordType(ctx, tenantID, doc.Template.RecordType)
		if err != nil {
			return nil, err
		}
		if rt == nil {
			return nil, conflict(fmt.Sprintf("record type %q no longer exists; preview the import again", doc.Template.RecordType))
		}
		if saved, err = recordimport.TemplateWithAnswers(doc.Template, *rt, doc.Answers); err != nil {
			return nil, fmt.Errorf("httpapi: answers for template %s: %w", save.Id, err)
		}
		saved.Name = strings.TrimSpace(save.Name)
	}

	err = recordimport.Apply(ctx, s.store, *p.Tenant, doc.ScorecardID, doc.Plan, doc.Answers, p.UserID)
	switch {
	case errors.Is(err, recordimport.ErrAlreadyApplied):
		return nil, alreadyApplied("this preview was already applied")
	case errors.Is(err, store.ErrConflict):
		return nil, conflict("something changed while applying, such as a record type or template; try again")
	}
	if err != nil {
		return nil, fmt.Errorf("httpapi: apply records import %s: %w", im.ID, err)
	}
	im.Status = importApplied
	if err := s.store.PutImport(ctx, tenantID, im); err != nil {
		return nil, err
	}
	// recordimport.Apply records the records.import audit entry itself.

	now := s.now()
	if doc.TemplateID != "" && (save == nil || save.Id != doc.TemplateID) {
		if err := s.touchTemplate(ctx, tenantID, doc.TemplateID, now); err != nil {
			return nil, err
		}
	}
	applied := RecordsApplied{SnapshotId: doc.Plan.Snapshot.ID, Counts: apiRecordCounts(doc.Plan.Counts)}
	if save != nil {
		if err := s.saveRecordsTemplate(ctx, p, save.Id, saved, now); err != nil {
			return nil, err
		}
		id := save.Id
		applied.TemplateId = &id
	}
	return ApplyImport200JSONResponse(ChangeSetPreview{
		Id: im.ID, Status: ChangeSetPreviewStatus(importApplied), Counts: ImportCounts{},
		Findings: []ImportFinding{}, Sample: []ImportChange{}, Records: &applied,
	}), nil
}

// saveRecordsTemplate stores t as records template id, used at at.
func (s *Server) saveRecordsTemplate(ctx context.Context, p auth.Principal, id string, t records.Template, at time.Time) error {
	tenantID := p.Tenant.ID
	raw, err := json.Marshal(t)
	if err != nil {
		return err
	}
	tpls, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return err
	}
	var before any
	if i := slices.IndexFunc(tpls, func(x store.Template) bool { return x.ID == id }); i >= 0 {
		before = apiTemplate(tpls[i])
	}
	next := store.Template{ID: id, Name: t.Name, Profile: profileRecords, Body: raw, LastUsed: &at}
	if err := s.store.PutTemplate(ctx, tenantID, next); err != nil {
		return err
	}
	return s.audit(ctx, p, tenantID, "import_template.put", "import_template", id, before, apiTemplate(next))
}

// ---- sample ------------------------------------------------------------------------------

// SampleRecords counts, per leaf subject, the stored records of a type whose
// bucketBy date falls in a period and that match a condition, for the live
// sample beside the condition builder. Admins only.
func (s *Server) SampleRecords(ctx context.Context, req SampleRecordsRequestObject) (SampleRecordsResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	tenantID := p.Tenant.ID
	sc, err := s.scorecardOf(ctx, tenantID, req.Sc)
	if err != nil {
		return nil, err
	}
	var pr problems
	per, _ := parsePeriod(&pr, "period", b.Period)
	rt, _, err := s.recordType(ctx, tenantID, b.RecordType)
	if err != nil {
		return nil, err
	}
	var cond *records.Cond
	if rt == nil {
		pr.add("recordType", "record type %q does not exist", b.RecordType)
	} else {
		if kind, ok := rt.FieldKind(b.BucketBy); !ok || kind != domain.AttrDate {
			pr.add("bucketBy", "%q is not a date field of record type %q", b.BucketBy, rt.ID)
		}
		if cond, err = records.CompileWhere(strOrEmpty(b.Where), *rt); err != nil {
			pr.add("where", "%s", err.Error())
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	in, err := recordimport.LoadDeriveInput(ctx, s.store, *p.Tenant, sc.ID)
	if err != nil {
		return nil, err
	}
	start, end := in.Cal.Start(per), in.Cal.End(per)
	res := records.NewResolver(in)
	counts := map[string]int{}
	for _, r := range in.Records {
		if r.Type != rt.ID || len(r.Revisions) == 0 {
			continue
		}
		f := records.Latest(r)
		d, ok, err := records.FieldDate(f, b.BucketBy)
		if err != nil || !ok || d.Time.Before(start) || !d.Time.Before(end) {
			continue // a mistyped attribute value counts for nothing
		}
		id, problem := res.Resolve(f.SubjectKey, in.Cal.MonthOf(d.Time))
		if problem != "" {
			continue
		}
		if match, err := cond.Match(f); err == nil && match {
			counts[id]++
		}
	}

	names := subjectNames(in)
	out := RecordsSample{BySubject: []struct {
		Count     int    `json:"count"`
		Name      string `json:"name"`
		SubjectId Id     `json:"subjectId"`
	}{}}
	for id, n := range counts {
		out.Total += n
		out.BySubject = append(out.BySubject, struct {
			Count     int    `json:"count"`
			Name      string `json:"name"`
			SubjectId Id     `json:"subjectId"`
		}{Count: n, Name: names[id], SubjectId: id})
	}
	sort.Slice(out.BySubject, func(i, j int) bool {
		a, b := out.BySubject[i], out.BySubject[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.SubjectId < b.SubjectId
	})
	return SampleRecords200JSONResponse(out), nil
}

// subjectNames maps org unit and tracked item IDs to their names.
func subjectNames(in records.DeriveInput) map[string]string {
	out := map[string]string{}
	if in.Tree != nil {
		for _, id := range in.Tree.UnitIDs() {
			u, _ := in.Tree.Unit(id)
			out[id] = u.Name
		}
	}
	for _, it := range in.Items {
		out[it.ID] = it.Name
	}
	return out
}

// ---- contributions -------------------------------------------------------------------------

// ListRecordContributions lists the records behind a metric cell: for each
// derived measure the metric's formula references, the stored point beside
// the value records give, and the records that contribute, across the leaf
// subjects of the cell the caller may read. Records are paginated across
// measures. Any member with data read access to the subject.
func (s *Server) ListRecordContributions(ctx context.Context, req ListRecordContributionsRequestObject) (ListRecordContributionsResponseObject, error) {
	p, err := member(ctx)
	if err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	sc, err := s.scorecardOf(ctx, tenantID, req.Sc)
	if err != nil {
		return nil, err
	}
	q := req.Params
	var pr problems
	pr.key("metric", q.Metric)
	pr.id("subject", q.Subject)
	per, _ := parsePeriod(&pr, "period", q.Period)
	offset := 0
	if q.Cursor != nil && *q.Cursor != "" {
		n, err := strconv.Atoi(*q.Cursor)
		if err != nil || n < 0 {
			pr.add("cursor", "must be a nextCursor from an earlier page")
		}
		offset = n
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	in, err := s.loadInput(ctx, *p.Tenant, sc.ID, []int{per.FY})
	if err != nil {
		return nil, err
	}
	acc := newAccess(p, in)
	if _, ok := acc.unitOf(q.Subject); !ok {
		return nil, notFound("subject not found")
	}
	v, ok := engine.VersionFor(in.Versions, per, in.Cal)
	if !ok {
		return nil, notFound("no methodology version is in force for this period")
	}
	mi := slices.IndexFunc(v.Content.Metrics, func(m domain.Metric) bool { return m.Key == q.Metric })
	if mi < 0 {
		return nil, notFound("metric not found")
	}
	metric := v.Content.Metrics[mi]
	month, _ := lastMonth(in.Cal, per)
	if !acc.canRead(q.Subject, []string{metric.Key}, month) {
		return nil, forbidden("you may not read this cell")
	}

	measures := derivedMeasuresOf(v, metric)
	leaves := map[string]bool{}
	for _, id := range cellSubjects(in, q.Subject, month, metric.RollItemsToOrg) {
		if acc.canRead(id, []string{metric.Key}, month) {
			leaves[id] = true
		}
	}
	din, err := recordimport.LoadDeriveInput(ctx, s.store, *p.Tenant, sc.ID)
	if err != nil {
		return nil, err
	}
	stored := map[string]domain.DataPoint{}
	for _, dp := range in.Data {
		if dp.SubjectID == q.Subject && dp.Period == per {
			stored[dp.MeasureKey] = dp
		}
	}

	out := RecordContributions{Measures: make([]ContributionMeasure, 0, len(measures))}
	pos, end := 0, offset+contributionsPageSize
	for _, m := range measures {
		cm := ContributionMeasure{MeasureKey: m.Key, Records: []RecordContribution{}}
		if dp, ok := stored[m.Key]; ok {
			cm.Value, cm.Source = copyValue(dp.Value), dp.Source
		}
		vals, err := records.Derive(din, m, []period.Period{per})
		if err != nil {
			// One bad rule does not hide the other measures' records.
			slog.Warn("httpapi: contributions: a derived measure could not be derived", "tenant", tenantID, "measure", m.Key, "err", err)
			vals = nil
		}
		var values []float64
		for _, d := range vals {
			if !leaves[d.SubjectID] {
				continue
			}
			values = append(values, d.Value)
			cm.Pending += d.Pending
			cm.Total += len(d.Contributions)
			cutoff := Date{Time: d.Cutoff.Time}
			cm.Cutoff = &cutoff
			for _, c := range d.Contributions {
				if pos >= offset && pos < end {
					cm.Records = append(cm.Records, apiContribution(c, d.SubjectID))
				}
				pos++
			}
		}
		cm.Covered = len(values) > 0
		cm.RecordsValue = rollUp(m.OrgAgg, values)
		out.Measures = append(out.Measures, cm)
	}
	if pos > end {
		next := strconv.Itoa(end)
		out.NextCursor = &next
	}
	return ListRecordContributions200JSONResponse(out), nil
}

// derivedMeasuresOf lists the derived measures of v that m's formula
// references, by key.
func derivedMeasuresOf(v domain.MethodologyVersion, m domain.Metric) []domain.Measure {
	ids, err := formula.Identifiers(m.Formula)
	if err != nil {
		return nil
	}
	var out []domain.Measure
	for _, id := range ids { // distinct and sorted
		i := slices.IndexFunc(v.Content.Measures, func(ms domain.Measure) bool { return ms.Key == id })
		if i >= 0 && v.Content.Measures[i].Source == domain.MeasureDerived && v.Content.Measures[i].Derive != nil {
			out = append(out, v.Content.Measures[i])
		}
	}
	return out
}

// cellSubjects lists the subjects whose values make up a cell's value as of
// month: the subject, the units below it, and, when the metric rolls items
// into the org, the items attached to any of them. Only leaves get derived
// values, so callers keep the ones Derive returns.
func cellSubjects(in *engine.Input, subjectID string, month period.Period, rollItems bool) []string {
	out := []string{subjectID}
	if _, ok := in.Tree.Unit(subjectID); !ok {
		return out
	}
	out = append(out, in.Tree.DescendantsAt(subjectID, month)...)
	if rollItems {
		units := map[string]bool{}
		for _, id := range out {
			units[id] = true
		}
		for _, it := range in.Items {
			if units[it.OrgUnitID] {
				out = append(out, it.ID)
			}
		}
	}
	return out
}

// rollUp combines leaf values the way the measure rolls up the org, or nil
// when there are none or the aggregation does not combine values.
func rollUp(agg domain.Agg, values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	if len(values) == 1 {
		v := values[0]
		return &v
	}
	var v float64
	switch agg {
	case domain.AggSum:
		for _, x := range values {
			v += x
		}
	case domain.AggAverage:
		for _, x := range values {
			v += x
		}
		v /= float64(len(values))
	case domain.AggMin:
		v = math.Inf(1)
		for _, x := range values {
			v = math.Min(v, x)
		}
	case domain.AggMax:
		v = math.Inf(-1)
		for _, x := range values {
			v = math.Max(v, x)
		}
	default:
		return nil
	}
	return &v
}
