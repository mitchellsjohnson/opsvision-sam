# API tokens, MCP server, and Ask SAM — design

Date: 2026-11-14. Status: awaiting maintainer review of the plan (maintainer opted to skip the question round; calls marked *builder's call* are the agent's and can be revisited).

## Intent

Program managers and leads should be able to (1) do everything the web app does from an MCP client (Claude Desktop, Cursor, any MCP-capable agent) or a script, and (2) ask SAM, the owl guide, questions inside the app: how a metric or the methodology works, why a number moved, what to look at this month, and have SAM draft the monthly report summary. Each person uses their own Claude credential; a lower-cost model is the default and an admin can change it.

Success: a PM opens the Overview, clicks Ask SAM, asks "why did epics on time go red in September?", and gets a grounded answer that cites the actual values, status bands, and commitment rule. An admin clicks "Draft with SAM" on the Report and gets a usable first draft of the summary. A power user points Claude Desktop at the MCP endpoint and can read any view, import records, and publish a report.

## Goals

- Personal access tokens usable as Bearer credentials on the whole `/v1` API.
- An MCP server at `/v1/mcp` exposing every API operation as a tool, with identical authorization, validation, and audit.
- Ask SAM: an in-app assistant drawer, per-user Claude credential, admin-selected model, read-only tools over the same catalog plus methodology help, persisted private threads.
- AI-drafted monthly report summary (admin), never saved without a human click.

## Non-goals

- SAM never writes data. It can propose; people act through the normal UI.
- No shared/tenant-paid Claude key, no budgets or billing (each user pays through their own key). *Builder's call:* a per-turn cap on tool rounds and output tokens instead.
- No streaming responses (the ALB + Lambda path does not stream); turns are polled.
- No OAuth flow for MCP clients in this phase; tokens are pasted into client config.
- No other model providers.

## Anti-goals (failure even if it works)

- A credential or token ever reaching the browser after it is saved, a log line, an audit record, or the model.
- SAM answering from guesses when the data is one tool call away; inventing numbers.
- SAM or MCP seeing data the user could not see in the UI.
- MCP behavior drifting from the API (two implementations of the same rule).

## Constraints

- Public repo: no first-adopter company/product names anywhere (code, tests, fixtures, help text). Infra specifics live in the private deploy repo.
- Existing stack only: Go API (single binary, Lambda behind an internal ALB, 1 MB response limit, 30 s API timeout), DynamoDB single table, React web. Any new library goes through the maintainer's dependency-vetting service before it is added; prefer the standard library (*builder's call:* hand-written MCP JSON-RPC, no MCP SDK).
- OpenAPI first; `make gen` and `make gen-check` as today. Writes that are audited today stay audited; MCP-originated writes record channel `mcp`, token API writes channel `token`.
- CSP stays as is: the browser never talks to the model provider.

## Part 1 — Personal access tokens

- `POST /v1/me/tokens {name, expiresInDays}` (1–365, default 90) returns `{id, name, token, prefix, createdAt, expiresAt}` once. Token format `ovs_pat_` + 32 random bytes base64url. Stored as SHA-256 hash with `prefix` (first 12 chars) for display. `GET /v1/me/tokens` lists (no secret), `DELETE /v1/me/tokens/{id}` revokes. Max 10 active per user.
- The auth middleware accepts `Authorization: Bearer ovs_pat_...` on all `/v1` routes in addition to the existing identity-provider token. A token resolves to its user and tenant; the user's current role and membership apply at each request (role changes and removal take effect immediately). `lastUsedAt` updated at most once per minute.
- Token creation and revocation are audited (never the secret).
- Web: My settings gets an "Access tokens" page: create (shows the token once with a copy button and the MCP config snippet), list with prefix/created/expires/last used, revoke with confirmation.

## Part 2 — MCP server

- `POST /v1/mcp`, MCP Streamable HTTP transport with JSON responses only (no SSE; `GET /v1/mcp` returns 405). Methods: `initialize` (server name `opsvision`, protocol version negotiated per spec, capability `tools`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Sessions are stateless (no `Mcp-Session-Id` required). Auth: Bearer access token (or the browser identity token).
- Tool catalog is generated at startup from the embedded OpenAPI document: one tool per `operationId`, name in snake_case (`getScorecardView` → `get_scorecard_view`), description from summary + description, `inputSchema` an object merging path params, query params, and (as `body`) the request body schema with `$ref`s resolved. Annotations: `readOnlyHint` for GET, `destructiveHint` for DELETE, `idempotentHint` for PUT. Excluded: `/v1/mcp` itself, token and assistant-credential operations, and raw binary endpoints.
- `tools/call` dispatches an in-process HTTP request through the same router with the caller's identity, so routing, authz, validation, and audit are shared. Result: the JSON body as text content plus `structuredContent`; HTTP 4xx/5xx become `isError: true` results carrying the problem detail. Results over 512 KB are truncated with a clear note telling the model to narrow the request.
- MCP-only convenience tool `import_records_csv {recordType, csv, period?, dryRun}` (CSV text up to 700 KB) that performs the presign → upload → import steps server-side, so record imports work from MCP clients.
- Docs: `docs/mcp.md` with setup for Claude Desktop and Cursor (URL, header), tool naming, examples, limits.

## Part 3 — Ask SAM backend

### Credentials and settings

- `PUT /v1/me/assistant/credential {apiKey}`: validated with one minimal request to the provider using the tenant's configured model; on success encrypted and stored; returns `{configured: true, last4, updatedAt}`. `GET` returns the same shape (`configured: false` when none), `DELETE` removes it. The key is never returned.
- Encryption: AWS KMS `Encrypt`/`Decrypt` with encryption context `{tenant, user, purpose: "assistant-credential"}` in AWS; locally and in tests an AES-256-GCM key from `OPSVISION_CREDENTIAL_KEY` (base64, 32 bytes). If neither is configured the assistant reports itself unavailable (no plaintext fallback).
- Tenant settings (admin, audited): `GET/PUT /v1/assistant/settings {enabled, model}`. Defaults `enabled: true`, `model: "claude-haiku-5-5"` (the lower-cost tier). The admin page offers `claude-haiku-5-5` (default, lower cost) and `claude-sonnet-5-5` (stronger, higher cost) and accepts any model id string. `GET` is readable by all members so the UI can show which model answers.

### Threads and turns

- `POST /v1/assistant/threads {context?}` creates a private thread; `GET /v1/assistant/threads` lists the caller's threads (newest first, 50 kept per user; older are deleted); `GET /v1/assistant/threads/{id}`; `DELETE /v1/assistant/threads/{id}`.
- `POST /v1/assistant/threads/{id}/messages {text, context}` stores the user message and a pending assistant message, enqueues the turn, and returns 202 with the thread. The client polls `GET /v1/assistant/threads/{id}` every 1.5 s while a message is pending. One pending turn per thread.
- Context: `{scorecardId?, period?, scope?, metricKey?, page: overview|table|report|focus|other}` from the page; included in the system prompt as "what the user is looking at".
- Worker: the same binary handles queue events (`OPSVISION_EVENT_SOURCE=sqs`), 90 s turn budget, up to 8 tool rounds, max 2,000 output tokens per model call. Locally the queue is in-process (a goroutine) so `make dev` works with no AWS. On failure the pending message becomes an error message the UI shows ("SAM couldn't finish: <reason>"); provider auth failures say to update the key.
- Each turn records `{model, inputTokens, outputTokens, toolCalls}` on the assistant message; the UI shows it quietly.

### Tools and grounding

- SAM's tools are the read-only (GET) subset of the MCP catalog minus member lists, tokens, credentials, and audit, executed as the user through the same in-process dispatch. Plus help tools: `search_help {query}` and `get_help_topic {id}` over markdown topics embedded in the binary (`api/internal/help/topics/*.md`): statuses and bands, live vs locked periods, restatement, commitment rule (a slip dings the committed month, then resets to the new date), derived measures, imports and dedupe, report publishing, scope and filters, worst-of-N, and each metric kind. Metric definitions come from the methodology versions via tools.
- System prompt (versioned in code): SAM is the OpsVision guide; answer from tool results and help topics; always cite values with period and scope; say when data is missing or not reported; never invent numbers; never claim to have changed anything; keep answers short with a "what to look at next" line when useful.

### Report summary draft

- `POST /v1/scorecards/{sc}/reports/{period}/summary/draft` (admin) runs a turn with a dedicated prompt over the report document (same scope rules: company scope only) and returns 202 with a draft id; `GET .../summary/draft/{id}` polls for `{pending, text?, error?}`. The draft is not stored as the summary.

## Part 4 — Ask SAM web

- The disabled "Ask SAM (coming soon)" controls in the scorecard control bar and the full-screen chart dialog become active, plus an Ask SAM entry in the left nav. They open a right-side drawer (non-modal on wide screens so the page stays usable; full-screen sheet on mobile) with the owl, the current context chip ("Sep 2026 · Smart Repo · Epics delivered on time"), a thread switcher (New chat, recent threads), the conversation, and a composer.
- Suggested starters from context, e.g. "Why is <metric> <status> this month?", "How is <metric> measured?", "What needs attention in <scope>?", "Summarize this month".
- Messages render markdown safely (no raw HTML, links open in a new tab with `rel="noopener noreferrer"`); value citations render as plain text. *Builder's call:* use a markdown renderer only if it passes the maintainer's dependency-vetting service; otherwise a small in-house renderer for paragraphs, lists, bold, code, and links.
- No credential: the drawer shows a setup card ("Add your Claude API key to use SAM") linking to My settings → Ask SAM, with a privacy line: questions and the data SAM reads are sent to the model provider under your key.
- My settings → Ask SAM: key field (password type), Save/Replace/Remove, last 4, the model in use. Admin settings → Ask SAM: enable, model.
- Report page: admins get "Draft with SAM" next to the summary editor; the draft fills the textarea marked "Draft from SAM — review before saving"; nothing is saved until Save.
- Accessibility: drawer is a labelled region/dialog with focus management, live region announces new SAM messages, keyboard send (Enter, Shift+Enter newline).

## Infra (private deploy repo)

SQS queue + DLQ (KMS-encrypted), a worker Lambda from the same zip (`OPSVISION_EVENT_SOURCE=sqs`, timeout 120 s, reserved concurrency small), event source mapping, IAM: API may `sqs:SendMessage`; worker may receive/delete; both may `kms:Encrypt`/`kms:Decrypt` on the app key without the `ViaService` condition but with an encryption-context condition `purpose = assistant-credential`. Update the CI role policy, boundary, and `simulate-ci-roles.sh` checks; the plan must show only these additions.

## Order of work

1. Tokens (API + web page). 2. MCP server + `import_records_csv` + docs. 3. Assistant credentials and settings. 4. Threads, worker, tools, help topics. 5. Web drawer and settings pages. 6. Report summary draft. 7. Infra in the deploy repo, then deploy and browser-verify.

## Left to the builder

Exact table key shapes, file layout inside `api/internal`, help topic wording (no company names), drawer visual details within the existing tokens, and test fixture design.
