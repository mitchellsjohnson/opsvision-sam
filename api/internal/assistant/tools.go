package assistant

import (
	"encoding/json"
	"strings"

	"opsvision/internal/help"
	"opsvision/internal/mcp"
)

// Help tools: SAM's own, answered from package help without the API.
const (
	SearchHelpTool   = "search_help"
	GetHelpTopicTool = "get_help_topic"
)

// toolSetExcluded are the API paths SAM never reads, with everything under
// them: people and their tokens, keys and settings, SAM's own threads, the
// audit log, and the platform operator's endpoints.
var toolSetExcluded = []string{"/members", "/me", "/assistant", "/audit", "/operator"}

// ToolSet returns the API tools SAM may call: the read-only (GET) tools of
// catalog, except those whose path is one of the excluded paths or under
// one. It is the server-side allowlist; the model's choice of tool is never
// trusted.
func ToolSet(catalog []mcp.Tool) []mcp.Tool {
	out := []mcp.Tool{}
	for _, t := range catalog {
		if mcp.ReadOnly(t) && !excludedPath(t.PathTemplate) {
			out = append(out, t)
		}
	}
	return out
}

func excludedPath(p string) bool {
	for _, x := range toolSetExcluded {
		if p == x || strings.HasPrefix(p, x+"/") {
			return true
		}
	}
	return false
}

// toolDefs lists the tools offered to the model: tools, then the help tools.
func toolDefs(tools []mcp.Tool) []ToolDef {
	out := make([]ToolDef, 0, len(tools)+2)
	for _, t := range tools {
		out = append(out, ToolDef{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
	}
	ids := []any{}
	for _, tp := range help.All() {
		ids = append(ids, tp.ID)
	}
	return append(out,
		ToolDef{
			Name: SearchHelpTool,
			Description: "Search OpsVision's methodology help (statuses and bands, commitments and slips, derived measures, " +
				"restatement, imports, scope, report publishing, metric kinds, and more). Returns the best matching topics in full.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"query": map[string]any{"type": "string", "description": "A few words, such as \"commitment slip\"."}},
				"required":   []any{"query"},
			},
		},
		ToolDef{
			Name:        GetHelpTopicTool,
			Description: "Read one OpsVision methodology help topic by id.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"id": map[string]any{"type": "string", "enum": ids}},
				"required":   []any{"id"},
			},
		},
	)
}

type helpTopicJSON struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
}

func topicJSON(t help.Topic, body bool) helpTopicJSON {
	out := helpTopicJSON{ID: t.ID, Title: t.Title}
	if body {
		out.Body = t.Body
	}
	return out
}

func topicIndex() []helpTopicJSON {
	var out []helpTopicJSON
	for _, t := range help.All() {
		out = append(out, topicJSON(t, false))
	}
	return out
}

// runHelp answers a help tool call: the result text and whether it is an
// error.
func runHelp(name string, input map[string]any) (string, bool) {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	switch name {
	case SearchHelpTool:
		q, _ := input["query"].(string)
		found := []helpTopicJSON{}
		for _, t := range help.Search(q) {
			found = append(found, topicJSON(t, true))
		}
		if len(found) == 0 {
			return enc(map[string]any{"topics": found, "note": "No topic matched; these are all the topics.", "available": topicIndex()}), false
		}
		return enc(map[string]any{"topics": found}), false
	default:
		id, _ := input["id"].(string)
		t, ok := help.Get(id)
		if !ok {
			return enc(map[string]any{"error": "no help topic " + id, "available": topicIndex()}), true
		}
		return enc(topicJSON(t, true)), false
	}
}
