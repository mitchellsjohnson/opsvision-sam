// Package auth authenticates API requests, resolves the caller's tenant, and
// answers authorization questions.
//
// The API trusts only the verified access token for identity: the user is the
// token's sub claim and the tenant is resolved from its org_id claim (an Auth0
// Organization), or in single-organization mode is the one configured tenant.
// A personal access token (TokenPrefix) stands for the user and tenant it was
// created for. Nothing in the URL, query string, headers, or body can select a
// tenant or user.
package auth

import (
	"context"

	"opsvision/internal/domain"
)

// Channels a request can arrive through; see Principal.Channel.
const (
	// ChannelToken is a request authenticated by a personal access token.
	ChannelToken = "token"
	// ChannelMCP is a request made through the MCP endpoint.
	ChannelMCP = "mcp"
	// ChannelAssistant is a read made by SAM, the assistant, for the user
	// whose turn it is.
	ChannelAssistant = "assistant"
)

// Principal is the authenticated caller of a request.
type Principal struct {
	// UserID is the token's sub claim.
	UserID string
	Email  string
	Name   string
	// IsOperator reports that the token carries the operate:platform
	// permission. Operators administer the platform, not tenant data: an
	// operator has tenant rights only through an explicit membership.
	IsOperator bool
	// Tenant is the tenant named by the token's org_id claim (the configured
	// tenant in single-organization mode); nil for an operator token without
	// an organization.
	Tenant *domain.Tenant
	// Membership is the caller's membership in Tenant; nil when Tenant is nil
	// and for an operator who is not a member of Tenant.
	Membership *domain.Membership
	// Channel is how the request arrived, as recorded in the audit log: ""
	// for the identity provider's token (the web UI), ChannelToken,
	// ChannelMCP, or ChannelAssistant. For an access token, UserID is the token's owner, Email
	// and Name come from the membership, and IsOperator is false.
	Channel string
	// Interactive reports a person signed in through the identity provider
	// (the web app). Only the middleware's identity-provider path sets it;
	// access tokens, MCP calls and SAM never have it.
	Interactive bool
}

type ctxKey struct{}

// WithPrincipal returns a context carrying p. The middleware uses it; handler
// tests use it to simulate an authenticated request.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the Principal the middleware attached to ctx.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
