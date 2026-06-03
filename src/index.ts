#!/usr/bin/env node
import dotenv from "dotenv";
// override:false → env vars from the parent process (Claude Code MCP config) win over `.env`,
// so a stale `.env` in the repo can't shadow a freshly-rotated key passed via the MCP launcher.
dotenv.config({ override: false });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";

// ── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.QTM4J_API_KEY;
const REGION = (process.env.QTM4J_REGION ?? "US").toUpperCase();

const BASE_URLS: Record<string, string> = {
  US: "https://qtmcloud.qmetry.com/rest/api/latest",
  AU: "https://syd-qtmcloud.qmetry.com/rest/api/latest",
};

const BASE_URL = BASE_URLS[REGION] ?? BASE_URLS["US"];
const CHARACTER_LIMIT = 25000;

if (!API_KEY) {
  process.stderr.write(
    "ERROR: QTM4J_API_KEY environment variable is required.\n" +
      "Set it in your MCP client config or in a .env file before starting the server.\n"
  );
  process.exit(1);
}

const FOLDER_SEGMENT: Record<"TESTCASE" | "TESTCYCLE" | "TESTPLAN", "testcase-folders" | "testcycle-folders" | "testplan-folders"> = {
  TESTCASE: "testcase-folders",
  TESTCYCLE: "testcycle-folders",
  TESTPLAN: "testplan-folders",
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

class QtmApiError extends Error {
  constructor(public status: number, public statusText: string, public body: unknown) {
    super(`HTTP ${status} ${statusText}`);
  }
}

async function qtmFetch(
  path: string,
  options: RequestInit = {},
  attempt = 1
): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    apiKey: API_KEY ?? "",
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  const response = await fetch(url, { ...options, headers });

  // Exponential back-off for rate limiting (max 3 attempts)
  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number.parseInt(
      response.headers.get("Retry-After") ?? "1",
      10
    );
    const delay = Math.max(retryAfter * 1000, 1000) * attempt;
    await new Promise((r) => setTimeout(r, delay));
    return qtmFetch(path, options, attempt + 1);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new QtmApiError(response.status, response.statusText, body);
  }

  return body;
}

/** Translate any thrown error into an actionable MCP tool error. */
function toolError(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let text: string;
  if (error instanceof QtmApiError) {
    const bodyStr = typeof error.body === "string" ? error.body : JSON.stringify(error.body);
    switch (error.status) {
      case 400:
        text = `Bad request (400): ${bodyStr}. Check that required fields are present and IDs are numeric where expected.`;
        break;
      case 401:
        text = `Unauthorized (401): QTM4J_API_KEY is invalid or expired. Generate a new key in QMetry → API Keys.`;
        break;
      case 403:
        text = `Forbidden (403): API key lacks permission for this resource. Check project access in QMetry.`;
        break;
      case 404:
        text = `Not found (404): The resource doesn't exist. Verify the ID/key, and remember internal IDs and keys (e.g. PROJ-TR-747) are different — search endpoints often need the internal id from a prior search response.`;
        break;
      case 429:
        text = `Rate limited (429) after retries: ${bodyStr}. Wait a minute and retry.`;
        break;
      default:
        text = `QMetry API error ${error.status} ${error.statusText}: ${bodyStr}`;
    }
  } else if (error instanceof Error) {
    text = `Error: ${error.message}`;
  } else {
    text = `Unexpected error: ${String(error)}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a successful API response as MCP tool content (JSON), with truncation. */
function okJSON(data: unknown) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    const original = text.length;
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n[... response truncated from ${original} to ${CHARACTER_LIMIT} chars. ` +
      `Use 'folderId' to scope, 'maxResults' / 'startAt' to paginate, or 'fields' to limit columns. ` +
      `For folder trees, pass a specific folderId to fetch only that subtree.]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Wrap markdown text as MCP tool content, with truncation. */
function okMarkdown(md: string) {
  let text = md;
  if (text.length > CHARACTER_LIMIT) {
    const original = text.length;
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n_[Response truncated from ${original} to ${CHARACTER_LIMIT} chars. Use filters/pagination to narrow results.]_`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Normalise a single `comment` string or a `comments` string array into an array. */
function normalizeComments(comment?: string, comments?: string[]): string[] {
  const list = comments ?? (comment !== undefined ? [comment] : []);
  if (list.length === 0) {
    throw new Error("Provide either `comment` (a string) or `comments` (an array of strings).");
  }
  return list;
}

/**
 * Normalise search filter inputs into the keys the QTM4J API expects.
 * The user-facing `query` field maps to the API's `searchText` filter; passing
 * `query` verbatim is silently ignored by the API (returns everything unfiltered).
 */
function buildFilter(filters: Record<string, unknown>): Record<string, unknown> {
  const { query, ...rest } = filters;
  if (query !== undefined && query !== "") rest.searchText = query;
  return rest;
}

/** Build a query string from a plain object, omitting undefined values. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Recursively collect all folder IDs in a subtree (inclusive of root). */
function collectFolderIds(nodes: any[], targetId?: number): number[] {
  function collectAll(items: any[]): number[] {
    const ids: number[] = [];
    for (const item of items) {
      ids.push(item.id);
      if (item.children?.length) ids.push(...collectAll(item.children));
    }
    return ids;
  }
  if (targetId === undefined) return collectAll(nodes);
  for (const node of nodes) {
    if (node.id === targetId) {
      return [node.id, ...collectAll(node.children ?? [])];
    }
    const found = collectFolderIds(node.children ?? [], targetId);
    if (found.length) return found;
  }
  return [];
}

async function getFolderIds(
  projectId: number | string,
  folderType: "TESTCASE" | "TESTCYCLE" | "TESTPLAN",
  folderId?: number
): Promise<number[]> {
  const data = (await qtmFetch(`/projects/${projectId}/${FOLDER_SEGMENT[folderType]}`)) as any;
  const nodes = data?.data ?? data ?? [];
  return folderId !== undefined ? collectFolderIds(nodes, folderId) : collectFolderIds(nodes);
}

async function countInFolder(
  endpoint: string,
  projectId: number | string,
  folderId: number,
  filters: Record<string, unknown>
): Promise<number> {
  const res = (await qtmFetch(`${endpoint}?maxResults=1`, {
    method: "POST",
    body: JSON.stringify({ filter: { projectId, folderId, ...buildFilter(filters) } }),
  })) as any;
  return res?.total ?? 0;
}

async function recursiveCount(
  endpoint: string,
  projectId: number | string,
  folderType: "TESTCASE" | "TESTCYCLE" | "TESTPLAN",
  folderId: number,
  filters: Record<string, unknown>
): Promise<{ total: number; folderCount: number }> {
  const ids = await getFolderIds(projectId, folderType, folderId);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  let total = 0;
  for (const chunk of chunks) {
    const counts = await Promise.all(chunk.map((id) => countInFolder(endpoint, projectId, id, filters)));
    total += counts.reduce((a, b) => a + b, 0);
  }
  return { total, folderCount: ids.length };
}

// ── Markdown formatters ──────────────────────────────────────────────────────

function fmtSearchResults(label: string, data: any): string {
  const items = data?.data ?? [];
  const total = data?.total ?? items.length;
  const lines = [`# ${label}`, "", `**Total**: ${total} · **Showing**: ${items.length}`, ""];
  if (!items.length) {
    lines.push("_No results._");
    return lines.join("\n");
  }
  for (const item of items) {
    const key = item.key ?? item.id;
    const summary = item.summary ?? item.name ?? "(no summary)";
    lines.push(`## ${summary} (${key})`);
    if (item.id && item.id !== key) lines.push(`- **Internal ID**: ${item.id}`);
    if (item.status?.name) lines.push(`- **Status**: ${item.status.name}`);
    if (item.priority?.name) lines.push(`- **Priority**: ${item.priority.name}`);
    if (item.assignee) lines.push(`- **Assignee**: ${item.assignee}`);
    if (item.archived) lines.push(`- **Archived**: yes`);
    lines.push("");
  }
  return lines.join("\n");
}

function fmtFolderTree(nodes: any[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}- **${node.name}** (id: ${node.id})`);
    if (node.children?.length) lines.push(fmtFolderTree(node.children, depth + 1));
  }
  return lines.join("\n");
}

function fmtExecutions(data: any): string {
  const items = data?.data ?? [];
  const total = data?.total ?? items.length;
  const lines = [`# Test Cycle Executions`, "", `**Total**: ${total} · **Showing**: ${items.length}`, ""];
  if (!items.length) return lines.concat(["_No executions._"]).join("\n");
  for (const ex of items) {
    lines.push(`## ${ex.summary ?? ex.key ?? ex.testCaseExecutionId}`);
    if (ex.testCaseExecutionId) lines.push(`- **Execution ID**: ${ex.testCaseExecutionId}`);
    if (ex.testCycleTestCaseMapId) lines.push(`- **Map ID** (for bulk update): ${ex.testCycleTestCaseMapId}`);
    if (ex.executionStatus?.name) lines.push(`- **Result**: ${ex.executionStatus.name}`);
    if (ex.priority?.name) lines.push(`- **Priority**: ${ex.priority.name}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Render one or more execution records (from GET …/testcases/{mapId}/executions). */
function fmtExecutionDetail(data: any, filterExecId?: string | number): string {
  let items: any[] = data?.executions?.data ?? [];
  if (filterExecId !== undefined) {
    items = items.filter((e) => String(e.testCaseExecutionId) === String(filterExecId));
  }
  const lines = [
    `# Test Execution`,
    "",
    `- **Test Cycle**: ${data?.id ?? ""}`,
    `- **Map ID**: ${data?.testCycleTestCaseMapId ?? ""}`,
    `- **Test Case**: ${data?.testCaseId ?? ""} (v${data?.versionNo ?? "?"})`,
    `- **Executions**: ${items.length}`,
    "",
  ];
  if (!items.length) return lines.concat(["_No matching execution record._"]).join("\n");
  for (const e of items) {
    lines.push(`## Execution ${e.testCaseExecutionId}`);
    if (e.executionResult?.name) lines.push(`- **Result**: ${e.executionResult.name}`);
    lines.push(`- **Comment**: ${e.comment ?? "_(none)_"}`);
    lines.push(`- **Assignee**: ${e.assignee ?? "_(unassigned)_"}`);
    if (e.environment?.name) lines.push(`- **Environment**: ${e.environment.name}`);
    if (e.build?.name) lines.push(`- **Build**: ${e.build.name}`);
    if (e.executed?.executedOn) lines.push(`- **Executed**: ${e.executed.executedOn}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const CustomField = z
  .object({
    id: z.string().describe("Custom field ID, e.g. qcf_1"),
    value: z.string().optional().describe("Field value"),
    cascadeValue: z.string().optional().describe("Cascade dropdown value"),
  })
  .strict();

const Pagination = {
  startAt: z.number().int().min(0).optional().describe("Page offset (default 0)"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Items per page (max 100, default 50)"),
  sort: z.string().optional().describe('Sort e.g. "id:asc" or "updated:desc"'),
  fields: z.string().optional().describe("Comma-separated fields to return"),
};

const SearchFilters = {
  folderId: z.number().int().optional().describe("Filter by folder ID"),
  status: z.array(z.string()).optional().describe("Filter by status name strings (e.g. ['To Do'])"),
  priority: z.array(z.string()).optional().describe("Filter by priority name strings (e.g. ['High'])"),
  assignee: z.array(z.string()).optional().describe("Filter by assignee Jira account IDs"),
  query: z.string().optional().describe("Free-text search on summary/key (mapped to the API's searchText filter)"),
};

const ID = z.union([z.string(), z.number()]);

// Accepts a number or a numeric string (e.g. 25510 or "25510") and normalises to a
// number. Rejects non-numeric names so callers get a clear "use the lookup tool" hint.
const NumericId = z
  .union([z.number().int(), z.string().regex(/^\d+$/, "Must be a numeric ID — use the matching qtm4j_get_* lookup tool to find it")])
  .transform((v) => Number(v));

const ResponseFormat = z
  .enum(["json", "markdown"])
  .default("json")
  .describe("Output format. 'markdown' is human-readable; 'json' (default) is machine-readable.");

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "qtm4j-mcp-server", version: "0.1.1" });

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type CallResult = { content: { type: "text"; text: string }[]; isError?: true };

const tool = <Shape extends z.ZodRawShape>(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: Shape;
    annotations: ToolAnnotations;
  },
  callback: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallResult>
) =>
  server.registerTool(
    name,
    config,
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      try {
        return await callback(args);
      } catch (err) {
        return toolError(err);
      }
    }) as any
  );

// ─────────────────────────────────────────────────────────────────────────────
//  TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_create_test_case",
  {
    title: "Create Test Case",
    description:
      "Create a new test case in QMetry. Returns the created test case object including its internal id and key (e.g. PROJ-TC-123). Priority, status, labels, and components use integer IDs.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      summary: z.string().describe("Test case title/summary"),
      precondition: z.string().optional().describe("Precondition / description text"),
      priority: z.number().int().optional().describe("Priority integer ID — use qtm4j_get_priorities to discover"),
      status: z.number().int().optional().describe("Status integer ID — use qtm4j_get_statuses to discover"),
      assignee: z.string().optional().describe("Assignee Jira account ID"),
      labels: z.array(z.number().int()).optional().describe("Label IDs to attach"),
      components: z.array(z.number().int()).optional().describe("Component IDs"),
      fixVersions: z.array(z.number().int()).optional().describe("Fix version IDs"),
      folderId: z.number().int().optional().describe("Target folder ID"),
      customFields: z.array(CustomField).optional().describe("Custom field values"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (body) => okJSON(await qtmFetch("/testcases", { method: "POST", body: JSON.stringify(body) }))
);

tool(
  "qtm4j_get_test_case",
  {
    title: "Get Test Case",
    description:
      "Get a test case by its internal ID or key (e.g. PROJ-TC-31950). Returns an array of versions with versionNo, isLatestVersion, aiGenerated flag, and any test steps.",
    inputSchema: {
      id: ID.describe("Test case ID or key (e.g. QTP-TC-1)"),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => okJSON(await qtmFetch(`/testcases/${id}`))
);

tool(
  "qtm4j_get_test_case_version",
  {
    title: "Get Test Case Version Details",
    description:
      "Get full details of a specific test case version: summary, description, precondition, priority, status, assignee, labels, components, fixVersions, sprint, custom fields, flakyScore, passRateScore. Pass 'latest' as versionNo to skip a get_test_case lookup.",
    inputSchema: {
      id: ID.describe("Test case ID or key (e.g. PROJ-TC-32282)"),
      versionNo: z
        .union([z.number().int(), z.literal("latest")])
        .default("latest")
        .describe("Version number, or 'latest' (default)"),
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated subset of fields to return (e.g. 'description,priority,status'). Omit for full payload."
        ),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, fields }) =>
    okJSON(await qtmFetch(`/testcases/${id}/versions/${versionNo}${qs({ fields })}`))
);

tool(
  "qtm4j_search_test_cases",
  {
    title: "Search Test Cases",
    description:
      "Search test cases in a project with optional filters. Returns total count and paginated data. Use status/priority name strings (e.g. 'To Do', 'High'). projectId must be numeric (e.g. 10000). Set recursive=true with folderId to count across all subfolders (returns total only, no data).",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      labels: z.array(z.string()).optional().describe("Filter by labels"),
      components: z.array(z.string()).optional().describe("Filter by components"),
      recursive: z
        .boolean()
        .optional()
        .describe("If true and folderId is set, counts test cases across all subfolders. Returns { total, folderCount } only."),
      response_format: ResponseFormat,
      ...SearchFilters,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, sort, fields, projectId, recursive, folderId, response_format, ...filters }) => {
    if (recursive && folderId !== undefined) {
      return okJSON(await recursiveCount("/testcases/search", projectId, "TESTCASE", folderId, filters));
    }
    const data = await qtmFetch(`/testcases/search${qs({ startAt, maxResults, sort, fields })}`, {
      method: "POST",
      body: JSON.stringify({ filter: { projectId, folderId, ...buildFilter(filters) } }),
    });
    return response_format === "markdown" ? okMarkdown(fmtSearchResults("Test Cases", data)) : okJSON(data);
  }
);

tool(
  "qtm4j_update_test_case",
  {
    title: "Update Test Case",
    description:
      "Update fields on a specific version of a test case. Requires the test case id and versionNo (usually 1 for latest). Priority and status take integer IDs.",
    inputSchema: {
      id: ID.describe("Test case ID"),
      versionNo: z.number().int().describe("Version number to update"),
      summary: z.string().optional(),
      precondition: z.string().optional(),
      priority: z.number().int().optional().describe("Priority integer ID"),
      status: z.number().int().optional().describe("Status integer ID"),
      assignee: z.string().optional().describe("Assignee Jira account ID"),
      labels: z.array(z.number().int()).optional(),
      components: z.array(z.number().int()).optional(),
      fixVersions: z.array(z.number().int()).optional(),
      customFields: z.array(CustomField).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, ...rest }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    return okJSON({ message: `Test case ${id} version ${versionNo} updated` });
  }
);

tool(
  "qtm4j_archive_test_case",
  {
    title: "Archive Test Case",
    description:
      "Archive a test case so it can be deleted (or hidden from active views). Uses the dedicated `PUT /testcases/{id}/archive` endpoint — DO NOT try to flip `archived:true` via bulk_update or update_test_case; those return 200 but the flag does not persist in some tenants. After this call, the case is read-only; use qtm4j_delete_test_case to permanently remove it.",
    inputSchema: {
      id: ID.describe("Test case UID (from search) or key (e.g. PROJ-TC-32755)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcases/${id}/archive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test case ${id} archived. Call qtm4j_delete_test_case to permanently remove.` });
  }
);

tool(
  "qtm4j_unarchive_test_case",
  {
    title: "Unarchive Test Case",
    description: "Restore an archived test case to active/editable state via PUT /testcases/{id}/unarchive.",
    inputSchema: { id: ID.describe("Test case UID (from search) or key (e.g. PROJ-TC-32755)") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcases/${id}/unarchive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test case ${id} unarchived` });
  }
);

tool(
  "qtm4j_delete_test_case",
  {
    title: "Delete Test Case",
    description:
      "Permanently delete a test case. Irreversible. NOTE: Active (non-archived) test cases cannot be deleted — the API returns `400 You can not delete active Test Case(s)`. Archive first via qtm4j_archive_test_case, then call this. The recommended path uses `DELETE /testcases/{id}` (no version suffix); the legacy `DELETE /testcases/{id}/versions/{n}` returns 404 once the case is archived. Pass `versionNo` only if you need to delete a specific non-latest version of a multi-version test case.",
    inputSchema: {
      id: ID.describe("Test case UID or key (e.g. PROJ-TC-32755)"),
      versionNo: z.number().int().optional().describe("Optional: delete a specific version. Omit to delete the entire test case after archive."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo }) => {
    const path = versionNo !== undefined ? `/testcases/${id}/versions/${versionNo}` : `/testcases/${id}`;
    await qtmFetch(path, { method: "DELETE" });
    return okJSON({ message: `Test case ${id}${versionNo !== undefined ? ` version ${versionNo}` : ""} deleted` });
  }
);

tool(
  "qtm4j_clone_test_cases",
  {
    title: "Clone Test Cases",
    description:
      "Bulk clone one or more test cases into a target project and optional folder. Each clone gets a fresh key; original test cases keep their existing folder memberships and linkages. Returns a background task with taskId and progressUrl — poll the progressUrl until status is 'Completed' (Title case, not COMPLETED).",
    inputSchema: {
      testCaseIds: z.array(z.string()).describe("Test case UIDs (strings, from search_test_cases — e.g. '4qpaflGmcp4gNM')"),
      projectId: z.union([z.string(), z.number()]).describe("Target project ID (numeric, e.g. 10000)"),
      folderId: z.union([z.string(), z.number()]).optional().describe("Target folder ID. Use -1 for root."),
      withAttachments: z.boolean().optional().default(true),
      withComments: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) =>
    okJSON(
      await qtmFetch("/testcases/bulk/clone", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          projectId: String(input.projectId),
          folderId: input.folderId === undefined ? undefined : String(input.folderId),
        }),
      })
    )
);

tool(
  "qtm4j_create_test_steps",
  {
    title: "Create Test Steps",
    description:
      "Add one or more test steps to a specific version of a test case. Each step has stepDetails (required), expectedResult, and testData. Returns the created step objects with their IDs.",
    inputSchema: {
      id: ID.describe("Test case ID"),
      versionNo: z.number().int().describe("Test case version number"),
      steps: z
        .array(
          z
            .object({
              stepDetails: z.string().describe("Step action/description"),
              expectedResult: z.string().optional(),
              testData: z.string().optional(),
            })
            .strict()
        )
        .describe("Steps to create"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, versionNo, steps }) =>
    okJSON(
      await qtmFetch(`/testcases/${id}/versions/${versionNo}/teststeps`, {
        method: "POST",
        body: JSON.stringify(steps),
      })
    )
);

tool(
  "qtm4j_update_test_steps",
  {
    title: "Update Test Steps",
    description:
      "Update existing test steps on a test case version. Each step must include its step id (from qtm4j_create_test_steps or qtm4j_get_test_case).",
    inputSchema: {
      id: ID.describe("Test case ID"),
      versionNo: z.number().int().describe("Test case version number"),
      steps: z
        .array(
          z
            .object({
              id: z.number().int().describe("Step ID to update"),
              stepDetails: z.string().optional(),
              expectedResult: z.string().optional(),
              testData: z.string().optional(),
            })
            .strict()
        )
        .describe("Steps to update"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, steps }) =>
    okJSON(
      await qtmFetch(`/testcases/${id}/versions/${versionNo}/teststeps`, {
        method: "PUT",
        body: JSON.stringify(steps),
      })
    )
);

// ─────────────────────────────────────────────────────────────────────────────
//  TEST CYCLES
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_create_test_cycle",
  {
    title: "Create Test Cycle",
    description:
      "Create a new test cycle. Returns the created cycle with its internal id and key (e.g. PROJ-TR-123). Use qtm4j_list_folders with folderType=TESTCYCLE to find valid folderId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      summary: z.string().describe("Test cycle name/summary"),
      description: z.string().optional(),
      priority: NumericId.optional().describe("Priority integer ID — use qtm4j_get_priorities to discover"),
      status: NumericId.optional().describe("Status integer ID — use qtm4j_get_statuses (module=testcycle) to discover"),
      assignee: z.string().optional().describe("Assignee Jira account ID"),
      folderId: z.number().int().optional().describe("Target folder ID"),
      plannedStartDate: z.string().optional().describe("ISO 8601 planned start date"),
      plannedEndDate: z.string().optional().describe("ISO 8601 planned end date"),
      customFields: z.array(CustomField).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => okJSON(await qtmFetch("/testcycles", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "qtm4j_get_test_cycle",
  {
    title: "Get Test Cycle",
    description:
      "Get a test cycle by its key (e.g. PROJ-TR-747) or internal id. The internal 'id' returned here is required by qtm4j_get_test_cycle_executions and qtm4j_update_test_execution.",
    inputSchema: { id: ID.describe("Test cycle ID or key") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => okJSON(await qtmFetch(`/testcycles/${id}`))
);

tool(
  "qtm4j_search_test_cycles",
  {
    title: "Search Test Cycles",
    description:
      "Search test cycles in a project. Returns total count and paginated list. The 'id' field in results is the internal ID needed for execution tools.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      response_format: ResponseFormat,
      ...SearchFilters,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, sort, fields, projectId, response_format, ...filters }) => {
    const data = await qtmFetch(`/testcycles/search${qs({ startAt, maxResults, sort, fields })}`, {
      method: "POST",
      body: JSON.stringify({ filter: { projectId, ...buildFilter(filters) } }),
    });
    return response_format === "markdown" ? okMarkdown(fmtSearchResults("Test Cycles", data)) : okJSON(data);
  }
);

tool(
  "qtm4j_update_test_cycle",
  {
    title: "Update Test Cycle",
    description: "Update a test cycle's metadata (summary, description, priority, status, dates, custom fields).",
    inputSchema: {
      id: ID.describe("Test cycle ID"),
      summary: z.string().optional(),
      description: z.string().optional(),
      priority: NumericId.optional().describe("Priority integer ID — use qtm4j_get_priorities"),
      status: NumericId.optional().describe("Status integer ID — use qtm4j_get_statuses (module=testcycle)"),
      assignee: z.string().optional(),
      plannedStartDate: z.string().optional().describe("ISO 8601 date"),
      plannedEndDate: z.string().optional().describe("ISO 8601 date"),
      customFields: z.array(CustomField).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, ...rest }) => {
    await qtmFetch(`/testcycles/${id}`, { method: "PUT", body: JSON.stringify(rest) });
    return okJSON({ message: `Test cycle ${id} updated` });
  }
);

tool(
  "qtm4j_delete_test_cycle",
  {
    title: "Delete Test Cycle",
    description: "Permanently delete a test cycle and all its execution records. Irreversible. NOTE: Active cycles cannot be deleted (API returns 400). Archive first via qtm4j_archive_test_cycle, then call this.",
    inputSchema: { id: ID.describe("Test cycle ID") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcycles/${id}`, { method: "DELETE" });
    return okJSON({ message: `Test cycle ${id} deleted` });
  }
);

tool(
  "qtm4j_archive_test_cycle",
  {
    title: "Archive Test Cycle",
    description:
      "Archive a test cycle via PUT /testcycles/{id}/archive so it can be deleted or hidden from active views. Active cycles must be archived before qtm4j_delete_test_cycle will succeed.",
    inputSchema: { id: ID.describe("Test cycle ID or key (e.g. PROJ-TR-123)") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcycles/${id}/archive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test cycle ${id} archived. Call qtm4j_delete_test_cycle to permanently remove.` });
  }
);

tool(
  "qtm4j_unarchive_test_cycle",
  {
    title: "Unarchive Test Cycle",
    description: "Restore an archived test cycle to active state via PUT /testcycles/{id}/unarchive.",
    inputSchema: { id: ID.describe("Test cycle ID or key") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcycles/${id}/unarchive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test cycle ${id} unarchived` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  TEST EXECUTIONS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_get_test_cycle_executions",
  {
    title: "List Test Cycle Executions",
    description:
      "List all test case executions linked to a test cycle. Requires the internal cycle id (from qtm4j_get_test_cycle). Returns testCycleTestCaseMapId (for bulk_update), testCaseExecutionId (for update_test_execution), key, status, priority per test case.",
    inputSchema: {
      id: ID.describe("Test cycle ID (internal ID from qtm4j_search_test_cycles)"),
      response_format: ResponseFormat,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, startAt, maxResults, sort, fields, response_format }) => {
    const data = await qtmFetch(
      `/testcycles/${id}/testcases/search${qs({ startAt, maxResults, sort, fields })}`,
      {
        method: "POST",
        body: JSON.stringify({ filter: {} }),
      }
    );
    return response_format === "markdown" ? okMarkdown(fmtExecutions(data)) : okJSON(data);
  }
);

tool(
  "qtm4j_get_test_execution",
  {
    title: "Get Test Execution",
    description:
      "Read back a test case execution's result, comment, and assignee from a test cycle — the only path that surfaces the saved execution comment (search/GET-execution endpoints drop it). " +
      "Requires the cycle's internal id and testCycleTestCaseMapId (both from qtm4j_get_test_cycle_executions). " +
      "Returns { executions: { data: [...] } }; each record carries one comment, executionResult, assignee, environment, build, and timestamps. " +
      "The data array is execution history (one entry per re-execution). Pass testCaseExecutionId to filter to a single record. Use this to verify a write made by qtm4j_update_test_execution.",
    inputSchema: {
      cycleId: ID.describe("Test cycle internal ID (from qtm4j_get_test_cycle)"),
      testCycleTestCaseMapId: z
        .number()
        .int()
        .describe("Map ID linking the test case to the cycle (from qtm4j_get_test_cycle_executions)"),
      testCaseExecutionId: ID.optional().describe(
        "Optional: filter to the single execution record with this id (from qtm4j_get_test_cycle_executions)"
      ),
      response_format: ResponseFormat,
      startAt: z.number().int().optional().describe("Page offset for execution history"),
      maxResults: z.number().int().optional().describe("Max execution-history records to return (max 100)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCycleTestCaseMapId, testCaseExecutionId, response_format, startAt, maxResults }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/testcases/${testCycleTestCaseMapId}/executions${qs({ startAt, maxResults })}`
    );
    if (testCaseExecutionId !== undefined) {
      const all: any[] = (data as any)?.executions?.data ?? [];
      const match = all.filter((e) => String(e.testCaseExecutionId) === String(testCaseExecutionId));
      (data as any).executions = { ...(data as any).executions, data: match, total: match.length };
    }
    return response_format === "markdown"
      ? okMarkdown(fmtExecutionDetail(data, testCaseExecutionId))
      : okJSON(data);
  }
);

tool(
  "qtm4j_link_test_cases_to_cycle",
  {
    title: "Link Test Cases to Test Cycle",
    description:
      "Link one or more test cases to a test cycle so they appear in its execution list. Pass the cycle's internal id and an array of { id, versionNo } pairs (id is the test case internal UID; versionNo is usually 1).",
    inputSchema: {
      id: ID.describe("Test cycle internal ID"),
      testCases: z
        .array(
          z.object({
            id: z.string().describe("Test case internal UID"),
            versionNo: z.number().int().describe("Test case version, usually 1"),
          })
        )
        .describe("Test cases to link"),
      sort: z.string().optional().describe('Sort, e.g. "key:ASC"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, ...body }) => {
    const data = await qtmFetch(`/testcycles/${id}/testcases`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return okJSON(data ?? { message: `Linked ${body.testCases.length} test case(s) to cycle ${id}` });
  }
);

tool(
  "qtm4j_unlink_test_cases_from_cycle",
  {
    title: "Unlink Test Cases from Test Cycle",
    description:
      "Remove one or more linked test cases from a test cycle. Pass the cycle's internal id and an array of test cases as { id, versionNo } (get both from qtm4j_get_test_cycle_executions — its 'id' field is the test case id).",
    inputSchema: {
      id: ID.describe("Test cycle internal ID"),
      testCases: z
        .array(z.object({ id: z.string(), versionNo: z.number().int() }))
        .describe("Test cases to unlink as { id, versionNo } (from qtm4j_get_test_cycle_executions)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, testCases }) => {
    await qtmFetch(`/testcycles/${id}/testcases`, {
      method: "DELETE",
      body: JSON.stringify({ testCases }),
    });
    return okJSON({ message: `Unlinked ${testCases.length} test case(s) from cycle ${id}` });
  }
);

tool(
  "qtm4j_update_test_execution",
  {
    title: "Update Test Execution",
    description:
      "Update a single test case execution result inside a test cycle. Use testCaseExecutionId from qtm4j_get_test_cycle_executions. executionResultId is an instance-specific integer ID — call qtm4j_get_execution_results to resolve names (Pass/Fail/Blocked/etc.) to IDs. " +
      "Pass testCycleTestCaseMapId to enable read-after-write verification: the tool re-reads the execution and returns the saved comment/result/assignee so you can confirm the write landed.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      executionResultId: z.number().int().optional().describe("Execution result/status ID"),
      environmentId: z.number().int().optional().describe("Environment ID"),
      buildId: z.number().int().optional().describe("Build ID"),
      comment: z.string().optional().describe("Execution comment"),
      actualTime: z.string().optional().describe('Actual time in "HH:MM" format (e.g. "1:30")'),
      executionAssignee: z.string().optional().describe("Jira account ID of execution assignee"),
      executionPlannedDate: z.string().optional().describe("Planned execution date (ISO 8601)"),
      testCycleTestCaseMapId: z
        .number()
        .int()
        .optional()
        .describe(
          "Optional map ID (from qtm4j_get_test_cycle_executions). If provided, the tool re-reads the execution after writing and returns the persisted values for verification."
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, testCycleTestCaseMapId, ...rest }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    if (testCycleTestCaseMapId === undefined) {
      return okJSON({
        message: `Execution ${testCaseExecutionId} updated`,
        verified: false,
        note: "Pass testCycleTestCaseMapId to read back and verify the saved comment/result/assignee.",
      });
    }
    let verified: any = null;
    try {
      const data = await qtmFetch(
        `/testcycles/${cycleId}/testcases/${testCycleTestCaseMapId}/executions`
      );
      const all: any[] = (data as any)?.executions?.data ?? [];
      const rec = all.find((e) => String(e.testCaseExecutionId) === String(testCaseExecutionId));
      if (rec) {
        verified = {
          executionResult: rec.executionResult?.name ?? null,
          comment: rec.comment ?? null,
          assignee: rec.assignee ?? null,
        };
      }
    } catch {
      /* fall through to unverified response */
    }
    return okJSON(
      verified
        ? { message: `Execution ${testCaseExecutionId} updated and verified`, verified: true, execution: verified }
        : {
            message: `Execution ${testCaseExecutionId} updated`,
            verified: false,
            note: "Write succeeded but the execution record could not be re-read for verification.",
          }
    );
  }
);

tool(
  "qtm4j_update_test_step_execution",
  {
    title: "Update Test Step Execution",
    description:
      "Update a single step-level execution result within a test case execution. testStepExecutionId comes from qtm4j_get_test_cycle_executions step data.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testStepExecutionId: ID.describe("Test step execution ID"),
      executionResultId: z.number().int().optional().describe("Execution result ID"),
      actualResult: z.string().optional().describe("Actual result text"),
      comment: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testStepExecutionId, ...rest }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/teststep-executions/${testStepExecutionId}`,
      { method: "PUT", body: JSON.stringify(rest) }
    );
    return okJSON(data ?? { message: `Step execution ${testStepExecutionId} updated` });
  }
);

tool(
  "qtm4j_bulk_update_test_executions",
  {
    title: "Bulk Update Test Executions",
    description:
      "Apply the same execution result, environment, or build to multiple test case executions at once. Use testCycleTestCaseMapIds from qtm4j_get_test_cycle_executions (the 'testCycleTestCaseMapId' field).",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCycleTestCaseMapIds: z.array(z.number().int()).describe("Test-case-execution map IDs to update"),
      executionResultId: z.number().int().optional().describe("Execution result ID to apply to all — use qtm4j_get_execution_results to resolve names to IDs"),
      environmentId: z.number().int().optional().describe("Environment ID to apply to all"),
      buildId: z.number().int().optional().describe("Build ID to apply to all"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, ...rest }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcases/bulk`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    return okJSON({ message: "Bulk execution update applied" });
  }
);

tool(
  "qtm4j_upload_execution_attachment",
  {
    title: "Upload Attachment to Test Execution",
    description:
      "Upload a local file as an attachment on an existing test-case execution inside a test cycle. " +
      "This is a TWO-STEP presigned-S3 POST flow — NOT a direct multipart upload to QMetry. " +
      "Step 1: GET `/testcycles/{cycleId}/testcase-executions/attachments/url/?fileName=…&projectId=…&testcaseExecutionId=…` " +
      "returns `{ endpoint_url, params }` where `params` is a full AWS S3 browser-POST policy " +
      "(`key`, `policy`, `success_action_status:201`, `x-amz-*`, `Content-Type`, …). " +
      "Step 2: this tool POSTs `multipart/form-data` to `endpoint_url` with every `params` entry as a form field FIRST " +
      "(order matters), then the `file` field LAST whose Blob type MUST equal the `Content-Type` param " +
      "(e.g. `image/png`, `video/mp4`, `video/webm`) — otherwise S3 returns 403 SignatureDoesNotMatch. " +
      "S3 returns 201 on success; there is no follow-up `register` call. " +
      "GOTCHA: do NOT POST/PUT to the `…/testcase-executions/{id}/attachments` collection itself — it is list/delete only " +
      "and returns 405 on write. To replace a file, call qtm4j_delete_execution_attachment then re-upload with the same fileName. " +
      "Sibling credentials endpoints exist for `/testplans/attachments/url/` and `/shareabletestcases/teststeps/attachments/url/`.",
    inputSchema: {
      cycleId: z.string().describe("Test cycle internal id (e.g. from qtm4j_search_test_cycles)"),
      testcaseExecutionId: ID.describe(
        "Test-case-execution id (the `testCaseExecutionId` field from qtm4j_get_test_cycle_executions)"
      ),
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      filePath: z.string().describe("Absolute path to the local file to upload"),
      fileName: z
        .string()
        .optional()
        .describe("Override file name shown in QMetry. Defaults to basename(filePath)."),
      inline: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether QMetry should render the attachment inline (default false)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ cycleId, testcaseExecutionId, projectId, filePath, fileName, inline }) => {
    const name = fileName ?? basename(filePath);
    const bytes = await readFile(filePath);

    // Step 1 — request presigned S3 POST policy from QMetry.
    const credentials = (await qtmFetch(
      `/testcycles/${cycleId}/testcase-executions/attachments/url/${qs({
        fileName: name,
        projectId,
        testcaseExecutionId,
        inline: inline ?? false,
      })}`
    )) as { endpoint_url: string; params: Record<string, string> };

    if (!credentials?.endpoint_url || !credentials?.params) {
      throw new Error(
        `QMetry attachments/url endpoint returned an unexpected payload: ${JSON.stringify(credentials)}`
      );
    }

    const contentType = credentials.params["Content-Type"] ?? "application/octet-stream";

    // Step 2 — multipart POST to S3. Append every policy field FIRST, file LAST.
    const form = new FormData();
    for (const [k, v] of Object.entries(credentials.params)) {
      form.append(k, v);
    }
    // The file Blob's type MUST match the policy's Content-Type or S3 rejects the signature.
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), name);

    const s3Response = await fetch(credentials.endpoint_url, { method: "POST", body: form });
    if (![200, 201, 204].includes(s3Response.status)) {
      const errBody = await s3Response.text();
      throw new Error(
        `S3 upload failed (HTTP ${s3Response.status} ${s3Response.statusText}): ${errBody}`
      );
    }

    return okJSON({
      message: `Uploaded ${name} to execution ${testcaseExecutionId} in cycle ${cycleId}. ` +
        `Attachment registration in QMetry may lag a few seconds — call qtm4j_list_execution_attachments to confirm.`,
      fileName: name,
      contentType,
      s3Status: s3Response.status,
    });
  }
);

tool(
  "qtm4j_list_execution_attachments",
  {
    title: "List Test-Execution Attachments",
    description:
      "List all attachments on a test-case execution. " +
      "GET `/testcycles/{cycleId}/testcase-executions/{testcaseExecutionId}/attachments` → `{ data: [{ name, id, fileSize, ... }] }`. " +
      "Note: after qtm4j_upload_execution_attachment succeeds, registration of the new entry can lag a few seconds.",
    inputSchema: {
      cycleId: z.string().describe("Test cycle internal id"),
      testcaseExecutionId: ID.describe("Test-case-execution id"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testcaseExecutionId }) =>
    okJSON(
      await qtmFetch(
        `/testcycles/${cycleId}/testcase-executions/${testcaseExecutionId}/attachments`
      )
    )
);

tool(
  "qtm4j_delete_execution_attachment",
  {
    title: "Delete Test-Execution Attachments",
    description:
      "Delete one or more attachments from a test-case execution. " +
      "DELETE `/testcycles/{cycleId}/testcase-executions/{testcaseExecutionId}/attachments` with JSON body " +
      "`{\"attachmentIds\":[…]}` (or `{\"deleteAll\":true}`) → 204. " +
      "GOTCHAS — all of these are WRONG and return 404/400: " +
      "(a) appending `/{attachmentId}` to the attachments path; " +
      "(b) the path `…/testcase-executions/attachments/{id}` (no executionId in front); " +
      "(c) sending a bare array body. " +
      "It MUST be the collection path plus an `attachmentIds` (or `deleteAll`) JSON body.",
    inputSchema: {
      cycleId: z.string().describe("Test cycle internal id"),
      testcaseExecutionId: ID.describe("Test-case-execution id"),
      attachmentIds: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("Attachment ids to delete (from qtm4j_list_execution_attachments). Omit if deleteAll=true."),
      deleteAll: z
        .boolean()
        .optional()
        .describe("If true, delete every attachment on this execution. Mutually exclusive with attachmentIds."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testcaseExecutionId, attachmentIds, deleteAll }) => {
    if (!deleteAll && (!attachmentIds || attachmentIds.length === 0)) {
      throw new Error(
        "Provide attachmentIds (non-empty) or set deleteAll=true."
      );
    }
    const body: Record<string, unknown> = deleteAll
      ? { deleteAll: true }
      : { attachmentIds };
    await qtmFetch(
      `/testcycles/${cycleId}/testcase-executions/${testcaseExecutionId}/attachments`,
      { method: "DELETE", body: JSON.stringify(body) }
    );
    return okJSON({
      message: deleteAll
        ? `Deleted all attachments on execution ${testcaseExecutionId}`
        : `Deleted ${attachmentIds!.length} attachment(s) on execution ${testcaseExecutionId}`,
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  TEST PLANS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_create_test_plan",
  {
    title: "Create Test Plan",
    description:
      "Create a new test plan. Returns the created plan with internal id and key (e.g. PROJ-TP-44). Use qtm4j_list_folders with folderType=TESTPLAN to find valid folderId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      summary: z.string().describe("Test plan name/summary"),
      description: z.string().optional(),
      priority: NumericId.optional().describe("Priority integer ID — use qtm4j_get_priorities"),
      status: NumericId.optional().describe("Status integer ID — use qtm4j_get_statuses (module=testplan)"),
      assignee: z.string().optional().describe("Assignee Jira account ID"),
      folderId: z.number().int().optional().describe("Target folder ID"),
      customFields: z.array(CustomField).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => okJSON(await qtmFetch("/testplans", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "qtm4j_get_test_plan",
  {
    title: "Get Test Plan",
    description:
      "Get a test plan by its key (e.g. PROJ-TP-43) or internal id. Use the internal 'id' for link/unlink/get_linked_test_cycles operations.",
    inputSchema: { id: ID.describe("Test plan ID or key") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => okJSON(await qtmFetch(`/testplans/${id}`))
);

tool(
  "qtm4j_search_test_plans",
  {
    title: "Search Test Plans",
    description: "Search test plans in a project. The 'id' field in results is the internal ID needed for linking cycles.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      response_format: ResponseFormat,
      ...SearchFilters,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, sort, fields, projectId, response_format, ...filters }) => {
    const data = await qtmFetch(`/testplans/search${qs({ startAt, maxResults, sort, fields })}`, {
      method: "POST",
      body: JSON.stringify({ filter: { projectId, ...buildFilter(filters) } }),
    });
    return response_format === "markdown" ? okMarkdown(fmtSearchResults("Test Plans", data)) : okJSON(data);
  }
);

tool(
  "qtm4j_update_test_plan",
  {
    title: "Update Test Plan",
    description: "Update a test plan's priority or custom fields.",
    inputSchema: {
      id: ID.describe("Test plan ID"),
      priority: NumericId.optional().describe("Priority integer ID — use qtm4j_get_priorities"),
      customFields: z.array(CustomField).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, ...rest }) => {
    await qtmFetch(`/testplans/${id}`, { method: "PUT", body: JSON.stringify(rest) });
    return okJSON({ message: `Test plan ${id} updated` });
  }
);

tool(
  "qtm4j_delete_test_plan",
  {
    title: "Delete Test Plan",
    description: "Permanently delete a test plan. Does not delete the linked test cycles. NOTE: Active plans cannot be deleted (API returns 400). Archive first via qtm4j_archive_test_plan, then call this.",
    inputSchema: { id: ID.describe("Test plan ID") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}`, { method: "DELETE" });
    return okJSON({ message: `Test plan ${id} deleted` });
  }
);

tool(
  "qtm4j_archive_test_plan",
  {
    title: "Archive Test Plan",
    description:
      "Archive a test plan via PUT /testplans/{id}/archive so it can be deleted or hidden from active views. Active plans must be archived before qtm4j_delete_test_plan will succeed.",
    inputSchema: { id: ID.describe("Test plan ID or key (e.g. PROJ-TP-12)") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}/archive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test plan ${id} archived. Call qtm4j_delete_test_plan to permanently remove.` });
  }
);

tool(
  "qtm4j_unarchive_test_plan",
  {
    title: "Unarchive Test Plan",
    description: "Restore an archived test plan to active state via PUT /testplans/{id}/unarchive.",
    inputSchema: { id: ID.describe("Test plan ID or key") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}/unarchive`, { method: "PUT", body: "{}" });
    return okJSON({ message: `Test plan ${id} unarchived` });
  }
);

tool(
  "qtm4j_link_test_cycles_to_plan",
  {
    title: "Link Test Cycles to Plan",
    description:
      "Link existing test cycles to a test plan. Use the plan's internal id. testcycleIds are the cycle UID strings (e.g. 'xWmIdW1sgYd' from qtm4j_search_test_cycles), NOT numeric ids or keys.",
    inputSchema: {
      id: ID.describe("Test plan ID"),
      testcycleIds: z.array(z.string()).describe("Test cycle UID strings to link (from qtm4j_search_test_cycles 'id' field)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, testcycleIds }) => {
    await qtmFetch(`/testplans/${id}/testcycles`, {
      method: "PUT",
      body: JSON.stringify({ testcycleIds }),
    });
    return okJSON({ message: `Test cycles linked to plan ${id}` });
  }
);

tool(
  "qtm4j_get_linked_test_cycles",
  {
    title: "List Linked Test Cycles",
    description: "List all test cycles currently linked to a test plan. Use the plan's internal id (not key).",
    inputSchema: {
      id: ID.describe("Test plan ID"),
      response_format: ResponseFormat,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, startAt, maxResults, sort, fields, response_format }) => {
    const data = await qtmFetch(
      `/testplans/${id}/testcycles${qs({ startAt, maxResults, sort, fields })}`,
      { method: "POST", body: JSON.stringify({ filter: {} }) }
    );
    return response_format === "markdown" ? okMarkdown(fmtSearchResults("Linked Test Cycles", data)) : okJSON(data);
  }
);

tool(
  "qtm4j_unlink_test_cycles_from_plan",
  {
    title: "Unlink Test Cycles from Plan",
    description: "Remove the link between one or more test cycles and a test plan. Does not delete the cycles themselves.",
    inputSchema: {
      id: ID.describe("Test plan ID"),
      testcycleIds: z.array(z.string()).describe("Test cycle UID strings to unlink (from qtm4j_search_test_cycles 'id' field)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, testcycleIds }) => {
    await qtmFetch(`/testplans/${id}/testcycles`, {
      method: "DELETE",
      body: JSON.stringify({ testcycleIds }),
    });
    return okJSON({ message: `Test cycles unlinked from plan ${id}` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  FOLDERS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_list_folders",
  {
    title: "List Folders",
    description:
      "List folders of a given type as a nested tree with id, name, parentId, and children. STRONGLY RECOMMENDED to pass folderId for large projects to return only that subtree — full project trees can exceed response size limits.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      folderType: z.enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"]).describe("Folder type to list"),
      folderId: z
        .number()
        .int()
        .optional()
        .describe("Return only this folder and its children (subtree). Strongly recommended for large projects."),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, folderType, folderId, response_format }) => {
    const data = (await qtmFetch(`/projects/${projectId}/${FOLDER_SEGMENT[folderType]}`)) as any;
    const nodes = data?.data ?? data ?? [];

    let result: any;
    if (folderId === undefined) {
      result = nodes;
    } else {
      function findSubtree(items: any[]): any | null {
        for (const item of items) {
          if (item.id === folderId) return item;
          const found = findSubtree(item.children ?? []);
          if (found) return found;
        }
        return null;
      }
      const subtree = findSubtree(nodes);
      if (!subtree) return okJSON({ error: `Folder ${folderId} not found` });
      result = [subtree];
    }

    if (response_format === "markdown") {
      const header = folderId !== undefined ? `# Folder Subtree (${folderId})` : `# ${folderType} Folders`;
      return okMarkdown(`${header}\n\n${fmtFolderTree(result)}`);
    }
    return okJSON(folderId !== undefined ? result[0] : result);
  }
);

tool(
  "qtm4j_create_folder",
  {
    title: "Create Folder",
    description:
      "Create a new folder under an existing parent folder. Use parentId=-1 for root-level (0 returns 404). Use qtm4j_list_folders first to find valid parentId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10000)"),
      folderName: z.string().describe("Folder name"),
      folderType: z.enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"]).describe("Folder type"),
      parentId: z.number().int().describe("Parent folder ID (use -1 for root)"),
      description: z.string().optional().describe("Folder description"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ projectId, folderType, folderName, parentId, description }) =>
    okJSON(
      await qtmFetch(`/projects/${projectId}/${FOLDER_SEGMENT[folderType]}`, {
        method: "POST",
        body: JSON.stringify({ folderName, parentId, description }),
      })
    )
);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTOMATION
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_link_automation_rule",
  {
    title: "Link Automation Rule to Cycle",
    description:
      "Associate an automation rule with a test cycle so it can be triggered for that cycle. automationRuleKey is the rule's string key from your QMetry automation config.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      automationRuleKey: z.string().describe("Automation rule key to link"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, automationRuleKey }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/automation-rule/link/${automationRuleKey}`,
      { method: "PUT", body: JSON.stringify({}) }
    );
    return okJSON(data ?? { message: "Automation rule linked" });
  }
);

tool(
  "qtm4j_unlink_automation_rule",
  {
    title: "Unlink Automation Rule from Cycle",
    description: "Remove the association between an automation rule and a test cycle.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      automationRuleKey: z.string().describe("Automation rule key to unlink"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, automationRuleKey }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/automation-rule/unlink/${automationRuleKey}`,
      { method: "PUT", body: JSON.stringify({}) }
    );
    return okJSON(data ?? { message: "Automation rule unlinked" });
  }
);

tool(
  "qtm4j_run_automation_rules",
  {
    title: "Run Automation Rule",
    description:
      "Trigger an automation rule to run against a specific test cycle. testCycleId is the internal id string (from qtm4j_get_test_cycle). Returns a background task object with taskId and progressUrl.",
    inputSchema: {
      automationRuleKey: z.string().describe("Automation rule key to run"),
      projectId: z.number().int().describe("Jira project numeric ID (e.g. 10000)"),
      testCycleId: z.string().describe("Internal test cycle ID (from qtm4j_search_test_cycles)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ automationRuleKey, projectId, testCycleId }) =>
    okJSON(
      await qtmFetch(`/automation-rule/${automationRuleKey}/run`, {
        method: "POST",
        body: JSON.stringify({ projectId, testCycleId }),
      })
    )
);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTHORING (extra tools that help building & organising test cases)
// ─────────────────────────────────────────────────────────────────────────────

const StepFilter = z
  .object({
    stepDetails: z.string().optional(),
    testData: z.string().optional(),
    expectedResult: z.string().optional(),
  })
  .optional();

const FOLDER_MODULE = z.enum(["testcase", "testcycle", "testplan"]);

tool(
  "qtm4j_get_test_steps",
  {
    title: "Get Test Steps",
    description:
      "List the steps of a test case version. Optional filter narrows by step details / test data / expected result substring.",
    inputSchema: {
      id: ID.describe("Test case ID or key"),
      versionNo: z.number().int().describe("Test case version number"),
      filter: StepFilter,
      ...Pagination,
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, filter, startAt, maxResults, sort }) =>
    okJSON(
      await qtmFetch(
        `/testcases/${id}/versions/${versionNo}/teststeps/search${qs({ startAt, maxResults, sort })}`,
        // QTM4J quirk: this endpoint wants a bare {} (or {filter:{...}} when non-empty);
        // sending {"filter":{}} returns HTTP 400 "Invalid request body".
        { method: "POST", body: JSON.stringify(filter ? { filter } : {}) }
      )
    )
);

tool(
  "qtm4j_delete_test_steps",
  {
    title: "Delete Test Steps",
    description:
      "Delete steps from a test case version. Provide either stepIds (array) or a filter, or set deleteAll=true to wipe all steps.",
    inputSchema: {
      id: ID.describe("Test case ID or key"),
      versionNo: z.number().int(),
      stepIds: z.array(z.number().int()).optional(),
      filter: StepFilter,
      deleteAll: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, versionNo, ...body }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}/teststeps`, {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    return okJSON({ message: `Steps deleted on test case ${id} v${versionNo}` });
  }
);

tool(
  "qtm4j_create_test_case_version",
  {
    title: "Create Test Case Version",
    description:
      "Branch a new version of a test case (optionally cloning from an existing version). Returns { id, key, versionNo }. Use this before making large edits so the previous version stays intact for prior cycles.",
    inputSchema: {
      id: ID.describe("Test case ID or key"),
      copyFromVersion: z
        .number()
        .int()
        .optional()
        .describe("Version to copy from. Omit to start from blank."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, copyFromVersion }) =>
    okJSON(
      await qtmFetch(`/testcases/${id}/versions`, {
        method: "POST",
        body: JSON.stringify({ copyFromVersion }),
      })
    )
);

tool(
  "qtm4j_move_test_cases",
  {
    title: "Move Test Cases to Folder",
    description:
      "Move test cases into a different folder (same project). Pass either testcaseIds or a filter. " +
      "IMPORTANT: QMetry test cases support multi-folder membership. " +
      "`selectedFolderId=-1` *adds* the case to targetFolderId without removing it from any current folder (so the case ends up in BOTH places). " +
      "To actually relocate, pass the real source folder id as selectedFolderId — that removes the case from that folder. " +
      "If a case is in multiple folders, you must run one move per source-folder to fully relocate it.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]),
      selectedFolderId: z.number().int().describe("Source folder ID (-1 for All Test Cases)"),
      targetFolderId: z.number().int().describe("Destination folder ID"),
      testcaseIds: z.array(z.string()).optional().describe("Test case UIDs from search_test_cases"),
      filter: z.record(z.string(), z.any()).optional().describe("Same filter shape as search_test_cases"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (body) => {
    await qtmFetch("/testcases/move", { method: "PUT", body: JSON.stringify(body) });
    return okJSON({ message: `Moved test cases to folder ${body.targetFolderId}` });
  }
);

tool(
  "qtm4j_bulk_update_test_cases",
  {
    title: "Bulk Update Test Cases",
    description:
      "Apply a set of field changes to many test cases at once. `fields` is the same shape as update_test_case (priority, status, assignee, labels {mode:'append'|'replace', values:[]}, components, fixVersions, customFields, isAutomated, summary, description, precondition, etc.). Provide testCaseIds or a filter. NOTE: archiving via `fields:{archived:true}` is a silent no-op in some tenants (returns 'Completed' but the flag doesn't flip) — use qtm4j_archive_test_case which hits the dedicated /archive endpoint.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]),
      fields: z.record(z.string(), z.any()).describe("Fields to apply to every selected test case"),
      testCaseIds: z.array(z.string()).optional(),
      filter: z.record(z.string(), z.any()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (body) => okJSON(await qtmFetch("/testcases/bulk", { method: "PUT", body: JSON.stringify(body) }))
);

tool(
  "qtm4j_link_test_cases_to_requirement",
  {
    title: "Link Test Cases to Requirement",
    description:
      "Associate test cases with a Jira requirement (story/issue) so traceability reports pick them up. testcases is an array of { id, versionNo }.",
    inputSchema: {
      requirementId: z.number().int().describe("Jira issue numeric ID"),
      testcases: z.array(z.object({ id: z.string(), versionNo: z.number().int() })),
      sort: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ requirementId, ...body }) =>
    okJSON(
      await qtmFetch(`/requirements/${requirementId}/testcases/link`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
);

tool(
  "qtm4j_unlink_test_cases_from_requirement",
  {
    title: "Unlink Test Cases from Requirement",
    description: "Remove the link between a Jira requirement and one or more test case versions.",
    inputSchema: {
      requirementId: z.number().int(),
      testcases: z.array(z.object({ id: z.string(), versionNo: z.number().int() })),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ requirementId, ...body }) => {
    await qtmFetch(`/requirements/${requirementId}/testcases/unlink`, {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    return okJSON({ message: `Unlinked from requirement ${requirementId}` });
  }
);

tool(
  "qtm4j_search_folders",
  {
    title: "Search Folders by Name",
    description:
      "Find folders in a module (testcase / testcycle / testplan) by name substring. Pass mode='STRICT' for exact match, omit for partial match.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]),
      module: FOLDER_MODULE,
      folderName: z.string(),
      mode: z.enum(["STRICT"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, module, folderName, mode }) =>
    okJSON(
      await qtmFetch(
        `/projects/${projectId}/${module}-folders/search${qs({ folderName, mode })}`
      )
    )
);

tool(
  "qtm4j_edit_folder",
  {
    title: "Edit Folder",
    description: "Rename a folder or update its description in any module.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]),
      module: FOLDER_MODULE,
      folderId: z.number().int(),
      folderName: z.string().optional(),
      description: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, module, folderId, folderName, description }) => {
    await qtmFetch(`/projects/${projectId}/${module}-folders/${folderId}`, {
      method: "PUT",
      body: JSON.stringify({ folderName, description }),
    });
    return okJSON({ message: `Folder ${folderId} updated` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  METADATA (read-only lookups for IDs)
// ─────────────────────────────────────────────────────────────────────────────

const ProjectId = z
  .union([z.string(), z.number()])
  .describe("Jira project numeric ID (e.g. 10000)");

const STATUS_MODULE = z
  .enum(["testcase", "testcycle", "testplan"])
  .describe("Module whose statuses to fetch");

const CF_MODULE = z
  .enum(["testcase", "testcycle", "testplan", "testcase-execution"])
  .describe("Module whose custom fields to fetch");

tool(
  "qtm4j_get_projects",
  {
    title: "Get QMetry-Enabled Projects",
    description:
      "List Jira projects with QMetry enabled. Returns id, key, name, and avatarUrl. Use returned numeric id as projectId for other tools.",
    inputSchema: {
      search: z.string().optional().describe("Filter by project key/name substring"),
      qmetryEnabled: z.boolean().optional().describe("Default true"),
      favorite: z.boolean().optional(),
      startAt: z.number().int().optional(),
      maxResults: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, ...filter }) =>
    okJSON(
      await qtmFetch(`/projects${qs({ startAt, maxResults })}`, {
        method: "POST",
        body: JSON.stringify(filter),
      })
    )
);

tool(
  "qtm4j_get_priorities",
  {
    title: "Get Priorities",
    description: "List priorities (id, name, iconUrl, isDefault, isArchive) for a project.",
    inputSchema: {
      projectId: ProjectId,
      status: z.array(z.enum(["active", "archive"])).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, status }) =>
    okJSON(
      await qtmFetch(
        `/projects/${projectId}/priorities${qs({ status: status?.join(",") })}`
      )
    )
);

tool(
  "qtm4j_get_priority_icons",
  {
    title: "Get Priority Icons",
    description: "List built-in priority icons (id, iconUrl) usable when creating priorities.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => okJSON(await qtmFetch("/priority/icons"))
);

tool(
  "qtm4j_get_statuses",
  {
    title: "Get Statuses",
    description:
      "List statuses for a module (testcase / testcycle / testplan). Returns id, name, color, isDefault, isArchive.",
    inputSchema: {
      projectId: ProjectId,
      module: STATUS_MODULE,
      status: z.array(z.enum(["active", "archive"])).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, module, status }) =>
    okJSON(
      await qtmFetch(
        `/projects/${projectId}/${module}-statuses${qs({ status: status?.join(",") })}`
      )
    )
);

tool(
  "qtm4j_get_environments",
  {
    title: "Get Environments",
    description: "List execution environments (id, name, description, isDefault) for a project.",
    inputSchema: { projectId: ProjectId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId }) => okJSON(await qtmFetch(`/projects/${projectId}/environments`))
);

tool(
  "qtm4j_get_builds",
  {
    title: "Get Builds",
    description: "List builds (id, name, description) for a project.",
    inputSchema: { projectId: ProjectId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId }) => okJSON(await qtmFetch(`/projects/${projectId}/builds`))
);

tool(
  "qtm4j_get_labels",
  {
    title: "Get Labels",
    description:
      "List labels for a project. Use paginated=true with search/sort for large projects (returns startAt/maxResults/total/data).",
    inputSchema: {
      projectId: ProjectId,
      paginated: z.boolean().optional().describe("Use the paginated /label endpoint"),
      search: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      startAt: z.number().int().optional(),
      maxResults: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, paginated, search, sort, startAt, maxResults }) => {
    const path = paginated
      ? `/projects/${projectId}/label${qs({ search, sort, startAt, maxResults })}`
      : `/projects/${projectId}/labels`;
    return okJSON(await qtmFetch(path));
  }
);

tool(
  "qtm4j_get_components",
  {
    title: "Get Components",
    description: "List components (id, name, description) for a project.",
    inputSchema: { projectId: ProjectId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId }) => okJSON(await qtmFetch(`/projects/${projectId}/components`))
);

tool(
  "qtm4j_get_execution_results",
  {
    title: "Get Execution Results",
    description: "List execution result definitions (id, name, color, isDefault) for a project.",
    inputSchema: { projectId: ProjectId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId }) => okJSON(await qtmFetch(`/projects/${projectId}/execution-results`))
);

tool(
  "qtm4j_get_custom_fields",
  {
    title: "Get Custom Fields",
    description:
      "List custom field definitions for a module. fieldType integers: 1=text, 3=radio, 4=checkbox, 5=single-dropdown, 6=multi-dropdown, 7=date, 8=datetime, 9=number, 10=user, 11=label, 12=cascade.",
    inputSchema: {
      projectId: ProjectId,
      module: CF_MODULE,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, module }) =>
    okJSON(await qtmFetch(`/projects/${projectId}/${module}-custom-fields`))
);

tool(
  "qtm4j_get_parameters",
  {
    title: "Get Parameters",
    description: "List data-grid parameters (id, name, description) for a project. Paginated.",
    inputSchema: {
      projectId: ProjectId,
      search: z.string().optional(),
      startAt: z.number().int().optional(),
      maxResults: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId, search, startAt, maxResults }) =>
    okJSON(
      await qtmFetch(
        `/projects/${projectId}/parameters${qs({ search, startAt, maxResults })}`
      )
    )
);

tool(
  "qtm4j_get_user_permissions",
  {
    title: "Get Current User Permissions",
    description:
      "Return permission flags for the current user on a project (e.g. TEST_CASE_EDIT, TEST_CYCLE_EXECUTE). Useful for pre-flight checks before mutations.",
    inputSchema: { projectId: ProjectId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ projectId }) => okJSON(await qtmFetch(`/projects/${projectId}/user-permissions`))
);

// ─────────────────────────────────────────────────────────────────────────────
//  COMMENTS — test cases (version-scoped), test cycles, test plans
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_get_test_case_comments",
  {
    title: "Get Test Case Comments",
    description:
      "List comments on a test case. Pass versionNo to read comments for a specific version (defaults to the latest version when omitted). Returns paginated { data: [{ id, comment, created, updated, isEdited }] }.",
    inputSchema: {
      id: ID.describe("Test case UID (from search) or key (e.g. PROJ-TC-123)"),
      versionNo: z.number().int().optional().describe("Test case version number (defaults to latest)"),
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, startAt, maxResults, sort }) =>
    okJSON(await qtmFetch(`/testcases/${id}/comments${qs({ versionNo, startAt, maxResults, sort })}`))
);

tool(
  "qtm4j_add_test_case_comment",
  {
    title: "Add Test Case Comment",
    description:
      "Add one or more comments to a specific version of a test case. Provide either `comment` (single string) or `comments` (array of strings). versionNo is required — use qtm4j_get_test_case (versionNo field) to find the current version.",
    inputSchema: {
      id: ID.describe("Test case UID or key"),
      versionNo: z.number().int().describe("Test case version number the comment applies to"),
      comment: z.string().optional().describe("A single comment to add"),
      comments: z.array(z.string()).optional().describe("Multiple comments to add at once"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, versionNo, comment, comments }) => {
    const payload = normalizeComments(comment, comments);
    await qtmFetch(`/testcases/${id}/versions/${versionNo}/comments`, {
      method: "POST",
      body: JSON.stringify({ comments: payload }),
    });
    return okJSON({ message: `Added ${payload.length} comment(s) to test case ${id} version ${versionNo}` });
  }
);

tool(
  "qtm4j_update_test_case_comment",
  {
    title: "Update Test Case Comment",
    description:
      "Edit an existing comment on a test case version. Use the comment id from qtm4j_get_test_case_comments.",
    inputSchema: {
      id: ID.describe("Test case UID or key"),
      versionNo: z.number().int().describe("Test case version number"),
      commentId: ID.describe("Comment id (from qtm4j_get_test_case_comments)"),
      comment: z.string().describe("New comment text"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, commentId, comment }) =>
    okJSON(
      await qtmFetch(`/testcases/${id}/versions/${versionNo}/comments/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ comment }),
      })
    )
);

tool(
  "qtm4j_delete_test_case_comment",
  {
    title: "Delete Test Case Comment",
    description: "Delete a comment from a test case version. Use the comment id from qtm4j_get_test_case_comments.",
    inputSchema: {
      id: ID.describe("Test case UID or key"),
      versionNo: z.number().int().describe("Test case version number"),
      commentId: ID.describe("Comment id to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo, commentId }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}/comments/${commentId}`, { method: "DELETE" });
    return okJSON({ message: `Comment ${commentId} deleted from test case ${id} version ${versionNo}` });
  }
);

tool(
  "qtm4j_get_test_cycle_comments",
  {
    title: "Get Test Cycle Comments",
    description: "List comments on a test cycle. Returns paginated { data: [{ id, comment, created, updated, isEdited }] }.",
    inputSchema: { id: ID.describe("Test cycle ID or key"), ...Pagination },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, startAt, maxResults, sort }) =>
    okJSON(await qtmFetch(`/testcycles/${id}/comments${qs({ startAt, maxResults, sort })}`))
);

tool(
  "qtm4j_add_test_cycle_comment",
  {
    title: "Add Test Cycle Comment",
    description:
      "Add one or more comments to a test cycle. Provide either `comment` (single string) or `comments` (array of strings).",
    inputSchema: {
      id: ID.describe("Test cycle ID or key"),
      comment: z.string().optional().describe("A single comment to add"),
      comments: z.array(z.string()).optional().describe("Multiple comments to add at once"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, comment, comments }) => {
    const payload = normalizeComments(comment, comments);
    await qtmFetch(`/testcycles/${id}/comments`, { method: "POST", body: JSON.stringify({ comments: payload }) });
    return okJSON({ message: `Added ${payload.length} comment(s) to test cycle ${id}` });
  }
);

tool(
  "qtm4j_update_test_cycle_comment",
  {
    title: "Update Test Cycle Comment",
    description: "Edit an existing comment on a test cycle. Use the comment id from qtm4j_get_test_cycle_comments.",
    inputSchema: {
      id: ID.describe("Test cycle ID or key"),
      commentId: ID.describe("Comment id (from qtm4j_get_test_cycle_comments)"),
      comment: z.string().describe("New comment text"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, commentId, comment }) =>
    okJSON(
      await qtmFetch(`/testcycles/${id}/comments/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ comment }),
      })
    )
);

tool(
  "qtm4j_delete_test_cycle_comment",
  {
    title: "Delete Test Cycle Comment",
    description: "Delete a comment from a test cycle. Use the comment id from qtm4j_get_test_cycle_comments.",
    inputSchema: {
      id: ID.describe("Test cycle ID or key"),
      commentId: ID.describe("Comment id to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, commentId }) => {
    await qtmFetch(`/testcycles/${id}/comments/${commentId}`, { method: "DELETE" });
    return okJSON({ message: `Comment ${commentId} deleted from test cycle ${id}` });
  }
);

tool(
  "qtm4j_get_test_plan_comments",
  {
    title: "Get Test Plan Comments",
    description: "List comments on a test plan. Returns paginated { data: [{ id, comment, created, updated, isEdited }] }.",
    inputSchema: { id: ID.describe("Test plan ID or key"), ...Pagination },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, startAt, maxResults, sort }) =>
    okJSON(await qtmFetch(`/testplans/${id}/comments${qs({ startAt, maxResults, sort })}`))
);

tool(
  "qtm4j_add_test_plan_comment",
  {
    title: "Add Test Plan Comment",
    description:
      "Add one or more comments to a test plan. Provide either `comment` (single string) or `comments` (array of strings).",
    inputSchema: {
      id: ID.describe("Test plan ID or key"),
      comment: z.string().optional().describe("A single comment to add"),
      comments: z.array(z.string()).optional().describe("Multiple comments to add at once"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ id, comment, comments }) => {
    const payload = normalizeComments(comment, comments);
    await qtmFetch(`/testplans/${id}/comments`, { method: "POST", body: JSON.stringify({ comments: payload }) });
    return okJSON({ message: `Added ${payload.length} comment(s) to test plan ${id}` });
  }
);

tool(
  "qtm4j_update_test_plan_comment",
  {
    title: "Update Test Plan Comment",
    description: "Edit an existing comment on a test plan. Use the comment id from qtm4j_get_test_plan_comments.",
    inputSchema: {
      id: ID.describe("Test plan ID or key"),
      commentId: ID.describe("Comment id (from qtm4j_get_test_plan_comments)"),
      comment: z.string().describe("New comment text"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, commentId, comment }) =>
    okJSON(
      await qtmFetch(`/testplans/${id}/comments/${commentId}`, {
        method: "PUT",
        body: JSON.stringify({ comment }),
      })
    )
);

tool(
  "qtm4j_delete_test_plan_comment",
  {
    title: "Delete Test Plan Comment",
    description: "Delete a comment from a test plan. Use the comment id from qtm4j_get_test_plan_comments.",
    inputSchema: {
      id: ID.describe("Test plan ID or key"),
      commentId: ID.describe("Comment id to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, commentId }) => {
    await qtmFetch(`/testplans/${id}/comments/${commentId}`, { method: "DELETE" });
    return okJSON({ message: `Comment ${commentId} deleted from test plan ${id}` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  DEFECTS — execution-level, step-level, and cycle-level
// ─────────────────────────────────────────────────────────────────────────────

const DefectFilter = z
  .record(z.string(), z.any())
  .optional()
  .describe('Optional filter object, e.g. { "status": ["To Do"], "priority": ["Medium"] }');

tool(
  "qtm4j_get_execution_defects",
  {
    title: "Get Test Case Execution Defects",
    description:
      "List Jira defects linked to a single test case execution. POST-based read: requires the internal cycle id and the testCaseExecutionId (from qtm4j_get_test_cycle_executions). Optionally pass a filter object.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID (from qtm4j_get_test_cycle_executions)"),
      level: z.string().optional().describe("Optional defect level filter (e.g. 'execution')"),
      filter: DefectFilter,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, level, filter, startAt, maxResults }) =>
    okJSON(
      await qtmFetch(
        `/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}/defects${qs({ level, startAt, maxResults })}`,
        { method: "POST", body: JSON.stringify({ filter: filter ?? {} }) }
      )
    )
);

tool(
  "qtm4j_link_execution_defects",
  {
    title: "Link Defects to Test Case Execution",
    description:
      "Link one or more existing Jira defects to a test case execution. defectIDs are the numeric Jira defect IDs (not issue keys).",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      defectIDs: z.array(ID).describe("Jira defect numeric IDs to link (e.g. [14488])"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, defectIDs }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}/defects`, {
      method: "PUT",
      body: JSON.stringify({ defectIDs }),
    });
    return okJSON({ message: `Linked ${defectIDs.length} defect(s) to execution ${testCaseExecutionId}` });
  }
);

tool(
  "qtm4j_unlink_execution_defects",
  {
    title: "Unlink Defects from Test Case Execution",
    description: "Remove the link between one or more Jira defects and a test case execution. Does not delete the defects.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      defectIDs: z.array(ID).describe("Jira defect numeric IDs to unlink"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, defectIDs }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}/defects`, {
      method: "DELETE",
      body: JSON.stringify({ defectIDs }),
    });
    return okJSON({ message: `Unlinked ${defectIDs.length} defect(s) from execution ${testCaseExecutionId}` });
  }
);

tool(
  "qtm4j_get_step_execution_defects",
  {
    title: "Get Test Step Execution Defects",
    description:
      "List Jira defects linked to a single test step execution. POST-based read: requires the cycle id and the testStepExecutionId.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testStepExecutionId: ID.describe("Test step execution ID"),
      filter: DefectFilter,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testStepExecutionId, filter, startAt, maxResults }) =>
    okJSON(
      await qtmFetch(
        `/testcycles/${cycleId}/teststep-executions/${testStepExecutionId}/defects${qs({ startAt, maxResults })}`,
        // Step-level defect reads take a bare `{}` body when unfiltered (per the API
        // blueprint example), unlike the execution/cycle reads which wrap in `{ filter }`.
        { method: "POST", body: JSON.stringify(filter ? { filter } : {}) }
      )
    )
);

tool(
  "qtm4j_link_step_execution_defects",
  {
    title: "Link Defects to Test Step Execution",
    description: "Link one or more existing Jira defects to a test step execution. defectIDs are the numeric Jira defect IDs.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testStepExecutionId: ID.describe("Test step execution ID"),
      defectIDs: z.array(ID).describe("Jira defect numeric IDs to link"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testStepExecutionId, defectIDs }) => {
    await qtmFetch(`/testcycles/${cycleId}/teststep-executions/${testStepExecutionId}/defects`, {
      method: "PUT",
      body: JSON.stringify({ defectIDs }),
    });
    return okJSON({ message: `Linked ${defectIDs.length} defect(s) to step execution ${testStepExecutionId}` });
  }
);

tool(
  "qtm4j_unlink_step_execution_defects",
  {
    title: "Unlink Defects from Test Step Execution",
    description: "Remove the link between one or more Jira defects and a test step execution.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testStepExecutionId: ID.describe("Test step execution ID"),
      defectIDs: z.array(ID).describe("Jira defect numeric IDs to unlink"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testStepExecutionId, defectIDs }) => {
    await qtmFetch(`/testcycles/${cycleId}/teststep-executions/${testStepExecutionId}/defects`, {
      method: "DELETE",
      body: JSON.stringify({ defectIDs }),
    });
    return okJSON({ message: `Unlinked ${defectIDs.length} defect(s) from step execution ${testStepExecutionId}` });
  }
);

tool(
  "qtm4j_search_cycle_defects",
  {
    title: "Search Test Cycle Defects",
    description:
      "Search all Jira defects linked across a test cycle's executions. POST-based read with an optional filter object (searchText, status, priority, testCaseKey, environment, etc.) and pagination.",
    inputSchema: {
      id: ID.describe("Test cycle ID"),
      filter: DefectFilter,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, filter, startAt, maxResults, fields, sort }) =>
    okJSON(
      await qtmFetch(`/testcycles/${id}/defects/search${qs({ startAt, maxResults, fields, sort })}`, {
        method: "POST",
        body: JSON.stringify({ filter: filter ?? {} }),
      })
    )
);

tool(
  "qtm4j_get_cycle_defect_summary",
  {
    title: "Get Test Cycle Defect Summary",
    description:
      "Get an aggregated summary of defects for a test cycle. POST-based read with an optional filter object (e.g. { environment: 'Chrome' }).",
    inputSchema: {
      id: ID.describe("Test cycle ID"),
      filter: DefectFilter,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, filter }) =>
    okJSON(
      await qtmFetch(`/testcycles/${id}/defects/summary`, {
        method: "POST",
        body: JSON.stringify({ filter: filter ?? {} }),
      })
    )
);

// ─────────────────────────────────────────────────────────────────────────────
//  EXECUTION DETAIL — step executions and execution custom fields
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_get_execution_teststeps",
  {
    title: "Get Test Case Execution Steps",
    description:
      "List the per-step execution records for a single test case execution (step result, actual result, defects). Requires the cycle id and the testCaseExecutionId from qtm4j_get_test_cycle_executions.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, startAt, maxResults }) =>
    okJSON(
      await qtmFetch(
        `/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}/teststeps${qs({ startAt, maxResults })}`
      )
    )
);

tool(
  "qtm4j_update_execution_custom_fields",
  {
    title: "Update Test Case Execution Custom Fields",
    description:
      "Set custom field values on a test case execution. customFields use string IDs (e.g. 'qcf_1337') with value and optional cascadeValue. Requires the cycle id and testCaseExecutionId.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      customFields: z.array(CustomField).describe("Custom field values to set"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, customFields }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}/custom-fields`, {
      method: "PUT",
      body: JSON.stringify({ customFields }),
    });
    return okJSON({ message: `Updated ${customFields.length} custom field(s) on execution ${testCaseExecutionId}` });
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

if (process.argv.includes("--check")) {
  try {
    const res = await fetch(`${BASE_URL}/testcases/search?maxResults=1`, {
      method: "POST",
      headers: {
        apiKey: API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ filter: {} }),
    });
    if (res.status === 401 || res.status === 403) {
      process.stderr.write(
        `FAIL: API key rejected by ${BASE_URL} (HTTP ${res.status}). Check QTM4J_API_KEY.\n`
      );
      process.exit(1);
    }
    process.stderr.write(
      `OK: reached ${BASE_URL} (HTTP ${res.status}) — region ${REGION}, key authenticated.\n`
    );
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `FAIL: could not reach ${BASE_URL} — ${msg}. Check network and QTM4J_REGION.\n`
    );
    process.exit(1);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `qtm4j-mcp-server running — region: ${REGION}, base URL: ${BASE_URL}\n`
);
