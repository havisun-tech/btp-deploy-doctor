# BTP Deploy Doctor

Finds SAP BTP / CAP deployment mistakes **before** `cf deploy`, fixes most of them automatically, and explains failed deploy and app logs **after** it. Covers CAP services, Fiori apps in the HTML5 application repository (managed approuter, Work Zone) and multitenant SaaS apps.

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `btp-doctor` CLI and library: project checks, log analyzer, cf log fetching |
| [`packages/vscode`](packages/vscode) | VS Code extension. Also runs in SAP Business Application Studio (BAS) |

## Try it

```sh
npm install
npm run build
node packages/core/dist/cli.js check examples/broken-bookshop
node packages/core/dist/cli.js diagnose examples/broken-bookshop/deploy.log
node packages/core/dist/cli.js fix --dry-run examples/broken-bookshop
```

Examples, each with a matching failed `deploy.log`:

| Folder | What is broken |
|---|---|
| `examples/broken-bookshop` | CAP service: bindings, dependencies, auth profiles, build step |
| `examples/broken-fiori` | Fiori app: artifact names, destinations, sap.cloud.service, packaging |
| `examples/broken-saas` | Multitenant app: tenant mode, Service Manager, TENANT_HOST_PATTERN, MTX |

## Development

```sh
npm test            # build core and run its tests
npm run typecheck   # type-check the extension
npm run package -w packages/vscode   # build a .vsix to install in VS Code or BAS
```

To run the extension from source, open this folder in VS Code and press F5 (uses `.vscode/launch.json`).

### Adding a rule

- **Static check:** add it to the matching file in `packages/core/src/rules/` with a new rule ID, and a test in `src/test/check.test.ts` that breaks the clean fixture.
- **Log pattern:** add it to `packages/core/src/logs/patterns.ts` and a sample line to `src/test/logs.test.ts`. The test suite fails if a pattern has no sample.
