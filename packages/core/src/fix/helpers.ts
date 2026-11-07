import { Document } from 'yaml';
import { Project } from '../project';
import { FileChange, Finding, Fix } from '../types';
import { JsonOp, editJson, editYaml } from './edit';

export const NPM_INSTALL = 'Run "npm install" so package-lock.json matches package.json.';

export function yamlFix(p: Project, title: string, mutate: (doc: Document) => void | false): Fix | undefined {
  const c = editYaml(p, mutate);
  return c ? { title, changes: [c] } : undefined;
}

export function jsonFix(p: Project, rel: string, title: string, ops: JsonOp[], followUp?: string): Fix | undefined {
  const c = editJson(p, rel, ops);
  return c ? { title, changes: [c], followUp } : undefined;
}

export function combine(title: string, changes: (FileChange | undefined)[], followUp?: string): Fix | undefined {
  const list = changes.filter((c): c is FileChange => !!c);
  return list.length ? { title, changes: list, followUp } : undefined;
}

export function attach(f: Finding, ...fixes: (Fix | undefined)[]): Finding {
  const list = fixes.filter((x): x is Fix => !!x);
  if (list.length) f.fixes = [...(f.fixes ?? []), ...list];
  return f;
}

/** "^9.1.0" -> "^9" */
export function majorRange(range: string | undefined): string | undefined {
  const m = /(\d+)/.exec(range ?? '');
  return m ? `^${m[1]}` : undefined;
}
