// Membership changes and the packets after them (the model, a fake clock for
// the real-time streams): a join learned from its report applies to the very
// next datagram; a leave is pending for the last member queries (robustness
// × last member query interval, 2 × 1 s) and the port goes exactly then, not
// at the next second's sweep; another member behind the same port keeps it;
// the router ports keep their copies; a membership change and a packet at
// the same moment go in the order they happen. On screen: multicast data is
// shown on every cable of its way from the moment each copy is forwarded, so
// there is no backlog of earlier datagrams after a change; the copies
// already forwarded complete their way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const I = load('model/ip.js');

const sim = (text) => withClock(new S.Simulation(model(text)));
const HOUSE = example('private-house.yaml');
const MQ = example('multicast-querier.yaml');

/** A device's Layer 2 decisions for a traffic's packets, in time order. */
const decisions = (s, traffic, dev) =>
  s.engine.flights
    .filter((f) => f.test === traffic && f.view === 'physical')
    .flatMap((f) => s.engine.mcDecisions.get(f.id) || [])
    .filter((d) => d.dev === dev && d.layer === 'l2')
    .sort((a, b) => a.t - b.t);
const port = (d, p) => d.ports.find((x) => x.port === p);

test('a join applies to the very next datagram after the switch processed its report — no query, no restart, nothing before it', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  s.play(3200);
  const q0 = s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').length;
  assert.equal(s.joinGroup('tv', 'wlan0', '239.20.0.1', []), null);
  s.play(3000);
  const learned = s.events().find((e) => e.device === 'core' && e.what === 'snooping' && /port ap is a member port of 239\.20\.0\.1/.test(e.detail));
  assert.ok(learned, 'learned from the report');
  const ds = decisions(s, st.traffic, 'core');
  const before = ds.filter((d) => d.t < learned.t);
  const after = ds.filter((d) => d.t >= learned.t);
  assert.ok(before.length >= 3 && before.every((d) => !port(d, 'ap').sent), 'nothing to the TV before');
  assert.ok(after.length >= 2 && after.every((d) => port(d, 'ap').sent), 'every datagram after');
  assert.match(port(after[0], 'ap').why, /^member port \(/);
  assert.equal(s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').length, q0, 'no query needed');
  assert.equal(st.stream.sent, Math.floor(st.stream.sent), 'the same stream, never restarted');
});

test('a leave: pending for exactly the last member queries (2 × 1 s) — forwarded meanwhile and said so — then the port goes at that moment, the next datagram not forwarded; the leave’s event says pending, then removed', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  assert.equal(s.joinGroup('tv', 'wlan0', '239.20.0.1', []), null);
  s.play(5000);
  const lv = s.actLeave('tv', 'wlan0', '239.20.0.1');
  assert.equal(lv.error, undefined);
  const t0 = s.now;
  assert.match(s.actions().find((v) => v.id === lv.id).summary, /cleanup pending/);
  s.play(6000);
  const gone = s.events().find((e) => e.device === 'core' && e.what === 'member port expired');
  assert.ok(gone, 'removed');
  assert.equal(Math.round(gone.t - t0), 2000, 'exactly robustness × last member query interval after the leave (no sweep delay)');
  assert.match(gone.detail, /nobody answered the group-specific queries after the leave/);
  const ds = decisions(s, st.traffic, 'core').filter((d) => d.t >= t0);
  const pend = ds.filter((d) => d.t < gone.t);
  const after = ds.filter((d) => d.t >= gone.t);
  assert.ok(pend.length >= 1 && pend.every((d) => port(d, 'ap').sent && /^member port, leave pending: it goes in [0-2]\.\d s unless a member answers the group-specific queries$/.test(port(d, 'ap').why)), JSON.stringify(pend.map((d) => port(d, 'ap'))));
  assert.ok(after.length >= 3 && after.every((d) => !port(d, 'ap').sent), 'no datagram to the TV after the removal');
  // no copy towards the TV forwarded after the removal
  assert.ok(!s.engine.flights.some((f) => f.test === st.traffic && f.track.ref === 'link:l-core-apb' && f.t0 >= gone.t));
  assert.match(s.actions().find((v) => v.id === lv.id).summary, /removed at core/);
  // the source goes on: the stream is not stopped by a receiver leaving
  assert.equal(s.actions().find((v) => v.kind === 'stream').status, 'running');
});

test('a shared port: rx3 leaves, rx4 behind the same port of sw answers the group-specific query — the port stays and rx4 keeps receiving; the router ports keep their copies; another member’s port is never touched', () => {
  const s = sim(MQ);
  s.runTo(30000);
  for (const h of ['rx2', 'rx3', 'rx4']) assert.equal(s.joinGroup(h, 'eth0', '239.5.5.5', []), null);
  const st = s.actStream('src', 'eth0', '239.5.5.5', 5004, 1000, 500);
  s.play(4000);
  assert.deepEqual(s.snoopTable('sw').rows.filter((r) => r[1] !== '—').map((r) => r[2]), ['p5', 'p6']);
  const lv = s.actLeave('rx3', 'eth0', '239.5.5.5');
  assert.equal(lv.error, undefined);
  const t0 = s.now;
  s.play(8000);
  assert.deepEqual(s.snoopTable('sw').rows.filter((r) => r[1] !== '—').map((r) => r[2]), ['p5', 'p6'], 'p6 kept: rx4 answered');
  assert.ok(!s.events().some((e) => e.device === 'sw' && e.what === 'member port expired' && e.t > t0));
  const ds = decisions(s, st.traffic, 'sw').filter((d) => d.t > t0 + 3000);
  assert.ok(ds.length >= 3);
  for (const d of ds) {
    assert.equal(port(d, 'p6').sent, true, 'the shared port');
    assert.equal(port(d, 'p5').sent, true, 'rx2, untouched');
    assert.equal(port(d, 'p1').sent, true, 'the router port to q1');
    assert.equal(port(d, 'p4').sent, false, 'rx1 never joined');
  }
  assert.ok(st.stream.rx.get('rx4') >= 6 && st.stream.rx.get('rx2') >= 6);
  assert.match(s.actions().find((v) => v.id === lv.id).summary, /kept at sw \(VLAN 10, port p6\)/);
});

test('the same moment: a report processed before a packet of the same instant is applied to it; at the moment a leave’s port goes, a packet then finds it gone (the order the events happen in, no cache)', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const sd = s.engine.net.devices.get('core');
  const A = (x) => I.parseAddress(x);
  const frame = (msg, src, dst) => ({ src: '00:00:00:00:00:01', dst: '01:00:5e:14:00:01', msg, ip: { src: A(src), dst: A(dst), msg, ttl: 1, l4: {} } });
  const data = () => frame({ protocol: 'mcast', type: 'Data', label: 'UDP → 239.20.0.1:5004', data: {} }, '192.168.20.101', '239.20.0.1');
  const report = (leave) => frame({ protocol: 'igmp', type: 'Report', label: 'IGMPv3 Report', data: { group: '239.20.0.1', leave } }, '192.168.20.100', '224.0.0.22');
  const t = s.now;
  // a packet, then the report, then a packet — all at t
  assert.ok(!s.multicast.snoop(sd, 'up2', 20, data(), t).ports.has('ap'), 'before the report');
  s.multicast.snoop(sd, 'ap', 20, report(false), t);
  assert.ok(s.multicast.snoop(sd, 'up2', 20, data(), t).ports.has('ap'), 'right after it, the same instant');
  // the leave: pending until t + 2 s; a packet at exactly that moment finds it gone
  s.multicast.snoop(sd, 'ap', 20, report(true), t + 10);
  const pend = s.multicast.snoop(sd, 'up2', 20, data(), t + 2009);
  assert.ok(pend.ports.has('ap') && pend.leaving.has('ap'), 'pending, marked as leaving');
  assert.ok(!s.multicast.snoop(sd, 'up2', 20, data(), t + 2010).ports.has('ap'), 'gone at its moment');
});

test('on screen: a stream’s copies show from the moment they are forwarded, on every cable at once (no backlog of earlier datagrams); after the leave took effect no new copy towards the TV, the ones forwarded before complete their way', () => {
  const s = sim(HOUSE);
  const host = { engine: s.engine, shown: (f) => f.view === 'physical', typical: () => s.engine.hopTime(), headers: (f) => f.hdr, foreground: () => s.foregroundActive() };
  const p = new P.Pacer(host, 48);
  const seen = new Map();
  // (the display clock when the TV's member port was removed, as soon as a frame sees it)
  let goneClock = null;
  let leaveAt = Infinity;
  const frame = () => {
    const before = p.clock;
    p.frame(50);
    for (const it of p.items) if (it.f.protocol === 'mcast' && it.f.view === 'physical' && !seen.has(it.f.id)) seen.set(it.f.id, { it, clock: before });
    if (goneClock === null && s.events().some((e) => e.device === 'core' && e.what === 'member port expired' && e.t >= leaveAt)) goneClock = p.clock;
  };
  const run = (ms) => {
    for (let t = 0; t < ms; t += 50) frame();
  };
  // (to 40 s of simulated time: the scenario's startup is shown in detail first, the simulation waiting for its dots)
  for (let i = 0; i < 20000 && s.now < 40000; i++) frame();
  assert.ok(s.now >= 40000);
  s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  s.joinGroup('tv', 'wlan0', '239.20.0.1', []);
  // (the join and the example datagram are shown hop by hop first, the simulation waiting for them; then the flow)
  for (let i = 0; i < 8000 && Array.from(seen.values()).filter(({ it }) => !it.example && it.f.track.ref === 'link:w-tv').length < 10; i++) frame();
  // the stream's example after the Network events (its first datagram since): hop by hop, each copy after the one it was
  // forwarded from has arrived on screen — the tree as it is, seen growing
  const ex = Array.from(seen.values()).filter(({ it }) => it.example).map(({ it }) => it);
  assert.ok(ex.length >= 2, String(ex.length));
  for (const it of ex) if (it.parent && it.parent.example) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6, `${it.f.label} on ${it.f.track.ref} before its upstream copy arrived`);
  // the backlog: every other copy starts on screen when it is forwarded (in the frame that forwards it), whatever its place on the way
  const lags = Array.from(seen.values())
    .filter(({ it }) => !it.example)
    .map(({ it, clock }) => it.d0 - clock);
  assert.ok(lags.length > 20);
  assert.ok(Math.max(...lags.map((l) => Math.abs(l))) <= 50 + 1e-6, `display lag ${Math.max(...lags)} ms`);
  leaveAt = s.now;
  s.leaveGroup('tv', 'wlan0', '239.20.0.1');
  for (let i = 0; i < 4000 && goneClock === null; i++) frame();
  run(10000);
  const gone = s.events().find((e) => e.device === 'core' && e.what === 'member port expired' && e.t >= leaveAt);
  const tv = Array.from(seen.values()).filter(({ it }) => it.f.track.ref === 'link:w-tv').map(({ it }) => it);
  assert.ok(tv.length >= 10);
  assert.ok(tv.every((it) => it.f.t0 < gone.t), 'no copy towards the TV forwarded after the removal');
  // the last ones (forwarded during the pending leave) were drawn to their end: on screen at most a hop's time after the removal
  const last = tv.reduce((m, it) => Math.max(m, p.arrival(it)), 0);
  assert.ok(last <= goneClock + P.HOP_MAX + 100, `${last - goneClock} ms after the removal`);
  assert.ok(tv.filter((it) => it.f.t0 >= leaveAt).every((it) => it.drawn), 'the copies of the pending leave are drawn, not erased');
});
