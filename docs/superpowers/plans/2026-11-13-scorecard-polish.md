# Scorecard Polish Implementation Plan

> **Superseded (2026-11-13):** the 2026-11-10 scorecard UX plan already delivers these features. Only Task U1 (manual navigation toggle and latest-month default, commit 695dcee) was implemented from this plan.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the scorecard presentation-ready for executives and program managers. This plan adds:
- a collapsible left nav;
- a chart view that expands to about 90% of the screen, with axes, tooltips, a legend, goal and threshold bands, range, prior-year and segment comparison, and a data table, plus CSV and PNG downloads;
- the same expand and CSV for the Table tab;
- livelier chart tiles;
- opening on the latest month with data.

**Architecture:** web-only except U1's `latestDataMonth` field. Shared chart pieces live in `web/src/ui/charts/`. Expanded views are Radix Dialogs sized to 90vw × 90vh.

**Tech Stack:** existing only (React 19, Tailwind 4, Radix, Recharts 3, lucide-react). No new dependencies. PNG export serializes the chart's SVG to a canvas in the browser.

**Spec:** the maintainer-approved description, 2026-11-13. It extends main spec §7 (Charts tab, Table tab).

## Global Constraints
- WCAG 2.2 AA. Status is never conveyed by color alone: always a letter or label as well.
- Every chart has a text alternative: the visually hidden summary on tiles, and the data table in the expanded view.
- Tooltips work by keyboard focus as well as hover.
- Animations only under `prefers-reduced-motion: no-preference`.
- Plain-language copy. No company names, so example data only in tests.
- Downloads are generated client-side.
- CSV:
  - UTF-8 with a BOM.
  - Values that could be read as formulas (starting with `= + - @`) are prefixed with `'`.
  - Filename `<scorecard>-<metric>-<subject>-<from>-to-<to>.csv`, slugified.
- Keep existing behavior and tests green. Use the existing tokens in `web/src/ui/tokens.css` and the existing `StatusBadge`.

## Review Focus
1. **Missing data:** a month with no value, a not-applicable month, or an override in a series. Tooltips, CSV and the chart show it honestly: a gap, "Not applicable: reason", or "Overridden". Never 0. Tests in U2 and U3.
2. **Collapsed nav and keyboard:** with the nav collapsed, every link is still reachable by Tab with an accessible name, and the toggle state persists. Test in U1.
3. **Large tables in the expanded view and CSV:** 20 metrics × 30 subjects × 13 columns keep headers pinned, and the CSV matches what's shown, including YTD and status letters. Test in U4.
4. **Dialog focus:** opening and closing the expanded chart or table returns focus to the expand button, and Esc closes it. Tests in U3 and U4.
5. **Default month:** with no `period` in the URL, the app opens on `latestDataMonth`. An explicit `period` always wins, and the current month is used when there's no data. Test in U1.

---

### Task U1: Collapsible nav and latest-month default
**Files:** `web/src/shell/AppShell.tsx` (+ tests), `web/src/shell/usePeriodState.ts` (or wherever the default period is chosen) (+ tests); `openapi/openapi.yaml` + `make gen`, `api/internal/httpapi` (scorecards list) (+ tests).
- **Nav toggle:** a button at the top of the nav, `aria-expanded` plus `aria-controls`, labeled "Collapse navigation" / "Expand navigation". When collapsed, the nav becomes a 56 px rail with icons (lucide), and every link keeps its accessible name (`aria-label`) plus a Radix tooltip. The state persists in `localStorage` key `opsvision.nav.collapsed`. Main content widens.
- **Scorecard summary:** gains `latestDataMonth` (Period string or null), the newest month-grain period with any stored data point for the scorecard in the current or previous fiscal year.
- **Period state:** with no `period` in the URL, it uses `latestDataMonth` if set, else the current month. An explicit `period` wins.
- **Tests:**
  - Toggle collapses and persists.
  - Rail links are reachable by keyboard and named.
  - axe passes.
  - Default period cases.
  - Go: `latestDataMonth` is computed, and null when there's no data.

### Task U2: Chart toolkit and livelier tiles
**Files:** create `web/src/ui/charts/{ChartTooltip.tsx,statusColors.ts,exportCsv.ts,exportPng.ts,seriesModel.ts}` (+ tests); modify `web/src/ui/Sparkline.tsx`, `web/src/features/scorecard/MetricTile.tsx` (+ tests).
- **`seriesModel`:** turns view rows and cells into points `{period, label, value|null, display, status, naReason, override, components, change}`.
- **`ChartTooltip`:** month, display value, `StatusBadge` letter and label, components (e.g. `94 / 131`), change vs the prior month, "Not applicable: …", "Overridden by … : reason".
- **`exportCsv(rows, columns, filename)`** and **`exportPng(svgElement, filename, {background})`**. The PNG uses SVG serialization, inline styles, then `canvas.toBlob`, at 2× scale with a white background.
- **Tiles:**
  - a soft gradient area under the sparkline, colored by the current status;
  - a highlighted current-month point;
  - a hover and focus tooltip on points;
  - a small trend arrow with an accessible name ("Up 2.1 points vs Aug"), direction-aware for lower-is-better metrics;
  - an animated draw-in under reduced-motion rules;
  - an expand button ("Expand <metric> chart") that U3 wires to the dialog, here just a callback prop.
- **Tests:** `seriesModel` with not-applicable, override and missing months; CSV escaping and formula guard; tooltip content; trend arrow wording; axe.

### Task U3: Expanded chart dialog
**Files:** create `web/src/features/scorecard/ExpandedChart.tsx`, `chartModel.ts` (+ tests); modify `ChartsTab.tsx`, `MetricTile.tsx`, `web/src/api/queries.ts` (as needed).
- **Dialog:** a Radix Dialog at 90vw × 90vh. Its title is the metric name and subject.
- **Large `ResponsiveContainer` line chart:**
  - axes with formatted ticks, horizontal gridlines;
  - the target as a dashed `ReferenceLine` labeled "Goal";
  - the green band as a `ReferenceArea`, from the metric's status-rule green band in the methodology version in force (read client-side from the version content), omitted for change or scale rules;
  - points colored by status, with letters in the tooltip;
  - `ChartTooltip`;
  - a `Legend` with the value, goal, green band, prior year and compared subjects.
- **Controls:** range (12, 24 or 36 months, or All, which is everything stored, fetched via the view API with those periods); "Show prior year" (a dashed line of the same months a year earlier); "Compare" (a multi-select of child subjects, default the direct children, one line each with distinct accessible colors and a legend).
- **Data table under the chart:** period, value, status letter, components, change, note, for the main series and any compared ones.
- **Downloads:** "Download CSV" (the data table) and "Download PNG" (the chart), with the filenames in Global Constraints.
- **Tests:** open and close focus return; Esc; range refetch; prior-year series; compare adds lines and legend entries; data table matches; CSV content; PNG invoked; not-applicable months shown as gaps with a note; axe.

### Task U4: Expanded table and CSV
**Files:** create `web/src/features/scorecard/ExpandedTable.tsx`, `tableExport.ts` (+ tests); modify `TableTab.tsx`.
- **Expand button:** "Expand table" in the Table tab header opens a 90vw × 90vh dialog. It renders the same `TableTab` content: the same filters, restatement and structure. Headers stick (`position: sticky` on `thead` and the first column), and the dialog scrolls internally.
- **"Download CSV"** in both normal and expanded modes. Columns are metric, subject, depth, then for each period `<period> value` and `<period> status`, then YTD. Overridden cells get an `overridden` note column.
- **Tests:** focus return and Esc; sticky header styles present; CSV matches the visible rows (expanded subjects only, filters applied); large table performance smoke (20 × 30 × 13 renders); axe.
