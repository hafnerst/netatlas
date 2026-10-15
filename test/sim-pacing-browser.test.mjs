// Even pacing from the first packet, in a real browser (headless Chrome/Edge/
// Chromium through the DevTools protocol; skipped without one): the screen
// time of every hop, from the moment its dot starts moving to its arrival,
// is its configured pacing (Readable: about 3 s, by latency within 2–6 s)
// for the first messages after the start and for messages a minute later,
// within a small tolerance. Also after a slow first frame (the main thread
// blocked as the simulation starts), through the startup burst (more hops
// than the dot limit), and across a hidden tab: the clock never jumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load as loadJs } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const P = loadJs('analysis/sim/pacing.js');
const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start recording: each drawn hop's wall time when it starts moving and when it arrives (one already on its way is left out), and each frame's clock step. */
const RECORD_BODY = `
  const c = netatlas.simController(); const p = c.pacer;
  window.__rec = new Map(); window.__steps = []; window.__at = [];
  if (!p.__orig) p.__orig = p.frame.bind(p);
  p.frame = (ms) => { const before = p.clock; p.__orig(ms); const now = performance.now(); window.__steps.push(p.clock - before); window.__at.push(now);
    for (const it of p.items) { if (!it.drawn || it.f.hidden || it.f.view !== 'physical') continue; let r = window.__rec.get(it.f.id); const st = p.state(it);
      if (!r) { r = { id: it.f.id, hop: it.hop, lat: it.lat, track: it.f.track.ref + '|' + it.f.track.from, lost: it.f.dropped !== undefined, start: null, end: null, pre: st.phase === 'moving' && st.frac > 0.02 }; window.__rec.set(it.f.id, r); }
      if (st.phase === 'moving' && r.start === null) r.start = now;
      if (st.phase !== 'moving' && st.phase !== 'waiting' && st.phase !== 'transit' && r.start !== null && r.end === null) r.end = now; } };`;
const RECORD = `(() => { ${RECORD_BODY}; return true; })()`;
const READ = `JSON.stringify({ recs: Array.from(window.__rec.values()), steps: window.__steps, at: window.__at, speed: netatlas.simController().pacer.speed })`;

/**
 * The real time a frame took beyond FRAME_MAX between two moments: a frame
 * counts at most FRAME_MAX by design (a stall slows the dots instead of
 * making them jump), so a loaded machine's long frames are not display time.
 */
function capped(out, from, to) {
  let lost = 0;
  for (let i = 1; i < out.at.length; i++) if (out.at[i] > from && out.at[i] <= to) lost += Math.max(0, out.at[i] - out.at[i - 1] - P.FRAME_MAX);
  return lost;
}

/** The hops that moved and arrived in the window, with their screen time ÷ their configured time. */
function ratios(out, exclude = () => false) {
  return out.recs.filter((r) => r.start !== null && r.end !== null && !r.lost && !r.pre && r.hop > 0 && !exclude(r)).map((r) => ({ ...r, ratio: ((r.end - r.start - capped(out, r.start, r.end)) * out.speed) / r.hop }));
}

function assertPaced(rs, what) {
  assert.ok(rs.length >= 5, `${what}: enough hops measured (${rs.length})`);
  const bad = rs.filter((r) => r.ratio < 0.95 || r.ratio > 1.06);
  assert.equal(bad.length, 0, `${what}: screen time ÷ configured time out of 0.95–1.06: ${bad.slice(0, 5).map((r) => `${r.track} ${r.hop.toFixed(0)} ms → ${r.ratio.toFixed(3)}`).join(', ')}`);
}

test('the first packets and those a minute later take their configured screen time; a slow first frame, the startup burst and a hidden tab change nothing', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = await page.eval(`Array.from(document.querySelectorAll('#menu-examples [data-example]')).findIndex((b) => /protocol-simulation/.test(b.textContent))`);
    await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExample(${ex}), netatlas.setView('physical'), true`);
    await page.settle(150);
    // start, recording from the first frame, and keep the main thread busy for 400 ms before that frame
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }); ${RECORD_BODY}; const t = performance.now(); while (performance.now() - t < 400) {} return true; })()`);
    await wait(8000);
    const early = JSON.parse(await page.eval(READ));
    // the first frame counts nothing (the setup and the blocked thread are not display time); no frame jumps
    assert.equal(early.steps[0], 0, 'the clock starts with the first frame: ' + early.steps.slice(0, 5).join(', '));
    assert.ok(Math.max(...early.steps) <= P.FRAME_MAX * early.speed + 1e-6, 'no step beyond FRAME_MAX: ' + Math.max(...early.steps));
    assert.ok(early.recs.length > 48, 'the startup burst: more hops than the dot limit (' + early.recs.length + ')');
    const r1 = ratios(early);
    assertPaced(r1, 'the first packets');

    // a hidden tab for 1.5 s while dots are on their way: nothing moves meanwhile, and nothing jumps after it
    await page.eval(RECORD);
    await wait(1000);
    // (the clock read in the same task as each change: no frame runs between)
    const hide = JSON.parse(await page.eval(`(() => { const clock = netatlas.simController().pacer.clock; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return JSON.stringify({ clock, at: performance.now() }); })()`));
    await wait(1500);
    const show = JSON.parse(await page.eval(`(() => { const clock = netatlas.simController().pacer.clock; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); return JSON.stringify({ clock, at: performance.now() }); })()`));
    const clockBefore = hide.clock;
    const clockHidden = show.clock;
    const hiddenAt = hide.at;
    const shownAt = show.at;
    await wait(5000);
    const hid = JSON.parse(await page.eval(READ));
    assert.equal(clockHidden, clockBefore, 'hidden: the display clock stands still');
    assert.ok(Math.max(...hid.steps) <= P.FRAME_MAX * hid.speed + 1e-6, 'no jump after the tab is shown again');
    // the hops that moved while it was hidden took their time plus the hidden time; the others theirs
    const across = (r) => r.start < hiddenAt && r.end > shownAt;
    assertPaced(ratios(hid, across), 'around a hidden tab');
    for (const r of ratios(hid).filter(across)) {
      const shown = (r.end - r.start - (shownAt - hiddenAt)) * hid.speed;
      assert.ok(Math.abs(shown - r.hop) / r.hop < 0.08, `a hop across the hidden time moved for its own time on screen: ${shown.toFixed(0)} of ${r.hop.toFixed(0)} ms`);
    }

    // a minute later
    await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(false); c.runTo(c.t + 60000); c.setPlaying(true); return true; })()`);
    await page.eval(RECORD);
    await wait(8000);
    const late = JSON.parse(await page.eval(READ));
    const r2 = ratios(late);
    assertPaced(r2, 'a minute later');
    // the same hop (cable, direction, latency) is given the same time early and late: nothing learned meanwhile
    const key = (r) => `${r.track}|${r.lat.toFixed(6)}`;
    const firstHop = new Map(r1.map((r) => [key(r), r.hop]));
    let same = 0;
    for (const r of r2) {
      if (!firstHop.has(key(r))) continue;
      same++;
      assert.ok(Math.abs(firstHop.get(key(r)) - r.hop) < 1e-6, `${key(r)}: ${firstHop.get(key(r))} then ${r.hop}`);
    }
    assert.ok(same > 0 || r2.length > 0);
  } finally {
    await page.close();
  }
});
