#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.QTM4J_API_KEY;
const REGION = (process.env.QTM4J_REGION ?? "US").toUpperCase();

const BASE_URLS: Record<string, string> = {
  US: "https://qtmcloud.qmetry.com/rest/api/latest",
  AU: "https://qtmcloud-au.qmetry.com/rest/api/latest",
};

const BASE_URL = BASE_URLS[REGION] ?? BASE_URLS["US"];

if (!API_KEY) {
  process.stderr.write("Warning: QTM4J_API_KEY environment variable is not set\n");
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(body)}`
    );
  }

  return body;
}

/** Wrap a successful API response as MCP tool content. */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
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

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const CustomField = z.object({
  id: z.string().describe("Custom field ID, e.g. qcf_1"),
  value: z.string().optional().describe("Field value"),
  cascadeValue: z.string().optional().describe("Cascade dropdown value"),
});

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
  status: z.array(z.string()).optional().describe("Filter by status values"),
  priority: z.array(z.string()).optional().describe("Filter by priority values"),
  assignee: z.array(z.string()).optional().describe("Filter by assignee Jira account IDs"),
  query: z.string().optional().describe("Free-text search query"),
};

const ID = z.union([z.string(), z.number()]);

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "qtm4j-mcp", version: "1.0.0" });

/** Thin wrapper around registerTool for concise, non-deprecated tool registration. */
const tool = <Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callback: (args: z.infer<z.ZodObject<Shape>>) => Promise<any>
) =>
  server.registerTool(
    name,
    { description, inputSchema },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback as any
  );

// ─────────────────────────────────────────────────────────────────────────────
//  TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "create_test_case",
  "Create a new test case in QMetry. Returns the created test case ID and key.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    summary: z.string().describe("Test case title/summary"),
    description: z.string().optional().describe("Description (HTML supported)"),
    priority: z.string().optional().describe("Priority e.g. High, Medium, Low"),
    status: z.string().optional().describe("Initial status"),
    assignee: z.string().optional().describe("Assignee Jira account ID"),
    labels: z.array(z.string()).optional().describe("Labels to attach"),
    components: z.array(z.string()).optional().describe("Component names"),
    fixVersions: z.array(z.string()).optional().describe("Fix version names"),
    folderId: z.number().int().optional().describe("Target folder ID"),
    customFields: z.array(CustomField).optional().describe("Custom field values"),
  },
  async (input) => ok(await qtmFetch("/testcases", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "get_test_case",
  "Get a test case by its ID or key, including all versions and step details.",
  { id: ID.describe("Test case ID or key (e.g. QTP-TC-1)") },
  async ({ id }) => ok(await qtmFetch(`/testcases/${id}`))
);

tool(
  "search_test_cases",
  "Search/list test cases in a project with optional filters and pagination.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    labels: z.array(z.string()).optional().describe("Filter by labels"),
    components: z.array(z.string()).optional().describe("Filter by components"),
    ...SearchFilters,
    ...Pagination,
  },
  async ({ startAt, maxResults, sort, fields, projectId, ...filters }) =>
    ok(
      await qtmFetch(`/testcases/search${qs({ startAt, maxResults, sort, fields })}`, {
        method: "POST",
        body: JSON.stringify({ filter: { projectId, ...filters } }),
      })
    )
);

tool(
  "update_test_case",
  "Update a specific version of a test case (summary, description, priority, status, custom fields, etc.).",
  {
    id: ID.describe("Test case ID"),
    versionNo: z.number().int().describe("Version number to update"),
    summary: z.string().optional(),
    description: z.string().optional(),
    priority: z.string().optional(),
    status: z.string().optional(),
    assignee: z.string().optional().describe("Assignee Jira account ID"),
    labels: z.array(z.string()).optional(),
    components: z.array(z.string()).optional(),
    fixVersions: z.array(z.string()).optional(),
    customFields: z.array(CustomField).optional(),
  },
  async ({ id, versionNo, ...rest }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    return ok({ message: `Test case ${id} version ${versionNo} updated` });
  }
);

tool(
  "delete_test_case",
  "Delete a specific version of a test case.",
  {
    id: ID.describe("Test case ID"),
    versionNo: z.number().int().describe("Version number to delete"),
  },
  async ({ id, versionNo }) => {
    await qtmFetch(`/testcases/${id}/versions/${versionNo}`, { method: "DELETE" });
    return ok({ message: `Test case ${id} version ${versionNo} deleted` });
  }
);

tool(
  "clone_test_cases",
  "Clone one or more test cases to a target project/folder. Returns a background task ID with a progress URL.",
  {
    testcaseIds: z.array(z.number().int()).describe("Test case IDs to clone"),
    projectId: z.string().describe("Target project ID or key"),
    folderId: z.number().int().optional().describe("Target folder ID"),
  },
  async (input) =>
    ok(await qtmFetch("/testcases/clone", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "create_test_steps",
  "Add one or more test steps to a specific version of a test case.",
  {
    id: ID.describe("Test case ID"),
    versionNo: z.number().int().describe("Test case version number"),
    steps: z
      .array(
        z.object({
          stepDetails: z.string().describe("Step action/description"),
          expectedResult: z.string().optional(),
          testData: z.string().optional(),
        })
      )
      .describe("Steps to create"),
  },
  async ({ id, versionNo, steps }) =>
    ok(
      await qtmFetch(`/testcases/${id}/versions/${versionNo}/teststeps`, {
        method: "POST",
        body: JSON.stringify(steps),
      })
    )
);

tool(
  "update_test_steps",
  "Update existing test steps for a specific version of a test case.",
  {
    id: ID.describe("Test case ID"),
    versionNo: z.number().int().describe("Test case version number"),
    steps: z
      .array(
        z.object({
          id: z.number().int().describe("Step ID to update"),
          stepDetails: z.string().optional(),
          expectedResult: z.string().optional(),
          testData: z.string().optional(),
        })
      )
      .describe("Steps to update"),
  },
  async ({ id, versionNo, steps }) =>
    ok(
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
  "create_test_cycle",
  "Create a new test cycle in QMetry. Returns the created test cycle details.",
  {
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
  async (input) =>
    ok(await qtmFetch("/testcycles", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "get_test_cycle",
  "Get a test cycle by its ID or key, including execution summary.",
  { id: ID.describe("Test cycle ID or key") },
  async ({ id }) => ok(await qtmFetch(`/testcycles/${id}`))
);

tool(
  "search_test_cycles",
  "Search/list test cycles in a project with optional filters and pagination.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    ...SearchFilters,
    ...Pagination,
  },
  async ({ startAt, maxResults, sort, fields, projectId, ...filters }) =>
    ok(
      await qtmFetch(`/testcycles/search${qs({ startAt, maxResults, sort, fields })}`, {
        method: "POST",
        body: JSON.stringify({ filter: { projectId, ...filters } }),
      })
    )
);

tool(
  "update_test_cycle",
  "Update a test cycle's summary, description, priority, status, or custom fields.",
  {
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
  async ({ id, ...rest }) => {
    await qtmFetch(`/testcycles/${id}`, { method: "PUT", body: JSON.stringify(rest) });
    return ok({ message: `Test cycle ${id} updated` });
  }
);

tool(
  "delete_test_cycle",
  "Delete a test cycle by ID.",
  { id: ID.describe("Test cycle ID") },
  async ({ id }) => {
    await qtmFetch(`/testcycles/${id}`, { method: "DELETE" });
    return ok({ message: `Test cycle ${id} deleted` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  TEST EXECUTIONS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "get_test_cycle_executions",
  "List all test case executions (linked test cases and their run status) within a test cycle.",
  {
    id: ID.describe("Test cycle ID (internal ID from search_test_cycles)"),
    ...Pagination,
  },
  async ({ id, startAt, maxResults, sort, fields }) =>
    ok(
      await qtmFetch(`/testcycles/${id}/testcases/search${qs({ startAt, maxResults, sort, fields })}`, {
        method: "POST",
        body: JSON.stringify({ filter: {} }),
      })
    )
);

tool(
  "update_test_execution",
  "Update the execution result, environment, build, or comment for a single test case execution inside a test cycle.",
  {
    cycleId: ID.describe("Test cycle ID"),
    testCaseExecutionId: ID.describe("Test case execution ID"),
    executionResultId: z.number().int().optional().describe("Execution result/status ID"),
    environmentId: z.number().int().optional().describe("Environment ID"),
    buildId: z.number().int().optional().describe("Build ID"),
    comment: z.string().optional().describe("Execution comment"),
    actualTime: z.number().int().optional().describe("Actual time spent in milliseconds"),
  },
  async ({ cycleId, testCaseExecutionId, ...rest }) => {
    await qtmFetch(
      `/testcycles/${cycleId}/testcase-executions/${testCaseExecutionId}`,
      { method: "PUT", body: JSON.stringify(rest) }
    );
    return ok({ message: `Execution ${testCaseExecutionId} updated` });
  }
);

tool(
  "update_test_step_execution",
  "Update the result, actual result, or comment for a single test step execution.",
  {
    cycleId: ID.describe("Test cycle ID"),
    testStepExecutionId: ID.describe("Test step execution ID"),
    executionResultId: z.number().int().optional().describe("Execution result ID"),
    actualResult: z.string().optional().describe("Actual result text"),
    comment: z.string().optional(),
  },
  async ({ cycleId, testStepExecutionId, ...rest }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/teststep-executions/${testStepExecutionId}`,
      { method: "PUT", body: JSON.stringify(rest) }
    );
    return ok(data ?? { message: `Step execution ${testStepExecutionId} updated` });
  }
);

tool(
  "bulk_update_test_executions",
  "Bulk-update execution result, environment, or build for multiple test case executions in a test cycle.",
  {
    cycleId: ID.describe("Test cycle ID"),
    testCycleTestCaseMapIds: z
      .array(z.number().int())
      .describe("Test-case-execution map IDs to update"),
    executionResultId: z.number().int().optional().describe("Execution result ID to apply to all"),
    environmentId: z.number().int().optional().describe("Environment ID to apply to all"),
    buildId: z.number().int().optional().describe("Build ID to apply to all"),
  },
  async ({ cycleId, ...rest }) => {
    await qtmFetch(`/testcycles/${cycleId}/testcases/bulk`, {
      method: "PUT",
      body: JSON.stringify(rest),
    });
    return ok({ message: "Bulk execution update applied" });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  TEST PLANS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "create_test_plan",
  "Create a new test plan in QMetry. Returns the created test plan ID and key.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    summary: z.string().describe("Test plan name/summary"),
    description: z.string().optional(),
    priority: z.string().optional(),
    status: z.string().optional(),
    assignee: z.string().optional().describe("Assignee Jira account ID"),
    folderId: z.number().int().optional().describe("Target folder ID"),
    customFields: z.array(CustomField).optional(),
  },
  async (input) =>
    ok(await qtmFetch("/testplans", { method: "POST", body: JSON.stringify(input) }))
);

tool(
  "get_test_plan",
  "Get a test plan by its ID or key.",
  { id: ID.describe("Test plan ID or key") },
  async ({ id }) => ok(await qtmFetch(`/testplans/${id}`))
);

tool(
  "search_test_plans",
  "Search/list test plans in a project with optional filters and pagination.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    ...SearchFilters,
    ...Pagination,
  },
  async ({ startAt, maxResults, sort, fields, projectId, ...filters }) =>
    ok(
      await qtmFetch(`/testplans/search${qs({ startAt, maxResults, sort, fields })}`, {
        method: "POST",
        body: JSON.stringify({ filter: { projectId, ...filters } }),
      })
    )
);

tool(
  "update_test_plan",
  "Update a test plan's priority or custom fields.",
  {
    id: ID.describe("Test plan ID"),
    priority: z.string().optional(),
    customFields: z.array(CustomField).optional(),
  },
  async ({ id, ...rest }) => {
    await qtmFetch(`/testplans/${id}`, { method: "PUT", body: JSON.stringify(rest) });
    return ok({ message: `Test plan ${id} updated` });
  }
);

tool(
  "delete_test_plan",
  "Delete a test plan by ID.",
  { id: ID.describe("Test plan ID") },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}`, { method: "DELETE" });
    return ok({ message: `Test plan ${id} deleted` });
  }
);

tool(
  "link_test_cycles_to_plan",
  "Link one or more test cycles to a test plan.",
  {
    id: ID.describe("Test plan ID"),
    testcycleIds: z.array(z.number().int()).describe("Test cycle IDs to link"),
  },
  async ({ id, testcycleIds }) => {
    await qtmFetch(`/testplans/${id}/testcycles`, {
      method: "PUT",
      body: JSON.stringify({ testcycleIds }),
    });
    return ok({ message: `Test cycles linked to plan ${id}` });
  }
);

tool(
  "get_linked_test_cycles",
  "Get all test cycles linked to a test plan, with pagination.",
  {
    id: ID.describe("Test plan ID"),
    ...Pagination,
  },
  async ({ id, startAt, maxResults, sort, fields }) =>
    ok(await qtmFetch(`/testplans/${id}/testcycles${qs({ startAt, maxResults, sort, fields })}`))
);

tool(
  "unlink_test_cycles_from_plan",
  "Unlink one or more test cycles from a test plan.",
  {
    id: ID.describe("Test plan ID"),
    testcycleIds: z.array(z.number().int()).describe("Test cycle IDs to unlink"),
  },
  async ({ id, testcycleIds }) => {
    await qtmFetch(`/testplans/${id}/testcycles`, {
      method: "DELETE",
      body: JSON.stringify({ testcycleIds }),
    });
    return ok({ message: `Test cycles unlinked from plan ${id}` });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  FOLDERS
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "list_folders",
  "List all folders of a given type (TESTCASE, TESTCYCLE, TESTPLAN) in a project.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    folderType: z
      .enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"])
      .describe("Folder type to list"),
  },
  async ({ projectId, folderType }) =>
    ok(await qtmFetch(`/folders${qs({ projectId, folderType })}`))
);

tool(
  "create_folder",
  "Create a new folder in a project for test cases, cycles, or plans.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    name: z.string().describe("Folder name"),
    folderType: z.enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"]).describe("Folder type"),
    parentFolderId: z.number().int().optional().describe("Parent folder ID (omit for root)"),
  },
  async (input) =>
    ok(await qtmFetch("/folders", { method: "POST", body: JSON.stringify(input) }))
);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTOMATION
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "link_automation_rule",
  "Link an automation rule to a test cycle.",
  {
    cycleId: ID.describe("Test cycle ID"),
    automationRuleKey: z.string().describe("Automation rule key to link"),
  },
  async ({ cycleId, automationRuleKey }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/automation-rule/link/${automationRuleKey}`,
      { method: "PUT", body: JSON.stringify({}) }
    );
    return ok(data ?? { message: "Automation rule linked" });
  }
);

tool(
  "unlink_automation_rule",
  "Unlink an automation rule from a test cycle.",
  {
    cycleId: ID.describe("Test cycle ID"),
    automationRuleKey: z.string().describe("Automation rule key to unlink"),
  },
  async ({ cycleId, automationRuleKey }) => {
    const data = await qtmFetch(
      `/testcycles/${cycleId}/automation-rule/unlink/${automationRuleKey}`,
      { method: "PUT", body: JSON.stringify({}) }
    );
    return ok(data ?? { message: "Automation rule unlinked" });
  }
);

tool(
  "run_automation_rules",
  "Trigger an automation rule run for a project. Returns a background task ID with a progress URL.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    automationRuleKey: z.string().describe("Automation rule key to run"),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional filter criteria for the run"),
  },
  async (input) =>
    ok(await qtmFetch("/automation-rules/run", { method: "POST", body: JSON.stringify(input) }))
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `QTM4J MCP server running — region: ${REGION}, base URL: ${BASE_URL}\n`
);
