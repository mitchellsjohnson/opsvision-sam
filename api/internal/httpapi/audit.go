package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// maxAuditRange is the longest time range ListAudit serves.
const maxAuditRange = 31 * 24 * time.Hour

// ListAudit lists the tenant's audit entries from <= at < to, newest first.
// Admins only. The range must be positive and at most 31 days.
func (s *Server) ListAudit(ctx context.Context, req ListAuditRequestObject) (ListAuditResponseObject, error) {
	p, err := tenantAdmin(ctx)
	if err != nil {
		return nil, err
	}
	from, to := req.Params.From, req.Params.To
	var pr problems
	switch {
	case !to.After(from):
		pr.add("to", "must be after from")
	case to.Sub(from) > maxAuditRange:
		pr.add("to", "must be at most 31 days after from")
	}
	if err := pr.err(); err != nil {
		return nil, err
	}
	entries, err := s.store.ListAudit(ctx, p.Tenant.ID, from, to)
	if err != nil {
		return nil, err
	}
	// The store sorts by time then ID, oldest first.
	slices.Reverse(entries)
	out := make([]AuditEntry, len(entries))
	for i, e := range entries {
		out[i] = AuditEntry{
			Id: e.ID, ActorId: e.ActorID, Channel: e.Channel, Action: e.Action,
			TargetType: e.TargetType, TargetId: e.TargetID, At: e.At,
			Before: rawJSON(e.Before), After: rawJSON(e.After),
		}
	}
	return ListAudit200JSONResponse{Entries: out}, nil
}

// rawJSON returns raw for embedding in a response as-is, or
// nil (omitted) when raw is empty or JSON null.
func rawJSON(raw json.RawMessage) any {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	return raw
}
