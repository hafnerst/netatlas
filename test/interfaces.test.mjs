// The interface hierarchy: physical interfaces at the device level, logical
// and tunnel children below them, loopbacks as device-level logical
// endpoints. Also: the alphabetical display order, the device fields that
// were removed, and export -> reload of the new format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, queries, derive, panels, scene, state, load, example, exampleNames, model, byClass } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { SCHEMA, RETIRED } = load('yaml/schema.js');
const { compareNames, sortedByName } = load('model/order.js');
const T = load('model/types.js');
const Y = load('yaml/parse.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const messages = (text) => validate.loadModel(text).errors.map((e) => e.message);
const shape = (d) => d.interfaces.map((i) => `${i.id}:${i.type}[${i.children.map((c) => `${c.id}:${c.type}`).join(',')}]`).join(' ');

const net = `netatlas: 1
devices:
  - id: r1
    type: router
    loopbacks:
      - {id: lo0, label: Router ID, ip: [10.255.0.1/32, 2001:db8::1/128]}
    interfaces:
      - id: ge-0/0/0
        ip: 198.51.100.2/30
        children:
          - {id: ge-0/0/0.100, type: logical, ip: 10.100.0.1/24}
          - {id: st0.10, type: tunnel, ip: 172.16.10.1/30}
          - {id: ge-0/0/0.200, ip: 10.200.0.1/24}
      - id: ge-0/0/1
        children:
          - {id: irb.7, type: logical}
      - {id: ge-0/0/2}
      - ge-0/0/3
  - id: r2
    loopbacks: [{id: lo0, ip: 10.255.0.2/32}]
    interfaces: [{id: eth0, children: [tun0]}, eth1]
links:
  - {id: c1, a: "r1:ge-0/0/0", b: "r2:eth0"}
networks:
  - {id: mgmt, cidr: 10.100.0.0/24, vlan: 100}
  - {id: loops, cidr: 10.255.0.0/24}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:st0.10", "r2:tun0"], over: c1}
  - {id: ibgp, protocol: ibgp, endpoints: ["r1:lo0", "r2:lo0"]}
`;

// ------------------------------------------------------------- hierarchy

test('hierarchy: only physical interfaces at the device level; each has zero, one or several logical and tunnel children', () => {
  const r = validate.loadModel(net);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  const r1 = r.model.index.devices.get('r1');
  assert.equal(shape(r1), 'ge-0/0/0:physical[ge-0/0/0.100:logical,st0.10:tunnel,ge-0/0/0.200:logical] ge-0/0/1:physical[irb.7:logical] ge-0/0/2:physical[] ge-0/0/3:physical[]');
  assert.ok(r1.interfaces.every((i) => i.type === 'physical' && i.parent === undefined));
  // a child without a type is logical; a child knows its physical interface; the shorthand works for children too
  assert.equal(r.model.index.interfaces.get('r1:ge-0/0/0.200').type, 'logical');
  assert.equal(r.model.index.interfaces.get('r1:st0.10').parent, 'ge-0/0/0');
  assert.equal(shape(r.model.index.devices.get('r2')), 'eth0:physical[tun0:logical] eth1:physical[]');
  // loopbacks are not part of the physical interfaces
  assert.deepEqual(r1.loopbacks.map((l) => [l.id, l.type, l.parent, l.children.length]), [['lo0', 'loopback', undefined, 0]]);
  assert.ok(!r1.interfaces.some((i) => i.id === 'lo0'));
  // one flat index and one order for "every interface of a device"
  assert.deepEqual(T.deviceInterfaces(r1).map((i) => i.id), ['ge-0/0/0', 'ge-0/0/0.100', 'st0.10', 'ge-0/0/0.200', 'ge-0/0/1', 'irb.7', 'ge-0/0/2', 'ge-0/0/3', 'lo0']);
  assert.equal(r.model.index.interfaces.size, 9 + 4);
});

test('hierarchy: an interface has no type key; a child is "logical" or "tunnel" and nothing else', () => {
  assert.deepEqual(T.CHILD_IFACE_TYPES, ['logical', 'tunnel']);
  const top = (t) => messages(`netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, type: ${t}}\n`);
  for (const t of ['physical', 'loopback', 'tunnel', 'logical', 'svi', 'vti', 'subinterface', 'lag']) {
    const m = top(t);
    assert.equal(m.length, 1, t);
    assert.match(m[0], /^"type" is no longer part of the format — an entry of "interfaces:" is always a physical interface and has no type: delete this key\. A loopback belongs in the "loopbacks:" list of the device; a logical or tunnel interface belongs in "children:"/, t);
  }
  const child = (t) => messages(`netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - id: e0\n        children:\n          - {id: c0, type: ${t}}\n`);
  assert.deepEqual(child('logical'), []);
  assert.deepEqual(child('tunnel'), []);
  for (const t of ['vti', 'subinterface', 'svi', 'vlan', 'lag', 'physical', 'loopback', 'Tunnel', 'virtual']) {
    const m = child(t);
    assert.equal(m.length, 1, t);
    assert.match(m[0], new RegExp(`^"${t}" is not a child interface type: use "logical" or "tunnel" \\(describe a more specific function`), t);
  }
  // the old type is not read: the entry stays what its place in the file makes it
  const r = validate.loadModel('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: lo0, type: loopback, ip: 10.0.0.1/32}\n      - id: e0\n        children: [{id: c0, type: vti}]\n');
  assert.equal(r.errors.length, 2);
  assert.equal(shape(r.model.devices[0]), 'lo0:physical[] e0:physical[c0:logical]');
  assert.deepEqual(r.model.devices[0].loopbacks, []);
  // the error is located at the type, for the editor
  assert.deepEqual([r.errors[0].path, r.errors[0].key, r.errors[0].line], ['devices.a.interfaces[0].type', 'type', 5]);
  assert.deepEqual([r.errors[1].path, r.errors[1].line], ['devices.a.interfaces[1].children[0].type', 7]);
});

test('hierarchy: children cannot be nested, and loopbacks have no children', () => {
  const nested = messages('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - id: e0\n        children:\n          - id: c0\n            children: [c1]\n');
  assert.deepEqual(nested.length, 1);
  assert.match(nested[0], /^"children" is no longer part of the format — a child interface cannot have children of its own/);
  const loop = messages('netatlas: 1\ndevices:\n  - id: a\n    loopbacks:\n      - {id: lo0, ip: 10.0.0.1/32, children: [x], type: loopback, mac: "00:11:22:33:44:55"}\n');
  assert.equal(loop.length, 3);
  assert.ok(loop.some((m) => /a loopback has no child interfaces/.test(m)) && loop.some((m) => /is a loopback by definition/.test(m)) && loop.some((m) => /has no MAC address/.test(m)));
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, children: {id: c0}}\n')[0], /expected a list/);
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    loopbacks: [lo0]\n')[0], /expected a mapping/);
});

test('hierarchy: interfaces, children and loopbacks share one set of ids per device', () => {
  const dup = (body) => messages('netatlas: 1\ndevices:\n  - id: a\n' + body);
  assert.match(dup('    interfaces:\n      - id: e0\n        children: [e0]\n')[0], /duplicate interface "e0" on device "a" \(already used by a physical interface;/);
  assert.match(dup('    interfaces:\n      - {id: e0, children: [x]}\n      - {id: e1, children: [x]}\n')[0], /duplicate interface "x" on device "a" \(already used by a logical interface of "e0";/);
  assert.match(dup('    interfaces:\n      - {id: e0, children: [{id: lo0, type: tunnel}]}\n    loopbacks:\n      - {id: lo0, ip: 10.0.0.1/32}\n')[0], /duplicate interface "lo0" on device "a" \(already used by a tunnel interface of "e0";/);
  // the same id on another device is fine
  assert.deepEqual(messages('netatlas: 1\ndevices:\n  - {id: a, interfaces: [{id: e0, children: [x]}]}\n  - {id: b, interfaces: [{id: e0, children: [x]}]}\n'), []);
});

test('references: a cable ends on a physical interface only; a relation may name any interface or loopback', () => {
  const r = validate.loadModel(net);
  assert.deepEqual(r.model.relations.map((x) => x.endpoints.map((e) => r.model.index.interfaces.get(e.device + ':' + e.iface).type).join('-')), ['tunnel-logical', 'loopback-loopback']);
  const cable = (a) => messages(net.replace('a: "r1:ge-0/0/0", b: "r2:eth0"', `a: "${a}", b: "r2:eth1"`));
  assert.deepEqual(cable('r1:ge-0/0/2'), []);
  assert.match(cable('r1:st0.10')[0], /^"r1:st0\.10" is a tunnel interface of "ge-0\/0\/0", not a physical interface — a physical link must end on a physical interface\. Cable its physical interface "r1:ge-0\/0\/0" instead;/);
  assert.match(cable('r1:ge-0/0/0.100')[0], /^"r1:ge-0\/0\/0\.100" is a logical interface of "ge-0\/0\/0", not a physical interface/);
  assert.match(cable('r1:lo0')[0], /^"r1:lo0" is a loopback, not a physical interface/);
  // unknown interface names are suggested from every interface of the device, children and loopbacks included
  assert.match(messages(net.replace('"r1:st0.10"', '"r1:st0.11"'))[0], /device "r1" has no interface "st0\.11" — did you mean "st0\.10"\?/);
  assert.match(messages(net.replace('"r1:lo0"', '"r1:lo1"'))[0], /did you mean "lo0"\?/);
});

test('children take part in everything derived from addresses, like any interface', () => {
  const m = model(net);
  assert.deepEqual(derive.networkMembers(m, 'mgmt')[0].matches.map((x) => [x.iface, x.loopback]), [['ge-0/0/0.100', false]]);
  assert.deepEqual(derive.networkMembers(m, 'loops').map((x) => x.matches[0].iface + '/' + x.matches[0].loopback), ['lo0/true', 'lo0/true']);
  assert.equal(derive.interfaceVlanText(derive.interfaceAddresses(m, 'r1', 'ge-0/0/0.100')), 'VLAN 100');
  assert.equal(queries.search(m, '172.16.10.1')[0].ref, 'device:r1');
  // an ambiguous VLAN on a child is reported at the child
  const amb = validate.loadModel(net.replace('  - {id: loops', '  - {id: mgmt2, cidr: 10.100.0.0/25, vlan: 101}\n  - {id: loops'));
  assert.equal(amb.warnings[0].path, 'devices.r1.interfaces[0].children[0].ip');
});

test('both views follow the hierarchy: a child highlights its port and that port\'s cable; a port its children', () => {
  const m = model(net);
  const child = queries.relatedRefs(m, 'iface:r1:st0.10');
  assert.ok(child.has('iface:r1:ge-0/0/0') && child.has('link:c1') && child.has('relation:gre') && child.has('device:r2'));
  const port = queries.relatedRefs(m, 'iface:r1:ge-0/0/0');
  assert.ok(port.has('iface:r1:st0.10') && port.has('iface:r1:ge-0/0/0.100') && !port.has('iface:r1:irb.7') && !port.has('iface:r1:lo0'));
  assert.ok(queries.relatedRefs(m, 'device:r1').has('iface:r1:irb.7'));
  assert.deepEqual([...queries.selectionContext(m, 'iface:r1:st0.10').related].sort(), ['link:c1', 'relation:gre']);
  assert.ok(queries.refExists(m, 'iface:r1:irb.7') && queries.refExists(m, 'iface:r1:lo0'));
  // physical view: ports are physical interfaces; children and loopbacks are never drawn as ports
  const s = new state.Session(m);
  const phys = s.render().root;
  const drawn = scene.findAll(phys, (n) => /^iface:/.test(n.attrs['data-ref'] || '')).map((n) => n.attrs['data-ref']);
  assert.deepEqual([...new Set(drawn)].sort(), ['iface:r1:ge-0/0/0', 'iface:r2:eth0']);
  // logical view: the loopbacks hang under their device; the tunnel is a relation
  s.setView('logical');
  const log = s.render().root;
  assert.deepEqual(byClass(log, 'loop-chip').map((n) => n.attrs['data-ref']).sort(), ['iface:r1:lo0', 'iface:r2:lo0']);
  assert.equal(byClass(log, 'cat-tunnel').length, 1);
  // details name the kind and the place in the hierarchy
  const det = (ref) => scene.textOf(panels.detailsFor(m, ref));
  assert.match(det('iface:r1:st0.10'), /type\nTunnel\nphysical interface\nge-0\/0\/0\n/);
  assert.doesNotMatch(det('iface:r1:st0.10'), /cable/);
  assert.match(det('iface:r1:ge-0/0/0'), /type\nPhysical\n[\s\S]*cable\nc1\n[\s\S]*Child interfaces \(3\)/);
  assert.match(det('iface:r1:lo0'), /type\nLoopback\n/);
  assert.match(det('device:r1'), /Interfaces \(4 physical, 1 cabled, 4 children\)/);
  assert.deepEqual(panels.tooltipFor(m, 'device:r1'), ['r1', 'Router', '4 physical interfaces, 1 cabled', '4 child interfaces', '1 loopback']);
  assert.match(panels.tooltipFor(m, 'iface:r1:st0.10')[1], /^Tunnel on ge-0\/0\/0$/);
});

// -------------------------------------------------------------- loopbacks

test('loopbacks: device-level entries with addresses; created and edited in their own list', () => {
  const d = ModelDoc.create();
  const i = d.addEntity('device', [['id', Y.strNode('r1')]]);
  assert.equal(d.addLoopback(i, ['10.255.0.1/32'], 'Router ID'), 0);
  assert.equal(d.addLoopback(i, ['2001:db8::1/128']), 1);
  assert.equal(d.addInterface(i), 0);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.match(d.exportText(), /^netatlas: 1\ntitle: New network\ndevices:\n  - id: r1\n    loopbacks:\n      - \{id: lo0, label: Router ID, ip: \[10\.255\.0\.1\/32\]\}\n      - \{id: lo1, ip: \[2001:db8::1\/128\]\}\n    interfaces:\n      - \{id: eth0\}\n/);
  assert.doesNotMatch(d.exportText(), /type:/, 'no type is written for a loopback or a physical interface');
  assert.deepEqual(d.result.model.devices[0].loopbacks.map((l) => [l.id, l.type, l.label]), [['lo0', 'loopback', 'Router ID'], ['lo1', 'loopback', undefined]]);
  assert.deepEqual(d.interfaceEntries(i).map((e) => `${e.kind}:${e.id}:${e.path.join('.')}`), ['interface:eth0:devices.0.interfaces.0', 'loopback:lo0:devices.0.loopbacks.0', 'loopback:lo1:devices.0.loopbacks.1']);
  // edited like any entry: a label and a second address, in the loopback's key order
  d.setText(['devices', i, 'loopbacks', 1, 'label'], 'BGP source');
  d.appendText(['devices', i, 'loopbacks', 1, 'ip'], 'fd00::1/128');
  assert.match(d.exportText(), /- \{id: lo1, label: BGP source, ip: \[2001:db8::1\/128, fd00::1\/128\]\}/);
  assert.equal(d.schemaKindOf(['devices', i, 'loopbacks', 1]), 'loopback');
  // a new loopback without an address is reported until it has one
  d.addLoopback(i, []);
  assert.match(d.errors[0].message, /loopback "lo2" needs at least one IPv4 or IPv6 address/);
  assert.deepEqual(d.issuePath(d.errors[0]), ['devices', i, 'loopbacks', 2, 'ip']);
});

test('loopbacks: no port, no cable; a device can have loopbacks and no interface at all', () => {
  const r = validate.loadModel('netatlas: 1\ndevices:\n  - id: a\n    loopbacks:\n      - {id: lo0, ip: 10.0.0.1/32, vrf: red, description: x, attrs: {k: v}}\n  - id: b\n    loopbacks: [{id: lo0, ip: 10.0.0.2/32}]\nrelations:\n  - {id: s, protocol: ibgp, endpoints: ["a:lo0", "b:lo0"]}\n');
  assert.deepEqual(r.errors.concat(r.warnings), []);
  assert.deepEqual([r.model.devices[0].interfaces.length, r.model.devices[0].loopbacks[0].vrf, r.model.devices[0].loopbacks[0].mac], [0, 'red', undefined]);
  const s = new state.Session(r.model);
  assert.equal(byClass(s.render().root, 'port').length, 0);
  s.setView('logical');
  assert.equal(byClass(s.render().root, 'loop-chip').length, 2);
});

// ------------------------------------------------------ alphabetical display

test('display order: alphabetical, case-insensitive, numbers by value, with a stable tie-breaker', () => {
  const sorted = (xs) => xs.slice().sort(compareNames);
  assert.deepEqual(sorted(['eth10', 'eth2', 'Eth1', 'lo0', 'ge-0/0/10', 'ge-0/0/9', 'ae1', 'Vlan20', 'vlan3']), ['ae1', 'Eth1', 'eth2', 'eth10', 'ge-0/0/9', 'ge-0/0/10', 'lo0', 'vlan3', 'Vlan20']);
  // names that differ only in case or leading zeros still have one fixed order
  assert.deepEqual(sorted(['eth1', 'Eth1', 'eth01']), sorted(['eth01', 'eth1', 'Eth1']));
  assert.equal(compareNames('a', 'a'), 0);
  assert.ok(compareNames('eth1', 'eth1.5') < 0 && compareNames('eth1.5', 'eth1') > 0);
  // identical names keep the order they were given in (file order)
  const items = [{ n: 'b', k: 1 }, { n: 'a', k: 2 }, { n: 'b', k: 3 }, { n: 'a', k: 4 }];
  assert.deepEqual(sortedByName(items, (x) => x.n).map((x) => x.k), [2, 4, 1, 3]);
  assert.deepEqual(items.map((x) => x.k), [1, 2, 3, 4], 'the input is not changed');
  // total and antisymmetric over a mixed set, so every browser sorts the same way
  const set = ['', 'a', 'A', 'a1', 'a01', 'a1b', '1', '01', '10', '2', 'ä', 'Z', 'a-1', 'a.1'];
  for (const x of set) for (const y of set) assert.equal(Math.sign(compareNames(x, y)) + Math.sign(compareNames(y, x)), 0, `${x} / ${y}`);
});

test('display order: details list interfaces, children and loopbacks alphabetically; the file order and the file stay as they are', () => {
  const text = `netatlas: 1
devices:
  - id: sw
    loopbacks:
      - {id: lo10, ip: 10.0.0.10/32}
      - {id: lo2, ip: 10.0.0.2/32}
      - {id: Lo1, ip: 10.0.0.1/32}
      - {id: lo3, ip: 10.0.0.3/32}
    interfaces:
      - id: eth10
      - id: eth2
        children: [{id: eth2.30}, {id: tun0, type: tunnel}, {id: eth2.4}]
      - id: Eth1
`;
  const d = doc(text);
  const m = d.result.model;
  const det = panels.detailsFor(m, 'device:sw');
  const rows = (list) => scene.findAll(scene.findAll(det, (n) => n.attrs['data-list'] === list)[0], (n) => n.tag === 'tr' && n.attrs['data-iface']).map((n) => n.attrs['data-iface']);
  assert.deepEqual(rows('loopbacks'), ['Lo1', 'lo2', 'lo3', 'lo10']);
  // every physical interface is followed by its own children
  assert.deepEqual(rows('interfaces'), ['Eth1', 'eth2', 'eth2.4', 'eth2.30', 'tun0', 'eth10']);
  const kids = scene.findAll(panels.detailsFor(m, 'iface:sw:eth2'), (n) => n.tag === 'li' && n.attrs['data-iface']).map((n) => n.attrs['data-iface']);
  assert.deepEqual(kids, ['eth2.4', 'eth2.30', 'tun0']);
  // the logical view shows the first loopbacks of that same order
  const s = new state.Session(m);
  s.setView('logical');
  const log = s.render().root;
  assert.deepEqual(byClass(log, 'loop-chip').map((n) => n.attrs['data-ref']), ['iface:sw:Lo1', 'iface:sw:lo2', 'iface:sw:lo3']);
  assert.match(scene.textOf(log), /\+1 more loopbacks/);
  // only the display is sorted: the model keeps the file order, and viewing writes nothing
  assert.deepEqual(m.devices[0].loopbacks.map((l) => l.id), ['lo10', 'lo2', 'Lo1', 'lo3']);
  assert.deepEqual(m.devices[0].interfaces.map((i) => i.id), ['eth10', 'eth2', 'Eth1']);
  assert.deepEqual(m.devices[0].interfaces[1].children.map((c) => c.id), ['eth2.30', 'tun0', 'eth2.4']);
  assert.deepEqual(d.interfaceEntries(0).map((e) => e.id), ['eth10', 'eth2', 'eth2.30', 'tun0', 'eth2.4', 'Eth1', 'lo10', 'lo2', 'Lo1', 'lo3']);
  assert.equal(d.exportText(), text);
  assert.equal(d.dirty, false);
  assert.equal(d.canUndo(), null);
  // adding an entry appends it to the list in the file; nothing is re-sorted
  d.addInterface(0, [['id', Y.strNode('eth0')]]);
  assert.deepEqual(d.result.model.devices[0].interfaces.map((i) => i.id), ['eth10', 'eth2', 'Eth1', 'eth0']);
});

test('display order: the file order of interfaces does not change the layout either', () => {
  const { layoutInput, layoutSignature } = load('layout/input.js');
  const a = model(net);
  const b = model(net.replace("      - {id: ge-0/0/0.100, type: logical, ip: 10.100.0.1/24}\n          - {id: st0.10, type: tunnel, ip: 172.16.10.1/30}\n", "      - {id: st0.10, type: tunnel, ip: 172.16.10.1/30}\n          - {id: ge-0/0/0.100, type: logical, ip: 10.100.0.1/24}\n"));
  assert.deepEqual(b.devices[0].interfaces[0].children.map((c) => c.id), ['st0.10', 'ge-0/0/0.100', 'ge-0/0/0.200']);
  assert.equal(layoutSignature(layoutInput(a)), layoutSignature(layoutInput(b)));
});

// ------------------------------------------------------------ removed fields

test('removed device fields: vendor, model, role, mgmt and router_id are errors, are not read, and have no default', () => {
  const removed = ['vendor', 'model', 'role', 'mgmt', 'router_id'];
  for (const k of removed) {
    const r = validate.loadModel(`netatlas: 1\ndevices:\n  - id: r1\n    ${k}: x\n    loopbacks:\n      - {id: lo0, ip: 10.255.0.1/32}\n`);
    assert.equal(r.errors.length, 1, k);
    assert.match(r.errors[0].message, new RegExp(`^"${k}" is no longer part of the format — a device has no `), k);
    assert.deepEqual([r.errors[0].path, r.errors[0].key, r.errors[0].line], [`devices[0].${k}`, k, 4], k);
    assert.ok(!SCHEMA.device.includes(k) && k in RETIRED.device, k);
    // nothing of it reaches the model …
    assert.deepEqual(Object.keys(r.model.devices[0]).sort(), ['attrs', 'description', 'group', 'id', 'interfaces', 'label', 'line', 'loopbacks', 'tier', 'type'], k);
    // … and the loopback itself is untouched
    assert.deepEqual(r.model.devices[0].loopbacks[0].addresses, ['10.255.0.1/32'], k);
  }
  assert.deepEqual(SCHEMA.device, ['id', 'label', 'type', 'group', 'tier', 'description', 'attrs', 'loopbacks', 'interfaces']);
  // the same values are welcome as free-form attributes
  const ok = validate.loadModel('netatlas: 1\ndevices:\n  - {id: r1, attrs: {vendor: Juniper, model: MX204, role: edge, mgmt: 10.99.0.11}}\n');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.model.devices[0].attrs.map(([k]) => k), ['vendor', 'model', 'role', 'mgmt']);
});

test('removed device fields: not drawn, not searched, and gone from the examples and the editor', () => {
  const m = model('netatlas: 1\ndevices:\n  - {id: r1, label: Edge, type: router, attrs: {model: MX204}}\n  - {id: r2}\n');
  const s = new state.Session(m);
  const text = scene.textOf(s.render().root);
  assert.match(text, /Edge\nRouter\n/);
  assert.doesNotMatch(text, /MX204/);
  assert.deepEqual(queries.search(m, 'MX204'), []);
  assert.doesNotMatch(scene.textOf(panels.detailsFor(m, 'device:r1')).split('Attributes')[0], /vendor|model|role|mgmt|router ID/i);
  const { layoutInput } = load('layout/input.js');
  assert.deepEqual(layoutInput(m).devices.map((d) => d.sub), ['Router', '']);
  for (const f of exampleNames) {
    assert.doesNotMatch(example(f), /^\s*(- )?(vendor|model|role|mgmt|router_id):/m, f);
    assert.doesNotMatch(example(f), /type: (loopback|physical|svi|vti|lag|virtual|subinterface)\b/, f);
  }
  const inspector = load('ui/inspector.js').Editor.toString();
  // (a relation endpoint still has a role; that is a different field)
  assert.doesNotMatch(inspector, /base\.concat\('(vendor|model|role|mgmt|router_id)'\)|Router ID \(loopback\)|Management address|'Vendor'|'Model'/);
});

// ------------------------------------------------ editing and export -> reload

test('editing: children are added under their physical interface, typed logical or tunnel, renamed with their references', () => {
  const d = doc('netatlas: 1\ndevices:\n  - id: r1\n    interfaces: [eth0, eth1]\n  - id: r2\n    interfaces: [eth0]\nrelations:\n  - {id: t, protocol: gre, endpoints: [r1, r2]}\n');
  const p = ['devices', 0, 'interfaces', 1];
  assert.equal(d.addChild(p, 'tunnel'), 0);
  assert.equal(d.addChild(p, 'logical'), 1);
  assert.equal(d.addChild(p, 'logical', [['id', Y.strNode('eth1.20')], ['ip', Y.seqNode([Y.strNode('10.0.20.1/24')], true)]]), 2);
  assert.equal(d.canUndo(), 'Add logical interface');
  // the shorthand "eth1" became a mapping with a block list of children; its sibling stays as written
  assert.match(d.exportText(), /    interfaces:\n      - eth0\n      - id: eth1\n        children:\n          - \{id: tun0, type: tunnel\}\n          - \{id: eth1\.1, type: logical\}\n          - \{id: eth1\.20, type: logical, ip: \[10\.0\.20\.1\/24\]\}\n/);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.equal(shape(d.result.model.devices[0]), 'eth0:physical[] eth1:physical[tun0:tunnel,eth1.1:logical,eth1.20:logical]');
  assert.equal(d.schemaKindOf(p), 'interface');
  assert.equal(d.schemaKindOf(p.concat('children', 0)), 'child');
  // ids are unique across the whole device, so a second tunnel is tun1 even on another port
  assert.equal(d.addChild(['devices', 0, 'interfaces', 0], 'tunnel'), 0);
  assert.equal(d.text(['devices', 0, 'interfaces', 0, 'children', 0, 'id']), 'tun1');
  // a relation uses the child; renaming the child updates it
  d.setEndpoint(['relations', 0, 'endpoints', 0], 'r1', 'tun0');
  assert.equal(d.renameInterface(p.concat('children', 0), 'gr-0'), 1);
  assert.match(d.exportText(), /endpoints: \[r1:gr-0, r2\]/);
  assert.deepEqual(d.references('device', 'r1', 'gr-0'), [['relations', 0, 'endpoints', 0]]);
  // changing the type is a plain field edit
  d.setText(p.concat('children', 1, 'type'), 'tunnel');
  assert.equal(d.result.model.index.interfaces.get('r1:eth1.1').type, 'tunnel');
  // removing a physical interface takes its children with it; what referred to them is reported, not dropped
  d.remove(p, 'Delete interface');
  assert.ok(d.errors.some((e) => /device "r1" has no interface "gr-0"/.test(e.message)));
  d.undo();
  assert.ok(d.valid);
});

test('export -> reload: the new format round-trips (hierarchy, loopbacks, references, comments)', () => {
  const d = doc(net);
  const out = d.exportText();
  assert.equal(out, net, 'an unedited file is written back exactly');
  const back = doc(out);
  assert.ok(back.valid);
  const flat = (m) => m.devices.map((x) => [x.id, T.deviceInterfaces(x).map((i) => [i.id, i.type, i.parent || null, i.addresses])]);
  assert.deepEqual(flat(back.result.model), flat(d.result.model));
  // … and after editing through the editor's operations
  d.addLoopback(1, ['2001:db8::2/128'], 'IPv6');
  d.addChild(['devices', 1, 'interfaces', 1], 'tunnel', [['id', Y.strNode('wg0')]]);
  d.renameEntity('device', 0, 'edge');
  const edited = d.exportText();
  const again = doc(edited);
  assert.ok(again.valid, again.errors.map((e) => e.message).join('\n'));
  assert.equal(again.exportText(), edited);
  assert.deepEqual(flat(again.result.model), flat(d.result.model));
  assert.equal(shape(again.result.model.index.devices.get('r2')), 'eth0:physical[tun0:logical] eth1:physical[wg0:tunnel]');
  assert.deepEqual(again.result.model.index.devices.get('r2').loopbacks.map((l) => l.id), ['lo0', 'lo1']);
  assert.deepEqual(again.result.model.relations.map((r) => r.endpoints.map((e) => e.device + ':' + e.iface)), [['edge:st0.10', 'r2:tun0'], ['edge:lo0', 'r2:lo0']]);
});

test('every example uses the new format and draws in both views', () => {
  for (const f of exampleNames) {
    const r = validate.loadModel(example(f));
    assert.deepEqual(r.errors.map((e) => `${e.line}: ${e.message}`), [], f);
    for (const dev of r.model.devices) {
      assert.ok(dev.interfaces.every((i) => i.type === 'physical'), f);
      assert.ok(dev.interfaces.every((i) => i.children.every((c) => (c.type === 'logical' || c.type === 'tunnel') && c.parent === i.id)), f);
      assert.ok(dev.loopbacks.every((l) => l.type === 'loopback' && l.addresses.length > 0), f);
    }
    const d = doc(example(f));
    assert.equal(d.exportText(), example(f).replace(/\r\n/g, '\n'), f + ': written back unchanged');
    const s = new state.Session(r.model);
    assert.equal(byClass(s.render().root, 'device').length, r.model.devices.length, f);
    s.setView('logical');
    assert.ok(s.render().root, f);
  }
  // the examples show the hierarchy itself: several children, of both types, and loopbacks
  const wan = model(example('enterprise-wan.yaml'));
  assert.equal(shape(wan.index.devices.get('hq-rtr2')), 'ge-0/0/0:physical[st0.11:tunnel,wg0:tunnel] ge-0/0/1:physical[]');
  assert.equal(wan.index.interfaces.get('hq-core1:Vlan10').parent, 'Ethernet1');
  assert.equal(wan.index.interfaces.get('hq-core1:Vlan10').type, 'logical');
});
