// IKEv2 between two ends that each keep their own state (analysis/sim/
// proto-other.ts): requests with message IDs, sent again until answered,
// a repeated request answered from the kept response; dead peer
// detection on each side by its own timers (one end's loss never changes
// the other's state); rekeying replaces the SAs, a failed rekey lets the
// Child SA expire at its lifetime. Asserted by each end's state, the
// messages as sent and whether the tunnel carries traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const PAIR = (sim = '') => `netatlas: 1
title: ipsec
devices:
  - {id: a, type: router, interfaces: [{id: wan, ip: 192.0.2.1/30}]}
  - {id: b, type: router, interfaces: [{id: wan, ip: 192.0.2.2/30}]}
links:
  - {id: l, a: "a:wan", b: "b:wan"}
relations:
  - {id: vpn, protocol: ipsec, endpoints: ["a:wan", "b:wan"]${sim ? ', simulation: ' + sim : ''}}
`;

const sim = (x) => new S.Simulation(model(PAIR(x)));
const st = (s, dev) => s.sessions(dev, 'ipsec')[0].state;
const msgs = (s, dev, type, t0 = 0) => s.events().filter((e) => e.kind === 'message' && e.device === dev && e.what === type && e.t >= t0);
const block = (s, pred) => {
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && pred(f.msg, f.msg.data || {}) ? { lose: true } : null);
};

test('IKEv2: a lost IKE_AUTH request is sent again with its message ID; the responder answers it once; both ends Established', () => {
  const s = sim();
  let lost = 0;
  block(s, (m, d) => m.type === 'IKE_AUTH' && !d.response && lost++ === 0);
  s.runTo(20000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  const req = msgs(s, 'a', 'IKE_AUTH');
  assert.equal(req.length, 2);
  assert.match(req[0].detail, /request \(message ID 1\): IDi, AUTH/);
  assert.match(req[1].detail, /request \(message ID 1\), sent again \(1\)/);
  assert.ok(req[1].t - req[0].t >= 2000);
  assert.equal(msgs(s, 'b', 'IKE_AUTH').length, 1, 'answered once');
  assert.match(msgs(s, 'b', 'IKE_AUTH')[0].detail, /response \(message ID 1\)/);
});

test('IKEv2: each end detects a dead peer by its own DPD — the other end’s state is never changed for it; both recover when messages pass again', () => {
  const s = sim('{dpd_interval: 5}');
  s.runTo(20000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  // b's responses to a are lost (its requests pass): a's DPD requests go unanswered, b's are answered
  const t0 = s.now;
  block(s, (m, d) => d.from === 'b' && d.response);
  s.runTo(t0 + 40000);
  const aDown = s.events().find((e) => e.t >= t0 && e.kind === 'state' && e.device === 'a' && /Dead Peer Detection/.test(e.detail));
  assert.ok(aDown, 'a deleted its SAs by its own DPD');
  // b still has its SAs then: nothing told it — its own DPD requests were answered
  assert.equal(s.events().filter((e) => e.t >= t0 && e.t <= aDown.t && e.kind === 'state' && e.device === 'b').length, 0, 'b’s state is its own');
  // b finds out later, by what it receives itself: its own DPD unanswered, or a's new IKE_SA_INIT (a starts over)
  s.runTo(t0 + 120000);
  const bDown = s.events().find((e) => e.t >= t0 && e.kind === 'state' && e.device === 'b');
  assert.ok(bDown && bDown.t > aDown.t && /Dead Peer Detection|a starts a new IKE SA; b's established SAs serve until the new one is authenticated/.test(bDown.detail), bDown && bDown.detail);
  // the messages pass again: a negotiates anew (its recovery timer), both Established
  s.engine.impair = null;
  s.runTo(s.now + 60000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
});

test('IKEv2: the responder powered off — the initiator deletes its SAs by DPD and negotiates again when it is back', () => {
  const s = sim('{dpd_interval: 5}');
  s.runTo(20000);
  s.powerOff('b');
  s.runTo(s.now + 40000);
  assert.equal(st(s, 'a'), 'IKE_SA_INIT', 'trying again');
  s.powerOn('b');
  s.runTo(s.now + 150000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
});

test('IKEv2 rekeying: a rekey answered renews the Child SA on both ends; a rekey never answered lets it expire at its lifetime (no traffic), the IKE SA with it after its retries', () => {
  const s = sim('{child_lifetime: 120, rekey_margin: 30, dpd_interval: 600}');
  s.runTo(10000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  // the first rekey at 90 s: answered — the SA lives on past its first lifetime
  s.runTo(10000 + 125000);
  assert.ok(msgs(s, 'a', 'CREATE_CHILD_SA').length >= 1);
  assert.ok(msgs(s, 'b', 'CREATE_CHILD_SA').some((e) => /response/.test(e.detail)));
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  // from now on the rekeys are lost: at the end of the lifetime the Child SA is gone on both ends (each by its own timer)
  block(s, (m) => m.type === 'CREATE_CHILD_SA');
  const t0 = s.now;
  s.runTo(t0 + 130000);
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'a' && e.what === 'rekey failed' || (e.device === 'a' && e.what === 'No Child SA' && e.t >= t0)));
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'state' && e.device === 'b' && e.what === 'No Child SA'), 'b’s Child SA expired by its own lifetime');
});

const notes = (s, dev, what, t0 = 0) => s.events().filter((e) => e.t >= t0 && e.device === dev && e.what === what);

test('IKEv2: the Child SA and the IKE SA rekeys due at the same moment — the second waits for the first’s response (one request at a time); both SAs renewed, no response ignored', () => {
  // equal lifetimes and margins: both rekeys at 90 s
  const s = sim('{child_lifetime: 120, ike_lifetime: 120, rekey_margin: 30, dpd_interval: 600}');
  s.runTo(150000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  const rekeys = msgs(s, 'a', 'CREATE_CHILD_SA').filter((e) => /request \(message ID/.test(e.detail));
  assert.ok(rekeys.some((e) => /rekeys the Child SA/.test(e.detail)) && rekeys.some((e) => /rekeys the IKE SA/.test(e.detail)), rekeys.map((e) => e.detail).join('\n'));
  assert.deepEqual(s.events().filter((e) => e.kind === 'drop' && e.device === 'a' && /ignores a CREATE_CHILD_SA response/.test(e.detail)).map((e) => e.detail), []);
  assert.equal(notes(s, 'a', 'No Child SA').length + notes(s, 'b', 'No Child SA').length, 0, 'no SA expired');
  assert.ok(notes(s, 'a', 'request waits').some((e) => /waits for the response to its CREATE_CHILD_SA/.test(e.detail)));
  // each request its own message ID, in order
  const ids = rekeys.map((e) => Number(/message ID (\d+)/.exec(e.detail)[1]));
  assert.deepEqual(ids, ids.slice().sort((x, y) => x - y));
  assert.equal(new Set(ids).size, ids.length);
});

test('IKEv2: a DPD outstanding when a rekey falls due — the rekey waits for the DPD response, then goes; nothing overwritten', () => {
  const s = sim('{child_lifetime: 120, rekey_margin: 30, dpd_interval: 15}');
  // a's DPD at 90 s: its response is delayed so that it is still outstanding when the rekey falls due
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'INFORMATIONAL' && (f.msg.data || {}).response && (f.msg.data || {}).from === 'b' ? { delay: 1500 } : null);
  s.runTo(200000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  assert.equal(s.events().filter((e) => e.kind === 'drop' && e.device === 'a' && /ignores a (INFORMATIONAL|CREATE_CHILD_SA) response/.test(e.detail)).length, 0);
  assert.equal(notes(s, 'a', 'No Child SA').length, 0);
  assert.ok(!s.events().some((e) => e.device === 'a' && /Dead Peer Detection/.test(e.detail)));
});

test('IKEv2: a rekey’s response lost — the request is sent again with the same message ID, the peer answers from its kept response, the SA renewed once', () => {
  const s = sim('{child_lifetime: 120, rekey_margin: 30, dpd_interval: 600}');
  let lost = 0;
  block(s, (m, d) => m.type === 'CREATE_CHILD_SA' && d.response && lost++ === 0);
  s.runTo(150000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  const req = msgs(s, 'a', 'CREATE_CHILD_SA').filter((e) => /rekeys the Child SA/.test(e.detail));
  assert.ok(req.length >= 2 && /sent again \(1\)/.test(req[1].detail), req.map((e) => e.detail).join('\n'));
  assert.equal(Number(/message ID (\d+)/.exec(req[0].detail)[1]), Number(/message ID (\d+)/.exec(req[1].detail)[1]));
  assert.ok(msgs(s, 'b', 'CREATE_CHILD_SA').some((e) => /sent again: the request came again/.test(e.detail)), 'answered from the kept response');
  assert.equal(notes(s, 'a', 'No Child SA').length, 0);
});

test('IKEv2: a new IKE_SA_INIT while the responder is established — its old SAs carry traffic until the new IKE SA is authenticated, then are replaced', () => {
  const s = sim('{dpd_interval: 600}');
  s.runTo(20000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  // a reboots and starts over (b's DPD is far off: b is still established); a's first two IKE_AUTH requests are lost
  let lost = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'IKE_AUTH' && !(f.msg.data || {}).response && lost++ < 2 ? { lose: true } : null);
  const t0 = s.now;
  assert.ok(s.powerOff('a'));
  s.runTo(t0 + 500);
  assert.ok(s.powerOn('a'));
  // until b has answered a's new IKE_SA_INIT
  for (let t = t0 + 1000; t < t0 + 300000 && !notes(s, 'b', 'new IKE SA', t0).length; t += 200) s.runTo(t);
  assert.equal(notes(s, 'b', 'new IKE SA', t0).length, 1);
  // a's IKE_AUTH lost meanwhile: b is still Established, its SAs serve (nothing deleted by the new negotiation)
  s.runTo(s.now + 3000);
  assert.ok(lost >= 1);
  assert.equal(st(s, 'b'), 'Established');
  assert.equal(notes(s, 'b', 'IKE SA replaced', t0).length, 0);
  assert.equal(s.events().filter((e) => e.t >= t0 && e.kind === 'state' && e.device === 'b' && e.what === 'Idle').length, 0);
  // a's retransmitted IKE_AUTH arrives: the new SA replaces the old one on b
  s.runTo(s.now + 30000);
  assert.equal(notes(s, 'b', 'IKE SA replaced', t0).length, 1);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
});

// ------------------------------------------------------------------ the IKE SA's identity, its window, rekeying by either side

test('IKEv2: the IKE_SA_INIT that began the SA, delayed past its retransmission — dropped by the established responder (outside the window), never a new IKE SA; a delayed old IKE_AUTH too', () => {
  for (const type of ['IKE_SA_INIT', 'IKE_AUTH']) {
    const s = sim('{dpd_interval: 5}');
    let n = 0;
    s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === type && !(f.msg.data || {}).response && n++ === 0 ? { delay: type === 'IKE_SA_INIT' ? 5000 : 15000 } : null);
    s.runTo(60000);
    assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established'], type);
    const drop = s.events().filter((e) => e.kind === 'drop' && e.device === 'b' && e.what === type);
    assert.equal(drop.length, 1, `${type}: the late one dropped`);
    assert.match(drop[0].detail, type === 'IKE_SA_INIT' ? /a retransmission, outside the window \(RFC 7296 §2\.2\)/ : /an old one \(the next is \d+\), outside the window/);
    assert.equal(notes(s, 'b', 'new IKE SA').length + notes(s, 'b', 'IKE SA replaced').length, 0, `${type}: no new IKE SA on b`);
    // b answered each request once (no response to the late one); its own DPD message IDs go on (never back to 0)
    assert.equal(msgs(s, 'b', type).filter((e) => /response/.test(e.detail)).length, 1);
    const ids = msgs(s, 'b', 'INFORMATIONAL').filter((e) => /^IPsec \(IKEv2\) INFORMATIONAL: b .*; request \(message ID (\d+)\)/.test(e.detail)).map((e) => Number(/message ID (\d+)/.exec(e.detail)[1]));
    assert.ok(ids.length >= 4 && ids.every((v, k) => v === k), `${type}: b's DPD IDs ${ids.join(',')}`);
  }
});

test('IKEv2: an IKE SA rekeyed — the old one deleted by an INFORMATIONAL Delete on it, answered; in the new SA both sides’ message IDs start at 0 (RFC 7296 §2.18)', () => {
  const s = sim('{dpd_interval: 20, ike_lifetime: 120}');
  s.runTo(150000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  const rekey = msgs(s, 'a', 'CREATE_CHILD_SA').find((e) => /rekeys the IKE SA/.test(e.detail));
  assert.ok(rekey);
  const del = msgs(s, 'a', 'INFORMATIONAL').find((e) => /Delete \(the old IKE SA/.test(e.detail));
  const delAck = msgs(s, 'b', 'INFORMATIONAL').find((e) => /response .*Delete \(the old IKE SA\)/.test(e.detail));
  assert.ok(del && delAck && del.t >= rekey.t && delAck.t >= del.t, 'Delete and its answer');
  // the old SA's message IDs went on to the rekey; after it (until the next rekey), each side's requests start at 0 and count up
  const next = msgs(s, 'a', 'CREATE_CHILD_SA', rekey.t + 1).find((e) => /rekeys the IKE SA/.test(e.detail));
  const end = next ? next.t : Infinity;
  for (const d of ['a', 'b']) {
    const after = msgs(s, d, 'INFORMATIONAL', rekey.t + 1).filter((e) => e.t < end && /; request \(message ID \d+\): DPD/.test(e.detail)).map((e) => Number(/message ID (\d+)/.exec(e.detail)[1]));
    assert.ok(after.length >= 2 && after.every((v, k) => v === k), `${d}: ${after.join(',')}`);
  }
  // every DPD answered: nothing dropped as outside the window or of another SA
  assert.equal(s.events().filter((e) => e.kind === 'drop' && e.protocol === 'ipsec').length, 0);
});

test('IKEv2 DPD: one request every DPD interval (counted from the previous request), not every two', () => {
  const s = sim('{dpd_interval: 20}');
  s.runTo(150000);
  for (const d of ['a', 'b']) {
    const t = msgs(s, d, 'INFORMATIONAL').filter((e) => /; request \(message ID \d+\): DPD/.test(e.detail)).map((e) => e.t);
    const gaps = t.slice(1).map((v, k) => v - t[k]);
    assert.ok(gaps.length >= 5 && gaps.every((g) => g >= 19990 && g <= 20010), `${d}: ${gaps.map(Math.round).join(', ')}`);
  }
});

test('IKEv2: the responder’s own lifetime shorter — it rekeys its Child SA itself (RFC 7296 §2.8: lifetimes are not negotiated), never left without one; equal lifetimes — only the initiator rekeys', () => {
  const t = PAIR().replace('{id: b, type: router, interfaces: [{id: wan, ip: 192.0.2.2/30}]}', '{id: b, type: router, interfaces: [{id: wan, ip: 192.0.2.2/30}], simulation: {child_lifetime: 120}}');
  const s = new S.Simulation(model(t));
  s.runTo(400000);
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  assert.equal(s.events().filter((e) => e.kind === 'state' && e.what === 'No Child SA').length, 0, 'never without a Child SA');
  const own = msgs(s, 'b', 'CREATE_CHILD_SA').filter((e) => /; request \(message ID \d+\): rekeys the Child SA/.test(e.detail));
  assert.ok(own.length >= 3, `b rekeys (${own.length})`);
  assert.ok(own.every((e) => msgs(s, 'a', 'CREATE_CHILD_SA').some((r) => /response/.test(r.detail) && Math.abs(r.t - e.t) < 5)), 'each answered');
  // equal lifetimes: the initiator's rekey renews first; the responder's own one is never needed
  const e = sim('{child_lifetime: 120}');
  e.runTo(400000);
  assert.equal(msgs(e, 'b', 'CREATE_CHILD_SA').filter((x) => /; request/.test(x.detail)).length, 0);
  assert.ok(msgs(e, 'a', 'CREATE_CHILD_SA').filter((x) => /; request/.test(x.detail)).length >= 3);
});

// ------------------------------------------------------------------ an IKE SA rekey across loss, delay and requests waiting

// the tunnel the IKE SA protects carries the hosts' traffic
const TUN = (sim) => `netatlas: 1
title: ipsec tunnel
devices:
  - id: a
    type: router
    interfaces: [{id: wan, ip: 192.0.2.1/30}, {id: lan, ip: 10.1.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: b
    type: router
    interfaces: [{id: wan, ip: 192.0.2.2/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l, a: "a:wan", b: "b:wan"}
  - {id: la, a: "a:lan", b: "ha:eth0"}
  - {id: lb, a: "b:lan", b: "hb:eth0"}
relations:
  - {id: vpn, protocol: ipsec, endpoints: ["a:tun0", "b:tun0"], simulation: ${sim}}
`;
const ikeX = (s, dev) => Array.from(s.protocols.sessions.values()).find((x) => x.protocol === 'ipsec' && x.dev === dev).x;
const ping = (s) => {
  const t = s.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  s.runTo(s.now + 3000);
  return t.ok;
};
/** what must hold after the rekey: one IKE SA on both ends (the same), no reset, no expiry, the tunnel carrying traffic */
function converged(s, t0) {
  assert.deepEqual([st(s, 'a'), st(s, 'b')], ['Established', 'Established']);
  assert.equal(ikeX(s, 'a').sa, ikeX(s, 'b').sa, 'both ends in the same IKE SA');
  assert.equal(s.events().filter((e) => e.t >= t0 && e.kind === 'state' && e.protocol === 'ipsec' && /^(Idle|No Child SA|IKE_SA_INIT)$/.test(e.what)).length, 0, 'no reset, no expiry');
  assert.equal(ping(s), true, 'the tunnel carries traffic');
}

test('IKEv2: an IKE SA rekey’s response lost once, then twice — the request is sent again on the old SA with its message ID, the responder answers from its kept response there (RFC 7296 §2.1, §2.18); both ends end in the same new SA, the old one deleted; the tunnel carries traffic throughout', () => {
  for (const losses of [1, 2]) {
    const s = new S.Simulation(model(TUN('{ike_lifetime: 120, dpd_interval: 600}')));
    s.runTo(30000);
    assert.equal(ping(s), true);
    let lost = 0;
    s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'CREATE_CHILD_SA' && (f.msg.data || {}).response && (f.msg.data || {}).what === 'ike' && lost++ < losses ? { lose: true } : null);
    const t0 = s.now;
    s.runTo(t0 + 50000);
    assert.equal(lost >= losses, true);
    const req = msgs(s, 'a', 'CREATE_CHILD_SA', t0).filter((e) => /rekeys the IKE SA/.test(e.detail));
    assert.equal(req.length, losses + 1, req.map((e) => e.detail).join('\n'));
    const mids = req.map((e) => Number(/message ID (\d+)/.exec(e.detail)[1]));
    assert.ok(mids.every((m) => m === mids[0]), 'the same message ID each time');
    const replays = msgs(s, 'b', 'CREATE_CHILD_SA', t0).filter((e) => /sent again on the old IKE SA: the request came again/.test(e.detail));
    assert.equal(replays.length, losses, 'each retransmission answered from the kept response');
    assert.equal(msgs(s, 'b', 'CREATE_CHILD_SA', t0).filter((e) => /response \(message ID \d+\): the new IKE SA/.test(e.detail)).length, 1, 'one exchange, not another');
    assert.equal(s.events().filter((e) => e.t >= t0 && e.kind === 'drop' && e.protocol === 'ipsec' && /does not have|outside the window/.test(e.detail)).length, 0);
    assert.ok(notes(s, 'a', 'old IKE SA deleted', t0).length === 1);
    assert.equal(ikeX(s, 'b').old, undefined, 'the old SA’s state gone with its Delete');
    converged(s, t0);
    // in the new SA each side's requests start at message ID 0
    s.runTo(s.now + 70000);
    const next = msgs(s, 'a', 'CREATE_CHILD_SA', req[req.length - 1].t + 1).find((e) => /rekeys the IKE SA/.test(e.detail));
    assert.ok(next && /request \(message ID 0\)/.test(next.detail), next && next.detail);
  }
});

test('IKEv2: the IKE SA rekey request delayed past its retransmission — the retransmission rekeys, the old SA is deleted, then the late original arrives: dropped, no second exchange, no second new SA', () => {
  const s = new S.Simulation(model(TUN('{ike_lifetime: 120, dpd_interval: 600}')));
  s.runTo(30000);
  let n = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'CREATE_CHILD_SA' && !(f.msg.data || {}).response && (f.msg.data || {}).what === 'ike' && n++ === 0 ? { delay: 3000 } : null);
  const t0 = s.now;
  s.runTo(t0 + 50000);
  assert.ok(n >= 2, 'the original and its retransmission');
  assert.equal(msgs(s, 'b', 'CREATE_CHILD_SA', t0).filter((e) => /the new IKE SA/.test(e.detail)).length, 1, 'answered once');
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'drop' && e.device === 'b' && /CREATE_CHILD_SA request .* of an IKE SA it does not have/.test(e.detail)), 'the late copy dropped');
  converged(s, t0);
});

test('IKEv2: a Child SA rekey falling due while the IKE SA rekey is outstanding waits, and goes after it in the new IKE SA with message ID 0 — never on the old SA with the old message ID', () => {
  // the IKE SA rekey's response delayed 1.5 s; the Child SA rekey falls due 1 s after the IKE SA's
  const s = new S.Simulation(model(TUN('{ike_lifetime: 120, child_lifetime: 122, dpd_interval: 600}')));
  s.runTo(30000);
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'CREATE_CHILD_SA' && (f.msg.data || {}).response && (f.msg.data || {}).what === 'ike' ? { delay: 1500 } : null);
  const t0 = s.now;
  s.runTo(t0 + 50000);
  const waited = notes(s, 'a', 'request waits', t0).filter((e) => /CREATE_CHILD_SA \(Child SA\) waits for the response to its CREATE_CHILD_SA/.test(e.detail));
  assert.equal(waited.length, 1, 'the Child SA rekey waited');
  const child = msgs(s, 'a', 'CREATE_CHILD_SA', t0).find((e) => /rekeys the Child SA/.test(e.detail));
  const ikeRekey = msgs(s, 'a', 'CREATE_CHILD_SA', t0).find((e) => /rekeys the IKE SA/.test(e.detail));
  assert.ok(child.t > ikeRekey.t + 1000, 'after the IKE SA rekey’s response');
  assert.match(child.detail, /request \(message ID 0\)/, 'the new SA’s first message ID');
  assert.ok(msgs(s, 'b', 'CREATE_CHILD_SA', t0).some((e) => /response \(message ID 0\): the new Child SA/.test(e.detail)), 'answered in the new SA');
  assert.equal(s.events().filter((e) => e.t >= t0 && e.kind === 'drop' && e.protocol === 'ipsec' && !/lost on/.test(e.detail)).length, 0);
  converged(s, t0);
});

test('IKEv2: the responder’s DPD on its way across the IKE SA rekey (delayed past the old SA’s Delete) — it ends with the old SA, the next DPD goes in the new one; the responder never takes the peer for dead', () => {
  const s = new S.Simulation(model(TUN('{ike_lifetime: 120, dpd_interval: 20}')));
  s.runTo(30000);
  // b's DPD requests around the rekey (about 62 s) arrive a second late
  s.engine.impair = (link, f) => {
    const d = f.msg.data || {};
    return f.msg.protocol === 'ipsec' && f.msg.type === 'INFORMATIONAL' && f.msg.sender === 'b' && !d.response && !d.del && s.now >= 60000 && s.now <= 63000 ? { delay: 1000 } : null;
  };
  const t0 = s.now;
  s.runTo(t0 + 80000);
  assert.ok(notes(s, 'a', 'old IKE SA deleted', t0).length >= 1);
  assert.equal(s.events().filter((e) => e.t >= t0 && e.kind === 'state' && /Dead Peer Detection/.test(e.detail)).length, 0, 'nobody deleted its SAs by DPD');
  // b's DPD after the rekey: in the new SA, answered
  const dpdAfter = msgs(s, 'b', 'INFORMATIONAL', 64000).filter((e) => /request \(message ID \d+\): DPD/.test(e.detail));
  assert.ok(dpdAfter.length >= 1);
  assert.ok(msgs(s, 'a', 'INFORMATIONAL', 64000).some((e) => /response \(message ID \d+\): DPD/.test(e.detail)));
  converged(s, t0);
});

test('IKEv2: the responder rekeys the IKE SA itself (its own lifetime shorter), its response lost once — the initiator answers the retransmission from its kept response on the old SA; both in the new SA', () => {
  const t = TUN('{dpd_interval: 600}').replace('  - id: b\n    type: router\n', '  - id: b\n    type: router\n    simulation: {ike_lifetime: 120}\n');
  const s = new S.Simulation(model(t));
  s.runTo(30000);
  let lost = 0;
  s.engine.impair = (link, f) => (f.msg.protocol === 'ipsec' && f.msg.type === 'CREATE_CHILD_SA' && (f.msg.data || {}).response && (f.msg.data || {}).what === 'ike' && lost++ === 0 ? { lose: true } : null);
  const t0 = s.now;
  s.runTo(t0 + 80000);
  const req = msgs(s, 'b', 'CREATE_CHILD_SA', t0).filter((e) => /rekeys the IKE SA/.test(e.detail));
  assert.ok(req.length >= 2, req.map((e) => e.detail).join('\n'));
  assert.ok(msgs(s, 'a', 'CREATE_CHILD_SA', t0).some((e) => /sent again on the old IKE SA/.test(e.detail)));
  assert.ok(notes(s, 'b', 'old IKE SA deleted', t0).length === 1);
  converged(s, t0);
});
