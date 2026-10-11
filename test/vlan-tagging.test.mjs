// Layer-2 tagging on link ends: the port mode (access / trunk), the untagged
// (access or native) VLAN and the tagged VLANs of each end. The networks a
// cable carries are derived from it (through each network's `vlan`), the
// ports carrying a VLAN interface's VLAN too. Stored per end, never
// repaired; the VLAN consistency checks report what disagrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, derive, queries, panels, scene, state, load, byClass, byRef } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const checks = load('analysis/checks.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const ok = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r;
};
const errorsOf = (text) => validate.loadModel(text).errors.map((e) => e.message);
const findings = (text, id) => validate.loadModel(text).findings.filter((f) => !id || f.check === id);

const lk = `netatlas: 1
devices:
  - id: a
    type: switch
    interfaces: [e0, e1, e2]
  - id: b
    type: switch
    interfaces: [e0, e1, e2]
networks:
  - {id: users, label: Users, cidr: 10.1.0.0/24, vlan: 10}
  - {id: users6, label: Users v6, cidr: "2001:db8:1::/64", vlan: 10}
  - {id: servers, label: Servers, cidr: 10.2.0.0/24, vlan: 20}
  - {id: mgmt, label: Management, cidr: 10.9.0.0/24}
links:
  - {id: trunk, a: {device: a, interface: e0, mode: trunk, untagged: 1, tagged: [20, 10]}, b: {device: b, interface: e0, mode: trunk, untagged: 1, tagged: [10, 20]}, medium: fiber, speed: 10G}
  - {id: access, a: {device: a, interface: e1, mode: access, untagged: 10}, b: {device: b, interface: e1, mode: access, untagged: 10}}
  - {id: plain, a: "a:e2", b: "b:e2"}
`;

// ------------------------------------------------------------ the format

test('tagging is stored per end: mode, untagged and tagged (IDs and ranges); nothing written, nothing assumed', () => {
  const r = ok(lk);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.findings.map((f) => f.check), ['vlan-unknown', 'vlan-unknown'], 'VLAN 1 is defined by no network');
  const [trunk, access, plain] = r.model.links;
  assert.deepEqual([trunk.a.mode, trunk.a.untagged, trunk.a.tagged], ['trunk', 1, [{ from: 20, to: 20 }, { from: 10, to: 10 }]]);
  assert.deepEqual([access.a.mode, access.a.untagged, access.a.tagged], ['access', 10, []]);
  assert.deepEqual([plain.a.mode, plain.a.untagged, plain.a.tagged], [undefined, undefined, []]);
  // ranges, and a single value as a one-element list
  const m = ok(lk.replace('tagged: [10, 20]}', 'tagged: 100-199}')).model;
  assert.deepEqual(m.links[0].b.tagged, [{ from: 100, to: 199 }]);
  assert.deepEqual(derive.vlanIds([{ from: 3, to: 5 }, { from: 1, to: 1 }, { from: 4, to: 6 }]), [1, 3, 4, 5, 6]);
  assert.equal(derive.vlanRangesText([30, 20, 100, 101, 102, 199, 1]), '1,20,30,100-102,199');
});

test('tagging text and the networks a link end carries are derived; several networks of one VLAN are one VLAN', () => {
  const m = ok(lk).model;
  const [trunk, access, plain] = m.links;
  assert.deepEqual([derive.endTagText(trunk.a), derive.endTagText(access.a), derive.endTagText(plain.a)], ['U 1 · T 10,20', 'U 10', '']);
  assert.equal(derive.endTagText({ device: 'x', mode: 'trunk', tagged: [] }), 'trunk', 'a mode alone is shown as the mode');
  assert.deepEqual(derive.endVlans(trunk.a), [1, 10, 20]);
  assert.deepEqual(derive.endNetworks(m, trunk.a), ['users', 'users6', 'servers']);
  assert.deepEqual(derive.endNetworks(m, access.b), ['users', 'users6']);
  assert.deepEqual(derive.endNetworks(m, plain.a), [], 'nothing configured, nothing carried');
  assert.deepEqual(derive.linkNetworks(m, trunk), ['users', 'users6', 'servers']);
  // carriage is not membership: no device has an address in these networks
  for (const n of m.networks) assert.deepEqual(derive.networkMembers(m, n.id), [], n.id);
  // a network without a VLAN is carried by no tagging
  assert.ok(!derive.linkNetworks(m, trunk).includes('mgmt'));
});

test('validation: a mode is needed for tagging; modes, VLAN IDs and ranges are checked; repeats are errors; the file is kept', () => {
  const end = (e) => lk.replace('a: "a:e2"', `a: {device: a, interface: e2, ${e}}`);
  assert.deepEqual(errorsOf(end('untagged: 10')), ['VLAN tagging needs the port mode: add "mode: access" (one untagged VLAN) or "mode: trunk" (tagged VLANs, plus an untagged native VLAN)']);
  assert.match(errorsOf(end('tagged: [10]'))[0], /needs the port mode/);
  assert.match(errorsOf(end('mode: trunc'))[0], /unknown port mode "trunc": use "access" .* — did you mean "trunk"\?/);
  assert.match(errorsOf(end('mode: access, untagged: 4095'))[0], /"4095" is not a VLAN ID: use a whole number from 1 to 4094/);
  assert.match(errorsOf(end('mode: trunk, tagged: [0]'))[0], /"0" is not a VLAN ID or range/);
  assert.match(errorsOf(end('mode: trunk, tagged: [200-100]'))[0], /"200-100" is not a VLAN ID or range/);
  assert.match(errorsOf(end('mode: trunk, tagged: [10-4095]'))[0], /is not a VLAN ID or range/);
  assert.match(errorsOf(end('mode: trunk, tagged: [10, 5-12]'))[0], /VLAN 10 listed twice in "tagged" on this end/);
  assert.match(errorsOf(end('mode: trunk, networks: [users]'))[0], /unknown key "networks"/, 'networks on a link end are not part of the format');
  // located at the key, so the editor marks the field
  const r = validate.loadModel(end('mode: access, untagged: 9999'));
  assert.equal(r.errors[0].path, 'links.plain.a.untagged');
  // nothing is converted or dropped: the end is written back as it was
  const text = end('mode: trunk, tagged: [10, 5-12]');
  assert.ok(doc(text).exportText().includes('a: {device: a, interface: e2, mode: trunk, tagged: [10, 5-12]}'));
});

// ------------------------------------------------------------ the checks

test('check vlan-native-mismatch: untagged VLANs that differ between the ends (both written)', () => {
  assert.deepEqual(findings(lk, 'vlan-native-mismatch'), []);
  const f = findings(lk.replace('b: {device: b, interface: e1, mode: access, untagged: 10}', 'b: {device: b, interface: e1, mode: access, untagged: 20}'), 'vlan-native-mismatch');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].message, 'link access: the untagged VLAN is 10 at a:e1 and 20 at b:e1');
  assert.deepEqual(f[0].refs, ['link:access', 'iface:a:e1', 'iface:b:e1']);
  assert.equal(f[0].path, 'links.access.b.untagged');
  // an end without an untagged VLAN says nothing: no mismatch is assumed
  assert.deepEqual(findings(lk.replace('mode: trunk, untagged: 1, tagged: [10, 20]}', 'mode: trunk, tagged: [10, 20]}'), 'vlan-native-mismatch'), []);
});

test('check vlan-tagged-mismatch: trunks tagging different VLANs (a warning)', () => {
  assert.deepEqual(findings(lk, 'vlan-tagged-mismatch'), [], 'the same set in another order is no difference');
  const f = findings(lk.replace('tagged: [10, 20]}', 'tagged: [10, 30-31]}'), 'vlan-tagged-mismatch');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].message, 'link trunk: the two ends tag different VLANs (only at a:e0: 20; only at b:e0: 30-31)');
});

test('check vlan-access-tagged: an access port that tags VLANs', () => {
  assert.deepEqual(findings(lk, 'vlan-access-tagged'), []);
  const f = findings(lk.replace('a: {device: a, interface: e1, mode: access, untagged: 10}', 'a: {device: a, interface: e1, mode: access, untagged: 10, tagged: [20]}'), 'vlan-access-tagged');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /a:e1 is an access port but tags VLANs 20/);
  assert.equal(f[0].path, 'links.access.a.tagged');
});

test('check vlan-untagged-tagged: a VLAN untagged at one end and tagged at the other', () => {
  assert.deepEqual(findings(lk, 'vlan-untagged-tagged'), []);
  const text = lk.replace('{id: access, a: {device: a, interface: e1, mode: access, untagged: 10}', '{id: access, a: {device: a, interface: e1, mode: trunk, tagged: [10]}');
  const f = findings(text, 'vlan-untagged-tagged');
  assert.deepEqual(f.map((x) => x.message), ['link access: VLAN 10 is untagged at b:e1 and tagged at a:e1']);
  assert.equal(f[0].severity, 'error');
});

test('check vlan-unknown: VLANs that no network and no VLAN interface defines (a warning)', () => {
  const f = findings(lk, 'vlan-unknown');
  assert.deepEqual(f.map((x) => x.message), ['link trunk: a:e0 carries VLAN 1, which no network and no VLAN interface of the model defines', 'link trunk: b:e0 carries VLAN 1, which no network and no VLAN interface of the model defines']);
  // a VLAN interface defines its VLAN too
  const withSvi = lk.replace('  - id: b\n    type: switch\n    interfaces: [e0, e1, e2]', '  - id: b\n    type: switch\n    interfaces: [e0, e1, e2]\n    logical_interfaces:\n      - {id: Vlan1, type: virtual, vlan: 1}');
  assert.deepEqual(findings(withSvi, 'vlan-unknown'), []);
  // ranges are named as ranges
  assert.match(findings(lk.replace('tagged: [10, 20]}', 'tagged: [10, 20, 300-399]}'), 'vlan-unknown').map((x) => x.message).join('\n'), /VLANs 1,300-399/);
});

test('checks run only on what is written: an end without a mode is never compared', () => {
  const text = lk.replace('b: {device: b, interface: e1, mode: access, untagged: 10}', 'b: "b:e1"');
  const r = ok(text);
  assert.deepEqual(r.findings.filter((f) => f.check !== 'vlan-unknown'), []);
  assert.equal(derive.tagMismatch(r.model.links[1].a, r.model.links[1].b), null);
  // and the check registry knows every VLAN check, with what it reads
  for (const id of ['vlan-native-mismatch', 'vlan-tagged-mismatch', 'vlan-access-tagged', 'vlan-untagged-tagged', 'vlan-unknown']) {
    const c = checks.checkById(id);
    assert.ok(c && /links/.test(c.reads), id);
  }
});

// ------------------------------------------------------------ editing

test('editing tagging: only the edited end is written; short form in, short form out; one undo step each', () => {
  const d = doc(lk);
  const p = ['links', 2, 'a'];
  assert.deepEqual(d.endTagging(p), { mode: '', untagged: '', tagged: [] });
  assert.ok(d.setEndMode(p, 'trunk'));
  assert.ok(d.setEndUntagged(p, '1'));
  assert.ok(d.setEndTagged(p, '10, 20 100-199'));
  assert.match(d.exportText(), /\{id: plain, a: \{device: a, interface: e2, mode: trunk, untagged: 1, tagged: \[10, 20, 100-199\]\}, b: "b:e2"\}/);
  assert.deepEqual(d.endTagging(p), { mode: 'trunk', untagged: '1', tagged: ['10', '20', '100-199'] });
  assert.equal(d.result.model.links[2].b.mode, undefined, 'the other end is untouched');
  assert.equal(d.canUndo(), 'Set tagged VLANs');
  // an access port has no tagged VLANs: switching to access drops them in the same step
  d.setEndMode(p, 'access');
  assert.match(d.exportText(), /a: \{device: a, interface: e2, mode: access, untagged: 1\}/);
  d.undo();
  assert.match(d.exportText(), /tagged: \[10, 20, 100-199\]/);
  // no layer-2 tagging: the keys go, and the end goes back to the short form
  d.setEndMode(p, '');
  assert.match(d.exportText(), /\{id: plain, a: a:e2, b: "b:e2"\}/);
  // an end without a device can't be tagged
  const e = doc('netatlas: 1\ndevices:\n  - id: a\nlinks:\n  - {id: l}\n');
  assert.equal(e.setEndMode(['links', 0, 'a'], 'trunk'), false);
  // changing the device of an end keeps its tagging
  d.setEndMode(['links', 2, 'b'], 'access');
  d.setEndUntagged(['links', 2, 'b'], '10');
  d.setEndpoint(['links', 2, 'b'], 'a', '');
  assert.match(d.exportText(), /b: \{device: a, mode: access, untagged: 10\}/);
});

test('renaming or deleting a network never touches link ends: they hold VLAN IDs, not network ids', () => {
  const d = doc(lk);
  assert.deepEqual(d.references('network', 'users'), []);
  d.renameEntity('network', 0, 'staff');
  assert.ok(d.valid);
  assert.match(d.exportText(), /tagged: \[20, 10\]/);
  assert.deepEqual(derive.endNetworks(d.result.model, d.result.model.links[1].a), ['staff', 'users6']);
});

// ------------------------------------------------------------ display

test('physical view: the tagging is a second line of each port label; a disagreement marks the cable', () => {
  const m = ok(lk.replace('b: {device: b, interface: e1, mode: access, untagged: 10}', 'b: {device: b, interface: e1, mode: access, untagged: 20}')).model;
  const s = new state.Session(m);
  const v = s.render().root;
  const tags = byClass(v, 'port-tag').map((n) => scene.textOf(n).trim()).sort();
  assert.deepEqual(tags, ['U 1 · T 10,20', 'U 1 · T 10,20', 'U 10', 'U 20']);
  // a tag belongs to its link end: selecting the link selects it, and the Edit tab marks that end
  const t = byClass(v, 'port-tag').find((n) => scene.textOf(n).trim() === 'U 20');
  assert.deepEqual([t.attrs['data-ref'], t.attrs['data-field']], ['link:access', 'b']);
  const cable = (id) => byRef(v, 'link:' + id).find((n) => scene.hasClass(n, 'cable'));
  assert.ok(scene.hasClass(cable('access'), 'net-mismatch'));
  assert.ok(!scene.hasClass(cable('trunk'), 'net-mismatch') && !scene.hasClass(cable('plain'), 'net-mismatch'));
  assert.equal(byClass(v, 'net-warn').length, 1);
  const label = byClass(v, 'link-label').map((n) => scene.textOf(n)).join('|');
  assert.match(label, /VLANs differ/);
  // with labels off, the tagging goes with the port names
  s.state.showLabels = false;
  assert.equal(byClass(s.render().root, 'port-tag').length, 0);
});

test('details, tooltip, Find and selection use the tagging', () => {
  const m = ok(lk.replace('b: {device: b, interface: e1, mode: access, untagged: 10}', 'b: {device: b, interface: e1, mode: access, untagged: 20}')).model;
  const tip = panels.tooltipFor(m, 'link:trunk').join('\n');
  assert.match(tip, /A: trunk, native VLAN 1, tagged 10,20 {2}\| {2}B: trunk, native VLAN 1, tagged 10,20/);
  assert.match(panels.tooltipFor(m, 'link:access').join('\n'), /⚠ VLANs differ: untagged VLAN 10 at end A, 20 at end B/);
  assert.ok(!/tagging|VLAN/.test(panels.tooltipFor(m, 'link:plain').join('\n')), 'nothing configured: nothing shown');
  const det = scene.textOf(panels.detailsFor(m, 'link:trunk'));
  assert.match(det, /trunk, native VLAN 1, tagged 10,20/);
  assert.match(det, /carries \nUsers\n, \nUsers v6\n, \nServers/);
  assert.match(scene.textOf(panels.detailsFor(m, 'link:access')), /the ends differ — untagged VLAN 10 at end A, 20 at end B/);
  assert.match(scene.textOf(panels.detailsFor(m, 'link:plain')), /no layer-2 tagging/);
  // the network's details list the cables carrying its VLAN, and at which end
  const nd = scene.textOf(panels.detailsFor(m, 'network:servers'));
  assert.match(nd, /Carried on cables \(2\)/);
  assert.match(nd, /a:e1 ⟷ b:e1 \(end B only\)/);
  // Find: a VLAN number finds the cables carrying it
  assert.deepEqual(queries.search(m, 'vlan 20').filter((x) => x.kind === 'link').map((x) => x.ref).sort(), ['link:access', 'link:trunk']);
  assert.deepEqual(queries.search(m, '1').filter((x) => x.kind === 'link').map((x) => x.ref), ['link:trunk']);
  // selection: a network highlights the cables carrying its VLAN; a cable relates those networks
  assert.ok(queries.relatedRefs(m, 'network:users').has('link:access') && queries.relatedRefs(m, 'network:users').has('iface:a:e1'));
  assert.ok(!queries.relatedRefs(m, 'network:users').has('link:plain'));
  assert.ok(queries.relatedRefs(m, 'link:trunk').has('network:servers'));
  assert.ok(queries.selectionContext(m, 'network:servers').related.has('link:trunk'));
  assert.ok(queries.selectionContext(m, 'link:access').related.has('network:users'));
});

test('a VLAN interface: the ports carrying its VLAN are derived from the tagging of the link ends', () => {
  const text = `netatlas: 1
devices:
  - id: sw
    type: switch
    interfaces: [p1, p2, p3]
    logical_interfaces:
      - {id: Vlan10, type: virtual, ip: 10.1.0.1/24}
      - {id: Vlan20, type: virtual, vlan: 20}
      - {id: Po1, type: virtual, members: [p3]}
  - id: h
    type: server
    interfaces: [e0, e1, e2]
networks:
  - {id: users, cidr: 10.1.0.0/24, vlan: 10}
  - {id: servers, cidr: 10.2.0.0/24, vlan: 20}
links:
  - {id: l1, a: {device: sw, interface: p1, mode: access, untagged: 10}, b: "h:e0"}
  - {id: l2, a: {device: sw, interface: p2, mode: trunk, untagged: 10, tagged: [20]}, b: "h:e1"}
  - {id: l3, a: "sw:p3", b: "h:e2"}
`;
  const m = ok(text).model;
  const ix = m.index.interfaces;
  assert.deepEqual(derive.interfaceVlans(m, ix.get('sw:Vlan10')), [10], 'from the network of its address');
  assert.deepEqual(derive.interfaceVlans(m, ix.get('sw:Vlan20')), [20]);
  assert.deepEqual(derive.interfaceVlans(m, ix.get('sw:Po1')), []);
  const ports = (id) => derive.interfaceVlanPorts(m, ix.get(id)).map((p) => `${p.iface}/${p.link}/${p.vlan}/${p.tagged ? 'T' : 'U'}`);
  assert.deepEqual(ports('sw:Vlan10'), ['p1/l1/10/U', 'p2/l2/10/U']);
  assert.deepEqual(ports('sw:Vlan20'), ['p2/l2/20/T']);
  assert.deepEqual(derive.associatedInterfaces(m, ix.get('sw:p2')).sort(), ['Vlan10', 'Vlan20']);
  assert.match(panels.associationText(m, ix.get('sw:Vlan20')), /VLAN 20 · ports carrying it: p2/);
  // a physical port's own address does not put a VLAN on the cable (containment is not carriage)
  assert.deepEqual(derive.portsCarryingVlans(m, 'h', [10]), []);
});
