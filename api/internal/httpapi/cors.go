package httpapi

import "net/http"

// corsMethods and corsHeaders are the only methods and request headers a
// browser may use cross-origin. The API authenticates with a bearer token in
// the Authorization header, never cookies, so credentials are not allowed.
const (
	corsMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	corsHeaders = "Authorization, Content-Type"
	corsMaxAge  = "600"
)

// CORS returns middleware that allows cross-origin browser requests from one
// origin: allowedOrigin, matched exactly (scheme, host and port; no
// wildcards, no suffix matching). An empty allowedOrigin, or "*", allows no
// origin: the API never answers with a wildcard.
//
// A preflight (OPTIONS with Access-Control-Request-Method) is answered with
// 204 right here, before any authentication, because browsers send it without
// credentials. Every other response, including errors from inner middleware,
// carries Access-Control-Allow-Origin when the request's Origin matches, so
// the browser can read a 401 instead of reporting an opaque network failure.
// A preflight from any other origin also gets 204 but no CORS headers, which
// makes the browser refuse the real request.
//
// Wrap the handler returned by NewHandler with it, outermost.
func CORS(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowed := allowedOrigin != "" && allowedOrigin != "*" && origin == allowedOrigin
			w.Header().Add("Vary", "Origin")
			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			}
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				if allowed {
					w.Header().Set("Access-Control-Allow-Methods", corsMethods)
					w.Header().Set("Access-Control-Allow-Headers", corsHeaders)
					w.Header().Set("Access-Control-Max-Age", corsMaxAge)
				}
				w.Header().Add("Vary", "Access-Control-Request-Method")
				w.Header().Add("Vary", "Access-Control-Request-Headers")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
