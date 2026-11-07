import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  analyzeLog,
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

const VERSION = '0.1.0';

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

export function createServer(opts: ServerOptions = {}): McpServer {
  const cfPath = opts.cfPath ?? process.env.BTP_DOCTOR_CF ?? 'cf';
  const rootOf = (p?: string) => {
    const root = path.resolve(opts.defaultRoot ?? process.cwd(), p ?? '.');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    return root;
  };

  const server = new McpServer(
    { name: 'btp-deploy-doctor', version: VERSION },
    {
      instructions:
        'Checks SAP BTP Cloud Foundry projects (CAP, MTA, Fiori, multitenant) for deployment problems and explains failed deploy logs. ' +
        'Typical flow: check_project, then preview_fix and apply_fix for individual findings, or fix_all for every fix that needs no choice. ' +
        'Findings with several fixes are alternatives; ask the user which one to apply. Fixes marked requiresReview must be shown to the user first. ' +
        'For a failed "cf deploy", use diagnose_log with the output, or diagnose_mta_operation with the operation ID the log mentions.',
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

  return server;
}
