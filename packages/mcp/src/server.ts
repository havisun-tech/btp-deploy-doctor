import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  analyzeIasToken,
  analyzeLog,
  analyzeToken,
  appName,
  applyEdit,
  attributeStatus,
  buildAmsState,
  cfTarget,
  ConnectivitySession,
  dclRootOf,
  effectiveDescriptor,
  generateDescriptor,
  isAmsProject,
  issues,
  listApps,
  mtaBinding,
  Project,
  roleStatus,
  scanAms,
  scanCdsAuth,
  applyFixToDisk,
  autoFixable,
  CfError,
  CheckResult,
  fetchAppLogs,
  fetchMtaOperationLogs,
  Finding,
  Fix,
  fixAll,
  formatFixPreview,
  runChecks,
  StaleFixError,
} from 'btp-deploy-doctor';

export interface ServerOptions {
  /** Project used when a tool call gives no path. Defaults to the process working directory. */
  defaultRoot?: string;
  /** cf CLI executable. Defaults to $BTP_DOCTOR_CF or "cf". Never taken from tool input. */
  cfPath?: string;
}

const VERSION = '0.1.1';

/** Stable ID for one fix of one finding, so it survives a re-check of unchanged files. */
export function fixId(f: Finding, fixIndex: number): string {
  const fix = f.fixes![fixIndex];
  const h = createHash('sha1')
    .update([f.ruleId, f.location.file, f.location.line ?? 0, f.title, fix.title].join('|'))
    .digest('hex')
    .slice(0, 8);
  return `${f.ruleId}-${h}`;
}

function findingToJson(f: Finding) {
  return {
    ruleId: f.ruleId,
    severity: f.severity,
    title: f.title,
    message: f.message,
    file: f.location.file,
    line: f.location.line,
    howToFix: f.fix,
    fixes: f.fixes?.map((x, i) => ({
      fixId: fixId(f, i),
      title: x.title,
      files: x.changes.map((c) => c.file),
      followUp: x.followUp,
      requiresReview: x.requiresReview || undefined,
      includedInFixAll: f.fixes!.length === 1 && !x.requiresReview,
    })),
  };
}

function checkToJson(r: CheckResult) {
  return {
    root: r.root,
    summary: r.summary,
    autoFixable: autoFixable(r.findings).length,
    findings: r.findings.map(findingToJson),
  };
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function findFix(root: string, id: string): { finding: Finding; fix: Fix } | undefined {
  for (const f of runChecks(root).findings) {
    for (let i = 0; i < (f.fixes?.length ?? 0); i++) if (fixId(f, i) === id) return { finding: f, fix: f.fixes![i] };
  }
  return undefined;
}

const notFound = (id: string) =>
  fail(`No fix with ID "${id}" in the current check results. The files may have changed. Call check_project again to get fresh fix IDs.`);

async function guard(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CfError || err instanceof StaleFixError) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
}


const SKIP_DIRS = new Set(['node_modules', 'gen', 'dist', 'mta_archives', '.git', 'resources']);

/** xs-security*.json files in the project, nearest first (max depth 3). */
export function findDescriptors(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isFile() && /^xs-security[^/\\]*\.json$/.test(e.name)) out.push(path.join(dir, e.name));
    if (depth < 3) for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Role chain for one xs-security.json, with what mta.yaml adds at deploy. */
function descriptorReport(root: string, file: string) {
  const cds = scanCdsAuth(root);
  const binding = mtaBinding(root, file);
  const d = effectiveDescriptor(fs.readFileSync(file, 'utf8'), binding?.values);
  return {
    file: path.relative(root, file) || path.basename(file),
    xsappname: d.xsappname || undefined,
    tenantMode: d.tenantMode || undefined,
    deployedBy: binding && { mtaFile: binding.mtaFile, resource: binding.resource, instance: binding.instance, overriddenKeys: binding.overrides, boundTo: binding.boundTo },
    issues: issues(d, cds, !!binding),
    roles: roleStatus(d, cds).map((r) => ({
      ...r,
      reachable: r.scope && r.templates.length > 0 && r.collections.length > 0,
      note: !r.scope
        ? 'No scope: nobody can get this role. Use add_missing_roles.'
        : !r.templates.length
          ? 'Scope exists, but no role template grants it. Use add_missing_roles.'
          : !r.collections.length
            ? 'No role collection in xs-security.json contains its template. Create one here or in the BTP cockpit (Security > Role Collections) and assign it to users.'
            : undefined,
    })),
    attributes: attributeStatus(d, cds),
    roleCollections: d.collections,
  };
}

function amsReport(root: string) {
  const dclRoot = dclRootOf(new Project(root).cdsFor('production'));
  const s = buildAmsState(root, dclRoot);
  return {
    dclRoot: s.dclRoot,
    dclRootExists: s.dclRootExists,
    files: s.files,
    generatedByCdsBuild: s.generates,
    roles: s.roles.map((r) => ({
      ...r,
      note: r.direct.length || r.derived.length ? undefined : 'No policy gives this role, so no user can get it. Add a policy that ASSIGNs ROLE ' + r.role + '.',
    })),
    policies: s.policies.map((p) => ({ name: p.qualified, kind: p.kind, file: p.file, line: p.line, roles: p.roles.map((x) => x.role), uses: p.uses.map((u) => ({ target: u.target, known: u.known })), usedBy: p.usedBy })),
    attributes: s.attributes,
  };
}

function pickDescriptor(root: string, file?: string): string | undefined {
  if (file) {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    return abs;
  }
  const found = findDescriptors(root);
  return found.find((f) => path.dirname(f) === root) ?? found[0];
}

export function createServer(opts: ServerOptions = {}): McpServer {
  const cfPath = opts.cfPath ?? process.env.BTP_DOCTOR_CF ?? 'cf';
  const rootOf = (p?: string) => {
    const root = path.resolve(opts.defaultRoot ?? process.cwd(), p ?? '.');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    return root;
  };

  const server = new McpServer(
    { name: 'havisun-btp-doctor', version: VERSION },
    {
      instructions:
        'Checks SAP BTP Cloud Foundry projects (CAP, MTA, Fiori, multitenant) for deployment problems and explains failed deploy logs. ' +
        'Typical flow: check_project, then preview_fix and apply_fix for individual findings, or fix_all for every fix that needs no choice. ' +
        'Findings with several fixes are alternatives; ask the user which one to apply. Fixes marked requiresReview must be shown to the user first. ' +
        'For a failed "cf deploy", use diagnose_log with the output, or diagnose_mta_operation with the operation ID the log mentions. ' +
        'For 401/403 errors, use check_roles (CDS roles vs xs-security.json or AMS policies) and explain_token for a JWT the user provides. ' +
        'When a deployed app cannot reach another system, use check_destinations with the Cloud Foundry app name, then test_destination_call. ' +
        'Never print secrets or tokens back to the user.',
    },
  );

  const projectPath = z
    .string()
    .optional()
    .describe('Project root containing mta.yaml or package.json. Relative paths resolve against the server working directory. Defaults to it.');

  server.registerTool(
    'check_project',
    {
      title: 'Check BTP project',
      description:
        'Checks mta.yaml, package.json, .cdsrc.json, Fiori app files and multitenancy setup for problems that make "cf deploy" fail or the app break after deploy. ' +
        'Returns findings with severity, location, explanation and fix IDs for one-click fixes. Read-only.',
      inputSchema: { path: projectPath },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path: p }) => guard(() => ok(checkToJson(runChecks(rootOf(p))))),
  );

  server.registerTool(
    'preview_fix',
    {
      title: 'Preview a fix',
      description: 'Shows the exact file changes a fix would make, as a diff. Use a fixId from check_project. Read-only.',
      inputSchema: { path: projectPath, fixId: z.string().describe('Fix ID from check_project, e.g. "MTA004-1a2b3c4d".') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path: p, fixId: id }) =>
      guard(() => {
        const hit = findFix(rootOf(p), id);
        if (!hit) return notFound(id);
        return {
          content: [
            {
              type: 'text',
              text:
                `${hit.finding.ruleId}: ${hit.fix.title}\n` +
                (hit.fix.requiresReview ? 'This fix needs review: show it to the user before applying.\n' : '') +
                (hit.fix.followUp ? `After applying: ${hit.fix.followUp}\n` : '') +
                `\n${formatFixPreview(hit.fix)}`,
            },
          ],
        };
      }),
  );

  server.registerTool(
    'apply_fix',
    {
      title: 'Apply a fix',
      description:
        'Writes one fix to the project files, keeping their formatting and comments. Use a fixId from check_project. ' +
        'Refuses if the files changed since the check. Returns any follow-up step, such as npm install, and the remaining findings.',
      inputSchema: { path: projectPath, fixId: z.string().describe('Fix ID from check_project.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ path: p, fixId: id }) =>
      guard(() => {
        const root = rootOf(p);
        const hit = findFix(root, id);
        if (!hit) return notFound(id);
        applyFixToDisk(root, hit.fix);
        return ok({
          applied: hit.fix.title,
          ruleId: hit.finding.ruleId,
          files: hit.fix.changes.map((c) => c.file),
          followUp: hit.fix.followUp,
          remaining: checkToJson(runChecks(root)),
        });
      }),
  );

  server.registerTool(
    'fix_all',
    {
      title: 'Apply all safe fixes',
      description:
        'Applies every fix that needs no choice, one at a time, re-checking after each. ' +
        'Skips findings with alternative fixes and fixes that need review. With dryRun, only lists the diffs.',
      inputSchema: {
        path: projectPath,
        dryRun: z.boolean().optional().describe('Only show what would change. Default false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ path: p, dryRun }) =>
      guard(async () => {
        const root = rootOf(p);
        if (dryRun) {
          const fixable = autoFixable(runChecks(root).findings);
          return ok({
            wouldApply: fixable.map((f) => ({ ruleId: f.ruleId, fixId: fixId(f, 0), title: f.fixes![0].title, diff: formatFixPreview(f.fixes![0]) })),
            note: 'Fixes are applied one at a time with a re-check after each, so later diffs may differ slightly.',
          });
        }
        const { applied, remaining } = await fixAll(root);
        return ok({
          applied,
          followUps: [...new Set(applied.map((a) => a.followUp).filter(Boolean))],
          remaining: checkToJson(remaining),
        });
      }),
  );

  server.registerTool(
    'diagnose_log',
    {
      title: 'Explain a deploy or app log',
      description:
        'Matches a Cloud Foundry, MTA deploy, HDI, npm, UI5 build or CAP runtime log against known failure signatures. ' +
        'Returns the cause and fix for each known problem, MTA operation IDs, and unexplained error lines. Pass the text or a file path. Read-only.',
      inputSchema: {
        text: z.string().optional().describe('Log text, e.g. the output of "cf deploy" or "cf logs <app> --recent".'),
        file: z.string().optional().describe('Path to a saved log file, used when text is not given.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ text, file }) =>
      guard(() => {
        if (text === undefined && !file) return fail('Pass the log as "text" or a log file path as "file".');
        const log = text ?? fs.readFileSync(path.resolve(opts.defaultRoot ?? process.cwd(), file!), 'utf8');
        return ok(analyzeLog(log));
      }),
  );

  server.registerTool(
    'diagnose_cf_app',
    {
      title: 'Explain recent app logs',
      description:
        'Runs "cf logs <app> --recent" with the locally logged-in cf CLI and explains known problems. Read-only on Cloud Foundry. ' +
        'Needs the cf CLI installed and logged in to the right org and space.',
      inputSchema: { app: z.string().describe('Cloud Foundry app name, e.g. "bookshop-srv".') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app }) => guard(async () => ok(analyzeLog(await fetchAppLogs(app, { cfPath, cwd: opts.defaultRoot })))),
  );

  server.registerTool(
    'diagnose_mta_operation',
    {
      title: 'Explain a failed MTA deploy',
      description:
        'Downloads the logs of one MTA deploy operation ("cf dmol -i <id>") with the local cf CLI and explains known problems. ' +
        'The operation ID appears in failed "cf deploy" output. Read-only on Cloud Foundry.',
      inputSchema: { operationId: z.string().describe('MTA operation ID from the cf deploy output.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ operationId }) => guard(async () => ok(analyzeLog(await fetchMtaOperationLogs(operationId, { cfPath, cwd: opts.defaultRoot })))),
  );

  // ---------------- Auth Studio: roles, policies, tokens ----------------

  const descriptorFile = z.string().optional().describe('xs-security.json to use, relative to the project. Defaults to the one in the project root, or the first one found.');

  server.registerTool(
    'check_roles',
    {
      title: 'Check roles (403 Forbidden)',
      description:
        'Follows every role that the CDS model checks (@requires, @restrict) to xs-security.json: scope, role template and role collection, ' +
        'including the values mta.yaml adds at deploy (parameters.config). Also checks user attributes ($user.x) and references XSUAA would reject. ' +
        'For apps using Identity Authentication with AMS, lists which DCL policies give each role instead. Read-only.',
      inputSchema: { path: projectPath, file: descriptorFile },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path: p, file }) =>
      guard(() => {
        const root = rootOf(p);
        const cds = scanCdsAuth(root);
        const ams = isAmsProject(root);
        const desc = pickDescriptor(root, file);
        if (!desc && !ams)
          return ok({
            cdsRoles: cds.roles.map((r) => r.role),
            cdsFilesScanned: cds.filesScanned,
            xsSecurity: null,
            note: cds.roles.length
              ? 'No xs-security.json found. Use add_missing_roles to create one with a scope and role template for every CDS role.'
              : 'No xs-security.json and no roles in @requires or @restrict.',
          });
        return ok({
          cdsFilesScanned: cds.filesScanned,
          otherDescriptors: findDescriptors(root).filter((f) => f !== desc).map((f) => path.relative(root, f)),
          xsSecurity: desc ? descriptorReport(root, desc) : null,
          ams: ams ? amsReport(root) : undefined,
        });
      }),
  );

  server.registerTool(
    'explain_token',
    {
      title: 'Explain a JWT',
      description:
        'Decodes a JWT locally (the signature is not verified) and explains it against this project: who it is for, expiry, ' +
        'which CDS roles it grants, whether it comes from another XSUAA instance, or for IAS/AMS which policies each role needs. ' +
        'Only use a token the user gave you. The token is not stored or sent anywhere. Read-only.',
      inputSchema: {
        path: projectPath,
        token: z.string().describe('The JWT, with or without "Bearer ".'),
        file: descriptorFile,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path: p, token, file }) =>
      guard(() => {
        const root = rootOf(p);
        const cds = scanCdsAuth(root);
        if (isAmsProject(root)) {
          const dclRoot = dclRootOf(new Project(root).cdsFor('production'));
          return ok({ mode: 'ams', ...analyzeIasToken(token, scanAms(root, dclRoot, false), cds) });
        }
        const desc = pickDescriptor(root, file);
        const d = effectiveDescriptor(desc ? fs.readFileSync(desc, 'utf8') : '{}', desc ? mtaBinding(root, desc)?.values : undefined);
        return ok({ mode: 'xsuaa', ...analyzeToken(token, d, cds) });
      }),
  );

  server.registerTool(
    'add_missing_roles',
    {
      title: 'Add missing roles to xs-security.json',
      description:
        'Adds a scope and role template for each CDS role that has none, keeping the file formatting. ' +
        'Creates xs-security.json from the CDS model when the project has none. Does not create role collections or assign users. ' +
        'With dryRun, only lists what would be added.',
      inputSchema: {
        path: projectPath,
        file: descriptorFile,
        roles: z.array(z.string()).optional().describe('Only these CDS roles. Default: every role without a scope or role template.'),
        dryRun: z.boolean().optional().describe('Only show what would change. Default false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ path: p, file, roles, dryRun }) =>
      guard(() => {
        const root = rootOf(p);
        const cds = scanCdsAuth(root);
        const desc = pickDescriptor(root, file);
        if (!desc) {
          const target = path.join(root, 'xs-security.json');
          const text = generateDescriptor(appName(root), cds);
          if (!dryRun) fs.writeFileSync(target, text);
          return ok({
            created: dryRun ? undefined : 'xs-security.json',
            wouldCreate: dryRun ? 'xs-security.json' : undefined,
            content: text,
            followUp: 'Reference it from the XSUAA resource in mta.yaml (parameters.path: ./xs-security.json), add role collections, and redeploy.',
          });
        }
        const before = fs.readFileSync(desc, 'utf8');
        const d = effectiveDescriptor(before, mtaBinding(root, desc)?.values);
        if (d.error) return fail(`${path.relative(root, desc)} is not valid JSON: ${d.error}`);
        const missing = roleStatus(d, cds)
          .filter((r) => !r.scope || !r.templates.length)
          .map((r) => r.role)
          .filter((r) => !roles || roles.includes(r));
        const unknown = (roles ?? []).filter((r) => !cds.roles.some((x) => x.role === r));
        let text = before;
        for (const role of missing) text = applyEdit(text, { kind: 'addRole', name: role });
        if (!dryRun && text !== before) fs.writeFileSync(desc, text);
        return ok({
          file: path.relative(root, desc),
          [dryRun ? 'wouldAdd' : 'added']: missing,
          unknownRoles: unknown.length ? unknown : undefined,
          followUp: missing.length
            ? 'Redeploy (or "cf update-service <xsuaa-instance> -c xs-security.json"), add the role templates to a role collection, assign it to users, and have them log in again.'
            : 'Nothing to add: every CDS role has a scope and a role template.',
        });
      }),
  );

  // ---------------- Connectivity Doctor: destinations ----------------

  const cfApp = z.string().describe('Name of the deployed Cloud Foundry app whose bindings are used, e.g. "bookshop-srv".');

  server.registerTool(
    'list_cf_apps',
    {
      title: 'List Cloud Foundry apps',
      description: 'Lists the apps in the space the local cf CLI targets, with their state. Read-only on Cloud Foundry.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guard(async () => {
        const t = cfTarget();
        return ok({ org: t.org, space: t.space, apps: (await listApps({ cfPath, cwd: opts.defaultRoot })).map((a) => ({ name: a.name, state: a.state })) });
      }),
  );

  server.registerTool(
    'check_destinations',
    {
      title: 'Check destinations of a deployed app',
      description:
        "Reads a deployed app's service bindings with the local cf CLI and checks every destination it can see, " +
        'the way the app would: Destination and Connectivity service bindings, destination configuration, authentication tokens ' +
        '(OAuth2, SAML, principal propagation), on-premise and Cloud Connector setup, and destinations the CAP project uses but that do not exist. ' +
        'Secrets in the configuration are masked. Read-only, but calls the Destination service API.',
      inputSchema: {
        app: cfApp,
        path: projectPath,
        destinations: z.array(z.string()).optional().describe('Only check these destination names.'),
        testCalls: z.boolean().optional().describe('Also send one GET to each reachable Internet destination that needs no user. Default false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ app, path: p, destinations, testCalls }) =>
      guard(async () => {
        const root = rootOf(p);
        const session = await ConnectivitySession.forApp(app, { cf: { cfPath, cwd: opts.defaultRoot }, projectRoot: root, only: destinations });
        if (testCalls) for (const d of session.report.destinations) if (d.callable && !d.userDependent) d.checks.push(await session.testCall(d.name));
        return ok(session.report);
      }),
  );

  server.registerTool(
    'test_destination_call',
    {
      title: 'Test a call through a destination',
      description:
        "Sends one GET request through a destination with the deployed app's credentials and explains the response " +
        '(status, redirects to a login page, wrong path, certificate and network errors). Only Internet destinations can be called from this machine. ' +
        'For destinations that need a user (OAuth2UserTokenExchange, SAML bearer, principal propagation), pass a user JWT the user gave you.',
      inputSchema: {
        app: cfApp,
        destination: z.string().describe('Destination name.'),
        requestPath: z.string().optional().describe('Path appended to the destination URL, e.g. "/$metadata". Default: the URL itself.'),
        userToken: z.string().optional().describe('A user JWT, only for user-dependent destinations.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ app, destination, requestPath, userToken }) =>
      guard(async () => {
        const session = await ConnectivitySession.forApp(app, { cf: { cfPath, cwd: opts.defaultRoot }, only: [destination] });
        const report = userToken ? await session.checkDestination(destination, userToken) : session.report.destinations.find((d) => d.name === destination);
        const call = await session.testCall(destination, { path: requestPath, userToken });
        return ok({ destination: report, call });
      }),
  );

  return server;
}
