// The routing protocols' exchanges decide their adjacencies, not a fixed
// sequence of message names (analysis/sim/proto-routing.ts, protocols.ts):
// OSPF's database exchange negotiates master and slave by router ID and
// rejects a DBD whose MTU is larger than the interface takes (stuck in
// ExStart, as real routers are); EIGRP asks its other neighbours with a
// Query when it loses one, and resets one that never replies (stuck in
// active). Asserted by states, the DBDs' fields and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const OSPF = (x = {}) => `netatlas: 1
title: ospf pair
devices:
  - id: r1
    type: router
    router_id: 10.255.0.1
    interfaces: [{id: g0, ip: 10.0.12.1/30${x.mtu1 ? ', mtu: ' + x.mtu1 : ''}}]
    protocols: {ospf: {}}
  - id: r2
    type: router
    router_id: 10.255.0.2
    interfaces: [{id: g0, ip: 10.0.12.2/30${x.mtu2 ? ', mtu: ' + x.mtu2 : ''}}]
    protocols: {ospf: {}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: igp, protocol: ospf, endpoints: ["r1:g0", "r2:g0"]}
`;

const dbds = (s, dev) => s.events().filter((e) => e.kind === 'message' && e.protocol === 'ospf' && e.what === 'DBD' && e.device === dev).map((e) => e.detail);

test('OSPF: the higher router ID is master; the slave answers with the master’s DD sequence number; then Loading and Full', () => {
  const s = new S.Simulation(model(OSPF()));
  s.runTo(80000);
  assert.deepEqual(['r1', 'r2'].map((d) => s.sessions(d, 'ospf')[0].state), ['Full', 'Full']);
  const neg = (dev) => s.events().find((e) => e.kind === 'state' && e.device === dev && e.what === 'Exchange');
  assert.match(neg('r2').detail, /this router \(router ID 10\.255\.0\.2\) is master, r1 slave \(DD sequence \d+\)/);
  assert.match(neg('r1').detail, /r2 \(router ID 10\.255\.0\.2\) is master, this router slave \(DD sequence \d+\)/);
  const seq = Number(/DD sequence (\d+)/.exec(neg('r2').detail)[1]);
  assert.ok(dbds(s, 'r1').some((d) => new RegExp(`Exchange \\(slave\\): the LSA headers of the database, DD sequence ${seq}$`).test(d)), dbds(s, 'r1').join('\n'));
  assert.ok(dbds(s, 'r2').some((d) => new RegExp(`Exchange \\(master\\): the LSA headers of the database, DD sequence ${seq + 1}$`).test(d)));
  assert.ok(dbds(s, 'r1').every((d) => !/ExStart/.test(d) || /interface MTU 1500/.test(d)));
});

test('OSPF: an MTU mismatch — the side with the smaller MTU rejects the larger DBDs: no adjacency gets past ExStart / Exchange, no routes', () => {
  const s = new S.Simulation(model(OSPF({ mtu1: 1400 })));
  s.runTo(120000);
  const st = ['r1', 'r2'].map((d) => s.sessions(d, 'ospf')[0].state);
  assert.ok(st.every((x) => x === 'ExStart' || x === 'Exchange'), st.join());
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'r1' && /MTU 1500 in r2's DBD is larger than g0's MTU 1400/.test(e.detail)));
  // the Hellos still pass (2-Way and beyond): the mismatch is the database exchange's
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Hello' && e.t > 100000));
  // the master keeps retransmitting its initial DBD
  assert.ok(dbds(s, 'r2').filter((d) => /^OSPF DBD: .*ExStart/.test(d) || /ExStart: I, M, MS/.test(d)).length >= 5);
});

/** r1 — r2 — r3 and r1 — r3 in a triangle, EIGRP everywhere. */
const TRI = `netatlas: 1
title: eigrp triangle
devices:
  - {id: r1, type: router, router_id: 10.255.0.1, interfaces: [{id: a, ip: 10.0.12.1/30}, {id: b, ip: 10.0.13.1/30}], protocols: {eigrp: {asn: 10}}}
  - {id: r2, type: router, router_id: 10.255.0.2, interfaces: [{id: a, ip: 10.0.12.2/30}, {id: c, ip: 10.0.23.1/30}], protocols: {eigrp: {asn: 10}}}
  - {id: r3, type: router, router_id: 10.255.0.3, interfaces: [{id: b, ip: 10.0.13.2/30}, {id: c, ip: 10.0.23.2/30}], protocols: {eigrp: {asn: 10}}}
links:
  - {id: l12, a: "r1:a", b: "r2:a"}
  - {id: l13, a: "r1:b", b: "r3:b"}
  - {id: l23, a: "r2:c", b: "r3:c"}
relations:
  - {id: e12, protocol: eigrp, endpoints: ["r1:a", "r2:a"]}
  - {id: e13, protocol: eigrp, endpoints: ["r1:b", "r3:b"]}
  - {id: e23, protocol: eigrp, endpoints: ["r2:c", "r3:c"]}
`;

test('EIGRP: a lost neighbour — the router queries its other neighbours, each Reply answers the Query; the routes go the other way', () => {
  const s = new S.Simulation(model(TRI));
  s.runTo(60000);
  assert.ok(['r1', 'r2', 'r3'].every((d) => s.sessions(d, 'eigrp').every((x) => x.state === 'Up')));
  const t0 = s.now;
  s.fail('link:l12');
  s.runTo(t0 + 30000);
  const q = s.events().filter((e) => e.t >= t0 && e.kind === 'message' && e.protocol === 'eigrp' && e.what === 'Query');
  assert.ok(q.some((e) => e.device === 'r1' && e.peer === 'r3'), q.map((e) => `${e.device}→${e.peer}`).join(' '));
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'message' && e.protocol === 'eigrp' && e.what === 'Reply' && e.device === 'r3' && e.peer === 'r1'));
  // no Query was sent again: the Reply answered it
  assert.equal(q.filter((e) => e.device === 'r1' && e.peer === 'r3' && /sent again/.test(e.detail)).length, 0);
  assert.match(s.routeLookup('r1', '10.0.23.1').text, /out b/);
});

test('EIGRP: a neighbour that never replies to a Query is reset after the active timer (stuck in active)', () => {
  const s = new S.Simulation(model(TRI));
  s.runTo(60000);
  // r3's Replies are lost
  s.engine.impair = (link, f) => (f.msg.protocol === 'eigrp' && f.msg.type === 'Reply' && f.msg.data && f.msg.data.from === 'r3' ? { lose: true } : null);
  const t0 = s.now;
  s.fail('link:l12');
  s.runTo(t0 + 200000);
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'state' && e.device === 'r1' && e.peer === 'r3' && /stuck in active: no Reply to its Query within the active timer \(3 min\)/.test(e.detail)), 'reset after 3 min');
  assert.ok(s.events().filter((e) => e.t >= t0 && e.device === 'r1' && e.what === 'Query' && /sent again/.test(e.detail)).length >= 3);
});
