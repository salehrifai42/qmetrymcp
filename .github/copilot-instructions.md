# QMetry MCP — GitHub Copilot Instructions

This is a **Model Context Protocol (MCP) server** for QMetry for Jira (QTM4J). Everything lives in a single file: `src/index.ts`.

## Commands

```bash
npm run build      # compile TypeScript → dist/
npm start          # run compiled server (requires QTM4J_API_KEY env var)
npm run dev        # run directly from source via tsx (no build step)
```

There are no tests. To verify a change, build and hit the endpoint directly:

```bash
QTM4J_API_KEY=<key> node -e "
const res = await fetch('https://qtmcloud.qmetry.com/rest/api/latest/<path>', {
  method: 'POST',
  headers: { apiKey: '<key>', 'Content-Type': 'application/json' },
  body: JSON.stringify(<body>)
});
console.log(await res.json());
"
```

## Architecture

### Tool registration

Uses a thin `tool()` wrapper around `server.registerTool()` to avoid the deprecated `server.tool()` overload. The SDK handles Zod → JSON Schema conversion internally:

```ts
const tool = <Shape extends z.ZodRawShape>(name, description, inputSchema, callback) =>
  server.registerTool(name, { description, inputSchema }, callback as any);
```

### HTTP

`qtmFetch(path, options?, attempt?)` prepends `BASE_URL`, injects `apiKey` header, auto-retries 429s with exponential back-off (max 3 attempts). Returns parsed JSON or throws with HTTP status + body.

### Shared schemas

```ts
const ID = z.union([z.string(), z.number()]);   // accepts both internal ID and key string
const Pagination = { startAt, maxResults, sort, fields };
const SearchFilters = { folderId, status, priority, assignee, query };
```

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `QTM4J_API_KEY` | yes | Sent as `apiKey` header on every request |
| `QTM4J_REGION` | no | `US` (default) or `AU` |

## QTM4J API patterns & quirks

- **Search endpoints** — `POST /…/search` with filters under `{ filter: { projectId, ...filters } }`, pagination on query string via `qs()` helper.
- **Execution endpoints** — `POST /testcycles/{id}/testcases/search` requires `{ filter: {} }` (not bare `{}`).
- **Folder endpoints** — split by type:
  - `GET/POST /projects/{projectId}/testcase-folders`
  - `GET/POST /projects/{projectId}/testcycle-folders`
  - `GET/POST /projects/{projectId}/testplan-folders`
- **Automation run** — `POST /automation-rule/{key}/run` with body `{ projectId, testCycleId }`.
- `projectId` must be **numeric** (e.g. `10011`), never the key string (`"FS"`).
- Keys: `FS-TC-*` (test cases), `FS-TR-*` (cycles), `FS-TP-*` (plans).
- GET single-resource endpoints accept either internal ID or key. Search/execution endpoints require the internal `id` from a prior search response.
- 204 responses return `null` body; tools wrap these as `{ message: "…" }`.
- AU region URL: `https://syd-qtmcloud.qmetry.com` (not `qtmcloud-au`).

## Local reference files (git-ignored)

| File | Purpose |
|---|---|
| `config.json` | API key + project ID for local use (copy from `config.template.json`) |
| `field_reference.json` | Real IDs/names for statuses, priorities, environments, builds, labels, components |
| `qtm4j_openapi_spec.json` | Full OpenAPI spec (1MB) |
