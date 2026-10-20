// Execution and the display (pacing.ts), without a browser: the simulated
// clock runs at its rate, and waits before a delivery until its dot has
// arrived on screen (Readable); IGMP startup queries, protocol timers and
// independent exchanges keep their simulated times whatever is on screen,
// and independent exchanges are on screen together; the dots follow each
// operation's causal order (a hop after the one it continues, an answer
// after what it answers, which the simulation computes only once the
// request has arrived on screen); the same events in the same order
// whatever is drawn; a frame's work stays bounded. Foreground attribution
// by the operation's id: its messages, copies, answers and prerequisites
// (the ARP it needs) are the foreground, the scenario the background (muted)
// while it runs or its hops are on screen, and only then. A fake real clock
// drives the frames (no sleeping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

/** A simulation with its pacer, as the page has them; `frame(ms)`: one animation frame (the real-time schedule's turn, then the display's). */
function paced(name, set = {}) {
  const sim = withClock(new S.Simulation(model(example(name))));
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr, foreground: () => sim.foregroundActive() };
  const p = new P.Pacer(host, 48);
  Object.assign(p, set);
  const frame = (ms = 50) => {
    p.frame(ms);
  };
  return { sim, p, frame };
}
const run = (frame, ms, dt = 50) => {
  for (let t = 0; t < ms; t += dt) frame(dt);
};
/** Frames until `cond()` (at most `max` ms of display); returns the display time it took. */
const until = (frame, cond, max = 600000, dt = 50) => {
  let t = 0;
  for (; t < max && !cond(); t += dt) frame(dt);
  assert.ok(cond(), `not within ${max} ms of display`);
  return t;
};

// ------------------------------------------------------------------ IGMP startup

test('private house from a fresh start: the core (the snooping querier of VLANs 10, 20, 30) sends its first startup queries when its first port is up (t = 2 s, the link-up delay), drawn at once; the second a quarter of the query interval later (t = 33.25 s); the table says so', () => {
  const { sim, p, frame: frame0 } = paced('private-house.yaml');
  // (the frames' work budget never runs out here, however loaded the machine: the budget's own test is below)
  const frame = (ms) => {
    const real = Date.now;
    const t = real();
    Date.now = () => t;
    try {
      frame0(ms);
    } finally {
      Date.now = real;
    }
  };
  // the startup burst (DHCP, ARP …) is on screen meanwhile, each delivery after its dot: the queries keep their simulated time
  until(frame, () => sim.now >= 2500);
  // (the core is the snooping querier of VLANs 10, 20 and 30: one query each)
  const q = sim.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query');
  assert.equal(q.length, 3);
  assert.deepEqual(q.map((e) => Math.round(e.t)), [2000, 2000, 2000], 'at its deadline, not behind the scenario');
  assert.ok(q.some((e) => /^IGMPv3 General Query from core \(snooping querier, 192\.168\.20\.1\) in VLAN 20/.test(e.detail)));
  // its hops are taken in for the screen (drawn: a protocol with nothing else on screen gets a place)
  const hops = p.items.filter((it) => it.f.protocol === 'igmp');
  assert.ok(hops.length >= 2 && hops.some((it) => it.drawn), hops.map((it) => `${it.f.track.ref}:${it.drawn}`).join(', '));
  // the role and the timers, as the table has them
  const role = sim.multicast.querierRoles('core').find((r) => r.vlan === 20);
  assert.deepEqual([role.role, role.startup, Math.round(role.nextAt)], ['starting', '2 of 2', 33250]);
  assert.ok(sim.multicast.querierTable('core').rows.every((r) => r[5] === 'query at t = 33.3 s (startup 2 of 2)'));
  // on, past it: the second query at its deadline, then the querier elected, the next a query interval on
  until(frame, () => sim.now >= 34500);
  const q2 = sim.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query');
  assert.deepEqual(q2.map((e) => Math.round(e.t)), [2000, 2000, 2000, 33250, 33250, 33250]);
  assert.ok(sim.multicast.querierRoles('core').every((r) => r.role === 'querier' && Math.round(r.nextAt) === 33250 + 125000));
});

test('a new simulation starts its schedule afresh: the same deadlines, no second schedule; no candidate: no query at all', () => {
  const a = paced('private-house.yaml');
  const b = paced('private-house.yaml');
  until(a.frame, () => a.sim.now >= 40000);
  until(b.frame, () => b.sim.now >= 40000);
  const times = (s) => s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').map((e) => Math.round(e.t));
  assert.deepEqual(times(a.sim), [2000, 2000, 2000, 33250, 33250, 33250]);
  assert.deepEqual(times(b.sim), times(a.sim));
  // without the snooping querier: no candidate, nothing queried, nothing marked
  const none = withClock(new S.Simulation(model(example('private-house.yaml').split(', simulation: {snooping_querier: "on"}}').join('}'))));
  none.runTo(60000);
  assert.deepEqual(none.multicast.querierRoles(), []);
  assert.equal(none.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').length, 0);
});

// ------------------------------------------------------------------ concurrency

test('two independent operations progress together: both sends’ messages on screen at once; a longer exchange never delays a short one; one answer each, counted once', () => {
  const { sim, p, frame } = paced('protocol-simulation.yaml');
  run(frame, 8000);
  // pc1 → its gateway (one hop) and pc2 → pc1 (across core1, ARP first): independent
  const lan = sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.10.1', kind: 'icmp' });
  const wan = sim.actSend({ delivery: 'unicast', from: 'pc2', target: '10.10.10.21', kind: 'icmp' });
  assert.equal(lan.error, undefined);
  assert.equal(wan.error, undefined);
  let together = false;
  const finished = (a) => sim.actions().find((x) => x.id === a.id).status === 'completed';
  until(frame, () => {
    const moving = p.items.filter((it) => it.drawn && p.state(it).phase === 'moving');
    if (moving.some((it) => it.f.test === lan.run.tests[0].id) && moving.some((it) => it.f.test === wan.run.tests[0].id)) together = true;
    return finished(lan) && finished(wan);
  });
  assert.ok(together, 'both on screen at once');
  // the LAN echo answered at the same simulated time as when it runs alone
  const alone = paced('protocol-simulation.yaml');
  run(alone.frame, 8000);
  const solo = alone.sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.10.1', kind: 'icmp' });
  until(alone.frame, () => alone.sim.actions().find((x) => x.id === solo.id).status === 'completed');
  const done = (s, a) => s.events().find((e) => e.test === a.run.tests[0].id && e.what === 'Echo Reply' && e.kind === 'message');
  assert.ok(done(sim, lan) && done(alone.sim, solo));
  assert.equal(done(sim, lan).t - lan.at, done(alone.sim, solo).t - solo.at, 'the other one changed nothing');
  // one request, one reply each: no duplicate, no result counted twice
  for (const [s, a] of [[sim, lan], [sim, wan]]) {
    const v = s.actions().find((x) => x.id === a.id);
    assert.equal(v.status, 'completed', v.summary);
    assert.equal(v.outcome.ok, 1);
    assert.equal(s.events().filter((e) => e.test === a.run.tests[0].id && e.kind === 'message' && e.what === 'Echo Request').length, 1);
    assert.equal(s.events().filter((e) => e.test === a.run.tests[0].id && e.kind === 'message' && e.what === 'Echo Reply').length, 1);
  }
});

test('the causal order on screen: a reply’s first hop never starts before its request arrived; a continuing hop never before the one before it', () => {
  const { sim, p, frame } = paced('protocol-simulation.yaml');
  until(frame, () => sim.now >= 6000);
  const a = sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.20.22', kind: 'icmp' });
  const id = a.run.tests[0].id;
  const seen = new Set();
  // the simulation computes the reply only once the request has arrived on screen at pc2 (the barrier)
  let early = '';
  until(frame, () => {
    const replied = sim.events().some((e) => e.test === id && e.what === 'Echo Reply');
    for (const it of p.items) {
      if (it.f.test !== id || it.f.view !== 'physical') continue;
      seen.add(it);
      if (replied && /^ICMP Echo →/.test(it.f.label) && it.f.track.to && p.clock < p.arrival(it) - 1e-6 && !it.f.dropped && it.f.t1 <= sim.now && !early) early = it.f.label + ' on ' + it.f.track.ref;
    }
    return sim.actions().find((x) => x.id === a.id).status === 'completed' && p.items.every((it) => it.f.test !== id || p.state(it).phase === 'gone');
  });
  assert.equal(early, '', 'a request still on its way on screen was already delivered');
  const hops = Array.from(seen);
  const req = hops.filter((it) => /^ICMP Echo →/.test(it.f.label));
  const rep = hops.filter((it) => /^ICMP Echo Reply/.test(it.f.label));
  assert.ok(req.length >= 2 && rep.length >= 2, `${req.length} / ${rep.length}`);
  const lastReq = Math.max(...req.map((it) => p.arrival(it)));
  const firstRep = Math.min(...rep.map((it) => it.d0));
  assert.ok(firstRep >= lastReq - 1e-6, `the reply starts at ${firstRep}, the request arrived at ${lastReq}`);
  for (const it of hops) if (it.parent) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6);
  // in simulated time the answer is as quick as ever: waiting for the dots costs display time, never simulated time
  const ans = sim.events().find((e) => e.test === id && e.what === 'Echo Reply');
  assert.ok(ans.t < a.at + 1000, `answered at ${ans.t} (sent at ${a.at})`);
});

test('the same events in the same order whatever is drawn: bundling, the dot limit, a followed conversation change nothing simulated', () => {
  const a = paced('protocol-simulation.yaml');
  const b = paced('protocol-simulation.yaml', { convLimit: 1000, limit: 1000 });
  const c = paced('protocol-simulation.yaml', { limit: 1 });
  for (const r of [a, b, c]) run(r.frame, 60000);
  // (as far as the slowest got: more dots, more waiting for them)
  const upTo = Math.min(a.sim.now, b.sim.now, c.sim.now);
  assert.ok(upTo > 2100, String(upTo));
  const sig = (s) => s.events().filter((e) => e.t <= upTo).map((e) => `${e.t.toFixed(6)}|${e.device}|${e.what}|${e.detail}`);
  assert.deepEqual(sig(b.sim), sig(a.sim));
  assert.deepEqual(sig(c.sim), sig(a.sim));
});

test('a busy model stays responsive: a frame does a bounded amount of simulation work, and says when it falls behind', () => {
  const { sim, p } = paced('protocol-simulation.yaml', { convLimit: 1000 });
  let worst = 0;
  // (the frame's CPU time, not the wall clock's: a loaded machine's other processes don't count)
  for (let i = 0; i < 60; i++) {
    const c = process.cpuUsage();
    p.frame(100);
    const d = process.cpuUsage(c);
    worst = Math.max(worst, (d.user + d.system) / 1000);
  }
  assert.ok(worst < P.JUMP_BUDGET + 250, `worst frame ${worst.toFixed(0)} ms of CPU`);
  assert.ok(sim.now > 2000);
  // a slow machine: every look at the wall clock 30 ms on — behind, said; never caught up in a burst
  const real = Date.now;
  let clock = real();
  Date.now = () => (clock += 30);
  try {
    const before = sim.now;
    p.frame(100);
    p.frame(100);
    assert.ok(sim.now - before <= 200 + 1e-6);
  } finally {
    Date.now = real;
  }
});

// ------------------------------------------------------------------ attribution

test('attribution by the operation’s id: a send’s request, its ARP prerequisite and its reply are the foreground; the scenario (Hellos, queries) the background while it runs, and again the foreground after its hops arrived', () => {
  const { sim, p, frame } = paced('protocol-simulation.yaml');
  until(frame, () => sim.now >= 6000);
  // core1 has no ARP entry for pc2 yet: the send needs ARP on the way, which is its own (its id)
  const a = sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.20.22', kind: 'icmp' });
  const id = a.run.tests[0].id;
  const seen = new Set();
  let bgSeen = false;
  for (let t = 0; t < 20000; t += 50) {
    frame(50);
    for (const it of p.items) {
      if (it.f.test === id) {
        seen.add(it);
        assert.equal(p.background(it), false);
      } else if (it.drawn && p.state(it).phase === 'moving' && p.background(it)) bgSeen = true;
    }
  }
  assert.ok(Array.from(seen).some((it) => /^ICMP Echo →/.test(it.f.label)));
  assert.ok(sim.engine.flights.some((f) => f.test === id && f.protocol === 'arp'), 'its ARP prerequisite carries its id');
  assert.ok(bgSeen, 'the scenario went on, muted');
  // the autonomous traffic is never the operation's: an OSPF Hello carries no id
  assert.ok(p.items.filter((it) => it.f.protocol === 'ospf').every((it) => it.f.test === undefined));
  // done once its last hop arrived on screen (the simulation waits for its dots), and then nothing is muted any more
  until(frame, () => !sim.foregroundActive());
  run(frame, 10000);
  assert.equal(sim.foregroundActive(), false);
  assert.equal(p.fgActive(), false);
  assert.ok(p.items.every((it) => !p.background(it)));
});
