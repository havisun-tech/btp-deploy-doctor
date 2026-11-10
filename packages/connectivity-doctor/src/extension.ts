import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CfError, ConnectivitySession, Project, cfTarget, formatConnectivity, listApps, mtaModules } from 'btp-deploy-doctor';

const LAST_APP = 'connectivityDoctor.lastApp';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.commands.registerCommand('connectivityDoctor.open', (uri?: vscode.Uri) => Panel.show(ctx, uri)));
}

export function deactivate() {}

const cfPath = () => vscode.workspace.getConfiguration('connectivityDoctor').get<string>('cfPath') || 'cf';

/** Project folder: the folder of the given mta.yaml, or the first workspace folder with an mta.yaml or package.json. */
function projectRoot(uri?: vscode.Uri): string | undefined {
  if (uri) return fs.statSync(uri.fsPath).isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const has = (f: string) => fs.existsSync(path.join(f, 'mta.yaml')) || fs.existsSync(path.join(f, 'mta.yml'));
  return (folders.find((f) => has(f.uri.fsPath)) ?? folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, 'package.json'))))?.uri.fsPath;
}

/** Module names from mta.yaml, CAP services first: likely app names. */
function mtaAppNames(root?: string): string[] {
  if (!root) return [];
  try {
    const mods = mtaModules(new Project(root));
    const rank = (t?: string) => (t === 'nodejs' || t === 'java' ? 0 : t === 'approuter.nodejs' ? 1 : 2);
    return mods.filter((m) => m.name).sort((a, b) => rank(a.type) - rank(b.type)).map((m) => m.name);
  } catch {
    return [];
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Panel {
  static current: Panel | undefined;
  private session?: ConnectivitySession;
  private busy = false;

  static show(ctx: vscode.ExtensionContext, uri?: vscode.Uri) {
    const root = projectRoot(uri);
    if (Panel.current) {
      Panel.current.root = root ?? Panel.current.root;
      Panel.current.panel.reveal();
      Panel.current.loadApps();
      return;
    }
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('connectivityDoctor', 'Connectivity Doctor', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    Panel.current = new Panel(ctx, panel, media, root);
  }

  private constructor(private readonly ctx: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel, media: vscode.Uri, private root: string | undefined) {
    panel.webview.html = html(panel.webview, media);
    panel.onDidDispose(() => {
      Panel.current = undefined;
      this.session = undefined;
    });
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', message: message(e) })));
  }

  private post(m: unknown) {
    this.panel.webview.postMessage(m);
  }

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
      case 'loadApps':
        return this.loadApps();
      case 'run':
        return this.run(String(m.app ?? ''));
      case 'testCall': {
        if (!this.session) return;
        this.post({ type: 'pending', name: m.name, what: 'call' });
        const check = await this.session.testCall(String(m.name), { path: typeof m.path === 'string' ? m.path : undefined, userToken: cleanToken(m.userToken) });
        return this.post({ type: 'call', name: m.name, check });
      }
      case 'userToken': {
        if (!this.session) return;
        const token = cleanToken(m.token);
        if (!token) return this.post({ type: 'error', message: 'Paste a JWT (three parts separated by dots).' });
        this.post({ type: 'pending', name: m.name, what: 'token' });
        await this.session.checkDestination(String(m.name), token);
        return this.post({ type: 'report', report: this.session.report });
      }
      case 'copy':
        if (this.session) {
          await vscode.env.clipboard.writeText(formatConnectivity(this.session.report));
          vscode.window.showInformationMessage('Connectivity Doctor: report copied (no secrets or tokens included).');
        }
        return;
      case 'log':
        return void vscode.window.showErrorMessage(`Connectivity Doctor panel error: ${String(m.message ?? '')}`);
      case 'terminal':
        return vscode.window.createTerminal({ name: 'Cloud Foundry' }).show();
      case 'settings':
        return vscode.commands.executeCommand('workbench.action.openSettings', 'connectivityDoctor.cfPath');
    }
  }

  async loadApps() {
    const target = cfTarget();
    this.post({ type: 'busy', text: 'Reading the apps in your Cloud Foundry space…' });
    try {
      const apps = await listApps({ cfPath: cfPath() });
      const names = new Set(apps.map((a) => a.name));
      const last = this.ctx.workspaceState.get<string>(LAST_APP);
      const suggested = (last && names.has(last) ? last : undefined) ?? mtaAppNames(this.root).find((n) => names.has(n)) ?? apps[0]?.name;
      this.post({ type: 'apps', target, apps, suggested, project: this.root ? path.basename(this.root) : undefined, version: this.ctx.extension.packageJSON.version });
    } catch (e) {
      this.post({ type: 'error', message: message(e), cf: e instanceof CfError, target });
    }
  }

  private async run(app: string) {
    if (this.busy) return;
    if (!app) return this.post({ type: 'error', message: 'Pick an app first.' });
    this.busy = true;
    this.post({ type: 'busy', text: `Checking the destinations of "${app}"…` });
    try {
      this.session = await ConnectivitySession.forApp(app, { cf: { cfPath: cfPath() }, projectRoot: this.root });
      await this.ctx.workspaceState.update(LAST_APP, app);
      this.post({ type: 'report', report: this.session.report });
    } catch (e) {
      this.post({ type: 'error', message: message(e), cf: e instanceof CfError, target: cfTarget() });
    } finally {
      this.busy = false;
    }
  }
}

function cleanToken(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  const s = t.trim().replace(/^bearer\s+/i, '');
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(s) ? s : undefined;
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = [...Array(24)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Connectivity Doctor</title>
</head>
<body>
<div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
