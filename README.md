# BTP Deploy Doctor

Finds SAP BTP / CAP deployment mistakes **before** `cf deploy`, and explains failed deploy and app logs **after** it.

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
```

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
