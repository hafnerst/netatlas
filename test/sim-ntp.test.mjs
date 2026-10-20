// NTP's state in the simulation (analysis/sim/ntp.ts): configured upstreams versus being
// synchronized to one that answers, serving time versus being synchronized, stratum from the source,
// unsynchronized after the reach register's 8 polls; NTP and PTP kept apart. Injected clocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const NET = (more = '') => `netatlas: 1
devices:
  - id: ref
    type: server
    services:
      ntp: {stratum: 1}
    interfaces: [{id: eth0, ip: 10.0.0.1/24}]
  - id: mid
    type: server
    services:
      ntp: {upstreams: [10.0.0.1]}
    interfaces: [{id: eth0, ip: 10.0.0.2/24}]
  - id: leaf
    type: server
    services:
      ntp: {upstreams: [10.0.0.2]}${more}
    interfaces: [{id: eth0, ip: 10.0.0.3/24}]
  - id: lonely
    type: server
    services:
      ntp: {upstreams: [192.0.2.123]}
    interfaces: [{id: eth0, ip: 10.0.0.4/24}]
  - id: sw
    type: switch
    igmp_mld_snooping: {1: disabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
links:
  - {id: l1, a: "sw:p1", b: "ref:eth0"}
  - {id: l2, a: "sw:p2", b: "mid:eth0"}
  - {id: l3, a: "sw:p3", b: "leaf:eth0"}
  - {id: l4, a: "sw:p4", b: "lonely:eth0"}
`;

const sim = (t = NET()) => withClock(new S.Simulation(model(t)));

test('a reference serves its stratum; a client is synchronized only once a usable upstream answered; the stratum follows the source', () => {
  const s = sim();
  assert.match(s.ntp.text('ref'), /serving time at stratum 1/);
  assert.match(s.ntp.text('mid'), /^unsynchronized \(stratum 16\)/, 'configured upstreams are no synchronization yet');
  s.runTo(150000);
  assert.match(s.ntp.text('mid'), /^synchronized to 10\.0\.0\.1/);
  assert.equal(s.ntp.stratum('mid'), 2);
  s.runTo(300000);
  assert.equal(s.ntp.stratum('leaf'), 3);
  // an upstream outside the model never answers: said so
  assert.match(s.ntp.text('lonely'), /unsynchronized .*192\.0\.2\.123 is outside the model \(not simulated\)/);
  assert.equal(s.ntp.stratum('lonely'), 16);
  const t = s.ntp.table('mid');
  assert.equal(t.rows[0][0], '10.0.0.1');
  assert.equal(t.rows[0][4], 'its source');
  assert.ok(s.status().some((x) => x.name === 'NTP mid' && x.state === 'Synchronized'));
});

test('its source silent for 8 polls: unsynchronized again (and its own clients with it, stratum 16)', () => {
  const s = sim();
  s.runTo(300000);
  assert.equal(s.ntp.stratum('leaf'), 3);
  s.powerOff('ref');
  s.runTo(s.now + 9 * 64000 + 10000);
  assert.match(s.ntp.text('mid'), /^unsynchronized \(stratum 16\): no response from 10\.0\.0\.1 for 8 polls/);
  s.runTo(s.now + 9 * 64000 + 10000);
  assert.equal(s.ntp.stratum('leaf'), 16, 'a stratum-16 server is nobody’s source');
});

test('NTP and PTP stay apart: neither enables or disciplines the other', () => {
  const s = sim(NET(`\n      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}`));
  s.runTo(300000);
  assert.equal(s.ntp.stratum('leaf'), 3);
  assert.equal(s.ptp.clocks.get('leaf').state, 'grandmaster', 'the only PTP clock: its own grandmaster, whatever NTP says');
  assert.ok(!s.ptp.clocks.has('mid'), 'NTP turns no PTP on');
  assert.ok(!s.ntp.has('ptp-only'));
});

test('a client knows its upstreams only by their responses: the stratum they reported, fresh by their reach; a source answering stratum 16 ends it at once', () => {
  const s = sim();
  s.runTo(400000);
  assert.equal(s.ntp.stratum('leaf'), 3);
  // the stratum is the one mid's last response said (shown as such)
  const t = s.ntp.table('leaf');
  assert.deepEqual([t.cols[3], t.rows[0][3]], ['Stratum it reported', '2']);
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'mid' && e.what === 'Server response' && /stratum 2$/.test(e.detail)));
  // ref powered off: nothing tells mid at once — it stays synchronized until its reach register runs out (8 polls)
  const off = s.now;
  s.powerOff('ref');
  s.runTo(off + 300000);
  assert.match(s.ntp.text('mid'), /^synchronized to 10\.0\.0\.1/, 'stale but its own knowledge');
  s.runTo(off + 8 * 64000 + 70000);
  assert.match(s.ntp.text('mid'), /^unsynchronized/);
  // mid's next response says stratum 16: leaf drops its source at once (not 8 polls later), and its status agrees
  s.runTo(s.now + 70000);
  const lost = s.events().find((e) => e.kind === 'state' && e.device === 'leaf' && e.what === 'unsynchronized');
  assert.ok(lost && /its source mid answers at stratum 16/.test(lost.detail), lost && lost.detail);
  assert.equal(s.ntp.stratum('leaf'), 16);
  assert.ok(s.status().some((x) => x.name === 'NTP leaf' && x.state === 'Unsynchronized'));
});

/** two references (stratum 3 and stratum `b`) and a client with both as upstreams, in that order */
const TWO = (b = 5, refStratum = 3) => `netatlas: 1
devices:
  - {id: refa, type: server, services: {ntp: {stratum: ${refStratum}}}, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}
  - {id: refb, type: server, services: {ntp: {stratum: ${b}}}, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
  - {id: cl, type: server, services: {ntp: {upstreams: [10.0.0.1, 10.0.0.2]}}, interfaces: [{id: eth0, ip: 10.0.0.3/24}]}
  - id: sw
    type: switch
    igmp_mld_snooping: {1: disabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]
links:
  - {id: l1, a: "sw:p1", b: "refa:eth0"}
  - {id: l2, a: "sw:p2", b: "refb:eth0"}
  - {id: l3, a: "sw:p3", b: "cl:eth0"}
`;

const ntpStatus = (s, dev) => s.status().find((x) => x.name === 'NTP ' + dev);

test('an upstream at stratum 15 is not usable (one more is 16): the client stays unsynchronized everywhere — status, its stratum, the snapshot', () => {
  const s = sim(TWO(15, 15));
  s.runTo(300000);
  assert.equal(s.ntp.stratum('cl'), 16);
  assert.equal(s.ntp.synchronized('cl'), false);
  assert.equal(ntpStatus(s, 'cl').state, 'Unsynchronized');
  assert.match(s.ntp.text('cl'), /^unsynchronized \(stratum 16\)/);
  assert.equal(s.snapshot().timing.find((x) => x.dev === 'cl' && x.protocol === 'ntp').synchronized, false);
  assert.ok(s.events().some((e) => e.device === 'cl' && /answers at stratum 15 \(one more would be stratum 16\): no time to take from it/.test(e.detail)));
  // the table still shows what they reported
  assert.deepEqual(s.ntp.table('cl').rows.map((r) => r[3]), ['15', '15']);
});

test('a reference powered off is not synchronized and serves nothing; on again, it is', () => {
  const s = sim(TWO());
  s.runTo(10000);
  assert.equal(ntpStatus(s, 'refa').state, 'Synchronized');
  assert.ok(s.powerOff('refa'));
  s.runTo(s.now + 1000);
  assert.equal(ntpStatus(s, 'refa').state, 'Unsynchronized');
  assert.equal(s.ntp.synchronized('refa'), false);
  assert.match(s.ntp.text('refa'), /powered off/);
  assert.equal(s.snapshot().timing.find((x) => x.dev === 'refa' && x.protocol === 'ntp').synchronized, false);
  assert.ok(s.powerOn('refa'));
  s.runTo(s.now + 120000);
  assert.equal(ntpStatus(s, 'refa').state, 'Synchronized');
});

test('its source lost, the client takes the other upstream whose last response is still fresh and usable — from that response alone', () => {
  const s = sim(TWO(5));
  s.runTo(300000);
  assert.match(s.ntp.text('cl'), /^synchronized to 10\.0\.0\.1/);
  assert.deepEqual(s.ntp.table('cl').rows.map((r) => r[3]), ['3', '5'], 'both answered');
  // refa silent: after 8 polls without its answer, cl takes refb (its last response fresh: stratum 5)
  assert.ok(s.powerOff('refa'));
  s.runTo(s.now + 9 * 64000);
  assert.match(s.ntp.text('cl'), /^synchronized to 10\.0\.0\.2/);
  assert.equal(s.ntp.stratum('cl'), 6);
  assert.ok(s.events().some((e) => e.device === 'cl' && /loses its source 10\.0\.0\.1: no response from 10\.0\.0\.1 for 8 polls .*; it takes refb \(10\.0\.0\.2\), whose last response .* ago said stratum 5/.test(e.detail)));
  assert.equal(ntpStatus(s, 'cl').peer, 'refb');
});

test('its source starts reporting stratum 15: the client gives it up at once and takes the fresh alternative', () => {
  const s = sim(TWO(5));
  s.runTo(300000);
  assert.equal(s.ntp.stratum('cl'), 4);
  // refa's own stratum becomes 15 (its reference degraded): its next response says so
  s.ntp.devs.get('refa').own = 15;
  s.runTo(s.now + 2 * 64000);
  assert.match(s.ntp.text('cl'), /^synchronized to 10\.0\.0\.2/);
  assert.equal(s.ntp.stratum('cl'), 6);
  assert.ok(s.events().some((e) => e.device === 'cl' && /loses its source 10\.0\.0\.1: its source refa answers at stratum 15 \(one more would be stratum 16\)/.test(e.detail)));
});

test('a client powered off forgets what its upstreams said: after it boots it is unsynchronized until one answers again', () => {
  const s = sim(TWO(5));
  s.runTo(300000);
  assert.ok(s.powerOff('cl'));
  s.runTo(s.now + 1000);
  assert.deepEqual(s.ntp.table('cl').rows.map((r) => [r[2], r[3]]), [['never', '—'], ['never', '—']]);
  assert.equal(ntpStatus(s, 'cl').state, 'Unsynchronized');
  assert.ok(s.powerOn('cl'));
  assert.equal(s.ntp.synchronized('cl'), false);
  s.runTo(s.now + 200000);
  assert.equal(s.ntp.synchronized('cl'), true);
});
