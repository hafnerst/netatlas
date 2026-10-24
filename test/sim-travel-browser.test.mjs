// Visible travel time in a real browser (headless Chrome/Edge/Chromium through the DevTools protocol; skipped without
// one): at 1× in Readable pacing every dot crosses its line in 3–5 s of screen time, the 15 ms WAN link of the example
// visibly longer than its LAN cables; several dots move at once; pause freezes a dot where it is and resume goes on from
// there; 2× halves the screen time; switching to the logical view and back on the way restarts nothing; and Exit while
// dots are on their way answers at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load as loadJs } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const T = loadJs('analysis/sim/travel.js');
const P = loadJs('analysis/sim/pacing.js');
const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record each drawn physical hop: its hop, its wall time from moving to arrived, the most dots moving at once. */
const RECORD = `(() => {
  const c = netatlas.simController(); const p = c.pacer;
  window.__rec = new Map(); window.__most = 0; window.__at = [];
  if (!p.__orig) p.__orig = p.frame.bind(p);
  p.frame = (ms) => { p.__orig(ms); const now = performance.now(); window.__at.push(now); let moving = 0;
    for (const it of p.items) { if (!it.drawn || it.f.hidden || it.f.view !== 'physical' || !c.renderable(it.f)) continue; const st = p.state(it);
      let r = window.__rec.get(it.f.id);
      if (!r) { r = { id: it.f.id, hop: it.hop, ref: it.f.track.ref, lost: it.f.dropped !== undefined, start: null, end: null, pre: st.phase === 'moving' && st.frac > 0.02 }; window.__rec.set(it.f.id, r); }
      if (st.phase === 'moving') { moving++; if (r.start === null) r.start = now; }
      if (st.phase !== 'moving' && st.phase !== 'waiting' && st.phase !== 'transit' && r.start !== null && r.end === null) r.end = now; }
    window.__most = Math.max(window.__most, moving); };
  return true; })()`;
const READ = `JSON.stringify({ recs: Array.from(window.__rec.values()), most: window.__most, at: window.__at, speed: netatlas.simController().pacer.speed })`;

/** Real ms beyond FRAME_MAX between two moments (a loaded machine's long frames are not display time, by design). */
function capped(out, from, to) {
  let lost = 0;
  for (let i = 1; i < out.at.length; i++) if (out.at[i] > from && out.at[i] <= to) lost += Math.max(0, out.at[i] - out.at[i - 1] - P.FRAME_MAX);
  return lost;
}
const measured = (out) => out.recs.filter((r) => r.start !== null && r.end !== null && !r.lost && !r.pre).map((r) => ({ ...r, screen: (r.end - r.start - capped(out, r.start, r.end)) * out.speed }));

test('Readable at 1×: every dot 3–5 s, the WAN link longer than the LAN cables, several at once; pause, 2×, a view switch and Exit on the way', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
    await page.settle(150);
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }); const p = netatlas.simController().pacer; p.convLimit = 1000; p.summarizeRepeats = false; return true; })()`);
    await page.eval(RECORD);
    assert.match(await page.eval(`netatlas.simController().pacingText()`), /^Readable · 3–5 s per hop · 1×/);
    await wait(12000);
    const one = JSON.parse(await page.eval(READ));
    const rs = measured(one);
    assert.ok(rs.length >= 8, `enough hops measured (${rs.length})`);
    // each dot's screen time: its hop (to a frame or two), and every hop within the bounds
    for (const r of rs) {
      assert.ok(r.hop >= T.TRAVEL_MIN - 1e-6 && r.hop <= T.TRAVEL_MAX + 1e-6, `${r.ref}: ${r.hop}`);
      assert.ok(r.screen >= r.hop * 0.95 && r.screen <= r.hop * 1.06, `${r.ref}: ${r.screen.toFixed(0)} ms on screen for ${r.hop.toFixed(0)}`);
    }
    assert.ok(one.most >= 2, `several dots on their way at once (${one.most})`);
    // the model's 15 ms WAN link: its hops longer than any LAN cable's (from the same mapping, in the page)
    const wan = await page.eval(`(() => { const c = netatlas.simController(); const l = netatlas.session.model.links.find((x) => Number(c.sim.engine.latency(x.id).value) === 15); return l ? l.id : ''; })()`);
    assert.ok(wan, 'the example has its 15 ms cables (the Internet cloud’s)');
    const hops = JSON.parse(await page.eval(`JSON.stringify((() => { const c = netatlas.simController(); const e = c.sim.engine; return { wan: c.pacer.hopTime(e.linkCost(${JSON.stringify(wan)})), lan: Math.min(...netatlas.session.model.links.map((l) => c.pacer.hopTime(e.linkCost(l.id)))) }; })())`));
    assert.ok(hops.wan > hops.lan + 500, `WAN ${hops.wan} vs LAN ${hops.lan}`);

    // pause with a dot on its way: it keeps its place for a second; resumed, it goes on from there
    const paused = JSON.parse(await page.eval(`(() => { const c = netatlas.simController(); const p = c.pacer; const it = p.items.find((x) => x.drawn && x.f.view === 'physical' && p.state(x).phase === 'moving' && p.state(x).frac < 0.7); c.setPlaying(false); return JSON.stringify(it ? { id: it.f.id, frac: p.state(it).frac, clock: p.clock } : null); })()`));
    assert.ok(paused, 'a dot on its way to pause');
    await wait(1000);
    const still = JSON.parse(await page.eval(`(() => { const p = netatlas.simController().pacer; const it = p.find(${paused.id}); return JSON.stringify({ frac: it ? p.state(it).frac : null, clock: p.clock }); })()`));
    assert.deepEqual(still, { frac: paused.frac, clock: paused.clock }, 'paused: the dot and the clock stand');
    await page.eval(`netatlas.simController().setPlaying(true), true`);
    await wait(400);
    const on = await page.eval(`(() => { const p = netatlas.simController().pacer; const it = p.find(${paused.id}); return it ? p.state(it).frac : 1; })()`);
    assert.ok(on > paused.frac, `resumed: on from ${paused.frac} to ${on}`);

    // 2×: the same hops, half the real time
    await page.eval(`netatlas.simController().setSpeed(2), true`);
    await page.eval(RECORD);
    await wait(8000);
    const two = JSON.parse(await page.eval(READ));
    const r2 = measured(two);
    assert.ok(r2.length >= 3, `hops at 2× (${r2.length})`);
    for (const r of r2) assert.ok(r.screen >= r.hop * 0.95 && r.screen <= r.hop * 1.06, `2× ${r.ref}: ${(r.screen / 2).toFixed(0)} real ms for ${r.hop.toFixed(0)}`);
    await page.eval(`netatlas.simController().setSpeed(1), true`);

    // the logical view and back with dots on their way: nothing restarted or re-timed
    const before = JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().pacer.items.map((it) => [it.f.id, it.d0, it.hop, it.transit]))`));
    await page.eval(`netatlas.setView('logical'), true`);
    await wait(700);
    await page.eval(`netatlas.setView('physical'), true`);
    await wait(300);
    const after = new Map(JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().pacer.items.map((it) => [it.f.id, [it.d0, it.hop, it.transit]]))`)));
    let kept = 0;
    for (const [id, d0, hop, transit] of before)
      if (after.has(id)) {
        assert.deepEqual(after.get(id), [d0, hop, transit], `flight ${id}`);
        kept++;
      }
    assert.ok(kept > 0, 'dots still kept after the switch');

    // Exit with dots on their way: at once (no wait for a dot)
    const exit = JSON.parse(await page.eval(`(() => { const p = netatlas.simController().pacer; const moving = p.items.filter((x) => x.drawn && p.state(x).phase === 'moving').length; const t = performance.now(); netatlas.exitSimulation(); return JSON.stringify({ moving, ms: performance.now() - t, on: netatlas.simulationOn() }); })()`));
    assert.ok(exit.moving > 0, 'dots were on their way');
    assert.equal(exit.on, false);
    assert.ok(exit.ms < 1000, `Exit took ${exit.ms.toFixed(0)} ms`);
  } finally {
    await page.close();
  }
});
