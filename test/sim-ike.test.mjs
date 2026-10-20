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
