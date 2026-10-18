// Auto-arrange and cable routing avoid crossings that aren't needed: a cable
// that has to go around a device takes the side that crosses no other cable
// when it can; the order of the devices in a row is improved by exchanges as
// the order of the blocks is; a cable through a third device's box counts
// against a placement. Measured on the drawn routes (port to port): two
// cables that only meet at a port, or end at one device, don't cross.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, example, publicExampleNames, exampleNames } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { Session } = load('diagram/session.js');
const { groupRects } = load('diagram/physical.js');
const G = load('layout/geometry.js');

/** The physical view after Auto-arrange with a strategy: its routes, boxes, groups and the arranged document. */
function arranged(text, strategy) {
  const d = ModelDoc.fromText(text, 'x.yaml', 'file').doc;
  d.arrange(['physical'], strategy);
  const s = new Session(d.result.model);
  s.state.view = 'physical';
  return { d, s, scene: s.render() };
}

/** The pairs of cables whose drawn routes cross (each pair once, by id). */
function crossings(routes) {
  const rs = Array.from(routes.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out = [];
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const q = rs[j][1];
      const segs = [];
      for (let k = 0; k + 1 < q.length; k++) segs.push([q[k], q[k + 1]]);
      if (G.polylineCrossings(rs[i][1], segs)) out.push(`${rs[i][0]}×${rs[j][0]}`);
    }
  }
  return out;
}

test('the crossing measure: a shared end or a port two cables leave from is no crossing; a real one is', () => {
  const p = (x, y) => ({ x, y });
  assert.equal(G.segmentsCross(p(0, 0), p(10, 10), p(0, 10), p(10, 0)), true);
  assert.equal(G.segmentsCross(p(0, 0), p(10, 10), p(0, 0), p(10, 0)), false, 'a shared end');
  assert.equal(G.segmentsCross(p(0, 0), p(10, 0), p(5, 0), p(5, 10)), false, 'an end on the other');
  assert.equal(G.segmentsCross(p(0, 0), p(10, 0), p(2, 0), p(8, 0)), false, 'on one line');
  assert.equal(G.polylineCrossings([p(0, 5), p(5, 5), p(5, -5)], [[p(2, 0), p(2, 10)], [p(4, 0), p(8, 0)]]), 2);
});

for (const strategy of ['default', 'structured']) {
  test(`private house, ${strategy}: the core's cables to the DSL router and to the NAS don't cross, nothing crosses; floors, ports and labels as they should be`, () => {
    const { s, scene } = arranged(example('private-house.yaml'), strategy);
    const routes = scene.routes;
    const c = crossings(routes);
    assert.ok(c.indexOf('l-core-nas×l-router-core') < 0, c.join(', '));
    assert.deepEqual(c, []);
    const m = s.viewModel('physical');
    // every device in its floor, every floor's frame around its devices
    const want = { basement: ['ap-b', 'core', 'dsl-router', 'nas', 'tv'], floor1: ['ap-1', 'guest-phone', 'phone'], floor2: ['ap-2', 'dist', 'laptop', 'thermostat'] };
    for (const [g, ids] of Object.entries(want)) assert.deepEqual(m.devices.filter((d) => d.group === g).map((d) => d.id).sort(), ids, g);
    // each cable starts and ends at a port of its own two devices (on their boxes' edges)
    const bx = s.physicalLayout().boxes;
    for (const l of m.links) {
      const pts = routes.get(l.id);
      assert.ok(pts && pts.length >= 2, l.id);
      const on = (pt, id) => {
        const b = bx.get(id);
        return Math.abs(Math.abs(pt.x - b.cx) - b.w / 2) < 1.5 || Math.abs(Math.abs(pt.y - b.cy) - b.h / 2) < 1.5;
      };
      assert.ok(on(pts[0], l.a.device) && on(pts[pts.length - 1], l.b.device), l.id);
      // and goes through no other device
      for (const [id, b] of bx) {
        if (id === l.a.device || id === l.b.device) continue;
        for (let k = 0; k + 1 < pts.length; k++) assert.ok(!G.segmentHitsRect(pts[k], pts[k + 1], G.boxRect(b, -1)), `${l.id} through ${id}`);
      }
    }
    // no overlaps of boxes or labels
    assert.equal(scene.conflicts, 0);
    const gr = groupRects(m, bx, new Map());
    for (const [g, ids] of Object.entries(want)) {
      const r = gr.get(g);
      for (const id of ids) {
        const b = bx.get(id);
        assert.ok(b.cx - b.w / 2 >= r.x && b.cx + b.w / 2 <= r.x + r.w && b.cy - b.h / 2 >= r.y && b.cy + b.h / 2 <= r.y + r.h, `${id} in ${g}`);
      }
    }
  });
}

test('a row is ordered by exchanges too: the data center’s border leaf goes where its uplink crosses nothing; only the spines’ unavoidable crossings remain', () => {
  {
    const c = crossings(arranged(example('datacenter-evpn.yaml'), 'default').scene.routes);
    // two spines cabled to four leaves in two rows: C(4,2) = 6 crossings in any order
    assert.equal(c.length, 6, c.join(', '));
    assert.ok(c.every((x) => /^s1-l\d×s2-l\d$/.test(x)), c.join(', '));
  }
  {
    // Structured routes one cable after the other at right angles: one more, between the spine-leaf cables
    const c = crossings(arranged(example('datacenter-evpn.yaml'), 'structured').scene.routes);
    assert.ok(c.length <= 7, c.join(', '));
    assert.ok(c.every((x) => /^s\d-l\d×s\d-l\d$/.test(x)), c.join(', '));
  }
});

test('no public example has more crossings than its topology leaves (Default and Structured; Compact at most two more); the whole set has fewer than before', () => {
  // the remaining ones: a full spine/leaf mesh (6), two ToR switches cabled crosswise to two hosts and a client between them, the campus controller under the distribution switch (Default)
  const most = { 'datacenter-evpn.yaml': 6, 'virtualization.yaml': 3, 'enterprise-campus.yaml': 1 };
  for (const f of publicExampleNames) {
    for (const strategy of ['default', 'compact', 'structured']) {
      const c = crossings(arranged(example(f), strategy).scene.routes);
      // (Compact packs tighter and may add a crossing or two where it saves room, never many; Structured's
      // right-angle routes, laid one after the other, may add one)
      assert.ok(c.length <= (most[f] || 0) + (strategy === 'compact' ? 2 : strategy === 'structured' ? 1 : 0), `${f} ${strategy}: ${c.join(', ')}`);
    }
  }
  // every example, public and internal (but the layout stress model, which has many on purpose): 26 crossings with
  // Default before the crossing reduction; now 14 with Default, 15 with Compact and 19 with Structured (the campus's
  // second DHCP server: Default lost a crossing, Structured's right-angle routes to the two servers gained one)
  const total = { default: 0, compact: 0, structured: 0 };
  for (const f of exampleNames.filter((x) => x !== 'layout-stress.yaml')) for (const strategy of ['default', 'compact', 'structured']) total[strategy] += crossings(arranged(example(f), strategy).scene.routes).length;
  assert.ok(total.default <= 14 && total.compact <= 15 && total.structured <= 19, JSON.stringify(total));
});

test('deterministic and stable: the same model and strategy give the same positions and routes; arranging again changes nothing', () => {
  for (const strategy of ['default', 'compact', 'structured']) {
    const a = arranged(example('private-house.yaml'), strategy);
    const b = arranged(example('private-house.yaml'), strategy);
    assert.equal(a.d.exportText(), b.d.exportText());
    assert.deepEqual(Array.from(a.scene.routes.entries()), Array.from(b.scene.routes.entries()));
    const before = a.d.exportText();
    assert.equal(a.d.arrange(['physical'], strategy).changed, false);
    assert.equal(a.d.exportText(), before);
  }
});

test('performance: a 300-device model with sites is arranged in a few seconds', () => {
  let y = 'netatlas: 1\ngroups:\n';
  for (let s = 0; s < 20; s++) y += `  - {id: s${s}, label: Site ${s}, kind: site}\n`;
  y += 'devices:\n';
  const links = [];
  for (let i = 0; i < 300; i++) {
    const s = Math.floor(i / 15);
    const k = i % 15;
    const type = k === 0 ? 'router' : k < 4 ? 'switch' : 'server';
    y += `  - {id: d${i}, type: ${type}, group: s${s}, interfaces: [${Array.from({ length: 6 }, (_, p) => `{id: p${p}${type === 'switch' ? ', vlans: 1' : ''}}`).join(', ')}]}\n`;
    if (k > 0 && k < 4) links.push([s * 15, i]);
    if (k >= 4) links.push([s * 15 + 1 + (k % 3), i]);
    if (k === 0 && s > 0) links.push([(s - 1) * 15, i]);
  }
  const used = new Map();
  const port = (n) => {
    const c = used.get(n) || 0;
    used.set(n, c + 1);
    return `d${n}:p${c}`;
  };
  y += 'links:\n' + links.map(([a, b], i) => `  - {id: l${i}, a: "${port(a)}", b: "${port(b)}"}`).join('\n') + '\n';
  const d = ModelDoc.fromText(y, 'p.yaml', 'file').doc;
  assert.deepEqual(d.result.errors, []);
  const t0 = Date.now();
  d.arrange(['physical'], 'default');
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
});
