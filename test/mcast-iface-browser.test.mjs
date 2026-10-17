// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), the private house, both themes. Multicast from
// Network events: a join's reports and a stream's datagrams are dots in the
// diagram although no multicast protocol can be ticked, a dot opens the
// packet inspector, nothing moves while paused. Interface actions: the form
// follows the chosen interface's state (marked with an icon and words; Bring
// interface up, Stop flapping), whatever changed it; Shut interface ends a
// flapping first; switching the interface shows that one's state; the
// keyboard works the buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** The dots on the canvas of an id's traffic: their flights' protocol, and a point to click that nothing covers. */
const DOTS = (tag) => `(() => { const c = netatlas.simController(); const out = [];
  for (const d of document.querySelectorAll('#canvas .layer-sim [data-flight]')) {
    const id = Number(d.getAttribute('data-flight')); const it = c.pacer.find(id); const f = it ? it.f : null;
    if (!f || f.test !== ${tag}) continue;
    const r = d.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const e = document.elementFromPoint(x, y);
    out.push({ id, protocol: f.protocol, x, y, free: !!e && !!e.closest('#canvas') });
  } return out; })()`;
const FORM = `(() => { const g = (id) => document.getElementById(id); return { shut: g('sim-i-shut').textContent, flap: g('sim-i-flap').textContent, flapOff: g('sim-i-flap').disabled, state: g('sim-i-state').textContent, mark: document.querySelector('.sim-i-form').getAttribute('data-state'), option: g('sim-i-if').selectedOptions[0] ? g('sim-i-if').selectedOptions[0].textContent : null, need: g('sim-i-need').textContent }; })()`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: a multicast join’s and stream’s packets are drawn and inspectable; Interface actions show the interface’s state and its reverse action`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    const set = (id, v, ev = 'change') => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)})); return true; })()`);
    // (a press half a second after the last of the same button: a quicker one counts as the same press)
    const press = async (id) => {
      await new Promise((r) => setTimeout(r, 550));
      await page.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`);
      await page.settle(40);
    };
    const frames = (n, ms = 50) => page.eval(`(() => { const c = netatlas.simController(); for (let i = 0; i < ${n}; i++) c.advance(${ms}); c.refresh(true); return c.t; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), netatlas.fit(), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(9000); c.refresh(true); return true; })()`);
      await page.settle(150);
      // IGMP / MLD to tick (the core's queries as the IoT VLAN's snooping querier); no streams of the model's
      assert.deepEqual(await page.eval(`netatlas.simController().protocolEntries().filter((e) => e.id === 'igmp' || e.id === 'mcast').map((e) => e.id)`), ['igmp']);
      // the forms: the TV joins 239.1.1.1, the NAS streams to it
      await page.eval(`document.getElementById('sim-ne-join-toggle').click(), document.getElementById('sim-ne-stream-toggle').click(), true`);
      await set('sim-j-dev', 'tv');
      await set('sim-j-group', '239.1.1.1', 'input');
      await page.eval(`document.getElementById('sim-j-go').click(), true`);
      await set('sim-s-dev', 'nas');
      await set('sim-s-group', '239.1.1.1', 'input');
      await set('sim-s-port', '5004', 'input');
      await page.eval(`document.getElementById('sim-s-go').click(), true`);
      await page.settle(60);
      const tags = await page.eval(`netatlas.simController().sim.actions().map((v) => [v.kind, v.tests[0]])`);
      const tag = Object.fromEntries(tags);
      // paused: drawn at once where they are, nothing moves
      const t0 = await page.eval(`netatlas.simController().t`);
      let J = await page.eval(DOTS(tag.join));
      let D = await page.eval(DOTS(tag.stream));
      assert.ok(J.length > 0 && J.every((d) => d.protocol === 'igmp'), `the join's report: ${JSON.stringify(J)}`);
      assert.ok(D.length > 0 && D.every((d) => d.protocol === 'mcast'), `the stream's datagram: ${JSON.stringify(D)}`);
      await page.settle(400);
      assert.equal(await page.eval(`netatlas.simController().t`), t0, 'paused');
      // playing (frames as the page draws them): the stream's copies along VLAN 10
      await page.eval(`netatlas.simController().setPlaying(true), true`);
      await frames(60);
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      D = await page.eval(DOTS(tag.stream));
      assert.ok(D.length > 0, 'its datagrams on screen');
      // a dot of the stream opens the inspector: a UDP datagram to the group
      const dot = D.find((d) => d.free) || D[0];
      await page.mouse('mouseMoved', dot.x, dot.y);
      await page.mouse('mousePressed', dot.x, dot.y, 'left');
      await page.mouse('mouseReleased', dot.x, dot.y, 'left');
      await page.settle(100);
      const pi = await page.eval(`(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"] .pi'); return p ? p.textContent : null; })()`);
      assert.ok(pi && /239\.1\.1\.1/.test(pi) && /UDP/.test(pi), pi);
      await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
      // the event: its first datagram in the inspector from its details too
      assert.equal(await page.eval(`netatlas.simController().inspectTest(${tag.stream})`), true);
      await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
      // Stop stream: no datagram after it
      await page.eval(`document.querySelector('#sim-events li[data-kind="stream"] button[data-op="stop"]').click(), true`);
      const stopAt = await page.eval(`netatlas.simController().t`);
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 5000); c.refresh(true); return true; })()`);
      assert.equal(await page.eval(`netatlas.simController().sim.engine.flights.filter((f) => f.test === ${tag.stream} && f.t0 > ${stopAt}).length`), 0);

      // Interface actions: core:wan flapping
      await page.eval(`document.getElementById('sim-ne-iface-toggle').click(), true`);
      await set('sim-i-dev', 'core');
      await set('sim-i-if', 'wan');
      let F = await page.eval(FORM);
      assert.deepEqual([F.shut, F.flap, F.mark, F.state], ['Shut interface', 'Start flapping', null, 'Administratively up · link up']);
      await press('sim-i-flap');
      F = await page.eval(FORM);
      assert.deepEqual([F.flap, F.mark, F.option], ['Stop flapping', 'flapping', 'wan (flapping)']);
      assert.match(F.state, /^↯ Flapping: down now, cycle 1 of 3 · administratively up$/);
      assert.equal(F.need, 'Shut interface stops the flapping first.');
      // a quick second press is the same press, not Stop flapping
      await page.eval(`document.getElementById('sim-i-flap').click(), true`);
      assert.equal((await page.eval(FORM)).flap, 'Stop flapping');
      // another interface: its own state, nothing carried over; back: flapping again
      await set('sim-i-if', 'nas');
      F = await page.eval(FORM);
      assert.deepEqual([F.shut, F.flap, F.mark], ['Shut interface', 'Start flapping', null]);
      await set('sim-i-if', 'wan');
      assert.equal((await page.eval(FORM)).mark, 'flapping');
      // a flap's own transition: the state line follows (up now)
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 6000); c.refresh(true); return true; })()`);
      assert.match((await page.eval(FORM)).state, /^↯ Flapping: up now/);
      // Shut interface while flapping: the flapping stops first, the interface is shut; the form says so
      await press('sim-i-shut');
      F = await page.eval(FORM);
      assert.deepEqual([F.shut, F.flap, F.flapOff, F.mark], ['Bring interface up', 'Start flapping', true, 'shut']);
      assert.match(F.state, /^⏻ Shut: administratively down · link down$/);
      assert.equal(F.need, 'core:wan is shut: bring it up first.');
      const ev = await page.eval(`Array.from(document.querySelectorAll('#sim-events > li[data-act]')).map((li) => li.getAttribute('data-kind') + ':' + li.getAttribute('data-status'))`);
      assert.deepEqual(ev.slice(0, 2), ['shut:completed', 'flap:stopped']);
      // from the keyboard: Bring interface up (Enter on the focused button)
      await new Promise((r) => setTimeout(r, 550));
      await page.eval(`document.getElementById('sim-i-shut').focus(), true`);
      await page.key('Enter', 'Enter', 13);
      F = await page.eval(FORM);
      assert.deepEqual([F.shut, F.mark], ['Shut interface', null]);
      assert.match(F.state, /^Administratively up · (link coming up|link up|link down)/);
      assert.equal(await page.eval(`document.activeElement.id`), 'sim-i-shut', 'the focus stays on the button');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 8000); c.refresh(true); return true; })()`);
      assert.equal((await page.eval(FORM)).state, 'Administratively up · link up');
      // changed elsewhere (the diagram's menu, Active events): the form follows
      await page.eval(`(() => { const c = netatlas.simController(); c.shut('core', 'wan'); c.refresh(true); return true; })()`);
      assert.equal((await page.eval(FORM)).shut, 'Bring interface up');
      await page.eval(`document.querySelector('#sim-events li[data-kind="shut"] button[data-op="noshut"]').click(), true`);
      await page.settle(40);
      assert.equal((await page.eval(FORM)).shut, 'Shut interface');
      // the peer off: administratively up, the link down, and why
      await page.eval(`(() => { const c = netatlas.simController(); c.powerOff('dsl-router'); c.runTo(c.t + 5000); c.refresh(true); return true; })()`);
      assert.equal((await page.eval(FORM)).state, 'Administratively up · link down (dsl-router is off)');
      // the mark is more than a colour: a bar and a tint besides its icon and words
      await page.eval(`(() => { const c = netatlas.simController(); c.shut('core', 'wan'); c.refresh(true); return true; })()`);
      const cs = await page.eval(`(() => { const s = getComputedStyle(document.querySelector('.sim-i-form')); return [s.borderLeftWidth, s.fontWeight, getComputedStyle(document.getElementById('sim-i-state')).fontWeight]; })()`);
      assert.equal(cs[0], '3px');
      assert.ok(Number(cs[2]) >= 600);
      // a new simulation: nothing of it left
      await page.eval(`(() => { netatlas.exitSimulation(); netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.refresh(true); return true; })()`);
      await page.settle(100);
      assert.deepEqual(await page.eval(`[document.getElementById('sim-i-dev').value, !!document.querySelector('.sim-i-form[data-state]'), document.querySelectorAll('#sim-events > li[data-act]').length]`), ['', false, 0]);
    } finally {
      await page.close();
    }
  });
}
