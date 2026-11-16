package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"

	"opsvision/internal/auth"
	"opsvision/internal/mcp"
	"opsvision/internal/objects"
)

// mcpPath is the MCP endpoint (see package mcp).
const mcpPath = "/v1/mcp"

// mcpExcluded are the operations MCP does not offer as tools, by tool name
// (the embedded spec's operationIds are capitalized by the generator).
// Access tokens stay in the web app: a token minted by a tool would land in
// the model's context.
var mcpExcluded = map[string]bool{
	"list_my_tokens":  true,
	"create_my_token": true,
	"delete_my_token": true,
}

var mcpCatalog = sync.OnceValues(func() ([]mcp.Tool, error) {
	spec, err := GetSpec()
	if err != nil {
		return nil, err
	}
	return mcp.BuildCatalog(spec, func(op string) bool { return mcpExcluded[mcp.SnakeCase(op)] })
})

// Tools returns the MCP tool catalog of the API: one tool per operation of
// the embedded spec except the excluded ones. The tools share their schemas;
// treat them as read-only.
func Tools() ([]mcp.Tool, error) {
	tools, err := mcpCatalog()
	return slices.Clone(tools), err
}

// mcpHandler is the MCP endpoint: the catalog dispatched through api on the
// MCP channel, plus import_records_csv.
func (s *Server) mcpHandler(api http.Handler) http.Handler {
	tools, err := mcpCatalog()
	if err != nil {
		panic("httpapi: build the MCP catalog: " + err.Error())
	}
	d := mcp.NewHTTPDispatcher(api, auth.ChannelMCP)
	imp, err := mcp.ImportRecordsCSV(tools, d, s.putImportCSV, s.now)
	if err != nil {
		panic("httpapi: " + err.Error())
	}
	return mcp.NewHandler(tools, d, []mcp.ExtraTool{imp})
}

// putImportCSV stores csv as the file of a CSV import the caller started and
// has not uploaded to yet, as the browser's PUT to the upload URL would.
func (s *Server) putImportCSV(ctx context.Context, importID string, csv []byte) error {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return err
	}
	objs, err := s.objectStore()
	if err != nil {
		return err
	}
	im, err := s.loadImport(ctx, p.Tenant.ID, importID)
	if err != nil {
		return err
	}
	if im.Status != importUploaded || im.CreatedBy != p.UserID || !isCSVUpload(im.ObjectKey) {
		return errors.New("httpapi: the import is not a new CSV import of the caller")
	}
	return objs.Put(ctx, im.ObjectKey, objects.ContentTypeCSV, csv)
}
