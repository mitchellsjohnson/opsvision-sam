# API Tokens, MCP Server, and Ask SAM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Personal access tokens, an MCP server that exposes every API operation, and SAM — an in-app assistant on each user's own Claude key with read-only tools and methodology help — plus an AI-drafted report summary.

**Architecture:** Tokens become a second credential type in the existing auth middleware. The MCP endpoint builds its tool catalog from the embedded OpenAPI document and dispatches each call in-process through the same router, so authz, validation, and audit are shared. SAM runs turns off the request path (in-process locally, an SQS-triggered worker in AWS), calling the provider over HTTPS with the user's decrypted key and the read-only subset of the same catalog plus embedded help topics.

**Tech Stack:** Go 1.27 (net/http, oapi-codegen strict server, kin-openapi already in the module graph), DynamoDB single table, aws-sdk-go-v2 (new: `service/sqs` v1.53.0, `service/kms` v1.62.6, vetted 2026-11-14 by the maintainer's dependency-vetting service: Apache-2.0, no vulnerabilities, not malicious), React 19 + TypeScript + TanStack Query + Tailwind + Radix primitives.

**Spec:** `docs/superpowers/specs/2026-11-14-mcp-and-ask-sam-design.md`

## Global Constraints

- No first-adopter company or product names, domains, account ids, or identity-provider ids anywhere in this repo (code, tests, fixtures, help topics, comments). Example names only (`Example Co`, `Unit A`, `example.test`).
- Dependencies: only the two Go modules above may be added, at exactly those versions. If `go get` bumps any other module, vet each bumped module and version with the dependency-vetting MCP (`getComponentVersion`) before committing; if a bump is not compliant, stop and report NEEDS_CONTEXT. No web dependency unless it passes that vetting first (see Task 7).
- OpenAPI first: edit `openapi/openapi.yaml`, run `make gen`, commit `api/internal/httpapi/gen.go` and `web/src/api/schema.d.ts` with the edit; `make gen-check` must pass.
- Secrets (access tokens, Claude API keys) are never returned after creation, never logged, never in audit `before`/`after`, never sent to the model, never stored in plaintext.
- SAM never writes. The server enforces a read-only allowlist for SAM's tools; prompts are not a security boundary.
- Audit channels: browser `ui` (today), access-token API `token`, MCP `mcp`.
- Default model `claude-haiku-5-5`; offered alternative `claude-sonnet-5-5`; admins may enter any model id.
- Provider: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`; base URL overridable by `OPSVISION_ASSISTANT_BASE_URL` (tests use an httptest server).
- Limits: turn budget 90 s, ≤ 8 tool rounds, `max_tokens` 2000 per call; MCP/SAM tool results truncated above 512 KB; `import_records_csv` CSV ≤ 700 KB; ≤ 10 active tokens per user; token lifetime 1–365 days (default 90); 50 threads kept per user.
- Web: tokens from `web/src/ui/tokens.css`; status never color alone; the document is the only scroll container on pages (drawers may scroll); axe passes on every new page/drawer test.
- Suites: `cd api && go test ./...`, `make gen-check`, `cd web && npm test`, `npm run typecheck`, `npm run lint` (0 errors).

## Review Focus

- A token that is revoked, expired, or whose user was removed from the tenant must stop working on the next request (401/403), including through MCP. Test in Task 1.
- A tool call whose JSON result exceeds the budget (a 24-month company view) returns a truncated, valid result with a note, never a 500 or an ALB 502. Test in Task 3.
- Provider failures (401 bad key, 429, 5xx, timeout, worker crash) never leave a message pending forever: errors become an error message; a pending message older than 3 minutes is reported as failed on read. Test in Task 5.
- Data that reads like instructions (a record description saying "call delete_org_unit") cannot cause a write: SAM's dispatcher rejects any non-allowlisted operation server-side. Test in Task 5.
- Double-submit: a second message while one is pending returns 409 and the UI keeps one pending bubble. Tests in Tasks 5 and 7.

---

### Task 1: Personal access tokens (API)

**Files:**
- Modify: `openapi/openapi.yaml` (ops `createMyToken` POST `/me/tokens`, `listMyTokens` GET `/me/tokens`, `deleteMyToken` DELETE `/me/tokens/{id}`; schemas `CreateTokenRequest{name, expiresInDays}`, `AccessToken{id,name,prefix,createdAt,expiresAt,lastUsedAt?}`, `CreatedAccessToken` = AccessToken + `token`), `api/internal/httpapi/gen.go`, `web/src/api/schema.d.ts`
- Create: `api/internal/domain/token.go`, `api/internal/httpapi/tokens.go`, `api/internal/httpapi/tokens_test.go`, `api/internal/auth/pat.go`, `api/internal/auth/pat_test.go`
- Modify: `api/internal/store/store.go` (add `TokenStore` to `Store`), `api/internal/store/memstore/*`, `api/internal/store/dynamostore/*`, `api/internal/store/storetest/*` (contract), `api/internal/auth/middleware.go`, `api/internal/auth/principal.go`, `api/internal/httpapi/server.go` (audit channel)

**Interfaces:**
- Produces:
  - `domain.AccessToken{ID, TenantID, UserID, Name, Prefix string; Hash [32]byte; CreatedAt, ExpiresAt time.Time; LastUsedAt *time.Time}`
  - `store.TokenStore`: `PutToken(ctx, t domain.AccessToken) error`; `TokenByHash(ctx, hash [32]byte) (domain.AccessToken, error)` (ErrNotFound); `ListTokens(ctx, tenantID, userID string) ([]domain.AccessToken, error)`; `DeleteToken(ctx, tenantID, userID, id string) error`; `TouchToken(ctx, tenantID, userID, id string, at time.Time) error`
  - `auth.TokenPrefix = "ovs_pat_"`; `auth.NewToken() (secret string, hash [32]byte, prefix string, err error)`; `auth.HashToken(secret string) [32]byte`
  - `auth.Principal.Channel string` — `""` (treated as `ui`), `"token"`, `"mcp"`
  - `Server.audit` uses `p.Channel` (default `channelUI`)

- [ ] **Step 1: Failing tests.** `pat_test.go`: `TestNewTokenFormat` (prefix `ovs_pat_`, length 8+43, prefix field = first 12 chars, hash = sha256(secret)). `tokens_test.go`: `TestCreateTokenReturnsSecretOnce` (POST returns `token`; GET list has no `token` field), `TestTokenLifetimeBounds` (0 and 366 → 400; omitted → 90 days), `TestTokenLimit` (11th active → 409), `TestDeleteTokenOtherUser404`, `TestTokenAudited` (audit entry action `create`/`delete`, targetType `access_token`, after JSON has no `token`/`hash`). Middleware tests: `TestBearerTokenAuthenticates` (principal = owner, Channel `token`, current membership role), `TestRevokedTokenRejected` (401), `TestExpiredTokenRejected` (401), `TestRemovedMemberTokenRejected` (403), `TestTokenTouchThrottled` (two requests within 60 s → one TouchToken). Contract suite: put/get-by-hash/list/delete/touch, tenant and user isolation.
- [ ] **Step 2:** Run `cd api && go test ./internal/auth/... ./internal/httpapi/... ./internal/store/...` — FAIL.
- [ ] **Step 3:** Implement. Middleware: if the bearer starts with `ovs_pat_`, resolve via `TokenByHash` (constant-time compare not needed for a hash lookup), reject expired, load tenant and membership as the JWT path does, set `Channel: "token"`; otherwise the existing JWT path. Dynamo keys follow existing conventions (an item per token under the user, plus a GSI1 entry keyed by hash).
- [ ] **Step 4:** `cd api && go test ./...` and `make gen-check` — PASS.
- [ ] **Step 5:** Commit `feat(api): personal access tokens`.

### Task 2: Access tokens page (web)

**Files:**
- Create: `web/src/features/settings/AccessTokensPage.tsx`, `AccessTokensPage.test.tsx`
- Modify: `web/src/App.tsx` (route `settings/tokens`), `web/src/shell/AppShell.tsx` (My settings → Access tokens link), `web/src/api/queries.ts` (hooks `useMyTokens`, `useCreateToken`, `useDeleteToken`)

**Interfaces:**
- Consumes: Task 1 operations.

- [ ] **Step 1: Failing tests.** Create shows the token once with `Copy token` and an MCP config snippet containing `"url": "<origin>/v1/mcp"` and `"Authorization": "Bearer ovs_pat_…"`; after closing, the secret is gone from the DOM; list shows name, prefix, created, expires, last used (`Never` when null); Revoke asks for confirmation then DELETEs; 409 at the limit shows `You have 10 active tokens. Revoke one to create another.`; axe passes.
- [ ] **Step 2:** `cd web && npx vitest run src/features/settings/AccessTokensPage.test.tsx` — FAIL. **Step 3:** Implement. **Step 4:** `npm test`, `npm run typecheck`, `npm run lint` — PASS.
- [ ] **Step 5:** Commit `feat(web): access tokens page`.

### Task 3: MCP server

**Files:**
- Modify: `api/internal/httpapi/oapi-config.yaml` (add `embedded-spec: true`), `gen.go` (regenerated), `api/internal/httpapi/server.go` (mount `/v1/mcp` inside `secured`, before the generated router)
- Create: `api/internal/mcp/catalog.go`, `catalog_test.go`, `server.go`, `server_test.go`, `dispatch.go`, `importcsv.go`, `importcsv_test.go`; `docs/mcp.md`

**Interfaces:**
- Produces:
  - `mcp.Tool{Name, Description string; InputSchema map[string]any; Annotations map[string]any; Method, PathTemplate string; PathParams, QueryParams []string; HasBody bool}`
  - `mcp.BuildCatalog(spec *openapi3.T, exclude func(opID string) bool) ([]Tool, error)` — name = snake_case(operationId)
  - `mcp.Dispatcher interface{ Call(ctx context.Context, t Tool, args map[string]any) (status int, body []byte, err error) }`; `mcp.NewHTTPDispatcher(h http.Handler, channel string) Dispatcher` (builds a request to `/v1` + path with the caller's principal in the context and `Principal.Channel = channel`, records the response)
  - `mcp.NewHandler(tools []Tool, d Dispatcher, extra []ExtraTool) http.Handler`
  - `mcp.ResultLimit = 512 << 10`
  - `mcp.ReadOnly(t Tool) bool` (Method == GET) — Task 5 uses it

- [ ] **Step 1: Failing tests.** `catalog_test.go`: every operationId except excluded ones yields one tool; `getScorecardView` → `get_scorecard_view` with path params required, query params optional, `$ref`s resolved; GET has `readOnlyHint: true`, DELETE `destructiveHint: true`; token ops and `/mcp` excluded. `server_test.go` (JSON-RPC over httptest with an authenticated principal): `initialize` returns `serverInfo.name == "opsvision"` and `capabilities.tools`; `tools/list` count equals catalog + extras; `tools/call get_scorecard_view` returns the same JSON as GET `/v1/...`; a 403 from the API becomes `isError: true` with the error message; a write via MCP is audited with channel `mcp`; a result over `ResultLimit` is truncated with text `Result truncated at 512 KB; narrow the request (fewer periods or a smaller scope).`; unknown method → JSON-RPC error -32601; `GET /v1/mcp` → 405; unauthenticated → 401. `importcsv_test.go`: dry run returns the import preview; CSV over 700 KB → `isError` with the limit.
- [ ] **Step 2:** `cd api && go test ./internal/mcp/...` — FAIL.
- [ ] **Step 3:** Implement. JSON-RPC 2.0, batch not supported (return -32600). Protocol version: echo the client's if supported, else the server's latest. `import_records_csv {recordType, csv, period?, dryRun?}` drives the existing presign/upload/import operations through the dispatcher and the objects store.
- [ ] **Step 4:** `cd api && go test ./...`, `make gen-check` — PASS. Write `docs/mcp.md` (Claude Desktop and Cursor config, auth header, tool naming, limits, examples).
- [ ] **Step 5:** Commit `feat(api): MCP server exposing every API operation`.

### Task 4: Assistant credentials, settings, provider client

**Files:**
- Modify: `openapi/openapi.yaml` (ops `getMyAssistantCredential`/`putMyAssistantCredential`/`deleteMyAssistantCredential` on `/me/assistant/credential`; `getAssistantSettings`/`putAssistantSettings` on `/assistant/settings`; schemas `AssistantCredentialStatus{configured, last4?, updatedAt?}`, `PutAssistantCredentialRequest{apiKey}`, `AssistantSettings{enabled, model}`), gen files, store files + contract
- Create: `api/internal/assistant/seal.go` (+ `seal_test.go`), `api/internal/assistant/provider.go` (+ `provider_test.go`), `api/internal/httpapi/assistant_settings.go` (+ test)
- Modify: `api/cmd/api/main.go` (env `OPSVISION_CREDENTIAL_KEY`, `OPSVISION_CREDENTIAL_KMS_KEY_ID`, `OPSVISION_ASSISTANT_BASE_URL`; documented in the package comment and `docs/deploy/environment.md`), `api/go.mod`/`go.sum` (`service/kms` v1.62.6)

**Interfaces:**
- Produces:
  - `assistant.Sealer interface{ Seal(ctx, plaintext []byte, ec map[string]string) ([]byte, error); Open(ctx, sealed []byte, ec map[string]string) ([]byte, error) }`; `assistant.NewAESSealer(key []byte) (Sealer, error)`; `assistant.NewKMSSealer(client KMSAPI, keyID string) Sealer`
  - `assistant.Provider interface{ Messages(ctx, apiKey string, req MessagesRequest) (MessagesResponse, error) }`; `assistant.NewHTTPProvider(baseURL string, hc *http.Client) Provider`; types `MessagesRequest{Model string; System string; Messages []Message; Tools []ToolDef; MaxTokens int}`, `MessagesResponse{Content []Block; StopReason string; Usage Usage}`, `Block{Type, Text, ID, Name string; Input json.RawMessage; ToolUseID string; Content string; IsError bool}`
  - `assistant.ErrBadKey`, `assistant.ErrRateLimited`, `assistant.ErrUnavailable`
  - `store.AssistantStore`: `PutCredential/GetCredential/DeleteCredential(tenantID, userID)` with `domain.AssistantCredential{Sealed []byte; Last4 string; UpdatedAt time.Time}`; `GetAssistantSettings/PutAssistantSettings(tenantID)` with `domain.AssistantSettings{Enabled bool; Model string}` (default `{true, "claude-haiku-5-5"}` when absent)

- [ ] **Step 1: Failing tests.** Seal round trip; wrong encryption context fails to open; AES sealer rejects keys ≠ 32 bytes. Provider against httptest: request headers and body shape; 401 → `ErrBadKey`; 429 → `ErrRateLimited`; 5xx/timeout → `ErrUnavailable`. Handlers: PUT validates with one provider call using the tenant model and `max_tokens: 1` then stores sealed (store holds no plaintext: assert the stored bytes do not contain the key); bad key → 400 `That key was rejected by the provider.`; GET returns `last4` only; DELETE; settings GET by any member, PUT admin-only and audited; missing sealer config → credential PUT 503 `assistant_unavailable`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (vet any `go get` bumps per Global Constraints). **Step 4:** `cd api && go test ./...`, `make gen-check` — PASS.
- [ ] **Step 5:** Commit `feat(api): assistant credentials and settings`.

### Task 5: Threads, turns, worker, tools, help topics

**Files:**
- Modify: `openapi/openapi.yaml` (ops `createAssistantThread` POST `/assistant/threads`, `listAssistantThreads` GET, `getAssistantThread` GET `/assistant/threads/{id}`, `deleteAssistantThread` DELETE, `postAssistantMessage` POST `/assistant/threads/{id}/messages` → 202; schemas `AssistantContext{scorecardId?, period?, scope?, metricKey?, page}`, `AssistantThread{id, title, createdAt, updatedAt, context?, messages[]}`, `AssistantMessage{id, role: user|assistant, text, status: done|pending|error, error?, createdAt, usage?{model, inputTokens, outputTokens, toolCalls}}`), gen files, store + contract, `api/cmd/api/main.go` (event source `sqs`; env `OPSVISION_ASSISTANT_QUEUE_URL`), `api/go.mod` (`service/sqs` v1.53.0)
- Create: `api/internal/assistant/runner.go` (+ test), `queue.go` (+ test), `prompt.go`, `tools.go` (+ test), `api/internal/help/help.go` (+ test), `api/internal/help/topics/*.md`, `api/internal/httpapi/assistant_threads.go` (+ test)

**Interfaces:**
- Consumes: Task 3 `mcp.BuildCatalog`, `mcp.NewHTTPDispatcher`, `mcp.ReadOnly`, `mcp.ResultLimit`; Task 4 `Sealer`, `Provider`, `AssistantStore`.
- Produces:
  - `assistant.Queue interface{ Enqueue(ctx, TurnRef) error }`, `TurnRef{TenantID, UserID, ThreadID, MessageID string}`; `NewInProcessQueue(run func(context.Context, TurnRef))`; `NewSQSQueue(client SQSAPI, url string)`
  - `assistant.Runner{...}.Run(ctx, TurnRef) error` — loads thread, opens the key, builds system prompt (`prompt.go`, constant `PromptVersion = "sam-v1"`) with context, calls the provider with tools, executes tool_use blocks via the dispatcher (channel `assistant`) or help, loops ≤ 8 rounds within 90 s, writes the final assistant message (done or error with a user-facing reason).
  - `assistant.ToolSet(catalog []mcp.Tool) []mcp.Tool` — GET only, excluding operations whose path starts with `/members`, `/me/tokens`, `/me/assistant`, `/audit`, `/operator`
  - `help.Search(query string) []Topic`, `help.Get(id string) (Topic, bool)`; `Topic{ID, Title, Body string}`; topics embedded with `//go:embed topics/*.md`
  - `assistant.StalePending = 3 * time.Minute`

- [ ] **Step 1: Failing tests.** Threads: create/list/get/delete private to the user (another user → 404); post message → 202 with a pending assistant message; second post while pending → 409; 51st thread deletes the oldest; a pending message older than `StalePending` reads as `status: error`, `error: "SAM took too long. Try again."`. Runner with a fake provider: tool_use `get_scorecard_view` executes as the user and its result is passed back; a tool_use for a non-allowlisted tool (e.g. `delete_org_unit`) returns an error tool_result and nothing is written (assert store unchanged); provider `ErrBadKey` → message error `Your Claude key was rejected. Update it in My settings → Ask SAM.`; 9th round stops with a note; usage recorded; tool results truncated at `ResultLimit`. Help: `Search("commitment")` finds the commitments-and-slips topic; every topic file parses with front matter `id` and `title`, and `id` matches the file name. Queue: in-process runs the turn; SQS body is JSON TurnRef. `main_test.go`: `OPSVISION_EVENT_SOURCE=sqs` builds a worker handler.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Help topics (plain, short, no company names): statuses-and-bands, live-and-locked-periods, restatement, commitments-and-slips (a slip dings the committed month, then the commitment resets to the new date and can be delivered or missed against it), derived-measures, imports-and-dedupe, report-publishing, scope-and-filters, worst-of-n, metric-kinds, asking-sam.
- [ ] **Step 4:** `cd api && go test ./...`, `make gen-check` — PASS.
- [ ] **Step 5:** Commit `feat(api): Ask SAM threads, turns, and tools`.

### Task 6: Report summary draft

**Files:**
- Modify: `openapi/openapi.yaml` (ops `draftReportSummary` POST `/scorecards/{sc}/reports/{period}/summary/draft` → 202 `{id}`; `getReportSummaryDraft` GET `.../summary/draft/{id}` → `{pending, text?, error?}`), gen files
- Create: `api/internal/assistant/draft.go` (+ test), `api/internal/httpapi/report_draft.go` (+ test)

**Interfaces:**
- Consumes: Task 5 Runner, Queue, store; produces `assistant.DraftPromptVersion = "sam-summary-v1"`.

- [ ] **Step 1: Failing tests.** Admin-only (viewer 403); 202 then poll returns text from a fake provider; the stored report summary is unchanged after a draft; non-company scope is not accepted (draft always company scope); no credential → 409 `Add your Claude API key in My settings → Ask SAM to draft with SAM.`
- [ ] **Step 2:** FAIL. **Step 3:** Implement (draft prompt gets the report document's facts, needs-attention, per-category values; asks for 3–6 sentences, plain, no invented numbers). **Step 4:** PASS. **Step 5:** Commit `feat(api): draft the report summary with SAM`.

### Task 7: Ask SAM in the web app

**Files:**
- Create: `web/src/features/assistant/AskSamDrawer.tsx` (+ test), `AssistantMessage.tsx` (+ test), `web/src/features/assistant/useAssistant.ts`, `web/src/features/settings/AskSamSettingsPage.tsx` (+ test), `web/src/features/admin/AssistantAdminPage.tsx` (+ test)
- Modify: `web/src/features/scorecard/ControlBar.tsx`, `FocusDialog.tsx` (enable Ask SAM, pass context), `web/src/shell/AppShell.tsx` (nav entry; drawer host), `web/src/features/scorecard/ReportPage.tsx` (Draft with SAM), `web/src/App.tsx` (routes `settings/ask-sam`, `admin/assistant`), `web/src/api/queries.ts`

**Interfaces:**
- Consumes: Tasks 4–6 operations.
- Produces: `useAskSam(): { open(context: AssistantContext): void }` from a provider in `AppShell`.

- [ ] **Step 0: Markdown.** Call the dependency-vetting MCP `getRecommendedComponentVersions` for `pkg:npm/react-markdown`. If a recommended version is policy compliant, install it exact (`--save-exact`) and use it with raw HTML disabled; record the result in the task report. Otherwise implement a small renderer (paragraphs, lists, bold, inline code, code blocks, links) in `AssistantMessage.tsx`.
- [ ] **Step 1: Failing tests.** Ask SAM buttons are enabled with name `Ask SAM` and open the drawer with a context chip (`Sep 2026 · Unit A · <metric>`); starters render from context; sending posts `{text, context}`, shows a pending bubble, polls until done, announces the reply in a polite live region; Enter sends, Shift+Enter newline; a second send while pending is disabled; error message renders with retry; no credential → setup card linking to `/settings/ask-sam` with the privacy line `Your questions and the data SAM reads are sent to the model provider using your key.`; thread switcher lists recent threads and New chat; links in replies open with `rel="noopener noreferrer"`; settings page saves/replaces/removes the key showing `•••• <last4>` and the model in use; admin page sets enabled/model with the two offered ids and free text; Report: admin `Draft with SAM` fills the textarea with the draft and the label `Draft from SAM — review before saving`, nothing PUT until Save; axe passes for drawer and pages.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Drawer: Radix Dialog, non-modal at ≥ 1024 px (right sheet, page usable), modal full-screen below; owl from `web/src/ui/Sam.tsx`. **Step 4:** `npm test`, `npm run typecheck`, `npm run lint` — PASS.
- [ ] **Step 5:** Commit `feat(web): Ask SAM assistant`.

### Task 8: Infra and deploy (private deploy repo `~/Documents/apps/opsvision-sam-deploy`)

**Files (deploy repo):** `infra/modules/api/main.tf` (worker function from the same zip, `OPSVISION_EVENT_SOURCE=sqs`, timeout 120, reserved concurrency 5; event source mapping batch size 1; API env `OPSVISION_ASSISTANT_QUEUE_URL`, `OPSVISION_CREDENTIAL_KMS_KEY_ID`), new `infra/modules/queue` (SQS + DLQ, KMS-encrypted, maxReceiveCount 2), IAM (API `sqs:SendMessage`; worker receive/delete/get attributes; both `kms:Encrypt`/`kms:Decrypt` on the app key with condition `kms:EncryptionContext:purpose = assistant-credential`), `infra/envs/dev`, CI role policy/boundary updates, `scripts/simulate-ci-roles.sh` new checks, `docs/runbook.md`.

- [ ] **Step 1:** Public repo: push `feat/phase1-foundation` after syncing; note SHA.
- [ ] **Step 2:** Deploy repo branch: pin `opsvision.ref`, infra changes; `terraform fmt -check`, `terraform validate`; `scripts/simulate-ci-roles.sh` all pass.
- [ ] **Step 3:** PR; plan shows only the queue, DLQ, worker, mapping, IAM, env changes and the API Lambda update. Merge; deploy green.
- [ ] **Step 4:** Browser verification on dev: create a token; MCP `initialize` + `tools/list` via curl with the token; save a Claude key; ask SAM a methodology question and a data question on Overview; Draft with SAM on Report. Jira comment on OPVSAM-1.
