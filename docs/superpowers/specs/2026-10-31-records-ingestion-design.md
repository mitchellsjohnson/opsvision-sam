# OpsVision — Records Ingestion and Derived Measures

Status: draft for maintainer approval
Date: 2026-10-31
Extends: `2026-10-30-opsvision-design.md` (the main spec). Where they disagree, this document wins.

## 1. Intent

Today every measure value is a period total that someone types, pastes, or imports (for example `epics_committed = 66` for one product in one month). Upstream, those totals are counted by hand from issue-tracker and portfolio-tool exports. This feature lets the program manager upload the raw rows instead (each defect, each epic, each concept) and have OpsVision compute the period totals, so:

- the monthly close is an upload, not a counting exercise;
- the same export uploaded twice, or two overlapping exports, never double counts;
- any period's numbers can be explained down to the records behind them ("which defects made Checkout's score 1,587?");
- the rules that turn records into numbers are versioned with the methodology, like formulas and thresholds.

Typing values per period stays fully supported. A tenant can use records for some measures, typed values for others, and type a value over a derived one for a specific period.

This replaces the main spec's v1 non-goal "No item-level records". Connectors and a records ingestion API remain later phases.

## 2. Goals, non-goals, anti-goals

**Goals**

1. One generic record shape for defects and every kind of measurable work unit, with tenant-defined record types.
2. Saved mapping templates that turn a tracker export (CSV or .xlsx) into records, reused every month.
3. Idempotent, deduplicating monthly uploads with a preview before anything changes.
4. Measures derived from records by versioned, validated rules that cover the first adopter's metrics (spec §5.11): on-time, on-budget, expected value, weighted defect score, idea age.
5. Two layers of numbers: **live** (always recomputed from current records) and **locked** (frozen at lock, changed only by an intentional recalculation).
6. Drill-down from a derived cell to the records that produced it.

**Non-goals (this feature)**

- Connectors or scheduled pulls from trackers. API push of records is a later phase; the record JSON in §4 is designed to be that API's body.
- Editing individual records in the UI. Records come from the source system; corrections happen there and arrive in the next upload.
- Arbitrary analytics over records (ad hoc queries, pivots).

**Anti-goals**

- A re-upload or overlapping export changes any number.
- A new upload silently changes a locked month.
- A derived value that cannot be traced to its records.
- The mapping format being specific to one tracker product.

## 3. Concepts

- **Record type** (tenant-level, not versioned, like item kinds): a name and key (`defect`, `epic`, `concept`, `capability`, `release`, `idea`), the tenant's normalized **priority values** (for example `P1, P2, P3, P4, none`), optional custom **attribute definitions** (name, type `string | number | bool | date`), and a **tracked-from month** per source (§8).
- **Record**: one defect or work unit from a source system, identified by `(source, externalId)`. Belongs to one subject (org unit or tracked item).
- **Record revision**: the state of a record as of one snapshot. A record changes only by gaining a revision.
- **Snapshot**: one upload, with an **as-of date** (the date the export was taken; entered at upload, default today).
- **Mapping template**: how one export format maps to records.
- **Derivation rule**: on a measure in a methodology version; turns records into that measure's value per subject per period.

## 4. The record format (canonical)

Every import produces records in this shape; the future API accepts the same JSON.

```json
{
  "source": "tracker",
  "externalId": "PAY-1042",
  "type": "defect",
  "subjectKey": "Checkout",
  "title": "Refund total rounds incorrectly",
  "category": "bug",
  "priority": "P2",
  "status": "In Review",
  "state": "open",
  "createdAt": "2026-09-03",
  "committedAt": null,
  "dueAt": null,
  "completedAt": null,
  "measuredAt": null,
  "planned": null,
  "actual": null,
  "expectedValue": null,
  "deliveredValue": null,
  "url": "https://tracker.example/PAY-1042",
  "attributes": { "customerTicket": true }
}
```

| Field | Required | Meaning |
|---|---|---|
| `source` | yes | Which system the record comes from (tenant-chosen label). Part of identity. |
| `externalId` | yes | The record's key in that system. Part of identity. |
| `type` | yes | A record type key. |
| `subjectKey` | yes | Matched against org-unit and tracked-item `sourceKeys` (existing field). |
| `title` | no | Display only. |
| `category` | no | Free text from the source (bug, defect, story, feature). Usable in rule conditions. |
| `priority` | no | One of the record type's normalized priority values; absent means `none`. |
| `status` | no | The source's raw status text, kept for display and conditions. |
| `state` | yes | Normalized: `open`, `done`, or `cancelled`. |
| `createdAt` | yes | When the record was opened or created. |
| `committedAt` | no | When the work was committed to (for example sprint or plan commitment). |
| `dueAt` | no | The current committed due date. |
| `priorDueDates` | no | Earlier committed due dates, oldest first, if the export has them (for example from a change log). Lets the first upload carry slips that happened before OpsVision saw the record. |
| `completedAt` | no | When it was finished or resolved. Required when `state` is `done` or `cancelled`. |
| `measuredAt` | no | When an after-the-fact measurement was taken (for example expected value measured four quarters after launch). |
| `planned`, `actual` | no | Numbers (planned and actual spend, in the record type's unit, e.g. $k or dev-weeks). |
| `expectedValue`, `deliveredValue` | no | Numbers (or booleans via attributes when value delivery is a yes/no judgment). |
| `url` | no | Link back to the source record. |
| `attributes` | no | Values for the record type's custom attributes. Unknown attributes are an import error. |

Dates are calendar dates (`YYYY-MM-DD`). Date-times in exports are truncated to their written date; time zones are ignored. (Builder's call; day-level precision is all the metrics need.)

## 5. Snapshots, deduplication, and history

- **Identity:** `(tenant, source, externalId)`. A record's `type` may not change; a row that would change it is an import error.
- **Unchanged rows:** a row whose normalized fields equal the record's latest revision is reported as `unchanged` and writes nothing. Uploading the same file twice is a no-op.
- **Changed rows:** a new revision with `asOf` = the snapshot's as-of date. Out-of-order uploads (an older export uploaded after a newer one) are allowed: the revision is inserted at its as-of date, and the "latest" state is the revision with the newest as-of date.
- **Within-file duplicates:** two rows with the same identity in one file are an error; both rows are listed.
- **Missing records:** never deleted. If the template is marked `fullExport`, records of that type and source that are absent from the file are listed in the preview as `missing`; the admin may choose "mark missing as cancelled" when applying (writes a revision with `state: cancelled`, `completedAt` = as-of date).
- **Which revision a rule reads:** derivation reads the **latest revision** of each record for every field (state, subject, category, numbers, attributes, dates), because the source system reports those as current facts about the past. The one exception is `daily_open_weighted` (§8), which reads `priority` and evaluates its `where` condition with the revision in force on each day (the latest revision with `asOf` ≤ that day; before a record's first snapshot, its earliest revision). Example: a defect that is P3 in the October upload and P1 in the November upload counts as P3 through the October snapshot's as-of date and P1 after it. When the record API arrives, it can send exact change times as revisions with exact as-of dates; nothing else changes.
- **Commitments (maintainer's rule):** every committed due date is its own commitment, judged in the month it falls in. A slip dings the month of the date that slipped; the commitment then resets to the new date, which can be met or missed in its own month. Example: epic 1 is committed for 2026-12-15 and slips; the new date is 2027-02-10, and it is delivered on 2027-02-08. December counts 1 committed, 0 on time; February counts 1 committed, 1 on time; the epic's record is 1 of 2 commitments met (50%).
  - A record's **commitment list** is `priorDueDates` (if mapped) followed by each distinct `dueAt` value across its revisions, in as-of order.
  - A commitment is **met** if `completedAt` ≤ its date; **missed** if its date moved later (a slip) or the date passed without completion. A commitment whose date passed without completion and was never re-planned stays missed, with no new commitment.
  - Moving a date **earlier** replaces the commitment without a ding (builder's call; the maintainer may override).
  - A record cancelled before a commitment's date drops that commitment; misses already recorded stand.
  - Snapshot granularity: if a due date changes twice between uploads, only the last value is seen. Mapping `priorDueDates` from a change-log column closes that gap.
- **Unmatched subjects:** a row whose `subjectKey` matches no org unit or tracked item is held in the preview as `unmatched` (grouped by value). The admin can add the value as a source key on the right unit and re-run the preview without re-uploading. Unmatched rows are not stored on apply.
- **Parent units:** a row whose `subjectKey` matches an org unit that has child units in any month of the record's life is an error ("matches a parent unit"). Today's engine gives a parent either its own value or its children's rollup, never both, so a parent-level record would hide its children's numbers. The workaround is a child unit for shared work (for example "Data (shared)") carrying that source key. Tracked items and leaf units are fine.
- **Ambiguous subjects:** a value matching more than one subject is an error (source keys must be unique per tenant; enforce on save of source keys).

## 6. Mapping templates

A tenant-scoped, named JSON document, validated on save, used for the monthly upload. One template maps one export format to one record type. **Users never have to write it:** the guided mapping (§7.1) produces it, and the JSON is shown only under "Advanced".

```json
{
  "name": "Tracker defects export",
  "recordType": "defect",
  "source": "tracker",
  "file": { "format": "csv", "sheet": null, "headerRow": 1 },
  "fullExport": false,
  "fields": {
    "externalId":  { "column": "Issue key" },
    "title":       { "column": "Summary" },
    "subjectKey":  { "column": "Product" },
    "category":    { "column": "Issue Type" },
    "priority":    { "column": "Priority", "map": { "Highest": "P1", "High": "P2", "Medium": "P3", "Low": "P4" }, "default": "none" },
    "status":      { "column": "Status" },
    "state":       { "column": "Status", "map": { "Done": "done", "Closed": "done", "Won't Do": "cancelled", "*": "open" } },
    "createdAt":   { "column": "Created", "dateFormats": ["2006-01-02 15:04", "02/Jan/06 3:04 PM"] },
    "completedAt": { "column": "Resolved", "dateFormats": ["2006-01-02 15:04"] },
    "url":         { "template": "https://tracker.example/browse/{Issue key}" }
  },
  "attributes": {
    "customerTicket": { "column": "Linked tickets", "transform": "nonEmpty" }
  },
  "skipRows": [ { "column": "Issue Type", "in": ["Sub-task"] } ]
}
```

- A field takes a `column` (header text, exact match after trimming), a `constant`, or a `template` (string with `{Column}` placeholders).
- `map` translates raw values; `"*"` is the fallback; with no fallback, an unmapped value is a row error naming the value. `default` applies when the cell is empty.
- `dateFormats` are tried in order (Go layout strings; the editor offers presets and a test box). Spreadsheet serial dates in .xlsx are recognized automatically. A month-only value (`2026-03`, `Mar 2026`) maps to the first day of that month, for lists grouped by a month column rather than a date.
- `priorDueDates` takes a column holding a list of dates and a `separator`.
- Yes/no judgment columns from a list (for example "measured in period", "within budget") map to `bool` attributes that rules filter on (`where: "measured && withinBudget"`).
- Numbers accept the same forms as the entry grid (`1,234`, `$10k`, `84%`).
- `transform` (attributes only): `nonEmpty`, `number`, `bool`, `date`, `text`.
- `skipRows` drops rows before validation (counted in the preview, not errors).
- Templates are versioned by revision like other admin objects; each snapshot records the template revision used.

The parser is deterministic Go code (CSV via the standard library; .xlsx via the existing in-house reader, `internal/xlsx`). Upload limits match the existing import (20 MB).

## 7. Import flow

**Experience goal (maintainer): maximize ease.** The monthly close for a program manager is: drop the export files, read what changed in plain language, click Apply. Nobody types JSON, expressions, or source keys to get there. Every step is keyboard-accessible, and drag-and-drop always has a "Choose file" button alternative.

Same shape as the existing workbook import (upload → parse → preview → apply), as a second import kind.

### 7.1 First upload: guided setup ("Set up from a file")

One wizard, end to end, the first time a new export is dropped:

1. **What is this file?** Pick an existing record type or create one in place ("Defects", "Epics", …). OpsVision suggests one from the headers (a "Priority" plus "Resolved" column suggests defects; "Due date" suggests a work unit).
2. **Columns.** OpsVision guesses each field from header synonyms (for example "Issue key", "Key", "ID" → `externalId`; "Created" → `createdAt`; "Resolved", "Done date" → `completedAt`; "Due date", "Target date" → `dueAt`; "Product", "Component", "Team", "Project" → `subjectKey`) and from content (a column of unique values suggests the ID; date-like columns suggest dates). Each field shows the guess, its confidence, and three sample values from the file; the user corrects with a dropdown. Date formats are detected from the values; an ambiguous format (`03/04/2026`) asks once ("Is that March 4 or April 3?").
3. **Values.** For priority, state, and any yes/no attribute, the wizard lists the distinct values actually in the file with row counts, pre-mapped by keyword (Highest, Critical, Blocker → P1; Done, Closed, Resolved → done; Won't Do, Duplicate, Cancelled → cancelled; anything else → open). The user adjusts with dropdowns.
4. **Products and teams.** Distinct subject values are matched to org units and tracked items by name and existing source keys, with fuzzy suggestions ("Checkout Svc" → Checkout). Unmatched values get a picker, plus "Ignore these rows" and, for parent units, "Create '<Segment> (shared)'". Choices are saved as source keys when the import is applied.
5. **What should we calculate?** Presets (§8.1) for the record type, pre-selected where the methodology has matching measures, with a plain-language sentence for each ("On-time delivery: each due date is a commitment; a slip counts as a miss in that month").
6. **Preview** (§7.3), then **Apply**.

The wizard saves the template, the record type, the source keys, and (into a draft methodology version) any new derived measures and metrics. The preview evaluates the draft so the user sees the numbers the presets will produce. Derived values start once the draft is published; the wizard's last step offers "Publish now", effective from the record type's tracked-from month, through the normal publish dialog with its diff.

### 7.2 Monthly uploads

- **Drop anywhere.** On the Import page, or a file dropped on the scorecard page, opens the import with that file. Several files can be dropped at once (defects plus epics); each is previewed separately, and Apply applies them together.
- **Recognition.** The file's header set is matched against saved templates: "Looks like your *Defects export*: 1,204 rows, 37 changed since your October 31 upload." If columns were added or removed but required fields are present, it proceeds and says so; if a required column is missing, it opens the mapping step at that field.
- **New values** that no map covers (a new priority "Urgent") are asked inline in the preview, not reported as row errors; the answer updates the template.
- **Nothing new:** "Nothing changed since your last upload" with no Apply button.
- The as-of date defaults to today and is shown, editable, at the top of the preview.

### 7.3 Preview that tells the story

Nothing is stored until Apply. The preview leads with **what changes in the scorecard**, not row counts:

- **Changes by metric**, largest status changes first: "October · Payments · On-time delivery 84% → 81% (Yellow) · 3 epics slipped: PAY-12, PAY-40, PAY-77." Each line expands to the records and why each counts (slipped, delivered on time, newly opened P1, …), with links to the source system.
- **Your typed numbers vs records** (for the parallel-run close): where a typed value exists for a derived measure (typed wins, §8), "You typed 48 / 66 for Payments in October; records give 47 / 66" with the records behind 47 / 66 listed, so the team can find the difference. A per-cell action "Use records for this month" clears the typed value on apply.
- **Waiting for locked months** (§9): listed, not applied.
- **Needs your input:** unmatched products, new values, duplicate IDs in the file, parent-unit matches; each answerable inline. Rows with real errors (no ID, unreadable date) are listed with row number and column, and do not block applying the rest.
- **Row counts** last: new, changed, unchanged, skipped, missing (full export only).

**Apply** (admin) writes the snapshot, the records and revisions, the saved answers (source keys, value maps), then recalculates derived values for open periods (§9). Applying twice is a conflict, as today.

Records ingestion is admin-only in phase 1, like the existing import apply.

## 8. Derived measures

A measure in a methodology version gains a `source`:

- `entered` (default; today's behavior): values come from the grid, imports, or (later) SAM and the API.
- `derived`: values are computed from records by the measure's `derive` rule.

```json
{ "key": "epics_on_time", "name": "Epics on time", "unit": "count", "orgAgg": "sum", "timeAgg": "sum",
  "source": "derived",
  "derive": {
    "recordType": "epic",
    "op": "count",
    "bucketBy": "dueAt",
    "where": "state == 'done' && completedAt <= dueAt"
  } }
```

**Operations**

| `op` | Value for a subject and period | Example measure |
|---|---|---|
| `count` | number of records whose `bucketBy` date falls in the period and that satisfy `where` | `epics_committed` (bucketBy `dueAt`), `concepts_measured` (bucketBy `completedAt`) |
| `sum` | sum of `field` over the same set | `planned_spend_k` (field `planned`, bucketBy `completedAt`) |
| `daily_open_weighted` | for each day in the period, the sum of `weights[priority]` over records open that day, summed across the days | `defect_points_sum` with weights `P1 64, P2 16, P3 4, P4 2, none 1` |
| `commitments` | number of commitments (§5) whose date falls in the period, with `outcome` = `resolved` (met or missed) or `met`, among records satisfying `where` | `epics_committed` (`resolved`), `epics_on_time` (`met`) |
| `days_in_period` | number of calendar days in the period through its cutoff (no records needed) | `defect_days` |
| `age_sum` | sum, over records whose `bucketBy` date falls in the period, of days from `ageFrom` to `ageTo` (or to the period end if `ageTo` is empty) | `idea_age_days_sum` |

- **Pending commitments:** a commitment that is neither met nor missed by the period's cutoff (due later in the open month, not yet done) is not counted yet; the cell shows "N still due this month".
- **Open on a day** (for `daily_open_weighted`): `createdAt` ≤ day and (`completedAt` is empty or `completedAt` > day), evaluated with that day's revision for priority and the `where` condition.
- **`where`** is an expression over record fields and attributes, compiled with the same sandboxed expression engine as formulas (`expr`), validated when the methodology is saved (unknown fields, type errors). Date comparisons and `in [...]` are supported; no function calls beyond a small allow-list (builder's choice).
- **Subjects:** a record contributes to the subject its `subjectKey` matched (always a leaf unit or tracked item, §5). Values at parent levels come from the existing org rollup (`orgAgg`), so as-of reorg semantics apply unchanged. Derived points are never written on parent units.
- **Which cells get a derived value:** each record type has a **tracked-from month** per source (set on the record type; default the month of its first snapshot). From that month on, every leaf org unit and tracked item **that has at least one source key** gets a derived value for each derived measure on that record type, at the levels and kinds the metric reports at, including `0` when no records match. Subjects without source keys, and months before tracked-from, get no derived value, so they show as missing rather than a perfect zero, and backfilled workbook months are not filled in.
- **Data cutoff:** a period's derivation stops at its **cutoff** = the earlier of the period's last day and the latest snapshot as-of date for that record type. `daily_open_weighted` and `days_in_period` both count days only through the cutoff, so a month-to-date defect score is an average over the days actually covered (shown as "through Nov 14" on the cell). A period entirely after the latest snapshot gets no derived value. Records completed after the cutoff are still open on days up to the cutoff.
- **Period grain:** derivation runs at the measure's grain (monthly measures per month; a quarterly measure buckets by the quarter). Time rollups (`timeAgg`) are unchanged.
- **No records:** a derived `count` with no matching records is `0`, which lets existing zero-denominator handling show "not applicable" for 0/0 metrics. `sum` and `age_sum` with no records are `0`.
- **Versioning:** the rule belongs to the methodology version in force for the period, so changing weights or conditions in a 2027 version does not change 2026. Restatement (main spec §5.3) re-derives under the other version for comparison.
- **Changing a measure's source** between versions is allowed; each period uses its own version's source.

### 8.1 Presets and the condition builder

Admins choose a **preset** and fill in blanks; the `derive` JSON and the `where` expression are generated and visible under "Advanced". Each preset creates its measures and, optionally, the metric (formula, direction, format, default bands the admin can edit) in the current draft version.

| Preset | Asks for | Creates |
|---|---|---|
| On-time delivery | record type, filter | `<type>_committed` (commitments, resolved), `<type>_on_time` (commitments, met); metric `on_time / committed * 100`, higher is better, bands ≥ 90 G, ≥ 80 Y |
| Weighted open items | record type, weight per priority (pre-filled from the record type's priorities; defect default 64 / 16 / 4 / 2 / 1), filter | `<type>_points_sum` (daily open weighted), `<type>_days` (days in period); metric `points_sum / days`, lower is better, change vs prior period |
| Delivered within budget | record type, tolerance % (default 20), bucket date, filter | `<type>_measured`, `<type>_within_budget`, `planned_<unit>`, `actual_<unit>`; metric `within / measured * 100` |
| Delivered expected value | record type, filter | `<type>_ev_measured`, `<type>_ev_delivered` (bucket `measuredAt`); metric `delivered / measured * 100` |
| Average age | record type, from and to dates, filter | `<type>_age_days_sum`, `<type>_count`; metric `age_sum / count`, lower is better |
| Count | record type, bucket date, filter | one count measure |
| Sum | record type, number field, bucket date, filter | one sum measure |

The **filter** is a condition builder: rows of *field · operator · value* (for example *Category · is one of · bug, defect*; *Customer ticket · is · yes*), combined with AND, with value pickers populated from values seen in the tenant's records. It compiles to the `where` expression; "Advanced" allows editing the expression directly (validated on save as above). A live sample beside the form shows "Last month this matches 212 records (Checkout 41, Billing 18, …)".

**Typed values win.** If a data point for a derived measure exists with any source other than `records` (grid, import, legacy, SAM, API), that value is used for that subject and period and shown as "entered (derived value would be X)". Clearing it restores the derived value. This keeps the backfilled workbook history authoritative for months before records exist.

## 9. Live and locked

The month lock is built in phase 2 (main spec §6.2). This feature defines what the lock means for derived values, and phase 2's lock must implement it.

- **Storage:** derived values are materialized as ordinary data points with `source: "records"` (a new source), revisioned and audited like any write, so the engine, views, overrides, and history work unchanged.
- **Live (open months):** every records apply recalculates derived points for all open periods affected by the changed records, and every methodology publish recalculates open periods under the new version. The view for an open month always reflects current records.
- **Locked months:** never recalculated automatically. Imports still store the records, and the preview and apply report list "changes waiting for locked months" (period, measure, subject, locked value → live value).
- **Intentional recalculation (phase 2, admin):** "Recalculate locked month" shows that diff and, on confirm, writes the new derived points as revisions with an optional reason, writes an audit entry, and flags any published brief for the month as "data revised since publication".
- **Seeing both:** for a locked month, the Table cell drawer shows the live value next to the locked one when they differ, and the Table tab marks such cells (phase 2, with the lock). In phase 1 there is no lock, so every month is live.

## 10. Drill-down

- A derived cell in the Table drawer shows "Derived from N records" with a list: external ID (linked by `url`), title, priority, state, and the dates the rule used, plus the record's contribution where it is not 1 (for example a defect's points that month). Rolled-up cells list records from all contributing subjects.
- API: list contributing records for (metric or measure, subject, period), paginated, respecting the caller's data scope.
- This is also the read path SAM's `explain_status` will use in phase 3.

## 11. Mapping to the first adopter's metrics (validation cases)

Uses the main spec §5.11 measures; record types and field names are as in §4.

| Measure | Rule |
|---|---|
| `epics_committed` | commitments `epic`, outcome `resolved` |
| `epics_on_time` | commitments `epic`, outcome `met` |
| `concepts_measured` | count `concept`, bucketBy `completedAt`, where `state == 'done'` |
| `concepts_within_budget` | count `concept`, bucketBy `completedAt`, where `state == 'done' && actual <= planned * 1.2` |
| `planned_spend_k`, `actual_spend_k` | sum `planned` / `actual` over `concept`, bucketBy `completedAt`, where `state == 'done'` |
| `ev_measured`, `ev_delivered` | count `concept`, bucketBy `measuredAt`; delivered adds `deliveredValue >= expectedValue` |
| `defect_points_sum` | daily_open_weighted `defect`, weights P1 64 / P2 16 / P3 4 / P4 2 / none 1, where `category in ['bug','defect']`; the customer-weighted variant is a filter, adding `&& customerTicket` (the methodology counts only bugs with a customer ticket attached; weights are the same) |
| `defect_days` | days_in_period |
| `idea_age_days_sum`, `idea_count` | age_sum / count `idea`, bucketBy `createdAt`, ageFrom `createdAt`, ageTo `completedAt` (first response) |

Uptime, training, and accessibility stay entered.

The engine tests reproduce the defect example from the methodology (one P1, one P2, five P3 open all month → 100 points per day) an epic due on the last day of a month completed one day late (counts as committed, not on time), and the slip example in §5 (December 0 of 1, February 1 of 1).

## 12. Data model and access patterns (for the builder)

New tenant-scoped entities: record types; records (latest state per identity); record revisions (by record and as-of); snapshots (upload metadata, template revision, counts); mapping templates. Access patterns: upsert batch by identity; list records by type and subject whose dates overlap a date range (for derivation); list records by id set (drill-down). Volumes: up to roughly 50,000 records and 200,000 revisions per tenant over several years. The builder designs keys and indexes (main spec §14), with in-memory derivation per scorecard-year like the existing engine.

## 13. UI (phase 1 scope)

- **Import page:** drop zone (multi-file) with "Choose files"; recognized files go straight to the story preview (§7.2, §7.3); unrecognized files open the guided setup (§7.1). The existing "Legacy workbook" import stays as a second option on the same page.
- **Scorecard page:** an "Upload records" button in the header, and dropping a file on the page opens the import.
- **Admin → Record types:** list, add, edit priorities, attributes, and tracked-from months (also created in place by the wizard).
- **Admin → Templates:** list saved templates with last-used date; "Edit mapping" reopens the wizard's column and value steps against a sample of the last upload; JSON under "Advanced".
- **Methodology → Measure form:** "Source: Entered / Derived from records"; derived uses the presets and condition builder (§8.1), with Advanced JSON.
- **Table cell drawer:** "Derived from N records" list (§10), "through <date>" for month-to-date cells, "N still due this month" for pending commitments, and "entered (records give X)" when a typed value wins.
- **Copy:** plain language throughout ("products and teams", "due date", "slipped"), not internal vocabulary ("subject", "source key", "revision"), except under Advanced.

## 14. Delivery

Added to the phase 1 plan as new tasks after Task 26 (methodology editor and import page) and before Task 27 (infrastructure). The workbook backfill provides history as entered values, so records matter from the December 2026 close onward; this ordering keeps the POC on track and surfaces the schedule cost early. The phase 2 lock implements §9. The records ingestion API is phase 5 alongside the existing ingestion API.

## 15. Decisions

**Decided by the maintainer**

- Generic records for defects and measurable work units; values can be typed per period or derived from records.
- Ingestion is a monthly upload of an export; the tool deduplicates. API integration is a later phase.
- Real-time (live) values and locked values; a locked month changes only through an intentional recalculation.
- On-time delivery counts commitments: a slip dings the month of the missed date, and the commitment resets to the new date, judged in its own month.
- Maximize ease for existing users: guided mapping from the first file, recognition of repeat uploads, inline fixes for unmatched products, presets instead of expressions, a story-first preview, typed-versus-records comparison for the parallel run, and drill-down from any cell.

**Builder / tech-lead calls (maintainer may override)**

- Snapshot as-of dates give record history. Rules read the latest revision, except the daily defect score, which reads each day's priority.
- Moving a due date earlier is not a ding; cancelling before a date drops that commitment; pending commitments in the open month are not counted until met or missed.
- Records must match a leaf unit or tracked item; parent-level matches are errors, with a "shared" child unit as the workaround.
- Derived values exist only from a record type's tracked-from month and only for subjects with source keys; zero otherwise.
- Month-to-date derivations stop at the latest snapshot date (points and days alike).
- The customer-weighted defect score is a filter on bugs with a customer ticket, same weights.
- Records are never deleted by an upload; full-export templates list missing records for optional cancellation.
- Typed values override derived values per subject and period.
- Derived values are materialized as `records`-source data points.
- Date-only precision; time zones ignored.
- Records ingestion is admin-only in phase 1.
- Presets create measures and metrics into a draft version, never a published one.
- Row errors do not block applying the other rows; questions (unmatched values, new values) are answered inline and saved on apply.
- Tasks inserted into phase 1 after Task 26.
