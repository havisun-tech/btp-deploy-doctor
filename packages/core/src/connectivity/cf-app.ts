import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CfError, CfOptions, runCf } from '../cf';

export interface CfTarget {
  api?: string;
  org?: string;
  space?: string;
  spaceGuid?: string;
  user?: string;
}

/** The current "cf target", read from the cf CLI config (CF_HOME/.cf/config.json). */
export function cfTarget(): CfTarget {
  const file = path.join(process.env.CF_HOME || os.homedir(), '.cf', 'config.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    let user: string | undefined;
    try {
      const payload = String(c.AccessToken ?? '').replace(/^bearer\s+/i, '').split('.')[1];
      if (payload) user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).user_name;
    } catch {
      /* no user name */
    }
    return { api: c.Target || undefined, org: c.OrganizationFields?.Name || undefined, space: c.SpaceFields?.Name || undefined, spaceGuid: c.SpaceFields?.GUID || undefined, user };
  } catch {
    return {};
  }
}

/** "cf curl" returns the API's JSON, including error bodies; turn those into CfErrors. */
async function cfCurl(p: string, opts: CfOptions): Promise<any> {
  const out = await runCf(['curl', p], opts);
  let j: any;
  try {
    j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  } catch {
    throw new CfError(`Unexpected answer from "cf curl ${p}": ${out.trim().slice(0, 300)}`);
  }
  if (Array.isArray(j?.errors) && j.errors.length) {
    const e = j.errors[0];
    const hint = e.code === 10003 || e.title === 'CF-NotAuthorized' ? ' Reading an app\'s environment needs the Space Developer role in its space.' : '';
    throw new CfError(`${e.detail ?? e.title ?? 'Cloud Foundry API error'}.${hint}`);
  }
  return j;
}

export interface CfApp {
  name: string;
  guid: string;
  state?: string;
}

/** Apps in the targeted space, sorted by name. */
export async function listApps(opts: CfOptions = {}): Promise<CfApp[]> {
  const t = cfTarget();
  if (!t.spaceGuid) throw new CfError('No Cloud Foundry space is targeted. Run "cf login" (or "cf target -o <org> -s <space>") first.');
  const apps: CfApp[] = [];
  let next: string | undefined = `/v3/apps?space_guids=${t.spaceGuid}&per_page=200&order_by=name`;
  for (let page = 0; next && page < 10; page++) {
    const j = await cfCurl(next, opts);
    for (const a of j.resources ?? []) apps.push({ name: a.name, guid: a.guid, state: a.state });
    const href: string | undefined = j.pagination?.next?.href;
    next = href ? href.slice(href.indexOf('/v3/')) : undefined;
  }
  return apps;
}

/** VCAP_SERVICES of a deployed app in the targeted space. */
export async function appServices(app: string, opts: CfOptions = {}): Promise<unknown> {
  if (!app || app.startsWith('-') || /\s/.test(app)) throw new CfError(`Invalid app name: "${app}"`);
  const t = cfTarget();
  let guid: string | undefined;
  if (t.spaceGuid) {
    const j = await cfCurl(`/v3/apps?space_guids=${t.spaceGuid}&names=${encodeURIComponent(app)}`, opts);
    guid = j.resources?.[0]?.guid;
  } else {
    guid = (await runCf(['app', app, '--guid'], opts)).trim().split('\n').pop()?.trim();
  }
  if (!guid) throw new CfError(`App "${app}" was not found in ${t.org && t.space ? `org "${t.org}", space "${t.space}"` : 'the targeted space'}. Check the name with "cf apps", or target the right space.`);
  const env = await cfCurl(`/v3/apps/${guid}/env`, opts);
  return env.system_env_json?.VCAP_SERVICES ?? {};
}
