// Foreground and background (pacing.ts): while a Network event runs (a
// stream, a send's messages, a join), its traffic alone holds the clock and
// the gaps between its messages are skipped; the scenario's hops are not
// drawn as dots but counted as cable activity, and never hold the clock.
// Without one, at most CONV_LIMIT conversations are drawn as dots at once,
// the rest are cable activity. Real time: the clock runs with the display,
// falling behind (said) rather than catching up in a burst. Next exchange
// runs on to the end of the exchange first on screen. One clock throughout:
// the scenario and the events share the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const PS = example('protocol-simulation.yaml');

function paced(set = {}, fg = true) {
  const sim = new S.Simulation(model(PS));
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr };
  if (fg) host.foreground = () => sim.foregroundActive();
  const p = new P.Pacer(host, 48);
  Object.assign(p, set);
  return { sim, p };
}

/** Display time from the start (ms of the display clock) at which each originating datagram of a stream was first on screen. */
function streamTimes(fg, ms = 90000) {
  const { sim, p } = paced({}, fg);
  for (let t = 0; t < 3000; t += 50) p.frame(50);
  const a = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  const first = new Map();
  const start = p.clock;
  let activity = 0;
  for (let t = 0; t < ms; t += 50) {
    p.frame(50);
    activity = Math.max(activity, p.activity('physical').length);
    // (a datagram's first hop: from pc1, its own send time)
    for (const it of p.items) if (it.f.test === a.traffic && it.f.protocol === 'mcast' && it.f.sender === 'pc1' && !first.has(Math.round(it.f.t0))) first.set(Math.round(it.f.t0), it.d0 - start);
  }
  return { times: Array.from(first.values()).sort((x, y) => x - y), sends: Array.from(first.keys()).sort((x, y) => x - y), sim, p, a, activity };
}

test('a stream in the foreground: its datagrams follow each other as soon as the last was seen, never behind the scenario’s dots; without the foreground they wait behind them', () => {
  const fg = streamTimes(true);
  const old = streamTimes(false);
  assert.ok(fg.times.length >= 5, `${fg.times.length} datagrams in 90 s of display`);
  const gaps = (t) => t.slice(1).map((x, i) => x - t[i]);
  const avg = (g) => g.reduce((a, b) => a + b, 0) / g.length;
  // the foreground: one datagram's hops (each about 3 s) then the next at once: never more than a path's hops apart
  assert.ok(Math.max(...gaps(fg.times)) < 25000, gaps(fg.times).join(', '));
  // the same stream behind the scenario: fewer datagrams in the same display time
  assert.ok(fg.times.length > old.times.length, `${fg.times.length} vs ${old.times.length}`);
  if (old.times.length > 1) assert.ok(avg(gaps(fg.times)) < avg(gaps(old.times)));
  // one clock: the stream's datagrams are still 1 s of simulated time apart (the engine decides that, not the display)
  const d = gaps(fg.sends);
  assert.ok(d.every((x) => Math.abs(x - 1000) < 50), `1 s of simulated time apart: ${d}`);
});

test('while a Network event runs, the scenario is the background: its hops are cable activity (not dots), they hold nothing; the event’s own are drawn', () => {
  const { sim, p, a, activity } = streamTimes(true, 30000);
  assert.equal(p.fgNow, true);
  assert.match(p.describe(), /· your events in front$/);
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
  // stopped: the scenario is the foreground again
  sim.actionControl(a.id, 'stop');
  for (let t = 0; t < 20000; t += 50) p.frame(50);
  assert.equal(p.fgNow, false);
  assert.doesNotMatch(p.describe(), /in front/);
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

test('real time: the simulated clock runs with the display (× the speed); a 1 s stream sends one datagram a second; too much work: behind, said, no burst', () => {
  const { sim, p } = paced({ mode: 'realtime' }, true);
  assert.match(p.describe(), /^Real time · 1×/);
  for (let t = 0; t < 5000; t += 50) p.frame(50);
  // with the real time; never ahead of it, behind only when a frame's work budget ran out (a busy machine), and then said
  assert.ok(sim.now <= 5100 && (sim.now > 4900 || p.behind > 0 || sim.now > 4000), String(sim.now));
  const a = sim.actStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500);
  const t0 = sim.now;
  for (let t = 0; t < 10000; t += 50) p.frame(50);
  assert.ok(sim.now - t0 <= 10100 && sim.now - t0 > 8000, String(sim.now - t0));
  // a datagram per second of it: never more than real time allows
  assert.ok(a.stream.sent >= Math.floor((sim.now - t0) / 1000) && a.stream.sent <= 11, `${a.stream.sent} in ${sim.now - t0} ms`);
  assert.ok(p.items.every((it) => it.hop === P.RT_HOP));
  assert.equal(p.gate().item, null, 'nothing holds the clock');
  // 2×: twice as far
  p.speed = 2;
  const t1 = sim.now;
  for (let t = 0; t < 2000; t += 50) p.frame(50);
  assert.ok(sim.now - t1 <= 4150 && sim.now - t1 > 3000, String(sim.now - t1));
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
