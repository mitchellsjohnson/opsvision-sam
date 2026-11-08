package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/importer"
	"opsvision/internal/objects"
	"opsvision/internal/store"
	"opsvision/internal/xlsx"
)

// Import statuses (store.Import.Status).
const (
	importUploaded = "uploaded"
	importParsed   = "parsed"
	importApplied  = "applied"
)

// Import profiles.
const (
	profileLegacyWorkbook = "legacy_workbook"
	profileCSV            = "csv"
	profileRecords        = "records"
)

const (
	csvUnavailable = "csv import is not available yet"
	// previewSampleSize is the most changes a preview shows.
	previewSampleSize = 50
)

// uploadKey is the object key of an import's uploaded file; ext is ".xlsx"
// or ".csv".
func uploadKey(tenantID, importID, ext string) string {
	return "t/" + tenantID + "/imports/" + importID + ext
}

// isCSVUpload reports whether an upload's object key names a CSV file.
func isCSVUpload(key string) bool { return strings.HasSuffix(key, ".csv") }

// changeSetKey is the object key of an import's parsed change set.
func changeSetKey(tenantID, importID string) string {
	return "t/" + tenantID + "/imports/" + importID + ".changeset.json"
}

// storedChangeSet is the document saved at changeSetKey: the change set and
// the scorecard it was parsed for, so apply writes where parse looked even if
// the template changed in between. A change set is too large for the import's
// database item (the item limit is 400 KB), so it lives in the object store.
type storedChangeSet struct {
	ScorecardID string              `json:"scorecardId"`
	ChangeSet   changeset.ChangeSet `json:"changeSet"`
}

// objectStore returns the configured object store.
func (s *Server) objectStore() (objects.Store, error) {
	if s.objects == nil {
		return nil, errors.New("httpapi: Deps.Objects is not configured")
	}
	return s.objects, nil
}

// loadImport reads an import of the caller's tenant. An ID that does not exist
// there, including one that belongs to another tenant, is a 404.
func (s *Server) loadImport(ctx context.Context, tenantID, id string) (store.Import, error) {
	if !validID(id) {
		return store.Import{}, notFound("import not found")
	}
	im, err := s.store.GetImport(ctx, tenantID, id)
	if errors.Is(err, store.ErrNotFound) {
		return store.Import{}, notFound("import not found")
	}
	return im, err
}

// ---- upload ---------------------------------------------------------------------

// CreateImportUpload starts an import and returns a URL to upload the
// file to: an .xlsx workbook (the default) or a CSV export. Admins only.
func (s *Server) CreateImportUpload(ctx context.Context, req CreateImportUploadRequestObject) (CreateImportUploadResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	contentType, ext := objects.ContentTypeXLSX, ".xlsx"
	if req.Body != nil && req.Body.ContentType != nil {
		switch *req.Body.ContentType {
		case objects.ContentTypeXLSX:
		case objects.ContentTypeCSV:
			contentType, ext = objects.ContentTypeCSV, ".csv"
		default:
			return nil, badRequest("only .xlsx workbooks and CSV files can be imported",
				detail{Path: "contentType", Message: "must be " + objects.ContentTypeXLSX + " or " + objects.ContentTypeCSV})
		}
	}
	tenantID := p.Tenant.ID
	id := s.newID()
	key := uploadKey(tenantID, id, ext)
	url, err := objs.PresignPut(ctx, key, contentType, objects.MaxUploadBytes, objects.UploadTTL)
	if err != nil {
		return nil, err
	}
	im := store.Import{ID: id, Status: importUploaded, ObjectKey: key, CreatedBy: p.UserID, CreatedAt: s.now()}
	if err := s.store.PutImport(ctx, tenantID, im); err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "import.create", "import", id, nil, im); err != nil {
		return nil, err
	}
	return CreateImportUpload201JSONResponse{ImportId: id, UploadUrl: url}, nil
}

// ---- parse ----------------------------------------------------------------------

// ParseImport parses the uploaded workbook with a saved template into a change
// set and returns its preview. Nothing is applied. An import that is parsed
// may be parsed again, with the same or another template. Admins only.
func (s *Server) ParseImport(ctx context.Context, req ParseImportRequestObject) (ParseImportResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	im, err := s.loadImport(ctx, tenantID, req.Id)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body

	switch string(b.Profile) {
	case profileLegacyWorkbook:
	case profileCSV:
		return nil, badRequest(csvUnavailable)
	default:
		return nil, badRequest("request validation failed", detail{Path: "profile", Message: "must be legacy_workbook"})
	}
	if b.TemplateId == nil || !validID(*b.TemplateId) {
		return nil, badRequest("request validation failed", detail{Path: "templateId", Message: "a stored template is required: " + idRule})
	}
	templateID := *b.TemplateId
	tpls, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var tpl *store.Template
	for i := range tpls {
		if tpls[i].ID == templateID {
			tpl = &tpls[i]
		}
	}
	if tpl == nil {
		return nil, badRequest("request validation failed", detail{Path: "templateId", Message: fmt.Sprintf("template %q does not exist", templateID)})
	}
	if tpl.Profile != profileLegacyWorkbook {
		return nil, badRequest("request validation failed", detail{Path: "templateId", Message: fmt.Sprintf("template %q is not a legacy_workbook template", templateID)})
	}
	if im.Status != importUploaded && im.Status != importParsed {
		return nil, conflict(fmt.Sprintf("import is %s; only an uploaded or parsed import can be parsed", im.Status))
	}
	tb, problemList := decodeTemplateBody(tpl.Body)
	if len(problemList) > 0 {
		return nil, badRequest("template is not valid", problemList...)
	}

	scorecardID, err := s.importScorecard(ctx, tenantID, tb.ScorecardID)
	if err != nil {
		return nil, err
	}

	wb, err := readWorkbook(ctx, objs, im.ObjectKey)
	if err != nil {
		return nil, err
	}

	cs, err := importer.Parse(ctx, s.store, *p.Tenant, s.calendar(*p.Tenant), scorecardID, tb.Template, wb)
	if err != nil {
		return nil, err
	}
	cs.ID = im.ID
	cs.CreatedBy = p.UserID
	cs.CreatedAt = s.now()

	raw, err := json.Marshal(storedChangeSet{ScorecardID: scorecardID, ChangeSet: cs})
	if err != nil {
		return nil, err
	}
	if err := objs.Put(ctx, changeSetKey(tenantID, im.ID), "application/json", raw); err != nil {
		return nil, err
	}
	im.Status = importParsed
	im.Profile = profileLegacyWorkbook
	im.TemplateID = templateID
	im.ChangeSet = nil
	if err := s.store.PutImport(ctx, tenantID, im); err != nil {
		return nil, err
	}

	pv := previewOf(cs, countsOf(cs), cs.Findings)
	if err := s.audit(ctx, p, tenantID, "import.parse", "import", im.ID, nil, map[string]any{
		"profile": profileLegacyWorkbook, "templateId": templateID, "scorecardId": scorecardID,
		"counts": pv.Counts, "findings": len(pv.Findings),
	}); err != nil {
		return nil, err
	}
	return ParseImport200JSONResponse(pv), nil
}

// importScorecard picks the scorecard an import writes to: the one the
// template names, else the tenant's only one.
func (s *Server) importScorecard(ctx context.Context, tenantID, named string) (string, error) {
	id, err := importer.ResolveScorecard(ctx, s.store, tenantID, named)
	var ie *importer.Error
	switch {
	case errors.As(err, &ie) && ie.Path != "":
		return "", badRequest("request validation failed", detail{Path: ie.Path, Message: ie.Message})
	case errors.As(err, &ie):
		return "", badRequest(ie.Message)
	}
	return id, err
}

// readUpload loads an uploaded file. The size limit is checked twice:
// against the size the store reports, and while reading, because a store may
// report no size at all. Over the limit is a 413.
func readUpload(ctx context.Context, objs objects.Store, key string) ([]byte, error) {
	over := tooLarge(fmt.Sprintf("the file is larger than %d MiB", objects.MaxUploadBytes>>20))
	rc, size, err := objs.Get(ctx, key)
	if errors.Is(err, objects.ErrNotFound) {
		return nil, notFound("no file has been uploaded for this import")
	}
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	if size > objects.MaxUploadBytes {
		return nil, over
	}
	data, err := io.ReadAll(io.LimitReader(rc, objects.MaxUploadBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > objects.MaxUploadBytes {
		return nil, over
	}
	return data, nil
}

// readWorkbook loads and opens an uploaded workbook.
func readWorkbook(ctx context.Context, objs objects.Store, key string) (*xlsx.Workbook, error) {
	data, err := readUpload(ctx, objs, key)
	if err != nil {
		return nil, err
	}
	wb, err := xlsx.Open(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, badRequest(err.Error())
	}
	return wb, nil
}

// ---- apply ----------------------------------------------------------------------

// ApplyImport applies a parsed change set, or a records preview (see
// applyRecords). An import can be applied once. Admins only.
func (s *Server) ApplyImport(ctx context.Context, req ApplyImportRequestObject) (ApplyImportResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	objs, err := s.objectStore()
	if err != nil {
		return nil, err
	}
	tenantID := p.Tenant.ID
	im, err := s.loadImport(ctx, tenantID, req.Id)
	if err != nil {
		return nil, err
	}
	if im.Status != importParsed {
		return nil, conflict(fmt.Sprintf("import is %s; only a parsed import can be applied", im.Status))
	}
	if im.Profile == profileRecords {
		return s.applyRecords(ctx, p, objs, im, req.Body)
	}

	rc, _, err := objs.Get(ctx, changeSetKey(tenantID, im.ID))
	if errors.Is(err, objects.ErrNotFound) {
		return nil, conflict("the parsed change set is missing; parse the import again")
	}
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var stored storedChangeSet
	if err := json.NewDecoder(io.LimitReader(rc, objects.MaxUploadBytes*4)).Decode(&stored); err != nil {
		return nil, fmt.Errorf("httpapi: decode change set of import %s: %w", im.ID, err)
	}
	cs := stored.ChangeSet
	if cs.ID != im.ID || stored.ScorecardID == "" {
		return nil, fmt.Errorf("httpapi: change set stored for import %s is for %q", im.ID, cs.ID)
	}

	var problemList []detail
	for _, f := range cs.Findings {
		if f.Severity == changeset.SeverityError {
			problemList = append(problemList, detail{Path: findingPath(f), Message: f.Message})
		}
	}
	if len(problemList) > 0 {
		return nil, badRequest("the change set has error findings and cannot be applied", problemList...)
	}
	if problemList, err = s.checkDraftVersions(ctx, tenantID, stored.ScorecardID, cs); err != nil {
		return nil, err
	}
	if len(problemList) > 0 {
		return nil, badRequest("the change set no longer fits the methodology; parse the import again", problemList...)
	}

	res, err := changeset.Apply(ctx, s.store, tenantID, stored.ScorecardID, cs, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("httpapi: apply import %s: %w", im.ID, err)
	}
	im.Status = importApplied
	if err := s.store.PutImport(ctx, tenantID, im); err != nil {
		return nil, err
	}
	// changeset.Apply records the import.apply audit entry itself.

	counts := ImportCounts{DataPoints: res.DataPoints, Overrides: res.Overrides, VersionText: res.VersionText, LegacyNotes: len(cs.Notes)}
	findings := append(slices.Clone(cs.Findings), res.Findings...)
	pv := previewOf(cs, counts, findings)
	pv.Status = ChangeSetPreviewStatus(res.Status)
	return ApplyImport200JSONResponse(pv), nil
}

// checkDraftVersions reports every methodology version a change set writes
// text to that is gone or no longer a draft. Parsing saw the version as a
// draft; it may have been published since.
func (s *Server) checkDraftVersions(ctx context.Context, tenantID, scorecardID string, cs changeset.ChangeSet) ([]detail, error) {
	var out []detail
	seen := map[string]bool{}
	for _, c := range cs.VersionText {
		if seen[c.VersionID] {
			continue
		}
		seen[c.VersionID] = true
		v, err := s.store.GetVersion(ctx, tenantID, scorecardID, c.VersionID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			out = append(out, detail{Path: "versionText", Message: fmt.Sprintf("version %q no longer exists", c.VersionID)})
		case err != nil:
			return nil, err
		case v.Status != domain.VersionDraft:
			out = append(out, detail{Path: "versionText", Message: fmt.Sprintf("version %q is %s; legacy text can only be applied to a draft version", c.VersionID, v.Status)})
		}
	}
	return out, nil
}

func findingPath(f changeset.Finding) string {
	switch {
	case f.Sheet != "" && f.Cell != "":
		return f.Sheet + "!" + f.Cell
	default:
		return f.Sheet
	}
}

// ---- preview --------------------------------------------------------------------

func countsOf(cs changeset.ChangeSet) ImportCounts {
	return ImportCounts{DataPoints: len(cs.Data), Overrides: len(cs.Overrides), VersionText: len(cs.VersionText), LegacyNotes: len(cs.Notes)}
}

// previewOf builds the API view of a change set. The sample takes changes
// round-robin from data points, overrides and version text so a reviewer sees
// every kind present, up to previewSampleSize in all.
func previewOf(cs changeset.ChangeSet, counts ImportCounts, findings []changeset.Finding) ChangeSetPreview {
	pv := ChangeSetPreview{
		Id:       cs.ID,
		Status:   ChangeSetPreviewStatus(cs.Status),
		Counts:   counts,
		Findings: make([]ImportFinding, 0, len(findings)),
		Sample:   []ImportChange{},
	}
	for _, f := range findings {
		pv.Findings = append(pv.Findings, ImportFinding{Severity: ImportFindingSeverity(f.Severity), Sheet: f.Sheet, Cell: f.Cell, Message: f.Message})
	}

	str := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	var lists [3][]ImportChange
	for _, w := range cs.Data {
		dp := w.Point
		per, key, subj := dp.Period.String(), dp.MeasureKey, dp.SubjectID
		lists[0] = append(lists[0], ImportChange{Kind: ImportChangeKindDataPoint, MeasureKey: &key, SubjectId: &subj, Period: &per, Value: dp.Value, NaReason: str(dp.NAReason)})
	}
	for _, o := range cs.Overrides {
		per, key, subj := o.Period.String(), o.MetricKey, o.SubjectID
		lists[1] = append(lists[1], ImportChange{Kind: ImportChangeKindOverride, MetricKey: &key, SubjectId: &subj, Period: &per, Value: o.Value, Status: str(o.Status)})
	}
	for _, v := range cs.VersionText {
		key, field, text := v.MetricKey, v.Field, v.Value
		lists[2] = append(lists[2], ImportChange{Kind: ImportChangeKindVersionText, MetricKey: &key, Field: &field, Text: &text})
	}
	for i := 0; len(pv.Sample) < previewSampleSize; i++ {
		added := false
		for k := range lists {
			if i < len(lists[k]) && len(pv.Sample) < previewSampleSize {
				pv.Sample = append(pv.Sample, lists[k][i])
				added = true
			}
		}
		if !added {
			break
		}
	}
	return pv
}

// ---- templates -------------------------------------------------------------------

// decodeTemplateBody decodes and validates the body of a legacy_workbook
// template (see importer.DecodeTemplateBody). The returned details are empty
// when the template is usable.
func decodeTemplateBody(raw []byte) (importer.TemplateBody, []detail) {
	tb, ps := importer.DecodeTemplateBody(raw)
	var out []detail
	for _, p := range ps {
		out = append(out, detail{Path: p.Path, Message: p.Message})
	}
	return tb, out
}

// validateTemplate checks one template of a request against the tenant's
// record types; path prefixes the problem paths (for example "templates[2]").
func validateTemplate(pr *problems, path string, t ImportTemplate, types []domain.RecordType) (store.Template, bool) {
	before := len(pr.list)
	if path != "" {
		path += "."
	}
	pr.id(path+"id", t.Id)
	pr.nonEmpty(path+"name", t.Name)
	switch string(t.Profile) {
	case profileLegacyWorkbook, profileRecords:
	case profileCSV:
		pr.add(path+"profile", "%s", csvUnavailable)
	default:
		pr.add(path+"profile", "must be legacy_workbook or records")
	}
	raw, err := json.Marshal(t.Body)
	switch {
	case err != nil:
		pr.add(path+"body", "is not valid JSON")
	case string(t.Profile) == profileLegacyWorkbook:
		if _, ds := decodeTemplateBody(raw); len(ds) > 0 {
			for _, d := range ds {
				pr.add(path+d.Path, "%s", d.Message)
			}
		}
	case string(t.Profile) == profileRecords:
		if rt, err := decodeRecordTemplate(raw); err != nil {
			pr.add(path+"body", "is not a records template: %v", err)
		} else {
			validateRecordTemplate(pr, path+"body.", rt, types)
		}
	}
	if len(pr.list) > before {
		return store.Template{}, false
	}
	return store.Template{ID: t.Id, Name: strings.TrimSpace(t.Name), Profile: string(t.Profile), Body: raw}, true
}

func apiTemplate(t store.Template) ImportTemplate {
	body := map[string]interface{}{}
	if len(t.Body) > 0 {
		_ = json.Unmarshal(t.Body, &body)
	}
	if body == nil {
		body = map[string]interface{}{}
	}
	out := ImportTemplate{Id: t.ID, Name: t.Name, Profile: ImportTemplateProfile(t.Profile), Body: body}
	if t.Revision > 0 {
		rev := t.Revision
		out.Revision = &rev
	}
	if t.LastUsed != nil {
		used := t.LastUsed.UTC()
		out.LastUsed = &used
	}
	return out
}

func apiTemplates(ts []store.Template) []ImportTemplate {
	out := make([]ImportTemplate, len(ts))
	for i, t := range ts {
		out[i] = apiTemplate(t)
	}
	return out
}

// ListImportTemplates lists the tenant's import templates. Admins only.
func (s *Server) ListImportTemplates(ctx context.Context, _ ListImportTemplatesRequestObject) (ListImportTemplatesResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	ts, err := s.store.ListTemplates(ctx, p.Tenant.ID)
	if err != nil {
		return nil, err
	}
	return ListImportTemplates200JSONResponse{Templates: apiTemplates(ts)}, nil
}

// PutImportTemplate creates or replaces one template. Admins only.
func (s *Server) PutImportTemplate(ctx context.Context, req PutImportTemplateRequestObject) (PutImportTemplateResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	b := *req.Body
	tenantID := p.Tenant.ID

	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var pr problems
	pr.id("id", req.Id)
	if b.Id != req.Id {
		pr.add("id", "must equal the id in the path (%q)", req.Id)
	}
	t, _ := validateTemplate(&pr, "", b, types)
	if err := pr.err(); err != nil {
		return nil, err
	}

	existing, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var before any
	for _, e := range existing {
		if e.ID == t.ID {
			before = apiTemplate(e)
			t.LastUsed = e.LastUsed
		}
	}
	if err := s.store.PutTemplate(ctx, tenantID, t); err != nil {
		return nil, err
	}
	stored, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for _, e := range stored {
		if e.ID == t.ID {
			t = e // the store assigns the revision
		}
	}
	after := apiTemplate(t)
	if err := s.audit(ctx, p, tenantID, "import_template.put", "import_template", t.ID, before, after); err != nil {
		return nil, err
	}
	return PutImportTemplate200JSONResponse(after), nil
}

// ReplaceImportTemplates replaces the whole set of templates. Every template
// is validated before any is written. Admins only.
func (s *Server) ReplaceImportTemplates(ctx context.Context, req ReplaceImportTemplatesRequestObject) (ReplaceImportTemplatesResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("request body is required")
	}
	tenantID := p.Tenant.ID
	types, err := s.store.ListRecordTypes(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	var pr problems
	next := make([]store.Template, 0, len(req.Body.Templates))
	seen := map[string]int{}
	for i, in := range req.Body.Templates {
		path := fmt.Sprintf("templates[%d]", i)
		if j, dup := seen[in.Id]; dup {
			pr.add(path+".id", "duplicate template id %q (also templates[%d])", in.Id, j)
			continue
		}
		seen[in.Id] = i
		if t, ok := validateTemplate(&pr, path, in, types); ok {
			next = append(next, t)
		}
	}
	if err := pr.err(); err != nil {
		return nil, err
	}

	before, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	lastUsed := map[string]*time.Time{}
	for _, old := range before {
		lastUsed[old.ID] = old.LastUsed
	}
	// Write the new set first and delete the rest last: a failure part-way
	// leaves too many templates, never too few.
	for _, t := range next {
		t.LastUsed = lastUsed[t.ID]
		if err := s.store.PutTemplate(ctx, tenantID, t); err != nil {
			return nil, err
		}
	}
	for _, old := range before {
		if _, keep := seen[old.ID]; keep {
			continue
		}
		if err := s.store.DeleteTemplate(ctx, tenantID, old.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	stored, err := s.store.ListTemplates(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := s.audit(ctx, p, tenantID, "import_templates.replace", "import_templates", "templates", apiTemplates(before), apiTemplates(stored)); err != nil {
		return nil, err
	}
	return ReplaceImportTemplates200JSONResponse{Templates: apiTemplates(stored)}, nil
}
