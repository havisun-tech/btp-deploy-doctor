import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { parseDcl, policiesForRole, scanAms } from '../ams';
import { runChecks } from '../check';
import { applyFixToDisk } from '../fix/apply';

const EXAMPLE = path.resolve(__dirname, '../../../../examples/broken-ams');

function copyExample(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-ams-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
}
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const ids = (root: string) => runChecks(root).findings.filter((f) => f.ruleId.startsWith('AMS')).map((f) => f.ruleId).sort();

test('parses DCL as SAP samples write it', () => {
  const d = parseDcl(`
// line comment with POLICY Fake { ASSIGN ROLE Fake; }
@label: 'Read Products'
@description: 'Allows to see the products.'
POLICY ReadProducts {
  GRANT read ON products;
}
/* POLICY Hidden { ASSIGN ROLE Hidden; } */
INTERNAL POLICY Api { USE shopping.CreateOrders RESTRICT order.total < 100, product.category IS NOT RESTRICTED; }
DEFAULT POLICY "Base" {
  ASSIGN ROLE A, "B-2" WHERE Genre IS NOT RESTRICTED AND $app.Price < 10;
  GRANT C ON $SCOPES;
  USE Reader RESTRICT order.createdBy = $user.scim_id;
}
SCHEMA {
  "$user": { scim_id: String },
  order: { total: Number, createdBy: String },
  @valueHelp: { path: 'Genres', valueField: 'name' }
  Genre: String,
  Tags: String[]
}`);
  assert.deepEqual(d.policies.map((p) => [p.kind, p.name, p.label]), [['policy', 'ReadProducts', 'Read Products'], ['internal', 'Api', undefined], ['default', 'Base', undefined]]);
  const base = d.policies[2];
  assert.deepEqual(base.roles.map((r) => r.role), ['A', 'B-2', 'C']);
  assert.deepEqual(base.roles[0].attributes.map((a) => a.path), ['Genre', 'Price']);
  assert.equal(base.roles[0].condition, 'Genre IS NOT RESTRICTED AND $app.Price < 10');
  assert.deepEqual(base.uses[0].attributes.map((a) => a.path), ['order.createdBy', '$user.scim_id']);
  assert.deepEqual(d.policies[1].uses[0].attributes.map((a) => a.path), ['order.total', 'product.category']);
  assert.deepEqual(d.policies[0].grants, [{ actions: ['read'], resources: ['products'], line: 6, condition: undefined, attributes: [] }]);
  assert.deepEqual(d.schema.map((s) => `${s.path}:${s.type}`), ['$user.scim_id:String', 'order.total:Number', 'order.createdBy:String', 'Genre:String', 'Tags:String[]']);
});

test('resolves packages, USE targets and the policies that give a role', () => {
  const m = scanAms(EXAMPLE);
  assert.equal(m.schemaFile, 'ams/dcl/schema.dcl');
  assert.deepEqual(m.policies.map((p) => p.qualified), ['cap.Viewer', 'cap.SalesRep', 'cap.Approver', 'local.SalesRepEU', 'local.ViewerSmall']);
  assert.deepEqual(m.policies[4].uses.map((u) => u.target), ['cap.Viewer']);
  const viewer = policiesForRole(m, 'Viewer');
  assert.deepEqual(viewer.direct.map((p) => p.qualified), ['cap.Viewer', 'local.ViewerSmall']);
  assert.deepEqual(m.mappings.map((x) => `${x.name}=${x.element}`), ['Region=region', 'Budget=amount']);
});

test('finds the broken-ams problems, and its fixes clear all of them', () => {
  const root = copyExample();
  assert.deepEqual(ids(root), ['AMS001', 'AMS002', 'AMS003', 'AMS005', 'AMS006', 'AMS010', 'AMS011']);
  for (let i = 0; i < 20; i++) {
    const f = runChecks(root).findings.find((x) => x.ruleId.startsWith('AMS') && x.fixes?.length);
    if (!f) break;
    applyFixToDisk(root, f.fixes![0]);
  }
  assert.deepEqual(ids(root), []);
  const base = fs.readFileSync(path.join(root, 'ams/dcl/cap/basePolicies.dcl'), 'utf8');
  assert.match(base, /POLICY "SalesManager" \{\n\tASSIGN ROLE "SalesManager";\n\}\n$/);
  assert.match(fs.readFileSync(path.join(root, 'ams/dcl/schema.dcl'), 'utf8'), /Region: String,\n\tBudget: Number\n\}/);
});

test('roles are not missing while cds build still generates basePolicies.dcl', () => {
  const root = copyExample();
  fs.rmSync(path.join(root, 'ams/dcl/cap/basePolicies.dcl'));
  write(root, 'ams/dcl/local/testPolicies.dcl', 'POLICY X { USE cap.Viewer; }\n');
  assert.ok(!ids(root).includes('AMS001'));
  // With generation switched off, nothing creates it: the fix creates the file.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.cds.requires.auth['[production]'].ams = { generateDcl: false };
  write(root, 'package.json', JSON.stringify(pkg, null, 2));
  const f = runChecks(root).findings.filter((x) => x.ruleId === 'AMS001');
  assert.equal(f.length, 4);
  assert.equal(f[0].fixes![0].changes[0].before, null);
});

test('XSUAA projects and non-AMS projects get no AMS findings', () => {
  const root = copyExample();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.cds.requires.auth['[production]'].kind = 'xsuaa';
  write(root, 'package.json', JSON.stringify(pkg, null, 2));
  assert.deepEqual(ids(root), []);
  const plain = copyExample();
  fs.rmSync(path.join(plain, 'ams'), { recursive: true });
  const p2 = JSON.parse(fs.readFileSync(path.join(plain, 'package.json'), 'utf8'));
  delete p2.devDependencies['@sap/ams'];
  write(plain, 'package.json', JSON.stringify(p2, null, 2));
  assert.deepEqual(ids(plain), []);
});

test('built-in $ attributes are not checked unless the schema defines them', () => {
  const root = copyExample();
  write(root, 'ams/dcl/local/testPolicies.dcl', "POLICY A { USE cap.Viewer RESTRICT Region = $env.region; }\nPOLICY B { USE cap.Viewer RESTRICT Region = $user.city; }\n");
  assert.ok(!runChecks(root).findings.some((f) => f.ruleId === 'AMS005'));
  write(root, 'ams/dcl/schema.dcl', 'SCHEMA {\n\tRegion: String,\n\tBudget: Number,\n\t"$user": { scim_id: String }\n}\n');
  const f = runChecks(root).findings.filter((x) => x.ruleId === 'AMS005');
  assert.deepEqual(f.map((x) => x.title), ['Unknown attribute "$user.city" in policy "local.B"']);
});

test('a duplicate policy is reported once, at the second definition', () => {
  const root = copyExample();
  write(root, 'ams/dcl/cap/more.dcl', 'POLICY "Viewer" {\n  ASSIGN ROLE "Viewer";\n}\n');
  const f = runChecks(root).findings.filter((x) => x.ruleId === 'AMS004');
  assert.equal(f.length, 1);
  assert.equal(f[0].location.file, 'ams/dcl/cap/more.dcl');
});

// Patterns from SAP-samples/ams-samples-node (ams-cap-nodejs-bookshop), which compiles cleanly.
test('SAP\'s AMS bookshop sample gets no AMS findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-ams-sample-'));
  write(root, 'package.json', JSON.stringify({ name: 'ams-cap-nodejs-bookshop', dependencies: { '@sap/ams': '^3.10.0', '@sap/cds': '^10.2.1', '@sap/xssec': '^4', express: '^4' }, devDependencies: { '@sap/ams-dev': '^3.0.2', '@sap/cds-dk': '^10.2.0' } }));
  write(root, '.cdsrc.json', JSON.stringify({ requires: { auth: { '[development]': { kind: 'mocked' }, '[production]': { kind: 'ias' } } } }));
  write(root, 'srv/admin-service.cds', `service AdminService @(path: '/admin', requires: ['ManageAuthors', 'ManageBooks']) {
  @(restrict: [
    { grant: ['READ'], to: 'ManageAuthors' },
    { grant: ['READ', 'WRITE'], to: 'ManageBooks' } ])
  entity Books { key ID : Integer; genre : String; }
}`);
  write(root, 'srv/cat-service.cds', `service CatalogService {
  @restrict: [{ grant:['READ'], to: ['ReadBooks'], where: 'stock > 0' }]
  entity ListOfBooks { key ID : Integer; }
}
service AmsValueHelpService @(requires: 'ValueHelpUser') { entity Genres { key name : String; } }`);
  write(root, 'srv/authorization.cds', "using { AdminService } from './admin-service';\nannotate AdminService.Books with @ams.attributes: {\n    Genre: (genre)\n};");
  write(root, 'ams/dcl/schema.dcl', "SCHEMA {\n\t@valueHelp: { \n\t\tpath: 'Genres',\n\t\tvalueField: 'name',\n\t\tlabelField: 'name'\n\t}\n\tGenre: String\n}");
  write(root, 'ams/dcl/cap/basePolicies.dcl', 'POLICY StockManager {\n  ASSIGN ROLE ManageBooks WHERE Genre IS NOT RESTRICTED;\n}\n\nPOLICY ContentManager {\n  ASSIGN ROLE ManageAuthors;\n  ASSIGN ROLE ManageBooks;\n  ASSIGN ROLE ValueHelpUser;\n}\n\nPOLICY Reader {\n  ASSIGN ROLE ReadBooks WHERE Genre IS NOT RESTRICTED;\n}\n\nPOLICY "ValueHelpUser" {\n\tASSIGN ROLE "ValueHelpUser";\n}');
  write(root, 'ams/dcl/internal/apiPolicies.dcl', "INTERNAL POLICY AMS_ValueHelp {\n  ASSIGN ROLE ValueHelpUser;\n}\nINTERNAL POLICY ReadCatalog {\n    USE cap.Reader RESTRICT Genre NOT IN ('Mystery', 'Romance', 'Thriller', 'Dystopia');\n}");
  write(root, 'ams/dcl/local/adminPolicies.dcl', "POLICY StockManagerFiction {\n    USE cap.StockManager RESTRICT Genre IN ('Mystery', 'Fantasy');\n}\n\nPOLICY JuniorReader {\n    USE cap.Reader RESTRICT Genre IN ('Fairy Tale', 'Fantasy', 'Mystery');\n}");
  assert.deepEqual(ids(root), []);
  const m = scanAms(root);
  assert.equal(m.policies.length, 8);
  assert.deepEqual(policiesForRole(m, 'ReadBooks').derived.map((p) => p.qualified), ['internal.ReadCatalog', 'local.JuniorReader']);
});
