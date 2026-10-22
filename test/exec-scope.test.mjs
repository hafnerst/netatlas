// Execution scopes (analysis/exec-scope.ts) close over their
// dependencies to a fixed point: a device added for one reason is examined
// for its own (a resolver's resolver, a guest's host, a router's domain);
// each addition says why. A relation with more than two endpoints keeps
// the endpoints inside (and says what it runs without, as a caveat); a
// service runs only with its server; a two-endpoint relation with an end
// outside is cut. Checked by the scope and by the scoped model it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const XS = load('analysis/exec-scope.js');

/** pc resolves with dns1, dns1 with dns2, dns2 with dns3 — each on its own subnet behind r1 / r2. */
const CHAIN = `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, dns_servers: [10.1.0.53], interfaces: [{id: eth0, ip: 10.0.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: dns1, type: server, dns_servers: [10.2.0.53], services: {dns: {forwarders: [10.2.0.53]}}, interfaces: [{id: eth0, ip: 10.1.0.53/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: dns2, type: server, dns_servers: [10.3.0.53], services: {dns: {forwarders: [10.3.0.53]}}, interfaces: [{id: eth0, ip: 10.2.0.53/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
  - {id: dns3, type: server, services: {dns: {forwarders: [9.9.9.9]}}, interfaces: [{id: eth0, ip: 10.3.0.53/24}], routes: [{prefix: 0.0.0.0/0, via: 10.3.0.1}]}
  - id: r1
    type: router
    interfaces: [{id: a, ip: 10.0.0.1/24}, {id: b, ip: 10.1.0.1/24}, {id: c, ip: 10.12.0.1/30}]
    routes: [{prefix: 10.2.0.0/16, via: 10.12.0.2}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.12.0.2/30}, {id: b, ip: 10.2.0.1/24}, {id: c, ip: 10.3.0.1/24}]
    routes: [{prefix: 10.0.0.0/15, via: 10.12.0.1}]
  - {id: other, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.99/24}]}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l2, a: "dns1:eth0", b: "r1:b"}
  - {id: l3, a: "r1:c", b: "r2:a"}
  - {id: l4, a: "dns2:eth0", b: "r2:b"}
  - {id: l5, a: "dns3:eth0", b: "r2:c"}
`;

test('a dependency chain is followed to its end: pc → dns1 → dns2 → dns3, with the routers on each way, each saying why', () => {
  const m = model(CHAIN);
  const s = XS.dependencyScope(m, 'pc');
  assert.deepEqual(Array.from(s.devices).sort(), ['dns1', 'dns2', 'dns3', 'pc', 'r1', 'r2']);
  const why = new Map(s.included.map((x) => [x.device, x.why]));
  assert.match(why.get('dns2'), /dns1’s DNS server/);
  assert.match(why.get('dns3'), /dns2’s DNS server/);
  assert.ok(!s.devices.has('other'));
});

test('a union of scopes closes over again: what one added is examined with the others', () => {
  const m = model(CHAIN);
  const u = XS.unionScope(m, 'two', [XS.dependencyScope(m, 'pc'), XS.groupScope(m, 'none')]);
  assert.ok(u.devices.has('dns3'));
  assert.equal(new Set(u.included.map((x) => x.device)).size, u.included.length, 'each device once, with its reason');
});

/** r1, r2, r3 on one OSPF LAN (a switch); c1, c2 clients of srv (one service relation); group g has r1, r2, c1 and srv. */
const LAN = `netatlas: 1
title: lan
groups:
  - {id: g}
devices:
  - {id: r1, type: router, group: g, router_id: 10.255.0.1, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 10.0.0.1/24}]}
  - {id: r2, type: router, group: g, router_id: 10.255.0.2, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 10.0.0.2/24}]}
  - {id: r3, type: router, router_id: 10.255.0.3, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 10.0.0.3/24}]}
  - {id: sw, type: switch, group: g, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}, {id: p6, vlans: 1}]}
  - {id: c1, type: endpoint, group: g, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: c2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.12/24}]}
  - {id: srv, type: server, group: g, interfaces: [{id: eth0, ip: 10.0.0.80/24}]}
links:
  - {id: a, a: "r1:g0", b: "sw:p1"}
  - {id: b, a: "r2:g0", b: "sw:p2"}
  - {id: c, a: "r3:g0", b: "sw:p3"}
  - {id: d, a: "c1:eth0", b: "sw:p4"}
  - {id: e, a: "c2:eth0", b: "sw:p5"}
  - {id: f, a: "srv:eth0", b: "sw:p6"}
relations:
  - {id: lan, protocol: ospf, endpoints: ["r1:g0", "r2:g0", "r3:g0"]}
  - {id: web, protocol: https, endpoints: [c1, c2, srv]}
`;

test('a relation with three endpoints keeps those inside (a scoped relation), says what it runs without; a service needs its server', () => {
  const m = model(LAN);
  // (the OSPF domain of r1 and r2 includes r3: closing over adds it — so take a VLAN-free group without routing first)
  const g = XS.groupScope(m, 'g');
  assert.ok(g.devices.has('r3'), 'r1’s OSPF domain brings r3 in (its routes come from it)');
  // an explicit boundary without r3 (nothing closed over): the LAN relation runs between r1 and r2, and the scope says so
  const scope = XS.explicitScope(m, 'test', new Set(['r1', 'r2', 'sw', 'c1', 'srv']));
  assert.deepEqual(scope.partialRelations, [{ relation: 'lan', without: ['r3'] }, { relation: 'web', without: ['c2'] }]);
  assert.deepEqual(scope.cutRelations, []);
  assert.ok(scope.caveats.some((c) => /^lan runs without r3: an election, a flooding or a load share there can differ/.test(c)));
  const sub = XS.scopedModel(m, scope);
  const lan = sub.relations.find((r) => r.id === 'lan');
  assert.deepEqual(lan.endpoints.map((e) => e.device), ['r1', 'r2']);
  const web = sub.relations.find((r) => r.id === 'web');
  assert.deepEqual(web.endpoints.map((e) => e.device), ['c1', 'srv']);
  // without the server, the service relation is cut, not run with its clients only
  const noSrv = XS.explicitScope(m, 'test', new Set(['c1', 'c2', 'sw']));
  assert.ok(noSrv.cutRelations.indexOf('web') >= 0);
  assert.ok(!noSrv.partialRelations.some((p) => p.relation === 'web'));
});

test('a virtual guest’s scope includes its host, saying so', () => {
  const m = model(example('virtualization.yaml'));
  const s = XS.dependencyScope(m, 'web1');
  assert.ok(s.devices.has('hv1'));
  assert.ok(s.included.some((x) => x.device === 'hv1' && /web1 runs on it/.test(x.why)));
});
