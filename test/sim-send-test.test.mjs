// Send test in the protocol simulation (analysis/sim): a test starts at the
// current simulated time, in parallel with the traffic in flight, after its
// real dependencies only (ARP / NDP, a DNS answer, a DHCP lease); its
// messages, what they need and every answer (replies, ICMP errors, RSTs)
// are marked as the test's, and nothing else is; the pacing draws them
// whatever the dot limit and lets a running test alone hold the clock; the
// timeline is deterministic with tests sent at given times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

const PS = example('protocol-simulation.yaml');
const CS = example('campus-services.yaml');

/** Run until some messages are on their way (in the air at the simulated time). */
function untilInFlight(sim) {
  const e = sim.engine;
  for (let i = 0; i < 100000; i++) {
    if (e.flights.some((f) => f.t0 <= e.now && f.t1 > e.now)) return;
    const n = e.nextTime();
    if (n === null) break;
    e.run(n);
  }
  throw new Error('no traffic in flight');
}

const ofTest = (sim, t) => sim.events().filter((e) => e.test === t.id);

test('a test starts at the current simulated time, while other traffic is in flight, after its real dependencies only', () => {
  const sim = new S.Simulation(model(PS));
  sim.runTo(30000);
  untilInFlight(sim);
  const now = sim.now;
  const inAir = sim.engine.flights.filter((f) => f.t0 <= now && f.t1 > now && f.test === undefined).length;
  assert.ok(inAir > 0);
  const t = sim.sendTest({ from: 'pc1', to: 'srv', kind: 'icmp' });
  assert.equal(typeof t, 'object', String(t));
  assert.equal(t.started, now, 'started now');
  // its first message leaves now (pc1 knows its gateway's MAC by now): not after the next periodic event, not behind the traffic
  const first = ofTest(sim, t).find((e) => e.kind === 'message');
  assert.ok(first && first.t === now, JSON.stringify(first));
  assert.ok(sim.engine.flights.some((f) => f.test === t.id && f.t0 === now), 'its first hop is on its way now');
  sim.runTo(now + 2000);
  assert.ok(t.done && t.ok, t.result);
  // a test that needs ARP: the ARP request goes now, and the echo waits for nothing else
  const fresh = new S.Simulation(model(PS));
  fresh.runTo(4000);
  const at = fresh.now;
  const u = fresh.sendTest({ from: 'pc1', to: 'core2', kind: 'icmp' });
  const evs = ofTest(fresh, u);
  assert.ok(evs.some((e) => e.kind === 'message' && e.t === at), 'its first message (ARP or the echo) leaves now: ' + JSON.stringify(evs.slice(0, 3).map((e) => [e.t, e.what])));
  fresh.runTo(at + 3000);
  for (const w of ofTest(fresh, u).filter((e) => e.kind === 'wait')) assert.match(w.detail, /waiting for (ARP|NDP|DNS|a DHCP lease)/, w.detail);
});

test('a test by name before the lease: it waits for its DHCP lease, then for DNS, then connects; the DNS messages are the test’s', () => {
  const sim = new S.Simulation(model(CS));
  sim.runTo(500);
  const t = sim.sendTest({ from: 'pc2', to: 'web.campus.example', kind: 'tcp', port: 443 });
  assert.equal(typeof t, 'object', String(t));
  sim.runTo(30000);
  assert.ok(t.done && t.ok, t.result);
  const evs = ofTest(sim, t);
  const waits = evs.filter((e) => e.kind === 'wait').map((e) => e.detail);
  assert.ok(waits.some((w) => /DHCP lease/.test(w)), waits.join(' | '));
  assert.ok(evs.some((e) => e.kind === 'message' && e.protocol === 'dns'), 'its DNS query and answer are the test’s');
  assert.ok(evs.some((e) => e.kind === 'message' && e.what === 'TCP SYN'));
  // the DHCP exchange is not the test's (it ran anyway)
  assert.ok(!evs.some((e) => e.protocol === 'dhcp'));
  for (const w of waits) assert.match(w, /waiting for (ARP|NDP|DNS|a DHCP lease)/, w);
});

test('marked as the test’s: its packets, their ARP, the replies, a RST, an ICMP error; nothing else (no routing protocol, no other traffic)', () => {
  const sim = new S.Simulation(model(PS));
  sim.runTo(30000);
  const a = sim.sendTest({ from: 'pc1', to: 'srv', kind: 'icmp' });
  const b = sim.sendTest({ from: 'pc1', to: 'srv', kind: 'tcp', port: 22 });
  const c = sim.sendTest({ from: 'pc1', to: '203.0.113.80', kind: 'icmp' });
  sim.runTo(60000);
  const whats = (t) => ofTest(sim, t).filter((e) => e.kind === 'message').map((e) => e.what);
  assert.ok(whats(a).includes('Echo Request') && whats(a).includes('Echo Reply'), whats(a).join());
  assert.ok(whats(b).includes('TCP SYN') && whats(b).includes('TCP RST'), whats(b).join());
  assert.ok(ofTest(sim, c).some((e) => /Unreachable/.test(e.what)), whats(c).join());
  // each test's state line too
  for (const t of [a, b, c]) assert.ok(ofTest(sim, t).some((e) => e.kind === 'state' && /^Test (answered|failed)$/.test(e.what)));
  // nothing else carries a test
  const protos = new Set(sim.events().filter((e) => e.test !== undefined).map((e) => e.protocol));
  for (const p of protos) assert.ok(['icmp', 'tcp', 'udp', 'arp', 'ndp', 'dns'].includes(p), 'not the test’s: ' + p);
  // and the flights: the dots of the test only
  assert.ok(sim.engine.flights.filter((f) => f.test !== undefined).every((f) => ['icmp', 'tcp', 'udp', 'arp', 'ndp', 'dns'].includes(f.protocol)));
});

test('the pacing: a test’s hops are drawn beyond the dot limit; it is answered at once in simulated time (nothing on screen holds it); its hops show one after the other, never behind the traffic on screen', () => {
  const sim = new S.Simulation(model(PS));
  const host = { engine: sim.engine, shown: (f) => f.view === 'physical', typical: () => sim.engine.hopTime(), headers: (f) => f.hdr, testRunning: () => sim.tests().some((t) => !t.done) };
  const p = new P.Pacer(host, 6);
  // the startup burst: more hops than the limit
  for (let i = 0; i < 400 && p.notDrawn === 0; i++) p.frame(16);
  assert.ok(p.notDrawn > 0, 'the limit is reached');
  sim.engine.runUntil(sim.now + 3000, () => false);
  p.resync();
  for (let i = 0; i < 200 && p.notDrawn < 20; i++) p.frame(16);
  const t = sim.sendTest({ from: 'pc1', to: 'core1', kind: 'icmp' });
  assert.equal(typeof t, 'object', String(t));
  p.frame(16);
  const mine = p.items.filter((it) => it.test);
  assert.ok(mine.length > 0 && mine.every((it) => it.drawn), 'drawn at once, beyond the limit');
  // (the scenario's dots on screen meanwhile hold nothing: there is no clock to hold any more)
  // answered in simulated time within a few frames: the dots on screen hold nothing
  for (let i = 0; i < 10 && !t.done; i++) p.frame(16);
  assert.ok(t.done, t.result);
  // on screen: its hops one after the other, each at most HOP_MAX (and a switch's crossing): no wait behind the others
  let frames = 0;
  const seen = new Set();
  while (p.items.some((it) => it.test && p.clock < p.arrival(it)) && frames < 3000) {
    for (const it of p.items) if (it.test && it.f.view === 'physical') seen.add(it.f.track.ref + '|' + it.f.label);
    p.frame(16);
    frames++;
  }
  // (each message on each cable: the hops shown one after the other)
  const hops = seen.size;
  assert.ok(frames * 16 <= (hops + 2) * (P.HOP_MAX + P.TRANSIT_MS) + 2000, `${frames * 16} ms for ${hops} cables`);
});

test('deterministic: tests sent at the same simulated times give the same timeline, however the time is advanced', () => {
  const run = (steps) => {
    const sim = new S.Simulation(model(PS));
    for (const s of steps) {
      if (s.to !== undefined) sim.runTo(s.to);
      if (s.send) sim.sendTest(s.send);
    }
    sim.runTo(40000);
    return sim.events().map((e) => [e.t, e.kind, e.protocol, e.device, e.what, e.detail, e.test === undefined ? '' : e.test].join('|'));
  };
  const plan = [{ to: 20000, send: { from: 'pc1', to: 'srv', kind: 'tcp', port: 443 } }, { to: 22500, send: { from: 'pc1', to: '203.0.113.80', kind: 'icmp' } }, { to: 23000, send: { from: 'pc1', to: 'srv', kind: 'tcp', port: 22 } }];
  const a = run(plan);
  const b = run(plan);
  // the same moments reached in other steps
  const c = run([{ to: 5000 }, { to: 12000 }].concat(plan));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  // (the three tests are in it, marked)
  assert.equal(new Set(a.map((x) => x.slice(x.lastIndexOf('|') + 1)).filter((x) => x)).size, 3);
});
