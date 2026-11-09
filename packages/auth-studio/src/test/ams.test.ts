import assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { scanAms, scanCdsAuth } from 'btp-deploy-doctor';
import { analyzeIasToken, buildAmsState, dclRootFor, isAmsProject, rootForDcl } from '../ams-model';

const ROOT = path.resolve(__dirname, '../../../examples/broken-ams');
const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object) => `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`;

test('builds the policies view from the broken-ams example', () => {
  assert.ok(isAmsProject(ROOT));
  const s = buildAmsState(ROOT, dclRootFor(ROOT));
  assert.equal(s.dclRoot, 'ams/dcl');
  assert.equal(s.generates.policies, false);
  const byRole = Object.fromEntries(s.roles.map((r) => [r.role, r]));
  assert.deepEqual(byRole.Viewer.direct.map((d) => d.policy), ['cap.Viewer', 'local.ViewerSmall']);
  assert.deepEqual(byRole.SalesRep.direct.map((d) => d.condition), ['Region IS NOT RESTRICTED']);
  assert.deepEqual(byRole.SalesManager.direct, []);
  assert.deepEqual(s.policies.find((p) => p.qualified === 'local.SalesRepEU')!.uses.map((u) => u.known), [false]);
  assert.deepEqual(s.policies.find((p) => p.qualified === 'cap.Viewer')!.usedBy, ['local.ViewerSmall']);
  assert.deepEqual(s.attributes.map((a) => [a.path, a.inSchema, a.mappedFrom?.element]), [['Region', true, 'region'], ['Budget', false, 'amount']]);
});

test('explains an IAS token: no roles inside, which policies give each role', () => {
  const model = scanAms(ROOT);
  const r = analyzeIasToken(jwt({ iss: 'https://t1.accounts.ondemand.com', sub: 'u1', scim_id: 'abc-123', email: 'maria@example.com', app_tid: 'tid-1', azp: 'client-1', aud: ['client-1'], exp: Math.floor(Date.now() / 1000) + 600 }), model, scanCdsAuth(ROOT));
  assert.equal(r.kind, 'ias');
  assert.equal(r.subject, 'maria@example.com');
  assert.equal(r.tenant, 'tid-1');
  assert.deepEqual(r.roles.find((x) => x.role === 'Viewer')!.policies, ['cap.Viewer', 'local.ViewerSmall']);
  assert.ok(r.notes.some((n) => /do not carry roles/.test(n) && /abc-123/.test(n)));
  assert.ok(r.notes.some((n) => /No policy gives roles .*SalesManager/.test(n)));
});

test('flags an XSUAA token sent to an IAS app, and unknown API permission groups', () => {
  const model = scanAms(ROOT);
  const x = analyzeIasToken(jwt({ zid: 'z', scope: ['orders!t1.Viewer'], exp: 1 }), model, scanCdsAuth(ROOT));
  assert.equal(x.kind, 'xsuaa');
  assert.ok(x.notes.some((n) => /XSUAA token/.test(n)));
  assert.ok(x.notes.some((n) => /expired/.test(n)));
  const t = analyzeIasToken(jwt({ iss: 'https://t1.accounts.ondemand.com', app_tid: 't', ias_apis: ['ReadCatalog'] }), model, scanCdsAuth(ROOT));
  assert.deepEqual(t.apis, [{ name: 'ReadCatalog', policy: undefined, roles: [] }]);
  assert.ok(t.notes.some((n) => /INTERNAL POLICY "ReadCatalog"/.test(n)));
  assert.match(analyzeIasToken('nope', model, scanCdsAuth(ROOT)).error ?? '', /not a JWT/);
});

test('finds the project of a .dcl file through its schema.dcl', () => {
  assert.equal(rootForDcl(path.join(ROOT, 'ams/dcl/local/testPolicies.dcl')), ROOT);
  assert.equal(dclRootFor(ROOT, path.join(ROOT, 'ams/dcl/cap/basePolicies.dcl')), 'ams/dcl');
  assert.equal(rootForDcl(path.join(ROOT, 'srv/order-service.cds')), undefined);
});
