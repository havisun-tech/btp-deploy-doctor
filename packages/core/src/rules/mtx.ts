import { addRequire, addResource, setDependency, setScalar } from '../fix/edit';
import { NPM_INSTALL, attach, jsonFix, majorRange, yamlFix } from '../fix/helpers';
import { Project } from '../project';
import { Finding, Fix, Severity } from '../types';
import { isPlainObject } from '../util';
import {
  isApprouter,
  isCapService,
  isHdbDeployer,
  isMtxSidecar,
  isSaasRegistry,
  isServiceManager,
  isXsuaa,
  mtaModules,
  mtaResources,
} from './mta-model';

/** @sap/cds-mtxs major that matches each @sap/cds major. */
const MTXS_FOR_CDS: Record<string, string> = { '7': '^1', '8': '^2', '9': '^3' };
const TENANT_HOST_PATTERN = '^(.*)-${default-uri}';

/** True when CAP multitenancy is switched on for production. */
export function isMultitenant(p: Project): boolean {
  const mt = p.cdsFor('production')?.requires?.multitenancy;
  return mt === true || isPlainObject(mt);
}

/** Static checks for multitenant (SaaS) CAP applications. */
export function mtxRules(p: Project): Finding[] {
  if (!p.packageJson || !p.isCap || !isMultitenant(p)) return [];
  const out: Finding[] = [];
  const add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, location: { file: string; line?: number }): Finding => {
    const f: Finding = { ruleId, severity, title, message, fix, location: { file: location.file, line: location.line ?? 1 } };
    out.push(f);
    return f;
  };
  const pkg = p.packageJson;

  // MT001 – @sap/cds-mtxs at runtime
  if (!('@sap/cds-mtxs' in p.dependencies)) {
    const installed = p.installedVersion('@sap/cds-mtxs');
    const cdsMajor = majorRange(p.dependencies['@sap/cds'])?.slice(1);
    const version = p.devDependencies['@sap/cds-mtxs'] ?? (installed ? `^${installed}` : cdsMajor ? MTXS_FOR_CDS[cdsMajor] : undefined);
    const f = add('MT001', 'error', 'Multitenancy is on, but @sap/cds-mtxs is not a runtime dependency', 'CAP needs @sap/cds-mtxs to onboard tenants. Without it, subscriptions fail and tenant requests cannot find a database.', 'Run "npm install @sap/cds-mtxs" (or "cds add multitenancy").', { file: 'package.json', line: p.jsonKeyLine(pkg, 'dependencies') });
    if (version) {
      const ops = [setDependency('dependencies', '@sap/cds-mtxs', version)];
      if (p.devDependencies['@sap/cds-mtxs']) ops.unshift({ path: ['devDependencies', '@sap/cds-mtxs'], value: undefined });
      attach(f, jsonFix(p, 'package.json', `Add @sap/cds-mtxs ${version} to dependencies`, ops, NPM_INSTALL));
    }
  }

  if (!p.mta || p.mta.errors.length) return out;
  const mtaFile = p.mta.rel;
  const at = (nodePath: (string | number)[]) => ({ file: mtaFile, line: p.yamlLine(nodePath) ?? p.yamlLine(nodePath.slice(0, 2)) });
  const modules = mtaModules(p);
  const resources = mtaResources(p);
  const id = String(p.mta.data.ID ?? 'app');
  const services = modules.filter(isCapService);
  const sidecars = modules.filter(isMtxSidecar);

  // MT002 – XSUAA must be shared
  for (const r of resources.filter(isXsuaa)) {
    const cfgMode = r.parameters.config?.['tenant-mode'];
    const file = typeof r.parameters.path === 'string' ? r.parameters.path.replace(/^\.\//, '') : undefined;
    const fileJson = file ? p.json(file) : undefined;
    const fileMode = fileJson && !fileJson.error ? fileJson.data['tenant-mode'] : undefined;
    const mode = cfgMode ?? fileMode;
    if (mode === 'shared') continue;
    const f = add('MT002', 'error', `XSUAA "${r.name}" is not shared between tenants`, `A multitenant app needs tenant-mode "shared", but it is ${mode ? `"${mode}"` : 'not set (defaults to "dedicated")'}. Subscribing from another subaccount fails.`, 'Set "tenant-mode": "shared" in the XSUAA configuration.', at(['resources', r.idx, 'parameters']));
    let fix: Fix | undefined;
    if (cfgMode !== undefined) fix = yamlFix(p, 'Set tenant-mode: shared', (doc) => setScalar(doc, ['resources', r.idx, 'parameters', 'config', 'tenant-mode'], 'shared'));
    else if (fileJson && !fileJson.error) fix = jsonFix(p, file!, `Set "tenant-mode": "shared" in ${file}`, [{ path: ['tenant-mode'], value: 'shared' }]);
    else fix = yamlFix(p, 'Set tenant-mode: shared', (doc) => doc.setIn(['resources', r.idx, 'parameters', 'config', 'tenant-mode'], 'shared'));
    attach(f, fix);
  }

  // MT003 / MT007 – Service Manager creates the tenant databases
  const sm = resources.filter(isServiceManager);
  if (!sm.length) {
    const name = `${id}-db`;
    const free = !resources.some((r) => r.name === name) && !modules.some((m) => m.name === name);
    const f = add('MT003', 'error', 'No Service Manager resource for tenant databases', 'In a multitenant CAP app, every tenant gets its own HDI container through Service Manager (service-manager, plan container). Without it, onboarding a tenant fails.', 'Add a service-manager resource with plan container and require it from the service and MTX sidecar modules ("cds add multitenancy" does this).', at(['resources']));
    if (free) {
      attach(f, yamlFix(p, `Add Service Manager resource "${name}" and require it`, (doc) => {
        addResource(doc, { name, type: 'org.cloudfoundry.managed-service', parameters: { service: 'service-manager', 'service-plan': 'container' } });
        for (const m of [...services, ...sidecars]) addRequire(doc, m.idx, name);
      }));
    }
  } else {
    for (const m of [...services, ...sidecars]) {
      if (m.requires.some((r) => sm.some((s) => s.name === r.name))) continue;
      attach(
        add('MT007', 'error', `"${m.name}" is not bound to Service Manager`, `"${m.name}" needs the Service Manager binding to find each tenant's database. Without it, tenant requests fail.`, `Add "- name: ${sm[0].name}" under "${m.name}" > requires.`, at(['modules', m.idx, 'requires'])),
        yamlFix(p, `Require "${sm[0].name}" from "${m.name}"`, (doc) => addRequire(doc, m.idx, sm[0].name)),
      );
    }
  }

  // MT009 – a static HDI deployer is single-tenant
  for (const m of modules.filter(isHdbDeployer)) {
    add('MT009', 'warning', `"${m.name}" deploys to a single shared database`, 'In a multitenant app, tenant databases are created and upgraded by the MTX services. A static HDI deployer module only fills one container that no tenant uses.', 'Remove the db-deployer module and its hdi-shared resource, unless you deliberately keep shared data there.', at(['modules', m.idx]));
  }

  // MT004 / MT008 – SaaS registry
  const registries = resources.filter(isSaasRegistry);
  if (!registries.length) {
    add('MT004', 'error', 'No SaaS registry resource', 'Without a saas-registry service, the app does not appear in the subscription list of consumer subaccounts.', 'Run "cds add multitenancy", or add a saas-registry resource (plan application) whose appUrls point to the MTX sidecar.', at(['resources']));
  }
  const xsuaaApp = resources.filter(isXsuaa).map((r) => r.parameters.config?.xsappname).find((x): x is string => typeof x === 'string');
  for (const r of registries) {
    const cfg = r.parameters.config ?? {};
    if (!cfg.appUrls?.onSubscription) {
      add('MT004', 'error', `SaaS registry "${r.name}" has no onSubscription URL`, 'BTP calls appUrls.onSubscription when a consumer subscribes. Without it, the subscription cannot start.', 'Set appUrls.onSubscription to ~{mtx-api/mtx-url}/-/cds/saas-provisioning/tenant/{tenantId} (provided by the MTX sidecar).', at(['resources', r.idx, 'parameters', 'config']));
    }
    if (xsuaaApp && typeof cfg.xsappname === 'string' && cfg.xsappname !== xsuaaApp) {
      attach(
        add('MT008', 'error', `SaaS registry xsappname differs from XSUAA`, `The registry uses "${cfg.xsappname}", but XSUAA uses "${xsuaaApp}". They must be identical, or subscription callbacks are rejected.`, 'Use the same xsappname in both resources.', at(['resources', r.idx, 'parameters', 'config', 'xsappname'])),
        yamlFix(p, `Change to "${xsuaaApp}"`, (doc) => setScalar(doc, ['resources', r.idx, 'parameters', 'config', 'xsappname'], xsuaaApp)),
      );
    }
  }

  // MT005 – the sidecar profile needs a sidecar module
  if (p.cdsProfiles.includes('with-mtx-sidecar') && !sidecars.length) {
    add('MT005', 'error', 'MTX sidecar module missing', 'The project uses the "with-mtx-sidecar" profile, but mta.yaml has no module for the sidecar (path gen/mtx/sidecar). Tenant onboarding and upgrades have nothing to run on.', 'Run "cds add multitenancy" to add the sidecar module, or add a nodejs module with path gen/mtx/sidecar.', at(['modules']));
  }

  // MT006 – approuter must know how to read the tenant from the host
  for (const m of modules.filter(isApprouter)) {
    if ('TENANT_HOST_PATTERN' in m.properties) continue;
    attach(
      add('MT006', 'error', `Approuter "${m.name}" has no TENANT_HOST_PATTERN`, 'The approuter reads the tenant from the subdomain of each request. Without TENANT_HOST_PATTERN, requests from consumer subdomains are rejected or routed to the provider.', `Set properties: TENANT_HOST_PATTERN: "${TENANT_HOST_PATTERN}" on the approuter module, and add a route for each consumer subdomain.`, at(['modules', m.idx])),
      yamlFix(p, 'Add TENANT_HOST_PATTERN', (doc) => doc.setIn(['modules', m.idx, 'properties', 'TENANT_HOST_PATTERN'], TENANT_HOST_PATTERN)),
    );
  }

  return out;
}

