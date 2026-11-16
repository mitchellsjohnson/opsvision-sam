package mcp_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"opsvision/internal/httpapi"
	"opsvision/internal/mcp"
)

// secretOps are the access-token and assistant-credential operations, which
// MCP must not expose.
var secretOps = []string{
	"listMyTokens", "createMyToken", "deleteMyToken",
	"getMyAssistantCredential", "putMyAssistantCredential", "deleteMyAssistantCredential",
}

func apiSpec(t *testing.T) *openapi3.T {
	t.Helper()
	spec, err := httpapi.GetSpec()
	if err != nil {
		t.Fatal(err)
	}
	return spec
}

func apiTools(t *testing.T) []mcp.Tool {
	t.Helper()
	tools, err := httpapi.Tools()
	if err != nil {
		t.Fatal(err)
	}
	return tools
}

func toolNamed(t *testing.T, tools []mcp.Tool, name string) mcp.Tool {
	t.Helper()
	i := slices.IndexFunc(tools, func(x mcp.Tool) bool { return x.Name == name })
	if i < 0 {
		t.Fatalf("no tool %q", name)
	}
	return tools[i]
}

func TestCatalogHasOneToolPerOperation(t *testing.T) {
	spec := apiSpec(t)
	var want []string
	for _, path := range spec.Paths.Keys() {
		for _, op := range spec.Paths.Value(path).Operations() {
			name := mcp.SnakeCase(op.OperationID)
			if !slices.ContainsFunc(secretOps, func(t string) bool { return mcp.SnakeCase(t) == name }) {
				want = append(want, name)
			}
		}
	}
	slices.Sort(want)
	var got []string
	for _, tool := range apiTools(t) {
		got = append(got, tool.Name)
	}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("tools\n got %v\nwant %v", got, want)
	}
	if len(got) < 50 {
		t.Fatalf("only %d tools", len(got))
	}
	for _, op := range secretOps {
		if slices.Contains(got, mcp.SnakeCase(op)) {
			t.Errorf("secret operation %s is exposed", op)
		}
	}
}

func TestSnakeCase(t *testing.T) {
	for in, want := range map[string]string{
		"getScorecardView":    "get_scorecard_view",
		"getMe":               "get_me",
		"batchSaveData":       "batch_save_data",
		"listMyTokens":        "list_my_tokens",
		"getHTTPStatus":       "get_http_status",
		"importV2Records":     "import_v2_records",
		"already_snake":       "already_snake",
		"createOrgMove":       "create_org_move",
		"listOperatorTenants": "list_operator_tenants",
	} {
		if got := mcp.SnakeCase(in); got != want {
			t.Errorf("SnakeCase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCatalogScorecardViewSchema(t *testing.T) {
	tool := toolNamed(t, apiTools(t), "get_scorecard_view")
	if tool.Method != "GET" || tool.PathTemplate != "/scorecards/{sc}/view" || tool.HasBody {
		t.Fatalf("tool = %+v", tool)
	}
	if !slices.Equal(tool.PathParams, []string{"sc"}) {
		t.Errorf("path params = %v", tool.PathParams)
	}
	for _, q := range []string{"periods", "ytd", "subjects", "metrics", "restate", "structure"} {
		if !slices.Contains(tool.QueryParams, q) {
			t.Errorf("query params %v lack %s", tool.QueryParams, q)
		}
	}
	if !strings.Contains(tool.Description, "Compute the scorecard table") {
		t.Errorf("description = %q", tool.Description)
	}
	s := tool.InputSchema
	if s["type"] != "object" {
		t.Fatalf("schema type = %v", s["type"])
	}
	if req := strs(s["required"]); !slices.Equal(req, []string{"sc"}) {
		t.Errorf("required = %v, want [sc]", req)
	}
	props := s["properties"].(map[string]any)
	periods := props["periods"].(map[string]any)
	if periods["type"] != "array" {
		t.Errorf("periods = %v", periods)
	}
	items := periods["items"].(map[string]any)
	if items["type"] != "string" || items["pattern"] == nil {
		t.Errorf("periods items are not the resolved Period schema: %v", items)
	}
	if _, ok := props["sc"].(map[string]any)["type"]; !ok {
		t.Errorf("sc schema not resolved: %v", props["sc"])
	}
	if tool.Annotations["readOnlyHint"] != true {
		t.Errorf("annotations = %v", tool.Annotations)
	}
}

func TestCatalogBodyAndAnnotations(t *testing.T) {
	tools := apiTools(t)
	put := toolNamed(t, tools, "put_my_preferences")
	if !put.HasBody || put.Method != "PUT" {
		t.Fatalf("put_my_preferences = %+v", put)
	}
	if !slices.Contains(strs(put.InputSchema["required"]), "body") {
		t.Errorf("required body missing: %v", put.InputSchema["required"])
	}
	body := put.InputSchema["properties"].(map[string]any)["body"].(map[string]any)
	if body["type"] != "object" || body["properties"] == nil {
		t.Errorf("body schema not resolved: %v", body)
	}
	if put.Annotations["idempotentHint"] != true || put.Annotations["readOnlyHint"] != false || put.Annotations["destructiveHint"] != true {
		t.Errorf("PUT annotations = %v", put.Annotations)
	}
	patch := toolNamed(t, tools, "update_member")
	if patch.Method != "PATCH" || patch.Annotations["destructiveHint"] != true {
		t.Errorf("PATCH annotations = %v (%s)", patch.Annotations, patch.Method)
	}
	del := toolNamed(t, tools, "delete_override")
	if del.Annotations["destructiveHint"] != true {
		t.Errorf("DELETE annotations = %v", del.Annotations)
	}
	// A POST creates: destructiveHint is left out rather than false.
	post := toolNamed(t, tools, "create_item_kind")
	if _, set := post.Annotations["destructiveHint"]; post.Annotations["readOnlyHint"] != false || set {
		t.Errorf("POST annotations = %v", post.Annotations)
	}
	if mcp.ReadOnly(post) || !mcp.ReadOnly(toolNamed(t, tools, "get_me")) {
		t.Error("ReadOnly is not GET")
	}
	upload := toolNamed(t, tools, "create_import_upload")
	if slices.Contains(strs(upload.InputSchema["required"]), "body") {
		t.Error("an optional request body is required")
	}
}

// No schema in the catalog keeps a $ref: clients get every shape inline.
func TestCatalogResolvesEveryRef(t *testing.T) {
	for _, tool := range apiTools(t) {
		raw, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatalf("%s: %v", tool.Name, err)
		}
		if strings.Contains(string(raw), `"$ref"`) {
			t.Errorf("%s keeps a $ref: %s", tool.Name, raw)
		}
		if strings.Contains(string(raw), `"nullable"`) {
			t.Errorf("%s keeps OpenAPI nullable: %s", tool.Name, raw)
		}
	}
}

const syntheticSpec = `
openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /mcp:
    post:
      operationId: mcp
      responses: { '200': { description: ok } }
  /things/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { $ref: '#/components/schemas/Id' } }
    get:
      operationId: getThing
      summary: One thing
      description: Reads it.
      parameters:
        - { name: full, in: query, schema: { type: boolean } }
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Node' } } } }
    put:
      operationId: putThing
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/Node' } } }
      responses: { '200': { description: ok } }
  /things/{id}/file:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getThingFile
      responses:
        '200': { description: ok, content: { application/octet-stream: { schema: { type: string, format: binary } } } }
    put:
      operationId: putThingFile
      requestBody:
        content: { application/octet-stream: { schema: { type: string, format: binary } } }
      responses: { '204': { description: done } }
  /secret:
    get:
      operationId: getSecret
      responses: { '200': { description: ok } }
components:
  schemas:
    Id: { type: string, pattern: '^[a-z]+$' }
    Node:
      type: object
      properties:
        name: { type: string, nullable: true }
        children: { type: array, items: { $ref: '#/components/schemas/Node' } }
`

func TestBuildCatalogExclusions(t *testing.T) {
	spec, err := openapi3.NewLoader().LoadFromData([]byte(syntheticSpec))
	if err != nil {
		t.Fatal(err)
	}
	tools, err := mcp.BuildCatalog(spec, func(op string) bool { return op == "getSecret" })
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	// /mcp itself, binary bodies and responses, and excluded operations are left out.
	if !slices.Equal(names, []string{"get_thing", "put_thing"}) {
		t.Fatalf("tools = %v", names)
	}
	get := tools[0]
	if get.Description != "One thing\n\nReads it." {
		t.Errorf("description = %q", get.Description)
	}
	props := get.InputSchema["properties"].(map[string]any)
	if props["id"].(map[string]any)["pattern"] != "^[a-z]+$" {
		t.Errorf("id = %v", props["id"])
	}
	if !slices.Equal(get.QueryParams, []string{"full"}) || !slices.Equal(strs(get.InputSchema["required"]), []string{"id"}) {
		t.Errorf("get = %+v", get)
	}
	body := tools[1].InputSchema["properties"].(map[string]any)["body"].(map[string]any)
	name := body["properties"].(map[string]any)["name"].(map[string]any)
	if !slices.Equal(strs(name["type"]), []string{"string", "null"}) {
		t.Errorf("nullable name = %v", name)
	}
	// A recursive schema stops at the cycle instead of expanding forever.
	children := body["properties"].(map[string]any)["children"].(map[string]any)
	if _, ok := children["items"].(map[string]any)["properties"]; ok {
		t.Errorf("recursive schema expanded: %v", children)
	}
}

// strs reads a JSON Schema string list (a []string, []any or a single string).
func strs(v any) []string {
	switch x := v.(type) {
	case []string:
		return x
	case string:
		return []string{x}
	case []any:
		out := make([]string, 0, len(x))
		for _, e := range x {
			s, _ := e.(string)
			out = append(out, s)
		}
		return out
	}
	return nil
}

// Every operation under the secret paths stays out of MCP, including any
// added later: a token or key handled by a tool would reach the model.
func TestCatalogHasNoSecretPaths(t *testing.T) {
	secret := func(path string) bool {
		for _, p := range []string{"/me/tokens", "/me/assistant"} {
			if path == p || strings.HasPrefix(path, p+"/") {
				return true
			}
		}
		return false
	}
	spec, err := httpapi.GetSpec()
	if err != nil {
		t.Fatal(err)
	}
	inSpec := 0
	for path, item := range spec.Paths.Map() {
		if secret(path) {
			inSpec += len(item.Operations())
		}
	}
	if inSpec == 0 {
		t.Fatal("no secret operations in the spec; the check checks nothing")
	}
	for _, tool := range apiTools(t) {
		if secret(tool.PathTemplate) {
			t.Errorf("%s (%s %s) is an MCP tool", tool.Name, tool.Method, tool.PathTemplate)
		}
	}
}
