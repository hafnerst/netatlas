// The stacking order in a running protocol simulation, with real input
// (headless Chrome/Edge/Chromium through the DevTools protocol; skipped
// without one): every main menu, the Export submenu, the diagram filters,
// the command palette, the in-diagram menu and the packet inspector are in
// front of the simulation border and clickable at their edges
// (elementFromPoint at each corner and edge finds them, not the border);
// the border never catches a click; it is a thin solid border with a
// "Simulation running" label, at least 3:1 against the canvas in both
// themes; the z-index scale is the only one the stylesheet uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

test('one z-index scale: diagram overlays < panels < toolbar < menus and popovers < tooltips < dialogs < announcements; no other numbers but local orders', () => {
  const scale = {};
  for (const m of css.matchAll(/--z-([a-z]+): (\d+);/g)) scale[m[1]] = Number(m[2]);
  const order = ['overlay', 'panel', 'toolbar', 'menu', 'tooltip', 'dialog', 'announce'];
  assert.deepEqual(Object.keys(scale), order);
  for (let i = 1; i < order.length; i++) assert.ok(scale[order[i]] > scale[order[i - 1]] + 2, order[i]);
  // what uses numbers of its own orders only within one component (0–3)
  for (const m of css.matchAll(/z-index:\s*(\d+)/g)) assert.ok(Number(m[1]) <= 3, m[0]);
  // the simulation border: thin, solid, inside the diagram's edge, an overlay that never catches a click
  const rule = /body\[data-mode~="simulation"\] #canvas-wrap::after \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /pointer-events: none/);
  assert.match(rule, /z-index: var\(--z-overlay\)/);
  assert.match(rule, /inset 0 0 0 2px var\(--sim\)/);
  assert.doesNotMatch(css, /repeating-linear-gradient\(45deg, var\(--sim\)/, 'no hatching any more');
  // the menus' layer
  assert.match(/\.dropdown \{([^}]*)\}/.exec(css)[1], /z-index: var\(--z-menu\)/);
  for (const sel of ['.sim-menu', '.sim-table-panel', 'ul.combo-list', '.tabs-more-menu', '.snd-menu']) assert.match((new RegExp(sel.replace('.', '\\.') + ' \\{[^}]*z-index: var\\(--z-menu\\)').exec(css) || [''])[0], /z-index/, sel);
});

test('the simulation border is at least 3:1 against the canvas (and the panels) in both themes', () => {
  const P = load('diagram/palette.js');
  const block = (name) => new RegExp(`:root\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`).exec(css)[1];
  for (const name of ['light', 'dark']) {
    const b = block(name);
    const v = (k) => new RegExp(`--${k}: (#[0-9a-f]{6});`).exec(b)[1];
    for (const bg of ['canvas', 'panel', 'raised']) assert.ok(P.contrast(v('sim'), v(bg)) >= 3, `${name}: --sim on --${bg} ${P.contrast(v('sim'), v(bg)).toFixed(2)}:1`);
  }
});

/** What elementFromPoint finds at the corners and edges of an element (2 px inside), each as "inside" or what it hit. */
const EDGES = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  // (the corners 6 px inside: a rounded corner's 2 px are outside its shape, and a click there passes through)
  const pts = [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6], [(r.left + r.right) / 2, r.top + 2], [r.left + 2, (r.top + r.bottom) / 2], [r.right - 2, (r.top + r.bottom) / 2], [(r.left + r.right) / 2, r.bottom - 2]];
  return pts.filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight).map(([x, y]) => { const h = document.elementFromPoint(x, y); return h && e.contains(h) ? 'inside' : (h ? (h.id || h.className || h.tagName) : 'none'); });
})()`;

/** Does the element overlap the diagram's area (where the border is)? */
const OVER = (sel) => { const a = document.querySelector(sel).getBoundingClientRect(); const c = document.getElementById('canvas-wrap').getBoundingClientRect(); return a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top; };

for (const dark of [false, true]) {
  test(`in a running simulation (${dark ? 'dark' : 'light'}): every menu, submenu, the palette, the in-diagram menu and the packet inspector are in front of the simulation border and clickable at their edges`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1280, height: 800, dark });
    try {
      await page.settle(150);
      const ex = 'protocol-simulation.yaml';
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
      await page.eval(`document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(dark ? 'dark' : 'light')} && document.getElementById('theme-btn').click(), true`);
      await page.settle(100);
      await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(15000), true`);
      await page.settle(200);
      // the indicator: the border (a computed inset shadow) and the label, readable
      const ind = await page.eval(`(() => { const s = getComputedStyle(document.getElementById('canvas-wrap'), '::after'); const b = document.getElementById('sim-badge'); return { shadow: s.boxShadow, pe: s.pointerEvents, label: b.hidden ? '' : b.textContent.trim(), labelVisible: b.getBoundingClientRect().width > 0 }; })()`);
      assert.match(ind.shadow, /inset/);
      assert.match(ind.shadow, /2px/);
      assert.equal(ind.pe, 'none');
      assert.equal(ind.label, '◈ Simulation running');
      assert.equal(ind.labelVisible, true);
      // the border never catches a click: at the diagram's very edge the diagram (or what is drawn there) is hit
      // (at the bottom edge the simulation panel's splitter reaches over it: a panel, above the overlays)
      const edge = await page.eval(`(() => { const c = document.getElementById('canvas-wrap').getBoundingClientRect(); const pts = [[c.left + 1, c.top + c.height / 2], [c.right - 1, c.top + c.height / 2]]; return pts.map(([x, y]) => { const h = document.elementFromPoint(x, y); return !!h && document.getElementById('canvas').contains(h); }); })()`);
      assert.deepEqual(edge, [true, true], 'the diagram itself under the border');
      // every main menu and the filters' panels
      const over = [];
      for (const [btn, menu] of [['menu-btn', 'main-menu'], ['export-btn', 'export-menu'], ['find-btn', 'find-menu'], ['analyze-btn', 'analyze-menu'], ['simulate-btn', 'simulate-menu'], ['help-btn', 'help-menu'], ['devices-btn', 'devices-panel'], ['types-btn', 'types-panel'], ['more-filters-btn', 'more-filters']]) {
        // (a filter's button shows only when the toolbar has room for it, or only when it hasn't)
        if (!(await page.eval(`document.getElementById(${JSON.stringify(btn)}).getClientRects().length > 0`))) continue;
        await page.click('#' + btn);
        await page.settle(80);
        assert.equal(await page.eval(`!document.getElementById(${JSON.stringify(menu)}).hidden`), true, `${menu} open`);
        if (await page.call(OVER, '#' + menu)) over.push(menu);
        const hits = await page.eval(EDGES('#' + menu));
        assert.ok(hits.length >= 4 && hits.every((h) => h === 'inside'), `${menu}: ${hits.join(', ')}`);
        // clickable at its edge: the first item there gets the click (pointer-events reach it)
        const item = await page.call((menu) => { const m = document.getElementById(menu); const i = m.querySelector('button:not([disabled]), input, select'); if (!i) return null; const r = i.getBoundingClientRect(); const h = document.elementFromPoint(r.left + 3, r.top + r.height / 2); return !!h && i.contains(h); }, menu);
        if (item !== null) assert.equal(item, true, `${menu}: its first control takes the click`);
        if (menu === 'export-menu') {
          // the submenu: Export view as ▸ opens under its entry
          const can = await page.eval(`!document.getElementById('btn-export-as').disabled`);
          if (can) {
            await page.click('#btn-export-as');
            await page.settle(80);
            const sub = await page.eval(EDGES('#export-formats'));
            assert.ok(sub && sub.every((h) => h === 'inside'), `export submenu: ${sub}`);
          }
        }
        await page.key('Escape', 'Escape', 27);
        await page.settle(60);
      }
      assert.ok(over.length >= 4, `menus reaching over the diagram (and its border): ${over.join(', ')}`);
      // the command palette (a dialog)
      await page.eval(`document.getElementById('canvas').focus(), true`);
      await page.key('k', 'KeyK', 75, 2);
      await page.settle(120);
      const pal = await page.eval(`document.getElementById('modal').open && document.getElementById('modal').classList.contains('palette-dialog')`);
      assert.equal(pal, true, 'the palette is open');
      const ph = await page.eval(EDGES('#modal'));
      assert.ok(ph.every((h) => h === 'inside'), `palette: ${ph}`);
      await page.key('Escape', 'Escape', 27);
      await page.settle(80);
      // the in-diagram menu, right at the diagram's left edge (over the border)
      await page.eval(`(() => { const c = document.getElementById('canvas-wrap').getBoundingClientRect(); netatlas.simController().openMenu('Edge test', [{ label: 'First', act: () => {} }, { label: 'Second', act: () => {} }], c.left + 1, c.top + 40); return true; })()`);
      await page.settle(80);
      const mh = await page.eval(EDGES('.sim-menu'));
      assert.ok(mh && mh.every((h) => h === 'inside'), `in-diagram menu: ${mh}`);
      await page.key('Escape', 'Escape', 27);
      // the packet inspector, placed at the diagram's corner
      const fid = await page.eval(`(() => { const c = netatlas.simController(); const f = c.sim.engine.flights.find((x) => x.hdr); return f ? f.id : -1; })()`);
      assert.ok(fid >= 0);
      await page.eval(`(() => { const c = document.getElementById('canvas-wrap').getBoundingClientRect(); return netatlas.simController().inspectFlight(${fid}, { x: c.left, y: c.top, w: 4, h: 4 }); })()`);
      await page.settle(120);
      const pi = await page.eval(EDGES('.sim-table-panel[data-table="packet"]'));
      assert.ok(pi && pi.every((h) => h === 'inside'), `packet inspector: ${pi}`);
      const close = await page.eval(`(() => { const b = document.querySelector('.sim-table-panel[data-table="packet"] button'); const r = b.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return b.contains(h); })()`);
      assert.equal(close, true, 'its buttons take clicks');
    } finally {
      await page.close();
    }
  });
}
