package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
	"opsvision/internal/objects"
	"opsvision/internal/period"
)

// ---- fixture -----------------------------------------------------------------

const sampleWorkbook = "../legacy/testdata/legacy_sample.xlsx"

// sampleTemplateBody is the template of the committed legacy sample workbook
// (the same document the legacy package tests use).
const sampleTemplateBody = `{
  "sheets": [{"sheet": "Scorecard", "fiscalYear": 2025, "labelColumn": "A",
              "monthColumns": {"F": 1, "G": 2, "H": 3}}],
  "rows": [
    {"sheet": "Scorecard", "label": "Epics on time"},
    {"sheet": "Scorecard", "section": "Epics on time", "label": "North Segment", "metric": "epics_on_time", "subject": "north",
     "convert": "ratio", "measures": {"num": "epics_done", "den": "epics_total"}},
    {"sheet": "Scorecard", "section": "Epics on time", "label": "South Segment", "metric": "epics_on_time", "subject": "south",
     "convert": "ratio", "measures": {"num": "epics_done", "den": "epics_total"}},
    {"sheet": "Scorecard", "label": "Uptime"},
    {"sheet": "Scorecard", "section": "Uptime", "label": "North Segment", "metric": "uptime", "subject": "north",
     "convert": "uptime_percent", "measures": {"down": "seconds_down", "period": "seconds_in_period"}},
    {"sheet": "Scorecard", "section": "Uptime", "label": "South Segment", "metric": "uptime", "subject": "south",
     "convert": "uptime_percent", "measures": {"down": "seconds_down", "period": "seconds_in_period"}}
  ],
  "methodology": [{"sheet": "Methodology", "versionId": "v2-draft",
    "rows": {"Epics on time": "epics_on_time", "Uptime": "uptime"},
    "columns": {"B": "frequency", "C": "definition", "D": "green", "E": "yellow", "F": "red",
                "G": "source", "H": "notes", "I": "link"}}]
}`

func bandsFor(gv, yv float64) []domain.Band {
	return []domain.Band{{Status: "G", Op: ">=", Value: gv}, {Status: "Y", Op: ">=", Value: yv}, {Status: "R"}}
}

// seedLegacy gives tenant t1 what the sample workbook needs: org units
// company > north, south, and scorecard "sc" with a published version in force
// for fiscal year 2025 and a draft for 2026.
func seedLegacy(t *testing.T, e *testEnv) {
	t.Helper()
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(e.store.PutOrgUnit(ctx, "t1", domain.OrgUnit{ID: "company", Name: "Company", LevelID: "co", SourceKeys: []string{}}))
	must(e.store.PutOrgUnit(ctx, "t1", domain.OrgUnit{ID: "north", Name: "North Segment", LevelID: "seg", ParentID: "company", SourceKeys: []string{}}))
	must(e.store.PutOrgUnit(ctx, "t1", domain.OrgUnit{ID: "south", Name: "South Segment", LevelID: "seg", ParentID: "company", SourceKeys: []string{}}))
	must(e.store.PutScorecard(ctx, "t1", domain.Scorecard{ID: "sc", Name: "Scorecard"}))

	metric := func(key, formula, format string, bs []domain.Band) domain.Metric {
		return domain.Metric{
			Key: key, Name: key, Formula: formula, Format: format,
			Direction: domain.DirectionHigherBetter, Frequency: domain.FrequencyMonthly,
			Rule: domain.StatusRule{Type: domain.RuleBands, Bands: bs}, Targets: []domain.Target{},
		}
	}
	content := domain.Methodology{
		Metrics: []domain.Metric{
			metric("epics_on_time", "epics_done / epics_total * 100", domain.FormatPercent0, bandsFor(80, 60)),
			metric("uptime", "(1 - seconds_down / seconds_in_period) * 100", domain.FormatPercent2, bandsFor(99.9, 99.5)),
		},
	}
	for _, k := range []string{"epics_done", "epics_total", "seconds_down", "seconds_in_period"} {
		content.Measures = append(content.Measures, domain.Measure{Key: k, Name: k, OrgAgg: domain.AggSum, TimeAgg: domain.AggSum})
	}
	pub := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	must(e.store.PutVersion(ctx, "t1", domain.MethodologyVersion{
		ID: "v1", ScorecardID: "sc", Name: "v1", Status: domain.VersionPublished, PublishedAt: &pub,
		EffectiveFrom: period.Period{Grain: period.Year, FY: 2025}, Content: content,
	}, 0))
	must(e.store.PutVersion(ctx, "t1", domain.MethodologyVersion{
		ID: "v2-draft", ScorecardID: "sc", Name: "v2", Status: domain.VersionDraft,
		EffectiveFrom: period.Period{Grain: period.Year, FY: 2026}, Content: content,
	}, 0))
}

func readSample(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(sampleWorkbook)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ---- wire types -----------------------------------------------------------------

type uploadJSON struct {
	ImportID  string `json:"importId"`
	UploadURL string `json:"uploadUrl"`
}

type findingJSON struct {
	Severity string `json:"severity"`
	Sheet    string `json:"sheet"`
	Cell     string `json:"cell"`
	Message  string `json:"message"`
}

type previewJSON struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Counts struct {
		DataPoints  int `json:"dataPoints"`
		Overrides   int `json:"overrides"`
		VersionText int `json:"versionText"`
		LegacyNotes int `json:"legacyNotes"`
	} `json:"counts"`
	Findings []findingJSON    `json:"findings"`
	Sample   []map[string]any `json:"sample"`
}

type templateJSON struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Profile string         `json:"profile"`
	Body    map[string]any `json:"body"`
}

func tplBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func sampleTemplate(t *testing.T, id string) templateJSON {
	return templateJSON{ID: id, Name: "Legacy scorecard", Profile: "legacy_workbook", Body: tplBody(t, sampleTemplateBody)}
}

func (e *testEnv) putTemplate(t *testing.T, token string, tpl templateJSON) {
	t.Helper()
	e.expect(t, 200, token, "PUT", "/import-templates/"+tpl.ID, tpl, nil)
}

// createImport starts an import as tenant t1's admin and uploads data as its
// file (skipped when data is nil).
func (e *testEnv) createImport(t *testing.T, data []byte) uploadJSON {
	t.Helper()
	var up uploadJSON
	e.expect(t, 201, e.tokens["t1-admin"], "POST", "/imports/uploads", map[string]string{"filename": "legacy.xlsx"}, &up)
	if data != nil {
		if err := e.objs.Put(context.Background(), uploadKeyOf("t1", up.ImportID), objects.ContentTypeXLSX, data); err != nil {
			t.Fatal(err)
		}
	}
	return up
}

func uploadKeyOf(tenant, id string) string { return "t/" + tenant + "/imports/" + id + ".xlsx" }

func (e *testEnv) parse(t *testing.T, id, templateID string) previewJSON {
	t.Helper()
	var pv previewJSON
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/imports/"+id+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": templateID}, &pv)
	return pv
}

func auditActions(t *testing.T, e *testEnv, tenant string) []string {
	var out []string
	// changeset.Apply stamps its audit entry with the real clock, so look
	// beyond the test clock.
	all, err := e.store.ListAudit(context.Background(), tenant, time.Time{}, time.Now().Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range all {
		out = append(out, a.Action)
	}
	return out
}

func hasAction(actions []string, want string) bool {
	for _, a := range actions {
		if a == want {
			return true
		}
	}
	return false
}

// ---- upload ----------------------------------------------------------------------

func TestCreateImportUpload(t *testing.T) {
	e := newTestEnv(t)
	up := e.createImport(t, nil)
	if up.ImportID == "" {
		t.Fatal("no importId")
	}
	u, err := url.Parse(up.UploadURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/dev/objects/t/t1/imports/"+up.ImportID+".xlsx" {
		t.Errorf("upload path = %s", u.Path)
	}
	exp, sig := u.Query().Get("exp"), u.Query().Get("sig")
	// The objects store signs with the real clock, not the test clock.
	key := uploadKeyOf("t1", up.ImportID)
	if err := objects.Verify(testSecret, key, exp, sig, time.Now()); err != nil {
		t.Errorf("upload URL does not verify: %v", err)
	}
	if err := objects.Verify(testSecret, key, exp, sig, time.Now().Add(objects.UploadTTL+time.Minute)); err != objects.ErrExpired {
		t.Errorf("upload URL must expire after the 15 minute TTL; Verify = %v", err)
	}
	if err := objects.Verify(testSecret, key, exp, sig, time.Now().Add(objects.UploadTTL-time.Minute)); err != nil {
		t.Errorf("upload URL must still be valid just before the TTL; Verify = %v", err)
	}
	if err := objects.Verify(testSecret, key+"x", exp, sig, time.Now()); err == nil {
		t.Error("upload URL verifies for another key")
	}

	im, err := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if err != nil {
		t.Fatal(err)
	}
	if im.Status != "uploaded" || im.ObjectKey != uploadKeyOf("t1", up.ImportID) || im.CreatedBy != "u-t1-admin" || !im.CreatedAt.Equal(testNow) {
		t.Errorf("import = %+v", im)
	}
	if !hasAction(auditActions(t, e, "t1"), "import.create") {
		t.Errorf("no import.create audit entry: %v", auditActions(t, e, "t1"))
	}
}

func TestCreateImportUploadBody(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	// The body is optional.
	e.expect(t, 201, admin, "POST", "/imports/uploads", nil, nil)
	e.expect(t, 201, admin, "POST", "/imports/uploads", map[string]string{"contentType": objects.ContentTypeXLSX}, nil)
	e.expect(t, 201, admin, "POST", "/imports/uploads", map[string]string{"contentType": "text/csv"}, nil)
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/uploads", map[string]string{"contentType": "text/plain"})
}

// ---- parse and apply ----------------------------------------------------------------

func TestUploadParseApply(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))

	pv := e.parse(t, up.ImportID, "legacy-1")
	if pv.ID != up.ImportID || pv.Status != "parsed" {
		t.Fatalf("preview id/status = %q/%q", pv.ID, pv.Status)
	}
	if pv.Counts.DataPoints != 22 || pv.Counts.Overrides == 0 || pv.Counts.VersionText == 0 || pv.Counts.LegacyNotes == 0 {
		t.Errorf("counts = %+v", pv.Counts)
	}
	for _, f := range pv.Findings {
		if f.Severity == "error" {
			t.Errorf("unexpected error finding: %+v", f)
		}
	}
	total := pv.Counts.DataPoints + pv.Counts.Overrides + pv.Counts.VersionText
	if want := min(total, 50); len(pv.Sample) != want {
		t.Errorf("sample has %d entries, want %d", len(pv.Sample), want)
	}
	kinds := map[any]bool{}
	for _, c := range pv.Sample {
		kinds[c["kind"]] = true
	}
	if !kinds["data_point"] || !kinds["override"] || !kinds["version_text"] {
		t.Errorf("sample kinds = %v, want all three", kinds)
	}

	// Nothing is written until the change set is applied.
	pts, _, err := e.store.ListData(context.Background(), "t1", "sc", []int{2025})
	if err != nil || len(pts) != 0 {
		t.Fatalf("data before apply = %d, %v", len(pts), err)
	}

	var applied previewJSON
	e.expect(t, 200, admin, "POST", "/imports/"+up.ImportID+"/apply", nil, &applied)
	if applied.Status != "applied" || applied.ID != up.ImportID {
		t.Fatalf("applied preview = %+v", applied)
	}
	if applied.Counts.DataPoints != 22 || applied.Counts.Overrides != pv.Counts.Overrides || applied.Counts.VersionText != pv.Counts.VersionText {
		t.Errorf("applied counts = %+v, parsed %+v", applied.Counts, pv.Counts)
	}
	pts, ovs, err := e.store.ListData(context.Background(), "t1", "sc", []int{2025})
	if err != nil || len(pts) != 22 || len(ovs) != pv.Counts.Overrides {
		t.Fatalf("data after apply = %d points, %d overrides, %v", len(pts), len(ovs), err)
	}
	for _, p := range pts {
		if p.EnteredBy != "u-t1-admin" || p.Source != domain.SourceLegacy {
			t.Fatalf("point %+v: want entered by the applying admin from the legacy source", p)
		}
	}
	v, err := e.store.GetVersion(context.Background(), "t1", "sc", "v2-draft")
	if err != nil {
		t.Fatal(err)
	}
	if v.Content.Metrics[1].Source != "Monitoring export" {
		t.Errorf("draft version text not applied: %+v", v.Content.Metrics[1])
	}

	im, err := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if err != nil {
		t.Fatal(err)
	}
	if im.Status != "applied" || im.Profile != "legacy_workbook" || im.TemplateID != "legacy-1" {
		t.Errorf("import = %+v", im)
	}

	actions := auditActions(t, e, "t1")
	for _, want := range []string{"import_template.put", "import.create", "import.parse", "import.apply"} {
		if !hasAction(actions, want) {
			t.Errorf("no %s audit entry in %v", want, actions)
		}
	}
}

func TestChangeSetLivesInObjectsNotInTheImportItem(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	e.putTemplate(t, e.tokens["t1-admin"], sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	pv := e.parse(t, up.ImportID, "legacy-1")

	im, err := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if err != nil {
		t.Fatal(err)
	}
	if len(im.ChangeSet) != 0 {
		t.Errorf("Import item holds %d bytes of change set; it belongs in the object store", len(im.ChangeSet))
	}
	rc, _, err := e.objs.Get(context.Background(), "t/t1/imports/"+up.ImportID+".changeset.json")
	if err != nil {
		t.Fatalf("change set object: %v", err)
	}
	defer rc.Close()
	raw, _ := io.ReadAll(rc)
	var stored struct {
		ScorecardID string              `json:"scorecardId"`
		ChangeSet   changeset.ChangeSet `json:"changeSet"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	cs := stored.ChangeSet
	if stored.ScorecardID != "sc" || cs.ID != up.ImportID || cs.CreatedBy != "u-t1-admin" || !cs.CreatedAt.Equal(testNow) ||
		cs.Status != changeset.StatusParsed || len(cs.Data) != pv.Counts.DataPoints {
		t.Errorf("stored change set: scorecard %q, id %q, by %q, at %v, status %q, %d writes", stored.ScorecardID, cs.ID, cs.CreatedBy, cs.CreatedAt, cs.Status, len(cs.Data))
	}
	if ct, _ := e.objs.ContentType("t/t1/imports/" + up.ImportID + ".changeset.json"); ct != "application/json" {
		t.Errorf("change set content type = %q", ct)
	}
}

func TestApplyTwiceConflict(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	e.parse(t, up.ImportID, "legacy-1")
	e.expect(t, 200, admin, "POST", "/imports/"+up.ImportID+"/apply", nil, nil)
	e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+up.ImportID+"/apply", nil)
	// An applied import cannot be parsed again either.
	e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
	// Applying twice wrote nothing twice.
	pts, _, _ := e.store.ListData(context.Background(), "t1", "sc", []int{2025})
	for _, p := range pts {
		if p.Revision != 1 {
			t.Fatalf("point %s/%s revision %d after one apply", p.MeasureKey, p.SubjectID, p.Revision)
		}
	}
}

func TestApplyBeforeParseConflict(t *testing.T) {
	e := newTestEnv(t)
	up := e.createImport(t, readSample(t))
	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/imports/"+up.ImportID+"/apply", nil)
}

func TestReparseThenApply(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	first := e.parse(t, up.ImportID, "legacy-1")

	// A narrower template: only the uptime rows, no methodology.
	narrow := sampleTemplate(t, "legacy-2")
	rows := narrow.Body["rows"].([]any)
	narrow.Body["rows"] = rows[3:]
	delete(narrow.Body, "methodology")
	e.putTemplate(t, admin, narrow)
	second := e.parse(t, up.ImportID, "legacy-2")
	if second.Counts.DataPoints >= first.Counts.DataPoints || second.Counts.VersionText != 0 {
		t.Fatalf("re-parse counts = %+v, first %+v", second.Counts, first.Counts)
	}
	im, _ := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if im.Status != "parsed" || im.TemplateID != "legacy-2" {
		t.Errorf("import after re-parse = %+v", im)
	}

	var applied previewJSON
	e.expect(t, 200, admin, "POST", "/imports/"+up.ImportID+"/apply", nil, &applied)
	if applied.Counts.DataPoints != second.Counts.DataPoints {
		t.Errorf("applied %d points; the latest parse has %d", applied.Counts.DataPoints, second.Counts.DataPoints)
	}
	pts, _, _ := e.store.ListData(context.Background(), "t1", "sc", []int{2025})
	if len(pts) != second.Counts.DataPoints {
		t.Errorf("stored %d points, want %d", len(pts), second.Counts.DataPoints)
	}
}

func TestParseErrors(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	path := "/imports/" + up.ImportID + "/parse"

	got := e.expectError(t, 400, "invalid", admin, "POST", path, map[string]string{"profile": "csv"})
	if got.Error.Message != "csv import is not available yet" {
		t.Errorf("csv message = %q", got.Error.Message)
	}
	e.expectError(t, 400, "invalid", admin, "POST", path, map[string]string{"profile": "legacy_workbook"})
	e.expectError(t, 400, "invalid", admin, "POST", path, map[string]string{"profile": "legacy_workbook", "templateId": "nope"})
	e.expectError(t, 400, "invalid", admin, "POST", path, map[string]string{"profile": "legacy_workbook", "templateId": "bad id!"})
	e.expectError(t, 400, "invalid", admin, "POST", path, map[string]string{"profile": "excel"})
	e.expectError(t, 400, "invalid", admin, "POST", path, nil)
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/missing/parse", map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
}

func TestParseWithoutUploadIsNotFound(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, nil)
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
}

func TestParseRejectsOversizedUpload(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, make([]byte, objects.MaxUploadBytes+1))
	e.expectError(t, 413, "too_large", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
}

func TestParseRejectsANonWorkbook(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, []byte("id,value\n1,2\n"))
	got := e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
	if !strings.Contains(got.Error.Message, "xlsx") {
		t.Errorf("message %q does not carry the parser's reason", got.Error.Message)
	}
	// The import stays uploaded: the person can upload again.
	im, _ := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if im.Status != "uploaded" {
		t.Errorf("status = %q after a failed parse", im.Status)
	}
}

func TestParseScorecardSelection(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	if err := e.store.PutScorecard(context.Background(), "t1", domain.Scorecard{ID: "other", Name: "Other"}); err != nil {
		t.Fatal(err)
	}
	up := e.createImport(t, readSample(t))
	parseReq := func(tpl string) map[string]string {
		return map[string]string{"profile": "legacy_workbook", "templateId": tpl}
	}
	path := "/imports/" + up.ImportID + "/parse"

	// Two scorecards and no scorecardId in the template: ambiguous.
	e.putTemplate(t, admin, sampleTemplate(t, "plain"))
	got := e.expectError(t, 400, "invalid", admin, "POST", path, parseReq("plain"))
	if !strings.Contains(got.Error.Message, "scorecardId") {
		t.Errorf("message = %q, want it to name scorecardId", got.Error.Message)
	}

	named := sampleTemplate(t, "named")
	named.Body["scorecardId"] = "sc"
	e.putTemplate(t, admin, named)
	e.expect(t, 200, admin, "POST", path, parseReq("named"), nil)

	missing := sampleTemplate(t, "missing")
	missing.Body["scorecardId"] = "ghost"
	e.putTemplate(t, admin, missing)
	e.expectError(t, 400, "invalid", admin, "POST", path, parseReq("missing"))
}

func TestParseWithNoScorecardIsRejected(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
}

func TestApplyRefusesErrorFindings(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	bad := sampleTemplate(t, "ghost")
	rows := bad.Body["rows"].([]any)
	rows[1].(map[string]any)["subject"] = "ghost-unit"
	e.putTemplate(t, admin, bad)
	up := e.createImport(t, readSample(t))

	pv := e.parse(t, up.ImportID, "ghost")
	errs := 0
	for _, f := range pv.Findings {
		if f.Severity == "error" {
			errs++
		}
	}
	if errs == 0 {
		t.Fatalf("expected error findings in the preview: %+v", pv.Findings)
	}
	got := e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+up.ImportID+"/apply", nil)
	if len(got.Error.Details) != errs {
		t.Errorf("details = %d, want one per error finding (%d)", len(got.Error.Details), errs)
	}
	pts, _, _ := e.store.ListData(context.Background(), "t1", "sc", []int{2025})
	if len(pts) != 0 {
		t.Errorf("%d points written by a refused apply", len(pts))
	}
	im, _ := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if im.Status != "parsed" {
		t.Errorf("status = %q after a refused apply", im.Status)
	}
}

func TestApplyRefusesAVersionPublishedSinceParse(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	e.parse(t, up.ImportID, "legacy-1")

	ctx := context.Background()
	v, err := e.store.GetVersion(ctx, "t1", "sc", "v2-draft")
	if err != nil {
		t.Fatal(err)
	}
	v.Status = domain.VersionPublished
	if err := e.store.PutVersion(ctx, "t1", v, v.Revision); err != nil {
		t.Fatal(err)
	}
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+up.ImportID+"/apply", nil)
	pts, _, _ := e.store.ListData(ctx, "t1", "sc", []int{2025})
	if len(pts) != 0 {
		t.Errorf("%d points written by a refused apply", len(pts))
	}
}

// ---- tenancy and roles ---------------------------------------------------------------

func TestCrossTenantImport(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	e.putTemplate(t, e.tokens["t1-admin"], sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	e.parse(t, up.ImportID, "legacy-1")

	other := e.tokens["t2-admin"]
	e.expectError(t, 404, "not_found", other, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
	e.expectError(t, 404, "not_found", other, "POST", "/imports/"+up.ImportID+"/apply", nil)

	// Tenant t2 cannot see t1's templates, and t1's import is still parsed.
	var list struct {
		Templates []templateJSON `json:"templates"`
	}
	e.expect(t, 200, other, "GET", "/import-templates", nil, &list)
	if len(list.Templates) != 0 {
		t.Errorf("t2 sees templates %+v", list.Templates)
	}
	im, _ := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if im.Status != "parsed" {
		t.Errorf("t1 import status = %q", im.Status)
	}
}

func TestImportEndpointsAreAdminOnly(t *testing.T) {
	e := newTestEnv(t)
	seedLegacy(t, e)
	e.putTemplate(t, e.tokens["t1-admin"], sampleTemplate(t, "legacy-1"))
	up := e.createImport(t, readSample(t))
	tpl := sampleTemplate(t, "legacy-1")

	ops := []struct {
		name, method, path string
		body               any
	}{
		{"createImportUpload", "POST", "/imports/uploads", nil},
		{"parseImport", "POST", "/imports/" + up.ImportID + "/parse", map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"}},
		{"applyImport", "POST", "/imports/" + up.ImportID + "/apply", nil},
		{"listImportTemplates", "GET", "/import-templates", nil},
		{"replaceImportTemplates", "PUT", "/import-templates", map[string]any{"templates": []templateJSON{tpl}}},
		{"putImportTemplate", "PUT", "/import-templates/legacy-1", tpl},
		{"listAudit", "GET", "/audit?from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z", nil},
	}
	for _, role := range []string{"t1-contributor", "t1-viewer"} {
		for _, op := range ops {
			e.expectError(t, 403, "forbidden", e.tokens[role], op.method, op.path, op.body)
		}
	}
	for _, op := range ops {
		e.expectError(t, 401, "unauthorized", "", op.method, op.path, op.body)
	}
	// None of the refused calls changed anything.
	im, _ := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if im.Status != "uploaded" {
		t.Errorf("import status = %q", im.Status)
	}
}

// ---- templates ----------------------------------------------------------------------

func TestTemplateValidation(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]

	unknownConvert := sampleTemplate(t, "tpl")
	unknownConvert.Body["rows"].([]any)[1].(map[string]any)["convert"] = "bogus"
	got := e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", unknownConvert)
	if len(got.Error.Details) == 0 || !strings.Contains(got.Error.Details[0].Message, "bogus") {
		t.Errorf("details = %+v, want the unknown converter named", got.Error.Details)
	}

	unknownField := sampleTemplate(t, "tpl")
	unknownField.Body["extra"] = true
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", unknownField)

	empty := templateJSON{ID: "tpl", Name: "Empty", Profile: "legacy_workbook", Body: map[string]any{}}
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", empty)

	csv := sampleTemplate(t, "tpl")
	csv.Profile = "csv"
	got = e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", csv)
	if len(got.Error.Details) == 0 || !strings.Contains(got.Error.Details[0].Message, "csv import is not available yet") {
		t.Errorf("csv details = %+v", got.Error.Details)
	}

	noName := sampleTemplate(t, "tpl")
	noName.Name = "  "
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", noName)

	mismatch := sampleTemplate(t, "other")
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", mismatch)

	badScorecard := sampleTemplate(t, "tpl")
	badScorecard.Body["scorecardId"] = "bad id!"
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/tpl", badScorecard)

	var list struct {
		Templates []templateJSON `json:"templates"`
	}
	e.expect(t, 200, admin, "GET", "/import-templates", nil, &list)
	if len(list.Templates) != 0 {
		t.Errorf("rejected templates were stored: %+v", list.Templates)
	}
}

func TestPutAndListTemplates(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	b := sampleTemplate(t, "b-tpl")
	a := sampleTemplate(t, "a-tpl")
	a.Name = "First"
	e.putTemplate(t, admin, b)
	e.putTemplate(t, admin, a)
	a.Name = "First, renamed"
	var stored templateJSON
	e.expect(t, 200, admin, "PUT", "/import-templates/a-tpl", a, &stored)
	if stored.ID != "a-tpl" || stored.Name != "First, renamed" || stored.Profile != "legacy_workbook" || stored.Body["sheets"] == nil {
		t.Errorf("stored = %+v", stored)
	}

	var list struct {
		Templates []templateJSON `json:"templates"`
	}
	e.expect(t, 200, admin, "GET", "/import-templates", nil, &list)
	if len(list.Templates) != 2 || list.Templates[0].ID != "a-tpl" || list.Templates[1].ID != "b-tpl" || list.Templates[0].Name != "First, renamed" {
		t.Errorf("list = %+v", list.Templates)
	}
	if got := auditActions(t, e, "t1"); strings.Count(strings.Join(got, ","), "import_template.put") != 3 {
		t.Errorf("audit actions = %v, want three import_template.put", got)
	}
}

func TestReplaceTemplates(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "old-1"))
	e.putTemplate(t, admin, sampleTemplate(t, "keep"))

	// One invalid template rejects the whole replacement; nothing changes.
	bad := sampleTemplate(t, "new-1")
	bad.Body["rows"].([]any)[1].(map[string]any)["convert"] = "bogus"
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates", map[string]any{"templates": []templateJSON{sampleTemplate(t, "keep"), bad}})
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates", map[string]any{"templates": []templateJSON{sampleTemplate(t, "keep"), sampleTemplate(t, "keep")}})

	var list struct {
		Templates []templateJSON `json:"templates"`
	}
	e.expect(t, 200, admin, "GET", "/import-templates", nil, &list)
	if len(list.Templates) != 2 {
		t.Fatalf("a rejected replacement changed the set: %+v", list.Templates)
	}

	renamed := sampleTemplate(t, "keep")
	renamed.Name = "Renamed"
	e.expect(t, 200, admin, "PUT", "/import-templates", map[string]any{"templates": []templateJSON{renamed, sampleTemplate(t, "new-1")}}, &list)
	if len(list.Templates) != 2 || list.Templates[0].ID != "keep" || list.Templates[0].Name != "Renamed" || list.Templates[1].ID != "new-1" {
		t.Errorf("replace response = %+v", list.Templates)
	}
	list.Templates = nil
	e.expect(t, 200, admin, "GET", "/import-templates", nil, &list)
	if len(list.Templates) != 2 || list.Templates[0].ID != "keep" || list.Templates[1].ID != "new-1" {
		t.Errorf("stored set = %+v; old-1 must be gone", list.Templates)
	}
	if !hasAction(auditActions(t, e, "t1"), "import_templates.replace") {
		t.Errorf("no import_templates.replace audit entry: %v", auditActions(t, e, "t1"))
	}

	// An empty set clears every template.
	e.expect(t, 200, admin, "PUT", "/import-templates", map[string]any{"templates": []templateJSON{}}, &list)
	if len(list.Templates) != 0 {
		t.Errorf("cleared set = %+v", list.Templates)
	}
}

// ---- audit -----------------------------------------------------------------------------

func TestListAudit(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	e.createImport(t, nil)

	type auditList struct {
		Entries []struct {
			ID     string `json:"id"`
			Action string `json:"action"`
			At     string `json:"at"`
		} `json:"entries"`
	}
	q := func(from, to time.Time) string {
		v := url.Values{"from": {from.Format(time.RFC3339)}, "to": {to.Format(time.RFC3339)}}
		return "/audit?" + v.Encode()
	}
	var got auditList
	e.expect(t, 200, admin, "GET", q(testNow.Add(-time.Hour), testNow.Add(time.Hour)), nil, &got)
	if len(got.Entries) != 2 {
		t.Fatalf("entries = %+v, want 2", got.Entries)
	}
	// Newest first; same-instant entries by descending ID.
	if got.Entries[0].Action != "import.create" || got.Entries[1].Action != "import_template.put" {
		t.Errorf("order = %s, %s", got.Entries[0].Action, got.Entries[1].Action)
	}

	// The range is half-open: to is exclusive, from inclusive.
	got = auditList{}
	e.expect(t, 200, admin, "GET", q(testNow.Add(-time.Hour), testNow), nil, &got)
	if len(got.Entries) != 0 {
		t.Errorf("to must be exclusive: %+v", got.Entries)
	}
	e.expect(t, 200, admin, "GET", q(testNow, testNow.Add(time.Hour)), nil, &got)
	if len(got.Entries) != 2 {
		t.Errorf("from must be inclusive: %+v", got.Entries)
	}

	// Another tenant's audit log is its own.
	got = auditList{}
	e.expect(t, 200, e.tokens["t2-admin"], "GET", q(testNow.Add(-time.Hour), testNow.Add(time.Hour)), nil, &got)
	if len(got.Entries) != 0 {
		t.Errorf("t2 sees %+v", got.Entries)
	}
}

func TestListAuditRangeValidation(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	from := testNow.Add(-time.Hour)
	f := func(t time.Time) string { return url.QueryEscape(t.Format(time.RFC3339)) }

	e.expectError(t, 400, "invalid", admin, "GET", "/audit", nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?from="+f(from), nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?to="+f(testNow), nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?from=yesterday&to="+f(testNow), nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?from="+f(testNow)+"&to="+f(from), nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?from="+f(testNow)+"&to="+f(testNow), nil)
	// 31 days is the longest range.
	e.expect(t, 200, admin, "GET", "/audit?from="+f(from)+"&to="+f(from.AddDate(0, 0, 31)), nil, nil)
	e.expectError(t, 400, "invalid", admin, "GET", "/audit?from="+f(from)+"&to="+f(from.AddDate(0, 0, 31).Add(time.Second)), nil)
}

// ---- misc ---------------------------------------------------------------------------------

func TestImportServerWithoutObjectsFailsCleanly(t *testing.T) {
	e := newTestEnv(t)
	s := NewServer(Deps{Store: e.store})
	if _, err := s.objectStore(); err == nil {
		t.Fatal("objectStore with no Deps.Objects must fail")
	}
}
