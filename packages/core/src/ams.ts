import * as fs from 'fs';
import * as path from 'path';
import { blankComments, cdsFiles, closing } from './cds-roles';
import { lineAt } from './util';

/**
 * A reader for SAP Authorization Management Service (AMS) policies written in DCL,
 * as used by CAP projects with Identity Authentication (IAS). It is deliberately
 * lenient: anything it does not understand is skipped, because the DCL compiler
 * (@sap/ams-dev) reports syntax errors at build time. What it adds is the link
 * between policies and the CAP model, which the compiler does not check.
 */

export interface DclRef {
  /** Attribute path as written, without a leading "$app.". */
  path: string;
  line: number;
}

export interface DclRoleAssignment {
  role: string;
  line: number;
  /** The WHERE condition as written, if any. */
  condition?: string;
  attributes: DclRef[];
}

export interface DclUse {
  /** Policy reference as written, e.g. "cap.Reader" or "Reader". */
  ref: string;
  /** Fully qualified name it points to (package.Name). */
  target: string;
  line: number;
  restrict?: string;
  attributes: DclRef[];
}

export interface DclGrant {
  actions: string[];
  resources: string[];
  line: number;
  condition?: string;
  attributes: DclRef[];
}

export interface DclPolicy {
  name: string;
  /** Package: the folder below the DCL root, dot-separated ("" at the root). */
  pkg: string;
  qualified: string;
  kind: 'policy' | 'internal' | 'default';
  label?: string;
  description?: string;
  file: string;
  line: number;
  /** End of the policy block (line of the closing brace). */
  endLine: number;
  roles: DclRoleAssignment[];
  uses: DclUse[];
  /** GRANTs on resources other than $SCOPES (plain AMS, not CAP roles). */
  grants: DclGrant[];
}

export interface DclAttribute {
  /** Dotted path, e.g. "Genre" or "order.total". */
  path: string;
  type: string;
  line: number;
}

export interface AmsAttributeMapping {
  /** AMS attribute name, the key in @ams.attributes. */
  name: string;
  /** CDS element expression it maps to, as written. */
  element: string;
  file: string;
  line: number;
}

export interface AmsModel {
  /** DCL root, relative to the project root. */
  dclRoot: string;
  dclRootExists: boolean;
  files: string[];
  /** schema.dcl, relative to the project root, if it exists. */
  schemaFile?: string;
  schema: DclAttribute[];
  policies: DclPolicy[];
  /** @ams.attributes mappings found in .cds files. */
  mappings: AmsAttributeMapping[];
}

// ---------------- tokenizer ----------------

type Tok = { k: 'id' | 'qid' | 'str' | 'num' | 'p'; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') while (i < src.length && src[i] !== '\n') i++;
    else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"') {
      const start = i;
      let v = '';
      for (i++; i < src.length; i++) {
        if (src[i] === c && src[i + 1] === c) {
          v += c;
          i++;
        } else if (src[i] === c) break;
        else v += src[i];
      }
      i++;
      out.push({ k: c === "'" ? 'str' : 'qid', v, at: start });
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))![0];
      out.push({ k: 'id', v: m, at: i });
      i += m.length;
    } else if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))![0];
      out.push({ k: 'num', v: m, at: i });
      i += m.length;
    } else {
      const two = src.slice(i, i + 2);
      const p = ['<=', '>=', '<>', '!=', '[]'].includes(two) ? two : c;
      out.push({ k: 'p', v: p, at: i });
      i += p.length;
    }
  }
  return out;
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'IN', 'RESTRICTED', 'NULL', 'BETWEEN', 'LIKE', 'ESCAPE', 'TRUE', 'FALSE']);
const isName = (t?: Tok) => !!t && (t.k === 'id' || t.k === 'qid');
const kw = (t: Tok | undefined, word: string) => !!t && t.k === 'id' && t.v.toUpperCase() === word;

/** Attribute references in a condition: dotted names that are not keywords or function calls. */
function attributeRefs(toks: Tok[], src: string): DclRef[] {
  const out: DclRef[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!isName(t) || (t.k === 'id' && KEYWORDS.has(t.v.toUpperCase()))) continue;
    const parts = [t.v];
    let j = i;
    while (toks[j + 1]?.v === '.' && toks[j + 1].k === 'p' && isName(toks[j + 2])) {
      parts.push(toks[j + 2].v);
      j += 2;
    }
    const next = toks[j + 1];
    i = j;
    if (next?.k === 'p' && next.v === '(') continue; // function call
    if (parts[0] === '$app') parts.shift();
    if (parts.length) out.push({ path: parts.join('.'), line: lineAt(src, t.at) });
  }
  return out;
}

const text = (src: string, toks: Tok[]) => (toks.length ? src.slice(toks[0].at, endOf(toks[toks.length - 1], src)).replace(/\s+/g, ' ').trim() : '');
function endOf(t: Tok, src: string): number {
  if (t.k === 'str' || t.k === 'qid') {
    // find the closing quote after the token start
    const q = src[t.at];
    let i = t.at + 1;
    for (; i < src.length; i++) {
      if (src[i] === q && src[i + 1] === q) i++;
      else if (src[i] === q) break;
    }
    return i + 1;
  }
  return t.at + t.v.length;
}

// ---------------- parser ----------------

interface ParsedFile {
  policies: Omit<DclPolicy, 'file' | 'pkg' | 'qualified'>[];
  schema: DclAttribute[];
  hasSchema: boolean;
}

/** Parses one DCL file. Unknown constructs are skipped. */
export function parseDcl(src: string): ParsedFile {
  const toks = tokenize(src);
  const policies: ParsedFile['policies'] = [];
  const schema: DclAttribute[] = [];
  let hasSchema = false;
  let i = 0;
  const skipBalanced = (open: number): number => {
    const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
    const stack: string[] = [];
    for (let j = open; j < toks.length; j++) {
      const t = toks[j];
      if (t.k !== 'p') continue;
      if (pairs[t.v]) stack.push(pairs[t.v]);
      else if (t.v === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) return j;
      }
    }
    return toks.length - 1;
  };
  /** Reads "@a.b: value" annotations; returns them and the index after. */
  const annotations = (j: number) => {
    const ann: Record<string, string> = {};
    while (toks[j]?.k === 'p' && toks[j].v === '@') {
      j++;
      const key: string[] = [];
      while (isName(toks[j])) {
        key.push(toks[j].v);
        if (toks[j + 1]?.v === '.') j += 2;
        else {
          j++;
          break;
        }
      }
      if (toks[j]?.v === ':') j++;
      const v = toks[j];
      if (v && v.k === 'p' && (v.v === '{' || v.v === '[')) j = skipBalanced(j) + 1;
      else if (v) {
        if (v.k === 'str') ann[key.join('.')] = v.v;
        j++;
      }
    }
    return { ann, j };
  };

  const schemaFields = (j: number, prefix: string): number => {
    // j points at "{"
    j++;
    while (j < toks.length && !(toks[j].k === 'p' && toks[j].v === '}')) {
      j = annotations(j).j;
      const name = toks[j];
      if (!isName(name) || toks[j + 1]?.v !== ':') {
        j++;
        continue;
      }
      const type = toks[j + 2];
      if (type?.k === 'p' && type.v === '{') {
        j = schemaFields(j + 2, `${prefix}${name.v}.`) + 1;
      } else {
        let t = type?.v ?? '';
        j += 3;
        if (toks[j]?.v === '[]') {
          t += '[]';
          j++;
        } else if (toks[j]?.v === '[' && toks[j + 1]?.v === ']') {
          t += '[]';
          j += 2;
        }
        schema.push({ path: prefix + name.v, type: t, line: lineAt(src, name.at) });
      }
      if (toks[j]?.v === ',') j++;
    }
    return j;
  };

  while (i < toks.length) {
    const a = annotations(i);
    i = a.j;
    const t = toks[i];
    if (!t) break;
    if (kw(t, 'SCHEMA') && toks[i + 1]?.v === '{') {
      hasSchema = true;
      i = schemaFields(i + 1, '') + 1;
      continue;
    }
    let kind: DclPolicy['kind'] = 'policy';
    let k = i;
    if (kw(t, 'INTERNAL') || kw(t, 'DEFAULT')) {
      kind = kw(t, 'INTERNAL') ? 'internal' : 'default';
      k++;
    }
    if (kw(toks[k], 'POLICY') && isName(toks[k + 1]) && toks[k + 2]?.v === '{') {
      const nameTok = toks[k + 1];
      const open = k + 2;
      const close = skipBalanced(open);
      const policy: ParsedFile['policies'][number] = {
        name: nameTok.v,
        kind,
        label: a.ann.label,
        description: a.ann.description,
        line: lineAt(src, toks[k].at),
        endLine: lineAt(src, toks[close]?.at ?? src.length),
        roles: [],
        uses: [],
        grants: [],
      };
      // statements separated by ";"
      let s = open + 1;
      while (s < close) {
        s = annotations(s).j;
        let e = s;
        while (e < close && !(toks[e].k === 'p' && toks[e].v === ';')) e++;
        const st = toks.slice(s, e);
        if (st.length) statement(st, policy);
        s = e + 1;
      }
      policies.push(policy);
      i = close + 1;
      continue;
    }
    // Anything else (FUNCTION, TEST, ...): skip one block or statement.
    let j = i;
    while (j < toks.length && !(toks[j].k === 'p' && (toks[j].v === ';' || toks[j].v === '{'))) j++;
    i = toks[j]?.v === '{' ? skipBalanced(j) + 1 : j + 1;
  }
  return { policies, schema, hasSchema };

  function statement(st: Tok[], policy: ParsedFile['policies'][number]) {
    const line = lineAt(src, st[0].at);
    const whereAt = st.findIndex((x) => kw(x, 'WHERE'));
    const cond = whereAt >= 0 ? st.slice(whereAt + 1) : [];
    if (kw(st[0], 'ASSIGN') && kw(st[1], 'ROLE')) {
      const names = st.slice(2, whereAt >= 0 ? whereAt : st.length).filter(isName);
      for (const n of names)
        policy.roles.push({ role: n.v, line: lineAt(src, n.at), condition: cond.length ? text(src, cond) : undefined, attributes: attributeRefs(cond, src) });
    } else if (kw(st[0], 'GRANT')) {
      const onAt = st.findIndex((x) => kw(x, 'ON'));
      const end = whereAt >= 0 ? whereAt : st.length;
      const actions = st.slice(1, onAt >= 0 ? onAt : end).filter(isName);
      const resources = onAt >= 0 ? st.slice(onAt + 1, end).filter(isName).map((x) => x.v) : [];
      const attributes = attributeRefs(cond, src);
      const condition = cond.length ? text(src, cond) : undefined;
      if (resources.includes('$SCOPES')) {
        for (const n of actions) policy.roles.push({ role: n.v, line: lineAt(src, n.at), condition, attributes });
      }
      const other = resources.filter((r) => r !== '$SCOPES');
      if (other.length) policy.grants.push({ actions: actions.map((x) => x.v), resources: other, line, condition, attributes });
    } else if (kw(st[0], 'USE')) {
      const parts: string[] = [];
      let j = 1;
      while (isName(st[j])) {
        parts.push(st[j].v);
        if (st[j + 1]?.v === '.') j += 2;
        else {
          j++;
          break;
        }
      }
      const rAt = st.findIndex((x) => kw(x, 'RESTRICT'));
      const r = rAt >= 0 ? st.slice(rAt + 1) : [];
      if (parts.length) policy.uses.push({ ref: parts.join('.'), target: '', line, restrict: r.length ? text(src, r) : undefined, attributes: attributeRefs(r, src) });
    }
  }
}

// ---------------- project ----------------

/** DCL files below a folder, sorted. */
function dclFiles(abs: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.dcl')) out.push(p);
    }
  };
  walk(abs, 0);
  return out.sort();
}

/** @ams.attributes: { Name: (element), ... } and @ams.attributes.Name: (element) in .cds files. */
export function scanAmsMappings(root: string): AmsAttributeMapping[] {
  const out: AmsAttributeMapping[] = [];
  for (const abs of cdsFiles(root)) {
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes('ams.attributes')) continue;
    const src = blankComments(raw);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    for (const m of src.matchAll(/\bams\.attributes\s*:\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const end = closing(src, open);
      const body = src.slice(open + 1, end);
      // top-level "Name: value" entries
      let depth = 0;
      let start = 0;
      const entries: { s: string; at: number }[] = [];
      for (let i = 0; i <= body.length; i++) {
        const c = body[i];
        if (c === "'" || c === '"') {
          for (i++; i < body.length && body[i] !== c; i++);
          continue;
        }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if ((c === ',' && depth === 0) || i === body.length) {
          entries.push({ s: body.slice(start, i), at: open + 1 + start });
          start = i + 1;
        }
      }
      for (const e of entries) {
        const em = /^(\s*)("?)([A-Za-z_$][\w$]*)\2\s*:\s*([\s\S]*?)\s*$/.exec(e.s);
        if (em) out.push({ name: em[3], element: em[4].replace(/^\(\s*|\s*\)$/g, ''), file: rel, line: lineAt(src, e.at + em[1].length) });
      }
    }
    for (const m of src.matchAll(/@\s*ams\.attributes\.([A-Za-z_$][\w$]*)\s*:\s*(\([^)]*\)|[^,;\n]+)/g)) {
      out.push({ name: m[1], element: m[2].trim().replace(/^\(\s*|\s*\)$/g, ''), file: rel, line: lineAt(src, m.index ?? 0) });
    }
  }
  return out;
}

/** The DCL root CAP uses: cds.requires.auth.ams.dclRoot, else ams/dcl. */
export function dclRootOf(cds: any): string {
  const auth = cds?.requires?.auth;
  const ams = (auth && typeof auth === 'object' ? auth.ams : undefined) ?? cds?.requires?.ams;
  const v = ams && typeof ams === 'object' ? ams.dclRoot : undefined;
  return typeof v === 'string' && v.trim() ? v.replace(/^\.\//, '').replace(/\/$/, '') : 'ams/dcl';
}

/** Reads every DCL file below `dclRoot` (relative to root) and the CDS attribute mappings. */
export function scanAms(root: string, dclRoot = 'ams/dcl', withMappings = true): AmsModel {
  const absRoot = path.resolve(root, dclRoot);
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const files = dclFiles(absRoot);
  const policies: DclPolicy[] = [];
  let schema: DclAttribute[] = [];
  let schemaFile: string | undefined;
  for (const abs of files) {
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDcl(src);
    const pkg = path.relative(absRoot, path.dirname(abs)).split(path.sep).filter(Boolean).join('.');
    if (parsed.hasSchema && !pkg) {
      schemaFile = rel(abs);
      schema = parsed.schema;
    }
    for (const p of parsed.policies) {
      const qualified = pkg ? `${pkg}.${p.name}` : p.name;
      policies.push({ ...p, pkg, qualified, file: rel(abs) });
    }
  }
  const known = new Set(policies.map((p) => p.qualified));
  for (const p of policies)
    for (const u of p.uses) {
      // "Reader" first means the same package; a dotted name is fully qualified.
      const local = p.pkg ? `${p.pkg}.${u.ref}` : u.ref;
      u.target = known.has(local) || !u.ref.includes('.') ? local : u.ref;
    }
  return {
    dclRoot,
    dclRootExists: fs.existsSync(absRoot),
    files: files.map(rel),
    schemaFile,
    schema,
    policies,
    mappings: withMappings ? scanAmsMappings(root) : [],
  };
}

/** Policies that give a role: directly (ASSIGN ROLE / GRANT ON $SCOPES) or by USE of such a policy. */
export function policiesForRole(model: AmsModel, role: string): { direct: DclPolicy[]; derived: DclPolicy[] } {
  const direct = model.policies.filter((p) => p.roles.some((r) => r.role === role));
  const derived: DclPolicy[] = [];
  const seen = new Set(direct.map((p) => p.qualified));
  let frontier = [...seen];
  while (frontier.length) {
    const next: string[] = [];
    for (const p of model.policies)
      if (!seen.has(p.qualified) && p.uses.some((u) => frontier.includes(u.target))) {
        seen.add(p.qualified);
        derived.push(p);
        next.push(p.qualified);
      }
    frontier = next;
  }
  return { direct, derived };
}

/** Text that adds a base policy for a role, in the style "cds build" generates. */
export function policyText(role: string): string {
  const q = `"${role.replace(/"/g, '""')}"`;
  return `POLICY ${q} {\n  ASSIGN ROLE ${q};\n}\n`;
}
