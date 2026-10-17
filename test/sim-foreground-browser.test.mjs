// Foreground and background on screen (headless Chrome/Edge/Chromium through
// the DevTools protocol; skipped without one), the busy internal example,
// both themes: the scenario bundled (a few exchanges as dots, lit cables with
// counts for the rest); a stream started: its dots in front, a datagram
// every real second in Readable pacing too, the clock in real time, the
// scenario as cable activity, the panel says so, a dot of it opens the
// inspector; Real time pacing: the clock and the stream with the real
// seconds; Next exchange.
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

for (const theme of ['light', 'dark']) {
  test(`${theme}: the scenario bundled with cable activity; a Network event in front, the scenario behind; Real time; Next exchange`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    const ui = () => page.eval(`(() => { const c = netatlas.simController(); const p = c.pacer; const on = p.items.filter((it) => it.drawn && it.f.view === 'physical' && p.state(it).phase === 'moving');
      return { pace: document.getElementById('sim-pace-text').textContent, drawn: document.getElementById('sim-drawn').textContent, lit: document.querySelectorAll('#canvas .layer-sim .sim-activity').length, counts: Array.from(document.querySelectorAll('#canvas .layer-sim-labels .sim-activity-label text')).map((t) => t.textContent),
        convs: new Set(on.filter((it) => it.f.test === undefined).map((it) => it.key)).size, scenarioDots: on.filter((it) => it.f.test === undefined).length, fgDots: p.items.filter((it) => it.drawn && it.f.view === 'physical' && it.f.test !== undefined && p.state(it).phase !== 'gone').length, t: c.t }; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`netatlas.startProtocolSimulation(), netatlas.fit(), true`);
      await wait(4000);
      // the scenario alone: a few exchanges as dots, the rest lit cables with their counts
      let u = await ui();
      assert.ok(u.convs <= 6, JSON.stringify(u));
      assert.ok(u.lit > 0 && u.counts.length > 0 && u.counts.every((c) => /^\S.* ×\d+/.test(c)), JSON.stringify(u.counts));
      assert.match(u.drawn, /^\d+ more on their way as cable activity \(at most 6 exchanges as dots at once\)\.$/);
      assert.equal(u.pace, 'Readable · 3 s per hop · 1×');
      // a stream from pc1: in front; the scenario behind as cable activity
      await page.eval(`netatlas.simController().startStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500), true`);
      const s0 = await page.eval(`[netatlas.simController().sim.actions()[0].progress.done, performance.now()]`);
      await wait(3000);
      u = await ui();
      assert.match(u.pace, /^Readable · 3 s per hop · 1× · streams in real time( · behind)?$/);
      assert.ok(u.fgDots > 0, 'the stream’s dots');
      // a datagram every real second, Readable pacing or not (the first at once): within a frame or two of the real seconds
      const s1 = await page.eval(`[netatlas.simController().sim.actions()[0].progress.done, performance.now()]`);
      const secs = (s1[1] - s0[1]) / 1000;
      assert.ok(s1[0] >= Math.floor(secs) && s1[0] <= Math.floor(secs) + 2, `${s1[0]} datagrams in ${secs.toFixed(2)} s`);
      const fresh = await page.eval(`(() => { const p = netatlas.simController().pacer; const a = netatlas.simController().sim.actions()[0]; return p.items.filter((it) => it.f.view === 'physical' && it.f.test === undefined && it.f.t0 >= a.at).every((it) => !it.drawn); })()`);
      assert.equal(fresh, true, 'the scenario’s hops since the stream started: cable activity, not dots');
      // a dot of the stream opens the inspector, among the activity (paused for the click)
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      await page.settle(60);
      const dot = await page.eval(`(() => { for (const d of document.querySelectorAll('#canvas .layer-sim [data-flight]')) { const it = netatlas.simController().pacer.find(Number(d.getAttribute('data-flight'))); if (!it || it.f.test === undefined) continue; const r = d.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const e = document.elementFromPoint(x, y); if (e && e.closest('#canvas')) return { x, y }; } return null; })()`);
      if (dot) {
        await page.mouse('mouseMoved', dot.x, dot.y);
        await page.mouse('mousePressed', dot.x, dot.y, 'left');
        await page.mouse('mouseReleased', dot.x, dot.y, 'left');
        await page.settle(100);
        assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi').textContent`), /239\.9\.9\.9/);
        await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
      }
      // Next exchange: named, paused afterwards, the clock on
      assert.equal(await page.eval(`document.getElementById('sim-step-x').getAttribute('aria-label')`), 'Next exchange');
      const before = (await ui()).t;
      await page.eval(`document.getElementById('sim-step-x').click(), true`);
      await page.settle(60);
      assert.equal(await page.eval(`netatlas.simController().playing`), false);
      assert.ok((await ui()).t >= before);
      // Real time: the clock and the stream with the real seconds
      await page.eval(`(() => { const s = document.getElementById('sim-pace'); s.value = 'realtime'; s.dispatchEvent(new Event('change')); netatlas.simController().setPlaying(true); return true; })()`);
      const r0 = await page.eval(`[netatlas.simController().t, netatlas.simController().sim.actions()[0].progress.done, performance.now()]`);
      await wait(4000);
      const r1 = await page.eval(`[netatlas.simController().t, netatlas.simController().sim.actions()[0].progress.done, performance.now()]`);
      const real = r1[2] - r0[2];
      assert.ok(r1[0] - r0[0] <= real + 200 && r1[0] - r0[0] > real * 0.5, `${r1[0] - r0[0]} ms simulated in ${real} ms`);
      assert.ok(r1[1] - r0[1] >= 2 && r1[1] - r0[1] <= Math.ceil(real / 1000) + 1, `${r1[1] - r0[1]} datagrams in ${real} ms`);
      assert.match((await ui()).pace, /^Real time · 1×( · behind)? · your events in front$/);
      // stopped: the scenario is in front again
      await page.eval(`document.querySelector('#sim-events li[data-kind="stream"] button[data-op="stop"]').click(), true`);
      await wait(2500);
      assert.doesNotMatch((await ui()).pace, /in front/);
    } finally {
      await page.close();
    }
  });
}
