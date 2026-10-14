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
  await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExample(${ex}), netatlas.setView('physical'), netatlas.fit(), true`);
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
    // the start dialog: four layers' sections, collapsed, their counts in their names; the keyboard on the first one
    const dlg = await page.eval(`(() => { const d = document.getElementById('modal'); return { open: d.open, heads: Array.from(d.querySelectorAll('.psec-toggle')).map((b) => b.textContent + '|' + b.getAttribute('aria-expanded')), active: document.activeElement.className }; })()`);
    assert.equal(dlg.open, true);
    assert.deepEqual(dlg.heads.map((h) => h.replace(/ \(\d+\)/, '')), ['Layer 1 – Physical|false', 'Layer 2 – Data link|false', 'Layer 3 – Network|false', 'Layer 4 – Transport|false']);
    assert.equal(dlg.active, 'psec-toggle');
    // open Layer 1 with the keyboard, type a latency, Start
    await page.key('Enter', 'Enter', 13);
    await page.settle(60);
    assert.equal(await page.eval(`document.activeElement.getAttribute('aria-expanded') + ' ' + !document.getElementById('sim-pd-l1').hidden`), 'true true');
    await page.eval(`document.getElementById('sim-pd-link-latency').focus(), document.getElementById('sim-pd-link-latency').select(), true`);
    await page.type('0.5');
    await page.key('Tab', 'Tab', 9);
    await page.settle(60);
    assert.equal(await page.eval(`document.querySelector('[data-param-row~="link-latency"]').classList.contains('modified')`), true, 'marked modified');
    await page.eval(`document.querySelector('#modal [data-value="start"]').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simulationOn() && netatlas.toolWindow()`), 'sim');
    assert.equal(await page.eval(`netatlas.simController().sim.params.simValue('link-latency')`), 0.5, 'started with the typed latency');
    assert.equal(await page.eval(`JSON.parse(sessionStorage.getItem('netatlas.sim.params'))['link-latency']`), 0.5, 'remembered for the session');
    await page.eval(`netatlas.simController().setPlaying(false), netatlas.simController().runTo(20000), true`);
    // the window folded to its title bar, so that the diagram is free to click
    await page.eval(`document.querySelector('#toolwin .tw-collapse').click(), true`);
    await page.settle(100);
    // a click on a cable: Fail this link, at that spot; Enter fails it
    // a point of the cable that is not covered by anything (the legend, the side panel)
    const pt = await page.eval(`(() => { const p = document.querySelector('#canvas g.cable[data-ref="link:l-carrier-r3"] path.cable-line'); const m = p.getScreenCTM(); for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) { const a = p.getPointAtLength(p.getTotalLength() * f); const x = a.x * m.a + a.y * m.c + m.e; const y = a.x * m.b + a.y * m.d + m.f; const e = document.elementFromPoint(x, y); if (e && e.closest('[data-ref="link:l-carrier-r3"]')) return { x, y }; } return { x: 0, y: 0 }; })()`);
    const x = pt.x;
    const y = pt.y;
    assert.match(await page.eval(`(document.elementFromPoint(${x}, ${y}).closest('[data-ref]') || { getAttribute() { return ''; } }).getAttribute('data-ref')`), /^link:l-carrier-r3$/, await page.eval(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName + '.' + e.getAttribute('class') + ' ' + (e.parentElement && e.parentElement.getAttribute('class')) : 'none'; })()`));
    await page.mouse('mouseMoved', x, y);
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(150);
    const m = await page.eval(`(() => { const b = document.querySelector('.sim-menu'); const r = b.getBoundingClientRect(); return { items: Array.from(b.querySelectorAll('[role=menuitem]')).map((i) => i.textContent), active: document.activeElement.textContent, x: r.left, y: r.top }; })()`);
    assert.deepEqual(m.items, ['Fail link', 'Start flapping', 'Highlight broadcast domain']);
    assert.equal(m.active, 'Fail link', 'the keyboard is in the menu');
    assert.ok(Math.abs(m.x - x) < 40 && Math.abs(m.y - y) < 40, 'at that spot');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simController().sim.downRefs().indexOf('link:l-carrier-r3') >= 0`), true);
    // the same cable again: Restore link; Esc closes the menu
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(120);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`), ['Restore link', 'Start flapping', 'Highlight broadcast domain']);
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

test('the start dialog: collapsed sections with counts, defaults with sources, range errors, modified marks and resets, remembered for the session; a device’s Simulation settings edited during the simulation, and undone', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1280, height: 860 });
  try {
    await start(page);
    await page.eval(`netatlas.openStartDialog(), true`);
    await page.settle(120);
    const heads = await page.eval(`Array.from(document.querySelectorAll('#modal .psec-toggle')).map((b) => [b.textContent, b.getAttribute('aria-expanded'), document.getElementById(b.getAttribute('aria-controls')).hidden])`);
    assert.deepEqual(heads, [
      ['Layer 1 – Physical (8)', 'false', true],
      ['Layer 2 – Data link (8)', 'false', true],
      ['Layer 3 – Network (8)', 'false', true],
      ['Layer 4 – Transport (8)', 'false', true],
    ]);
    assert.equal(await page.eval(`document.getElementById('sim-pd-reset-all').disabled`), true, 'nothing to reset');
    await page.click('#sim-pd-l2-btn');
    await page.settle(60);
    const f = await page.eval(`({ v: document.getElementById('sim-pd-arp-timeout').value, help: document.getElementById('sim-pd-arp-timeout-help').textContent, unit: document.getElementById('sim-pd-arp-timeout').parentElement.textContent })`);
    assert.equal(f.v, '14400');
    assert.match(f.help, /Default 4 h: Cisco IOS \(4 h\); RFC 826 sets none\./);
    assert.match(f.unit, /s$/);
    // out of range: an error, Start unavailable
    await page.eval(`(() => { const i = document.getElementById('sim-pd-arp-timeout'); i.focus(); i.select(); return true; })()`);
    await page.type('0');
    await page.settle(40);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-pd-arp-timeout-err').textContent, document.getElementById('sim-pd-arp-timeout').getAttribute('aria-invalid'), document.querySelector('#modal [data-value="start"]').disabled]`), ['ARP timeout must be from 1 s to 2147483 s.', 'true', true]);
    await page.eval(`document.getElementById('sim-pd-arp-timeout').select(), true`);
    await page.type('60');
    await page.key('Tab', 'Tab', 9);
    await page.settle(40);
    assert.deepEqual(await page.eval(`[document.querySelector('[data-param-row~="arp-timeout"]').classList.contains('modified'), document.querySelector('[data-layer="2"] .psec-mod').textContent, document.querySelector('#modal [data-value="start"]').disabled]`), [true, '1 modified', false]);
    // Reset Layer 2: the default again
    await page.eval(`document.querySelector('[data-layer="2"] .psec-reset').scrollIntoView({ block: 'center' }), true`);
    await page.click('[data-layer="2"] .psec-reset');
    await page.settle(40);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-pd-arp-timeout').value, document.querySelector('[data-param-row~="arp-timeout"]').classList.contains('modified')]`), ['14400', false]);
    await page.eval(`(() => { const i = document.getElementById('sim-pd-arp-timeout'); i.value = '60'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true; })()`);
    await page.click('#modal [data-value="start"]');
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simController().sim.params.simValue('arp-timeout')`), 60000);
    // the next start in this session remembers it
    await page.eval(`netatlas.exitSimulation(), netatlas.openStartDialog(), true`);
    await page.settle(120);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-pd-arp-timeout').value, document.querySelector('[data-param-row~="arp-timeout"]').classList.contains('modified')]`), ['60', true]);
    await page.click('#modal [data-value="cancel"]');
    await page.settle(80);
    assert.equal(await page.eval(`netatlas.simulationOn()`), false, 'Cancel starts nothing');
    // a running simulation: core1's Simulation section stays editable (the rest of the form is read-only); the change applies at once, Undo takes it back
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(15000), netatlas.closeToolWindow(), netatlas.select('device:core1'), true`);
    await page.click('[data-tab="edit"]');
    await page.settle(120);
    assert.equal(await page.eval(`!!document.querySelector('#side-body .sim-live #fg-simulation') && document.querySelector('#side-body fieldset.locked-form').disabled && !document.querySelector('#side-body fieldset.locked-form #fg-simulation')`), true);
    assert.equal(await page.eval(`document.getElementById('fg-simulation').getAttribute('aria-expanded')`), 'false', 'collapsed by default');
    await page.eval(`document.getElementById('fg-simulation').scrollIntoView({ block: 'center' }), true`);
    await page.click('#fg-simulation');
    await page.settle(60);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-attr-arp_timeout').value, document.getElementById('sim-attr-arp_timeout-state').textContent, document.getElementById('sim-attr-mac_aging').value, document.getElementById('sim-attr-mac_aging').placeholder, document.getElementById('sim-attr-mac_aging-state').textContent]`), ['300', 'Set on this device: 5 min. It would inherit 1 min (simulation).', '', '300', 'Inherited: 5 min (default — IEEE 802.1D-2004 recommended ageing time).']);
    await page.eval(`(() => { const i = document.getElementById('sim-attr-arp_timeout'); i.focus(); i.select(); return true; })()`);
    await page.type('45');
    await page.key('Tab', 'Tab', 9);
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /simulation: \{arp_timeout: 45, pim_dr_priority: 200\}/);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Parameter changed: ARP timeout on core1 5 min → 45 s (device)')`));
    await page.eval(`netatlas.undo(), true`);
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /simulation: \{arp_timeout: 300, pim_dr_priority: 200\}/);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Parameter changed: ARP timeout on core1 45 s → 5 min (device)')`));
    // the window's parameters: the same sections, applied at once
    await page.eval(`netatlas.openSimWindow(), document.getElementById('sim-params').open = true, document.getElementById('sim-pw-l2-btn').click(), true`);
    await page.settle(80);
    await page.eval(`(() => { const i = document.getElementById('sim-pw-mac-aging'); i.value = '60'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Parameter changed: MAC aging time 5 min → 1 min (simulation)')`));
    assert.equal(await page.eval(`JSON.parse(sessionStorage.getItem('netatlas.sim.params'))['mac-aging']`), 60000);
  } finally {
    await page.close();
  }
});

test('Layers 3 and 4 on screen: a dot opens the packet inspector, a log message too (keyboard); Send test… from a device; the storm warning; a broadcast domain highlighted; the log by layer and cast; connections and sessions', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(30000), true`);
    await page.settle(150);
    // the lab's loop storms: the banner and the window warn
    assert.match(await page.eval(`document.getElementById('sim-text').textContent`), /⚠ broadcast storm in the untagged frames/);
    assert.match(await page.eval(`(() => { const s = document.getElementById('sim-storm'); return s.hidden ? '' : s.textContent; })()`), /^Broadcast storm in the untagged frames \(loop over l-lab-\w, since t = [\d.]+ s\): a Layer 2 loop that no spanning tree blocks/);
    // the shapes' legend; a dot of each cast is drawn with its shape
    assert.match(await page.eval(`document.getElementById('sim-shapes').textContent`), /unicast.*broadcast.*multicast/);
    // a dot: the packet inspector, layer by layer
    // to a moment with a dot on a cable that nothing covers
    const dot = await page.eval(`(() => { const c = netatlas.simController(); for (let i = 0; i < 60; i++) { c.sim.advance(c.t + 5000, (f) => f.view === 'physical'); c.refresh(true); for (const d of document.querySelectorAll('#canvas [data-flight]')) { const r = d.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (e && e.closest('[data-flight]') === d) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } c.runTo(c.t + 1); } return null; })()`);
    assert.ok(dot, 'a dot that can be clicked');
    await page.mouse('mouseMoved', dot.x, dot.y);
    await page.mouse('mousePressed', dot.x, dot.y, 'left');
    await page.mouse('mouseReleased', dot.x, dot.y, 'left');
    await page.settle(120);
    const pi = await page.eval(`(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p ? { title: p.querySelector('.st-title').textContent, layers: Array.from(p.querySelectorAll('.pi-layer h4')).map((h) => h.textContent) } : null; })()`);
    assert.equal(pi.title, 'Packet · inspector');
    assert.equal(pi.layers[0], 'Layer 2 – Ethernet');
    assert.equal(pi.layers[pi.layers.length - 1], 'Payload');
    await page.key('Escape', 'Escape', 27);
    await page.settle(60);
    // a message of the log, by keyboard: its frame as sent
    await page.eval(`netatlas.openSimWindow(), true`);
    await page.settle(100);
    await page.eval(`(() => { const b = document.querySelector('#sim-log-table .sim-msg-btn'); b.focus(); return true; })()`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi p').textContent`), /as \S+ sent it at t = /);
    await page.key('Escape', 'Escape', 27);
    // the log by layer and cast
    await page.eval(`(() => { const s = document.getElementById('sim-log-cast'); s.value = 'broadcast'; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    const bc = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-protocol'))`);
    assert.ok(bc.length > 0 && bc.every((p) => ['arp', 'garp', 'icmp', 'udp', 'stp'].indexOf(p) >= 0), bc.join(','));
    await page.eval(`(() => { const s = document.getElementById('sim-log-cast'); s.value = ''; s.dispatchEvent(new Event('change')); const l = document.getElementById('sim-log-layer'); l.value = '4'; l.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    const l4 = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-protocol'))`);
    assert.ok(l4.length > 0 && l4.indexOf('ospf') < 0 && l4.indexOf('arp') < 0, l4.join(','));
    // Send test… from pc1's menu: the window's section with pc1 as the source; srv tcp/22 is refused
    await page.eval(`netatlas.simController().sendTestFrom('pc1'), true`);
    await page.settle(100);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-test').open, document.getElementById('sim-t-from').value, document.activeElement.id]`), [true, 'pc1', 'sim-t-to']);
    await page.type('srv');
    await page.eval(`(() => { const k = document.getElementById('sim-t-kind'); k.value = 'tcp'; const p = document.getElementById('sim-t-port'); p.value = '22'; return true; })()`);
    await page.click('#sim-t-send');
    await page.settle(80);
    assert.match(await page.eval(`document.getElementById('sim-t-msg').textContent`), /^Test sent at t = [\d.]+ s: pc1 → srv tcp\/22\.$/);
    await page.eval(`netatlas.simController().runTo(netatlas.simController().t + 3000), true`);
    await page.settle(80);
    assert.match(await page.eval(`document.querySelector('#sim-tests li').textContent`), /pc1 → srv tcp\/22: connection refused: RST from 10\.30\.0\.10 \(srv\)/);
    // a broadcast domain: the lab host's
    await page.eval(`netatlas.simController().highlightDomain({ dev: 'lab-h', iface: 'eth0' }), true`);
    await page.settle(100);
    const hl = await page.eval(`({ on: document.querySelector('#canvas svg, #canvas').closest('svg') ? 0 : 0, cls: document.querySelector('svg.has-bcdomain') ? true : false, devs: Array.from(document.querySelectorAll('#canvas .node.bc-on')).map((n) => n.getAttribute('data-ref')).sort(), banner: document.getElementById('sim-text').textContent })`);
    assert.equal(hl.cls, true);
    assert.deepEqual(hl.devs, ['device:lab-h', 'device:lab-sw1', 'device:lab-sw2']);
    assert.match(hl.banner, /broadcast domain of lab-h:eth0 highlighted/);
    await page.eval(`netatlas.simController().clearDomain(), true`);
    await page.settle(60);
    assert.equal(await page.eval(`!!document.querySelector('svg.has-bcdomain')`), false);
    // connections and a firewall's sessions
    await page.eval(`netatlas.simController().showTable('conn', 'srv'), netatlas.simController().showTable('fw', 'fw1'), true`);
    await page.settle(100);
    const tabs = await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel .st-title')).map((t) => t.textContent)`);
    assert.deepEqual(tabs, ['Connections · srv', 'Sessions · fw1']);
    assert.ok(await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel[data-table="conn"] tbody tr')).some((r) => r.getAttribute('data-state') === 'LISTEN')`));
    assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="fw"] .st-timers').textContent`), /Default action.*Reject/);
  } finally {
    await page.close();
  }
});

test('multicast on screen: Join group… from a device’s menu (the window’s form), the event with Leave group, the IGMP groups, the multicast table and routes, IGMP in the inspector', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(40000), true`);
    await page.settle(150);
    // a host's menu: Join group…, Leave group for its own groups, Start stream…
    const sw = await page.rect('#canvas .node[data-ref="device:pc1"]');
    await page.mouse('mousePressed', sw.x + 10, sw.y + 10, 'left');
    await page.mouse('mouseReleased', sw.x + 10, sw.y + 10, 'left');
    await page.settle(120);
    const items = await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`);
    for (const it of ['Join group…', 'Leave group 239.1.1.1', 'Start stream…']) assert.ok(items.indexOf(it) >= 0, items.join('|'));
    await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).find((b) => b.textContent === 'Join group…').click(), true`);
    await page.settle(120);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-mc').open, document.getElementById('sim-mc-jif').value, document.activeElement.id]`), [true, 'pc1:eth0', 'sim-mc-jg']);
    await page.type('239.4.4.4');
    await page.click('#sim-mc-join');
    await page.settle(100);
    assert.equal(await page.eval(`document.getElementById('sim-mc-msg').textContent`), 'pc1:eth0 joins 239.4.4.4.');
    const ev = await page.eval(`(() => { const li = document.querySelector('#sim-events li[data-event="join"]'); return li ? [li.textContent, li.querySelector('button').textContent] : null; })()`);
    assert.match(ev[0], /joined 239\.4\.4\.4/);
    assert.equal(ev[1], 'Leave group');
    await page.eval(`document.querySelector('#sim-events li[data-event="join"] button').click(), true`);
    await page.settle(100);
    assert.equal(await page.eval(`!!document.querySelector('#sim-events li[data-event="join"]')`), false);
    // the tables
    await page.eval(`netatlas.simController().showTable('igmp', 'core1'), netatlas.simController().showTable('snoop', 'acc-sw'), netatlas.simController().showTable('mroute', 'r1'), true`);
    await page.settle(120);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel .st-title')).map((t) => t.textContent)`), ['IGMP groups · core1', 'Multicast table · acc-sw', 'Multicast routes · r1']);
    assert.ok(await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel[data-table="snoop"] tbody tr')).some((r) => /239\.1\.1\.1/.test(r.textContent))`));
    assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="mroute"]').textContent`), /RP 10\.255\.0\.1 \(r1\)/);
    // an IGMP report in the inspector, from the log
    await page.eval(`netatlas.simController().tables.closeAll(), true`);
    const seq = await page.eval(`netatlas.simController().sim.events().find((e) => e.protocol === 'igmp' && e.what === 'Report' && e.hdr).seq`);
    await page.eval(`netatlas.simController().inspectEvent(${seq}), true`);
    await page.settle(100);
    const heads = await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel[data-table="packet"] .pi-layer h4')).map((h) => h.textContent)`);
    assert.ok(heads.indexOf('Layer 3 – IGMP (2)') >= 0, heads.join(', '));
  } finally {
    await page.close();
  }
});
