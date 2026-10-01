// "Configure once, derive elsewhere": network membership and interface VLANs
// are computed from addresses and prefixes (model/derive.ts), link-end VLANs
// are configured per end, and keys that are not part of the format are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, derive, queries, panels, scene, state, load, example, exampleNames, byClass, byRef } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { SCHEMA, RETIRED } = load('yaml/schema.js');
const { layoutInput, layoutSignature } = load('layout/input.js');
const { parseVlanList } = load('ui/inspector.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const load2 = (text) => validate.loadModel(text);
const ok = (text) => {
  const r = load2(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r;
};
const members = (m, id) => derive.networkMembers(m, id).map((x) => x.device);
const matches = (m, id) => derive.networkMembers(m, id).flatMap((x) => x.matches.map((a) => `${a.device}:${a.iface} ${a.address}`));
const vlanOf = (m, dev, inf) => derive.interfaceAddresses(m, dev, inf).map((a) => (a.vlan.state === 'vlan' ? a.vlan.vlan : a.vlan.state === 'ambiguous' ? 'ambiguous:' + a.vlan.vlans.join('/') : 'none'));
const errorsOf = (text) => load2(text).errors.map((e) => e.message);

// ------------------------------------------------------------------ membership

const net = `netatlas: 1
devices:
  - id: r1
    logical_interfaces:
      - {id: lo0, type: loopback, ip: [10.255.0.1/32, 2001:db8:ffff::1/128]}
    interfaces:
      - {id: eth0, ip: [10.1.0.1/24, 2001:db8:1::1/64]}
      - {id: eth1, ip: 10.1.0.9/24}
      - {id: eth2}
  - id: r2
    interfaces:
      - {id: eth0, ip: 10.1.0.2}
      - {id: eth1, ip: 10.1.1.2/16}
  - id: sw
    interfaces: [p1, p2]
networks:
  - {id: lan, cidr: 10.1.0.0/24, vlan: 10}
  - {id: lan6, cidr: "2001:db8:1::/64"}
  - {id: loops, cidr: [10.255.0.0/24, "2001:db8:ffff::/48"]}
  - {id: empty}
`;

test('membership: a device is a member when one of its addresses lies in the network; listed once, with every match', () => {
  const { model: m, warnings } = ok(net);
  assert.deepEqual(members(m, 'lan'), ['r1', 'r2']);
  // r1 matches through two interfaces but appears once
  assert.deepEqual(matches(m, 'lan'), ['r1:eth0 10.1.0.1/24', 'r1:eth1 10.1.0.9/24', 'r2:eth0 10.1.0.2']);
  assert.deepEqual(members(m, 'lan6'), ['r1']);
  // loopbacks count, for IPv4 and IPv6, and are marked as loopbacks
  assert.deepEqual(derive.networkMembers(m, 'loops')[0].matches.map((x) => [x.iface, x.loopback, x.address]), [
    ['lo0', true, '10.255.0.1/32'],
    ['lo0', true, '2001:db8:ffff::1/128'],
  ]);
  // devices without addresses, and networks without a prefix, have no membership
  assert.ok(!m.networks.some((n) => members(m, n.id).includes('sw')));
  assert.deepEqual(members(m, 'empty'), []);
  assert.deepEqual(warnings.map((w) => w.message).filter((t) => /no prefix/.test(t)).length, 1);
  assert.deepEqual(derive.deviceNetworks(m, 'r1'), ['lan', 'lan6', 'loops']);
  assert.deepEqual(derive.interfaceNetworks(m, 'r1', 'eth0'), ['lan', 'lan6']);
  assert.deepEqual(derive.interfaceNetworks(m, 'r1', 'eth2'), []);
});

test('membership: the network prefix is the authority; the interface\'s own prefix length is ignored', () => {
  const { model: m } = ok(net);
  // 10.1.0.2 (no length) and 10.1.1.2/16 (shorter length, but outside 10.1.0.0/24)
  assert.ok(matches(m, 'lan').includes('r2:eth0 10.1.0.2'));
  assert.ok(!matches(m, 'lan').some((x) => x.startsWith('r2:eth1')));
  const n = (cidr) => [{ id: 'n', label: 'n', cidr: [cidr], attrs: [], line: 0 }];
  const inside = (addr, cidr) => derive.containingNetworks(addr, n(cidr)).length === 1;
  assert.ok(inside('10.1.0.200/32', '10.1.0.0/24'));
  assert.ok(inside('10.1.0.200/8', '10.1.0.0/24'), 'a wider interface mask still matches');
  assert.ok(inside('10.1.0.200/30', '10.1.0.0/24'), 'a narrower interface mask still matches');
  assert.ok(!inside('10.1.1.1/16', '10.1.0.0/24'), 'same /16, but outside the network\'s /24');
});

test('membership: prefix lengths and boundaries, IPv4', () => {
  const n = (cidr) => [{ id: 'n', label: 'n', cidr: [cidr], attrs: [], line: 0 }];
  const inside = (addr, cidr) => derive.containingNetworks(addr, n(cidr)).length === 1;
  assert.ok(inside('10.1.0.0', '10.1.0.0/24') && inside('10.1.0.255', '10.1.0.0/24'), 'first and last address');
  assert.ok(!inside('10.0.255.255', '10.1.0.0/24') && !inside('10.1.1.0', '10.1.0.0/24'));
  assert.ok(inside('192.0.2.5', '192.0.2.4/30') && !inside('192.0.2.8', '192.0.2.4/30'), 'a prefix that is not on a byte boundary');
  assert.ok(inside('192.0.2.1', '192.0.2.1/32') && !inside('192.0.2.2', '192.0.2.1/32'), '/32 matches one address');
  assert.ok(inside('192.0.2.0', '192.0.2.0/31') && inside('192.0.2.1', '192.0.2.0/31') && !inside('192.0.2.2', '192.0.2.0/31'), '/31');
  assert.ok(inside('8.8.8.8', '0.0.0.0/0'), '/0 contains every IPv4 address');
  assert.ok(inside('10.1.0.77', '10.1.0.9/24'), 'host bits in the configured prefix are ignored: the network is the /24');
});

test('membership: IPv6, and no matching across address families', () => {
  const n = (cidr) => [{ id: 'n', label: 'n', cidr: [cidr], attrs: [], line: 0 }];
  const inside = (addr, cidr) => derive.containingNetworks(addr, n(cidr)).length === 1;
  assert.ok(inside('2001:db8:1::1/64', '2001:db8:1::/64'));
  assert.ok(inside('2001:DB8:1:0:ffff:ffff:ffff:ffff', '2001:db8:1::/64') && !inside('2001:db8:2::1', '2001:db8:1::/64'));
  assert.ok(inside('2001:db8::1', '2001:db8::1/128') && !inside('2001:db8::2', '2001:db8::1/128'));
  assert.ok(inside('2001:db8:0:1200::1', '2001:db8:0:1000::/52') && !inside('2001:db8:0:2000::1', '2001:db8:0:1000::/52'), 'a /52');
  assert.ok(inside('fe80::1', '::/0'));
  assert.ok(!inside('10.0.0.1', '::/0') && !inside('::1', '0.0.0.0/0'), 'IPv4 and IPv6 never match each other');
  assert.ok(!inside('::ffff:10.1.0.1', '10.1.0.0/24'), 'an IPv4-mapped IPv6 address is an IPv6 address');
});

test('membership: invalid or incomplete addresses belong to no network', () => {
  const n = [{ id: 'n', label: 'n', cidr: ['10.1.0.0/24', '::/0', '0.0.0.0/0'], attrs: [], line: 0 }];
  for (const bad of ['', 'dhcp', '10.1.0', '10.1.0.256', '10.1.0.1/', '10.1.0.1/33', '10.1.0.1/x', '10.1.0.1/24/24', '2001:db8::1/129', '2001:db8:::1', 'fe80::1%eth0', '10.1.0.01']) {
    assert.deepEqual(derive.containingNetworks(bad, n), [], JSON.stringify(bad));
  }
  // in a model: reported as a warning on the interface, shown as written, never a member
  const r = ok(net.replace('{id: eth2}', '{id: eth2, ip: [dhcp, 10.1.0.300/24]}'));
  assert.equal(r.warnings.filter((w) => /shown as written/.test(w.message)).length, 2);
  assert.deepEqual(derive.interfaceAddresses(r.model, 'r1', 'eth2').map((a) => [a.address, a.valid, a.networks]), [
    ['dhcp', false, []],
    ['10.1.0.300/24', false, []],
  ]);
  assert.deepEqual(matches(r.model, 'lan').filter((x) => x.startsWith('r1:eth2')), []);
});

test('membership: an invalid network prefix is an error and defines nothing', () => {
  const r = load2(net.replace('{id: empty}', '{id: bad, cidr: [10.1.0.0, 10.1.0.0/40, banana]}'));
  assert.deepEqual(r.errors.map((e) => e.message), [
    'invalid network prefix: "10.1.0.0" needs a prefix length, e.g. 10.1.0.0/32',
    'invalid network prefix: prefix length "/40" is invalid for IPv4 (0–32)',
    'invalid network prefix: "banana" is not a valid IPv4 or IPv6 address',
  ]);
  assert.deepEqual(members(r.model, 'bad'), []);
  const hb = ok(net.replace('{id: empty}', '{id: hb, cidr: 10.1.0.9/24}'));
  assert.ok(hb.warnings.some((w) => /10\.1\.0\.9\/24 has bits set beyond \/24/.test(w.message)));
  assert.deepEqual(members(hb.model, 'hb'), ['r1', 'r2']);
});

test('membership: overlapping networks each list the device', () => {
  const { model: m } = ok(net.replace('{id: empty}', '{id: super, cidr: 10.0.0.0/8}'));
  assert.deepEqual(members(m, 'super'), ['r1', 'r2']);
  assert.deepEqual(matches(m, 'super'), ['r1:eth0 10.1.0.1/24', 'r1:eth1 10.1.0.9/24', 'r1:lo0 10.255.0.1/32', 'r2:eth0 10.1.0.2', 'r2:eth1 10.1.1.2/16']);
  assert.deepEqual(derive.interfaceAddresses(m, 'r1', 'eth1')[0].networks, ['lan', 'super']);
});

// --------------------------------------------------------------- derived VLANs

test('interface VLAN: derived from the containing network, per address; never invented', () => {
  const { model: m } = ok(net);
  assert.deepEqual(vlanOf(m, 'r1', 'eth0'), [10, 'none'], 'IPv4 in lan (VLAN 10), IPv6 in lan6 (no VLAN defined)');
  assert.deepEqual(vlanOf(m, 'r1', 'lo0'), ['none', 'none'], 'a matching network without a VLAN gives none');
  assert.deepEqual(vlanOf(m, 'r2', 'eth1'), ['none'], 'no matching network gives none');
  assert.deepEqual(vlanOf(m, 'r1', 'eth2'), [], 'no address, nothing derived');
  assert.equal(derive.interfaceVlanText(derive.interfaceAddresses(m, 'r1', 'eth0')), 'VLAN 10');
  assert.equal(derive.interfaceVlanText(derive.interfaceAddresses(m, 'r1', 'lo0')), '');
});

test('interface VLAN: several addresses can give several VLANs', () => {
  const { model: m, warnings } = ok(net.replace('{id: eth1, ip: 10.1.0.9/24}', '{id: eth1, ip: [10.1.0.9/24, 10.2.0.9/24, "2001:db8:1::9/64"]}').replace('{id: empty}', '{id: lan2, cidr: 10.2.0.0/24, vlan: 20}'));
  assert.deepEqual(vlanOf(m, 'r1', 'eth1'), [10, 20, 'none']);
  assert.equal(derive.interfaceVlanText(derive.interfaceAddresses(m, 'r1', 'eth1')), 'VLAN 10, VLAN 20');
  assert.ok(!warnings.some((w) => /ambiguous/.test(w.message)), 'different addresses in different VLANs are not an ambiguity');
});

test('interface VLAN: overlapping networks with conflicting VLANs are an explicit ambiguity', () => {
  const r = ok(net.replace('{id: empty}', '{id: part, cidr: 10.1.0.0/28, vlan: 99}'));
  // 10.1.0.1 and 10.1.0.9 lie in both; 10.1.0.2 too
  assert.deepEqual(vlanOf(r.model, 'r1', 'eth0'), ['ambiguous:10/99', 'none']);
  assert.match(derive.interfaceVlanText(derive.interfaceAddresses(r.model, 'r1', 'eth0')), /^ambiguous: VLAN 10 or 99$/);
  const w = r.warnings.filter((x) => /ambiguous/.test(x.message));
  assert.equal(w.length, 3);
  assert.match(w[0].message, /the VLAN of 10\.1\.0\.1\/24 on r1:eth0 is ambiguous: it lies in "lan" \(VLAN 10\) and "part" \(VLAN 99\); no VLAN is derived for it/);
  assert.equal(w[0].path, 'devices.r1.interfaces[0].ip');
  // overlapping networks that agree, or where only one defines a VLAN, are not ambiguous
  assert.deepEqual(vlanOf(ok(net.replace('{id: empty}', '{id: part, cidr: 10.1.0.0/28, vlan: 10}')).model, 'r1', 'eth0'), [10, 'none']);
  assert.deepEqual(vlanOf(ok(net.replace('{id: empty}', '{id: super, cidr: 10.0.0.0/8}')).model, 'r1', 'eth0'), [10, 'none']);
});

test('derived values follow every edit at once and are never written to the YAML', () => {
  const d = doc(net);
  const m = () => d.result.model;
  d.appendText(['devices', 2, 'interfaces', 0, 'ip'], '10.1.0.50/24');
  assert.deepEqual(members(m(), 'lan'), ['r1', 'r2', 'sw']);
  assert.deepEqual(vlanOf(m(), 'sw', 'p1'), [10]);
  d.setInteger(['networks', 0, 'vlan'], '11');
  assert.deepEqual(vlanOf(m(), 'sw', 'p1'), [11]);
  d.setText(['networks', 0, 'cidr'], '10.9.0.0/24');
  assert.deepEqual(members(m(), 'lan'), []);
  assert.deepEqual(vlanOf(m(), 'sw', 'p1'), ['none']);
  d.undo();
  assert.deepEqual(members(m(), 'lan'), ['r1', 'r2', 'sw']);
  d.setText(['devices', 2, 'interfaces', 0, 'ip', 0], '');
  assert.deepEqual(members(m(), 'lan'), ['r1', 'r2']);
  const out = d.exportText();
  assert.ok(!/members/.test(out));
  assert.equal((out.match(/vlan/g) || []).length, 1, 'only the network\'s own vlan key');
  assert.deepEqual(Object.keys(m().networks[0]).sort(), ['attrs', 'cidr', 'description', 'id', 'label', 'line', 'vlan']);
});

test('membership drives highlighting, the selection context, search and the layout input', () => {
  const { model: m } = ok(net);
  assert.ok(queries.relatedRefs(m, 'network:lan').has('device:r2') && queries.relatedRefs(m, 'network:lan').has('iface:r1:eth1'));
  assert.ok(queries.relatedRefs(m, 'device:r1').has('network:loops') && !queries.relatedRefs(m, 'device:sw').has('network:lan'));
  assert.deepEqual([...queries.selectionContext(m, 'network:lan').related].sort(), ['device:r1', 'device:r2']);
  assert.deepEqual([...queries.selectionContext(m, 'iface:r2:eth1').related], []);
  assert.equal(queries.search(m, 'vlan 10')[0].ref, 'network:lan');
  assert.deepEqual(layoutInput(m).networks.map((n) => [n.id, n.members]), [['empty', []], ['lan', ['r1', 'r2']], ['lan6', ['r1']], ['loops', ['r1']]]);
  // an address change matters for the layout only when it changes membership
  const sig = (t) => layoutSignature(layoutInput(ok(t).model));
  assert.equal(sig(net.replace('10.1.0.9/24', '10.1.0.10/24')), sig(net));
  assert.notEqual(sig(net.replace('ip: 10.1.0.2}', 'ip: 10.7.0.2}')), sig(net));
});

// ---------------------------------------------------------- link-end VLANs

const lk = `netatlas: 1
devices:
  - id: a
    interfaces: [e0, e1, e2]
  - id: b
    interfaces: [e0, e1, e2]
networks:
  - {id: users, cidr: 10.1.0.0/24, vlan: 10}
links:
  - {id: trunk, a: {device: a, interface: e0, vlans: [20, 10, 30]}, b: {device: b, interface: e0, vlans: [10, 20, 30]}, medium: fiber, speed: 10G}
  - {id: access, a: {device: a, interface: e1, vlans: 10}, b: {device: b, interface: e1, vlans: [10]}}
  - {id: plain, a: "a:e2", b: "b:e2"}
`;

test('link ends: VLANs are stored per end; several = Trunk, one = single VLAN, none = no VLAN', () => {
  const r = ok(lk);
  assert.deepEqual(r.warnings, []);
  const [trunk, access, plain] = r.model.links;
  assert.deepEqual([trunk.a.vlans, trunk.b.vlans], [[10, 20, 30], [10, 20, 30]]);
  assert.deepEqual([access.a.vlans, access.b.vlans], [[10], [10]], 'a single value is a one-element list');
  assert.deepEqual([plain.a.vlans, plain.b.vlans], [[], []], 'nothing configured, nothing assumed');
  assert.equal(derive.linkEndVlanText(trunk.a.vlans), 'Trunk · VLANs 10, 20, 30');
  assert.equal(derive.linkEndVlanText(access.a.vlans), 'VLAN 10');
  assert.equal(derive.linkEndVlanText(plain.a.vlans), 'No VLAN');
  assert.deepEqual([trunk.medium, trunk.speed], ['fiber', '10G']);
});

test('link ends: a difference between the ends is a warning; neither end is changed', () => {
  const text = lk.replace('b: {device: b, interface: e0, vlans: [10, 20, 30]}', 'b: {device: b, interface: e0, vlans: [10, 40]}').replace('b: "b:e2"', 'b: {device: b, interface: e2, vlans: [7]}');
  const r = ok(text);
  assert.deepEqual(r.warnings.map((w) => [w.path, w.message]), [
    ['links.trunk', 'VLAN mismatch between the ends of this link (only on end A: 20, 30; only on end B: 40)'],
    ['links.plain', 'VLAN mismatch between the ends of this link (only on end B: 7)'],
  ]);
  assert.deepEqual([r.model.links[0].a.vlans, r.model.links[0].b.vlans], [[10, 20, 30], [10, 40]]);
  assert.deepEqual(derive.vlanMismatch([10, 20], [20, 10]), null);
  assert.deepEqual(derive.vlanMismatch([], []), null);
  assert.deepEqual(derive.vlanMismatch([10], []), { onlyA: [10], onlyB: [] });
  // the file is written back exactly as it was (the unsorted list on end A too)
  const short = text.replace(', medium: fiber, speed: 10G', '');
  assert.equal(doc(short).exportText(), short);
});

test('link ends: VLAN IDs are validated (1–4094, no duplicates)', () => {
  const bad = (v) => errorsOf(lk.replace('vlans: [20, 10, 30]', 'vlans: ' + v));
  assert.match(bad('[0]')[0], /"0" is not a VLAN ID: use a whole number from 1 to 4094/);
  assert.match(bad('[4095]')[0], /"4095" is not a VLAN ID/);
  assert.match(bad('[ten]')[0], /"ten" is not a VLAN ID/);
  assert.match(bad('[1.5]')[0], /not a VLAN ID/);
  assert.match(bad('[10, 10]')[0], /VLAN 10 is listed twice on this end/);
  assert.match(bad('{x: 1}')[0], /expected a list/);
  assert.deepEqual(bad('[1, 4094]'), []);
  assert.match(errorsOf(lk.replace('vlan: 10}', 'vlan: users}'))[0], /"users" is not a VLAN ID/);
  assert.match(errorsOf(lk.replace('a: "a:e2"', 'a: {device: a, interface: e2, vlan: 5}'))[0], /unknown key "vlan" — did you mean "vlans"\?/);
});

test('link-end VLANs and network VLANs are separate facts', () => {
  // a VLAN may be permitted on a cable without any network defining it, and vice versa
  const r = ok(lk.replace('vlan: 10}', 'vlan: 500}'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.model.networks[0].vlan, 500);
  assert.deepEqual(r.model.links[0].a.vlans, [10, 20, 30]);
  // changing a link end does not change any derived interface VLAN
  const d = doc(lk.replace('interfaces: [e0, e1, e2]', 'interfaces: [{id: e0, ip: 10.1.0.1/24}, e1, e2]'));
  assert.deepEqual(vlanOf(d.result.model, 'a', 'e0'), [10]);
  d.removeEndVlan(['links', 0, 'a'], '10');
  assert.deepEqual(vlanOf(d.result.model, 'a', 'e0'), [10]);
  assert.deepEqual(d.result.model.links[0].a.vlans, [20, 30]);
});

test('editing link-end VLANs: only the edited end is written; short form in, short form out', () => {
  const d = doc(lk);
  const p = ['links', 2, 'a'];
  assert.deepEqual(d.endVlans(p), []);
  assert.ok(d.addEndVlans(p, [30, 10, 30]));
  assert.match(d.exportText(), /\{id: plain, a: \{device: a, interface: e2, vlans: \[10, 30\]\}, b: "b:e2"\}/);
  assert.deepEqual(d.result.model.links[2].b.vlans, [], 'the other end is untouched');
  assert.ok(d.warnings.some((w) => /only on end A: 10, 30/.test(w.message)));
  assert.ok(d.addEndVlans(p, [10]), 'already there: nothing to do');
  assert.equal(d.canUndo(), 'Add VLAN');
  d.addEndVlans(p, [20]);
  assert.deepEqual(d.endVlans(p), ['10', '20', '30']);
  d.removeEndVlan(p, '20');
  d.removeEndVlan(p, '10');
  assert.match(d.exportText(), /a: \{device: a, interface: e2, vlans: \[30\]\}/);
  d.removeEndVlan(p, '30');
  assert.match(d.exportText(), /\{id: plain, a: a:e2, b: "b:e2"\}/, 'no VLAN left: back to the short form, no empty list');
  assert.ok(d.valid && !d.warnings.length);
  // an end without a device cannot get VLANs
  const e = doc('netatlas: 1\ndevices:\n  - id: a\nlinks:\n  - {id: l}\n');
  assert.equal(e.addEndVlans(['links', 0, 'a'], [10]), false);
  assert.equal(e.exportText(), 'netatlas: 1\ndevices:\n  - id: a\nlinks:\n  - {id: l}\n');
  // a device-only end works too, and an invalid entry in the file is kept, not dropped
  const f = doc('netatlas: 1\ndevices:\n  - id: a\n  - id: b\nlinks:\n  - {id: l, a: a, b: {device: b, vlans: [x, 5]}}\n');
  f.addEndVlans(['links', 0, 'a'], [5]);
  f.addEndVlans(['links', 0, 'b'], [7]);
  assert.match(f.exportText(), /a: \{device: a, vlans: \[5\]\}, b: \{device: b, vlans: \[x, 5, 7\]\}/);
  // changing the device of an end keeps that end's VLANs
  f.setEndpoint(['links', 0, 'a'], 'b', '');
  assert.match(f.exportText(), /a: \{device: b, vlans: \[5\]\}/);
});

test('VLAN list input: ids, separators and ranges', () => {
  assert.deepEqual(parseVlanList('10'), [10]);
  assert.deepEqual(parseVlanList('10, 20;30  40'), [10, 20, 30, 40]);
  assert.deepEqual(parseVlanList('30-32, 31, 5'), [30, 31, 32, 5]);
  for (const bad of ['0', '4095', '10-5', 'a', '10,,x', '1.5', '-3']) assert.equal(parseVlanList(bad), null, bad);
});

test('physical view and details show per-end VLANs, Trunk, and the mismatch', () => {
  const s = new state.Session(ok(lk.replace('b: {device: b, interface: e0, vlans: [10, 20, 30]}', 'b: {device: b, interface: e0, vlans: [10]}')).model);
  const v = s.render().root;
  const cable = (id) => byRef(v, 'link:' + id).find((n) => scene.hasClass(n, 'cable'));
  assert.ok(scene.hasClass(cable('trunk'), 'vlan-mismatch'));
  assert.ok(!scene.hasClass(cable('access'), 'vlan-mismatch') && !scene.hasClass(cable('plain'), 'vlan-mismatch'));
  assert.equal(byClass(v, 'vlan-warn').length, 1);
  const tip = panels.tooltipFor(s.model, 'link:trunk').join('\n');
  assert.match(tip, /A: Trunk · VLANs 10, 20, 30 {2}\| {2}B: VLAN 10/);
  assert.match(tip, /VLAN mismatch/);
  assert.ok(!/VLAN/.test(panels.tooltipFor(s.model, 'link:plain').join('\n')), 'no VLAN configured: none shown');
  const det = JSON.stringify(panels.detailsFor(s.model, 'link:trunk'));
  assert.match(det, /Trunk · VLANs 10, 20, 30/);
  assert.match(det, /mismatch — only on end A: 20, 30/);
  assert.match(JSON.stringify(panels.detailsFor(s.model, 'link:plain')), /No VLAN/);
  // the cable label names the trunk when both ends agree
  const { linkVlanLabel } = load('diagram/physical.js');
  const links = ok(lk).model.links;
  assert.deepEqual(links.map(linkVlanLabel), ['Trunk 10,20,30', 'VLAN 10', '']);
  assert.equal(linkVlanLabel(s.model.links[0]), 'VLAN mismatch');
});

test('details and logical view use derived membership and derived interface VLANs', () => {
  const { model: m } = ok(net);
  const netDet = JSON.stringify(panels.detailsFor(m, 'network:lan'));
  assert.match(netDet, /Members \(2\)/);
  assert.match(netDet, /10\.1\.0\.9\/24/);
  assert.match(JSON.stringify(panels.detailsFor(m, 'iface:r1:eth0')), /VLAN 10/);
  assert.match(JSON.stringify(panels.detailsFor(m, 'iface:r2:eth1')), /no network/);
  assert.deepEqual(panels.tooltipFor(m, 'network:lan'), ['lan', 'VLAN 10 · 10.1.0.0/24', '2 members']);
  const s = new state.Session(m);
  s.setView('logical');
  const v = s.render().root;
  assert.equal(byClass(v, 'member').length, 4, 'lan: r1, r2; lan6: r1; loops: r1');
  assert.equal(byClass(v, 'network').length, 4);
});

// ------------------------------------- keys outside the format are errors

test('keys that are not part of the format are rejected with what to do instead', () => {
  const wrong = `netatlas: 1
groups:
  - {id: g1, kind: row}
devices:
  - id: r1
    interfaces:
      - {id: e0, speed: 1G, media: fiber, vlan: 10, ip: 10.1.0.1/24}
    loopbacks:
      - {id: lo0, ip: 10.255.0.1/32, vlan: 5}
networks:
  - {id: n1, kind: vlan, vrf: red, vlan: 10, cidr: 10.1.0.0/24, members: [r1, "r1:e0"]}
`;
  const r = load2(wrong);
  const by = (re) => r.errors.filter((e) => re.test(e.message));
  assert.equal(r.errors.length, 8, r.errors.map((e) => e.message).join('\n'));
  assert.match(by(/"speed"/)[0].message, /^"speed" is not part of the format — speed is configured once, on the physical link: set "speed:" on the link/);
  assert.match(by(/"media"/)[0].message, /set "medium:" on the link cabled to this port/);
  assert.equal(by(/"vlan" is not part of the format — the VLAN of a physical interface is derived from the network/).length, 1);
  assert.match(by(/"loopbacks"/)[0].message, /^"loopbacks" is not part of the format — loopbacks are logical interfaces: move each entry into "logical_interfaces:" of the device and add "type: loopback"/);
  assert.equal(r.model.devices[0].logical.length, 0, 'the list under an unknown key is not read');
  assert.match(by(/"kind"/)[0].message, /a network is always an IP network: delete this key/);
  assert.match(by(/"vrf"/)[0].message, /set "vrf:" on those interfaces/);
  assert.match(by(/"members"/)[0].message, /members are derived from the interface and loopback addresses/);
  assert.match(by(/"row"/)[0].message, /group kind "row" is not accepted — write "kind: floor"/);
  // located at the key, with its line, for the editor and the problem list
  assert.deepEqual([by(/"members"/)[0].path, by(/"members"/)[0].key, by(/"members"/)[0].line], ['networks[0].members', 'members', 11]);
  // nothing is converted: the rejected values are not read into the model …
  const e0 = r.model.index.interfaces.get('r1:e0');
  assert.ok(!('speed' in e0) && !('vlan' in e0));
  assert.deepEqual(members(r.model, 'n1'), ['r1'], 'membership comes from the address, not from the rejected list');
  // … and the file is written back unchanged, so the user can fix it
  assert.equal(doc(wrong).exportText(), wrong);
  // the same keys are rejected when written in block style, and link "speed"/"medium" stay valid
  assert.match(errorsOf('netatlas: 1\ndevices:\n  - id: a\n    interfaces:\n      - id: e0\n        speed: 1G\n')[0], /"speed" is not part of the format/);
  assert.deepEqual(errorsOf('netatlas: 1\ndevices:\n  - id: a\n  - id: b\nlinks:\n  - {id: l, a: a, b: b, medium: fiber, speed: 1G}\n'), []);
});

test('the schema contains none of the rejected keys, and the editor never writes them', () => {
  for (const kind of Object.keys(RETIRED)) for (const k of Object.keys(RETIRED[kind])) assert.ok(!SCHEMA[kind].includes(k), `${kind}.${k}`);
  assert.deepEqual(SCHEMA.network, ['id', 'label', 'cidr', 'vlan', 'description', 'attrs']);
  assert.deepEqual(SCHEMA.interface, ['id', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'description', 'attrs']);
  assert.deepEqual(SCHEMA.logical, ['id', 'type', 'label', 'dhcp', 'ip', 'vrf', 'mac', 'members', 'vlan', 'source', 'destination', 'description', 'attrs']);
  assert.ok(!('child' in SCHEMA) && !('loopback' in SCHEMA));
  assert.deepEqual(SCHEMA.linkEnd, ['device', 'interface', 'vlans']);
  assert.ok(SCHEMA.link.includes('medium') && SCHEMA.link.includes('speed'));
  for (const f of exampleNames) {
    const r = load2(example(f));
    for (const n of r.model.networks) assert.deepEqual(Object.keys(n).sort(), ['attrs', 'cidr', 'description', 'id', 'label', 'line', 'vlan'], f);
    assert.ok(!/^\s*(members|kind: (subnet|vlan|vni|vrf))\b/m.test(example(f)), f);
  }
});

test('VRF is assigned on interfaces (loopbacks included), not on networks', () => {
  const r = ok('netatlas: 1\ndevices:\n  - id: pe\n    logical_interfaces:\n      - {id: lo1, type: loopback, ip: 10.9.9.1/32, vrf: red}\n    interfaces:\n      - {id: e0, ip: 10.1.0.1/24, vrf: red}\n      - {id: e1, ip: 10.1.0.2/24}\nnetworks:\n  - {id: n, cidr: 10.1.0.0/24}\n');
  assert.deepEqual(r.model.devices[0].logical.concat(r.model.devices[0].interfaces).map((i) => i.vrf), ['red', 'red', undefined]);
  assert.match(JSON.stringify(panels.detailsFor(r.model, 'iface:pe:e0')), /"vrf"[^\]]*\]?[^\]]*red/);
  // membership is by prefix only; the VRF does not take part
  assert.deepEqual(matches(r.model, 'n'), ['pe:e0 10.1.0.1/24', 'pe:e1 10.1.0.2/24']);
});

test('group kind "floor" is accepted, "row" is not', () => {
  const r = ok('netatlas: 1\ngroups:\n  - {id: b, kind: building}\n  - {id: f2, kind: Floor, parent: b}\n');
  assert.equal(r.model.groups[1].kind, 'floor');
  assert.match(errorsOf('netatlas: 1\ngroups:\n  - {id: f2, kind: ROW}\n')[0], /group kind "row" is not accepted — write "kind: floor"/);
});

test('loopbacks stay logical: no physical-link properties, no cable', () => {
  const base = 'netatlas: 1\ndevices:\n  - id: a\n    logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.1/32SPEED}]\n    interfaces: [e0]\n  - id: b\n    interfaces: [e0]\n';
  assert.match(errorsOf(base.replace('SPEED', ', speed: 1G'))[0], /"speed" is not part of the format/);
  assert.match(errorsOf(base.replace('SPEED', '') + 'links:\n  - {id: l, a: "a:lo0", b: "b:e0"}\n')[0], /"a:lo0" is a loopback, not a physical interface/);
  assert.doesNotMatch(JSON.stringify(panels.detailsFor(ok(base.replace('SPEED', '')).model, 'iface:a:lo0')), /cable|speed|media/);
});
