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

// ---- the database exchange under loss, duplication and delay (r2 is master: the higher router ID)

const ospfStates = (s) => ['r1', 'r2'].map((d) => s.sessions(d, 'ospf')[0].state);
/** the DBD frames on the cable, by sender: their exchange fields */
const isDbd = (f) => f.msg.protocol === 'ospf' && f.msg.type === 'DBD';
const fullAt = (s, dev) => {
  const e = s.events().find((x) => x.kind === 'state' && x.device === dev && x.protocol === 'ospf' && x.what === 'Full');
  return e ? e.t : null;
};

test('OSPF: the master’s first summary DBD lost — it is sent again until the slave acknowledges it; both Full, neither before the exchange is done', () => {
  const s = new S.Simulation(model(OSPF()));
  let lost = 0;
  s.engine.impair = (link, f) => (isDbd(f) && f.msg.sender === 'r2' && f.msg.data.phase === 'summary' && f.msg.data.ms && !lost++ ? { lose: true } : null);
  s.runTo(80000);
  assert.ok(lost > 0);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.ok(dbds(s, 'r2').some((d) => /Exchange \(master\): the LSA headers of the database, DD sequence \d+ \(again: not acknowledged\)/.test(d)), dbds(s, 'r2').join('\n'));
  // the master went to Loading only after the slave's acknowledgment arrived (the slave acknowledged before the master was Full)
  const ack = s.events().find((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'DBD' && /acknowledges DD sequence/.test(e.detail));
  const loading = s.events().find((e) => e.kind === 'state' && e.device === 'r2' && e.protocol === 'ospf' && e.what === 'Loading');
  assert.ok(ack && loading && loading.t > ack.t, `${ack && ack.t} / ${loading && loading.t}`);
});

test('OSPF: the slave’s acknowledgment lost — the master sends its summary again, the slave acknowledges again; both Full', () => {
  const s = new S.Simulation(model(OSPF()));
  let lost = 0;
  s.engine.impair = (link, f) => (isDbd(f) && f.msg.sender === 'r1' && /acknowledges/.test(f.msg.detail || '') && !lost++ ? { lose: true } : null);
  s.runTo(80000);
  assert.ok(lost >= 1);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.ok(dbds(s, 'r1').some((d) => /acknowledges DD sequence \d+ \(again: the master sent its summary again\)/.test(d)), dbds(s, 'r1').join('\n'));
});

test('OSPF: the slave’s answer to the initial DBD lost — the master repeats its initial DBD, the slave answers again; both Full', () => {
  const s = new S.Simulation(model(OSPF()));
  let lost = 0;
  s.engine.impair = (link, f) => (isDbd(f) && f.msg.sender === 'r1' && f.msg.data.phase === 'summary' && /LSA headers/.test(f.msg.detail || '') && !lost++ ? { lose: true } : null);
  s.runTo(80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.ok(dbds(s, 'r1').some((d) => /Exchange \(slave\): the LSA headers of the database, DD sequence \d+ \(again\)/.test(d)), dbds(s, 'r1').join('\n'));
});

test('OSPF: every DBD duplicated, then every DBD delayed past the exchange — duplicates and late ones are discarded or answered, never restart it', () => {
  for (const imp of [{ dup: true }, { delay: 12000 }]) {
    const s = new S.Simulation(model(OSPF()));
    s.engine.impair = (link, f) => (isDbd(f) ? imp : null);
    s.runTo(120000);
    assert.deepEqual(ospfStates(s), ['Full', 'Full'], JSON.stringify(imp));
    assert.ok(!s.events().some((e) => e.what === 'SeqNumberMismatch'), JSON.stringify(imp) + ': ' + s.events().filter((e) => e.what === 'SeqNumberMismatch').map((e) => e.detail).join('\n'));
    // Full once each: no exchange started over
    assert.equal(s.events().filter((e) => e.kind === 'state' && e.protocol === 'ospf' && e.what === 'Full').length, 2, JSON.stringify(imp));
  }
});

test('OSPF: an interface restarted during the exchange — the neighbour starts over (a new initial DBD: SeqNumberMismatch or a new adjacency), both Full again', () => {
  const s = new S.Simulation(model(OSPF()));
  // r1's interface goes down while the master r2 is in Exchange (r1's acknowledgments lost, so the exchange stays open)
  s.engine.impair = (link, f) => (isDbd(f) && f.msg.sender === 'r1' && /acknowledges/.test(f.msg.detail || '') ? { lose: true } : null);
  for (let t = 1000; t < 80000 && s.sessions('r2', 'ospf')[0].state !== 'Exchange'; t += 100) s.runTo(t);
  assert.equal(s.sessions('r2', 'ospf')[0].state, 'Exchange');
  assert.ok(s.shut('r1', 'g0'));
  s.runTo(s.now + 2000);
  s.engine.impair = null;
  assert.ok(s.noShut('r1', 'g0'));
  s.runTo(s.now + 80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.ok(fullAt(s, 'r1') > 0 && fullAt(s, 'r2') > 0);
});

test('OSPF: a DBD of a later exchange after Full (the neighbour negotiated anew) — SeqNumberMismatch, back to ExStart, Full again', () => {
  const s = new S.Simulation(model(OSPF()));
  s.runTo(80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  const P = s.protocols;
  const r1 = Array.from(P.sessions.values()).find((x) => x.dev === 'r1' && x.protocol === 'ospf');
  // r2's new initial DBD (another DD sequence number) reaches r1
  P.behaviours.get('ospf').rx(P, r1, { protocol: 'ospf', type: 'DBD', label: 'OSPF DBD', detail: '', data: { phase: 'init', dd: 77, mtu: 1500, rid: '10.255.0.2' } }, null, null);
  assert.ok(s.events().some((e) => e.what === 'SeqNumberMismatch' && e.device === 'r1' && /an initial DBD \(I bit, DD sequence 77\)/.test(e.detail)));
  assert.notEqual(s.sessions('r1', 'ospf')[0].state, 'Full');
  s.runTo(s.now + 80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
});

test('OSPF: a change is flooded to a neighbour in Exchange or Loading too (RFC 2328 §13.3) — r2 learns r1’s record from r3 while their database exchange is still loading', () => {
  const s = new S.Simulation(model(`netatlas: 1
title: ospf chain
devices:
  - {id: r1, type: router, router_id: 10.255.0.1, interfaces: [{id: g0, ip: 10.0.13.1/30}, {id: lan, ip: 10.1.0.1/24}], protocols: {ospf: {}}}
  - {id: r3, type: router, router_id: 10.255.0.3, interfaces: [{id: g0, ip: 10.0.13.2/30}, {id: g1, ip: 10.0.23.1/30}], protocols: {ospf: {}}}
  - {id: r2, type: router, router_id: 10.255.0.2, interfaces: [{id: g0, ip: 10.0.23.2/30}], protocols: {ospf: {}}}
links:
  - {id: l13, a: "r1:g0", b: "r3:g0"}
  - {id: l23, a: "r3:g1", b: "r2:g0"}
relations:
  - {id: o13, protocol: ospf, endpoints: ["r1:g0", "r3:g0"]}
  - {id: o23, protocol: ospf, endpoints: ["r3:g1", "r2:g0"]}
`));
  // the database exchange between r3 and r2 never completes: the LSUs answering their LSRs are lost both ways
  s.engine.impair = (link, f) => (link === 'l23' && f.msg.protocol === 'ospf' && f.msg.type === 'LSU' && f.msg.data && f.msg.data.reply ? { lose: true } : null);
  s.runTo(60000);
  assert.deepEqual(s.sessions('r3', 'ospf', 'r2').filter((x) => x.device === 'r3').map((x) => x.state), ['Loading']);
  assert.deepEqual(s.sessions('r1', 'ospf').map((x) => x.state), ['Full']);
  // r1's record (its adjacency with r3) reached r2 by flooding, though r3 and r2 are not Full
  const rec = s.protocols.viewOf('r2').find((x) => x.origin === 'r1');
  assert.ok(rec && rec.adj.some((a) => /^o13\|r3$/.test(a)), JSON.stringify(s.protocols.viewOf('r2')));
});
