import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server';

const EXAMPLES = path.resolve(__dirname, '..', '..', '..', '..', 'examples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-mcp-'));

function copyExample(name: string, as = name): string {
  const dest = path.join(tmp, as);
  fs.cpSync(path.join(EXAMPLES, name), dest, { recursive: true });
  return dest;
}

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: !!res.isError, json: () => JSON.parse(res.content[0].text) };
}

before(async () => {
  const server = createServer({ defaultRoot: tmp, cfPath: path.join(tmp, 'no-such-cf') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

after(async () => {
  await client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('lists the tools with annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['apply_fix', 'check_project', 'diagnose_cf_app', 'diagnose_log', 'diagnose_mta_operation', 'fix_all', 'preview_fix']);
    assert.equal(tools.find((t) => t.name === 'check_project')!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'apply_fix')!.annotations?.readOnlyHint, false);
  });

  it('checks a project and returns fix IDs', async () => {
    const root = copyExample('broken-bookshop');
    const r = (await call('check_project', { path: root })).json();
    assert.ok(r.summary.error > 0);
    const withFix = r.findings.find((f: any) => f.fixes?.length);
    assert.match(withFix.fixes[0].fixId, /^[A-Z]+\d+-[0-9a-f]{8}$/);
  });

  it('resolves relative paths against the default root', async () => {
    copyExample('broken-saas');
    const r = (await call('check_project', { path: 'broken-saas' })).json();
    assert.ok(r.findings.some((f: any) => f.ruleId.startsWith('MT')));
  });

  it('previews and applies a single fix, then the ID is gone', async () => {
    const root = copyExample('broken-fiori');
    const r = (await call('check_project', { path: root })).json();
    const fix = r.findings.flatMap((f: any) => f.fixes ?? []).find((x: any) => x.includedInFixAll);
    const before = r.findings.length;

    const preview = await call('preview_fix', { path: root, fixId: fix.fixId });
    assert.equal(preview.isError, false);
    assert.match(preview.text, /^(\+\+\+|---) /m);

    const applied = await call('apply_fix', { path: root, fixId: fix.fixId });
    assert.equal(applied.isError, false, applied.text);
    assert.ok(applied.json().remaining.findings.length < before);

    const again = await call('apply_fix', { path: root, fixId: fix.fixId });
    assert.equal(again.isError, true);
    assert.match(again.text, /check_project again/);
  });

  it('fix_all dry run changes nothing, real run fixes the SaaS example', async () => {
    const root = copyExample('broken-saas', 'broken-saas-2');
    const mta = fs.readFileSync(path.join(root, 'mta.yaml'), 'utf8');

    const dry = (await call('fix_all', { path: root, dryRun: true })).json();
    assert.ok(dry.wouldApply.length > 0);
    assert.equal(fs.readFileSync(path.join(root, 'mta.yaml'), 'utf8'), mta);

    const real = (await call('fix_all', { path: root })).json();
    assert.ok(real.applied.length > 0);
    assert.equal(real.remaining.summary.error, 0);
  });

  it('diagnoses log text and log files', async () => {
    const fromFile = (await call('diagnose_log', { file: path.join(EXAMPLES, 'broken-bookshop', 'deploy.log') })).json();
    assert.ok(fromFile.matches.length > 0);
    const fromText = (await call('diagnose_log', { text: 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for @sap/cds@99' })).json();
    assert.ok(fromText.totalLines === 2);
    assert.equal((await call('diagnose_log', {})).isError, true);
  });

  it('reports a missing cf CLI and bad arguments as tool errors', async () => {
    const missing = await call('diagnose_cf_app', { app: 'bookshop-srv' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not found/);
    const bad = await call('diagnose_mta_operation', { operationId: '--help' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Invalid operation ID/);
  });

  it('rejects a path that is not a directory', async () => {
    const r = await call('check_project', { path: path.join(tmp, 'nope') });
    assert.equal(r.isError, true);
    assert.match(r.text, /Not a directory/);
  });
});
