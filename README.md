# QTM4J MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the
[QMetry Test Management for Jira Cloud (QTM4J) REST API](https://app.swaggerhub.com/apis-docs/qmetry-ada/qtm4j_cloud/restapi)
as tools Claude (or any MCP-compatible client) can call.

## Features

Tools cover the most common CRUD flows across the major QTM4J entities:

| Area | Tools |
| --- | --- |
| **Test Cases** | `create_test_case`, `get_test_case`, `search_test_cases`, `update_test_case`, `delete_test_case`, `clone_test_cases`, `create_test_steps`, `update_test_steps` |
| **Test Cycles** | `create_test_cycle`, `get_test_cycle`, `search_test_cycles`, `update_test_cycle`, `delete_test_cycle` |
| **Test Executions** | `get_test_cycle_executions`, `update_test_execution`, `update_test_step_execution`, `bulk_update_test_executions` |
| **Test Plans** | `create_test_plan`, `get_test_plan`, `search_test_plans`, `update_test_plan`, `delete_test_plan`, `link_test_cycles_to_plan`, `get_linked_test_cycles`, `unlink_test_cycles_from_plan` |
| **Folders** | `list_folders`, `create_folder` |
| **Automation** | `link_automation_rule`, `unlink_automation_rule`, `run_automation_rules` |

All tools validate inputs with Zod, paginate list endpoints via `startAt` / `maxResults`, and automatically retry rate-limited (HTTP 429) responses with exponential back-off up to 3 attempts.

## Requirements

- Node.js **18+** (uses native `fetch`)
- A QMetry API key (from QMetry → *API Keys*)

## Setup (same steps for all clients)

**1. Set your API key** — add to `~/.zshrc` or `~/.bashrc` so it persists across sessions:

```bash
export QTM4J_API_KEY=your-api-key-here
```

**2. Clone, install, build:**

```bash
git clone https://github.com/salehrifai42/qmetrymcp.git
cd qmetrymcp
npm install
npm run build
```

**3. Open your editor/IDE in the repo directory.** Both clients pick up `QTM4J_API_KEY` from your shell environment automatically — no extra config needed:

- **Claude Code** — `.mcp.json` is already in the repo. Run `claude` in this directory and the `qtm4j` server connects automatically.
- **GitHub Copilot (VS Code)** — `.vscode/mcp.json` is already in the repo. Open the folder in VS Code, switch Copilot Chat to **Agent** mode, and the `qtm4j` tools appear in the tool picker.

## Configuration

The server reads two environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `QTM4J_API_KEY` | yes | — | QMetry API key, sent on every request as the `apiKey` header |
| `QTM4J_REGION` | no | `US` | `US` → `https://qtmcloud.qmetry.com/rest/api/latest`, `AU` → `https://syd-qtmcloud.qmetry.com/rest/api/latest` |

### Local config reference

A `config.template.json` is included with common field values (project ID, statuses, priorities, execution result IDs, folder IDs, etc.). Copy it for local reference:

```bash
cp config.template.json config.json
```

`config.json` is git-ignored. The MCP server reads only from environment variables.

## Running manually

```bash
QTM4J_API_KEY=your-key npm start
```

The server speaks MCP over stdio — you don't normally run it directly; your MCP client spawns it.

## MCP client configuration

### Claude Code (CLI)

`.mcp.json` ships with this repo and is auto-detected when you open Claude Code in the project directory. Verify:

```bash
claude mcp list
```

Run `/mcp` inside a session to see connected servers and their tools.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and restart Claude Desktop:

```json
{
  "mcpServers": {
    "qtm4j": {
      "command": "node",
      "args": ["/path/to/qmetrymcp/dist/index.js"],
      "env": {
        "QTM4J_API_KEY": "your-api-key-here",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

### GitHub Copilot (VS Code)

`.vscode/mcp.json` ships with this repo and is auto-detected when you open the folder in VS Code. Switch Copilot Chat to **Agent** mode and the `qtm4j` tools appear automatically.

### Trying it out

Once connected, ask the assistant something like:

> *Search QMetry project 10011 for test cases with status "To Do" and show me the first 5.*

The client will call `search_test_cases` with `{ projectId: 10011, status: ["To Do"], maxResults: 5 }` and render the response.

> *Get all executions in test cycle FS-TR-747 and mark any unexecuted ones as Pass.*

## Example tool calls

```jsonc
// Search test cases in project with numeric ID 10011
{
  "name": "search_test_cases",
  "arguments": {
    "projectId": 10011,
    "status": ["Approved"],
    "maxResults": 20
  }
}

// Update an execution result (executionResultId: 239444=Pass, 239441=Fail, 239443=Not Executed)
{
  "name": "update_test_execution",
  "arguments": {
    "cycleId": "gxMbioKJsyEr3E",
    "testCaseExecutionId": 287595809,
    "executionResultId": 239444,
    "comment": "Verified on staging"
  }
}
```

## Error handling

- Non-2xx responses return a tool error with the HTTP status and parsed API body.
- Network errors return a descriptive error message.
- 429 responses are retried automatically with exponential back-off (up to 3 total attempts).

## Notes

- **`projectId` must be the numeric Jira project ID** (e.g. `10011`), not the project key (e.g. `"FS"`). You can find it in the Jira project URL: `…?projectId=10011&projectKey=FS`.
- Search endpoints use `POST /…/search` — filters go in the body under `filter`, pagination/sort on the query string. The MCP handlers wrap this for you automatically.
- "Update" endpoints that return `204 No Content` resolve with a simple `{ message: "…" }` payload.
- The Swagger spec does **not** currently document a framework-style automation import-result endpoint (e.g. JUnit/TestNG/Cucumber ingestion); the automation tools here cover the rules-run and rule-link flows exposed in the spec.
