# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Slash command

Run `/qtm4j <task>` in any Claude Code session in this repo to get a QMetry-aware assistant with all real field IDs pre-loaded (defined in `.claude/commands/qtm4j.md`).

## Commands

```bash
npm run build      # compile TypeScript → dist/
npm start          # run compiled server (requires QTM4J_API_KEY env var)
npm run dev        # run directly from source via tsx (no build step)
```

There are no tests. To verify a change works, run the build and test the affected endpoint directly:

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
  -- node /Users/saleh.rifai/qmetrymcp/dist/index.js
```

## Architecture

Everything lives in a single file: **`src/index.ts`**.

### Key patterns

**Tool registration** — uses a thin `tool()` wrapper around `server.registerTool()` to avoid the deprecated `server.tool()` overload. The SDK handles Zod → JSON Schema conversion internally (supports both Zod v3 and v4):

```ts
const tool = <Shape extends z.ZodRawShape>(name, description, inputSchema, callback) =>
  server.registerTool(name, { description, inputSchema }, callback as any);
```

**HTTP** — `qtmFetch(path, options?, attempt?)` prepends `BASE_URL`, injects `apiKey` header, auto-retries 429s with exponential back-off (max 3 attempts). Returns parsed JSON or throws with HTTP status + body.

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
| `field_reference.json` | Real IDs/names for statuses, priorities, environments, builds, labels, components fetched from project 10011 |
| `qtm4j_openapi_spec.json` | Full OpenAPI spec (1MB), fetched from SwaggerHub |
| `config.template.json` | Committed template — copy to `config.json` |

### QTM4J API quirks

- `projectId` must be **numeric** (e.g. `10011`), never the key string (`"FS"`).
- Keys follow the pattern `FS-TC-*` (test cases), `FS-TR-*` (cycles), `FS-TP-*` (plans).
- The GET endpoints for a single resource accept either the internal ID or the key (`FS-TR-747`). Search/execution endpoints require the internal `id` from a prior search response.
- 204 responses return `null` body; the tools wrap these as `{ message: "…" }`.
- AU region URL: `https://syd-qtmcloud.qmetry.com` (not `qtmcloud-au`).
