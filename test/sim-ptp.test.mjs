// PTP in the simulation (analysis/sim/ptp.ts, model/ptp.ts): IEEE 1588-2008, Default delay
// request-response profile over UDP/IPv4, two-step. The election by Announce and the data set
// comparison, ordinary / boundary / transparent clocks, Sync, Follow_Up, Delay_Req, Delay_Resp,
// residence-time correction, grandmaster loss and recovery, domain and connectivity isolation,
// interface failure, modelled clock time apart from the scheduler. Injected clocks, no sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock, errorsOf } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('model/ptp.js');

/** cell A (10.0.10.0/24): gm1, gm2 and the router's port a, through the transparent clock sw1; cell B (10.0.20.0/24): rx1, rx2 through the plain switch sw2; the router bc1 is a boundary clock */
const NET = (o = {}) => `netatlas: 2
devices:
  - id: gm1
    type: server
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable${o.gm1 || ', priority1: 100'}}
    interfaces: [{id: eth0, ip: 10.0.10.11/24}]
  - id: gm2
    type: server
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable${o.gm2 || ''}}
    interfaces: [{id: eth0, ip: 10.0.10.12/24}]
  - id: sw1
    type: switch
    kind: industrial
    igmp_mld_snooping: {10: disabled}
    services:
      ptp: {clock: ${o.tc || 'transparent'}, profile: default_e2e_udp4, interfaces: [p1, p2, p3]}
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]
  - id: bc1
    type: router
    services:
      ptp: {clock: boundary, profile: default_e2e_udp4, domain: 0, interfaces: [a, b]}
    interfaces: [{id: a, ip: 10.0.10.1/24}, {id: b, ip: 10.0.20.1/24}]
  - id: sw2
    type: switch
    igmp_mld_snooping: {20: disabled}
    interfaces: [{id: p1, vlans: 20}, {id: p2, vlans: 20}, {id: p3, vlans: 20}${o.sw2more || ''}]
  - id: rx1
    type: endpoint
    kind: plc
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: ${o.rx1domain || 0}, interfaces: [eth0], role: receiver_only${o.rx1 || ''}}
    interfaces: [{id: eth0, ip: 10.0.20.21/24}]
  - id: rx2
    type: endpoint
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: receiver_only}
    interfaces: [{id: eth0, ip: 10.0.20.22/24}]
${o.more || ''}links:
  - {id: l1, a: "gm1:eth0", b: "sw1:p1"}
  - {id: l2, a: "gm2:eth0", b: "sw1:p2"}
  - {id: l3, a: "sw1:p3", b: "bc1:a"}
  - {id: l4, a: "bc1:b", b: "sw2:p1"}
  - {id: l5, a: "sw2:p2", b: "rx1:eth0"}
  - {id: l6, a: "sw2:p3", b: "rx2:eth0"}
${o.links || ''}networks:
  - {id: a, cidr: 10.0.10.0/24, vlan: 10}
  - {id: b, cidr: 10.0.20.0/24, vlan: 20}
`;

const sim = (text = NET()) => withClock(new S.Simulation(model(text)));
const settle = (s, ms) => s.runTo(s.now + ms);
const clock = (s, d) => s.ptp.clocks.get(d);
const states = (s, d) => clock(s, d).ports.map((p) => p.state);

test('the format: a clock function, the one profile, a domain, its ports; what each function needs; nothing substituted', () => {
  assert.deepEqual(errorsOf(NET()), []);
  const e = (o) => errorsOf(NET(o)).map((x) => x.message).join(' | ');
  assert.match(e({ tc: 'boundary' }), /p1 has no IPv4 address: the profile carries PTP over UDP\/IPv4/);
  assert.match(errorsOf(NET().replace("ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable, priority1: 100}", "ptp: {clock: transparent, profile: default_e2e_udp4, interfaces: [eth0]}")).map((x) => x.message).join('|'), /"gm1" bridges nothing: a transparent clock corrects the frames a switch forwards/);
  assert.match(errorsOf(NET().replace('interfaces: [a, b]}', 'interfaces: [a]}')).map((x) => x.message).join('|'), /a boundary clock has several PTP ports/);
  assert.match(errorsOf(NET().replace("domain: 0, interfaces: [eth0], role: receiver_only}\n    interfaces: [{id: eth0, ip: 10.0.20.22/24}]", "domain: 0, interfaces: [eth0]}\n    interfaces: [{id: eth0, ip: 10.0.20.22/24}]")).map((x) => x.message).join('|'), /needs its role/);
  assert.match(e({ rx1: ', clock_class: 6' }), /a receiver-only clock announces clock class 255/);
  assert.match(e({ gm2: ', announce_interval: 3s' }), /the Announce interval is one of 1 s, 2 s, 4 s, 8 s, 16 s in this profile/);
  assert.match(e({ gm2: ', clock_offset: fast, drift: lots' }), /"fast" is not an offset[\s\S]*"lots" is not a drift/);
  assert.match(errorsOf(NET().replace('profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}', 'profile: gptp, domain: 0, interfaces: [eth0], role: source_capable}')).map((x) => x.message).join('|'), /"gptp" is not a profile/);
  // a VM keeps no PTP clock; nothing is inferred from a switch's kind: an industrial switch without the service is no clock
  assert.ok(errorsOf(`netatlas: 2\ndevices:\n  - {id: v, type: vm, host: h, services: {ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [x], role: receiver_only}}}\n`).some((x) => /can't run PTP/.test(x.message)));
  const m = model(NET({ tc: 'transparent' }).replace(/  - id: sw2\n    type: switch\n/, '  - id: sw2\n    type: switch\n    kind: industrial\n'));
  assert.ok(!m.index.devices.get('sw2').appServices, 'no PTP because of its kind');
});

test('the election: Announces qualify the better grandmaster (priority1 100); every other port follows it; the boundary clock carries it into the other subnet', () => {
  const s = sim();
  settle(s, 30000);
  assert.equal(s.ptp.grandmaster(0), 'gm1');
  assert.equal(clock(s, 'gm1').state, 'grandmaster');
  assert.deepEqual(states(s, 'gm1'), ['MASTER']);
  assert.equal(clock(s, 'gm2').parent.senderDev, 'gm1', 'gm2 is a candidate, not the grandmaster: it follows gm1');
  assert.deepEqual(states(s, 'bc1'), ['SLAVE', 'MASTER'], 'its port a toward gm1 a slave, its port b a master');
  for (const d of ['rx1', 'rx2']) {
    const c = clock(s, d);
    assert.equal(c.parent.senderDev, 'bc1');
    assert.equal(c.parent.gmDev, 'gm1');
    assert.equal(c.parent.stepsRemoved, 2, 'two steps: gm1 → bc1 → it');
    assert.equal(c.state, 'synchronized', `${d}: ${c.state}`);
  }
  // every message kind, through the shared pipeline
  const kinds = new Set(s.events().filter((e) => e.protocol === 'ptp' && e.kind === 'message').map((e) => e.what));
  for (const k of ['PTP Announce', 'PTP Sync', 'PTP Follow_Up', 'PTP Delay_Req', 'PTP Delay_Resp']) assert.ok(kinds.has(k), k);
  // the receivers joined the PTP group (IGMP), as ptp4l does: no blanket multicast bypass
  assert.ok(s.multicast.isMember('rx1', 'eth0', '224.0.1.129'));
  // the mark in the diagram
  assert.match(s.ptp.mark('gm1').text, /Grandmaster/);
  assert.match(s.ptp.mark('rx1').text, /Synchronized/);
  assert.match(s.ptp.mark('sw1').text, /Transparent clock/);
});

test('the estimates follow the modelled timestamps: offsets within the lock threshold, the error against the grandmaster small; the scheduler never moves', () => {
  // hardware timestamps on the whole path (a software-stamping master would keep a hardware slave above 1 µs: shown in the next lines)
  const s = sim(NET({ gm1: ', priority1: 100, timestamping: hardware', rx1: ', timestamping: hardware, drift: 25ppm, clock_offset: +3ms' }).replace('interfaces: [a, b]}', 'interfaces: [a, b], timestamping: hardware}'));
  const t0 = s.now;
  settle(s, 40000);
  assert.equal(s.now, t0 + 40000, 'PTP changes no simulated time');
  const c = clock(s, 'rx1');
  assert.equal(c.state, 'synchronized');
  assert.ok(Math.abs(c.lastOffset) < 1000, `offset ${c.lastOffset} ns`);
  // its clock against gm1's (the simulation's knowledge): within a few µs after the servo (hardware timestamps, symmetric cables)
  const gm = clock(s, 'gm1');
  const T = s.now * 1e6;
  const err = (c.phase + c.rate * 1e-6 * (T - c.tref)) - (gm.phase + gm.rate * 1e-6 * (T - gm.tref));
  assert.ok(Math.abs(err) < 5000, `error ${err} ns`);
  // the mean path delay is the two cables' to its boundary clock (100 µs of latency each, the simulation's default) and their serialization
  assert.ok(c.meanPathDelay > 200000 && c.meanPathDelay < 210000, `mean path delay ${c.meanPathDelay} ns`);
  // a master stamping in software: the hardware slave's estimates scatter by its 1 µs resolution and stay unlocked
  const sw = sim(NET({ rx1: ', timestamping: hardware' }));
  settle(sw, 40000);
  assert.notEqual(clock(sw, 'rx1').state, 'synchronized');
  // event times never go back
  const ts = s.events().map((e) => e.t);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1]);
});

test('the transparent clock: it times what it forwards and corrects the matching Follow_Up and Delay_Resp; it never becomes a time source', () => {
  const s = sim();
  settle(s, 30000);
  const tc = clock(s, 'sw1');
  assert.ok(tc.tc.corrected > 10, `${tc.tc.corrected} event messages timed`);
  assert.equal(tc.ports.length, 0, 'no PTP port of its own: it takes no part in the election');
  assert.ok(!s.events().some((e) => e.device === 'sw1' && e.what === 'PTP Announce'));
  assert.match(s.ptp.table('sw1').notes.join(' '), /two-step/);
  // traffic queued in front of the event messages (a camera's 60 kB datagrams on a 100 Mbit/s path): the transparent clock times the
  // queueing and corrects it; without one the same queueing pollutes the path delay and the boundary clock does not lock
  const loaded = (tc) => {
    let text = NET({ gm1: ', priority1: 100, timestamping: hardware', more: '  - id: cam\n    type: endpoint\n    services:\n      applications:\n        - {id: video, name: Video, profile: udp_sender, peer: 10.0.10.1, port: 5004, interval: 0.1s, start: simulation_start, request_size: 60000}\n    interfaces: [{id: eth0, ip: 10.0.10.50/24}]\n', links: '  - {id: l7, a: "cam:eth0", b: "sw1:p4"}\n' })
      .replace('interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]', 'interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}, {id: p4, vlans: 10}]')
      .replace('interfaces: [p1, p2, p3]}', 'interfaces: [p1, p2, p3, p4]}')
      .replace('interfaces: [a, b]}', 'interfaces: [a, b], timestamping: hardware}')
      .replace('  - {id: l3, a: "sw1:p3", b: "bc1:a"}', '  - {id: l3, a: "sw1:p3", b: "bc1:a", speed: 100M}');
    if (!tc) text = text.replace(/    services:\n      ptp: \{clock: transparent[^\n]*\n/, '');
    const x = sim(text);
    settle(x, 60000);
    return x;
  };
  const withTc = loaded(true);
  const bc = clock(withTc, 'bc1');
  assert.ok(clock(withTc, 'sw1').tc.max > 1e6, `a residence of more than 1 ms was corrected (${clock(withTc, 'sw1').tc.max} ns)`);
  assert.equal(bc.state, 'synchronized');
  assert.ok(bc.meanPathDelay < 215000, `the path delay stays the cables' (${bc.meanPathDelay} ns)`);
  const noTc = loaded(false);
  const bc2 = clock(noTc, 'bc1');
  assert.ok(bc2.meanPathDelay > 1e6, `without a transparent clock the queueing is in the path delay (${bc2.meanPathDelay} ns)`);
  assert.notEqual(bc2.state, 'synchronized');
});

test('grandmaster loss and recovery: gm2 takes over after the announce receipt timeout; gm1 back, the election follows the data sets again', () => {
  const s = sim();
  settle(s, 30000);
  s.powerOff('gm1');
  settle(s, 20000);
  assert.equal(s.ptp.grandmaster(0), 'gm2');
  assert.equal(clock(s, 'rx1').parent.gmDev, 'gm2', 'the receivers follow the new grandmaster through the boundary clock');
  assert.ok(s.events().some((e) => e.device === 'gm2' && /PTP grandmaster/.test(e.what)));
  s.powerOn('gm1');
  settle(s, 60000);
  assert.equal(s.ptp.grandmaster(0), 'gm1', 'the better clock is the grandmaster again');
  assert.equal(clock(s, 'gm2').parent.senderDev, 'gm1');
  assert.equal(clock(s, 'rx1').parent.gmDev, 'gm1');
});

test('the boundary clock’s upstream fails: its receivers lose their time (holdover or unsynchronized), and get it back when the link returns', () => {
  const s = sim();
  settle(s, 30000);
  s.shut('bc1', 'a');
  settle(s, 20000);
  const st = clock(s, 'rx1').state;
  assert.ok(['holdover', 'unsynchronized', 'acquiring'].includes(st) || clock(s, 'rx1').parent.gmDev === 'bc1', `rx1: ${st}`);
  assert.notEqual(clock(s, 'bc1').state, 'synchronized');
  s.noShut('bc1', 'a');
  settle(s, 60000);
  assert.equal(clock(s, 'rx1').parent.gmDev, 'gm1');
  assert.equal(clock(s, 'rx1').state, 'synchronized');
});

test('domain and connectivity: another domain is ignored; a domain number never joins networks the messages can’t cross', () => {
  const s = sim(NET({ rx1domain: 1, rx1: '' }).replace('role: receiver_only}\n    interfaces: [{id: eth0, ip: 10.0.20.21/24}]', 'role: source_capable}\n    interfaces: [{id: eth0, ip: 10.0.20.21/24}]'));
  settle(s, 30000);
  assert.equal(s.ptp.grandmaster(1), 'rx1', 'alone in domain 1: its own grandmaster');
  assert.ok(s.events().some((e) => e.device === 'rx1' && /ignores domain 0/.test(e.detail)));
  // two islands of domain 0, nothing between them: two grandmasters
  const island = `netatlas: 2
devices:
  - {id: a1, type: server, services: {ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}}, interfaces: [{id: eth0, ip: 10.1.0.1/24}]}
  - {id: a2, type: server, services: {ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}}, interfaces: [{id: eth0, ip: 10.1.0.2/24}]}
  - {id: b1, type: server, services: {ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}}, interfaces: [{id: eth0, ip: 10.2.0.1/24}]}
  - {id: b2, type: server, services: {ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}}, interfaces: [{id: eth0, ip: 10.2.0.2/24}]}
links:
  - {id: la, a: "a1:eth0", b: "a2:eth0"}
  - {id: lb, a: "b1:eth0", b: "b2:eth0"}
`;
  const t = withClock(new S.Simulation(model(island)));
  t.runTo(30000);
  const gms = Array.from(t.ptp.clocks.values()).filter((c) => c.gm).map((c) => c.dev).sort();
  assert.equal(gms.length, 2, gms.join(','));
  assert.ok((gms.includes('a1') || gms.includes('a2')) && (gms.includes('b1') || gms.includes('b2')));
});

test('the data set comparison (1588-2008 §9.3.4) and the state decision (§9.3.3)', () => {
  const gm = (id, p1 = 128, cls = 248, p2 = 128) => ({ identity: id, priority1: p1, clockClass: cls, clockAccuracy: 0xfe, variance: 0xffff, priority2: p2 });
  const ds = (g, steps, sender, receiver) => ({ gm: g, stepsRemoved: steps, sender, receiver });
  // attributes in order, lower wins; identity last
  assert.equal(P.compareDatasets(ds(gm('aa', 100), 0, 'aa-1', 'x-1'), ds(gm('00', 128), 0, '00-1', 'x-1')), P.A_BETTER);
  assert.equal(P.compareDatasets(ds(gm('aa', 128, 6), 0, 'aa-1', 'x-1'), ds(gm('00', 128, 248), 0, '00-1', 'x-1')), P.A_BETTER);
  assert.equal(P.compareDatasets(ds(gm('aa'), 0, 'aa-1', 'x-1'), ds(gm('bb'), 0, 'bb-1', 'x-1')), P.A_BETTER);
  // the same grandmaster: by topology
  assert.equal(P.compareDatasets(ds(gm('aa'), 1, 'p-1', 'x-1'), ds(gm('aa'), 3, 'q-1', 'x-2')), P.A_BETTER);
  assert.equal(P.compareDatasets(ds(gm('aa'), 1, 'p-1', 'x-1'), ds(gm('aa'), 1, 'q-1', 'x-1')), P.A_BETTER_TOPO);
  // a receiver-only clock: slave or listening, never a master
  const d0 = ds(gm('me', 128, 255), 0, 'me-0', 'me-0');
  assert.equal(P.stateDecision(d0, null, null, false, true, false), 'LISTENING');
  assert.equal(P.stateDecision(d0, ds(gm('aa'), 0, 'aa-1', 'me-1'), ds(gm('aa'), 0, 'aa-1', 'me-1'), true, true, false), 'S1');
  // a better clock alone on its port is the grandmaster (M2); hearing a better one, a slave (S1)
  const mine = ds(gm('me', 100), 0, 'me-0', 'me-0');
  assert.equal(P.stateDecision(mine, null, null, false, false, false), 'M2');
  const better = ds(gm('aa', 50), 0, 'aa-1', 'me-1');
  assert.equal(P.stateDecision(mine, better, better, true, false, false), 'S1');
  assert.equal(P.clockIdentity('00:1b:21:12:34:56'), '00:1b:21:ff:fe:12:34:56');
  assert.equal(P.parseClockOffset('+250us'), 250000);
  assert.equal(P.parseClockOffset('-3ms'), -3e6);
  assert.equal(P.parseDrift('20ppm'), 20);
  assert.equal(P.parseDrift('2000ppm'), null);
});

test('reset: a new simulation of the same model starts from nothing; timers of a stopped clock do nothing', () => {
  const s = sim();
  settle(s, 30000);
  const n = s.events().filter((e) => e.device === 'rx1' && e.protocol === 'ptp').length;
  s.powerOff('rx1');
  const after = s.events().length;
  settle(s, 20000);
  assert.equal(s.events().slice(after).filter((e) => e.device === 'rx1' && e.protocol === 'ptp' && e.kind === 'message').length, 0, 'nothing from a clock that is off');
  const t = sim();
  assert.equal(t.ptp.grandmaster(0), null, 'a fresh start: no grandmaster before the Announces');
  assert.ok(n > 0);
});
