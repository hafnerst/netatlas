// The three Auto-arrange strategies (Default, Compact, Spacious): deterministic
// and idempotent for every example (small and dense), free of overlaps, group
// frames kept clear of what they don't contain, and recognised from the
// positions alone — also in filtered views, and with a stable tie-break when
// two strategies give the same positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { layoutInput } = load('layout/input.js');
const { autoPositions } = load('layout/positions.js');
const { STRATEGIES, strategyPositions, allStrategyPositions } = load('layout/strategies.js');
const { physicalBoxes } = load('layout/physical.js');
const { logicalSpecs } = load('layout/logical.js');
const { groupRects } = load('diagram/physical.js');
const { Session } = load('diagram/session.js');
const { filterModel } = load('model/filter.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const posText = (m) => JSON.stringify(Array.from(m.entries()).sort((p, q) => (p[0] < q[0] ? -1 : 1)));

/** node boxes of a view at these positions (physical: devices with their ports; logical: devices, networks, hubs) */
function boxes(view, input, pos) {
  if (view === 'physical') return Array.from(physicalBoxes(input, pos).entries()).map(([id, b]) => ({ id, kind: 'device', ...b }));
  return logicalSpecs(input).map((s) => ({ id: s.id, kind: s.kind, cx: pos.get(s.id).x, cy: pos.get(s.id).y, w: s.w, h: s.h }));
}

function overlaps(bs, margin) {
  const out = [];
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      if (Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + margin && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + margin) out.push(a.id + '/' + b.id);
    }
  }
  return out;
}

/** devices drawn inside the frame of a group they don't belong to */
function frameIntrusions(m, bs) {
  const devs = new Map(bs.filter((b) => b.kind === 'device').map((b) => [b.id, b]));
  const inGroup = (d, g) => {
    let x = m.index.devices.get(d)?.group;
    for (let n = 0; x && n < 50; n++) {
      if (x === g) return true;
      x = m.index.groups.get(x)?.parent;
    }
    return false;
  };
  const out = [];
  groupRects(m, devs).forEach((r, g) =>
    devs.forEach((b, id) => {
      if (inGroup(id, g)) return;
      if (b.cx + b.w / 2 > r.x && b.cx - b.w / 2 < r.x + r.w && b.cy + b.h / 2 > r.y && b.cy - b.h / 2 < r.y + r.h) out.push(`${id} in ${g}`);
    }),
  );
  return out;
}

function extent(bs) {
  const x0 = Math.min(...bs.map((b) => b.cx - b.w / 2));
  const x1 = Math.max(...bs.map((b) => b.cx + b.w / 2));
  const y0 = Math.min(...bs.map((b) => b.cy - b.h / 2));
  const y1 = Math.max(...bs.map((b) => b.cy + b.h / 2));
  return (x1 - x0) * (y1 - y0);
}

test('three strategies, Default first; Default is exactly the existing Auto-arrange', () => {
  assert.deepEqual(STRATEGIES, ['default', 'compact', 'spacious']);
  for (const f of exampleNames) {
    const input = layoutInput(model(example(f)));
    for (const v of ['physical', 'logical']) assert.equal(posText(strategyPositions(v, input, 'default')), posText(autoPositions(v, input)), `${f} ${v}`);
  }
});

test('every strategy, every example (small and dense), both views: deterministic integers, no overlaps, no device inside a foreign group frame', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    const input = layoutInput(m);
    for (const v of ['physical', 'logical']) {
      const all = allStrategyPositions(v, input);
      for (const st of STRATEGIES) {
        const pos = strategyPositions(v, input, st);
        assert.equal(posText(pos), posText(all.get(st)), `${f} ${v} ${st}: same result either way`);
        assert.equal(posText(pos), posText(strategyPositions(v, layoutInput(model(example(f))), st)), `${f} ${v} ${st}: deterministic`);
        pos.forEach((p) => assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), `${f} ${v} ${st}: integer positions`));
        const bs = boxes(v, input, pos);
        assert.deepEqual(overlaps(bs, 4), [], `${f} ${v} ${st}: overlaps`);
        assert.deepEqual(frameIntrusions(m, bs), [], `${f} ${v} ${st}: group frames`);
      }
    }
  }
});

test('the strategies differ meaningfully: Compact takes less room than Default, Spacious more, for the dense examples', () => {
  for (const f of ['enterprise-wan.yaml', 'datacenter-evpn.yaml', 'metro-ring.yaml', 'device-types.yaml', 'long-labels.yaml']) {
    const input = layoutInput(model(example(f)));
    for (const v of ['physical', 'logical']) {
      const [d, c, s] = STRATEGIES.map((st) => extent(boxes(v, input, strategyPositions(v, input, st))));
      assert.ok(c < d, `${f} ${v}: compact ${Math.round(c)} < default ${Math.round(d)}`);
      assert.ok(s > d * 1.3, `${f} ${v}: spacious ${Math.round(s)} > default ${Math.round(d)}`);
    }
  }
});

test('Compact keeps the arrangement: devices in a row stay in their left-to-right order, stacked devices stay stacked', () => {
  const input = layoutInput(model(example('enterprise-wan.yaml')));
  const def = strategyPositions('physical', input, 'default');
  const cmp = strategyPositions('physical', input, 'compact');
  const ids = Array.from(def.keys());
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const [pa, pb, qa, qb] = [def.get(a), def.get(b), cmp.get(a), cmp.get(b)];
      if (pa.y === pb.y && pa.x < pb.x) assert.ok(qa.x < qb.x, `${a} stays left of ${b}`);
      if (pa.x === pb.x && pa.y < pb.y) assert.ok(qa.y < qb.y, `${a} stays above ${b}`);
    }
  }
});

test('arranging with a strategy: one undo step, idempotent, recognised from the positions (also after undo, reload and manual moves)', () => {
  for (const f of ['minimal.yaml', 'metro-ring.yaml', 'long-labels.yaml']) {
    const d = doc(example(f));
    assert.deepEqual(d.arrangedWith('physical').slice(0, 1), ['default'], f);
    for (const st of ['compact', 'spacious', 'default']) {
      for (const v of ['physical', 'logical']) {
        const res = d.arrange([v], st);
        assert.equal(d.arrangedWith(v)[0], st, `${f} ${v} ${st}`);
        assert.equal(d.layoutStatus(v), 'auto');
        // the second time nothing changes
        const text = d.exportText();
        const undo = d.canUndo();
        assert.deepEqual(d.arrange([v], st), { changed: false, moved: 0 }, `${f} ${v} ${st} idempotent`);
        assert.equal(d.exportText(), text);
        assert.equal(d.canUndo(), undo);
        if (res.changed) assert.match(d.canUndo(), new RegExp(`Auto-arrange \\(${v} view${st === 'default' ? '' : ', ' + st[0].toUpperCase() + st.slice(1)}\\)`));
      }
    }
    // the status survives export and reload: it comes from the stored positions
    const c = doc(example(f));
    c.arrange(['physical'], 'compact');
    c.arrange(['logical'], 'spacious');
    const back = doc(c.exportText());
    assert.deepEqual([back.arrangedWith('physical')[0], back.arrangedWith('logical')[0]], ['compact', 'spacious'], f);
    // undo goes back to what was shown before
    c.undo();
    assert.equal(c.arrangedWith('logical')[0], 'default');
    // a manual move: no strategy matches any more, and Auto-arrange reports the hand-placed node
    const id = Array.from(c.displayedPositions('physical').keys())[0];
    c.movePositions('physical', new Map([[id, { x: 9999, y: 9999 }]]), 'Move');
    assert.deepEqual(c.arrangedWith('physical'), []);
    assert.equal(c.layoutStatus('physical'), 'manual');
    for (const st of STRATEGIES) assert.deepEqual(c.arrangeImpact('physical', st).manual, [id], `${f} ${st}`);
    // a node put back where a strategy places it is no longer counted as moved by hand
    c.movePositions('physical', new Map([[id, c.autoLayout('physical', 'compact').get(id)]]), 'Move back');
    assert.deepEqual(c.arrangedWith('physical'), ['compact']);
  }
});

test('identical results: a one-device model gets the same positions from every strategy; the first (Default) counts, the order is stable', () => {
  const d = doc('netatlas: 1\ndevices:\n  - {id: solo, type: router}\n');
  for (const v of ['physical', 'logical']) {
    assert.deepEqual(d.arrangedWith(v), ['default', 'compact', 'spacious'], v);
    assert.equal(d.layoutStatus(v), 'auto');
    for (const st of STRATEGIES) assert.deepEqual(d.arrangeImpact(v, st).moved, [], `${v} ${st}: nothing would move`);
  }
});

test('filtered views: each strategy arranges the shown devices only, deterministically and temporarily', () => {
  const m = model(example('enterprise-wan.yaml'));
  const subset = ['inet', 'isp1-pe', 'hq-rtr1', 'hq-rtr2', 'hq-fw', 'hq-core1'];
  for (const view of ['physical', 'logical']) {
    const s = new Session(m);
    s.setView(view);
    s.setDevices(subset);
    assert.deepEqual(s.filteredArrangedWith(view).slice(0, 1), ['default']);
    const input = layoutInput(filterModel(m, new Set(subset), view));
    for (const st of STRATEGIES) {
      s.arrangeFiltered(st);
      assert.equal(posText(s.positionsFor(view)), posText(strategyPositions(view, input, st)), `${view} ${st}`);
      assert.equal(s.filteredArrangedWith(view)[0], st);
      assert.equal(s.arrangeFiltered(st), 0, `${view} ${st}: nothing moves the second time`);
      assert.deepEqual(overlaps(boxes(view, input, s.positionsFor(view)), 4), [], `${view} ${st}`);
    }
    // the model's own (stored) layout is never touched
    assert.equal(m.layout[view].size, 0);
    // the same selection, chosen in another order, gives the same positions
    const t = new Session(m);
    t.setView(view);
    t.setDevices(subset.slice().reverse());
    t.arrangeFiltered('compact');
    s.arrangeFiltered('compact');
    assert.equal(posText(t.positionsFor(view)), posText(s.positionsFor(view)));
  }
});

test('disconnected components and varied node sizes (long labels, many ports) stay apart in every strategy', () => {
  let t = 'netatlas: 1\ngroups:\n  - {id: site, kind: site, label: "A site whose title is much longer than the devices inside it are wide"}\ndevices:\n';
  t += '  - {id: big, type: switch, label: "A switch with a very long label\\nand a second line", group: site, interfaces: [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12]}\n';
  t += '  - {id: small, type: router, group: site, interfaces: [e0]}\n  - {id: lone, type: server}\n  - {id: x1, type: router, interfaces: [a]}\n  - {id: x2, type: router, interfaces: [a]}\n';
  t += 'links:\n  - {id: c1, a: "big:p1", b: "small:e0"}\n  - {id: c2, a: "x1:a", b: "x2:a"}\n';
  const m = model(t);
  const input = layoutInput(m);
  for (const v of ['physical', 'logical']) {
    for (const st of STRATEGIES) {
      const bs = boxes(v, input, strategyPositions(v, input, st));
      assert.deepEqual(overlaps(bs, 4), [], `${v} ${st}`);
      assert.deepEqual(frameIntrusions(m, bs), [], `${v} ${st}`);
    }
  }
});
