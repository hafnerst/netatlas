// The analysis module (src/analysis/): address arithmetic for IPv4 and IPv6,
// and route resolution: connected networks, static routes, longest-prefix
// match, administrative distance, equal-cost multipath, recursive next hops,
// blackholes, VRFs, and interfaces that are down. Pure and deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const ip = load('model/ip.js');
const M = load('analysis/ipmath.js');
const R = load('analysis/routing.js');

const P = (s) => ip.parsePrefix(s);
const A = (s) => ip.parseAddress(s);
const big = (s) => M.addrBig(A(s));

// ------------------------------------------------------------ address math

test('address math: integers, canonical text (RFC 5952 for IPv6), networks of prefixes', () => {
  assert.equal(M.addrBig(A('10.0.0.1')), BigInt(167772161));
  assert.equal(M.formatAddr(M.bigAddr(BigInt(167772161), 4)), '10.0.0.1');
  for (const [i, o] of [
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['::', '::'],
    ['::ffff:10.1.0.1', '::ffff:a01:1'],
    ['FE80::A', 'fe80::a'],
  ]) {
    assert.equal(M.formatAddr(A(i)), o, i);
  }
  assert.equal(M.prefixText(P('10.1.2.3/24')), '10.1.2.0/24');
  assert.equal(M.prefixText(P('2001:db8:1:2::77/48')), '2001:db8:1::/48');
  assert.equal(M.prefixText(P('0.0.0.0/0')), '0.0.0.0/0');
  assert.equal(M.prefixText(P('::/0')), '::/0');
});

test('address math: sizes, ranges, containment, overlap', () => {
  assert.equal(M.prefixSize(P('10.0.0.0/24')), BigInt(256));
  assert.equal(M.prefixSize(P('10.0.0.0/32')), BigInt(1));
  assert.equal(M.prefixSize(P('2001:db8::/64')), BigInt(2) ** BigInt(64));
  assert.equal(M.prefixSize(P('::/0')), BigInt(2) ** BigInt(128));
  const r = M.prefixRange(P('192.0.2.77/28'));
  assert.deepEqual([M.formatAddr(M.bigAddr(r.first, 4)), M.formatAddr(M.bigAddr(r.last, 4))], ['192.0.2.64', '192.0.2.79']);
  assert.ok(M.prefixCovers(P('10.0.0.0/8'), P('10.1.0.0/16')));
  assert.ok(!M.prefixCovers(P('10.1.0.0/16'), P('10.0.0.0/8')));
  assert.ok(!M.prefixCovers(P('10.0.0.0/8'), P('2001:db8::/32')), 'families never mix');
  assert.ok(M.prefixesOverlap(P('10.1.0.0/16'), P('10.0.0.0/8')) && !M.prefixesOverlap(P('10.1.0.0/16'), P('10.2.0.0/16')));
  assert.ok(M.inPrefix(P('2001:db8::/32'), A('2001:db8:ffff::1')) && !M.inPrefix(P('2001:db8::/32'), A('2001:db9::1')));
  assert.equal(M.count64(P('2001:db8::/48')), BigInt(65536));
  assert.equal(M.count64(P('2001:db8::/64')), BigInt(1));
  assert.equal(M.count64(P('2001:db8::/120')), BigInt(0));
  assert.equal(M.bigText(BigInt(65536)), '65 536');
});

test('address math: host addresses, free ranges and the next free address (IPv4 network/broadcast, /31, /32, IPv6)', () => {
  // a /24: network and broadcast are not host addresses
  assert.equal(M.hostCount(P('10.0.0.0/24')), BigInt(254));
  assert.equal(M.hostCount(P('10.0.0.0/31')), BigInt(2), 'RFC 3021');
  assert.equal(M.hostCount(P('10.0.0.1/32')), BigInt(1));
  assert.equal(M.hostCount(P('2001:db8::/126')), BigInt(4), 'no broadcast in IPv6');
  const used = ['10.0.0.1', '10.0.0.2', '10.0.0.5', '10.9.9.9'].map(big);
  const free = M.freeRanges(P('10.0.0.0/29'), used).map((x) => M.rangeText(x, 4));
  assert.deepEqual(free, ['10.0.0.3 – 10.0.0.4', '10.0.0.6']);
  assert.equal(M.formatAddr(M.nextFree(P('10.0.0.0/29'), used)), '10.0.0.3');
  assert.equal(M.nextFree(P('10.0.0.0/30'), ['10.0.0.1', '10.0.0.2'].map(big)), null, 'full');
  assert.equal(M.formatAddr(M.nextFree(P('10.0.0.0/31'), [])), '10.0.0.0', 'a /31 has no network address to skip');
  assert.equal(M.formatAddr(M.nextFree(P('2001:db8::/64'), ['2001:db8::', '2001:db8::1'].map(big))), '2001:db8::2');
  // order: family, then value; prefixes by network, then length
  const sorted = ['2001:db8::1', '10.0.0.10', '10.0.0.9'].map(A).sort(M.compareAddr).map(M.formatAddr);
  assert.deepEqual(sorted, ['10.0.0.9', '10.0.0.10', '2001:db8::1']);
  assert.ok(M.comparePrefix(P('10.0.0.0/8'), P('10.0.0.0/16')) < 0);
});

// ------------------------------------------------------------ routing

const net = `netatlas: 2
devices:
  - id: r1
    type: router
    interfaces:
      - {id: e0, ip: 10.0.12.1/30}
      - {id: e1, ip: 10.0.13.1/30}
      - {id: e2, ip: 192.168.1.1/24, vrf: red}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
      - {id: tun0, type: tunnel, source: e0, destination: r2}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.0.12.2}
      - {prefix: 0.0.0.0/0, via: 10.0.13.2, distance: 200}
      - {prefix: 10.50.0.0/16, via: 10.0.12.2, distance: 5}
      - {prefix: 10.50.0.0/16, via: 10.0.13.2, distance: 5}
      - {prefix: 10.50.7.0/24, via: 10.0.13.2, distance: 5, metric: 20}
      - {prefix: 10.50.7.0/24, via: 10.0.12.2, distance: 5, metric: 10}
      - {prefix: 10.60.0.0/16, via: 10.255.0.2}
      - {prefix: 10.255.0.2/32, via: 10.0.12.2}
      - {prefix: 10.70.0.0/16, interface: tun0}
      - {prefix: 198.18.0.0/15, blackhole: true}
      - {prefix: 0.0.0.0/0, via: 192.168.1.254, vrf: red}
  - id: r2
    type: router
    interfaces:
      - {id: e0, ip: 10.0.12.2/30}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.2/32}
  - id: r3
    type: router
    interfaces:
      - {id: e0, ip: 10.0.13.2/30}
links:
  - {id: l12, a: "r1:e0", b: "r2:e0"}
  - {id: l13, a: "r1:e1", b: "r3:e0"}
`;

const hops = (d) => d.hops.map((h) => h.iface + (h.gateway ? '>' + M.formatAddr(h.gateway) : ''));

test('routing tables: connected networks per VRF (distance 0) and static routes (a missing distance counts as 1)', () => {
  const m = model(net);
  const rib = R.ribOf(m, 'r1', '').map((e) => `${e.kind} ${M.prefixText(e.net)} ${e.distance}${e.iface ? ' ' + e.iface : ''}${e.via ? ' via ' + M.formatAddr(e.via) : ''}${e.blackhole ? ' blackhole' : ''}`);
  assert.deepEqual(rib, [
    'static 0.0.0.0/0 1 via 10.0.12.2',
    'static 0.0.0.0/0 200 via 10.0.13.2',
    'connected 10.0.12.0/30 0 e0',
    'connected 10.0.13.0/30 0 e1',
    'static 10.50.0.0/16 5 via 10.0.12.2',
    'static 10.50.0.0/16 5 via 10.0.13.2',
    'static 10.50.7.0/24 5 via 10.0.12.2',
    'static 10.50.7.0/24 5 via 10.0.13.2',
    'static 10.60.0.0/16 1 via 10.255.0.2',
    'static 10.70.0.0/16 1 tun0',
    'connected 10.255.0.1/32 0 lo0',
    'static 10.255.0.2/32 1 via 10.0.12.2',
    'static 198.18.0.0/15 1 blackhole',
  ]);
  assert.deepEqual(R.ribOf(m, 'r1', 'red').map((e) => `${e.kind} ${M.prefixText(e.net)}`), ['static 0.0.0.0/0', 'connected 192.168.1.0/24']);
  assert.deepEqual(R.deviceVrfs(m, 'r1'), ['', 'red']);
});

test('lookup: longest prefix first, then the lowest distance, then the lowest metric; equal ones are all used (ECMP)', () => {
  const m = model(net);
  const at = (dst, vrf = '') => R.lookup(m, 'r1', vrf, A(dst));
  // the default route with distance 1; the floating one (200) is not used while it does
  assert.deepEqual(hops(at('8.8.8.8')), ['e0>10.0.12.2']);
  assert.equal(at('8.8.8.8').entries[0].route.index, 0);
  // two routes with the same distance and metric: equal-cost multipath, in a fixed order
  assert.deepEqual(hops(at('10.50.1.1')), ['e0>10.0.12.2', 'e1>10.0.13.2']);
  // a longer prefix wins over a shorter one; within it the lower metric
  assert.deepEqual(hops(at('10.50.7.9')), ['e0>10.0.12.2']);
  // connected
  assert.deepEqual(hops(at('10.0.13.2')), ['e1']);
  assert.equal(at('10.0.12.1').kind, 'local');
  assert.equal(at('10.255.0.1').kind, 'local');
  // a blackhole drops; the VRF has its own table
  assert.equal(at('198.19.1.1').kind, 'blackhole');
  assert.deepEqual(hops(at('8.8.8.8', 'red')), ['e2>192.168.1.254']);
  assert.equal(at('10.0.12.2', 'red').kind, 'forward', 'red has a default route of its own');
  assert.equal(R.lookup(m, 'r2', '', A('8.8.8.8')).kind, 'none', 'no route at all');
});

test('next hops: directly connected, recursive through another route, an exit interface, the device itself', () => {
  const m = model(net);
  const r1 = m.index.devices.get('r1');
  const res = (i) => R.resolveRoute(m, r1.routes[i]);
  assert.deepEqual(res(0), { ok: true, hops: [{ iface: 'e0', gateway: A('10.0.12.2') }], recursive: false });
  // 10.255.0.2 is r2's loopback: it resolves through the /32 route, to the connected gateway
  const rec = res(6);
  assert.ok(rec.ok && rec.recursive);
  assert.deepEqual(rec.hops.map((h) => h.iface + '>' + M.formatAddr(h.gateway)), ['e0>10.0.12.2']);
  assert.deepEqual(hops(R.lookup(m, 'r1', '', A('10.60.1.1'))), ['e0>10.0.12.2']);
  // only an exit interface: out of it, to the destination itself
  assert.deepEqual(res(8), { ok: true, hops: [{ iface: 'tun0' }], recursive: false });
  // the next hop is an address of the device itself
  const self = model(net.replace('{prefix: 10.255.0.2/32, via: 10.0.12.2}', '{prefix: 10.255.0.2/32, via: 10.255.0.1}'));
  const sr = R.resolveRoute(self, self.index.devices.get('r1').routes[7]);
  assert.equal(sr.ok, false);
  assert.equal(sr.reason, 'self');
  // a next hop that resolves only through the route itself is not usable; a default route never resolves a next hop
  const loop = model(net.replace('{prefix: 10.255.0.2/32, via: 10.0.12.2}', '{prefix: 10.255.0.0/24, via: 10.255.0.2}'));
  const lr = R.resolveRoute(loop, loop.index.devices.get('r1').routes[7]);
  assert.deepEqual([lr.ok, lr.reason], [false, 'unresolved'], 'its only way to the next hop is itself');
  assert.equal(R.resolveRoute(loop, loop.index.devices.get('r1').routes[6]).ok, false, 'its next hop is reachable only by the default route');
  assert.deepEqual(hops(R.lookup(loop, 'r1', '', A('10.60.0.1'))), ['e0>10.0.12.2'], '… so traffic to it takes the default route');
});

test('failures: an interface that is down has no connected networks; routes through it are not used; the floating route takes over', () => {
  const m = model(net);
  const down = new Set(['r1:e0']);
  const ctx = { up: (d, i) => !down.has(d + ':' + i) };
  const d = R.lookup(m, 'r1', '', A('8.8.8.8'), ctx);
  assert.deepEqual(hops(d), ['e1>10.0.13.2']);
  assert.equal(d.entries[0].distance, 200, 'the floating default route');
  assert.ok(d.unusable.some((u) => u.entry.distance === 1), 'the primary route is reported as unusable, with why');
  // ECMP loses the member that went down
  assert.deepEqual(hops(R.lookup(m, 'r1', '', A('10.50.1.1'), ctx)), ['e1>10.0.13.2']);
  // the longer prefix whose next hop went away is skipped: the shorter one is used
  assert.deepEqual(hops(R.lookup(m, 'r1', '', A('10.50.7.1'), ctx)), ['e1>10.0.13.2']);
  // an exit interface that is down
  assert.equal(R.lookup(m, 'r1', '', A('10.70.0.1'), { up: (dv, i) => i !== 'tun0' }).kind, 'forward', 'falls back to the default route');
  // a destination on a network whose interface is down is not local any more
  assert.notEqual(R.lookup(m, 'r1', '', A('10.0.12.1'), ctx).kind, 'local');
});

test('routing is deterministic: the order of devices, interfaces and routes in the file changes nothing', () => {
  const m1 = model(net);
  // the same routes and interfaces in reverse order
  const lines = net.split('\n');
  const rs = lines.filter((l) => /^ {6}- \{prefix:/.test(l));
  const reversed = net.replace(rs.join('\n'), rs.slice().reverse().join('\n'));
  const m2 = model(reversed);
  for (const dst of ['8.8.8.8', '10.50.1.1', '10.50.7.9', '10.60.1.1', '198.18.0.1', '10.70.1.1']) {
    const a = R.lookup(m1, 'r1', '', A(dst));
    const b = R.lookup(m2, 'r1', '', A(dst));
    assert.deepEqual([a.kind, hops(a)], [b.kind, hops(b)], dst);
  }
  assert.deepEqual(R.sortedRoutes(m1, 'r1').map(R.routeText), R.sortedRoutes(m2, 'r1').map(R.routeText));
});

test('next-hop targets and candidates: what the diagram points at, what the editor suggests', () => {
  const m = model(net);
  const r1 = m.index.devices.get('r1');
  const t = (i) => R.nextHopTargets(m, r1.routes[i]).map((x) => x.device + ':' + (x.iface || ''));
  assert.deepEqual(t(0), ['r2:e0']);
  assert.deepEqual(t(6), ['r2:lo0'], 'the next-hop address is r2’s loopback');
  assert.deepEqual(t(8), ['r2:'], 'a tunnel exit points at its destination');
  assert.deepEqual(t(9), [], 'a blackhole points nowhere');
  assert.deepEqual(R.nextHopCandidates(m, 'r1', '').map((c) => `${c.address} ${c.device}:${c.iface} via ${c.via}`), ['10.0.12.2 r2:e0 via e0', '10.0.13.2 r3:e0 via e1']);
  assert.deepEqual(R.nextHopCandidates(m, 'r1', 'red'), []);
});
