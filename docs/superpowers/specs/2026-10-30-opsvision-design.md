# OpsVision — Design

Status: draft for maintainer approval
Date: 2026-10-30

## 1. Intent

OpsVision is an open-source (MIT), multi-tenant web application for running an operational metrics program: delivery, quality, uptime, security, and whatever else an organization chooses to measure. It replaces a hand-maintained spreadsheet process.

Today's process, as observed in the first adopter's workbook:

- Numbers are computed upstream (issue trackers, BI dashboards, ideas portals, training platforms, uptime monitors) and typed into cells by hand as text, e.g. `48|66 | 72% | Y` (numerator, denominator, percent, status).
- The methodology (definitions, thresholds, sources) changes every year and lives on separate tabs per year. Metrics are added, dropped, and redefined.
- The reporting hierarchy changes yearly and sometimes mid-year ("moved under Data" from July).
- Cell comments carry the workflow: assigning who collects a number, explaining misses, questioning figures, celebrating a first green.
- Recurring outputs are copied out by hand: a quarterly board-deck view and a multi-year lookback.

OpsVision makes the metric framework explicit and versioned, computes rollups and statuses instead of having people type them, runs the monthly collection ("close"), and adds **SAM**, an AI guide (a wise owl) that answers questions about metrics and trends, explains the tool and methodology, helps update data, and drafts a monthly business one-pager.

**Why now / success:** the first adopter (the maintainer's organization) runs its first real monthly close in OpsVision in early January 2027 for December 2026 numbers, with the spreadsheet retired after that cycle.

## 2. Users and roles

- **Platform operator:** runs a deployment; creates tenants; sets the allowed AI models and defaults.
- **Tenant admin (program manager):** owns the methodology, org hierarchy, metrics, the close, and briefs.
- **Contributor:** enters and corrects data for assigned metrics and org units; comments.
- **Viewer:** reads dashboards, tables, and briefs (executives: CIO, CISO, business leadership).
- **Reviewer (optional, per methodology draft):** comments on draft methodology versions.

Contributor and viewer roles can be scoped to an org-unit subtree, a set of metrics, or both.

## 3. Goals, non-goals, anti-goals

**Goals**

1. A framework general enough that a tenant can define new categories, metrics, measures, rollups, and hierarchies without code changes.
2. Versioned methodology with a clear diff between versions and frozen history.
3. A monthly close that is faster than updating the spreadsheet.
4. Beautiful chart views and a dense table view of the same data.
5. A monthly brief: live month-to-date, published history, audience versions, exportable.
6. SAM, model-agnostic on Amazon Bedrock, safe enough to run on a low-cost model.

**Non-goals (v1)**

- Not a BI tool or data warehouse; no ad hoc query builder.
- No built-in connectors (issue trackers, BI tools, monitors). The ingestion API and file import cover automation.
- No connectors or scheduled pulls for item-level records (each defect, epic, concept). Records arrive by monthly file upload in v1; see `2026-10-31-records-ingestion-design.md`.
- No billing or self-serve signup by default.
- No native mobile app; the web app is responsive.

**Anti-goals (failure even if it "works")**

- SAM states a number that is not in the data, or does arithmetic itself.
- Data entry is slower or more confusing than typing into the spreadsheet.
- The product is locked to one AI model or vendor.
- Any mention of the first adopter's company, products, people, or data appears in the public repository.

## 4. Constraints

- **Open source:** MIT license, public GitHub repository. No company names anywhere in code, docs, fixtures, commit messages, or screenshots. Seed and demo data use a fictional company. The real workbook is never committed; it is imported through the app into the maintainer's private instance only.
- **Mono-repo** containing frontend, backend, infrastructure, and docs.
- **Stack:** React + TypeScript frontend; Go backend.
- **AWS shape mirrors the maintainer's existing app ("task-vision"):** static SPA on S3 + CloudFront + Route 53 + ACM; API Gateway in front of a Lambda; DynamoDB; Auth0 for identity; GitHub Actions for deploys. All AWS infrastructure is CloudFormation through AWS SAM (Terraform provider versions could not be vetted through the dependency process, so Terraform is not used). Auth0 configuration is managed with the Auth0 Deploy CLI.
- **Identity:** Auth0, multi-tenant via Auth0 Organizations.
- **AI:** Amazon Bedrock, model chosen by configuration. The maintainer expects to use a Kimi model; confirm availability in the target region and native tool-use support through the Bedrock Converse API before relying on it.
- **Dependencies:** versions are selected during planning through the maintainer's dependency-vetting process; the plan must not pin versions from memory.
- **First adopter's deployment:** runs in the first adopter's own AWS accounts and is reachable **only from the company VPN**. Deployment specifics (domain, account IDs, Auth0 tenant, network allowlists, Terraform state) live in a **private deployment repository** in the company's GitHub, which deploys a pinned release of the public repo. The public repo contains only generic, variable-driven infrastructure and the project's own demo environment (demo data only).
- **Data approval gate:** the first adopter must approve sending internal metric data to Amazon Bedrock and the chosen model before SAM is enabled on real data (phase 3).
- **Timeline:** POC on real data by about 2026-11-20, iterate with the program management team, **full scope** production-ready by 2027-01-01. Built by the maintainer working with AI agents.
- **Accessibility:** WCAG 2.2 AA. Status is never conveyed by color alone (always a letter or icon plus color).

## 5. Domain model (the framework)

Everything below is tenant-scoped.

### 5.1 Org units and levels

- A tenant defines **levels** with its own names and order, e.g. Company → Segment → Product, or Company → Subsidiary → Business unit → Team. Unlimited depth.
- **Org units** form a tree. Each has a name, level, parent, and optional **source keys** (labels used by external systems, e.g. the product field value in an issue tracker) used to auto-match imported rows.
- The tree is **effective-dated**: a move ("Product X moves under Data on 2026-07-01") is recorded with an effective date. Periods before the date roll up the old way; periods after, the new way. Org units keep a stable identity across moves, renames, and retirement.
- The org tree is tenant-wide and versioned by effective date, separately from methodology versions (reorgs happen on their own schedule).
- **As-of rollup semantics:** each month's data counts toward the parent the unit belonged to *in that month*. Quarter, half, YTD, and annual totals are the sum of those monthly rollups, so if Product X moves from Segment A to Data on July 1, Data's 2026 YTD includes Product X's July onward and Segment A keeps January–June. Prior-period and prior-year comparisons use the same rule. The restatement view (§5.3) can additionally show any range rolled up under today's structure for comparison.

### 5.2 Tracked items

- Non-org things that are measured: monitored services, private-cloud customer environments, vendors, etc.
- Grouped by **kind** (tenant-defined: "Services", "Vendors", ...).
- Each item may be **attached to an org unit**. A metric reported per item can optionally roll up into the attached org unit.

### 5.3 Scorecards and methodology versions

- A tenant has one or more **scorecards** (e.g. "Service Fulfillment").
- A scorecard has **methodology versions**, named by year and revision (e.g. `2026 v1.2`), each with status `draft → in review → published → superseded` and an **effective-from date**.
- A version contains: categories, measures, metrics (definitions, formulas, thresholds, targets, frequency, source, notes, worked examples, external links), and the list of org levels / item kinds each metric is reported at.
- **History is frozen:** a period's status is always evaluated under the version in force for that period. A **restatement view** shows any range of periods re-evaluated under another version for comparison; it never changes stored results.
- Publishing shows a **diff** against the current version (added, removed, changed metrics; changed thresholds and formulas) and a preview of recent months scored under the draft.

### 5.4 Categories

Tenant-defined groupings for display and briefs (e.g. Delivery, Quality, Engineering, Security, Design, Product). Names can change between versions.

### 5.5 Measures (raw inputs)

- What people enter or import: e.g. `epics_committed`, `epics_on_time`, `planned_spend_k`, `actual_spend_k`, `defect_points_sum`, `defect_days`, `seconds_down`, `seconds_in_period`, `trained_count`, `headcount`, `idea_age_days_sum`, `idea_count`, `a11y_score`, `a11y_max`.
- Each measure has a unit and **an aggregation rule per axis**:
  - **Org axis** (children → parent): `sum`, `min`, `max`, `latest`, or `none` (does not roll up).
  - **Time axis** (months → quarter → half → year/YTD): `sum`, `average`, `latest`, `min`, `max`.
- Averages are modeled as sum ÷ count measures so they roll up correctly (e.g. average idea age = `idea_age_days_sum / idea_count`).

### 5.6 Metrics (computed)

- A **formula** over measures (e.g. `epics_on_time / epics_committed`, `1 - seconds_down / seconds_in_period`, `actual_spend_k / planned_spend_k`).
- **Rollups recompute the formula from rolled-up measures** (ratio of sums), never average child percentages. Example: a segment's on-time rate is Σ on-time ÷ Σ committed across its products.
- Attributes: unit and display format, **direction** (higher is better / lower is better), **frequency** (monthly, quarterly, biannual, annual), levels/kinds reported at, owner, due rule, source description, external link (e.g. a BI dashboard URL).
- **Status rules** map a value to a status on the tenant's **status scale** (default Green / Yellow / Red; tenants can define others, e.g. A–F grades). Rule types:
  - **Bands** on the value (≥ 90% green, ≥ 80% yellow, else red). Bands can be overridden per org unit or tracked item (uptime goals differ by service).
  - **Change versus a comparison** (prior period, prior-year average, baseline), with bands on the percent change and direction-aware wording ("17% quality decline").
  - **Score scale** (value-to-grade table).
- **Targets** per period (baseline, H1 goal, H2 goal, annual goal), with per-unit overrides. Targets are display lines and brief inputs; status rules decide color.
- **Not applicable** is a first-class state with a reason ("No qualifying initiatives ended this month"), distinct from "missing".

### 5.7 Periods

- Monthly base grain. Quarterly/biannual/annual metrics hold data at their own grain.
- **Fiscal year start** is configurable per tenant.
- Computed views: month, quarter, half, year, YTD, and "month to date" for the open month.

### 5.8 Data points

- A value for one measure at one (org unit or tracked item, period).
- Carries: value or not-applicable reason, source (grid / import / SAM / API), entered by, entered at, **revision history**, evidence (links and file attachments), and a **comment thread**.
- Metric values and statuses for every level and period are derived, never stored as typed text, except for overrides (§5.8.1).

#### 5.8.1 Overrides

- A tenant admin can override the computed **value or status** of any metric cell (metric × org unit or item × period) at any time, including locked periods.
- An override stores the overriding value/status, who, when, and an optional comment, and writes an audit entry. The computed result is kept alongside it.
- Overridden cells carry a **footnote marker** everywhere they appear (Charts, Table, metric detail, briefs, exports): "Overridden by <admin> on <date>", plus the comment if any. Clearing the override restores the computed result.
- **Imported history:** where the legacy workbook's recorded status or value disagrees with the computed one, the importer creates an override automatically with the reason "As reported in legacy workbook" and lists all such cells in the import report.
- SAM must say when a value it cites is overridden, and quote the reason.

### 5.9 Comments

Threads on data points, metrics, periods, and briefs. Support @mentions (notify), "assign to" (with due date), and resolve. These replace the workbook's cell comments.

### 5.10 Audit log

Every write records who, when, through which channel (UI, import, SAM change set, API), and before/after values.

### 5.11 Worked mappings from the workbook (validation cases)

| Workbook metric | Measures | Formula | Org rollup | Time rollup | Status rule |
|---|---|---|---|---|---|
| Epics delivered on time | committed, on_time | on_time / committed | sum both | sum both | bands ≥90 G, ≥80 Y |
| Concepts delivered on budget | measured, within_budget | within / measured | sum | sum | bands ≥90 / ≥80 (goal 80%) |
| Spend vs plan | planned_k, actual_k | actual / planned | sum | sum | bands ≤110 G, ≤120 Y (lower is better) |
| Concepts delivered expected value (quarterly) | measured, delivered | delivered / measured | sum | sum | bands ≥90 / ≥80 |
| Weighted defect score (MTD/YTD average) | points_sum, days | points_sum / days | points: sum; days: max (same calendar days for every unit) | sum both | change vs prior month (MTD) or prior-year average (YTD), lower is better |
| Uptime | seconds_down, seconds_in_period | 1 − down / period | none by default (per service) | sum both | bands ≥99.9 G, >99.8 Y |
| Security training completion | trained, headcount | trained / headcount | sum | latest | bands ≥90 / ≥70 |
| Customer feedback SLO | age_days_sum, idea_count | sum / count | sum | sum | bands ≤14 G, ≤17 Y (lower is better) |
| Accessibility compliance (biannual) | score, max | score / max | none | latest | bands ≥80 / >60 |

The workbook's written defect-score thresholds are internally inconsistent; the recorded statuses imply: any improvement → green, decline 0–5% → yellow, decline > 5% → red. The importer compares each recorded status with the computed one; mismatches become "as reported" overrides (§5.8.1) and appear in the import report for the admin to review.

The first adopter will add an "open-source risk policy SLO" metric reported by segment; it must be configurable through the UI with no code change.

## 6. Workflows

### 6.1 Methodology authoring

- The admin creates a draft version (usually by cloning the current one) and edits categories, measures, metrics, formulas, rules, and targets in the UI. Formulas are validated on save (unknown measures, division by zero handling, unit mismatches).
- Optional reviewers comment on the draft. The admin publishes. SAM can draft changes for review but cannot publish.
- Every metric has a rich-text definition, notes, and a worked example (the workbook already has these).

### 6.2 Monthly close

- Each metric (optionally per org unit) has an **owner**, a **due rule** (e.g. 8th business day after month end), and a **reminder schedule**.
- A **close board** shows, for the open period, each expected data point as received / late / questioned / not applicable, by owner.
- The admin **locks** the period when complete. Edits after locking are allowed for admins only, are logged as revisions, and flag any published brief for that period as "data revised since publication".
- Reminders and @mentions go by **email**, plus an optional per-tenant **Slack incoming webhook**.

### 6.3 Data entry

- A spreadsheet-like grid per period: rows are measures × org units (or items), filtered to what the user owns. Keyboard-first (type, Tab, Enter), paste from a spreadsheet, inline not-applicable reason, inline comment.
- Derived metric values and statuses update live as inputs change.

### 6.4 Import and export

- **Import** Excel (.xlsx) or CSV. Parsing is deterministic Go code. The user (or SAM) maps columns/rows to measures, org units, and periods; the mapping is saved as a **template** for repeat monthly uploads. Every import produces a **preview change set** (adds, changes, conflicts, unmatched rows) that the user applies.
- **Records import:** monthly uploads of raw defects and work units (tracker exports), deduplicated, with guided mapping and measures derived by versioned rules. Specified in `2026-10-31-records-ingestion-design.md`.
- **Legacy scorecard adapter:** parses the workbook's text cell formats (`48|66 | 72% | Y`, `87% (172/198)`, `74/98 (75.5%)`, `$10471k`, `99.64% | R`, free-text not-applicable reasons) into measures plus a recorded status. This is generic and ships in the repo; the mapping template for the first adopter's workbook lives only in their tenant.
- **Backfill:** the first adopter imports the 2022 baseline through 2026 data, and the 2024, 2025, and 2026 methodology tabs as published versions, through the shipped importer. 2022–2023 have no methodology tab; they are scored under a "Legacy (pre-2024)" version cloned from 2024, with mismatches handled as overrides.
- **Legacy cell comments** from the workbook are imported (phase 2) as read-only "legacy notes" on the matching data point or metric, with author names kept as plain text (not matched to user accounts).
- **Export:** Excel export of any table view (round-trips with import); PDF and PNG of dashboards, the board-deck view, and briefs.

### 6.5 Ingestion API

- Tenant-scoped API tokens (shown once, stored hashed), each scoped to measures and/or org units.
- `POST` data points with the same validation as the grid; writes are revisions with channel `api`. Locked periods reject writes.

## 7. Views

All views share one period picker and segment/org-unit filter.

- **Charts tab:** tiles per metric grouped by category: value, status, sparkline with goal line, change vs prior period, numerator/denominator. SAM's short take and close progress on the side.
- **Table tab:** heatmap of metrics (rows, grouped by category; expandable to org units) by period (columns, plus YTD). Cells show value and status letter. Click a cell for trend, comments, evidence, and the methodology in force.
- **Monthly brief tab:** see §8.
- **Metric detail:** trend with threshold bands and target line, small multiples per org unit, comment timeline, methodology panel with version history.
- **Board-deck view:** quarterly columns for a curated set of metrics (admin-configured), exportable.
- **Multi-year lookback:** annual columns for a curated set of metrics.
- **Close board** (§6.2), **methodology pages** (current, drafts, diff, history), **admin** (org tree, items, users and roles, notifications, AI model choice, API tokens).

UI uses Tailwind and Radix primitives (as in task-vision) and Recharts or an equivalent charting library; final choices go through dependency vetting.

## 8. Monthly brief

- One brief per scorecard per month (and per quarter), plus **audience versions** defined by the admin (e.g. a CISO version leading with security and uptime). All versions come from the same numbers.
- **Live month-to-date:** the open month always has a live draft. Numbers on the page are always live from computed data. SAM regenerates the narrative after data changes, debounced to at most once per hour per brief. A banner shows the last update time and trigger, and a "still waiting on" section lists missing data points.
- **Admin edits are protected:** once the admin edits a section, SAM stops rewriting it and instead flags "numbers changed since your edit".
- **Publish** (on or after locking the month) freezes text, numbers, and methodology version. Later corrections show "data revised since publication" with a link; the published brief never silently changes.
- **History:** a rail lists past monthly and quarterly briefs; any can be opened and exported (PDF, image).
- Structure (default, admin-editable template): headline; key metrics strip; going well; needs attention; still waiting on (live only); notable streaks and firsts; methodology version footer.

## 9. SAM (AI agent)

### 9.1 Principles

- **SAM never does arithmetic.** Every number comes from a tool that computes it in Go. The model selects tools and writes language.
- **SAM never writes directly.** Write tools produce **change sets** the user reviews as a diff card and applies. Applying goes through the normal API with the user's permissions; SAM can never exceed the user's rights. Methodology changes always land as a draft version.
- **Tenant and user come from the verified token**, never from model output.
- Uploaded file contents and comments are treated as data, never as instructions.

### 9.2 Capabilities

- Answer questions about metrics, statuses, and trends ("Why is Data red on on-time delivery?", "How has quality trended since last year?").
- Explain the tool and methodology ("How do I add a metric?", "What changed between 2025 and 2026?").
- Update data from chat or an uploaded Excel file (via change sets).
- Draft methodology changes (via draft versions).
- Draft and refresh monthly briefs and audience versions.
- Context-aware: knows the page, period, metric, or cell the user is looking at.

### 9.3 Tools (initial set; builder may refine)

Read: `get_scorecard(period, filter)`, `get_metric(metric, version)`, `get_series(metric, unit, range)` returning precomputed trend facts (change vs prior period and prior year, 3-period average, streaks, first-ever status, distance to threshold and target), `explain_status(metric, unit, period)`, `compare_units(metric, period)`, `get_comments(target)`, `diff_versions(a, b)`, `get_close_status(period)`, `search_docs(query)`.

Write (change sets only): `propose_data_updates`, `propose_comment`, `propose_methodology_change`, `import_file(upload_id, template?)`.

### 9.4 Knowledge

- Product documentation lives in `docs/` and is bundled into the agent. The corpus is small; search it in memory (keyword ranking). No vector database or managed knowledge base in v1.
- Tenant methodology content is reached through tools, not the doc index.

### 9.5 Runtime and models

- Separate Go Lambda for SAM with **streamed responses** (chat turns with several tool calls can exceed API Gateway's integration timeout). The builder verifies the Go streaming approach (e.g. Lambda function URL response streaming) during planning and picks a fallback if needed.
- Bedrock **Converse API** with native tool use; model ID is configuration. The platform operator sets a default and an allowed list; a tenant admin picks from the list. A startup/config-time check rejects models without tool-use support.
- Conversations are stored per user (retention configurable; default 90 days). No memory shared across users.
- Per-tenant monthly token budget and rate limits; usage recorded per tenant and user.

### 9.6 Evaluation

A checked-in set of questions with expected answers against the demo tenant (numbers, statuses, explanations, refusal to invent data). Run on demand and before changing a deployment's model; not on every CI push.

### 9.7 Persona

Calm, precise, warm, a little dry humor. Cites the methodology version when explaining a status. Visual design per `docs/brand/sam-creative-brief.md`.

## 10. Architecture

### 10.1 Repository layout

```
web/        React + TypeScript (Vite), Tailwind, Radix, charts
api/        Go: HTTP API Lambda, SAM agent Lambda, workers (briefs, reminders, imports)
  engine/   metric engine: formulas, rollups, status rules, restatement (pure Go, heavily tested)
infra/      AWS SAM / CloudFormation templates (Lambdas, API Gateway, DynamoDB, S3, CloudFront, WAF, ACM, Route 53)
            Auth0 Deploy CLI tenant configuration
docs/       user and admin docs (also SAM's knowledge), specs, brand
openapi/    API contract; generates Go types/server stubs and the TypeScript client
```

### 10.2 AWS

- SPA: S3 + CloudFront + Route 53 + ACM.
- API: API Gateway → single Go Lambda (router inside), `provided.al2023`, arm64.
- SAM agent: separate Go Lambda with streaming.
- Workers: brief regeneration (debounced via queue), reminder scheduler (EventBridge Scheduler), large imports.
- Data: DynamoDB single table, partitioned by tenant; S3 for uploads, attachments, and exports.
- Email: Amazon SES. Slack: per-tenant incoming webhook URL stored encrypted.
- Environments: the public project's `demo` environment (demo data only); the first adopter's environments are defined in their private deployment repo. Deploys use GitHub Actions with OIDC to AWS.
- Region: `us-east-1` by default (as task-vision), pending confirmation that the chosen Bedrock model and SES are available there.

### 10.2.1 Network access modes

The infrastructure supports a per-deployment access mode, so private deployments need no code changes:

- **Public:** CloudFront and API Gateway open to the internet (the demo environment).
- **IP allowlist (default for private deployments):** AWS WAF on the SPA's CloudFront distribution allows only configured CIDRs (e.g. VPN egress ranges). The API (its own hostname, called directly by the SPA as in task-vision) carries a resource policy allowing only the same CIDRs. The SAM agent endpoint (phase 3) gets the same restriction.
- **Fully private (fallback):** if the VPN routes into a VPC rather than egressing from fixed IPs, serve the SPA and API through internal endpoints in a VPC (e.g. internal load balancer plus private API Gateway endpoint), reachable only over the VPN.

Which mode the first adopter uses depends on how its VPN routes traffic; confirm with its network team before phase 1 infrastructure work. Auth0 login pages and outbound calls (Bedrock, SES, Slack webhooks) work in all modes.

### 10.3 Data store

DynamoDB single table, every key prefixed by tenant. Data volume is small (order of tens of thousands of data points per scorecard per year), so the engine loads a scorecard-year of measures and computes rollups in memory, with a cached computed snapshot per (scorecard, period) invalidated on write. Performance target: the Table tab for a full year renders in under 1.5 s. The builder designs keys and indexes from the access patterns in §6–§9.

### 10.4 Identity and tenancy

- Auth0 Organizations: one Auth0 organization per tenant; the access token carries the org ID, mapped to a tenant. Users may belong to several tenants (tenant switcher).
- Platform operator is an Auth0 permission. App roles and scopes (§2) are stored in DynamoDB and enforced in the API.
- Invitations use Auth0 organization invitations.
- **Sign-in:** each Auth0 organization can have an enterprise connection (company single sign-on via OIDC or SAML); the first adopter signs in through its company SSO. The public default is email/password plus Google.
- Auth0 configuration is managed as code (Auth0 Deploy CLI). Confirm during planning that the Auth0 plan supports Organizations with enterprise connections; the POC must not be blocked by SSO setup (fall back to invited email/password users until SSO is connected).

### 10.5 Security

- Every API handler and agent tool derives the tenant from the token; repository functions require a tenant ID and cannot query across tenants. Tests assert cross-tenant isolation.
- API tokens hashed; secrets in AWS Secrets Manager or SSM.
- Audit log for all writes (§5.10).
- Prompt-injection posture per §9.1.

## 11. Open-source hygiene

- MIT `LICENSE`, `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`.
- Fictional demo tenant and seed data (a made-up company that does not resemble a real one).
- A CI check scans for a maintainer-configured denylist of names (stored as a repository secret or local untracked file, so the list itself is not public) and fails the build on a match.
- `.superpowers/` and any local import files are git-ignored.

## 12. Delivery plan

| Phase | Target | Scope |
|---|---|---|
| 1. Foundation + POC | ~2026-11-20 | Repo, CI, dev environment, Auth0 tenants and roles, org units and levels, tracked items, metric engine, methodology versions (authoring UI may start minimal), grid entry, Charts and Table tabs, legacy adapter and backfill so the POC shows the real history; then records import and derived measures (for the December close) |
| 2. Close + import/export | ~2026-12-04 | Owners, due rules, close board, lock, email reminders, comments and @mentions, Excel/CSV import with templates, Excel/PDF/PNG export, methodology diff and publish |
| 3. SAM | ~2026-12-15 | Agent Lambda, read tools, docs search, change sets, file import via chat, model config, budgets, evals |
| 4. Briefs | ~2026-12-23 | Live month-to-date brief, publish and history, audience versions, export, board-deck and lookback views |
| 5. Hardening + prod | by 2027-01-01 | Prod environment, ingestion API, Slack webhook, security review, docs |

The maintainer requires the full scope by 2027-01-01, built by the maintainer working with AI agents. That is aggressive for a single human reviewer; plans should keep each phase demoable to the program management team weekly, and surface schedule risk early rather than silently cutting scope.

The program management team iterates on the POC from phase 1 onward. Recommended: run the December 2026 close in OpsVision with the spreadsheet in parallel for that one cycle, then retire the spreadsheet.

The POC on real data runs in the first adopter's private, VPN-only environment (§4, §10.2.1), so phase 1 includes standing up that environment through the private deployment repo, not just the demo environment.

Each phase gets its own implementation plan.

## 13. Decisions

**Decided by the maintainer**

- React + Go, mono-repo, Auth0, AWS in the task-vision shape, MIT, public, no company mentions.
- Methodology is versioned; history is frozen; restatement is a comparison view.
- Period totals typed or imported, or derived from uploaded item-level records (defects and work units) by versioned rules; see `2026-10-31-records-ingestion-design.md`.
- Ingestion: grid, Excel/CSV with templates, SAM chat, token API. Connectors later.
- Full monthly close (owners, board, reminders, lock).
- SAM proposes change sets; user applies; methodology changes as drafts.
- Tenants created by a platform operator; self-serve signup is a flag, off by default; no billing.
- Model configurable; operator sets default and allowed list, tenant admin chooses; Kimi expected.
- Monthly business one-pager for CIO / CISO / business, with audience versions; live month-to-date and history; exportable.
- Notifications: email plus optional Slack webhook.
- Exports: Excel, PDF/PNG.
- Backfill 2022 baseline through 2026, methodology 2024–2026 as versions.
- Charts and Table views both, plus the brief.
- Org units with tenant-defined levels and names; metrics at any level; rollups.
- Tracked items (services, vendors) as separate kinds, optionally attached to org units.
- Ready by 2027-01-01 with full scope, via a POC iterated with the program management team; built by the maintainer with AI agents.
- Imported mismatches keep the as-reported result; admins can override any value or status at any time, footnoted everywhere and audited with an optional comment.
- The first adopter's instance runs in its own AWS accounts, reachable only over VPN, deployed from a private deployment repo.
- Mid-year reorgs roll up as-of each month, including YTD and comparisons.
- Company SSO through Auth0 for the first adopter.

**Tech-lead calls (maintainer may override)**

- Product name OpsVision; SAM is the agent.
- DynamoDB single table; all AWS infrastructure in CloudFormation via AWS SAM; Auth0 via the Auth0 Deploy CLI.
- Phase 1 reads .xlsx with a small in-house reader (no spreadsheet library); a library for Excel export is vetted in phase 2.
- OpenAPI contract generating Go and TypeScript code.
- Rollups recompute formulas from rolled-up measures; per-axis aggregation rules; averages as sum ÷ count.
- Org tree effective-dated and separate from methodology versions.
- Scoped roles; reviewers optional; SAM cannot publish.
- SAM in a separate streaming Lambda; in-memory docs search; evals on demand.
- Brief regeneration debounced to hourly; admin edits protected; publish freezes.
- Parallel-run the December close.
- Denylist CI check for company names.
- 2022–2023 scored under a "Legacy (pre-2024)" version cloned from 2024.
- Workbook cell comments imported as read-only legacy notes (phase 2).
- `us-east-1` default region; network access modes with WAF IP allowlist as the default private mode.

## 14. Left to the builder

- DynamoDB key and index design; caching strategy details.
- Formula expression language and parser (must be safe, sandboxed, and validated).
- Exact Go and TypeScript libraries (through dependency vetting), including Excel parsing and PDF generation.
- Streaming mechanism for SAM and its fallback.
- Grid component implementation, chart styling, and design tokens consistent with the SAM palette.
- Tool schemas and system prompt for SAM.
- Demo tenant name and content.
