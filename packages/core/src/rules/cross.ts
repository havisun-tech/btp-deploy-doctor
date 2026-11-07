import { Document } from 'yaml';
import { destinationServices, requiredKind } from '../cds-config';
import { addRequire, addResource } from '../fix/edit';
import { attach, yamlFix } from '../fix/helpers';
import { Project } from '../project';
import { Finding } from '../types';
import { MtaModule, MtaResource, isCapService, isDestination, isIdentity, isXsuaa, mtaModules, mtaResources } from './mta-model';

const requiresAny = (m: MtaModule, res: MtaResource[]) => m.requires.some((r) => res.some((x) => x.name === r.name));

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** Checks that compare CAP configuration with what mta.yaml binds. */
export function crossRules(p: Project): Finding[] {
  if (!p.mta || p.mta.errors.length || !p.isCap) return [];
  const out: Finding[] = [];
  const modules = mtaModules(p);
  const services = modules.filter(isCapService);
  if (!services.length) return out;
  const resources = mtaResources(p);
  const taken = new Set([...modules.map((m) => m.name), ...modules.flatMap((m) => m.provides), ...resources.map((r) => r.name)]);
  const id = String(p.mta.data.ID ?? 'app');
  const prod = p.cdsFor('production');
  const loc = (m: MtaModule) => ({ file: p.mta!.rel, line: p.yamlLine(['modules', m.idx, 'requires']) ?? p.yamlLine(['modules', m.idx]) ?? 1 });

  /** Fix: require an existing resource, or create one and require it. */
  const bindFix = (m: MtaModule, existing: MtaResource[], create: { name: string; resource: Record<string, unknown>; label: string }) =>
    existing.length
      ? yamlFix(p, `Require "${existing[0].name}" from "${m.name}"`, (doc) => addRequire(doc, m.idx, existing[0].name))
      : yamlFix(p, `Add ${create.label} resource "${create.name}" and require it from "${m.name}"`, (doc: Document) => {
          addResource(doc, create.resource);
          addRequire(doc, m.idx, create.name);
        });

  // X001 – production auth needs an auth service bound to the CAP service
  const auth = requiredKind(prod, 'auth');
  if (auth === 'xsuaa' || auth === 'jwt' || auth === 'ias') {
    const ias = auth === 'ias';
    const authRes = resources.filter(ias ? isIdentity : isXsuaa);
    const label = ias ? 'Identity Authentication (identity)' : 'XSUAA';
    const name = uniqueName(`${id}-auth`, taken);
    const parameters: Record<string, unknown> = ias
      ? { service: 'identity', 'service-plan': 'application' }
      : {
          service: 'xsuaa',
          'service-plan': 'application',
          ...(p.exists('xs-security.json') ? { path: './xs-security.json' } : {}),
          config: { xsappname: `${id}-\${org}-\${space}`, 'tenant-mode': 'dedicated' },
        };
    for (const m of services) {
      if (requiresAny(m, authRes)) continue;
      out.push(
        attach(
        {
          ruleId: 'X001',
          severity: 'error',
          title: `"${m.name}" is not bound to ${label}`,
          message: `CAP production auth is "${auth}", but module "${m.name}" does not require ${authRes.length ? `any of: ${authRes.map((r) => r.name).join(', ')}` : `an ${label} resource (none is defined)`}. The app fails at startup with "no ... instance bound".`,
          fix: authRes.length ? `Add "- name: ${authRes[0].name}" under "${m.name}" > requires.` : 'Run "cds add xsuaa" (or "cds add ias") to add the resource, then require it from the service module.',
          location: loc(m),
        },
        bindFix(m, authRes, { name, label: ias ? 'an identity' : 'an XSUAA', resource: { name, type: 'org.cloudfoundry.managed-service', parameters } }),
        ),
      );
    }
  }

  // X002 – destinations need the destination service
  const dests = destinationServices(prod);
  if (dests.length) {
    const destRes = resources.filter(isDestination);
    const name = uniqueName(`${id}-destination`, taken);
    for (const m of services) {
      if (requiresAny(m, destRes)) continue;
      out.push(
        attach(
          {
            ruleId: 'X002',
            severity: 'error',
            title: `"${m.name}" uses destinations but is not bound to the destination service`,
            message: `${dests.map((d) => `"${d.name}" uses destination "${d.destination}"`).join('; ')}. Without a destination service binding, those calls fail at runtime.`,
            fix: destRes.length ? `Add "- name: ${destRes[0].name}" under "${m.name}" > requires.` : 'Run "cds add destination" and require the new resource from the service module. For on-premise systems, also add and bind the connectivity service.',
            location: loc(m),
          },
          bindFix(m, destRes, { name, label: 'a destination', resource: { name, type: 'org.cloudfoundry.managed-service', parameters: { service: 'destination', 'service-plan': 'lite' } } }),
        ),
      );
    }
  }

  return out;
}
