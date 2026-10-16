// docs/FORMAT.md documents the capability mapping: its matrix is the resolver's (scripts/capability-matrix.mjs writes it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';
import { matrix, BEGIN, END } from '../scripts/capability-matrix.mjs';

test('the capability matrix in docs/FORMAT.md is the one the resolver gives (node scripts/capability-matrix.mjs --write)', () => {
  const doc = readFileSync(join(root, 'docs', 'FORMAT.md'), 'utf8');
  const i = doc.indexOf(BEGIN);
  const j = doc.indexOf(END);
  assert.ok(i >= 0 && j > i, 'the markers are there');
  assert.equal(doc.slice(i + BEGIN.length, j).trim(), matrix());
});

test('FORMAT.md documents each type, each System purpose and the two built-in functions', () => {
  const doc = readFileSync(join(root, 'docs', 'FORMAT.md'), 'utf8');
  for (const t of ['router', 'switch', 'firewall', 'ap', 'load_balancer', 'ids_ips', 'vpn_gateway', 'security_gateway', 'server', 'vm', 'container', 'storage', 'endpoint', 'cloud', 'system']) assert.match(doc, new RegExp('\\| `' + t + '` \\|'), t);
  for (const p of ['host', 'l2_forwarder', 'l3_forwarder', 'inline', 'passive_monitor', 'pass_through', 'external_network']) assert.match(doc, new RegExp('\\| `' + p + '` \\|'), p);
  assert.match(doc, /#### VPN gateway/);
  assert.match(doc, /#### Security gateway/);
  assert.match(doc, /default deny/);
});
