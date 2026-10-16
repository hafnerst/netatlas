// Send test on screen, with real input (headless Chrome/Edge/Chromium through
// the DevTools protocol; skipped without one): a test's messages are drawn
// and listed whatever the senders and the protocols ticked, take display
// priority at the dot limit, say "Test" in their label and in the event
// log, and draw a trail; sent while paused, a test is sent at the current
// time, the panel says it starts when the simulation plays, and Send and
// play sends it and plays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function load(page) {
  await page.settle(150);
  const ex = 'protocol-simulation.yaml';
  await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), true`);
  await page.settle(150);
}

/** Fill the Send test form (From, To, Type) in the Actions panel. */
async function fill(page, from, to, kind) {
  await page.eval(`(() => { const f = document.getElementById('sim-t-from'); f.value = ${JSON.stringify(from)}; f.dispatchEvent(new Event('change')); const k = document.getElementById('sim-t-kind'); k.value = ${JSON.stringify(kind)}; k.dispatchEvent(new Event('change')); const t = document.getElementById('sim-t-to'); t.value = ${JSON.stringify(to)}; return true; })()`);
}

test('paused: Send sends at the current time and says it starts when the simulation plays; Send and play sends and plays; shown despite the senders and protocols, marked Test, with a trail', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page);
    // srv the only sender, and ICMP not ticked: pc1's ping would be hidden, were it not a test
    await page.eval(`(() => { const ids = netatlas.simController ? null : null; netatlas.startProtocolSimulation({ params: {}, senders: ['srv'], protocols: [] }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(30000); c.refresh(true); return true; })()`);
    await page.settle(150);
    const before = await page.eval(`(() => { const c = netatlas.simController(); return { t: c.t, clock: c.pacer.clock, shown: c.shown.size, sendPlay: !document.getElementById('sim-t-sendplay').hidden }; })()`);
    assert.equal(before.shown, 0, 'no protocol ticked');
    assert.equal(before.sendPlay, true, 'Send and play is offered while paused');
    await fill(page, 'pc1', 'srv', 'icmp');
    // (the Actions panel scrolls to the button, as one does)
    await page.eval(`document.getElementById('sim-t-send').scrollIntoView({ block: 'nearest' }), true`);
    await page.click('#sim-t-send');
    await page.settle(150);
    const s = await page.eval(`(() => { const c = netatlas.simController(); const t = c.sim.tests()[0];
      return { msg: document.getElementById('sim-t-msg').textContent, t: c.t, clock: c.pacer.clock, playing: c.playing, started: t.started,
        items: c.drawItems().filter((d) => d.f.test === t.id).length, labels: Array.from(document.querySelectorAll('#canvas .layer-sim-labels .sim-test text')).map((x) => x.textContent) }; })()`);
    assert.match(s.msg, /^Sent at t = 30 s: pc1 → srv ICMP echo\. It starts when the simulation plays\.$/);
    assert.equal(s.playing, false);
    assert.equal(s.t, before.t, 'paused: the time does not move');
    assert.equal(s.clock, before.clock);
    assert.equal(s.started, before.t, 'sent at the current time');
    assert.ok(s.items > 0, 'drawn despite the senders and the protocols');
    assert.ok(s.labels.some((l) => /^Test · ICMP Echo → /.test(l)), s.labels.join(' | '));
    // Send and play: another test, and it plays
    await fill(page, 'pc1', '203.0.113.80', 'icmp');
    // (the Actions panel scrolls to the button, as one does)
    await page.eval(`document.getElementById('sim-t-sendplay').scrollIntoView({ block: 'nearest' }), true`);
    await page.click('#sim-t-sendplay');
    await page.settle(200);
    const p = await page.eval(`(() => { const c = netatlas.simController(); return { playing: c.playing, msg: document.getElementById('sim-t-msg').textContent, hidden: document.getElementById('sim-t-sendplay').hidden, n: c.sim.tests().length }; })()`);
    assert.equal(p.playing, true);
    assert.equal(p.hidden, true, 'no Send and play while playing');
    assert.equal(p.n, 2);
    assert.match(p.msg, /^Test sent at t = /);
    // a few seconds: the tests' messages in the log, marked Test; their dots with a trail
    await new Promise((r) => setTimeout(r, 4000));
    const log = await page.eval(`(() => { const c = netatlas.simController(); c.refresh(true);
      const rows = Array.from(document.querySelectorAll('#sd-log tbody tr')).filter((r) => r.querySelector('.sim-test-tag'));
      return { rows: rows.length, what: rows.map((r) => r.textContent).slice(0, 4), trails: document.querySelectorAll('#canvas .layer-sim .sim-trail').length, followedDots: c.drawItems().filter((d) => d.test && d.followed).length, allTest: c.drawItems().every((d) => d.test) }; })()`);
    assert.ok(log.rows > 0, 'the log lists the tests’ messages, marked Test');
    assert.ok(log.what.every((w) => /^.*Test/.test(w)), log.what.join(' | '));
    assert.ok(log.allTest, 'nothing else is shown (no protocol ticked)');
    assert.ok(log.followedDots === 0 || log.trails > 0, 'a trail as with Follow message');
  } finally {
    await page.close();
  }
});

test('at the dot limit, a test sent during the startup burst is drawn at once, and starts at the current simulated time', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page);
    await page.eval(`netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }), true`);
    // the burst after the links come up: more dots than the limit
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await page.eval(`netatlas.simController().pacer.notDrawn > 0`)) break;
    }
    const r = await page.eval(`(() => { const c = netatlas.simController(); const p = c.pacer;
      const drawnBefore = p.items.filter((it) => it.drawn && !it.f.hidden && c.drawItems().some((d) => d.f === it.f)).length;
      const now = c.t; const msg = c.sendTest({ from: 'pc1', to: 'core1', kind: 'icmp' }); const t = c.sim.tests()[0];
      c.advance(16); c.refresh(true);
      const mine = p.items.filter((it) => it.test);
      return { notDrawn: p.notDrawn, drawnBefore, now, started: t.started, first: mine.length ? Math.min(...mine.map((it) => it.f.t0)) : null, mineDrawn: mine.every((it) => it.drawn), mine: mine.length, dom: document.querySelectorAll('#canvas .layer-sim .sim-test').length, msg }; })()`);
    assert.ok(r.notDrawn > 0 && r.drawnBefore >= 40, 'the dot limit is reached: ' + JSON.stringify(r));
    assert.equal(r.started, r.now, 'started at the current simulated time');
    assert.ok(r.mine > 0 && r.mineDrawn, 'drawn despite the limit');
    assert.equal(r.first, r.now, 'its first message is on its way now');
    assert.ok(r.dom > 0, 'on screen');
  } finally {
    await page.close();
  }
});
