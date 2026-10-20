// Further protocol semantics found in the audit of the remaining protocols:
// BFD's detection time is the peer's multiplier × the slower of the two
// intervals (RFC 5880 §6.8.4), from what its Control packets say; a PIM
// router elects the DR by the priorities its neighbours' Hellos announce,
// never by reading their configuration. Asserted by when a failure is
// detected and by the roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const BFD = (attrs) => `netatlas: 1
title: bfd
devices:
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/30}], protocols: {bfd: {}}}
  - {id: r2, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], protocols: {bfd: {}}}
links:
  - {id: l, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: b, protocol: bfd, endpoints: ["r1:g0", "r2:g0"], attrs: {${attrs}}}
`;

test('BFD: the detection time is the peer’s multiplier × the slower interval (as the Control packets say), not this end’s own', () => {
  // r1: 300 ms × 3; r2: 1 s × 5. r1 detects r2's silence after 5 × 1 s; r2 detects r1's after 3 × 1 s
  const s = new S.Simulation(model(BFD('interval.r1: 300ms, multiplier.r1: 3, interval.r2: 1s, multiplier.r2: 5')));
  s.runTo(20000);
  assert.deepEqual(['r1', 'r2'].map((d) => s.sessions(d, 'bfd')[0].state), ['Up', 'Up']);
  // r1 sends no faster than r2 takes (its required min RX 1 s)
  const r1 = s.events().filter((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Control' && e.t > 10000);
  assert.ok(r1.length >= 2 && r1.slice(1).every((e, i) => e.t - r1[i].t >= 990), r1.map((e) => Math.round(e.t)).join());
  const t0 = s.now;
  s.engine.impair = (link, f) => (f.msg.protocol === 'bfd' && f.msg.data && f.msg.data.from === 'r2' ? { lose: true } : null);
  s.runTo(t0 + 8000);
  const down = s.events().find((e) => e.kind === 'state' && e.device === 'r1' && e.what === 'Down' && e.t >= t0);
  assert.ok(down, 'detected');
  assert.match(down.detail, /the peer's multiplier 5 × 1 s/);
  assert.ok(down.t - t0 >= 4000, `not before 5 × 1 s of silence (${Math.round(down.t - t0)} ms)`);
});

const PIM = `netatlas: 1
title: pim dr
devices:
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24, simulation: {pim_dr_priority: 200}}], protocols: {pim: {}}}
  - {id: r2, type: router, interfaces: [{id: g0, ip: 10.0.0.2/24}], protocols: {pim: {}}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "r1:g0", b: "sw:p1"}
  - {id: b, a: "r2:g0", b: "sw:p2"}
relations:
  - {id: p, protocol: pim, endpoints: ["r1:g0", "r2:g0"]}
`;

test('PIM: the DR is elected by the priorities the neighbours’ Hellos announce (r1’s 200 in its Hello); before a Hello, a neighbour counts as priority 1', () => {
  const s = new S.Simulation(model(PIM));
  s.runTo(40000);
  const hello = s.events().find((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Hello');
  assert.match(hello.detail, /DR priority 200/);
  const r2 = Array.from(s.protocols.sessions.values()).find((x) => x.dev === 'r2' && x.protocol === 'pim');
  assert.equal(r2.x.peerDrPrio, 200, 'what r1 said');
  // r2 knows r1 only by its Hello: forget it, and r2 takes r1 for priority 1 (r2's own address 10.0.0.2 > 10.0.0.1 wins then)
  r2.x.peerDrPrio = undefined;
  const isDr = (dev) => s.multicast.isDr(dev, s.engine.net.devices.get(dev).l3.get('g0'), 4).dr;
  assert.equal(isDr('r2'), true);
  r2.x.peerDrPrio = 200;
  assert.equal(isDr('r2'), false);
  assert.equal(isDr('r1'), true);
});

const DNSFWD = `netatlas: 1
title: dns forwarding
devices:
  - {id: pc, type: endpoint, dns_servers: [10.0.0.53], interfaces: [{id: eth0, ip: 10.0.0.10/24}]}
  - {id: dns1, type: server, services: {dns: {forwarders: [10.0.0.99]}}, interfaces: [{id: eth0, ip: 10.0.0.53/24}]}
  - {id: web, type: server, interfaces: [{id: eth0, ip: 10.0.0.99/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "dns1:eth0", b: "sw:p2"}
  - {id: c, a: "web:eth0", b: "sw:p3"}
`;

test('DNS: a forwarder that runs no DNS is asked all the same (the server cannot know); no answer — the client gets SERVFAIL from its server', () => {
  const s = new S.Simulation(model(DNSFWD));
  s.runTo(3000);
  const t = s.sendTest({ from: 'pc', to: 'name.example', kind: 'icmp' });
  s.runTo(s.now + 40000);
  // dns1 sent the query to 10.0.0.99 (it can't tell that web runs no DNS) …
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'dns1' && e.what === 'Query' && /to 10\.0\.0\.99:53/.test(e.detail)));
  // … which refuses it (a closed port); dns1 answers its client SERVFAIL
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'dns1' && e.what === 'Response' && /SERVFAIL/.test(e.detail) && /its forwarders gave no answer/.test(e.detail)));
  assert.equal(typeof t === 'string' ? false : t.ok, false);
});

const LAG = (crossed) => `netatlas: 1
title: lag
devices:
  - id: sw1
    type: switch
    interfaces: [{id: p1}, {id: p2}]
    logical_interfaces: [{id: po1, type: virtual, members: [p1, p2], vlans: [10]}]
  - id: sw2
    type: switch
    interfaces: [{id: p1}, {id: p2}]
    logical_interfaces: [{id: po1, type: virtual, members: [p1${crossed ? '' : ', p2'}], vlans: [10]}${crossed ? ', {id: po2, type: virtual, members: [p2], vlans: [10]}' : ''}]
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
`;

test('LACP: the members of an aggregate are bundled only with one partner aggregate; a member whose partner is another aggregate is not', () => {
  const ok = new S.Simulation(model(LAG(false)));
  ok.runTo(15000);
  assert.ok(ok.status().filter((x) => x.protocol === 'lacp').every((x) => x.state === 'Collecting / Distributing'));
  // sw2 put p2 in another aggregate: sw1's po1 has two partners — one of its members stays out of the bundle
  const bad = new S.Simulation(model(LAG(true)));
  bad.runTo(15000);
  const sw1 = bad.status().filter((x) => x.protocol === 'lacp' && x.device === 'sw1').map((x) => x.state).sort();
  assert.deepEqual(sw1, ['Collecting / Distributing', 'Detached']);
  assert.ok(bad.events().some((e) => e.device === 'sw1' && e.what === 'not bundled' && /differs from the aggregate's other members'/.test(e.detail)));
});
