// Each layer of a tunnel stack from its own identity (trace.ts layerEnds; checks-more tunnelBudget, mtu.ts and the
// simulation's encapsulation): a layer carried over a relation between other addresses has that relation's family, ends
// and routing context, and the outer packet is routed by its outermost layer's. Static and runtime boundaries agree
// beyond the GRE slice: nested layers of different families, an IPv6 outer header, a UDP tunnel, an IPv6 inner packet,
// ESP's padding, a front-door VRF per layer, equal-cost underlays of different MTUs, an unknown format, an unwritten
// MTU. Every expected size is worked by hand from the specifications, never computed with the helper under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const MT = load('analysis/mtu.js');
const CM = load('analysis/checks-more.js');
const P = load('analysis/sim/params.js');

/** ha — a ==(tunnel)== b — hb; `a`/`b` blocks and the relations are the case's. */
const TOPO = (a, b, rels, links = '  - {id: l2, a: "a:wan", b: "b:wan"}') => `netatlas: 1
title: tunnel layers
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
${a}
  - id: b
    type: router
${b}
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: "ha:eth0", b: "a:lan"}
${links}
  - {id: l3, a: "b:lan", b: "hb:eth0"}
relations:
${rels}
`;

/** The static figures and the simulation's for a:tun0, and the largest DF ping payload that is answered. */
function figures(m, { at = 40000 } = {}) {
  const bud = CM.tunnelBudget(m, m.index.interfaces.get('a:tun0'));
  const c = C.checkCommunication(m, { from: 'ha', to: 'hb' });
  const mt = MT.pathMtu(m, c);
  const s = new S.Simulation(m);
  s.runTo(at);
  const egress = s.engine.egressMtu('a', s.engine.net.devices.get('a').l3.get('tun0'));
  const ping = (size) => {
    const run = s.sendPlan({ delivery: 'unicast', from: 'ha', kind: 'icmp', target: '10.2.0.10', size, df: true });
    s.runTo(s.now + 6000);
    return run.tests[0];
  };
  return { bud, c, mt, s, egress, ping };
}

/** The outer packet records of the simulation with n IP headers (outermost first). */
const framesOf = (s, n) => Array.from(s.engine.packets.values()).filter((r) => r.hdr.l3.length === n);

test('GRE (IPv4 ends) over an IPsec relation between IPv6 addresses: each layer its own family; static and runtime 1398', () => {
  // ESP over IPv6 within 1500: 40 IPv6 + 8 (SPI, sequence) + 16 IV + 12 ICV = 76, leaving 1424 for the padded payload:
  // n + 2 ≤ 1424 and a multiple of 16 → n ≤ 1422; GRE with IPv4 ends adds 20 + 4 → 1398 (ICMP payload 1398 − 28 = 1370)
  const m = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: "2001:db8::1/64", mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}, {id: tun0, type: tunnel, ip: 172.16.0.1/30, source: lo0, destination: 10.255.0.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: "2001:db8::2/64", mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}, {id: tun0, type: tunnel, ip: 172.16.0.2/30, source: lo0, destination: 10.255.0.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: ipsec1, protocol: ipsec, endpoints: ["a:wan", "b:wan"]}
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"], over: [ipsec1]}`,
  ));
  const f = figures(m);
  assert.deepEqual(f.bud.layers.map((l) => [l.def.protocol, l.outer]), [['gre', 4], ['ipsec', 6]]);
  assert.equal(f.bud.fits(1500), 1398);
  assert.ok(f.bud.what.some((x) => /ipsec1: its own ends 2001:db8::1 → 2001:db8::2/.test(x)), f.bud.what.join(' | '));
  assert.equal(f.c.verdict, 'satisfied', f.c.headline);
  assert.equal(f.mt.mtu, 1398, f.mt.text);
  assert.equal(f.egress, 1398);
  assert.equal(f.ping(1370).ok, true);
  const big = f.ping(1371);
  assert.deepEqual([big.outcome.kind, big.outcome.mtu], ['too-big', 1398]);
  // the outer frame: IPv6 ESP between the IPsec ends, inside it IPv4 GRE between the loopbacks, inside that the ping
  const fr = framesOf(f.s, 3).find((r) => r.hdr.l3[2].dst === '10.2.0.10');
  assert.ok(fr, 'an outer packet of the ping');
  assert.deepEqual(fr.hdr.l3.map((x) => [x.version, x.src, x.dst]), [[6, '2001:db8::1', '2001:db8::2'], [4, '10.255.0.1', '10.255.0.2'], [4, '10.1.0.10', '10.2.0.10']]);
  // its keepalives the same: no keepalive left without its IPsec layer
  assert.ok(!f.s.events().some((e) => e.kind === 'drop' && /GRE Keepalive/.test(e.detail)), 'no keepalive dropped');
});

test('an IPv6 outer header: GRE between IPv6 ends takes 40 + 4 — 1456 within 1500, static and runtime', () => {
  const m = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: "2001:db8::1/64", mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: "2001:db8::2"}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: "2001:db8::2/64", mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: "2001:db8::1"}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}`,
  ));
  const f = figures(m);
  assert.deepEqual(f.bud.layers.map((l) => l.outer), [6]);
  assert.equal(f.bud.fits(1500), 1456);
  assert.equal(f.mt.mtu, 1456, f.mt.text);
  assert.equal(f.egress, 1456);
  assert.equal(f.ping(1428).ok, true);
  assert.equal(f.ping(1429).outcome.mtu, 1456);
});

test('a UDP tunnel: WireGuard takes 20 + 8 + 16 + 16 — 1440 within 1500; its outer packet is UDP to 51820', () => {
  const m = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: wg1, protocol: wireguard, endpoints: ["a:tun0", "b:tun0"]}`,
  ));
  const f = figures(m);
  assert.equal(f.bud.fits(1500), 1440);
  assert.equal(f.mt.mtu, 1440, f.mt.text);
  assert.equal(f.egress, 1440);
  assert.equal(f.ping(1412).ok, true);
  assert.equal(f.ping(1413).outcome.mtu, 1440);
  const fr = framesOf(f.s, 2).find((r) => r.hdr.l3[1].dst === '10.2.0.10');
  assert.ok(fr);
  assert.deepEqual([fr.hdr.l3[0].proto, fr.hdr.l3[0].len], ['UDP (17)', 1412 + 28 + 60], 'the inner 1440 + 60 (20 IPv4 + 8 UDP + 16 + 16)');
});

test('an IPv6 inner packet over IPv4 IP-in-IP: protocol 41, 20 bytes around it', () => {
  const m = model(`netatlas: 1
title: 6in4
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: "2001:db8:1::10/64", mtu: 1500}], routes: [{prefix: "::/0", via: "2001:db8:1::1"}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: "2001:db8:1::1/64", mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: "2001:db8:ff::1/64", source: wan, destination: 192.0.2.2}]
    routes: [{prefix: "2001:db8:2::/64", via: "2001:db8:ff::2"}]
  - id: b
    type: router
    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500}, {id: lan, ip: "2001:db8:2::1/64", mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: "2001:db8:ff::2/64", source: wan, destination: 192.0.2.1}]
    routes: [{prefix: "2001:db8:1::/64", via: "2001:db8:ff::1"}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: "2001:db8:2::10/64", mtu: 1500}], routes: [{prefix: "::/0", via: "2001:db8:2::1"}]}
links:
  - {id: l1, a: "ha:eth0", b: "a:lan"}
  - {id: l2, a: "a:wan", b: "b:wan"}
  - {id: l3, a: "b:lan", b: "hb:eth0"}
relations:
  - {id: t6, protocol: ipip, endpoints: ["a:tun0", "b:tun0"]}
`);
  const s = new S.Simulation(m);
  s.runTo(40000);
  // 1500 − 20 (IPv4 outer) = 1480 for the IPv6 packet: an echo of 1480 − 40 − 8 = 1432 bytes fits
  assert.equal(s.engine.egressMtu('a', s.engine.net.devices.get('a').l3.get('tun0')), 1480);
  const run = s.sendPlan({ delivery: 'unicast', from: 'ha', kind: 'icmp', target: '2001:db8:2::10', size: 1432 });
  s.runTo(s.now + 6000);
  assert.equal(run.tests[0].ok, true, run.tests[0].result);
  const fr = framesOf(s, 2).find((r) => r.hdr.l3[1].dst === '2001:db8:2::10');
  assert.deepEqual([fr.hdr.l3[0].version, fr.hdr.l3[0].proto, fr.hdr.l3[0].len, fr.hdr.l3[1].len], [4, 'IPv6 in IP (41)', 1500, 1480]);
});

test('ESP’s padding at run time: GRE over IPsec within 1500 takes 1414 — 1386 bytes of ping pass with DF, 1387 do not', () => {
  // ESP within 1500 (IPv4): 20 + 24 + 12 = 56, 1444 for the padded payload → n + 2 ≤ 1440 → n ≤ 1438; GRE: 1438 − 24 = 1414
  const m = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: ipsec1, protocol: ipsec, endpoints: ["a:wan", "b:wan"]}
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"], over: [ipsec1]}`,
  ));
  const f = figures(m);
  assert.deepEqual([f.bud.fits(1500), f.mt.mtu, f.egress], [1414, 1414, 1414]);
  assert.equal(f.ping(1386).ok, true);
  assert.equal(f.ping(1387).outcome.mtu, 1414);
});

test('a front-door VRF per layer: the IPsec layer’s outer packets go in its own interface’s VRF', () => {
  const m = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500, vrf: inet}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}, {id: tun0, type: tunnel, ip: 172.16.0.1/30, source: lo0, destination: 10.255.0.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500, vrf: inet}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}, {id: tun0, type: tunnel, ip: 172.16.0.2/30, source: lo0, destination: 10.255.0.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: ipsec1, protocol: ipsec, endpoints: ["a:wan", "b:wan"]}
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"], over: [ipsec1]}`,
  ));
  const f = figures(m);
  // (no route to the IPsec peer exists outside VRF inet: only its own VRF carries the outer packet)
  assert.equal(f.c.verdict, 'satisfied', f.c.headline);
  assert.equal(f.ping(100).ok, true);
  const fr = framesOf(f.s, 3).find((r) => r.hdr.l3[2].dst === '10.2.0.10');
  assert.deepEqual(fr.hdr.l3.slice(0, 2).map((x) => [x.src, x.dst]), [['192.0.2.1', '192.0.2.2'], ['10.255.0.1', '10.255.0.2']]);
});

test('equal-cost underlays of different MTUs: the tunnel’s limit is the branch its outer flow takes, not the first listed', () => {
  const m = model(`netatlas: 1
title: two underlays
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: w1, ip: 192.0.2.1/30, mtu: 1500}, {id: w2, ip: 192.0.2.5/30, mtu: 1400}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}, {id: tun0, type: tunnel, ip: 172.16.0.1/30, source: lo0, destination: 10.255.0.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}, {prefix: 10.255.0.2/32, via: 192.0.2.2}, {prefix: 10.255.0.2/32, via: 192.0.2.6}]
  - id: b
    type: router
    interfaces: [{id: w1, ip: 192.0.2.2/30, mtu: 1500}, {id: w2, ip: 192.0.2.6/30, mtu: 1400}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}, {id: tun0, type: tunnel, ip: 172.16.0.2/30, source: lo0, destination: 10.255.0.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}, {prefix: 10.255.0.1/32, via: 192.0.2.1}, {prefix: 10.255.0.1/32, via: 192.0.2.5}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: "ha:eth0", b: "a:lan"}
  - {id: u1, a: "a:w1", b: "b:w1"}
  - {id: u2, a: "a:w2", b: "b:w2"}
  - {id: l3, a: "b:lan", b: "hb:eth0"}
relations:
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}
`);
  const s = new S.Simulation(m);
  s.runTo(40000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'ha', kind: 'icmp', target: '10.2.0.10', size: 100 });
  s.runTo(s.now + 6000);
  assert.equal(run.tests[0].ok, true);
  // the branch the outer flow 10.255.0.1 → 10.255.0.2 took (recorded), and the limit the simulation uses
  const br = s.events().find((e) => e.route && e.device === 'a' && e.test === run.tests[0].id);
  assert.ok(br, 'the equal-cost choice is recorded');
  const want = br.route.iface === 'w1' ? 1500 - 24 : 1400 - 24;
  assert.equal(s.engine.egressMtu('a', s.engine.net.devices.get('a').l3.get('tun0')), want, `out ${br.route.iface}`);
  // statically, the alternatives' limits differ and are both said: the smaller bounds what is certain
  const mt = MT.pathMtu(m, C.checkCommunication(m, { from: 'ha', to: 'hb' }));
  assert.equal(mt.mtu, 1376, mt.text);
});

test('an unknown tunnel format and an unwritten MTU: said as an estimate and as not known; the simulation’s own assumption said too', () => {
  const unknown = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: x1, protocol: sdwan, endpoints: ["a:tun0", "b:tun0"]}`,
  ));
  assert.equal(CM.tunnelBudget(unknown, unknown.index.interfaces.get('a:tun0')), null, 'the tunnel-MTU check assumes nothing');
  const mt = MT.pathMtu(unknown, C.checkCommunication(unknown, { from: 'ha', to: 'hb' }));
  const ov = mt.forward[0].overheads[0];
  assert.equal(ov.assumed, true);
  assert.match(ov.what, /format not known, taken as GRE/);
  const s = new S.Simulation(unknown);
  s.runTo(40000);
  assert.equal(s.engine.egressMtu('a', s.engine.net.devices.get('a').l3.get('tun0')), 1476, 'the simulation takes it as GRE, as the static estimate');
  // no MTU written on the underlay: statically not known; the simulation sends with its default MTU, said so
  const bare = model(TOPO(
    `    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 192.0.2.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]`,
    `    interfaces: [{id: wan, ip: 192.0.2.2/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]`,
    `  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}`,
  ).replace(/, mtu: 1500/g, ''));
  const mb = MT.pathMtu(bare, C.checkCommunication(bare, { from: 'ha', to: 'hb' }));
  assert.equal(mb.mtu, null, mb.text);
  const sb = new S.Simulation(bare);
  sb.runTo(40000);
  const tun = sb.engine.net.devices.get('a').l3.get('tun0');
  const lim = sb.engine.tunnelLimit('a', tun, sb.engine.tunnelFormats([{ relation: 'gre1' }], 4), sb.engine.tunnelEnds('a', 'tun0')[0], '');
  assert.equal(lim.mtu, 1476);
  assert.match(lim.why, /underlay a:wan \(MTU 1500\)/, 'the simulation’s default MTU, as its parameter gives it');
  assert.match(P.resolvedText(sb.engine.mtu('a', sb.engine.net.devices.get('a').l3.get('wan'))), /^1500 .*default/i, 'from the default, not from the model');
});
