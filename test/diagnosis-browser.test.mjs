// The diagnosis with real input (headless Chrome/Edge/Chromium through the DevTools protocol; skipped without one):
// Shift+D on a selected device diagnoses its client application's communication at once with the keyboard on the
// answer; Tab reaches its evidence and next actions; leaving Analyze restores the workspace and the selection; in a
// narrow window the diagnosis wraps (no horizontal scroll). Not a full accessibility audit: these checks only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const MODEL = `netatlas: 1
title: Diagnosis
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.1.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]
    services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web", interval: 5s}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    policy:
      default: permit
      rules:
        - {action: deny, proto: tcp, dport: 80}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.0.2.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]
    services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}]}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
`;

async function waitReady(page) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (await page.eval(`document.readyState === 'complete' && !!window.netatlas`)) return;
    } catch (e) {
      /* navigating */
    }
  }
}

const ST = `({ ws: netatlas.workspace(), tool: netatlas.analyzeTool(), active: document.activeElement.id, inDiag: !!document.activeElement.closest('#diag'), state: (document.getElementById('diag') || { getAttribute: () => null }).getAttribute('data-state'), sel: netatlas.session ? netatlas.session.state.selected : null })`;

test('Shift+D with real keys: the selected device’s client application is diagnosed at once, the keyboard on the answer; Tab reaches its evidence; leaving Analyze keeps the selection', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(MODEL)}, "diagnosis.yaml"), true`);
    await page.settle(150);
    await page.eval(`netatlas.select('device:pc', true), document.getElementById('canvas').focus(), true`);
    await page.key('D', 'KeyD', 68, 8);
    await page.settle(200);
    const st = await page.eval(ST);
    assert.deepEqual([st.ws, st.tool, st.active, st.state], ['analyze', 'trace', 'diag-summary', 'blocked'], JSON.stringify(st) + ' ' + (await page.eval(`JSON.stringify([netatlas.currentTrace().check.request, netatlas.currentTrace().check.headline, netatlas.currentTrace().check.info.context])`)));
    assert.match(await page.eval(`document.getElementById('diag-question').textContent`), /pc:eth0 · 10\.0\.1\.10/);
    // Tab: from the answer into its evidence (a link to the rule or the device) and its next actions
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.key('Tab', 'Tab', 9);
      reached = await page.eval(`!!document.activeElement.closest('#diag') && document.activeElement.tagName === 'BUTTON'`);
    }
    assert.ok(reached, 'Tab reaches a button of the diagnosis');
    // Enter on a piece of evidence selects it; the workspace stays
    await page.eval(`(document.querySelector('#diag [data-diag-ref^="device:"]') || document.querySelector('#diag [data-diag-ref]')).focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(100);
    const after = await page.eval(ST);
    assert.equal(after.ws, 'analyze');
    assert.match(String(after.sel), /^device:/, 'the evidence’s object is selected');
    await page.eval(`netatlas.runCommand('ws.exit'), true`);
    await page.settle(150);
    const out = await page.eval(ST);
    assert.equal(out.ws, 'edit');
    assert.equal(out.sel, after.sel, 'the selection is kept');
  } finally {
    await page.close();
  }
});

test('the diagnosis in a narrow window wraps: no horizontal scroll of the page or of the diagnosis', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 390, height: 844 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(MODEL)}, "diagnosis.yaml"), netatlas.select('device:pc', true), netatlas.runCommand('analyze.diagnose'), true`);
    await page.settle(250);
    const m = await page.eval(`(() => { const d = document.getElementById('diag'); return d ? { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, own: d.scrollWidth - d.clientWidth, w: Math.round(d.getBoundingClientRect().width) } : null; })()`);
    assert.ok(m, 'the diagnosis is shown');
    assert.ok(m.page <= 0, `the page scrolls sideways by ${m.page} px`);
    assert.ok(m.own <= 1, `the diagnosis scrolls sideways by ${m.own} px (width ${m.w})`);
  } finally {
    await page.close();
  }
});

test('a hop’s object in the Analyze bottom panel is a working link: it selects the object (it did nothing before)', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadExampleNamed('enterprise-wan.yaml'), netatlas.setTraceForm({ from: 'muc-rtr:lan0', to: 'hq-log' }), netatlas.runTrace(), true`);
    await page.settle(300);
    const r = await page.eval(`(() => { const b = document.querySelector('#ws-an-dock button.ref[data-goto]'); if (!b) return null; b.click(); return { ref: b.getAttribute('data-goto'), sel: netatlas.session.state.selected, ws: netatlas.workspace() }; })()`);
    assert.ok(r, 'the bottom panel has object links');
    assert.equal(r.sel, r.ref);
    assert.equal(r.ws, 'analyze');
  } finally {
    await page.close();
  }
});
