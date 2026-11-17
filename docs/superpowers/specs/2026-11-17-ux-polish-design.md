# OpsVision — UX polish: from good to world class

Status: revised after an independent design and engineering review (2026-11-17); for the maintainer's approval
Date: 2026-11-17
Extends: `2026-11-16-dashboard-ux-design.md` (the "dashboard spec"). Where they disagree, this document wins. Section numbers in the form "dashboard §6.3" point there.
Plan: `docs/superpowers/plans/2026-11-17-ux-polish.md`.

## 1. Intent

The dashboard overhaul shipped. The final review rated ten widgets "good" rather than world class, and the maintainer's own tenant showed two faults the demo had hidden:

- The expanded Uptime grid uses about 55% of the dialog at 1920px and leaves the rest empty.
- Long item names (35–48 characters, "Service - Region Environment" style) wrap to two lines, and "Not reported / No reports in 12 months" stacks into three, so rows have three heights and cannot be scanned.

The demo now reproduces that shape (Deployment uptime: 21 deployments, long names, 9 reporting and 12 not reported in the latest month, 8 with no reports in the last 12 months). An audit at 1920, 1440, 1280, 1024, 390 and 360px found 34 problems, five of them Critical (wrong or misleading information):

1. Truncation removes the part of a name that tells rows apart ("Identity Service -…" twice).
2. Every caption calls items "services" and unit children "segments", whatever they are.
3. A published report says "Data revised since publication" a minute after it is published.
4. A published report counts quarterly and twice-yearly metrics as Not reported.
5. (Same root as 1, on the tile.)

Success: at any width from 320 to 1920px, every item row is one line, the grid fills its card, the not-reported tail is short, and every chart shows what decides its status. On phones nothing scrolls sideways and the Report is readable. A published report counts each metric exactly as the Overview did when it was published.

## 2. Item grid, expanded (dialog)

Mockups: `uptime-grid-1920.png`, `-1440.png`, `-1024.png`, `-390.png`.

### 2.1 Columns

Inline mode, left to right:

1. **Name** (`th scope="row"`): one line (§2.3).
2. **Group**: the item's org unit, in its own column, only when the items span two or more distinct groups and the column fits (§2.2). Header: the org level noun of the groups, capitalized (`Segment`; `Group` when the units sit at different levels). Text 12/16, `text-ink/70`, `truncate`. The group tag beside the name goes.
3. **Periods**: the shown columns, as today (fiscal-year group row, selected column band, `StatusCell` 24px tall; it is `w-full`, so it stretches to the column's width less the 2px gutters: an 89px band at 1920).
4. **Value** for the selected period (§2.4).
5. **Red months** (the tenant's worst label + months), as today.

### 2.2 Width algorithm

Replace `itemGridLayout` with a fill layout. Every input is measured, not assumed.

```ts
interface ItemGridNeeds {
  name: number   // widest item name at 14px/500, + 12 (pr-3)
  group: number  // widest group name at 12px/400, + 16; 0 when fewer than 2 distinct groups
  value: number  // widest value cell (§2.4) + 12 (pl-3), clamped 96–168; a reported cell is text + 6 gap + CHIP_MD_WIDTH (28, the md chip's `w-7`)
  extra: number  // Red months: 112; 0 when the caller has none
}
interface ItemGridLayout {
  count: number; cellWidth: number; nameWidth: number; groupWidth: number
  valueWidth: number; extraShown: boolean; stacked: boolean; tableWidth: number
}
itemGridLayout(width: number, total: number, needs: ItemGridNeeds, opts?: { minInline?: number; stackBelow?: number; nameFloor?: number }): ItemGridLayout
// CELL_MIN 28, CELL_MAX 96, CELL_MAX_STACKED 56; defaults: minInline 6, stackBelow 600, nameFloor 240 (the tile passes 200)
```

1. **Stacked** when `width < stackBelow` (600). `count` = `min(total, 6)`, halved while `count × 28 > width`; `cellWidth = min(56, floor(width / count))`.
2. **Inline**: for `count` = total, then halved while `count ≥ min(minInline, total)`:
   - `name = min(needs.name, nameFloor)`; `base = count × 28 + needs.value + name`. If `base > width`, halve and retry.
   - Spend the remainder `rem = width − base` in this order: Red months (`needs.extra`, only if it fits whole); the name up to `needs.name`; the group column (only if `needs.group` fits whole); the cells, evenly, up to 96px each; then, once every column is full (only above about 2300px), the cells again, evenly and without a cap; the last `rem mod count` pixels go to the name column. The name never takes more than `needs.name` + `count − 1` pixels of leftover, so no column holds dead space.
   - `tableWidth === width` always: the table fills its card. Value and Red months sit right after the cells.
3. If no inline count fits, stacked as in 1.

Measuring: `textWidth(text: string, font: string): number` in `web/src/ui/textWidth.ts` draws on one cached `OffscreenCanvas`/`canvas` 2D context with the computed font family. Without a canvas (jsdom) it returns `ceil(text.length × size × 0.56)`. `ItemGrid` measures once per row set (memoized on names, groups, displays **and a fonts-ready flag**): `useFontsReady()` (in `textWidth.ts`) returns `false` until `document.fonts.ready` resolves, then `true`, so widths taken with the fallback font are measured again once the web font has loaded. Without `document.fonts` it returns `true`.

Expected, with the demo's deployments (`needs` name 332, group 76, value 132, extra 112):

| Grid width | Mode | Count × cell | Name | Group | Red months | Table |
|---|---|---|---|---|---|---|
| 1774 (1920 viewport) | inline | 12 × 93 | 338 | 76 | yes | 1774 |
| 1294 (1440) | inline | 12 × 53 | 338 | 76 | yes | 1294 |
| 1134 (1280) | inline | 12 × 40 | 334 | 76 | yes | 1134 |
| 878 (1024) | inline | 12 × 28 | 298 | — | yes | 878 |
| 600 | inline | 6 × 28 | 300 | — | no | 600 |
| 340 (390) | stacked | 6 × 56 | — | — | — | 336 |
| 310 (360) | stacked | 6 × 51 | — | — | — | 306 |

The 24 short service names (`needs.name` 150, `group` 76) at 1294: 12 × 68, name 158. The deployments over 24 months at 1294: 24 × 29, name 354, no group column; at 878: halved to the last 12, with the note `Last 12 of 24 months`.

### 2.3 Names: one line, keep the part that differs

- Every item name renders through `ItemName` (`web/src/ui/status/ItemName.tsx`) on one line. Rows are never clamped to two lines.
- `splitItemName(name): { head: string; tail: string }` (`web/src/features/scorecard/logic/itemName.ts`) splits at the **last** separator among ` - `, ` – `, ` — `, ` · `, ` / `, `: ` (with the spaces on both sides; a separator at the very start or end does not count). With no separator, a name of three or more words keeps its **last two words** as the tail (`Payments Gateway (EU Primary)` → head `Payments Gateway`, tail ` (EU Primary)`); a name of one or two words is all tail.
- Layout (CSS only, no measuring): a flex row. Head `min-w-0 shrink truncate`; tail `shrink-0 whitespace-pre overflow-hidden text-ellipsis max-w-[calc(100%-8ch)]` (the tail includes the separator; `whitespace-pre` keeps its leading space and, like `nowrap`, keeps it on one line, so `truncate`, which sets `nowrap`, is not used on it). The head shrinks first; the tail is cut only when it alone exceeds the space less 8 characters. With no head, the tail is `min-w-0 truncate`. Result: `Analytics Warehouse… - Batch Loader Primary`, `Identity Serv… - Staging Mirror West`.
- The full name is always in the DOM text (screen readers read it), in every cell's accessible name (`cellName`, unchanged), and first in the cell tooltip (§2.7). Pointer hover on a truncated name shows the app tooltip (Radix `Tooltip`, 400ms delay, ink style of dashboard §3.7) with the full name and the group; no native `title`.
- Used by: the dialog grid, the uptime tile rows (§3.1), the Needs attention mini board, the board's Current caption (§11), the drill-in breadcrumb, and Worst now on phones.

### 2.4 Row height and value cell

- Every row is **32px** (24px cell + 4px above and below), reported or not, inline or the cell row of a stacked item. Stacked name rows are 24px.
- Reported: value 14/600 `tabular-nums` + `StatusChip` md (hidden when stacked, where the cells carry the letter).
- Not reported this period, one line, 12/16 `text-ink/70`, `whitespace-nowrap`:
  - stopped: `Last Sep 100.00%` (the last column with a value, its short label and display); stacked: `Last Sep`. When the window is longer than 12 months the label carries the year: `Last Dec 2025 99.20%` / `Last Dec 2025`.
  - not applicable: `n/a` (reason in the cell tooltip).
- The group header already says "Not reported this month", so the cell never repeats it.

### 2.5 Groups of rows

**Silent** means: no value and no status in **any column of the window** (`columns`, the 6, 12 or 24 periods of the range), whatever number of columns the layout shows. An item with a value only in a column that the layout halved away is not silent; it is not reported this period. `partitionItems` (§17) and `visibleItemOrder` use the window, so they agree with the grid at every width.

`tbody` groups, in this DOM order, each with a `rowgroup` header (11px uppercase 600 `ink/70`, as today):

1. Reported this period (no header).
2. `Not reported this month · 4`: items with a value somewhere in the window but not in the selected column, by name.
3. `Not applicable this month · n`, as today.
4. `No reports in the last 12 months · 8` (the window's span and unit, `columnUnit`): the silent items. It comes **last**: its header row in one `tbody` and its item rows in a second `tbody` (`id`) rendered only while expanded, so the button is the next tab stop after the grid's cells. **Collapsed by default.** The header holds a button `Show 8 deployments` (12px 500 `accent-deep`, 28px tall, `aria-expanded`; `aria-controls` the rows' `tbody` id only while expanded, because a collapsed group's rows are not rendered), then, at 640px and wider, a one-line preview of the first names (12px `ink/70`, `truncate`). Expanded: the rows (by name) and the button reads `Hide`. Collapsed rows are not rendered, so arrow keys never land on them.
   - Under 640px the header is two lines: `No reports in the last 12 months · 8` (11px uppercase) and, under it, the button (left-aligned); no preview.

- While the filter has text, group 4 shows its matching rows expanded and the button is hidden (`No reports in the last 12 months · 2 match`).
- Expanded state lives with the dialog body (like the filter), survives the drill-in, and resets on previous/next metric. `ItemGrid` takes `silentOpen?: boolean` and `onSilentOpen?: (open: boolean) => void`; uncontrolled when absent.
- Returning from a drill-in on a silent item while the group is collapsed (the item was opened from a link or a tile) **opens the group**, then focuses the item's selected cell and announces `Showing 8 more deployments`, so focus never falls back to the dialog frame.
- The summary still counts all 12 as not reported, and exports (CSV, SVG, PNG) still list every item: grouping is presentation only. `sortItems` and `itemSummary` are unchanged.

### 2.6 Summary and toolbar

- Desktop: unchanged (dashboard §6.5 item 1).
- Under 640px container width: the headline 20/28; counts line as today; `Worst now` becomes two lines: eyebrow + `ItemName` (14/600) on the first, value 20/600 + chip `lg` + `Red since Oct 2026 · 1 month` (12) on the second. The group and Red-month count move out (they are in the drill-in).
- Under 640px the legend is one line (`flex-nowrap`, 10px gaps, 11px labels), showing only the keys present (§2.7). Green, Yellow, Red and No data come to about 270px (three 28px chips + 4px + label, the no-data dot + label), inside the 294px card content at 360. If a tenant's labels are longer, the legend wraps rather than clipping.
- Target: the first grid row starts within 300px of the dialog body's top at 390 × 844 (today about 415px). This needs both the two-line Worst now and the one-line legend.

### 2.7 Legend and tooltips

- `Legend` gains `present?: Set<string>`: the keys shown are the scale statuses, `missing` (No data), `na`, `unrated` and `notDue` that occur in the shown cells. Absent `present` keeps today's behavior (the board).
- `StatusCellTip` gains `title?: string`, rendered first (12px 600, `max-w-64`, wraps): the full item name, then ` · {group}` in `text-white/75`. The grid passes it for every cell.

### 2.8 Keyboard and accessibility

Unchanged grid model (dashboard §6.5): one tab stop, arrows, Home/End, PageUp/PageDown, Enter. New: the Show/Hide button (in the last `tbody`) is the next tab stop after the grid; activating it keeps focus on it and announces `Showing 8 more deployments` / `Hid 8 deployments` in the surface's polite region. The group column is plain text (`td`), skipped by arrows. With a filter that matches only silent items, the grid's tab stop is the first match's selected cell and ArrowDown reaches the second.

### 2.9 States

Loading: the grid card's skeleton is 32px rows. Empty filter: unchanged copy, centered in the card. One item: no filter, no sort control. All items silent: group 4 open by default (nothing else to show).

## 3. Item surfaces outside the dialog

### 3.1 Uptime tile

Mockups: `uptime-tile-1440.png`, `-390.png`.

- Columns first: §2.2 with `needs.value` measured from the candidate rows (about 68: `99.63%` at 12px/600, or `Last Sep`), no group or extra, `nameFloor` 200 and `stackBelow` 400 (phones stack; a half-width desktop tile stays inline). On a 536px tile the deployments need 604px for 12 months, so the tile shows the latest 6 (names 300px) and the footer's right side reads `Exceptions first · last 6 months · Oct 2026`. The 24 short service names (`needs.name` 120) need 524px and keep 12. Below 400px: stacked rows (name and value on one line, cells below, 18px tall).
- Then exception rows, at most 5: reported items that are not at the best status (worst first, as today); then items that stopped reporting **whose last report falls inside the shown columns**, most recent first. Items with no reports in the window, and items whose last report is older than the shown columns, never get a row: a row of dots tells the reader nothing.
- Footer line (12, `ink/80`), parts joined by ` · `: `All other 8 deployments Green`; `1 more stopped reporting` when stopped rows were cut by the limit of 5; `1 stopped before May` for stopped items whose last report is before the first shown column (the first shown column's short label); `8 with no reports in 12 months`. When every item is best: `All 21 deployments Green`.
- Names through `ItemName`. Not reported on the tile: `Last Sep` (11, `ink/70`; with the year when the window is longer than 12 months); the value is in the dialog.
- Row button names are unchanged (dashboard §6.4).

### 3.2 Needs attention mini board

Names through `ItemName` (96px column, as today).

### 3.3 Nouns in captions

`metricNoun` and the `noun` of `statusAtScope`/`periodStatus` become `NounForms` (dashboard §3.8):

- Item metrics: the item kind's name (`useItemKinds`) when the caller has it, else the kind id from the metric's `reportedAt` (`nounFromId('deployments')` → `deployment`/`deployments`, hyphens and underscores read as spaces).
- Unit children: the org level of the children (`useOrgLevels` by depth), else `unit`/`units`.
- `statusAtScope` and `periodStatus` accept `NounForms` or the old strings (`'segments' | 'services' | 'items'`, mapped to forms), so callers move one at a time. The two primitives (`nounFromId`, `statusAtScope`'s wider type) land first; callers (`FocusDialog`'s hard-coded `'services'`, standings, the board) follow.
- Captions: `worst of 9 deployments · 12 not reported`, `worst of 2 products`.

## 4. Drill-in

Mockups: `drill-in-1440.png`, `drill-in-390.png`.

- **Step through items.** The breadcrumb row gains, at its right end, `‹ 1 of 13 ›`: two 32px ghost icon buttons (`aria-label="Previous deployment: {name}"` / `"Next deployment: {name}"`, `aria-keyshortcuts="K"` / `"J"`) around the position (12, `ink/70`, tabular). The order is the grid's visible order (`visibleItemOrder`: sort, filter, the silent group only when open). At the ends the button is disabled; there is no wrap-around. When the item is not in that order (opened by link while its group is collapsed, or the filter excludes it), the position reads `–`, Previous is disabled and Next goes to the first item of the order. Stepping replaces the history entry (`item=`) **and keeps `location.state`** (the `{ itemGrid: true }` marker that lets Back return to the grid with `navigate(-1)`), keeps focus on the pressed button, and announces `{name}, 2 of 13`. Phones: the stepper sits on the breadcrumb's second line, right-aligned.
- **Keys** (dialog shortcut rules, dashboard §8.4): `J` next item, `K` previous item, in a drill-in only. Esc in a drill-in returns to the grid (focus on the item's selected cell, as `All {n}` does, opening the silent group first when the item is in it, §2.5); Esc in the grid closes the dialog. The hint row reads `← → previous / next metric · J K next / previous {noun one} · 1–5 range · Esc back to all {noun many}`.
- **Chart** (drawn by `RatioChart` for item rows): straight segments and a 3px dot per period (current 4px, filled) instead of `monotoneX`. Threshold lines: a dashed line at each band edge inside the domain, labelled at the right `Green 99.90%` / `Red 99.80%` (11, `ink/70`; phones `G 99.90` / `R 99.80`). **An axis tick within 12px of a threshold line is dropped**, so a label never prints over a tick (`99.80%` tick under `Red 99.80%`). Value labels on the current point (to its left), the lowest point and the point with the largest change from its predecessor; no others; a label that would collide with another (within 14px) is dropped, current first kept.
- **Monthly values**: a `Monthly values` disclosure button (secondary, 32px, `aria-expanded`, collapsed by default) under the range strip. Open: a table (`max-w-[640px]`, 14px rows 32px): Month (`Oct 2026`) · value (header = metric name's unit word, `Uptime`) · Status (chip + label) · Change (vs prior month, toned, `0.00 pts` when equal, `—` when either side is missing), newest first, all shown periods. Open state persists for the dialog session.
- **Range strip**: a range whose first column has no value for this item shows `No data then` (11, `ink/70`) under its label and is not a button (`aria-disabled`, skipped by its arrow keys).

## 5. Coarse metrics (quarterly, twice-yearly, yearly)

Mockup: `tiles-coarse-money-1440.png`, `-390.png`.

### 5.1 Quarterly (four or more periods shown)

- Tile and full screen: straight segments and a dot per period (`RatioChart` `curve: 'linear'` for coarse rows). Value labels on every point (tile and focus), as today.
- **Next period ghost**: one extra slot after the last period, drawn with a dashed 4px ring at the last value's height, a dashed connector, and `due Jan` (11, `ink/70`) above; its axis label is the next period (`Q4 FY26`, `ink/55`); the ribbon gets a dashed empty cell. The state comes from `coarseStatus(row, columns, selected, fy)` (dashboard §5.3) with `selected` = the **selected period** (the month the user picked), which callers pass to `MetricChart` as `selectedPeriod`; the chart's `currentColumnKey` is the counted quarter and cannot be used for it. `current` or `due` → `due Jan`; `overdue` → `overdue` in `text-status-r`; without `selectedPeriod` no ghost is drawn.
- **Thresholds in view**: the y-domain is padded to include the nearest band edge above and below the data when that edge is within 12 points (percent) of the data; each edge inside the domain is a dashed line labelled at the right (`90%`, `80%`), and an axis tick within 12px of one is dropped (§4).

### 5.2 Twice-yearly and yearly (three periods or fewer on a tile)

- Tile: **period cards** instead of a line: the **last two** periods plus the next one, so always three cards (a yearly metric's tile shows FY2024, FY2025 and the due FY2026; the third year stays in full screen). `grid-cols-3` at ≥ 360px tile width, else `grid-cols-1` (stacked). Each `rounded-lg bg-ink/[0.035] px-3 py-2.5` with the period and its months (`H1 FY26 · Jan–Jun`, 11, `ink/70`) and the value (20/28, 600 for the latest, 500 otherwise) + chip md. The next period is a dashed card (`border border-dashed border-ink/20`, no fill) reading `Due by Jan 2027` (12, `ink/70`); overdue: `Overdue since Jan 2027` in `text-status-r`. The next period and its state come from `coarseStatus` with `selectedPeriod` (§5.1); without it the third card is not drawn.
- The value row's change reads `vs H2 FY25` (full period, since there are so few).
- Full screen keeps the line chart (four halves or three years) with 5.1's linear segments, ghost and thresholds.

## 6. Money plan

Mockup: `tiles-coarse-money-*.png`.

- **Compact amounts** in the value row, on the tile and in full screen: `formatMoneyCompact(value: number, unit: string): string` in `charts/moneyPlan.ts`: for `$k` units, `$12.7M` from 1,000k (one decimal, `$1.0M`), `$950k` below; other units as `format.ts` formats them. Tile copy: `$12.7M spent of $12.2M planned · over plan in 12 of the last 12 months` (one line, 12, `ink/70`); full screen appends `$12.7M spent of $12.2M planned` to the since-when extras.
- **Axis follows the data**: up = over plan. When every deviation in view is ≥ 0, the under-plan side is `max(3, round(0.2 × over))` points; when every one is ≤ 0, the mirror; mixed keeps the symmetric domain. Over side: `max(largest deviation, 12) + 3`.
- **Threshold lines**: dashed, in the color of the status the edge starts: `status-y` at 110%, `status-r` at 120%, each only when inside the domain. Full screen labels them at the right: `110% Y`, `120% R` (11, `ink/70`).
- **Narrow slots** (under 32px per month; a 390px phone tile without the rail has about 27px): deviation labels only on the current month and the largest deviation; month labels on every other month and the current one. "Plan" moves to the left end, above the 100% line. The ribbon gets `phone` (dashboard review).

## 7. Sparse (more n/a than values)

- Full-screen table at full width, columns: Month · the value (header `parts.valueLabel`, `On time`; `Value` without parts) · the parts when the formula is a ratio of two measures: `4 of 5 on time` (header `parts.denominatorLabel`, `Postmortems`) · Status · `Change vs previous report` (`▼ −20 pts vs Aug`; the oldest `First in the window`).
- `MetricChart` cannot see the methodology, so the caller (the dialog) passes `parts?: { valueLabel: string; denominatorLabel: string; numerator: string; denominator: string }`: the measure keys from `ratioParts(metric.formula, cell.components)` and labels from the metric and the denominator measure's name (`valueLabel`: the metric name's last word, lowercased after the first letter, `On time` for `Incident postmortems on time`; `denominatorLabel`: the measure name, `Postmortems due` → its first word, `Postmortems`). Without `parts` the column is absent.
- Under the table, one line: `n/a in 7 months (Nov, Jan, Feb, Apr, May, Jul, Sep): {reason}` when every n/a shares the reason; else `n/a in 7 months` and the reasons in each month's tooltip.
- Phones: the parts join the value cell (`80% · 4 of 5`), and the change column shortens to `▼ −20 vs Aug`.

## 8. Multi-series (no company total)

Mockup: `tiles-sparse-multi-1440.png`, `-390.png`.

- **Tile, focus and context**: the worst series (the header's `Worst {segment}`) is drawn in the **accent** (`--color-accent`) at 2.5px with a 4px end dot, whatever its position in `LINE_COLORS`, so the focus color is the same on every tile; the others in `ink` at 38% opacity, 1.5px, 3px end dots. All end labels stay (name 11/600 in the accent for the worst, `ink/70` for the rest; value; chip), 16px apart. Pointer hover on an end label brings that series forward; the labels stay decorative (`aria-hidden`), and keyboard and screen reader users have the chart summary and the breakdown. Straight segments.
- **Small multiples**: under each panel's ribbon, month labels (11, `ink/70`; the selected month `accent-deep` 600): short labels (`Nov`) when the panel is at least 360px wide, initials (`N`) below. Panels use straight segments too.

## 9. Change rule (weighted defect score)

Mockup: `tiles-sparse-multi-*.png`.

- **Change bars** under the level line, `ChangeBars` (`charts/ChangeBars.tsx`): one bar per period of the change that set its status. The engine's `cell.change` with `changeKind: 'improvement_pct'` is positive = **better** (`engine/metric.go`), so the bar's value is **`worse = −cell.change`**, drawn up when positive. Zero line `ink/55`; a dashed `status-r` line at the Red boundary (the rule's worst band edge in the same terms, `−(−5) = +5%` worse) labelled at the right `+5%`; `worse` above and `better` below the axis on the right (10, `ink/70`). Fill by the status each change earned (Green tint + edge, Yellow tint + edge, Red solid). Labels (10, 600) on Yellow and Red bars only: `+27%`.
- Caption follows the rule's `compare`: `prior_period` → `Change vs the prior month` (the grain's word: `prior quarter`); `prior_year_average` → `Change vs last year's average`; `baseline` → `Change vs the baseline`.
- Tile: level line 48px (no axis, the current value labelled), then the caption (11, `ink/70`), the 64px bars, the ribbon and month initials. Full screen: the 120px bar panel sits between the chart and the ribbon, with right-axis ticks at 0 and each band edge.
- The bars are `aria-hidden`; the chart summary adds `Changes: Sep 27% worse (Red), Oct 26% worse (Red)` for every non-best period in view.
- Definition: already reads once in the shipped app (`DefinitionLine` drops a threshold clause the definition states, since `9b6cd75`): `Severity-weighted open defects per day. Judged on change against the prior period; lower is better. Green: any improvement · Yellow: up to 5% worse · Red: more than 5% worse.` No change; the audit screenshot `focus-change-1440.png` confirms it.

## 10. Category section header

- `h2` 16/24 600 `accent-deep`; then `3 metrics` (12, `ink/70`); right-aligned, the roll-up as small chips with counts (`◆R 2` `▲Y 1`, `StatusChip` md + count 12/600), or `All Green`.
- `id="section-{categoryId}"` and `scroll-margin-top: calc(var(--control-bar-h, 0px) + 16px)`. Tiles get the same `scroll-margin-top`.
- Hidden when the Health filter leaves the section without visible tiles (review item), and the board group then reads `· none match` (12, `ink/70`).
- On the status board, each category group label becomes a link (`href="#section-{id}"`, 11px uppercase as today, `hover:underline`) that scrolls to the section and moves focus to its `h2` (`tabIndex={-1}`).

## 11. Status board

- **Sticky month header**: the board's `thead` (year row and month row) is `position: sticky; top: var(--control-bar-h, 0px)` with `bg-white` and a 1px `ink/10` bottom border while stuck; desktop and phones.
- **Current caption for item and no-total rows**: line 1 the value (worst child's, as today); line 2 `{ItemName of the worst child} · {k} of {N} {worst label}`, `N` = all items. `ItemName` keeps the tail, so a narrow column reads `Notification… - Multi-Region Active · 1 of 21 Red` (the `· 1 of 21 Red` part is `shrink-0`); the not-reported count moves into the row's accessible name (`Deployment uptime, Oct 2026: 99.63%, Red; worst Notification Relay - Multi-Region Active; 1 of 21 Red; 12 not reported`).
- **Year header** in one-column groups: `FY26` (short form) instead of a truncated `FY2…`.

## 12. Customize layout on phones

Mockup: none (pattern below is complete).

- Under 640px, Customize mode renders every block as a **compact row** instead of its content: `min-h-14 rounded-lg border border-dashed border-accent/45 bg-white px-3 py-2`, the title (14/600, `line-clamp-2`), for a hidden-able tile nothing else; right side: `Move up` and `Move down` icon buttons (32px ghost, `ChevronUp`/`ChevronDown`, `aria-label="Move {title} up"`), then the layout menu (32px) with `Hide`, `Move to top`, `Move to bottom`. Size options are not shown (one column on phones).
- Sections render as a section row (`Section · Engineering`, 12/600 uppercase `ink/70`) with their tiles indented 12px beneath.
- Move up/down keeps focus on the same button of the moved row and announces `Moved Uptime to position 4 of 16` (polite). At the ends the button is disabled.
- The bar stays one row (`Customizing layout`, menu, `Done`). Done or Esc leaves and returns focus to `Customize layout`.
- Desktop is unchanged.

## 13. Report page on phones and the phone shell

Mockup: `report-phone-390.png`, `-360.png`.

### 13.1 Shell

- Under 640px the 64px icon rail is not rendered. The top bar gains a 40px menu button at its left (`Menu`, `aria-label="Open navigation"`, `aria-expanded`), which opens the navigation in a left drawer (Radix `Dialog`, `w-[min(320px,85vw)]`, full height, the expanded nav with labels; focus moves to the first link; Esc, a link, or any route change closes it, and focus returns to the menu button).
- The top bar stays as today: not sticky on phones. The shell root publishes `--top-bar-h` (`0px` while the top bar scrolls away, which it always does under 640px) so sticky elements below it can offset by `calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))`; the control bar already publishes `--control-bar-h` as `0px` on phones.
- Content width at 390 becomes 358px (today 277px). Fixes the 320px sideways scroll the final review logged against `AppShell`.

### 13.2 Report page

- Header: title, scope line and status line as today. Actions under 640px: `Publish` (primary, admins), `Download` (secondary with `ChevronDown`, a Radix `DropdownMenu` with `PowerPoint (.pptx)` and `PDF`); `Use my layout` becomes a `role="switch"` (32×18 track) on the next line.
- Health: the Overview's chips (`StatusChip lg` + count 16/600 + label 14), a 2 × 2 grid under 640px. Report cards use `StatusChip` (shape and letter) everywhere a status pill appears.
- **Metrics this month** (the table) under 640px renders as a two-column status table, `ReportStatusList`, **one `tr` per metric**:
  - Columns: `th scope="row"` (the metric, `w-[38%]`, 14/600, wraps to three lines) and one `td` holding, stacked: the value line (value 14/600 + chip md, right-aligned), the caption (11px `ink/70`: `YTD 87%`, the counted period for coarse metrics `Q3 FY2026 · Q4 due by Jan`, or the worst child for item and no-total metrics `Notification… - Multi-Region Active · 1 of 21 Red`), and the six months as 24px `StatusCell`s in a 6-column grid (`aria-hidden`), followed by a visually hidden list of the months' values (`Jun 2026: 88% Green; …`). So each metric is one row for a screen reader: its name, then everything about it.
  - One sticky header row in `thead`: an empty `td` over the name column and a `th` holding the six months' short labels in the same 6-column grid (the report month `accent-deep` 600), `position: sticky; top: calc(var(--top-bar-h, 0px) + var(--control-bar-h, 0px))` (0px on phones today), `bg-white`, 1px `ink/10` bottom border.
  - Category rows: a `th scope="rowgroup" colSpan={2}`: `Delivery · ◆ 1 Red · ▲ 1 Yellow` (11px uppercase 600 `ink/70`).
  - Coarse metrics: their period's cell in its last month, `notDue` elsewhere (dashboard §5.4).
- `document.documentElement.scrollWidth === clientWidth` at 320–639px.
- Desktop unchanged.

## 14. Published reports: what the snapshot must contain

### 14.1 The problem

`PublishReport` stores `report.Document{ View }` computed by `reportViewRequest`: the report month and the five before it, plus YTD. The web counts a **live** report from the Overview's request (12 months and the coarse periods of dashboard §5.2) so the report and the Overview agree; a **published** report can only count from the snapshot, where quarterly, twice-yearly and yearly metrics have no counted period (they show as Not reported) and streaks stop at 6 months.

Separately, every published report reads "Data revised since publication" as soon as it is opened. A YTD cell carries the month it runs through as its `period` (`engine/view.go`), and `diffReportViews` keys the snapshot's cells by metric, subject and period without YTD, so for the **report month** the YTD cell overwrites the month cell; the live loop skips YTD and compares the fresh month cell with the stale YTD value. Only the report month is affected (all 148 lines in the audit are `Sep 2026`), which is every metric whose year-to-date value differs from its month value. The fix also repairs existing v1 snapshots.

### 14.2 Snapshot v2

`report.Document` gains:

```go
SchemaVersion int             `json:"schemaVersion,omitempty"` // 2 for new snapshots; absent (0) = v1
Standing      json.RawMessage `json:"standing,omitempty"`      // ScorecardView, see below
```

`Standing` is the view the Overview would have requested for the report month at the company scope:

- Periods: the 12 months ending at the report month; then, for each frequency coarser than monthly used by a metric of the version in force for the month (`engine.VersionFor`), `COARSE_SPAN` periods of that grain (4 quarters, 2 halves, 3 years) by the web's `windowColumns` rule: the grain's period containing the report month, stepped back one when it ends after the report month, then the ones before it. Oct 2026 with a January fiscal year: `2025-Q4 … 2026-Q3`, `2025-H2, 2026-H1`, `FY2023 … FY2025`. YTD through the report month. `Structure: as-of`. This is exactly the set `metricStandings` requires to treat a grain as present (`standings.ts`: every coarse column must be in `view.periods`).
- Rows: every row, as `View`. Cells: month and YTD cells for every row; a coarse-period cell only on rows whose metric reports at that grain (the others are dropped before storing, to keep the snapshot small).
- Built by `report.StandingPeriods(cal period.Calendar, month period.Period, freqs []domain.Frequency) []period.Period` (pure, tested against fiscal years starting in January and July) and a `standingView` step in `PublishReport`, through the same `engine.Compute` + `apiView` path as `View`. `loadInput` is called with `fiscalYears(true, <every standing period>…)`, because annual standing reaches back to FY2023.

`View` is unchanged (the table, charts and exports still draw six months).

### 14.3 API

- `GET /scorecards/{sc}/reports/{period}` gains an optional query parameter `standing` (boolean, default false). `ReportDocument` gains `standing?: ScorecardView`, **returned only when `standing=true` is asked** and the revision's snapshot has one, filtered by the caller's access exactly as `view` (`filterScorecardView`; the access input is loaded once for both). Absent for live documents (the web keeps its own Overview request) and for v1 snapshots.
- Only the web asks for it (`useReportDocument` always sends `standing=true`). The MCP catalog turns every OpenAPI query parameter into a tool argument, and SAM uses that catalog, so the parameter carries the extension `x-mcp-hidden: true` and `mcp.BuildCatalog` skips parameters marked with it. MCP's `get_report_document` and SAM's tools therefore never pass `standing`, and their results are unchanged: oapi-codegen orders fields alphabetically, and a large `standing` block would otherwise sit before `summary` and `view` and be cut by SAM's 64 KB and MCP's 512 KB result limits. A test asserts the MCP tool result contains `summary` and no `standing`.
- OpenAPI: add the parameter and the optional property, each with a description; `make gen`; `make gen-check` passes. `ReportChange.period` is already any grain, and the page labels changes with `periodLabel`, so a `2026-Q3` change line renders correctly.
- Size: the default response (no `standing`) for the demo's published month stays under **900 KB raw** (clients that do not send `Accept-Encoding` get raw JSON; today about 690 KB), and the `standing=true` response stays under 400 KB gzip-encoded (the web always sends `Accept-Encoding`). Both are asserted.
- Facts (Go `report.Facts`): `FactsRow` gains `Frequency`, and a metric whose frequency is coarser than monthly is left out of the `not reported` sentence (it has no month cell by design). The web already restates that sentence from its own count; this stops MCP and SAM calling quarterly metrics not reported.

### 14.4 Data revised

- `diffReportViews` **leaves YTD cells out** of the comparison: it skips `c.Ytd` when building the snapshot's cells, as the live loop already does. A month revision already shows as a month line; a YTD line would be labelled with the month and mislead. This alone fixes the false "Data revised".
- For a v2 revision, the fresh comparison view is computed **once**, with the snapshot's own `standing.periods` (not recomputed from today's version), filtered for the caller like the snapshot. The diff compares its month cells with the snapshot's `view` months, and its non-month cells with the snapshot's `standing` non-month cells, so a revised Q3 shows as `Concepts delivered expected value, Acme Demo, Q3 FY2026: 83% Y → 85% Y`. A v1 revision keeps today's six-month fresh view.
- Test: publish, then read: `dataRevised: false`, `changes: []`.

### 14.5 Backward compatibility

- v1 snapshots (no `standing`) are served as today; the server never fills them from live data (a published report does not change). Old servers ignore the unknown fields, so a rollback is safe.
- The web, for a published document without `standing`: counts from the snapshot's months as today, **except** metrics whose frequency is coarser than monthly: they are not counted (not Not reported, not in Health) and the Health block shows one line under the chips (12, `ink/70`): `2 quarterly or twice-yearly metrics are not counted in this revision: it was published before their periods were saved.` For admins, followed by ` Publish again to include them.` (link-styled button that runs Publish). Their category cards show the metric with `Not in this revision` instead of a value. With no coarse metrics, no line.
- Streak captions in a v1 revision stay capped at 6 months (`all 6 months shown`).

## 15. Accessibility (additions)

- Names: full text in the DOM and accessible names; truncation is visual only (§2.3).
- New controls: Show/Hide group (§2.5), item stepper and J/K (§4), Monthly values (§4), Customize rows' Move buttons (§12), menu drawer (§13.1), Download menu and the layout switch (§13.2). Each has a visible label or `aria-label`, a 32px target (24px minimum), a focus ring, and a polite announcement where focus does not move.
- Status never by color alone: change bars keep the ribbon's letters; period cards carry chips; the report list's cells carry letters.
- `scroll-margin-top` on tiles and sections so focused elements are not under the sticky bar (WCAG 2.4.11).

## 16. Responsive summary

| Width | Item grid | Tiles | Report | Shell |
|---|---|---|---|---|
| ≥ 1280 | inline, fills, group column | as today + §3, §5–§9 | as today | rail |
| 1024 | inline, fills, no group column | as today | as today | rail |
| 640–1023 | inline (stacked below a 600px grid) | 2 columns | as today | rail |
| < 640 | stacked, 6 months | 1 column; uptime tile rows stacked below a 400px tile | status list, Download menu, switch | menu button + drawer |

## 17. Verification

- Unit: `itemGridLayout` (the §2.2 table, the 24-name and 24-month cases, `tableWidth === width` for every inline result up to 2400px, the name never past `needs.name + count − 1`), `splitItemName` (separators, edges, the two-word fallback), `textWidth` fallback and `useFontsReady`, `partitionItems(rows, columns)` → `{ reported, notReported, silent, notApplicable }` over the window, `itemSummary` still counting 12 not reported, tile row selection (stopped before the shown columns → footer), `formatMoneyCompact`, money domain, change-bar sign (`worse = −change`), tick dropping near threshold lines, `StandingPeriods`, `diffReportViews` (YTD skipped), noun forms in captions, report model v1/v2 counting.
- Component (Vitest, Testing Library, `vitest-axe`): grid fill at 1294/878/340 (mocked widths), one row height, Show/Hide focus and announcement, silent-only filter focus, back from a silent item opening its group, exports including silent items, drill-in stepper (ends disabled, not-in-order), J/K and kept history state, Monthly values, Customize phone rows (Move up/down focus and announcement), drawer focus return and close on route change, report list (one row per metric).
- API: `cd api && go test ./...`; publish then read has `dataRevised: false`; `?standing=true` returns `standing` with 4 quarter and 2 half columns for the demo, the default omits it; the MCP tool result keeps `summary` and has no `standing`; a v1 object (fixture) reads without `standing`; raw and gzip size bounds.
- Every task ends with the full web suite (count named), typecheck, lint with 0 errors, and `make dev` screenshots at 1440, 1024, 390 and 360 of what it touched, with `scrollWidth === clientWidth`.

## 18. Mockups

HTML prototypes rendered from the demo's data (captured from `make dev`), with screenshots, in the local working folder `.superpowers/sdd/2026-11-17-ux-polish/mockups/` (not committed). `uptime-grid.html` runs the §2.2 algorithm in the page (with the mockup's fallback font, so its measured name widths differ from the app's by a few pixels). Pink pins and "Design notes" panels are annotations; where a note and this document differ, this document wins. Revised after the design review: the grid (silent group last, phone header), the drill-in (tick dropping), the uptime tile (stopped-row rule, 400px stacking), the money plan (Red line color) and the report on phones (one row per metric).

| Design | HTML | Screenshots |
|---|---|---|
| Item grid, expanded (fill, names, group column, one-line not reported, collapsed no-reports group, phone stacked) | `uptime-grid.html` | `uptime-grid-1920.png`, `-1440.png`, `-1024.png`, `-390.png` |
| Drill-in (stepper, linear chart, thresholds, No data then, Monthly values) | `drill-in.html` | `drill-in-1440.png`, `-390.png` |
| Quarterly (ghost period, thresholds), twice-yearly period cards, money plan tile and full screen | `tiles-coarse-money.html` | `tiles-coarse-money-1440.png`, `-390.png` |
| Multi-series focus and context, change bars, small multiples with months, sparse table | `tiles-sparse-multi.html` | `tiles-sparse-multi-1440.png`, `-390.png` |
| Uptime tile with real-shape data | `uptime-tile.html` | `uptime-tile-1440.png`, `-390.png` |
| Report on phones with the menu shell | `report-phone.html` | `report-phone-390.png`, `-360.png` |

## 19. Decisions

1. **Fill, don't float.** The item grid always fills its card. Space goes to readable names first, then months; cells grow to 96px (past it only once every column is full, above about 2300px), so at 1920 a month reads as a band.
2. **Keep the end of a name.** Item names are cut in the middle, not at the end, because sibling items share a prefix and differ in their suffix.
3. **Group in a column, not a tag.** A tag beside a name costs the name its line.
4. **Silence collapses.** Items with no reports in the window are counted, listed in one line, and expandable; they never take rows by default.
5. **Show what decides the status.** Change rules get change bars; thresholds are drawn as lines; coarse charts use straight segments and show the next due period.
6. **Phones are their own layout**: stacked item rows, a status list for the report, compact Customize rows, and no rail.
7. **A published report is frozen and complete.** It stores what the Overview counted; older revisions are never back-filled and say what they lack.
8. **Demo shape.** Deployment uptime is a second item metric (its own item kind and random stream), so the existing Uptime and every other value stay as they were.

## 20. Non-goals

- New dependencies. Capping the dialog width. A virtualized grid (21–40 items render fast once rows are memoized, which they are).
- Changing the monthly line style of ratio, line and days charts (approved as `monotoneX`); only coarse, item drill-in and sparse series move to straight segments.
- Back-filling v1 snapshots; owner fields; item onboarding dates.
