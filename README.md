# QTM4J MCP Server

[![npm](https://img.shields.io/npm/v/qtm4j-mcp-server.svg)](https://www.npmjs.com/package/qtm4j-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/qtm4j-mcp-server.svg)](https://www.npmjs.com/package/qtm4j-mcp-server)
[![Node](https://img.shields.io/node/v/qtm4j-mcp-server.svg)](https://www.npmjs.com/package/qtm4j-mcp-server)
[![License](https://img.shields.io/npm/l/qtm4j-mcp-server.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server with **26 tools** for [QMetry Test Management for Jira (QTM4J)](https://www.qmetry.com/qmetry-test-management-jira). Search and manage test cases, cycles, executions, plans, folders, and automation rules from Claude Desktop, Claude Code, VS Code Copilot, Cursor, or any MCP-compatible client.

**Distribution**:
- npm: [`qtm4j-mcp-server`](https://www.npmjs.com/package/qtm4j-mcp-server)
- MCP Registry: `io.github.salehrifai42/qtm4j-mcp-server`
- GitHub: [`salehrifai42/qmetrymcp`](https://github.com/salehrifai42/qmetrymcp)

## Quick start (no clone required)

You need a QMetry API key (QMetry → *API Keys*) and Node.js 18+.

### Claude Desktop

Edit your config file and restart Claude:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

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
claude mcp add qtm4j -e QTM4J_API_KEY=your-api-key-here -e QTM4J_REGION=US -- npx -y qtm4j-mcp-server
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

Add to `~/.cursor/mcp.json` (or `<project>/.cursor/mcp.json` for project-level):

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

> 💡 Set `QTM4J_REGION=AU` if your QMetry instance is on the Sydney cluster.

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

All tools validate inputs with Zod, paginate via `startAt`/`maxResults`, and automatically retry rate-limited (HTTP 429) responses with exponential back-off (up to 3 attempts).

## Trying it out

Once connected, ask your assistant something like:

> *Search QMetry project `<your project ID>` for test cases with status "To Do" and show me the first 5.*

The client will call `qtm4j_search_test_cases` and render the response.

> *Get all executions in test cycle FS-TR-747 and mark any unexecuted ones as Pass.*

## Example tool calls

> Replace `10011` below with your numeric Jira project ID. Find it in the project URL: `…?projectId=10011&projectKey=FS`.

```jsonc
// Search test cases
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

## Troubleshooting

- **Tools don't appear in my client.** Restart the client after editing config. Check `claude mcp list` (Claude Code) or VS Code's MCP panel for connection status. On first run, `npx -y qtm4j-mcp-server` may take a few seconds to download the package.
- **401 Unauthorized.** Your `QTM4J_API_KEY` is invalid or expired. Generate a new one in QMetry → *API Keys*.
- **404 on execution or search endpoints.** Many endpoints want the **internal numeric `id`**, not the human key like `FS-TR-747`. Call `qtm4j_get_test_cycle` first to translate the key into the internal id.
- **Empty or oversized folder response.** Pass `folderId` to `qtm4j_list_folders` to scope to a subtree — full project trees on large projects can exceed the response size limit.
- **`projectId` rejected.** Use the **numeric** Jira project ID (e.g. `10011`), not the project key (`"FS"`). You can find it in the Jira project URL: `…?projectId=10011&projectKey=FS`.

## Notes

- Search endpoints use `POST /…/search` — filters go in the body under `filter`, pagination/sort on the query string. Tool handlers wrap this for you.
- `204 No Content` responses resolve as `{ message: "…" }`.
- The Swagger spec does not currently document a framework-style automation import-result endpoint (e.g. JUnit/TestNG/Cucumber ingestion); the automation tools cover the rules-run and rule-link flows exposed in the spec.

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

## Bugs and contributions

Found a bug or want to suggest a feature? Open an issue at <https://github.com/salehrifai42/qmetrymcp/issues>. PRs welcome.

## License

[MIT](LICENSE)
