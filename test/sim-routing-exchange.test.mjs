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

// ---- the Exchange state's checks (RFC 2328 §10.6): a duplicate of the last DBD received is discarded by the master and makes
// the slave send its last DBD again; anything else that is not the next DBD — the MS bit inconsistent with the roles, the I bit,
// a DD sequence number out of order — is SeqNumberMismatch; in Loading and Full only duplicates are acceptable

// r1 with a LAN behind it (h): r2 learns 10.1.1.0/24 only from a Full adjacency
const PAIR = OSPF()
  .replace('    interfaces: [{id: g0, ip: 10.0.12.1/30}]', '    interfaces: [{id: g0, ip: 10.0.12.1/30}, {id: lan, ip: 10.1.1.1/24}]')
  .replace('links:\n', '  - {id: h, type: endpoint, interfaces: [{id: eth0, ip: 10.1.1.5/24}]}\nlinks:\n  - {id: l2, a: "r1:lan", b: "h:eth0"}\n');
const sess = (s, dev) => Array.from(s.protocols.sessions.values()).find((x) => x.dev === dev && x.protocol === 'ospf');
/** a DBD from the peer, handed to a router's session as received (the fields its packets carry) */
function dbdTo(s, dev, data) {
  const P = s.protocols;
  P.behaviours.get('ospf').rx(P, sess(s, dev), { protocol: 'ospf', type: 'DBD', label: 'OSPF DBD', detail: '', data: { mtu: 1500, ...data } }, null, null);
}
const mismatches = (s, dev, t0) => s.events().filter((e) => e.t >= t0 && e.what === 'SeqNumberMismatch' && e.device === dev);
/** r2 (the master) held in Exchange: the slave r1's acknowledgments lost until released */
function heldInExchange() {
  const s = new S.Simulation(model(PAIR));
  let hold = true;
  s.engine.impair = (link, f) => (hold && isDbd(f) && f.msg.sender === 'r1' && /acknowledges/.test(f.msg.detail || '') ? { lose: true } : null);
  for (let t = 1000; t < 80000 && sess(s, 'r2').state !== 'Exchange'; t += 50) s.runTo(t);
  assert.equal(sess(s, 'r2').state, 'Exchange');
  s.runTo(s.now + 1000);
  return { s, release: () => (hold = false) };
}

test('OSPF Exchange, the master: a DBD from the slave that is not the acknowledgment it expects (another DD sequence number) is SeqNumberMismatch — back to ExStart, no routes meanwhile, Full again (and routes then)', () => {
  const { s, release } = heldInExchange();
  assert.equal(s.routeLookup('r2', '10.1.1.5').kind, 'none', 'no route before Full');
  const dd = sess(s, 'r2').x.dd;
  const t0 = s.now;
  dbdTo(s, 'r2', { phase: 'summary', dd: dd + 5, ms: false });
  const m = mismatches(s, 'r2', t0);
  assert.equal(m.length, 1);
  assert.match(m[0].detail, new RegExp(`DBD ${dd + 5} out of sequence \\(the master expects the acknowledgment of ${dd}\\)`));
  assert.equal(sess(s, 'r2').state, 'ExStart');
  assert.equal(s.routeLookup('r2', '10.1.1.5').kind, 'none');
  release();
  s.runTo(s.now + 80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.equal(s.routeLookup('r2', '10.1.1.5').kind, 'forward');
});

test('OSPF Exchange, the master: a duplicate of the slave’s last DBD is discarded (no mismatch); a DBD with the MS bit set from the slave is SeqNumberMismatch', () => {
  const { s } = heldInExchange();
  const x = sess(s, 'r2').x;
  const t0 = s.now;
  // the slave's answer to the negotiation again (its last DBD, the master's initial DD sequence number): a duplicate
  dbdTo(s, 'r2', { phase: 'summary', dd: x.lastRx.dd, ms: false });
  assert.equal(mismatches(s, 'r2', t0).length, 0);
  assert.equal(sess(s, 'r2').state, 'Exchange');
  dbdTo(s, 'r2', { phase: 'summary', dd: x.dd, ms: true });
  assert.match(mismatches(s, 'r2', t0)[0].detail, /the MS bit of DBD \d+ is set, but r1 is the slave/);
});

test('OSPF Exchange, the slave: the master’s summary with a DD sequence number that is not the next one, or without the MS bit, is SeqNumberMismatch; a duplicate of the master’s initial DBD makes it answer again', () => {
  for (const bad of ['seq', 'ms']) {
    const s = new S.Simulation(model(PAIR));
    // the master's summaries lost: the slave r1 stays in Exchange, waiting for DD sequence (its) + 1
    s.engine.impair = (link, f) => (isDbd(f) && f.msg.sender === 'r2' && f.msg.data.phase === 'summary' ? { lose: true } : null);
    for (let t = 1000; t < 80000 && sess(s, 'r1').state !== 'Exchange'; t += 50) s.runTo(t);
    assert.equal(sess(s, 'r1').state, 'Exchange');
    const x = { ...sess(s, 'r1').x };
    const t0 = s.now;
    const answers = () => s.events().filter((e) => e.t >= t0 && e.kind === 'message' && e.device === 'r1' && e.what === 'DBD' && /\(again\)/.test(e.detail)).length;
    dbdTo(s, 'r1', { phase: 'init', dd: x.peerInit, rid: '10.255.0.2' });
    assert.equal(mismatches(s, 'r1', t0).length, 0, 'the initial DBD again: a duplicate');
    assert.equal(answers(), 1, 'answered again');
    if (bad === 'seq') dbdTo(s, 'r1', { phase: 'summary', dd: x.dd + 3, ms: true });
    else dbdTo(s, 'r1', { phase: 'summary', dd: x.dd + 1, ms: false });
    const m = mismatches(s, 'r1', t0);
    assert.equal(m.length, 1, bad);
    assert.match(m[0].detail, bad === 'seq' ? new RegExp(`DBD ${x.dd + 3} out of sequence \\(the slave expects ${x.dd + 1}\\)`) : /the MS bit of DBD \d+ is clear, but r2 is the master/);
    s.engine.impair = null;
    s.runTo(s.now + 80000);
    assert.deepEqual(ospfStates(s), ['Full', 'Full'], bad);
  }
});

test('OSPF Full: a duplicate of the last DBD is answered (slave) or discarded (master); a stale DBD of this exchange that is no duplicate is SeqNumberMismatch (RFC 2328 §10.6: only duplicates in Loading and Full)', () => {
  const s = new S.Simulation(model(PAIR));
  s.runTo(80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  const slave = sess(s, 'r1').x;
  const master = sess(s, 'r2').x;
  const t0 = s.now;
  // the master's summary again (the slave's acknowledgment lost): the slave acknowledges again
  dbdTo(s, 'r1', { phase: 'summary', dd: slave.lastRx.dd, ms: true });
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'r1' && e.what === 'DBD' && /acknowledges DD sequence \d+ \(again: the master sent its summary again\)/.test(e.detail)));
  // the slave's acknowledgment again: the master discards it
  dbdTo(s, 'r2', { phase: 'summary', dd: master.lastRx.dd, ms: false });
  assert.equal(mismatches(s, 'r1', t0).length + mismatches(s, 'r2', t0).length, 0);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  // the slave's answer to the negotiation, delayed past the exchange (an older DBD, not the last one): SeqNumberMismatch
  dbdTo(s, 'r2', { phase: 'summary', dd: master.lastRx.dd - 1, ms: false });
  const m = mismatches(s, 'r2', t0);
  assert.equal(m.length, 1);
  assert.match(m[0].detail, /a DBD that is no duplicate \(DD sequence \d+\) in Full: only duplicates are acceptable after the exchange/);
  s.runTo(s.now + 80000);
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
});

test('OSPF: the master’s summary and the slave’s acknowledgment each delayed selectively past a retransmission — duplicates, never a mismatch; Full once each, routes only then', () => {
  const s = new S.Simulation(model(PAIR));
  let n = 0;
  s.engine.impair = (link, f) => (isDbd(f) && f.msg.data.phase === 'summary' && n++ < 3 ? { delay: 6000 } : null);
  let early = false;
  for (let t = 1000; t <= 120000; t += 500) {
    s.runTo(t);
    if (s.routeLookup('r2', '10.1.1.5').kind !== 'none' && sess(s, 'r2').state !== 'Full') early = true;
  }
  assert.equal(early, false, 'no route before Full');
  assert.deepEqual(ospfStates(s), ['Full', 'Full']);
  assert.equal(s.events().filter((e) => e.what === 'SeqNumberMismatch').length, 0);
  assert.equal(s.events().filter((e) => e.kind === 'state' && e.protocol === 'ospf' && e.what === 'Full').length, 2);
});

// ---- EIGRP's initialization is reliable (RFC 7868 §5.3.1): the init Update sent again until acknowledged, Up only with both
// inits through, a retransmission acknowledged again (not a restart), the neighbour reset after the retry limit

const EPAIR = `netatlas: 1
title: eigrp pair
devices:
  - {id: r1, type: router, router_id: 10.255.0.1, interfaces: [{id: g0, ip: 10.0.12.1/30}], logical_interfaces: [{id: lo0, type: loopback, ip: 1.1.1.1/32}], protocols: {eigrp: {asn: 10}}}
  - {id: r2, type: router, router_id: 10.255.0.2, interfaces: [{id: g0, ip: 10.0.12.2/30}], logical_interfaces: [{id: lo0, type: loopback, ip: 2.2.2.2/32}], protocols: {eigrp: {asn: 10}}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: e, protocol: eigrp, endpoints: ["r1:g0", "r2:g0"]}
`;
const eStates = (s) => ['r1', 'r2'].map((d) => s.sessions(d, 'eigrp')[0].state);
const eUpAt = (s, dev) => (s.events().find((e) => e.kind === 'state' && e.protocol === 'eigrp' && e.device === dev && e.what === 'Up') || { t: null }).t;

test('EIGRP: r1’s first init Update lost — it is sent again after 5 s; r2 is not Up before it has r1’s init; both Up, routes both ways', () => {
  const s = new S.Simulation(model(EPAIR));
  let n = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'eigrp' && f.msg.type === 'Update' && f.msg.data.init && f.msg.data.from === 'r1' && ++n === 1 ? { lose: true } : null);
  s.runTo(60000);
  assert.equal(n >= 1, true);
  const again = s.events().find((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Update' && /init flag set, sequence \d+, no routes yet \(sent again: no ACK after 5 s\)/.test(e.detail));
  assert.ok(again, 'the init Update sent again');
  assert.ok(eUpAt(s, 'r2') >= again.t, `r2 Up only once it had r1's init (${eUpAt(s, 'r2')} / ${again.t})`);
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  assert.equal(s.routeLookup('r1', '2.2.2.2').kind, 'forward');
  assert.equal(s.routeLookup('r2', '1.1.1.1').kind, 'forward');
});

test('EIGRP: r2’s ACK of r1’s init lost — r1 sends its init again (the same sequence number), r2 acknowledges it again without resetting; both Up, once each', () => {
  const s = new S.Simulation(model(EPAIR));
  let n = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'eigrp' && f.msg.type === 'ACK' && f.msg.data.from === 'r2' && ++n === 1 ? { lose: true } : null);
  s.runTo(60000);
  const inits = s.events().filter((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Update' && /init flag set/.test(e.detail));
  assert.equal(inits.length, 2);
  assert.equal(/sequence (\d+)/.exec(inits[0].detail)[1], /sequence (\d+)/.exec(inits[1].detail)[1], 'a retransmission: the same sequence number');
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'r2' && e.what === 'ACK' && /acknowledges the init Update again \(sequence \d+: a retransmission\)/.test(e.detail)));
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  assert.equal(s.events().filter((e) => e.kind === 'state' && e.protocol === 'eigrp' && e.what === 'Up').length, 2, 'Up once each: no reset');
  assert.equal(s.routeLookup('r1', '2.2.2.2').kind, 'forward');
});

test('EIGRP: a new init Update from an Up neighbour (it restarted its side) resets the adjacency, which comes up again; every init lost — the neighbour reset after 16 tries, never Up', () => {
  let s = new S.Simulation(model(EPAIR));
  s.runTo(30000);
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  const P = s.protocols;
  const r2 = Array.from(P.sessions.values()).find((x) => x.dev === 'r2' && x.protocol === 'eigrp');
  const t0 = s.now;
  P.behaviours.get('eigrp').rx(P, r2, { protocol: 'eigrp', type: 'Update', label: 'EIGRP Update', detail: '', data: { init: true, seq: 4242 } }, null, null);
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'state' && e.device === 'r2' && e.what === 'Down' && /init Update from r1 while Up: it restarted/.test(e.detail)));
  s.runTo(t0 + 60000);
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  // the restart settles: each side reset once (r2 by the init, r1 by r2's new init), not reset by each other's inits again and again
  const resets = s.events().filter((e) => e.t >= t0 && e.kind === 'state' && e.protocol === 'eigrp' && e.what === 'Down');
  assert.ok(resets.length <= 2, `${resets.length} resets: ${resets.slice(0, 4).map((e) => `${e.device} ${Math.round(e.t - t0)} ms`).join(', ')}`);
  assert.ok(!s.events().some((e) => e.t >= t0 && e.kind === 'state' && e.protocol === 'eigrp' && e.what === 'Up' && e.t < t0 + 1000), 'not Up again on the init that reset it');
  // r1's inits never arrive: r1 retries, then resets r2 (Down), and starts over at r2's next Hello
  s = new S.Simulation(model(EPAIR));
  s.engine.impair = (link, f) => (f.msg.protocol === 'eigrp' && f.msg.type === 'Update' && f.msg.data.init && f.msg.data.from === 'r1' ? { lose: true } : null);
  s.runTo(100000);
  const reset = s.events().find((e) => e.kind === 'state' && e.device === 'r1' && e.what === 'Down' && /retry limit exceeded: the init Update sent 16 times without an ACK from r2/.test(e.detail));
  assert.ok(reset, 'reset after the retry limit');
  assert.ok(reset.t >= 2000 + 15 * 5000 && reset.t <= 2000 + 16 * 5000 + 100, `after 16 tries (${Math.round(reset.t)} ms)`);
  assert.ok(!s.events().some((e) => e.kind === 'state' && e.protocol === 'eigrp' && e.what === 'Up'), 'never Up');
  assert.equal(s.routeLookup('r2', '1.1.1.1').kind, 'none');
});

// r1 and r2 through a switch: what is on its way on r2's side survives a flap of r1's port
const EPAIR_SW = `netatlas: 1
title: eigrp pair through a switch
devices:
  - {id: r1, type: router, router_id: 10.255.0.1, interfaces: [{id: g0, ip: 10.0.12.1/30}], logical_interfaces: [{id: lo0, type: loopback, ip: 1.1.1.1/32}], protocols: {eigrp: {asn: 10}}}
  - {id: r2, type: router, router_id: 10.255.0.2, interfaces: [{id: g0, ip: 10.0.12.2/30}], logical_interfaces: [{id: lo0, type: loopback, ip: 2.2.2.2/32}], protocols: {eigrp: {asn: 10}}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: l1, a: "r1:g0", b: "sw:p1"}
  - {id: l2, a: "sw:p2", b: "r2:g0"}
relations:
  - {id: e, protocol: eigrp, endpoints: ["r1:g0", "r2:g0"]}
`;

test('EIGRP: an ACK of the earlier adjacency delayed past a restart does not acknowledge the new init — r1 keeps sending its init (lost meanwhile), is not Up and learns nothing; once its init gets through, both Up with routes', () => {
  const s = new S.Simulation(model(EPAIR_SW));
  let first = true;
  let dropInit = false;
  s.engine.impair = (link, f) => {
    const d = f.msg.data || {};
    if (f.msg.protocol !== 'eigrp') return null;
    // r2's first ACK (of r1's first init) held on r2's side for 26 s: it reaches r1 after r1's restart
    if (f.msg.type === 'ACK' && d.from === 'r2' && first && link === 'l2') {
      first = false;
      return { delay: 26000 };
    }
    if (dropInit && f.msg.type === 'Update' && d.init && d.from === 'r1') return { lose: true };
    return null;
  };
  s.runTo(20000);
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  dropInit = true;
  assert.ok(s.shut('r1', 'g0'));
  s.runTo(20500);
  assert.ok(s.noShut('r1', 'g0'));
  s.runTo(45000);
  const ignored = s.events().find((e) => e.kind === 'drop' && e.device === 'r1' && /ignores an ACK of sequence \d+ from r2: its init Update is sequence \d+ \(an ACK of an earlier exchange\)/.test(e.detail));
  assert.ok(ignored, 'the old ACK arrived and was not taken');
  const again = s.events().filter((e) => e.t > ignored.t && e.kind === 'message' && e.device === 'r1' && e.what === 'Update' && /init flag set.*sent again/.test(e.detail));
  assert.ok(again.length >= 2, `r1 keeps sending its init (${again.length})`);
  assert.equal(s.sessions('r1', 'eigrp')[0].state, 'Pending');
  assert.equal(s.routeLookup('r1', '2.2.2.2').kind, 'none', 'nothing learned before the adjacency is up');
  dropInit = false;
  s.runTo(80000);
  assert.deepEqual(eStates(s), ['Up', 'Up']);
  assert.equal(s.routeLookup('r1', '2.2.2.2').kind, 'forward');
  assert.equal(s.routeLookup('r2', '1.1.1.1').kind, 'forward');
});
