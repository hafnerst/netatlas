// IGMP / MLD snooping as a switch's own configuration (model/snooping.ts,
// validation/snooping.ts) and its forwarding in the simulation
// (analysis/sim/multicast.ts), without a browser: the format (a choice per
// VLAN, ranges, only switches, enabled / disabled, never twice) and the
// check for a switched VLAN without a choice; enabled: a group's data only
// to the ports where a member of that group reported it in that VLAN, never
// flooded when nobody did, never back out of its ingress port; reports only
// to the router ports, queries flooded; join, refresh, leave, expiry, a link
// down, a new simulation; IPv6 (MLD); snooping apart from multicast routing
// on a Layer 3 switch; the private house's IoT VLAN, before and after the
// TV joins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, validate, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/checks.js');
const Sn = load('model/snooping.js');

const sim = (text, opts) => withClock(new S.Simulation(model(text), opts));
const ev = (s, f) => s.events().filter(f);
/** The data flights of a group on a link (physical view), after a time. */
const data = (s, link, group, after = -1) => s.engine.flights.filter((f) => f.t0 > after && f.view === 'physical' && f.track.ref === 'link:' + link && f.protocol === 'mcast' && f.hdr && f.hdr.l3.length && f.hdr.l3[0].dst === group);

/**
 * A Layer 3 switch sw (no PIM unless `pim`), VLAN 10 and 20 with a VLAN
 * interface each, the snooping querier in both; h1, h2 and src in VLAN 10
 * (IPv4 and IPv6), h3 and src20 in VLAN 20. src sends 239.1.1.1 and
 * 239.1.1.2, src20 239.1.1.1, each once a second (the model's streams).
 */
const LAB = (x = {}) => `netatlas: 2
title: snooping
devices:
  - id: sw
    type: switch
    layer3: true
    ${x.snoop !== undefined ? x.snoop : 'igmp_mld_snooping: {10: enabled, 20: enabled}'}
    simulation: {igmp_query_interval: ${x.query || 125}}${x.pim ? '\n    protocols: {pim: {mode: dense}}' : ''}
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 20}, {id: p4, vlans: 10}, {id: p5, vlans: 20}]
    logical_interfaces:
      - {id: Vlan10, type: virtual, vlan: 10, ip: [10.10.0.1/24, "2001:db8:10::1/64"]}
      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.20.0.1/24}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: [10.10.0.11/24, "2001:db8:10::11/64"]}], routes: [{prefix: 0.0.0.0/0, via: 10.10.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: [10.10.0.12/24, "2001:db8:10::12/64"]}], routes: [{prefix: 0.0.0.0/0, via: 10.10.0.1}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.20.0.13/24}], routes: [{prefix: 0.0.0.0/0, via: 10.20.0.1}]}
  - id: src
    type: server
    interfaces:
      - {id: eth0, ip: [10.10.0.20/24, "2001:db8:10::20/64"], multicast: {streams: [{group: 239.1.1.1, interval: 1s}, {group: 239.1.1.2, port: 5006, interval: 1s}${x.v6 ? ', {group: "ff05::1", port: 5008, interval: 1s}' : ''}]}}
    routes: [{prefix: 0.0.0.0/0, via: 10.10.0.1}]
  - {id: src20, type: server, interfaces: [{id: eth0, ip: 10.20.0.20/24, multicast: {streams: [{group: 239.1.1.1, port: 5010, interval: 1s}]}}], routes: [{prefix: 0.0.0.0/0, via: 10.20.0.1}]}
links:
  - {id: l1, a: "h1:eth0", b: "sw:p1"}
  - {id: l2, a: "h2:eth0", b: "sw:p2"}
  - {id: l3, a: "h3:eth0", b: "sw:p3"}
  - {id: l4, a: "src:eth0", b: "sw:p4"}
  - {id: l5, a: "src20:eth0", b: "sw:p5"}
networks:
  - {id: v10, cidr: 10.10.0.0/24, vlan: 10, simulation: {snooping_querier: "on"}}
  - {id: v20, cidr: 10.20.0.0/24, vlan: 20, simulation: {snooping_querier: "on"}}
`;

// ------------------------------------------------------------------ the format and the check

test('the format: igmp_mld_snooping is a switch’s choice per VLAN or range, enabled or disabled, once; elsewhere or otherwise an error', () => {
  const errs = (snoop, type = 'switch') => validate.loadModel(`netatlas: 2\ntitle: t\ndevices:\n  - {id: s, type: ${type}, ${snoop}, interfaces: [{id: p1, vlans: [10, 20, 30-32]}]}\n`).errors.map((e) => e.message);
  const ok = validate.loadModel(`netatlas: 2\ntitle: t\ndevices:\n  - {id: s, type: switch, igmp_mld_snooping: {10: enabled, 20: disabled, 30-32: enabled}, interfaces: [{id: p1, vlans: [10, 20, 30-32]}]}\n`);
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  const d = ok.model.devices[0];
  assert.deepEqual(d.snooping, [{ from: 10, to: 10, enabled: true }, { from: 20, to: 20, enabled: false }, { from: 30, to: 32, enabled: true }]);
  assert.deepEqual([10, 20, 31, 40].map((v) => Sn.snoopingChoice(d, v)), ['enabled', 'disabled', 'enabled', 'unset']);
  assert.deepEqual(Sn.switchedVlans(d), [10, 20, 30, 31, 32]);
  assert.match(errs('igmp_mld_snooping: {10: on}').join('|'), /IGMP \/ MLD snooping of VLAN 10 is "on": write enabled or disabled/);
  assert.match(errs('igmp_mld_snooping: {5000: enabled}').join('|'), /"5000" is not a VLAN ID or range/);
  assert.match(errs('igmp_mld_snooping: {10-20: enabled, 20: disabled}').join('|'), /VLAN 20 is chosen twice in igmp_mld_snooping of "s"/);
  assert.match(errs('igmp_mld_snooping: [10]').join('|'), /expected a mapping/);
  assert.match(errs('igmp_mld_snooping: {10: enabled}', 'router').join('|'), /igmp_mld_snooping is a switch's setting \(IGMP \/ MLD snooping per VLAN\); "s" is a Router — delete it/);
  // a choice for a VLAN no switch port carries does nothing: a warning
  const w = validate.loadModel(`netatlas: 2\ntitle: t\ndevices:\n  - {id: s, type: switch, igmp_mld_snooping: {10: enabled, 99: disabled}, interfaces: [{id: p1, vlans: 10}]}\n`);
  assert.deepEqual(w.warnings.map((x) => x.message), ['VLAN 99 is on none of the switch ports of "s": its IGMP / MLD snooping setting there does nothing']);
});

test('the check: every VLAN a switch carries on its ports needs a choice (an error until chosen); its VLAN interface alone or a routed port needs none', () => {
  const find = (snoop) => C.runChecks(model(`netatlas: 2\ntitle: t\ndevices:\n  - {id: s, type: switch, layer3: true, ${snoop}interfaces: [{id: p1, vlans: [10, 20]}, {id: p2, vlans: 30}, {id: p3, routed: true, ip: 10.9.9.1/30}], logical_interfaces: [{id: Vlan40, type: virtual, vlan: 40, ip: 10.4.0.1/24}]}\n`)).filter((f) => f.check === 'snooping-not-configured');
  assert.deepEqual(find('').map((f) => [f.severity, f.message]), [['error', 's carries VLANs 10, 20, 30 without an IGMP / MLD snooping choice: set igmp_mld_snooping to enabled or disabled for each (until then the simulation floods their multicast, as a switch without snooping)']]);
  assert.deepEqual(find('igmp_mld_snooping: {10: enabled}, ').map((f) => f.message.split(' without')[0]), ['s carries VLANs 20, 30']);
  // disabled is a choice too
  assert.deepEqual(find('igmp_mld_snooping: {10-20: enabled, 30: disabled}, '), []);
  // not a switch: nothing to choose
  assert.deepEqual(C.runChecks(model(`netatlas: 2\ntitle: t\ndevices:\n  - {id: r, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}]}\n`)).filter((f) => f.check === 'snooping-not-configured'), []);
});

// ------------------------------------------------------------------ forwarding

test('enabled: a group goes only to the ports where a member of that group reported it in that VLAN; nothing before; never back to its source', () => {
  const s = sim(LAB());
  s.runTo(8000);
  // nobody joined yet: no host port gets anything (not h1, h2, h3), the sources only send
  for (const [l, g] of [['l1', '239.1.1.1'], ['l2', '239.1.1.1'], ['l3', '239.1.1.1'], ['l1', '239.1.1.2'], ['l2', '239.1.1.2']]) assert.deepEqual(data(s, l, g), [], `${l} ${g} before any join`);
  assert.ok(data(s, 'l4', '239.1.1.1').length && data(s, 'l5', '239.1.1.1').length, 'the sources send');
  assert.deepEqual(s.snoopTable('sw').rows, []);
  assert.match(s.snoopTable('sw').empty, /^No memberships and no router port learned in VLAN 10, 20\.$/);
  // h1 joins 239.1.1.1: its port only, that group only, that VLAN only
  assert.equal(s.joinGroup('h1', 'eth0', '239.1.1.1', []), null);
  s.runTo(s.now + 500);
  const t = s.now;
  s.runTo(t + 5000);
  assert.ok(data(s, 'l1', '239.1.1.1', t).length >= 4, 'h1 gets its group');
  assert.ok(data(s, 'l1', '239.1.1.1', t).every((f) => f.hdr.l3[0].src === '10.10.0.20'), 'from VLAN 10 only: src20’s stream to the same group stays in VLAN 20');
  assert.deepEqual(data(s, 'l1', '239.1.1.2', t), [], 'not another group');
  assert.deepEqual(data(s, 'l2', '239.1.1.1', t), [], 'not another port of the VLAN');
  assert.deepEqual(data(s, 'l3', '239.1.1.1', t), [], 'not the same group in another VLAN');
  // never back out of its ingress port: src gets none of its own
  assert.ok(!s.engine.flights.some((f) => f.track.ref === 'link:l4' && f.protocol === 'mcast' && f.sender !== 'src'));
  const rows = s.snoopTable('sw').rows;
  assert.deepEqual(rows.map((r) => r.slice(0, 3)), [['10', '239.1.1.1 (IGMP)', 'p1']]);
  assert.match(rows[0][3], /^member port: IGMPv3, any source, reported by 10\.10\.0\.11$/);
  // the log says where a group goes to no host port
  assert.ok(ev(s, (e) => e.device === 'sw' && e.kind === 'drop' && /^sw forwards 239\.1\.1\.2 to no port in VLAN 10: no member reported it there and it has no multicast router port \((it is the VLAN's querier itself and no multicast router is there|no query or PIM Hello heard in VLAN 10: no querier there); unregistered multicast goes to the router ports only\)$/.test(e.detail)).length >= 1);
});

test('control traffic: reports go to the router ports only (no other host hears them), queries are flooded; a member learned without any router port', () => {
  const s = sim(LAB({ query: 10 }));
  s.runTo(3000);
  // (a join of Network events: its reports carry its id, so they are drawn and found)
  const j = s.actJoin('h1', 'eth0', '239.1.1.1', []);
  s.runTo(4000);
  // (the flights of the last moments: the unsolicited report)
  const rep = s.engine.flights.filter((f) => f.test === j.traffic && f.protocol === 'igmp' && f.view === 'physical');
  s.runTo(30000);
  assert.ok(rep.some((f) => f.track.ref === 'link:l1'), 'h1’s reports reach the switch');
  // h1's reports never reach h2 or src: the switch sends them to its router ports only, and it has none in VLAN 10 (it is the querier itself)
  assert.ok(!rep.some((f) => f.track.ref === 'link:l2' || f.track.ref === 'link:l4'), rep.map((f) => f.track.ref).join());
  assert.ok(!ev(s, (e) => e.device === 'h2' && /report suppressed/.test(e.what)).length, 'h2 never hears another member’s report');
  // the querier's general queries (224.0.0.1, link-local) are flooded: h1 hears and answers them
  assert.ok(ev(s, (e) => e.device === 'h1' && /answers the general query of 10\.10\.0\.1/.test(e.detail)).length >= 1);
  // h2 answers no query for a group it never joined
  assert.ok(!ev(s, (e) => e.device === 'h2' && e.what === 'Report').length);
  assert.ok(s.snoopTable('sw').notes.includes('VLAN 10 · Querier: the elected IGMP querier of VLAN 10 (snooping querier, from 10.10.0.1); no multicast router port; unregistered multicast to the router ports only.'), s.snoopTable('sw').notes.join(' | '));
});

test('lifecycle: refreshed by the answers to queries, gone after a leave (group queries) or when nothing refreshes it; a link down takes its port at once; a new simulation starts empty', () => {
  const s = sim(LAB({ query: 10 }));
  s.runTo(2000);
  s.joinGroup('h1', 'eth0', '239.1.1.1', []);
  s.joinGroup('h2', 'eth0', '239.1.1.1', []);
  // refresh: the membership interval is 2 × 10 s + 10 s = 30 s; at 90 s both are still there (answers to the queries)
  s.runTo(90000);
  assert.deepEqual(s.snoopTable('sw').rows.map((r) => r[2]), ['p1', 'p2']);
  // leave: h2's port goes after the last member queries (robustness × 1 s), h1 stays
  s.leaveGroup('h2', 'eth0', '239.1.1.1');
  s.runTo(s.now + 4000);
  assert.deepEqual(s.snoopTable('sw').rows.map((r) => r[2]), ['p1']);
  let t = s.now;
  s.runTo(t + 3000);
  assert.deepEqual(data(s, 'l2', '239.1.1.1', t), [], 'h2 left: nothing to its port');
  assert.ok(data(s, 'l1', '239.1.1.1', t).length, 'h1 still gets it');
  // a link down: the member port goes at once, logged
  s.fail('link:l1');
  s.runTo(s.now + 100);
  assert.deepEqual(s.snoopTable('sw').rows, []);
  assert.ok(ev(s, (e) => e.device === 'sw' && /^sw: port p1 is no member port of 239\.1\.1\.1 in VLAN 10 any more \(its link went down\)$/.test(e.detail)).length === 1);
  s.restore('link:l1');
  s.runTo(s.now + 25000);
  assert.deepEqual(s.snoopTable('sw').rows.map((r) => r[2]), ['p1'], 'learned again from its answer to the next query');
  // expiry: h1 powered off answers nothing; after the membership interval its port goes
  s.powerOff('h1');
  s.runTo(s.now + 32000);
  assert.deepEqual(s.snoopTable('sw').rows, []);
  // (h2's port went exactly when the last member queries after its leave were over — 2 × 1 s — and says why; h1's with its link when it was powered off)
  assert.deepEqual(ev(s, (e) => e.device === 'sw' && e.what === 'member port expired').map((e) => [Math.round(e.t), e.detail]), [[92000, 'sw: port p2 is no member port of 239.1.1.1 in VLAN 10 any more (nobody answered the group-specific queries after the leave)']]);
  assert.ok(ev(s, (e) => e.device === 'sw' && e.what === 'member port removed' && e.t > 120000 && /its link went down/.test(e.detail)).length >= 1);
  t = s.now;
  s.runTo(t + 3000);
  assert.deepEqual(data(s, 'l1', '239.1.1.1', t), []);
  // a new simulation of the same model: nothing of the last one
  const fresh = sim(LAB({ query: 10 }));
  assert.deepEqual(fresh.snoopTable('sw').rows, []);
  // the switch powered off forgets what it learned
  const p = sim(LAB({ query: 10 }));
  p.runTo(2000);
  p.joinGroup('h1', 'eth0', '239.1.1.1', []);
  p.runTo(5000);
  assert.equal(p.snoopTable('sw').rows.length, 1);
  p.powerOff('sw');
  assert.deepEqual(p.snoopTable('sw').rows, []);
});

test('IPv6: MLD reports make member ports too; an IPv6 group goes to its member only', () => {
  const s = sim(LAB({ v6: true }));
  s.runTo(2000);
  assert.equal(s.joinGroup('h1', 'eth0', 'ff05::1', []), null);
  s.runTo(4000);
  const t = s.now;
  s.runTo(t + 4000);
  assert.ok(data(s, 'l1', 'ff05::1', t).length >= 3);
  assert.deepEqual(data(s, 'l2', 'ff05::1', t), []);
  const row = s.snoopTable('sw').rows.find((r) => r[1] === 'ff05::1 (MLD)');
  assert.deepEqual(row.slice(0, 3), ['10', 'ff05::1 (MLD)', 'p1']);
  assert.match(row[3], /^member port: MLDv2, any source, reported by 2001:db8:10::11$/);
  // the host's own memberships: its table
  const m = s.memberTable('h1');
  assert.deepEqual(m.rows.map((r) => r.slice(0, 4)), [['eth0', 'ff05::1', 'MLDv2', 'any source']]);
  assert.equal(s.memberTable('h2').rows.length, 0);
  assert.equal(s.memberTable('h2').empty, 'No memberships: it has joined no group.');
});

test('snooping is not routing: a Layer 3 switch without PIM routes no multicast between its VLANs; with PIM it does, for members only, and snooping still keeps the other hosts out', () => {
  const s = sim(LAB());
  s.runTo(2000);
  s.joinGroup('h3', 'eth0', '239.1.1.2', []);
  s.runTo(4000);
  let t = s.now;
  s.runTo(t + 5000);
  assert.deepEqual(data(s, 'l3', '239.1.1.2', t), [], 'h3 in VLAN 20: nothing from VLAN 10 without multicast routing');
  assert.ok(ev(s, (e) => e.device === 'sw' && /sw routes no multicast \(it runs no PIM\)/.test(e.detail)).length >= 1);
  assert.match(s.snoopTable('sw').notes.join(' '), /sw routes no multicast \(it runs no PIM\): nothing crosses its VLAN interfaces; this table is its Layer 2 snooping only\./);
  // the same with PIM (dense mode): routed into VLAN 20 to its member; h1 and h2 in VLAN 10 still get nothing (not members)
  const r = sim(LAB({ pim: true }));
  r.runTo(2000);
  r.joinGroup('h3', 'eth0', '239.1.1.2', []);
  r.runTo(8000);
  t = r.now;
  r.runTo(t + 5000);
  assert.ok(data(r, 'l3', '239.1.1.2', t).length >= 3, 'routed to the member in VLAN 20');
  assert.deepEqual(data(r, 'l1', '239.1.1.2', t).concat(data(r, 'l2', '239.1.1.2', t)), [], 'no host of VLAN 10 without a membership');
  assert.ok(r.mrouteTable('sw').rows.some((row) => /239\.1\.1\.2/.test(row[0])));
  assert.match(r.snoopTable('sw').notes.join(' '), /sw also routes multicast \(PIM\) between its VLAN interfaces: see Show multicast routes/);
});

// ------------------------------------------------------------------ the private house

test('private house: the thermostat’s VLAN 20 stream reaches no host before a join; the TV’s join opens only its way; leaving closes it; nothing leaks into Internal or Guest; in another VLAN the TV gets nothing without multicast routing', () => {
  const s = sim(example('private-house.yaml'));
  assert.deepEqual(C.runChecks(s.model).filter((f) => f.check === 'snooping-not-configured'), []);
  s.runTo(30000);
  const st = s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 1316);
  assert.equal(st.error, undefined);
  const links = (from) => new Set(s.engine.flights.filter((f) => f.test === st.traffic && f.t0 > from && f.view === 'physical' && f.protocol === 'mcast').map((f) => f.track.ref));
  // 1, 2: no member: the stream leaves the thermostat and its access point; dist sends it to its router port (the core, the IoT VLAN's
  // snooping querier) only; the core to no port; the TV and the first-floor access point get nothing
  let t = s.now;
  s.play(5000);
  let l = links(t - 1);
  assert.deepEqual(Array.from(l).sort(), ['link:l-core-dist', 'link:l-dist-ap2', 'link:w-thermostat']);
  // (the core queries VLANs 10, 20 and 30: dist's port up is a router port in each of them, never a membership)
  assert.deepEqual(s.snoopTable('dist').rows.map((r) => r.slice(0, 3)), [['10', '—', 'up'], ['20', '—', 'up'], ['30', '—', 'up']]);
  assert.match(s.snoopTable('dist').rows[1][3], /^multicast router port: every group goes there, members or not \(a query or PIM Hello arrived there; the querier core \(192\.168\.20\.1\) is behind it\); not a membership$/);
  assert.deepEqual(s.snoopTable('core').rows, []);
  assert.equal(st.stream.rx.size, 0);
  const v = s.actions().find((x) => x.id === st.id);
  assert.match(v.summary, /no member received any yet · stops at core$/);
  assert.ok(v.details.includes("Last stopped at core: core forwards 239.20.0.1 to no port in VLAN 20: no member reported it there and it has no multicast router port (it is the VLAN's querier itself and no multicast router is there; unregistered multicast goes to the router ports only)"), v.details.join(' | '));
  // 3: the TV joins: the core learns its port (towards ap-b); the stream goes that way only
  assert.equal(s.joinGroup('tv', 'wlan0', '239.20.0.1', []), null);
  s.play(3000);
  t = s.now;
  s.play(5000);
  l = links(t);
  assert.deepEqual(Array.from(l).sort(), ['link:l-core-apb', 'link:l-core-dist', 'link:l-dist-ap2', 'link:w-thermostat', 'link:w-tv']);
  assert.ok(st.stream.rx.get('tv') >= 4);
  assert.deepEqual(s.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['20', '239.20.0.1 (IGMP)', 'ap']]);
  assert.deepEqual(s.memberTable('tv').rows.map((r) => r.slice(0, 2)), [['wlan0', '239.20.0.1']]);
  // 5: never into Internal or Guest: not to the other clients, not to the NAS, not past the core
  for (const no of ['link:w-phone', 'link:w-guest-phone', 'link:w-laptop', 'link:l-dist-ap1', 'link:l-core-nas', 'link:l-router-core']) assert.ok(!l.has(no), no);
  // 4: the TV leaves: after the last member queries its port goes, and the stream with it
  assert.ok(s.leaveGroup('tv', 'wlan0', '239.20.0.1'));
  s.play(6000);
  t = s.now;
  s.play(4000);
  assert.ok(!links(t).has('link:l-core-apb') && !links(t).has('link:w-tv'));
  assert.deepEqual(s.snoopTable('core').rows, []);
  // 6: the TV in the Internal VLAN instead (its Wi-Fi network): its join is learned there, but the core routes no multicast between VLANs
  const moved = sim(example('private-house.yaml').replace('{id: w-tv, a: "ap-b:radio0", b: "tv:wlan0", medium: wireless, wireless_network: iot}', '{id: w-tv, a: "ap-b:radio0", b: "tv:wlan0", medium: wireless, wireless_network: internal}'));
  moved.runTo(30000);
  const s2 = moved.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 1316);
  assert.equal(moved.joinGroup('tv', 'wlan0', '239.20.0.1', []), null);
  moved.play(8000);
  assert.equal(s2.stream.rx.size, 0, 'no multicast routing on the core: nothing reaches the TV in VLAN 10');
  assert.ok(!moved.engine.flights.some((f) => f.test === s2.traffic && (f.track.ref === 'link:w-tv' || f.track.ref === 'link:l-core-apb')));
  assert.deepEqual(moved.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['10', '239.20.0.1 (IGMP)', 'ap']], 'the membership is the Internal VLAN’s, where nothing of the stream is');
});
