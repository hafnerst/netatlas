// Tool windows with real input (headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped without one): F6 and Esc with real keys,
// Shift+F opening the Focus window with the keyboard in it,
// dragging the title bar and the resize grip, the size and position
// remembered over a reload (local storage), docking at the bottom in a
// narrow window and at 200 % zoom, and the page never scrolling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const GEO = `(() => { const w = document.getElementById('toolwin'); const r = w.getBoundingClientRect(); return { open: !w.hidden, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), docked: document.body.classList.contains('tw-docked'), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth + document.documentElement.scrollHeight - document.documentElement.clientHeight, id: netatlas.toolWindow(), active: document.activeElement.id || document.activeElement.className }; })()`;

async function waitReady(page) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (await page.eval(`document.readyState === 'complete' && !!window.netatlas`)) return;
    } catch (e) {
      /* navigating */
    }
  }
}

test('F6 and Esc with real keys: into the window and back to where the focus was; Esc closes it and the focus returns', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), true`);
    await page.settle(150);
    await page.eval(`document.getElementById('canvas').focus(), true`);
    await page.key('t', 'KeyT', 84);
    let g = await page.eval(GEO);
    assert.equal(g.id, 'trace');
    assert.equal(g.active, 'trace-from', 'the window has the focus, on its first empty field');
    await page.key('F6', 'F6', 117);
    assert.equal((await page.eval(GEO)).active, 'canvas', 'F6: back to the diagram');
    await page.key('F6', 'F6', 117);
    assert.equal((await page.eval(GEO)).active, 'trace-from', 'F6: into the window, where the focus was');
    await page.key('Escape', 'Escape', 27);
    g = await page.eval(GEO);
    assert.deepEqual([g.open, g.id, g.active], [false, '', 'canvas']);
  } finally {
    await page.close();
  }
});

test('Shift+F with real keys: the Focus window opens and focuses at once, the keyboard on the hops in effect; Esc closes the window and keeps the focus, a second Esc in the diagram exits it', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), netatlas.setView('physical'), netatlas.select('device:hq-fw', true), document.getElementById('canvas').focus(), true`);
    await page.settle(150);
    const st = () => page.eval(`({ win: netatlas.toolWindow(), on: !document.getElementById('mb-focus').hidden, hops: document.activeElement.getAttribute('data-focus-hops'), checked: document.activeElement.getAttribute('aria-checked'), active: document.activeElement.id })`);
    await page.key('F', 'KeyF', 70, 8);
    await page.settle(150);
    assert.deepEqual(await st(), { win: 'focus', on: true, hops: '1', checked: 'true', active: '' });
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.deepEqual(await st(), { win: '', on: true, hops: null, checked: null, active: 'canvas' });
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal((await st()).on, false);
  } finally {
    await page.close();
  }
});

test('dragging the title bar and the grip; the size and position are remembered over a reload; the page never scrolls', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), netatlas.openSpof(), true`);
    await page.settle(150);
    let g = await page.eval(GEO);
    const head = await page.rect('#tw-title');
    // drag the title 200 left, 60 down
    await page.mouse('mouseMoved', head.x + 20, head.y + 8);
    await page.mouse('mousePressed', head.x + 20, head.y + 8, 'left');
    await page.mouse('mouseMoved', head.x - 80, head.y + 40, 'left');
    await page.mouse('mouseMoved', head.x - 180, head.y + 68, 'left');
    await page.mouse('mouseReleased', head.x - 180, head.y + 68, 'left');
    await page.settle();
    const moved = await page.eval(GEO);
    assert.deepEqual([moved.x - g.x, moved.y - g.y], [-200, 60]);
    // the grip: 100 wider, 50 taller
    const grip = await page.rect('#toolwin .tw-grip');
    await page.mouse('mouseMoved', grip.x + 5, grip.y + 5);
    await page.mouse('mousePressed', grip.x + 5, grip.y + 5, 'left');
    await page.mouse('mouseMoved', grip.x + 105, grip.y + 55, 'left');
    await page.mouse('mouseReleased', grip.x + 105, grip.y + 55, 'left');
    await page.settle();
    g = await page.eval(GEO);
    assert.deepEqual([g.w - moved.w, g.h - moved.h], [100, 50]);
    // never out of the browser window: a drag far away is stopped at its edge
    const head2 = await page.rect('#tw-title');
    await page.mouse('mouseMoved', head2.x + 20, head2.y + 8);
    await page.mouse('mousePressed', head2.x + 20, head2.y + 8, 'left');
    await page.mouse('mouseMoved', head2.x + 3000, head2.y + 3000, 'left');
    await page.mouse('mouseReleased', head2.x + 3000, head2.y + 3000, 'left');
    await page.settle();
    const far = await page.eval(GEO);
    assert.ok(far.x + far.w <= far.vw && far.y + far.h <= far.vh && far.scroll === 0, JSON.stringify(far));
    // reload: it opens where it was left, at its size
    await page.cmd('Page.reload', {});
    await waitReady(page);
    await page.eval(`netatlas.loadExample(0), netatlas.openSpof(), true`);
    await page.settle(150);
    const again = await page.eval(GEO);
    assert.deepEqual([again.x, again.y, again.w, again.h], [far.x, far.y, far.w, far.h]);
  } finally {
    await page.close();
  }
});

test('narrow windows and 200 % zoom: every window docks as a full-width panel at the bottom, above the status bar; the page never scrolls', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), true`);
    for (const [W, H, z] of [[800, 760, 1], [600, 700, 1], [1440, 900, 2], [1100, 800, 2]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
      await page.settle(120);
      for (const open of [`netatlas.openSpof()`, `netatlas.openTrace()`, `netatlas.openAddressing()`, `netatlas.openFocusWindow(false)`]) {
        await page.eval(`${open}, true`);
        await page.settle(80);
        const g = await page.eval(GEO);
        const status = await page.rect('#status');
        const where = `${W}px ${z * 100}% ${open}`;
        assert.ok(g.docked && Math.abs(g.w - g.vw) <= 2 && g.scroll === 0, `${where}: ${JSON.stringify(g)}`);
        assert.ok(g.y + g.h <= status.y + 1 && g.h <= g.vh * 0.5 + 2, `${where}: above the status bar, at most half the height`);
        const dockBtn = await page.eval(`document.querySelector('#toolwin .tw-dock').disabled`);
        assert.equal(dockBtn, true, `${where}: docking can't be undone in a narrow window`);
      }
    }
    // wide again: it floats as it was
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.settle(120);
    const g = await page.eval(GEO);
    assert.equal(g.docked, false);
  } finally {
    await page.close();
  }
});
