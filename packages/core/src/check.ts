import { Project } from './project';
import { cdsRules } from './rules/cds';
import { crossRules } from './rules/cross';
import { fioriRules } from './rules/fiori';
import { mtaRules } from './rules/mta';
import { mtxRules } from './rules/mtx';
import { repoRules } from './rules/repo';
import { CheckResult, Finding, Severity } from './types';

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Runs every static check on the project in `root`. */
export function runChecks(root: string): CheckResult {
  const p = new Project(root);
  const findings: Finding[] = [];
  if (!p.mta && !p.packageJson) {
    findings.push({
      ruleId: 'GEN001',
      severity: 'info',
      title: 'Nothing to check',
      message: 'No mta.yaml or package.json was found in this folder.',
      fix: 'Run the check in the root folder of your CAP or MTA project.',
      location: { file: '.' },
    });
  } else {
    findings.push(...mtaRules(p), ...cdsRules(p), ...crossRules(p), ...fioriRules(p), ...mtxRules(p), ...repoRules(p));
  }
  findings.sort(
    (a, b) =>
      ORDER[a.severity] - ORDER[b.severity] ||
      a.location.file.localeCompare(b.location.file) ||
      (a.location.line ?? 0) - (b.location.line ?? 0),
  );
  const summary: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return { root: p.root, findings, summary };
}
