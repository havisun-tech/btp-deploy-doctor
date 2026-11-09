import { CdsAuth, JsonOp, editJsonText, templateNameFor } from 'btp-deploy-doctor';

export const PREFIX = '$XSAPPNAME.';
/** "$XSAPPNAME.Admin" -> "Admin"; anything else (uaa.user, foreign apps) stays as is. */
export const localName = (s: string) => (s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s);
export const TEMPLATE_NAME = /^[A-Za-z0-9_]{1,64}$/;
export const SCOPE_NAME = /^[A-Za-z0-9_.\-]{1,64}$/;

export interface Scope { name: string; description: string; technical: boolean }
export interface Template { name: string; description: string; scopes: string[]; attributes: string[] }
export interface Collection { name: string; description: string; templates: string[] }
export interface Attribute { name: string; description: string; valueType: string }

export interface Descriptor {
  xsappname: string;
  tenantMode: string;
  scopes: Scope[];
  templates: Template[];
  collections: Collection[];
  attributes: Attribute[];
  redirectUris: string[];
  /** Set when the text is not valid JSON. */
  error?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function parseDescriptor(text: string): Descriptor {
  let data: Record<string, any> = {};
  let error: string | undefined;
  try {
    data = obj(JSON.parse(text || '{}'));
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  return {
    xsappname: str(data.xsappname),
    tenantMode: str(data['tenant-mode']),
    scopes: list(data.scopes).map((s) => ({
      name: str(s?.name),
      description: str(s?.description),
      technical: list(s?.['granted-apps']).length > 0 || list(s?.['grant-as-authority-to-apps']).length > 0,
    })),
    templates: list(data['role-templates']).map((t) => ({
      name: str(t?.name),
      description: str(t?.description),
      scopes: list(t?.['scope-references']).filter((x): x is string => typeof x === 'string'),
      attributes: list(t?.['attribute-references']).map((a) => (typeof a === 'string' ? a : str(a?.name))).filter(Boolean),
    })),
    collections: list(data['role-collections']).map((c) => ({
      name: str(c?.name),
      description: str(c?.description),
      templates: list(c?.['role-template-references']).filter((x): x is string => typeof x === 'string').map(localName),
    })),
    attributes: list(data.attributes).map((a) => ({ name: str(a?.name), description: str(a?.description), valueType: str(a?.valueType) || 'string' })),
    redirectUris: list(obj(data['oauth2-configuration'])['redirect-uris']).filter((x): x is string => typeof x === 'string'),
    error,
  };
}

/**
 * The descriptor XSUAA actually receives at deploy: this file with the mta.yaml
 * parameters.config of its resource on top (top-level keys replace the file's).
 */
export function effectiveDescriptor(text: string, overrides?: Record<string, unknown>): Descriptor {
  const own = parseDescriptor(text);
  if (own.error || !overrides || !Object.keys(overrides).length) return own;
  return parseDescriptor(JSON.stringify({ ...obj(JSON.parse(text || '{}')), ...overrides }));
}

// ---------------- edits ----------------

export type Edit =
  | { kind: 'addRole'; name: string; description?: string }
  | { kind: 'addScope'; name: string; description?: string }
  | { kind: 'removeScope'; name: string }
  | { kind: 'addTemplate'; name: string; description?: string }
  | { kind: 'removeTemplate'; name: string }
  | { kind: 'toggleTemplateScope'; template: string; scope: string; on: boolean }
  | { kind: 'toggleTemplateAttribute'; template: string; attribute: string; on: boolean }
  | { kind: 'addCollection'; name: string; description?: string }
  | { kind: 'removeCollection'; name: string }
  | { kind: 'toggleCollectionTemplate'; collection: string; template: string; on: boolean }
  | { kind: 'addAttribute'; name: string; description?: string; valueType?: string }
  | { kind: 'removeAttribute'; name: string }
  | { kind: 'setDescription'; list: 'scopes' | 'role-templates' | 'role-collections' | 'attributes'; name: string; description: string }
  | { kind: 'setXsappname'; value: string }
  | { kind: 'setTenantMode'; value: string }
  | { kind: 'setRedirectUris'; value: string[] };

class EditError extends Error {}
export { EditError };

const raw = (text: string) => obj(JSON.parse(text));
const indexOf = (text: string, key: string, name: string) => list(raw(text)[key]).findIndex((x: any) => x?.name === name);

/** Appends to an array, creating it when missing. */
function appendOp(text: string, path: (string | number)[], value: unknown): JsonOp {
  let node: any = raw(text);
  for (const k of path) node = node?.[k as any];
  return Array.isArray(node) ? { path: [...path, -1], value } : { path, value: [value] };
}

function apply(text: string, ops: JsonOp[]): string {
  const out = editJsonText(text, ops);
  if (out === undefined) throw new EditError('xs-security.json is not valid JSON. Fix it in the text editor first.');
  return out;
}

/** Applies one edit and returns the new text. Each step re-reads the text, so indices never go stale. */
export function applyEdit(text: string, e: Edit): string {
  if (!text.trim()) text = '{}\n';
  try {
    JSON.parse(text);
  } catch {
    throw new EditError('xs-security.json is not valid JSON. Fix it in the text editor first.');
  }
  const has = (key: string, name: string) => indexOf(text, key, name) >= 0;
  switch (e.kind) {
    case 'addRole': {
      const tname = templateNameFor(e.name);
      const scope = PREFIX + e.name;
      if (!has('scopes', scope)) text = applyEdit(text, { kind: 'addScope', name: e.name, description: e.description });
      if (has('role-templates', tname)) return applyEdit(text, { kind: 'toggleTemplateScope', template: tname, scope, on: true });
      if (!TEMPLATE_NAME.test(tname)) throw new EditError(`"${tname}" is not a valid role template name.`);
      return apply(text, [appendOp(text, ['role-templates'], { name: tname, description: e.description || e.name, 'scope-references': [scope] })]);
    }
    case 'addScope': {
      const name = e.name.startsWith(PREFIX) ? e.name : PREFIX + e.name;
      if (!SCOPE_NAME.test(localName(name))) throw new EditError(`"${localName(name)}" is not a valid scope name: use letters, digits, ".", "-" or "_" (max 64).`);
      if (has('scopes', name)) throw new EditError(`Scope "${name}" already exists.`);
      return apply(text, [appendOp(text, ['scopes'], { name, description: e.description || localName(name) })]);
    }
    case 'removeScope': {
      // Remove the references first, so no role template points to a missing scope.
      for (let i = list(raw(text)['role-templates']).length - 1; i >= 0; i--) {
        const refs = list(raw(text)['role-templates'][i]?.['scope-references']);
        const r = refs.indexOf(e.name);
        if (r >= 0) text = apply(text, [{ path: ['role-templates', i, 'scope-references', r], value: undefined }]);
      }
      const i = indexOf(text, 'scopes', e.name);
      return i < 0 ? text : apply(text, [{ path: ['scopes', i], value: undefined }]);
    }
    case 'addTemplate': {
      if (!TEMPLATE_NAME.test(e.name)) throw new EditError(`"${e.name}" is not a valid role template name: use letters, digits or "_" (max 64).`);
      if (has('role-templates', e.name)) throw new EditError(`Role template "${e.name}" already exists.`);
      return apply(text, [appendOp(text, ['role-templates'], { name: e.name, description: e.description || e.name, 'scope-references': [] })]);
    }
    case 'removeTemplate': {
      for (let i = list(raw(text)['role-collections']).length - 1; i >= 0; i--) {
        const refs = list(raw(text)['role-collections'][i]?.['role-template-references']);
        const r = refs.indexOf(PREFIX + e.name);
        if (r >= 0) text = apply(text, [{ path: ['role-collections', i, 'role-template-references', r], value: undefined }]);
      }
      const i = indexOf(text, 'role-templates', e.name);
      return i < 0 ? text : apply(text, [{ path: ['role-templates', i], value: undefined }]);
    }
    case 'toggleTemplateScope':
      return toggleRef(text, 'role-templates', e.template, 'scope-references', e.scope, e.on);
    case 'toggleTemplateAttribute':
      return toggleRef(text, 'role-templates', e.template, 'attribute-references', e.attribute, e.on);
    case 'addCollection': {
      if (!e.name.trim()) throw new EditError('A role collection needs a name.');
      if (has('role-collections', e.name)) throw new EditError(`Role collection "${e.name}" already exists.`);
      return apply(text, [appendOp(text, ['role-collections'], { name: e.name, description: e.description || e.name, 'role-template-references': [] })]);
    }
    case 'removeCollection': {
      const i = indexOf(text, 'role-collections', e.name);
      return i < 0 ? text : apply(text, [{ path: ['role-collections', i], value: undefined }]);
    }
    case 'toggleCollectionTemplate':
      return toggleRef(text, 'role-collections', e.collection, 'role-template-references', PREFIX + e.template, e.on);
    case 'addAttribute': {
      if (!TEMPLATE_NAME.test(e.name)) throw new EditError(`"${e.name}" is not a valid attribute name: use letters, digits or "_" (max 64).`);
      if (has('attributes', e.name)) throw new EditError(`Attribute "${e.name}" already exists.`);
      return apply(text, [appendOp(text, ['attributes'], { name: e.name, description: e.description || e.name, valueType: e.valueType || 'string' })]);
    }
    case 'removeAttribute': {
      for (let i = list(raw(text)['role-templates']).length - 1; i >= 0; i--) {
        const refs = list(raw(text)['role-templates'][i]?.['attribute-references']);
        const r = refs.findIndex((x: any) => x === e.name || x?.name === e.name);
        if (r >= 0) text = apply(text, [{ path: ['role-templates', i, 'attribute-references', r], value: undefined }]);
      }
      const i = indexOf(text, 'attributes', e.name);
      return i < 0 ? text : apply(text, [{ path: ['attributes', i], value: undefined }]);
    }
    case 'setDescription': {
      const i = indexOf(text, e.list, e.name);
      return i < 0 ? text : apply(text, [{ path: [e.list, i, 'description'], value: e.description }]);
    }
    case 'setXsappname':
      return apply(text, [{ path: ['xsappname'], value: e.value }]);
    case 'setTenantMode':
      return apply(text, [{ path: ['tenant-mode'], value: e.value }]);
    case 'setRedirectUris':
      return apply(text, [{ path: ['oauth2-configuration', 'redirect-uris'], value: e.value.length ? e.value : undefined }]);
  }
}

function toggleRef(text: string, key: string, name: string, refKey: string, ref: string, on: boolean): string {
  const i = indexOf(text, key, name);
  if (i < 0) throw new EditError(`"${name}" was not found.`);
  const refs = list(raw(text)[key][i]?.[refKey]);
  const at = refs.findIndex((x: any) => x === ref || x?.name === ref);
  if (on && at < 0) return apply(text, [refs.length ? { path: [key, i, refKey, -1], value: ref } : { path: [key, i, refKey], value: [ref] }]);
  if (!on && at >= 0) return apply(text, [{ path: [key, i, refKey, at], value: undefined }]);
  return text;
}

// ---------------- CDS ----------------

export interface RoleStatus {
  role: string;
  file: string;
  line: number;
  /** Scope "$XSAPPNAME.<role>" exists. */
  scope: boolean;
  /** Role templates that grant the scope. */
  templates: string[];
  /** Role collections that contain one of those templates. */
  collections: string[];
}

export interface AttributeStatus { name: string; file: string; line: number; defined: boolean; templates: string[] }

export function roleStatus(d: Descriptor, cds: CdsAuth): RoleStatus[] {
  return cds.roles.map((r) => {
    const scope = PREFIX + r.role;
    const templates = d.templates.filter((t) => t.scopes.includes(scope)).map((t) => t.name);
    return {
      role: r.role,
      file: r.file,
      line: r.line,
      scope: d.scopes.some((s) => s.name === scope),
      templates,
      collections: d.collections.filter((c) => c.templates.some((t) => templates.includes(t))).map((c) => c.name),
    };
  });
}

export function attributeStatus(d: Descriptor, cds: CdsAuth): AttributeStatus[] {
  return cds.attributes.map((a) => ({
    name: a.role,
    file: a.file,
    line: a.line,
    defined: d.attributes.some((x) => x.name === a.role),
    templates: d.templates.filter((t) => t.attributes.includes(a.role)).map((t) => t.name),
  }));
}

export interface Issue { severity: 'error' | 'warning'; message: string }

/** Problems XSUAA would reject, or that leave CDS roles unreachable. Live, on the unsaved text. */
/** Standard UAA scope for token exchange; XSUAA accepts it without the $XSAPPNAME prefix. */
const UAA_SCOPES = new Set(['uaa.user']);

/**
 * `deployed` is true when an mta.yaml resource creates the XSUAA instance from this file.
 * Files that nothing deploys (or that "cds add xsuaa" wrote without xsappname, for the
 * MTA to supply it) only get a warning for a missing xsappname.
 */
export function issues(d: Descriptor, cds?: CdsAuth, deployed = false): Issue[] {
  const out: Issue[] = [];
  if (d.error) return [{ severity: 'error', message: `Not valid JSON: ${d.error}` }];
  if (!d.xsappname)
    out.push(
      deployed
        ? { severity: 'error', message: 'xsappname is missing.' }
        : { severity: 'warning', message: 'xsappname is missing. Set it here, or under parameters.config of the XSUAA resource in mta.yaml, before creating the service.' },
    );
  const scopes = new Set(d.scopes.map((s) => s.name));
  const templates = new Set(d.templates.map((t) => t.name));
  const attrs = new Set(d.attributes.map((a) => a.name));
  const dup = (names: string[], what: string) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) out.push({ severity: 'error', message: `${what} "${n}" is defined twice.` });
      seen.add(n);
    }
  };
  dup(d.scopes.map((s) => s.name), 'Scope');
  dup(d.templates.map((t) => t.name), 'Role template');
  dup(d.collections.map((c) => c.name), 'Role collection');
  dup(d.attributes.map((a) => a.name), 'Attribute');
  for (const s of d.scopes) if (!s.name.startsWith(PREFIX) && !UAA_SCOPES.has(s.name)) out.push({ severity: 'error', message: `Scope "${s.name}" must start with "${PREFIX}".` });
  for (const t of d.templates) {
    if (!TEMPLATE_NAME.test(t.name)) out.push({ severity: 'error', message: `Role template name "${t.name}" may only contain letters, digits and "_".` });
    for (const s of t.scopes) if (s.startsWith(PREFIX) && !scopes.has(s)) out.push({ severity: 'error', message: `Role template "${t.name}" references unknown scope "${s}".` });
    for (const a of t.attributes) if (!attrs.has(a)) out.push({ severity: 'error', message: `Role template "${t.name}" references unknown attribute "${a}".` });
  }
  for (const c of d.collections) for (const t of c.templates) if (!templates.has(t)) out.push({ severity: 'error', message: `Role collection "${c.name}" references unknown role template "${t}".` });
  if (cds) {
    for (const r of roleStatus(d, cds)) {
      if (!r.scope) out.push({ severity: 'error', message: `CDS role "${r.role}" has no scope, so requests that need it fail with 403.` });
      else if (!r.templates.length) out.push({ severity: 'warning', message: `CDS role "${r.role}" is not granted by any role template.` });
    }
    for (const a of attributeStatus(d, cds)) if (!a.defined) out.push({ severity: 'warning', message: `CDS reads $user.${a.name}, but the attribute is not defined.` });
  }
  return out;
}

/** A descriptor with a scope and role template for every CDS role, like "cds compile --to xsuaa". */
export function generateDescriptor(xsappname: string, cds: CdsAuth): string {
  const attrsFor = (role: string) => [...new Set(cds.grants.filter((g) => g.roles.includes(role)).flatMap((g) => g.attributes))];
  const d = {
    xsappname,
    'tenant-mode': 'dedicated',
    scopes: cds.roles.map((r) => ({ name: PREFIX + r.role, description: r.role })),
    attributes: cds.attributes.map((a) => ({ name: a.role, description: a.role, valueType: 'string' })),
    'role-templates': cds.roles.map((r) => {
      const attrs = attrsFor(r.role);
      return { name: templateNameFor(r.role), description: `generated from ${r.file}`, 'scope-references': [PREFIX + r.role], ...(attrs.length ? { 'attribute-references': attrs } : {}) };
    }),
  };
  return JSON.stringify(d, null, 2) + '\n';
}

// ---------------- tokens ----------------

export interface TokenReport {
  ok: boolean;
  error?: string;
  kind?: 'xsuaa' | 'ias' | 'unknown';
  subject?: string;
  clientId?: string;
  grantType?: string;
  issuer?: string;
  expires?: string;
  expired?: boolean;
  /** Scope names grouped by the app (xsappname with !t/!b suffix) they belong to. */
  apps: { app: string; scopes: string[] }[];
  otherScopes: string[];
  roleCollections: string[];
  attributes: Record<string, string[]>;
  /** CDS roles and whether this token grants them. */
  roles: { role: string; granted: boolean; via?: string }[];
  notes: string[];
}

function b64urlJson(part: string): any {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * Decodes a JWT locally (the signature is not and cannot be verified here) and explains,
 * for each CDS role, whether CAP would accept the token.
 */
export function analyzeToken(input: string, d: Descriptor, cds: CdsAuth, now = Date.now()): TokenReport {
  const empty: TokenReport = { ok: false, apps: [], otherScopes: [], roleCollections: [], attributes: {}, roles: [], notes: [] };
  const token = input.trim().replace(/^(Authorization:\s*)?Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return { ...empty, error: 'This is not a JWT. Paste the token itself (three parts separated by dots), with or without "Bearer ".' };
  let p: any;
  try {
    b64urlJson(parts[0]);
    p = b64urlJson(parts[1]);
  } catch {
    return { ...empty, error: 'The token could not be decoded. It may be truncated: copy it again in full.' };
  }
  const scopes: string[] = Array.isArray(p.scope) ? p.scope : typeof p.scope === 'string' ? p.scope.split(' ') : [];
  const byApp = new Map<string, string[]>();
  const otherScopes: string[] = [];
  for (const s of scopes) {
    const m = /^(.+?![tb]\d+)\.(.+)$/.exec(s);
    if (m) byApp.set(m[1], [...(byApp.get(m[1]) ?? []), m[2]]);
    else otherScopes.push(s);
  }
  const isIas = !p.ext_attr && !p.zid && typeof p.iss === 'string' && /accounts(?:400)?\.ondemand\.com|\.accounts\./.test(p.iss) && !scopes.length;
  const exp = typeof p.exp === 'number' ? p.exp * 1000 : undefined;
  const apps = [...byApp.entries()].map(([app, s]) => ({ app, scopes: s }));
  const base = d.xsappname.split('$')[0].replace(/[-_.]+$/, '');
  const ours = apps.filter((a) => base && a.app.startsWith(base));
  const pool = ours.length ? ours : apps;
  const roles = cds.roles.map((r) => {
    const hit = pool.find((a) => a.scopes.includes(r.role));
    return { role: r.role, granted: !!hit, via: hit ? `${hit.app}.${r.role}` : undefined };
  });
  const notes: string[] = [];
  if (exp !== undefined && exp < now) notes.push('The token has expired, so every request with it gets 401. Get a new one.');
  if (isIas) notes.push('This is an Identity Authentication (IAS) token. CAP roles for IAS come from policies or groups, not from XSUAA scopes.');
  if (base && apps.length && !ours.length) notes.push(`None of the scopes belong to an app starting with "${base}" (the xsappname here). The token was probably issued by another XSUAA instance, so CAP rejects it or sees no roles.`);
  if (p.grant_type === 'client_credentials') notes.push('This is a technical (client credentials) token: it has no user, and its scopes come from "authorities", not from role collections.');
  const missing = roles.filter((r) => !r.granted).map((r) => r.role);
  if (missing.length && !isIas) notes.push(`Missing role${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Assign the user a role collection that contains ${missing.length > 1 ? 'those role templates' : 'that role template'}, then log in again for a new token.`);
  const attrs = obj(p['xs.user.attributes']);
  return {
    ok: true,
    kind: isIas ? 'ias' : p.zid || p.ext_attr || scopes.length ? 'xsuaa' : 'unknown',
    subject: str(p.user_name) || str(p.email) || str(p.sub) || undefined,
    clientId: str(p.client_id) || str(p.azp) || undefined,
    grantType: str(p.grant_type) || undefined,
    issuer: str(p.iss) || undefined,
    expires: exp !== undefined ? new Date(exp).toISOString() : undefined,
    expired: exp !== undefined ? exp < now : undefined,
    apps,
    otherScopes,
    roleCollections: list(p['xs.rolecollections']).filter((x): x is string => typeof x === 'string'),
    attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, list(v).map(String)])),
    roles,
    notes,
  };
}
