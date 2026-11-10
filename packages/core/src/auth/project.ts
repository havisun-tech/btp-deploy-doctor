import * as fs from 'fs';
import * as path from 'path';
import { CdsAuth, scanCdsAuth } from '../cds-roles';
import { Project } from '../project';
import { instanceName, isXsuaa, mtaModules, mtaResources } from '../rules/mta-model';

/** Nearest folder at or above `dir` with an mta.yaml, else one with a CAP package.json, else `dir`. */
export function findRoot(dir: string, stopAt?: string): string {
  let capRoot: string | undefined;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'mta.yaml')) || fs.existsSync(path.join(d, 'mta.yml'))) return d;
    if (!capRoot && isCapPackage(path.join(d, 'package.json'))) capRoot = d;
    if (d === stopAt || path.dirname(d) === d) break;
  }
  return capRoot ?? dir;
}

function isCapPackage(file: string): boolean {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !!(p.cds || p.dependencies?.['@sap/cds'] || p.devDependencies?.['@sap/cds']);
  } catch {
    return false;
  }
}

/** What mta.yaml adds on top of this descriptor file at deploy time. */
export interface MtaBinding {
  mtaFile: string;
  resource: string;
  instance: string;
  /** Keys set under parameters.config, which override the file. */
  overrides: string[];
  values: Record<string, unknown>;
  /** Modules that require this XSUAA resource. */
  boundTo: string[];
}

export function mtaBinding(root: string, file: string): MtaBinding | undefined {
  const p = new Project(root);
  if (!p.mta || p.mta.errors.length) return undefined;
  const r = mtaResources(p).find((x) => isXsuaa(x) && typeof x.parameters.path === 'string' && path.resolve(root, x.parameters.path) === path.resolve(file));
  if (!r) return undefined;
  const config = r.parameters.config && typeof r.parameters.config === 'object' ? (r.parameters.config as Record<string, unknown>) : {};
  return {
    mtaFile: p.mta.rel,
    resource: r.name,
    instance: instanceName(r),
    overrides: Object.keys(config),
    values: config,
    boundTo: mtaModules(p).filter((m) => m.requires.some((q) => q.name === r.name)).map((m) => m.name),
  };
}

export function appName(root: string): string {
  const p = new Project(root);
  const id = p.mta?.data.ID ?? p.packageJson?.data.name ?? path.basename(root);
  return String(id).replace(/^@[^/]+\//, '').replace(/[^\w-]/g, '-');
}

export const scanCds = (root: string): CdsAuth => scanCdsAuth(root);
