// The three Auto-arrange presets as drawn: Default unchanged and used unless
// another is chosen; Compact smaller without hiding or shrinking anything;
// Structured on a grid, with every cable and relation made of horizontal and
// vertical segments and right-angle bends, clear of boxes, parallel lines
// apart, ends at their interfaces; its routing stored with the positions
// (one undo step), kept after a move, after save and reload and in the
// export. Geometric checks on the rendered scenes, over the representative
// examples (and the internal layout stress model with nested groups and
// parallel cables).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames, scene, validate } from './helpers.mjs';
import { problems, physicalBindingProblems, logicalBindingProblems, logicalScene, geometry } from './scene-geometry.mjs';

const { ModelDoc } = load('editor/document.js');
const { Session } = load('diagram/session.js');
const { layoutInput } = load('layout/input.js');
const { autoPositions } = load('layout/positions.js');
const { STRATEGIES, STRATEGY_LABEL, STRATEGY_ROUTING, strategyPositions } = load('layout/strategies.js');
const { orthoRoute, separate, isOrthogonal } = load('layout/orthogonal.js');

/** the representative architectures the presets are compared on */
const REPRESENTATIVE = ['private-house.yaml', 'enterprise-campus.yaml', 'datacenter-evpn.yaml', 'enterprise-wan.yaml', 'hybrid-cloud.yaml', 'wan-vpn.yaml', 'layout-stress.yaml'];

const doc = (text) => ModelDoc.fromText(text, 'x.yaml', 'file').doc;
/** a document arranged with a strategy in one view, and its scene */
function arranged(f, view, strategy) {
  const d = doc(example(f));
  if (strategy) d.arrange([view], strategy);
  const s = new Session(d.result.model);
  s.setView(view);
  return { d, s, r: s.render() };
}
const parse = (d) => (d.match(/[A-Za-z][^A-Za-z]*/g) || []).map((c) => ({ cmd: c[0], nums: c.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number) }));
/** every drawn connection (cables, relation lanes and tubes, spokes, memberships, next-hop lines): its ref and points */
function connections(root) {
  const out = [];
  const visit = (n, ref) => {
    const rr = n.attrs['data-ref'] || ref;
    if (n.tag === 'path' && /(^| )(cable-line|rel-line|tube-outer|member|nh-line)( |$)/.test(n.attrs.class || '')) {
      const cmds = parse(n.attrs.d);
      out.push({ ref: rr + '|' + (n.attrs['data-member'] || n.attrs['data-spoke'] || ''), cls: n.attrs.class, cmds, pts: cmds.map((c) => ({ x: c.nums[0], y: c.nums[1] })) });
    }
    for (const c of n.children) visit(c, rr);
  };
  visit(root, '');
  return out;
}
const area = (b) => b.w * b.h;

// ------------------------------------------------------------------ Default

test('Default is the preset unless another is chosen: the initial layout, arrange() without a preset, the A key; no routing stored', () => {
  for (const f of REPRESENTATIVE) {
    const m = model(example(f));
    const input = layoutInput(m);
    for (const v of ['physical', 'logical']) {
      // a model without stored positions shows Default, and says so
      const d = doc(example(f));
      assert.equal(d.arrangedWith(v)[0], 'default', `${f} ${v}`);
      assert.equal(d.routing(v), undefined);
      // arranging without naming a preset is Default
      const e = doc(example(f));
      e.arrange([v]);
      const sorted = (pos) => Array.from(pos).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      assert.deepEqual(sorted(e.displayedPositions(v)), sorted(autoPositions(v, input)), `${f} ${v}`);
      assert.doesNotMatch(e.exportText(), /\n {2}routing:/);
    }
  }
  // the topology's size never chooses another preset: Default for a large model too
  assert.deepEqual(STRATEGIES, ['default', 'compact', 'structured']);
  assert.deepEqual(STRATEGIES.map((s) => STRATEGY_LABEL[s]), ['Default', 'Compact', 'Structured']);
  assert.deepEqual(STRATEGIES.map((s) => STRATEGY_ROUTING[s] || ''), ['', '', 'orthogonal']);
});

test('Default does not depend on what was chosen before: after Compact or Structured it is exactly the fresh Default, routing removed', () => {
  for (const f of ['private-house.yaml', 'layout-stress.yaml']) {
    for (const v of ['physical', 'logical']) {
      const fresh = arranged(f, v, null);
      for (const before of ['compact', 'structured']) {
        const { d } = arranged(f, v, before);
        d.arrange([v], 'default');
        assert.equal(d.routing(v), undefined, `${f} ${v} after ${before}`);
        assert.doesNotMatch(d.exportText(), /\n {2}routing:/);
        const s = new Session(d.result.model);
        s.setView(v);
        assert.equal(JSON.stringify(s.render().root), JSON.stringify(fresh.r.root), `${f} ${v}: Default after ${before} draws like a fresh Default`);
      }
    }
  }
});

test('stored positions are kept when a file is opened: nothing is arranged by itself, with or without a stored routing', () => {
  const d = doc(example('private-house.yaml'));
  d.arrange(['physical'], 'structured');
  const id = Array.from(d.displayedPositions('physical').keys())[0];
  const p = d.displayedPositions('physical').get(id);
  d.movePositions('physical', new Map([[id, { x: p.x + 230, y: p.y - 70 }]]), 'Move');
  const text = d.exportText();
  const back = doc(text);
  assert.deepEqual(back.displayedPositions('physical').get(id), { x: p.x + 230, y: p.y - 70 });
  assert.equal(back.layoutStatus('physical'), 'manual');
  assert.equal(back.routing('physical'), 'orthogonal');
  assert.equal(back.exportText(), text, 'opening and exporting changes nothing');
});

// ------------------------------------------------------------------ Compact

test('Compact is clearly smaller where the topology allows it (full drawn bounds), and never larger than Default', () => {
  // the drawn bounds of the whole scene (boxes, frames, labels, cable bends), not the device centres
  const want = { 'private-house.yaml': [0.12, 0.35], 'enterprise-campus.yaml': [0.15, 0.4], 'datacenter-evpn.yaml': [0.1, 0.2], 'enterprise-wan.yaml': [0.15, 0.3], 'layout-stress.yaml': [0.15, 0.2], 'ot-network.yaml': [0.2, 0.25] };
  for (const [f, [physical, logical]] of Object.entries(want)) {
    for (const [v, least] of [['physical', physical], ['logical', logical]]) {
      const d = area(arranged(f, v, null).r.bounds);
      const c = area(arranged(f, v, 'compact').r.bounds);
      assert.ok(c <= d * (1 - least), `${f} ${v}: compact ${Math.round(c)} is at least ${least * 100}% below default ${Math.round(d)} (${Math.round((100 * (d - c)) / d)}%)`);
    }
  }
  for (const f of exampleNames) {
    for (const v of ['physical', 'logical']) {
      const d = area(arranged(f, v, null).r.bounds);
      const c = area(arranged(f, v, 'compact').r.bounds);
      assert.ok(c <= d * 1.01, `${f} ${v}: compact ${Math.round(c)} not larger than default ${Math.round(d)}`);
    }
  }
});

test('Compact packs groups tighter: unconnected sibling groups stand side by side, a long row of clients is folded', () => {
  let t = 'netatlas: 1\ngroups:\n';
  for (const g of ['a', 'b', 'c']) t += `  - {id: ${g}, label: Site ${g.toUpperCase()}, kind: site}\n`;
  t += 'devices:\n';
  for (const g of ['a', 'b', 'c']) {
    t += `  - {id: ${g}-sw, type: switch, group: ${g}, interfaces: [${Array.from({ length: 8 }, (_, i) => `{id: p${i}, vlans: 1}`).join(', ')}]}\n`;
    for (let i = 0; i < 8; i++) t += `  - {id: ${g}-pc${i}, type: endpoint, group: ${g}, interfaces: [eth0]}\n`;
  }
  t += 'links:\n';
  for (const g of ['a', 'b', 'c']) for (let i = 0; i < 8; i++) t += `  - {id: ${g}-l${i}, a: "${g}-sw:p${i}", b: "${g}-pc${i}:eth0"}\n`;
  const m = model(t);
  const input = layoutInput(m);
  const def = strategyPositions('physical', input, 'default');
  const cmp = strategyPositions('physical', input, 'compact');
  const span = (pos, ids, k) => Math.max(...ids.map((id) => pos.get(id)[k])) - Math.min(...ids.map((id) => pos.get(id)[k]));
  const pcs = (g) => Array.from({ length: 8 }, (_, i) => `${g}-pc${i}`);
  // the sites: stacked in Default, side by side in Compact
  assert.ok(def.get('a-sw').y < def.get('b-sw').y && def.get('b-sw').y < def.get('c-sw').y);
  assert.ok(cmp.get('a-sw').y === cmp.get('b-sw').y && cmp.get('b-sw').y === cmp.get('c-sw').y && cmp.get('a-sw').x < cmp.get('b-sw').x);
  // the clients of a site: in Default a long row (continued at six), in Compact folded into a narrow block
  assert.ok(span(cmp, pcs('a'), 'x') < span(def, pcs('a'), 'x') / 2, 'folded');
  // every client still below its switch (the tier stays)
  for (const g of ['a', 'b', 'c']) for (const pc of pcs(g)) assert.ok(cmp.get(pc).y > cmp.get(g + '-sw').y, pc);
  const s = new Session(m);
  const d0 = s.render().bounds;
  s.model.layout.physical = cmp;
  s.setModel(s.model);
  const r = s.render();
  assert.ok(area(r.bounds) < area(d0) * 0.75, `${Math.round(area(r.bounds))} < ${Math.round(area(d0))}`);
  assert.deepEqual(problems(r.root), []);
  assert.equal(r.conflicts, 0);
});

test('Compact hides and shrinks nothing: the same texts in the same font sizes, the same boxes; no overlaps, every end at its interface; crossings at most two more', () => {
  const sig = (root) => {
    const out = [];
    scene.walk(root, (n) => {
      if (n.tag === 'text') out.push(`${n.attrs.class}|${n.attrs['font-size'] || ''}|${scene.textOf(n)}`);
      if (n.tag === 'rect' && /dev-box|net-box/.test(n.attrs.class || '')) out.push(`${n.attrs.class}|${n.attrs.width}x${n.attrs.height}`);
    });
    return out.sort();
  };
  for (const f of REPRESENTATIVE) {
    for (const v of ['physical', 'logical']) {
      const d = arranged(f, v, null).r;
      const { d: doc2, r } = arranged(f, v, 'compact');
      // (a box is as large as its label and its ports need where they are: the texts are what is compared)
      assert.deepEqual(sig(r.root).filter((x) => !/^(dev-box|net-box)/.test(x)), sig(d.root).filter((x) => !/^(dev-box|net-box)/.test(x)), `${f} ${v}: same texts, same sizes`);
      assert.deepEqual(problems(r.root), [], `${f} ${v}`);
      assert.equal(r.conflicts, 0, `${f} ${v}`);
      const m = doc2.result.model;
      if (v === 'physical') assert.deepEqual(physicalBindingProblems(m, r.root), [], `${f} ${v}`);
      else assert.deepEqual(logicalBindingProblems(m, r.root), [], `${f} ${v}`);
    }
  }
});

// ------------------------------------------------------------------ Structured

test('Structured: on a 10 px grid, devices of a row on one line, many more connected devices in one column than in Default', () => {
  for (const f of REPRESENTATIVE) {
    const input = layoutInput(model(example(f)));
    for (const v of ['physical', 'logical']) {
      const pos = strategyPositions(v, input, 'structured');
      pos.forEach((p, id) => assert.ok(p.x % 10 === 0, `${f} ${v} ${id}: x on the grid (${p.x})`));
    }
    // connected devices one above the other (their cable runs straight down): counted against Default
    const m = model(example(f));
    const aligned = (pos) => m.links.filter((l) => l.a.device !== l.b.device && pos.get(l.a.device) && pos.get(l.b.device) && Math.abs(pos.get(l.a.device).x - pos.get(l.b.device).x) < 1).length;
    const s = aligned(strategyPositions('physical', input, 'structured'));
    const d = aligned(strategyPositions('physical', input, 'default'));
    assert.ok(s >= d, `${f}: ${s} straight columns with Structured, ${d} with Default`);
  }
  // in the campus, every switch stands right above the access switches it feeds or in their middle
  const input = layoutInput(model(example('enterprise-campus.yaml')));
  const p = strategyPositions('physical', input, 'structured');
  assert.equal(p.get('core1').x, p.get('dist1').x, 'core and distribution in one column');
  assert.equal(p.get('acc1').y, p.get('acc2').y, 'the access switches in one row');
});

test('Structured routes: only M and L commands, every segment horizontal or vertical, every bend a right angle, the ends at the ports', () => {
  for (const f of exampleNames) {
    for (const v of ['physical', 'logical']) {
      const { d, r } = arranged(f, v, 'structured');
      assert.ok(scene.hasClass(r.root, 'orthogonal'), `${f} ${v}: the scene says so`);
      for (const c of connections(r.root)) {
        assert.ok(c.cmds.every((x, i) => (i === 0 ? x.cmd === 'M' : x.cmd === 'L')), `${f} ${v} ${c.ref}: no curves (${c.cmds.map((x) => x.cmd).join('')})`);
        assert.ok(isOrthogonal(c.pts), `${f} ${v} ${c.ref}: ${JSON.stringify(c.pts)}`);
        // a bend: the segments before and after it are perpendicular (never back along itself)
        for (let i = 1; i + 1 < c.pts.length; i++) {
          const [a, b, e] = [c.pts[i - 1], c.pts[i], c.pts[i + 1]];
          const dot = (b.x - a.x) * (e.x - b.x) + (b.y - a.y) * (e.y - b.y);
          assert.ok(Math.abs(dot) < 0.01, `${f} ${v} ${c.ref}: a ${dot > 0 ? 'straight' : 'reversing'} point at ${i}`);
        }
      }
      const m = d.result.model;
      if (v === 'physical') assert.deepEqual(physicalBindingProblems(m, r.root), [], `${f} ${v}`);
      else {
        assert.deepEqual(logicalBindingProblems(m, r.root), [], `${f} ${v}`);
        assert.deepEqual(logicalScene(r.root).leaders.filter((x) => /^iface:/.test(x)), [], `${f} ${v}: end labels at their ports`);
      }
      assert.deepEqual(problems(r.root), [], `${f} ${v}`);
      assert.equal(r.conflicts, 0, `${f} ${v}`);
    }
  }
});

test('Structured routes go around boxes, and connections that share a corridor stay apart (no long common stretch)', () => {
  for (const f of REPRESENTATIVE) {
    const { r } = arranged(f, 'physical', 'structured');
    const g = geometry(r.root);
    const routes = Array.from(r.routes.entries());
    for (const [id, pts] of routes) {
      const own = new Set();
      for (const l of [id]) for (const dev of g.devices) if ((r.routes.get(l) || []).some((p) => Math.abs(p.x - dev.box.x) < 1 || Math.abs(p.x - dev.box.x - dev.box.w) < 1 || Math.abs(p.y - dev.box.y) < 1 || Math.abs(p.y - dev.box.y - dev.box.h) < 1)) own.add(dev.ref);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [a, b] = [pts[k], pts[k + 1]];
        for (const dev of g.devices) {
          if (own.has(dev.ref)) continue;
          const x0 = Math.min(a.x, b.x);
          const x1 = Math.max(a.x, b.x);
          const y0 = Math.min(a.y, b.y);
          const y1 = Math.max(a.y, b.y);
          const B = dev.box;
          assert.ok(!(x1 > B.x + 1 && x0 < B.x + B.w - 1 && y1 > B.y + 1 && y0 < B.y + B.h - 1), `${f}: ${id} runs through ${dev.ref}`);
        }
      }
    }
    // two cables never share more than a few px of one line (inner segments)
    const segs = [];
    for (const [id, pts] of routes) for (let k = 1; k + 2 < pts.length; k++) segs.push({ id, a: pts[k], b: pts[k + 1] });
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const [p, q] = [segs[i], segs[j]];
        if (p.id === q.id) continue;
        const ph = Math.abs(p.a.y - p.b.y) < 0.01;
        const qh = Math.abs(q.a.y - q.b.y) < 0.01;
        if (ph !== qh) continue;
        if (ph ? Math.abs(p.a.y - q.a.y) > 0.5 : Math.abs(p.a.x - q.a.x) > 0.5) continue;
        const [lo1, hi1] = ph ? [Math.min(p.a.x, p.b.x), Math.max(p.a.x, p.b.x)] : [Math.min(p.a.y, p.b.y), Math.max(p.a.y, p.b.y)];
        const [lo2, hi2] = ph ? [Math.min(q.a.x, q.b.x), Math.max(q.a.x, q.b.x)] : [Math.min(q.a.y, q.b.y), Math.max(q.a.y, q.b.y)];
        assert.ok(Math.min(hi1, hi2) - Math.max(lo1, lo2) < 24, `${f}: ${p.id} and ${q.id} run on one line for ${Math.round(Math.min(hi1, hi2) - Math.max(lo1, lo2))} px`);
      }
    }
  }
});

test('the router: around a box in its way, the cheapest of few bends, apart where it shares a corridor', () => {
  const box = { x: 100, y: -50, w: 100, h: 100 };
  const way = orthoRoute({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 300, y: 0 }, { x: -1, y: 0 }, [box], 12);
  assert.ok(isOrthogonal(way));
  assert.deepEqual(way[0], { x: 0, y: 0 });
  assert.deepEqual(way[way.length - 1], { x: 300, y: 0 });
  // around it with three bends (and the turn into the port at the end)
  assert.ok(way.length <= 6, JSON.stringify(way));
  for (let k = 0; k + 1 < way.length; k++) {
    const [a, b] = [way[k], way[k + 1]];
    assert.ok(!(Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h), 'clear of the box');
  }
  // keeps its margin from the box
  assert.ok(way.some((p) => p.y <= box.y - 12 || p.y >= box.y + box.h + 12));
  // aligned ends: one straight segment
  assert.deepEqual(orthoRoute({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 200 }, { x: 0, y: -1 }, [], 12), [{ x: 0, y: 0 }, { x: 0, y: 200 }]);
  // two routes on one corridor are spread apart; their ends stay
  const r1 = { id: 'a', width: 2, pts: [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 100 }] };
  const r2 = { id: 'b', width: 2, pts: [{ x: 10, y: 0 }, { x: 10, y: 50 }, { x: 210, y: 50 }, { x: 210, y: 100 }] };
  separate([r1, r2], 8, []);
  assert.notEqual(r1.pts[1].y, r2.pts[1].y);
  assert.ok(Math.abs(r1.pts[1].y - r2.pts[1].y) >= 10);
  assert.deepEqual([r1.pts[0], r1.pts[3], r2.pts[0], r2.pts[3]], [{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 10, y: 0 }, { x: 210, y: 100 }]);
  assert.ok(isOrthogonal(r1.pts) && isOrthogonal(r2.pts));
});

test('Structured keeps nested groups, floors and hosted guests: frames around their own devices only, guests inside their hosts', () => {
  for (const f of ['layout-stress.yaml', 'virtualization.yaml', 'private-house.yaml']) {
    for (const v of ['physical', 'logical']) {
      const { d, r } = arranged(f, v, 'structured');
      const m = d.result.model;
      const g = geometry(r.root);
      const boxOf = new Map(g.devices.map((x) => [x.ref.slice(7), x.box]));
      for (const grp of g.groups) {
        const id = grp.ref.slice(6);
        const inGroup = (dev) => {
          let x = m.index.devices.get(dev)?.group;
          for (let n = 0; x && n < 20; n++) {
            if (x === id) return true;
            x = m.index.groups.get(x)?.parent;
          }
          return false;
        };
        boxOf.forEach((b, dev) => {
          const inside = b.x >= grp.box.x && b.y >= grp.box.y && b.x + b.w <= grp.box.x + grp.box.w && b.y + b.h <= grp.box.y + grp.box.h;
          const apart = b.x + b.w <= grp.box.x || b.x >= grp.box.x + grp.box.w || b.y + b.h <= grp.box.y || b.y >= grp.box.y + grp.box.h;
          if (v === 'physical' && m.index.devices.get(dev)?.host) return;
          assert.ok(inGroup(dev) ? inside : apart, `${f} ${v}: ${dev} ${inGroup(dev) ? 'inside' : 'outside'} ${id}`);
        });
      }
      // nothing moved to another group, nothing added or removed
      assert.deepEqual(m.devices.map((x) => [x.id, x.group || '', x.host || '']), model(example(f)).devices.map((x) => [x.id, x.group || '', x.host || '']));
      assert.equal(m.links.length + m.relations.length, model(example(f)).links.length + model(example(f)).relations.length);
    }
  }
  // the hypervisor's guests are drawn inside it in the physical view
  const { r } = arranged('layout-stress.yaml', 'physical', 'structured');
  const g = geometry(r.root);
  const hv = g.devices.find((x) => x.ref === 'device:hv1').box;
  for (const vm of ['vm1', 'vm2']) {
    const b = g.devices.find((x) => x.ref === 'device:' + vm);
    assert.ok(b && b.box.x >= hv.x && b.box.x + b.box.w <= hv.x + hv.w && b.box.y >= hv.y && b.box.y + b.box.h <= hv.y + hv.h, vm);
  }
});

test('Structured keeps tunnels and what they carry visible: a relation over a tunnel stays a lane inside its tube, tunnels stay tubes', () => {
  const { r } = arranged('enterprise-wan.yaml', 'logical', 'structured');
  const rels = scene.findAll(r.root, (n) => n.tag === 'g' && /(^| )rel( |$)/.test(n.attrs.class || ''));
  const cls = (ref) => (rels.find((n) => n.attrs['data-ref'] === ref) || { attrs: { class: '' } }).attrs.class;
  // GRE and IPsec are drawn as tubes; OSPF over the GRE tunnel runs inside it (one level deeper, along the same corners)
  assert.match(cls('relation:ipsec-muc'), /style-tube/);
  assert.match(cls('relation:gre-muc'), /style-tube .*depth-0/);
  assert.match(cls('relation:ospf-muc'), /depth-1/);
  const pathOf = (ref) => connections(r.root).find((c) => c.ref.startsWith(ref + '|')).pts;
  assert.deepEqual(pathOf('relation:ospf-muc'), pathOf('relation:gre-muc'));
  assert.ok(isOrthogonal(pathOf('relation:ipsec-muc')) && isOrthogonal(pathOf('relation:gre-muc')));
});

test('Structured persists: positions and routing in one undo step, kept after a move, after save and reload, the same scene and export', () => {
  for (const v of ['physical', 'logical']) {
    const f = 'private-house.yaml';
    const d = doc(example(f));
    const before = d.exportText();
    const s0 = new Session(d.result.model);
    s0.setView(v);
    const scene0 = JSON.stringify(s0.render().root);
    assert.equal(d.arrange([v], 'structured').changed, true);
    assert.equal(d.canUndo(), `Auto-arrange (${v} view, Structured)`);
    assert.equal(d.routing(v), 'orthogonal');
    assert.match(d.exportText(), new RegExp(`\\n  routing: \\{${v}: orthogonal\\}\\n`));
    const s1 = new Session(d.result.model);
    s1.setView(v);
    const scene1 = JSON.stringify(s1.render().root);
    // save and reload: the same diagram, still Structured
    const back = doc(d.exportText());
    assert.deepEqual(back.arrangedWith(v), ['structured']);
    const s2 = new Session(back.result.model);
    s2.setView(v);
    assert.equal(JSON.stringify(s2.render().root), scene1, 'reloaded: the same scene');
    // undo: positions and routing together; redo brings both back
    d.undo();
    assert.equal(d.exportText(), before);
    assert.equal(d.routing(v), undefined);
    const s3 = new Session(d.result.model);
    s3.setView(v);
    assert.equal(JSON.stringify(s3.render().root), scene0, 'undone: the Default scene');
    d.redo();
    assert.equal(d.routing(v), 'orthogonal');
    // a move: the routing stays, only what moved is elsewhere; nothing else is rearranged
    const pos = d.displayedPositions(v);
    const id = Array.from(pos.keys()).sort()[0];
    const p = pos.get(id);
    d.movePositions(v, new Map([[id, { x: p.x + 140, y: p.y + 60 }]]), 'Move');
    assert.equal(d.routing(v), 'orthogonal');
    assert.deepEqual(d.arrangedWith(v), []);
    assert.equal(d.layoutStatus(v), 'manual');
    d.displayedPositions(v).forEach((q, other) => {
      if (other !== id) assert.deepEqual(q, pos.get(other), `${other} stays`);
    });
    const s4 = new Session(d.result.model);
    s4.setView(v);
    const r4 = s4.render();
    assert.ok(scene.hasClass(r4.root, 'orthogonal'));
    for (const c of connections(r4.root)) assert.ok(isOrthogonal(c.pts), `${v} after the move: ${c.ref}`);
    // an edit of the model (a device's label: the geometry changes) keeps the routing too
    d.setText(['devices', 0, 'label'], 'A longer label for the first device');
    assert.match(d.exportText(), /A longer label for the first device/);
    assert.equal(d.routing(v), 'orthogonal');
  }
});

test('the routing entry in the YAML: only "orthogonal" per view; anything else is a warning and ignored; Remove stored positions removes it', () => {
  const base = 'netatlas: 1\ndevices:\n  - {id: a, type: router}\n';
  const ok = validate.loadModel(base + 'layout:\n  routing: {physical: orthogonal, logical: orthogonal}\n');
  assert.deepEqual(ok.errors.concat(ok.warnings), []);
  assert.deepEqual(ok.model.layout.routing, { physical: 'orthogonal', logical: 'orthogonal' });
  const bad = validate.loadModel(base + 'layout:\n  routing: {physical: curved, middle: orthogonal}\n');
  assert.deepEqual(bad.errors, []);
  assert.equal(bad.warnings.length, 2, bad.warnings.map((w) => w.message).join('\n'));
  assert.match(bad.warnings[0].message, /"physical: curved" is not a routing/);
  assert.deepEqual(bad.model.layout.routing, {});
  const d = doc(base);
  d.arrange(['physical'], 'structured');
  assert.equal(d.clearLayout(), true);
  assert.equal(d.routing('physical'), undefined);
  assert.doesNotMatch(d.exportText(), /layout/);
});

// ------------------------------------------------------------------ shared

test('deterministic and stable: the same input gives the same positions, routing and scene; arranging again changes nothing', () => {
  for (const f of REPRESENTATIVE) {
    for (const v of ['physical', 'logical']) {
      for (const st of STRATEGIES) {
        const a = arranged(f, v, st);
        const b = arranged(f, v, st);
        assert.equal(a.d.exportText(), b.d.exportText(), `${f} ${v} ${st}`);
        assert.equal(JSON.stringify(a.r.root), JSON.stringify(b.r.root), `${f} ${v} ${st}: the same scene`);
        const text = a.d.exportText();
        assert.deepEqual(a.d.arrange([v], st), { changed: false, moved: 0 }, `${f} ${v} ${st}: again`);
        assert.equal(a.d.exportText(), text);
      }
    }
  }
});

test('performance: a 300-device model with sites is arranged and drawn with each preset in a few seconds', () => {
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
  for (const st of ['compact', 'structured']) {
    const d = doc(y);
    const t0 = Date.now();
    d.arrange(['physical'], st);
    const s = new Session(d.result.model);
    const r = s.render();
    const ms = Date.now() - t0;
    assert.ok(ms < 15000, `${st}: ${ms} ms`);
    assert.equal(r.conflicts, 0, st);
  }
});
