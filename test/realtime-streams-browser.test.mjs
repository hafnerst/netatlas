// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), the busy internal example, both themes.
// Two multicast streams started from the form run side by side, each a
// datagram every real second in Readable pacing, both with datagrams on
// their way at once, each inspectable with its own port; paused, both say
// Paused and send nothing; Stop one, the other goes on. A device's
// lifecycle in the diagram: powered off "⏻ Off", booting "↻ Booting", a
// tooltip with its state, the box neither moved nor resized, its label
// clear; operational: no badge; a shut interface marks no device off; an
// external network has no badge and no Power off; Exit clears it all.
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

/** The dots of an id's traffic on the canvas: how many, of how many datagrams (their send times), a point to click that nothing covers. */
const DOTS = (tag) => `(() => { const c = netatlas.simController(); const out = []; const sends = new Set();
  for (const d of document.querySelectorAll('#canvas .layer-sim [data-flight]')) {
    const it = c.pacer.find(Number(d.getAttribute('data-flight'))); if (!it || it.f.test !== ${tag}) continue;
    sends.add(Math.round(it.f.t0));
    const r = d.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const e = document.elementFromPoint(x, y);
    out.push({ x, y, free: !!e && !!e.closest('#canvas') });
  } return { dots: out.length, datagrams: sends.size, free: out.filter((d) => d.free) }; })()`;
/** The streams' events: status, the originating datagrams, their traffic id, the summary. */
const STREAMS = `netatlas.simController().sim.actions().filter((v) => v.kind === 'stream').reverse().map((v) => ({ id: v.id, status: v.status, done: v.progress.done, tag: v.tests[0], summary: v.summary, row: (document.querySelector('#sim-events li[data-kind="stream"][data-act="' + v.id + '"]') || document.querySelector('#sim-events li[data-kind="stream"]')).getAttribute('data-status') }))`;
/** A device's box, its power badge and tooltip, its marks. */
const DEV = (id) => `(() => { const n = document.querySelector('#canvas .node[data-ref="device:${id}"]'); const box = n.querySelector('.dev-box').getBoundingClientRect();
  const b = document.querySelector('#canvas .layer-sim-power .sim-power[data-device="${id}"]'); const br = b ? b.getBoundingClientRect() : null;
  const texts = Array.from(n.querySelectorAll('text')).map((t) => t.getBoundingClientRect()).filter((r) => r.width > 0);
  const hit = br ? texts.some((r) => r.left < br.right - 1 && r.right > br.left + 1 && r.top < br.bottom - 1 && r.bottom > br.top + 1) : false;
  return { box: [box.x, box.y, box.width, box.height].map((v) => Math.round(v * 10) / 10), power: b ? b.getAttribute('data-power') : null, text: b ? b.querySelector('text').textContent : null, tip: b ? b.querySelector('title').textContent : null, aria: b ? b.getAttribute('aria-label') : null,
    stroke: b ? getComputedStyle(b.querySelector('rect')).stroke : null, off: n.classList.contains('sim-off'), booting: n.classList.contains('sim-booting'), down: n.classList.contains('sim-down'), overlapsLabel: hit }; })()`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: two streams side by side in real seconds, Paused, Stop one; devices powered off and booting in the diagram, operational without a badge`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    const set = (id, v, ev = 'change') => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)})); return true; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`netatlas.startProtocolSimulation(), netatlas.fit(), true`);
      await wait(3000);
      // two streams from the form: srv and pc2 to 239.1.1.1 (members in the campus and site B), 1 s each
      await page.eval(`document.getElementById('sim-ne-stream-toggle').click(), true`);
      for (const [dev, port] of [['srv', '5010'], ['pc2', '5012']]) {
        await set('sim-s-dev', dev);
        await set('sim-s-group', '239.1.1.1', 'input');
        await set('sim-s-port', port, 'input');
        await set('sim-s-int', '1', 'input');
        await page.eval(`document.getElementById('sim-s-go').click(), true`);
        await page.settle(30);
      }
      const t0 = await page.eval(`performance.now()`);
      let S = await page.eval(STREAMS);
      assert.equal(S.length, 2, JSON.stringify(S));
      assert.ok(S[0].tag !== S[1].tag, 'each its own traffic');
      await wait(5000);
      S = await page.eval(STREAMS);
      const secs = ((await page.eval(`performance.now()`)) - t0) / 1000;
      // each a datagram every real second (the first at once): within a frame or two of the real seconds, neither waiting for the other
      for (const s of S) {
        assert.ok(s.done >= Math.floor(secs) && s.done <= Math.floor(secs) + 2, `${s.done} datagrams in ${secs.toFixed(2)} s`);
        assert.equal(s.status, 'running');
        assert.equal(s.row, 'running');
        assert.match(s.summary, /^\d+ datagrams sent, every 1 s of real time · /);
      }
      assert.ok(Math.abs(S[0].done - S[1].done) <= 1, 'side by side, not taking turns');
      assert.match(await page.eval(`document.getElementById('sim-pace-text').textContent`), /^Readable · 3 s per hop · 1× · streams in real time( · behind)?$/);
      // both on screen at once, each with several datagrams on their way (a path takes longer than the interval)
      const A = await page.eval(DOTS(S[0].tag));
      const B = await page.eval(DOTS(S[1].tag));
      assert.ok(A.dots > 0 && B.dots > 0, JSON.stringify([A.dots, B.dots]));
      assert.ok(A.datagrams >= 2 && B.datagrams >= 2, JSON.stringify([A.datagrams, B.datagrams]));
      // paused: both Paused, nothing sent
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      await page.settle(60);
      const P0 = await page.eval(STREAMS);
      await wait(2000);
      const P1 = await page.eval(STREAMS);
      assert.deepEqual(P1.map((s) => [s.status, s.row]), [['paused', 'paused'], ['paused', 'paused']]);
      assert.deepEqual(P1.map((s) => s.done), P0.map((s) => s.done), 'nothing while paused');
      // a dot of the second stream opens the inspector: its group and its own port
      const dot = (await page.eval(DOTS(S[1].tag))).free[0];
      if (dot) {
        await page.mouse('mouseMoved', dot.x, dot.y);
        await page.mouse('mousePressed', dot.x, dot.y, 'left');
        await page.mouse('mouseReleased', dot.x, dot.y, 'left');
      } else await page.eval(`netatlas.simController().inspectTest(${S[1].tag}), true`);
      await page.settle(100);
      const pi = await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi').textContent`);
      assert.ok(/239\.1\.1\.1/.test(pi) && /5012/.test(pi) && !/5010/.test(pi), pi);
      await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), netatlas.simController().setPlaying(true), true`);
      // Stop the first: the second goes on
      await page.eval(`document.querySelector('#sim-events li[data-kind="stream"][data-act="${S[0].id}"] button[data-op="stop"]').click(), true`);
      const Q0 = await page.eval(STREAMS);
      await wait(2500);
      const Q1 = await page.eval(STREAMS);
      assert.equal(Q1[0].status, 'stopped');
      assert.equal(Q1[0].done, Q0[0].done, 'no datagram after Stop');
      assert.ok(Q1[1].done >= Q0[1].done + 2, `${Q0[1].done} → ${Q1[1].done}`);
      await page.eval(`document.querySelector('#sim-events li[data-kind="stream"][data-act="${S[1].id}"] button[data-op="stop"]').click(), true`);

      // ---------------------------------------------------------------- device state
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      const before = await page.eval(DEV('lab-h'));
      assert.equal(before.power, null, 'operational: no badge');
      assert.equal(before.off || before.booting || before.down, false);
      await page.eval(`netatlas.simController().powerOff('lab-h'), true`);
      await page.settle(100);
      let d = await page.eval(DEV('lab-h'));
      assert.equal(d.power, 'off');
      assert.equal(d.text, '⏻ Off');
      assert.match(d.tip, /^lab-h: Powered off at t = [\d.]+ s$/);
      assert.equal(d.aria, d.tip);
      assert.ok(d.off && d.down && !d.booting);
      assert.notEqual(d.stroke, 'none');
      assert.deepEqual(d.box, before.box, 'the box neither moved nor resized');
      assert.equal(d.overlapsLabel, false, 'its label stays clear');
      // the device menu says it first
      const menu = await page.eval(`(() => { const c = netatlas.simController(); const n = document.querySelector('#canvas .node[data-ref="device:lab-h"] .dev-box').getBoundingClientRect(); c.diagramClick('device:lab-h', n.left + 10, n.top + 10); const m = document.querySelector('.sim-menu'); const r = { state: m.querySelector('.sim-menu-state').textContent, mark: m.querySelector('.sim-menu-state').getAttribute('data-power'), label: m.getAttribute('aria-label'), items: Array.from(m.querySelectorAll('.sim-menu-item')).map((b) => b.textContent) }; c.closeMenu(); return r; })()`);
      assert.match(menu.state, /^Powered off at t = /);
      assert.equal(menu.mark, 'off');
      assert.match(menu.label, /^Simulation: .*\. Powered off at t = /);
      assert.ok(menu.items.indexOf('Power on') >= 0);
      // powered on: booting until its boot time is over
      await page.eval(`netatlas.simController().powerOn('lab-h'), true`);
      await page.settle(100);
      d = await page.eval(DEV('lab-h'));
      assert.equal(d.power, 'booting');
      assert.equal(d.text, '↻ Booting');
      assert.match(d.tip, /^lab-h: Booting: powered on, up at t = [\d.]+ s; it takes no part until then$/);
      assert.ok(d.booting && d.down && !d.off);
      assert.deepEqual(d.box, before.box);
      assert.equal(d.overlapsLabel, false);
      // (the same state as packet processing)
      assert.equal(await page.eval(`netatlas.simController().sim.engine.deviceOn('lab-h')`), false);
      const up = await page.eval(`(() => { const c = netatlas.simController(); const st = c.sim.engine.powerState('lab-h'); c.runTo(st.until - 1); c.refresh(true); return st.until; })()`);
      await page.settle(60);
      assert.equal((await page.eval(DEV('lab-h'))).power, 'booting', 'not before its boot is over');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(${up} + 1); c.refresh(true); return true; })()`);
      await page.settle(100);
      d = await page.eval(DEV('lab-h'));
      assert.equal(d.power, null, 'booted: operational, no badge');
      assert.ok(!d.off && !d.booting);
      assert.deepEqual(d.box, before.box);
      // a shut interface marks the interface, never the device off
      await page.eval(`netatlas.simController().shut('srv', 'eth0'), true`);
      await page.settle(100);
      d = await page.eval(DEV('srv'));
      assert.equal(d.power, null);
      assert.ok(!d.off && !d.booting);
      // an external network: no lifecycle, no badge, no Power off, no state line
      const inet = await page.eval(`(() => { const c = netatlas.simController(); return { items: c.itemsFor('device:inet').map((i) => i.label), state: c.sim.deviceState('inet').state }; })()`);
      assert.equal(inet.state, 'none');
      assert.ok(inet.items.indexOf('Power off') < 0, inet.items.join(', '));
      // Exit: no badge, no mark
      await page.eval(`netatlas.simController().powerOff('lab-h'), true`);
      await page.settle(60);
      assert.equal((await page.eval(DEV('lab-h'))).power, 'off');
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .layer-sim-power, #canvas .sim-off, #canvas .sim-booting').length`), 0);
    } finally {
      await page.close();
    }
  });
}
