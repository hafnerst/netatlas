// An exact source address is not an interface: a check from 10.0.1.11 on an
// interface that also has 10.0.1.10 is compared only with a send that went
// out from 10.0.1.11 (as recorded when it was sent), and the handoff says the
// address itself can't be chosen. A policy that permits only 10.0.1.11 makes
// the difference observable. Interface bindings, unusable aliases, IPv6
// aliases and the one-interface case stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const C = load('analysis/communication.js');
const I = load('analysis/comm-identity.js');
const S = load('analysis/sim/simulation.js');
const IP = load('model/ip.js');

const ALIAS = `netatlas: 1
title: aliases
devices:
  - id: client
    type: server
    interfaces: [{id: eth0, ip: [10.0.1.10/24, 10.0.1.11/24, "fd00:1::10/64", "fd00:1::11/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}, {prefix: "::/0", via: "fd00:1::1"}]
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: [10.0.1.1/24, "fd00:1::1/64"]}, {id: out, ip: [10.9.0.1/24, "fd00:9::1/64"]}]
    policy:
      default: deny
      rules:
        - {action: permit, source: 10.0.1.11, proto: tcp, dport: 80}
        - {action: permit, source: "fd00:1::11", proto: tcp, dport: 80}
  - id: srv
    type: server
    simulation: {listening: "tcp/80"}
    interfaces: [{id: eth0, ip: [10.9.0.10/24, "fd00:9::10/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}, {prefix: "::/0", via: "fd00:9::1"}]
links:
  - {id: a, a: "client:eth0", b: "fw:in"}
  - {id: b, a: "fw:out", b: "srv:eth0"}
`;

function sendFromHandoff(s, m, id, extra = {}) {
  const h = I.handoffOf(m, id);
  s.actSend({ delivery: 'unicast', ...h.prefill, ...extra });
  s.runTo(s.now + 10000);
  return { h, run: s.testRuns()[0] };
}

for (const [fam, from, other, dst] of [
  [4, '10.0.1.11', '10.0.1.10', '10.9.0.10'],
  [6, 'fd00:1::11', 'fd00:1::10', 'fd00:9::10'],
]) {
  test(`IPv${fam}: a check from the exact address ${from} — the handoff says the address can't be chosen; a send that left from ${other} is not its evidence`, () => {
    const m = model(ALIAS);
    const c = C.checkCommunication(m, { from, to: dst, service: 'tcp/80' });
    assert.equal(c.verdict, 'satisfied', c.headline);
    const id = I.commIdentity(m, c);
    assert.deepEqual([id.source.binding, id.source.iface, id.source.address], ['address', 'eth0', from]);
    const s = new S.Simulation(m);
    s.runTo(5000);
    const { h, run } = sendFromHandoff(s, m, id);
    assert.ok(h.notTransferred.some((x) => x.startsWith('Source address:') && x.includes(`not the address ${from}`)), h.notTransferred.join(' | '));
    // the transport chose the interface's first usable address: the other one — denied, and no evidence for this check
    assert.equal(run.tests[0].srcAddr, other);
    assert.equal(run.tests[0].ok, false);
    assert.equal(I.planMatches(id, run.plan, m), true, 'the plan alone looks the same');
    assert.equal(I.runMatches(id, run, m), false, 'as sent, it is not');
    // the other address made unusable (a duplicate): the transport sends from this one — delivered, and evidence
    s.engine.setUsable('client', 'eth0', IP.parseAddress(other), false);
    const again = sendFromHandoff(s, m, id).run;
    assert.equal(again.tests[0].srcAddr, from);
    assert.equal(again.tests[0].ok, true, again.tests[0].result);
    assert.equal(I.runMatches(id, again, m), true);
    assert.equal(I.compareRun(m, c, again, s.snapshot()).agree, true);
  });
}

test('an interface binding is its effective address when sent: any of its addresses is that check’s; a destination alias stays another check; a one-interface device without a named interface still matches', () => {
  const m = model(ALIAS);
  const c = C.checkCommunication(m, { from: 'client:eth0', to: 'srv', service: 'tcp/80' });
  const id = I.commIdentity(m, c);
  assert.equal(id.source.binding, 'interface');
  const s = new S.Simulation(m);
  s.runTo(5000);
  const { h, run } = sendFromHandoff(s, m, id);
  assert.ok(!h.notTransferred.some((x) => /^Source address/.test(x)), 'nothing to say for an interface');
  assert.equal(I.runMatches(id, run, m), true);
  // the exact check of the address the transport chose: the run is its evidence
  const c10 = C.checkCommunication(m, { from: '10.0.1.10', to: '10.9.0.10', service: 'tcp/80' });
  assert.equal(I.runMatches(I.commIdentity(m, c10), run, m), true);
  // a run to another destination address is another check
  const toAlias = { ...run, plan: { ...run.plan, toAddr: '10.9.0.99' } };
  assert.equal(I.runMatches(id, toAlias, m), false);
  // the one-interface case of #93: no interface named in the plan, still the check's (here the device has one interface)
  assert.equal(I.planMatches(id, { ...run.plan, via: undefined }, m), true);
});

// ------------------------------------------------------------------ the boundaries of an exact-source comparison

const ONE = ALIAS.replace('ip: [10.0.1.10/24, 10.0.1.11/24, "fd00:1::10/64", "fd00:1::11/64"]', 'ip: 10.0.1.11/24');

test('exact source, its boundaries: a message that could not be sent (no source chosen) is no evidence by itself; with sends from the exact address it counts as their failure (said why); a run still going is provisional; one message from another address makes the run no evidence', () => {
  const m = model(ONE);
  const c = C.checkCommunication(m, { from: '10.0.1.11', to: '10.9.0.10', service: 'tcp/80' });
  const id = I.commIdentity(m, c);
  assert.equal(id.source.binding, 'address');
  // every message sent while the interface is shut: none left, nothing to compare
  let s = new S.Simulation(m);
  s.runTo(5000);
  s.shut('client', 'eth0');
  s.runTo(s.now + 1000);
  let { run } = sendFromHandoff(s, m, id);
  assert.equal(run.tests[0].srcAddr, undefined);
  assert.match(run.tests[0].result, /^not sent: client:eth0 is down/);
  assert.equal(I.runMatches(id, run, m), false, 'no message left: no evidence of this source');
  // the first of three messages while shut, the others after: evidence, with the failure counted and explained
  s = new S.Simulation(m);
  s.runTo(5000);
  s.shut('client', 'eth0');
  s.runTo(s.now + 1000);
  const h = I.handoffOf(m, id);
  s.actSend({ delivery: 'unicast', ...h.prefill, count: 3, interval: 4 });
  s.runTo(s.now + 1000);
  s.noShut('client', 'eth0');
  // (a run not done yet: provisional, never final agreement)
  run = s.testRuns()[0];
  let cmp = I.compareRun(m, c, run, s.snapshot());
  assert.equal(cmp.final, false);
  assert.equal(cmp.agree, false);
  s.runTo(s.now + 20000);
  run = s.testRuns()[0];
  assert.deepEqual(run.tests.map((t) => t.srcAddr), [undefined, '10.0.1.11', '10.0.1.11']);
  assert.equal(I.runMatches(id, run, m), true);
  cmp = I.compareRun(m, c, run, s.snapshot());
  assert.equal(cmp.final, true);
  assert.deepEqual([cmp.counts.delivered, cmp.counts.failed], [2, 1]);
  assert.equal(cmp.runtime, 'mixed');
  assert.ok(cmp.lines.some((l) => /^Interface down when sent/.test(l)), cmp.lines.join(' | '));
  // one message of the run from another address (as after an address change between messages): the run is not evidence
  const changed = { ...run, tests: run.tests.map((t, k) => (k === 2 ? { ...t, srcAddr: '10.0.1.12' } : t)) };
  assert.equal(I.runMatches(id, changed, m), false);
});
