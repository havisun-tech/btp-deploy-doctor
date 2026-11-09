import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CfError,
  DiagnoseResult,
  Finding,
  Fix,
  Project,
  StaleFixError,
  analyzeLog,
  autoFixable,
  changedOffsets,
  fixAll,
  fetchAppLogs,
  fetchMtaOperationLogs,
  formatDiagnose,
  mtaModules,
  runChecks,
} from 'btp-deploy-doctor';

const WATCHED = new Set(['mta.yaml', 'mta.yml', 'package.json', '.cdsrc.json', '.cdsrc-private.json', 'xs-security.json', '.gitignore', 'manifest.json', 'xs-app.json', 'ui5.yaml', 'ui5-deploy.yaml']);

const SEVERITY: Record<Finding['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let lastOperationIds: string[] = [];
/** Findings behind each published diagnostic, for quick fixes. */
const findingsByKey = new Map<string, { root: string; finding: Finding }>();
const diagKey = (file: string, line: number, ruleId: string, title: string) => `${file}|${line}|${ruleId}|${title}`;

export function activate(ctx: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('btp-doctor');
  output = vscode.window.createOutputChannel('Deploy Doctor for SAP BTP');
  ctx.subscriptions.push(
    diagnostics,
    output,
    vscode.commands.registerCommand('btpDoctor.check', () => checkWorkspace(true)),
    vscode.commands.registerCommand('btpDoctor.diagnoseLog', diagnoseEditor),
    vscode.commands.registerCommand('btpDoctor.diagnoseFile', diagnoseFile),
    vscode.commands.registerCommand('btpDoctor.diagnoseApp', diagnoseApp),
    vscode.commands.registerCommand('btpDoctor.diagnoseMtaOp', diagnoseMtaOp),
    vscode.commands.registerCommand('btpDoctor.applyFix', applyFixCommand),
    vscode.commands.registerCommand('btpDoctor.fixAll', fixAllCommand),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', pattern: '**/{mta.yaml,mta.yml,package.json,.cdsrc.json,.gitignore,manifest.json,xs-app.json,ui5-deploy.yaml,xs-security.json,*.cds,*.dcl}' },
      { provideCodeActions },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (config().get<boolean>('checkOnSave', true) && (WATCHED.has(path.basename(doc.fileName)) || /\.(cds|dcl)$/.test(doc.fileName))) checkWorkspace(false);
    }),
  );
  checkWorkspace(false);
}

export function deactivate() {}

const config = () => vscode.workspace.getConfiguration('btpDoctor');
const cfOptions = (cwd?: string) => ({ cfPath: config().get<string>('cfPath') || 'cf', cwd });

/** Folders that hold an mta.yaml or a CAP package.json. */
async function projectRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const found = await vscode.workspace.findFiles('**/{mta.yaml,mta.yml,.cdsrc.json}', '**/{node_modules,gen,mta_archives}/**', 50);
  for (const uri of found) roots.add(path.dirname(uri.fsPath));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const p = new Project(folder.uri.fsPath);
    if (p.mta || p.isCap) roots.add(folder.uri.fsPath);
  }
  return [...roots];
}

async function checkWorkspace(interactive: boolean) {
  const roots = await projectRoots();
  diagnostics.clear();
  findingsByKey.clear();
  if (!roots.length) {
    if (interactive) vscode.window.showInformationMessage('BTP Doctor: no mta.yaml or CAP project found in this workspace.');
    return;
  }
  const byFile = new Map<string, vscode.Diagnostic[]>();
  let errors = 0;
  let warnings = 0;
  for (const root of roots) {
    for (const f of runChecks(root).findings) {
      if (f.ruleId === 'GEN001') continue;
      const file = path.join(root, f.location.file);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
      const line = Math.max(0, (f.location.line ?? 1) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        `${f.title}\n${f.message}${f.fix ? `\nFix: ${f.fix}` : ''}`,
        SEVERITY[f.severity],
      );
      d.source = 'BTP Doctor';
      d.code = f.ruleId;
      findingsByKey.set(diagKey(file, line, f.ruleId, f.title), { root, finding: f });
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
      if (f.severity === 'error') errors++;
      if (f.severity === 'warning') warnings++;
    }
  }
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
  if (interactive) {
    const msg = errors + warnings ? `BTP Doctor: ${errors} errors, ${warnings} warnings. See the Problems panel.` : 'BTP Doctor: no problems found.';
    const action = errors + warnings ? await vscode.window.showInformationMessage(msg, 'Open Problems') : await vscode.window.showInformationMessage(msg);
    if (action) vscode.commands.executeCommand('workbench.actions.view.problems');
  }
}

function showDiagnosis(source: string, result: DiagnoseResult) {
  lastOperationIds = result.operationIds;
  output.clear();
  output.appendLine(`Source: ${source}`);
  output.appendLine('');
  output.append(formatDiagnose(result));
  output.show(true);
  const n = result.matches.length;
  vscode.window.showInformationMessage(
    n ? `BTP Doctor: ${n} known problem${n === 1 ? '' : 's'} found. Details are in the output panel.` : 'BTP Doctor: no known problem found. Unexplained error lines are in the output panel.',
  );
}

async function withCf(title: string, run: () => Promise<string>): Promise<string | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, run);
  } catch (e: any) {
    const msg = e instanceof CfError ? e.message : String(e?.message ?? e);
    vscode.window.showErrorMessage(`BTP Doctor: ${msg}`);
    return undefined;
  }
}

async function diagnoseEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return diagnoseFile();
  const sel = editor.selection;
  const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  showDiagnosis(sel.isEmpty ? editor.document.fileName : `selection in ${editor.document.fileName}`, analyzeLog(text));
}

async function diagnoseFile() {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Explain log', filters: { Logs: ['log', 'txt'], All: ['*'] } });
  if (!picked?.length) return;
  const bytes = await vscode.workspace.fs.readFile(picked[0]);
  showDiagnosis(picked[0].fsPath, analyzeLog(Buffer.from(bytes).toString('utf8')));
}

async function diagnoseApp() {
  const roots = await projectRoots();
  const names = [...new Set(roots.flatMap((r) => mtaModules(new Project(r)).map((m) => m.name)).filter(Boolean))];
  const other = '$(edit) Enter another app name...';
  let app: string | undefined = names.length ? await vscode.window.showQuickPick([...names, other], { placeHolder: 'Which Cloud Foundry app?' }) : other;
  if (app === other) app = await vscode.window.showInputBox({ prompt: 'Cloud Foundry app name', placeHolder: 'my-app-srv' });
  if (!app) return;
  const name = app;
  const text = await withCf(`Fetching logs for ${name}...`, () => fetchAppLogs(name, cfOptions(roots[0])));
  if (text !== undefined) showDiagnosis(`cf logs ${name} --recent`, analyzeLog(text));
}

async function diagnoseMtaOp() {
  const id = await vscode.window.showInputBox({
    prompt: 'MTA operation ID (shown by a failed "cf deploy" after "cf dmol -i")',
    value: lastOperationIds[0] ?? '',
  });
  if (!id) return;
  const text = await withCf(`Downloading logs of operation ${id}...`, () => fetchMtaOperationLogs(id.trim(), cfOptions()));
  if (text !== undefined) showDiagnosis(`cf dmol -i ${id}`, analyzeLog(text));
}

// ---- quick fixes ----

function provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
  const actions: vscode.CodeAction[] = [];
  const roots = new Set<string>();
  for (const d of ctx.diagnostics) {
    if (d.source !== 'BTP Doctor' || typeof d.code !== 'string') continue;
    const title = d.message.split('\n')[0];
    const entry = findingsByKey.get(diagKey(doc.uri.fsPath, d.range.start.line, d.code, title));
    const fixes = entry?.finding.fixes ?? [];
    fixes.forEach((fix, idx) => {
      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [d];
      action.isPreferred = fixes.length === 1 && !fix.requiresReview;
      action.command = { command: 'btpDoctor.applyFix', title: fix.title, arguments: [entry!.root, d.code, title, idx] };
      actions.push(action);
    });
    if (entry && fixes.length) roots.add(entry.root);
  }
  for (const root of roots) {
    const count = autoFixable([...findingsByKey.values()].filter((e) => e.root === root).map((e) => e.finding)).length;
    if (count > 1) {
      const action = new vscode.CodeAction(`Fix all ${count} auto-fixable BTP Doctor problems`, vscode.CodeActionKind.QuickFix);
      action.command = { command: 'btpDoctor.fixAll', title: action.title, arguments: [root] };
      actions.push(action);
    }
  }
  return actions;
}

/** Saves unsaved editors inside `root`, so fixes are computed from what the user sees. */
async function saveDirty(root: string) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && d.uri.scheme === 'file' && d.uri.fsPath.startsWith(prefix)) await d.save();
  }
}

/** Applies a fix through the editor (undoable), then saves the touched files. */
async function applyFixInEditor(root: string, fix: Fix): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const touched: vscode.Uri[] = [];
  for (const c of fix.changes) {
    const uri = vscode.Uri.file(path.join(root, c.file));
    touched.push(uri);
    if (c.before === null) {
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), c.after);
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== c.before) throw new StaleFixError(`${c.file} changed since the fix was computed.`);
    const { start, end, text } = changedOffsets(c.before, c.after);
    edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not apply "${fix.title}".`);
  for (const uri of touched) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) await doc.save();
  }
}

async function offerFollowUps(root: string, followUps: (string | undefined)[]) {
  const unique = [...new Set(followUps.filter((f): f is string => !!f))];
  for (const msg of unique) {
    const npm = /npm install/.test(msg);
    const choice = await vscode.window.showInformationMessage(`BTP Doctor: ${msg}`, ...(npm ? ['Run npm install'] : []));
    if (choice === 'Run npm install') {
      const term = vscode.window.createTerminal({ name: 'npm install', cwd: root });
      term.show();
      term.sendText('npm install');
    }
  }
}

async function applyFixCommand(root: string, ruleId: string, title: string, idx: number) {
  try {
    await saveDirty(root);
    const finding = runChecks(root).findings.find((f) => f.ruleId === ruleId && f.title === title);
    const fix = finding?.fixes?.[idx];
    if (!fix) {
      vscode.window.showInformationMessage('BTP Doctor: this problem is already resolved.');
      return;
    }
    await applyFixInEditor(root, fix);
    await checkWorkspace(false);
    await offerFollowUps(root, [fix.followUp]);
  } catch (e: any) {
    vscode.window.showErrorMessage(`BTP Doctor: ${e?.message ?? e}`);
    await checkWorkspace(false);
  }
}

async function fixAllCommand(rootArg?: string) {
  let roots = rootArg ? [rootArg] : await projectRoots();
  roots = roots.filter((r) => autoFixable(runChecks(r).findings).length > 0);
  if (!roots.length) {
    vscode.window.showInformationMessage('BTP Doctor: nothing to fix automatically.');
    return;
  }
  const applied: { root: string; followUp?: string; fix: string }[] = [];
  try {
    for (const root of roots) {
      await saveDirty(root);
      const result = await fixAll(root, { apply: applyFixInEditor });
      applied.push(...result.applied.map((a) => ({ root, followUp: a.followUp, fix: a.fix })));
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`BTP Doctor: ${e?.message ?? e}`);
  }
  await checkWorkspace(false);
  output.clear();
  output.appendLine(`Applied ${applied.length} fix${applied.length === 1 ? '' : 'es'}:`);
  for (const a of applied) output.appendLine(`  ✔ ${a.fix}  (${path.basename(a.root)})`);
  output.show(true);
  vscode.window.showInformationMessage(`BTP Doctor: applied ${applied.length} fix${applied.length === 1 ? '' : 'es'}. Remaining problems are in the Problems panel.`);
  for (const root of roots) await offerFollowUps(root, applied.filter((a) => a.root === root).map((a) => a.followUp));
}
