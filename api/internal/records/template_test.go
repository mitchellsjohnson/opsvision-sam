package records

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"opsvision/internal/domain"
)

// specTemplateJSON is the example from the records design, section 6.
const specTemplateJSON = `{
  "name": "Tracker defects export",
  "recordType": "defect",
  "source": "tracker",
  "file": { "format": "csv", "sheet": null, "headerRow": 1 },
  "fullExport": false,
  "fields": {
    "externalId":  { "column": "Issue key" },
    "title":       { "column": "Summary" },
    "subjectKey":  { "column": "Product" },
    "category":    { "column": "Issue Type" },
    "priority":    { "column": "Priority", "map": { "Highest": "P1", "High": "P2", "Medium": "P3", "Low": "P4" }, "default": "none" },
    "status":      { "column": "Status" },
    "state":       { "column": "Status", "map": { "Done": "done", "Closed": "done", "Won't Do": "cancelled", "*": "open" } },
    "createdAt":   { "column": "Created", "dateFormats": ["2006-01-02 15:04", "02/Jan/06 3:04 PM"] },
    "completedAt": { "column": "Resolved", "dateFormats": ["2006-01-02 15:04"] },
    "url":         { "template": "https://tracker.example/browse/{Issue key}" }
  },
  "attributes": {
    "customerTicket": { "column": "Linked tickets", "transform": "nonEmpty" }
  },
  "skipRows": [ { "column": "Issue Type", "in": ["Sub-task"] } ]
}`

func specTemplate(t testing.TB) Template {
	t.Helper()
	var tpl Template
	if err := json.Unmarshal([]byte(specTemplateJSON), &tpl); err != nil {
		t.Fatal(err)
	}
	return tpl
}

// problemPaths lists the paths of errs.
func problemPaths(errs []domain.ValidationError) []string {
	out := make([]string, len(errs))
	for i, e := range errs {
		out[i] = e.Path
	}
	return out
}

func TestTemplateJSON(t *testing.T) {
	tpl := specTemplate(t)
	if tpl.Name != "Tracker defects export" || tpl.RecordType != "defect" || tpl.Source != "tracker" ||
		tpl.File.Format != "csv" || tpl.File.Sheet != "" || tpl.File.HeaderRow != 1 || tpl.FullExport {
		t.Fatalf("header fields = %+v", tpl)
	}
	pri := tpl.Fields["priority"]
	if pri.Column != "Priority" || pri.Map["Highest"] != "P1" || pri.Default != "none" {
		t.Fatalf("priority = %+v", pri)
	}
	if got := tpl.Fields["createdAt"].DateFormats; len(got) != 2 || got[1] != "02/Jan/06 3:04 PM" {
		t.Fatalf("createdAt formats = %q", got)
	}
	if tpl.Fields["url"].Template != "https://tracker.example/browse/{Issue key}" {
		t.Fatalf("url = %+v", tpl.Fields["url"])
	}
	if tpl.Attributes["customerTicket"].Transform != "nonEmpty" {
		t.Fatalf("attribute = %+v", tpl.Attributes["customerTicket"])
	}
	if len(tpl.SkipRows) != 1 || tpl.SkipRows[0].Column != "Issue Type" || tpl.SkipRows[0].In[0] != "Sub-task" {
		t.Fatalf("skipRows = %+v", tpl.SkipRows)
	}

	// It survives a round trip, and every key keeps its spec name.
	out, err := json.Marshal(tpl)
	if err != nil {
		t.Fatal(err)
	}
	var back Template
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tpl, back) {
		t.Fatalf("round trip changed the template:\n%s", out)
	}
	for _, key := range []string{`"recordType"`, `"fullExport"`, `"fields"`, `"attributes"`, `"skipRows"`, `"file"`,
		`"format"`, `"headerRow"`, `"column"`, `"template"`, `"map"`, `"default"`, `"dateFormats"`, `"transform"`, `"in"`} {
		if !strings.Contains(string(out), key) {
			t.Errorf("marshaled template has no %s key: %s", key, out)
		}
	}

	sep := FieldMap{Column: "Earlier due dates", Separator: ";"}
	if b, _ := json.Marshal(sep); string(b) != `{"column":"Earlier due dates","separator":";"}` {
		t.Errorf("separator marshals as %s", b)
	}
	if b, _ := json.Marshal(FieldMap{Constant: "tracker"}); string(b) != `{"constant":"tracker"}` {
		t.Errorf("constant marshals as %s", b)
	}
}

func TestTemplateValidate(t *testing.T) {
	if errs := specTemplate(t).Validate(defectType); errs != nil {
		t.Fatalf("the spec example should be valid, got %v", errs)
	}

	// edit changes a fresh copy of the spec template.
	edit := func(f func(*Template)) []domain.ValidationError {
		tpl := specTemplate(t)
		f(&tpl)
		return tpl.Validate(defectType)
	}
	wantPath := func(t *testing.T, errs []domain.ValidationError, path string) {
		t.Helper()
		for _, e := range errs {
			if e.Path == path {
				return
			}
		}
		t.Fatalf("no error at %q in %v", path, errs)
	}

	t.Run("required fields", func(t *testing.T) {
		errs := Template{Name: "x", RecordType: "defect", Source: "tracker", File: FileSpec{Format: "csv"}}.Validate(defectType)
		want := []string{"fields.externalId", "fields.subjectKey", "fields.state", "fields.createdAt"}
		if got := problemPaths(errs); !reflect.DeepEqual(got, want) {
			t.Fatalf("paths = %v, want %v", got, want)
		}
	})
	t.Run("optional fields may be absent", func(t *testing.T) {
		errs := edit(func(tpl *Template) {
			for _, k := range []string{"title", "category", "priority", "status", "completedAt", "url"} {
				delete(tpl.Fields, k)
			}
			tpl.Attributes = nil
			tpl.SkipRows = nil
		})
		if errs != nil {
			t.Fatalf("got %v", errs)
		}
	})
	t.Run("unknown field", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) { tpl.Fields["severity"] = FieldMap{Column: "Sev"} }), "fields.severity")
	})
	t.Run("type and source are not columns", func(t *testing.T) {
		errs := edit(func(tpl *Template) {
			tpl.Fields["type"] = FieldMap{Column: "Kind"}
			tpl.Fields["source"] = FieldMap{Column: "System"}
		})
		wantPath(t, errs, "fields.type")
		wantPath(t, errs, "fields.source")
	})
	t.Run("unknown attribute", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) { tpl.Attributes["escalated"] = FieldMap{Column: "Esc"} }), "attributes.escalated")
	})
	t.Run("a field needs exactly one source", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) { tpl.Fields["title"] = FieldMap{} }), "fields.title")
		wantPath(t, edit(func(tpl *Template) { tpl.Fields["title"] = FieldMap{Column: "A", Constant: "B"} }), "fields.title")
		wantPath(t, edit(func(tpl *Template) { tpl.Attributes["customerTicket"] = FieldMap{Column: "A", Template: "{B}"} }), "attributes.customerTicket")
	})
	t.Run("state map values", func(t *testing.T) {
		errs := edit(func(tpl *Template) {
			tpl.Fields["state"] = FieldMap{Column: "Status", Map: map[string]string{"Done": "finished", "*": "open"}}
		})
		wantPath(t, errs, "fields.state.map.Done")
	})
	t.Run("priority map values", func(t *testing.T) {
		errs := edit(func(tpl *Template) {
			tpl.Fields["priority"] = FieldMap{Column: "Priority", Map: map[string]string{"Highest": "P0"}, Default: "P9"}
		})
		wantPath(t, errs, "fields.priority.map.Highest")
		wantPath(t, errs, "fields.priority.default")
	})
	t.Run("transform", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) {
			tpl.Attributes["customerTicket"] = FieldMap{Column: "A", Transform: "shout"}
		}), "attributes.customerTicket.transform")
		// nonEmpty makes a yes/no, so it cannot feed a string attribute.
		wantPath(t, edit(func(tpl *Template) {
			tpl.Attributes["team"] = FieldMap{Column: "A", Transform: "nonEmpty"}
		}), "attributes.team.transform")
		// transform is for attributes only.
		wantPath(t, edit(func(tpl *Template) {
			tpl.Fields["title"] = FieldMap{Column: "A", Transform: "text"}
		}), "fields.title.transform")
		if errs := edit(func(tpl *Template) {
			tpl.Attributes["severity"] = FieldMap{Column: "A", Transform: "number"}
			tpl.Attributes["reviewedAt"] = FieldMap{Column: "B", Transform: "date"}
			tpl.Attributes["team"] = FieldMap{Column: "C", Transform: "text"}
			tpl.Attributes["customerTicket"] = FieldMap{Column: "D", Transform: "bool"}
		}); errs != nil {
			t.Fatalf("matching transforms should be valid, got %v", errs)
		}
	})
	t.Run("header and file", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) { tpl.Name = " " }), "name")
		wantPath(t, edit(func(tpl *Template) { tpl.Source = "" }), "source")
		wantPath(t, edit(func(tpl *Template) { tpl.RecordType = "epic" }), "recordType")
		wantPath(t, edit(func(tpl *Template) { tpl.File.Format = "pdf" }), "file.format")
		wantPath(t, edit(func(tpl *Template) { tpl.File.HeaderRow = -1 }), "file.headerRow")
	})
	t.Run("skip rules", func(t *testing.T) {
		errs := edit(func(tpl *Template) { tpl.SkipRows = []SkipRule{{Column: "", In: nil}} })
		wantPath(t, errs, "skipRows[0].column")
		wantPath(t, errs, "skipRows[0].in")
	})
	t.Run("empty date format", func(t *testing.T) {
		wantPath(t, edit(func(tpl *Template) {
			tpl.Fields["createdAt"] = FieldMap{Column: "Created", DateFormats: []string{"2006-01-02", " "}}
		}), "fields.createdAt.dateFormats[1]")
	})
}

func TestTemplateValidateMapCaseCollisions(t *testing.T) {
	tpl := specTemplate(t)
	defect := defectType
	// Two keys that differ only in case and mean different things.
	tpl.Fields["state"].Map["done"] = "open"
	errs := tpl.Validate(defect)
	if got := problemPaths(errs); len(got) != 1 || got[0] != "fields.state.map.done" {
		t.Fatalf("problems = %v, want fields.state.map.done", errs)
	}
	if !strings.Contains(errs[0].Message, "Done") {
		t.Errorf("message = %q, want it to name the other key", errs[0].Message)
	}
	// The same meaning in two cases is fine.
	tpl.Fields["state"].Map["done"] = "done"
	if errs := tpl.Validate(defect); errs != nil {
		t.Errorf("same-target keys: problems = %v", errs)
	}
}
