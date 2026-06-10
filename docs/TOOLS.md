# QTM4J MCP — Tool Reference

87 tools, grouped by purpose. All tools are namespaced `qtm4j_*` and are listed by the bare name here.

Conventions:
- `projectId` = numeric Jira project ID (e.g. `10000`)
- `id` accepts either internal ID or key (`PROJ-TC-123`) on `get_*` endpoints
- Search/execution endpoints require the internal `id` from a prior search response
- 204 responses are wrapped as `{ message: "…" }`

## Metadata & discovery (read-only)

Use these once at the start of a session to learn the IDs the project exposes.

| Tool | Returns |
|---|---|
| `get_projects` | List of QMetry-enabled projects with numeric `id` |
| `get_priorities` | Priority IDs/names for a project |
| `get_priority_icons` | Built-in priority icons |
| `get_statuses` | Statuses for a module — `testcase` / `testcycle` / `testplan` |
| `get_environments` | Execution environment IDs |
| `get_builds` | Build IDs |
| `get_labels` | Label IDs (paginated mode available) |
| `get_components` | Component IDs |
| `get_execution_results` | Execution result IDs (Pass/Fail/etc.) |
| `get_custom_fields` | Custom field defs for a module — `testcase` / `testcycle` / `testplan` / `testcase-execution` |
| `get_parameters` | Data-grid parameters for a project |
| `get_user_permissions` | Permission flags for the current user on a project |

## Test cases

| Tool | Notes |
|---|---|
| `create_test_case` | Returns id + key |
| `get_test_case` | Accepts ID or key; returns versions |
| `update_test_case` | Pass `versionNo` (use `getTestCase` first) |
| `delete_test_case` | By version. Active cases must be archived first (API 400 otherwise) |
| `archive_test_case` | PUT `/testcases/{id}/archive` — required before delete |
| `unarchive_test_case` | Restore an archived case |
| `search_test_cases` | Filters: folderId, status (name), priority (name), labels, components, `query` (free-text → API `searchText`). Set `recursive: true` with `folderId` for subtree counts |
| `clone_test_cases` | Bulk clone with optional folder/project target |

## Test cycles

| Tool | Notes |
|---|---|
| `create_test_cycle` | `priority`/`status` are numeric IDs (number or numeric string) |
| `get_test_cycle` | Accepts key (`PROJ-TR-123`) — call this first to resolve to internal `id` |
| `update_test_cycle` | `priority`/`status` numeric IDs |
| `delete_test_cycle` | Active cycles must be archived first |
| `archive_test_cycle` | PUT `/testcycles/{id}/archive` — required before delete |
| `unarchive_test_cycle` | Restore an archived cycle |
| `search_test_cycles` | `query` free-text maps to `searchText` |
| `get_test_cycle_executions` | Returns `testCycleTestCaseMapId` per row — needed for bulk updates. Server-side `query`/`components` filters; `groupBy: "component"` auto-paginates the whole cycle and returns a `{ total, counts }` tally; responses slimmed by default (`slim: false` for raw) |

## Test plans

| Tool | Notes |
|---|---|
| `create_test_plan` | `priority`/`status` numeric IDs |
| `get_test_plan` | |
| `update_test_plan` | `priority` numeric ID |
| `delete_test_plan` | Active plans must be archived first |
| `archive_test_plan` | PUT `/testplans/{id}/archive` — required before delete |
| `unarchive_test_plan` | Restore an archived plan |
| `search_test_plans` | `query` free-text maps to `searchText` |
| `link_test_cycles_to_plan` | `testcycleIds` are cycle **UID strings** (search `id`), not numeric |
| `unlink_test_cycles_from_plan` | Same UID-string `testcycleIds` |
| `get_linked_test_cycles` | |

## Comments

Test case comments are version-scoped; cycle/plan comments are flat. Add tools accept either `comment` (string) or `comments` (array).

| Tool | Notes |
|---|---|
| `get_test_case_comments` | `versionNo` optional (defaults to latest) |
| `add_test_case_comment` | `versionNo` required |
| `update_test_case_comment` | Needs `versionNo` + `commentId` |
| `delete_test_case_comment` | Needs `versionNo` + `commentId` |
| `get_test_cycle_comments` | |
| `add_test_cycle_comment` | |
| `update_test_cycle_comment` | |
| `delete_test_cycle_comment` | |
| `get_test_plan_comments` | |
| `add_test_plan_comment` | |
| `update_test_plan_comment` | |
| `delete_test_plan_comment` | |

## Defects

`defectIDs` are numeric Jira defect IDs. Reads are POST with an optional `filter`.

| Tool | Notes |
|---|---|
| `get_execution_defects` | Defects on a test-case execution |
| `link_execution_defects` | PUT `{defectIDs:[…]}` |
| `unlink_execution_defects` | DELETE `{defectIDs:[…]}` |
| `get_step_execution_defects` | Defects on a test-step execution |
| `link_step_execution_defects` | |
| `unlink_step_execution_defects` | |
| `search_cycle_defects` | All defects across a cycle's executions |
| `get_cycle_defect_summary` | Aggregated defect summary for a cycle |

## Test steps

| Tool | Notes |
|---|---|
| `create_test_steps` | Per test case version |
| `update_test_steps` | |

## Executions

| Tool | When |
|---|---|
| `update_test_execution` | Single test-case-execution result |
| `update_test_step_execution` | Single step result inside an execution |
| `bulk_update_test_executions` | Many at once — uses `testCycleTestCaseMapId` |
| `get_execution_teststeps` | List per-step execution records for a test-case execution |
| `update_execution_custom_fields` | Set execution custom fields (`{id:"qcf_…", value, cascadeValue}`) |
| `upload_execution_attachment` | Upload a local file (two-step presigned-S3 POST; not a direct upload to QMetry) |
| `list_execution_attachments` | List attachments on an execution (registration lags a few seconds after upload) |
| `delete_execution_attachment` | Delete one or more attachments — DELETE the collection with `{attachmentIds:[…]}` or `{deleteAll:true}` |

## Folders

| Tool | Notes |
|---|---|
| `list_folders` | Pass `folderId` to scope to a subtree (full tree can be huge) |
| `create_folder` | Root-level folders use `parentId: -1` (0 → 404) |

## Automation rules

| Tool | Notes |
|---|---|
| `link_automation_rule` | |
| `unlink_automation_rule` | |
| `run_automation_rules` | Triggers `POST /automation-rule/{key}/run` |
| `get_automation_audit_log` | `POST /automation-rule/audit` — the only audit trail QTM4J exposes (automation-rule executions: who/when). No general test-case/cycle/folder deletion history exists. |

---

## Patterns

### Cycle key → internal ID
```
get_test_cycle({ id: "PROJ-TR-123" })
→ data.id = "abc123XYZ"  // use this for execution endpoints
```

### Bulk execution update
```
get_test_cycle_executions({ id: "<cycleId>" })
→ rows have testCycleTestCaseMapId

bulk_update_test_executions({
  cycleId: "<cycleId>",
  testCycleTestCaseMapIds: [ ...mapIds ],
  executionResultId: <from get_execution_results>,
  environmentId:   <from get_environments>,
  buildId:         <from get_builds>,
})
```

### Subtree count (cheap)
```
search_test_cases({ projectId: 10000, folderId: 100, recursive: true })
→ { total, folderCount }   // no data array, fast
```

## Where IDs come from

| Field | Source |
|---|---|
| `projectId` | `get_projects` |
| `priority` | `get_priorities` |
| `status` | `get_statuses({ module })` |
| `environmentId` | `get_environments` |
| `buildId` | `get_builds` |
| `executionResultId` | `get_execution_results` |
| `labels`, `components`, `fixVersions` | `get_labels`, `get_components`, Jira fix versions API |
| `customFields[].id` | `get_custom_fields({ module })` |
| `folderId` | `list_folders` |
