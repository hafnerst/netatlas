// The diagnosis workflow with real input (headless Chrome/Edge/Chromium through the DevTools protocol; skipped without
// one): a client application's own run diagnosed and compared (never a send prepared like it); its evidence links open
// the exact record — the policy rule in place, the decision's packet in the inspector, focus back on the link after
// Escape — with no side effect (the clock, the actions, the model and its lock unchanged); a link of an earlier
// simulation said unavailable; a finished failure whose cause is not established labelled so; a series' distinct causes
// each with its messages; an MQTT run's legs from its own publications; a narrow window in both themes; leaving
// Analyze and coming back keeps the result as it was. Not a full accessibility audit: these checks only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

// pc's application asks srv/web over TCP 80; fw rejects it (rule 1) with a RST carrying srv's address
const APP = `netatlas: 1
title: Diagnosis workflow
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.1.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]
    services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web"}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    simulation: {default_action: reject}
    policy:
      default: permit
      rules:
        - {action: deny, proto: tcp, dport: 80}
        - {action: permit, proto: icmp}
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

const START = `(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(5000); c.refresh(true); return true; })()`;
// what must not change when evidence is prepared or followed: the clock, the operations, the model, its lock
const STATE = `(() => { const c = netatlas.simController(); return JSON.stringify({ t: c ? c.sim.now : null, acts: c ? c.sim.actionCount : null, runs: c ? c.sim.apps.runs.length : null, lock: netatlas.editLock(), model: netatlas.session.model === window.__m0 }); })()`;

test('an application’s own run: diagnosed and compared as that run; its rule and decision open exactly, without side effects; an earlier simulation’s link is unavailable', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(APP)}, "workflow.yaml"), window.__m0 = netatlas.session.model, true`);
    await page.settle(150);
    await page.eval(START);
    await page.settle(200);
    await page.eval(`netatlas.select('device:pc', true), netatlas.runCommand('analyze.diagnose'), true`);
    await page.settle(250);
    assert.equal(await page.eval(`document.getElementById('diag') ? document.getElementById('diag').getAttribute('data-state') : null`), 'blocked', 'statically: the rule denies it');
    // Prepare in simulation: nothing sent, the clock and the model as they were
    const s0 = await page.eval(STATE);
    await page.eval(`document.querySelector('#diag [data-diag-act="handoff"]').click(), true`);
    await page.settle(150);
    assert.equal(await page.eval(STATE), s0, 'preparing changes nothing');
    // its own run, then a send prepared like it: the comparison takes the application's run
    await page.eval(`(() => { const c = netatlas.simController(); const a = c.sim.actApp('pc', 'get', 'event'); if (a.error) throw new Error(a.error); c.runTo(c.sim.now + 6000); c.sim.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' }); c.runTo(c.sim.now + 6000); c.refresh(true); return true; })()`);
    await page.settle(150);
    await page.eval(`document.querySelector('#diag [data-diag-act="compare"]').click(), true`);
    await page.settle(200);
    const q = await page.eval(`document.getElementById('diag-question').textContent`);
    assert.match(q, /Runtime\s*application run #\d+ of pc\/get \(started from Network events/);
    const rt = await page.eval(`(() => { const e = document.getElementById('diag-runtime'); return [e.getAttribute('data-completed'), e.getAttribute('data-outcome'), e.getAttribute('data-cause'), document.getElementById('diag-state').textContent]; })()`);
    assert.deepEqual(rt, ['true', 'failed', 'established', '✕ Blocked']);
    const text = await page.eval(`document.getElementById('diag-blockers').textContent`);
    assert.match(text, /fw refused the connection: its policy rejected it \(rule 1/i);
    assert.ok(!/nothing listens/.test(text));
    // the rule, with the keyboard: in place, rule 1 marked; Escape closes it and the focus is back on the link
    const s1 = await page.eval(STATE);
    await page.eval(`document.querySelector('#diag [data-diag-ref="policy:fw:1"]').focus(), true`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    const rule = await page.eval(`(() => { const b = document.getElementById('diag-rule'); return b ? { focus: document.activeElement === b, on: Array.from(b.querySelectorAll('li[aria-current="true"]')).map((x) => x.getAttribute('data-rule')), rows: b.querySelectorAll('li[data-rule]').length } : null; })()`);
    assert.deepEqual(rule, { focus: true, on: ['1'], rows: 3 }, 'rule 1 of 2 and the default, rule 1 marked');
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-diag-ref')`), 'policy:fw:1', 'the focus is back on the link');
    // the decision's line: the packet it dropped, in the inspector; Escape returns to the link
    const ev = await page.eval(`(() => { const b = document.querySelector('#diag [data-diag-ref^="event:"]'); b.focus(); return b.getAttribute('data-diag-ref'); })()`);
    await page.key('Enter', 'Enter', 13);
    await page.settle(150);
    const insp = await page.eval(`(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p ? p.textContent : null; })()`);
    assert.ok(insp && /packet \d+, as pc sent it at t = .*dropped at fw/.test(insp), String(insp).slice(0, 300));
    await page.key('Escape', 'Escape', 27);
    await page.settle(100);
    assert.equal(await page.eval(`document.activeElement.getAttribute('data-diag-ref')`), ev, 'focus back on the evidence link');
    assert.equal(await page.eval(STATE), s1, 'following evidence changed nothing (the clock, the operations, the model, its lock)');
    // a new simulation: the old link names the earlier execution — unavailable, nothing else opened
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(150);
    await page.eval(START);
    await page.settle(200);
    await page.eval(`netatlas.gotoEvidence(${JSON.stringify(ev)}), true`);
    await page.settle(80);
    assert.match(await page.eval(`document.getElementById('toast').textContent`), /belongs to an earlier simulation .*not available/);
    assert.equal(await page.eval(`!!document.querySelector('.sim-table-panel[data-table="packet"]')`), false);
  } finally {
    await page.close();
  }
});

const CHAIN = `netatlas: 1
title: Causes
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: r1, type: router, interfaces: [{id: a, ip: 10.0.1.1/24}, {id: b, ip: 10.0.2.1/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l2, a: "r1:b", b: "srv:eth0"}
`;

test('a series’ distinct causes each with its messages; a finished failure whose cause is not established is labelled so', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(CHAIN)}, "causes.yaml"), true`);
    await page.settle(150);
    await page.eval(START);
    await page.settle(200);
    // message 2's request lost on l1, message 3's on l2; message 1 answered
    await page.eval(`(() => { const c = netatlas.simController(); const t0 = c.sim.now; c.sim.engine.impair = (l, f) => { const k = f.ip && f.ip.l4 && f.ip.l4.icmpType === 8 ? Math.floor((c.sim.engine.now - t0 + 500) / 2000) : -1; return (k === 1 && l === 'l1') || (k === 2 && l === 'l2') ? { lose: true } : null; }; c.sim.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10', count: 3, interval: 2 }); c.runTo(c.sim.now + 20000); c.sim.engine.impair = null; c.refresh(true); return true; })()`);
    await page.eval(`netatlas.setTraceForm({ from: 'pc', to: 'srv' }), netatlas.runTrace(), true`);
    await page.settle(200);
    await page.eval(`document.querySelector('#diag [data-diag-act="compare"]').click(), true`);
    await page.settle(200);
    const g = await page.eval(`Array.from(document.querySelectorAll('#diag-blockers li[data-count]')).map((li) => [li.getAttribute('data-rel'), li.getAttribute('data-count'), Array.from(li.querySelectorAll('.diag-msgs button')).map((b) => b.textContent).join(',')])`);
    assert.deepEqual(g, [['cause', '1', 'message 2'], ['cause', '1', 'message 3']]);
    assert.equal(await page.eval(`document.getElementById('diag-state').textContent`), '◐ Partial');
    // srv's answers lost on their way back: the request arrived, the records do not establish why no answer came
    await page.eval(`(() => { const c = netatlas.simController(); c.sim.engine.impair = (l, f) => (l === 'l2' && f.ip && f.ip.src.bytes.join('.') === '10.0.2.10' ? { lose: true } : null); c.sim.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' }); c.runTo(c.sim.now + 10000); c.sim.engine.impair = null; c.refresh(true); return true; })()`);
    await page.eval(`document.querySelector('#diag [data-diag-act="compare"]').click(), true`);
    await page.settle(200);
    const u = await page.eval(`[document.getElementById('diag-state').textContent, document.getElementById('diag-runtime').getAttribute('data-cause'), document.getElementById('diag-flags') ? document.getElementById('diag-flags').textContent : '']`);
    assert.deepEqual(u.slice(0, 2), ['✕ Not completed — cause not established', 'unknown']);
    assert.ok(!/Provisional/.test(u[2]), 'a finished run is not provisional');
  } finally {
    await page.close();
  }
});

const MQ = `netatlas: 1
title: MQTT legs
devices:
  - {id: broker, type: server, services: {mqtt_broker: {}}, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: pa, type: endpoint, services: {applications: [{id: a, name: A, profile: mqtt_client, broker: broker, publish: [s/a], interval: 1s, count: 3, qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: sub, type: endpoint, services: {applications: [{id: v, name: V, profile: mqtt_client, broker: broker, subscribe: ["s/#"], qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.20/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "broker:eth0"}
  - {id: l2, a: "sw:p2", b: "pa:eth0"}
  - {id: l3, a: "sw:p3", b: "sub:eth0"}
`;

test('an MQTT run: the publisher’s and the subscriber’s legs from its own publications; a narrow window in both themes; leaving Analyze keeps the result', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 390, height: 844 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(MQ)}, "mqtt.yaml"), true`);
    await page.settle(150);
    await page.eval(START);
    await page.settle(200);
    // the publisher runs (scenario time), the subscriber does not
    await page.eval(`(() => { const c = netatlas.simController(); const a = c.sim.actApp('pa', 'a', 'experiment'); if (a.error) throw new Error(a.error); c.runTo(c.sim.now + 8000); c.refresh(true); return true; })()`);
    await page.eval(`netatlas.select('device:pa', true), netatlas.runCommand('analyze.diagnose'), true`);
    await page.settle(250);
    await page.eval(`document.querySelector('#diag [data-diag-act="compare"]').click(), true`);
    await page.settle(200);
    const legs = await page.eval(`Array.from(document.querySelectorAll('#diag-legs li')).map((li) => [li.textContent.replace(/\\s+/g, ' ').slice(0, 200), li.getAttribute('data-state')])`);
    const pub = legs.find((x) => /Publisher pa\/a → broker broker \(runtime, run #\d+\)/.test(x[0]));
    const sub = legs.find((x) => /Broker broker → subscriber sub\/v \(runtime/.test(x[0]));
    assert.ok(pub && sub, JSON.stringify(legs));
    assert.equal(pub[1], 'established');
    assert.equal(sub[1], 'blocked', 'the broker passed it to nobody: the subscriber had no session');
    assert.match(await page.eval(`document.getElementById('diag-question').textContent`), /Runtime\s*MQTT run #\d+ of pa\/a/);
    const state0 = await page.eval(`document.getElementById('diag').getAttribute('data-state') + '|' + document.getElementById('diag-summary').textContent`);
    // narrow, both themes: nothing scrolls sideways
    for (const th of ['light', 'dark']) {
      await page.eval(`netatlas.theme.set(${JSON.stringify(th)}), true`);
      await page.settle(120);
      const m = await page.eval(`(() => { const d = document.getElementById('diag'); return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, own: d.scrollWidth - d.clientWidth, bg: getComputedStyle(document.body).backgroundColor }; })()`);
      assert.ok(m.page <= 0 && m.own <= 1, `${th}: sideways scroll ${JSON.stringify(m)}`);
    }
    // leave Analyze and come back: the result as it was (frozen, not recomputed)
    await page.eval(`netatlas.runCommand('ws.exit'), true`);
    await page.settle(150);
    await page.eval(`netatlas.runCommand('trace.open'), true`);
    await page.settle(200);
    assert.equal(await page.eval(`document.getElementById('diag').getAttribute('data-state') + '|' + document.getElementById('diag-summary').textContent`), state0);
  } finally {
    await page.close();
  }
});

// a device with two client applications: Diagnose communication… asks which; nothing of an earlier question carried over
const TWO = APP.replace('services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web"}]}', 'services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web"}, {id: ping, name: Ping, profile: udp_client, peer: "srv/web", port: 9}]}');

test('several client applications: an explicit choice, nothing checked before it; an earlier question’s fields are not carried over', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(TWO)}, "two.yaml"), true`);
    await page.settle(150);
    // an earlier question with a service and a VRF
    await page.eval(`netatlas.setTraceForm({ from: 'srv', to: 'fw', service: 'tcp/22', vrf: '' }), netatlas.runTrace(), true`);
    await page.settle(150);
    await page.eval(`netatlas.select('device:pc', true), netatlas.runCommand('analyze.diagnose'), true`);
    await page.settle(200);
    const c = await page.eval(`(() => { const ch = document.getElementById('trace-choice'); return ch ? { focus: !!document.activeElement.closest('#trace-choice'), opts: Array.from(ch.querySelectorAll('button')).map((b) => b.getAttribute('data-choice-from')) } : null; })()`);
    assert.deepEqual(c, { focus: true, opts: ['pc/get', 'pc/ping', 'pc'] });
    assert.deepEqual(await page.eval(`[document.getElementById('trace-service').value, document.getElementById('trace-to').value]`), ['', ''], 'the earlier service and destination are cleared');
    await page.key('Enter', 'Enter', 13);
    await page.settle(200);
    assert.equal(await page.eval(`netatlas.currentTrace().check.request.from`), 'pc/get');
    assert.equal(await page.eval(`document.activeElement.id`), 'diag-summary');
  } finally {
    await page.close();
  }
});
