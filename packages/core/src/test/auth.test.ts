import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { blankComments, scanCdsAuth } from '../cds-roles';
import { runChecks } from '../check';
import { applyFixToDisk, fixAll } from '../fix/apply';
import { Finding } from '../types';
import { CLEAN_MTA, FIORI_FILES, FIORI_MTA, makeProject } from './helpers';

const SERVICE = `using { sap.capire.bookshop as my } from '../db/schema';

// @requires: 'CommentedOut'
service AdminService @(requires: 'Admin') {
  entity Books as projection on my.Books;
}

service CatalogService {
  @readonly entity Books @(restrict: [
    { grant: 'READ', to: 'authenticated-user' },
    { grant: ['READ', 'WRITE'], to: ['Viewer', 'Admin'], where: 'country = $user.country' }
  ]) as projection on my.Books;
  /* @restrict: [{ to: 'AlsoCommented' }] */
}
`;

const XS_SECURITY = {
  xsappname: 'bookshop',
  'tenant-mode': 'dedicated',
  scopes: [
    { name: '$XSAPPNAME.Admin', description: 'Admin' },
    { name: '$XSAPPNAME.Viewer', description: 'Viewer' },
  ],
  attributes: [{ name: 'country', description: 'Country', valueType: 'string' }],
  'role-templates': [
    { name: 'Admin', 'scope-references': ['$XSAPPNAME.Admin'] },
    { name: 'Viewer', 'scope-references': ['$XSAPPNAME.Viewer', 'uaa.user'], 'attribute-references': ['country'] },
  ],
  'role-collections': [{ name: 'Bookshop Admin', 'role-template-references': ['$XSAPPNAME.Admin'] }],
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const project = (patch: Record<string, string | object | null> = {}) =>
  makeProject({ 'srv/admin-service.cds': SERVICE, 'xs-security.json': XS_SECURITY, ...patch });
const auth = (dir: string) => runChecks(dir).findings.filter((f) => /^AUTH/.test(f.ruleId));
const findingOf = (dir: string, id: string): Finding => {
  const f = runChecks(dir).findings.find((x) => x.ruleId === id);
  assert.ok(f, `expected ${id}, got ${runChecks(dir).findings.map((x) => x.ruleId).join(', ')}`);
  return f;
};
const xs = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'xs-security.json'), 'utf8'));
const xsWith = (patch: (x: typeof XS_SECURITY) => void) => {
  const x = clone(XS_SECURITY);
  patch(x);
  return x;
};

// ---------------- CDS scanning ----------------

test('reads roles and user attributes from CDS, ignoring comments and pseudo roles', () => {
  const dir = project();
  const r = scanCdsAuth(dir);
  assert.deepEqual(r.roles.map((x) => x.role).sort(), ['Admin', 'Viewer']);
  assert.deepEqual(r.attributes.map((x) => x.role), ['country']);
  assert.deepEqual(r.roles.find((x) => x.role === 'Admin'), { role: 'Admin', file: 'srv/admin-service.cds', line: 4 });
});

test('comments are blanked without moving lines, strings are kept', () => {
  const src = "a // x\n/* y\n z */ b 'not // a comment'";
  const out = blankComments(src);
  assert.equal(out.split('\n').length, 3);
  assert.match(out, /'not \/\/ a comment'/);
  assert.doesNotMatch(out, /x|y|z/);
});

test('a consistent model and xs-security.json has no auth findings', () => {
  assert.deepEqual(auth(project()), []);
});

test('IAS projects are not checked against xs-security.json', () => {
  const pkg = { name: 'b', dependencies: { '@sap/cds': '^9', '@sap/xssec': '^4' }, cds: { requires: { '[production]': { auth: 'ias' } } } };
  assert.deepEqual(auth(project({ 'package.json': pkg, 'xs-security.json': xsWith((x) => (x.scopes = [])) })), []);
});

// ---------------- roles ----------------

test('AUTH001 role used in CDS but missing from xs-security.json, fix adds scope and role template', async () => {
  const dir = project({ 'xs-security.json': xsWith((x) => { x.scopes = x.scopes.filter((s) => s.name !== '$XSAPPNAME.Viewer'); x['role-templates'] = x['role-templates'].filter((t) => t.name !== 'Viewer'); }) });
  const f = findingOf(dir, 'AUTH001');
  assert.equal(f.severity, 'error');
  assert.equal(f.location.file, 'srv/admin-service.cds');
  assert.match(f.title, /"Viewer"/);
  await fixAll(dir);
  const after = xs(dir);
  assert.ok(after.scopes.some((s: any) => s.name === '$XSAPPNAME.Viewer'));
  assert.ok(after['role-templates'].some((t: any) => t.name === 'Viewer' && t['scope-references'].includes('$XSAPPNAME.Viewer')));
  assert.deepEqual(auth(dir).filter((x) => x.ruleId !== 'AUTH006'), []);
});

test('AUTH001 with only a case difference asks for review instead of auto-fixing', () => {
  const dir = project({ 'srv/admin-service.cds': SERVICE.replace("requires: 'Admin'", "requires: 'admin'") });
  const f = findingOf(dir, 'AUTH001');
  assert.match(f.message, /case-sensitive/);
  assert.equal(f.fixes?.[0].requiresReview, true);
});

test('AUTH001 without any scopes array creates it', () => {
  const dir = project({ 'xs-security.json': { xsappname: 'bookshop', 'tenant-mode': 'dedicated', attributes: [{ name: 'country' }] } });
  const f = runChecks(dir).findings.filter((x) => x.ruleId === 'AUTH001');
  assert.equal(f.length, 2);
  applyFixToDisk(dir, f[0].fixes![0]);
  assert.equal(xs(dir).scopes.length, 1);
});

test('AUTH001 when scopes come from mta.yaml config points there and offers no file fix', () => {
  const mta = CLEAN_MTA.replace('      path: ./xs-security.json\n', "      path: ./xs-security.json\n      config:\n        scopes:\n          - name: $XSAPPNAME.Admin\n");
  const dir = project({ 'mta.yaml': mta });
  const f = findingOf(dir, 'AUTH001');
  assert.match(f.message, /mta\.yaml \(resource "bookshop-auth"\)/);
  assert.equal(f.fixes, undefined);
});

test('AUTH002 scope without a role template, fix adds one', () => {
  const dir = project({ 'xs-security.json': xsWith((x) => (x['role-templates'] = x['role-templates'].filter((t) => t.name !== 'Admin'))) });
  const f = findingOf(dir, 'AUTH002');
  assert.match(f.title, /"Admin"/);
  applyFixToDisk(dir, f.fixes![0]);
  assert.ok(!auth(dir).some((x) => x.ruleId === 'AUTH002'));
});

test('AUTH003 role template with a misspelled scope reference, fix corrects it', () => {
  const dir = project({ 'xs-security.json': xsWith((x) => (x['role-templates'][0]['scope-references'] = ['$XSAPPNAME.Admn'])) });
  const f = findingOf(dir, 'AUTH003');
  assert.equal(f.fixes?.[0].title, 'Change to "$XSAPPNAME.Admin"');
  applyFixToDisk(dir, f.fixes![0]);
  assert.deepEqual(auth(dir), []);
});

test('AUTH004 role collection with an unknown role template', () => {
  const dir = project({ 'xs-security.json': xsWith((x) => (x['role-collections'][0]['role-template-references'] = ['$XSAPPNAME.Admins'])) });
  const f = findingOf(dir, 'AUTH004');
  applyFixToDisk(dir, f.fixes![0]);
  assert.deepEqual(auth(dir), []);
});

test('AUTH005 role template with an unknown attribute', () => {
  const dir = project({ 'xs-security.json': xsWith((x) => (x['role-templates'][1]['attribute-references'] = ['Country'])) });
  const f = findingOf(dir, 'AUTH005');
  assert.equal(f.fixes?.[0].title, 'Change to "country"');
});

test('AUTH006 $user attribute in a where condition that XSUAA does not define', () => {
  const f = findingOf(project({ 'xs-security.json': xsWith((x) => { x.attributes = []; delete (x['role-templates'][1] as any)['attribute-references']; }) }), 'AUTH006');
  assert.match(f.title, /"country"/);
  assert.equal(f.location.file, 'srv/admin-service.cds');
});

// ---------------- approuter ----------------

const ROUTER_MTA = CLEAN_MTA.replace('resources:\n', `  - name: bookshop
    type: approuter.nodejs
    path: app/router
    requires:
      - name: srv-api
        group: destinations
        properties:
          name: srv-api
          url: ~{srv-url}
          forwardAuthToken: true
      - name: bookshop-auth
resources:
`);
const ROUTER_FILES = {
  'mta.yaml': ROUTER_MTA,
  'app/router/package.json': { name: 'router', dependencies: { '@sap/approuter': '^20' } },
  'app/router/xs-app.json': { routes: [{ source: '^/(.*)$', target: '$1', destination: 'srv-api', authenticationType: 'xsuaa' }] },
};

test('a standalone approuter bound to XSUAA and forwarding the token is clean', () => {
  assert.deepEqual(auth(project(ROUTER_FILES)), []);
});

test('AUTH010 approuter with login routes but no XSUAA binding, fix requires it', () => {
  const dir = project({ ...ROUTER_FILES, 'mta.yaml': ROUTER_MTA.replace('          forwardAuthToken: true\n      - name: bookshop-auth\n', '          forwardAuthToken: true\n') });
  const f = findingOf(dir, 'AUTH010');
  applyFixToDisk(dir, f.fixes![0]);
  assert.deepEqual(auth(dir), []);
});

test('AUTH010 is not reported when every route is public', () => {
  const dir = project({ ...ROUTER_FILES, 'mta.yaml': ROUTER_MTA.replace('      - name: bookshop-auth\nresources', 'resources'), 'app/router/xs-app.json': { authenticationMethod: 'none', routes: [] } });
  assert.ok(!auth(dir).some((f) => f.ruleId === 'AUTH010'));
});

test('AUTH011 approuter destination without forwardAuthToken, fix sets it', () => {
  const dir = project({ ...ROUTER_FILES, 'mta.yaml': ROUTER_MTA.replace('          forwardAuthToken: true\n', '') });
  const f = findingOf(dir, 'AUTH011');
  applyFixToDisk(dir, f.fixes![0]);
  assert.deepEqual(auth(dir), []);
});

test('AUTH011 managed approuter destination without HTML5.ForwardAuthToken', () => {
  const dir = makeProject({ ...FIORI_FILES, 'mta.yaml': FIORI_MTA.replace('                HTML5.ForwardAuthToken: true\n', '') });
  const f = findingOf(dir, 'AUTH011');
  applyFixToDisk(dir, f.fixes![0]);
  assert.ok(!runChecks(dir).findings.some((x) => x.ruleId === 'AUTH011'));
});

test('AUTH011 is not reported for the destination to the MTX sidecar', () => {
  const mta = ROUTER_MTA.replace('      - name: bookshop-auth\nresources', `      - name: mtx-api
        group: destinations
        properties:
          name: mtx
          url: ~{mtx-url}
      - name: bookshop-auth
resources`).replace('  - name: bookshop-db-deployer', `  - name: bookshop-mtx
    type: nodejs
    path: gen/mtx/sidecar
    provides:
      - name: mtx-api
        properties:
          mtx-url: \${default-url}
  - name: bookshop-db-deployer`);
  assert.ok(!auth(project({ ...ROUTER_FILES, 'mta.yaml': mta })).some((f) => f.ruleId === 'AUTH011'));
});

test('fixes append to xs-security.json in the style of the existing entries', () => {
  const compact = `{
  "xsappname": "bookshop",
  "scopes": [
    { "name": "$XSAPPNAME.Admin", "description": "Admin" }
  ],
  "attributes": [{ "name": "country" }],
  "role-templates": [
    { "name": "Admin", "scope-references": ["$XSAPPNAME.Admin"] }
  ]
}
`;
  const dir = project({ 'xs-security.json': compact });
  applyFixToDisk(dir, findingOf(dir, 'AUTH001').fixes![0]);
  const after = fs.readFileSync(path.join(dir, 'xs-security.json'), 'utf8');
  assert.equal(after, compact
    .replace('"description": "Admin" }\n', '"description": "Admin" },\n    { "name": "$XSAPPNAME.Viewer", "description": "Viewer" }\n')
    .replace('["$XSAPPNAME.Admin"] }\n', '["$XSAPPNAME.Admin"] },\n    { "name": "Viewer", "description": "Viewer", "scope-references": ["$XSAPPNAME.Viewer"] }\n'));
});
