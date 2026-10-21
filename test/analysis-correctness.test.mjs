// Targeted analysis correctness: the address family asked for is the one
// evaluated end to end (endpoints, names, traces, identity, expectations,
// the simulation's prefill); policy identities by effective addresses;
// the complete Analyze-to-Simulate identity; incomplete runs never a final
// agreement; application-derived capacity; NTP chain feasibility; VRF-scoped
// broadcast source selection. Asserted by the effective addresses and paths,
// not only the headlines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const C = load('analysis/communication.js');
const I = load('analysis/comm-identity.js');
const T = load('analysis/trace.js');

// pc and srv are dual-stack; r1 routes IPv4 to srv but has no IPv6 on srv's side (IPv6 unrouted); v6s is reached over IPv6 only
const DUAL = `netatlas: 1
title: dual stack
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: [10.0.1.10/24, "fd00:1::10/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}, {prefix: "::/0", via: "fd00:1::1"}]
    services:
      applications:
        - {id: web6, name: Web over IPv6, profile: tcp_client, peer: srv/web, ip_version: 6}
        - {id: web4, name: Web over IPv4, profile: tcp_client, peer: srv/web}
  - id: r1
    type: router
    interfaces:
      - {id: eth0, ip: [10.0.1.1/24, "fd00:1::1/64"]}
      - {id: eth1, ip: 10.0.2.1/24}
      - {id: eth2, ip: "fd00:3::1/64"}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: [10.0.2.20/24, "fd00:2::20/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]
    services:
      applications:
        - {id: web, name: Web, profile: tcp_server, port: 80}
  - id: v6s
    type: server
    interfaces: [{id: eth0, ip: [10.0.3.30/24, "fd00:3::30/64"]}]
    routes: [{prefix: "::/0", via: "fd00:3::1"}]
  - id: v4only
    type: server
    interfaces: [{id: eth0, ip: 10.0.2.40/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]
links:
  - {id: a, a: "pc:eth0", b: "r1:eth0"}
  - {id: b, a: "r1:eth1", b: "srv:eth0"}
  - {id: c, a: "r1:eth2", b: "v6s:eth0"}
`;

const check = (m, req) => C.checkCommunication(m, req);
const ends = (c) => [c.trace && c.trace.source ? c.trace.source.address : null, c.trace && c.trace.dest ? c.trace.dest.address : null];

test('family: IPv6 asked for is IPv6 evaluated — devices and interfaces resolved in it (never IPv4 instead), and the reverse', () => {
  const m = model(DUAL);
  // IPv4 succeeds, IPv6 is unrouted (r1 has no IPv6 towards srv)
  const v4 = check(m, { from: 'pc', to: 'srv', family: 4 });
  assert.deepEqual(ends(v4), ['10.0.1.10', '10.0.2.20']);
  assert.equal(v4.verdict, 'satisfied');
  const v6 = check(m, { from: 'pc', to: 'srv', family: 6 });
  assert.deepEqual(ends(v6), ['fd00:1::10', 'fd00:2::20'], 'the IPv6 addresses, not the IPv4 ones');
  assert.notEqual(v6.verdict, 'satisfied', v6.headline);
  assert.equal(v6.layers.find((l) => l.id === 'path').verdict, 'violated');
  // interfaces as ends: the same
  const i6 = check(m, { from: 'pc:eth0', to: 'srv:eth0', family: 6 });
  assert.deepEqual(ends(i6), ['fd00:1::10', 'fd00:2::20']);
  assert.notEqual(i6.verdict, 'satisfied');
  // the reverse: IPv6 succeeds, IPv4 is unrouted (r1 has no IPv4 towards v6s)
  const r6 = check(m, { from: 'pc', to: 'v6s', family: 6 });
  assert.deepEqual(ends(r6), ['fd00:1::10', 'fd00:3::30']);
  assert.equal(r6.verdict, 'satisfied');
  const r4 = check(m, { from: 'pc', to: 'v6s', family: 4 });
  assert.deepEqual(ends(r4), ['10.0.1.10', '10.0.3.30']);
  assert.notEqual(r4.verdict, 'satisfied');
});

test('family: unavailable in the asked family — said so, no fallback to the other one', () => {
  const m = model(DUAL);
  const c = check(m, { from: 'pc', to: 'v4only', family: 6 });
  assert.notEqual(c.verdict, 'satisfied');
  assert.equal(c.trace && c.trace.dest ? c.trace.dest.address : undefined, undefined, 'nothing traced to its IPv4 address');
  assert.match(c.layers.map((l) => l.text + ' ' + l.detail.join(' ')).join(' | '), /v4only has no IPv6 address/);
  // the tracer itself, asked directly
  assert.match(T.tracePath(m, { from: 'pc', to: 'v4only', family: 6 }).error, /Destination: v4only has no IPv6 address to trace to/);
  assert.match(T.tracePath(m, { from: '10.0.1.10', to: 'srv', family: 6 }).error, /Source: 10\.0\.1\.10 is an IPv4 address, not IPv6/);
  assert.match(T.tracePath(m, { from: 'v4only', to: 'srv', family: 6 }).error, /Source: v4only has no IPv6 address/);
  // no family: as before (IPv4 first)
  assert.deepEqual(ends(check(m, { from: 'pc', to: 'srv' })), ['10.0.1.10', '10.0.2.20']);
});

test('family: application endpoints — a client’s ip_version, a listener asked for in a family; identity, expectation and prefill keep it', () => {
  const m = model(DUAL);
  const a6 = check(m, { from: 'pc/web6' });
  assert.deepEqual(ends(a6), ['fd00:1::10', 'fd00:2::20']);
  assert.notEqual(a6.verdict, 'satisfied');
  const a4 = check(m, { from: 'pc/web4' });
  assert.deepEqual(ends(a4), ['10.0.1.10', '10.0.2.20']);
  const l6 = check(m, { from: 'pc', to: 'srv/web', family: 6 });
  assert.deepEqual(ends(l6), ['fd00:1::10', 'fd00:2::20']);
  // the identity, the saved expectation and the simulation's prefill: the same family and addresses
  const id = I.commIdentity(m, l6);
  assert.equal(id.family, 6);
  assert.equal(id.destination.address, 'fd00:2::20');
  assert.equal(I.expectationFields(id).family, 6);
  const h = I.handoffOf(m, id);
  assert.equal(h.prefill.toAddr, 'fd00:2::20');
  assert.ok(h.carried.some((x) => /IPv6/.test(x)));
  // a host name can't carry IPv6 into Send network packets (it resolves A): said, not claimed
  const nid = { ...id, destination: { binding: 'name', name: 'srv.example.net' } };
  const nh = I.handoffOf(m, nid);
  assert.ok(nh.notTransferred.some((x) => /resolves srv\.example\.net for IPv4/.test(x)));
  assert.ok(!nh.carried.some((x) => /IPv6/.test(x)));
});
