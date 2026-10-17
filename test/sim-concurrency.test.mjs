// Execution apart from the display (pacing.ts), without a browser: the
// simulated clock runs at its rate whatever is on screen, so IGMP startup
// queries, protocol timers and independent exchanges happen when they are
// due, together; the dots follow each operation's causal order (a hop after
// the one it continues, an answer after what it answers); a slow exchange
// never delays an unrelated one; the same events in the same order
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
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr, foreground: () => sim.foregroundActive(), realtime: () => sim.realtimeActive() };
  const p = new P.Pacer(host, 48);
  Object.assign(p, set);
  const frame = (ms = 50) => {
    sim.clock.t += ms;
    sim.pumpRealTime();
    p.frame(ms);
  };
  return { sim, p, frame };
}
const run = (frame, ms, dt = 50) => {
  for (let t = 0; t < ms; t += dt) frame(dt);
};

// ------------------------------------------------------------------ IGMP startup

test('private house from a fresh start: the core (VLAN 20’s snooping querier) sends its first startup query when its first port is up (t = 2 s, the link-up delay), drawn at once; the second a quarter of the query interval later (t = 33.25 s); the table says so', () => {
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
  // the startup burst (DHCP, ARP …) is on screen meanwhile: it holds nothing
  run(frame, 2500);
  const q = sim.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query');
  assert.equal(q.length, 1);
  assert.equal(Math.round(q[0].t), 2000, 'at its deadline, not behind the scenario');
  assert.match(q[0].detail, /^IGMPv3 General Query from core \(snooping querier, 192\.168\.20\.1\) in VLAN 20/);
  // its hops are taken in for the screen (drawn: a protocol with nothing else on screen gets a place)
  const hops = p.items.filter((it) => it.f.protocol === 'igmp');
  assert.ok(hops.length >= 2 && hops.some((it) => it.drawn), hops.map((it) => `${it.f.track.ref}:${it.drawn}`).join(', '));
  // the role and the timers, as the table has them
  const role = sim.multicast.querierRoles('core')[0];
  assert.deepEqual([role.role, role.startup, Math.round(role.nextAt)], ['starting', '2 of 2', 33250]);
  assert.equal(sim.multicast.querierTable('core').rows[0][5], 'query at t = 33.3 s (startup 2 of 2)');
  // on, past it: the second query at its deadline, then the querier elected, the next a query interval on
  run(frame, 32000);
  const q2 = sim.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query');
  assert.deepEqual(q2.map((e) => Math.round(e.t)), [2000, 33250]);
  assert.equal(sim.multicast.querierRoles('core')[0].role, 'querier');
  assert.equal(Math.round(sim.multicast.querierRoles('core')[0].nextAt), 33250 + 125000);
  // the simulation ran with real time all along (34.5 s), whatever was on screen
  assert.ok(sim.now >= 34500 - 100, String(sim.now));
});

test('a new simulation starts its schedule afresh: the same deadlines, no second schedule; no candidate: no query at all', () => {
  const a = paced('private-house.yaml');
  const b = paced('private-house.yaml');
  run(a.frame, 40000);
  run(b.frame, 40000);
  const times = (s) => s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').map((e) => Math.round(e.t));
  assert.deepEqual(times(a.sim), [2000, 33250]);
  assert.deepEqual(times(b.sim), times(a.sim));
  // without the snooping querier: no candidate, nothing queried, nothing marked
  const none = withClock(new S.Simulation(model(example('private-house.yaml').replace('vlan: 20, simulation: {snooping_querier: "on"}}', 'vlan: 20}'))));
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
  for (let t = 0; t < 20000; t += 50) {
    frame(50);
    const moving = p.items.filter((it) => it.drawn && p.state(it).phase === 'moving');
    if (moving.some((it) => it.f.test === lan.run.tests[0].id) && moving.some((it) => it.f.test === wan.run.tests[0].id)) together = true;
  }
  assert.ok(together, 'both on screen at once');
  // the LAN echo answered at the same simulated time as when it runs alone
  const alone = paced('protocol-simulation.yaml');
  run(alone.frame, 8000);
  const solo = alone.sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.10.1', kind: 'icmp' });
  run(alone.frame, 20000);
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
  run(frame, 6000);
  const a = sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.20.22', kind: 'icmp' });
  const id = a.run.tests[0].id;
  const seen = new Set();
  for (let t = 0; t < 60000; t += 50) {
    frame(50);
    for (const it of p.items) if (it.f.test === id && it.f.view === 'physical') seen.add(it);
  }
  const hops = Array.from(seen);
  const req = hops.filter((it) => /^ICMP Echo →/.test(it.f.label));
  const rep = hops.filter((it) => /^ICMP Echo Reply/.test(it.f.label));
  assert.ok(req.length >= 2 && rep.length >= 2, `${req.length} / ${rep.length}`);
  const lastReq = Math.max(...req.map((it) => p.arrival(it)));
  const firstRep = Math.min(...rep.map((it) => it.d0));
  assert.ok(firstRep >= lastReq - 1e-6, `the reply starts at ${firstRep}, the request arrived at ${lastReq}`);
  for (const it of hops) if (it.parent) assert.ok(it.d0 >= p.arrival(it.parent) - 1e-6);
  // while the simulation knew the answer long before (it is not held by the dots)
  const ans = sim.events().find((e) => e.test === id && e.what === 'Echo Reply');
  assert.ok(ans.t < a.at + 1000, `answered at ${ans.t} (sent at ${a.at})`);
});

test('the same events in the same order whatever is drawn: bundling, the dot limit, a followed conversation change nothing simulated', () => {
  const sig = (s) => s.events().filter((e) => e.t <= 20000).map((e) => `${e.t.toFixed(6)}|${e.device}|${e.what}|${e.detail}`);
  const a = paced('protocol-simulation.yaml');
  const b = paced('protocol-simulation.yaml', { convLimit: 1000, limit: 1000 });
  const c = paced('protocol-simulation.yaml', { limit: 1 });
  for (const r of [a, b, c]) run(r.frame, 22000);
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
  assert.ok(sim.now > 5000);
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
  run(frame, 6000);
  // core1 has no ARP entry for pc2 yet: the send needs ARP on the way, which is its own (its id)
  const a = sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.20.22', kind: 'icmp' });
  const id = a.run.tests[0].id;
  const seen = new Set();
  let bgSeen = false;
  for (let t = 0; t < 4000; t += 50) {
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
  // done (in simulated time long since) and, once its last hop arrived on screen, nothing is muted any more
  assert.equal(sim.foregroundActive(), false);
  assert.equal(p.fgActive(), true, 'its dots are still on their way: still in front');
  run(frame, 60000);
  assert.equal(sim.foregroundActive(), false);
  assert.equal(p.fgActive(), false);
  assert.ok(p.items.every((it) => !p.background(it)));
});
