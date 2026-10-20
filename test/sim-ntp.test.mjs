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
