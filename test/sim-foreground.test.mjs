// Foreground and background (pacing.ts): the clock runs at its rate, held
// by no dot; while a Network event runs (a send's messages, a join, a
// leave, a stream, flapping) or a hop of one is still on screen, its
// traffic is the foreground (drawn, inspectable) and the scenario the
// background: its dots go on moving, muted and not clickable. A finished
// event, a join's lasting membership or a card kept in the list mute
// nothing. A stream of Network events sends every interval of simulated
// time, like the model's: the pacing changes how fast it is shown, never
// which datagrams exist.
// At most CONV_LIMIT of the scenario's conversations are drawn as dots at
// once, the rest are cable activity. Real time: the clock runs with the
// display, falling behind (said) rather than catching up in a burst. Next
// exchange runs on to the end of the exchange first on screen. One clock
// throughout: the scenario and the events share the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const PS = example('protocol-simulation.yaml');

/** The pacing over the busy example; `frame(ms)` is the page's animation frame. */
function paced(set = {}, fg = true) {
  const sim = withClock(new S.Simulation(model(PS)));
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr };
  if (fg) {
    host.foreground = () => sim.foregroundActive();
  }
  const p = new P.Pacer(host, 48);
  Object.assign(p, set);
  const frame = (ms) => {
    p.frame(ms);
  };
  return { sim, p, frame };
}

/** A stream of Network events from pc1 after 3 s, then `ms` of frames: how many datagrams, how many of them on their way at once at most, the cable activity. */
function streamRun(ms = 20000, set = {}) {
  const { sim, p, frame } = paced(set, true);
  for (let t = 0; t < 3000; t += 50) frame(50);
  const a = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  const t0 = sim.now;
  let together = 0;
  let activity = 0;
  for (let t = 0; t < ms; t += 50) {
    frame(50);
    activity = Math.max(activity, p.activity('physical').length);
    // datagrams on their way at once: their hops' send times, drawn and moving
    const going = new Set(p.items.filter((it) => it.f.test === a.traffic && it.drawn && p.state(it).phase === 'moving').map((it) => it.f.t0));
    together = Math.max(together, going.size);
  }
  return { sim, p, a, frame, t0, together, activity };
}

test('a stream of Network events in Readable pacing: one datagram every second of simulated time — the same datagrams as without any display; each hop readable; the clock held by nothing', () => {
  const { sim, p, a, t0 } = streamRun(20000);
  // on the simulated clock: the first at once, then one every simulated second
  const sends = sim.events().filter((e) => e.test === a.traffic && e.kind === 'message' && /^multicast datagram \d+ from/.test(e.detail)).map((e) => e.t);
  // (the log lists a stream's datagrams 1, 10, 20 …)
  assert.equal(a.stream.sent, Math.floor((sim.now - t0 - 5) / 1000) + 1, `${a.stream.sent} datagrams in ${sim.now - t0} ms of simulated time`);
  assert.doesNotMatch(p.describe(), /real time/);
  // the dots keep their readable time
  assert.ok(p.items.filter((it) => it.f.test === a.traffic).every((it) => it.hop >= P.HOP_MIN));
  // the same stream without a display, run to the same simulated time: the same datagrams at the same times
  const bare = new S.Simulation(model(PS));
  bare.runTo(t0);
  const b = bare.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  bare.runTo(sim.now);
  const bareSends = bare.events().filter((e) => e.test === b.traffic && e.kind === 'message' && /^multicast datagram \d+ from/.test(e.detail)).map((e) => e.t);
  assert.deepEqual(bareSends, sends, 'the pacing changes nothing of what is sent');
});

test('while a Network event runs, the scenario is the background: its dots go on moving, muted (not clickable); the event’s own are the foreground; stopped, all of it is the foreground again', () => {
  const { sim, p, a, frame } = streamRun(30000);
  assert.equal(p.fgNow, true);
  assert.match(p.describe(), /· your events in front$/);
  // the scenario goes on (one clock, one network): drawn, moving, the background
  const scenario = p.items.filter((it) => it.f.view === 'physical' && it.f.test === undefined && it.drawn);
  assert.ok(scenario.length > 0, 'the scenario still drawn');
  assert.ok(scenario.every((it) => p.background(it)), 'muted while the stream runs');
  assert.ok(scenario.some((it) => p.state(it).phase === 'moving'), 'and moving');
  const mine = p.items.filter((it) => it.f.test === a.traffic && it.f.view === 'physical');
  assert.ok(mine.length && mine.every((it) => it.drawn && !p.background(it)), 'the stream: the foreground');
  // stopped: once its last datagram has arrived on screen, nothing is muted any more
  sim.actionControl(a.id, 'stop');
  const n = a.stream.sent;
  for (let t = 0; t < 20000; t += 50) frame(50);
  assert.equal(a.stream.sent, n, 'its future sends cancelled');
  assert.equal(p.fgNow, false);
  assert.equal(p.fgActive(), false);
  assert.ok(p.items.every((it) => !p.background(it)));
  assert.doesNotMatch(p.describe(), /in front|real time/);
});

test('what keeps the foreground: a running send, stream, flapping, a join until recorded, a leave until settled; a finished event, a join’s membership, a card kept in the list, a send waiting for its DHCP lease do not', () => {
  const { sim, p, frame } = paced({}, true);
  for (let t = 0; t < 5000; t += 50) frame(50);
  assert.equal(sim.foregroundActive(), false);
  // a join: in front until a multicast router (or switch) recorded it; then its membership lasts, muting nothing
  const j = sim.actJoin('pc1', 'eth0', '239.9.9.9', []);
  assert.equal(sim.foregroundActive(), true);
  for (let t = 0; t < 15000; t += 50) frame(50);
  assert.equal(sim.actions().find((v) => v.id === j.id).status, 'completed');
  assert.equal(sim.foregroundActive(), false);
  assert.equal(p.fgActive(), false, 'its hops arrived: nothing muted');
  // flapping: in front until stopped
  const f = sim.actFlap('iface:pc2:eth0');
  assert.equal(sim.foregroundActive(), true);
  sim.actionControl(f.id, 'stop');
  assert.equal(sim.foregroundActive(), false);
  // two at once: both foreground; the first ends, the second keeps it
  const s1 = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 200);
  const s2 = sim.actStream('pc2', 'eth0', '239.8.8.8', 5004, 1000, 200);
  for (let t = 0; t < 3000; t += 50) frame(50);
  assert.ok(p.items.some((it) => it.f.test === s1.traffic && !p.background(it)) && p.items.some((it) => it.f.test === s2.traffic && !p.background(it)));
  sim.actionControl(s1.id, 'stop');
  assert.equal(sim.foregroundActive(), true);
  sim.actionControl(s2.id, 'stop');
  assert.equal(sim.foregroundActive(), false);
  // the cards are still listed: they mute nothing
  assert.ok(sim.actions().length >= 4);
  for (let t = 0; t < 20000; t += 50) frame(50);
  assert.equal(p.fgActive(), false);
});

test('bundling: a conversation takes a place while a hop of it is on its way; never more than CONV_LIMIT new ones (and CONV_DIVERSE more for protocols with nothing on screen); the rest counted as activity; the clock runs at its rate whatever is drawn', () => {
  const { sim, p } = paced({}, false);
  assert.equal(P.CONV_LIMIT, 6);
  let most = 0;
  for (let t = 0; t < 40000; t += 16) {
    p.frame(16);
    const keys = new Set(p.items.filter((it) => it.drawn && it.f.view === 'physical' && p.state(it).phase === 'moving').map((it) => it.key));
    most = Math.max(most, keys.size);
  }
  assert.ok(most <= P.CONV_LIMIT + P.CONV_DIVERSE + 2, String(most));
  assert.ok(most >= 2, 'several at once, not one at a time');
  assert.ok(p.notDrawn > 0, 'the rest: cable activity');
  // the clock: as far with bundling as without (it follows its rate, not the dots)
  const q = paced({ convLimit: 1000 }, false);
  for (let t = 0; t < 40000; t += 16) q.p.frame(16);
  assert.ok(Math.abs(sim.now - q.sim.now) < 1000 || sim.now >= 40000 - 50, `${sim.now} vs ${q.sim.now}`);
});

test('real time: the simulated clock runs with the display (× the speed); a 1 s stream sends one datagram a simulated second, twice as many at 2×; too much work: behind, said, no burst', () => {
  const { sim, p, frame } = paced({ mode: 'realtime' }, true);
  assert.match(p.describe(), /^Real time · 1×/);
  for (let t = 0; t < 5000; t += 50) frame(50);
  // with the real time; never ahead of it, behind only when a frame's work budget ran out (a busy machine), and then said
  assert.ok(sim.now <= 5100 && (sim.now > 4900 || p.behind > 0 || sim.now > 4000), String(sim.now));
  const a = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  const t0 = sim.now;
  for (let t = 0; t < 10000; t += 50) frame(50);
  assert.ok(sim.now - t0 <= 10100 && (sim.now - t0 > 8000 || p.behind > 0), String(sim.now - t0));
  // a datagram per second of simulated time: the first at once, then one a second (the timers' jitter aside)
  const due = (since) => Math.floor((sim.now - since - 5) / 1000) + 1;
  assert.equal(a.stream.sent, due(t0));
  assert.ok(p.items.every((it) => it.hop === P.RT_HOP));
  // 2×: the clock twice as far, and the stream with it (it is on the simulated clock: the speed changes how fast it is shown)
  p.speed = 2;
  const t1 = sim.now;
  for (let t = 0; t < 2000; t += 50) frame(50);
  assert.ok(sim.now - t1 <= 4150 && (sim.now - t1 > 3000 || p.behind > 0), String(sim.now - t1));
  assert.equal(a.stream.sent, due(t0));
  // a slow machine: every frame's work cut short; it falls behind and says so, then goes on from there (no catching up in a burst)
  p.speed = 1;
  const real = Date.now;
  let clock = real();
  Date.now = () => (clock += 30);
  try {
    // (where the clock stands before depends on the machine; over ten frames with every frame's work cut short it falls behind, and says so then)
    let fell = false;
    for (let i = 0; i < 10 && !fell; i++) {
      p.frame(50);
      if (p.behind > 0) {
        fell = true;
        assert.match(p.describe(), /behind/, 'and says so');
      }
    }
    assert.ok(fell, 'it falls behind');
    const before = sim.now;
    p.frame(50);
    assert.ok(sim.now - before <= 100 + 1e-6, 'never more than its frames’ worth at once');
  } finally {
    Date.now = real;
  }
});

test('Next exchange: on to the end of the exchange first on screen, all its hops arrived', () => {
  const { sim, p } = paced({}, false);
  for (let t = 0; t < 4000; t += 50) p.frame(50);
  const first = () => {
    let best = null;
    for (const it of p.items) if (it.drawn && it.f.view === 'physical' && p.state(it).phase === 'moving' && (!best || p.arrival(it) < p.arrival(best))) best = it;
    return best;
  };
  let it = first();
  if (!it) {
    p.step();
    it = first();
  }
  assert.ok(it, 'something on screen');
  const key = it.key;
  p.stepExchange();
  assert.ok(!p.items.some((x) => x.key === key && x.drawn && x.f.view === 'physical' && p.clock < p.arrival(x) - 1e-6), 'its exchange is over');
  assert.ok(sim.now > 0);
});

test('a stream running, a Step or Next exchange moves the simulation on: the real-time clock goes on from there, never waiting for the display to catch up', () => {
  const { sim, p, frame } = streamRun(3000);
  for (const move of [() => p.step(), () => p.stepExchange(), () => sim.runTo(sim.now + 60000)]) {
    move();
    const t = sim.now;
    for (let i = 0; i < 40; i++) frame(50);
    assert.ok(sim.now - t > 1000 && sim.now - t <= 2000 + 1, `${sim.now - t} ms simulated in 2 s`);
  }
});
