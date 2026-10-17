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

/** Fill the Send test form in the Actions panel: unicast, From, To (a device, else an address written in), the protocol. */
async function fill(page, from, to, kind) {
  await page.eval(`(() => {
    const set = (id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev || 'change')); };
    set('sim-t-type', 'unicast');
    set('sim-t-from', ${JSON.stringify(from)});
    if (Array.from(document.getElementById('sim-t-to').options).some((o) => o.value === ${JSON.stringify(to)})) set('sim-t-to', ${JSON.stringify(to)});
    else { set('sim-t-to', '*'); set('sim-t-addr', ${JSON.stringify(to)}, 'input'); }
    set('sim-t-kind', ${JSON.stringify(kind)});
    return true; })()`);
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
    assert.match(s.msg, /^Sent at t = 30 s: pc1 → srv ICMP echo; see Active events\. It starts when the simulation plays\.$/);
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

test('during the startup burst (more than is drawn), a test is drawn at once, and starts at the current simulated time', { skip, timeout: 240000 }, async () => {
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
    // (the burst is more than is drawn: bundled, the rest is cable activity)
    assert.ok(r.notDrawn > 0 && r.drawnBefore >= 1, 'the burst is bundled: ' + JSON.stringify(r));
    assert.equal(r.started, r.now, 'started at the current simulated time');
    assert.ok(r.mine > 0 && r.mineDrawn, 'drawn despite the limit');
    assert.equal(r.first, r.now, 'its first message is on its way now');
    assert.ok(r.dom > 0, 'on screen');
  } finally {
    await page.close();
  }
});

test('a series follows the simulated clock: paused, no further message is sent; playing at 1× or 4×, they go one interval of simulated time apart', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page);
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(30000); c.refresh(true); return true; })()`);
    const frames = [];
    for (const speed of [1, 4]) {
      const id = await page.eval(`(() => { const c = netatlas.simController(); c.setSpeed(${speed}); const o = c.sim.testDestinations('pc1').find((d) => d.id === 'srv').options[0];
        c.sendPlan({ delivery: 'unicast', from: 'pc1', to: 'srv', toIface: o.iface, toAddr: o.addr, kind: 'icmp', count: 4, interval: 0.5 }); return c.sim.testRuns()[0].id; })()`);
      // paused: a second of wall-clock time sends nothing more
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(await page.eval(`netatlas.simController().sim.testRuns()[0].sent`), 1, `${speed}×: paused`);
      // playing: the animation's frames (as the page draws them, here without waiting for the screen) move the clock
      const run = await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(true); let frames = 0; let r;
        for (; frames < 20000; frames++) { c.advance(100); r = c.sim.testRuns().find((x) => x.id === ${id}); if (r.sent === 4 && r.tests.every((t) => t.done)) break; }
        c.setPlaying(false); return { sent: r.sent, at: r.tests.map((t) => t.started - r.t0), frames }; })()`);
      frames.push(run.frames);
      assert.deepEqual(run.at, [0, 500, 1000, 1500], `${speed}×: ${JSON.stringify(run)}`);
    }
    // the faster playback took fewer frames for the same simulated times
    assert.ok(frames[1] < frames[0], frames.join(' vs '));
  } finally {
    await page.close();
  }
});
