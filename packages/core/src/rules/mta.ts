import { addBeforeAllCommand, addRequire, editJson, levenshtein, setDependency, setScalar } from '../fix/edit';
import { NPM_INSTALL, attach, combine, majorRange, yamlFix } from '../fix/helpers';
import { Project } from '../project';
import { Finding, Severity } from '../types';
import { parseSizeMb } from '../util';
import {
  MtaResource,
  beforeAllCommands,
  isApprouter,
  isCapService,
  isDestination,
  isHdbDeployer,
  isHdiContainer,
  isIdentity,
  isXsuaa,
  mtaModules,
  mtaResources,
} from './mta-model';

/** Default plans for services where one plan is the obvious choice. */
const DEFAULT_PLANS: Record<string, string> = {
  xsuaa: 'application',
  destination: 'lite',
  connectivity: 'lite',
  hana: 'hdi-shared',
  identity: 'application',
  'saas-registry': 'application',
};

const NAME_KINDS: [RegExp, (r: MtaResource) => boolean][] = [
  [/uaa|auth|ias|identity/i, (r) => isXsuaa(r) || isIdentity(r)],
  [/db|hdi|hana/i, isHdiContainer],
  [/dest/i, isDestination],
  [/conn/i, (r) => r.parameters.service === 'connectivity'],
];

/** Likely intended names for an unknown dependency. */
function suggestNames(missing: string, names: string[], resources: MtaResource[]): string[] {
  for (const [re, pred] of NAME_KINDS) {
    if (!re.test(missing)) continue;
    const same = resources.filter(pred).map((r) => r.name);
    if (same.length === 1) return same;
  }
  const limit = Math.max(2, Math.floor(missing.length / 3));
  return names
    .map((n) => [n, levenshtein(missing, n)] as const)
    .filter(([, d]) => d <= limit)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([n]) => n);
}

/** Static checks on mta.yaml. */
export function mtaRules(p: Project): Finding[] {
  const mta = p.mta;
  if (!mta) return [];
  const out: Finding[] = [];
  const add = (
    ruleId: string,
    severity: Severity,
    title: string,
    message: string,
    fix: string | undefined,
    nodePath?: (string | number)[],
  ): Finding => {
    const f: Finding = { ruleId, severity, title, message, fix, location: { file: mta.rel, line: (nodePath && p.yamlLine(nodePath)) || 1 } };
    out.push(f);
    return f;
  };

  // MTA001 – YAML syntax
  if (mta.errors.length) {
    for (const e of mta.errors) {
      out.push({
        ruleId: 'MTA001',
        severity: 'error',
        title: 'mta.yaml is not valid YAML',
        message: e.message,
        fix: 'Fix the YAML syntax. Indentation must use spaces, and list items under modules/resources need a leading "- ".',
        location: { file: mta.rel, line: e.line ?? 1 },
      });
    }
    return out;
  }

  // MTA002 – required top-level fields
  if (!mta.data.ID) {
    add('MTA002', 'error', 'mta.yaml has no ID', 'The MTA build (mbt build) fails without a top-level ID.', 'Add a line like "ID: my-app" at the top of mta.yaml.');
  }
  if (!mta.data['_schema-version']) {
    attach(
      add('MTA002', 'warning', 'mta.yaml has no _schema-version', 'Without _schema-version, the deploy service may interpret the file with an old schema.', "Add \"_schema-version: '3.1'\"."),
      yamlFix(p, "Add _schema-version '3.1'", (doc) => {
        const root: any = doc.contents;
        if (!root?.items) return false;
        const pair: any = doc.createPair('_schema-version', '3.1');
        pair.value.type = 'QUOTE_SINGLE';
        root.items.unshift(pair);
      }),
    );
  }

  const modules = mtaModules(p);
  const resources = mtaResources(p);

  // MTA003 – unique names across modules, resources and provided dependencies
  const seen = new Map<string, string>();
  const claim = (name: string, what: string, nodePath: (string | number)[]) => {
    if (!name) return;
    const prev = seen.get(name);
    if (prev) {
      add('MTA003', 'error', `Duplicate name "${name}"`, `"${name}" is used by a ${prev} and a ${what}. Names must be unique across modules, resources and provided dependencies.`, 'Rename one of them, and update every "requires" entry that refers to it.', nodePath);
    } else seen.set(name, what);
  };
  modules.forEach((m) => {
    claim(m.name, 'module', ['modules', m.idx, 'name']);
    m.provides.forEach((pr) => { if (pr !== m.name) claim(pr, 'provided dependency', ['modules', m.idx, 'provides']); });
  });
  resources.forEach((r) => claim(r.name, 'resource', ['resources', r.idx, 'name']));

  // MTA004 – every requires entry must resolve
  const known = new Set<string>([...modules.map((m) => m.name), ...modules.flatMap((m) => m.provides), ...resources.map((r) => r.name)]);
  for (const m of modules) {
    const alreadyRequired = new Set(m.requires.map((r) => r.name));
    for (const r of m.requires) {
      if (!r.name || known.has(r.name)) continue;
      const placeholder = r.name.includes('${');
      const f = add(
        'MTA004',
        'error',
        `Unknown dependency "${r.name}"`,
        `Module "${m.name}" requires "${r.name}", but no resource or provided dependency has that name.` +
          (placeholder ? ' Placeholders like ${...} are not resolved in dependency names.' : ''),
        `Add a resource named "${r.name}" under resources, or change the name to one that exists: ${[...known].join(', ') || '(none)'}.`,
        ['modules', m.idx, 'requires', r.idx],
      );
      const candidates = suggestNames(r.name, [...known].filter((n) => n !== m.name), resources);
      attach(
        f,
        ...candidates.map((c) =>
          alreadyRequired.has(c)
            ? yamlFix(p, `Remove "${r.name}" ("${m.name}" already requires "${c}")`, (doc) => {
                doc.deleteIn(['modules', m.idx, 'requires', r.idx]);
              })
            : yamlFix(p, `Change "${r.name}" to "${c}"`, (doc) => setScalar(doc, ['modules', m.idx, 'requires', r.idx, 'name'], c)),
        ),
      );
    }
  }

  // MTA005 – module paths exist (or are generated by cds build)
  const commands = beforeAllCommands(p);
  const runsCdsBuild = commands.some((c) => /\bcds\s+build\b/.test(c.cmd));
  let offeredBuildStep = false;
  for (const m of modules) {
    if (!m.path || p.exists(m.path)) continue;
    const generated = /^(\.\/)?gen(\/|$)/.test(m.path);
    if (generated && runsCdsBuild) continue;
    const f = add(
      'MTA005',
      'error',
      `Module path "${m.path}" does not exist`,
      generated
        ? `Module "${m.name}" points to "${m.path}", which only exists after "cds build". mta.yaml has no before-all step that runs it, so the module would be empty and fail with "ENOENT ... package.json".`
        : `Module "${m.name}" points to "${m.path}", which is not in the project.`,
      generated
        ? 'Add to mta.yaml:\nbuild-parameters:\n  before-all:\n    - builder: custom\n      commands:\n        - npx cds build --production'
        : 'Correct the path relative to mta.yaml.',
      ['modules', m.idx, 'path'],
    );
    if (generated && !offeredBuildStep) {
      offeredBuildStep = true;
      attach(f, yamlFix(p, 'Add a before-all step that runs "npx cds build --production"', (doc) => addBeforeAllCommand(doc, 'npx cds build --production')));
    }
  }

  // MTA006 – HDI deployer needs exactly one target container
  const hdiNames = new Set(resources.filter(isHdiContainer).map((r) => r.name));
  for (const m of modules.filter(isHdbDeployer)) {
    const containers = m.requires.filter((r) => hdiNames.has(r.name));
    if (containers.length === 0) {
      const f = add('MTA006', 'error', `Database deployer "${m.name}" has no HDI container`, 'The HDI deployer module does not require any resource of type com.sap.xs.hdi-container, so it has nowhere to deploy to.', `Add a resource with type com.sap.xs.hdi-container (service: hana, service-plan: hdi-shared) and list it under "${m.name}" > requires.`, ['modules', m.idx]);
      if (hdiNames.size === 1) {
        const [only] = hdiNames;
        attach(f, yamlFix(p, `Require "${only}" from "${m.name}"`, (doc) => addRequire(doc, m.idx, only)));
      }
    } else if (containers.length > 1) {
      const hasTarget = 'TARGET_CONTAINER' in m.properties || containers.some((r) => 'TARGET_CONTAINER' in r.properties);
      if (!hasTarget) {
        add('MTA006', 'error', `Database deployer "${m.name}" has several HDI containers`, `It requires ${containers.map((c) => c.name).join(', ')}, but does not say which one is the deploy target.`, `Set properties: TARGET_CONTAINER: ~{${containers[0].name}/...} or move the extra container to an hdbgrants setup.`, ['modules', m.idx]);
      }
    }
  }

  // MTA007 – managed services need service and plan
  for (const r of resources) {
    if (r.type !== 'org.cloudfoundry.managed-service') continue;
    const missing = ['service', 'service-plan'].filter((k) => !r.parameters[k]);
    if (!missing.length) continue;
    const f = add('MTA007', 'error', `Resource "${r.name}" is missing ${missing.join(' and ')}`, 'A managed service resource needs both the service offering and the plan, or creating the instance fails.', 'Add both under parameters, for example "service: xsuaa" and "service-plan: application".', ['resources', r.idx]);
    const plan = DEFAULT_PLANS[String(r.parameters.service)];
    if (missing.length === 1 && missing[0] === 'service-plan' && plan) {
      attach(f, yamlFix(p, `Set service-plan to "${plan}"`, (doc) => doc.setIn(['resources', r.idx, 'parameters', 'service-plan'], plan)));
    }
  }

  // MTA008 – XSUAA security descriptor file exists
  for (const r of resources.filter(isXsuaa)) {
    const file = r.parameters.path;
    if (typeof file === 'string' && !p.exists(file)) {
      const f = add('MTA008', 'error', `Security descriptor "${file}" not found`, `XSUAA resource "${r.name}" points to "${file}", which does not exist, so the service instance cannot be created.`, 'Run "cds add xsuaa" to generate xs-security.json from your @requires annotations, or fix the path.', ['resources', r.idx, 'parameters', 'path']);
      const rel = file.replace(/^\.\//, '');
      const xsappname = String(mta.data.ID ?? 'app').replace(/[^\w.-]/g, '-');
      const content = JSON.stringify({ xsappname, 'tenant-mode': 'dedicated', scopes: [], attributes: [], 'role-templates': [] }, null, 2) + '\n';
      attach(f, { title: `Create a minimal ${rel} (no roles yet)`, changes: [{ file: rel, before: null, after: content }], followUp: 'Add your scopes and role templates, or regenerate it with "cds compile srv --to xsuaa".' });
    }
  }

  // MTA009 – approuter needs xs-app.json
  for (const m of modules.filter(isApprouter)) {
    if (m.path && p.exists(m.path) && !p.exists(`${m.path}/xs-app.json`)) {
      add('MTA009', 'warning', `Approuter "${m.name}" has no xs-app.json`, `"${m.path}/xs-app.json" is missing, so the approuter has no routes and every request returns 404.`, 'Add xs-app.json with routes to your service and UI, or run "cds add approuter".', ['modules', m.idx, 'path']);
    }
  }

  // MTA010 – memory too small for a CAP service
  for (const m of modules.filter(isCapService)) {
    const mb = parseSizeMb(m.parameters.memory);
    if (mb !== undefined && mb < 256) {
      attach(
        add('MTA010', 'warning', `Module "${m.name}" has only ${m.parameters.memory} memory`, 'CAP services usually need at least 256M. Below that, instances are killed with exit status 137 (out of memory) during start.', 'Set parameters: memory: 256M or more.', ['modules', m.idx, 'parameters', 'memory']),
        yamlFix(p, `Set memory of "${m.name}" to 256M`, (doc) => setScalar(doc, ['modules', m.idx, 'parameters', 'memory'], '256M')),
      );
    }
  }

  // MTA011 – how cds build is invoked
  const cdsDkInstalled = '@sap/cds-dk' in p.devDependencies || '@sap/cds-dk' in p.dependencies;
  const dkRange = majorRange(p.dependencies['@sap/cds']);
  const addDk = () =>
    !cdsDkInstalled && dkRange && p.packageJson && !p.packageJson.error
      ? editJson(p, 'package.json', [setDependency('devDependencies', '@sap/cds-dk', dkRange)])
      : undefined;
  for (const c of commands) {
    if (!/\bcds\s+build\b/.test(c.cmd)) continue;
    const trimmed = c.cmd.trim();
    if (/^cds\s/.test(trimmed)) {
      const f = add('MTA011', 'warning', 'cds build relies on a global install', `"${trimmed}" only works where @sap/cds-dk is installed globally. Build machines and CI usually fail with "cds: not found".`, 'Use "npx cds build --production" and add @sap/cds-dk to devDependencies.', c.path);
      const yaml = yamlFix(p, '', (doc) => setScalar(doc, c.path, `npx ${trimmed}`));
      const dk = addDk();
      attach(f, combine(dk ? `Use "npx ${trimmed}" and add @sap/cds-dk ${dkRange} to devDependencies` : `Use "npx ${trimmed}"`, [yaml?.changes[0], dk], dk ? NPM_INSTALL : undefined));
    } else if (/^npx\s/.test(trimmed) && !cdsDkInstalled && !/@sap\/cds-dk@\d/.test(trimmed)) {
      const f = add('MTA011', 'warning', 'cds build uses an unpinned @sap/cds-dk', `"${trimmed}" downloads the latest @sap/cds-dk on every build, which can be a newer major version than your @sap/cds and produce different output.`, 'Add @sap/cds-dk to devDependencies with the same major version as @sap/cds.', c.path);
      attach(f, combine(`Add @sap/cds-dk ${dkRange} to devDependencies`, [addDk()], NPM_INSTALL));
    }
  }

  return out;
}
