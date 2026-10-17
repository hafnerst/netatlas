// Foreground and background (pacing.ts): while a Network event runs (a
// send's messages, a join), its traffic alone holds the clock and the gaps
// between its messages are skipped; a stream of Network events sends every
// interval of real time, and while one runs the clock runs in real time,
// held by nothing; the scenario's hops are not drawn as dots but counted as
// cable activity, and never hold the clock.
// Without one, at most CONV_LIMIT conversations are drawn as dots at once,
// the rest are cable activity. Real time: the clock runs with the display,
// falling behind (said) rather than catching up in a burst. Next exchange
// runs on to the end of the exchange first on screen. One clock throughout:
// the scenario and the events share the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const PS = example('protocol-simulation.yaml');

/** The pacing over the busy example, with a fake real clock for the real-time schedule; `frame(ms)` is the page's animation frame (the schedule's turn, then the display's). */
function paced(set = {}, fg = true) {
  const sim = withClock(new S.Simulation(model(PS)));
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr };
  if (fg) {
    host.foreground = () => sim.foregroundActive();
    host.realtime = () => sim.realtimeActive();
  }
  const p = new P.Pacer(host, 48);
  Object.assign(p, set);
  const frame = (ms) => {
    sim.clock.t += ms;
    sim.pumpRealTime();
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
  const r0 = sim.clock.t;
  let together = 0;
  let activity = 0;
  for (let t = 0; t < ms; t += 50) {
    frame(50);
    activity = Math.max(activity, p.activity('physical').length);
    // datagrams on their way at once: their hops' send times, drawn and moving
    const going = new Set(p.items.filter((it) => it.f.test === a.traffic && it.drawn && p.state(it).phase === 'moving').map((it) => it.f.t0));
    together = Math.max(together, going.size);
  }
  return { sim, p, a, frame, t0, real: sim.clock.t - r0, together, activity };
}

test('a stream of Network events in Readable pacing: a datagram every second of real time; several on their way at once, each hop readable; the clock runs in real time, held by nothing', () => {
  const { sim, p, a, t0, real, together } = streamRun(20000);
  // the first at once, then one every second of real time: 0 … 20 s
  assert.equal(real, 20000);
  assert.equal(a.stream.sent, 21);
  assert.equal(p.rtNow, true);
  assert.match(p.describe(), /^Readable · 3 s per hop · 1× · streams in real time( · behind)?$/);
  // the clock with real time (never ahead; behind only when a frame's work ran out, and then said)
  assert.ok(sim.now - t0 <= 20000 + 1 && (sim.now - t0 > 15000 || p.behind > 0), `${sim.now - t0} ms simulated in 20 s`);
  assert.equal(p.gate().item, null, 'nothing holds the clock');
  // the dots keep their readable time: a datagram's path takes longer than its interval, so several are on their way at once
  assert.ok(p.items.filter((it) => it.f.test === a.traffic).every((it) => it.hop >= P.HOP_MIN));
  assert.ok(together >= 3, `${together} datagrams on their way at once`);
  // each datagram at the simulated time it was due: about a second apart (the clock ran with real time)
  // (the log has datagrams 1, 10, 20 …)
  const sends = sim.events().filter((e) => e.test === a.traffic && e.kind === 'message' && /^multicast datagram (1|10) from/.test(e.detail)).map((e) => e.t);
  assert.ok(sends.length === 2 && sends[1] - sends[0] > 6000 && sends[1] - sends[0] <= 9001, `datagrams 1 and 10: ${sends.join(', ')}`);
});

test('while a Network event runs, the scenario is the background: its hops are cable activity (not dots), they hold nothing; the event’s own are drawn', () => {
  const { sim, p, a, activity, frame } = streamRun(30000);
  assert.equal(p.fgNow, true);
  assert.match(p.describe(), /· streams in real time( · behind)?$/);
  const scenario = p.items.filter((it) => it.f.view === 'physical' && it.f.test === undefined && it.d0 > 3000);
  assert.ok(scenario.length > 0, 'the scenario goes on (one clock, one network)');
  assert.ok(scenario.every((it) => !it.drawn), 'the scenario: not drawn as dots');
  assert.ok(p.items.filter((it) => it.f.test === a.traffic && it.f.view === 'physical').every((it) => it.drawn));
  assert.ok(activity > 0, 'cable activity while it ran');
  for (const x of p.activity('physical')) {
    assert.ok(x.counts.length > 0 && x.counts.every(([proto, n]) => typeof proto === 'string' && n > 0));
    assert.equal(x.track.ref, x.ref);
  }
  // the gate is held by the stream only
  const g = p.gate();
  assert.ok(g.item === null || g.item.f.test === a.traffic);
  // stopped: the scenario is the foreground again, the clock paced again
  sim.actionControl(a.id, 'stop');
  const n = a.stream.sent;
  for (let t = 0; t < 20000; t += 50) frame(50);
  assert.equal(a.stream.sent, n, 'its future sends cancelled');
  assert.equal(p.fgNow, false);
  assert.equal(p.rtNow, false);
  assert.doesNotMatch(p.describe(), /in front|real time/);
});

test('bundling: never more than CONV_LIMIT of the scenario’s conversations as dots on their way at once; the rest counted as activity; the clock never passes a dot on its way', () => {
  const { sim, p } = paced({}, false);
  assert.equal(P.CONV_LIMIT, 6);
  let most = 0;
  for (let t = 0; t < 40000; t += 16) {
    p.frame(16);
    const keys = new Set(p.items.filter((it) => it.drawn && it.f.view === 'physical' && p.state(it).phase !== 'arrived' && p.state(it).phase !== 'gone' && p.state(it).phase !== 'lost').map((it) => it.key));
    most = Math.max(most, keys.size);
    for (const it of p.items) {
      if (!it.drawn || it.f.view !== 'physical') continue;
      const st = p.state(it);
      if (st.phase === 'moving' || st.phase === 'transit') assert.ok(sim.now < (it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat));
    }
  }
  assert.ok(most <= P.CONV_LIMIT, String(most));
  assert.ok(most >= 2, 'several at once, not one at a time');
  assert.ok(p.notDrawn > 0, 'the rest: cable activity');
  // the clock moves on (no run-away jump, no standstill): about as far as without bundling
  const q = paced({ convLimit: 1000 }, false);
  for (let t = 0; t < 40000; t += 16) q.p.frame(16);
  assert.ok(sim.now < 10 * q.sim.now + 5000 && sim.now > 0, `${sim.now} vs ${q.sim.now}`);
});

test('real time: the simulated clock runs with the display (× the speed); a 1 s stream sends one datagram a second, at 2× too; too much work: behind, said, no burst', () => {
  const { sim, p, frame } = paced({ mode: 'realtime' }, true);
  assert.match(p.describe(), /^Real time · 1×/);
  for (let t = 0; t < 5000; t += 50) frame(50);
  // with the real time; never ahead of it, behind only when a frame's work budget ran out (a busy machine), and then said
  assert.ok(sim.now <= 5100 && (sim.now > 4900 || p.behind > 0 || sim.now > 4000), String(sim.now));
  const a = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  const t0 = sim.now;
  for (let t = 0; t < 10000; t += 50) frame(50);
  assert.ok(sim.now - t0 <= 10100 && (sim.now - t0 > 8000 || p.behind > 0), String(sim.now - t0));
  // a datagram per second of real time: the first at once, then 10
  assert.equal(a.stream.sent, 11);
  assert.ok(p.items.every((it) => it.hop === P.RT_HOP));
  assert.equal(p.gate().item, null, 'nothing holds the clock');
  // 2×: the clock twice as far; the stream still one a second of real time (the speed is the scenario's)
  p.speed = 2;
  const t1 = sim.now;
  for (let t = 0; t < 2000; t += 50) frame(50);
  assert.ok(sim.now - t1 <= 4150 && (sim.now - t1 > 3000 || p.behind > 0), String(sim.now - t1));
  assert.equal(a.stream.sent, 13);
  // a slow machine: every frame's work cut short; it falls behind and says so, then goes on from there (no catching up in a burst)
  p.speed = 1;
  const real = Date.now;
  let clock = real();
  Date.now = () => (clock += 30);
  try {
    p.frame(50);
    assert.ok(p.behind >= 0);
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
