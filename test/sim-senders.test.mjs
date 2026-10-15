// Senders in the protocol simulation's engine (analysis/sim/engine.ts): every
// message knows its sender and its origin (the device whose own action
// started the exchange: a reply, an error or a forwarded copy carries the
// origin of what it answers or carries); the senders chosen generate the
// optional test traffic and nothing else changes: every protocol still runs
// on every device, the adjacencies form as before, and the timeline is
// deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const PS = example('protocol-simulation.yaml');
const run = (senders, ms = 30000, params) => {
  const sim = new S.Simulation(model(PS), params ? { params } : {});
  if (senders) sim.engine.setSenders(new Set(senders), senders.join(', '));
  sim.runTo(ms);
  return sim;
};
const msgs = (sim, f) => sim.events().filter((e) => e.kind === 'message' && f(e));

test('every message has its sender and origin; a reply, an error and a forwarded copy carry the origin of what they answer', () => {
  const sim = run(null);
  const all = sim.events().filter((e) => e.kind === 'message');
  assert.ok(all.length > 100);
  assert.ok(all.every((e) => typeof e.sender === 'string' && typeof e.origin === 'string'), 'every message');
  assert.ok(sim.engine.flights.every((f) => typeof f.sender === 'string'), 'every dot');
  // ARP: the reply belongs to the request's exchange
  const reqs = msgs(sim, (e) => e.protocol === 'arp' && /Request/.test(e.what) && e.sender === e.origin);
  assert.ok(reqs.length > 0);
  const replies = msgs(sim, (e) => e.protocol === 'arp' && /Reply/.test(e.what));
  // (its origin is the requester's, or the origin of the packet the requester resolved for, which may be the replier's own)
  assert.ok(replies.length > 0 && replies.every((e) => typeof e.origin === 'string') && replies.filter((e) => e.origin !== e.sender).length > replies.length / 2, 'an ARP reply belongs to the exchange of its request');
  // TCP: srv's SYN-ACK or RST to pc1's tests
  const tcp = msgs(sim, (e) => e.protocol === 'tcp' && e.device === 'srv' && e.peer === 'pc1');
  assert.ok(tcp.length > 0 && tcp.every((e) => e.sender === 'srv' && e.origin === 'pc1'), tcp.map((e) => e.what + ' ' + e.origin).join(', '));
  // ICMP errors from a router about pc1's packets
  const errs = msgs(sim, (e) => e.protocol === 'icmp' && /Unreachable|exceeded/i.test(e.what) && e.peer === 'pc1');
  assert.ok(errs.length > 0 && errs.every((e) => e.origin === 'pc1' && e.sender !== 'pc1'), errs.map((e) => `${e.what} ${e.sender} ${e.origin}`).join('; '));
  // a frame forwarded by a switch keeps its sender
  const fwd = sim.engine.flights.filter((f) => f.view === 'physical' && f.parent !== undefined);
  for (const f of fwd.slice(0, 200)) {
    const parent = sim.engine.flights.find((x) => x.id === f.parent);
    if (parent) assert.equal(f.sender, parent.sender);
  }
});

test('the senders choose the optional test traffic only: endpoints that are not senders send no test traffic; every protocol still runs and reaches the same states', () => {
  const params = { 'test-traffic': 'on' };
  const all = run(null, 40000, params);
  const one = run(['pc1'], 40000, params);
  // what an endpoint starts itself over ICMP, TCP or UDP: its test traffic
  // (not what it receives: an error about its own telemetry is not test traffic)
  const testsOf = (sim, dev) => msgs(sim, (e) => e.sender === dev && e.origin === dev && ['icmp', 'tcp', 'udp'].indexOf(e.protocol) >= 0 && e.detail.indexOf(dev + ' received ') !== 0).length;
  const endpoints = model(PS).devices.filter((d) => d.type === 'endpoint').map((d) => d.id);
  const others = endpoints.filter((d) => d !== 'pc1');
  assert.ok(others.length > 0);
  assert.ok(others.some((d) => testsOf(all, d) > 0), 'every endpoint tests with all senders');
  assert.ok(others.every((d) => testsOf(one, d) === 0), 'no test traffic from non-senders');
  assert.ok(testsOf(one, 'pc1') > 0, 'the sender still tests');
  // the protocols: the same sessions in the same states
  const control = (sim) => sim.status().filter((s) => ['ospf', 'bgp', 'bfd', 'vrrp', 'stp', 'pim', 'ipsec', 'gre'].indexOf(s.protocol) >= 0).map((s) => `${s.protocol} ${s.name} ${s.state}`).sort();
  assert.deepEqual(control(one), control(all));
  assert.ok(one.status().some((s) => s.protocol === 'ospf' && s.state === 'Full'), 'OSPF reaches Full though r1, r2 and r3 are not senders');
});

test('choosing the senders is logged, and deterministic', () => {
  const a = run(['pc1', 'r1']);
  const b = run(['pc1', 'r1']);
  assert.ok(a.events().some((e) => e.detail === 'Senders changed: pc1, r1'));
  const sig = (s) => s.events().map((e) => `${e.t}|${e.kind}|${e.protocol}|${e.device}|${e.what}|${e.sender}|${e.origin}`);
  assert.deepEqual(sig(a), sig(b));
  assert.equal(a.engine.isSender('pc1'), true);
  assert.equal(a.engine.isSender('r2'), false);
  a.engine.setSenders(null, 'every device');
  assert.equal(a.engine.isSender('r2'), true);
});
