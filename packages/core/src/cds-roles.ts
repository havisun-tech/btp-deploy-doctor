import * as fs from 'fs';
import * as path from 'path';
import { lineAt } from './util';

/** CAP pseudo roles: granted by CAP itself, never defined in xs-security.json. */
export const PSEUDO_ROLES = new Set(['any', 'authenticated-user', 'identified-user', 'system-user', 'internal-user']);
/** $user properties CAP fills itself, not from XSUAA attributes. */
const BUILTIN_USER_PROPS = new Set(['id', 'locale', 'tenant', 'is', 'attr', 'roles', 'name']);
/** $user.<name>, also $user.attr.<name> (CAP Java style). */
const USER_ATTR = /\$user\.(?:attr\.)?([A-Za-z_]\w*)/g;

export interface RoleUse {
  role: string;
  file: string;
  line: number;
}

/** One @restrict entry: who it is granted to, and which user attributes its where condition reads. */
export interface CdsGrant {
  roles: string[];
  attributes: string[];
}

/** XSUAA role template and attribute names allow only letters, digits and "_" (max 64). */
export const templateNameFor = (role: string) => role.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'Role';

export interface CdsAuth {
  /** Roles from @requires and @restrict "to", first use of each. */
  roles: RoleUse[];
  /** User attributes the model reads as $user.<name>: in @restrict "where" conditions, view and projection "where" clauses, or anywhere else. */
  attributes: RoleUse[];
  grants: CdsGrant[];
  filesScanned: number;
}

const SKIP_DIRS = new Set(['node_modules', 'gen', 'dist', 'mta_archives', 'resources', 'target', 'coverage', 'test', 'tests']);
const MAX_FILES = 1500;

/** .cds files of a project, skipping build output, dependencies and tests. */
export function cdsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.cds') && out.length < MAX_FILES) {
        out.push(abs);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Replaces comments with spaces (keeping offsets and line breaks), so later regexes
 * never match inside them. Strings and quoted identifiers are left intact.
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      // CDS escapes a quote by doubling it: 'it''s'
      i++;
      while (i < src.length) {
        if (src[i] === c && src[i + 1] === c) i += 2;
        else if (src[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) out[i] = out[i + 1] = ' ';
      i += 2;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open`, skipping strings. */
export function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { '[': ']', '{': '}', '(': ')' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++);
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return src.length;
}

/** String literals in a value: 'a' or ['a', 'b']. Returns each with its offset. */
function stringsIn(value: string, base: number): { s: string; at: number }[] {
  return [...value.matchAll(/'((?:[^']|'')*)'/g)].map((m) => ({ s: m[1].replace(/''/g, "'"), at: base + (m.index ?? 0) }));
}

/** Reads the roles and user attributes a CAP model uses for authorization. */
export function scanCdsAuth(root: string): CdsAuth {
  const roles = new Map<string, RoleUse>();
  const attributes = new Map<string, RoleUse>();
  const grants: CdsGrant[] = [];
  const files = cdsFiles(root);
  for (const abs of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!/requires|restrict|\$user\./.test(raw)) continue;
    const src = blankComments(raw);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const addRole = (s: string, at: number) => {
      const role = s.trim();
      if (!role || PSEUDO_ROLES.has(role) || roles.has(role)) return;
      roles.set(role, { role, file: rel, line: lineAt(src, at) });
    };
    const addAttr = (name: string, at: number) => {
      if (BUILTIN_USER_PROPS.has(name) || attributes.has(name)) return;
      attributes.set(name, { role: name, file: rel, line: lineAt(src, at) });
    };

    // @requires: 'X'   @requires: ['X', 'Y']   @(requires: ..., ...)
    for (const m of src.matchAll(/\brequires\s*:\s*/g)) {
      const start = (m.index ?? 0) + m[0].length;
      const before = src.slice(Math.max(0, (m.index ?? 0) - 200), m.index);
      // Only inside an annotation: "@requires" or a key in an "@( ... )" block.
      if (!/@\s*$/.test(before) && !/@\s*\([^)]*$/.test(before)) continue;
      const value = src[start] === '[' ? src.slice(start, closing(src, start) + 1) : /^'(?:[^']|'')*'/.exec(src.slice(start))?.[0] ?? '';
      for (const { s, at } of stringsIn(value, start)) addRole(s, at);
    }

    // @restrict: [ { grant: ..., to: 'X', where: '...' }, ... ]
    for (const m of src.matchAll(/\brestrict\s*:\s*\[/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const block = src.slice(open, closing(src, open) + 1);
      for (const t of block.matchAll(/\bto\s*:\s*/g)) {
        const start = (t.index ?? 0) + t[0].length;
        const value = block[start] === '[' ? block.slice(start, closing(block, start) + 1) : /^'(?:[^']|'')*'/.exec(block.slice(start))?.[0] ?? '';
        for (const { s, at } of stringsIn(value, open + start)) addRole(s, at);
      }
      for (const a of block.matchAll(USER_ATTR)) addAttr(a[1], open + (a.index ?? 0));
      // Each { ... } entry of the array is one grant.
      for (let i = 1; i < block.length; i++) {
        if (block[i] === "'") {
          for (i++; i < block.length && block[i] !== "'"; i++);
          continue;
        }
        if (block[i] !== '{') continue;
        const end = closing(block, i);
        const entry = block.slice(i, end + 1);
        const to = /\bto\s*:\s*/.exec(entry);
        const value = to ? (entry[to.index + to[0].length] === '[' ? entry.slice(to.index + to[0].length, closing(entry, to.index + to[0].length) + 1) : /^'(?:[^']|'')*'/.exec(entry.slice(to.index + to[0].length))?.[0] ?? '') : '';
        const roleList = stringsIn(value, 0).map((x) => x.s.trim()).filter((r) => r && !PSEUDO_ROLES.has(r));
        const attrList = [...new Set([...entry.matchAll(USER_ATTR)].map((m) => m[1]).filter((n) => !BUILTIN_USER_PROPS.has(n)))];
        if (roleList.length || attrList.length) grants.push({ roles: roleList, attributes: attrList });
        i = end;
      }
    }

    // $user.<name> outside @restrict too, e.g. "as projection on my.Orders where country = $user.country".
    for (const a of src.matchAll(USER_ATTR)) addAttr(a[1], a.index ?? 0);
  }
  return { roles: [...roles.values()], attributes: [...attributes.values()], grants, filesScanned: files.length };
}
