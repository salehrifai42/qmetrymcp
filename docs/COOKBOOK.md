# QTM4J MCP — Cookbook

Practical prompts you can paste into any MCP-aware client (Claude Code, Claude Desktop, Cursor, VS Code Copilot in agent mode) once `qtm4j` is registered. The assistant will pick the right tool — you don't need to name it.

> Replace `<projectId>`, `<KEY>`, and `<folderId>` placeholders below with your tenant's real values. Find the project ID and key in any Jira project URL: `…?projectId=<projectId>&projectKey=<KEY>`.

## Pick your project first

Most QMetry endpoints want a numeric `projectId`. If you don't know it:

> List all QMetry-enabled projects and show me the IDs.

The assistant calls `qtm4j_get_projects`. Note the numeric `id` (not the key).

## Discover IDs you'll need

Once you have a `projectId`, ask once and reuse:

> For project `<projectId>`, list priorities, statuses (test case + test cycle), environments, builds, labels, and components. Format as a quick reference.

This is now one chat turn instead of digging through QMetry config screens.

## Search & filter

> Find every test case in project `<projectId>` with label `Smoke` whose status is `To Do`, sorted by most recently updated.

> How many test cases live under folder `<folderId>` across all subfolders?
> *(uses `recursive: true` — returns total + folderCount only)*

> Show test cycles in project `<projectId>` created this month.

## Run an execution pass

```
For test cycle <KEY>-TR-<n>:
1. List all linked test cases.
2. Mark every "Login" test case as Pass on environment <env-name> with build <build-name>.
3. Leave a comment "Smoke pass — <date>".
```

The assistant resolves the cycle key → internal ID, looks up environment/build IDs (or uses cached ones from your `/qtm4j` skill), then bulk-updates.

## Create a test case with steps

> Create a test case in project `<projectId>`, folder `<folderId>`, summary "User can reset password via email", priority High, status To Do. Add 4 steps covering: open login, click forgot password, enter email, verify reset link.

## Build a regression cycle

```
Create a test cycle in project <projectId> named "Regression — Sprint 42",
folder <folder-name>, priority High, planned <start-date> → <end-date>,
and link the latest version of every test case in folder <folderId>
with label `Regression`.
```

## Verify a fix

> List all failed executions in cycle `<KEY>-TR-<n>` from the last 7 days, grouped by test case key. For each, show the actual result and any linked defects.

## Update test step results in bulk

> In cycle `<KEY>-TR-<n>`, mark step 3 of every executed test case as Pass.

The assistant pulls step executions, filters where `executionResult` is unset/Not Executed for step 3, and updates each.

## Folder ops

> Show me the folder tree under "<folder-name>" only — don't dump the whole project.

> Move test case `<KEY>-TC-<n>` to folder `<folderId>`.

## Pre-flight permission check

> Before I bulk-update 200 executions in project `<projectId>`, check if I have TEST_CYCLE_EXECUTE permission.

Calls `qtm4j_get_user_permissions`. Returns a flag map.

---

## Tips

- **Use keys for humans, IDs for the API.** `<KEY>-TC-123`, `<KEY>-TR-747` work in `get_*` calls. Search/execution endpoints need the internal numeric `id` from a prior search response.
- **`projectId` must be numeric** — pass the integer, never the key string.
- **Status/priority filters take name strings** — `"To Do"`, `"High"` — not IDs.
- **`recursive: true`** on `search_test_cases` with `folderId` counts across the whole subtree.
- **Bulk execution updates** use `testCycleTestCaseMapId` (from `get_test_cycle_executions`), not the test case ID.
- For known IDs you reuse constantly (statuses, environments, builds), copy `.claude/commands/qtm4j.template.md` to `.claude/commands/qtm4j.md` (which is gitignored) and fill in your tenant's values so the assistant has them every conversation.
