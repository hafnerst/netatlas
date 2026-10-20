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
  assert.ok(bDown && bDown.t > aDown.t && /Dead Peer Detection|the peer starts a new IKE SA/.test(bDown.detail), bDown && bDown.detail);
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
