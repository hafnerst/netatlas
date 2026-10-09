// The segmented controls of the toolbar (View, Auto-arrange) and the buttons
// of the Filters group: every segment shows a complete border on all four
// sides in every state (normal, hover, keyboard focus, pressed, selected,
// disabled), in both themes, at normal and narrow widths and at browser zoom
// 100 %, 125 %, 150 % and 200 %. Neighbouring segments share one border column
// (margin-left: -1px); a segment whose border changes must be drawn above
// its neighbours there. Checked in the DOM (what is on top at each edge) and
// in the pixels of a screenshot. Headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped when none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const SEGMENTS = '#view-group .seg button, #arrange-group .arrange-btn, #filters-group button:not([hidden])';

test('stylesheet: a segment whose border changes is lifted above its neighbours (stacking only: no size or position change)', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.seg button, \.arrange-btn \{ position: relative; z-index: 0; \}/);
  assert.match(css, /\.seg button\.active, \.arrange-btn\.current, \.arrange-btn\.current:disabled \{ z-index: 1; \}/);
  assert.match(css, /\.seg button:hover:not\(:disabled\), \.arrange-btn:hover:not\(:disabled\) \{ z-index: 2; \}/);
  assert.match(css, /\.seg button:focus-visible, \.arrange-btn:focus-visible \{ z-index: 3; \}/);
  // the more visible dashed group frames stay
  assert.match(css, /\.tool-group \{[^}]*border: 1px dashed var\(--frame\);/);
});

/**
 * In the page: the edges of the segments that a reader would see broken. Two
 * neighbours share one border column, which can only show one of them. At a
 * point just inside each edge, the topmost element must be the segment
 * itself, or a neighbour that draws a border there and is in a state at
 * least as prominent (keyboard focus > hover or pressed > selected > plain;
 * the state is read from what the element matches, not from the stylesheet's
 * stacking order), or whose border there looks the same. A segment whose
 * state shows in its border, covered by a plainer neighbour, is the bug.
 */
const BROKEN = `((sel) => {
  const side = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const look = (e, s) => { const cs = getComputedStyle(e); return cs['border' + cap(s) + 'Color'] + ' ' + cs['border' + cap(s) + 'Width'] + ' ' + cs.opacity; };
  const rank = (e) => (e.matches(':focus-visible') ? 3 : e.matches(':hover:not(:disabled), :active:not(:disabled)') ? 2 : e.matches('.active, .current') ? 1 : 0);
  const out = [];
  for (const b of document.querySelectorAll(sel)) {
    const r = b.getBoundingClientRect();
    if (!r.width) continue;
    const pts = { left: [r.left + 0.5, r.top + r.height / 2], right: [r.right - 0.5, r.top + r.height / 2], top: [r.left + r.width / 2, r.top + 0.5], bottom: [r.left + r.width / 2, r.bottom - 0.5] };
    for (const s of Object.keys(pts)) {
      const t = document.elementFromPoint(pts[s][0], pts[s][1]);
      const tb = t && t.closest('button');
      if (tb === b) continue;
      if (tb && look(tb, side[s]) === look(b, s)) continue;
      if (tb && parseFloat(getComputedStyle(tb)['border' + cap(side[s]) + 'Width']) > 0 && rank(tb) >= rank(b)) continue;
      out.push((b.textContent || b.id).trim().slice(0, 12) + ' ' + s + ' (covered by ' + (tb ? (tb.textContent || tb.id).trim().slice(0, 12) : t && t.tagName) + ')');
    }
  }
  return out;
})`;

/** In the page: the colours of the device pixels x0 … x1 of row y of a PNG given as base64. */
const PIXELS = `((b64, x0, x1, y) => new Promise((ok) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const out = []; for (let x = x0; x <= x1; x++) out.push(Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3)); ok(out); }; im.src = 'data:image/png;base64,' + b64; }))`;
const rgb = (v) => (/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(v) || []).slice(1, 4).map(Number);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('every segment has a complete border in every state, both themes, normal and narrow widths, zoom 100–200 %', { skip, timeout: 600000 }, async () => {
  const page = await openPage(url);
  const problems = [];
  try {
    for (const theme of ['dark', 'light']) {
      for (const [W, H] of [[1440, 900], [800, 760]]) {
        for (const z of [1, 1.25, 1.5, 2]) {
          const where = `${theme} ${W}px ${Math.round(z * 100)} %`;
          await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
          // disabled: no model yet
          await page.eval(`netatlas.closeModel(), netatlas.theme.set('${theme}'), true`);
          await page.settle(80);
          for (const p of await page.eval(`${BROKEN}(${JSON.stringify(SEGMENTS)})`)) problems.push(`${where} disabled: ${p}`);
          // normal and selected (Physical, the option the view is arranged with)
          await page.eval(`netatlas.loadExample(0), netatlas.setView('physical'), true`);
          await page.mouse('mouseMoved', 5, Math.round(H / z) - 5);
          await page.settle(80);
          for (const p of await page.eval(`${BROKEN}(${JSON.stringify(SEGMENTS)})`)) problems.push(`${where} normal: ${p}`);
          const segs = await page.eval(`[...document.querySelectorAll('#view-group .seg button, #arrange-group .arrange-btn')].map((b, i) => ({ i, sel: b.id ? '#' + b.id : '[data-view-btn="' + b.getAttribute('data-view-btn') + '"]', disabled: b.disabled }))`);
          for (const sg of segs.filter((x) => !x.disabled)) {
            // hover
            await page.hover(sg.sel);
            for (const p of await page.eval(`${BROKEN}(${JSON.stringify(SEGMENTS)})`)) problems.push(`${where} hover ${sg.sel}: ${p}`);
            // … and the pixels: the right border of the hovered segment has its hover colour, not its neighbour's
            const g = await page.eval(`(() => { const b = document.querySelector(${JSON.stringify(sg.sel)}); const n = b.nextElementSibling; const r = b.getBoundingClientRect(); return { r: { x: r.left, y: r.top, w: r.width, h: r.height }, own: getComputedStyle(b).borderRightColor, other: n ? getComputedStyle(n).borderLeftColor : null }; })()`);
            if (g.other && dist(rgb(g.own), rgb(g.other)) > 30) {
              const clip = { x: Math.floor(g.r.x) - 2, y: Math.floor(g.r.y) - 2, width: Math.ceil(g.r.w) + 6, height: Math.ceil(g.r.h) + 4, scale: 1 };
              const shot = await page.cmd('Page.captureScreenshot', { format: 'png', clip });
              // the border column is 1 CSS pixel: z device pixels, at a fractional zoom spread over two (anti-aliased)
              const right = (g.r.x + g.r.w - clip.x) * z;
              const px = await page.eval(`${PIXELS}(${JSON.stringify(shot.data)}, ${Math.floor(right - z)}, ${Math.ceil(right) - 1}, ${Math.floor((g.r.y + g.r.h / 2 - clip.y) * z)})`);
              const best = px.reduce((m, p) => (dist(p, rgb(g.own)) < dist(m, rgb(g.own)) ? p : m));
              if (dist(best, rgb(g.own)) >= dist(best, rgb(g.other))) problems.push(`${where} hover ${sg.sel}: right border pixels ${JSON.stringify(px)} show the neighbour's ${g.other}, not ${g.own}`);
            }
            // pressed (released outside, so nothing is triggered)
            const r = g.r;
            await page.mouse('mousePressed', r.x + r.w / 2, r.y + r.h / 2, 'left');
            await page.settle(30);
            for (const p of await page.eval(`${BROKEN}(${JSON.stringify(SEGMENTS)})`)) problems.push(`${where} pressed ${sg.sel}: ${p}`);
            await page.mouse('mouseMoved', 5, Math.round(H / z) - 5);
            await page.mouse('mouseReleased', 5, Math.round(H / z) - 5, 'left');
            // keyboard focus (with its ring): Tab from the control before it
            await page.eval(`(() => { const all = [...document.querySelectorAll('header.topbar button, header.topbar input')].filter((e) => !e.disabled && e.getClientRects().length && !e.closest('[hidden]')); const b = document.querySelector(${JSON.stringify(sg.sel)}); all[all.indexOf(b) - 1].focus(); return true; })()`);
            await page.key('Tab', 'Tab', 9);
            const focused = await page.eval(`document.activeElement === document.querySelector(${JSON.stringify(sg.sel)}) && document.activeElement.matches(':focus-visible')`);
            if (!focused) problems.push(`${where} ${sg.sel}: not reached with Tab`);
            for (const p of await page.eval(`${BROKEN}(${JSON.stringify(SEGMENTS)})`)) problems.push(`${where} focus ${sg.sel}: ${p}`);
            await page.eval(`document.activeElement.blur(), true`);
          }
          // nothing moved or changed size between the states
          const sizes = await page.eval(`[...document.querySelectorAll(${JSON.stringify(SEGMENTS)})].map((b) => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(); })`);
          await page.hover('#btn-arrange-compact');
          const hovered = await page.eval(`[...document.querySelectorAll(${JSON.stringify(SEGMENTS)})].map((b) => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(); })`);
          if (sizes.join('|') !== hovered.join('|')) problems.push(`${where}: a segment moved or changed size on hover`);
        }
      }
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
