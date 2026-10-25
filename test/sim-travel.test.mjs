// Visible travel time (analysis/sim/travel.ts, used by pacing.ts): in Readable pacing at 1× a dot crosses its line in
// 3–5 s, from the hop's modelled traversal cost (a cable's latency and its frame's serialization, a relation's lane its
// underlay's estimate) on the model's own log scale; no cost: 4 s. The mapping is ordered and distinguishable; the speed
// divides it; pause, a view switch and cancellation keep it coherent; a line drawn in two halves is one traversal; and no
// presentation setting changes what the simulation computes (the same events, flights and outcomes as headless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, travelOf } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const T = load('analysis/sim/travel.js');

const within = (x) => x >= T.TRAVEL_MIN - 1e-6 && x <= T.TRAVEL_MAX + 1e-6;

// ha — a ==(wan, its latency; a GRE tunnel with keepalives over it)== b — hb, plus a second host behind a
const WAN = (lat = 20) => `netatlas: 1
title: travel
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: hc, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.11/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 192.0.2.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: b
    type: router
    interfaces: [{id: wan, ip: 192.0.2.2/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: "ha:eth0", b: "sw:p1"}
  - {id: l0, a: "hc:eth0", b: "sw:p2"}
  - {id: lu, a: "sw:p3", b: "a:lan"}
  - {id: l2, a: "a:wan", b: "b:wan", simulation: {latency: ${lat}}}
  - {id: l3, a: "b:lan", b: "hb:eth0"}
relations:
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"], attrs: {keepalive: "10 3"}}
`;

/** A simulation with its pacer as the page has them; `view` and `paused` can change on the way. */
function paced(text, o = {}) {
  const sim = new S.Simulation(model(text));
  const st = { view: o.view || 'physical', cap: null };
  const p = new P.Pacer({ engine: sim.engine, shown: (f) => f.view === st.view, travel: travelOf(sim.engine), headers: (f) => f.hdr, foreground: () => sim.foregroundActive(), until: () => st.cap }, 48);
  Object.assign(p, o.set || {});
  // every hop taken in (the pacer forgets what has gone from the screen)
  const seen = new Set();
  const frame = (ms) => {
    p.frame(ms);
    for (const it of p.items) seen.add(it);
  };
  const frames = (ms, step = 50) => {
    for (let t = 0; t < ms; t += step) frame(step);
  };
  const until = (cond, max = 600000) => {
    for (let t = 0; t < max && !cond(); t += 50) frame(50);
    assert.ok(cond(), `not within ${max} ms of display (simulated ${sim.now})`);
  };
  // play until the simulated clock is exactly at t (the pacer's cap): an action then is at the same time as headless
  const to = (t) => {
    st.cap = t;
    until(() => sim.now >= t - 1e-9, 2000000);
    st.cap = null;
  };
  return { sim, p, st, frames, until, to, seen };
}

/** Everything simulated, comparable (no ids): the log, the flights' times and tracks, the tests' outcomes. */
function simulated(sim, upTo) {
  const ev = sim.events().filter((e) => e.t <= upTo).map((e) => `${e.t.toFixed(9)}|${e.kind}|${e.protocol}|${e.device}|${e.peer}|${e.what}|${e.state}|${e.detail}`);
  const tests = sim.tests().filter((t) => t.started <= upTo).map((t) => `${t.started.toFixed(9)}|${t.done}|${t.ok}|${t.result}`);
  return { ev, tests };
}

// ------------------------------------------------------------------ the mapping

test('the mapping: ordered, distinguishable, within 3–5 s; a homogeneous model inside the bounds; no cost or no scale the neutral 4 s', () => {
  assert.deepEqual([T.TRAVEL_MIN, T.TRAVEL_MAX, T.TRAVEL_NEUTRAL], [3000, 5000, 4000]);
  // a LAN of 0.1 ms cables with one 20 ms WAN link
  const sc = T.travelScale([0.1, 0.1, 0.1, 20]);
  const low = T.travelMs(0.1, sc);
  const mid = T.travelMs(2, sc);
  const high = T.travelMs(20, sc);
  assert.equal(low, T.TRAVEL_MIN, 'the cheapest cable: the shortest');
  assert.ok(mid > low + 500 && high > mid + 500, `${low} < ${mid} < ${high}: distinguishable`);
  assert.ok(high < T.TRAVEL_MAX, 'the dearest cable below the top (a logical line over it and more is longer)');
  assert.equal(T.travelMs(80, sc), T.TRAVEL_MAX);
  assert.equal(T.travelMs(10000, sc), T.TRAVEL_MAX, 'beyond the scale: the top, never more');
  assert.equal(T.travelMs(0.00001, sc), T.TRAVEL_MIN, 'below it: the bottom, never less');
  // monotonic in the cost, and not a clamp of raw milliseconds: costs between the ends all differ
  let last = 0;
  const seen = new Set();
  for (const c of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 40, 80]) {
    const d = T.travelMs(c, sc);
    assert.ok(d >= last && within(d), `${c} ms: ${d}`);
    seen.add(Math.round(d));
    last = d;
  }
  assert.equal(seen.size, 10, 'every cost its own time');
  // a homogeneous model: the window widened to TRAVEL_DECADES, a fifth of it below its cables — they sit just inside the
  // bounds, never on the floor; a smaller frame or a faster link a little shorter, a lane over two cables, a larger
  // frame or a link ten times slower longer
  const hom = T.travelScale([0.1064, 0.1064]);
  assert.ok(Math.abs(Math.log10(hom.hi / hom.lo) - T.TRAVEL_DECADES) < 1e-9);
  const one = T.travelMs(0.1064, hom);
  assert.ok(one > T.TRAVEL_MIN + 200 && one < T.TRAVEL_MIN + 400, `a cable of a homogeneous model: ${one}`);
  assert.ok(T.travelMs(0.101, hom) < one, 'a 64-byte frame: a little shorter');
  assert.ok(T.travelMs(0.112, hom) > one, 'a 1500-byte frame on the same gigabit cable: a little longer');
  assert.ok(T.travelMs(0.2128, hom) > one + 250, 'two cables');
  assert.ok(T.travelMs(0.01064, hom) === T.TRAVEL_MIN, 'ten times cheaper: the floor');
  assert.ok(T.travelMs(1.064, hom) > T.TRAVEL_MIN + 1000 && T.travelMs(1.064, hom) < T.TRAVEL_MAX, 'ten times dearer: above the middle');
  // no cost (none modelled, zero, unknown) or no scale (no cables): the neutral middle
  for (const c of [0, -1, NaN, Infinity, null, undefined]) assert.equal(T.travelMs(c, sc), T.TRAVEL_NEUTRAL, String(c));
  assert.equal(T.travelMs(1, null), T.TRAVEL_NEUTRAL);
  assert.equal(T.travelScale([]), null);
  assert.equal(T.travelScale([0, NaN]), null);
});

test('a model\'s cables: the WAN link visibly longer than the LAN cables; the scale fixed by the model, not by the traffic', () => {
  const { sim, until, seen } = paced(WAN(20));
  until(() => sim.now > 3000);
  const t = sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  until(() => t.done);
  assert.equal(t.ok, true, t.result);
  const ours = Array.from(seen).filter((it) => it.f.test === t.id && it.f.view === 'physical');
  const wan = ours.filter((it) => it.f.track.ref === 'link:l2');
  const lan = ours.filter((it) => it.f.track.ref === 'link:l1');
  assert.ok(wan.length && lan.length);
  for (const it of ours) assert.ok(within(it.hop), `${it.f.track.ref}: ${it.hop}`);
  assert.ok(Math.min(...wan.map((x) => x.hop)) > Math.max(...lan.map((x) => x.hop)) + 500, 'the WAN hop is visibly longer');
  // each hop's time is the mapping of its own modelled time (the engine's wire timing, t1 − t0: latency and serialization once)
  const sc = travelOf(sim.engine)();
  for (const it of ours) assert.equal(it.hop, T.travelMs(it.f.t1 - it.f.t0, sc));
  // a 0.1 ms WAN link instead: the same cable no longer longer
  const q = paced(WAN(0.1));
  q.until(() => q.sim.now > 3000);
  const u = q.sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  q.until(() => u.done);
  const w2 = Array.from(q.seen).filter((it) => it.f.test === u.id && it.f.track.ref === 'link:l2');
  assert.ok(w2.length && w2.every((it) => it.hop < Math.min(...wan.map((x) => x.hop)) - 500));
});

test('a relation\'s lane reflects its modelled underlay: a GRE keepalive over a 20 ms link longer than over a 0.1 ms one, its estimate the underlay\'s cables', () => {
  const lane = (lat) => {
    const { sim, p, until } = paced(WAN(lat), { view: 'logical' });
    until(() => p.items.some((it) => it.f.track.ref === 'relation:gre1'), 900000);
    const it = p.items.find((x) => x.f.track.ref === 'relation:gre1');
    // the lane's modelled cost: the cable between the tunnel's ends, its own latency and a small frame at its speed
    assert.ok(Math.abs(it.f.t1 - it.f.t0 - sim.engine.linkCost('l2')) < 1e-9, `${it.f.t1 - it.f.t0} vs ${sim.engine.linkCost('l2')}`);
    assert.ok(within(it.hop));
    return it.hop;
  };
  const slow = lane(20);
  const fast = lane(0.1);
  assert.ok(slow > fast + 500, `${slow} vs ${fast}`);
});

// ------------------------------------------------------------------ playback

test('a tunnel in the physical and the logical view: one hold for its journey (the view on screen), no restart on a switch, the headless outcome', () => {
  const ref = new S.Simulation(model(WAN(20)));
  const { sim, p, st, frames, until, to } = paced(WAN(20));
  to(3000);
  const t = sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  // on its way in the physical view
  until(() => p.items.some((it) => it.f.test === t.id && it.f.track.ref === 'link:l2' && p.state(it).phase === 'moving'));
  const before = new Map(p.items.map((it) => [it, [it.d0, it.hop, it.transit]]));
  // one hop held at a time, and only in the view on screen
  const h = p.holding();
  assert.ok(!h || h.f.view === 'physical');
  st.view = 'logical';
  p.reshow();
  frames(500);
  // nothing still kept restarted or re-timed: a dot's start, its time and its crossing stay what they were
  for (const it of p.items) if (before.has(it)) assert.deepEqual([it.d0, it.hop, it.transit], before.get(it), it.f.label);
  // the other view's hops hold nothing now: the hold is the logical view's or none (never both)
  const h2 = p.holding();
  assert.ok(!h2 || h2.f.view === 'logical', h2 && h2.f.label);
  st.view = 'physical';
  p.reshow();
  until(() => t.done);
  assert.equal(t.ok, true, t.result);
  ref.runTo(3000);
  const r = ref.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  ref.runTo(sim.now);
  assert.equal(r.started, t.started);
  assert.deepEqual(simulated(sim, sim.now), simulated(ref, sim.now), 'the same events and outcome as headless');
});

test('pause freezes a dot where it is; resume goes on from there; the speed divides the time (2× half, 0.5× double) without changing the hop', () => {
  /** A ping's first moving hop at a speed, and the real ms of frames it takes from there to its arrival. */
  const run = (speed) => {
    const { sim, p, until } = paced(WAN(20), { set: { speed } });
    until(() => sim.now > 3000);
    const t = sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
    until(() => p.items.some((it) => it.f.test === t.id && p.state(it).phase === 'moving'));
    const it = p.items.find((x) => x.f.test === t.id && p.state(x).phase === 'moving');
    // paused: no frames (the page's loop stands, whatever real time passes): the dot keeps its place
    const st0 = p.state(it);
    assert.deepEqual(p.state(it), st0);
    let real = 0;
    while (p.state(it).phase === 'moving') {
      p.frame(10);
      real += 10;
      if (real === 50) assert.ok(p.state(it).frac > st0.frac, 'resumed: on from where it stood');
    }
    return { hop: it.hop, left: (1 - st0.frac) * it.hop, real, it, p };
  };
  const one = run(1);
  const two = run(2);
  const slow = run(0.5);
  assert.ok(within(one.hop));
  assert.equal(two.hop, one.hop, 'the speed does not change the hop itself');
  assert.equal(slow.hop, one.hop);
  // the rest of its crossing in real time: its display time ÷ the speed (to a frame)
  for (const [x, sp] of [[one, 1], [two, 2], [slow, 0.5]]) assert.ok(Math.abs(x.real - x.left / sp) <= 10 + 1e-6, `${sp}×: ${x.real} real ms for ${x.left} left`);
  // a change of speed on the way: the dot keeps its place (the clock is continuous) and goes on faster
  const q = paced(WAN(20));
  q.until(() => q.sim.now > 3000);
  const t = q.sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  q.until(() => q.p.items.some((it) => it.f.test === t.id && q.p.state(it).phase === 'moving'));
  const it = q.p.items.find((x) => x.f.test === t.id && q.p.state(x).phase === 'moving');
  q.p.frame(500);
  const at = q.p.state(it).frac;
  q.p.speed = 4;
  assert.equal(q.p.state(it).frac, at);
  q.p.frame(100);
  assert.ok(Math.abs(q.p.state(it).frac - Math.min(1, at + 400 / it.hop)) < 1e-6, '100 real ms at 4×: 400 ms of its crossing');
});

test('cancellation on the way: detaching the pacing lets the simulation run on at once (no wait for a dot), to the headless outcome', () => {
  const ref = new S.Simulation(model(WAN(20)));
  const { sim, p, until, to } = paced(WAN(20));
  to(3000);
  const t = sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  until(() => p.items.some((it) => it.f.test === t.id && it.f.track.ref === 'link:l2' && p.state(it).phase === 'moving'));
  assert.ok(p.holding(), 'a dot holds its delivery');
  const t0 = Date.now();
  p.detach();
  sim.runTo(sim.now + 10000);
  assert.ok(Date.now() - t0 < 2000, 'no display wait');
  assert.equal(t.done, true);
  ref.runTo(3000);
  const r = ref.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  ref.runTo(sim.now);
  assert.deepEqual([r.started, r.ok, r.result], [t.started, t.ok, t.result]);
  assert.deepEqual(simulated(sim, sim.now), simulated(ref, sim.now));
});

test('several packets at once stay concurrent; a multi-hop path takes its hops one after the other, each 3–5 s, the whole bounded', () => {
  const { sim, p, until, seen } = paced(WAN(20));
  until(() => sim.now > 3000);
  const a = sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  const b = sim.sendTest({ from: 'hc', to: '10.2.0.10', kind: 'icmp' });
  let together = 0;
  const start = p.clock;
  until(() => {
    const moving = new Set(p.items.filter((it) => it.f.view === 'physical' && it.f.test !== undefined && p.state(it).phase === 'moving').map((it) => it.f.test));
    together = Math.max(together, moving.size);
    return a.done && b.done;
  });
  assert.ok(together >= 2, 'both on their way at the same time (not serialized for readability)');
  assert.equal(a.ok && b.ok, true);
  const hops = Array.from(seen).filter((it) => it.f.test === a.id && it.f.view === 'physical');
  // the request ha → sw → a → (WAN) → b → hb and the reply back, after the ARP: each hop within the bounds
  assert.ok(hops.length >= 8, String(hops.length));
  for (const it of hops) assert.ok(within(it.hop), `${it.f.track.ref}: ${it.hop}`);
  // the request's cables one after the other (each after the one it continues arrived)
  for (const it of hops) if (it.parent) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6);
  // the whole exchange no longer than its hops at the top and their crossings (plus the frame steps)
  const took = p.clock - start;
  assert.ok(took <= hops.length * (T.TRAVEL_MAX + P.TRANSIT_MS) + 5000, `${took} ms for ${hops.length} hops`);
});

test('headless and paced at every speed and view: the same events and outcomes under the same simulated-time schedule', () => {
  const ref = new S.Simulation(model(WAN(20)));
  ref.runTo(3000);
  ref.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
  ref.runTo(40000);
  for (const [speed, view] of [[1, 'physical'], [4, 'logical'], [0.5, 'physical']]) {
    const { sim, to } = paced(WAN(20), { view, set: { speed } });
    to(3000);
    assert.equal(sim.now, 3000);
    sim.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp' });
    to(40000);
    assert.deepEqual(simulated(sim, 40000), simulated(ref, 40000), `${speed}× ${view}`);
  }
});
