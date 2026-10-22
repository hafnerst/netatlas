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
 * x: extra YAML per device (sw, r1, r2, src, rxa), and links; x.snoop: sw's
 * igmp_mld_snooping (default: enabled in VLAN 1; '' : not configured).
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
    protocols: {ospf: {}, pim: {${x.r2pim || 'rp: 10.255.0.1'}}}
    interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.2.0.1/24}, {id: g2, ip: 10.0.23.2/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]${x.r2 || ''}
  - id: r3
    type: router
    router_id: 10.255.0.3
    protocols: {ospf: {}, pim: {${x.r2pim || 'rp: 10.255.0.1'}}}
    interfaces: [{id: g0, ip: 10.0.13.2/30}, {id: g1, ip: 10.0.23.1/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.3/32}]
  - {id: sw, type: switch, ${x.snoop !== undefined ? x.snoop : 'igmp_mld_snooping: {1: enabled}, '}interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]${x.sw || ''}}
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
  - {id: o12, protocol: ospf, endpoints: ["r1:g1", "r2:g0"], attrs: {network-type: point-to-point, area: 0, cost: 10}}
  - {id: o13, protocol: ospf, endpoints: ["r1:g2", "r3:g0"], attrs: {network-type: point-to-point, area: 0, cost: 20}}
  - {id: o23, protocol: ospf, endpoints: ["r3:g1", "r2:g2"], attrs: {network-type: point-to-point, area: 0, cost: 20}}
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
  - {id: sw, type: switch, ${x.snoop !== undefined ? x.snoop : 'igmp_mld_snooping: {1: enabled}, '}interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]${x.sw || ''}}
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

test('multicast parameters: the query interval (Layer 3) completes its section; snooping itself is the switch’s configuration, no parameter; the attributes by device type', () => {
  assert.deepEqual(Pm.layerRows(2).length, 7);
  assert.deepEqual(Pm.layerRows(3).length, 8);
  for (const k of ['igmp-snooping', 'unknown-mc']) assert.throws(() => Pm.paramDef(k), /unknown simulation parameter/);
  assert.equal(Pm.formatValue(Pm.paramDef('igmp-query'), Pm.paramDef('igmp-query').dflt), '125 s');
  assert.match(Pm.paramDef('igmp-query').source, /RFC 3376/);
  assert.ok(Pm.paramDef('test-type').options.some((o) => o.value === 'multicast'));
  assert.equal(Pm.formatValue(Pm.paramDef('igmp-unsolicited'), 0), 'by version: v2 10 s, v3 1 s');
  const byType = new Map(Pm.attributesByType().map((x) => [x.type, x.keys]));
  for (const k of ['igmp-version', 'igmp-unsolicited']) assert.ok(byType.get('endpoint').includes(k), k);
  // the querier's settings are an interface's, with a device-wide default; the DR priority an interface's only
  for (const k of ['igmp-querier', 'igmp-query', 'igmp-max-resp', 'igmp-robustness', 'igmp-lmqi', 'spt-switchover']) assert.ok(byType.get('router').includes(k), k);
  assert.ok(!byType.get('router').includes('pim-dr-priority') && Pm.paramDef('pim-dr-priority').level === 'interface');
  // snooping's timers: the switch's; the querier and fast leave per VLAN (snooping itself: igmp_mld_snooping, the switch's configuration)
  for (const k of ['mrouter-aging', 'igmp-query']) assert.ok(byType.get('switch').includes(k), k);
  // (unregistered multicast: an explicit policy per VLAN, only with snooping enabled — not the old global unknown-mc)
  for (const k of ['snoop-querier', 'unregistered-mc', 'fast-leave']) assert.ok(!byType.get('switch').includes(k) && Pm.paramDef(k).level === 'vlan', k);
  assert.deepEqual(Pm.vlanParams().map((p) => p.key), ['snoop-querier', 'unregistered-mc', 'fast-leave']);
  assert.equal(Pm.paramDef('unregistered-mc').dflt, 'router-ports');
  assert.match(Pm.paramDef('unregistered-mc').source, /RFC 4541/);
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
  s.runTo(6000);
  assert.ok(ev(s, (e) => e.device === 'q2' && e.what === 'not querier' && /hears a query from 10\.5\.0\.1 \(lower than its 10\.5\.0\.2\)/.test(e.detail)).length === 1);
  assert.match(s.igmpTable('q2').notes.join(' '), /g0 \(10\.5\.0\.2, 10\.5\.0\.0\/24\): not the querier \(10\.5\.0\.1 \(q1\) queries\)/);
  s.powerOff('q1');
  // robustness 2 × 10 s + 10 s ÷ 2 = 25 s
  s.runTo(s.now + 30000);
  const take = ev(s, (e) => e.device === 'q2' && e.what === 'querier' && /takes over as IGMP querier: no query from 10\.5\.0\.1 \(q1\) for 25 s/.test(e.detail));
  assert.equal(take.length, 1);
  assert.match(s.igmpTable('q2').notes[0], /the querier/);
});

test('IGMP: members answer a general query after a random delay up to the response interval; IGMPv2 hosts suppress their report when another member answered (snooping off)', () => {
  const s = sim(LAN({ snoop: 'igmp_mld_snooping: {1: disabled}, ', h1: ', simulation: {igmp_version: v2}', h2: ', simulation: {igmp_version: v2}' }));
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
  assert.match(v3.detail, /IGMPv3 Report from h1 \(10\.5\.0\.11\) to 224\.0\.0\.22: ALLOW \(232\.9\.9\.9, \{10\.9\.0\.1\}\)/);
  assert.deepEqual([v3.hdr.l4.igmp.version, v3.hdr.l4.igmp.sources], ['IGMPv3', ['10.9.0.1']]);
  const mld = ev(s, (e) => e.device === 'h1' && e.what === 'Report' && /ff05::9/.test(e.detail))[0];
  // (its first Report, at once when its link is up, goes from :: — its link-local address is still tentative: RFC 3590)
  assert.match(mld.detail, /MLDv2 Report from h1 \((::|fe80::[0-9a-f:]+)\) to ff02::16: TO_EX \(ff05::9, \{\}\)/);
  assert.equal(mld.hdr.l4.icmpType, 143);
  // a join is a state change (TO_EX / ALLOW, RFC 3376 §5.1); an answer to a query is the current state (IS_EX / IS_IN)
  s.runTo(40000);
  const answered = ev(s, (e) => e.device === 'h1' && e.what === 'Report' && /answers the general query/.test(e.detail));
  assert.ok(answered.some((e) => /: IS_IN \(232\.9\.9\.9, \{10\.9\.0\.1\}\)/.test(e.detail)), answered.map((e) => e.detail).join(' | '));
  assert.ok(answered.some((e) => /: IS_EX \(ff05::9, \{\}\)/.test(e.detail)));
  assert.ok(!ev(s, (e) => e.device === 'h1' && e.what === 'Report' && /joins \(unsolicited/.test(e.detail)).some((e) => /IS_IN|IS_EX/.test(e.detail)), 'never a current-state record in a join');
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
  // the router port (r2's queries and Hellos), then each group's member port: VLAN, group with its family, port, what it is
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3].split(',')[0]]), [['1', '—', 'p1', 'multicast router port: every group goes there'], ['1', '232.1.1.1 (IGMP)', 'p3', 'member port: IGMPv3'], ['1', '239.1.1.1 (IGMP)', 'p2', 'member port: IGMPv3']]);
  assert.match(rows[1][3], /sources 10\.1\.0\.10, reported by 10\.2\.0\.22$/);
  assert.match(rows[2][3], /any source, reported by 10\.2\.0\.21$/);
  // idle (no member) gets no stream; rxa gets 239.1.1.1 only, rxb 232.1.1.1 only
  const on = (link) => s.engine.flights.filter((f) => f.track.ref === 'link:' + link && f.hdr && f.hdr.l3.length && /^23[29]\./.test(f.hdr.l3[0].dst) && f.protocol === 'mcast').map((f) => f.hdr.l3[0].dst);
  s.runTo(24000);
  assert.deepEqual(on('f'), []);
  assert.ok(on('d').length && on('d').every((g) => g === '239.1.1.1'));
  assert.ok(on('e').length && on('e').every((g) => g === '232.1.1.1'));
  // a report never reaches another host
  assert.ok(!s.engine.flights.some((f) => (f.track.ref === 'link:f' || f.track.ref === 'link:e') && f.protocol === 'igmp' && /Report 239/.test(f.label)));
  assert.match(s.snoopTable('sw').timers.map((t) => `${t.label}: ${t.value}`).join(', '), /^Fast leave: Off, Router port aging: 5 min, Snooping querier: Off$/);
  assert.match(s.snoopTable('sw').notes[0], /^Snooping enabled in VLAN 1: a group goes to its member ports and the router ports; a group without members \(unregistered\) to the router ports only — none there, nowhere \(unregistered_multicast: router-ports, RFC 4541 §2\.1\.2\)\.$/);
});

test('snooping disabled floods every group; not configured floods too and says so; enabled never floods a group without members; fast leave removes a port at once', () => {
  // (the switch's untagged frames are VLAN 1: its VLAN settings are the network's of VLAN 1)
  const lan = (b) => `  - {id: lan, cidr: 10.2.0.0/24, vlan: 1, simulation: ${b}}`;
  const mc = (s, link, after = -1) => s.engine.flights.filter((f) => f.t0 > after && f.track.ref === 'link:' + link && f.protocol === 'mcast');
  const off = sim(NET({ snoop: 'igmp_mld_snooping: {1: disabled}, ' }));
  off.runTo(24000);
  assert.ok(mc(off, 'f').length, 'disabled: idle gets the streams');
  assert.ok(!ev(off, (e) => /not configured/.test(e.detail)).length);
  assert.match(off.snoopTable('sw').notes[0], /^Snooping disabled in VLAN 1: multicast is flooded to every port of the VLAN\.$/);
  assert.deepEqual(off.snoopTable('sw').rows, [], 'nothing learned');
  // not configured: an error of the checks, flooded meanwhile, said in the log (once per 10 s)
  const unset = sim(NET({ snoop: '' }));
  assert.deepEqual(C.runChecks(unset.model).filter((f) => f.check === 'snooping-not-configured').map((f) => [f.severity, f.message]), [['error', 'sw carries VLAN 1 without an IGMP / MLD snooping choice: set igmp_mld_snooping to enabled or disabled for it (until then the simulation floods its multicast, as a switch without snooping)']]);
  unset.runTo(24000);
  assert.ok(mc(unset, 'f').length, 'not configured: flooded');
  assert.ok(ev(unset, (e) => e.device === 'sw' && /^sw floods .* in VLAN 1: its IGMP \/ MLD snooping is not configured there \(a configuration error: choose enabled or disabled\)$/.test(e.detail)).length >= 1);
  assert.match(unset.snoopTable('sw').notes[0], /^Not configured in VLAN 1: a configuration error/);
  // enabled: idle never gets a group's data, from the start (before any member reported) to the end
  const on = sim(NET());
  on.runTo(24000);
  assert.deepEqual(mc(on, 'f'), [], 'enabled: nothing to a host port without a member');
  const s = sim(NET({ nets: lan('{fast_leave: "on"}') }));
  s.runTo(10000);
  s.leaveGroup('rxa', 'eth0', '239.1.1.1');
  s.runTo(s.now + 100);
  assert.ok(ev(s, (e) => e.device === 'sw' && /port p2 leaves 239\.1\.1\.1 in VLAN 1 at once \(fast leave\)/.test(e.detail)).length === 1);
  // the last member gone (expired after the group queries): the group goes to the router port only, never to idle or rxa
  on.leaveGroup('rxa', 'eth0', '239.1.1.1');
  on.runTo(on.now + 300000);
  const t = on.now;
  on.runTo(t + 5000);
  assert.ok(!on.engine.flights.some((f) => f.t0 > t && (f.track.ref === 'link:d' || f.track.ref === 'link:f') && f.protocol === 'mcast' && f.hdr.l3[0].dst === '239.1.1.1'));
});

test('snooping querier: a VLAN without a multicast router is queried by the switch (when on), so that its members are learned', () => {
  const Y = (sim, snoop = 'enabled', svi = true) => `netatlas: 1
title: q
devices:
  - {id: sw, type: switch, igmp_mld_snooping: {1: ${snoop}}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}], logical_interfaces: [{id: Vlan1, type: virtual, vlan: 1${svi ? ', ip: 10.9.0.2/24' : ''}}]${sim}}
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
  assert.match(q[0].detail, /General Query from sw \(snooping querier, 10\.9\.0\.2\) in VLAN 1: which groups have members\?/);
  assert.ok(ev(on, (e) => e.device === 'h1' && /answers the general query of 10\.9\.0\.2/.test(e.detail)).length >= 1);
  assert.ok(on.snoopTable('sw').notes.some((n) => /^VLAN 1 · Querier: the elected IGMP querier of VLAN 1 \(snooping querier, from 10\.9\.0\.2\)/.test(n)), on.snoopTable('sw').notes.join(' | '));
  // the querier needs snooping enabled on the switch, and an address of its own in the VLAN
  const net = 'networks:\n  - {id: v1, cidr: 10.9.0.0/24, vlan: 1, simulation: {snooping_querier: "on"}}\n';
  const dis = sim(Y(', simulation: {igmp_query_interval: 5}', 'disabled') + net);
  dis.runTo(18000);
  assert.ok(!ev(dis, (e) => e.device === 'sw' && e.what === 'Query').length, 'snooping disabled: no querier');
  const noAddr = sim(Y(', simulation: {igmp_query_interval: 5}', 'enabled', false) + net);
  noAddr.runTo(18000);
  assert.ok(!ev(noAddr, (e) => e.device === 'sw' && e.what === 'Query').length, 'no address in the VLAN: no querier');
  assert.ok(ev(noAddr, (e) => e.device === 'sw' && /^sw is no snooping querier candidate in VLAN 1: it has no IPv4 address there \(a VLAN interface\) to query from$/.test(e.detail)).length >= 1);
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
  assert.match(s.mrouteTable('r1').notes[0], /^RP for 239\.1\.1\.1: 10\.255\.0\.1 \(r1\), the static RP of r1$/);
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

test('PIM-SM: after the SPT switchover the RP, its (S, G) left with no outgoing interface and nothing to inherit (the shared tree pruned for S), prunes (S, G) towards the source at once (RFC 7761 §4.5.7) — the first hop stops sending to it; the receiver keeps getting the stream', () => {
  const s = sim(NET({ r1pim: 'rp: 10.255.0.3', r2pim: 'rp: 10.255.0.3' }));
  s.runTo(30000);
  const sw = ev(s, (e) => e.device === 'r2' && e.what === 'SPT switchover')[0];
  assert.ok(sw, 'r2 switched to the source’s tree');
  const rpt = ev(s, (e) => e.device === 'r3' && e.what === 'RPT prune')[0];
  const prune = ev(s, (e) => e.device === 'r3' && e.kind === 'message' && e.what === 'Join/Prune' && /prune \(10\.1\.0\.10, 239\.1\.1\.1\)/.test(e.detail));
  assert.equal(prune.length, 1, 'one Prune(S, G) from the RP towards r1');
  assert.ok(prune[0].t >= rpt.t && prune[0].t - rpt.t < 1, 'when the shared tree was pruned for S, not after a holdtime');
  assert.match(prune[0].detail, /on g0/);
  // r1 sends (S, G) only towards r2 (g1), no more towards the RP (g2); the RP keeps no (S, G)
  const oil = (dev, sg) => (s.mrouteTable(dev).rows.find((r) => r[0] === sg) || [])[2];
  assert.match(oil('r1', '(10.1.0.10, 239.1.1.1)'), /^g1 \(/);
  assert.equal(oil('r3', '(10.1.0.10, 239.1.1.1)'), undefined);
  assert.ok(ev(s, (e) => e.device === 'r1' && e.kind === 'route' && /forwards \(10\.1\.0\.10, 239\.1\.1\.1\) from g0 out of g1 \(/.test(e.detail) && e.t > prune[0].t).length >= 1);
  s.runTo(240000);
  assert.ok(!ev(s, (e) => e.device === 'r1' && e.t > prune[0].t + 1 && /out of g2/.test(e.detail) && /239\.1\.1\.1/.test(e.detail)).length, 'nothing out of g2 afterwards (it no longer waits for the 210 s holdtime)');
  assert.equal(ev(s, (e) => e.device === 'r1' && e.what === 'Register' && e.t > prune[0].t).length, 0, 'no Register again');
  const rx = s.multicastReceived('rxa', '239.1.1.1');
  assert.ok(rx.last > 239000 && rx.count > 220, JSON.stringify(rx));
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
  - {id: ap, type: ap, services: {wireless: {networks: [{id: lan, ssid: LAN, untagged: true, radio: w1, security: open}]}}, interfaces: [up, ${m2u ? '{id: w1, simulation: {multicast_to_unicast: "on"}}' : 'w1'}, w2]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: phone, type: endpoint, interfaces: [{id: wlan0, ip: 10.6.0.21/24, multicast: {join: [239.6.6.6]}}]}
links:
  - {id: a, a: "q:g0", b: "sw:p1"}
  - {id: b, a: "src:eth0", b: "sw:p2"}
  - {id: c, a: "sw:p3", b: "ap:up"}
  - {id: air, a: "ap:w1", b: "phone:wlan0", medium: wireless, wireless_network: lan}
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

// ------------------------------------------------------------------ the RP in each router's own context

test('RP: conflicting static RPs stay each router’s own (no global winner); their trees do not meet, the receivers get nothing, and the log says so', () => {
  // r1 says it is the RP itself; r2 and r3 say r3 is
  const s = sim(NET({ r1pim: 'rp: 10.255.0.1', r2pim: 'rp: 10.255.0.3' }));
  s.runTo(40000);
  assert.equal(s.multicast.rp('r1', '239.1.1.1').dev, 'r1');
  assert.equal(s.multicast.rp('r2', '239.1.1.1').dev, 'r3');
  assert.ok(s.events().some((e) => /PIM: r1's RP is 10\.255\.0\.1 \(its static RP\), r[23]'s is 10\.255\.0\.3 \(its static RP\): they disagree in one PIM domain/.test(e.detail)));
  assert.notEqual(status(s, 'rxa member of 239.1.1.1').state, 'Receiving');
  // the source-specific group does not need an RP: it still arrives
  assert.equal(status(s, 'rxb member of 232.1.1.1 (10.1.0.10)').state, 'Receiving');
});

const ISLANDS = (a = 'a', b = 'b') => `netatlas: 1
title: islands
devices:
  - {id: ${a}1, type: router, router_id: 10.255.0.9, protocols: {pim: {candidate_rp: "yes"}}, interfaces: [{id: g0, ip: 10.9.0.1/30}, {id: g1, ip: 2001:db8:9::1/64}]}
  - {id: ${a}2, type: router, router_id: 10.255.0.8, protocols: {pim: {}}, interfaces: [{id: g0, ip: 10.9.0.2/30}]}
  - {id: ${b}1, type: router, router_id: 10.255.0.1, protocols: {pim: {candidate_rp: "yes"}}, interfaces: [{id: g0, ip: 10.1.0.1/30}], logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]}
  - {id: ${b}2, type: router, router_id: 10.255.0.2, protocols: {pim: {rp: 10.255.0.1}}, interfaces: [{id: g0, ip: 10.1.0.2/30}, {id: g1, ip: 2001:db8:1::1/64}]}
links:
  - {id: la, a: "${a}1:g0", b: "${a}2:g0"}
  - {id: lb, a: "${b}1:g0", b: "${b}2:g0"}
relations:
  - {id: pa, protocol: pim, endpoints: ["${a}1:g0", "${a}2:g0"]}
  - {id: pb, protocol: pim, endpoints: ["${b}1:g0", "${b}2:g0"]}
`;

test('RP: independent PIM domains never take each other’s candidate RP; device IDs decide nothing; an IPv4 RP serves no IPv6 group', () => {
  const s = sim(ISLANDS());
  s.runTo(40000);
  // a2 learns its own domain's candidate (a1) from its Bootstraps, although b1 sorts first and the bootstrap of b would win a global election
  assert.equal(s.multicast.rp('a2', '239.1.1.1').dev, 'a1');
  assert.equal(s.multicast.rp('b1', '239.1.1.1').dev, 'b1');
  assert.equal(s.multicast.rp('b2', '239.1.1.1').how, 'the static RP of b2');
  // renamed (b's routers now sort first): the same choices
  const r = sim(ISLANDS('z', 'c'));
  r.runTo(40000);
  assert.equal(r.multicast.rp('z2', '239.1.1.1').dev, 'z1');
  assert.equal(r.multicast.rp('c2', '239.1.1.1').dev, 'c1');
  // IPv6: b2's static RP is IPv4 (no RP for ff0e::1 from it), and b1 has no IPv6 address to be one
  assert.equal(s.multicast.rp('b2', 'ff0e::1'), null);
  assert.ok(s.events().some((e) => /b2's static RP 10\.255\.0\.1 is IPv4: no RP for its IPv6 groups from it/.test(e.detail)));
  // a1 has an IPv6 address: it is its domain's IPv6 candidate RP too
  assert.equal(s.multicast.rp('a2', 'ff0e::1').dev, 'a1');
});

test('RP discovery follows the Bootstraps: none before the first arrives; a silent candidate is kept until its holdtime, then dropped (no reading of its power state)', () => {
  const s = sim(ISLANDS());
  s.runTo(1500);
  assert.equal(s.multicast.rp('a2', '239.1.1.1'), null, 'no Bootstrap yet: no RP known');
  s.runTo(40000);
  assert.equal(s.multicast.rp('a2', '239.1.1.1').dev, 'a1');
  assert.ok(s.events().some((e) => e.kind === 'table' && e.device === 'a2' && e.what === 'RP set' && /learns candidate RP a1 \(router ID 10\.255\.0\.9\) from a Bootstrap, for 150 s/.test(e.detail)));
  const last = s.events().filter((e) => e.kind === 'message' && e.what === 'Bootstrap' && e.device === 'a1').slice(-1)[0];
  s.powerOff('a1');
  const off = s.now;
  s.runTo(off + 30000);
  assert.equal(s.multicast.rp('a2', '239.1.1.1').dev, 'a1', 'stale: still the candidate it last heard of');
  s.runTo(last.t + 150000 + 1000);
  assert.equal(s.multicast.rp('a2', '239.1.1.1'), null, 'its holdtime ran out');
  assert.ok(s.events().some((e) => e.kind === 'table' && e.device === 'a2' && e.what === 'RP expired'));
});

test('MLD: from the link-local address once it is valid (:: before), with the Router Alert option and hop limit 1; a router ignores MLD from a global source', () => {
  const s = sim(LAN({ h1j: ', multicast: {join: ["ff05::9"]}', q1: ', simulation: {igmp_query_interval: 10}' }));
  s.runTo(40000);
  const mld = ev(s, (e) => e.kind === 'message' && e.protocol === 'igmp' && e.hdr && e.hdr.l3.length && e.hdr.l3[0].version === 6);
  assert.ok(mld.length >= 3);
  for (const e of mld) {
    const ip = e.hdr.l3[0];
    assert.ok(/^fe80::/.test(ip.src) || ip.src === '::', `${e.what} from ${ip.src}`);
    assert.equal(ip.ttl, 1);
    assert.equal(ip.options, 'Hop-by-Hop: Router Alert (MLD)');
  }
  // the router's queries are from its link-local address, and later reports from the host's
  assert.ok(mld.some((e) => e.what === 'Query' && /^fe80::/.test(e.hdr.l3[0].src)));
  assert.ok(mld.some((e) => e.what === 'Report' && e.device === 'h1' && /^fe80::/.test(e.hdr.l3[0].src)));
  // the lengths follow the version: an MLDv2 Report with one record and no sources 28 bytes (+ 8 of Hop-by-Hop after the 40)
  const rep = mld.find((e) => e.what === 'Report' && e.device === 'h1');
  assert.equal(rep.hdr.l3[0].len, 40 + 8 + 28);
  const q = mld.find((e) => e.what === 'Query');
  assert.equal(q.hdr.l3[0].len, 40 + 8 + 28, 'an MLDv2 General Query: 28 bytes');
  // IGMPv3: a Report 8 + 8 per record + 4 per source; the Router Alert option is 4 bytes of the IPv4 header
  const v4 = ev(s, (e) => e.kind === 'message' && e.protocol === 'igmp' && e.hdr && e.hdr.l3.length && e.hdr.l3[0].version === 4);
  for (const e of v4) assert.equal(e.hdr.l3[0].options, 'Router Alert (option 20)');
  // a report from a global source is ignored by the router (RFC 3810 §5)
  const P = s.protocols;
  const ip = load('model/ip.js');
  const n = s.events().length;
  const pkt = s.engine.newPacket(ip.parseAddress('2001:db8:5::11'), ip.parseAddress('ff02::16'), '', { protocol: 'igmp', type: 'Report', label: 'MLD Report ff05::7', detail: '', data: { from: 'h1', group: 'ff05::7' } }, [], 1);
  pkt.routerAlert = true;
  pkt.l4 = { proto: 'icmp', num: 58, icmpType: 143, icmpCode: 0, icmpName: 'MLD Report', igmp: { type: 'Membership Report', version: 'MLDv2', group: 'ff05::7' } };
  P.handlers.get('igmp')('q1', s.engine.net.devices.get('q1').l3.get('g0'), pkt.msg, pkt);
  assert.ok(s.events().slice(n).some((e) => e.kind === 'drop' && /source 2001:db8:5::11 is not link-local/.test(e.detail)));
  assert.ok(!s.igmpTable('q1').rows.some((r) => r[1] === 'ff05::7'));
});

// ------------------------------------------------------------------ IGMPv3 source state (RFC 3376 §6.4)

/** s1 (10.1.0.10) and s2 (10.1.0.11) both stream 232.1.1.1; r1 — r2 (PIM, SSM); rxa joins (G, s1); rxb nothing yet */
const SSM2 = `netatlas: 1
title: ssm two sources
devices:
  - id: s1
    type: server
    interfaces: [{id: eth0, ip: 10.1.0.10/24, multicast: {streams: [{group: 232.1.1.1, port: 5006, interval: 1s}]}}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: s2
    type: server
    interfaces: [{id: eth0, ip: 10.1.0.11/24, multicast: {streams: [{group: 232.1.1.1, port: 5006, interval: 1s}]}}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - {id: swa, type: switch, igmp_mld_snooping: {1: disabled}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: r1
    type: router
    router_id: 10.255.0.1
    protocols: {ospf: {}, pim: {}}
    interfaces: [{id: g0, ip: 10.1.0.1/24}, {id: g1, ip: 10.0.12.1/30}]
  - id: r2
    type: router
    router_id: 10.255.0.2
    protocols: {ospf: {}, pim: {}}
    interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.2.0.1/24}]
  - {id: sw, type: switch, igmp_mld_snooping: {1: disabled}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: rxa
    type: endpoint
    interfaces: [{id: eth0, ip: 10.2.0.21/24, multicast: {join: [{group: 232.1.1.1, sources: [10.1.0.10]}]}}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
  - id: rxb
    type: endpoint
    interfaces: [{id: eth0, ip: 10.2.0.22/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
links:
  - {id: a1, a: "s1:eth0", b: "swa:p1"}
  - {id: a2, a: "s2:eth0", b: "swa:p2"}
  - {id: a3, a: "swa:p3", b: "r1:g0"}
  - {id: b, a: "r1:g1", b: "r2:g0"}
  - {id: c, a: "r2:g1", b: "sw:p1"}
  - {id: d, a: "sw:p2", b: "rxa:eth0"}
  - {id: e, a: "sw:p3", b: "rxb:eth0"}
relations:
  - {id: o12, protocol: ospf, endpoints: ["r1:g1", "r2:g0"], attrs: {network-type: point-to-point, area: 0}}
  - {id: p12, protocol: pim, endpoints: ["r1:g1", "r2:g0"]}
`;

test('IGMPv3 sources: a second source on a group already known is joined (its own (S, G) out of the interface, delivered to its member); BLOCK of one source removes that source only — its (S, G) leaves the interface and is pruned upstream, the other source keeps flowing', () => {
  const s = sim(SSM2);
  const mroutes = (dev) => s.mrouteTable(dev).rows.map((r) => `${r[0]} out ${r[2]}`);
  const oil = (dev, sg) => (s.mrouteTable(dev).rows.find((r) => r[0] === sg) || [])[2];
  s.runTo(90000);
  assert.deepEqual(mroutes('r2'), ['(10.1.0.10, 232.1.1.1) out g1 (members)']);
  // rxb joins (G, s2): an ALLOW record for a group r2 already has
  assert.equal(s.joinGroup('rxb', 'eth0', '232.1.1.1', ['10.1.0.11']), null);
  s.runTo(100000);
  const allow = ev(s, (e) => e.device === 'rxb' && e.what === 'Report' && e.t >= 90000)[0];
  assert.match(allow.detail, /: ALLOW \(232\.1\.1\.1, \{10\.1\.0\.11\}\), joins \(unsolicited\)/);
  assert.ok(ev(s, (e) => e.device === 'r2' && e.what === 'source added' && /232\.1\.1\.1 has a member for 10\.1\.0\.11 too/.test(e.detail)).length === 1);
  assert.deepEqual(mroutes('r2'), ['(10.1.0.10, 232.1.1.1) out g1 (members)', '(10.1.0.11, 232.1.1.1) out g1 (members)']);
  s.runTo(150000);
  const rb = s.multicastReceived('rxb', '232.1.1.1');
  assert.ok(rb && rb.count > 40, `rxb receives s2: ${JSON.stringify(rb)}`);
  assert.match(oil('r1', '(10.1.0.11, 232.1.1.1)'), /^g1 /, 's2 goes down to r2 (r1 joined by r2)');
  // rxa leaves (BLOCK {s1}): after the last member queries s1 goes from r2:g1 and r2 prunes it upstream; s2 stays
  assert.equal(s.leaveGroup('rxa', 'eth0', '232.1.1.1'), true);
  const t0 = s.now;
  s.runTo(t0 + 10000);
  const block = ev(s, (e) => e.device === 'rxa' && e.what === 'Report' && e.t >= t0)[0];
  assert.match(block.detail, /: BLOCK \(232\.1\.1\.1, \{10\.1\.0\.10\}\)/);
  const gone = ev(s, (e) => e.device === 'r2' && e.t >= t0 && e.what === 'source expired')[0];
  assert.ok(gone && gone.t - t0 <= 2100, 'after robustness × the last member query interval');
  assert.match(gone.detail, /no member for 10\.1\.0\.10 any more .*still for 10\.1\.0\.11/);
  assert.deepEqual(s.igmpTable('r2').rows.map((r) => r[4]), ['10.1.0.11']);
  assert.deepEqual(mroutes('r2'), ['(10.1.0.11, 232.1.1.1) out g1 (members)']);
  assert.ok(ev(s, (e) => e.device === 'r2' && e.t >= t0 && e.what === 'pruned' && /\(10\.1\.0\.10, 232\.1\.1\.1\)/.test(e.detail)).length === 1, 'pruned towards r1');
  s.runTo(t0 + 60000);
  assert.equal(oil('r1', '(10.1.0.10, 232.1.1.1)'), 'none', 'r1 sends s1 to r2 no more');
  assert.match(oil('r1', '(10.1.0.11, 232.1.1.1)'), /^g1 /, 's2 still flows');
  assert.equal(s.multicastReceived('rxa', '232.1.1.1').last < t0 + 3000, true, 'rxa gets nothing after it left');
  const rb2 = s.multicastReceived('rxb', '232.1.1.1');
  assert.ok(rb2.last > t0 + 55000);
});

test('IGMPv3: a BLOCK naming only sources the router does not know (RFC 3376 §6.4.2: INCLUDE(A) + BLOCK(B) queries A*B — empty) changes nothing: the known source’s timer stays, no group-specific query; even with the member’s answers lost, rxa keeps receiving', () => {
  const s = sim(SSM2);
  s.runTo(90000);
  // rxb's reports never reach r2: its join of (G, s2) is unknown there
  s.engine.impair = (link, f) => (f.msg.protocol === 'igmp' && f.msg.type === 'Report' && (f.msg.data || {}).from === 'rxb' && !(f.msg.data || {}).leave ? { lose: true } : null);
  assert.equal(s.joinGroup('rxb', 'eth0', '232.1.1.1', ['10.1.0.11']), null);
  s.runTo(100000);
  assert.deepEqual(s.igmpTable('r2').rows.map((r) => r[4]), ['10.1.0.10'], 'r2 knows s1 only');
  // rxb leaves: a BLOCK {s2} that does reach r2; rxa's answers lost from now on
  s.engine.impair = (link, f) => (f.msg.protocol === 'igmp' && f.msg.type === 'Report' && (f.msg.data || {}).from === 'rxa' ? { lose: true } : null);
  assert.equal(s.leaveGroup('rxb', 'eth0', '232.1.1.1'), true);
  const t0 = s.now;
  s.runTo(t0 + 10000);
  assert.ok(ev(s, (e) => e.device === 'rxb' && e.what === 'Report' && e.t >= t0 && /BLOCK \(232\.1\.1\.1, \{10\.1\.0\.11\}\)/.test(e.detail)).length === 1, 'the BLOCK was sent');
  assert.equal(ev(s, (e) => e.device === 'r2' && e.t >= t0 && e.what === 'Query' && /232\.1\.1\.1/.test(e.detail)).length, 0, 'no group-specific query');
  assert.equal(ev(s, (e) => e.device === 'r2' && e.t >= t0 && /expired/.test(e.what)).length, 0, 'nothing expired');
  assert.deepEqual(s.igmpTable('r2').rows.map((r) => r[4]), ['10.1.0.10']);
  s.engine.impair = null;
  s.runTo(t0 + 30000);
  const ra = s.multicastReceived('rxa', '232.1.1.1');
  assert.ok(ra && ra.last > t0 + 25000, 'rxa still receives s1');
});

// ------------------------------------------------------------------ members of named sources and members of every source on one LAN

/**
 * s1, s2 (one LAN) — r1 (its own RP) — sw (snooping disabled: every host sees what r1 forwards) — rxa, rxb, rxc, which join
 * by events; an ordinary ASM group (239.5.5.5, or ff0e::1:1 with MLD).
 */
const MIX = (v6) => {
  const a = v6
    ? { s1: '2001:db8:1::10/64', s2: '2001:db8:1::11/64', g0: '2001:db8:1::1/64', g1: '2001:db8:2::1/64', lo: '2001:db8:ff::1/128', rp: '2001:db8:ff::1', ra: '2001:db8:2::21/64', rb: '2001:db8:2::22/64', rc: '2001:db8:2::23/64', d: '::/0', v1: '2001:db8:1::1', v2: '2001:db8:2::1', G: 'ff0e::1:1' }
    : { s1: '10.1.0.10/24', s2: '10.1.0.11/24', g0: '10.1.0.1/24', g1: '10.2.0.1/24', lo: '10.255.0.1/32', rp: '10.255.0.1', ra: '10.2.0.21/24', rb: '10.2.0.22/24', rc: '10.2.0.23/24', d: '0.0.0.0/0', v1: '10.1.0.1', v2: '10.2.0.1', G: '239.5.5.5' };
  return `netatlas: 1
title: mixed members
devices:
  - {id: s1, type: server, interfaces: [{id: eth0, ip: "${a.s1}", multicast: {streams: [{group: "${a.G}", port: 5006, interval: 1s}]}}], routes: [{prefix: "${a.d}", via: "${a.v1}"}]}
  - {id: s2, type: server, interfaces: [{id: eth0, ip: "${a.s2}", multicast: {streams: [{group: "${a.G}", port: 5006, interval: 1s}]}}], routes: [{prefix: "${a.d}", via: "${a.v1}"}]}
  - {id: swa, type: switch, igmp_mld_snooping: {1: disabled}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: r1
    type: router
    router_id: 10.255.0.1
    protocols: {pim: {rp: "${a.rp}"}}
    interfaces: [{id: g0, ip: "${a.g0}"}, {id: g1, ip: "${a.g1}"}]
    logical_interfaces: [{id: lo0, type: loopback, ip: "${a.lo}"}]
  - {id: sw, type: switch, igmp_mld_snooping: {1: disabled}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
  - {id: rxa, type: endpoint, interfaces: [{id: eth0, ip: "${a.ra}"}], routes: [{prefix: "${a.d}", via: "${a.v2}"}]}
  - {id: rxb, type: endpoint, interfaces: [{id: eth0, ip: "${a.rb}"}], routes: [{prefix: "${a.d}", via: "${a.v2}"}]}
  - {id: rxc, type: endpoint, interfaces: [{id: eth0, ip: "${a.rc}"}], routes: [{prefix: "${a.d}", via: "${a.v2}"}]}
links:
  - {id: a1, a: "s1:eth0", b: "swa:p1"}
  - {id: a2, a: "s2:eth0", b: "swa:p2"}
  - {id: a3, a: "swa:p3", b: "r1:g0"}
  - {id: c, a: "r1:g1", b: "sw:p1"}
  - {id: d, a: "sw:p2", b: "rxa:eth0"}
  - {id: e, a: "sw:p3", b: "rxb:eth0"}
  - {id: f, a: "sw:p4", b: "rxc:eth0"}
`;
};
const FAM = [
  { v6: false, G: '239.5.5.5', S1: '10.1.0.10', S2: '10.1.0.11' },
  { v6: true, G: 'ff0e::1:1', S1: '2001:db8:1::10', S2: '2001:db8:1::11' },
];
/** How many of a source device's stream datagrams a host has taken so far. */
const got = (s, from, rx) => s.multicast.streams.filter((x) => x.dev === from).reduce((n, x) => n + (x.rx.get(rx) || 0), 0);
/** What each receiver takes of each source in the next `ms`: {rxa: [from s1, from s2], …}. */
const window = (s, ms) => {
  const before = {};
  for (const r of ['rxa', 'rxb', 'rxc']) before[r] = [got(s, 's1', r), got(s, 's2', r)];
  s.runTo(s.now + ms);
  const out = {};
  for (const r of ['rxa', 'rxb', 'rxc']) out[r] = [got(s, 's1', r) - before[r][0], got(s, 's2', r) - before[r][1]];
  return out;
};
/** r1's row of the group on g1 (its sources column), and whether its (*, G) and each source's (S, G) go out of g1. */
const r1State = (s, f) => {
  const row = s.igmpTable('r1').rows.find((r) => r[0] === 'g1' && r[1] === f.G);
  const mr = s.mrouteTable('r1').rows;
  const out = (src) => mr.some((r) => r[0] === `(${src}, ${f.G})` && /g1/.test(r[2]));
  return { sources: row ? row[4] : null, star: out('*'), s1: out(f.S1), s2: out(f.S2) };
};

test('IGMPv3 / MLDv2, a member of one source and a member of every source on one LAN (RFC 3376 §6.4.1, RFC 3810 §7.4.1: INCLUDE + IS_EX {} → EXCLUDE {}): every source is forwarded, whichever joined first; the source-filtered member still takes only its source', () => {
  for (const f of FAM) {
    for (const order of [['rxa', 'rxb'], ['rxb', 'rxa']]) {
      const s = sim(MIX(f.v6));
      s.runTo(20000);
      for (const who of order) {
        assert.equal(s.joinGroup(who, 'eth0', f.G, who === 'rxa' ? [f.S1] : []), null);
        s.runTo(s.now + 10000);
      }
      const tag = `${f.v6 ? 'MLDv2' : 'IGMPv3'}, ${order.join(' then ')}`;
      // (the shared tree's (*, G) carries every source out of g1: r1, the RP, forwards s1 and s2 by it)
      const st = r1State(s, f);
      assert.deepEqual([st.sources, st.star], [`any (also named: ${f.S1})`, true], tag);
      const w = window(s, 10000);
      assert.ok(w.rxb[0] >= 9 && w.rxb[1] >= 9, `${tag}: rxb takes s1 and s2 (${w.rxb})`);
      assert.ok(w.rxa[0] >= 9 && w.rxa[1] === 0, `${tag}: rxa takes s1 only (${w.rxa})`);
    }
  }
});

test('IGMPv3 / MLDv2, mixed members leaving: the member of every source leaving — after the group-specific queries only the named source goes out (s2 no more); the member of one source leaving — every source still goes out, nothing expires', () => {
  for (const f of FAM) {
    const tag = f.v6 ? 'MLDv2' : 'IGMPv3';
    // rxb (every source) leaves; rxa (s1) answers the queries
    let s = sim(MIX(f.v6));
    s.runTo(20000);
    s.joinGroup('rxa', 'eth0', f.G, [f.S1]);
    s.joinGroup('rxb', 'eth0', f.G, []);
    s.runTo(40000);
    assert.equal(s.leaveGroup('rxb', 'eth0', f.G), true);
    s.runTo(s.now + 5000);
    assert.deepEqual(r1State(s, f), { sources: f.S1, star: false, s1: true, s2: false }, `${tag}: back to s1 only`);
    let w = window(s, 10000);
    assert.ok(w.rxa[0] >= 9, `${tag}: rxa keeps s1 (${w.rxa})`);
    assert.equal(w.rxc[1] + w.rxb[1], 0);
    assert.equal(ev(s, (e) => e.device === 'r1' && e.what === 'membership expired').length, 0, `${tag}: the group stays`);
    // rxa (s1) leaves with a BLOCK {s1}; rxb (every source) stays
    s = sim(MIX(f.v6));
    s.runTo(20000);
    s.joinGroup('rxa', 'eth0', f.G, [f.S1]);
    s.joinGroup('rxb', 'eth0', f.G, []);
    s.runTo(40000);
    const t0 = s.now;
    assert.equal(s.leaveGroup('rxa', 'eth0', f.G), true);
    s.runTo(t0 + 5000);
    assert.ok(ev(s, (e) => e.device === 'rxa' && e.what === 'Report' && e.t >= t0 && /BLOCK/.test(e.detail)).length === 1, `${tag}: rxa's BLOCK`);
    w = window(s, 30000);
    assert.ok(w.rxb[0] >= 29 && w.rxb[1] >= 29, `${tag}: rxb keeps s1 and s2 (${w.rxb})`);
    assert.equal(ev(s, (e) => e.device === 'r1' && e.t >= t0 && e.what === 'membership expired').length, 0, `${tag}: no membership expired`);
    assert.deepEqual([r1State(s, f).sources, r1State(s, f).star], ['any', true], `${tag}: s1 no longer named`);
  }
});

test('IGMPv3 / MLDv2: a named source whose timer runs out while a member of every source remains (its member’s reports lost) — the group stays and every source keeps going out; several members of the same source: one leaving keeps it', () => {
  for (const f of FAM) {
    const tag = f.v6 ? 'MLDv2' : 'IGMPv3';
    const s = sim(MIX(f.v6));
    s.runTo(20000);
    s.joinGroup('rxa', 'eth0', f.G, [f.S1]);
    s.joinGroup('rxb', 'eth0', f.G, []);
    s.runTo(30000);
    // rxa's reports never reach r1 from now on: s1's source timer runs out (the membership interval, 260 s)
    s.engine.impair = (link, fr) => (fr.msg.protocol === 'igmp' && fr.msg.type === 'Report' && (fr.msg.data || {}).from === 'rxa' ? { lose: true } : null);
    const t0 = s.now;
    const w = window(s, 300000);
    assert.ok(ev(s, (e) => e.device === 'r1' && e.t >= t0 && e.what === 'source expired').length >= 1, `${tag}: s1's timer ran out`);
    assert.equal(ev(s, (e) => e.device === 'r1' && e.t >= t0 && e.what === 'membership expired').length, 0, `${tag}: the group never expired`);
    assert.ok(w.rxb[0] >= 299 && w.rxb[1] >= 299, `${tag}: rxb took every datagram of s1 and s2 (${w.rxb})`);
    const st = r1State(s, f);
    assert.deepEqual([st.sources, st.star], ['any', true], tag);
    s.engine.impair = null;
    // rxa and rxc both members of s1, rxb of every source; rxb leaves, then rxa: rxc keeps s1
    const m = sim(MIX(f.v6));
    m.runTo(20000);
    m.joinGroup('rxa', 'eth0', f.G, [f.S1]);
    m.joinGroup('rxc', 'eth0', f.G, [f.S1]);
    m.joinGroup('rxb', 'eth0', f.G, []);
    m.runTo(40000);
    m.leaveGroup('rxb', 'eth0', f.G);
    m.runTo(m.now + 5000);
    m.leaveGroup('rxa', 'eth0', f.G);
    m.runTo(m.now + 5000);
    assert.deepEqual(r1State(m, f), { sources: f.S1, star: false, s1: true, s2: false }, `${tag}: s1 only, still`);
    const w2 = window(m, 10000);
    assert.ok(w2.rxc[0] >= 9 && w2.rxc[1] === 0, `${tag}: rxc keeps s1 (${w2.rxc})`);
  }
});

test('an IPv6 stream to a routable group goes from the interface’s global address, not its link-local one (RFC 6724 §5 rule 2; a link-local source is never routed, RFC 4291 §2.5.6): r1 routes it and a member behind it receives it; its MLD reports still go from the link-local address', () => {
  const s = sim(MIX(true));
  s.runTo(20000);
  assert.equal(s.joinGroup('rxb', 'eth0', 'ff0e::1:1', []), null);
  s.runTo(30000);
  const sent = ev(s, (e) => e.kind === 'message' && e.device === 's1' && e.protocol === 'mcast' && e.hdr && e.hdr.l3);
  assert.ok(sent.length >= 1 && sent.every((e) => e.hdr.l3[0].src === '2001:db8:1::10'), sent.slice(0, 2).map((e) => e.hdr.l3[0].src).join(', '));
  assert.ok(got(s, 's1', 'rxb') >= 9 && got(s, 's2', 'rxb') >= 9, `${got(s, 's1', 'rxb')}, ${got(s, 's2', 'rxb')}`);
  assert.equal(ev(s, (e) => e.kind === 'drop' && e.device === 'r1' && /no state for \(fe80::/.test(e.detail)).length, 0);
  const rep = ev(s, (e) => e.kind === 'message' && e.device === 'rxb' && e.what === 'Report' && e.hdr && e.hdr.l3);
  assert.ok(rep.length && rep.every((e) => /^fe80:|^::$/.test(e.hdr.l3[0].src)), rep.map((e) => e.hdr.l3[0].src).join(', '));
});
