import * as fs from 'fs';
import * as path from 'path';
import { runChecks } from '../check';
import { CheckResult, Finding, Fix } from '../types';

export class StaleFixError extends Error {}

function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`Refusing to write outside the project: ${rel}`);
  return abs;
}

/** Writes a fix to disk. Throws StaleFixError if a file changed since the fix was computed. */
export function applyFixToDisk(root: string, fix: Fix): void {
  const targets = fix.changes.map((c) => ({ c, abs: resolveInside(root, c.file) }));
  for (const { c, abs } of targets) {
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current !== c.before) throw new StaleFixError(`${c.file} changed since the fix was computed. Run the check again.`);
  }
  for (const { c, abs } of targets) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c.after);
  }
}

export interface AppliedFix {
  ruleId: string;
  finding: string;
  fix: string;
  files: string[];
  followUp?: string;
}

const findingKey = (f: Finding) => `${f.ruleId}|${f.title}|${f.message}`;

/** Findings that fix-all would handle: exactly one fix, so no choice is needed. */
export const autoFixable = (findings: Finding[]) => findings.filter((f) => f.fixes?.length === 1 && !f.fixes[0].requiresReview);

/**
 * Applies every unambiguous fix, one at a time, re-checking after each so that
 * fixes never work from stale file contents.
 */
export async function fixAll(
  root: string,
  opts: { apply?: (root: string, fix: Fix) => void | Promise<void>; maxSteps?: number } = {},
): Promise<{ applied: AppliedFix[]; remaining: CheckResult }> {
  const apply = opts.apply ?? applyFixToDisk;
  const attempted = new Set<string>();
  const applied: AppliedFix[] = [];
  for (let step = 0; step < (opts.maxSteps ?? 100); step++) {
    const next = autoFixable(runChecks(root).findings).find((f) => !attempted.has(findingKey(f)));
    if (!next) break;
    attempted.add(findingKey(next));
    const fix = next.fixes![0];
    await apply(root, fix);
    applied.push({ ruleId: next.ruleId, finding: next.title, fix: fix.title, files: fix.changes.map((c) => c.file), followUp: fix.followUp });
  }
  return { applied, remaining: runChecks(root) };
}
