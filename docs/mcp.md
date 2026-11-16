# Using OpsVision from an MCP client

OpsVision runs an [MCP](https://modelcontextprotocol.io) server at `/v1/mcp`.
An MCP client, such as Claude Desktop, Cursor, or your own agent, can do
anything the web app does through it: read any view, enter data, import
records, and publish a report.

Every tool calls the matching API operation as you. Your role and scope apply
exactly as they do in the web app, and so do validation and the audit log.
Changes made through MCP are audited with channel `mcp`. The one exception is
the entry an import writes when it is applied, which has channel `import`, as
it does in the web app.

The examples use `https://opsvision.example.test`. Use your deployment's API
address instead. When you run `make dev` locally, it is
`http://127.0.0.1:8080`.

## 1. Create an access token

In the web app, open **My settings → Access tokens** and create a token. The
token (`ovs_pat_…`) is shown once, together with a ready-made client entry.
Copy it then: only its first characters are kept for display.

A token acts as you, in the organization you created it in, until it expires
or you revoke it. If your role changes, or you are removed from the
organization, the token follows on its next request. Treat the token like a
password: keep it out of shared files and repositories.

## 2. Configure your client

Every client sends the token as a bearer credential:

```http
Authorization: Bearer ovs_pat_…
```

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project
you do not share:

```json
{
  "mcpServers": {
    "opsvision": {
      "url": "https://opsvision.example.test/v1/mcp",
      "headers": { "Authorization": "Bearer ovs_pat_…" }
    }
  }
}
```

To keep the token out of the file, export it in your shell profile
(`export OPSVISION_TOKEN=ovs_pat_…`) and write the header as
`"Authorization": "Bearer ${env:OPSVISION_TOKEN}"`.

### Claude Desktop

Claude Desktop starts local MCP servers from its configuration file, so it
reaches a remote server through the `mcp-remote` bridge. The bridge needs
Node.js. Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "opsvision": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.16.1",
        "https://opsvision.example.test/v1/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${OPSVISION_AUTH}"
      ],
      "env": { "OPSVISION_AUTH": "Bearer ovs_pat_…" }
    }
  }
}
```

Passing the header through `env` keeps the space in `Bearer …` out of the
arguments, which some platforms split. Restart Claude Desktop afterwards. The
OpsVision tools then appear in the tools menu.

### Any other client

Point the client at `https://opsvision.example.test/v1/mcp` with the
Streamable HTTP transport and the header above. The server:

- takes one JSON-RPC 2.0 message per `POST` and answers with
  `application/json`. It never streams, so `GET` returns 405.
- keeps no sessions and issues no `Mcp-Session-Id`.
- speaks protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and
  `2024-11-05`. A client that asks for another version is offered
  `2025-11-25`.
- supports `initialize`, `ping`, `tools/list` and `tools/call`.
  Notifications get 202 with no body. Batches are refused with -32600.

You can check a token from a shell:

```sh
curl -s https://opsvision.example.test/v1/mcp \
  -H "Authorization: Bearer $OPSVISION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

There is one tool per API operation. Its name is the operation's
`operationId` in snake_case (see `openapi/openapi.yaml`):

| Operation | Tool |
|-----------|------|
| `getMe` | `get_me` |
| `listScorecards` | `list_scorecards` |
| `getScorecardView` | `get_scorecard_view` |
| `batchSaveData` | `batch_save_data` |
| `publishReport` | `publish_report` |

A tool's description is the operation's summary and description. Its input
schema takes:

- path parameters (for example `sc`, `period`) as required arguments;
- query parameters as arguments. A list, such as `periods`, is a JSON array;
- the request body, when the operation has one, as the `body` argument.

Annotations tell the client what a tool does. A `GET` tool has
`readOnlyHint`. A `DELETE` tool has `destructiveHint`. A `PUT` tool has
`idempotentHint`. Many clients ask before they run a tool without
`readOnlyHint`.

These operations are not tools:

- **Access tokens** (`listMyTokens`, `createMyToken`, `deleteMyToken`):
  manage tokens in the web app. A request made with a token cannot create a
  token anyway.
- **The MCP endpoint itself**.
- **Raw file transfers**: any operation whose body or response is not JSON.
  Upload a records export with `import_records_csv` instead.

### Results

A tool returns the API's JSON response as text. A JSON object of at most
256 KB also comes back as `structuredContent`.

An API error is a result with `isError: true` and text such as
`Error: HTTP 403 forbidden: tenant admin role required`, followed by one line
per validation problem. The model can read the message and correct the call.
An unknown tool name, or a tool that is not offered, is a JSON-RPC error
(-32602).

### import_records_csv

`import_records_csv` imports a CSV export of records (defects, epics, …) the
way the web app's Import page does: it starts an import, stores the file,
recognizes the saved records template, previews the import, and applies the
preview. Each step is the API operation (`create_import_upload`,
`inspect_import`, `preview_records_import`, `apply_import`), so it is
authorized and audited the same way. It is for admins only.

| Argument | Required | Meaning |
|----------|:--------:|---------|
| `recordType` | yes | The record type of the rows, such as `defect`. |
| `csv` | yes | The CSV text, header on line 1, at most 700 KB. |
| `templateId` | | The saved records template to read the file with. By default, the one that recognizes the file's columns. |
| `scorecardId` | | The scorecard the preview describes. By default, the organization's only scorecard. |
| `asOf` | | The date the export was taken (`YYYY-MM-DD`). By default, today. |
| `answers` | | Answers to the preview's questions, as in `preview_records_import`. |
| `dryRun` | | `true` previews without applying. |

The result holds the `importId`, the template, scorecard and as-of date used,
the `preview`, and, unless it was a dry run, `applied`. A file no saved
template recognizes needs a template first: save one with
`put_import_template`, or set up the import once in the web app.

A good habit is to preview first, read the questions the preview asks, then
apply. Either call again without `dryRun` and with the same `answers`, or call
`apply_import` with the dry run's `importId`, its preview's `planId`, and the
same answers.

## Limits

- **Tool results: 512 KB.** A longer result is cut at 512 KB and followed by
  the note `Result truncated at 512 KB; narrow the request (fewer periods or
  a smaller scope).` A two-year view of the whole company can reach this
  limit. Ask for fewer `periods`, or filter by `subjects` or `metrics`.
- **`import_records_csv`: 700 KB of CSV.** Split a larger export and import
  each part.
- **Requests: 4 MB** per JSON-RPC message.
- **Access tokens:** at most 10 active per user, each valid for 1 to 365 days
  (90 by default).
- The API's own limits apply too, such as at most 24 period columns in a
  view.

## Examples

Ask your client in plain language. For example:

- "Which metrics were red in September 2026 for Unit A, and what were their
  values?" The client calls `list_scorecards`, then `get_scorecard_view` with
  `{"sc": "<id>", "periods": ["2026-M09"], "subjects": ["unit-a"]}`.
- "How is *Epics delivered on time* measured?" The client calls
  `list_versions` and `get_version`.
- "Import this defects export and tell me what changes before you apply it."
  The client calls `import_records_csv` with `dryRun: true`, shows you the
  preview, then applies it.
- "Publish the September report." The client calls `publish_report` with
  `{"sc": "<id>", "period": "2026-M09"}`, and most clients ask you first.

A raw call looks like this:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_scorecard_view",
    "arguments": { "sc": "example-scorecard", "periods": ["2026-M08", "2026-M09"] }
  }
}
```
