// TCP's byte stream (analysis/sim/tcp.ts) and the connections that use it
// (transport.ts): separate send and receive sequence state, SYN and FIN
// taking a sequence number each, cumulative acknowledgments, retransmitted
// segments keeping their ranges, duplicates and out-of-order segments, and
// every message delivered exactly once, after all its bytes. Then whole
// connections with segments lost, duplicated and delayed on the cable
// (Engine.impair), checked by the state, the deliveries and the headers
// the inspector shows — never by the animation alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const T = load('analysis/sim/tcp.js');
const S = load('analysis/sim/simulation.js');

// ------------------------------------------------------------------ the stream

/** Two ends after a handshake: a (ISS 1000) and b (ISS 5000). */
function pair() {
  const a = new T.TcpStream(1000);
  const b = new T.TcpStream(5000);
  const syn = a.syn('SYN');
  b.synIn(syn.seq);
  const synack = b.syn('SYN-ACK');
  a.synIn(synack.seq);
  assert.equal(a.ack(b.ackNo), true, 'the SYN-ACK acknowledges the SYN');
  assert.equal(b.ack(a.ackNo), true, 'the ACK acknowledges the SYN-ACK');
  return { a, b };
}

test('stream: the SYN and the FIN take one sequence number each; the acknowledgments are the next byte expected', () => {
  const { a, b } = pair();
  assert.equal(a.sndNxt, 1001);
  assert.equal(a.ackNo, 5001);
  assert.equal(b.ackNo, 1001);
  const segs = a.write(300, 1460, 'request', 'req');
  assert.deepEqual(segs.map((s) => [s.seq, s.len]), [[1001, 300]]);
  const r = b.receive(segs[0]);
  assert.equal(r.ack, 1301);
  assert.deepEqual(r.msgs.map((m) => m.msg), ['req']);
  const fin = a.fin('FIN');
  assert.equal(fin.seq, 1301);
  assert.equal(a.sndNxt, 1302);
  const rf = b.receive(fin);
  assert.equal(rf.fin, true);
  assert.equal(rf.ack, 1302, 'the FIN is acknowledged by its own number + 1');
  assert.equal(a.ack(1302), true);
  assert.equal(a.finAcked, true);
  assert.equal(a.idle, true);
});

test('stream: segments of a message by the MSS; the message is delivered once, after its last byte, in order', () => {
  const { a, b } = pair();
  const segs = a.write(3000, 1000, 'answer', 'A');
  assert.deepEqual(segs.map((s) => [s.seq, s.len, !!s.mark]), [[1001, 1000, false], [2001, 1000, false], [3001, 1000, true]]);
  // the last first: kept out of order, nothing delivered, the acknowledgment still asks for 1001
  const r3 = b.receive(segs[2]);
  assert.deepEqual([r3.outOfOrder, r3.ack, r3.msgs.length], [true, 1001, 0]);
  const r1 = b.receive(segs[0]);
  assert.deepEqual([r1.ack, r1.msgs.length], [2001, 0], 'a gap remains');
  const r2 = b.receive(segs[1]);
  assert.equal(r2.ack, 4001, 'the gap filled: what waited follows');
  assert.deepEqual(r2.msgs.map((m) => m.msg), ['A']);
  // every one of them again: duplicates, acknowledged, never delivered again
  for (const s of segs) {
    const d = b.receive(s);
    assert.deepEqual([d.dup, d.ack, d.msgs.length], [true, 4001, 0]);
  }
  assert.equal(b.received, 3000);
});

test('stream: cumulative acknowledgments; one of nothing new or of something never sent changes nothing', () => {
  const { a } = pair();
  a.write(1000, 500, 'x', 'X');
  assert.equal(a.out.length, 2);
  assert.equal(a.ack(1001), false, 'at SND.UNA: nothing new');
  assert.equal(a.ack(9999), false, 'beyond SND.NXT: never sent');
  assert.equal(a.sndUna, 1001);
  assert.equal(a.ack(1501), true);
  assert.deepEqual(a.out.map((s) => s.seq), [1501]);
  assert.equal(a.ack(1301), false, 'an older acknowledgment never moves SND.UNA back');
  assert.equal(a.ack(2001), true);
  assert.equal(a.idle, true);
});

test('stream: a retransmission keeps its range; a smaller MSS splits the unacknowledged range, the mark stays at its byte', () => {
  const { a, b } = pair();
  const first = a.write(1400, 1400, 'answer', 'A')[0];
  assert.equal(a.earliest(), first);
  a.resegment(600);
  assert.deepEqual(a.out.map((s) => [s.seq, s.len, !!s.mark]), [[1001, 600, false], [1601, 600, false], [2201, 200, true]]);
  // the original (big) one arrives after all: the pieces after it are duplicates, the message once
  const r = b.receive(first);
  assert.deepEqual(r.msgs.map((m) => m.msg), ['A']);
  for (const s of a.out) assert.equal(b.receive(s).dup, true);
  // a partly acknowledged segment: only its rest is split
  const c = pair();
  c.a.write(1000, 1000, 'x', 'X');
  c.a.ack(1401);
  c.a.resegment(300);
  assert.deepEqual(c.a.out.map((s) => [s.seq, s.len]), [[1401, 300], [1701, 300]]);
});

test('stream: two messages, the second whole first: nothing is delivered out of order; both in order once the gap is filled', () => {
  const { a, b } = pair();
  const [m1] = a.write(100, 1460, 'one', 'M1');
  const [m2] = a.write(100, 1460, 'two', 'M2');
  assert.deepEqual(b.receive(m2).msgs, []);
  assert.deepEqual(b.receive(m1).msgs.map((m) => m.msg), ['M1', 'M2']);
});

// ------------------------------------------------------------------ connections

const CHAIN = (x = {}) => `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: r1
    type: router
    interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.12.1/30${x.mtu ? ', mtu: ' + x.mtu : ''}}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}]${x.r1 || ''}
  - id: r2
    type: router
    interfaces: [{id: g0, ip: 10.0.12.2/30${x.mtu ? ', mtu: ' + x.mtu : ''}}, {id: g1, ip: 10.0.2.1/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: tcp/80${x.srv || ''}}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
  - {id: l2, a: "r1:g1", b: "r2:g0"}
  - {id: l3, a: "r2:g1", b: "srv:eth0"}
`;

const sim = (text, opts) => new S.Simulation(model(text), opts);
/** the TCP segments a device sent after t, as [flags, seq, ack, bytes] from their headers as sent (the packet inspector's) */
const segs = (s, dev, t0) =>
  s.events()
    .filter((e) => e.kind === 'message' && e.device === dev && e.t >= t0 && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp')
    .map((e) => {
      const l4 = e.hdr.l4;
      const ip = e.hdr.l3[e.hdr.l3.length - 1];
      // (the TCP header: 20 bytes, 24 with the MSS option of a SYN)
      return [l4.flags.join(','), l4.seq, l4.ack === undefined ? null : l4.ack, ip.len - (ip.version === 4 ? 20 : 40) - (l4.mss !== undefined ? 24 : 20)];
    });

/** Lose (or duplicate, delay) the n-th frame on a cable that a predicate picks. */
function impair(s, pick, what, n = 1) {
  let seen = 0;
  s.engine.impair = (link, frame) => {
    if (!pick(link, frame)) return null;
    seen++;
    return seen === n ? what : null;
  };
}
const isTcp = (from, flags) => (link, frame) => !!frame.ip && frame.ip.l4 && frame.ip.l4.proto === 'tcp' && (from === undefined || link === from) && (!flags || flags(frame.ip.l4.flags || [], frame.ip));
/** the server's segments (from port 80), the client's (to port 80) */
const fromSrv = (ip) => ip.l4.sport === 80;
const toSrv = (ip) => ip.l4.dport === 80;

test('connection: the headers carry the stream’s own numbers: ISS, ISS + 1 after the SYN, the acknowledgment of each byte', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.result, 'connected and answered (1460 bytes)');
  const pc = segs(s, 'pc', t0);
  const sv = segs(s, 'srv', t0);
  const [, iss] = pc[0];
  const [, irs] = sv[0];
  assert.deepEqual(pc.slice(0, 2), [['SYN', iss, null, 0], ['ACK', iss + 1, irs + 1, 0]]);
  assert.deepEqual(pc[2], ['PSH,ACK', iss + 1, irs + 1, 120], 'the request: 120 bytes from ISS + 1');
  assert.deepEqual(sv[0], ['SYN,ACK', irs, iss + 1, 0]);
  assert.deepEqual(sv[1], ['ACK', irs + 1, iss + 121, 0], 'the server acknowledges the 120 bytes');
  assert.deepEqual(sv[2], ['PSH,ACK', irs + 1, iss + 121, 1460]);
  // the client acknowledges the answer, then closes: FIN at ISS + 121; the server's FIN at IRS + 1461; the last ACK
  assert.deepEqual(pc.slice(3), [['ACK', iss + 121, irs + 1461, 0], ['FIN,ACK', iss + 121, irs + 1461, 0], ['ACK', iss + 122, irs + 1462, 0]]);
  assert.deepEqual(sv[3], ['FIN,ACK', irs + 1461, iss + 122, 0]);
  // two connections never start from the same sequence number
  const t2 = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t1 = s.now;
  s.runTo(t1 + 3000);
  assert.equal(t2.ok, true);
  assert.notEqual(segs(s, 'pc', t1)[0][1], iss);
});

test('connection: a lost answer segment is sent again with the same range after the RTO; delivered once; the test answered', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l3', (f, ip) => f.indexOf('PSH') >= 0 && fromSrv(ip)), { lose: true });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(t.ok, true, t.result);
  assert.equal(t.result, 'connected and answered (1460 bytes)');
  const data = segs(s, 'srv', t0).filter((x) => x[0] === 'PSH,ACK');
  assert.equal(data.length, 2, 'sent, lost, sent again');
  assert.deepEqual(data[0], data[1], 'the retransmission carries the same sequence range and acknowledgment');
  const re = s.events().filter((e) => e.device === 'srv' && e.protocol === 'tcp' && /retransmission 1 \(timeout 1 s/.test(e.detail));
  assert.equal(re.length, 1);
  assert.ok(re[0].t - t0 >= 1000, 'after the initial RTO (1 s)');
  assert.equal(s.events().filter((e) => e.device === 'pc' && /Test answered/.test(e.what)).length, 1);
});

test('connection: a duplicated answer is acknowledged again and delivered once; a duplicated request is answered once', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l3', (f, ip) => f.indexOf('PSH') >= 0 && fromSrv(ip)), { dup: true });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.ok, true);
  assert.ok(s.events().some((e) => e.device === 'pc' && /a duplicate \(seq \d+\): acknowledges again, delivers nothing/.test(e.detail)));
  assert.equal(s.events().filter((e) => e.device === 'pc' && e.what === 'Test answered').length, 1);
  // the request twice: the server answers once
  const s2 = sim(CHAIN());
  s2.runTo(2500);
  impair(s2, isTcp('l1', (f, ip) => f.indexOf('PSH') >= 0 && toSrv(ip)), { dup: true });
  const u = s2.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const u0 = s2.now;
  s2.runTo(u0 + 3000);
  assert.equal(u.ok, true);
  assert.equal(segs(s2, 'srv', u0).filter((x) => x[0] === 'PSH,ACK').length, 1, 'one answer');
});

test('connection: a lost SYN-ACK — the client sends its SYN again, the server its SYN-ACK; one connection, answered', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l3', (f) => f.indexOf('SYN') >= 0 && f.indexOf('ACK') >= 0), { lose: true });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 5000);
  assert.equal(t.ok, true, t.result);
  const synacks = segs(s, 'srv', t0).filter((x) => x[0] === 'SYN,ACK');
  assert.ok(synacks.length >= 2);
  assert.ok(synacks.every((x) => x[1] === synacks[0][1]), 'the SYN-ACK keeps its sequence number');
  const syns = segs(s, 'pc', t0).filter((x) => x[0] === 'SYN');
  assert.ok(syns.length >= 2 && syns.every((x) => x[1] === syns[0][1]), 'the SYN keeps its sequence number');
});

test('connection: a lost handshake ACK — the request’s own ACK completes the handshake at the server', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l1', (f, ip) => f.length === 1 && f[0] === 'ACK' && toSrv(ip)), { lose: true });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.ok, true, t.result);
  assert.ok(s.events().some((e) => e.kind === 'drop' && /lost on l1 \(an impairment of the test\): TCP \[A\]$/.test(e.detail)), 'the handshake ACK was lost');
  // the server never retransmitted its SYN-ACK: the request (ACK set) completed the handshake
  assert.equal(segs(s, 'srv', t0).filter((x) => x[0] === 'SYN,ACK').length, 1);
});

test('connection: a delayed segment overtaken by the next ones: kept out of order, the request whole and answered once', () => {
  // a 3000-byte request: three segments (1460, 1460, 80); the first is held up 50 ms on the first cable
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l1', (f, ip) => (ip.len || 0) > 1000 && toSrv(ip)), { delay: 50 });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80, size: 3000 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.ok, true, t.result);
  const ooo = s.events().filter((e) => e.device === 'srv' && /out of order \(seq \d+, expected \d+\): kept/.test(e.detail));
  assert.equal(ooo.length, 2, 'the second and third arrive first');
  const req = segs(s, 'pc', t0).filter((x) => x[3] > 0).map((x) => x[3]);
  assert.deepEqual(req, [1460, 1460, 80]);
  // the server's acknowledgments: two duplicates asking for the first byte, then all 3000
  const acks = segs(s, 'srv', t0).filter((x) => x[0] === 'ACK').map((x) => x[2]);
  const iss = segs(s, 'pc', t0)[0][1];
  assert.deepEqual(acks.slice(0, 3), [iss + 1, iss + 1, iss + 3001]);
  assert.equal(segs(s, 'srv', t0).filter((x) => x[0] === 'PSH,ACK').length, 1, 'one answer');
});

test('connection: PMTUD shrinks the segments after Fragmentation Needed; with ICMP errors blocked the answer never arrives (a black hole)', () => {
  const s = sim(CHAIN({ mtu: 1400 }));
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(t.ok, true, t.result);
  assert.equal(t.result, 'connected and answered (1460 bytes)');
  assert.ok(s.events().some((e) => e.device === 'srv' && e.what === 'path MTU' && /to 10\.0\.1\.10 is 1400 bytes now \(Frag Needed from 10\.0\.2\.1 \(r2\)\)/.test(e.detail)));
  // the answer went again in segments of at most 1360 bytes over the same range (1460 = 1360 + 100)
  const data = segs(s, 'srv', t0).filter((x) => x[3] > 0);
  assert.deepEqual(data.map((x) => x[3]), [1460, 1360, 100]);
  assert.equal(data[1][1], data[0][1], 'the first piece starts where the big segment did');
  assert.equal(data[2][1], data[0][1] + 1360);
  assert.ok(s.events().some((e) => e.device === 'srv' && /sent again in smaller segments \(Frag Needed from 10\.0\.2\.1 \(r2\): path MTU 1400\)/.test(e.detail)));
  // the client acknowledged the pieces and got the answer once
  assert.equal(s.events().filter((e) => e.device === 'pc' && e.what === 'Test answered').length, 1);
  // r2 sends no ICMP errors: srv never learns, retransmits the big segment, and the client times out
  const b = sim(CHAIN({ mtu: 1400 }).replace('    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]', '    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]\n    simulation: {icmp_errors: "off"}'));
  b.runTo(2500);
  const bt = b.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const b0 = b.now;
  b.runTo(b0 + 8000);
  assert.equal(bt.ok, false);
  assert.match(bt.result, /^no answer within 5 s/);
  assert.ok(!b.events().some((e) => e.device === 'srv' && e.what === 'path MTU'));
  assert.ok(segs(b, 'srv', b0).filter((x) => x[3] === 1460).length >= 2, 'the big segment again and again');
});

test('connection: a lost FIN is sent again with its sequence number; both ends close (TIME_WAIT, then gone)', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  impair(s, isTcp('l1', (f, ip) => f.indexOf('FIN') >= 0 && toSrv(ip)), { lose: true });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.ok, true);
  const fins = segs(s, 'pc', t0).filter((x) => x[0] === 'FIN,ACK');
  assert.equal(fins.length, 2);
  assert.deepEqual(fins[0], fins[1]);
  assert.ok(s.connTable('pc').some((r) => r.state === 'TIME_WAIT'));
  assert.ok(!s.connTable('srv').some((r) => r.state !== 'LISTEN'), 'the server end is closed');
  s.runTo(s.now + 61000);
  assert.ok(!s.connTable('pc').some((r) => r.state === 'TIME_WAIT'));
});

test('connection kept open: the keepalive probe carries SND.NXT − 1 and is answered; unanswered probes reset it', () => {
  const s = sim(CHAIN(), { params: { 'tcp-keepalive': 5000 } });
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80, keep: true });
  const t0 = s.now;
  s.runTo(t0 + 7000);
  assert.equal(t.ok, true);
  const probe = segs(s, 'pc', t0).find((x, i, all) => i > 1 && x[0] === 'ACK' && x[1] === all[1][1] - 1);
  assert.ok(probe, 'a probe one below SND.NXT');
  assert.ok(s.events().some((e) => e.device === 'srv' && /answers the keepalive/.test(e.detail)));
  assert.ok(s.connTable('pc').some((r) => r.state === 'ESTABLISHED'));
  // the server gone: the probes go unanswered, 9 of them 75 s apart, then a RST
  s.powerOff('srv');
  s.runTo(s.now + 5000 + 10 * 75000);
  assert.ok(s.events().some((e) => e.device === 'pc' && /reset: none of 9 keepalive probes answered/.test(e.detail)));
  assert.ok(!s.connTable('pc').some((r) => r.state === 'ESTABLISHED'));
});
