# Metric RCAs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clickable "Why?" on every cell that is not perfect: the gap explained by imported incidents (to the minute) and contributing records, a 280-character owned write-up with up to five https links, an RCAs view that lists what is still needed, and RCAs carried into published reports and the PPTX/PDF downloads.

**Architecture:** Six tasks with single-owner files, in four waves. Wave 1: T1, the pure Go pieces (incident records in the records engine; the `rca` package with the gap arithmetic, expectation and staleness). Wave 2: T2, storage, HTTP, the whole OpenAPI surface (draft endpoints stubbed), `Cell.rca` on views, MCP and SAM exposure, and the demo seed. Wave 3 (parallel): T3 SAM drafts and report snapshots (Go), T4 the web card, hooks and editor. Wave 4 (parallel): T5 the Why? affordances on tiles, the board, grids and the full-screen dialog; T6 the RCAs view, the Report page and the downloads.

**Tech Stack:** Go API (oapi-codegen, kin-openapi, the records expression engine), `make gen`; React 19, TypeScript, Tailwind 4, Radix (Popover, Dialog, Tooltip), lucide-react, pptxgenjs and the existing PDF writer, Vitest + Testing Library + vitest-axe.

**Spec:** `docs/superpowers/specs/2026-11-20-metric-rca-design.md` (extends the records ingestion, dashboard and polish specs). Mockups (local, not committed): `.superpowers/sdd/2026-11-20-metric-rca/mockups/`.

## Global Constraints

- **Precondition:** the 2026-11-17 UX polish round is committed: `git status --short -- web/src/features/scorecard web/src/ui` is empty (it touches `ReportPage.tsx`, `report/ReportStatusList.tsx`, `ItemDrillIn.tsx`, `ItemMonths.tsx`, `FocusDialog.tsx`, `RangeStrip.tsx`, `useDialogShortcuts.ts`, `StatusBoard.tsx`, `OverviewPage.tsx` and `logic/*`). T1–T3 may start before; T4–T6 may not.
- No new dependencies (web or Go). No horizontal scroll at 320–1920px (`document.documentElement.scrollWidth === clientWidth`); the Why card and the full-screen dialog body may scroll vertically; nothing else nests a scroll area.
- Type scale 11/16, 12/16, 14/20, 16/24, 20/28, 28/36 only; text `ink/70` or stronger; targets ≥ 24px (icon buttons 32px); status never by color alone; the tenant's scale labels (`Red`), never rank labels.
- Copy exactly as in the spec (§10.10 and inline). Plain text everywhere: no `dangerouslySetInnerHTML`, no Markdown rendering of notes, titles or imported fields. Every external link `target="_blank" rel="noopener noreferrer"`, https only.
- Never change a value from incidents; never hide the unexplained remainder; parts always sum to the rounded headline (largest remainder, spec §5.7).
- Public repo: no company or product names in code, tests, docs, fixtures or commit messages. Sample exports use `tracker.example`, `oncall.example`, `status.example`, `docs.example`.
- **One checkout, parallel tasks** (as the 2026-11-17 plan): each task edits only the files its **Files** list owns, imports earlier tasks' code without editing it, runs its own servers on its own ports and stops only what it started (never `pkill`):

  | Task | API | Web |
  |---|---|---|
  | T2 | 8112 | 5212 |
  | T3 | 8113 | 5213 |
  | T4 | 8114 | 5214 |
  | T5 | 8115 | 5215 |
  | T6 | 8116 | 5216 |

  ```bash
  (cd api && go run ./cmd/devserver -addr 127.0.0.1:$API -allowed-origin http://localhost:$WEB -seed demo -auth dev -dev-secret opsvision-local-dev-secret-not-for-production)
  (cd web && VITE_API_URL=http://127.0.0.1:$API VITE_AUTH_MODE=dev npx vite --port $WEB --strictPort)
  ```
- **Gate** (every task, in a temporary export of `HEAD` with only the task's files copied in, exactly as the 2026-11-17 plan's step 4): `go test ./...` with the package and test count named when the task touches `api/`; `make gen-check` when it touches `openapi/openapi.yaml`; the full web suite with file and test counts (record the baseline at the plan's start commit), `npx tsc -b --noEmit`, `npx eslint .` with 0 errors; screenshots at 1440 and 390 of what it touched against its own servers, saved to `.superpowers/sdd/2026-11-20-metric-rca/task-<id>/`, with `scrollWidth === clientWidth` noted.
- Commit only the task's files: `git add -- $FILES && git commit --only -m "<message>" -- $FILES`. Never `git add -A`. If `.git/index.lock` exists, wait and retry; never delete it.

## Review Focus

1. **Overlapping incidents with unequal impact, one spanning the month boundary, one ongoing at the cutoff.** The union is counted once, the overlap is split by impact, each month counts only its clipped minutes, and the rounded parts (incidents + remainder) equal the rounded headline. Tested in T1 (`TestCountDowntimeMixed`).
2. **Writes outside the writer's reach:** a contributor scoped to Payments writing a Platform item, the company roll-up, or an unattached item; a viewer writing anything; a stale `expectedRevision`. 403 with the spec's copy, or 409 with the current note; nothing stored, no audit entry. Tested in T2.
3. **Hostile link and text input:** a `javascript:` URL, an `http://` URL, an https URL carrying a user name and password before the host, a URL with a space, a 2049-byte URL, a title that is an HTML `img` tag with an `onerror` handler, 281 runes, a note of only newlines. Rejected with the spec's messages by the API; when such strings reach the web from an import (titles, record URLs), they render as text and never as a link. Tested in T2 (API) and T4 (render).
4. **A tenant that never imported incidents** (no `incident` type, no `explains`): views gain `Cell.rca` only for cells with a gap, the card explains uptime from the value (`(from the value)`), and the downtime arithmetic is not attempted. Tested in T2.
5. **Edits racing and abandoned:** two people save the same note (the second gets the 409 flow and keeps their text), closing the card with unsaved text asks before discarding, and SAM's draft is never saved without Save (`putCellRca` is not called on `Use this draft`). Tested in T4.

---

### Task T1: Incident records and the gap arithmetic (pure Go)

**Files:**
- Modify: `api/internal/domain/records.go`, `api/internal/domain/records_test.go` (`AttrDateTime`, `RecordFields.GroupKey`, `ExplainLink`, `RecordType.Explains` and its validation)
- Create: `api/internal/domain/rca.go`, `api/internal/domain/rca_test.go` (`CellRCA`, `RCALink`, `RCABasis`, `Validate`)
- Modify: `api/internal/records/template.go`, `template_test.go`, `normalize.go`, `normalize_test.go`, `guess.go`, `guess_test.go`
- Create: `api/internal/records/incident.go`, `incident_test.go`; `api/internal/records/testdata/incidents_tracker.csv`, `incidents_oncall.csv`, `incidents_status_page.csv` (verbatim from spec §7.2)
- Create: `api/internal/rca/downtime.go`, `downtime_test.go`, `round.go`, `round_test.go`, `expect.go`, `expect_test.go`, `rank.go`, `rank_test.go`, `basis.go`, `basis_test.go`, `text.go`, `text_test.go`

**Interfaces:**
- Consumes: `records.Contribution` (existing).
- Produces:
  - `domain.AttrDateTime AttrType = "datetime"`; `RecordFields.GroupKey string` (JSON `groupKey,omitempty`); `type ExplainLink struct { ScorecardID, MetricKey, Mode, DownMeasure, Where string }` (JSON camelCase; `Mode` is `downtime` or `list`); `RecordType.Explains []ExplainLink` (JSON `explains,omitempty`).
  - `domain.CellRCA`, `domain.RCALink`, `domain.RCABasis` exactly as spec §8.1; `func (r CellRCA) Validate() []ValidationError` and `func NormalizeRCAText(s string) string` (trim, collapse whitespace, NFC).
  - `records.Template.TimeZone string` (JSON `timeZone,omitempty`); `records.FieldMap.Unit string` (JSON `unit,omitempty`; `s`, `min`, `h`; number attributes only); `subjectKey.separator` fans a row out to `externalId = key + "@" + service` with `GroupKey = key`.
  - `records.IncidentPreset() domain.RecordType` (ID `incident`, priorities `SEV1…SEV4`, attributes `startedAt`/`endedAt` datetime, `minutesDown` number, `impactPct` number).
  - Package `rca`:
    ```go
    type Window struct{ Start, End time.Time }
    func MonthWindow(cal period.Calendar, p period.Period) Window // UTC calendar boundaries
    type Incident struct {
        Source, ExternalID, Key, Title, URL, Severity, SubjectID string
        State      domain.RecordState
        Start, End *time.Time
        Minutes    *float64 // minutesDown
        Impact     float64  // 0 < x ≤ 1; 0 means 1
        CreatedAt  domain.Date
    }
    type Counted struct {
        Incident                                                  Incident
        Minutes, TotalMinutes                                     float64            // counted in the window; whole duration
        Overlaps                                                  map[string]float64 // other Key → raw minutes
        StartedBefore, EndedAfter, Ongoing, DurationOnly, Unknown bool
    }
    type Downtime struct {
        PeriodMinutes, ReportedMinutes, Explained, Unexplained, Excess float64
        Agree bool
        Items []Counted // by Minutes desc, then Start, then Key
    }
    func CountDowntime(w Window, periodMinutes, reportedMinutes float64, cutoff time.Time, incs []Incident) Downtime
    func RoundParts(parts []float64, total float64, decimals int) []float64
    func Duration(minutes float64) string
    type Expectation string // Needed, Available, None
    type ExpectInput struct { HasValue, NA, YTD, NotRated, AtReportingLevel bool; Status, BestStatus string; Value float64; Ideal *float64; Higher bool }
    func Expect(in ExpectInput) Expectation
    func Ideal(m domain.Metric) (float64, bool) // spec §4.2
    type Gap struct { Kind string; Ideal, Points *float64; Headline, Detail string }
    type GapInput struct { Metric domain.Metric; Cell CellFacts; StatusLabel func(string) string; Threshold string; Downtime *Downtime; Records *RecordSummary; PeriodLabel string }
    func GapOf(in GapInput) Gap
    type Ranked struct { C records.Contribution; Impact float64; ImpactDisplay, Note string }
    func RankRatio(denominator float64, misses []records.Contribution) []Ranked
    func RankAmounts(per float64, cs []records.Contribution) []Ranked        // sums and ages
    func RankChange(cur, prior []records.Contribution, per float64) []Ranked // change rules
    func RankOverPlan(cs []records.Contribution) []Ranked
    func StaleReasons(stored, current domain.RCABasis, statusLabel func(string) string) []string
    ```
    `CellFacts` is a small struct (`Display, Status string; Value *float64; Components map[string]float64; Change *float64`) and `RecordSummary` (`Noun string; Misses, Denominator int`) so `rca` does not import `httpapi`.

- [ ] **Step 1: Write the failing tests**

`downtime_test.go` (all times UTC):
```go
sep := rca.Window{Start: t("2026-09-01T00:00"), End: t("2026-10-01T00:00")} // 43,200 min
d := rca.CountDowntime(sep, 43200, 216, t("2026-10-15T00:00"), []rca.Incident{
    inc("INC-1187", "2026-09-09T13:12", "2026-09-09T15:42", 1),
    inc("INC-1203", "2026-09-30T23:05", "2026-10-01T00:50", 1),
})
// TestWorkedExample: Items[0] INC-1187 Minutes 150; Items[1] INC-1203 Minutes 55, TotalMinutes 105, EndedAfter true;
// Explained 205, Unexplained 11, Excess 0, Agree false.
```
- `TestOverlapCountedOnce`: Oct window, reported 420, INC-2041 14:05–18:15 Oct 3; INC-2047 09:40–11:45 and INC-2049 11:20–11:50 Oct 17 → Minutes 250, 112.5, 17.5; `Overlaps["INC-2049"] == 25` on INC-2047; Explained 380; Unexplained 40.
- `TestOverlapSplitByImpact`: A 10:00–11:00 impact 1, B 10:30–11:30 impact 0.5 → segment 10:30–11:00 counts 30 (max weight), A gets 20, B gets 10; B's 11:00–11:30 counts 15; Explained 65.
- `TestCountDowntimeMixed` (Review Focus 1): the two above plus an ongoing incident from Oct 31 22:00 with cutoff Nov 14 → in Oct it counts 120 (to the window end) with `Ongoing`; in a Nov window with cutoff Nov 14 00:00 it counts to the cutoff; `RoundParts` of every item's points plus the remainder equals `round(gap, 2)` for both months.
- `TestDurationOnlyAndUnknown`: `Minutes` 45, no times, `CreatedAt` Oct 9 → counted 45 in Oct, `DurationOnly`; no times and no minutes → listed with 0 and `Unknown`; state `done` with a start, no end and no minutes → counted to the end of its `completedAt` day (spec §5.3).
- `TestAgreementTolerance`: reported 600, explained 595 → `Agree`; 590 → Unexplained 10; reported 75, explained 90 → Excess 15.
- `TestCancelledAndOutside`: a `cancelled` incident and one entirely in September never count in October.

`round_test.go`: `RoundParts([]float64{0.34722, 0.12731, 0.02546}, 0.5, 2)` → `[0.35, 0.13, 0.02]`; `RoundParts([]float64{0.56, 0.252, 0.0392, 0.0896}, 0.9409, 2)` → `[0.56, 0.25, 0.04, 0.09]`; for 1,000 random part sets the rounded parts sum to `round(total, d)` exactly (compare as integers of `10^d`).

`text_test.go`: `Duration(45) == "45m"`, `Duration(216) == "3h 36m"`, `Duration(420) == "7h 00m"`, `Duration(1565) == "1d 2h 05m"`.

`expect_test.go`: one table case per row of spec §4.1 and §4.2 — Red product of `epics_on_time` (reports at product) → `Needed`; Red segment of it → `Available`; Green item at 99.97% with ideal 100 → `Available`; Green at 100.00% → `None`; n/a, not rated, YTD, no value → `None`; Yellow company cell of `postmortems_on_time` (reports at company) → `Needed`; `Ideal` is 100 for `percent2` higher-better and `money_plan`, absent for `number0` lower-better, `days0` and change rules.

`expect_test.go` (`GapOf`): uptime Webhooks → Headline `0.94 pts short of 100% · 7h 00m down`, Detail `Red · Green at 99.90% or better`; no downtime measure → `… · 3h 36m down (from the value)`; epics 8 / 11 → `27 pts short of 100% · 3 of 11 epics missed` and Detail ending `· each miss costs 9.1 pts`; support backlog 588 with Green ≤ 450 → `138 above the Green line (450 or less)`; spend 104% → `4% over plan · $46k over`; change −26% → `26% worse than Sep · Green needs any improvement`; Green 99.97% → `0.03 pts short of 100% · no RCA needed`.

`rank_test.go`: `RankRatio(11, …)` gives each miss `9.1 pts`, ordered P1 before P2, then more days late first; slip note `Slipped Oct 15 → Nov 12`, open miss `Missed Oct 28 · still open`. `RankChange` tags a record absent from `prior` as `New` and ranks by the increase.

`basis_test.go`: display `99.12%`→`99.06%` gives `The value changed from 99.12% to 99.06%.`; status Y→R `The status changed from Yellow to Red.`; evidence gains `incident-tracker:INC-2049` → `1 new incident since it was written: INC-2049.`; loses one → `INC-2033 no longer counts.`; reported 400→420 → `The reported downtime changed from 6h 40m to 7h 00m.`; equal bases → no reasons.

`rca_test.go` (domain): Review Focus 3's inputs each produce the spec §8.2 message (`Use a link that starts with https://` for the `javascript:`, `http:`, user-info and whitespace URLs; `Write up to 280 characters` at 281 runes; `Write what caused the gap` for whitespace-only text; `Up to 5 links`; `This link is already listed`); a title of HTML is accepted as text (it is never rendered as HTML); `NormalizeRCAText("a\n\n  b")` is `"a b"`.

`incident_test.go`: applying each sample CSV with its template yields the spec's records: the tracker file's INC-2049 fans out to `INC-2049@Webhooks` and `INC-2049@Search` with `GroupKey` `INC-2049`; `startedAt` `2026-10-17T11:20:00Z`; `impactPct` 100; INC-2058 is `cancelled`; the on-call file's `2026-10-08T21:14:00-04:00` is stored `2026-10-09T01:14:00Z` and `88533` is `open` with no `endedAt`; the status page file's `partial_outage` gives `impactPct` 50 and `;` fans out; uploading each file twice gives `unchanged` for every row. Row errors: end before start `Ended before it started`; impact 0 or 120 `Impact must be more than 0 and at most 100`.

`template_test.go` / `records_test.go`: `timeZone` must be an IANA name; `unit` only on number attributes and one of `s`, `min`, `h`; `explains` with mode `downtime` on a type without `startedAt`/`endedAt` datetimes or `minutesDown` is an error; a mode other than `downtime`/`list` is an error. `guess_test.go`: headers `Incident start`, `started_at`, `Started at` guess `startedAt`; `resolved_on`, `Incident end`, `Resolved at` guess `endedAt` when the type is `incident`.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/rca/... ./internal/records/... ./internal/domain/...` → FAIL (undefined: `rca.CountDowntime`, `domain.AttrDateTime`, …).

- [ ] **Step 3: Implement.** The sweep in `CountDowntime` follows spec §5.2 exactly (segment down = `len × max(w)`, shares `× wᵢ / Σw`). `datetime` values parse with the field's `dateFormats` in the template's `timeZone` (RFC 3339 inputs keep their offsets) and are stored as RFC 3339 UTC strings in `Attributes`; rule conditions compare them as instants.

- [ ] **Step 4: Verify** the same command passes, then the gate (no screenshots; no web change).

- [ ] **Step 5: Commit** — `feat(api): incident records and the gap arithmetic for RCAs`.

---

### Task T2: RCA storage, API, view state, MCP and the demo

**Files:**
- Modify: `api/internal/store/store.go` (`RCAStore` in `Store`), `store/memstore/memstore.go`; Create: `store/memstore/rcas.go`, `store/dynamostore/rcas.go`; Modify: `store/dynamostore/keys.go`, `store/storetest/suite.go`
- Create: `api/internal/httpapi/rca.go`, `rca_test.go`, `rca_explain.go`, `rca_list.go`, `rca_list_test.go`, `rca_draft_stub.go`
- Modify: `api/internal/httpapi/view.go`, `view_test.go` (`Cell.rca`), `records.go` (record type `explains` and `datetime` on the wire), `mcp.go` (exclusions), `server.go` (wiring)
- Modify: `api/internal/assistant/tools.go`, `tools_test.go` (`/scorecards/{sc}/rca/draft` excluded)
- Modify: `openapi/openapi.yaml`; regenerate `api/internal/httpapi/gen.go` and `web/src/api/schema.d.ts` (`make gen`)
- Modify: `api/internal/demo/seed.go`, `seed_test.go`; Create: `api/internal/demo/testdata/acme_incidents_oct.csv`
- Modify: `api/internal/recordimport/story.go`, `story_test.go` (incident story lines, spec §7.3)

**Interfaces:**
- Consumes: T1's `rca` package, `domain.CellRCA`, `records.IncidentPreset`.
- Produces:
  - ```go
    type RCAStore interface {
        GetRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) (domain.CellRCA, error)
        PutRCA(ctx context.Context, tenantID string, r domain.CellRCA, expectedRevision int) (domain.CellRCA, error) // 0 creates; mismatch ErrConflict
        DeleteRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period, expectedRevision int) error
        ListRCAs(ctx context.Context, tenantID, scorecardID string, p period.Period) ([]domain.CellRCA, error) // by metric, then subject
    }
    ```
  - Operations and schemas of spec §9.1–§9.2 (`getCellRca`, `putCellRca`, `deleteCellRca`, `listCellRcas`, `draftCellRca`, `getCellRcaDraft`; `CellRca`, `CellRcaList`, `CellRcaSummary`, `CellRcaState`, `RcaNote`, `RcaGap`, `RcaIncident`, `RcaRemainder`, `RcaRecord`, `RcaChild`, `RcaLink`, `PutCellRcaRequest`, `CellRcaDraft` with `warnings`; `Cell.rca`; `RecordType.explains`; `AttributeDef.type` `datetime`; `getReportDocument` query `rcas` with `x-mcp-hidden: true` and `ReportDocument.rcas?: RcaSnapshot[]`). The draft handlers return 503 `assistant_unavailable` until T3.
  - `func (s *Server) explainCell(ctx context.Context, p auth.Principal, sc, metric, subject string, per period.Period) (CellRca, error)` — the one path the card, the list, SAM drafts (T3) and snapshots (T3) use.
  - Demo: the `incident` type with `explains` for `uptime` and `deployment_uptime` (spec §14), the incident snapshot, and three notes (Webhooks Oct 2026 by `dev|admin`; Search Oct 2026 with basis display `99.90%`; the Payments product cell of `epics_on_time` that is not at its best in 2026-M10, by `dev|contributor`). Exported `demo.RCAExamples` names those three cells for tests.

- [ ] **Step 1: Write the failing tests**

`storetest/suite.go` (`RCAs`): create at revision 0 → revision 1; put with 1 → 2; put with 1 again → `ErrConflict`; delete with a stale revision → `ErrConflict`; `ListRCAs` returns one period only, sorted; another tenant sees nothing. Runs for memstore and dynamostore (memdynamo).

`rca_test.go`:
- `TestGetCellRcaWebhooks`: `GET /v1/scorecards/service-fulfillment/rca?metric=uptime&subject=webhooks&period=2026-M10` → `expectation: needed`, `gap.headline: "0.94 pts short of 100% · 7h 00m down"`, incidents `INC-2041` `0.56 pts`, `INC-2047` `0.25 pts` (note `Overlaps INC-2049 for 25m`), `INC-2049` `0.04 pts`, `unexplained.display: "0.09 pts · 40m of the 7h 00m reported"`, a note by Avery Admin, `stale: false`, `canEdit: true` for the admin.
- `TestGetCellRcaExcess`: Analytics Ingest → `excess.minutes == 15`, `unexplained == null`, no note.
- `TestGetCellRcaStale`: Search → `stale: true`, `staleReasons` contains `The value changed from 99.90% to 99.87%.` and `1 new incident since it was written: INC-2049.`; INC-2055 (maintenance) is absent.
- `TestGetCellRcaRecords`: the epics cell in `demo.RCAExamples` → `gap.kind: ratio`, `recordsSummary` matching `^\d+ of \d+ epics missed$`, each record's `impactDisplay` equal to `100/denominator` to one decimal.
- `TestGetCellRcaRollUp`: the company cell of `epics_on_time` → `expectation: available`, at most 3 `children` ordered by missed count, `childrenTotal` ≥ 3.
- `TestPutCellRcaPermissions` (Review Focus 2): the Payments contributor can put on a Payments product and on `checkout-api`; gets 403 `You can write RCAs only for your own units.` on `webhooks`, on the company cell and on an unattached item; the viewer gets 403 everywhere; a stale `expectedRevision` gets 409 whose body holds the current note; none of the rejected writes adds an audit entry.
- `TestPutCellRcaValidation` (Review Focus 3): each hostile input from T1's test returns 400 with the same message at the field path (`links[0].url`, `text`).
- `TestPutCellRcaAudit`: create, update, confirm (same text and links) and delete write audit entries `create`, `update`, `confirm`, `delete` with `targetType: rca` and `targetId: uptime|webhooks|2026-M10`; a put through `/v1/mcp` stores `channel: mcp`.
- `TestNoIncidentType` (Review Focus 4): a tenant fixture without incident types — the uptime card's headline ends `(from the value)`, `incidents` is empty, and `GET …/view` adds `rca` only to cells with a gap.

`rca_list_test.go`: `GET …/rcas?period=2026-M10` (admin) → `counts.needed` equal to the number of `needed` items, every item `state: needed`, sorted by status rank then gap; `state=all` includes `available` rows last and the Search row as `stale`; `mine=true` as the Payments contributor returns only Payments rows; a viewer scoped to Mobile sees only Mobile rows.

`view_test.go`: the Overview request for 2026-M10 has `rca.state: written` with an `excerpt` of at most 64 characters on Webhooks' Oct cell, `rca.state: needed` on Analytics Ingest's, no `rca` on a Green 100.00% cell or on any YTD cell, and `neededBelow ≥ 1` on the company row of `uptime`.

MCP and SAM (`server_test.go` in `mcp`, `tools_test.go`): the catalog has `get_cell_rca`, `list_cell_rcas`, `put_cell_rca`, `delete_cell_rca` and not `draft_cell_rca` or `get_cell_rca_draft`; `get_report_document` has no `rcas` argument; SAM's tool set has `get_cell_rca` and `list_cell_rcas` and no write or draft tool; a SAM-size (64 KB) cut of the demo Overview view still contains `rows`.

`story_test.go`: previewing the tracker sample against the demo gives a line `Oct · Webhooks · 3 incidents explain 6h 20m of 7h 00m reported`; re-previewing after apply gives `nothingChanged`.

`seed_test.go`: the incident type, 1 snapshot, the three notes; Webhooks Oct downtime reported 420 minutes (unchanged); `demo.RCAExamples[2]`'s cell status is not the best.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/store/... ./internal/httpapi/... ./internal/mcp/... ./internal/assistant/... ./internal/demo/...`.

- [ ] **Step 3: Implement.** OpenAPI first, `make gen`, then the store, `explainCell` (one `engine.Compute` for the cell's period and subject; incidents of every record type whose `explains` names the metric; contributions via the existing `records.Derive` path used by `ListRecordContributions`), handlers, the view annotation (notes by `ListRCAs` for each month in the view; incidents loaded once per request; expectation and basis per cell with a gap), MCP exclusions, then the demo.

- [ ] **Step 4: Verify**, then the gate with `make gen-check`. Screenshots: none required (no UI); save `curl` outputs of the four demo cells to `task-T2/` instead.

- [ ] **Step 5: Commit** — `feat(api): RCA notes, explanations and the RCAs list`.

---

### Task T3: SAM drafts and RCAs in published reports

**Files:**
- Create: `api/internal/assistant/rca_draft.go`, `rca_draft_test.go`
- Modify: `api/internal/assistant/runner.go` (dispatch by draft kind), `prompt.go` (the RCA tool sentence, spec §9.4), `api/internal/domain/assistant.go` (`AssistantDraft.Kind`, `MetricKey`, `SubjectID`)
- Create: `api/internal/help/topics/rca.md`; Modify: `api/internal/help/help_test.go`
- Delete: `api/internal/httpapi/rca_draft_stub.go`; Create: `api/internal/httpapi/rca_draft.go`, `rca_draft_test.go`
- Modify: `api/internal/report/snapshot.go`, `snapshot_test.go` (`SchemaVersion` 3, `RcaSnapshot`), `api/internal/httpapi/reports.go`, `reports_test.go`
- Modify: `api/internal/store/memstore/drafts.go`, `store/dynamostore/drafts.go` (store the new draft fields)

**Interfaces:**
- Consumes: T2's `explainCell`, `RCAStore`, the stubbed operations' generated types.
- Produces: `assistant.RCADraftPromptVersion = "sam-rca-v1"`; `assistant.RCADraftData(c RCADraftCell) string`; `assistant.DraftKeyWarnings(draft string, keys []string) []string`; `report.RcaSnapshot` (spec §10.8); `GET …/reports/{period}?rcas=true` returns `rcas` for v3 revisions.

- [ ] **Step 1: Write the failing tests**

`rca_draft_test.go` (assistant, fake provider):
- The system prompt contains each rule line of spec §9.3 verbatim and `(Prompt sam-rca-v1.)`; the user message for Webhooks lists `INC-2041`, `INC-2047`, `INC-2049`, `0.09 pts not explained` and no other key.
- A 400-rune model answer is cut at the last sentence end within 280; one with no sentence end within 280 is 279 runes plus `…`.
- `DraftKeyWarnings("… INC-9999 and INC-2041 …", []string{"INC-2041"})` → `["INC-9999"]`.
- A contributor drafting outside their scope fails with `Only people who can write this RCA can draft it.`; a contributor in scope succeeds.

`rca_draft_test.go` (httpapi): `POST /rca/draft` → 202 pending; polling returns `text` and `warnings`; the note is unchanged afterwards (`GET /rca` revision equal); 409 while one is pending for the same cell; 404 for another user's draft.

`reports_test.go`: publish 2026-M10 → the stored object has `schemaVersion: 3` and `rcas` including Webhooks with `text`, `headline` and 3 `evidence` keys, sorted worst first, at most 300; `GET` without `rcas` has no `rcas` key; with `?rcas=true` it does, filtered for the Payments contributor to Payments cells; editing the Webhooks note after publishing leaves the snapshot's text unchanged; a v2 object reads with `?rcas=true` and has no `rcas`.

`help_test.go`: `help.Search("why rca incident")` returns topic `rca` first.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/assistant/... ./internal/httpapi/... ./internal/report/... ./internal/help/...`.

- [ ] **Step 3: Implement** per spec §9.3, §9.4 and §10.8. The draft reads the cell through `explainCell` as the user, so scope filtering is inherited.

- [ ] **Step 4: Verify**, then the gate (`make gen-check` must still pass: T3 does not edit the OpenAPI).

- [ ] **Step 5: Commit** — `feat(api): SAM drafts for RCAs and RCAs in published reports`.

---

### Task T4: The Why card, its editor and the hooks (web)

**Files:**
- Create: `web/src/features/rca/WhyButton.tsx`, `WhyButton.test.tsx`, `WhyCard.tsx`, `WhyCard.test.tsx`, `WhyCardContent.tsx`, `GapBar.tsx`, `EvidenceList.tsx`, `RcaEditForm.tsx`, `RcaEditForm.test.tsx`, `SamSuggestion.tsx`, `WhyCardProvider.tsx`, `rcaText.ts`, `rcaText.test.ts`
- Modify: `web/src/api/queries.ts`, `web/src/api/queries.test.tsx`
- Create: `web/src/test/rcaFixtures.ts`; Modify: `web/src/test/server.ts` (MSW handlers for the six operations)

**Interfaces:**
- Consumes: T2's generated `components['schemas']['CellRca' | 'CellRcaState' | 'CellRcaList' | 'CellRcaDraft' | 'PutCellRcaRequest']`.
- Produces:
  - Hooks in `queries.ts`: `useCellRca(sc: string, cell: RcaCellRef | null)`, `usePutCellRca(sc: string)`, `useDeleteCellRca(sc: string)`, `useCellRcas(sc: string, q: { period: string; scope?: string; state?: RcaListState; mine?: boolean })`, `useCellRcaDraft(sc: string)` (starts and polls like the summary draft hook). `type RcaCellRef = { metric: string; subject: string; period: string }`. Saving invalidates the cell, the list and the views of that period.
  - `WhyButton({ state, subjectName, display, periodLabel, nameSubject, onOpen, compact })` — the four states and the roll-up tag of spec §10.1, accessible names exactly as specified.
  - `WhyCardProvider` + `useWhyCard(): { open(ref: RcaCellRef, anchor: HTMLElement, opts?: { title?: string }): void }` — one card at a time, popover ≥ 640px, sheet below; focus to the heading; Esc and Close return focus to `anchor`.
  - `rcaText.ts`: `whyName(...)`, `rcaExcerpt(text: string, max = 60): string`, `hostOf(url: string): string`, `safeHref(url: string): string | null` (https only, else null).

- [ ] **Step 1: Write the failing tests**

`WhyButton.test.tsx`: names `Why is Webhooks 99.06% in Oct 2026? RCA needed`; written shows `Why:` and the excerpt and has the name `Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin`; stale shows the `Review` tag; a roll-up with `neededBelow: 2, staleBelow: 1` shows `2 needed · 1 to review`; height class `min-h-6`; axe clean.
`WhyCard.test.tsx` (fixtures from `rcaFixtures.ts` mirroring the demo):
- uptime: headline, bar with a hidden sentence `7h 00m down: INC-2041 4h 10m, INC-2047 1h 53m, INC-2049 17m, 40m not explained` (minutes rounded by largest remainder so they sum to 7h 00m), rows in order with points, the overlap note, the remainder row; every key link has `target="_blank"` and `rel="noopener noreferrer"` and the name `INC-2041 (opens in a new tab)`.
- Review Focus 3 (render): an incident whose url is a `javascript:` URL renders its key as text with no `a`; a title that is an HTML `img` tag is text content and no `img` element exists.
- excess callout text; stale banner with reasons and `Still accurate` calling `putCellRca` with the same text, links and the shown revision; empty state for an editor (`Add RCA`, `Draft with SAM`) and for a viewer (`Billing hasn't written one yet.`); roll-up rows open the child's card and `‹ Acme Demo` returns; loading has `aria-busy` and `Loading why`; error shows `Try again`.
- Focus: opening focuses the heading; Escape closes and focuses the trigger; under a mocked 390px width the card renders as a `dialog` sheet.
`RcaEditForm.test.tsx`:
- counter `121 / 280`; at 292 runes `12 over` and Save disabled; https validation message under the field with `aria-invalid`; `Add link` hidden at 5.
- Review Focus 5: Save with a stale revision shows `Someone else changed this RCA while you were editing.` and `Show theirs`, and keeps the user's text in a `Your text` block; closing with unsaved text asks `Discard your changes?`; `Use this draft` replaces the text, shows `Undo`, and `putCellRca` has not been called; a draft with `warnings: ['INC-9999']` shows `SAM mentioned INC-9999, which is not linked to this cell. Check it before using this draft.`; delete asks the two-button confirm.
`rcaText.test.ts`: `safeHref('http://x')` is null; `safeHref('https://docs.example/a')` is the URL; `hostOf` gives `docs.example`; `rcaExcerpt` of 70 characters ends with `…` at 61 characters.
`queries.test.tsx`: `usePutCellRca` invalidates `['rca', sc, ref]`, `['rcas', sc, period]` and the view queries for the period.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- rca queries`.

- [ ] **Step 3: Implement** per spec §10.2–§10.4 and §10.9–§10.11 (Radix `Popover` with focus trapped; Radix `Dialog` for the sheet; `dir="auto"` on note text).

- [ ] **Step 4: Verify**, then the gate. Screenshots: none here (the card has no surface until T5 and T6); the final pass captures it against the mockups.

- [ ] **Step 5: Commit** — `feat(web): the Why card, RCA editor and SAM suggestion`.

---

### Task T5: Why? on tiles, the board, item grids and the full-screen dialog

**Files:**
- Modify: `web/src/features/scorecard/TileFrame.tsx`, `TileFrame.test.tsx`, `MetricTile.tsx`, `ItemSummaryTile.tsx`, `ItemSummaryTile.test.tsx`, `AttentionCard.tsx`, `AttentionCard.test.tsx`
- Modify: `web/src/features/scorecard/StatusBoard.tsx`, `StatusBoard.test.tsx`, `logic/statusBoard.ts`, `logic/statusBoard.test.ts` (Current as a gridcell; `rca` on `BoardCell`)
- Modify: `web/src/features/scorecard/ItemGrid.tsx`, `ItemGrid.test.tsx`, `ItemDrillIn.tsx`, `FocusDialog.tsx`, `FocusDialog.test.tsx`, `useDialogShortcuts.ts`, `useDialogShortcuts.test.tsx`
- Modify: `web/src/features/scorecard/ItemMonths.tsx`, `ItemMonths.test.tsx` (the drill-in's Monthly values disclosure from the polish round; it gains a Why column and is rendered in every full-screen body)
- Modify: `web/src/ui/status/StatusCell.tsx`, `StatusCellTip.tsx`, `useGridNavigation.ts`, `useGridNavigation.test.tsx`
- Modify: `web/src/features/scorecard/OverviewPage.tsx` (mount `WhyCardProvider` only)

**Interfaces:**
- Consumes: T4's `WhyButton`, `useWhyCard`, `useCellRcas`; `Cell.rca` from the view.
- Produces: `TileFrameProps.why?: ReactNode`; `StatusCell` prop `rca?: CellRcaState` (the written mark and the name suffix); `StatusCellTipProps.rca?: CellRcaState`; `useGridNavigation` option `onWhy?: (rowId: string, col: number, el: HTMLElement) => void` bound to `W`; `ItemMonthsProps.onWhy?: (period: string, el: HTMLElement) => void` (the Why column is present only when it is passed).

- [ ] **Step 1: Write the failing tests**

- `TileFrame.test.tsx`: with `why`, the line renders between the value row and the chart; without it, the DOM is unchanged (snapshot of the existing structure).
- `OverviewPage.test.tsx` fixtures through `TileFrame`: a Green 100.00% tile has no `Why` button; the epics tile at Checkout scope has `Why? RCA needed`.
- `ItemSummaryTile.test.tsx`: the Webhooks row's name ends `; RCA written`; the footer shows `2 RCAs needed ›` linking to `rcas?period=2026-M10&rca=needed&metric=uptime` when two shown items need one; none when zero.
- `AttentionCard.test.tsx`: the RCA line sits above the stretched link (`relative z-10`) and clicking it opens the card, not the metric.
- `StatusBoard.test.tsx`: ArrowRight from the last month reaches the Current cell; Enter there opens the Why card for the row's scope cell (`useWhyCard().open` called with `{ metric: 'uptime', subject: 'acme', period: '2026-M10' }`); `W` on the Mar cell opens that month's card; Enter on a month cell still calls `onOpen`; `W` is ignored with Ctrl, in inputs and when shortcuts are off; a cell with `rca.state: 'written'` has the mark and the name suffix `; RCA written`; the tip shows `RCA: …`.
- `ItemGrid.test.tsx`: the Value cell is a gridcell reached by ArrowRight from the selected month, named `Webhooks, Oct 2026: 99.06%, Red. RCA written. Press Enter for why.`; Enter opens the card; the hint row ends `· W why`.
- `FocusDialog.test.tsx`: the value row has the WhyButton for the selected period; `Monthly values` exists for a ratio metric and its rows have a `Why` cell for months with a gap; Escape with the card open closes only the card.
- `ItemMonths.test.tsx`: with `onWhy`, the Why column shows `Why?`, `RCA` or `Review` per `Cell.rca` and nothing for months without a gap; without it the table is unchanged.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- TileFrame ItemSummaryTile AttentionCard StatusBoard statusBoard ItemGrid FocusDialog ItemMonths useGridNavigation useDialogShortcuts`.

- [ ] **Step 3: Implement** per spec §10.1 and §10.6; the mark is a CSS pseudo-element on `StatusCell` (no extra DOM in the grid's arrow order).

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390: the Overview (epics tile at `?scope=checkout`, the uptime tile, the board with the Current cell focused), `?focus=uptime` (grid with the Value cell focused), `?focus=uptime&item=webhooks` with the card open, `?focus=epics_on_time&scope=checkout` with the card open.

- [ ] **Step 5: Commit** — `feat(web): Why? on tiles, the status board, item grids and the full-screen dialog`.

---

### Task T6: The RCAs view, the Report page and the downloads

**Files:**
- Create: `web/src/features/rca/RcasPage.tsx`, `RcasPage.test.tsx`, `rcaReminder.ts`, `rcaReminder.test.ts`
- Modify: `web/src/App.tsx` (route `scorecards/:sc/rcas`), `web/src/features/scorecard/ControlBar.tsx`, `ControlBar.test.tsx` (fourth view and count pill)
- Modify: `web/src/features/scorecard/ReportPage.tsx`, `ReportPage.test.tsx`, `report/model.ts`, `report/model.test.ts`, `report/ReportStatusList.tsx`, `report/ReportStatusList.test.tsx`, `report/pptx.ts`, `report/pdf.ts`, `report/export.test.ts`, `web/src/test/reportFixtures.ts`
- Modify: `web/src/features/admin/RecordTypesPage.tsx`, `RecordTypesPage.test.tsx`, `adminModel.ts`, `adminModel.test.ts` (`Add incident type`, the Explains section, `Date and time` attributes; spec §7.1)

**Interfaces:**
- Consumes: T4's hooks and card; T3's `ReportDocument.rcas`; `Cell.rca`.
- Produces: `ReportMetric.why?: { headline: string; text?: string; author?: string; links: RcaLink[]; evidence: { key: string; url: string; pointsDisplay: string }[]; unexplained?: string; children: { name: string; display: string; status: string; excerpt?: string; written: boolean }[]; editedSincePublication: boolean }`; `ReportModel.rootCauses` and `ReportModel.rcasNeeded: number`; `reminderText(list: CellRcaList, url: string, periodLabel: string): string`.

- [ ] **Step 1: Write the failing tests**

- `RcasPage.test.tsx`: `?rca=needed` default; toggles are `aria-pressed` and update the URL; rows grouped by category with `th scope="rowgroup"`; `Add RCA` opens the card anchored to it, and after a save the row reads `Open`, focus stays on it and the live region says `RCA saved for Webhooks`; `Only ones I can write` is on by default for the contributor fixture; the filter narrows rows; the two empty states' copy; under 640px one `li` per cell; loading `?why=uptime:analytics-ingest` opens that row's card; axe clean.
- `rcaReminder.test.ts`: the exact text block of spec §10.5 for the fixture, ending with the view URL.
- `ControlBar.test.tsx`: `RCAs` tab with pill `7` and the name `RCAs, 7 needed` when the list counts 7 the user can write; no pill at 0.
- `model.test.ts`: a live model's Uptime metric gets `why.children` (Webhooks written, Analytics Ingest not), the postmortems metric its own `why.text`; a v3 published model reads `why` from `rcas` and sets `editedSincePublication` when the live revision is newer; a v2 published model shows the spec's `RCAs shown as they are now; …` line; `rcasNeeded` equals the list's needed count.
- `ReportPage.test.tsx`: the Why block's copy and linked keys; `No RCA yet` with `Add RCA` (live, editor) linking `rcas?…&why=uptime:analytics-ingest`; none on a published revision; the Notes section `Root causes`; the publish dialog line `7 RCAs are still needed for Oct 2026. Publishing does not wait for them.`
- `ReportStatusList.test.tsx`: the caption gains `Why: …` clamped to two lines.
- `RecordTypesPage.test.tsx`: `Add incident type` creates a type with priorities `SEV1…SEV4` and the four attributes, then is disabled; adding an Explains row `Uptime · Downtime · Category is not maintenance` saves `explains: [{ scorecardId, metricKey: 'uptime', mode: 'downtime', where: "category != 'maintenance'" }]` with the loaded revision; a 409 shows the existing conflict message; the attribute type picker offers `Date and time`.
- `export.test.ts`: the PPTX metric slide for Uptime has a `Why` text box whose runs include a hyperlink for `INC-2041`; an appendix slide `Root causes · Oct 2026` with 8 rows a slide; the PDF has the same text and a link annotation per key; no text run contains `<`.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- RcasPage rcaReminder ControlBar model ReportPage ReportStatusList export RecordTypesPage adminModel`.

- [ ] **Step 3: Implement** per spec §10.5, §10.7 and §10.8.

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390: `/scorecards/service-fulfillment/rcas?period=2026-M10` (needed, all), with a card open from `Add RCA`; the Report page for 2026-M10 live; the PPTX and PDF opened and captured (first metric slide and the appendix).

- [ ] **Step 5: Commit** — `feat(web): the RCAs view and RCAs in the report and downloads`.

---

## Final pass

After T5 and T6: a full-branch review against the spec, `make dev` screenshots of every mockup's surface at 1440 and 390 (compare with `.superpowers/sdd/2026-11-20-metric-rca/mockups/`), and `cd api && go test ./...` plus the full web suite on `HEAD`.
