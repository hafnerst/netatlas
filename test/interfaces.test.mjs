// Interfaces: physical ones (ports) and logical ones (loopback, virtual,
// tunnel), stored once under their device. What a logical interface is
// associated with depends on what it is: member ports of an aggregate, the
// VLAN of a VLAN interface (its ports are derived from the links), the source
// and destination of a tunnel. Also: the alphabetical display order, the
// rejection of the earlier structures, and export -> reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, queries, derive, panels, scene, state, load, example, exampleNames, fixture, fixtureNames, model, byClass } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { SCHEMA, RETIRED } = load('yaml/schema.js');
const { compareNames, sortedByName } = load('model/order.js');
const T = load('model/types.js');
const Y = load('yaml/parse.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const messages = (text) => validate.loadModel(text).errors.map((e) => e.message);
const warnings = (text) => validate.loadModel(text).warnings.map((e) => e.message);
const ids = (xs) => xs.map((i) => i.id).join(',');
const s = Y.strNode;

const net = `netatlas: 1
devices:
  - id: sw1
    type: switch
    interfaces:
      - {id: Eth1}
      - {id: Eth2}
      - {id: Eth3, ip: 198.51.100.2/30}
      - Eth4
    logical_interfaces:
      - {id: lo0, type: loopback, label: Router ID, ip: [10.255.0.1/32, 2001:db8::1/128]}
      - {id: Po1, type: virtual, members: [Eth1, Eth2]}
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.10.0.2/24}
      - {id: Vlan20, type: virtual, ip: 10.20.0.2/24}
      - {id: nve1, type: virtual, description: VTEP}
      - {id: tun0, type: tunnel, source: Eth3, destination: 203.0.113.9, ip: 172.16.0.1/30}
      - {id: tun1, type: tunnel, source: lo0, destination: sw2:lo0}
      - {id: tun2, type: tunnel, source: 198.51.100.2, destination: 10.255.0.2}
  - id: sw2
    type: switch
    interfaces: [Eth1, Eth2]
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.2/32}
links:
  - {id: peer1, a: {device: sw1, interface: Eth1, vlans: [10, 20]}, b: {device: sw2, interface: Eth1, vlans: [10, 20]}}
  - {id: peer2, a: {device: sw1, interface: Eth2, vlans: [10]}, b: {device: sw2, interface: Eth2, vlans: [10]}}
networks:
  - {id: users, cidr: 10.10.0.0/24, vlan: 10}
  - {id: servers, cidr: 10.20.0.0/24, vlan: 20}
  - {id: loops, cidr: 10.255.0.0/24}
relations:
  - {id: lag, protocol: lacp, endpoints: ["sw1:Po1", sw2]}
  - {id: ibgp, protocol: ibgp, endpoints: ["sw1:lo0", "sw2:lo0"]}
`;

// ------------------------------------------------------ the two categories

test('interfaces are stored once under their device, as physical and logical; zero or more of either', () => {
  const r = validate.loadModel(net);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  const d = r.model.index.devices.get('sw1');
  assert.equal(ids(d.interfaces), 'Eth1,Eth2,Eth3,Eth4');
  assert.ok(d.interfaces.every((i) => i.type === 'physical'));
  assert.equal(d.logical.map((i) => i.id + ':' + i.type).join(), 'lo0:loopback,Po1:virtual,Vlan10:virtual,Vlan20:virtual,nve1:virtual,tun0:tunnel,tun1:tunnel,tun2:tunnel');
  // no nesting and no generic parent anywhere in the model
  for (const i of T.deviceInterfaces(d)) assert.ok(!('parent' in i) && !('children' in i), i.id);
  assert.deepEqual(Object.keys(d).sort(), ['attrs', 'description', 'group', 'id', 'interfaces', 'label', 'line', 'logical', 'tier', 'type']);
  // each interface exists once: one flat index, stable "device:interface" ids
  assert.equal(r.model.index.interfaces.size, 12 + 3);
  assert.equal(r.model.index.interfaces.get('sw1:Po1').type, 'virtual');
  assert.equal(ids(T.deviceInterfaces(d)), 'Eth1,Eth2,Eth3,Eth4,lo0,Po1,Vlan10,Vlan20,nve1,tun0,tun1,tun2');
  // zero of either category is fine
  const none = validate.loadModel('netatlas: 1\ndevices:\n  - {id: a}\n  - {id: b, interfaces: [e0]}\n  - {id: c, logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.1/32}]}\n');
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.model.devices.map((x) => [x.interfaces.length, x.logical.length]), [[0, 0], [1, 0], [0, 1]]);
  assert.deepEqual(SCHEMA.device.slice(-2), ['interfaces', 'logical_interfaces']);
});

test('a physical interface has no type; a logical interface has one of loopback, virtual, tunnel', () => {
  assert.deepEqual(T.LOGICAL_IFACE_TYPES, ['loopback', 'virtual', 'tunnel']);
  for (const t of ['physical', 'loopback', 'virtual', 'tunnel', 'svi']) {
    const m = messages(`netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, type: ${t}}\n`);
    assert.equal(m.length, 1, t);
    assert.match(m[0], /^"type" is not part of the format — an entry of "interfaces:" is always a physical interface and has no type: delete this key\. A loopback, virtual or tunnel interface belongs in the "logical_interfaces:" list/, t);
  }
  const logical = (body) => messages(`netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces:\n      - {id: x0${body}}\n`);
  assert.deepEqual(logical(', type: virtual'), []);
  assert.deepEqual(logical(', type: tunnel'), []);
  assert.deepEqual(logical(', type: loopback, ip: 10.0.0.1/32'), []);
  assert.deepEqual(logical(''), ['missing required key "type"']);
  for (const t of ['logical', 'svi', 'vlan', 'lag', 'bond', 'subinterface', 'vti', 'Tunnel']) {
    const m = logical(', type: ' + t);
    assert.equal(m.length, 1, t);
    assert.match(m[0], new RegExp(`^"${t}" is not a logical interface type: use "loopback", "virtual" or "tunnel" \\(an SVI, a VLAN interface, a bond or a subinterface is "virtual"\\)`), t);
  }
  assert.match(logical(', type: physical')[0], /a physical interface belongs in the "interfaces:" list of the device/);
  // located at the key, for the editor
  const r = validate.loadModel('netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces:\n      - {id: x0, type: svi}\n      - {id: x1}\n');
  assert.deepEqual([r.errors[0].path, r.errors[0].line], ['devices.a.logical_interfaces[0].type', 5]);
  assert.deepEqual([r.errors[1].path, r.errors[1].key], ['devices.a.logical_interfaces[1]', 'type']);
  // a draft without a valid type is still drawn, as the kind with the fewest rules
  assert.deepEqual(r.model.devices[0].logical.map((i) => i.type), ['virtual', 'virtual']);
  // a logical interface is written as a mapping (it needs its type)
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces: [lo0]\n')[0], /expected a mapping/);
});

test('stable ids: physical and logical interfaces share one set of ids per device', () => {
  const dup = (body) => messages('netatlas: 1\ndevices:\n  - id: a\n' + body);
  assert.match(dup('    interfaces: [e0]\n    logical_interfaces:\n      - {id: e0, type: virtual}\n')[0], /duplicate interface "e0" on device "a" \(already used by a physical interface; physical and logical interfaces share one set of ids per device\)/);
  assert.match(dup('    logical_interfaces:\n      - {id: x, type: tunnel}\n      - {id: x, type: virtual}\n')[0], /duplicate interface "x" on device "a" \(already used by a tunnel interface;/);
  assert.deepEqual(messages('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\n  - {id: b, interfaces: [e0]}\n'), []);
  // references use those ids: a cable ends on a physical interface only, a relation on any interface
  const r = validate.loadModel(net);
  assert.deepEqual(r.model.relations.map((x) => x.endpoints.map((e) => (e.iface ? r.model.index.interfaces.get(e.device + ':' + e.iface).type : 'device')).join('-')), ['virtual-device', 'loopback-loopback']);
  const cable = (a) => messages(net.replace('a: {device: sw1, interface: Eth2, vlans: [10]}', `a: "${a}"`));
  assert.deepEqual(cable('sw1:Eth4'), []);
  assert.match(cable('sw1:Po1')[0], /^"sw1:Po1" is a virtual interface, not a physical interface — a physical link must end on a physical interface\. Cable its member ports \(Eth1, Eth2\) instead;/);
  assert.match(cable('sw1:tun0')[0], /^"sw1:tun0" is a tunnel interface, not a physical interface .* Its source is "Eth3";/);
  assert.match(cable('sw1:lo0')[0], /^"sw1:lo0" is a loopback, not a physical interface/);
  assert.match(messages(net.replace('"sw1:Po1"', '"sw1:Po2"'))[0], /device "sw1" has no interface "Po2" — did you mean "Po1"\?/);
});

// -------------------------------------------------------------- loopbacks

test('loopbacks: logical interfaces with addresses and no physical parent', () => {
  const m = model(net);
  const lo = m.index.interfaces.get('sw1:lo0');
  assert.deepEqual([lo.type, lo.label, lo.addresses, lo.members, lo.vlan, lo.source, lo.destination], ['loopback', 'Router ID', ['10.255.0.1/32', '2001:db8::1/128'], [], undefined, undefined, undefined]);
  // its addresses count like any other interface's
  assert.deepEqual(derive.networkMembers(m, 'loops').map((x) => `${x.device}:${x.matches[0].iface}:${x.matches[0].loopback}`), ['sw1:lo0:true', 'sw2:lo0:true']);
  assert.equal(panels.associationText(m, lo), '', 'nothing to associate: no parent, members, VLAN or source');
  // the address rules of loopbacks are unchanged
  const lb = (ip) => messages(`netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces:\n      - {id: lo0, type: loopback${ip}}\n`);
  assert.match(lb('')[0], /loopback "lo0" needs at least one IPv4 or IPv6 address with prefix length/);
  assert.match(lb(', ip: 10.0.0.1')[0], /invalid loopback address: "10\.0\.0\.1" needs a prefix length/);
  assert.deepEqual(lb(', ip: [10.0.0.1/32, "2001:db8::1/128"]'), []);
  // the associations of other types are errors on a loopback, not silently ignored
  assert.match(lb(', ip: 10.0.0.1/32, members: [e0]')[0], /^"members" applies to a virtual interface only \(the member ports of a bond or aggregate\); "lo0" is a loopback interface — delete this key or change the type/);
  assert.match(lb(', ip: 10.0.0.1/32, vlan: 10')[0], /^"vlan" applies to a virtual interface only/);
  assert.match(lb(', ip: 10.0.0.1/32, source: e0')[0], /^"source" applies to a tunnel interface only/);
  assert.match(lb(', ip: 10.0.0.1/32, parent: e0')[0], /^"parent" is not part of the format — a logical interface has no generic parent/);
  // drawn as chips under the device in the logical view, never as ports
  const session = new state.Session(m);
  assert.equal(scene.findAll(session.render().root, (n) => /lo0$/.test(n.attrs['data-ref'] || '')).length, 0);
  session.setView('logical');
  assert.deepEqual(byClass(session.render().root, 'loop-chip').map((n) => n.attrs['data-ref']).sort(), ['iface:sw1:lo0', 'iface:sw2:lo0']);
});

// ------------------------------------------------------------- aggregates

test('aggregate: a virtual interface references several member ports, and the references are validated', () => {
  const m = model(net);
  const po = m.index.interfaces.get('sw1:Po1');
  assert.deepEqual(po.members, ['Eth1', 'Eth2']);
  assert.equal(panels.associationText(m, po), 'Member ports: Eth1, Eth2');
  assert.deepEqual(derive.associatedInterfaces(m, po), ['Eth1', 'Eth2']);
  assert.ok(derive.associatedInterfaces(m, m.index.interfaces.get('sw1:Eth1')).includes('Po1'), 'and the other way round');
  // a single member may be written without brackets
  assert.deepEqual(model(net.replace('members: [Eth1, Eth2]', 'members: Eth1')).index.interfaces.get('sw1:Po1').members, ['Eth1']);
  const bad = (members) => validate.loadModel(net.replace('members: [Eth1, Eth2]', 'members: ' + members));
  const first = (members) => bad(members).errors[0];
  assert.match(first('[Eth1, Eth9]').message, /^device "sw1" has no physical interface "Eth9" — did you mean "Eth1"\?/);
  assert.deepEqual([first('[Eth1, Eth9]').path, first('[Eth1, Eth9]').line], ['devices.sw1.logical_interfaces[1].members[1]', 12]);
  assert.match(first('[Eth1, lo0]').message, /^"lo0" is a loopback: the members of an aggregate are physical interfaces of the same device/);
  assert.match(first('[Eth1, Vlan10]').message, /^device "sw1" has no physical interface "Vlan10"/, 'a logical interface declared later is not a port either');
  assert.match(first('[Eth1, Eth1]').message, /^member port "Eth1" is listed twice/);
  assert.match(first('{a: 1}').message, /expected a list/);
  // what failed is not taken into the model; the rest is kept
  assert.deepEqual(bad('[Eth1, Eth9, Eth2]').model.index.interfaces.get('sw1:Po1').members, ['Eth1', 'Eth2']);
  // a port of another device is not a member port
  assert.match(messages('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\n  - id: b\n    logical_interfaces:\n      - {id: bond0, type: virtual, members: [e0]}\n')[0], /device "b" has no physical interface "e0" \(the device declares no physical interfaces\)/);
  // a port in two aggregates is reported, not refused
  const two = net.replace('      - {id: Vlan10,', '      - {id: Po2, type: virtual, members: [Eth2, Eth4]}\n      - {id: Vlan10,');
  assert.deepEqual(messages(two), []);
  assert.deepEqual(warnings(two), ['port "Eth2" is also a member of "Po1"; a port normally belongs to one aggregate']);
  // members on a physical interface: the aggregate is a logical interface
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, members: [e1]}\n')[0], /^"members" is not part of the format — only a virtual interface \(an aggregate\) has member ports/);
});

// -------------------------------------------------- VLAN-derived port association

test('VLAN interface: it names its VLAN (or takes it from its network); the ports carrying it are derived from the links', () => {
  const m = model(net);
  const v10 = m.index.interfaces.get('sw1:Vlan10');
  const v20 = m.index.interfaces.get('sw1:Vlan20');
  // written on the interface
  assert.equal(v10.vlan, 10);
  assert.deepEqual(derive.interfaceVlans(m, v10), [10]);
  assert.deepEqual(derive.interfaceVlanPorts(m, v10), [{ iface: 'Eth1', link: 'peer1', vlan: 10 }, { iface: 'Eth2', link: 'peer2', vlan: 10 }]);
  // not written: the VLAN of the network containing its address (entered once, on the network)
  assert.equal(v20.vlan, undefined);
  assert.deepEqual(derive.interfaceVlans(m, v20), [20]);
  assert.deepEqual(derive.interfaceVlanPorts(m, v20), [{ iface: 'Eth1', link: 'peer1', vlan: 20 }]);
  assert.equal(panels.associationText(m, v10), 'VLAN 10 · ports carrying it: Eth1, Eth2');
  assert.equal(panels.associationText(m, v20), 'VLAN 20 · ports carrying it: Eth1');
  // the ports are nowhere in the file or the model of the interface
  assert.deepEqual(v10.members, []);
  assert.doesNotMatch(net, /Vlan10[^\n]*Eth/);
  // they follow the links: only this device's own link ends count, and an end without the VLAN doesn't
  const moved = model(net.replace('a: {device: sw1, interface: Eth2, vlans: [10]}', 'a: {device: sw1, interface: Eth2, vlans: [20]}'));
  assert.deepEqual(derive.interfaceVlanPorts(moved, moved.index.interfaces.get('sw1:Vlan10')).map((p) => p.iface), ['Eth1']);
  assert.deepEqual(derive.interfaceVlanPorts(moved, moved.index.interfaces.get('sw1:Vlan20')).map((p) => p.iface), ['Eth1', 'Eth2']);
  assert.deepEqual(derive.portsCarryingVlans(m, 'sw2', [10]).map((p) => p.iface), ['Eth1', 'Eth2']);
  assert.deepEqual(derive.portsCarryingVlans(m, 'sw1', [99]), []);
  assert.deepEqual(derive.portsCarryingVlans(m, 'sw1', []), []);
  const none = model(net.replace(/, vlans: \[[0-9, ]+\]/g, ''));
  assert.equal(panels.associationText(none, none.index.interfaces.get('sw1:Vlan10')), 'VLAN 10 · no port carries it');
  // not every virtual interface is a VLAN interface or a bond: nothing is assumed for the VTEP
  const nve = m.index.interfaces.get('sw1:nve1');
  assert.deepEqual([derive.interfaceVlans(m, nve), derive.interfaceVlanPorts(m, nve), nve.members, panels.associationText(m, nve)], [[], [], [], '']);
  assert.deepEqual(derive.interfaceVlans(m, m.index.interfaces.get('sw1:Eth3')), [], 'only virtual interfaces are VLAN interfaces');
  // validation of the reference
  const vlan = (v) => messages(net.replace('vlan: 10, ip: 10.10.0.2/24', 'vlan: ' + v));
  assert.deepEqual(vlan('4094'), []);
  assert.match(vlan('0')[0], /"0" is not a VLAN ID: use a whole number from 1 to 4094/);
  assert.match(vlan('users')[0], /"users" is not a VLAN ID/);
  // the VLAN written on the interface and the VLAN of its address's network must agree
  assert.deepEqual(warnings(net.replace('vlan: 10, ip: 10.10.0.2/24', 'vlan: 30, ip: 10.10.0.2/24')), ['"Vlan10" is the interface of VLAN 30, but its address 10.10.0.2/24 lies in a network of VLAN 10']);
  // a physical interface still has no vlan key
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, vlan: 10}\n')[0], /^"vlan" is not part of the format — the VLAN of a physical interface is derived/);
});

// ---------------------------------------------------------- tunnel sources

test('tunnel: source is a physical or logical interface or an address; destination an address, device or interface', () => {
  const m = model(net);
  const t = (id) => m.index.interfaces.get('sw1:' + id);
  // a physical source, an address as destination
  assert.deepEqual(t('tun0').source, { text: 'Eth3', device: 'sw1', iface: 'Eth3' });
  assert.deepEqual(t('tun0').destination, { text: '203.0.113.9', address: '203.0.113.9' });
  // a logical source (a loopback): not restricted to a physical parent
  assert.deepEqual(t('tun1').source, { text: 'lo0', device: 'sw1', iface: 'lo0' });
  assert.deepEqual(t('tun1').destination, { text: 'sw2:lo0', device: 'sw2', iface: 'lo0' });
  // addresses: the interface that has the address is derived, not entered
  assert.deepEqual(t('tun2').source, { text: '198.51.100.2', address: '198.51.100.2', device: 'sw1', iface: 'Eth3' });
  assert.deepEqual(t('tun2').destination, { text: '10.255.0.2', address: '10.255.0.2', device: 'sw2', iface: 'lo0' });
  assert.equal(panels.associationText(m, t('tun0')), 'Tunnel source: Eth3 · Destination: 203.0.113.9');
  assert.equal(panels.associationText(m, t('tun2')), 'Tunnel source: 198.51.100.2 (Eth3) · Destination: 10.255.0.2 (sw2:lo0)');
  assert.deepEqual(derive.associatedInterfaces(m, t('tun1')), ['lo0']);
  assert.deepEqual(derive.associatedInterfaces(m, m.index.interfaces.get('sw1:lo0')), ['tun1']);
  // both are optional
  assert.deepEqual(messages('netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces:\n      - {id: t0, type: tunnel}\n      - {id: t1, type: tunnel, source: t0}\n'), []);
  const src = (v) => validate.loadModel(net.replace('source: Eth3', 'source: ' + v));
  assert.match(src('Eth9').errors[0].message, /^tunnel source "Eth9" is neither an IP address nor an interface of "sw1" — did you mean "Eth1"\?/);
  assert.equal(src('Eth9').errors[0].path, 'devices.sw1.logical_interfaces[5].source');
  assert.equal(src('Eth9').model.index.interfaces.get('sw1:tun0').source, undefined);
  assert.match(src('tun0').errors[0].message, /^a tunnel cannot be sourced from itself/);
  assert.match(src('sw2:Eth1').errors[0].message, /neither an IP address nor an interface of "sw1"/, 'the source is local');
  assert.deepEqual(src('192.0.2.77').errors, []);
  assert.deepEqual(src('192.0.2.77').warnings.map((w) => w.message), ['source address 192.0.2.77 is not an address of an interface of "sw1"; the tunnel\'s source interface can\'t be derived']);
  assert.deepEqual(src('"2001:db8::1"').model.index.interfaces.get('sw1:tun0').source, { text: '2001:db8::1', address: '2001:db8::1', device: 'sw1', iface: 'lo0' });
  const dst = (v) => validate.loadModel(net.replace('destination: sw2:lo0', 'destination: ' + v));
  assert.deepEqual(dst('sw2').model.index.interfaces.get('sw1:tun1').destination, { text: 'sw2', device: 'sw2', iface: undefined });
  assert.match(dst('sw9').errors[0].message, /^tunnel destination "sw9" is neither an IP address nor a device or "device:interface" of this model — did you mean "sw1"\?/);
  assert.match(dst('sw2:lo9').errors[0].message, /^device "sw2" has no interface "lo9" — did you mean "lo0"\?/);
  assert.match(dst('sw1:tun1').errors[0].message, /^a tunnel cannot have itself as its destination/);
  // source and destination belong to tunnels only
  assert.match(messages(net.replace('type: virtual, description: VTEP', 'type: virtual, source: Eth3'))[0], /^"source" applies to a tunnel interface only \(the local interface or address a tunnel is sourced from\); "nve1" is a virtual interface/);
  assert.match(messages(net.replace('source: lo0, destination: sw2:lo0', 'members: [Eth4]'))[0], /^"members" applies to a virtual interface only/);
});

// ------------------------------------------------ diagrams and highlighting

test('diagrams and selection follow the associations, in both directions', () => {
  const m = model(net);
  const rel = (ref) => queries.relatedRefs(m, ref);
  // an aggregate: its member ports and their cables
  for (const want of ['iface:sw1:Eth1', 'iface:sw1:Eth2', 'link:peer1', 'link:peer2', 'device:sw2', 'relation:lag']) assert.ok(rel('iface:sw1:Po1').has(want), want);
  assert.ok(!rel('iface:sw1:Po1').has('iface:sw1:Eth3'));
  // a VLAN interface: the ports carrying its VLAN and their cables
  assert.ok(rel('iface:sw1:Vlan20').has('iface:sw1:Eth1') && rel('iface:sw1:Vlan20').has('link:peer1') && !rel('iface:sw1:Vlan20').has('iface:sw1:Eth2') && !rel('iface:sw1:Vlan20').has('link:peer2'));
  // a tunnel: its source (a port, or a loopback) and its destination
  assert.ok(rel('iface:sw1:tun0').has('iface:sw1:Eth3') && !rel('iface:sw1:tun0').has('device:sw2'));
  assert.ok(rel('iface:sw1:tun1').has('iface:sw1:lo0') && rel('iface:sw1:tun1').has('device:sw2') && rel('iface:sw1:tun1').has('iface:sw2:lo0'));
  // a port: the logical interfaces that use it, without pulling in their other ports' cables
  const e1 = rel('iface:sw1:Eth1');
  assert.ok(e1.has('iface:sw1:Po1') && e1.has('iface:sw1:Vlan10') && e1.has('iface:sw1:Vlan20') && e1.has('link:peer1') && !e1.has('link:peer2') && !e1.has('iface:sw1:tun0'));
  assert.ok(rel('iface:sw1:Eth3').has('iface:sw1:tun0') && rel('iface:sw1:Eth3').has('iface:sw1:tun2'), 'tun2 is sourced from the address of Eth3');
  // the selection context of the lists: the cables a logical interface uses
  assert.deepEqual([...queries.selectionContext(m, 'iface:sw1:Po1').related].sort(), ['link:peer1', 'link:peer2', 'relation:lag']);
  assert.deepEqual([...queries.selectionContext(m, 'iface:sw1:Vlan10').related].sort(), ['link:peer1', 'link:peer2', 'network:users']);
  assert.deepEqual([...queries.selectionContext(m, 'iface:sw1:tun1').related].sort(), ['device:sw2']);
  // physical view: ports are physical interfaces; logical interfaces are never ports
  const session = new state.Session(m);
  const drawn = scene.findAll(session.render().root, (n) => /^iface:/.test(n.attrs['data-ref'] || '')).map((n) => n.attrs['data-ref']);
  assert.deepEqual([...new Set(drawn)].sort(), ['iface:sw1:Eth1', 'iface:sw1:Eth2', 'iface:sw2:Eth1', 'iface:sw2:Eth2']);
  // details: two tables, and only the associations that apply, with accurate labels
  const det = (ref) => scene.textOf(panels.detailsFor(m, ref));
  assert.match(det('device:sw1'), /Physical interfaces \(4, 2 cabled\)/);
  assert.match(det('device:sw1'), /Logical interfaces \(8\)/);
  assert.doesNotMatch(det('device:sw1'), /child|Loopbacks \(/i);
  assert.match(det('iface:sw1:Po1'), /type\nVirtual\nmember ports\nEth1\n, \nEth2\n/);
  assert.doesNotMatch(det('iface:sw1:Po1'), /ports carrying VLAN|tunnel source|physical interface\n/);
  assert.match(det('iface:sw1:Vlan20'), /VLAN\n20 \(from the network of its address\)\nports carrying VLAN\nEth1\n/);
  assert.match(det('iface:sw1:Vlan10'), /VLAN\n10\nports carrying VLAN\nEth1\n, \nEth2\n/);
  assert.doesNotMatch(det('iface:sw1:Vlan10'), /member ports|tunnel/);
  assert.match(det('iface:sw1:tun1'), /tunnel source\nlo0\ntunnel destination\nsw2:lo0\n/);
  assert.match(det('iface:sw1:tun2'), /tunnel source\n198\.51\.100\.2 \n→ \nsw1:Eth3\n/);
  assert.doesNotMatch(det('iface:sw1:lo0'), /member ports|ports carrying VLAN|tunnel source|\nVLAN\n/);
  assert.doesNotMatch(det('iface:sw1:nve1'), /member ports|ports carrying VLAN|tunnel source|\nVLAN\n/);
  assert.match(det('iface:sw1:Eth1'), /Used by logical interfaces \(3\)\nPo1\n aggregate \(member port\)\nVlan10\n VLAN interface \(carried on this port\)\nVlan20\n/);
  assert.match(det('iface:sw1:lo0'), /Used by logical interfaces \(1\)\ntun1\n tunnel \(source\)/);
  assert.deepEqual(panels.tooltipFor(m, 'device:sw1'), ['sw1', 'Switch', '4 physical interfaces, 2 cabled', '8 logical interfaces']);
  assert.deepEqual(panels.tooltipFor(m, 'iface:sw1:Po1').slice(0, 3), ['sw1 Po1', 'Virtual', 'Member ports: Eth1, Eth2']);
  assert.match(panels.tooltipFor(m, 'iface:sw1:Eth1')[2], /^used by Po1, Vlan10, Vlan20$/);
});

// ------------------------------------------------------ alphabetical display

test('display order: alphabetical, case-insensitive, numbers by value, with a stable tie-breaker', () => {
  const sorted = (xs) => xs.slice().sort(compareNames);
  assert.deepEqual(sorted(['eth10', 'eth2', 'Eth1', 'lo0', 'ge-0/0/10', 'ge-0/0/9', 'ae1', 'Vlan20', 'vlan3']), ['ae1', 'Eth1', 'eth2', 'eth10', 'ge-0/0/9', 'ge-0/0/10', 'lo0', 'vlan3', 'Vlan20']);
  assert.deepEqual(sorted(['eth1', 'Eth1', 'eth01']), sorted(['eth01', 'eth1', 'Eth1']));
  assert.equal(compareNames('a', 'a'), 0);
  // identical names keep the order they were given in (file order)
  const items = [{ n: 'b', k: 1 }, { n: 'a', k: 2 }, { n: 'b', k: 3 }, { n: 'a', k: 4 }];
  assert.deepEqual(sortedByName(items, (x) => x.n).map((x) => x.k), [2, 4, 1, 3]);
  assert.deepEqual(items.map((x) => x.k), [1, 2, 3, 4], 'the input is not changed');
  const set = ['', 'a', 'A', 'a1', 'a01', 'a1b', '1', '01', '10', '2', 'ä', 'Z', 'a-1', 'a.1'];
  for (const x of set) for (const y of set) assert.equal(Math.sign(compareNames(x, y)) + Math.sign(compareNames(y, x)), 0, `${x} / ${y}`);
});

test('display order: both categories are listed alphabetically; the file order and the file stay as they are', () => {
  const text = `netatlas: 1
devices:
  - id: sw
    interfaces: [eth10, eth2, Eth1]
    logical_interfaces:
      - {id: lo10, type: loopback, ip: 10.0.0.10/32}
      - {id: tun0, type: tunnel}
      - {id: lo2, type: loopback, ip: 10.0.0.2/32}
      - {id: bond0, type: virtual, members: [eth10, eth2]}
      - {id: Lo1, type: loopback, ip: 10.0.0.1/32}
      - {id: lo3, type: loopback, ip: 10.0.0.3/32}
`;
  const d = doc(text);
  const m = d.result.model;
  const det = panels.detailsFor(m, 'device:sw');
  const rows = (list) => scene.findAll(scene.findAll(det, (n) => n.attrs['data-list'] === list)[0], (n) => n.tag === 'tr' && n.attrs['data-iface']).map((n) => n.attrs['data-iface']);
  assert.deepEqual(rows('interfaces'), ['Eth1', 'eth2', 'eth10']);
  assert.deepEqual(rows('logical'), ['bond0', 'Lo1', 'lo2', 'lo3', 'lo10', 'tun0']);
  assert.match(scene.textOf(det), /Member ports: eth2, eth10/, 'member ports are shown sorted too');
  // the logical view shows the first loopbacks of that same order
  const session = new state.Session(m);
  session.setView('logical');
  const log = session.render().root;
  assert.deepEqual(byClass(log, 'loop-chip').map((n) => n.attrs['data-ref']), ['iface:sw:Lo1', 'iface:sw:lo2', 'iface:sw:lo3']);
  assert.match(scene.textOf(log), /\+1 more loopbacks/);
  // only the display is sorted: the model keeps the file order, and viewing writes nothing
  assert.equal(ids(m.devices[0].interfaces), 'eth10,eth2,Eth1');
  assert.equal(ids(m.devices[0].logical), 'lo10,tun0,lo2,bond0,Lo1,lo3');
  assert.deepEqual(m.devices[0].logical[3].members, ['eth10', 'eth2']);
  assert.deepEqual(d.interfaceEntries(0).map((e) => `${e.kind}:${e.id}`), ['interface:eth10', 'interface:eth2', 'interface:Eth1', 'logical:lo10', 'logical:tun0', 'logical:lo2', 'logical:bond0', 'logical:Lo1', 'logical:lo3']);
  assert.equal(d.exportText(), text);
  assert.equal(d.dirty, false);
  assert.equal(d.canUndo(), null);
  // adding an entry appends it to its list in the file; nothing is re-sorted
  d.addInterface(0, [['id', s('eth0')]]);
  d.addLogical(0, 'virtual', [['id', s('aaa')]]);
  assert.equal(ids(d.result.model.devices[0].interfaces), 'eth10,eth2,Eth1,eth0');
  assert.equal(ids(d.result.model.devices[0].logical), 'lo10,tun0,lo2,bond0,Lo1,lo3,aaa');
  // and the order of either list has no effect on the layout
  const { layoutInput, layoutSignature } = load('layout/input.js');
  const swapped = model(text.replace('[eth10, eth2, Eth1]', '[Eth1, eth2, eth10]').replace("      - {id: lo10, type: loopback, ip: 10.0.0.10/32}\n      - {id: tun0, type: tunnel}\n", "      - {id: tun0, type: tunnel}\n      - {id: lo10, type: loopback, ip: 10.0.0.10/32}\n"));
  assert.equal(layoutSignature(layoutInput(swapped)), layoutSignature(layoutInput(m)));
});

// ------------------------------- structures outside the format are rejected

test('nested child interfaces and a loopbacks list are rejected clearly, and nothing of them is dropped from the file', () => {
  const old = `netatlas: 1
devices:
  - id: r1
    loopbacks:
      - {id: lo0, ip: 10.255.0.1/32}
    interfaces:
      - id: ge-0/0/0
        ip: 198.51.100.2/30
        children:
          - {id: ge-0/0/0.100, type: logical, ip: 10.100.0.1/24}
          - {id: st0.10, type: tunnel, ip: 172.16.10.1/30}
      - {id: ge-0/0/1}
`;
  const r = validate.loadModel(old);
  assert.deepEqual(r.errors.map((e) => [e.line, e.path, e.key]), [[4, 'devices[0].loopbacks', 'loopbacks'], [9, 'devices.r1.interfaces[0].children', 'children']]);
  assert.match(r.errors[0].message, /^"loopbacks" is not part of the format — loopbacks are logical interfaces: move each entry into "logical_interfaces:" of the device and add "type: loopback" to it$/);
  assert.match(r.errors[1].message, /^"children" is not part of the format — interfaces are not nested: move each entry into "logical_interfaces:" of the device and give it "type: virtual" or "type: tunnel"\. A tunnel names the interface it is sourced from with "source:"; an aggregate lists its ports under "members:"; a VLAN interface names its VLAN with "vlan:"$/);
  // nothing is accepted silently: those entries are not read as interfaces …
  assert.equal(ids(r.model.devices[0].interfaces), 'ge-0/0/0,ge-0/0/1');
  assert.deepEqual(r.model.devices[0].logical, []);
  assert.ok(!r.model.index.interfaces.has('r1:lo0') && !r.model.index.interfaces.has('r1:st0.10'));
  // … and not discarded either: the document keeps them, exports them unchanged, and says why on every load
  const d = doc(old);
  assert.equal(d.exportText(), old);
  assert.equal(d.valid, false);
  d.setText(['devices', 0, 'label'], 'Router 1');
  assert.match(d.exportText(), /loopbacks:\n {6}- \{id: lo0, ip: 10\.255\.0\.1\/32\}/);
  assert.match(d.exportText(), /children:\n {10}- \{id: ge-0\/0\/0\.100, type: logical, ip: 10\.100\.0\.1\/24\}\n {10}- \{id: st0\.10, type: tunnel/);
  assert.deepEqual(doc(d.exportText()).errors.map((e) => e.key), ['loopbacks', 'children']);
  // what referred to them is reported as well, so nothing looks fine by accident
  assert.match(messages(old + 'relations:\n  - {id: x, protocol: gre, endpoints: ["r1:st0.10", r1]}\n')[2], /device "r1" has no interface "st0\.10"/);
  // the rejected keys are not part of the schema
  for (const kind of Object.keys(RETIRED)) for (const k of Object.keys(RETIRED[kind])) assert.ok(!SCHEMA[kind].includes(k), `${kind}.${k}`);
  assert.ok('children' in RETIRED.interface && 'children' in RETIRED.logical && 'loopbacks' in RETIRED.device && 'parent' in RETIRED.logical);
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces:\n      - {id: x, type: virtual, children: [y]}\n')[0], /^"children" is not part of the format — interfaces are not nested/);
  // "interfaces" as a mapping of categories is not the format either
  assert.match(messages('netatlas: 1\ndevices:\n  - id: a\n    interfaces: {physical: [e0]}\n')[0], /expected a list/);
});

test('removed device fields stay removed', () => {
  for (const k of ['vendor', 'model', 'role', 'mgmt', 'router_id']) {
    const r = validate.loadModel(`netatlas: 1\ndevices:\n  - id: r1\n    ${k}: x\n`);
    assert.equal(r.errors.length, 1, k);
    assert.match(r.errors[0].message, new RegExp(`^"${k}" is not part of the format — a device has no `), k);
  }
  for (const f of exampleNames) {
    assert.doesNotMatch(example(f), /^\s*(- )?(vendor|model|role|mgmt|router_id|loopbacks|children):/m, f);
    assert.doesNotMatch(example(f), /type: (logical|physical|svi|vti|lag|subinterface)\b/, f);
  }
  const inspector = load('ui/inspector.js').Editor.toString();
  assert.doesNotMatch(inspector, /add-child|child-type|Child interfaces|'children'|'loopbacks'|"Parent|parent physical/);
});

// ------------------------------------------------ editing and export -> reload

test('editing: interfaces are created in their category; members, VLAN, source and destination are plain fields', () => {
  const d = ModelDoc.create();
  const i = d.addEntity('device', [['id', s('r1')]]);
  assert.equal(d.addInterface(i), 0);
  assert.equal(d.addInterface(i), 1);
  assert.equal(d.addLoopback(i, ['10.255.0.1/32'], 'Router ID'), 0);
  assert.equal(d.addLogical(i, 'virtual'), 1);
  assert.equal(d.addLogical(i, 'virtual', [['id', s('Vlan10')]]), 2);
  assert.equal(d.addLogical(i, 'tunnel'), 3);
  assert.equal(d.canUndo(), 'Add tunnel interface');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.match(
    d.exportText(),
    /^netatlas: 1\ntitle: New network\ndevices:\n  - id: r1\n    interfaces:\n      - \{id: eth0\}\n      - \{id: eth1\}\n    logical_interfaces:\n      - \{id: lo0, type: loopback, label: Router ID, ip: \[10\.255\.0\.1\/32\]\}\n      - \{id: virtual0, type: virtual\}\n      - \{id: Vlan10, type: virtual\}\n      - \{id: tun0, type: tunnel\}\n/,
  );
  assert.deepEqual(d.interfaceEntries(i).map((e) => `${e.kind}:${e.id}:${e.type || ''}:${e.path.slice(2).join('.')}`), [
    'interface:eth0::interfaces.0',
    'interface:eth1::interfaces.1',
    'logical:lo0:loopback:logical_interfaces.0',
    'logical:virtual0:virtual:logical_interfaces.1',
    'logical:Vlan10:virtual:logical_interfaces.2',
    'logical:tun0:tunnel:logical_interfaces.3',
  ]);
  const lg = (k) => ['devices', i, 'logical_interfaces', k];
  assert.equal(d.schemaKindOf(lg(1)), 'logical');
  assert.equal(d.schemaKindOf(['devices', i, 'interfaces', 0]), 'interface');
  // an aggregate with two member ports
  d.appendText(lg(1).concat('members'), 'eth0', 'Add member port');
  d.appendText(lg(1).concat('members'), 'eth1', 'Add member port');
  // a VLAN interface, a tunnel sourced from the loopback
  d.setInteger(lg(2).concat('vlan'), '10');
  d.setText(lg(3).concat('source'), 'lo0');
  d.setText(lg(3).concat('destination'), '203.0.113.1');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.match(d.exportText(), /- \{id: virtual0, type: virtual, members: \[eth0, eth1\]\}\n {6}- \{id: Vlan10, type: virtual, vlan: 10\}\n {6}- \{id: tun0, type: tunnel, source: lo0, destination: 203\.0\.113\.1\}/);
  // ids are unique across both categories
  assert.equal(d.addLogical(i, 'tunnel'), 4);
  assert.equal(d.text(lg(4).concat('id')), 'tun1');
  // renaming a port updates the member list; renaming the loopback updates the tunnel source
  assert.equal(d.renameInterface(['devices', i, 'interfaces', 1], 'eth9'), 1);
  assert.equal(d.renameInterface(lg(0), 'Loopback0'), 1);
  assert.match(d.exportText(), /members: \[eth0, eth9\]/);
  assert.match(d.exportText(), /source: Loopback0/);
  assert.ok(d.valid);
  assert.deepEqual(d.references('device', 'r1', 'eth9'), [['devices', i, 'logical_interfaces', 1, 'members', 1]]);
  // changing the type is a plain field edit; what no longer applies is reported, never dropped
  d.setText(lg(1).concat('type'), 'tunnel');
  assert.match(d.errors[0].message, /"members" applies to a virtual interface only/);
  assert.match(d.exportText(), /\{id: virtual0, type: tunnel, members: \[eth0, eth9\]\}/);
  d.undo();
  // deleting a port that an aggregate lists is reported at the member
  d.remove(['devices', i, 'interfaces', 0], 'Delete interface');
  assert.match(d.errors[0].message, /device "r1" has no physical interface "eth0"/);
  assert.deepEqual(d.issuePath(d.errors[0]), ['devices', i, 'logical_interfaces', 1, 'members', 0]);
  d.undo();
  assert.ok(d.valid);
});

test('renaming follows tunnel destinations across devices, and leaves addresses alone', () => {
  const d = doc(net);
  assert.equal(d.renameInterface(['devices', 1, 'logical_interfaces', 0], 'Loopback0'), 2, 'the ibgp endpoint and the destination of sw1:tun1');
  assert.match(d.exportText(), /destination: sw2:Loopback0/);
  assert.equal(d.renameEntity('device', 1, 'core2') >= 4, true);
  assert.match(d.exportText(), /destination: core2:Loopback0/);
  assert.match(d.exportText(), /destination: 203\.0\.113\.9/);
  assert.match(d.exportText(), /source: 198\.51\.100\.2, destination: 10\.255\.0\.2/);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.deepEqual(d.result.model.index.interfaces.get('sw1:tun1').destination, { text: 'core2:Loopback0', device: 'core2', iface: 'Loopback0' });
});

test('export -> reload: the format round-trips (both categories, members, VLAN, source, destination, comments)', () => {
  const d = doc(net);
  const out = d.exportText();
  assert.equal(out, net, 'an unedited file is written back exactly');
  const flat = (m) => m.devices.map((x) => [x.id, T.deviceInterfaces(x).map((i) => [i.id, i.type, i.addresses, i.members, i.vlan, i.source, i.destination])]);
  assert.deepEqual(flat(doc(out).result.model), flat(d.result.model));
  // … and after editing through the editor's operations
  d.addLogical(1, 'virtual', [['id', s('Po1')], ['members', Y.seqNode([s('Eth1'), s('Eth2')], true)]]);
  d.addLogical(1, 'tunnel', [['id', s('tun0')], ['source', s('lo0')], ['destination', s('sw1:lo0')]]);
  d.addLogical(1, 'virtual', [['id', s('Vlan10')], ['vlan', Y.numNode(10)]]);
  d.addLoopback(1, ['2001:db8::2/128'], 'IPv6');
  const edited = d.exportText();
  const again = doc(edited);
  assert.ok(again.valid, again.errors.map((e) => e.message).join('\n'));
  assert.equal(again.exportText(), edited);
  assert.deepEqual(flat(again.result.model), flat(d.result.model));
  const sw2 = again.result.model.index.devices.get('sw2');
  assert.equal(sw2.logical.map((i) => i.id + ':' + i.type).join(), 'lo0:loopback,Po1:virtual,tun0:tunnel,Vlan10:virtual,lo1:loopback');
  assert.deepEqual(sw2.logical[1].members, ['Eth1', 'Eth2']);
  assert.deepEqual(derive.interfaceVlanPorts(again.result.model, sw2.logical[3]).map((p) => p.iface), ['Eth1', 'Eth2'], 'derived again after the reload, from the links');
  assert.doesNotMatch(edited, /Vlan10[^\n]*Eth/, 'the derived ports are never written');
  assert.deepEqual(sw2.logical[2].source, { text: 'lo0', device: 'sw2', iface: 'lo0' });
});

test('every example (and generated fixture) uses the format and draws in both views', () => {
  const files = exampleNames.map((f) => [f, example(f)]).concat(fixtureNames.map((f) => [f, fixture(f)]));
  assert.equal(files.length, 6 + 3);
  for (const [f, text] of files) {
    const r = validate.loadModel(text);
    assert.deepEqual(r.errors.concat(r.warnings).map((e) => `${e.line}: ${e.message}`), [], f);
    for (const dev of r.model.devices) {
      assert.ok(dev.interfaces.every((i) => i.type === 'physical'), f);
      assert.ok(dev.logical.every((i) => T.LOGICAL_IFACE_TYPES.includes(i.type)), f);
    }
    const d = doc(text);
    assert.equal(d.exportText(), text.replace(/\r\n/g, '\n'), f + ': written back unchanged');
    const session = new state.Session(r.model);
    assert.equal(byClass(session.render().root, 'device').length, r.model.devices.length, f);
    session.setView('logical');
    assert.ok(session.render().root, f);
  }
  // the examples show each association
  const wan = model(example('enterprise-wan.yaml'));
  const core = wan.index.devices.get('hq-core1');
  assert.deepEqual(wan.index.interfaces.get('hq-core1:Port-Channel1').members, ['Ethernet51', 'Ethernet52']);
  assert.deepEqual(derive.interfaceVlans(wan, wan.index.interfaces.get('hq-core1:Vlan10')), [10], 'from the network of its address');
  assert.deepEqual([...new Set(derive.interfaceVlanPorts(wan, wan.index.interfaces.get('hq-core1:Vlan10')).map((p) => p.iface))].sort(), ['Ethernet1', 'Ethernet51', 'Ethernet52']);
  assert.equal(core.logical.length, 3);
  assert.deepEqual(wan.index.interfaces.get('hq-rtr1:st0.10').source, { text: 'ge-0/0/0', device: 'hq-rtr1', iface: 'ge-0/0/0' });
  assert.deepEqual(wan.index.interfaces.get('hq-rtr1:st0.10').destination, { text: '192.0.2.10', address: '192.0.2.10', device: 'muc-rtr', iface: 'wan0' });
  const lab = model(fixture('editor-new-network.yaml'));
  assert.equal(lab.index.interfaces.get('edge-a:gr-0/0/0.1').source.iface, 'lo0', 'a tunnel sourced from a loopback');
  assert.deepEqual(derive.interfaceVlanPorts(lab, lab.index.interfaces.get('edge-a:irb.100')).map((p) => p.iface), ['ge-0/0/0']);
  assert.ok(model(example('datacenter-evpn.yaml')).index.interfaces.get('leaf1:Vxlan1').members.length === 0, 'a virtual interface that is neither a bond nor a VLAN interface');
});
