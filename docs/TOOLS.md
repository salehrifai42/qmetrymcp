# QTM4J MCP — Tool Reference

42 tools, grouped by purpose. All tools are namespaced `qtm4j_*` and are listed by the bare name here.

Conventions:
- `projectId` = numeric Jira project ID (e.g. `10011`)
- `id` accepts either internal ID or key (`FS-TC-31950`) on `get_*` endpoints
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
| `delete_test_case` | By version |
| `search_test_cases` | Filters: folderId, status (name), priority (name), labels, components. Set `recursive: true` with `folderId` for subtree counts |
| `clone_test_cases` | Bulk clone with optional folder/project target |

## Test cycles

| Tool | Notes |
|---|---|
| `create_test_cycle` | |
| `get_test_cycle` | Accepts key (`FS-TR-747`) — call this first to resolve to internal `id` |
| `update_test_cycle` | |
| `delete_test_cycle` | |
| `search_test_cycles` | |
| `get_test_cycle_executions` | Returns `testCycleTestCaseMapId` per row — needed for bulk updates |

## Test plans

| Tool | Notes |
|---|---|
| `create_test_plan` | |
| `get_test_plan` | |
| `update_test_plan` | |
| `delete_test_plan` | |
| `search_test_plans` | |
| `link_test_cycles_to_plan` | |
| `unlink_test_cycles_from_plan` | |
| `get_linked_test_cycles` | |

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

## Folders

| Tool | Notes |
|---|---|
| `list_folders` | Pass `folderId` to scope to a subtree (full tree can be huge) |
| `create_folder` | |

## Automation rules

| Tool | Notes |
|---|---|
| `link_automation_rule` | |
| `unlink_automation_rule` | |
| `run_automation_rules` | Triggers `POST /automation-rule/{key}/run` |

---

## Patterns

### Cycle key → internal ID
```
get_test_cycle({ id: "FS-TR-747" })
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
search_test_cases({ projectId: 10011, folderId: 1508393, recursive: true })
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
