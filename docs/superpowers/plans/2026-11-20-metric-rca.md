# Metric RCAs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clickable "Why?" on every cell that is not perfect: the gap explained by imported incidents (to the minute) and contributing records, a 280-character owned write-up with up to five https links, an RCAs view that lists what is still needed, and RCAs carried into published reports and the PPTX/PDF downloads — inside the platform's time and size limits.

**Architecture:** Eight tasks with single-owner files in six waves (the reviewer's split). Wave 1: T1, the pure Go pieces (incident records in the records engine; the `rca` package). Wave 2: T2a, the whole OpenAPI surface, the RCA store, note writes, permissions, audit and MCP/SAM exposure, with read and draft endpoints stubbed. Wave 3 (parallel): T2c the demo incidents and notes; T4 the web card, editor and hooks. Wave 4: T2b the shared per-request explainer, `getCellRca`, `listCellRcas` and `Cell.rca` on views, with time and size budgets. Wave 5 (parallel): T3 SAM drafts and report snapshots; T5 the Why? affordances. Wave 6: T6 the RCAs view, the Report page, the downloads and the Record types admin. T7 (follow-up, not scheduled) holds what the spec defers.

**Tech Stack:** Go API (oapi-codegen, kin-openapi, the records expression engine), `make gen`; React 19, TypeScript, Tailwind 4, Radix (Popover, Dialog, Tooltip), lucide-react, pptxgenjs and pdf-lib (already present), Vitest + Testing Library + vitest-axe.

**Spec:** `docs/superpowers/specs/2026-11-20-metric-rca-design.md` (revised after review; resolutions in its §17). Review: `.superpowers/sdd/2026-11-20-metric-rca/spec-review.md`. Mockups (local, not committed): `.superpowers/sdd/2026-11-20-metric-rca/mockups/`.

## Global Constraints

- **Precondition for T4–T6:** none of their files has uncommitted changes from another agent: `git status --short -- <the task's Files>` is empty before starting (the 2026-11-17 polish round has landed at `82666d5`; re-check, do not assume).
- No new dependencies (web or Go), and no indirect Go module made direct (so no `golang.org/x/text`; spec §8.2). No horizontal scroll at 320–1920px (`document.documentElement.scrollWidth === clientWidth`); the Why card and the full-screen dialog body may scroll vertically; nothing else nests a scroll area.
- Type scale 11/16, 12/16, 14/20, 16/24, 20/28, 28/36 only; text `ink/70` or stronger; targets ≥ 24px (icon buttons and trailing cells 32px); status never by color alone; the tenant's scale labels, never rank labels.
- Copy exactly as in the spec (§10.10 and inline). Plain text everywhere: no `dangerouslySetInnerHTML`, no Markdown rendering of notes, titles or imported fields. Every external link `target="_blank" rel="noopener noreferrer"`, through `safeHref` (https only), in the app and in the downloads.
- Never change a value from incidents; the remainder or excess is always shown when ≥ 0.5 min; parts always sum to the displayed gap (largest remainder with the spec's tie-break, §5.7); gaps come from the displayed value (§4.2).
- Never reveal what the reader cannot read: counts, children, incidents and stale reasons are computed over readable cells only.
- Public repo: no company or product names in code, tests, docs, fixtures or commit messages. Sample exports use `tracker.example`, `oncall.example`, `status.example`, `docs.example`.
- **Parallel execution rules** (as in the 2026-11-17 polish round; tasks in a wave run at the same time in this one checkout, no branches or worktrees):
  1. Each task edits only the files its **Files** list owns; it imports earlier tasks' code without editing it, except where a later task's list names the file (ownership passes in wave order).
  2. Each task runs its own servers on its own ports, and **stops only the processes it started — never `pkill`, `killall` or any broad kill**:

     | Task | API | Web |
     |---|---|---|
     | T2a | 8121 | 5221 |
     | T2b | 8123 | 5223 |
     | T2c | 8122 | 5222 |
     | T3 | 8125 | 5225 |
     | T4 | 8124 | 5224 |
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
  5. Commit only the task's own files: `git add -- $FILES && git commit --only -m "<message>" -- $FILES` (`--only` commits exactly those paths whatever else is staged). Never `git add -A` or `git add .`. **Never commit the untracked `import subprocess.py`** at the repository root (it is not part of the project). If `.git/index.lock` exists, wait and retry; never delete it.
- **Gate contents** (every task): `go test ./...` with the package and test counts named when the task touches `api/`; `make gen-check` when it touches the OpenAPI; the full web suite with file and test counts (record the baseline at `HEAD` before T1), `npx tsc -b --noEmit`, `npx eslint .` with 0 errors; screenshots at 1440 and 390 of what it touched against its own servers, saved to `.superpowers/sdd/2026-11-20-metric-rca/task-<id>/`, with `scrollWidth === clientWidth` noted.

## Review Focus

1. **Overlapping incidents with unequal impact, one across the month boundary, one ongoing at its source's cutoff, plus a tie in rounding and a within-tolerance remainder.** The union is counted once, the overlap split by impact, each month counts only its clipped minutes, equal remainders go in evidence order with the remainder last, a 5-minute remainder of 600 is still shown, and the rounded parts equal the displayed gap. Tested in T1.
2. **Writes and reads outside the caller's reach:** a Payments contributor writing a Platform item, the company roll-up, or an unattached item; a viewer writing anything; a stale `expectedRevision`; a scoped viewer reading a roll-up whose children, counts or stale reasons include unreadable cells. 403 / 409 with nothing stored and no audit entry; nothing unreadable named or counted. Tested in T2a (writes) and T2b (reads).
3. **Hostile link and text input:** a `javascript:` URL, an `http://` URL, an https URL carrying a user name and password before the host, a URL with a space, a 2049-byte URL, five links totalling over 4 KB, `HTTPS://` (accepted, lowercased), a title that is an HTML `img` tag with an `onerror` handler, 281 code points, a note of only newlines, and an imported incident title that tells SAM to print a link. Rejected or neutralized per spec §8.2 and §9.4; rendered as text in the app and downloads. Tested in T1, T2a, T3, T4 and T6.
4. **Load and size at the limits:** the demo Overview with RCA state, `listCellRcas` at 200 rows, publish with 300 RCAs, a maximum-size report document, and a tenant with no incident type at all. Within spec §9.5–§9.6's budgets; no `available` state in payloads; nothing in published views. Tested in T2b and T3.
5. **Edits racing and abandoned, and drafts of two kinds at once:** two people save the same note (the second gets the 409 flow and keeps their text); closing with unsaved text asks first; SAM's draft is never saved without Save; a pending RCA draft does not block or leak into the month's summary draft. Tested in T4 and T3.

---

### Task T1: Incident records and the gap arithmetic (pure Go) — Wave 1

**Files:**
- Modify: `api/internal/domain/records.go`, `records_test.go` (`AttrDateTime`, `RecordFields.GroupKey`, `ExplainLink`, `RecordType.Explains` and its validation)
- Create: `api/internal/domain/rca.go`, `rca_test.go` (`CellRCA`, `RCALink`, `RCABasis`, `Validate`, `NormalizeRCAText`, `RCAChannel`)
- Modify: `api/internal/records/template.go`, `template_test.go`, `normalize.go`, `normalize_test.go`, `guess.go`, `guess_test.go`, `cond.go`, `cond_test.go`
- Modify: `api/internal/recordimport/plan.go`, `plan_test.go` (attribute-type switch for `datetime`; fan-out row counts)
- Create: `api/internal/records/incident.go`, `incident_test.go`; `api/internal/records/testdata/incidents_tracker.csv`, `incidents_oncall.csv`, `incidents_status_page.csv` (verbatim from spec §7.2)
- Create: `api/internal/rca/window.go`, `downtime.go`, `downtime_test.go`, `round.go`, `round_test.go`, `expect.go`, `expect_test.go`, `gap.go`, `gap_test.go`, `ratio.go`, `ratio_test.go`, `rank.go`, `rank_test.go`, `basis.go`, `basis_test.go`, `text.go`, `text_test.go`

**Interfaces:**
- Consumes: `records.Contribution`, `domain.StatusRule`, `domain.StatusLevel` (existing).
- Produces:
  - `domain.AttrDateTime AttrType = "datetime"`; `RecordFields.GroupKey string` (JSON `groupKey,omitempty`); `type ExplainLink struct { ScorecardID, MetricKey, Mode, DownMeasure, Where string }` (JSON camelCase; `Mode` `downtime` or `list`); `RecordType.Explains []ExplainLink` (JSON `explains,omitempty`).
  - `domain.CellRCA`, `RCALink`, `RCABasis` exactly as spec §8.1; `func (r CellRCA) Validate() []ValidationError` (spec §8.2, runes as received, 4,096-byte link budget, lowercased scheme); `func NormalizeRCAText(s string) string` (trim and collapse whitespace; **no** Unicode normalization); `func RCAChannel(principalChannel string) string` (`"" → "web"`, `"token" → "api"`, `"mcp" → "mcp"`).
  - `records.Template.TimeZone string` (JSON `timeZone,omitempty`); `records.FieldMap.Unit string` (JSON `unit,omitempty`; `s`, `min`, `h`; number attributes only); `subjectKey.separator` fans a row out to `externalId = key + "@" + service` with `GroupKey = key`; `recordimport` plan counts source rows and fan-out records separately (`RowCounts.Records`).
  - `records.IncidentPreset() domain.RecordType` (ID `incident`, priorities `SEV1…SEV4`, attributes `startedAt`/`endedAt` datetime, `minutesDown` number, `impactPct` number).
  - Package `rca`:
    ```go
    type Window struct{ Start, End time.Time }
    func PeriodWindow(cal period.Calendar, p period.Period, loc *time.Location) Window // v1 callers pass time.UTC
    func Cutoff(asOf domain.Date) time.Time                                         // as-of + 24h, UTC
    type Incident struct {
        Source, ExternalID, Key, Title, URL, Severity, SubjectID string
        State      domain.RecordState
        Start, End *time.Time
        Minutes    *float64 // minutesDown
        Impact     float64  // 0 < x ≤ 1; 0 means 1
        CreatedAt  domain.Date
        CompletedAt *domain.Date
        Cutoff     time.Time // its source's cutoff
    }
    type Counted struct {
        Incident                                                  Incident
        Minutes, TotalMinutes                                     float64
        Overlaps                                                  map[string]float64 // other Key → raw minutes
        SameWindowAs                                              []string           // keys from other sources, ≥ 80% overlap
        StartedBefore, EndedAfter, Ongoing, DurationOnly, Unknown bool
    }
    type Downtime struct {
        PeriodMinutes, ReportedMinutes, Explained, Unexplained, Excess float64
        WithinTolerance bool
        Items []Counted // evidence order: Minutes desc, then Start, then Key
    }
    func CountDowntime(w Window, periodMinutes, reportedMinutes float64, incs []Incident) Downtime
    func RoundParts(parts []float64, total float64, decimals int) []float64 // ties in slice order; callers pass evidence order, remainder last
    func Duration(minutes float64) string
    func BestStatus(rule domain.StatusRule, scale []domain.StatusLevel) string
    type Expectation string // Needed, Available, None
    type ExpectInput struct {
        YTD, NotDue, NA, NotRated, HasValueOrStatus, HasReadableChildren, AtReportingSubject bool
        Status, BestStatus string
        DisplayedUnits, IdealUnits *int64 // §4.2, display precision
        Higher bool
        WorstChild *Expectation          // row 2 of §4.1
    }
    func Expect(in ExpectInput) Expectation
    func IsReportingSubject(m domain.Metric, subjectDepth int, isItem bool) bool // deepest reportedAt in the chain
    func Ideal(m domain.Metric) (float64, bool)
    func Decimals(format domain.MetricFormat) int
    func GapUnits(ideal float64, displayed string, decimals int) (int64, bool) // from the displayed text, not the exact value
    type Gap struct { Kind string; Ideal *float64; Units *int64; Decimals int; Headline, Detail string }
    type CellFacts struct { Display, Status string; Value *float64; Components map[string]float64; Change *float64 }
    type RecordSummary struct { Noun string; Misses, Denominator int }
    type GapInput struct { Metric domain.Metric; Cell CellFacts; StatusLabel func(string) string; Threshold string; Downtime *Downtime; Records *RecordSummary; ComparedLabel string }
    func GapOf(in GapInput) Gap
    func RatioParts(formula string) (numerator, denominator string, ok bool) // Go port of the web's ratioParts
    type Ranked struct { C records.Contribution; Impact float64; ImpactDisplay, Note string } // ImpactDisplay empty for ratios
    func RankRatio(misses []records.Contribution) []Ranked
    func RankAmounts(per float64, cs []records.Contribution) []Ranked
    func RankChange(cur, prior []records.Contribution, per float64) []Ranked
    func RankOverPlan(cs []records.Contribution) []Ranked
    func StaleReasons(stored, current domain.RCABasis, statusLabel func(string) string) []string
    ```

- [ ] **Step 1: Write the failing tests**

`downtime_test.go` (all times UTC; `inc(key, start, end, impact)` helper; cutoff far in the future unless stated):
```go
sep := rca.PeriodWindow(cal, month(2026, 9), time.UTC) // 43,200 min
d := rca.CountDowntime(sep, 43200, 216, []rca.Incident{
    inc("INC-1187", "2026-09-09T13:12", "2026-09-09T15:42", 1),
    inc("INC-1203", "2026-09-30T23:05", "2026-10-01T00:50", 1),
})
// TestWorkedExample: Items[0] INC-1187 Minutes 150; Items[1] INC-1203 Minutes 55, TotalMinutes 105, EndedAfter;
// Explained 205, Unexplained 11, Excess 0.
```
- `TestOverlapCountedOnce`: Oct, reported 420, INC-2041 Oct 3 14:05–18:15; INC-2047 Oct 17 09:40–11:45; INC-2049 11:20–11:50 → Minutes 250, 112.5, 17.5; `Overlaps["INC-2049"] == 25` on INC-2047; Explained 380; Unexplained 40.
- `TestOverlapSplitByImpact`: A 10:00–11:00 impact 1, B 10:30–11:30 impact 0.5 → **A 50, B 25, Explained 75** (10:00–10:30 A 30; 10:30–11:00 down 30 split A 20 / B 10; 11:00–11:30 B 15).
- `TestCountDowntimeMixed` (Review Focus 1): the two sets above plus an ongoing incident from Oct 31 22:00 whose source's `Cutoff` is `rca.Cutoff(2026-11-14)` (= Nov 15 00:00 UTC) → Oct counts 120 with `Ongoing`; a Nov window counts it to Nov 15 00:00; `RoundParts` of item points plus the remainder equals the displayed gap units for both months.
- `TestRemainderWithinTolerance`: reported 600, explained 595 → `Unexplained == 5`, `WithinTolerance`; 590 → Unexplained 10, not within; reported 75, explained 90 → Excess 15.
- `TestSameWindowAcrossSources`: INC-2041 (tracker) 14:05–18:15 and sp-7h1q (status-page) 14:00–18:20 → each lists the other in `SameWindowAs`; Explained is the union (260).
- `TestDurationOnlyAndUnknown`: `Minutes` 45, no times, `CreatedAt` Oct 9 → 45 in Oct, `DurationOnly`; `Minutes` 30 with `Start` 2026-11-01T01:00Z and `CreatedAt` 2026-10-31 → counted in **Nov** (UTC date of start); no times and no minutes → 0 and `Unknown`; `done` with a start, no end, no minutes, `CompletedAt` Oct 4 → counted to Oct 5 00:00 UTC.
- `TestCancelledAndOutside`: a `cancelled` incident and one entirely in September never count in October.

`round_test.go`: `RoundParts([]float64{0.34722, 0.12731, 0.02546}, 0.5, 2)` → `[0.35, 0.13, 0.02]`; `RoundParts([]float64{0.56, 0.252, 0.0392, 0.0896}, 0.94, 2)` → `[0.56, 0.25, 0.04, 0.09]`; **tie-break**: `RoundParts([]float64{0.0672, 0.0672}, 0.13, 2)` → `[0.07, 0.06]` and minutes `RoundParts([]float64{250, 112.5, 17.5, 40}, 420, 0)` → `[250, 113, 17, 40]`; for 1,000 random part sets the rounded parts sum to the total exactly (compare as integers of `10^d`).

`gap_test.go`: `GapUnits(100, "99.87%", 2)` → 13 for an exact 99.865 (display boundary); Webhooks → Headline `0.94 pts short of 100% · 7h 00m down`, Detail `Red · Green at 99.90% or better`; no downtime measure → `… · 3h 36m down (from the value)`; epics `73%` (percent0, 8 / 11) → `27 pts short of 100% · 3 of 11 epics missed`, Detail ending `· each miss costs 9.1 pts`; support backlog 588 Green ≤ 450 → `138 above the Green line (450 or less)`; spend 104% → `4% over plan · $46k over`; change −26% → `26% worse than Sep · Green needs any improvement`; a `percent1` value `94.5%` → `5.5 pts short of 100%`; a `money_k` lower-better `$920k` with Green ≤ 800 → `$120k above the Green line ($800k or less)`; a scale rule → `0.6 below the Green step (4.0 or more)`; Green 99.97% → `0.03 pts short of 100% · no RCA needed`.

`expect_test.go`: one case per row of spec §4.1 — YTD, not due, n/a, not rated → `None`; the Uptime company cell (no value, readable children, worst child Red) → `Available`; no value without children → `None`; Red product of `epics_on_time` → `Needed`; Red segment of it → `Available`; Green item at 99.97% → `Available`; Green 100.00% → `None`; Yellow company cell of `postmortems_on_time` → `Needed`. `BestStatus`: a tenant scale `B, G, Y, R` with bands producing `G, Y, R` → `G`; a scale rule with steps `G, Y` → `G`. `IsReportingSubject`: a metric reported at product and segment → product true, segment false; item kind deeper than any unit.

`ratio_test.go`: `RatioParts("epics_on_time / epics_committed * 100")` → `epics_on_time, epics_committed`; `"(1 - seconds_down / seconds_in_period) * 100"` → not a ratio; the same cases as the web's `ratioParts` tests.

`rank_test.go`: `RankRatio` orders P1 before P2, then more days late, then key; `ImpactDisplay` is empty; notes `Slipped Oct 15 → Nov 12`, `Missed Oct 28 · still open`. `RankChange` tags a record absent from `prior` as `New` and ranks by the increase.

`basis_test.go`: the five reasons of spec §8.4 verbatim; equal bases → none.

`text_test.go`: `Duration(45) == "45m"`, `Duration(216) == "3h 36m"`, `Duration(420) == "7h 00m"`, `Duration(1565) == "1d 2h 05m"`.

`rca_test.go` (domain): Review Focus 3's inputs return spec §8.2's messages (`Use a link that starts with https://` for `javascript:`, `http:`, user-info and whitespace URLs; `These links are too long together; shorten or remove one` over 4,096 bytes; `Write up to 280 characters` at 281 runes; `Write what caused the gap` for whitespace-only text; `Up to 5 links`; `This link is already listed`); `HTTPS://docs.example/a` validates and is stored `https://docs.example/a`; an HTML title is accepted as text; `NormalizeRCAText("a\n\n  b") == "a b"`; `RCAChannel("")=="web"`, `("token")=="api"`, `("mcp")=="mcp"`.

`incident_test.go`: the tracker sample's INC-2049 fans out to `INC-2049@Webhooks` and `INC-2049@Search` with `GroupKey` `INC-2049`; `startedAt` `2026-10-17T11:20:00Z`; INC-2058 `cancelled`; the on-call row 88412 stores `startedAt` `2026-10-09T01:14:00Z` and `createdAt` `2026-10-08`; 88533 is `open` with no `endedAt`; the status page `partial_outage` gives `impactPct` 50 and `;` fans out; uploading each sample twice gives `unchanged` everywhere. Row errors: `Ended before it started`; `Impact must be more than 0 and at most 100`.

`cond_test.go`: `startedAt >= '2026-10-01T00:00:00Z'` compares instants; a `datetime` compared with a date literal is a validation error. `plan_test.go`: the tracker sample plans 6 source rows and 7 records; a `datetime` attribute value round-trips through the plan. `template_test.go` / `records_test.go`: `timeZone` must be an IANA name; `unit` only on number attributes and one of `s`, `min`, `h`; `explains` mode `downtime` without the needed attributes, or an unknown mode, is an error. `guess_test.go`: `Incident start`, `started_at`, `Started at` guess `startedAt`; `resolved_on`, `Incident end`, `Resolved at` guess `endedAt` for an `incident` type.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/rca/... ./internal/records/... ./internal/recordimport/... ./internal/domain/...` → FAIL (undefined: `rca.CountDowntime`, `domain.AttrDateTime`, …).

- [ ] **Step 3: Implement.** The sweep in `CountDowntime` follows spec §5.2 exactly; each incident is clipped by its own `Cutoff`. `datetime` values parse with the field's `dateFormats` in the template's `timeZone` (RFC 3339 inputs keep their offsets) and are stored as RFC 3339 UTC strings.

- [ ] **Step 4: Verify** the same command passes, then the gate (no web change, no screenshots).

- [ ] **Step 5: Commit** — `feat(api): incident records and the gap arithmetic for RCAs`.

---

### Task T2a: RCA API surface, store, note writes and exposure — Wave 2

**Files:**
- Modify: `openapi/openapi.yaml` (every operation and schema of spec §9.1–§9.2, including `RecordTemplate.timeZone`, `FieldMap.unit`, `FieldMap.separator` on `subjectKey`, `AttributeDef.type: datetime`, `RecordType.explains`, `Cell.rca` (`CellRcaState`, no `available`), `ViewRow.rcaIdeal`, `getReportDocument`'s `rcas` with `x-mcp-hidden: true`, `ReportDocument.rcas`, `listCellRcas`'s `countsOnly`, and the untrusted-text sentence in `getCellRca`/`listCellRcas` descriptions); regenerate `api/internal/httpapi/gen.go` and `web/src/api/schema.d.ts` (`make gen`)
- Modify: `api/internal/store/store.go` (`RCAStore` in `Store`), `store/memstore/memstore.go`, `store/dynamostore/keys.go`, `store/storetest/suite.go`; Create: `store/memstore/rcas.go`, `store/dynamostore/rcas.go`
- Create: `api/internal/httpapi/rca.go` (put, delete), `rca_test.go`, `rca_basis.go` (one cell's basis for a write), `rca_stubs_read.go` (`GetCellRca`, `ListCellRcas` → `errNotImplemented`), `rca_stubs_draft.go` (`DraftCellRca`, `GetCellRcaDraft` → `errNotImplemented`), `mcp_rca_test.go`
- Modify: `api/internal/httpapi/records.go`, `records_test.go` (wire format for `explains`, `datetime`, `timeZone`, `unit`, `separator`), `mcp.go` (`mcpExcluded` gains `delete_cell_rca`, `draft_cell_rca`, `get_cell_rca_draft`), `server.go` (wiring)
- Modify: `api/internal/assistant/tools.go`, `tools_test.go` (`/scorecards/{sc}/rca/draft` excluded)

**Interfaces:**
- Consumes: T1's `domain.CellRCA`, `Validate`, `RCAChannel`, `rca.*`.
- Produces:
  ```go
  type RCAStore interface {
      GetRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) (domain.CellRCA, error)
      PutRCA(ctx context.Context, tenantID string, r domain.CellRCA, expectedRevision int) (domain.CellRCA, error) // 0 creates; mismatch ErrConflict
      DeleteRCA(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period, expectedRevision int) error
      ListRCAs(ctx context.Context, tenantID, scorecardID string, p period.Period) ([]domain.CellRCA, error)
      ListRCAsRange(ctx context.Context, tenantID, scorecardID string, from, to period.Period) ([]domain.CellRCA, error) // one query; by period, metric, subject
  }
  ```
  - `func (s *Server) loadIncidents(ctx context.Context, tenantID, sc string, metricKeys []string) (map[string]map[string][]rca.Incident, error)` in `rca_basis.go` — incidents of every record type whose `explains` names one of `metricKeys`, by metric then subject, `where` applied, cutoffs per source. T2b reuses it.
  - `func (s *Server) cellBasis(ctx context.Context, p auth.Principal, sc, metric, subject string, per period.Period) (domain.RCABasis, error)` — used by PUT (T2b later delegates it to the explainer).
  - All generated types of spec §9.2 for T2b, T2c, T3 and T4.

- [ ] **Step 1: Write the failing tests**

`storetest/suite.go` (`RCAs`): create at revision 0 → 1; put with 1 → 2; put with 1 again → `ErrConflict`; delete with a stale revision → `ErrConflict`; `ListRCAs` returns one period only, sorted; `ListRCAsRange(2025-M11, 2026-M10)` returns notes of every month and quarter in range and none outside; another tenant sees nothing. Runs for memstore and dynamostore (memdynamo).

`rca_test.go`:
- `TestPutCellRcaPermissions` (Review Focus 2): the Payments contributor can put on a Payments product, on `checkout-api` (a `none` cell at 100%) and on the Payments **segment** roll-up; gets 403 `You can write RCAs only for your own units.` on `webhooks`, on the company cell and on an unattached item; the viewer gets 403 everywhere; a stale `expectedRevision` gets 409 whose body holds the current note; no rejected write adds an audit entry.
- `TestPutCellRcaValidation` (Review Focus 3): each hostile input returns 400 with T1's message at its path (`links[1].url`, `text`, `links`); `HTTPS://docs.example/a` is stored lowercased.
- `TestPutCellRcaAudit`: create, update, confirm (same text and links) and delete write `create`, `update`, `confirm`, `delete` with `targetType: rca`, `targetId: uptime|webhooks|2026-M10`; a put with a personal access token stores `channel: api`; through `/v1/mcp`, `channel: mcp`.
- `TestPutCellRcaBasis`: a put on Webhooks 2026-M10 stores basis display `99.06%`, status `R`, reported minutes 420 (evidence empty until T2c seeds incidents; a fixture incident type in this test yields `incident-tracker:INC-2041`).
- `TestStubs`: `GET /rca`, `GET /rcas`, `POST /rca/draft` return 501 `not_implemented`.

`mcp_rca_test.go`: the catalog has `get_cell_rca`, `list_cell_rcas`, `put_cell_rca`; not `delete_cell_rca`, `draft_cell_rca` or `get_cell_rca_draft`; `get_report_document` has no `rcas` argument; `get_cell_rca`'s description contains `untrusted`. `tools_test.go`: SAM's tool set has `get_cell_rca` and `list_cell_rcas` and no RCA write or draft tool.

`records_test.go`: a record type with `explains` and a `datetime` attribute round-trips; a template with `timeZone`, `unit` and `separator` round-trips and is validated.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/store/... ./internal/httpapi/... ./internal/assistant/...`.

- [ ] **Step 3: Implement.** OpenAPI first, `make gen`, then the store, `rca_basis.go`, handlers, stubs and exclusions.

- [ ] **Step 4: Verify**, then the gate with `make gen-check`. No screenshots (no UI); save `curl` outputs of a put, a 403 and a 409 to `task-T2a/`.

- [ ] **Step 5: Commit** — `feat(api): RCA notes: API surface, store, writes and MCP exposure`.

---

### Task T2c: Demo incidents and notes; incident story lines — Wave 3

**Files:**
- Modify: `api/internal/demo/seed.go`, `seed_test.go`; Create: `api/internal/demo/testdata/acme_incidents_oct.csv`
- Modify: `api/internal/recordimport/story.go`, `story_test.go`

**Interfaces:**
- Consumes: T1's preset and records changes; T2a's `RCAStore`.
- Produces: the demo of spec §14 (the `incident` type with `explains` for `uptime` and `deployment_uptime`, one snapshot as-of 2026-11-01, three notes with explicit bases); `demo.RCAExamples` naming the three noted cells and `demo.RCANeeded` naming two needed cells without notes (Analytics Ingest and Notification Relay - Multi-Region Active, Oct 2026), for T2b's tests.

- [ ] **Step 1: Write the failing tests**

`seed_test.go`: the incident type exists with the two links; 1 incident snapshot; INC-2049 has two fan-out records; the three notes exist with authors `dev|admin`, `dev|admin`, `dev|contributor`; the Search note's basis display is `99.90%`; the Webhooks note's basis is display `99.06%`, status `R`, reported 420, evidence `incident-tracker:INC-2041`, `…:INC-2047`, `…:INC-2049`; Webhooks Oct downtime is still 420 minutes (no seeded value moved); `demo.RCAExamples[2]`'s cell status is not the best.

`story_test.go`: previewing the tracker sample against the demo before its snapshot gives `Oct · Webhooks · 3 incidents explain 6h 20m of 7h 00m reported`; after apply, re-previewing gives `nothingChanged`; the counts read `6 rows → 7 records`.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/demo/... ./internal/recordimport/...`.

- [ ] **Step 3: Implement** the seed (incidents from the CSV through the normal import path, notes written through the store with their bases) and the story lines (incident minutes per subject from `rca.CountDowntime` with the cell's reported minutes).

- [ ] **Step 4: Verify**, then the gate. Screenshot the import preview's story for the tracker sample at 1440 and 390 (`/admin/import`).

- [ ] **Step 5: Commit** — `feat(api): demo incidents and RCA notes; incident story lines`.

---

### Task T4: The Why card, its editor and the hooks (web) — Wave 3

**Files:**
- Create: `web/src/features/rca/WhyButton.tsx`, `WhyButton.test.tsx`, `WhyCard.tsx`, `WhyCard.test.tsx`, `WhyCardContent.tsx`, `GapBar.tsx`, `EvidenceList.tsx`, `RcaEditForm.tsx`, `RcaEditForm.test.tsx`, `SamSuggestion.tsx`, `WhyCardProvider.tsx`, `rcaText.ts`, `rcaText.test.ts`, `rcaState.ts`, `rcaState.test.ts`
- Modify: `web/src/api/queries.ts`, `web/src/api/queries.test.tsx` (RCA hooks; `useReportDocument` sends `rcas=true`)
- Modify: `web/src/features/scorecard/ScorecardFrame.tsx` (mount `WhyCardProvider` once)
- Create: `web/src/test/rcaFixtures.ts`; Modify: `web/src/test/server.ts` (MSW handlers for the six operations)

**Interfaces:**
- Consumes: T2a's generated `components['schemas'][…]`.
- Produces:
  - Hooks: `useCellRca(sc, ref: RcaCellRef | null)`, `usePutCellRca(sc)`, `useDeleteCellRca(sc)`, `useCellRcas(sc, q: { period: string; scope?: string; state?: RcaListState; mine?: boolean })`, `useCellRcaCounts(sc, period)` (`countsOnly=true`, `staleTime: 60_000`), `useCellRcaDraft(sc)`. `type RcaCellRef = { metric: string; subject: string; period: string }`. Saving invalidates the cell, the list, the counts and the views of that period.
  - `rcaState.ts`: `bestStatus(rule: StatusRule, scale: StatusLevel[]): string`; `displayState(row: ViewRow, cell: Cell, scale: StatusLevel[], surface: 'single' | 'dense'): WhyDisplay | null` — `available` derived from `row.rcaIdeal` and status per spec §9.2; dense surfaces return null for `available`; tags only when `cell.rca.canEdit` (or role admin/contributor for roll-up counts).
  - `WhyButton({ display: WhyDisplay, subjectName, valueDisplay, periodLabel, nameSubject, prefix?: 'why' | 'rca', compact?, onOpen })` — spec §10.1 states, names and `aria-description`.
  - `WhyCardProvider` + `useWhyCard(): { open(ref: RcaCellRef, anchor: HTMLElement, opts?: { title?: string; showValue?: boolean }): void }` — one card at a time; popover (`modal` on `Popover.Root`) ≥ 640px, sheet below; focus to the heading; Esc and Close return focus to `anchor`.
  - `rcaText.ts`: `whyName(...)`, `rcaExcerpt(text, max = 60)`, `hostOf(url)` (`URL.hostname`, punycode), `safeHref(url): string | null` (https only, any case), `codePoints(text): number` (`[...text.normalize('NFC')].length`).

- [ ] **Step 1: Write the failing tests**

`WhyButton.test.tsx`: needed with `canEdit` → name `Why is Webhooks 99.06% in Oct 2026? RCA needed` and the tag; needed without `canEdit` → `Why?` only; written → `Why:` + excerpt, name `Why Webhooks is 99.06% in Oct 2026: RCA by Avery Admin`; stale → `Review` tag (editors only); roll-up `neededBelow: 1, staleBelow: 1` → `1 needed · 1 to review`; `prefix="rca"` → `RCA:` / `RCA needed` / `RCA · Review`; hints are `aria-description`, not in the name; `min-h-6`; axe clean.
`rcaState.test.ts`: a Green 99.97% uptime cell with `rcaIdeal: 100` → `available` on `single`, null on `dense`; Green 100.00% → null; Red without `Cell.rca` (a roll-up) → `available`; a custom scale `B, G, Y, R` with G-best bands → Green is best.
`WhyCard.test.tsx` (fixtures mirror the demo):
- uptime: headline; hidden bar sentence `7h 00m down: INC-2041 4h 10m, INC-2047 1h 53m, INC-2049 17m, 40m not explained`; rows in evidence order with points; the overlap note; the remainder row; every key link `target="_blank"`, `rel="noopener noreferrer"`, name `INC-2041 (opens in a new tab)`.
- anchored popover has **no** value row; the 390px sheet and `showValue: true` have it; in the sheet, incident titles carry `line-clamp-2`.
- epics: detail `… · each miss costs 9.1 pts`; record rows have **no** points.
- within-tolerance remainder shows `(within 1% of the reported downtime)`; excess callout begins `Incidents add up to 0.20 pts (1h 30m)`; same-window note `Same window as sp-7h1q (Status page)`.
- Review Focus 3 (render): a `javascript:` URL renders the key as text with no `a`; an HTML `img` title is text and no `img` exists; a host `xn--…` shows as punycode.
- stale banner reasons and `Still accurate` → `putCellRca` with the same text, links and revision; empty states for an editor and a viewer (`Billing hasn't written one yet.`); roll-up rows open the child and `‹ Acme Demo` returns; loading `aria-busy` + `Loading why`; error `Try again`; open focuses the heading; Escape closes and focuses the trigger.
`RcaEditForm.test.tsx`: counter `121 / 280` counting code points (an emoji counts 1, a decomposed `é` counts 1 after NFC); at 292 `12 over` and Save disabled; the sent text is NFC; https message with `aria-invalid`; the 4 KB link message; `Add link` hidden at 5. Review Focus 5: a stale save shows `Someone else changed this RCA while you were editing.`, `Show theirs`, and keeps `Your text`; closing dirty asks `Discard your changes?`; `Use this draft` replaces the text, shows `Undo`, and `putCellRca` is not called; draft `warnings: ['INC-9999']` show the spec's sentence; delete asks the two-button confirm.
`rcaText.test.ts`: `safeHref('http://x')` null; `safeHref('HTTPS://docs.example/a')` the URL; `hostOf` → `docs.example`; `rcaExcerpt` of 70 characters ends `…` at 61.
`queries.test.tsx`: `usePutCellRca` invalidates `['rca', sc, ref]`, `['rcas', sc, period]`, `['rca-counts', sc, period]` and the view queries for the period; `useReportDocument` sends `rcas=true`.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- rca queries`.

- [ ] **Step 3: Implement** per spec §10.1–§10.4 and §10.9–§10.11.

- [ ] **Step 4: Verify**, then the gate. No screenshots: the card has no surface until T5 and T6, and `GET /rca` is stubbed until T2b; attach the Testing Library DOM output of the uptime and epics cards to `task-T4/`. T5 and T6 capture the card in the app.

- [ ] **Step 5: Commit** — `feat(web): the Why card, RCA editor and SAM suggestion`.

---

### Task T2b: The shared explainer, reads and RCA state on views — Wave 4

**Files:**
- Create: `api/internal/httpapi/rca_explain.go`, `rca_explain_test.go`, `rca_view.go`, `rca_view_test.go`, `rca_list.go`, `rca_list_test.go`, `rca_budget_test.go`
- Delete: `api/internal/httpapi/rca_stubs_read.go`
- Modify: `api/internal/httpapi/rca_basis.go` (ownership passes from T2a: `cellBasis` delegates to the explainer at depth `state`), `view.go`, `view_test.go`

**Interfaces:**
- Consumes: T1, T2a (`RCAStore.ListRCAsRange`, `loadIncidents`), T2c's demo and `demo.RCAExamples` / `demo.RCANeeded`.
- Produces:
  ```go
  type explainDepth int // depthState, depthSummary, depthFull
  type explainOpts struct { Scope string; Restated bool }
  func (s *Server) newExplainer(ctx context.Context, p auth.Principal, sc string, periods []period.Period, opts explainOpts) (*explainer, error)
  func (e *explainer) explain(metric, subject string, per period.Period, d explainDepth) (CellRca, error)
  func (e *explainer) snapshot(metric, subject string, per period.Period) (RcaSnapshot, error) // summary + top-5 evidence, for T3
  func annotateRCA(v *ScorecardView, e *explainer) // live views only
  ```
  The explainer loads once per request: the engine input and the computed view for its periods; notes via one `ListRCAsRange`; incidents only for metrics with a downtime link (all cells at `full`/`summary`; noted cells only at `state`); the derive input lazily, on the first derived metric explained; derived contributions memoized per measure and period.

- [ ] **Step 1: Write the failing tests**

`rca_explain_test.go` (through `GET /v1/scorecards/service-fulfillment/rca`):
- `TestExplainWebhooks`: `expectation: needed`; `gap.headline` `0.94 pts short of 100% · 7h 00m down`; incidents `INC-2041` `0.56 pts` `4h 10m`, `INC-2047` `0.25 pts` `1h 53m` (note `Overlaps INC-2049 for 25m`), `INC-2049` `0.04 pts` `17m`; `unexplained.display` `0.09 pts · 40m of the 7h 00m reported`; Avery Admin's note; `stale: false`; `canEdit: true` for the admin.
- `TestExplainSearchStaleAndTie`: `stale: true` with `The value changed from 99.90% to 99.87%.` and `1 new incident since it was written: INC-2049.`; INC-2049 `0.07 pts`, remainder `0.06 pts`; INC-2055 (maintenance) absent.
- `TestExplainExcess`: Analytics Ingest → `excess` 15 minutes, `unexplained == null`, points rounded to their own sum (`0.20 pts`).
- `TestExplainRecords`: `demo.RCAExamples[2]` → `gap.kind: ratio`, `recordsSummary` matching `^\d+ of \d+ epics missed$`, every record without `impactDisplay`, detail ending `each miss costs N pts`.
- `TestExplainUptimeCompany`: the company cell of `uptime` (no value) → `expectation: available`, `children` the worst three readable services.
- `TestExplainReadableOnly` (Review Focus 2): a viewer scoped to Mobile reading the company `uptime` cell sees only Mobile services in `children`, `childrenTotal` counting Mobile only, and stale reasons naming no Platform incident.
- `TestExplainNoIncidentType` (Review Focus 4): a tenant fixture without incident types → the uptime headline ends `(from the value)`, `incidents` empty.
- `TestPutUsesExplainerBasis`: re-saving the Search note (confirm) clears `stale`.

`rca_list_test.go`: `GET …/rcas?period=2026-M10` (admin) → `counts.needed` equals the needed items; items sorted needed, stale, written, then status, then gap; `state=all` includes `available` rows last and Search as `stale`; `mine=true` as the Payments contributor returns only Payments rows; a Mobile-scoped viewer sees only Mobile rows; `countsOnly=true` returns counts with `items: []` and `neededMine` equal to the needed rows the caller can write, without loading the derive input (assert through an instrumented loader).

`rca_view_test.go` / `view_test.go`: the Overview request for 2026-M10 has `rca.state: written` with an excerpt ≤ 64 characters on Webhooks' Oct cell; `rca.state: needed` with `canEdit` on Analytics Ingest's for the admin and `canEdit: false` for the viewer; **no `rca` with an `available` state anywhere**, none on a Green 100.00% cell or any YTD cell; the company `uptime` cell carries `neededBelow: 1, staleBelow: 1` for the admin (Analytics Ingest needed, Search stale) and readable-only counts for a scoped viewer; `ViewRow.rcaIdeal` is 100 on uptime rows and absent on the support backlog; with `restate=` no `stale` state is computed (the Search cell reads `written`).

`rca_budget_test.go` (Review Focus 4): the demo Overview view's gzipped body with RCA state is at most 5% larger than with `annotateRCA` disabled, and its raw body is under 512 KB; `listCellRcas` with 200 rows (fixture tenant with 200 needed cells) is under 256 KB raw and returns in under 3 s; the Overview with RCA state takes at most 1.5× the time without (median of 5); `getCellRca` for Webhooks is under 32 KB.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/httpapi/... -run 'Explain|RcaList|RcaView|View|Budget|PutUses'`.

- [ ] **Step 3: Implement** per spec §9.2, §9.5 and §8.4 (cheap view staleness).

- [ ] **Step 4: Verify**, then the gate. Save `curl` outputs of the four demo cells and the list to `task-T2b/`.

- [ ] **Step 5: Commit** — `feat(api): RCA explanations, the RCAs list and RCA state on views`.

---

### Task T3: SAM drafts and RCAs in reports — Wave 5

**Files:**
- Create: `api/internal/assistant/rca_draft.go`, `rca_draft_test.go`, `links.go`, `links_test.go` (answer-link rewriting)
- Modify: `api/internal/assistant/runner.go`, `runner_test.go` (dispatch by draft kind; rewrite answer links), `prompt.go` (spec §9.4's two sentences), `api/internal/domain/assistant.go` (`AssistantDraft.Kind`, `MetricKey`, `SubjectID`)
- Create: `api/internal/help/topics/rca.md`; Modify: `api/internal/help/help_test.go`
- Delete: `api/internal/httpapi/rca_stubs_draft.go`; Create: `api/internal/httpapi/rca_draft.go`, `rca_draft_test.go`
- Modify: `api/internal/httpapi/report_draft.go`, `report_draft_test.go` (kind filter in the pending check, GET and eviction), `assistant_threads.go`, `assistant_threads_test.go` (runner wiring for RCA drafts)
- Modify: `api/internal/report/snapshot.go`, `snapshot_test.go` (`SchemaVersion` 3, `RcaSnapshot`), `api/internal/httpapi/reports.go`, `reports_test.go`
- Modify: `api/internal/store/memstore/drafts.go`, `store/dynamostore/drafts.go` (persist the new draft fields)

**Interfaces:**
- Consumes: T2b's `newExplainer`, `explain`, `snapshot`, `annotateRCA`.
- Produces: `assistant.RCADraftPromptVersion = "sam-rca-v1"`; `assistant.RCADraftData(c RCADraftCell) string`; `assistant.KeyShapes(keys []string) []*regexp.Regexp` and `assistant.DraftKeyWarnings(draft string, keys []string) []string`; `assistant.RewriteAnswerLinks(answer string, allowedHosts []string) string`; `report.RcaSnapshot`; `GET …/reports/{period}?rcas=true` for live and published documents.

- [ ] **Step 1: Write the failing tests**

`rca_draft_test.go` (assistant, fake provider): the system prompt has each rule line of spec §9.3 verbatim and `(Prompt sam-rca-v1.)`; Webhooks' user message lists `INC-2041`, `INC-2047`, `INC-2049`, `0.09 pts not explained` and no other key; a 400-rune answer is cut at the last sentence end within 280, one with no sentence end at 279 runes + `…`; `DraftKeyWarnings("… INC-9999, 88999 and sp-zz9 … INC-2041", []string{"INC-2041", "88412", "sp-7f3k"})` → `["INC-9999", "88999", "sp-zz9"]` (shapes derived from the keys sent); a contributor outside scope gets `Only people who can write this RCA can draft it.`

`links_test.go` (Review Focus 3): `RewriteAnswerLinks("See [the fix](https://evil.example/x) and [INC-2041](https://tracker.example/browse/INC-2041)", []string{"tracker.example"})` → `See the fix (evil.example) and [INC-2041](https://tracker.example/browse/INC-2041)`. `runner_test.go`: a turn whose tool result contains an incident title instructing SAM to print a link to `evil.example` yields an answer with no `evil.example` link; `prompt.go` contains both spec §9.4 sentences.

`rca_draft_test.go` (httpapi): `POST /rca/draft` → 202 pending; polling returns `text` and `warnings`; the note is unchanged afterwards; 409 while one is pending for the same cell. `report_draft_test.go` (Review Focus 5): a pending RCA draft for 2026-M10 does **not** make `POST …/summary/draft` 409; `GET …/summary/draft/{rcaDraftId}` is 404; six RCA drafts evict only RCA drafts (the summary draft survives).

`reports_test.go`: publish 2026-M10 → the stored object has `schemaVersion: 3`, `rcas` with Webhooks (`text`, `headline`, 3 `evidence`), worst first, at most 300, and the stored `view` has **no** `rca` on any cell; `GET` without `rcas` has no `rcas`; `?rcas=true` on the published document returns them, filtered for the Payments contributor (children filtered too); `?rcas=true` on the **live** document returns snapshots built by the explainer; editing the Webhooks note after publishing leaves the snapshot unchanged; a v2 object with `?rcas=true` has no `rcas`; the live document's `view` carries `Cell.rca` (via `annotateRCA`). Budgets (Review Focus 4): publishing a fixture with 300 RCAs finishes under 10 s; the maximum document (300 RCAs × 5 links at the 4 KB budget, with `view` and `standing`) is under 900 KB gzipped; the default document's size is unchanged.

`help_test.go`: `help.Search("why rca incident")` returns `rca` first; the topic mentions the conservative overlap rule.

- [ ] **Step 2: Run to verify they fail** — `cd api && go test ./internal/assistant/... ./internal/httpapi/... ./internal/report/... ./internal/help/... ./internal/store/...`.

- [ ] **Step 3: Implement** per spec §9.3, §9.4, §10.7 and §10.8.

- [ ] **Step 4: Verify**, then the gate (`make gen-check` must still pass; T3 does not edit the OpenAPI).

- [ ] **Step 5: Commit** — `feat(api): SAM drafts for RCAs, safer answer links, and RCAs in reports`.

---

### Task T5: Why? on tiles, the board, item grids and the full-screen dialog — Wave 5

**Files** (all exist at `82666d5` unless marked Create):
- Modify: `web/src/features/scorecard/TileFrame.tsx`, `TileFrame.test.tsx`, `MetricTile.tsx`, `ItemSummaryTile.tsx`, `ItemSummaryTile.test.tsx`, `AttentionCard.tsx`, `AttentionCard.test.tsx`, `OverviewPage.tsx` (prop plumbing only), `OverviewPage.test.tsx`
- Modify: `web/src/features/scorecard/StatusBoard.tsx`, `StatusBoard.test.tsx`, `logic/statusBoard.ts`, `logic/statusBoard.test.ts` (Current as the trailing gridcell; stacked trailing cells; `rca` on `BoardCell`)
- Modify: `web/src/features/scorecard/ItemGrid.tsx`, `ItemGrid.test.tsx`, `ItemDrillIn.tsx`, `ItemDrillIn.test.tsx`, `ItemMonths.tsx`, `ItemMonths.test.tsx`, `FocusDialog.tsx`, `FocusDialog.test.tsx`, `useDialogShortcuts.ts`, `useDialogShortcuts.test.tsx`
- Modify: `web/src/ui/status/StatusCell.tsx`, `StatusCellTip.tsx`, `useGridNavigation.ts`, `useGridNavigation.test.tsx`
- Modify: `web/src/test/viewFixtures.ts` (`Cell.rca`, `ViewRow.rcaIdeal`)

**Interfaces:**
- Consumes: T4's `WhyButton`, `useWhyCard`, `displayState`; `Cell.rca` and `ViewRow.rcaIdeal` from T2b's views.
- Produces: `TileFrameProps.why?: ReactNode`; `StatusCell` prop `rca?: CellRcaState`; `StatusCellTipProps.rca?: CellRcaState`; `GridNavigationOptions.trailing?: boolean` and `onWhy?: (rowId: string, col: number, el: HTMLElement) => void` (bound to `W`); `ItemMonthsProps.onWhy?: (period: string, el: HTMLElement) => void` (Why in the Status cell; absent → unchanged).

- [ ] **Step 1: Write the failing tests**

- `useGridNavigation.test.tsx`: with `trailing`, End still lands on the selected period and the first tab stop is the selected period; → from it reaches the trailing cell, ← returns; a row with a spacer trailing cell keeps → on the selected period; PageUp/PageDown keep the column; `W` calls `onWhy` with the focused cell; `W` with Ctrl or inside an input does nothing.
- `TileFrame.test.tsx`: with `why`, the line sits between the value row and the chart; without it, the DOM is unchanged.
- `OverviewPage.test.tsx`: a Green 100.00% tile has no Why button; a Green 99.97% tile shows `Why?` (single surface); the epics tile at Checkout scope shows `Why? RCA needed` for the admin and `Why?` for the viewer.
- `ItemSummaryTile.test.tsx`: the Webhooks row's name ends `; RCA written`; the footer shows `1 RCA needed · 1 to review ›` for editors (link `rcas?period=2026-M10&rca=needed&metric=uptime`), nothing for viewers; a Green 99.97% row has no mark or tag.
- `AttentionCard.test.tsx`: the RCA line reads `RCA: …` (not `Why`), sits under `attention-why`, is `relative z-10`, and opens the card rather than the metric.
- `StatusBoard.test.tsx`: inline — → from Oct reaches Current; Enter there opens the card for `{ metric: 'uptime', subject: 'acme', period: '2026-M10' }` with tag `1 needed · 1 to review` (admin); `W` on Mar opens Mar's card; Enter on a month still calls `onOpen`; a written cell has the mark and `; RCA written`; the tip shows `RCA: …`. Stacked (360px) — the ribbon row ends in a 32px trailing gridcell reachable by → and by click/tap, and the `aria-hidden` name row holds no control.
- `ItemGrid.test.tsx`: inline — the Value cell is the trailing gridcell, named `Webhooks, Oct 2026: 99.06%, Red. RCA written.` with `aria-description` `Press Enter for why`; Enter opens the card; a Green 99.97% row's Value cell shows no `Why?`; the hint row ends `· W why`. Stacked — the trailing cell exists and is reachable.
- `ItemMonths.test.tsx` / `FocusDialog.test.tsx`: with `onWhy`, the Status cell shows the mark and a compact `Why`/`RCA`/`Review` button for months with a dense-surface state, still four columns at 390px; Monthly values now render for a ratio metric's full-screen body too; the value row has the WhyButton (single surface); Escape with the card open closes only the card.
- `ItemDrillIn.test.tsx`: the drill-in value row has the WhyButton for the item's cell.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- useGridNavigation TileFrame OverviewPage ItemSummaryTile AttentionCard StatusBoard statusBoard ItemGrid ItemMonths FocusDialog ItemDrillIn useDialogShortcuts`.

- [ ] **Step 3: Implement** per spec §4.3, §10.1, §10.6 and §10.9; the mark is a CSS pseudo-element on `StatusCell`.

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390 (T5 servers; the demo from T2c): Overview (epics tile at `?scope=checkout`, the uptime tile, the board with Current focused; phones: stacked board with the trailing cell), `?focus=uptime` (Value cell focused; Green rows quiet), `?focus=uptime&item=webhooks` with the card open, `?focus=epics_on_time&scope=checkout` with Monthly values open and the card open from a past month.

- [ ] **Step 5: Commit** — `feat(web): Why? on tiles, the status board, item grids and the full-screen dialog`.

---

### Task T6: The RCAs view, the Report page, the downloads and Record types — Wave 6

**Files** (all exist at `82666d5` unless marked Create):
- Create: `web/src/features/rca/RcasPage.tsx`, `RcasPage.test.tsx`, `rcaReminder.ts`, `rcaReminder.test.ts`
- Modify: `web/src/App.tsx` (route `scorecards/:sc/rcas`), `web/src/features/scorecard/ControlBar.tsx`, `ControlBar.test.tsx` (fourth view; pill from `useCellRcaCounts`)
- Modify: `web/src/features/scorecard/ReportPage.tsx`, `ReportPage.test.tsx`, `report/model.ts`, `report/model.test.ts`, `report/ReportStatusList.tsx`, `report/ReportStatusList.test.tsx`, `report/pptx.ts`, `report/pdf.ts`, `report/export.test.ts`, `web/src/test/reportFixtures.ts`
- Modify: `web/src/features/admin/RecordTypesPage.tsx`, `RecordTypesPage.test.tsx`, `adminModel.ts`, `adminModel.test.ts`

**Interfaces:**
- Consumes: T4's hooks, card and `safeHref`; T3's `ReportDocument.rcas` (live and published).
- Produces: `ReportMetric.why?: { headline: string; text?: string; author?: string; links: RcaLink[]; evidence: { key: string; url: string | null; pointsDisplay: string }[]; unexplained?: string; children: RcaChild[]; editedSincePublication: boolean }`; `ReportModel.rootCauses: { metric: string; where: string; display: string; status: string; text: string; keys: { key: string; url: string | null }[] }[]`; `ReportModel.rcasNeeded: number`; `reminderText(items: CellRcaSummary[], url: string, periodLabel: string): string`.

- [ ] **Step 1: Write the failing tests**

- `RcasPage.test.tsx`: `?rca=needed` default; toggles `aria-pressed` and update the URL; rows grouped with `th scope="rowgroup"`; `Add RCA` opens the card (with its value row) anchored to it; after a save the row reads `Open`, focus stays, and the live region says `RCA saved for Webhooks`; `Only ones I can write` on by default for the contributor; the filter narrows rows; both empty states; one `li` per cell under 640px; `?why=uptime:analytics-ingest` opens that row's card on load; axe clean.
- `rcaReminder.test.ts`: the exact block of spec §10.5, ending with the view URL.
- `ControlBar.test.tsx`: `RCAs` tab with pill `7` named `RCAs, 7 needed` from `counts.neededMine`; no pill at 0; the counts request carries `countsOnly=true` and is not refetched within 60 s.
- `model.test.ts`: a live document's `rcas` give Uptime `why.children` (Webhooks written, Analytics Ingest not) and postmortems its own `why.text`; a v3 published model reads `why` from `rcas` and sets `editedSincePublication` when the live revision is newer; a v2 model shows `RCAs shown as they are now; …`; `rcasNeeded` from the counts.
- `ReportPage.test.tsx`: the Why block's copy and keys linked through `safeHref` (an `http:` URL renders the key as text); `No RCA yet` + `Add RCA` (live, editor) linking `rcas?…&why=uptime:analytics-ingest`; none on a published revision; `Root causes`; **the line beside Publish** `7 RCAs are still needed for Oct 2026. Publishing does not wait for them.` for admins on a live report, hidden at zero; a 300-RCA published fixture renders `Root causes` with `Showing the 300 most severe RCAs` and no horizontal overflow.
- `ReportStatusList.test.tsx`: the caption gains `Why: …` (`line-clamp-2`).
- `export.test.ts`: the PPTX Uptime slide has a `Why` box with a hyperlink run for `INC-2041` and none for an `http:` key; an appendix `Root causes · Oct 2026` with 8 rows a slide; the PDF prints `INC-2041 https://tracker.example/browse/INC-2041` in the appendix and no URL for an `http:` key; a title `Queue < 5 & retries > 3` round-trips literally into both files.
- `RecordTypesPage.test.tsx` / `adminModel.test.ts`: `Add incident type` creates priorities `SEV1…SEV4` and the four attributes, then is disabled; an Explains row `Uptime · Downtime · Category is not maintenance` saves `explains: [{ scorecardId, metricKey: 'uptime', mode: 'downtime', where: "category != 'maintenance'" }]` with the loaded revision; 409 shows the existing conflict message; the attribute picker offers `Date and time`.

- [ ] **Step 2: Run to verify they fail** — `npm --prefix web test -- RcasPage rcaReminder ControlBar model ReportPage ReportStatusList export RecordTypesPage adminModel`.

- [ ] **Step 3: Implement** per spec §7.1, §10.5, §10.7 and §10.8.

- [ ] **Step 4: Verify**, then the gate. Screenshots at 1440 and 390: `/scorecards/service-fulfillment/rcas?period=2026-M10` (needed; all; a card open from `Add RCA`); the live Report for 2026-M10 (Why blocks, Root causes, the Publish line); the PPTX and PDF opened and captured (Uptime slide; appendix); `/admin/record-types` with the Explains section.

- [ ] **Step 5: Commit** — `feat(web): the RCAs view, RCAs in the report and downloads, and incident record types`.

---

### Task T7 (follow-up, not scheduled): deferred items

Owns, when scheduled: the setup wizard's incident detection and in-wizard preset (`web/src/features/import/setup/*`, `api/internal/records/guess.go` thresholds); `TemplatesPage` form fields for `timeZone`, `unit` and `separator`; a Why link in `CellDrawer`; PDF link annotations (`report/pdf.ts`). Depends on T1 (wizard) and T6 (PDF, drawer). Ports 8128/5228.

---

## Task table

| Task | Wave | Owns (summary) | Depends on | Ports (API/Web) |
|---|---|---|---|---|
| T1 | 1 | `domain/records.go`, `domain/rca.go`, `records/{template,normalize,guess,cond,incident}.go`, `records/testdata/incidents_*.csv`, `recordimport/plan.go`, `rca/*` | — | — |
| T2a | 2 | `openapi.yaml` + generated code, `store/*` RCA store, `httpapi/{rca,rca_basis,rca_stubs_read,rca_stubs_draft,records,mcp,server}.go`, `mcp_rca_test.go`, `assistant/tools.go` | T1 | 8121/5221 |
| T2c | 3 | `demo/seed.go`, `demo/testdata/acme_incidents_oct.csv`, `recordimport/story.go` | T2a | 8122/5222 |
| T4 | 3 | `web/src/features/rca/*` (card, editor, hooks' components, `rcaState`, `rcaText`), `api/queries.ts`, `test/{rcaFixtures,server}.ts`, `ScorecardFrame.tsx` | T2a | 8124/5224 |
| T2b | 4 | `httpapi/{rca_explain,rca_view,rca_list,rca_budget_test}.go`, `rca_basis.go` (passes from T2a), `view.go`; deletes `rca_stubs_read.go` | T2a, T2c | 8123/5223 |
| T3 | 5 | `assistant/{rca_draft,links,runner,prompt}.go`, `domain/assistant.go`, `help/topics/rca.md`, `httpapi/{rca_draft,report_draft,assistant_threads,reports}.go`, `report/snapshot.go`, draft stores; deletes `rca_stubs_draft.go` | T2b | 8125/5225 |
| T5 | 5 | `TileFrame`, `MetricTile`, `ItemSummaryTile`, `AttentionCard`, `OverviewPage` (plumbing), `StatusBoard`, `logic/statusBoard`, `ItemGrid`, `ItemDrillIn`, `ItemMonths`, `FocusDialog`, `useDialogShortcuts`, `ui/status/{StatusCell,StatusCellTip,useGridNavigation}`, `test/viewFixtures.ts` | T4, T2b | 8126/5226 |
| T6 | 6 | `features/rca/{RcasPage,rcaReminder}`, `App.tsx`, `ControlBar`, `ReportPage`, `report/{model,ReportStatusList,pptx,pdf}`, `test/reportFixtures.ts`, `admin/{RecordTypesPage,adminModel}` | T3, T4 (and T5 for the final screenshots) | 8127/5227 |
| T7 | later | wizard incident detection, `TemplatesPage` fields, `CellDrawer` Why link, PDF annotations | T1, T6 | 8128/5228 |

## Final pass

After T6: a full-branch review against the spec, `make dev` screenshots of every mockup's surface at 1440 and 390 (compare with the mockups), `cd api && go test ./...` and the full web suite on `HEAD`, and the size budgets re-run against the merged tree.
