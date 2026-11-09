import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CdsAuth, Finding, StaleFixError, changedOffsets, runChecks } from 'btp-deploy-doctor';
import { Edit, EditError, analyzeToken, applyEdit, attributeStatus, effectiveDescriptor, generateDescriptor, issues, parseDescriptor, roleStatus } from './model';
import { MtaBinding, appName, findRoot, mtaBinding, scanCds } from './project';
import { isAmsProject, rootForDcl } from './ams-model';
import { PoliciesPanel } from './policies';

const VIEW_TYPE = 'authStudio.xsSecurity';
/** Deploy Doctor rules that matter for authorization. */
const AUTH_RULES = /^(AUTH\d+|X001|MTA008|CDS002|CDS004|CDS006|MT002|MT008)$/;

let provider: StudioProvider;
let context: vscode.ExtensionContext;

export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;
  provider = new StudioProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }),
    vscode.commands.registerCommand('authStudio.open', (uri?: vscode.Uri) => openStudio(uri)),
    vscode.commands.registerCommand('authStudio.openAsJson', () => {
      const uri = provider.activeUri;
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('authStudio.createFromCds', createFromCds),
    vscode.commands.registerCommand('authStudio.decodeToken', async () => {
      const uri = provider.activeUri ?? (await findDescriptor());
      if (!uri) {
        const ams = amsRoot();
        if (ams) return openPolicies(undefined, 'token');
        return void vscode.window.showInformationMessage('Auth Studio: no xs-security.json found in this workspace. Create one with "Auth Studio: Create xs-security.json from CDS Model".');
      }
      await openStudio(uri, 'token');
    }),
    vscode.commands.registerCommand('authStudio.openPolicies', (uri?: vscode.Uri) => openPolicies(uri)),
  );
}

/** Project root of the given or active file, or of the first workspace folder that uses AMS. */
function amsRoot(uri?: vscode.Uri): { root: string; file?: string } | undefined {
  const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
  if (file) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    const dclRoot = file.endsWith('.dcl') ? rootForDcl(file, folder?.uri.fsPath) : undefined;
    const root = dclRoot && !isAmsProject(findRoot(path.dirname(file), folder?.uri.fsPath)) ? dclRoot : findRoot(path.dirname(file), folder?.uri.fsPath);
    if (file.endsWith('.dcl') || isAmsProject(root)) return { root, file };
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) if (isAmsProject(f.uri.fsPath)) return { root: f.uri.fsPath };
  return undefined;
}

function openPolicies(uri?: vscode.Uri, tab?: string) {
  const target = amsRoot(uri);
  if (!target) {
    return void vscode.window
      .showInformationMessage('Auth Studio: this project does not use AMS policies yet (no @sap/ams and no ams/dcl folder). To switch a CAP app to IAS with AMS, run "cds add ias" and "cds add ams".', 'Open terminal')
      .then((pick) => {
        if (pick) vscode.window.createTerminal({ name: 'Auth Studio' }).show();
      });
  }
  PoliciesPanel.show(context, target.root, applyFix, (w, m) => html(w, m, 'policies.js'), { file: target.file?.endsWith('.dcl') ? target.file : undefined, tab });
}

export function deactivate() {}

async function openStudio(uri?: vscode.Uri, tab?: string) {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (!uri && active?.fsPath.endsWith('.dcl')) return openPolicies(active, tab);
  const target = uri ?? (active && /xs-security[^/\\]*\.json$/.test(active.fsPath) ? active : undefined) ?? (await findDescriptor());
  if (!target) {
    if (amsRoot()) return openPolicies(undefined, tab);
    return void vscode.window.showInformationMessage('Auth Studio: open an xs-security.json file first.');
  }
  if (tab) provider.pendingTab = tab;
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

async function findDescriptor(): Promise<vscode.Uri | undefined> {
  const found = await vscode.workspace.findFiles('**/xs-security*.json', '**/{node_modules,gen,dist,mta_archives}/**', 20);
  if (found.length <= 1) return found[0];
  const pick = await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Which security descriptor?' });
  return pick?.uri;
}

async function createFromCds() {
  const folder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : vscode.workspace.workspaceFolders?.[0];
  if (!folder) return void vscode.window.showInformationMessage('Auth Studio: open a CAP project folder first.');
  const start = vscode.window.activeTextEditor ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath) : folder.uri.fsPath;
  const root = findRoot(start, folder.uri.fsPath);
  const file = path.join(root, 'xs-security.json');
  if (fs.existsSync(file)) {
    vscode.window.showInformationMessage('Auth Studio: xs-security.json already exists. Opening it; add the missing CDS roles from the Roles tab.');
    return openStudio(vscode.Uri.file(file));
  }
  const cds = scanCds(root);
  if (!cds.roles.length) {
    const go = await vscode.window.showWarningMessage(`No roles found in @requires or @restrict annotations (${cds.filesScanned} .cds files). Create an xs-security.json without roles?`, 'Create', 'Cancel');
    if (go !== 'Create') return;
  }
  const edit = new vscode.WorkspaceEdit();
  const uri = vscode.Uri.file(file);
  edit.createFile(uri, { overwrite: false });
  edit.insert(uri, new vscode.Position(0, 0), generateDescriptor(appName(root), cds));
  if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showErrorMessage('Auth Studio: could not create xs-security.json.');
  await (await vscode.workspace.openTextDocument(uri)).save();
  await openStudio(uri);
  if (!mtaBinding(root, file) && (fs.existsSync(path.join(root, 'mta.yaml')) || fs.existsSync(path.join(root, 'mta.yml')))) {
    vscode.window.showInformationMessage('Auth Studio: no XSUAA resource in mta.yaml uses this file yet. Add "path: ./xs-security.json" to its parameters, or run "cds add xsuaa".');
  }
}

/** Replaces the document text with `after`, touching only the changed range (Undo works). */
async function replaceText(doc: vscode.TextDocument, after: string): Promise<boolean> {
  const before = doc.getText();
  if (before === after) return true;
  const { start, end, text } = changedOffsets(before, after);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
  return vscode.workspace.applyEdit(edit);
}

type Prompt =
  | 'addRole' | 'addScope' | 'addTemplate' | 'addCollection' | 'addAttribute' | 'setXsappname' | 'addRedirectUri'
  | 'describe';

class StudioProvider implements vscode.CustomTextEditorProvider {
  activeUri: vscode.Uri | undefined;
  pendingTab: string | undefined;
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = html(panel.webview, media);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const root = findRoot(path.dirname(doc.uri.fsPath), folder?.uri.fsPath);
    let cds: CdsAuth = scanCds(root);
    let binding: MtaBinding | undefined = mtaBinding(root, doc.uri.fsPath);
    let findings: Finding[] = [];
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');

    const post = (msg: unknown) => panel.webview.postMessage(msg);
    const sendState = () => {
      const d = parseDescriptor(doc.getText());
      // Status and problems are judged on what XSUAA gets at deploy, including mta.yaml config.
      const eff = effectiveDescriptor(doc.getText(), binding?.values);
      post({
        type: 'state',
        state: {
          file: rel(doc.uri.fsPath),
          root: path.basename(root),
          dirty: doc.isDirty,
          descriptor: d,
          issues: issues(eff, cds, !!binding),
          roles: roleStatus(eff, cds),
          attributes: attributeStatus(eff, cds),
          cdsFiles: cds.filesScanned,
          binding,
        },
      });
    };
    let timer: NodeJS.Timeout | undefined;
    const refresh = (rescan = false) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (rescan) {
          cds = scanCds(root);
          binding = mtaBinding(root, doc.uri.fsPath);
        }
        sendState();
      }, 150);
    };

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/{*.cds,mta.yaml,mta.yml}'));
    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => e.document.uri.toString() === doc.uri.toString() && refresh()),
      vscode.workspace.onDidSaveTextDocument((d) => (d.uri.toString() === doc.uri.toString() || /\.cds$|mta\.ya?ml$/.test(d.fileName)) && refresh(true)),
      watcher,
      watcher.onDidChange(() => refresh(true)),
      watcher.onDidCreate(() => refresh(true)),
      watcher.onDidDelete(() => refresh(true)),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.activeUri = doc.uri;
      }),
    ];
    if (panel.active) this.activeUri = doc.uri;
    panel.onDidDispose(() => {
      subs.forEach((s) => s.dispose());
      if (this.activeUri?.toString() === doc.uri.toString()) this.activeUri = undefined;
    });

    const edit = async (e: Edit | Edit[]) => {
      try {
        let text = doc.getText();
        for (const x of Array.isArray(e) ? e : [e]) text = applyEdit(text, x);
        await replaceText(doc, text);
      } catch (err: any) {
        vscode.window.showErrorMessage(err instanceof EditError ? err.message : `Auth Studio: ${err?.message ?? err}`);
      }
    };

    const ask = async (prompt: Prompt, arg: any): Promise<void> => {
      const input = (title: string, value = '', placeHolder = '', validate?: (v: string) => string | undefined) =>
        vscode.window.showInputBox({ title, value, placeHolder, validateInput: validate, ignoreFocusOut: true });
      const tmpl = (v: string) => (/^[A-Za-z0-9_]{1,64}$/.test(v) ? undefined : 'Letters, digits and "_" only, at most 64 characters.');
      const scope = (v: string) => (/^[A-Za-z0-9_.\-]{1,64}$/.test(v) ? undefined : 'Letters, digits, ".", "-" and "_" only, at most 64 characters.');
      switch (prompt) {
        case 'addRole': {
          const name = await input('New role: the name CAP checks in @requires / @restrict', '', 'e.g. Viewer', scope);
          if (name) await edit({ kind: 'addRole', name });
          return;
        }
        case 'addScope': {
          const name = await input('New scope (without $XSAPPNAME.)', '', 'e.g. Viewer', scope);
          if (name) await edit({ kind: 'addScope', name });
          return;
        }
        case 'addTemplate': {
          const name = await input('New role template', '', 'e.g. Viewer', tmpl);
          if (name) await edit({ kind: 'addTemplate', name });
          return;
        }
        case 'addCollection': {
          const name = await input('New role collection', '', 'e.g. Orders Viewer', (v) => (v.trim() ? undefined : 'Enter a name.'));
          if (name) await edit({ kind: 'addCollection', name: name.trim() });
          return;
        }
        case 'addAttribute': {
          const name = await input('New attribute', arg?.name ?? '', 'e.g. country', tmpl);
          if (name) await edit({ kind: 'addAttribute', name });
          return;
        }
        case 'setXsappname': {
          const value = await input('xsappname', parseDescriptor(doc.getText()).xsappname, '', (v) => (v.trim() ? undefined : 'xsappname cannot be empty.'));
          if (value) await edit({ kind: 'setXsappname', value: value.trim() });
          return;
        }
        case 'addRedirectUri': {
          const value = await input('Allowed redirect URI pattern', 'https://*.cfapps.eu10.hana.ondemand.com/**', 'https://*.<your landscape domain>/**', (v) => (/^https?:\/\//.test(v) ? undefined : 'Start with https://'));
          if (value) await edit({ kind: 'setRedirectUris', value: [...parseDescriptor(doc.getText()).redirectUris, value] });
          return;
        }
        case 'describe': {
          const value = await input(`Description of "${arg.name}"`, arg.description ?? '');
          if (value !== undefined) await edit({ kind: 'setDescription', list: arg.list, name: arg.name, description: value });
          return;
        }
      }
    };

    const runAuthChecks = async () => {
      if (doc.isDirty) await doc.save();
      findings = runChecks(root).findings.filter((f) => AUTH_RULES.test(f.ruleId));
      post({
        type: 'checks',
        findings: findings.map((f, i) => ({ i, ruleId: f.ruleId, severity: f.severity, title: f.title, message: f.message, fix: f.fix, file: f.location.file, line: f.location.line, fixes: (f.fixes ?? []).map((x) => x.title) })),
      });
    };

    panel.webview.onDidReceiveMessage(async (m: any) => {
      switch (m?.type) {
        case 'ready':
          sendState();
          if (this.pendingTab) post({ type: 'tab', tab: this.pendingTab });
          this.pendingTab = undefined;
          return;
        case 'edit':
          return edit(m.edit);
        case 'prompt':
          return ask(m.prompt, m.arg);
        case 'remove': {
          const ok = await vscode.window.showWarningMessage(m.question, { modal: true, detail: m.detail }, 'Remove');
          if (ok === 'Remove') await edit(m.edit);
          return;
        }
        case 'addMissing': {
          const d = parseDescriptor(doc.getText());
          const missing = roleStatus(d, cds).filter((r) => !r.scope || !r.templates.length).map((r): Edit => ({ kind: 'addRole', name: r.role }));
          const attrs = attributeStatus(d, cds).filter((a) => !a.defined).map((a): Edit => ({ kind: 'addAttribute', name: a.name }));
          return edit([...missing, ...attrs]);
        }
        case 'open': {
          const target = vscode.Uri.file(path.join(root, m.file));
          const line = Math.max(0, (m.line ?? 1) - 1);
          return vscode.window.showTextDocument(target, { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
        }
        case 'openJson':
          return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
        case 'runChecks':
          return runAuthChecks();
        case 'applyFix': {
          const f = findings[m.i];
          const fix = f?.fixes?.[m.fix];
          if (!fix) return;
          try {
            await applyFix(root, fix.changes);
            if (fix.followUp) vscode.window.showInformationMessage(`Auth Studio: ${fix.followUp}`);
          } catch (err: any) {
            vscode.window.showErrorMessage(err instanceof StaleFixError ? `${err.message} Run the checks again.` : `Auth Studio: ${err?.message ?? err}`);
          }
          return runAuthChecks();
        }
        case 'token':
          // Decoded here, in the extension host. The token is never stored, logged or sent anywhere.
          return post({ type: 'tokenReport', report: analyzeToken(String(m.token ?? ''), effectiveDescriptor(doc.getText(), binding?.values), cds) });
        case 'push':
          return push(doc, root, binding);
      }
    });
  }
}

async function applyFix(root: string, changes: { file: string; before: string | null; after: string }[]) {
  const edit = new vscode.WorkspaceEdit();
  for (const c of changes) {
    const uri = vscode.Uri.file(path.join(root, c.file));
    if (c.before === null) {
      edit.createFile(uri, { overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), c.after);
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== c.before) throw new StaleFixError(`${c.file} changed since the check ran.`);
    const { start, end, text } = changedOffsets(c.before, c.after);
    edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Could not apply the fix.');
  for (const c of changes) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, c.file)));
    if (doc.isDirty) await doc.save();
  }
}

/** Prepares "cf update-service" in a terminal. It is never run without the user pressing Enter. */
async function push(doc: vscode.TextDocument, root: string, binding: MtaBinding | undefined) {
  if (!binding) {
    return void vscode.window.showInformationMessage('Auth Studio: no XSUAA resource in mta.yaml uses this file, so the service instance name is unknown. Update it with "cf update-service <instance> -c <file>".');
  }
  if (binding.overrides.length) {
    return void vscode.window.showWarningMessage(
      `mta.yaml adds ${binding.overrides.join(', ')} to this descriptor at deploy time.`,
      { modal: true, detail: `"cf update-service" with only the file would drop those values (for example the xsappname) and can break logins. Redeploy the MTA instead ("mbt build" and "cf deploy"), which sends the file and the mta.yaml config together.` },
    );
  }
  if (doc.isDirty) await doc.save();
  const cf = vscode.workspace.getConfiguration('authStudio').get<string>('cfPath') || 'cf';
  const file = path.relative(root, doc.uri.fsPath).split(path.sep).join('/');
  const term = vscode.window.createTerminal({ name: 'Auth Studio', cwd: root });
  term.show();
  term.sendText(`${cf} update-service ${binding.instance} -c ${file}`, false);
  vscode.window.showInformationMessage(`Auth Studio: check the target space ("${cf} target"), then press Enter in the terminal to update "${binding.instance}".`);
}

function html(webview: vscode.Webview, media: vscode.Uri, script = 'studio.js'): string {
  const nonce = [...Array(24)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'studio.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, script));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Auth Studio</title>
</head>
<body>
<div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
