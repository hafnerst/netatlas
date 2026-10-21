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

// ------------------------------------------------------------------ lifecycle boundaries

const P = load('analysis/sim/pacing.js');
const synSent = (s, dev) => (s.transport.conns.get(dev) ? Array.from(s.transport.conns.get(dev).values()).filter((c) => c.state === 'SYN_SENT').length : 0);

test('Stop during an ARP wait or a DHCP wait: nothing new is sent after it; a message already started ends by its own timeout, its attempt abandoned — no SYN after that, none when the peer appears later', () => {
  // the peer is on pc's own subnet and off: ARP goes unanswered
  const arp = counted(CHAIN({ pc: `\n    services:\n      applications:\n        - {id: get, name: Get, profile: tcp_client, peer: 10.0.1.77, port: 80, interval: 2s, timeout: 3s}` }).replace('  - {id: srv,', '  - {id: near, type: server, interfaces: [{id: eth0, ip: 10.0.1.77/24}], simulation: {listening: "tcp/80"}}\n  - {id: srv,').replace('  - {id: l1, a: "pc:eth0", b: "r1:g0"}', '  - {id: l1, a: "pc:eth0", b: "sw:p1"}\n  - {id: l0, a: "r1:g0", b: "sw:p2"}\n  - {id: ln, a: "near:eth0", b: "sw:p3"}').replace('links:', '  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}\nlinks:'));
  const s = arp.s;
  s.runTo(2500);
  s.powerOff('near');
  s.runTo(4000);
  const a = s.actApp('pc', 'get');
  assert.ok(!a.error, a.error);
  s.runTo(s.now + 300);
  const madeAtStop = arp.made.length;
  assert.ok(s.actionControl(a.id, 'stop'));
  const stopAt = s.now;
  s.runTo(stopAt + 1500);
  s.powerOn('near');
  s.runTo(stopAt + 60000);
  assert.equal(arp.made.length, madeAtStop, 'no connection after Stop');
  const ended = Math.max(...a.app.tests.map((t) => t.ended || 0));
  assert.ok(ended <= stopAt + 3000 + 1, 'the started message ended by its own timeout');
  assert.deepEqual(syns(s, 'pc', ended + 1e-6), [], 'no SYN once it ended, though the peer came back');
  assert.equal(synSent(s, 'pc'), 0);
  // a DHCP wait: the message waits for its lease (no connection yet); Stop cancels it, the lease later sends nothing
  const dh = counted(`netatlas: 1
title: dhcp wait
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ipv4: dhcp}]
    services:
      applications:
        - {id: get, name: Get, profile: tcp_client, peer: 10.0.1.5, port: 80, interval: 2s}
  - id: dsrv
    type: server
    simulation: {listening: "tcp/80"}
    services:
      dhcp:
        scopes: [{network: lan, range: 10.0.1.100-10.0.1.199, gateway: 10.0.1.1, dns: [10.0.1.5]}]
    interfaces: [{id: eth0, ip: 10.0.1.5/24}]
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "dsrv:eth0", b: "sw:p2"}
networks:
  - {id: lan, cidr: 10.0.1.0/24}
`);
  dh.s.powerOff('dsrv');
  dh.s.runTo(3000);
  const b = dh.s.actApp('pc', 'get');
  dh.s.runTo(dh.s.now + 500);
  assert.match(b.app.tests[0].result, /waiting for a DHCP lease/);
  assert.ok(dh.s.actionControl(b.id, 'stop'));
  dh.s.powerOn('dsrv');
  // (the client's DHCP retransmissions back off: its next Discover can be minutes away)
  dh.s.runTo(dh.s.now + 600000);
  assert.ok(dh.s.engine.effectiveAddrs('pc').some((x) => x.addr.version === 4), 'the lease came');
  assert.equal(dh.made.filter((m) => m.dev === 'pc').length, 0, 'the cancelled message never connects');
  assert.match(b.app.tests[0].result, /cancelled \(Stop\)/);
});

test('a SYN-ACK at the response timeout’s own moment: the earlier event decides, deterministically — the attempt abandoned (the late SYN-ACK finds no connection), or established and closed normally when it comes first; the same paced', () => {
  // the handshake's SYN-ACK reaches pc when pc sends the handshake ACK: measured, then the response timeout set exactly there
  const probe = counted(CHAIN());
  probe.s.runTo(2500);
  const t0 = probe.s.now;
  const pt = probe.s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  probe.s.runTo(t0 + 5000);
  assert.equal(pt.ok, true);
  const ack = probe.s.events().find((e) => e.t >= t0 && e.device === 'pc' && e.kind === 'message' && e.hdr && e.hdr.l4 && e.hdr.l4.proto === 'tcp' && e.hdr.l4.flags.join() === 'ACK');
  const at = ack.t - t0;
  const run = (timeout, paced) => {
    const { s, made } = counted(CHAIN());
    const pacer = paced ? new P.Pacer({ engine: s.engine, shown: () => true, typical: () => s.engine.hopTime(), headers: (f) => f.hdr }, 8) : null;
    s.runTo(2500);
    const r = s.transport.resolveTarget('pc', { to: 'srv' }, 'tcp');
    const t = s.transport.run({ from: 'pc', target: 'srv', dst: r.dst, kind: 'tcp', port: 80, source: 'manual', timeout: { value: timeout } });
    if (pacer) for (let i = 0; i < 4000 && s.now < 2500 + 70000; i++) pacer.frame(16);
    s.runTo(2500 + 70000);
    const log = s.events().filter((e) => e.t >= 2500).map((e) => `${e.t.toFixed(6)} ${e.kind} ${e.device} ${e.detail}`);
    return { t, conn: made[made.length - 1].conn, log, s };
  };
  // exactly then: the timeout was scheduled first (when the test started), so it comes first — the attempt in SYN-SENT is
  // abandoned; the SYN-ACK arrives for no connection
  const exact = run(at, false);
  assert.match(exact.t.result, /timed out/);
  assert.ok(exact.log.some((x) => /connection attempt abandoned/.test(x)), 'abandoned');
  assert.equal(exact.conn.state, 'CLOSED');
  assert.ok(!exact.log.some((x) => / pc .*\[P,A\]/.test(x) && /→ 10\.0\.2\.10:80/.test(x)), 'no request sent on an abandoned attempt');
  // a microsecond later: the SYN-ACK came first — established, not abandoned (the test still times out: no answer yet), and
  // the connection then ends normally, nothing left open
  const after = run(at + 0.001, false);
  assert.match(after.t.result, /timed out/);
  assert.ok(!after.log.some((x) => /connection attempt abandoned/.test(x)), 'not abandoned once established');
  assert.ok(after.conn.state === 'CLOSED' || after.conn.state === 'TIME_WAIT' || !after.s.transport.alive(after.conn), after.conn.state);
  // the same paced, at both boundaries
  assert.deepEqual(run(at, true).log, exact.log);
  assert.deepEqual(run(at + 0.001, true).log, after.log);
});

// two BGP speakers over one cable: the session, its connections, its state
const PAIR = `netatlas: 1
title: bgp pair
devices:
  - {id: a, type: router, interfaces: [{id: g0, ip: 10.0.0.1/30}], protocols: {bgp: {asn: 65001}}}
  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], protocols: {bgp: {asn: 65002}}}
links:
  - {id: l, a: "a:g0", b: "b:g0"}
relations:
  - {id: ebgp, protocol: bgp, endpoints: ["a:g0", "b:g0"]}
`;
const sessionState = (s, protocol, dev) => (s.status().find((x) => x.protocol === protocol && x.device === dev) || { state: 'none' }).state;

test('a persistent session after a failure and its recovery: established before, down by the failure, established again after the restore — with new connections of that session only, bounded, one attempt at a time', () => {
  const { s, made } = counted(PAIR);
  s.runTo(6000);
  // 1–2: which session, established before the failure, with its one connection
  assert.deepEqual([sessionState(s, 'bgp', 'a'), sessionState(s, 'bgp', 'b')], ['Established', 'Established']);
  const mine = () => made.filter((m) => m.dev === 'a' || m.dev === 'b');
  assert.equal(mine().length, 1, 'one connection for the session');
  assert.match(mine()[0].what, /BGP/);
  const before = mine().length;
  // 3: the failure takes the session down
  assert.ok(s.fail('link:l'));
  s.runTo(s.now + 200000);
  assert.notEqual(sessionState(s, 'bgp', 'a'), 'Established', 'down after the failure');
  assert.notEqual(sessionState(s, 'bgp', 'b'), 'Established');
  // 4: the restore brings it back
  assert.ok(s.restore('link:l'));
  let peak = 0;
  let back = null;
  for (let t = 0; t < 180000 && back === null; t += 1000) {
    s.runTo(s.now + 1000);
    peak = Math.max(peak, synSent(s, 'a'), synSent(s, 'b'));
    if (sessionState(s, 'bgp', 'a') === 'Established' && sessionState(s, 'bgp', 'b') === 'Established') back = s.now;
  }
  assert.ok(back !== null, 'established again after the restore');
  // 5: its new connections: at least one (the session needs one), all of this session, bounded, never piled up
  const after = mine().slice(before);
  assert.ok(after.length >= 1, 'a new connection for the session');
  assert.ok(after.length <= 4, `${after.length} new connections (bounded)`);
  for (const m of after) assert.match(m.what, /BGP/);
  assert.equal(made.length, mine().length, 'no other device opened anything');
  assert.ok(peak <= 1, `at most one attempt in SYN-SENT at a time (${peak})`);
});

test('an established connection whose application gives up (a slow answer): the test times out, the connection does not stay open for ever, a late answer opens nothing; a retry is a connection of its own', () => {
  const slow = CHAIN({ pc: `\n    services:\n      applications:\n        - {id: get, name: Get, profile: tcp_client, peer: srv/web, interval: 20s, count: 1, timeout: 2s, retries: 1, start: simulation_start}` }).replace('{id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80"}}', `{id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80, response_delay: 5s}]}}`);
  const { s, made } = counted(slow);
  s.runTo(60000);
  const run = s.apps.runs.find((r) => r.dev === 'pc');
  assert.equal(run.tests.length, 2, 'the try and its one retry');
  for (const t of run.tests) assert.match(t.result, /timed out/);
  const mine = made.filter((m) => m.dev === 'pc');
  assert.equal(mine.length, 2, 'one connection per try');
  assert.equal(new Set(mine.map((m) => m.lport)).size, 2);
  // a minute later: neither is left established, half-open or retransmitting
  s.runTo(240000);
  for (const m of mine) assert.ok(m.conn.state === 'CLOSED' || m.conn.state === 'TIME_WAIT' || !s.transport.alive(m.conn), `${m.lport}: ${m.conn.state}`);
  assert.equal(made.filter((m) => m.dev === 'pc').length, 2, 'nothing new');
});

test('in-progress ownership: an MQTT client stopped while its connection is being opened leaves no attempt behind and never reconnects; LDP sessions after a failure keep one attempt each at a time', () => {
  // the broker behind r2: every SYN-ACK lost, so the client stays connecting
  const mq = counted(CHAIN({ pc: `\n    services:\n      applications:\n        - {id: m, name: Telemetry, profile: mqtt_client, broker: srv, publish: [plant/t], interval: 5s}` }).replace('simulation: {listening: "tcp/80"}', 'services: {mqtt_broker: {}}'));
  const s = mq.s;
  s.runTo(2500);
  loseSynAcks(s, 'l3');
  const a = s.actApp('pc', 'm');
  assert.ok(!a.error, a.error);
  s.runTo(s.now + 1500);
  assert.ok(synSent(s, 'pc') >= 1, 'connecting');
  const n = mq.made.length;
  assert.ok(s.actionControl(a.id, 'stop'));
  const stopAt = s.now;
  s.engine.impair = null;
  s.runTo(stopAt + 60000);
  assert.equal(mq.made.length, n, 'no reconnection after Stop');
  assert.equal(synSent(s, 'pc'), 0, 'its attempt is gone');
  assert.deepEqual(syns(s, 'pc', stopAt + 1e-6), [], 'no SYN after Stop');
  // LDP: one of the metro ring's sessions — established, taken down by its cable's failure, back after the restore, its new
  // connections its own and bounded, one attempt at a time
  const ld = counted(example('metro-ring.yaml'));
  ld.s.runTo(60000);
  const ldp = () => ld.made.filter((m) => /LDP/.test(m.what));
  assert.ok(ldp().length >= 1, 'LDP sessions over TCP');
  const first = ldp()[0];
  const rel = ld.s.model.relations.find((r) => /ldp/i.test(r.protocol) && r.endpoints.some((e) => e.device === first.dev));
  const peer = rel.endpoints.map((e) => e.device).find((d) => d !== first.dev);
  const ldpUp = (dev) => ld.s.status().some((x) => x.protocol === 'ldp' && x.device === dev && x.peer === (dev === first.dev ? peer : first.dev) && /Operational|Established|OPERATIONAL/.test(x.state));
  assert.ok(ldpUp(first.dev), `${first.dev}–${peer} LDP up before: ${JSON.stringify(ld.s.status().filter((x) => x.protocol === 'ldp' && x.device === first.dev))}`);
  const link = ld.s.model.links.find((l) => [l.a.device, l.b.device].indexOf(first.dev) >= 0 && [l.a.device, l.b.device].indexOf(peer) >= 0);
  assert.ok(link, 'the cable between them');
  const before = ldp().filter((m) => m.dev === first.dev || m.dev === peer).length;
  assert.ok(ld.s.fail('link:' + link.id));
  ld.s.runTo(ld.s.now + 200000);
  assert.ok(!ldpUp(first.dev), 'down after the failure');
  assert.ok(ld.s.restore('link:' + link.id));
  let peak = 0;
  let back = false;
  for (let t = 0; t < 240000 && !back; t += 1000) {
    ld.s.runTo(ld.s.now + 1000);
    for (const d of [first.dev, peer]) peak = Math.max(peak, synSent(ld.s, d));
    back = ldpUp(first.dev);
  }
  assert.ok(back, 'up again after the restore');
  const after = ldp().filter((m) => m.dev === first.dev || m.dev === peer).slice(before);
  assert.ok(after.length >= 1 && after.length <= 4, `${after.length} new connections of the session`);
  assert.ok(peak <= 1, `attempts in SYN-SENT at once: ${peak}`);
});
