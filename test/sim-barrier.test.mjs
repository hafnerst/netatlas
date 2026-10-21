// Readable playback waits for the dots (pacing.ts with the engine's
// presentation hold): a delivery happens only once the dot that brings it
// has arrived on screen — before it, nothing it causes exists (no learned
// entry, no answer, no next hop); after it, at its own simulated time. Every
// test here checks that barrier at every frame (the simulated clock never
// passes the arrival of a gated hop still on its way on screen), and that
// it changes nothing simulated: the same model and the same actions at the
// same scenario times give the same events, the same connections and the
// same outcomes headless, in Readable, Proportional and Real time pacing,
// at any speed, with any filter, dot limit, view or follow — only the
// display and the wall-clock time differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

const PS = example('protocol-simulation.yaml');
const HOUSE = example('private-house.yaml');

// two switches between a host, a second host and a server, all in one subnet: an ARP over three cables
const LAN = (x = {}) => `netatlas: 1
title: lan
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.10/24}]}
  - {id: pcb, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: sw1, type: switch, igmp_mld_snooping: {1: ${x.snoop || 'enabled'}}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
  - {id: sw2, type: switch, igmp_mld_snooping: {1: ${x.snoop || 'enabled'}}, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.20/24}], simulation: {listening: "tcp/80"}}
  - {id: rx, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.30/24}]}
links:
  - {id: a, a: "pc:eth0", b: "sw1:p1"${x.lat !== undefined ? ', simulation: {latency: ' + x.lat + '}' : ''}}
  - {id: b, a: "pcb:eth0", b: "sw1:p2"}
  - {id: c, a: "sw1:p3", b: "sw2:p1"}
  - {id: d, a: "sw2:p2", b: "srv:eth0"}
  - {id: e, a: "sw2:p3", b: "rx:eth0"}
`;

/** The barrier: no gated hop still on its way on screen has been delivered (the simulated clock is not past its arrival). */
function barrierHolds(sim, p) {
  for (const it of p.items)
    if (it.f.view === 'physical' && p.gated(it) && p.clock < p.arrival(it) - 1e-6) assert.ok(sim.now <= it.f.t1 + 1e-9, `${it.f.label} on ${it.f.track.ref} is still on its way on screen, but the simulation is at ${sim.now}, past its arrival at ${it.f.t1}`);
}

/**
 * A simulation with its pacer as the page has them. `frame()` checks the barrier after every frame of the physical view;
 * `to(t)` plays until the simulated clock is exactly at t (the pacer's cap), so actions are made at the same scenario
 * time as headless; `made`: every client connection created ("t|device|port|what").
 */
function paced(text, o = {}) {
  const sim = withClock(new S.Simulation(model(text)));
  const made = traced(sim);
  const st = { view: o.view || 'physical', cap: null, hide: o.hide || null };
  const host = {
    engine: sim.engine,
    shown: (f) => f.view === st.view && !(st.hide && st.hide(f)),
    typical: () => sim.engine.hopTime(),
    headers: (f) => f.hdr,
    foreground: () => sim.foregroundActive(),
    epoch: () => sim.presentationEpoch,
    until: () => st.cap,
  };
  const p = new P.Pacer(host, o.limit || 48);
  Object.assign(p, o.set || {});
  const hooks = [];
  const frame = (ms = 50) => {
    p.frame(ms);
    if (st.view === 'physical') barrierHolds(sim, p);
    for (const h of hooks) h();
  };
  const until = (cond, max = 900000 / Math.min(1, p.speed)) => {
    for (let t = 0; t < max && !cond(); t += 50) frame();
    assert.ok(cond(), `not within ${max} ms of display (simulated ${sim.now})`);
  };
  const to = (t) => {
    st.cap = t;
    until(() => sim.now >= t - 1e-9);
    st.cap = null;
  };
  return { sim, p, frame, until, to, made, st, hooks };
}

/**
 * Record what a simulation creates, as it creates it (the engine keeps only its recent flights, pruned whenever it stops,
 * which the pacing changes): every client connection ("t|device|port|what", returned) and every flight (sim.created).
 */
function traced(sim) {
  const made = [];
  const tr = sim.transport;
  const orig = tr.newConn.bind(tr);
  tr.newConn = (c) => {
    const x = orig(c);
    if (c.role === 'client') made.push(`${sim.now.toFixed(9)}|${c.dev}|${c.lport}|${c.what}`);
    return x;
  };
  const e = sim.engine;
  const fl = e.flight.bind(e);
  sim.created = [];
  e.flight = (...a) => {
    const x = fl(...a);
    sim.created.push(x);
    return x;
  };
  return made;
}

/** Everything simulated, as a comparable text: the log, every flight (deliveries, drops), the tests' outcomes. */
function simulated(sim, upTo) {
  const ev = sim.events().filter((e) => e.t <= upTo).map((e) => `${e.t.toFixed(9)}|${e.kind}|${e.protocol}|${e.device}|${e.peer}|${e.what}|${e.state}|${e.detail}`);
  const fl = (sim.created || sim.engine.flights).filter((f) => f.t0 <= upTo).map((f) => `${f.t0.toFixed(9)}|${f.t1.toFixed(9)}|${f.view}|${f.track.ref}|${f.track.from}>${f.track.to}|${f.label}|${f.dropped === undefined ? '' : f.dropped.toFixed(9)}`);
  const tests = sim.tests().filter((t) => t.started <= upTo).map((t) => `${t.series}|${t.started.toFixed(9)}|${t.done}|${t.ok}|${t.result}`);
  return { ev, fl, tests };
}

// ------------------------------------------------------------------ the visible order of ARP and TCP

test('ARP over three cables, then TCP: each delivery after its dot arrived; the reply after the request reached the server; the waiting SYN after the reply reached the client; SYN → SYN-ACK → ACK → data, each after the one before arrived', () => {
  const m = paced(LAN());
  m.to(3000);
  // (the scenario's own start is over: the first message of each kind was shown; now a test of our own, always drawn)
  const t = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'tcp', port: 80 });
  const id = t.id;
  // the ARP entry pc learns: only once the reply's dot reached pc (the barrier, checked every frame), never before
  let learnedAt = null;
  m.hooks.push(() => {
    if (learnedAt === null && m.sim.events().some((e) => e.device === 'pc' && e.kind === 'table' && /ARP Reply: 10\.0\.0\.20 is at/.test(e.detail) && e.t >= 3000)) learnedAt = m.p.clock;
  });
  const seen = new Map();
  m.hooks.push(() => {
    for (const it of m.p.items) if (it.f.test === id && it.f.view === 'physical') seen.set(it.f.id, it);
  });
  m.until(() => t.done && m.p.items.every((it) => it.f.test !== id || m.p.state(it).phase === 'gone'));
  assert.equal(t.ok, true, t.result);
  const hops = Array.from(seen.values());
  const of = (re) => hops.filter((it) => re.test(it.f.label));
  const lastArrival = (list) => Math.max(...list.map((it) => m.p.arrival(it)));
  const firstStart = (list) => Math.min(...list.map((it) => it.d0));
  const req = of(/^ARP Request/);
  const rep = of(/^ARP Reply/);
  const syn = of(/TCP \[S\] /);
  const synack = of(/TCP \[S,A\]/);
  const ack = of(/^TCP \[A\]$/);
  const data = of(/TCP \[P,A\]/);
  assert.equal(req.filter((it) => it.f.track.ref === 'link:d').length, 1, 'the request reached the server over three cables');
  assert.equal(rep.length, 3, 'the reply back over three cables');
  for (const list of [req, rep, syn, synack, ack, data]) assert.ok(list.length >= 1 && list.every((it) => it.drawn), list.map((it) => it.f.label).join());
  // the order on screen is the causal one, each step after the dot of the one before arrived
  assert.ok(firstStart(rep) >= Math.max(...req.filter((it) => it.f.track.ref === 'link:d').map((it) => m.p.arrival(it))) - 1e-6, 'the reply after the request reached srv');
  assert.ok(firstStart(syn) >= lastArrival(rep) - 1e-6, 'the waiting SYN released after the reply reached pc');
  assert.ok(learnedAt !== null && learnedAt >= lastArrival(rep) - 1e-6, 'pc learned srv’s address when the reply arrived');
  assert.ok(firstStart(synack) >= lastArrival(syn) - 1e-6, 'SYN-ACK after the SYN arrived');
  assert.ok(firstStart(ack) >= lastArrival(synack) - 1e-6, 'ACK after the SYN-ACK arrived');
  assert.ok(firstStart(data) >= lastArrival(synack) - 1e-6, 'the request after the handshake');
  // a warm cache: the next test to the same server needs no ARP
  const t2 = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'tcp', port: 80 });
  m.until(() => t2.done);
  assert.equal(t2.ok, true, t2.result);
  assert.ok(!m.sim.engine.flights.some((f) => f.test === t2.id && f.protocol === 'arp'), 'no ARP with the entry cached');
});

test('independent exchanges are on screen together: two hosts’ tests move at once (the barrier waits for one arrival at a time, not for a whole conversation)', () => {
  const m = paced(LAN());
  m.to(3000);
  const a = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  const b = m.sim.sendTest({ from: 'pcb', to: '10.0.0.30', kind: 'icmp' });
  let together = 0;
  m.hooks.push(() => {
    const moving = m.p.items.filter((it) => it.drawn && m.p.state(it).phase === 'moving');
    if (moving.some((it) => it.f.test === a.id) && moving.some((it) => it.f.test === b.id)) together++;
  });
  m.until(() => a.done && b.done);
  assert.ok(a.ok && b.ok, `${a.result} / ${b.result}`);
  assert.ok(together > 20, `${together} frames with both moving`);
});

// ------------------------------------------------------------------ multicast

test('multicast: a stream runs before the join; the switch learns the member port when the report arrives on screen; the next datagrams reach the TV; after the leave, none; each copy forwarded only after its upstream copy arrived', () => {
  const m = paced(HOUSE);
  m.to(40000);
  const flights = () => m.sim.engine.flights.filter((f) => f.view === 'physical');
  m.sim.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  m.to(44000);
  const streamed = flights().filter((f) => f.protocol === 'mcast');
  assert.ok(streamed.length >= 3, 'the stream runs before anyone joined');
  assert.ok(!streamed.some((f) => f.track.ref === 'link:w-tv'), 'nothing to the TV yet');
  // the join: its report is a Network event's (drawn, gated)
  const joinAt = m.sim.now;
  const j = m.sim.actJoin('tv', 'wlan0', '239.20.0.1', []);
  assert.equal(j.error, undefined);
  const learnedRe = /port ap is a member port of 239\.20\.0\.1/;
  let learned = null;
  m.hooks.push(() => {
    if (learned) return;
    const e = m.sim.events().find((x) => x.device === 'core' && x.what === 'snooping' && learnedRe.test(x.detail) && x.t >= joinAt);
    if (!e) return;
    // the report that taught it: a dot on its last cable into core, arrived at e.t — and arrived on screen by now
    const r = m.p.items.find((it) => it.f.protocol === 'igmp' && /Report 239\.20\.0\.1/.test(it.f.label) && Math.abs(it.f.t1 - e.t) < 1e-6);
    learned = { e, clock: m.p.clock, r };
  });
  m.until(() => learned !== null);
  assert.ok(learned.r, 'the report’s dot is on screen');
  assert.ok(learned.clock >= m.p.arrival(learned.r) - 1e-6, 'learned only once the report arrived on screen');
  // later forwarding uses it: copies to the TV, none forwarded before the switch learned
  m.until(() => flights().filter((f) => f.protocol === 'mcast' && f.track.ref === 'link:w-tv').length >= 3);
  const tv = flights().filter((f) => f.protocol === 'mcast' && f.track.ref === 'link:w-tv');
  assert.ok(tv.every((f) => f.t0 >= learned.e.t - 1e-9), 'no copy to the TV before the member port');
  // each copy is forwarded from an upstream copy that had arrived (in simulated time), never ahead of it
  for (const f of flights().filter((x) => x.protocol === 'mcast' && x.parent !== undefined)) {
    const up = m.sim.engine.flights.find((x) => x.id === f.parent);
    if (up) assert.ok(f.t0 >= up.t1 - 1e-9, `${f.track.ref} forwarded before ${up.track.ref} arrived`);
  }
  // the leave: after the port is gone, nothing more to the TV
  const leaveAt = m.sim.now;
  assert.equal(m.sim.actLeave('tv', 'wlan0', '239.20.0.1').error, undefined);
  m.until(() => m.sim.events().some((e) => e.device === 'core' && e.what === 'member port expired' && e.t >= leaveAt));
  const gone = m.sim.events().find((e) => e.device === 'core' && e.what === 'member port expired' && e.t >= leaveAt);
  m.to(m.sim.now + 3000);
  assert.ok(!flights().some((f) => f.protocol === 'mcast' && f.track.ref === 'link:w-tv' && f.t0 > gone.t + 1e-9), 'no copy to the TV after the leave took effect');
});

test('multicast flooding where snooping is off: a stream reaches every port without any member — the flood is the model’s, the barrier changes none of it', () => {
  const m = paced(LAN({ snoop: 'disabled' }));
  m.to(3000);
  m.sim.actStream('pc', 'eth0', '239.9.9.9', 5004, 500, 200);
  m.to(6000);
  const on = (l) => m.sim.engine.flights.filter((f) => f.protocol === 'mcast' && f.track.ref === 'link:' + l).length;
  for (const l of ['b', 'c', 'd', 'e']) assert.ok(on(l) >= 3, `link ${l}: ${on(l)}`);
  const ref = withClock(new S.Simulation(model(LAN({ snoop: 'disabled' }))));
  traced(ref);
  ref.runTo(3000);
  ref.actStream('pc', 'eth0', '239.9.9.9', 5004, 500, 200);
  ref.runTo(6000);
  assert.deepEqual(simulated(m.sim, 6000), simulated(ref, 6000));
});

// ------------------------------------------------------------------ scheduling

test('the engine: a held delivery stops runUntil before it, event by event — what comes before it at the same moment is done, what comes after is not; released, the rest in their order', () => {
  const sim = new S.Simulation(model(LAN()));
  const e = sim.engine;
  e.run(500);
  const order = [];
  const T = e.now + 1;
  let held = true;
  e.hold = (id) => id === 424242 && held;
  e.at(T, () => order.push('a'));
  e.at(T, () => order.push('held'), [424242]);
  e.at(T, () => order.push('b'));
  // (a zero-latency delivery due now: held as well)
  e.at(e.now, () => order.push('now'), [424242]);
  assert.equal(e.runUntil(T + 10, () => false), true);
  assert.equal(e.held, 424242);
  assert.deepEqual(order, []);
  assert.ok(e.now < T);
  assert.equal(e.heldNext(), 424242);
  held = false;
  assert.equal(e.runUntil(T + 10, () => false), false);
  assert.deepEqual(order, ['now', 'a', 'held', 'b']);
  // held again at the same moment as others: those before it (by their sequence) run
  const order2 = [];
  held = true;
  const T2 = e.now + 1;
  e.at(T2, () => order2.push('x'));
  e.at(T2, () => order2.push('held'), [424242]);
  e.at(T2, () => order2.push('y'));
  e.runUntil(T2 + 1, () => false);
  assert.deepEqual(order2, ['x']);
  assert.equal(e.now, T2, 'at the moment of the last event done');
  held = false;
  e.runUntil(T2 + 1, () => false);
  assert.deepEqual(order2, ['x', 'held', 'y']);
  // run (a jump, the tests) never asks
  held = true;
  const order3 = [];
  e.at(e.now + 1, () => order3.push('held'), [424242]);
  e.run(e.now + 2);
  assert.deepEqual(order3, ['held']);
  e.hold = null;
});

test('a zero-latency cable: its dot still gets its screen time and the delivery waits for it (registered by the hold itself, within the same batch)', () => {
  const m = paced(LAN({ lat: 0 }));
  // (the fixture really is zero: the cable's own latency, resolved as written)
  const r = m.sim.engine.latency('a');
  assert.deepEqual([r.value, r.source], [0, 'configured']);
  assert.notEqual(paced(LAN()).sim.engine.latency('a').value, 0, 'the default is not zero');
  m.to(3000);
  const t = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  let min = Infinity;
  m.hooks.push(() => {
    for (const it of m.p.items) if (it.f.test === t.id && it.f.track.ref === 'link:a') min = Math.min(min, it.hop);
  });
  m.until(() => t.done);
  assert.equal(t.ok, true, t.result);
  assert.ok(min >= P.HOP_MIN, String(min));
});

test('a cable failing under a dot on its way: the dot is lost there, its hold goes with it (no deadlock), and the outcome is the headless one', () => {
  const m = paced(LAN());
  m.to(3000);
  const t = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  // until a dot of it is on its way over cable c
  m.until(() => m.p.items.some((it) => it.f.test === t.id && it.f.track.ref === 'link:c' && m.p.state(it).phase === 'moving'));
  const failAt = m.sim.now;
  assert.ok(m.sim.fail('link:c'));
  const it = m.p.items.find((x) => x.f.test === t.id && x.f.track.ref === 'link:c');
  assert.notEqual(it.f.dropped, undefined, 'lost on the cable');
  assert.equal(m.p.gated(it), false, 'it holds nothing any more');
  m.until(() => t.done);
  assert.equal(t.ok, false);
  const ref = new S.Simulation(model(LAN()));
  ref.runTo(3000);
  const rt = ref.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  ref.runTo(failAt);
  ref.fail('link:c');
  ref.runTo(m.sim.now);
  assert.equal(rt.result, t.result);
});

test('Step: the next visible delivery happens (at its own simulated time) and what it causes appears; nothing later — the other dots on their way stay held; Next exchange ends the exchange first on screen', () => {
  const m = paced(LAN());
  m.to(3000);
  const t = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'tcp', port: 80 });
  m.p.take();
  for (let i = 0; i < 6; i++) {
    const pending = m.p.items.filter((it) => it.f.view === 'physical' && m.p.gated(it) && m.p.clock < m.p.arrival(it) - 1e-6);
    if (!pending.length) break;
    const next = pending.reduce((a, b) => (m.p.arrival(a) <= m.p.arrival(b) ? a : b));
    const n0 = m.sim.engine.flights.length;
    m.p.step();
    assert.ok(m.sim.now >= next.f.t1 - 1e-9, `${next.f.label} delivered by the Step`);
    barrierHolds(m.sim, m.p);
    // what it caused at once is on screen now (an answer, the next cable), at its sender
    const caused = m.sim.engine.flights.slice(n0).filter((f) => f.view === 'physical');
    for (const f of caused) assert.ok(f.t0 >= next.f.t1 - 1e-9);
  }
  m.p.stepExchange();
  barrierHolds(m.sim, m.p);
  m.until(() => t.done);
  assert.equal(t.ok, true, t.result);
});

test('stop, exit, a new simulation: the pacer lets go of its engine (nothing held any more); a new one starts afresh', () => {
  const m = paced(LAN());
  m.to(3000);
  m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  for (let i = 0; i < 5; i++) m.frame();
  assert.ok(m.p.holding(), 'held by a dot on its way');
  m.p.detach();
  assert.equal(m.sim.engine.hold, null);
  assert.equal(m.sim.engine.runUntil(m.sim.now + 5000, () => false), false, 'free');
  // a new simulation of the same model (a model replaced, the simulation started again): its own pacer, its own holds
  const n = paced(LAN());
  n.to(3000);
  assert.equal(n.sim.now, 3000);
});

// ------------------------------------------------------------------ the same simulation, whatever is shown

/** The model's scenario with the same actions at the same scenario times; `drive(to)` reaches each time its own way. */
function scenario(drive, sim) {
  const done = [];
  drive(6000);
  done.push(sim.sendTest({ from: 'pc1', to: '10.10.20.22', kind: 'tcp', port: 80 }));
  drive(7500);
  done.push(sim.sendTest({ from: 'pc2', to: '10.10.10.21', kind: 'icmp' }));
  drive(9000);
  done.push(sim.sendTest({ from: 'pc1', to: '10.10.20.22', kind: 'udp', port: 53 }));
  drive(16000);
  return done;
}

test('semantic invariance: headless, Readable, Proportional, Real time, any speed, filter, dot limit, view, follow and their changes on the way — the same events, deliveries and drops, connections and outcomes', () => {
  const END = 16000;
  const ref = new S.Simulation(model(PS));
  const refMade = traced(ref);
  scenario((t) => ref.runTo(t), ref);
  const want = simulated(ref, END);
  assert.ok(want.ev.length > 200 && refMade.length >= 1, `${want.ev.length} events, ${refMade.length} connections`);
  const variants = {
    readable: {},
    'readable 4×': { set: { speed: 4 } },
    'readable 0.25×': { set: { speed: 0.25 } },
    proportional: { set: { mode: 'proportional', scale: 100 } },
    'real time': { set: { mode: 'realtime' } },
    logical: { view: 'logical' },
    'no OSPF shown': { hide: (f) => f.protocol === 'ospf' },
    'dot limit 2': { limit: 2, set: { convLimit: 1 } },
    'no idle skipping': { set: { skipIdle: false, speed: 4 } },
    'every repeat drawn': { set: { summarizeRepeats: false, speed: 4 } },
  };
  for (const [name, o] of Object.entries(variants)) {
    const m = paced(PS, o);
    scenario((t) => m.to(t), m.sim);
    const got = simulated(m.sim, END);
    assert.deepEqual(got.tests, want.tests, name);
    assert.deepEqual(m.made, refMade, `${name}: the connections created`);
    assert.deepEqual(got.fl, want.fl, `${name}: the flights (deliveries, drops)`);
    assert.deepEqual(got.ev, want.ev, `${name}: the log`);
  }
  // the controls changed on the way: view, pacing, speed, follow, limit, filter — no action resubmitted, no extra connection
  const m = paced(PS);
  let k = 0;
  const changes = [
    () => (m.st.view = 'logical'),
    () => (m.p.mode = 'realtime'),
    () => (m.st.view = 'physical'),
    () => (m.p.mode = 'readable'),
    () => (m.p.speed = 4),
    () => {
      const it = m.p.items.find((x) => x.drawn);
      if (it) m.p.followFlight(it.f.id);
    },
    () => (m.p.limit = 1),
    () => (m.st.hide = (f) => f.protocol === 'arp'),
    () => m.p.followFlight(null),
    () => (m.p.mode = 'proportional'),
    () => (m.st.hide = null),
  ];
  // (each change through the one path the page takes: Pacer.reshow)
  let r = 7;
  m.hooks.push(() => {
    r = (r * 1103515245 + 12345) % 2147483648;
    if (r % 50 === 0 && k < changes.length * 4) {
      changes[k++ % changes.length]();
      m.p.reshow();
    }
  });
  scenario((t) => m.to(t), m.sim);
  const got = simulated(m.sim, END);
  assert.ok(k >= changes.length, `${k} changes made`);
  assert.deepEqual(got.tests, want.tests, 'changing controls');
  assert.deepEqual(m.made, refMade, 'changing controls: the connections created');
  assert.deepEqual(got.ev, want.ev, 'changing controls: the log');
});

// ------------------------------------------------------------------ the steady state

test('the steady state is summarized: a kind of the scenario’s message seen once is cable activity afterwards (no wait for it); a Network event makes it news again; the startup is shown, then the simulation runs at its rate', () => {
  const m = paced(PS);
  m.to(20000);
  assert.ok(m.p.repeats > 0, 'repeats summarized');
  // at its rate now: 10 s of display, about 10 s of simulated time (a little less while a new kind is shown)
  const t0 = m.sim.now;
  for (let i = 0; i < 200; i++) m.frame();
  assert.ok(m.sim.now - t0 > 5000, `${m.sim.now - t0} ms simulated in 10 s`);
  // a Network event: the scenario's next messages are news again — a Hello drawn as a dot once more
  const before = m.p.repeats;
  m.sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.10.1', kind: 'icmp' });
  const drawnAfter = new Set();
  m.hooks.push(() => {
    for (const it of m.p.items) if (it.drawn && it.f.test === undefined && it.f.view === 'physical') drawnAfter.add(P.repeatKey(it.f));
  });
  m.until(() => drawnAfter.size >= 1, 120000);
  assert.ok(m.p.repeats >= before);
  // and the pacing text says what it waits for, when it waits
  m.until(() => !!m.p.holding(), 120000);
  assert.match(m.p.describe(), /^Readable · 3 s per hop · 1× · (your events in front · )?waiting for packet arrival/);
});

test('the words of a hold: neighbor resolution, establishing TCP, retransmitting SYN, a membership report — from the held hop itself', () => {
  const f = (o) => ({ id: 1, t0: 0, t1: 1, view: 'physical', track: { ref: 'link:x', from: 'a', to: 'b' }, ...o });
  assert.equal(P.holdText(f({ protocol: 'arp', label: 'ARP Request (broadcast): who has 10.0.0.1?' })), 'waiting for packet arrival (neighbor resolution)');
  assert.equal(P.holdText(f({ protocol: 'ndp', label: 'NDP NS Who has fd00::1?' })), 'waiting for packet arrival (neighbor resolution)');
  assert.equal(P.holdText(f({ protocol: 'tcp', label: 'TCP [S] → 10.0.0.20:80', flags: '[S]' })), 'waiting for packet arrival (establishing TCP)');
  assert.equal(P.holdText(f({ protocol: 'tcp', label: 'TCP [S] → 10.0.0.20:80 (retransmission)', flags: '[S]' })), 'waiting for packet arrival (retransmitting SYN)');
  assert.equal(P.holdText(f({ protocol: 'bgp', label: 'BGP TCP [S,A]', flags: '[S,A]' })), 'waiting for packet arrival (establishing TCP)');
  assert.equal(P.holdText(f({ protocol: 'igmp', label: 'IGMPv3 Report 239.1.1.1' })), 'waiting for packet arrival (membership report in transit)');
  assert.equal(P.holdText(f({ protocol: 'tcp', label: 'TCP [P,A] · 120 B', flags: '[P,A]' })), 'waiting for packet arrival');
  assert.equal(P.holdText(f({ protocol: 'ospf', label: 'OSPF Hello' })), 'waiting for packet arrival');
});

// ------------------------------------------------------------------ presentation eligibility, aggregation epochs, equal times

test('a held dot loses its drawing (a filter, a collapsed group, IP / Non-IP, no geometry: not shown any more): its hold is let go at once — no obsolete hold, no reordering, the headless outcome', () => {
  const run = (hideHeld) => {
    const m = paced(LAN());
    m.to(3000);
    const t = m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'tcp', port: 80 });
    let cut = null;
    if (hideHeld) {
      // as the page does when the track of the held dot leaves the scene: shown says no, and the change goes through reshow
      m.until(() => !!m.p.holding());
      cut = m.p.holding().f.track.ref;
      m.st.hide = (f) => f.track.ref === cut;
      m.p.reshow();
      m.frame();
      const h = m.p.holding();
      assert.ok(!h || h.f.track.ref !== cut, 'no hold on a dot that is not drawn');
      // nothing on that track waits from now on
      for (const it of m.p.items) if (it.f.track.ref === cut) assert.equal(m.p.gated(it), false);
    }
    m.until(() => t.done);
    m.to(20000);
    return { sim: simulated(m.sim, 20000), ok: t.ok, cut };
  };
  const shown = run(false);
  const hidden = run(true);
  assert.ok(hidden.cut, 'a dot was held and its track hidden');
  assert.equal(hidden.ok, true);
  assert.deepEqual(hidden.sim, shown.sim, 'the same events, flights and outcomes');
});

test('aggregation after failures and recovery: a failure and its restore through the plain API (no event of the list) make the scenario news again, then it is summarized again', () => {
  const m = paced(PS);
  m.to(30000);
  assert.ok(m.p.repeats > 0, 'the steady state is summarized');
  const seen = (pred) => {
    const s = new Set();
    m.hooks.push(() => {
      for (const it of m.p.items) if (it.drawn && it.f.test === undefined && it.f.view === 'physical' && pred(it)) s.add(P.repeatKey(it.f));
    });
    return s;
  };
  for (const [what, act] of [
    ['fail', () => m.sim.fail('link:l-acc-core1')],
    ['restore', () => m.sim.restore('link:l-acc-core1')],
    ['power off', () => m.sim.powerOff('pc2')],
    ['power on', () => m.sim.powerOn('pc2')],
  ]) {
    // a quiet stretch first: what the scenario sends is the steady state (cable activity)
    for (let i = 0; i < 200; i++) m.frame();
    const e0 = m.sim.presentationEpoch;
    assert.ok(act(), what);
    assert.equal(m.sim.presentationEpoch, e0 + 1, `${what} moves the presentation's epoch`);
    const t0 = m.sim.now;
    const after = seen((it) => it.f.t0 >= t0);
    const r0 = m.p.repeats;
    m.until(() => after.size >= 1, 300000);
    // and bounded: the same kinds become the steady state again
    m.until(() => m.p.repeats > r0, 600000);
  }
  // the network's own changes and packets do not move it
  const e1 = m.sim.presentationEpoch;
  for (let i = 0; i < 400; i++) m.frame();
  assert.equal(m.sim.presentationEpoch, e1);
});

test('the presentation epoch: each successful outside change counts once, a refused one not at all; flapping counts its transitions', () => {
  const sim = new S.Simulation(model(PS));
  sim.runTo(20000);
  const e = () => sim.presentationEpoch;
  const steps = [
    ['shut', () => sim.shut('pc1', 'eth0'), 1],
    ['shut again', () => sim.shut('pc1', 'eth0'), 0],
    ['no shut', () => sim.noShut('pc1', 'eth0'), 1],
    ['fail', () => sim.fail('link:l-pc2'), 1],
    ['fail unknown', () => sim.fail('link:nope'), 0],
    ['restore', () => sim.restore('link:l-pc2'), 1],
    ['power off', () => sim.powerOff('pc2'), 1],
    ['power on', () => sim.powerOn('pc2'), 1],
  ];
  for (const [what, act, n] of steps) {
    const before = e();
    act();
    assert.equal(e() - before, n, what);
  }
  const f0 = e();
  assert.ok(!sim.actFlap('iface:pc1:eth0').error);
  sim.runTo(sim.now + 30000);
  assert.ok(e() >= f0 + 3, 'its event, and its transitions while it flaps');
});

test('equal timestamps: a delivery processed at the engine’s own time is history, one still pending at that time keeps its dot and its hold; the order of events is kept', () => {
  const sim = withClock(new S.Simulation(model(LAN())));
  sim.runTo(3000);
  const e = sim.engine;
  const order = [];
  const msg = (n) => ({ protocol: 'icmp', type: 'probe ' + n, label: 'probe ' + n, detail: '', data: {} });
  // f1 not drawn (filtered), f2 drawn: the engine does f1 at t1 and stops before f2 — at the same time
  const st = { hide: (f) => f.id === f1.id };
  const p = new P.Pacer({ engine: e, shown: (f) => f.view === 'physical' && !st.hide(f), typical: () => e.hopTime(), headers: (f) => f.hdr }, 48);
  const t1 = e.now + 1;
  const f1 = e.flight(e.now, t1, msg(1), 'physical', { ref: 'link:a', from: 'a', to: 'b' });
  const f2 = e.flight(e.now, t1, msg(2), 'physical', { ref: 'link:b', from: 'a', to: 'b' });
  e.at(t1, () => order.push(1), [f1.id]);
  e.at(t1, () => order.push(2), [f2.id]);
  assert.deepEqual([f1.due, f2.due], [1, 1], 'both pending');
  for (let i = 0; i < 1000 && order.length < 1; i++) p.frame(16);
  assert.deepEqual(order, [1]);
  assert.equal(e.now, t1, 'stopped partway through the moment');
  assert.deepEqual([f1.due, f1.delivered, f2.due, !!f2.delivered], [0, true, 1, false]);
  assert.equal(p.holding() && p.holding().f.id, f2.id);
  assert.deepEqual([P.history(f1, e.now, f1.t1), P.history(f2, e.now, f2.t1)], [true, false], 'the same time, told apart by the lifecycle');
  // the filter is lifted between the two: f1 (processed) is not drawn travelling towards its arrival; f2 keeps its place and its hold
  st.hide = () => false;
  p.reshow();
  assert.ok(!p.find(f1.id), 'processed: not revived as pending');
  assert.ok(p.find(f2.id) && p.holding().f.id === f2.id, 'pending: kept, still held');
  // a change of pacing between them neither
  p.mode = 'proportional';
  p.reshow();
  p.mode = 'readable';
  assert.ok(p.find(f2.id));
  for (let i = 0; i < 1000 && order.length < 2; i++) p.frame(16);
  assert.deepEqual(order, [1, 2], 'in their order');
  assert.deepEqual([f2.due, f2.delivered], [0, true]);
  // a zero-time flight (its arrival at its own start): pending until its delivery runs
  const f3 = e.flight(e.now, e.now, msg(3), 'physical', { ref: 'link:a', from: 'a', to: 'b' });
  e.at(e.now, () => order.push(3), [f3.id]);
  assert.equal(P.history(f3, e.now, f3.t1), false);
  sim.runTo(e.now);
  assert.equal(P.history(f3, e.now, f3.t1), true);
  assert.deepEqual(order, [1, 2, 3]);
});

test('a receiving device’s state stays as it was until its dot arrives: the server learns the client’s address only when the held request is processed', () => {
  const m = paced(LAN());
  m.to(3000);
  m.sim.sendTest({ from: 'pc', to: '10.0.0.20', kind: 'icmp' });
  // the request's last cable to the server: held; the server knows nothing of pc until its delivery runs
  m.until(() => {
    const h = m.p.holding();
    return !!h && h.f.protocol === 'arp' && h.f.track.ref === 'link:d';
  });
  const h = m.p.holding();
  const knows = () => m.sim.arpTable('srv').some((r) => JSON.stringify(r).indexOf('10.0.0.10') >= 0);
  assert.equal(h.f.due, 1, 'its delivery is pending');
  assert.equal(knows(), false, 'nothing learned before the delivery');
  m.until(() => !h.f.due);
  assert.equal(h.f.delivered, true);
  assert.equal(knows(), true, 'learned when it is processed');
});
