import { Project } from '../project';
import { appendLines } from '../fix/edit';
import { Finding } from '../types';

const SECRET_FILES = ['.cdsrc-private.json', 'default-env.json', '.env'];

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

function isIgnored(lines: string[], name: string): boolean {
  let ignored = false;
  for (const raw of lines) {
    let l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const negate = l.startsWith('!');
    if (negate) l = l.slice(1);
    l = l.replace(/^\/|^\*\*\//, '').replace(/\/$/, '');
    if (globToRegExp(l).test(name)) ignored = !negate;
  }
  return ignored;
}

/** Repository hygiene checks: credentials that would be committed. */
export function repoRules(p: Project): Finding[] {
  const gitignore = p.readText('.gitignore');
  if (gitignore === undefined && !p.exists('.git')) return []; // not a git project
  const lines = (gitignore ?? '').split(/\r?\n/);
  const out: Finding[] = [];
  for (const f of SECRET_FILES) {
    if (!p.exists(f) || isIgnored(lines, f)) continue;
    out.push({
      ruleId: 'REPO001',
      severity: 'warning',
      title: `${f} is not git-ignored`,
      message: `${f} usually holds service keys or passwords (for example from "cds bind" or "cf env"). It would be committed with the rest of the project.`,
      fix: `Add "${f}" to .gitignore. If it was already committed, rotate the credentials it contains.`,
      location: { file: gitignore !== undefined ? '.gitignore' : f, line: 1 },
      fixes: [{ title: `Add ${f} to .gitignore`, changes: [appendLines(p, '.gitignore', [f])] }],
    });
  }
  return out;
}
