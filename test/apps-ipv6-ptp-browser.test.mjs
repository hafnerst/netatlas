// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), light and dark at 1440 × 900 and light at 720 × 450
// (a page zoomed to 200 %):
//   - private-house.yaml's thermostat: its Applications collapsed to one line
//     each ("Name · profile · port/peer"); one opened shows its basic fields
//     and a closed Advanced section; the profile's support note, a keyboard
//     disclosure; + Add application focuses the profile; Duplicate; Remove of
//     a listener another application names lists that one first; one undo
//     step each; the laptop's IPv6 method and the core's router
//     advertisements (prefixes, then a closed Advanced section);
//   - ot-network.yaml in the simulation: Start application (its form in
//     Network events), the MQTT sessions on the broker and the subscriber's
//     deliveries, an MQTT message's inspection (no payload);
//   - timing-ptp.yaml: the PTP marks (gm-a ★ grandmaster, the others
//     synchronized, sw-a TC), clear of the texts and ports, the boxes
//     unmoved; Show PTP clock; gm-a powered off: gm-b's mark turns
//     grandmaster; Exit clears the marks.
// No sideways scrolling in the editor or the panel at any size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const APPS = `Array.from(document.querySelectorAll('[data-svc-card="applications"] details.app-card')).map((d) => ({ id: d.getAttribute('data-app'), title: d.querySelector('summary .card-title').textContent, open: d.open }))`;
const NO_SIDEWAYS = `(() => { const out = []; for (const e of [document.getElementById('inspector') || document.querySelector('.inspector'), document.scrollingElement]) if (e && e.scrollWidth > e.clientWidth + 1) out.push(e.id || e.className || 'page'); return out; })()`;
const PTP = `(() => { const sc = document.querySelector('#canvas .scene'); const bb = (e) => { const r = e.getBBox(); return { l: r.x, t: r.y, r: r.x + r.width, b: r.y + r.height, w: r.width }; };
  const obst = []; for (const t of sc.querySelectorAll('text, .layer-ports > *, .lport')) { if (t.closest('.layer-sim-power, .layer-sim, .layer-sim-labels')) continue; const r = bb(t); if (r.w > 0) obst.push(r); }
  const hit = (a) => obst.some((r) => a.l < r.r - 0.5 && a.r > r.l + 0.5 && a.t < r.b - 0.5 && a.b > r.t + 0.5);
  return Object.fromEntries(Array.from(sc.querySelectorAll('.sim-ptp')).map((m) => [m.getAttribute('data-device'), { state: m.getAttribute('data-state'), text: m.querySelector('text').textContent, aria: m.getAttribute('aria-label'), tip: m.querySelector('title').textContent, overlaps: hit(bb(m.querySelector('rect'))) }])); })()`;
const BOXES = `Object.fromEntries(Array.from(document.querySelectorAll('#canvas .node.device')).map((n) => { const b = n.querySelector('.dev-box').getBBox(); return [n.getAttribute('data-ref').slice(7), [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10)]; }))`;
const TABLE = `Array.from(document.querySelectorAll('#sim-status-table tbody tr')).map((r) => Array.from(r.cells).map((c) => c.textContent))`;

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]].slice(0, process.env.ONE ? 1 : 3)) {
  test(`${theme}, ${width} × ${height}: applications, IPv6 and router advertisements in the editor; Start application and MQTT; the PTP clocks in the diagram`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    const click = (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const clickModal = (value) => page.eval(`(() => { const b = document.querySelector('#modal [data-value="${value}"]'); if (!b) return false; b.click(); return true; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);

      // ------------------------------------------------------------ the thermostat's applications
      await page.eval(`netatlas.select('device:thermostat', true), netatlas.showTab('edit'), true`);
      await page.settle(150);
      await page.eval(`(() => { const g = document.querySelector('section.fgroup[data-group="netservices"]'); if (g && g.tagName === 'DETAILS') g.open = true; const b = g && g.querySelector('[aria-expanded="false"]'); if (b) b.click(); return true; })()`);
      await page.settle(100);
      assert.deepEqual(await page.eval(APPS), [
        { id: 'control', title: 'Local control · TCP listener · 8080', open: false },
        { id: 'sync', title: 'Cloud sync · TCP request/response · web/web', open: false },
      ]);
      assert.equal(await page.eval(`document.querySelector('[data-svc-card="applications"] .svc-name').textContent`), 'Applications (2)');
      // opened: its basic fields, the profile's support note and a closed Advanced section
      await click('[data-svc-card="applications"] details.app-card[data-app="sync"] > summary');
      await page.settle(100);
      const sync = await page.eval(`(() => { const d = document.querySelector('details.app-card[data-app="sync"]'); return { open: d.open, labels: Array.from(d.querySelectorAll(':scope > .field > label')).map((l) => l.textContent), adv: !!d.querySelector('details.adv-section') && !d.querySelector('details.adv-section').open, advLabels: Array.from(d.querySelectorAll('details.adv-section .field > label')).map((l) => l.textContent), note: d.querySelector('details.support-note > summary').textContent, noteOpen: d.querySelector('details.support-note').open, noteAria: d.querySelector('details.support-note > summary').getAttribute('aria-label') }; })()`);
      assert.equal(sync.open, true);
      assert.deepEqual(sync.labels.slice(0, 4), ['Id *', 'Name *', 'Profile *', 'Peer *']);
      assert.equal(sync.adv, true, 'Advanced is closed');
      assert.ok(sync.advLabels.some((l) => /^Request size/.test(l)) && sync.advLabels.indexOf('Timeout') >= 0 && sync.advLabels.indexOf('Retries') >= 0, sync.advLabels.join(', '));
      assert.equal(sync.note, 'ⓘ Modeled behavior');
      assert.equal(sync.noteOpen, false);
      assert.match(sync.noteAria, /^TCP client \(request\/response\): Modeled behavior \(what NetAtlas simulates\)$/);
      // the support note by keyboard: focus, Enter opens it
      await page.eval(`document.querySelector('details.app-card[data-app="sync"] details.support-note > summary').focus(), true`);
      await page.key('Enter', 'Enter', 13);
      assert.equal(await page.eval(`document.querySelector('details.app-card[data-app="sync"] details.support-note').open`), true);
      assert.match(await page.eval(`document.querySelector('details.app-card[data-app="sync"] details.support-note .sup-not').textContent`), /^Not modeled: /);
      // + Add application: a new entry, its profile focused, nothing chosen
      const before = await page.eval(`netatlas.exportText()`);
      await click('[data-act="add-app"]');
      await page.settle(150);
      const added = await page.eval(`(() => { const a = document.activeElement; return { t: a.getAttribute('data-t'), value: a.value, apps: ${APPS}.map((x) => x.id) }; })()`);
      assert.deepEqual(added, { t: 'app-profile', value: '', apps: ['control', 'sync', 'app1'] });
      await page.eval(`netatlas.undo(), true`);
      await page.settle(150);
      assert.equal(await page.eval(`netatlas.exportText()`), before, 'one undo step');
      // Duplicate: a copy with its own id, one undo step
      await click('details.app-card[data-app="sync"] [data-act="dup-app"]');
      await page.settle(150);
      assert.deepEqual((await page.eval(APPS)).map((x) => x.id), ['control', 'sync', 'sync-2']);
      await page.eval(`netatlas.undo(), true`);
      await page.settle(150);
      assert.equal(await page.eval(`netatlas.exportText()`), before);
      // Remove a listener another application names: listed first; Cancel keeps it, Remove removes it, undo brings it back
      await page.eval(`document.querySelector('details.app-card[data-app="control"]').open = true, true`);
      await click('details.app-card[data-app="control"] [data-act="del-app"]');
      await page.settle(150);
      const dlg = await page.eval(`(() => { const d = document.getElementById('modal'); return { open: d.open, title: d.querySelector('h2, .modal-title, [id$="title"]').textContent, refs: Array.from(d.querySelectorAll('.removal-list li')).map((l) => l.textContent) }; })()`);
      assert.equal(dlg.open, true);
      assert.match(dlg.title, /Remove the application thermostat\/control\?/);
      assert.deepEqual(dlg.refs.length, 1);
      assert.match(dlg.refs[0], /tv\/control/);
      await clickModal('cancel');
      await page.settle(100);
      assert.equal(await page.eval(`netatlas.exportText()`), before);
      await click('details.app-card[data-app="control"] [data-act="del-app"]');
      await page.settle(150);
      await clickModal('go');
      await page.settle(150);
      assert.deepEqual((await page.eval(APPS)).map((x) => x.id), ['sync']);
      assert.doesNotMatch(await page.eval(`netatlas.exportText()`), /peer: thermostat\/control/, 'the peer that named it is removed');
      await page.eval(`netatlas.undo(), true`);
      await page.settle(150);
      assert.equal(await page.eval(`netatlas.exportText()`), before, 'one undo step');
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);

      // ------------------------------------------------------------ IPv6: the laptop's method, the core's router advertisements
      await page.eval(`netatlas.select('device:laptop', true), netatlas.showTab('edit'), true`);
      await page.settle(150);
      const m6 = await page.eval(`(() => { const s = document.querySelector('select[data-t="ipv6-method"]'); return s ? { value: s.value, options: Array.from(s.options).map((o) => o.textContent) } : null; })()`);
      assert.ok(m6, 'the IPv6 method field');
      assert.equal(m6.value, 'slaac');
      assert.deepEqual(m6.options, ['None (no IPv6 address)', 'Automatic (SLAAC)', 'Automatic (DHCPv6)', 'Automatic (SLAAC and DHCPv6)'], 'one choice: no address written, so no static method offered');
      await page.eval(`netatlas.select('device:core', true), netatlas.showTab('edit'), true`);
      await page.settle(150);
      const ra = await page.eval(`(() => { const out = []; for (const cb of document.querySelectorAll('input[data-act="ra-toggle"]')) { const card = cb.closest('.card, details, .field'); out.push({ checked: cb.checked, label: (document.querySelector('label[for="' + cb.id + '"]') || {}).textContent || '', adv: card ? Array.from(card.parentElement.querySelectorAll('details.adv-section')).map((d) => d.open) : [] }); } return out; })()`);
      assert.ok(ra.some((r) => r.checked), 'Vlan10 sends router advertisements');
      assert.ok(ra.filter((r) => r.checked).every((r) => r.adv.every((o) => o === false)), 'their advanced settings closed');
      assert.match(await page.eval(`netatlas.exportText()`), /ipv6_ra: \{prefixes: \[fd00:10::\/64\]\}/);
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);

      // ------------------------------------------------------------ ot-network.yaml: Start application, MQTT
      await page.eval(`netatlas.loadExampleNamed('ot-network.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(5000); c.refresh(true); if (document.getElementById('spt-actions')) document.getElementById('spt-actions').click(); return true; })()`);
      await page.settle(200);
      await page.eval(`document.getElementById('sim-ne-expand').click(), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.getElementById('sim-ne-app').hidden`), false);
      const devs = await page.eval(`Array.from(document.getElementById('sim-a-dev').options).map((o) => [o.value, o.textContent, o.disabled])`);
      assert.deepEqual(devs, [['', 'Select…', false], ['eng-ws', 'eng-ws', false], ['hmi', 'hmi', false], ['plc', 'plc', false]]);
      const startApp = async (dev, app) => {
        await page.eval(`(() => { const d = document.getElementById('sim-a-dev'); d.value = '${dev}'; d.dispatchEvent(new Event('change')); const a = document.getElementById('sim-a-app'); a.value = '${app}'; a.dispatchEvent(new Event('change')); return true; })()`);
        assert.equal(await page.eval(`document.getElementById('sim-a-go').disabled`), false, `${dev}/${app} can start`);
        await click('#sim-a-go');
        await page.settle(100);
      };
      await startApp('hmi', 'dashboard');
      assert.match(await page.eval(`document.getElementById('sim-a-ctx').textContent`), /subscribe|publish|MQTT/i);
      await startApp('plc', 'telemetry');
      // the periodic publications: on the simulated clock, played on 12 s
      await page.eval(`(() => { const c = netatlas.simController(); for (let i = 0; i < 240; i++) c.runTo(c.t + 50); c.refresh(true); return true; })()`);
      await page.settle(200);
      await page.eval(`netatlas.simController().showTable('mqtt', 'edge'), true`);
      await page.settle(100);
      const sess = await page.eval(TABLE);
      assert.deepEqual(sess.map((r) => r[0]).sort(), ['hmi-dashboard', 'plc-telemetry']);
      assert.match(sess.find((r) => r[0] === 'hmi-dashboard')[2], /^plant\/cell1\/\+\/temperature \(QoS 1\)$/);
      await page.eval(`netatlas.simController().showTable('mqttc', 'hmi'), true`);
      await page.settle(100);
      assert.match((await page.eval(TABLE))[0][5], /^plant\/cell1\/plc-1\/temperature: \d+$/, 'the temperature only');
      // a PUBLISH's inspection: its topic, QoS and size, never its payload
      const pub = await page.eval(`(() => { const e = netatlas.simController().sim.events().find((x) => x.protocol === 'mqtt' && x.what === 'MQTT PUBLISH'); return e ? e.detail : null; })()`);
      assert.match(pub, /a payload of 64 bytes \(its contents are not modelled/);
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(150);

      // ------------------------------------------------------------ timing-ptp.yaml: the clocks' marks
      await page.eval(`netatlas.loadExampleNamed('timing-ptp.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      const boxes = await page.eval(BOXES);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(60000); c.refresh(true); return true; })()`);
      await page.settle(200);
      let marks = await page.eval(PTP);
      assert.deepEqual(Object.fromEntries(Object.entries(marks).map(([d, m]) => [d, m.state])), { 'drv-b': 'synchronized', 'gm-a': 'grandmaster', 'gm-b': 'synchronized', 'plc-b': 'synchronized', rt: 'synchronized', 'sw-a': 'transparent' });
      assert.match(marks['gm-a'].text, /^★ /);
      for (const [d, m] of Object.entries(marks)) {
        assert.equal(m.aria, m.tip, d);
        assert.equal(m.overlaps, false, `${d}: clear of texts and ports`);
      }
      assert.deepEqual(await page.eval(BOXES), boxes, 'no box moved or resized');
      // each mark says in its tooltip what it means (the clock's own state, its grandmaster)
      assert.match(marks['gm-a'].tip, /grandmaster/i);
      assert.match(marks['plc-b'].tip, /gm-a|grandmaster/);
      // Show PTP clock
      assert.ok((await page.eval(`netatlas.simController().itemsFor('device:rt').map((i) => i.label)`)).some((l) => /^Show PTP clock/.test(l)));
      await page.eval(`netatlas.simController().showTable('ptp', 'rt'), true`);
      await page.settle(100);
      const pt = await page.eval(TABLE);
      assert.ok(pt.length >= 2, 'its ports and estimates');
      assert.ok(pt.some((r) => r.some((c) => /SLAVE|Slave/.test(c))) && pt.some((r) => r.some((c) => /MASTER|Master/.test(c))));
      // gm-a off: gm-b takes over, its mark says so
      await page.eval(`(() => { const c = netatlas.simController(); c.sim.powerOff('gm-a'); c.runTo(c.t + 30000); c.refresh(true); return true; })()`);
      await page.settle(200);
      marks = await page.eval(PTP);
      assert.equal(marks['gm-b'].state, 'grandmaster');
      assert.notEqual((marks['gm-a'] || { state: 'off' }).state, 'grandmaster');
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(150);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .sim-ptp').length`), 0, 'Exit clears the marks');
      assert.deepEqual(await page.eval(NO_SIDEWAYS), []);
    } finally {
      await page.close();
    }
  });
}
