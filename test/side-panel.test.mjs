// The side panel: wider by default, resizable with a visible splitter
// (pointer, keyboard, double-click to reset), its width remembered in local
// storage and never in the model; its tabs never cut off or squeezed (they
// wrap; the active one always shows), and the page never scrolls sideways,
// at normal and narrow widths and at browser zoom up to 200 %. The limits
// are pure functions, tested without a browser; the rest in headless
// Chrome/Edge/Chromium (DevTools protocol), skipped without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const S = load('ui/splitter.js');
const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

test('limits: at least 320 px, at most what leaves the diagram 360 px beside the object list; stored values are checked', () => {
  assert.equal(S.SIDE_DEFAULT, 480);
  assert.equal(S.SIDE_DEFAULT_NARROW, 400);
  assert.equal(S.sideMax(1440, 250), 830);
  assert.equal(S.clampSide(2000, 1440, 250), 830);
  assert.equal(S.clampSide(100, 1440, 250), 320);
  assert.equal(S.clampSide(500.4, 1440, 250), 500);
  // a window too small for both: the minimum (the stylesheet then gives the diagram what is left)
  assert.equal(S.sideMax(700, 200), 320);
  assert.equal(S.parseStoredWidth('512'), 512);
  for (const bad of [null, '', 'wide', '12', '-400', '512px', '99999']) assert.equal(S.parseStoredWidth(bad), null, String(bad));
});

const GEO = `(() => {
  const side = document.getElementById('side').getBoundingClientRect();
  const canvas = document.getElementById('canvas-wrap').getBoundingClientRect();
  const sp = document.getElementById('side-splitter');
  // (in a very short window the tabs that don't fit are in More ▾, not on the row)
  const tabs = [...document.querySelectorAll('#side .tabs button[data-tab]')].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return { name: b.textContent, whole: b.scrollWidth <= b.clientWidth + 1 && r.left >= side.left - 0.5 && r.right <= side.right + 0.5 && r.width > 0, active: b.classList.contains('active'), top: Math.round(r.top) }; });
  return {
    side: Math.round(side.width),
    canvas: Math.round(canvas.width),
    pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    splitter: getComputedStyle(sp).display !== 'none' && sp.getBoundingClientRect().width > 0,
    now: Number(sp.getAttribute('aria-valuenow')),
    min: Number(sp.getAttribute('aria-valuemin')),
    max: Number(sp.getAttribute('aria-valuemax')),
    tabs,
    rows: new Set(tabs.map((t) => t.top)).size,
    stored: (() => { try { return localStorage.getItem('netatlas.sideWidth'); } catch (e) { return 'n/a'; } })(),
  };
})()`;

async function at(page, W, H, z = 1) {
  await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
  await page.settle(120);
  return page.eval(GEO);
}

test('the splitter: an accessible separator; keyboard, drag and double-click; the width is remembered in this browser only', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.removeItem('netatlas.sideWidth'), netatlas.loadExample(0), true`);
    let g = await at(page, 1440, 900);
    const yamlBefore = await page.eval(`netatlas.exportText()`);
    assert.equal(g.side, 480, 'wider by default (was 410)');
    const a11y = await page.eval(`(() => { const s = document.getElementById('side-splitter'); return [s.getAttribute('role'), s.getAttribute('aria-orientation'), s.getAttribute('aria-label'), s.tabIndex, s.getAttribute('aria-valuetext')]; })()`);
    assert.deepEqual(a11y, ['separator', 'vertical', 'Width of the side panel', 0, '480 pixels wide']);
    assert.deepEqual([g.now, g.min, g.max], [480, 320, 830]);
    // keyboard: ← wider, → narrower, Shift for bigger steps, Home / End, Enter resets
    await page.eval(`document.getElementById('side-splitter').focus(), true`);
    assert.equal(await page.eval(`document.activeElement.id`), 'side-splitter');
    await page.key('ArrowLeft', 'ArrowLeft', 37);
    g = await page.eval(GEO);
    assert.deepEqual([g.side, g.now, g.stored], [496, 496, '496']);
    await page.key('ArrowLeft', 'ArrowLeft', 37, 8);
    assert.equal((await page.eval(GEO)).side, 560);
    await page.key('ArrowRight', 'ArrowRight', 39);
    assert.equal((await page.eval(GEO)).side, 544);
    await page.key('Home', 'Home', 36);
    assert.equal((await page.eval(GEO)).side, 320);
    await page.key('End', 'End', 35);
    g = await page.eval(GEO);
    assert.equal(g.side, 830);
    assert.ok(g.canvas >= 359, 'the diagram keeps its room: ' + g.canvas);
    // the arrows never pan the diagram while the splitter has the keyboard
    await page.key('Enter', 'Enter', 13);
    g = await page.eval(GEO);
    assert.deepEqual([g.side, g.stored], [480, null], 'Enter resets to the default and forgets the choice');
    // drag: 100 px to the left widens the panel by 100 px
    const r = await page.rect('#side-splitter');
    const x = r.x + r.w / 2;
    const y = r.y + r.h / 2;
    await page.mouse('mouseMoved', x, y);
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseMoved', x - 50, y, 'left');
    await page.mouse('mouseMoved', x - 100, y, 'left');
    await page.mouse('mouseReleased', x - 100, y, 'left');
    await page.settle();
    g = await page.eval(GEO);
    assert.ok(Math.abs(g.side - 580) <= 2, 'dragged to ' + g.side);
    // remembered: a reload keeps it (local storage, not the model)
    assert.equal(await page.eval(`netatlas.exportText()`), yamlBefore, 'nothing about the panel is written to the model');
    assert.equal(await page.eval(`netatlas.mdoc.dirty`), false, 'resizing is no edit');
    await page.cmd('Page.reload', {});
    // wait for the new document (an evaluation during the navigation fails)
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        if (await page.eval(`document.readyState === 'complete' && !!window.netatlas`)) break;
      } catch (e) {
        /* still navigating */
      }
    }
    await page.eval(`netatlas.loadExample(0), true`);
    g = await at(page, 1440, 900);
    assert.ok(Math.abs(g.side - 580) <= 2, 'after a reload: ' + g.side);
    // double-click resets
    await page.eval(`document.getElementById('side-splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`);
    g = await page.eval(GEO);
    assert.deepEqual([g.side, g.stored], [480, null]);
  } finally {
    await page.close();
  }
});

test('tabs never cut off or squeezed, the active one always shown, and no sideways page scrolling: widths 1440 … 600, zoom 100–200 %, any chosen width', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  const problems = [];
  try {
    await page.eval(`localStorage.removeItem('netatlas.sideWidth'), netatlas.loadExample(0), true`);
    for (const chosen of [null, 2000]) {
      await page.eval(chosen ? `netatlas.splitter.set(${chosen}), true` : `netatlas.splitter.set(null), true`);
      for (const [W, H] of [[1440, 900], [1100, 800], [1000, 700], [861, 700], [800, 760], [600, 700]]) {
        for (const z of [1, 1.5, 2]) {
          for (const tab of ['edit', 'details', 'legend', 'relations', 'problems', 'yaml']) {
            await page.eval(`netatlas.showTab('${tab}'), true`);
            const g = await at(page, W, H, z);
            const where = `${W}px ${z * 100}% ${chosen ? 'widest' : 'default'} ${tab}`;
            if (g.pageScroll > 0) problems.push(`${where}: the page scrolls sideways by ${g.pageScroll}px`);
            const cut = g.tabs.filter((t) => !t.whole).map((t) => t.name);
            if (cut.length) problems.push(`${where}: tabs cut off or squeezed: ${cut.join(', ')}`);
            if (!g.tabs.some((t) => t.active && t.whole)) problems.push(`${where}: the active tab is not shown whole`);
            const narrow = W / z <= 860;
            if (narrow === g.splitter) problems.push(`${where}: the splitter is ${g.splitter ? 'shown' : 'hidden'}`);
            if (!narrow && g.canvas < 330) problems.push(`${where}: the diagram has only ${g.canvas}px`);
          }
        }
      }
    }
    // a tab label that grows (many problems): the tabs wrap onto a second row rather than squeezing
    await page.eval(`netatlas.splitter.set(320), document.querySelector('#side .tabs [data-tab="problems"]').textContent = 'Problems (1234 errors and warnings)', true`);
    const g = await at(page, 1440, 900);
    assert.ok(g.tabs.every((t) => t.whole), JSON.stringify(g.tabs));
    assert.ok(g.rows >= 2, 'wraps: ' + g.rows);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test('a very short window: the tabs stay on one row; those that don\'t fit are in More ▾ (the active one never), which works with the keyboard', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 400, height: 300 });
  try {
    await page.eval(`netatlas.loadExample(0), true`);
    await page.settle(150);
    const state = `(() => { const tabs = [...document.querySelectorAll('#side .tabs button[data-tab]')]; const nav = document.querySelector('#side .tabs'); return { shown: tabs.filter((b) => !b.hidden).map((b) => b.getAttribute('data-tab')), hidden: tabs.filter((b) => b.hidden).map((b) => b.getAttribute('data-tab')), more: !document.querySelector('.tabs-more').hidden, rows: new Set(tabs.filter((b) => !b.hidden).map((b) => Math.round(b.getBoundingClientRect().top))).size, fits: tabs.filter((b) => !b.hidden).every((b) => { const r = b.getBoundingClientRect(), n = nav.getBoundingClientRect(); return r.right <= n.right + 0.5 && b.scrollWidth <= b.clientWidth + 1; }), active: netatlas.currentTab(), label: document.getElementById('tabs-more-btn').getAttribute('aria-label') }; })()`;
    for (const tab of ['edit', 'details', 'legend', 'relations', 'problems', 'yaml']) {
      await page.eval(`netatlas.showTab('${tab}'), true`);
      const s = await page.eval(state);
      assert.equal(s.more, true, tab);
      assert.equal(s.rows, 1, `${tab}: one row`);
      assert.equal(s.fits, true, `${tab}: no tab on the row is cut off`);
      assert.ok(s.shown.includes(tab), `${tab}: the active tab is on the row (${s.shown})`);
      assert.ok(s.hidden.length > 0 && !s.hidden.includes(tab), tab);
      assert.equal(s.label, 'More tabs: ' + s.hidden.map((t) => t[0].toUpperCase() + t.slice(1)).join(', ').replace('Yaml', 'YAML'));
    }
    // the keyboard: ↓ opens it on its first entry, Enter picks, the picked tab has the focus; Esc closes and returns to More
    await page.eval(`netatlas.showTab('edit'), document.getElementById('tabs-more-btn').focus(), true`);
    let s = await page.eval(state);
    const first = s.hidden[0];
    await page.key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-tab-pick')`), first);
    assert.equal(await page.eval(`document.getElementById('tabs-more-btn').getAttribute('aria-expanded')`), 'true');
    await page.key('Enter', 'Enter', 13);
    s = await page.eval(state);
    assert.equal(s.active, first);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-tab')`), first, 'the picked tab has the focus, on the row');
    await page.eval(`document.getElementById('tabs-more-btn').focus(), true`);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await page.key('Escape', 'Escape', 27);
    assert.equal(await page.eval(`document.activeElement.id + ' ' + document.getElementById('tabs-more-menu').hidden`), 'tabs-more-btn true');
    // a taller window: the tabs wrap again and More is gone
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 400, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.settle(150);
    s = await page.eval(state);
    assert.deepEqual([s.more, s.hidden.length], [false, 0]);
  } finally {
    await page.close();
  }
});
