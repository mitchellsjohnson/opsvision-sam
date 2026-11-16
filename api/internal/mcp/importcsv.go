package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// MaxImportCSVBytes is the largest CSV import_records_csv takes.
const MaxImportCSVBytes = 700 << 10

// ImportCSVToolName is the name of the records import tool.
const ImportCSVToolName = "import_records_csv"

// Uploader stores csv as the file of an import the caller of ctx has just
// created, in place of the browser's upload to the presigned URL.
type Uploader func(ctx context.Context, importID string, csv []byte) error

// The API operations import_records_csv drives, by tool name.
const (
	opListScorecards  = "list_scorecards"
	opCreateUpload    = "create_import_upload"
	opInspect         = "inspect_import"
	opListTemplates   = "list_import_templates"
	opPreviewRecords  = "preview_records_import"
	opApplyImport     = "apply_import"
	importCSVFilename = "import.csv"
)

// ImportRecordsCSV returns the import_records_csv tool: it imports a CSV
// export of records the way the web app does, through the API operations of
// catalog called with d: start an import (create_import_upload), store the
// file with upload, inspect it to recognize a saved records template, preview
// it (preview_records_import), and unless dryRun, apply that preview
// (apply_import). Each step is authorized and audited by the API as the
// caller. today gives the default as-of date. It fails if catalog lacks one
// of those operations.
func ImportRecordsCSV(catalog []Tool, d Dispatcher, upload Uploader, today func() time.Time) (ExtraTool, error) {
	ops := map[string]Tool{}
	for _, name := range []string{opListScorecards, opCreateUpload, opInspect, opListTemplates, opPreviewRecords, opApplyImport} {
		i := indexOf(catalog, name)
		if i < 0 {
			return ExtraTool{}, fmt.Errorf("mcp: %s needs the %s operation", ImportCSVToolName, name)
		}
		ops[name] = catalog[i]
	}
	answers := map[string]any{"type": "object"}
	if body, ok := ops[opPreviewRecords].InputSchema["properties"].(map[string]any)[bodyArg].(map[string]any); ok {
		if a, ok := body["properties"].(map[string]any)["answers"].(map[string]any); ok {
			answers = a
		}
	}
	answers["description"] = "Answers to the preview's questions (unmatched product or team values, ignored values, value maps, date order), " +
		"as in preview_records_import. Apply with the answers you previewed."

	tool := Tool{
		Name: ImportCSVToolName,
		Description: "Import a CSV export of records (defects, epics, ...) the way the web app's Import page does: " +
			"the file is read with a saved records template, previewed, and applied unless dryRun is set. " +
			"The result has the import's preview (row counts, what changes on the scorecard, and questions) and, when applied, what was applied. " +
			"A file no saved template recognizes needs a template first (put_import_template, or set the import up once in the web app). " +
			"CSV text up to 700 KB, header on line 1. Admins only.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"recordType": map[string]any{"type": "string", "description": "The record type of the rows, such as defect (see list_record_types)."},
				"csv":        map[string]any{"type": "string", "description": "The CSV text, at most 700 KB, with the header on line 1."},
				"templateId": map[string]any{"type": "string", "description": "The saved records template to read the file with. Default: the saved template that recognizes the file's columns."},
				"scorecardId": map[string]any{"type": "string",
					"description": "The scorecard whose changes the preview shows. Default: the organization's only scorecard."},
				"asOf":    map[string]any{"type": "string", "format": "date", "description": "The date the export was taken, YYYY-MM-DD. Default: today."},
				"answers": answers,
				"dryRun":  map[string]any{"type": "boolean", "default": false, "description": "Preview only: nothing is applied."},
			},
			"required": []string{"recordType", "csv"},
		},
		Annotations: map[string]any{
			"title": "Import records from CSV", "readOnlyHint": false, "destructiveHint": false,
			"idempotentHint": false, "openWorldHint": false,
		},
	}
	imp := &csvImport{ops: ops, d: d, upload: upload, today: today}
	return ExtraTool{Tool: tool, Run: imp.run}, nil
}

func indexOf(tools []Tool, name string) int {
	for i, t := range tools {
		if t.Name == name {
			return i
		}
	}
	return -1
}

type csvImport struct {
	ops    map[string]Tool
	d      Dispatcher
	upload Uploader
	today  func() time.Time
}

// csvArgs are import_records_csv's arguments.
type csvArgs struct {
	recordType, csv, templateID, scorecardID, asOf string
	answers                                        map[string]any
	dryRun                                         bool
}

func parseCSVArgs(args map[string]any) (csvArgs, error) {
	var a csvArgs
	str := func(name string, required bool) (string, error) {
		v, ok := args[name]
		if !ok || v == nil {
			if required {
				return "", &ArgumentError{name, "is required"}
			}
			return "", nil
		}
		s, ok := v.(string)
		if !ok {
			return "", &ArgumentError{name, "must be a string"}
		}
		if required && strings.TrimSpace(s) == "" {
			return "", &ArgumentError{name, "is required"}
		}
		return s, nil
	}
	var err error
	if a.recordType, err = str("recordType", true); err != nil {
		return a, err
	}
	if a.csv, err = str("csv", true); err != nil {
		return a, err
	}
	if a.templateID, err = str("templateId", false); err != nil {
		return a, err
	}
	if a.scorecardID, err = str("scorecardId", false); err != nil {
		return a, err
	}
	if a.asOf, err = str("asOf", false); err != nil {
		return a, err
	}
	if v, ok := args["dryRun"]; ok && v != nil {
		if a.dryRun, ok = v.(bool); !ok {
			return a, &ArgumentError{"dryRun", "must be a boolean"}
		}
	}
	if v, ok := args["answers"]; ok && v != nil {
		if a.answers, ok = v.(map[string]any); !ok {
			return a, &ArgumentError{"answers", "must be an object"}
		}
	}
	return a, nil
}

func (c *csvImport) run(ctx context.Context, args map[string]any) (int, []byte, error) {
	a, err := parseCSVArgs(args)
	if err != nil {
		return 0, nil, err
	}
	if len(a.csv) > MaxImportCSVBytes {
		return http.StatusRequestEntityTooLarge, envelope("too_large",
			fmt.Sprintf("the CSV is %d KB; the limit is 700 KB. Split the export and import each part.", len(a.csv)>>10)), nil
	}

	// Start the import first: it is where the API checks the caller may import.
	var created struct {
		ImportID string `json:"importId"`
	}
	if st, body, err := c.step(ctx, opCreateUpload, map[string]any{bodyArg: map[string]any{"filename": importCSVFilename, "contentType": "text/csv"}}, &created); st != 0 || err != nil {
		return st, body, err
	}
	if a.scorecardID == "" {
		var list struct {
			Scorecards []struct {
				ID string `json:"id"`
			} `json:"scorecards"`
		}
		if st, body, err := c.step(ctx, opListScorecards, nil, &list); st != 0 || err != nil {
			return st, body, err
		}
		if len(list.Scorecards) != 1 {
			return http.StatusBadRequest, envelope("invalid", fmt.Sprintf(
				"this organization has %d scorecards; pass scorecardId (see list_scorecards)", len(list.Scorecards))), nil
		}
		a.scorecardID = list.Scorecards[0].ID
	}
	if err := c.upload(ctx, created.ImportID, []byte(a.csv)); err != nil {
		return 0, nil, fmt.Errorf("mcp: upload the CSV of import %s: %w", created.ImportID, err)
	}

	idArgs := map[string]any{"id": created.ImportID}
	var inspected struct {
		Inspection struct {
			MatchedTemplateID string `json:"matchedTemplateId"`
		} `json:"inspection"`
	}
	if st, body, err := c.step(ctx, opInspect, idArgs, &inspected); st != 0 || err != nil {
		return st, body, err
	}
	templateID := a.templateID
	if templateID == "" {
		templateID = inspected.Inspection.MatchedTemplateID
	}
	if templateID == "" {
		return http.StatusBadRequest, envelope("invalid",
			"no saved records template recognizes this file's columns; save one with put_import_template "+
				"(or set the import up once in the web app), or pass templateId"), nil
	}
	if st, body, err := c.checkTemplate(ctx, templateID, a.recordType); st != 0 || err != nil {
		return st, body, err
	}

	asOf := a.asOf
	if asOf == "" {
		asOf = c.today().Format(time.DateOnly)
	}
	previewBody := map[string]any{"scorecardId": a.scorecardID, "asOf": asOf, "templateId": templateID}
	if a.answers != nil {
		previewBody["answers"] = a.answers
	}
	var preview json.RawMessage
	if st, body, err := c.step(ctx, opPreviewRecords, map[string]any{"id": created.ImportID, bodyArg: previewBody}, &preview); st != 0 || err != nil {
		return st, body, err
	}
	out := map[string]any{
		"importId": created.ImportID, "templateId": templateID, "scorecardId": a.scorecardID,
		"asOf": asOf, "dryRun": a.dryRun, "preview": preview,
	}
	if a.dryRun {
		out["next"] = "Nothing was applied. To apply this preview, call apply_import with id " + created.ImportID +
			" and a body of the preview's planId and the same answers, or call import_records_csv again without dryRun."
	} else {
		var plan struct {
			PlanID string `json:"planId"`
		}
		if err := json.Unmarshal(preview, &plan); err != nil {
			return 0, nil, fmt.Errorf("mcp: decode the preview of import %s: %w", created.ImportID, err)
		}
		applyBody := map[string]any{"planId": plan.PlanID}
		if a.answers != nil {
			applyBody["answers"] = a.answers
		}
		var applied json.RawMessage
		if st, body, err := c.step(ctx, opApplyImport, map[string]any{"id": created.ImportID, bodyArg: applyBody}, &applied); st != 0 || err != nil {
			return st, body, err
		}
		out["applied"] = applied
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, raw, nil
}

// checkTemplate requires templateID to be a saved records template for
// recordType.
func (c *csvImport) checkTemplate(ctx context.Context, templateID, recordType string) (int, []byte, error) {
	var list struct {
		Templates []struct {
			ID      string `json:"id"`
			Profile string `json:"profile"`
			Body    struct {
				RecordType string `json:"recordType"`
			} `json:"body"`
		} `json:"templates"`
	}
	if st, body, err := c.step(ctx, opListTemplates, nil, &list); st != 0 || err != nil {
		return st, body, err
	}
	for _, t := range list.Templates {
		if t.ID != templateID {
			continue
		}
		switch {
		case t.Profile != "records":
			return http.StatusBadRequest, envelope("invalid", fmt.Sprintf("template %s is a %s template, not a records template", templateID, t.Profile)), nil
		case t.Body.RecordType != recordType:
			return http.StatusBadRequest, envelope("invalid", fmt.Sprintf("template %s imports %s records, not %s", templateID, t.Body.RecordType, recordType)), nil
		}
		return 0, nil, nil
	}
	return http.StatusBadRequest, envelope("invalid", fmt.Sprintf("template %s does not exist (see list_import_templates)", templateID)), nil
}

// step calls one operation and decodes its successful response into out. It
// returns status 0 on success; otherwise the operation's status and its error
// envelope with the message prefixed by the step, for the caller to return.
func (c *csvImport) step(ctx context.Context, op string, args map[string]any, out any) (int, []byte, error) {
	status, body, err := c.d.Call(ctx, c.ops[op], args)
	if err != nil {
		return 0, nil, err
	}
	if status < 200 || status > 299 {
		return status, prefixError(op, status, body), nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return 0, nil, fmt.Errorf("mcp: decode the %s response: %w", op, err)
	}
	return 0, nil, nil
}

// prefixError names the failing step in an API error envelope.
func prefixError(op string, status int, body []byte) []byte {
	var env map[string]map[string]any
	if json.Unmarshal(body, &env) != nil || env["error"] == nil {
		return envelope("internal", fmt.Sprintf("%s failed with HTTP %d", op, status))
	}
	msg, _ := env["error"]["message"].(string)
	env["error"]["message"] = op + ": " + msg
	raw, err := json.Marshal(env)
	if err != nil {
		return body
	}
	return raw
}
