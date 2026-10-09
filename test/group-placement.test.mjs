// Auto-arrange places groups by their cabling: a group sits one layer below
// the block it is cabled to, as close as possible to the point under (or
// over) the devices it connects, instead of wherever the flow of boxes left
// room. Regression test for the enterprise-wan example, plus other
// topologies to show that the rule is general and not keyed on any name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, model, example, exampleNames, state } from './helpers.mjs';
import { geometry, problems, overlap } from './scene-geometry.mjs';

const { layoutInput } = load('layout/input.js');
const { autoPositions } = load('layout/positions.js');
const { logicalEdges, logicalSpecs } = load('layout/logical.js');
const { ModelDoc } = load('editor/document.js');
const legend = load('diagram/legend.js');

const posText = (m) => JSON.stringify(Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const auto = (text) => model(text.replace(/\nlayout:[\s\S]*$/, '\n'));
const scene = (m, view = 'physical', stored) => {
  const s = new state.Session(m);
  if (stored) s.model.layout[view] = stored;
  s.setView(view);
  return s.render();
};
const group = (g, id) => g.groups.find((x) => x.ref === 'group:' + id).box;
const dev = (g, id) => g.devices.find((x) => x.ref === 'device:' + id).box;
const cy = (b) => b.y + b.h / 2;
const cx = (b) => b.x + b.w / 2;

/** Drawn cabling of a physical scene: total length, crossings between different cables, bends around devices. */
function cabling(g) {
  const segs = [];
  let length = 0;
  let bends = 0;
  for (const c of g.cables) {
    for (let i = 0; i + 1 < c.pts.length; i++) {
      length += Math.hypot(c.pts[i + 1].x - c.pts[i].x, c.pts[i + 1].y - c.pts[i].y);
      segs.push([c.ref, c.pts[i], c.pts[i + 1]]);
    }
    // a cable with stubs has 4 points; more means it had to go around a device
    bends += Math.max(0, c.pts.length - (c.straight ? 2 : 4));
  }
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [ra, a, b] = segs[i];
      const [rb, c, d] = segs[j];
      if (ra !== rb && o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) crossings++;
    }
  }
  return { length: Math.round(length), crossings, bends };
}

// ------------------------------------------------------------ enterprise-wan

test('enterprise-wan: the provider group lies between the Internet above it and the HQ routers below it', () => {
  const m = auto(example('enterprise-wan.yaml'));
  const g = geometry(scene(m).root);
  const providers = group(g, 'providers');
  const hq = group(g, 'hq');
  // above the devices it connects to in HQ, and above the whole HQ box
  assert.ok(providers.y + providers.h < hq.y, 'the provider box ends above the HQ box');
  for (const id of ['hq-rtr1', 'hq-rtr2']) assert.ok(cy(dev(g, 'isp1-pe')) < cy(dev(g, id)) && cy(dev(g, 'isp2-pe')) < cy(dev(g, id)), id);
  // below the Internet cloud it also connects to
  assert.ok(cy(dev(g, 'inet')) < providers.y, 'the cloud is above the providers');
  // horizontally over the routers it feeds: each PE within the span of the HQ box, in the same left-to-right order
  for (const id of ['isp1-pe', 'isp2-pe']) assert.ok(cx(dev(g, id)) > hq.x && cx(dev(g, id)) < hq.x + hq.w, id + ' is over HQ');
  assert.ok(cx(dev(g, 'isp1-pe')) < cx(dev(g, 'isp2-pe')) === cx(dev(g, 'hq-rtr1')) < cx(dev(g, 'hq-rtr2')), 'no twist between PEs and routers');
  // the uplinks are short and steep, not long diagonals through the diagram
  for (const [pe, rtr] of [['isp1-pe', 'hq-rtr1'], ['isp2-pe', 'hq-rtr2']]) {
    const dx = Math.abs(cx(dev(g, pe)) - cx(dev(g, rtr)));
    const dy = Math.abs(cy(dev(g, pe)) - cy(dev(g, rtr)));
    // (the HQ box sits below the Munich branch's column: its core rack is as wide as the network names on its cables need;
    // the routers' boxes hold the entries with their interfaces' addresses, which makes the HQ rows taller)
    assert.ok(dx < 160 && dy < 800, `${pe} - ${rtr}: ${dx} x ${dy}`);
  }
  // the branches hang under the Internet too: the top of the diagram is the cloud
  for (const id of ['branch-muc', 'branch-ham']) assert.ok(group(g, id).y > cy(dev(g, 'inet')), id);
});

test('enterprise-wan: shorter, clearer cabling than with the provider group at the bottom', () => {
  const m = auto(example('enterprise-wan.yaml'));
  const now = cabling(geometry(scene(m).root));
  // Before this change the group was placed under HQ. The same picture with
  // the two provider routers moved below everything else:
  const pos = autoPositions('physical', layoutInput(m));
  const bottom = Math.max(...Array.from(pos.values()).map((p) => p.y)) + 250;
  const moved = new Map(pos);
  for (const id of ['isp1-pe', 'isp2-pe']) moved.set(id, { x: pos.get(id).x, y: bottom });
  const before = cabling(geometry(scene(auto(example('enterprise-wan.yaml')), 'physical', moved).root));
  assert.ok(now.length < before.length * 0.75, `cable length ${now.length} vs ${before.length}`);
  assert.ok(now.crossings < before.crossings, `crossings ${now.crossings} vs ${before.crossings}`);
  // measured with the previous release of the layout: length 7385, 16 crossings, 6 bends around devices
  // (the device boxes now also hold their interfaces' addresses, so the rows are a little further apart)
  assert.ok(now.length < 7385 * 0.65, 'cable length: ' + now.length);
  assert.equal(now.crossings, 0, 'no two cables cross');
  assert.equal(now.bends, 0, 'no cable has to go around a device');
});

test('the placement comes from the topology, not from names or kinds', () => {
  // nothing in the layout code knows a group kind, a group id or a device id of the example
  for (const f of ['physical.ts', 'input.ts', 'positions.ts']) {
    const src = readFileSync(join(root, 'src', 'layout', f), 'utf8');
    assert.ok(!/provider|providers|isp|hq-|inet|'site'|'rack'|'cloud'|\.kind\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/kind: g\.kind|n\.kind|kind: string;?|kind: ''|g\.kind/g, '')), f);
  }
  // other names and another kind: the same arrangement
  const renamed = example('enterprise-wan.yaml')
    .replace(/\bproviders\b/g, 'zz-carriers')
    .replace('kind: provider', 'kind: zone')
    .replace(/\bisp1-pe\b/g, 'carrier-a')
    .replace(/\bisp2-pe\b/g, 'carrier-b');
  const g = geometry(scene(auto(renamed)).root);
  assert.ok(group(g, 'zz-carriers').y + group(g, 'zz-carriers').h < group(g, 'hq').y);
  assert.ok(cy(dev(g, 'inet')) < group(g, 'zz-carriers').y);
  assert.equal(cabling(g).crossings, 0);
});

test('not a rule that providers go on top: a provider group cabled only to the bottom of a site is placed below it', () => {
  const text = `netatlas: 1
groups:
  - {id: site, kind: site}
  - {id: colo, label: Colocation provider, kind: provider}
devices:
  - {id: wan, type: cloud, group: site, interfaces: [p0]}
  - {id: rtr, type: router, group: site, interfaces: [wan, lan]}
  - {id: sw, type: switch, group: site, interfaces: [up, x1, x2]}
  - {id: backup-a, type: storage, group: colo, interfaces: [e0]}
  - {id: backup-b, type: storage, group: colo, interfaces: [e0]}
links:
  - {id: l1, a: "wan:p0", b: "rtr:wan"}
  - {id: l2, a: "rtr:lan", b: "sw:up"}
  - {id: l3, a: "sw:x1", b: "backup-a:e0"}
  - {id: l4, a: "sw:x2", b: "backup-b:e0"}
`;
  const g = geometry(scene(model(text)).root);
  assert.ok(group(g, 'colo').y > group(g, 'site').y + group(g, 'site').h, 'the provider group is below the site it hangs on');
  assert.ok(Math.abs(cx(group(g, 'colo')) - cx(dev(g, 'sw'))) < 40, 'and under the switch it is cabled to');
  assert.deepEqual(problems(scene(model(text)).root), []);
  assert.equal(cabling(g).crossings, 0);
});

// ------------------------------------------------------- other topologies

test('data centre: the spine rack is above the leaf racks it feeds', () => {
  const m = auto(example('datacenter-evpn.yaml'));
  const g = geometry(scene(m).root);
  const spines = group(g, 'rack-a01');
  for (const id of ['rack-a02', 'rack-a03']) assert.ok(spines.y + spines.h < group(g, id).y, id);
  // between the two leaf racks, not off to one side
  const leaves = ['rack-a02', 'rack-a03'].map((id) => cx(group(g, id))).sort((p, q) => p - q);
  assert.ok(cx(spines) > leaves[0] && cx(spines) < leaves[1], 'a block with links to two blocks sits between them');
  const c = cabling(g);
  // previous layout: length 4825, 11 crossings, 6 bends around devices
  assert.ok(c.length < 4825 * 0.8 && c.crossings <= 11 && c.bends === 0, JSON.stringify(c));
});

const hub = `netatlas: 1
groups:
  - {id: core, label: Core site, kind: site}
  - {id: s1, label: Satellite 1, kind: site}
  - {id: s2, label: Satellite 2 with a considerably longer name than the others, kind: site}
  - {id: s3, label: Satellite 3, kind: site}
  - {id: lab, label: Lab (not connected), kind: room}
  - {id: tiny, kind: rack}
devices:
  - {id: up, type: cloud, interfaces: [a, b]}
  - {id: c1, type: router, group: core, interfaces: [up, d1, d2, x]}
  - {id: c2, type: router, group: core, interfaces: [up, d3, d4, x]}
  - {id: a1, type: switch, group: s1, interfaces: [u1]}
  - {id: a2, type: server, group: s1, interfaces: [e0]}
  - {id: b1, type: switch, group: s2, interfaces: [u1, u2, p1, p2, p3]}
  - {id: b2, type: server, group: s2, interfaces: [e0]}
  - {id: b3, type: server, group: s2, interfaces: [e0]}
  - {id: b4, type: server, group: s2, interfaces: [e0]}
  - {id: d1, type: switch, group: s3, interfaces: [u1]}
  - {id: t1, type: switch, group: tiny, interfaces: [u1, u2]}
  - {id: l1, type: server, group: lab, interfaces: [e0]}
  - {id: l2, type: server, group: lab, interfaces: [e0]}
  - {id: loose, type: server}
links:
  - {id: k1, a: "up:a", b: "c1:up", speed: 10G}
  - {id: k2, a: "up:b", b: "c2:up", speed: 10G}
  - {id: k3, a: "c1:x", b: "c2:x", speed: 10G, label: core interconnect}
  - {id: k4, a: "c1:d1", b: "a1:u1", speed: 1G}
  - {id: k5, a: "c1:d2", b: "b1:u1", speed: 10G, label: primary uplink of satellite 2}
  - {id: k6, a: "c2:d3", b: "b1:u2", speed: 10G, label: secondary uplink}
  - {id: k7, a: "c2:d4", b: "d1:u1", speed: 1G}
  - {id: k8, a: "b1:p1", b: "b2:e0"}
  - {id: k9, a: "b1:p2", b: "b3:e0"}
  - {id: k10, a: "b1:p3", b: "b4:e0"}
  - {id: k11, a: "a2:e0", b: "t1:u1"}
  - {id: k12, a: "l1:e0", b: "l2:e0"}
`;

test('hub and spokes, groups of different sizes, a disconnected group, a loose device', () => {
  const m = model(hub);
  const r = scene(m);
  const g = geometry(r.root);
  assert.deepEqual(problems(r.root), []);
  // layers follow the cabling: cloud, core, satellites, and the rack behind satellite 1
  assert.ok(cy(dev(g, 'up')) < group(g, 'core').y);
  for (const id of ['s1', 's2', 's3']) assert.ok(group(g, 'core').y + group(g, 'core').h < group(g, id).y, id + ' is below the core');
  assert.ok(group(g, 's1').y + group(g, 's1').h < group(g, 'tiny').y, 'two layers down: behind its satellite');
  // left to right as the core routers they hang on; the one with two uplinks (to both routers) in the middle
  const xs = ['s1', 's2', 's3'].map((id) => cx(group(g, id)));
  assert.ok((xs[0] < xs[1] && xs[1] < xs[2]) === cx(dev(g, 'c1')) < cx(dev(g, 'c2')), 'satellites in the order of their routers: ' + xs);
  assert.ok(xs[1] > Math.min(xs[0], xs[2]) && xs[1] < Math.max(xs[0], xs[2]));
  // group boxes never overlap, whatever their size; the long title fits
  const boxes = g.groups.map((x) => x.box);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `${g.groups[i].ref} / ${g.groups[j].ref}`);
  // the disconnected group and the loose device are beside the connected part, not inside it
  const connected = ['core', 's1', 's2', 's3', 'tiny'].map((id) => group(g, id));
  for (const b of [group(g, 'lab'), dev(g, 'loose')]) for (const c of connected) assert.ok(!overlap(b, c));
  assert.deepEqual(cabling(g), { ...cabling(g), crossings: 0, bends: 0 });
  // deterministic and idempotent, also after manual moves
  const d = ModelDoc.fromText(hub, 'hub.yaml', 'file').doc;
  d.arrange(['physical', 'logical']);
  const want = posText(d.displayedPositions('physical'));
  assert.equal(want, posText(autoPositions('physical', layoutInput(model(hub)))));
  d.movePositions('physical', new Map([['b1', { x: -999, y: 999 }], ['up', { x: 5000, y: 5000 }]]));
  assert.equal(d.layoutStatus('physical'), 'manual');
  assert.notEqual(posText(d.displayedPositions('physical')), want, 'manual positions are kept until Auto-arrange is used');
  d.arrange(['physical']);
  assert.equal(posText(d.displayedPositions('physical')), want);
  assert.equal(d.layoutStatus('physical'), 'auto');
  assert.deepEqual(d.arrange(['physical', 'logical']), { changed: false, moved: 0 });
  // the order of the file doesn't matter
  const reversed = hub.replace(/(links:\n)([\s\S]*)$/, (_, h, body) => h + body.trimEnd().split('\n').reverse().join('\n') + '\n');
  assert.equal(posText(autoPositions('physical', layoutInput(model(reversed)))), want);
});

test('every example, both views: still no overlaps, clipped text or cables through devices; the SVG legend still clears the diagram', () => {
  for (const f of exampleNames) {
    const m = auto(example(f));
    for (const view of ['physical', 'logical']) {
      const r = scene(m, view);
      assert.deepEqual(problems(r.root), [], `${f} ${view}`);
      const g = geometry(r.root);
      const boxes = g.groups.map((x) => x.box);
      // sibling groups never overlap (a group does contain its children)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = m.index.groups.get(g.groups[i].ref.slice(6));
          const b = m.index.groups.get(g.groups[j].ref.slice(6));
          const nested = (x, y) => {
            for (let p = x; p; p = p.parent ? m.index.groups.get(p.parent) : undefined) if (p.id === y.id) return true;
            return false;
          };
          if (!nested(a, b) && !nested(b, a)) assert.ok(!overlap(boxes[i], boxes[j]), `${f}: ${a.id} / ${b.id}`);
        }
      }
      const lg = legend.svgLegend(m, view, { hiddenProtocols: new Set(), showNetworks: true, showGroups: true }, r.bounds);
      assert.ok(lg.box.x >= r.bounds.x + r.bounds.w, `${f} ${view}: legend beside the diagram`);
      for (const b of g.devices.map((x) => x.box).concat(boxes)) assert.ok(b.x >= r.bounds.x && b.x + b.w <= r.bounds.x + r.bounds.w && b.y >= r.bounds.y && b.y + b.h <= r.bounds.y + r.bounds.h, `${f} ${view}: inside the picture`);
    }
  }
});

// ------------------------------------------------------------- logical view

test('the logical view is arranged by logical relationships, not by cables', () => {
  // a-b-c-d are cabled in a chain; logically a talks to d and b to c's network only
  const text = `netatlas: 1
devices:
  - {id: a, type: router, interfaces: [e0], logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.1/32}]}
  - {id: b, type: router, interfaces: [e0, e1], logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.2/32}]}
  - {id: c, type: router, interfaces: [e0, e1], logical_interfaces: [{id: v1, type: virtual, ip: 10.9.0.3/24}]}
  - {id: d, type: router, interfaces: [e0], logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.4/32}, {id: v1, type: virtual, ip: 10.9.0.4/24}]}
links:
  - {id: ab, a: "a:e0", b: "b:e0"}
  - {id: bc, a: "b:e1", b: "c:e0"}
  - {id: cd, a: "c:e1", b: "d:e0"}
networks:
  - {id: lan, cidr: 10.9.0.0/24}
relations:
  - {id: bgp, protocol: ibgp, endpoints: ["a:lo0", "d:lo0"]}
`;
  const m = model(text);
  const input = layoutInput(m);
  const edges = logicalEdges(input, logicalSpecs(input)).map((e) => e[0] + '~' + e[1]);
  assert.deepEqual(edges, ['device:a~device:d', 'network:lan~device:c', 'network:lan~device:d'], 'edges: the relation and the network memberships; no cable');
  const dist = (p, x, y) => Math.hypot(p.get(x).x - p.get(y).x, p.get(x).y - p.get(y).y);
  const p = autoPositions('logical', input);
  // a is drawn at relation distance from d (its session partner), although it is cabled only to b
  assert.ok(dist(p, 'a', 'd') > 200 && dist(p, 'a', 'd') < 520, 'a-d ' + dist(p, 'a', 'd'));
  assert.ok(dist(p, 'c', 'lan') < 420 && dist(p, 'd', 'lan') < 420, 'members next to their network');
  assert.deepEqual(problems(scene(m, 'logical').root), []);
  // and it does not change when only the cabling changes
  const recabled = model(text.replace('  - {id: ab, a: "a:e0", b: "b:e0"}\n', '').replace('  - {id: cd, a: "c:e1", b: "d:e0"}', '  - {id: ad, a: "a:e0", b: "c:e1"}'));
  const input2 = layoutInput(recabled);
  assert.deepEqual(logicalEdges(input2, logicalSpecs(input2)).map((e) => e[0] + '~' + e[1]), edges, 'the same logical edges');
  const p2 = autoPositions('logical', input2);
  assert.ok(dist(p2, 'a', 'd') > 200 && dist(p2, 'a', 'd') < 520 && dist(p2, 'c', 'lan') < 420, 'the same logical neighborhoods after recabling');
  assert.notEqual(posText(autoPositions('physical', input2)), posText(autoPositions('physical', input)), 'while the physical view follows the cables');
});
