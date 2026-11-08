import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { runChecks } from '../check';
import { applyFixToDisk, autoFixable } from '../fix/apply';
import { Finding } from '../types';
import { FIORI_FILES, FIORI_MTA, MTX_FILES, MTX_MTA, MTX_PACKAGE, makeProject } from './helpers';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const fiori = (patch: Record<string, string | object | null> = {}) => makeProject({ ...FIORI_FILES, ...patch });
const mtx = (patch: Record<string, string | object | null> = {}) => makeProject({ ...MTX_FILES, ...patch });
const ids = (dir: string) => runChecks(dir).findings.map((f) => f.ruleId);
const findingOf = (dir: string, id: string, re?: RegExp): Finding => {
  const f = runChecks(dir).findings.find((x) => x.ruleId === id && (!re || re.test(x.title)));
  assert.ok(f, `expected ${id}, got ${ids(dir).join(', ')}`);
  return f;
};
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** Applies the only fix and asserts the finding is gone without breaking any file. */
function fixes(dir: string, id: string, titleRe?: RegExp) {
  const f = findingOf(dir, id, titleRe);
  assert.equal(f.fixes?.length, 1, `${id} should have one fix`);
  applyFixToDisk(dir, f.fixes![0]);
  const after = runChecks(dir).findings;
  assert.ok(!after.some((x) => x.ruleId === id && x.title === f.title), `${id} still reported`);
  assert.ok(!after.some((x) => ['MTA001', 'CDS000', 'UI007'].includes(x.ruleId) && /is not valid/.test(x.title)), 'a file was broken');
  return dir;
}

// ---------------- Fiori ----------------

test('a clean managed-approuter Fiori project has no findings', () => {
  assert.deepEqual(runChecks(fiori()).findings.map((f) => `${f.ruleId}: ${f.title}`), []);
});

test('UI001 app not packaged by a content module, fix adds it', () => {
  const mta = FIORI_MTA.replace('        - artifacts:\n            - comsapbookshopbrowse.zip\n          name: comsapbookshopbrowse\n          target-path: resources/\n', '        []\n');
  const broken = mta.replace('      requires:\n        []\n', '');
  const dir = fiori({ 'mta.yaml': broken });
  assert.ok(ids(dir).includes('UI001'));
});

test('UI001 fix packages the app in the content module', () => {
  const second = FIORI_MTA.replace('resources:\n  - name: bookshop-repo-host', `  - name: bookshop-admin
    type: html5
    path: app/admin
    build-parameters:
      build-result: dist
      supported-platforms: []
resources:
  - name: bookshop-repo-host`);
  assert.notEqual(second, FIORI_MTA);
  const dir = fiori({ 'mta.yaml': second, 'app/admin/webapp/manifest.json': { 'sap.app': { id: 'admin' }, 'sap.cloud': { public: true, service: 'bookshop' } }, 'app/admin/xs-app.json': { routes: [] } });
  fixes(dir, 'UI001');
  assert.match(read(dir, 'mta.yaml'), /- bookshopadmin\.zip/);
});

test('UI002 artifact name mismatch after renaming the app', () => {
  const dir = fiori({ 'app/browse/ui5-deploy.yaml': (FIORI_FILES['app/browse/ui5-deploy.yaml'] as string).replace('archiveName: comsapbookshopbrowse', 'archiveName: browseapp') });
  fixes(dir, 'UI002');
  assert.match(read(dir, 'mta.yaml'), /- browseapp\.zip/);
});

test('UI003 missing content-target', () => {
  const dir = fiori({ 'mta.yaml': FIORI_MTA.replace('      - name: bookshop-repo-host\n        parameters:\n          content-target: true\n', '      - name: bookshop-repo-host\n        parameters:\n          content-target: false\n') });
  fixes(dir, 'UI003');
});

test('UI003 no repository at all creates one', () => {
  const mta = FIORI_MTA.replace('    requires:\n      - name: bookshop-repo-host\n        parameters:\n          content-target: true\n', '');
  const dir = fiori({ 'mta.yaml': mta });
  fixes(dir, 'UI003', /not bound/);
});

test('UI004 missing build:cf script is added', () => {
  const pkg = clone(FIORI_FILES['app/browse/package.json']) as any;
  delete pkg.scripts;
  const dir = fiori({ 'app/browse/package.json': pkg });
  fixes(dir, 'UI004');
  assert.match(JSON.parse(read(dir, 'app/browse/package.json')).scripts['build:cf'], /--config ui5-deploy\.yaml/);
});

test('UI005 zipper task not installed', () => {
  const pkg = clone(FIORI_FILES['app/browse/package.json']) as any;
  delete pkg.devDependencies['ui5-task-zipper'];
  fixes(fiori({ 'app/browse/package.json': pkg }), 'UI005');
});

test('UI005 no zipper task adds one', () => {
  const yaml = (FIORI_FILES['app/browse/ui5-deploy.yaml'] as string).replace(/  customTasks:[\s\S]*$/, '');
  const dir = fiori({ 'app/browse/ui5-deploy.yaml': yaml });
  fixes(dir, 'UI005');
  assert.match(read(dir, 'app/browse/ui5-deploy.yaml'), /archiveName: comsapbookshopbrowse/);
});

test('UI006 missing xs-app.json is created with the service route', () => {
  const dir = fiori({ 'app/browse/xs-app.json': null });
  fixes(dir, 'UI006');
  assert.equal(JSON.parse(read(dir, 'app/browse/xs-app.json')).routes[0].destination, 'srv-api');
});

test('UI006 xs-app.json not packaged', () => {
  const yaml = (FIORI_FILES['app/browse/ui5-deploy.yaml'] as string).replace('        additionalFiles:\n          - xs-app.json\n', '');
  fixes(fiori({ 'app/browse/ui5-deploy.yaml': yaml }), 'UI006', /not packaged/);
});

test('UI007 invalid route regex and misspelled destination', () => {
  const xs = clone(FIORI_FILES['app/browse/xs-app.json']) as any;
  xs.routes[0].destination = 'srv_api';
  xs.routes.push({ source: '^/(broken$', target: '$1' });
  const dir = fiori({ 'app/browse/xs-app.json': xs });
  assert.ok(runChecks(dir).findings.some((f) => f.ruleId === 'UI007' && /Invalid route/.test(f.title)));
  fixes(dir, 'UI007', /unknown destination/);
  assert.equal(JSON.parse(read(dir, 'app/browse/xs-app.json')).routes[0].destination, 'srv-api');
});

test('UI008 missing and mismatched sap.cloud.service', () => {
  const m = clone(FIORI_FILES['app/browse/webapp/manifest.json']) as any;
  delete m['sap.cloud'];
  const dir = fiori({ 'app/browse/webapp/manifest.json': m });
  fixes(dir, 'UI008');
  assert.equal(JSON.parse(read(dir, 'app/browse/webapp/manifest.json'))['sap.cloud'].service, 'bookshop');
  m['sap.cloud'] = { public: true, service: 'bookstore' };
  fixes(fiori({ 'app/browse/webapp/manifest.json': m }), 'UI008');
});

test('UI009 absolute data source URI: fix needs review', () => {
  const m = clone(FIORI_FILES['app/browse/webapp/manifest.json']) as any;
  m['sap.app'].dataSources.mainService.uri = '/odata/v4/catalog/';
  const dir = fiori({ 'app/browse/webapp/manifest.json': m });
  const f = findingOf(dir, 'UI009');
  assert.equal(f.fixes![0].requiresReview, true);
  assert.ok(!autoFixable(runChecks(dir).findings).some((x) => x.ruleId === 'UI009'));
  fixes(dir, 'UI009');
  assert.equal(JSON.parse(read(dir, 'app/browse/webapp/manifest.json'))['sap.app'].dataSources.mainService.uri, 'odata/v4/catalog/');
});

test('UI010 HTML5 runtime not enabled', () => {
  fixes(fiori({ 'mta.yaml': FIORI_MTA.replace('        HTML5Runtime_enabled: true\n', '') }), 'UI010');
});

test('UI011 wrong instance name and service key', () => {
  const dir = fiori({ 'mta.yaml': FIORI_MTA.replace('ServiceInstanceName: bookshop-html5-app-host-service', 'ServiceInstanceName: bookshop-repo-host') });
  fixes(dir, 'UI011', /unknown instance/);
  const dir2 = fiori({ 'mta.yaml': FIORI_MTA.replace('ServiceKeyName: bookshop-auth-key', 'ServiceKeyName: bookshop-uaa-key') });
  fixes(dir2, 'UI011', /service key/);
});

test('UI012 html5 module without supported-platforms', () => {
  const dir = fiori({ 'mta.yaml': FIORI_MTA.replace('      supported-platforms: []\n', '') });
  fixes(dir, 'UI012');
  assert.match(read(dir, 'mta.yaml'), /supported-platforms: \[\]/);
});

test('Fiori checks stay quiet without html5 modules', () => {
  assert.ok(!ids(makeProject()).some((i) => i.startsWith('UI')));
});

// ---------------- multitenancy ----------------

test('a clean multitenant CAP project has no findings', () => {
  assert.deepEqual(runChecks(mtx()).findings.map((f) => `${f.ruleId}: ${f.title}`), []);
});

test('MTX checks stay quiet for single-tenant apps', () => {
  const pkg = clone(MTX_PACKAGE) as any;
  pkg.cds.requires['[production]'].multitenancy = false;
  assert.ok(!ids(mtx({ 'package.json': pkg })).some((i) => i.startsWith('MT0')));
});

test('MT001 missing @sap/cds-mtxs', () => {
  const pkg = clone(MTX_PACKAGE) as any;
  delete pkg.dependencies['@sap/cds-mtxs'];
  const dir = mtx({ 'package.json': pkg });
  fixes(dir, 'MT001');
  assert.equal(JSON.parse(read(dir, 'package.json')).dependencies['@sap/cds-mtxs'], '^3');
});

test('MT002 dedicated tenant mode, in mta.yaml or xs-security.json', () => {
  fixes(mtx({ 'mta.yaml': MTX_MTA.replace('tenant-mode: shared', 'tenant-mode: dedicated') }), 'MT002');
  const dir = mtx({ 'mta.yaml': MTX_MTA.replace('        tenant-mode: shared\n', ''), 'xs-security.json': { xsappname: 'saas', 'tenant-mode': 'dedicated' } });
  fixes(dir, 'MT002');
  assert.equal(JSON.parse(read(dir, 'xs-security.json'))['tenant-mode'], 'shared');
});

test('MT003 no Service Manager adds it to service and sidecar', () => {
  const mta = MTX_MTA.replace(/      - name: saas-db\n/g, '').replace(/  - name: saas-db\n    type: org.cloudfoundry.managed-service\n    parameters:\n      service: service-manager\n      service-plan: container\n/, '');
  const dir = mtx({ 'mta.yaml': mta });
  fixes(dir, 'MT003');
  assert.equal((read(dir, 'mta.yaml').match(/- name: saas-db/g) ?? []).length, 3);
});

test('MT007 sidecar not bound to Service Manager', () => {
  const mta = MTX_MTA.replace('    path: gen/mtx/sidecar\n    requires:\n      - name: saas-db\n', '    path: gen/mtx/sidecar\n    requires:\n');
  fixes(mtx({ 'mta.yaml': mta }), 'MT007');
});

test('MT004 missing onSubscription', () => {
  assert.ok(ids(mtx({ 'mta.yaml': MTX_MTA.replace(/          onSubscription: .*\n/, '') })).includes('MT004'));
});

test('MT005 sidecar profile without sidecar module', () => {
  const mta = MTX_MTA.replace(/  - name: saas-mtx\n[\s\S]*?mtx-url: \$\{default-url\}\n/, '');
  assert.ok(ids(mtx({ 'mta.yaml': mta })).includes('MT005'));
});

test('MT006 approuter without TENANT_HOST_PATTERN', () => {
  const dir = mtx({ 'mta.yaml': MTX_MTA.replace('    properties:\n      TENANT_HOST_PATTERN: "^(.*)-${default-uri}"\n', '') });
  fixes(dir, 'MT006');
  assert.match(read(dir, 'mta.yaml'), /TENANT_HOST_PATTERN: \^\(\.\*\)-\$\{default-uri\}|TENANT_HOST_PATTERN: "\^\(\.\*\)-\$\{default-uri\}"/);
});

test('MT008 registry xsappname differs from XSUAA', () => {
  fixes(mtx({ 'mta.yaml': MTX_MTA.replace('        xsappname: saas-${org}-${space}\n        appName', '        xsappname: saas-app\n        appName') }), 'MT008');
});

test('MT009 static HDI deployer in a multitenant app', () => {
  const mta = MTX_MTA.replace('resources:\n', '  - name: saas-db-deployer\n    type: hdb\n    path: gen/db\n    requires:\n      - name: saas-hdi\nresources:\n  - name: saas-hdi\n    type: com.sap.xs.hdi-container\n    parameters:\n      service: hana\n      service-plan: hdi-shared\n');
  assert.ok(ids(mtx({ 'mta.yaml': mta })).includes('MT009'));
});

// ---------------- Work Zone ----------------

const manifestWith = (patch: (m: any) => void) => {
  const m = clone(FIORI_FILES['app/browse/webapp/manifest.json']);
  patch(m);
  return { 'app/browse/webapp/manifest.json': m };
};

test('UI013 no inbound for Work Zone is info, and its fix needs review', () => {
  const dir = fiori(manifestWith((m) => delete m['sap.app'].crossNavigation));
  const f = findingOf(dir, 'UI013');
  assert.equal(f.severity, 'info');
  assert.equal(f.fixes?.[0].requiresReview, true);
  applyFixToDisk(dir, f.fixes![0]);
  const inbound = JSON.parse(read(dir, 'app/browse/webapp/manifest.json'))['sap.app'].crossNavigation.inbounds['browse-display'];
  assert.deepEqual([inbound.semanticObject, inbound.action], ['browse', 'display']);
  assert.ok(!ids(dir).includes('UI013'));
});

test('UI013 keeps existing outbounds when adding the inbound', () => {
  const dir = fiori(manifestWith((m) => (m['sap.app'].crossNavigation = { outbounds: { toOrders: { semanticObject: 'Orders', action: 'display' } } })));
  applyFixToDisk(dir, findingOf(dir, 'UI013').fixes![0]);
  const nav = JSON.parse(read(dir, 'app/browse/webapp/manifest.json'))['sap.app'].crossNavigation;
  assert.ok(nav.outbounds.toOrders && nav.inbounds['browse-display']);
});

test('UI013 is not reported for apps served by the Application Frontend service', () => {
  const mta = FIORI_MTA.replace('resources:\n', 'resources:\n  - name: bookshop-app-front\n    type: org.cloudfoundry.managed-service\n    parameters:\n      service: app-front\n      service-plan: developer\n');
  assert.ok(!ids(fiori({ 'mta.yaml': mta, ...manifestWith((m) => delete m['sap.app'].crossNavigation) })).includes('UI013'));
});

test('UI014 sap.cloud.public missing, fix sets it', () => {
  fixes(fiori(manifestWith((m) => delete m['sap.cloud'].public)), 'UI014');
});
