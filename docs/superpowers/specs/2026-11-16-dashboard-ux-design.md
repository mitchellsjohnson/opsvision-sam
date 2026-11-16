# OpsVision — Dashboard and expanded-mode UX

Status: draft for the maintainer's review
Date: 2026-11-16
Extends: `2026-11-10-scorecard-ux-design.md` §4 (Overview), §5 (chart design system) and §7 (full screen). Where they disagree, this document wins. The 12-month status board (commits 2e7b8b4, 2afded3, 224cc74) and the full-screen line chart are approved and are the quality bar; this document brings every other widget up to them.

## 1. Intent

The maintainer, looking at real data: "That uptime is useless and unreadable when you click it. Go through every single widget, both the dashboard and expanded mode. Make the UX world class."

An audit of every widget in both modes at 1440 and 390 px, against a demo tenant enriched to production-like density (24 months, 24 services, every chart kind, gaps, n/a months, unreported metrics), found the same faults the maintainer's tenant shows:

1. Expanded Uptime is a wrapped run of 11px glyphs with no months, no alignment, no sort and no summary.
2. Item-only metrics (Uptime) answer with `— ◆R worst of N services`: no value, no service, and unreported services silently dropped.
3. Quarterly and biannual metrics vanish in a month view: twelve no-data dots and an empty plot, although every quarter has data.
4. Needs attention hides Reds beyond three with no overflow, and its cards use a different status pill from the board.
5. The full-screen chrome is seven equal buttons on two rows; no definition, thresholds, position or shortcuts.
6. Health is four unstyled buttons in a second vocabulary ("Off track / Watch / On track").
7. Money-plan bars start at zero, so 96% and 111% of plan look the same.
8. Sparse, never-reported, stopped-reporting and no-company-total metrics each invent their own empty look.
9. On phones the control bar takes 240 of 844 px and charts are scaled-down desktop charts.
10. Tiles repeat themselves (`Current: 79% ◆R` under `79% ◆R`) and offer three ways to open the same thing.

Success: an executive opening the Overview reads the month in one line, sees every Red with the reason it is Red, and in the full-screen view of any metric (including 24 services of uptime) answers "what is wrong, where, since when" without hunting, by mouse, keyboard or screen reader, at any width from 360 to 1920 px.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Every widget answers one stated question first, in words and a number, before any chart.
2. One status language everywhere: the board's cell, chip, legend, no-data dot, n/a hatch, Not rated grey, roll-up text and hover label.
3. Expanded Uptime becomes a real service × month status grid with summary, sort, filter, keyboard grid and per-service drill-in.
4. Quarterly and biannual metrics show their own periods in month views.
5. One full-screen chrome for every metric, with the definition and thresholds always visible.
6. Phones get their own layout and chart geometry, not a shrunken desktop.

**Non-goals**

- New metrics, methodology fields (there is no metric owner field; owner is out of scope), or API changes beyond requesting more periods in existing endpoints.
- The Table page and the monthly report (separate specs), except where they share components changed here.
- New dependencies. Everything uses React 19, Tailwind 4 tokens, Radix primitives already installed (Dialog, DropdownMenu, Tooltip, Popover), Recharts 3 and lucide-react.

**Anti-goals (failure even if it works)**

- Status shown by color alone, anywhere.
- A widget that shows `—` as its answer while data exists at another grain or in its items.
- Any horizontal page scroll at 360–1920 px (a grid that scrolls inside its own card is allowed only for 24M uptime on desktop, §6.2).
- Two vocabularies for one status.

## 3. Design system notes (shared by every widget)

### 3.1 Type scale

Six sizes only. Tailwind classes in brackets.

| Size / line | Use | Class |
|---|---|---|
| 11 / 16 | Eyebrows (uppercase, 600, 0.04em), cell letters, chart ticks on tiles, captions under values | `text-[11px] leading-4` |
| 12 / 16 | Secondary lines: thresholds, change on boards, legends, table headers | `text-xs` |
| 14 / 20 | Body, table cells, buttons, change in value rows | `text-sm` |
| 16 / 24 | Card and section titles (600) | `text-base` |
| 20 / 28 | Dialog title (600, accent-deep); phone headline numbers | `text-xl` |
| 28 / 36 | The answer: the primary value on tiles, cards and the dialog (600, `tabular-nums`) | `text-[28px] leading-9` |

Chart ticks are 12px in focus, 10px on tiles (the one exception: SVG text inside a 120px plot). Nothing smaller than 10px; no letters inside cells smaller than 11px.

### 3.2 Color and tokens

From `web/src/ui/tokens.css`, unchanged: `accent` `#5B4BDB` (lines, current-value pill), `accent-deep` `#3F33A8` (titles, links, selected header), `cream` (page and dialog), `ink` with opacities 80 (secondary text), 70 (captions, ticks), 55 (chart ticks), 35 (no-data dot, hover ring), 20 (borders), 15 (n/a border, dividers), 10 (row rules), 6 (Not rated, skeletons, segmented control track), 3.5 (row hover). Status: `status-g`/`status-g-bg`, `status-y`/`status-y-bg`, `status-r`; tiers from `statusFill` (best = soft tint, middle = tint with border, worst = solid). Series colors: `LINE_COLORS`. Bands in plots: status color at 7% opacity (up from 6%, which is invisible on cream). Hatch: the board's `HATCH`.

### 3.3 Spacing and card anatomy

4px grid. Card: `rounded-lg border border-ink/20 bg-white p-4`. Gaps: 8px inside a card between rows, 16px between cards (`gap-4`), 24px between sections (`gap-6`). Section header: title 16/24 semibold accent-deep, roll-up text 11px ink/70 beside it, a 1px `ink/15` rule under it with 6px padding; no card around it.

Tile anatomy, top to bottom:

1. Header row: title (16, 600) and, under it, one 12px ink/70 line (thresholds or context, §3.5); on the right a 32×32 ghost icon button `Maximize2` (16px), `aria-label="Expand {metric}"`, `title="Expand"`. The text "Expand" button goes.
2. Value row (baseline-aligned, 8px gaps, wraps): value 28/36; status chip `lg` (20px tall, 12px letter, shape + letter); change 14px medium with arrow and tone (`MOVE_CLASS`); optional 12px ink/70 extras (YTD, components such as `18 / 20`).
3. One 12px ink/70 context sentence when the kind needs one (sparse, stopped reporting, quarterly).
4. Chart region (per kind, §7), plot 120px, ribbon cells 18px tall with 11px letters.
5. Optional footer (12/14px link) separated by a 1px `ink/10` rule.

Removed from tiles: the `Current: …` line, the `View as table` link (the dialog's More menu and the Table tab cover it), and the category eyebrow above a tile when the tile sits under its own category's section header (kept when the user has moved it elsewhere).

### 3.4 Status vocabulary (shared with the board)

| State | Cell | Words (visible / accessible) | Where it comes from |
|---|---|---|---|
| Status | Tier fill + letter (and shape on chips) | `Red`, `Yellow`, `Green` from the tenant's scale labels | cell status |
| Not rated | `ink/6` fill, no letter | `Not rated` | value with no status |
| n/a | Hatch, `ink/15` border | `n/a` + reason (`No major incident needed a postmortem this month`) | `naReason` |
| No data | 4px `ink/35` dot | `No data` | no cell, or cell with neither value nor status |
| Not due | Empty cell, no dot | `Not due` (tooltip `Q3 FY2026 reports after Sep`) | month cells of a quarterly or biannual metric that are not its period's last month (§5) |
| Not reported (metric, this period) | — | `Not reported` | no status at scope or in children for the selected column |
| Never reported | — | `No data yet` + `Nothing has been entered for this metric.` | no value in any column |
| Stopped reporting | — | `Last reported {Mon YYYY}` | values in history, none in the last column |

Health and every count use the scale labels: "5 Red", never "Off track". Roll-ups everywhere use the board's `RollUp` text: `◆ 1 Red · ▲ 1 Yellow`, or `All Green`, plus `· 2 no data` for blanks.

### 3.5 Threshold sentence

A new pure function `thresholdText(rule, format, direction, statusLabel)` in `logic/statusText.ts` writes the 12px line under every title:

- Bands, higher better: `Green at 90% or better · Red below 80%` (best band's value; worst band's neighbour's value).
- Bands, lower better: `Lower is better · Yellow above 110% · Red above 120%`.
- Per-subject bands: append `; {subject} is held to {value}` for each (`Status Page is held to 99.50%`).
- Change rule: `Lower is better · judged on change vs the prior month` on tiles; in focus add `Green: any improvement · Yellow: up to 5% worse · Red: more than 5% worse`.
- Values use the metric's format with trailing zeros trimmed for whole steps (`90%`, `99.90%` stays because percent2).

### 3.6 Hover label

Unchanged from `ChartHoverCard` / `StatusCellTip` (ink background, 11/16 white text, bold 13–14px value, full period, `shape label`, streak `· 4 months`, change). Every new grid and chart uses one of these two; no new tooltip styles.

### 3.7 Loading, empty and error

- Page: the frame (title, control bar, layout buttons) renders at once; widgets render skeletons at their final size (`bg-ink/[0.06] rounded`), with one `role="status"` "Loading overview" (visually hidden) and `aria-busy` on the grid. Today's text `Loading overview…` goes.
- A widget whose data failed shows, inside its own card at its own height, `Couldn’t load this chart` (14, 500), `The rest of the dashboard is up to date.` (12, ink/70) and a `Try again` button (secondary, 32px). The view is one request today, so this applies to the dialog's 24-month request and to future per-widget requests; the page-level error stays for the main view.
- Empty (never reported): no plot (§7.9).

## 4. Overview page

Order (default layout; still draggable): Health, Needs attention, 12-month status, then category sections with their tiles, then Not reported. `LayoutGrid.displayOrder` pins Health then Needs attention to the top when visible (today it pins Needs only).

### 4.1 Health this month

Mockup: `overview-top-1440.png`, `overview-top-390.png` (HTML `overview-top.html`).

- Question: how did the month go overall, and what changed since last month?
- Layout: one wide card. Row 1: title `Health this month` (16, 600, accent-deep, `h2`), then `15 metrics · Oct 2026` (12, ink/70); right-aligned on ≥640px, below on phones: `Since Sep: 2 more Red, 1 fewer Green` (12; the Red phrase `text-status-r font-semibold` when it grew). Row 2: a 12px-tall proportion bar, `rounded-md`, 2px gaps, one segment per status in rank order worst first (Red solid, Yellow tint with 1px `status-y` inset border, Green tint with 1px green/25 inset border, Not reported hatch with `ink/15` border), `flex-grow` = count. Row 3 (12px below): four toggle buttons.
- Toggle button: 36px tall, `rounded-lg border border-ink/20 bg-white pl-2 pr-3`, contents: status chip (Not reported: a hatch swatch), count (16, 600, tabular), label (12), delta vs prior (11, tone; `no change` neutral). Pressed: `border-accent bg-accent/[0.08] ring-1 ring-accent ring-inset`, `aria-pressed="true"`. Not reported is a real toggle (`?health=none`) that filters to unreported metrics' tiles.
- Accessible names: bar `role="img" aria-label="5 Red, 3 Yellow, 3 Green, 4 Not reported of 15 metrics"`; toggles `aria-label="5 Red, +2 vs Sep. Show only these"`; group `role="group" aria-label="Show metrics by status"`.
- Prior-month counts: `statusAtScope` at `priorColumn(trendColumns)` for every metric (the same call the page makes for the current column).
- The separate "Clear health filter" pill goes; pressing the pressed toggle again clears it, and a `Clear` text button (12, accent-deep) appears after the toggles while one is pressed.
- Phone: toggles wrap two per row (`flex-1 basis-[calc(50%-4px)]`).

### 4.2 Needs attention

Mockup: `overview-top-*.png`.

- Question: which metrics are Red (or slipping), why, and where?
- Header row: `Needs attention` (16, 600, accent-deep, `h2`), `3 of 5 Red` (12, ink/70), and when more qualify than shown, a link `Show all 5 ›` (12, 500, accent-deep) that sets `?health=R` and moves focus to the first metric tile.
- Grid: 3 columns ≥1024px, 2 at 640–1023, 1 below; `gap-4`; cards stretch to the tallest in the row (min 248px on ≥640).
- Card: one `<button>` (no inner Expand, no nested controls): `aria-label="{name}: {value}, {status label}, {change}. {reason}. Open chart"`. Inside, as spans:
  1. Row: category eyebrow (11, uppercase) left; reason (11, 600, `text-status-r`, or `text-status-y` for tier 2/3) right. Reasons: `Red {n} months running` (n ≥ 2), `Fell from {prior label}`, `New Red`, `{n} service(s) Red` for item metrics, `Yellow {n} months` for tier 3.
  2. Title (16, 600).
  3. Value row as §3.3 (28px value, chip `lg`, change).
  4. Threshold line (12, ink/70): `Goal 90% · Red below 80%` / `Lower is better · Red above 600`.
  5. Trend: 56px Recharts area/line (no axes), bands at 9% opacity, goal dotted `ink/40`, current dot; then a 12-cell ribbon (18px cells with letters; phones show the last 6) and month initials (11px ink/70).
  6. Why line, after a 1px `ink/10` rule, `mt-auto`: worst child with value and chip and how many share the worst status: `Lowest: Payments 55% ◆R · 2 of 4 segments Red` (higher better) or `Highest: Android App 941 ◆R · 4 of 8 products Red` (lower better). From `rankedChildren` logic in `FocusDialog`, moved to a shared `logic/drivers.ts`.
- Item-only metrics (Uptime): value row is `Worst {item} {value} {chip}`; line 4 is the distribution `18 of 24 Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported`; line 5 is a mini board of the worst three items (name 96px, 12 cells 14px tall with tier fill only, value 56px; the card's accessible name carries the statuses, so these cells are `aria-hidden`); why line `{item}: Red in {n} of the last 12 months`.
- Ranking (changes `needsAttention`): tier 1 (worst status) sorted by **Red streak length** (consecutive worst-status columns ending now) descending, then distance past the Red line, then category order; tiers 2 and 3 unchanged. Show 3; the header states the total.
- Phone: one column; cards keep all parts; ribbon shows 6 months.

### 4.3 12-month status board

Approved; changes are limited to:

- Quarterly and biannual rows (§5): the quarter's status sits in the quarter's last month column; other month cells are Not due (empty, no dot); the Current column shows the latest period's value with a caption `Q3 FY2026`.
- Item-metric rows: the Current caption becomes `worst of 24 services · 3 not reported` when any are missing (`statusAtScope` caption gains the not-reported count).
- The sticky control bar must not cover the board header: the board's `scroll-margin-top` equals the control bar height (`--control-bar-h`, published by `ControlBar` like `--tile-toolbar`).
- Phone (stacked rows): row name `min-w-0 line-clamp-2`, value `shrink-0 max-w-[45%] truncate`, so nothing clips at 358px.

### 4.4 Category section header

Mockup: `uptime-tile-1440.png` (top).

`h2` 16/24 semibold accent-deep, then the board's `RollUp` component (exported from `StatusBoard.tsx`) in 11px ink/70, a 1px `ink/15` rule under both, `pb-1.5 mb-3`. No drag handle or menu on the header row: the section's layout menu moves into the existing layout controls as `Move section…` (keyboard drag via dnd-kit remains on the first tile). Today's `1R 1Y` text goes.

### 4.5 Metric tiles

Per kind in §7. Common rules in §3.3. Whole-card click stays as a pointer shortcut (documented `eslint-disable` stays); the Expand icon button is the keyboard and screen reader path and the focus-return target.

### 4.6 Not reported

Mockup: `tile-states-1440.png` (bottom).

- Question: what is missing this month, and why?
- A wide card: `h2` `Not reported for Oct 2026` + `· 4 metrics` (12, ink/70); right: `Enter Oct 2026 data` secondary button (contributors and admins only; links to `/entry?period=2026-M10`).
- Table (`text-sm`, rows with 1px `ink/10` rules): Metric (`th scope=row`, 500) · Why · Category (hidden <640). Why strings: `Never reported`; `Last reported Jul 2026 (77%)`; `Quarterly: Q3 FY2026 is shown; Q4 is due after Dec`; `Twice a year: H1 FY2026 is shown; H2 is due after Dec`; `Not applicable: {reason}` when the scope cell is n/a.
- Fixes "next due" (today it names the period after the open one): the open period is due after its last month.
- Hidden when empty.

## 5. Quarterly and biannual metrics in month views

The month trend asks for 12 (or 24) month columns; quarterly and biannual metrics hold data only at their own grain, so every month cell is empty. Fix in the request, not the API:

- `columns.ts`: `coarseColumns(period, grain: 'quarter' | 'half', count, fy): Column[]`, the `count` periods of `grain` whose last month is on or before the selected month (Oct 2026 → Q4 FY2025…Q3 FY2026 for 4 quarters; H2 FY2025, H1 FY2026 for 2 halves).
- `scorecardViewRequest(state, tree, { coarse: true })` appends 4 quarters and 2 halves on the Overview (12 + 4 + 2 = 18 periods, within the API's 24 with the YTD column) and 8 quarters and 4 halves for one metric in the dialog. Requested only when a metric of that frequency is in the view's methodology (from `useVersions`), so monthly-only tenants send the same request as today.
- `metricScope` / `buildPoints` pick a metric's columns by `row.frequency`: monthly → month columns; quarterly → quarter columns; biannual → half columns. The board maps a quarter's cell to its last month's column and marks the other months Not due.
- Labels: `Q3 FY26` on axes (11/12px), `Q3 FY2026` in captions and tooltips, `Jul–Sep 2026` as the hover label's period line.

## 6. Uptime and other item-only metrics

### 6.1 Uptime tile

Mockup: `uptime-tile-1440.png`, `uptime-tile-390.png` (HTML `uptime-tile.html`).

- Question: is any service down, which, and how widespread?
- Header: title; subtitle `24 services · Green at 99.90%` (count of item rows; best band of the metric-level rule).
- Value row: `Worst` (12, ink/70), worst reported item name (16, 600), its value (28), chip `lg`. Worst = highest status rank, then lowest value (higher better) or highest (lower better), then name.
- Distribution: an 8px proportion bar (same segments as Health) `role="img" aria-label="18 Green, 2 Yellow, 1 Red, 3 not reported, of 24 services"`, then `18 Green · 2 Yellow · 1 Red · 3 not reported` (12; the best status bold) .
- Mini board: header row (`Service` 11px left, month initials 11px centered, `Oct` right, selected month accent-deep 600), then the 5 worst reported items: name (`min-w-[84px] truncate`, 12, 500), 12 cells (`StatusCell` size `sm`, 26px columns, 18px tall, letters), value (64px, right, 12, 600, tabular). `role="grid"` with the board's keyboard model; Enter on a cell opens the dialog at that item (`?focus=uptime&subject={id}`).
- Footer: `See all 24 services ›` (14, 500, accent-deep) opens the dialog; right `Worst first · Oct 2026` (11, ink/70).
- Fixed content height; never lists every item. Phone: 6 months (`older` columns hidden), name min 72px, value 56px.
- Item metrics with ≤ 5 items show all items and no footer link text change (`See trend ›`).

### 6.2 Uptime, expanded

Mockup: `uptime-expanded-1440.png`, `uptime-expanded-390.png` (HTML `uptime-expanded.html`).

Below the shared chrome (§8):

1. **Summary** (flex, wraps, `items-end justify-between`, gap 12/32px).
   - Left: headline `18 of 24 services Green` (28/36, 600; 20/28 on phones), then (14, ink/80) `◆ 1 Red · ▲ 2 Yellow · 3 not reported · Oct 2026` (shapes `aria-hidden`).
   - Right (left-aligned on phones): eyebrow `Worst now`, then name (16, 600), value (20, 600), chip `lg`; then `2 Red months in the last 12 · Platform` (12, ink/70; the item's org unit name).
   - `role="status"` is not used here; the summary is static text in a `section aria-label="Summary"`.
2. **Controls** (`role="toolbar" aria-label="Arrange services"`, 16px above the grid, gap 8/12px, wraps):
   - `Sort` label (12, ink/70) + segmented control (`role="radiogroup" aria-label="Sort services"`, Radix-free: buttons with `role="radio"`, arrow keys move the checked option): `Worst now` (default) · `Most Red months` · `Name`.
   - Filter input (shown when items > 12): 32px, 220px wide (full width on phones), search icon, placeholder `Filter 24 services`, `aria-label="Filter services"`, matches item name or org unit name, case-insensitive. A visually hidden `role="status"` announces `Showing 3 of 24 services`. No matches: a row `No services match “xyz”.` with a `Clear filter` link.
   - Range segmented control on the right: `6M` · `12M` · `24M` (default 12M, or the dialog's range when it is 3M/6M → 6M, YTD/12M → 12M, 24M → 24M). This replaces the range strip for item grids (the strip's change text has no meaning without a scope value).
3. **Grid card** (`bg-white border border-ink/20 rounded-lg px-4 pt-3 pb-2`):
   - Top row: range note (12, ink/70) `Nov 2025 – Oct 2026 · 12 months` (`Last 6 of 12 months` on phones) left; the board `Legend` right.
   - Table `role="grid" aria-label="Uptime by service and month"`, `table-fixed border-separate border-spacing-0`. Columns: Service (260px; 104px on phones), one per month (40px; 28px on phones), flexible gap, value (136px; 84px on phones), Red months (112px; hidden on phones).
   - Header rows: fiscal-year group row (11px uppercase 600 ink/70, left border `ink/20` at a year start), month row (12px 500 ink/70 centered; selected month `accent-deep 600` with the 2px accent underline; hovered column header bolds, as the board).
   - The selected column carries the board's current band (`bg-accent/10`) behind its cells.
   - Body row: row header `th scope=row`: name (14, 500, `line-clamp-2`) and org unit (11, ink/55, hidden on phones). Cells: `StatusCell` (24px tall buttons, tier fill, letter) with `cellName` accessible names (`Webhooks, Oct 2026: Red, 99.06%`) and the shared hover tip (value, period, status, streak, change). Value cell: value (14, 600, tabular) + chip (chip hidden on phones; the Oct cell carries the letter). Red months: count + a 44×6px bar (`bg-status-r`, width n/12), `—` when 0.
   - Sorting: Worst now = status rank of the selected column desc, then value (worse first by direction), then name. Most Red months = count of worst-status cells in the range desc, then Worst now. Name = locale compare. Items with no value in the selected column always form a final group with a `rowgroup` header `Not reported this month · 3` (11px uppercase), sorted by name; their value cell reads `Not reported` (12, ink/70) over `Last Sep · 99.98%` (11, ink/70; `Last Sep` on phones) or `Never reported`.
   - Rows: `hover:bg-ink/[0.035]`, `focus-within` the same. Row header is clickable for pointers (opens the trend) but is not a tab stop.
   - Keyboard: one tab stop (the first cell of the first row, or the last active cell). Arrow keys move; Home/End jump to the first month / the selected month; PageUp/PageDown move 10 rows; Enter or Space opens the item's trend; the grid's arrow keys never trigger the dialog's ← / → shortcuts (§8.4). Hint line under the grid (11, ink/70): `Arrow keys move between cells · Enter opens the service’s trend · Home/End jump to the first or current month`.
   - 24M on ≥1024px: 24 cells at 36px; when the card is narrower than name + 24 cells + value, the grid scrolls horizontally inside the card with the Service column `sticky left-0` (the only nested scroll allowed). Phones: the board's halving (last 6 of 12; last 12 of 24 at 28px with the same note).
4. **Item drill-in** (row chosen): URL gains `&subject={id}`. The grid is replaced by a breadcrumb row (12px) `‹ All 24 services` (link, accent-deep 500) `/` **Webhooks** `· Platform`, a value row (28px value, chip `lg`, change vs prior, `2 Red months in the last 12`), and the standard focus chart (`RatioChart`, `size="focus"`) for that item's row: bands, `Green 99.90%` guide pill, right axis, current pill, ribbon, the range strip (its changes now apply). `All services` restores the grid with the previous sort, filter and scroll position and moves focus to that item's row cell. Previous/next metric clear `subject`. Esc closes the dialog.
5. No Breakdown section and no `View as table` link (the More menu has it).

Logic: `logic/itemGrid.ts` (pure, tested):

```ts
export interface ItemRow {
  id: string; name: string; group: string // org unit name
  cells: BoardCell[]                       // one per column, statusBoard's BoardCell
  current: { value: number; display: string; status: string } | null
  lastReported: { label: string; display: string } | null
  worstCount: number                       // worst-status cells in range
}
export type ItemSort = 'worst' | 'reds' | 'name'
export function buildItemRows(children: ViewRow[], columns: Column[], scale: StatusScaleEntry[], unitName: (id: string) => string, fyStart: number): ItemRow[]
export function sortItems(rows: ItemRow[], sort: ItemSort, direction: Direction, scale: StatusScaleEntry[]): { reported: ItemRow[]; notReported: ItemRow[] }
export function itemSummary(rows: ItemRow[], scale: StatusScaleEntry[]): { total: number; best: number; counts: Map<string, number>; notReported: number; worst: ItemRow | null }
export function filterItems(rows: ItemRow[], query: string): ItemRow[]
```

The same components serve any item-kind metric (the noun comes from the item kind's name, lowercased: `services`).

## 7. Metric kinds: tile and expanded

Every kind uses §3.3 on tiles and §8 chrome in focus. Focus plot height stays `FOCUS_CHART_HEIGHT`; on phones the plot is `h-[max(280px,45vh)]` with its own geometry: right axis 48px, every other month labelled, ribbon cells 18px with letter only (no shape). Range strip on phones: label 14, change 11px on one line (`whitespace-nowrap`, `text-[11px]`).

### 7.1 Ratio and line (incl. days, lower-is-better scores)

Mockup: `focus-chrome-1440.png` (focus); tiles as today plus §3.3.

- Tile: subtitle = threshold sentence; bands at 7%; goal line dotted with no label (the subtitle names it); ribbon 18px. Lower-is-better metrics always say `Lower is better` in the subtitle; the change arrow keeps the value's direction (▲ for up) with tone by goodness.
- Focus: as approved, plus the value row's `Goal 90%` (14, ink/70) and `YTD 85%` when present; tick labels within 14px of the current-value pill are hidden so the pill never covers one; band pills unchanged.
- Breakdown (below the range strip), replacing the plain list: `h3` `By segment` / `By product` / `By service` (16, 600, accent-deep) and `Worst first · choose a segment to scope the dashboard to it` (12, ink/70). Table columns: name (`th scope=row`, link-styled button for org rows that calls `updatePeriod({ scope })`, item rows open the item drill-in), `Last 12 months` (12 `StatusCell xs` 14px, `aria-hidden`; hidden <640), value + chip (right), change vs prior (12, tone), `vs goal 90%` bar (8px track `ink/6`, accent fill at value%, a 2px `ink/50` tick at the goal; hidden <640). Sortable headers (`aria-sort`), default worst first.

### 7.2 Change rule (weighted defect score)

Mockup: `tile-states-1440.png` (top right).

- Tile and focus: no bands (correct today), but the subtitle states the rule (§3.5) and the focus definition line spells out all three outcomes.
- Methodology change marker: when `versionByPeriod` changes between adjacent columns, a dashed `ink/45` vertical line at the boundary with a 10px label at its top: `From records` when the newer version derives a measure of this metric, else the version name (`2026 v2`). Hover label on the marker: `Methodology changed: 2026 v2 from Jul 2026`. Applies to every line chart, not only change rules.
- Range strip shows the change in the header's terms: improvement percentage for change rules (`26% worse`), so the header and strip agree.

### 7.3 Discrete (quarterly, biannual)

Mockup: `bars-money-plan-1440.png` (right tile, bottom chart).

- Tile: last 4 quarters (2 halves); expanded: 8 quarters (4 halves). Context line `Latest: Q3 FY2026 (Jul–Sep) · Q4 is due after Dec`. Header value = latest period's value; change `vs Q2`.
- Bars from 0 on a 0–100% axis for shares (from 0 to the nice max otherwise), filled by status tier: Green `status-g-bg` with a 1px `status-g` edge, Yellow `status-y-bg` with a 1px `status-y` edge, Red solid `status-r` (the edges meet 3:1 non-text contrast). Value label above each bar (11, 600). Band zones behind at 7%. Ribbon under the bars. Max bar width 40px tile, 56px focus.

### 7.4 Money plan

Mockup: `bars-money-plan-1440.png` (left tile, middle chart).

- Question: over or under plan, by how much, how often?
- Value row: `104%` + `of plan` (14, ink/80) + chip + change. Context: `Over plan in 12 of the last 12 months`. When components exist (`ratioParts`): `$1,150k spent of $1,000k planned` (12, ink/70).
- Chart: diverging bars from a solid `ink/50` 100% line; up = over plan, down = under; filled by status tier as §7.3; deviation label at the bar's end (`+4%`, 11, 600); band zones (Green to 110, Yellow 110–120, Red above) at 7%; axis centered on 100%, padded to the largest deviation + 3 (at least ±15 pts). Focus: right axis ticks at the band edges only, and a `Plan` pill on the axis at 100% (ink/72, white 11px). Tile: `Plan` label (10, 600, ink/70) at the right end under the line.
- Exports (`chartSvg`) draw the same diverging bars.

### 7.5 Sparse (more n/a than values)

Mockup: `uptime-tile-1440.png` (right tile).

- Tile and focus: a 12-column board ribbon (18px tile, 24px focus) with the value above valued months (11, 600) and month labels below; context sentence `5 months with a major incident in the last 12; the rest are n/a` (from the n/a reasons when they agree, else `7 months n/a`). Footer `No incident: n/a` from the most common reason. Replaces the bordered chips (which looked like buttons).
- Focus: the same at full width, then a table of the valued months (month, value, status, change) and the range strip hidden (a 5-point change is not a trend).

### 7.6 Multi-series (no company total)

Mockup: `tile-states-1440.png` (top left).

- Header: `Worst {segment} {value} {chip}` and `1 of 4 segments Red` (12, ink/70). Subtitle explains: `4 segments · each runs its own survey, so there is no company total` (the definition's second sentence when present, else `4 segments · no company total`).
- Lines end in direct labels at the right (name in series color 11/600, value 11/600 ink, chip 24×14), stacked with 16px minimum spacing; the bottom legend goes. Bands at 8%.
- Focus: the same plus a per-series ribbon block under the plot (one 18px ribbon per series with its name), and the breakdown table (§7.1). Range strip shows `—` today; it is hidden for multi-series.

### 7.7 Uptime

§6.

### 7.8 Stopped reporting

Mockup: `tile-states-1440.png` (middle left). Value shown as history in `ink/55` with `Last reported Jul 2026 · nothing for Aug–Oct`; no current chip; the plot ends at the last value; the ribbon's no-data dots continue to now.

### 7.9 Never reported

Mockup: `tile-states-1440.png` (middle right). No plot. `No data yet` (14, 500), `Nothing has been entered for this metric. It is measured monthly, by product.` (12, ink/70), and for contributors and admins `Enter Oct 2026 data ›` (14, 500, accent-deep). The Expand button is hidden (nothing to expand); the dialog, if opened by URL, shows the same message centered.

## 8. Full-screen dialog chrome

Mockups: `focus-chrome-1440.png`, `focus-chrome-390.png` (HTML `focus-chrome.html`); the uptime mockup uses the same chrome.

### 8.1 Frame

`fixed inset-8` (≥768px), `inset-0 rounded-none` below 768px; `bg-cream rounded-lg shadow-xl flex flex-col overflow-hidden`. Header `px-6 pt-4 pb-3 border-b border-ink/15` (phones `px-4 pt-3 pb-2`), not scrolling; body `flex-1 overflow-y-auto px-6 pt-4 pb-6`.

### 8.2 Header

One row (wraps only on phones):

- Left: category eyebrow (11, uppercase, ink/70) over the title (`Dialog.Title`, 20/28, 600, accent-deep). One `h2`.
- Right, in order: metric navigation (`nav aria-label="Metrics"`): ghost icon button `ChevronLeft` 32px, `aria-label="Previous metric: {name}"`, `aria-keyshortcuts="ArrowLeft"`, `title="Previous metric (←)"`; position `7 of 15` (12, ink/70, tabular, 48px centered); `ChevronRight` likewise. A 1px `ink/15` divider. `Ask SAM` (32px secondary button with the `Sam` mark, `border-accent/40 text-accent-deep font-medium`), `aria-haspopup="dialog"`. More actions: ghost icon button `MoreHorizontal`, `aria-label="More actions"`, Radix `DropdownMenu`. Close: ghost icon `X`, `aria-label="Close"`, `title="Close (Esc)"`.
- Phones: row 1 eyebrow/title + Close; row 2 `‹ 7 of 15 ›` left, Ask SAM and More right.
- Under the row: the definition line (12/16, ink/80, max-width 820px): `{definition} {threshold sentence}. Source: {source}.` and a `Methodology ›` link (to the methodology page at this metric) when the user can read it. From `row.definition` and the metric's version content.

### 8.3 More actions menu

Radix `DropdownMenu`, 220px, `rounded-lg border border-ink/20 bg-white p-1 shadow-lg`, items 32px with `menuItemHighlight`. Items: `Copy link` (`L`), `View as table` (`T`), `Present` (`P`), separator, `Export PNG`, `Export SVG`, `Export CSV`. Shortcut hints as `kbd` chips on the right. Copy link: on success the trigger's accessible name and a visually hidden `role="status"` say `Link copied` for 2 s; on failure `Couldn’t copy the link` in the same status. Export failure messages stay as today (`We couldn’t make the image. Try SVG or CSV.`) under the header.

### 8.4 Keyboard shortcuts

Active while focus is inside the dialog and the event target is not an `input`, `textarea`, `select`, `[contenteditable]`, `[role=grid]` descendant, `[role=radiogroup]`, or the range strip: `←` / `→` previous / next metric; `1`–`5` ranges 3M, 6M, 12M, YTD, 24M; `T` table; `L` copy link; `P` present; `Esc` close (Radix). A hint row at the bottom of the body (11px, ink/70, hidden on phones): `← → previous / next metric · 1–5 range · T table · L copy link · Esc close`. Previous/next announce the new title (the title is the dialog's label; a polite live region says `{name}, 8 of 15`).

### 8.5 Body

Value row (§3.3 at focus size: value 28, chip `lg`, change 16px medium, goal and YTD 14px ink/70), then the kind's chart (§7), the range strip (as approved, with the caption `Change from the first month in each range to Oct 2026`, 11px ink/70, centered), the breakdown (§7.1), then the shortcut hint. The always-present `Loading chart…` status line goes: while the other window loads, the chart region keeps its size with `aria-busy` and a visually hidden status.

### 8.6 Ask SAM placement

Ask SAM stays the only labelled header action. When the drawer opens, the dialog stays open behind it (as today); focus moves to the drawer and returns to the Ask SAM button on close.

## 9. Accessibility

- Every status has a shape and letter (chips) or a letter (cells), plus words in accessible names; tier fills differ in form (soft, outlined, solid) as well as color.
- Grids (board, uptime, tile mini boards) follow the board's model: one tab stop, arrows, Home/End, Enter; `aria-label` per cell via `cellName`.
- Charts: SVG `aria-hidden`; a text summary (`trendSummary`) and the point buttons (`sr-only focus-within:not-sr-only`) stay; diverging and discrete bars get the same point buttons.
- Targets ≥ 24×24 (WCAG 2.5.8): icon buttons 32px, cells 24px (18px cells only where they are `aria-hidden` inside a larger control or in the tile mini grid, whose rows are also reachable in the dialog).
- Health toggles `aria-pressed`; segmented controls `role="radio"`/`aria-checked`; menus are Radix.
- Focus returns to the trigger on dialog close (`focusReturnRef`), to the item's row on leaving a drill-in, and to the first tile after `Show all`.
- Reduced motion: unchanged (`usePrefersReducedMotion`).

## 10. Responsive summary

| Width | Overview | Dialog |
|---|---|---|
| ≥1024 | Needs attention 3 columns; tiles 2 columns (small) or full (wide) | inset 32px; one header row; uptime 12 or 24 cells |
| 640–1023 | Needs attention 2 columns; tiles 2 columns | inset 32px (16 under 768) |
| < 640 | One column; control bar not sticky, collapsed to one 40px row `Oct 2026 · All of Acme Demo · Filters` that opens a bottom sheet (Radix Dialog) with the full control bar; mini boards and ribbons show the last 6 periods | Full screen; two header rows; phone chart geometry; uptime last 6 months, 104px names |

## 11. Reuse map

| Need | Reuse | Change |
|---|---|---|
| Cells, chips, legend, tooltip, roll-up, keyboard grid | `StatusBoard.tsx` internals | Extract to `web/src/ui/status/` (`StatusChip` with `size: 'md' \| 'lg'`, `StatusCell` with `size: 'md' \| 'sm' \| 'xs'`, `Legend`, `StatusCellTip`, `RollUp`, `useGridNavigation`) and re-import in `StatusBoard` with no visual change |
| Cell semantics | `logic/statusBoard.ts` (`BoardCell`, `buildBoardRow`, `cellName`, `streakAt`, `boardLayout`, `fiscalGroups`) | Add `notDue` kind; coarse-period mapping |
| Status at scope, worst child | `logic/statusAtScope.ts` | Caption gains not-reported count |
| Focus line chart | `charts/MetricChart.tsx` `RatioChart` | Phone geometry; tick/pill collision; methodology marker; direct labels for multi-series |
| Bars | `BarsChart` | Status-tier fills, value labels, diverging mode for money plan |
| Sparse | `LetteredChips` | Replaced by a ribbon with values |
| Uptime | `UptimeRows` | Replaced by `ItemSummaryTile` (Overview) and `ItemGrid` (dialog) |
| Ranges | `charts/ranges.ts` | Change-rule ranges in improvement terms |
| Exports | `exports.ts` `chartSvg`, `chartCsv`, `metricPng` | Money-plan diverging bars; item grid CSV (one row per item) |
| Needs attention | `logic/needsAttention.ts` | Streak ranking; reasons |
| Drivers | `FocusDialog` `rankedChildren` | Move to `logic/drivers.ts`, shared with cards and breakdown |

## 12. Verification

- Unit: `itemGrid.ts`, `statusText.ts`, `drivers.ts`, `coarseColumns`, `needsAttention` (streak), `buildBoardRow` (notDue), bar geometry helpers.
- Component (Vitest + Testing Library + `vitest-axe`): every new component has an axe test and keyboard tests (grid arrows, Enter, shortcuts ignored inside grids and inputs, menu items, toggles' `aria-pressed`).
- Full web suite: `npm --prefix web test`, `npm --prefix web run lint`, `npm --prefix web run typecheck`, with the total test count named.
- Visual: `make dev` screenshots at 1440 and 390 of every widget in both modes against the mockups below, no horizontal page overflow at 360, 390, 768, 1280, 1440, 1920 (`scrollWidth === clientWidth`).
- API: `go test ./internal/demo/...` (the demo covers every case above).

## 13. Mockups

HTML prototypes rendered from the demo tenant's real view (captured from `make dev`) and their screenshots at 1440 and 390 px, in the working folder `.superpowers/sdd/2026-11-16-dashboard-ux/mockups/` (local, not committed):

| Design | HTML | Screenshots |
|---|---|---|
| Uptime, expanded (grid, summary, sort, filter, drill-in) | `uptime-expanded.html` | `uptime-expanded-1440.png`, `uptime-expanded-390.png` |
| Uptime tile, section header, sparse tile | `uptime-tile.html` | `uptime-tile-1440.png`, `uptime-tile-390.png` |
| Health and Needs attention (incl. the item-metric card) | `overview-top.html` | `overview-top-1440.png`, `overview-top-390.png` |
| Focus dialog chrome, More menu, ratio chart, range strip, breakdown | `focus-chrome.html` | `focus-chrome-1440.png`, `focus-chrome-390.png` |
| Discrete bars and money plan, tile and expanded | `bars-money-plan.html` | `bars-money-plan-1440.png`, `bars-money-plan-390.png` |
| Multi-series, change rule, stopped, never reported, loading, error, Not reported | `tile-states.html` | `tile-states-1440.png`, `tile-states-390.png` |

Pink numbered pins and the "Design notes" panel in each mockup are annotations, not UI.

## 14. Decisions

1. **Scale labels over rank labels.** Health says `5 Red`, not `Off track 5`: one vocabulary with the board and the chips.
2. **Uptime headline counts Green, not a threshold.** `18 of 24 services Green`: per-subject bands (Status Page at 99.50%) make a single threshold untrue; the definition line states the thresholds.
3. **Not reported items sink to their own group** in every sort, so a missing report is never mistaken for a good or bad value.
4. **Needs attention ranks by Red streak first.** A metric Red for four months outranks one that turned Red this month by a larger margin; the reason line says which.
5. **No nested buttons.** Needs attention cards are single buttons; their ribbons are decorative and their names carry the statuses. Tiles keep a separate Expand button because they hold interactive point buttons.
6. **Item grids get a nested horizontal scroll only at 24M on desktop**, with a sticky name column; everywhere else the board's halving rule applies.
7. **Quarterly metrics are requested at their own grain** rather than having the API fill month cells; month cells between reports are Not due, not No data.
8. **Owner is out of scope**: the methodology has no owner field; the definition line shows Source.

## 15. Implementation tasks

Six reviewable tasks. 1 first; 2, 3 and 4 in parallel after it; 5 after 3; 6 after 2. Each ends with the full web suite green (named count), lint, typecheck, and screenshots at 1440 and 390 of the widgets it touched.

### Task 1 — Shared status primitives and vocabulary

- Files: new `web/src/ui/status/{StatusChip,StatusCell,Legend,StatusCellTip,RollUp}.tsx`, `web/src/ui/status/useGridNavigation.ts`, new `web/src/features/scorecard/logic/statusText.ts`, `logic/drivers.ts`; edit `StatusBoard.tsx` (import the extracted parts), `logic/statusBoard.ts` (`notDue` kind), `logic/statusAtScope.ts` (not-reported count in caption), `FocusDialog.tsx` (use `drivers.ts`).
- Interfaces: `StatusChip({ status, scale, size })`, `StatusCell({ cell, name, size, tabIndex, onFocus, onKeyDown, onClick, tip })`, `useGridNavigation({ rows, cols, onOpen }) → { active, cellProps(row, col) }`, `thresholdText(rule, format, direction, statusLabel, perSubjectNames)`, `worstChildren(children, columnKey, scale, direction) → { worst, worstCount, total }`.
- Tests: existing `StatusBoard.test.tsx` unchanged and passing; new `statusText.test.ts` (higher/lower/change/per-subject), `drivers.test.ts`, `useGridNavigation` keyboard tests; `statusAtScope` caption with missing children.

### Task 2 — Quarterly and biannual metrics in month views

- Files: `columns.ts` (`coarseColumns`), `viewRequest.ts` (`coarse` option), `viewHelpers.ts` (columns per frequency), `logic/statusBoard.ts` (map quarter cells to month columns, Not due), `OverviewPage.tsx` (Not reported reasons and next-due fix), `FocusDialog.tsx` (8 quarters / 4 halves), `charts/MetricChart.tsx` (discrete uses coarse columns).
- Interfaces: `coarseColumns(period: string, grain: 'quarter' | 'half', count: number, fy: number): Column[]`; `scorecardViewRequest(state, tree, { coarse?: boolean })`; `columnsFor(frequency, columns): Column[]`.
- Tests: `columns.test.ts` (Oct → Q4 FY2025…Q3 FY2026; fiscal starts other than January), `viewRequest.test.tsx` (18 periods; none added for monthly-only methodologies), `statusBoard.test.ts` (notDue and quarter mapping), `OverviewPage.test.tsx` (quarterly tile shows Q3 value; Not reported reasons).

### Task 3 — Item metrics: uptime tile, expanded grid, drill-in

- Files: new `logic/itemGrid.ts`, `ItemGrid.tsx`, `ItemSummaryTile.tsx`; edit `FocusDialog.tsx` (item grid for `chartKind === 'uptime'` and any item-only metric; `subject` param drill-in), `OverviewPage.tsx` (tile), `charts/MetricChart.tsx` (remove `UptimeRows`), `exports.ts` (item CSV).
- Interfaces: §6.2 `itemGrid.ts` signatures; `ItemGrid({ metric, rows, columns, scale, direction, noun, onOpenItem })`; `ItemSummaryTile({ head, children, columns, scale, onOpen, onOpenItem })`; URL `?focus={metric}&subject={itemId}`.
- Tests: `itemGrid.test.ts` (sorts, not-reported group, last reported, summary counts, filter), `ItemGrid.test.tsx` (keyboard, Enter opens item, filter announcement, 6-of-12 on narrow width, axe), `FocusDialog.test.tsx` (subject drill-in, back restores focus, prev/next clears subject), `OverviewPage.test.tsx` (uptime tile worst item and distribution).

### Task 4 — Full-screen chrome

- Files: `FocusDialog.tsx` (header, More menu, definition line, position, shortcuts, breakdown table, value row, loading state), new `FocusHeader.tsx`, `Breakdown.tsx`, `useDialogShortcuts.ts`.
- Interfaces: `FocusHeader({ eyebrow, title, position: { index, total }, prev, next, onAskSam, actions })`; `useDialogShortcuts(ref, handlers)` ignoring grids, inputs and radiogroups; `Breakdown({ head, rows, columns, scale, onScope, onOpenItem })`.
- Tests: `FocusDialog.test.tsx` (menu items and shortcuts, Copy link status text, ← → ignored inside the item grid and the filter input, focus return, position text, definition line), `Breakdown.test.tsx` (sort, scope button), axe.

### Task 5 — Overview top, tiles and sections

- Files: new `HealthSummary.tsx`, `AttentionCard.tsx`, `NotReportedCard.tsx`, `SectionHeader.tsx`; edit `OverviewPage.tsx`, `LayoutGrid.tsx` (pin Health then Needs; category eyebrow rule; section menu), `logic/needsAttention.ts` (streak, reasons), `ControlBar.tsx` (phone collapse, `--control-bar-h`), `MetricTile`-level header in `OverviewPage` (Expand icon, subtitle, remove `Current` line and table link).
- Interfaces: `HealthSummary({ counts, prior, total, period, selected, onSelect })`; `needsAttention(items, scale) → { shown: NeedsAttentionItem[]; total: number }` with `reason` and `streak` on each item; `AttentionCard({ item, meta, onOpen })` with an item-metric variant.
- Tests: `needsAttention` (streak order, reasons, total), `OverviewPage.test.tsx` (health toggles `aria-pressed`, Not reported filter, Show all, section roll-up text, no `Current:` line), `ControlBar.test.tsx` (phone sheet), `LayoutGrid.test.tsx` (pin order), axe.

### Task 6 — Chart kinds

- Files: `charts/MetricChart.tsx` (status-tier bars with labels, diverging money plan, sparse ribbon, multi-series direct labels and per-series ribbons, methodology marker, change-rule header terms, stopped/never states, phone geometry, tick/pill collision), `charts/ranges.ts` (improvement-terms change), `exports.ts` (money plan SVG), `charts/chartTheme.ts` (tier fill + edge helper for bars).
- Interfaces: `barFill(scale, status) → { fill, stroke }`; `moneyPlanDomain(values) → [lo, hi]`; `versionBoundaries(view, columns) → { index, label, title }[]`.
- Tests: `MetricChart.test.tsx` (each kind renders its parts and point buttons; diverging bars' direction; direct labels; marker present at a version change; never-reported tile has no plot), `ranges.test.ts`, `exports.test.ts` (money-plan SVG), `chartTheme.test.ts` (edge contrast ≥ 3:1).
