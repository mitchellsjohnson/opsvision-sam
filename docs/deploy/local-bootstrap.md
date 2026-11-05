# Running locally with your own tenant

The dev server normally seeds a fictional demo tenant. To work on a real
organisation's configuration (its org tree, scorecards, methodology, import
templates and a few dev users), and to try importing a legacy workbook into
it, give the dev server a **bootstrap file**. Two tools use it:

- `go run ./cmd/devserver -bootstrap <file> [-import <xlsx> -import-template <id>]`
- `go run ./cmd/importcheck -bootstrap <file> -workbook <xlsx> -template <id>`

Run both from `api/`.

> **Never commit a real bootstrap file or workbook.** They describe a real
> organisation. Keep them in `/private/` at the repository root, which is
> git-ignored (so are all `*.xlsx` files outside test data). The files in this
> repository are synthetic. Nothing in these tools uploads, logs or writes
> your data anywhere but the in-memory store of the process you run.

## The bootstrap file

One JSON document. It is read strictly: an unknown field, a mistyped value, or
anything after the document is an error, and every problem found is reported
at once. IDs (tenant, level, unit, item kind, item, scorecard, version,
template) are 1-64 characters of letters, digits, `_` or `-`. Periods are
written `2026-M07`, `2026-Q3`, `2026-H2` or `2026-FY`.

| Key          | Contents |
|--------------|----------|
| `tenant`     | `id`, `name`, `auth0OrgId` (all required); `fiscalYearStartMonth` (1-12, default 1); `statusScale` (default green/yellow/red); `defaultRole` (default `viewer`) |
| `levels`     | `{id, name, depth}`; depths are unique (0 is the top) |
| `units`      | org units `{id, name, levelId, parentId, sourceKeys, retiredFrom}`; the tree must be valid |
| `moves`      | reorgs `{unitId, newParentId, effectiveMonth, note}` |
| `itemKinds`  | `{id, name}` |
| `items`      | tracked items `{id, kindId, name, orgUnitId, sourceKeys}` |
| `scorecards` | `{id, name}` |
| `versions`   | methodology versions `{id, scorecardId, name, status, effectiveFrom, publishedAt, content}`. `content` is `{categories, measures, metrics}` and must be valid for `published` and `superseded` versions; a `draft` may be incomplete and may omit `effectiveFrom`. Import text from a workbook is only written to drafts |
| `templates`  | import templates `{id, name, profile: "legacy_workbook", body}`; `body` is the legacy mapping (`sheets`, `rows`, `methodology`) plus an optional `scorecardId` (without it the tenant's only scorecard is used). The body is validated like the Import API validates it |
| `users`      | dev sign-ins `{userId, email, name, role, scope}`; `role` is `admin`, `contributor` or `viewer`; `scope.orgUnitIds` / `scope.metricKeys` limit what they see |

Users become members of the tenant directly, bound by `userId`; there are no
pending invitations. Omitted keys mean "none".

### A tiny synthetic example

```json
{
  "tenant": {"id": "sample-co", "name": "Sample Co", "auth0OrgId": "org_sample_co"},
  "levels": [{"id": "co", "name": "Company", "depth": 0}, {"id": "seg", "name": "Segment", "depth": 1}],
  "units": [
    {"id": "company", "name": "Company", "levelId": "co"},
    {"id": "north", "name": "North Segment", "levelId": "seg", "parentId": "company"}
  ],
  "scorecards": [{"id": "sc", "name": "Scorecard"}],
  "versions": [{
    "id": "v1", "scorecardId": "sc", "name": "v1", "status": "published",
    "effectiveFrom": "2025-FY", "publishedAt": "2025-01-01T00:00:00Z",
    "content": {
      "categories": [{"id": "delivery", "name": "Delivery", "order": 1}],
      "measures": [
        {"key": "done", "name": "Done", "unit": "count", "orgAgg": "sum", "timeAgg": "sum"},
        {"key": "total", "name": "Total", "unit": "count", "orgAgg": "sum", "timeAgg": "sum"}
      ],
      "metrics": [{
        "key": "on_time", "name": "On time", "categoryId": "delivery",
        "formula": "done / total * 100", "format": "percent0",
        "direction": "higher_better", "frequency": "monthly",
        "reportedAt": [{"kind": "level", "id": "seg"}],
        "rule": {"type": "bands", "bands": [
          {"status": "G", "op": ">=", "value": 80},
          {"status": "Y", "op": ">=", "value": 60},
          {"status": "R", "op": "", "value": 0}]}
      }]
    }
  }],
  "users": [{"userId": "dev|admin", "email": "admin@sample.test", "name": "Sample Admin", "role": "admin"}]
}
```

A larger synthetic file, with a template that matches the test workbook, is
`api/internal/bootstrap/testdata/synthetic.json`.

## Import template reference

A template `body` has `sheets`, `rows` and `methodology`.

**`sheets`** (one per data sheet): `sheet`, `fiscalYear`, `labelColumn`,
`monthColumns` (column letter to fiscal month 1-12), `periodColumns` (column
letter to a period such as `2025-Q4`; wins over `monthColumns` for the same
column) and an optional `ytdColumn`.

**`rows`**: each maps one sheet row to a metric and subject.

| Field | Meaning |
|-------|---------|
| `sheet`, `label` | the sheet and the row's text in its `labelColumn`. A row with no `metric` is a section header |
| `section` | only match rows below the section header with this label |
| `row` | optional 1-based worksheet row number. The mapping then applies to exactly that row, `section` is ignored, and `label` becomes optional: if given, it is a guard, and a row whose label differs (trimmed, case-insensitive) is skipped with an error finding `row N label is "x", expected "y"`. A row number needs a `metric`, and a sheet's row numbers must be unique |
| `metric`, `subject` | the metric key and the org unit or tracked item ID |
| `convert`, `measures` | the converter and its role-to-measure map |
| `periodColumns` | optional column letter to period for this row. It replaces the sheet's `monthColumns` and `periodColumns` for the row entirely: only the listed columns are imported. Each period's grain must fit the metric's frequency |

Use `row` when labels repeat. Here the sheet has two blocks that both list
`North` and `South` (rows 3-4 under "Revenue", rows 6-7 under "Cost"), and
the "Retention" row on row 9 is quarterly although the sheet's columns are
months. Its values sit in the January (`F`) and April (`I`) columns:

```json
{
  "sheets": [{
    "sheet": "Data", "fiscalYear": 2025, "labelColumn": "A",
    "monthColumns": {"F": 1, "G": 2, "H": 3, "I": 4, "J": 5, "K": 6}
  }],
  "rows": [
    {"sheet": "Data", "row": 3, "label": "North", "metric": "revenue", "subject": "north",
     "convert": "money_k", "measures": {"value": "revenue"}},
    {"sheet": "Data", "row": 4, "label": "South", "metric": "revenue", "subject": "south",
     "convert": "money_k", "measures": {"value": "revenue"}},
    {"sheet": "Data", "row": 6, "label": "North", "metric": "cost", "subject": "north",
     "convert": "money_k", "measures": {"value": "cost"}},
    {"sheet": "Data", "row": 7, "label": "South", "metric": "cost", "subject": "south",
     "convert": "money_k", "measures": {"value": "cost"}},
    {"sheet": "Data", "row": 9, "metric": "retention", "subject": "company",
     "convert": "value", "measures": {"value": "retention"},
     "periodColumns": {"F": "2025-Q1", "I": "2025-Q2"}}
  ]
}
```

The `value`, `money_k` and `daily_average` converters also read a score with
its change (`1587 | 12% Quality Increase | G`), and a bare number or percent
that carries a status (`99.5 | G`): the number is imported and the status is
checked against the methodology like any other recorded status.

## Running the dev server with it

```sh
cd api
go run ./cmd/devserver -bootstrap ../private/tenant.json
```

- The tenant is loaded into the in-memory store at startup. `-bootstrap`
  needs `-store memory` (the default) and replaces the demo seed; combining it
  with `-seed demo` is refused. Restart to reload the file.
- `/dev/users` lists the file's `users` and `/dev/login` signs them in to the
  file's tenant (`auth0OrgId`), so the web login page works as usual.

To import a legacy workbook as the server starts:

```sh
go run ./cmd/devserver -bootstrap ../private/tenant.json \
    -import ../private/scorecard.xlsx -import-template legacy-1
```

`-import` and `-import-template` go together and need `-bootstrap`. The
server parses the workbook with the named template exactly as the Import API
would (same fiscal years loaded for comparison, same scorecard choice, same
parser) and applies the change set. It logs the counts and the number of
findings by severity, never their text. **It refuses to start** if the
template is wrong, the workbook cannot be read, there are any error findings,
or applying fails. Warnings and info findings do not stop it.

## Iterating on a template with importcheck

```sh
go run ./cmd/importcheck -bootstrap ../private/tenant.json \
    -workbook ../private/scorecard.xlsx -template legacy-1
```

It loads the bootstrap file into a throwaway store, parses the workbook, and
prints the counts (data points, overrides, version text, legacy notes) and
the findings grouped by severity, then sheet. Edit the template in the
bootstrap file, run again. Nothing is applied and no file is written.

| Flag | Meaning |
|------|---------|
| `-sheet <name>` | show only that sheet's findings |
| `-limit N` | most findings printed per severity and sheet (default 50) |
| `-severity error\|warn\|info` | lowest severity shown (default `info`: everything) |
| `-json` | print one JSON document (counts, finding counts, grouped findings) |

Exit status: `0` when there are no error findings, `1` when there are any
(even ones the filters hide), `2` for bad flags or unreadable input. Finding
text is printed in full, since it quotes your workbook; do not paste it
anywhere public.
