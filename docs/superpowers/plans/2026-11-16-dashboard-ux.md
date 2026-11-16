# Dashboard and Expanded-Mode UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every Overview widget and every expanded (full-screen) view up to the approved status board and line chart: an item grid for uptime, coarse metrics at their own grain counted once, one dialog chrome, a Customize layout mode, and redesigned Health, Needs attention and chart kinds.

**Architecture:** Client-only (`web/`); no API changes. Pure logic first in `features/scorecard/logic/*` with unit tests, then components that consume it. `MetricChart.tsx` is split into one file per chart kind before any chart changes, and status primitives are extracted from `StatusBoard.tsx`, so parallel tasks own disjoint files.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind 4 (tokens in `web/src/ui/tokens.css`), Radix (Dialog, DropdownMenu, Tooltip), Recharts 3, lucide-react, TanStack Query, react-router 7; Vitest 5, Testing Library, `vitest-axe`, MSW.

**Spec:** `docs/superpowers/specs/2026-11-16-dashboard-ux-design.md` (section numbers below are the spec's). Mockups: `.superpowers/sdd/2026-11-16-dashboard-ux/mockups/` (local).

## Global Constraints

- No new dependencies (no edits to `web/package.json` or the lockfile).
- No company, product or customer names in code, copy, tests, fixtures or commits; demo names only.
- Colors only from `web/src/ui/tokens.css` and existing helpers (`chartTheme`, `statusFill`, `LINE_COLORS`); all text at `ink/70` or stronger; `ink/55` for non-text only.
- Status is never shown by color alone: chips carry shape + letter, cells carry a letter (or are decorative inside a control whose name states the status).
- The document is the only scroll container on a page; a dialog body may scroll vertically; no horizontal scroll at 320–1920 px.
- Exports (PNG, SVG, CSV) keep working for every chart kind.
- Existing behavior is preserved unless the spec changes it; existing tests keep passing or change only where the spec changes the behavior they assert.
- Type scale 11/12/14/16/20/28 only (§3.1); spacing on the 4px grid.
- No request above the API limits: 24 periods, 2 YTD columns, 200 subjects, 200 metrics.
- Every new Recharts chart: `isAnimationActive={!reduced}`.
- Every task ends with: `npm --prefix web test` (all pass; name the count), `npm --prefix web run typecheck` (exit 0), `npm --prefix web run lint` (0 errors), and screenshots against `make dev` at 360, 390 and 1440 px of what it touched, saved as `.superpowers/sdd/2026-11-16-dashboard-ux/build/task-N/<widget>-<mode>-<width>.png`, each with `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Stop `make dev` afterwards.
- Stage only the task's files; commit with the message given.

## Review Focus

1. **Narrow widths with long names and many items** (320–360 px, 24 services, names like "Analytics Ingest Worker"): no horizontal overflow, names clamp to two lines, stacked mode kicks in. Pinned by Task 4 (`ItemGrid` at a 272px container) and Task 6 (`ItemSummaryTile` at a 300px container).
2. **Tenants with a custom status scale** (two or four levels, labels like "On track / Watch / Off track"): every count, headline and reason uses the tenant's labels; "best" is rank-minimum, "worst" rank-maximum. Pinned by Task 6 (`HealthSummary` with a four-level scale) and Task 4 (headline uses the best label).
3. **Restated views and mid-window methodology changes** (`?restate=v2026`, versions changing in July): definition and threshold text come from the version in force for the selected period; no methodology markers when restated; coarse grains come from the version in force. Pinned by Task 2 (definition line from `Cell.versionId`), Task 3 (coarse grains from the version in force) and Task 8 (`useVersionMarkers` returns `[]` when restated).
4. **Metrics with no data, all n/a, or an n/a scope in the selected period**: each metric is counted exactly once in Health; n/a scopes list their reason in Not reported. Pinned by Task 3 (`periodStatus` table test) and Task 5 (`NotReportedCard` n/a row).
5. **Stale or hand-edited URLs** (`item` of an item not in view, `sort=bogus`, `focus` of a hidden metric): the dialog falls back (grid without drill-in, Worst now sort) and cleans the URL with `replace`. Pinned by Task 4.

---

## File structure

| File | Responsibility | Owner task |
|---|---|---|
| `web/src/features/scorecard/charts/chartParts.tsx` | Shared chart parts moved out of `MetricChart.tsx` (size spec, ticks, hover card, pills, ribbon, point controls, axis helpers) | 0, then 7, then 8 |
| `charts/RatioChart.tsx`, `charts/BarsChart.tsx`, `charts/UptimeRows.tsx`, `charts/LetteredChips.tsx` | One chart kind each (moved verbatim) | 0; 7 (Ratio points, Bars → MoneyPlan, Lettered → Sparse); 8 (Ratio markers/geometry, delete Uptime/Lettered) |
| `charts/MetricChart.tsx` | Header + dispatch by kind; re-exports public names | 0, 7, 8 |
| `charts/MoneyPlanChart.tsx`, `charts/SparseRibbon.tsx` | New kinds | 7 |
| `charts/MultiSeries.tsx`, `charts/versionMarkers.ts` | Direct labels, small multiples; methodology markers | 8 |
| `charts/chartTheme.ts`, `exports.ts` | `barFill`; money-plan SVG | 7 |
| `charts/ranges.ts` | Change-rule range terms | 8 |
| `web/src/ui/status/*` | `StatusChip`, `StatusCell`, `Legend`, `StatusCellTip`, `RollUp`, `useGridNavigation` | 1 |
| `logic/statusText.ts`, `logic/nouns.ts`, `logic/drivers.ts`, `useNouns.ts` | Copy, nouns, worst child | 1 |
| `StatusBoard.tsx` | Board | 1 (imports), 3 (`notDue`, caption), 5 (phone clamp, scroll margin) |
| `FocusDialog.tsx`, `FocusHeader.tsx`, `MoreMenu.tsx`, `DefinitionLine.tsx`, `RangeStrip.tsx`, `Breakdown.tsx`, `useDialogShortcuts.ts`, `focusBody.ts` | Dialog chrome | 2 (all), then 4 (`FocusDialog.tsx`) |
| `columns.ts`, `viewRequest.ts`, `viewHelpers.ts`, `focusRequest.ts`, `logic/coarse.ts`, `logic/statusBoard.ts`, `logic/statusAtScope.ts` | Coarse periods and counting | 3 |
| `logic/itemGrid.ts`, `logic/itemGridLayout.ts`, `ItemGrid.tsx`, `ItemDrillIn.tsx`, `itemExports.ts` | Item metrics in the dialog | 4 |
| `LayoutGrid.tsx`, `CustomizeBar.tsx`, `SectionHeader.tsx`, `TileFrame.tsx`, `NotReportedCard.tsx`, `ControlBar.tsx` | Overview frame | 5 |
| `OverviewPage.tsx` | Overview | 3 (counting), 5 (frame), 6 (top widgets) |
| `HealthSummary.tsx`, `AttentionCard.tsx`, `ItemSummaryTile.tsx`, `logic/needsAttention.ts` | Overview top and uptime tile | 6 |

All paths are under `web/src/features/scorecard/` unless they start with `web/src/ui/`. Tests sit beside their files (`X.test.ts[x]`).

## Dependencies

```
0 ─┐                 ┌─ 4 ─┐
1 ─┼─ 2 ─────────────┤     ├─ 6 ─┐
   └─ 3 ─────────────┴─ 5 ─┤     ├─ 8
0 ──────────────────────── 7 ────┘
```

- 0 and 1 have no dependencies and run in parallel.
- 2 depends on 1. 3 depends on 1. 2 and 3 run in parallel (2 owns the dialog files, 3 owns request, column and board-logic files and `OverviewPage.tsx` counting).
- 4 depends on 1, 2, 3 (it owns `FocusDialog.tsx` after 2 and wires 3's `focusWindow`). 5 depends on 1, 3. 4 and 5 run in parallel.
- 6 depends on 4 (`itemGrid.ts`, `itemGridLayout.ts`) and 5. 7 depends on 0, 3, 5. 6 and 7 run in parallel (6 owns `OverviewPage.tsx` top widgets; 7 owns chart files).
- 8 depends on 0, 5, 6, 7 (it deletes `UptimeRows` after 6 stops using it, and edits chart files after 7).

---

### Task 0: Split `MetricChart.tsx` into one file per chart kind

Size S. No behavior change.

**Files:**
- Create: `charts/chartParts.tsx`, `charts/RatioChart.tsx`, `charts/BarsChart.tsx`, `charts/UptimeRows.tsx`, `charts/LetteredChips.tsx`
- Modify: `charts/MetricChart.tsx` (keep `MetricChart`, `FOCUS_CHART_HEIGHT`, `ChartSize`; re-export `ChartHoverCard`, `ChartSeries`, `ChartHoverCardProps`, `buildPoints`, `ChartPoint`)
- Test: `charts/MetricChart.test.tsx` (unchanged)

**Interfaces:**
- Consumes: nothing new.
- Produces: `chartParts.tsx` exports `sizeSpec(size: ChartSize, tileHeight: number): SizeSpec`, `tickStyle`, `valueAxis(format, domain, extra?)`, `yDomain`, `barDomain`, `StatusMarker`, `ChangeLabel`, `ChartHoverCard`, `hoverTooltip`, `Hairline`, `CurrentDot`, `ActiveDot`, `BandRect`, `BandPill`, `GuidePill`, `AxisPill`, `StatusRibbon`, `PointButtons`, `PointSummary`, `PointControls`, `pointLabel`, constants `ACCENT`, `TICK_OPACITY`, `ANIMATION`, `GUIDE`, `BAND_PILL`. Kind files export `RatioChart`, `BarsChart`, `UptimeRows`, `LetteredChips` with today's props.

- [ ] **Step 1: Record the baseline.** Run `npm --prefix web test -- MetricChart` and note the passing count.
- [ ] **Step 2: Move code verbatim** into the new files (cut and paste; only imports change). `MetricChart.tsx` keeps the header and the `kind` dispatch.
- [ ] **Step 3: Verify the split.** Run `npm --prefix web test -- MetricChart` → same count, all pass. Run `wc -l web/src/features/scorecard/charts/*.tsx` → every file under 450 lines. Run `rg -n "from './charts/MetricChart'|from '../charts/MetricChart'" web/src` → importers unchanged and still compiling.
- [ ] **Step 4: Full verification** (Global Constraints). Screenshots: `ratio-tile`, `money-plan-tile`, `uptime-focus` at 360/390/1440 must match the audit screenshots pixel-for-pixel in layout.
- [ ] **Step 5: Commit.** `git commit -m "refactor(web): split MetricChart into one file per chart kind"`

### Task 1: Status primitives, copy, nouns, drivers

Size M.

**Files:**
- Create: `web/src/ui/status/StatusChip.tsx`, `StatusCell.tsx`, `Legend.tsx`, `StatusCellTip.tsx`, `RollUp.tsx`, `useGridNavigation.ts`, `index.ts`; `logic/statusText.ts`, `logic/nouns.ts`, `logic/drivers.ts`, `useNouns.ts`
- Modify: `StatusBoard.tsx` (import the moved parts; same DOM), `FocusDialog.tsx` (`rankedChildren` → `worstChildren`)
- Test: `web/src/ui/status/useGridNavigation.test.tsx`, `logic/statusText.test.ts`, `logic/nouns.test.ts`, `logic/drivers.test.ts`; `StatusBoard.test.tsx` unchanged

**Interfaces:**
- Produces:
  - `StatusChip({ status, scale, size = 'md' }: { status: string; scale: StatusLevel[]; size?: 'md' | 'lg' })` — `md` is today's 28×16 chip; `lg` is 20px tall, 12px letter.
  - `StatusCell(props: { cell: BoardCell; name: string; scale: StatusLevel[]; size?: 'md' | 'sm' | 'xs'; decorative?: boolean; tip?: ReactNode; grid?: GridCellProps; onOpen?: (el: HTMLElement) => void })` — `md` 24px button (board), `sm` 18px, `xs` 14px; `decorative` renders a `span aria-hidden` with no handlers.
  - `Legend({ scale, unrated }: { scale: StatusLevel[]; unrated: boolean })`, `StatusCellTip` (today's props), `RollUp({ rows, scale })` (today's).
  - `useGridNavigation(opts: { rowIds: string[]; colCount: number; anchor: 'start' | 'end'; pageSize?: number; onOpen: (rowId: string, col: number, el: HTMLElement) => void }): { active: { rowId: string; col: number }; cellProps: (rowId: string, col: number) => GridCellProps; focusRow: (rowId: string, col?: number) => void }` with `GridCellProps = { tabIndex: 0 | -1; 'data-pos': string; onKeyDown: KeyboardEventHandler; onFocus: FocusEventHandler; ref: RefCallback<HTMLElement> }`. `anchor: 'end'` keeps the column counted back from the selected period when `colCount` changes (the board's `back`). Keys: arrows, Home (first period), End (selected period), PageUp/PageDown (`pageSize`, default 10), Enter/Space → `onOpen`.
  - `thresholdText(rule: StatusRule, opts: { format: string; direction: Direction; chartKind: string; frequency: Frequency; statusLabel: (key: string) => string | undefined; perSubject?: { name: string; value: number }[]; noun?: NounForms; surface: 'tile' | 'focus' }): string` (§3.5).
  - `sinceText(cells: BoardCell[], index: number, columns: Column[], statusLabel: (key: string) => string | undefined): string` (§3.6).
  - `nounForms(name: string | undefined, fallback: 'item' | 'unit'): NounForms` with `NounForms = { one: string; many: string }` (§3.8); `countNoun(n: number, forms: NounForms): string` → `1 service` / `3 services`.
  - `worstChildren(children: ViewRow[], columnKey: string, scale: StatusScaleEntry[], direction: Direction): { ranked: { row: ViewRow; cell: Cell; rank: number }[]; worst: { row: ViewRow; cell: Cell } | null; worstCount: number; total: number }` — reported children only, worst first (rank, then worse value by direction, then name).
  - `useItemNoun(metric: Metric | undefined): NounForms`; `useLevelNoun(depth: number): NounForms`.

- [ ] **Step 1: Write failing tests for `statusText.ts`.**

```ts
const label = (k: string) => ({ G: 'Green', Y: 'Yellow', R: 'Red' })[k]
it('bands higher better', () => {
  expect(thresholdText(bands([['G', '>=', 90], ['Y', '>=', 80], ['R', '', 0]]), base({ format: 'percent0', direction: 'higher_better', chartKind: 'ratio' }))).toBe('Green at 90% or better · Red below 80%')
})
it('lower better score', () => expect(thresholdText(lower(450, 600), base({ format: 'number0', direction: 'lower_better', chartKind: 'line' }))).toBe('Lower is better · Yellow above 450 · Red above 600'))
it('days', () => expect(thresholdText(lower(14, 17), base({ format: 'days0', direction: 'lower_better', chartKind: 'days' }))).toBe('Fewer days is better · Green at 14 days or fewer · Red above 17 days'))
it('money plan', () => expect(thresholdText(lower(110, 120), base({ format: 'percent0', direction: 'lower_better', chartKind: 'money_plan' }))).toBe('Under plan is fine · Yellow above 110% · Red above 120%'))
it('change rule tile and focus', () => {
  expect(thresholdText(change(0, -5), base({ chartKind: 'change', direction: 'lower_better', surface: 'tile' }))).toBe('Lower is better · judged on change vs the prior month')
  expect(thresholdText(change(0, -5), base({ chartKind: 'change', direction: 'lower_better', surface: 'focus' }))).toBe('Lower is better · judged on change vs the prior month · Green: any improvement · Yellow: up to 5% worse · Red: more than 5% worse')
})
it('per-subject bands', () => {
  const o = base({ format: 'percent2', chartKind: 'uptime', perSubject: [{ name: 'Status Page', value: 99.5 }], noun: { one: 'service', many: 'services' } })
  expect(thresholdText(uptimeBands, { ...o, surface: 'tile' })).toBe('Green at 99.90% or better · 1 service has its own target')
  expect(thresholdText(uptimeBands, { ...o, surface: 'focus' })).toBe('Green at 99.90% or better; Status Page is held to 99.50%')
})
it('coarse prefix', () => expect(thresholdText(b90_80, base({ frequency: 'quarterly' }))).toMatch(/^Reported quarterly · Green at 90%/))
it('since: streak, capped, quarterly in months', () => {
  expect(sinceText(cellsGYRR, 3, MONTHS4, label)).toBe('Red since Sep 2026 · 2 months')
  expect(sinceText(allRed12, 11, MONTHS12, label)).toBe('Red all 12 months shown')
  expect(sinceText(quartersYY, 1, QUARTERS2, label)).toBe('Yellow all 2 quarters shown')
  expect(sinceText(quartersGY, 1, QUARTERS2, label)).toBe('Yellow since Q3 FY2026 · 3 months')
})
```

- [ ] **Step 2: Write failing tests for `nouns.ts` and `drivers.ts`.** `nounForms('Services','item')` → `{one:'service',many:'services'}`; `'Repositories'` → `repository/repositories`; `'Repository'` → `repository/repositories`; `'Boxes'` → `box/boxes`; `'Class'` → `class/classes`; `undefined,'unit'` → `unit/units`; `countNoun(1, services)` → `'1 service'`. `worstChildren` on three segments (Payments 55% R, Data 75% R, Mobile 86% Y, one n/a) → worst Payments, worstCount 2, total 3; lower-better picks the highest value first.
- [ ] **Step 3: Write failing tests for `useGridNavigation`** in a tiny harness grid (3 rows × 4 cols): ArrowRight/Left/Up/Down move focus; Home → col 0, End → col 3; PageDown with `pageSize: 2` moves 2 rows; Enter calls `onOpen('r2', 3, el)`; only one `tabIndex=0` at a time; `focusRow('r3')` focuses row r3 at the active column; changing `colCount` from 4 to 2 with `anchor: 'end'` keeps the selected period.
- [ ] **Step 4: Run** `npm --prefix web test -- statusText nouns drivers useGridNavigation` → FAIL (modules not found).
- [ ] **Step 5: Implement** the four logic files and the `ui/status` components; move `StatusChip`, `Legend`, `StatusCellTip`, `RollUp`, `HATCH`, the cell button and the keyboard handling out of `StatusBoard.tsx`, which now composes them (`useGridNavigation` with `rowIds = rows.map(r => r.key)`, `anchor: 'end'`). Replace `rankedChildren` in `FocusDialog.tsx` with `worstChildren(...).ranked`.
- [ ] **Step 6: Run** the new tests and `npm --prefix web test -- StatusBoard FocusDialog` → PASS with no changes to `StatusBoard.test.tsx` or `FocusDialog.test.tsx`.
- [ ] **Step 7: Full verification.** Screenshots: `status-board-tile` at 360/390/1440, identical layout to before.
- [ ] **Step 8: Commit.** `git commit -m "refactor(web): extract status primitives and shared copy helpers"`

### Task 2: Dialog chrome

Size M–L. Depends on 1.

**Files:**
- Create: `FocusHeader.tsx`, `MoreMenu.tsx`, `DefinitionLine.tsx`, `RangeStrip.tsx` (moved from `FocusDialog.tsx`), `Breakdown.tsx`, `useDialogShortcuts.ts`, `focusBody.ts`
- Modify: `FocusDialog.tsx`
- Test: `FocusDialog.test.tsx`, `Breakdown.test.tsx`, `useDialogShortcuts.test.tsx`, `focusBody.test.ts`

**Interfaces:**
- Consumes: `thresholdText`, `sinceText`, `worstChildren`, `useLevelNoun`, `StatusChip` (Task 1).
- Produces:
  - `FocusHeader({ eyebrow, title, position, prev, next, onAskSam, samOpen, menu }: { eyebrow: string; title: string; position: { index: number; total: number }; prev: { name: string; onGo: () => void }; next: { name: string; onGo: () => void }; onAskSam: () => void; samOpen: boolean; menu: ReactNode })`
  - `MoreMenu({ onCopyLink, onTable, onPresent, onExport }: { onCopyLink: () => Promise<boolean>; onTable: () => void; onPresent: () => void; onExport: (format: 'png' | 'svg' | 'csv') => void })`
  - `DefinitionLine({ metric, rule, row, statusLabel, isAdmin, noun }: { metric: Metric | undefined; rule: StatusRule | undefined; row: ViewRow; statusLabel: …; isAdmin: boolean; noun: NounForms })` — `metric` is the version in force for the selected column (`Cell.versionId`).
  - `useDialogShortcuts(ref: RefObject<HTMLElement | null>, handlers: { prev: () => void; next: () => void; range?: (n: 1 | 2 | 3 | 4 | 5) => void; table: () => void; copyLink: () => void; present: () => void }, options?: { rangeKeys?: 3 | 5 }): { enabled: boolean; setEnabled: (on: boolean) => void }` — modifier guard, ignore list (§8.4), `localStorage` key `opsvision.shortcuts` = `off`.
  - `RangeStrip({ selected, onSelect, changeFor, caption, hidden })` with `data-range-strip` on its root.
  - `Breakdown({ head, children, columns, columnKey, scale, direction, noun, onScope, onOpenItem })` (§7.1; vs-goal column only for percent formats with a target).
  - `focusBodyKind(rows: ViewRow[]): 'chart' | 'items'` — `'items'` when there are item rows and no unit scope value, or `chartKind === 'uptime'` (§6.1). In this task `'items'` still renders today's chart; Task 4 replaces it.

- [ ] **Step 1: Write failing `useDialogShortcuts` tests.** Inside a dialog harness: `ArrowRight` calls `next`; `Meta+ArrowRight`, `Control+l`, `Alt+t` call nothing; `t` inside an `<input>`, inside `[role=grid]`, inside `[role=menu]`, inside `[role=radiogroup]`, on a `[data-point-button]` and inside `[data-range-strip]` call nothing; `5` with `rangeKeys: 3` calls nothing and `3` calls `range(3)`; `setEnabled(false)` stores `localStorage['opsvision.shortcuts'] === 'off'` and then `p` calls nothing; a remount reads it back as disabled.
- [ ] **Step 2: Write failing `FocusDialog` tests.**

```ts
it('header: eyebrow, title, position, named prev/next', async () => {
  renderOverview('/scorecards/sc-main/overview?period=2026-M10&focus=on_time_pct')
  const dialog = await screen.findByRole('dialog', { name: 'On-time delivery' })
  expect(within(dialog).getByText('1 of 3')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: /^Previous metric: / })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft')
  expect(within(dialog).queryByRole('button', { name: 'Export PNG' })).toBeNull() // moved into More
})
it('More menu holds copy link, table, present and exports; copy announces', async () => {
  // open More → items Copy link, View as table, Present, Export PNG, Export SVG, Export CSV
  // click Copy link (clipboard mocked) → status text 'Link copied'
})
it('definition line uses the version in force and shows Methodology only to admins', …)
it('no "Loading chart…" line once loaded; aria-busy while switching to 24M', …)
it('range strip has a caption and is hidden for a quarterly metric', …)
it('breakdown is a sortable table with scope buttons; vs goal column only with a percent target', …)
```

- [ ] **Step 3: Write failing `Breakdown` and `focusBody` tests.** `Breakdown` sorts worst first; header click toggles `aria-sort`; an org row button calls `onScope('unit-a')`; a number-format metric renders no `vs goal` header. `focusBodyKind`: uptime rows → `'items'`; unit rows only → `'chart'`; item rows plus a unit scope with a value → `'chart'`.
- [ ] **Step 4: Run** `npm --prefix web test -- FocusDialog Breakdown useDialogShortcuts focusBody` → FAIL.
- [ ] **Step 5: Implement.** Frame insets `inset-8` ≥768px and `inset-0 rounded-none` below; header and body classes per §8.1; value row per §8.5 (value 28, `StatusChip lg`, change 16/500, `sinceText`, goal and YTD 14 `ink/70`); remove the `role="status"` "Loading chart…" line (keep a visually hidden status and `aria-busy`); position from `metricIds`; live region announces `{name}, {i} of {n}` on prev/next.
- [ ] **Step 6: Run** the tests → PASS.
- [ ] **Step 7: Full verification.** Screenshots: `ratio-focus`, `money-plan-focus`, `uptime-focus` (still today's body), More menu open, at 360/390/1440.
- [ ] **Step 8: Commit.** `git commit -m "feat(web): full-screen chrome with definition, position, More menu and shortcuts"`

### Task 3: Coarse periods and counting

Size M–L. Depends on 1.

**Files:**
- Create: `focusRequest.ts`, `logic/coarse.ts`
- Modify: `columns.ts`, `viewRequest.ts`, `viewHelpers.ts`, `logic/statusBoard.ts`, `logic/statusAtScope.ts`, `StatusBoard.tsx` (render `notDue`), `OverviewPage.tsx` (health counts, attention inputs and not-reported data through `periodStatus`)
- Test: `columns.test.ts`, `viewRequest.test.tsx`, `focusRequest.test.ts`, `logic/coarse.test.ts`, `logic/statusBoard.test.ts`, `logic/logic.test.ts` (statusAtScope caption), `OverviewPage.test.tsx`, `TablePage.test.tsx`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `coarseColumns(period: string, grain: 'quarter' | 'half' | 'year', count: number, fy: number): Column[]` (§5.1).
  - `coarseGrains(frequencies: Frequency[], selected: Grain): ('quarter' | 'half' | 'year')[]`.
  - `ViewRequestOptions` gains `coarse?: ('quarter' | 'half' | 'year')[]` and `window?: { grain: Grain; count: number }`. `useScorecardViewRequest()` waits for `useVersions` and passes `coarse` from the version in force for the selected period.
  - `columnsFor(frequency: Frequency, selected: Grain, trend: Column[], coarse: Partial<Record<'quarter' | 'half' | 'year', Column[]>>): Column[]` in `viewHelpers.ts`.
  - `focusWindow(range: RangeKey, period: string, frequency: Frequency): { grain: Grain; count: number }` and `focusRequestOptions(window, metricKey): ViewRequestOptions` in `focusRequest.ts`.
  - `coarseStatus(row: ViewRow, columns: Column[], selected: string, fy: number): { state: 'current' | 'due' | 'overdue' | 'none'; counted: Column | null; cell: Cell | undefined; next: { label: string; dueBy: string } }` (§5.3).
  - `periodStatus(input: { scope: ViewRow | null; children: ViewRow[]; frequency: Frequency; selected: Column; coarse: Column[]; scale: StatusScaleEntry[]; noun: 'segments' | 'services' | 'items'; fy: number }): { status: string; caption: string; counted: Column; notReported: { kind: 'window' | 'stopped' | 'overdue' | 'na'; text: string } | null; quiet: string | null }` — the single source for Health, Needs attention, the board's Current column and Not reported.
  - `BoardCell['kind']` gains `'notDue'`; `buildBoardRow` takes `frequency` and `coarse` and maps (§5.4).

- [ ] **Step 1: Write failing column and request tests.**

```ts
it('coarse columns end at or before the selected month', () => {
  expect(coarseColumns('2026-M10', 'quarter', 4, 1).map((c) => c.period)).toEqual(['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3'])
  expect(coarseColumns('2026-M10', 'half', 2, 1).map((c) => c.period)).toEqual(['2025-H2', '2026-H1'])
  expect(coarseColumns('2026-M10', 'year', 3, 1).map((c) => c.period)).toEqual(['2023-FY', '2024-FY', '2025-FY'])
  // Periods are fiscal-indexed: fiscal M03 closes Q1 whatever the start month; the start month only changes labels.
  expect(coarseColumns('2026-M03', 'quarter', 1, 4).map((c) => c.period)).toEqual(['2026-Q1'])
  expect(coarseColumns('2026-M02', 'quarter', 1, 4).map((c) => c.period)).toEqual(['2025-Q4'])
})
it('requests never exceed 24 periods', () => {
  for (const range of RANGES) for (const freq of ['monthly', 'quarterly', 'biannual', 'annual'] as const)
    for (const period of ['2026-M10', '2026-Q3', '2026-H1', '2025-FY']) {
      expect(scorecardViewRequest(state(period), {}, focusRequestOptions(focusWindow(range.key, period, freq), 'm')).periods.length).toBeLessThanOrEqual(24)
    }
  expect(scorecardViewRequest(state('2026-M10', { ytd: true }), {}, { coarse: ['quarter', 'half', 'year'] }).periods).toHaveLength(21)
})
it('monthly-only methodologies send exactly today’s request', …)
it('focusWindow: monthly 24M → months×24; quarterly any range → quarters×8; biannual → halves×4; annual → years×3', …)
```

- [ ] **Step 2: Write failing `coarseStatus` / `periodStatus` table tests** (Oct 2026, quarterly): Q3 reported → `current`, counts Q3's status, `next = { label: 'Q4', dueBy: 'Jan' }`; Q3 missing in Oct with Q2 reported → `due`, counts Q2, caption `Q3 due by Oct`; Q3 missing in Nov → `overdue`, Not reported `Q3 FY2026 overdue (due by Oct 2026)`; none in window → `none`, `No reports in the last 4 quarters`. Monthly: scope n/a → `notReported.kind === 'na'` with the reason; no value in 12 months → `window`, `No reports in the last 12 months`; values until Jul → `stopped`, `Last reported Jul 2026 (77%)`. One-count invariant: for a mixed fixture, the sum of status counts plus not-reported equals the metric count.
- [ ] **Step 3: Write failing board tests.** A quarterly row in month columns: the Sep cell is `status` (Q3), Jul and Aug are `notDue`, Oct is `notDue`; Current caption `Q3 FY2026`. `StatusBoard` renders `notDue` cells with no dot and the name `…, Aug 2026: Not due`. `statusAtScope` caption `worst of 21 services · 3 not reported`.
- [ ] **Step 4: Write failing page tests.** `OverviewPage.test.tsx`: with a quarterly metric reported for Q3, Health counts it once under its status and Not reported does not list it but shows the quiet line; `TablePage.test.tsx`: with the extra quarter columns in the response the Table renders the same cells as before.
- [ ] **Step 5: Run** `npm --prefix web test -- columns viewRequest focusRequest coarse statusBoard logic OverviewPage TablePage` → FAIL.
- [ ] **Step 6: Implement.** Extend `test/viewFixtures.ts` `buildView` to answer quarter, half and year periods for a quarterly fixture metric (owned here). `OverviewPage.tsx`: compute `periodStatus` once per metric and use it for `healthCounts`, `attentionItems`, `boardRows` and the not-reported list (keep today's markup; Task 5 restyles it); fix next-due copy.
- [ ] **Step 7: Run** the tests → PASS.
- [ ] **Step 8: Full verification.** Screenshots: `status-board-tile`, `discrete-quarterly-tile` (still today's chart, now with data), `not-reported-tile` at 360/390/1440.
- [ ] **Step 9: Commit.** `git commit -m "feat(web): coarse metrics at their own grain, counted once"`

### Task 4: Item metrics in the dialog

Size L. Depends on 1, 2, 3.

**Files:**
- Create: `logic/itemGrid.ts`, `logic/itemGridLayout.ts`, `ItemGrid.tsx`, `ItemDrillIn.tsx`, `itemExports.ts`
- Modify: `FocusDialog.tsx` (item body, `subject` and `sort` params, `focusWindow` wiring, explicit shown window, item exports, `1`–`3` ranges)
- Test: `logic/itemGrid.test.ts`, `logic/itemGridLayout.test.ts`, `ItemGrid.test.tsx`, `itemExports.test.ts`, `FocusDialog.test.tsx`

**Interfaces:**
- Consumes: `useGridNavigation`, `StatusCell`, `Legend`, `sinceText`, `thresholdText`, `useItemNoun` (1); `focusBodyKind`, `FocusHeader`, `MoreMenu`, `useDialogShortcuts` (2); `focusWindow`, `focusRequestOptions` (3).
- Produces (used by Task 6):
  - `ItemRow`, `ItemSort`, `buildItemRows(rows: ViewRow[], columns: Column[], scale: StatusScaleEntry[], groupOf: (itemId: string) => string, fy: number): ItemRow[]` (filters `subjectKind === 'item'`), `sortItems(rows, sort, direction, scale): { reported: ItemRow[]; notReported: ItemRow[] }`, `itemSummary(rows, scale): { total: number; best: number; counts: Map<string, number>; notReported: number; worst: ItemRow | null }`, `filterItems(rows, query): ItemRow[]`, `exceptionsFirst(rows: ItemRow[], scale, direction, max = 5): { shown: ItemRow[]; hiddenNotReported: number; restBest: number }` — signatures as spec §6.5 plus `exceptionsFirst` for the tile.
  - `itemGridLayout(width, total, opts): ItemGridLayout` (§6.3, exact constants).
  - `ItemGrid({ head, rows, columns, scale, direction, noun, sort, onSort, filter, onFilter, onOpenItem, restoreId })`.
  - `ItemDrillIn({ head, row, columns, scale, noun, total, onBack, headingRef })`.
  - `itemGridCsv(rows: ItemRow[], columns: Column[]): string`, `itemGridSvg(input: { title: string; scope: string; rows: ItemRow[]; columns: Column[]; scale: StatusLevel[] }): string`.
  - `useItemGroups(): (itemId: string) => string` (in `ItemGrid.tsx`; `useItems({ enabled: true })` + `useOrgUnits`; `''` org unit → `Unassigned`).

- [ ] **Step 1: Write failing `itemGridLayout` tests** with the spec table:

```ts
const dlg = (w: number) => itemGridLayout(w, 12, { valueWidth: w < 640 ? 76 : 136, extraWidth: 112, nameMin: 96 })
expect(dlg(1296)).toMatchObject({ count: 12, cellWidth: 40, nameWidth: 240, extraShown: true, stacked: false, tableWidth: 968 })
expect(dlg(880)).toMatchObject({ count: 12, cellWidth: 39, nameWidth: 164, extraShown: true })
expect(dlg(624)).toMatchObject({ count: 12, cellWidth: 28, nameWidth: 100, extraShown: true })
expect(dlg(342)).toMatchObject({ count: 6, cellWidth: 28, nameWidth: 98, extraShown: false, stacked: false })
expect(dlg(312)).toMatchObject({ count: 6, cellWidth: 48, stacked: true })
expect(dlg(272)).toMatchObject({ count: 6, cellWidth: 45, stacked: true })
const tile = (w: number) => itemGridLayout(w, 12, { valueWidth: 72, nameMin: 80 })
expect(tile(528)).toMatchObject({ count: 12, cellWidth: 28, nameWidth: 120 })
expect(tile(320)).toMatchObject({ count: 6, cellWidth: 28, nameWidth: 80 })
expect(itemGridLayout(1296, 24, { valueWidth: 136, extraWidth: 112 })).toMatchObject({ count: 24, stacked: false })
```

- [ ] **Step 2: Write failing `itemGrid` tests** on a 6-item fixture (R, two Y, G 100.00%, G, not reported with history, not reported never): `sortItems('worst')` order; `'reds'` order by worst-status count; `'name'`; not-reported group by name; `itemSummary` → `{ total: 7, best: 2, notReported: 2 }`; `lastReported` `{ label: 'Sep', display: '99.98%' }`; `filterItems(rows, 'pay')` matches a group name; `exceptionsFirst(…, 5)` → R, Y, Y, then not reported, `restBest: 2`, `hiddenNotReported: 0`; unit rows in the input are ignored.
- [ ] **Step 3: Write failing `ItemGrid` tests.** Summary text `18 of 24 services Green` from the uptime fixture with a four-level scale (best label used); arrow-down from the last reported row lands on the first not-reported row (the group header is skipped); Enter calls `onOpenItem('svc-web')`; typing `web` then waiting 300 ms announces `Showing 1 of 2 services`; at a 272px container (mock `useElementWidth`) the grid is stacked and `document.documentElement.scrollWidth <= 320`; long names clamp (`line-clamp-2` class present); axe passes.
- [ ] **Step 4: Write failing dialog tests.** Opening a row pushes `subject` (history length +1), focuses the `h3` with the item's name, and shows `Green at 99.90% or better` from the item's `Cell.rule`; `‹ All 2 services` restores `sort=reds` and the filter and focuses the same item's cell by id after the sort changed order; `subject=nope` shows the grid and the URL loses `subject` (replace); `sort=bogus` behaves as Worst now; prev/next clears `subject` and `sort`; More → Export CSV on the grid writes one row per item (spy `downloadBlob`); the item range control shows `6M 12M 24M` and key `3` selects 24M; a quarterly metric's request contains only quarter periods (assert the MSW-captured query).
- [ ] **Step 5: Run** `npm --prefix web test -- itemGrid itemGridLayout ItemGrid itemExports FocusDialog` → FAIL.
- [ ] **Step 6: Implement.** `FocusDialog.tsx`: replace the `periods.length > 12 ? 24 : 12` guess with the window kept alongside the data it was requested for; route `focusBodyKind === 'items'` to `ItemGrid`/`ItemDrillIn`; keep filter text and scroll position in `MetricFocusBody` state; sort in the URL. Summary and Worst now per §6.5 (scope value first when present, §6.1).
- [ ] **Step 7: Run** the tests → PASS.
- [ ] **Step 8: Full verification.** Screenshots: `uptime-focus` (grid), `uptime-focus-drill-in`, filter with no matches, at 360/390/1440; compare with `uptime-expanded-*.png` mockups.
- [ ] **Step 9: Commit.** `git commit -m "feat(web): service-by-month grid and drill-in for item metrics"`

### Task 5: Overview frame

Size L. Depends on 1, 3.

**Files:**
- Create: `CustomizeBar.tsx`, `SectionHeader.tsx`, `TileFrame.tsx`, `NotReportedCard.tsx`
- Modify: `LayoutGrid.tsx`, `ControlBar.tsx`, `StatusBoard.tsx` (phone clamp, `scroll-margin-top`), `OverviewPage.tsx` (tiles through `TileFrame`, section headers, Not reported card, page skeleton, coarse columns to charts via `columnsFor`, stopped and no-reports tile states)
- Test: `LayoutGrid.test.tsx`, `TileFrame.test.tsx`, `NotReportedCard.test.tsx`, `ControlBar.test.tsx`, `OverviewPage.test.tsx`, `StatusBoard.test.tsx`

**Interfaces:**
- Consumes: `RollUp`, `StatusChip`, `thresholdText`, `sinceText`, `useLevelNoun`, `useItemNoun` (1); `periodStatus`, `columnsFor` (3).
- Produces (used by 6 and 7):
  - `TileFrame({ head, threshold, value, extras, context, footer, onExpand, state, children }: { head: ViewRow; threshold: string; value: ReactNode; extras?: ReactNode; context?: string; footer?: ReactNode; onExpand: (trigger: HTMLElement) => void; state: 'normal' | 'stopped' | 'window'; children: ReactNode })` — renders `article` + `h3`, Expand icon button, removes `Current:` and the table link.
  - `LayoutGrid` prop additions: none; internal `editing` state; `Customize layout` button rendered by `LayoutGrid` in the page header slot (`renderHeaderActions?: (button: ReactNode) => ReactNode` prop so `OverviewPage` places it beside the title).
  - `NotReportedCard({ period, items, quiet, canEnter }: { period: string; items: { key: string; name: string; why: string; category: string }[]; quiet: string | null; canEnter: boolean })`.
  - CSS custom property `--control-bar-h` set by `ControlBar` on `document.documentElement`.

- [ ] **Step 1: Write failing `LayoutGrid` tests.** At rest: no `button` named `/^Drag /` or `Layout options`; one `Customize layout` button. After clicking it: every tile has `Move {title}. Space to pick up` and `Layout options for {title}`; tile content has the `inert` attribute; `Reset layout`, `Save as default` (admin only) and `Done` are in a region named `Customize layout`; `Done` returns focus to `Customize layout`; Esc with nothing picked up leaves the mode; a section's menu offers `Move section up`, `Move section down`, `Move section to top`, `Hide section header` and moves the section with its tiles (existing `moveBlock`); display order pins `widget:health` then `widget:needs`.
- [ ] **Step 2: Write failing `TileFrame`, `NotReportedCard`, `ControlBar`, `StatusBoard` tests.** `TileFrame`: `h3` title, threshold line text, Expand named `Expand On-time delivery`, no `Current:` text, no `View as table` link; `state='window'` renders `No reports in the last 12 months` and no Expand. `NotReportedCard`: rows with their why text (incl. `Not applicable: {reason}`), the quiet line, `Enter Oct 2026 data` only when `canEnter`. `ControlBar` at 390px renders one 40px summary button that opens a dialog with the full controls; it sets `--control-bar-h`. `StatusBoard` stacked rows have `line-clamp-2` names and truncating values.
- [ ] **Step 3: Write failing page test.** `OverviewPage.test.tsx`: section headers show the roll-up `◆ 1 Off track · ▲ 1 Watch` (test-tenant labels), the eyebrow above a tile is absent when the tile follows its own section, the page skeleton has `aria-busy` and a hidden `Loading overview` status, and the quarterly tile receives quarter columns.
- [ ] **Step 4: Run** `npm --prefix web test -- LayoutGrid TileFrame NotReportedCard ControlBar StatusBoard OverviewPage` → FAIL.
- [ ] **Step 5: Implement** per §4.1, §4.4, §4.5, §4.7, §3.3, §3.9 and §10 (phone control bar).
- [ ] **Step 6: Run** the tests → PASS.
- [ ] **Step 7: Full verification.** Screenshots: `overview-dashboard` at rest and in Customize mode, `category-section-tile`, `not-reported-tile`, `ratio-tile`, control bar on phones, at 360/390/1440; compare with `customize-layout-*.png`.
- [ ] **Step 8: Commit.** `git commit -m "feat(web): Customize layout mode, tile frame, section headers and not-reported card"`

### Task 6: Health, Needs attention, uptime tile

Size L. Depends on 4, 5.

**Files:**
- Create: `HealthSummary.tsx`, `AttentionCard.tsx`, `ItemSummaryTile.tsx`
- Modify: `logic/needsAttention.ts`, `OverviewPage.tsx` (render the three; stop rendering `MetricChart` for item metrics)
- Test: `logic/logic.test.ts` (needsAttention), `HealthSummary.test.tsx`, `AttentionCard.test.tsx`, `ItemSummaryTile.test.tsx`, `OverviewPage.test.tsx`

**Interfaces:**
- Consumes: `periodStatus` (3); `buildItemRows`, `itemSummary`, `exceptionsFirst`, `itemGridLayout`, `useItemGroups` (4); `TileFrame` (5); `worstChildren`, `sinceText`, `StatusChip`, `StatusCell` (1).
- Produces:
  - `needsAttention(items: NeedsAttentionItem[], scale: StatusScaleEntry[]): { shown: RankedItem[]; totals: { red: number; slipping: number; middle: number } }` with `RankedItem = NeedsAttentionItem & { tier: 1 | 2 | 3; streakMonths: number; distance: number; newRed: boolean; reason: string }`; `NeedsAttentionItem` gains `streakMonths: number` and `priorLabel: string`.
  - `HealthSummary({ title, period, total, counts, prior, priorLabel, selected, onSelect, scale })`.
  - `AttentionCard({ item, meta, href, compact })` and the item variant via `meta.items`.
  - `ItemSummaryTile({ head, rows, columns, scale, direction, noun, onExpand, onOpenItem })`.

- [ ] **Step 1: Write failing `needsAttention` tests.**

```ts
it('one slot for the most severe New Red, the rest by streak then distance', () => {
  const r = needsAttention([
    red('backlog', { streakMonths: 4, distance: 0.5 }),
    red('defects', { streakMonths: 2, distance: 3 }),
    red('epics', { newRed: true, distance: 0.1 }),
    red('uptime', { newRed: true, distance: 2.4 }),
    red('csat', { newRed: true, distance: 0.8 }),
  ], SCALE)
  expect(r.shown.map((i) => i.metricKey)).toEqual(['backlog', 'defects', 'uptime'])
  expect(r.totals.red).toBe(5)
})
it('reasons', () => {
  // streak 4 from Jul → 'Red since Jul 2026 · 4 months'; streak = window → 'Red all 12 months shown';
  // new red from Green → 'New Red · fell from Green'; tier 2 → 'Fell from Green'
})
it('quarterly streaks are measured in months', …)
```

- [ ] **Step 2: Write failing component tests.** `HealthSummary` with a four-level scale (labels `Great/Good/Watch/Off track`): four toggles plus Not reported, names like `Off track: 5 metrics, up 2 since Sep`, `aria-pressed` toggles keep focus and the live region says `Showing 5 Off track metrics`; title `Health this quarter` for a quarter selection with `Since Q2`. `AttentionCard`: an `article` with `h3` link whose accessible name starts with the title; `aria-describedby` includes the reason; compact mode renders no SVG and a 6-cell ribbon. Header copy on the page: `3 of 5 Red` with `Show all 5 Red`; mixed → `2 Red · 1 slipping` with no Show all; Show all moves focus to the first tile. `ItemSummaryTile`: rows only for non-best and not-reported items (max 5), each a button named `Open Web service trend: 99.20%, Red`, cells `aria-hidden`, the closing line through `countNoun` (`All other 1 service Green`), threshold line `· 1 service has its own target` when per-subject bands exist; at a 300px container no horizontal overflow; axe passes.
- [ ] **Step 3: Run** `npm --prefix web test -- logic HealthSummary AttentionCard ItemSummaryTile OverviewPage` → FAIL.
- [ ] **Step 4: Implement** per §4.2, §4.3, §6.4; Health counts from `periodStatus`; the item card variant from `itemSummary`.
- [ ] **Step 5: Run** the tests → PASS.
- [ ] **Step 6: Full verification.** Screenshots: `health-tile`, `needs-attention-tile` (desktop and phone compact), `uptime-tile` at 360/390/1440; compare with `overview-top-*.png` and `uptime-tile-*.png`.
- [ ] **Step 7: Commit.** `git commit -m "feat(web): health summary, needs attention ranking and exceptions-first uptime tile"`

### Task 7: Chart kinds A — coarse points, money plan, sparse ribbon

Size M. Depends on 0, 3, 5.

**Files:**
- Create: `charts/MoneyPlanChart.tsx`, `charts/SparseRibbon.tsx`
- Modify: `charts/MetricChart.tsx` (dispatch: `discrete` and coarse → `RatioChart` with `points`; `money_plan` → `MoneyPlanChart`; sparse → `SparseRibbon`), `charts/RatioChart.tsx` (`points` prop: a dot per period, value labels), `charts/chartParts.tsx` (point buttons for new kinds), `charts/chartTheme.ts` (`barFill`), `exports.ts` (money-plan SVG); delete `charts/BarsChart.tsx` once unused
- Test: `charts/MetricChart.test.tsx`, `charts/chartTheme.test.ts`, `exports.test.ts`

**Interfaces:**
- Consumes: `columnsFor` (3, via the columns `TileFrame` passes from Task 5).
- Produces: `barFill(scale: StatusLevel[], status: string): { fill: string; stroke: string }`; `moneyPlanDomain(values: number[]): [number, number]` (centred on 100, padded by the largest deviation + 3, at least ±15); `RatioChart` prop `points?: boolean`.

- [ ] **Step 1: Write failing tests.** Coarse metric with quarter columns renders `data-testid="metric-chart"` with one `circle[data-point]` per quarter and labels `Q3 FY26`; no `rect` bars. Money plan: a 96% month draws its bar below the 100% line and a 104% month above (compare `y` attributes), labels `-4%` and `+4%`, a `Plan` label, summary text `Spend vs plan: over plan in 1 of 2 months; Oct 104% of plan, Green`; `moneyPlanDomain([96, 111])` → `[85, 115]` (deviation 11 + 3 < 15, so ±15); `moneyPlanDomain([80, 130])` → `[67, 133]`. Sparse: board cells with values above valued months and no bordered chips (`queryAllByText(/n\/a$/)` inside buttons is empty). `barFill` edges have ≥ 3:1 contrast on white (`contrastRatio`). `chartSvg` for money plan contains bars on both sides of the 100% line.
- [ ] **Step 2: Run** `npm --prefix web test -- MetricChart chartTheme exports` → FAIL.
- [ ] **Step 3: Implement** per §5.5, §7.4, §7.5; `isAnimationActive={!reduced}`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Full verification.** Screenshots: `discrete-quarterly-tile/focus`, `money-plan-tile/focus`, `sparse-tile/focus` at 360/390/1440; compare with `tile-states-*.png` and `bars-money-plan-*.png`; export PNG/SVG/CSV of money plan open without error.
- [ ] **Step 6: Commit.** `git commit -m "feat(web): coarse points, diverging money plan and sparse ribbon"`

### Task 8: Chart kinds B — multi-series, markers, ranges, phone geometry

Size L. Depends on 0, 5, 6, 7.

**Files:**
- Create: `charts/MultiSeries.tsx`, `charts/versionMarkers.ts`
- Modify: `charts/RatioChart.tsx` (markers, phone geometry, tick/pill collision, percent cap at 100), `charts/chartParts.tsx` (`TICK_OPACITY = 0.7`), `charts/MetricChart.tsx` (multi-series dispatch; remove `UptimeRows` and `LetteredChips`), `charts/ranges.ts` (change-rule terms)
- Delete: `charts/UptimeRows.tsx`, `charts/LetteredChips.tsx`
- Test: `charts/MetricChart.test.tsx`, `charts/ranges.test.ts`, `charts/versionMarkers.test.ts`

**Interfaces:**
- Consumes: Task 7's dispatcher and `RatioChart`.
- Produces: `useVersionMarkers(columns: Column[], metricKey: string): { index: number; label: string; title: string }[]` in `charts/versionMarkers.ts` (reads `useVersions` and `usePeriodState`; `[]` when `restate` is set); `versionBoundaries(versions: MethodologyVersion[], columns: Column[], metricKey: string): { index: number; label: string; title: string }[]` (pure, tested); `rangeChange(row, columns)` returns improvement terms (`26% worse`) when the row's cells carry a change rule.

- [ ] **Step 1: Write failing tests.** `versionBoundaries` with versions effective 2026-M01 and 2026-M07 over Nov–Oct columns → markers at Jan (`2026 v1.0`) and Jul (`From records` when the newer version derives a measure in the metric's formula); restated → `[]`. Multi-series: 3 series → one SVG with three end labels (name, value, chip) and no legend; 4 series in focus → four panels named by segment, worst first, one shared y-domain (same tick labels in each), each with a ribbon. `rangeChange` for a change-rule row → `{ text: '26% worse' }`. Phone geometry: at 360px focus the plot height class is `h-[max(280px,45vh)]` and every other month label renders. Tick/pill: no tick label within 14px of the current-value pill. Percent axis max never exceeds 100. `UptimeRows` and `LetteredChips` no longer exist (`rg` in the verification step).
- [ ] **Step 2: Run** `npm --prefix web test -- MetricChart ranges versionMarkers` → FAIL.
- [ ] **Step 3: Implement** per §7.1, §7.2, §7.6, §7 (phone geometry) and §3.2 (ticks).
- [ ] **Step 4: Run** → PASS. Run `rg -n "UptimeRows|LetteredChips" web/src` → no results.
- [ ] **Step 5: Full verification.** Screenshots: `multi-series-tile/focus`, `change-score-tile/focus`, `ratio-focus` at 360/390/1440, plus a restated view showing no markers.
- [ ] **Step 6: Commit.** `git commit -m "feat(web): multi-series small multiples, methodology markers and phone chart geometry"`

---

## Self-review

- **Spec coverage:** §3 → Tasks 1, 2, 5, 8; §4.1 → 5; §4.2–4.3 → 6; §4.4 → 3, 5; §4.5–4.7 → 5; §5 → 3 (logic, requests), 4 (dialog request), 7 (chart); §6.1–6.3, 6.5–6.7 → 4; §6.4 → 6; §7.1 → 2 (breakdown), 8; §7.2 → 8; §7.4–7.5 → 7; §7.6 → 8; §7.8–7.9 → 5; §8 → 2 (and 4 for item actions); §9 → every task's axe/keyboard tests; §10 → 5 (phone control bar), 4 and 6 (grids), 8 (chart geometry).
- **Ownership:** parallel pairs (0‖1, 2‖3, 4‖5, 6‖7) share no file; `OverviewPage.tsx` passes 3 → 5 → 6, `FocusDialog.tsx` 1 → 2 → 4, `StatusBoard.tsx` 1 → 3 → 5, chart files 0 → 7 → 8, sequentially.
- **Type names:** `ItemRow`, `itemGridLayout`, `periodStatus`, `focusWindow`, `TileFrame`, `needsAttention → { shown, totals }` are defined once and used with the same signatures in later tasks.
