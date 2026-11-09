import * as path from 'path';
import * as vscode from 'vscode';
import { Finding, StaleFixError, runChecks, scanAms, scanCdsAuth } from 'btp-deploy-doctor';
import { analyzeIasToken, buildAmsState, dclRootFor } from './ams-model';

/** Deploy Doctor rules shown in the AMS view. */
const AMS_RULES = /^(AMS\d+|X001|AUTH010|AUTH011|CDS002|CDS004|CDS006)$/;

type ApplyFix = (root: string, changes: { file: string; before: string | null; after: string }[]) => Promise<void>;

/** One "AMS Policies" panel per project root. */
export class PoliciesPanel {
  private static panels = new Map<string, PoliciesPanel>();
  private findings: Finding[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, root: string, applyFix: ApplyFix, html: (w: vscode.Webview, media: vscode.Uri) => string, opts: { file?: string; tab?: string } = {}) {
    const existing = PoliciesPanel.panels.get(root);
    if (existing) {
      existing.panel.reveal();
      if (opts.tab) existing.post({ type: 'tab', tab: opts.tab });
      return;
    }
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('authStudio.amsPolicies', `AMS Policies · ${path.basename(root)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'images', 'icon.png');
    panel.webview.html = html(panel.webview, media);
    PoliciesPanel.panels.set(root, new PoliciesPanel(panel, root, dclRootFor(root, opts.file), applyFix, opts.tab));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly root: string,
    private readonly dclRoot: string,
    private readonly applyFix: ApplyFix,
    private pendingTab?: string,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/{*.dcl,*.cds,mta.yaml,mta.yml,package.json,.cdsrc.json}'));
    const changed = () => this.refresh();
    this.subs.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidSaveTextDocument((d) => !path.relative(root, d.fileName).startsWith('..') && changed()),
    );
    panel.onDidDispose(() => {
      this.subs.forEach((s) => s.dispose());
      clearTimeout(this.timer);
      PoliciesPanel.panels.delete(root);
    });
    panel.webview.onDidReceiveMessage((m) => this.receive(m));
  }

  private post(msg: unknown) {
    return this.panel.webview.postMessage(msg);
  }

  private refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 250);
  }

  /** Scans the DCL and CDS files and runs the related Deploy Doctor checks. */
  private send() {
    const state = buildAmsState(this.root, this.dclRoot);
    this.findings = runChecks(this.root).findings.filter((f) => AMS_RULES.test(f.ruleId));
    // AMS rules only run for CAP projects; a DCL root of another app still shows its policies.
    this.post({
      type: 'state',
      state,
      findings: this.findings.map((f, i) => ({ i, ruleId: f.ruleId, severity: f.severity, title: f.title, message: f.message, fix: f.fix, file: f.location.file, line: f.location.line, fixes: (f.fixes ?? []).map((x) => x.title), auto: (f.fixes ?? []).map((x) => !x.requiresReview) })),
    });
  }

  private async receive(m: any) {
    switch (m?.type) {
      case 'ready':
        this.send();
        if (this.pendingTab) this.post({ type: 'tab', tab: this.pendingTab });
        this.pendingTab = undefined;
        return;
      case 'open': {
        const line = Math.max(0, (m.line ?? 1) - 1);
        return vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, m.file)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
      }
      case 'applyFix':
        return this.fix(this.findings[m.i], m.fix ?? 0);
      case 'addPolicy': {
        // The AMS001 finding for this role carries the exact text change.
        const f = this.findings.find((x) => x.ruleId === 'AMS001' && x.title.startsWith(`Role "${m.role}" `));
        if (f) return this.fix(f, 0);
        return;
      }
      case 'addAms': {
        const term = vscode.window.createTerminal({ name: 'Auth Studio', cwd: this.root });
        term.show();
        term.sendText('npx cds add ams', false);
        vscode.window.showInformationMessage('Auth Studio: press Enter in the terminal to run "cds add ams". It adds @sap/ams, the DCL folder and the policy deployer to mta.yaml.');
        return;
      }
      case 'token': {
        // Decoded here, in the extension host. The token is never stored, logged or sent anywhere.
        const report = analyzeIasToken(String(m.token ?? ''), scanAms(this.root, this.dclRoot, false), scanCdsAuth(this.root));
        return this.post({ type: 'tokenReport', report });
      }
    }
  }

  private async fix(f: Finding | undefined, index: number) {
    const fix = f?.fixes?.[index];
    if (!fix) return;
    try {
      await this.applyFix(this.root, fix.changes);
      if (fix.followUp) vscode.window.showInformationMessage(`Auth Studio: ${fix.followUp}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(err instanceof StaleFixError ? `${err.message} The view has been refreshed; try again.` : `Auth Studio: ${err?.message ?? err}`);
    }
    this.send();
  }
}
