import { deepMerge, isPlainObject } from './util';

const PROFILE_KEY = /^\[.+\]$/;

/**
 * Resolves CAP configuration for one profile, the way CAP does:
 * `[profile]` blocks can sit at any level and override their siblings.
 */
export function resolveProfile(cfg: unknown, profile: string): any {
  if (!isPlainObject(cfg)) return cfg;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (PROFILE_KEY.test(k)) continue;
    out[k] = resolveProfile(v, profile);
  }
  const block = cfg[`[${profile}]`];
  if (isPlainObject(block)) deepMerge(out, resolveProfile(block, profile));
  return out;
}

/** Kind of a `cds.requires.<name>` entry, handling the string shorthand (`"db": "hana"`). */
export function requiredKind(resolved: any, name: string): string | undefined {
  const r = resolved?.requires?.[name];
  if (typeof r === 'string') return r;
  if (isPlainObject(r) && typeof r.kind === 'string') return r.kind;
  return undefined;
}

/** Names of required services that are consumed through a BTP destination. */
export function destinationServices(resolved: any): { name: string; destination: string }[] {
  const out: { name: string; destination: string }[] = [];
  const requires = resolved?.requires;
  if (!isPlainObject(requires)) return out;
  for (const [name, r] of Object.entries(requires)) {
    const dest = isPlainObject(r) && isPlainObject(r.credentials) ? r.credentials.destination : undefined;
    if (typeof dest === 'string') out.push({ name, destination: dest });
  }
  return out;
}

export const REAL_AUTH_KINDS = ['xsuaa', 'ias', 'jwt'];
export const MOCK_AUTH_KINDS = ['mocked', 'dummy', 'basic'];
export const HANA_DB_KINDS = ['hana', 'hana-cloud', 'hana-mt'];
export const HANA_DRIVERS = ['@cap-js/hana', 'hdb', '@sap/hana-client'];
