import * as posix from 'path/posix';
import { Document, isSeq } from 'yaml';
import { addRequire, addResource, editJson, editYamlFile, levenshtein, setDependency, setScalar } from '../fix/edit';
import { NPM_INSTALL, attach, combine, jsonFix, yamlFix } from '../fix/helpers';
import { JsonFile, Project, YamlFile } from '../project';
import { Finding, Severity } from '../types';
import { asArray, isPlainObject } from '../util';
import {
  MtaModule,
  MtaResource,
  instanceName,
  isApprouter,
  isAppContent,
  isDestination,
  isHtml5App,
  isLegacyHtml5Deployer,
  joinPath,
  isRepoHost,
  isXsuaa,
  moduleCommands,
  mtaModules,
  mtaResources,
} from './mta-model';

interface DeployEntry {
  deployer: MtaModule;
  /** Index in the deployer's build-parameters.requires. */
  idx: number;
  artifacts: string[];
}

interface Zipper {
  rel: string;
  file: YamlFile;
  taskIdx: number;
  archiveName?: string;
  additionalFiles: string[];
}

interface DestinationEntry {
  module: MtaModule;
  path: (string | number)[];
  entry: Record<string, any>;
}

const npmScripts = (cmd: string) => [...cmd.matchAll(/npm run(?:-script)?\s+([\w:.-]+)/g)].map((m) => m[1]);

/** Static checks for Fiori / UI5 apps deployed to the HTML5 application repository. */
export function fioriRules(p: Project): Finding[] {
  if (!p.mta || p.mta.errors.length) return [];
  const modules = mtaModules(p);
  // Old pattern: a "html5" module that is itself a running approuter app, not repository content.
  const runsApprouter = (m: MtaModule) => {
    const deps = p.json(joinPath(m.path ?? '.', 'package.json'))?.data?.dependencies;
    return isPlainObject(deps) && '@sap/approuter' in deps;
  };
  const apps = modules.filter((m) => isHtml5App(m) && m.path && p.exists(m.path) && !runsApprouter(m));
  if (!apps.length) return [];
  const resources = mtaResources(p);
  const repoHosts = resources.filter(isRepoHost);
  const contentModules = modules.filter(isAppContent);
  const id = String(p.mta.data.ID ?? 'app');
  const mtaFile = p.mta.rel;
  const out: Finding[] = [];
  const add = (ruleId: string, severity: Severity, title: string, message: string, fix: string, location: { file: string; line?: number }): Finding => {
    const f: Finding = { ruleId, severity, title, message, fix, location: { file: location.file, line: location.line ?? 1 } };
    out.push(f);
    return f;
  };
  const mtaAt = (nodePath: (string | number)[]) => {
    for (let n = nodePath.length; n > 0; n--) {
      const line = p.yamlLine(nodePath.slice(0, n));
      if (line) return { file: mtaFile, line };
    }
    return { file: mtaFile, line: 1 };
  };

  // ---- project-wide facts ----
  const deployers = contentModules.filter((m) => asArray(m.buildParameters.requires).some((r: any) => asArray(r?.artifacts).length));
  const deployEntry = (app: MtaModule): DeployEntry | undefined => {
    for (const d of deployers) {
      const reqs = asArray(d.buildParameters.requires);
      const idx = reqs.findIndex((r: any) => r?.name === app.name);
      if (idx >= 0) return { deployer: d, idx, artifacts: asArray(reqs[idx].artifacts).filter((a): a is string => typeof a === 'string') };
    }
    return undefined;
  };

  const destinationEntries: DestinationEntry[] = [];
  for (const m of contentModules) {
    for (const level of ['instance', 'subaccount']) {
      asArray(m.parameters.content?.[level]?.destinations).forEach((entry, k) => {
        if (isPlainObject(entry)) destinationEntries.push({ module: m, path: ['modules', m.idx, 'parameters', 'content', level, 'destinations', k], entry });
      });
    }
  }
  const initDestinations = resources
    .filter(isDestination)
    .flatMap((r) => asArray(r.parameters.config?.init_data?.instance?.destinations).concat(asArray(r.parameters.config?.init_data?.subaccount?.destinations)))
    .filter(isPlainObject);
  const knownDestinations = new Set<string>([...initDestinations, ...destinationEntries.map((d) => d.entry)].map((d) => d.Name).filter((n): n is string => typeof n === 'string'));
  const cloudServices = new Set(destinationEntries.map((d) => d.entry['sap.cloud.service']).filter((s): s is string => typeof s === 'string'));
  const onlyCloudService = cloudServices.size === 1 ? [...cloudServices][0] : undefined;
  const srvDestination = initDestinations.find((d) => typeof d.URL === 'string' && /srv-url|srv-api/.test(d.URL))?.Name as string | undefined;
  // SAP Application Frontend service: serves apps from the repository without Work Zone.
  const usesAppFront = resources.some((r) => r.parameters.service === 'app-front');
  const usesManagedApprouter = !usesAppFront && !modules.some((m) => isApprouter(m) || (isHtml5App(m) && runsApprouter(m)));
  /** Apps are served under their own path prefix, so absolute data source URIs miss the app's routes. */
  const servedUnderAppPath = usesManagedApprouter || usesAppFront;
  /** The older deployer copies the apps into its own folder, which this check cannot trace. */
  const hasLegacyDeployer = modules.some(isLegacyHtml5Deployer);
  const templated = (s: string) => /\$\{|~\{/.test(s);

  const webappDir = (m: MtaModule) => {
    const w = p.yaml(joinPath(m.path!, 'ui5.yaml'))?.data?.resources?.configuration?.paths?.webapp;
    return joinPath(m.path!, typeof w === 'string' ? w : 'webapp');
  };
  const appPackage = (m: MtaModule): JsonFile | undefined => p.json(joinPath(m.path!, 'package.json'));
  const deployConfigRel = (m: MtaModule): string | undefined => {
    const scripts = appPackage(m)?.data.scripts ?? {};
    for (const cmd of moduleCommands(m)) {
      for (const name of npmScripts(cmd)) {
        const cfg = /--config[= ](\S+)/.exec(String(scripts[name] ?? ''));
        if (cfg) return joinPath(m.path!, cfg[1]);
      }
    }
    const def = joinPath(m.path!, 'ui5-deploy.yaml');
    return p.exists(def) ? def : undefined;
  };
  const zipperOf = (m: MtaModule): Zipper | undefined => {
    const rel = deployConfigRel(m);
    const file = rel ? p.yaml(rel) : undefined;
    if (!rel || !file || file.errors.length) return undefined;
    const tasks = asArray(file.data.builder?.customTasks);
    const taskIdx = tasks.findIndex((t: any) => t?.name === 'ui5-task-zipper');
    if (taskIdx < 0) return { rel, file, taskIdx, additionalFiles: [] };
    const cfg = tasks[taskIdx]?.configuration ?? {};
    return {
      rel,
      file,
      taskIdx,
      archiveName: typeof cfg.archiveName === 'string' ? cfg.archiveName : undefined,
      additionalFiles: asArray(cfg.additionalFiles).filter((x): x is string => typeof x === 'string'),
    };
  };

  for (const app of apps) {
    const entry = deployEntry(app);
    const zipper = zipperOf(app);
    const pkg = appPackage(app);
    const archive = zipper?.archiveName ?? entry?.artifacts[0]?.replace(/\.zip$/, '') ?? app.name.replace(/[^\w]/g, '');

    // UI001 – the app must be packaged by a content module
    if (!entry && !hasLegacyDeployer) {
      const f = add('UI001', 'error', `Fiori app "${app.name}" is never deployed`, `The html5 module is built, but no com.sap.application.content module lists it under build-parameters > requires. Its files never reach the HTML5 application repository, so the app does not appear in Work Zone or the cockpit.`, `Add it to the app-content module, or run "cds add html5-repo" / Fiori tools "Add Deploy Config".`, mtaAt(['modules', app.idx]));
      const target = deployers.length === 1 ? deployers[0] : contentModules.filter((m) => m.requires.some((r) => repoHosts.some((h) => h.name === r.name))).length === 1 ? contentModules.find((m) => m.requires.some((r) => repoHosts.some((h) => h.name === r.name))) : undefined;
      if (target) {
        attach(f, yamlFix(p, `Package "${app.name}" in "${target.name}"`, (doc) => {
          const item = { artifacts: [`${archive}.zip`], name: app.name, 'target-path': 'resources/' };
          const seq = doc.getIn(['modules', target.idx, 'build-parameters', 'requires']);
          if (isSeq(seq)) seq.add(doc.createNode(item));
          else doc.setIn(['modules', target.idx, 'build-parameters', 'requires'], doc.createNode([item]));
          if (doc.getIn(['modules', target.idx, 'build-parameters', 'build-result']) === undefined) {
            doc.setIn(['modules', target.idx, 'build-parameters', 'build-result'], 'resources');
          }
        }));
      }
    }

    // UI002 – the artifact name must match the zip the UI5 build produces
    if (entry && zipper?.archiveName && !entry.artifacts.includes(`${zipper.archiveName}.zip`)) {
      const artifactsPath = ['modules', entry.deployer.idx, 'build-parameters', 'requires', entry.idx, 'artifacts'];
      const f = add('UI002', 'error', `Artifact name does not match the UI5 build of "${app.name}"`, `"${entry.deployer.name}" expects ${entry.artifacts.map((a) => `"${a}"`).join(', ') || 'no artifact'}, but ${zipper.rel} creates "${zipper.archiveName}.zip". The MTA build fails because it cannot find the artifact. This usually happens after renaming the app.`, `Make the artifact name and archiveName match.`, mtaAt(artifactsPath));
      if (entry.artifacts.length === 1) attach(f, yamlFix(p, `Use "${zipper.archiveName}.zip"`, (doc) => setScalar(doc, [...artifactsPath, 0], `${zipper.archiveName}.zip`)));
    }

    // UI004 – build scripts referenced by mta.yaml must exist
    for (const cmd of moduleCommands(app)) {
      for (const name of npmScripts(cmd)) {
        if (!pkg) {
          add('UI004', 'error', `"${app.name}" has no package.json`, `mta.yaml runs "${cmd}" in ${app.path}, but there is no package.json there.`, 'Add a package.json with the build script, or fix the module path.', mtaAt(['modules', app.idx, 'path']));
          continue;
        }
        if (pkg.data.scripts?.[name]) continue;
        const f = add('UI004', 'error', `Script "${name}" is missing in ${pkg.rel}`, `mta.yaml runs "${cmd}" to build "${app.name}", but package.json has no "${name}" script. The MTA build fails with "Missing script".`, `Add the script to ${pkg.rel}.`, { file: pkg.rel, line: p.jsonKeyLine(pkg, 'scripts') ?? 1 });
        const deployYaml = (zipper ? posix.relative(app.path!, zipper.rel) : undefined) ?? (p.exists(joinPath(app.path!, 'ui5-deploy.yaml')) ? 'ui5-deploy.yaml' : undefined);
        if (name === 'build:cf' && deployYaml) {
          attach(f, jsonFix(p, pkg.rel, `Add the standard "build:cf" script`, [{ path: ['scripts', 'build:cf'], value: `ui5 build preload --clean-dest --config ${deployYaml} --include-task=generateCachebusterInfo` }]));
        }
      }
    }

    // UI005 – the UI5 build must produce a zip
    if (entry && zipper) {
      if (zipper.taskIdx < 0) {
        const f = add('UI005', 'error', `The UI5 build of "${app.name}" creates no zip`, `${zipper.rel} has no ui5-task-zipper task, so the build produces no "${archive}.zip" for "${entry.deployer.name}" to deploy.`, `Add the ui5-task-zipper custom task to ${zipper.rel}.`, { file: zipper.rel, line: p.yamlLine(['builder'], zipper.file) });
        const yaml = editYamlFile(p, zipper.rel, (doc: Document) => {
          const task = { name: 'ui5-task-zipper', afterTask: 'generateCachebusterInfo', configuration: { archiveName: archive, additionalFiles: ['xs-app.json'] } };
          const seq = doc.getIn(['builder', 'customTasks']);
          if (isSeq(seq)) seq.add(doc.createNode(task));
          else doc.setIn(['builder', 'customTasks'], doc.createNode([task]));
        });
        const dep = pkg && !hasDep(pkg, 'ui5-task-zipper') ? editJson(p, pkg.rel, [setDependency('devDependencies', 'ui5-task-zipper', '^3')]) : undefined;
        attach(f, combine(`Add the ui5-task-zipper task${dep ? ' and dev dependency' : ''}`, [yaml, dep], dep ? NPM_INSTALL : undefined));
      } else if (pkg && !hasDep(pkg, 'ui5-task-zipper')) {
        attach(
          add('UI005', 'error', `ui5-task-zipper is not installed for "${app.name}"`, `${zipper.rel} uses the ui5-task-zipper task, but ${pkg.rel} does not list it. The UI5 build fails because it cannot find the task.`, `Add ui5-task-zipper to devDependencies in ${pkg.rel}.`, { file: pkg.rel, line: p.jsonKeyLine(pkg, 'devDependencies') ?? 1 }),
          jsonFix(p, pkg.rel, 'Add ui5-task-zipper ^3 to devDependencies', [setDependency('devDependencies', 'ui5-task-zipper', '^3')], NPM_INSTALL),
        );
      }
    }

    // UI006 – xs-app.json exists and is packaged
    const webapp = webappDir(app);
    const rootXsApp = joinPath(app.path!, 'xs-app.json');
    const xsAppRel = p.exists(rootXsApp) ? rootXsApp : p.exists(joinPath(webapp, 'xs-app.json')) ? joinPath(webapp, 'xs-app.json') : undefined;
    if (!xsAppRel) {
      const f = add('UI006', 'warning', `Fiori app "${app.name}" has no xs-app.json`, `Without xs-app.json, the approuter does not know how to serve the app or where to send its OData requests, so the app fails to load or its data calls return 404.`, `Create ${rootXsApp} with routes for your service and the HTML5 repository.`, mtaAt(['modules', app.idx, 'path']));
      const routes: Record<string, unknown>[] = [];
      if (srvDestination) routes.push({ source: '^/odata/(.*)$', target: '/odata/$1', destination: srvDestination, authenticationType: 'xsuaa', csrfProtection: false });
      routes.push({ source: '^(.*)$', target: '$1', service: 'html5-apps-repo-rt', authenticationType: 'xsuaa' });
      const content = JSON.stringify({ welcomeFile: '/index.html', authenticationMethod: 'route', routes }, null, 2) + '\n';
      const pack = zipper && zipper.taskIdx >= 0 && !zipper.additionalFiles.includes('xs-app.json') ? addAdditionalFile(p, zipper) : undefined;
      attach(f, combine(`Create xs-app.json with standard routes${srvDestination ? ` (OData via "${srvDestination}")` : ''}`, [{ file: rootXsApp, before: null, after: content }, pack]));
    } else if (xsAppRel === rootXsApp && zipper && zipper.taskIdx >= 0 && !zipper.additionalFiles.includes('xs-app.json')) {
      attach(
        add('UI006', 'warning', `xs-app.json of "${app.name}" is not packaged`, `${rootXsApp} sits outside the webapp folder and is not listed under additionalFiles of ui5-task-zipper, so it is missing from the deployed zip.`, `Add "xs-app.json" to the zipper's additionalFiles in ${zipper.rel}.`, { file: zipper.rel, line: p.yamlLine(['builder', 'customTasks', zipper.taskIdx], zipper.file) }),
        combine('Add xs-app.json to additionalFiles', [addAdditionalFile(p, zipper)]),
      );
    }

    // UI007 – xs-app.json content
    if (xsAppRel) {
      const xsApp = p.json(xsAppRel);
      if (xsApp?.error) {
        add('UI007', 'error', `${xsAppRel} is not valid JSON`, xsApp.error.message, 'Fix the JSON syntax.', { file: xsAppRel, line: xsApp.error.line });
      } else if (xsApp) {
        asArray(xsApp.data.routes).forEach((route: any) => {
          if (!isPlainObject(route)) return;
          const line = p.jsonKeyLine(xsApp, 'routes', String(route.source ?? '')) ?? p.jsonKeyLine(xsApp, 'routes');
          if (typeof route.source === 'string') {
            try {
              new RegExp(route.source);
            } catch (e: any) {
              add('UI007', 'error', `Invalid route pattern "${route.source}"`, `The approuter cannot compile this regular expression: ${e.message}. It rejects the whole xs-app.json.`, 'Fix the regular expression in "source".', { file: xsAppRel, line });
            }
          }
          if (typeof route.destination === 'string' && knownDestinations.size && !knownDestinations.has(route.destination)) {
            const near = [...knownDestinations].find((d) => levenshtein(d.toLowerCase(), route.destination.toLowerCase()) <= 2);
            // A near miss is almost always a typo. Anything else is usually a backend
            // destination created by hand in the BTP cockpit, such as "northwind".
            const f = near
              ? add('UI007', 'warning', `Route uses unknown destination "${route.destination}"`, `mta.yaml defines the destination "${near}", but the route uses "${route.destination}". Destination names are case-sensitive, so requests on this route fail.`, `Change it to "${near}", or create a destination named "${route.destination}".`, { file: xsAppRel, line })
              : add('UI007', 'info', `Route uses destination "${route.destination}" from outside mta.yaml`, `mta.yaml does not create "${route.destination}". Make sure it exists in the BTP cockpit of every subaccount you deploy to, or requests on this route fail.`, 'Create the destination in the BTP cockpit (Connectivity > Destinations), or define it in mta.yaml.', { file: xsAppRel, line });
            if (near) {
              const routeIdx = asArray(xsApp.data.routes).indexOf(route);
              attach(f, jsonFix(p, xsAppRel, `Change to "${near}"`, [{ path: ['routes', routeIdx, 'destination'], value: near }]));
            }
          }
        });
      }
    }

    // UI008 / UI009 – manifest.json
    const manifestRel = joinPath(webapp, 'manifest.json');
    const manifest = p.json(manifestRel);
    if (manifest && !manifest.error) {
      const cloud = manifest.data['sap.cloud'];
      const service = isPlainObject(cloud) && typeof cloud.service === 'string' ? cloud.service : undefined;
      if (!service && (usesManagedApprouter || cloudServices.size > 0)) {
        const f = add('UI008', 'warning', `manifest.json of "${app.name}" has no sap.cloud.service`, 'The managed approuter and Work Zone use "sap.cloud.service" to find the app and its destinations. Without it, the app is not listed under HTML5 Applications and cannot be added to a site.', `Add "sap.cloud": { "public": true, "service": "<your business service name>" } to manifest.json.`, { file: manifestRel, line: p.jsonKeyLine(manifest, 'sap.app') });
        if (onlyCloudService) attach(f, jsonFix(p, manifestRel, `Add sap.cloud.service "${onlyCloudService}"`, [{ path: ['sap.cloud'], value: { public: true, service: onlyCloudService } }]));
      } else if (service && cloudServices.size && !cloudServices.has(service) && ![...cloudServices].some(templated)) {
        const f = add('UI008', 'error', `sap.cloud.service "${service}" does not match mta.yaml`, `The app says its business service is "${service}", but the destinations in mta.yaml use ${[...cloudServices].map((s) => `"${s}"`).join(', ')}. The app cannot reach its repository or authentication destinations and fails to start.`, 'Use the same sap.cloud.service value in manifest.json and in the destination content module.', { file: manifestRel, line: p.jsonKeyLine(manifest, 'sap.cloud') });
        if (onlyCloudService) attach(f, jsonFix(p, manifestRel, `Change to "${onlyCloudService}"`, [{ path: ['sap.cloud', 'service'], value: onlyCloudService }]));
      }

      const sources = manifest.data['sap.app']?.dataSources;
      const absolute = isPlainObject(sources)
        ? Object.entries(sources).filter(([, ds]: [string, any]) => typeof ds?.uri === 'string' && /^\/(?!\/)/.test(ds.uri))
        : [];
      if (absolute.length && servedUnderAppPath) {
        const f = add('UI009', 'warning', `Absolute data source URI in "${app.name}"`, `${absolute.map(([n, ds]: [string, any]) => `"${n}" uses "${ds.uri}"`).join('; ')}. ${usesAppFront ? 'In the Application Frontend service' : 'In the managed approuter and Work Zone'}, the app is served under its own path, so an absolute URI skips the app's xs-app.json routes and returns 404.`, 'Make the URI relative (remove the leading "/"). If you also run the app with "cds watch", check it still loads there.', { file: manifestRel, line: p.jsonKeyLine(manifest, 'dataSources') });
        const fix = jsonFix(p, manifestRel, 'Make the data source URIs relative', absolute.map(([n, ds]: [string, any]) => ({ path: ['sap.app', 'dataSources', n, 'uri'], value: String(ds.uri).replace(/^\/+/, '') })));
        if (fix) fix.requiresReview = true;
        attach(f, fix);
      }
    }

    // UI012 – html5 modules are build-only
    if (!('supported-platforms' in app.buildParameters)) {
      attach(
        add('UI012', 'warning', `"${app.name}" may be deployed as its own app`, 'Without "supported-platforms: []", the html5 module is not marked as build-only, so the deployer can push it to Cloud Foundry as a separate app instead of only packaging it.', 'Add "supported-platforms: []" under the module\'s build-parameters.', mtaAt(['modules', app.idx, 'build-parameters'])),
        yamlFix(p, 'Add supported-platforms: []', (doc) => {
          const node = doc.createNode([]);
          (node as any).flow = true;
          doc.setIn(['modules', app.idx, 'build-parameters', 'supported-platforms'], node);
        }),
      );
    }
  }

  // UI003 – the content module must upload to an app-host repository
  for (const d of deployers) {
    const req = d.requires.find((r) => repoHosts.some((h) => h.name === r.name));
    if (!req) {
      const f = add('UI003', 'error', `"${d.name}" is not bound to an HTML5 repository`, 'The content module packages the Fiori apps, but does not require an html5-apps-repo resource with plan app-host, so there is nowhere to upload them.', 'Add an html5-apps-repo (app-host) resource and require it with "content-target: true".', mtaAt(['modules', d.idx]));
      if (repoHosts.length === 1) {
        attach(f, yamlFix(p, `Require "${repoHosts[0].name}" as content target`, (doc) => addRequire(doc, d.idx, repoHosts[0].name, { 'content-target': true })));
      } else if (!repoHosts.length) {
        const name = uniqueName(`${id}-repo-host`, new Set([...modules.map((m) => m.name), ...resources.map((r) => r.name)]));
        attach(f, yamlFix(p, `Add an HTML5 repository resource "${name}"`, (doc) => {
          addResource(doc, { name, type: 'org.cloudfoundry.managed-service', parameters: { service: 'html5-apps-repo', 'service-plan': 'app-host' } });
          addRequire(doc, d.idx, name, { 'content-target': true });
        }));
      }
    } else if (req.parameters['content-target'] !== true) {
      attach(
        add('UI003', 'error', `"${d.name}" does not upload to "${req.name}"`, `The content module requires the repository "${req.name}" but without "content-target: true", so the app content is not uploaded.`, `Set parameters: content-target: true on that requires entry.`, mtaAt(['modules', d.idx, 'requires', req.idx])),
        yamlFix(p, 'Set content-target: true', (doc) => doc.setIn(['modules', d.idx, 'requires', req.idx, 'parameters', 'content-target'], true)),
      );
    }
  }

  // UI010 – managed approuter needs HTML5Runtime_enabled
  const destRes = resources.filter(isDestination);
  if (usesManagedApprouter && destRes.length === 1 && destRes[0].parameters.config?.HTML5Runtime_enabled !== true) {
    const r = destRes[0];
    attach(
      add('UI010', 'warning', 'HTML5 runtime is not enabled on the destination service', `"${r.name}" lacks config: HTML5Runtime_enabled: true. Without it, the managed approuter and Work Zone cannot serve your Fiori apps.`, 'Set parameters > config > HTML5Runtime_enabled: true on the destination resource.', mtaAt(['resources', r.idx])),
      yamlFix(p, 'Set HTML5Runtime_enabled: true', (doc) => doc.setIn(['resources', r.idx, 'parameters', 'config', 'HTML5Runtime_enabled'], true)),
    );
  }

  // UI011 – destination content must point at real instances and keys
  const instanceNames = new Map(resources.map((r) => [instanceName(r), r]));
  for (const d of destinationEntries) {
    const inst = d.entry.ServiceInstanceName;
    if (typeof inst === 'string' && !instanceNames.has(inst)) {
      const f = add('UI011', 'error', `Destination "${d.entry.Name ?? '?'}" points to unknown instance "${inst}"`, `ServiceInstanceName must be the Cloud Foundry name of a service instance this MTA creates (its service-name, or the resource name). The deployment fails with "service instance not found".`, `Use one of: ${[...instanceNames.keys()].join(', ')}.`, mtaAt([...d.path, 'ServiceInstanceName']));
      const target = pickInstance(inst, String(d.entry.Name ?? ''), resources);
      if (target) attach(f, yamlFix(p, `Change to "${instanceName(target)}"`, (doc) => setScalar(doc, [...d.path, 'ServiceInstanceName'], instanceName(target))));
    }
    const key = d.entry.ServiceKeyName;
    if (typeof key === 'string') {
      const keys = d.module.requires.map((r) => r.parameters['service-key']?.name).filter((k): k is string => typeof k === 'string');
      if (!keys.includes(key)) {
        const res = typeof inst === 'string' ? instanceNames.get(inst) : undefined;
        const match = res && d.module.requires.find((r) => r.name === res.name)?.parameters['service-key']?.name;
        const f = add('UI011', 'error', `Destination "${d.entry.Name ?? '?'}" uses unknown service key "${key}"`, `"${d.module.name}" only creates the service keys ${keys.map((k) => `"${k}"`).join(', ') || '(none)'}. The destination cannot be created.`, `Use the service-key name from the module's requires entry for that service.`, mtaAt([...d.path, 'ServiceKeyName']));
        if (typeof match === 'string') attach(f, yamlFix(p, `Change to "${match}"`, (doc) => setScalar(doc, [...d.path, 'ServiceKeyName'], match)));
      }
    }
  }

  return out;
}

function hasDep(pkg: JsonFile, name: string): boolean {
  return [pkg.data.dependencies, pkg.data.devDependencies].some((d) => isPlainObject(d) && name in d);
}

function addAdditionalFile(p: Project, z: Zipper) {
  return editYamlFile(p, z.rel, (doc) => {
    const path = ['builder', 'customTasks', z.taskIdx, 'configuration', 'additionalFiles'];
    const seq = doc.getIn(path);
    if (isSeq(seq)) seq.add(doc.createNode('xs-app.json'));
    else doc.setIn(path, doc.createNode(['xs-app.json']));
  });
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** Best guess for which resource a destination meant. */
function pickInstance(wrong: string, destName: string, resources: MtaResource[]): MtaResource | undefined {
  const hint = `${wrong} ${destName}`;
  const byKind = /repo|html/i.test(hint) ? resources.filter(isRepoHost) : /uaa|auth/i.test(hint) ? resources.filter(isXsuaa) : [];
  if (byKind.length === 1) return byKind[0];
  const scored = resources.map((r) => [r, levenshtein(wrong, instanceName(r))] as const).sort((a, b) => a[1] - b[1]);
  return scored.length && scored[0][1] <= Math.max(2, Math.floor(wrong.length / 3)) && (scored.length === 1 || scored[1][1] > scored[0][1]) ? scored[0][0] : undefined;
}
