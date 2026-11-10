import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class CfError extends Error {}

export interface CfOptions {
  /** Path to the cf executable. Defaults to "cf". */
  cfPath?: string;
  cwd?: string;
}

function assertArg(value: string, what: string) {
  if (!value || value.startsWith('-') || /\s/.test(value)) throw new CfError(`Invalid ${what}: "${value}"`);
}

export function runCf(args: string[], opts: CfOptions): Promise<string> {
  const cf = opts.cfPath || 'cf';
  return new Promise((resolve, reject) => {
    execFile(cf, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stderr ? `${stdout}\n${stderr}` : stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new CfError(`Cloud Foundry CLI ("${cf}") not found. Install it, or analyze a saved log file instead.`));
      }
      const detail = `${stdout}\n${stderr}`.trim() || err.message;
      reject(new CfError(`"cf ${args.join(' ')}" failed: ${detail}`));
    });
  });
}

/** Recent logs of one Cloud Foundry app ("cf logs <app> --recent"). */
export function fetchAppLogs(app: string, opts: CfOptions = {}): Promise<string> {
  assertArg(app, 'app name');
  return runCf(['logs', app, '--recent'], opts);
}

/** All logs of one MTA deploy operation ("cf dmol -i <id>"), concatenated. */
export async function fetchMtaOperationLogs(operationId: string, opts: CfOptions = {}): Promise<string> {
  assertArg(operationId, 'operation ID');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-'));
  try {
    await runCf(['dmol', '-i', operationId, '-d', dir], opts);
    const parts: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else parts.push(`==> ${path.relative(dir, full)} <==\n${fs.readFileSync(full, 'utf8')}`);
      }
    };
    walk(dir);
    if (!parts.length) throw new CfError(`No logs were downloaded for operation ${operationId}.`);
    return parts.join('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
