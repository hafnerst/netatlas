// The three Auto-arrange presets on screen (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one), light and dark at
// 1440 × 900 and light at 720 × 450 (a page zoomed to 200 %):
//   - the buttons Default, Compact, Structured in the toolbar, each with a
//     hover text that says what it does; Structured chosen by the keyboard;
//   - private-house.yaml arranged with each: Compact's picture smaller than
//     Default's, Structured's cables all horizontal and vertical with sharp
//     (mitred) corners, in the browser's own geometry;
//   - the export (SVG, and the PNG made from it) shows the same routes as
//     the screen, the corners mitred in the file too (round only after
//     Default);
//   - a device dragged after Structured: its cables are routed again at
//     right angles; undo brings the arranged picture back; Default brings
//     back the standard routing (round joins);
//   - nothing scrolls sideways, the toolbar stays within the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** the cables on screen: their path data and computed line join */
const CABLES = `Array.from(document.querySelectorAll('#canvas .cable-line')).map((p) => ({ ref: p.closest('[data-ref]').getAttribute('data-ref'), d: p.getAttribute('d'), join: getComputedStyle(p).strokeLinejoin }))`;
const BOUNDS = `(() => { const b = document.querySelector('#canvas .scene').getBBox(); return b.width * b.height; })()`;
const NO_SIDEWAYS = `(() => { const out = []; for (const e of [document.scrollingElement, document.querySelector('header.topbar')]) if (e && e.scrollWidth > e.clientWidth + 1) out.push(e.tagName); const g = document.getElementById('arrange-group').getBoundingClientRect(); if (g.right > innerWidth + 0.5) out.push('arrange group'); return out; })()`;
const straight = (d) => {
  const n = (d.match(/-?[\d.]+/g) || []).map(Number);
  for (let k = 0; k + 3 < n.length; k += 2) if (Math.abs(n[k] - n[k + 2]) > 0.15 && Math.abs(n[k + 1] - n[k + 3]) > 0.15) return false;
  return /^M[^A-Za-z]*(L[^A-Za-z]*)*$/.test(d);
};

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]].slice(0, process.env.ONE ? 1 : 3)) {
  test(`${theme}, ${width} × ${height}: Default, Compact and Structured on screen, in the export, after a move and undo`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(200);
      // the three options, each saying what it does
      const btns = await page.eval(`Array.from(document.querySelectorAll('#arrange-group .arrange-btn')).map((b) => ({ s: b.getAttribute('data-strategy'), text: b.textContent, title: b.title, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled }))`);
      assert.deepEqual(btns.map((b) => b.text), ['Default', 'Compact', 'Structured']);
      assert.deepEqual(btns.map((b) => b.pressed), ['true', 'false', 'false'], 'a model without stored positions shows Default');
      assert.match(btns[1].title, /^Compact: packed tight/);
      assert.match(btns[2].title, /^Structured: rows and columns.*right-angle bends/);
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);
      const def = await page.eval(CABLES);
      const defArea = await page.eval(BOUNDS);
      assert.ok(def.some((c) => !straight(c.d)), 'Default has diagonal cables');
      assert.ok(def.every((c) => c.join === 'round'));

      // Compact: the drawn picture is smaller
      await page.eval(`document.getElementById('btn-arrange-compact').click(), true`);
      await page.settle(200);
      const cArea = await page.eval(BOUNDS);
      assert.ok(cArea < defArea * 0.9, `compact ${Math.round(cArea)} < default ${Math.round(defArea)}`);

      // Structured, by the keyboard: focus the button, Enter
      await page.eval(`document.getElementById('btn-arrange-structured').focus(), true`);
      await page.key('Enter', 'Enter', 13);
      await page.settle(250);
      assert.equal(await page.eval(`document.getElementById('btn-arrange-structured').getAttribute('aria-pressed')`), 'true');
      const st = await page.eval(CABLES);
      assert.equal(st.length, def.length);
      for (const c of st) {
        assert.ok(straight(c.d), `${c.ref}: ${c.d}`);
        assert.equal(c.join, 'miter', c.ref);
      }
      assert.match(await page.eval(`netatlas.exportText()`), /\n {2}routing: \{physical: orthogonal\}\n/);
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);

      // the export: the same routes, mitred in the file (the file carries resolved styles, no stylesheet)
      const svg = await page.eval(`netatlas.exportSvg()`);
      const exported = [...svg.matchAll(/<path class="cable-line"[^>]*>/g)].map((m) => m[0]);
      assert.equal(exported.length, st.length);
      for (const p of exported) {
        const d = /\sd="([^"]+)"/.exec(p)[1];
        assert.ok(st.some((c) => c.d === d), 'the exported route is the one on screen');
        // (the file writes a style only where it differs from the element around it: mitred is SVG's own default)
        assert.doesNotMatch(p, /stroke-linejoin="(round|bevel)"/);
      }
      const png = await page.eval(`netatlas.exportPng().then((p) => p.width > 0 && p.height > 0)`, true);
      assert.equal(png, true);

      // a device dragged (as the editor stores a drag): routed again at right angles, nothing else moved; undo
      const moved = await page.eval(`(() => { const d = netatlas.mdoc; const pos = d.displayedPositions('physical'); const p = pos.get('nas'); d.movePositions('physical', new Map([['nas', { x: p.x + 150, y: p.y + 40 }]]), 'Move nas'); netatlas.afterEdit(); return true; })()`);
      assert.equal(moved, true);
      await page.settle(200);
      const after = await page.eval(CABLES);
      for (const c of after) assert.ok(straight(c.d) && c.join === 'miter', `after the move: ${c.ref}`);
      assert.equal(await page.eval(`document.querySelector('#arrange-group .arrange-btn[aria-pressed="true"]')`), null);
      assert.match(await page.eval(`document.getElementById('arrange-status').textContent`), /keep the right angles of Structured/);
      await page.eval(`netatlas.undo(), true`);
      await page.settle(200);
      assert.deepEqual((await page.eval(CABLES)).map((c) => c.d), st.map((c) => c.d), 'undo: the arranged picture again');

      // Default: the standard routing again (and its own picture, as before)
      await page.eval(`document.getElementById('btn-arrange-default').click(), true`);
      await page.settle(200);
      const back = await page.eval(CABLES);
      assert.deepEqual(back.map((c) => c.d), def.map((c) => c.d));
      assert.ok(back.every((c) => c.join === 'round'));
      assert.match(await page.eval(`netatlas.exportSvg()`), /<path class="cable-line"[^>]*stroke-linejoin="round"/);
      assert.doesNotMatch(await page.eval(`netatlas.exportText()`), /\n {2}routing:/);

      // the logical view: Structured there too, relations at right angles
      await page.eval(`netatlas.setView('logical'), true`);
      await page.settle(150);
      await page.eval(`document.getElementById('btn-arrange-structured').click(), true`);
      await page.settle(250);
      const rels = await page.eval(`Array.from(document.querySelectorAll('#canvas .rel-line, #canvas .tube-outer, #canvas .member')).map((p) => ({ d: p.getAttribute('d'), join: getComputedStyle(p).strokeLinejoin }))`);
      assert.ok(rels.length > 0);
      for (const r of rels) assert.ok(straight(r.d) && r.join === 'miter', r.d);
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);
    } finally {
      await page.close();
    }
  });
}
