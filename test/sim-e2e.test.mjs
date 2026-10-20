// End to end from a freshly booted network (every table empty, every
// adjacency down): what a delivery needs is built by the layers below it,
// in their order, and a delivery happens only once every one of them is in
// place. Checked by the state at each moment and by the deliveries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/** pc — r1 — r2 — srv, OSPF point-to-point between the routers, srv listening on tcp/80; no static route anywhere but the hosts' gateways. */
const V4 = `netatlas: 1
title: cold v4
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: r1, type: router, router_id: 10.255.0.1, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.12.1/30}]}
  - {id: r2, type: router, router_id: 10.255.0.2, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.2.1/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: tcp/80}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:g0"}
  - {id: l2, a: "r1:g1", b: "r2:g0"}
  - {id: l3, a: "r2:g1", b: "srv:eth0"}
relations:
  - {id: o12, protocol: ospf, endpoints: ["r1:g1", "r2:g0"], attrs: {network-type: point-to-point}}
`;

test('cold start, IPv4: carrier, then the adjacency, then the learned route, then the TCP exchange — and not before', () => {
  const s = sim(V4);
  // at once: nothing is up, nothing is known
  assert.equal(s.engine.portUp('r1', 'g1'), false, 'the cables come up after their link-up delay');
  assert.notEqual(s.routeLookup('r1', '10.0.2.10').kind, 'forward');
  // a connection tried before the routers learned the way: refused by r1 (no route), never delivered
  s.runTo(1500);
  const early = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  s.runTo(s.now + 6000);
  assert.equal(early.result, 'no route to 10.0.2.10 (network unreachable)', 'r1 has learned nothing yet');
  // then each layer in its order
  const firstAt = (re) => (s.events().find((e) => re.test(e.detail)) || {}).t;
  s.runTo(60000);
  const carrier = firstAt(/r1:g1 has carrier/);
  const full = (s.events().find((e) => e.device === 'r1' && e.kind === 'state' && e.what === 'Full') || {}).t;
  const learned = (s.events().find((e) => e.device === 'r1' && e.what === 'learned' && /r2/.test(e.detail)) || {}).t;
  assert.ok(carrier !== undefined && full !== undefined && learned !== undefined, `${carrier} ${full} ${learned}`);
  assert.ok(carrier < full && full <= learned, `carrier ${carrier}, Full ${full}, learned ${learned}`);
  assert.equal(s.routeLookup('r1', '10.0.2.10').kind, 'forward');
  // now the exchange: handshake, request, answer, close
  const t = s.sendTest({ from: 'pc', to: 'srv', kind: 'tcp', port: 80 });
  const t0 = s.now;
  s.runTo(t0 + 3000);
  assert.equal(t.result, 'connected and answered (1460 bytes)');
  // its hops were the routers' own decisions then (pc's ARP for its gateway first, at the start)
  const routed = s.events().filter((e) => e.t >= t0 && e.kind === 'route' && e.what === 'routed' && /10\.0\.1\.10 → 10\.0\.2\.10/.test(e.detail)).map((e) => e.device);
  assert.deepEqual(Array.from(new Set(routed)), ['r1', 'r2']);
  // the connection is gone from both tables afterwards (TIME_WAIT over)
  s.runTo(s.now + 130000);
  const left = (dev) => s.connTable(dev).filter((c) => c.proto === 'tcp' && c.state !== 'LISTEN');
  assert.deepEqual([left('pc'), left('srv')], [[], []], 'no connection left');
  assert.ok(s.connTable('srv').some((c) => c.state === 'LISTEN' && /:80$/.test(c.local)), 'srv still listens');
});

/** a — r — b, static IPv6 only (no RA, no SLAAC), the hosts' default route via r's written link-local address. */
const V6 = `netatlas: 1
title: cold v6
devices:
  - {id: a, type: endpoint, interfaces: [{id: eth0, ip: [2001:db8:1::10/64]}], routes: [{prefix: ::/0, via: fe80::1, interface: eth0}]}
  - {id: r, type: router, interfaces: [{id: g0, ip: [2001:db8:1::1/64, fe80::1/64]}, {id: g1, ip: [2001:db8:2::1/64, fe80::1/64]}]}
  - {id: b, type: server, interfaces: [{id: eth0, ip: [2001:db8:2::10/64]}], routes: [{prefix: ::/0, via: fe80::1, interface: eth0}], simulation: {listening: tcp/443}}
links:
  - {id: l1, a: "a:eth0", b: "r:g0"}
  - {id: l2, a: "r:g1", b: "b:eth0"}
`;

test('cold start, IPv6: link-local addresses through DAD, neighbour discovery of the link-local next hop, then the echo and the TCP exchange', () => {
  const s = sim(V6);
  s.runTo(2100);
  // r's link-local addresses are still tentative: a's ping waits on neighbour discovery and is not answered from a tentative address
  const lls = () => s.snapshot().addresses.filter((x) => x.device === 'r' && x.method === 'link-local').map((x) => x.state);
  assert.deepEqual(lls(), ['tentative', 'tentative']);
  s.runTo(8000);
  assert.deepEqual(lls(), ['preferred', 'preferred']);
  const ping = s.sendTest({ from: 'a', to: '2001:db8:2::10', kind: 'icmp' });
  const tcp = s.sendTest({ from: 'a', to: '2001:db8:2::10', kind: 'tcp', port: 443 });
  const t0 = s.now;
  s.runTo(t0 + 4000);
  assert.equal(ping.ok, true, ping.result);
  assert.equal(tcp.result, 'connected and answered (1460 bytes)');
  // a resolved fe80::1 on eth0 by NDP (a Neighbor Solicitation from a, an Advertisement from r) before its first routed packet
  const ns = s.events().find((e) => e.device === 'a' && e.what === 'Neighbor Solicitation' && /fe80::1\b/.test(e.detail) && e.t >= t0);
  const na = s.events().find((e) => e.device === 'r' && e.what === 'Neighbor Advertisement' && e.t >= t0);
  const routed = s.events().find((e) => e.device === 'r' && e.kind === 'route' && e.what === 'routed' && e.t >= t0);
  assert.ok(ns && na && routed && ns.t <= na.t && na.t <= routed.t, `${ns && ns.t} ${na && na.t} ${routed && routed.t}`);
});
