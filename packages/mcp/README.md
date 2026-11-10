# MCP server for SAP BTP: deploy, roles and destinations

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants check, fix and diagnose SAP BTP Cloud Foundry apps. It brings the checks of all three free HAVISUN extensions to Claude Code, GitHub Copilot, Cursor and any other MCP client:

- **[Deploy Doctor for SAP BTP](https://www.havisun.com/tools/btp-deploy-doctor/)**: mistakes in mta.yaml, package.json, Fiori and multitenancy files that break `cf deploy`, with fixes, and explanations of failed deploy and app logs.
- **[Auth Studio for SAP BTP](https://www.havisun.com/tools/auth-studio/)**: why a CAP app returns 403. Every CDS role followed to its scope, role template and role collection in xs-security.json, or to AMS policies, and JWTs explained.
- **[Connectivity Doctor for SAP BTP](https://www.havisun.com/tools/connectivity-doctor/)**: why a deployed app cannot reach another system. Destinations, tokens and Cloud Connector setup, checked with the app's own bindings.

SAP's MCP servers for CAP, Fiori and UI5 help an assistant write the code. This one checks that it deploys, that users get their roles, and that the app can reach its backends. They work well together.

## Tools

**Deployment** (Deploy Doctor)

| Tool | What it does | Changes |
| --- | --- | --- |
| `check_project` | Checks mta.yaml, package.json, .cdsrc.json, Fiori files and multitenancy setup. Returns findings with fix IDs. | Nothing |
| `preview_fix` | Shows the diff for one fix ID. | Nothing |
| `apply_fix` | Applies one fix, keeping formatting and comments. Refuses if the files changed since the check. | Project files |
| `fix_all` | Applies every fix that needs no choice, re-checking after each. Supports `dryRun`. | Project files |
| `diagnose_log` | Explains a deploy or app log, given as text or a file path. | Nothing |
| `diagnose_cf_app` | Runs `cf logs <app> --recent` and explains it. | Nothing |
| `diagnose_mta_operation` | Runs `cf dmol -i <id>` and explains it. | Nothing |

**Roles and tokens** (Auth Studio)

| Tool | What it does | Changes |
| --- | --- | --- |
| `check_roles` | Follows every role in `@requires` and `@restrict` to its scope, role template and role collection, including what mta.yaml adds at deploy. Checks `$user` attributes and broken references. For apps on Identity Authentication, lists the AMS policies that give each role. | Nothing |
| `explain_token` | Decodes a JWT on your machine and says which CDS roles it grants, whether it expired or comes from another XSUAA instance, and for IAS which policies each role needs. | Nothing |
| `add_missing_roles` | Adds a scope and role template for each CDS role that has none, or creates xs-security.json from the CDS model. Supports `dryRun`. | xs-security.json |

**Destinations** (Connectivity Doctor)

| Tool | What it does | Changes |
| --- | --- | --- |
| `list_cf_apps` | Lists the apps in the targeted space. | Nothing |
| `check_destinations` | Reads a deployed app's bindings and checks every destination it can see, the way the app would: configuration, authentication tokens, on-premise and Cloud Connector setup, and destinations the CAP project uses that do not exist. Secrets are masked. | Nothing |
| `test_destination_call` | Sends one GET through a destination with the app's credentials and explains the answer. Takes a user JWT for user-dependent destinations. | Nothing (one request to the backend) |

Project tools take an optional `path`. Relative paths resolve against the server's working directory, or against the directory passed as the first argument.

Findings with several fixes are alternatives, so the assistant should ask which one to apply. `fix_all` skips them, and it also skips fixes marked `requiresReview`.

## Privacy and access

- Everything runs on your machine. There is no telemetry.
- The Cloud Foundry tools use your local cf CLI login and only read: app logs, the app's bindings (`cf curl /v3/apps/<guid>/env`, which needs the Space Developer role) and the Destination service. Credentials from the bindings stay in memory and are never returned to the assistant.
- Tokens given to `explain_token` or `test_destination_call` are decoded or forwarded only for that call and never stored. Remember that the assistant's own model provider still sees whatever you paste into the chat.
- Set `BTP_DOCTOR_CF` to use a cf binary that is not on the PATH. The assistant can never choose the binary.

## Setup

It needs Node.js 18 or later. `npx` downloads the server on first use.

**Claude Code**

```sh
claude mcp add btp-doctor -- npx -y @havisun/sap-btp-mcp
```

**VS Code with GitHub Copilot**, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "btp-doctor": { "command": "npx", "args": ["-y", "@havisun/sap-btp-mcp", "${workspaceFolder}"] }
  }
}
```

**Cursor**, in `.cursor/mcp.json`, and **Claude Desktop**, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "btp-doctor": { "command": "npx", "args": ["-y", "@havisun/sap-btp-mcp", "/path/to/your/cap-project"] }
  }
}
```

**SAP Business Application Studio.** Use the VS Code setup if your dev space has an MCP-capable assistant. Otherwise use the CLI or the VS Code extension.

## Example prompts

- "Check this project before I deploy and fix what's safe to fix."
- "cf deploy failed, here is the output. What's wrong?"
- "My app bookshop-srv crashes after deploy. Look at its logs."
- "Users get 403 on AdminService. Which role is missing, and can you add it?"
- "Here is my token. Why can't I see the orders?"
- "orders-srv cannot reach the S4 destination. Check it and test a call to /$metadata."

## Development

To run it from a clone of the repository, use `node /path/to/btp-deploy-doctor/packages/mcp/dist/index.js` instead of `npx -y @havisun/sap-btp-mcp`.


```sh
npm run build -w packages/mcp
npm test -w packages/mcp
```
