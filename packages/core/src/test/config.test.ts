import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredKind, resolveProfile } from '../cds-config';

test('profile blocks override at every level', () => {
  const cfg = { requires: { db: { kind: 'sqlite' }, '[production]': { db: 'hana' } }, '[production]': { requires: { auth: 'xsuaa' } } };
  const prod = resolveProfile(cfg, 'production');
  assert.equal(requiredKind(prod, 'db'), 'hana');
  assert.equal(requiredKind(prod, 'auth'), 'xsuaa');
  const dev = resolveProfile(cfg, 'development');
  assert.equal(requiredKind(dev, 'db'), 'sqlite');
  assert.equal(requiredKind(dev, 'auth'), undefined);
});

test('nested profile inside a service entry', () => {
  const cfg = { requires: { auth: { kind: 'mocked', '[production]': { kind: 'ias' } } } };
  assert.equal(requiredKind(resolveProfile(cfg, 'production'), 'auth'), 'ias');
  assert.equal(requiredKind(resolveProfile(cfg, 'development'), 'auth'), 'mocked');
});
