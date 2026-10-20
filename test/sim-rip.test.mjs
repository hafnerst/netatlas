// RIP as a distance vector (analysis/sim/rip.ts): each router's table comes
// from its neighbours' Responses only — prefixes with metrics, poisoned
// reverse, a timeout per route, withdrawal with metric 16 and triggered
// updates — and the routes the router installs are that table's.
// Asserted by the Responses' entries as sent, the routes installed and
// their metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

/** lan1 — r1 — r2 — r3 — lan3, RIP on both links; r3's lan3 interface faces a host. */
const CHAIN = (x = {}) => `netatlas: 1
title: rip
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: r1, type: router, interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: g1, ip: 10.0.12.1/30}], protocols: {rip: {}}}
  - {id: r2, type: router, interfaces: [{id: g0, ip: 10.0.12.2/30}, {id: g1, ip: 10.0.23.1/30}], protocols: {rip: {}}}
  - {id: r3, type: router, interfaces: [{id: g0, ip: 10.0.23.2/30}, {id: lan, ip: 10.3.0.1/24}], protocols: {rip: {${x.r3 || ''}}}${x.r3sim || ''}}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.3.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.3.0.1}]}
links:
  - {id: a, a: "h1:eth0", b: "r1:lan"}
  - {id: b, a: "r1:g1", b: "r2:g0"}
  - {id: c, a: "r2:g1", b: "r3:g0"}
  - {id: d, a: "r3:lan", b: "h3:eth0"}
relations:
  - {id: rip12, protocol: rip, endpoints: ["r1:g1", "r2:g0"]}
  - {id: rip23, protocol: rip, endpoints: ["r2:g1", "r3:g0"]${x.rel23 || ''}}
`;

const sim = (text) => new S.Simulation(model(text));
/** the RIP entries a device sent (each Response as sent: its prefix → metric) */
const responses = (s, dev, t0 = 0) =>
  s.events()
    .filter((e) => e.kind === 'message' && e.protocol === 'rip' && e.device === dev && e.what === 'Response' && e.t >= t0)
    .map((e) => ({ t: e.t, peer: e.peer, detail: e.detail }));
const route = (s, dev, ip) => s.routeLookup(dev, ip);
const prefixOf = (r) => `${[...r.net.bytes].join('.')}/${r.net.prefix}`;

test('RIP: the routes come from the Responses, hop by hop — metric 1 one router away, 2 two away; installed with them', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const r1 = s.protocols.rip.routes('r1', '');
  const lan3 = r1.find((r) => prefixOf(r) === '10.3.0.0/24');
  assert.ok(lan3, JSON.stringify(r1.map(prefixOf)));
  assert.deepEqual([lan3.metric, lan3.peer, lan3.relation], [2, 'r2', 'rip12']);
  assert.equal(r1.find((r) => prefixOf(r) === '10.0.23.0/30').metric, 1);
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'forward');
  assert.match(route(s, 'r1', '10.3.0.10').text, /via 10\.0\.12\.2 out g1/);
  // end to end
  const t = s.sendTest({ from: 'h1', to: 'h3', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
});

test('RIP: split horizon with poisoned reverse — what came in by an interface goes back out of it with metric 16', () => {
  const s = sim(CHAIN());
  s.runTo(70000);
  // r2's periodic Response towards r1 (out of g0): r1's own lan with 16; r3's lan with its metric
  const toR1 = responses(s, 'r2', 30000).find((x) => x.peer === 'r1' && /periodic update/.test(x.detail));
  assert.ok(toR1, 'a periodic Response out of g0');
  assert.match(toR1.detail, /10\.1\.0\.0\/24 metric 16/, toR1.detail);
  assert.match(toR1.detail, /10\.3\.0\.0\/24 metric 1/);
  const toR3 = responses(s, 'r2', 30000).find((x) => x.peer === 'r3' && /periodic update/.test(x.detail));
  assert.match(toR3.detail, /10\.3\.0\.0\/24 metric 16/);
  assert.match(toR3.detail, /10\.1\.0\.0\/24 metric 1/);
});

test('RIP: a network that goes away is withdrawn with metric 16 by a triggered update, hop by hop, long before any timeout', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  s.shut('r3', 'lan');
  s.runTo(t0 + 15000);
  const trig = responses(s, 'r3', t0).find((x) => /triggered update/.test(x.detail));
  assert.ok(trig && /10\.3\.0\.0\/24 metric 16/.test(trig.detail), JSON.stringify(responses(s, 'r3', t0)));
  assert.ok(trig.t - t0 >= 1000 && trig.t - t0 <= 5100, `after 1 to 5 s (${trig.t - t0} ms)`);
  // r2 passes the withdrawal on; r1 no longer has a route
  assert.ok(responses(s, 'r2', t0).some((x) => /triggered update/.test(x.detail) && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none', route(s, 'r1', '10.3.0.10').text);
  assert.ok(s.now - t0 < 180000);
});

test('RIP: a router that goes silent — its routes time out after 180 s (no withdrawal ever arrives), then withdrawn on', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  // r3's Responses are lost on the cable (its link stays up): nothing tells r2; r2's route to lan3 stays until its timeout
  s.engine.impair = (link, f) => (link === 'c' && f.msg.protocol === 'rip' && f.msg.data && f.msg.data.from === 'r3' ? { lose: true } : null);
  s.runTo(t0 + 150000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'forward', 'still there before the timeout (stale)');
  s.runTo(t0 + 200000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none');
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none');
  const to = s.events().find((e) => e.kind === 'route' && e.device === 'r2' && e.what === 'timed out' && /10\.3\.0\.0\/24/.test(e.detail));
  assert.ok(to, 'timed out');
  assert.ok(to.t - t0 >= 150000 && to.t - t0 <= 181000, String(to.t - t0));
  // (meanwhile r2 advertised it with 16 to r1, which withdrew it too)
  assert.ok(responses(s, 'r2', to.t).some((x) => x.peer === 'r1' && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  // garbage collection: advertised with 16, then gone from the table
  s.runTo(t0 + 200000 + 130000);
  assert.ok(!s.protocols.rip.routes('r2', '').some((r) => prefixOf(r) === '10.3.0.0/24'));
});

test('RIP: an export filter keeps a prefix out of the Responses; the neighbour never learns it (no topology flooding behind it)', () => {
  const s = sim(CHAIN({ r3: 'export: [{prefix: 10.3.0.0/24, action: deny}, {action: permit}]' }));
  s.runTo(60000);
  assert.ok(!responses(s, 'r3').some((x) => /10\.3\.0\.0\/24/.test(x.detail)));
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none');
  assert.equal(route(s, 'r2', '10.0.23.1').kind, 'local');
});

test('RIP: an interface going down invalidates what was learned through it at once (metric 16), and the withdrawal goes on', () => {
  const s = sim(CHAIN());
  s.runTo(60000);
  const t0 = s.now;
  s.powerOff('r3');
  s.runTo(t0 + 8000);
  assert.equal(route(s, 'r2', '10.3.0.10').kind, 'none', 'its cable is down: no waiting for the timeout');
  assert.ok(responses(s, 'r2', t0).some((x) => x.peer === 'r1' && /triggered update/.test(x.detail) && /10\.3\.0\.0\/24 metric 16/.test(x.detail)));
  assert.equal(route(s, 'r1', '10.3.0.10').kind, 'none');
});
