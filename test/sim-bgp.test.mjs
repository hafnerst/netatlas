// BGP over the common transport (proto-routing.ts, proto-tcp.ts,
// transport.ts): its connection is a TCP connection of the transport (the
// connection table, retransmission, a listener only where a speaker runs),
// and its OPEN is structured state — the peer AS checked, the hold time
// negotiated (the smaller one; 0: no keepalives and no hold timer; 1 and
// 2 refused), the BGP identifier checked — with a NOTIFICATION when it is
// refused. Checked by the sessions' states and the messages sent, not by
// log wording alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/** a and b over one cable; extra relation attributes, b's AS. */
const PAIR = (attrs = '', bAs = 65002) => `netatlas: 1
title: bgp
devices:
  - {id: a, type: router, interfaces: [{id: g0, ip: 10.0.0.1/30}], protocols: {bgp: {asn: 65001}}}
  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], protocols: {bgp: {asn: ${bAs}}}}
links:
  - {id: l, a: "a:g0", b: "b:g0"}
relations:
  - {id: ebgp, protocol: bgp, endpoints: ["a:g0", "b:g0"]${attrs ? ', attrs: {' + attrs + '}' : ''}}
`;
const st = (s, dev) => (s.status().find((x) => x.protocol === 'bgp' && x.device === dev) || {});
const msgs = (s, dev, type, t0 = 0) => s.events().filter((e) => e.kind === 'message' && e.protocol === 'bgp' && e.device === dev && e.what === type && e.t >= t0);

test('BGP: the session’s TCP connection is the transport’s — in the connection table, from the session’s address to port 179', () => {
  const s = sim(PAIR());
  s.runTo(6000);
  assert.equal(st(s, 'a').state, 'Established');
  assert.equal(st(s, 'b').state, 'Established');
  const ca = s.connTable('a').find((r) => r.remote === '10.0.0.2:179');
  assert.ok(ca && ca.state === 'ESTABLISHED', JSON.stringify(s.connTable('a')));
  assert.equal(ca.local.split(':')[0], '10.0.0.1');
  const cb = s.connTable('b').find((r) => r.local === '10.0.0.2:179');
  assert.ok(cb && cb.state === 'ESTABLISHED');
  // its OPEN, KEEPALIVE and UPDATE are TCP data with real sequence numbers; the handshake is drawn as BGP's
  const open = msgs(s, 'a', 'OPEN')[0];
  assert.match(open.detail, /version 4, AS 65001, hold time 180 s, BGP identifier 10\.0\.0\.1, IPv4 unicast — TCP 10\.0\.0\.1:\d+ → 10\.0\.0\.2:179 \[PSH,ACK\] seq \d+, ack \d+, 45 bytes/);
  assert.equal(msgs(s, 'a', 'TCP SYN').length, 1);
  assert.equal(msgs(s, 'b', 'TCP SYN-ACK').length, 1);
  // the negotiated hold time and keepalive are the session's
  assert.match(st(s, 'a').detail, /keepalive 1 min, hold 3 min \(negotiated: the smaller of 180 s and 180 s\)/);
});

test('BGP: a peer in another AS than expected is refused with a NOTIFICATION (Bad Peer AS); the session stays down', () => {
  const s = sim(PAIR('peer-as.a: 65099'));
  s.runTo(10000);
  assert.notEqual(st(s, 'a').state, 'Established');
  assert.notEqual(st(s, 'b').state, 'Established');
  const n = msgs(s, 'a', 'NOTIFICATION');
  assert.ok(n.length >= 1);
  assert.match(n[0].detail, /OPEN Message Error \/ Bad Peer AS: AS 65002 in the OPEN, a expects AS 65099 \(its peer-as\)/);
  assert.ok(s.events().some((e) => e.device === 'b' && e.protocol === 'bgp' && /NOTIFICATION from a: OPEN Message Error \/ Bad Peer AS/.test(e.detail)));
  // iBGP: the peer must be in the own AS
  const i = sim(PAIR('', 65001).replace('protocol: bgp', 'protocol: ibgp'));
  i.runTo(6000);
  assert.equal(st(i, 'a').state, 'Established');
  const j = sim(PAIR().replace('protocol: bgp', 'protocol: ibgp'));
  j.runTo(6000);
  assert.notEqual(st(j, 'a').state, 'Established');
  assert.ok(msgs(j, 'a', 'NOTIFICATION').some((e) => /Bad Peer AS: AS 65002 in the OPEN, a expects AS 65001 \(iBGP: its own AS\)/.test(e.detail)));
});

test('BGP hold time: the smaller of the two OPENs, keepalives a third of it; 0 means no keepalives and no hold timer; 1 and 2 are refused', () => {
  const s = sim(PAIR('hold.a: 30, hold.b: 90'));
  s.runTo(40000);
  assert.equal(st(s, 'a').state, 'Established');
  assert.match(st(s, 'a').detail, /keepalive 10 s, hold 30 s \(negotiated: the smaller of 30 s and 90 s\)/);
  assert.match(st(s, 'b').detail, /keepalive 10 s, hold 30 s \(negotiated: the smaller of 90 s and 30 s\)/);
  const ka = msgs(s, 'b', 'KEEPALIVE').map((e) => e.t);
  assert.ok(ka.length >= 3);
  assert.ok(Math.abs(ka[ka.length - 1] - ka[ka.length - 2] - 10000) < 50, 'b sends every 10 s, not its own 30 s');
  // the hold timer of the negotiated 30 s takes the session down when the cable fails
  s.fail('link:l');
  s.runTo(s.now + 35000);
  assert.equal(st(s, 'a').state, 'Idle');
  assert.ok(s.events().some((e) => e.device === 'a' && /hold timer expired \(30 s, negotiated\)/.test(e.detail)));
  // hold 0 on one side: 0 negotiated; no KEEPALIVE after the one that confirms the OPEN, and the session never times out
  const z = sim(PAIR('hold.a: 0'));
  z.runTo(5000);
  assert.equal(st(z, 'a').state, 'Established');
  assert.match(st(z, 'a').detail, /hold time 0 negotiated: no keepalives, no hold timer/);
  const before = msgs(z, 'a', 'KEEPALIVE').length;
  z.fail('link:l');
  z.runTo(z.now + 400000);
  assert.equal(msgs(z, 'a', 'KEEPALIVE').length, before, 'no keepalives at all');
  assert.equal(st(z, 'b').state, 'Established', 'no hold timer: the session is not taken down by BGP');
  // hold 2: refused by the peer
  const two = sim(PAIR('hold.a: 2'));
  two.runTo(6000);
  assert.notEqual(st(two, 'b').state, 'Established');
  assert.ok(msgs(two, 'b', 'NOTIFICATION').some((e) => /Unacceptable Hold Time \(2 s\)/.test(e.detail)));
});

test('BGP over TCP: a lost UPDATE is retransmitted by TCP (same sequence range); the session stays Established', () => {
  const s = sim(PAIR());
  let n = 0;
  s.engine.impair = (link, frame) => (frame.msg.protocol === 'bgp' && frame.msg.type === 'UPDATE' && frame.ip && frame.ip.src.bytes[3] === 1 && ++n === 1 ? { lose: true } : null);
  s.runTo(8000);
  assert.equal(st(s, 'a').state, 'Established');
  const seq = (e) => /\] seq (\d+)/.exec(e.detail)[1];
  const all = msgs(s, 'a', 'UPDATE');
  const ups = all.filter((e) => seq(e) === seq(all[0]));
  assert.equal(ups.length, 2, 'sent, lost, sent again with the same sequence number');
  assert.match(ups[1].detail, /retransmission 1 \(timeout 1 s\)/);
});

test('BGP: no AS number — no speaker: nothing listens on 179, the peer’s SYN is refused, both stay down', () => {
  const s = sim(PAIR().replace('  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], protocols: {bgp: {asn: 65002}}}', '  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}]}'));
  s.runTo(6000);
  assert.equal(st(s, 'b').state, 'Idle');
  assert.ok(s.events().some((e) => e.device === 'b' && /no BGP speaker runs on b: port 179 is open only while one does/.test(e.detail)));
  assert.ok(s.events().some((e) => e.device === 'a' && e.protocol === 'bgp' && /failed: connection refused/.test(e.detail)));
});
