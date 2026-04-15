#!/usr/bin/env node
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
  "Create a new test case in QMetry. Returns the created test case object including its internal id and key (e.g. FS-TC-123). Priority, status, labels, and components use integer IDs — see field_reference.json for valid values.",
  {
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
  async (body) => {
    return ok(await qtmFetch("/testcases", { method: "POST", body: JSON.stringify(body) }));
  }
);

tool(
  "get_test_case",
  "Get a test case by its internal ID or key (e.g. FS-TC-31950). Returns an array of versions, each with versionNo, isLatestVersion, aiGenerated flag, and any test steps.",
  { id: ID.describe("Test case ID or key (e.g. QTP-TC-1)") },
  async ({ id }) => ok(await qtmFetch(`/testcases/${id}`))
);

tool(
  "search_test_cases",
  "Search test cases in a project with optional filters. Returns total count and paginated data with id, key, version info, archived flag. Use status/priority name strings (e.g. 'To Do', 'High') not IDs. projectId must be numeric (10011).",
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
  "Update fields on a specific version of a test case. Requires both the test case id and versionNo (usually 1 for latest). Priority and status take integer IDs. Returns 204 on success.",
  {
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
  "Permanently delete a specific version of a test case. If it is the only version, the test case is removed entirely. Returns 204 on success.",
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
  "Bulk clone one or more test cases into a target project and optional folder. Returns a background task object with a taskId and progressUrl to poll for completion.",
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
  "Add one or more test steps to a specific version of a test case. Each step has stepDetails (required), expectedResult, and testData. Returns the created step objects with their IDs.",
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
  "Update existing test steps on a test case version. Each step must include its step id (from create_test_steps or get_test_case response). Returns the updated step objects.",
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
  "Create a new test cycle in QMetry. Returns the created cycle with its internal id and key (e.g. FS-TR-123). Use list_folders with folderType=TESTCYCLE to find valid folderId values.",
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
  "Get a test cycle by its key (e.g. FS-TR-747) or internal id. Returns id, key, status, priority, projectId, archived flag. The internal 'id' returned here is required by get_test_cycle_executions and update_test_execution.",
  { id: ID.describe("Test cycle ID or key") },
  async ({ id }) => ok(await qtmFetch(`/testcycles/${id}`))
);

tool(
  "search_test_cycles",
  "Search test cycles in a project. Returns total count and paginated list with id, key, status, priority, archived. The 'id' field in results is the internal ID needed for execution tools.",
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
  "Update a test cycle's metadata (summary, description, priority, status, dates, custom fields). Pass the internal id or key. Returns 204 on success.",
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
  "Permanently delete a test cycle and all its execution records. This is irreversible. Returns 204 on success.",
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
  "List all test case executions linked to a test cycle. Requires the internal cycle id (from get_test_cycle, not the key). Returns testCycleTestCaseMapId (needed for bulk_update), testCaseExecutionId (needed for update_test_execution), key, status, and priority per test case.",
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
  "Update a single test case execution result inside a test cycle. Use testCaseExecutionId from get_test_cycle_executions. executionResultId: 239443=Not Executed, 239444=Pass, 239441=Fail, 239442=Work In Progress, 239440=Blocked. Returns 204 on success.",
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
  "Update a single step-level execution result within a test case execution. testStepExecutionId comes from get_test_cycle_executions step data. Returns 200 with updated step data.",
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
  "Apply the same execution result, environment, or build to multiple test case executions at once. Use testCycleTestCaseMapIds from get_test_cycle_executions (the 'testCycleTestCaseMapId' field). Returns 204 on success.",
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
  "Create a new test plan in QMetry. Returns the created plan with its internal id and key (e.g. FS-TP-44). Use list_folders with folderType=TESTPLAN to find valid folderId values.",
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
  "Get a test plan by its key (e.g. FS-TP-43) or internal id. Returns id, key, projectId, archived flag. Use the internal 'id' when calling link/unlink/get_linked_test_cycles.",
  { id: ID.describe("Test plan ID or key") },
  async ({ id }) => ok(await qtmFetch(`/testplans/${id}`))
);

tool(
  "search_test_plans",
  "Search test plans in a project. Returns total count and paginated list with id, key, projectId, archived. The 'id' field is the internal ID needed for linking cycles.",
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
  "Update a test plan's priority or custom fields. Returns 204 on success.",
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
  "Permanently delete a test plan. This does not delete the linked test cycles. Returns 204 on success.",
  { id: ID.describe("Test plan ID") },
  async ({ id }) => {
    await qtmFetch(`/testplans/${id}`, { method: "DELETE" });
    return ok({ message: `Test plan ${id} deleted` });
  }
);

tool(
  "link_test_cycles_to_plan",
  "Link one or more existing test cycles to a test plan. Use the plan's internal id (from get_test_plan or search_test_plans). testcycleIds are numeric integer IDs. Returns 204 on success.",
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
  "List all test cycles currently linked to a test plan. Returns paginated list with id, key, status, priority per cycle. Use the plan's internal id (not key).",
  {
    id: ID.describe("Test plan ID"),
    ...Pagination,
  },
  async ({ id, startAt, maxResults, sort, fields }) =>
    ok(
      await qtmFetch(`/testplans/${id}/testcycles${qs({ startAt, maxResults, sort, fields })}`, {
        method: "POST",
        body: JSON.stringify({ filter: {} }),
      })
    )
);

tool(
  "unlink_test_cycles_from_plan",
  "Remove the link between one or more test cycles and a test plan. Does not delete the cycles themselves. Returns 204 on success.",
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
  "List all folders of a given type in a project, returned as a nested tree with id, name, parentId, and children. Use the folder id values as folderId when creating or filtering test cases, cycles, or plans.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    folderType: z
      .enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"])
      .describe("Folder type to list"),
  },
  async ({ projectId, folderType }) => {
    const typeSegment =
      folderType === "TESTCASE" ? "testcase-folders"
      : folderType === "TESTCYCLE" ? "testcycle-folders"
      : "testplan-folders";
    return ok(await qtmFetch(`/projects/${projectId}/${typeSegment}`));
  }
);

tool(
  "create_folder",
  "Create a new folder under an existing parent folder. Use parentId=0 for root-level. folderName is required. Returns the created folder with its id. Use list_folders first to find valid parentId values.",
  {
    projectId: z.union([z.string(), z.number()]).describe("Jira project numeric ID (e.g. 10011)"),
    folderName: z.string().describe("Folder name"),
    folderType: z.enum(["TESTCASE", "TESTCYCLE", "TESTPLAN"]).describe("Folder type"),
    parentId: z.number().int().describe("Parent folder ID (use 0 for root)"),
    description: z.string().optional().describe("Folder description"),
  },
  async ({ projectId, folderType, folderName, parentId, description }) => {
    const typeSegment =
      folderType === "TESTCASE" ? "testcase-folders"
      : folderType === "TESTCYCLE" ? "testcycle-folders"
      : "testplan-folders";
    return ok(
      await qtmFetch(`/projects/${projectId}/${typeSegment}`, {
        method: "POST",
        body: JSON.stringify({ folderName, parentId, description }),
      })
    );
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  AUTOMATION
// ─────────────────────────────────────────────────────────────────────────────

tool(
  "link_automation_rule",
  "Associate an automation rule with a test cycle so it can be triggered for that cycle. automationRuleKey is the rule's string key from your QMetry automation config. Returns 200 on success.",
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
  "Remove the association between an automation rule and a test cycle. Returns 200 on success.",
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
  "Trigger an automation rule to run against a specific test cycle. testCycleId is the internal id string (from get_test_cycle). Returns a background task object with taskId and progressUrl to poll for completion.",
  {
    automationRuleKey: z.string().describe("Automation rule key to run"),
    projectId: z.number().int().describe("Jira project numeric ID (e.g. 10011)"),
    testCycleId: z.string().describe("Internal test cycle ID (from search_test_cycles)"),
  },
  async ({ automationRuleKey, projectId, testCycleId }) =>
    ok(
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
  `QTM4J MCP server running — region: ${REGION}, base URL: ${BASE_URL}\n`
);
