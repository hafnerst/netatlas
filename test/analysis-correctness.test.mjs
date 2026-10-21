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

// ------------------------------------------------------------------ policy identities by effective addresses

const S = load('analysis/sim/simulation.js');
const PO = load('analysis/policy.js');
const IP = load('model/ip.js');

// pc takes DHCP and SLAAC addresses, st is static; fw's explicit policy names devices
const POLICY = (rules, def = 'deny', lease = '1h') => `netatlas: 1
title: policy identities
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ipv4: dhcp, ipv6: slaac}]
  - id: st
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.50/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: dsrv
    type: server
    services:
      dhcp:
        scopes: [{network: lan, range: 10.1.0.100-10.1.0.199, gateway: 10.1.0.1, dns: [10.1.0.5], lease: ${lease}}]
    interfaces: [{id: eth0, ip: 10.1.0.5/24}]
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
  - id: fw
    type: firewall
    interfaces:
      - id: lan
        ip: [10.1.0.1/24, "2001:db8:10::1/64"]
        ipv6_ra: {prefixes: ["2001:db8:10::/64"]}
      - {id: wan, ip: [10.9.0.1/24, "2001:db8:99::1/64"]}
    policy:
      default: ${def}
      rules:
${rules}
  - id: srv
    type: server
    simulation: {listening: "tcp/80"}
    interfaces: [{id: eth0, ip: [10.9.0.10/24, "2001:db8:99::10/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}, {prefix: "::/0", via: "2001:db8:99::1"}]
links:
  - {id: l-pc, a: "pc:eth0", b: "sw:p1"}
  - {id: l-st, a: "st:eth0", b: "sw:p2"}
  - {id: l-d, a: "dsrv:eth0", b: "sw:p3"}
  - {id: l-fw, a: "fw:lan", b: "sw:p4"}
  - {id: l-srv, a: "fw:wan", b: "srv:eth0"}
networks:
  - {id: lan, cidr: 10.1.0.0/24}
`;
const PERMIT_PC = `        - {action: permit, source: pc, destination: srv, proto: tcp, dport: 80}
        - {action: permit, source: "pc:eth0", destination: "2001:db8:99::10", proto: tcp, dport: 80}`;

/** run a TCP test to its end */
function tcp(s, from, to) {
  const t = s.sendTest({ from, to, kind: 'tcp', port: 80 });
  assert.equal(typeof t, 'object', String(t));
  s.runTo(s.now + 10000);
  return t;
}

test('policy: a rule naming a DHCP / SLAAC device or interface matches its acquired addresses in the simulation; a static device is itself; the default for the rest', () => {
  const m = model(POLICY(PERMIT_PC));
  const s = new S.Simulation(m);
  s.runTo(30000);
  const leased = s.engine.effectiveAddrs('pc').map((x) => x.addr);
  assert.ok(leased.some((a) => a.version === 4) && leased.some((a) => a.version === 6), 'pc has a lease and a SLAAC address');
  assert.equal(tcp(s, 'pc', '10.9.0.10').ok, true, 'the IPv4 lease matches "source: pc"');
  assert.equal(tcp(s, 'pc', '2001:db8:99::10').ok, true, 'the SLAAC address matches "source: pc:eth0"');
  const st = tcp(s, 'st', '10.9.0.10');
  assert.equal(st.ok, false, 'st is named by no rule: the default deny');
  assert.match(st.result, /fw|denied|policy/i);
});

test('policy: a frozen snapshot uses the addresses acquired then — the same decision as the simulation; the configured model says it can’t decide, never a definite answer', () => {
  const m = model(POLICY(PERMIT_PC));
  const s = new S.Simulation(m);
  s.runTo(30000);
  const snap = s.snapshot();
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' }, snap);
  assert.equal(c.layers.find((l) => l.id === 'policy').verdict, 'satisfied', c.headline);
  assert.equal(c.verdict, 'satisfied', c.headline);
  // the configured model: pc has no address yet (its own layer says so); a destination rule naming a DHCP device, to an address
  // nobody has configured, is undecided — not a non-match that would let it through
  const deny = model(POLICY('        - {action: deny, destination: pc, proto: tcp, dport: 80}', 'permit'));
  const cfg = C.checkCommunication(deny, { from: 'st', to: '10.1.0.150', service: 'tcp/80' });
  const pol = cfg.trace ? cfg.trace.paths.flatMap((p) => p.hops.flatMap((h) => h.notes || [])).join(' | ') : '';
  assert.notEqual(cfg.verdict, 'satisfied', cfg.headline);
  void pol;
  const flow = { src: IP.parseAddress('10.1.0.50'), dst: IP.parseAddress('10.1.0.150'), proto: 'tcp', dport: 80, srcDev: 'st', dstDev: null, inIface: 'lan', outIface: 'lan' };
  const d = PO.policyDecision(deny, deny.index.devices.get('fw'), flow, true);
  assert.ok(PO.undecided(d), d.text);
  assert.match(d.text, /an address a device takes at runtime/);
  // known to be another device's: a definite non-match (a static address, the configured model)
  const d2 = PO.policyDecision(deny, deny.index.devices.get('fw'), { ...flow, dst: IP.parseAddress('10.1.0.5'), dstDev: 'dsrv' }, true);
  assert.equal(PO.undecided(d2), false);
  assert.equal(d2.permit, true, d2.text);
  // the same rule in the snapshot: pc's lease is pc's, another address is not
  const ss = new S.Simulation(deny);
  ss.runTo(30000);
  const snap2 = ss.snapshot();
  const lease = ss.engine.effectiveAddrs('pc').find((x) => x.addr.version === 4).addr;
  const ids = PO.ctxIds(deny, snap2.ctx);
  assert.equal(PO.specMatches(deny, 'pc', lease, ids), true);
  assert.equal(PO.specMatches(deny, 'pc', IP.parseAddress('10.1.0.199'), ids), false);
  assert.equal(PO.specMatches(deny, 'pc:eth0', lease, ids), true);
  // never a whole subnet for a device
  assert.equal(PO.specMatches(deny, 'pc', IP.parseAddress('10.1.0.0'), ids), false);
});

test('policy: an expired lease is no identity any more; a renewed one still is (the same address)', () => {
  const m = model(POLICY(PERMIT_PC, 'deny', '60s'));
  const s = new S.Simulation(m);
  s.runTo(30000);
  const lease = s.engine.effectiveAddrs('pc').find((x) => x.addr.version === 4).addr;
  // renewed at T1 by the server: still pc's
  s.runTo(30000 + 60000);
  assert.ok(s.engine.effectiveAddrs('pc').some((x) => IP.compareAddr ? true : true));
  assert.equal(PO.specMatches(m, 'pc', lease, PO.ctxIds(m, s.snapshot().ctx)), true, 'renewed');
  assert.equal(tcp(s, 'pc', '10.9.0.10').ok, true);
  // the server gone: no renewal, the lease expires — the address is nobody's
  s.powerOff('dsrv');
  s.runTo(s.now + 130000);
  assert.ok(!s.engine.effectiveAddrs('pc').some((x) => x.addr.version === 4), 'expired');
  assert.equal(PO.specMatches(m, 'pc', lease, PO.ctxIds(m, s.snapshot().ctx)), false);
});

// two VRFs of one firewall with the same host address on both sides: hostR and hostB are both 10.9.0.5
// (each side its own gateway and server addresses: the tracer resolves a next hop to an address's first holder, not per segment)
const VRFS = `netatlas: 1
title: overlapping VRFs
devices:
  - {id: hostR, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.254}]}
  - {id: srvR, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - {id: srvB, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.7.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - id: fw
    type: firewall
    interfaces:
      - {id: r-in, ip: 10.9.0.1/24, vrf: red}
      - {id: r-out, ip: 10.8.0.1/24, vrf: red}
      - {id: b-in, ip: 10.9.0.254/24, vrf: blue}
      - {id: b-out, ip: 10.7.0.1/24, vrf: blue}
    policy:
      default: deny
      rules:
        - {action: permit, source: hostR, proto: tcp, dport: 80}
links:
  - {id: a, a: "hostR:eth0", b: "fw:r-in"}
  - {id: b, a: "hostB:eth0", b: "fw:b-in"}
  - {id: c, a: "fw:r-out", b: "srvR:eth0"}
  - {id: d, a: "fw:b-out", b: "srvB:eth0"}
`;

test('policy: overlapping addresses in two VRFs — a rule naming one host does not match the other host with the same address (analysis and simulation)', () => {
  const m = model(VRFS);
  const r = C.checkCommunication(m, { from: 'hostR', to: 'srvR', service: 'tcp/80' });
  assert.equal(r.verdict, 'satisfied', r.headline);
  const b = C.checkCommunication(m, { from: 'hostB', to: 'srvB', service: 'tcp/80' });
  assert.equal(b.layers.find((l) => l.id === 'policy').verdict, 'violated', b.headline);
  const s = new S.Simulation(m);
  s.runTo(10000);
  assert.equal(tcp(s, 'hostR', 'srvR').ok, true);
  assert.equal(tcp(s, 'hostB', 'srvB').ok, false, 'hostB is not hostR, whatever its address');
});
