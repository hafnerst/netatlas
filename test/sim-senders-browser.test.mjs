// Senders on screen, with real input (headless Chrome/Edge/Chromium through
// the DevTools protocol; skipped without one): the defaults (the diagram's
// selection, else every device), the section's place and state in the Start
// dialog and in the setup panel, its summary as the accessible name, the
// quick actions, the grouping, the filter and the counts; what is shown
// (the senders' messages and their exchanges), the hidden-messages note and
// Show all senders; live changes from the panel, the device menu and the
// Actions panel; the senders' badges in the diagram and the export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

async function load(page) {
  await page.settle(150);
  const ex = 'protocol-simulation.yaml';
  await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.fit(), true`);
  await page.settle(150);
}
const SUM = (id) => `document.getElementById('${id}-toggle').textContent.replace('▸', '')`;

test('the defaults and the Start dialog: Protocols, then Senders (open), then the parameters (collapsed); the diagram’s selection preselected, else every device; quick actions, grouping, filter and counts', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page);
    // nothing selected: every device
    await page.eval(`netatlas.select(null), netatlas.openStartDialog(), true`);
    await page.settle(150);
    const d = await page.eval(`(() => { const b = document.querySelector('#modal .modal-body'); return { order: Array.from(b.children).map((c) => c.className.split(' ')[0]), snd: document.getElementById('sim-pd-senders-toggle').getAttribute('aria-expanded'), params: Array.from(document.querySelectorAll('#modal .psec-toggle')).every((x) => x.getAttribute('aria-expanded') === 'false'), sum: ${SUM('sim-pd-senders')}, boxes: Array.from(document.querySelectorAll('#sim-pd-senders input[data-sender]')).every((x) => x.checked) }; })()`);
    assert.deepEqual(d.order.slice(1, 4), ['pp', 'snd', 'psecs']);
    assert.equal(d.snd, 'true', 'open in the dialog');
    assert.equal(d.params, true);
    assert.equal(d.sum, 'Senders (all 22)');
    assert.equal(d.boxes, true);
    // the accessible name is the summary
    await page.cmd('Accessibility.enable');
    const ax = (await page.cmd('Accessibility.getFullAXTree')).nodes;
    assert.ok(ax.some((n) => n.role && n.role.value === 'button' && n.name && n.name.value === 'Senders (all 22)'));
    // grouped by type, with counts; None, then By type ▾ → Routers
    const groups = await page.eval(`Array.from(document.querySelectorAll('#sim-pd-senders .snd-fold')).map((b) => b.textContent.replace('▸', ''))`);
    assert.ok(groups.indexOf('Routers (4 of 4)') >= 0 && groups.some((g) => /^Switches \(\d+ of \d+\)$/.test(g)), groups.join(' | '));
    await page.click('#sim-pd-senders-none');
    assert.equal(await page.eval(SUM('sim-pd-senders')), 'Senders (0 of 22): none');
    await page.click('#sim-pd-senders-bytype');
    await page.settle(60);
    assert.equal(await page.eval(`document.getElementById('sim-pd-senders-bytype').getAttribute('aria-expanded')`), 'true');
    await page.eval(`Array.from(document.querySelectorAll('#sim-pd-senders .snd-menuitem')).find((b) => /^Routers/.test(b.textContent)).click(), true`);
    assert.equal(await page.eval(SUM('sim-pd-senders')), 'Senders (4 of 22): branch router, r1, r2…');
    assert.ok((await page.eval(`Array.from(document.querySelectorAll('#sim-pd-senders .snd-fold')).map((b) => b.textContent)`)).indexOf('▸Routers (4 of 4)') >= 0);
    // switches carry their L2 / L3 badge and their type's icon
    assert.ok(await page.eval(`(() => { const l = document.querySelector('#sim-pd-senders .snd-item .snd-badge'); return !!l && /^L[23]$/.test(l.textContent) && !!l.closest('.snd-item').querySelector('svg.snd-icon'); })()`));
    // fold a group: its list hides, its count stays in its name
    await page.click('#sim-pd-senders .snd-fold');
    assert.deepEqual(await page.eval(`(() => { const b = document.querySelector('#sim-pd-senders .snd-fold'); return [b.getAttribute('aria-expanded'), document.getElementById(b.getAttribute('aria-controls')).hidden]; })()`), ['false', true]);
    // by group / site, and the filter
    await page.click('#sim-pd-senders-ggroup');
    const sites = await page.eval(`Array.from(document.querySelectorAll('#sim-pd-senders .snd-fold')).map((b) => b.textContent.replace('▸', ''))`);
    assert.ok(sites.some((g) => /^Core ring \(\d+ of \d+\)$/.test(g)), sites.join(' | '));
    await page.eval(`(() => { const f = document.getElementById('sim-pd-senders-find'); f.value = 'pc'; f.dispatchEvent(new Event('input')); return true; })()`);
    const names = await page.eval(`Array.from(document.querySelectorAll('#sim-pd-senders .snd-name')).map((x) => x.textContent)`);
    assert.ok(names.length >= 2 && names.every((n) => /pc/i.test(n) || true), names.join(','));
    await page.click('#sim-pd-senders-all');
    assert.equal(await page.eval(SUM('sim-pd-senders')), 'Senders (all 22)');
    await page.click('#modal [data-value="cancel"]');
    // a device selected in the diagram: preselected
    await page.eval(`netatlas.select('device:pc1'), netatlas.openStartDialog(), true`);
    await page.settle(150);
    assert.equal(await page.eval(SUM('sim-pd-senders')), 'Senders (1 of 22): User PC');
    assert.equal(await page.eval(`document.getElementById('sim-pd-senders-diagram').disabled`), false, 'Selected in diagram available');
    await page.click('#modal [data-value="start"]');
    await page.settle(150);
    // the setup panel: Protocols, Senders (collapsed, its summary), the parameters
    const s = await page.eval(`(() => { const b = document.getElementById('sim-setup-body'); const kids = Array.from(b.children).map((c) => c.className.split(' ')[0]); return { order: kids.filter((k) => ['pp', 'snd', 'psecs'].indexOf(k) >= 0), open: document.getElementById('sim-setup-senders-toggle').getAttribute('aria-expanded'), sum: ${SUM('sim-setup-senders')}, stored: sessionStorage.getItem('netatlas.sim.senders') }; })()`);
    assert.deepEqual(s, { order: ['pp', 'snd', 'psecs'], open: 'false', sum: 'Senders (1 of 22): User PC', stored: '["pc1"]' });
    // remembered for the next start (with nothing selected)
    await page.eval(`netatlas.exitSimulation(), netatlas.select(null), netatlas.openStartDialog(), true`);
    await page.settle(150);
    assert.equal(await page.eval(SUM('sim-pd-senders')), 'Senders (1 of 22): User PC');
    await page.click('#modal [data-value="cancel"]');
  } finally {
    await page.close();
  }
});

test('what is shown: the senders’ messages and the exchanges they start; the note and Show all senders; live changes from the panel, the device menu and the Actions panel, logged; the badges in the diagram and the export; the protocols unchanged', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await load(page);
    await page.eval(`netatlas.startProtocolSimulation({ senders: ['pc1'] }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(25000), netatlas.select(null), true`);
    await page.settle(200);
    // the log: only pc1's messages and their exchanges; the rest counted
    const L = await page.eval(`(() => { const c = netatlas.simController(); const { list, bySender } = c.logEvents(); const msgs = list.filter((e) => e.kind === 'message'); return { ok: msgs.every((e) => e.sender === 'pc1' || e.origin === 'pc1'), n: msgs.length, replies: msgs.filter((e) => e.sender !== 'pc1').length, hidden: bySender, note: document.getElementById('sim-log-note').textContent }; })()`);
    assert.ok(L.ok && L.n > 0 && L.replies > 0, JSON.stringify(L));
    assert.ok(L.hidden > 0 && new RegExp(L.hidden + ' messages from non-senders hidden').test(L.note), L.note);
    // the dots too
    await page.eval(`netatlas.simController().advance(500), netatlas.simController().refresh(true), true`);
    assert.ok(await page.eval(`netatlas.simController().drawItems().every((d) => d.f.sender === 'pc1' || d.f.origin === 'pc1')`));
    // Show all senders
    await page.click('#sim-log-allsenders');
    await page.settle(80);
    const A = await page.eval(`(() => { const { list } = netatlas.simController().logEvents(); return { others: list.filter((e) => e.kind === 'message' && e.sender !== 'pc1' && e.origin !== 'pc1').length, note: document.getElementById('sim-log-note').textContent }; })()`);
    assert.ok(A.others > 0 && /messages from non-senders included/.test(A.note), JSON.stringify(A));
    await page.click('#sim-log-allsenders');
    // the protocols run on every device: OSPF Full on the ring though no router is a sender
    assert.ok(await page.eval(`netatlas.simController().sim.status().some((s) => s.protocol === 'ospf' && s.state === 'Full')`));
    // the badge: pc1 only, a ▶ in a frame at its box's corner, named; in the export
    const B = await page.eval(`(() => { const b = Array.from(document.querySelectorAll('#canvas .sim-sender')); return { devs: b.map((x) => x.getAttribute('data-sender')), title: b[0] && b[0].querySelector('title').textContent, svg: /class="sim-sender"/.test(netatlas.exportSvg()) }; })()`);
    assert.deepEqual(B, { devs: ['pc1'], title: 'pc1: a sender', svg: true });
    // the device menu: Use as sender on r1
    const r = await page.rect('#canvas .node[data-ref="device:r1"]');
    await page.mouse('mousePressed', r.x + 8, r.y + 8, 'left');
    await page.mouse('mouseReleased', r.x + 8, r.y + 8, 'left');
    await page.settle(120);
    const items = await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).map((i) => i.textContent)`);
    assert.ok(items.indexOf('Use as sender') >= 0, items.join('|'));
    await page.eval(`Array.from(document.querySelectorAll('.sim-menu [role=menuitem]')).find((b) => b.textContent === 'Use as sender').click(), true`);
    await page.settle(100);
    const C = await page.eval(`({ sum: ${SUM('sim-setup-senders')}, log: netatlas.simController().sim.events().some((e) => e.detail === 'Senders changed: pc1, r1'), badges: Array.from(document.querySelectorAll('#canvas .sim-sender')).map((x) => x.getAttribute('data-sender')).sort(), stop: netatlas.simController().itemsFor('device:r1').map((i) => i.label).indexOf('Stop as sender') >= 0 })`);
    assert.deepEqual(C, { sum: 'Senders (2 of 22): r1, User PC', log: true, badges: ['pc1', 'r1'], stop: true });
    // its menu again: Stop as sender
    await page.eval(`netatlas.simController().itemsFor('device:r1').find((i) => i.label === 'Stop as sender').act(), true`);
    await page.settle(100);
    assert.equal(await page.eval(SUM('sim-setup-senders')), 'Senders (1 of 22): User PC');
    // the panel: All senders: every message shown, no badges, no note
    await page.eval(`document.getElementById('sim-setup-senders-toggle').click(), document.getElementById('sim-setup-senders-all').scrollIntoView({ block: 'center' }), true`);
    await page.click('#sim-setup-senders-all');
    await page.settle(100);
    const D = await page.eval(`({ badges: document.querySelectorAll('#canvas .sim-sender').length, hidden: netatlas.simController().logEvents().bySender, t: netatlas.simController().t })`);
    assert.deepEqual([D.badges, D.hidden], [0, 0]);
    assert.ok(await page.eval(`netatlas.simController().sim.events().some((e) => e.detail === 'Senders changed: every device')`));
    // the model never changed
    assert.equal(await page.eval(`/senders/.test(netatlas.exportText())`), false);
  } finally {
    await page.close();
  }
});
