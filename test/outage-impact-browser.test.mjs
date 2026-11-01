// Outage impact in the browser, with real input (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one): a model without failure domains, components found and added with the keyboard, the
// condition reviewed, Analyze impact, a changed item inspected under the outage and left again — in a narrow
// window. Then: the diagram selection prepared without running and without replacing a condition; a changed
// request marked as not applied; the model edited afterwards (a failure domain defined: an explicit edit with
// undo) leaving the result frozen and outdated; a device-pair check stopped with its coverage said. Selection,
// preparation, inspection and analysis change nothing in the model and start no simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

// h1 reaches srv over two uplinks (equal-cost static routes); a requirement says it must; no failure domain
const UPLINKS = `netatlas: 1
title: Two uplinks
devices:
  - {id: h1, type: endpoint, interfaces: [{id: e0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: r1
    type: router
    label: Access router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: a, ip: 10.0.1.1/30}, {id: b, ip: 10.0.2.1/30}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.1.2}, {prefix: 10.9.0.0/24, via: 10.0.2.2}]
  - {id: r2, type: router, interfaces: [{id: a, ip: 10.0.1.2/30}, {id: c, ip: 10.9.0.2/24}], routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]}
  - {id: r3, type: router, interfaces: [{id: b, ip: 10.0.2.2/30}, {id: c, ip: 10.9.0.3/24}], routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: srv, type: server, interfaces: [{id: e0, ip: 10.9.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.2}]}
links:
  - {id: l-h1, a: "h1:e0", b: "r1:lan"}
  - {id: up-a, a: "r1:a", b: "r2:a"}
  - {id: up-b, a: "r1:b", b: "r3:b"}
  - {id: l-r2, a: "r2:c", b: "sw:p1"}
  - {id: l-r3, a: "r3:c", b: "sw:p2"}
  - {id: l-srv, a: "srv:e0", b: "sw:p3"}
expectations:
  - {id: h1-srv, name: h1 reaches srv, expect: available, from: h1, to: srv}
`;

// two LANs of 40 hosts behind two routers: an outage of the link between them is on many device pairs' paths
const hosts = (net, sw, n) => Array.from({ length: n }, (_, i) => `  - {id: ${sw}h${i}, type: endpoint, interfaces: [{id: e0, ip: 10.${net}.0.${i + 10}/24}], routes: [{prefix: 0.0.0.0/0, via: 10.${net}.0.1}]}`).join('\n');
const ports = (n) => Array.from({ length: n + 1 }, (_, i) => `{id: p${i}, vlans: 1}`).join(', ');
const plinks = (sw, n) => Array.from({ length: n }, (_, i) => `  - {id: ${sw}l${i}, a: "${sw}h${i}:e0", b: "${sw}:p${i + 1}"}`).join('\n');
const LANS = `netatlas: 1
title: Two LANs
devices:
  - {id: ra, type: router, interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: w, ip: 10.0.0.1/30}], routes: [{prefix: 10.2.0.0/24, via: 10.0.0.2}]}
  - {id: rb, type: router, interfaces: [{id: lan, ip: 10.2.0.1/24}, {id: w, ip: 10.0.0.2/30}], routes: [{prefix: 10.1.0.0/24, via: 10.0.0.1}]}
  - {id: swa, type: switch, interfaces: [${ports(40)}]}
  - {id: swb, type: switch, interfaces: [${ports(40)}]}
${hosts(1, 'swa', 40)}
${hosts(2, 'swb', 40)}
links:
  - {id: wan, a: "ra:w", b: "rb:w"}
  - {id: la, a: "ra:lan", b: "swa:p0"}
  - {id: lb, a: "rb:lan", b: "swb:p0"}
${plinks('swa', 40)}
${plinks('swb', 40)}
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

// a real click on an element, scrolled into view first (the selector is passed as a value)
async function press(page, sel) {
  await page.call((s) => {
    const e = document.querySelector(s);
    if (!e) throw new Error('nothing matches ' + s);
    e.scrollIntoView({ block: 'center' });
    return true;
  }, sel);
  await page.settle(40);
  await page.click(sel);
}

const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`;
const STATE = `JSON.stringify({ yaml: netatlas.exportText(), sim: !!netatlas.simController() })`;

test('Outage impact: a model without failure domains — select, review, analyze, inspect, return — by keyboard in a narrow window', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 600, height: 800 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(UPLINKS)}, 'uplinks.yaml'), true`);
    await page.settle(150);
    const s0 = await page.eval(STATE);
    await page.eval(`netatlas.runCommand('analyze.outage'), true`);
    await page.settle(120);
    assert.equal(await page.eval(`document.activeElement.id`), 'oi-search');
    // no failure domain: no empty domain selector, nothing to create first
    assert.equal(await page.eval(`!!document.getElementById('oi-set')`), false);
    assert.match(await page.eval(`document.getElementById('oi-set-help').textContent`), /^Saved failure sets are optional: a failure domain is a named set of components assumed to become unavailable together/);
    assert.match(await page.eval(`document.getElementById('oi-intro').textContent`), /^Choose components to make unavailable\. Compare the modeled consequences with the architecture without this outage\. Nothing in the model is changed\.$/);
    // an exact id with Enter; a label with ↓ then Enter; similar names are never picked for you
    await page.type('up-a');
    await page.settle(60);
    await page.key('Enter', 'Enter', 13);
    await page.settle(80);
    await page.type('access');
    await page.settle(60);
    assert.match(await page.eval(`document.getElementById('oi-matches').textContent`), /r1 — Device · Access router/);
    await page.key('Enter', 'Enter', 13);
    await page.settle(60);
    assert.match(await page.eval(`document.getElementById('oi-match-status').textContent`), /Choose a match with ↑\/↓/, 'Enter on a partial name adds nothing');
    await page.key('ArrowDown', 'ArrowDown', 40);
    await page.key('Enter', 'Enter', 13);
    await page.settle(80);
    const picks = () => page.eval(`Array.from(document.querySelectorAll('#oi-condition [data-oi-pick]')).map((e) => e.getAttribute('data-oi-pick'))`);
    assert.deepEqual(await picks(), ['link:up-a', 'device:r1']);
    assert.equal(await page.eval(`document.activeElement.id`), 'oi-search', 'the keyboard stays in the picker');
    // a removable entry, by keyboard
    await page.eval(`document.querySelector('[data-oi-remove="device:r1"]').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(80);
    assert.deepEqual(await picks(), ['link:up-a']);
    assert.match(await page.eval(`document.getElementById('oi-counts').textContent`), /^1 explicitly selected component\.$/);
    assert.match(await page.eval(`document.getElementById('oi-propagation').textContent`), /a cable takes its ports down/);
    // Analyze impact (Tab-free: the button by focus and Enter)
    await page.eval(`document.getElementById('oi-go').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(200);
    assert.ok(await page.eval(visible('#oi-summary')), 'the answer is shown in the narrow window');
    const sum = await page.eval(`document.getElementById('oi-summary').textContent`);
    assert.match(sum, /^Outage: up-a/);
    assert.match(sum, /1 requirement is kept through an alternative/);
    assert.match(sum, /The model configures no dependency/);
    assert.match(sum, /Device-pair connectivity was not checked/);
    // inspect the requirement: its state without and under the outage, the outage attached to the evidence
    await press(page, '#oi-result .an-pick[data-an-item="wexp:h1-srv"]');
    await page.settle(150);
    const ev = await page.eval(`({ kind: document.getElementById('an-detail').getAttribute('data-ev-kind'), ctx: document.querySelector('#ws-an-right [data-an-ev-ctx]').textContent, text: document.getElementById('an-detail').textContent, shown: ${visible('#an-detail')} })`);
    assert.equal(ev.kind, 'Requirement');
    assert.match(ev.ctx, /Hypothetical outage: up-a/);
    assert.match(ev.text, /Without the outage[\s\S]*Under the outage/);
    assert.ok(ev.shown);
    // return: Escape lets the evidence go, the keyboard back on what opened it
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal(await page.eval(`netatlas.analyzeSelection()`), '');
    assert.equal(await page.eval(STATE), s0, 'nothing changed in the model, no simulation started');
  } finally {
    await page.close();
  }
});

test('Outage impact: the selection prepared, never run or replacing; a changed request not applied; an edit afterwards leaves the result frozen; Stop says the coverage', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(UPLINKS)}, 'uplinks.yaml'), true`);
    await page.settle(150);
    const s0 = await page.eval(STATE);
    // the contextual action: prepared, not analyzed
    await page.eval(`netatlas.select('link:up-a', true), true`);
    await page.eval(`netatlas.runCommand('analyze.outage-selection'), true`);
    await page.settle(120);
    assert.deepEqual([await page.eval(`netatlas.analyzeMode()`), await page.eval(`netatlas.analysisHistory().length`), await page.eval(`!!document.getElementById('oi-summary')`)], ['outage', 0, false]);
    assert.equal(await page.eval(`document.activeElement.id`), 'oi-go');
    await press(page, '#oi-go');
    await page.settle(150);
    const first = await page.eval(`document.getElementById('oi-summary').textContent`);
    // another selection while a condition exists: offered, the condition kept until you choose
    await page.eval(`netatlas.select('link:up-b', true), netatlas.runCommand('analyze.outage-selection'), true`);
    await page.settle(120);
    assert.ok(await page.eval(`!!document.getElementById('oi-offer')`), 'the prepared component is offered');
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#oi-condition [data-oi-pick]')).map((e) => e.getAttribute('data-oi-pick'))`), ['link:up-a']);
    assert.equal(await page.eval(`netatlas.analysisHistory().length`), 1, 'nothing analyzed');
    await press(page, '#oi-offer [data-oi-offer="add"]');
    await page.settle(100);
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('#oi-condition [data-oi-pick]')).map((e) => e.getAttribute('data-oi-pick'))`), ['link:up-a', 'link:up-b']);
    // the request changed: marked as not applied; the old result is the old condition's
    assert.match(await page.eval(`document.querySelector('#ws-an-left [data-an-draft]').textContent`), /not applied yet/);
    assert.equal(await page.eval(`document.getElementById('oi-summary').textContent`), first);
    await press(page, '#oi-go');
    await page.settle(150);
    assert.match(await page.eval(`document.getElementById('oi-summary').textContent`), /^Outage: up-a, up-b.*1 requirement is no longer satisfied/);
    assert.equal(await page.eval(`!!document.querySelector('#ws-an-left [data-an-draft]')`), false);
    assert.equal(await page.eval(STATE), s0, 'preparation and analysis changed nothing');
    // a failure domain defined afterwards: an explicit model edit (undo), the result frozen and outdated
    const before = await page.eval(`document.getElementById('oi-summary').textContent`);
    await press(page, '#dom-config');
    await page.settle(100);
    await press(page, '#dom-add');
    await page.eval(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set('dom-f-label', 'Uplinks'); set('dom-f-members', 'up-a, up-b'); return true; })()`);
    await press(page, '#an-ed-save');
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /failure_domains:/);
    assert.ok(await page.eval(`!!document.querySelector('#ws-an-left .an-outdated')`), 'outdated');
    assert.equal(await page.eval(`document.getElementById('oi-summary').textContent`), before, 'frozen, not computed again');
    // the saved set: an optional shortcut, its members shown before analysis
    await page.eval(`netatlas.undo(), true`);
    await page.settle(100);
    assert.equal(JSON.parse(await page.eval(STATE)).yaml, JSON.parse(s0).yaml, 'undo removes the domain');
    // a device-pair check in slices: Stop ends it, the coverage says how far it got
    await page.eval(`netatlas.loadText(${JSON.stringify(LANS)}, 'lans.yaml'), netatlas.prepareOutage(['link:wan']), true`);
    await page.settle(120);
    await page.eval(`(() => { const r = document.getElementById('oi-reach'); r.value = 'entire'; r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.settle(80);
    assert.match(await page.eval(`document.getElementById('oi-pairs').textContent`), /^Traces 1\d{3} of 6\d{3} device pairs \(the limit\)/);
    const stopped = await page.eval(`(() => { netatlas.runOutage(); const b = document.getElementById('oi-stop'); if (b) b.click(); const c = document.querySelector('#oi-reach-res .an-coverage').textContent; return { stopped: !!b, c }; })()`);
    if (stopped.stopped) assert.match(stopped.c, /^Checked \d+ of \d+ device pairs \(stopped before the end\)/);
    else assert.match(stopped.c, /^Checked \d+ of \d+ device pairs \(a limit was reached\)/);
    assert.match(await page.eval(`document.getElementById('oi-summary').textContent`), /device pairs? loses? reachability \(Checked/);
  } finally {
    await page.close();
  }
});
