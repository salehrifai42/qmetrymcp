# Install QTM4J MCP Server in VS Code (Copilot Agent mode)

A step-by-step guide for installing the [`qtm4j-mcp-server`](https://www.npmjs.com/package/qtm4j-mcp-server) in VS Code so QMetry tools become available inside GitHub Copilot Chat's Agent mode.

## Prerequisites

- VS Code with the **GitHub Copilot** and **GitHub Copilot Chat** extensions installed and signed in (Copilot subscription required)
- Node.js 18+ — verify with `node -v`
- A QMetry API key — generate one in QMetry → *API Keys*

## Steps

### 1. Create the MCP config file

In the root of your workspace, create:

```
.vscode/mcp.json
```

### 2. Paste this configuration

```json
{
  "servers": {
    "qtm4j": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "qtm4j-mcp-server@^0.1"],
      "env": {
        "QTM4J_API_KEY": "${input:qtm4j_api_key}",
        "QTM4J_REGION": "US"
      }
    }
  },
  "inputs": [
    {
      "id": "qtm4j_api_key",
      "type": "promptString",
      "description": "QMetry API Key",
      "password": true
    }
  ]
}
```

The `inputs` block keeps your API key out of the committed config file. VS Code prompts for it on first launch and caches it locally.

For the AU region, change `"QTM4J_REGION": "US"` to `"AU"`.

### 3. Reload VS Code

`Cmd/Ctrl + Shift + P` → *Developer: Reload Window*

### 4. Switch Copilot Chat to Agent mode

Open Copilot Chat (`Cmd/Ctrl + Alt + I`) and change the mode dropdown to **Agent**.

### 5. Provide your API key on first run

VS Code prompts for your QMetry API key the first time the server launches. Paste it. The package downloads from npm on first run (~5 seconds), then starts.

### 6. Verify it loaded

In the Copilot Chat panel, click the 🛠 *tools* icon. You should see `qtm4j_*` tools listed (`qtm4j_search_test_cases`, `qtm4j_get_test_cycle`, etc.).

## Try it

> Search QMetry project `10011` for test cases with status "Approved" — show me the first 5.

Copilot will call `qtm4j_search_test_cases` and render the results.

## Finding your `projectId`

Open any QMetry project URL: `…?projectId=10011&projectKey=FS`. Tools require the **numeric** `10011` — not the project key `"FS"`.

## Troubleshooting

- **Tools don't appear** — check `View → Output → MCP`. Common causes: Node not on PATH, or `.vscode/mcp.json` has a JSON syntax error.
- **401 Unauthorized** — wrong API key. Reset with `Cmd/Ctrl + Shift + P` → *MCP: Reset Inputs*, then reload.
- **Slow first launch** — `npx` downloads on first run per machine; subsequent runs use the cache. For instant startup, see the [Global install](../README.md#global-install-faster-startup) section in the main README.
- **Want it for all projects?** Move the same configuration into VS Code **user** `settings.json` under `"mcp.servers"` instead of `.vscode/mcp.json`.

## Other install paths

The workspace `.vscode/mcp.json` shown above is the most common setup, but VS Code supports several alternatives. Pick whichever fits your situation:

### User settings (all workspaces)

If you want the server available in **every** project without committing config to each repo, add it to your VS Code **user** `settings.json` instead:

`Cmd/Ctrl + Shift + P` → *Preferences: Open User Settings (JSON)* → add:

```json
{
  "mcp": {
    "servers": {
      "qtm4j": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "qtm4j-mcp-server@^0.1"],
        "env": {
          "QTM4J_API_KEY": "${input:qtm4j_api_key}",
          "QTM4J_REGION": "US"
        }
      }
    },
    "inputs": [
      {
        "id": "qtm4j_api_key",
        "type": "promptString",
        "description": "QMetry API Key",
        "password": true
      }
    ]
  }
}
```

### Command Palette wizard (no JSON)

`Cmd/Ctrl + Shift + P` → *MCP: Add Server* → select **NPM Package** → enter `qtm4j-mcp-server` → choose user or workspace scope. VS Code generates the config for you and prompts for the API key.

### Global install (faster startup)

`npx` re-downloads on the first run per machine and adds startup latency every launch. Install once globally:

```bash
npm install -g qtm4j-mcp-server
```

Then in any of the configs above, replace:

```json
"command": "npx",
"args": ["-y", "qtm4j-mcp-server@^0.1"],
```

with:

```json
"command": "qtm4j-mcp-server",
```

Faster startup, works offline. Run `npm update -g qtm4j-mcp-server` to upgrade.

### Dev Containers / Codespaces

Add the server to `.devcontainer/devcontainer.json` so it auto-installs in cloud or container environments:

```json
{
  "customizations": {
    "vscode": {
      "settings": {
        "mcp.servers": {
          "qtm4j": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "qtm4j-mcp-server@^0.1"],
            "env": { "QTM4J_API_KEY": "${localEnv:QTM4J_API_KEY}" }
          }
        }
      }
    }
  }
}
```

Set `QTM4J_API_KEY` as a Codespaces secret so it's available without prompting.

### Enterprise / org-managed (Copilot Enterprise)

Org admins can push MCP server lists to all team members via Copilot Enterprise policy. See [GitHub Copilot Enterprise docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization) — the `qtm4j-mcp-server` block above works the same way once placed in the org policy.

## See also

- [Main README](../README.md) — install instructions for Claude Desktop, Claude Code, Cursor
- [`docs/TOOLS.md`](TOOLS.md) — full tool reference
- [`docs/COOKBOOK.md`](COOKBOOK.md) — example prompts
