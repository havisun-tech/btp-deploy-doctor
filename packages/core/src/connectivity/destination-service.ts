import { isPlainObject } from '../util';
import { HttpFn, HttpResponse, httpRequest } from './http';

/** One service binding from VCAP_SERVICES. */
export interface Binding {
  name: string;
  label: string;
  plan?: string;
  instanceName?: string;
  tags: string[];
  credentials: Record<string, any>;
}

/** All bindings in VCAP_SERVICES, flattened. */
export function bindingsOf(vcap: unknown): Binding[] {
  const out: Binding[] = [];
  if (!isPlainObject(vcap)) return out;
  for (const [label, list] of Object.entries(vcap)) {
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!isPlainObject(b)) continue;
      out.push({
        name: String(b.name ?? b.instance_name ?? label),
        label: String(b.label ?? label),
        plan: typeof b.plan === 'string' ? b.plan : undefined,
        instanceName: typeof b.instance_name === 'string' ? b.instance_name : undefined,
        tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
        credentials: isPlainObject(b.credentials) ? b.credentials : {},
      });
    }
  }
  return out;
}

const is = (service: string) => (b: Binding) => b.label === service || b.tags.includes(service);
export const isDestinationBinding = is('destination');
export const isConnectivityBinding = is('connectivity');
export const isXsuaaBinding = is('xsuaa');
export const isIdentityBinding = (b: Binding) => b.label === 'identity' || b.tags.includes('ias');

/** The parts of a destination binding the client needs. Secrets never leave the extension host. */
export interface DestinationCredentials {
  /** Destination service REST endpoint. */
  uri: string;
  /** Token endpoint base URL (XSUAA of the subaccount). */
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  certificate?: string;
  key?: string;
}

export class DestinationServiceError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
  }
}

export function destinationCredentials(b: Binding): DestinationCredentials {
  const c = b.credentials;
  const x509 = c['credential-type'] === 'x509' || (!!c.certificate && !c.clientsecret);
  const base = x509 ? c.certurl ?? c.url : c.url;
  const missing = ['uri', 'clientid', x509 ? 'certificate' : 'clientsecret'].filter((k) => typeof c[k] !== 'string');
  if (typeof base !== 'string') missing.push(x509 ? 'certurl' : 'url');
  if (missing.length) throw new DestinationServiceError(`The binding "${b.name}" has no ${missing.join(', ')} in its credentials, so it cannot be used to call the Destination service.`);
  return {
    uri: String(c.uri).replace(/\/+$/, ''),
    tokenUrl: String(base).replace(/\/+$/, ''),
    clientId: c.clientid,
    clientSecret: x509 ? undefined : c.clientsecret,
    certificate: x509 ? c.certificate : undefined,
    key: x509 ? c.key : undefined,
  };
}

/** Result of the "find destination" call, the same lookup an app makes at runtime. */
export interface FindResult {
  owner?: { SubaccountId?: string; InstanceId?: string | null };
  destinationConfiguration: Record<string, any>;
  authTokens: { type?: string; value?: string; http_header?: { key: string; value: string }; error?: string; expires_in?: string }[];
  certificates?: { Name?: string; Type?: string }[];
}

export function parseJson(res: HttpResponse): any {
  try {
    return JSON.parse(res.body);
  } catch {
    return undefined;
  }
}

/** Short, readable error text from a service response body. */
export function responseMessage(res: HttpResponse): string {
  const j = parseJson(res);
  const msg = j?.ErrorMessage ?? j?.error_description ?? j?.error?.message ?? j?.message ?? j?.error;
  if (typeof msg === 'string' && msg) return msg;
  return res.body.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${res.status}`;
}

export class DestinationService {
  private token?: { value: string; expires: number };
  constructor(readonly creds: DestinationCredentials, private readonly http: HttpFn = httpRequest) {}

  private tls() {
    return this.creds.certificate ? { cert: this.creds.certificate, key: this.creds.key } : {};
  }

  /** Client-credentials token for the Destination service itself. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30000) return this.token.value;
    const url = `${this.creds.tokenUrl}/oauth/token`;
    const base: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const form = (extra: Record<string, string> = {}) => new URLSearchParams({ grant_type: 'client_credentials', client_id: this.creds.clientId, ...extra }).toString();
    // Client IDs of service bindings contain "!" and "|". Send the secret in the form body (as @sap/xssec does);
    // if the server only accepts HTTP Basic, retry with the raw (not URL-encoded) id and secret.
    const attempts: (() => Promise<HttpResponse>)[] = this.creds.clientSecret
      ? [
          () => this.http(url, { method: 'POST', headers: base, body: form({ client_secret: this.creds.clientSecret! }) }),
          () => this.http(url, { method: 'POST', headers: { ...base, Authorization: 'Basic ' + Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64') }, body: form() }),
        ]
      : [() => this.http(url, { method: 'POST', headers: base, body: form(), ...this.tls() })];
    let res!: HttpResponse;
    let j: any;
    for (const attempt of attempts) {
      res = await attempt();
      j = parseJson(res);
      if (res.status === 200 && typeof j?.access_token === 'string') break;
      if (res.status !== 401 && res.status !== 400) break;
    }
    if (res.status !== 200 || typeof j?.access_token !== 'string') {
      throw new DestinationServiceError(`Could not get a token for the Destination service from ${new URL(this.creds.tokenUrl).host} (HTTP ${res.status}): ${responseMessage(res)}`, res.status, res.body);
    }
    this.token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 600) * 1000 };
    return j.access_token;
  }

  private async get(path: string, extra: Record<string, string> = {}): Promise<HttpResponse> {
    const token = await this.accessToken();
    return this.http(`${this.creds.uri}/destination-configuration/v1${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra } });
  }

  /** Destinations defined on subaccount or service-instance level (configuration only, no tokens). */
  async list(level: 'subaccount' | 'instance'): Promise<Record<string, any>[]> {
    const res = await this.get(level === 'subaccount' ? '/subaccountDestinations' : '/instanceDestinations');
    if (res.status !== 200) throw new DestinationServiceError(`Listing ${level} destinations failed (HTTP ${res.status}): ${responseMessage(res)}`, res.status, res.body);
    const j = parseJson(res);
    return Array.isArray(j) ? j.filter(isPlainObject) : [];
  }

  /**
   * Looks up a destination the way an app does at runtime: instance level first, then subaccount,
   * with authentication tokens. A user token is needed for user-dependent authentication types.
   * Returns the raw response so callers can explain non-200 answers.
   */
  async find(name: string, userToken?: string): Promise<{ res: HttpResponse; result?: FindResult }> {
    const res = await this.get(`/destinations/${encodeURIComponent(name)}`, userToken ? { 'X-user-token': userToken } : {});
    const j = parseJson(res);
    if (res.status === 200 && isPlainObject(j) && isPlainObject(j.destinationConfiguration)) {
      return { res, result: { owner: j.owner, destinationConfiguration: j.destinationConfiguration, authTokens: Array.isArray(j.authTokens) ? j.authTokens : [], certificates: j.certificates } };
    }
    return { res };
  }
}
