// The display name of the type vpn_gateway is "VPN gateway" (sentence case,
// like "Access point" and "Load balancer"), from the one registry
// (model/device-types.ts) everywhere it is shown; the model identifier, the
// behaviour and the labels users write are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, model, validate, example } from './helpers.mjs';

const DT = load('model/device-types.js');

test('the registry: "VPN gateway" / "VPN gateways", the identifier vpn_gateway; acronyms stay uppercase in running text', () => {
  const t = DT.typeDef('vpn_gateway');
  assert.deepEqual([t.id, t.label, t.plural], ['vpn_gateway', 'VPN gateway', 'VPN gateways']);
  assert.equal(DT.deviceTypeLabel('vpn_gateway'), 'VPN gateway');
  assert.equal(DT.deviceTypeLine({ type: 'vpn_gateway' }), 'VPN gateway');
  // every multiword type in sentence case: only acronyms are capitalised after the first word
  for (const d of DT.DEVICE_TYPES) for (const w of d.label.split(' ').slice(1)) assert.ok(w === w.toLowerCase() || /^[A-Z0-9/]{2,}$/.test(w) || /^\d/.test(w), `${d.label}: "${w}"`);
  assert.deepEqual(['vpn_gateway', 'load_balancer', 'ids_ips', 'ap', 'vm'].map((x) => DT.deviceTypeInText(x, true)), ['VPN gateways', 'load balancers', 'IDS/IPS', 'access points', 'virtual machines']);
  assert.equal(DT.deviceTypeInText('vpn_gateway'), 'VPN gateway');
});

test('nothing shows "VPN Gateway": not the code, the manual, the documentation or the examples', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of readdirSync(join(root, dir))) {
      const p = join(dir, f);
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else if (/\.(ts|md|ya?ml|html|css)$/.test(f)) files.push(p);
    }
  };
  for (const d of ['src', 'docs', 'examples', join('test', 'examples')]) walk(d);
  files.push('README.md');
  const hits = files.filter((f) => /VPN Gateway/.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(hits, []);
  // the change log names the old spelling once, where it records the change
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal((log.match(/VPN Gateway/g) || []).length, 1);
  assert.match(log, /\(it was\s+\*VPN Gateway\*\)/);
});

test('the surfaces read it from the registry: the device box, the legend, the Device types filter, Find, the palette, validation, the tracer and the simulation', () => {
  const m = model(example('wan-vpn.yaml'));
  const gw = m.devices.find((d) => d.type === 'vpn_gateway');
  // the legend and the box
  const L = load('diagram/legend.js');
  assert.ok(L.legendOf(m, 'physical').sections.some((s) => s.items.some((i) => i.label === 'VPN gateway')));
  assert.match(load('layout/input.js').deviceSub(m, gw), /^VPN gateway/);
  // the Device types filter's rows
  assert.equal(DT.typeKeyLabel(DT.typeKey(gw)), 'VPN gateway');
  // Find by the type's name
  const Q = load('model/queries.js');
  assert.ok(Q.search(m, 'vpn gateway').some((h) => h.ref === 'device:' + gw.id));
  // a validation message, the tracer, the simulation
  const errs = validate.loadModel(`netatlas: 2\ndevices:\n  - {id: g1, type: vpn_gateway, interfaces: [{id: e0, ip: 10.0.0.1/24}]}\n`).errors.map((e) => e.message);
  assert.ok(errs.some((e) => /^VPN gateway "g1" needs the configuration of its VPN/.test(e)), errs.join('\n'));
  const T = load('analysis/trace.js');
  const t = T.tracePath(m, { from: 'hq-pc', to: '192.0.2.10' });
  assert.match(T.traceText(t), /is a VPN gateway: it forwards only to and from its VPN/);
  const S = load('analysis/sim/simulation.js');
  const s = new S.Simulation(m);
  s.runTo(12000);
  assert.ok(s.events().some((e) => /is a VPN gateway: it forwards only to and from its VPN/.test(e.detail)));
});

test('a model is unchanged: type vpn_gateway, its behaviour, and a label a user wrote with "VPN Gateway" in it', () => {
  const text = `netatlas: 2\ndevices:\n  - id: g1\n    label: Acme VPN Gateway 1\n    type: vpn_gateway\n    interfaces: [{id: e0, ip: 10.0.0.1/24}]\n`;
  const r = validate.loadModel(text);
  assert.equal(r.model.devices[0].type, 'vpn_gateway');
  assert.equal(r.model.devices[0].label, 'Acme VPN Gateway 1');
  const D = load('editor/document.js');
  const d = D.ModelDoc.fromText(text, 't.yaml', 'file').doc;
  assert.equal(d.exportText(), text, 'written back byte-for-byte');
  // the box shows the user's label and the type's display name, each as written
  assert.match(load('layout/input.js').deviceSub(r.model, r.model.devices[0]), /^VPN gateway/);
  assert.match(readFileSync(join(root, 'test', 'examples', 'wan-vpn.yaml'), 'utf8'), /type: vpn_gateway/);
});
