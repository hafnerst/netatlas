// The IGMP querier election, the queries and the hosts' answers, and Leave
// multicast group, without a browser (analysis/sim/multicast.ts): the
// election starts by itself with the simulation (startup queries, the
// lowest address wins, provisional until its startup queries are sent),
// scoped to the LAN its queries reach (two LANs with the same VLAN ID elect
// apart; a device may hold different roles on different LANs), no
// candidate (and no query heard) said as such, snooping alone makes no
// candidate; failover after the other querier present interval and
// recovery by the same rules, one schedule each (no duplicate queries);
// periodic queries; members answer and stay learned over many query cycles,
// the host's membership (its intent) apart from what the network learned;
// a leave through the network: the host's answers stop, the switch's port
// goes after the querier's group queries, a port with another member behind
// it stays, the source goes on; flapping only on interfaces. The fake clock
// drives the streams of Network events (no sleeping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const MQ = example('multicast-querier.yaml');
const sim = (text = MQ, opts) => withClock(new S.Simulation(model(text), opts));
const ev = (s, f) => s.events().filter(f);
/** "dev:LAN=role" for every candidate. */
const roles = (s) => s.multicast.querierRoles().map((q) => `${q.dev}:${q.lan}=${q.role}`);
const role = (s, dev, lan = 'VLAN 10') => (s.multicast.querierRoles().find((q) => q.dev === dev && q.lan === lan) || {}).role;
/** General queries a device sent (the log), after a time. */
const queries = (s, dev, after = -1) => ev(s, (e) => e.device === dev && e.kind === 'message' && e.what === 'Query' && /General Query/.test(e.detail) && e.t > after);
const view = (s, id) => s.actions().find((v) => v.id === id);

// ------------------------------------------------------------------ the election

test('the election starts by itself: every candidate queries at once (provisionally the querier); the lowest address wins; the startup queries, then one every query interval', () => {
  const s = sim();
  // before the interfaces are up: down, nothing sent
  s.runTo(500);
  assert.deepEqual(roles(s), ['q1:VLAN 10=down', 'q2:VLAN 10=down', 'q3:VLAN 10=down']);
  s.runTo(4000);
  // both of LAN A queried at their start; q2 heard q1's (lower) and stopped; q1 is the querier only for now (its startup queries)
  assert.equal(queries(s, 'q1').length, 1);
  assert.equal(queries(s, 'q2').length, 1);
  assert.deepEqual(roles(s), ['q1:VLAN 10=starting', 'q2:VLAN 10=non-querier', 'q3:VLAN 10=starting']);
  assert.match(ev(s, (e) => e.device === 'q2' && e.what === 'not querier')[0].detail, /^q2:g0 hears a query from 10\.5\.0\.1 \(lower than its 10\.5\.0\.2\): it stops querying \(querier election\)$/);
  // the startup queries: robustness (2) of them, a quarter of the query interval (20 s) apart; then settled
  s.runTo(12000);
  const q1 = queries(s, 'q1');
  assert.equal(q1.length, 2);
  assert.equal(Math.round(q1[1].t - q1[0].t), 5000);
  assert.equal(role(s, 'q1'), 'querier');
  assert.ok(ev(s, (e) => e.device === 'q1' && e.what === 'querier' && /startup queries are sent and no lower address was heard/.test(e.detail)).length === 1);
  // then one every query interval, from the querier only
  s.runTo(80000);
  const later = queries(s, 'q1', 12000).map((e) => Math.round(e.t / 1000));
  assert.deepEqual(later.map((t, i) => (i ? t - later[i - 1] : 20)), later.map(() => 20), later.join(','));
  assert.equal(queries(s, 'q2', 4000).length, 0, 'the non-querier sends none');
  // the tables say the same
  const t1 = s.multicast.querierTable('q1').rows[0];
  assert.deepEqual(t1.slice(0, 5), ['VLAN 10 (g0)', 'IGMP', '10.5.0.1', 'Querier', 'itself']);
  const t2 = s.multicast.querierTable('q2').rows[0];
  assert.deepEqual(t2.slice(0, 5), ['VLAN 10 (g0)', 'IGMP', '10.5.0.2', 'Non-querier', '10.5.0.1 (q1)']);
  assert.match(t2[5], /^\d+ s$/, 'how long until it would take over');
  // the queries are real messages on the cables: drawn and inspectable, from q1:g0 to 224.0.0.1
  const msg = queries(s, 'q1')[0];
  assert.equal(msg.hdr.l3[0].dst, '224.0.0.1');
  assert.equal(msg.hdr.l3[0].src, '10.5.0.1');
});

test('scoped to the LAN its queries reach: LAN B (the same VLAN ID, not cabled to A) elects its own; one candidate is the querier alone', () => {
  const s = sim();
  s.runTo(15000);
  assert.equal(role(s, 'q3'), 'querier', 'q3 is LAN B’s querier although q1 (lower) queries a VLAN 10 too');
  assert.ok(!ev(s, (e) => e.device === 'q3' && e.what === 'not querier').length);
  // hb hears q3, rx1 hears q1
  assert.match(s.memberTable('hb').notes.join(' '), /eth0: the last IGMP query from 10\.6\.0\.1 \(q3\)/);
  assert.match(s.memberTable('rx1').notes.join(' '), /eth0: the last IGMP query from 10\.5\.0\.1 \(q1\)/);
});

test('one device on two LANs holds a role on each; no candidate at all is said as such; snooping enabled makes no candidate', () => {
  const two = `netatlas: 1
title: two LANs
devices:
  - {id: r, type: router, protocols: {pim: {mode: dense}}, simulation: {igmp_query_interval: 20}, interfaces: [{id: g0, ip: 10.1.0.1/24}, {id: g1, ip: 10.2.0.9/24}]}
  - {id: s, type: router, protocols: {pim: {mode: dense}}, simulation: {igmp_query_interval: 20}, interfaces: [{id: g0, ip: 10.2.0.2/24}]}
  - {id: h, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.11/24}]}
links:
  - {id: a, a: "r:g0", b: "h:eth0"}
  - {id: b, a: "r:g1", b: "s:g0"}
checks: {protocol-unused: "off"}
`;
  const s = sim(two);
  s.runTo(15000);
  assert.deepEqual(s.multicast.querierRoles('r').map((q) => `${q.iface}:${q.role}`), ['g0:querier', 'g1:non-querier']);
  assert.equal(s.multicast.querierRoles('s')[0].role, 'querier');
  // no candidate: a switch with snooping enabled and an address, but no snooping querier; no router
  const none = sim(`netatlas: 1
title: none
devices:
  - {id: sw, type: switch, igmp_mld_snooping: {1: enabled}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}], logical_interfaces: [{id: Vlan1, type: virtual, vlan: 1, ip: 10.9.0.2/24}]}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.11/24}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.12/24}]}
links:
  - {id: a, a: "h1:eth0", b: "sw:p1"}
  - {id: b, a: "h2:eth0", b: "sw:p2"}
`);
  none.runTo(60000);
  assert.deepEqual(none.multicast.querierRoles(), [], 'snooping enabled makes no candidate');
  assert.equal(none.multicast.querierDevice('sw'), false);
  assert.ok(!ev(none, (e) => e.what === 'Query').length);
  assert.match(none.memberTable('h1').notes.join(' '), /eth0: no IGMP query heard yet \(no querier reaches it, or not yet\)/);
});

test('failover and recovery: the querier off, the other takes over after the other querier present interval; back, it starts afresh and wins again; one schedule each', () => {
  const s = sim();
  s.runTo(30000);
  s.powerOff('q1');
  assert.equal(role(s, 'q1'), 'down');
  // q1's last query was at t = 27 s; 2 × 20 s + 10 s ÷ 2 = 45 s later q2 takes over (not before)
  s.runTo(71000);
  assert.equal(role(s, 'q2'), 'non-querier');
  s.runTo(73000);
  assert.equal(role(s, 'q2'), 'querier');
  assert.match(ev(s, (e) => e.device === 'q2' && e.what === 'querier')[0].detail, /^q2:g0 takes over as IGMP querier: no query from 10\.5\.0\.1 \(q1\) for 45 s \(other querier present interval\)$/);
  // q2 queries every 20 s from its takeover, once each
  s.runTo(150000);
  const q2 = queries(s, 'q2', 72000).map((e) => Math.round(e.t / 1000));
  assert.ok(q2.length >= 3 && q2.every((t, i) => !i || t - q2[i - 1] === 20), q2.join(','));
  // q1 powered on: it boots, starts as querier candidate again, q2 hears the lower address and yields
  const on = s.now;
  s.powerOn('q1');
  s.runTo(s.now + 120000);
  assert.equal(role(s, 'q1'), 'querier');
  assert.equal(role(s, 'q2'), 'non-querier');
  // no duplicate schedule: its two startup queries 5 s apart, then exactly one every 20 s
  const q1 = queries(s, 'q1', on).map((e) => Math.round(e.t / 1000));
  const gaps = q1.slice(1).map((t, i) => t - q1[i]);
  assert.ok(gaps[0] === 5 && gaps.slice(1).every((g) => g === 20) && gaps.length >= 3, q1.join(','));
  // (q1 boots first: its boot time) once q1 queried again, q2 sends none
  assert.equal(queries(s, 'q2', q1[0] * 1000 + 1000).length, 0, 'q2 silent again');
});

test('an interface flapping on the querier: down, its candidacy stops; up again, it starts afresh (startup) and wins again; the other never queries meanwhile (shorter than the other querier present interval)', () => {
  const s = sim(MQ, { params: { 'flap-cycles': 2, 'flap-down': 3000, 'flap-up': 6000 } });
  s.runTo(30000);
  assert.ok(s.actFlap('iface:q1:g0').flap);
  s.runTo(31000);
  assert.equal(role(s, 'q1'), 'down');
  s.runTo(60000);
  assert.equal(role(s, 'q1'), 'querier');
  assert.equal(queries(s, 'q2', 30000).length, 0);
  assert.ok(ev(s, (e) => e.device === 'q1' && e.what === 'querier (starting)').length >= 2, 'started again after each flap');
});

// ------------------------------------------------------------------ members: answers and leaves

test('members stay learned over many query cycles by answering the queries; the host’s membership apart from what the network learned: a link down drops the switch’s port, not the host’s membership', () => {
  const s = sim();
  s.runTo(8000);
  assert.equal(s.joinGroup('rx1', 'eth0', '239.5.5.5', []), null);
  s.runTo(12000);
  const port = () => s.snoopTable('sw').rows.find((r) => r[1] === '239.5.5.5 (IGMP)' && r[2] === 'p4');
  assert.ok(port());
  // the membership interval is 2 × 20 s + 10 s = 50 s; at 200 s it is still learned: the answers to the queries refresh it
  s.runTo(200000);
  assert.ok(port(), 'refreshed by the answers to the queries');
  const answers = ev(s, (e) => e.device === 'rx1' && e.what === 'Report' && /answers the general query of 10\.5\.0\.1/.test(e.detail));
  assert.ok(answers.length >= 8, String(answers.length));
  for (const a of answers) assert.match(a.detail, /after \d+(\.\d+)? (ms|s) \(random, up to 10 s\)/);
  // its cable down: the switch forgets the port at once; the host keeps its membership (its intent)
  s.fail('link:l-rx1');
  s.runTo(s.now + 100);
  assert.equal(port(), undefined);
  assert.deepEqual(s.memberTable('rx1').rows.map((r) => r[1]), ['239.5.5.5']);
  // back: its answer to the next query brings the port back, without another join
  s.restore('link:l-rx1');
  s.runTo(s.now + 35000);
  assert.ok(port(), 'learned again from its answer');
});

test('Leave multicast group: the leave goes through the network; the switch’s port goes after the querier’s group queries; delivery to it stops; the others and the source go on; no later answer for the group', () => {
  const s = sim();
  s.runTo(15000);
  for (const h of ['rx1', 'rx2']) assert.equal(s.joinGroup(h, 'eth0', '239.5.5.5', []), null);
  s.runTo(18000);
  const st = s.actStream('src', 'eth0', '239.5.5.5', 5004, 1000, 1316);
  s.play(4000);
  assert.ok(st.stream.rx.get('rx1') >= 3 && st.stream.rx.get('rx2') >= 3);
  // refused: not a member here
  assert.match(s.actLeave('rx1', 'eth0', '239.9.9.9').error, /^rx1:eth0 is no member of 239\.9\.9\.9 \(its groups: 239\.5\.5\.5\)$/);
  assert.match(s.actLeave('rx3', 'eth0', '239.5.5.5').error, /^rx3:eth0 is no member of 239\.5\.5\.5 \(it has joined no group\)$/);
  // the leave: what the network had learned on rx1's way (its port at sw, the routers' group)
  const lv = s.actLeave('rx1', 'eth0', '239.5.5.5');
  assert.deepEqual(lv.leave.watch.map((w) => w.where), ['sw (VLAN 10, port p4)', 'q1:g0', 'q2:g0']);
  // in progress: sent, the cleanup pending (never "removed" before it is)
  let v = view(s, lv.id);
  assert.equal(v.status, 'running');
  assert.equal(v.summary, 'leave sent · cleanup pending (3 of 3)');
  // its leave report: drawn and inspectable with the event's id
  const sent = s.events().filter((e) => e.test === lv.traffic && e.kind === 'message');
  assert.equal(sent.length, 1);
  assert.match(sent[0].detail, /^IGMPv3 Report from rx1 \(10\.5\.0\.11\) to 224\.0\.0\.22: TO_IN \(239\.5\.5\.5, \{\}\), leaves the group$/);
  // q1, the querier, asks twice (robustness), 1 s apart; nobody behind p4 answers: the port goes
  s.play(4000);
  v = view(s, lv.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.summary, 'leave sent · removed at sw (VLAN 10, port p4) · kept at q1:g0 (10.5.0.12 reports it), q2:g0 (10.5.0.12 reports it): another member there answered');
  // (it asks once: rx2 answers, the group stays on its LAN, no second query is needed)
  assert.equal(ev(s, (e) => e.device === 'q1' && e.what === 'Query' && /Group-Specific Query from q1 \(10\.5\.0\.1\) to 239\.5\.5\.5/.test(e.detail) && e.t > lv.at).length, 1);
  assert.ok(ev(s, (e) => e.device === 'rx2' && /answers the group-specific query of 10\.5\.0\.1/.test(e.detail) && e.t > lv.at).length === 1);
  // delivery: none to rx1 any more, rx2 goes on, the source too
  const r1 = st.stream.rx.get('rx1');
  const r2 = st.stream.rx.get('rx2');
  const sent0 = st.stream.sent;
  s.play(5000);
  assert.equal(st.stream.rx.get('rx1'), r1);
  assert.ok(st.stream.rx.get('rx2') >= r2 + 4);
  assert.ok(st.stream.sent >= sent0 + 4, 'the source is not stopped by a receiver’s leave');
  assert.ok(!s.engine.flights.some((f) => f.t0 > lv.at + 4000 && f.track.ref === 'link:l-rx1' && f.protocol === 'mcast'));
  // later queries: rx1 answers none for the group (no rejoin)
  s.runTo(s.now + 100000);
  assert.ok(!ev(s, (e) => e.device === 'rx1' && e.what === 'Report' && e.t > lv.at + 100).length);
  assert.deepEqual(s.memberTable('rx1').rows, []);
  assert.ok(!s.snoopTable('sw').rows.some((r) => r[2] === 'p4'));
});

test('a port with another member behind it stays: rx3 leaves, rx4 (behind the same port) answers the group query; the leave says kept', () => {
  const s = sim();
  s.runTo(15000);
  for (const h of ['rx3', 'rx4']) assert.equal(s.joinGroup(h, 'eth0', '239.5.5.5', []), null);
  s.runTo(20000);
  const lv = s.actLeave('rx3', 'eth0', '239.5.5.5');
  assert.deepEqual(lv.leave.watch.map((w) => w.where), ['sw (VLAN 10, port p6)', 'q1:g0', 'q2:g0']);
  s.runTo(s.now + 5000);
  s.actions();
  const v = view(s, lv.id);
  assert.equal(v.status, 'completed');
  assert.match(v.summary, /^leave sent · kept at sw \(VLAN 10, port p6\) \(10\.5\.0\.14 reports it\), q1:g0 \(10\.5\.0\.14 reports it\), q2:g0 \(10\.5\.0\.14 reports it\): another member there answered$/);
  assert.ok(s.snoopTable('sw').rows.some((r) => r[2] === 'p6' && /reported by 10\.5\.0\.14/.test(r[3])));
  assert.ok(ev(s, (e) => e.device === 'rx4' && /answers the group-specific query of 10\.5\.0\.1/.test(e.detail)).length >= 1);
});

test('a leave that can’t be sent (the host’s cable is down): failed with the reason; the membership ends at the host all the same', () => {
  const s = sim();
  s.runTo(15000);
  s.joinGroup('rx2', 'eth0', '239.5.5.5', []);
  s.runTo(18000);
  s.shut('rx2', 'eth0');
  s.runTo(18100);
  const lv = s.actLeave('rx2', 'eth0', '239.5.5.5');
  const v = view(s, lv.id);
  assert.equal(v.status, 'failed');
  assert.match(v.summary, /^rx2:eth0 could not send its leave \(its interface or device is down\) · its membership ended locally$/);
  assert.deepEqual(s.memberTable('rx2').rows, []);
});

test('an IPv6 leave says MLD, never IGMP; the form’s note names the message, the address and the VLAN', () => {
  const s = sim(MQ.replace('{id: eth0, ip: 10.5.0.11/24}', '{id: eth0, ip: [10.5.0.11/24, "2001:db8:5::11/64"]}').replace('{id: eth0, ip: 10.5.0.20/24}', '{id: eth0, ip: [10.5.0.20/24, "2001:db8:5::20/64"]}'));
  s.runTo(10000);
  assert.equal(s.joinGroup('rx1', 'eth0', 'ff05::5', []), null);
  assert.equal(s.joinGroup('rx1', 'eth0', '239.5.5.5', []), null);
  assert.equal(s.leaveContext('rx1', 'eth0', 'ff05::5'), 'rx1:eth0 (2001:db8:5::11, VLAN 10) sends an MLDv2 report that blocks ff05::5 to ff02::16; its membership ends at once.');
  assert.equal(s.leaveContext('rx1', 'eth0', '239.5.5.5'), 'rx1:eth0 (10.5.0.11, VLAN 10) sends an IGMPv3 report that blocks 239.5.5.5 to 224.0.0.22; its membership ends at once.');
  const lv = s.actLeave('rx1', 'eth0', 'ff05::5');
  const m = s.events().find((e) => e.test === lv.traffic && e.kind === 'message');
  assert.match(m.detail, /^MLDv2 Report from rx1 \(2001:db8:5::11\) to ff02::16/);
  // the other group stays
  assert.deepEqual(s.memberTable('rx1').rows.map((r) => r[1]), ['239.5.5.5']);
});

// ------------------------------------------------------------------ flapping: interfaces only

test('flapping is an interface action: a cable is refused by the simulation (not only the menus); the cable’s attribute moved to its port', () => {
  const s = sim();
  s.runTo(5000);
  const bad = s.actFlap('link:l-q1');
  assert.equal(bad.error, 'cable l-q1 is no interface: flapping is an interface action (choose a device and its interface)');
  assert.equal(s.startFlap('link:l-q1'), false);
  assert.ok(!s.netEvents().some((e) => e.kind === 'flap'));
  // the port flaps, its cable follows, the port stays administratively up
  const ok = s.actFlap('iface:rx1:eth0');
  assert.equal(ok.error, undefined);
  s.runTo(s.now + 1000);
  assert.deepEqual(s.engine.portStatus('rx1', 'eth0'), { admin: 'up', oper: 'down', why: 'flapping (down)' });
  assert.equal(s.engine.cableUp('l-rx1'), false);
  // the model's flapping is a port's: protocol-simulation's acc-sw:up2 flaps from the start
  const pe = sim(example('protocol-simulation.yaml'));
  pe.runTo(15000);
  assert.ok(pe.netEvents().some((e) => e.kind === 'flap' && e.ref === 'iface:acc-sw:up2'));
});
