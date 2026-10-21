// TCP's correctness where a connection meets the unexpected, and the one
// notation of its flags (analysis/sim/tcp.ts): the label beside every dot
// gives the flags of the segment's own header ([S], [S,A], [P,A] …); a
// health check completes the handshake before it resets; a power-off ends
// every timer of its connections (nothing old is sent after the reboot);
// unacceptable segments are refused as RFC 9293 says ([R] or [R,A] by the
// segment's ACK); a FIN closes one direction (CLOSE_WAIT, a half-open
// connection still delivers); TIME_WAIT starts again with a FIN sent again;
// the MSS of the peer's SYN bounds the segments. Every assertion reads the
// headers as sent (the packet inspector's), the states and the deliveries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const T = load('analysis/sim/tcp.js');
const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

const CHAIN = (x = {}) => `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]${x.pc || ''}}
  - id: r1
    type: router
    interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.12.1/30}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}]
  - id: r2
    type: router
    interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.2.1/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24${x.srvMtu ? ', mtu: ' + x.srvMtu : ''}}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80${x.listen || ''}"${x.srv || ''}}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
  - {id: l2, a: "r1:g1", b: "r2:g0"}
  - {id: l3, a: "r2:g1", b: "srv:eth0"}
`;

const sim = (text, opts) => new S.Simulation(model(text), opts);
/** the TCP segments a device sent after t0, from their headers as sent: { flags, seq, ack, len, sport, dport, mss, label, t } */
const segs = (s, dev, t0 = 0) =>
  s.events()
    .filter((e) => e.kind === 'message' && e.device === dev && e.t >= t0 && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp')
    .map((e) => {
      const l4 = e.hdr.l4;
      const ip = e.hdr.l3[e.hdr.l3.length - 1];
      return { flags: T.tcpFlagsText(l4.flags), seq: l4.seq, ack: l4.ack, len: ip.len - (ip.version === 4 ? 20 : 40) - T.tcpHeaderLen(l4), iplen: ip.len, sport: l4.sport, dport: l4.dport, mss: l4.mss, label: e.hdr.label, t: e.t };
    });
/** Change (lose, delay …) frames on a cable: `fn(frame)` returns the impairment, or null. */
const impair = (s, link, fn) => {
  s.engine.impair = (l, frame) => (l === link && frame.ip && frame.ip.l4 && frame.ip.l4.proto === 'tcp' ? fn(frame) : null);
};
const flagsOf = (frame) => T.tcpFlagsText(frame.ip.l4.flags);

// ------------------------------------------------------------------ the notation

test('flags: one order (S, F, R, P, A, U, E, C) and one letter each; an empty set is []; the long form names them', () => {
  assert.equal(T.tcpFlagsText(['ACK', 'SYN']), '[S,A]');
  assert.equal(T.tcpFlagsText(['ACK', 'PSH']), '[P,A]');
  assert.equal(T.tcpFlagsText(['ACK', 'FIN']), '[F,A]');
  assert.equal(T.tcpFlagsText(['RST']), '[R]');
  assert.equal(T.tcpFlagsText(['CWR', 'ECE', 'URG', 'ACK', 'PSH', 'RST', 'FIN', 'SYN']), '[S,F,R,P,A,U,E,C]');
  assert.equal(T.tcpFlagsText([]), '[]', 'no flags: said, not an invented ACK');
  assert.equal(T.tcpFlagsText(undefined), '[]');
  assert.equal(T.tcpFlagsLong(['ACK', 'SYN']), 'SYN (S), ACK (A)');
  assert.equal(T.tcpFlagsLong([]), 'none');
  // the label: the application's message, or the protocol the connection is for, or TCP; the size of plain data; a retransmission
  assert.equal(T.segmentLabel({ flags: ['SYN'], to: '10.0.2.10:80' }), 'TCP [S] → 10.0.2.10:80');
  assert.equal(T.segmentLabel({ flags: ['PSH', 'ACK'], bytes: 120 }), 'TCP [P,A] · 120 B');
  assert.equal(T.segmentLabel({ flags: ['PSH', 'ACK'], app: 'BGP OPEN', bytes: 45 }), 'BGP OPEN [P,A]');
  assert.equal(T.segmentLabel({ flags: ['SYN', 'ACK'], owner: 'BGP' }), 'BGP TCP [S,A]');
  assert.equal(T.segmentLabel({ flags: ['SYN'], retx: true, to: '10.0.2.10:80' }), 'TCP [S] → 10.0.2.10:80 (retransmission)');
  assert.equal(T.segmentLabel({ flags: ['ACK'], keepalive: true }), 'TCP keepalive [A]');
});

test('labels: a fresh connection shows [S], [S,A], [A] as three packets, then [P,A] data, [F,A] — each label from its own header', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  const n0 = s.engine.flights.length;
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(t.ok, true, t.result);
  const pc = segs(s, 'pc', t0);
  const sv = segs(s, 'srv', t0);
  assert.deepEqual(pc.map((x) => x.flags), ['[S]', '[A]', '[P,A]', '[A]', '[F,A]', '[A]']);
  assert.deepEqual(sv.map((x) => x.flags), ['[S,A]', '[A]', '[P,A]', '[F,A]']);
  // the three segments of the handshake, in their causal order: the SYN, the SYN-ACK after it arrived, the ACK after that
  const [syn] = pc;
  const [synack] = sv;
  const ack = pc[1];
  assert.ok(syn.t < synack.t && synack.t < ack.t);
  assert.equal(synack.ack, syn.seq + 1);
  assert.deepEqual([ack.seq, ack.ack], [syn.seq + 1, synack.seq + 1]);
  assert.deepEqual([pc[0].label, sv[0].label, pc[1].label, pc[2].label], ['TCP [S] → 10.0.2.10:80', 'TCP [S,A]', 'TCP [A]', 'TCP [P,A] · 120 B']);
  // every dot of a TCP segment, on every cable, says the flags of the header it carries there
  const tcp = s.engine.flights.slice(n0).filter((f) => f.view === 'physical' && f.hdr && f.hdr.l4 && f.hdr.l4.proto === 'tcp');
  assert.ok(tcp.length >= 30, String(tcp.length));
  for (const f of tcp) assert.ok(f.label.indexOf(T.tcpFlagsText(f.hdr.l4.flags)) >= 0, `${f.label} vs ${f.hdr.l4.flags}`);
  // the log line names the same flags
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'pc' && /^TCP 10\.0\.1\.10:\d+ → 10\.0\.2\.10:80 \[S\] seq \d+, MSS 1460: opens a connection/.test(e.detail)));
});

test('labels: every TCP header in the examples comes from a connection of the transport (none is made up from a message name), and its label gives its flags', () => {
  let seen = 0;
  for (const name of ['protocol-simulation.yaml', 'datacenter-evpn.yaml', 'ot-network.yaml', 'dmz-services.yaml']) {
    const s = new S.Simulation(model(example(name)));
    s.runTo(60000);
    const tcp = s.engine.flights.filter((f) => f.view === 'physical' && f.hdr && f.hdr.l4 && f.hdr.l4.proto === 'tcp');
    for (const f of tcp) assert.ok(f.label.indexOf(T.tcpFlagsText(f.hdr.l4.flags)) >= 0, `${name}: ${f.label} vs ${f.hdr.l4.flags}`);
    // a message sent by unicast (never over a connection) has no TCP header: LDP's Hellos are UDP 646
    const ev = s.events().filter((e) => e.kind === 'message' && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp');
    for (const e of ev) assert.ok(/ \[[SFRPAUEC,]*\] seq \d+/.test(e.detail), `${name}: ${e.what}: ${e.detail}`);
    seen += tcp.length;
  }
  assert.ok(seen > 100, String(seen));
});

// ------------------------------------------------------------------ health checks

const LB = `netatlas: 1
title: lb
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: lb, type: load_balancer, interfaces: [{id: eth0, ip: 10.0.0.100/24}]}
  - {id: w1, type: server, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "lb:eth0", b: "sw:p2"}
  - {id: c, a: "w1:eth0", b: "sw:p3"}
relations:
  - {id: front, protocol: https, endpoints: [pc, lb]}
  - {id: m1, protocol: https, endpoints: [lb, w1]}
`;

test('health check: a TCP connect check — [S], [S,A], the third [A], then [R,A]; the result says the connection was established', () => {
  const s = sim(LB);
  s.runTo(8000);
  const lb = segs(s, 'lb').filter((x) => x.dport === 443);
  const w1 = segs(s, 'w1').filter((x) => x.sport === 443);
  // one check: the lb's segments of one connection (its client port)
  const port = lb[0].sport;
  const one = lb.filter((x) => x.sport === port).map((x) => x.flags);
  assert.deepEqual(one, ['[S]', '[A]', '[R,A]'], 'the handshake completes before the check resets it');
  assert.deepEqual(w1.filter((x) => x.dport === port).map((x) => x.flags), ['[S,A]']);
  const ack = lb.find((x) => x.sport === port && x.flags === '[A]');
  const rst = lb.find((x) => x.sport === port && x.flags === '[R,A]');
  assert.deepEqual([rst.seq, rst.ack], [ack.seq, ack.ack], 'the RST at SND.NXT with the acknowledgment');
  const done = s.transport.tests.find((t) => t.source === 'health' && t.ok);
  assert.equal(done.result, 'connection established (the handshake completed), then closed with a RST');
  // the server's end: established by the ACK, then reset — nothing of it is left
  assert.ok(s.events().some((e) => e.device === 'w1' && e.what === 'connection closed' && /reset by 10\.0\.0\.100/.test(e.detail)));
});

// ------------------------------------------------------------------ lifecycle

test('power-off with unacknowledged data and a quick reboot: no segment, retransmission or timer of the old connection survives', () => {
  const s = sim(CHAIN({ pc: ', simulation: {boot_time: 1}' }));
  s.runTo(2500);
  // the request never reaches the server: pc retransmits it
  impair(s, 'l1', (f) => (f.ip.l4.dport === 80 && f.ip.l4.flags.indexOf('PSH') >= 0 ? { lose: true } : null));
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 1800);
  const port = segs(s, 'pc', t0)[0].sport;
  assert.ok(segs(s, 'pc', t0).filter((x) => x.sport === port && x.flags === '[P,A]').length >= 2, 'retransmitted at least once');
  const conns = (dev) => s.connTable(dev).filter((r) => r.proto === 'tcp' && r.state !== 'LISTEN');
  assert.equal(conns('pc').length, 1);
  s.powerOff('pc');
  const off = s.now;
  s.runTo(off + 200);
  assert.equal(conns('pc').length, 0, 'gone with the power');
  s.powerOn('pc');
  s.runTo(s.now + 60000);
  assert.equal(s.deviceState('pc').state, 'operational');
  // nothing of the old connection after the power-off: no segment from its port, no retransmission in the log
  assert.deepEqual(segs(s, 'pc', off).filter((x) => x.sport === port), []);
  assert.equal(s.events().filter((e) => e.t >= off && e.kind === 'message' && e.device === 'pc' && /retransmission/.test(e.detail)).length, 0);
  // the server never had it (its request was lost): its half-open end resets nothing it should not; the test failed
  assert.equal(t.ok, false);
});

test('a rebooted server answers a kept-open connection’s keepalive with [R] at the probe’s acknowledgment; the client resets', () => {
  const s = sim(CHAIN({ pc: ', simulation: {tcp_keepalive: 20}', srv: ', boot_time: 1' }));
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80, keep: true });
  s.runTo(s.now + 2000);
  assert.equal(t.ok, true, t.result);
  s.powerOff('srv');
  s.runTo(s.now + 100);
  s.powerOn('srv');
  const t1 = s.now;
  s.runTo(t1 + 30000);
  const probe = segs(s, 'pc', t1).find((x) => /keepalive/.test(x.label));
  assert.ok(probe, 'probed');
  const rst = segs(s, 'srv', t1).find((x) => x.flags === '[R]');
  assert.ok(rst, 'a segment with ACK of no connection: [R], not [R,A]');
  assert.deepEqual([rst.seq, rst.ack, rst.sport, rst.dport], [probe.ack, undefined, 80, probe.sport]);
  assert.equal(s.connTable('pc').filter((r) => r.proto === 'tcp' && r.state !== 'LISTEN').length, 0, 'the client took the RST');
  // a SYN to a closed port: [R,A], seq 0, ack ISS + 1
  const t2 = s.now;
  s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 81 });
  s.runTo(t2 + 2000);
  const syn = segs(s, 'pc', t2).find((x) => x.flags === '[S]');
  const refused = segs(s, 'srv', t2).find((x) => x.dport === syn.sport);
  assert.deepEqual([refused.flags, refused.seq, refused.ack], ['[R,A]', 0, syn.seq + 1]);
});

// ------------------------------------------------------------------ acceptance

test('an acknowledgment of something never sent: dropped (its data not delivered), answered with an ACK; the retransmission is taken once', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  let done = false;
  impair(s, 'l3', (f) => {
    const l4 = f.ip.l4;
    if (!done && l4.dport === 80 && l4.flags.indexOf('PSH') >= 0) {
      done = true;
      f.ip.l4 = { ...l4, ack: l4.ack + 5000 };
    }
    return null;
  });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 5000);
  assert.equal(t.ok, true, t.result);
  const sv = segs(s, 'srv', t0);
  const pc = segs(s, 'pc', t0);
  const req = pc.find((x) => x.flags === '[P,A]');
  // the server's answer to the bad segment: an ACK of what it had (the request's first byte still expected), nothing delivered
  assert.equal(sv[1].flags, '[A]');
  assert.equal(sv[1].ack, req.seq, 'acknowledges what it still expects');
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'srv' && /beyond what was sent/.test(e.detail)));
  // the request's retransmission (after the RTO) is delivered and answered once
  assert.equal(pc.filter((x) => x.flags === '[P,A]' && x.seq === req.seq).length, 2);
  assert.equal(sv.filter((x) => x.flags === '[P,A]').length, 1, 'answered once');
});

test('SYN-RECEIVED: an ACK that does not acknowledge the SYN-ACK is answered with [R] at its number; the right one opens the connection', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  let done = false;
  impair(s, 'l3', (f) => {
    const l4 = f.ip.l4;
    if (!done && l4.dport === 80 && l4.flags.length === 1 && l4.flags[0] === 'ACK') {
      done = true;
      f.ip.l4 = { ...l4, ack: l4.ack + 7 };
    }
    return null;
  });
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 5000);
  const sv = segs(s, 'srv', t0);
  const r = sv.find((x) => x.flags === '[R]');
  assert.ok(r, sv.map((x) => x.flags).join(' '));
  const synack = sv[0];
  assert.equal(r.seq, synack.seq + 1 + 7, '<SEQ=SEG.ACK><CTL=RST>');
  // the request that follows carries the right acknowledgment: the server takes it and answers
  assert.equal(t.ok, true, t.result);
});

// ------------------------------------------------------------------ closing

test('lost last ACK: the server sends its FIN again, the client in TIME_WAIT acknowledges it again and TIME_WAIT starts again', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  // the client's ACK of the server's FIN is lost (once)
  let srvFin = false;
  let lost = false;
  impair(s, 'l1', (f) => {
    const l4 = f.ip.l4;
    if (l4.sport === 80 && l4.flags.indexOf('FIN') >= 0) srvFin = true;
    if (srvFin && !lost && l4.dport === 80 && flagsOf(f) === '[A]') {
      lost = true;
      return { lose: true };
    }
    return null;
  });
  s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 600);
  const pcRow = () => s.connTable('pc').find((r) => r.proto === 'tcp' && r.state !== 'LISTEN');
  assert.equal(pcRow().state, 'TIME_WAIT');
  assert.equal(s.connTable('srv').find((r) => r.proto === 'tcp' && r.state !== 'LISTEN').state, 'LAST_ACK');
  s.runTo(t0 + 3500);
  const sv = segs(s, 'srv', t0).filter((x) => x.flags === '[F,A]');
  assert.equal(sv.length, 2, 'the FIN sent again after its RTO');
  assert.equal(sv[1].label, 'TCP [F,A] (retransmission)');
  assert.deepEqual([sv[1].seq, sv[1].ack], [sv[0].seq, sv[0].ack], 'the same FIN');
  const acks = segs(s, 'pc', t0).filter((x) => x.flags === '[A]' && x.ack === sv[0].seq + 1);
  assert.equal(acks.length, 2, 'acknowledged again');
  const row = pcRow();
  assert.equal(row.state, 'TIME_WAIT');
  assert.ok(Math.abs(row.remaining - (60000 - (s.now - acks[1].t))) < 1, `TIME_WAIT started again with the second ACK (${row.remaining} ms left)`);
  // the server's end is closed by the second ACK
  assert.equal(s.connTable('srv').filter((r) => r.proto === 'tcp' && r.state !== 'LISTEN').length, 0);
});

test('half-close: a FIN closes one direction — the peer that handles it stays in CLOSE_WAIT, still sends, and closes when it is done', () => {
  const ip = load('model/ip.js');
  const s = sim(CHAIN({ listen: ', tcp/7000' }));
  s.runTo(2500);
  const Tr = s.transport;
  const seen = [];
  Tr.appListen('srv', 7000, 'echo', {
    message(sock, m) {
      seen.push(`srv got ${m.type}`);
    },
    peerClosed(sock) {
      seen.push(`srv ${s.connTable('srv').find((r) => r.local.endsWith(':7000') && r.state !== 'LISTEN').state}`);
      // its direction is still open: it answers after the client's FIN, then closes
      assert.equal(sock.open, true);
      assert.equal(sock.send({ protocol: 'tcp', type: 'late answer', label: 'late answer', detail: 'the answer after the FIN', bytes: 300, data: {} }), true);
      sock.close('done');
    },
    closed() {},
  });
  const sock = Tr.appConnect('pc', ip.parseAddress('10.0.2.10'), 7000, 'client', {
    open(k) {
      k.send({ protocol: 'tcp', type: 'request', label: 'request', detail: 'the request', bytes: 100, data: {} });
      k.close('sent everything');
    },
    message() {},
    closed() {},
  });
  assert.equal(typeof sock, 'object');
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.deepEqual(seen, ['srv got request', 'srv CLOSE_WAIT']);
  const sv = segs(s, 'srv', t0).filter((x) => x.sport === 7000);
  const pc = segs(s, 'pc', t0).filter((x) => x.dport === 7000);
  const cfin = pc.find((x) => x.flags === '[F,A]');
  // the server acknowledges the FIN alone (its application decides what follows), then sends 300 bytes, then its FIN
  assert.deepEqual(sv.map((x) => x.flags), ['[S,A]', '[A]', '[A]', '[P,A]', '[F,A]']);
  assert.equal(sv[2].ack, cfin.seq + 1, 'the FIN acknowledged');
  assert.equal(sv[3].len, 300);
  // the client, in FIN_WAIT_2, still takes and acknowledges the data of the open direction, then the FIN: TIME_WAIT
  const dataAck = pc.find((x) => x.flags === '[A]' && x.ack === sv[3].seq + 300);
  assert.ok(dataAck, pc.map((x) => x.flags + x.ack).join(' '));
  assert.equal(s.connTable('pc').find((r) => r.remote.endsWith(':7000')).state, 'TIME_WAIT');
});

test('MSS: the SYNs announce their MSS; the client sends segments the server can receive (its MTU 1000: MSS 960), without PMTUD', () => {
  const s = sim(CHAIN({ srvMtu: 1000 }));
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80, size: 3000 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(t.ok, true, t.result);
  const pc = segs(s, 'pc', t0);
  const sv = segs(s, 'srv', t0);
  assert.equal(pc[0].mss, 1460);
  assert.equal(sv[0].mss, 960);
  // a SYN's header has the MSS option: IPv4 20 + TCP 20 + MSS 4 = 44 bytes (no data); the segments after it 20-byte TCP headers
  assert.deepEqual([pc[0].iplen, pc[0].len, sv[0].iplen], [44, 0, 44]);
  assert.equal(pc.filter((x) => x.len > 0)[0].iplen, 20 + 20 + 960);
  const data = pc.filter((x) => x.len > 0).map((x) => x.len);
  assert.deepEqual(data, [960, 960, 960, 120]);
  assert.equal(s.events().filter((e) => e.t >= t0 && /Fragmentation Needed/.test(e.what)).length, 0);
  // the server's answer (1460 bytes) by its own MSS (960; the client's 1460 is larger)
  assert.deepEqual(sv.filter((x) => x.len > 0).map((x) => x.len), [960, 500]);
});

test('two connections between the same hosts at once: separate sequence spaces, each answered once, two conversations (Follow message)', () => {
  const s = sim(CHAIN());
  s.runTo(2500);
  const a = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const b = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(a.ok && b.ok, true);
  const ports = Array.from(new Set(segs(s, 'pc', t0).map((x) => x.sport)));
  assert.equal(ports.length, 2);
  for (const p of ports) assert.equal(segs(s, 'srv', t0).filter((x) => x.dport === p && x.flags === '[P,A]').length, 1);
  const keys = new Set(s.engine.flights.filter((f) => f.view === 'physical' && f.hdr && f.hdr.l4 && f.hdr.l4.proto === 'tcp' && f.t0 >= t0).map((f) => P.conversationKey(f.protocol, f.hdr, f.label)));
  assert.equal(keys.size, 2, Array.from(keys).join(' '));
});

// ------------------------------------------------------------------ the views

test('logical view: a relation’s connection — its handshake, acknowledgments and messages — goes along the relation, one dot per segment sent', () => {
  const s = new S.Simulation(model(example('protocol-simulation.yaml')));
  s.runTo(16000);
  const lane = s.engine.flights.filter((f) => f.view === 'logical' && f.track.ref === 'relation:ibgp-r1-r3');
  const labels = lane.map((f) => f.label);
  // the transport's three segments of the handshake, both ways, before the OPENs
  const i = (l) => labels.indexOf(l);
  assert.ok(i('BGP TCP [S]') >= 0 && i('BGP TCP [S,A]') > i('BGP TCP [S]') && i('BGP TCP [A]') > i('BGP TCP [S,A]') && i('BGP OPEN [P,A]') > i('BGP TCP [A]'), labels.slice(0, 8).join(' | '));
  assert.deepEqual([lane[i('BGP TCP [S]')].track.from, lane[i('BGP TCP [S,A]')].track.from], ['r1', 'r3'], 'the SYN-ACK is the listener’s (it knows its neighbour by address)');
  // a logical dot has the headers its segment was sent with (its inspector), its flags with them
  assert.deepEqual(lane[i('BGP TCP [S,A]')].hdr.l4.flags, ['SYN', 'ACK']);
  assert.equal(lane[i('BGP TCP [S,A]')].flags, '[S,A]');
  // one dot per segment: as many OPEN dots as OPEN segments sent, on the wire too
  const sent = s.events().filter((e) => e.kind === 'message' && e.protocol === 'bgp' && e.what === 'OPEN').length;
  assert.equal(labels.filter((l) => l === 'BGP OPEN [P,A]').length, sent);
  // each dot carries its connection: Follow message is the same conversation in both views
  const phys = s.engine.flights.find((f) => f.view === 'physical' && f.label === 'BGP TCP [S]');
  assert.ok(phys.conv && phys.conv === lane[i('BGP TCP [S]')].conv && lane.every((f) => f.conv === phys.conv), 'one conversation');
  // its identity is the connection's (made when it opened, carried by both ends' segments), not its addresses and ports
  assert.match(phys.conv, /^tcp#\d+$/);
  assert.equal(P.flightKey(phys, phys.hdr), phys.conv);
});

/** Play a model's display (Readable, physical or logical) with the frame budget's clock pinned; the hops it took in. */
function display(name, view, follow) {
  const sim = new S.Simulation(model(example(name)));
  const host = { engine: sim.engine, shown: (f) => f.view === view, typical: () => sim.engine.hopTime(), headers: (f) => f.hdr };
  const p = new P.Pacer(host, 48);
  const now = Date.now;
  Date.now = () => 0;
  const seen = new Map();
  try {
    for (let i = 0; i < 8000; i++) {
      p.frame(16);
      for (const it of p.items) if (it.f.view === view && !seen.has(it.f.id)) seen.set(it.f.id, it);
      if (follow && !p.follow) {
        const syn = p.items.find((it) => it.f.view === view && /TCP \[S\]/.test(it.f.label));
        if (syn) p.followFlight(syn.f.id);
      }
    }
  } finally {
    Date.now = now;
  }
  return { sim, p, items: Array.from(seen.values()) };
}

test('busy model: a TCP handshake drawn is drawn whole — its SYN-ACK and ACK are never turned into cable activity behind its SYN; the rest stays bounded', () => {
  for (const [name, views] of [['dmz-services.yaml', ['physical']], ['private-house.yaml', ['physical', 'logical']], ['cross-domain.yaml', ['logical']]]) {
    for (const view of views) {
      const { p, items } = display(name, view);
      const by = new Map();
      for (const it of items) if (it.f.conv) by.set(it.key, (by.get(it.key) || []).concat([it]));
      let whole = 0;
      for (const list of by.values()) {
        const syn = list.find((x) => x.drawn && /TCP \[S\]/.test(x.f.label));
        if (!syn) continue;
        // the handshake's other two segments: the SYN-ACKs, and the client's first ACK after them (every cable of each)
        const sa = list.filter((x) => /TCP \[S,A\]/.test(x.f.label));
        const acks = list.filter((x) => /TCP \[A\]$/.test(x.f.label) && x.f.sender === syn.f.sender);
        const first = acks.length ? Math.min(...acks.map((x) => x.f.t0)) : null;
        const answers = sa.concat(acks.filter((x) => x.f.t0 === first));
        if (!sa.length || !answers.length) continue;
        assert.ok(answers.every((x) => x.drawn), `${name} ${view}: ${answers.filter((x) => !x.drawn).map((x) => `${x.f.label} ${x.f.track.ref} parent ${x.parent ? x.parent.drawn : '-'} lag ${Math.round(x.d0 - p.clock)}`).join(' | ')}`);
        whole++;
      }
      assert.ok(whole >= 1, `${name} ${view}: a handshake drawn`);
      // the background stays bounded: never more dots moving at once than the limit (48); in the busy models most of the
      // traffic is cable activity, said so (cross-domain's little traffic all fits)
      const shown = items.filter((x) => x.f.view === view && x.drawn);
      let most = 0;
      for (let t = 0; t < p.clock; t += 250) most = Math.max(most, shown.filter((x) => x.d0 <= t && t < x.d0 + x.hop).length);
      assert.ok(most <= 48, `${name} ${view}: ${most} moving at once`);
      if (name !== 'cross-domain.yaml') assert.ok(p.notDrawn > 50, `${name} ${view}: ${p.notDrawn}`);
    }
  }
});

test('Follow message on a TCP connection in a busy model: its handshake and every later segment are drawn', () => {
  const { p, items } = display('dmz-services.yaml', 'physical', true);
  assert.ok(p.follow, 'following a connection');
  const mine = items.filter((it) => it.key === p.follow.key);
  assert.ok(mine.some((x) => /\[S,A\]/.test(x.f.label)) && mine.some((x) => /TCP \[A\]/.test(x.f.label)), mine.map((x) => x.f.label).join(' | '));
  assert.ok(mine.every((x) => x.drawn), mine.filter((x) => !x.drawn).map((x) => x.f.label).join(' | '));
});

// ---- a conversation's identity: its connection's, not its addresses and ports

/** two customers' VRFs on one PE, the same addresses in each: pc-a and pc-b both 10.0.1.10, both servers 10.0.2.10 */
const TWO_VRFS = `netatlas: 1
title: same tuple in two vrfs
devices:
  - {id: pc-a, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: pc-b, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: srv-a, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: tcp/80}}
  - {id: srv-b, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: tcp/80}}
  - id: pe
    type: router
    interfaces:
      - {id: a1, ip: 10.0.1.1/24, vrf: a}
      - {id: a2, ip: 10.0.2.1/24, vrf: a}
      - {id: b1, ip: 10.0.1.1/24, vrf: b}
      - {id: b2, ip: 10.0.2.1/24, vrf: b}
links:
  - {id: la1, a: "pc-a:eth0", b: "pe:a1"}
  - {id: la2, a: "srv-a:eth0", b: "pe:a2"}
  - {id: lb1, a: "pc-b:eth0", b: "pe:b1"}
  - {id: lb2, a: "srv-b:eth0", b: "pe:b2"}
`;

test('conversations: the same addresses and ports in two VRFs are two conversations; each its own, both ends, both views', () => {
  const s = sim(TWO_VRFS);
  s.runTo(2500);
  // the same ephemeral port on both clients: identical tuples
  const np = s.transport.nextPort;
  if (!np.has('pc-a')) np.set('pc-a', 50000);
  np.set('pc-b', np.get('pc-a'));
  const ta = s.sendTest({ from: 'pc-a', to: '10.0.2.10', kind: 'tcp', port: 80 });
  const tb = s.sendTest({ from: 'pc-b', to: '10.0.2.10', kind: 'tcp', port: 80 });
  s.runTo(s.now + 4000);
  assert.equal(ta.ok, true, ta.result);
  assert.equal(tb.ok, true, tb.result);
  // the frames on each customer's cables (physical view): their conversations
  const on = (links) => s.engine.flights.filter((f) => f.view === 'physical' && f.protocol === 'tcp' && f.conv && links.indexOf(f.track.ref) >= 0);
  const fa = on(['link:la1', 'link:la2']);
  const fb = on(['link:lb1', 'link:lb2']);
  const a = new Set(fa.map((f) => f.conv));
  const b = new Set(fb.map((f) => f.conv));
  assert.equal(a.size, 1, Array.from(a).join());
  assert.equal(b.size, 1, Array.from(b).join());
  assert.notEqual(Array.from(a)[0], Array.from(b)[0], 'two conversations');
  // both ways in each (the servers' answers, from port 80, are their clients' conversations)
  assert.ok(fa.some((f) => f.hdr && f.hdr.l4.sport === 80) && fb.some((f) => f.hdr && f.hdr.l4.sport === 80));
  // the tuples were really the same (what a key from the headers would have merged)
  const tuple = (list) => {
    const f = list.find((x) => x.hdr && x.hdr.l4 && x.hdr.l4.dport === 80);
    return `${f.hdr.l3[0].src}:${f.hdr.l4.sport}>${f.hdr.l3[0].dst}:${f.hdr.l4.dport}`;
  };
  assert.equal(tuple(fa), tuple(fb));
  // the logical view's dots (if any) carry the same conversations: Follow message is one in both views
  const lg = s.engine.flights.filter((f) => f.view === 'logical' && f.protocol === 'tcp' && f.conv);
  assert.ok(lg.every((f) => a.has(f.conv) || b.has(f.conv)));
});

/** h1 behind a router doing PAT, a server outside */
const NAT = `netatlas: 1
title: pat tcp
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.11/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - id: n
    type: router
    services:
      nat:
        inside: [g0]
        outside: [g1]
        rules:
          - {type: pat, source: 10.0.0.0/24}
    interfaces: [{id: g0, ip: 10.0.0.1/24}, {id: g1, ip: 198.51.100.1/24}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 198.51.100.10/24}], simulation: {listening: tcp/80}}
links:
  - {id: a, a: "h1:eth0", b: "n:g0"}
  - {id: d, a: "n:g1", b: "srv:eth0"}
`;

test('conversations: translated by NAT on the way, the reply is the same conversation as the request; a later connection on the same ports is a new one', () => {
  const s = sim(NAT);
  s.runTo(2500);
  const t1 = s.sendTest({ from: 'h1', to: '198.51.100.10', kind: 'tcp', port: 80 });
  s.runTo(s.now + 4000);
  assert.equal(t1.ok, true, t1.result);
  const tcpFlights = s.engine.flights.filter((f) => f.view === 'physical' && f.protocol === 'tcp' && f.conv);
  // the server saw the translated source: its answers (from port 80, on its cable) go to the router's outside address …
  const outside = tcpFlights.find((f) => f.track.ref === 'link:d' && f.hdr && f.hdr.l4.sport === 80);
  assert.equal(outside.hdr.l3[0].dst, '198.51.100.1', 'the server answers the translated address');
  const inside = tcpFlights.find((f) => f.track.ref === 'link:a' && f.hdr && f.hdr.l4.sport === 80);
  assert.equal(inside.hdr.l3[0].dst, '10.0.0.11', 'translated back on the inside');
  // … and it is one conversation, on both sides of the NAT
  const first = new Set(tcpFlights.map((f) => f.conv));
  assert.equal(first.size, 1, 'request and answer one conversation: ' + Array.from(first).join());
  // the same client port again after the connection closed (TIME_WAIT over): another conversation
  s.runTo(s.now + 300000);
  const n = s.engine.flights.length;
  // (the next connection from the same client port: the stack's port counter set back)
  s.transport.nextPort.set('h1', s.transport.nextPort.get('h1') - 1);
  const t2 = s.sendTest({ from: 'h1', to: '198.51.100.10', kind: 'tcp', port: 80 });
  s.runTo(s.now + 4000);
  assert.equal(t2.ok, true, t2.result);
  const later = s.engine.flights.slice(n).filter((f) => f.view === 'physical' && f.protocol === 'tcp' && f.conv);
  const second = new Set(later.map((f) => f.conv));
  assert.equal(second.size, 1);
  const cport = (list) => list.find((f) => f.track.ref === 'link:a' && f.hdr && f.hdr.l4.dport === 80).hdr.l4.sport;
  assert.equal(cport(later), cport(tcpFlights), 'the same client port');
  assert.ok(!first.has(Array.from(second)[0]), 'a new conversation');
});

// ------------------------------------------------------------------ a test's connection ends with its test

test('an ICMP error about a test’s SYN ends its connection with the test (RFC 1122 §4.2.3.9; Linux tcp_v4_err): no SYN is sent again — also when the router rate-limits its later errors', () => {
  for (const limit of ['', ', simulation: {icmp_rate_limit: 60000}']) {
    const t = `netatlas: 1
title: unreachable
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.1.1/24}]${limit}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
`;
    const s = sim(t);
    s.runTo(3000);
    const t0 = s.now;
    const r = s.sendTest({ from: 'pc', to: '10.9.9.9', kind: 'tcp', port: 80 });
    s.runTo(t0 + 120000);
    assert.equal(r.ok, false);
    assert.match(r.result, /^Net Unreachable from 10\.0\.1\.1/);
    const out = segs(s, 'pc', t0);
    assert.deepEqual(out.map((x) => x.flags), ['[S]'], `${limit || 'no limit'}: ${out.map((x) => `${x.t} ${x.label}`).join(', ')}`);
    const closed = s.events().filter((e) => e.t >= t0 && e.kind === 'table' && e.device === 'pc' && e.what === 'connection closed');
    assert.equal(closed.length, 1);
    assert.ok(closed[0].t <= r.ended + 1e-6, 'closed when the test failed');
    assert.match(closed[0].detail, /connection failed: Net Unreachable/);
  }
});

test('the response timeout of a test on an open connection: the client aborts it ([R,A], RFC 9293 §3.10.4 ABORT) — the server’s late answer is never sent on it, nothing of the connection after', () => {
  const s = sim(CHAIN({ srv: ', response_time: 7000' }));
  s.runTo(3000);
  const t0 = s.now;
  const r = s.sendTest({ from: 'pc', to: '10.0.2.10', kind: 'tcp', port: 80 });
  s.runTo(t0 + 20000);
  assert.equal(r.ok, false);
  assert.match(r.result, /no answer within 5 s/);
  const pc = segs(s, 'pc', t0);
  assert.equal(pc[pc.length - 1].flags, '[R,A]');
  assert.ok(Math.abs(pc[pc.length - 1].t - r.ended) < 1e-6, 'at the timeout');
  assert.ok(pc.every((x) => x.t <= r.ended + 1e-6), 'nothing after the abort');
  // the server's connection is reset before its answer is due: it sends no data
  assert.ok(segs(s, 'srv', t0).every((x) => x.len === 0), segs(s, 'srv', t0).map((x) => `${x.t - t0} ${x.label}`).join(', '));
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'srv' && e.kind === 'table' && /reset by 10\.0\.1\.10/.test(e.detail)));
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'pc' && e.kind === 'table' && /aborted: pc gave up after its response timeout/.test(e.detail)));
});

test('an answer due after the service response time is not sent by a server powered off and on meanwhile (a rebooted server knows no request): the UDP test times out, no UDP answer leaves the server', () => {
  const s = sim(CHAIN({ srv: ', response_time: 4000, boot_time: 0.1' }).replace('listening: "tcp/80"', 'listening: "tcp/80, udp/53"'));
  s.runTo(3000);
  const t0 = s.now;
  const r = s.sendTest({ from: 'pc', to: '10.0.2.10', kind: 'udp', port: 53 });
  s.runTo(t0 + 300);
  assert.ok(s.events().some((e) => e.t >= t0 && e.device === 'r2' && e.kind === 'route' && e.protocol === 'udp' && /10\.0\.1\.10 → 10\.0\.2\.10/.test(e.detail)), 'the request was routed to srv before the power-off');
  s.powerOff('srv');
  s.runTo(t0 + 600);
  s.powerOn('srv');
  s.runTo(t0 + 10000);
  assert.equal(r.ok, false);
  assert.match(r.result, /no answer within 5 s/);
  assert.equal(s.events().filter((e) => e.t >= t0 && e.device === 'srv' && e.what === 'UDP answer').length, 0);
  // without the power cycle the same request is answered after 4 s
  const u = sim(CHAIN({ srv: ', response_time: 4000, boot_time: 0.1' }).replace('listening: "tcp/80"', 'listening: "tcp/80, udp/53"'));
  u.runTo(3000);
  const ok = u.sendTest({ from: 'pc', to: '10.0.2.10', kind: 'udp', port: 53 });
  u.runTo(u.now + 10000);
  assert.equal(ok.ok, true, ok.result);
});
