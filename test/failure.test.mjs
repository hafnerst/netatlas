// Failure impact (analysis/failure.ts): what a failed device, port, cable or
// relation takes down with it, propagated through the model; LAGs with
// min_links, redundancy groups failing over, relations over relations,
// networks losing members, static routes failing and floating routes taking
// over, the path tracer under the failure, device pairs that lose
// reachability, and the single points of failure. Order never matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const F = load('analysis/failure.js');
const T = load('analysis/trace.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const not = (m) => [...m.entries()].filter(([, s]) => s !== 'up').sort((a, b) => (a[0] < b[0] ? -1 : 1));

// two routers joined by a LAG of two cables (min_links 2 on one side) and a third cable; a VRRP pair over a LAN; GRE over IPsec over the third cable; OSPF over GRE
const net = `netatlas: 1
devices:
  - id: r1
    type: router
    router_id: 10.255.0.1
    protocols: {ospf: {}, vrrp: {}}
    interfaces: [{id: p1}, {id: p2}, {id: p3, ip: 192.0.2.1/30}, {id: lan, ip: 10.0.0.2/24, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 200}}}]
    logical_interfaces:
      - {id: po1, type: virtual, members: [p1, p2], ip: 10.12.0.1/30}
      - {id: t0, type: tunnel, ip: 172.16.0.1/30, source: p3, destination: 192.0.2.2}
  - id: r2
    type: router
    router_id: 10.255.0.2
    protocols: {ospf: {}, vrrp: {}}
    interfaces: [{id: p1}, {id: p2}, {id: p3, ip: 192.0.2.2/30}, {id: lan, ip: 10.0.0.3/24, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 100}}}]
    logical_interfaces:
      - {id: po1, type: virtual, members: [p1, p2], min_links: 2, ip: 10.12.0.2/30}
      - {id: t0, type: tunnel, ip: 172.16.0.2/30, source: p3, destination: 192.0.2.1}
  - id: sw
    type: switch
    interfaces: [{id: a, vlans: 1}, {id: b, vlans: 1}, {id: c, vlans: 1}]
  - id: h
    type: endpoint
    interfaces: [{id: e0, ip: 10.0.0.50/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]
links:
  - {id: c1, a: "r1:p1", b: "r2:p1"}
  - {id: c2, a: "r1:p2", b: "r2:p2"}
  - {id: c3, a: "r1:p3", b: "r2:p3"}
  - {id: s1, a: "sw:a", b: "r1:lan"}
  - {id: s2, a: "sw:b", b: "r2:lan"}
  - {id: s3, a: "sw:c", b: "h:e0"}
networks:
  - {id: lan, cidr: 10.0.0.0/24}
  - {id: core, cidr: 10.12.0.0/30}
relations:
  - {id: lag, protocol: lacp, endpoints: ["r1:po1", "r2:po1"], over: [c1, c2]}
  - {id: ipsec, protocol: ipsec, endpoints: ["r1:p3", "r2:p3"], over: c3}
  - {id: gre, protocol: gre, endpoints: ["r1:t0", "r2:t0"], over: ipsec}
  - {id: ospf, protocol: ospf, endpoints: ["r1:t0", "r2:t0"], over: gre}
  - {id: vrrp, protocol: vrrp, endpoints: ["r1:lan", "r2:lan"], over: lan}
  - {id: syslog, protocol: syslog, endpoints: [h, r1]}
`;

test('a failed device fails its interfaces and cables; its neighbours are degraded; relations at it go down, a redundancy group fails over', () => {
  const m = model(net);
  const r = F.simulate(m, ['device:r1']);
  assert.deepEqual(r.failed, ['device:r1']);
  assert.equal(r.devices.get('r1'), 'down');
  assert.equal(r.devices.get('r2'), 'degraded');
  assert.equal(r.devices.get('h'), 'up');
  for (const l of ['c1', 'c2', 'c3', 's1']) assert.equal(r.links.get(l), 'down', l);
  assert.equal(r.links.get('s2'), 'up');
  assert.equal(r.ifaces.get('r1:lan'), 'down');
  assert.equal(r.ifaces.get('r2:p1'), 'down');
  assert.equal(r.relations.get('syslog'), 'down');
  assert.equal(r.relations.get('vrrp'), 'degraded');
  assert.match(r.why.get('relation:vrrp'), /fails over: r1 is down, r2 left/);
  assert.equal(r.networks.get('lan'), 'degraded');
  assert.equal(r.networks.get('core'), 'down');
  // the routing context sees it
  assert.equal(r.ctx.up('r1', 'lan'), false);
  assert.equal(r.ctx.up('r2', 'lan'), true);
  assert.equal(r.ctx.relUp('syslog'), false);
  assert.equal(r.ctx.linkUp('s2'), true);
});

test('a failed port fails its cable; a LAG survives partial member failure, honouring min_links', () => {
  const m = model(net);
  const r = F.simulate(m, ['iface:r1:p1']);
  assert.equal(r.links.get('c1'), 'down');
  assert.equal(r.ifaces.get('r2:p1'), 'down', 'the far port loses its cable');
  // r1's aggregate needs one member: degraded; r2's needs two (min_links): down
  assert.equal(r.ifaces.get('r1:po1'), 'degraded');
  assert.equal(r.ifaces.get('r2:po1'), 'down');
  assert.match(r.why.get('iface:r2:po1'), /1 of 2 member ports up, 2 needed \(min_links\)/);
  // the LAG relation: min_links 2 of its endpoints → down
  assert.equal(r.relations.get('lag'), 'down');
  // without min_links the same failure only degrades it
  const m2 = model(net.replace('members: [p1, p2], min_links: 2,', 'members: [p1, p2],'));
  const r2 = F.simulate(m2, ['link:c1']);
  assert.equal(r2.ifaces.get('r2:po1'), 'degraded');
  assert.equal(r2.relations.get('lag'), 'degraded');
  assert.match(r2.why.get('relation:lag'), /1 of 2 cables up \(c1 down\)/);
  assert.equal(F.failureRefs(r2).get('relation:lag'), 'degraded');
});

test('a failed cable or relation fails everything that runs over it, recursively; a tunnel interface follows its tunnel', () => {
  const m = model(net);
  const r = F.simulate(m, ['link:c3']);
  assert.deepEqual(
    not(r.relations).map(([k, s]) => k + '=' + s),
    ['gre=down', 'ipsec=down', 'ospf=down'],
  );
  assert.match(r.why.get('relation:ospf'), /runs over gre/);
  assert.equal(r.ifaces.get('r1:t0'), 'down');
  // failing the relation in the middle: what runs over it goes, what it runs over stays
  const g = F.simulate(m, ['relation:ipsec']);
  assert.deepEqual(not(g.relations).map(([k]) => k), ['gre', 'ipsec', 'ospf']);
  assert.equal(g.links.get('c3'), 'up');
  // the summary sorts relations and tunnels apart, down first
  const s = F.summarize(m, r);
  assert.deepEqual(s.tunnels.map((a) => a.ref), ['relation:gre', 'relation:ipsec']);
  assert.deepEqual(s.relations.map((a) => a.ref), ['relation:ospf']);
  assert.deepEqual(s.links.map((a) => a.ref), ['link:c3']);
});

test('a relation of more than two devices is degraded while two are left; a network with no member left is down', () => {
  const m = model(`netatlas: 1
devices:
  - {id: a, type: router, interfaces: [{id: e, ip: 10.0.0.1/24}]}
  - {id: b, type: router, interfaces: [{id: e, ip: 10.0.0.2/24}]}
  - {id: c, type: router, interfaces: [{id: e, ip: 10.0.0.3/24}]}
networks:
  - {id: n, cidr: 10.0.0.0/24}
relations:
  - {id: area0, protocol: ospf, endpoints: [a, b, c], over: n}
`);
  const one = F.simulate(m, ['device:a']);
  assert.equal(one.relations.get('area0'), 'degraded');
  assert.equal(one.networks.get('n'), 'degraded');
  const two = F.simulate(m, ['device:b', 'device:a']);
  assert.equal(two.relations.get('area0'), 'down');
  assert.equal(two.networks.get('n'), 'degraded');
  assert.equal(F.simulate(m, ['device:a', 'device:b', 'device:c']).networks.get('n'), 'down');
});

test('static routes whose next hop becomes unreachable fail; the floating route takes over; the path tracer follows it', () => {
  const m = model(example('branch-routing.yaml'));
  const r = F.simulate(m, ['link:br-isp-a']);
  assert.equal(r.routes.get('route:br-rtr:0'), 'down');
  assert.equal(r.routes.get('route:br-rtr:1'), 'takeover');
  assert.equal(r.routes.get('route:br-rtr:2'), 'down');
  assert.equal(r.routes.get('route:br-rtr:3'), 'up', 'the other equal-cost route to HQ stays');
  assert.match(r.why.get('route:br-rtr:1'), /takes over 0\.0\.0\.0\/0/);
  // before: two equal-cost paths to HQ; under the failure, only the one over ISP B
  assert.equal(T.tracePath(m, { from: 'pc1', to: 'hq-rtr' }).paths.length, 2);
  const t = T.tracePath(m, { from: 'pc1', to: 'hq-rtr' }, r.ctx);
  assert.deepEqual(t.paths.map((p) => p.hops.map((h) => h.device)), [['pc1', 'br-rtr', 'isp-b-pe', 'hq-rtr']]);
  // the internet: the floating default via ISP B
  const inet = T.tracePath(m, { from: 'pc1', to: '8.8.8.8' }, r.ctx).paths[0];
  assert.equal(inet.hops[1].via.route, 'route:br-rtr:1');
  assert.match(F.failureLine(m, r), /^failed cable br-isp-a · \d+ down, \d+ degraded$/);
});

test('a VRRP gateway fails over in the path tracer: the backup forwards', () => {
  const m = model(net);
  const before = T.tracePath(m, { from: 'h', to: 'r2:p3' });
  assert.equal(before.paths[0].hops[1].device, 'r1');
  const r = F.simulate(m, ['iface:r1:lan']);
  const after = T.tracePath(m, { from: 'h', to: 'r2:p3' }, r.ctx);
  assert.deepEqual(after.paths[0].hops.map((h) => h.device), ['h', 'r2']);
  assert.match(after.paths[0].hops[0].notes.join(' '), /r1 is down, r2 has taken over/);
});

test('device pairs that lose reachability, all of it or a part (equal-cost paths), and the pairs not counted', () => {
  const m = model(example('branch-routing.yaml'));
  const r = F.simulate(m, ['link:br-isp-a']);
  const lost = F.lostReachability(m, r);
  assert.equal(lost.checked, 7);
  const key = (p) => `${p.from}>${p.to}${p.partial ? ' (part)' : ''}`;
  const keys = lost.pairs.map(key);
  assert.ok(keys.includes('hq-rtr>pc1 (part)'), keys.join(' '));
  assert.ok(keys.includes('isp-a-pe>pc1'));
  assert.ok(!keys.some((k) => /^pc1>hq-rtr/.test(k)), 'the branch still reaches HQ over ISP B');
  // a failed device's own pairs are not counted
  const d = F.lostReachability(m, F.simulate(m, ['device:pc1']));
  assert.ok(!d.pairs.some((p) => p.from === 'pc1' || p.to === 'pc1'));
  // the same pairs for the same failure, computed again
  assert.deepEqual(F.lostReachability(m, F.simulate(m, ['link:br-isp-a'])).pairs.map(key), keys);
});

test('single points of failure: cables and devices that partition, a LAG listed once, relations without a redundant underlay', () => {
  const m = model(net);
  const s = F.singlePointsOfFailure(m);
  const by = new Map(s.map((x) => [x.ref, x]));
  // the switch is the only way to the host
  assert.deepEqual(by.get('device:sw').isolated, [['h']]);
  assert.deepEqual(by.get('link:s3').isolated, [['h']]);
  // c3 carries IPsec, GRE and OSPF with no other way
  assert.deepEqual(by.get('link:c3').relations, ['gre', 'ipsec', 'ospf']);
  assert.deepEqual(by.get('link:c3').isolated, []);
  // the LAG: once (from r1), failing both member cables; one member alone takes the LAG down only because of min_links 2
  assert.ok(by.has('iface:r1:po1') && !by.has('iface:r2:po1'));
  assert.deepEqual(by.get('iface:r1:po1').fail, ['link:c1', 'link:c2']);
  assert.deepEqual(by.get('link:c1').relations, ['lag']);
  // the cables to the redundant routers are not single points (VRRP fails over)
  assert.ok(!by.has('link:s1') || !by.get('link:s1').relations.includes('vrrp'));
  // most impact first
  const w = (x) => x.isolated.reduce((n, g) => n + g.length, 0) + x.relations.length;
  for (let i = 1; i < s.length; i++) assert.ok(w(s[i - 1]) >= w(s[i]));
  // a ring has none
  const ring = model(`netatlas: 1
devices:
  - {id: a, type: switch, interfaces: [{id: x, vlans: 1}, {id: y, vlans: 1}]}
  - {id: b, type: switch, interfaces: [{id: x, vlans: 1}, {id: y, vlans: 1}]}
  - {id: c, type: switch, interfaces: [{id: x, vlans: 1}, {id: y, vlans: 1}]}
links:
  - {id: ab, a: "a:y", b: "b:x"}
  - {id: bc, a: "b:y", b: "c:x"}
  - {id: ca, a: "c:y", b: "a:x"}
`);
  assert.deepEqual(F.singlePointsOfFailure(ring).filter((x) => x.kind === 'cable'), []);
  // the examples: the internet cloud and the firewall of the enterprise WAN cut it apart
  const wan = new Map(F.singlePointsOfFailure(model(example('enterprise-wan.yaml'))).map((x) => [x.ref, x]));
  assert.deepEqual(wan.get('device:hq-fw').isolated, [['hq-acc1', 'hq-core1', 'hq-core2', 'hq-log']]);
  assert.ok(wan.get('link:l-hq-isp1').relations.includes('gre-muc'));
  assert.ok(!wan.has('link:l-peer2') || !wan.get('link:l-peer2').relations.includes('lag-peer'), 'one member of the peer LAG is not a single point');
});

test('only cables, ports, devices and relations can fail; the result is the same in any order', () => {
  const m = model(net);
  assert.ok(F.failableRef(m, 'device:r1') && F.failableRef(m, 'link:c1') && F.failableRef(m, 'iface:r1:p1') && F.failableRef(m, 'relation:gre'));
  assert.ok(!F.failableRef(m, 'network:lan') && !F.failableRef(m, 'device:nope') && !F.failableRef(m, 'route:r1:0'));
  const a = F.simulate(m, ['link:c3', 'iface:r1:p1', 'network:lan']);
  const b = F.simulate(m, ['iface:r1:p1', 'link:c3']);
  assert.deepEqual(a.failed, ['iface:r1:p1', 'link:c3']);
  const dump = (r) => JSON.stringify([not(r.devices), not(r.ifaces), not(r.links), not(r.relations), not(r.networks), not(r.routes)]);
  assert.equal(dump(a), dump(b));
  // a file in another order: the same failure, the same result
  const rev = (body) => body.replace(/\n+$/, '').split('\n').reverse().join('\n') + '\n';
  const reordered = net.replace(/relations:\n([\s\S]*)$/, (all, body) => 'relations:\n' + rev(body)).replace(/links:\n((?:  - .*\n)+)/, (all, body) => 'links:\n' + rev(body));
  assert.notEqual(reordered, net);
  assert.equal(dump(F.simulate(model(reordered), ['link:c3', 'iface:r1:p1'])), dump(a));
  assert.deepEqual(F.singlePointsOfFailure(model(reordered)), F.singlePointsOfFailure(m));
});
