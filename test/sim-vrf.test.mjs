// VRF-local state and source selection in the simulation (transport.ts):
// the path MTU a device learns is kept per device, VRF and destination
// (overlapping addresses in two VRFs never share it), it ages out after
// 10 min, and a route that leaves by another interface forgets it; the
// source of a device's own packet comes from the route in its routing
// context (the default table for an unbound sender; one VRF only when it
// is the only one with a route; several: ambiguous, nothing sent), never
// from an address of another VRF; IPv6 senders fragment their own packets
// to the path MTU they learned (routers never do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/**
 * s (a router) reaches 10.5.0.10 in two VRFs over the same addresses:
 * red through m1 (its far side has an MTU of 1400), blue through m2 (1500).
 */
const TWO = (x = {}) => `netatlas: 1
title: vrfs
devices:
  - id: s
    type: router
    interfaces:
      - {id: r0, ip: 10.1.0.1/30, vrf: red}
      - {id: b0, ip: 10.1.0.1/30, vrf: blue}${x.sIfs || ''}
    routes:
      - {prefix: 10.5.0.0/24, via: 10.1.0.2, vrf: red}
      - {prefix: 10.5.0.0/24, via: 10.1.0.2, vrf: blue}${x.sRoutes || ''}
  - {id: m1, type: router, interfaces: [{id: g0, ip: 10.1.0.2/30}, {id: g1, ip: 10.5.0.1/24, mtu: 1400}]}
  - {id: m2, type: router, interfaces: [{id: g0, ip: 10.1.0.2/30}, {id: g1, ip: 10.5.0.1/24}]}
  - {id: hr, type: server, interfaces: [{id: eth0, ip: 10.5.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.5.0.1}]}
  - {id: hb, type: server, interfaces: [{id: eth0, ip: 10.5.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.5.0.1}], simulation: {listening: tcp/80}}
links:
  - {id: l1, a: "s:r0", b: "m1:g0"}
  - {id: l2, a: "s:b0", b: "m2:g0"}
  - {id: l3, a: "m1:g1", b: "hr:eth0"}
  - {id: l4, a: "m2:g1", b: "hb:eth0"}
`;
const run = (s, o, ms = 6000) => {
  const t = s.sendTest(o);
  if (typeof t === 'string') return t;
  s.runTo(s.now + ms);
  return t;
};

test('PMTU per VRF: what red learned (1400) never applies to the same address in blue', () => {
  const s = sim(TWO());
  s.runTo(3000);
  const red = run(s, { from: 's', via: 'r0', to: '10.5.0.10', kind: 'icmp', size: 1472, df: true });
  assert.match(red.result, /^Frag Needed from 10\.1\.0\.2 \(m1\).*path MTU 1400/);
  assert.ok(s.events().some((e) => e.what === 'path MTU' && e.device === 's' && /to 10\.5\.0\.10 \(VRF red\) is 1400 bytes now/.test(e.detail)));
  // the same destination address in blue: a full-size packet with DF goes through
  const blue = run(s, { from: 's', via: 'b0', to: '10.5.0.10', kind: 'icmp', size: 1472, df: true });
  assert.equal(blue.ok, true, blue.result);
  assert.match(blue.result, /^Echo Reply from 10\.5\.0\.10/);
  // TCP in blue sends full segments (no MSS from red's 1400); in red, the learned one
  const t0 = s.now;
  run(s, { from: 's', via: 'b0', to: '10.5.0.10', kind: 'tcp', port: 80, size: 3000 });
  const sizes = s.events().filter((e) => e.device === 's' && e.protocol === 'tcp' && e.t >= t0).map((e) => /, (\d+) bytes:/.exec(e.detail)).filter((m) => !!m).map((m) => Number(m[1]));
  assert.deepEqual(sizes, [1460, 1460, 80], 'blue: full segments, none of red’s path MTU');
});

test('PMTU ages out after 10 minutes: the next large DF packet learns it again', () => {
  const s = sim(TWO());
  s.runTo(3000);
  run(s, { from: 's', via: 'r0', to: '10.5.0.10', kind: 'icmp', size: 1472, df: true });
  s.runTo(s.now + 601000);
  const again = run(s, { from: 's', via: 'r0', to: '10.5.0.10', kind: 'icmp', size: 1472, df: true });
  assert.match(again.result, /^Frag Needed/);
  assert.ok(s.events().some((e) => e.what === 'path MTU' && /is forgotten: it aged out \(10 min\)/.test(e.detail)));
});

test('source selection: an unbound send reachable only in two VRFs is ambiguous (nothing sent); one VRF is used and said; never another VRF’s address', () => {
  const s = sim(TWO());
  s.runTo(3000);
  const amb = s.sendTest({ from: 's', to: '10.5.0.10', kind: 'icmp' });
  assert.equal(typeof amb, 'string');
  assert.match(amb, /s reaches 10\.5\.0\.10 in VRFs blue, red and not in its default table: ambiguous — choose a source interface/);
  // only red reaches 10.6.0.0/24: it is used, and the log says so
  const one = sim(TWO({ sRoutes: '\n      - {prefix: 10.6.0.0/24, via: 10.1.0.2, vrf: red}' }));
  one.runTo(3000);
  const t = one.sendTest({ from: 's', to: '10.6.0.9', kind: 'icmp' });
  assert.equal(typeof t, 'object');
  one.runTo(one.now + 6000);
  assert.ok(one.events().some((e) => e.device === 's' && e.what === 'source' && /from 10\.1\.0\.1 in VRF red, the only one with a route to 10\.6\.0\.9/.test(e.detail)));
  // a default-table interface of its own: the unbound send uses the default table and never a VRF's address
  const def = sim(TWO({ sIfs: '\n      - {id: m0, ip: 192.0.2.1/24}', sRoutes: '\n      - {prefix: 10.5.0.0/24, via: 192.0.2.254}' }));
  def.runTo(3000);
  const d = def.sendTest({ from: 's', to: '10.5.0.10', kind: 'icmp' });
  def.runTo(def.now + 6000);
  const sent = def.events().find((e) => e.device === 's' && e.what === 'Echo Request' && e.t >= 3000);
  assert.match(sent.detail, /from 192\.0\.2\.1 to 10\.5\.0\.10/);
  assert.equal(d.ok, false);
});

test('source selection: a chosen interface that is down fails the test, saying so', () => {
  const s = sim(TWO());
  s.runTo(3000);
  s.shut('s', 'r0');
  s.runTo(s.now + 500);
  const t = run(s, { from: 's', via: 'r0', to: '10.5.0.10', kind: 'icmp' });
  assert.equal(t.ok, false);
  assert.equal(t.result, 'not sent: s:r0 is down');
});

const V6 = `netatlas: 1
title: v6
devices:
  - {id: a, type: endpoint, interfaces: [{id: eth0, ip: 2001:db8:1::10/64}], routes: [{prefix: ::/0, via: 2001:db8:1::1}]}
  - {id: r, type: router, interfaces: [{id: g0, ip: 2001:db8:1::1/64}, {id: g1, ip: 2001:db8:2::1/64, mtu: 1400}]}
  - {id: b, type: server, interfaces: [{id: eth0, ip: 2001:db8:2::10/64, mtu: 1400}], routes: [{prefix: ::/0, via: 2001:db8:2::1}]}
links:
  - {id: l1, a: "a:eth0", b: "r:g0"}
  - {id: l2, a: "r:g1", b: "b:eth0"}
`;

test('IPv6: Packet Too Big teaches the sender its path MTU; its next large ping is fragmented at the source and answered', () => {
  const s = sim(V6);
  s.runTo(5000);
  const first = run(s, { from: 'a', to: '2001:db8:2::10', kind: 'icmp', size: 1452 });
  assert.equal(first.ok, false);
  assert.match(first.result, /Packet Too Big from 2001:db8:1::1 \(r\).*path MTU 1400/);
  assert.ok(s.events().some((e) => e.device === 'r' && /IPv6 routers never fragment/.test(e.detail)));
  const second = run(s, { from: 'a', to: '2001:db8:2::10', kind: 'icmp', size: 1452 });
  assert.equal(second.ok, true, second.result);
  assert.ok(s.events().some((e) => e.device === 'a' && e.what === 'fragmented' && /fragments its own .* for the path MTU it learned, 1400 \(IPv6: the sender fragments\)/.test(e.detail)));
  assert.ok(s.events().some((e) => e.device === 'b' && e.what === 'reassembled'));
  // nothing is fragmented by the router
  assert.ok(!s.events().some((e) => e.device === 'r' && e.what === 'fragmented'));
});

const PAT = `netatlas: 1
title: pat
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.11/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.12/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: n
    type: router
    services:
      nat:
        inside: [g0]
        outside: [g1]
        rules:
          - {type: pat, source: 10.0.0.0/24}
    interfaces: [{id: g0, ip: 10.0.0.1/24}, {id: g1, ip: 198.51.100.1/24}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 198.51.100.10/24}], simulation: {listening: udp/53}}
links:
  - {id: a, a: "h1:eth0", b: "sw:p1"}
  - {id: b, a: "h2:eth0", b: "sw:p2"}
  - {id: c, a: "sw:p3", b: "n:g0"}
  - {id: d, a: "n:g1", b: "srv:eth0"}
`;

test('PAT: two inside hosts with the same source port to the same server get two translations; each answer goes back to its own host', () => {
  const s = sim(PAT);
  s.runTo(3000);
  // both hosts' next ephemeral port the same (a collision PAT must resolve)
  const np = s.transport.nextPort;
  np.set('h2', np.get('h1') || 50000);
  if (!np.has('h1')) np.set('h1', 50000);
  const a = s.sendTest({ from: 'h1', to: '198.51.100.10', kind: 'udp', port: 53 });
  const b = s.sendTest({ from: 'h2', to: '198.51.100.10', kind: 'udp', port: 53 });
  s.runTo(s.now + 3000);
  assert.equal(a.ok, true, a.result);
  assert.equal(b.ok, true, b.result);
  const pats = s.events().filter((e) => e.device === 'n' && e.what === 'PAT');
  assert.equal(pats.length, 2);
  assert.match(pats[1].detail, /10\.0\.0\.12:\d+ → 198\.51\.100\.1:1024 \(its port is taken towards 198\.51\.100\.10\)/);
  const back = s.events().filter((e) => e.device === 'n' && e.what === 'NAT reply').map((e) => /→ (10\.0\.0\.1[12])/.exec(e.detail)[1]).sort();
  assert.deepEqual(back, ['10.0.0.11', '10.0.0.12']);
});
