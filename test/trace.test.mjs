// The path tracer (analysis/trace.ts) and the routes learned over routing
// adjacencies (analysis/routing.ts): longest-prefix match, administrative
// distance and floating routes, equal-cost multipath, black holes, missing
// routes and next hops, loops, OSPF costs and hop counts, tunnels with their
// encapsulation stack and underlay, VRRP virtual gateways, layer-2 ways
// through switches with VLANs, failures through the routing context, the
// return path, and the same result for a file in another order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const T = load('analysis/trace.js');
const R = load('analysis/routing.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const devs = (p) => p.hops.map((h) => h.device);
const trace = (m, from, to, extra = {}, ctx) => T.tracePath(m, { from, to, ...extra }, ctx);

// a chain h1 – r1 – r2 – r3 – h2 with static routes, a backup over r4, and a blackhole
const chain = `netatlas: 1
devices:
  - id: h1
    type: server
    interfaces: [{id: e0, ip: 10.1.0.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: r1
    type: router
    interfaces:
      - {id: lan, ip: 10.1.0.1/24}
      - {id: up, ip: 10.12.0.1/30}
      - {id: bk, ip: 10.14.0.1/30}
    routes:
      - {prefix: 10.2.0.0/16, via: 10.12.0.2}
      - {prefix: 10.2.0.0/24, via: 10.12.0.2, name: more specific}
      - {prefix: 10.2.0.0/24, via: 10.14.0.2, distance: 200, name: floating}
      - {prefix: 192.0.2.0/24, blackhole: true}
      - {prefix: 198.51.100.0/24, via: 10.99.0.1}
      - {prefix: 203.0.113.0/24, via: 10.12.0.2}
  - id: r2
    type: router
    interfaces:
      - {id: a, ip: 10.12.0.2/30}
      - {id: b, ip: 10.23.0.1/30}
    routes:
      - {prefix: 10.2.0.0/24, via: 10.23.0.2}
      - {prefix: 10.1.0.0/24, via: 10.12.0.1}
      - {prefix: 203.0.113.0/24, via: 10.12.0.1}
  - id: r4
    type: router
    interfaces:
      - {id: a, ip: 10.14.0.2/30}
      - {id: b, ip: 10.43.0.1/30}
    routes: [{prefix: 10.2.0.0/24, via: 10.43.0.2}]
  - id: r3
    type: router
    interfaces:
      - {id: a, ip: 10.23.0.2/30}
      - {id: c, ip: 10.43.0.2/30}
      - {id: lan, ip: 10.2.0.1/24}
    routes: [{prefix: 10.1.0.0/24, via: 10.23.0.1}]
  - id: h2
    type: server
    interfaces: [{id: e0, ip: 10.2.0.20/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
links:
  - {id: l1, a: "h1:e0", b: "r1:lan"}
  - {id: l2, a: "r1:up", b: "r2:a"}
  - {id: l3, a: "r2:b", b: "r3:a"}
  - {id: l4, a: "r1:bk", b: "r4:a"}
  - {id: l5, a: "r4:b", b: "r3:c"}
  - {id: l6, a: "r3:lan", b: "h2:e0"}
`;

test('a static path: longest prefix match, hop by hop, with interfaces, addresses, routes and cables', () => {
  const m = model(chain);
  const t = trace(m, 'h1', 'h2');
  assert.equal(t.error, undefined);
  assert.deepEqual(t.source, { device: 'h1', vrf: '', address: '10.1.0.10' });
  assert.deepEqual(t.dest, { address: '10.2.0.20', device: 'h2', iface: 'e0' });
  assert.equal(t.paths.length, 1);
  const p = t.paths[0];
  assert.deepEqual(devs(p), ['h1', 'r1', 'r2', 'r3', 'h2']);
  assert.deepEqual(p.end, { kind: 'reached', device: 'h2', iface: 'e0' });
  const r1 = p.hops[1];
  assert.equal(r1.ingress, 'lan');
  assert.equal(r1.inAddr, '10.1.0.1');
  assert.equal(r1.egress, 'up');
  assert.equal(r1.outAddr, '10.12.0.1');
  assert.equal(r1.gateway, '10.12.0.2');
  // the /24 wins over the /16 (and over the floating /24 with distance 200)
  assert.equal(r1.via.kind, 'static');
  assert.equal(r1.via.route, 'route:r1:1');
  assert.deepEqual(r1.links, ['l2']);
  // the last router delivers to its connected network
  assert.equal(p.hops[3].via.kind, 'connected');
  assert.equal(p.hops[4].via.kind, 'local');
  // the highlight refs
  const refs = T.traceRefs(t);
  for (const r of ['device:r2', 'link:l3', 'iface:r1:up', 'route:r1:1']) assert.ok(refs.main.has(r), r);
  assert.equal(refs.alt.size, 0);
  assert.equal(refs.stop, null);
  // the ends can be interfaces and addresses too
  assert.deepEqual(devs(trace(m, 'h1:e0', '10.2.0.20').paths[0]), ['h1', 'r1', 'r2', 'r3', 'h2']);
  assert.deepEqual(devs(trace(m, '10.1.0.10', 'r3:lan').paths[0]), ['h1', 'r1', 'r2', 'r3']);
});

test('a floating static route takes over when the better route’s next hop goes down (a routing context)', () => {
  const m = model(chain);
  const down = { up: (d, i) => !(d === 'r1' && i === 'up') };
  const t = trace(m, 'h1', 'h2', {}, down);
  assert.deepEqual(devs(t.paths[0]), ['h1', 'r1', 'r4', 'r3', 'h2']);
  assert.equal(t.paths[0].hops[1].via.route, 'route:r1:2');
  assert.match(t.paths[0].hops[1].via.text, /AD 200|200/);
});

test('where a trace stops, and why: black hole, no route, an unresolved next hop, a loop, a device that does not forward', () => {
  const m = model(chain);
  const bh = trace(m, 'h1', '192.0.2.7').paths[0];
  assert.deepEqual(bh.end.kind === 'stopped' && [bh.end.device, bh.end.reason], ['r1', 'blackhole']);
  const none = trace(m, 'r2', '172.16.0.1').paths[0];
  assert.deepEqual([none.end.device, none.end.reason], ['r2', 'no-route']);
  // 10.99.0.1 is in no network of r1: the route can't be used, and there is no other
  const un = trace(m, 'h1', '198.51.100.9').paths[0];
  assert.deepEqual([un.end.device, un.end.reason], ['r1', 'unresolved']);
  assert.match(un.end.detail, /10\.99\.0\.1/);
  // r1 sends 203.0.113.0/24 to r2, which sends it back
  const loop = trace(m, 'h1', '203.0.113.5').paths[0];
  assert.deepEqual([loop.end.device, loop.end.reason], ['r1', 'loop']);
  // a host on the way does not forward
  const hm = model(chain.replace('{prefix: 10.2.0.0/24, via: 10.23.0.2}', '{prefix: 10.2.0.0/24, via: 10.12.0.1}').replace('id: r1\n    type: router', 'id: r1\n    type: server'));
  const nf = trace(hm, 'h1', 'h2').paths[0];
  assert.deepEqual([nf.end.device, nf.end.reason], ['r1', 'not-forwarding']);
  // the device where it stops is marked
  assert.equal(T.traceRefs(trace(m, 'h1', '192.0.2.7')).stop, 'device:r1');
});

test('a destination outside the model: the trace leaves it at the last next hop; a network without the address: delivered', () => {
  const m = model(chain.replace('routes: [{prefix: 10.1.0.0/24, via: 10.23.0.1}]', 'routes: [{prefix: 10.1.0.0/24, via: 10.23.0.1}, {prefix: 0.0.0.0/0, via: 10.43.0.9}]').replace('{id: c, ip: 10.43.0.2/30}', '{id: c, ip: 10.43.0.2/28}'));
  const out = trace(m, 'h2', '8.8.8.8').paths[0];
  assert.deepEqual(out.end, { kind: 'exits', device: 'r3', gateway: '10.43.0.9' });
  const d = trace(m, 'h1', '10.2.0.99').paths[0];
  assert.equal(d.end.kind, 'delivered');
  assert.equal(d.end.device, 'r3');
});

test('bad requests say why: unknown ends, no address, the same device', () => {
  const m = model(chain);
  assert.match(trace(m, 'nope', 'h2').error, /^Source: “nope” is no device/);
  assert.match(trace(m, 'h1', '').error, /^Destination: Enter/);
  assert.match(trace(m, '10.9.9.9', 'h2').error, /not an address of a device/);
  assert.match(trace(m, 'h1', 'h1:e0').error, /same device/);
  assert.equal(T.parseTraceEnd(m, 'r1:up').kind, 'iface');
  assert.equal(T.parseTraceEnd(m, '2001:db8::1').kind, 'address');
});

// ECMP: two equal static routes, and OSPF with equal costs
const ecmp = `netatlas: 1
devices:
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.0.1.1/24}, {id: x, ip: 10.0.12.1/30}, {id: y, ip: 10.0.13.1/30}]
    routes:
      - {prefix: 10.0.4.0/24, via: 10.0.12.2}
      - {prefix: 10.0.4.0/24, via: 10.0.13.2}
  - id: b
    type: router
    interfaces: [{id: x, ip: 10.0.12.2/30}, {id: z, ip: 10.0.24.1/30}]
    routes: [{prefix: 10.0.4.0/24, via: 10.0.24.2}]
  - id: c
    type: router
    interfaces: [{id: y, ip: 10.0.13.2/30}, {id: z, ip: 10.0.34.1/30}]
    routes: [{prefix: 10.0.4.0/24, via: 10.0.34.2}]
  - id: d
    type: router
    interfaces: [{id: b, ip: 10.0.24.2/30}, {id: c, ip: 10.0.34.2/30}, {id: lan, ip: 10.0.4.1/24}]
links:
  - {id: ab, a: "a:x", b: "b:x"}
  - {id: ac, a: "a:y", b: "c:y"}
  - {id: bd, a: "b:z", b: "d:b"}
  - {id: cd, a: "c:z", b: "d:c"}
`;

test('equal-cost multipath: every branch is followed; the first is the main path, the others are alternatives', () => {
  const m = model(ecmp);
  const t = trace(m, 'a:lan', 'd:lan');
  assert.equal(t.paths.length, 2);
  assert.deepEqual(t.paths.map(devs), [['a', 'b', 'd'], ['a', 'c', 'd']]);
  assert.deepEqual([t.paths[0].hops[0].ecmp, t.paths[0].hops[0].branch, t.paths[1].hops[0].branch], [2, 0, 1]);
  const refs = T.traceRefs(t);
  assert.ok(refs.main.has('device:b') && refs.main.has('link:bd'));
  assert.ok(refs.alt.has('device:c') && refs.alt.has('link:cd') && !refs.alt.has('device:d'));
  const text = T.traceText(t);
  assert.match(text, /Main path \(1 of 2 equal-cost paths\)/);
  assert.match(text, /Equal-cost alternative 1/);
  assert.match(text, /equal-cost 1 of 2/);
  assert.match(text, /not a simulation of the protocols/);
});

const ospf = `netatlas: 1
devices:
  - {id: a, type: router, router_id: 10.255.0.1, protocols: {ospf: {}}, interfaces: [{id: lan, ip: 10.0.1.1/24}, {id: x, ip: 10.0.12.1/30}, {id: y, ip: 10.0.13.1/30}]}
  - {id: b, type: router, router_id: 10.255.0.2, protocols: {ospf: {}}, interfaces: [{id: x, ip: 10.0.12.2/30}, {id: z, ip: 10.0.24.1/30}]}
  - {id: c, type: router, router_id: 10.255.0.3, protocols: {ospf: {}}, interfaces: [{id: y, ip: 10.0.13.2/30}, {id: z, ip: 10.0.34.1/30}]}
  - {id: d, type: router, router_id: 10.255.0.4, protocols: {ospf: {}}, interfaces: [{id: b, ip: 10.0.24.2/30}, {id: c, ip: 10.0.34.2/30}, {id: lan, ip: 10.0.4.1/24}]}
  - {id: e, type: router, router_id: 10.255.0.5, protocols: {ospf: {}}, interfaces: [{id: x, ip: 10.9.9.1/30}]}
links:
  - {id: ab, a: "a:x", b: "b:x"}
  - {id: ac, a: "a:y", b: "c:y"}
  - {id: bd, a: "b:z", b: "d:b"}
  - {id: cd, a: "c:z", b: "d:c"}
relations:
  - {id: o-ab, protocol: ospf, endpoints: ["a:x", "b:x"]}
  - {id: o-ac, protocol: ospf, endpoints: ["a:y", "c:y"]}
  - {id: o-bd, protocol: ospf, endpoints: ["b:z", "d:b"]}
  - {id: o-cd, protocol: ospf, endpoints: ["c:z", "d:c"]}
`;

test('routes learned over OSPF adjacencies: hop count without costs (equal-cost), the lower cost where written', () => {
  const m = model(ospf);
  const t = trace(m, 'a:lan', 'd:lan');
  assert.deepEqual(t.paths.map(devs), [['a', 'b', 'd'], ['a', 'c', 'd']]);
  const via = t.paths[0].hops[0].via;
  assert.equal(via.kind, 'dynamic');
  assert.equal(via.relation, 'o-ab');
  assert.match(via.text, /OSPF route 10\.0\.4\.0\/24 over o-ab \(cost 2, distance 110\)/);
  assert.ok(T.traceRefs(t).main.has('relation:o-ab') && T.traceRefs(t).main.has('relation:o-bd'));
  // a cost on a–b (per device) makes the way over c cheaper
  const cm = model(ospf.replace('{id: o-ab, protocol: ospf, endpoints: ["a:x", "b:x"]}', '{id: o-ab, protocol: ospf, endpoints: ["a:x", "b:x"], attrs: {cost: {a: 50}}}'));
  assert.deepEqual(trace(cm, 'a:lan', 'd:lan').paths.map(devs), [['a', 'c', 'd']]);
  // a static route (distance 1) beats OSPF (110) for the same prefix
  const sm = model(ospf.replace('{id: lan, ip: 10.0.1.1/24}, {id: x, ip: 10.0.12.1/30}, {id: y, ip: 10.0.13.1/30}]}', '{id: lan, ip: 10.0.1.1/24}, {id: x, ip: 10.0.12.1/30}, {id: y, ip: 10.0.13.1/30}], routes: [{prefix: 10.0.4.0/24, via: 10.0.13.2}]}'));
  assert.deepEqual(trace(sm, 'a:lan', 'd:lan').paths.map(devs), [['a', 'c', 'd']]);
  assert.equal(trace(sm, 'a:lan', 'd:lan').paths[0].hops[0].via.kind, 'static');
  // a failed adjacency teaches nothing: the other branch remains
  const ctx = { relUp: (id) => id !== 'o-bd' };
  assert.deepEqual(trace(m, 'a:lan', 'd:lan', {}, ctx).paths.map(devs), [['a', 'c', 'd']]);
});

test('a routing adjacency between devices without a common network can’t form: the trace says so', () => {
  const m = model(ospf + '  - {id: o-ae, protocol: ospf, endpoints: [a, e]}\n');
  const adj = R.routingAdjacencies(m);
  assert.ok(adj.missing.some((x) => x.relation === 'o-ae' && x.from === 'a' && x.to === 'e' && /no network in common/.test(x.detail)));
  const t = trace(m, 'a:lan', '10.9.9.1');
  assert.deepEqual([t.paths[0].end.reason, t.paths[0].end.device], ['no-adjacency', 'a']);
  assert.match(t.paths[0].end.detail, /OSPF adjacency o-ae to e can't form/);
});

// a GRE tunnel over IPsec over an internet cloud, OSPF over the GRE tunnel; a switch with VLANs at the far end
const tunnel = `netatlas: 1
devices:
  - id: inet
    type: cloud
  - id: hq
    type: router
    router_id: 10.255.0.1
    protocols: {ospf: {}}
    interfaces: [{id: wan, ip: 198.51.100.2/30}, {id: lan, ip: 10.1.0.1/24}]
    logical_interfaces:
      - {id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.10}
  - id: br
    type: router
    router_id: 10.255.0.2
    protocols: {ospf: {}}
    interfaces: [{id: wan, ip: 192.0.2.10/29}, {id: trunk, vlans: [20, 30]}]
    logical_interfaces:
      - {id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.2}
      - {id: vl20, type: virtual, vlan: 20, ip: 10.2.20.1/24}
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: [20, 30]}, {id: p2, vlans: 20}, {id: p3, vlans: 1}]
  - id: srv
    type: server
    interfaces: [{id: e0, ip: 10.2.20.50/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.20.1}]
links:
  - {id: l-hq, a: "hq:wan", b: inet}
  - {id: l-br, a: "br:wan", b: inet}
  - {id: l-trunk, a: "br:trunk", b: "sw:p1"}
  - {id: l-srv, a: "sw:p2", b: "srv:e0"}
networks:
  - {id: n20, cidr: 10.2.20.0/24, vlan: 20}
relations:
  - {id: ipsec, protocol: ipsec, endpoints: ["hq:wan", "br:wan"], over: [l-hq, l-br]}
  - {id: gre, protocol: gre, endpoints: ["hq:tun0", "br:tun0"], over: ipsec}
  - {id: ospf, protocol: ospf, endpoints: ["hq:tun0", "br:tun0"], over: gre}
`;

test('tunnels: the encapsulation stack, the declared underlay down to the cables, and OSPF over the tunnel', () => {
  const m = model(tunnel);
  const t = trace(m, 'hq:lan', 'srv');
  assert.equal(t.error, undefined);
  const p = t.paths[0];
  assert.deepEqual(devs(p), ['hq', 'br', 'srv']);
  const h = p.hops[0];
  assert.equal(h.egress, 'tun0');
  assert.equal(h.via.relation, 'ospf');
  assert.deepEqual(h.encap.map((l) => l.label), ['GRE', 'IPsec']);
  assert.equal(T.encapText(h.encap), 'GRE over IPsec');
  assert.deepEqual(h.links, ['l-br', 'l-hq']);
  assert.deepEqual(h.l2, ['inet']);
  for (const r of ['ospf', 'gre', 'ipsec']) assert.ok(h.relations.includes(r), r);
  assert.ok(h.notes.some((n) => /over: chain of gre/.test(n)));
  // the last hop: through the switch, in VLAN 20 (not the port in VLAN 30)
  const last = p.hops[1];
  assert.equal(last.egress, 'vl20');
  assert.deepEqual(last.l2, ['sw']);
  assert.deepEqual(last.links, ['l-trunk', 'l-srv']);
  assert.deepEqual(last.networks, ['n20']);
  // the same tunnel with a routed underlay: the outer packet is traced, nested
  const routed = model(
    tunnel
      .replace('{id: wan, ip: 198.51.100.2/30}, {id: lan, ip: 10.1.0.1/24}]', '{id: wan, ip: 198.51.100.2/30}, {id: lan, ip: 10.1.0.1/24}]\n    routes: [{prefix: 192.0.2.8/29, via: 198.51.100.1}]')
      .replace('  - id: inet\n    type: cloud', '  - id: isp\n    type: router\n    interfaces: [{id: a, ip: 198.51.100.1/30}, {id: b, ip: 192.0.2.9/29}]')
      .replace('{id: l-hq, a: "hq:wan", b: inet}', '{id: l-hq, a: "hq:wan", b: "isp:a"}')
      .replace('{id: l-br, a: "br:wan", b: inet}', '{id: l-br, a: "br:wan", b: "isp:b"}'),
  );
  const u = trace(routed, 'hq:lan', 'srv').paths[0].hops[0];
  assert.ok(u.underlay);
  assert.deepEqual(devs(u.underlay), ['hq', 'isp', 'br']);
  assert.deepEqual(u.underlay.hops[0].encap.map((l) => l.label), ['GRE', 'IPsec']);
  assert.deepEqual(u.links, ['l-hq', 'l-br']);
  assert.match(T.traceText(trace(routed, 'hq:lan', 'srv')), /underlay \(GRE over IPsec\):\n   1\.1\. hq/);
  // a layer-2 way that does not exist: the VLAN is not on the trunk
  const noVlan = model(tunnel.replace('{id: trunk, vlans: [20, 30]}', '{id: trunk, vlans: 30}').replace('{id: p1, vlans: [20, 30]}', '{id: p1, vlans: 30}'));
  const s = trace(noVlan, 'hq:lan', 'srv').paths[0];
  assert.deepEqual([s.end.device, s.end.reason], ['br', 'no-adjacency']);
  assert.match(s.end.detail, /VLAN 20 of br:vl20 is on none of br’s ports/);
});

test('a VRRP virtual gateway: the active member forwards; when it is down, the backup takes over', () => {
  const m = model(`netatlas: 1
devices:
  - {id: h, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.50/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: r1, type: router, protocols: {vrrp: {}}, interfaces: [{id: lan, ip: 10.0.0.2/24, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 100}}}, {id: lo, ip: 10.255.0.9/32}]}
  - {id: r2, type: router, protocols: {vrrp: {}}, interfaces: [{id: lan, ip: 10.0.0.3/24, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 200}}}, {id: lo, ip: 10.255.0.9/32}]}
relations:
  - {id: vrrp, protocol: vrrp, endpoints: ["r1:lan", "r2:lan"]}
`);
  const t = trace(m, 'h', '10.255.0.9');
  assert.deepEqual(devs(t.paths[0]), ['h', 'r2']);
  assert.ok(t.paths[0].hops[0].relations.includes('vrrp'));
  assert.match(t.paths[0].hops[0].notes.join(' '), /virtual address of VRRP group 1; the active member is r2/);
  const failed = trace(m, 'h', '10.255.0.9', {}, { up: (d) => d !== 'r2' });
  assert.deepEqual(devs(failed.paths[0]), ['h', 'r1']);
  assert.match(failed.paths[0].hops[0].notes.join(' '), /r2 is down, r1 has taken over/);
});

test('VRFs: the source interface’s VRF, or the one asked for; nothing leaks between them', () => {
  const m = model(`netatlas: 1
devices:
  - id: r
    type: router
    interfaces: [{id: a, ip: 10.0.0.1/24, vrf: RED}, {id: b, ip: 10.1.0.1/24}]
    routes: [{prefix: 10.9.0.0/16, via: 10.0.0.2, vrf: RED}]
  - {id: s, type: router, interfaces: [{id: a, ip: 10.0.0.2/24, vrf: RED}, {id: n, ip: 10.9.0.1/24, vrf: RED}]}
links:
  - {id: l, a: "r:a", b: "s:a"}
`);
  assert.deepEqual(devs(trace(m, 'r:a', '10.9.0.1').paths[0]), ['r', 's']);
  assert.equal(trace(m, 'r:a', '10.9.0.1').source.vrf, 'RED');
  assert.equal(trace(m, 'r', '10.9.0.1').paths[0].end.reason, 'no-route');
  assert.deepEqual(devs(trace(m, 'r', '10.9.0.1', { vrf: 'RED' }).paths[0]), ['r', 's']);
  assert.equal(trace(m, 'r:a', '10.9.0.1', { vrf: '' }).paths[0].end.reason, 'no-route');
});

test('the return path: traced from the destination back to the source address; asymmetric routing is found', () => {
  const m = model(chain.replace("routes: [{prefix: 10.1.0.0/24, via: 10.23.0.1}]", "routes: [{prefix: 10.1.0.0/24, via: 10.43.0.1}]").replace("routes: [{prefix: 10.2.0.0/24, via: 10.43.0.2}]", "routes: [{prefix: 10.2.0.0/24, via: 10.43.0.2}, {prefix: 10.1.0.0/24, via: 10.14.0.1}]"));
  const t = trace(m, 'h1', 'h2');
  const rq = T.returnRequest(t);
  assert.deepEqual(rq, { from: 'h2:e0', to: '10.1.0.10' });
  const back = T.tracePath(m, rq);
  assert.deepEqual(devs(back.paths[0]), ['h2', 'r3', 'r4', 'r1', 'h1']);
  assert.equal(T.isAsymmetric(t, back), true);
  assert.match(T.traceText(t, back), /Return path: h2:e0 → 10\.1\.0\.10 \(asymmetric/);
  // the symmetric chain
  const s = model(chain);
  const t2 = trace(s, 'h1', 'h2');
  assert.equal(T.isAsymmetric(t2, T.tracePath(s, T.returnRequest(t2))), false);
  // no way back to trace from outside the model
  assert.equal(T.returnRequest(trace(s, 'h1', '192.0.2.7')), null);
});

test('the same trace for a file in another order (devices, interfaces, routes, links, relations reversed)', () => {
  const reorder = (text) => {
    // reverse every list of top-level entries ("  - " items) within each section
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (/^[a-z_]+:$/.test(lines[i])) {
        out.push(lines[i++]);
        const items = [];
        while (i < lines.length && /^ {2}/.test(lines[i])) {
          if (/^ {2}- /.test(lines[i]) || !items.length) items.push([]);
          items[items.length - 1].push(lines[i++]);
        }
        for (const it of items.reverse()) out.push(...it);
      } else out.push(lines[i++]);
    }
    return out.join('\n');
  };
  for (const [text, from, to] of [
    [ospf, 'a:lan', 'd:lan'],
    [ecmp, 'a:lan', 'd:lan'],
    [tunnel, 'hq:lan', 'srv'],
    [chain, 'h1', 'h2'],
  ]) {
    const a = trace(model(text), from, to);
    const b = trace(model(reorder(text)), from, to);
    assert.notEqual(reorder(text), text);
    assert.equal(T.traceText(b), T.traceText(a), from + ' → ' + to);
  }
});

test('the examples: the enterprise WAN over GRE over IPsec with ECMP and VRRP; the branch with equal-cost routes', () => {
  const wan = model(example('enterprise-wan.yaml'));
  const t = trace(wan, 'muc-rtr:lan0', 'hq-log');
  assert.deepEqual(t.paths.map(devs), [
    ['muc-rtr', 'hq-rtr1', 'hq-fw', 'hq-core1', 'hq-log'],
    ['muc-rtr', 'hq-rtr1', 'hq-fw', 'hq-core2', 'hq-log'],
  ]);
  assert.equal(T.encapText(t.paths[0].hops[0].encap), 'GRE over IPsec');
  const back = T.tracePath(wan, T.returnRequest(t));
  assert.deepEqual(devs(back.paths[0]), ['hq-log', 'hq-core1', 'hq-fw', 'hq-rtr1', 'muc-rtr']);
  assert.match(back.paths[0].hops[0].notes.join(' '), /virtual address of VRRP group 20; the active member is hq-core1/);
  const br = model(example('branch-routing.yaml'));
  const b = trace(br, 'pc1', 'hq-rtr');
  assert.deepEqual(b.paths.map(devs), [
    ['pc1', 'br-rtr', 'isp-a-pe', 'hq-rtr'],
    ['pc1', 'br-rtr', 'isp-b-pe', 'hq-rtr'],
  ]);
  assert.deepEqual(b.paths[0].hops[0].l2, ['br-sw']);
  // the internet: ISP A's edge is in the model and has no route there; guests (VRF GUEST) are blackholed at the branch router
  const inet = trace(br, 'pc1', '8.8.8.8').paths[0].end;
  assert.deepEqual([inet.kind, inet.device, inet.reason], ['stopped', 'isp-a-pe', 'no-route']);
  const g = trace(br, 'br-rtr:ge-0/0/2.30', '8.8.8.8').paths[0].end;
  assert.deepEqual([g.kind, g.reason], ['stopped', 'blackhole']);
});
