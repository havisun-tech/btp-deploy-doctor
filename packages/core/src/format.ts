import { changedRegion } from './fix/edit';
import { AppliedFix, autoFixable } from './fix/apply';
import { DiagnoseResult } from './logs/analyze';
import { CheckResult, Finding, Fix, Severity } from './types';

export interface FormatOptions {
  color?: boolean;
}

function palette(on: boolean) {
  const wrap = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap(31), yellow: wrap(33), cyan: wrap(36), dim: wrap(2), bold: wrap(1), green: wrap(32) };
}

const indent = (s: string, pad: string) => s.split('\n').join(`\n${pad}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatCheck(r: CheckResult, opts: FormatOptions = {}): string {
  const c = palette(!!opts.color);
  const icon: Record<Severity, string> = { error: c.red('✖ error  '), warning: c.yellow('▲ warning'), info: c.cyan('● info   ') };
  const out: string[] = [c.bold(`BTP Deploy Doctor: ${r.root}`), ''];
  const pad = ' '.repeat(13);
  for (const f of r.findings) {
    const where = `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}`;
    out.push(`${icon[f.severity]}  ${c.bold(f.title)}  ${c.dim(`${f.ruleId} ${where}`)}`);
    out.push(`${pad}${indent(f.message, pad)}`);
    if (f.fix) out.push(`${pad}${c.green('Fix:')} ${indent(f.fix, pad + '     ')}`);
    for (const x of f.fixes ?? []) out.push(`${pad}${c.cyan(x.requiresReview ? 'Quick fix (review first):' : 'Auto-fix:')} ${x.title}`);
    out.push('');
  }
  const { error, warning, info } = r.summary;
  if (!r.findings.length) out.push(c.green('No problems found.'));
  else {
    out.push(`${plural(error, 'error')}, ${plural(warning, 'warning')}, ${info} info`);
    const auto = autoFixable(r.findings).length;
    if (auto) out.push(c.dim(`${auto} can be fixed automatically: btp-doctor fix${r.root === process.cwd() ? '' : ` ${r.root}`}`));
  }
  return out.join('\n');
}

export function formatDiagnose(r: DiagnoseResult, opts: FormatOptions = {}): string {
  const c = palette(!!opts.color);
  const out: string[] = [];
  out.push(
    r.matches.length
      ? c.bold(`Found ${plural(r.matches.length, 'known problem')} in ${r.totalLines} log lines`)
      : c.bold(`No known problem found in ${r.totalLines} log lines`),
    '',
  );
  const pad = '   ';
  r.matches.forEach((m, i) => {
    out.push(`${c.red(`${i + 1}.`)} ${c.bold(m.title)}  ${c.dim(`line ${m.line}${m.count > 1 ? `, ${m.count}×` : ''} · ${m.patternId}`)}`);
    out.push(`${pad}${c.dim('> ' + m.text)}`);
    out.push(`${pad}${m.explanation}`);
    out.push(`${pad}${c.green('Fix:')} ${m.fix}`);
    out.push('');
  });
  if (r.operationIds.length) {
    out.push(c.bold('MTA deploy operations mentioned in this log:'));
    for (const id of r.operationIds) out.push(`${pad}btp-doctor diagnose --mta-op ${id}`);
    out.push('');
  }
  if (r.otherErrors.length) {
    out.push(c.bold(r.matches.length ? 'Other error lines:' : 'Error lines worth reading:'));
    for (const e of r.otherErrors) out.push(`${pad}${c.dim(`${e.line}:`)} ${e.text}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Check result for --json: fixes are listed by title, without file contents. */
export function checkToJson(r: CheckResult): unknown {
  return {
    ...r,
    findings: r.findings.map((f) => ({
      ...f,
      fixes: f.fixes?.map((x) => ({ title: x.title, files: x.changes.map((c) => c.file), followUp: x.followUp })),
    })),
  };
}

/** Diff-style preview of a fix. */
export function formatFixPreview(fix: Fix, opts: FormatOptions = {}): string {
  const c = palette(!!opts.color);
  const out: string[] = [];
  for (const ch of fix.changes) {
    if (ch.before === null) {
      out.push(c.bold(`+++ ${ch.file} (new file)`));
      for (const l of ch.after.replace(/\n$/, '').split('\n')) out.push(c.green(`+ ${l}`));
      continue;
    }
    const { startLine, endLine, newLines } = changedRegion(ch.before, ch.after);
    out.push(c.bold(`--- ${ch.file}:${startLine + 1}`));
    for (const l of ch.before.split('\n').slice(startLine, endLine)) out.push(c.red(`- ${l}`));
    for (const l of newLines) out.push(c.green(`+ ${l}`));
  }
  return out.join('\n');
}

export function formatFixDryRun(findings: Finding[], opts: FormatOptions = {}): string {
  const c = palette(!!opts.color);
  if (!findings.length) return 'Nothing to fix automatically.\n';
  const out = [c.bold(`Would apply ${findings.length} fix${findings.length === 1 ? '' : 'es'}:`), ''];
  for (const f of findings) {
    out.push(`${c.cyan(f.ruleId)} ${f.fixes![0].title}`);
    out.push(indent(formatFixPreview(f.fixes![0], opts), '    ').replace(/^/, '    '));
    out.push('');
  }
  out.push(c.dim('Fixes are applied one at a time and the project is re-checked after each, so later fixes may differ slightly from this preview.'));
  return out.join('\n') + '\n';
}

export function formatFixResult(applied: AppliedFix[], remaining: CheckResult, opts: FormatOptions = {}): string {
  const c = palette(!!opts.color);
  const out: string[] = [];
  if (!applied.length) out.push('Nothing to fix automatically.');
  for (const a of applied) out.push(`${c.green('✔')} ${a.fix}  ${c.dim(`${a.ruleId} · ${a.files.join(', ')}`)}`);
  const followUps = [...new Set(applied.map((a) => a.followUp).filter(Boolean))];
  if (followUps.length) {
    out.push('', c.bold('Next:'));
    for (const fu of followUps) out.push(`  ${fu}`);
  }
  const { error, warning, info } = remaining.summary;
  const left = remaining.findings.filter((f) => f.ruleId !== 'GEN001').length;
  out.push('', left ? `Remaining: ${plural(error, 'error')}, ${plural(warning, 'warning')}, ${info} info. Run "btp-doctor check" for details.` : c.green('No problems left.'));
  return out.join('\n') + '\n';
}
