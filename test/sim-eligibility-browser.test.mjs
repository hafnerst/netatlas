// A hold only for a dot the scene can draw, in a real browser (headless
// Chrome/Edge/Chromium through the DevTools protocol; skipped without one):
// a delivery held for its dot is let go when the dot's track leaves the
// scene — a device filter, a collapsed group, the IP / Non-IP switch, the
// scene redrawn — and a dot of what was delivered meanwhile is not drawn as
// still on its way when the track comes back. Nothing is reordered: the
// simulation goes on in its order, the outcome is the same.
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

/** The state the test reads: what is held, whether its track is in the scene, and whether a gated dot on its way has no track or was delivered. */
const STATE = `(() => {
  const c = netatlas.simController(); const p = c.pacer; const h = p.holding();
  const bad = p.items.filter((it) => p.gated(it) && p.clock < p.arrival(it) - 1e-6 && !c.renderable(it.f)).map((it) => it.f.label + ' ' + it.f.track.ref);
  const stale = p.items.filter((it) => it.drawn && p.host.shown(it.f) && p.clock < p.arrival(it) - 1e-6 && it.f.delivered && !it.f.due).map((it) => it.f.label + ' ' + it.f.track.ref);
  return JSON.stringify({ now: c.sim.now, held: h ? { id: h.f.id, ref: h.f.track.ref, t1: h.f.t1, renderable: c.renderable(h.f) } : null, bad, stale });
})()`;

async function heldOn(page, pred, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = JSON.parse(await page.eval(STATE));
    if (s.held && pred(s.held)) return s;
    await wait(100);
  }
  throw new Error('no hold of the kind expected');
}

test('a held dot whose track leaves the scene (device filter, collapsed group, IP / Non-IP, scene redrawn) lets go of its hold; back, nothing delivered is drawn as on its way', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('vme-rack.yaml'), netatlas.setView('physical'), true`);
    await page.settle(200);
    await page.eval(`netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }), true`);
    await page.settle(300);
    const all = await page.eval(`JSON.stringify(netatlas.session.model.devices.map((d) => d.id))`);
    // 1. a device filter: a ping from the workstation to SBC 1, held on a cable; the workstation filtered out
    await page.eval(`netatlas.simController().sim.actSend({ delivery: 'unicast', from: 'ews', kind: 'icmp', target: '10.30.0.11' }), true`);
    let s = await heldOn(page, (h) => h.ref === 'link:l-ews');
    await page.eval(`netatlas.session.setDevices(${all}.filter((d) => d !== 'ews')), netatlas.render(), true`);
    await wait(400);
    let after = JSON.parse(await page.eval(STATE));
    assert.deepEqual(after.bad, [], 'no gated dot without its track');
    assert.ok(!after.held || after.held.ref !== 'link:l-ews', 'its hold let go');
    // it goes on in its order, without waiting for the hidden dot
    const until = Date.now() + 20000;
    while (Date.now() < until && JSON.parse(await page.eval(STATE)).now <= s.held.t1) await wait(100);
    assert.ok(JSON.parse(await page.eval(STATE)).now > s.held.t1, 'past the hidden arrival');
    // back: what was delivered meanwhile is not drawn as on its way
    await page.eval(`netatlas.session.setDevices(${all}), netatlas.render(), true`);
    await wait(300);
    assert.deepEqual(JSON.parse(await page.eval(STATE)).stale, [], 'no delivered hop drawn as still on its way');
    // 2. a collapsed group: illustrative data inside the crate, held, the crate collapsed
    await page.eval(`netatlas.simController().sim.actOpaque({ initiator: 'cpu1:vme', from: 'adc:vme', to: ['cpu1:vme'], count: 3, interval: 1000, size: 64 }), true`);
    s = await heldOn(page, (h) => h.ref === 'interconnect:vmebus');
    await page.eval(`netatlas.session.setCollapsed('crate', true), netatlas.render(), true`);
    await wait(400);
    after = JSON.parse(await page.eval(STATE));
    assert.deepEqual(after.bad, []);
    assert.ok(!after.held || after.held.ref !== 'interconnect:vmebus', 'the collapsed crate’s dot holds nothing');
    await page.eval(`netatlas.session.setCollapsed('crate', false), netatlas.render(), true`);
    await wait(300);
    assert.deepEqual(JSON.parse(await page.eval(STATE)).stale, []);
    // 3. IP / Non-IP: a non-IP dot held, the diagram switched to IP only
    await page.eval(`netatlas.simController().sim.actOpaque({ initiator: 'gps:com1', from: 'gps:com1', to: ['cpu2:com2'], count: 3, interval: 1000, size: 82 }), true`);
    s = await heldOn(page, (h) => h.ref === 'interconnect:gps-nmea');
    await page.eval(`netatlas.session.setConnections('ip'), netatlas.render(), true`);
    await wait(400);
    after = JSON.parse(await page.eval(STATE));
    assert.deepEqual(after.bad, []);
    assert.ok(!after.held || after.held.ref.indexOf('interconnect:') !== 0, 'no non-IP hold with IP only shown');
    await page.eval(`netatlas.session.setConnections('all'), netatlas.render(), true`);
    await wait(300);
    assert.deepEqual(JSON.parse(await page.eval(STATE)).stale, []);
    // 4. the scene redrawn (the same tracks): the hold stays what it was, nothing stale
    await page.eval(`netatlas.simController().sim.actSend({ delivery: 'unicast', from: 'ews', kind: 'icmp', target: '10.30.0.12' }), true`);
    s = await heldOn(page, (h) => h.renderable);
    await page.eval(`netatlas.render(), true`);
    await wait(100);
    after = JSON.parse(await page.eval(STATE));
    assert.deepEqual(after.bad, []);
    assert.deepEqual(after.stale, []);
    // the outcomes: the pings answered, the transfers delivered — as if nothing had been hidden
    const out = JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().sim.actions().map((a) => a.status))`));
    void out;
    const until2 = Date.now() + 60000;
    let done = false;
    while (!done && Date.now() < until2) {
      done = JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().sim.actions().every((a) => a.status !== 'running'))`));
      if (!done) await wait(200);
    }
    const st = JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().sim.actions().map((a) => [a.title, a.status]))`));
    assert.ok(st.every(([, x]) => x === 'completed'), JSON.stringify(st));
  } finally {
    await page.close();
  }
});
