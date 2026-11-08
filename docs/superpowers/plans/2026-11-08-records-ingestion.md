# Records Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Program managers upload monthly tracker exports of defects and work units; OpsVision deduplicates them, derives measures by versioned rules, explains every change in plain language, and drills down from any cell to its records, ready for the December 2026 close.

**Architecture:** A pure Go package `internal/records` (record history, conditions, commitments, derivation, file parsing, column guessing) feeds `internal/recordimport` (import plan, recalculation, story), which materializes derived values as ordinary `records`-source data points so the existing engine, views, and overrides are unchanged. New store methods hold record types, records with revisions, and snapshots. The web app gets a drop-anywhere import with a story-first preview, a guided setup wizard, rule presets, and drill-down.

**Tech Stack:** Existing only: Go 1.27 (`encoding/csv`, `github.com/expr-lang/expr v1.17.8`, in-house `internal/xlsx`), React 19 + Tailwind 4 + Radix (pins in the phase 1 plan). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-records-ingestion-design.md` (extends `2026-10-30-opsvision-design.md`).

**Placement:** Tasks R1–R13 run after phase 1 Task 26c and before Task 27. Task 30's e2e gains the records flow (end of this plan).

## Global Constraints

- Everything in the phase 1 plan's Global Constraints applies (no first-adopter names anywhere; synthetic fixtures only; tenant from token; WCAG 2.2 AA; status never color-only).
- No new Go or npm dependencies. If one seems necessary, stop and vet it through the maintainer's dependency-vetting process before adding it.
- Fixtures use the Acme Demo products (Identity, Messaging, Checkout, Billing, Analytics, Pipelines, iOS App, Android App) and fictional keys (`CHK-`, `BIL-`, `ANL-`, `PAY-`).
- Dates are calendar dates, JSON `YYYY-MM-DD`; time zones ignored.
- Upload limits: 20 MiB per file; CSV max 200,000 rows and 500 columns.
- Records ingestion (inspect, preview, apply, record types, templates) is admin-only.
- UI copy uses plain language: "products and teams", "due date", "slipped", "upload"; never "subject", "source key", "revision", "snapshot" outside Advanced panels.
- UI is the existing `web/` stack (Tailwind + Radix). Run `ux-stack-router` at the start of each web task to confirm.
- Derived points are never written on parent org units, and recalculation never overwrites a data point whose source is not `records`.

## Review Focus

1. **The same export uploaded twice, or two overlapping exports:** zero revisions, zero data writes, "Nothing changed since your last upload". Test in R7 (`TestReuploadIsNoOp`, `TestOverlappingExportsDedupe`).
2. **The maintainer's slip example** (due 2026-12-15, re-planned to 2027-02-10, done 2027-02-08): December 0 of 1, February 1 of 1, discovered only from successive uploads. Tests in R2 (`TestCommitmentSlip`) and R3 (`TestCommitmentsAcrossMonths`).
3. **A number someone typed for a month that is now derived:** never overwritten by recalculation; shown as "entered (records give X)"; replaced only by "Use records for this month". Tests in R7 (`TestRecalcSkipsTypedSlots`, `TestUseRecordsOverridesTyped`) and R13.
4. **Messy export dates** (mixed formats in one column, `03/04/2026`, Excel serials, `Mar 2026`, blank "Resolved" on an open bug): parsed per row, asked once when ambiguous, never silently wrong. Tests in R5 (`TestDateFormats`) and R6 (`TestAmbiguousDateDetected`).
5. **Cross-tenant identifiers** (upload, import, record type, template, contributions query from tenant B): 404 and no data. Tests in R8 (`TestCrossTenantRecordImport`, `TestCrossTenantContributions`).

---

### Task R1: Record domain types, derived-measure fields, contract

**Files:**
- Create: `api/internal/domain/records.go`, `api/internal/domain/records_test.go`
- Modify: `api/internal/domain/methodology.go` (Measure), `api/internal/domain/data.go` (`SourceRecords`, `DataPoint.Deleted`), `api/internal/domain/validate.go`, `openapi/openapi.yaml` (Measure, RecordType, Date schemas), regenerate (`make gen`)

**Interfaces:**
- Produces (in `domain`):
  - `type Date struct{ time.Time }` (UTC midnight), `func ParseDate(s string) (Date, error)`, JSON `"YYYY-MM-DD"`, `func (d Date) Before(o Date) bool`, `func (d Date) AddDays(n int) Date`.
  - `type RecordState string` = `StateOpen "open"`, `StateDone "done"`, `StateCancelled "cancelled"`.
  - `type AttrType string` = `string|number|bool|date`; `type AttributeDef struct{ Key, Name string; Type AttrType }`.
  - `type RecordType struct{ ID, Name string; Priorities []string; Attributes []AttributeDef; TrackedFrom map[string]period.Period; Revision int }` (`TrackedFrom` keyed by source; `none` is always an implicit priority).
  - `type RecordFields struct{ SubjectKey, Title, Category, Priority, Status, URL string; State RecordState; CreatedAt Date; CommittedAt, DueAt, CompletedAt, MeasuredAt *Date; PriorDueDates []Date; Planned, Actual, ExpectedValue, DeliveredValue *float64; Attributes map[string]any }`
  - `type RecordRevision struct{ AsOf Date; SnapshotID string; Fields RecordFields }`
  - `type Record struct{ Source, ExternalID, Type string; Revisions []RecordRevision }` (revisions sorted by AsOf).
  - `type Snapshot struct{ ID, RecordType, Source, TemplateID string; TemplateRevision int; AsOf Date; FileName, CreatedBy string; CreatedAt time.Time; Counts map[string]int }`
  - `type DeriveOp string` = `count|sum|daily_open_weighted|commitments|days_in_period|age_sum`.
  - `type DeriveRule struct{ RecordType string; Op DeriveOp; BucketBy, Field, Where, Outcome, AgeFrom, AgeTo string; Weights map[string]float64 }` (`Outcome` ∈ `resolved|met`).
  - `Measure` gains `Source string \`json:"source,omitempty"\`` (`""`/`"entered"` or `"derived"`) and `Derive *DeriveRule \`json:"derive,omitempty"\``.
  - `const SourceRecords = "records"` (added to `ValidSource`); `DataPoint.Deleted bool \`json:"deleted,omitempty"\`` (history tombstones only).
  - `func (rt RecordType) Validate() []ValidationError`; `func ValidateDerive(m Methodology, types []RecordType) []ValidationError` (structure only; condition compile is R2).
  - Date fields usable in `BucketBy`, `AgeFrom`, `AgeTo`: `createdAt, committedAt, dueAt, completedAt, measuredAt` or a `date` attribute key.

- [ ] **Step 1: Write failing tests:** `TestDateJSONRoundTrip` (`"2026-09-03"`), `TestRecordTypeValidate` (empty/duplicate priorities, bad attribute key, unknown attr type), `TestDerivedMeasureNeedsRule` (`source: derived` without `derive` → error at `measures[i].derive`), `TestEnteredMeasureRejectsDerive`, `TestDeriveOpParams` (`sum` needs `field` of a number field or number attribute; `daily_open_weighted` needs a weight for every priority of the record type plus `none`; `commitments` needs `outcome` resolved|met; `count`/`sum`/`age_sum` need a date `bucketBy`; `age_sum` needs `ageFrom`), `TestDeriveUnknownRecordType`, `TestSourceRecordsValid`.
- [ ] **Step 2:** Run `cd api && go test ./internal/domain/` — FAIL. **Step 3:** Implement; add schemas to `openapi/openapi.yaml`; `make gen`. **Step 4:** `go test ./internal/domain/ ./internal/httpapi/` and `make gen-check` — PASS.
- [ ] **Step 5: Commit** `feat(domain): record types, records, and derived measures`.

### Task R2: Record history, conditions, commitments

**Files:**
- Create: `api/internal/records/{history.go,cond.go,commit.go,history_test.go,cond_test.go,commit_test.go}`

**Interfaces:**
- Consumes: R1 types.
- Produces (package `records`):
  - `func Latest(r domain.Record) domain.RecordFields`
  - `func FieldsOn(r domain.Record, day domain.Date) domain.RecordFields` — revision with the latest `AsOf` ≤ day; before the first, the earliest.
  - `type Cond struct{ /* compiled program */ }`; `func CompileWhere(src string, rt domain.RecordType) (*Cond, error)`; `func (c *Cond) Match(f domain.RecordFields) (bool, error)`. Empty `src` matches everything. Env: every `RecordFields` field by its JSON name plus each attribute key (missing attribute = zero value of its type); dates are `time.Time`; `in [...]`, comparisons, `&&`, `||`, `!` allowed; no function calls; max 1,000 characters; must return bool (checked at compile with `expr.AsBool()` and a typed env).
  - `type Outcome string` = `met|missed|pending|dropped`; `type Commitment struct{ Due domain.Date; Outcome Outcome; Slipped bool }`
  - `func Commitments(r domain.Record, cutoff domain.Date) []Commitment`

Commitment list = `Latest(r).PriorDueDates` then each `DueAt` across revisions in AsOf order, consecutive duplicates removed. Walk it: if the record is done and `CompletedAt` ≤ this date → `met`, stop. Else if a next date exists: next later → `missed` with `Slipped`; next earlier → no entry (pull-in), continue. Else (last date): cancelled with `CompletedAt` ≤ date → `dropped`; date ≤ cutoff (not met) → `missed`; otherwise → `pending`.

- [ ] **Step 1: Write failing tests:** `TestCommitmentSlip` (revisions: AsOf 2026-11-30 due 2026-12-15 open; AsOf 2027-01-05 due 2027-02-10 open; AsOf 2027-02-28 done 2027-02-08 → `[missed 2026-12-15 slipped, met 2027-02-10]`), `TestCommitmentLateNoReplan` (due 2026-12-31, done 2027-01-01 → one `missed`), `TestPullInNoDing` (due 02-10 then 01-20, done 01-15 → one `met` on 01-20), `TestCancelledBeforeDueDrops`, `TestCancelledAfterSlipKeepsMiss`, `TestPendingBeforeCutoff`, `TestPriorDueDatesPrepended`, `TestFieldsOnBeforeFirstSnapshot`, `TestFieldsOnPriorityByDay`, `TestWhereCompileErrors` (unknown field, `priority > 3` type mismatch, function call, non-bool result — each a clear message), `TestWhereAttributes` (`customerTicket && category in ['bug','defect']`), `TestWhereDates` (`completedAt <= dueAt`, nil date never matches a comparison).
- [ ] **Step 2:** `go test ./internal/records/` — FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(records): history, conditions, commitments`.

### Task R3: Derivation

**Files:**
- Create: `api/internal/records/{derive.go,subjects.go,derive_test.go}`

**Interfaces:**
- Consumes: R2; `orgtree.Tree`, `period.Calendar`.
- Produces:
  - `type DeriveInput struct{ Cal period.Calendar; Tree *orgtree.Tree; Items []domain.TrackedItem; Types []domain.RecordType; Records []domain.Record; LatestAsOf map[string]domain.Date /* record type -> latest snapshot as-of */ }`
  - `func ResolveSubject(in DeriveInput, key string, month period.Period) (subjectID string, problem string)` — `problem` ∈ `""|"unmatched"|"parent"|"ambiguous"`; matches org-unit and item `SourceKeys` case-insensitively after trimming; a unit with children in `month` → `parent`.
  - `type Contribution struct{ Source, ExternalID, Title, URL, Priority string; State domain.RecordState; Amount float64; Reason string; Dates map[string]domain.Date }` — `Reason` ∈ `matched|met|missed|slipped|pending|open_days|age_days`.
  - `type Derived struct{ MeasureKey, SubjectID string; Period period.Period; Value float64; Cutoff domain.Date; Pending int; Contributions []Contribution }`
  - `func Derive(in DeriveInput, m domain.Measure, periods []period.Period) ([]Derived, error)`

Rules (spec §8): a record belongs to the subject `ResolveSubject` returns for the month of its bucket date (for `daily_open_weighted`, each day's month); unresolved records are skipped. Values exist only for leaf units and items that have at least one source key, from the record type's earliest `TrackedFrom` month, for periods starting on or before `LatestAsOf[type]`; `0` when nothing matches. Cutoff = min(period end, `LatestAsOf[type]`). `daily_open_weighted` sums `Weights[priority]` per day ≤ cutoff where open (`CreatedAt` ≤ day and (`CompletedAt` nil or `CompletedAt` > day)) and `where` matches `FieldsOn(day)`; Amount per record = its points in the period. `days_in_period` = days through cutoff. `commitments` counts commitments whose `Due` is in the period: `resolved` = met + missed, `met` = met; `Pending` counts pending ones. Other ops read `Latest`.

- [ ] **Step 1: Write failing tests:** `TestDefectExample100PerDay` (1 P1, 1 P2, 5 P3 open all of a 30-day month, weights 64/16/4/2/1 → `defect_points_sum` 3000, `defect_days` 30), `TestDailyPriorityChange`, `TestCutoffMidMonth` (latest as-of 2026-11-14 → days 14, "through" cutoff 2026-11-14), `TestPeriodAfterLatestSnapshotAbsent`, `TestCountBucket`, `TestSumPlanned`, `TestAgeSum` (open idea ages to cutoff), `TestCommitmentsAcrossMonths` (slip example: 2026-12 resolved 1 met 0; 2027-02 resolved 1 met 1), `TestPendingCount`, `TestNoSourceKeyIsAbsent`, `TestZeroWhenTracked`, `TestBeforeTrackedFromAbsent`, `TestParentMatchSkipped`, `TestQuarterGrainBuckets`, `TestContributionsListed` (IDs, reasons, amounts).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `go test -bench Derive ./internal/records/` with 50,000 records and 8 subjects over 12 months completes under 2 s.
- [ ] **Step 5: Commit** `feat(records): derive measures from records`.

### Task R4: Record store and data-point deletes

**Files:**
- Modify: `api/internal/store/store.go`, `api/internal/store/memstore/memstore.go`, `api/internal/store/dynamostore/{keys.go,keys_test.go,dynamostore.go,items.go}`, `api/internal/store/storetest/suite.go`
- Create: `api/internal/store/dynamostore/records.go`

**Interfaces:**
- Produces:
  - `type RecordRevisionWrite struct{ Source, ExternalID, Type string; Rev domain.RecordRevision }`
  - `type RecordStore interface { PutRecordType(ctx, tenantID string, rt domain.RecordType, expectedRevision int) error; ListRecordTypes(ctx, tenantID string) ([]domain.RecordType, error); ApplySnapshot(ctx, tenantID string, s domain.Snapshot, revs []RecordRevisionWrite) error; ListRecords(ctx, tenantID, recordType string) ([]domain.Record, error); ListSnapshots(ctx, tenantID, recordType string) ([]domain.Snapshot, error) }` added to `Store`.
  - `PutRecordType` follows `PutVersion` revision semantics. `ApplySnapshot` with an existing snapshot ID → `ErrConflict`; re-running after a partial failure with a new ID is safe (revision keys are deterministic, see below). `ListRecords` returns records sorted by Source, ExternalID, revisions by AsOf. `ListSnapshots` newest AsOf first.
  - `DataWrite.Delete bool`: removes the current point; `History` gains a tombstone revision (`Deleted: true`, `Source: records`).
  - `store.Template` gains `Revision int` (incremented on every `PutTemplate`) and `LastUsed *time.Time` (set by R8 on apply); `domain.Snapshot.TemplateRevision` records the revision used.
  - Dynamo keys: record type `RTYPE#<id>` and snapshot `SNAP#<type>#<id>` in the tenant partition; revisions in partition `T#<tid>#REC#<type>` with SK `R#<esc(source)>#<esc(externalId)>#<asOf>` where `esc` is `url.PathEscape` (external IDs may contain `#`). Pin all in `keys_test.go`.

- [ ] **Step 1: Write failing contract tests** in `storetest`: `TemplateRevisionIncrements`, `RecordTypeRevision`, `ApplySnapshotGroupsRevisions`, `ApplySnapshotDuplicateIDConflict`, `SnapshotsNewestFirst`, `RecordsCrossTenant` (tenant B sees none), `ExternalIDWithHash`, `DeleteDataPoint` (gone from `ListData`, tombstone in `History`). Key tests for the new layouts.
- [ ] **Step 2:** `go test ./internal/store/...` — FAIL. **Step 3:** Implement in memstore and dynamostore. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(store): record types, records, snapshots, data-point deletes`.

### Task R5: Records templates and file parsing

**Files:**
- Create: `api/internal/records/{template.go,table.go,values.go,normalize.go,template_test.go,table_test.go,values_test.go,normalize_test.go}`, `api/internal/records/testdata/{defects.csv,epics.csv,epics_dec.xlsx}` (synthetic; the xlsx generated by `xlsxtest.Build` in a test helper and committed)

**Interfaces:**
- Produces:
  - `type FieldMap struct{ Column, Constant, Template, Default, Separator, Transform string; Map map[string]string; DateFormats []string }` (JSON per spec §6; `Map["*"]` is the fallback).
  - `type FileSpec struct{ Format, Sheet string; HeaderRow int }`; `type SkipRule struct{ Column string; In []string }`
  - `type Template struct{ Name, RecordType, Source string; File FileSpec; FullExport bool; Fields map[string]FieldMap; Attributes map[string]FieldMap; SkipRows []SkipRule }`; `func (t Template) Validate(rt domain.RecordType) []domain.ValidationError` (required: `externalId`, `subjectKey`, `state`, `createdAt`; unknown field or attribute → error).
  - `type Table struct{ Headers []string; Rows [][]string; RowNums []int; Format string }`; `func ReadCSV(r io.Reader) (Table, error)` (BOM stripped; delimiter sniffed among `,` `;` tab; limits from Global Constraints); `func ReadSheet(wb *xlsx.Workbook, sheet string, headerRow int) (Table, error)`.
  - `func ParseDate(s string, formats []string, allowSerial bool) (domain.Date, error)` — tries formats in order, then ISO `2006-01-02`, then month-only (`2006-01`, `Jan 2006`, `January 2006` → first of month), then xlsx serial when `allowSerial`; date-times truncate to the written date.
  - `func ParseNumber(s string) (float64, error)` — same accepted forms as `web/src/features/entry/pasteParser.ts`.
  - `type Row struct{ RowNum int; Source, ExternalID, Type string; Fields domain.RecordFields }`
  - `type RowProblem struct{ RowNum int; Kind, Column, Field, Value, Message string }` — `Kind` ∈ `error|unmapped_value|duplicate_id`.
  - `func Normalize(t Template, rt domain.RecordType, tbl Table) (rows []Row, skipped int, problems []RowProblem)` — rows with an `error` problem are excluded; `unmapped_value` rows are excluded until answered; duplicate IDs exclude both rows.

- [ ] **Step 1: Write failing tests:** `TestCSVDelimiterAndBOM`, `TestCSVLimits`, `TestNormalizeDefectsFixture` (row count, `Highest`→P1, `Won't Do`→cancelled, `Linked tickets` non-empty → `customerTicket` true), `TestValueMapFallback`, `TestUnmappedValueProblem` (names the value and column), `TestDateFormats` (two formats in one column; `2026-03` and `Mar 2026` → 2026-03-01; serial `46023` → 2026-01-01 for xlsx only; `2026-09-03 14:22` → 2026-09-03; blank `Resolved` on an open row OK), `TestNumberForms` (`1,234`, `$10k`, `84%`), `TestPriorDueDatesSeparator`, `TestSkipRows`, `TestDuplicateIDsInFile`, `TestDoneNeedsCompletedAt`, `TestTemplateValidate`, `TestReadSheetFixture`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(records): templates and CSV/xlsx parsing`.

### Task R6: Inspect, guess, recognize

**Files:**
- Create: `api/internal/records/{guess.go,match.go,guess_test.go,match_test.go}`

**Interfaces:**
- Produces:
  - `type ColumnGuess struct{ Field, Column string; Confidence float64; Samples []string }`
  - `type ValueCount struct{ Value string; Count int; Suggested string }`
  - `type SavedTemplate struct{ ID string; Revision int; LastUsed *time.Time; T Template }`
  - `type Inspection struct{ Headers []string; RowCount int; Samples [][]string; SuggestedType string; Guesses []ColumnGuess; Values map[string][]ValueCount; DateFormats map[string][]string; AmbiguousDates []string; Draft Template; MatchedTemplateID string; Added, Missing []string }`
  - `func Inspect(tbl Table, types []domain.RecordType, saved []SavedTemplate) Inspection`
  - `type SubjectSuggestion struct{ Value string; Rows int; SubjectID string; Score float64; Candidates []string }`
  - `func SuggestSubjects(values map[string]int, units []domain.OrgUnit, items []domain.TrackedItem) []SubjectSuggestion`

Header synonyms (case- and punctuation-insensitive): externalId ← `issue key, key, id, issue id, ticket`; title ← `summary, title, name`; subjectKey ← `product, component, components, team, project, application`; category ← `issue type, type, category`; priority ← `priority, severity`; status ← `status`; createdAt ← `created, created date, opened, submitted`; completedAt ← `resolved, resolution date, done date, closed, completed`; dueAt ← `due date, due, target date, end date`; committedAt ← `committed, commit date, planned start`; url ← `url, link`. Content rules: a column whose non-empty values are all unique and non-date → externalId candidate; ≥ 90% parseable as dates → date candidate. Value suggestions: `highest, critical, blocker, p1, urgent` → P1; `high, major, p2` → P2; `medium, normal, p3` → P3; `low, minor, p4` → P4; `lowest, trivial, none, ""` → none (only priorities the record type has); state: `done, closed, resolved, complete, completed, released` → done; `won't do, wont do, cancelled, canceled, duplicate, rejected, obsolete` → cancelled; else open. A column is ambiguous when every value is `NN/NN/YYYY` with both parts ≤ 12. Recognition: the saved template with the most referenced columns, all present in the headers; `Added`/`Missing` against it. Fuzzy subject match: normalized (lowercase, strip punctuation and the words `svc, service, team, app`) exact match scores 1.0; otherwise token overlap (Jaccard) ≥ 0.5; candidates top 3. `SuggestedType`: `priority` + `completedAt` guesses → a record type with priorities; `dueAt` guess → a type without.

- [ ] **Step 1: Write failing tests:** `TestGuessTrackerHeaders` (defects fixture: each field mapped, confidence ≥ 0.9, three samples), `TestGuessByContent`, `TestSuggestPriorityValues`, `TestStateSuggestions`, `TestAmbiguousDateDetected`, `TestRecognizeSavedTemplate`, `TestHeaderDiff`, `TestFuzzySubject` (`Checkout Svc` → Checkout, `Pipelines team` → Pipelines, `Platform` unit with children still suggested but flagged in R7), `TestSuggestedType`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(records): column guessing, value suggestions, template recognition`.

### Task R7: Import plan, recalculation, story

**Files:**
- Create: `api/internal/recordimport/{plan.go,recalc.go,story.go,plan_test.go,recalc_test.go,story_test.go}`

**Interfaces:**
- Consumes: R3–R6; `importer.LoadInput`, `engine.Compute`.
- Produces:
  - `type CellRef struct{ MeasureKey, SubjectID string; Period period.Period }`
  - `type Answers struct{ SourceKeys map[string]string; IgnoreValues []string; ValueMaps map[string]map[string]string; DateOrder string /* "mdy"|"dmy"|"" */; UseRecords []CellRef; MarkMissingCancelled bool; CreateShared []string }`
  - `type Counts struct{ New, Changed, Unchanged, Skipped, Missing, Unmatched, Errors int }`
  - `type StoryLine struct{ Period period.Period; MetricKey, MetricName, SubjectID, SubjectName, BeforeDisplay, AfterDisplay, BeforeStatus, AfterStatus string; Reasons map[string][]records.Contribution }`
  - `type TypedVsRecords struct{ CellRef; Typed float64; TypedSource string; Records float64; Contributions []records.Contribution }`
  - `type Story struct{ NothingChanged bool; Lines []StoryLine; More int; Typed []TypedVsRecords; LockedWaiting []StoryLine }`
  - `type ParentMatch struct{ Value string; Rows int; UnitID string }`
  - `type Plan struct{ Snapshot domain.Snapshot; Revisions []store.RecordRevisionWrite; Counts Counts; Problems []records.RowProblem; Unmatched []records.SubjectSuggestion; Parents []ParentMatch; NewValues map[string][]records.ValueCount; Missing []string; Writes []store.DataWrite; Story Story }`
  - `func Build(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, t records.Template, tbl records.Table, asOf domain.Date, ans Answers, draft *domain.MethodologyVersion) (Plan, error)` — `draft`, when set, is evaluated in place of the version in force (wizard preview).
  - `func Apply(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, p Plan, ans Answers, actor string) error` — in order: shared units (`<Parent name> (shared)` child of each `CreateShared` unit, source key moved from the parent), source keys from `ans.SourceKeys`, snapshot + revisions, data writes; one audit entry `records.import` with counts.
  - `func Recalculate(ctx context.Context, st store.Store, tenant domain.Tenant, scorecardID string, locked func(period.Period) bool, use []CellRef) ([]store.DataWrite, error)` — derives each period under the methodology version in force for it (`engine.VersionFor`), for every derived measure for months from the earliest tracked-from through the latest snapshot month (plus coarser grains containing them), skipping `locked` periods; writes changed `records` points with `ExpectedRevision Unconditional`, deletes `records` points no longer derived, skips slots whose current point source is not `records` unless listed in `use`. Phase 1 passes `locked` = always false.

Story: metric cells before/after via `engine.Compute` on the current input vs input + `Writes`, only metrics whose formulas reference changed measures; lines ordered by status-rank change (worse first), then absolute value change; at most 50 lines (`More` = rest). Reasons come from per-record contribution diffs for that cell: `slipped`, `met`, `missed`, `newly_open`, `closed`, `priority_changed`, `added`, `removed`. `NothingChanged` when there are no revisions and no writes.

- [ ] **Step 1: Write failing tests** (memstore, Acme-like fixture tenant): `TestReuploadIsNoOp`, `TestOverlappingExportsDedupe`, `TestChangedRowNewRevision`, `TestOutOfOrderSnapshot`, `TestRecalcSkipsTypedSlots`, `TestUseRecordsOverridesTyped`, `TestDeleteWhenNoLongerDerived`, `TestStorySlippedEpics` (three epics slip in October for Checkout → one line for on-time delivery with `slipped` reasons listing the three IDs, status change shown), `TestTypedVsRecords` (typed 48/66 vs records 47/66 → entry with the 66 committed contributions), `TestUnmatchedNotStored`, `TestParentMatchReported`, `TestCreateSharedUnit`, `TestAnswersSaveSourceKeys`, `TestMissingFullExportCancel`, `TestDraftPreview`.
- [ ] **Step 2:** `go test ./internal/recordimport/` — FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(records): import plan, recalculation, and story preview`.

### Task R8: Records API

**Files:**
- Create: `api/internal/httpapi/{records.go,records_test.go}`
- Modify: `openapi/openapi.yaml`, `api/internal/httpapi/imports.go` (CSV uploads, `records` profile), `api/internal/httpapi/methodology.go` (`PublishVersion` recalculates; validate compiles `where`), `api/internal/httpapi/{org.go,items.go}` (unique source keys), `api/internal/httpapi/load.go` (restatement re-derivation), regenerate

**Interfaces:**
- Consumes: R4–R7.
- Produces (all under `/v1`, admin-only unless noted):
  - `GET /record-types` (any member), `PUT /record-types/{id}` (body RecordType with `revision`; 409 on stale).
  - `POST /imports/uploads` accepts `contentType` `text/csv` as well as xlsx; object key extension follows the type.
  - `POST /imports/{id}/inspect` → `{inspection, subjects: SubjectSuggestion[]}`.
  - `POST /imports/{id}/records-preview` body `{scorecardId, asOf, templateId? , template?, answers, draftVersionId?}` → `{counts, story, problems, unmatched, parents, newValues, missing}`; stores the plan on the import (status `parsed`, profile `records`).
  - `POST /imports/{id}/apply` for profile `records`: body `{answers, saveTemplate?: {id, name}}`; answers must equal those of the stored preview (else 409 "preview is out of date"); applying twice → 409; saves the template (value maps merged) when `saveTemplate` is set.
  - `POST /scorecards/{sc}/records/sample` body `{recordType, where, bucketBy, period}` → `{total, bySubject: [{subjectId, name, count}]}`; compile error → 400 with `path: "where"`.
  - `GET /scorecards/{sc}/records/contributions?metric=&subject=&period=&cursor=` (any member with `data:read` on the subject) → `{measures: [{measureKey, value, source, recordsValue, cutoff, pending, records: Contribution[]}], nextCursor}`; 100 per page; rolled-up subjects list contributions from all leaf subjects in scope.
  - Template profile `records` validated with `records.Template.Validate`.
  - `PublishVersion` response gains `recalculated int`.
  - Source keys are unique per tenant across org units and tracked items (case-insensitive): `PUT` of a unit or item reusing another's key → 409 naming the holder (`org.go`, `items.go`).
  - Restatement: when the view has `restate=<version>`, `loadInput` replaces `records`-source points for that version's derived measures with `records.Derive` under the restate version, in memory only.

- [ ] **Step 1: Write failing tests:** `TestRecordsUploadInspectPreviewApply` (CSV fixture end to end; view then shows derived values), `TestRecordsApplyTwiceConflict`, `TestRecordsApplyStalePreview409`, `TestContributorCannotApplyRecords` → 403, `TestCrossTenantRecordImport` → 404, `TestCrossTenantContributions` → 404, `TestContributionsRespectScope`, `TestSampleWhereError400`, `TestPublishRecalculates`, `TestCSVTooLarge` → 413, `TestValidateDerivedMeasure` (bad `where` → error at `measures[i].derive.where`), `TestRecordTypeStaleRevision409`, `TestDuplicateSourceKeyRejected`, `TestRestateRederives` (different weights in the restate version change the defect score; stored points unchanged).
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `make gen`. **Step 4:** `go test ./...` and `make gen-check` — PASS.
- [ ] **Step 5: Commit** `feat(api): records import, record types, sample, contributions`.

### Task R9: Demo records and fixtures

**Files:**
- Modify: `api/internal/demo/seed.go`, `api/internal/demo/seed_test.go`
- Create: `api/internal/demo/testdata/{acme_defects_nov.csv,acme_epics_nov.csv}`

**Interfaces:**
- Produces: Acme Demo record types `defect` (priorities P1–P4, attribute `customerTicket` bool) and `epic`; tracked from `2026-M07` for source `tracker`; synthetic records with monthly snapshots dated each month end July–October 2026 for all eight products; published version `2026 v2` effective `2026-M07` in which `epics_committed`, `epics_on_time` (commitments) and `defect_points_sum`, `defect_days` (daily open weighted, weights 64/16/4/2/1, `category in ['bug','defect']`) are derived; the seed writes no entered values for those measures from `2026-M07`. The November CSVs (as-of 2026-11-14) include three Checkout epics that slip and one new P1 defect, for the e2e and manual rehearsal.

- [ ] **Step 1: Write failing tests:** `TestSeedComputes` still passes (every row has a status or NA reason for `2026-M10`); `TestSeedDerivedMonths` (derived points exist for 2026-M07..M10 with source `records`; June values remain entered); `TestNovemberFixturePreview` (preview of both CSVs reports the three slipped epics and `through 2026-11-14`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `make dev` shows derived months in the Table tab.
- [ ] **Step 5: Commit** `feat(demo): synthetic records and derived measures`.

### Task R10: Web — drop-anywhere import and story preview

**Files:**
- Create: `web/src/features/import/{RecordsImport.tsx,DropZone.tsx,StoryPreview.tsx,NeedsInput.tsx,recordsModel.ts,RecordsImport.test.tsx,recordsModel.test.ts}`
- Modify: `web/src/features/admin/ImportPage.tsx` (two kinds: "Records" first, "Legacy workbook"), `web/src/features/scorecard/ScorecardPage.tsx` ("Upload records" button; page-level drop for admins), `web/src/api/queries.ts` (`useRecordTypes`, `useInspect`, `useRecordsPreview`, `useApplyRecords`)

**Interfaces:**
- Consumes: R8 endpoints.
- Produces: `DropZone({onFiles, multiple})` (native drag and drop plus a "Choose files" button; accepts .csv and .xlsx; rejects others and >20 MiB with a message); per-file flow: upload → inspect → if `matchedTemplateId`, preview with that template, else hand off to the setup wizard (R11) via `onNeedsSetup(file, inspection)`. `StoryPreview` renders, in order: the as-of date (default today, editable; changing it re-runs the preview), the recognition line ("Looks like your *Defects export*: 1,204 rows, 37 changed since your October 31 upload."), changes by metric (each line a disclosure listing records with links and reason labels: "slipped", "delivered on time", "newly open P1"), "Your typed numbers vs records" with "Use records for this month" checkboxes, "Needs your input" (`NeedsInput`: product pickers with fuzzy suggestion preselected, "Ignore these rows", "Create '<Segment> (shared)'", new-value selects, one date-order question), row problems table (row, column, message), counts last. Answers re-run the preview (debounced 300 ms). "Nothing changed since your last upload" replaces the Apply button. One "Apply" applies every ready file in order and shows a toast-free inline summary.

- [ ] **Step 1: Write failing tests** (MSW): dropping two files shows two previews; recognition line text; `NothingChanged` hides Apply; expanding a story line lists the three slipped epic IDs as links; picking a product for an unmatched value re-requests with `answers.sourceKeys`; new value select sets `answers.valueMaps`; "Use records for this month" adds to `answers.useRecords`; Apply posts answers and `saveTemplate` for new templates; "Choose files" works by keyboard; non-admin sees no "Upload records"; `axe` no violations.
- [ ] **Step 2:** `npm test` FAIL. **Step 3:** Implement. **Step 4:** `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` PASS.
- [ ] **Step 5: Commit** `feat(web): drop-anywhere records import with story preview`.

### Task R11: Web — guided setup wizard

**Files:**
- Create: `web/src/features/import/setup/{SetupWizard.tsx,StepType.tsx,StepColumns.tsx,StepValues.tsx,StepProducts.tsx,StepCalculate.tsx,wizardModel.ts,SetupWizard.test.tsx,wizardModel.test.ts}`

**Interfaces:**
- Consumes: R8 (`inspect`, `records-preview` with inline `template` and `draftVersionId`, `PUT /record-types`), R10 `StoryPreview`, existing `PublishDialog`, R12 `presets.ts`.
- Produces: full-page wizard at `/admin/import/setup?step=type|columns|values|products|calculate|preview` with a step indicator ("Step 2 of 6: Columns"), Back/Next, unsaved-progress guard. `wizardModel.ts`: `type WizardState`, `function templateFrom(state): RecordsTemplate`, `function answersFrom(state): Answers`. Steps per spec §7.1: type (suggested type preselected; "New type" inline with name and priorities from the file's values); columns (each field: dropdown of headers, confidence chip "Likely"/"Check this", three sample values); values (distinct values with counts and suggested mapping; ambiguous date question "Is 03/04/2026 March 4 or April 3?"); products (suggestions preselected; picker; ignore; create shared); calculate (presets for the record type, preselected where the methodology has matching measure keys, each with its one-sentence explanation; creates them in a draft via `applyPreset`); preview (`StoryPreview` against the draft); Apply saves record type, template, answers; then "Publish now" opens `PublishDialog` with `effectiveFrom` = tracked-from month.

- [ ] **Step 1: Write failing tests:** guesses prefilled with samples; changing a column updates samples; "Check this" shown below 0.7 confidence; the ambiguous-date question appears once and sets `dateOrder`; values step shows counts and suggested P1–P4; products step preselects `Checkout Svc` → Checkout; calculate step preselects "On-time delivery" when `epics_committed` exists; Back keeps edits; Apply sends `saveTemplate`; "Publish now" opens the dialog with the tracked-from month; `templateFrom`/`answersFrom` unit tests; `axe` no violations on every step.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** test, lint, typecheck, build PASS.
- [ ] **Step 5: Commit** `feat(web): guided records setup wizard`.

### Task R12: Web — rule presets, condition builder, record types, templates

**Files:**
- Create: `web/src/features/admin/{presets.ts,presets.test.ts,DeriveEditor.tsx,ConditionBuilder.tsx,conditionModel.ts,conditionModel.test.ts,RecordTypesPage.tsx,TemplatesPage.tsx,DeriveEditor.test.tsx,RecordTypesPage.test.tsx}`
- Modify: `web/src/features/admin/DraftEditor.tsx` (measure rows show Source; derived rows open `DeriveEditor`), `web/src/App.tsx` and `web/src/shell/AppShell.tsx` (routes and admin nav "Record types", "Templates")

**Interfaces:**
- Produces:
  - `type PresetId = 'on_time' | 'weighted_open' | 'within_budget' | 'expected_value' | 'average_age' | 'count' | 'sum'`; `function applyPreset(content: Methodology, id: PresetId, params: PresetParams): { content: Methodology; created: string[] }` creating exactly the measures, formulas, directions, and default bands in spec §8.1 (keys prefixed by the record type key; existing keys reused, not duplicated).
  - `type ConditionRow = { field: string; op: 'is' | 'is_not' | 'one_of' | 'before' | 'after' | 'on_or_before' | 'on_or_after' | 'greater' | 'less' | 'is_empty' | 'not_empty'; value?: string | string[] | boolean }`; `function toWhere(rows: ConditionRow[]): string`; `function fromWhere(src: string): ConditionRow[] | null` (null → Advanced only).
  - `DeriveEditor`: preset picker, blanks for the preset, `ConditionBuilder` with value pickers from `records/sample`, live sample "Last month this matches 212 records (Checkout 41, Billing 18, …)", Advanced (raw `where` and derive JSON, validated by the methodology validate endpoint).
  - `RecordTypesPage`: list, add, edit name, priorities (ordered), attributes, tracked-from month per source. `TemplatesPage`: list with last used; "Edit mapping" opens the wizard at `step=columns` with the template and a sample from its last upload; Advanced JSON.

- [ ] **Step 1: Write failing tests:** each preset produces the spec §8.1 keys, formula, direction, and bands; `toWhere`/`fromWhere` round trip for every operator and `fromWhere` returns null for `a || b`; the live sample text renders from the MSW response; Advanced edit with a bad expression shows the server error under the field; record type priority reorder PUTs with revision; "Edit mapping" navigates to the wizard; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** test, lint, typecheck, build PASS.
- [ ] **Step 5: Commit** `feat(web): derived-measure presets, condition builder, record types, templates`.

### Task R13: Web — drill-down in the cell drawer

**Files:**
- Modify: `web/src/features/scorecard/{CellDrawer.tsx,CellDrawer.test.tsx,TableTab.tsx}`, `web/src/api/queries.ts` (`useContributions`)

**Interfaces:**
- Consumes: `GET /records/contributions`.
- Produces: in the drawer for a derived cell, a "Derived from N records" section per measure (table: ID linked to `url`, title, priority, state, the dates the rule used, contribution when not 1; "Load more" for pages), "Through Nov 14" for cells cut off before period end, "2 still due this month" for pending commitments, and "Entered · records give 47 / 66" when a typed value wins. Table cells with a cutoff before period end carry a visually hidden "month to date through <date>" in their accessible name.

- [ ] **Step 1: Write failing tests:** drawer lists records with links and contributions; "Load more" requests `cursor`; "Through Nov 14" and "2 still due this month" render; typed-wins note renders; a non-derived cell shows no records section; the table cell accessible name includes the through date; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** test, lint, typecheck, build PASS.
- [ ] **Step 5: Commit** `feat(web): drill down from a cell to its records`.

### Amendment to phase 1 Task 30 (end-to-end smoke)

Add to `web/e2e/smoke.spec.ts`: as `admin@demo.test`, drop `api/internal/demo/testdata/acme_epics_nov.csv` and `acme_defects_nov.csv` on the Import page; both are recognized; the story shows three slipped Checkout epics; apply; the Table tab for `2026-M11` shows Checkout on-time with "Through Nov 14" in the drawer and the three epic IDs in its records list. Also run the setup wizard once with a renamed-headers copy of the defects CSV generated in the test (columns guessed, products matched, preview shown). `@axe-core/playwright` covers the Import page, each wizard step, and the drawer with records.
