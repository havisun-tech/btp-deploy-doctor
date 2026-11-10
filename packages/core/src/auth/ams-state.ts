import * as fs from 'fs';
import * as path from 'path';
import { AmsModel, DclPolicy, dclRootOf, policiesForRole, scanAms } from '../ams';
import { CdsAuth, scanCdsAuth } from '../cds-roles';
import { Project } from '../project';

/** What the AMS policies view shows. Plain data, so it can go to the webview as is. */
export interface AmsState {
  root: string;
  dclRoot: string;
  dclRootExists: boolean;
  files: string[];
  schemaFile?: string;
  /** "cds build" generates basePolicies.dcl / schema.dcl when they do not exist yet. */
  generates: { policies: boolean; schema: boolean };
  baseFile: string;
  cdsFiles: number;
  roles: {
    role: string;
    file: string;
    line: number;
    direct: { policy: string; file: string; line: number; condition?: string }[];
    derived: { policy: string; file: string; line: number }[];
  }[];
  policies: (Omit<DclPolicy, 'uses'> & { uses: (DclPolicy['uses'][number] & { known: boolean })[]; usedBy: string[] })[];
  attributes: { path: string; type: string; line?: number; mappedFrom?: { element: string; file: string; line: number }; usedBy: string[]; inSchema: boolean }[];
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** True when the project authorizes with AMS: @sap/ams, or DCL files in the DCL root. */
export function isAmsProject(root: string): boolean {
  try {
    const p = new Project(root);
    if ('@sap/ams' in p.dependencies || '@sap/ams' in p.devDependencies) return true;
    return scanAms(root, dclRootOf(p.cdsFor('production')), false).files.length > 0;
  } catch {
    return false;
  }
}

/**
 * DCL root for the project. A DCL file opened from elsewhere (for example a non-CAP app with
 * auth/dcl) wins: its nearest folder with a schema.dcl is the root.
 */
export function dclRootFor(root: string, file?: string): string {
  const configured = dclRootOf(new Project(root).cdsFor('production'));
  if (!file) return configured;
  const abs = path.resolve(file);
  const inConfigured = !path.relative(path.resolve(root, configured), abs).startsWith('..');
  if (inConfigured) return configured;
  for (let dir = path.dirname(abs); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'schema.dcl'))) return path.relative(root, dir).split(path.sep).join('/');
  }
  return configured;
}

/**
 * Project root for a .dcl file: up from the file to the folder with schema.dcl (the DCL root),
 * then up to the nearest package.json or mta.yaml. Undefined when there is no schema.dcl.
 */
export function rootForDcl(file: string, stopAt?: string): string | undefined {
  const stop = stopAt ? path.resolve(stopAt) : path.parse(file).root;
  let dir = path.dirname(path.resolve(file));
  let schemaDir: string | undefined;
  for (; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'schema.dcl'))) schemaDir = dir;
    if (dir === stop || path.dirname(dir) === dir) break;
  }
  if (!schemaDir) return undefined;
  for (let d = path.dirname(schemaDir); ; d = path.dirname(d)) {
    if (['package.json', 'mta.yaml', 'mta.yml'].some((f) => fs.existsSync(path.join(d, f)))) return d;
    if (d === stop || path.dirname(d) === d) return path.dirname(schemaDir);
  }
}

export function buildAmsState(root: string, dclRoot: string, cds: CdsAuth = scanCdsAuth(root), model: AmsModel = scanAms(root, dclRoot)): AmsState {
  const prod = new Project(root).cdsFor('production');
  const auth = obj(prod?.requires?.auth);
  const cfg = obj(auth.ams ?? prod?.requires?.ams);
  const pkg = typeof cfg.dclGenerationPackage === 'string' && cfg.dclGenerationPackage ? cfg.dclGenerationPackage : 'cap';
  const baseFile = `${dclRoot}/${pkg.split('.').join('/')}/basePolicies.dcl`;
  const generate = cfg.generateDcl !== false;
  const known = new Set(model.policies.map((p) => p.qualified));
  const usedBy = (q: string) => model.policies.filter((p) => p.uses.some((u) => u.target === q)).map((p) => p.qualified);

  const attrUse = new Map<string, Set<string>>();
  for (const p of model.policies)
    for (const a of [...p.roles.flatMap((r) => r.attributes), ...p.uses.flatMap((u) => u.attributes), ...p.grants.flatMap((g) => g.attributes)]) {
      if (!attrUse.has(a.path)) attrUse.set(a.path, new Set());
      attrUse.get(a.path)!.add(p.qualified);
    }
  const mapping = (name: string) => model.mappings.find((m) => m.name === name);
  const attributes: AmsState['attributes'] = model.schemaFile
    ? model.schema.map((s) => {
        const m = mapping(s.path);
        return { path: s.path, type: s.type, line: s.line, mappedFrom: m && { element: m.element, file: m.file, line: m.line }, usedBy: [...(attrUse.get(s.path) ?? [])], inSchema: true };
      })
    : [];
  for (const m of model.mappings)
    if (!attributes.some((a) => a.path === m.name))
      attributes.push({ path: m.name, type: '', mappedFrom: { element: m.element, file: m.file, line: m.line }, usedBy: [...(attrUse.get(m.name) ?? [])], inSchema: !model.schemaFile && generate });

  return {
    root: path.basename(root),
    dclRoot,
    dclRootExists: model.dclRootExists,
    files: model.files,
    schemaFile: model.schemaFile,
    generates: { policies: generate && !fs.existsSync(path.join(root, baseFile)), schema: generate && !model.schemaFile },
    baseFile,
    cdsFiles: cds.filesScanned,
    roles: cds.roles.map((r) => {
      const { direct, derived } = policiesForRole(model, r.role);
      return {
        role: r.role,
        file: r.file,
        line: r.line,
        direct: direct.map((p) => {
          const a = p.roles.find((x) => x.role === r.role)!;
          return { policy: p.qualified, file: p.file, line: a.line, condition: a.condition };
        }),
        derived: derived.map((p) => ({ policy: p.qualified, file: p.file, line: p.line })),
      };
    }),
    policies: model.policies.map((p) => ({ ...p, uses: p.uses.map((u) => ({ ...u, known: known.has(u.target) })), usedBy: usedBy(p.qualified) })),
    attributes,
  };
}

// ---------------- IAS tokens ----------------

export interface IasTokenReport {
  ok: boolean;
  error?: string;
  kind?: 'ias' | 'xsuaa' | 'unknown';
  subject?: string;
  scimId?: string;
  tenant?: string;
  clientId?: string;
  audience?: string[];
  issuer?: string;
  expires?: string;
  expired?: boolean;
  groups: string[];
  /** ias_apis: API permission groups of a technical or principal-propagation token. */
  apis: { name: string; policy?: string; roles: string[] }[];
  /** CDS roles, the policies that give each, and (when the token lists them) whether it has them. */
  roles: { role: string; policies: string[]; inToken?: boolean }[];
  notes: string[];
}

function b64urlJson(part: string): any {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Roles a policy gives, including through USE of other policies. */
function rolesOf(model: AmsModel, qualified: string, seen = new Set<string>()): string[] {
  if (seen.has(qualified)) return [];
  seen.add(qualified);
  const p = model.policies.find((x) => x.qualified === qualified);
  if (!p) return [];
  return [...new Set([...p.roles.map((r) => r.role), ...p.uses.flatMap((u) => rolesOf(model, u.target, seen))])];
}

/**
 * Decodes an IAS token locally (the signature is not verified) and explains it for AMS:
 * roles are not in the token, so it shows which policies the user needs for each CDS role.
 */
export function analyzeIasToken(input: string, model: AmsModel, cds: CdsAuth, now = Date.now()): IasTokenReport {
  const empty: IasTokenReport = { ok: false, groups: [], apis: [], roles: [], notes: [] };
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
  const scopes = strs(p.scope).flatMap((s) => s.split(' '));
  const xsuaa = !!(p.zid || p.ext_attr || scopes.some((s) => /![tb]\d+\./.test(s)));
  const ias = !xsuaa && (!!p.app_tid || !!p.scim_id || (typeof p.iss === 'string' && /accounts(?:400)?\.ondemand\.com|cloud\.sap/.test(p.iss)));
  const exp = typeof p.exp === 'number' ? p.exp * 1000 : undefined;
  const notes: string[] = [];
  if (exp !== undefined && exp < now) notes.push('The token has expired, so every request with it gets 401. Get a new one.');
  if (xsuaa) notes.push('This is an XSUAA token, but this app authenticates with Identity Authentication (IAS). CAP rejects it with 401. Call the app through an approuter or client bound to the identity service, so that IAS issues the token.');

  const policiesFor = (role: string) => {
    const { direct, derived } = policiesForRole(model, role);
    return [...direct, ...derived].filter((x) => x.kind !== 'internal').map((x) => x.qualified);
  };
  const authz = Array.isArray(p.functionalAuthz) ? strs(p.functionalAuthz) : undefined;
  const roles = cds.roles.map((r) => ({ role: r.role, policies: policiesFor(r.role), inToken: authz ? authz.includes(r.role) : undefined }));

  const apis = strs(p.ias_apis).map((name) => {
    const pol = model.policies.find((x) => x.kind === 'internal' && x.name === name);
    return { name, policy: pol?.qualified, roles: pol ? rolesOf(model, pol.qualified) : [] };
  });
  for (const a of apis) if (!a.policy) notes.push(`The token carries API permission group "${a.name}", but no INTERNAL POLICY "${a.name}" exists in ${model.dclRoot}, so it gives no roles.`);

  if (ias) {
    notes.push(
      authz
        ? 'Roles in "functionalAuthz" are only a hint: conditions (WHERE / RESTRICT) are never in the token, AMS evaluates them per request.'
        : `IAS tokens do not carry roles. At each request AMS looks up the policies assigned to this user${str(p.scim_id) ? ` (SCIM ID ${p.scim_id})` : ''} in the Identity Authentication admin console. If a request fails with 403, assign the user one of the policies listed for the role below.`,
    );
    const noPolicy = roles.filter((r) => !r.policies.length).map((r) => r.role);
    if (noPolicy.length) notes.push(`No policy gives ${noPolicy.length > 1 ? 'roles' : 'role'} ${noPolicy.join(', ')}, so no user can get ${noPolicy.length > 1 ? 'them' : 'it'}. Add a policy in ${model.dclRoot}.`);
    if (!p.app_tid) notes.push('The token has no "app_tid" (application tenant). Tokens for CAP apps on IAS normally do; it may be meant for another application.');
  }
  return {
    ok: true,
    kind: xsuaa ? 'xsuaa' : ias ? 'ias' : 'unknown',
    subject: str(p.email) || str(p.user_name) || str(p.sub),
    scimId: str(p.scim_id) || str(p.user_uuid),
    tenant: str(p.app_tid) || str(p.zone_uuid),
    clientId: str(p.azp) || str(p.client_id),
    audience: strs(p.aud),
    issuer: str(p.iss),
    expires: exp !== undefined ? new Date(exp).toISOString() : undefined,
    expired: exp !== undefined ? exp < now : undefined,
    groups: strs(p.groups),
    apis,
    roles,
    notes,
  };
}
