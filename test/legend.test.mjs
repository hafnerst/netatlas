// The legend is defined once (diagram/legend.ts) and used twice: as HTML in
// the Legend tab and as SVG inside exported pictures. These tests cover the
// exported form: content, and a position that neither covers the diagram nor
// gets clipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames, state, scene, panels } from './helpers.mjs';

const legend = load('diagram/legend.js');
const { textWidth } = load('layout/geometry.js');

const ALL = { hiddenProtocols: new Set(), showNetworks: true, showUnderlay: false };
const texts = (v) => scene.findAll(v, (n) => n.tag === 'text').map((n) => n.text);
const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function exported(m, view, opts = ALL) {
  const s = new state.Session(m);
  s.setView(view);
  const bounds = s.render().bounds;
  return { bounds, ...legend.svgLegend(m, view, opts, bounds) };
}

test('every example, both views: the legend lies beside the diagram, inside the picture, and nothing is clipped', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    for (const view of ['physical', 'logical']) {
      const x = exported(m, view);
      const where = `${f} ${view}`;
      assert.ok(!overlap(x.box, x.bounds), where + ': legend overlaps the diagram');
      assert.ok(x.box.x >= x.bounds.x + x.bounds.w + legend.LEGEND_GAP - 0.01, where + ': to the right of everything drawn');
      assert.ok(inside(x.box, x.viewBox), where + ': legend inside the viewBox');
      assert.ok(inside(x.bounds, x.viewBox), where + ': diagram still inside the viewBox');
      assert.ok(x.viewBox.x + x.viewBox.w - (x.box.x + x.box.w) >= legend.LEGEND_GAP - 0.01, where + ': margin on the right');
      assert.ok(x.viewBox.y + x.viewBox.h - (x.box.y + x.box.h) >= legend.LEGEND_GAP - 0.01, where + ': margin below');
      // the background box is as large as the reported rectangle, and every label fits into it
      const rect = scene.findAll(x.root, (n) => scene.hasClass(n, 'lg-box'))[0];
      assert.deepEqual([Number(rect.attrs.width), Number(rect.attrs.height)], [x.box.w, Math.round(x.box.h * 10) / 10], where);
      for (const t of scene.findAll(x.root, (n) => n.tag === 'text' && n.attrs.x !== '22')) {
        const size = scene.hasClass(t, 'lg-label') ? 12 : scene.hasClass(t, 'lg-heading') ? 13 : 11;
        assert.ok(Number(t.attrs.x) + textWidth(t.text, size) <= x.box.w, `${where}: "${t.text}" is wider than the legend`);
        assert.ok(Number(t.attrs.y) > 0 && Number(t.attrs.y) < x.box.h, `${where}: "${t.text}" is outside the legend vertically`);
      }
    }
  }
});

test('a short diagram is made taller for a long legend; a large one keeps its size', () => {
  const small = exported(model(example('minimal.yaml')), 'logical');
  assert.ok(small.box.h + 2 * legend.LEGEND_GAP >= small.bounds.h, 'the legend is the taller part here');
  assert.equal(small.viewBox.h, small.box.h + 2 * legend.LEGEND_GAP);
  let t = 'netatlas: 1\ndevices:\n';
  for (let i = 0; i < 120; i++) t += `  - {id: d${i}, type: ${i % 2 ? 'router' : 'switch'}, interfaces: [e0, e1]}\n`;
  t += 'links:\n';
  for (let i = 0; i < 100; i += 2) t += `  - {id: l${i}, a: "d${i}:e0", b: "d${i + 1}:e0", medium: fiber}\n`;
  const big = exported(model(t), 'physical');
  assert.ok(big.bounds.w > 1500 || big.bounds.h > 1500, 'a large diagram with many disconnected components');
  assert.equal(big.viewBox.h, Math.max(big.bounds.h, big.box.h + 2 * legend.LEGEND_GAP));
  assert.ok(!overlap(big.box, big.bounds) && inside(big.box, big.viewBox));
  // legend sizes are in diagram units and don't depend on the diagram's size
  assert.equal(big.box.h, exported(model(t.replace(/  - \{id: d1[0-9][0-9].*\n/g, '')), 'physical').box.h);
});

test('physical legend in the SVG: device types, cable media, speed, ports, locations', () => {
  const m = model(example('enterprise-wan.yaml'));
  const t = texts(exported(m, 'physical').root);
  assert.equal(t[0], 'Legend — physical view');
  for (const want of ['DEVICES', 'Router', 'Switch', 'Firewall', 'CABLES (PHYSICAL LINKS)', 'Fiber', 'Copper', '1G (width grows with speed)', '100G', 'Port (label: interface name)', 'LOCATIONS / GROUPS', 'site', 'rack']) {
    assert.ok(t.includes(want), want + '\n' + t.join(' | '));
  }
  assert.ok(!t.some((x) => /mismatch/.test(x)), 'no mismatch symbol when no cable has one');
  const mm = model('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l, a: {device: a, interface: e0, vlans: [10]}, b: "b:e0"}\n');
  assert.ok(texts(exported(mm, 'physical').root).includes('VLAN mismatch between the two ends'));
  // symbols are real SVG content of the file (icons, lines), not references to the page
  const root = exported(m, 'physical').root;
  assert.ok(scene.findAll(root, (n) => scene.hasClass(n, 'icon')).length >= 5);
  assert.equal(scene.findAll(root, (n) => n.tag === 'use' || n.tag === 'image' || n.tag === 'foreignObject' || 'href' in n.attrs).length, 0);
});

test('logical legend in the SVG: the protocols that are drawn, with their line styles', () => {
  const m = model(example('enterprise-wan.yaml'));
  const all = texts(exported(m, 'logical').root);
  assert.equal(all[0], 'Legend — logical view');
  for (const want of ['IPsec', 'GRE', 'OSPF', 'MACsec *', 'Multipoint hub (3+ devices)', 'IP network', 'Network membership (from addresses)', '* defined in this file’s "protocols" section']) {
    assert.ok(all.includes(want), want + '\n' + all.join(' | '));
  }
  assert.ok(!all.includes('Physical adjacency (optional underlay)'), 'underlay is off');
  const root = exported(m, 'logical').root;
  assert.ok(scene.findAll(root, (n) => scene.hasClass(n, 'tube-outer')).length >= 2, 'tunnels keep their tube symbol');
  // what is switched off in the view is not in the picture, so it is not in its legend either
  const some = texts(exported(m, 'logical', { hiddenProtocols: new Set(['ospf', 'gre']), showNetworks: false, showUnderlay: true }).root);
  assert.ok(!some.includes('OSPF') && !some.includes('GRE') && some.includes('IPsec'));
  assert.ok(!some.includes('IP network') && !some.includes('Network membership (from addresses)'));
  assert.ok(some.includes('Physical adjacency (optional underlay)'));
});

test('the Legend tab and the SVG legend show the same entries', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    for (const view of ['physical', 'logical']) {
      const tab = scene.textOf(panels.legendFor(m, view, new Set()));
      for (const s of legend.legendOf(m, view).sections) {
        assert.ok(tab.includes(s.title), `${f} ${view}: tab lacks "${s.title}"`);
        for (const i of s.items.concat(s.more || [])) assert.ok(tab.includes(i.label), `${f} ${view}: tab lacks "${i.label}"`);
      }
      const svg = texts(exported(m, view, { ...ALL, showUnderlay: true }).root);
      for (const s of legend.legendOf(m, view).sections) {
        // (network symbols are left out of the picture's legend when the model has no network)
        for (const i of s.items) if (i.label !== '1G' && (m.networks.length || !/^IP network|^Network membership/.test(i.label))) assert.ok(svg.includes(i.label + (i.custom ? ' *' : '')), `${f} ${view}: SVG lacks "${i.label}"`);
      }
    }
  }
});
