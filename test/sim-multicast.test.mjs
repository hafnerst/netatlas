// Multicast in the protocol simulation (analysis/sim/multicast.ts) without a
// browser: the interfaces' `multicast:` blocks (groups, SSM sources, IGMP
// version, streams); IGMPv2 / v3 and MLD: querier election and takeover,
// general and group-specific queries, reports with their random delay,
// report suppression, leaves, expiry; IGMP snooping: router and member
// ports, members only, reports only to the router ports, fast leave, the
// snooping querier, flooding when off, unknown multicast; PIM: the shared
// tree, registers and Register-Stop, the switch to the source's tree (or
// not), SSM, the RPF check and the tree moving after a failure, dense mode's
// flood and prune; TTL 1 and link-local groups never routed; the tables;
// Join / Leave / Start / Stop events; firewalls, clouds, access points and
// tunnels; multicast test traffic; the checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, validate } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const Pm = load('analysis/sim/params.js');
const C = load('analysis/checks.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);
const ev = (s, f) => s.events().filter(f);
const status = (s, name) => s.status().find((r) => r.name === name);

/**
 * src — r1 (RP) — r2 — sw (snooping) — rxa (239.1.1.1), rxb (232.1.1.1 from src), idle;
 * x: extra YAML per device (sw, r1, r2, src, rxa), and links.
 */
const NET = (x = {}) => `netatlas: 1
title: mc
devices:
  - id: src
    type: server
    interfaces:
      - id: eth0
        ip: 10.1.0.10/24
        multicast: {streams: [{group: 239.1.1.1, interval: 1s}, {group: 232.1.1.1, port: 5006, interval: 1s}]}
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]${x.src || ''}
  - id: r1
    type: router
    router_id: 10.255.0.1
    protocols: {ospf: {}, pim: {${x.r1pim || 'rp: 10.255.0.1'}}}
    interfaces: [{id: g0, ip: 10.1.0.1/24}, {id: g1, ip: 10.0.12.1/30}, {id: g2, ip: 10.0.13.1/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]${x.r1 || ''}
  - id: r2
    type: router
    router_id: 10.255.0.2
    protocols: {ospf: {}, pim: {${x.r2pim || ''}}}
    interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.2.0.1/24}, {id: g2, ip: 10.0.23.2/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]${x.r2 || ''}
  - id: r3
    type: router
    router_id: 10.255.0.3
    protocols: {ospf: {}, pim: {${x.r2pim || ''}}}
    interfaces: [{id: g0, ip: 10.0.13.2/30}, {id: g1, ip: 10.0.23.1/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.3/32}]
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]${x.sw || ''}}
  - id: rxa
    type: endpoint
    interfaces: [{id: eth0, ip: 10.2.0.21/24, multicast: {join: [239.1.1.1]}}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]${x.rxa || ''}
  - id: rxb
    type: endpoint
    interfaces: [{id: eth0, ip: 10.2.0.22/24, multicast: {join: [{group: 232.1.1.1, sources: [10.1.0.10]}]}}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
  - {id: idle, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.23/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]${x.idle || ''}}
links:
  - {id: a, a: "src:eth0", b: "r1:g0"}
  - {id: b, a: "r1:g1", b: "r2:g0"}
  - {id: c, a: "r2:g1", b: "sw:p1"}
  - {id: d, a: "sw:p2", b: "rxa:eth0"}
  - {id: e, a: "sw:p3", b: "rxb:eth0"}
  - {id: f, a: "sw:p4", b: "idle:eth0"}
  - {id: g, a: "r1:g2", b: "r3:g0"}
  - {id: h, a: "r3:g1", b: "r2:g2"}
relations:
  - {id: o12, protocol: ospf, endpoints: ["r1:g1", "r2:g0"], attrs: {area: 0, cost: 10}}
  - {id: o13, protocol: ospf, endpoints: ["r1:g2", "r3:g0"], attrs: {area: 0, cost: 20}}
  - {id: o23, protocol: ospf, endpoints: ["r3:g1", "r2:g2"], attrs: {area: 0, cost: 20}}
  - {id: p12, protocol: pim, endpoints: ["r1:g1", "r2:g0"]}
  - {id: p13, protocol: pim, endpoints: ["r1:g2", "r3:g0"]}
  - {id: p23, protocol: pim, endpoints: ["r3:g1", "r2:g2"]}${x.rels || ''}
${x.nets ? 'networks:\n' + x.nets + '\n' : ''}`;

/** One LAN: two routers (queriers), a switch, hosts; no PIM routing needed. */
const LAN = (x = {}) => `netatlas: 1
title: lan
devices:
  - {id: q1, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: [10.5.0.1/24, "2001:db8:5::1/64"]}]${x.q1 || ''}}
  - {id: q2, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: [10.5.0.2/24, "2001:db8:5::2/64"]}]${x.q2 || ''}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]${x.sw || ''}}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: [10.5.0.11/24, "2001:db8:5::11/64"]${x.h1j || ', multicast: {join: [239.2.2.2]}'}}]${x.h1 || ''}}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: [10.5.0.12/24, "2001:db8:5::12/64"]${x.h2j || ', multicast: {join: [239.2.2.2]}'}}]${x.h2 || ''}}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.13/24}]}
links:
  - {id: l1, a: "q1:g0", b: "sw:p1"}
  - {id: l2, a: "q2:g0", b: "sw:p2"}
  - {id: l3, a: "h1:eth0", b: "sw:p3"}
  - {id: l4, a: "h2:eth0", b: "sw:p4"}
  - {id: l5, a: "h3:eth0", b: "sw:p5"}
`;

// ------------------------------------------------------------------ the registry and the format

test('multicast parameters: IGMP snooping (Layer 2) and the query interval (Layer 3) complete their sections; the attributes by device type', () => {
  assert.deepEqual(Pm.layerRows(2).length, 8);
  assert.deepEqual(Pm.layerRows(3).length, 8);
  assert.equal(Pm.paramDef('igmp-snooping').dflt, 'on');
  assert.equal(Pm.formatValue(Pm.paramDef('igmp-query'), Pm.paramDef('igmp-query').dflt), '125 s');
  assert.match(Pm.paramDef('igmp-query').source, /RFC 3376/);
  assert.ok(Pm.paramDef('test-type').options.some((o) => o.value === 'multicast'));
  assert.equal(Pm.formatValue(Pm.paramDef('igmp-unsolicited'), 0), 'by version: v2 10 s, v3 1 s');
  const byType = new Map(Pm.attributesByType().map((x) => [x.type, x.keys]));
  for (const k of ['igmp-version', 'igmp-unsolicited']) assert.ok(byType.get('endpoint').includes(k), k);
  // the querier's settings are an interface's, with a device-wide default; the DR priority an interface's only
  for (const k of ['igmp-querier', 'igmp-query', 'igmp-max-resp', 'igmp-robustness', 'igmp-lmqi', 'spt-switchover']) assert.ok(byType.get('router').includes(k), k);
  assert.ok(!byType.get('router').includes('pim-dr-priority') && Pm.paramDef('pim-dr-priority').level === 'interface');
  // snooping: per VLAN (a global default for snooping itself)
  for (const k of ['igmp-snooping', 'mrouter-aging', 'igmp-query']) assert.ok(byType.get('switch').includes(k), k);
  for (const k of ['snoop-querier', 'fast-leave', 'unknown-mc']) assert.ok(!byType.get('switch').includes(k) && Pm.paramDef(k).level === 'vlan', k);
  assert.deepEqual(Pm.vlanParams().map((p) => p.key), ['igmp-snooping', 'snoop-querier', 'fast-leave', 'unknown-mc']);
  assert.ok(!byType.get('firewall').includes('mc-passthrough') && Pm.paramDef('mc-passthrough').level === 'interface');
  assert.ok(byType.get('vpn_gateway').includes('mc-tunnel'), 'a VPN gateway’s default for its tunnels');
  assert.ok(!byType.get('ap').includes('mc-to-unicast') && Pm.paramDef('mc-to-unicast').level === 'interface');
  assert.ok(byType.get('cloud').includes('mc-support'));
});

test('multicast: blocks are checked: a group, never link-local; SSM with its sources and IGMPv3; streams with their defaults', () => {
  const m = (iface, sim = '') => validate.loadModel(`netatlas: 1\ntitle: t\ndevices:\n  - id: h\n    type: endpoint\n    interfaces:\n      - {id: e0, ip: 10.0.0.5/24, multicast: ${iface}}${sim}\n`);
  const ok = m('{join: [239.1.1.1, {group: 232.1.1.1, sources: [10.0.0.9]}], streams: [{group: 239.1.1.1}, {group: 239.1.1.2, port: 6000, interval: 500ms, size: 200}]}');
  assert.deepEqual(ok.errors, []);
  const i = ok.model.devices[0].interfaces[0].multicast;
  assert.deepEqual(i.joins.map((j) => [j.group, j.sources]), [['239.1.1.1', []], ['232.1.1.1', ['10.0.0.9']]]);
  assert.deepEqual(i.streams.map((s) => [s.group, s.port, s.interval, s.size]), [['239.1.1.1', 5004, 1000, 1316], ['239.1.1.2', 6000, 500, 200]]);
  const err = (b, sim) => m(b, sim).errors.map((e) => e.message);
  assert.match(err('{join: [10.0.0.1]}')[0], /10\.0\.0\.1 is not a multicast group \(224\.0\.0\.0\/4, ff00::\/8\)/);
  assert.match(err('{join: [224.0.0.5]}')[0], /224\.0\.0\.5 is a link-local group \(224\.0\.0\.0\/24\): it is never joined or routed/);
  assert.match(err('{join: [232.1.1.1]}')[0], /232\.1\.1\.1 is a source-specific group \(232\.0\.0\.0\/8\): write its sources/);
  assert.match(err('{join: [{group: 239.1.1.1, sources: [10.0.0.9]}]}', '\n    simulation: {igmp_version: v2}')[0], /needs IGMPv3 \(MLDv2\): the interface's \(or its device's\) simulation sets igmp_version: v2/);
  assert.match(err('{join: [239.1.1.1, 239.1.1.1]}')[0], /239\.1\.1\.1 is joined twice/);
  assert.match(err('{streams: [{group: 239.1.1.1, port: 0}]}')[0], /UDP port/);
  assert.match(err('{stream: []}')[0], /unknown key "stream"/);
  const noIp = validate.loadModel(`netatlas: 1\ntitle: t\ndevices:\n  - id: h\n    interfaces: [{id: e0, multicast: {join: [239.1.1.1]}}]\n`);
  assert.match(noIp.errors[0].message, /interface "e0" has no address: it can neither join a group nor send a stream/);
});

// ------------------------------------------------------------------ IGMP / MLD

test('IGMP: the lowest address is the querier; the other stops and takes over when it goes silent (other-querier-present interval)', () => {
  const s = sim(LAN({ q1: ', simulation: {igmp_query_interval: 10}', q2: ', simulation: {igmp_query_interval: 10}' }));
  s.runTo(3000);
  assert.ok(ev(s, (e) => e.device === 'q2' && e.what === 'not querier' && /hears a query from 10\.5\.0\.1 \(lower than its 10\.5\.0\.2\)/.test(e.detail)).length === 1);
  assert.match(s.igmpTable('q2').notes.join(' '), /g0 \(10\.5\.0\.2\): not the querier \(10\.5\.0\.1 queries\)/);
  s.powerOff('q1');
  // robustness 2 × 10 s + 10 s ÷ 2 = 25 s
  s.runTo(s.now + 30000);
  const take = ev(s, (e) => e.device === 'q2' && e.what === 'querier' && /takes over as IGMP querier: no query from 10\.5\.0\.1 for 25 s/.test(e.detail));
  assert.equal(take.length, 1);
  assert.match(s.igmpTable('q2').notes[0], /the querier/);
});

test('IGMP: members answer a general query after a random delay up to the response interval; IGMPv2 hosts suppress their report when another member answered (snooping off)', () => {
  const s = sim(LAN({ sw: ', simulation: {igmp_snooping: "off"}', h1: ', simulation: {igmp_version: v2}', h2: ', simulation: {igmp_version: v2}' }));
  s.runTo(130000);
  const answers = ev(s, (e) => e.kind === 'message' && e.what === 'Report' && /answers the general query of 10\.5\.0\.1 after/.test(e.detail));
  assert.ok(answers.length >= 1);
  for (const a of answers) {
    const ms = /after (\d+(?:\.\d+)?) (ms|s)/.exec(a.detail);
    assert.ok(Number(ms[1]) * (ms[2] === 's' ? 1000 : 1) <= 10000, a.detail);
  }
  assert.ok(ev(s, (e) => e.what === 'report suppressed' && /its own answer is suppressed \(IGMPv2\)/.test(e.detail)).length >= 1);
  // the router keeps the group with its last reporter and version
  const row = s.igmpTable('q1').rows.find((r) => r[1] === '239.2.2.2');
  assert.equal(row[3], 'IGMPv2');
});

test('IGMP: a leave makes the querier ask with group-specific queries (robustness times, one last member query interval apart); unanswered, the group goes', () => {
  const s = sim(LAN({ h2j: ' ', h1: ', simulation: {igmp_version: v2}' }));
  // (its first unsolicited report may go before the switch knows its router ports: the repeat, 10 s later, gets there)
  s.runTo(13000);
  assert.ok(s.igmpTable('q1').rows.some((r) => r[1] === '239.2.2.2'));
  s.leaveGroup('h1', 'eth0', '239.2.2.2');
  s.runTo(s.now + 4000);
  assert.ok(ev(s, (e) => e.device === 'h1' && e.what === 'Leave' && /IGMPv2 Leave Group from h1 \(10\.5\.0\.11\) for 239\.2\.2\.2 to 224\.0\.0\.2/.test(e.detail)).length === 1);
  const gsq = ev(s, (e) => e.device === 'q1' && e.what === 'Query' && /Group-Specific Query from q1 \(10\.5\.0\.1\) to 239\.2\.2\.2/.test(e.detail));
  assert.equal(gsq.length, 2);
  assert.equal(Math.round(gsq[1].t - gsq[0].t), 1000);
  assert.ok(!s.igmpTable('q1').rows.some((r) => r[1] === '239.2.2.2'));
  assert.ok(ev(s, (e) => e.what === 'membership expired' && /nobody answered the group-specific queries/.test(e.detail)).length >= 1);
  // the leave is an event: Join again ends it
  const le = s.netEvents().find((e) => e.kind === 'leave');
  assert.equal(le.group, '239.2.2.2');
  assert.ok(s.end(le));
  assert.ok(!s.netEvents().some((e) => e.kind === 'leave'));
});

test('IGMPv3 and MLD: reports with records (and sources), to 224.0.0.22 / ff02::16; a membership expires when its host is gone', () => {
  const s = sim(LAN({ h1j: ', multicast: {join: [{group: 232.9.9.9, sources: [10.9.0.1]}, "ff05::9"]}', q1: ', simulation: {igmp_query_interval: 10}' }));
  s.runTo(5000);
  const v3 = ev(s, (e) => e.device === 'h1' && e.what === 'Report' && /232\.9\.9\.9/.test(e.detail))[0];
  assert.match(v3.detail, /IGMPv3 Report from h1 \(10\.5\.0\.11\) to 224\.0\.0\.22: ALLOW \/ IS_IN \(232\.9\.9\.9, \{10\.9\.0\.1\}\)/);
  assert.deepEqual([v3.hdr.l4.igmp.version, v3.hdr.l4.igmp.sources], ['IGMPv3', ['10.9.0.1']]);
  const mld = ev(s, (e) => e.device === 'h1' && e.what === 'Report' && /ff05::9/.test(e.detail))[0];
  assert.match(mld.detail, /MLDv2 Report from h1 \(2001:db8:5::11\) to ff02::16: IS_EX \(ff05::9, \{\}\)/);
  assert.equal(mld.hdr.l4.icmpType, 143);
  const t = s.igmpTable('q1');
  assert.ok(t.rows.some((r) => r[1] === '232.9.9.9' && r[4] === '10.9.0.1'));
  assert.ok(t.rows.some((r) => r[1] === 'ff05::9'));
  // h1 powered off: no more reports; after robustness × query + response (2 × 10 s + 10 s) the groups go
  s.powerOff('h1');
  s.runTo(s.now + 32000);
  assert.ok(!s.igmpTable('q1').rows.some((r) => r[1] === '232.9.9.9'));
  assert.ok(ev(s, (e) => e.what === 'membership expired' && /no report within the membership interval/.test(e.detail)).length >= 1);
});

// ------------------------------------------------------------------ snooping

test('snooping: router ports from queries and PIM Hellos, member ports from reports; data only to members and routers; reports only to the routers', () => {
  const s = sim(NET());
  s.runTo(20000);
  const rows = s.snoopTable('sw').rows;
  assert.deepEqual(rows.map((r) => [r[1], r[2].split(' ')[0], r[3].split(' ')[0]]), [['232.1.1.1', 'p3', 'p1'], ['239.1.1.1', 'p2', 'p1']]);
  // idle (no member) gets no stream; rxa gets 239.1.1.1 only, rxb 232.1.1.1 only
  const on = (link) => s.engine.flights.filter((f) => f.track.ref === 'link:' + link && f.hdr && f.hdr.l3.length && /^23[29]\./.test(f.hdr.l3[0].dst) && f.protocol === 'mcast').map((f) => f.hdr.l3[0].dst);
  s.runTo(24000);
  assert.deepEqual(on('f'), []);
  assert.ok(on('d').length && on('d').every((g) => g === '239.1.1.1'));
  assert.ok(on('e').length && on('e').every((g) => g === '232.1.1.1'));
  // a report never reaches another host
  assert.ok(!s.engine.flights.some((f) => (f.track.ref === 'link:f' || f.track.ref === 'link:e') && f.protocol === 'igmp' && /Report 239/.test(f.label)));
  assert.match(s.snoopTable('sw').timers.map((t) => `${t.label}: ${t.value}`).join(', '), /IGMP \/ MLD snooping: On, Fast leave: Off, Unknown multicast: Flood in the VLAN/);
});

test('snooping: off floods every group; unknown multicast dropped goes to router ports only; fast leave removes a port at once', () => {
  // (the switch's untagged frames are VLAN 1: its settings are the network's of VLAN 1)
  const lan = (b) => `  - {id: lan, cidr: 10.2.0.0/24, vlan: 1, simulation: ${b}}`;
  const off = sim(NET({ nets: lan('{igmp_snooping: "off"}') }));
  off.runTo(24000);
  assert.ok(off.engine.flights.some((f) => f.track.ref === 'link:f' && f.protocol === 'mcast'), 'idle gets the streams');
  // a group nobody joined: flooded by default, dropped when unknown multicast is drop
  const Y = (sw) => NET({ sw, idle: ', simulation: {igmp_version: v3}' }).replace('{group: 232.1.1.1, port: 5006, interval: 1s}]', '{group: 232.1.1.1, port: 5006, interval: 1s}]}\n    simulation: {test_traffic: "off"').replace('multicast: {streams: [{group: 239.1.1.1, interval: 1s}, {group: 232.1.1.1, port: 5006, interval: 1s}]}\n    simulation: {test_traffic: "off"', 'multicast: {streams: [{group: 239.1.1.1, interval: 1s}, {group: 232.1.1.1, port: 5006, interval: 1s}]}');
  void Y;
  const s = sim(NET({ nets: lan('{fast_leave: "on"}') }));
  s.runTo(10000);
  s.leaveGroup('rxa', 'eth0', '239.1.1.1');
  s.runTo(s.now + 100);
  assert.ok(ev(s, (e) => e.device === 'sw' && /port p2 leaves 239\.1\.1\.1 at once \(fast leave\)/.test(e.detail)).length === 1);
  const unknown = sim(NET({ nets: lan('{unknown_multicast: drop}') }));
  unknown.runTo(5000);
  unknown.leaveGroup('rxa', 'eth0', '239.1.1.1');
  unknown.runTo(unknown.now + 300000);
  // no member left on the switch: the group goes to the router port only, never to idle or rxa
  const t = unknown.now;
  unknown.runTo(t + 5000);
  assert.ok(!unknown.engine.flights.some((f) => f.t0 > t && (f.track.ref === 'link:d' || f.track.ref === 'link:f') && f.protocol === 'mcast' && f.hdr.l3[0].dst === '239.1.1.1'));
});

test('snooping querier: a VLAN without a multicast router is queried by the switch (when on), so that its members are learned', () => {
  const Y = (sim) => `netatlas: 1
title: q
devices:
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}], logical_interfaces: [{id: Vlan1, type: virtual, vlan: 1, ip: 10.9.0.2/24}]${sim}}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.11/24, multicast: {join: [239.3.3.3]}}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.12/24}]}
links:
  - {id: a, a: "h1:eth0", b: "sw:p1"}
  - {id: b, a: "h2:eth0", b: "sw:p2"}
`;
  const off = sim(Y(''));
  off.runTo(10000);
  assert.ok(!ev(off, (e) => e.device === 'sw' && e.what === 'Query').length);
  const on = sim(Y(', simulation: {igmp_query_interval: 5}') + 'networks:\n  - {id: v1, cidr: 10.9.0.0/24, vlan: 1, simulation: {snooping_querier: "on"}}\n');
  // (its first query goes when its first port is up, possibly before h1's: h1 answers the next one, within its 10 s)
  on.runTo(18000);
  const q = ev(on, (e) => e.device === 'sw' && e.what === 'Query');
  assert.ok(q.length >= 2);
  assert.match(q[0].detail, /General Query from sw \(snooping querier, 10\.9\.0\.2\) in VLAN 1: no multicast router there/);
  assert.ok(ev(on, (e) => e.device === 'h1' && /answers the general query of 10\.9\.0\.2/.test(e.detail)).length >= 1);
});

// ------------------------------------------------------------------ PIM

test('PIM-SM: the receiver’s DR joins the shared tree to the RP; the source registers; Register-Stop; the last hop switches to the source’s tree', () => {
  const s = sim(NET());
  s.runTo(30000);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.what === 'source' && /this router is the RP/.test(e.detail)).length === 1, 'r1 is the first hop and the RP');
  // its first join goes out once OSPF has a route to the RP (an RPF change from none)
  assert.ok(ev(s, (e) => e.device === 'r2' && /\(\*, 239\.1\.1\.1\).*(towards the RP 10\.255\.0\.1|from none to g0 \(r1\): join there)/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'r2' && e.what === 'SPT switchover').length === 1);
  const r2 = s.mrouteTable('r2').rows.map((r) => [r[0], r[1], r[2], r[3]]);
  assert.deepEqual(r2.find((r) => r[0] === '(*, 239.1.1.1)'), ['(*, 239.1.1.1)', 'g0 (r1)', 'g1 (members)', 'sparse']);
  assert.ok(r2.some((r) => r[0] === '(10.1.0.10, 239.1.1.1)' && /SPT/.test(r[3])));
  assert.ok(r2.some((r) => r[0] === '(10.1.0.10, 232.1.1.1)' && r[3] === 'SSM'));
  assert.match(s.mrouteTable('r1').notes[0], /^RP 10\.255\.0\.1 \(r1\): the static RP of r1/);
  assert.deepEqual([status(s, 'rxa member of 239.1.1.1').state, status(s, 'rxb member of 232.1.1.1 (10.1.0.10)').state], ['Receiving', 'Receiving']);
});

test('PIM-SM with the RP elsewhere: Register, Register-Stop once the RP gets the data natively; SPT switchover never keeps the shared tree', () => {
  const Y = NET({ r1pim: 'rp: 10.255.0.3', r2pim: 'rp: 10.255.0.3' });
  const s = sim(Y);
  s.runTo(40000);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.what === 'Register').length >= 1);
  assert.ok(ev(s, (e) => e.device === 'r3' && e.what === 'Register-Stop').length === 1);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.what === 'registered').length === 1);
  assert.equal(status(s, 'rxa member of 239.1.1.1').state, 'Receiving');
  const never = sim(Y.replace('logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]', 'logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]\n    simulation: {spt_switchover: never}'));
  never.runTo(40000);
  assert.equal(ev(never, (e) => e.device === 'r2' && e.what === 'SPT switchover').length, 0);
  assert.ok(!never.mrouteTable('r2').rows.some((r) => r[0] === '(10.1.0.10, 239.1.1.1)'));
  assert.equal(status(never, 'rxa member of 239.1.1.1').state, 'Receiving');
});

test('the RPF check, and the tree moving when a link fails: new joins on the new RPF interface, prunes to the old neighbour; the receivers get the stream again', () => {
  const s = sim(NET());
  s.runTo(30000);
  s.fail('link:b');
  s.runTo(s.now + 30000);
  const ch = ev(s, (e) => e.device === 'r2' && e.what === 'RPF change');
  assert.ok(ch.some((e) => /\(\*, 239\.1\.1\.1\) changes from g0 \(r1\) to g2 \(r3\)/.test(e.detail)));
  assert.ok(s.mrouteTable('r2').rows.some((r) => r[0] === '(10.1.0.10, 232.1.1.1)' && r[1] === 'g2 (r3)'));
  assert.equal(status(s, 'rxb member of 232.1.1.1 (10.1.0.10)').state, 'Receiving');
});

test('dense mode: the first packets flood to every PIM neighbour; a router without receivers prunes itself off', () => {
  const s = sim(NET({ r1pim: 'mode: dense', r2pim: 'mode: dense' }).replace('{group: 232.1.1.1, port: 5006, interval: 1s}', '{group: 239.5.5.5, port: 5006, interval: 1s}'));
  s.runTo(30000);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.what === 'source' && /dense mode: flooded to every PIM neighbour, then pruned/.test(e.detail)).length >= 1);
  // r3 has no receivers: it prunes (10.1.0.10, 239.5.5.5) upstream
  assert.ok(ev(s, (e) => e.device === 'r3' && e.kind === 'message' && e.what === 'Join/Prune' && /prune \(10\.1\.0\.10, 239\.5\.5\.5\)/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.what === 'pruned' && /pruned off g2 for 210 s/.test(e.detail)).length >= 1);
  // r2 got r3's flooded copy on g2, not its RPF interface towards the source: the RPF check drops it (and r3 is told to prune)
  assert.ok(ev(s, (e) => e.device === 'r2' && /RPF check failed for \(10\.1\.0\.10, 239\.5\.5\.5\): it arrived on g2, the RPF interface towards the source is g0; dropped/.test(e.detail)).length >= 1);
  assert.equal(status(s, 'rxa member of 239.1.1.1').state, 'Receiving');
});

test('never routed: link-local groups and TTL 1; a router without PIM routes no multicast; a firewall only with passthrough; a cloud (a Layer 3 hop) passes no link-local Hellos', () => {
  const ttl = sim(NET({ src: '\n    simulation: {ttl: 1}' }));
  ttl.runTo(20000);
  assert.ok(ev(ttl, (e) => e.device === 'r1' && /does not route UDP → 239\.1\.1\.1:5004 from 10\.1\.0\.10: its TTL is 1/.test(e.detail)).length >= 1);
  assert.notEqual(status(ttl, 'rxa member of 239.1.1.1').state, 'Receiving');
  const fw = sim(NET().replace('  - id: r2\n    type: router', '  - id: r2\n    type: firewall'));
  fw.runTo(20000);
  assert.ok(ev(fw, (e) => e.device === 'r2' && /r2 drops multicast for 239\.1\.1\.1 from 10\.1\.0\.10: multicast passthrough Off \(default\)/.test(e.detail)).length >= 1);
  const pass = sim(NET().replace('{id: g0, ip: 10.0.12.2/30}', '{id: g0, ip: 10.0.12.2/30, simulation: {multicast_passthrough: "on"}}').replace('  - id: r2\n    type: router', '  - id: r2\n    type: firewall'));
  pass.runTo(30000);
  assert.equal(status(pass, 'rxa member of 239.1.1.1').state, 'Receiving');
  // a cloud between r1 and r2
  const cloud = (on) => NET().replace('  - {id: b, a: "r1:g1", b: "r2:g0"}', '  - {id: b, a: "r1:g1", b: "inet:a"}\n  - {id: b2, a: "inet:b", b: "r2:g0"}').replace('  - {id: sw, type: switch', `  - {id: inet, type: cloud, interfaces: [{id: a, vlans: 1}, {id: b, vlans: 1}]${on ? ', simulation: {multicast: "on"}' : ''}}\n  - {id: sw, type: switch`);
  // a cloud is one Layer 3 hop: link-local PIM Hellos end at it (with or without multicast), so r1 and r2 are no PIM neighbours
  // across it and the stream takes the routed way round through r3
  for (const on of [false, true]) {
    const c = sim(cloud(on));
    c.runTo(30000);
    assert.ok(ev(c, (e) => e.device === 'inet' && e.protocol === 'pim' && /inet is a Layer 3 hop \(an external network\): .*224\.0\.0\.13.* does not cross it/.test(e.detail)).length >= 1, 'PIM Hellos end at the cloud');
    assert.ok(!ev(c, (e) => e.protocol === 'pim' && e.what === 'Neighbour' && e.device === 'r2' && /10\.0\.12\./.test(e.detail)).length, 'no PIM neighbour across the cloud');
    assert.equal(status(c, 'rxa member of 239.1.1.1').state, 'Receiving');
  }
});

// ------------------------------------------------------------------ events, tests, access points, checks

test('Join group / Start stream as events: listed with their way back (Leave group, Stop stream); Stop on a stream of the model and Start again', () => {
  const s = sim(NET());
  s.runTo(10000);
  assert.equal(s.joinGroup('idle', 'eth0', '239.1.1.1', []), null);
  assert.equal(s.joinGroup('idle', 'eth0', '224.0.0.5', []), '224.0.0.5 is a link-local group: it is never joined');
  assert.equal(s.joinGroup('idle', 'eth0', '232.7.7.7', []), '232.7.7.7 is a source-specific group: name its sources');
  assert.equal(s.startStream('rxa', 'eth0', '239.8.8.8', 6000, 500, 100), null);
  s.runTo(s.now + 10000);
  const evs = s.netEvents().filter((e) => e.group);
  assert.deepEqual(evs.map((e) => [e.kind, e.ref, e.group]), [['join', 'iface:idle:eth0', '239.1.1.1'], ['stream', 'iface:rxa:eth0', '239.8.8.8']]);
  assert.equal(status(s, 'idle member of 239.1.1.1').state, 'Receiving');
  assert.ok(status(s, 'rxa → 239.8.8.8:6000').detail.indexOf('(Start stream)') > 0);
  for (const e of evs) assert.ok(s.end(e));
  assert.deepEqual(s.netEvents().filter((e) => e.group), []);
  // a stream of the model stopped: an event "stopped", ended by Start stream
  assert.ok(s.stopStream('src', 'eth0', '239.1.1.1'));
  const st = s.netEvents().find((e) => e.kind === 'stopped');
  assert.equal(st.group, '239.1.1.1');
  assert.equal(status(s, 'src → 239.1.1.1:5004').state, 'Stopped');
  assert.ok(s.end(st));
  assert.equal(status(s, 'src → 239.1.1.1:5004').state, 'Sending');
});

test('multicast tests: a UDP datagram to a group is received by its members (test traffic of the multicast type, Send test…)', () => {
  const s = sim(NET({ idle: ', simulation: {test_traffic: "on", test_type: multicast, test_interval: 5}' }));
  s.runTo(30000);
  const ok = ev(s, (e) => e.what === 'Test answered' && /^Test idle → 239\.1\.1\.1 udp\/5004: received by 1 member: rxa \(round trip [\d.]+ ms\)$/.test(e.detail));
  assert.ok(ok.length >= 3, 'answered, with the time to the first member');
  // to the SSM group, from a source it does not name: nobody takes it
  assert.ok(ev(s, (e) => e.what === 'Test failed' && /idle → 232\.1\.1\.1 udp\/5004: no member received it within 5 s/.test(e.detail)).length >= 1);
  const t = s.sendTest({ from: 'rxb', to: '239.1.1.1', kind: 'udp', port: 5004 });
  s.runTo(s.now + 6000);
  assert.equal(t.result, 'received by 1 member: rxa');
});

test('an access point with multicast to unicast sends a group to its client as unicast frames; tunnels carry multicast only when allowed', () => {
  const Y = (m2u) => `netatlas: 1
title: ap
devices:
  - {id: q, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: 10.6.0.1/24}]}
  - {id: src, type: server, interfaces: [{id: eth0, ip: 10.6.0.10/24, multicast: {streams: [{group: 239.6.6.6}]}}]}
  - {id: ap, type: ap, interfaces: [up, ${m2u ? '{id: w1, simulation: {multicast_to_unicast: "on"}}' : 'w1'}, w2]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: phone, type: endpoint, interfaces: [{id: wlan0, ip: 10.6.0.21/24, multicast: {join: [239.6.6.6]}}]}
links:
  - {id: a, a: "q:g0", b: "sw:p1"}
  - {id: b, a: "src:eth0", b: "sw:p2"}
  - {id: c, a: "sw:p3", b: "ap:up"}
  - {id: air, a: "ap:w1", b: "phone:wlan0", medium: wireless}
`;
  const off = sim(Y(false));
  off.runTo(15000);
  const fo = off.engine.flights.filter((f) => f.track.ref === 'link:air' && f.hdr && f.hdr.l3.length && f.hdr.l3[0].dst === '239.6.6.6');
  assert.ok(fo.length && fo.every((f) => f.cast === 'multicast'));
  const on = sim(Y(true));
  on.runTo(15000);
  const fu = on.engine.flights.filter((f) => f.track.ref === 'link:air' && f.hdr && f.hdr.l3.length && f.hdr.l3[0].dst === '239.6.6.6');
  assert.ok(fu.length && fu.every((f) => f.cast === 'unicast'));
  assert.ok(ev(on, (e) => e.device === 'ap' && e.what === 'multicast to unicast').length === 1);
  assert.equal(status(on, 'phone member of 239.6.6.6').state, 'Receiving');
});

test('the checks: no querier for receivers, no RP for sparse-mode groups, an RPF interface without PIM', () => {
  const ids = (text) => C.runChecks(model(text)).map((f) => f.check).filter((c) => /^multicast/.test(c)).sort();
  assert.deepEqual(ids(NET()), []);
  assert.deepEqual(ids(NET({ r1pim: ' ', r2pim: ' ' })), ['multicast-no-rp']);
  assert.deepEqual(Array.from(new Set(ids(NET().replace('  - {id: p12, protocol: pim, endpoints: ["r1:g1", "r2:g0"]}\n', '')))), ['multicast-rpf-not-pim']);
  const lonely = NET().replace("ip: 10.2.0.23/24}]", "ip: 10.7.0.23/24, multicast: {join: [239.1.1.1]}}]");
  assert.deepEqual(ids(lonely), ['multicast-no-querier']);
});

test('determinism with multicast events at the same times', () => {
  const go = () => {
    const s = sim(NET());
    s.runTo(15000);
    s.joinGroup('idle', 'eth0', '239.1.1.1', []);
    s.fail('link:b');
    s.runTo(40000);
    return s.events().map((e) => `${e.t}|${e.device}|${e.what}|${e.detail}`).join('\n');
  };
  assert.equal(go(), go());
});
