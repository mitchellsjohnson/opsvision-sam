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
