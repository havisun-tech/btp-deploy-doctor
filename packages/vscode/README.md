# BTP Deploy Doctor

Catches SAP BTP deployment mistakes before `cf deploy`, fixes most of them in one click, and explains failed deploy and app logs. Works in VS Code and SAP Business Application Studio (BAS).

It covers CAP Node.js services, Fiori apps deployed to the HTML5 application repository (managed approuter, SAP Build Work Zone, Application Frontend service), and multitenant SaaS apps built with MTX.

> **Preview.** The checks were validated on 20 public SAP sample projects. If a finding is wrong or a real problem is missed, please [open an issue](https://github.com/havisun-tech/btp-deploy-doctor/issues/new/choose).

## What it catches

Problems appear in the Problems panel and on the offending line of `mta.yaml`, `package.json`, `.cdsrc.json`, `xs-security.json`, `manifest.json`, `xs-app.json` and `ui5-deploy.yaml`. A few examples:

- **CAP service:** the service module is not bound to XSUAA or the destination service, `@sap/xssec` or the HANA driver is only a dev dependency, mock authentication is active in production, or `cds build` never runs so `gen/srv` is empty.
- **Fiori apps:** the artifact name in mta.yaml does not match the zip the UI5 build creates, `sap.cloud.service` does not match mta.yaml, a route uses a misspelled destination, xs-app.json is left out of the zip, or the HTML5 runtime is not enabled on the destination service.
- **Multitenant apps:** `@sap/cds-mtxs` is missing at runtime, XSUAA is not shared between tenants, Service Manager or the SaaS registry is missing, or the approuter has no `TENANT_HOST_PATTERN`.
- **Repository hygiene:** `.env`, `default-env.json` or `.cdsrc-private.json` with credentials is not git-ignored.

## One-click fixes

Click the lightbulb, or press `Cmd+.` / `Ctrl+.`, on a problem to apply its fix. Fixes go through the editor, so Undo works, and they change only the lines that need it. Formatting and comments are kept.

**BTP Doctor: Fix All Auto-fixable Problems** applies every fix that needs no decision. Fixes with alternatives, and fixes that could affect local development, are left for you to apply individually.

## Explain failed deploys

From the Command Palette:

- **BTP Doctor: Explain Log in Editor (or Selection)** for pasted `cf deploy`, `npm` or build output.
- **BTP Doctor: Explain Log File...** for a saved log.
- **BTP Doctor: Explain Cloud Foundry App Logs...** runs `cf logs <app> --recent`.
- **BTP Doctor: Explain MTA Deploy Operation...** runs `cf dmol -i <id>` for the operation ID that a failed `cf deploy` prints.

You get the known cause and the fix for each failure, plus the error lines that no known pattern explains. Fetching logs uses the Cloud Foundry CLI and your existing `cf login` session. In BAS the CLI is preinstalled.

## Privacy

Everything runs locally. The extension sends no telemetry and makes no network requests of its own. Only the two log commands call the cf CLI on your machine.

## Settings

| Setting | Default | Description |
|---|---|---|
| `btpDoctor.checkOnSave` | `true` | Re-check when project config files are saved |
| `btpDoctor.cfPath` | `cf` | Path to the cf CLI |

## Also available

The same checks run as a CLI for CI pipelines and as an MCP server for AI assistants. See the [repository](https://github.com/havisun-tech/btp-deploy-doctor).

Not covered yet: CAP Java and Kyma.

Made by [Havisun](https://www.havisun.com). Licensed under Apache 2.0.
