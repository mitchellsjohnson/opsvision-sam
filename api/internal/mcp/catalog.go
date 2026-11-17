// Package mcp serves the OpsVision API to MCP clients: a JSON-RPC 2.0
// endpoint over the MCP Streamable HTTP transport, with JSON responses only
// (no server-sent events) and no sessions.
//
// The tool catalog is built from the OpenAPI document (BuildCatalog): one
// tool per operation. A tool call is dispatched in-process through the API's
// own router as the caller (NewHTTPDispatcher), so routing, authorization,
// validation and audit are the API's; nothing here re-implements a rule.
package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode"

	"github.com/getkin/kin-openapi/openapi3"
)

// Tool is one MCP tool. Tools built from the API name the operation they
// call: Method and PathTemplate (relative to /v1, for example
// "/scorecards/{sc}/view"), the argument names that fill the path and the
// query, and whether the "body" argument is the request body.
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Annotations map[string]any

	Method       string
	PathTemplate string
	PathParams   []string
	QueryParams  []string
	HasBody      bool
}

// ReadOnly reports whether a tool only reads: it calls a GET operation.
func ReadOnly(t Tool) bool { return t.Method == http.MethodGet }

// bodyArg is the argument that carries the request body.
const bodyArg = "body"

// methodOrder lists the methods a path's operations are listed in.
var methodOrder = []string{
	http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete,
}

// BuildCatalog returns one tool per operation of spec, in path order, except
// the operations exclude reports (by operationId), the MCP endpoint itself
// (/mcp), and operations that take or return something other than JSON.
// Parameters marked x-mcp-hidden: true are left out of their tool.
// Every $ref is resolved, so a client sees each schema inline. It fails on
// an operation without an operationId, two operations with one tool name,
// or a parameter the catalog cannot pass (a required header or cookie, a
// required hidden one, or one named "body").
func BuildCatalog(spec *openapi3.T, exclude func(opID string) bool) ([]Tool, error) {
	if spec == nil || spec.Paths == nil {
		return nil, fmt.Errorf("mcp: the spec has no paths")
	}
	paths := spec.Paths.Keys()
	slices.Sort(paths)
	var out []Tool
	seen := map[string]string{}
	for _, path := range paths {
		if path == "/mcp" || strings.HasPrefix(path, "/mcp/") {
			continue
		}
		item := spec.Paths.Value(path)
		ops := item.Operations()
		for _, method := range methodOrder {
			op := ops[method]
			if op == nil {
				continue
			}
			if op.OperationID == "" {
				return nil, fmt.Errorf("mcp: %s %s has no operationId", method, path)
			}
			if (exclude != nil && exclude(op.OperationID)) || !jsonOnly(op) {
				continue
			}
			t, err := buildTool(method, path, item, op)
			if err != nil {
				return nil, err
			}
			if prev, dup := seen[t.Name]; dup {
				return nil, fmt.Errorf("mcp: operations %s and %s are both tool %s", prev, op.OperationID, t.Name)
			}
			seen[t.Name] = op.OperationID
			out = append(out, t)
		}
	}
	return out, nil
}

// jsonOnly reports whether an operation's request body and successful
// responses, when they have content, are JSON.
func jsonOnly(op *openapi3.Operation) bool {
	if op.RequestBody != nil && op.RequestBody.Value != nil {
		if op.RequestBody.Value.Content.Get("application/json") == nil {
			return false
		}
	}
	if op.Responses == nil {
		return true
	}
	for code, r := range op.Responses.Map() {
		if !strings.HasPrefix(code, "2") || r.Value == nil || len(r.Value.Content) == 0 {
			continue
		}
		if r.Value.Content.Get("application/json") == nil {
			return false
		}
	}
	return true
}

func buildTool(method, path string, item *openapi3.PathItem, op *openapi3.Operation) (Tool, error) {
	t := Tool{
		Name:         SnakeCase(op.OperationID),
		Description:  describe(op),
		Method:       method,
		PathTemplate: path,
		Annotations:  annotations(method, op),
	}
	props := map[string]any{}
	required := []string{}

	// Operation parameters override path-level ones of the same name and place.
	params := map[string]*openapi3.Parameter{}
	var order []string
	for _, refs := range []openapi3.Parameters{item.Parameters, op.Parameters} {
		for _, ref := range refs {
			p := ref.Value
			if p == nil {
				continue
			}
			key := p.In + ":" + p.Name
			if _, ok := params[key]; !ok {
				order = append(order, key)
			}
			params[key] = p
		}
	}
	for _, key := range order {
		p := params[key]
		if hidden(p) {
			if p.Required || p.In == openapi3.ParameterInPath {
				return Tool{}, fmt.Errorf("mcp: %s: required parameter %s is hidden", op.OperationID, p.Name)
			}
			continue
		}
		switch p.In {
		case openapi3.ParameterInPath:
			t.PathParams = append(t.PathParams, p.Name)
		case openapi3.ParameterInQuery:
			t.QueryParams = append(t.QueryParams, p.Name)
		default:
			if p.Required {
				return Tool{}, fmt.Errorf("mcp: %s: required %s parameter %s cannot be passed", op.OperationID, p.In, p.Name)
			}
			continue
		}
		if p.Name == bodyArg {
			return Tool{}, fmt.Errorf("mcp: %s: a parameter is named %q", op.OperationID, bodyArg)
		}
		if _, dup := props[p.Name]; dup {
			return Tool{}, fmt.Errorf("mcp: %s: two parameters are named %q", op.OperationID, p.Name)
		}
		s := map[string]any{}
		if p.Schema != nil {
			s = inline(p.Schema, nil)
		}
		if p.Description != "" {
			s["description"] = p.Description
		}
		props[p.Name] = s
		if p.Required || p.In == openapi3.ParameterInPath {
			required = append(required, p.Name)
		}
	}
	if rb := op.RequestBody; rb != nil && rb.Value != nil {
		t.HasBody = true
		s := map[string]any{}
		if mt := rb.Value.Content.Get("application/json"); mt != nil && mt.Schema != nil {
			s = inline(mt.Schema, nil)
		}
		if rb.Value.Description != "" {
			s["description"] = rb.Value.Description
		} else if _, ok := s["description"]; !ok {
			s["description"] = "The request body."
		}
		props[bodyArg] = s
		if rb.Value.Required {
			required = append(required, bodyArg)
		}
	}
	t.InputSchema = map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		t.InputSchema["required"] = required
	}
	return t, nil
}

// hiddenExt marks a parameter tools never pass, such as a large block only
// the web asks for.
const hiddenExt = "x-mcp-hidden"

func hidden(p *openapi3.Parameter) bool {
	v, _ := p.Extensions[hiddenExt].(bool)
	return v
}

func describe(op *openapi3.Operation) string {
	var parts []string
	for _, s := range []string{op.Summary, op.Description} {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	if len(parts) == 0 {
		return op.OperationID
	}
	return strings.Join(parts, "\n\n")
}

// annotations are the MCP tool hints of an operation: GET only reads; PUT,
// PATCH and DELETE can overwrite or remove data; PUT and DELETE are
// idempotent. A POST creates, which is not destructive but not known safe
// either, so it has no destructiveHint.
func annotations(method string, op *openapi3.Operation) map[string]any {
	a := map[string]any{
		"readOnlyHint":   method == http.MethodGet,
		"idempotentHint": method == http.MethodGet || method == http.MethodPut || method == http.MethodDelete,
		"openWorldHint":  false,
	}
	switch method {
	case http.MethodGet:
		a["destructiveHint"] = false
	case http.MethodPut, http.MethodPatch, http.MethodDelete:
		a["destructiveHint"] = true
	}
	if op.Summary != "" {
		a["title"] = strings.TrimSpace(op.Summary)
	}
	return a
}

// SnakeCase converts an operationId to a tool name: getScorecardView is
// get_scorecard_view, and an acronym is one word (getHTTPStatus is
// get_http_status).
func SnakeCase(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		if unicode.IsUpper(r) {
			if i > 0 {
				prev := rs[i-1]
				nextLower := i+1 < len(rs) && unicode.IsLower(rs[i+1])
				if unicode.IsLower(prev) || unicode.IsDigit(prev) || (unicode.IsUpper(prev) && nextLower) {
					b.WriteByte('_')
				}
			}
			b.WriteRune(unicode.ToLower(r))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// nested lists the schema keywords whose values are schemas or schema lists;
// inline rebuilds them from the typed schema so every $ref is resolved.
var nested = []string{"properties", "items", "allOf", "oneOf", "anyOf", "not", "additionalProperties"}

// inline returns ref's schema as a JSON Schema object with every $ref
// resolved. OpenAPI's nullable becomes a "null" type and example becomes
// examples. A schema that contains itself stops at the cycle with an
// unconstrained schema that says so. stack holds the schemas being expanded.
func inline(ref *openapi3.SchemaRef, stack []*openapi3.Schema) map[string]any {
	if ref == nil || ref.Value == nil {
		return map[string]any{}
	}
	s := ref.Value
	if slices.Contains(stack, s) {
		name := ref.Ref[strings.LastIndex(ref.Ref, "/")+1:]
		return map[string]any{"description": "The same shape as the enclosing " + name + " (recursive)."}
	}
	stack = append(stack, s)

	out := map[string]any{}
	if raw, err := json.Marshal(s); err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	for _, k := range nested {
		delete(out, k)
	}
	for k := range out {
		if strings.HasPrefix(k, "x-") {
			delete(out, k)
		}
	}
	delete(out, "discriminator")
	delete(out, "xml")
	delete(out, "externalDocs")

	if len(s.Properties) > 0 {
		props := map[string]any{}
		for name, p := range s.Properties {
			props[name] = inline(p, stack)
		}
		out["properties"] = props
	}
	if s.Items != nil {
		out["items"] = inline(s.Items, stack)
	}
	for k, list := range map[string]openapi3.SchemaRefs{"allOf": s.AllOf, "oneOf": s.OneOf, "anyOf": s.AnyOf} {
		if len(list) == 0 {
			continue
		}
		xs := make([]any, len(list))
		for i, x := range list {
			xs[i] = inline(x, stack)
		}
		out[k] = xs
	}
	if s.Not != nil {
		out["not"] = inline(s.Not, stack)
	}
	switch ap := s.AdditionalProperties; {
	case ap.Schema != nil:
		out["additionalProperties"] = inline(ap.Schema, stack)
	case ap.Has != nil:
		out["additionalProperties"] = *ap.Has
	}

	if ex, ok := out["example"]; ok {
		delete(out, "example")
		out["examples"] = []any{ex}
	}
	if s.Nullable {
		delete(out, "nullable")
		switch typ := out["type"].(type) {
		case string:
			out["type"] = []any{typ, "null"}
		case []any:
			if !slices.Contains(typ, any("null")) {
				out["type"] = append(typ, "null")
			}
		default:
			out = map[string]any{"anyOf": []any{out, map[string]any{"type": "null"}}}
		}
	}
	return out
}
