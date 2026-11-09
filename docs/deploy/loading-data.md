# Loading data into a deployment

`opsvision-admin` loads a tenant and a legacy workbook into a deployed
DynamoDB table. You run it once, from your own machine, with your own AWS
credentials. The deployed API needs nothing extra for it. It uses the same
bootstrap and import code as the dev server, so a file that loads locally
loads the same way in the cloud. For the deployed API's own settings, see
[environment.md](environment.md).

The names below (`opsvision-example`, `sample-co`, `legacy-1`) are examples.
Use your own.

> **Never commit a real bootstrap file or workbook.** Keep them in `/private/`
> at the repository root, which is git-ignored. They describe a real
> organisation.

## Before you start

1. Build the tool from `api/`:

   ```sh
   cd api
   go build -o ../build/opsvision-admin ./cmd/opsvision-admin
   ```

2. Sign in to AWS so the default credential chain finds credentials (an SSO
   profile, environment variables, or a shared config file) and select the
   region the table lives in:

   ```sh
   export AWS_PROFILE=example-operator
   export AWS_REGION=us-east-1
   ```

   The identity needs these DynamoDB actions on the table (the table ARN
   only; the tool never reads an index and never touches S3):

   | Action | `bootstrap` | `import` | Used for |
   |--------|:-----------:|:--------:|----------|
   | `dynamodb:GetItem` | yes | yes | reading the tenant, templates and versions |
   | `dynamodb:Query` | yes | yes | listing what the table already holds, and the fiscal-year data an import compares with |
   | `dynamodb:PutItem` | yes | yes | writing items; also authorizes the items inside a transaction |
   | `dynamodb:BatchGetItem` | no | yes | reading current data points before an import writes them |

   `TransactWriteItems` (creating the tenant, writing levels, writing data
   points) has no IAM action of its own: DynamoDB authorizes each write inside
   it as `dynamodb:PutItem`. The tool makes no `UpdateItem`, `DeleteItem`,
   `BatchWriteItem` or `Scan` calls, and no calls on indexes. So `bootstrap`
   needs `GetItem`, `Query` and `PutItem`; `import` needs those and
   `BatchGetItem`. With `-dry-run`, both commands need only `GetItem` and
   `Query`.

3. Write a bootstrap file. Its format is the dev server's, described in
   [local-bootstrap.md](local-bootstrap.md). Try it locally first with
   `go run ./cmd/importcheck`.

   In a single-organization deployment the tenant comes from configuration, so
   leave `tenant.auth0OrgId` out. `opsvision-admin` and `importcheck` accept
   that. The tenant's `id` must match the deployment's configured tenant ID
   (`OPSVISION_TENANT_ID`; see [environment.md](environment.md)).

   The dev server still requires `tenant.auth0OrgId`, because dev sign-in
   picks the tenant by organization. To try a single-organization file with
   the dev server, add any placeholder value such as `org_local`.

## Step 1: load the tenant

Check what would change, then load it:

```sh
../build/opsvision-admin bootstrap -table opsvision-example -file ../private/tenant.json -dry-run
../build/opsvision-admin bootstrap -table opsvision-example -file ../private/tenant.json
```

It prints how many of each kind it created, updated or left unchanged:

```text
tenant id: sample-co
tenant: 1 created, 0 updated, 0 unchanged
levels: 2 created, 0 updated, 0 unchanged
units: 3 created, 0 updated, 0 unchanged
...
versions: 2 created, 0 updated, 0 unchanged
templates: 1 created, 0 updated, 0 unchanged
users: 0 created, 0 updated, 0 unchanged
```

With `-dry-run` nothing is written; the output is what a real run would do.

### Running it again

Bootstrap only **creates what is missing**. After go-live, people edit
methodology and the org model in the app, so a re-run must never undo that.
For each level, unit, move, item kind, item, scorecard, version, template and
member in the file:

- Missing from the table: it is created.
- Identical to what the table holds: it is left alone, counted as `unchanged`.
- Present but different: it is **kept as it is** and reported with its kind
  and ID, for example:

  ```text
  units: 0 created, 0 updated, 2 unchanged, 1 differs (kept)
  versions: 0 created, 0 updated, 1 unchanged, 1 differs (kept)
  differs (kept): unit north
  differs (kept): version sc/v2-draft
  ```

- Nothing the file does not name is deleted.

`-dry-run` reports the same differences, so run it before a re-run to see
what the file would do.

### Overwriting on purpose

To make the table match the file for the items that differ, pass `-overwrite`:

```sh
../build/opsvision-admin bootstrap -table opsvision-example -file ../private/tenant.json -overwrite -dry-run
../build/opsvision-admin bootstrap -table opsvision-example -file ../private/tenant.json -overwrite
```

Differing items are updated and counted as `updated`. A methodology version
is saved against the revision found in the table, so its revision goes up by
one, and a version someone else changed meanwhile is reported as a conflict
instead of being overwritten. **This replaces in-app edits to those items,
including import text written into a draft version.** Check the dry run first.

A version that is **not a draft** (published, superseded or in review) is
never overwritten, even with `-overwrite`, because the app treats it as
immutable. If the file differs from it, the run reports it and leaves it alone:

```text
versions: 0 created, 1 updated, 0 unchanged, 1 differs (kept)
differs (kept, published): version sc/v1
```

To change a published version, publish a new version in the app.

### The tenant record

The tenant record itself (name, organization, fiscal year start, default
role, status scale) is never changed, with or without `-overwrite`. If the
file differs from the stored tenant, the run stops before writing anything and
names the settings.

## Step 2: import a legacy workbook

The template named by `-template` must already be in the table (it is part of
the bootstrap file). Parse first:

```sh
../build/opsvision-admin import -table opsvision-example -tenant sample-co \
    -workbook ../private/scorecard.xlsx -template legacy-1 -dry-run
```

It prints the template and scorecard it resolved, the counts (data points,
overrides, version text, legacy notes) and the findings by severity. Finding
text quotes your workbook, so do not paste it anywhere public. Fix the
template in the file and run `bootstrap -overwrite` (a changed template is
otherwise kept as it is) until there are no error findings.

Then apply it by running the same command without `-dry-run`:

```sh
../build/opsvision-admin import -table opsvision-example -tenant sample-co \
    -workbook ../private/scorecard.xlsx -template legacy-1
```

- The workbook is read from the local file. It is not uploaded anywhere, so
  there is no bucket to name.
- A workbook with any error finding is never applied; the command exits `1`.
- The result is applied as one change set, on the channel `import`, by the
  actor `cli:<your OS user name>`. It appears in the audit log as an
  `import.apply` entry.
- Legacy text goes only into draft versions, as in the app's Import page.
- Applying again is safe: data points are written unconditionally, so the
  same workbook gives the same values.

## Exit status

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | the import has error findings and was not applied |
| `2` | bad flags, an unreadable file, an unknown tenant or template, or a store failure |

## Troubleshooting

- `load AWS config` or an access error: check `AWS_PROFILE`, `AWS_REGION` and
  that your login has not expired.
- `tenant "..." does not exist in this table; run bootstrap first`: run step 1,
  or check `-tenant` and `-table`.
- `tenant ... already exists and differs from the file`: the tenant record
  cannot be changed by this tool. Restore the file's tenant settings to what
  the table holds.
- `differs (kept)` lines: the table holds an edited version of that item and
  bootstrap left it alone. Edit it in the app, remove it from the file, or
  re-run with `-overwrite` if the file should win.
