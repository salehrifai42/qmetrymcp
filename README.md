# QTM4J MCP Server

[![npm](https://img.shields.io/npm/v/qtm4j-mcp-server.svg)](https://www.npmjs.com/package/qtm4j-mcp-server)

An [MCP](https://modelcontextprotocol.io) server that exposes the [QMetry Test Management for Jira Cloud (QTM4J) REST API](https://app.swaggerhub.com/apis-docs/qmetry-ada/qtm4j_cloud/restapi) as tools any MCP-compatible client can call (Claude Desktop, Claude Code, VS Code Copilot, Cursor, etc.).

## Quick start (no clone required)

You need a QMetry API key (QMetry → *API Keys*) and Node.js 18+.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and restart Claude:

```json
{
  "mcpServers": {
    "qtm4j": {
      "command": "npx",
      "args": ["-y", "qtm4j-mcp-server"],
      "env": {
        "QTM4J_API_KEY": "your-api-key-here",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add qtm4j \
  -e QTM4J_API_KEY=your-api-key-here \
  -e QTM4J_REGION=US \
  -- npx -y qtm4j-mcp-server
```

### VS Code (GitHub Copilot Agent mode)

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "qtm4j": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "qtm4j-mcp-server"],
      "env": {
        "QTM4J_API_KEY": "${env:QTM4J_API_KEY}",
        "QTM4J_REGION": "US"
      }
    }
  }
}
```

Switch Copilot Chat to **Agent** mode and the `qtm4j_*` tools appear automatically.

### Cursor

Add to `~/.cursor/mcp.json` (or the project-level equivalent):

```json
{
  "mcpServers": {
    "qtm4j": {
      "command": "npx",
      "args": ["-y", "qtm4j-mcp-server"],
      "env": { "QTM4J_API_KEY": "your-api-key-here" }
    }
  }
}
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `QTM4J_API_KEY` | yes | — | QMetry API key, sent on every request as the `apiKey` header |
| `QTM4J_REGION` | no | `US` | `US` → `https://qtmcloud.qmetry.com`, `AU` → `https://syd-qtmcloud.qmetry.com` |

## Tools

All tools are prefixed with `qtm4j_` to avoid collisions with other MCP servers.

| Area | Tools |
| --- | --- |
| **Test Cases** | `qtm4j_create_test_case`, `qtm4j_get_test_case`, `qtm4j_search_test_cases`, `qtm4j_update_test_case`, `qtm4j_delete_test_case`, `qtm4j_clone_test_cases`, `qtm4j_create_test_steps`, `qtm4j_update_test_steps` |
| **Test Cycles** | `qtm4j_create_test_cycle`, `qtm4j_get_test_cycle`, `qtm4j_search_test_cycles`, `qtm4j_update_test_cycle`, `qtm4j_delete_test_cycle` |
| **Test Executions** | `qtm4j_get_test_cycle_executions`, `qtm4j_update_test_execution`, `qtm4j_update_test_step_execution`, `qtm4j_bulk_update_test_executions` |
| **Test Plans** | `qtm4j_create_test_plan`, `qtm4j_get_test_plan`, `qtm4j_search_test_plans`, `qtm4j_update_test_plan`, `qtm4j_delete_test_plan`, `qtm4j_link_test_cycles_to_plan`, `qtm4j_get_linked_test_cycles`, `qtm4j_unlink_test_cycles_from_plan` |
| **Folders** | `qtm4j_list_folders`, `qtm4j_create_folder` |
| **Automation** | `qtm4j_link_automation_rule`, `qtm4j_unlink_automation_rule`, `qtm4j_run_automation_rules` |

Every tool ships with annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can decide whether to ask for confirmation. Read tools accept a `response_format` parameter (`json` default, or `markdown` for human-readable output). Large responses are automatically truncated at 25k characters with a hint to narrow the query.

All tools validate inputs with Zod, paginate via `startAt`/`maxResults`, and automatically retry rate-limited (HTTP 429) responses with exponential back-off.

## Trying it out

Once connected, ask the assistant:

> *Search QMetry project 10011 for test cases with status "To Do" and show me the first 5.*

The client will call `qtm4j_search_test_cases` and render the response.

> *Get all executions in test cycle FS-TR-747 and mark any unexecuted ones as Pass.*

## Example tool calls

```jsonc
// Search test cases in project 10011
{
  "name": "qtm4j_search_test_cases",
  "arguments": {
    "projectId": 10011,
    "status": ["Approved"],
    "maxResults": 20,
    "response_format": "markdown"
  }
}

// Update an execution result
// (executionResultId: 239444=Pass, 239441=Fail, 239443=Not Executed)
{
  "name": "qtm4j_update_test_execution",
  "arguments": {
    "cycleId": "gxMbioKJsyEr3E",
    "testCaseExecutionId": 287595809,
    "executionResultId": 239444,
    "comment": "Verified on staging"
  }
}
```

## Notes

- **`projectId` must be the numeric Jira project ID** (e.g. `10011`), not the project key (e.g. `"FS"`). You can find it in the Jira project URL: `…?projectId=10011&projectKey=FS`.
- Search endpoints use `POST /…/search` — filters go in the body under `filter`, pagination/sort on the query string.
- `204 No Content` responses resolve with `{ message: "…" }`.
- The Swagger spec does **not** currently document a framework-style automation import-result endpoint (e.g. JUnit/TestNG/Cucumber ingestion); the automation tools cover the rules-run and rule-link flows exposed in the spec.

## Development

Local setup if you want to modify the server:

```bash
git clone https://github.com/salehrifai42/qmetrymcp.git
cd qmetrymcp
npm install
npm run build
QTM4J_API_KEY=your-key npm start
```

Test changes with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
QTM4J_API_KEY=your-key npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
