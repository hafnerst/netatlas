// Routing in the simulation is learned, not known (protocols.ts: the
// routers' databases, Engine.recompute): a router's routes come from the
// records its neighbours' advertisements brought it — an origin's change
// reaches it only with an advertisement, after which its routes are
// recomputed after its route recomputation delay. A lost advertisement or
// withdrawal (with the session up all along) has the protocol's
// consequence: OSPF sends it again after its retransmit interval, BGP's
// TCP retransmits it, RIP waits for its next periodic Response. Checked by
// the routes installed and by what traffic does, not by the log alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const Tr = load('analysis/trace.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/** r1 — r2 — r3 over two cables; r3's stub network 10.3.0.0/24; one protocol on both links. */
const CHAIN = (proto = 'ospf', x = {}) => {
  const svc = proto === 'bgp' ? (n) => `bgp: {asn: 6500${n}}` : proto === 'rip' ? () => 'rip: {}' : () => 'ospf: {}';
  const attrs = proto === 'ospf' ? ', attrs: {network-type: point-to-point}' : '';
  const dev = (n, ifs) => `  - id: r${n}
    type: router
    router_id: lo0
    protocols: {${svc(n)}}
    interfaces: [${ifs}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.${n}/32}]`;
  return `netatlas: 1
title: chain
devices:
${dev(1, '{id: g0, ip: 10.0.12.1/30}, {id: g9, ip: 10.1.0.1/24}')}
${dev(2, '{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.23.1/30}')}
${dev(3, '{id: g0, ip: 10.0.23.2/30}, {id: g1, ip: 10.3.0.1/24}')}
  - {id: h3, type: server, interfaces: [{id: eth0, ip: 10.3.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.3.0.1}]}
links:
  - {id: l12, a: "r1:g0", b: "r2:g0"}
  - {id: l23, a: "r2:g1", b: "r3:g0"}
  - {id: l3h, a: "r3:g1", b: "h3:eth0"}
relations:
  - {id: a12, protocol: ${proto === 'bgp' ? 'ebgp' : proto}, endpoints: ["r1:g0", "r2:g0"]${attrs}}
  - {id: a23, protocol: ${proto === 'bgp' ? 'ebgp' : proto}, endpoints: ["r2:g1", "r3:g0"]${attrs}}
${x.more || ''}`;
};

const fwd = (s, dev, ip) => s.routeLookup(dev, ip).kind === 'forward';
const stateOf = (s, proto, dev, peer) => (s.status().find((x) => x.protocol === proto && x.device === dev && x.peer === peer) || {}).state;
/** step to t in small steps, recording when a predicate first holds */
function whenTrue(s, until, pred, step = 50) {
  for (let t = s.now; t <= until; t += step) {
    s.runTo(t);
    if (pred()) return s.now;
  }
  return null;
}
/** lose the n-th frame a predicate picks (Engine.impair) */
function lose(s, pick, n = 1) {
  let k = 0;
  s.engine.impair = (link, frame) => (pick(link, frame) && ++k === n ? { lose: true } : null);
}
const isMsg = (link, proto, type, fromAddr) => (l, frame) => l === link && frame.msg.protocol === proto && frame.msg.type === type && !!frame.ip && frame.ip.src.bytes.join('.') === fromAddr;

test('learned, not known: r1 has a route to r3’s network only once an advertisement with r3’s record reached it', () => {
  const s = sim(CHAIN());
  const routed = whenTrue(s, 30000, () => fwd(s, 'r1', '10.3.0.10'));
  assert.ok(routed !== null, 'r1 gets the route');
  const learned = s.events().filter((e) => e.kind === 'route' && e.what === 'learned' && e.device === 'r1' && /r3 sequence/.test(e.detail));
  assert.ok(learned.length >= 1, 'r1 learned r3’s record from r2');
  assert.ok(learned[0].t < routed, `learned at ${learned[0].t}, routed at ${routed}`);
  // the session r1 – r2 was Full before r1 knew of r3: an adjacency alone teaches nothing beyond its peer
  const full = s.events().find((e) => e.kind === 'state' && e.protocol === 'ospf' && e.device === 'r1' && e.peer === 'r2' && e.state === 'Full');
  assert.ok(full && full.t <= learned[0].t);
});

test('OSPF: a lost withdrawal — r1 keeps its stale route (the session stays Full) until the LSU is sent again; traffic meanwhile fails at r2', () => {
  const s = sim(CHAIN());
  s.runTo(30000);
  assert.ok(fwd(s, 'r1', '10.3.0.10'));
  // r2's first LSU to r1 after the failure is lost on l12
  lose(s, isMsg('l12', 'ospf', 'LSU', '10.0.12.2'));
  const t0 = s.now;
  s.fail('link:l23');
  s.runTo(t0 + 2500);
  assert.equal(fwd(s, 'r2', '10.3.0.10'), false, 'r2 knows at once: its own adjacency');
  assert.equal(fwd(s, 'r1', '10.3.0.10'), true, 'r1 has not heard of it: the LSU was lost');
  assert.equal(stateOf(s, 'ospf', 'r1', 'r2'), 'Full');
  // traffic meanwhile: r1 sends it to r2, which has no route — never delivered by a stale route
  const t = s.sendTest({ from: 'r1', via: 'g9', to: '10.3.0.10', kind: 'icmp' });
  s.runTo(s.now + 1000);
  assert.equal(t.ok, false);
  assert.match(t.result, /^Net Unreachable from 10\.0\.12\.2 \(r2\)/);
  // an analysis snapshot now traces with each router's installed routes: r1's stale one leads to r2, which has none
  const snap = s.snapshot();
  const tr = Tr.tracePath(s.engine.model, { from: 'r1', to: '10.3.0.10' }, snap.ctx);
  assert.equal(tr.paths[0].end.kind, 'stopped');
  assert.equal(tr.paths[0].end.device, 'r2');
  assert.deepEqual(tr.paths[0].hops.map((h) => h.device), ['r1', 'r2']);
  // the LSU goes again after the retransmit interval (5 s): r1 learns and its route goes
  const gone = whenTrue(s, t0 + 15000, () => !fwd(s, 'r1', '10.3.0.10'));
  assert.ok(gone !== null && gone - t0 >= 5000, `the route went at ${gone && gone - t0} ms`);
  assert.ok(s.events().some((e) => e.device === 'r2' && e.what === 'LSU' && /sent again: no LSAck after 5 s/.test(e.detail)));
  assert.equal(stateOf(s, 'ospf', 'r1', 'r2'), 'Full', 'the session was up all along');
});

test('OSPF: a lost advertisement on restoration — r1 learns the way back only with the retransmission', () => {
  const s = sim(CHAIN());
  s.runTo(30000);
  s.fail('link:l23');
  s.runTo(s.now + 10000);
  assert.equal(fwd(s, 'r1', '10.3.0.10'), false);
  // the first LSU from r2 that carries r3's record (r3 back with its adjacency) is lost
  const carriesR3 = (l, f) => isMsg('l12', 'ospf', 'LSU', '10.0.12.2')(l, f) && ((f.msg.data || {}).db || []).some((r) => r.origin === 'r3' && r.adj.length);
  lose(s, carriesR3);
  const t0 = s.now;
  s.restore('link:l23');
  const r2 = whenTrue(s, t0 + 30000, () => fwd(s, 'r2', '10.3.0.10'));
  const r1 = whenTrue(s, t0 + 30000, () => fwd(s, 'r1', '10.3.0.10'));
  assert.ok(r2 !== null && r1 !== null);
  assert.ok(r1 - r2 >= 4000, `r1 ${r1 - t0} ms, r2 ${r2 - t0} ms: about one retransmit interval apart`);
});

test('BGP: a lost UPDATE (a withdrawal) is retransmitted by TCP; the peer learns about a second later; the session stays Established', () => {
  const s = sim(CHAIN('bgp'));
  s.runTo(30000);
  assert.ok(fwd(s, 'r1', '10.3.0.10'), 'r1 learned r3’s network over BGP');
  lose(s, isMsg('l12', 'bgp', 'UPDATE', '10.0.12.2'));
  const t0 = s.now;
  s.fail('link:l23');
  // r2's session to r3 goes down by its hold timer (no BFD): at most 180 s; then the withdrawal to r1 is lost once
  const r2 = whenTrue(s, t0 + 200000, () => !fwd(s, 'r2', '10.3.0.10'), 200);
  const r1 = whenTrue(s, t0 + 210000, () => !fwd(s, 'r1', '10.3.0.10'), 50);
  assert.ok(r2 !== null && r1 !== null, `${r2} ${r1}`);
  assert.ok(r1 - r2 >= 900, `r1 learned ${r1 - r2} ms after r2: the TCP retransmission`);
  assert.equal(stateOf(s, 'bgp', 'r1', 'r2'), 'Established');
  assert.ok(s.events().some((e) => e.device === 'r2' && e.what === 'UPDATE' && /retransmission 1/.test(e.detail)));
});

test('RIP: a lost triggered update waits for the next periodic Response (30 s)', () => {
  const s = sim(CHAIN('rip'));
  s.runTo(70000);
  assert.ok(fwd(s, 'r1', '10.3.0.10'));
  lose(s, isMsg('l12', 'rip', 'Response', '10.0.12.2'));
  const t0 = s.now;
  s.fail('link:l23');
  // r2 notices by its timeout (180 s); its triggered Response is lost; the next periodic one carries the change
  const r2 = whenTrue(s, t0 + 200000, () => !fwd(s, 'r2', '10.3.0.10'), 200);
  const r1 = whenTrue(s, t0 + 240000, () => !fwd(s, 'r1', '10.3.0.10'), 200);
  assert.ok(r2 !== null && r1 !== null, `${r2} ${r1}`);
  assert.ok(r1 - r2 > 1000 && r1 - r2 <= 31000, `r1 ${r1 - r2} ms after r2: the next periodic Response`);
});

test('an installed route never outlives what it rests on: every delivered ping took routes its routers had installed', () => {
  const s = sim(CHAIN());
  s.runTo(30000);
  const t = s.sendTest({ from: 'r1', via: 'g9', to: '10.3.0.10', kind: 'icmp' });
  s.runTo(s.now + 1000);
  assert.equal(t.ok, true);
  // each routed hop of the answered ping was the router's own installed decision then
  const hops = s.events().filter((e) => e.kind === 'route' && e.what === 'routed' && e.t >= t.started && /10\.1\.0\.1 → 10\.3\.0\.10/.test(e.detail));
  assert.deepEqual(hops.map((e) => e.device), ['r2', 'r3']);
});
