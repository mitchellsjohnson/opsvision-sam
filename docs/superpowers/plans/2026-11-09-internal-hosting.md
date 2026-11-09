# Internal Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API Lambda runs behind an internal load balancer, serves the web app from the same origin with runtime configuration, signs employees in through a single-organization mode, and ships as one deployment zip; plus a CLI that loads a bootstrap file and workbook into the deployment's table.

**Architecture:** `cmd/api` gains an event-source switch (ALB or API Gateway) and an optional embedded web app (`internal/webui`). `internal/auth` gains a single-organization mode (trusted subject prefixes, fixed tenant, `/userinfo` email, bootstrap admins). A new `cmd/opsvision-admin` reuses `internal/bootstrap` and `internal/importer` against DynamoDB. The web app reads `/config.json` at startup in production builds.

**Tech Stack:** Existing only: Go 1.27, `github.com/aws/aws-lambda-go v1.55.1` (`events.ALBTargetGroupRequest`), AWS SDK v2, `embed`; React 19 web app. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-internal-hosting-design.md` (extends `2026-10-30-opsvision-design.md`).

**Placement:** Replaces phase 1 Tasks 27–29 for the first adopter's deployment. Infrastructure and deploy workflows live in the private deployment repository, with its own plan.

## Global Constraints

- No first-adopter names, domains, account IDs, or identity-provider client IDs anywhere in this repository. Use example values (`example.us.auth0.com`, `ops.example.test`) in tests and docs.
- Write all code fresh. Nothing is copied from other organizations' private repositories.
- No new dependencies.
- Dev authentication and `/dev/*` routes never exist in `cmd/api`. `cmd/api` refuses to start unless `OPSVISION_AUTH_MODE=auth0` (unchanged).
- Tenant isolation is unchanged: in single-organization mode the tenant comes only from configuration, never from the request.
- Responses through the load balancer stay within 1 MB. Compress when the client accepts gzip. Otherwise return 502 problem JSON with code `response_too_large`.

## Review Focus

1. **A token from an untrusted connection** (wrong `sub` prefix) in single-organization mode: 403, with no membership created. Test in H3 (`TestSingleOrgUntrustedSubForbidden`).
2. **Deep links to app pages** (`/scorecards/x?tab=table`) through the load balancer: they serve `index.html`, not 404. A missing asset (`/assets/missing.js`) is 404, not `index.html`. Tests in H2 (`TestSPAFallback`, `TestMissingAssetIs404`).
3. **Binary bodies:** an `.xlsx` upload proxied through the API and a gzip response both survive the base64 round trip. Test in H1 (`TestALBBinaryRoundTrip`).
4. **`/userinfo` outages or slowness:** sign-in fails closed with 503 and doesn't hang. The fetch has a 5 s timeout. A cached email is reused until the token expires. Test in H3 (`TestUserInfoTimeoutFailsClosed`).
5. **A bootstrap file loaded twice:** it is idempotent, or refuses clearly. It never duplicates units or versions. Test in H4 (`TestBootstrapTwice`).

---

### Task H1: Load balancer adapter and event-source switch

**Files:**
- Create: `api/internal/lambdahttp/alb.go`, `api/internal/lambdahttp/alb_test.go`
- Modify: `api/cmd/api/main.go` (`OPSVISION_EVENT_SOURCE`), `api/cmd/api/main_test.go`, `api/Makefile` (unchanged target name)

**Interfaces:**
- Produces: `func ALBHandler(h http.Handler) func(context.Context, events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error)`.
  - Requests: multi-value headers and query (the target group enables multi-value headers); a base64 request body when `IsBase64Encoded`.
  - Responses: multi-value headers. The body is base64 when it isn't text (text means `text/*`, JSON, JavaScript, SVG, and `Content-Encoding` absent).
  - Responses over 1,000,000 bytes after encoding become 502 problem JSON `{"code":"response_too_large"}`.
- `cmd/api` reads `OPSVISION_EVENT_SOURCE`: `apigateway` (default, unchanged) or `alb`; anything else refuses to start.
- `GET /healthz` returns `200 {"status":"ok"}` without auth. Add it to the router outside `/v1`, and test it.

- [ ] **Step 1: Write failing tests:**
  - `TestALBRoundTrip`: GET `/v1/scorecards?periods=2026-M10&periods=2026-M09`, JSON POST, headers preserved.
  - `TestALBBinaryRoundTrip`: base64 xlsx request body, gzip response base64-encoded.
  - `TestALBTooLarge`: 502 `response_too_large`.
  - `TestEventSourceConfig`: `alb`, `apigateway`, and default are accepted; `foo` refuses.
  - `TestHealthz`.
- [ ] **Step 2:** `cd api && go test ./internal/lambdahttp/ ./cmd/api/` FAIL. **Step 3:** Implement. **Step 4:** PASS; `go test ./...`.
- [ ] **Step 5: Commit** `feat(api): load balancer events and health check`.

### Task H2: Embedded web app and runtime configuration

**Files:**
- Create: `api/internal/webui/{webui.go,webui_test.go,dist/index.html}` (the committed placeholder `dist/index.html` says "The web app isn't built into this binary"; the build copies `web/dist` over it), `web/src/runtimeConfig.ts`, `web/src/runtimeConfig.test.ts`
- Modify: `api/cmd/api/main.go` (`OPSVISION_SERVE_WEB=1` mounts the web app), `web/src/config.ts`, `web/src/main.tsx` (load config before render), root `Makefile` (`package` target), `.gitignore` (ignore the copied `api/internal/webui/dist/*` except the placeholder)

**Interfaces:**
- Produces:
  - `type webui.Config struct{ AuthMode, Auth0Domain, Auth0ClientID, Auth0Audience, Organization string; UploadsOrigin string }`. Its JSON form is `/config.json` (`authMode`, `auth0Domain`, `auth0ClientId`, `auth0Audience`, `organization` omitted when empty, `apiUrl: ""`).
  - `func webui.Handler(files fs.FS, cfg Config) http.Handler`:
    - GET and HEAD only.
    - `/config.json` is served with no-cache.
    - Files under `assets/` get `Cache-Control: public, max-age=31536000, immutable`.
    - `index.html` gets no-cache.
    - A path whose last segment has no `.` falls back to `index.html`.
    - A missing path with an extension is 404.
    - Every response sets HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and the CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://<Auth0Domain> <UploadsOrigin>; frame-src https://<Auth0Domain>; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://<Auth0Domain>`.
  - `func webui.Files() fs.FS` returns the embedded `dist`.
- `cmd/api` with `OPSVISION_SERVE_WEB=1`:
  - Routing: `/v1/` and `/healthz` go to the API; everything else goes to `webui`.
  - CORS: none for the same origin, so `ALLOWED_ORIGIN` becomes optional.
  - New env vars: `OPSVISION_WEB_AUTH0_CLIENT_ID` (required when serving the web app) and `OPSVISION_UPLOADS_ORIGIN` (default `https://<UPLOADS_BUCKET>.s3.<AWS_REGION>.amazonaws.com`).
- Web:
  - A production build first fetches `/config.json`. On success it uses those values and `apiUrl` is the same origin. On 404 it falls back to the build env (existing behavior). Dev builds are unchanged.
  - `AuthProvider` passes `organization` only when one is configured.
- `make package` runs, in order: `npm --prefix web ci && npm --prefix web run build`, copy `web/dist/*` into `api/internal/webui/dist/`, `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -o build/bootstrap ./cmd/api`, then zip to `build/opsvision-api-lambda.zip`.

- [ ] **Step 1: Write failing tests:**
  - Go: `TestSPAFallback`, `TestMissingAssetIs404`, `TestAssetCaching`, `TestConfigJSON` (organization omitted when empty), `TestSecurityHeaders` (exact CSP for the example config), `TestServeWebRouting` (`/v1/me` hits the API, `/` hits the web app, `/healthz`).
  - Web: `runtimeConfig.test.ts` covers config.json used, 404 falling back to env, and network error falling back to env.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Go and web suites PASS; `make package` produces the zip, and `unzip -l` lists `bootstrap`.
- [ ] **Step 5: Commit** `feat: serve the web app from the API Lambda with runtime config`.

### Task H3: Single-organization sign-in mode

**Files:**
- Create: `api/internal/auth/{singleorg.go,singleorg_test.go,userinfo.go,userinfo_test.go}`
- Modify: `api/internal/auth/middleware.go`, `api/internal/auth/jwt.go` (as needed), `api/cmd/api/main.go`, `api/cmd/api/main_test.go`

**Interfaces:**
- Produces:
  - `auth.Config` gains `SingleTenantID string`, `TrustedSubPrefixes []string`, `BootstrapAdmins []string` (lowercased emails), and `UserInfoURL string` (default `https://<Domain>/userinfo`).
  - `func NewUserInfo(url string, client *http.Client) *UserInfo` and `func (u *UserInfo) Email(ctx context.Context, token string) (email string, verified bool, err error)`, with a 5 s timeout and a 64 KiB response limit.
- Rules when `SingleTenantID != ""`:
  - The token must be valid for the audience, as today.
  - `sub` must start with a trusted prefix, else 403 `forbidden`. An empty prefix list refuses to start.
  - The tenant is `SingleTenantID`; `org_id` is ignored. A missing tenant record is 403 `tenant not provisioned`.
  - Email comes from the namespaced claim if present. Otherwise it comes from `/userinfo`, cached by `sub` until the token's `exp`, with at most 1,000 entries evicted oldest first.
  - `/userinfo` failure is 503 `identity_unavailable`, and no membership is created.
  - Provisioning on first sign-in follows the internal hosting spec §3. Bootstrap-admin membership is written once and never re-elevates a later demotion.
- `cmd/api` env:
  - `OPSVISION_TENANT_ID` enables the mode.
  - `OPSVISION_TRUSTED_SUB_PREFIXES` and `OPSVISION_BOOTSTRAP_ADMINS` are comma-separated.
  - `OPSVISION_USERINFO_URL` is optional.

- [ ] **Step 1: Write failing tests:**
  - `TestSingleOrgTrustedMember`: an existing member keeps their role.
  - `TestSingleOrgUntrustedSubForbidden`: no membership is created.
  - `TestSingleOrgBootstrapAdmin`: an admin is created on first sign-in; after demotion to viewer, they stay a viewer.
  - `TestSingleOrgPendingInviteBinds`.
  - `TestSingleOrgDefaultRole`.
  - `TestSingleOrgIgnoresOrgID`: a token whose `org_id` names another tenant still resolves to the configured one.
  - `TestUserInfoCachedUntilExp`.
  - `TestUserInfoTimeoutFailsClosed`.
  - `TestSingleOrgConfigRequiresPrefixes`.
  - Existing multi-tenant tests stay green.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `go test ./...`.
- [ ] **Step 5: Commit** `feat(auth): single-organization sign-in mode`.

### Task H4: Admin CLI for bootstrap and import

**Files:**
- Create: `api/cmd/opsvision-admin/{main.go,main_test.go}`, `docs/deploy/loading-data.md`
- Modify: `api/internal/bootstrap/bootstrap.go` (only if needed for idempotence)

**Interfaces:**
- Produces:
  - `opsvision-admin bootstrap -table T -file bootstrap.json [-dry-run]`. It loads into DynamoDB through `dynamostore` with the default AWS credential chain, and prints counts.
  - `opsvision-admin import -table T -tenant ID -bucket B -workbook x.xlsx -template ID [-dry-run]`. It parses with the stored template and prints counts and findings, as `importcheck` does. Without `-dry-run` it applies the import as a change set with channel `import` and actor `cli:<user>`.
  - Core functions take `store.Store` and `objects.Store`, so tests use memstore.
  - Bootstrap is idempotent: puts upsert, and versions use their existing revisions. A second run reports `unchanged` counts.
- `docs/deploy/loading-data.md`: a generic how-to with example names only.

- [ ] **Step 1: Write failing tests:**
  - `TestBootstrapLoadsTenant`.
  - `TestBootstrapTwice`: no duplicates, the second run reports unchanged.
  - `TestImportDryRunWritesNothing`.
  - `TestImportApplies`: uses the synthetic fixtures in `api/internal/bootstrap/testdata` and `api/internal/legacy/testdata`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `go test ./...`.
- [ ] **Step 5: Commit** `feat(cmd): opsvision-admin bootstrap and import`.
