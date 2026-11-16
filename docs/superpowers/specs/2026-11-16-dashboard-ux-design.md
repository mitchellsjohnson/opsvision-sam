# OpsVision — Dashboard and expanded-mode UX

Status: revised after an independent design and engineering review; for the maintainer's approval
Date: 2026-11-16
Extends: `2026-11-10-scorecard-ux-design.md` §4 (Overview), §5 (chart design system) and §7 (full screen). Where they disagree, this document wins. The 12-month status board (commits 2e7b8b4, 2afded3, 224cc74) and the full-screen line chart are approved and are the quality bar; this document brings every other widget up to them.
Plan: `docs/superpowers/plans/2026-11-16-dashboard-ux.md`.

## 1. Intent

The maintainer, looking at real data: "That uptime is useless and unreadable when you click it. Go through every single widget, both the dashboard and expanded mode. Make the UX world class."

An audit of every widget in both modes at 1440 and 390 px, against a demo tenant enriched to production-like density (24 months, 24 services, every chart kind, gaps, n/a months, unreported metrics), found the faults the maintainer's tenant shows:

1. Expanded Uptime is a wrapped run of 11px glyphs with no months, no alignment, no sort and no summary.
2. Item-only metrics (Uptime) answer with `— ◆R worst of N services`: no value, no service, and unreported services silently dropped.
3. Quarterly and biannual metrics vanish in a month view: twelve no-data dots and an empty plot, although every quarter has data.
4. Needs attention hides Reds beyond three with no overflow, and its cards use a different status pill from the board.
5. The full-screen chrome is seven equal buttons on two rows; no definition, thresholds, position or shortcuts.
6. Health is four unstyled buttons in a second vocabulary ("Off track / Watch / On track").
7. Money-plan bars start at zero, so 96% and 111% of plan look the same.
8. Sparse, never-reported, stopped-reporting and no-company-total metrics each invent their own empty look.
9. On phones the control bar takes 240 of 844 px and charts are scaled-down desktop charts.
10. Tiles repeat themselves (`Current: 79% ◆R` under `79% ◆R`), carry a drag handle and menu in their header corner, and offer three ways to open the same thing.

Success: an executive opening the Overview reads the period in one line, sees every Red with the reason and since when, and in the full-screen view of any metric (including 24 services of uptime) answers "what is wrong, where, since when" without hunting, by mouse, keyboard or screen reader, at any width from 320 to 1920 px.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Every widget answers one stated question first, in words and a number, before any chart.
2. One status language everywhere: the board's cell, chip, legend, no-data dot, n/a hatch, Not rated grey, roll-up text and hover label.
3. Expanded Uptime becomes a service × period status grid with summary, sort, filter, keyboard grid and per-service drill-in.
4. Quarterly, biannual and annual metrics show their own periods in finer views, and are counted once.
5. One full-screen chrome for every metric, with the definition, thresholds and source always visible.
6. Layout editing becomes a mode; at rest no tile carries layout chrome.
7. Phones get their own layout and chart geometry, not a shrunken desktop.

**Non-goals**

- API changes. Every need below is met by data the API already returns (§12). The one optional improvement (`orgUnitId` and `itemKindId` on item `ViewRow`s) is logged, not required.
- New metrics or methodology fields. There is no owner field; owner is out of scope and logged as a future methodology field.
- The Table page and the monthly report, except where they share components changed here (the Table must keep working with the extra periods in §5.2).
- New dependencies. React 19, Tailwind 4 tokens, Radix primitives already installed (Dialog, DropdownMenu, Tooltip, Popover), Recharts 3 and lucide-react.

**Anti-goals (failure even if it works)**

- Status shown by color alone, anywhere.
- A widget that shows `—` as its answer while data exists at another grain or in its items.
- A metric counted twice (for example as Yellow and as Not reported).
- Any horizontal scroll at 320–1920 px. The document is the only scroll container on a page; a dialog body may scroll vertically. No nested scroll areas.
- Two vocabularies for one status.
- A request the API rejects (more than 24 periods, 2 YTD columns, 200 subjects or 200 metrics).

## 3. Design system (shared by every widget)

### 3.1 Type scale

Six sizes only.

| Size / line | Use | Class |
|---|---|---|
| 11 / 16 | Eyebrows (uppercase, 600, 0.04em), cell letters, captions | `text-[11px] leading-4` |
| 12 / 16 | Secondary lines: thresholds, change on boards, legends, table headers | `text-xs` |
| 14 / 20 | Body, table cells, buttons, change in value rows, phone card titles | `text-sm` |
| 16 / 24 | Card and section titles (600) | `text-base` |
| 20 / 28 | Dialog title (600, accent-deep); phone headline numbers | `text-xl` |
| 28 / 36 | The answer: the primary value on tiles, cards and the dialog (600, `tabular-nums`) | `text-[28px] leading-9` |

Chart ticks: 12px in focus, 10px on tiles (SVG text inside a 120px plot is the one exception to the scale). No text under 10px; no cell letter under 11px.

### 3.2 Color and contrast

Tokens from `web/src/ui/tokens.css`, unchanged: `accent` (lines, current-value pill), `accent-deep` (titles, links, selected header), `cream` (page and dialog), `ink`, status pairs, `statusFill` tiers (best = soft tint, middle = tint with border, worst = solid), `LINE_COLORS`, the board's `HATCH`.

- **All text uses `ink` at 70% or more** (about 5.6:1 on cream and white). `ink/55` is for non-text only (lines, dots, borders). `TICK_OPACITY` in the chart files goes from 0.55 to 0.7.
- Non-text graphics that carry meaning (bar edges, segmented-control selection, focus rings) meet 3:1.
- Bands in plots: status color at 7% opacity on cream and white (6% is invisible on cream).

### 3.3 Spacing and tile anatomy

4px grid. Card: `rounded-lg border border-ink/20 bg-white p-4`. Gaps: 8px inside a card between rows, 16px between cards, 24px between sections.

A new `TileFrame` component renders every metric tile:

1. Header: title (16, 600, an `h3`) and one 12px `ink/70` threshold line (§3.5) under it. Right: a 32×32 ghost icon button (`Maximize2`, 16px), `aria-label="Expand {metric}"`. The text "Expand" button goes. No drag handle or menu (§4.1).
2. Value row (baseline-aligned, 8px gaps, wraps): value 28/36; status chip `lg` (20px tall, 12px letter, shape + letter); change (14, 500, arrow and tone from `MOVE_CLASS`); then 12px `ink/70` extras (since when, YTD, components such as `18 / 20`).
3. An optional 12px `ink/70` context sentence (sparse, stopped, coarse, multi-series).
4. The kind's chart region (§7): plot 120px; ribbon cells 18px tall with 11px letters.
5. An optional footer (12/14px link) after a 1px `ink/10` rule.

Removed from tiles: the `Current: …` line, the `View as table` link (the dialog's More menu and the Table tab cover it), and the category eyebrow above a tile when the tile sits under its own category's section header (kept when the user has moved it elsewhere). The whole-card click stays as a pointer-only shortcut; Expand is the keyboard and screen reader path and the focus-return target.

### 3.4 Status vocabulary (shared with the board)

| State | Cell | Words (visible and accessible) | Source |
|---|---|---|---|
| Status | Tier fill + letter (chips add the shape) | the tenant's scale labels (`Red`, `Yellow`, `Green`) | cell status |
| Not rated | `ink/6` fill, no letter | `Not rated` | value with no status |
| n/a | Hatch, `ink/15` border | `n/a` + reason | `naReason` |
| No data | 4px `ink/35` dot | `No data` | no cell, or neither value nor status |
| Not due | Empty, no dot | `Not due` (tooltip `Q3 FY2026 reports after Sep`) | month cells of a coarse metric that are not its period's last month (§5.4) |
| Due | — | `Q3 due by Oct` caption; counts under the prior period's status | §5.3 |
| Not reported (metric, this period) | — | `Not reported` + reason | §5.3 for coarse metrics; no status at scope or in children for monthly ones |
| No reports in the window | — | `No reports in the last 12 months` (the grain's window: `4 quarters`) | no value in any column; history before the window is unknown, so never "Never reported" |
| Stopped reporting | — | `Last reported {Mon YYYY}` | values in history, none in the last column |

Health and every count use the scale labels: `5 Red`, never `Off track 5`. Roll-ups use the board's `RollUp` text: `◆ 1 Red · ▲ 1 Yellow`, or `All Green`, plus `· 2 no data` for blanks.

### 3.5 Threshold and direction copy

`thresholdText(rule, opts)` in `logic/statusText.ts`:

```ts
thresholdText(rule: StatusRule, opts: {
  format: string; direction: Direction; chartKind: string; frequency: Frequency
  statusLabel: (key: string) => string | undefined
  perSubject?: { name: string; value: number }[]   // items or units with their own best-band value
  noun?: NounForms                                 // for "1 service has its own target" (§3.8)
  surface: 'tile' | 'focus'
}): string
```

| Kind | Copy |
|---|---|
| Bands, higher better | `Green at 90% or better · Red below 80%` |
| Bands, lower better (line, score) | `Lower is better · Yellow above 450 · Red above 600` |
| Days | `Fewer days is better · Green at 14 days or fewer · Red above 17 days` |
| Money plan | `Under plan is fine · Yellow above 110% · Red above 120%` |
| Change rule | tile `Lower is better · judged on change vs the prior month`; focus adds `Green: any improvement · Yellow: up to 5% worse · Red: more than 5% worse` |
| Per-subject bands, tile | append `· 1 service has its own target` (count, noun from §3.8) |
| Per-subject bands, focus | append `; Status Page is held to 99.50%` for each |
| Coarse metrics | prefix `Reported quarterly ·` / `Reported twice a year ·` / `Reported yearly ·` |

Labels come from `statusLabel`, values from the metric's format (whole steps without decimals for percent0/number0).

### 3.6 Since when

`sinceText(cells, index, columns, statusLabel)` in `logic/statusText.ts` returns `Red since Sep 2026 · 2 months` for a status streak ending at `index` (`streakAt`), measured in months (a quarter counts 3, a half 6, a year 12). When the streak reaches the first column shown, the copy is capped: `Red all 12 months shown` (`all 4 quarters shown`). It appears in the dialog value row, the uptime Worst now block, the drill-in, the uptime tile and Needs attention reasons.

### 3.7 Hover label

Unchanged `ChartHoverCard` and `StatusCellTip` (ink background, 11/16 white text, bold value, full period, `shape label`, streak, change). No new tooltip styles.

### 3.8 Nouns

`nounForms(name: string | undefined, fallback: 'item' | 'unit'): { one: string; many: string }` in `logic/nouns.ts`, lowercased:

- A name ending in `ies` → one `y`-form (`Repositories` → `repository`/`repositories`); ending in `ses`, `xes`, `ches`, `shes` → drop `es`; ending in `s` but not `ss` → drop `s`.
- Otherwise the name is singular: plural by `y` → `ies` after a consonant, `s/x/ch/sh` → `+es`, else `+s` (`Repository` → `repositories`).
- Unknown name → `item/items` or `unit/units`.

Item nouns come from the item kind of the metric (`Metric.reportedAt` item_kind id → `useItemKinds`); org nouns from the level of the children (`useOrgLevels`, by depth). A count uses `one` when it is 1. Items with no org unit (`orgUnitId: ''`) are grouped as `Unassigned`.

### 3.9 Loading, empty and error

- The frame (title, control bar, Customize button) renders at once. Widgets render skeletons at their final size (`bg-ink/[0.06] rounded`) inside one `aria-busy` region with a visually hidden `role="status"` `Loading overview`. Today's text `Loading overview…` goes.
- The Overview is one request, so a failure is page-level (as today). The per-region error (`Couldn’t load this chart` · `The 24-month history didn’t load. The 12 months above are up to date.` · `Try again`) exists only for the dialog's own request (§8.5).
- Empty: no plot (§7.9).

### 3.10 Live regions

- One polite region per surface, owned by the surface (Overview, dialog). Never announce on page load.
- Filter result counts: debounced 300 ms after typing stops (`Showing 3 of 24 services`).
- Health toggles keep focus and announce `Showing 5 Red metrics` (or `Showing all metrics` when cleared).
- Previous/next metric: `{name}, 8 of 15`. Copy link: `Link copied` / `Couldn’t copy the link`. Drill-in: none (focus moves to its heading, which is announced).

### 3.11 Segmented controls

Buttons in a `role="radiogroup"` with `role="radio"`, `aria-checked`, a roving tabindex (one tab stop; arrows move and select). Track `bg-ink/[0.06] rounded-lg p-0.5`; options 28px, 12px 500. The selected option is white with weight 600 **and** a 1px `ink/55` inset border (3:1 against the track), so selection never rests on fill alone.

### 3.12 Motion

Every new Recharts chart sets `isAnimationActive={!reduced}` (`usePrefersReducedMotion`). Swapping the grid for a drill-in, entering Customize mode, and filtering do not animate.

## 4. Overview page

Default order (draggable in Customize mode): Health, Needs attention, the status board, then category sections with their tiles, then Not reported. `LayoutGrid.displayOrder` pins Health then Needs attention to the top when visible (today it pins Needs only).

### 4.1 Customize layout mode

Mockup: `customize-layout-1440.png`, `customize-layout-390.png`.

- At rest the page has one layout control: `Customize layout` (secondary 32px button with the `LayoutDashboard` icon, right side of the page header row). Reset layout, Save as default and Hidden (n) move into the mode. No tile or section shows a drag handle or menu.
- In the mode:
  - A sticky bar under the control bar (`top: var(--control-bar-h)`; `bg-white border border-accent rounded-lg p-3 shadow-sm`, `role="region" aria-label="Customize layout"`): `Customizing layout` (14, 600), help text (12, `ink/70`) `Drag a tile by its handle, or use its menu. Keyboard: Space to pick up, arrow keys to move, Space to drop, Esc to cancel.` (phones: `Use each tile’s menu to move, resize or hide it.`), then `Reset layout`, `Save as default` (admins), `Hidden (n)`, `Done` (primary).
  - Every tile and section: a 2px dashed `accent/45` outline (offset 3px, radius 10px), a name tag (11px 600 white on accent-deep pill, `{title} · Small|Wide` or `Section · {name}`), and a toolbar at top-right: the dnd-kit drag handle (32px, `aria-label="Move {title}. Space to pick up"`) and the layout menu (32px, `aria-label="Layout options for {title}"`).
  - Tile content is wrapped in an element with `inert` and `opacity-70`, so nothing inside is focusable or clickable.
  - Tile menu: `Small`, `Wide` (checked state shown), `Hide`, separator, `Move up`, `Move down`, `Move to top` (existing `moveBlock`). Section menu: `Move section up`, `Move section down`, `Move section to top` (sections move with their tiles, as `moveBlock` does today) and `Hide section header`.
  - Keyboard drag uses the existing dnd-kit `KeyboardSensor` and announcements; pointer drag stays off below 768px.
  - `Done`, or Esc when nothing is picked up, leaves the mode and returns focus to `Customize layout`. Saving works as today (each change persists).

### 4.2 Health

Mockup: `overview-top-1440.png`, `overview-top-390.png`.

- Question: how did the period go overall, and what changed since the last one?
- Title by grain: `Health this month` / `this quarter` / `this half` / `this year`; then `15 metrics · Oct 2026` (12, `ink/70`). Right (below on phones): `Since Sep: 2 more Red, 1 fewer Green` (12; the Red phrase `text-status-r font-semibold` when it grew). The comparison label is the prior column's short label (`Sep`, `Q2`, `H1`, `FY2025`).
- A 12px proportion bar (`rounded-md`, 2px gaps, worst first: Red solid, Yellow tint with a 1px `status-y` inset border, Green tint with a 1px green/25 inset border, Not reported hatch with `ink/15` border), segment `flex-grow` = count. `role="img" aria-label="5 Red, 3 Yellow, 3 Green, 4 Not reported of 15 metrics"`.
- Four toggle buttons (`role="group" aria-label="Show metrics by status"`), 12px below: `min-h-9 rounded-lg border border-ink/20 bg-white pl-2 pr-3`, a 2-row grid: chip (Not reported: a hatch swatch), count (16, 600, tabular), label (12); the change (11, tone; `no change`) on the second row. Pressed: `border-accent bg-accent/[0.08] ring-1 ring-inset ring-accent`, `aria-pressed="true"`. Name: `Red: 5 metrics, up 2 since Sep`. Not reported is a real toggle (`?health=none`). Pressing keeps focus and announces (§3.10); pressing the pressed toggle clears. The separate "Clear health filter" pill goes. Phones: a 2×2 grid.
- Counts come from one function (§5.3) so every metric is counted exactly once.

### 4.3 Needs attention

Mockup: `overview-top-1440.png`, `overview-top-390.png`.

- Question: which metrics are Red or slipping, why, where, and since when?
- Ranking (`needsAttention(items, scale) → { shown, totals }`):
  1. Tier 1 is the worst status. If any tier-1 item is a **New Red** (prior status not the worst), the most severe one (largest distance past the Red line) takes one slot.
  2. The remaining tier-1 items fill slots by Red streak in months (descending), then distance, then category order.
  3. Then tier 2 (lost at least one rank since the prior period, "slipping"), then tier 3 (middle status), as today.
  4. Show 3. Display order: tier, then streak, then distance.
- Header: `Needs attention` (16, 600, accent-deep, `h2`), then what is shown (12, `ink/70`): `3 of 5 Red` when all shown are Red, else `2 Red · 1 slipping` (or `· 1 Yellow` for tier 3). `Show all 5 Red ›` (12, 500, accent-deep) appears only when more Reds exist than are shown; it sets `?health=R` and moves focus to the first metric tile.
- Card: an `article` labelled by its `h3`; the `h3` holds a link (`href="?focus={metric}"` with the current query) whose `::after` covers the card (stretched link); the link's `aria-describedby` points at the value row and the reason, so its name starts with the visible title. Hover: `border-accent`; focus: the card shows the focus ring (`:focus-within`). Contents:
  1. Category eyebrow (11, uppercase) and the reason (11, 600; `text-status-r` for tier 1, `text-status-y` otherwise): `Red since Jul 2026 · 4 months`, `Red all 12 months shown`, `New Red · fell from Green`, `1 service Red`, `Fell from Green`, `Yellow since …`.
  2. Title (`h3`, 16, 600).
  3. Value row (§3.3).
  4. Threshold line (§3.5).
  5. Trend: 56px line (no axes), bands at 9%, goal dotted `ink/40`, current dot; a 12-cell ribbon (18px cells, letters, `aria-hidden`) and month initials (11, `ink/70`). The trend's summary sentence is part of the card's description.
  6. Why line after a 1px `ink/10` rule, pushed to the bottom: worst child, value, chip, and how many share the worst status: `Lowest: Payments 55% ◆R · 2 of 4 segments Red` / `Highest: Android App 941 ◆R · 4 of 8 products Red` (`worstChildren`, §11).
- Item-only metrics (Uptime): value row `Worst {item} {value} {chip}`; line 4 `18 of 24 Green · ◆ 1 Red · ▲ 2 Yellow · 3 not reported`; line 5 a decorative mini board of the worst three items (name 96px, 12 tier-fill cells 14px tall, value 56px); why `{item}: Red in {n} of the last 12 months`.
- Grid: 3 columns ≥1024px, 2 at 640–1023, cards stretch to the tallest (min 248px).
- Phones (<640px): compact rows, `gap-2`, card `p-3`: reason, title (14, 600), value (20) with chip and change (12), a 6-cell ribbon. No eyebrow, threshold, line chart, mini board or why line.

### 4.4 Status board

Approved; changes limited to:

- Coarse rows (§5.4): the period's status sits in its last month's column, other month cells are Not due, the Current column shows the counted period's value with a caption `Q3 FY2026` (or `Q3 due by Oct`).
- Item-metric rows: the Current caption becomes `worst of 21 services · 3 not reported` when any are missing (`statusAtScope` caption gains the not-reported count).
- `scroll-margin-top: var(--control-bar-h)` so the sticky control bar never covers the board header.
- Phones (stacked rows): row name `min-w-0 line-clamp-2`, value `shrink-0 max-w-[45%] truncate`, so nothing clips at 320px.

### 4.5 Category section header

Mockup: `uptime-tile-1440.png` (top). `h2` 16/24 semibold accent-deep, the board's `RollUp` text (11, `ink/70`), a 1px `ink/15` rule under both, `pb-1.5 mb-3`. No toolbar at rest. Today's `1R 1Y` text goes.

### 4.6 Metric tiles

`TileFrame` (§3.3) with the kind's chart region (§7).

### 4.7 Not reported

Mockup: `tile-states-1440.png` (bottom).

- Question: what is missing this period, and why?
- Wide card: `h2` `Not reported for Oct 2026` + `· 2 metrics` (12, `ink/70`); right: `Enter Oct 2026 data` (secondary; contributors and admins; `/entry?period=2026-M10`).
- Table (14px, 1px `ink/10` row rules): Metric (`th scope=row`, 500) · Why · Category (hidden <640). Why: `No reports in the last 12 months`; `Last reported Jul 2026 (77%)`; `Q3 FY2026 overdue (due by Oct 2026)` for coarse metrics past due (§5.3); `Not applicable: {reason}` when the scope cell is n/a.
- Coarse metrics that are current or due are **not** listed; one quiet line under the table (12, `ink/70`): `Reported less often and up to date: Concepts delivered expected value (Q3 FY2026; Q4 due by Jan) · Accessibility compliance (H1 FY2026; H2 due by Jan).`
- Hidden when nothing is listed and no quiet line applies.

## 5. Coarse metrics (quarterly, biannual, annual)

A metric is **coarse** when its frequency is coarser than the selected grain (quarterly, biannual or annual in a month view; biannual or annual in a quarter view; annual in a half view).

### 5.1 Columns

`coarseColumns(period: string, grain: 'quarter' | 'half' | 'year', count: number, fy: number): Column[]` in `columns.ts`: the `count` periods of `grain` whose last month is on or before the selected period's last month. Oct 2026 → 4 quarters Q4 FY2025…Q3 FY2026; 2 halves H2 FY2025, H1 FY2026; 3 years FY2023…FY2025. Fiscal years starting in any month.

### 5.2 Requests

- **Overview, Table, and the dialog's layout view** share one request (one cache entry), built by `scorecardViewRequest(state, tree, { coarse })` where `coarse` lists the coarse grains present among the metrics of the version in force for the selected period (from `useVersions`; `useScorecardViewRequest` waits for versions before `ready`). Month selection: + 4 quarters, + 2 halves, + 3 years, each only if that frequency is present (at most 12 + 9 = 21 periods). Quarter selection: + 2 halves, + 3 years. Half: + 3 years. Monthly-only methodologies send exactly today's request. The Table and report keep working: they look cells up by column key and ignore extra periods (tested).
- **The dialog's own request** asks for the metric's own grain only, never mixed: `focusWindow(range, period, frequency): { grain: Grain; count: number }`. Monthly metric in a month view: months, 12 or 24 by range (24 only with `metrics=[key]`, as today). Coarse metric: quarter × 8, half × 4, or year × 3, with `metrics=[key]`. Always ≤ 24 periods.
- The shown window is explicit state, not inferred: the chart uses the window of the data it is showing (kept with the data while a new window loads), replacing `view.data.periods.length > 12 ? 24 : 12`.

### 5.3 Due and overdue

`coarseStatus(row, columns, selected, fy): { state: 'current' | 'due' | 'overdue' | 'none'; counted: Column | null; cell: Cell | undefined; next: { label: string; dueBy: string } }` in `logic/coarse.ts`. With L = the latest coarse period ending on or before the selected period, and one month of grace:

| Condition | State | Counts as | Caption |
|---|---|---|---|
| L is reported | `current` | L's status | `Q3 FY2026` · next `Q4 due by Jan` |
| L missing, selected ≤ L's last month + 1, and L−1 reported | `due` | L−1's status | `Q3 due by Oct` |
| L missing past grace, or L and L−1 missing | `overdue` | Not reported | `Q3 FY2026 overdue (due by Oct 2026)` |
| no reported coarse cell in the window | `none` | Not reported | `No reports in the last 4 quarters` |

Health, Needs attention, the board's Current column and Not reported all read this one function for coarse metrics, so nothing is counted twice. Streaks for coarse metrics are measured in months.

### 5.4 Board mapping

`buildBoardRow` maps a coarse cell to its period's last month column; the other month columns are `notDue` (empty, no dot, tooltip `Q3 FY2026 reports after Sep`). In a quarter view, a biannual cell sits in its half's last quarter.

### 5.5 Chart

Coarse metrics use the approved `RatioChart` at their own grain (not bars): a line through a visible point per period (`r` 3, current 4), the value above each point (11, 600), bands, goal, ribbon under the plot. Tile: last 4 quarters / 2 halves / 3 years; dialog: 8 / 4 / 3. Labels `Q3 FY26` on axes, `Q3 FY2026` in captions, `Jul–Sep 2026` in the hover label. Context line: `Latest: Q3 FY2026 (Jul–Sep) · Q4 due by Jan`. Value row change: `vs Q2`. The range strip is hidden for coarse metrics.

Mockup: `tile-states-1440.png` ("Coarse metric").

## 6. Item metrics (Uptime and any metric with item rows)

### 6.1 Which rows and which metrics

- Item rows are `rows.filter(r => r.subjectKind === 'item')`, never `metricScope(...).children` (which returns unit rows whenever a unit row exists).
- A metric gets the item grid and the item tile when it has item rows and no unit scope value, or when `chartKind === 'uptime'`. When a unit scope value also exists (items rolled up to the org), the summary leads with it: `Company 99.95% ◆G · 18 of 24 services Green`, and the tile shows the scope trend with the item exceptions as its mini board.
- The engine emits a row for every item of the kind (`subjectsFor`), so items with no data appear (as No data / Not reported).

### 6.2 Groups and names

The org unit name per item comes from `useItems` (enabled whenever the view has item rows, not only when a scope is set) and `useOrgUnits`; no org unit → `Unassigned`. The noun comes from §3.8 (`service` / `services`).

### 6.3 Layout

`itemGridLayout(width, total, opts)` in `logic/itemGridLayout.ts`, reusing `boardLayout`'s halving:

```ts
interface ItemGridLayout { count: number; cellWidth: number; nameWidth: number; valueWidth: number; extraShown: boolean; stacked: boolean; tableWidth: number }
itemGridLayout(width: number, total: number, opts: { valueWidth: number; extraWidth?: number; nameMin?: number; minInline?: number }): ItemGridLayout
// CELL_MIN 28 (24px target + gutters), CELL_MAX 40, CELL_MAX_STACKED 48, NAME_COMFORT 160, NAME_MAX 240, minInline default 6
```

- Inline when `nameMin + count × 28 + valueWidth ≤ width` for count = total, then halved (12 → 6 → 3) while count ≥ `minInline` (or total when smaller). Extra column (Red months) only if it also fits. Cells widen to 40 once the name has 160; the name stops at 240; the table is only as wide as it needs (`tableWidth`), left-aligned, with any leftover space after it. Value and Red months sit right after the cells.
- Otherwise stacked: the name and value above, the cells below at up to 48px, `count` halved until `count × 28 ≤ width`.
- Callers: dialog grid `valueWidth` 136 (76 when the container is under 640), `extraWidth` 112, `nameMin` 96; tile mini board `valueWidth` 72, `nameMin` 80, no extra.
- Expected (container widths): 1296 → 12 × 40, name 240, extra shown, table 968; 880 → 12 × 39, name 164, extra shown; 624 → 12 × 28, name 100, extra shown; 342 → 6 × 28, name 98; 312 → stacked 6 × 48; 272 → stacked 6 × 45. Tile 528 → 12 × 28, name 120; tile 320 → 6 × 28, name 80.

### 6.4 Uptime tile

Mockup: `uptime-tile-1440.png`, `uptime-tile-360.png`.

- Question: is any service down, which, since when, and how widespread?
- Threshold line: `24 services · Green at 99.90% or better · 1 service has its own target`.
- Value row: `Worst` (12, `ink/70`), the worst reported item (16, 600), its value (28), chip `lg`, then `Red since Oct 2026 · 1 month` (§3.6). Worst = highest status rank, then worse value by direction, then name.
- Distribution: an 8px proportion bar (as Health) with `role="img"` and the sentence `18 Green · 2 Yellow · 1 Red · 3 not reported` (12; the best status bold).
- Exceptions first: rows for non-best reported items (worst first) then not-reported items (by name), at most 5. Each row is one `<button>` (min 28px tall, `rounded-md`, hover `ink/3.5`) named `Open Webhooks trend: 99.06%, Red` (`Open Push Gateway trend: not reported this month, last Sep 100.00%`): name, decorative cells (`aria-hidden`, tier fill and letters, 18px), value or `Not reported` (11, `ink/70`). Columns from §6.3. A month-initial header row (`aria-hidden`) when inline. Activating a row opens the dialog at that item (`?focus=uptime&subject={id}`).
- Then one line (12, `ink/80`): `All other 18 services Green`, prefixed `1 more not reported ·` when rows were cut. When every item is best: `All 24 services Green`.
- Footer: `See all 24 services ›` (14, 500, accent-deep) opens the dialog; right `Exceptions first · Oct 2026` (11, `ink/70`).

### 6.5 Uptime, expanded

Mockup: `uptime-expanded-1440.png`, `uptime-expanded-390.png`, `uptime-expanded-360.png`.

Below the chrome (§8):

1. **Summary** (wraps, `items-end justify-between`, gap 12/32px). Left: `18 of 24 services Green` (28/36, 600; 20/28 under 640px; "Green" is the tenant's best label; the denominator is all items), then `◆ 1 Red · ▲ 2 Yellow · 3 not reported · Oct 2026` (14, `ink/80`; shapes `aria-hidden`). Right: eyebrow `Worst now`, name (16, 600), value (20, 600), chip `lg`, then `Red since Oct 2026 · 1 month · 2 Red months in the last 12 · Platform` (12, `ink/70`).
2. **Controls** (`role="toolbar" aria-label="Arrange services"`): `Sort` (12, `ink/70`) and a segmented control (§3.11) `Worst now` · `Most Red months` · `Name`, stored in the URL (`&sort=reds|name`; default omitted). Filter input when items > 12 (32px, 220px; full width on phones; `aria-label="Filter services"`, placeholder `Filter 24 services`, matches item and group names, case-insensitive; debounced count announcement; no matches: `No services match “xyz”.` and `Clear filter`). A range segmented control `6M` · `12M` · `24M` on the right in month views only (default from the dialog range: 3M/6M → 6M, YTD/12M → 12M, 24M → 24M); hidden in other grains, where columns are the grain's trend.
3. **Grid card** (`bg-white border border-ink/20 rounded-lg px-4 pt-3 pb-2`; phones `px-2`). Top row: range note (12, `ink/70`) `Nov 2025 – Oct 2026 · 12 months`, or `Last 6 of 12 months` when §6.3 halves; the board `Legend` right.
   - `role="grid" aria-label="Uptime by service and month"`, `aria-describedby` the keyboard hint. Inline mode: Service column, month columns, value column (`Oct`), Red months (when shown); widths from §6.3; fiscal-year group row (11px uppercase 600 `ink/70`, `ink/20` left border at a year start); month row (12px 500 `ink/70`; selected month accent-deep 600 with the 2px accent underline); the selected column carries the board's current band.
   - Row header `th scope=row`: name (14, 500, `line-clamp-2`), group (11, `ink/70`; hidden under 640px). Not a tab stop; pointer click opens the trend.
   - Cells: `StatusCell` 24px buttons with `cellName` names and the shared tip. Value: value (14, 600) + chip (chip hidden under 640px). Not reported: `Not reported` (12) over `Last Sep · 99.98%` (11; `Last Sep` under 640px) or `No reports in 12 months`. Red months: count + a 44×6px `status-r` bar, `—` when 0.
   - Stacked mode: per item, a name row (`aria-hidden`; name and value) above the cell row, with a zero-width `th` holding the name for assistive technology (the board's stacked pattern).
   - Sorting: Worst now = status rank of the selected column, then worse value by direction, then name; Most Red months = worst-status cells in the range, then Worst now; Name = locale compare. Items with no value in the selected column always form the last group under a `rowgroup` header `Not reported this month · 3` (11px uppercase), by name.
   - Keyboard (`useGridNavigation`): one tab stop; arrows move (down crosses the group header without stopping); Home/End = first / selected period; PageUp/PageDown = 10 rows; Enter/Space opens the trend. Hint (11, `ink/70`): `Arrow keys move between cells · Enter opens the service’s trend · Home/End jump to the first or current month`.
4. **Drill-in** (§6.6).

No Breakdown section and no `View as table` link here.

### 6.6 Drill-in

- Opening pushes a history entry with `&subject={id}` (not replace), so browser Back returns to the grid.
- The grid is replaced by: a breadcrumb row (12px) `‹ All 24 services` (link, accent-deep 500) `/` the item name as an `h3` with `tabIndex={-1}` that receives focus, then `· Platform · Green at 99.90% or better` (the item's own rule); a value row (28 value, chip, change vs prior, `Red since Oct 2026 · 1 month · 2 Red months in the last 12`); the standard focus `RatioChart` for the item's row. Its bands and threshold text use the item cell's `rule` (the rule after per-subject bands); percent axes are capped at 100; the range strip applies.
- Sort (URL), filter text and scroll position live in the dialog body, not in the grid, so they survive the drill-in. `All services` (or Back) restores them and moves focus to the same item's row cell **by item id** (`focusRow(id)`), whatever the sort or filter.
- Previous/next metric clears `subject`, `sort` and the filter. Esc closes the dialog.
- Screen-reader summary of the drill-in chart includes the item's threshold: `Webhooks uptime over 12 months: from 99.98% to 99.06%; Green at 99.90% or better; Red in 2 months`.

### 6.7 Actions in an item view

- Export SVG and PNG draw the grid (`itemGridSvg`: title, scope, legend, names, cells, values); Export CSV writes one row per item: name, group, one column per period (value or `n/a`/blank), then the current status. In a drill-in, exports are the item's chart (existing `chartSvg`/`chartCsv` on the item row).
- Present shows the dialog body full screen, as today.
- Shortcuts `1`–`3` select 6M/12M/24M in the grid (the hint row reads `1–3 range`); `4` and `5` do nothing there.

## 7. Metric kinds: tile and expanded

Every kind uses `TileFrame` on tiles and §8 chrome in focus. Focus plot height stays `FOCUS_CHART_HEIGHT`; under 640px the plot is `h-[max(280px,45vh)]` with its own geometry: right axis 48px, every other period labelled, ribbon cells 18px with the letter only. Range strip on phones: label 14, change 11 on one line.

### 7.1 Ratio, line, days, lower-is-better scores

Mockup: `focus-chrome-1440.png`.

- Tile: threshold line (§3.5), bands at 7%, goal dotted without a label (the threshold line names it), 18px ribbon.
- Focus: as approved, plus `Goal 90%` and `YTD 85%` (14, `ink/70`) in the value row and since-when; tick labels within 14px of the current-value pill are hidden; percent axes capped at 100.
- Breakdown (below the range strip): `h3` `By segment` / `By product` (org level noun, §3.8) or `By service`, 16/600 accent-deep, and `Worst first · choose a segment to scope the dashboard to it` (12, `ink/70`). Table: name (`th scope=row`; org rows are buttons calling `updatePeriod({ scope })`, item rows open the drill-in), `Last 12 months` (12 decorative `xs` cells; hidden <640), value + chip, change vs prior (12, tone), and `vs goal 90%` (8px track `ink/6`, accent fill to the value, a 2px `ink/55` tick at the goal; hidden <640) **only for percent formats with a target**; otherwise the column is absent. Sortable headers with `aria-sort`; default worst first.

### 7.2 Change rule (weighted defect score)

Mockup: `tile-states-1440.png` (top right).

- No bands; the threshold line states the rule; the focus definition spells out all three outcomes.
- Methodology-change marker on every line chart: when the published version in force changes between adjacent columns (from the versions' `effectiveFrom`; no markers when the view is restated under one version), a dashed `ink/55` vertical line at the boundary with a 10px label (`ink/70`) `From records` when the newer version derives a measure of this metric (`Measure.source === 'derived'`), else the version name. Hover label: `Methodology changed: 2026 v2 from Jul 2026`.
- The range strip states change rules in the header's terms (`26% worse`).

### 7.3 Coarse metrics

§5.5.

### 7.4 Money plan

Mockup: `bars-money-plan-1440.png`.

- Question: over or under plan, by how much, how often?
- Value row: `104%` + `of plan` (14, `ink/80`) + chip + change; context `Over plan in 12 of the last 12 months`; with components (`ratioParts`): `$1,150k spent of $1,000k planned` (12, `ink/70`).
- Diverging bars from a solid `ink/55` 100% line: up = over, down = under; fill by tier (Green `status-g-bg` + 1px `status-g` edge, Yellow `status-y-bg` + 1px `status-y` edge, Red solid); the deviation at the bar end (`+4%`, 11, 600); band zones at 7%; the axis centred on 100%, padded to the largest deviation + 3 (at least ±15). Focus: right-axis ticks at band edges only and a `Plan` pill (ink/72, white 11px) at 100%; tile: `Plan` (10, 600, `ink/70`) at the right end under the line.
- Summary: `Spend vs plan: over plan in 12 of 12 months; Oct 104% of plan, Green`. Point buttons as other charts.
- `chartSvg` draws the same diverging bars.

### 7.5 Sparse (more n/a than values)

Mockup: `uptime-tile-1440.png` (right).

- A 12-column board ribbon (18px tile, 24px focus) with the value above valued months (11, 600) and month labels below; context `5 months with a major incident in the last 12; the rest are n/a` (from the n/a reasons when they agree, else `7 months n/a`); footer `No incident: n/a` from the most common reason. Replaces the bordered chips.
- Focus: the same at full width, then a table of valued months (month, value, status, change); the range strip is hidden.

### 7.6 Multi-series (no company total)

Mockup: `tile-states-1440.png` (top left and "small multiples").

- Header: `Worst {segment} {value} {chip}` and `1 of 4 segments Red` (12, `ink/70`); threshold line, then `4 segments · each runs its own survey, so there is no company total` (from the definition when it says so, else `4 segments · no company total`).
- Tile: overlaid lines with direct end labels (name in series color 11/600, value 11/600 ink, chip 24×14), 16px minimum spacing; no legend.
- Focus with 1–3 series: the same, larger, plus the breakdown. With 4 or more: **small multiples**, one panel per series (auto-fit, min 280px; 2–3 columns on desktop, 1 on phones), worst first, sharing one y-domain; each panel: name (14, 600), value, chip, since-when (11, `ink/70`), a 110px line with bands, and its own ribbon. A caption `Shared y-axis 60–100% · worst first`. The range strip is hidden.

### 7.7 Uptime

§6.

### 7.8 Stopped reporting

Mockup: `tile-states-1440.png`. The last value as history (28, `ink/70`) with `Last reported Jul 2026 · nothing for Aug–Oct`; no current chip; the plot ends at the last value; the ribbon's no-data dots continue to now.

### 7.9 No reports in the window

Mockup: `tile-states-1440.png`. No plot: `No reports in the last 12 months` (14, 500), `Nothing has been entered for Nov 2025 – Oct 2026. Measured monthly, by product.` (12, `ink/70`); for contributors and admins `Enter Oct 2026 data ›`. No Expand button; the dialog, opened by URL, shows the same message centred.

## 8. Full-screen dialog chrome

Mockups: `focus-chrome-1440.png`, `focus-chrome-390.png`; the uptime mockup uses the same chrome.

### 8.1 Frame

`fixed inset-8` at ≥768px, `inset-0 rounded-none` below; `bg-cream rounded-lg shadow-xl flex flex-col overflow-hidden`. Header `px-6 pt-4 pb-3 border-b border-ink/15` (phones `px-4 pt-3 pb-2`), fixed; body `flex-1 overflow-y-auto px-6 pt-4 pb-6` (phones `px-4`), the only scroll area.

### 8.2 Header

One row (two on phones):

- Left: category eyebrow (11, uppercase, `ink/70`) over the title (`Dialog.Title`, 20/28, 600, accent-deep; one `h2`).
- Right: `nav aria-label="Metrics"` with ghost icon buttons `ChevronLeft` / `ChevronRight` (32px; `aria-label="Previous metric: {name}"`, `aria-keyshortcuts="ArrowLeft"`, `title="Previous metric (←)"`) around the position `7 of 15` (12, `ink/70`, tabular); a 1px `ink/15` divider; `Ask SAM` (32px secondary with the `Sam` mark, `border-accent/40 text-accent-deep font-medium`, `aria-haspopup="dialog"`); More actions (ghost `MoreHorizontal`, Radix `DropdownMenu`); Close (ghost `X`, `aria-label="Close"`, `title="Close (Esc)"`).
- Phones: row 1 eyebrow/title + Close; row 2 `‹ 7 of 15 ›` left, Ask SAM and More right.
- Definition line (12/16, `ink/80`, max 820px): `{definition} {threshold sentence (focus)}.` then a second line `Source: {source} · Measured {monthly|quarterly|twice a year|yearly}, by {noun one} · Methodology ›`, read from the metric in the version in force for the selected period (`Cell.versionId` → `useVersions`). `Methodology ›` links to `/admin/methodology` and shows only to admins (no per-metric anchor exists yet).

### 8.3 More actions menu

Radix `DropdownMenu`, 220px, `rounded-lg border border-ink/20 bg-white p-1 shadow-lg`, 32px items with `menuItemHighlight`: `Copy link` (`L`), `View as table` (`T`), `Present` (`P`), separator, `Export PNG`, `Export SVG`, `Export CSV` (§6.7 for item views). Shortcut hints as `kbd` chips. Copy link announces `Link copied` / `Couldn’t copy the link` (§3.10). Export failure text stays as today.

### 8.4 Keyboard shortcuts

`useDialogShortcuts(ref, handlers)`:

- Keys: `←` / `→` previous / next metric; `1`–`5` ranges (3M, 6M, 12M, YTD, 24M; `1`–`3` in item grids, §6.7); `T` table; `L` copy link; `P` present. Esc closes (Radix).
- Ignored when `metaKey`, `ctrlKey` or `altKey` is held (Cmd+P still prints, Cmd+L still focuses the address bar), when `event.defaultPrevented`, or when the target is inside `input`, `textarea`, `select`, `[contenteditable]`, `[role=grid]`, `[role=menu]`, `[role=menuitem]`, `[role=radiogroup]`, `[role=listbox]`, the range strip (`[data-range-strip]`), or a chart point button (`[data-point-button]`).
- Off switch (WCAG 2.1.4): a `role="switch"` button `Shortcuts: On|Off` in the hint row, stored on the device (`localStorage` key `opsvision.shortcuts`, value `off`), following `useNavCollapsed`. The server preferences have no field for it, and adding one would be an API change.
- Hint row at the bottom of the body (11, `ink/70`; hidden on phones): `← → previous / next metric · 1–5 range · T table · L copy link · Esc close` and the switch.

### 8.5 Body

Value row (focus size: value 28, chip `lg`, change 16/500, since-when, goal and YTD 14 `ink/70`), the kind's chart (§7) or item grid (§6.5), the range strip (as approved; caption `Change from the first month in each range to Oct 2026`, 11 `ink/70`; hidden for coarse, sparse and multi-series metrics and in non-month grains), the breakdown (§7.1), the hint row. The always-present `Loading chart…` line goes: while another window loads the chart keeps its size with `aria-busy` and a visually hidden status. If the dialog's own request fails while 12 months are shown, the region error of §3.9 appears under the chart.

### 8.6 Ask SAM

The only labelled header action. The dialog stays open behind the drawer; focus moves to the drawer and returns to the Ask SAM button on close.

## 9. Accessibility

- Status: shape and letter (chips) or letter (cells) plus words in names; tier fills differ in form (soft, outlined, solid), not only color.
- Grids (board, item grid): one tab stop, arrows, Home/End, PageUp/PageDown, Enter; `cellName` names; group headers skipped by arrows. The tile mini board and attention mini boards are decorative; their rows (tile) are buttons ≥ 28px.
- Charts: SVG `aria-hidden`; a text summary and the point buttons (`sr-only focus-within:not-sr-only`, `data-point-button`) stay; diverging bars, coarse points and small multiples get them too. Summaries: §6.6, §7.4; the attention trend's summary is part of the card description.
- Targets ≥ 24×24: icon buttons 32px, cells 24px, tile rows 28px. 18px cells appear only where they are decorative.
- Headings: tiles and attention cards are `article` + `h3`; sections `h2`; the dialog one `h2`; the drill-in item `h3`.
- Focus: returns to the trigger on dialog close (`focusReturnRef`); to the drill-in heading on entry and to the item's row on exit; to the first tile after `Show all`; to `Customize layout` after Done.
- Text contrast ≥ 4.5:1 (§3.2); live regions (§3.10); segmented controls (§3.11); shortcuts (§8.4); reduced motion (§3.12).

## 10. Responsive and grains

| Width | Overview | Dialog |
|---|---|---|
| ≥1024 | Needs attention 3 columns; tiles 2 columns (small) or full (wide) | inset 32px; one header row; item grid per §6.3 |
| 640–1023 | Needs attention 2 columns; tiles 2 columns | inset 32px (0 under 768) |
| < 640 | One column; control bar not sticky, collapsed to one 40px row `Oct 2026 · All of Acme Demo · Filters` opening a bottom sheet (Radix Dialog) with the full control bar; Needs attention compact rows; Health toggles 2×2 | Full screen; two header rows; phone chart geometry; item grid per §6.3 (6 columns at 390, stacked at 360) |

Grains: titles and comparisons follow the grain (§4.2); columns are the grain's trend (12 months, 8 quarters, 4 halves, 3 years) with §6.3 halving; range controls appear only in month views; coarse rules follow §5.

## 11. Reuse map

| Need | Reuse | Change |
|---|---|---|
| Cells, chips, legend, tip, roll-up, keyboard grid | `StatusBoard.tsx` internals | Extract to `web/src/ui/status/` (`StatusChip` `size: 'md' \| 'lg'`, `StatusCell` `size: 'md' \| 'sm' \| 'xs'`, `Legend`, `StatusCellTip`, `RollUp`, `useGridNavigation`); `StatusBoard` re-imports them with no DOM change |
| Cell semantics | `logic/statusBoard.ts` | `notDue` kind and coarse mapping (§5.4) |
| Worst child | `FocusDialog` `rankedChildren` | `logic/drivers.ts` `worstChildren(children, columnKey, scale, direction)` |
| Status at scope | `logic/statusAtScope.ts` | Not-reported count in the caption |
| Charts | `charts/MetricChart.tsx` (988 lines) | Split into one file per kind first (no behavior change), then §7 |
| Uptime | `UptimeRows` | Replaced by `ItemGrid` (dialog) and `ItemSummaryTile` (Overview) |
| Ranges | `charts/ranges.ts` | Change-rule terms |
| Exports | `exports.ts` | Money plan bars; item grid export in a new `itemExports.ts` |
| Needs attention | `logic/needsAttention.ts` | New Red slot, streak in months, reasons, totals |
| Layout | `LayoutGrid.tsx`, `logic/layoutReorder.ts` | Customize mode; `moveBlock` reused unchanged |

## 12. Feasibility: no API change

| Need | Already available |
|---|---|
| Per-item thresholds | `Cell.rule` (after per-subject bands) |
| Goal | `Cell.target` |
| Definition | `ViewRow.definition` |
| Source, frequency, reported-at | `Metric.source`, `Metric.frequency`, `Metric.reportedAt` via `useVersions` and `Cell.versionId` |
| Item org unit | `GET /items` (`useItems`, any member) + `useOrgUnits` |
| Item kind and level names | `useItemKinds`, `useOrgLevels` |
| Methodology-change marker | published versions' `effectiveFrom` and names (`useVersions`), `Measure.source` |
| Items with no data | engine rows for every item of the kind |
| Coarse periods | `periods` accepts any grain; ≤ 21 on the Overview, ≤ 24 in the dialog |
| Shortcut off switch | device storage (server preferences only hold `defaultScope`) |

Not available, and so not designed: owner fields; item onboarding dates (leading no-data dots stay); history before the window ("Last reported" and streaks are capped at the window); downtime minutes (not derived; a metric may be request-based). Optional, not blocking: `orgUnitId` and `itemKindId` on item `ViewRow`s.

## 13. Verification

- Unit: `statusText.ts`, `nouns.ts`, `drivers.ts`, `coarse.ts`, `coarseColumns`, `focusWindow`, request period counts (≤ 24 for every range, grain and frequency), `itemGridLayout` (the §6.3 table), `itemGrid.ts`, `needsAttention`, `buildBoardRow` (`notDue`), bar geometry.
- Component (Vitest, Testing Library, `vitest-axe`): axe and keyboard tests for every new component; shortcuts ignored with modifiers and inside inputs, grids, menus and radio groups; Customize mode `inert`; drill-in focus and restore by id after sort and filter.
- Each implementation task ends with `npm --prefix web test` (count named), `npm --prefix web run typecheck`, `npm --prefix web run lint` (0 errors), and `make dev` screenshots at 360, 390 and 1440 of what it touched, with `scrollWidth === clientWidth`.
- API: `go test ./internal/demo/...` (the demo covers every case above).

## 14. Mockups

HTML prototypes rendered from the demo tenant's view (captured from `make dev`), with screenshots, in the local working folder `.superpowers/sdd/2026-11-16-dashboard-ux/mockups/` (not committed). Pink pins and "Design notes" panels are annotations.

| Design | HTML | Screenshots |
|---|---|---|
| Uptime expanded (grid, summary, sort, filter, since when, stacked mode, drill-in) | `uptime-expanded.html` | `uptime-expanded-1440.png`, `-390.png`, `-360.png` |
| Uptime tile (exceptions first, row buttons), section header, sparse tile | `uptime-tile.html` | `uptime-tile-1440.png`, `-390.png`, `-360.png` |
| Health and Needs attention (stretched-link cards, item card, phone compact rows) | `overview-top.html` | `overview-top-1440.png`, `-390.png` |
| Customize layout mode | `customize-layout.html` | `customize-layout-1440.png`, `-390.png` |
| Dialog chrome, More menu, source line, shortcut switch, breakdown | `focus-chrome.html` | `focus-chrome-1440.png`, `-390.png` |
| Money plan, tile and expanded | `bars-money-plan.html` | `bars-money-plan-1440.png`, `-390.png` |
| Multi-series, change rule, stopped, no reports, loading, dialog error, coarse metric, small multiples, Not reported | `tile-states.html` | `tile-states-1440.png`, `-390.png` |

## 15. Decisions

1. **Scale labels over rank labels.** `5 Red`, not `Off track 5`.
2. **Item headlines count the best status.** `18 of 24 services Green`, with the tenant's best-status label and all items in the denominator, because per-subject bands make a single threshold untrue. The tile's threshold line says how many items have their own target.
3. **Needs attention:** one slot for the most severe New Red, the rest by Red streak in months, then distance, then category order. Long, mild Reds cannot bury a severe new breach; persistent ones still lead.
4. **Source, not owner.** `Source · Measured … · Methodology ›` from the version in force; owner logged as a future methodology field.
5. **One status language.** Green cells keep full-strength letters everywhere (no dimming on some surfaces only).
6. **No nested scroll.** Item grids halve or stack instead of scrolling sideways.
7. **Coarse metrics at their own grain**, counted by one due/overdue rule, drawn as the approved line chart with points (not bars).
8. **Layout editing is a mode.** No layout chrome at rest.
9. **Shortcut preference on the device**, because the server preferences have no field for it.

## 16. Review resolution

| Review gap | Resolution |
|---|---|
| C1 Dialog period overflow | §5.2: dialog asks for the metric's own grain only (≤ 24); explicit window; range strip hidden for coarse metrics with `vs Q2` (§5.5) |
| C2 Coarse metrics counted twice | §5.3 due/overdue rule read by Health, Needs attention, board and Not reported; §4.7 quiet line |
| C3 Item grids overflow | §6.3 `itemGridLayout` with halving and a stacked mode; tested widths |
| C4 Tile toolbars undesigned | §4.1 Customize layout mode; no toolbars at rest; `inert` content; Done and keyboard drag |
| I5 Item grid rows | §6.1 `subjectKind === 'item'`; which metrics; scope value in summary |
| I6 Nouns and groups | §3.8 `nounForms`, item kinds, org levels, `Unassigned`; §6.2 `useItems` enabled |
| I7 Non-month grains | §4.2 grain titles and comparisons; §6.5 range control month-only; §10 |
| I8 Annual metrics | §5 years (3 columns), copy, due rule |
| I9 Drill-in focus | §6.6 heading focus, history entry, restore by id |
| I10 Grid state | §6.5 sort in URL; §6.6 filter and scroll in the dialog body |
| I11 Per-item thresholds | §6.6 item `Cell.rule`; §6.4 honest threshold line |
| I12 Item grid actions | §6.7 grid SVG/PNG, CSV per item, `1`–`3` |
| I13 vs-goal bar | §7.1 only for percent formats with a target |
| I14 Needs attention header | §4.3 mixed copy; Show all only with more Reds than shown |

## 17. Implementation

Nine tasks with single-owner files; see the plan. Order: 0 and 1; then 2 and 3; then 4 and 5; then 6 and 7; then 8.
