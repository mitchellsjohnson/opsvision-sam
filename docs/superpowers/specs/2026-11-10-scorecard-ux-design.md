# OpsVision — Scorecard UX: Overview, Table, Full Screen, Layout, and Monthly Report

Status: approved by the maintainer on 2026-11-10
Date: 2026-11-10
Extends: `2026-10-30-opsvision-design.md` §7 (Views) and §8 (Monthly brief). Where they disagree, this document wins. The monthly operating report in §9 **replaces** the main spec's monthly brief.

## 1. Intent

The first scorecard UI works but reads like a scaled-down spreadsheet: one sparkline per metric that often shows loose dots, tiles that show "—" because only the company row is charted, a table that scrolls inside the page and sideways, repeated not-applicable text that sets column widths, and no room for the AI assistant. The maintainer called it "terrible" and asked for a frontier-quality redesign.

Four independent reviews (Gemini 4 Argon, Claude Opus 5.5, GPT-5.6 Sol, Grok 4.7) reached the same diagnosis and the same recommended direction. The maintainer approved that direction from a mockup ("beautiful, lock it in") and added three requirements: draggable charts and widgets, click-to-full-screen, and a monthly operating report exported as PPTX and PDF.

Success: an executive opens the scorecard and, without scrolling sideways or hunting, sees how the month went, what needs attention and why, and can drill into any metric, rearrange the page to their priorities, and hand leadership a polished monthly report in one click.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Separate **Overview** (charts) and **Table** pages that share one control bar and always agree.
2. One chart design per kind of metric, with status bands, a labelled goal, a labelled current value, and an org breakdown.
3. Any chart, widget, or table opens full screen by clicking it.
4. Users rearrange (drag) Overview charts and widgets; the arrangement persists per user.
5. A monthly operating report, viewable in the app and exported as PPTX and PDF.
6. A layout slot for SAM (the assistant) that the page reflows around.
7. Everything in this document ships together (no staged slices), within the main spec's timeline (production-ready by 2027-01-01). Plans surface schedule risk early rather than cutting scope silently.

**Non-goals (this project)**

- SAM itself, its setup flow, and the MCP server (later projects; this project only reserves the dock).
- The searchable activity log page (next project).
- AI-written report narrative (SAM project); this project ships a human-editable summary plus computed facts.
- New metrics or methodology features.

**Anti-goals (failure even if it works)**

- Any horizontal scrollbar, or a scroll container nested inside the page scroll, on the Overview, Table, or report pages at widths 1280–1920 px.
- Status shown by color alone anywhere (charts included).
- Overview and Table showing different numbers for the same controls.
- An exported report that differs from what the app shows for the same month.

## 3. Information architecture

### 3.1 Routes

- `/scorecards/:sc/overview` (default when opening a scorecard)
- `/scorecards/:sc/table`
- `/scorecards/:sc/report` (monthly operating report preview and export)
- Full screen is a dialog over the current page, linkable with `?focus=<widget id>`.
- Existing `/scorecards/:sc?tab=...` links redirect to the matching route.

### 3.2 One control bar

A single sticky bar below the app header, shared by all three pages, all state in the URL:

- View switch: **Overview | Table | Report**.
- **Period**: one popover ("Sep 2026 · Monthly ▾") holding grain (month, quarter, half, year), fiscal year, period, and the year-to-date toggle.
- **Scope**: org-tree picker with search (company, a segment, or a product; tracked items under their units).
- **View options** ("As reported ▾"): methodology restatement and org structure (as of each month / today's structure). Restated views show an amber "Restated under …" chip.
- **Ask SAM** button (disabled with "coming soon" until the SAM project; the dock slot exists now).

Every control applies to every page. If a control cannot apply somewhere, it is visibly disabled there with a reason, never silently ignored.

### 3.3 Shell and scrolling

- The app shell becomes a grid: navigation, main content (`minmax(0, 1fr)`), and an optional right dock (SAM, 360–400 px). The navigation collapses to a 64 px icon rail below 1440 px or when the dock is open.
- **The document is the only scroll container.** No `overflow: auto` / fixed `max-height` around page content. Sticky elements (control bar, table header) stick to the viewport. Only true overlays (popovers, drawers, dialogs) may scroll internally.
- All content regions use `min-width: 0` and container queries so opening the dock reflows content instead of overflowing.
- The cell drawer uses the same right dock position (it replaces the dock while open).

### 3.4 Mobile (< 768 px)

Navigation and control bar collapse into sheets; Overview is one column; the Table becomes metric cards with a six-month status strip; full screen and the drawer are full-screen sheets; drag-to-rearrange is disabled (order is still applied).

## 4. Overview page

Top to bottom:

1. **Header**: scorecard name, the period sentence ("September 2026 · year to date through September · All of <company>").
2. **Health this month** widget: counts of On track / Watch / Off track / Not reported at the selected scope. Clicking a count filters the Overview to those metrics (chip shows the active filter).
3. **12-month status** widget: one row per metric, twelve lettered status squares (letter + color), and the current value.
4. **Needs attention** section: up to three metric cards chosen automatically — off-track metrics first, then the largest worsening versus the prior period, then watch metrics; ties by category order. Cards are larger and include a driver line (the worst child units or the largest contributors).
5. **Category sections** (category order from the methodology): one chart card per metric. Sections show their status counts in the heading.
6. **Not reported** line: metrics with no value for the period collapse into one line naming them and their next due period (quarterly/biannual), with "Enter data →" for users who can enter data.

**Scope semantics.** "All of <company>" shows the company row; a card's org breakdown shows the next level down. If the company cell is missing or not applicable but children have values, the card says so ("Company total not reported; 4 segments reported") and shows the children instead of a blank.

**Status of a metric at a scope (shared logic for health counts, needs attention, the 12-month status widget, and report facts).** If the metric has a value at the selected scope, its status is that cell's status. If it has no value there but reported children (org units or tracked items) do, its status is the **worst reported child's status**, labelled "worst of N segments" / "worst of N services" wherever the status is shown. If nothing is reported, it is "Not reported". "Worst" follows the tenant status scale's rank.

**Needs attention ranking.** Candidates are metrics whose status is the worst rank (off track), ordered by how far past the worst band threshold they are relative to that band's width; then metrics whose status worsened by at least one rank versus the prior period, ordered by ranks lost then by the same distance measure; then middle-rank (watch) metrics. Up to three are shown; ties by category order.

**Grains other than month.** At quarter, half, or year grain the Overview uses that grain's periods: the trend window is the last 8 quarters, 4 halves, or 3 years ending at the selected period; labels adapt ("Health this quarter", "8-quarter status"). The report remains monthly in this version.

**Charts honor every control**, including year to date (shown as a secondary figure on the card and as a pinned column in the Table) and restatement/structure.

## 5. Chart design system

### 5.1 Choosing the chart

The chart kind is chosen from data the view already carries, with an optional override:

- `format`, `direction` (higher/lower is better), `frequency` (monthly, quarterly, biannual, annual), the status rule type (bands, change, scale) and its bands/compare, resolved per subject (per-subject bands apply).
- The view API adds these fields so the client does not need to join methodology versions: each **cell** carries the resolved rule (bands/compare/scale, per-subject bands applied) of the methodology version in force for that cell's period, and each **row** carries `frequency` and the chart kind from the version of the latest column. Bands drawn on a chart therefore step where the methodology version changes, and a month's status letter always agrees with the band it sits in. Metrics may also set an optional `chartKind` in the methodology to override the automatic choice (taken from the latest column's version).
- **Status scales.** The visual system is designed for the default three-level scale (Green/Yellow/Red: shapes ●▲◆, tints, health buckets On track/Watch/Off track). A tenant with a different scale gets each level's own letter and color on neutral round markers, health buckets by rank (best, middle levels, worst), and contrast checks on the tenant colors (falling back to ink text when a tenant color fails contrast).

| Metric kind | Detection | Chart |
|---|---|---|
| Ratio % | percent formats, bands rule | Line over tinted status bands, labelled goal, enlarged labelled current point; numerator/denominator shown under the value |
| Money vs plan | spend vs plan style (percent of plan with lower/upper bands around 100) | Bars above/below a 100% reference line, colored and lettered by status; not-applicable months shown as a neutral "n/a" tick |
| Score judged by change | change rule | Score line on top; change vs comparison as status-colored bars below, labelled "↑ worse / ↓ better" per direction |
| Uptime per service | tracked items of a service kind, high-precision percent | One row per service: 12 lettered status cells plus the current value; full screen adds a 99.0–100% line per service with 99.8/99.9 bands |
| Days / SLO | days format, lower is better | Line against the limit line; area beyond the limit tinted |
| Sparse counts | monthly results that are frequently not applicable (e.g. initiatives on budget) | Lettered monthly result chips with the current value |
| Quarterly / biannual / annual | frequency | Discrete period columns (this period vs prior, and next due period); never a 12-month line with gaps |

### 5.2 Encoding rules (every chart)

- **Bands** from the resolved rule as light status tints (8–12% opacity), with a 1 px edge at 3:1 contrast and labels once per chart. Domains come from the metric (percent 0–100 unless bands require a zoom; uptime zoomed to 99.0–100 and labelled as zoomed).
- **Goal** (target) as a dashed, labelled ink line.
- **Status** always by shape and letter as well as color (G ●, Y ▲, R ◆); the current point is enlarged and labelled with value and letter.
- **Missing** data is a gap with a "no data" tick; **not applicable** is a neutral hatched/"n/a" marker; they never look alike.
- **Overrides** are a hollow marker with † and the reason in the tooltip.
- **Tooltips** are keyboard reachable; every chart has a text summary and a "View as table" option.
- **Motion**: draw once (≤300 ms), crossfade on control changes (≤150 ms), none under `prefers-reduced-motion`.
- **Library**: Recharts 3 (already in use). No new charting library.

### 5.3 Org breakdown

Card footer: the worst child units with values and letters. Full screen: ranked horizontal bars for the next level (worst first), click a bar to drill one level; optional small multiples on a shared axis (up to 8, then "show all").

## 6. Table page

**Keep**: heat-tinted cells with status letters, category rows, metric/subject hierarchy with expand toggles, caption, cell drawer with provenance and override controls, separated YTD column, restatement banner.

**Change**:

- **Fits the width, never scrolls sideways.** `table-layout: fixed; width: 100%`. Metric column `clamp(13rem, 24%, 18rem)` (two lines max); period columns at least 4.5rem; YTD pinned at the right. The visible month count is computed from the available width and ends at the selected period; a "‹ Earlier / Later ›" stepper moves the window. Typical: 6 months at 1280 px, 12 at about 1700 px or wider; opening the dock removes columns rather than overflowing. The selected period column has an accent top edge.
- **Cells**: right-aligned tabular numbers with a fixed-width status letter chip; uniform row height; values never wrap.
- **Not applicable**: a quiet "n/a" chip; the reason is the accessible name and tooltip, and recurring reasons get one legend line under the table.
- **Rows**: subject rows start collapsed; a collapsed parent shows its children's status mix ("4 segments · 1G 2Y 1R"). Toolbar: Expand all / Collapse all, "Only off track", Earlier/Later, and full screen.
- **Overrides**: the † mark stays in cells; identical override notes are grouped into one collapsible note ("12 values as reported in the legacy workbook · show cells").
- **Metrics with no data in the window** become one row ("No data in this range · Enter data").
- **Sticky header** sticks to the viewport below the control bar; category rows stick under it.
- **Keyboard**: an ARIA grid with a roving tab stop (one Tab into the table; arrow keys move between cells; Enter opens the drawer).

## 7. Full screen

- **Click to open**: clicking a chart card, widget, or the table's full-screen button opens it full screen. Each also has a visible "Expand" button (the keyboard path). Interactive children (chart points, links) keep their own behavior; clicking empty card space opens full screen.
- **Container**: a full-viewport dialog that traps focus; Esc or Close returns focus to the opener. URL `?focus=<widget id>`.
- **Chart full screen**: large chart with axes, legend, and bands; 12/24-period toggle; org breakdown (ranked bars, small multiples); "View as table"; Export PNG / SVG / CSV; Copy link; "Ask SAM about this" (enabled with SAM). Left/Right arrows (and buttons) step to the previous/next card.
- **Table full screen**: hides navigation, shows as many periods as fit (often all 12 plus YTD), same no-horizontal-scroll rule; Export CSV.
- **Present mode** (optional button): uses the browser's full-screen API for meetings.

## 8. Draggable layout

- **What moves**: on the Overview, every chart card and widget (health, 12-month status, category sections, individual metric cards, the not-reported line) can be dragged to a new position. Needs attention stays at the top (it is computed), but its cards can be hidden.
- **Grid**: a responsive column grid; a card can be **small** (1 column) or **wide** (2 columns) via its menu; position and size are what persist. Category sections can be reordered as units, and metric cards can be moved within and between sections (a moved card keeps its category label).
- **Hide and restore**: cards can be hidden from the menu; a "Hidden (n)" control restores them.
- **Keyboard and screen readers**: every draggable item has a handle that supports keyboard moves (Space to pick up, arrow keys to move, Space to drop, Esc to cancel) with live-region announcements; the card menu also offers Move up/down/to top and Resize.
- **Persistence**: per user, per scorecard, stored server-side so it follows the user across devices: new endpoints `GET/PUT /v1/me/layouts/{scorecard}` (body: ordered items with ids, sizes, hidden flags; version field for optimistic concurrency). "Reset layout" restores the default. Admins can save the current layout as the **tenant default** for that scorecard (`PUT /v1/scorecards/{sc}/default-layout`), which new users get. Unknown items in a saved layout (e.g. a metric removed from the methodology) are ignored; new metrics appear at the end of their category.
- **Mobile**: order and hidden flags apply; dragging is disabled.
- **Library**: drag-and-drop with built-in keyboard and screen-reader support is required; the dependency is chosen through the maintainer's vetting process during planning (no hand-rolled pointer-only drag).

## 9. Monthly operating report

### 9.1 What it is

A report for leadership for one month of one scorecard, previewed at `/scorecards/:sc/report?period=YYYY-Mmm` and exported as **PPTX** and **PDF**. It uses the same data, chart kinds, and scope as the Overview for that month, so the export always matches the app.

### 9.2 Contents (default template)

1. **Cover**: scorecard name, month, scope, organization name, generated date, methodology version(s).
2. **Executive summary**: health counts; an editable **summary** text (written by an admin, saved per scorecard and month; the SAM project will later draft it); computed facts ("2 metrics turned red: …", "first green in 8 months: …", "not reported: …").
3. **Needs attention**: the same up-to-three metrics as the Overview, each with its chart, value, status, change, and driver line.
4. **One section per category**: each metric's chart, current value, status, change vs prior period, year to date, and goal.
5. **Scorecard table**: the month and the five before it plus year to date for every metric at the selected scope (fits the slide/page; split across pages if needed, never shrunk below legibility).
6. **Notes**: overrides (grouped), not-applicable reasons, metrics not reported, and the methodology version footnote.

The report follows the user's saved Overview order for category sections and hides metrics the user has hidden only if they choose "Use my layout"; the default is the full standard order.

### 9.3 Export formats

- **PPTX**: 16:9 slides with **native, editable charts** where the chart kind allows (line, bar), text as editable text boxes, and the app's palette; complex encodings that native charts cannot express (status strips, banded backgrounds) render as high-resolution images. Each slide has speaker notes with the metric definition and source.
- **PDF**: a vector document (US Letter landscape by default, A4 option) laid out from the same report pages, with real text (selectable, searchable) and document metadata (title, month).
- **Generation** happens in the browser from the report page's data; no server rendering is required. Libraries for PPTX and PDF generation are chosen through the maintainer's vetting process during planning.
- **Accessibility**: the in-app report page is the accessible version (WCAG 2.2 AA); exports include alt text for chart images and slide titles in reading order; tagged-PDF completeness depends on the chosen library and is reported as a known limit if incomplete.

### 9.4 Summary storage

New endpoints `GET/PUT /v1/scorecards/{sc}/reports/{period}/summary` (admin writes; members read), revisioned and audited like other writes. The summary belongs to the **company-scope** report for that month; at other scopes the report shows "Summary is written for <company>" with a link instead of the text, and computed facts are recomputed for the scope.

### 9.5 Live, published, and history (replaces the monthly brief)

- **Live report**: any month can be previewed and exported at any time. The open (current) month is labelled "Month to date, as of <date>".
- **Publish** (admin): freezes the company-scope report for the month as a **snapshot**: the data behind every chart and table (cells, components, statuses, overrides, notes), the summary text, the computed facts, the methodology versions, and the generation time. Publishing an unlocked month shows a warning but is allowed. Exports of a published report are produced from the snapshot, so they never change.
- **Revisions**: publishing again creates a new revision; all revisions are kept and listed with who and when.
- **Data revised since publication**: if any value behind a published snapshot changes later (a correction, an override, a records recalculation), the published report shows a banner "Data revised since publication" with a link to the live version and a list of what changed.
- **History**: the report page has a list of months with their status (Live, Published on <date> by <name>, Revised since publication) and opens any of them.
- **Storage**: snapshots as JSON objects in the objects store keyed by tenant, scorecard, month, and revision; a small index item per published revision in the table; publish and republish are audited.
- **Endpoints**: `GET /v1/scorecards/{sc}/reports` (months with status), `POST /v1/scorecards/{sc}/reports/{period}/publish`, `GET /v1/scorecards/{sc}/reports/{period}?revision=` (live when no published revision, else latest published; `revision=live` forces live).
- **Later (SAM project)**: AI-drafted summary and audience versions (for example a CISO version).

## 10. Visual language

- **Type**: tabular numerals everywhere. Scale 12 / 13 / 14 / 16 / 20 / 28 / 40: hero number 40/600, card value 28/600, card title 14–15/600, metadata 12–13. Headings in ink; category headings as small uppercase labels with status counts.
- **Color**: purple for interaction, selection, the current period, and the primary data series; status colors only for status, always with letter/shape; amber only for restated/attention chrome (never amber text on white).
- **Surfaces**: warm light page background, white cards (radius 12, 1 px ink/8 border, soft shadow on hover and focus), 8 px spacing system, auto-fill grid `repeat(auto-fill, minmax(min(100%, 22rem), 1fr))`, Needs attention cards spanning wider.
- **Delta wording**: plain language with arrows and direction ("▼ 8 pts vs Aug", "▲ 16.6% worse").

## 11. Accessibility

WCAG 2.2 AA throughout: keyboard paths for full screen, drag, chart points, and table cells; focus management in dialogs; text summaries for charts; contrast ≥ 3:1 for graphical elements and ≥ 4.5:1 for text; status never color-only; reduced motion respected.

## 12. Performance

The Overview makes one view request for the trend window (plus one for year to date if needed) and renders under 1.5 s for a year of data at the first adopter's scale. Charts below the fold render lazily. Export of a full report completes in under 10 seconds in a current browser.

## 13. Verification

- Unit/component tests for chart-kind selection, windowing math, layout persistence, and report assembly.
- Accessibility checks (axe) on every page and dialog, plus keyboard tests for drag and full screen.
- A visual check at 1280, 1440, and 1920 px with and without the dock open, asserting no horizontal scroll (document `scrollWidth <= clientWidth`) and a single scroll container.
- A before/after change report (screenshots of Overview, Table, full screen, report) for the maintainer.
- Export tests: generated PPTX and PDF open and contain the expected slide/page count and titles for a fixture month.

## 14. Decisions

**Decided by the maintainer**

- The executive-briefing direction from the mockup: Overview with health, 12-month status, needs attention, typed charts by category, not-reported line; separate Table page; full-screen metric view with org breakdown ("beautiful, lock it in").
- Table shows the months that fit ending at the selected month, YTD pinned, with an earlier/later stepper.
- Charts and widgets are draggable; click opens full screen.
- Monthly operating report exported as PPTX and PDF.
- Project order: this UX, then the activity log page, then SAM and an MCP server on one shared tool layer. SAM uses an admin-entered AI key set up through a short flow when someone first clicks Ask SAM, with specific supported models.
- Everything in this document ships together, no staged slices.
- The monthly operating report replaces the monthly brief, including publish/freeze, revisions, "data revised since publication", and past-month history now.
- A metric without a value at the selected scope takes its worst reported child's status, labelled "worst of N".

**Tech-lead calls (maintainer may override)**

- Three routes (overview, table, report) under one control bar; Overview is the default.
- Restatement and structure move into the shared control bar.
- Navigation collapses to an icon rail; a right dock slot is built now and used by the cell drawer.
- Chart kind from data with an optional methodology `chartKind` override; the view API's rows add `frequency` and the resolved rule.
- Layouts persist per user server-side; admins can set a tenant default; small/wide card sizes; hide/restore.
- Report generated in the browser; native editable charts in PPTX where possible; summary text stored per month.
- ARIA grid with roving focus for the table.
- Bands and status follow the methodology version in force per cell; chart kind from the latest column's version.
- Non-monthly grains use 8 quarters / 4 halves / 3 years; the report is monthly only for now.
- Custom status scales get letter chips on neutral markers and rank-based health buckets.
- The report summary is company-scope only; other scopes link to it.
- Needs attention ranking: off track by distance past the worst threshold, then worsened by rank, then watch.

## 15. Left to the builder

- Exact component structure and file layout under `web/src/features/scorecard/`.
- Exact column-width math and breakpoints within the stated rules.
- Detection thresholds for "sparse counts" and the money-vs-plan kind.
- Report page breaks and slide layouts within the stated contents.
- Choice of drag, PPTX, and PDF libraries (through vetting).
