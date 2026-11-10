import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { ConnectivitySession, configChecks, explainTokenError, maskConfig } from '../connectivity/diagnose';
import { formatConnectivity } from '../connectivity/format';

let server: http.Server;
/** Real binding client IDs contain "!" and "|". */
const CLIENT_ID = 'sb-clone1a2b!b12345|destination-xsappname!b404';
let base = '';
const calls: string[] = [];

function destinations() {
  return [
    { Name: 'S4', Type: 'HTTP', ProxyType: 'Internet', Authentication: 'OAuth2ClientCredentials', URL: `${base}/backend`, clientId: 'c', clientSecret: 's', tokenServiceURL: `${base}/t` },
    { Name: 'ONPREM', Type: 'HTTP', ProxyType: 'OnPremise', Authentication: 'BasicAuthentication', URL: 'https://erp.internal:443', User: 'u', Password: 'p', CloudConnectorLocationId: 'LOC1' },
    { Name: 'BADOAUTH', Type: 'HTTP', ProxyType: 'Internet', Authentication: 'OAuth2ClientCredentials', URL: 'https://api.example.com', clientId: 'c', clientSecret: 'wrong', tokenServiceURL: 'https://auth.example.com/oauth/token' },
    { Name: 'EXCHANGE', Type: 'HTTP', ProxyType: 'Internet', Authentication: 'OAuth2UserTokenExchange', URL: `${base}/backend`, clientId: 'c', clientSecret: 's', tokenServiceURL: `${base}/t` },
    { Name: 'NOPASS', Type: 'HTTP', ProxyType: 'Internet', Authentication: 'BasicAuthentication', URL: 'https://api.example.com', User: 'u' },
  ];
}

function find(name: string, userToken?: string) {
  const cfg = destinations().find((d) => d.Name === name);
  if (!cfg) return undefined;
  const owner = { SubaccountId: 'sub', InstanceId: null };
  if (name === 'BADOAUTH') return { owner, destinationConfiguration: cfg, authTokens: [{ type: '', value: '', error: 'Retrieval of OAuthToken failed due to: Unable to fetch token: 401 Unauthorized {"error":"invalid_client"}' }] };
  if (name === 'EXCHANGE' && !userToken) return { owner, destinationConfiguration: cfg, authTokens: [{ type: '', value: '', error: 'Missing user token' }] };
  if (name === 'S4' || name === 'EXCHANGE') return { owner, destinationConfiguration: cfg, authTokens: [{ type: 'Bearer', value: 'backend-token', http_header: { key: 'Authorization', value: 'Bearer backend-token' }, expires_in: '3600' }] };
  if (name === 'ONPREM' || name === 'NOPASS') return { owner, destinationConfiguration: cfg, authTokens: [{ type: 'Basic', value: 'dTpw', http_header: { key: 'Authorization', value: 'Basic dTpw' } }] };
  return { owner, destinationConfiguration: cfg, authTokens: [] };
}

before(async () => {
  server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/oauth/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        // like XSUAA: id and secret in the form body, or raw in HTTP Basic
        const ok = (f.get('client_id') === CLIENT_ID && f.get('client_secret') === 'dest-secret') || req.headers.authorization === 'Basic ' + Buffer.from(`${CLIENT_ID}:dest-secret`).toString('base64');
        ok ? send(200, { access_token: 'dest-token', expires_in: 3600 }) : send(401, { error: 'unauthorized', error_description: 'Bad credentials' });
      });
      return;
    }
    if (req.url?.startsWith('/destination-configuration/')) {
      if (req.headers.authorization !== 'Bearer dest-token') return send(401, { ErrorMessage: 'Unauthorized' });
      if (req.url.endsWith('/instanceDestinations')) return send(200, []);
      if (req.url.endsWith('/subaccountDestinations')) return send(200, destinations());
      const name = decodeURIComponent(req.url.split('/').pop()!);
      const r = find(name, req.headers['x-user-token'] as string | undefined);
      return r ? send(200, r) : send(404, { ErrorMessage: 'Configuration with the specified name was not found' });
    }
    if (req.url?.startsWith('/backend')) {
      if (req.headers.authorization !== 'Bearer backend-token') return send(401, { error: 'no' });
      return req.url.includes('$metadata') ? send(200, {}) : send(404, { error: 'not here' });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const vcap = (secret = 'dest-secret', extra: Record<string, unknown[]> = {}) => ({
  destination: [{ name: 'orders-destination', label: 'destination', plan: 'lite', tags: ['destination'], credentials: { uri: base, url: base, clientid: CLIENT_ID, clientsecret: secret } }],
  xsuaa: [{ name: 'orders-auth', label: 'xsuaa', tags: ['xsuaa'], credentials: {} }],
  ...extra,
});

function capProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', cds: { requires: { API_BP: { kind: 'odata-v2', credentials: { destination: 's4' } } } } }));
  return dir;
}

test('checks every destination of the app and explains the problems', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap(), { projectRoot: capProject() });
  const r = s.report;
  const d = (n: string) => r.destinations.find((x) => x.name === n)!;
  assert.equal(r.status, 'error');
  assert.ok(r.checks.some((c) => c.id === 'destination-binding' && c.status === 'ok'));

  assert.equal(d('S4').status, 'warning', 'only the private-host warning for 127.0.0.1');
  assert.ok(d('S4').checks.some((c) => c.id === 'token' && c.status === 'ok'));
  assert.ok(d('S4').callable);

  const on = d('ONPREM');
  assert.ok(on.checks.some((c) => c.id === 'connectivity' && c.status === 'error'));
  assert.ok(on.checks.some((c) => c.id === 'onprem-https'));
  assert.ok(on.checks.some((c) => c.id === 'cloud-connector' && /LOC1/.test(c.title)));
  assert.equal(on.callable, false);
  assert.equal(on.config!.Password, '••••••');

  const bad = d('BADOAUTH').checks.find((c) => c.id === 'token')!;
  assert.equal(bad.status, 'error');
  assert.match(bad.fix!, /clientId and clientSecret/);

  assert.equal(d('EXCHANGE').checks.find((c) => c.id === 'token')!.status, 'skipped');
  assert.notEqual(d('EXCHANGE').status, 'ok', 'an untested exchange is not shown as OK');
  assert.ok(d('NOPASS').checks.some((c) => c.id === 'auth-props' && /Password/.test(c.title)));

  const missing = d('s4');
  assert.deepEqual(missing.usedBy, ['API_BP']);
  assert.match(missing.checks.find((c) => c.id === 'exists')!.detail!, /"S4" exists/);

  assert.match(formatConnectivity(r), /Connectivity Doctor for SAP BTP: orders-srv/);
  assert.doesNotMatch(JSON.stringify(r), /dest-secret|backend-token/, 'no secrets or tokens in the report');
});

test('connectivity binding removes the OnPremise error', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap('dest-secret', { connectivity: [{ name: 'orders-conn', label: 'connectivity', tags: ['connectivity'], credentials: {} }] }), { only: ['ONPREM'] });
  const on = s.report.destinations[0];
  assert.ok(!on.checks.some((c) => c.id === 'connectivity'));
  assert.equal(on.status, 'warning');
});

test('user token tests the exchange', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap(), { only: ['EXCHANGE'] });
  const rep = await s.checkDestination('EXCHANGE', 'user-jwt');
  assert.ok(rep.checks.some((c) => c.id === 'token' && c.status === 'ok' && /pasted user token/.test(c.title)));
  assert.equal(s.report.destinations[0].testedWithUserToken, true);
});

test('test call uses the token from the Destination service', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap(), { only: ['S4'] });
  const base404 = await s.testCall('S4');
  assert.equal(base404.status, 'warning');
  assert.match(base404.title, /404/);
  const ok = await s.testCall('S4', { path: '/sap/opu/odata/sap/API_BP/$metadata' });
  assert.equal(ok.status, 'ok');
  assert.ok(calls.includes('GET /backend/sap/opu/odata/sap/API_BP/$metadata'));
  const onprem = await (await ConnectivitySession.fromServices('a', vcap(), { only: ['ONPREM'] })).testCall('ONPREM');
  assert.equal(onprem.status, 'skipped');
});

test('wrong binding credentials are reported, not thrown', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap('old-secret'));
  const c = s.report.checks.find((k) => k.id === 'destination-token')!;
  assert.equal(c.status, 'error');
  assert.match(c.detail!, /HTTP 401.*Bad credentials/);
});

test('no destination binding', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', { xsuaa: vcap().xsuaa }, { projectRoot: capProject() });
  assert.equal(s.report.checks[0].status, 'error');
  assert.equal(s.report.destinations[0].name, 's4');
  assert.equal(s.report.destinations[0].status, 'skipped');
});

test('config checks', () => {
  const ctx = { connectivityBound: true, identityBound: false };
  const ids = (cfg: Record<string, string>) => configChecks(cfg, ctx).map((c) => `${c.id}:${c.status}`);
  assert.deepEqual(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'NoAuthentication', URL: 'https://api.example.com' }), []);
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'NoAuthentication', URL: 'http://10.1.2.3:8000' }).includes('private-host:warning'));
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'NoAuthentication', URL: 'not a url' }).includes('url:error'));
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'BasicAuthentication', URL: 'https://erp-virtual:44300', User: 'u', Password: 'p' }).includes('private-host:warning'), 'single-label host');
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'PrincipalPropagation', URL: 'https://x.example.com' }).includes('pp-proxy:error'));
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'OnPremise', Authentication: 'PrincipalPropagation', URL: 'http://erp:443' }).includes('user-token:warning'));
  assert.ok(ids({ Type: 'HTTP', ProxyType: 'Internet', URL: 'https://x.example.com' }).includes('auth:error'));
  assert.deepEqual(ids({ Type: 'RFC', Name: 'X' }), ['type:info']);
  assert.deepEqual(ids({ Type: 'HTTP', ProxyType: 'Internet', Authentication: 'OAuth2ClientCredentials', URL: 'https://a.example.com', clientId: 'c', tokenServiceURL: 'https://t', 'tokenService.KeyStoreLocation': 'k.p12' }), []);
});

test('similar names', () => {
  const { similarNames } = require('../connectivity/diagnose');
  assert.deepEqual(similarNames('S4HANA', ['S4HANA_CLOUD', 'NORTHWIND']), ['S4HANA_CLOUD']);
  assert.deepEqual(similarNames('NORTWIND', ['S4HANA_CLOUD', 'NORTHWIND']), ['NORTHWIND']);
  assert.deepEqual(similarNames('ABC', ['XYZ_SYSTEM']), []);
});

test('no test call when the token could not be fetched', async () => {
  const s = await ConnectivitySession.fromServices('orders-srv', vcap(), { only: ['BADOAUTH'] });
  const c = await s.testCall('BADOAUTH');
  assert.equal(c.status, 'skipped');
});

test('token error explanations', () => {
  assert.match(explainTokenError('401 Unauthorized invalid_client').fix, /clientSecret/);
  assert.match(explainTokenError('invalid_grant', 'OAuth2Password').fix, /User and Password/);
  assert.match(explainTokenError('invalid_grant', 'OAuth2UserTokenExchange').fix, /trust/);
  assert.match(explainTokenError('getaddrinfo ENOTFOUND auth.example.com').detail, /cannot be resolved/);
  assert.match(explainTokenError('PKIX path building failed').detail, /TLS/);
  assert.deepEqual(maskConfig({ Password: 'x', clientSecret: 'y', 'tokenService.KeyStorePassword': 'z', URL: 'u' }), { Password: '••••••', clientSecret: '••••••', 'tokenService.KeyStorePassword': '••••••', URL: 'u' });
});
