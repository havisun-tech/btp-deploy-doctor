import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CdsAuth } from 'btp-deploy-doctor';
import { analyzeToken, applyEdit, attributeStatus, effectiveDescriptor, generateDescriptor, issues, parseDescriptor, roleStatus } from '../model';

const TEXT = `{
  "xsappname": "orders",
  "tenant-mode": "dedicated",
  "scopes": [
    { "name": "$XSAPPNAME.SalesRep", "description": "Sales representative" }
  ],
  "attributes": [],
  "role-templates": [
    { "name": "SalesRep", "description": "Sales representative", "scope-references": ["$XSAPPNAME.SalesRep"] }
  ],
  "role-collections": [
    { "name": "Sales", "role-template-references": ["$XSAPPNAME.SalesRep"] }
  ]
}
`;

const CDS: CdsAuth = {
  roles: [
    { role: 'SalesRep', file: 'srv/s.cds', line: 3 },
    { role: 'sales-manager', file: 'srv/s.cds', line: 4 },
  ],
  attributes: [{ role: 'country', file: 'srv/s.cds', line: 3 }],
  grants: [{ roles: ['SalesRep'], attributes: ['country'] }, { roles: ['sales-manager'], attributes: [] }],
  filesScanned: 1,
};

test('parses the descriptor, with role collection references as template names', () => {
  const d = parseDescriptor(TEXT);
  assert.equal(d.xsappname, 'orders');
  assert.deepEqual(d.collections[0].templates, ['SalesRep']);
  assert.equal(d.error, undefined);
  assert.ok(parseDescriptor('{ nope').error);
});

test('addRole creates scope and template and keeps the existing lines untouched', () => {
  const out = applyEdit(TEXT, { kind: 'addRole', name: 'sales-manager' });
  const d = parseDescriptor(out);
  assert.ok(d.scopes.some((s) => s.name === '$XSAPPNAME.sales-manager'));
  assert.deepEqual(d.templates.find((t) => t.name === 'sales_manager')?.scopes, ['$XSAPPNAME.sales-manager']);
  for (const line of TEXT.split('\n').filter((l) => l.includes('"name"'))) assert.ok(out.includes(line.replace(/ }$/, '')), `changed: ${line}`);
});

test('removeScope also removes the references to it', () => {
  const d = parseDescriptor(applyEdit(TEXT, { kind: 'removeScope', name: '$XSAPPNAME.SalesRep' }));
  assert.equal(d.scopes.length, 0);
  assert.deepEqual(d.templates[0].scopes, []);
  assert.deepEqual(issues(d), []);
});

test('removeTemplate also removes it from role collections', () => {
  const d = parseDescriptor(applyEdit(TEXT, { kind: 'removeTemplate', name: 'SalesRep' }));
  assert.equal(d.templates.length, 0);
  assert.deepEqual(d.collections[0].templates, []);
});

test('toggles references on and off', () => {
  let t = applyEdit(TEXT, { kind: 'addAttribute', name: 'country' });
  t = applyEdit(t, { kind: 'toggleTemplateAttribute', template: 'SalesRep', attribute: 'country', on: true });
  assert.deepEqual(parseDescriptor(t).templates[0].attributes, ['country']);
  t = applyEdit(t, { kind: 'removeAttribute', name: 'country' });
  assert.deepEqual(parseDescriptor(t).templates[0].attributes, []);
  t = applyEdit(t, { kind: 'addCollection', name: 'Managers' });
  t = applyEdit(t, { kind: 'toggleCollectionTemplate', collection: 'Managers', template: 'SalesRep', on: true });
  assert.deepEqual(parseDescriptor(t).collections[1].templates, ['SalesRep']);
  t = applyEdit(t, { kind: 'toggleCollectionTemplate', collection: 'Managers', template: 'SalesRep', on: false });
  assert.deepEqual(parseDescriptor(t).collections[1].templates, []);
});

test('rejects invalid and duplicate names', () => {
  assert.throws(() => applyEdit(TEXT, { kind: 'addTemplate', name: 'Sales Rep' }), /not a valid role template name/);
  assert.throws(() => applyEdit(TEXT, { kind: 'addScope', name: 'SalesRep' }), /already exists/);
  assert.throws(() => applyEdit('{ nope', { kind: 'addScope', name: 'X' }), /not valid JSON/);
});

test('settings edits, including removing redirect URIs', () => {
  let t = applyEdit(TEXT, { kind: 'setRedirectUris', value: ['https://*.cfapps.eu10.hana.ondemand.com/**'] });
  assert.deepEqual(parseDescriptor(t).redirectUris, ['https://*.cfapps.eu10.hana.ondemand.com/**']);
  t = applyEdit(t, { kind: 'setTenantMode', value: 'shared' });
  assert.equal(parseDescriptor(t).tenantMode, 'shared');
});

test('role and attribute status against the CDS model', () => {
  const d = parseDescriptor(TEXT);
  const s = roleStatus(d, CDS);
  assert.deepEqual(s[0], { role: 'SalesRep', file: 'srv/s.cds', line: 3, scope: true, templates: ['SalesRep'], collections: ['Sales'] });
  assert.equal(s[1].scope, false);
  assert.deepEqual(attributeStatus(d, CDS).map((a) => a.defined), [false]);
  assert.deepEqual(issues(d, CDS).map((i) => i.severity), ['error', 'warning']);
});

test('issues finds references XSUAA would reject', () => {
  const bad = TEXT.replace('"scope-references": ["$XSAPPNAME.SalesRep"]', '"scope-references": ["$XSAPPNAME.SalesRap"]').replace('"role-template-references": ["$XSAPPNAME.SalesRep"]', '"role-template-references": ["$XSAPPNAME.Nope"]');
  const msgs = issues(parseDescriptor(bad)).map((i) => i.message);
  assert.ok(msgs.some((m) => /unknown scope "\$XSAPPNAME.SalesRap"/.test(m)));
  assert.ok(msgs.some((m) => /unknown role template "Nope"/.test(m)));
});

test('generates a descriptor from the CDS model', () => {
  const d = parseDescriptor(generateDescriptor('orders', CDS));
  assert.deepEqual(d.templates.map((t) => t.name), ['SalesRep', 'sales_manager']);
  assert.deepEqual(d.templates[0].attributes, ['country']);
  assert.deepEqual(issues(d, CDS), []);
});

// ---------------- tokens ----------------

const jwt = (payload: object) => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.signature`;
};
const NOW = Date.parse('2026-11-08T10:00:00Z');
const user = {
  user_name: 'maria@example.com',
  client_id: 'sb-orders-dev!t123',
  grant_type: 'authorization_code',
  zid: 'tenant-1',
  exp: NOW / 1000 + 600,
  scope: ['openid', 'orders-dev!t123.SalesRep'],
  'xs.user.attributes': { country: ['DE'] },
  'xs.rolecollections': ['Sales'],
};

test('explains which CDS roles a token grants', () => {
  const r = analyzeToken(`Bearer ${jwt(user)}`, parseDescriptor(TEXT), CDS, NOW);
  assert.ok(r.ok);
  assert.equal(r.subject, 'maria@example.com');
  assert.deepEqual(r.roles, [
    { role: 'SalesRep', granted: true, via: 'orders-dev!t123.SalesRep' },
    { role: 'sales-manager', granted: false, via: undefined },
  ]);
  assert.deepEqual(r.attributes, { country: ['DE'] });
  assert.ok(r.notes.some((n) => /Missing role: sales-manager/.test(n)));
  assert.equal(r.expired, false);
});

test('flags expired tokens and tokens from another XSUAA instance', () => {
  const r = analyzeToken(jwt({ ...user, exp: NOW / 1000 - 5, scope: ['billing!t9.Admin'] }), parseDescriptor(TEXT), CDS, NOW);
  assert.equal(r.expired, true);
  assert.ok(r.notes.some((n) => /expired/.test(n)));
  assert.ok(r.notes.some((n) => /another XSUAA instance/.test(n)));
});

test('rejects things that are not tokens', () => {
  assert.match(analyzeToken('hello', parseDescriptor(TEXT), CDS).error ?? '', /not a JWT/);
  assert.match(analyzeToken('a.b.c', parseDescriptor(TEXT), CDS).error ?? '', /could not be decoded/);
});

test('judges the descriptor with the mta.yaml config applied, as XSUAA gets it', () => {
  const file = TEXT.replace('"xsappname": "orders",\n', '').replace(/,\n  "role-collections": \[[\s\S]*?\]\n/, '\n');
  assert.ok(issues(parseDescriptor(file)).some((i) => /xsappname is missing/.test(i.message)));
  const eff = effectiveDescriptor(file, { xsappname: 'orders-${space}', 'role-collections': [{ name: 'Sales-${space}', 'role-template-references': ['$XSAPPNAME.SalesRep'] }] });
  assert.deepEqual(issues(eff), []);
  assert.deepEqual(roleStatus(eff, CDS)[0].collections, ['Sales-${space}']);
});

// Found by running the studio on public SAP samples (btp-user-management-microservice, cap-sflight, ...).
test('accepts the standard uaa.user scope used for token exchange', () => {
  const d = parseDescriptor(JSON.stringify({ xsappname: 'a', scopes: [{ name: 'uaa.user' }], 'role-templates': [{ name: 'Token_Exchange', 'scope-references': ['uaa.user'] }] }));
  assert.deepEqual(issues(d), []);
});

test('a missing xsappname is an error only when mta.yaml deploys the file', () => {
  const d = parseDescriptor('{ "scopes": [] }');
  assert.deepEqual(issues(d).map((i) => i.severity), ['warning']);
  assert.deepEqual(issues(d, undefined, true).map((i) => i.severity), ['error']);
});

test('refilling an emptied list keeps the file\'s one-item-per-line style', () => {
  const text = `{
    "xsappname": "a",
    "scopes": [
        { "name": "$XSAPPNAME.A" },
        { "name": "$XSAPPNAME.B" }
    ],
    "role-templates": [
        {
            "name": "A",
            "scope-references": [
                "$XSAPPNAME.A"
            ]
        },
        {
            "name": "B",
            "scope-references": [
                "$XSAPPNAME.A",
                "$XSAPPNAME.B"
            ]
        }
    ]
}
`;
  const off = applyEdit(text, { kind: 'toggleTemplateScope', template: 'A', scope: '$XSAPPNAME.A', on: false });
  assert.match(off, /"scope-references": \[\]/);
  assert.equal(applyEdit(off, { kind: 'toggleTemplateScope', template: 'A', scope: '$XSAPPNAME.A', on: true }), text);
  // Files that write lists on one line keep doing so.
  const inline = text.replace(/\[\n\s+("\$XSAPPNAME\.A")\n\s+\]/, '[$1]').replace(/\[\n\s+("\$XSAPPNAME\.A"),\n\s+("\$XSAPPNAME\.B")\n\s+\]/, '[$1, $2]');
  const off2 = applyEdit(inline, { kind: 'toggleTemplateScope', template: 'A', scope: '$XSAPPNAME.A', on: false });
  assert.equal(applyEdit(off2, { kind: 'toggleTemplateScope', template: 'A', scope: '$XSAPPNAME.A', on: true }), inline);
});
