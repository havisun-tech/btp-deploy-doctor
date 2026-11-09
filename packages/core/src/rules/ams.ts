import { AmsModel, dclRootOf, policyText, scanAms } from '../ams';
import { requiredKind } from '../cds-config';
import * as fs from 'fs';
import { blankComments, cdsFiles, scanCdsAuth } from '../cds-roles';
import { levenshtein, removeDependency, setDependency } from '../fix/edit';
import { NPM_INSTALL, attach, jsonFix, yamlFix } from '../fix/helpers';
import { Project } from '../project';
import { Finding, Fix, Severity } from '../types';
import { isPlainObject } from '../util';
import { isCapService, isIdentity, mtaModules, mtaResources } from './mta-model';

const near = (name: string, candidates: string[]) => {
  const lower = name.toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === lower) ?? candidates.find((c) => levenshtein(c.toLowerCase(), lower) <= 2);
  return hit !== name ? hit : undefined;
};

const DEPLOY_HINT = 'Redeploy so the policy deployer uploads the change to AMS, then assign the policy to users in the Identity Authentication admin console.';

/** AMS settings from cds.requires.auth.ams (or cds.requires.ams). */
function amsConfig(cds: any): Record<string, any> {
  const auth = cds?.requires?.auth;
  const a = isPlainObject(auth) ? auth.ams : undefined;
  return isPlainObject(a) ? a : isPlainObject(cds?.requires?.ams) ? cds.requires.ams : {};
}

/** Replaces the first `from` name on one line, keeping its quotes. */
function replaceOnLine(text: string, line: number, from: string, to: string): string | undefined {
  const lines = text.split('\n');
  const l = lines[line - 1];
  if (l === undefined) return undefined;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp(`"${esc}"`);
  const bare = new RegExp(`(^|[^\\w$."])${esc}(?![\\w$])`);
  let next: string;
  if (quoted.test(l)) next = l.replace(quoted, `"${to}"`);
  else if (bare.test(l)) next = l.replace(bare, (_m, pre) => `${pre}${/^[A-Za-z_][\w.]*$/.test(to) ? to : `"${to}"`}`);
  else return undefined;
  lines[line - 1] = next;
  return lines.join('\n');
}

/**
 * Checks for CAP projects that authorize with SAP Authorization Management Service (AMS)
 * policies on Identity Authentication (IAS): every CDS role must be reachable from a policy,
 * policies must reference real roles, policies and attributes, and the policies must be deployed.
 */
export function amsRules(p: Project): Finding[] {
  if (!p.isCap || p.mta?.errors.length) return [];
  const prod = p.cdsFor('production');
  const auth = requiredKind(prod, 'auth');
  const usesAmsLib = '@sap/ams' in p.dependencies || '@sap/ams' in p.devDependencies;
  const dclRoot = dclRootOf(prod);
  const model = scanAms(p.root, dclRoot);
  if (!usesAmsLib && !model.files.length) return [];
  // XSUAA apps are checked by the AUTH rules; AMS here means IAS.
  if (auth === 'xsuaa' || auth === 'jwt') return [];

  const out: Finding[] = [];
  const add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, file: string, line?: number) => {
    const f: Finding = { ruleId, severity, title, message, fix, location: { file, line: line ?? 1 } };
    out.push(f);
    return f;
  };
  const cfg = amsConfig(prod);
  const generate = cfg.generateDcl !== false;
  const pkg = typeof cfg.dclGenerationPackage === 'string' && cfg.dclGenerationPackage ? cfg.dclGenerationPackage : 'cap';
  const baseFile = `${dclRoot}/${pkg.split('.').join('/')}/basePolicies.dcl`;
  const baseExists = p.exists(baseFile);

  // Each rule group reports through add(), which collects into out.
  roleRules(p, model, { generate, baseFile, baseExists, pkg, add });
  referenceRules(p, model, generate, add);
  deployRules(p, model, cfg, usesAmsLib, auth, add);
  return out;
}

type Add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, file: string, line?: number) => Finding;

function roleRules(p: Project, model: AmsModel, o: { generate: boolean; baseFile: string; baseExists: boolean; pkg: string; add: Add }): void {
  const cds = scanCdsAuth(p.root);
  const assigned = new Set(model.policies.flatMap((x) => x.roles.map((r) => r.role)));
  const assignedAsWritten = new Set(assigned);
  // A misspelled assignment is reported once, by AMS002, whose fix also covers the role.
  const roleNames = cds.roles.map((r) => r.role);
  for (const r of assigned) if (!roleNames.includes(r)) {
    const similar = near(r, roleNames);
    if (similar) assigned.add(similar);
  }

  // AMS001 – a CDS role that no policy assigns can never be granted
  // When basePolicies.dcl does not exist yet, "cds build" generates it with every role.
  if (o.baseExists || !o.generate) {
    for (const use of cds.roles) {
      if (assigned.has(use.role)) continue;
      const existing = o.baseExists ? p.readText(o.baseFile) ?? '' : undefined;
      const indent = existing !== undefined ? /\n([ \t]+)ASSIGN/i.exec(existing)?.[1] ?? '  ' : '  ';
      const block = policyText(use.role).replace(/\n  /g, `\n${indent}`);
      const after = existing === undefined ? block : `${existing.replace(/\s*$/, '')}\n\n${block}`;
      const f = o.add(
        'AMS001',
        'error',
        `Role "${use.role}" is not assigned by any AMS policy`,
        o.baseExists
          ? `The CDS model requires role "${use.role}", but no policy in ${model.dclRoot} assigns it. ${o.baseFile} already exists, and "cds build" does not regenerate a DCL file that is there, so roles added to the model later are missing. Nobody can get this role, so every request that needs it fails with 403 Forbidden.`
          : `The CDS model requires role "${use.role}", but no policy in ${model.dclRoot} assigns it and DCL generation is switched off (generateDcl: false). Nobody can get this role, so every request that needs it fails with 403 Forbidden.`,
        `Add a policy with "ASSIGN ROLE ${use.role};" to ${o.baseFile}, or delete that file and run "cds build" to regenerate it.`,
        use.file,
        use.line,
      );
      attach(f, { title: `Add policy "${use.role}" to ${o.baseFile}`, changes: [{ file: o.baseFile, before: existing ?? null, after }], followUp: DEPLOY_HINT });
    }
  }

  // AMS002 – a policy assigns a role the CDS model never checks
  if (cds.roles.length) {
    const roles = cds.roles.map((r) => r.role);
    const reported = new Set<string>();
    for (const pol of model.policies)
      for (const r of pol.roles) {
        if (roles.includes(r.role) || reported.has(`${pol.file}:${r.line}:${r.role}`)) continue;
        reported.add(`${pol.file}:${r.line}:${r.role}`);
        const similar = near(r.role, roles);
        // When the misspelled role is the only way to get the real one, users get 403 for it.
        const blocks = !!similar && !assignedAsWritten.has(similar);
        const f = o.add(
          'AMS002',
          blocks ? 'error' : 'warning',
          `Policy "${pol.qualified}" assigns unknown role "${r.role}"`,
          `No @requires or @restrict in the CDS model uses role "${r.role}", so this assignment has no effect${similar ? `. The model has "${similar}"${similar.toLowerCase() === r.role.toLowerCase() ? ': role names are case-sensitive' : ''}` : ''}.${blocks ? ` No other policy gives "${similar}", so every request that needs it fails with 403 Forbidden.` : ''}`,
          similar ? `Change "${r.role}" to "${similar}".` : `Use a role from the CDS model (${roles.slice(0, 5).join(', ')}${roles.length > 5 ? ', ...' : ''}), or remove the assignment.`,
          pol.file,
          r.line,
        );
        const text = similar ? p.readText(pol.file) : undefined;
        const after = text !== undefined && similar ? replaceOnLine(text, r.line, r.role, similar) : undefined;
        if (after) attach(f, { title: `Change role "${r.role}" to "${similar}"`, changes: [{ file: pol.file, before: text!, after }], followUp: DEPLOY_HINT, requiresReview: true });
      }
  }
}

function referenceRules(p: Project, model: AmsModel, generate: boolean, add: Add): void {
  const names = model.policies.map((x) => x.qualified);

  // AMS004 – policy names must be unique within a package
  const seen = new Map<string, string>();
  for (const pol of model.policies) {
    const first = seen.get(pol.qualified);
    if (first) add('AMS004', 'error', `Policy "${pol.qualified}" is defined twice`, `"${pol.qualified}" is also defined at ${first}. The DCL compiler rejects the policies, so "cds build" fails.`, 'Rename or remove one of them.', pol.file, pol.line);
    else seen.set(pol.qualified, `${pol.file}:${pol.line}`);
  }

  // AMS003 – USE of a policy that does not exist
  for (const pol of model.policies)
    for (const u of pol.uses) {
      if (names.includes(u.target)) continue;
      const similar = near(u.target, names) ?? near(u.ref, names);
      const f = add(
        'AMS003',
        'error',
        `Policy "${pol.qualified}" uses unknown policy "${u.ref}"`,
        `There is no policy "${u.target}" in ${model.dclRoot}. The DCL compiler rejects it ("Cannot find PolicyDefinition"), so "cds build" fails.`,
        similar ? `Change it to "${similar}".` : 'Use the package and name of an existing policy, for example "cap.Reader".',
        pol.file,
        u.line,
      );
      const text = similar ? p.readText(pol.file) : undefined;
      const after = text !== undefined && similar ? replaceOnLine(text, u.line, u.ref, similar) : undefined;
      if (after) attach(f, { title: `Change "${u.ref}" to "${similar}"`, changes: [{ file: pol.file, before: text!, after }], requiresReview: true });
    }

  // AMS005 / AMS006 – attributes in conditions and @ams.attributes must be in the schema
  const schemaPaths = model.schemaFile ? model.schema.map((s) => s.path) : generate ? model.mappings.map((m) => m.name) : [];
  const roots = new Set(schemaPaths.map((s) => s.split('.')[0]));
  if (model.schemaFile || generate) {
    const reported = new Set<string>();
    for (const pol of model.policies) {
      const refs = [...pol.roles.flatMap((r) => r.attributes), ...pol.uses.flatMap((u) => u.attributes), ...pol.grants.flatMap((g) => g.attributes)];
      for (const a of refs) {
        if (schemaPaths.includes(a.path)) continue;
        // $user, $env and similar are built in unless the schema defines them.
        if (a.path.startsWith('$') && !roots.has(a.path.split('.')[0])) continue;
        const key = `${pol.file}:${a.line}:${a.path}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const similar = near(a.path, schemaPaths);
        const f = add(
          'AMS005',
          'error',
          `Unknown attribute "${a.path}" in policy "${pol.qualified}"`,
          `${model.schemaFile ? `${model.schemaFile} does not define "${a.path}"` : `No @ams.attributes annotation maps "${a.path}", so the generated schema.dcl will not have it`}${similar ? ` (it has "${similar}")` : ''}. The DCL compiler rejects the policy, so "cds build" fails.`,
          similar ? `Change it to "${similar}".` : model.schemaFile ? `Add "${a.path}" to ${model.schemaFile}, or fix the name.` : `Map it in CDS, for example: annotate <Entity> with @ams.attributes: { ${a.path}: (<element>) };`,
          pol.file,
          a.line,
        );
        const text = similar ? p.readText(pol.file) : undefined;
        const after = text !== undefined && similar ? replaceOnLine(text, a.line, a.path, similar) : undefined;
        if (after) attach(f, { title: `Change "${a.path}" to "${similar}"`, changes: [{ file: pol.file, before: text!, after }], requiresReview: true });
      }
    }
  }
  if (model.schemaFile) {
    const text = p.readText(model.schemaFile) ?? '';
    const reported = new Set<string>();
    for (const m of model.mappings) {
      if (schemaPaths.includes(m.name) || reported.has(m.name)) continue;
      reported.add(m.name);
      const f = add(
        'AMS006',
        'error',
        `@ams.attributes "${m.name}" is missing from ${model.schemaFile}`,
        `The CDS model maps AMS attribute "${m.name}" to (${m.element}), but ${model.schemaFile} does not define it. With a hand-written schema, CAP requires every mapped attribute to be in it, so "cds build" fails.`,
        `Add "${m.name}" with the type of ${m.element} (String, Number or Boolean) to the SCHEMA in ${model.schemaFile}.`,
        m.file,
        m.line,
      );
      const close = text.lastIndexOf('}');
      if (close > 0) {
        const before = text.slice(0, close).replace(/\s*$/, '');
        const indent = /\{\s*\n([ \t]+)/.exec(text)?.[1] ?? '\t';
        const sep = before.endsWith('{') || before.endsWith(',') ? '' : ',';
        const type = elementType(p.root, m.element);
        const after = `${before}${sep}\n${indent}${m.name}: ${type}\n${text.slice(close)}`;
        attach(f, { title: `Add "${m.name}: ${type}" to ${model.schemaFile} (check the type)`, changes: [{ file: model.schemaFile, before: text, after }], requiresReview: true });
      }
    }
  }
}

/** AMS type for a CDS element, guessed from its declaration ("amount : Decimal(10,2)" -> Number). */
function elementType(root: string, element: string): string {
  const name = element.split('.').pop()?.trim();
  if (!name || !/^\w+$/.test(name)) return 'String';
  for (const abs of cdsFiles(root)) {
    let src = '';
    try {
      src = blankComments(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    const m = new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*(?:cds\\.)?(\\w+)`).exec(src);
    if (!m) continue;
    if (/^(Integer|Int16|Int32|Int64|UInt8|Decimal|Double|DecimalFloat)$/.test(m[1])) return 'Number';
    if (m[1] === 'Boolean') return 'Boolean';
    return 'String';
  }
  return 'String';
}

function deployRules(p: Project, model: AmsModel, cfg: Record<string, any>, usesAmsLib: boolean, auth: string | undefined, add: Add): void {
  const deps = p.dependencies;
  const pkgLoc = p.packageJson ? { file: 'package.json', line: p.jsonKeyLine(p.packageJson, 'dependencies') ?? 1 } : { file: 'package.json', line: 1 };

  // AMS011 – @sap/ams evaluates the policies at runtime, so it must be a runtime dependency
  if (!('@sap/ams' in deps) && (usesAmsLib || (model.files.length && auth === 'ias'))) {
    const devOnly = '@sap/ams' in p.devDependencies;
    const f = add(
      'AMS011',
      'error',
      devOnly ? '@sap/ams is only a dev dependency' : 'AMS policies exist, but @sap/ams is not a dependency',
      devOnly
        ? '@sap/ams is only in devDependencies. Cloud Foundry installs production dependencies only, so the deployed app cannot evaluate AMS policies and users get no roles.'
        : `The project has DCL policies in ${model.dclRoot}, but package.json does not list @sap/ams, so CAP never applies them and users get no roles.`,
      'Add @sap/ams to dependencies (and @sap/ams-dev to devDependencies for local tests), for example with "cds add ams".',
      pkgLoc.file,
      pkgLoc.line,
    );
    if (devOnly && p.packageJson && !p.packageJson.error)
      attach(f, jsonFix(p, 'package.json', 'Move @sap/ams from devDependencies to dependencies', [removeDependency('devDependencies', '@sap/ams'), setDependency('dependencies', '@sap/ams', p.devDependencies['@sap/ams'])], NPM_INSTALL));
  }

  // AMS010 – something must upload the policies to AMS
  if (p.mta && cfg.generatePoliciesDeployer !== false && (model.files.length || usesAmsLib)) {
    const modules = mtaModules(p);
    const identity = mtaResources(p).filter(isIdentity);
    const services = modules.filter(isCapService);
    const isDeployer = (m: (typeof modules)[number]) =>
      /policies-deployer|policy-deployer|ams-deployer/i.test(m.name) ||
      /(^|\/)policies$/.test(m.path ?? '') ||
      m.requires.some((r) => isPlainObject(r.parameters.config) && r.parameters.config['app-identifier'] === 'policy-deployer');
    if (identity.length && services.length && !modules.some(isDeployer)) {
      const id = identity.find((r) => services.some((s) => s.requires.some((q) => q.name === r.name))) ?? identity[0];
      const app = typeof p.mta.data.ID === 'string' ? p.mta.data.ID : services[0].name.replace(/-srv$/, '');
      const name = `${app}-ams-policies-deployer`;
      const f = add(
        'AMS010',
        'error',
        'No module deploys the AMS policies',
        `mta.yaml has no AMS policies deployer module, so the policies in ${model.dclRoot} are never uploaded to AMS. In the cloud no policy can be assigned to users, and every role check fails with 403 Forbidden.`,
        `Run "cds add ams", which adds the "${name}" module (path gen/policies, built by "cds build"), or add it by hand.`,
        p.mta.rel,
        p.yamlLine(['modules']) ?? 1,
      );
      const fix: Fix | undefined = yamlFix(p, `Add module "${name}"`, (doc) => {
        const seq: any = doc.getIn(['modules']);
        if (!seq || typeof seq.add !== 'function') return false;
        const node: any = doc.createNode({
            name,
            type: 'javascript.nodejs',
            path: 'gen/policies',
            parameters: { buildpack: 'nodejs_buildpack', 'no-route': true, 'no-start': true, tasks: [{ name: 'deploy-dcl', command: 'npm start', memory: '512M' }] },
            requires: [{ name: id.name, parameters: { config: { 'credential-type': 'X509_GENERATED', 'app-identifier': 'policy-deployer' } } }],
          });
        // Keep the blank line between modules that most mta.yaml files have.
        if (seq.items.some((x: any, i: number) => i > 0 && x?.spaceBefore)) node.spaceBefore = true;
        seq.add(node);
      });
      if (fix) {
        fix.requiresReview = true;
        fix.followUp = 'Make sure the MTA build runs "cds build --production", which creates gen/policies.';
      }
      attach(f, fix);
    }
  }
}
