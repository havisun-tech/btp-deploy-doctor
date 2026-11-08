import { requiredKind } from '../cds-config';
import { RoleUse, scanCdsAuth } from '../cds-roles';
import { addRequire, levenshtein } from '../fix/edit';
import { attach, jsonFix, yamlFix } from '../fix/helpers';
import { JsonFile, Project } from '../project';
import { Finding, Fix, Severity } from '../types';
import { asArray, isPlainObject } from '../util';
import { MtaModule, MtaResource, isApprouter, isCapService, isDestination, isHtml5App, isIdentity, isMtxSidecar, isXsuaa, joinPath, mtaModules, mtaResources } from './mta-model';

const PREFIX = '$XSAPPNAME.';
/** "$XSAPPNAME.Admin" -> "Admin". Other forms (foreign apps, uaa.user) return undefined. */
const local = (s: unknown) => (typeof s === 'string' && s.startsWith(PREFIX) ? s.slice(PREFIX.length) : undefined);
const names = (list: unknown[]) => list.map((x: any) => x?.name).filter((n): n is string => typeof n === 'string');
const near = (name: string, candidates: string[]) => {
  const lower = name.toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === lower) ?? candidates.find((c) => levenshtein(c.toLowerCase(), lower) <= 2);
  return hit !== name ? hit : undefined;
};

const UPDATE_HINT = 'Then redeploy, or run "cf update-service <xsuaa instance> -c xs-security.json": the running XSUAA instance does not pick up file changes by itself.';

/** The security descriptor XSUAA is created from: the file, overlaid with mta.yaml config. */
interface Descriptor {
  /** File the arrays come from, when they are not overridden in mta.yaml. */
  file?: JsonFile;
  /** mta.yaml resource whose config overrides the file, if any. */
  resource?: MtaResource;
  data: Record<string, any>;
  /** Keys that come from mta.yaml config, so the file is not where to fix them. */
  fromMta: Set<string>;
}

function descriptor(p: Project, resources: MtaResource[], services: MtaModule[]): Descriptor | undefined {
  const xsuaa = resources.filter(isXsuaa);
  const bound = xsuaa.find((r) => services.some((m) => m.requires.some((q) => q.name === r.name))) ?? xsuaa[0];
  if (!p.mta) {
    const file = p.json('xs-security.json');
    return file && !file.error ? { file, data: file.data, fromMta: new Set() } : undefined;
  }
  if (!bound) return undefined;
  const rel = typeof bound.parameters.path === 'string' ? bound.parameters.path : undefined;
  const file = rel ? p.json(rel) : undefined;
  if (rel && (!file || file.error)) return undefined; // MTA008 / invalid JSON is reported elsewhere
  const config = isPlainObject(bound.parameters.config) ? bound.parameters.config : {};
  const data = { ...(file?.data ?? {}), ...config };
  return { file, resource: bound, data, fromMta: new Set(Object.keys(config)) };
}

/** Checks that the roles CAP enforces can actually be granted by XSUAA, and that logins reach the service. */
export function authRules(p: Project): Finding[] {
  if (p.mta?.errors.length) return [];
  const out: Finding[] = [];
  const prod = p.isCap ? p.cdsFor('production') : undefined;
  const auth = prod ? requiredKind(prod, 'auth') : undefined;
  const modules = mtaModules(p);
  const resources = mtaResources(p);
  const services = modules.filter(isCapService);
  const xsuaa = resources.filter(isXsuaa);
  const usesXsuaa = auth === 'xsuaa' || auth === 'jwt' || (!auth && xsuaa.length > 0);

  if (p.isCap && usesXsuaa) out.push(...roleRules(p, resources, services));
  if (p.mta) out.push(...approuterRules(p, modules, resources, services, auth));
  return out;
}

function roleRules(p: Project, resources: MtaResource[], services: MtaModule[]): Finding[] {
  const out: Finding[] = [];
  const d = descriptor(p, resources, services);
  const cds = scanCdsAuth(p.root);
  // No descriptor: no XSUAA, or its file is missing or invalid, which MTA008 / JSON checks report.
  if (!d) return out;
  const data = d.data;
  const scopes = asArray(data.scopes).filter(isPlainObject);
  const templates = asArray(data['role-templates']).filter(isPlainObject);
  const collections = asArray(data['role-collections']).filter(isPlainObject);
  const attributes = asArray(data.attributes).filter(isPlainObject);
  const scopeNames = names(scopes).map(local).filter((n): n is string => !!n);
  const templateNames = names(templates);
  const attributeNames = names(attributes);
  /** Where a list of the descriptor is defined: the file, or mta.yaml config overriding it. */
  const srcOf = (key: string) => (d.file && !d.fromMta.has(key) ? d.file.rel : d.resource ? `${p.mta!.rel} (resource "${d.resource.name}")` : 'xs-security.json');

  const add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, location: { file: string; line?: number }) => {
    const f: Finding = { ruleId, severity, title, message, fix, location: { file: location.file, line: location.line ?? 1 } };
    out.push(f);
    return f;
  };
  /** Where a descriptor entry lives, for pointing at it. */
  const descAt = (key: string, ...inner: string[]) => {
    if (d?.file && !d.fromMta.has(key)) return { file: d.file.rel, line: p.jsonKeyLine(d.file, key, ...inner) ?? p.jsonKeyLine(d.file, key) ?? 1 };
    if (d?.resource) return { file: p.mta!.rel, line: p.yamlLine(['resources', d.resource.idx, 'parameters', 'config', key]) ?? p.yamlLine(['resources', d.resource.idx]) ?? 1 };
    return { file: srcOf(key), line: 1 };
  };
  /** Edits to the file, only when the arrays really come from it. */
  const editable = (...keys: string[]) => !!d?.file && keys.every((k) => !d.fromMta.has(k));
  const fileFix = (title: string, ops: { path: (string | number)[]; value: unknown }[], review = false): Fix | undefined => {
    if (!d?.file) return undefined;
    const fx = jsonFix(p, d.file.rel, title, ops, UPDATE_HINT);
    if (fx && review) fx.requiresReview = true;
    return fx;
  };
  const appendOps = (key: string, list: unknown[], items: unknown[]) =>
    list.length || asArray(data[key]).length ? items.map((value) => ({ path: [key, -1], value })) : [{ path: [key], value: items }];

  // AUTH001 / AUTH002 – every role CAP checks must be a scope that a role template grants
  for (const use of cds.roles) {
    const scope = `${PREFIX}${use.role}`;
    const hasScope = scopeNames.includes(use.role);
    if (!hasScope) {
      const similar = near(use.role, scopeNames);
      const f = add(
        'AUTH001',
        'error',
        `Role "${use.role}" is not defined in ${d.file && !d.fromMta.has('scopes') ? 'xs-security.json' : 'XSUAA'}`,
        `The CDS model requires role "${use.role}", but ${srcOf('scopes')} has no scope "${scope}"${similar ? `. It has "${PREFIX}${similar}": role names are case-sensitive` : ''}. Nobody can be given this role, so every request that needs it fails with 403 Forbidden.`,
        !d.file
          ? 'Generate the descriptor with "cds compile srv --to xsuaa > xs-security.json" and set "path: ./xs-security.json" on the XSUAA resource.'
          : similar
            ? `Use the same spelling in the CDS model and in ${srcOf('scopes')}.`
            : `Add the scope "${scope}" and a role template "${use.role}" that references it, or regenerate with "cds compile srv --to xsuaa".`,
        use,
      );
      if (editable('scopes', 'role-templates')) {
        const existing = templates.findIndex((t) => t.name === use.role);
        const ops = appendOps('scopes', scopes, [{ name: scope, description: use.role }]);
        if (existing >= 0) {
          const refs = asArray(templates[existing]['scope-references']);
          ops.push(refs.length ? { path: ['role-templates', existing, 'scope-references', -1], value: scope } : { path: ['role-templates', existing, 'scope-references'], value: [scope] });
        }
        else ops.push(...appendOps('role-templates', templates, [{ name: use.role, description: use.role, 'scope-references': [scope] }]));
        attach(f, fileFix(`Add scope and role template "${use.role}" to ${d.file!.rel}`, ops, !!similar));
      }
      continue;
    }
    const refs = templates.flatMap((t) => asArray(t['scope-references']).map(local)).filter((n): n is string => !!n);
    const granted = refs.includes(use.role);
    // A misspelled reference to this scope is reported (and fixed) as AUTH003 instead.
    const misspelled = refs.some((r) => !scopeNames.includes(r) && near(r, scopeNames) === use.role);
    if (!granted && !misspelled) {
      const f = add(
        'AUTH002',
        'warning',
        `No role template grants role "${use.role}"`,
        `${srcOf('scopes')} defines the scope "${scope}", but no role template references it. Scopes reach users only through role templates and role collections, so nobody can get this role and requests that need it fail with 403 Forbidden.`,
        `Add a role template with "scope-references": ["${scope}"].`,
        use,
      );
      if (editable('role-templates')) {
        const same = templates.findIndex((t) => t.name === use.role);
        const refs = same >= 0 ? asArray(templates[same]['scope-references']) : [];
        attach(f, same >= 0
          ? fileFix(`Add "${scope}" to role template "${use.role}"`, [refs.length ? { path: ['role-templates', same, 'scope-references', -1], value: scope } : { path: ['role-templates', same, 'scope-references'], value: [scope] }])
          : fileFix(`Add role template "${use.role}"`, appendOps('role-templates', templates, [{ name: use.role, description: use.role, 'scope-references': [scope] }])));
      }
    }
  }

  // AUTH003 / AUTH005 – role templates must reference defined scopes and attributes
  templates.forEach((t, ti) => {
    asArray(t['scope-references']).forEach((ref, ri) => {
      const name = local(ref);
      if (!name || scopeNames.includes(name)) return;
      const similar = near(name, scopeNames);
      const f = add('AUTH003', 'error', `Role template "${t.name}" references unknown scope "${ref}"`, `${srcOf('scopes')} has no scope "${ref}". XSUAA rejects the descriptor, so creating or updating the service instance fails during deploy.`, similar ? `Change it to "${PREFIX}${similar}".` : `Add the scope "${ref}" to "scopes", or remove the reference.`, descAt('role-templates', String(t.name ?? '')));
      if (editable('role-templates', 'scopes')) {
        attach(f, similar
          ? fileFix(`Change to "${PREFIX}${similar}"`, [{ path: ['role-templates', ti, 'scope-references', ri], value: `${PREFIX}${similar}` }])
          : fileFix(`Add scope "${ref}"`, appendOps('scopes', scopes, [{ name: ref, description: name }])));
      }
    });
    asArray(t['attribute-references']).forEach((ref: any, ri) => {
      const name = typeof ref === 'string' ? ref : ref?.name;
      if (typeof name !== 'string' || attributeNames.includes(name)) return;
      const similar = near(name, attributeNames);
      const f = add('AUTH005', 'error', `Role template "${t.name}" references unknown attribute "${name}"`, `${srcOf('attributes')} has no attribute "${name}" under "attributes". XSUAA rejects the descriptor, so creating or updating the service instance fails during deploy.`, similar ? `Change it to "${similar}".` : `Add { "name": "${name}", "valueType": "string" } to "attributes".`, descAt('role-templates', String(t.name ?? '')));
      if (similar && editable('role-templates') && typeof ref === 'string') {
        attach(f, fileFix(`Change to "${similar}"`, [{ path: ['role-templates', ti, 'attribute-references', ri], value: similar }]));
      }
    });
  });

  // AUTH004 – role collections must reference defined role templates
  collections.forEach((c, ci) => {
    asArray(c['role-template-references']).forEach((ref, ri) => {
      const name = local(ref);
      if (!name || templateNames.includes(name)) return;
      const similar = near(name, templateNames);
      const f = add('AUTH004', 'error', `Role collection "${c.name}" references unknown role template "${ref}"`, `${srcOf('role-templates')} has no role template "${name}". XSUAA rejects the descriptor, so the deploy fails when it creates or updates the service instance.`, similar ? `Change it to "${PREFIX}${similar}".` : 'Use the name of a role template from "role-templates".', descAt('role-collections', String(c.name ?? '')));
      if (similar && editable('role-collections')) {
        attach(f, fileFix(`Change to "${PREFIX}${similar}"`, [{ path: ['role-collections', ci, 'role-template-references', ri], value: `${PREFIX}${similar}` }]));
      }
    });
  });

  // AUTH006 – user attributes in @restrict where conditions must exist in XSUAA
  {
    for (const a of cds.attributes) {
      if (attributeNames.includes(a.role)) continue;
      add('AUTH006', 'warning', `User attribute "${a.role}" is not defined in xs-security.json`, `A @restrict condition reads $user.${a.role}, but ${srcOf('attributes')} defines no attribute "${a.role}". Users never carry it, so the condition matches no rows and they see empty lists or 403 errors.`, `Add { "name": "${a.role}", "valueType": "string" } to "attributes" and reference it from the role templates that need it.`, a as RoleUse);
    }
  }
  return out;
}

function approuterRules(p: Project, modules: MtaModule[], resources: MtaResource[], services: MtaModule[], auth: string | undefined): Finding[] {
  const out: Finding[] = [];
  const mta = p.mta!;
  const realAuth = auth === 'xsuaa' || auth === 'jwt' || auth === 'ias';
  const at = (path: (string | number)[]) => ({ file: mta.rel, line: p.yamlLine(path) ?? 1 });
  const loginServices = resources.filter((r) => isXsuaa(r) || isIdentity(r));
  const runsApprouter = (m: MtaModule) => {
    const deps = p.json(joinPath(m.path ?? '.', 'package.json'))?.data?.dependencies;
    return isApprouter(m) || (isHtml5App(m) && isPlainObject(deps) && '@sap/approuter' in deps);
  };
  // MTX endpoints (sidecar or in the service) are called by the SaaS registry and tools, not with user tokens.
  const srvProvides = new Set(services.filter((m) => !isMtxSidecar(m)).flatMap((m) => m.provides).filter((n) => !/mtx/i.test(n)));

  for (const m of modules.filter(runsApprouter)) {
    // AUTH010 – an approuter that logs users in needs XSUAA (or IAS) bound
    const xsApp = m.path ? p.json(joinPath(m.path, 'xs-app.json')) : undefined;
    if (xsApp && !xsApp.error && xsApp.data.authenticationMethod !== 'none') {
      const routes = asArray(xsApp.data.routes).filter(isPlainObject);
      const needsLogin = routes.some((r) => r.authenticationType !== 'none');
      const bound = m.requires.some((q) => loginServices.some((r) => r.name === q.name));
      if (needsLogin && !bound) {
        const f: Finding = {
          ruleId: 'AUTH010',
          severity: 'error',
          title: `Approuter "${m.name}" is not bound to XSUAA`,
          message: `${xsApp.rel} has routes that require login, but "${m.name}" does not require an XSUAA or Identity Authentication resource. The approuter fails at startup, or every request to those routes fails.`,
          fix: loginServices.length ? `Add "- name: ${loginServices[0].name}" under "${m.name}" > requires.` : 'Add an XSUAA resource ("cds add xsuaa") and require it from the approuter.',
          location: at(['modules', m.idx, 'requires']).line > 1 ? at(['modules', m.idx, 'requires']) : at(['modules', m.idx]),
        };
        out.push(loginServices.length === 1 ? attach(f, yamlFix(p, `Require "${loginServices[0].name}" from "${m.name}"`, (doc) => addRequire(doc, m.idx, loginServices[0].name))) : f);
      }
    }

    // AUTH011 – destinations from the approuter to the CAP service must forward the user's token
    if (!realAuth || isPlainObject(m.properties.destinations) || typeof m.properties.destinations === 'string') continue;
    asArray(mta.data.modules?.[m.idx]?.requires).forEach((q: any, qi) => {
      if (q?.group !== 'destinations' || !srvProvides.has(q?.name) || !isPlainObject(q.properties)) return;
      if (q.properties.forwardAuthToken === true || q.properties.forwardAuthToken === 'true') return;
      const destName = typeof q.properties.name === 'string' ? q.properties.name : q.name;
      out.push(attach({
        ruleId: 'AUTH011',
        severity: 'warning',
        title: `Destination "${destName}" does not forward the login token`,
        message: `"${m.name}" calls the CAP service through destination "${destName}" without "forwardAuthToken: true". The service receives no user token and answers 401 Unauthorized.`,
        fix: 'Set forwardAuthToken: true in the properties of that requires entry.',
        location: at(['modules', m.idx, 'requires', qi]),
      }, yamlFix(p, 'Set forwardAuthToken: true', (doc) => doc.setIn(['modules', m.idx, 'requires', qi, 'properties', 'forwardAuthToken'], true))));
    });
  }

  // AUTH011 – same for the managed approuter: destinations created in the destination service
  if (realAuth && srvProvides.size) {
    for (const r of resources.filter(isDestination)) {
      for (const level of ['instance', 'subaccount']) {
        asArray(r.parameters.config?.init_data?.[level]?.destinations).forEach((dst: any, k) => {
          if (!isPlainObject(dst) || typeof dst.URL !== 'string') return;
          const target = /~\{([^}/]+)\//.exec(dst.URL)?.[1];
          if (!target || !srvProvides.has(target)) return;
          if ((dst.Authentication ?? 'NoAuthentication') !== 'NoAuthentication') return;
          const fwd = dst['HTML5.ForwardAuthToken'] ?? dst.forwardAuthToken;
          if (fwd === true || fwd === 'true') return;
          const path = ['resources', r.idx, 'parameters', 'config', 'init_data', level, 'destinations', k];
          out.push(attach({
            ruleId: 'AUTH011',
            severity: 'warning',
            title: `Destination "${dst.Name ?? target}" does not forward the login token`,
            message: `The destination to the CAP service uses NoAuthentication without "HTML5.ForwardAuthToken: true". The managed approuter and Work Zone call the service without the user's token, so it answers 401 Unauthorized.`,
            fix: 'Add "HTML5.ForwardAuthToken: true" to the destination.',
            location: at(path),
          }, yamlFix(p, 'Set HTML5.ForwardAuthToken: true', (doc) => doc.setIn([...path, 'HTML5.ForwardAuthToken'], true))));
        });
      }
    }
  }
  return out;
}
