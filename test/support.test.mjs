// What NetAtlas does for each protocol, service and profile (model/support.ts): one shared
// definition with each, three levels, never "full support", custom protocols drawn only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const profiles = load('model/sim-profiles.js');
const reg = load('model/service-registry.js');
const apps = load('model/applications.js');
const support = load('model/support.js');
const sim = load('analysis/sim/simulation.js');

const LEVELS = ['drawn', 'configured', 'modeled'];
const wellFormed = (s, what) => {
  assert.ok(s && LEVELS.includes(s.level), `${what}: a level`);
  assert.ok(s.does && s.does.length > 20, `${what}: what it does`);
  assert.ok(s.not && s.not.length > 5, `${what}: what it does not`);
  for (const t of [s.does, s.not]) assert.ok(!/full(y)? support|fully (simulated|supported|emulat)/i.test(t), `${what}: never "full support": ${t}`);
};

test('every built-in protocol profile, service and application profile says what is simulated and what is not', () => {
  for (const p of profiles.SIM_PROFILES) wellFormed(p.support, `profile ${p.id}`);
  for (const s of reg.SERVICES) wellFormed(s.support, `service ${s.id}`);
  for (const p of apps.APP_PROFILES) wellFormed(p.support, `application profile ${p.id}`);
  // every built-in protocol has a behaviour of the engine: modeled, within its limits
  assert.ok(profiles.SIM_PROFILES.every((p) => p.support.level === 'modeled'));
  // a service whose protocols are not simulated says so: storage opens its ports, NFS / SMB / iSCSI are not run
  assert.equal(reg.serviceDef('storage').support.level, 'configured');
  assert.match(reg.serviceDef('storage').support.not, /NFS, SMB and iSCSI/);
  assert.equal(reg.serviceDef('vpn').support.level, 'configured');
  // generic TCP / UDP applications never pass for an industrial protocol
  assert.match(apps.appProfile('tcp_server').support.not, /Modbus TCP labels it, nothing of Modbus is simulated/);
  // the session protocols: establishment and forwarding, never the cryptography or the payload
  assert.match(profiles.simProfile('wireguard').support.not, /payload contents and cryptographic operations/);
  assert.match(profiles.simProfile('ipsec').support.not, /cryptographic operations/);
});

test('a protocol of the model’s own is drawn only, whatever demonstration packets it sends', () => {
  const c = profiles.customProfile('custom:modbus', 'Modbus TCP');
  assert.equal(c.support.level, 'drawn');
  assert.match(c.support.does, /demonstration packets/);
  const m = model(`netatlas: 1
protocols:
  - {id: modbus, label: Modbus TCP, category: service}
devices:
  - {id: a, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.1/24}]}
  - {id: b, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.2/24}]}
links:
  - {id: l, a: "a:e0", b: "b:e0"}
relations:
  - {id: r1, protocol: modbus, endpoints: [a, b]}
  - {id: r2, protocol: ospf, endpoints: [a, b]}
`);
  const entries = sim.protocolEntriesOf(m);
  const custom = entries.find((e) => e.label === 'Modbus TCP');
  assert.equal(custom.support.level, 'drawn');
  assert.equal(entries.find((e) => e.id === 'ospf').support.level, 'modeled');
  // the tests' transports have their own statement
  for (const id of ['icmp', 'tcp', 'udp']) wellFormed(entries.find((e) => e.id === id).support, id);
  assert.match(entries.find((e) => e.id === 'tcp').support.not, /no throughput/);
});

test('the three levels have short labels; a support reads as two lines', () => {
  assert.deepEqual(support.SUPPORT_LEVELS.map((x) => x.label), ['Diagram only', 'Configuration and validation', 'Modeled behavior']);
  const lines = support.supportLines(profiles.simProfile('wireguard').support);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Modeled behavior: Session establishment/);
  assert.match(lines[1], /^Not modeled: payload contents and cryptographic operations/);
});
