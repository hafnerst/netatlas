// The simulation panel's height, the packet inspector's pause, the hidden
// tab and the pace measured on screen, with real input (headless
// Chrome/Edge/Chromium through the DevTools protocol; skipped without one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(page, pre = '') {
  await page.settle(150);
  const ex = 'protocol-simulation.yaml';
  await page.eval(`${pre} sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
  await page.settle(150);
}
const H = `document.getElementById('sim-dock').getBoundingClientRect().height`;
const ST = `({ playing: netatlas.simController().playing, by: netatlas.simController().pausedBy, state: document.getElementById('sim-state').textContent, live: document.getElementById('sim-state-live').textContent, pi: !!document.querySelector('.sim-table-panel[data-table="packet"]') })`;

test('the simulation panel: by default its header and three rows of each table (an older remembered height ignored); dragged and with the keyboard; remembered under its new key; a double-click resets it', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    // a height remembered by an earlier development version
    await load(page, `localStorage.clear(), localStorage.setItem('netatlas.dockHeight', '600'), localStorage.setItem('netatlas.simPanelHeight', '420'),`);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(20000), true`);
    await page.settle(200);
    const g = await page.eval(`(() => { const b = document.getElementById('sim-log-table').getBoundingClientRect(); const rows = Array.from(document.querySelectorAll('#sim-log-table tbody tr')).filter((r) => { const q = r.getBoundingClientRect(); return q.top >= b.top - 1 && q.bottom <= b.bottom + 1; }).length; const s = document.getElementById('sim-status-table').getBoundingClientRect(); const srows = Array.from(document.querySelectorAll('#sim-status-table tbody tr')).filter((r) => r.getBoundingClientRect().bottom <= s.bottom + 1).length; return { h: ${H}, canvas: document.getElementById('canvas-wrap').getBoundingClientRect().height, rows, srows, play: document.getElementById('sim-play').getBoundingClientRect().height, exit: document.getElementById('sim-exit').getBoundingClientRect().bottom <= innerHeight }; })()`);
    assert.ok(Math.abs(g.h - (await page.eval(`netatlas.dockBounds().min`))) < 2, `its minimum, three rows of each table: ${g.h}`);
    assert.ok(g.canvas > 2 * g.h, 'the diagram is clearly the largest part');
    assert.ok(g.rows >= 3 && g.srows >= 3, `three rows: ${g.rows} log, ${g.srows} status`);
    assert.ok(g.play > 0 && g.exit);
    // dragged 80 px up
    const sp = await page.rect('#dock-splitter');
    await page.mouse('mouseMoved', sp.x + sp.w / 2, sp.y + sp.h / 2);
    await page.mouse('mousePressed', sp.x + sp.w / 2, sp.y + sp.h / 2, 'left');
    await page.mouse('mouseMoved', sp.x + sp.w / 2, sp.y + sp.h / 2 - 80, 'left');
    await page.mouse('mouseReleased', sp.x + sp.w / 2, sp.y + sp.h / 2 - 80, 'left');
    const h1 = await page.eval(H);
    assert.ok(Math.abs(h1 - g.h - 80) < 3, `${g.h} → ${h1}`);
    assert.equal(await page.eval(`Number(localStorage.getItem('netatlas.simPanelHeight3'))`), Math.round(h1));
    // the keyboard: ↓ lower
    await page.eval(`document.getElementById('dock-splitter').focus(), true`);
    await page.key('ArrowDown', 'ArrowDown', 40);
    assert.ok(Math.abs((await page.eval(H)) - (h1 - 20)) < 2);
    // remembered for the next start
    await page.eval(`netatlas.exitSimulation(), netatlas.startProtocolSimulation(), true`);
    await page.settle(150);
    assert.ok(Math.abs((await page.eval(H)) - (h1 - 20)) < 2, 'remembered');
    // a double-click: the default again, the key removed
    const sp2 = await page.rect('#dock-splitter');
    await page.mouse('mouseMoved', sp2.x + sp2.w / 2, sp2.y + sp2.h / 2);
    await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp2.x + sp2.w / 2, y: sp2.y + sp2.h / 2, button: 'left', clickCount: 1 });
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp2.x + sp2.w / 2, y: sp2.y + sp2.h / 2, button: 'left', clickCount: 1 });
    await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp2.x + sp2.w / 2, y: sp2.y + sp2.h / 2, button: 'left', clickCount: 2 });
    await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp2.x + sp2.w / 2, y: sp2.y + sp2.h / 2, button: 'left', clickCount: 2 });
    await page.settle(100);
    assert.ok(Math.abs((await page.eval(H)) - (await page.eval(`netatlas.dockBounds().dflt`))) < 2, 'the default');
    assert.equal(await page.eval(`localStorage.getItem('netatlas.simPanelHeight3')`), null);
    // a narrow window and 200 % zoom (a viewport of 800 × 450): the toolbar shown, nothing scrolls the page
    for (const [w, h] of [[800, 640], [800, 450]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.settle(250);
      const n = await page.eval(`({ scroll: document.documentElement.scrollHeight - document.documentElement.clientHeight + document.documentElement.scrollWidth - document.documentElement.clientWidth, play: { height: document.getElementById('sim-play').getBoundingClientRect().height }, exit: (({ bottom, right }) => ({ bottom, right }))(document.getElementById('sim-exit').getBoundingClientRect()) })`);
      assert.equal(n.scroll, 0, `${w}×${h}`);
      assert.ok(n.play.height > 0 && n.exit.bottom <= h + 0.5 && n.exit.right <= w + 0.5, `${w}×${h}: the toolbar in view ${JSON.stringify(n)}`);
    }
  } finally {
    await page.close();
  }
});

test('the packet inspector pauses while it is in use: closing it (× or Esc), leaving it (a click or the focus elsewhere) or losing sight of it resumes; a pause by the user stays; Follow message runs beside it', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, `localStorage.clear(),`);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().runTo(15000), true`);
    await page.settle(200);
    // a message of the log that is in view (not under the table's header)
    const open = async () => {
      // (polled: the log's rows may come a frame or two later on a loaded machine)
      let p = null;
      for (let i = 0; i < 20 && !p; i++) {
        // (not in view: scrolled into the log's view, as a reader would)
        if (i) await page.eval(`(() => { const bs = document.querySelectorAll('#sim-log-table .sim-msg-btn'); if (bs.length) bs[bs.length - 1].scrollIntoView({ block: 'center' }); return true; })()`);
        if (i) await page.settle(100);
        p = await page.eval(`(() => { for (const b of Array.from(document.querySelectorAll('#sim-log-table .sim-msg-btn')).reverse()) { const r = b.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; if (document.elementFromPoint(x, y) === b) return { x, y }; } return null; })()`);
      }
      assert.ok(p, 'a message in view: ' + JSON.stringify(await page.eval(`(() => { const bs = Array.from(document.querySelectorAll('#sim-log-table .sim-msg-btn')); const b = bs[bs.length - 1]; if (!b) return { n: 0 }; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { n: bs.length, r: [r.left, r.top, r.width, r.height], at: e ? e.tagName + '.' + e.className : null }; })()`)));
      await page.mouse('mouseMoved', p.x, p.y);
      await page.mouse('mousePressed', p.x, p.y, 'left');
      await page.mouse('mouseReleased', p.x, p.y, 'left');
      await page.settle(120);
      // (polled: a loaded machine may take a few frames to open it)
      for (let i = 0; i < 20 && !(await page.eval(`!!document.querySelector('.sim-table-panel[data-table="packet"] .st-close')`)); i++) await page.settle(100);
    };
    // a log row: paused, and the state says why
    await open();
    let s = await page.eval(ST);
    assert.deepEqual([s.playing, s.by, s.state, s.live, s.pi], [false, 'inspector', 'Paused: inspecting packet', 'Paused: inspecting packet', true]);
    // × closes it: playing again
    await page.click('.sim-table-panel[data-table="packet"] .st-close');
    await page.settle(100);
    s = await page.eval(ST);
    assert.deepEqual([s.playing, s.state, s.live, s.pi], [true, 'Playing', 'Playing', false]);
    // Esc
    await open();
    await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').focus(), true`);
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal((await page.eval(ST)).playing, true, 'Esc');
    // a click in the diagram's background
    await open();
    const c = await page.rect('#canvas-wrap');
    await page.mouse('mousePressed', c.x + 20, c.y + c.h - 60, 'left');
    await page.mouse('mouseReleased', c.x + 20, c.y + c.h - 60, 'left');
    await page.settle(100);
    s = await page.eval(ST);
    assert.deepEqual([s.playing, s.by, s.pi], [false, 'inspector', true], 'a click elsewhere: still paused by the open inspector');
    // the focus to another control: still paused
    await page.eval(`document.getElementById('sim-speed').focus(), true`);
    await page.settle(100);
    assert.equal((await page.eval(ST)).playing, false, 'the focus elsewhere: still paused');
    assert.match(await page.eval(`document.getElementById('sim-state').title`), /The packet inspector paused it: it plays again when you close the inspector/);
    // closed: playing
    await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
    await page.settle(100);
    assert.equal((await page.eval(ST)).playing, true, 'closed');
    // no longer visible (moved out of the window, as a layout change would)
    await open();
    await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"]').style.left = '-3000px', true`);
    await wait(700);
    assert.equal((await page.eval(ST)).playing, true, 'out of sight');
    await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
    // paused by the user first: it stays paused
    await page.click('#sim-play');
    await page.settle(60);
    assert.equal((await page.eval(ST)).by, 'user');
    await open();
    s = await page.eval(ST);
    assert.deepEqual([s.playing, s.by, s.state], [false, 'user', 'Paused']);
    await page.click('.sim-table-panel[data-table="packet"] .st-close');
    await page.settle(60);
    assert.deepEqual([(await page.eval(ST)).playing, (await page.eval(ST)).by], [false, 'user'], 'still paused after closing');
    // played and paused again by the user while it is open: stays paused
    await page.click('#sim-play');
    await open();
    await page.click('#sim-play');
    await page.settle(60);
    assert.equal((await page.eval(ST)).playing, true, 'Play while inspecting');
    await page.click('#sim-play');
    await page.settle(60);
    await page.click('.sim-table-panel[data-table="packet"] .st-close');
    await page.settle(60);
    s = await page.eval(ST);
    assert.deepEqual([s.playing, s.by], [false, 'user'], 'a pause by the user while it was open stays');
    // Follow message: runs beside the open inspector
    await page.click('#sim-play');
    await open();
    await page.click('#pi-follow');
    await page.settle(100);
    s = await page.eval(ST);
    assert.deepEqual([s.playing, s.pi], [true, true], 'following: playing beside the inspector');
  } finally {
    await page.close();
  }
});

test('a hidden tab: the clock stops and goes on when the tab is visible again, only if it was running', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, `localStorage.clear(),`);
    await page.eval(`netatlas.startProtocolSimulation(), true`);
    await wait(300);
    const vis = (v) => page.eval(`(Object.defineProperty(document, 'visibilityState', { get: () => '${v}', configurable: true }), document.dispatchEvent(new Event('visibilitychange')), true)`);
    const clock = () => page.eval(`netatlas.simController().pacer.clock`);
    await vis('hidden');
    const c0 = await clock();
    await wait(600);
    assert.equal(await clock(), c0, 'stopped while hidden');
    assert.equal(await page.eval(`netatlas.simController().playing`), true, 'still meant to play');
    await vis('visible');
    await wait(500);
    assert.ok((await clock()) > c0 + 200, 'going on');
    // paused before: stays paused
    await page.click('#sim-play');
    await vis('hidden');
    await vis('visible');
    const c1 = await clock();
    await wait(400);
    assert.equal(await clock(), c1, 'still paused');
  } finally {
    await page.close();
  }
});

test('the pace on screen at the defaults: every hop takes at least 2 s of real time (measured), and a dot never moves faster than 70 px per second at 100 % zoom', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page, `localStorage.clear(),`);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().runTo(20000), true`);
    await page.settle(100);
    const r = await page.eval(`(async () => {
      const c = netatlas.simController();
      const seen = new Map();
      const t0 = performance.now();
      while (performance.now() - t0 < 16000) {
        await new Promise((ok) => requestAnimationFrame(ok));
        const now = performance.now();
        for (const it of c.pacer.items) {
          if (it.f.view !== 'physical' || !it.drawn || it.f.dropped !== undefined || !c.drawItems().some((d) => d.f === it.f)) continue;
          const st = c.pacer.state(it);
          let s = seen.get(it);
          if (!s) seen.set(it, (s = {}));
          if (st.phase === 'moving' && s.start === undefined && st.frac < 0.05) s.start = now;
          if ((st.phase === 'arrived' || st.phase === 'gone') && s.start !== undefined && s.end === undefined) s.end = now;
        }
      }
      const k = netatlas.zoomLevel ? 1 : 1;
      const done = Array.from(seen).filter(([, s]) => s.end !== undefined).map(([it, s]) => ({ real: s.end - s.start, hop: it.hop, len: c.pacer.find(it.f.id) ? 0 : 0, id: it.f.id, ref: it.f.track.ref, from: it.f.track.from }));
      return done;
    })()`);
    assert.ok(r.length >= 2, `hops measured: ${r.length}`);
    for (const x of r) assert.ok(x.real >= 2000 - 40, `a hop on ${x.ref} took ${Math.round(x.real)} ms of real time`);
    // the speed: the line's length in the diagram over the hop's time
    const fast = await page.eval(`(() => { const c = netatlas.simController(); let worst = 0; for (const it of c.pacer.items) { if (it.f.view !== 'physical') continue; const p = document.querySelector('#canvas g.cable[data-ref="' + it.f.track.ref + '"] path.cable-line'); if (!p) continue; worst = Math.max(worst, p.getTotalLength() / (it.hop / 1000)); } return worst; })()`);
    assert.ok(fast <= 70 + 1e-6, `${fast} px per second at 100 % zoom`);
  } finally {
    await page.close();
  }
});
