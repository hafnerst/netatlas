// Non-IP interconnects and opaque ports (model/interconnect.ts, the
// interconnects section of validation/validate.ts): the format's rules,
// the editor's references through renames, deletes and undo, and the
// isolation from everything IP — an opaque port is never an interface of
// the IP side (no address, MAC, Layer 2, routing or simulated network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, errorsOf, example } from './helpers.mjs';

const D = load('editor/document.js');
const IC = load('model/interconnect.js');
const NET = load('analysis/sim/net.js');
const S = load('analysis/sim/simulation.js');
const ROUTING = load('analysis/routing.js');

/** a controller with a network port and opaque ports, an instrument, two bus members */
const BASE = (ics, extra = '') => `netatlas: 1
devices:
  - id: ctl
    type: system
    purpose: host
    interfaces:
      - {id: eth0, ip: 192.0.2.10/24}
      - {id: usb0, stack: opaque}
      - {id: bus0, stack: opaque}
  - {id: inst, type: endpoint, interfaces: [{id: eth0, ip: 192.0.2.20/24}, {id: usb0, stack: opaque}]}
  - {id: m1, type: endpoint, interfaces: [{id: bus0, stack: opaque}]}
  - {id: m2, type: endpoint, interfaces: [{id: bus0, stack: opaque}]}
${extra}links:
  - {id: l1, a: "ctl:eth0", b: "inst:eth0"}
interconnects:
${ics}`;
const USB = `  - id: usb
    topology: point_to_point
    technology: {name: USB, version: "2.0"}
    access: controller_target
    endpoints:
      - {port: "ctl:usb0", role: controller}
      - {port: "inst:usb0", role: target}
`;
const BUS = `  - id: bus
    topology: shared
    technology: {name: RS-485}
    access: controller_target
    endpoints:
      - {port: "ctl:bus0", role: controller}
      - {port: "m1:bus0", role: target}
      - {port: "m2:bus0", role: target}
`;
const msgs = (text) => errorsOf(text).map((e) => e.message).join('\n');

test('the format: opaque ports in a device’s interfaces, interconnects point to point and shared, technology and version as text, a custom technology', () => {
  const m = model(BASE(USB + BUS + `  - id: custom
    topology: point_to_point
    technology: {name: Custom backplane, version: revision B}
    endpoints:
      - {port: "m1:x", role: peer}
      - {port: "m2:x", role: peer}
`).replace('interfaces: [{id: bus0, stack: opaque}]}\n  - {id: m2', 'interfaces: [{id: bus0, stack: opaque}, {id: x, stack: opaque}]}\n  - {id: m2').replace(/(id: m2, type: endpoint, interfaces: \[\{id: bus0, stack: opaque\})/, '$1, {id: x, stack: opaque}'));
  const ctl = m.index.devices.get('ctl');
  assert.deepEqual(ctl.interfaces.map((i) => i.id), ['eth0'], 'only the network port is an interface');
  assert.deepEqual(ctl.opaquePorts.map((p) => p.id), ['usb0', 'bus0']);
  assert.equal(m.interconnects.length, 3);
  const usb = m.index.interconnects.get('usb');
  assert.deepEqual(usb.technology, { name: 'USB', version: '2.0' }, 'the version kept as written (text)');
  assert.equal(IC.interconnectLabel(usb), 'USB 2.0 ↔');
  assert.deepEqual(m.index.interconnects.get('custom').technology, { name: 'Custom backplane', version: 'revision B' });
  assert.equal(m.index.portInterconnect.get('m2:bus0'), 'bus');
  assert.deepEqual(m.index.interconnects.get('bus').endpoints.map((e) => [e.role, e.data]), [['controller', 'both'], ['target', 'both'], ['target', 'both']], 'a target is not receive-only');
});

test('the format: a direction is each endpoint’s own (send / receive), never the order of the endpoints; a monitor only receives', () => {
  const one = (a, b) => model(BASE(`  - id: s
    topology: point_to_point
    technology: {name: RS-232}
    endpoints:
      - {port: "ctl:usb0", role: peer, data: ${a}}
      - {port: "inst:usb0", role: peer, data: ${b}}
`)).index.interconnects.get('s');
  assert.equal(IC.interconnectLabel(one('send', 'receive')), 'RS-232 →');
  assert.equal(IC.interconnectLabel(one('receive', 'send')), 'RS-232 ←', 'reversed by the data, not by swapping the endpoints');
  assert.equal(IC.interconnectLabel(one('both', 'both')), 'RS-232 ↔');
  assert.match(msgs(BASE(BUS.replace('{port: "m2:bus0", role: target}', '{port: "m2:bus0", role: monitor, data: send}'))), /a monitor only receives: its data is receive/);
});

test('the format’s rules: what an opaque port may not have, where it may not be used, and what an interconnect must be', () => {
  const cases = [
    [BASE(USB).replace('{id: usb0, stack: opaque}]}', '{id: usb0, stack: opaque, ip: 10.0.0.1/24}]}'), /an opaque port has no network stack: "ip" belongs to a network port/],
    [BASE(USB).replace('{id: usb0, stack: opaque}]}', '{id: usb0, stack: opaque, vlans: 10}]}'), /"vlans" belongs to a network port/],
    [BASE(USB).replace('  - {id: l1, a: "ctl:eth0", b: "inst:eth0"}', '  - {id: l1, a: "ctl:eth0", b: "inst:eth0"}\n  - {id: l2, a: "ctl:usb0", b: "m1:bus0"}'), /"ctl:usb0" is an opaque port \(stack: opaque\): it has no network stack and connects only through an interconnect/],
    [BASE(USB) + 'relations:\n  - {id: r, protocol: ospf, endpoints: ["ctl:usb0", "inst:usb0"]}\n', /"ctl:usb0" is an opaque port/],
    [BASE(USB.replace('"inst:usb0"', '"inst:eth0"')), /"inst:eth0" is a network port: an interconnect joins opaque ports/],
    [BASE(USB.replace('      - {port: "inst:usb0", role: target}\n', '      - {port: "inst:usb0", role: target}\n      - {port: "m1:bus0", role: target}\n')), /a point_to_point interconnect joins exactly two ports \(here 3\)/],
    [BASE(USB + BUS.replace('"m2:bus0"', '"inst:usb0"')), /"inst:usb0" is already attached to interconnect "usb"/],
    [BASE(USB.replace('role: target}', 'role: peer}')), /with controller_target access a participant is a controller, a target, controller_target or a monitor, not a peer/],
    [BASE(USB.replace('    access: controller_target\n', '')), /"controller" is a role of controller_target access; between peers a participant is a peer or a monitor/],
    [BASE(USB.replace('{port: "inst:usb0", role: target}', '{port: "inst:usb0"}')), /missing required key "role"/],
    [BASE(USB.replace('    technology: {name: USB, version: "2.0"}\n', '')), /missing required key "technology"/],
    [BASE(USB.replace('point_to_point', 'ring')), /"ring" is not a topology/],
    [BASE(USB, '  - {id: hub, type: endpoint, interfaces: [{id: a, stack: opaque}, {id: b, stack: opaque}], opaque_transit: [{ports: [a, b]}]}\n'), /opaque_transit is for a System/],
  ];
  for (const [text, re] of cases) assert.match(msgs(text), re, String(re));
});

test('transit: only explicit groups of a System pass data, of one technology — a group joining USB and RS-485 is refused (nothing is converted)', () => {
  const text = BASE(USB.replace('"ctl:usb0"', '"hub:a"') + BUS.replace('"ctl:bus0"', '"hub:b"'), '  - {id: hub, type: system, purpose: host, interfaces: [{id: a, stack: opaque}, {id: b, stack: opaque}], opaque_transit: [{ports: [a, b]}]}\n');
  assert.match(msgs(text), /transit group of "hub" joins interconnects of different technologies \(RS-485, USB\): a transit group converts nothing/);
});

test('the example: every kind (USB, serial one way and both ways, RS-485, CAN with a monitor, VME with two controllers, a VPX-style fabric with explicit transit) and Ethernet beside it — valid', () => {
  const m = model(example('interconnects.yaml'));
  assert.equal(m.interconnects.length, 9);
  assert.deepEqual(m.index.devices.get('fsw').opaqueTransit.map((g) => g.ports), [['f1', 'f2', 'f4']], 'its console port is in no transit group');
  assert.deepEqual(m.index.interconnects.get('vme').endpoints.filter((e) => e.role === 'controller_target').map((e) => e.device), ['sbc1', 'sbc2'], 'two controllers, no arbitration modelled');
  assert.equal(m.index.interconnects.get('vme').endpoints[0].systemController, true);
});

test('isolation: an opaque port is no part of the IP side — no interface, MAC, bridge port or Layer 3 interface; no adjacency or path through an interconnect', () => {
  const m = model(example('interconnects.yaml'));
  for (const d of m.devices) for (const p of d.opaquePorts) assert.ok(!m.index.interfaces.has(d.id + ':' + p.id), d.id + ':' + p.id);
  const net = NET.buildNet(m);
  for (const d of m.devices) {
    const sd = net.devices.get(d.id);
    if (!sd) continue;
    for (const p of d.opaquePorts) {
      assert.ok(!sd.l3.has(p.id) && !sd.portOf.has(p.id) && !net.macs.has(d.id + ':' + p.id), `${d.id}:${p.id} in the simulated network`);
    }
  }
  // the payloads have no IP at all: no adjacency, nothing reachable; the controller and the scope reach each other over Ethernet only
  assert.equal(ROUTING.routingAdjacencies(m).adjacencies.length, 0);
  const s = new S.Simulation(m);
  s.runTo(3000);
  const t = s.sendTest({ from: 'ctl', to: '192.0.2.20', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
  assert.ok(!s.engine.flights.some((f) => /^interconnect:/.test(f.track.ref)), 'no IP packet on an interconnect');
});

test('the editor: renaming a device or an opaque port updates the interconnects’ endpoints and the transit groups; undo restores them', () => {
  const d = D.ModelDoc.fromText(example('interconnects.yaml'), 'interconnects.yaml', 'file').doc;
  const before = d.exportText();
  const n = d.renameEntity('device', d.findEntity('device', 'ctl').index, 'controller');
  assert.ok(n >= 4, String(n));
  let m = d.result.model;
  assert.deepEqual(m.index.interconnects.get('meter-bus').endpoints.map((e) => e.device), ['controller', 'meter1', 'meter2']);
  assert.equal(d.result.errors.length, 0, d.result.errors.map((e) => e.message).join('\n'));
  // an opaque port of the fabric switch: its interconnect and its transit group follow
  const fsw = d.findEntity('device', 'fsw');
  const path = d.interfaceEntries(fsw.index).find((e) => e.id === 'f1').path;
  assert.equal(d.renameInterface(path, 'fab1'), 2);
  m = d.result.model;
  assert.deepEqual(m.index.devices.get('fsw').opaqueTransit[0].ports, ['fab1', 'f2', 'f4']);
  assert.equal(m.index.interconnects.get('fab1').endpoints[1].port, 'fab1');
  assert.equal(d.result.errors.length, 0);
  d.undo();
  d.undo();
  assert.equal(d.exportText(), before);
});

test('the editor: an interconnect is an entity of its own (added, found, deleted); the file round-trips byte for byte', () => {
  const text = example('interconnects.yaml');
  const d = D.ModelDoc.fromText(text, 'interconnects.yaml', 'file').doc;
  assert.equal(d.exportText(), text);
  assert.equal(d.entities('interconnect').length, 9);
  const i = d.addEntity('interconnect');
  assert.equal(d.entities('interconnect')[i].id, 'ic1');
  assert.deepEqual(D.KEY_ORDER.interconnect.slice(0, 3), ['id', 'label', 'topology']);
  d.undo();
  assert.equal(d.exportText(), text);
});
