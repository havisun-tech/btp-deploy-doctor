import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../check';
import { CLEAN_MTA, makeProject, pkg } from './helpers';

const ids = (dir: string) => runChecks(dir).findings.map((f) => f.ruleId);
const find = (dir: string, id: string) => runChecks(dir).findings.find((f) => f.ruleId === id);

test('a clean CAP project has no findings', () => {
  assert.deepEqual(runChecks(makeProject()).findings, []);
});

test('empty folder reports nothing to check', () => {
  assert.deepEqual(ids(makeProject({ 'package.json': null, 'mta.yaml': null })), ['GEN001']);
});

test('MTA001 invalid YAML with line number', () => {
  const f = find(makeProject({ 'mta.yaml': 'ID: x\nmodules:\n  - name: a\n   type: nodejs\n' }), 'MTA001');
  assert.ok(f);
  assert.equal(f.severity, 'error');
  assert.ok(f.location.line && f.location.line >= 3);
});

test('MTA002 missing ID', () => {
  assert.ok(ids(makeProject({ 'mta.yaml': CLEAN_MTA.replace('ID: bookshop\n', '') })).includes('MTA002'));
});

test('MTA003 duplicate names', () => {
  const mta = CLEAN_MTA.replace('name: bookshop-db-deployer', 'name: bookshop-db');
  assert.ok(ids(makeProject({ 'mta.yaml': mta })).includes('MTA003'));
});

test('MTA004 unknown required dependency points at the requires line', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '      - name: bookshop-uaa\n');
  const f = find(makeProject({ 'mta.yaml': mta }), 'MTA004');
  assert.ok(f);
  assert.match(f.message, /bookshop-uaa/);
  const expected = mta.split('\n').findIndex((l) => l.includes('bookshop-uaa')) + 1;
  assert.equal(f.location.line, expected);
});

test('MTA004 flags unresolved placeholders', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '      - name: ${service-name}\n');
  assert.match(find(makeProject({ 'mta.yaml': mta }), 'MTA004')!.message, /Placeholders/);
});

test('MTA005 gen/ path without cds build', () => {
  const mta = CLEAN_MTA.replace(/build-parameters:[\s\S]*?--production\n/, '');
  const f = find(makeProject({ 'mta.yaml': mta }), 'MTA005');
  assert.ok(f);
  assert.match(f.message, /cds build/);
});

test('MTA005 missing non-generated path', () => {
  const mta = CLEAN_MTA.replace('path: gen/db', 'path: database');
  assert.match(find(makeProject({ 'mta.yaml': mta }), 'MTA005')!.title, /database/);
});

test('MTA006 HDI deployer without container', () => {
  const mta = CLEAN_MTA.replace('    path: gen/db\n    requires:\n      - name: bookshop-db\n', '    path: gen/db\n');
  assert.ok(ids(makeProject({ 'mta.yaml': mta })).includes('MTA006'));
});

test('MTA007 managed service without plan', () => {
  const mta = CLEAN_MTA.replace('      service-plan: application\n', '');
  assert.ok(ids(makeProject({ 'mta.yaml': mta })).includes('MTA007'));
});

test('MTA008 missing xs-security.json', () => {
  assert.ok(ids(makeProject({ 'xs-security.json': null })).includes('MTA008'));
});

test('MTA009 approuter without xs-app.json', () => {
  const mta = CLEAN_MTA.replace('resources:', '  - name: bookshop-app\n    type: approuter.nodejs\n    path: app/router\nresources:');
  assert.ok(ids(makeProject({ 'mta.yaml': mta, 'app/router/package.json': '{}' })).includes('MTA009'));
  assert.ok(!ids(makeProject({ 'mta.yaml': mta, 'app/router/package.json': '{}', 'app/router/xs-app.json': '{}' })).includes('MTA009'));
});

test('MTA010 too little memory', () => {
  assert.ok(ids(makeProject({ 'mta.yaml': CLEAN_MTA.replace('memory: 256M', 'memory: 128M') })).includes('MTA010'));
});

test('MTA011 global cds and unpinned cds-dk', () => {
  assert.ok(ids(makeProject({ 'mta.yaml': CLEAN_MTA.replace('npx cds build', 'cds build') })).includes('MTA011'));
  const noDk = pkg((p) => delete p.devDependencies['@sap/cds-dk']);
  assert.ok(ids(makeProject({ 'package.json': noDk })).includes('MTA011'));
});

test('CDS000 invalid package.json', () => {
  assert.ok(ids(makeProject({ 'package.json': '{ "name": "x", }' })).includes('CDS000'));
});

test('CDS005 @sap/cds only in devDependencies', () => {
  const p = pkg((p) => {
    delete p.dependencies['@sap/cds'];
    p.devDependencies['@sap/cds'] = '^9';
  });
  assert.match(find(makeProject({ 'package.json': p }), 'CDS005')!.message, /devDependencies/);
});

test('CDS001 HANA without driver', () => {
  const p = pkg((p) => delete p.dependencies['@cap-js/hana']);
  assert.ok(ids(makeProject({ 'package.json': p })).includes('CDS001'));
});

test('CDS002 xsuaa without @sap/xssec', () => {
  const p = pkg((p) => delete p.dependencies['@sap/xssec']);
  assert.ok(ids(makeProject({ 'package.json': p })).includes('CDS002'));
});

test('CDS003 HDI deployer but production uses sqlite', () => {
  const p = pkg((p) => (p.cds.requires['[production]'].db = 'sqlite'));
  assert.ok(ids(makeProject({ 'package.json': p })).includes('CDS003'));
});

test('CDS004 xsuaa outside production profile', () => {
  const p = pkg((p) => (p.cds = { requires: { auth: 'xsuaa', '[production]': { db: 'hana' } } }));
  assert.ok(ids(makeProject({ 'package.json': p })).includes('CDS004'));
});

test('CDS004 respects a development override to mocked', () => {
  const p = pkg((p) => (p.cds = { requires: { auth: 'xsuaa', '[development]': { auth: 'mocked' }, '[production]': { db: 'hana' } } }));
  assert.ok(!ids(makeProject({ 'package.json': p })).includes('CDS004'));
});

test('CDS006 mocked auth in production', () => {
  const p = pkg((p) => (p.cds.requires['[production]'].auth = 'mocked'));
  assert.ok(ids(makeProject({ 'package.json': p })).includes('CDS006'));
});

test('CDS008 missing engines', () => {
  const p = pkg((p) => delete p.engines);
  assert.equal(find(makeProject({ 'package.json': p }), 'CDS008')!.severity, 'info');
});

test('.cdsrc.json is merged with package.json', () => {
  const p = pkg((p) => delete p.cds);
  const dir = makeProject({ 'package.json': p, '.cdsrc.json': { requires: { '[production]': { db: 'hana', auth: { kind: 'xsuaa' } } } } });
  assert.deepEqual(runChecks(dir).findings, []);
});

test('X001 srv module not bound to XSUAA', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '');
  const f = find(makeProject({ 'mta.yaml': mta }), 'X001');
  assert.ok(f);
  assert.match(f.fix!, /bookshop-auth/);
});

test('X002 destination without destination service', () => {
  const p = pkg((p) => (p.cds.requires.API_BUSINESS_PARTNER = { kind: 'odata-v2', credentials: { destination: 'S4' } }));
  assert.ok(ids(makeProject({ 'package.json': p })).includes('X002'));
});

test('REPO001 secrets not git-ignored', () => {
  const dir = makeProject({ '.gitignore': 'node_modules/\n', 'default-env.json': '{}', '.cdsrc-private.json': '{}' });
  assert.equal(runChecks(dir).findings.filter((f) => f.ruleId === 'REPO001').length, 2);
  const ok = makeProject({ '.gitignore': '/default-env.json\n.cdsrc-private.json\n', 'default-env.json': '{}', '.cdsrc-private.json': '{}' });
  assert.ok(!ids(ok).includes('REPO001'));
});

test('findings are sorted errors first', () => {
  const p = pkg((p) => {
    delete p.engines;
    delete p.dependencies['@sap/xssec'];
  });
  const sev = runChecks(makeProject({ 'package.json': p })).findings.map((f) => f.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
});
