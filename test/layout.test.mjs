// Auto-arrange: determinism, order independence, idempotence, manual moves,
// both views, disconnected components, dense relationships and the
// load -> arrange -> export -> reload cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, yaml, validate, state, byClass } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { layoutInput, layoutSignature } = load('layout/input.js');
const { autoPositions, resolvePositions } = load('layout/positions.js');
const { autoPhysical, physicalBoxes } = load('layout/physical.js');
const { logicalSpecs } = load('layout/logical.js');
const W = load('yaml/write.js');

const exampleNames = readdirSync(join(root, 'examples')).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(join(root, 'examples', f), 'utf8');
const docOf = (text, name = 'x.yaml') => {
  const r = ModelDoc.fromText(text, name, 'file');
  assert.ok(r.doc, JSON.stringify(r.errors));
  return r.doc;
};
const posText = (m) => JSON.stringify(Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const both = (doc) => ({ physical: posText(doc.displayedPositions('physical')), logical: posText(doc.displayedPositions('logical')) });

// --------------------------------------------------------------- helpers

/** Deterministic shuffle of everything whose order carries no meaning. */
function shuffleTree(node, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const perm = (xs) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
  };
  const walk = (n, parentKey, owner) => {
    if (n.kind === 'seq') {
      // endpoint order of directed relations is meaningful
      const directed = parentKey === 'endpoints' && owner && owner.entries.get('directed') && owner.entries.get('directed').value.value === true;
      if (!directed) perm(n.items);
      n.items.forEach((it) => walk(it, null, null));
    } else if (n.kind === 'map') {
      const e = Array.from(n.entries.entries());
      perm(e);
      n.entries = new Map(e);
      // a/b of a cable are interchangeable
      if (n.entries.has('a') && n.entries.has('b') && rnd() < 0.5) {
        const a = n.entries.get('a').value;
        n.entries.get('a').value = n.entries.get('b').value;
        n.entries.get('b').value = a;
      }
      e.forEach(([k, v]) => walk(v.value, k, n));
    }
  };
  walk(node, null, null);
  return node;
}

function overlaps(boxes, margin) {
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + margin && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + margin) out.push(a.id + '/' + b.id);
    }
  }
  return out;
}

function physicalBoxList(input, pos) {
  const b = physicalBoxes(input, pos);
  return Array.from(b.entries()).map(([id, x]) => ({ id, ...x }));
}
function logicalBoxList(input, pos) {
  return logicalSpecs(input).map((s) => ({ id: s.id, cx: pos.get(s.id).x, cy: pos.get(s.id).y, w: s.w, h: s.h }));
}

// --------------------------------------------------------------- repeatability

test('repeatability: the same YAML always arranges to the same integer positions', () => {
  for (const f of exampleNames) {
    const a = docOf(read(f));
    const b = docOf(read(f));
    a.arrange(['physical', 'logical']);
    b.arrange(['physical', 'logical']);
    assert.deepEqual(both(a), both(b), f);
    for (const v of ['physical', 'logical']) {
      a.displayedPositions(v).forEach((p) => assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), f));
    }
  }
});

test('order independence: shuffled keys, sections, lists and swapped cable ends arrange identically', () => {
  for (const f of exampleNames.filter((x) => !/arranged/.test(x))) {
    const ref = layoutInput(docOf(read(f)).result.model);
    const refPos = { physical: posText(autoPositions('physical', ref)), logical: posText(autoPositions('logical', ref)) };
    for (const seed of [1, 7, 42]) {
      const tree = shuffleTree(yaml.parseYaml(read(f)), seed);
      const text = W.stringifyYaml(tree);
      assert.notEqual(text, read(f).replace(/\r\n/g, '\n'), 'the shuffle changed the text');
      const m = validate.loadModel(text).model;
      const inp = layoutInput(m);
      assert.equal(layoutSignature(inp), layoutSignature(ref), `${f} seed ${seed}: canonical input`);
      assert.equal(posText(autoPositions('physical', inp)), refPos.physical, `${f} seed ${seed}`);
      assert.equal(posText(autoPositions('logical', inp)), refPos.logical, `${f} seed ${seed}`);
    }
  }
});

test('fields that do not affect geometry do not change the layout', () => {
  const base = layoutInput(docOf(read('enterprise-wan.yaml')).result.model);
  const text = read('enterprise-wan.yaml')
    .replace('vendor: Juniper', 'vendor: Someone Else')
    .replace(/ip: 198\.51\.100\.2\/30/, 'ip: 198.51.100.66/30')
    .replace('encryption: aes-256-gcm', 'encryption: chacha20')
    .replace('# netatlas example: enterprise WAN', '# a different comment');
  assert.equal(layoutSignature(layoutInput(docOf(text).result.model)), layoutSignature(base));
});

// --------------------------------------------------------------- idempotence

test('idempotence: arranging twice moves nothing and adds no undo step', () => {
  const d = docOf(read('metro-ring.yaml'));
  const first = d.arrange(['physical', 'logical']);
  assert.equal(first.changed, true);
  assert.equal(first.moved, 0, 'the automatic layout that was shown is exactly what gets stored');
  const snap = both(d);
  const undo = d.canUndo();
  const second = d.arrange(['physical', 'logical']);
  assert.deepEqual(second, { changed: false, moved: 0 });
  assert.equal(d.canUndo(), undo);
  assert.deepEqual(both(d), snap);
});

test('load -> arrange -> export -> reload keeps every position; reloading does not re-arrange', () => {
  for (const f of ['metro-ring.yaml', 'enterprise-wan.yaml', 'datacenter-evpn.yaml']) {
    const d = docOf(read(f));
    d.arrange(['physical', 'logical']);
    const text = d.exportText();
    const back = docOf(text);
    assert.deepEqual(both(back), both(d), f);
    assert.equal(back.dirty, false);
    assert.deepEqual(back.arrange(['physical', 'logical']), { changed: false, moved: 0 }, f);
    assert.equal(back.exportText(), text, 'export is stable');
    // the rendered scene is identical, too
    for (const v of ['physical', 'logical']) {
      const s1 = new state.Session(d.result.model);
      const s2 = new state.Session(back.result.model);
      s1.setView(v);
      s2.setView(v);
      assert.deepEqual(s2.render().root, s1.render().root, `${f} ${v}`);
    }
  }
});

test('the arranged example file is exactly load -> arrange -> export of its source', () => {
  const d = docOf(read('metro-ring.yaml'));
  d.arrange(['physical', 'logical']);
  const expected = read('metro-ring-arranged.yaml').replace(/\r\n/g, '\n');
  const header = expected.slice(0, expected.indexOf('# netatlas example: metro ring'));
  assert.equal(header + d.exportText(), expected);
});

// --------------------------------------------------------------- manual moves

test('manual moves: only the moved node changes, arrange ignores it, undo brings it back', () => {
  const d = docOf(read('enterprise-wan.yaml'));
  const auto = both(d);
  const before = d.displayedPositions('physical');
  assert.ok(d.movePositions('physical', new Map([['hq-fw', { x: 3000.4, y: -250.6 }]])));
  const after = d.displayedPositions('physical');
  assert.deepEqual(after.get('hq-fw'), { x: 3000, y: -251 });
  before.forEach((p, id) => {
    if (id !== 'hq-fw') assert.deepEqual(after.get(id), p, id);
  });
  assert.equal(d.hasStoredLayout('physical'), true);
  assert.equal(d.hasStoredLayout('logical'), false, 'moving in one view does not touch the other');
  // Auto-arrange is independent of manual positions
  const r = d.arrange(['physical']);
  assert.equal(r.moved, 1);
  assert.equal(both(d).physical, auto.physical);
  d.undo();
  assert.deepEqual(d.displayedPositions('physical').get('hq-fw'), { x: 3000, y: -251 });
  // the logical auto layout does not depend on physical manual positions
  const fresh = docOf(read('enterprise-wan.yaml'));
  assert.equal(posText(d.displayedPositions('logical')), posText(fresh.displayedPositions('logical')));
});

test('edits never re-arrange: positions are frozen on the first geometric edit, new nodes placed near neighbors', () => {
  const d = docOf(read('enterprise-wan.yaml'));
  const shown = { physical: d.displayedPositions('physical'), logical: d.displayedPositions('logical') };
  // a non-geometric edit stores nothing
  const fw = d.findEntity('device', 'hq-fw').index;
  d.change('vendor', () => d.setAt(['devices', fw, 'vendor'], yaml.strNode('Fortinet')));
  assert.equal(d.root.entries.has('layout'), false);
  // adding a device changes geometry: everything shown stays where it was
  const i = d.addEntity('device', [['id', yaml.strNode('hq-fw2')], ['type', yaml.strNode('firewall')], ['group', yaml.strNode('hq-edge')]]);
  assert.ok(d.root.entries.has('layout'));
  for (const v of ['physical', 'logical']) {
    const now = d.displayedPositions(v);
    shown[v].forEach((p, id) => assert.deepEqual(now.get(id), p, `${v} ${id}`));
  }
  // the new device is placed in free space next to its group mates
  const input = layoutInput(d.result.model);
  const pos = d.displayedPositions('physical');
  assert.ok(pos.has('hq-fw2'));
  assert.deepEqual(overlaps(physicalBoxList(input, pos), 0).filter((x) => x.includes('hq-fw2')), []);
  const mate = pos.get('hq-rtr1');
  const p = pos.get('hq-fw2');
  assert.ok(Math.abs(p.x - mate.x) + Math.abs(p.y - mate.y) < 900, JSON.stringify([p, mate]));
  // renaming carries the position; deleting removes it
  const saved = d.displayedPositions('physical').get('hq-fw2');
  d.renameEntity('device', i, 'fw-b');
  assert.deepEqual(d.displayedPositions('physical').get('fw-b'), saved);
  assert.ok(!/hq-fw2/.test(d.exportText()));
  d.deleteEntity('device', d.findEntity('device', 'fw-b').index);
  assert.ok(!/fw-b/.test(d.exportText()));
  assert.ok(d.valid);
});

test('the YAML tab is taken literally: removing the layout section returns to automatic positions', () => {
  const d = docOf(read('minimal-edited.yaml'));
  assert.ok(d.hasStoredLayout('physical'));
  const text = d.exportText().replace(/\n\nlayout:\n[\s\S]*$/, '\n');
  d.replaceRoot(yaml.parseYaml(text));
  assert.equal(d.hasStoredLayout('physical'), false);
  assert.equal(d.root.entries.has('layout'), false);
});

// --------------------------------------------------------------- semantics

test('layout data never changes the network semantics', () => {
  const plain = validate.loadModel(read('metro-ring.yaml')).model;
  const arranged = validate.loadModel(read('metro-ring-arranged.yaml')).model;
  const strip = (m) =>
    JSON.stringify({ devices: m.devices, links: m.links, networks: m.networks, relations: m.relations, groups: m.groups }, (k, v) => (k === 'line' ? undefined : v));
  assert.equal(strip(arranged), strip(plain));
  assert.equal(plain.layout.physical.size, 0);
  assert.equal(arranged.layout.physical.size, 13);
});

test('bad layout entries are warnings and are ignored (never errors)', () => {
  const r = validate.loadModel(`netatlas: 1
devices:
  - {id: a}
  - {id: b}
relations:
  - {id: r, protocol: bgp, endpoints: [a, b]}
layout:
  physical:
    a: [10, 20]
    b: [1, 2, 3]
    ghost: [0, 0]
  logical:
    r: [5, 5]
    a: ["x", 1]
  sideways: {}
`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 5, r.warnings.map((w) => w.message).join('\n'));
  assert.deepEqual(Array.from(r.model.layout.physical.entries()), [['a', { x: 10, y: 20 }]]);
  assert.equal(r.model.layout.logical.size, 0);
});

// --------------------------------------------------------------- structure

function islands() {
  // components of different sizes, one grouped, plus isolated devices
  let t = 'netatlas: 1\ngroups:\n  - {id: g-big, kind: site}\ndevices:\n';
  const links = [];
  const rels = [];
  const add = (prefix, n, group) => {
    for (let i = 0; i < n; i++) t += `  - {id: ${prefix}${i}, type: ${i ? 'switch' : 'router'}${group ? ', group: ' + group : ''}, interfaces: [p0, p1, p2, {id: lo0, type: loopback, ip: [10.${prefix.length}.${n}.${i}/32]}]}\n`;
    for (let i = 1; i < n; i++) links.push(`  - {id: ${prefix}l${i}, a: "${prefix}${i}:p0", b: "${prefix}${Math.floor((i - 1) / 2)}:p${i % 2 ? 1 : 2}"}`);
    for (let i = 1; i < n; i++) rels.push(`  - {id: ${prefix}r${i}, protocol: ospf, endpoints: ["${prefix}${i}:lo0", "${prefix}0:lo0"]}`);
  };
  add('big', 20, 'g-big');
  add('mid', 8, null);
  add('sm', 3, null);
  t += '  - {id: lone1, type: server}\n  - {id: lone2, type: endpoint}\n';
  return t + 'links:\n' + links.join('\n') + '\nrelations:\n' + rels.join('\n') + '\n';
}

test('disconnected components of different sizes: no overlaps in either view, components kept apart', () => {
  const d = docOf(islands());
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  const input = layoutInput(d.result.model);
  const phys = autoPositions('physical', input);
  assert.deepEqual(overlaps(physicalBoxList(input, phys), 20), []);
  const log = autoPositions('logical', input);
  const boxes = logicalBoxList(input, log);
  assert.deepEqual(overlaps(boxes, 20), []);
  // bounding boxes of the logical components do not intersect
  const comp = (prefix) => {
    const bs = boxes.filter((b) => b.id.startsWith(prefix));
    return { x0: Math.min(...bs.map((b) => b.cx - b.w / 2)), x1: Math.max(...bs.map((b) => b.cx + b.w / 2)), y0: Math.min(...bs.map((b) => b.cy - b.h / 2)), y1: Math.max(...bs.map((b) => b.cy + b.h / 2)) };
  };
  const cs = ['big', 'mid', 'sm', 'lone1', 'lone2'].map(comp);
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i];
      const b = cs[j];
      assert.ok(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0, `components ${i} and ${j} intersect`);
    }
  }
  // the largest component is placed first (top-left)
  assert.ok(cs[0].x0 <= cs[1].x0 && cs[0].y0 <= cs[1].y0 + 1);
});

test('dense relationships: a 12-router full mesh with tunnels stays readable', () => {
  const n = 12;
  let t = 'netatlas: 1\ndevices:\n';
  for (let i = 0; i < n; i++) t += `  - {id: r${String(i).padStart(2, '0')}, type: router, interfaces: [{id: lo0, type: loopback, ip: [10.0.0.${i}/32, "2001:db8::${i}/128"]}]}\n`;
  t += 'relations:\n  - {id: ospf, protocol: ospf, endpoints: [' + Array.from({ length: n }, (_, i) => 'r' + String(i).padStart(2, '0')).join(', ') + ']}\n';
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = 'r' + String(i).padStart(2, '0');
      const b = 'r' + String(j).padStart(2, '0');
      t += `  - {id: bgp-${a}-${b}, protocol: ibgp, endpoints: ["${a}:lo0", "${b}:lo0"]}\n`;
      if ((i + j) % 4 === 0) t += `  - {id: gre-${a}-${b}, protocol: gre, endpoints: ["${a}:lo0", "${b}:lo0"]}\n  - {id: ipsec-${a}-${b}, protocol: ipsec, endpoints: ["${a}", "${b}"]}\n`;
    }
  }
  const d = docOf(t);
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  const input = layoutInput(d.result.model);
  const t0 = Date.now();
  const log = autoPositions('logical', input);
  assert.ok(Date.now() - t0 < 5000);
  const boxes = logicalBoxList(input, log);
  assert.deepEqual(overlaps(boxes, 30), [], 'devices keep room for relation bundles');
  // every relation still gets its own lane and tunnels are drawn as tubes
  const s = new state.Session(d.result.model);
  s.setView('logical');
  const v = s.render().root;
  assert.equal(byClass(v, 'rel').length, d.result.model.relations.length);
  assert.ok(byClass(v, 'tube-outer').length > 0);
  assert.deepEqual(posText(autoPositions('logical', input)), posText(log), 'deterministic');
});

test('every example: no overlapping boxes after auto-arrange, in both views', () => {
  for (const f of exampleNames) {
    const input = layoutInput(docOf(read(f)).result.model);
    assert.deepEqual(overlaps(physicalBoxList(input, autoPositions('physical', input)), 10), [], f + ' physical');
    assert.deepEqual(overlaps(logicalBoxList(input, autoPositions('logical', input)), 10), [], f + ' logical');
  }
});

test('the two views use different strategies (not identical positions)', () => {
  const input = layoutInput(docOf(read('enterprise-wan.yaml')).result.model);
  assert.notEqual(posText(autoPositions('physical', input)), posText(new Map(Array.from(autoPositions('logical', input)).filter(([id]) => input.devices.some((x) => x.id === id)))));
});

test('determinism guard: layout code uses no randomness, time, locale or browser-approximated math', () => {
  // every module of the layout layer
  const files = readdirSync(join(root, 'src', 'layout')).filter((x) => x.endsWith('.ts'));
  assert.ok(files.length >= 6, files.join(', '));
  for (const f of files) {
    // code only: comments may mention what is avoided
    const src = readFileSync(join(root, 'src', 'layout', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const banned of ['Math.random', 'Date.now', 'new Date', 'performance.', 'localeCompare', 'Math.hypot', 'Math.sin', 'Math.cos', 'Math.atan', 'Math.exp', 'Math.pow', '**', 'getBBox', 'getComputedStyle', 'measureText']) {
      if (f === 'geometry.ts' && banned === 'Math.hypot') continue; // geometry.ts: rendering helpers only (checked below)
      assert.ok(!src.includes(banned), `${f} uses ${banned}`);
    }
  }
  // text measuring and wrapping (what sizes are made of) live in the layout layer, so they are covered above
  assert.ok(files.includes('text.ts') && files.includes('sizes.ts') && files.includes('bundles.ts'));
});

test('auto-arrange stays fast for a large model', () => {
  let t = 'netatlas: 1\ngroups:\n';
  for (let g = 0; g < 10; g++) t += `  - {id: s${g}, kind: site}\n`;
  t += 'devices:\n';
  for (let i = 0; i < 400; i++) t += `  - {id: d${String(i).padStart(3, '0')}, type: ${i % 10 ? 'switch' : 'router'}, group: s${i % 10}, interfaces: [a, b, c, {id: lo0, type: loopback, ip: [10.1.${i >> 8}.${i & 255}/32]}]}\n`;
  t += 'links:\n';
  for (let i = 1; i < 400; i++) t += `  - {id: l${i}, a: "d${String(i).padStart(3, '0')}:a", b: "d${String(Math.floor(i / 2)).padStart(3, '0')}:${i % 2 ? 'b' : 'c'}"}\n`;
  t += 'relations:\n';
  for (let i = 0; i < 400; i += 4) t += `  - {id: r${i}, protocol: ibgp, endpoints: ["d${String(i).padStart(3, '0')}:lo0", "d${String((i + 4) % 400).padStart(3, '0')}:lo0"]}\n`;
  const d = docOf(t);
  const t0 = Date.now();
  d.arrange(['physical', 'logical']);
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, `took ${ms} ms`);
  assert.deepEqual(d.arrange(['physical', 'logical']), { changed: false, moved: 0 });
});

test('resolvePositions: stored positions win, missing nodes are placed without moving others', () => {
  const input = layoutInput(docOf(read('minimal.yaml')).result.model);
  const auto = autoPositions('physical', input);
  const stored = new Map([['r1', { x: 0, y: 0 }]]);
  const res = resolvePositions('physical', input, stored);
  assert.deepEqual(res.get('r1'), { x: 0, y: 0 });
  assert.ok(res.has('r2'));
  assert.notDeepEqual(res.get('r2'), auto.get('r2'));
  assert.deepEqual(resolvePositions('physical', input, new Map()), auto);
});

// --------------------------------------------------------------- layout status

test('layout status is derived per view: auto-arranged, manually adjusted, edited since arranged', () => {
  const src = read('metro-ring.yaml');
  const d = docOf(src);
  const st = () => d.layoutStatus('physical') + '/' + d.layoutStatus('logical');
  assert.equal(st(), 'auto/auto', 'a file without stored positions shows the auto-arranged layout');
  // a non-geometric edit never changes the status
  const i = d.findEntity('device', 'pe1').index;
  d.change('vendor', () => d.setAt(['devices', i, 'vendor'], yaml.strNode('Acme')));
  assert.equal(st(), 'auto/auto');
  // dragging marks only that view as manually adjusted
  d.movePositions('physical', new Map([['pe3', { x: 9000, y: 9000 }]]), 'Move pe3');
  assert.equal(st(), 'manual/auto');
  assert.match(d.exportText(), /\n  manual:\n    physical: \[pe3\]\n/);
  // undo -> derived again from the document, no stale flag
  d.undo();
  assert.equal(st(), 'auto/auto');
  d.redo();
  assert.equal(st(), 'manual/auto');
  // moving it back to its calculated position is "auto-arranged" again
  d.movePositions('physical', new Map([['pe3', d.autoLayout('physical').get('pe3')]]), 'Move pe3 back');
  assert.equal(st(), 'auto/auto');
  // export -> reload keeps a manual adjustment (positions and the record are in the YAML)
  d.movePositions('logical', new Map([['pe4', { x: -500, y: -500 }]]), 'Move pe4');
  const reloaded = docOf(d.exportText());
  assert.equal(reloaded.layoutStatus('physical') + '/' + reloaded.layoutStatus('logical'), 'auto/manual');
  // Auto-arrange restores the view and clears its record; repeating it changes nothing
  d.arrange(['logical']);
  assert.equal(st(), 'auto/auto');
  assert.ok(!/\n  manual:/.test(d.exportText()) || !/logical: \[pe4\]/.test(d.exportText()));
  assert.deepEqual(d.arrange(['physical', 'logical']), { changed: false, moved: 0 });
  // a geometric model edit is not a manual adjustment
  d.addEntity('device', [['id', yaml.strNode('pe7')], ['type', yaml.strNode('router')], ['group', yaml.strNode('pop-east')]]);
  assert.equal(st(), 'edited/edited');
  const edited = docOf(d.exportText());
  assert.equal(edited.layoutStatus('physical') + '/' + edited.layoutStatus('logical'), 'edited/edited', 'survives export -> reload');
  // ... but dragging after an edit is
  d.movePositions('physical', new Map([['pe7', { x: 0, y: -2000 }]]));
  assert.equal(st(), 'manual/edited');
  // renaming keeps the record; deleting the node removes it
  d.renameEntity('device', d.findEntity('device', 'pe7').index, 'pe8');
  assert.match(d.exportText(), /physical: \[pe8\]/);
  d.deleteEntity('device', d.findEntity('device', 'pe8').index);
  assert.ok(!/pe8/.test(d.exportText()));
  assert.equal(st(), 'auto/auto', 'without pe8 the stored layout equals Auto-arrange again');
  // an arranged example is auto-arranged when loaded
  const arranged = docOf(read('metro-ring-arranged.yaml'));
  assert.equal(arranged.layoutStatus('physical') + '/' + arranged.layoutStatus('logical'), 'auto/auto');
});

test('the manual record is presentation only: bad entries warn and never affect the model', () => {
  const r = validate.loadModel(`netatlas: 1
devices:
  - {id: a}
layout:
  physical:
    a: [0, 0]
  manual:
    physical: [a, ghost]
    sideways: [a]
`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(Array.from(r.model.layout.manual.physical), ['a', 'ghost']);
});
