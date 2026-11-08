import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLog } from '../logs/analyze';
import { LOG_PATTERNS } from '../logs/patterns';

const SAMPLES: Record<string, string> = {
  'auth-not-bound': '[cds] - Error: Authentication kind "xsuaa" configured, but no XSUAA instance bound to application.',
  'hdi-build-plugin': 'Error: Could not find the "com.sap.hana.di.cds" build plugin [8210015]',
  'hdi-incompatible-change': 'Error: com.sap.hana.di.table: SQL error 7: feature not supported: cannot change the data type',
  'hdi-duplicate-key': 'Error: unique constraint violated: Table(MY_BOOKSHOP_BOOKS)',
  'hdi-privilege': 'Error: insufficient privilege: Detailed info for this error can be found with guid',
  'hana-no-instance': 'Service broker error: Could not find any HANA database instance for org and space',
  'hana-unreachable': 'Error: Connection to abc.hana.prod-eu10.hanacloud.ondemand.com:443 failed: socket closed',
  'service-offering-missing': "Service offering 'hana' not found",
  'service-name-taken': 'Service broker error: Service instance name is taken: bookshop-auth',
  'service-not-found': 'Error: Service "${service-name}" not found',
  'xsappname-conflict': 'Service broker error: xsappname "bookshop" already exists in subaccount',
  'package-json-missing': "npm ERR! enoent ENOENT: no such file or directory, open '/home/vcap/app/package.json'",
  'module-not-found': "Error: Cannot find module '@sap/xssec'",
  'cds-not-found': 'sh: 1: cds: not found',
  'npm-sap-registry': 'npm ERR! 404 Not Found - GET https://npm.sap.com/@sap%2fcds',
  'npm-version-missing': 'npm ERR! notarget No matching version found for @sap/cds@^99.0.0.',
  'npm-eresolve': 'npm ERR! ERESOLVE unable to resolve dependency tree',
  'health-check': 'Timed out after 1m0s: health check never passed.',
  'out-of-memory': 'APP/PROC/WEB/0 Exited with status 137 (out of memory)',
  'disk-quota': 'Error: ENOSPC: No space left on device',
  'app-too-large': 'Upload of application content failed: 413 Request Entity Too Large',
  'destination-not-found': 'Error: Failed to load destination S4HANA',
  'onprem-connection': 'Error: read ECONNRESET at connectivity proxy connectivityproxy.internal.cf.eu10.hana.ondemand.com:20003',
  'auth-forbidden': 'GET /odata/v4/admin/Books 403 Forbidden',
  'sqlite-busy': 'Error: SQLITE_BUSY: database is locked',
  'port-in-use': 'Error: listen EADDRINUSE: address already in use :::4004',
  'broker-error': 'Service broker error: Internal Server Error',
  'cap-missing-role': `[cds] - 403 - Forbidden { reason: "User 'alice' is lacking required roles: [Admin]", user: 'alice' }`,
  'insufficient-scope': 'WWW-Authenticate: Bearer error="insufficient_scope"',
  'token-audience': "Error: Jwt token with audience: [ 'sb-other!t1' ] is not issued for these clientIds: [ 'sb-bookshop!t2' ]",
  'token-expired': 'TokenExpiredError: jwt expired',
  'token-missing': 'Error: Invalid token: jwt malformed',
  'csrf-token': 'POST /odata/v4/admin/Books 403 Forbidden - CSRF token validation failed',
  'redirect-mismatch': 'Invalid redirect https://acme-bookshop.cfapps.eu10.hana.ondemand.com/login/callback did not match one of the registered values',
  'xsuaa-descriptor-rejected': 'Service broker error: Invalid scope reference in role template "Viewer"',
  'hdi-deploy-failed': 'Deployment to container BOOKSHOP_HDI failed - error: Error executing make',
  'ui5-task-missing': "Error: Cannot find module 'ui5-task-zipper'",
  'mbt-artifact-missing': 'ERROR could not copy build artifacts: the "comsapbookshopbrowse.zip" artifact was not found',
  'html5-xs-app-missing': 'Error: xs-app.json file is missing in application comsapbookshopbrowse',
  'html5-app-not-found': 'Application comsapbookshopbrowse-1.0.0 not found in HTML5 Application Repository',
  'mtx-subscription-failed': 'Subscription failed: onSubscription callback returned status code 500',
  'mtx-tenant-unknown': "Error: Tenant 'a1b2c3d4-0000-1111-2222-333344445555' is not subscribed",
  'tenant-host-pattern': 'Host acme-bookshop.cfapps.eu10.hana.ondemand.com does not match TENANT_HOST_PATTERN',
  'app-crashed': 'Error starting application "bookshop-srv": Some instances have crashed.',
};

test('every pattern has a sample', () => {
  assert.deepEqual(LOG_PATTERNS.map((p) => p.id).sort(), Object.keys(SAMPLES).sort());
});

for (const [id, line] of Object.entries(SAMPLES)) {
  test(`detects ${id}`, () => {
    const ids = analyzeLog(`some noise\n${line}\nmore noise`).matches.map((m) => m.patternId);
    assert.ok(ids.includes(id), `expected ${id}, got ${ids.join(', ') || 'nothing'}`);
  });
}

test('fills capture groups into the fix', () => {
  const m = analyzeLog("Error: Cannot find module 'hdb'").matches[0];
  assert.match(m.fix, /Move "hdb" to dependencies/);
});

test('strips ANSI colors, counts repeats, reports first line', () => {
  const log = 'ok\n\x1b[31mError: SQLITE_BUSY: database is locked\x1b[0m\nError: SQLITE_BUSY: database is locked\n';
  const [m] = analyzeLog(log).matches;
  assert.equal(m.line, 2);
  assert.equal(m.count, 2);
  assert.ok(!m.text.includes('\x1b'));
});

test('extracts MTA operation IDs', () => {
  const log = 'Process failed.\nUse "cf dmol -i 6f1c2e5a-0b9d-11ef-a1b2-eeee00001111" to download the logs of the process.';
  assert.deepEqual(analyzeLog(log).operationIds, ['6f1c2e5a-0b9d-11ef-a1b2-eeee00001111']);
});

test('lists unexplained error lines', () => {
  const r = analyzeLog('info\nERROR something completely new happened\n');
  assert.equal(r.matches.length, 0);
  assert.equal(r.otherErrors[0].line, 2);
});

test('generic patterns yield to specific ones on the same line', () => {
  const r = analyzeLog('Error: com.sap.hana.di.table: Could not find the "com.sap.hana.di.cds" build plugin');
  assert.deepEqual(r.matches.map((m) => m.patternId), ['hdi-build-plugin']);
});

test('ui5 tasks are not reported as runtime modules', () => {
  const ids = analyzeLog("Error: Cannot find module 'ui5-task-zipper'").matches.map((m) => m.patternId);
  assert.ok(!ids.includes('module-not-found'));
});

test('clean log has no matches', () => {
  const r = analyzeLog('[cds] - serving CatalogService { path: /odata/v4/catalog }\n[cds] - server listening on { url: http://localhost:4004 }');
  assert.equal(r.matches.length, 0);
  assert.equal(r.otherErrors.length, 0);
});

test('a specific 401/403 cause replaces the general one on the same line', () => {
  const ids = analyzeLog('POST /odata/v4/admin/Books 403 Forbidden - CSRF token validation failed').matches.map((m) => m.patternId);
  assert.deepEqual(ids, ['csrf-token']);
});

test('names the missing role', () => {
  const m = analyzeLog(`reason: "User 'bob' is lacking required roles: [ 'Admin', 'Viewer' ]"`).matches[0];
  assert.equal(m.patternId, 'cap-missing-role');
  assert.match(m.explanation, /required role\(s\): 'Admin', 'Viewer'\./);
});

test('an invalid CSRF token is not reported as a missing user token', () => {
  const ids = analyzeLog('Error: invalid csrf token').matches.map((m) => m.patternId);
  assert.deepEqual(ids, ['csrf-token']);
});
