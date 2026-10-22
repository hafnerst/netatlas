// Exit simulation by every route, with real input (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): Esc, the banner's
// button, the simulation panel's Exit, the Simulate menu and the command
// palette; closing and replacing the model during a simulation. After each:
// no "Editing is paused" notice and no disabled Exit simulation button
// remain, the form is editable (no read-only fieldset, the outline's Add
// buttons enabled), the Objects list and the Inspector are back with the
// tab and the selection, and every simulation-only part is gone (the
// layout, the panel, the border and label, the banner, the tables and the
// packet inspector).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** What is on screen now: the notice, the lock, the layout, the simulation-only parts. */
const STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const vis = (s) => { const e = q(s); return !!e && !e.hidden && e.getClientRects().length > 0; };
  const side = q('#side-body');
  return {
    sim: netatlas.simulationOn(),
    notice: document.querySelectorAll('.lock-note').length,
    exitInSide: side ? side.querySelectorAll('[data-command="sim.exit"]').length : -1,
    disabledExit: Array.from(document.querySelectorAll('#side-body [data-command="sim.exit"], #outline [data-command="sim.exit"]')).filter((b) => b.disabled).length,
    lockedForm: side ? side.querySelectorAll('fieldset[disabled]').length : -1,
    editable: side ? side.querySelectorAll('input:not([disabled]), select:not([disabled])').length : 0,
    addDisabled: Array.from(document.querySelectorAll('#outline [data-act="add-entity"]')).filter((b) => b.disabled).length,
    addButtons: document.querySelectorAll('#outline [data-act="add-entity"]').length,
    tab: (q('#side .tabs .active') || { getAttribute: () => '' }).getAttribute('data-tab'),
    tabsShown: vis('#side .tabs'),
    outlineShown: vis('#outline-body'),
    selected: netatlas.session ? netatlas.session.state.selected : null,
    dataSim: document.body.getAttribute('data-sim'),
    mode: document.body.getAttribute('data-mode') || '',
    dock: vis('#sim-dock'), setup: vis('#sim-setup'), actions: vis('#sim-actions'),
    banner: vis('#mb-sim'), badge: vis('.sim-badge'),
    tables: document.querySelectorAll('.sim-table-panel').length,
    dots: document.querySelectorAll('#canvas .layer-sim, #canvas .layer-sim-labels').length,
    lock: netatlas.editLock(),
  };
})()`;

/** Nothing of the simulation is left, and editing is back (the tab as given). */
function assertBack(s, tab, sel, how) {
  const at = `${how}: ${JSON.stringify(s)}`;
  assert.equal(s.sim, false, at);
  assert.equal(s.notice, 0, 'no notice: ' + at);
  assert.equal(s.exitInSide, 0, 'no Exit simulation in the Inspector: ' + at);
  assert.equal(s.disabledExit, 0, at);
  assert.equal(s.lockedForm, 0, 'no read-only form: ' + at);
  assert.equal(s.lock, '', at);
  assert.equal(s.addDisabled, 0, 'the outline can add again: ' + at);
  assert.ok(s.addButtons > 0, at);
  assert.equal(s.tab, tab, 'the tab as before: ' + at);
  assert.ok(s.tabsShown && s.outlineShown, 'the Objects list and the Inspector: ' + at);
  if (sel !== undefined) assert.equal(s.selected, sel, 'the selection: ' + at);
  if (tab === 'edit') assert.ok(s.editable > 0, 'the Edit form takes input: ' + at);
  assert.equal(s.dataSim, null, at);
  assert.ok(!/simulation/.test(s.mode), 'no simulation mode (border, label): ' + at);
  assert.ok(!s.dock && !s.setup && !s.actions && !s.banner && !s.badge, 'no panel, setup, actions, banner or label: ' + at);
  assert.equal(s.tables, 0, 'no device table or packet inspector: ' + at);
  assert.equal(s.dots, 0, 'no dots: ' + at);
}

async function start(page, tab) {
  await page.call((tab) => { netatlas.select('device:core1'); netatlas.showTab(tab); return true; }, tab);
  await page.settle(120);
  await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(20000); c.showTable('arp', 'core1'); c.refresh(true); return true; })()`);
  await page.settle(150);
  const s = await page.eval(STATE);
  assert.equal(s.sim, true);
  // a packet inspector open as well: it goes with the simulation
  await page.eval(`(() => { const c = netatlas.simController(); const f = c.sim.engine.flights.find((x) => !!x.hdr); return f ? c.inspectFlight(f.id, { x: 400, y: 200, w: 10, h: 10 }) : false; })()`);
  await page.settle(100);
}

test('Exit simulation by Esc, the banner, the panel, the menu and the palette: no notice, editable, the tab and selection back, nothing of the simulation left', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = 'protocol-simulation.yaml';
    await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), true`);
    await page.settle(150);
    const routes = [
      ['Esc', 'edit', async () => {
        await page.eval(`document.getElementById('canvas').focus(), true`);
        await page.key('Escape', 'Escape', 27);
        // (the first Esc closes the packet inspector, the next one exits)
        if (await page.eval('netatlas.simulationOn()')) await page.key('Escape', 'Escape', 27);
        if (await page.eval('netatlas.simulationOn()')) await page.key('Escape', 'Escape', 27);
      }],
      ['the banner', 'edit', async () => page.click('#sim-exit-banner')],
      ['the simulation panel', 'details', async () => page.click('#sim-exit')],
      ['the Simulate menu', 'edit', async () => {
        await page.click('#simulate-btn');
        await page.click('#btn-sim-exit');
      }],
      ['the command palette', 'yaml', async () => {
        await page.key('k', 'KeyK', 75, 2);
        await page.settle(120);
        await page.type('Exit simulation');
        await page.settle(120);
        await page.key('Enter', 'Enter', 13);
      }],
    ];
    for (const [how, tab, exit] of routes) {
      await start(page, tab);
      await exit();
      await page.settle(150);
      assertBack(await page.eval(STATE), tab, 'device:core1', how);
      // and editing works at once (Edit tab): the label field takes a value
      if (tab === 'edit') {
        const before = await page.eval('netatlas.exportText()');
        await page.eval(`(() => { const i = Array.from(document.querySelectorAll('#side-body input[data-p]')).find((x) => x.getAttribute('data-p').endsWith(',"label"]') && !x.disabled); i.focus(); i.value = i.value + 'x'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await page.settle(100);
        assert.notEqual(await page.eval('netatlas.exportText()'), before, `${how}: an edit is applied`);
        await page.eval('netatlas.undo(), true');
        await page.settle(80);
      }
    }
  } finally {
    await page.close();
  }
});

test('closing or replacing the model during a simulation: the simulation ends with nothing of it left; the next model is editable', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.settle(150);
    const ex = 'protocol-simulation.yaml';
    // replacing it: another example
    await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), true`);
    await page.settle(150);
    await start(page, 'edit');
    await page.eval(`netatlas.loadExample(0), true`);
    await page.settle(200);
    await page.eval(`netatlas.select('device:hq-rtr1'), netatlas.showTab('edit'), true`);
    await page.settle(150);
    assertBack(await page.eval(STATE), 'edit', 'device:hq-rtr1', 'replaced by another model');
    // closing it: the start screen, then a model again
    await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(ex)}), true`);
    await page.settle(150);
    await start(page, 'edit');
    await page.eval(`netatlas.closeModel ? netatlas.closeModel() : document.getElementById('btn-close').click(), true`);
    await page.settle(200);
    const closed = await page.eval(STATE);
    assert.equal(closed.sim, false);
    assert.equal(closed.notice, 0);
    assert.equal(closed.dataSim, null);
    assert.ok(!closed.dock && !closed.banner && !closed.badge && closed.tables === 0, JSON.stringify(closed));
    await page.eval(`netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.select('device:core1'), netatlas.showTab('edit'), true`);
    await page.settle(150);
    assertBack(await page.eval(STATE), 'edit', 'device:core1', 'closed, then opened again');
  } finally {
    await page.close();
  }
});
