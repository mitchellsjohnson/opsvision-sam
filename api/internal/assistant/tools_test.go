package assistant

import (
	"slices"
	"testing"

	"opsvision/internal/mcp"
)

func tool(name, method, path string) mcp.Tool {
	return mcp.Tool{Name: name, Method: method, PathTemplate: path, InputSchema: map[string]any{"type": "object"}}
}

func TestToolSetIsReadOnlyAndExcludesPrivatePaths(t *testing.T) {
	catalog := []mcp.Tool{
		tool("get_scorecard_view", "GET", "/scorecards/{sc}/view"),
		tool("list_org_units", "GET", "/org/units"),
		tool("delete_org_unit", "DELETE", "/org/units/{id}"),
		tool("create_item", "POST", "/items"),
		tool("put_report_summary", "PUT", "/scorecards/{sc}/reports/{period}/summary"),
		tool("list_members", "GET", "/members"),
		tool("get_member", "GET", "/members/{userId}"),
		tool("get_me", "GET", "/me"),
		tool("get_my_preferences", "GET", "/me/preferences"),
		tool("list_my_tokens", "GET", "/me/tokens"),
		tool("get_my_assistant_credential", "GET", "/me/assistant/credential"),
		tool("get_assistant_settings", "GET", "/assistant/settings"),
		tool("list_assistant_threads", "GET", "/assistant/threads"),
		tool("list_audit", "GET", "/audit"),
		tool("list_operator_tenants", "GET", "/operator/tenants"),
		tool("get_report_summary_draft", "GET", "/scorecards/{sc}/reports/{period}/summary/draft/{id}"),
		tool("get_report_summary", "GET", "/scorecards/{sc}/reports/{period}/summary"),
		tool("list_metrics_about_members", "GET", "/membersx"), // a prefix is not a path segment
		{Name: mcp.ImportCSVToolName},                          // an extra tool has no method
	}
	got := ToolSet(catalog)
	var names []string
	for _, tl := range got {
		names = append(names, tl.Name)
	}
	want := []string{"get_scorecard_view", "list_org_units", "get_report_summary", "list_metrics_about_members"}
	if !slices.Equal(names, want) {
		t.Fatalf("ToolSet = %v, want %v", names, want)
	}
	if len(ToolSet(nil)) != 0 {
		t.Fatal("ToolSet(nil) is not empty")
	}
}

func TestHelpToolsAreOffered(t *testing.T) {
	defs := toolDefs(ToolSet([]mcp.Tool{tool("get_scorecard_view", "GET", "/scorecards/{sc}/view")}))
	var names []string
	for _, d := range defs {
		names = append(names, d.Name)
		if d.InputSchema["type"] != "object" {
			t.Errorf("%s input schema %v is not an object", d.Name, d.InputSchema)
		}
	}
	if !slices.Equal(names, []string{"get_scorecard_view", SearchHelpTool, GetHelpTopicTool}) {
		t.Fatalf("tools offered = %v", names)
	}
}
