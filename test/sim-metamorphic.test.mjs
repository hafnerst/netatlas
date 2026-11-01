// Metamorphic checks of the simulation: what must not change a result
// does not. Reordering the YAML, renaming a device that is not involved,
// adding a network that touches nothing, choosing other senders or another
// pacing, and replaying the same history from a clean start give the same
// states and the same deliveries (compared as states and results, not as
// animation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, travelOf } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const PS = example('protocol-simulation.yaml');
const REROUTE = example('ospf-reroute.yaml');

/** What a run comes to: the sessions' states (sorted), and a few Send tests' results. */
function outcome(text, o = {}) {
  const s = new S.Simulation(model(text));
  if (o.senders) s.engine.setSenders(new Set(o.senders), o.senders.join(', '));
  s.runTo(60000);
  const tests = (o.tests || []).map((t) => s.sendTest(t));
  s.runTo(70000);
  if (o.fail) {
    s.fail(o.fail);
    s.runTo(120000);
  }
  const rename = o.rename || ((x) => x);
  const states = s.status().filter((x) => !/^(test traffic|Send test)/.test(x.detail)).map((x) => `${x.protocol}|${rename(x.name)}|${x.state}`).sort();
  return { states, tests: tests.map((t) => (typeof t === 'string' ? t : `${t.ok} ${t.result}`)), sim: s };
}

const TESTS = [
  { from: 'pc2', to: 'web', kind: 'tcp', port: 443 },
  { from: 'pc1', to: 'srv', kind: 'icmp' },
];

/** The YAML's top-level lists in reverse order (devices, links, relations): the same model, written otherwise. */
function reversed(text) {
  const m = model(text);
  void m;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^(devices|links|relations):\s*$/.test(l)) {
      out.push(l);
      i++;
      const items = [];
      let cur = null;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i] === '')) {
        if (/^ {2}- /.test(lines[i])) {
          cur = [lines[i]];
          items.push(cur);
        } else if (cur && /^ {3,}\S/.test(lines[i])) cur.push(lines[i]);
        else if (lines[i] === '' || /^\s*#/.test(lines[i])) {
          if (cur) cur.push(lines[i]);
        } else break;
        i++;
      }
      for (const it of items.reverse()) out.push(...it);
      continue;
    }
    out.push(l);
    i++;
  }
  return out.join('\n');
}

test('the YAML in another order (devices, links and relations reversed): the same states and results', () => {
  const r = reversed(REROUTE);
  assert.notEqual(r, REROUTE);
  assert.equal(model(r).devices.length, model(REROUTE).devices.length);
  const tests = [{ from: 'w-host', to: 'e-srv', kind: 'tcp', port: 80 }, { from: 'w-host', to: 'e-srv', kind: 'icmp' }];
  const a = outcome(REROUTE, { tests, fail: 'link:l-c1-c3' });
  const b = outcome(r, { tests, fail: 'link:l-c1-c3' });
  assert.deepEqual(b.states, a.states);
  assert.deepEqual(b.tests, a.tests);
});

test('a device that is not involved renamed: the same states (under the new name) and results', () => {
  // pc3 joins a group nobody serves: renamed everywhere it appears
  const renamed = PS.replace(/\bpc3\b/g, 'pc-zz');
  assert.notEqual(renamed, PS);
  const a = outcome(PS, { tests: TESTS });
  const b = outcome(renamed, { tests: TESTS, rename: (x) => x.replace(/\bpc-zz\b/g, 'pc3') });
  assert.deepEqual(b.states, a.states);
  assert.deepEqual(b.tests, a.tests);
});

test('a network that touches nothing added (two routers with OSPF of their own): the existing exchanges unchanged', () => {
  const island = PS.replace(/\nlinks:\n/, `
  - {id: zz1, type: router, router_id: 10.255.9.1, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 192.0.2.1/30}]}
  - {id: zz2, type: router, router_id: 10.255.9.2, protocols: {ospf: {}}, interfaces: [{id: g0, ip: 192.0.2.2/30}]}
links:
  - {id: zz-l, a: "zz1:g0", b: "zz2:g0"}
`).replace(/\nrelations:\n/, `
relations:
  - {id: zz-ospf, protocol: ospf, endpoints: ["zz1:g0", "zz2:g0"], attrs: {network-type: point-to-point}}
`);
  assert.equal(model(island).devices.length, model(PS).devices.length + 2);
  const a = outcome(PS, { tests: TESTS });
  const b = outcome(island, { tests: TESTS });
  assert.deepEqual(b.states.filter((x) => !/zz/.test(x)), a.states);
  assert.deepEqual(b.tests, a.tests);
  assert.ok(b.states.some((x) => /^ospf\|zz-ospf: zz1 → zz2\|Full$/.test(x)), 'the island runs on its own');
});

test('other senders (what is shown): the same states and results', () => {
  const a = outcome(PS, { tests: TESTS });
  const b = outcome(PS, { tests: TESTS, senders: ['pc1'] });
  assert.deepEqual(b.states, a.states);
  assert.deepEqual(b.tests, a.tests);
});

test('another pacing (Readable, Proportional, Real time): the same events at the same simulated times', () => {
  const sig = (mode) => {
    const s = new S.Simulation(model(REROUTE));
    const host = { engine: s.engine, shown: (f) => f.view === 'physical', travel: travelOf(s.engine), headers: (f) => f.hdr };
    const p = new P.Pacer(host, 48);
    p.mode = mode;
    for (let i = 0; i < 400 && s.now < 20000; i++) p.frame(50);
    const until = s.now;
    // what happened up to where the slowest got: the same everywhere
    return { until, ev: (n) => s.events().filter((e) => e.t <= n).map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}|${e.detail}`) };
  };
  const runs = ['readable', 'proportional', 'realtime'].map(sig);
  const n = Math.min(...runs.map((r) => r.until));
  assert.ok(n > 0);
  const base = runs[0].ev(n);
  for (const r of runs.slice(1)) assert.deepEqual(r.ev(n), base);
});

test('the same history from a clean start: the same timeline (a failure, a restore and Send tests at the same moments)', () => {
  const go = () => {
    const s = new S.Simulation(model(PS));
    s.runTo(30000);
    s.sendTest({ from: 'pc2', to: 'web', kind: 'tcp', port: 443 });
    s.runTo(40000);
    s.fail('link:l-r1-r2');
    s.runTo(70000);
    s.restore('link:l-r1-r2');
    s.sendTest({ from: 'pc1', to: 'srv', kind: 'icmp' });
    s.runTo(110000);
    return s.events().map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}|${e.detail}`);
  };
  assert.deepEqual(go(), go());
});
