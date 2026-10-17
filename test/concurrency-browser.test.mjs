// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), light and dark at 1440 × 900 and light at 720 × 450
// (200 % zoom):
//   - the private house from a fresh start: the core's first IGMP query at
//     simulated t = 2 s, its dots on screen within about a second of real
//     time after it (not behind the startup burst); the core's badge
//     "VLAN 20 · Querier (startup)", the deadline in Show querier election;
//     the diagnostics say "scheduled";
//   - two of your actions at once (a stream and a send series): both in
//     front; the scenario's dots go on moving behind them, grey, without a
//     data-flight, not under the pointer: no outline, no inspector from
//     them; a dot of yours opens the inspector, which stays open while the
//     styling changes; stopped and arrived: nothing grey any more.
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

const HOVER = `(() => { const h = document.querySelector('#canvas .sim-hit'); return { id: h ? Number(h.getAttribute('data-hover')) : null, hand: document.getElementById('canvas').classList.contains('sim-dot-hover') }; })()`;
const PANEL = `(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p && !p.hidden ? p.querySelector('.pi').textContent : null; })()`;

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]]) {
  test(`${theme}, ${width} × ${height}: IGMP startup in the private house on time and on screen; two actions in front, the scenario grey and not clickable behind them, restored after`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      const t0 = Date.now();
      await page.eval(`netatlas.startProtocolSimulation(), true`);
      // the first query and its dots: polled, a fresh start
      let seen = null;
      for (let i = 0; i < 40 && !seen; i++) {
        await wait(250);
        seen = await page.eval(`(() => { const c = netatlas.simController(); const q = c.sim.events().find((e) => e.protocol === 'igmp' && e.what === 'Query'); if (!q) return null; const dots = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).filter((d) => { const it = c.pacer.find(Number(d.getAttribute('data-flight'))); return it && it.f.protocol === 'igmp'; }).length; return dots ? { t: q.t, dots } : null; })()`);
      }
      const real = (Date.now() - t0) / 1000;
      assert.ok(seen, 'an IGMP query drawn');
      assert.equal(Math.round(seen.t), 2000, 'sent at its deadline (the core’s first port up after the link-up delay)');
      assert.ok(real < 6, `its dots on screen ${real.toFixed(1)} s after the start (its simulated time 2 s; the page’s first frames)`);
      // the core's snooping badges: one per VLAN with snooping enabled, each in its startup
      const mark = await page.eval(`(() => { const m = document.querySelector('#canvas .sim-snoop[data-device="core"] .sim-snoop-vlan[data-vlan="20"]'); return m ? { text: m.querySelector('text:not(.sim-snoop-icon)').textContent, role: m.getAttribute('data-role'), tip: m.querySelector('title').textContent } : null; })()`);
      assert.deepEqual([mark.text, mark.role], ['VLAN 20 · Querier (startup)', 'starting']);
      assert.match(mark.tip, /^core: the IGMP querier of VLAN 20 for now, sending its startup queries from 192\.168\.20\.1/);
      assert.ok((await page.eval(`netatlas.simController().queryDiagnostics()`)).every((d) => d.next === 'scheduled'));
      await page.eval(`netatlas.simController().showTable('querier', 'core'), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelector('#sim-status-table tbody tr').cells[5].textContent`), 'query at t = 33.3 s (startup 2 of 2)');
      await page.eval(`netatlas.exitSimulation(), true`);

      // ------------------------------------------------------------ two actions at once, the scenario behind
      await page.eval(`netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); netatlas.fit(); return true; })()`);
      await wait(6000);
      await page.eval(`(() => { const c = netatlas.simController(); c.startStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500); c.sim.actSend({ delivery: 'unicast', from: 'pc2', target: '10.10.10.21', kind: 'icmp', count: 20, interval: 1 }); c.pacer.take(); return true; })()`);
      await wait(4000);
      let st = await page.eval(`(() => { const c = netatlas.simController(); const p = c.pacer; const ids = c.sim.actions().map((v) => v.tests[0]); const fg = ids.map((id) => p.items.some((it) => it.f.test === id && it.drawn && !p.background(it))); const bg = Array.from(document.querySelectorAll('#canvas .layer-sim .sim-bg')); return { fg, bg: bg.length, flightOnBg: bg.some((e) => e.hasAttribute('data-flight')), pe: bg.length ? getComputedStyle(bg[0]).pointerEvents : '', pace: document.getElementById('sim-pace-text').textContent }; })()`);
      assert.deepEqual(st.fg, [true, true], 'both actions in front');
      assert.ok(st.bg > 0, 'the scenario still moving, grey');
      assert.deepEqual([st.flightOnBg, st.pe], [false, 'none']);
      // a grey dot under the pointer: no outline, no inspector
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      await page.settle(60);
      const g = await page.eval(`(() => { for (const e of document.querySelectorAll('#canvas .layer-sim .sim-bg')) { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const fgNear = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).some((d) => { const q = d.getBoundingClientRect(); return Math.hypot(q.left + q.width / 2 - x, q.top + q.height / 2 - y) < 30; }); if (!fgNear && x > 20 && y > 20 && x < innerWidth - 20 && y < innerHeight - 20) return { x, y }; } return null; })()`);
      if (g) {
        await page.mouse('mouseMoved', g.x, g.y);
        await page.settle(40);
        assert.deepEqual(await page.eval(HOVER), { id: null, hand: false }, 'no outline on a grey dot');
        await page.mouse('mousePressed', g.x, g.y, 'left');
        await page.mouse('mouseReleased', g.x, g.y, 'left');
        await page.settle(80);
        assert.equal(await page.eval(PANEL), null, 'no inspector from it');
        await page.eval(`(() => { const m = document.querySelector('.sim-menu'); if (m) netatlas.simController().closeMenu(); return true; })()`);
      }
      // a dot of yours: the inspector, which stays while the styling changes (the actions end, the scenario comes back)
      const mine = await page.eval(`(() => { const c = netatlas.simController(); for (const d of document.querySelectorAll('#canvas .layer-sim [data-flight]')) { const it = c.pacer.find(Number(d.getAttribute('data-flight'))); if (it && it.f.test !== undefined) return Number(d.getAttribute('data-flight')); } return null; })()`);
      assert.ok(mine !== null);
      await page.eval(`netatlas.simController().inspectFlight(${mine}, { x: 300, y: 200, w: 10, h: 10 }), true`);
      await page.settle(80);
      const shown = await page.eval(PANEL);
      assert.ok(shown);
      // stop the stream and the series: the foreground ends once their dots arrived
      await page.eval(`(() => { const c = netatlas.simController(); for (const v of c.sim.actions()) if (v.controls.some((x) => x.op === 'stop')) c.sim.actionControl(v.id, 'stop'); c.setPlaying(true); return true; })()`);
      for (let i = 0; i < 40; i++) {
        await wait(2000);
        if (!(await page.eval(`netatlas.simController().pacer.fgActive()`))) break;
      }
      st = await page.eval(`({ fg: netatlas.simController().pacer.fgActive(), bg: document.querySelectorAll('#canvas .layer-sim .sim-bg').length })`);
      assert.deepEqual(st, { fg: false, bg: 0 }, 'restored: nothing grey');
      assert.equal(await page.eval(PANEL), shown, 'the inspector kept its packet');
    } finally {
      await page.close();
    }
  });
}
