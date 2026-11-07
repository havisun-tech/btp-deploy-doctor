# BTP Deploy Doctor for VS Code and SAP Business Application Studio

- **Problems panel checks:** opens with any workspace that has an mta.yaml or CAP config, and re-checks on save. Mistakes in mta.yaml, package.json and CAP config show up as errors and warnings on the offending line.
- **One-click fixes:** click the lightbulb (or press Cmd+. / Ctrl+.) on a problem to apply its fix. **BTP Doctor: Fix All Auto-fixable Problems** applies every fix that needs no choice. Fixes go through the editor, so Undo works, and they change only the lines that need it.
- **Explain logs:** run **BTP Doctor: Explain Log in Editor**, **Explain Cloud Foundry App Logs...** or **Explain MTA Deploy Operation...** from the Command Palette. You get the known cause and fix for each failure.

Fetching logs uses the Cloud Foundry CLI and your existing `cf login` session. In BAS it is preinstalled.

## Settings

| Setting | Default | |
|---|---|---|
| `btpDoctor.checkOnSave` | `true` | Re-check when project config files are saved |
| `btpDoctor.cfPath` | `cf` | Path to the cf CLI |
