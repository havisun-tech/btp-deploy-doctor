# Deploy Doctor MCP server

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants check, fix and diagnose SAP BTP Cloud Foundry deployments. It covers CAP, MTA, Fiori apps and multitenant (MTX/SaaS) apps.

It uses the same rules and fixes as the `btp-doctor` CLI and the VS Code extension.

## Tools

| Tool | What it does | Writes files |
| --- | --- | --- |
| `check_project` | Checks mta.yaml, package.json, .cdsrc.json, Fiori files and multitenancy setup. Returns findings with fix IDs. | No |
| `preview_fix` | Shows the diff for one fix ID. | No |
| `apply_fix` | Applies one fix, keeping formatting and comments. Refuses if the files changed since the check. | Yes |
| `fix_all` | Applies every fix that needs no choice, re-checking after each. Supports `dryRun`. | Yes |
| `diagnose_log` | Explains a deploy or app log, given as text or a file path. | No |
| `diagnose_cf_app` | Runs `cf logs <app> --recent` and explains it. | No |
| `diagnose_mta_operation` | Runs `cf dmol -i <id>` and explains it. | No |

Every tool takes an optional `path` to the project. Relative paths resolve against the server's working directory, or against the directory passed as the first argument.

Findings with several fixes are alternatives, so the assistant should ask which one to apply. `fix_all` skips them, and it also skips fixes marked `requiresReview`.

The cf tools use your local cf CLI login. Set `BTP_DOCTOR_CF` to use a cf binary that is not on the PATH. The assistant can never choose the binary.

## Setup

Until the package is on npm, replace `npx -y btp-deploy-doctor-mcp` with `node /path/to/btp-deploy-doctor/packages/mcp/dist/index.js`.

**Claude Code**

```sh
claude mcp add btp-doctor -- npx -y btp-deploy-doctor-mcp
```

**VS Code with GitHub Copilot**, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "btp-doctor": { "command": "npx", "args": ["-y", "btp-deploy-doctor-mcp", "${workspaceFolder}"] }
  }
}
```

**Cursor**, in `.cursor/mcp.json`, and **Claude Desktop**, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "btp-doctor": { "command": "npx", "args": ["-y", "btp-deploy-doctor-mcp", "/path/to/your/cap-project"] }
  }
}
```

**SAP Business Application Studio.** Use the VS Code setup if your dev space has an MCP-capable assistant. Otherwise use the CLI or the VS Code extension.

## Example prompts

- "Check this project before I deploy and fix what's safe to fix."
- "cf deploy failed, here is the output. What's wrong?"
- "My app bookshop-srv crashes after deploy. Look at its logs."

## Development

```sh
npm run build -w packages/mcp
npm test -w packages/mcp
```
