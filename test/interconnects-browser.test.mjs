// The non-IP interconnects in the browser (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): the physical view
// draws the example's lines, buses, taps, role badges and diamond ports, in
// both themes with enough contrast; the logical view none; the IP / Non-IP
// switches; the Edit tab and the export. In a simulation: Send illustrative
// data through its form (its reasons when it can't), dots along the
// interconnects, the inspector without layers and with its notice, and
// reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const COUNT = `(sel) => document.querySelectorAll('#canvas ' + sel).length`;
/** relative luminance contrast of two CSS colours */
const CONTRAST = `(a, b) => { const lum = (c) => { const m = c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }; const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: the physical view draws every interconnect (lines, buses with taps and role badges, diamonds), readable; the logical view none; IP / Non-IP; the Edit tab; the export`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('interconnects.yaml'), netatlas.setView('physical'), netatlas.fit(), true`);
      await page.settle(250);
      const n = (sel) => page.eval(`(${COUNT})(${JSON.stringify(sel)})`);
      // 6 point-to-point lines, 3 buses with 9 taps, 21 opaque ports as diamonds, 9 role badges
      assert.equal(await n('g.ic.p2p'), 6);
      assert.equal(await n('g.ic.bus'), 3);
      assert.equal(await n('g.ic.tap'), 9);
      assert.equal(await n('path.opaque-port'), 21);
      assert.equal(await n('g.ic-role'), 9);
      const labels = await page.eval(`Array.from(document.querySelectorAll('#canvas .ic-label, #canvas .ic-bar-label')).map((t) => t.textContent).sort()`);
      for (const t of ['USB 2.0 ↔', 'RS-232 →', 'RS-232 ↔', 'SRIO 3.1 ↔', 'RS-485', 'CAN FD', 'VME VME64x']) assert.ok(labels.includes(t), `${t} in ${labels.join(' | ')}`);
      // never colour alone: dashed lines, diamonds; enough contrast against the diagram in this theme (3:1 for marks)
      const look = await page.eval(`(() => { const l = document.querySelector('#canvas path.ic-line'); const cs = getComputedStyle(l); const bg = getComputedStyle(document.getElementById('canvas')).backgroundColor; const lab = getComputedStyle(document.querySelector('#canvas .ic-label')); return { dash: cs.strokeDasharray, stroke: cs.stroke, bg, text: lab.fill }; })()`);
      assert.notEqual(look.dash, 'none');
      const c1 = await page.eval(`(${CONTRAST})(${JSON.stringify(look.stroke)}, ${JSON.stringify(look.bg === 'rgba(0, 0, 0, 0)' ? (theme === 'dark' ? 'rgb(21, 24, 29)' : 'rgb(251, 252, 253)') : look.bg)})`);
      assert.ok(c1 >= 3, `line contrast ${c1}`);
      // the logical view: no interconnect
      await page.eval(`netatlas.setView('logical'), true`);
      await page.settle(200);
      assert.equal(await n('.ic'), 0);
      await page.eval(`netatlas.setView('physical'), true`);
      await page.settle(200);
      // IP / Non-IP: the switches are there for this model; off, one side alone (at least one stays on)
      assert.equal(await page.eval(`!document.getElementById('opt-ip').parentElement.hidden && !document.getElementById('opt-nonip').parentElement.hidden`), true);
      const toggle = (id) => page.eval(`(() => { const c = document.getElementById('${id}'); c.click(); return true; })()`);
      await toggle('opt-nonip');
      await page.settle(200);
      assert.equal(await n('.ic'), 0, 'IP only: no interconnect');
      assert.ok((await n('g.cable')) >= 2);
      await toggle('opt-nonip');
      await toggle('opt-ip');
      await page.settle(200);
      assert.equal(await n('g.cable'), 0, 'Non-IP only: no cable');
      assert.equal(await n('g.ic.bus'), 3);
      // switching the last one off switches the other one back on: IP alone
      await toggle('opt-nonip');
      await page.settle(200);
      assert.deepEqual(await page.eval(`[document.getElementById('opt-ip').checked, document.getElementById('opt-nonip').checked]`), [true, false], 'the last one switched off switches the other on');
      assert.equal(await n('.ic'), 0);
      assert.ok((await n('g.cable')) >= 2);
      await toggle('opt-nonip');
      await page.settle(200);
      assert.equal(await n('g.ic.bus'), 3, 'both again');
      // the Edit tab of a bus: its technology, its endpoints with their roles
      await page.eval(`netatlas.select('interconnect:meter-bus'), true`);
      await page.settle(150);
      const edit = await page.eval(`(() => { const p = document.getElementById('side'); return { text: p.textContent, tech: (p.querySelector('input[data-p*="technology"]') || {}).value }; })()`);
      assert.equal(edit.tech, 'RS-485');
      assert.match(edit.text, /Endpoints/);
      assert.match(edit.text, /ctl:rs485/);
      // the keyboard: / (Find), the technology typed, Enter selects the bus (and marks it in the diagram)
      await page.eval(`netatlas.select(null), document.body.focus(), true`);
      await page.key('/', 'Slash', 191);
      await page.type('can fd');
      await page.settle(150);
      await page.key('Enter', 'Enter', 13);
      await page.settle(200);
      assert.equal(await page.eval(`netatlas.session.state.selected`), 'interconnect:can');
      assert.equal(await n('g.ic.bus.selected'), 1);
      // the exported picture holds them too
      const svg = await page.eval(`netatlas.exportSvg()`);
      assert.ok(svg.includes('interconnect:meter-bus') && svg.includes('opaque-port'));
    } finally {
      await page.close();
    }
  });
}

test('Send illustrative data in a simulation: the form says why it can’t, sends when it can; dots along the bus; the inspector without layers, with its notice; reduced motion draws arrows', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('light'), netatlas.loadExampleNamed('interconnects.yaml'), netatlas.setView('physical'), netatlas.fit(), true`);
    await page.settle(200);
    await page.eval(`(() => { netatlas.startProtocolSimulation(); const c = netatlas.simController(); c.setPlaying(false); c.runTo(3000); c.refresh(true); return true; })()`);
    await page.settle(150);
    const set = (id, v) => page.eval(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); return e.value; })()`);
    assert.equal(await set('sim-o-ic', 'meter-bus'), 'meter-bus');
    await set('sim-o-init', 'ctl:rs485');
    await set('sim-o-from', 'meter1:rs485');
    await set('sim-o-to', 'meter2:rs485');
    // a transfer between two targets: refused, said so, the button disabled
    const need = await page.eval(`({ text: document.getElementById('sim-o-need').textContent, disabled: document.getElementById('sim-o-send').disabled })`);
    assert.equal(need.disabled, true);
    assert.match(need.text, /neither the source nor the recipient/);
    // a read: the meter's data to the controller, initiated by the controller
    await set('sim-o-to', 'ctl:rs485');
    assert.equal(await page.eval(`document.getElementById('sim-o-send').disabled`), false);
    await page.eval(`document.getElementById('sim-o-send').click(), true`);
    await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(true); for (let i = 0; i < 40; i++) c.advance(25); c.refresh(true); return true; })()`);
    await page.settle(150);
    const ev = await page.eval(`document.getElementById('sim-events').textContent`);
    assert.match(ev, /Send illustrative data/);
    // its dots: on the bus's taps, labelled with the technology
    const dots = await page.eval(`Array.from(document.querySelectorAll('#canvas .layer-sim-labels [data-for]')).map((g) => g.textContent).filter((t) => /RS-485 data/.test(t))`);
    assert.ok(dots.length >= 1, 'a dot of it on screen');
    // the inspector: its rows and the notice; no Ethernet / IP / TCP layer
    const id = await page.eval(`netatlas.simController().sim.engine.flights.filter((f) => f.protocol === 'opaque').pop().id`);
    assert.equal(await page.eval(`netatlas.simController().inspectFlight(${id})`), true);
    await page.settle(80);
    const panel = await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi').textContent`);
    assert.match(panel, /Illustrative traffic — protocol behaviour not simulated/);
    assert.match(panel, /Initiated by\s*ctl:rs485 \(controller/);
    assert.doesNotMatch(panel, /Layer 2|Layer 3|Ethernet|TCP|Flags/);
    // reduced motion: static arrows instead of moving dots
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.eval(`(() => { const c = netatlas.simController(); c.tables.closeAll(); c.sim.actOpaque({ initiator: 'ecu1:can0', from: 'ecu1:can0', to: ['ecu2:can0'], count: 1, interval: 1000, size: 8 }); c.setPlaying(true); for (let i = 0; i < 20; i++) c.advance(25); c.refresh(true); return true; })()`);
    await page.settle(150);
    const arrows = await page.eval(`Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).filter((g) => /arrow/.test(g.getAttribute('class') || '')).length`);
    assert.ok(arrows >= 1, String(arrows));
  } finally {
    await page.close();
  }
});
