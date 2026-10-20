// Layer 1–2 per hop (engine.ts): a frame is decided at each device when it
// arrives there, with that device's state then — a port shut, the switch
// powered off, a spanning tree changed while the frame was on a cable —
// never all at once when it was sent. Disconnected segments that reuse a
// VLAN ID are independent (each its own spanning tree); a port without
// spanning tree keeps no hidden loop protection. Checked by delivery and
// by the drops the log records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/** h1 — sw — h2, both cables 100 ms long (a slow link: frames are on their way long enough to change things meanwhile). */
const SLOW = `netatlas: 1
title: slow
devices:
  - {id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}
  - {id: h2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "h1:eth0", b: "sw:p1", simulation: {latency: 100ms}}
  - {id: b, a: "sw:p2", b: "h2:eth0", simulation: {latency: 100ms}}
`;

/** a ping from h1 to h2 once ARP is done; `meanwhile` runs 50 ms after it was sent (its request is on the first cable then) */
function pingWith(meanwhile) {
  const s = sim(SLOW);
  s.runTo(3000);
  const warm = s.sendTest({ from: 'h1', to: '10.0.0.2', kind: 'icmp' });
  s.runTo(s.now + 2000);
  assert.equal(warm.ok, true, 'the way works: ' + warm.result);
  const t = s.sendTest({ from: 'h1', to: '10.0.0.2', kind: 'icmp' });
  s.runTo(s.now + 50);
  meanwhile(s);
  s.runTo(s.now + 6000);
  return { s, t };
}

test('a switch port shut while a frame is on its way to the switch: the switch drops it when it arrives', () => {
  const { s, t } = pingWith((x) => x.shut('sw', 'p2'));
  assert.equal(t.ok, false, t.result);
  // h2 never got the request
  assert.ok(!s.events().some((e) => e.device === 'h2' && e.what === 'Echo Reply' && e.t >= t.started));
});

test('the switch powered off while a frame is on its way to it: nothing passes it', () => {
  const { s, t } = pingWith((x) => x.powerOff('sw'));
  assert.equal(t.ok, false, t.result);
  assert.ok(!s.events().some((e) => e.device === 'h2' && e.what === 'Echo Reply' && e.t >= t.started));
});

test('a switch learns a source MAC when the frame arrives there, not when it was sent (its table is never ahead of the traffic)', () => {
  const s = sim(SLOW);
  // (h1's gratuitous ARP at link-up taught the switch its MAC: that entry ages out first, after the MAC aging time of 300 s)
  s.runTo(310000);
  const mac1 = () => s.macTable('sw').filter((r) => r.port === 'p1' && r.type === 'dynamic');
  assert.equal(mac1().length, 0, 'nothing learned now');
  s.sendTest({ from: 'h1', to: '10.0.0.2', kind: 'icmp' });
  const t0 = s.now;
  // h1's ARP request is on cable a for 100 ms: the switch has not seen it yet
  s.runTo(t0 + 50);
  assert.equal(mac1().length, 0, 'not before the frame arrives');
  s.runTo(t0 + 150);
  assert.equal(mac1().length, 1, 'learned on arrival');
  // and the ping is answered (the comparison: nothing changed meanwhile)
  s.runTo(t0 + 3000);
  const ok = s.events().some((e) => e.device === 'h1' && e.what === 'Test answered' && e.t >= t0);
  assert.ok(ok);
});

/** Two islands that do not touch, both in VLAN 10, each a loop of two switches; island b's switches have the better (lower) priority. */
const ISLANDS = `netatlas: 1
title: islands
devices:
  - {id: a1, type: switch, interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]}
  - {id: a2, type: switch, interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]}
  - {id: b1, type: switch, simulation: {bridge_priority: 4096}, interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]}
  - {id: b2, type: switch, simulation: {bridge_priority: 8192}, interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]}
  - {id: ha1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}
  - {id: ha2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
  - {id: hb1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}
  - {id: hb2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
links:
  - {id: la1, a: "a1:p1", b: "a2:p1"}
  - {id: la2, a: "a1:p2", b: "a2:p2"}
  - {id: lb1, a: "b1:p1", b: "b2:p1"}
  - {id: lb2, a: "b1:p2", b: "b2:p2"}
  - {id: ha1l, a: "ha1:eth0", b: "a1:p3"}
  - {id: ha2l, a: "ha2:eth0", b: "a2:p3"}
  - {id: hb1l, a: "hb1:eth0", b: "b1:p3"}
  - {id: hb2l, a: "hb2:eth0", b: "b2:p3"}
`;

test('two disconnected segments reusing VLAN 10 are independent: each breaks its own loop, each delivers, nothing crosses', () => {
  const s = sim(ISLANDS);
  s.runTo(40000);
  const t = s.engine.tree(10);
  // one blocked port per island's loop, none of the other island's choice decides it
  const blockedA = Array.from(t.blocked).filter((k) => /^a/.test(k));
  const blockedB = Array.from(t.blocked).filter((k) => /^b/.test(k));
  assert.equal(blockedA.length, 1, JSON.stringify(Array.from(t.blocked)));
  assert.equal(blockedB.length, 1, JSON.stringify(Array.from(t.blocked)));
  const a = s.sendTest({ from: 'ha1', to: '10.0.0.2', kind: 'icmp' });
  const b = s.sendTest({ from: 'hb1', to: '10.0.0.2', kind: 'icmp' });
  s.runTo(s.now + 5000);
  assert.equal(a.ok, true, a.result);
  assert.equal(b.ok, true, b.result);
  assert.match(a.result, /\(ha2\)|10\.0\.0\.2/);
  // each ping answered in its own island: ha2 and hb2 each sent one Echo Reply (the same addresses, never crossing)
  const replies = (dev) => s.events().filter((e) => e.device === dev && e.what === 'Echo Reply' && e.t >= a.started).length;
  assert.deepEqual([replies('ha2'), replies('hb2')], [1, 1]);
  assert.ok(!s.engine.storms.size, 'no storm in either island');
});
