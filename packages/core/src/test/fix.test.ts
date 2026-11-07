import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import { runChecks } from '../check';
import { StaleFixError, applyFixToDisk, fixAll } from '../fix/apply';
import { applyLineDiff, changedRegion } from '../fix/edit';
import { Finding } from '../types';
import { CLEAN_MTA, makeProject, pkg } from './helpers';

const findingOf = (dir: string, id: string): Finding => {
  const f = runChecks(dir).findings.find((x) => x.ruleId === id);
  assert.ok(f, `expected ${id}`);
  return f;
};

/** Applies the only fix of `id` and asserts the finding is gone and files still parse. */
function fixesIt(files: Parameters<typeof makeProject>[0], id: string, titleRe?: RegExp) {
  const dir = makeProject(files);
  const f = findingOf(dir, id);
  assert.equal(f.fixes?.length, 1, `${id} should have exactly one fix`);
  if (titleRe) assert.match(f.fixes![0].title, titleRe);
  applyFixToDisk(dir, f.fixes![0]);
  const after = runChecks(dir);
  assert.ok(!after.findings.some((x) => x.ruleId === id), `${id} still reported after fix`);
  assert.ok(!after.findings.some((x) => x.ruleId === 'MTA001' || x.ruleId === 'CDS000'), 'fix broke file syntax');
  return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('MTA002 adds _schema-version at the top', () => {
  const dir = fixesIt({ 'mta.yaml': CLEAN_MTA.replace("_schema-version: '3.1'\n", '') }, 'MTA002');
  assert.ok(read(dir, 'mta.yaml').startsWith("_schema-version: '3.1'\nID: bookshop"));
});

test('MTA004 renames to the resource of the same kind', () => {
  fixesIt({ 'mta.yaml': CLEAN_MTA.replace('      - name: bookshop-auth\n', '      - name: bookshop-uaa\n') }, 'MTA004', /to "bookshop-auth"/);
});

test('MTA004 removes the entry when the right one is already required', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '      - name: bookshop-auth\n      - name: bookshop-xsuaa\n');
  fixesIt({ 'mta.yaml': mta }, 'MTA004', /Remove/);
});

test('MTA004 offers no fix when nothing is similar', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '      - name: bookshop-auth\n      - name: totally-unrelated\n');
  assert.equal(findingOf(makeProject({ 'mta.yaml': mta }), 'MTA004').fixes, undefined);
});

test('MTA005 adds a before-all step before modules', () => {
  const mta = CLEAN_MTA.replace(/build-parameters:[\s\S]*?--production\n/, '');
  const dir = fixesIt({ 'mta.yaml': mta }, 'MTA005');
  const text = read(dir, 'mta.yaml');
  assert.ok(text.indexOf('build-parameters:') < text.indexOf('modules:'));
  assert.match(text, /- npx cds build --production/);
});

test('MTA006 requires the only HDI container', () => {
  fixesIt({ 'mta.yaml': CLEAN_MTA.replace('    path: gen/db\n    requires:\n      - name: bookshop-db\n', '    path: gen/db\n') }, 'MTA006');
});

test('MTA007 sets the default plan', () => {
  const dir = fixesIt({ 'mta.yaml': CLEAN_MTA.replace('      service-plan: application\n', '') }, 'MTA007');
  assert.match(read(dir, 'mta.yaml'), /service-plan: application/);
});

test('MTA008 creates xs-security.json', () => {
  const dir = fixesIt({ 'xs-security.json': null }, 'MTA008');
  assert.equal(JSON.parse(read(dir, 'xs-security.json')).xsappname, 'bookshop');
});

test('MTA010 raises memory and keeps the comment', () => {
  const dir = fixesIt({ 'mta.yaml': CLEAN_MTA.replace('memory: 256M', 'memory: 128M # small') }, 'MTA010');
  assert.match(read(dir, 'mta.yaml'), /memory: 256M #/);
});

test('MTA011 adds npx and @sap/cds-dk', () => {
  const p = pkg((p) => delete p.devDependencies['@sap/cds-dk']);
  const dir = fixesIt({ 'package.json': p, 'mta.yaml': CLEAN_MTA.replace('npx cds build', 'cds build') }, 'MTA011');
  assert.equal(JSON.parse(read(dir, 'package.json')).devDependencies['@sap/cds-dk'], '^9');
});

test('CDS005 moves @sap/cds out of devDependencies', () => {
  const p = pkg((p) => {
    delete p.dependencies['@sap/cds'];
    p.devDependencies['@sap/cds'] = '^9.1.0';
  });
  const dir = fixesIt({ 'package.json': p }, 'CDS005', /Move/);
  const after = JSON.parse(read(dir, 'package.json'));
  assert.equal(after.dependencies['@sap/cds'], '^9.1.0');
  assert.equal(after.devDependencies['@sap/cds'], undefined);
  assert.deepEqual(Object.keys(after.dependencies), [...Object.keys(after.dependencies)].sort());
});

test('CDS005 has no fix when no version is known', () => {
  const p = pkg((p) => delete p.dependencies['@sap/cds']);
  assert.equal(findingOf(makeProject({ 'package.json': p }), 'CDS005').fixes, undefined);
});

test('CDS001 adds a HANA driver matching the cds major version', () => {
  const p = pkg((p) => delete p.dependencies['@cap-js/hana']);
  const dir = fixesIt({ 'package.json': p }, 'CDS001', /@cap-js\/hana \^2/);
  assert.equal(JSON.parse(read(dir, 'package.json')).dependencies['@cap-js/hana'], '^2');
});

test('CDS001 prefers the version installed in node_modules', () => {
  const p = pkg((p) => delete p.dependencies['@cap-js/hana']);
  fixesIt({ 'package.json': p, 'node_modules/@cap-js/hana/package.json': '{"version":"2.3.1"}' }, 'CDS001', /\^2\.3\.1/);
});

test('CDS002 adds @sap/xssec', () => {
  fixesIt({ 'package.json': pkg((p) => delete p.dependencies['@sap/xssec']) }, 'CDS002');
});

test('CDS004 moves auth into [production] in package.json', () => {
  const p = pkg((p) => (p.cds = { requires: { auth: 'xsuaa', '[production]': { db: 'hana' } } }));
  const dir = fixesIt({ 'package.json': p }, 'CDS004');
  assert.deepEqual(JSON.parse(read(dir, 'package.json')).cds.requires, { '[production]': { db: 'hana', auth: 'xsuaa' } });
});

test('CDS004 works in .cdsrc.json and creates the profile block', () => {
  const p = pkg((p) => delete p.cds);
  const dir = fixesIt({ 'package.json': p, '.cdsrc.json': { requires: { db: 'hana', auth: { kind: 'xsuaa' } } } }, 'CDS004');
  assert.deepEqual(JSON.parse(read(dir, '.cdsrc.json')).requires['[production]'], { auth: { kind: 'xsuaa' } });
});

test('X001 binds the existing XSUAA resource', () => {
  fixesIt({ 'mta.yaml': CLEAN_MTA.replace('      - name: bookshop-auth\n', '') }, 'X001', /Require "bookshop-auth"/);
});

test('X001 creates an XSUAA resource when none exists', () => {
  const mta = CLEAN_MTA.replace('      - name: bookshop-auth\n', '').replace(/  - name: bookshop-auth\n[\s\S]*$/, '');
  const dir = fixesIt({ 'mta.yaml': mta }, 'X001', /Add an XSUAA resource "bookshop-auth"/);
  const data = parseDocument(read(dir, 'mta.yaml')).toJS();
  assert.equal(data.resources[1].parameters.service, 'xsuaa');
  assert.equal(data.resources[1].parameters.config.xsappname, 'bookshop-${org}-${space}');
});

test('X002 creates a destination resource and binds it', () => {
  const p = pkg((p) => (p.cds.requires.S4 = { kind: 'odata', credentials: { destination: 'S4' } }));
  fixesIt({ 'package.json': p }, 'X002', /bookshop-destination/);
});

test('REPO001 appends to .gitignore', () => {
  const dir = fixesIt({ '.gitignore': 'node_modules/', 'default-env.json': '{}' }, 'REPO001');
  assert.equal(read(dir, '.gitignore'), 'node_modules/\ndefault-env.json\n');
});

test('YAML fixes keep comments and spacing elsewhere in the file', () => {
  const mta = CLEAN_MTA.replace('memory: 256M', 'memory: 128M')
    .replace('        - npx cds build --production', '        - npx cds build --production   # build all')
    .replace('resources:', '# ---- resources ----\nresources:');
  const dir = makeProject({ 'mta.yaml': mta });
  applyFixToDisk(dir, findingOf(dir, 'MTA010').fixes![0]);
  const { startLine, endLine, newLines } = changedRegion(mta, read(dir, 'mta.yaml'));
  assert.equal(endLine - startLine, 1);
  assert.deepEqual(newLines, ['      memory: 256M']);
});

test('JSON fixes keep inline objects they do not touch', () => {
  const text = '{\n  "name": "x",\n  "dependencies": { "@sap/cds": "^9" },\n  "cds": { "requires": { "[production]": { "db": "hana", "auth": "xsuaa" } } }\n}\n';
  const dir = makeProject({ 'package.json': text });
  applyFixToDisk(dir, findingOf(dir, 'CDS002').fixes![0]);
  const after = read(dir, 'package.json');
  assert.ok(after.includes('"cds": { "requires": { "[production]": { "db": "hana", "auth": "xsuaa" } } }'));
  assert.equal(JSON.parse(after).dependencies['@sap/xssec'], '^4');
});

test('applyLineDiff keeps original lines that only differ in formatting', () => {
  const original = 'a:   1   # c\nb: 2\n';
  const baseline = 'a: 1 # c\nb: 2\n';
  const modified = 'a: 1 # c\nb: 3\n';
  assert.equal(applyLineDiff(original, baseline, modified), 'a:   1   # c\nb: 3\n');
});

test('stale fixes are refused', () => {
  const dir = makeProject({ 'mta.yaml': CLEAN_MTA.replace('memory: 256M', 'memory: 128M') });
  const fix = findingOf(dir, 'MTA010').fixes![0];
  fs.appendFileSync(path.join(dir, 'mta.yaml'), '# edited\n');
  assert.throws(() => applyFixToDisk(dir, fix), StaleFixError);
});

test('fixes cannot write outside the project', () => {
  const dir = makeProject();
  assert.throws(() => applyFixToDisk(dir, { title: 'x', changes: [{ file: '../evil.txt', before: null, after: 'x' }] }), /outside/);
});

test('fixAll repairs the broken example end to end', async () => {
  const example = path.resolve(__dirname, '../../../../examples/broken-bookshop');
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(example)) files[f] = fs.readFileSync(path.join(example, f), 'utf8');
  const dir = makeProject({ ...files, 'xs-security.json': null });
  const before = runChecks(dir).summary;
  assert.ok(before.error >= 7);
  const { applied, remaining } = await fixAll(dir);
  assert.ok(applied.length >= 10);
  assert.equal(remaining.summary.error, 0);
  assert.equal(remaining.summary.warning, 0);
});
