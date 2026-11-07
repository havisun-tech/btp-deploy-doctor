import { HANA_DB_KINDS, HANA_DRIVERS, MOCK_AUTH_KINDS, REAL_AUTH_KINDS, requiredKind } from '../cds-config';
import { JsonOp, removeDependency, setDependency } from '../fix/edit';
import { NPM_INSTALL, attach, jsonFix, majorRange } from '../fix/helpers';
import { Project } from '../project';
import { Finding, Fix, Severity } from '../types';
import { isPlainObject } from '../util';
import { isHdbDeployer, mtaModules } from './mta-model';

/** Versions to add when a package is missing entirely, by @sap/cds major version. */
const COMPATIBLE: Record<string, Record<string, string>> = {
  '@cap-js/hana': { '8': '^1', '9': '^2' },
  '@sap/xssec': { '8': '^4', '9': '^4' },
};

/** Moves a package from devDependencies to dependencies, or adds it with a known-compatible version. */
function runtimeDependencyFix(p: Project, name: string): Fix | undefined {
  if (!p.packageJson || p.packageJson.error) return undefined;
  const devVersion = p.devDependencies[name];
  if (devVersion) {
    return jsonFix(p, 'package.json', `Move ${name} from devDependencies to dependencies`, [removeDependency('devDependencies', name), setDependency('dependencies', name, devVersion)], NPM_INSTALL);
  }
  const installed = p.installedVersion(name);
  const cdsMajor = majorRange(p.dependencies['@sap/cds'] ?? p.installedVersion('@sap/cds'))?.slice(1);
  const version = installed ? `^${installed}` : cdsMajor ? COMPATIBLE[name]?.[cdsMajor] : undefined;
  if (!version) return undefined;
  return jsonFix(p, 'package.json', `Add ${name} ${version} to dependencies`, [setDependency('dependencies', name, version)], NPM_INSTALL);
}

/** Moves a real auth setting from the base config into the [production] profile. */
function moveAuthToProductionFix(p: Project): Fix | undefined {
  const sources: [string, typeof p.packageJson, string[]][] = [
    ['package.json', p.packageJson, ['cds']],
    ['.cdsrc.json', p.cdsrc, []],
  ];
  for (const [rel, file, base] of sources) {
    if (!file || file.error) continue;
    const cfg: any = base.reduce((o: any, k) => o?.[k], file.data);
    const requires = cfg?.requires;
    const auth = requires?.auth;
    const kind = typeof auth === 'string' ? auth : auth?.kind;
    if (!REAL_AUTH_KINDS.includes(kind)) continue;
    const ops: JsonOp[] = [{ path: [...base, 'requires', 'auth'], value: undefined }];
    const prodBlock = requires['[production]'];
    const alreadyInProd = cfg['[production]']?.requires?.auth !== undefined || (isPlainObject(prodBlock) && 'auth' in prodBlock);
    if (!alreadyInProd && (prodBlock === undefined || isPlainObject(prodBlock))) {
      ops.push({ path: [...base, 'requires', '[production]', 'auth'], value: auth });
    }
    return jsonFix(p, rel, `Move "auth" under "[production]" in ${rel} (mocked users locally)`, ops);
  }
  return undefined;
}

/** Checks on the CAP configuration and package.json dependencies. */
export function cdsRules(p: Project): Finding[] {
  const out: Finding[] = [];

  for (const f of [p.packageJson, p.cdsrc, p.cdsrcPrivate]) {
    if (f?.error) {
      out.push({ ruleId: 'CDS000', severity: 'error', title: `${f.rel} is not valid JSON`, message: f.error.message, fix: 'Fix the JSON syntax. Trailing commas and comments are not allowed.', location: { file: f.rel, line: f.error.line ?? 1 } });
    }
  }
  if (!p.packageJson || !p.isCap) return out;
  const pkg = p.packageJson;

  const cfgLoc = p.cdsConfigLocation();
  const depsLoc = { file: 'package.json', line: p.jsonKeyLine(pkg, 'dependencies') ?? 1 };
  const add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, location = cfgLoc): Finding => {
    const f: Finding = { ruleId, severity, title, message, fix, location };
    out.push(f);
    return f;
  };

  const deps = p.dependencies;
  const dev = p.devDependencies;
  const inDevOnly = (name: string) => !(name in deps) && name in dev;

  // CDS005 – @sap/cds must be a runtime dependency
  if (!('@sap/cds' in deps)) {
    attach(
      add('CDS005', 'error', '@sap/cds is not a runtime dependency', inDevOnly('@sap/cds') ? '@sap/cds is only in devDependencies. Cloud Foundry installs production dependencies only, so the app crashes with "Cannot find module \'@sap/cds\'".' : 'package.json does not list @sap/cds under dependencies, so the deployed app cannot start.', 'Move @sap/cds to dependencies: npm install @sap/cds', depsLoc),
      runtimeDependencyFix(p, '@sap/cds'),
    );
  }

  const prod = p.cdsFor('production');
  const devCfg = p.cdsFor('development');
  const prodDb = requiredKind(prod, 'db');
  const prodAuth = requiredKind(prod, 'auth');
  const devAuth = requiredKind(devCfg, 'auth');
  const hasHanaDriver = HANA_DRIVERS.some((d) => d in deps);

  // CDS001 – HANA in production needs a driver at runtime
  if (prodDb && HANA_DB_KINDS.includes(prodDb) && !hasHanaDriver) {
    const devOnly = HANA_DRIVERS.filter(inDevOnly);
    attach(
      add('CDS001', 'error', 'HANA is configured but no HANA driver is a runtime dependency', `The production profile uses db kind "${prodDb}", but none of ${HANA_DRIVERS.join(', ')} is in dependencies${devOnly.length ? ` (${devOnly.join(', ')} is only in devDependencies)` : ''}. The service fails to connect at startup.`, 'Run "npm install @cap-js/hana", or "cds add hana" to set up both config and dependency.', depsLoc),
      runtimeDependencyFix(p, devOnly[0] ?? '@cap-js/hana'),
    );
  }

  // CDS002 – real auth needs @sap/xssec
  if (prodAuth && REAL_AUTH_KINDS.includes(prodAuth) && !('@sap/xssec' in deps)) {
    attach(
      add('CDS002', 'error', `Auth kind "${prodAuth}" needs @sap/xssec`, `Production auth is "${prodAuth}", but @sap/xssec is not in dependencies${inDevOnly('@sap/xssec') ? ' (only in devDependencies)' : ''}. Requests fail or the app crashes when validating tokens.`, 'Run "npm install @sap/xssec".', depsLoc),
      runtimeDependencyFix(p, '@sap/xssec'),
    );
  }

  // CDS003 – mta.yaml deploys HANA but CAP production profile does not use it
  const deploysHana = mtaModules(p).some(isHdbDeployer);
  const prodUsesHana = prodDb ? HANA_DB_KINDS.includes(prodDb) : '@cap-js/hana' in deps;
  if (deploysHana && !prodUsesHana) {
    add('CDS003', 'warning', 'mta.yaml deploys HANA, but CAP production does not use it', prodDb ? `The production db kind is "${prodDb}", while mta.yaml has an HDI deployer. The service will not read the tables you deploy.` : 'mta.yaml has an HDI deployer, but the production profile has no db configured and @cap-js/hana is not installed.', 'Run "cds add hana", which sets "[production]": { "db": "hana" } and installs @cap-js/hana.');
  } else if (prodDb === 'sqlite') {
    // CDS007 – sqlite in production
    add('CDS007', 'warning', 'Production uses SQLite', 'Cloud Foundry containers have an ephemeral file system, so SQLite data is lost on every restart, and each instance has its own copy.', 'Use SAP HANA Cloud in production ("cds add hana"). Keep SQLite for development only.');
  }

  // CDS004 – real auth in development breaks cds watch
  if (devAuth && REAL_AUTH_KINDS.includes(devAuth)) {
    attach(
      add('CDS004', 'warning', `Auth kind "${devAuth}" is active in development`, `Local "cds watch" fails with "Authentication kind \\"${devAuth}\\" configured, but no ... instance bound" unless you bind a real instance.`, 'Move the auth setting under "[production]" and use "mocked" locally. To test with real tokens, bind with "cds bind" and run "cds watch --profile hybrid".'),
      moveAuthToProductionFix(p),
    );
  }

  // CDS006 – mock auth in production
  if (prodAuth && MOCK_AUTH_KINDS.includes(prodAuth)) {
    add('CDS006', 'warning', `Production uses "${prodAuth}" authentication`, 'Mock users are active in production, so anyone who knows the mock passwords can call your service.', 'Set "[production]": { "auth": "xsuaa" } (or "ias") and add the matching service with "cds add xsuaa".');
  }

  // CDS008 – Node engine pinned
  if (!pkg.data.engines?.node) {
    add('CDS008', 'info', 'No Node.js version pinned', 'Without engines.node, the Cloud Foundry buildpack picks its default Node version, which changes when SAP updates the buildpack.', 'Add "engines": { "node": "^20 || ^22" } (match your local version).', { file: 'package.json', line: 1 });
  }

  return out;
}
