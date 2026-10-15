// Pacing of the protocol simulation (analysis/sim/pacing.ts): every hop is
// shown for its paced time from its sender to its receiver, the simulated
// clock never runs past a hop on screen, the readable pacing scales with
// the link's latency within its clamps, the proportional mode follows the
// scale, the speed applies on top, idle time is skipped (or not), Step
// moves one message event at a time, a lost message stops where it was
// lost, Follow message holds the clock for its conversation only, and no
// setting changes what the simulation computes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

const PS = example('protocol-simulation.yaml');

function paced(text = PS, view = 'physical', set = {}) {
  const sim = new S.Simulation(model(text));
  const host = {
    engine: sim.engine,
    shown: (f) => f.view === view,
    typical: () => sim.engine.hopTime(),
    headers: (f) => f.hdr,
  };
  const p = new P.Pacer(host, set.limit || 48);
  Object.assign(p, set);
  return { sim, p, view };
}

/** Run the display for `ms` of real time in frames of `dt`; check after every frame that no hop on its way has been passed by the simulation. */
function play(sim, p, ms, dt = 16, check = true, view = 'physical') {
  const seen = new Set();
  for (let t = 0; t < ms; t += dt) {
    p.frame(dt);
    for (const it of p.items) {
      seen.add(it);
      if (!check || !it.drawn || it.f.hidden || it.f.view !== view) continue;
      const st = p.state(it);
      if (st.phase === 'moving' || st.phase === 'transit' || st.phase === 'waiting') {
        const gate = it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat;
        assert.ok(sim.now < gate, `t=${sim.now} passed ${it.f.label} (arrives at ${gate}) while its dot is on its way`);
      }
    }
  }
  return seen;
}

test('readable pacing: about 3 s per typical hop, longer for slower links, clamped to 2–6 s; the speeds 0.1× … 4×; the pulse and the ✕ 1.5 s', () => {
  assert.equal(P.readableHop(0.1, 0.1), 3000);
  assert.ok(P.readableHop(1, 0.1) > 4500 && P.readableHop(1, 0.1) < 5000, String(P.readableHop(1, 0.1)));
  assert.equal(P.readableHop(20, 0.1), 6000, 'a WAN link of 20 ms beside 0.1 ms cables: the upper clamp');
  assert.equal(P.readableHop(0.0001, 0.1), 2000, 'a very short cable: the lower clamp');
  assert.ok(P.readableHop(0.05, 0.1) < 3000 && P.readableHop(0.05, 0.1) >= 2000);
  assert.equal(P.HOP_MIN, 2000);
  assert.equal(P.HOP_MAX, 6000);
  // monotonic in the latency
  let last = 0;
  for (const l of [0.001, 0.01, 0.05, 0.1, 0.3, 1, 3, 10, 100]) {
    const h = P.readableHop(l, 0.1);
    assert.ok(h >= last);
    last = h;
  }
  assert.deepEqual(P.PACE_SPEEDS, [0.1, 0.25, 0.5, 1, 2, 4]);
  assert.equal(P.PULSE_MS, 1500);
  assert.equal(P.LOST_MS, 1500);
  assert.equal(P.proportionalHop(1, 1000), 1000);
  assert.equal(P.proportionalHop(0.01, 1000), P.PROP_MIN);
  assert.equal(P.proportionalHop(100, 1000), P.PROP_MAX);
  assert.equal(P.scaleText(1000), '1 ms = 1 s');
  assert.equal(P.scaleText(100), '1 ms = 0.1 s');
  const { p } = paced();
  assert.equal(p.speed, 1, '1× is the default');
  assert.equal(p.describe(), 'Readable · 3 s per hop · 1×');
  p.mode = 'proportional';
  p.speed = 2;
  assert.equal(p.describe(), 'Proportional · 1 ms = 1 s · 2×');
});

test('the speed cap: a dot never moves faster than 70 px per second at 100 % zoom; a long line takes longer, in both modes', () => {
  assert.equal(P.MAX_SPEED, 70);
  const { p, sim: s0 } = paced();
  const typ = s0.engine.hopTime();
  assert.equal(p.hopTime(typ, 'physical', 100), 3000, 'a short cable: the readable time');
  assert.equal(p.hopTime(typ, 'physical', 700), 10000, '700 px: 10 s');
  assert.equal(p.hopTime(typ, 'physical', null), 3000, 'not drawn: the readable time');
  p.mode = 'proportional';
  assert.equal(p.hopTime(typ, 'physical', 350), 5000);
  // a pacer whose host knows the lines: every hop at most MAX_SPEED
  const sim = new S.Simulation(model(PS));
  const q = new P.Pacer({ engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr, length: (f) => (f.track.ref.length % 3) * 300 + 50 }, 48);
  for (let i = 0; i < 200; i++) q.frame(50);
  assert.ok(q.items.length > 0);
  for (const it of q.items) assert.ok(it.hop >= (((it.f.track.ref.length % 3) * 300 + 50) / 70) * 1000 - 1e-6, `${it.f.track.ref}: ${it.hop}`);
});

test('the cause of the fast dots is not the clock: a hop shown keeps exactly its paced time on screen, whatever the simulation does meanwhile (skipping, other hops, jumps)', () => {
  const { sim, p } = paced();
  const started = new Map();
  const arrived = new Map();
  for (let t = 0; t < 40000; t += 16) {
    p.frame(16);
    for (const it of p.items) {
      if (!it.drawn || it.f.view !== 'physical' || it.f.dropped !== undefined) continue;
      const st = p.state(it);
      if (st.phase === 'moving' && !started.has(it)) started.set(it, p.clock);
      if ((st.phase === 'arrived' || st.phase === 'gone') && started.has(it) && !arrived.has(it)) arrived.set(it, p.clock);
    }
  }
  assert.ok(arrived.size > 5, String(arrived.size));
  for (const [it, end] of arrived) {
    const took = end - started.get(it);
    // (to the frame: a hop starts and ends between two frames)
    assert.ok(took >= it.hop - 32 && took <= it.hop + 32, `${it.f.label}: ${took} for ${it.hop}`);
    assert.ok(it.hop >= P.HOP_MIN);
  }
});

test('a quiet screen with busy hidden traffic: a jump does a bounded amount of work per frame (the page stays responsive)', () => {
  const sim = new S.Simulation(model(PS));
  // nothing is shown: every jump runs through hidden events only
  const q = new P.Pacer({ engine: sim.engine, shown: () => false, typical: () => sim.engine.hopTime(), headers: (f) => f.hdr }, 48);
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    const t = Date.now();
    q.frame(16);
    worst = Math.max(worst, Date.now() - t);
  }
  assert.ok(worst < P.JUMP_BUDGET + 250, `worst frame ${worst} ms`);
  assert.ok(sim.now > 1000, 'and it does move on');
});

test('every hop travels its whole way for its paced time; the clock never passes a hop on screen; a continuing hop starts when the one before it arrived', () => {
  const { sim, p } = paced();
  const seen = play(sim, p, 12000);
  const drawn = Array.from(seen).filter((it) => it.drawn);
  assert.ok(drawn.length > 10, String(drawn.length));
  for (const it of drawn) {
    assert.ok(it.hop >= P.HOP_MIN && it.hop <= P.HOP_MAX, `${it.f.label}: ${it.hop}`);
    if (it.parent) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6, `${it.f.label} starts after its previous hop arrived`);
  }
  // a frame through a switch: the second cable starts after the first, with the crossing of the switch first
  assert.ok(drawn.some((it) => it.parent && it.transit === P.TRANSIT_MS));
  // something was sent, and the simulated time moved on
  assert.ok(sim.now > 0);
});

test('the speed applies on top of the pacing: twice the speed, twice the display time in the same real time, and further in the simulation', () => {
  const a = paced();
  const b = paced(PS, 'physical', { speed: 2 });
  const q = paced(PS, 'physical', { speed: 0.5 });
  play(a.sim, a.p, 6000);
  play(b.sim, b.p, 6000);
  play(q.sim, q.p, 6000);
  assert.ok(Math.abs(b.p.clock - 2 * a.p.clock) < 1e-6 && Math.abs(q.p.clock - a.p.clock / 2) < 1e-6);
  assert.ok(b.sim.now > a.sim.now && a.sim.now > q.sim.now, `${q.sim.now} < ${a.sim.now} < ${b.sim.now}`);
  // the hops themselves are paced the same: the speed only runs the display faster
  assert.equal(b.p.hopTime(0.1, 'physical'), a.p.hopTime(0.1, 'physical'));
});

test('a jump cut short by its work budget (a slow machine) goes on towards the same end and still rests: the clock never runs away', () => {
  const Q = example('branch-routing.yaml');
  const fast = paced(Q);
  const slow = paced(Q);
  for (const r of [fast, slow]) {
    r.sim.runTo(5000);
    r.p.resync();
  }
  play(fast.sim, fast.p, 20000, 50, false);
  // every hundredth look at the wall clock finds 30 ms gone: jumps are cut short, often near their end
  const real = Date.now;
  let t = real();
  let n = 0;
  Date.now = () => (++n % 100 === 0 ? (t += 30) : t);
  try {
    play(slow.sim, slow.p, 20000, 50, false);
  } finally {
    Date.now = real;
  }
  assert.ok(slow.sim.now <= 5000 + (20000 / P.IDLE_REST + 1) * P.IDLE_HORIZON, String(slow.sim.now));
  assert.ok(fast.sim.now <= 5000 + (20000 / P.IDLE_REST + 1) * P.IDLE_HORIZON, String(fast.sim.now));
});

test('skipping idle time: with nothing on screen the clock jumps to the next message shown and reports it; without skipping it runs at the speed', () => {
  // a quiet network past its boot
  const Q = example('branch-routing.yaml');
  const a = paced(Q);
  const b = paced(Q, 'physical', { skipIdle: false });
  for (const r of [a, b]) {
    r.sim.runTo(5000);
    r.p.resync();
  }
  play(a.sim, a.p, 20000, 50, false);
  play(b.sim, b.p, 20000, 50, false);
  assert.ok(a.sim.now > b.sim.now + 60000, `${a.sim.now} > ${b.sim.now}`);
  // a jump that finds nothing to show goes at most IDLE_HORIZON at once, then rests
  assert.ok(a.sim.now <= 5000 + (20000 / P.IDLE_REST + 1) * P.IDLE_HORIZON, String(a.sim.now));
  // without skipping, at most real time × speed of idle time passes (plus the paced messages' own simulated time)
  assert.ok(b.sim.now <= 5000 + 20000 + 1, String(b.sim.now));
  assert.ok(b.sim.now > 5000 + 1000, 'but it does run');
  assert.ok(a.p.skipped && a.p.skipped.ms >= P.SKIP_REPORT, JSON.stringify(a.p.skipped));
  assert.equal(b.p.skipped, null);
});

test('Step: to the next message event; a hop on its way arrives, else the next message appears at its sender', () => {
  const { sim, p } = paced();
  p.step();
  const first = p.items.filter((it) => it.drawn);
  assert.ok(first.length > 0, 'a message appears');
  assert.ok(first.some((it) => it.f.view === 'physical' && p.state(it).phase === 'moving' && p.state(it).frac === 0), 'at its sender');
  assert.ok(first.every((it) => p.state(it).phase === 'moving' && p.state(it).frac === 0 || p.state(it).phase === 'waiting' || p.state(it).phase === 'transit'));
  const before = sim.now;
  const clock = p.clock;
  p.step();
  assert.ok(p.clock > clock, 'the display moved to the first arrival');
  assert.ok(sim.now >= before);
  // stepping on never passes a hop on screen
  for (let i = 0; i < 40; i++) {
    p.step();
    for (const it of p.items) {
      if (!it.drawn || it.f.hidden || it.f.view !== 'physical') continue;
      const st = p.state(it);
      if (st.phase === 'moving' || st.phase === 'waiting' || st.phase === 'transit') assert.ok(sim.now < (it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat));
    }
  }
});

test('no pacing setting changes what the simulation computes: the same events in the same order', () => {
  const ref = new S.Simulation(model(PS));
  const sig = (s, upTo) => s.events().filter((e) => e.t <= upTo).map((e) => `${e.t.toFixed(9)}|${e.kind}|${e.protocol}|${e.device}|${e.peer}|${e.what}|${e.state}|${e.detail}`);
  const runs = [
    paced(),
    paced(PS, 'physical', { speed: 4 }),
    paced(PS, 'physical', { speed: 0.25 }),
    paced(PS, 'physical', { mode: 'proportional', scale: 100 }),
    paced(PS, 'logical'),
    paced(PS, 'physical', { skipIdle: false, speed: 4 }),
  ];
  let upTo = Infinity;
  for (const r of runs) {
    play(r.sim, r.p, 20000, 33, false);
    upTo = Math.min(upTo, r.sim.now);
  }
  // and Step, a few times
  const st = paced();
  for (let i = 0; i < 30; i++) st.p.step();
  runs.push(st);
  upTo = Math.min(upTo, st.sim.now);
  ref.runTo(upTo);
  const want = sig(ref, upTo);
  assert.ok(want.length > 20, String(want.length));
  for (const r of runs) assert.deepEqual(sig(r.sim, upTo), want);
});

test('a message lost on a failed cable stops where it was lost and shows there for about a second', () => {
  const { sim, p } = paced();
  // wait for a hop on a cable, then fail that cable while the dot is midway
  let it = null;
  for (let i = 0; i < 2000 && !it; i++) {
    p.frame(16);
    it = p.items.find((x) => x.drawn && x.f.track.ref.indexOf('link:') === 0 && p.state(x).phase === 'moving' && p.state(x).frac > 0.4);
  }
  assert.ok(it, 'a dot midway');
  const frac = p.state(it).frac;
  assert.ok(sim.fail(it.f.track.ref));
  p.frame(0);
  assert.notEqual(it.f.dropped, undefined, 'lost when the cable went down');
  const st = p.state(it);
  assert.equal(st.phase, 'lost');
  assert.ok(Math.abs(st.frac - frac) < 0.1, `lost where it was: ${st.frac} ~ ${frac}`);
  p.frame(P.LOST_MS - 50);
  assert.equal(p.state(it).phase, 'lost', 'still shown');
  p.frame(100);
  assert.equal(p.state(it).phase, 'gone');
});

test('Follow message: its conversation alone holds the clock; the key pairs a request with its reply', () => {
  const k1 = P.conversationKey('arp', { arp: { senderIp: '10.0.0.1', targetIp: '10.0.0.2' }, l2: { src: 'a', dst: 'b' }, l3: [] }, 'ARP Request');
  const k2 = P.conversationKey('arp', { arp: { senderIp: '10.0.0.2', targetIp: '10.0.0.1' }, l2: { src: 'b', dst: 'a' }, l3: [] }, 'ARP Reply');
  assert.equal(k1, k2);
  const t1 = P.conversationKey('tcp', { l2: { src: 'a', dst: 'b' }, l3: [{ src: '10.0.0.1', dst: '10.0.0.9' }], l4: { proto: 'tcp', src: 40000, dst: 80 } }, 'SYN');
  const t2 = P.conversationKey('tcp', { l2: { src: 'b', dst: 'a' }, l3: [{ src: '10.0.0.9', dst: '10.0.0.1' }], l4: { proto: 'tcp', src: 80, dst: 40000 } }, 'SYN-ACK');
  assert.equal(t1, t2);
  const { sim, p } = paced();
  p.step();
  const it = p.items.find((x) => x.drawn);
  assert.ok(p.followFlight(it.f.id));
  assert.equal(p.follow.key, it.key);
  // only hops of that conversation hold the clock
  for (let i = 0; i < 300; i++) {
    p.frame(16);
    const g = p.gate();
    if (g.item) assert.equal(g.item.key, it.key);
  }
  assert.ok(p.followFlight(null));
  assert.equal(p.follow, null);
  assert.ok(sim.now > 0);
});

test('the dot limit: a hop beyond it is not drawn and does not hold the clock; the count says how many', () => {
  const { sim, p } = paced(PS, 'physical', { limit: 2 });
  play(sim, p, 8000, 16, false);
  assert.ok(p.notDrawn > 0, String(p.notDrawn));
  for (let i = 0; i < 100; i++) {
    p.frame(16);
    assert.ok(p.items.filter((x) => x.drawn && p.clock < p.end(x) && x.f.view === 'physical').length <= 2);
  }
});

test('the logical view: hops along relations and network lines, paced against the view\'s typical hop', () => {
  const { sim, p } = paced(PS, 'logical');
  const seen = play(sim, p, 40000, 16, true, 'logical');
  const drawn = Array.from(seen).filter((it) => it.drawn && it.f.view === 'logical');
  assert.ok(drawn.some((it) => it.f.track.ref.indexOf('relation:') === 0), 'along relations');
  assert.ok(drawn.some((it) => it.f.track.ref.indexOf('network:') === 0 && it.parent), 'a network line: to the network, then on to the receiver');
  for (const it of drawn) if (it.parent) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6);
});

test('a jump of the simulation (runTo): what it passed leaves the screen; what is still on its way stays', () => {
  const { sim, p } = paced();
  play(sim, p, 500);
  assert.ok(p.items.length > 0);
  sim.runTo(20000);
  p.resync();
  for (const it of p.items) assert.ok((it.f.dropped !== undefined ? it.f.dropped : it.f.t0 + it.lat) >= sim.now - 1e-6, it.f.label);
  play(sim, p, 2000);
});
