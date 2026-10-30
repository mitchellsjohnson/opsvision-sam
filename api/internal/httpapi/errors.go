package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"opsvision/internal/store"
)

// Error codes of the API error envelope (see the Error schema in the spec).
const (
	codeInvalid        = "invalid"
	codeUnauthorized   = "unauthorized"
	codeForbidden      = "forbidden"
	codeNotFound       = "not_found"
	codeConflict       = "conflict"
	codeNotImplemented = "not_implemented"
	codeInternal       = "internal"
)

// detail is one validation problem; path looks like `levels[0].id`.
type detail struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// apiError is an error that maps directly to an HTTP response. Handlers
// return it as the error result of a strict-server method; the
// ResponseErrorHandlerFunc writes it as the error envelope.
type apiError struct {
	status  int
	code    string
	message string
	details []detail
}

// Error implements error.
func (e *apiError) Error() string { return e.code + ": " + e.message }

// errNotImplemented is returned by the stubs in unimplemented.go.
var errNotImplemented = &apiError{
	status:  http.StatusNotImplemented,
	code:    codeNotImplemented,
	message: "this operation is not implemented yet",
}

func badRequest(msg string, details ...detail) *apiError {
	return &apiError{status: http.StatusBadRequest, code: codeInvalid, message: msg, details: details}
}

func unauthorized(msg string) *apiError {
	return &apiError{status: http.StatusUnauthorized, code: codeUnauthorized, message: msg}
}

func forbidden(msg string) *apiError {
	return &apiError{status: http.StatusForbidden, code: codeForbidden, message: msg}
}

func notFound(msg string) *apiError {
	return &apiError{status: http.StatusNotFound, code: codeNotFound, message: msg}
}

func conflict(msg string) *apiError {
	return &apiError{status: http.StatusConflict, code: codeConflict, message: msg}
}

// writeError writes the error envelope.
func writeError(w http.ResponseWriter, e *apiError) {
	body := struct {
		Error struct {
			Code    string   `json:"code"`
			Message string   `json:"message"`
			Details []detail `json:"details,omitempty"`
		} `json:"error"`
	}{}
	body.Error.Code = e.code
	body.Error.Message = e.message
	body.Error.Details = e.details
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(body)
}

// requestErrorHandler handles request decoding and parameter binding errors:
// always a 400 invalid envelope. The decoder's message is not echoed; it can
// quote request bytes.
func requestErrorHandler(w http.ResponseWriter, _ *http.Request, _ error) {
	writeError(w, badRequest("malformed request"))
}

// responseErrorHandler maps handler errors to the envelope. Typed API errors
// keep their status; store sentinels map to 404/409; anything else is an
// internal error with a generic message (details are logged, never sent).
func responseErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
		writeError(w, ae)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, notFound("not found"))
	case errors.Is(err, store.ErrConflict):
		writeError(w, conflict("conflict with current state"))
	default:
		slog.Error("httpapi: internal error", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, &apiError{status: http.StatusInternalServerError, code: codeInternal, message: "internal error"})
	}
}
