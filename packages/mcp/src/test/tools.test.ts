import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server';

const EXAMPLES = path.resolve(__dirname, '..', '..', '..', '..', 'examples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-mcp-tools-'));
/** Real binding client IDs contain "!" and "|". */
const CLIENT_ID = 'sb-clone1a2b!b12345|destination-xsappname!b404';

let client: Client;
let backend: http.Server;
const oldCfHome = process.env.CF_HOME;

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: !!res.isError, json: () => JSON.parse(res.content[0].text) };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;

/** A CAP project with roles Admin and SalesRep, where xs-security.json only defines SalesRep. */
function authProject(name: string, withDescriptor = true): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'srv'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'orders', dependencies: { '@sap/cds': '^9' }, cds: { requires: { auth: 'xsuaa' } } }, null, 2));
  fs.writeFileSync(
    path.join(dir, 'srv', 'service.cds'),
    [
      "service OrderService @(requires: 'authenticated-user') {",
      "  entity Orders @(restrict: [{ grant: 'READ', to: 'SalesRep', where: 'country = $user.country' }]) { key ID: Integer; country: String; }",
      '}',
      "service AdminService @(requires: 'Admin') { entity Settings { key ID: Integer; } }",
      '',
    ].join('\n'),
  );
  if (withDescriptor)
    fs.writeFileSync(
      path.join(dir, 'xs-security.json'),
      JSON.stringify(
        {
          xsappname: 'orders',
          'tenant-mode': 'dedicated',
          scopes: [{ name: '$XSAPPNAME.SalesRep', description: 'Sales rep' }],
          'role-templates': [{ name: 'SalesRep', 'scope-references': ['$XSAPPNAME.SalesRep'] }],
        },
        null,
        2,
      ) + '\n',
    );
  return dir;
}

before(async () => {
  // Destination service + XSUAA + backend, like the real ones.
  backend = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/oauth/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        f.get('client_id') === CLIENT_ID && f.get('client_secret') === 'dest-secret' ? send(200, { access_token: 'dest-token', expires_in: 3600 }) : send(401, { error: 'unauthorized' });
      });
      return;
    }
    const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const s4 = { Name: 'S4', Type: 'HTTP', ProxyType: 'Internet', Authentication: 'NoAuthentication', URL: `${base}/backend` };
    if (req.url?.startsWith('/destination-configuration/')) {
      if (req.headers.authorization !== 'Bearer dest-token') return send(401, {});
      if (req.url.endsWith('/instanceDestinations')) return send(200, []);
      if (req.url.endsWith('/subaccountDestinations')) return send(200, [s4]);
      const name = decodeURIComponent(req.url.split('/').pop()!);
      return name === 'S4' ? send(200, { owner: { SubaccountId: 'sub', InstanceId: null }, destinationConfiguration: s4, authTokens: [] }) : send(404, { ErrorMessage: 'Configuration with the specified name was not found' });
    }
    if (req.url?.startsWith('/backend')) return req.url.includes('$metadata') ? send(200, {}) : send(404, {});
    send(404, {});
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

  // A fake cf CLI: a targeted space with one app bound to the Destination service above.
  const cfHome = path.join(tmp, 'cf-home');
  fs.mkdirSync(path.join(cfHome, '.cf'), { recursive: true });
  fs.writeFileSync(path.join(cfHome, '.cf', 'config.json'), JSON.stringify({ Target: 'https://api.cf.example.com', OrganizationFields: { Name: 'my-org' }, SpaceFields: { Name: 'dev', GUID: 'space-1' } }));
  process.env.CF_HOME = cfHome;
  const vcap = { destination: [{ name: 'orders-destination', label: 'destination', tags: ['destination'], credentials: { uri: base, url: base, clientid: CLIENT_ID, clientsecret: 'dest-secret' } }] };
  const cf = path.join(tmp, 'fake-cf');
  fs.writeFileSync(
    cf,
    `#!/usr/bin/env node
const p = process.argv[3] || '';
if (process.argv[2] !== 'curl') process.exit(1);
if (p.startsWith('/v3/apps?')) console.log(JSON.stringify({ resources: p.includes('names=') && !p.includes('names=orders-srv') ? [] : [{ guid: 'g1', name: 'orders-srv', state: 'STARTED' }] }));
else if (p === '/v3/apps/g1/env') console.log(JSON.stringify({ system_env_json: { VCAP_SERVICES: ${JSON.stringify(vcap)} } }));
else process.exit(1);
`,
  );
  fs.chmodSync(cf, 0o755);

  const server = createServer({ defaultRoot: tmp, cfPath: cf });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

after(async () => {
  await client.close();
  backend.close();
  if (oldCfHome === undefined) delete process.env.CF_HOME;
  else process.env.CF_HOME = oldCfHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('roles and tokens (Auth Studio)', () => {
  it('follows each CDS role to xs-security.json', async () => {
    const r = (await call('check_roles', { path: authProject('roles') })).json();
    const role = (n: string) => r.xsSecurity.roles.find((x: any) => x.role === n);
    assert.equal(role('Admin').scope, false);
    assert.match(role('Admin').note, /No scope/);
    assert.equal(role('SalesRep').scope, true);
    assert.deepEqual(role('SalesRep').templates, ['SalesRep']);
    assert.equal(role('SalesRep').reachable, false, 'no role collection');
    assert.ok(r.xsSecurity.issues.some((i: any) => /Admin/.test(i.message)));
    assert.ok(r.xsSecurity.attributes.some((a: any) => a.name === 'country' && !a.defined));
  });

  it('explains which roles a token grants', async () => {
    const root = authProject('token');
    const token = jwt({ user_name: 'maria@example.com', zid: 'z1', scope: ['orders!t1.SalesRep', 'openid'], exp: Math.floor(Date.now() / 1000) + 600 });
    const r = (await call('explain_token', { path: root, token: `Bearer ${token}` })).json();
    assert.equal(r.mode, 'xsuaa');
    assert.equal(r.subject, 'maria@example.com');
    assert.deepEqual(
      r.roles.map((x: any) => [x.role, x.granted]).sort(),
      [['Admin', false], ['SalesRep', true]],
    );
    assert.ok(r.notes.some((n: string) => /Missing role: Admin/.test(n)));
    assert.equal((await call('explain_token', { path: root, token: 'not-a-jwt' })).json().ok, false);
  });

  it('adds missing roles, and only reports with dryRun', async () => {
    const root = authProject('add');
    const file = path.join(root, 'xs-security.json');
    const before = fs.readFileSync(file, 'utf8');
    const dry = (await call('add_missing_roles', { path: root, dryRun: true })).json();
    assert.deepEqual(dry.wouldAdd, ['Admin']);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const r = (await call('add_missing_roles', { path: root })).json();
    assert.deepEqual(r.added, ['Admin']);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(d.scopes.some((s: any) => s.name === '$XSAPPNAME.Admin'));
    assert.ok(d['role-templates'].some((t: any) => t.name === 'Admin'));
    assert.deepEqual((await call('add_missing_roles', { path: root })).json().added, []);
  });

  it('creates xs-security.json when there is none', async () => {
    const root = authProject('create', false);
    const r = (await call('add_missing_roles', { path: root })).json();
    assert.equal(r.created, 'xs-security.json');
    const d = JSON.parse(fs.readFileSync(path.join(root, 'xs-security.json'), 'utf8'));
    assert.deepEqual(d.scopes.map((s: any) => s.name).sort(), ['$XSAPPNAME.Admin', '$XSAPPNAME.SalesRep']);
  });

  it('lists AMS policies for apps on Identity Authentication', async () => {
    const root = path.join(tmp, 'ams');
    fs.cpSync(path.join(EXAMPLES, 'broken-ams'), root, { recursive: true });
    const r = (await call('check_roles', { path: root })).json();
    assert.ok(r.ams);
    assert.ok(r.ams.policies.length > 0);
    assert.ok(r.ams.roles.length > 0);
    const t = (await call('explain_token', { path: root, token: jwt({ sub: 'u1', iss: 'https://t1.accounts.ondemand.com', app_tid: 't1', scim_id: 's1' }) })).json();
    assert.equal(t.mode, 'ams');
    assert.equal(t.kind, 'ias');
  });
});

describe('destinations (Connectivity Doctor)', () => {
  it('lists the apps in the targeted space', async () => {
    const r = (await call('list_cf_apps', {})).json();
    assert.equal(r.space, 'dev');
    assert.deepEqual(r.apps, [{ name: 'orders-srv', state: 'STARTED' }]);
  });

  it('checks the destinations of a deployed app without leaking secrets', async () => {
    const res = await call('check_destinations', { app: 'orders-srv', testCalls: true });
    assert.equal(res.isError, false, res.text);
    assert.doesNotMatch(res.text, /dest-secret|dest-token/);
    const r = res.json();
    assert.equal(r.target.space, 'dev');
    const s4 = r.destinations.find((d: any) => d.name === 'S4');
    assert.ok(s4);
    assert.ok(s4.checks.some((c: any) => c.id === 'call'));
  });

  it('tests one call through a destination', async () => {
    const r = (await call('test_destination_call', { app: 'orders-srv', destination: 'S4', requestPath: '/$metadata' })).json();
    assert.equal(r.destination.name, 'S4');
    assert.equal(r.call.status, 'ok', JSON.stringify(r.call));
  });

  it('explains an unknown app', async () => {
    const r = await call('check_destinations', { app: 'nope' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not found/);
  });
});
