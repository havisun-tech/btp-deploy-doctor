import { Project } from './project';
import { amsRules } from './rules/ams';
import { authRules } from './rules/auth';
import { cdsRules } from './rules/cds';
import { crossRules } from './rules/cross';
import { fioriRules } from './rules/fiori';
import { mtaRules } from './rules/mta';
import { mtxRules } from './rules/mtx';
import { isNeoMta } from './rules/mta-model';
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
  } else if (p.mta && isNeoMta(p)) {
    findings.push({
      ruleId: 'GEN002',
      severity: 'info',
      title: 'Neo MTA not checked',
      message: `${p.mta.rel} is written for the SAP BTP Neo environment, which SAP has retired. Deploy Doctor only checks Cloud Foundry deployments.`,
      fix: 'Migrate the app to Cloud Foundry, for example with the SAP Fiori tools Neo migration, then check the result.',
      location: { file: p.mta.rel, line: 1 },
    });
    findings.push(...repoRules(p));
  } else {
    findings.push(...mtaRules(p), ...cdsRules(p), ...crossRules(p), ...fioriRules(p), ...mtxRules(p), ...authRules(p), ...amsRules(p), ...repoRules(p));
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
