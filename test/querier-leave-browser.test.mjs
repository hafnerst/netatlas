// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), the internal example multicast-querier.yaml, light
// and dark at 1440 × 900 and light at 720 × 450 (200 % zoom):
//   - the querier election from the start: the queries drawn as dots, the
//     mark "Querier (startup) · VLAN 10" (dashed) on q1 and q3, then
//     "Querier · VLAN 10" once settled; q2 "Standby · VLAN 10"; the
//     marks clear of every text, port and status, the boxes unmoved;
//   - Leave multicast group right below Join multicast group, in Expand
//     all; its groups the interface's memberships, none chosen; its note;
//     the event: sent, cleanup pending, then removed at the switch's port;
//     its leave report inspectable; Show querier election;
//   - the querier off: q2 takes over and its mark appears; Exit clears all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** The querier marks: device, role, text, tooltip; clear of texts, ports and the status pills (the drawing's coordinates). */
const MARKS = `(() => { const sc = document.querySelector('#canvas .scene'); const bb = (e) => { const r = e.getBBox(); return { l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height, w: r.width }; };
  const obst = []; for (const t of sc.querySelectorAll('text, .layer-ports > *, .lport')) { if (t.closest('.layer-sim-power, .layer-sim, .layer-sim-labels')) continue; const r = bb(t); if (r.w > 0) obst.push(r); }
  for (const p of sc.querySelectorAll('.layer-sim-power .sim-power rect')) obst.push(bb(p));
  const hit = (a) => obst.some((r) => a.l < r.r - 0.5 && a.r > r.l + 0.5 && a.t < r.b - 0.5 && a.b > r.t + 0.5);
  return Array.from(sc.querySelectorAll('.layer-sim-power .sim-querier')).map((m) => ({ dev: m.getAttribute('data-device'), role: m.getAttribute('data-role'), text: m.querySelector('text').textContent, tip: m.querySelector('title').textContent, aria: m.getAttribute('aria-label'), dash: getComputedStyle(m.querySelector('rect')).strokeDasharray, overlaps: hit(bb(m.querySelector('rect'))) })); })()`;
const BOXES = `Object.fromEntries(Array.from(document.querySelectorAll('#canvas .node.device')).map((n) => { const b = n.querySelector('.dev-box').getBBox(); return [n.getAttribute('data-ref').slice(7), [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10)]; }))`;

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]]) {
  test(`${theme}, ${width} × ${height}: the querier election marked in the diagram (startup, settled, failover); Leave multicast group from its form, followed to the switch; Show querier election`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    const set = (id, v, ev = 'change') => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)})); return true; })()`);
    const run = (ms) => page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + ${ms}); c.refresh(true); return true; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('multicast-querier.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      const before = await page.eval(BOXES);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(2600); c.refresh(true); if (document.getElementById('spt-actions')) document.getElementById('spt-actions').click(); return true; })()`);
      await page.settle(200);
      // the election started by itself: the queries are messages on the cables, drawn (their dots) and in the log
      const q = await page.eval(`(() => { const c = netatlas.simController(); const fl = c.sim.engine.flights.filter((f) => f.protocol === 'igmp' && /Query/.test(f.label)); return { flights: fl.length, senders: Array.from(new Set(fl.map((f) => f.sender))).sort() }; })()`);
      assert.ok(q.flights > 0);
      assert.deepEqual(q.senders, ['q1', 'q2', 'q3']);
      // provisional: q1 and q3 marked for now (dashed), q2 heard q1 and has no mark
      let m = await page.eval(MARKS);
      assert.deepEqual(m.map((x) => [x.dev, x.role, x.text]), [['q1', 'starting', 'Querier (startup) · VLAN 10'], ['q2', 'standby', 'Standby · VLAN 10'], ['q3', 'starting', 'Querier (startup) · VLAN 10']]);
      assert.notEqual(m[0].dash, 'none');
      // the reason it is still in its startup, and what comes next, in its tooltip
      assert.match(m[0].tip, /^q1: IGMP querier of VLAN 10 \(g0\) from 10\.5\.0\.1, in its startup: startup query 2 of 2 due at t = [\d.]+ s \(a quarter of the query interval after the last\); a lower address heard meanwhile would take over$/);
      assert.match(m[1].tip, /^q2: IGMP standby on VLAN 10 \(g0\) \(10\.5\.0\.2\): 10\.5\.0\.1 \(q1\) queries; it takes over at t = [\d.]+ s if that one falls silent$/);
      // settled after its startup queries
      await run(10000);
      await page.settle(150);
      m = await page.eval(MARKS);
      assert.deepEqual(m.map((x) => [x.dev, x.role, x.text]), [['q1', 'querier', 'Querier · VLAN 10'], ['q2', 'standby', 'Standby · VLAN 10'], ['q3', 'querier', 'Querier · VLAN 10']]);
      for (const x of m) {
        assert.equal(x.aria, x.tip);
        assert.equal(x.overlaps, false, `${x.dev}: clear of texts, ports and its status`);
      }
      assert.deepEqual(await page.eval(BOXES), before, 'no box moved or resized');
      // Show querier election: the device's menu, the panel's table
      assert.ok((await page.eval(`netatlas.simController().itemsFor('device:q2').map((i) => i.label)`)).indexOf('Show querier election') >= 0);
      await page.eval(`netatlas.simController().showTable('querier', 'q2'), true`);
      await page.settle(100);
      const qt = await page.eval(`Array.from(document.querySelectorAll('#sim-status-table tbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent))`);
      assert.deepEqual(qt.map((r) => r.slice(0, 5)), [['VLAN 10 (g0)', 'IGMP', '10.5.0.2', 'Standby (non-querier)', '10.5.0.1 (q1)']]);
      assert.match(qt[0][5], /^takes over at t = [\d.]+ s unless it hears 10\.5\.0\.1 \(q1\)$/);

      // ------------------------------------------------------------ Leave multicast group
      const order = await page.eval(`Array.from(document.querySelectorAll('#sim-act-net .sim-ne-h .sp-toggle')).map((b) => b.querySelector('span:last-child').textContent)`);
      assert.deepEqual(order, ['Send network packets', 'Join multicast group', 'Leave multicast group', 'Start multicast stream', 'Interface actions', 'Start application']);
      // in Expand all
      await page.eval(`document.getElementById('sim-ne-expand').click(), true`);
      assert.equal(await page.eval(`document.getElementById('sim-ne-leave').hidden`), false);
      // no membership yet: rx1 offered but not choosable
      assert.match(await page.eval(`Array.from(document.getElementById('sim-l-dev').options).find((o) => o.value === 'rx1').textContent`), /^rx1 — no membership$/);
      // rx1 and rx2 join (the Join form)
      for (const h of ['rx1', 'rx2']) {
        await set('sim-j-dev', h);
        await set('sim-j-group', '239.5.5.5', 'input');
        await page.eval(`document.getElementById('sim-j-go').click(), true`);
      }
      await run(3000);
      await page.settle(100);
      await set('sim-l-dev', 'rx1');
      const L = await page.eval(`(() => ({ iface: document.getElementById('sim-l-if').value, groups: Array.from(document.getElementById('sim-l-group').options).map((o) => o.textContent), chosen: document.getElementById('sim-l-group').value, need: document.getElementById('sim-l-need').textContent, disabled: document.getElementById('sim-l-go').disabled }))()`);
      assert.deepEqual(L, { iface: 'eth0', groups: ['Select…', '239.5.5.5 (IGMP)'], chosen: '', need: 'Choose the group to leave.', disabled: true }, 'none chosen for you');
      await set('sim-l-group', '239.5.5.5');
      assert.equal(await page.eval(`document.getElementById('sim-l-ctx').textContent`), 'rx1:eth0 (10.5.0.11, VLAN 10) sends an IGMPv3 report that blocks 239.5.5.5 to 224.0.0.22; its membership ends at once.');
      // with the keyboard
      await page.eval(`document.getElementById('sim-l-go').focus(), true`);
      await page.key('Enter');
      await page.settle(100);
      const LV = `(() => { const li = document.querySelector('#sim-events li[data-kind="leave"]'); return li ? { status: li.getAttribute('data-status'), title: li.querySelector('.sim-ev-title').textContent, summary: li.querySelector('.sim-ev-summary').textContent } : null; })()`;
      let lv = await page.eval(LV);
      assert.equal(lv.status, 'running');
      assert.match(lv.title, /Leave multicast group/);
      assert.match(lv.summary, /^leave sent · cleanup pending \(3 of 3\)/);
      // its leave report: inspectable by its event's id
      const tag = await page.eval(`netatlas.simController().sim.actions().find((v) => v.kind === 'leave').tests[0]`);
      await page.eval(`netatlas.simController().inspectTest(${tag}), true`);
      await page.settle(100);
      assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"]').textContent`), /TO_IN \(239\.5\.5\.5, \{\}\)/);
      await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
      await run(5000);
      await page.settle(150);
      lv = await page.eval(LV);
      assert.equal(lv.status, 'completed');
      assert.match(lv.summary, /^leave sent · removed at sw \(VLAN 10, port p4\) · kept at q1:g0 \(10\.5\.0\.12 reports it\)/);
      // read-only tables stay out of Network events
      assert.equal(await page.eval(`/Show |querier election/i.test(document.getElementById('sim-act-net').textContent)`), false);

      // ------------------------------------------------------------ failover: q1 off, q2 takes over, its mark appears
      await page.eval(`netatlas.simController().powerOff('q1'), true`);
      await run(60000);
      await page.settle(150);
      m = await page.eval(MARKS);
      assert.deepEqual(m.map((x) => [x.dev, x.role, x.text]), [['q2', 'querier', 'Querier · VLAN 10'], ['q3', 'querier', 'Querier · VLAN 10']]);
      assert.equal(m[0].overlaps, false);
      // Exit: no mark left
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .sim-querier, #canvas .layer-sim-power').length`), 0);
    } finally {
      await page.close();
    }
  });
}
