package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// ---- fixture -----------------------------------------------------------------
//
// A small synthetic Acme Demo tenant (t1): Acme > Commerce (Checkout, Billing)
// and Insights (Analytics), a defect record type, and scorecard "sc" with a
// published version whose defect score is derived from records. The defects
// export is records/testdata/defects.csv, read as of 2026-09-15.

const defectsFixture = "../records/testdata/defects.csv"

func readDefects(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(defectsFixture)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var defectWeights = map[string]float64{"P1": 64, "P2": 16, "P3": 4, "P4": 2, "none": 1}

func defectMethodology(weights map[string]float64) domain.Methodology {
	derived := func(key, name string, rule domain.DeriveRule) domain.Measure {
		return domain.Measure{Key: key, Name: name, Unit: "points", OrgAgg: domain.AggSum, TimeAgg: domain.AggSum,
			Source: domain.MeasureDerived, Derive: &rule}
	}
	return domain.Methodology{
		Categories: []domain.Category{{ID: "quality", Name: "Quality", Order: 1}},
		Measures: []domain.Measure{
			derived("defect_points_sum", "Defect points", domain.DeriveRule{RecordType: "defect", Op: domain.OpDailyOpenWeighted,
				Where: "category == 'Bug'", Weights: weights}),
			derived("defect_days", "Defect days", domain.DeriveRule{RecordType: "defect", Op: domain.OpDaysInPeriod}),
		},
		Metrics: []domain.Metric{{
			Key: "defect_score", Name: "Defect score", CategoryID: "quality", Formula: "defect_points_sum / defect_days",
			Format: domain.FormatNumber1, Direction: domain.DirectionLowerBetter, Frequency: domain.FrequencyMonthly,
			ReportedAt: []domain.Subject{{Kind: domain.SubjectLevel, ID: "product"}, {Kind: domain.SubjectLevel, ID: "segment"}, {Kind: domain.SubjectLevel, ID: "company"}},
			Rule: domain.StatusRule{Type: domain.RuleBands, Bands: []domain.Band{
				{Status: "G", Op: "<=", Value: 10}, {Status: "Y", Op: "<=", Value: 50}, {Status: "R"}}},
			Targets: []domain.Target{},
		}},
	}
}

// seedRecords gives tenant t1 the org, the defect record type, and scorecard
// sc with v1 published from 2026-M01.
func seedRecords(t *testing.T, e *testEnv) {
	t.Helper()
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(e.store.PutLevels(ctx, "t1", []domain.Level{
		{ID: "company", Name: "Company", Depth: 0}, {ID: "segment", Name: "Segment", Depth: 1}, {ID: "product", Name: "Product", Depth: 2},
	}))
	for _, u := range []domain.OrgUnit{
		{ID: "acme", Name: "Acme", LevelID: "company", SourceKeys: []string{}},
		{ID: "commerce", Name: "Commerce", LevelID: "segment", ParentID: "acme", SourceKeys: []string{}},
		{ID: "insights", Name: "Insights", LevelID: "segment", ParentID: "acme", SourceKeys: []string{}},
		{ID: "checkout", Name: "Checkout", LevelID: "product", ParentID: "commerce", SourceKeys: []string{"Checkout"}},
		{ID: "billing", Name: "Billing", LevelID: "product", ParentID: "commerce", SourceKeys: []string{"Billing"}},
		{ID: "analytics", Name: "Analytics", LevelID: "product", ParentID: "insights", SourceKeys: []string{}},
	} {
		must(e.store.PutOrgUnit(ctx, "t1", u))
	}
	must(e.store.PutRecordType(ctx, "t1", domain.RecordType{ID: "defect", Name: "Defect", Priorities: []string{"P1", "P2", "P3", "P4"}}, 0))
	must(e.store.PutScorecard(ctx, "t1", domain.Scorecard{ID: "sc", Name: "Quality"}))
	pub := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	must(e.store.PutVersion(ctx, "t1", domain.MethodologyVersion{
		ID: "v1", ScorecardID: "sc", Name: "2026", Status: domain.VersionPublished, PublishedAt: &pub,
		EffectiveFrom: period.Period{Grain: period.Month, FY: 2026, Index: 1}, Content: defectMethodology(defectWeights),
	}, 0))
}

// defectsTemplate maps the defects export to the defect record type.
func defectsTemplate() map[string]any {
	return map[string]any{
		"name": "Tracker defects", "recordType": "defect", "source": "tracker",
		"file": map[string]any{"format": "csv", "headerRow": 1}, "fullExport": false,
		"fields": map[string]any{
			"externalId":  map[string]any{"column": "Issue key"},
			"title":       map[string]any{"column": "Summary"},
			"category":    map[string]any{"column": "Issue Type"},
			"priority":    map[string]any{"column": "Priority", "map": map[string]string{"Highest": "P1", "High": "P2", "Medium": "P3", "Low": "P4"}, "default": "none"},
			"status":      map[string]any{"column": "Status"},
			"state":       map[string]any{"column": "Status", "map": map[string]string{"Done": "done", "Closed": "done", "Won't Do": "cancelled", "*": "open"}},
			"subjectKey":  map[string]any{"column": "Product"},
			"createdAt":   map[string]any{"column": "Created", "dateFormats": []string{"2006-01-02 15:04", "02/Jan/06 3:04 PM"}},
			"completedAt": map[string]any{"column": "Resolved", "dateFormats": []string{"2006-01-02 15:04"}},
		},
	}
}

func (e *testEnv) putRecordsTemplate(t *testing.T, id string) {
	t.Helper()
	e.expect(t, 200, e.tokens["t1-admin"], "PUT", "/import-templates/"+id,
		map[string]any{"id": id, "name": "Tracker defects", "profile": "records", "body": defectsTemplate()}, nil)
}

// createCSVImport starts a CSV import as tenant's admin and uploads data.
func (e *testEnv) createCSVImport(t *testing.T, tenant string, data []byte) string {
	t.Helper()
	var up uploadJSON
	e.expect(t, 201, e.tokens[tenant+"-admin"], "POST", "/imports/uploads", map[string]string{"filename": "defects.csv", "contentType": "text/csv"}, &up)
	key := "t/" + tenant + "/imports/" + up.ImportID + ".csv"
	if data != nil {
		if err := e.objs.Put(context.Background(), key, "text/csv", data); err != nil {
			t.Fatal(err)
		}
	}
	return up.ImportID
}

// defectAnswers settle everything the defects export asks: Analytics is the
// analytics unit, and the mobile apps are ignored.
func defectAnswers() map[string]any {
	return map[string]any{
		"sourceKeys":   map[string]string{"Analytics": "analytics"},
		"ignoreValues": []string{"iOS App", "Android App"},
	}
}

func previewBody(answers map[string]any) map[string]any {
	return map[string]any{"scorecardId": "sc", "asOf": "2026-09-15", "templateId": "defects", "answers": answers}
}

type recordsPreviewJSON struct {
	PlanID string `json:"planId"`
	Counts struct {
		New, Changed, Unchanged, Skipped, Missing, Unmatched, Errors int
	} `json:"counts"`
	Story struct {
		NothingChanged bool `json:"nothingChanged"`
		Lines          []struct {
			Period, MetricKey, SubjectID, BeforeDisplay, AfterDisplay string
			Reasons                                                   map[string][]map[string]any
		} `json:"lines"`
		More  int              `json:"more"`
		Typed []map[string]any `json:"typed"`
	} `json:"story"`
	Problems  []map[string]any `json:"problems"`
	Unmatched []struct {
		Value     string `json:"value"`
		Rows      int    `json:"rows"`
		SubjectID string `json:"subjectId"`
	} `json:"unmatched"`
	Parents   []map[string]any            `json:"parents"`
	NewValues map[string][]map[string]any `json:"newValues"`
	Missing   []string                    `json:"missing"`
}

// previewPlan previews import id with body as the tenant's admin and returns the preview's planId.
func previewPlan(t *testing.T, e *testEnv, id string, body map[string]any) string {
	t.Helper()
	var pv recordsPreviewJSON
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/imports/"+id+"/records-preview", body, &pv)
	if pv.PlanID == "" {
		t.Fatal("preview has no planId")
	}
	return pv.PlanID
}

// applyDefects runs the whole flow for the defects export with the standard
// answers and returns the import ID.
func applyDefects(t *testing.T, e *testEnv) string {
	t.Helper()
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", readDefects(t))
	admin := e.tokens["t1-admin"]
	plan := previewPlan(t, e, id, previewBody(defectAnswers()))
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": plan, "answers": defectAnswers()}, nil)
	return id
}

func storedPoint(t *testing.T, e *testEnv, measure, subject string, p period.Period) (domain.DataPoint, bool) {
	t.Helper()
	pts, _, err := e.store.ListData(context.Background(), "t1", "sc", []int{p.FY})
	if err != nil {
		t.Fatal(err)
	}
	for _, dp := range pts {
		if dp.MeasureKey == measure && dp.SubjectID == subject && dp.Period == p {
			return dp, true
		}
	}
	return domain.DataPoint{}, false
}

var sep2026 = period.Period{Grain: period.Month, FY: 2026, Index: 9}

func viewCell(t *testing.T, e *testEnv, token, query, metric, subject string) map[string]any {
	t.Helper()
	var v struct {
		Rows []struct {
			MetricKey string           `json:"metricKey"`
			SubjectID string           `json:"subjectId"`
			Cells     []map[string]any `json:"cells"`
		} `json:"rows"`
	}
	e.expect(t, 200, token, "GET", "/scorecards/sc/view?"+query, nil, &v)
	for _, r := range v.Rows {
		if r.MetricKey == metric && r.SubjectID == subject && len(r.Cells) > 0 {
			return r.Cells[0]
		}
	}
	t.Fatalf("no %s row for %s in view %s", metric, subject, query)
	return nil
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

// ---- import flow -----------------------------------------------------------------

func TestRecordsUploadInspectPreviewApply(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", readDefects(t))

	// Inspect: headers, guesses, and subject suggestions.
	var ins struct {
		Inspection struct {
			Headers           []string         `json:"headers"`
			RowCount          int              `json:"rowCount"`
			Guesses           []map[string]any `json:"guesses"`
			MatchedTemplateID string           `json:"matchedTemplateId"`
			Draft             map[string]any   `json:"draft"`
		} `json:"inspection"`
		Subjects []struct {
			Value     string `json:"value"`
			Rows      int    `json:"rows"`
			SubjectID string `json:"subjectId"`
		} `json:"subjects"`
	}
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/inspect", nil, &ins)
	if len(ins.Inspection.Headers) != 9 || ins.Inspection.RowCount != 11 {
		t.Errorf("inspection headers/rows = %v/%d", ins.Inspection.Headers, ins.Inspection.RowCount)
	}
	if ins.Inspection.MatchedTemplateID != "defects" {
		t.Errorf("matchedTemplateId = %q, want defects", ins.Inspection.MatchedTemplateID)
	}
	guessed := map[string]string{}
	for _, g := range ins.Inspection.Guesses {
		guessed[fmt.Sprint(g["field"])] = fmt.Sprint(g["column"])
	}
	if guessed["externalId"] != "Issue key" || guessed["subjectKey"] != "Product" {
		t.Errorf("guesses = %v", guessed)
	}
	sugg := map[string]string{}
	for _, s := range ins.Subjects {
		sugg[s.Value] = s.SubjectID
	}
	if sugg["Analytics"] != "analytics" || sugg["Checkout"] != "checkout" {
		t.Errorf("subject suggestions = %+v", ins.Subjects)
	}

	// Preview without answers: Analytics and the mobile apps are unmatched.
	var pv recordsPreviewJSON
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/records-preview", previewBody(map[string]any{}), &pv)
	if pv.Counts.Unmatched != 4 || pv.Counts.New != 7 {
		t.Errorf("unanswered counts = %+v", pv.Counts)
	}
	values := map[string]string{}
	for _, u := range pv.Unmatched {
		values[u.Value] = u.SubjectID
	}
	if v, ok := values["Analytics"]; !ok || v != "analytics" {
		t.Errorf("unmatched = %+v, want Analytics suggested as analytics", pv.Unmatched)
	}
	im, err := e.store.GetImport(context.Background(), "t1", id)
	if err != nil {
		t.Fatal(err)
	}
	if im.Status != "parsed" || im.Profile != "records" || im.TemplateID != "defects" {
		t.Errorf("import after preview = %+v", im)
	}

	// Preview with answers.
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/records-preview", previewBody(defectAnswers()), &pv)
	if pv.Counts.New != 9 || pv.Counts.Skipped != 2 || pv.Counts.Unmatched != 0 || pv.Counts.Errors != 0 {
		t.Errorf("answered counts = %+v", pv.Counts)
	}
	if pv.Story.NothingChanged || len(pv.Story.Lines) == 0 {
		t.Errorf("story = %+v, want lines", pv.Story)
	}
	if pv.Missing == nil || pv.Problems == nil || pv.Unmatched == nil || pv.Parents == nil || pv.NewValues == nil {
		t.Errorf("preview lists must be non-null: %+v", pv)
	}
	// Nothing is stored before apply.
	if _, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); ok {
		t.Fatal("preview stored a derived point")
	}

	// Apply, saving the template under a new ID.
	var applied map[string]any
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/apply", map[string]any{
		"planId": pv.PlanID, "answers": defectAnswers(), "saveTemplate": map[string]string{"id": "defects-v2", "name": "Defects (saved)"},
	}, &applied)
	if applied["status"] != "applied" {
		t.Errorf("apply response = %v", applied)
	}

	// Derived points: CHK-101 (P1) is open 13 days of September through the
	// 15th; BIL-203 (no priority) 14 days; ANL-301 (P2) 6 and ANL-302 (P4) 2.
	for subject, want := range map[string]float64{"checkout": 832, "billing": 14, "analytics": 100} {
		dp, ok := storedPoint(t, e, "defect_points_sum", subject, sep2026)
		if !ok || dp.Value == nil || !near(*dp.Value, want) || dp.Source != domain.SourceRecords {
			t.Errorf("defect_points_sum %s = %+v, want %v from records", subject, dp, want)
		}
	}
	if dp, ok := storedPoint(t, e, "defect_points_sum", "commerce", sep2026); ok {
		t.Errorf("a derived point was written on parent unit commerce: %+v", dp)
	}

	// The view shows the derived values, rolled up too.
	cell := viewCell(t, e, e.tokens["t1-viewer"], "periods=2026-M09", "defect_score", "checkout")
	if v, ok := cell["value"].(float64); !ok || !near(v, 832.0/15) {
		t.Errorf("checkout defect score cell = %v, want %v", cell, 832.0/15)
	}
	cell = viewCell(t, e, e.tokens["t1-viewer"], "periods=2026-M09", "defect_score", "commerce")
	if v, ok := cell["value"].(float64); !ok || !near(v, 846.0/30) {
		t.Errorf("commerce defect score cell = %v, want %v", cell, 846.0/30)
	}

	// The answered source key was saved, and the template too.
	units, err := e.store.ListOrgUnits(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range units {
		if u.ID == "analytics" && (len(u.SourceKeys) != 1 || u.SourceKeys[0] != "Analytics") {
			t.Errorf("analytics source keys = %v", u.SourceKeys)
		}
	}
	tpls, err := e.store.ListTemplates(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	var saved, used *store.Template
	for i := range tpls {
		switch tpls[i].ID {
		case "defects-v2":
			saved = &tpls[i]
		case "defects":
			used = &tpls[i]
		}
	}
	if saved == nil || saved.Profile != "records" || saved.Name != "Defects (saved)" || saved.LastUsed == nil {
		t.Fatalf("saved template = %+v", saved)
	}
	if used == nil || used.LastUsed == nil || used.Revision != 1 {
		t.Errorf("used template = %+v, want lastUsed set and revision kept", used)
	}
	im, _ = e.store.GetImport(context.Background(), "t1", id)
	if im.Status != "applied" {
		t.Errorf("import status = %q", im.Status)
	}
	snaps, err := e.store.ListSnapshots(context.Background(), "t1", "defect")
	if err != nil || len(snaps) != 1 {
		t.Fatalf("snapshots = %+v, %v", snaps, err)
	}
	if snaps[0].TemplateID != "defects" || snaps[0].TemplateRevision != 1 || snaps[0].AsOf.String() != "2026-09-15" {
		t.Errorf("snapshot = %+v", snaps[0])
	}
}

func TestInspectLastUploadAsOf(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	inspect := func(id string) map[string]any {
		t.Helper()
		var out struct {
			Inspection map[string]any `json:"inspection"`
		}
		e.expect(t, 200, admin, "POST", "/imports/"+id+"/inspect", nil, &out)
		return out.Inspection
	}

	// No template matches: absent.
	other := e.createCSVImport(t, "t1", []byte("Ticket,Owner\nT-1,Ana\n"))
	if v, ok := inspect(other)["lastUploadAsOf"]; ok {
		t.Errorf("unmatched file: lastUploadAsOf = %v, want absent", v)
	}

	// A template matches, but nothing has been uploaded for it: absent.
	e.putRecordsTemplate(t, "defects")
	first := e.createCSVImport(t, "t1", readDefects(t))
	if v, ok := inspect(first)["lastUploadAsOf"]; ok {
		t.Errorf("no snapshot yet: lastUploadAsOf = %v, want absent", v)
	}

	// A later snapshot of the same record type from another source does not count.
	at := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	if err := e.store.ApplySnapshot(context.Background(), "t1", domain.Snapshot{
		ID: "snap-other", RecordType: "defect", Source: "helpdesk", AsOf: domain.Date{Time: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)},
		CreatedAt: at, Counts: map[string]int{},
	}, nil); err != nil {
		t.Fatal(err)
	}

	// After applying the defects export as of 2026-09-15, the next upload names that date.
	plan := previewPlan(t, e, first, previewBody(defectAnswers()))
	e.expect(t, 200, admin, "POST", "/imports/"+first+"/apply", map[string]any{"planId": plan, "answers": defectAnswers()}, nil)
	next := e.createCSVImport(t, "t1", readDefects(t))
	got := inspect(next)
	if got["matchedTemplateId"] != "defects" || got["lastUploadAsOf"] != "2026-09-15" {
		t.Errorf("after apply: matchedTemplateId = %v, lastUploadAsOf = %v, want defects and 2026-09-15",
			got["matchedTemplateId"], got["lastUploadAsOf"])
	}
}

func TestRecordsPreviewInlineTemplateAndXLSXUpload(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	id := e.createCSVImport(t, "t1", readDefects(t))
	body := map[string]any{"scorecardId": "sc", "asOf": "2026-09-15", "template": defectsTemplate(), "answers": defectAnswers()}
	var pv recordsPreviewJSON
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/records-preview", body, &pv)
	if pv.Counts.New != 9 {
		t.Errorf("inline template counts = %+v", pv.Counts)
	}
	// Exactly one of templateId and template.
	both := previewBody(defectAnswers())
	both["template"] = defectsTemplate()
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+id+"/records-preview", both)
	neither := map[string]any{"scorecardId": "sc", "asOf": "2026-09-15", "answers": map[string]any{}}
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+id+"/records-preview", neither)
	// An invalid inline template is reported under template.
	bad := defectsTemplate()
	delete(bad["fields"].(map[string]any), "state")
	got := e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+id+"/records-preview",
		map[string]any{"scorecardId": "sc", "asOf": "2026-09-15", "template": bad, "answers": map[string]any{}})
	if !hasDetail(got, "template.fields.state") {
		t.Errorf("details = %+v, want template.fields.state", got.Error.Details)
	}
	// An unknown scorecard is a 404.
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/"+id+"/records-preview",
		map[string]any{"scorecardId": "nope", "asOf": "2026-09-15", "template": defectsTemplate(), "answers": map[string]any{}})

	// A workbook upload is read from its first visible sheet.
	wb, err := os.ReadFile("../records/testdata/epics_dec.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	up := e.createImport(t, wb)
	var ins struct {
		Inspection struct {
			Headers  []string `json:"headers"`
			RowCount int      `json:"rowCount"`
		} `json:"inspection"`
	}
	e.expect(t, 200, admin, "POST", "/imports/"+up.ImportID+"/inspect", nil, &ins)
	if len(ins.Inspection.Headers) == 0 || ins.Inspection.RowCount == 0 {
		t.Errorf("workbook inspection = %+v", ins.Inspection)
	}
}

func hasDetail(got apiErrorBody, path string) bool {
	for _, d := range got.Error.Details {
		if d.Path == path {
			return true
		}
	}
	return false
}

func TestRecordsApplyTwiceConflict(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	id := applyDefects(t, e)
	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/imports/"+id+"/apply", map[string]any{"answers": defectAnswers()})
	// A preview of an applied import conflicts too.
	e.expectError(t, 409, "conflict", e.tokens["t1-admin"], "POST", "/imports/"+id+"/records-preview", previewBody(defectAnswers()))
}

func TestRecordsApplyStalePreview409(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", readDefects(t))
	plan := previewPlan(t, e, id, previewBody(defectAnswers()))

	got := e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": plan, "answers": map[string]any{}})
	if !strings.Contains(got.Error.Message, "preview is out of date") {
		t.Errorf("message = %q", got.Error.Message)
	}
	other := defectAnswers()
	other["ignoreValues"] = []string{"iOS App"}
	e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": plan, "answers": other})
	if _, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); ok {
		t.Fatal("a stale apply stored derived points")
	}
	// The same answers in another order still match.
	same := map[string]any{"ignoreValues": []string{"Android App", "iOS App"}, "sourceKeys": map[string]string{"Analytics": "analytics"}}
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": plan, "answers": same}, nil)
	// An import that was never previewed cannot be applied as records.
	fresh := e.createCSVImport(t, "t1", readDefects(t))
	e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+fresh+"/apply", map[string]any{"planId": plan, "answers": defectAnswers()})
}

func TestRecordsApplyRequiresTheLatestPlan(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", readDefects(t))
	older := previewPlan(t, e, id, previewBody(defectAnswers()))
	latest := previewPlan(t, e, id, previewBody(defectAnswers()))
	if older == latest {
		t.Fatalf("two previews share planId %q", older)
	}

	// The same answers, but the plan of an earlier preview: not the one stored.
	got := e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": older, "answers": defectAnswers()})
	if !strings.Contains(got.Error.Message, "preview is out of date") {
		t.Errorf("message = %q", got.Error.Message)
	}
	// No planId at all.
	e.expectError(t, 409, "conflict", admin, "POST", "/imports/"+id+"/apply", map[string]any{"answers": defectAnswers()})
	if _, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); ok {
		t.Fatal("an apply of an older plan stored derived points")
	}

	var applied struct {
		Records struct {
			SnapshotID string `json:"snapshotId"`
		} `json:"records"`
	}
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": latest, "answers": defectAnswers()}, &applied)
	if applied.Records.SnapshotID != latest {
		t.Errorf("applied snapshot %q, want the latest plan %q", applied.Records.SnapshotID, latest)
	}
	if _, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); !ok {
		t.Error("applying the latest plan stored no derived points")
	}
}

func TestContributorCannotApplyRecords(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", readDefects(t))
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/records-preview", previewBody(defectAnswers()), nil)
	for _, role := range []string{"contributor", "viewer"} {
		tok := e.tokens["t1-"+role]
		e.expectError(t, 403, "forbidden", tok, "POST", "/imports/"+id+"/apply", map[string]any{"answers": defectAnswers()})
		e.expectError(t, 403, "forbidden", tok, "POST", "/imports/"+id+"/inspect", nil)
		e.expectError(t, 403, "forbidden", tok, "POST", "/imports/"+id+"/records-preview", previewBody(defectAnswers()))
		e.expectError(t, 403, "forbidden", tok, "PUT", "/record-types/defect",
			map[string]any{"id": "defect", "name": "Defect", "priorities": []string{}, "attributes": []any{}, "trackedFrom": map[string]string{}, "revision": 1})
		e.expectError(t, 403, "forbidden", tok, "POST", "/scorecards/sc/records/sample",
			map[string]any{"recordType": "defect", "where": "", "bucketBy": "createdAt", "period": "2026-M09"})
	}
	if _, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); ok {
		t.Fatal("a forbidden apply stored derived points")
	}
}

func TestCrossTenantRecordImport(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	e.putRecordsTemplate(t, "defects")
	other := e.createCSVImport(t, "t2", readDefects(t))
	admin := e.tokens["t1-admin"]
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/"+other+"/inspect", nil)
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/"+other+"/records-preview", previewBody(defectAnswers()))
	e.expectError(t, 404, "not_found", admin, "POST", "/imports/"+other+"/apply", map[string]any{"answers": defectAnswers()})
}

// ---- contributions -------------------------------------------------------------

type contributionsJSON struct {
	Measures []struct {
		MeasureKey   string           `json:"measureKey"`
		Value        *float64         `json:"value"`
		Source       string           `json:"source"`
		RecordsValue *float64         `json:"recordsValue"`
		Cutoff       string           `json:"cutoff"`
		Pending      int              `json:"pending"`
		Total        int              `json:"total"`
		Records      []map[string]any `json:"records"`
	} `json:"measures"`
	NextCursor *string `json:"nextCursor"`
}

func contributionIDs(c contributionsJSON, measure string) []string {
	var out []string
	for _, m := range c.Measures {
		if m.MeasureKey == measure {
			for _, r := range m.Records {
				out = append(out, fmt.Sprint(r["externalId"]))
			}
		}
	}
	return out
}

func contributionsPath(subject, cursor string) string {
	p := "/scorecards/sc/records/contributions?metric=defect_score&period=2026-M09&subject=" + subject
	if cursor != "" {
		p += "&cursor=" + cursor
	}
	return p
}

func TestContributionsRespectScope(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)

	// A leaf: the stored point beside the records behind it.
	var c contributionsJSON
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", contributionsPath("checkout", ""), nil, &c)
	// Measures come by key: defect_days, then defect_points_sum.
	if len(c.Measures) != 2 || c.NextCursor != nil || c.Measures[0].MeasureKey != "defect_days" {
		t.Fatalf("checkout contributions = %+v", c)
	}
	if d := c.Measures[0]; d.Value == nil || *d.Value != 15 || len(d.Records) != 0 {
		t.Errorf("checkout defect_days = %+v", d)
	}
	m := c.Measures[1]
	if m.MeasureKey != "defect_points_sum" || m.Value == nil || *m.Value != 832 || m.Source != "records" ||
		m.RecordsValue == nil || *m.RecordsValue != 832 || m.Cutoff != "2026-09-15" || m.Total != 1 {
		t.Errorf("checkout defect_points_sum = %+v", m)
	}
	if ids := contributionIDs(c, "defect_points_sum"); len(ids) != 1 || ids[0] != "CHK-101" {
		t.Errorf("checkout records = %v", ids)
	}
	rec := c.Measures[1].Records[0]
	if rec["amount"] != 832.0 || rec["priority"] != "P1" || rec["state"] != "open" || rec["subjectId"] != "checkout" {
		t.Errorf("CHK-101 contribution = %v", rec)
	}

	// A rolled-up subject lists every leaf below it.
	e.expect(t, 200, e.tokens["t1-admin"], "GET", contributionsPath("acme", ""), nil, &c)
	if ids := contributionIDs(c, "defect_points_sum"); strings.Join(ids, ",") != "ANL-301,ANL-302,BIL-203,CHK-101" {
		t.Errorf("acme records = %v", ids)
	}
	if c.Measures[1].Total != 4 {
		t.Errorf("acme defect_points_sum total = %d, want 4", c.Measures[1].Total)
	}

	// A viewer scoped to Commerce sees Commerce's leaves only.
	ctx := context.Background()
	if err := e.store.PutMembership(ctx, "t1", domain.Membership{
		UserID: "u-t1-viewer", Email: "u-t1-viewer@example.test", Name: "User u-t1-viewer", Role: domain.RoleViewer,
		Scope: domain.Scope{OrgUnitIDs: []string{"commerce"}, MetricKeys: []string{}}, CreatedAt: testNow,
	}); err != nil {
		t.Fatal(err)
	}
	viewer := e.tokens["t1-viewer"]
	e.expect(t, 200, viewer, "GET", contributionsPath("commerce", ""), nil, &c)
	if ids := contributionIDs(c, "defect_points_sum"); strings.Join(ids, ",") != "BIL-203,CHK-101" {
		t.Errorf("commerce records for a scoped viewer = %v", ids)
	}
	e.expectError(t, 403, "forbidden", viewer, "GET", contributionsPath("acme", ""), nil)
	e.expectError(t, 403, "forbidden", viewer, "GET", contributionsPath("analytics", ""), nil)

	// Bad parameters.
	admin := e.tokens["t1-admin"]
	e.expectError(t, 404, "not_found", admin, "GET", contributionsPath("nobody", ""), nil)
	e.expectError(t, 404, "not_found", admin, "GET", "/scorecards/sc/records/contributions?metric=no_metric&period=2026-M09&subject=checkout", nil)
	e.expectError(t, 400, "invalid", admin, "GET", contributionsPath("checkout", "-3"), nil)
}

func TestContributionsPaginate(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	var b bytes.Buffer
	b.WriteString("Issue key,Summary,Issue Type,Priority,Status,Product,Created,Resolved\n")
	for i := 1; i <= 150; i++ {
		fmt.Fprintf(&b, "CHK-%d,Defect %d,Bug,Low,Open,Checkout,2026-09-01 09:00,\n", 1000+i, i)
	}
	e.putRecordsTemplate(t, "defects")
	id := e.createCSVImport(t, "t1", b.Bytes())
	admin := e.tokens["t1-admin"]
	plan := previewPlan(t, e, id, previewBody(map[string]any{}))
	e.expect(t, 200, admin, "POST", "/imports/"+id+"/apply", map[string]any{"planId": plan, "answers": map[string]any{}}, nil)

	var page1, page2 contributionsJSON
	e.expect(t, 200, admin, "GET", contributionsPath("checkout", ""), nil, &page1)
	if n := len(contributionIDs(page1, "defect_points_sum")); n != 100 || page1.NextCursor == nil {
		t.Fatalf("page 1 has %d records, next %v", n, page1.NextCursor)
	}
	e.expect(t, 200, admin, "GET", contributionsPath("checkout", *page1.NextCursor), nil, &page2)
	if n := len(contributionIDs(page2, "defect_points_sum")); n != 50 || page2.NextCursor != nil {
		t.Fatalf("page 2 has %d records, next %v", n, page2.NextCursor)
	}
	seen := map[string]bool{}
	for _, id := range append(contributionIDs(page1, "defect_points_sum"), contributionIDs(page2, "defect_points_sum")...) {
		if seen[id] {
			t.Fatalf("%s is on both pages", id)
		}
		seen[id] = true
	}
	// Every page carries the measure totals, including the count of all its records.
	if len(page2.Measures) != 2 || page2.Measures[1].RecordsValue == nil || *page2.Measures[1].RecordsValue != 150*15*2 {
		t.Errorf("page 2 measures = %+v", page2.Measures)
	}
	for i, page := range []contributionsJSON{page1, page2} {
		if page.Measures[1].Total != 150 || page.Measures[0].Total != 0 {
			t.Errorf("page %d totals = %d, %d; want 0, 150", i+1, page.Measures[0].Total, page.Measures[1].Total)
		}
	}
}

func TestCrossTenantContributions(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	ctx := context.Background()
	if err := e.store.PutScorecard(ctx, "t2", domain.Scorecard{ID: "sc2", Name: "Other"}); err != nil {
		t.Fatal(err)
	}
	if err := e.store.PutOrgUnit(ctx, "t2", domain.OrgUnit{ID: "t2-unit", Name: "Other", LevelID: "x", SourceKeys: []string{}}); err != nil {
		t.Fatal(err)
	}
	viewer := e.tokens["t1-viewer"]
	e.expectError(t, 404, "not_found", viewer, "GET", "/scorecards/sc2/records/contributions?metric=defect_score&period=2026-M09&subject=checkout", nil)
	e.expectError(t, 404, "not_found", viewer, "GET", contributionsPath("t2-unit", ""), nil)
	e.expectError(t, 404, "not_found", e.tokens["t1-admin"], "POST", "/scorecards/sc2/records/sample",
		map[string]any{"recordType": "defect", "where": "", "bucketBy": "createdAt", "period": "2026-M09"})
}

// ---- sample --------------------------------------------------------------------

func TestRecordsSample(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	var out struct {
		Total     int `json:"total"`
		BySubject []struct {
			SubjectID string `json:"subjectId"`
			Name      string `json:"name"`
			Count     int    `json:"count"`
		} `json:"bySubject"`
	}
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/sc/records/sample",
		map[string]any{"recordType": "defect", "where": "category == 'Bug'", "bucketBy": "createdAt", "period": "2026-M09"}, &out)
	if out.Total != 4 || len(out.BySubject) != 3 {
		t.Fatalf("sample = %+v", out)
	}
	if out.BySubject[0].SubjectID != "analytics" || out.BySubject[0].Count != 2 || out.BySubject[0].Name != "Analytics" {
		t.Errorf("largest first: %+v", out.BySubject)
	}
}

func TestSampleWhereError400(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	got := e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/sc/records/sample",
		map[string]any{"recordType": "defect", "where": "nosuchfield == 'x'", "bucketBy": "createdAt", "period": "2026-M09"})
	if !hasDetail(got, "where") {
		t.Errorf("details = %+v, want where", got.Error.Details)
	}
	got = e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/sc/records/sample",
		map[string]any{"recordType": "defect", "where": "", "bucketBy": "title", "period": "2026-M09"})
	if !hasDetail(got, "bucketBy") {
		t.Errorf("details = %+v, want bucketBy", got.Error.Details)
	}
	got = e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/sc/records/sample",
		map[string]any{"recordType": "nope", "where": "", "bucketBy": "createdAt", "period": "2026-M09"})
	if !hasDetail(got, "recordType") {
		t.Errorf("details = %+v, want recordType", got.Error.Details)
	}
}

// ---- record values ------------------------------------------------------------------

type recordValuesJSON struct {
	Values []struct {
		Value string `json:"value"`
		Count int    `json:"count"`
	} `json:"values"`
}

func (v recordValuesJSON) String() string {
	parts := make([]string, len(v.Values))
	for i, x := range v.Values {
		parts[i] = fmt.Sprintf("%s=%d", x.Value, x.Count)
	}
	return strings.Join(parts, " ")
}

func TestListRecordValues(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	ctx := context.Background()
	// Revisions whose snapshot was never stored (a failed partial apply): a
	// newer one for CHK-102 and the only one of BIL-999. Both are ignored.
	lost := func(id, category string) store.RecordRevisionWrite {
		return store.RecordRevisionWrite{Source: "tracker", ExternalID: id, Type: "defect", Rev: domain.RecordRevision{
			AsOf: domain.Date{Time: time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)}, SnapshotID: "lost",
			Fields: domain.RecordFields{SubjectKey: "Billing", Category: category, State: domain.StateOpen},
		}}
	}
	if err := e.store.ApplySnapshot(ctx, "t1", domain.Snapshot{ID: "tmp", RecordType: "defect", Source: "tracker",
		AsOf: domain.Date{Time: time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)}},
		[]store.RecordRevisionWrite{lost("CHK-102", "Story"), lost("BIL-999", "Orphaned")}); err != nil {
		t.Fatal(err)
	}

	admin := e.tokens["t1-admin"]
	cases := []struct{ field, want string }{
		// The mobile app rows were ignored on apply, so nine records are stored.
		{"category", "Bug=7 Defect=1 Sub-task=1"},
		{"subjectKey", "Checkout=4 Billing=3 Analytics=2"},
		// BIL-203 has no priority: it is none, as conditions see it.
		{"priority", "P1=2 P2=2 P3=2 P4=2 none=1"},
		{"completedAt", "2026-06-02=1 2026-07-01=1 2026-07-30=1 2026-08-19=1"},
		{"planned", ""},
	}
	for _, c := range cases {
		var got recordValuesJSON
		e.expect(t, 200, admin, "GET", "/record-types/defect/values?field="+c.field, nil, &got)
		if got.Values == nil {
			t.Errorf("%s: values is null, want a list", c.field)
		}
		if got.String() != c.want {
			t.Errorf("%s: values = %q, want %q", c.field, got.String(), c.want)
		}
	}
}

func TestListRecordValuesLimitAndAttributes(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	rt := domain.RecordType{ID: "epic", Name: "Epic", Attributes: []domain.AttributeDef{
		{Key: "customerTicket", Name: "Customer ticket", Type: domain.AttrBool},
		{Key: "team", Name: "Team", Type: domain.AttrString},
	}}
	if err := e.store.PutRecordType(ctx, "t1", rt, 0); err != nil {
		t.Fatal(err)
	}
	asOf := domain.Date{Time: time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)}
	var revs []store.RecordRevisionWrite
	for i := range 150 {
		attrs := map[string]any{"team": fmt.Sprintf("team-%03d", i)}
		if i%3 == 0 {
			attrs["customerTicket"] = true
		} else if i%3 == 1 {
			attrs["customerTicket"] = false
		}
		if i < 5 {
			attrs["team"] = "platform" // the most common value comes first
		}
		revs = append(revs, store.RecordRevisionWrite{Source: "tracker", ExternalID: fmt.Sprintf("EP-%d", i), Type: "epic",
			Rev: domain.RecordRevision{AsOf: asOf, SnapshotID: "s1", Fields: domain.RecordFields{SubjectKey: "Checkout", State: domain.StateOpen, Attributes: attrs}}})
	}
	if err := e.store.ApplySnapshot(ctx, "t1", domain.Snapshot{ID: "s1", RecordType: "epic", Source: "tracker", AsOf: asOf}, revs); err != nil {
		t.Fatal(err)
	}
	admin := e.tokens["t1-admin"]

	var team recordValuesJSON
	e.expect(t, 200, admin, "GET", "/record-types/epic/values?field=team", nil, &team)
	if len(team.Values) != 100 {
		t.Fatalf("team: %d values, want the limit of 100", len(team.Values))
	}
	if first := team.Values[0]; first.Value != "platform" || first.Count != 5 {
		t.Errorf("team: first = %+v, want platform=5", first)
	}
	if second := team.Values[1]; second.Value != "team-005" || second.Count != 1 {
		t.Errorf("team: second = %+v, want team-005=1 (ties by value)", second)
	}

	// Records without the attribute have no value, rather than false.
	var ticket recordValuesJSON
	e.expect(t, 200, admin, "GET", "/record-types/epic/values?field=customerTicket", nil, &ticket)
	if ticket.String() != "false=50 true=50" {
		t.Errorf("customerTicket: values = %q, want false=50 true=50", ticket.String())
	}
}

func TestListRecordValuesErrors(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	admin := e.tokens["t1-admin"]
	got := e.expectError(t, 400, "invalid", admin, "GET", "/record-types/defect/values?field=nosuchfield", nil)
	if !hasDetail(got, "field") {
		t.Errorf("details = %+v, want field", got.Error.Details)
	}
	e.expectError(t, 400, "invalid", admin, "GET", "/record-types/defect/values", nil)
	e.expectError(t, 404, "not_found", admin, "GET", "/record-types/nope/values?field=category", nil)
	e.expectError(t, 403, "forbidden", e.tokens["t1-contributor"], "GET", "/record-types/defect/values?field=category", nil)
}

func TestCrossTenantRecordValues(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	other := e.tokens["t2-admin"]
	// t2 has no defect type: t1's records are not reachable from t2.
	e.expectError(t, 404, "not_found", other, "GET", "/record-types/defect/values?field=category", nil)
	if err := e.store.PutRecordType(context.Background(), "t2", domain.RecordType{ID: "defect", Name: "Defect"}, 0); err != nil {
		t.Fatal(err)
	}
	var got recordValuesJSON
	e.expect(t, 200, other, "GET", "/record-types/defect/values?field=category", nil, &got)
	if len(got.Values) != 0 {
		t.Errorf("t2 sees values %q of t1's records", got.String())
	}
}

// ---- recalculation and restatement -------------------------------------------------

func TestPublishRecalculates(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)

	// v2 weighs every priority 1, from September.
	flat := map[string]float64{"P1": 1, "P2": 1, "P3": 1, "P4": 1, "none": 1}
	v := saveDraft(t, e, newDraft(t, e, "sc", "Flat", ""), defectMethodology(flat))
	var out struct {
		ID           string `json:"id"`
		Status       string `json:"status"`
		Recalculated *int   `json:"recalculated"`
	}
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/sc/versions/"+v.ID+"/publish", map[string]any{"effectiveFrom": "2026-M09"}, &out)
	// Checkout and Analytics change; Billing's only defect has no priority,
	// which weighs 1 in both versions.
	if out.Status != "published" || out.Recalculated == nil || *out.Recalculated != 2 {
		t.Fatalf("publish = %+v, want 2 recalculated", out)
	}
	for subject, want := range map[string]float64{"checkout": 13, "billing": 14, "analytics": 8} {
		dp, ok := storedPoint(t, e, "defect_points_sum", subject, sep2026)
		if !ok || dp.Value == nil || *dp.Value != want || dp.Source != domain.SourceRecords || dp.EnteredBy != "u-t1-admin" {
			t.Errorf("%s after publish = %+v, want %v", subject, dp, want)
		}
	}
}

func TestRestateRederives(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	applyDefects(t, e)
	flat := map[string]float64{"P1": 1, "P2": 1, "P3": 1, "P4": 1, "none": 1}
	v := saveDraft(t, e, newDraft(t, e, "sc", "Flat draft", ""), defectMethodology(flat))
	viewer := e.tokens["t1-viewer"]

	live := viewCell(t, e, viewer, "periods=2026-M09", "defect_score", "checkout")
	restated := viewCell(t, e, viewer, "periods=2026-M09&restate="+v.ID, "defect_score", "checkout")
	if lv, ok := live["value"].(float64); !ok || !near(lv, 832.0/15) {
		t.Errorf("live checkout score = %v", live["value"])
	}
	if rv, ok := restated["value"].(float64); !ok || !near(rv, 13.0/15) {
		t.Errorf("restated checkout score = %v, want %v", restated["value"], 13.0/15)
	}
	// Restatement is computed in memory: stored points are unchanged.
	if dp, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); !ok || dp.Value == nil || *dp.Value != 832 || dp.Revision != 1 {
		t.Errorf("stored point = %+v, want 832 at revision 1", dp)
	}
	// A typed value still wins under restatement.
	typed := 5.0
	if _, err := e.store.PutDataPoints(context.Background(), "t1", "sc", []store.DataWrite{{Point: domain.DataPoint{
		MeasureKey: "defect_points_sum", SubjectID: "billing", Period: sep2026, Value: &typed, Source: domain.SourceGrid,
		EnteredBy: "u-t1-admin", EnteredAt: testNow}, ExpectedRevision: store.Unconditional}}); err != nil {
		t.Fatal(err)
	}
	billing := viewCell(t, e, viewer, "periods=2026-M09&restate="+v.ID, "defect_score", "billing")
	if bv, ok := billing["value"].(float64); !ok || !near(bv, 5.0/15) {
		t.Errorf("restated billing score = %v, want typed 5/15", billing["value"])
	}
}

// ---- methodology validation ----------------------------------------------------------

func TestValidateDerivedMeasure(t *testing.T) {
	e := newTestEnv(t)
	seedScorecard(t, e, "delivery")
	admin := e.tokens["t1-admin"]
	e.expect(t, 200, admin, "PUT", "/record-types/defect", map[string]any{
		"id": "defect", "name": "Defect", "priorities": []string{"P1"}, "trackedFrom": map[string]string{}, "revision": 0,
		"attributes": []map[string]string{{"key": "customerTicket", "name": "Customer ticket", "type": "bool"}},
	}, nil)
	m := sampleMethodology(90)
	m.Measures[0].Source = domain.MeasureDerived
	m.Measures[0].Derive = &domain.DeriveRule{RecordType: "defect", Op: domain.OpCount, BucketBy: "createdAt", Where: "nosuchfield == 'x'"}
	m.Measures[1].Source = domain.MeasureDerived
	m.Measures[1].Derive = &domain.DeriveRule{RecordType: "epic", Op: domain.OpCount, BucketBy: "createdAt"}

	// A draft is work in progress: bad derive rules are saved as sent.
	v := saveDraft(t, e, newDraft(t, e, "delivery", "Derived", ""), m)
	if got := getVersion(t, e, "delivery", v.ID); got.Content.Measures[0].Derive == nil || got.Content.Measures[0].Derive.Where != "nosuchfield == 'x'" {
		t.Fatalf("saved draft measures = %+v", got.Content.Measures)
	}

	// Validate reports the where that does not compile and the unknown record type.
	var res struct {
		Valid  bool `json:"valid"`
		Errors []struct{ Path, Message string }
	}
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/versions/"+v.ID+"/validate", nil, &res)
	paths := map[string]bool{}
	for _, d := range res.Errors {
		paths[d.Path] = true
	}
	if res.Valid || !paths["measures[0].derive.where"] || !paths["measures[1].derive.recordType"] {
		t.Errorf("validate = %+v, want errors at measures[0].derive.where and measures[1].derive.recordType", res)
	}
	// Publish refuses it at the same paths.
	got := e.expectError(t, 400, "invalid", admin, "POST", "/scorecards/delivery/versions/"+v.ID+"/publish", map[string]any{"effectiveFrom": "2026-M01"})
	if !hasDetail(got, "measures[0].derive.where") || !hasDetail(got, "measures[1].derive.recordType") {
		t.Errorf("publish details = %+v", got.Error.Details)
	}

	// A where that compiles against the record type publishes.
	m.Measures[0].Derive.Where = "customerTicket == true"
	m.Measures[1].Derive.RecordType = "defect"
	v = saveDraft(t, e, getVersion(t, e, "delivery", v.ID), m)
	e.expect(t, 200, admin, "POST", "/scorecards/delivery/versions/"+v.ID+"/validate", nil, &res)
	if !res.Valid {
		t.Errorf("validate after the fix = %+v", res)
	}
	publish(t, e, v, "2026-M01")
}

// failingDataStore fails PutDataPoints while fail is set.
type failingDataStore struct {
	store.Store
	fail *bool
}

func (f failingDataStore) PutDataPoints(ctx context.Context, tenantID, scorecardID string, pts []store.DataWrite) ([]domain.DataPoint, error) {
	if *f.fail {
		return nil, fmt.Errorf("injected data point write failure")
	}
	return f.Store.PutDataPoints(ctx, tenantID, scorecardID, pts)
}

func TestPublishSurvivesRecalculationFailure(t *testing.T) {
	fail := false
	e := newTestEnvWith(t, func(st store.Store) store.Store { return failingDataStore{Store: st, fail: &fail} })
	seedRecords(t, e)
	applyDefects(t, e)

	flat := map[string]float64{"P1": 1, "P2": 1, "P3": 1, "P4": 1, "none": 1}
	v := saveDraft(t, e, newDraft(t, e, "sc", "Flat", ""), defectMethodology(flat))
	fail = true
	var out struct {
		Status             string  `json:"status"`
		Recalculated       *int    `json:"recalculated"`
		RecalculationError *string `json:"recalculationError"`
	}
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/sc/versions/"+v.ID+"/publish", map[string]any{"effectiveFrom": "2026-M09"}, &out)
	if out.Status != "published" || out.Recalculated == nil || *out.Recalculated != 0 || out.RecalculationError == nil || *out.RecalculationError == "" {
		t.Fatalf("publish = %+v, want published with a recalculation error", out)
	}
	if strings.Contains(*out.RecalculationError, "injected") {
		t.Errorf("recalculationError leaks the internal error: %q", *out.RecalculationError)
	}
	if got := getVersion(t, e, "sc", v.ID); got.Status != "published" || got.EffectiveFrom != "2026-M09" {
		t.Errorf("version after publish = %+v", got)
	}
	// The stored derived points are the ones from before the publish.
	if dp, ok := storedPoint(t, e, "defect_points_sum", "checkout", sep2026); !ok || dp.Value == nil || *dp.Value != 832 {
		t.Errorf("checkout point = %+v, want 832", dp)
	}

	// A successful publish carries no error.
	fail = false
	v2 := saveDraft(t, e, newDraft(t, e, "sc", "Default", ""), defectMethodology(defectWeights))
	out.RecalculationError = nil
	e.expect(t, 200, e.tokens["t1-admin"], "POST", "/scorecards/sc/versions/"+v2.ID+"/publish", map[string]any{"effectiveFrom": "2026-M10"}, &out)
	if out.RecalculationError != nil {
		t.Errorf("recalculationError on success = %q", *out.RecalculationError)
	}
}

// ---- record types ----------------------------------------------------------------------

func TestRecordTypeStaleRevision409(t *testing.T) {
	e := newTestEnv(t)
	admin := e.tokens["t1-admin"]
	body := func(rev int, name string) map[string]any {
		return map[string]any{
			"id": "epic", "name": name, "priorities": []string{}, "revision": rev,
			"attributes":  []map[string]string{{"key": "withinBudget", "name": "Within budget", "type": "bool"}},
			"trackedFrom": map[string]string{"tracker": "2026-M10"},
		}
	}
	var rt struct {
		ID          string            `json:"id"`
		Name        string            `json:"name"`
		Revision    int               `json:"revision"`
		TrackedFrom map[string]string `json:"trackedFrom"`
		Attributes  []map[string]string
	}
	e.expect(t, 200, admin, "PUT", "/record-types/epic", body(0, "Epic"), &rt)
	if rt.Revision != 1 || rt.TrackedFrom["tracker"] != "2026-M10" || len(rt.Attributes) != 1 {
		t.Fatalf("created = %+v", rt)
	}
	// Creating again, or saving over a newer revision, conflicts.
	e.expectError(t, 409, "conflict", admin, "PUT", "/record-types/epic", body(0, "Again"))
	e.expect(t, 200, admin, "PUT", "/record-types/epic", body(1, "Epics"), &rt)
	if rt.Revision != 2 || rt.Name != "Epics" {
		t.Fatalf("updated = %+v", rt)
	}
	e.expectError(t, 409, "conflict", admin, "PUT", "/record-types/epic", body(1, "Stale"))
	e.expectError(t, 409, "conflict", admin, "PUT", "/record-types/missing",
		map[string]any{"id": "missing", "name": "M", "priorities": []string{}, "attributes": []any{}, "trackedFrom": map[string]string{}, "revision": 3})

	// Validation: path and body IDs agree, the domain rules apply.
	e.expectError(t, 400, "invalid", admin, "PUT", "/record-types/epic", map[string]any{
		"id": "other", "name": "Epic", "priorities": []string{}, "attributes": []any{}, "trackedFrom": map[string]string{}, "revision": 2})
	got := e.expectError(t, 400, "invalid", admin, "PUT", "/record-types/epic", map[string]any{
		"id": "epic", "name": "Epic", "priorities": []string{"P1", "P1"}, "revision": 2, "trackedFrom": map[string]string{"tracker": "2026-Q1"},
		"attributes": []map[string]string{{"key": "dueAt", "name": "Due", "type": "date"}}})
	for _, p := range []string{"priorities[1]", "attributes[0].key", "trackedFrom.tracker"} {
		if !hasDetail(got, p) {
			t.Errorf("details = %+v, want %s", got.Error.Details, p)
		}
	}

	// Any member lists them.
	var list struct {
		RecordTypes []struct {
			ID       string `json:"id"`
			Revision int    `json:"revision"`
		} `json:"recordTypes"`
	}
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/record-types", nil, &list)
	if len(list.RecordTypes) != 1 || list.RecordTypes[0].ID != "epic" || list.RecordTypes[0].Revision != 2 {
		t.Errorf("list = %+v", list)
	}
	e.expect(t, 200, e.tokens["t2-viewer"], "GET", "/record-types", nil, &list)
	if len(list.RecordTypes) != 0 {
		t.Errorf("t2 sees t1's record types: %+v", list)
	}
}

// ---- source keys ---------------------------------------------------------------------

func TestDuplicateSourceKeyRejected(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	seedKinds(t, e)
	admin := e.tokens["t1-admin"]
	got := e.expectError(t, 409, "conflict", admin, "POST", "/org/units",
		unitJSON{ID: "checkout-2", Name: "Checkout 2", LevelID: "product", ParentID: "commerce", SourceKeys: []string{" CHECKOUT "}})
	if !strings.Contains(got.Error.Message, "checkout") || !hasDetail(got, "sourceKeys[0]") {
		t.Errorf("unit conflict = %+v", got.Error)
	}
	e.expectError(t, 409, "conflict", admin, "PATCH", "/org/units/analytics", map[string]any{"sourceKeys": []string{"billing"}})
	e.expectError(t, 409, "conflict", admin, "POST", "/items",
		map[string]any{"id": "web", "kindId": "app", "name": "Web", "orgUnitId": "", "sourceKeys": []string{"Billing"}})
	e.expect(t, 201, admin, "POST", "/items", map[string]any{"id": "web", "kindId": "app", "name": "Web", "orgUnitId": "", "sourceKeys": []string{"Web"}}, nil)
	got = e.expectError(t, 409, "conflict", admin, "PATCH", "/items/web", map[string]any{"sourceKeys": []string{"checkout"}})
	if !strings.Contains(got.Error.Message, "checkout") {
		t.Errorf("item conflict = %+v", got.Error)
	}
	e.expectError(t, 409, "conflict", admin, "PATCH", "/org/units/analytics", map[string]any{"sourceKeys": []string{"WEB"}})
	// A subject keeps its own keys.
	e.expect(t, 200, admin, "PATCH", "/org/units/checkout", map[string]any{"sourceKeys": []string{"checkout", "CHK"}}, nil)
}

// ---- uploads -------------------------------------------------------------------------

func TestCreateImportUploadCSV(t *testing.T) {
	e := newTestEnv(t)
	var up uploadJSON
	e.expect(t, 201, e.tokens["t1-admin"], "POST", "/imports/uploads", map[string]string{"contentType": "text/csv"}, &up)
	if !strings.Contains(up.UploadURL, "/imports/"+up.ImportID+".csv?") {
		t.Errorf("upload URL = %s, want a .csv key", up.UploadURL)
	}
	im, err := e.store.GetImport(context.Background(), "t1", up.ImportID)
	if err != nil || !strings.HasSuffix(im.ObjectKey, ".csv") {
		t.Errorf("import = %+v, %v", im, err)
	}
}

func TestCSVTooLarge(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	e.putRecordsTemplate(t, "defects")
	big := bytes.Repeat([]byte("a"), int(objects.MaxUploadBytes)+1)
	id := e.createCSVImport(t, "t1", big)
	admin := e.tokens["t1-admin"]
	e.expectError(t, 413, "too_large", admin, "POST", "/imports/"+id+"/inspect", nil)
	e.expectError(t, 413, "too_large", admin, "POST", "/imports/"+id+"/records-preview", previewBody(map[string]any{}))
	// A workbook over the limit is refused the same way.
	up := e.createImport(t, big)
	e.putTemplate(t, admin, sampleTemplate(t, "legacy-1"))
	e.expectError(t, 413, "too_large", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "legacy-1"})
}

// ---- templates and history (carried items) ----------------------------------------------

func TestRecordsTemplateValidated(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	bad := defectsTemplate()
	delete(bad["fields"].(map[string]any), "externalId")
	got := e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/defects",
		map[string]any{"id": "defects", "name": "Defects", "profile": "records", "body": bad})
	if !hasDetail(got, "body.fields.externalId") {
		t.Errorf("details = %+v", got.Error.Details)
	}
	unknown := defectsTemplate()
	unknown["recordType"] = "epic"
	got = e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/defects",
		map[string]any{"id": "defects", "name": "Defects", "profile": "records", "body": unknown})
	if !hasDetail(got, "body.recordType") {
		t.Errorf("details = %+v", got.Error.Details)
	}
	extra := defectsTemplate()
	extra["surprise"] = true
	e.expectError(t, 400, "invalid", admin, "PUT", "/import-templates/defects",
		map[string]any{"id": "defects", "name": "Defects", "profile": "records", "body": extra})
	e.putRecordsTemplate(t, "defects")
	// A records template cannot drive the legacy parse.
	up := e.createImport(t, readSample(t))
	e.expectError(t, 400, "invalid", admin, "POST", "/imports/"+up.ImportID+"/parse",
		map[string]string{"profile": "legacy_workbook", "templateId": "defects"})
}

func TestTemplatePutKeepsLastUsed(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	e.putRecordsTemplate(t, "defects")
	ctx := context.Background()
	tpls, _ := e.store.ListTemplates(ctx, "t1")
	used := testNow.Add(-time.Hour)
	tpls[0].LastUsed = &used
	if err := e.store.PutTemplate(ctx, "t1", tpls[0]); err != nil {
		t.Fatal(err)
	}
	renamed := map[string]any{"id": "defects", "name": "Renamed", "profile": "records", "body": defectsTemplate()}
	e.expect(t, 200, admin, "PUT", "/import-templates/defects", renamed, nil)
	tpls, _ = e.store.ListTemplates(ctx, "t1")
	if tpls[0].LastUsed == nil || !tpls[0].LastUsed.Equal(used) || tpls[0].Name != "Renamed" {
		t.Errorf("after PUT = %+v, want lastUsed kept", tpls[0])
	}
	e.expect(t, 200, admin, "PUT", "/import-templates", map[string]any{"templates": []any{renamed}}, nil)
	tpls, _ = e.store.ListTemplates(ctx, "t1")
	if tpls[0].LastUsed == nil || !tpls[0].LastUsed.Equal(used) {
		t.Errorf("after replace = %+v, want lastUsed kept", tpls[0])
	}
}

func TestTemplateListsLastUsedAndRevision(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	admin := e.tokens["t1-admin"]
	type tplJSON struct {
		ID       string     `json:"id"`
		Name     string     `json:"name"`
		Revision *int       `json:"revision"`
		LastUsed *time.Time `json:"lastUsed"`
	}
	list := func() tplJSON {
		t.Helper()
		var out struct {
			Templates []tplJSON `json:"templates"`
		}
		e.expect(t, 200, admin, "GET", "/import-templates", nil, &out)
		for _, tp := range out.Templates {
			if tp.ID == "defects" {
				return tp
			}
		}
		t.Fatalf("no defects template in %+v", out.Templates)
		return tplJSON{}
	}

	e.putRecordsTemplate(t, "defects")
	if got := list(); got.Revision == nil || *got.Revision != 1 || got.LastUsed != nil {
		t.Fatalf("before any apply = %+v, want revision 1 and no lastUsed", got)
	}

	applyDefects(t, e)
	got := list()
	if got.Revision == nil || *got.Revision != 1 {
		t.Errorf("after apply: revision = %v, want 1 (applying does not change the template)", got.Revision)
	}
	if got.LastUsed == nil || !got.LastUsed.Equal(testNow) {
		t.Errorf("after apply: lastUsed = %v, want %v", got.LastUsed, testNow)
	}

	// Both are read-only: values sent on PUT are ignored, and the response is the stored template.
	var put tplJSON
	e.expect(t, 200, admin, "PUT", "/import-templates/defects", map[string]any{
		"id": "defects", "name": "Renamed", "profile": "records", "body": defectsTemplate(),
		"revision": 40, "lastUsed": "2020-01-01T00:00:00Z",
	}, &put)
	if put.Revision == nil || *put.Revision != 2 || put.LastUsed == nil || !put.LastUsed.Equal(testNow) {
		t.Errorf("PUT response = %+v, want revision 2 and lastUsed kept", put)
	}
	if got := list(); *got.Revision != 2 || !got.LastUsed.Equal(testNow) || got.Name != "Renamed" {
		t.Errorf("after PUT = %+v", got)
	}
}

func TestHistoryMarksDeleted(t *testing.T) {
	e := newTestEnv(t)
	seedRecords(t, e)
	ctx := context.Background()
	v := 3.0
	if _, err := e.store.PutDataPoints(ctx, "t1", "sc", []store.DataWrite{{Point: domain.DataPoint{
		MeasureKey: "defect_points_sum", SubjectID: "checkout", Period: sep2026, Value: &v, Source: domain.SourceRecords,
		EnteredBy: "u-t1-admin", EnteredAt: testNow}, ExpectedRevision: store.Unconditional}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.PutDataPoints(ctx, "t1", "sc", []store.DataWrite{{Point: domain.DataPoint{
		MeasureKey: "defect_points_sum", SubjectID: "checkout", Period: sep2026, Source: domain.SourceRecords,
		EnteredBy: "u-t1-admin", EnteredAt: testNow}, ExpectedRevision: store.Unconditional, Delete: true}}); err != nil {
		t.Fatal(err)
	}
	var h struct {
		History []map[string]any `json:"history"`
	}
	e.expect(t, 200, e.tokens["t1-viewer"], "GET", "/scorecards/sc/history?measure=defect_points_sum&subject=checkout&period=2026-M09", nil, &h)
	if len(h.History) != 2 || h.History[0]["deleted"] != true || h.History[1]["deleted"] != nil {
		t.Errorf("history = %v, want the tombstone first marked deleted", h.History)
	}
	raw, _ := json.Marshal(h.History[1])
	if strings.Contains(string(raw), "deleted") {
		t.Errorf("a live revision carries deleted: %s", raw)
	}
}
