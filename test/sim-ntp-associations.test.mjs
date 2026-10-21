// NTP upstreams are addresses (associations, RFC 5905 §9), not devices
// (analysis/sim/service-relations.ts, protocols.ts exactSides, ntp.ts): the
// client asks exactly the address configured, a response counts for the
// association of the address it comes from — never for another address of
// the same server —, two addresses of one server are two associations, and
// an address two routing contexts both have is the device the client's
// traffic reaches. Asserted by the packets' addresses, the association each
// response updated, the source, the stratum and the snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const T = load('analysis/timing.js');
const C = load('analysis/communication.js');

/** a client 10.0.0.10 and a reference with 10.0.0.1 on its LAN and 192.0.2.1 on a loopback */
const REF = (o = {}) => `netatlas: 1
title: ntp associations
devices:
  - id: cl
    type: server
    interfaces: [{id: eth0, ip: ${o.v6 ? '[10.0.0.10/24, "2001:db8::10/64"]' : '10.0.0.10/24'}}]
${o.route ? '    routes: [{prefix: 192.0.2.0/24, via: 10.0.0.1}]\n' : ''}    services: {ntp: {upstreams: [${o.ups || '192.0.2.1'}]}}
  - id: ref
    type: server
    interfaces: [{id: eth0, ip: ${o.v6 ? '[10.0.0.1/24, "2001:db8::1/64"]' : '10.0.0.1/24'}}]
    logical_interfaces: [{id: lo, type: loopback, ip: 192.0.2.1/32}]
    services: {ntp: {stratum: 1}}
links:
  - {id: l, a: "cl:eth0", b: "ref:eth0"}
`;

const sim = (t) => new S.Simulation(model(t));
const requests = (s, dev = 'cl') => s.events().filter((e) => e.kind === 'message' && e.protocol === 'ntp' && e.device === dev && e.what === 'Client request');
/** the address a request was sent to (its header; one dropped before it left has none: its text names it) */
const dstOf = (e) => (e.hdr ? e.hdr.l3[0].dst : /→ \S+ \(([^)]+)\)/.exec(e.detail)[1]);
const responses = (s, to = 'cl') => s.events().filter((e) => e.kind === 'message' && e.protocol === 'ntp' && e.what === 'Server response' && e.hdr && e.hdr.l3[0].dst.startsWith(to === 'cl' ? '10.0.0.10' : to));
const row = (s, addr, dev = 'cl') => s.ntp.table(dev).rows.find((r) => r[0] === addr);

test('a loopback upstream without a route: the client asks 192.0.2.1 (not 10.0.0.1), nothing comes back, it stays unsynchronized — no time from having exchanged NTP with another address of the server', () => {
  const s = sim(REF());
  s.runTo(200000);
  const rq = requests(s);
  assert.ok(rq.length >= 3);
  assert.ok(rq.every((e) => dstOf(e) === '192.0.2.1'), 'every request to the configured address');
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'cl' && /no route to 192\.0\.2\.1/.test(e.detail)));
  assert.equal(responses(s).length, 0, 'no response');
  assert.equal(s.ntp.synchronized('cl'), false);
  assert.equal(s.ntp.stratum('cl'), 16);
  assert.deepEqual(row(s, '192.0.2.1').slice(0, 3), ['192.0.2.1', 'ref', 'never']);
  const snap = s.snapshot().timing.find((t) => t.dev === 'cl');
  assert.equal(snap.synchronized, false);
  assert.equal(snap.source, undefined);
});

test('a loopback upstream with a route: requests to 192.0.2.1, responses from 192.0.2.1, synchronized to that association (status, table, snapshot address)', () => {
  const s = sim(REF({ route: true }));
  s.runTo(200000);
  const r = responses(s);
  assert.ok(r.length >= 2);
  assert.ok(r.every((e) => e.hdr.l3[0].src === '192.0.2.1'), 'answered from the address asked');
  assert.equal(s.ntp.synchronized('cl'), true);
  assert.equal(s.ntp.stratum('cl'), 2);
  assert.match(s.ntp.text('cl'), /^synchronized to 192\.0\.2\.1/);
  assert.equal(row(s, '192.0.2.1')[4], 'its source');
  const snap = s.snapshot().timing.find((t) => t.dev === 'cl');
  assert.deepEqual([snap.synchronized, snap.source, snap.address], [true, 'ref', '192.0.2.1']);
});

test('two addresses of one server are two associations: both asked; one unreachable (no route) never answers and stays “never”, the other is the source', () => {
  const s = sim(REF({ ups: '192.0.2.1, 10.0.0.1' }));
  s.runTo(200000);
  const dst = new Set(requests(s).map(dstOf));
  assert.deepEqual(Array.from(dst).sort(), ['10.0.0.1', '192.0.2.1'], 'two associations, two destinations');
  assert.match(row(s, '10.0.0.1')[2], /ago$/);
  assert.equal(row(s, '192.0.2.1')[2], 'never', 'the unreachable association received nothing');
  assert.equal(row(s, '10.0.0.1')[4], 'its source');
  assert.match(s.ntp.text('cl'), /^synchronized to 10\.0\.0\.1/);
  // with the route, both answer, each from its own address
  const t = sim(REF({ ups: '192.0.2.1, 10.0.0.1', route: true }));
  t.runTo(200000);
  const src = new Set(responses(t).map((e) => e.hdr.l3[0].src));
  assert.deepEqual(Array.from(src).sort(), ['10.0.0.1', '192.0.2.1']);
  assert.match(row(t, '10.0.0.1')[2], /ago$/);
  assert.match(row(t, '192.0.2.1')[2], /ago$/);
});

test('a policy denying one of the server’s addresses: that association never answers, the other one is the source', () => {
  const t = `netatlas: 1
title: ntp through a firewall
devices:
  - {id: cl, type: server, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}], services: {ntp: {upstreams: [192.0.2.1, 10.2.0.1]}}}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.1.0.1/24}, {id: out, ip: 10.2.0.254/24}]
    routes: [{prefix: 192.0.2.0/24, via: 10.2.0.1}]
    policy:
      default: permit
      rules:
        - {action: deny, destination: 192.0.2.1/32, proto: udp, dport: 123}
  - id: ref
    type: server
    interfaces: [{id: eth0, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: lo, type: loopback, ip: 192.0.2.1/32}]
    routes: [{prefix: 10.1.0.0/24, via: 10.2.0.254}]
    services: {ntp: {stratum: 1}}
links:
  - {id: a, a: "cl:eth0", b: "fw:in"}
  - {id: b, a: "fw:out", b: "ref:eth0"}
`;
  const s = sim(t);
  s.runTo(200000);
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'fw' && /192\.0\.2\.1:123/.test(e.detail)), 'the firewall drops the requests to 192.0.2.1');
  assert.equal(row(s, '192.0.2.1')[2], 'never');
  assert.match(s.ntp.text('cl'), /^synchronized to 10\.2\.0\.1/);
});

test('the same upstream address in two routing contexts: the association is the device the client reaches (stratum 2 from ref, not 4 from the other), whichever is listed first', () => {
  const t = `netatlas: 1
title: overlapping upstream
devices:
  - {id: other, type: server, interfaces: [{id: eth0, ip: 10.5.0.1/24}], services: {ntp: {stratum: 3}}}
  - {id: cl, type: server, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}], services: {ntp: {upstreams: [10.5.0.1]}}}
  - id: r
    type: router
    interfaces:
      - {id: c, ip: 10.1.0.1/24}
      - {id: s, ip: 10.5.0.254/24}
      - {id: x, ip: 10.5.0.254/24, vrf: iso}
  - {id: ref, type: server, interfaces: [{id: eth0, ip: 10.5.0.1/24}], routes: [{prefix: 0.0.0.0/0, via: 10.5.0.254}], services: {ntp: {stratum: 1}}}
links:
  - {id: a, a: "cl:eth0", b: "r:c"}
  - {id: b, a: "r:s", b: "ref:eth0"}
  - {id: c, a: "r:x", b: "other:eth0"}
`;
  const s = sim(t);
  s.runTo(200000);
  assert.equal(row(s, '10.5.0.1')[1], 'ref');
  assert.equal(s.ntp.stratum('cl'), 2);
  assert.equal(s.snapshot().timing.find((x) => x.dev === 'cl').source, 'ref');
  // the static chain: the same device (the trace's destination), not the first holder by id
  const st = T.ntpSource(model(t), 'cl');
  assert.equal(st.verdict, 'satisfied', st.text);
  assert.deepEqual(st.chain, ['cl', 'ref']);
  // and the trace names the destination it reached (it named the first holder, other, while its path reached ref)
  const c = C.checkCommunication(model(t), { from: 'cl', to: '10.5.0.1', service: 'udp/123' });
  assert.deepEqual([c.trace.dest.device, c.trace.paths[0].end.device, c.to.device], ['ref', 'ref', 'ref']);
});

test('IPv6: the upstream 2001:db8::1 is asked and answers from that address; synchronized to it', () => {
  const s = sim(REF({ v6: true, ups: '"2001:db8::1"' }));
  s.runTo(200000);
  assert.ok(requests(s).some((e) => e.hdr && e.hdr.l3[0].dst === '2001:db8::1' && e.hdr.l3[0].src === '2001:db8::10'));
  const r = s.events().filter((e) => e.kind === 'message' && e.what === 'Server response' && e.hdr);
  assert.ok(r.length && r.every((e) => e.hdr.l3[0].src === '2001:db8::1'));
  assert.match(s.ntp.text('cl'), /^synchronized to 2001:db8::1/);
});

test('the server reboots: the association goes unanswered, is lost after 8 polls, and comes back with the server’s first response — from the same address', () => {
  const s = sim(REF({ route: true }));
  s.runTo(150000);
  assert.equal(s.ntp.synchronized('cl'), true);
  const t0 = s.now;
  s.powerOff('ref');
  s.runTo(t0 + 9 * 64000);
  assert.equal(s.ntp.synchronized('cl'), false);
  assert.match(s.ntp.text('cl'), /no response from 192\.0\.2\.1 for 8 polls/);
  const t1 = s.now;
  s.powerOn('ref');
  s.runTo(t1 + 3 * 64000);
  assert.equal(s.ntp.synchronized('cl'), true);
  const back = responses(s).filter((e) => e.t >= t1);
  assert.ok(back.length && back.every((e) => e.hdr.l3[0].src === '192.0.2.1'));
});

test('a response from an address that is none of the client’s upstreams is not taken (an ntp relation of the model between the two, asking the server’s LAN address, while the client’s upstream is its loopback)', () => {
  const t = REF({ route: true }) + 'relations:\n  - {id: n, protocol: ntp, endpoints: ["cl", "ref"]}\n';
  const s = sim(t);
  s.runTo(200000);
  const r = responses(s);
  assert.ok(r.length && r.every((e) => e.hdr.l3[0].src === '10.0.0.1'), 'the model’s relation asks 10.0.0.1');
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'cl' && /response from 10\.0\.0\.1: none of its upstreams \(192\.0\.2\.1\) is that address/.test(e.detail)));
  assert.equal(s.ntp.synchronized('cl'), false);
});
