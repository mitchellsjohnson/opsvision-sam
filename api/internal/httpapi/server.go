// Package httpapi is the OpsVision HTTP API. gen.go is generated from
// openapi/openapi.yaml; the rest implements the generated
// StrictServerInterface.
//
// Layout: server.go holds construction, routing and shared helpers; errors.go
// the error envelope; validate.go shared validators; mapping.go the
// domain-to-API conversions; one file per resource group holds its handlers
// (operator.go, members.go, org.go, imports.go, audit.go, ...). Server
// implements every operation of the spec.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/oklog/ulid/v2"

	"opsvision/internal/auth"
	"opsvision/internal/domain"
	"opsvision/internal/objects"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// maxBodyBytes bounds a request body. Bulk data arrives through the import
// flow, not through JSON bodies.
const maxBodyBytes = 4 << 20

// channelUI is the audit channel of writes made through the web UI.
const channelUI = "ui"

// Deps are the server's collaborators. Only Store is required.
type Deps struct {
	Store store.Store
	// Objects holds uploaded workbooks and parsed change sets. The import
	// endpoints answer 500 without it.
	Objects objects.Store
	// Calendar returns the fiscal calendar of a tenant. The default is built
	// from Tenant.FiscalYearStartMonth.
	Calendar func(domain.Tenant) period.Calendar
	// Now returns the current time. The default is time.Now().UTC().
	Now func() time.Time
	// NewID returns a new server-generated identifier. The default is a ULID.
	NewID func() string
}

// Server implements StrictServerInterface.
type Server struct {
	store    store.Store
	objects  objects.Store
	calendar func(domain.Tenant) period.Calendar
	now      func() time.Time
	newID    func() string
}

var _ StrictServerInterface = (*Server)(nil)

// NewServer builds a Server, filling in defaults for unset dependencies. It
// panics if d.Store is nil.
func NewServer(d Deps) *Server {
	if d.Store == nil {
		panic("httpapi: Deps.Store is required")
	}
	s := &Server{
		store:    d.Store,
		objects:  d.Objects,
		calendar: d.Calendar,
		now:      d.Now,
		newID:    d.NewID,
	}
	if s.calendar == nil {
		s.calendar = func(t domain.Tenant) period.Calendar {
			return period.Calendar{FiscalYearStartMonth: t.FiscalYearStartMonth}
		}
	}
	if s.now == nil {
		s.now = func() time.Time { return time.Now().UTC() }
	}
	if s.newID == nil {
		s.newID = func() string { return ulid.Make().String() }
	}
	return s
}

// NewHandler mounts the generated strict handler under /v1 behind authMW, with
// gzip compression of large JSON responses outermost. It
// panics if authMW is nil: an API without authentication must be a deliberate
// act, not a missing argument.
//
// It is NewHandler rather than Handler because the generated gen.go already
// declares Handler(ServerInterface).
func NewHandler(s *Server, authMW func(http.Handler) http.Handler) http.Handler {
	if authMW == nil {
		panic("httpapi: authentication middleware is required")
	}
	si := NewStrictHandlerWithOptions(s, nil, StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  requestErrorHandler,
		ResponseErrorHandlerFunc: responseErrorHandler,
	})
	api := HandlerWithOptions(si, StdHTTPServerOptions{
		BaseURL:          "/v1",
		ErrorHandlerFunc: requestErrorHandler,
	})
	return gzipMiddleware(authMW(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		api.ServeHTTP(w, r)
	})))
}

// principal returns the authenticated caller.
func principal(ctx context.Context) (auth.Principal, error) {
	p, ok := auth.FromContext(ctx)
	if !ok {
		return auth.Principal{}, unauthorized("missing or invalid token")
	}
	return p, nil
}

// member returns the caller if it is a member of its tenant. Tenant-scoped
// endpoints require it: a token without an organization, or an operator who
// has no membership in the organization, has no tenant access.
func member(ctx context.Context) (auth.Principal, error) {
	p, err := principal(ctx)
	if err != nil {
		return p, err
	}
	if p.Tenant == nil {
		return p, forbidden("this endpoint requires an organization")
	}
	if p.Membership == nil {
		return p, forbidden("not a member of this organization")
	}
	return p, nil
}

// tenantAdmin returns the caller if it may administer its tenant.
func tenantAdmin(ctx context.Context) (auth.Principal, error) {
	p, err := member(ctx)
	if err != nil {
		return p, err
	}
	if !auth.Can(p, auth.ActionTenantAdmin, auth.Resource{}, nil, period.Period{}) {
		return p, forbidden("tenant admin role required")
	}
	return p, nil
}

// operator returns the caller if it is a platform operator.
func operator(ctx context.Context) (auth.Principal, error) {
	p, err := principal(ctx)
	if err != nil {
		return p, err
	}
	if !p.IsOperator {
		return p, forbidden("operator access required")
	}
	return p, nil
}

// audit appends an audit entry for a write by p. before is nil for a create.
// A failure is returned so the request reports it instead of silently losing
// the record of a change.
func (s *Server) audit(ctx context.Context, p auth.Principal, tenantID, action, targetType, targetID string, before, after any) error {
	e := domain.AuditEntry{
		ID:         s.newID(),
		ActorID:    p.UserID,
		Channel:    channelUI,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		At:         s.now(),
	}
	var err error
	if before != nil {
		if e.Before, err = json.Marshal(before); err != nil {
			return err
		}
	}
	if after != nil {
		if e.After, err = json.Marshal(after); err != nil {
			return err
		}
	}
	return s.store.AppendAudit(ctx, tenantID, e)
}
