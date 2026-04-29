#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
        text = `Not found (404): The resource doesn't exist. Verify the ID/key, and remember internal IDs and keys (e.g. FS-TR-747) are different — search endpoints often need the internal id from a prior search response.`;
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

/** Build a query string from a plain object, omitting undefined values. */
function qs(params: Record<string, string | number | undefined>): string {
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
    body: JSON.stringify({ filter: { projectId, folderId, ...filters } }),
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
  query: z.string().optional().describe("Free-text search query"),
};

const ID = z.union([z.string(), z.number()]);
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
      "Create a new test case in QMetry. Returns the created test case object including its internal id and key (e.g. FS-TC-123). Priority, status, labels, and components use integer IDs.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      summary: z.string().describe("Test case title/summary"),
      precondition: z.string().optional().describe("Precondition / description text"),
      priority: z.number().int().optional().describe("Priority integer ID (e.g. 600784 for High)"),
      status: z.number().int().optional().describe("Status integer ID (e.g. 544256 for Done)"),
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
      "Get a test case by its internal ID or key (e.g. FS-TC-31950). Returns an array of versions with versionNo, isLatestVersion, aiGenerated flag, and any test steps.",
    inputSchema: {
      id: ID.describe("Test case ID or key (e.g. QTP-TC-1)"),
      response_format: ResponseFormat,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => okJSON(await qtmFetch(`/testcases/${id}`))
);

tool(
  "qtm4j_search_test_cases",
  {
    title: "Search Test Cases",
    description:
      "Search test cases in a project with optional filters. Returns total count and paginated data. Use status/priority name strings (e.g. 'To Do', 'High'). projectId must be numeric (e.g. 10011). Set recursive=true with folderId to count across all subfolders (returns total only, no data).",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
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
      body: JSON.stringify({ filter: { projectId, folderId, ...filters } }),
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
  "qtm4j_delete_test_case",
  {
    title: "Delete Test Case Version",
    description:
      "Permanently delete a specific version of a test case. If it is the only version, the test case is removed entirely. Irreversible.",
    inputSchema: {
      id: ID.describe("Test case ID"),
      versionNo: z.number().int().describe("Version number to delete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id, versionNo }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}`, { method: "DELETE" });
    return okJSON({ message: `Test case ${id} version ${versionNo} deleted` });
  }
);

tool(
  "qtm4j_clone_test_cases",
  {
    title: "Clone Test Cases",
    description:
      "Bulk clone one or more test cases into a target project and optional folder. Returns a background task object with taskId and progressUrl to poll.",
    inputSchema: {
      testcaseIds: z.array(z.number().int()).describe("Test case IDs to clone"),
      projectId: z.string().describe("Target project ID or key"),
      folderId: z.number().int().optional().describe("Target folder ID"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (input) => okJSON(await qtmFetch("/testcases/clone", { method: "POST", body: JSON.stringify(input) }))
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
      "Create a new test cycle. Returns the created cycle with its internal id and key (e.g. FS-TR-123). Use qtm4j_list_folders with folderType=TESTCYCLE to find valid folderId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      summary: z.string().describe("Test cycle name/summary"),
      description: z.string().optional(),
      priority: z.string().optional(),
      status: z.string().optional(),
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
      "Get a test cycle by its key (e.g. FS-TR-747) or internal id. The internal 'id' returned here is required by qtm4j_get_test_cycle_executions and qtm4j_update_test_execution.",
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
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      response_format: ResponseFormat,
      ...SearchFilters,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, sort, fields, projectId, response_format, ...filters }) => {
    const data = await qtmFetch(`/testcycles/search${qs({ startAt, maxResults, sort, fields })}`, {
      method: "POST",
      body: JSON.stringify({ filter: { projectId, ...filters } }),
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
      priority: z.string().optional(),
      status: z.string().optional(),
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
    description: "Permanently delete a test cycle and all its execution records. Irreversible.",
    inputSchema: { id: ID.describe("Test cycle ID") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testcycles/${id}`, { method: "DELETE" });
    return okJSON({ message: `Test cycle ${id} deleted` });
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
  "qtm4j_update_test_execution",
  {
    title: "Update Test Execution",
    description:
      "Update a single test case execution result inside a test cycle. Use testCaseExecutionId from qtm4j_get_test_cycle_executions. executionResultId: 239443=Not Executed, 239444=Pass, 239441=Fail, 239442=Work In Progress, 239440=Blocked.",
    inputSchema: {
      cycleId: ID.describe("Test cycle ID"),
      testCaseExecutionId: ID.describe("Test case execution ID"),
      executionResultId: z.number().int().optional().describe("Execution result/status ID"),
      environmentId: z.number().int().optional().describe("Environment ID"),
      buildId: z.number().int().optional().describe("Build ID"),
      comment: z.string().optional().describe("Execution comment"),
      actualTime: z.number().int().optional().describe("Actual time spent in milliseconds"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ cycleId, testCaseExecutionId, ...rest }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    return okJSON({ message: `Execution ${testCaseExecutionId} updated` });
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
      executionResultId: z.number().int().optional().describe("Execution result ID to apply to all"),
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

// ─────────────────────────────────────────────────────────────────────────────
//  TEST PLANS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "qtm4j_create_test_plan",
  {
    title: "Create Test Plan",
    description:
      "Create a new test plan. Returns the created plan with internal id and key (e.g. FS-TP-44). Use qtm4j_list_folders with folderType=TESTPLAN to find valid folderId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      summary: z.string().describe("Test plan name/summary"),
      description: z.string().optional(),
      priority: z.string().optional(),
      status: z.string().optional(),
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
      "Get a test plan by its key (e.g. FS-TP-43) or internal id. Use the internal 'id' for link/unlink/get_linked_test_cycles operations.",
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
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      response_format: ResponseFormat,
      ...SearchFilters,
      ...Pagination,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ startAt, maxResults, sort, fields, projectId, response_format, ...filters }) => {
    const data = await qtmFetch(`/testplans/search${qs({ startAt, maxResults, sort, fields })}`, {
      method: "POST",
      body: JSON.stringify({ filter: { projectId, ...filters } }),
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
      priority: z.string().optional(),
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
    description: "Permanently delete a test plan. Does not delete the linked test cycles.",
    inputSchema: { id: ID.describe("Test plan ID") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}`, { method: "DELETE" });
    return okJSON({ message: `Test plan ${id} deleted` });
  }
);

tool(
  "qtm4j_link_test_cycles_to_plan",
  {
    title: "Link Test Cycles to Plan",
    description:
      "Link existing test cycles to a test plan. Use the plan's internal id. testcycleIds are numeric integer IDs.",
    inputSchema: {
      id: ID.describe("Test plan ID"),
      testcycleIds: z.array(z.number().int()).describe("Test cycle IDs to link"),
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
      testcycleIds: z.array(z.number().int()).describe("Test cycle IDs to unlink"),
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
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
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
      "Create a new folder under an existing parent folder. Use parentId=0 for root-level. Use qtm4j_list_folders first to find valid parentId values.",
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
      folderName: z.string().describe("Folder name"),
      folderType: z.enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"]).describe("Folder type"),
      parentId: z.number().int().describe("Parent folder ID (use 0 for root)"),
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
      projectId: z.number().int().describe("Jira project numeric ID (e.g. 10011)"),
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

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `qtm4j-mcp-server running — region: ${REGION}, base URL: ${BASE_URL}\n`
);
