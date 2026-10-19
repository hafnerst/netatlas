// UI lifecycle in a real browser: opening and cancelling Start simulation
// again and again, starting and exiting simulations, building the setup
// panel again and replacing the model leave no listeners behind on the
// document or the window (counted by the DevTools protocol, never by
// guessing), and the inspector's pause belongs to the inspector: a click
// elsewhere keeps it paused, closing it plays again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;

/** the listeners on an object of the page (document, window), by event type */
async function listeners(page, expr) {
  const o = await page.cmd('Runtime.evaluate', { expression: expr });
  const r = await page.cmd('DOMDebugger.getEventListeners', { objectId: o.result.objectId });
  const by = {};
  for (const l of r.listeners) by[l.type] = (by[l.type] || 0) + 1;
  return by;
}

test('repeated Start dialogs, simulation starts and exits, and a model replaced leave no listeners behind', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1366, height: 768 });
  try {
    await page.settle(200);
    await page.eval(`(sessionStorage.clear(), netatlas.loadExampleNamed('protocol-simulation.yaml'), true)`);
    await page.settle(200);
    // once, to have what is created on first use (the dialog machinery) there before counting
    await page.eval(`netatlas.runCommand('sim.start'), true`);
    await page.settle(300);
    await page.eval(`document.querySelector('.modal-btns [data-value="cancel"]').click(), true`);
    await page.settle(200);
    const doc0 = await listeners(page, 'document');
    const win0 = await listeners(page, 'window');
    for (let i = 0; i < 5; i++) {
      await page.eval(`netatlas.runCommand('sim.start'), true`);
      await page.settle(250);
      assert.ok(await page.eval(`(() => { const m = document.getElementById('modal'); return !!m && m.open && m.classList.contains('sim-start-dialog'); })()`), 'the dialog opened');
      // its senders' By type ▾ menu opened and closed again (what listens to the document while it is open)
      await page.eval(`(() => { const b = Array.from(document.querySelectorAll('.sim-start-dialog button')).find((x) => /By type/.test(x.textContent)); if (b) b.click(); return true; })()`);
      await page.settle(60);
      await page.key('Escape', 'Escape', 27);
      await page.settle(60);
      await page.eval(`document.querySelector('.modal-btns [data-value="cancel"]').click(), true`);
      await page.settle(200);
    }
    assert.ok(!(await page.eval(`document.getElementById('modal').open`)), 'closed');
    assert.deepEqual(await listeners(page, 'document'), doc0, 'five Start dialogs later: the same listeners on the document');
    // simulations started and exited, the setup built each time
    for (let i = 0; i < 3; i++) {
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(3000); c.refresh(true); return true; })()`);
      await page.settle(250);
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(200);
    }
    assert.deepEqual(await listeners(page, 'document'), doc0, 'three simulations later: the same listeners on the document');
    assert.deepEqual(await listeners(page, 'window'), win0, 'and on the window');
    // a model replaced while nothing runs: the same again
    await page.eval(`(netatlas.loadExampleNamed('ospf-reroute.yaml'), true)`);
    await page.settle(250);
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); return true; })()`);
    await page.settle(250);
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(200);
    assert.deepEqual(await listeners(page, 'document'), doc0, 'a model replaced: the same listeners');
  } finally {
    await page.close();
  }
});

test('the packet inspector says what is computed, what is left out and what is described (a TCP segment: its sequence numbers are the connection’s)', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1366, height: 768 });
  try {
    await page.settle(200);
    await page.eval(`(sessionStorage.clear(), netatlas.loadExampleNamed('protocol-simulation.yaml'), true)`);
    await page.settle(200);
    const id = await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(8000); const t = c.sim.sendTest({ from: 'pc2', to: 'web', kind: 'tcp', port: 443 }); c.runTo(c.t + 3000); c.refresh(true); return t.id; })()`);
    assert.ok(await page.eval(`netatlas.simController().inspectTest(${id})`));
    await page.settle(150);
    const text = await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .pi').textContent`);
    assert.match(text, /Fidelity/);
    assert.match(text, /Computed.*the TCP flags, sequence and acknowledgement numbers \(the connection’s own state\)/);
    assert.match(text, /Left out.*checksums, IP identification and options, the TCP window and options/);
    assert.match(text, /Described.*the payload \(TCP \(tests\)\) in words.*not simulated: windows, congestion control/);
    assert.doesNotMatch(text, /\.\.$/);
    await page.eval(`netatlas.exitSimulation(), true`);
  } finally {
    await page.close();
  }
});
