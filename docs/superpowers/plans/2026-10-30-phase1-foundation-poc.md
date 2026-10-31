# OpsVision Phase 1 — Foundation + POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable OpsVision with tenants, org units, a versioned metric framework and engine, data entry, Charts and Table views, and a legacy-workbook importer, so the program management team can review real history in a private environment by about 2026-11-20.

**Architecture:** Go mono-repo backend (`api/`) with a pure metric engine, a store interface with in-memory and DynamoDB implementations, and an OpenAPI-first HTTP API served from one Lambda behind API Gateway. React SPA (`web/`) on S3 + CloudFront using a TypeScript client generated from the same contract. CloudFormation/SAM for all AWS resources; Auth0 Organizations for tenants.

**Tech Stack:** Go 1.27, aws-lambda-go, AWS SDK for Go v2 (DynamoDB, S3), go-jwt-middleware v3, expr, oapi-codegen; React 19, Vite 8, TypeScript 5.9, Tailwind 4, Radix UI, Recharts 3, TanStack Query, react-router 7, Auth0 React SDK; Vitest, Testing Library, MSW, vitest-axe, Playwright; AWS SAM CLI; Auth0 Deploy CLI.

**Spec:** `docs/superpowers/specs/2026-10-30-opsvision-design.md`

## Global Constraints

- No company names from the first adopter anywhere: code, docs, fixtures, test data, commit messages. All fixtures are synthetic. The real workbook and its mapping template are never committed.
- Go module path is `opsvision` (`api/go.mod`), `go 1.27`. Node 26 for `web/` and tooling.
- Lambda runtime `provided.al2023`, architecture `arm64`.
- Tenant ID always comes from the verified token; every store method takes a tenant ID; no cross-tenant reads.
- Dev authentication (`-auth=dev`) exists only in `cmd/devserver`; `cmd/api` must refuse to start if `OPSVISION_AUTH_MODE` is anything other than `auth0`.
- Formula results are in **display units** (percent metrics multiply by 100 in the formula); status bands compare against display units.
- Fiscal years are labeled by the calendar year in which they **end**; `FiscalYearStartMonth` defaults to January.
- Status is never color-only in the UI: always a letter or icon plus an accessible label. WCAG 2.2 AA.
- Pinned dependency versions (vetted; do not change without re-vetting):
  - Go: `github.com/aws/aws-lambda-go v1.55.1`, `github.com/aws/aws-sdk-go-v2 v1.47.5`, `.../config v1.33.13`, `.../service/dynamodb v1.72.3`, `.../feature/dynamodb/attributevalue v1.21.17`, `.../service/s3 v1.114.6`, `github.com/auth0/go-jwt-middleware/v3 v3.4.0` (v2 pulled an unvetted go-jose v2), `golang.org/x/crypto v0.58.0`, `github.com/expr-lang/expr v1.17.8`, `github.com/oapi-codegen/oapi-codegen/v2 v2.8.1` (tool), `github.com/oapi-codegen/runtime v1.8.0`, `github.com/oklog/ulid/v2 v2.1.2`, `github.com/google/go-cmp v0.7.0`.
  - npm runtime: `react 19.3.0`, `react-dom 19.3.0`, `react-router 7.18.4`, `@tanstack/react-query 5.105.0`, `@auth0/auth0-react 2.30.0`, `openapi-fetch 0.17.0`, `recharts 3.10.1`, `lucide-react 1.31.0`, `clsx 2.1.1`, `@radix-ui/react-dialog 1.3.1`, `@radix-ui/react-tabs 1.2.1`, `@radix-ui/react-tooltip 1.4.1`, `@radix-ui/react-select 2.4.1`, `@radix-ui/react-popover 1.3.1`, `@radix-ui/react-dropdown-menu 2.2.1`.
  - npm dev: `vite 8.3.4`, `@vitejs/plugin-react 6.1.2`, `typescript 5.9.3` (6.x conflicts with openapi-typescript's peer range), `@types/react 19.3.0`, `@types/react-dom 19.3.0`, `tailwindcss 4.3.3`, `@tailwindcss/vite 4.3.3`, `vitest 5.0.3`, `jsdom 30.1.1`, `@testing-library/react 16.3.3`, `@testing-library/user-event 14.6.8`, `msw 2.15.0`, `vitest-axe 0.1.0`, `@playwright/test 1.64.1`, `@axe-core/playwright 4.14.0`, `openapi-typescript 7.13.0`, `eslint 9.39.5` (10.x conflicts with eslint-plugin-jsx-a11y's peer range), `typescript-eslint 8.70.0`, `eslint-plugin-jsx-a11y 6.10.2`, `eslint-plugin-react-hooks 7.1.1`, `auth0-deploy-cli 9.2.0`.
  - If a peer-dependency conflict forces a different version, stop and re-vet; do not pick a version by hand.
- Not yet vetted, so not used: Terraform providers, the DynamoDB Local container image, any spreadsheet library. GitHub Actions versions must be supplied by the maintainer before Task 29.

## Review Focus

1. **Zero-denominator periods** ("no initiatives ended this month", 0/0): the cell shows not-applicable with a reason, never 0% red. Test in Task 7 (`TestZeroDenominatorIsNotApplicable`).
2. **Mid-year org moves with YTD/quarter totals**: each month rolls up to the parent it had that month. Test in Task 6 (`TestRollupAsOfMove`) and Task 8 (`TestYTDAcrossMove`).
3. **Values pasted from a spreadsheet** (`84%`, `1,234`, `$10k`, trailing spaces, blank cells, `n/a`): parsed or rejected per cell, never silently stored as 0. Test in Task 24 (`pasteParser` cases).
4. **Cross-tenant identifiers**: a token for tenant A naming an org unit, version, or upload from tenant B gets 404 and no data. Tests in Tasks 13, 15, 20 (`TestCrossTenant...`).
5. **Two people editing the same data point**: the second write with a stale revision gets 409 with the current value, not a silent overwrite. Tests in Task 9 contract suite (`ConflictOnStaleRevision`) and Task 24 (UI shows conflict).

---

## File Structure

```
LICENSE  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  .gitignore  Makefile
scripts/check-denylist.sh                 name guard (reads denylist from env/untracked file)
scripts/check-denylist_test.sh
openapi/openapi.yaml                      API contract (phase 1 paths)
api/
  go.mod
  Makefile                                SAM build targets (build-ApiFunction)
  cmd/api/main.go                         Lambda entrypoint
  cmd/devserver/main.go                   local HTTP server (memory|dynamo store, dev|auth0 auth)
  internal/period/                        Period, Calendar
  internal/domain/                        domain types + validation
  internal/formula/                       safe formula compile/eval
  internal/orgtree/                       effective-dated org tree
  internal/engine/                        rollups, metric values, status, view, restatement
  internal/store/                         interfaces; memstore/; dynamostore/; storetest/ (contract suite)
  internal/auth/                          token validation, principal, authorization
  internal/httpapi/                       generated server (gen.go), handlers by area
  internal/lambdahttp/                    API Gateway REST event <-> net/http adapter
  internal/xlsx/                          minimal .xlsx reader; xlsxtest/ writer for fixtures
  internal/legacy/                        legacy cell parser, workbook adapter, band-text parser
  internal/changeset/                     change set model, preview, apply
  internal/demo/                          fictional demo tenant seed
web/
  package.json  vite.config.ts  eslint.config.js  tsconfig.json  index.html
  src/main.tsx  src/App.tsx
  src/auth/        AuthProvider.tsx, devAuth.ts
  src/api/         schema.d.ts (generated), client.ts, queries.ts
  src/shell/       AppShell.tsx, PeriodPicker.tsx, SubjectFilter.tsx, TenantSwitcher.tsx
  src/ui/          StatusBadge.tsx, Footnote.tsx, Sparkline.tsx, tokens.css
  src/features/scorecard/  ScorecardPage.tsx, TableTab.tsx, CellDrawer.tsx, ChartsTab.tsx, MetricTile.tsx
  src/features/entry/      EntryPage.tsx, EntryGrid.tsx, pasteParser.ts
  src/features/admin/      OrgPage.tsx, ItemsPage.tsx, MembersPage.tsx, MethodologyPage.tsx, MetricForm.tsx, ImportPage.tsx
  src/test/        server.ts (MSW), fixtures.ts
  e2e/             smoke.spec.ts
infra/
  app.yaml                                SAM: API Gateway, Lambda, DynamoDB, uploads bucket, access mode
  edge.yaml                               SPA bucket, CloudFront, WAF IP set, ACM/Route 53 (optional)
  auth0/tenant.yaml  auth0/config.example.json  auth0/package.json
.github/workflows/ci.yml  .github/workflows/deploy.yml
docs/deploy/private-deployment.md  docs/user/getting-started.md
```

---

### Task 1: Repository bootstrap and name guard

**Files:**
- Create: `LICENSE` (MIT, copyright "OpsVision contributors"), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 text), `SECURITY.md`, `.gitignore`, `Makefile`, `scripts/check-denylist.sh`, `scripts/check-denylist_test.sh`

**Interfaces:**
- Produces: `scripts/check-denylist.sh [path...]` — reads newline-separated terms from `$OPSVISION_DENYLIST` (CI secret) or the untracked file `.denylist`; case-insensitive search of tracked files (`git ls-files`); prints `file:line:term` and exits 1 on any match, 0 otherwise; exits 0 with a warning if no list is configured.
- Produces: root `Makefile` targets `gen`, `test`, `lint`, `dev`, `denylist` (later tasks fill them in).

- [ ] **Step 1:** `git init`, set default branch `main`. `.gitignore` includes `.superpowers/`, `.denylist`, `node_modules/`, `.aws-sam/`, `dist/`, `*.local.*`, `/private/`, `*.xlsx` (with `!api/internal/**/testdata/*.xlsx`).
- [ ] **Step 2: Write the failing test** `scripts/check-denylist_test.sh`: creates a temp git repo with one file containing `Contoso Widgets`, sets `OPSVISION_DENYLIST=contoso`, asserts exit 1 and output contains `contoso`; then a clean file asserts exit 0; then unset list asserts exit 0 and stderr contains `no denylist configured`.
- [ ] **Step 3:** Run `bash scripts/check-denylist_test.sh` — expect FAIL (script missing).
- [ ] **Step 4:** Implement `scripts/check-denylist.sh` (POSIX bash, `git grep -n -i -F -f <terms>`).
- [ ] **Step 5:** Run the test — expect PASS. Run `OPSVISION_DENYLIST="$(cat ~/.opsvision-denylist)" make denylist` locally with the maintainer's private list (not committed) — expect exit 0.
- [ ] **Step 6: Commit** `chore: bootstrap repository, license, and name guard` (includes the existing `docs/` spec, brand brief, and this plan).

### Task 2: Periods and fiscal calendar

**Files:**
- Create: `api/go.mod`, `api/internal/period/period.go`, `api/internal/period/period_test.go`

**Interfaces:**
- Produces:
  - `type Grain int` with `Month, Quarter, Half, Year`
  - `type Period struct { Grain Grain; FY int; Index int }` (Index 1-based within the fiscal year; 0 for Year)
  - `func Parse(s string) (Period, error)`; `func (p Period) String() string` — formats `2026-M10`, `2026-Q3`, `2026-H2`, `2026-FY`
  - `type Calendar struct { FiscalYearStartMonth time.Month }`
  - `func (c Calendar) MonthOf(t time.Time) Period`
  - `func (c Calendar) Months(p Period) []Period` (constituent months, in order)
  - `func (c Calendar) Contains(outer, month Period) bool`
  - `func (c Calendar) YTD(month Period) []Period`
  - `func (c Calendar) Prev(p Period) Period`; `func (c Calendar) SameLastYear(p Period) Period`
  - `func (c Calendar) Start(p Period) time.Time`; `func (c Calendar) End(p Period) time.Time` (exclusive, UTC)
  - `func (c Calendar) Seconds(p Period) int64`
  - `func (c Calendar) Parent(month Period, g Grain) Period`

- [ ] **Step 1:** `go mod init opsvision` in `api/`, set `go 1.27`, add `github.com/google/go-cmp v0.7.0`.
- [ ] **Step 2: Write failing tests:**
  - `TestCalendarJanuaryStart`: `MonthOf(2026-10-15)` → `2026-M10`; `Parent(2026-M10, Quarter)` → `2026-Q4`; `Seconds(2026-M06)` → `2592000`.
  - `TestCalendarJulyStart` (`FiscalYearStartMonth: time.July`): `MonthOf(2026-07-01)` → `2027-M01`; `Start(2027-FY)` → 2026-07-01; `YTD(2027-M03)` has 3 months starting 2026-07.
  - `TestPrevAcrossYear`: `Prev(2026-M01)` → `2025-M12`; `Prev(2026-Q1)` → `2025-Q4`; `SameLastYear(2026-H2)` → `2025-H2`.
  - `TestParseRoundTrip` over `2026-M10, 2026-Q3, 2026-H2, 2026-FY`; `Parse("2026-M13")` returns error.
- [ ] **Step 3:** `cd api && go test ./internal/period/...` — FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Tests PASS.
- [ ] **Step 6: Commit** `feat(api): periods and fiscal calendar`.

### Task 3: Formula compiler

**Files:**
- Create: `api/internal/formula/{formula.go,formula_test.go}`

**Interfaces:**
- Produces:
  - `type Formula struct{ src string; prog *vm.Program; idents []string }`
  - `func Compile(src string, measures []string) (*Formula, error)` — allowed: number literals, measure identifiers, `+ - * /`, parentheses, functions `min(a,b)`, `max(a,b)`, `abs(x)`. Anything else (member access, strings, other builtins, comparisons) is a compile error.
  - `func (f *Formula) Eval(vars map[string]float64) (float64, error)` — returns `ErrMissing{Measure}` if a referenced measure is absent, `ErrDivByZero` on division by zero.
  - `func Identifiers(src string) ([]string, error)`

- [ ] **Step 1:** Add `github.com/expr-lang/expr v1.17.8`.
- [ ] **Step 2: Write failing tests:**
  - `TestEvalRatio`: `on_time / committed * 100` with `440, 522` → `84.2911...` (within 1e-9).
  - `TestEvalUptime`: `(1 - seconds_down / seconds_in_period) * 100` with `300, 2592000` → `99.98842...`.
  - `TestDivByZero`: `a / b` with `b=0` → `errors.Is(err, ErrDivByZero)`.
  - `TestMissingMeasure`: `a / b` with only `a` → `ErrMissing{Measure:"b"}`.
  - `TestRejectsUnsafe`: each of `env()`, `"x"`, `a.b`, `a > 1`, `len(a)`, `a ? 1 : 2` fails to compile.
  - `TestRejectsUnknownIdent`: `a / c` with measures `[a b]` → error naming `c`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement with `expr.Compile` plus an AST visitor (`ast.Visitor`) that whitelists node types; evaluate division through a custom `div` operator override so divide-by-zero is detected rather than yielding `+Inf`. **Step 5:** PASS.
- [ ] **Step 6: Commit** `feat(api): safe formula compiler`.

### Task 4: Domain types and methodology validation

**Files:**
- Create: `api/internal/domain/{tenant.go,org.go,methodology.go,data.go,validate.go,validate_test.go}`

**Interfaces:**
- Consumes: `period.Period`; `formula.Compile`, `formula.Identifiers` (Task 3).
- Produces (exported types, JSON tags in camelCase):
  - `Tenant{ID, Name, Auth0OrgID string; FiscalYearStartMonth time.Month; StatusScale []StatusLevel; DefaultRole Role; CreatedAt time.Time}`; `StatusLevel{Key, Label, Color string; Rank int}`; `DefaultStatusScale()` returns `G "Green" #137A3A rank 1`, `Y "Yellow" #8A5A00 rank 2`, `R "Red" #B42318 rank 3`.
  - `Role` = `"admin" | "contributor" | "viewer"`; `Membership{UserID, Email, Name string; Role Role; Scope Scope; CreatedAt time.Time}`; `Scope{OrgUnitIDs, MetricKeys []string}` (empty = everything).
  - `Level{ID, Name string; Depth int}`; `OrgUnit{ID, Name, LevelID, ParentID string; SourceKeys []string; RetiredFrom *period.Period}`; `OrgMove{UnitID, NewParentID string; EffectiveMonth period.Period; Note string}`.
  - `ItemKind{ID, Name string}`; `TrackedItem{ID, KindID, Name, OrgUnitID string; SourceKeys []string}`.
  - `Scorecard{ID, Name string}`; `VersionStatus` = `draft|in_review|published|superseded`; `MethodologyVersion{ID, ScorecardID, Name string; Status VersionStatus; EffectiveFrom period.Period; PublishedAt *time.Time; Revision int; Content Methodology}`.
  - `Methodology{Categories []Category; Measures []Measure; Metrics []Metric}`; `Category{ID, Name string; Order int}`.
  - `Agg` = `sum|min|max|latest|average|none`; `Measure{Key, Name, Unit string; OrgAgg, TimeAgg Agg}`.
  - `Direction` = `higher_better|lower_better`; `Frequency` = `monthly|quarterly|biannual|annual`; `Subject{Kind string /* "level"|"item_kind" */; ID string}`.
  - `Metric{Key, Name, CategoryID, Formula, Format string; Direction Direction; Frequency Frequency; ReportedAt []Subject; RollItemsToOrg bool; Rule StatusRule; Targets []Target; Definition, Notes, Example, Source, Link string}`; `Format` ∈ `percent0|percent1|percent2|number0|number1|number2|money_k|days0`.
  - `RuleType` = `bands|change|scale`; `StatusRule{Type RuleType; Bands []Band; Compare Comparison; PerSubject []SubjectBands; Scale []ScaleStep}`; `Band{Status, Op string /* ">=",">","<=","<","" */; Value float64}` (first match wins; `Op ""` is the else band); `Comparison` = `prior_period|prior_year_average|baseline`; `SubjectBands{SubjectID string; Bands []Band}`; `ScaleStep{Status string; Min float64}`.
  - `Target{Label string; From, To period.Period; Value float64; SubjectID string}`.
  - `DataPoint{MeasureKey, SubjectID string; Period period.Period; Value *float64; NAReason, Source, EnteredBy string; EnteredAt time.Time; Revision int}`; `Source` ∈ `grid|import|api|sam|legacy`.
  - `Override{MetricKey, SubjectID string; Period period.Period; Value *float64; Status, Reason, By string; At time.Time}`.
  - `AuditEntry{ID, ActorID, Channel, Action, TargetType, TargetID string; Before, After json.RawMessage; At time.Time}`.
  - `func (m Methodology) Validate(scale []StatusLevel) []ValidationError`; `ValidationError{Path, Message string}`.

- [ ] **Step 1: Write failing tests** `validate_test.go`:
  - `TestValidateRejectsUnknownMeasure`: metric formula `a / b` where only `a` exists → error at `metrics[0].formula` containing `unknown measure "b"`.
  - `TestValidateRejectsUnsafeFormula`: formula `len(a)` → error at `metrics[0].formula`.
  - `TestValidateBandsNeedElse`: bands without a final `Op ""` band → error `bands must end with an else band`.
  - `TestValidateStatusInScale`: band status `B` with default scale → error `unknown status "B"`.
  - `TestValidateDuplicateKeys`: two measures with key `x` → error.
  - `TestValidateChangeRuleNeedsCompare`: `Type change` with empty `Compare` → error.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): domain model and methodology validation`.

### Task 5: Effective-dated org tree

**Files:**
- Create: `api/internal/orgtree/{tree.go,tree_test.go}`

**Interfaces:**
- Consumes: `domain.OrgUnit`, `domain.OrgMove`, `period.Period`.
- Produces:
  - `func New(units []domain.OrgUnit, moves []domain.OrgMove) (*Tree, error)` — errors on unknown parent, cycles at any month, or a move into a descendant.
  - `func (t *Tree) ParentAt(unitID string, month period.Period) (string, bool)`
  - `func (t *Tree) ChildrenAt(unitID string, month period.Period) []string` (sorted by name)
  - `func (t *Tree) DescendantsAt(unitID string, month period.Period) []string`
  - `func (t *Tree) RootsAt(month period.Period) []string`
  - `func (t *Tree) ActiveAt(unitID string, month period.Period) bool`
  - `func (t *Tree) Unit(id string) (domain.OrgUnit, bool)`

- [ ] **Step 1: Write failing tests** with fixture: Company → {Platform, Data}; Data → {Analytics}; move Analytics → Platform effective `2026-M07`.
  - `TestParentBeforeAndAfterMove`: `ParentAt(Analytics, 2026-M06)` = Data; `2026-M07` = Platform.
  - `TestChildrenAt`: `ChildrenAt(Data, 2026-M07)` empty; `ChildrenAt(Platform, 2026-M07)` = [Analytics].
  - `TestRejectsCycle`: move Company under Analytics → error.
  - `TestRetired`: unit with `RetiredFrom 2026-M04` inactive at `2026-M04`, active at `2026-M03`; not in `ChildrenAt` after retirement.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (moves sorted by month; resolve parent by latest move ≤ month). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): effective-dated org tree`.

### Task 6: Engine — measure rollups

**Files:**
- Create: `api/internal/engine/{input.go,rollup.go,rollup_test.go,fixtures_test.go}`

**Interfaces:**
- Consumes: Tasks 2–5 (period, formula, domain, orgtree).
- Produces:
  - `type Input struct{ Cal period.Calendar; Tree *orgtree.Tree; Items []domain.TrackedItem; Versions []domain.MethodologyVersion; Data []domain.DataPoint; Overrides []domain.Override }`
  - `func NewIndex(in *Input) *Index` (indexes data by measure/subject/period)
  - `type Value struct{ V float64; Have, Expected int; NAReason string; Direct bool }` (`Have/Expected` = months with data / months in range; `Direct` = value came from a data point on this subject, not children)
  - `func (ix *Index) Measure(m domain.Measure, subjectID string, p period.Period, rollItems bool) (Value, bool)`
- Rules (pin these):
  - For each month in `Cal.Months(p)` (or the period itself if data is stored at a coarser grain), the monthly value is: the direct data point on the subject if present; otherwise the `OrgAgg` of children **as of that month** (and of attached tracked items if `rollItems`). `OrgAgg none` means no rollup.
  - Then the monthly values combine with `TimeAgg`. `average` = mean of months with data; `latest` = last month with data.
  - A month whose only data points are not-applicable contributes no value; if every contributing point is not-applicable, return `Value{NAReason: <the reason, or "Not applicable" if reasons differ>}`.

- [ ] **Step 1: Write failing tests** (fixture tree from Task 5; measures `on_time` sum/sum, `committed` sum/sum, `points` sum/sum, `days` max/sum, `seconds_down` none/sum, `trained` sum/latest):
  - `TestRollupSumAcrossChildren`: products 10/12 and 5/8 → segment `on_time 15`, `committed 20`.
  - `TestRollupAsOfMove`: Analytics has `on_time=4` every month of FY2026; `Measure(on_time, Data, 2026-H1)` includes 24, `Measure(on_time, Data, 2026-H2)` includes 0 from Analytics; `Measure(on_time, Platform, 2026-H2)` includes 24.
  - `TestDaysMaxAcrossUnits`: two products each `days=31` for 2026-M01 → segment `days 31`.
  - `TestDirectValueWins`: company has direct `trained=200`, children sum 150 → 200, `Direct true`.
  - `TestLatestOverTime`: `trained` 90, 92, 95 in Q1 months → Q1 value 95.
  - `TestNoneDoesNotRollUp`: `seconds_down` on two services attached to Platform, `rollItems=false` → `ok=false` for Platform.
  - `TestAllNotApplicable`: both children NA "No initiatives ended" → `NAReason "No initiatives ended"`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): measure rollups across org and time`.

### Task 7: Engine — metric values, status, targets, overrides

**Files:**
- Create: `api/internal/engine/{metric.go,status.go,format.go,metric_test.go,status_test.go,format_test.go}`

**Interfaces:**
- Consumes: Task 6 `Index.Measure`, Task 3 `formula`.
- Produces:
  - `type Cell struct{ MetricKey, SubjectID string; Period period.Period; Value *float64; Display, Status, NAReason string; Components map[string]float64; Coverage [2]int; Change *float64; Target *float64; VersionID string; Override *domain.Override; Computed *Computed }`; `Computed{Value *float64; Status string}`
  - `func (ix *Index) Cell(v domain.MethodologyVersion, m domain.Metric, subjectID string, p period.Period) Cell`
  - `func EvalStatus(rule domain.StatusRule, dir domain.Direction, subjectID string, value float64, comparison *float64) (status string, change *float64)`
  - `func Format(format string, v float64) string`
- Rules:
  - Change rules: `improvement = (cmp - cur)/cmp*100` for `lower_better`, `(cur - cmp)/cmp*100` for `higher_better`; bands evaluate `improvement`. `cmp == 0 && cur == 0` → improvement 0; `cmp == 0 && cur != 0` → no status. `prior_period` uses `Cal.Prev(p)`; `prior_year_average` uses the mean of the prior fiscal year's monthly cell values; `baseline` uses the target labeled `baseline`.
  - `PerSubject` bands replace the metric bands for that subject.
  - Division by zero, or all inputs not-applicable → `Value nil`, `Status ""`, `NAReason` = data reason or `"Not applicable"`.
  - An override replaces `Value`/`Status` (whichever it sets), recomputes `Display`, and keeps the engine result in `Computed`.
  - `Format`: `percent1` → `84.3%`, `percent2` → `99.99%`, `money_k` → `$8,234k`, `number0` → `1,587`, `days0` → `16 days`.

- [ ] **Step 1: Write failing tests** (values from the spec's §5.11 validation table):
  - `TestBandsOnTime`: 440/522 with bands `G>=90, Y>=80, R` → `84.3%`, `Y`.
  - `TestSpendLowerBetter`: 828/725 with `G<=110, Y<=120, R` → `114.2%`, `Y`; 552/345 → `R`.
  - `TestUptime`: 300 s down in June → `99.99%`, `G` (`G>=99.9, Y>=99.8, R`); 99.64 equivalent → `R`.
  - `TestChangeRuleDefectScore`: rule `change`, `prior_period`, bands `G>0, Y>=-5, R`, lower_better: 696 vs 597 → `R`, change ≈ −16.58; 644 vs 664 → `G`; 641 vs 627 → `Y`; 2 vs 2 → `Y`.
  - `TestZeroDenominatorIsNotApplicable`: 0/0 with NA reason "No initiatives ended this month" → `Value nil`, `Status ""`, `NAReason` equal to that reason.
  - `TestPerSubjectBands`: subject `svc-portal` override bands `G>=90, Y>=80, R` → 92 → `G` while metric bands would give `R`.
  - `TestOverrideReplacesStatus`: computed `Y`, override `Status "G"`, reason "As reported in legacy workbook" → `Status "G"`, `Computed.Status "Y"`, `Override.Reason` preserved.
  - `TestTargetLookup`: target `H1 goal` 90 for `2026-H1` applies to `2026-M03`, not to `2026-M07`.
  - `TestFormat` table for each format code above.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(engine): metric values, status rules, overrides`.

### Task 8: Engine — scorecard view, version selection, restatement

**Files:**
- Create: `api/internal/engine/{view.go,version.go,view_test.go,bench_test.go}`

**Interfaces:**
- Consumes: Task 7.
- Produces:
  - `func VersionFor(versions []domain.MethodologyVersion, last period.Period, cal period.Calendar) (domain.MethodologyVersion, bool)` — published or superseded version with the greatest `EffectiveFrom` ≤ the last month of the period.
  - `type ViewRequest struct{ Periods []period.Period; SubjectIDs []string; Restate string /* version ID or "" */; Structure string /* "as_of" (default) | "current" */ }`
  - `type Row struct{ MetricKey, MetricName, CategoryID, SubjectID, SubjectName, Format string; Depth int; Direction domain.Direction; Cells []Cell }`
  - `type View struct{ Periods []period.Period; Categories []domain.Category; Rows []Row; VersionByPeriod map[string]string }`
  - `func Compute(in *Input, req ViewRequest) View` — rows ordered by category order, metric order, then subject tree order; only subjects at a metric's `ReportedAt` levels/kinds or their ancestors; `Structure "current"` builds the tree using the latest month's parents for all periods; `Restate` evaluates every period under that version (stored results untouched).

- [ ] **Step 1: Write failing tests:**
  - `TestVersionSelection`: versions effective `2025-M01` and `2026-M01` → `2025-M12` uses the first, `2026-Q1` uses the second, `2026-FY` uses the second.
  - `TestYTDAcrossMove`: Analytics moves Data→Platform at `2026-M07`; YTD at `2026-M09` for Data includes Analytics Jan–Jun only; with `Structure "current"`, Platform includes Analytics Jan–Sep.
  - `TestRestatementDoesNotMutate`: computing with `Restate=v2026` over 2025 periods yields 2026 statuses; a second `Compute` without `Restate` returns the original 2025 statuses.
  - `TestRowsOrdering`: categories ordered by `Order`, segments before their products.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** `BenchmarkComputeYear`: 50 metrics × 60 subjects × 12 months + YTD → `go test -bench ComputeYear ./internal/engine/` reports under 300 ms/op on a laptop; record the result in the commit message.
- [ ] **Step 6: Commit** `feat(engine): scorecard view, version selection, restatement`.

### Task 9: Store interfaces, in-memory store, contract suite

**Files:**
- Create: `api/internal/store/store.go`, `api/internal/store/memstore/memstore.go`, `api/internal/store/storetest/suite.go`, `api/internal/store/memstore/memstore_test.go`

**Interfaces:**
- Produces in `store`:
  - `var ErrNotFound, ErrConflict = errors.New("not found"), errors.New("conflict")`
  - `TenantStore{ CreateTenant(ctx, domain.Tenant) error; GetTenant(ctx, id string) (domain.Tenant, error); TenantByAuth0Org(ctx, orgID string) (domain.Tenant, error); ListTenants(ctx) ([]domain.Tenant, error); PutMembership(ctx, tenantID string, m domain.Membership) error; GetMembership(ctx, tenantID, userID string) (domain.Membership, error); ListMemberships(ctx, tenantID string) ([]domain.Membership, error); TenantsForUser(ctx, userID string) ([]string, error) }`
  - `OrgStore{ PutLevels(ctx, tenantID string, ls []domain.Level) error; ListLevels; PutOrgUnit; ListOrgUnits; PutOrgMove; ListOrgMoves; PutItemKind; ListItemKinds; PutTrackedItem; ListTrackedItems }` (all take `tenantID` first after ctx)
  - `MethodologyStore{ PutScorecard; GetScorecard; ListScorecards; PutVersion(ctx, tenantID string, v domain.MethodologyVersion, expectedRevision int) error; GetVersion(ctx, tenantID, scorecardID, versionID string); ListVersions(ctx, tenantID, scorecardID string) }`
  - `DataStore{ PutDataPoints(ctx, tenantID, scorecardID string, pts []DataWrite) ([]domain.DataPoint, error); ListData(ctx, tenantID, scorecardID string, fiscalYears []int) ([]domain.DataPoint, []domain.Override, error); History(ctx, tenantID, scorecardID, measureKey, subjectID string, p period.Period) ([]domain.DataPoint, error); PutOverride(ctx, tenantID, scorecardID string, o domain.Override) error; DeleteOverride(ctx, tenantID, scorecardID, metricKey, subjectID string, p period.Period) error }`; `DataWrite{Point domain.DataPoint; ExpectedRevision int /* 0 = must not exist; -1 = unconditional (imports) */}`
  - `AuditStore{ AppendAudit(ctx, tenantID string, e domain.AuditEntry) error; ListAudit(ctx, tenantID string, from, to time.Time) ([]domain.AuditEntry, error) }`
  - `ImportStore{ PutImport(ctx, tenantID string, im Import) error; GetImport(ctx, tenantID, id string) (Import, error); PutTemplate(ctx, tenantID string, t Template) error; ListTemplates(ctx, tenantID string) ([]Template, error) }`; `Import{ID, Status, ObjectKey, Profile, TemplateID, CreatedBy string; CreatedAt time.Time; ChangeSet json.RawMessage}`; `Template{ID, Name, Profile string; Body json.RawMessage}`
  - `type Store interface{ TenantStore; OrgStore; MethodologyStore; DataStore; AuditStore; ImportStore }`
- Produces in `storetest`: `func Run(t *testing.T, newStore func(t *testing.T) store.Store)`.

- [ ] **Step 1: Write the contract suite** with subtests: `TenantRoundTrip`, `Auth0OrgLookup`, `MembershipsScopedByTenant`, `OrgModelRoundTrip`, `VersionOptimisticConcurrency` (stale `expectedRevision` → `ErrConflict`), `DataRevisionsAppend` (history returns revisions 1..n newest first), `ConflictOnStaleRevision` (two writers with revision 1; second → `ErrConflict`, stored value is the first writer's), `ListDataByFiscalYear`, `OverridesRoundTrip`, `TenantIsolation` (write in tenant A, every read in tenant B returns `ErrNotFound` or empty), `AuditRange`.
- [ ] **Step 2:** `memstore_test.go` calls `storetest.Run(t, func(t *testing.T) store.Store { return memstore.New() })` — FAIL.
- [ ] **Step 3:** Implement `memstore` (maps guarded by `sync.RWMutex`, deep copies on read/write).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(store): store interfaces, in-memory store, contract suite`.

### Task 10: DynamoDB store

**Files:**
- Create: `api/internal/store/dynamostore/{dynamostore.go,keys.go,keys_test.go,dynamostore_test.go}`

**Interfaces:**
- Consumes: Task 9 interfaces and suite.
- Produces: `func New(client *dynamodb.Client, table string) *Store`; table schema: `PK` (S), `SK` (S), `GSI1PK`/`GSI1SK` (S) with index `GSI1`.
- Key design (pin these):

| Item | PK | SK | GSI1 |
|---|---|---|---|
| Tenant | `T#<tid>` | `TENANT` | `TENANTS` / `T#<tid>` |
| Auth0 org map | `AUTH0ORG#<orgId>` | `MAP` | — |
| Membership | `T#<tid>` | `MEMBER#<userId>` | `USER#<userId>` / `T#<tid>` |
| Level / unit / move / kind / item | `T#<tid>` | `LEVEL#<id>` / `UNIT#<id>` / `MOVE#<unitId>#<month>` / `KIND#<id>` / `ITEM#<id>` | — |
| Scorecard / version | `T#<tid>` | `SC#<scid>` / `SC#<scid>#VER#<vid>` | — |
| Data point (current) | `T#<tid>#SC#<scid>#FY#<fy>` | `DP#<period>#<measure>#<subject>` | — |
| Data point revision | `T#<tid>#SC#<scid>#HIST` | `DP#<period>#<measure>#<subject>#R<rev:06d>` | — |
| Override | `T#<tid>#SC#<scid>#FY#<fy>` | `OV#<period>#<metric>#<subject>` | — |
| Audit | `T#<tid>#AUDIT#<yyyy-mm>` | `<ulid>` | — |
| Import / template | `T#<tid>` | `IMPORT#<id>` / `TEMPLATE#<id>` | — |

  - Data writes use `TransactWriteItems` (current item with condition on `Revision`, plus history item) in chunks of ≤ 50 points; a failed condition maps to `ErrConflict`.
  - Version content stored as a JSON string attribute `Content`.

- [ ] **Step 1: Write failing tests** `keys_test.go`: exact key strings for each row of the table above.
- [ ] **Step 2:** `dynamostore_test.go`: if `OPSVISION_DYNAMO_TEST_TABLE` is unset, `t.Skip("set OPSVISION_DYNAMO_TEST_TABLE to run against DynamoDB")`; otherwise each subtest uses a random tenant ID prefix and runs `storetest.Run`.
- [ ] **Step 3:** FAIL (keys). **Step 4:** Implement. **Step 5:** `go test ./internal/store/...` PASS; with a real table in the demo account (created by Task 27's template, or `aws dynamodb create-table` with the schema above), `OPSVISION_DYNAMO_TEST_TABLE=opsvision-test go test ./internal/store/dynamostore/` PASS.
- [ ] **Step 6: Commit** `feat(store): DynamoDB single-table store`.

### Task 11: API contract and code generation

**Files:**
- Create: `openapi/openapi.yaml`, `api/internal/httpapi/oapi-config.yaml`, `api/internal/httpapi/gen.go` (generated), `api/tools.go` (oapi-codegen tool dependency)
- Modify: root `Makefile` (`gen` target runs Go and TS generation; `gen-check` fails on drift)

**Interfaces:**
- Produces: `httpapi.StrictServerInterface` (oapi-codegen `std-http-server` + `strict-server`), schemas mirroring Task 3 types and Task 8 `View`/`Row`/`Cell`, and `web/src/api/schema.d.ts` (generated in Task 21).
- Paths (all under `/v1`, bearer auth, tenant from token):
  - `GET /me` → `{userId, name, email, isOperator, tenant?, role?, scope?, tenants[]}`
  - `GET|POST /operator/tenants` (operator only; POST body `{name, auth0OrgId, fiscalYearStartMonth, adminEmail}`)
  - `GET|PATCH /members`, `PATCH /members/{userId}` (`{role, scope}`)
  - `GET|PUT /org/levels`; `GET|POST /org/units`; `PATCH /org/units/{id}`; `POST /org/units/{id}/moves`; `GET /org/tree?month=`
  - `GET|POST /item-kinds`; `GET|POST /items`; `PATCH /items/{id}`
  - `GET|POST /scorecards`
  - `GET|POST /scorecards/{sc}/versions` (POST `{name, cloneFrom?}`); `GET|PUT /scorecards/{sc}/versions/{v}` (PUT draft content with `revision`); `POST /scorecards/{sc}/versions/{v}/validate`; `POST /scorecards/{sc}/versions/{v}/publish` (`{effectiveFrom}`); `GET /scorecards/{sc}/versions/{v}/diff?against=`
  - `GET /scorecards/{sc}/view?periods=&subjects=&restate=&structure=`
  - `GET /scorecards/{sc}/entry?period=` → rows `{measureKey, measureName, metricKeys[], subjectId, subjectName, value?, naReason?, revision, canEdit}`
  - `POST /scorecards/{sc}/data:batch` (`{writes:[{measureKey, subjectId, period, value?, naReason?, expectedRevision}]}` → 200 with saved points, or 409 with `{conflicts:[{..., current}]}`)
  - `POST /scorecards/{sc}/preview` (same body; returns affected `Cell`s without saving)
  - `GET /scorecards/{sc}/history?measure=&subject=&period=`
  - `PUT|DELETE /scorecards/{sc}/overrides` (`{metricKey, subjectId, period, value?, status?, reason?}`)
  - `POST /imports/uploads` → `{importId, uploadUrl}`; `POST /imports/{id}/parse` (`{profile:"legacy_workbook"|"csv", templateId?}`) → `ChangeSet`; `POST /imports/{id}/apply`; `GET|PUT /import-templates`, `PUT /import-templates/{id}`
  - `GET /audit?from=&to=`
  - Errors: `{error:{code, message, details?}}` with codes `not_found`, `forbidden`, `conflict`, `invalid`.

- [ ] **Step 1:** Write `openapi.yaml` (OpenAPI 3.0.3).
- [ ] **Step 2:** `make gen` produces `gen.go`; `cd api && go build ./...` succeeds.
- [ ] **Step 3:** `make gen-check` exits 0 on a clean tree and 1 after editing `openapi.yaml` without regenerating (verify both).
- [ ] **Step 4: Commit** `feat(api): phase 1 OpenAPI contract and code generation`.

### Task 12: Authentication, tenancy resolution, authorization

**Files:**
- Create: `api/internal/auth/{principal.go,jwt.go,devauth.go,authz.go,middleware.go,*_test.go}`

**Interfaces:**
- Consumes: `store.TenantStore`, `orgtree.Tree`.
- Produces:
  - `type Principal struct{ UserID, Email, Name string; IsOperator bool; Tenant *domain.Tenant; Membership *domain.Membership }`
  - `func FromContext(ctx context.Context) (Principal, bool)`
  - `type Config struct{ Mode string /* "auth0" | "dev" */; Domain, Audience, ClaimNamespace, DevSecret string }`
  - `func Middleware(cfg Config, ts store.TenantStore) (func(http.Handler) http.Handler, error)` — validates RS256 tokens against `https://<Domain>/.well-known/jwks.json` (Auth0 mode) or HS256 with `DevSecret` (dev mode); reads `org_id`, `permissions` (operator = contains `operate:platform`), and `<ClaimNamespace>email` / `<ClaimNamespace>name`; resolves tenant via `TenantByAuth0Org`; on first sign-in to a tenant with no membership, creates one with `Tenant.DefaultRole` unless a pending membership with the same email exists (then binds it); missing/invalid token → 401.
  - `func IssueDevToken(secret, userID, email, name, orgID string, operator bool) (string, error)`
  - `type Action string` = `tenant:admin | methodology:write | data:write | data:read | override:write`
  - `func Can(p Principal, a Action, res Resource, tree *orgtree.Tree, month period.Period) bool`; `Resource{OrgUnitID, MetricKey string}` — admin: all; contributor: `data:read` everywhere, `data:write` only inside scope (unit is in a scoped subtree as of `month` and metric in scope when listed); viewer: `data:read` inside scope.

- [ ] **Step 1: Write failing tests:**
  - `TestRS256ValidToken`: test JWKS server (`httptest`), signed token with `org_id org_1` → principal with tenant `t1`.
  - `TestRejectsWrongAudience`, `TestRejectsExpired`, `TestRejectsHS256InAuth0Mode` → 401.
  - `TestOperatorPermission`: `permissions:["operate:platform"]`, no `org_id` → `IsOperator true`, `Tenant nil`.
  - `TestFirstLoginCreatesDefaultMembership` (role viewer) and `TestPendingMembershipBoundByEmail` (role admin preserved).
  - `TestContributorScope`: contributor scoped to `Payments` can write `Checkout` data, cannot write `Analytics`; after Analytics moves under Payments in `2026-M07`, can write Analytics for `2026-M07` but not `2026-M06`.
  - `TestViewerCannotWrite`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `github.com/auth0/go-jwt-middleware/v2 v2.3.1` (validator + jwks provider). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(auth): token validation, tenant resolution, scoped authorization`.

### Task 13: API — operator, members, org model

**Files:**
- Create: `api/internal/httpapi/{server.go,errors.go,operator.go,members.go,org.go,org_test.go,members_test.go,testing_test.go}`

**Interfaces:**
- Consumes: Tasks 9, 11, 12.
- Produces: `func NewServer(st store.Store, cal func(domain.Tenant) period.Calendar, now func() time.Time) *Server` implementing the org/member/operator parts of `StrictServerInterface`; `func Handler(s *Server, authMW func(http.Handler) http.Handler) http.Handler`; test helper `newTestAPI(t) (*httptest.Server, tokens map[string]string)` using memstore + dev auth, seeding tenants `t1`, `t2`.
- Every write appends an `AuditEntry` with channel `ui` (or `api` when the token is an API token in phase 5).

- [ ] **Step 1: Write failing tests:**
  - `TestOperatorCreatesTenant`: operator POST → 201; non-operator → 403; the `adminEmail` gets a pending admin membership.
  - `TestOrgUnitsCRUDAndMove`: create levels Company/Segment/Product, units, move with `effectiveMonth 2026-M07`; `GET /org/tree?month=2026-M06` vs `2026-M07` reflect the move.
  - `TestMoveIntoDescendantRejected` → 400 `invalid`.
  - `TestCrossTenantOrgUnit`: tenant `t2` admin PATCHes a `t1` unit ID → 404; GET lists never include `t1` units.
  - `TestMembersAdminOnly`: contributor PATCH `/members/{id}` → 403.
  - `TestAuditOnWrite`: creating a unit yields an audit entry with before `null` and after the unit.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): operator, members, and org model endpoints`.

### Task 14: API — scorecards and methodology versions

**Files:**
- Create: `api/internal/httpapi/{methodology.go,diff.go,methodology_test.go,diff_test.go}`

**Interfaces:**
- Consumes: Tasks 3, 4, 9, 13 (formula, domain validation, store, server).
- Produces: `func DiffMethodology(a, b domain.Methodology) Diff`; `Diff{Added, Removed []string; Changed []MetricChange}`; `MetricChange{Key string; Fields []FieldChange}`; `FieldChange{Field string; From, To any}` (fields compared: name, category, formula, direction, frequency, format, rule, targets, definition, source).
- Rules: only `draft` versions accept PUT (published → 409 `conflict`, message `published versions are immutable`); publish runs `Validate` (errors → 400 with list), sets `published`, marks the previously effective version `superseded` only if the new `EffectiveFrom` is later than its own; `cloneFrom` copies content into a new draft.

- [ ] **Step 1: Write failing tests:** `TestCreateCloneEditPublish`, `TestPublishedImmutable`, `TestPublishValidationErrors` (unknown measure → 400 listing `metrics[0].formula`), `TestStaleRevisionPut` → 409, `TestDiffDetectsThresholdChange` (bands G>=90 → G>=95 shows `rule` change), `TestOnlyAdminsEditMethodology`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): methodology versions, diff, publish`.

### Task 15: API — data entry, preview, history, overrides, view

**Files:**
- Create: `api/internal/httpapi/{data.go,view.go,load.go,data_test.go,view_test.go}`

**Interfaces:**
- Consumes: Tasks 8, 9, 12, 14.
- Produces: `func (s *Server) loadInput(ctx, tenant domain.Tenant, scorecardID string, years []int) (*engine.Input, error)` (fiscal years spanning the requested periods plus the prior year for comparisons).
- Rules: `data:batch` checks `data:write` per write (any failure → 403 for the whole batch, listing forbidden rows); conflicts → 409 with current values and nothing saved; `preview` merges unsaved writes into the input and returns only the cells whose metrics use the written measures; `entry` lists measures × subjects at each metric's `ReportedAt` levels/kinds, filtered by `data:read`, with `canEdit` from `data:write`; overrides require `override:write` (admin) and write an audit entry.

- [ ] **Step 1: Write failing tests:** `TestBatchSaveAndView` (save on_time/committed for two products → view shows segment `84.3%`/`Y` for the 440/522 split), `TestBatchConflict` (409, nothing saved), `TestBatchForbiddenOutsideScope` (403), `TestPreviewDoesNotPersist`, `TestHistoryNewestFirst`, `TestOverrideFootnoteFields` (view cell has `override.reason` and `computed.status`), `TestViewerSeesOnlyScopedRows`, `TestCrossTenantScorecard` → 404, `TestRestateQueryParam`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): data entry, preview, history, overrides, scorecard view`.

### Task 16: Lambda adapter, entrypoints, demo seed

**Files:**
- Create: `api/internal/lambdahttp/{adapter.go,adapter_test.go}`, `api/cmd/api/main.go`, `api/cmd/devserver/main.go`, `api/internal/demo/{seed.go,seed_test.go}`, `api/Makefile`

**Interfaces:**
- Produces:
  - `func Handler(h http.Handler) func(context.Context, events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error)` — maps method, path, multi-value query and headers, base64 bodies (binary when `IsBase64Encoded`), and returns binary responses base64-encoded when `Content-Type` is not text/JSON.
  - `cmd/api`: env `TABLE_NAME`, `UPLOADS_BUCKET`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `CLAIM_NAMESPACE`, `ALLOWED_ORIGIN`, `OPSVISION_AUTH_MODE` (must equal `auth0`, else exit 1 with `refusing to start: OPSVISION_AUTH_MODE must be auth0`). CORS for `ALLOWED_ORIGIN` only.
  - `cmd/devserver` flags: `-addr :8080`, `-store memory|dynamo`, `-table`, `-auth dev|auth0`, `-seed demo|none`, `-dev-secret`; in dev auth, exposes `POST /dev/login {userId}` → token, and `GET /dev/users`.
  - `func demo.Seed(ctx, st store.Store, cal period.Calendar) (tenantID string, err error)` — fictional tenant **"Acme Demo"**: levels Company/Segment/Product; segments Platform, Payments, Data, Mobile, each with two products (Identity, Messaging; Checkout, Billing; Analytics, Pipelines; iOS App, Android App); Analytics moves Data→Platform at `2026-M07`; item kind Services (Public API, Web App, Status Page) attached to Platform; 2025 and 2026 published versions covering the nine metrics of spec §5.11 plus "Open-source risk SLO" by segment (`within_slo / due * 100`, `G>=90, Y>=80, R`); deterministic synthetic data (seeded RNG) for 2025-M01 through 2026-M10, including one 0/0 month and one not-applicable reason; demo users `admin@demo.test`, `contributor@demo.test` (scoped to Payments), `viewer@demo.test`.
  - `api/Makefile` target `build-ApiFunction`: `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -o $(ARTIFACTS_DIR)/bootstrap ./cmd/api`.

- [ ] **Step 1: Write failing tests:** `TestAdapterRoundTrip` (GET with query `periods=2026-M10&periods=2026-M09`, JSON POST body, base64 xlsx body), `TestSeedComputes` (seed into memstore, compute view for `2026-M10`: every row has a status or an NA reason; the demo 0/0 month is NA), `TestDevServerRefusesNoSecret`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Run `go run ./cmd/devserver -seed demo` and `curl -s -X POST localhost:8080/dev/login -d '{"userId":"admin@demo.test"}'` then `GET /v1/scorecards` with the token — returns the demo scorecard.
- [ ] **Step 5: Commit** `feat(api): Lambda adapter, entrypoints, demo seed`.

### Task 17: Minimal XLSX reader

**Files:**
- Create: `api/internal/xlsx/{reader.go,reader_test.go}`, `api/internal/xlsx/xlsxtest/writer.go`

**Interfaces:**
- Produces:
  - `func Open(r io.ReaderAt, size int64) (*Workbook, error)`; limits: max 20 MB uncompressed per part, max 200 sheets (errors beyond).
  - `type Workbook struct{ Sheets []Sheet }`; `type Sheet struct{ Name string; Hidden bool; Cells map[string]Cell; Comments map[string][]Comment }`
  - `type Cell struct{ Ref, Text string; Number *float64; Formula string }` (shared strings, inline strings, numbers, booleans; `Text` always set)
  - `type Comment struct{ Author, Text string; At *time.Time }` (legacy `comments*.xml` and threaded comments with `persons.xml` author names)
  - `func SerialToDate(serial float64) time.Time` (1900 date system)
  - `xlsxtest.Build(t *testing.T, sheets []xlsxtest.Sheet) []byte` — writes a minimal valid .xlsx (shared strings, numeric cells, hidden flag, threaded comments).

- [ ] **Step 1: Write failing tests** using `xlsxtest.Build`: `TestReadsStringsAndNumbers`, `TestHiddenSheets`, `TestThreadedCommentsWithAuthors`, `TestSerialToDate` (`46023` → 2026-01-01), `TestRejectsOversizedPart`, `TestRejectsNonZip`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `archive/zip` + `encoding/xml` (streaming decoder). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(xlsx): minimal reader and test writer`.

### Task 18: Legacy cell and band-text parsers

**Files:**
- Create: `api/internal/legacy/{cell.go,cell_test.go,bands.go,bands_test.go}`

**Interfaces:**
- Produces:
  - `type Kind int` = `Empty, Ratio, Percent, Money, Number, ScoreOfMax, ScoreChange, NotApplicable, Unparsed`
  - `type Parsed struct{ Kind Kind; Num, Den, Value, Max, Change *float64; Status, NAReason, Raw string }`
  - `func ParseCell(raw string) Parsed`
  - `func ParseBandText(green, yellow, red string) ([]domain.Band, error)`

- [ ] **Step 1: Write failing table tests** (synthetic inputs in the same formats as the legacy workbook):

| Input | Expect |
|---|---|
| `48\|66 \| 72% \| Y` | Ratio 48/66, Status Y |
| `8234k\|10471k \| 79% \| G` | Ratio 8234/10471, G |
| `87% (172/198)` | Ratio 172/198 |
| `74/98 (75.5%)` and `100/133(75.2%)` | Ratio 74/98; 100/133 |
| ` 100% (2/2` and `N/A (0/0)` and `0/0 ` | Ratio 2/2; 0/0; 0/0 |
| `$10471k` | Money 10471 |
| `99.64% \| R`, `97.83%\|R`, `99.6% ! R`, `99.36 \| R` | Percent with status R |
| `0.9989` | Number 0.9989 |
| `1587 \| 12% Quality Increase \| G` | ScoreChange 1587, Change +12, G |
| `696 \| 17% Quality Decline \| R` | ScoreChange 696, Change −17, R |
| `2 \| No Change \| Y` | ScoreChange 2, Change 0, Y |
| `16 \| Y`, `17\|Y` | Number with status |
| `4.8 \| 7 \| Y`, `4.4\| 7 \| Y` | ScoreOfMax 4.8/7, Y |
| `No big initiatives`, `No epics`, `Measured Quarterly`, `N/A - Migrated to new platform`, `Moved under Data` | NotApplicable with NAReason = trimmed input |
| `#N/A`, `` | Unparsed; Empty |

  - Bands: `(">=90%", ">=80% < 90%", "< 80%")` → `G>=90, Y>=80, R`; `("<=110%", ">110% <= 120%", "> 120%")` → `G<=110, Y<=120, R`; `("99.9% uptime", "<99.9% >99.8%", "< 99.8%")` → `G>=99.9, Y>99.8, R`; `("<= 14", "14 - 17", "18+")` → `G<=14, Y<=17, R`; unparseable text → error.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (ordered regexes; NA detection = no digits, or a known NA phrase prefix `N/A -`). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(legacy): cell and band-text parsers`.

### Task 19: Legacy workbook adapter and change sets

**Files:**
- Create: `api/internal/changeset/{changeset.go,apply.go,changeset_test.go}`, `api/internal/legacy/{template.go,adapter.go,methodology.go,adapter_test.go,testdata/legacy_sample.xlsx}` (fixture generated by a test helper from synthetic content and committed)

**Interfaces:**
- Consumes: Tasks 9, 17, 18.
- Produces:
  - `type ChangeSet struct{ ID, Source, CreatedBy, Status string; CreatedAt time.Time; Data []store.DataWrite; Overrides []domain.Override; VersionText []VersionTextChange; Notes []LegacyNote; Findings []Finding }`; `Finding{Severity /* info|warn|error */, Sheet, Cell, Message string}`; `VersionTextChange{VersionID, MetricKey, Field, Value string}` (fields: definition, notes, example, source, link, frequency, bands); `LegacyNote{MetricKey, SubjectID string; Period period.Period; Author, Text string; At *time.Time}` (stored in phase 2; phase 1 carries them in the change set and reports their count).
  - `func Apply(ctx context.Context, st store.Store, tenantID, scorecardID string, cs ChangeSet, actor string) error` — data writes with `ExpectedRevision -1`, overrides, version text into **draft** versions only (error if the version is not a draft), one audit entry per change set.
  - `type Template struct{ Sheets []SheetMap; Rows []RowMap; Methodology []MethodologyMap }`
    - `SheetMap{Sheet string; FiscalYear int; LabelColumn string; MonthColumns map[string]int /* "F":1 */; PeriodColumns map[string]string /* explicit, e.g. "F":"2025-Q4" */; YTDColumn string}`
    - `RowMap{Sheet, Section, Label, Metric, Subject, Convert string; Measures map[string]string /* "num","den","value","max" -> measure key */}` with `Convert` ∈ `ratio|value|money_k|uptime_percent|uptime_fraction|score_of_max|score`; `Section` = the nearest preceding label in `LabelColumn` that is itself mapped as a section header (`RowMap` with empty `Metric`).
    - `MethodologyMap{Sheet, VersionID string; Rows map[string]string /* row label -> metric key */; Columns map[string]string /* "C":"definition","D":"green","E":"yellow","F":"red","G":"source","H":"notes","I":"link","B":"frequency" */}`
  - `func ParseWorkbook(wb *xlsx.Workbook, t Template, cal period.Calendar, versions []domain.MethodologyVersion) ChangeSet` — converts cells to data writes; `uptime_percent` writes `seconds_in_period = cal.Seconds(month)` and `seconds_down = round((1 - pct/100) * seconds_in_period)`; recorded status (or value) that differs from the engine's computed result for that cell becomes an override with reason `As reported in legacy workbook`; unmapped non-empty cells in mapped rows and unparsed cells become `warn` findings with sheet and cell ref; comments on mapped cells become `LegacyNote`s.

- [ ] **Step 1: Write failing tests** against `testdata/legacy_sample.xlsx` (synthetic: one data sheet with sections "Epics on time" and "Uptime", two segments, months Jan–Mar, one 0/0 cell, one status that disagrees with the methodology, one threaded comment; one methodology sheet):
  - `TestRatioRowsBecomeMeasures`, `TestUptimePercentConversion` (`99.64%` in a 31-day month → `seconds_in_period 2678400`, `seconds_down 9642`), `TestMismatchBecomesOverride`, `TestZeroOverZeroIsNA`, `TestUnparsedCellFinding` (`#N/A` → warn with `Sheet!I50`-style ref), `TestCommentsBecomeLegacyNotes`, `TestMethodologyTextToDraft` (definition and bands into a draft), `TestApplyRejectsPublishedVersionText`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(legacy): workbook adapter and change sets`.

### Task 20: Import API

**Files:**
- Create: `api/internal/httpapi/{imports.go,imports_test.go}`, `api/internal/objects/{objects.go,s3.go,mem.go}`

**Interfaces:**
- Produces: `objects.Store{ PresignPut(ctx, key string, maxBytes int64, ttl time.Duration) (string, error); Get(ctx, key string) (io.ReadCloser, int64, error) }` with S3 and in-memory implementations; object keys `t/<tenantId>/imports/<importId>.xlsx`; max upload 20 MB; presign TTL 15 min.
- Rules: `parse` reads the object, runs `legacy.ParseWorkbook` with the selected template, stores the change set on the import (`status parsed`); `apply` (admin only) runs `changeset.Apply` (`status applied`); applying twice → 409; templates are tenant-scoped JSON bodies validated against `legacy.Template`.

- [ ] **Step 1: Write failing tests:** `TestUploadParseApply` (in-memory objects, fixture from Task 19), `TestApplyTwiceConflict`, `TestContributorCannotApply` → 403, `TestCrossTenantImport` → 404, `TestTemplateValidation` (unknown `Convert` → 400).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(api): import upload, parse, preview, apply`.

### Task 21: Web foundation

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/eslint.config.js`, `web/index.html`, `web/src/{main.tsx,App.tsx}`, `web/src/auth/{AuthProvider.tsx,devAuth.ts}`, `web/src/api/{client.ts,queries.ts}`, `web/src/shell/{AppShell.tsx,PeriodPicker.tsx,SubjectFilter.tsx,TenantSwitcher.tsx}`, `web/src/ui/{tokens.css,StatusBadge.tsx,Footnote.tsx}`, `web/src/test/{setup.ts,server.ts,fixtures.ts}`, `web/src/shell/AppShell.test.tsx`, `web/src/ui/StatusBadge.test.tsx`
- Modify: root `Makefile` (`gen` also runs `openapi-typescript ../openapi/openapi.yaml -o src/api/schema.d.ts`; `dev` runs devserver + `vite`)

**Interfaces:**
- Produces:
  - `useApi()` returning an `openapi-fetch` client with bearer middleware; `queries.ts` hooks `useMe()`, `useScorecards()`, `useView(sc, req)`, `useEntry(sc, period)`, `useSaveData(sc)`, `usePreview(sc)` (TanStack Query keys `['view', sc, req]` etc.)
  - `AuthProvider`: `VITE_AUTH_MODE=auth0` uses `@auth0/auth0-react` with `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`, organization from `?organization=` or last used; `dev` mode shows a user picker calling `/dev/login`.
  - `AppShell`: top bar (product name, SAM placeholder avatar button with `aria-label="Ask SAM (coming soon)"` disabled, tenant switcher, user menu), left nav (Scorecard, Enter data, Admin: Org, Items, Members, Methodology, Import — admin items hidden for non-admins), period picker (month/quarter/half/year + YTD toggle), subject filter.
  - `StatusBadge({status, label})` renders the letter inside a colored pill with `aria-label` "Status: Green" etc., and "—" with label "No status" when empty.
  - Design tokens in `tokens.css` (Tailwind 4 `@theme`): accent `#5B4BDB`, accent-deep `#3F33A8`, cream `#FFF6E5`, amber `#F5A524`, ink `#1D2433`, status G `#137A3A` on `#E3F6EA`, Y `#8A5A00` on `#FFF3D6`, R `#B42318` on `#FDE4E2`, NA `#8A93A6` on `#EEF0F4`.

- [ ] **Step 1:** Create the app with the pinned versions; `npm ci`; `npm run gen` creates `schema.d.ts`.
- [ ] **Step 2: Write failing tests:** `AppShell.test.tsx` (renders nav for admin; hides admin nav for viewer; `axe` reports no violations via `vitest-axe`), `StatusBadge.test.tsx` (each status renders letter and accessible label; empty renders "No status").
- [ ] **Step 3:** `npm test` FAIL. **Step 4:** Implement. **Step 5:** `npm test`, `npm run lint` (with `jsx-a11y` recommended rules as errors), `npm run typecheck`, `npm run build` all PASS.
- [ ] **Step 6: Commit** `feat(web): app foundation, auth, API client, shell`.

### Task 22: Web — Table tab and cell drawer

**Files:**
- Create: `web/src/features/scorecard/{ScorecardPage.tsx,TableTab.tsx,CellDrawer.tsx,TableTab.test.tsx,CellDrawer.test.tsx}`

**Interfaces:**
- Consumes: `useView`, `StatusBadge`, `Footnote`; `GET /history`; `PUT|DELETE /overrides`.
- Produces: route `/scorecards/:sc` with Radix Tabs `Charts` | `Table` (default tab remembered per user in `localStorage`); `TableTab` renders a semantic `<table>`: rows grouped by category (group header rows), metric rows expandable to subjects (button with `aria-expanded`), columns = requested periods + YTD; each cell shows `display` + `StatusBadge`, NA reason in muted text, override footnote marker `†` linked to a footnote list below the table ("Overridden by <by> on <date>: <reason>"); clicking a cell opens `CellDrawer` (Radix Dialog) with components (e.g., 440 / 522), coverage, target, change, methodology version, revision history, and for admins an override form (status select from the tenant scale, optional value, optional reason) and "Clear override". A "View under methodology…" select in the tab header sets `restate`; while set, a banner reads "Restated under <version name>. Stored results are unchanged." with a "Back to as-reported" button. A "Structure" toggle (as of each month / today's structure) sets `structure`.

- [ ] **Step 1: Write failing tests** (MSW fixtures from `fixtures.ts`): renders category groups and statuses with letters; selecting a restatement version adds `restate=<id>` to the request and shows the banner; NA cell shows reason and no badge color; overridden cell shows `†` and footnote text; expanding a metric shows subjects; drawer shows `440 / 522`; non-admin drawer has no override form; admin override PUT sends `{metricKey, subjectId, period, status, reason}`; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): scorecard table view and cell drawer`.

### Task 23: Web — Charts tab

**Files:**
- Create: `web/src/features/scorecard/{ChartsTab.tsx,MetricTile.tsx,ChartsTab.test.tsx}`, `web/src/ui/Sparkline.tsx`

**Interfaces:**
- Consumes: `useView` with the selected period plus the 11 prior months for the selected subject (default: top-level unit).
- Produces: summary strip (counts per status); category sections of `MetricTile`s: metric name, current `display`, `StatusBadge`, `Sparkline` (Recharts line, goal line as dashed reference line when a target exists, threshold band shading for the green band), secondary line with components (e.g., `440 / 522`) and change vs prior period ("+2.1 pts vs Sep" / "17% worse vs Sep · lower is better"); each tile is a link to the metric's Table rows; every sparkline has a visually hidden text summary ("Trend over 12 months: from 76% to 84%; goal 90%").

- [ ] **Step 1: Write failing tests:** tiles grouped by category; tile shows display, status letter, components, change text with direction wording for `lower_better`; sparkline summary text present; NA current period shows the reason; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): scorecard charts view`.

### Task 24: Web — Entry grid

**Files:**
- Create: `web/src/features/entry/{EntryPage.tsx,EntryGrid.tsx,pasteParser.ts,pasteParser.test.ts,EntryGrid.test.tsx}`

**Interfaces:**
- Consumes: `useEntry`, `useSaveData`, `usePreview`.
- Produces:
  - `parseEntryValue(raw: string): {kind:'empty'} | {kind:'value', value:number} | {kind:'na'} | {kind:'error', message:string}` and `parsePaste(tsv: string): string[][]`.
  - Grid: rows = measure × subject (grouped by metric), columns: subject, measure, value, not-applicable reason, derived metric preview (value + status from `/preview`, debounced 400 ms); keyboard: arrows move, Enter/F2 edit, Enter commits and moves down, Tab moves right, Esc cancels; paste of a block fills from the focused cell; dirty cells highlighted; Save sends one batch with each row's `expectedRevision`; a 409 marks conflicting rows, shows "Changed by someone else: now <value>" with "Use theirs" / "Keep mine" (keep mine resubmits with the new revision); rows with `canEdit false` are read-only.

- [ ] **Step 1: Write failing tests:** `pasteParser.test.ts`: `"84%"`→84, `"1,234"`→1234, `" 12 "`→12, `"$10k"`→10000, `""`→empty, `"n/a"` and `"N/A"`→na, `"abc"`→error, `"1.2.3"`→error, `"-5"`→-5; `parsePaste("1\t2\n3\t4\n")` → `[["1","2"],["3","4"]]`. `EntryGrid.test.tsx`: typing and Enter moves down; pasting a 2×1 block fills two rows; error cell blocks Save with message; preview shows derived status; 409 response shows the conflict prompt and "Use theirs" replaces the value; read-only rows reject input.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): keyboard-first data entry grid`.

### Task 25: Web — Admin: org, items, members

**Files:**
- Create: `web/src/features/admin/{OrgPage.tsx,ItemsPage.tsx,MembersPage.tsx,OrgPage.test.tsx,MembersPage.test.tsx}`

**Interfaces:**
- Consumes: org, item, and member endpoints (Task 11).
- Produces: OrgPage — editable level names and order; tree view as of a selected month; add/rename/retire unit; edit source keys; "Move…" dialog with new parent and effective month, showing the resulting tree preview. ItemsPage — kinds and items, attach to org unit. MembersPage — list members, change role, set scope (org units multi-select, metrics multi-select), add pending member by email.

- [ ] **Step 1: Write failing tests:** rename a level; move dialog posts `{newParentId, effectiveMonth}` and tree as-of toggle reflects it; member role change PATCH; scope selection PATCH; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): org, items, and members admin`.

### Task 26: Web — Methodology editor and Import page

**Files:**
- Create: `web/src/features/admin/{MethodologyPage.tsx,MetricForm.tsx,ImportPage.tsx,MethodologyPage.test.tsx,ImportPage.test.tsx}`

**Interfaces:**
- Consumes: version, diff, validate, publish, import, and template endpoints.
- Produces: MethodologyPage — version list with status chips; "New draft from…"; draft editor: categories list, measures table (key, name, unit, org/time aggregation selects), metrics list with `MetricForm` (name, category, formula with inline validation result from `/validate`, direction, frequency, format, reported-at levels/kinds, rule type with a bands table editor, comparison select, definition/notes/source/link) and an "Advanced (JSON)" panel for targets and per-subject bands; diff view against the current published version; Publish dialog with effective month. ImportPage — upload .xlsx, pick a saved template (or paste template JSON for admins), Parse → preview: counts (data points, overrides, version text, legacy notes), findings table filterable by severity with sheet/cell refs, sample of changes; Apply (admin) with confirmation.

- [ ] **Step 1: Write failing tests:** formula validation error shows under the field; publish dialog sends `{effectiveFrom}`; diff view lists a changed threshold; import preview shows counts and a warn finding with its cell ref; Apply disabled for contributors; `axe` no violations.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): methodology editor and import page`.

### Task 27: Infrastructure templates and access modes

**Files:**
- Create: `infra/app.yaml`, `infra/edge.yaml`, `infra/samconfig.example.toml`, `infra/README.md`

**Interfaces:**
- `app.yaml` (SAM) parameters: `Stage`, `Auth0Domain`, `Auth0Audience`, `ClaimNamespace`, `AllowedOrigin`, `AccessMode` (`public|allowlist`), `AllowedCidrs` (CommaDelimitedList), `ApiDomainName`/`ApiCertificateArn` (optional). Resources: DynamoDB table `opsvision-${Stage}` (PK/SK + GSI1, on-demand, PITR on, `DeletionProtectionEnabled: true`, `DeletionPolicy: Retain`); uploads bucket (block public access, SSE-S3, CORS PUT from `AllowedOrigin`, lifecycle expire 30 days); REST API (regional) with `/{proxy+}` → `ApiFunction` (`provided.al2023`, `arm64`, `BuildMethod: makefile`, CodeUri `../api`, 512 MB, 29 s timeout); in `allowlist` mode a resource policy denying `execute-api:Invoke` when `aws:SourceIp` is not in `AllowedCidrs`; least-privilege IAM (table + index, bucket prefix `t/*`). Outputs: `ApiUrl`, `TableName`, `UploadsBucket`.
- `edge.yaml` parameters: `Stage`, `AccessMode`, `AllowedCidrs`, `DomainName`, `CertificateArn`, `HostedZoneId` (all optional except `Stage`). Resources: private SPA bucket, CloudFront with OAC, SPA fallback (403/404 → `/index.html` 200), response headers policy (HSTS, `X-Content-Type-Options`, `Referrer-Policy`, CSP allowing self, the API origin, and the Auth0 domain), WAFv2 WebACL (scope `CLOUDFRONT`, deploy in `us-east-1`) with an IP set allow rule and default block — created only when `AccessMode=allowlist`; Route 53 alias when `HostedZoneId` is set.
- `AccessMode=private` is not implemented in phase 1; the templates fail fast with a clear message if used. If the network check (spec §10.2.1) requires it, add a follow-up task.

- [ ] **Step 1:** Write templates. **Step 2:** `sam validate --lint -t infra/app.yaml` and `sam validate --lint -t infra/edge.yaml` — PASS. **Step 3:** `sam build -t infra/app.yaml` produces `bootstrap` for arm64. **Step 4:** Deploy to the project's demo account (`sam deploy --guided` once, saving `samconfig.toml` locally, not committed); `curl $ApiUrl/v1/me` → 401 JSON error. **Step 5:** Deploy once with `AccessMode=allowlist` and an allowlist excluding your IP → API returns 403 and CloudFront returns 403; switch back to `public`.
- [ ] **Step 6: Commit** `feat(infra): SAM app and edge templates with access modes`.

### Task 28: Auth0 configuration and private deployment guide

**Files:**
- Create: `infra/auth0/{package.json,tenant.yaml,config.example.json,README.md}`, `docs/deploy/private-deployment.md`, `docs/user/getting-started.md`

**Interfaces:**
- `tenant.yaml` (Auth0 Deploy CLI format, keyword replacement `##KEY##`): resource server `##API_AUDIENCE##` with RBAC enabled, "add permissions in the access token" on, permission `operate:platform`; SPA application with callback/logout/web origins `##APP_URL##`, organization usage `allow`, organization prompt `post_login_prompt`; post-login Action adding `##CLAIM_NAMESPACE##email` and `##CLAIM_NAMESPACE##name` to the access token.
- `private-deployment.md`: how to create the private deployment repo (pinned public release tag, `samconfig.toml`, edge parameters, Auth0 `config.json`, GitHub OIDC role), how to configure `AccessMode=allowlist` with VPN CIDRs, how to create the tenant (operator `POST /v1/operator/tenants`), how to connect enterprise SSO to the Auth0 organization with auto-membership, how to import the legacy workbook with a private template (template file stays in the private repo).

- [ ] **Step 1:** `cd infra/auth0 && npm ci && npx a0deploy import --config_file config.json --input_file tenant.yaml` against the maintainer's dev Auth0 tenant — succeeds; sign in through the deployed demo SPA with an organization member and see `/v1/me` return the tenant.
- [ ] **Step 2:** Run `make denylist` with the private list — PASS.
- [ ] **Step 3: Commit** `docs(deploy): Auth0 configuration and private deployment guide`.

### Task 29: CI and deploy workflows

**Blocked until the maintainer supplies vetted versions (commit SHAs) for the GitHub Actions used: checkout, setup-go, setup-node, configure-aws-credentials, setup-sam.**

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`

**Interfaces:**
- `ci.yml` on pull request and push to `main`: jobs `go` (`go vet ./...`, `go test ./...`), `web` (`npm ci`, `lint`, `typecheck`, `test`, `build`), `contract` (`make gen-check`), `infra` (`sam validate --lint` both templates), `denylist` (`scripts/check-denylist.sh` with `OPSVISION_DENYLIST` from a repository secret; fails if the secret is missing on `main`).
- `deploy.yml` as `workflow_call` (used by the public demo and by the private deployment repo) with inputs `stage`, `samconfig_path`, `edge_params`, `web_env`, `aws_role_arn`, `ref`: OIDC to AWS, `sam build && sam deploy`, deploy `edge.yaml`, build web with `web_env`, `aws s3 sync dist/` to the SPA bucket, CloudFront invalidation.

- [ ] **Step 1:** Write workflows with the supplied pins. **Step 2:** Open a PR; all CI jobs green. **Step 3:** Run the demo deploy from `main`; demo SPA loads and lists the demo scorecard.
- [ ] **Step 4: Commit** `ci: build, test, contract, infra, name guard, and deploy workflows`.

### Task 30: End-to-end smoke and POC acceptance

**Files:**
- Create: `web/e2e/smoke.spec.ts`, `web/playwright.config.ts`, `docs/user/poc-checklist.md`

**Interfaces:**
- Consumes: devserver with `-seed demo -auth dev`.
- Produces: Playwright test that signs in as `admin@demo.test`, opens the scorecard Table tab for `2026-M10`, verifies a green, a yellow, a red, and an NA cell; enters a value in the grid that flips a status and sees the preview, saves, and sees the Table update; opens a cell drawer and sets an override, then sees the footnote; runs `@axe-core/playwright` on Table, Charts, Entry, and Methodology pages with no serious or critical violations. `poc-checklist.md`: steps to stand up the private environment, import the real workbook with a private template, and review the import report with the program management team.

- [ ] **Step 1: Write the failing e2e test.** **Step 2:** `npx playwright test` FAIL (before wiring `webServer`), then configure `webServer` to start devserver + vite. **Step 3:** PASS.
- [ ] **Step 4:** Rehearse the backfill with `api/internal/legacy/testdata/legacy_sample.xlsx` through the Import page against devserver; the import report counts match `TestRatioRowsBecomeMeasures` expectations.
- [ ] **Step 5: Commit** `test(e2e): POC smoke test and acceptance checklist`.
