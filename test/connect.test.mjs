// Connecting endpoints in the diagram: which endpoints can take part, which
// pairs are compatible, when a relation only repeats an existing one, and what
// a completed connection writes. The right-click interaction itself (and its
// keyboard equivalent) is exercised in the browser self-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, scene, byClass, state } from './helpers.mjs';

const C = load('model/connect.js');
const { ModelDoc } = load('editor/document.js');
const { exportBoxes } = load('diagram/networks-box.js');

const NET = `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces: [eth0, eth1, eth2]
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.0.0.1/32}
      - {id: tun0, type: tunnel}
      - {id: vlan10, type: virtual}
  - id: r2
    type: router
    interfaces: [eth0, eth1]
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.0.0.2/32}
      - {id: tun0, type: tunnel}
links:
  - {id: c1, a: "r1:eth0", b: "r2:eth0"}
relations:
  - {id: gre1, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
`;
const ep = (s) => (s.indexOf(':') < 0 ? { device: s } : { device: s.slice(0, s.indexOf(':')), iface: s.slice(s.indexOf(':') + 1) });

test('refs and endpoints convert both ways; a device endpoint stays a device', () => {
  assert.deepEqual(C.endpointOfRef('device:r1'), { device: 'r1' });
  assert.deepEqual(C.endpointOfRef('iface:r1:ge-0/0/1'), { device: 'r1', iface: 'ge-0/0/1' });
  assert.equal(C.endpointOfRef('link:c1'), null);
  assert.equal(C.endpointOfRef('relation:gre1'), null);
  assert.equal(C.endpointRef({ device: 'r1' }), 'device:r1');
  assert.equal(C.endpointRef({ device: 'r1', iface: 'eth1' }), 'iface:r1:eth1');
  assert.equal(C.connectionKind('physical'), 'link');
  assert.equal(C.connectionKind('logical'), 'relation');
});

test('physical view: devices and uncabled physical interfaces can be cabled; logical interfaces and cabled ports cannot', () => {
  const m = model(NET);
  const p = (s) => C.endpointProblem(m, 'physical', ep(s));
  assert.equal(p('r1'), '');
  assert.equal(p('r1:eth1'), '');
  assert.match(p('r1:eth0'), /already has a cable \(link “c1”\); one cable per port/);
  assert.match(p('r1:lo0'), /logical interface: only physical interfaces are cabled/);
  assert.match(p('r1:vlan10'), /logical interface/);
  assert.match(p('r9'), /not in the model/);
  assert.match(p('r1:eth9'), /not an interface/);
  // pairs
  const pp = (a, b) => C.pairProblem(m, 'physical', ep(a), ep(b));
  assert.equal(pp('r1:eth1', 'r2:eth1'), '');
  assert.equal(pp('r1:eth1', 'r2'), '', 'a port to a whole device');
  assert.equal(pp('r1', 'r2'), '', 'two whole devices (parallel cables are allowed)');
  assert.equal(pp('r1:eth1', 'r1:eth2'), '', 'two ports of one device');
  assert.match(pp('r1:eth1', 'r1:eth1'), /cannot be connected to itself/);
  assert.match(pp('r1', 'r1:eth1'), /cannot be cabled to itself or to one of its own ports/);
  assert.match(pp('r1', 'r1'), /itself/);
  assert.match(pp('r1:eth1', 'r2:eth0'), /already has a cable/);
  assert.match(pp('r1:eth1', 'r2:lo0'), /logical interface/);
  // the compatible second endpoints, from r1:eth1
  // (not its own device, not a cabled port, not a logical interface)
  assert.deepEqual(C.compatibleEndpoints(m, 'physical', ep('r1:eth1')).map(C.endpointRef), ['iface:r1:eth2', 'device:r2', 'iface:r2:eth1']);
});

test('logical view: devices and logical interfaces of other devices; physical interfaces are not offered there; an interface may have many relations', () => {
  const m = model(NET);
  const p = (s) => C.endpointProblem(m, 'logical', ep(s));
  assert.equal(p('r1'), '');
  assert.equal(p('r1:lo0'), '');
  assert.equal(p('r1:tun0'), '', 'already in a relation, still available');
  assert.match(p('r1:eth1'), /physical interface: in the logical view/);
  const pp = (a, b) => C.pairProblem(m, 'logical', ep(a), ep(b));
  assert.equal(pp('r1:tun0', 'r2:tun0'), '', 'the same pair as an existing relation: allowed (purpose decides, see duplicates)');
  assert.equal(pp('r1', 'r2:lo0'), '');
  assert.match(pp('r1:lo0', 'r1:tun0'), /same device/);
  assert.match(pp('r1', 'r1:lo0'), /same device/);
  assert.deepEqual(C.compatibleEndpoints(m, 'logical', ep('r1:lo0')).map(C.endpointRef), ['device:r2', 'iface:r2:lo0', 'iface:r2:tun0']);
});

test('duplicates: only a relation that repeats an existing one (same endpoints, protocol, label, direction, no underlay or attributes of its own)', () => {
  const m = model(NET);
  const ends = [ep('r1:tun0'), ep('r2:tun0')];
  const dup = (d) => (C.duplicateRelation(m, ends, d) || { id: null }).id;
  assert.equal(dup({ protocol: 'gre' }), 'gre1');
  assert.equal(dup({ protocol: 'GRE' }), 'gre1', 'protocol names are compared normalized');
  assert.equal(C.duplicateRelation(m, ends.slice().reverse(), { protocol: 'gre' }).id, 'gre1', 'bidirectional: the order of the endpoints does not matter');
  assert.equal(dup({ protocol: 'ospf' }), null, 'another protocol');
  assert.equal(dup({ protocol: 'gre', label: 'backup' }), null, 'another label');
  assert.equal(dup({ protocol: 'gre', direction: 'unidirectional' }), null, 'another direction');
  // an existing relation with an underlay or attributes has a purpose of its own
  const m2 = model(NET.replace('endpoints: ["r1:tun0", "r2:tun0"]}', 'endpoints: ["r1:tun0", "r2:tun0"], over: c1}'));
  assert.equal(C.duplicateRelation(m2, ends, { protocol: 'gre' }), null);
  // unidirectional: the order matters
  const m3 = model(NET.replace('endpoints: ["r1:tun0", "r2:tun0"]}', 'endpoints: ["r1:tun0", "r2:tun0"], direction: unidirectional}'));
  assert.equal(C.duplicateRelation(m3, ends, { protocol: 'gre', direction: 'unidirectional' }).id, 'gre1');
  assert.equal(C.duplicateRelation(m3, ends.slice().reverse(), { protocol: 'gre', direction: 'unidirectional' }), null);
});

test('a completed connection is one undo step with stable references; links accept a whole device at an end', () => {
  const d = ModelDoc.fromText(NET, 'n.yaml', 'file').doc;
  d.addConnection('link', 'c2', ['r1:eth1', 'r2'], [['medium', 'fiber'], ['speed', ''], ['label', '']]);
  assert.match(d.exportText(), /\n  - \{id: c2, a: "r1:eth1", b: r2, medium: fiber\}\n/);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('; '));
  assert.equal(d.canUndo(), 'Add link c2');
  assert.ok(d.dirty);
  const l = d.result.model.index.links.get('c2');
  assert.deepEqual([l.a.device, l.a.iface, l.b.device, l.b.iface], ['r1', 'eth1', 'r2', undefined], 'the device end is the device, no port chosen for it');
  d.undo();
  assert.ok(!d.result.model.index.links.has('c2') && !d.dirty);
});

test('two distinct relations on the same logical interfaces: both created, drawn as separate lanes, selectable, editable, exported and reloaded', () => {
  const d = ModelDoc.fromText(NET, 'n.yaml', 'file').doc;
  // the same endpoints as gre1, but other purposes
  for (const [id, proto, label] of [['ospf-a', 'ospf', 'area 0'], ['ospf-b', 'ospf', 'area 1']]) {
    assert.equal(C.duplicateRelation(d.result.model, [ep('r1:tun0'), ep('r2:tun0')], { protocol: proto, label }), null, id);
    d.addConnection('relation', id, ['r1:tun0', 'r2:tun0'], [['protocol', proto], ['label', label]]);
  }
  // the third one with the same values is a duplicate
  assert.equal(C.duplicateRelation(d.result.model, [ep('r2:tun0'), ep('r1:tun0')], { protocol: 'ospf', label: 'area 1' }).id, 'ospf-b');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('; '));
  assert.match(d.exportText(), /- id: ospf-a\n {4}protocol: ospf\n {4}label: area 0\n {4}endpoints: \["r1:tun0", "r2:tun0"\]\n/);
  // drawn separately: one lane (and label) each, every one with its own ref
  const s = new state.Session(d.result.model);
  s.setView('logical');
  const root = s.render().root;
  const rels = byClass(root, 'rel').map((n) => n.attrs['data-ref']).sort();
  assert.deepEqual(rels, ['relation:gre1', 'relation:ospf-a', 'relation:ospf-b']);
  const paths = byClass(root, 'rel').map((n) => scene.findAll(n, (x) => x.attrs.class === 'hit')[0].attrs.d);
  assert.equal(new Set(paths).size, 3, 'three distinct lanes');
  // selectable: each one highlights itself and its endpoints
  for (const r of ['relation:ospf-a', 'relation:ospf-b']) {
    s.select(r);
    assert.equal(s.state.selected, r);
    assert.ok(s.highlight().has(r) && s.highlight().has('device:r1'));
  }
  // editable independently
  const ib = d.findEntity('relation', 'ospf-b').index;
  d.setText(['relations', ib, 'description'], 'second area on the same tunnel');
  assert.equal(d.result.model.index.relations.get('ospf-a').description, undefined);
  // exported (the picture lists both) and reloaded
  const ex = exportBoxes(s.viewModel(), 'logical', s.state, s.render());
  assert.ok(ex.legend.root);
  const back = ModelDoc.fromText(d.exportText(), 'n.yaml', 'file').doc;
  assert.ok(back.valid);
  const bm = back.result.model;
  assert.deepEqual(['ospf-a', 'ospf-b'].map((id) => bm.index.relations.get(id).endpoints.map((e) => e.device + ':' + e.iface).join()), ['r1:tun0,r2:tun0', 'r1:tun0,r2:tun0']);
  assert.equal(bm.index.relations.get('ospf-b').description, 'second area on the same tunnel');
  assert.equal(back.exportText(), d.exportText());
});

test('the diagrams draw every interface of a shown device, as selectable endpoints, and follow edits, deletions and filters', () => {
  const d = ModelDoc.fromText(NET, 'n.yaml', 'file').doc;
  const refs = (view, cls) => {
    const s = new state.Session(d.result.model);
    s.setView(view);
    return byClass(s.render().root, cls).map((n) => n.attrs['data-ref']);
  };
  // physical: uncabled ports as chips (the cabled ones are ports on their cable); no logical interface
  assert.deepEqual(refs('physical', 'port-chip'), ['iface:r1:eth1', 'iface:r1:eth2', 'iface:r2:eth1']);
  assert.deepEqual(refs('physical', 'port').sort(), ['iface:r1:eth0', 'iface:r2:eth0']);
  assert.ok(!refs('physical', 'if-chip').some((r) => /lo0|tun0|vlan10/.test(r)));
  // logical: loopbacks as rows, the other logical interfaces as chips, with or without a relation
  assert.deepEqual(refs('logical', 'loop-chip'), ['iface:r1:lo0', 'iface:r2:lo0']);
  assert.deepEqual(refs('logical', 'logical-chip'), ['iface:r1:tun0', 'iface:r1:vlan10', 'iface:r2:tun0']);
  // every endpoint element says what it is
  const s = new state.Session(d.result.model);
  const all = scene.findAll(s.render().root, (n) => !!n.attrs['data-endpoint']);
  assert.ok(all.every((n) => (n.attrs['data-endpoint'] === 'device') === /^device:/.test(n.attrs['data-ref'])));
  // a new interface appears, a deleted one disappears, a cabled one becomes a port
  d.addInterface(0, [], 'eth7');
  assert.ok(refs('physical', 'port-chip').indexOf('iface:r1:eth7') >= 0);
  const entry = d.interfaceEntries(0).find((e) => e.id === 'eth7');
  d.deleteInterface(entry.path);
  assert.ok(refs('physical', 'port-chip').indexOf('iface:r1:eth7') < 0);
  d.addConnection('link', 'c9', ['r1:eth1', 'r2:eth1']);
  assert.deepEqual(refs('physical', 'port-chip'), ['iface:r1:eth2']);
  // a filtered view draws the interfaces of its devices only
  const f = new state.Session(d.result.model);
  f.setDevices(['r1']);
  assert.ok(byClass(f.render().root, 'if-chip').every((n) => /^iface:r1:/.test(n.attrs['data-ref'])));
});

test('interface chips: a long run of similar names shows the shared prefix once; nothing is cut off', () => {
  const S = load('layout/sizes.js');
  assert.deepEqual(S.chipTexts(['eth0', 'eth1']), { prefix: '', texts: ['eth0', 'eth1'] });
  const many = Array.from({ length: 12 }, (_, i) => `ge-0/0/${i + 1}`);
  assert.deepEqual(S.chipTexts(many), { prefix: 'ge-0/0/', texts: many.map((x) => x.slice(7)) });
  // a prefix is only used when every chip keeps text of its own
  assert.equal(S.chipTexts(['p', 'p1', 'p2', 'p3', 'p4', 'p5']).prefix, '');
  const flow = S.chipFlow(many, 160);
  assert.equal(flow.items[0].text, 'ge-0/0/ ▸');
  assert.ok(flow.items.every((c) => c.x + c.w <= 160 || c.x === 0), 'rows stay within the width');
  assert.ok(flow.items.every((c) => !/…/.test(c.text)));
  // the device box grows for the chips: its size depends on them, so Auto-arrange leaves room
  const { physicalBaseSize } = load('layout/physical.js');
  const base = { id: 'x', label: 'x', sub: 'Switch', tier: 4, group: null, loopbacks: 0, chipW: 0, dns: [], logical: [] };
  assert.ok(physicalBaseSize({ ...base, spare: many }).h > physicalBaseSize({ ...base, spare: [] }).h);
});
