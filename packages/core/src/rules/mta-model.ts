import { Project } from '../project';
import { asArray, isPlainObject } from '../util';

export interface MtaRequire {
  name: string;
  idx: number;
  properties: Record<string, any>;
  parameters: Record<string, any>;
}

export interface MtaModule {
  idx: number;
  name: string;
  type?: string;
  path?: string;
  requires: MtaRequire[];
  provides: string[];
  parameters: Record<string, any>;
  properties: Record<string, any>;
  buildParameters: Record<string, any>;
}

export interface MtaResource {
  idx: number;
  name: string;
  type?: string;
  parameters: Record<string, any>;
}

const obj = (v: unknown): Record<string, any> => (isPlainObject(v) ? v : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function mtaModules(p: Project): MtaModule[] {
  return asArray(p.mta?.data.modules).map((m: any, idx) => ({
    idx,
    name: str(m?.name) ?? '',
    type: str(m?.type),
    path: str(m?.path),
    requires: asArray(m?.requires).map((r: any, ridx) => ({
      name: str(r?.name) ?? '',
      idx: ridx,
      properties: obj(r?.properties),
      parameters: obj(r?.parameters),
    })),
    provides: asArray(m?.provides)
      .map((pr: any) => str(pr?.name))
      .filter((n): n is string => !!n),
    parameters: obj(m?.parameters),
    properties: obj(m?.properties),
    buildParameters: obj(m?.['build-parameters']),
  }));
}

export function mtaResources(p: Project): MtaResource[] {
  return asArray(p.mta?.data.resources).map((r: any, idx) => ({
    idx,
    name: str(r?.name) ?? '',
    type: str(r?.type),
    parameters: obj(r?.parameters),
  }));
}

/** All shell commands run in the global before-all build step. */
export function beforeAllCommands(p: Project): { cmd: string; path: (string | number)[] }[] {
  const out: { cmd: string; path: (string | number)[] }[] = [];
  const beforeAll = asArray(obj(p.mta?.data['build-parameters'])['before-all']);
  beforeAll.forEach((b: any, bi) => {
    asArray(b?.commands).forEach((c, ci) => {
      if (typeof c === 'string') out.push({ cmd: c, path: ['build-parameters', 'before-all', bi, 'commands', ci] });
    });
  });
  return out;
}

const service = (r: MtaResource) => str(r.parameters.service);

export const isHdiContainer = (r: MtaResource) =>
  r.type === 'com.sap.xs.hdi-container' ||
  (r.type === 'org.cloudfoundry.managed-service' && service(r) === 'hana' && r.parameters['service-plan'] === 'hdi-shared');

export const isXsuaa = (r: MtaResource) => service(r) === 'xsuaa' || (r.type ?? '').startsWith('com.sap.xs.uaa');
export const isIdentity = (r: MtaResource) => service(r) === 'identity';
export const isDestination = (r: MtaResource) => service(r) === 'destination';

export const isHdbDeployer = (m: MtaModule) => m.type === 'hdb' || m.type === 'com.sap.xs.hdi';
export const isApprouter = (m: MtaModule) => m.type === 'approuter.nodejs';
export const isCapService = (m: MtaModule) =>
  (m.type === 'nodejs' || m.type === 'java') && (/(^|\/)srv(\/|$)/.test(m.path ?? '') || m.name.endsWith('-srv'));

/** The Cloud Foundry service instance name a resource creates. */
export const instanceName = (r: MtaResource) => str(r.parameters['service-name']) ?? r.name;

export const isRepoHost = (r: MtaResource) => service(r) === 'html5-apps-repo' && r.parameters['service-plan'] === 'app-host';
export const isServiceManager = (r: MtaResource) => service(r) === 'service-manager';
export const isSaasRegistry = (r: MtaResource) => service(r) === 'saas-registry';
export const isHtml5App = (m: MtaModule) => m.type === 'html5';
export const isAppContent = (m: MtaModule) => m.type === 'com.sap.application.content';
export const isMtxSidecar = (m: MtaModule) => (m.type === 'nodejs' || m.type === 'java') && /(^|\/)mtx(\/|$)/.test(m.path ?? '');

/** Commands of a module's custom builder. */
export const moduleCommands = (m: MtaModule): string[] => asArray(m.buildParameters.commands).filter((c): c is string => typeof c === 'string');
