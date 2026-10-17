// Layer 2 and Layer 3 switches: the layer3 flag (switches only), what a
// Layer 2 switch may have (one management interface, static routes) and
// what is an error on it, the same rule in routing, the tracer and the
// Inspector's edit (the confirmation's list, one undo step), and the L2 /
// L3 marking of the diagram, the legend, the details, Find and the palette.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate, model, example, sessionFromYaml, byClass } from './helpers.mjs';

const DT = load('model/device-types.js');
const Cap = load('model/capabilities.js');
const D = load('editor/document.js');
const T = load('analysis/trace.js');
const L = load('diagram/legend.js');
const Q = load('model/queries.js');
const Pal = load('ui/palette.js');

const errs = (text) => validate.loadModel(text).errors.map((e) => `${e.path}: ${e.message}`);

const SW = (extra, dev = '') => `netatlas: 2
devices:
  - id: sw
    type: switch
${dev}    interfaces:
      - {id: p1, vlans: 1}
      - {id: p2, vlans: 1}
${extra}`;

test('layer3 is for switches only; the role of a device follows from it', () => {
  assert.deepEqual(errs(SW('', '    layer3: true\n')), []);
  const e = errs('netatlas: 2\ndevices:\n  - {id: r, type: router, layer3: true}\n');
  assert.equal(e.length, 1);
  assert.match(e[0], /^devices\.r\.layer3: layer3 is for switches/);
  assert.equal(Cap.deviceRoutingRole({ type: 'switch' }), 'host');
  assert.equal(Cap.deviceRoutingRole({ type: 'switch', layer3: true }), 'router');
  assert.equal(Cap.deviceRoutingRole({ type: 'router' }), 'router');
  assert.equal(Cap.isLayer2Switch({ type: 'switch' }), true);
  assert.equal(DT.deviceSubtitle('switch', true), 'Layer 3 switch');
  assert.equal(DT.deviceSubtitle('switch'), 'Layer 2 switch');
  assert.equal(validate.loadModel(SW('', '    layer3: true\n')).model.devices[0].layer3, true);
});

test('a Layer 2 switch: one management interface, static routes in the default table or its VRF; Layer 3 configuration is an error', () => {
  // allowed: a management VLAN interface and a default route towards management
  const ok = SW(`    logical_interfaces:
      - {id: Vlan99, type: virtual, vlan: 99, ip: 10.99.0.10/24, vrf: mgmt}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.99.0.1, vrf: mgmt}
`);
  assert.deepEqual(errs(ok), []);
  const bad = errs(`netatlas: 2
devices:
  - id: sw
    type: switch
    router_id: 10.0.0.1
    protocols: {ospf: {}}
    interfaces:
      - {id: p1, ip: 10.1.0.1/24}
      - {id: p2, vrf: blue}
    logical_interfaces:
      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24}
      - {id: t0, type: tunnel, source: p1, destination: 10.9.9.9}
    routes:
      - {prefix: 10.5.0.0/16, via: 10.1.0.9, vrf: red}
  - {id: r, type: router, protocols: {ospf: {}}, router_id: 10.0.0.2, interfaces: [{id: e0, ip: 10.1.0.2/24}]}
relations:
  - {id: o, protocol: ospf, endpoints: ["sw:p1", "r:e0"]}
  - {id: s, protocol: snmp, endpoints: ["sw:p1", "r:e0"]}
`);
  const has = (re) => assert.ok(bad.some((e) => re.test(e)), `${re}\n${bad.join('\n')}`);
  has(/^devices\.sw\.protocols: "sw" is a Layer 2 switch: it runs no routing protocols \(set layer3: true/);
  has(/^devices\.sw\.router_id: "sw" is a Layer 2 switch: it has no router ID/);
  has(/Vlan20 with addresses too would route between subnets/);
  has(/tunnel interface t0 needs routing/);
  has(/only its management interface may be in a VRF \(VRF blue on p2/);
  has(/its routes are for management, in the default table \(VRF red/);
  has(/^relations\.o\.endpoints: "sw" is a Layer 2 switch: it can't be an endpoint of OSPF/);
  assert.ok(!bad.some((e) => /relations\.s/.test(e)), 'SNMP to its management address is fine');
});

test('the same rule in routing and the path tracer: a Layer 2 switch never forwards, a Layer 3 switch does', () => {
  const text = (l3) => `netatlas: 2
devices:
  - {id: h1, type: endpoint, interfaces: [{id: e, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: sw
    type: switch
    ${l3 ? 'layer3: true' : ''}
    interfaces: [${l3 ? '{id: p1, routed: true, ip: 10.1.0.1/24}, {id: p2, routed: true, ip: 10.2.0.1/24}' : '{id: p1, vlans: 1}, {id: p2, vlans: 1}'}]
    ${l3 ? '' : 'logical_interfaces: [{id: Vlan1, type: virtual, vlan: 1, ip: 10.1.0.1/24}]'}
  - {id: h2, type: endpoint, interfaces: [{id: e, ip: 10.2.0.10/24}]}
links:
  - {id: a, a: "h1:e", b: "sw:p1"}
  - {id: b, a: "sw:p2", b: "h2:e"}
`;
  const t3 = T.tracePath(model(text(true)), { from: 'h1', to: '10.2.0.10' });
  assert.equal(t3.paths[0].end.kind, 'reached');
  const t2 = T.tracePath(model(text(false)), { from: 'h1', to: '10.2.0.10' });
  assert.equal(t2.paths[0].end.kind, 'stopped');
  assert.match(t2.paths[0].end.detail, /sw is a Layer 2 switch and does not forward traffic for others/);
});

test('making a Layer 3 switch a Layer 2 switch: the list of what goes (and the relations that stay), one undo step; and back', () => {
  const src = example('enterprise-wan.yaml');
  const d = D.ModelDoc.fromText(src, 'enterprise-wan.yaml', 'file').doc;
  const idx = d.result.model.devices.findIndex((x) => x.id === 'hq-core1');
  const plan = d.layer2Removal(idx);
  assert.ok(plan.removed.indexOf('protocol OSPF') >= 0 && plan.removed.indexOf('protocol VRRP') >= 0, plan.removed.join('; '));
  assert.ok(plan.removed.some((x) => /^router_id: /.test(x)));
  assert.ok(plan.removed.some((x) => /^Vlan10: \{vrrp: /.test(x)));
  assert.ok(plan.removed.some((x) => /^Vlan20: addresses /.test(x)), 'the addresses of all but the management interface');
  assert.ok(plan.relations.some((x) => /^ospf-hq-area0 \(OSPF\)$/.test(x)));
  const before = d.exportText();
  d.setLayer3(idx, false);
  const sw = d.result.model.devices.find((x) => x.id === 'hq-core1');
  assert.equal(sw.layer3, undefined);
  assert.equal(sw.services.length, 0);
  assert.equal(sw.routerId, undefined);
  assert.equal(sw.interfaces.concat(sw.logical).filter((i) => i.addresses.length).length, 1, 'one management interface keeps its addresses');
  // its routed port is a switch port now: it needs its VLANs, reported until they are given (nothing is chosen for it)
  assert.ok(plan.removed.indexOf('Ethernet49: routed port (give it its VLANs)') >= 0, plan.removed.join('; '));
  assert.deepEqual(d.result.errors.filter((e) => /^devices\.hq-core1\./.test(e.path)).map((e) => e.path), ['devices.hq-core1.interfaces[0].vlans'], d.result.errors.map((e) => e.path + ' ' + e.message).join('\n'));
  assert.ok(d.result.errors.some((e) => /^relations\..*Layer 2 switch/.test(e.path + ' ' + e.message)), 'the relations that need routing are reported');
  d.undo();
  assert.equal(d.exportText(), before, 'one undo step brings it all back');
  // a Layer 2 switch becomes Layer 3: the flag, one step
  const i2 = d.result.model.devices.findIndex((x) => x.id === 'hq-acc1');
  d.setLayer3(i2, true);
  assert.equal(d.result.model.devices[i2].layer3, true);
  assert.match(d.exportText(), /id: hq-acc1\n    label: hq-acc1\n    type: switch\n    layer3: true\n/);
  d.undo();
  assert.equal(d.exportText(), before);
});

test('the diagram marks a switch’s layer in both views (a badge and an own glyph), the legend explains it; details, Find and the palette say it', () => {
  const { session } = sessionFromYaml(example('enterprise-wan.yaml'));
  for (const view of ['physical', 'logical']) {
    session.setView(view);
    const root = session.render().root;
    const badges = byClass(root, 'dev-badge');
    const text = (b) => (b.children.find((c) => c.tag === "text") || {}).text;
    const l3 = badges.filter((b) => text(b) === 'L3').length;
    const l2 = badges.filter((b) => text(b) === 'L2').length;
    assert.equal(l3, 2, `${view}: hq-core1 and hq-core2`);
    assert.ok(l2 >= (view === 'physical' ? 3 : 1), `${view}: the Layer 2 switches drawn`);
    assert.ok(byClass(root, 'icon-switch-l3').length === 2, `${view}: the Layer 3 glyph`);
    const legend = L.legendOf(session.model, view);
    const labels = legend.sections.flatMap((s) => s.items.map((i) => i.label));
    assert.ok(labels.some((x) => /^Layer 3 switch \(L3/.test(x)) && labels.some((x) => /^Layer 2 switch \(L2/.test(x)), view);
  }
  const m = session.model;
  assert.ok(Q.search(m, 'l3').some((h) => h.ref === 'device:hq-core1' && h.kind === 'layer 3 switch'));
  assert.equal(Pal.objectItems(m).find((x) => x.key === 'ref:device:hq-acc1').sub, 'Layer 2 switch');
});
