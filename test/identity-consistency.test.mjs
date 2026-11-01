// The same communication keeps its identity from Analyze to the simulation: the static check takes the source and
// destination addresses the simulation's sender takes (the route's egress; a device's first interface, loopbacks last),
// a host name keeps its family, a tunnel's outer packets keep the routing context Trace path gives them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const I = load('analysis/comm-identity.js');

// r1 and r2, each with a loopback; r1's LAN is first by kind and id ("lan" < "wan") but the route to r2 leaves by wan
const PAIR = `netatlas: 1
title: identity
devices:
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 10.0.0.1/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]
  - id: r2
    type: router
    interfaces: [{id: wan, ip: 10.0.0.2/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.0.1}, {prefix: 10.255.0.1/32, via: 10.0.0.1}]
  - {id: h, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
links:
  - {id: l1, a: r1:wan, b: r2:wan}
  - {id: l2, a: r1:lan, b: h:eth0}
`;

test('a device source takes the address of its route’s egress (as the simulation’s sender), not its loopback; a device destination its first interface, loopbacks last', () => {
  const m = model(PAIR);
  const c = C.checkCommunication(m, { from: 'r1', to: 'r2' });
  // by RFC 6724 / Linux source selection: the egress towards 10.0.0.2 is r1:wan (connected), so 10.0.0.1
  assert.equal(c.from.address, '10.0.0.1', c.from.text);
  assert.equal(c.from.iface, 'wan');
  // r2: wan (10.0.0.2) before its loopback, as Send test and the applications resolve a device
  assert.equal(c.to.address, '10.0.0.2', c.to.text);
  assert.equal(c.verdict, 'satisfied', c.headline);
  // the same send in the simulation: sent from the same address to the same address, and the run is this check's
  const id = I.commIdentity(m, c);
  const h = I.handoffOf(m, id);
  const s = new S.Simulation(m);
  s.runTo(70000);
  const run = s.sendPlan({ delivery: 'unicast', ...h.prefill });
  s.runTo(s.now + 6000);
  const t = run.tests[0];
  assert.equal(t.ok, true, t.result);
  assert.equal(t.srcAddr, '10.0.0.1');
  assert.equal(t.dst.bytes.join('.'), '10.0.0.2');
  assert.ok(I.runMatches(id, run), 'the run carries the check’s identity');
});

test('a host name checked for IPv6 is carried with its family: the send asks for its AAAA record', () => {
  const m = model(PAIR);
  const id = { request: { from: 'h', to: 'www.example.test', family: 6 }, source: { device: 'h', iface: 'eth0', address: '10.1.0.10', binding: 'interface' }, destination: { name: 'www.example.test', binding: 'name' }, family: 6, expected: 'indeterminate' };
  const h = I.handoffOf(m, id);
  assert.equal(h.prefill.family, 6);
  assert.ok(!h.notTransferred.some((x) => /Family/.test(x)), 'the family is no longer dropped');
  const s = new S.Simulation(m);
  s.runTo(70000);
  const run = s.sendPlan({ delivery: 'unicast', ...h.prefill });
  assert.equal(run.tests[0].qtype, 'AAAA');
});

// a tunnel whose source interface is in a front-door VRF "inet": its outer packets are routed there, not in the default table
const FVRF = `netatlas: 1
title: front-door VRF
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 192.0.2.1/30, vrf: inet}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 198.51.100.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}, {prefix: 198.51.100.0/30, via: 192.0.2.2, vrf: inet}]
  - {id: t, type: router, interfaces: [{id: x, ip: 192.0.2.2/30}, {id: y, ip: 198.51.100.1/30}]}
  - id: b
    type: router
    interfaces: [{id: wan, ip: 198.51.100.2/30, vrf: inet}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}, {prefix: 192.0.2.0/30, via: 198.51.100.1, vrf: inet}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: ha:eth0, b: a:lan}
  - {id: l2, a: a:wan, b: t:x}
  - {id: l3, a: t:y, b: b:wan}
  - {id: l4, a: b:lan, b: hb:eth0}
relations:
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}
`;

test('a tunnel sourced in a front-door VRF: static and simulation both route its outer packets in that VRF', () => {
  const m = model(FVRF);
  const c = C.checkCommunication(m, { from: 'ha', to: 'hb' });
  assert.equal(c.verdict, 'satisfied', c.headline);
  const tun = c.trace.paths[0].hops.find((x) => x.underlay);
  assert.ok(tun && tun.underlay.hops.every((x) => x.device !== 'a' || x.vrf === 'inet'), 'the underlay starts in inet');
  const s = new S.Simulation(m);
  s.runTo(70000);
  const t = s.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  s.runTo(s.now + 6000);
  assert.equal(t.ok, true, t.result);
});

// ------------------------------------------------------------------ one order for "a device as an address" (endpoint-order.ts)

// h: an ordinary interface, a loopback and a container bridge, with ids that sort in every order before or after it
const ORDER = (eth, lo, br) => `netatlas: 1
title: endpoint order
devices:
  - id: h
    type: server
    interfaces: [{id: ${eth}, ip: 10.0.0.5/24}]
    logical_interfaces: [{id: ${lo}, type: loopback, ip: 10.255.0.5/32}]
    services:
      mqtt_broker: {}
      container_engine:
        engine: docker
        networks:
          - {name: bridge, driver: bridge, interface: ${br}, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true}
  - id: c
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.0.9/24}]
    services: {applications: [{id: m, name: M, profile: mqtt_client, broker: h, publish: [t/x], qos: "0"}, {id: q, name: Q, profile: udp_client, peer: h, port: 7}]}
links:
  - {id: l, a: "h:${eth}", b: "c:eth0"}
`;

test('a device as an address: the static check, the applications, Send test and an MQTT client’s broker take the same one — an ordinary interface, then a loopback, then a container bridge', () => {
  for (const [eth, lo, br] of [['eth0', 'lo0', 'docker0'], ['zz0', 'aa0', 'ab0'], ['m0', 'z0', 'a0'], ['b0', 'a0', 'c0']]) {
    const m = model(ORDER(eth, lo, br));
    assert.equal(m.index.interfaces.get('h:' + br).type, 'bridge');
    const s = new S.Simulation(m);
    s.runTo(3000);
    const what = `${eth}/${lo}/${br}`;
    // the static check, from the client application to its broker and to its peer
    assert.equal(C.checkCommunication(m, { from: 'c/m' }).to.address, '10.0.0.5', what + ': static, the broker');
    assert.equal(C.checkCommunication(m, { from: 'c/q' }).to.address, '10.0.0.5', what + ': static, the peer');
    assert.equal(C.checkCommunication(m, { from: 'c', to: 'h' }).to.address, '10.0.0.5', what + ': static, the device');
    // the simulation's consumers: an application's peer, Send test's target, an MQTT client's broker
    const fmt = (a) => (typeof a === 'string' ? a : a.bytes.join('.'));
    assert.equal(fmt(s.apps.peerNow('c', s.apps.app('c', 'q')).dst), '10.0.0.5', what + ': the application');
    assert.equal(fmt(s.transport.resolveTarget('c', { to: 'h' }, 'icmp').dst), '10.0.0.5', what + ': Send test');
    assert.equal(fmt(s.mqtt.brokerAddr('h', 4)), '10.0.0.5', what + ': the MQTT broker');
  }
});
