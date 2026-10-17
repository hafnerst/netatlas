// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), the private house, both themes, a wide window and a
// narrow one (720 × 450: a 1440 × 900 window at 200 % zoom).
//   - Expand all / Collapse all beside the Network events heading: the four
//     actions' forms only (not Active events, not More options), each
//     button disabled when it would change nothing, the focus handed over,
//     the keyboard, the heading not moving, form values and a running
//     stream kept.
//   - Every device's status in the diagram: an LED and a word (green
//     Operational; Powered off, Booting, External), its tooltip the device
//     menu's state line, clear of every text and port, the boxes unmoved
//     through state changes; gone at Exit.
//   - IGMP / MLD snooping in the switch's Edit tab: a choice per VLAN (Not
//     configured an error), written to igmp_mld_snooping.
//   - The snooping table and the host's memberships live in the panel's
//     status side; the thermostat's stream drawn only where it goes.
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

/** The six actions' state, the bulk buttons, where the heading and the buttons are. */
const BULK = `(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return { open: Array.from(document.querySelectorAll('#sim-act-net .sim-ne-h .sp-toggle')).map((b) => b.getAttribute('aria-expanded') === 'true' && !document.getElementById(b.getAttribute('aria-controls')).hidden),
    expand: document.getElementById('sim-ne-expand').disabled, collapse: document.getElementById('sim-ne-collapse').disabled,
    names: [document.getElementById('sim-ne-expand').getAttribute('aria-label'), document.getElementById('sim-ne-collapse').getAttribute('aria-label'), document.getElementById('sim-ne-expand').title],
    at: [r('sim-act-net-h'), r('sim-ne-expand'), r('sim-ne-collapse')], focus: document.activeElement ? document.activeElement.id : '',
    events: document.getElementById('sim-act-events').hidden, more: document.getElementById('sim-t-more-toggle').getAttribute('aria-expanded') }; })()`;

/** Every device's indicator: its state, word, tooltip, LED colour; overlaps with texts and ports; the boxes (all in the drawing's coordinates: the view may pan and zoom). */
const STATUS = `(() => { const sc = document.querySelector('#canvas .scene'); const out = {}; const texts = [];
  const bb = (e) => { const r = e.getBBox(); return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, width: r.width }; };
  for (const t of sc.querySelectorAll('text')) { if (t.closest('.layer-sim-power, .layer-sim, .layer-sim-labels')) continue; const r = bb(t); if (r.width > 0) texts.push(r); }
  for (const p of sc.querySelectorAll('.layer-ports > *, .lport')) { const r = bb(p); if (r.width > 0) texts.push(r); }
  const hit = (a) => texts.some((r) => a.left < r.right - 0.5 && a.right > r.left + 0.5 && a.top < r.bottom - 0.5 && a.bottom > r.top + 0.5);
  const pills = Array.from(sc.querySelectorAll('.layer-sim-power .sim-power')).map((s) => bb(s.querySelector('rect')));
  const crossed = pills.some((a, i) => pills.some((b, j) => j !== i && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
  for (const n of sc.querySelectorAll('.node.device')) { const id = n.getAttribute('data-ref').slice(7); const b = n.querySelector('.dev-box').getBBox();
    const s = sc.querySelector('.layer-sim-power .sim-power[data-device="' + id + '"]');
    out[id] = { box: [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10), state: s ? s.getAttribute('data-power') : null, text: s ? s.querySelector('text').textContent : null, tip: s ? s.querySelector('title').textContent : null, aria: s ? s.getAttribute('aria-label') : null, role: s ? s.getAttribute('role') : null,
      led: s ? getComputedStyle(s.querySelector('.sim-led')).fill : null, overlaps: s ? hit(bb(s.querySelector('rect'))) : null }; }
  return { devices: out, crossed, ok: getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() }; })()`;

const rgb = (hex) => {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
};

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]]) {
  test(`${theme}, ${width} × ${height}: Expand all / Collapse all of Network events; every device’s status in the diagram; IGMP / MLD snooping per VLAN; the snooping and membership tables live`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    const set = (id, v, ev = 'change') => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)})); return true; })()`);
    const run = (ms) => page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + ${ms}); c.refresh(true); return true; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);

      // ------------------------------------------------------------ snooping in the switch's Edit tab
      await page.eval(`netatlas.select('device:dist', true), netatlas.showTab('edit'), true`);
      await page.settle(100);
      const rows = () => page.eval(`Array.from(document.querySelectorAll('section.fgroup[data-group="snooping"] .snoop-row')).map((f) => [f.querySelector('label').textContent, f.querySelector('select').value, !!f.querySelector('.field-err')])`);
      assert.deepEqual(await rows(), [['VLAN 10', 'enabled', false], ['VLAN 20', 'enabled', false], ['VLAN 30', 'enabled', false], ['VLAN 99', 'disabled', false]]);
      assert.deepEqual(await page.eval(`Array.from(document.querySelector('section.fgroup[data-group="snooping"] select').options).map((o) => o.textContent)`), ['Not configured — choose', 'Enabled', 'Disabled']);
      // not configured: an error until chosen, the check's too; choosing writes it
      await page.eval(`(() => { const s = document.getElementById('snoop-' + document.querySelector('section.fgroup[data-group="snooping"] select').getAttribute('data-index') + '-99'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await page.settle(150);
      assert.deepEqual((await rows()).find((r) => r[0] === 'VLAN 99'), ['VLAN 99', '', true]);
      assert.match(await page.eval(`netatlas.exportText()`), /igmp_mld_snooping: \{10: enabled, 20: enabled, 30: enabled\}/);
      await page.eval(`(() => { const s = document.querySelector('section.fgroup[data-group="snooping"] select[data-key="99"]'); s.value = 'disabled'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await page.settle(150);
      assert.match(await page.eval(`netatlas.exportText()`), /igmp_mld_snooping: \{10: enabled, 20: enabled, 30: enabled, 99: disabled\}/);
      assert.equal(await page.eval(`/snooping-not-configured/.test(document.body.textContent)`), false);

      // ------------------------------------------------------------ the simulation: every device's status
      const before = (await page.eval(STATUS)).devices;
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(30000); c.refresh(true); if (document.getElementById('spt-actions')) document.getElementById('spt-actions').click(); return true; })()`);
      await page.settle(200);
      let st = await page.eval(STATUS);
      const ids = Object.keys(st.devices);
      assert.equal(ids.length, 14);
      for (const id of ids) {
        const d = st.devices[id];
        assert.deepEqual(d.box, before[id].box, `${id}: the box neither moved nor resized`);
        assert.equal(d.role, 'img', id);
        assert.equal(d.aria, d.tip, id);
        assert.equal(d.overlaps, false, `${id}: clear of every text and port`);
        if (id === 'isp') assert.deepEqual([d.state, d.text], ['external', 'External']);
        else {
          assert.deepEqual([d.state, d.text], ['operational', 'Operational'], id);
          assert.equal(d.led, rgb(st.ok), `${id}: a green LED`);
          assert.match(d.tip, new RegExp(`^${id}: Operational: powered on and booted`));
        }
      }
      assert.equal(st.crossed, false, 'no indicator over another');
      // powered off, booting, back; a shut interface never marks the device; the menu says the same
      await page.eval(`netatlas.simController().powerOff('ap-1'), netatlas.simController().shut('nas', 'eth0'), netatlas.simController().refresh(true), true`);
      await page.settle(100);
      st = await page.eval(STATUS);
      assert.deepEqual([st.devices['ap-1'].state, st.devices['ap-1'].text], ['off', 'Powered off']);
      assert.match(st.devices['ap-1'].tip, /^ap-1: Powered off at t = 30(\.\d+)? s$/);
      assert.deepEqual([st.devices.nas.state, st.devices.nas.text], ['operational', 'Operational'], 'a shut interface: the device stays operational');
      assert.deepEqual(st.devices['ap-1'].box, before['ap-1'].box);
      assert.equal(st.devices['ap-1'].overlaps, false);
      const menu = await page.eval(`(() => { const c = netatlas.simController(); const n = document.querySelector('#canvas .node[data-ref="device:ap-1"] .dev-box').getBoundingClientRect(); c.diagramClick('device:ap-1', n.left + 10, n.top + 10); const m = document.querySelector('.sim-menu'); const r = [m.querySelector('.sim-menu-state').textContent, m.querySelector('.sim-menu-state').getAttribute('data-power')]; c.closeMenu(); return r; })()`);
      assert.deepEqual(menu, [st.devices['ap-1'].tip.replace(/^ap-1: /, ''), 'off']);
      // the diagram's accessible name says who is out of operation
      assert.match(await page.eval(`document.getElementById('canvas').getAttribute('aria-label')`), /^Network diagram — simulated state: .* · powered off: ap-1/);
      await page.eval(`netatlas.simController().powerOn('ap-1'), netatlas.simController().refresh(true), true`);
      await page.settle(100);
      st = await page.eval(STATUS);
      assert.deepEqual([st.devices['ap-1'].state, st.devices['ap-1'].text], ['booting', 'Booting']);
      assert.notEqual(st.devices['ap-1'].led, rgb(st.ok));
      await run(120000);
      await page.settle(100);
      assert.equal((await page.eval(STATUS)).devices['ap-1'].state, 'operational', 'booted: operational again');
      await page.eval(`netatlas.simController().noShut('nas', 'eth0'), true`);

      // ------------------------------------------------------------ Expand all / Collapse all
      let b = await page.eval(BULK);
      assert.deepEqual(b.names, ['Expand all Network events sections', 'Collapse all Network events sections', 'Expand all Network events sections']);
      assert.deepEqual(b.open, [true, false, false, false, false, false]);
      assert.deepEqual([b.expand, b.collapse], [false, false], 'mixed: both');
      const at0 = b.at;
      // a value typed in a form, a stream running: kept through both
      await page.eval(`document.getElementById('sim-ne-stream-toggle').click(), true`);
      await set('sim-s-dev', 'thermostat');
      await set('sim-s-group', '239.20.0.1', 'input');
      await set('sim-s-port', '5004', 'input');
      await set('sim-s-int', '1', 'input');
      await page.eval(`document.getElementById('sim-s-go').click(), netatlas.simController().setPlaying(true), true`);
      assert.equal(await page.eval(`netatlas.simController().sim.actions().filter((v) => v.kind === 'stream').length`), 1, await page.eval(`document.getElementById('sim-s-need').textContent + ' | ' + (document.getElementById('sim-s-msg') || {}).textContent`));
      await set('sim-s-group', '239.20.0.9', 'input');
      // Expand all with the keyboard
      await page.eval(`document.getElementById('sim-ne-expand').focus(), true`);
      await page.key('Enter');
      await page.settle(60);
      b = await page.eval(BULK);
      assert.deepEqual(b.open, [true, true, true, true, true, true]);
      assert.deepEqual([b.expand, b.collapse], [true, false], 'all open: Expand all disabled');
      assert.equal(b.focus, 'sim-ne-collapse', 'the focus handed to Collapse all');
      assert.equal(b.events, false, 'Active events untouched');
      assert.equal(b.more, 'false', 'More options untouched');
      assert.deepEqual(b.at, at0, 'the heading and its buttons stay put');
      const sent0 = await page.eval(`netatlas.simController().sim.actions().find((v) => v.kind === 'stream').progress.done`);
      // Collapse all with Space
      await page.key(' ', 'Space', 32);
      await page.settle(60);
      b = await page.eval(BULK);
      assert.deepEqual(b.open, [false, false, false, false, false, false]);
      assert.deepEqual([b.expand, b.collapse], [false, true], 'all closed: Collapse all disabled');
      assert.equal(b.focus, 'sim-ne-expand');
      assert.deepEqual(b.at, at0);
      await wait(2200);
      const after = await page.eval(`(() => { const v = netatlas.simController().sim.actions().find((v) => v.kind === 'stream'); return [v.status, v.progress.done]; })()`);
      assert.equal(after[0], 'running', 'collapsing stops nothing');
      assert.ok(after[1] >= sent0 + 1, `${sent0} → ${after[1]}`);
      await page.eval(`document.getElementById('sim-ne-expand').click(), true`);
      await page.settle(40);
      assert.equal(await page.eval(`document.getElementById('sim-s-group').value`), '239.20.0.9', 'the form keeps its value');
      // one opened by hand: mixed again
      await page.eval(`document.getElementById('sim-ne-collapse').click(), document.getElementById('sim-ne-iface-toggle').click(), true`);
      b = await page.eval(BULK);
      assert.deepEqual([b.open, b.expand, b.collapse], [[false, false, false, false, true, false], false, false]);
      // nothing wider than the panel
      assert.equal(await page.eval(`(() => { const box = document.getElementById('sim-act-net'); return box.scrollWidth <= box.clientWidth + 1; })()`), true);

      // ------------------------------------------------------------ the stream's way and the tables, live
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      const sid = await page.eval(`netatlas.simController().sim.actions().find((v) => v.kind === 'stream').tests[0]`);
      const links = () => page.eval(`Array.from(new Set(netatlas.simController().sim.engine.flights.filter((f) => f.test === ${sid} && f.protocol === 'mcast' && f.view === 'physical').map((f) => f.track.ref))).sort()`);
      assert.deepEqual(await links(), ['link:l-core-dist', 'link:l-dist-ap2', 'link:w-thermostat'], 'no member: never towards the TV or the first floor');
      assert.match(await page.eval(`document.querySelector('#sim-events li[data-kind="stream"] .sim-ev-summary').textContent`), /no member received any yet · stops at core$/);
      await page.eval(`netatlas.simController().showTable('snoop', 'core'), true`);
      await page.settle(100);
      const tbl = () => page.eval(`(() => { const t = document.getElementById('sim-status-table'); return { rows: Array.from(t.querySelectorAll('tbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent)), text: t.textContent, focus: document.activeElement ? document.activeElement.id : '' }; })()`);
      let t = await tbl();
      assert.match(t.text, /No memberships and no router port learned in VLAN 10, 20, 30\./);
      assert.match(t.text, /Snooping enabled in VLAN 10, 20, 30/);
      assert.match(t.text, /VLAN 20 · Querier: the elected IGMP querier of VLAN 20 \(snooping querier, from 192\.168\.20\.1\)/);
      assert.match(t.text, /core routes no multicast \(it runs no PIM\)/);
      // the TV joins (the form): the open table shows its port without being opened again
      await page.eval(`document.getElementById('sim-ne-join-toggle').click(), true`);
      await set('sim-j-dev', 'tv');
      await set('sim-j-group', '239.20.0.1', 'input');
      await page.eval(`document.getElementById('sim-j-go').click(), true`);
      await run(3000);
      await page.settle(150);
      t = await tbl();
      assert.ok(t.rows.some((r) => r[0] === '20' && r[1] === '239.20.0.1 (IGMP)' && r[2] === 'ap' && /^member port: IGMPv3, any source, reported by 192\.168\.20\.\d+$/.test(r[3])), JSON.stringify(t.rows));
      assert.equal(await page.eval(`netatlas.simController().itemsFor('device:tv').map((i) => i.label).indexOf('Show group memberships') >= 0`), true);
      await page.eval(`netatlas.simController().showTable('members', 'tv'), true`);
      await page.settle(100);
      assert.ok((await tbl()).rows.some((r) => r[0] === 'wlan0' && r[1] === '239.20.0.1'));
      assert.equal(await page.eval(`document.querySelector('#sd-sttabs [aria-pressed="true"]').textContent`), 'Memberships');
      // read-only tables are not among the Network events actions
      assert.equal(await page.eval(`/Show |snooping table|memberships/i.test(document.getElementById('sim-act-net').textContent)`), false);

      // ------------------------------------------------------------ Exit: no indicator left
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .layer-sim-power, #canvas .sim-power').length`), 0);
      const end = (await page.eval(STATUS)).devices;
      for (const id of ids) assert.deepEqual(end[id].box, before[id].box, id);
    } finally {
      await page.close();
    }
  });
}
