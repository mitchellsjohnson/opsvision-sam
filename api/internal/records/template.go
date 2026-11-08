package records

import (
	"fmt"
	"sort"
	"strings"

	"opsvision/internal/domain"
)

// FieldMap says where one record field or attribute comes from. Exactly one of
// Column (header text), Constant, and Template (a string with {Column}
// placeholders) names the source. Map translates raw values, with "*" as the
// fallback. Default replaces an empty cell and is used as is (it is not
// mapped). DateFormats are Go layouts tried in order. Separator splits a list
// column (priorDueDates). Transform applies to attributes only: nonEmpty,
// number, bool, date, text.
type FieldMap struct {
	Column      string            `json:"column,omitempty"`
	Constant    string            `json:"constant,omitempty"`
	Template    string            `json:"template,omitempty"`
	Map         map[string]string `json:"map,omitempty"`
	Default     string            `json:"default,omitempty"`
	DateFormats []string          `json:"dateFormats,omitempty"`
	Separator   string            `json:"separator,omitempty"`
	Transform   string            `json:"transform,omitempty"`
}

// FileSpec describes the export file. Format is "csv" or "xlsx"; Sheet names
// the worksheet (empty means the first visible one); HeaderRow is the 1-based
// row holding the headers (0 means 1).
type FileSpec struct {
	Format    string `json:"format"`
	Sheet     string `json:"sheet,omitempty"`
	HeaderRow int    `json:"headerRow"`
}

// SkipRule drops a row when its Column cell equals any of In (compared after
// trimming, ignoring case).
type SkipRule struct {
	Column string   `json:"column"`
	In     []string `json:"in"`
}

// Template maps one export format to one record type. It is stored and edited
// as JSON; see the records design, section 6.
type Template struct {
	Name       string              `json:"name"`
	RecordType string              `json:"recordType"`
	Source     string              `json:"source"`
	File       FileSpec            `json:"file"`
	FullExport bool                `json:"fullExport"`
	Fields     map[string]FieldMap `json:"fields"`
	Attributes map[string]FieldMap `json:"attributes,omitempty"`
	SkipRows   []SkipRule          `json:"skipRows,omitempty"`
}

// How a built-in field's cell is read.
type valueKind int

const (
	vkText valueKind = iota
	vkDate
	vkNumber
	vkDateList
	vkPriority
	vkState
)

// fieldSpec is a mappable built-in field. Field order is the order problems
// are reported in.
type fieldSpec struct {
	name     string
	kind     valueKind
	required bool
}

var fieldSpecs = []fieldSpec{
	{"externalId", vkText, true},
	{"subjectKey", vkText, true},
	{"title", vkText, false},
	{"category", vkText, false},
	{"priority", vkPriority, false},
	{"status", vkText, false},
	{"state", vkState, true},
	{"url", vkText, false},
	{"createdAt", vkDate, true},
	{"committedAt", vkDate, false},
	{"dueAt", vkDate, false},
	{"priorDueDates", vkDateList, false},
	{"completedAt", vkDate, false},
	{"measuredAt", vkDate, false},
	{"planned", vkNumber, false},
	{"actual", vkNumber, false},
	{"expectedValue", vkNumber, false},
	{"deliveredValue", vkNumber, false},
}

func lookupFieldSpec(name string) (fieldSpec, bool) {
	for _, f := range fieldSpecs {
		if f.name == name {
			return f, true
		}
	}
	return fieldSpec{}, false
}

// Attribute transforms.
const (
	TransformNonEmpty = "nonEmpty"
	TransformNumber   = "number"
	TransformBool     = "bool"
	TransformDate     = "date"
	TransformText     = "text"
)

// transformFor returns the transform in effect for an attribute of the given
// type: the explicit one, or the type's natural one.
func transformFor(fm FieldMap, typ domain.AttrType) string {
	if fm.Transform != "" {
		return fm.Transform
	}
	switch typ {
	case domain.AttrNumber:
		return TransformNumber
	case domain.AttrBool:
		return TransformBool
	case domain.AttrDate:
		return TransformDate
	}
	return TransformText
}

// transformType is the attribute type a transform produces; ok is false for an
// unknown transform.
func transformType(tr string) (domain.AttrType, bool) {
	switch tr {
	case TransformNonEmpty, TransformBool:
		return domain.AttrBool, true
	case TransformNumber:
		return domain.AttrNumber, true
	case TransformDate:
		return domain.AttrDate, true
	case TransformText:
		return domain.AttrString, true
	}
	return "", false
}

// Validate returns every problem found in the template against record type rt,
// or nil. Paths are like fields.state.map.Done, attributes.customerTicket,
// skipRows[0].column. Required fields are externalId, subjectKey, state, and
// createdAt; type and source come from the template, not from columns.
func (t Template) Validate(rt domain.RecordType) []domain.ValidationError {
	var errs []domain.ValidationError
	add := func(path, format string, args ...any) {
		errs = append(errs, domain.ValidationError{Path: path, Message: fmt.Sprintf(format, args...)})
	}

	if strings.TrimSpace(t.Name) == "" {
		add("name", "name is required")
	}
	switch {
	case t.RecordType == "":
		add("recordType", "record type is required")
	case t.RecordType != rt.ID:
		add("recordType", "template is for record type %q, not %q", t.RecordType, rt.ID)
	}
	if strings.TrimSpace(t.Source) == "" {
		add("source", "source is required")
	}
	if t.File.Format != "csv" && t.File.Format != "xlsx" {
		add("file.format", "format must be csv or xlsx, got %q", t.File.Format)
	}
	if t.File.HeaderRow < 0 {
		add("file.headerRow", "header row must be 1 or more")
	}

	for _, spec := range fieldSpecs {
		if _, ok := t.Fields[spec.name]; !ok && spec.required {
			add("fields."+spec.name, "%s is required", spec.name)
		}
	}
	for _, name := range sortedKeys(t.Fields) {
		path := "fields." + name
		fm := t.Fields[name]
		spec, ok := lookupFieldSpec(name)
		switch {
		case name == "type" || name == "source":
			add(path, "%s comes from the template, not from a column", name)
			continue
		case !ok:
			add(path, "unknown field %q", name)
			continue
		}
		checkSource(path, fm, add)
		checkDateFormats(path, fm, add)
		if fm.Transform != "" {
			add(path+".transform", "transform applies to attributes only")
		}
		switch spec.kind {
		case vkState:
			for _, raw := range sortedKeys(fm.Map) {
				if !domain.RecordState(fm.Map[raw]).Valid() {
					add(path+".map."+raw, "state must be open, done, or cancelled, got %q", fm.Map[raw])
				}
			}
			if fm.Default != "" && !domain.RecordState(fm.Default).Valid() {
				add(path+".default", "state must be open, done, or cancelled, got %q", fm.Default)
			}
		case vkPriority:
			allowed := rt.AllPriorities()
			for _, raw := range sortedKeys(fm.Map) {
				if !contains(allowed, fm.Map[raw]) {
					add(path+".map."+raw, "priority %q is not one of %s", fm.Map[raw], strings.Join(allowed, ", "))
				}
			}
			if fm.Default != "" && !contains(allowed, fm.Default) {
				add(path+".default", "priority %q is not one of %s", fm.Default, strings.Join(allowed, ", "))
			}
		}
	}

	defs := make(map[string]domain.AttributeDef, len(rt.Attributes))
	for _, a := range rt.Attributes {
		defs[a.Key] = a
	}
	for _, key := range sortedKeys(t.Attributes) {
		path := "attributes." + key
		fm := t.Attributes[key]
		def, ok := defs[key]
		if !ok {
			add(path, "unknown attribute %q for record type %q", key, rt.ID)
			continue
		}
		checkSource(path, fm, add)
		checkDateFormats(path, fm, add)
		if fm.Transform == "" {
			continue
		}
		got, known := transformType(fm.Transform)
		switch {
		case !known:
			add(path+".transform", "transform must be nonEmpty, number, bool, date, or text, got %q", fm.Transform)
		case got != def.Type:
			add(path+".transform", "transform %q produces a %s, but attribute %q is a %s", fm.Transform, got, key, def.Type)
		}
	}

	for i, rule := range t.SkipRows {
		path := fmt.Sprintf("skipRows[%d]", i)
		if strings.TrimSpace(rule.Column) == "" {
			add(path+".column", "column is required")
		}
		if len(rule.In) == 0 {
			add(path+".in", "list at least one value")
		}
	}

	if len(errs) == 0 {
		return nil
	}
	return errs
}

// checkSource requires exactly one of column, constant, and template.
func checkSource(path string, fm FieldMap, add func(string, string, ...any)) {
	n := 0
	for _, s := range []string{fm.Column, fm.Constant, fm.Template} {
		if s != "" {
			n++
		}
	}
	switch {
	case n == 0:
		add(path, "give a column, a constant, or a template")
	case n > 1:
		add(path, "use only one of column, constant, and template")
	}
}

func checkDateFormats(path string, fm FieldMap, add func(string, string, ...any)) {
	for i, layout := range fm.DateFormats {
		if strings.TrimSpace(layout) == "" {
			add(fmt.Sprintf("%s.dateFormats[%d]", path, i), "date format is empty")
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
