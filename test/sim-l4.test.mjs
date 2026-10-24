// Layers 3 and 4 of the protocol simulation, and broadcast (analysis/sim/
// engine.ts, transport.ts) without a browser: every ICMP error (net and
// host unreachable, TTL exceeded, fragmentation needed with PMTUD, port
// unreachable, administratively prohibited), their rate limit, none about
// a broadcast or multicast, none from a blackhole route; fragmentation and
// reassembly; TCP (handshake, RST, SYN retransmissions with backoff and
// the connection timeout, FIN, keepalive), UDP; firewalls (drop and
// reject, stateful replies, session timeouts, stateless); endpoint test
// traffic and Send test…; load balancers (algorithm, health checks,
// persistence) and proxies (upstream timeout); monitoring probes;
// broadcast (limited, directed, broadcast ping, the broadcast domain);
// storms without spanning tree and storm control; the packet inspector's
// headers and the dots' cast; a wireless client's idle timeout; BGP's SYN
// retransmissions; determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, validate } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const Pm = load('analysis/sim/params.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);
const ev = (s, f) => s.events().filter(f);
const run = (s, o, ms = 8000) => {
  const t = s.sendTest(o);
  s.runTo(s.now + ms);
  return t;
};

/** pc — r1 — r2 — srv (r1 – r2 a /30), a firewall-free path; extra YAML per device. */
const CHAIN = (x = {}) => `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]${x.pc || ''}}
  - id: r1
    type: router
    interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.12.1/30${x.mtu ? ', mtu: ' + x.mtu : ''}}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}${x.r1routes || ''}]${x.r1 || ''}
  - id: r2
    type: router
    interfaces: [{id: g0, ip: 10.0.12.2/30${x.mtu ? ', mtu: ' + x.mtu : ''}}, {id: g1, ip: 10.0.2.1/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}${x.r2routes || ''}]${x.r2 || ''}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]${x.srv || ''}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
  - {id: l2, a: "r1:g1", b: "r2:g0"}
  - {id: l3, a: "r2:g1", b: "srv:eth0"}
`;

// ------------------------------------------------------------------ the parameters

test('Layer 4 has its eight parameters; Layer 2 the default MTU, Layer 3 Send ICMP errors; the new device attributes by type', () => {
  assert.deepEqual(Pm.paramLayers(), [1, 2, 3, 4]);
  assert.deepEqual(Pm.layerParams(4).map((p) => p.key), ['tcp-syn-retries', 'tcp-rto', 'tcp-keepalive', 'closed-port', 'test-traffic', 'test-interval', 'test-type', 'app-timeout']);
  assert.ok(Pm.layerParams(2).some((p) => p.key === 'mtu' && p.dflt === 1500));
  assert.ok(Pm.layerParams(3).some((p) => p.key === 'icmp-errors' && p.dflt === 'on'));
  const byType = new Map(Pm.attributesByType().map((x) => [x.type, x.keys]));
  for (const k of ['ping', 'bcast-ping', 'icmp-errors', 'icmp-rate', 'tcp-syn-retries', 'tcp-keepalive', 'closed-port']) assert.ok(byType.get('server').includes(k), k);
  for (const k of ['fw-action', 'fw-allow', 'fw-stateful', 'fw-tcp', 'fw-half-open', 'fw-udp', 'fw-icmp']) assert.ok(byType.get('firewall').includes(k), k);
  assert.ok(byType.get('load_balancer').includes('listening'));
  // a load balancer's health checks, persistence and algorithm are its pool's: set on its service relations to the members
  for (const k of ['lb-hc-interval', 'lb-hc-timeout', 'lb-hc-fall', 'lb-persistence', 'lb-algorithm']) {
    assert.ok(!byType.get('load_balancer').includes(k), k);
    assert.ok(Pm.relationParams({ base: 'https', lbService: true, serverService: true }).some((p) => p.key === k), k);
  }
  for (const k of ['test-traffic', 'test-targets', 'test-interval', 'test-type', 'app-timeout']) assert.ok(byType.get('endpoint').includes(k), k);
  // storm control is a port's, directed broadcasts an interface's
  for (const k of ['storm-bc', 'storm-mc']) assert.ok(!byType.get('switch').includes(k) && Pm.paramDef(k).level === 'interface', k);
  assert.ok(!byType.get('router').includes('directed-broadcast') && Pm.paramDef('directed-broadcast').level === 'interface');
  assert.ok(byType.get('system').includes('icmp-probe'));
  // the client idle timeout is the access point's; the beacon interval a radio's
  assert.ok(byType.get('ap').includes('ap-idle') && !byType.get('ap').includes('ap-beacon') && Pm.paramDef('ap-beacon').level === 'interface');
  assert.ok(!byType.get('server').includes('fw-action'));
});

test('lists: ports and targets are parsed, normalized and checked; on / off may be written as true / false', () => {
  const allow = Pm.paramDef('fw-allow');
  assert.deepEqual(Pm.parseValue(allow, 'TCP/443,udp/53  icmp'), { value: 'tcp/443, udp/53, icmp' });
  assert.deepEqual(Pm.parseValue(allow, ['tcp/8000-8080', 'any']), { value: 'tcp/8000-8080, any' });
  assert.deepEqual(Pm.parseValue(allow, 'none'), { value: '' });
  assert.match(Pm.parseValue(allow, 'tcp/0').error, /tcp\/443/);
  assert.match(Pm.parseValue(allow, 'http').error, /http/);
  const tg = Pm.paramDef('test-targets');
  assert.deepEqual(Pm.parseValue(tg, 'web1 TCP/443, 10.0.0.9,db:eth0 udp/53'), { value: 'web1 tcp/443, 10.0.0.9, db:eth0 udp/53' });
  assert.match(Pm.parseValue(tg, 'web1 tcp/1-2').error, /tcp\/<port>/);
  assert.deepEqual(Pm.parseValue(Pm.paramDef('ping'), false), { value: 'off' });
  assert.equal(Pm.formatValue(allow, ''), 'nothing more');
  // in the model: a YAML list works too; a wrong entry is an error with the device's path
  const ok = validate.loadModel(`netatlas: 1\ntitle: t\ndevices:\n  - {id: fw, type: firewall, simulation: {allow: [tcp/22, icmp], default_action: reject, stateful: false}}\n`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(Array.from(ok.model.devices[0].simulation), [['fw-allow', 'tcp/22, icmp'], ['fw-action', 'reject'], ['fw-stateful', 'off']]);
  const bad = validate.loadModel(`netatlas: 1\ntitle: t\ndevices:\n  - {id: s, type: server, simulation: {listening: "tcp/http", allow: tcp/22}}\n`);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0].message, /Listening services has "tcp\/http"/);
  assert.match(bad.errors[1].message, /"allow" \(also permits\) does not apply to "s"/);
});

// ------------------------------------------------------------------ ICMP errors

test('ICMP: an echo answered; net unreachable from the router without a route; a blackhole drops silently', () => {
  const s = sim(CHAIN({ r1routes: ', {prefix: 198.51.100.0/24, blackhole: true}' }));
  s.runTo(2500);
  const ok = run(s, { from: 'pc', to: 'srv', kind: 'icmp' });
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 'Echo Reply from 10.0.2.10');
  const net = run(s, { from: 'pc', to: '203.0.113.1', kind: 'icmp' });
  assert.equal(net.result, 'Net Unreachable from 10.0.1.1 (r1)');
  const e = ev(s, (x) => x.kind === 'message' && x.what === 'Net Unreachable')[0];
  assert.match(e.detail, /ICMP Destination Unreachable: net unreachable \(type 3, code 0\) about 10\.0\.1\.10 → 203\.0\.113\.1 ICMP, TTL 63/);
  // the dot's label names the error and its sender
  assert.ok(s.engine.flights.some((f) => f.label === 'ICMP Net Unreachable from 10.0.1.1'));
  const bh = run(s, { from: 'pc', to: '198.51.100.7', kind: 'icmp' });
  assert.match(bh.result, /^no answer within 5 s .*; the last of its packets was dropped at r1: a blackhole route/);
  assert.ok(ev(s, (x) => x.kind === 'drop' && /a blackhole route \(silently, no ICMP error\)/.test(x.detail)).length === 1);
});

test('ICMP: TTL exceeded in a routing loop; host unreachable when ARP fails (from the router; the sender’s own failure without ICMP)', () => {
  // r1 and r2 send 10.9.0.0/16 to each other
  const s = sim(CHAIN({ r1routes: ', {prefix: 10.9.0.0/16, via: 10.0.12.2}', r2routes: ', {prefix: 10.9.0.0/16, via: 10.0.12.1}' }));
  s.runTo(2500);
  const ttl = run(s, { from: 'pc', to: '10.9.1.1', kind: 'icmp' });
  assert.match(ttl.result, /^TTL exceeded from 10\.0\.12\.[12] \(r[12]\)$/);
  assert.ok(ev(s, (x) => /TTL expired at r[12] .*TTL 1\)/.test(x.detail)).length >= 1);
  // 10.0.2.99 does not exist: r2's ARP gives up after its retries and answers host unreachable
  const host = run(s, { from: 'pc', to: '10.0.2.99', kind: 'icmp' }, 8000);
  assert.equal(host.result, 'Host Unreachable from 10.0.12.2 (r2)');
  // pc's own neighbour does not answer: no ICMP on the wire, the test fails at pc
  const own = run(s, { from: 'pc', to: '10.0.1.77', kind: 'icmp' }, 8000);
  // (ARP gives up after its retries, 3 × 1 s, before the application's 5 s timeout: the sender's own error)
  assert.equal(own.result, 'not sent: 10.0.1.77 does not answer ARP (host unreachable)');
});

test('ICMP: fragmentation needed with DF (PMTUD lowers the path MTU), fragments without DF reassembled at the destination', () => {
  const s = sim(CHAIN({ mtu: 1400 }));
  s.runTo(2500);
  const df = run(s, { from: 'pc', to: 'srv', kind: 'icmp', size: 1472, df: true });
  assert.equal(df.result, 'Frag Needed from 10.0.1.1 (r1): the packet is too big for the path and DF is set (path MTU 1400)');
  assert.ok(ev(s, (x) => x.what === 'path MTU' && x.device === 'pc' && /10\.0\.2\.10 is 1400 bytes/.test(x.detail)).length === 1);
  const frag = run(s, { from: 'pc', to: 'srv', kind: 'icmp', size: 1472 });
  assert.equal(frag.ok, true);
  assert.ok(ev(s, (x) => x.what === 'fragmented' && /into 2 for the MTU of g1, 1400 \(configured on r1:g1\): 1396 \+ 124 bytes/.test(x.detail)).length === 1);
  assert.ok(ev(s, (x) => x.what === 'reassembled' && x.device === 'srv').length === 1);
  // the fragments' dots say so
  assert.ok(s.engine.flights.some((f) => / \(fragment 2\/2\)$/.test(f.label)));
  // TCP to a written listener: srv's full-size answer (1460 bytes, DF) is too big for the 1400-byte path;
  // r2's Frag Needed lowers srv's path MTU and the unacknowledged answer goes again in two segments over the same range
  const l = sim(CHAIN({ mtu: 1400, srv: ', simulation: {listening: tcp/80}' }));
  l.runTo(2500);
  const tcp = run(l, { from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  assert.equal(tcp.ok, true);
  assert.equal(tcp.result, 'connected and answered (1460 bytes)');
  assert.ok(ev(l, (x) => x.what === 'path MTU' && x.device === 'srv' && /10\.0\.1\.10 is 1400 bytes now \(Frag Needed from 10\.0\.2\.1 \(r2\)\)/.test(x.detail)).length === 1);
  const again = ev(l, (x) => x.device === 'srv' && x.protocol === 'tcp' && /sent again in smaller segments/.test(x.detail));
  assert.deepEqual(again.map((x) => /, (\d+) bytes:/.exec(x.detail)[1]), ['1360', '100']);
  assert.equal(ev(l, (x) => x.device === 'pc' && x.what === 'Test answered').length, 1, 'answered once');
  // port 81 is not in the listener: refused by a RST, not by PMTUD
  const closed = run(l, { from: 'pc', to: 'srv', kind: 'tcp', port: 81 });
  assert.equal(closed.result, 'connection refused: RST from 10.0.2.10 (srv)');
});

test('ICMP: port unreachable from a closed UDP port; none about a broadcast; the rate limit; Send ICMP errors off', () => {
  const s = sim(CHAIN({ srv: ', simulation: {listening: tcp/443}' }));
  s.runTo(2500);
  const udp = run(s, { from: 'pc', to: 'srv', kind: 'udp', port: 53 });
  assert.equal(udp.result, 'Port Unreachable from 10.0.2.10 (srv)');
  // two errors within the rate limit (500 ms): the second is not sent
  s.sendTest({ from: 'pc', to: '203.0.113.1', kind: 'icmp' });
  s.sendTest({ from: 'pc', to: '203.0.113.2', kind: 'icmp' });
  s.runTo(s.now + 6000);
  assert.ok(ev(s, (x) => x.what === 'no ICMP error' && /rate limit, one per 500 ms \(default\)/.test(x.detail)).length === 1);
  // off on r1: no error, the sender times out
  s.setParam('icmp-errors', 'off');
  const off = run(s, { from: 'pc', to: '203.0.113.3', kind: 'icmp' });
  assert.match(off.result, /^no answer within 5 s/);
  assert.ok(ev(s, (x) => /send ICMP errors Off \(simulation\)/.test(x.detail)).length >= 1);
  s.setParam('icmp-errors', undefined);
  // a UDP request to the broadcast address of srv's subnet: no ICMP error from anyone
  const before = ev(s, (x) => x.what === 'Port Unreachable').length;
  run(s, { from: 'srv', to: '10.0.2.255', kind: 'udp', port: 9 });
  assert.equal(ev(s, (x) => x.what === 'Port Unreachable').length, before);
});

// ------------------------------------------------------------------ TCP and UDP

test('TCP: handshake, request and answer, FIN close with TIME_WAIT; a closed port answers RST; with reply to closed ports off nothing', () => {
  const s = sim(CHAIN({ srv: ', simulation: {listening: "tcp/443, udp/53"}' }));
  s.runTo(2500);
  const ok = run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 443 }, 2000);
  assert.equal(ok.result, 'connected and answered (1460 bytes)');
  const types = ev(s, (x) => x.kind === 'message' && x.protocol === 'tcp' && x.t >= ok.started).map((x) => `${x.device} ${x.what}`);
  assert.deepEqual(types.slice(0, 9), ['pc TCP SYN', 'srv TCP SYN-ACK', 'pc TCP ACK', 'pc TCP data', 'srv TCP ACK', 'srv TCP data', 'pc TCP ACK', 'pc TCP FIN', 'srv TCP FIN']);
  assert.ok(s.connTable('pc').some((r) => r.state === 'TIME_WAIT'));
  assert.ok(s.connTable('srv').some((r) => r.state === 'LISTEN' && r.local === '*:443'));
  s.runTo(s.now + 61000);
  assert.ok(!s.connTable('pc').some((r) => r.state === 'TIME_WAIT'), 'TIME_WAIT is over after 60 s');
  const rst = run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 22 });
  assert.equal(rst.result, 'connection refused: RST from 10.0.2.10 (srv)');
  assert.deepEqual([rst.outcome.by, rst.outcome.reason, rst.outcome.cause], ['srv', 'closed', undefined], 'a closed port: its own RST, said so by srv');
  const u = run(s, { from: 'pc', to: 'srv', kind: 'udp', port: 53 });
  assert.equal(u.result, 'UDP answer from 10.0.2.10:53');
  // reply to closed ports off on srv: the SYN is dropped, the client retransmits and times out
  const s2 = sim(CHAIN({ srv: ', simulation: {listening: tcp/443, closed_port_reply: "off"}' }));
  s2.runTo(2500);
  const silent = run(s2, { from: 'pc', to: 'srv', kind: 'tcp', port: 22 });
  assert.match(silent.result, /^no answer within 5 s/);
  assert.ok(ev(s2, (x) => /dropped without an answer \(reply to closed ports Off \(device\)\)/.test(x.detail)).length >= 1);
});

test('TCP: an unanswered SYN is sent again after the initial RTO, doubling, until the SYN retries are spent: the connection times out', () => {
  const s = sim(CHAIN({ r1routes: ', {prefix: 198.51.100.0/24, blackhole: true}' }), { params: { 'tcp-syn-retries': 3, 'app-timeout': 60000 } });
  s.runTo(2500);
  const t = s.sendTest({ from: 'pc', to: '198.51.100.7', kind: 'tcp', port: 443 });
  s.runTo(s.now + 20000);
  const syns = ev(s, (x) => x.device === 'pc' && x.what === 'TCP SYN' && x.t >= t.started).map((x) => Math.round(x.t - t.started));
  // 0, 1, 3, 7 s (1 s, 2 s, 4 s), then 8 s later it gives up
  assert.deepEqual(syns, [0, 1000, 3000, 7000]);
  assert.equal(t.result, 'TCP connect timed out after 3 retransmissions');
  assert.ok(ev(s, (x) => /connection timed out: no answer to the SYN and its 3 retransmissions \(TCP SYN retries 3 \(simulation\)\)/.test(x.detail)).length === 1);
});

test('TCP keepalive: a connection kept open is probed after the keepalive time; a peer that is gone is reset after the probes', () => {
  const s = sim(CHAIN({ pc: ', simulation: {tcp_keepalive: 20}', srv: ', simulation: {listening: tcp/443}' }));
  s.runTo(2500);
  const t = run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 443, keep: true }, 2000);
  assert.match(t.result, /^connected; kept open \(keepalive after 20 s \(device\)\)$/);
  s.runTo(s.now + 21000);
  assert.ok(ev(s, (x) => x.what === 'keepalive' && x.device === 'pc' && /probe 1 of 9; keepalive time 20 s \(device\)/.test(x.detail)).length === 1);
  assert.ok(s.connTable('pc').some((r) => r.state === 'ESTABLISHED'), 'the probe was answered');
  s.powerOff('srv');
  s.runTo(s.now + 20000 + 9 * 75000 + 5000);
  assert.ok(ev(s, (x) => /reset: none of 9 keepalive probes answered/.test(x.detail)).length === 1);
  assert.ok(!s.connTable('pc').some((r) => r.state === 'ESTABLISHED'));
});

// ------------------------------------------------------------------ firewalls

const FW = (fw = '', srv = '') => `netatlas: 1
title: fw
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    ${fw ? 'simulation: ' + fw : ''}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/443, tcp/22, udp/53, udp/123"${srv}}}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
relations:
  - {id: dns-1, protocol: dns, endpoints: [pc, srv]}
`;

test('firewall: the model’s relations pass; the allow list opens sessions and their replies pass; anything else is dropped (silently) or rejected', () => {
  const s = sim(FW('{allow: "tcp/443"}'));
  s.runTo(2500);
  // the DNS relation's own queries pass (they are the model's policy)
  s.runTo(40000);
  assert.ok(ev(s, (x) => x.protocol === 'dns' && x.device === 'srv' && x.kind === 'message').length >= 1);
  assert.equal(run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 443 }, 3000).result, 'connected and answered (1460 bytes)');
  assert.ok(ev(s, (x) => x.what === 'session opened' && /10\.0\.1\.10:\d+ → 10\.0\.2\.10:443 \(allow tcp\/443, in in\)/.test(x.detail)).length === 1);
  const drop = run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 22 });
  assert.match(drop.result, /^no answer within 5 s/);
  assert.ok(ev(s, (x) => x.what === 'dropped' && /no relation of the model and no allow entry permits it \(default action Drop \(default\)\)/.test(x.detail)).length >= 1);
  const ping = run(s, { from: 'pc', to: 'srv', kind: 'icmp' });
  assert.match(ping.result, /^no answer/);
  // reject: TCP gets a RST (from the destination's address), anything else ICMP administratively prohibited
  const r = sim(FW('{allow: "tcp/443", default_action: reject}'));
  r.runTo(2500);
  // (the RST carries srv's address; it was sent by fw, which recorded why: its policy's rejection)
  const rej = run(r, { from: 'pc', to: 'srv', kind: 'tcp', port: 22 });
  assert.equal(rej.result, 'connection refused: RST from 10.0.2.10 (sent by fw, with the address of srv)');
  assert.deepEqual([rej.outcome.kind, rej.outcome.by, rej.outcome.byAddr, rej.outcome.reason, rej.outcome.cause.kind, rej.outcome.cause.policy.device], ['refused', 'fw', '10.0.2.10', 'policy', 'policy', 'fw']);
  const adm = run(r, { from: 'pc', to: 'srv', kind: 'udp', port: 123 });
  assert.equal(adm.result, 'Admin Prohibited from 10.0.1.1 (fw)');
  assert.deepEqual([adm.outcome.kind, adm.outcome.by, adm.outcome.reason, adm.outcome.cause.kind], ['unreachable', 'fw', 'policy', 'policy']);
  // a test on the DNS relation's port is the relation's traffic: it passes, with a session of its own
  assert.equal(run(r, { from: 'pc', to: 'srv', kind: 'udp', port: 53 }, 2000).result, 'UDP answer from 10.0.2.10:53');
  assert.ok(r.sessionTable('fw').some((x) => x.rule === 'relation dns-1'));
});

test('firewall: sessions time out by its timeouts; stateless it checks each packet (the reply by its source port)', () => {
  const s = sim(FW('{allow: "udp/123, icmp", udp_session_timeout: 10}'));
  s.runTo(2500);
  assert.equal(run(s, { from: 'pc', to: 'srv', kind: 'udp', port: 123 }, 2000).result, 'UDP answer from 10.0.2.10:123');
  assert.equal(s.sessionTable('fw').length, 1);
  assert.equal(s.sessionTable('fw')[0].rule, 'allow udp/123');
  s.runTo(s.now + 10000);
  assert.equal(s.sessionTable('fw').length, 0);
  assert.ok(ev(s, (x) => x.what === 'session timed out' && /idle for 10 s \(10 s \(device\)\)/.test(x.detail)).length === 1);
  // stateless: no session table; the answer passes because its source port is allowed
  const n = sim(FW('{allow: "udp/123", stateful: "off"}'));
  n.runTo(2500);
  assert.equal(run(n, { from: 'pc', to: 'srv', kind: 'udp', port: 123 }, 2000).result, 'UDP answer from 10.0.2.10:123');
  assert.equal(n.sessionTable('fw').length, 0);
  // stateful: a reply without its session (srv answers from 53 without being asked) is dropped
  const st = sim(FW('{allow: "udp/123"}'));
  st.runTo(2500);
  run(st, { from: 'srv', to: 'pc', kind: 'udp', port: 5353 });
  assert.ok(ev(st, (x) => x.device === 'fw' && /UDP 10\.0\.2\.10:\d+ → 10\.0\.1\.10:5353/.test(x.detail) && x.what === 'dropped').length === 1);
});

// ------------------------------------------------------------------ test traffic, load balancers, proxies, monitoring

test('endpoint test traffic: off by default; on, every interval to its gateway (ICMP) and the servers of its service relations (their port)', () => {
  const Y = FW('{allow: "tcp/443, icmp"}').replace('relations:\n', 'relations:\n  - {id: web, protocol: https, endpoints: [pc, srv]}\n');
  const off = sim(Y);
  off.runTo(12000);
  assert.equal(ev(off, (x) => x.what === 'Test answered' || x.what === 'Test failed').length, 0);
  const s = sim(Y, { params: { 'test-traffic': 'on', 'test-interval': 4000 } });
  s.runTo(12000);
  const rows = s.status().filter((r) => r.name.indexOf('pc → ') === 0).map((r) => `${r.name}: ${r.state}`);
  assert.deepEqual(rows, ['pc → gateway 10.0.1.1 ICMP echo: Answered', 'pc → srv tcp/443: Answered', 'pc → srv udp/53: Answered']);
  // its own targets instead, with an explicit test; the interval from the device
  const own = sim(Y.replace("routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}", 'routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}], simulation: {test_traffic: "on", test_interval: 2, test_targets: "srv tcp/22"}}'));
  own.runTo(8000);
  const t = own.status().filter((r) => r.name.indexOf('pc → ') === 0);
  assert.deepEqual(t.map((r) => r.name), ['pc → srv tcp/22']);
  assert.ok(ev(own, (x) => x.what === 'TCP SYN' && x.device === 'pc').length >= 3);
});

test('Send test…: to a device, an interface, an address, a subnet broadcast and 255.255.255.255; what cannot be sent says why', () => {
  const s = sim(FW('{allow: "icmp"}', ', respond_to_broadcast_ping: "on"'));
  s.runTo(2500);
  assert.equal(run(s, { from: 'pc', to: 'srv:eth0', kind: 'icmp' }).ok, true);
  assert.equal(run(s, { from: 'pc', to: '10.0.2.10', kind: 'icmp' }).ok, true);
  assert.equal(s.sendTest({ from: 'pc', to: 'nosuch', kind: 'icmp' }), 'nosuch is neither a device of the model, an address nor a host name');
  assert.deepEqual(s.broadcastTargets('srv'), ['10.0.2.255', '255.255.255.255']);
  // srv answers broadcast pings, fw does not (default off)
  const b = run(s, { from: 'fw', to: '10.0.2.255', kind: 'icmp' });
  assert.equal(b.result, '1 answer: 10.0.2.10 (srv)');
  assert.ok(ev(s, (x) => /does not answer ICMP Echo → 10\.0\.2\.255/.test(x.detail)).length === 0, 'fw does not ask itself');
  const tcp = run(s, { from: 'pc', to: '10.0.2.255', kind: 'tcp', port: 80 });
  assert.equal(tcp.result, 'not sent: TCP connects to one host, never to a broadcast or multicast address');
  assert.equal(s.tests()[0], tcp);
});

const LB = (pool = '') => `netatlas: 1
title: lb
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: pc2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.6/24}]}
  - {id: lb, type: load_balancer, interfaces: [{id: eth0, ip: 10.0.0.100/24}]}
  - {id: w1, type: server, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: w2, type: server, interfaces: [{id: eth0, ip: 10.0.0.12/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}, {id: p6, vlans: 1}, {id: p7, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "lb:eth0", b: "sw:p2"}
  - {id: c, a: "w1:eth0", b: "sw:p3"}
  - {id: d, a: "w2:eth0", b: "sw:p4"}
  - {id: f, a: "pc2:eth0", b: "sw:p6"}
relations:
  - {id: front, protocol: https, endpoints: [pc, lb]}
  - {id: m1, protocol: https, endpoints: [lb, w1]${pool}}
  - {id: m2, protocol: https, endpoints: [lb, w2]${pool}}
`;

test('load balancer: health checks keep its pool; round robin, then persistence by client; a member that fails its checks is taken out', () => {
  const s = sim(LB(', simulation: {persistence_timeout: 0}'));
  s.runTo(5000);
  assert.deepEqual(s.status().filter((r) => r.name.indexOf('lb pool') === 0).map((r) => `${r.name} ${r.state}`), ['lb pool: w1 tcp/443 Up', 'lb pool: w2 tcp/443 Up']);
  const chosen = () => ev(s, (x) => x.what === 'proxied' && x.device === 'lb').slice(-1)[0].peer;
  run(s, { from: 'pc', to: 'lb', kind: 'tcp', port: 443 }, 2000);
  const a = chosen();
  run(s, { from: 'pc', to: 'lb', kind: 'tcp', port: 443 }, 2000);
  assert.notEqual(chosen(), a, 'round robin');
  assert.ok(ev(s, (x) => /chosen by Round robin \(default\) among 2 healthy members/.test(x.detail)).length >= 2);
  // w2 off: down after 3 failed checks (2 s apart, 2 s timeout); then every request goes to w1
  s.powerOff('w2');
  s.runTo(s.now + 10000);
  assert.ok(ev(s, (x) => x.what === 'member down' && x.peer === 'w2' && /after 3 failed health checks \(threshold 3 \(default\)\)/.test(x.detail)).length === 1);
  for (let i = 0; i < 2; i++) {
    const t = run(s, { from: 'pc', to: 'lb', kind: 'tcp', port: 443 }, 2000);
    assert.equal(t.ok, true);
    assert.equal(chosen(), 'w1');
  }
  // persistence on: the same client keeps its member
  const p = sim(LB(''));
  p.runTo(5000);
  run(p, { from: 'pc', to: 'lb', kind: 'tcp', port: 443 }, 2000);
  run(p, { from: 'pc', to: 'lb', kind: 'tcp', port: 443 }, 2000);
  assert.ok(ev(p, (x) => /persistence: 10\.0\.0\.5 stays with w\d \(persistence timeout 3 min \(default\)\)/.test(x.detail)).length === 1);
});

test('monitoring: a manager pings the agents it polls by SNMP every ICMP probe interval; one powered off is unreachable', () => {
  const s = sim(`netatlas: 1
title: mon
devices:
  - {id: nms, type: system, purpose: host, interfaces: [{id: eth0, ip: 10.0.0.1/24}], simulation: {icmp_probe_interval: 5}}
  - {id: a1, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}], logical_interfaces: [{id: Vlan1, type: virtual, vlan: 1, ip: 10.0.0.2/24}]}
links:
  - {id: l, a: "nms:eth0", b: "a1:p1"}
relations:
  - {id: snmp-1, protocol: snmp, endpoints: [a1, nms]}
`);
  s.runTo(8000);
  assert.deepEqual(s.status().filter((r) => r.name === 'nms probe a1').map((r) => r.state), ['Reachable']);
  s.powerOff('a1');
  s.runTo(s.now + 6000);
  assert.deepEqual(s.status().filter((r) => r.name === 'nms probe a1').map((r) => r.state), ['Unreachable']);
  assert.ok(ev(s, (x) => x.what === 'unreachable' && /a1 is unreachable by ICMP probe \(no answer within 500 ms/.test(x.detail)).length === 1);
});

// ------------------------------------------------------------------ broadcast

const LAN = (sw = '', r = '') => `netatlas: 1
title: lan
devices:
  - {id: sw1, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]${sw}}
  - {id: sw2, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]${sw}}
  - {id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.254}], simulation: {respond_to_broadcast_ping: "on"}}
  - {id: h2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.254}]}
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.254/24${r}}, {id: g1, ip: 10.9.0.1/24}]}
  - {id: h9, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.9/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
  - {id: c, a: "sw1:p3", b: "h1:eth0"}
  - {id: d, a: "sw2:p3", b: "h2:eth0"}
  - {id: e, a: "sw1:p4", b: "r1:g0"}
  - {id: g, a: "r1:g1", b: "h9:eth0"}
`;

test('broadcast: a ping to the subnet broadcast is answered only where broadcast pings are on; a router never forwards 255.255.255.255; directed broadcasts only when on', () => {
  const s = sim(LAN());
  s.runTo(3000);
  assert.equal(run(s, { from: 'h2', to: '10.0.0.255', kind: 'icmp' }).result, '1 answer: 10.0.0.1 (h1)');
  assert.ok(ev(s, (x) => x.device === 'r1' && /r1 does not answer ICMP Echo → 10\.0\.0\.255 from 10\.0\.0\.2 \(respond to broadcast ping Off \(default\)\)/.test(x.detail)).length === 1);
  // the broadcast's dots are squares (cast), its frame to ff:ff:ff:ff:ff:ff
  assert.ok(s.engine.flights.some((f) => f.cast === 'broadcast' && f.hdr.l2.dst === 'ff:ff:ff:ff:ff:ff' && f.hdr.l3.length && f.hdr.l3[0].dst === '10.0.0.255'));
  run(s, { from: 'h2', to: '255.255.255.255', kind: 'icmp' });
  assert.ok(ev(s, (x) => x.device === 'r1' && /takes the limited broadcast 255\.255\.255\.255 itself and routes it nowhere/.test(x.detail)).length === 1);
  assert.ok(!s.engine.flights.some((f) => f.track.ref === 'link:g' && f.hdr && f.hdr.l3.length && f.hdr.l3[0].dst === '255.255.255.255'), 'it never reaches h9');
  // a directed broadcast from h9: dropped at r1 (off by default) …
  const off = run(s, { from: 'h9', to: '10.0.0.255', kind: 'icmp' });
  assert.match(off.result, /^no answer/);
  assert.ok(ev(s, (x) => x.kind === 'drop' && /r1 drops the directed broadcast to 10\.0\.0\.255 \(forward directed broadcasts Off \(default\); RFC 2644\)/.test(x.detail)).length === 1);
  // … sent on as a broadcast when it is on
  const on = sim(LAN('', ', simulation: {directed_broadcast: "on"}'));
  on.runTo(3000);
  assert.equal(run(on, { from: 'h9', to: '10.0.0.255', kind: 'icmp' }).result, '1 answer: 10.0.0.1 (h1)');
});

test('the broadcast domain: from an interface or a cable’s VLAN through the bridges, ending at every router', () => {
  const s = sim(LAN());
  s.runTo(2500);
  const d = s.broadcastDomain({ dev: 'h1', iface: 'eth0' });
  assert.deepEqual(d.devices, ['h1', 'h2', 'r1', 'sw1', 'sw2']);
  assert.ok(d.refs.includes('iface:r1:g0') && !d.refs.includes('iface:r1:g1') && !d.refs.includes('device:h9'));
  // the spanning tree blocks one of the two cables between the switches
  assert.equal(d.links.filter((l) => l === 'a' || l === 'b').length, 1);
  assert.deepEqual(s.broadcastDomain({ link: 'g', vlan: 0 }).devices, ['h9', 'r1']);
  s.fail('link:d');
  s.runTo(s.now + 100);
  assert.ok(!s.broadcastDomain({ dev: 'h1', iface: 'eth0' }).devices.includes('h2'), 'a failed cable ends it');
});

test('a storm: a loop without spanning tree circulates and multiplies broadcasts; storm control drops them; spanning tree on, or the loop broken, ends it', () => {
  const s = sim(LAN(', simulation: {stp_mode: "off"}'));
  // the loop is there once every cable is up (after the link-up delay): the first broadcast then storms
  s.runTo(2500);
  s.sendTest({ from: 'h2', to: '10.0.0.255', kind: 'icmp' });
  s.runTo(3000);
  assert.deepEqual(s.storms().map((x) => [x.vlan, x.links]), [[1, ['b']]]);
  assert.ok(ev(s, (x) => x.what === 'Broadcast storm' && /came back to sw\d over a loop that no spanning tree blocks/.test(x.detail)).length === 1);
  assert.ok(ev(s, (x) => x.what === 'MAC moved').length > 0, 'MAC addresses move between ports');
  assert.ok(ev(s, (x) => x.what === 'storm' && /has gone round the loop in VLAN 1 6 times/.test(x.detail)).length >= 1);
  // the log stays in time order
  const ts = s.events().map((x) => x.t);
  assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]));
  s.fail('link:b');
  s.runTo(s.now + 100);
  assert.deepEqual(s.storms(), []);
  assert.ok(ev(s, (x) => x.what === 'Storm over').length === 1);
  // storm control on sw1 drops the looping broadcasts at its ports
  const sc = sim(LAN(', simulation: {stp_mode: "off"}').replace('{id: sw1, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]', '{id: sw1, type: switch, interfaces: [{id: p1, vlans: 1, simulation: {storm_control_broadcast: 500}}, {id: p2, vlans: 1, simulation: {storm_control_broadcast: 500}}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]'));
  sc.runTo(2500);
  sc.sendTest({ from: 'h2', to: '10.0.0.255', kind: 'icmp' });
  sc.runTo(3000);
  assert.ok(ev(sc, (x) => x.what === 'storm control' && /far above its threshold of 500 frames\/s \(set on sw1:p[12]\)/.test(x.detail)).length >= 1);
  // spanning tree back on (a live change): the loop is blocked, the storm over
  s.restore('link:b');
  s.runTo(s.now + 3000);
  // the loop is open again: the next broadcast storms
  s.sendTest({ from: 'h2', to: '10.0.0.255', kind: 'icmp' });
  s.runTo(s.now + 100);
  assert.equal(s.storms().length, 1);
  s.setParam('stp-mode', 'rstp');
  s.deviceParamsFrom(model(LAN()));
  s.runTo(s.now + 100);
  assert.deepEqual(s.storms(), []);
  // with spanning tree from the start there is none
  const ok = sim(LAN());
  ok.runTo(2500);
  ok.sendTest({ from: 'h2', to: '10.0.0.255', kind: 'icmp' });
  ok.runTo(3000);
  assert.deepEqual(ok.storms(), []);
});

// ------------------------------------------------------------------ the inspector, wireless, BGP, determinism

test('the packet inspector: each dot’s frame layer by layer (MACs, VLAN tag, IP, TTL, DF, ports, flags, ICMP and its quote); the log’s messages carry theirs', () => {
  const s = sim(CHAIN({ srv: ', simulation: {listening: tcp/443}' }));
  s.runTo(2500);
  run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 443 }, 2000);
  run(s, { from: 'pc', to: '203.0.113.1', kind: 'icmp' }, 2000);
  const syn = s.engine.flights.find((f) => f.label === 'TCP [S] → 10.0.2.10:443' && f.track.ref === 'link:l2');
  assert.equal(syn.cast, 'unicast');
  assert.equal(syn.hdr.l2.ethertype, 'IPv4 (0x0800)');
  assert.equal(syn.hdr.l2.vlan, null);
  assert.deepEqual([syn.hdr.l3[0].src, syn.hdr.l3[0].dst, syn.hdr.l3[0].ttl, syn.hdr.l3[0].df, syn.hdr.l3[0].proto], ['10.0.1.10', '10.0.2.10', 63, true, 'TCP (6)']);
  assert.deepEqual([syn.hdr.l4.dport, syn.hdr.l4.flags], [443, ['SYN']]);
  const err = s.engine.flights.find((f) => f.label === 'ICMP Net Unreachable from 10.0.1.1');
  assert.deepEqual([err.hdr.l4.icmpType, err.hdr.l4.icmpCode, err.hdr.l4.quote.dst], [3, 0, '203.0.113.1']);
  const arp = s.engine.flights.find((f) => f.protocol === 'arp' && f.cast === 'broadcast');
  assert.match(arp.label, /^ARP Request \(broadcast\): who has 10\.0\.\d+\.\d+\?$/);
  assert.match(arp.hdr.l2.dstNote, /^broadcast/);
  assert.equal(arp.hdr.arp.targetMac, '00:00:00:00:00:00');
  const e = s.events().find((x) => x.kind === 'message' && x.what === 'TCP SYN');
  assert.deepEqual([e.hdr.l3[0].ttl, e.hdr.l2.src.length], [64, 17]);
  // a relation's message: its profile's transport (OSPF is IP 89, multicast)
  const o = new S.Simulation(model(example('protocol-simulation.yaml')));
  o.runTo(3000);
  const hello = o.engine.flights.find((f) => f.view === 'physical' && f.protocol === 'ospf' && /Hello/.test(f.label) && f.hdr);
  assert.equal(hello.cast, 'multicast');
  assert.equal(hello.hdr.l4.num, 89);
  assert.match(hello.hdr.l2.dstNote, /^IPv4 multicast 224\.0\.0\.5: 01:00:5e/);
});

test('a wireless client silent for its access point’s idle timeout is disassociated; its next frame waits for a beacon and the association', () => {
  const s = sim(`netatlas: 1
title: wifi
devices:
  - {id: ap, type: ap, services: {wireless: {networks: [{id: lan, ssid: LAN, untagged: true, radio: w, security: open}]}}, interfaces: [{id: w, simulation: {beacon_interval: 100ms}}, up], simulation: {client_idle_timeout: 20}}
  - {id: phone, type: endpoint, interfaces: [{id: wlan0, ip: 10.0.0.5/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.10/24}]}
links:
  - {id: air, a: "ap:w", b: "phone:wlan0", medium: wireless, wireless_network: lan}
  - {id: wire, a: "ap:up", b: "srv:eth0"}
`);
  s.runTo(25000);
  const t = run(s, { from: 'phone', to: 'srv', kind: 'icmp' }, 3000);
  assert.equal(t.ok, true);
  const e = ev(s, (x) => x.what === 'Associates again')[0];
  assert.match(e.detail, /^phone was disassociated by ap at t = 2\d(\.\d)? s \(client idle timeout 20 s \(device\)\): to send .* it waits for the next beacon \((at once|in \d+(\.\d+)? ms)\) and associates again \(1 s \(default\)\)/);
  assert.ok(t.rtt >= 1000, 'the round trip includes the association');
});

test('BGP’s TCP connection retransmits its SYN by the Layer 4 parameters, then the ConnectRetry timer tries again', () => {
  // b runs no BGP (no AS): nothing listens on its port 179, and it drops what comes there without a RST
  const Y = `netatlas: 1
title: bgp
devices:
  - {id: a, type: router, interfaces: [{id: g0, ip: 10.0.0.1/30}], protocols: {bgp: {asn: 65001}}}
  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], simulation: {closed_port_reply: "off"}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: l, a: "a:g0", b: "sw:p1"}
  - {id: m, a: "sw:p2", b: "b:g0"}
relations:
  - {id: ebgp, protocol: bgp, endpoints: ["a:g0", "b:g0"]}
`;
  const s = sim(Y, { params: { 'tcp-syn-retries': 2 } });
  s.runTo(10000);
  // the common transport's connection: the same SYN (its sequence number) again after 1 s, then 2 s
  const syns = ev(s, (x) => x.device === 'a' && x.protocol === 'bgp' && x.what === 'TCP SYN');
  assert.ok(syns.length >= 3);
  assert.match(syns[1].detail, /^BGP TCP 10\.0\.0\.1:\d+ → 10\.0\.0\.2:179 \[S\] seq \d+, MSS 1460: opens a connection \(BGP ebgp to b\), retransmission 1 \(timeout 1 s\)$/);
  const seq = (d) => /seq (\d+)/.exec(d)[1];
  assert.equal(seq(syns[1].detail), seq(syns[0].detail));
  assert.ok(Math.abs(syns[1].t - syns[0].t - 1000) < 1 && Math.abs(syns[2].t - syns[1].t - 2000) < 1);
  // the SYN retries spent: the connection times out, the session goes Active, and the ConnectRetry timer tries again
  assert.ok(ev(s, (x) => x.device === 'a' && x.what === 'connection closed' && /connection timed out: no answer to the SYN and its 2 retransmissions \(TCP SYN retries 2 \(simulation\)\)/.test(x.detail)).length === 1);
  assert.ok(ev(s, (x) => x.device === 'a' && x.protocol === 'bgp' && x.state === 'Active' && /TCP connection to 10\.0\.0\.2:179 failed: connection timed out/.test(x.detail)).length === 1);
  assert.ok(s.connTable('a').every((r) => r.state !== 'SYN_SENT'), 'nothing is left half-open');
});

test('determinism: the same model and the same tests at the same times give the same timeline', () => {
  const go = () => {
    const s = new S.Simulation(model(example('protocol-simulation.yaml')));
    s.runTo(6000);
    s.sendTest({ from: 'pc2', to: 'web', kind: 'tcp', port: 443 });
    s.runTo(20000);
    return s.events().map((e) => `${e.t}|${e.device}|${e.what}|${e.detail}`).join('\n');
  };
  assert.equal(go(), go());
});

test('TCP over a lossy cable: what is lost is sent again after the retransmission timeout, and the test is still answered', () => {
  const s = sim(CHAIN({ srv: ', simulation: {listening: tcp/443}' }).replace('  - {id: l3, a: "r2:g1", b: "srv:eth0"}', '  - {id: l3, a: "r2:g1", b: "srv:eth0", simulation: {loss: 25}}'), { params: { 'app-timeout': 60000 } });
  s.runTo(2500);
  const tests = [];
  for (let i = 0; i < 4; i++) tests.push(run(s, { from: 'pc', to: 'srv', kind: 'tcp', port: 443 }, 30000));
  assert.ok(ev(s, (x) => x.kind === 'message' && x.protocol === 'tcp' && /retransmission \d/.test(x.detail)).length > 0, 'something was retransmitted');
  assert.ok(ev(s, (x) => x.kind === 'drop' && /lost on l3 \(packet loss 25 % \(configured on cable l3\)\)/.test(x.detail)).length > 0);
  assert.ok(tests.filter((t) => t.ok).length >= 3, tests.map((t) => t.result).join(' | '));
});

test('Send test… to a multicast group: a multicast frame on the segment, no ICMP error from anyone', () => {
  const s = sim(LAN());
  s.runTo(3000);
  const t = run(s, { from: 'h2', to: '239.1.1.1', kind: 'udp', port: 5004 });
  assert.equal(t.result, 'no member received it within 5 s (default)');
  const f = s.engine.flights.find((x) => x.cast === 'multicast' && x.hdr && x.hdr.l3.length && x.hdr.l3[0].dst === '239.1.1.1');
  assert.equal(f.hdr.l2.dst, '01:00:5e:01:01:01');
  assert.match(f.hdr.l2.dstNote, /IPv4 multicast 239\.1\.1\.1: 01:00:5e \+ the group’s low 23 bits/);
  assert.equal(ev(s, (x) => /Unreachable/.test(x.what)).length, 0);
  // TCP to a group is refused at once
  assert.equal(s.sendTest({ from: 'h2', to: '239.1.1.1', kind: 'tcp', port: 80 }).result, 'not sent: TCP connects to one host, never to a broadcast or multicast address');
});

test('the Edit tab writes a list attribute as one text (and reads a YAML list); the Simulation section lists the attributes of the device’s type', () => {
  const D = load('editor/document.js');
  const At = load('analysis/sim/attrs.js');
  const d = D.ModelDoc.fromText(`netatlas: 1\ntitle: t\ndevices:\n  - id: fw\n    type: firewall\n    interfaces: [{id: in, ip: 10.0.0.1/24}]\n  - id: lb\n    type: load_balancer\n`, 't.yaml', 'file').doc;
  d.setSimAttr(0, 'allow', 'tcp/443, udp/53');
  d.setSimAttr(0, 'default_action', 'reject');
  assert.match(d.exportText(), /allow: tcp\/443, udp\/53|allow: "tcp\/443, udp\/53"/);
  assert.equal(d.result.model.index.devices.get('fw').simulation.get('fw-allow'), 'tcp/443, udp/53');
  assert.deepEqual(d.result.errors, []);
  const m = d.result.model;
  const keys = (id) => At.deviceAttributes(m, m.index.devices.get(id)).map((p) => p.yaml);
  for (const k of ['default_action', 'allow', 'stateful', 'tcp_session_timeout', 'respond_to_ping', 'icmp_errors']) assert.ok(keys('fw').includes(k), k);
  assert.ok(keys('lb').includes('listening'));
  for (const k of ['health_check_interval', 'algorithm', 'persistence_timeout']) assert.ok(!keys('lb').includes(k), k + ': per pool relation');
});
