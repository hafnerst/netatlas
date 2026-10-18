// The Analyze workspace and the tool windows with real input (headless
// Chrome/Edge/Chromium through the DevTools protocol; skipped without one):
// F6, Shift+F6 and Esc with real keys across the workspace's regions, Shift+F
// entering Focus with the keyboard on its hops, Esc layered (inside a panel it
// never leaves the workspace; in the diagram it ends a focus first, then
// Analyze), the workspace in narrow windows and at 200 % zoom; and for the
// tool windows that remain (Saved views here): dragging the title bar and the
// resize grip, the size and position remembered over a reload (local
// storage), docking at the bottom in a narrow window, the page never
// scrolling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
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

const REGION = `(() => { const a = document.activeElement; for (const id of ['outline', 'canvas-wrap', 'side', 'sim-paneltabs', 'sim-dock', 'toolwin']) { const r = document.getElementById(id); if (r && r.contains(a)) return id; } return a === document.body ? 'body' : a.id; })()`;
const WS = `({ ws: netatlas.workspace(), tool: netatlas.analyzeTool(), active: document.activeElement.id, trace: !!netatlas.currentTrace() })`;

test('Analyze with real keys: T enters Trace path with the keyboard in its form; F6 and Shift+F6 go region by region (left, diagram, right, results) and back to where the focus was; Esc in a field stays, Esc in the diagram leaves', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), true`);
    await page.settle(150);
    await page.eval(`document.getElementById('canvas').focus(), true`);
    await page.key('t', 'KeyT', 84);
    await page.settle(100);
    assert.deepEqual(await page.eval(WS), { ws: 'analyze', tool: 'trace', active: 'trace-from', trace: false });
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await page.key('F6', 'F6', 117);
      seq.push(await page.eval(REGION));
    }
    assert.deepEqual(seq, ['canvas-wrap', 'side', 'sim-dock', 'outline'], 'F6: the next region each time, round to the left panel');
    assert.equal((await page.eval(WS)).active, 'trace-from', 'F6: into the left panel, where the focus was');
    await page.key('F6', 'F6', 117, 8);
    assert.equal(await page.eval(REGION), 'sim-dock', 'Shift+F6: back');
    await page.key('F6', 'F6', 117);
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    assert.equal((await page.eval(WS)).ws, 'analyze', 'Esc in a field of the panel never leaves the workspace');
    await page.eval(`document.getElementById('canvas').focus(), true`);
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    const w = await page.eval(WS);
    assert.deepEqual([w.ws, w.tool], ['edit', ''], 'Esc in the diagram leaves Analyze');
    assert.ok(await page.eval(`!!document.getElementById('outline-body') && document.getElementById('sim-dock').hidden`), 'the editing panels again');
  } finally {
    await page.close();
  }
});

test('Shift+F with real keys: Focus in Analyze, focused at once, the keyboard on the hops in effect; Esc in the diagram ends the focus first, a second Esc leaves Analyze', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), netatlas.setView('physical'), netatlas.select('device:hq-fw', true), document.getElementById('canvas').focus(), true`);
    await page.settle(150);
    const st = () => page.eval(`({ tool: netatlas.analyzeTool(), on: !document.getElementById('mb-focus').hidden, hops: document.activeElement.getAttribute('data-focus-hops'), checked: document.activeElement.getAttribute('aria-checked') })`);
    await page.key('F', 'KeyF', 70, 8);
    await page.settle(150);
    assert.deepEqual(await st(), { tool: 'focus', on: true, hops: '1', checked: 'true' });
    await page.eval(`document.getElementById('canvas').focus(), true`);
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.deepEqual(await st(), { tool: 'focus', on: false, hops: null, checked: null }, 'the focus ends; Analyze stays');
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal((await st()).tool, '', 'then Analyze ends');
  } finally {
    await page.close();
  }
});

test('the workspaces in narrow windows and at 200 % zoom: the panels as tabs under the diagram, the results at the bottom, the page never scrolls; Exit restores the editing layout', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('ot-network.yaml'), true`);
    for (const [W, H, z] of [[800, 760, 1], [600, 700, 1], [1440, 900, 2], [1100, 800, 2]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
      await page.settle(120);
      for (const enter of [`netatlas.runCommand('analyze.checks')`, `netatlas.runCommand('analyze.spof')`, `netatlas.enterExperiments()`]) {
        await page.eval(`Promise.resolve(${enter}).then(() => true)`);
        await page.settle(150);
        const where = `${W}px ${z * 100}% ${enter}`;
        const g = await page.eval(`(() => { const d = document.documentElement; const dock = document.getElementById('sim-dock').getBoundingClientRect(); const st = document.getElementById('status').getBoundingClientRect(); return { scroll: d.scrollWidth - d.clientWidth + d.scrollHeight - d.clientHeight, dockShown: dock.height > 0, dockAbove: dock.bottom <= st.top + 1, tabs: getComputedStyle(document.getElementById('sim-paneltabs')).display !== 'none', ws: netatlas.workspace(), exit: !!document.getElementById('ws-exit-banner') && document.getElementById('ws-exit-banner').getBoundingClientRect().width > 0 }; })()`);
        assert.ok(g.scroll === 0 && g.dockShown && g.dockAbove && g.exit, `${where}: ${JSON.stringify(g)}`);
        if (W / z <= 900) assert.ok(g.tabs, `${where}: the panels as tabs`);
        await page.eval(`netatlas.exitWorkspace().then(() => true)`);
        await page.settle(80);
        assert.equal(await page.eval(`netatlas.workspace() + ' ' + document.getElementById('sim-dock').hidden`), 'edit true', `${where}: Exit restores the editing layout`);
      }
    }
  } finally {
    await page.close();
  }
});

test('a tool window (Saved views): dragging the title bar and the grip; the size and position are remembered over a reload; the page never scrolls', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), netatlas.openSavedViews(), true`);
    await page.settle(150);
    let g = await page.eval(GEO);
    const head = await page.rect('#tw-title');
    await page.mouse('mouseMoved', head.x + 20, head.y + 8);
    await page.mouse('mousePressed', head.x + 20, head.y + 8, 'left');
    await page.mouse('mouseMoved', head.x - 80, head.y + 40, 'left');
    await page.mouse('mouseMoved', head.x - 180, head.y + 68, 'left');
    await page.mouse('mouseReleased', head.x - 180, head.y + 68, 'left');
    await page.settle();
    const moved = await page.eval(GEO);
    assert.deepEqual([moved.x - g.x, moved.y - g.y], [-200, 60]);
    const grip = await page.rect('#toolwin .tw-grip');
    await page.mouse('mouseMoved', grip.x + 5, grip.y + 5);
    await page.mouse('mousePressed', grip.x + 5, grip.y + 5, 'left');
    await page.mouse('mouseMoved', grip.x + 105, grip.y + 55, 'left');
    await page.mouse('mouseReleased', grip.x + 105, grip.y + 55, 'left');
    await page.settle();
    g = await page.eval(GEO);
    assert.deepEqual([g.w - moved.w, g.h - moved.h], [100, 50]);
    const head2 = await page.rect('#tw-title');
    await page.mouse('mouseMoved', head2.x + 20, head2.y + 8);
    await page.mouse('mousePressed', head2.x + 20, head2.y + 8, 'left');
    await page.mouse('mouseMoved', head2.x + 3000, head2.y + 3000, 'left');
    await page.mouse('mouseReleased', head2.x + 3000, head2.y + 3000, 'left');
    await page.settle();
    const far = await page.eval(GEO);
    assert.ok(far.x + far.w <= far.vw && far.y + far.h <= far.vh && far.scroll === 0, JSON.stringify(far));
    await page.cmd('Page.reload', {});
    await waitReady(page);
    await page.eval(`netatlas.loadExample(0), netatlas.openSavedViews(), true`);
    await page.settle(150);
    const again = await page.eval(GEO);
    assert.deepEqual([again.x, again.y, again.w, again.h], [far.x, far.y, far.w, far.h]);
  } finally {
    await page.close();
  }
});

test('narrow windows and 200 % zoom: a tool window docks as a full-width panel at the bottom, above the status bar; the page never scrolls', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.eval(`localStorage.clear(), netatlas.loadExample(0), true`);
    for (const [W, H, z] of [[800, 760, 1], [600, 700, 1], [1440, 900, 2], [1100, 800, 2]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z, mobile: false });
      await page.settle(120);
      for (const open of [`netatlas.openSavedViews()`, `netatlas.openBrowse()`]) {
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
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.settle(120);
    const g = await page.eval(GEO);
    assert.equal(g.docked, false);
  } finally {
    await page.close();
  }
});
