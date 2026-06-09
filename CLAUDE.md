# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Slash command

Run `/qtm4j <task>` in any Claude Code session in this repo to get a QMetry-aware assistant with all real field IDs pre-loaded (defined in `.claude/commands/qtm4j.md`).

## Commands

```bash
npm run build      # compile TypeScript → dist/
npm start          # run compiled server (requires QTM4J_API_KEY env var)
npm run dev        # run directly from source via tsx (no build step)
npm test           # run unit tests (node:test via tsx) — no API key or network needed
```

Unit tests live in `src/*.test.ts` and run against the HTTP client's injectable transport seam (`src/client.ts`), so they need no API key or live network. For end-to-end checks against a real tenant, build and hit the endpoint directly:

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

After rebuilding, restart the MCP server in Claude Code:
```bash
claude mcp remove qtm4j && claude mcp add qtm4j \
  -e QTM4J_API_KEY=<key> -e QTM4J_REGION=US \
  -- node /absolute/path/to/qmetrymcp/dist/index.js
```

## Architecture

Everything lives in a single file: **`src/index.ts`**.

### Key patterns

**Tool registration** — uses a thin `tool()` wrapper around `server.registerTool()` to avoid the deprecated `server.tool()` overload. The SDK handles Zod → JSON Schema conversion internally (supports both Zod v3 and v4):

```ts
const tool = <Shape extends z.ZodRawShape>(name, description, inputSchema, callback) =>
  server.registerTool(name, { description, inputSchema }, callback as any);
```

**HTTP** — the client is a side-effect-free deep module in `src/client.ts`. `createQtmClient({ apiKey, baseUrl, transport?, sleep?, maxAttempts? })` returns `{ fetch }`, which prepends `baseUrl`, injects the `apiKey` header, auto-retries 429s with exponential back-off (default 3 attempts), and returns parsed JSON or throws `QtmApiError` with HTTP status + body. The network is an injectable `Transport` port (production = global `fetch`; tests = in-memory adapter); `resolveBaseUrl(region)` maps US/AU → base URL. `src/index.ts` binds one client and exposes `qtmFetch(path, options?)` as a thin alias, so all tool call sites are unchanged.

**Search endpoints** — all use `POST /…/search` with filters in the body under `{ filter: { projectId, ...filters } }` and pagination on the query string. The `qs()` helper builds the query string, omitting `undefined` values.

**Execution endpoints** — `POST /testcycles/{id}/testcases/search` requires `{ filter: {} }` (not bare `{}`).

**Folder endpoints** — split by type, not a single `/folders` path:
- `GET/POST /projects/{projectId}/testcase-folders`
- `GET/POST /projects/{projectId}/testcycle-folders`
- `GET/POST /projects/{projectId}/testplan-folders`

**Automation run** — `POST /automation-rule/{key}/run` with body `{ projectId, testCycleId }`.

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

### Local reference files (git-ignored)

| File | Purpose |
|---|---|
| `config.json` | API key + project ID for local use |
| `field_reference.json` | Real IDs/names for statuses, priorities, environments, builds, labels, components fetched from your project |
| `qtm4j_openapi_spec.json` | Full OpenAPI spec (1MB), fetched from SwaggerHub |
| `config.template.json` | Committed template — copy to `config.json` |

### QTM4J API quirks

- `projectId` must be **numeric** (e.g. `10000`), never the key string (`"<KEY>"`).
- Keys follow the pattern `<KEY>-TC-*` (test cases), `<KEY>-TR-*` (cycles), `<KEY>-TP-*` (plans).
- The GET endpoints for a single resource accept either the internal ID or the key (`<KEY>-TR-123`). Search/execution endpoints require the internal `id` from a prior search response.
- **Search free-text** — the `query` filter maps to the API's `searchText` key (via `buildFilter()`); passing `query` raw is silently ignored and returns all rows.
- **Folder root** — new folders use `parentId: -1` for root (0 → 404).
- **Priority/status on create/update cycle & plan** — numeric IDs only (`NumericId` schema accepts a number or numeric string, rejects names). Resolve via `qtm4j_get_priorities` / `qtm4j_get_statuses`.
- **Linking cycles to a plan** — `testcycleIds` are cycle **UID strings** (search `id`), not numeric IDs. Cycle/plan internal `id` is a string UID.
- **Archive before delete** — active cycles/plans/cases return 400 on delete; archive first (`qtm4j_archive_test_{cycle,plan,case}`, PUT `/…/archive` body `"{}"`), `unarchive` restores.
- **Comments** — testcase comments are version-scoped (POST `/testcases/{id}/versions/{no}/comments`); cycle/plan comments are flat (`/testcycles|testplans/{id}/comments`). Add tools accept `comment` (string) or `comments` (array).
- **Defects** — execution/step/cycle level under `/testcycles/{id}/…/defects`; reads are POST `{filter}`, link/unlink are PUT/DELETE `{defectIDs:[…]}` (numeric Jira IDs).
- 204 responses return `null` body; the tools wrap these as `{ message: "…" }`.
- **Execution comment read-back** — there is no GET on a single execution (`/testcycles/{id}/testcase-executions/{execId}` is PUT/DELETE only → 405), no `…/comments` sub-resource (404), and `testcases/search` drops the `comment` field. The only read path that surfaces the saved comment/result/assignee is `GET /testcycles/{cycleId}/testcases/{testCycleTestCaseMapId}/executions` → `{ executions: { data: [{ comment, executionResult, assignee, … }] } }`. It keys on `testCycleTestCaseMapId` (not `testCaseExecutionId`); the execution id only appears inside each record. The `data[]` array is execution history (one entry per re-execution), each carrying a single `comment` (not a comment thread). Exposed via `qtm4j_get_test_execution`; `qtm4j_update_test_execution` uses it for optional read-after-write verification when given `testCycleTestCaseMapId`.
- AU region URL: `https://syd-qtmcloud.qmetry.com` (not `qtmcloud-au`).

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues on `salehrifai42/qmetrymcp` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
