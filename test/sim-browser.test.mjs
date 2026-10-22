// The protocol simulation with real input (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): the Start dialog
// with the keyboard (protocols first, the parameters collapsed below,
// Enter and Esc, remembered for the session); the simulation layout
// (Simulation setup, Actions, the simulation panel; back on Exit with the
// previous tab and selection; the panel's splitter; F6 between the
// regions); the in-diagram menu on a cable and on a switch with the mouse
// and the keyboard; the device tables in the simulation panel; the
// protocols shown changed without a restart; the pacing on screen (a dot
// clicked pauses and opens the packet inspector, Follow message, Step,
// the speed and the pacing modes); reduced motion (static labelled
// arrows, Step a message at a time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function start(page) {
  await page.settle(150);
  const ex = 'protocol-simulation.yaml';
  await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
  await page.settle(150);
}

const REGION = `(() => { const a = document.activeElement; for (const id of ['outline', 'canvas-wrap', 'side', 'sim-paneltabs', 'sim-dock', 'toolwin']) { const r = document.getElementById(id); if (r && r.contains(a)) return id; } return a === document.body ? 'body' : a.id; })()`;

test('the Start dialog with the keyboard: protocols first (groups, counts, Select all and Clear), the parameters collapsed below with their modified notes; Enter starts, Esc cancels; both remembered for the session and carried into the setup panel', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1366, height: 768 });
  try {
    await start(page);
    // Simulate ▾ with the keyboard: the menu, Start simulation…
    await page.eval(`document.getElementById('simulate-btn').focus(), true`);
    await page.key('ArrowDown', 'ArrowDown', 40);
    await page.settle(80);
    assert.equal(await page.eval(`document.activeElement.id`), 'btn-sim-start');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    const d0 = await page.eval(`(() => { const d = document.getElementById('modal'); const body = d.querySelector('.modal-body'); return {
      open: d.open, active: document.activeElement.id,
      order: Array.from(body.children).map((c) => c.className.split(' ')[0]),
      groups: Array.from(d.querySelectorAll('.pp-group')).map((g) => g.querySelector('.pp-gname').textContent),
      boxes: Array.from(d.querySelectorAll('input[data-sim-proto]')).every((b) => b.checked),
      uses: Array.from(d.querySelectorAll('.pp-item')).map((l) => l.textContent).find((t) => /^OSPF/.test(t)),
      count: d.querySelector('.pp-count').textContent,
      heads: Array.from(d.querySelectorAll('.psec-toggle')).map((b) => b.textContent + '|' + b.getAttribute('aria-expanded')),
      scroll: [body.scrollHeight, body.clientHeight], list: d.querySelector('.pp-list').scrollHeight > d.querySelector('.pp-list').clientHeight,
      start: d.querySelector('[data-value="start"]').className, last: d.querySelector('.modal-btns').lastElementChild.getAttribute('data-value') }; })()`);
    assert.equal(d0.open, true);
    assert.equal(d0.active, 'sim-pd-protos-p-arp', 'the keyboard starts on the first protocol');
    // (the execution scope, what runs, comes before the protocols since execution scopes: src/ui/scope-ui.ts)
    assert.deepEqual(d0.order.slice(0, 5), ['muted', 'sim-pd-scope', 'pp', 'snd', 'psecs'], 'the execution scope, then the protocols, then the senders, the parameters below');
    assert.deepEqual(d0.groups, ['Layer 2 (4 of 4)', 'Routing (3 of 3)', 'Redundancy (1 of 1)', 'Tunnels and overlays (2 of 2)', 'Multicast (3 of 3)', 'Traffic (4 of 4)', 'Custom (1 of 1)']);
    assert.equal(d0.boxes, true, 'all selected by default');
    assert.match(d0.uses, /^OSPF\d+ relations$/);
    assert.equal(d0.count, '(18 of 18)');
    assert.deepEqual(d0.heads, ['▸Layer 1 – Physical (8)|false', '▸Layer 2 – Data link (7)|false', '▸Layer 3 – Network (8)|false', '▸Layer 4 – Transport (8)|false']);
    assert.ok(d0.scroll[0] <= d0.scroll[1] + 1, `the dialog does not scroll at 1366×768 with the parameters collapsed: ${d0.scroll}`);
    assert.equal(d0.start, 'primary');
    assert.equal(d0.last, 'start', 'Start, the primary action, last');
    // Space unticks ARP; the group's Clear clears Traffic; its count follows
    await page.key(' ', 'Space', 32);
    await page.eval(`document.querySelector('#modal [data-group-none="Traffic"]').click(), true`);
    await page.settle(60);
    assert.deepEqual(await page.eval(`[document.querySelector('#modal .pp-group[data-group="Traffic"] .pp-gcount').textContent, document.querySelector('#modal .pp-group[data-group="Layer 2"] .pp-gcount').textContent, document.querySelector('#modal .pp-count').textContent, document.querySelector('#modal [data-group-none="Traffic"]').disabled]`), ['(0 of 4)', '(3 of 4)', '(13 of 18)', true]);
    // a parameter: the collapsed layer says it is modified, also in its accessible name
    await page.eval(`(() => { document.getElementById('sim-pd-l3-btn').click(); const i = document.getElementById('sim-pd-ttl'); i.value = '32'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); document.getElementById('sim-pd-l3-btn').click(); return true; })()`);
    await page.settle(60);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-pd-l3-btn').textContent, document.getElementById('sim-pd-l3-btn').getAttribute('aria-expanded')]`), ['▸Layer 3 – Network (8) · 1 modified', 'false']);
    await page.cmd('Accessibility.enable');
    const { nodes } = await page.cmd('Accessibility.getFullAXTree');
    assert.ok(nodes.some((n) => n.role && n.role.value === 'button' && n.name && n.name.value === 'Layer 3 – Network (8) · 1 modified'), 'the accessible name has the count and the modified note');
    // Esc cancels: nothing starts
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    assert.equal(await page.eval(`netatlas.simulationOn() || document.getElementById('modal').open`), false);
    // open again: the protocols open at the top again, every one checked (nothing was started, nothing remembered)
    await page.eval(`netatlas.openStartDialog(), true`);
    await page.settle(120);
    assert.equal(await page.eval(`document.querySelector('#modal .pp-count').textContent + ' ' + document.activeElement.id`), '(18 of 18) sim-pd-protos-p-arp');
    // untick Traffic again, then Enter on a checkbox starts
    await page.eval(`document.querySelector('#modal [data-group-none="Traffic"]').click(), document.getElementById('sim-pd-protos-p-arp').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simulationOn()`), true, 'Enter starts');
    assert.deepEqual(await page.eval(`['icmp', 'tcp', 'udp', 'arp'].map((p) => netatlas.simController().shown.has(p))`), [false, false, false, true]);
    // carried into the setup panel: the same choice, the protocols open, every layer collapsed
    const s = await page.eval(`({ count: document.querySelector('#sim-setup .pp-count').textContent, traffic: document.querySelector('#sim-setup .pp-group[data-group="Traffic"] .pp-gcount').textContent, heads: Array.from(document.querySelectorAll('#sim-setup .psec-toggle')).map((b) => b.getAttribute('aria-expanded')) })`);
    assert.deepEqual(s, { count: '(14 of 18)', traffic: '(0 of 4)', heads: ['false', 'false', 'false', 'false'] });
    // remembered for the next start in this session
    await page.eval(`netatlas.exitSimulation(), netatlas.openStartDialog(), true`);
    await page.settle(120);
    assert.equal(await page.eval(`document.querySelector('#modal .pp-group[data-group="Traffic"] .pp-gcount').textContent`), '(0 of 4)');
    await page.click('#modal [data-value="cancel"]');
  } finally {
    await page.close();
  }
});

test('the simulation layout: setup and actions in place of the Objects list and the Inspector, the panel under the diagram (resizable with the keyboard, not detachable); F6 between the regions; Exit brings back the tab, the selection and the zoom', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.select('device:core1'), document.querySelector('[data-tab="legend"]').click(), true`);
    await page.settle(100);
    const zoom = await page.eval(`document.getElementById('viewport').getAttribute('transform')`);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), true`);
    await page.settle(150);
    const L = await page.eval(`(() => { const v = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; return {
      setup: v('sim-setup'), objects: v('outline-body'), actions: v('sim-actions'), tabs: v('side-body') || !!document.querySelector('#side .tabs').getClientRects().length, dock: v('sim-dock'),
      outlineName: document.getElementById(document.getElementById('outline').getAttribute('aria-labelledby')).textContent, sideName: document.getElementById(document.getElementById('side').getAttribute('aria-labelledby')).textContent,
      toolwin: netatlas.toolWindow(), detach: !!document.querySelector('#sim-dock .tw-dock, #sim-dock .tw-close'),
      scroll: document.documentElement.scrollHeight - document.documentElement.clientHeight, obj: !!document.getElementById('sim-obj'),
      acts: Array.from(document.querySelectorAll('#sim-act-net .sim-ne-h button > span:last-child')).map((b) => b.textContent) }; })()`);
    assert.deepEqual([L.setup, L.objects, L.actions, L.tabs, L.dock], [true, false, true, false, true]);
    assert.deepEqual([L.outlineName, L.sideName], ['Simulation setup', 'Actions']);
    assert.equal(L.toolwin, '', 'no floating window');
    assert.equal(L.detach, false, 'the panel has nothing to detach or close it');
    assert.equal(L.scroll, 0);
    assert.equal(L.obj, false, 'no object to choose first');
    assert.deepEqual(L.acts, ['Send network packets', 'Join multicast group', 'Leave multicast group', 'Start multicast stream', 'Interface actions', 'Start application'], 'the six actions, whatever is selected');
    // the panel: by default its header and three rows of each table, which is also its minimum; the diagram is the largest part
    const h0 = await page.eval(`document.getElementById('sim-dock').getBoundingClientRect().height`);
    const cw = await page.eval(`document.getElementById('canvas-wrap').getBoundingClientRect().height`);
    const b0 = await page.eval(`netatlas.dockBounds()`);
    assert.ok(Math.abs(h0 - b0.min) < 2 && b0.dflt === b0.min && cw > 2 * h0, `the panel ${h0} (${JSON.stringify(b0)}), the diagram ${cw}`);
    // the splitter: ↑ taller, Enter back to the default; remembered under its new key
    await page.eval(`document.getElementById('dock-splitter').focus(), true`);
    await page.key('ArrowUp', 'ArrowUp', 38);
    await page.key('ArrowUp', 'ArrowUp', 38);
    const h1 = await page.eval(`document.getElementById('sim-dock').getBoundingClientRect().height`);
    assert.ok(Math.abs(h1 - h0 - 40) < 2, `${h0} → ${h1}`);
    assert.equal(await page.eval(`Number(localStorage.getItem('netatlas.simPanelHeight3'))`), Math.round(h1));
    assert.equal(await page.eval(`document.getElementById('dock-splitter').getAttribute('aria-valuenow')`), String(Math.round(h1)));
    for (let i = 0; i < 40; i++) await page.key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await page.eval(`Math.round(document.getElementById('sim-dock').getBoundingClientRect().height)`), await page.eval(`netatlas.dockBounds().min`), 'never lower than its minimum');
    await page.key('Enter', 'Enter', 13);
    assert.ok(Math.abs((await page.eval(`document.getElementById('sim-dock').getBoundingClientRect().height`)) - h0) < 2, 'Enter: the default height');
    // F6: left panel, diagram, right panel, the simulation panel, round again; Shift+F6 back
    await page.eval(`document.getElementById('canvas').focus(), true`);
    const seq = [];
    for (let i = 0; i < 4; i++) {
      await page.key('F6', 'F6', 117);
      seq.push(await page.eval(REGION));
    }
    assert.deepEqual(seq, ['side', 'sim-dock', 'outline', 'canvas-wrap']);
    await page.key('F6', 'F6', 117, 8);
    assert.equal(await page.eval(REGION), 'outline');
    // Exit: the Objects list and the Inspector's Legend tab again, core1 still selected, the same zoom
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(120);
    const E = await page.eval(`({ objects: document.getElementById('outline-body').getBoundingClientRect().width > 0, dock: document.getElementById('sim-dock').hidden, tab: document.querySelector('#side .tabs .active').getAttribute('data-tab'), sel: netatlas.session.state.selected, zoom: document.getElementById('viewport').getAttribute('transform'), name: document.getElementById('side').getAttribute('aria-label'), sim: document.body.getAttribute('data-sim') })`);
    assert.deepEqual(E, { objects: true, dock: true, tab: 'legend', sel: 'device:core1', zoom, name: 'Inspector', sim: null });
  } finally {
    await page.close();
  }
});

test('the in-diagram menu with the mouse and the keyboard; the device tables in the simulation panel; the protocols shown without a restart', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(20000), netatlas.fit(), true`);
    await page.settle(150);
    // a click on a cable: Fail this link, at that spot; Enter fails it
    const pt = await page.eval(`(() => { const p = document.querySelector('#canvas g.cable[data-ref="link:l-carrier-r3"] path.cable-line'); const m = p.getScreenCTM(); for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) { const a = p.getPointAtLength(p.getTotalLength() * f); const x = a.x * m.a + a.y * m.c + m.e; const y = a.x * m.b + a.y * m.d + m.f; const e = document.elementFromPoint(x, y); if (e && e.closest('[data-ref="link:l-carrier-r3"]')) return { x, y }; } return { x: 0, y: 0 }; })()`);
    const { x, y } = pt;
    assert.ok(x > 0, 'a point of the cable that nothing covers');
    await page.mouse('mouseMoved', x, y);
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(150);
    const m = await page.eval(`(() => { const b = document.querySelector('.sim-menu'); const r = b.getBoundingClientRect(); return { items: Array.from(b.querySelectorAll('[role=menuitem]')).map((i) => i.textContent), active: document.activeElement.textContent, x: r.left, y: r.top }; })()`);
    // no flapping on a cable: that is an interface's (its ports' menus, Interface actions)
    assert.deepEqual(m.items, ['Fail link', 'Highlight broadcast domain']);
    assert.equal(m.active, 'Fail link', 'the keyboard is in the menu');
    assert.ok(Math.abs(m.x - x) < 40 && Math.abs(m.y - y) < 40, 'at that spot');
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.simController().sim.downRefs().indexOf('link:l-carrier-r3') >= 0`), true);
    assert.equal(await page.eval(`document.querySelector('#sim-events li[data-ref="link:l-carrier-r3"] button').textContent`), 'Restore');
    // the same cable again: Restore link; Esc closes the menu
    await page.mouse('mousePressed', x, y, 'left');
    await page.mouse('mouseReleased', x, y, 'left');
    await page.settle(120);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`), ['Restore link', 'Highlight broadcast domain']);
    await page.key('Escape', 'Escape', 27);
    await page.settle(80);
    assert.equal(await page.eval(`!!document.querySelector('.sim-menu') || !netatlas.simulationOn()`), false, 'Esc closes the menu, the simulation goes on');
    // Restore from Active events
    await page.eval(`document.querySelector('#sim-events li[data-ref="link:l-carrier-r3"] button').scrollIntoView({ block: 'nearest' }), true`);
    await page.click('#sim-events li[data-ref="link:l-carrier-r3"] button');
    await page.settle(100);
    assert.equal(await page.eval(`netatlas.simController().sim.netEvents().some((e) => e.ref === 'link:l-carrier-r3')`), false, 'restored (it comes up after its link-up delay)');
    // a switch: Show ARP table, Show MAC table (arrow keys move between them); the table shows in the simulation panel
    const sw = await page.rect('#canvas .node[data-ref="device:core1"]');
    await page.mouse('mousePressed', sw.x + 10, sw.y + 10, 'left');
    await page.mouse('mouseReleased', sw.x + 10, sw.y + 10, 'left');
    await page.settle(120);
    await page.key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await page.eval(`document.activeElement.textContent`), 'Show MAC table');
    await page.key('ArrowUp', 'ArrowUp', 38);
    await page.key('Enter', 'Enter', 13);
    await page.settle(120);
    const st = await page.eval(`({ tabs: Array.from(document.querySelectorAll('#sd-sttabs [data-st]')).map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')), heads: Array.from(document.querySelectorAll('#sim-status-table thead th')).slice(0, 8).map((h) => h.textContent), rows: document.querySelectorAll('#sim-status-table tbody tr[data-ip]').length, panels: document.querySelectorAll('.sim-table-panel').length })`);
    assert.deepEqual(st.tabs, ['Protocols', 'ARP*', 'MAC', 'Connections', 'IGMP / MLD', 'Querier', 'Multicast routes', 'Snooping']);
    assert.deepEqual(st.heads, ['IP address', 'MAC address', 'Interface', 'VLAN', 'Type', 'State', 'Age', 'Expires in']);
    assert.ok(st.rows > 0);
    assert.equal(st.panels, 0, 'no floating table');
    // the MAC tab; Protocols again
    await page.click('#sd-sttabs [data-st="mac"]');
    await page.settle(80);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#sim-status-table thead th')).map((h) => h.textContent)`), ['MAC address', 'VLAN', 'Port', 'Type', 'Age', 'Expires in']);
    await page.click('#sd-sttabs [data-st="status"]');
    await page.settle(80);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#sim-status-table thead th')).map((h) => h.textContent)`), ['Protocol', 'Session', 'State', 'Details']);
    // the protocols shown: unticking OSPF in the setup changes nothing else
    const t0 = await page.eval(`netatlas.simController().sim.now`);
    await page.eval(`document.querySelector('#sim-setup input[data-sim-proto="ospf"]').scrollIntoView({ block: 'center' }), true`);
    await page.click('#sim-setup input[data-sim-proto="ospf"]');
    await page.settle(80);
    assert.equal(await page.eval(`netatlas.simController().sim.now`), t0, 'no restart, the same time');
    assert.equal(await page.eval(`netatlas.simController().shown.has('ospf')`), false);
    assert.equal(await page.eval(`Array.from(document.querySelectorAll('#canvas .sim-label text')).some((t) => /^OSPF/.test(t.textContent))`), false, 'no OSPF dots now');
    assert.equal(await page.eval(`JSON.parse(sessionStorage.getItem('netatlas.sim.hidden')).indexOf('ospf') >= 0`), true, 'remembered for the next start');
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(80);
    assert.equal(await page.eval(`document.querySelectorAll('.sim-table-panel, .sim-menu').length`), 0);
  } finally {
    await page.close();
  }
});

test('the pacing on screen: every dot travels its way at the readable pace; a dot clicked pauses and opens the packet inspector with Follow message; Step; the speed, the modes and skipping idle time', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), true`);
    // (polled: a loaded machine's slow frames count at most 0.1 s each)
    const PACE = `(() => { const c = netatlas.simController(); return { text: document.getElementById('sim-pace-text').textContent, playing: c.playing, clock: c.pacer.clock, dots: document.querySelectorAll('#canvas .layer-sim [data-flight]').length, items: c.pacer.items.filter((i) => i.drawn && i.f.view === 'physical').map((i) => i.hop) }; })()`;
    let p = null;
    for (let i = 0; i < 20 && !(p && p.clock > 1000); i++) {
      await new Promise((r) => setTimeout(r, i ? 250 : 1500));
      p = await page.eval(PACE);
    }
    assert.match(p.text, /^Readable · 3 s per hop · 1×( · waiting for packet arrival( \(.+\))?)?$/);
    assert.ok(p.playing && p.clock > 1000, JSON.stringify(p));
    assert.ok(p.items.every((h) => h >= 2000), 'every hop at least 2 s');
    // a dot: at the moment one is drawn, click it; the simulation pauses and the inspector opens
    let dot = null;
    for (let i = 0; i < 40 && !dot; i++) {
      dot = await page.eval(`(() => { for (const d of document.querySelectorAll('#canvas .layer-sim [data-flight]')) { const r = d.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (e && e.closest('[data-flight]') === d) { netatlas.simController().setPlaying(false); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: d.getAttribute('data-flight') }; } } return null; })()`);
      if (!dot) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(dot, 'a dot that can be clicked');
    // (paused for the click to hit the dot; a click while it plays pauses it, below)
    await page.mouse('mouseMoved', dot.x, dot.y);
    await page.mouse('mousePressed', dot.x, dot.y, 'left');
    await page.mouse('mouseReleased', dot.x, dot.y, 'left');
    await page.settle(120);
    const pi = await page.eval(`(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p ? { title: p.querySelector('.st-title').textContent, follow: p.querySelector('#pi-follow') && p.querySelector('#pi-follow').textContent, playing: netatlas.simController().playing, play: document.getElementById('sim-play').textContent } : null; })()`);
    assert.ok(pi, 'the packet inspector');
    assert.deepEqual(pi, { title: 'Packet · inspector', follow: 'Follow message', playing: false, play: 'Play' });
    assert.equal(await page.eval(`(() => { const c = netatlas.simController(); c.setPlaying(true); c.inspectFlight(${dot.id}); return c.playing; })()`), false, 'a dot opened while it plays pauses the simulation');
    // Follow message: its conversation alone sets the pace; the panel says so; Stop following
    await page.click('#pi-follow');
    await page.settle(80);
    const f = await page.eval(`({ key: netatlas.simController().pacer.follow && netatlas.simController().pacer.follow.key, note: document.getElementById('sim-follow').hidden ? '' : document.getElementById('sim-follow-text').textContent, btn: document.getElementById('pi-follow').textContent })`);
    assert.ok(f.key && /^Following .+ and its replies$/.test(f.note) && f.btn === 'Stop following', JSON.stringify(f));
    await page.key('Escape', 'Escape', 27);
    // Step: to the next message event, paused
    const c0 = await page.eval(`netatlas.simController().pacer.clock`);
    await page.click('#sim-step');
    await page.settle(60);
    assert.ok(await page.eval(`netatlas.simController().pacer.clock > ${c0} && !netatlas.simController().playing`));
    await page.click('#sim-follow-stop');
    await page.settle(60);
    assert.equal(await page.eval(`netatlas.simController().pacer.follow`), null);
    // the speed, the proportional mode with its scale, skipping
    await page.eval(`(() => { const s = document.getElementById('sim-speed'); s.value = '2'; s.dispatchEvent(new Event('change')); const m = document.getElementById('sim-pace'); m.value = 'proportional'; m.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(60);
    const pm = await page.eval(`[document.getElementById('sim-pace-text').textContent, document.getElementById('sim-pace-scale-wrap').hidden, Array.from(document.getElementById('sim-speed').options).map((o) => o.value).join(' ')]`);
    assert.match(pm[0], /^Proportional · 1 ms = 1 s · 2×( · waiting for packet arrival( \(.+\))?)?$/);
    assert.deepEqual(pm.slice(1), [false, '0.1 0.25 0.5 1 2 4']);
    await page.eval(`(() => { const s = document.getElementById('sim-pace-scale'); s.value = '100'; s.dispatchEvent(new Event('change')); const k = document.getElementById('sim-skip'); k.click(); return true; })()`);
    await page.settle(60);
    const pm2 = await page.eval(`[document.getElementById('sim-pace-text').textContent, netatlas.simController().pacer.skipIdle]`);
    assert.match(pm2[0], /^Proportional · 1 ms = 0\.1 s · 2×( · waiting for packet arrival( \(.+\))?)?$/);
    assert.equal(pm2[1], false);
    // a skip is reported while it is recent (OSPF alone: its hellos are seconds apart)
    await page.eval(`(() => { const c = netatlas.simController(); const k = document.getElementById('sim-skip'); k.click(); const m = document.getElementById('sim-pace'); m.value = 'readable'; m.dispatchEvent(new Event('change')); c.setShownSet(new Set(['ospf'])); c.runTo(5000); c.setPlaying(true); return true; })()`);
    let skipped = '';
    for (let i = 0; i < 40 && !skipped; i++) {
      await new Promise((r) => setTimeout(r, 100));
      skipped = await page.eval(`document.getElementById('sim-skipped').textContent`);
    }
    assert.match(skipped, /^⏩ [\d.]+ (ms|s|min) skipped$/);
    await page.eval(`netatlas.exitSimulation(), true`);
  } finally {
    await page.close();
  }
});

test('reduced motion: no moving dots but static labelled arrows, each for its paced time; Step a message at a time; exports are still pictures', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), true`);
    await page.settle(80);
    // Step: the first message appears as an arrow at once, and stays while paused
    await page.click('#sim-step');
    await page.settle(80);
    const a = await page.eval(`({ dots: document.querySelectorAll('#canvas .sim-dot').length, arrows: document.querySelectorAll('#canvas .sim-arrow').length, labels: document.querySelectorAll('#canvas .sim-label').length, text: document.getElementById('sim-pace-text').textContent })`);
    assert.equal(a.dots, 0);
    assert.ok(a.arrows > 0 && a.labels >= a.arrows, JSON.stringify(a));
    assert.match(a.text, /arrows \(reduced motion\)$/);
    // Step on: one message event at a time
    const n0 = await page.eval(`netatlas.simController().pacer.clock`);
    await page.click('#sim-step');
    await page.settle(60);
    assert.ok(await page.eval(`netatlas.simController().pacer.clock`) > n0);
    // playing: the arrows stay put for their paced time (no motion), and go
    await page.eval(`netatlas.simController().setPlaying(true), true`);
    await new Promise((r) => setTimeout(r, 600));
    const pos = await page.eval(`Array.from(document.querySelectorAll('#canvas .sim-arrow')).map((e) => e.getAttribute('d')).join('|')`);
    await new Promise((r) => setTimeout(r, 120));
    const pos2 = await page.eval(`Array.from(document.querySelectorAll('#canvas .sim-arrow')).map((e) => e.getAttribute('d')).join('|')`);
    assert.ok(pos === pos2 || pos2.split('|').some((d) => pos.split('|').indexOf(d) >= 0), 'arrows do not move');
    await page.eval(`netatlas.simController().setPlaying(false), netatlas.simController().runTo(12000), true`);
    await page.settle(80);
    const svg = await page.eval(`netatlas.exportSvg()`);
    assert.match(svg, /Protocol simulation, t = 12 s/);
    assert.doesNotMatch(svg, /class="sim-dot"|sim-tx|sim-rx/);
  } finally {
    await page.close();
  }
});

test('a device’s Simulation settings in the Actions panel: collapsed, editable during the simulation (the rest of the model locked), applied at once, undone; the setup’s parameters applied at once', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1280, height: 860 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(15000), netatlas.select('device:core1'), true`);
    await page.settle(150);
    assert.equal(await page.eval(`!!document.querySelector('#sim-act-attrs #fg-simulation') && document.querySelectorAll('#fg-simulation').length === 1`), true, 'once, in the Actions panel');
    assert.equal(await page.eval(`document.getElementById('fg-simulation').getAttribute('aria-expanded')`), 'false', 'collapsed by default');
    await page.eval(`document.getElementById('fg-simulation').scrollIntoView({ block: 'center' }), true`);
    await page.click('#fg-simulation');
    await page.settle(60);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-attr-arp_timeout').value, document.getElementById('sim-attr-arp_timeout-state').textContent, document.getElementById('sim-attr-mac_aging').value, document.getElementById('sim-attr-mac_aging').placeholder]`), ['300', 'Set on this device: 5 min. It would inherit 4 h (default — Cisco IOS (4 h); RFC 826 sets none).', '', '300']);
    await page.eval(`(() => { const i = document.getElementById('sim-attr-arp_timeout'); i.focus(); i.select(); return true; })()`);
    await page.type('45');
    await page.key('Tab', 'Tab', 9);
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /simulation: \{arp_timeout: 45\}/);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Parameter changed: ARP timeout on core1 5 min → 45 s (device)')`));
    await page.eval(`netatlas.undo(), true`);
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /simulation: \{arp_timeout: 300\}/);
    // the setup's parameters: applied at once, logged, remembered for the session
    await page.eval(`document.getElementById('sim-pw-l2-btn').click(), true`);
    await page.settle(60);
    await page.eval(`(() => { const i = document.getElementById('sim-pw-mac-aging'); i.value = '60'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Parameter changed: MAC aging time 5 min → 1 min (simulation)')`));
    assert.equal(await page.eval(`JSON.parse(sessionStorage.getItem('netatlas.sim.params'))['mac-aging']`), 60000);
    assert.equal(await page.eval(`document.getElementById('sim-pw-l2-btn').textContent`), '▸Layer 2 – Data link (7) · 1 modified');
  } finally {
    await page.close();
  }
});

test('Layers 3 and 4 on screen: a log message opens the packet inspector (keyboard); Send test from the Actions panel and from a device’s menu; the storm warning; a broadcast domain; the log by layer, cast and protocol; connections and sessions', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(30000), true`);
    await page.settle(150);
    // the lab's loop storms: the banner and the panel warn
    assert.match(await page.eval(`document.getElementById('sim-text').textContent`), /⚠ broadcast storm in VLAN 1/);
    assert.match(await page.eval(`(() => { const s = document.getElementById('sim-storm'); return s.hidden ? '' : s.textContent; })()`), /^⚠ Broadcast storm in VLAN 1 \(loop over l-lab-\w, since t = [\d.]+ s\): a Layer 2 loop that no spanning tree blocks/);
    assert.match(await page.eval(`document.getElementById('sim-shapes').textContent`), /unicast.*broadcast.*multicast/);
    // a message of the log, by keyboard: its frame as sent
    await page.eval(`(() => { const b = document.querySelector('#sim-log-table .sim-msg-btn'); b.focus(); return true; })()`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    assert.match(await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi p').textContent`), /as \S+ sent it at t = /);
    await page.key('Escape', 'Escape', 27);
    // the log by cast, layer and protocol
    await page.eval(`(() => { const s = document.getElementById('sim-log-cast'); s.value = 'broadcast'; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    const bc = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-protocol'))`);
    assert.ok(bc.length > 0 && bc.every((p) => ['arp', 'garp', 'icmp', 'udp', 'stp'].indexOf(p) >= 0), bc.join(','));
    await page.eval(`(() => { const s = document.getElementById('sim-log-cast'); s.value = ''; s.dispatchEvent(new Event('change')); const l = document.getElementById('sim-log-layer'); l.value = '4'; l.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    const l4 = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-protocol'))`);
    assert.ok(l4.length > 0 && l4.indexOf('ospf') < 0 && l4.indexOf('arp') < 0, l4.join(','));
    await page.eval(`(() => { const l = document.getElementById('sim-log-layer'); l.value = '0'; l.dispatchEvent(new Event('change')); const p = document.getElementById('sim-log-proto'); p.value = 'ospf'; p.dispatchEvent(new Event('change')); return true; })()`);
    await page.settle(80);
    const os = await page.eval(`Array.from(document.querySelectorAll('#sim-log-table tbody tr')).map((r) => r.getAttribute('data-protocol'))`);
    assert.ok(os.length > 0 && os.every((p) => p === 'ospf'), os.join(','));
    // Send test from the Actions panel: unicast, srv tcp/22 is refused (Enter in Port sends)
    await page.eval(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); }; set('sim-t-type', 'unicast'); set('sim-t-from', 'pc1'); set('sim-t-to', 'srv'); set('sim-t-kind', 'tcp'); document.getElementById('sim-t-port').focus(); return true; })()`);
    await page.type('22');
    await page.key('Enter', 'Enter', 13);
    await page.settle(80);
    // (paused: sent at the current time, it moves when the simulation plays; Send and play is offered)
    assert.match(await page.eval(`document.getElementById('sim-t-msg').textContent`), /^Sent at t = [\d.]+ s: pc1 → srv tcp\/22; see Active events\. It starts when the simulation plays\.$/);
    assert.equal(await page.eval(`document.getElementById('sim-t-sendplay').hidden`), false);
    await page.eval(`netatlas.simController().runTo(netatlas.simController().t + 3000), true`);
    await page.settle(80);
    assert.match(await page.eval(`document.querySelector('#sim-events li[data-kind="send"]').textContent`), /pc1 → srv tcp\/22.*#1 at t = [\d.]+ s: connection refused: RST from 10\.30\.0\.10 \(srv\)/);
    // Send test… from a device's menu: the Actions panel's form with it as the source, the keyboard in its To field
    await page.eval(`netatlas.simController().sendTestFrom('pc2'), true`);
    await page.settle(80);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-t-from').value, document.activeElement.id]`), ['pc2', 'sim-t-to']);
    // a broadcast domain: the lab host's
    await page.eval(`netatlas.simController().highlightDomain({ dev: 'lab-h', iface: 'eth0' }), true`);
    await page.settle(100);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#canvas .node.bc-on')).map((n) => n.getAttribute('data-ref')).sort()`), ['device:lab-h', 'device:lab-sw1', 'device:lab-sw2']);
    assert.match(await page.eval(`document.getElementById('sim-text').textContent`), /broadcast domain of lab-h:eth0 highlighted/);
    await page.eval(`netatlas.simController().clearDomain(), true`);
    // connections and a firewall's sessions, in the simulation panel
    await page.eval(`netatlas.simController().showTable('conn', 'srv'), true`);
    await page.settle(100);
    assert.ok(await page.eval(`Array.from(document.querySelectorAll('#sim-status-table tbody tr')).some((r) => r.getAttribute('data-state') === 'LISTEN')`));
    await page.eval(`netatlas.simController().showTable('fw', 'fw1'), true`);
    await page.settle(100);
    assert.match(await page.eval(`document.querySelector('#sim-status-table .st-timers').textContent`), /Default action.*Reject/);
    assert.equal(await page.eval(`netatlas.session.state.selected`), 'device:fw1', 'the table’s device is selected');
  } finally {
    await page.close();
  }
});

test('multicast on screen: Join multicast group… from a device’s menu (the Actions panel’s form), the event with Leave group, the IGMP groups, the multicast table and routes, IGMP in the inspector', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await start(page);
    await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(40000), netatlas.fit(), true`);
    await page.settle(150);
    // a host's menu: Join multicast group…, Leave group for its own groups, Start multicast stream…
    const sw = await page.rect('#canvas .node[data-ref="device:pc1"]');
    await page.mouse('mousePressed', sw.x + 10, sw.y + 10, 'left');
    await page.mouse('mouseReleased', sw.x + 10, sw.y + 10, 'left');
    await page.settle(120);
    const items = await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`);
    for (const it of ['Join multicast group…', 'Leave group 239.1.1.1', 'Start multicast stream…']) assert.ok(items.indexOf(it) >= 0, items.join('|'));
    await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).find((b) => b.textContent === 'Join multicast group…').click(), true`);
    await page.settle(120);
    assert.deepEqual(await page.eval(`[document.getElementById('sim-ne-join-toggle').getAttribute('aria-expanded'), document.getElementById('sim-j-dev').value, document.getElementById('sim-j-if').value, document.activeElement.id]`), ['true', 'pc1', 'eth0', 'sim-j-group']);
    await page.type('239.4.4.4');
    await page.eval(`document.getElementById('sim-j-go').scrollIntoView({ block: 'center' }), true`);
    await page.click('#sim-j-go');
    await page.settle(100);
    const jm = await page.eval(`[document.getElementById('sim-j-msg').textContent, document.getElementById('sim-ne-join-toggle').getAttribute('aria-expanded'), document.getElementById('sim-j-group').value]`);
    assert.match(jm[0], /^pc1:eth0 → 239\.4\.4\.4: joining at t = [\d.]+ s; see Active events\.$/);
    assert.deepEqual(jm.slice(1), ['true', '239.4.4.4'], 'the form stays as it was');
    await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 3000); c.refresh(true); return true; })()`);
    const ev = await page.eval(`(() => { const li = document.querySelector('#sim-events li[data-kind="join"]'); return li ? [li.getAttribute('data-status'), li.querySelector('.sim-ev-summary').textContent, li.querySelector('button[data-op="leave"]').textContent] : null; })()`);
    assert.equal(ev[0], 'completed');
    // (the first device that learns it: here the snooping switch's port)
    assert.match(ev[1], /^membership recorded by (\S+|\S+ \(VLAN \d+, port \S+\)) · member of 239\.4\.4\.4$/);
    assert.equal(ev[2], 'Leave group');
    await page.eval(`document.querySelector('#sim-events li[data-kind="join"] button[data-op="leave"]').click(), true`);
    await page.settle(100);
    assert.match(await page.eval(`document.querySelector('#sim-events li[data-kind="join"] .sim-ev-summary').textContent`), /not a member \(left at t = /, 'the event stays, its membership over');
    // the tables, in the simulation panel
    await page.eval(`netatlas.simController().showTable('snoop', 'acc-sw'), true`);
    await page.settle(100);
    assert.ok(await page.eval(`Array.from(document.querySelectorAll('#sim-status-table tbody tr')).some((r) => /239\.1\.1\.1/.test(r.textContent))`));
    await page.eval(`netatlas.simController().showTable('mroute', 'r1'), true`);
    await page.settle(100);
    assert.match(await page.eval(`document.getElementById('sim-status-table').textContent`), /RP for 239\.1\.1\.1: 10\.255\.0\.1 \(r1\)/);
    await page.eval(`netatlas.simController().showTable('igmp', 'core1'), true`);
    await page.settle(100);
    assert.equal(await page.eval(`document.querySelector('#sd-sttabs [aria-pressed="true"]').textContent`), 'IGMP / MLD');
    // an IGMP report in the inspector, from the log
    const seq = await page.eval(`netatlas.simController().sim.events().find((e) => e.protocol === 'igmp' && e.what === 'Report' && e.hdr).seq`);
    await page.eval(`netatlas.simController().inspectEvent(${seq}), true`);
    await page.settle(100);
    const heads = await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel[data-table="packet"] .pi-layer h4')).map((h) => h.textContent)`);
    assert.ok(heads.indexOf('Layer 3 – IGMP (2)') >= 0, heads.join(', '));
  } finally {
    await page.close();
  }
});
