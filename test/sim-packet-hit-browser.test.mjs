// A packet's hit area on screen (headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped without one): at 50 %, 100 % and 200 % zoom the
// pointer 9 px beside a dot outlines it (a ring in the diagram, the hand) and
// a click there opens the inspector for that packet; 20 px away nothing is
// outlined and a click opens nothing. The inspector keeps that packet while
// the simulation moves on; a device's click stays a device's; the event log
// still opens a packet from the keyboard. Both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** A dot on screen with no other dot within 40 px (its centre, its flight), or null. */
const LONE = `(() => {
  const ds = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).map((d) => { const r = d.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: Number(d.getAttribute('data-flight')) }; });
  const W = innerWidth, H = innerHeight;
  const onCanvas = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && !!e.closest('#canvas'); };
  return ds.find((d) => d.x > 60 && d.y > 60 && d.x < W - 60 && d.y < H - 60 && [[0, 0], [9, 0], [9, -3], [20, 0], [0, 20]].every(([a, b]) => onCanvas(d.x + a, d.y + b)) && ds.every((o) => o === d || Math.hypot(o.x - d.x, o.y - d.y) > 40)) || null;
})()`;
const HOVER = `(() => { const h = document.querySelector('#canvas .sim-hit'); const r = h ? h.querySelector('.sim-hit-ring').getBoundingClientRect() : null; return { id: h ? Number(h.getAttribute('data-hover')) : null, hand: document.getElementById('canvas').classList.contains('sim-dot-hover'), ring: r ? Math.round(r.width) : 0, cursor: getComputedStyle(document.getElementById('canvas')).cursor }; })()`;
const PANEL = `(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p && !p.hidden ? p.querySelector('.pi').textContent : null; })()`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: a packet within 12 px of the pointer is outlined and opens on a click, at 50 %, 100 % and 200 % zoom; nothing farther; the inspector keeps its packet`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`netatlas.startProtocolSimulation(), true`);
      for (const k of [1, 0.5, 2]) {
        // the zoom, then a moment of play until a lone dot is on screen, paused there
        await page.eval(`(() => { netatlas.zoomBy(${k} / netatlas.zoom.k); return true; })()`);
        let dot = null;
        for (let i = 0; i < 60 && !dot; i++) {
          await page.eval(`netatlas.simController().setPlaying(true), true`);
          await new Promise((r) => setTimeout(r, 120));
          await page.eval(`netatlas.simController().setPlaying(false), true`);
          await page.settle(30);
          // (a dot in the middle of the canvas: the diagram panned to one, the zoom kept)
          await page.eval(`(() => { const c = netatlas.simController(); const ds = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).map((d) => c.dotOf(Number(d.getAttribute('data-flight')))).filter((p) => p); if (!ds.length) return false; const p = ds[ds.length - 1]; const r = document.getElementById('canvas').getBoundingClientRect(); netatlas.zoom.tx = r.width / 2 - 200 - p.x * netatlas.zoom.k; netatlas.zoom.ty = r.height / 2 - 100 - p.y * netatlas.zoom.k; netatlas.applyZoom(); return true; })()`);
          await page.settle(30);
          dot = await page.eval(LONE);
        }
        assert.ok(dot, `a lone dot at ${k * 100} %`);
        assert.equal(Math.round((await page.eval(`netatlas.zoom.k`)) * 100), k * 100);
        // near: outlined (a ring of 9 px radius on screen whatever the zoom), the hand
        await page.mouse('mouseMoved', dot.x + 9, dot.y);
        await page.settle(30);
        let h = await page.eval(HOVER);
        assert.equal(h.id, dot.id, `${k}: the dot beside the pointer is outlined`);
        assert.equal(h.hand, true);
        assert.equal(h.cursor, 'pointer');
        assert.ok(Math.abs(h.ring - 18) <= 3, `${k}: ring ${h.ring} px`);
        // farther: nothing
        await page.mouse('mouseMoved', dot.x + 20, dot.y);
        await page.settle(30);
        h = await page.eval(HOVER);
        assert.deepEqual([h.id, h.hand], [null, false], `${k}: 20 px away`);
        // a click 20 px away opens no inspector
        await page.mouse('mousePressed', dot.x + 20, dot.y, 'left');
        await page.mouse('mouseReleased', dot.x + 20, dot.y, 'left');
        await page.settle(60);
        assert.equal(await page.eval(PANEL), null, `${k}: no packet there`);
        // a click 9 px beside it opens that packet
        await page.mouse('mouseMoved', dot.x + 9, dot.y - 3);
        await page.mouse('mousePressed', dot.x + 9, dot.y - 3, 'left');
        await page.mouse('mouseReleased', dot.x + 9, dot.y - 3, 'left');
        await page.settle(100);
        const shown = await page.eval(PANEL);
        assert.ok(shown, `${k}: the inspector`);
        const want = await page.eval(`(() => { const it = netatlas.simController().pacer.find(${dot.id}); const f = it ? it.f : netatlas.simController().sim.engine.flights.find((x) => x.id === ${dot.id}); return { t0: f.t0, cable: f.track.ref.indexOf('link:') === 0 ? f.track.ref.slice(5) : '' }; })()`);
        if (want.cable) assert.ok(shown.indexOf(`on cable ${want.cable}`) >= 0, shown);
        // the simulation moves on: the inspector still shows the same packet
        await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 3000); c.refresh(true); return true; })()`);
        await page.settle(60);
        assert.equal(await page.eval(PANEL), shown, `${k}: the same packet after the animation advanced`);
        await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
        await page.settle(60);
        // the pointer leaves the diagram: no outline left behind
        await page.mouse('mouseMoved', 5, 5);
        await page.settle(30);
        assert.equal((await page.eval(HOVER)).id, null);
      }
      // a device's click away from any dot: the device is selected, no inspector
      // (the whole diagram in view: every device a candidate)
      await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(false); netatlas.fit(); return true; })()`);
      await page.settle(60);
      const dev = await page.eval(`(() => { const dots = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).map((d) => { const r = d.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); for (const n of document.querySelectorAll('#canvas .node[data-ref^="device:"]')) { const r = n.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; if (x < 40 || y < 40 || x > innerWidth - 420 || y > innerHeight - 260) continue; if (dots.every((d) => Math.hypot(d.x - x, d.y - y) > 25) && document.elementFromPoint(x, y) && document.elementFromPoint(x, y).closest('.node') === n) return { x, y, ref: n.getAttribute('data-ref') }; } return null; })()`);
      assert.ok(dev, 'a device clear of the dots');
      await page.mouse('mouseMoved', dev.x, dev.y);
      await page.mouse('mousePressed', dev.x, dev.y, 'left');
      await page.mouse('mouseReleased', dev.x, dev.y, 'left');
      await page.settle(100);
      assert.equal(await page.eval(PANEL), null);
      assert.equal(await page.eval(`netatlas.session.state.selected`), dev.ref);
      await page.key('Escape', 'Escape', 27);
      // from the keyboard: a message of the event log opens the inspector
      await page.eval(`(() => { const b = document.querySelector('#sim-log-table .sim-msg-btn'); b.focus(); return true; })()`);
      await page.key('Enter', 'Enter', 13);
      await page.settle(100);
      assert.match(await page.eval(PANEL), /as \S+ sent it at t = /);
    } finally {
      await page.close();
    }
  });
}
