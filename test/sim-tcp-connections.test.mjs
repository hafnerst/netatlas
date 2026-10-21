// How many TCP connections the simulation opens, and who opens them: counted
// at the transport's connection creation (not by dots: a SYN's
// retransmission, its copies on every cable and its dot in the logical view
// are one connection). One Send test opens one connection, its SYN's
// retransmissions stay in it; periodic test traffic opens one per target and
// interval, on the scenario's clock; an application's retries open one more
// each, within their budget; a persistent session (BGP) opens one and keeps
// it; and a connection attempt its application gave up on (its response
// timeout) is abandoned — it sends no more SYNs (before, it went on
// retransmitting for about two minutes beside every newer attempt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const CHAIN = (x = {}) => `netatlas: 1
title: chain
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.1.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]${x.pc || ''}
  - id: r1
    type: router
    interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.12.1/30}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}]
  - id: r2
    type: router
    interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.2.1/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80"}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
  - {id: l2, a: "r1:g1", b: "r2:g0"}
  - {id: l3, a: "r2:g1", b: "srv:eth0"}
`;

/** A simulation whose transport records every client connection it creates: { t, dev, lport, what }. */
function counted(text) {
  const s = new S.Simulation(model(text));
  const made = [];
  const tr = s.transport;
  const orig = tr.newConn.bind(tr);
  tr.newConn = (o) => {
    const c = orig(o);
    if (o.role === 'client') made.push({ t: s.now, dev: o.dev, lport: o.lport, what: o.what, conn: c });
    return c;
  };
  return { s, made };
}

/** Lose every SYN-ACK on a cable: the client's attempts stay in SYN_SENT. */
const loseSynAcks = (s, link) => {
  s.engine.impair = (l, f) => (l === link && f.ip && f.ip.l4 && f.ip.l4.proto === 'tcp' && f.ip.l4.flags.indexOf('SYN') >= 0 && f.ip.l4.flags.indexOf('ACK') >= 0 ? { lose: true } : null);
};

/** The SYNs a device sent (first transmissions and retransmissions), from their headers as sent: { t, sport }. */
const syns = (s, dev, t0 = 0) =>
  s.events()
    .filter((e) => e.kind === 'message' && e.device === dev && e.t >= t0 && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp' && e.hdr.l4.flags.length === 1 && e.hdr.l4.flags[0] === 'SYN')
    .map((e) => ({ t: e.t, sport: e.hdr.l4.sport }));

test('one Send test: one connection; the retransmissions of its SYN stay in it (the same port), they open none', () => {
  // (a response timeout long enough for retransmissions: 1 s, 2 s, 4 s after the SYN)
  const { s, made } = counted(CHAIN({ pc: '\n    simulation: {app_timeout: 10}' }));
  s.runTo(2500);
  loseSynAcks(s, 'l3');
  const n0 = made.length;
  const t0 = s.now;
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  s.runTo(t0 + 9000);
  assert.equal(made.length - n0, 1, made.slice(n0).map((m) => m.what).join('; '));
  const sent = syns(s, 'pc', t0);
  assert.ok(sent.length >= 3, `the SYN and its retransmissions: ${sent.length}`);
  assert.equal(new Set(sent.map((x) => x.sport)).size, 1, 'one connection: one client port');
  assert.equal(t.done, false, 'still waiting within its timeout');
});

test('a connection attempt its application gave up on is abandoned: no SYN after the response timeout, no half-open connection left', () => {
  const { s, made } = counted(CHAIN());
  s.runTo(2500);
  loseSynAcks(s, 'l3');
  const t0 = s.now;
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  // the default response timeout is 5 s; the SYN retries (6) would go on for about two minutes
  s.runTo(t0 + 130000);
  assert.equal(t.done, true);
  assert.match(t.result, /timed out/);
  const conn = made[made.length - 1].conn;
  assert.equal(conn.state, 'CLOSED', 'the attempt is over');
  const late = syns(s, 'pc', t.ended + 1e-6);
  assert.deepEqual(late, [], 'no SYN of an abandoned attempt');
  assert.ok(s.events().some((e) => e.device === 'pc' && e.what === 'connection closed' && /connection attempt abandoned: pc gave up after its response timeout/.test(e.detail)));
  assert.equal(s.transport.conns.get('pc') ? Array.from(s.transport.conns.get('pc').values()).filter((c) => c.state === 'SYN_SENT').length : 0, 0);
});

test('periodic test traffic: one connection per target and interval, on the scenario’s clock; a timed-out target never accumulates half-open attempts', () => {
  const { s, made } = counted(CHAIN({ pc: `\n    simulation: {test_traffic: "on", test_targets: "10.0.2.10 tcp/80, 10.0.2.10 tcp/81", test_interval: 10}` }));
  s.runTo(64000);
  const by = (port) => made.filter((m) => m.what === `test pc → 10.0.2.10 tcp/${port}`).map((m) => m.t);
  const open = by(80);
  const refused = by(81);
  // first after 3 s (and the device's jitter), then every 10 s of simulated time
  assert.equal(open.length, 7, open.join(', '));
  assert.equal(refused.length, 7, refused.join(', '));
  for (let i = 1; i < open.length; i++) assert.ok(Math.abs(open[i] - open[i - 1] - 10000) < 1, `${open[i]} − ${open[i - 1]}`);
  // with the SYN-ACKs lost: still one connection per interval, and at most the one being opened in SYN_SENT
  const b = counted(CHAIN({ pc: `\n    simulation: {test_traffic: "on", test_targets: "10.0.2.10 tcp/80", test_interval: 10}` }));
  b.s.runTo(2000);
  loseSynAcks(b.s, 'l3');
  let peak = 0;
  for (let t = 2000; t <= 64000; t += 250) {
    b.s.runTo(t);
    const m = b.s.transport.conns.get('pc');
    peak = Math.max(peak, m ? Array.from(m.values()).filter((c) => c.state === 'SYN_SENT').length : 0);
  }
  assert.equal(b.made.length, 7);
  assert.equal(peak, 1, 'one attempt at a time: each gives up after its 5 s before the next starts');
});

test('an application’s retries: one connection per try, within its budget (count × (1 + retries)), none after it stopped', () => {
  const { s, made } = counted(
    CHAIN({
      pc: `\n    services:\n      applications:\n        - {id: poll, name: Poll, profile: tcp_client, peer: 10.0.2.10, port: 80, interval: 20s, count: 2, timeout: 3s, retries: 2, start: simulation_start}`,
    }),
  );
  s.runTo(2000);
  loseSynAcks(s, 'l3');
  s.runTo(120000);
  const tries = made.filter((m) => m.dev === 'pc');
  assert.equal(tries.length, 2 * 3, tries.map((m) => `${m.t}`).join(', '));
  // each try is its own connection (its own port); the previous one was abandoned before it
  assert.equal(new Set(tries.map((m) => m.lport)).size, 6);
  for (const m of tries) assert.equal(m.conn.state, 'CLOSED');
  const last = Math.max(...s.transport.tests.filter((t) => t.from === 'pc').map((t) => t.ended));
  assert.deepEqual(syns(s, 'pc', last + 1e-6), [], 'nothing after the last try gave up');
});

test('a DNS name to resolve first: one connection per message all the same (the wait opens none)', () => {
  const { s, made } = counted(example('private-house.yaml'));
  s.runTo(60000);
  const laptopNas = made.filter((m) => m.dev === 'laptop' && /nas\.home\.arpa tcp\/445/.test(m.what));
  // the first once its lease and the DNS answer are there (its waits delay it, they add no attempt), then on the 10 s grid of
  // the test interval: one per message, never a second one for a message that waited
  const ts = laptopNas.map((m) => m.t);
  assert.equal(ts.length, 6, ts.join(', '));
  assert.ok(ts[0] > 3000 && ts[0] < 13000, ts.join(', '));
  for (let i = 2; i < ts.length; i++) assert.ok(Math.abs(ts[i] - ts[i - 1] - 10000) < 50, `${ts[i]} after ${ts[i - 1]}`);
  const series = s.transport.tests.filter((t) => t.from === 'laptop' && /nas\.home\.arpa tcp\/445/.test(t.series));
  assert.equal(series.length, ts.length, 'one test per message, each with its one connection');
});

test('a persistent session (BGP): one connection per configured session, kept — no reconnect while it is usable', () => {
  const { s, made } = counted(example('datacenter-evpn.yaml'));
  s.runTo(180000);
  const bgp = made.filter((m) => /^(BGP|EVPN) /.test(m.what));
  const per = new Map();
  for (const m of bgp) per.set(m.what, (per.get(m.what) || 0) + 1);
  assert.ok(per.size >= 10, String(per.size));
  for (const [what, n] of per) assert.equal(n, 1, `${what}: ${n} connections`);
});

test('a reboot ends every connection of the device: nothing of the old attempts is sent after it comes back', () => {
  const { s, made } = counted(CHAIN({ pc: '\n    simulation: {app_timeout: 60}' }));
  s.runTo(2500);
  loseSynAcks(s, 'l3');
  s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  s.runTo(s.now + 1500);
  const old = made[made.length - 1].lport;
  s.powerOff('pc');
  s.runTo(s.now + 1000);
  s.powerOn('pc');
  s.runTo(s.now + 60000);
  assert.deepEqual(syns(s, 'pc').filter((x) => x.sport === old && x.t > 4000), [], 'no SYN of the old attempt after the power-off');
});

test('the examples: connections opened in two minutes are the configured ones (an audit: periodic tests, health checks, sessions, requests)', () => {
  const want = {
    'cross-domain.yaml': 38,
    'dmz-services.yaml': 178,
    'datacenter-evpn.yaml': 13,
    'hybrid-cloud.yaml': 27,
    'private-house.yaml': 77,
  };
  for (const [f, n] of Object.entries(want)) {
    const { s, made } = counted(example(f));
    s.runTo(120000);
    assert.equal(made.length, n, f);
    // never more than one attempt of the same periodic test in SYN_SENT: none outlives its application's timeout
    for (const [dev, m] of s.transport.conns) {
      const half = Array.from(m.values()).filter((c) => c.state === 'SYN_SENT' && c.role === 'client');
      assert.ok(half.length <= 3, `${f} ${dev}: ${half.length} half-open`);
    }
  }
});
