#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { CfError, fetchAppLogs, fetchMtaOperationLogs } from './cf';
import { runChecks } from './check';
import { autoFixable, fixAll } from './fix/apply';
import { checkToJson, formatCheck, formatDiagnose, formatFixDryRun, formatFixResult } from './format';
import { analyzeLog } from './logs/analyze';
import { ConnectivitySession } from './connectivity/diagnose';
import { formatConnectivity } from './connectivity/format';

const HELP = `btp-doctor – find and explain SAP BTP / CAP deployment problems

Usage:
  btp-doctor check [dir]                Check mta.yaml and CAP config before deploying
  btp-doctor fix [dir] [--dry-run]      Apply every fix that needs no choice (or preview them)
  btp-doctor diagnose <logfile>         Explain a saved deploy or app log
  btp-doctor diagnose --app <name>      Fetch and explain "cf logs <name> --recent"
  btp-doctor diagnose --mta-op <id>     Fetch and explain "cf dmol -i <id>"
  cf deploy ... 2>&1 | btp-doctor diagnose   Explain piped output
  btp-doctor connectivity --app <name> [dir]  Check a deployed app's destinations (uses your cf login)

Options:
  --json           Machine-readable output
  --dry-run        With fix: show the changes without writing them
  --destination <name>  With connectivity: check only this destination (repeatable)
  --test-call      With connectivity: also call Internet destinations from this machine
  --cf <path>      Path to the cf CLI (default: cf)
  --no-color       Disable colors
  -h, --help       Show this help
  -v, --version    Show version

Exit codes: check and connectivity exit 1 when errors are found. diagnose exits 1 when a known problem is found.`;

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      app: { type: 'string' },
      'mta-op': { type: 'string' },
      destination: { type: 'string', multiple: true },
      'test-call': { type: 'boolean' },
      cf: { type: 'string' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    console.log(version());
    return 0;
  }
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd || values.help ? 0 : 2;
  }
  const color = !values['no-color'] && !values.json && !!process.stdout.isTTY && !process.env.NO_COLOR;

  if (cmd === 'check') {
    const result = runChecks(arg ?? process.cwd());
    console.log(values.json ? JSON.stringify(checkToJson(result), null, 2) : formatCheck(result, { color }));
    return result.summary.error > 0 ? 1 : 0;
  }

  if (cmd === 'fix') {
    const root = path.resolve(arg ?? process.cwd());
    if (values['dry-run']) {
      const fixable = autoFixable(runChecks(root).findings);
      console.log(values.json ? JSON.stringify(fixable.map((f) => ({ ruleId: f.ruleId, title: f.fixes![0].title, changes: f.fixes![0].changes })), null, 2) : formatFixDryRun(fixable, { color }));
      return 0;
    }
    const { applied, remaining } = await fixAll(root);
    console.log(values.json ? JSON.stringify({ applied, remaining: checkToJson(remaining) }, null, 2) : formatFixResult(applied, remaining, { color }));
    return remaining.summary.error > 0 ? 1 : 0;
  }

  if (cmd === 'diagnose') {
    const cfOpts = { cfPath: values.cf };
    let text: string;
    if (values.app) text = await fetchAppLogs(values.app, cfOpts);
    else if (values['mta-op']) text = await fetchMtaOperationLogs(values['mta-op'], cfOpts);
    else if (arg) text = fs.readFileSync(arg, 'utf8');
    else if (!process.stdin.isTTY) text = await readStdin();
    else {
      console.error('diagnose needs a log file, --app, --mta-op or piped input.\n\n' + HELP);
      return 2;
    }
    const result = analyzeLog(text);
    console.log(values.json ? JSON.stringify(result, null, 2) : formatDiagnose(result, { color }));
    return result.matches.length > 0 ? 1 : 0;
  }

  if (cmd === 'connectivity') {
    if (!values.app) {
      console.error('connectivity needs --app <name> (a deployed app in the targeted space).\n\n' + HELP);
      return 2;
    }
    const root = path.resolve(arg ?? process.cwd());
    const session = await ConnectivitySession.forApp(values.app, { cf: { cfPath: values.cf }, projectRoot: root, only: values.destination });
    if (values['test-call']) {
      for (const d of session.report.destinations) if (d.callable && !d.userDependent) d.checks.push(await session.testCall(d.name));
    }
    console.log(values.json ? JSON.stringify(session.report, null, 2) : formatConnectivity(session.report, { color }));
    return session.report.status === 'error' || session.report.destinations.some((d) => d.checks.some((k) => k.status === 'error')) ? 1 : 0;
  }

  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(err instanceof CfError ? err.message : err?.stack ?? String(err));
    process.exitCode = 2;
  },
);
