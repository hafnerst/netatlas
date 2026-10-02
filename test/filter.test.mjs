// Device-filtered views: the relevance rules of model/filter.ts, the
// temporary positions of filtered views in the session (deterministic,
// never written to the document, separate per view), the export of a
// subset, the Groups / Locations option, and the logical view's clustering
// of devices by group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, scene, example, exampleNames } from './helpers.mjs';

const { filterModel } = load('model/filter.js');
const { Session } = load('diagram/session.js');
const { ModelDoc } = load('editor/document.js');
const { autoPositions } = load('layout/positions.js');
const { layoutInput } = load('layout/input.js');
const { exportBoxes, sceneRefs, viewNetworks } = load('diagram/networks-box.js');
const { legendOf } = load('diagram/legend.js');
const { groupRects } = load('diagram/physical.js');
const { networkMembers } = load('model/derive.js');

const net = `netatlas: 1
protocols:
  - {id: custom-x, label: Custom X, category: service}
groups:
  - {id: site, label: Site, kind: site}
  - {id: rack1, label: Rack 1, kind: rack, parent: site}
  - {id: rack2, label: Rack 2, kind: rack, parent: site}
  - {id: far, label: Far away, kind: site}
devices:
  - id: r1
    type: router
    group: rack1
    interfaces: [{id: e0, ip: 10.0.0.1/30}, {id: e1, ip: 10.1.0.1/24}, e2]
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
      - {id: tun0, type: tunnel, source: lo0, destination: "r3:lo0"}
  - id: r2
    type: router
    group: rack1
    interfaces: [{id: e0, ip: 10.0.0.2/30}, {id: e1, ip: 10.1.0.2/24}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]
  - {id: sw, type: switch, group: rack2, interfaces: [p1, p2, {id: p3, ip: 10.1.0.3/24}]}
  - id: r3
    type: router
    group: far
    interfaces: [{id: e0, ip: 10.2.0.1/30}, {id: e1, ip: 10.1.0.9/24}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.3/32}]
links:
  - {id: l12, a: "r1:e0", b: "r2:e0", medium: fiber}
  - {id: l1s, a: {device: r1, interface: e2, networks: [v30]}, b: {device: sw, interface: p1, networks: [v30]}}
  - {id: l3s, a: "r3:e0", b: "sw:p2"}
networks:
  - {id: lan, cidr: 10.1.0.0/24}
  - {id: p2p, cidr: 10.0.0.0/30}
  - {id: far-net, cidr: 10.2.0.0/30}
  - {id: v30, cidr: 10.30.0.0/24, vlan: 30}
  - {id: overlay, cidr: 10.99.0.0/24}
relations:
  - {id: ospf12, protocol: ospf, endpoints: ["r1:e0", "r2:e0"], over: l12}
  - {id: gre13, protocol: gre, endpoints: ["r1:lo0", "r3:lo0"]}
  - {id: ibgp, protocol: ibgp, endpoints: [r1, r2, r3]}
  - {id: svc, protocol: custom-x, endpoints: [r1, r2], over: [ospf12, gre13, overlay]}
`;
const SUBSET = ['r1', 'r2', 'sw'];
const ids = (xs) => xs.map((x) => x.id).join(',');
const sorted = (it) => Array.from(it).sort().join(',');

// ------------------------------------------------------------- relevance

test('physical view of a subset: only the selected devices, links with both ends selected, the relevant groups and networks', () => {
  const m = model(net);
  const f = filterModel(m, new Set(SUBSET), 'physical');
  assert.equal(ids(f.devices), 'r1,r2,sw');
  // the cable to the left-out r3 is not drawn at all
  assert.equal(ids(f.links), 'l12,l1s');
  assert.equal(sorted(f.index.ifaceLink.keys()), 'r1:e0,r1:e2,r2:e0,sw:p1');
  // mixed group "site": kept, with only its included devices; "far" holds only r3
  assert.equal(ids(f.groups), 'site,rack1,rack2');
  // networks: included members, or carried at an end of an included cable; not named-by-relation only
  assert.equal(ids(f.networks), 'lan,p2p,v30');
  // a network with members on both sides shows only its included members
  assert.deepEqual(networkMembers(m, 'lan').map((x) => x.device), ['r1', 'r2', 'sw', 'r3']);
  assert.deepEqual(networkMembers(f, 'lan').map((x) => x.device), ['r1', 'r2', 'sw']);
});

test('logical view of a subset: only relations entirely among the selected devices; references to left-out objects are dropped', () => {
  const m = model(net);
  const f = filterModel(m, new Set(SUBSET), 'logical');
  // gre13 and the multipoint ibgp reach r3: left out entirely, not drawn as partial relations
  assert.equal(ids(f.relations), 'ospf12,svc');
  const svc = f.index.relations.get('svc');
  assert.deepEqual(svc.over, ['ospf12', 'overlay'], 'the carrier that reaches r3 is dropped from "over"');
  assert.ok(!('network' in svc));
  // networks: included members, or in the "over" of an included relation; not carried on a cable only
  assert.equal(ids(f.networks), 'lan,p2p,overlay');
  // a tunnel destination on a left-out device keeps its text and no longer points at it
  const tun = f.index.interfaces.get('r1:tun0');
  assert.equal(tun.destination.text, 'r3:lo0');
  assert.equal(tun.destination.device, undefined);
  // protocols: only those of included relations reach the legend (the registry stays complete)
  const labels = legendOf(f, 'logical').sections.flatMap((s) => s.items.filter((i) => i.protocol).map((i) => i.label));
  assert.deepEqual(labels.sort(), ['Custom X', 'OSPF']);
  assert.ok(f.protocols.has('gre'));
});

test('filtering never changes the complete model', () => {
  const m = model(net);
  const snap = JSON.stringify(m, (k, v) => (v instanceof Map ? Array.from(v.entries()) : v instanceof Set ? Array.from(v) : v));
  for (const view of ['physical', 'logical']) filterModel(m, new Set(['r1']), view);
  assert.equal(JSON.stringify(m, (k, v) => (v instanceof Map ? Array.from(v.entries()) : v instanceof Set ? Array.from(v) : v)), snap);
  assert.equal(m.index.interfaces.get('r1:tun0').destination.device, 'r3');
});

// ---------------------------------------------------------- session state

/** A document whose complete views have stored positions, one of them moved by hand. */
function arrangedDoc() {
  const d = ModelDoc.fromText(net, 'n.yaml', 'file').doc;
  d.arrange(['physical', 'logical']);
  const p = d.result.model.layout.physical.get('r3');
  d.movePositions('physical', new Map([['r3', { x: p.x + 400, y: p.y + 80 }]]));
  return d;
}

test('all devices selected: the complete model with its stored positions; a subset is auto-arranged for itself', () => {
  const d = arrangedDoc();
  const s = new Session(d.result.model);
  const full = new Map(s.positionsFor('physical'));
  assert.equal(full.get('r3').x, d.result.model.layout.physical.get('r3').x);
  assert.equal(s.isFiltered(), false);
  // selecting every device is no filter at all
  assert.equal(s.setDevices(['r3', 'sw', 'r2', 'r1']), false);
  assert.equal(s.viewModel(), s.model);
  assert.ok(s.setDevices(SUBSET));
  assert.equal(s.isFiltered(), true);
  for (const view of ['physical', 'logical']) {
    s.setView(view);
    const expected = autoPositions(view, layoutInput(filterModel(s.model, new Set(SUBSET), view)));
    assert.deepEqual(Array.from(s.positionsFor(view)), Array.from(expected), view);
    assert.equal(s.filteredStatus(view), 'auto');
  }
  // back to all devices: exactly the stored full-model positions
  assert.ok(s.setDevices(['r1', 'r2', 'r3', 'sw']));
  assert.equal(s.isFiltered(), false);
  assert.deepEqual(Array.from(s.positionsFor('physical')), Array.from(full));
});

test('a filtered layout is deterministic: the same for the same devices, whatever the selection order or earlier moves', () => {
  const run = (order, before) => {
    const s = new Session(arrangedDoc().result.model);
    before(s);
    s.setDevices(order);
    return ['physical', 'logical'].map((v) => JSON.stringify(Array.from(s.positionsFor(v))));
  };
  const plain = run(SUBSET, () => {});
  assert.deepEqual(run(['sw', 'r2', 'r1'], () => {}), plain);
  // after drags in the complete view, and after another filter with a moved node
  assert.deepEqual(
    run(['r2', 'sw', 'r1'], (s) => {
      s.moveNode('device:r1', { x: -500, y: -500 });
      s.setDevices(['r1', 'r3']);
      s.moveNode('device:r1', { x: 999, y: 999 });
      s.commitTemporary('device:r1');
    }),
    plain,
  );
});

test('moves in a filtered view are temporary: per view, never in the document, undone by Auto-arrange and by leaving the filter', () => {
  const d = arrangedDoc();
  const yaml = d.exportText();
  const undo = d.canUndo();
  const s = new Session(d.result.model);
  s.setDevices(SUBSET);
  s.setView('physical');
  const auto = new Map(s.positionsFor('physical'));
  const logicalBefore = JSON.stringify(Array.from(s.positionsFor('logical')));
  const p = auto.get('r2');
  s.moveNode('device:r2', { x: p.x + 123, y: p.y + 45 });
  assert.ok(s.commitTemporary('device:r2'));
  assert.deepEqual(s.positionsFor('physical').get('r2'), { x: p.x + 123, y: p.y + 45 });
  assert.equal(s.filteredStatus('physical'), 'manual');
  // the document is untouched: no stored position, no undo step, the same YAML
  assert.equal(d.exportText(), yaml);
  assert.equal(d.canUndo(), undo);
  assert.equal(d.dirty, true); // (from arranging, before filtering)
  // no leak between the views
  s.setView('logical');
  assert.equal(JSON.stringify(Array.from(s.positionsFor('logical'))), logicalBefore);
  assert.equal(s.filteredStatus('logical'), 'auto');
  s.setView('physical');
  assert.deepEqual(s.positionsFor('physical').get('r2'), { x: p.x + 123, y: p.y + 45 });
  // unrelated actions don't re-arrange
  s.state.showLabels = false;
  s.state.showGroups = false;
  s.select('device:r1');
  s.render();
  assert.deepEqual(s.positionsFor('physical').get('r2'), { x: p.x + 123, y: p.y + 45 });
  // Auto-arrange in a filtered view: the shown subset only, temporary
  assert.equal(s.arrangeFiltered(), 1);
  assert.deepEqual(Array.from(s.positionsFor('physical')), Array.from(auto));
  assert.equal(s.filteredStatus('physical'), 'auto');
  assert.equal(d.exportText(), yaml);
  // export -> reload keeps the full-model positions exactly
  const back = ModelDoc.fromText(d.exportText(), 'n.yaml', 'file').doc;
  for (const v of ['physical', 'logical']) assert.deepEqual(Array.from(back.result.model.layout[v]), Array.from(d.result.model.layout[v]));
  // leaving the filter forgets the temporary layout: the same subset is arranged afresh
  s.moveNode('device:r2', { x: 0, y: 0 });
  s.commitTemporary('device:r2');
  s.setDevices(['r1', 'r2', 'r3', 'sw']);
  s.setDevices(SUBSET);
  assert.deepEqual(Array.from(s.positionsFor('physical')), Array.from(auto));
});

test('an edit keeps a filtered layout stable; deleted devices leave the selection', () => {
  const d = ModelDoc.fromText(net, 'n.yaml', 'file').doc;
  const s = new Session(d.result.model);
  s.setDevices(SUBSET);
  const p = s.positionsFor('physical').get('r1');
  s.moveNode('device:r1', { x: p.x + 50, y: p.y });
  s.commitTemporary('device:r1');
  d.setText(['devices', 0, 'label'], 'Router one');
  s.setModel(d.result.model);
  assert.equal(s.isFiltered(), true);
  assert.deepEqual(s.positionsFor('physical').get('r1'), { x: p.x + 50, y: p.y });
  d.deleteEntity('device', 2); // sw
  s.setModel(d.result.model);
  assert.equal(sorted(s.selectedDevices()), 'r1,r2');
  // the last missing device was deleted: what remains is everything again, so no filter
  d.deleteEntity('device', 2); // r3
  s.setModel(d.result.model);
  assert.equal(s.isFiltered(), false);
});

// ----------------------------------------------------------------- export

test('the export of a subset shows only it: devices, links, relations, legend and networks overview', () => {
  const m = model(net);
  const s = new Session(m);
  s.setDevices(SUBSET);
  const opts = { hiddenProtocols: new Set(), showNetworks: true, showGroups: true };
  // physical
  s.setView('physical');
  let sc = s.render();
  let refs = sceneRefs(sc.root);
  assert.ok(refs.has('device:r1') && refs.has('device:sw') && !refs.has('device:r3'));
  assert.ok(refs.has('link:l12') && refs.has('link:l1s') && !refs.has('link:l3s'));
  assert.ok(refs.has('group:rack2') && !refs.has('group:far'));
  let boxes = exportBoxes(s.viewModel(), 'physical', { ...opts, ...s.state }, sc);
  let nets = viewNetworks(s.viewModel(), 'physical', refs).map((n) => n.id);
  assert.ok(nets.includes('v30') && nets.includes('p2p') && !nets.includes('far-net') && !nets.includes('overlay'), nets.join());
  assert.ok(scene.textOf(boxes.networks.root).includes('10.30.0.0/24') && !scene.textOf(boxes.networks.root).includes('10.2.0.0/30'));
  // the picture covers the whole filtered diagram, legend and overview included
  assert.ok(boxes.viewBox.w >= sc.bounds.w && boxes.viewBox.h >= sc.bounds.h);
  // logical
  s.setView('logical');
  sc = s.render();
  refs = sceneRefs(sc.root);
  assert.ok(refs.has('relation:ospf12') && refs.has('relation:svc') && !refs.has('relation:gre13') && !refs.has('relation:ibgp') && !refs.has('hub:ibgp'));
  assert.ok(!refs.has('device:r3') && !refs.has('network:far-net'));
  boxes = exportBoxes(s.viewModel(), 'logical', { ...opts, ...s.state }, sc);
  const legendText = scene.textOf(boxes.legend.root);
  const lines = legendText.split('\n');
  assert.ok(lines.includes('OSPF') && lines.includes('Custom X *') && !lines.includes('GRE') && !lines.includes('iBGP'), legendText);
  nets = viewNetworks(s.viewModel(), 'logical', refs).map((n) => n.id);
  assert.deepEqual(nets.sort(), ['lan', 'overlay', 'p2p']);
  // nothing about the temporary positions is part of the picture
  assert.ok(!/temporary|not saved in YAML/.test(scene.textOf(sc.root) + legendText + scene.textOf(boxes.networks.root)));
});

// ---------------------------------------------------- groups / locations

test('Groups / Locations hides the frames in both views, never a device or a position', () => {
  const s = new Session(model(example('enterprise-wan.yaml')));
  for (const view of ['physical', 'logical']) {
    s.setView(view);
    s.state.showGroups = true;
    const on = s.render();
    const frames = scene.findAll(on.root, (n) => scene.hasClass(n, 'group')).length;
    assert.ok(frames >= 3, view);
    const devs = scene.findAll(on.root, (n) => scene.hasClass(n, 'device')).map((n) => JSON.stringify(n.children[0].attrs));
    s.state.showGroups = false;
    const off = s.render();
    assert.equal(scene.findAll(off.root, (n) => scene.hasClass(n, 'group')).length, 0, view);
    assert.deepEqual(scene.findAll(off.root, (n) => scene.hasClass(n, 'device')).map((n) => JSON.stringify(n.children[0].attrs)), devs, view);
  }
});

test('logical auto-arrange keeps each group together: no frame covers a device of another group, sibling frames never overlap', () => {
  for (const f of exampleNames.concat(['filtered'])) {
    const m = f === 'filtered' ? filterModel(model(net), new Set(SUBSET), 'logical') : model(example(f));
    if (!m.groups.length) continue;
    const s = new Session(m);
    s.setView('logical');
    const nodes = s.logicalLayout().nodes;
    const boxes = new Map();
    nodes.forEach((n) => n.kind === 'device' && boxes.set(n.id, n));
    const rects = groupRects(m, boxes);
    const within = (dev, gid) => {
      let g = m.index.devices.get(dev).group;
      while (g) {
        if (g === gid) return true;
        g = m.index.groups.get(g).parent;
      }
      return false;
    };
    const hit = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
    rects.forEach((r, gid) => {
      nodes.forEach((n) => {
        if (n.kind === 'device' && within(n.id, gid)) return;
        // a network or hub whose devices all lie in the group is local to it, and placed inside its frame
        const devs = n.kind === 'network' ? networkMembers(m, n.id).map((x) => x.device) : n.kind === 'hub' ? Array.from(new Set(m.index.relations.get(n.id).endpoints.map((e) => e.device))) : [];
        if (devs.length && devs.every((d) => !boxes.has(d) || within(d, gid))) return;
        assert.ok(!hit(r, { x: n.cx - n.w / 2, y: n.cy - n.h / 2, w: n.w, h: n.h }), `${f}: frame of ${gid} covers ${n.ref}`);
      });
      rects.forEach((q, other) => {
        const g1 = m.index.groups.get(gid);
        const g2 = m.index.groups.get(other);
        if (other !== gid && (g1.parent || null) === (g2.parent || null)) assert.ok(!hit(r, q), `${f}: frames ${gid} and ${other} overlap`);
      });
    });
  }
});
