// The real-time schedule of Network events (analysis/sim/realtime.ts) and the
// streams on it: a stream started from Network events sends at its interval
// of real time, on its own grid from its start (the first datagram at once),
// whatever simulated time, the playback speed or the scenario do; several
// run side by side, each on its own grid, the same deadline in the order
// they were started; a late frame keeps the grid (no drift), a stall sends
// once and counts the rest as skipped (no burst); paused, the schedule
// stands; Stop cancels a stream's future sends, closing all. All on an
// injected clock: no test sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, withClock } from './helpers.mjs';

const R = load('analysis/sim/realtime.js');
const S = load('analysis/sim/simulation.js');

/** A schedule on a fake clock; `run(ms, frame)` pumps once a frame. */
function schedule() {
  const c = { t: 0 };
  const r = new R.RealTimeScheduler(() => c.t);
  const log = [];
  const add = (name, iv) => r.add(iv, (n) => log.push([name, n, c.t]));
  const run = (ms, frame = 16) => {
    const end = c.t + ms;
    while (c.t < end) {
      c.t = Math.min(end, c.t + frame);
      r.pump();
    }
  };
  return { c, r, log, add, run, of: (name) => log.filter((x) => x[0] === name) };
}

test('one entry: the first send at once, then one every interval (1 s, 2 s, 250 ms), never early', () => {
  for (const iv of [1000, 2000, 250]) {
    const s = schedule();
    s.add('a', iv);
    assert.deepEqual(s.log, [['a', 0, 0]], 'the first at once');
    s.run(10000);
    const a = s.of('a');
    assert.equal(a.length, 10000 / iv + 1, `${iv} ms: ${a.length}`);
    for (const [, n, t] of a) {
      assert.ok(t >= n * iv, `send ${n} not before its deadline`);
      assert.ok(t - n * iv < 16 + 1e-9, `send ${n} within a frame of its deadline`);
    }
  }
});

test('two entries with the same interval, started together: each at 0, 1, 2, 3 s, in the order added; never taking turns', () => {
  const s = schedule();
  s.add('a', 1000);
  s.add('b', 1000);
  s.run(3000);
  // (frames of 16 ms: the first frame at or after each deadline)
  assert.deepEqual(s.of('a').map((x) => x[2]), [0, 1008, 2000, 3000]);
  assert.deepEqual(s.of('a').map((x) => x[2]), s.of('b').map((x) => x[2]), 'the same frames');
  // the same deadline: a before b, every time
  const order = s.log.map((x) => x[0]).join('');
  assert.equal(order, 'abababab');
});

test('different intervals and start times: each keeps its own grid and offset; adding one changes nothing of another', () => {
  const s = schedule();
  s.add('a', 1000);
  s.run(300);
  s.add('b', 700);
  s.run(4700);
  // a: 0, 1, 2, 3, 4, 5 s; b from 0.3 s every 0.7 s: 0.3, 1.0, 1.7 … 4.5 (≤ 5 s)
  assert.deepEqual(s.of('a').map((x) => x[1]), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(s.of('b').map((x) => x[1]), [0, 1, 2, 3, 4, 5, 6]);
  for (const [, n, t] of s.of('a')) assert.ok(t >= n * 1000 && t - n * 1000 < 16, `a ${n} at ${t}`);
  for (const [, n, t] of s.of('b')) assert.ok(t >= 300 + n * 700 && t - (300 + n * 700) < 16, `b ${n} at ${t}`);
  // the same deadline (a's 1 s, b's 0.3 + 0.7 s): in one frame, a (added first) before b
  const one = s.log.filter((x) => (x[0] === 'a' && x[1] === 1) || (x[0] === 'b' && x[1] === 1));
  assert.deepEqual(one.map((x) => x[0]), ['a', 'b']);
  assert.equal(one[0][2], one[1][2]);
});

test('late frames keep the grid (no drift); a stall longer than an interval sends once and counts the rest as skipped, never a burst', () => {
  const s = schedule();
  s.add('a', 1000);
  // frames late by up to 90 ms, irregularly: a thousand seconds later the sends are still on the grid
  let k = 0;
  for (let i = 0; i < 20000; i++) {
    s.c.t += 16 + ((k = (k * 7 + 3) % 11) === 0 ? 90 : 0);
    s.r.pump();
  }
  const a = s.of('a');
  const last = a[a.length - 1];
  assert.equal(a.length, Math.floor(s.c.t / 1000) + 1);
  assert.ok(last[2] - last[1] * 1000 < 110, `the last send ${last[2] - last[1] * 1000} ms after its deadline (no drift)`);
  assert.equal(s.r.get(1).skipped, 0);
  // a stall of 3.5 s: one send (for the latest deadline), two skipped; then on the grid again
  const before = a.length;
  const n0 = a[a.length - 1][1];
  s.c.t = (n0 + 1) * 1000 + 2500;
  s.r.pump();
  assert.equal(s.of('a').length, before + 1, 'one send, not three');
  assert.equal(s.r.get(1).skipped, 2);
  assert.equal(s.of('a')[before][1], n0 + 3, 'for the latest deadline');
  s.c.t = (n0 + 4) * 1000;
  s.r.pump();
  assert.equal(s.of('a')[before + 1][1], n0 + 4, 'the grid goes on');
});

test('paused, the schedule stands: nothing is sent, and resuming goes on from there (shifted by the pause, nothing caught up)', () => {
  const s = schedule();
  s.add('a', 1000);
  s.run(2500);
  assert.equal(s.of('a').length, 3);
  s.r.setRunning(false);
  s.run(10000);
  assert.equal(s.of('a').length, 3, 'nothing while paused');
  s.r.setRunning(true);
  s.r.pump();
  assert.equal(s.of('a').length, 3, 'nothing caught up');
  s.run(500);
  assert.equal(s.of('a').length, 4, 'the next one 0.5 s of playing time later (its deadline 3 s)');
  assert.equal(s.r.now(), 3000);
});

test('removing one entry leaves the others; a removed entry never sends again, even from the pump under way; clear removes all', () => {
  const s = schedule();
  const a = s.add('a', 1000);
  // c's second send removes b (as a send's consequences could): b's send, due in the same pump after c's, is not made
  let b = null;
  s.r.add(1000, (n) => n === 1 && s.r.remove(b.id));
  b = s.add('b', 1000);
  s.run(4000);
  assert.deepEqual(s.of('b').map((x) => x[1]), [0], 'b: nothing after its removal');
  assert.equal(s.of('a').length, 5, 'a goes on');
  assert.equal(s.r.remove(a.id), true);
  assert.equal(s.r.remove(a.id), false, 'once');
  s.add('d', 500);
  s.r.clear();
  assert.equal(s.r.active(), false);
  s.run(3000);
  assert.equal(s.of('a').length, 5);
  assert.equal(s.of('d').length, 1);
});

// ------------------------------------------------------------ streams of Network events on it

/** The busy example (members of 239.1.1.1 in the campus and site B), after its start: srv and pc2 will stream to that group. */
function busy() {
  const s = withClock(new S.Simulation(model(example('protocol-simulation.yaml'))));
  s.play(8000, 100);
  return s;
}
const sends = (s, a) => s.engine.flights.filter((f) => f.test === a.traffic && f.sender === a.stream.dev && f.protocol === 'mcast' && f.view === 'physical' && f.parent === undefined);

test('two streams of 1 s started together: each sends at 0, 1, 2, 3 s of real time; both have datagrams on their way at once; the counts are originating datagrams', () => {
  const s = busy();
  const a = s.actStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500);
  const b = s.actStream('pc2', 'eth0', '239.1.1.1', 5012, 1000, 500);
  assert.ok(!a.error && !b.error, a.error || b.error);
  assert.ok(a.traffic !== b.traffic, 'each its own traffic id');
  s.play(3000);
  assert.equal(a.stream.sent, 4);
  assert.equal(b.stream.sent, 4);
  // the same simulated moments for both (the clock ran with real time): not alternating
  // (a datagram's hops from its source: routed on, a router's hop starts afresh; the moments they were sent)
  const at = (st) => Array.from(new Set(sends(s, st).map((f) => Math.round(f.t0 / 100)))).sort((x, y) => x - y);
  const ta = at(a);
  const tb = at(b);
  assert.equal(ta.length, 4);
  assert.deepEqual(ta, tb);
  // replicas are not originating datagrams
  assert.ok(s.engine.flights.filter((f) => f.test === a.traffic).length > 4 * 2);
  const v = s.actions().filter((x) => x.kind === 'stream');
  assert.deepEqual(v.map((x) => x.status), ['running', 'running']);
  assert.ok(v.every((x) => /^4 datagrams sent, every 1 s of real time · received by /.test(x.summary)), v.map((x) => x.summary).join(' | '));
  // once the trees are built (through the RP), both reach the members on both sites: pc1 (campus) and rx (site B)
  s.play(7000);
  assert.equal(a.stream.sent, 11);
  assert.equal(b.stream.sent, 11);
  for (const st of [a.stream, b.stream]) assert.ok(st.rx.get('pc1') > 0 && st.rx.get('rx') > 0, JSON.stringify([...st.rx]));
  assert.ok(v.every((x) => x.details.some((d) => /^Stream #\d+: UDP to 239\.1\.1\.1:50(10|12) from source port \d+, 500 bytes every 1 s of real time/.test(d))));
});

test('streams with other intervals and start times keep theirs; the scenario’s simulated time, held or jumping, changes nothing; no waiting for forwarding', () => {
  const s = busy();
  const a = s.actStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500);
  s.play(400);
  const b = s.actStream('pc2', 'eth0', '239.1.1.1', 5012, 2000, 500);
  s.play(5600);
  // a: 0 … 6 s; b from 0.4 s every 2 s: 0.4, 2.4, 4.4
  assert.equal(a.stream.sent, 7);
  assert.equal(b.stream.sent, 3);
  // the clock standing (held: a dot on screen) for 3 s of real time: the datagrams still go, at that simulated time, before the earlier ones were forwarded
  const now = s.now;
  for (let i = 0; i < 30; i++) {
    s.clock.t += 100;
    s.pumpRealTime();
  }
  assert.equal(a.stream.sent, 10);
  assert.equal(b.stream.sent, 5);
  assert.equal(s.now, now);
  assert.equal(sends(s, a).filter((f) => Math.abs(f.t0 - now) < 1).length, 3, 'three datagrams at the same simulated moment');
  // simulated time jumping ahead (Skip idle, a busy scenario): nothing more
  s.runTo(s.now + 120000);
  assert.equal(a.stream.sent, 10);
  assert.equal(b.stream.sent, 5);
});

test('Stop one stream: its future sends cancelled, the other goes on; paused: Paused, nothing sent; closing the simulation: nothing scheduled any more', () => {
  const s = busy();
  const a = s.actStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500);
  const b = s.actStream('pc2', 'eth0', '239.1.1.1', 5012, 1000, 500);
  s.play(2000);
  assert.equal(s.realtime.size, 2);
  assert.ok(s.actionControl(a.id, 'stop'));
  assert.equal(s.realtime.size, 1, 'its schedule removed');
  s.play(3000);
  assert.equal(a.stream.sent, 3);
  assert.equal(b.stream.sent, 6);
  assert.equal(s.actions().find((x) => x.id === a.id).status, 'stopped');
  // paused (the page's play state): the schedule stands, the event says Paused
  s.setRealTimeRunning(false);
  s.clock.t += 10000;
  s.pumpRealTime();
  assert.equal(b.stream.sent, 6);
  assert.equal(s.actions().find((x) => x.id === b.id).status, 'paused');
  s.setRealTimeRunning(true);
  s.play(1000);
  assert.equal(b.stream.sent, 7, 'on from where it was, nothing caught up');
  assert.equal(s.actions().find((x) => x.id === b.id).status, 'running');
  // one stream per interface and group: a second Start is refused, no second schedule
  const again = s.actStream('pc2', 'eth0', '239.1.1.1', 5012, 1000, 500);
  assert.match(again.error, /already streams to 239\.1\.1\.1/);
  assert.equal(s.realtime.size, 1);
  // closed: nothing sends again
  s.close();
  assert.equal(s.realtime.size, 0);
  s.play(3000);
  assert.equal(b.stream.sent, 7);
});

test('a stream’s source powered off: its datagrams are not sent (counted apart, said); powered on and booted, it sends again on its grid', () => {
  const s = busy();
  const a = s.actStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500);
  s.play(1000);
  assert.equal(a.stream.sent, 2);
  s.powerOff('srv');
  s.play(3000);
  assert.equal(a.stream.sent, 2, 'nothing from a device that is off');
  const v = s.actions().find((x) => x.id === a.id);
  assert.match(v.summary, /not sending: srv is off/);
  assert.ok(v.details.some((d) => /^Not sent: 3 \(3 while srv was off\)\.$/.test(d)), v.details.join(' | '));
  s.powerOn('srv');
  // it boots (simulated time) before it sends again
  s.play(70000, 200);
  assert.ok(a.stream.sent > 10, String(a.stream.sent));
  assert.doesNotMatch(s.actions().find((x) => x.id === a.id).summary, /not sending/);
});

test('a model’s streams (the scenario) stay on the simulated clock; a stopped stream of Network events started again from the device menu is one schedule', () => {
  const s = busy();
  const own = s.multicast.streams.filter((x) => x.origin === 'model');
  assert.ok(own.length >= 2 && own.every((x) => x.rt === undefined));
  const a = s.actStream('srv', 'eth0', '239.1.1.1', 5010, 1000, 500);
  s.play(1000);
  s.stopStream('srv', 'eth0', '239.1.1.1');
  assert.equal(s.realtime.size, 0);
  const n = a.stream.sent;
  assert.ok(s.multicast.restartStream('srv', 'eth0', '239.1.1.1'));
  assert.ok(s.multicast.restartStream('srv', 'eth0', '239.1.1.1') === false, 'already running');
  assert.equal(s.realtime.size, 1);
  assert.equal(a.stream.sent, n + 1, 'the first at once');
  s.play(2000);
  assert.equal(a.stream.sent, n + 3, 'then every second');
});
