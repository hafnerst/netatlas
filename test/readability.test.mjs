// Diagram sizing and readability: full text (no "…"), elements sized for
// their content, labels placed without collisions, straight point-to-point
// cables, and an Auto-arrange that depends only on the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames, state, scene } from './helpers.mjs';
import { geometry, problems, overlap, inside } from './scene-geometry.mjs';

const T = load('layout/text.js');
const S = load('layout/sizes.js');
const { layoutInput, layoutSignature } = load('layout/input.js');
const { autoPositions } = load('layout/positions.js');
const { ModelDoc } = load('editor/document.js');
const legend = load('diagram/legend.js');
const { addressAttrLines } = load('model/addresses.js');

const render = (m, view, opts = {}) => {
  const s = new state.Session(m);
  s.setView(view);
  Object.assign(s.state, opts);
  return s.render();
};
const long = () => model(example('long-labels.yaml'));
const posText = (m) => JSON.stringify(Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

// ------------------------------------------------------------------ wrapping

test('wrapText: explicit line breaks are kept, long lines wrap at spaces, nothing is dropped or replaced by "…"', () => {
  assert.deepEqual(T.wrapText('core-a\nCore switch A\r\n(rack 12)', 13, 220), ['core-a', 'Core switch A', '(rack 12)']);
  assert.deepEqual(T.wrapText('  a   b \n\n\n c\t d ', 13, 220), ['a b', 'c d'], 'white space is collapsed, empty lines are dropped');
  const text = 'Perimeter firewall cluster for the production and the pre-production environment (active/passive)';
  const lines = T.wrapText(text, 13, 220);
  assert.ok(lines.length >= 3);
  assert.equal(lines.join(' '), text, 'every word is still there, in order');
  for (const l of lines) assert.ok(T.textWidth(l, 13) <= 220, l);
  assert.deepEqual(T.wrapText('', 13, 220), []);
  assert.deepEqual(T.wrapText('short', 13, 220), ['short']);
});

test('wrapText: long text without spaces is broken, preferably after punctuation, and stays bounded', () => {
  const host = 'netapp-aff-a400-cluster01-node01.storage.infrastructure.example.internal';
  const lines = T.wrapText(host, 13, 220);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(''), host, 'no character lost, none added');
  for (const l of lines) assert.ok(T.textWidth(l, 13) <= 220, l);
  for (const l of lines.slice(0, -1)) assert.match(l, /[-.]$/, 'broken after punctuation: ' + l);
  // no break opportunity at all: broken by width
  const blob = 'X'.repeat(200);
  const b = T.wrapText(blob, 13, 220);
  assert.equal(b.join(''), blob);
  assert.ok(b.every((l) => T.textWidth(l, 13) <= 220) && b.length < 12);
  // wide (CJK) characters count as wide
  assert.ok(T.textWidth('網絡核心交換機', 13) > T.textWidth('abcdefg', 13) * 1.5);
  assert.ok(T.wrapText('網絡核心交換機'.repeat(6), 13, 220).length >= 2);
});

test('element sizes follow their text, within bounds', () => {
  const small = S.deviceBody('s', 'Server', 150, 54);
  assert.deepEqual([small.w, small.h], [150, 54], 'a short label keeps the minimum size');
  const multi = S.deviceBody('core-a\nCore switch A\n(rack 12, U30-U34)', 'Switch · core · Catalyst 9500-48Y4C', 150, 54);
  assert.deepEqual(multi.label.lines, ['core-a', 'Core switch A', '(rack 12, U30-U34)']);
  assert.ok(multi.h > small.h && multi.w > small.w);
  // the longest label the format allows (200 characters) gives a bounded box
  const huge = S.deviceBody('W'.repeat(200), 'x', 150, 54);
  assert.ok(huge.w <= S.DEVICE_TEXT_X + S.DEVICE_TEXT_MAX_W + 20, 'width is capped by the wrap width: ' + huge.w);
  assert.ok(huge.h < 300, 'height stays moderate: ' + huge.h);
  // a network shows its one prefix (and VLAN); a long label wraps
  assert.equal(S.networkSubtitle('10.0.2.0/24', 7), 'VLAN 7 · 10.0.2.0/24');
  assert.equal(S.networkSubtitle(undefined, 7), 'VLAN 7');
  const net = S.networkBody('Server network for the production hypervisor cluster in hall 2', S.networkSubtitle('2001:db8:aaaa:bbbb::/64', 7));
  assert.ok(net.label.lines.length >= 2 && net.h > 42);
  // a long relation label wraps inside its pill
  const pill = S.pillBox('IPsec › GRE › OSPF · IKEv2 site-to-site with certificate authentication');
  assert.ok(pill.block.lines.length === 2 && pill.w <= S.PILL_MAX_W + 16 && pill.h > 18);
});

// ------------------------------------------------------------- full text drawn

test('no diagram text is shortened: every example, both views, draws its labels in full', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    const flat = (s) => s.replace(/\s+/g, '');
    for (const view of ['physical', 'logical']) {
      const g = geometry(render(m, view).root);
      const all = scene.textOf(render(m, view).root);
      assert.ok(!/…|\.\.\.$/m.test(all.replace(/Auto-arrange…/g, '')), `${f} ${view}: an ellipsis is drawn`);
      for (const d of g.devices) {
        const dev = m.index.devices.get(d.ref.slice(7));
        const label = d.texts.find((t) => /dev-label/.test(t.cls));
        assert.equal(flat(label.lines.join('')), flat(dev.label), `${f} ${view}: label of ${dev.id}`);
      }
      for (const n of g.networks) {
        const nw = m.index.networks.get(n.ref.slice(8));
        assert.equal(flat(n.texts[0].lines.join('')), flat(nw.label));
        assert.ok(n.texts[1].lines.join(' ').includes(nw.cidr), `${f}: prefix ${nw.cidr} of ${nw.id} is shown`);
      }
      if (view === 'physical') {
        // the title, then the group's address-like attrs, each line whole
        for (const gr of g.groups) {
          const grp = m.index.groups.get(gr.ref.slice(6));
          assert.equal(flat(gr.title.lines.join('')), flat(grp.label + addressAttrLines(grp.attrs).join('')));
        }
        // every cable that has something to say is labelled (it used to be dropped when the cable was short)
        const labelled = new Set(g.linkLabels.map((l) => l.ref));
        for (const l of m.links) if (l.speed || l.label || l.a.networks.length) assert.ok(labelled.has('link:' + l.id), `${f}: cable ${l.id} has its label`);
      } else {
        const pills = new Set(g.pills.map((p) => p.ref));
        for (const r of m.relations) {
          if (new Set(r.endpoints.map((e) => e.device)).size < 2) continue;
          if (r.label) assert.ok(g.pills.some((p) => p.lines.join(' ').includes(r.label)), `${f}: label "${r.label}" is written out`);
        }
      }
    }
  }
});

test('multi-line and long labels: lines preserved, boxes grown, everything inside its box', () => {
  const m = long();
  for (const view of ['physical', 'logical']) {
    const g = geometry(render(m, view).root);
    const dev = (id) => g.devices.find((d) => d.ref === 'device:' + id);
    assert.deepEqual(dev('core-a').texts[0].lines, ['core-a', 'Core switch A', '(rack 12, U30-U34)'], 'explicit line breaks are kept');
    assert.deepEqual(dev('core-b').texts[0].lines, ['core-b', 'Core switch B']);
    assert.ok(dev('fw').texts[0].lines.length >= 3, 'a long label wraps');
    assert.ok(dev('storage').texts[0].lines.length >= 2, 'a long word is broken');
    assert.equal(dev('storage').texts[0].lines.join(''), m.index.devices.get('storage').label);
    // differing node sizes: the label part of a box grows with its lines (the entries with the
    // interfaces' addresses come on top of that), and every box holds its whole label
    const hs = ['srv', 'core-a', 'fw'].map((id) => dev(id).texts[0].rect.h);
    assert.ok(hs[0] < hs[1] && hs[1] < hs[2], 'label heights follow the text: ' + hs);
    for (const id of ['srv', 'core-a', 'fw']) assert.ok(dev(id).box.h >= dev(id).texts[0].rect.h + 16, id + ': the box is grown around its label');
    assert.ok(dev('srv').box.w < dev('fw').box.w);
    assert.ok(dev('fw').box.w <= 1200 && dev('fw').texts[0].rect.h <= 200, 'growth of the label is bounded');
    assert.deepEqual(problems(render(m, view).root), [], view);
  }
  const g = geometry(render(m, 'physical').root);
  const dc = g.groups.find((x) => x.ref === 'group:dc');
  assert.ok(dc.title.lines.length >= 1 && inside(dc.title.rect, dc.box), 'the long group title is inside its box');
  assert.equal(dc.title.lines.join(' '), m.index.groups.get('dc').label);
});

// ------------------------------------------------------ placement and routing

test('auto-arranged examples: text inside boxes, no overlapping labels, no label on a node, no cable through a device', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    for (const view of ['physical', 'logical']) assert.deepEqual(problems(render(m, view).root), [], `${f} ${view}`);
  }
});

test('several point-to-point cables between the same devices: parallel, straight, each with its own label', () => {
  const m = long();
  const g = geometry(render(m, 'physical').root);
  const peers = ['peer-1', 'peer-2', 'peer-3'].map((id) => g.cables.find((c) => c.ref === 'link:' + id));
  for (const c of peers) {
    assert.ok(c.straight && c.pts.length === 2, c.ref + ' is one straight segment');
    assert.equal(c.pts[0].y, c.pts[1].y, c.ref + ' is horizontal');
  }
  const ys = peers.map((c) => c.pts[0].y);
  assert.ok(ys[1] - ys[0] >= 20 && ys[2] - ys[1] >= 20, 'the cables are apart: ' + ys);
  const labels = ['peer-1', 'peer-2', 'peer-3'].map((id) => g.linkLabels.find((l) => l.ref === 'link:' + id));
  assert.deepEqual(labels.map((l) => l.lines.join(' ')), ['100G · peer link 1', '100G · peer link 2', '100G · keepalive']);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(!overlap(labels[i].rect, labels[j].rect));
  // each label lies on its own cable
  labels.forEach((l, i) => assert.ok(Math.abs(l.rect.y + l.rect.h / 2 - ys[i]) < 8, 'label ' + i + ' is on its cable'));
  // a long cable label wraps instead of being cut
  const uplink = g.linkLabels.find((l) => l.ref === 'link:srv-a');
  assert.ok(uplink.lines.length >= 2);
  assert.match(uplink.lines.join(' '), /25G · Server network \(production\), Server network \(production, IPv6\), Server network \(production, legacy IPv6 prefix\) · hypervisor uplink, all tenant VLANs/);
  // most cables of this example need no bend at all
  assert.ok(g.cables.filter((c) => c.straight).length >= 5, String(g.cables.filter((c) => c.straight).length));
  // port labels have room: none overlaps another one or a cable label
  const pl = g.portLabels;
  for (let i = 0; i < pl.length; i++) {
    for (let j = i + 1; j < pl.length; j++) assert.ok(!overlap(pl[i].rect, pl[j].rect, 1), `${pl[i].lines} / ${pl[j].lines}`);
    for (const l of g.linkLabels) assert.ok(!overlap(pl[i].rect, l.rect, 1), `${pl[i].lines} / ${l.lines}`);
  }
});

test('a cable that would cross a device bends around it; one that needs no bend has none', () => {
  // three devices in one row: the outer two are cabled, the middle one is in the way
  const m = model('netatlas: 1\ndevices:\n  - {id: a, type: switch, interfaces: [e0, e1]}\n  - {id: b, type: switch, interfaces: [e0, e1]}\n  - {id: c, type: switch, interfaces: [e0]}\nlinks:\n  - {id: ab, a: "a:e0", b: "b:e0"}\n  - {id: ac, a: "a:e1", b: "c:e0"}\n');
  const s = new state.Session(m);
  // put b exactly between a and c
  s.model.layout.physical = new Map([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }], ['c', { x: 800, y: 0 }]]);
  const g = geometry(s.render().root);
  const ac = g.cables.find((c) => c.ref === 'link:ac');
  const ab = g.cables.find((c) => c.ref === 'link:ab');
  assert.ok(ab.straight, 'a-b is straight');
  assert.ok(!ac.straight && ac.pts.length > 4, 'a-c bends: ' + JSON.stringify(ac.pts));
  assert.deepEqual(problems(s.render().root).filter((p) => /runs through/.test(p)), []);
});

test('multiple labelled relations between the same devices: one distinct, readable label each', () => {
  const m = long();
  const g = geometry(render(m, 'logical').root);
  const mine = ['ipsec-br', 'bgp-br', 'bfd-br', 'syslog-br'].map((id) => g.pills.find((p) => p.ref === 'relation:' + id));
  assert.deepEqual(mine.map((p) => p.lines.join(' ')), [
    'IPsec · IKEv2 site-to-site with certificate authentication › GRE · primary › OSPF · area 0.0.0.10',
    'eBGP · AS 65010 ↔ AS 65020',
    'BFD · 300 ms × 3',
    'Syslog · audit log',
  ]);
  assert.ok(mine[0].lines.length >= 2, 'the long one wraps inside its pill');
  // nested relations keep their own labels: they are named in their carrier's label
  assert.match(mine[0].lines.join(' '), /GRE · primary › OSPF · area 0\.0\.0\.10/);
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) assert.ok(!overlap(mine[i].box, mine[j].box), `${i}/${j}`);
  // no duplicates: nested relations are named in their carrier's label, not drawn a second time
  assert.equal(g.pills.filter((p) => /GRE/.test(p.lines.join(' '))).length, 1);
  assert.equal(new Set(g.pills.map((p) => p.ref)).size, g.pills.length);
  // their lanes are distinct lines
  const lanes = ['ipsec-br', 'bgp-br', 'bfd-br', 'syslog-br'].map((id) => JSON.stringify(g.rels.find((r) => r.ref === 'relation:' + id).pts));
  assert.equal(new Set(lanes).size, 4);
  // the two devices are far enough apart for the labels
  const a = g.devices.find((d) => d.ref === 'device:fw').box;
  const b = g.devices.find((d) => d.ref === 'device:br-rtr').box;
  const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  assert.ok(gapX >= 250 || gapY >= 100, `room between the devices: ${gapX} x ${gapY}`);
});

test('labels stay apart with labels off/on and when protocols are hidden', () => {
  const m = long();
  assert.equal(geometry(render(m, 'logical', { showLabels: false }).root).pills.length, 0);
  assert.equal(geometry(render(m, 'physical', { showLabels: false }).root).linkLabels.length, 0);
  assert.deepEqual(problems(render(m, 'logical', { hiddenProtocols: new Set(['ipsec', 'ospf']) }).root), []);
});

// -------------------------------------------------------------- determinism

test('auto-arrange depends only on the model: not on dragging, selection or a previous arrange', () => {
  for (const f of ['long-labels.yaml', 'enterprise-wan.yaml']) {
    const fresh = () => ModelDoc.fromText(example(f), f, 'file').doc;
    const ref = fresh();
    ref.arrange(['physical', 'logical']);
    const want = { physical: posText(ref.displayedPositions('physical')), logical: posText(ref.displayedPositions('logical')) };
    // drag things around first, select, arrange one view at a time
    const d = fresh();
    const dev = d.result.model.devices[0].id;
    d.movePositions('physical', new Map([[dev, { x: 1234, y: -567 }]]));
    d.movePositions('logical', new Map([[dev, { x: -900, y: 800 }]]));
    const s = new state.Session(d.result.model);
    s.select('device:' + dev);
    s.render();
    d.arrange(['logical']);
    d.arrange(['physical']);
    assert.equal(posText(d.displayedPositions('physical')), want.physical, f);
    assert.equal(posText(d.displayedPositions('logical')), want.logical, f);
    // arranging again moves nothing
    assert.deepEqual(d.arrange(['physical', 'logical']), { changed: false, moved: 0 });
    // and the drawn routes and label positions are the same too
    const draw = (doc, view, sel) => {
      const ses = new state.Session(doc.result.model);
      ses.setView(view);
      if (sel) ses.select(sel);
      return JSON.stringify(ses.render().root);
    };
    for (const view of ['physical', 'logical']) {
      assert.equal(draw(d, view, 'device:' + dev), draw(ref, view, null), `${f} ${view}: same picture, whatever is selected`);
      assert.equal(draw(d, view), draw(ModelDoc.fromText(d.exportText(), f, 'file').doc, view), `${f} ${view}: same picture after export and reload`);
    }
  }
});

test('sizes are part of the layout input: text that changes a box changes the layout, other text does not', () => {
  const base = example('long-labels.yaml');
  const sig = (t) => layoutSignature(layoutInput(model(t)));
  assert.notEqual(sig(base.replace('label: Branch router', 'label: Branch router with a considerably longer name')), sig(base));
  assert.notEqual(sig(base.replace('type: firewall', 'type: load_balancer')), sig(base), 'the subtitle (the type) is drawn, so it counts');
  assert.notEqual(sig(base.replace('label: peer link 1', 'label: a much longer label for this cable')), sig(base), 'cable labels need room');
  assert.notEqual(sig(base.replace('label: area 0.0.0.10', 'label: area 0.0.0.10 (totally stubby)')), sig(base), 'relation labels need room');
  // the cable id is an identifier: it is written under the cable's label, so it needs room too
  assert.notEqual(sig(base.replace('cable: CID-2024-000173', 'cable: CID-2024-000173-and-a-patch-panel-port')), sig(base), 'the cable id is drawn, so it counts');
  assert.equal(sig(base.replace('title: Long labels and mixed node sizes', 'title: something else')), sig(base), 'text that is not drawn does not count');
  assert.equal(sig(base.replace('medium: dac, speed: 100G, label: keepalive', 'medium: fiber, speed: 100G, label: keepalive')), sig(base));
  // a bigger box moves its neighbors, deterministically
  const a = autoPositions('physical', layoutInput(model(base)));
  const b = autoPositions('physical', layoutInput(model(base.replace('label: Branch router', 'label: Branch router with a considerably longer name'))));
  assert.notEqual(posText(a), posText(b));
  assert.equal(posText(a), posText(autoPositions('physical', layoutInput(model(base)))));
});

test('standalone SVG export: legend placement still clears the (larger) diagram, labels included in the bounds', () => {
  const m = long();
  for (const view of ['physical', 'logical']) {
    const r = render(m, view);
    const g = geometry(r.root);
    const b = r.bounds;
    const within = (x) => inside(x, b, 0);
    for (const x of g.devices.map((d) => d.box).concat(g.pills.map((p) => p.box), g.linkLabels.map((l) => l.rect), g.memberLabels.map((l) => l.rect), g.portLabels.map((l) => l.rect), g.groups.map((gr) => gr.box))) {
      assert.ok(within(x), `${view}: ${JSON.stringify(x)} outside ${JSON.stringify(b)}`);
    }
    for (const c of g.cables) for (const p of c.pts) assert.ok(p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h, 'cable bend inside the bounds');
    const lg = legend.svgLegend(m, view, { hiddenProtocols: new Set(), showNetworks: true, showGroups: true }, b);
    assert.ok(lg.box.x >= b.x + b.w && inside(lg.box, lg.viewBox) && inside(b, lg.viewBox));
  }
});
