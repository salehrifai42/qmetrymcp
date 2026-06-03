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
- **Search free-text** — the user-facing `query` filter maps to the API's `searchText` key via `buildFilter()`. Passing `query` verbatim is silently ignored by the API (returns all rows unfiltered). Same for cycle/plan search.
- `projectId` must be **numeric** (e.g. `10011`), never the key string (`"FS"`).
- Keys: `FS-TC-*` (test cases), `FS-TR-*` (cycles), `FS-TP-*` (plans).
- **Folder root** — new folders use `parentId: -1` for root level (`0` returns 404).
- **Priority/status on create/update cycle & plan** — numeric IDs (use `qtm4j_get_priorities` / `qtm4j_get_statuses`). The `NumericId` schema accepts a number or numeric string and rejects names.
- **Linking cycles to a plan** — `testcycleIds` are the cycle **UID strings** (e.g. `"xWmIdW1sgYd"` from search `id`), not numeric IDs or keys.
- **Archive before delete** — active cycles/plans/cases can't be deleted (API 400). Use `qtm4j_archive_test_{cycle,plan,case}` (PUT `/…/archive` body `"{}"`) first; `unarchive` restores. Test cycle/plan internal `id` is a **string UID**, not numeric.
- **Comments** — testcase comments are **version-scoped**: GET `/testcases/{id}/comments?versionNo=`; POST `/testcases/{id}/versions/{no}/comments` body `{comments:[...]}`; PUT/DELETE `…/versions/{no}/comments/{commentid}`. Cycle/plan comments are flat: `/testcycles|testplans/{id}/comments` (+ `/{commentid}`). Add tools accept a single `comment` string or a `comments` array.
- **Defects** — execution-level `/testcycles/{id}/testcase-executions/{execId}/defects` (POST `{filter}` to read, PUT/DELETE `{defectIDs:[…]}`); step-level `/testcycles/{id}/teststep-executions/{stepExecId}/defects`; cycle-level POST `/testcycles/{id}/defects/search` and `/summary` with `{filter}`. `defectIDs` are numeric Jira defect IDs.
- GET single-resource endpoints accept either internal ID or key. Search/execution endpoints require the internal `id` from a prior search response.
- 204 responses return `null` body; tools wrap these as `{ message: "…" }`.
- **Execution comment read-back** — no GET on a single execution (`/testcycles/{id}/testcase-executions/{execId}` is PUT/DELETE only → 405), no `…/comments` sub-resource (404), and `testcases/search` drops `comment`. The only read path for the saved comment/result/assignee is `GET /testcycles/{cycleId}/testcases/{testCycleTestCaseMapId}/executions` → `{ executions: { data: [{ comment, executionResult, assignee, … }] } }`. Keys on `testCycleTestCaseMapId`, not `testCaseExecutionId`. `data[]` is execution history; each record has a single `comment` (not a thread). Exposed as `qtm4j_get_test_execution`; `qtm4j_update_test_execution` uses it for read-after-write verification when given `testCycleTestCaseMapId`.
- AU region URL: `https://syd-qtmcloud.qmetry.com` (not `qtmcloud-au`).

## Local reference files (git-ignored)

| File | Purpose |
|---|---|
| `config.json` | API key + project ID for local use (copy from `config.template.json`) |
| `field_reference.json` | Real IDs/names for statuses, priorities, environments, builds, labels, components |
| `qtm4j_openapi_spec.json` | Full OpenAPI spec (1MB) |
