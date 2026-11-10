import { CfOptions } from '../cf';
import { destinationServices } from '../cds-config';
import { Project } from '../project';
import { isPlainObject } from '../util';
import { appServices, cfTarget, CfTarget } from './cf-app';
import {
  Binding,
  bindingsOf,
  destinationCredentials,
  DestinationService,
  DestinationServiceError,
  FindResult,
  isConnectivityBinding,
  isDestinationBinding,
  isIdentityBinding,
  isXsuaaBinding,
  responseMessage,
} from './destination-service';
import { HttpError, HttpFn, httpRequest } from './http';

export type Status = 'ok' | 'info' | 'warning' | 'error' | 'skipped';

export interface Check {
  id: string;
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

export type Level = 'instance' | 'subaccount';

export interface DestinationReport {
  name: string;
  /** Where the destination is defined; undefined when it was not found. */
  level?: Level;
  type?: string;
  proxyType?: string;
  authentication?: string;
  url?: string;
  /** CAP services (cds.requires) that use this destination. */
  usedBy: string[];
  status: Status;
  checks: Check[];
  /** Configuration with passwords and secrets masked. */
  config?: Record<string, string>;
  /** Needs a user's token to get its authentication token. */
  userDependent: boolean;
  /** Whether "Test call" can run from this machine. */
  callable: boolean;
  /** True when the lookup ran with a user token pasted by the developer. */
  testedWithUserToken?: boolean;
}

export interface AppReport {
  app: string;
  target: CfTarget;
  bindings: { destination: string[]; connectivity: string[]; identity: string[] };
  status: Status;
  checks: Check[];
  destinations: DestinationReport[];
  checkedAt: string;
}

const RANK: Record<Status, number> = { error: 4, warning: 3, skipped: 2, info: 1, ok: 0 };
export function worst(checks: { status: Status }[]): Status {
  let w: Status = 'ok';
  for (const c of checks) if (RANK[c.status] > RANK[w]) w = c.status;
  return w;
}

/** HTTP authentication types of the Destination service. */
export const AUTH_TYPES = [
  'NoAuthentication',
  'BasicAuthentication',
  'ClientCertificateAuthentication',
  'PrincipalPropagation',
  'OAuth2ClientCredentials',
  'OAuth2Password',
  'OAuth2UserTokenExchange',
  'OAuth2JWTBearer',
  'OAuth2SAMLBearerAssertion',
  'OAuth2TechnicalUserPropagation',
  'OAuth2RefreshToken',
  'OAuth2AuthorizationCode',
  'SAMLAssertion',
  'SAPAssertionSSO',
];
/** Authentication types that need the calling user's token. */
const USER_DEPENDENT = new Set(['PrincipalPropagation', 'OAuth2UserTokenExchange', 'OAuth2JWTBearer', 'OAuth2SAMLBearerAssertion', 'SAMLAssertion', 'SAPAssertionSSO']);
/** Authentication types for which the Destination service returns a token or header. */
const TOKEN_TYPES = new Set(['BasicAuthentication', 'OAuth2ClientCredentials', 'OAuth2Password', 'OAuth2UserTokenExchange', 'OAuth2JWTBearer', 'OAuth2SAMLBearerAssertion', 'OAuth2TechnicalUserPropagation', 'SAMLAssertion']);
/** Need input this tool cannot provide (an authorization code or a refresh token). */
const NOT_TESTABLE = new Set(['OAuth2AuthorizationCode', 'OAuth2RefreshToken']);

const REQUIRED: Record<string, (string | string[])[]> = {
  BasicAuthentication: ['User', 'Password'],
  OAuth2ClientCredentials: ['clientId', 'tokenServiceURL', ['clientSecret', 'tokenService.KeyStoreLocation']],
  OAuth2Password: ['clientId', 'tokenServiceURL', 'User', 'Password'],
  OAuth2UserTokenExchange: ['clientId', 'tokenServiceURL', ['clientSecret', 'tokenService.KeyStoreLocation']],
  OAuth2JWTBearer: ['clientId', 'tokenServiceURL', ['clientSecret', 'tokenService.KeyStoreLocation']],
  OAuth2SAMLBearerAssertion: ['tokenServiceURL', 'audience', 'clientKey'],
  ClientCertificateAuthentication: ['KeyStoreLocation'],
};

const SECRET = /password|secret/i;
export function maskConfig(cfg: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = SECRET.test(k) ? '••••••' : typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|\.(local|internal|corp|lan|intranet|localdomain)$/i;

export interface ConfigContext {
  connectivityBound: boolean;
  identityBound: boolean;
}

/** Checks of a destination's configuration that need no network call. */
export function configChecks(cfg: Record<string, any>, ctx: ConfigContext): Check[] {
  const out: Check[] = [];
  const type = cfg.Type;
  if (type && type !== 'HTTP') {
    out.push({ id: 'type', status: 'info', title: `${type} destination`, detail: 'Only HTTP destinations are checked.' });
    return out;
  }
  if (!type) out.push({ id: 'type', status: 'warning', title: 'Type is not set', fix: 'Set "Type" to "HTTP".' });

  const proxy = cfg.ProxyType;
  const auth = cfg.Authentication;
  let url: URL | undefined;
  if (typeof cfg.URL !== 'string' || !cfg.URL) out.push({ id: 'url', status: 'error', title: 'URL is missing', fix: 'Set the "URL" of the system this destination points to.' });
  else {
    try {
      url = new URL(cfg.URL);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      url = undefined;
      out.push({ id: 'url', status: 'error', title: `URL "${cfg.URL}" is not a valid http(s) URL`, fix: 'Use a full URL such as https://api.example.com or, for on-premise systems, http://virtual-host:port.' });
    }
  }

  if (!proxy) out.push({ id: 'proxy', status: 'warning', title: 'ProxyType is not set', fix: 'Set "ProxyType" to "Internet" for systems reachable on the internet, or "OnPremise" for systems behind the Cloud Connector.' });
  else if (proxy === 'OnPremise') {
    if (!ctx.connectivityBound) {
      out.push({
        id: 'connectivity',
        status: 'error',
        title: 'The app is not bound to the Connectivity service',
        detail: 'OnPremise destinations are called through the connectivity proxy, which the app only finds through a Connectivity service binding. Without it, calls fail before they reach the Cloud Connector.',
        fix: 'Add a resource with "service: connectivity" and "service-plan: lite" to mta.yaml and require it from the app module, then redeploy. For an app deployed with cf push: "cf create-service connectivity lite <name>", "cf bind-service <app> <name>" and "cf restage <app>".',
      });
    }
    if (url?.protocol === 'https:') {
      out.push({
        id: 'onprem-https',
        status: 'warning',
        title: 'OnPremise destination uses https://',
        detail: 'The connection from BTP to the Cloud Connector is already encrypted. The URL should point to the virtual host with http://, and the Cloud Connector mapping decides whether it calls the backend over HTTP or HTTPS.',
        fix: 'Change the URL to http://<virtual host>:<virtual port>, and set the protocol to the backend in the Cloud Connector mapping.',
      });
    }
    const loc = cfg.CloudConnectorLocationId;
    out.push({
      id: 'cloud-connector',
      status: 'info',
      title: loc ? `Cloud Connector location ID "${loc}"` : 'Cloud Connector without a location ID',
      detail: `The Cloud Connector cannot be checked from here. In the BTP cockpit, under Connectivity > Cloud Connectors, a connector${loc ? ` with location ID "${loc}" (exact match)` : ' without a location ID'} must be connected, and in the Cloud Connector, ${url ? `the virtual host "${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}"` : 'the virtual host and port of this URL'} must be mapped and its resource path allowed.`,
    });
  } else if (proxy === 'Internet') {
    // a host without a dot (e.g. "erp-virtual") cannot be resolved on the internet
    if (url && (PRIVATE_HOST.test(url.hostname) || (!url.hostname.includes('.') && !url.hostname.startsWith('[')))) {
      out.push({
        id: 'private-host',
        status: 'warning',
        title: `"${url.hostname}" looks like an internal host`,
        detail: 'Internet destinations are called directly from BTP and cannot reach hosts in a private network.',
        fix: 'If the system is on premise, set "ProxyType" to "OnPremise", expose it in the Cloud Connector and use its virtual host in the URL.',
      });
    }
  } else out.push({ id: 'proxy', status: 'warning', title: `Unknown ProxyType "${proxy}"`, fix: 'Use "Internet", "OnPremise" or "PrivateLink".' });

  if (!auth) out.push({ id: 'auth', status: 'error', title: 'Authentication is not set', fix: 'Set "Authentication", for example "NoAuthentication", "BasicAuthentication" or "OAuth2ClientCredentials".' });
  else if (!AUTH_TYPES.includes(auth)) out.push({ id: 'auth', status: 'warning', title: `Unknown authentication type "${auth}"`, fix: `Use one of: ${AUTH_TYPES.join(', ')}.` });
  else {
    const missing = (REQUIRED[auth] ?? []).filter((r) => (Array.isArray(r) ? !r.some((k) => cfg[k]) : !cfg[r])).map((r) => (Array.isArray(r) ? r.join(' or ') : r));
    if (missing.length) out.push({ id: 'auth-props', status: 'error', title: `${auth} needs ${missing.map((m) => `"${m}"`).join(', ')}`, fix: `Add ${missing.length === 1 ? 'this property' : 'these properties'} to the destination.` });
    if (auth === 'PrincipalPropagation' && proxy && proxy !== 'OnPremise') {
      out.push({ id: 'pp-proxy', status: 'error', title: 'PrincipalPropagation only works with ProxyType OnPremise', fix: 'For cloud systems, use OAuth2SAMLBearerAssertion or OAuth2UserTokenExchange instead.' });
    }
    if (USER_DEPENDENT.has(auth) && !ctx.identityBound) {
      out.push({
        id: 'user-token',
        status: 'warning',
        title: `${auth} needs the user's token, but the app is not bound to XSUAA or Identity Authentication`,
        detail: 'The app can only pass on a user it has authenticated.',
        fix: 'Bind the app to the XSUAA (or IAS) instance that logs users in, and make sure the approuter forwards the token.',
      });
    }
    if (auth === 'PrincipalPropagation') {
      out.push({
        id: 'pp-info',
        status: 'info',
        title: 'Principal propagation',
        detail: 'The app sends the user token to the connectivity proxy, and the Cloud Connector maps it to a backend user with a short-lived certificate. Check in the Cloud Connector that principal propagation is configured for this subaccount and that the backend trusts the Cloud Connector\'s certificate.',
      });
    }
  }
  return out;
}

/** Explains why the Destination service could not get an authentication token. */
export function explainTokenError(error: string, auth?: string): { detail: string; fix: string } {
  const e = error;
  if (/invalid_client|bad credentials|client authentication failed/i.test(e) || (/\b401\b|unauthorized/i.test(e) && !/invalid_grant/i.test(e))) {
    return { detail: 'The token service rejected the client.', fix: 'Check clientId and clientSecret (or the client certificate), and that tokenServiceURL belongs to the same OAuth client.' };
  }
  if (/invalid_grant/i.test(e)) {
    if (auth === 'OAuth2Password') return { detail: 'The token service rejected the user or password.', fix: 'Check the User and Password properties, and that the user is not locked.' };
    return {
      detail: 'The token service did not accept the user token or assertion.',
      fix: 'The user token must be valid and issued by the identity provider of this subaccount, and the target system must trust it. Check the trust configuration between the two systems.',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|UnknownHost|getaddrinfo|Name or service not known|could not resolve/i.test(e)) {
    return { detail: 'The host in tokenServiceURL cannot be resolved.', fix: 'Check the host name in tokenServiceURL. If the token service is on premise, set tokenServiceURLType and use the Cloud Connector.' };
  }
  if (/timed? ?out|ETIMEDOUT|ECONNREFUSED|connection refused/i.test(e)) {
    return { detail: 'The token service could not be reached.', fix: 'Check the host and port in tokenServiceURL, and that the token service is reachable from the internet.' };
  }
  if (/certificate|PKIX|SSL|TLS|handshake/i.test(e)) {
    return { detail: 'The TLS connection to the token service failed.', fix: 'The token service\'s certificate must be trusted: upload its CA as a trust store in the destination. For client certificates, check that the key store file exists and its password is right.' };
  }
  if (/\b404\b|not found/i.test(e)) {
    return { detail: 'The token service URL points to a path that does not exist.', fix: 'Check tokenServiceURL; it usually ends in /oauth/token or /oauth2/token.' };
  }
  return { detail: 'The Destination service could not get a token for this destination.', fix: 'Read the message from the token service above, and check the OAuth properties of the destination.' };
}

/** Checks of the runtime lookup: is it found, and did the Destination service get the tokens? */
export function lookupChecks(name: string, auth: string | undefined, lookup: { status: number; message?: string; result?: FindResult }, withUserToken: boolean): Check[] {
  const out: Check[] = [];
  if (!lookup.result) {
    if (lookup.status === 404) {
      out.push({ id: 'lookup', status: 'error', title: `Lookup of "${name}" failed: not found`, detail: lookup.message, fix: 'The app looks destinations up by exact name. Check the spelling, including case.' });
    } else {
      out.push({ id: 'lookup', status: 'error', title: `Lookup of "${name}" failed (HTTP ${lookup.status})`, detail: lookup.message });
    }
    return out;
  }
  const r = lookup.result;
  out.push({ id: 'lookup', status: 'ok', title: `Found by the runtime lookup${r.owner ? ` (${r.owner.InstanceId ? 'service instance' : 'subaccount'} level)` : ''}` });
  if (r.destinationConfiguration.KeyStoreLocation && !(r.certificates ?? []).some((c) => c.Name === r.destinationConfiguration.KeyStoreLocation)) {
    out.push({ id: 'keystore', status: 'error', title: `Certificate "${r.destinationConfiguration.KeyStoreLocation}" was not found`, fix: 'Upload the certificate under Connectivity > Destinations > Certificates on the same level as the destination, with exactly this name.' });
  }
  const userDependent = !!auth && USER_DEPENDENT.has(auth);
  const errors = r.authTokens.filter((t) => t.error);
  if (userDependent && !withUserToken && auth !== 'PrincipalPropagation') {
    out.push({
      id: 'token',
      status: 'skipped',
      title: 'Token exchange not tested: needs a user token',
      detail: `${auth} exchanges the logged-in user's token. Paste a user token to test the exchange.`,
    });
    return out;
  }
  for (const t of errors) {
    const x = explainTokenError(t.error!, auth);
    out.push({ id: 'token', status: 'error', title: 'The Destination service could not get a token', detail: `${t.error}\n\n${x.detail}`, fix: x.fix });
  }
  const good = r.authTokens.filter((t) => !t.error && (t.value || t.http_header));
  if (good.length) {
    const t = good[0];
    const exp = Number(t.expires_in);
    out.push({ id: 'token', status: 'ok', title: `Got ${t.type ? `a ${t.type}` : 'an authentication'} token${exp ? ` (valid for ${exp >= 120 ? `${Math.round(exp / 60)} min` : `${exp} s`})` : ''}${withUserToken ? ' using the pasted user token' : ''}` });
  } else if (!errors.length && auth && TOKEN_TYPES.has(auth)) {
    out.push({ id: 'token', status: 'warning', title: 'No authentication token was returned', detail: `For ${auth}, the Destination service normally returns a token or header with the lookup.` });
  }
  return out;
}

export interface CapDestination {
  service: string;
  destination: string;
}

/** Destinations the CAP project uses in production (cds.requires.<service>.credentials.destination). */
export function capDestinations(root: string): { uses: CapDestination[]; multitenant: boolean } {
  try {
    const prod = new Project(root).cdsFor('production');
    const mt = prod?.requires?.multitenancy;
    return { uses: destinationServices(prod).map((d) => ({ service: d.name, destination: d.destination })), multitenant: !!mt && mt !== false };
  } catch {
    return { uses: [], multitenant: false };
  }
}

export interface CheckOptions {
  cf?: CfOptions;
  /** CAP project folder, to include the destinations it uses. */
  projectRoot?: string;
  http?: HttpFn;
  /** Limit the check to these destination names. */
  only?: string[];
}

const label = (bs: Binding[]) => bs.map((b) => b.instanceName ?? b.name);

/**
 * Checks one deployed app's destinations, keeping the Destination service client
 * for follow-up actions (test call, user token). Credentials stay in memory.
 */
export class ConnectivitySession {
  report!: AppReport;
  private service?: DestinationService;
  private configs = new Map<string, { level: Level; cfg: Record<string, any> }>();
  private ctx!: ConfigContext;
  private http: HttpFn;

  private constructor(readonly app: string, readonly target: CfTarget, private readonly bindings: Binding[], private readonly opts: CheckOptions) {
    this.http = opts.http ?? httpRequest;
  }

  /** Reads the app's bindings with the cf CLI and runs all checks. */
  static async forApp(app: string, opts: CheckOptions = {}): Promise<ConnectivitySession> {
    const vcap = await appServices(app, opts.cf);
    return ConnectivitySession.fromServices(app, vcap, opts, cfTarget());
  }

  /** Runs all checks with a given VCAP_SERVICES (used by tests and for service keys). */
  static async fromServices(app: string, vcap: unknown, opts: CheckOptions = {}, target: CfTarget = {}): Promise<ConnectivitySession> {
    const s = new ConnectivitySession(app, target, bindingsOf(vcap), opts);
    await s.run();
    return s;
  }

  private async run() {
    const dest = this.bindings.filter(isDestinationBinding);
    const conn = this.bindings.filter(isConnectivityBinding);
    const ident = this.bindings.filter((b) => isXsuaaBinding(b) || isIdentityBinding(b));
    this.ctx = { connectivityBound: conn.length > 0, identityBound: ident.length > 0 };
    const checks: Check[] = [];
    const cap = this.opts.projectRoot ? capDestinations(this.opts.projectRoot) : { uses: [], multitenant: false };
    const usedBy = (name: string) => cap.uses.filter((u) => u.destination === name).map((u) => u.service);

    this.report = {
      app: this.app,
      target: this.target,
      bindings: { destination: label(dest), connectivity: label(conn), identity: label(ident) },
      status: 'ok',
      checks,
      destinations: [],
      checkedAt: new Date().toISOString(),
    };

    if (!dest.length) {
      checks.push({
        id: 'destination-binding',
        status: 'error',
        title: `"${this.app}" is not bound to the Destination service`,
        detail: 'The app cannot look up any destination at runtime.',
        fix: 'Add a resource with "service: destination" (plan "lite") to mta.yaml, require it from the app module, and redeploy. Deploy Doctor reports this before deploying as X002.',
      });
      this.report.destinations = cap.uses.map((u) => ({ name: u.destination, usedBy: usedBy(u.destination), status: 'skipped' as Status, checks: [], userDependent: false, callable: false }));
      this.finish();
      return;
    }
    checks.push({ id: 'destination-binding', status: 'ok', title: `Bound to the Destination service (${label(dest).join(', ')})` });
    if (dest.length > 1) checks.push({ id: 'destination-bindings', status: 'warning', title: `${dest.length} Destination service bindings`, detail: 'Libraries such as the SAP Cloud SDK use the first binding, so destinations defined on the other instances may not be found. This check uses the first one.' });
    checks.push(
      conn.length
        ? { id: 'connectivity-binding', status: 'ok', title: `Bound to the Connectivity service (${label(conn).join(', ')})` }
        : { id: 'connectivity-binding', status: 'info', title: 'Not bound to the Connectivity service', detail: 'Only needed for OnPremise destinations (through the Cloud Connector).' },
    );
    if (cap.multitenant) {
      checks.push({ id: 'multitenant', status: 'info', title: 'Multitenant app', detail: 'For subscriber requests, CAP looks destinations up in the subscriber\'s subaccount, which this check cannot see. It shows the provider subaccount\'s destinations.' });
    }

    try {
      this.service = new DestinationService(destinationCredentials(dest[0]), this.http);
      await this.service.accessToken();
    } catch (e) {
      checks.push({ id: 'destination-token', status: 'error', title: 'Could not call the Destination service', detail: errorText(e), fix: 'Check that the binding is current: run "cf restage" after recreating the service instance, or rebind it.' });
      this.finish();
      return;
    }

    for (const level of ['instance', 'subaccount'] as Level[]) {
      try {
        for (const cfg of await this.service.list(level)) {
          const name = cfg.Name;
          if (typeof name !== 'string') continue;
          if (this.configs.has(name)) {
            checks.push({ id: 'duplicate', status: 'info', title: `"${name}" exists on instance and subaccount level`, detail: 'The lookup uses the instance-level destination.' });
            continue;
          }
          this.configs.set(name, { level, cfg });
        }
      } catch (e) {
        checks.push({ id: `list-${level}`, status: 'warning', title: `Could not list ${level}-level destinations`, detail: errorText(e) });
      }
    }

    const names = [...new Set([...cap.uses.map((u) => u.destination), ...this.configs.keys()])].filter((n) => !this.opts.only || this.opts.only.includes(n));
    if (!names.length) checks.push({ id: 'none', status: 'info', title: 'No destinations found', detail: 'Neither the subaccount nor the destination service instance defines any destination.' });
    this.report.destinations = await mapLimit(names, 6, (n) => this.checkDestination(n, undefined, usedBy(n)));
    this.finish();
  }

  private finish() {
    const r = this.report;
    r.destinations.sort((a, b) => RANK[b.status] - RANK[a.status] || a.name.localeCompare(b.name));
    r.status = worst([...r.checks, ...r.destinations]);
  }

  /** (Re)checks one destination, optionally with a user token for user-dependent authentication. */
  async checkDestination(name: string, userToken?: string, usedBy?: string[]): Promise<DestinationReport> {
    usedBy ??= this.report.destinations.find((d) => d.name === name)?.usedBy ?? [];
    const known = this.configs.get(name);
    const cfg = known?.cfg;
    const auth: string | undefined = cfg?.Authentication;
    const rep: DestinationReport = {
      name,
      level: known?.level,
      type: cfg?.Type,
      proxyType: cfg?.ProxyType,
      authentication: auth,
      url: cfg?.URL,
      usedBy,
      status: 'ok',
      checks: [],
      config: cfg ? maskConfig(cfg) : undefined,
      userDependent: !!auth && USER_DEPENDENT.has(auth),
      callable: !!cfg && (cfg.Type ?? 'HTTP') === 'HTTP' && cfg.ProxyType !== 'OnPremise' && !!cfg.URL && !NOT_TESTABLE.has(auth ?? ''),
      testedWithUserToken: !!userToken,
    };
    if (usedBy.length) rep.checks.push({ id: 'used', status: 'info', title: `Used by CAP service${usedBy.length > 1 ? 's' : ''} ${usedBy.map((u) => `"${u}"`).join(', ')}` });

    if (!cfg) {
      const all = [...this.configs.keys()];
      const near = all.find((k) => k.toLowerCase() === name.toLowerCase());
      const similar = near ? [] : similarNames(name, all);
      const where = 'It is defined neither in the subaccount nor in the destination service instance the app is bound to.';
      rep.checks.push({
        id: 'exists',
        status: 'error',
        title: `Destination "${name}" does not exist`,
        detail: near
          ? `A destination named "${near}" exists. Names must match exactly, including case.`
          : similar.length
            ? `${where} Similar names: ${similar.map((n) => `"${n}"`).join(', ')}.`
            : where,
        fix: near ? `Use "${near}" in cds.requires, or rename the destination to "${name}".` : `Create "${name}" in the BTP cockpit under Connectivity > Destinations, or fix the name in cds.requires.`,
      });
      rep.status = worst(rep.checks);
      return rep;
    }
    const config = configChecks(cfg, this.ctx);
    if ((cfg.Type ?? 'HTTP') === 'HTTP') {
      if (NOT_TESTABLE.has(auth ?? '')) {
        rep.checks.push({ id: 'token', status: 'skipped', title: `${auth} cannot be tested here`, detail: 'It needs an authorization code or refresh token from an interactive login.' });
      } else {
        try {
          const { res, result } = await this.service!.find(name, userToken);
          rep.checks.push(...lookupChecks(name, auth, { status: res.status, message: result ? undefined : responseMessage(res), result }, !!userToken));
        } catch (e) {
          rep.checks.push({ id: 'lookup', status: 'error', title: 'The lookup failed', detail: errorText(e) });
        }
      }
    }
    rep.checks.push(...config);
    rep.status = worst(rep.checks);
    const i = this.report?.destinations.findIndex((d) => d.name === name) ?? -1;
    if (i >= 0) {
      this.report.destinations[i] = rep;
      this.report.status = worst([...this.report.checks, ...this.report.destinations]);
    }
    return rep;
  }

  /**
   * Calls an Internet destination from this machine with the headers the Destination service returns,
   * like the app would. Only runs when the developer asks for it.
   */
  async testCall(name: string, opts: { path?: string; userToken?: string } = {}): Promise<Check> {
    const known = this.configs.get(name);
    if (!known || !this.service) return { id: 'call', status: 'error', title: `Destination "${name}" is not available` };
    const cfg = known.cfg;
    if (cfg.ProxyType === 'OnPremise') {
      return { id: 'call', status: 'skipped', title: 'OnPremise systems cannot be called from here', detail: 'They are only reachable from inside Cloud Foundry, through the connectivity proxy and the Cloud Connector. Check the Cloud Connector\'s audit and trace logs, or the app logs.' };
    }
    const { res, result } = await this.service.find(name, opts.userToken);
    if (!result) return { id: 'call', status: 'error', title: `Lookup failed (HTTP ${res.status})`, detail: responseMessage(res) };
    const failed = result.authTokens.find((t) => t.error);
    if (failed) return { id: 'call', status: 'skipped', title: 'Not called: the Destination service could not get a token', detail: failed.error, fix: 'Fix the token problem first; a call without credentials would only show a misleading 401.' };
    const headers: Record<string, string> = { Accept: 'application/json, application/xml;q=0.9, */*;q=0.8' };
    const tok = result.authTokens.find((t) => !t.error && (t.http_header || t.value));
    if (tok?.http_header) headers[tok.http_header.key] = tok.http_header.value;
    else if (tok?.value) headers.Authorization = `${tok.type ?? 'Bearer'} ${tok.value}`;
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(result.destinationConfiguration)) {
      if (k.startsWith('URL.headers.') && typeof v === 'string') headers[k.slice(12)] = v;
      if (k.startsWith('URL.queries.') && typeof v === 'string') query.set(k.slice(12), v);
    }
    const base = String(result.destinationConfiguration.URL).replace(/\/+$/, '');
    const extra = (opts.path ?? '').trim();
    let url = extra ? `${base}/${extra.replace(/^\/+/, '')}` : base;
    if ([...query].length) url += (url.includes('?') ? '&' : '?') + query.toString();
    const shown = url.replace(/([?&][^=]*(?:key|token|secret|password)[^=]*=)[^&]*/gi, '$1••••••');
    try {
      const r = await this.http(url, { headers, timeoutMs: 20000 });
      return explainResponse(r.status, shown, r.headers, cfg.Authentication, r.body);
    } catch (e) {
      return explainNetworkError(e, shown);
    }
  }
}

/** Names that differ by a prefix/suffix or a few characters, best first. */
export function similarNames(name: string, names: string[]): string[] {
  const a = name.toLowerCase();
  const dist = (x: string, y: string) => {
    const d = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const t = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    return d[y.length];
  };
  return names
    .map((n) => ({ n, b: n.toLowerCase() }))
    .map(({ n, b }) => ({ n, score: b.includes(a) || a.includes(b) ? 1 : dist(a, b) }))
    .filter((x) => x.score <= Math.max(2, Math.floor(a.length / 4)))
    .sort((x, y) => x.score - y.score)
    .slice(0, 3)
    .map((x) => x.n);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function errorText(e: unknown): string {
  if (e instanceof DestinationServiceError || e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function explainResponse(status: number, url: string, headers: Record<string, string | string[] | undefined>, authType: string | undefined, body = ''): Check {
  const ct = String(headers['content-type'] ?? '').split(';')[0];
  const head = `GET ${url}\nHTTP ${status}${ct ? ` · ${ct}` : ''}`;
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  const detail = (text: string) => `${head}\n\n${text}${snippet && status >= 400 ? `\n\nResponse: ${snippet}` : ''}`;
  if (status >= 200 && status < 300) return { id: 'call', status: 'ok', title: `The system answered ${status}`, detail: head };
  if (status >= 300 && status < 400) {
    const loc = String(headers.location ?? '');
    return {
      id: 'call',
      status: 'warning',
      title: `Redirected (${status})`,
      detail: detail(`The system redirects to ${loc || 'another URL'}.${/login|saml|oauth|auth|sso/i.test(loc) ? ' This is usually a login page: the system did not accept the credentials, or expects a different authentication type.' : ''}`),
      fix: /login|saml|oauth|auth|sso/i.test(loc) ? `Check that "${authType}" is what the system expects for API calls.` : 'If the redirect points to a different host or https, update the destination URL.',
    };
  }
  if (status === 401) return { id: 'call', status: 'error', title: 'The system answered 401 Unauthorized', detail: detail(`The system did not accept the ${authType === 'NoAuthentication' ? 'call without credentials' : 'credentials from the destination'}.`), fix: authType === 'NoAuthentication' ? 'The system needs authentication: set an authentication type on the destination.' : 'Check the user, client or token settings of the destination, and that the user is not locked or expired in the target system.' };
  if (status === 403) return { id: 'call', status: 'error', title: 'The system answered 403 Forbidden', detail: detail('The credentials were accepted, but the user lacks authorization for this resource.'), fix: 'Give the technical or business user the needed roles in the target system (for SAP systems, check the communication arrangement or PFCG roles).' };
  if (status === 404) return { id: 'call', status: 'warning', title: 'The system answered 404 Not Found', detail: detail('The host was reached, but this path does not exist. Many systems answer 404 on the base URL, so this is not necessarily a problem.'), fix: 'Enter a path the app really calls, for example the service path plus "/$metadata", and test again.' };
  if (status >= 500) return { id: 'call', status: 'error', title: `The system answered ${status}`, detail: detail('The target system or a gateway in front of it failed.'), fix: 'Check the target system\'s logs. A 502 or 504 often means a proxy or gateway could not reach the system.' };
  return { id: 'call', status: 'warning', title: `The system answered ${status}`, detail: detail('') };
}

export function explainNetworkError(e: unknown, url: string): Check {
  const code = (e as HttpError)?.code ?? '';
  const msg = errorText(e);
  const head = `GET ${url}\n${msg}`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { id: 'call', status: 'error', title: 'Host not found', detail: head, fix: 'Check the host in the URL. Internal hosts are only reachable as OnPremise destinations through the Cloud Connector.' };
  if (/ECONNREFUSED/.test(code)) return { id: 'call', status: 'error', title: 'Connection refused', detail: head, fix: 'Check the port in the URL, and that the system accepts connections from the internet.' };
  if (/ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT/.test(code)) return { id: 'call', status: 'error', title: 'No answer from the system', detail: `${head}\n\nThe call was made from this machine, so a firewall or VPN here can also block it.`, fix: 'Check the host and port, and whether the system is reachable from the internet.' };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/.test(code)) return { id: 'call', status: 'error', title: 'TLS certificate not trusted', detail: head, fix: 'The system\'s certificate is self-signed or from an unknown CA. Upload the CA certificate as a trust store in the destination. Use TrustAll only for tests.' };
  return { id: 'call', status: 'error', title: 'The call failed', detail: head };
}
