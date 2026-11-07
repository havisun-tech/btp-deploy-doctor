// Regression tests for false positives found by running the checks on public SAP sample
// projects (SAP-samples/*, cap-js/*). Each case mirrors a real project layout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../check';
import { CLEAN_MTA, FIORI_FILES, FIORI_MTA, makeProject, pkg } from './helpers';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const findings = (dir: string) => runChecks(dir).findings;
const has = (dir: string, id: string, severity?: string) => findings(dir).some((f) => f.ruleId === id && (!severity || f.severity === severity));
const fiori = (patch: Record<string, string | object | null> = {}) => makeProject({ ...FIORI_FILES, ...patch });

test('gen folder in a subproject, built by an npm script in before-all, is not reported', () => {
  // btp-cap-genai-semantic-search: "npm run build:cf --prefix api" and path api/gen/srv
  const mta = CLEAN_MTA.replace('npx cds build --production', 'npm run build:cf --prefix api')
    .replace('path: gen/srv', 'path: api/gen/srv')
    .replace('path: gen/db', 'path: api/gen/db');
  assert.ok(!has(makeProject({ 'mta.yaml': mta }), 'MTA005'));
});

test('root gen folder built by "npm run build" is not reported', () => {
  // btp-cap-genai-rag
  const mta = CLEAN_MTA.replace('npx cds build --production', 'npm run build');
  assert.ok(!has(makeProject({ 'mta.yaml': mta }), 'MTA005'));
});

test('a missing non-gen path is a warning when a build step exists, an error otherwise', () => {
  const withBuild = CLEAN_MTA.replace('path: gen/db', 'path: router/dist');
  assert.ok(has(makeProject({ 'mta.yaml': withBuild }), 'MTA005', 'warning'));
  const noBuild = withBuild.replace(/build-parameters:\n  before-all:\n    - builder: custom\n      commands:\n        - npx cds build --production\n/, '');
  assert.ok(has(makeProject({ 'mta.yaml': noBuild }), 'MTA005', 'error'));
});

test('a missing gen folder with no build step at all is still an error with a fix', () => {
  const noBuild = CLEAN_MTA.replace(/build-parameters:\n  before-all:\n    - builder: custom\n      commands:\n        - npx cds build --production\n/, '');
  const f = findings(makeProject({ 'mta.yaml': noBuild })).find((x) => x.ruleId === 'MTA005');
  assert.equal(f?.severity, 'error');
  assert.equal(f?.fixes?.length, 1);
});

test('a Neo MTA gets one info finding and no Cloud Foundry checks', () => {
  // fiori-tools-samples/neo-migration/neo
  const neo = `ID: solution
_schema-version: '3.1'
version: 1.0.0
parameters:
  hcp-deployer-version: 1.1.0
modules:
- name: app
  type: com.sap.hcp.html5
  path: html5-app-folder
- name: role2
  type: com.sap.hcp.html5.role
  path: dummy
`;
  const ids = findings(makeProject({ 'mta.yaml': neo, 'package.json': null, 'xs-security.json': null })).map((f) => f.ruleId);
  assert.deepEqual(ids, ['GEN002']);
});

test('@sap/cds-hana counts as a HANA driver', () => {
  // btp-event-driven-multi-tenant-architecture uses CAP 7 with @sap/cds-hana
  const p = pkg((x) => {
    for (const d of ['@cap-js/hana', 'hdb', '@sap/hana-client']) delete x.dependencies[d];
    x.dependencies['@sap/cds-hana'] = '^2';
  });
  assert.ok(!has(makeProject({ 'package.json': p }), 'CDS001'));
});

test('in-memory SQLite in production is info, file SQLite is a warning', () => {
  const mta = CLEAN_MTA.replace(/  - name: bookshop-db-deployer[\s\S]*?(?=resources:)/, '');
  const base = (db: unknown) => pkg((x) => {
    x.cds = { requires: { db } };
  });
  const mem = findings(makeProject({ 'mta.yaml': mta, 'package.json': base({ kind: 'sqlite', credentials: { database: ':memory:' } }) }));
  assert.equal(mem.find((f) => f.ruleId === 'CDS007')?.severity, 'info');
  const file = findings(makeProject({ 'mta.yaml': mta, 'package.json': base({ kind: 'sqlite', credentials: { database: 'db.sqlite' } }) }));
  assert.equal(file.find((f) => f.ruleId === 'CDS007')?.severity, 'warning');
});

test('an html5 module that runs @sap/approuter is not treated as repository content', () => {
  // liteinventorymanagement: old pattern with type html5 + approuter in app/package.json
  const mta = FIORI_MTA.replace(/        - artifacts:\n            - comsapbookshopbrowse.zip\n          name: comsapbookshopbrowse\n          target-path: resources\/\n/, '        []\n')
    .replace('      supported-platforms: []\n', '');
  const dir = fiori({
    'mta.yaml': mta,
    'app/browse/package.json': { name: 'browse', dependencies: { '@sap/approuter': '^21' }, scripts: { start: 'node node_modules/@sap/approuter/approuter.js', 'build:cf': 'ui5 build' } },
  });
  const ui = findings(dir).filter((f) => f.ruleId.startsWith('UI'));
  assert.deepEqual(ui.map((f) => f.ruleId), []);
});

test('apps shipped by the older com.sap.html5.application-content deployer are not "never deployed"', () => {
  // btp-cap-genai-rag
  const mta = FIORI_MTA.replace(/        - artifacts:\n            - comsapbookshopbrowse.zip\n          name: comsapbookshopbrowse\n          target-path: resources\/\n/, '        []\n')
    .replace('resources:\n  - name: bookshop-repo-host', `  - name: bookshop-app-deployer
    type: com.sap.html5.application-content
    path: app/html5-deployer
    requires:
      - name: bookshop-repo-host
resources:
  - name: bookshop-repo-host`);
  assert.ok(!has(fiori({ 'mta.yaml': mta, 'app/html5-deployer/package.json': { name: 'deployer' } }), 'UI001'));
});

test('a standalone approuter without business services does not need sap.cloud.service', () => {
  // btp-cap-multitenant-saas, btp-cap-genai-rag
  const mta = FIORI_MTA.replace(/              sap\.cloud\.service: bookshop\n/g, '').replace('modules:\n', `modules:
  - name: bookshop-approuter
    type: approuter.nodejs
    path: router
`);
  const manifest = clone(FIORI_FILES['app/browse/webapp/manifest.json']) as any;
  delete manifest['sap.cloud'];
  const dir = fiori({ 'mta.yaml': mta, 'app/browse/webapp/manifest.json': manifest, 'router/xs-app.json': { routes: [] }, 'router/package.json': { name: 'r' } });
  assert.ok(!has(dir, 'UI008'));
  // With the managed approuter the same manifest is still reported.
  assert.ok(has(fiori({ 'app/browse/webapp/manifest.json': manifest }), 'UI008'));
});

test('a templated sap.cloud.service in mta.yaml is not compared', () => {
  // btp-user-management-microservice: sap.cloud.service: ${appname}
  const mta = FIORI_MTA.replace(/sap\.cloud\.service: bookshop/g, 'sap.cloud.service: ${appname}');
  assert.ok(!has(fiori({ 'mta.yaml': mta }), 'UI008'));
});

test('the Application Frontend service does not need HTML5Runtime_enabled', () => {
  // fiori-tools-samples/cap/cap-with-frontend-service
  const mta = FIORI_MTA.replace('        HTML5Runtime_enabled: true\n', '').replace('resources:\n', `resources:
  - name: bookshop-app-front
    type: org.cloudfoundry.managed-service
    parameters:
      service: app-front
      service-plan: developer
`);
  const manifest = clone(FIORI_FILES['app/browse/webapp/manifest.json']) as any;
  manifest['sap.app'].dataSources.mainService.uri = '/odata/v4/catalog/';
  const dir = fiori({ 'mta.yaml': mta, 'app/browse/webapp/manifest.json': manifest });
  assert.ok(!has(dir, 'UI010'));
  assert.ok(has(dir, 'UI009'), 'absolute URIs still break under the app path');
  // Without app-front the missing flag is reported.
  assert.ok(has(fiori({ 'mta.yaml': FIORI_MTA.replace('        HTML5Runtime_enabled: true\n', '') }), 'UI010'));
});

test('a destination created in the cockpit is info, a near-miss name is a warning', () => {
  const xs = clone(FIORI_FILES['app/browse/xs-app.json']) as any;
  xs.routes.unshift({ source: '^/northwind/(.*)$', target: '$1', destination: 'northwind' });
  const info = findings(fiori({ 'app/browse/xs-app.json': xs })).find((f) => f.ruleId === 'UI007');
  assert.equal(info?.severity, 'info');
  assert.equal(info?.fixes, undefined);
  xs.routes[0].destination = 'srv_api';
  const typo = findings(fiori({ 'app/browse/xs-app.json': xs })).find((f) => f.ruleId === 'UI007');
  assert.equal(typo?.severity, 'warning');
  assert.equal(typo?.fixes?.length, 1);
});

test('module paths like "./app/browse/" give clean file locations', () => {
  const mta = FIORI_MTA.replace('    path: app/browse\n', '    path: ./app/browse/\n');
  const manifest = clone(FIORI_FILES['app/browse/webapp/manifest.json']) as any;
  delete manifest['sap.cloud'];
  const f = findings(fiori({ 'mta.yaml': mta, 'app/browse/webapp/manifest.json': manifest })).find((x) => x.ruleId === 'UI008');
  assert.equal(f?.location.file, 'app/browse/webapp/manifest.json');
});
