// VLANs on physical ports: one VLAN makes an access port (untagged), several
// a trunk (tagged, except an optional native VLAN); a port without VLANs on a
// router or a Layer 3 switch ("routed: true") is a routed port; a switch's
// ports need their VLANs. An aggregate holds the VLANs of its members. A
// VLAN interface binds to every bridge port of its VLAN by itself. The
// checks compare what the two ends of a cable carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, derive, queries, panels, scene, state, load, byClass, byRef } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const checks = load('analysis/checks.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const ok = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.path + ': ' + e.message), []);
  return r;
};
const errorsOf = (text) => validate.loadModel(text).errors.map((e) => `${e.path}: ${e.message}`);
const warningsOf = (text) => validate.loadModel(text).warnings.map((e) => `${e.path}: ${e.message}`);
const findings = (text, id) => validate.loadModel(text).findings.filter((f) => !id || f.check === id);

// a Layer 3 switch a (trunk with a native VLAN, access ports, a routed uplink, a LAG trunk, two VLAN interfaces),
// a Layer 2 switch b (the same, and a trunk to the router), a router r (a routed port, and one with subinterfaces) and a server
const base = `netatlas: 2
devices:
  - id: a
    type: switch
    layer3: true
    igmp_mld_snooping: {10: enabled, 20: disabled}
    interfaces:
      - {id: e0, vlans: [10, 20], native: 10}
      - {id: e1, vlans: 10}
      - {id: e2, vlans: 20}
      - {id: e3, routed: true, ip: 10.9.0.1/30}
      - e4
      - e5
    logical_interfaces:
      - {id: Po1, type: virtual, members: [e4, e5], vlans: [10, 20]}
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.1/24}
      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24}
  - id: b
    type: switch
    igmp_mld_snooping: {10-20: enabled}
    interfaces:
      - {id: e0, vlans: [10, 20], native: 10}
      - {id: e1, vlans: 10}
      - {id: e3, vlans: [10, 20]}
      - e4
      - e5
    logical_interfaces:
      - {id: Po1, type: virtual, members: [e4, e5], vlans: [10, 20]}
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}
  - id: r
    type: router
    interfaces:
      - {id: g0, ip: 10.9.0.2/30}
      - g1
    logical_interfaces:
      - {id: g1.10, type: virtual, ip: 10.1.0.3/24}
      - {id: g1.20, type: virtual, ip: 10.2.0.3/24}
  - id: h
    type: server
    interfaces: [{id: eth0, ip: 10.2.0.50/24}]
networks:
  - {id: users, label: Users, cidr: 10.1.0.0/24, vlan: 10}
  - {id: servers, label: Servers, cidr: 10.2.0.0/24, vlan: 20}
  - {id: transit, cidr: 10.9.0.0/30}
links:
  - {id: trunk, a: "a:e0", b: "b:e0", speed: 10G}
  - {id: access, a: "a:e1", b: "b:e1"}
  - {id: srv, a: "a:e2", b: "h:eth0"}
  - {id: up, a: "a:e3", b: "r:g0"}
  - {id: lag1, a: "a:e4", b: "b:e4"}
  - {id: lag2, a: "a:e5", b: "b:e5"}
  - {id: stick, a: "b:e3", b: "r:g1"}
`;
const rep = (a, b, text = base) => {
  assert.ok(text.includes(a), a);
  return text.replace(a, b);
};
// b's ports (to change one of b's without touching a's identical lines)
const B_E0 = '      - {id: e0, vlans: [10, 20], native: 10}\n      - {id: e1, vlans: 10}\n      - {id: e3';
const bE0 = (line) => rep(B_E0, `      - ${line}\n      - {id: e1, vlans: 10}\n      - {id: e3`);
const bE1 = (line) => rep('      - {id: e1, vlans: 10}\n      - {id: e3', `      - ${line}\n      - {id: e3`);
// (the fields that are set: a port without a native VLAN has none)
const l2 = (m, k) => {
  const x = derive.portL2(m, ...k.split(':'));
  return x && Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));
};

// ------------------------------------------------------------ the model

test('the port model: access, trunk with or without a native VLAN, routed, host; a LAG member takes the aggregate’s VLANs', () => {
  const r = ok(base);
  assert.deepEqual([r.warnings, r.findings], [[], []]);
  const m = r.model;
  assert.deepEqual(m.index.interfaces.get('a:e0').vlans, [{ from: 10, to: 10 }, { from: 20, to: 20 }]);
  assert.equal(m.index.interfaces.get('a:e0').native, 10);
  assert.equal(m.index.interfaces.get('a:e3').routed, true);
  assert.deepEqual(l2(m, 'a:e0'), { kind: 'trunk', vlans: [10, 20], native: 10, untagged: 10, tagged: [20] });
  assert.deepEqual(l2(m, 'a:e1'), { kind: 'access', vlans: [10], untagged: 10, tagged: [] });
  assert.deepEqual(l2(m, 'b:e3'), { kind: 'trunk', vlans: [10, 20], tagged: [10, 20] }, 'without a native VLAN every VLAN is tagged');
  assert.deepEqual(l2(m, 'a:e3'), { kind: 'routed', vlans: [], tagged: [] });
  assert.deepEqual(l2(m, 'r:g0'), { kind: 'routed', vlans: [], tagged: [] }, 'a router port without VLANs is routed');
  assert.deepEqual(l2(m, 'r:g1'), { kind: 'routed', vlans: [10, 20], tagged: [10, 20] }, 'a routed port tags its subinterfaces’ VLANs');
  assert.deepEqual(l2(m, 'a:e4'), { kind: 'trunk', vlans: [10, 20], tagged: [10, 20], lag: 'Po1' });
  assert.deepEqual(l2(m, 'a:Po1'), { kind: 'trunk', vlans: [10, 20], tagged: [10, 20] });
  assert.equal(l2(m, 'h:eth0').kind, 'host', 'hosts are unaffected');
  assert.ok(derive.isBridgePort(l2(m, 'a:e0')) && derive.isBridgePort(l2(m, 'a:e4')) && !derive.isBridgePort(l2(m, 'a:e3')) && !derive.isBridgePort(l2(m, 'r:g1')));
  // subinterfaces by name: "<port>.<n>"
  assert.equal(derive.subinterfaceParent(m, m.index.interfaces.get('r:g1.10')), 'g1');
  assert.deepEqual(derive.subinterfacesOf(m, 'r', 'g1').map((i) => i.id), ['g1.10', 'g1.20']);
  assert.equal(derive.lagOf(m, 'a', 'e5'), 'Po1');
  // IDs and ranges
  assert.deepEqual(ok(rep('{id: e2, vlans: 20}', '{id: e2, vlans: [20, 100-102]}')).model.index.interfaces.get('a:e2').vlans, [{ from: 20, to: 20 }, { from: 100, to: 102 }]);
  assert.deepEqual(derive.vlanIds([{ from: 3, to: 5 }, { from: 1, to: 1 }, { from: 4, to: 6 }]), [1, 3, 4, 5, 6]);
  assert.equal(derive.vlanRangesText([30, 20, 100, 101, 102, 199, 1]), '1,20,30,100-102,199');
  // the link ends hold no tagging any more
  assert.deepEqual(Object.keys(m.links[0].a).sort(), ['device', 'iface']);
});

test('badges and diagram tags: "Access · VLAN 10", "Trunk · … (native 10)", "Routed"; "A 10", "T 10,20 · N 10"', () => {
  const m = ok(base).model;
  const t = (k) => [derive.portBadgeText(l2(m, k)), derive.portTagText(l2(m, k))];
  assert.deepEqual(t('a:e1'), ['Access · VLAN 10', 'A 10']);
  assert.deepEqual(t('a:e0'), ['Trunk · 10, 20 (native 10)', 'T 10,20 · N 10']);
  assert.deepEqual(t('b:e3'), ['Trunk · 10, 20', 'T 10,20']);
  assert.deepEqual(t('a:e3'), ['Routed', ''], 'a plain routed port has no diagram tag');
  assert.deepEqual(t('r:g1'), ['Routed · tagged 10, 20', 'R · T 10,20']);
  // ranges with an en dash in the badge, as in the Edit panel
  const big = ok(rep('{id: e0, vlans: [10, 20], native: 10}', '{id: e0, vlans: [10, 20, 30-39], native: 10}', bE0('{id: e0, vlans: [10, 20, 30-39], native: 10}'))).model;
  assert.equal(derive.portBadgeText(l2(big, 'a:e0')), 'Trunk · 10, 20, 30–39 (native 10)');
  assert.equal(derive.portTagText(l2(big, 'a:e0')), 'T 10,20,30–39 · N 10');
  // the cable ends show their ports' tags; the networks a cable carries follow from both ends
  const ends = (id) => {
    const l = m.links.find((x) => x.id === id);
    return [derive.endTagText(m, l.a), derive.endTagText(m, l.b), derive.linkNetworks(m, l)];
  };
  assert.deepEqual(ends('trunk'), ['T 10,20 · N 10', 'T 10,20 · N 10', ['users', 'servers']]);
  assert.deepEqual(ends('srv'), ['A 20', '', ['servers']]);
  assert.deepEqual(ends('up'), ['', '', []]);
  assert.deepEqual(ends('stick'), ['T 10,20', 'R · T 10,20', ['users', 'servers']]);
  assert.deepEqual(ends('lag1'), ['T 10,20', 'T 10,20', ['users', 'servers']], 'a member’s cable carries the aggregate’s VLANs');
});

// ------------------------------------------------------------ validation

test('validation: a switch port needs its VLANs (or its aggregate does); the error is at the field until it is filled in', () => {
  assert.deepEqual(errorsOf(bE1('e1')), ['devices.b.interfaces[1].vlans: "e1" of switch "b" needs its VLANs: one VLAN (an access port) or several (a trunk)']);
  const r = validate.loadModel(bE1('e1'));
  assert.equal(r.errors[0].key, 'vlans');
  // a Layer 3 switch's port may be routed instead
  assert.match(errorsOf(rep('{id: e1, vlans: 10}', 'e1'))[0], /needs its VLANs: .*, or "routed: true" for a routed port/);
  // an aggregate of a switch: its members take its VLANs
  assert.deepEqual(errorsOf(rep('members: [e4, e5], vlans: [10, 20]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}', 'members: [e4, e5]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}')), [
    'devices.b.logical_interfaces[0].vlans: aggregate "Po1" of switch "b" needs its VLANs (its members e4, e5 take them): one VLAN (access) or several (a trunk)',
  ]);
  // routers: optional (a port without VLANs is routed); hosts: unaffected
  assert.deepEqual(errorsOf(base), []);
});

test('validation: LAG members, native VLANs, routed ports, VLAN IDs, addresses on bridge ports', () => {
  const at = (text) => errorsOf(text);
  assert.deepEqual(at(rep('      - e4\n      - e5\n    logical_interfaces:\n      - {id: Po1, type: virtual, members: [e4, e5], vlans: [10, 20]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.1/24}', '      - {id: e4, vlans: 10}\n      - e5\n    logical_interfaces:\n      - {id: Po1, type: virtual, members: [e4, e5], vlans: [10, 20]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.1/24}')), [
    'devices.a.interfaces[4].vlans: "e4" is a member of the aggregate "Po1": it takes the aggregate\'s VLANs — configure "vlans" on Po1 and delete it here',
  ]);
  assert.deepEqual(at(rep('{id: e2, vlans: 20}', '{id: e2, vlans: 20, native: 20}')), ['devices.a.interfaces[2].native: "e2" is an access port (one VLAN, 20), and its frames are untagged anyway: "native" is a trunk\'s (several VLANs) — delete it']);
  assert.deepEqual(at(rep('{id: e0, vlans: [10, 20], native: 10}', '{id: e0, vlans: [10, 20], native: 30}')), ['devices.a.interfaces[0].native: the native VLAN 30 is not one of the VLANs of "e0" (10, 20): add it to "vlans" or choose one of them']);
  assert.deepEqual(at(rep('{id: e2, vlans: 20}', '{id: e2, vlans: [0, 4095, 200-100, 10, 5-12]}')), [
    'devices.a.interfaces[2].vlans[0]: "0" is not a VLAN ID or range: use a whole number from 1 to 4094, or a range such as 100-199',
    'devices.a.interfaces[2].vlans[1]: "4095" is not a VLAN ID or range: use a whole number from 1 to 4094, or a range such as 100-199',
    'devices.a.interfaces[2].vlans[2]: "200-100" is not a VLAN ID or range: use a whole number from 1 to 4094, or a range such as 100-199',
    'devices.a.interfaces[2].vlans[4]: VLAN 10 listed twice in the VLANs of "e2"',
  ]);
  assert.match(at(rep('      - {id: e3, vlans: [10, 20]}', '      - {id: e3, routed: true}'))[0], /^devices\.b\.interfaces\[2\]\.routed: "b" is a Layer 2 switch: its ports are switch ports \(they need VLANs\)/);
  assert.match(at(rep('{id: e3, routed: true, ip: 10.9.0.1/30}', '{id: e3, routed: true, vlans: 10, ip: 10.9.0.1/30}'))[0], /"e3" has VLANs \(a switch port\) and is set to routed: a routed port has no VLANs/);
  assert.deepEqual(at(rep('{id: e2, vlans: 20}', '{id: e2, vlans: 20, ip: 10.2.0.9/24}')), ['devices.a.interfaces[2].ip: "e2" is a switch port (VLANs 20): it has no address of its own — put the address on the VLAN interface of its VLAN, or make it a routed port']);
  // the old link-end keys say where the VLANs went
  assert.deepEqual(at(rep('{id: access, a: "a:e1", b: "b:e1"}', '{id: access, a: {device: a, interface: e1, mode: access, untagged: 10}, b: "b:e1"}')), [
    'links.access.a.mode: unknown key "mode" (a port\'s VLANs are configured on the port: "vlans" on the device\'s interface (one VLAN: access; several: trunk))',
    'links.access.a.untagged: unknown key "untagged" (a port\'s VLANs are configured on the port: "vlans" (an access port\'s VLAN) and "native" (a trunk\'s untagged VLAN) on the device\'s interface)',
  ]);
});

test('router-on-a-stick: subinterfaces stay; a port is not both a bridge port and a subinterface parent for one VLAN', () => {
  ok(base);
  // a router port with VLANs is a bridge port (a BVI binds to it); then a subinterface for the same VLAN clashes
  assert.deepEqual(errorsOf(rep('      - g1\n', '      - {id: g1, vlans: [10, 30]}\n')), [
    'devices.r.logical_interfaces[0]: "g1.10" is a subinterface of "g1" in VLAN 10, but g1 is a switch port of VLAN 10 itself: a port is either a bridge port of a VLAN or the parent of a subinterface for it — remove the VLAN from g1, or use the VLAN interface of VLAN 10 instead',
  ]);
  // another VLAN on the same port is fine
  const m = ok(rep('      - g1\n', '      - {id: g1, vlans: 30}\n')).model;
  assert.equal(l2(m, 'r:g1').kind, 'access');
});

// ------------------------------------------------------------ VLAN interfaces

test('a VLAN interface binds to every bridge port of its VLAN (access, trunk, LAG); no member list', () => {
  const m = ok(base).model;
  const ix = m.index.interfaces;
  assert.ok(derive.isVlanInterface(m, ix.get('a:Vlan10')) && !derive.isVlanInterface(m, ix.get('a:Po1')) && !derive.isVlanInterface(m, ix.get('r:g1.10')));
  const ports = (k) => derive.interfaceVlanPorts(m, ix.get(k)).map((p) => `${p.iface}/${p.vlan}/${p.tagged ? 'T' : 'U'}/${p.kind}`);
  assert.deepEqual(ports('a:Vlan10'), ['e0/10/U/trunk', 'e1/10/U/access', 'Po1/10/T/trunk']);
  assert.deepEqual(ports('a:Vlan20'), ['e0/20/T/trunk', 'e2/20/U/access', 'Po1/20/T/trunk']);
  assert.deepEqual(derive.vlanPortsByMode(m, ix.get('b:Vlan10')), { access: ['e1'], trunk: ['e0', 'e3', 'Po1'], routed: [] });
  assert.equal(derive.bridgePortsText(m, ix.get('a:Vlan10')), 'Access: e1 · Trunk: e0, Po1');
  assert.deepEqual(derive.vlanInterfacesOf(m, 'a', 20).map((i) => i.id), ['Vlan20']);
  // a port is associated with the VLAN interfaces of its VLANs (a member through its aggregate)
  assert.deepEqual(derive.associatedInterfaces(m, ix.get('a:e0')), ['Vlan10', 'Vlan20']);
  assert.deepEqual(derive.associatedInterfaces(m, ix.get('a:e4')), ['Po1', 'Vlan10', 'Vlan20']);
  // the binding follows the ports: a port moved to VLAN 20 leaves Vlan10
  const moved = ok(rep('{id: e1, vlans: 10}', '{id: e1, vlans: 20}', base).replace('      - {id: e1, vlans: 20}\n      - {id: e3, vlans', '      - {id: e1, vlans: 10}\n      - {id: e3, vlans')).model;
  assert.deepEqual(derive.vlanPortsByMode(moved, moved.index.interfaces.get('a:Vlan10')).access, []);
  assert.deepEqual(derive.vlanPortsByMode(moved, moved.index.interfaces.get('a:Vlan20')).access, ['e1', 'e2']);
  // the 1-port runs: "Gi1/0/1–10"
  assert.deepEqual(derive.portRuns(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/5', 'Po1']).map((r) => r.text), ['Gi1/0/1–3', 'Gi1/0/5', 'Po1']);
});

test('VLAN interfaces: two for a VLAN (error), none of its bridge ports (warning), one on a Layer 2 switch; no members, no vlans', () => {
  const svi = '      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24}';
  assert.deepEqual(errorsOf(rep(svi, svi + '\n      - {id: irb20, type: virtual, vlan: 20}')), ['devices.a.logical_interfaces[3].vlan: "a" has two VLAN interfaces for VLAN 20 (Vlan20 and irb20): a device has one interface per VLAN']);
  assert.deepEqual(warningsOf(rep(svi, svi + '\n      - {id: Vlan30, type: virtual, vlan: 30}')), ['devices.a.logical_interfaces[3].vlan: VLAN 30 has no bridge port on "a": no port of the device carries it (in its "vlans"), so "Vlan30" reaches no one']);
  const b2 = '      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}';
  assert.deepEqual(errorsOf(rep(b2, b2 + '\n      - {id: Vlan20, type: virtual, vlan: 20}')), ['devices.b.logical_interfaces[2].vlan: "b" is a Layer 2 switch: it has one VLAN interface, its management interface (Vlan10); another one (Vlan20) would route between VLANs — set layer3: true to make it a Layer 3 switch']);
  assert.deepEqual(errorsOf(rep(svi, '      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24, vlans: 20}')), ['devices.a.logical_interfaces[2].vlans: "vlans" applies to a port or an aggregate (with member ports); "Vlan20" has no member ports — a VLAN interface\'s VLAN is "vlan", and it binds to the ports of that VLAN by itself']);
  assert.match(errorsOf(rep(svi, '      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24, members: [e2]}')).join('\n'), /"Vlan20" is an aggregate \(it has member ports\): it carries VLANs with "vlans", it is not the interface of one VLAN/);
});

// ------------------------------------------------------------ the checks

test('check vlan-access-mismatch: access ports in different VLANs (a warning)', () => {
  const f = findings(bE1('{id: e1, vlans: 20}'), 'vlan-access-mismatch');
  assert.deepEqual(f.map((x) => [x.severity, x.path, x.refs, x.message]), [['warning', 'devices.b.interfaces[1].vlans', ['link:access', 'iface:a:e1', 'iface:b:e1'], 'link access: a:e1 is an access port in VLAN 10, b:e1 in VLAN 20: the cable joins the two VLANs (frames of one arrive in the other)']]);
});

test('check vlan-trunk-mismatch: trunks with different lists (a warning); a routed port with subinterfaces counts as a trunk', () => {
  assert.deepEqual(findings(base, 'vlan-trunk-mismatch'), []);
  const f = findings(bE0('{id: e0, vlans: [10, 20, 30-31], native: 10}'), 'vlan-trunk-mismatch');
  assert.deepEqual(f.map((x) => [x.severity, x.path, x.message]), [['warning', 'devices.b.interfaces[0].vlans', 'link trunk: the two trunks carry different VLANs (only b:e0: 30-31); a VLAN only one end allows is dropped by the other']]);
  const s = findings(rep('      - {id: e3, vlans: [10, 20]}', '      - {id: e3, vlans: [10, 20, 30]}'), 'vlan-trunk-mismatch');
  assert.deepEqual(s.map((x) => x.message), ['link stick: the two trunks carry different VLANs (only b:e3: 30); a VLAN only one end allows is dropped by the other']);
});

test('check vlan-native-mismatch: native VLANs that differ, or one end without (an error)', () => {
  assert.deepEqual(findings(base, 'vlan-native-mismatch'), []);
  const f = findings(bE0('{id: e0, vlans: [10, 20], native: 20}'), 'vlan-native-mismatch');
  assert.deepEqual(f.map((x) => [x.severity, x.path, x.message]), [['error', 'devices.b.interfaces[0].native', 'link trunk: the native VLAN is VLAN 10 at a:e0 and VLAN 20 at b:e0: untagged frames of one end arrive in another VLAN at the other (or are dropped)']]);
  const g = findings(bE0('{id: e0, vlans: [10, 20]}'), 'vlan-native-mismatch');
  assert.match(g[0].message, /VLAN 10 at a:e0 and none \(every VLAN tagged\) at b:e0/);
  assert.equal(g[0].path, 'devices.a.interfaces[0].native');
});

test('check vlan-access-trunk: an access port facing a trunk whose native VLAN is not its VLAN', () => {
  const f = findings(bE1('{id: e1, vlans: [10, 20]}'), 'vlan-access-trunk');
  assert.deepEqual(f.map((x) => [x.severity, x.message]), [['warning', 'link access: a:e1 is an access port in VLAN 10, but b:e1 is a trunk without a native VLAN: it drops the untagged frames']]);
  assert.deepEqual(findings(bE1('{id: e1, vlans: [10, 20], native: 10}'), 'vlan-access-trunk'), [], 'its native VLAN is the access VLAN: fine');
});

test('check vlan-unknown: VLANs no network and no VLAN interface defines (VLAN 1 is the default VLAN)', () => {
  const f = findings(rep('{id: e2, vlans: 20}', '{id: e2, vlans: [20, 300-399, 1]}'), 'vlan-unknown');
  assert.deepEqual(f.map((x) => [x.severity, x.path, x.refs, x.message]), [['warning', 'devices.a.interfaces[2].vlans', ['iface:a:e2'], 'a:e2 carries VLANs 300-399, which no network and no VLAN interface of the model defines']]);
});

test('check lag-member-vlans: the far ends of an aggregate’s members differ', () => {
  const text = rep('      - e4\n      - e5\n    logical_interfaces:\n      - {id: Po1, type: virtual, members: [e4, e5], vlans: [10, 20]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}', '      - e4\n      - {id: e5, vlans: 10}\n    logical_interfaces:\n      - {id: Po1, type: virtual, members: [e4], vlans: [10, 20]}\n      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.2/24}');
  const f = findings(text, 'lag-member-vlans');
  assert.deepEqual(f.map((x) => [x.severity, x.refs, x.message]), [['warning', ['iface:a:Po1', 'iface:b:e5'], 'aggregate a:Po1 (Trunk · 10, 20): its members’ far end differs: b:e5 (Access · VLAN 10); a bundle carries the same VLANs on every member']]);
});

test('the check registry knows every VLAN check, and what it reads', () => {
  for (const id of ['vlan-access-mismatch', 'vlan-trunk-mismatch', 'vlan-native-mismatch', 'vlan-access-trunk', 'vlan-unknown', 'lag-member-vlans']) {
    const c = checks.checkById(id);
    assert.ok(c && /interfaces/.test(c.reads), id);
  }
  for (const gone of ['vlan-tagged-mismatch', 'vlan-access-tagged', 'vlan-untagged-tagged']) assert.equal(checks.checkById(gone), undefined, gone);
});

// ------------------------------------------------------------ editing

test('editing a port’s VLANs: IDs and ranges in, merged ranges out; native; routed; one undo step each', () => {
  const d = doc(base);
  const p = ['devices', 0, 'interfaces', 2];
  assert.deepEqual(d.portVlans(p), ['20']);
  assert.ok(d.setPortVlans(p, '20, 30–39 31 10'));
  assert.match(d.exportText(), /- \{id: e2, vlans: \[10, 20, 30-39\]\}/);
  assert.equal(d.canUndo(), 'Set VLANs');
  assert.deepEqual(d.portVlans(p), ['10', '20', '30-39']);
  d.setPortNative(p, '20');
  assert.match(d.exportText(), /\{id: e2, vlans: \[10, 20, 30-39\], native: 20\}/);
  assert.equal(d.canUndo(), 'Set native VLAN');
  // one VLAN left: an access port, and the native VLAN goes in the same step
  d.setPortVlans(p, '20');
  assert.match(d.exportText(), /\{id: e2, vlans: 20\}/);
  d.undo();
  assert.match(d.exportText(), /native: 20/);
  // the native VLAN dropped from the list goes too
  d.setPortVlans(p, '10 30');
  assert.match(d.exportText(), /\{id: e2, vlans: \[10, 30\]\}/);
  // a routed port: VLANs and native go, in one step; back to a switch port
  d.setPortRouted(p, true);
  assert.match(d.exportText(), /\{id: e2, routed: true\}/);
  assert.equal(d.canUndo(), 'Make it a routed port');
  d.setPortVlans(p, '20');
  assert.match(d.exportText(), /\{id: e2, vlans: 20\}/, 'VLANs make it a switch port again');
  // a shorthand port becomes a mapping
  const q = ['devices', 1, 'interfaces', 3];
  d.setPortVlans(q, '10');
  assert.match(d.exportText(), /- \{id: e4, vlans: 10\}/);
  // anything else is kept as written, for validation to report
  d.setPortVlans(p, '20 5000');
  assert.ok(d.errors.some((e) => /"5000" is not a VLAN ID/.test(e.message)));
});

test('Assign VLANs to ports…: the same VLANs on several ports of a device, one undo step; unknown ports write nothing', () => {
  const d = doc(base);
  const before = d.exportText();
  assert.deepEqual(d.assignPortVlans(1, ['e0', 'e9'], '10', ''), { missing: ['e9'], done: 0 });
  assert.equal(d.exportText(), before);
  assert.deepEqual(d.assignPortVlans(1, ['e0', 'e1', 'e3'], '10, 20', '20'), { missing: [], done: 3 });
  for (const id of ['e0', 'e1', 'e3']) assert.match(d.exportText(), new RegExp(`\\{id: ${id}, vlans: \\[10, 20\\], native: 20\\}`), id);
  assert.equal(d.canUndo(), 'Assign VLANs to 3 ports');
  d.undo();
  assert.equal(d.exportText(), before);
});

test('making a Layer 3 switch Layer 2 lists its routed ports; they need their VLANs then', () => {
  const d = doc(base);
  const plan = d.layer2Removal(0);
  assert.ok(plan.removed.includes('e3: routed port (give it its VLANs)'), plan.removed.join('; '));
});

// ------------------------------------------------------------ display

test('physical view: each port’s VLANs under its name, trunks drawn distinctly; a disagreement marks the cable', () => {
  const m = ok(bE1('{id: e1, vlans: 20}')).model;
  const s = new state.Session(m);
  const v = s.render().root;
  const tags = byClass(v, 'port-tag').map((n) => `${scene.textOf(n).trim()}@${n.attrs['data-ref']}/${n.attrs['data-field']}`);
  assert.deepEqual(tags.sort(), ['A 10@link:access/a', 'A 20@link:access/b', 'A 20@link:srv/a', 'R · T 10,20@link:stick/b', 'T 10,20 · N 10@link:trunk/a', 'T 10,20 · N 10@link:trunk/b', 'T 10,20@link:lag1/a', 'T 10,20@link:lag1/b', 'T 10,20@link:lag2/a', 'T 10,20@link:lag2/b', 'T 10,20@link:stick/a']);
  // trunk ports are drawn larger, with a thick frame
  const trunks = byClass(v, 'port').filter((n) => scene.hasClass(n, 'trunk')).map((n) => n.attrs['data-ref']).sort();
  assert.deepEqual(trunks, ['iface:a:e0', 'iface:a:e4', 'iface:a:e5', 'iface:b:e0', 'iface:b:e3', 'iface:b:e4', 'iface:b:e5']);
  const cable = (id) => byRef(v, 'link:' + id).find((n) => scene.hasClass(n, 'cable'));
  assert.ok(scene.hasClass(cable('access'), 'net-mismatch'));
  assert.ok(!scene.hasClass(cable('trunk'), 'net-mismatch'));
  assert.match(byClass(v, 'link-label').map((n) => scene.textOf(n)).join('|'), /VLANs differ/);
  s.state.showLabels = false;
  assert.equal(byClass(s.render().root, 'port-tag').length, 0);
});

test('details, tooltips, Find and highlighting: ports by their mode, VLAN interfaces with their bridge ports', () => {
  const m = ok(base).model;
  assert.deepEqual(panels.tooltipFor(m, 'link:trunk').slice(-1), ['A: Trunk · 10, 20 (native 10)  |  B: Trunk · 10, 20 (native 10)']);
  assert.ok(panels.tooltipFor(m, 'iface:a:e4').includes('Trunk · 10, 20 (from Po1)'));
  assert.match(scene.textOf(panels.detailsFor(m, 'link:trunk')), /e0\n — Trunk · 10, 20 \(native 10\)\n · carries \nUsers\n, \nServers/);
  // the VLAN interface: its bridge ports, grouped by mode, read-only (derived)
  const det = scene.textOf(panels.detailsFor(m, 'iface:a:Vlan10'));
  assert.match(det, /bridge ports\nAccess: \ne1\n · \nTrunk: \ne0\n, \nPo1\nDerived: every port of this device whose VLANs include its VLAN\./);
  assert.equal(panels.associationText(m, m.index.interfaces.get('a:Vlan10')), 'VLAN 10 · bridge ports: Access: e1 · Trunk: e0, Po1');
  assert.equal(panels.associationText(m, m.index.interfaces.get('r:g1.10')), 'VLAN 10 · tagged on g1');
  // the network lists the cables carrying its VLAN
  assert.match(scene.textOf(panels.detailsFor(m, 'network:servers')), /Carried on cables \(5\)[\s\S]*a:e2 ⟷ h:eth0 \(end A only\)/);
  // Find: by VLAN and by mode
  const found = (q) => queries.search(m, q, 100).map((x) => x.ref);
  assert.deepEqual(found('vlan 20').filter((r) => r.startsWith('link:')).sort(), ['link:lag1', 'link:lag2', 'link:srv', 'link:stick', 'link:trunk']);
  assert.ok(found('vlan 20').includes('iface:a:e2') && !found('vlan 20').includes('iface:a:e1'));
  assert.ok(found('access port').includes('iface:a:e1') && !found('access port').includes('iface:a:e0'));
  assert.ok(found('trunk').includes('iface:a:Po1'));
  assert.ok(found('routed port').includes('iface:a:e3'));
  // highlighting both ways: the VLAN interface lights its bridge ports (an aggregate's members and cables too), a port its VLAN interfaces
  const rel = queries.relatedRefs(m, 'iface:a:Vlan10');
  for (const r of ['iface:a:e0', 'iface:a:e1', 'iface:a:Po1', 'iface:a:e4', 'link:lag1', 'link:trunk', 'network:users']) assert.ok(rel.has(r), r);
  assert.ok(!rel.has('iface:a:e2') && !rel.has('link:srv'));
  assert.ok(queries.relatedRefs(m, 'iface:a:e1').has('iface:a:Vlan10'));
  assert.ok(queries.relatedRefs(m, 'iface:a:e4').has('iface:a:Vlan20'));
  // membership follows the VLAN interface (its address), not the ports
  assert.deepEqual(derive.networkMembers(m, 'users').map((x) => x.device), ['a', 'b', 'r']);
});
