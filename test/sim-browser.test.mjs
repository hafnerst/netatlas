// The protocol simulation with real input (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): the in-diagram menu
// on a cable and on a switch with the mouse and the keyboard, the ARP and
// MAC tables (several at once, Esc, dragged aside), the protocols shown
// changed without a restart, and reduced motion (static labelled arrows,
// the time in steps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function start(page) {
  await page.settle(150);
  const ex = await page.eval(`Array.from(document.querySelectorAll('#menu-examples [data-example]')).findIndex((b) => /protocol-simulation/.test(b.textContent))`);
  await page.eval(`localStorage.clear(), netatlas.loadExample(${ex}), netatlas.setView('physical'), true`);
  await page.settle(150);
}

test('the in-diagram menu with the mouse and the keyboard; the tables: several at once, Esc, dragged aside; the protocols shown without a restart', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    // Simulate ▾ with the keyboard: the menu, Start simulation…
    await page.eval(`document.getElementById('simulate-btn').focus(), true`);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await page.settle(80);
    assert.equal(await page.eval(`document.activeElement.id`), 'btn-sim-start');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simulationOn() && netatlas.toolWindow()`), 'sim');
    await page.eval(`netatlas.simController().setPlaying(false), netatlas.simController().runTo(20000), true`);
    // the window folded to its title bar, so that the diagram is free to click
    await page.eval(`document.querySelector('#toolwin .tw-collapse').click(), true`);
    await page.settle(100);
    // a click on a cable: Fail this link, at that spot; Enter fails it
    const pt = await page.eval(`(() => { const p = document.querySelector('#canvas g.cable[data-ref="link:l-carrier-r3"] path.cable-line'); const a = p.getPointAtLength(p.getTotalLength() / 2); const m = p.getScreenCTM(); return { x: a.x * m.a + a.y * m.c + m.e, y: a.x * m.b + a.y * m.d + m.f }; })()`);
    const x = pt.x;
    const y = pt.y;
    assert.match(await page.eval(`(document.elementFromPoint(${x}, ${y}).closest('[data-ref]') || { getAttribute() { return ''; } }).getAttribute('data-ref')`), /^link:l-carrier-r3$/);
    await page.mouse('mouseMoved', x, y);
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(150);
    const m = await page.eval(`(() => { const b = document.querySelector('.sim-menu'); const r = b.getBoundingClientRect(); return { items: Array.from(b.querySelectorAll('[role=menuitem]')).map((i) => i.textContent), active: document.activeElement.textContent, x: r.left, y: r.top }; })()`);
    assert.deepEqual(m.items, ['Fail this link']);
    assert.equal(m.active, 'Fail this link', 'the keyboard is in the menu');
    assert.ok(Math.abs(m.x - x) < 40 && Math.abs(m.y - y) < 40, 'at that spot');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simController().sim.failed()`), 'link:l-carrier-r3');
    // the same cable again: Restore link; Esc closes the menu
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(120);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`), ['Restore link']);
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    assert.equal(await page.eval(`!!document.querySelector('.sim-menu') || !netatlas.simulationOn()`), false, 'Esc closes the menu, the simulation goes on');
    // a switch: Show ARP table, Show MAC table (arrow keys move between them)
    const sw = await page.rect('#canvas .node[data-ref="device:core1"]');
    await page.mouse('mousePressed', sw.x + 10, sw.y + 10, 'left');
    await page.mouse('mouseReleased', sw.x + 10, sw.y + 10, 'left');
    await page.settle(120);
    await page.key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await page.eval(`document.activeElement.textContent`), 'Show MAC table');
    await page.key('ArrowUp', 'ArrowUp', 38);
    await page.key('Enter', 'Enter', 13);
    await page.settle(120);
    await page.eval(`netatlas.simController().showTable('arp', 'r1'), netatlas.simController().showTable('mac', 'acc-sw'), true`);
    await page.settle(120);
    const titles = await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel .st-title')).map((t) => t.textContent)`);
    assert.deepEqual(titles, ['ARP table · core1', 'ARP table · r1', 'MAC table · acc-sw']);
    // the first table is beside core1, not on it
    const pr = await page.rect('.sim-table-panel[data-device="core1"]');
    const box = await page.rect('#canvas .node[data-ref="device:core1"]');
    assert.ok(pr.x >= box.x + box.w || pr.x + pr.w <= box.x, 'beside the device');
    // dragged aside by its title
    const head = await page.rect('.sim-table-panel[data-device="r1"] .st-title');
    await page.mouse('mouseMoved', head.x + 5, head.y + 5);
    await page.mouse('mousePressed', head.x + 5, head.y + 5, 'left');
    await page.mouse('mouseMoved', head.x - 95, head.y + 45, 'left');
    await page.mouse('mouseReleased', head.x - 95, head.y + 45, 'left');
    await page.settle(80);
    const moved = await page.rect('.sim-table-panel[data-device="r1"] .st-title');
    assert.deepEqual([Math.round(moved.x - head.x), Math.round(moved.y - head.y)], [-100, 40]);
    // Esc in a table closes it (only it)
    await page.eval(`document.querySelector('.sim-table-panel[data-device="r1"] .st-close').focus(), true`);
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel')).map((p) => p.getAttribute('data-device'))`), ['core1', 'acc-sw']);
    // the protocols shown: unticking OSPF with the mouse changes nothing else (the window unfolded again)
    await page.eval(`document.querySelector('#toolwin .tw-collapse').click(), document.querySelector('input[data-sim-proto="ospf"]').scrollIntoView({ block: 'center' }), true`);
    await page.settle(100);
    const t0 = await page.eval(`netatlas.simController().sim.now`);
    await page.click('input[data-sim-proto="ospf"]');
    await page.settle(80);
    assert.equal(await page.eval(`netatlas.simController().sim.now`), t0, 'no restart, the same time');
    assert.equal(await page.eval(`netatlas.simController().shown.has('ospf')`), false);
    assert.equal(await page.eval(`document.querySelectorAll('.sim-table-panel').length`), 2, 'the tables stay');
    assert.equal(await page.eval(`Array.from(document.querySelectorAll('#canvas .sim-label text')).some((t) => /^OSPF/.test(t.textContent))`), false, 'no OSPF dots now');
    // Exit simulation closes the tables
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(80);
    assert.equal(await page.eval(`document.querySelectorAll('.sim-table-panel, .sim-menu').length`), 0);
  } finally {
    await page.close();
  }
});

test('reduced motion: no moving dots but static labelled arrows; the time advances in steps; exports are still pictures', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setSpeed(2), true`);
    await new Promise((r) => setTimeout(r, 3500));
    const t = await page.eval(`netatlas.simController().sim.now`);
    assert.ok(t >= 4000 && t % 2000 === 0, `steps of 1 s × speed 2: ${t}`);
    assert.match(await page.eval(`document.getElementById('sim-time').textContent`), /\(steps: reduced motion\)/);
    await page.eval(`netatlas.simController().setPlaying(false), netatlas.simController().runTo(12000), true`);
    await page.settle(80);
    const r = await page.eval(`({ dots: document.querySelectorAll('#canvas .sim-dot').length, arrows: document.querySelectorAll('#canvas .sim-arrow').length, labels: document.querySelectorAll('#canvas .sim-label').length })`);
    assert.equal(r.dots, 0);
    assert.ok(r.arrows > 0 && r.labels >= r.arrows, JSON.stringify(r));
    const svg = await page.eval(`netatlas.exportSvg()`);
    assert.match(svg, /Protocol simulation, t = 12 s/);
    assert.match(svg, /class="sim-arrow"/);
  } finally {
    await page.close();
  }
});
