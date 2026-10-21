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

// sw1's aggregate with LACP rate fast (or both slow); two members
const LAG2 = (fast) => `netatlas: 1
title: lag
devices:
  - id: sw1
    type: switch
    interfaces: [{id: p1}, {id: p2}]
    logical_interfaces: [{id: po1, type: virtual, members: [p1, p2], vlans: [10]${fast ? ', simulation: {lacp_rate: fast}' : ''}}]
  - id: sw2
    type: switch
    interfaces: [{id: p1}, {id: p2}]
    logical_interfaces: [{id: po1, type: virtual, members: [p1, p2], vlans: [10]}]
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
`;
const lacpOf = (s, dev, port) => s.status().find((x) => x.protocol === 'lacp' && x.device === dev && x.name.indexOf(`member ${port} `) > 0);

test('LACP rates (IEEE 802.1AX periodic machine): sw1 fast (a 3 s timeout), sw2 slow — sw2 sends every second because sw1’s LACPDUs say its timeout is short; sw1 never times out, the members stay bundled', () => {
  const s = new S.Simulation(model(LAG2(true)));
  s.runTo(100000);
  for (const d of ['sw1', 'sw2']) for (const p of ['p1', 'p2']) assert.equal(lacpOf(s, d, p).state, 'Collecting / Distributing', `${d}:${p}`);
  assert.equal(s.events().filter((e) => e.protocol === 'lacp' && e.kind === 'state' && e.what === 'Detached').length, 0, 'no time-out on sw1');
  // the LACPDUs carry their actor's timeout; sw2's arrive every second on each member after the first exchange
  const sw1pdu = s.events().filter((e) => e.kind === 'message' && e.protocol === 'lacp' && e.device === 'sw1');
  assert.ok(sw1pdu.every((e) => /LACP_Timeout short/.test(e.detail)));
  const sw2p1 = s.events().filter((e) => e.kind === 'message' && e.protocol === 'lacp' && e.device === 'sw2' && /sw2:p1/.test(e.detail) && e.t > 10000);
  const gaps = sw2p1.slice(1).map((e, k) => e.t - sw2p1[k].t);
  assert.ok(gaps.length > 80 && gaps.every((g) => g > 900 && g < 1100), `sw2's gaps: ${gaps.slice(0, 6).map((g) => Math.round(g)).join(', ')}`);
  assert.ok(sw2p1.every((e) => /LACP_Timeout long/.test(e.detail)), 'sw2 itself stays slow (a 90 s timeout)');
  assert.match(lacpOf(s, 'sw2', 'p1').detail, /^LACPDU every 1 s \(its partner’s timeout is short\), timeout 1 min 30 s|^LACPDU every 1 s \(its partner’s timeout is short\), timeout 90 s/);
  assert.match(lacpOf(s, 'sw1', 'p1').detail, /^LACPDU every 30 s \(its partner’s timeout is long\), timeout 3 s/);
  // both slow: every 30 s either way
  const slow = new S.Simulation(model(LAG2(false)));
  slow.runTo(100000);
  const p = slow.events().filter((e) => e.kind === 'message' && e.protocol === 'lacp' && e.device === 'sw2' && /sw2:p1/.test(e.detail) && e.t > 10000);
  assert.ok(p.length >= 2 && p.length <= 4, `${p.length} slow LACPDUs`);
});

test('LACP mux machine: sw2’s LACPDUs lost on one member — sw1 times it out, says so at once (not in sync), and sw2 stops collecting and distributing on that member (Attached, its traffic held); the other member stays bundled', () => {
  const s = new S.Simulation(model(LAG2(false)));
  s.runTo(15000);
  s.engine.impair = (link, f) => (link === 'a' && f.msg.protocol === 'lacp' && (f.msg.data || {}).from === 'sw2' ? { lose: true } : null);
  s.runTo(300000);
  const det = s.events().find((e) => e.kind === 'state' && e.device === 'sw1' && e.what === 'Detached');
  const att = s.events().find((e) => e.t > 15000 && e.kind === 'state' && e.device === 'sw2' && e.what === 'Attached');
  assert.ok(det && att, 'both transitions');
  assert.ok(att.t - det.t < 10, `sw2 learns at once (${att.t - det.t} ms): sw1 sends when its state changes`);
  assert.match(att.detail, /its partner sw1:p1 is not in sync/);
  assert.equal(lacpOf(s, 'sw2', 'p1').state, 'Attached');
  assert.equal(lacpOf(s, 'sw2', 'p1').up, false);
  assert.equal(s.engine.memberReady('sw2', 'p1'), false, 'sw2 carries no traffic on it any more');
  assert.equal(s.engine.memberReady('sw2', 'p2'), true);
  for (const d of ['sw1', 'sw2']) assert.equal(lacpOf(s, d, 'p2').state, 'Collecting / Distributing', `${d}:p2`);
  // restored: back to Collecting / Distributing on both sides
  s.engine.impair = null;
  s.runTo(s.now + 70000);
  for (const d of ['sw1', 'sw2']) assert.equal(lacpOf(s, d, 'p1').state, 'Collecting / Distributing', `${d}:p1 again`);
});

// ---- LLDP / CDP: a neighbour known from its advertisements only

const LLDP = `netatlas: 1
title: lldp
devices:
  - {id: a, type: switch, interfaces: [{id: p1, vlans: 1}]}
  - {id: b, type: switch, interfaces: [{id: p1, vlans: 1}]}
links:
  - {id: l, a: "a:p1", b: "b:p1"}
relations:
  - {id: x, protocol: lldp, endpoints: [a, b]}
`;
const lldpState = (s, dev) => s.status().find((x) => x.protocol === 'lldp' && x.device === dev).state;

test('LLDP: the local link down — the neighbour is removed at once (not after its time-to-live); back up, it is learned again from its next advertisement', () => {
  const s = new S.Simulation(model(LLDP));
  s.runTo(40000);
  assert.equal(lldpState(s, 'a'), 'neighbour known');
  const t0 = s.now;
  assert.ok(s.shut('a', 'p1'));
  s.runTo(t0 + 1000);
  assert.equal(lldpState(s, 'a'), 'no neighbour', 'removed with the link, long before the 120 s TTL');
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'a' && e.what === 'neighbour removed' && /its link went down/.test(e.detail)));
  assert.ok(s.noShut('a', 'p1'));
  s.runTo(s.now + 60000);
  assert.equal(lldpState(s, 'a'), 'neighbour known');
});

test('LLDP: a device powered off forgets its neighbours; its neighbour removes it when the link goes down with it (loss of signal)', () => {
  const s = new S.Simulation(model(LLDP));
  s.runTo(40000);
  const t0 = s.now;
  assert.ok(s.powerOff('b'));
  s.runTo(t0 + 1000);
  assert.equal(lldpState(s, 'b'), 'no neighbour', 'b forgot');
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'b' && e.what === 'neighbour removed' && /b was powered off/.test(e.detail)));
  // a sees its own link go down (b's port is dark): what that port knew goes
  assert.equal(lldpState(s, 'a'), 'no neighbour');
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'a' && e.what === 'neighbour removed' && /its link went down/.test(e.detail)));
});

test('LLDP: the neighbour silent while the link stays up (its advertisements lost) — aged out after the TTL it announced, not before', () => {
  const s = new S.Simulation(model(LLDP));
  s.runTo(40000);
  const t0 = s.now;
  s.engine.impair = (link, f) => (f.msg.protocol === 'lldp' && f.msg.data && f.msg.data.from === 'b' ? { lose: true } : null);
  s.runTo(t0 + 60000);
  assert.equal(lldpState(s, 'a'), 'neighbour known', 'within its TTL');
  s.runTo(t0 + 130000);
  assert.equal(lldpState(s, 'a'), 'no neighbour');
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'a' && e.what === 'neighbour aged out' && /aged out after 2 min/.test(e.detail)));
});

test('LLDP: a neighbour is kept for the time-to-live its own advertisement announced', () => {
  const s = new S.Simulation(model(LLDP));
  s.runTo(40000);
  const ev = s.events().find((e) => e.device === 'a' && e.what === 'neighbour known');
  assert.match(ev.detail, /neighbour b port p1 \(for 2 min, the TTL it announced\)/);
  const msg = s.events().find((e) => e.kind === 'message' && e.protocol === 'lldp' && e.device === 'b');
  assert.match(msg.detail, /TTL 2 min/);
});
