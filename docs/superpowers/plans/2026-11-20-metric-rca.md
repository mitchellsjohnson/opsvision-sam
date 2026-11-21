# Metric RCAs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribution on every cell that is not perfect (incidents to the minute, contributing records, the unexplained rest), one **required exec summary per metric per month** at company scope written by an admin with up to 25 links, a **publish gate** that blocks a month until every required summary exists, an Exec summaries view that lists what is missing, and summaries carried into published reports and the PPTX/PDF downloads — inside the platform's time and size limits.

**Architecture:** The maintainer's 2026-11-21 decisions change landed work, so the plan has **rework tasks** (marked ′) for the three landed commits that are affected, then the remaining tasks. Wave 0 (running now): T1f, a fix to T1. Wave 1: T2a′ reshapes the API to metric summaries (admin-only writes, 25 links, the publish gate's data). Wave 2 (parallel): T2c′ reseeds the demo with company-level summaries; T4′ reworks the web card, editor and hooks. Wave 3: T2b, the shared explainer, attribution and summary reads, and summary state on views. Wave 4 (parallel): T3 drafts, snapshots and the enforced publish gate; T5 the Why? affordances. Wave 5: T6 the Exec summaries view, the Report's required block and gated Publish, the downloads and Record types. T7 holds what the spec defers.

**Tech Stack:** Go API (oapi-codegen, kin-openapi, the records expression engine), `make gen`; React 19, TypeScript, Tailwind 4, Radix (Popover, Dialog, Tooltip), lucide-react, pptxgenjs and pdf-lib (already present), TanStack Query (already present), Vitest + Testing Library + vitest-axe.

**Spec:** `docs/superpowers/specs/2026-11-20-metric-rca-design.md` (revised 2026-11-21; the changes are its §18). Review: `.superpowers/sdd/2026-11-20-metric-rca/spec-review.md`. Mockups (local, not committed): `.superpowers/sdd/2026-11-20-metric-rca/mockups/`.

## Landed so far

| Commit | Task | What landed | Affected by 2026-11-21? |
|---|---|---|---|
| `61c1f41` | T1 | incident records, the `rca` package (downtime sweep, rounding, gap, expectation, ranking, basis) | No (T1f fixes edge cases; `rca/summary.go` is new in T2a′) |
| `bb9e98b` | T2a | OpenAPI for `*CellRca*`, the RCA store, per-cell note put/delete with contributor and roll-up writes, 5 links / 4 KB, MCP and SAM exposure, stubs | **Yes → T2a′** |
| `d96f6cd` | T2c | demo incidents, per-cell notes (one by the contributor), incident story lines | **Yes → T2c′** (story lines stay) |
| `426e2c2` | T4 | the Why card, per-cell note editor for editors, SAM suggestion, `useCellRca*` hooks, fixtures | **Yes → T4′** |

## Global Constraints

- **Precondition for every task:** none of its files has uncommitted changes from another agent: `git status --short -- <the task's Files>` is empty before starting. **T1f is running now** and owns `api/internal/rca/**`, `api/internal/records/incident*.go`, `api/internal/records/cond*.go`, `api/internal/domain/rca*.go`, `api/internal/recordimport/plan_test.go` and `api/internal/httpapi/records_test.go`; T2a′ starts only after T1f is committed.
- No new dependencies (web or Go), and no indirect Go module made direct (no `golang.org/x/text`). No horizontal scroll at 320–1920px (`document.documentElement.scrollWidth === clientWidth`); the Why card and the full-screen dialog body may scroll vertically; nothing else nests a scroll area.
- Type scale 11/16, 12/16, 14/20, 16/24, 20/28, 28/36 only; text `ink/70` or stronger; targets ≥ 24px (icon buttons and trailing cells 32px); status never by color alone; the tenant's scale labels.
- Copy exactly as in the spec (§10.10 and inline). Plain text everywhere: no `dangerouslySetInnerHTML`, no Markdown rendering of summaries, link titles or imported fields. Every external link `target="_blank" rel="noopener noreferrer"`, through `safeHref` (https only), in the app and the downloads.
- **Only admins write exec summaries**, on every channel (web session, token, MCP). **Nothing ever stands in for a missing summary**: no computed sentence, attribution headline or SAM draft in a summary slot, an export or a snapshot. **A month with a required summary missing never publishes.**
- Never change a value from incidents; the remainder or excess is always shown when ≥ 0.5 min; parts always sum to the displayed gap; gaps come from the displayed value.
- Never reveal what the reader cannot read: children, incidents and stale reasons over readable cells only; a summary is read on the company cell.
- Public repo: no company or product names in code, tests, docs, fixtures or commit messages. Sample exports use `tracker.example`, `oncall.example`, `status.example`, `docs.example`.
- **Parallel execution rules** (as in the 2026-11-17 polish round; tasks in a wave run at the same time in this one checkout, no branches or worktrees):
  1. Each task edits only the files its **Files** list owns; it imports earlier tasks' code without editing it, except where its list names the file (ownership passes in wave order). Rework tasks own the landed files they list.
  2. Each task runs its own servers on its own ports, and **stops only the processes it started — never `pkill`, `killall` or any broad kill**:

     | Task | API | Web |
     |---|---|---|
     | T1f | — | — |
     | T2a′ | 8121 | 5221 |
     | T2c′ | 8122 | 5222 |
     | T2b | 8123 | 5223 |
     | T4′ | 8124 | 5224 |
     | T3 | 8125 | 5225 |
     | T5 | 8126 | 5226 |
     | T6 | 8127 | 5227 |
     | T7 | 8128 | 5228 |

     ```bash
     (cd api && go run ./cmd/devserver -addr 127.0.0.1:$API -allowed-origin http://localhost:$WEB -seed demo -auth dev -dev-secret opsvision-local-dev-secret-not-for-production)
     (cd web && VITE_API_URL=http://127.0.0.1:$API VITE_AUTH_MODE=dev npx vite --port $WEB --strictPort)
     ```
  3. While working, a task may run targeted tests in the shared tree (another task's half-finished edits can fail unrelated tests there; ignore those and never fix another task's file).
  4. **Final gate in a temporary export of `HEAD` with only the task's own changed files copied in**, so the counts are its own:

     ```bash
     FILES="<this task's created and modified files>"        # and DELETED="<removed files>", if any
     EX=$(mktemp -d "/tmp/opsv-gate-$TASK.XXXX")
     git archive HEAD | tar -x -C "$EX"
     for f in $FILES; do mkdir -p "$EX/$(dirname "$f")"; cp "$f" "$EX/$f"; done
     for f in $DELETED; do rm -f "$EX/$f"; done
     ln -s "$PWD/web/node_modules" "$EX/web/node_modules"
     (cd "$EX/api" && go test ./...)                                           # when the task touches api/
     (cd "$EX" && make gen-check)                                              # when the task touches openapi/openapi.yaml
     (cd "$EX/web" && npx vitest run && npx tsc -b --noEmit && npx eslint .)   # file and test counts stated
     rm -rf "$EX"
     ```
  5. Commit only the task's own files: `git add -- $FILES && git commit --only -m "<message>" -- $FILES`. Never `git add -A` or `git add .`. **Never commit the untracked `import subprocess.py`** at the repository root. If `.git/index.lock` exists, wait and retry; never delete it.
- **Gate contents** (every task): `go test ./...` with package and test counts named when the task touches `api/`; `make gen-check` when it touches the OpenAPI; the full web suite with file and test counts, `npx tsc -b --noEmit`, `npx eslint .` with 0 errors; screenshots at 1440 and 390 of what it touched against its own servers, saved to `.superpowers/sdd/2026-11-20-metric-rca/task-<id>/`, with `scrollWidth === clientWidth` noted.

## Review Focus

1. **Who may write:** a contributor's browser session, a contributor's personal access token, a viewer, and a contributor through `/v1/mcp` each call `putMetricSummary` and `deleteMetricSummary` — all 403 `Only admins can write exec summaries.`, nothing stored, no audit entry; the same calls as an admin succeed (MCP labelled `via MCP`), and `delete_metric_summary` is not an MCP tool. Tested in T2a′; the web shows no editor to non-admins (T4′).
2. **The publish gate under races and edge months:** a summary deleted after the Report loaded (409 with the list; the Report re-renders), a stale summary (allowed, flagged), republishing revision 2, publishing through MCP, a Green-below-100% metric, Uptime where only one service is below 100%, a quarterly metric (gates only the month that closes its quarter), a metric not reported this month (not required). Tested in T2a′ (requirement) and T3 (enforcement), surfaced in T6.
3. **Nothing stands in for a missing summary:** the card, the tile, the Report blocks, the Notes section, the PPTX, the PDF and a published snapshot of a live month with a missing summary show `Exec summary not written yet` / `Exec summary needed` and never a SAM draft, a computed headline or another metric's text. Tested in T4′, T3 and T6.
4. **Hostile and bulk links:** 26 links; 25 links over 16 KB; `Paste links` with `http://`, `javascript:`, blank and duplicate lines; `HTTPS://` (accepted, lowercased); an https URL carrying a user name and password; a link title that is an HTML `img` tag with an `onerror` handler; an imported incident title telling SAM to print a link. Rejected or neutralized; rendered as text. Tested in T2a′, T4′, T3.
5. **Load and size at the limits:** a service with 37 incidents (5 shown, `Show all`, pages of 50, arithmetic over all 37), `listMetricSummaries?full=true` with 16 maximum summaries, `getMetricSummary` at the maximum, the demo Overview with summary state, publish with every metric summarized. Within spec §9.5–§9.6's budgets. Tested in T2b and T3.

---

### Task T1f (running; not part of this revision): T1 edge-case fix — Wave 0

Owns `api/internal/rca/**`, `api/internal/records/incident*.go`, `cond*.go`, `api/internal/domain/rca*.go`, `api/internal/recordimport/plan_test.go`, `api/internal/httpapi/records_test.go` (gap and incident validation edge cases). Its commit is T2a′'s precondition. No ports.

---

### Task T2a′: Rework the API to metric summaries — admin-only, 25 links, the gate's data — Wave 1

Reworks `bb9e98b` (and the tests `d96f6cd` touched in `httpapi/`).

**Files:**
- Modify: `openapi/openapi.yaml` (spec §9.1–§9.2: replace `getCellRca`, `putCellRca`, `deleteCellRca`, `listCellRcas`, `draftCellRca`, `getCellRcaDraft` with `getCellAttribution` (`incidentsCursor`, `recordsCursor`), `getMetricSummary` (`revision`), `putMetricSummary`, `deleteMetricSummary`, `listMetricSummaries` (`state`, `full`, `revision`, `countsOnly`, `cursor`), `draftMetricSummary`, `getMetricSummaryDraft`; schemas `MetricSummary`, `MetricSummaryList`, `PutMetricSummaryRequest` (25 links), `CellAttribution` (was `CellRca`, note fields removed, `summary` added), `RcaChild` (`attributionLine`), `MetricSummaryState` as `Cell.summary` (replacing `Cell.rca`/`CellRcaState`), `RcaEvidenceKey`, `MetricSummaryDraft`, `PublishBlocked`; `publishReport` gains the 409 `PublishBlocked` response; **remove** `getReportDocument`'s `rcas` parameter and `ReportDocument.rcas`; the untrusted-text sentence in the three read descriptions); regenerate `api/internal/httpapi/gen.go` and `web/src/api/schema.d.ts` (`make gen`)
- Modify: `api/internal/domain/rca.go`, `rca_test.go` (ownership passes from T1f: `MaxRCALinks = 25`, `MaxRCALinkBytes = 16384`, the spec §8.2 messages)
- Create: `api/internal/rca/summary.go`, `summary_test.go` (ownership of the new file only)
- Modify: `api/internal/httpapi/rca.go` (rename handlers to `PutMetricSummary` / `DeleteMetricSummary`; subject fixed to the root unit; **admin-only** via `auth.Can(p, auth.ActionTenantAdmin, …)`; audit `targetType: metric_summary`, `targetId: {metric}|{period}`), `rca_test.go`, `rca_basis.go` (company basis: standing display and status, subject evidence, incident keys; `loadIncidents` unchanged), `rca_stubs_read.go` (stubs: `GetCellAttribution`, `GetMetricSummary`, `ListMetricSummaries`), `rca_stubs_draft.go` (stubs: `DraftMetricSummary`, `GetMetricSummaryDraft`), `mcp.go` (`mcpExcluded`: `delete_metric_summary`, `draft_metric_summary`, `get_metric_summary_draft`), `mcp_rca_test.go`, `server.go`
- Create: `api/internal/httpapi/summary_gate.go`, `summary_gate_test.go`
- Modify: `api/internal/assistant/tools.go`, `tools_test.go` (`toolSetExcluded` gains `/scorecards/{sc}/metric-summaries/{metric}/{period}/draft`)

**Interfaces:**
- Consumes: T1/T1f's `rca` package; the landed `RCAStore` (unchanged: the subject is always the root unit).
- Produces:
  ```go
  // rca/summary.go
  type Requirement struct { Required bool; Reason string } // Reason: "Red", "Below 100% (99.97%)", "1 of 24 services below 100%"
  type SummaryInput struct {
      Metric domain.Metric; Company *CellFacts; CompanyRule domain.StatusRule
      Reporting []SubjectFacts // the reporting subjects, used when the company has no value
      Scale []domain.StatusLevel; Coarse bool; ClosesInMonth bool; Noun NounForms
  }
  func SummaryRequired(in SummaryInput) Requirement
  func CompanyHeadline(in SummaryInput) string // "6 of 24 services below 100% · worst Webhooks 99.06%"

  // httpapi/summary_gate.go — cheap: one engine compute for the month (and coarse periods it closes) + one ListRCAs per period; no derive input
  type GateItem struct { MetricKey, MetricName string; Period period.Period; Requirement rca.Requirement; State string /* missing|written|stale|optional */; Standing MetricSummaryStanding }
  func (s *Server) summaryGate(ctx context.Context, tenant domain.Tenant, sc string, month period.Period) ([]GateItem, error)
  ```
  The generated types above for T2c′, T4′, T2b, T3.

- [ ] **Step 1: Write the failing tests**

`summary_test.go`: one case per row of spec §4.1 — company Red → required `Red`; company Green 99.97% → required `Below 100% (99.97%)`; company Green 100% → optional; Uptime with no company value and one service at 99.97% Green → required `1 of 24 services below 100%`; all services 100% → optional; not reported / all n/a → optional; a change-rule metric Green → optional; a quarterly metric: required for `2026-Q3` with `ClosesInMonth` for Sep, not for Oct. `CompanyHeadline` for the demo Uptime → `6 of 24 services below 100% · worst Webhooks 99.06%` (fixture counts).

`summary_gate_test.go`: for the demo's 2026-M10 (fixture notes until T2c′) the gate lists every metric with its requirement and state; a deleted summary flips its state to `missing`; a summary whose basis display differs is `stale`; the gate loads no derive input (instrumented loader) and finishes under 2 s.

`rca_test.go` (Review Focus 1, 4):
- `TestPutMetricSummaryAdminOnly`: as admin (session), `PUT /v1/scorecards/service-fulfillment/metric-summaries/uptime/2026-M10` stores a summary with `SubjectID` the root unit, revision 1, `channel: web`; with an admin's token `channel: api`; through `/v1/mcp` `channel: mcp`. The contributor (session, token and MCP) and the viewer get 403 `Only admins can write exec summaries.`; nothing stored; no audit entry. The old contributor and roll-up write tests are removed.
- `TestPutMetricSummaryLinks`: 25 links accepted; 26 → `Up to 25 links` at `links`; 25 links totalling over 16,384 bytes → `These links are too long together; shorten or remove some`; `HTTPS://docs.example/a` stored lowercased; `javascript:`, `http:`, user-info and whitespace URLs → `Use a link that starts with https://` at `links[i].url`; duplicate → `This link is already listed`; an HTML title accepted as text.
- `TestMetricSummaryRevisionsAndAudit`: create, update, confirm and delete write `create`, `update`, `confirm`, `delete` with `targetType: metric_summary` and `targetId: uptime|2026-M10`; a stale `expectedRevision` → 409 with the current summary.
- `TestMetricSummaryBasis`: the stored basis is the company standing (`99.06%`, `R` for worst-of Uptime), subject evidence `subject:webhooks`, `subject:search`, … and incident keys.
- `TestStubs`: `GET /attribution`, `GET /metric-summaries/{m}/{p}`, `GET /metric-summaries`, `POST …/draft` → 501.

`mcp_rca_test.go`: the catalog has `get_cell_attribution`, `get_metric_summary`, `list_metric_summaries`, `put_metric_summary`; not `delete_metric_summary`, `draft_metric_summary`, `get_metric_summary_draft`, nor any `*_cell_rca*` tool; `get_report_document` has no `rcas` argument; read descriptions contain `untrusted`. `tools_test.go`: SAM has the three read tools and no write or draft tool. `domain/rca_test.go`: the 25 / 16 KB limits and messages.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/rca/... ./internal/domain/... ./internal/httpapi/... ./internal/assistant/...`.

- [ ] **Step 3: Implement.** OpenAPI first, `make gen`, then `domain/rca.go`, `rca/summary.go`, the handlers, `summary_gate.go`, the stubs and exclusions. The store and its contract suite do not change.

- [ ] **Step 4: Verify**, then the gate with `make gen-check`. Save `curl` outputs of an admin put, a contributor 403 and a 26-link 400 to `task-T2a′/`.

- [ ] **Step 5: Commit** — `feat(api): metric exec summaries: admin-only writes, 25 links, the publish gate's data`.

---

### Task T2c′: Reseed the demo with company-level exec summaries — Wave 2

Reworks `d96f6cd`'s notes (the incidents and story lines stay).

**Files:**
- Modify: `api/internal/demo/seed.go`, `seed_test.go`

**Interfaces:**
- Consumes: T2a′'s domain limits and `summaryGate`.
- Produces: spec §14's summaries for Oct 2026 (written: Uptime, Epics delivered on time, Incident postmortems on time; stale: Spend vs plan; missing: Deployment uptime, Weighted support backlog, Security training completion), all by `dev|admin`; `RCAExamples` and `RCANeeded` replaced by `demo.SummaryWritten`, `demo.SummaryStale`, `demo.SummaryMissing` (metric keys and period) and `demo.AttributionExamples` (the four attribution cells: Webhooks, Search, Analytics Ingest, Notification Relay - Multi-Region Active, Oct 2026).

- [ ] **Step 1: Write the failing tests**

`seed_test.go`: no per-cell notes remain (every stored summary's subject is the root unit; none authored by the contributor); the written, stale and missing sets equal the spec's; `summaryGate(2026-M10)` reports exactly `demo.SummaryMissing` as missing and `demo.SummaryStale` as stale; the Uptime summary has 4 links; the incident snapshot, fan-out records and Webhooks' 420 minutes are unchanged; Sep 2026 has a summary for every required metric (so Sep is publishable in the demo).

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/demo/...`.

- [ ] **Step 3: Implement** through the store with explicit bases (the stale one with a different basis display).

- [ ] **Step 4: Verify**, then the gate. Save the gate output for 2026-M10 to `task-T2c′/`.

- [ ] **Step 5: Commit** — `feat(api): demo exec summaries at company scope`.

---

### Task T4′: Rework the Why card, editor and hooks for exec summaries — Wave 2

Reworks `426e2c2`.

**Files:**
- Modify: `web/src/features/rca/WhyButton.tsx`, `WhyButton.test.tsx`, `WhyCard.tsx`, `WhyCard.test.tsx`, `WhyCardContent.tsx`, `EvidenceList.tsx`, `GapBar.tsx`, `RcaEditForm.tsx`, `RcaEditForm.test.tsx`, `SamSuggestion.tsx`, `WhyCardProvider.tsx`, `rcaState.ts`, `rcaState.test.ts`, `rcaText.ts`, `rcaText.test.ts`
- Create: `web/src/features/rca/SummarySection.tsx`, `SummarySection.test.tsx`, `LinkList.tsx`, `PasteLinks.tsx`, `PasteLinks.test.tsx`
- Modify: `web/src/api/queries.ts`, `web/src/api/queries.test.tsx`, `web/src/test/rcaFixtures.ts`, `web/src/test/server.ts`
- Keep: `web/src/features/scorecard/ScorecardFrame.tsx` (the provider mount stands; edit only if a prop changes)

**Interfaces:**
- Consumes: T2a′'s generated schemas.
- Produces:
  - Hooks (replacing `useCellRca*`): `useCellAttribution(sc, ref: RcaCellRef | null)` (an infinite query over `incidentsCursor`/`recordsCursor`), `useMetricSummary(sc, metric, period, revision?)`, `usePutMetricSummary(sc)`, `useDeleteMetricSummary(sc)`, `useMetricSummaries(sc, q: { period: string; state?: SummaryListState; full?: boolean; revision?: number })` (paged), `useMetricSummaryCounts(sc, period)` (`countsOnly=true`, `staleTime: 60_000`), `useMetricSummaryDraft(sc)`. `usePublishReport` surfaces a 409 as `PublishBlockedError { missing: MetricSummary[]; stale: number }`. `useReportDocument` no longer sends `rcas`.
  - `rcaState.ts`: `summaryDisplay(cell: Cell, role: Role): SummaryDisplay | null` (company-root cells, from `Cell.summary`); `attributionAvailable(row, cell, scale): boolean` (from `ViewRow.rcaIdeal`, status and `bestStatus`).
  - `WhyButton({ summary?: SummaryDisplay, attribution: boolean, … , prefix?: 'why' | 'summary' })` — spec §10.1 (missing tag for everyone; admin wording differs).
  - `useWhyCard().open(ref, anchor, opts?: { showValue?: boolean })` unchanged in shape.
  - `rcaText.ts`: `RCA_LINKS_MAX = 25`, `RCA_LINKS_BYTES = 16384`, `parsePastedLinks(text: string, existing: RcaLink[]): { added: RcaLink[]; rejected: string[] }` (title from the last path segment or the host), `rollupTag` removed.

- [ ] **Step 1: Write the failing tests**

`SummarySection.test.tsx`: written → text, byline, first 3 of 12 links and `Show all 12 links` (`aria-expanded`), expanding shows 12 and announces `Showing 12 links`; stale → banner reasons, admins see `Edit` and `Still accurate`; **missing, admin** → `No exec summary yet for Uptime, Oct 2026.`, the required reason, `Write exec summary`, `Draft with SAM`; **missing, contributor or viewer** → the same two sentences and `Product ops writes this summary.`, no buttons; optional → `No exec summary (not required: 100% this month).` (`Add one` for admins); a child cell's card labels the section `Exec summary · Uptime · Oct 2026`; a scoped viewer's card (summary `null`) has no section. Review Focus 3: with a SAM draft in the cache, a missing summary's section still shows no draft text.
`WhyCard.test.tsx` (updated): the Exec summary section comes before Attribution; the Webhooks card's attribution unchanged (headline, rows, overlap note, remainder, links `noopener noreferrer`); a service with 37 incidents shows 5 and `Show all 37 incidents`, loads pages of 50 on scroll to the end, and the bar sentence still covers 37; the epics card has no per-row points; children rows show `attributionLine`s; the anchored popover has no value row, the sheet has it with `line-clamp-2` titles; a `javascript:` key renders as text; an HTML title renders as text.
`WhyButton.test.tsx`: the states of spec §10.1, including `Exec summary needed` for admins and `No exec summary yet` for others on a company-standing surface, `Summary:` prefix for attention cards, and `Why?` only (no tag) on non-company cells; hints in `aria-description`.
`RcaEditForm.test.tsx`: rendered only for admins (`canEdit`); label `Exec summary for Uptime, Oct 2026`; counter `212 / 280` in code points of NFC text; `12 / 25 links`; `Add link` hidden at 25; the 16 KB message; delete confirm includes `Oct 2026 can't be published again until a new one is written.` when required; 409 `Someone else changed this exec summary while you were editing.` keeps `Your text`; dirty close asks `Discard your changes?`; `Use this draft` replaces the text with `Undo` and does not call `putMetricSummary`; draft warnings shown.
`PasteLinks.test.tsx` (Review Focus 4): pasting `https://tracker.example/browse/INC-2041`, `https://oncall.example/incidents/88412`, `http://x`, `javascript:alert(1)`, a blank line and a duplicate adds two rows titled `INC-2041` and `88412` and lists `3 lines are not https links` (blank lines ignored, the duplicate reported); pasting past 25 adds up to 25 and says `Up to 25 links`.
`rcaState.test.ts`: `summaryDisplay` for each `Cell.summary` state and role; `attributionAvailable` for Green 99.97% (true), 100% (false), Red roll-up (true), custom scale.
`queries.test.tsx`: `usePutMetricSummary` invalidates the summary, the list, the counts, the attribution queries and the views of the period; `usePublishReport` maps a 409 `summaries_missing` to `PublishBlockedError` with the list; `useReportDocument` sends no `rcas`.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- rca queries`.

- [ ] **Step 3: Implement** per spec §10.1–§10.4, §10.7, §10.10–§10.11; remove the per-cell note paths and the contributor editor.

- [ ] **Step 4: Verify**, then the gate. No app screenshots (reads are stubbed until T2b); attach the Testing Library DOM output of the Uptime company card (written, missing for admin, missing for viewer) to `task-T4′/`.

- [ ] **Step 5: Commit** — `feat(web): exec summaries in the Why card: admin-only editor, 25 links, missing states`.

---

### Task T2b: The shared explainer, attribution and summary reads, summary state on views — Wave 3

**Files:**
- Create: `api/internal/httpapi/rca_explain.go`, `rca_explain_test.go`, `rca_view.go`, `rca_view_test.go`, `rca_list.go`, `rca_list_test.go`, `rca_budget_test.go`
- Delete: `api/internal/httpapi/rca_stubs_read.go`
- Modify: `api/internal/httpapi/rca_basis.go` (ownership passes from T2a′: delegates to the explainer at depth `state`), `summary_gate.go` (the list's counts reuse it), `view.go`, `view_test.go`

**Interfaces:**
- Consumes: T2a′ (`summaryGate`, `loadIncidents`, the store), T2c′'s demo and its exported sets.
- Produces (spec §9.5):
  ```go
  func (s *Server) newExplainer(ctx context.Context, p auth.Principal, sc string, periods []period.Period, opts explainOpts) (*explainer, error)
  func (e *explainer) attribution(metric, subject string, per period.Period, d explainDepth, c attributionCursors) (CellAttribution, error)
  func (e *explainer) summary(metric string, per period.Period, full bool) (MetricSummary, error)
  func (e *explainer) required(per period.Period) ([]MetricSummary, error)
  func annotateSummaries(v *ScorecardView, e *explainer) // live views; company-root cells only
  ```
  `GetCellAttribution`, `GetMetricSummary` (live; `revision` → 501 until T3), `ListMetricSummaries` (live; `revision` → 501 until T3).

- [ ] **Step 1: Write the failing tests**

`rca_explain_test.go`: `GET /v1/scorecards/service-fulfillment/attribution?metric=uptime&subject=webhooks&period=2026-M10` → `attribution: available`, headline `0.94 pts short of 100% · 7h 00m down`, `INC-2041 0.56 pts 4h 10m`, `INC-2047 0.25 pts 1h 53m` (`Overlaps INC-2049 for 25m`), `INC-2049 0.04 pts 17m`, remainder `0.09 pts · 40m of the 7h 00m reported`, and `summary` the company Uptime summary's excerpt with its first 3 links; Search's tie (`0.07`, `0.06`); Analytics Ingest's excess (`0.20 pts`); the epics product cell's records without `impactDisplay`; the company Uptime cell's headline `6 of 24 services below 100% · worst Webhooks 99.06%` and three `children` with `attributionLine`s; a fixture service with 37 incidents returns 5, `incidentsTotal: 37`, an `incidentsCursor`, and pages of 50 (Review Focus 5); a Mobile-scoped viewer gets `summary: null` and only Mobile children; a tenant without incident types → `(from the value)`.

`GET /metric-summaries/uptime/2026-M10` → the full summary (4 links), `requirement: required`, `state: written`; `spend_vs_plan` → `stale` with `The value changed from …`; `deployment_uptime` → `missing` with reason `Red`; `security_training` → `missing` with `Below 100% (94%)` (demo values as seeded).

`rca_list_test.go`: default `state=missing` returns exactly `demo.SummaryMissing`, sorted by status; `state=all` lists every metric with optional ones last; `counts` match the gate; `full=true` pages of 16 with all links; `countsOnly=true` returns no items and loads no derive input; a contributor reads everything with `canEdit: false`; an admin gets `canEdit: true`.

`rca_view_test.go` / `view_test.go`: the Overview for 2026-M10 has `summary` only on company-root cells (`written` with an excerpt ≤ 64 characters on Uptime, `missing` on Deployment uptime, `stale` on Spend vs plan), none on any service, product or YTD cell, and none for perfect metrics without a summary; `restate=` computes no `stale`; `ViewRow.rcaIdeal` 100 on uptime rows.

`rca_budget_test.go` (Review Focus 5): the Overview's gzipped body grows ≤ 2% with summary state and stays under 512 KB raw, within 1.5× the time without; `getMetricSummary` at the maximum (25 links at 16 KB) under 24 KB; the attribution first page under 32 KB and a page of 50 under 64 KB; `listMetricSummaries` for 200 metrics under 384 KB and under 2 s; `full=true` with 16 maximum summaries under 480 KB.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/httpapi/... -run 'Attribution|MetricSummar|SummaryView|View|Budget'`.

- [ ] **Step 3: Implement** per spec §9.2, §9.5, §9.6 and §8.4.

- [ ] **Step 4: Verify**, then the gate. Save `curl` outputs for the four attribution cells, the three summary states and the list to `task-T2b/`.

- [ ] **Step 5: Commit** — `feat(api): attribution, exec summary reads and summary state on views`.

---

### Task T3: SAM drafts, snapshots and the enforced publish gate — Wave 4

**Files:**
- Create: `api/internal/assistant/summary_draft.go`, `summary_draft_test.go`, `links.go`, `links_test.go`
- Modify: `api/internal/assistant/runner.go`, `runner_test.go`, `prompt.go`, `api/internal/domain/assistant.go` (`AssistantDraft.Kind`, `MetricKey`)
- Create: `api/internal/help/topics/rca.md`; Modify: `api/internal/help/help_test.go`
- Delete: `api/internal/httpapi/rca_stubs_draft.go`; Create: `api/internal/httpapi/summary_draft.go`, `summary_draft_test.go`
- Modify: `api/internal/httpapi/report_draft.go`, `report_draft_test.go`, `assistant_threads.go`, `assistant_threads_test.go`
- Modify: `api/internal/report/snapshot.go`, `snapshot_test.go` (`SchemaVersion` 3, `SummarySnapshot`), `api/internal/httpapi/reports.go`, `reports_test.go` (the gate, the 409, snapshots)
- Modify: `api/internal/httpapi/rca_list.go` and `rca_explain.go` (ownership passes from T2b: the `revision` branch of `listMetricSummaries` and `getMetricSummary`)
- Modify: `api/internal/store/memstore/drafts.go`, `store/dynamostore/drafts.go`

**Interfaces:**
- Consumes: T2b's explainer; T2a′'s `summaryGate`.
- Produces: `assistant.MetricSummaryPromptVersion = "sam-metric-summary-v1"`; `assistant.DraftKeyWarnings`; `assistant.RewriteAnswerLinks`; `report.SummarySnapshot`; the 409 `PublishBlocked` from `PublishReport`; `revision=N` reads.

- [ ] **Step 1: Write the failing tests**

`reports_test.go` (Review Focus 2): publishing 2026-M10 in the demo → 409 `summaries_missing`, `message` `3 exec summaries are missing for Oct 2026.`, `missing` equal to `demo.SummaryMissing` (each with standing headline and reason), `stale: 1`, nothing stored; after an admin writes the three, publish succeeds and the stored object has `schemaVersion: 3`, a `summaries` entry for every required metric (plus any optional one), all links, and a `view` with no `summary` on any cell; deleting a summary between the gate-check read and publish (two requests) → 409; republish (revision 2) is gated; MCP `publish_report` returns the same 409 in its tool result; a quarterly metric's `2026-Q3` summary is required to publish Sep and not Oct; publishing under 10 s with every metric summarized. `GET …/metric-summaries?period=2026-M10&revision=1&full=true` returns the frozen texts; editing a summary afterwards leaves revision 1 unchanged; a v2 revision returns `items: []`.

`snapshot_test.go` (Review Focus 3): a live month with a missing summary, published through a test-only path that bypasses the gate, is refused by `report.Document` validation (`a required exec summary is missing`), so no snapshot ever holds a placeholder.

`summary_draft_test.go` (assistant, fake provider): the prompt's rule lines verbatim and `(Prompt sam-metric-summary-v1.)`; the user message for Uptime lists the worst contributors' attribution lines, `INC-2041`, `INC-2047`, `INC-2049` and `0.09 pts not explained`, and no other key; cut at 280; `DraftKeyWarnings` from key shapes; a contributor or viewer gets 403 (admin-only).

`summary_draft_test.go` (httpapi), `report_draft_test.go` (Review Focus 3): `POST …/metric-summaries/uptime/2026-M10/draft` → 202 then text and warnings; the summary is unchanged; the month's summary list does not count the draft as written; a pending metric-summary draft does not block the report summary draft; `GET …/summary/draft/{metricDraftId}` → 404; eviction per kind.

`links_test.go` and `runner_test.go` (Review Focus 4): `RewriteAnswerLinks` keeps tool-result hosts and turns others into `title (host)`; an incident title instructing SAM to link `evil.example` yields no such link; `prompt.go` has spec §9.4's two sentences.

`help_test.go`: `help.Search("exec summary publish")` returns `rca` first; the topic explains the gate and the overlap rule.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/assistant/... ./internal/httpapi/... ./internal/report/... ./internal/help/... ./internal/store/...`.

- [ ] **Step 3: Implement** per spec §9.3, §9.4, §9.7 and §10.9.

- [ ] **Step 4: Verify**, then the gate (`make gen-check` must still pass; T3 does not edit the OpenAPI).

- [ ] **Step 5: Commit** — `feat(api): exec summary drafts, frozen summaries and the publish gate`.

---

### Task T5: Why? on tiles, the board, item grids and the full-screen dialog — Wave 4

**Files** (all exist at `HEAD`):
- Modify: `web/src/features/scorecard/TileFrame.tsx`, `TileFrame.test.tsx`, `MetricTile.tsx`, `ItemSummaryTile.tsx`, `ItemSummaryTile.test.tsx`, `AttentionCard.tsx`, `AttentionCard.test.tsx`, `OverviewPage.tsx` (prop plumbing only), `OverviewPage.test.tsx`
- Modify: `web/src/features/scorecard/StatusBoard.tsx`, `StatusBoard.test.tsx`, `logic/statusBoard.ts`, `logic/statusBoard.test.ts`
- Modify: `web/src/features/scorecard/ItemGrid.tsx`, `ItemGrid.test.tsx`, `ItemDrillIn.tsx`, `ItemDrillIn.test.tsx`, `ItemMonths.tsx`, `ItemMonths.test.tsx`, `FocusDialog.tsx`, `FocusDialog.test.tsx`, `useDialogShortcuts.ts`, `useDialogShortcuts.test.tsx`
- Modify: `web/src/ui/status/StatusCell.tsx`, `StatusCellTip.tsx`, `useGridNavigation.ts`, `useGridNavigation.test.tsx`
- Modify: `web/src/test/viewFixtures.ts` (`Cell.summary`, `ViewRow.rcaIdeal`)

**Interfaces:**
- Consumes: T4′'s `WhyButton`, `useWhyCard`, `summaryDisplay`, `attributionAvailable`; `Cell.summary` and `ViewRow.rcaIdeal` from T2b's views.
- Produces: `TileFrameProps.why?: ReactNode`; `StatusCell` prop `summary?: MetricSummaryState` (mark on company-root cells only); `StatusCellTipProps.summary?`; `GridNavigationOptions.trailing?: boolean`, `onWhy?: (rowId, col, el) => void` (bound to `W`); `ItemMonthsProps.onWhy?: (period, el) => void`.

- [ ] **Step 1: Write the failing tests**

- `useGridNavigation.test.tsx`: with `trailing`, End still lands on the selected period and the first tab stop is the selected period; → reaches the trailing cell, ← returns; spacer rows keep → on the selected period; `W` calls `onWhy`; `W` with Ctrl or in an input does nothing.
- `TileFrame.test.tsx`: the `why` slot sits between the value row and the chart; absent → DOM unchanged.
- `OverviewPage.test.tsx`: a company-scope Uptime tile shows `Why:` + the summary excerpt; Deployment uptime shows `Why? Exec summary needed` for the admin and `Why? No exec summary yet` for the viewer; Security training (Green 94%) shows the missing tag too; a tile scoped to Checkout shows `Why?` only; a perfect tile shows nothing.
- `ItemSummaryTile.test.tsx`: the footer shows `Summary: …` when written and `Exec summary needed ›` (admins) when missing, linking `exec-summaries?period=2026-M10&why=uptime`; service rows carry no marks or tags.
- `AttentionCard.test.tsx`: the line reads `Summary: …` / `Exec summary needed` / `No exec summary yet`, under `attention-why`, `relative z-10`, and opens the card.
- `StatusBoard.test.tsx`: inline — → from Oct reaches Current; Enter opens the company card; Current shows the summary state (mark and name `; exec summary written`, or the missing tag); month cells keep opening the dialog and `W` opens their card; stacked (360px) — the ribbon row ends in a 32px trailing gridcell reachable by → and tap.
- `ItemGrid.test.tsx`: the Value cell is the trailing gridcell named `Webhooks, Oct 2026: 99.06%, Red.` with `aria-description` `Press Enter for why`; Enter opens the service card (attribution, company summary as context); no tags on any row; stacked trailing cell reachable.
- `ItemMonths.test.tsx` / `FocusDialog.test.tsx`: with `onWhy`, the Status cell shows a compact `Why` for months with attribution, and `Summary` / `Needed` at company scope, still four columns at 390px; Monthly values render in every full-screen body; the value row has the WhyButton; Escape closes only the card.
- `ItemDrillIn.test.tsx`: the drill-in value row has `Why?` for the item's cell.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- useGridNavigation TileFrame OverviewPage ItemSummaryTile AttentionCard StatusBoard statusBoard ItemGrid ItemMonths FocusDialog ItemDrillIn useDialogShortcuts`.

- [ ] **Step 3: Implement** per spec §4.5, §10.1, §10.6 and §10.7.

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390 (T5 servers, T2c′ demo): the Overview at company scope (Uptime written, Deployment uptime missing as admin and as viewer, the board's Current cells; phones: the stacked trailing cell), at `?scope=checkout`, `?focus=uptime` (Value cell focused), `?focus=uptime&item=webhooks` with the card open (attribution under the company summary), `?focus=deployment_uptime` with the missing card as admin.

- [ ] **Step 5: Commit** — `feat(web): Why? and exec summary states on tiles, the board, grids and the dialog`.

---

### Task T6: Exec summaries view, the Report's gate, the downloads and Record types — Wave 5

**Files** (all exist at `HEAD` unless marked Create):
- Create: `web/src/features/rca/ExecSummariesPage.tsx`, `ExecSummariesPage.test.tsx`, `summaryReminder.ts`, `summaryReminder.test.ts`
- Modify: `web/src/App.tsx` (route `scorecards/:sc/exec-summaries`), `web/src/features/scorecard/ControlBar.tsx`, `ControlBar.test.tsx` (fourth view and pill)
- Modify: `web/src/features/scorecard/ReportPage.tsx`, `ReportPage.test.tsx`, `report/model.ts`, `report/model.test.ts`, `report/ReportStatusList.tsx`, `report/ReportStatusList.test.tsx`, `report/pptx.ts`, `report/pdf.ts`, `report/export.test.ts`, `web/src/test/reportFixtures.ts`
- Modify: `web/src/features/admin/RecordTypesPage.tsx`, `RecordTypesPage.test.tsx`, `adminModel.ts`, `adminModel.test.ts`

**Interfaces:**
- Consumes: T4′'s hooks (`useMetricSummaries`, `useMetricSummaryCounts`, `usePublishReport` with `PublishBlockedError`) and card; T3's gate and `revision` reads.
- Produces: `ReportMetric.summary?: { state: 'missing' | 'written' | 'stale' | 'optional'; text?: string; author?: string; links: RcaLink[]; linksTotal: number; reason?: string; attributionLine?: string; editedSincePublication: boolean }`; `ReportModel.summariesMissing: MetricSummary[]`, `ReportModel.summariesStale: number`; `reminderText(items: MetricSummary[], url: string, periodLabel: string): string`.

- [ ] **Step 1: Write the failing tests**

- `ExecSummariesPage.test.tsx`: `?state=missing` default; toggles `aria-pressed` with the URL; rows grouped by category; columns and copy of spec §10.5; admins see `Write` / `Review` / `Edit`, contributors and viewers `Open`; after an admin save the row updates, focus stays, live region `Exec summary saved for Uptime`; both empty states; `?why=deployment_uptime` opens that card; one `li` per metric under 640px; axe clean.
- `summaryReminder.test.ts`: the exact block of spec §10.5.
- `ControlBar.test.tsx`: tab `Exec summaries` (phones `Summaries`) with pill `3` named `Exec summaries, 3 needed` for everyone; none at 0; `countsOnly=true` not refetched within 60 s.
- `ReportPage.test.tsx` (Review Focus 2, 3): a live Oct report shows the required block `3 exec summaries needed before Oct 2026 can be published` listing the three with links (admins also `Write ›`); Publish is `aria-disabled` with `Publishing needs 3 more exec summaries.`; when the counts reach 0 Publish enables and the stale line `1 exec summary may be out of date: Spend vs plan. Publishing is allowed.` shows; a mocked 409 re-renders the block from its `missing` and focuses its heading; MetricBlocks show the summary (first 3 links, `Show all 12 links`) and the attribution line, or `Exec summary needed` — never draft or computed text; the Notes section `Exec summaries`; a published v3 revision shows frozen texts and `Exec summary edited since publication` when newer; a v2 revision shows `This revision was published before exec summaries were required.`
- `model.test.ts`: summaries joined to metrics; `summariesMissing` and `summariesStale`; v2 handling.
- `ReportStatusList.test.tsx`: captions gain `Summary: …` or `Exec summary needed`.
- `export.test.ts` (Review Focus 3): a live PPTX with a missing summary prints `Exec summary not written yet` for it and nothing else in that box; metric slides hyperlink up to 3 links through `safeHref` and say `+ 9 more links in the appendix`; the appendix `Exec summaries · Oct 2026` lists every link, 6 rows a slide; the PDF prints titles and URLs (`safeHref` only); a title `Queue < 5 & retries > 3` round-trips literally.
- `RecordTypesPage.test.tsx` / `adminModel.test.ts`: `Add incident type` creates the preset, then is disabled; an Explains row saves `explains: [{ scorecardId, metricKey: 'uptime', mode: 'downtime', where: "category != 'maintenance'" }]` with the loaded revision; 409 shows the conflict message; the attribute picker offers `Date and time`.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- ExecSummariesPage summaryReminder ControlBar model ReportPage ReportStatusList export RecordTypesPage adminModel`.

- [ ] **Step 3: Implement** per spec §7.1, §10.5, §10.8 and §10.9.

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390: `/scorecards/service-fulfillment/exec-summaries?period=2026-M10` (needed; all; the card open from `Write`), the live Oct Report with the required block and disabled Publish (admin) and after writing the three (enabled, stale line), the PPTX and PDF (Uptime slide; appendix), `/admin/record-types` with Explains.

- [ ] **Step 5: Commit** — `feat(web): exec summaries view, the Report's publish gate, summaries in downloads, incident record types`.

---

### Task T7 (follow-up, not scheduled): deferred items

The setup wizard's incident detection and preset (`web/src/features/import/setup/*`, `api/internal/records/guess.go` thresholds); `TemplatesPage` fields for `timeZone`, `unit` and `separator`; a Why link in `CellDrawer`; PDF link annotations. Depends on T1 and T6. Ports 8128/5228.

---

## Task table

| Task | Wave | Owns (summary) | Depends on | Ports (API/Web) |
|---|---|---|---|---|
| T1 | done (`61c1f41`) | records engine incident support, `rca/*` arithmetic | — | — |
| T1f | 0 (running) | `rca/**`, `records/incident*`, `records/cond*`, `domain/rca*`, `recordimport/plan_test.go`, `httpapi/records_test.go` | T1 | — |
| T2a′ | 1 | `openapi.yaml` + generated code (metric summaries, attribution, `Cell.summary`, `PublishBlocked`, no `rcas`), `domain/rca.go` (25 links, 16 KB), `rca/summary.go`, `httpapi/{rca,rca_basis,rca_stubs_read,rca_stubs_draft,summary_gate,mcp,server}.go` + tests, `assistant/tools.go` | T1f | 8121/5221 |
| T2c′ | 2 | `demo/seed.go`, `seed_test.go` (company-level summaries; written, stale, missing) | T2a′ | 8122/5222 |
| T4′ | 2 | `web/src/features/rca/*` (summary section, Show all, Paste links, admin-only editor), `api/queries.ts` (renamed hooks, `PublishBlockedError`), `test/{rcaFixtures,server}.ts` | T2a′ | 8124/5224 |
| T2b | 3 | `httpapi/{rca_explain,rca_view,rca_list,rca_budget_test}.go`, `rca_basis.go`, `summary_gate.go`, `view.go`; deletes `rca_stubs_read.go` | T2a′, T2c′ | 8123/5223 |
| T3 | 4 | `assistant/{summary_draft,links,runner,prompt}.go`, `domain/assistant.go`, `help/topics/rca.md`, `httpapi/{summary_draft,report_draft,assistant_threads,reports}.go`, the `revision` branch of `rca_list.go`/`rca_explain.go`, `report/snapshot.go`, draft stores; deletes `rca_stubs_draft.go` | T2b | 8125/5225 |
| T5 | 4 | TileFrame, MetricTile, ItemSummaryTile, AttentionCard, OverviewPage (plumbing) + test, StatusBoard, `logic/statusBoard`, ItemGrid, ItemDrillIn, ItemMonths, FocusDialog, useDialogShortcuts, `ui/status/{StatusCell,StatusCellTip,useGridNavigation}`, `test/viewFixtures.ts` | T4′, T2b | 8126/5226 |
| T6 | 5 | `features/rca/{ExecSummariesPage,summaryReminder}`, `App.tsx`, ControlBar, ReportPage (required block, gated Publish), `report/{model,ReportStatusList,pptx,pdf}`, `test/reportFixtures.ts`, `admin/{RecordTypesPage,adminModel}` | T3, T4′ (T5 for final screenshots) | 8127/5227 |
| T7 | later | wizard incident detection, TemplatesPage fields, CellDrawer Why link, PDF annotations | T1, T6 | 8128/5228 |

## Final pass

After T6: a full-branch review against the spec, `make dev` screenshots of every mockup's surface at 1440 and 390, `cd api && go test ./...` and the full web suite on `HEAD`, the size budgets re-run on the merged tree, and a manual run of the demo's Oct publish: blocked with three missing, then published after an admin writes them.
