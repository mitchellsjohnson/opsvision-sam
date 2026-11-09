# Loading data into a deployment

`opsvision-admin` loads a tenant and a legacy workbook into a deployed
DynamoDB table. You run it once, from your own machine, with your own AWS
credentials. The deployed API needs nothing extra for it. It uses the same
bootstrap and import code as the dev server, so a file that loads locally
loads the same way in the cloud.

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

   The identity needs read and write access to the table and its indexes
   (`dynamodb:GetItem`, `Query`, `PutItem`, `UpdateItem`, `TransactWriteItems`
   and `BatchWriteItem`). It needs no S3 access.

3. Write a bootstrap file. Its format is the dev server's, described in
   [local-bootstrap.md](local-bootstrap.md). Try it locally first with
   `go run ./cmd/importcheck`.

   In a single-organization deployment the tenant comes from configuration, so
   leave `tenant.auth0OrgId` out. `opsvision-admin` accepts that. The tenant's
   `id` must match the deployment's configured tenant ID.

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

With `-dry-run` nothing is written; the counts are what a real run would do.

### Running it again

It is safe to repeat. After an edit to the file:

- A thing that is identical to what the table holds is left alone and counted
  as `unchanged`. A second run with the same file reports only `unchanged`.
- A thing that differs is overwritten with the file's content and counted as
  `updated`. A methodology version is saved against the revision found in the
  table, so its revision goes up by one, and a version someone else changed
  meanwhile is reported as a conflict instead of being overwritten.
- Nothing the file does not name is deleted.
- The tenant record itself (name, organization, fiscal year start, default
  role, status scale) is never changed. If the file differs from the stored
  tenant, the run stops before writing anything and names the settings.

**Re-running overwrites a version that differs from the file.** That includes
text an import has written into a draft version. Keep the file as the source
of truth for versions, or take the version out of the file once you edit it in
the app.

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
template and run `bootstrap` again until there are no error findings.

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
