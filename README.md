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

## Install

No install needed — run it directly with `npx`:

```bash
npx qtm4j-mcp
```

…or install globally:

```bash
npm install -g qtm4j-mcp
qtm4j-mcp
```

…or from source:

```bash
git clone https://github.com/salehrifai42/qtm4j-mcp.git
cd qtm4j-mcp
npm install
npm run build
npm start
```

## Configuration

The server is configured entirely through environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `QTM4J_API_KEY` | yes | — | QMetry API key, sent on every request as the `apiKey` header |
| `QTM4J_REGION` | no  | `US` | `US` → `https://qtmcloud.qmetry.com/rest/api/latest`, `AU` → `https://qtmcloud-au.qmetry.com/rest/api/latest` |

## Running

```bash
QTM4J_API_KEY=your-key npm start
```

The server speaks MCP over stdio — you don't normally run it directly; your MCP client (Claude Desktop, Claude Code, etc.) spawns it.

## MCP client configuration

All clients use the same shape: `npx -y qtm4j-mcp` as the command, and `QTM4J_API_KEY` (plus optional `QTM4J_REGION`) in the env. No cloning, no absolute paths.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (or the platform equivalent) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "qtm4j": {
      "command": "npx",
      "args": ["-y", "qtm4j-mcp"],
      "env": {
        "QTM4J_API_KEY": "your-api-key-here",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

### Claude Code (CLI)

Easiest — use the `claude mcp add` command:

```bash
claude mcp add qtm4j \
  -e QTM4J_API_KEY=your-api-key-here \
  -e QTM4J_REGION=US \
  -- npx -y qtm4j-mcp
```

This writes to your user-scoped config (`~/.claude.json`). To scope it to a single repo instead, drop a `.mcp.json` at the project root with the same `mcpServers` shape as the Claude Desktop example above — Claude Code will pick it up automatically.

Verify it's registered:

```bash
claude mcp list
```

In a session you can also run `/mcp` to see connected servers and their tools.

### GitHub Copilot (VS Code)

Copilot's agent mode supports MCP via a `.vscode/mcp.json` file in your workspace (or the equivalent block in user `settings.json` under `github.copilot.chat.mcp.servers`). Note: Copilot's schema uses `servers` (not `mcpServers`) and expects an explicit `type`:

```jsonc
// .vscode/mcp.json
{
  "servers": {
    "qtm4j": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "qtm4j-mcp"],
      "env": {
        "QTM4J_API_KEY": "your-api-key-here",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

After saving, open the Copilot Chat panel, switch to **Agent** mode, and the `qtm4j` tools will appear in the tool picker. If you don't want to commit your API key, use VS Code's secret input:

```jsonc
{
  "inputs": [
    { "id": "qtm4jKey", "type": "promptString", "description": "QTM4J API Key", "password": true }
  ],
  "servers": {
    "qtm4j": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "qtm4j-mcp"],
      "env": {
        "QTM4J_API_KEY": "${input:qtm4jKey}",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

### Trying it out

Once connected, ask the assistant something like:

> *Search QMetry project 10011 for test cases with status "Approved" and show me the first 5.*

The client will call `search_test_cases` with `{ projectId: 10011, status: ["Approved"], maxResults: 5 }` and render the response.

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

// Update an execution result
{
  "name": "update_test_execution",
  "arguments": {
    "cycleId": 1234,
    "testCaseExecutionId": 56789,
    "executionResultId": 2,
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
