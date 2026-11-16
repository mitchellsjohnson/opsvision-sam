package domain

import "time"

// DefaultAssistantModel is the model SAM uses until an admin chooses another:
// the lower-cost tier.
const DefaultAssistantModel = "claude-haiku-5-5"

// AssistantCredential is a user's model-provider API key in one tenant.
// Sealed is the key encrypted by an assistant.Sealer; the plaintext is never
// stored. Last4 is the end of the key, kept so people can tell keys apart.
type AssistantCredential struct {
	Sealed    []byte
	Last4     string
	UpdatedAt time.Time
}

// AssistantSettings are a tenant's assistant settings.
type AssistantSettings struct {
	Enabled bool
	Model   string
}

// DefaultAssistantSettings are the settings of a tenant that saved none.
func DefaultAssistantSettings() AssistantSettings {
	return AssistantSettings{Enabled: true, Model: DefaultAssistantModel}
}

// Assistant message roles.
const (
	AssistantRoleUser      = "user"
	AssistantRoleAssistant = "assistant"
)

// Assistant message statuses. A user message is always done.
const (
	AssistantStatusDone    = "done"
	AssistantStatusPending = "pending"
	AssistantStatusError   = "error"
)

// AssistantThread is one user's private conversation with SAM in one tenant.
// Revision counts the thread's saves (1 after creation); the store assigns
// it. Messages are oldest first; a thread list leaves them nil.
type AssistantThread struct {
	ID        string
	UserID    string
	Title     string
	Context   *AssistantContext
	CreatedAt time.Time
	UpdatedAt time.Time
	Revision  int
	Messages  []AssistantMessage
}

// AssistantContext is what the user was looking at when they asked: empty
// strings are unset. Page is overview, table, report, focus or other.
type AssistantContext struct {
	ScorecardID string `json:"scorecardId,omitempty"`
	Period      string `json:"period,omitempty"`
	Scope       string `json:"scope,omitempty"`
	MetricKey   string `json:"metricKey,omitempty"`
	Page        string `json:"page"`
}

// AssistantMessage is a question (Role user) or SAM's answer (Role
// assistant). Error is the user-facing reason of a failed answer.
type AssistantMessage struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Text      string          `json:"text"`
	Status    string          `json:"status"`
	Error     string          `json:"error,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	Usage     *AssistantUsage `json:"usage,omitempty"`
}

// AssistantUsage is what one answer cost: the provider's token counts summed
// over the turn's model calls, and the tools called.
type AssistantUsage struct {
	Model        string `json:"model"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
	ToolCalls    int    `json:"toolCalls"`
}
