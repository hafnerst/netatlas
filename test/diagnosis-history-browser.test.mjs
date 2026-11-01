// What a comparison and an evidence link may show, with real input (headless Chrome/Edge/Chromium through the DevTools
// protocol; skipped without one): an IPv6 host-name question prepared, sent from the form and compared — the AAAA send
// is its run, the IPv4 send of the same name is not; an application's run is not compared with a question that asks
// another service (said why); and a policy decision followed after the policy was edited shows the rules as they were
// when diagnosed, the recorded rule marked, the current policy said to differ — never the new rule 1 as the decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

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

const DUAL = `netatlas: 1
title: Dual stack
devices:
  - id: dns1
    type: server
    services: {dns: {zones: [{name: lab.example, records: [{name: web, type: A, value: 10.0.0.20}, {name: web, type: AAAA, value: "2001:db8::20"}]}]}}
    interfaces: [{id: eth0, ip: 10.0.0.53/24}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: [10.0.0.20/24, "2001:db8::20/64"]}], simulation: {listening: "tcp/80"}}
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: [10.0.0.30/24, "2001:db8::30/64"]}], dns_servers: [10.0.0.53]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "dns1:eth0"}
  - {id: l2, a: "sw:p2", b: "srv:eth0"}
  - {id: l3, a: "sw:p3", b: "pc:eth0"}
`;

const TRACE = (f) => `(() => { netatlas.openTrace(); Object.assign(netatlas.traceForm, ${JSON.stringify(f)}); return netatlas.runTrace(); })()`;

test('an IPv6 host-name check: prepared, sent from the form and compared — the AAAA send is its run; the IPv4 send of the same name is not', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(DUAL)}, "dual.yaml"), true`);
    await page.settle(150);
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(5000); c.refresh(true); return true; })()`);
    await page.settle(150);
    // the IPv4 send of the same name first, from the form: it must not answer the IPv6 question
    assert.ok(await page.eval(TRACE({ from: 'pc', to: 'web.lab.example', service: 'tcp/80', family: '4', vrf: 'auto' })));
    await page.settle(150);
    await page.eval(`document.querySelector('#diag [data-diag-act="handoff"]').click(), true`);
    await page.settle(150);
    await page.eval(`document.getElementById('sim-t-send').click(), true`);
    await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.sim.now + 6000); c.refresh(true); return true; })()`);
    await page.settle(100);
    // the IPv6 question: nothing to compare yet (the IPv4 send is not its run)
    assert.ok(await page.eval(TRACE({ from: 'pc', to: 'web.lab.example', service: 'tcp/80', family: '6', vrf: 'auto' })));
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.compareTrace()`), false, 'the IPv4 send of the same name is not the IPv6 question’s');
    assert.match(await page.eval(`document.getElementById('toast').textContent`), /no send carries this check/);
    // prepared and sent: the form asks for the AAAA record; the comparison takes that send and agrees
    await page.eval(`document.querySelector('#diag [data-diag-act="handoff"]').click(), true`);
    await page.settle(150);
    await page.eval(`document.getElementById('sim-t-send').click(), true`);
    await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.sim.now + 6000); c.refresh(true); return true; })()`);
    await page.settle(100);
    const sent = JSON.parse(await page.eval(`JSON.stringify(netatlas.simController().sim.testRuns().map((r) => ({ fam: r.plan.family || 4, q: r.tests[0].qtype || 'A', v: r.tests[0].dst.version, ok: r.tests[0].ok })))`));
    assert.deepEqual(sent, [{ fam: 6, q: 'AAAA', v: 6, ok: true }, { fam: 4, q: 'A', v: 4, ok: true }], 'newest first: the AAAA send, then the A send');
    assert.equal(await page.eval(`netatlas.compareTrace()`), true);
    await page.settle(150);
    const cmp = await page.eval(`document.getElementById('trace-compare-res') ? document.getElementById('trace-compare-res').textContent : ''`);
    assert.match(cmp, /agree/i, cmp.slice(0, 300));
    assert.equal(await page.eval(`document.getElementById('diag').getAttribute('data-state')`), 'established');
  } finally {
    await page.close();
  }
});

// pc's application asks srv/web over TCP 80; fw denies TCP 80 by rule 1 (rejecting it)
const APP = `netatlas: 1
title: Policy history
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
    services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}, {id: tls, name: TLS, profile: tcp_server, port: 443}]}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
`;

test('an application run is not compared with a question about another service; a policy decision followed after the policy changed is the one diagnosed', { skip, timeout: 180000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await waitReady(page);
    await page.eval(`localStorage.clear(), netatlas.loadText(${JSON.stringify(APP)}, "history.yaml"), true`);
    await page.settle(150);
    await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(5000); const a = c.sim.actApp('pc', 'get', 'event'); if (a.error) throw new Error(a.error); c.runTo(c.sim.now + 6000); c.refresh(true); return true; })()`);
    await page.settle(150);
    // the application asked about TCP 443: its TCP 80 run does not answer it
    assert.ok(await page.eval(TRACE({ from: 'pc/get', to: '', service: 'tcp/443', family: '', vrf: 'auto' })));
    await page.settle(150);
    const before = await page.eval(`document.getElementById('diag').getAttribute('data-state')`);
    assert.equal(await page.eval(`netatlas.compareTrace()`), false);
    assert.match(await page.eval(`document.getElementById('toast').textContent`), /Not compared: pc\/get’s run is not this question’s communication — service: pc\/get uses TCP 80, the question asks about TCP 443/);
    assert.equal(await page.eval(`document.getElementById('diag').getAttribute('data-state')`), before, 'nothing attached');
    assert.equal(await page.eval(`document.getElementById('diag-runtime').hasAttribute('data-outcome')`), false, 'no run attached');
    // its own question: compared; the decision is rule 1, recorded
    assert.ok(await page.eval(TRACE({ from: 'pc/get', to: '', service: '', family: '', vrf: 'auto' })));
    await page.settle(150);
    assert.equal(await page.eval(`netatlas.compareTrace()`), true);
    await page.settle(150);
    assert.ok(await page.eval(`!!document.querySelector('#diag [data-diag-ref="policy:fw:1"]')`));
    // the policy changes after the diagnosis: rule 1 now permits TCP 443 instead (the simulation is left first: editing is locked while it runs)
    await page.eval(`netatlas.exitSimulation(), true`);
    await page.settle(100);
    await page.eval(`(() => { const i = netatlas.session.model.devices.findIndex((d) => d.id === 'fw'); netatlas.mdoc.setInteger(['devices', i, 'policy', 'rules', 0, 'dport'], '443'); netatlas.mdoc.setText(['devices', i, 'policy', 'rules', 0, 'action'], 'permit'); netatlas.afterEdit(); return true; })()`);
    await page.settle(150);
    assert.match(await page.eval(`netatlas.exportText()`), /- \{action: permit, proto: tcp, dport: 443\}/);
    // the old link: the rules as diagnosed, rule 1 (deny TCP 80) marked; the current policy said to differ
    await page.eval(`netatlas.gotoEvidence('policy:fw:1'), true`);
    await page.settle(150);
    const rule = JSON.parse(await page.eval(`(() => { const b = document.getElementById('diag-rule'); return JSON.stringify(b ? { on: Array.from(b.querySelectorAll('li[aria-current="true"]')).map((x) => x.textContent), current: !!b.querySelector('[data-current="differs"]'), text: b.textContent } : null); })()`));
    assert.ok(rule, 'the rule view is shown');
    assert.equal(rule.on.length, 1);
    assert.match(rule.on[0], /^Rule 1: deny .*80.* — decided here$/, rule.on[0]);
    assert.ok(!/443/.test(rule.on[0]), 'never the new rule 1');
    assert.equal(rule.current, true, 'the current policy is said to differ');
    assert.match(rule.text, /As diagnosed: default permit/);
    // the outdated result is said too
    assert.match(await page.eval(`netatlas.traceOutdated() ? 'outdated' : 'current'`), /outdated/);
  } finally {
    await page.close();
  }
});
