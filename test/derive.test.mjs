// "Configure once, derive elsewhere": network membership and interface VLANs
// are computed from addresses and each network's one prefix
// (model/derive.ts), the networks a cable carries are configured per link
// end, and keys that are not part of the format are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, derive, queries, panels, scene, state, load, example, exampleNames, byClass, byRef } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { SCHEMA, RETIRED } = load('yaml/schema.js');
const { layoutInput, layoutSignature } = load('layout/input.js');

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
/** a network as the model holds it, for the pure functions */
const n1 = (cidr) => [{ id: 'n', label: 'n', cidr, attrs: [], line: 0 }];

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
  - {id: loops, cidr: 10.255.0.0/24}
  - {id: loops6, cidr: "2001:db8:ffff::/48"}
`;

test('membership: a device is a member when one of its addresses lies in the network; listed once, with every match', () => {
  const { model: m } = ok(net);
  assert.deepEqual(members(m, 'lan'), ['r1', 'r2']);
  // r1 matches through two interfaces but appears once
  assert.deepEqual(matches(m, 'lan'), ['r1:eth0 10.1.0.1/24', 'r1:eth1 10.1.0.9/24', 'r2:eth0 10.1.0.2']);
  assert.deepEqual(members(m, 'lan6'), ['r1']);
  // loopbacks count, for IPv4 and IPv6, and are marked as loopbacks; each network has its one prefix
  assert.deepEqual(derive.networkMembers(m, 'loops')[0].matches.map((x) => [x.iface, x.loopback, x.address]), [['lo0', true, '10.255.0.1/32']]);
  assert.deepEqual(derive.networkMembers(m, 'loops6')[0].matches.map((x) => [x.iface, x.loopback, x.address]), [['lo0', true, '2001:db8:ffff::1/128']]);
  // devices without addresses have no membership
  assert.ok(!m.networks.some((n) => members(m, n.id).includes('sw')));
  assert.deepEqual(derive.deviceNetworks(m, 'r1'), ['lan', 'lan6', 'loops', 'loops6']);
  assert.deepEqual(derive.interfaceNetworks(m, 'r1', 'eth0'), ['lan', 'lan6']);
  assert.deepEqual(derive.interfaceNetworks(m, 'r1', 'eth2'), []);
  assert.equal(typeof m.networks[0].cidr, 'string');
});

test('membership: an interface with DHCP on and no known address makes its device a member of nothing', () => {
  const { model: m } = ok(net.replace('{id: eth2}', '{id: eth2, dhcp: true}').replace('interfaces: [p1, p2]', 'interfaces: [{id: p1, dhcp: true}, p2]'));
  assert.deepEqual(derive.interfaceNetworks(m, 'r1', 'eth2'), []);
  assert.deepEqual(derive.deviceNetworks(m, 'sw'), []);
  for (const n of m.networks) assert.ok(!members(m, n.id).includes('sw'), n.id);
});

test('membership: the network prefix is the authority; the interface\'s own prefix length is ignored', () => {
  const { model: m } = ok(net);
  // 10.1.0.2 (no length) and 10.1.1.2/16 (shorter length, but outside 10.1.0.0/24)
  assert.ok(matches(m, 'lan').includes('r2:eth0 10.1.0.2'));
  assert.ok(!matches(m, 'lan').some((x) => x.startsWith('r2:eth1')));
  const inside = (addr, cidr) => derive.containingNetworks(addr, n1(cidr)).length === 1;
  assert.ok(inside('10.1.0.200/32', '10.1.0.0/24'));
  assert.ok(inside('10.1.0.200/8', '10.1.0.0/24'), 'a wider interface mask still matches');
  assert.ok(inside('10.1.0.200/30', '10.1.0.0/24'), 'a narrower interface mask still matches');
  assert.ok(!inside('10.1.1.1/16', '10.1.0.0/24'), 'same /16, but outside the network\'s /24');
});

test('membership: prefix lengths and boundaries, IPv4', () => {
  const inside = (addr, cidr) => derive.containingNetworks(addr, n1(cidr)).length === 1;
  assert.ok(inside('10.1.0.0', '10.1.0.0/24') && inside('10.1.0.255', '10.1.0.0/24'), 'first and last address');
  assert.ok(!inside('10.0.255.255', '10.1.0.0/24') && !inside('10.1.1.0', '10.1.0.0/24'));
  assert.ok(inside('192.0.2.5', '192.0.2.4/30') && !inside('192.0.2.8', '192.0.2.4/30'), 'a prefix that is not on a byte boundary');
  assert.ok(inside('192.0.2.1', '192.0.2.1/32') && !inside('192.0.2.2', '192.0.2.1/32'), '/32 matches one address');
  assert.ok(inside('192.0.2.0', '192.0.2.0/31') && inside('192.0.2.1', '192.0.2.0/31') && !inside('192.0.2.2', '192.0.2.0/31'), '/31');
  assert.ok(inside('8.8.8.8', '0.0.0.0/0'), '/0 contains every IPv4 address');
  assert.ok(inside('10.1.0.77', '10.1.0.9/24'), 'host bits in the configured prefix are ignored: the network is the /24');
  assert.ok(!inside('10.1.0.1', undefined), 'a network without a (valid) prefix contains nothing');
});

test('membership: IPv6, and no matching across address families', () => {
  const inside = (addr, cidr) => derive.containingNetworks(addr, n1(cidr)).length === 1;
  assert.ok(inside('2001:db8:1::1/64', '2001:db8:1::/64'));
  assert.ok(inside('2001:DB8:1:0:ffff:ffff:ffff:ffff', '2001:db8:1::/64') && !inside('2001:db8:2::1', '2001:db8:1::/64'));
  assert.ok(inside('2001:db8::1', '2001:db8::1/128') && !inside('2001:db8::2', '2001:db8::1/128'));
  assert.ok(inside('2001:db8:0:1200::1', '2001:db8:0:1000::/52') && !inside('2001:db8:0:2000::1', '2001:db8:0:1000::/52'), 'a /52');
  assert.ok(inside('fe80::1', '::/0'));
  assert.ok(!inside('10.0.0.1', '::/0') && !inside('::1', '0.0.0.0/0'), 'IPv4 and IPv6 never match each other');
  assert.ok(!inside('::ffff:10.1.0.1', '10.1.0.0/24'), 'an IPv4-mapped IPv6 address is an IPv6 address');
});

test('membership: invalid or incomplete addresses belong to no network', () => {
  const all = ['10.1.0.0/24', '::/0', '0.0.0.0/0'].map((c, i) => ({ id: 'n' + i, label: 'n', cidr: c, attrs: [], line: 0 }));
  for (const bad of ['', 'dhcp', '10.1.0', '10.1.0.256', '10.1.0.1/', '10.1.0.1/33', '10.1.0.1/x', '10.1.0.1/24/24', '2001:db8::1/129', '2001:db8:::1', 'fe80::1%eth0', '10.1.0.01']) {
    assert.deepEqual(derive.containingNetworks(bad, all), [], JSON.stringify(bad));
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

test('a network has exactly one prefix: missing, empty, several or invalid is an error, and nothing is dropped', () => {
  const add = (entry) => net + '  - ' + entry + '\n';
  assert.deepEqual(errorsOf(add('{id: bad}')), ['network "bad" needs its IP network: add "cidr:" with one prefix (e.g. 192.0.2.0/24 or 2001:db8::/64)']);
  assert.deepEqual(errorsOf(add('{id: bad, cidr: []}')), ['a network needs exactly one prefix, e.g. cidr: 192.0.2.0/24 (not an empty list)']);
  const two = load2(add('{id: bad, cidr: [10.9.0.0/24, "2001:db8:9::/64"]}'));
  assert.deepEqual(two.errors.map((e) => e.message), ['"cidr" lists 2 prefixes, but a network has exactly one: keep one here (written without brackets, e.g. cidr: 192.0.2.0/24) and make a separate network for each other prefix']);
  assert.equal(two.errors[0].path, 'networks.bad.cidr');
  // even a one-element list is a list
  assert.match(errorsOf(add('{id: bad, cidr: [10.9.0.0/24]}'))[0], /lists 1 prefixes, but a network has exactly one/);
  assert.match(errorsOf(add('{id: bad, prefixes: [10.9.0.0/24]}')).join('\n'), /"prefixes" is not part of the format — a network has exactly one prefix: write it as "cidr: 10.0.0.0\/24"/);
  // invalid prefixes
  assert.deepEqual(errorsOf(add('{id: bad, cidr: 10.1.0.0}')), ['invalid network prefix: "10.1.0.0" needs a prefix length, e.g. 10.1.0.0/32']);
  assert.deepEqual(errorsOf(add('{id: bad, cidr: 10.1.0.0/40}')), ['invalid network prefix: prefix length "/40" is invalid for IPv4 (0–32)']);
  assert.deepEqual(errorsOf(add('{id: bad, cidr: banana}')), ['invalid network prefix: "banana" is not a valid IPv4 or IPv6 address']);
  // an invalid draft network is kept, with no prefix and no members; the file is written back unchanged
  const r = load2(add('{id: bad, cidr: [10.1.0.0/24, 10.2.0.0/24]}'));
  const bad = r.model.index.networks.get('bad');
  assert.equal(bad.cidr, undefined);
  assert.deepEqual(members(r.model, 'bad'), []);
  const text = add('{id: bad, cidr: [10.1.0.0/24, 10.2.0.0/24]}');
  assert.equal(doc(text).exportText(), text);
  // host bits: a warning, the network is the whole prefix
  const hb = ok(add('{id: hb, cidr: 10.1.0.9/24}'));
  assert.ok(hb.warnings.some((w) => /10\.1\.0\.9\/24 has bits set beyond \/24/.test(w.message)));
  assert.deepEqual(members(hb.model, 'hb'), ['r1', 'r2']);
});

test('overlapping networks: an address belongs to every network containing it; the same prefix twice is a warning', () => {
  const { model: m, warnings } = ok(net + '  - {id: super, cidr: 10.0.0.0/8}\n');
  assert.deepEqual(members(m, 'super'), ['r1', 'r2']);
  assert.deepEqual(matches(m, 'super'), ['r1:eth0 10.1.0.1/24', 'r1:eth1 10.1.0.9/24', 'r1:lo0 10.255.0.1/32', 'r2:eth0 10.1.0.2', 'r2:eth1 10.1.1.2/16']);
  assert.deepEqual(derive.interfaceAddresses(m, 'r1', 'eth1')[0].networks, ['lan', 'super']);
  assert.ok(!warnings.some((w) => /same prefix/.test(w.message)), 'a sub- and a supernet are two networks');
  const dup = ok(net + '  - {id: lan-copy, cidr: 10.1.0.0/24}\n  - {id: lan-copy2, cidr: 10.1.0.5/24}\n');
  assert.deepEqual(dup.warnings.filter((w) => /same prefix/.test(w.message)).map((w) => w.message), [
    'network "lan-copy" has the same prefix as network "lan"; both list the same members',
    'network "lan-copy2" has the same prefix as network "lan"; both list the same members',
  ]);
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
  const { model: m, warnings } = ok(net.replace('{id: eth1, ip: 10.1.0.9/24}', '{id: eth1, ip: [10.1.0.9/24, 10.2.0.9/24, "2001:db8:1::9/64"]}') + '  - {id: lan2, cidr: 10.2.0.0/24, vlan: 20}\n');
  assert.deepEqual(vlanOf(m, 'r1', 'eth1'), [10, 20, 'none']);
  assert.equal(derive.interfaceVlanText(derive.interfaceAddresses(m, 'r1', 'eth1')), 'VLAN 10, VLAN 20');
  assert.ok(!warnings.some((w) => /ambiguous/.test(w.message)), 'different addresses in different VLANs are not an ambiguity');
});

test('interface VLAN: overlapping networks with conflicting VLANs are an explicit ambiguity, nothing is chosen', () => {
  const r = ok(net + '  - {id: part, cidr: 10.1.0.0/28, vlan: 99}\n');
  // 10.1.0.1 and 10.1.0.9 lie in both; 10.1.0.2 too
  assert.deepEqual(vlanOf(r.model, 'r1', 'eth0'), ['ambiguous:10/99', 'none']);
  assert.match(derive.interfaceVlanText(derive.interfaceAddresses(r.model, 'r1', 'eth0')), /^ambiguous: VLAN 10 or 99$/);
  const w = r.warnings.filter((x) => /ambiguous/.test(x.message));
  assert.equal(w.length, 3);
  assert.match(w[0].message, /the VLAN of 10\.1\.0\.1\/24 on r1:eth0 is ambiguous: it lies in "lan" \(VLAN 10\) and "part" \(VLAN 99\); no VLAN is derived for it/);
  assert.equal(w[0].path, 'devices.r1.interfaces[0].ip');
  // overlapping networks that agree, or where only one defines a VLAN, are not ambiguous
  assert.deepEqual(vlanOf(ok(net + '  - {id: part, cidr: 10.1.0.0/28, vlan: 10}\n').model, 'r1', 'eth0'), [10, 'none']);
  assert.deepEqual(vlanOf(ok(net + '  - {id: super, cidr: 10.0.0.0/8}\n').model, 'r1', 'eth0'), [10, 'none']);
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
  assert.match(d.exportText(), /\{id: lan, cidr: 10\.9\.0\.0\/24, vlan: 11\}/, 'one value, not a list');
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
  assert.equal(queries.search(m, '2001:db8:ffff::/48')[0].ref, 'network:loops6');
  assert.deepEqual(layoutInput(m).networks.map((n) => [n.id, n.members]), [['lan', ['r1', 'r2']], ['lan6', ['r1']], ['loops', ['r1']], ['loops6', ['r1']]]);
  // an address change matters for the layout only when it changes membership
  const sig = (t) => layoutSignature(layoutInput(ok(t).model));
  assert.equal(sig(net.replace('10.1.0.9/24', '10.1.0.10/24')), sig(net));
  assert.notEqual(sig(net.replace('ip: 10.1.0.2}', 'ip: 10.7.0.2}')), sig(net));
});

// ---------------------------------------------------------- link-end networks

const lk = `netatlas: 1
devices:
  - id: a
    interfaces: [e0, e1, e2]
  - id: b
    interfaces: [e0, e1, e2]
networks:
  - {id: users, label: Users, cidr: 10.1.0.0/24, vlan: 10}
  - {id: servers, label: Servers, cidr: 10.2.0.0/24, vlan: 20}
  - {id: mgmt, label: Management, cidr: 10.9.0.0/24}
links:
  - {id: multi, a: {device: a, interface: e0, networks: [servers, users, mgmt]}, b: {device: b, interface: e0, networks: [users, servers, mgmt]}, medium: fiber, speed: 10G}
  - {id: access, a: {device: a, interface: e1, networks: users}, b: {device: b, interface: e1, networks: [users]}}
  - {id: plain, a: "a:e2", b: "b:e2"}
`;

test('link ends: networks are stored per end by id; any network can be assigned, with or without a VLAN; none = nothing assumed', () => {
  const r = ok(lk);
  assert.deepEqual(r.warnings, []);
  const [multi, access, plain] = r.model.links;
  assert.deepEqual([multi.a.networks, multi.b.networks], [['servers', 'users', 'mgmt'], ['users', 'servers', 'mgmt']]);
  assert.deepEqual([access.a.networks, access.b.networks], [['users'], ['users']], 'a single value is a one-element list');
  assert.deepEqual([plain.a.networks, plain.b.networks], [[], []], 'nothing configured, nothing assumed');
  assert.equal(derive.linkEndNetworksText(r.model, multi.a.networks), 'Servers, Users, Management');
  assert.equal(derive.linkEndNetworksText(r.model, plain.a.networks), 'No network');
  assert.deepEqual([multi.medium, multi.speed], ['fiber', '10G']);
});

test('link ends: carriage is not membership, and several networks are not called a trunk', () => {
  const r = ok(lk);
  // no device has an address in any network: assigning networks to cable ends makes no one a member
  for (const n of r.model.networks) assert.deepEqual(members(r.model, n.id), [], n.id);
  const s = new state.Session(r.model);
  const all = JSON.stringify(s.render().root) + JSON.stringify(panels.detailsFor(r.model, 'link:multi')) + panels.tooltipFor(r.model, 'link:multi').join('\n');
  assert.ok(!/trunk/i.test(all), 'no "trunk" anywhere');
  const { linkNetworkLabel } = load('diagram/physical.js');
  // the cable label names the networks (sorted by name, so the order in the file changes nothing)
  assert.deepEqual(r.model.links.map((l) => linkNetworkLabel(r.model, l)), ['Management, Servers, Users', 'Users', '']);
});

test('link ends: a difference between the ends is a warning; neither end is changed', () => {
  const text = lk.replace('b: {device: b, interface: e0, networks: [users, servers, mgmt]}', 'b: {device: b, interface: e0, networks: [users]}').replace('b: "b:e2"', 'b: {device: b, interface: e2, networks: [mgmt]}');
  const r = ok(text);
  assert.deepEqual(r.warnings.map((w) => [w.path, w.message]), [
    ['links.multi', 'the two ends of this link carry different networks (only at end A: Servers, Management)'],
    ['links.plain', 'the two ends of this link carry different networks (only at end B: Management)'],
  ]);
  assert.deepEqual([r.model.links[0].a.networks, r.model.links[0].b.networks], [['servers', 'users', 'mgmt'], ['users']]);
  assert.deepEqual(derive.networkMismatch(['a', 'b'], ['b', 'a']), null);
  assert.deepEqual(derive.networkMismatch([], []), null);
  assert.deepEqual(derive.networkMismatch(['a'], []), { onlyA: ['a'], onlyB: [] });
  // both ends are written back as they were (a long line may be re-wrapped)
  const out = doc(text).exportText();
  for (const want of ['a: {device: a, interface: e0, networks: [servers, users, mgmt]}', 'b: {device: b, interface: e0, networks: [users]}', 'b: {device: b, interface: e2, networks: [mgmt]}']) {
    assert.ok(out.includes(want), want);
  }
});

test('link ends: network references are validated per end (unknown, repeated); unknown ones are reported, not drawn', () => {
  const r = load2(lk.replace('networks: [servers, users, mgmt]}, b', 'networks: [servers, voice, servers]}, b'));
  assert.deepEqual(r.errors.map((e) => [e.path, e.message]), [
    ['links.multi.a.networks[2]', 'network "servers" is listed twice on this end'],
    ['links.multi.a.networks[1]', 'unknown network "voice" (known: users, servers, mgmt)'],
  ]);
  assert.deepEqual(r.model.links[0].a.networks, ['servers']);
  assert.match(errorsOf(lk.replace('networks: users}', 'networks: user}'))[0], /unknown network "user" — did you mean "users"\?/);
  assert.match(errorsOf(lk.replace('a: "a:e2"', 'a: {device: a, interface: e2, network: users}'))[0], /unknown key "network" — did you mean "networks"\?/);
});

test('link-end VLAN IDs are not part of the format: rejected with what to write instead', () => {
  const text = lk.replace('a: "a:e2"', 'a: {device: a, interface: e2, vlans: [10, 20]}');
  const r = load2(text);
  assert.deepEqual(r.errors.map((e) => e.message), ['"vlans" is not part of the format — a link end lists the networks the cable carries there, not VLAN IDs: replace "vlans:" by "networks: [network ids]" (the VLAN ID belongs on the network, as its "vlan:")']);
  // the value is not converted or dropped: it is written back as it was
  assert.deepEqual(r.model.links[2].a.networks, []);
  assert.ok(doc(text).exportText().includes('a: {device: a, interface: e2, vlans: [10, 20]}'));
});

test('editing link-end networks: only the edited end is written; short form in, short form out', () => {
  const d = doc(lk);
  const p = ['links', 2, 'a'];
  assert.deepEqual(d.endNetworks(p), []);
  assert.ok(d.addEndNetwork(p, 'servers'));
  assert.ok(d.addEndNetwork(p, 'mgmt'));
  assert.match(d.exportText(), /\{id: plain, a: \{device: a, interface: e2, networks: \[servers, mgmt\]\}, b: "b:e2"\}/);
  assert.deepEqual(d.result.model.links[2].b.networks, [], 'the other end is untouched');
  assert.ok(d.warnings.some((w) => /only at end A: Servers, Management/.test(w.message)));
  assert.ok(d.addEndNetwork(p, 'mgmt'), 'already there: nothing to do');
  assert.equal(d.canUndo(), 'Assign network');
  d.removeEndNetwork(p, 'servers');
  assert.match(d.exportText(), /a: \{device: a, interface: e2, networks: \[mgmt\]\}/);
  d.removeEndNetwork(p, 'mgmt');
  assert.match(d.exportText(), /\{id: plain, a: a:e2, b: "b:e2"\}/, 'no network left: back to the short form, no empty list');
  assert.ok(d.valid && !d.warnings.length);
  // an end without a device cannot get networks
  const e = doc('netatlas: 1\ndevices:\n  - id: a\nlinks:\n  - {id: l}\n');
  assert.equal(e.addEndNetwork(['links', 0, 'a'], 'x'), false);
  assert.equal(e.exportText(), 'netatlas: 1\ndevices:\n  - id: a\nlinks:\n  - {id: l}\n');
  // changing the device of an end keeps that end's networks
  d.addEndNetwork(['links', 2, 'b'], 'users');
  d.setEndpoint(['links', 2, 'b'], 'a', '');
  assert.match(d.exportText(), /b: \{device: a, networks: \[users\]\}/);
});

test('renaming a network updates the link ends that carry it; deleting it reports them', () => {
  const d = doc(lk);
  assert.equal(d.renameEntity('network', 0, 'staff'), 4);
  assert.deepEqual(d.result.model.links.map((l) => [l.a.networks, l.b.networks]), [
    [['servers', 'staff', 'mgmt'], ['staff', 'servers', 'mgmt']],
    [['staff'], ['staff']],
    [[], []],
  ]);
  assert.ok(d.valid);
  assert.deepEqual(d.references('network', 'servers').map((p) => p.join('.')), ['links.0.a.networks.0', 'links.0.b.networks.1']);
  d.deleteEntity('network', 1);
  assert.deepEqual(d.errors.map((e) => e.message), ['unknown network "servers" (known: staff, mgmt)', 'unknown network "servers" (known: staff, mgmt)']);
});

test('physical view, selection and details show per-end networks and the difference between the ends', () => {
  const m = ok(lk.replace('b: {device: b, interface: e0, networks: [users, servers, mgmt]}', 'b: {device: b, interface: e0, networks: [users]}')).model;
  const s = new state.Session(m);
  const v = s.render().root;
  const cable = (id) => byRef(v, 'link:' + id).find((n) => scene.hasClass(n, 'cable'));
  assert.ok(scene.hasClass(cable('multi'), 'net-mismatch'));
  assert.ok(!scene.hasClass(cable('access'), 'net-mismatch') && !scene.hasClass(cable('plain'), 'net-mismatch'));
  assert.equal(byClass(v, 'net-warn').length, 1);
  const tip = panels.tooltipFor(m, 'link:multi').join('\n');
  assert.match(tip, /A: Servers, Users, Management {2}\| {2}B: Users/);
  assert.match(tip, /the two ends carry different networks/);
  assert.ok(!/network/i.test(panels.tooltipFor(m, 'link:plain').join('\n')), 'nothing configured: nothing shown');
  const det = scene.textOf(panels.detailsFor(m, 'link:multi'));
  assert.match(det, /carries \nServers\n, \nUsers\n, \nManagement/);
  assert.match(det, /the ends differ — only at end A: Servers, Management/);
  assert.match(scene.textOf(panels.detailsFor(m, 'link:plain')), /no network/);
  // the network's details list the cables that carry it (and at which end), separately from its members
  const nd = scene.textOf(panels.detailsFor(m, 'network:servers'));
  assert.match(nd, /Carried on cables \(1\)/);
  assert.match(nd, /a:e0 ⟷ b:e0 \(end A only\)/);
  // selection: a network highlights the cables that carry it; a cable relates the networks it carries
  assert.ok(queries.relatedRefs(m, 'network:users').has('link:access') && queries.relatedRefs(m, 'network:users').has('iface:a:e1'));
  assert.ok(!queries.relatedRefs(m, 'network:users').has('link:plain'));
  assert.ok(queries.relatedRefs(m, 'link:multi').has('network:mgmt'));
  assert.ok(queries.selectionContext(m, 'network:mgmt').related.has('link:multi'));
  assert.ok(queries.selectionContext(m, 'link:access').related.has('network:users'));
});

test('a virtual interface: the ports carrying its networks are derived from the link ends', () => {
  const text = `netatlas: 1
devices:
  - id: sw
    interfaces: [p1, p2, p3]
    logical_interfaces:
      - {id: Vlan10, type: virtual, ip: 10.1.0.1/24}
      - {id: Vlan20, type: virtual, vlan: 20}
      - {id: Po1, type: virtual, members: [p3]}
  - id: h
    interfaces: [e0, e1, e2]
networks:
  - {id: users, cidr: 10.1.0.0/24, vlan: 10}
  - {id: servers, cidr: 10.2.0.0/24, vlan: 20}
links:
  - {id: l1, a: {device: sw, interface: p1, networks: [users]}, b: {device: h, interface: e0, networks: [users]}}
  - {id: l2, a: {device: sw, interface: p2, networks: [users, servers]}, b: {device: h, interface: e1, networks: [users, servers]}}
  - {id: l3, a: "sw:p3", b: "h:e2"}
`;
  const m = ok(text).model;
  const ix = m.index.interfaces;
  // in its network through its address; through its VLAN (the networks of that VLAN); a bond without either is in none
  assert.deepEqual(derive.interfaceCarriedNetworks(m, ix.get('sw:Vlan10')), ['users']);
  assert.deepEqual(derive.interfaceCarriedNetworks(m, ix.get('sw:Vlan20')), ['servers']);
  assert.deepEqual(derive.interfaceCarriedNetworks(m, ix.get('sw:Po1')), []);
  const ports = (id) => derive.interfaceNetworkPorts(m, ix.get(id)).map((p) => `${p.iface}/${p.link}/${p.network}`);
  assert.deepEqual(ports('sw:Vlan10'), ['p1/l1/users', 'p2/l2/users']);
  assert.deepEqual(ports('sw:Vlan20'), ['p2/l2/servers']);
  assert.deepEqual(derive.associatedInterfaces(m, ix.get('sw:p2')).sort(), ['Vlan10', 'Vlan20']);
  assert.match(panels.associationText(m, ix.get('sw:Vlan20')), /VLAN 20 · ports carrying its networks: p2/);
  // a physical port's own address does not put its network on the cable (containment is not carriage)
  assert.deepEqual(derive.portsCarryingNetworks(m, 'h', ['users']).map((p) => p.iface), ['e0', 'e1']);
});

test('details and logical view use derived membership and derived interface VLANs', () => {
  const { model: m } = ok(net);
  const netDet = JSON.stringify(panels.detailsFor(m, 'network:lan'));
  assert.match(netDet, /Members \(2\)/);
  assert.match(netDet, /10\.1\.0\.9\/24/);
  assert.match(netDet, /IP network/);
  assert.match(JSON.stringify(panels.detailsFor(m, 'iface:r1:eth0')), /VLAN 10/);
  assert.match(JSON.stringify(panels.detailsFor(m, 'iface:r2:eth1')), /no network/);
  assert.deepEqual(panels.tooltipFor(m, 'network:lan'), ['lan', 'VLAN 10 · 10.1.0.0/24', '2 members']);
  const s = new state.Session(m);
  s.setView('logical');
  const v = s.render().root;
  assert.equal(byClass(v, 'member').length, 5, 'lan: r1, r2; lan6, loops, loops6: r1');
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
  assert.deepEqual(SCHEMA.linkEnd, ['device', 'interface', 'networks']);
  assert.deepEqual(SCHEMA.endpoint, ['device', 'interface']);
  assert.ok(!SCHEMA.relation.includes('network') && SCHEMA.relation.includes('over'));
  assert.ok(SCHEMA.link.includes('medium') && SCHEMA.link.includes('speed'));
  for (const f of exampleNames) {
    const r = load2(example(f));
    for (const n of r.model.networks) {
      assert.deepEqual(Object.keys(n).sort(), ['attrs', 'cidr', 'description', 'id', 'label', 'line', 'vlan'], f);
      assert.equal(typeof n.cidr, 'string', `${f}: ${n.id} has one prefix`);
    }
    assert.ok(!/^\s*(members|kind: (subnet|vlan|vni|vrf))\b/m.test(example(f)), f);
    assert.ok(!/vlans:|role:|^\s+network:/m.test(example(f)), f + ': no retired key');
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
