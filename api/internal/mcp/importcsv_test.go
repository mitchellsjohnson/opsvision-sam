package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"opsvision/internal/demo"
	"opsvision/internal/httpapi"
	"opsvision/internal/mcp"
)

// defectsCSV is a small tracker export of the demo tenant's defects.
func defectsCSV(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../demo/testdata/acme_defects_nov.csv")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// send calls the REST API directly and requires want.
func (e *env) send(t *testing.T, token, method, path string, body any, want int) []byte {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, e.srv.URL+"/v1"+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, out)
	}
	return out
}

// putDefectsTemplate saves a records template for the demo defects export.
func (e *env) putDefectsTemplate(t *testing.T) {
	t.Helper()
	dates := []string{"2006-01-02"}
	e.send(t, e.tokens["admin"], "PUT", "/import-templates/tracker-defects", map[string]any{
		"id": "tracker-defects", "name": "Tracker defects", "profile": "records",
		"body": map[string]any{
			"name": "Tracker defects", "recordType": "defect", "source": "tracker",
			"file": map[string]any{"format": "csv", "headerRow": 1}, "fullExport": false,
			"fields": map[string]any{
				"externalId":  map[string]any{"column": "Issue key"},
				"title":       map[string]any{"column": "Summary"},
				"category":    map[string]any{"column": "Issue Type"},
				"priority":    map[string]any{"column": "Priority", "map": map[string]string{"Highest": "P1", "High": "P2", "Medium": "P3", "Low": "P4"}, "default": "none"},
				"status":      map[string]any{"column": "Status"},
				"state":       map[string]any{"column": "Status", "map": map[string]string{"Done": "done", "Closed": "done", "*": "open"}},
				"subjectKey":  map[string]any{"column": "Product"},
				"createdAt":   map[string]any{"column": "Created", "dateFormats": dates},
				"completedAt": map[string]any{"column": "Resolved", "dateFormats": dates},
			},
		},
	}, 200)
}

func (e *env) snapshots(t *testing.T) int {
	t.Helper()
	snaps, err := e.store.ListSnapshots(context.Background(), demo.TenantID, "defect")
	if err != nil {
		t.Fatal(err)
	}
	return len(snaps)
}

type importResult struct {
	ImportID    string `json:"importId"`
	TemplateID  string `json:"templateId"`
	ScorecardID string `json:"scorecardId"`
	AsOf        string `json:"asOf"`
	DryRun      bool   `json:"dryRun"`
	Preview     struct {
		PlanID string         `json:"planId"`
		Counts map[string]int `json:"counts"`
	} `json:"preview"`
	Applied *struct {
		Records struct {
			SnapshotID string `json:"snapshotId"`
		} `json:"records"`
	} `json:"applied"`
}

func decodeImport(t *testing.T, res toolResult) importResult {
	t.Helper()
	if res.IsError {
		t.Fatalf("isError: %s", res.text())
	}
	var out importResult
	if err := json.Unmarshal([]byte(res.Content[0].Text), &out); err != nil {
		t.Fatalf("decode %s: %v", res.Content[0].Text, err)
	}
	return out
}

func TestImportCSVDryRun(t *testing.T) {
	e := newEnv(t)
	e.putDefectsTemplate(t)
	before := e.snapshots(t)
	res := e.callTool(t, e.tokens["admin"], "import_records_csv", map[string]any{
		"recordType": "defect", "csv": defectsCSV(t), "dryRun": true, "asOf": "2026-11-14",
	})
	got := decodeImport(t, res)
	if !got.DryRun || got.Applied != nil {
		t.Fatalf("dry run applied: %+v", got)
	}
	// The saved template is recognized from the file's columns, and the only
	// scorecard is used.
	if got.TemplateID != "tracker-defects" || got.ScorecardID != demo.ScorecardID || got.AsOf != "2026-11-14" {
		t.Errorf("result = %+v", got)
	}
	if got.Preview.PlanID == "" || got.Preview.Counts["new"]+got.Preview.Counts["changed"]+got.Preview.Counts["unchanged"] == 0 {
		t.Errorf("preview = %+v", got.Preview)
	}
	if n := e.snapshots(t); n != before {
		t.Errorf("snapshots %d -> %d after a dry run", before, n)
	}
	im, err := e.store.GetImport(context.Background(), demo.TenantID, got.ImportID)
	if err != nil {
		t.Fatal(err)
	}
	if im.Status != "parsed" || !strings.HasSuffix(im.ObjectKey, ".csv") {
		t.Errorf("import = %+v", im)
	}

	// The preview is the API's: the same file previewed through REST counts the same.
	up := e.send(t, e.tokens["admin"], "POST", "/imports/uploads", map[string]any{"filename": "d.csv", "contentType": "text/csv"}, 201)
	var created struct{ ImportID string }
	if err := json.Unmarshal(up, &created); err != nil {
		t.Fatal(err)
	}
	if err := e.objs.Put(context.Background(), "t/"+demo.TenantID+"/imports/"+created.ImportID+".csv", "text/csv", []byte(defectsCSV(t))); err != nil {
		t.Fatal(err)
	}
	raw := e.send(t, e.tokens["admin"], "POST", "/imports/"+created.ImportID+"/records-preview",
		map[string]any{"scorecardId": demo.ScorecardID, "asOf": "2026-11-14", "templateId": "tracker-defects"}, 200)
	var direct struct{ Counts map[string]int }
	if err := json.Unmarshal(raw, &direct); err != nil {
		t.Fatal(err)
	}
	if !mapsEqual(direct.Counts, got.Preview.Counts) {
		t.Errorf("counts %v, REST preview %v", got.Preview.Counts, direct.Counts)
	}
}

func mapsEqual(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestImportCSVApplies(t *testing.T) {
	e := newEnv(t)
	e.putDefectsTemplate(t)
	before := e.snapshots(t)
	got := decodeImport(t, e.callTool(t, e.tokens["admin"], "import_records_csv", map[string]any{
		"recordType": "defect", "csv": defectsCSV(t), "templateId": "tracker-defects", "scorecardId": demo.ScorecardID,
	}))
	if got.DryRun || got.Applied == nil || got.Applied.Records.SnapshotID == "" {
		t.Fatalf("not applied: %+v", got)
	}
	if got.AsOf != "2026-11-15" {
		t.Errorf("asOf = %q, want the server's today", got.AsOf)
	}
	if n := e.snapshots(t); n != before+1 {
		t.Errorf("snapshots %d -> %d", before, n)
	}
	var create, parse, apply string
	// recordimport.Apply stamps its entry with the real clock.
	all, err := e.store.ListAudit(context.Background(), demo.TenantID, time.Time{}, time.Now().Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range all {
		switch {
		case a.Action == "import.create" && a.TargetID == got.ImportID:
			create = a.Channel
		case a.Action == "import.parse" && a.TargetID == got.ImportID:
			parse = a.Channel
		case a.Action == "records.import" && a.TargetID == got.Applied.Records.SnapshotID:
			apply = a.Channel
		}
	}
	if create != "mcp" || parse != "mcp" || apply != "mcp" {
		t.Errorf("audit channels create %q parse %q apply %q", create, parse, apply)
	}
}

func TestImportCSVLimits(t *testing.T) {
	e := newEnv(t)
	big := "Issue key,Summary\n" + strings.Repeat("ABC-1,"+strings.Repeat("x", 90)+"\n", 8000)
	if len(big) <= mcp.MaxImportCSVBytes {
		t.Fatalf("fixture is only %d bytes", len(big))
	}
	res := e.callTool(t, e.tokens["admin"], "import_records_csv", map[string]any{"recordType": "defect", "csv": big})
	if !res.IsError || !strings.Contains(res.text(), "700 KB") {
		t.Fatalf("result = %.300s", res.text())
	}
	if len(e.objs.Keys()) != 0 {
		t.Error("an oversized CSV was uploaded")
	}
}

func TestImportCSVErrors(t *testing.T) {
	e := newEnv(t)
	for _, tc := range []struct {
		name  string
		token string
		args  map[string]any
		want  string
	}{
		{"no record type", "admin", map[string]any{"csv": "a,b\n1,2\n"}, "recordType"},
		{"no csv", "admin", map[string]any{"recordType": "defect"}, "csv"},
		{"viewer", "viewer", map[string]any{"recordType": "defect", "csv": "a,b\n1,2\n"}, "tenant admin role required"},
		{"no template", "admin", map[string]any{"recordType": "defect", "csv": "a,b\n1,2\n"}, "template"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := e.callTool(t, e.tokens[tc.token], "import_records_csv", tc.args)
			if !res.IsError || !strings.Contains(res.text(), tc.want) {
				t.Fatalf("result = %.300s", res.text())
			}
		})
	}

	// A template for another record type is refused.
	e.putDefectsTemplate(t)
	res := e.callTool(t, e.tokens["admin"], "import_records_csv", map[string]any{
		"recordType": "epic", "csv": defectsCSV(t), "templateId": "tracker-defects",
	})
	if !res.IsError || !strings.Contains(res.text(), "defect") {
		t.Fatalf("other record type: %.300s", res.text())
	}
}

// previewAnswers returns the answers schema of preview_records_import in tools.
func previewAnswers(t *testing.T, tools []mcp.Tool) map[string]any {
	t.Helper()
	for _, tl := range tools {
		if tl.Name == "preview_records_import" {
			body := tl.InputSchema["properties"].(map[string]any)["body"].(map[string]any)
			return body["properties"].(map[string]any)["answers"].(map[string]any)
		}
	}
	t.Fatal("no preview_records_import tool")
	return nil
}

func TestImportCSVLeavesTheCatalogAlone(t *testing.T) {
	newEnv(t)
	tools, err := httpapi.Tools()
	if err != nil {
		t.Fatal(err)
	}
	before, err := json.Marshal(previewAnswers(t, tools))
	if err != nil {
		t.Fatal(err)
	}
	imp, err := mcp.ImportRecordsCSV(tools, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	after, err := json.Marshal(previewAnswers(t, tools))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("preview_records_import answers changed:\n%s\n%s", before, after)
	}
	own := imp.Tool.InputSchema["properties"].(map[string]any)["answers"].(map[string]any)["description"]
	if previewAnswers(t, tools)["description"] == own {
		t.Errorf("preview_records_import answers carry import_records_csv's description %q", own)
	}
}

func TestImportCSVAnnotations(t *testing.T) {
	tools, err := httpapi.Tools()
	if err != nil {
		t.Fatal(err)
	}
	imp, err := mcp.ImportRecordsCSV(tools, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, set := imp.Tool.Annotations["destructiveHint"]; set || imp.Tool.Annotations["readOnlyHint"] != false {
		t.Fatalf("annotations = %v; want a write without destructiveHint", imp.Tool.Annotations)
	}
}
