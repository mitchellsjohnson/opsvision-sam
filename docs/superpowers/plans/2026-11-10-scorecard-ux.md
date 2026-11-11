# Scorecard UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scorecard's charts tab and scrolling table with an Overview, a windowed Table, and a monthly operating report, sharing one control bar, with click-to-full-screen and a draggable Overview layout.

**Architecture:** The view engine attaches a chart kind and a per-cell resolved status rule so the client never rejoins methodology versions. Layouts and published report snapshots are new store items; report files live in the objects store. The web app splits `/scorecards/:sc` into `overview`, `table`, and `report`, and keeps all shared controls in the URL. PPTX and PDF are built in the browser from the same report model the page renders.

**Tech Stack:** Go 1.27, existing OpenAPI codegen, React 19, Tailwind 4, Radix, Recharts 3.10.1. New, vetted: `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, `@dnd-kit/utilities` 3.2.2, `pdf-lib` 1.17.1, `pptxgenjs` 4.0.1.

**Spec:** `docs/superpowers/specs/2026-11-10-scorecard-ux-design.md` (extends `2026-10-30-opsvision-design.md`; this spec wins on views and replaces the monthly brief).

## Global Constraints

- No first-adopter company or product names, domains, account ids, or identity-provider client ids anywhere in the repo, including tests, fixtures, and comments. Example values only (`example.test`, fictional metric names already in the repo).
- Dependency pins are exact. Do not add, upgrade, or swap a library. The only new packages are the five above, installed in Task U9 (`@dnd-kit/*`) and Task U10 (`pdf-lib`, `pptxgenjs`). Vetted 2026-11-10: `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0, and `@dnd-kit/utilities` 3.2.2 are MIT, not malicious, policy compliant (CVSS < 7.0). `pdf-lib` 1.17.1 is MIT, trust 100, no vulnerabilities, policy compliant. `pptxgenjs` 4.0.1 is MIT, trust 99, policy compliant (CVSS < 7.0 passing). Its recommendation lists transitive CVE-2025-71329 and CVE-2025-71330 at 7.5 on every recent version, with `vulnerableMethods` empty; use 4.0.1 and do not look for a different library.
- After any OpenAPI edit, run `make gen` from the repo root and commit `api/internal/httpapi/gen.go` and `web/src/api/schema.d.ts` with the edit. `make gen-check` must pass.
- Charts use Recharts 3 only. No second chart library, no screenshot library.
- The Ask SAM control stays disabled, with accessible name "Ask SAM (coming soon)". Do not build SAM, the activity log, or an MCP server.
- Status is never color alone: a letter or shape goes with every status color. Use tokens in `web/src/ui/tokens.css` (accent `#5B4BDB`, ink `#1D2433`, cream `#FFF6E5`). Amber is only for restatement and attention chrome, never amber text on white.
- The document is the only scroll container on Overview, Table, and Report at widths that tests can express. Do not add `overflow-auto`, `overflow-x-auto`, or a fixed `max-height` around page content. Popovers, drawers, and dialogs may scroll.
- Required JSON arrays and maps are never null; use empty values.
- Writes that the spec calls audited go through `Server.audit`.
- Tests: `cd api && go test ./...` and `cd web && npm test`. A task is not done until the suites it names pass.

## Review Focus

1. A metric with no value at the selected scope, but with reported children, shows the worst child's status, labelled "worst of N segments" (or "services" / "items"), and health counts use that same status. Tests in U5 (`statusAtScope`) and U6.
2. A saved layout that names a removed metric and omits a new one drops the unknown id and appends the new metric at the end of its category. Test in U5 (`applyLayout`).
3. A second layout PUT with a stale `expectedRevision` returns 409 and leaves the first layout unchanged. Test in U2.
4. After publish, a later data change does not alter the published body; the response sets `dataRevised` and lists the change. `revision=live` shows the new value. Test in U3.
5. The table renders only as many period columns as `periodWindowSize` allows for its width, with no horizontal-scroll class. Test in U7. The controller checks `scrollWidth <= clientWidth` in a browser at 1280, 1440, and 1920 after U10.

---

### Task U1: Chart kind and the resolved rule on the view

**Files:**
- Modify: `openapi/openapi.yaml` (`Metric`, `Cell`, `ViewRow`)
- Modify: `api/internal/domain/methodology.go`, `api/internal/domain/validate.go`, `api/internal/engine/view.go`, `api/internal/engine/metric.go` (only if a helper must live next to band resolution), `api/internal/httpapi/view.go`
- Test: `api/internal/engine/chartkind_test.go`, extend `api/internal/engine/view_test.go`
- Generated: `api/internal/httpapi/gen.go`, `web/src/api/schema.d.ts`

**Interfaces:**
- Produces:
  - `domain.Metric.ChartKind string` `json:"chartKind,omitempty"`. Valid values: `ratio`, `money_plan`, `change`, `uptime`, `days`, `discrete`, `line`. Empty means automatic. Any other value fails methodology validation with a field error on `chartKind`.
  - `func ChartKind(m domain.Metric) string` in package `engine`. Order, first match: a valid `ChartKind`; else non-monthly frequency → `discrete`; else format `days0` → `days`; else rule type `change` → `change`; else format `percent2` and any `ReportedAt` kind `item_kind` → `uptime`; else `money_plan` when the rule is `bands` and `moneyPlanBands` is true; else a percent format with rule `bands` → `ratio`; else `line`.
  - `moneyPlanBands`: every non-empty `op` is `<`, `<=`, `>`, or `>=`, at least one upper bound and one lower bound, every threshold is in [50, 150], and at least one threshold is in [90, 110].
  - `func ResolveRule(rule domain.StatusRule, subjectID string) domain.StatusRule` — copy; if a `perSubject` entry matches `subjectID`, its bands replace `Bands` and `PerSubject` is nil.
  - `engine.Row` gains `Frequency string` and `ChartKind string`, taken from the metric the view already picks for row metadata (latest column's version).
  - `engine.Cell` gains `Rule domain.StatusRule`, the resolved rule of the version that computed that cell. Zero value when the cell has no version.
  - OpenAPI: `Metric.chartKind` optional string. `ViewRow.frequency` (required, ref `Frequency`) and `ViewRow.chartKind` (required string). `Cell.rule` optional, ref `StatusRule`, description: "The rule after per-subject bands are applied. Omitted when no methodology version applied."
- Consumes: existing `Compute`.

- [ ] **Step 1: Write failing tests** in `chartkind_test.go`: one case per kind in the order above, plus an invalid override falling through, plus `ResolveRule` swapping bands for the matching subject and leaving other subjects on the default bands. In `view_test.go`, a view whose latest column's metric is percent + bands exposes `ChartKind == "ratio"` and `Frequency` on the row, and a cell's `Rule.Bands` are the per-subject bands.
- [ ] **Step 2:** `cd api && go test ./internal/engine/ -count=1` fails on the new tests.
- [ ] **Step 3:** Implement the signatures above. Map the new fields in `apiCell` and the `ViewRow` builder in `view.go`. `make gen`.
- [ ] **Step 4:** `cd api && go test ./internal/engine/ ./internal/domain/ ./internal/httpapi/ -count=1` passes. `make gen-check` passes.
- [ ] **Step 5: Commit** `feat(api): chart kind and resolved rule on the scorecard view`.

### Task U2: Per-user layouts and the tenant default

**Files:**
- Modify: `openapi/openapi.yaml`, `api/internal/store/store.go`, `api/internal/store/memstore/` (the memory implementation and its contract suite), `api/internal/store/dynamostore/dynamostore.go`, `api/internal/httpapi/server.go` only if wiring is required
- Create: `api/internal/httpapi/layouts.go`, `api/internal/httpapi/layouts_test.go`
- Generated: `gen.go`, `schema.d.ts`

**Interfaces:**
- Produces store methods on a new `LayoutStore` embedded in `Store`:
  - `GetLayout(ctx, tenantID, userID, scorecardID) (domain.Layout, error)` — `ErrNotFound` when absent.
  - `PutLayout(ctx, tenantID, userID, scorecardID string, items []domain.LayoutItem, expectedRevision int) (domain.Layout, error)` — revision 0 creates revision 1; otherwise `expectedRevision` must match. Mismatch → `ErrConflict`. The returned layout has the new revision.
  - `GetDefaultLayout` / `PutDefaultLayout` — same, without `userID`.
- `domain.Layout` is `{Items []LayoutItem, Revision int}`. `LayoutItem` is `{ID string, Size string, Hidden bool}`. `Size` is `small` or `wide`.
- HTTP:
  - `GET /v1/me/layouts/{sc}` — caller's layout if present, else the tenant default, else `{items: [], revision: 0, source: "empty"}`. `source` is `user`, `default`, or `empty`. When `source` is `default`, `revision` is 0 (the next user PUT creates their layout). When `source` is `user`, `revision` is theirs.
  - `PUT /v1/me/layouts/{sc}` body `{items, expectedRevision}`. Any member. 409 `conflict` on a stale revision. Response is the stored layout plus `source: "user"`.
  - `PUT /v1/scorecards/{sc}/default-layout` — admin only. Same body and conflict behavior. Response `{items, revision, source: "default"}`.
- Validation 400 `invalid`: more than 200 items; duplicate ids; id not matching `^[a-z0-9][a-z0-9:_-]{0,80}$`; size other than `small` or `wide`.
- Dynamo keys, same partition as other tenant items: SK `LAYOUT#<userId>#<scorecardId>` and `LAYOUTDEFAULT#<scorecardId>`.
- Ids are opaque. The server does not check that they match current metrics.

- [ ] **Step 1: Failing tests.** Store contract (mem and the shared suite the dynamo store already runs): create, update, conflict, default is independent of a user's layout. HTTP: member PUT then GET; second PUT with the old revision is 409 and GET still returns the first; viewer PUT of the default layout is 403; admin PUT of the default is what a new user gets; over 200 items is 400.
- [ ] **Step 2:** `cd api && go test ./internal/store/ ./internal/httpapi/ -count=1 -run 'Layout'` fails.
- [ ] **Step 3:** Implement. `make gen`. Follow the revision style of `PutRecordType`.
- [ ] **Step 4:** Those packages pass. `make gen-check` passes.
- [ ] **Step 5: Commit** `feat(api): save scorecard layouts per user and as a tenant default`.

### Task U3: Report summary, publish, and history

**Files:**
- Modify: `openapi/openapi.yaml`, `store.go`, memstore, dynamostore
- Create: `api/internal/httpapi/reports.go`, `api/internal/httpapi/reports_test.go`, `api/internal/report/snapshot.go`, `api/internal/report/snapshot_test.go`
- Generated: `gen.go`, `schema.d.ts`

**Interfaces:**
- `report.Document` JSON stored as the snapshot: `period`, `generatedAt`, `summary` (string), `facts` ([]string), `versionIds` ([]string), `view` (the engine view, or the API view — use the API `ScorecardView` shape so the client can render it unchanged).
- Object key: `t/<tenantId>/reports/<scorecardId>/<period>/<revision>.json`, content type `application/json`.
- Store:
  - `GetReportSummary(ctx, tenantID, scorecardID, period) (domain.ReportSummary, error)` with `Text`, `Revision`, `UpdatedBy`, `UpdatedAt`. `ErrNotFound` when none.
  - `PutReportSummary(ctx, tenantID, scorecardID, period string, text, by string, expectedRevision int, at time.Time) (domain.ReportSummary, error)`. Text longer than 8000 chars is rejected by the handler (400), not the store. Conflict → `ErrConflict`.
  - `ListReportRevisions(ctx, tenantID, scorecardID) ([]domain.ReportRevision, error)` newest period first, then highest revision. `ReportRevision`: `Period`, `Revision`, `PublishedBy`, `PublishedAt`, `ObjectKey`.
  - `PutReportRevision` fails with `ErrConflict` if that revision number already exists.
- HTTP, month periods only (400 `invalid` otherwise):
  - `GET /v1/scorecards/{sc}/reports/{period}/summary` — members. Missing summary is `{text: "", revision: 0}` (not 404).
  - `PUT` the same — admin. Body `{text, expectedRevision}`. Audited action `report.summary`.
  - `GET /v1/scorecards/{sc}/reports` — one entry per month from 11 months before the latest of (current month, newest published month) through that latest month, capped at 36. Fields: `period`, `status` (`live` or `published`), `publishedAt`, `publishedBy`, `revision` (0 when live). This list does not compute drift.
  - `POST /v1/scorecards/{sc}/reports/{period}/publish` — admin. Body `{summary}` optional; when omitted, the stored summary is used. Computes the company-scope view for that month plus the five previous months and one YTD through that month (structure `as_of`, no restate). Stores the snapshot, revision = max+1. Response includes `revision`, `unlocked: true` (no month lock exists yet; the UI warns). Audited action `report.publish`.
  - `GET /v1/scorecards/{sc}/reports/{period}?revision=` — members. No query: latest published snapshot if any, otherwise live. `revision=live` always recomputes. A numeric revision returns that snapshot or 404. Live response: `live: true`, `revision: 0`, `dataRevised: false`, `changes: []`, plus `summary`, `facts`, `view`, `generatedAt`. Published response: `live: false`, the snapshot's view and summary, and `dataRevised` / `changes` from a fresh compute of the same columns. A change is `{metricKey, subjectId, period, was, now}` where `was` and `now` are the display strings (status letter appended when present, e.g. `94.5% G`). Compare value and status only.
- Facts, computed by `report.Facts(view, scale) []string` for the company row of the selected month: `"N metrics turned red: A, B"` when status rank becomes the worst; `"first green in K months: A"` when the best rank appears after K-1 worse months in the view window and K >= 2; `"not reported: A, B"` for rows with no value and no status. Use the tenant scale (higher rank is worse). Names are metric names. Omit a sentence whose N is 0.
- Summary text is company-scope. The GET document includes `summaryScope: "company"` always. The handler does not filter by the caller's scope query; scope is a client concern in this version. Viewers still only receive view rows their scope allows — apply the same row filter `GetScorecardView` uses when building a live view. A published snapshot is stored unfiltered and filtered the same way on read.
- Publishing does not require the month to be locked.

- [ ] **Step 1: Failing tests.** `Facts` for a turn-red, a first-green-in-3, a not-reported, and an all-green month that yields no "turned red". HTTP: admin PUT summary then member GET; viewer PUT is 403; stale revision is 409. Publish returns `unlocked: true` and revision 1; second publish is revision 2 and both still list. After publish, change a data point: GET without revision has `dataRevised: true` and the old display in `view`; `?revision=live` has the new display and `dataRevised: false`. A non-month period is 400.
- [ ] **Step 2:** targeted `go test` fails.
- [ ] **Step 3:** Implement. `make gen`. Reuse `GetScorecardView`'s input assembly rather than copying the rollup.
- [ ] **Step 4:** `cd api && go test ./internal/report/ ./internal/httpapi/ ./internal/store/ -count=1` passes. `make gen-check` passes.
- [ ] **Step 5: Commit** `feat(api): publish monthly operating reports`.

### Task U4: Routes, shell grid, and the control bar

**Files:**
- Modify: `web/src/App.tsx`, `web/src/shell/AppShell.tsx`, `web/src/shell/usePeriodState.ts`, `web/src/shell/AppShell.test.tsx`
- Create: `web/src/features/scorecard/ScorecardFrame.tsx`, `web/src/features/scorecard/ControlBar.tsx`, `web/src/features/scorecard/ControlBar.test.tsx`
- Modify: `web/src/features/scorecard/ScorecardPage.tsx` so `/scorecards/:sc` redirects

**Interfaces:**
- Routes, nested under the existing shell: `/scorecards/:sc/overview`, `/scorecards/:sc/table`, `/scorecards/:sc/report`. `/scorecards/:sc` redirects to `overview`, preserving the query. `tab=table` redirects to the table route; `tab=charts` or any other `tab` redirects to overview; `tab` is removed.
- `usePeriodState` also reads and writes `scope` (one id, absent = company), `restate` (version id), and `structure` (`as_of` default, or `current`). Add those keys to `VIEW_PARAMS`. Do not change the entry page's `subject` params.
- `ScorecardFrame` renders the control bar and an `<Outlet />`. Pages are placeholders with an `<h1>` ("Overview", "Table", "Report") until later tasks.
- Control bar, sticky, one row that wraps: links Overview / Table / Report (the current one is `aria-current="page"`); a Period button showing the existing period label; Scope button; a "As reported" button; Ask SAM disabled. Period popover sets grain by rewriting `period` (month `YYYY-Mmm`, quarter `YYYY-Qn`, half `YYYY-Hn`, year `YYYY`), the fiscal year, and the YTD toggle (`ytd=1`). Scope popover lists the company and org units from the existing org query, with a text filter. View-options popover sets `structure` and `restate` (versions from the existing methodology query). When `restate` is set, an amber chip reads `Restated under <version name>`.
- Shell: the page under the header is `grid` with `minmax(0, 1fr)`. Nav is `w-60` at `min-[1440px]` and `w-16` below that. No right dock yet (Task U8 adds it). Main content has `min-w-0`.
- Keep the upload-records control on the frame.

- [ ] **Step 1: Failing tests.** Redirect from `/scorecards/sc-main?tab=table&period=2026-M09` lands on `/scorecards/sc-main/table?period=2026-M09`. Control bar: choosing quarter rewrites the period; choosing a version shows the chip; Ask SAM is disabled with that accessible name. App shell nav has the icon-rail width class below 1440 (assert the class, jsdom has no layout).
- [ ] **Step 2:** `cd web && npx vitest run src/features/scorecard/ControlBar.test.tsx src/shell/AppShell.test.tsx` fails.
- [ ] **Step 3:** Implement. Existing charts/table components may stay mounted only if a route still imports them; the new routes must not render the old tab strip.
- [ ] **Step 4:** `cd web && npm test` passes.
- [ ] **Step 5: Commit** `feat(web): scorecard routes and shared control bar`.

### Task U5: Status, attention, window, facts, and layout merge

**Files:**
- Create: `web/src/features/scorecard/logic/statusAtScope.ts`, `logic/needsAttention.ts`, `logic/window.ts`, `logic/layout.ts`, and `logic/logic.test.ts`
- The report facts already exist in Go. This task's facts helper is only the labels the Overview needs; do not reimplement publish.

**Interfaces:**
- `statusAtScope({ scope, children, columnKey, scale, noun })`. A cell is reported when `value != null` or (`status` is non-empty and `naReason` is empty). If `scope` is reported, return `{status, caption: ""}`. Else among reported children, the status with the worst rank (highest rank number). Caption `worst of ${n} ${noun}` with noun `segments`, `services`, or `items`. If none reported, `{status: "", caption: ""}`.
- `needsAttention(items, scale)`, at most 3. `items` are `{metricKey, name, categoryOrder, status, value, change, direction, rule, priorStatus}` for one column. Order: worst rank, by `distancePastWorst` descending, then category order; then statuses that worsened by at least one rank, by ranks lost descending, then distance, then category order; then middle ranks (neither best nor worst), by category order. `distancePastWorst`: for bands, the worst-rank band's threshold (the else band uses the nearest better band's value); width is the gap to the next threshold or 10; distance is how far the value sits on the bad side of that threshold, divided by the width. Higher-better is bad below the threshold; lower-better is bad above. For a change rule, distance is `Math.abs(change)` and width is 1. Missing inputs yield distance 0.
- `periodWindowSize(contentWidthPx: number): number`. `<= 720 → 3`, `<= 960 → 6`, `<= 1280 → 9`, else `12`. `windowStart(columnCount, visible, selectedIndex)` clamps so the window ends at `selectedIndex` unless that would pass the last column.
- `defaultLayout(categories, metricsByCategory)` order: `widget:health` wide, `widget:ribbon` wide, `widget:needs` wide, then each category as `section:<id>` wide followed by `metric:<key>` small, then `widget:unreported` wide. Nothing hidden.
- `applyLayout(fallback, saved)`: keep saved items whose id is in the fallback, in saved order; append fallback items that are missing, a new metric directly after the last item of its `section:<categoryId>` (or after that section marker).

- [ ] **Step 1: Failing tests** covering Review Focus 1 and 2, plus: three off-track metrics keep only the two furthest past the threshold and the next by category order is dropped at the cap of 3; a worsened watch metric ranks above a stable watch metric; `periodWindowSize(960) === 6` and `periodWindowSize(1700) === 12`; the window ending at the selected month does not include later months.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. **Step 4:** `npm test` passes.
- [ ] **Step 5: Commit** `feat(web): scorecard status, attention, and layout rules`.

### Task U6: Overview page and the chart kinds

**Files:**
- Create: `web/src/features/scorecard/OverviewPage.tsx`, `OverviewPage.test.tsx`, `charts/MetricChart.tsx`, `charts/chartTheme.ts`
- Modify: the overview route in `App.tsx` / `ScorecardFrame` to render `OverviewPage`
- Reuse: `groupRows`, `format.ts`, `StatusBadge`, the view query in `api/queries.ts`. Extend the query only if the period list has to change.

**Interfaces:**
- One view request for the trend window ending at the selected period: 12 months, or 8 quarters, 4 halves, 3 years. A second request for YTD when `ytd=1`, shown as a secondary figure on each card ("YTD 94%") and not as a point on the monthly line.
- `chartTheme` maps a status key to letter, shape (G `●`, Y `▲`, R `◆`; any other key is a neutral `●`), and the tenant color. Contrast: if the tenant color on white is below 4.5:1, the letter is ink.
- `MetricChart` switches on the row's `chartKind`, then applies the sparse override: when the kind is not `discrete` and the window has at least 4 columns and not-applicable cells outnumber valued cells, render lettered chips instead of a line.
- Every chart: a visually hidden summary (`<p className="sr-only">`) naming the metric, the current display value, and the status letter; a "View as table" control that navigates to the table route with the same query; tooltip content reachable by keyboard (a button per point is enough); missing as a gap, not applicable as the text `n/a` (not the same glyph as a gap); an override as `†` plus the reason in the tooltip. Bands are tinted rects at about 10% opacity with a 1px edge. The goal is a dashed line labelled with the target. The current point is labelled with value and letter. `prefers-reduced-motion`: no animation (Recharts `isAnimationActive={false}` when the media query matches).
- Uptime in the card is one row per child subject: letter squares and the current value. Days draws the target as the limit. Money-plan is a bar chart with a reference line at 100. Discrete is columns for the periods in the window, not a 12-month line.
- Page, top to bottom: header sentence (`September 2026 · year to date through September · All of <company>` when those controls say so); health counts button group; 12-month (or N-period) status widget; needs-attention section (up to 3 cards, each with a driver line naming the worst child); category sections in methodology order with status counts in the heading; a single not-reported line listing names and, for a non-monthly metric, its next due period, plus "Enter data" linking to `/entry` only when `me.role` is admin or contributor.
- Health buttons set `health=<statusKey>` in the query and the page hides metric cards whose scope status differs. The active filter is a chip with a clear control.
- When the scope cell is absent and children have values, the card says `Company total not reported; N segments reported` (use the noun from U5) and charts the children.
- Cards are not draggable in this task. Each card has an Expand button that sets `?focus=<id>` but the dialog is Task U8; until then the button only updates the query.

- [ ] **Step 1: Failing tests** using the existing view fixture handlers. A ratio metric renders its summary with the status letter. A metric with no company value and two children renders `worst of 2 segments` and the health count includes it in that status. Clicking Off track leaves only off-track cards. Not-applicable and missing are different text. YTD on shows the secondary figure.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. **Step 4:** `npm test` passes.
- [ ] **Step 5: Commit** `feat(web): scorecard overview and chart kinds`.

### Task U7: Windowed table

**Files:**
- Create: `web/src/features/scorecard/TablePage.tsx`, `TablePage.test.tsx`
- Reuse: `CellDrawer.tsx`, `columns.ts` (extend, don't fork), `format.ts`. The table route renders `TablePage`. `TableTab.tsx` may be deleted once `TablePage` covers the drawer and category rows; move any still-true tests.

**Interfaces:**
- `table-layout: fixed; width: 100%`. Metric column class `w-[clamp(13rem,24%,18rem)]`. No `overflow-x-auto`.
- Period headers are the window from U5 ending at the selected period. YTD, when on, is the last column and stays when the window moves. Earlier / Later buttons are disabled at the ends. The selected period header has a top border in accent.
- Cells: tabular nums, status letter chip, `n/a` chip whose accessible name is the reason. A collapsed subject row shows `4 segments · 1G 2Y 1R`. Toolbar: Expand all, Collapse all, Only off track, Earlier, Later, Expand (sets `?focus=table`).
- Overrides: `†` in the cell. Identical reasons become one note `12 values as reported in the legacy workbook` with a button `show cells`.
- A metric with no valued cell in the window is one row: `No data in this range` and, for an editor, `Enter data`.
- The header row is `sticky top-<control bar height>` (use a CSS variable the frame sets). Category rows stick below it.
- The grid has `role="grid"`. One tab stop; arrow keys move a roving `tabIndex={0}`. Enter opens the drawer. Other cells are `tabIndex={-1}`.
- Below 768 px (a class hook is enough: the page renders a card list instead of the table when the caller passes `compact`, and the test renders `compact`): one card per metric, the current value, and six status letters. No horizontal scroll.

- [ ] **Step 1: Failing tests.** At a stubbed content width of 960 the table has 6 period headers and no `overflow-x-auto`. Later is disabled on the last month. `n/a` exposes its reason as the accessible name. Enter on a focused cell opens the drawer. Twelve identical override reasons render as one note. With `compact`, the grid is absent and six status letters render on the metric card.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. Measure width with a ref defaulting to 960 when it is 0 (jsdom). **Step 4:** `npm test` passes.
- [ ] **Step 5: Commit** `feat(web): windowed scorecard table`.

### Task U8: Full screen

**Files:**
- Create: `web/src/features/scorecard/FocusDialog.tsx`, `FocusDialog.test.tsx`
- Modify: `AppShell.tsx` to reserve a right dock column (`w-0` by default; `w-96` when the drawer or, later, SAM is open — the cell drawer moves into that column on Overview and Table, replacing the dock)

**Interfaces:**
- `?focus=<id>` opens a Radix dialog (`@radix-ui/react-dialog` is already a dependency) that traps focus. Esc and Close clear `focus` and return focus to the control that set it. `focus=table` renders `TablePage` with `periodWindowSize` large enough to show every period column that fits a full-viewport width (pass 1600). Any other id renders that metric's `MetricChart` larger, with a 12/24 toggle (24 requests a longer window), the ranked children as a list of buttons (worst first) that set `scope` to that child, "View as table", and Previous / Next cycling metric ids in layout order.
- Export PNG, SVG, and CSV, plus Present, are buttons. CSV downloads the metric's rows for the window (value, status, period). SVG is a document built from the values (polyline, status letters, title) with no new library. PNG draws that SVG into an `HTMLCanvasElement` and downloads `image/png`. Present calls `element.requestFullscreen` on the dialog content when the API exists.
- Copy link copies `location.href`.
- Clicking empty card space on Overview also sets `focus`. Clicks on links, buttons, and chart points do not.

- [ ] **Step 1: Failing tests.** Setting `focus` shows the dialog named with the metric. Esc removes it. Next moves to the following metric. A point button's click does not open the dialog when the test clicks the point rather than the card.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. **Step 4:** `npm test` passes.
- [ ] **Step 5: Commit** `feat(web): full-screen scorecard charts and table`.

### Task U9: Draggable overview layout

**Files:**
- Modify: `web/package.json`, `web/package-lock.json` (exact versions only)
- Create: `web/src/features/scorecard/LayoutGrid.tsx`, `LayoutGrid.test.tsx`
- Modify: `web/src/api/queries.ts` (layout query and mutation), `OverviewPage.tsx`

**Interfaces:**
- Install exactly `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `@dnd-kit/utilities@3.2.2`. No other new packages.
- `LayoutGrid` renders `applyLayout(defaultLayout(...), saved)`. Widgets, `section:*` markers, and metric cards are sortable, so a section moves as a block with the metric ids that follow it until the next section, and a metric can sit under a different section (the card still shows its own category name). Needs attention is the `widget:needs` item from U5: it stays pinned first even if the saved order puts it elsewhere, and hiding it sets `hidden`. A card menu offers Small, Wide, Hide, Move up, Move down, Move to top. Hidden cards disappear and a `Hidden (n)` button restores the list one at a time in saved order.
- Keyboard: dnd-kit `KeyboardSensor`. The handle's accessible name is `Drag <card name>`.
- Pointer drag is disabled when `window.matchMedia('(max-width: 767px)').matches`. Order and hidden still apply. In tests, mock that media query.
- PUT on drop and on menu actions, sending `expectedRevision` from the GET. On 409, refetch and do not retry blindly. "Reset layout" PUTs the default items. Admins see "Save as default", which PUTs the default-layout endpoint.
- A new metric not in the saved layout appears at the end of its category (U5). The test uses a saved layout missing one metric and naming one unknown id.

- [ ] **Step 1: Failing test.** Keyboard is not required to drag in jsdom; call the menu Move down and assert the PUT body order and that the headings render in that order. Hidden (1) restores a card. An unknown saved id is not rendered; a metric absent from the save still renders.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. **Step 4:** `npm test` passes. `npm run typecheck` passes.
- [ ] **Step 5: Commit** `feat(web): drag to rearrange the scorecard overview`.

### Task U10: Monthly report preview, PPTX, and PDF

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`
- Create: `web/src/features/scorecard/report/model.ts`, `report/model.test.ts`, `report/pptx.ts`, `report/pdf.ts`, `report/export.test.ts`, `ReportPage.tsx`, `ReportPage.test.tsx`
- The report route renders `ReportPage`.

**Interfaces:**
- Install exactly `pdf-lib@1.17.1` and `pptxgenjs@4.0.1`.
- The page reads `GET /v1/scorecards/{sc}/reports/{period}` and the month list. Query `revision=live` when the user clicks "View live". The period comes from the control bar and must be a month; on quarter, half, or year the report controls except the view switch are disabled and the page says `The monthly report is available on a month.`
- Header states: `Month to date, as of <today>` for the current month live; `Published on <date> by <name>` when a snapshot is showing; a banner `Data revised since publication` with a link that sets `revision=live` when `dataRevised` is true.
- Summary: an admin textarea saved with the summary PUT (expected revision). At a non-company `scope`, do not show the textarea or the summary text; show `Summary is written for <company name>` linking to the same URL without `scope`.
- Sections, in order, matching the document: cover facts (health counts, facts sentences), needs attention (same three as U5, from the document view), one block per category with value, status, change, YTD, and goal, the six-column table (the month, five before, YTD) at the selected scope, notes (grouped overrides, n/a reasons, not reported, methodology version ids). A checkbox `Use my layout` (default off) hides metrics the user hid and reorders categories to the saved layout.
- Publish button (admin) calls the publish endpoint and then refetches. It is enabled with the visible warning `This month is not locked.`
- `buildPptx(doc): Promise<Uint8Array>` — 16:9. Cover slide, summary slide, one slide per needs-attention metric, one slide per remaining metric, table slides that split after 12 metric rows, a notes slide. Titles are the metric names. Line and bar kinds use `pptxgenjs` native charts. Uptime, sparse, and band backgrounds are a table of period, value, and status letter (not an image). Each slide's notes contain the metric definition when the view row has one (pass it through; if the API view row has no definition field, put the metric name and the version id). Speaker notes always include the version id.
- `buildPdf(doc): Promise<Uint8Array>` — US Letter landscape. `PDFDocument` title is `<scorecard> · <month>`. Real text for every title and value. Charts are vector polylines plus the status letter, not images. Page count is at least 4 for a fixture with a cover, a summary, one metric, and notes.
- The in-app page is the accessible version: headings in order, the table with headers.

- [ ] **Step 1: Failing tests.** Model: a non-company scope flag suppresses the summary text. Export: PPTX bytes start with `PK` and a slide XML contains the fixture metric name and `Needs attention`; PDF loads with `pdf-lib`, page count >= 4, title equals the fixture title. Page: the revised banner's link requests `revision=live`. The quarter grain shows the disabled sentence and does not call publish.
- [ ] **Step 2:** vitest fails. **Step 3:** Implement. **Step 4:** `npm test` and `npm run typecheck` pass.
- [ ] **Step 5: Commit** `feat(web): monthly operating report as PPTX and PDF`.

## Self-review

- Spec §3 routes, control bar, shell, mobile: U4 (routes, bar, rail), U9 (drag off under 768). Mobile sheets for nav are the existing shell's job only where it already collapses; U4's rail is the required collapse. A full mobile sheet rewrite is out of scope beyond the rail and the one-column note in U6 (Overview uses a single column class `grid-cols-1` below `md`).
- §4 Overview and worst-of-N: U5, U6. Grains: U6 window lengths. Report stays monthly: U10.
- §5 chart kinds and encoding: U1 (kind), U6 (rendering). Sparse threshold: U6 (N/A outnumber values, at least 4 columns).
- §6 table: U7. §7 full screen: U8. §8 drag and endpoints: U2, U9. §9 report: U3, U10.
- §10 type scale is applied in U6/U7/U10 via the existing Tailwind type utilities (`text-[40px] font-semibold` for the hero, `text-[28px] font-semibold` for card values, `text-sm` for titles). Do not add a new font.
- §11 and §12: axe is already in the web test setup; each new page test calls `expect(await axe(container)).toHaveNoViolations()` the way existing page tests do. Lazy rendering and the 1.5 s budget are not unit-tested; the controller checks them in the browser after U10.
