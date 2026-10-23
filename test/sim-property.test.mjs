// Property tests of the simulation's shared semantics: bounded, seeded models (a chain of routers between two
// hosts, cable MTUs written or not, a GRE tunnel across the chain or not) and action sequences (sends of every
// kind and size with and without DF, cable failures and restores, power off and on). After each sequence the
// invariants below must hold. A failure is reported reproducibly — the seed, the model, the deterministic
// settings, the action sequence and the invariant — after reducing the sequence to the actions it still needs.
// The generator and the reducer are test-only (nothing of this is in the shipped HTML).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const MT = load('analysis/mtu.js');

/** A small seeded generator (mulberry32): the same seed, the same model and actions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A model: ha — r1 — … — rk — hb, optionally a GRE tunnel r1 ⇄ rk carrying the hosts' LANs. */
function genModel(r) {
  const k = 1 + Math.floor(r() * 3);
  const tunnel = k >= 2 && r() < 0.5;
  // (half the models write every MTU, so the static path MTU is established and its boundary is checked at run time)
  const all = r() < 0.5;
  const mtu = () => (!all && r() < 0.25 ? '' : `, mtu: ${[1500, 1500, 1450, 1400][Math.floor(r() * 4)]}`);
  const dev = [];
  dev.push(`  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24${mtu()}}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}`);
  dev.push(`  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24${mtu()}}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}`);
  const links = ['  - {id: la, a: "ha:eth0", b: "r1:lana"}', `  - {id: lb, a: "hb:eth0", b: "r${k}:lanb"}`];
  // link i (1-based) joins r_i and r_(i+1): 192.0.i.0/30
  for (let i = 1; i <= k; i++) {
    const ifs = [];
    if (i === 1) ifs.push(`{id: lana, ip: 10.1.0.1/24${mtu()}}`);
    if (i === k) ifs.push(`{id: lanb, ip: 10.2.0.1/24${mtu()}}`);
    if (i > 1) ifs.push(`{id: w${i - 1}, ip: 192.0.${i - 1}.2/30${mtu()}}`);
    if (i < k) ifs.push(`{id: w${i}, ip: 192.0.${i}.1/30${mtu()}}`);
    const routes = [];
    const logical = [];
    const toB = i < k ? `192.0.${i}.2` : null;
    const toA = i > 1 ? `192.0.${i - 1}.1` : null;
    // the transit networks, both ways
    for (let j = 1; j < k; j++) {
      if (j === i || j === i - 1) continue;
      routes.push(`{prefix: 192.0.${j}.0/30, via: ${j > i ? toB : toA}}`);
    }
    if (tunnel && (i === 1 || i === k)) {
      const far = i === 1 ? `192.0.${k - 1}.2` : '192.0.1.1';
      const src = i === 1 ? 'w1' : `w${k - 1}`;
      logical.push(`{id: tun0, type: tunnel, ip: 172.16.0.${i === 1 ? 1 : 2}/30, source: ${src}, destination: ${far}}`);
      routes.push(`{prefix: ${i === 1 ? '10.2.0.0/24' : '10.1.0.0/24'}, via: 172.16.0.${i === 1 ? 2 : 1}}`);
    } else {
      if (i < k) routes.push(`{prefix: 10.2.0.0/24, via: ${toB}}`);
      if (i > 1) routes.push(`{prefix: 10.1.0.0/24, via: ${toA}}`);
    }
    dev.push(`  - id: r${i}\n    type: router\n    interfaces: [${ifs.join(', ')}]${logical.length ? `\n    logical_interfaces: [${logical.join(', ')}]` : ''}${routes.length ? `\n    routes: [${routes.join(', ')}]` : ''}`);
    if (i < k) links.push(`  - {id: l${i}, a: "r${i}:w${i}", b: "r${i + 1}:w${i}"}`);
  }
  const rel = tunnel ? `relations:\n  - {id: gre1, protocol: gre, endpoints: ["r1:tun0", "r${k}:tun0"]}\n` : '';
  const yaml = `netatlas: 1\ntitle: generated\ndevices:\n${dev.join('\n')}\nlinks:\n${links.join('\n')}\n${rel}`;
  return { yaml, k, tunnel, links: links.map((l) => /id: (\w+)/.exec(l)[1]) };
}

/** An action sequence over a model. */
function genActions(r, g) {
  const n = 3 + Math.floor(r() * 5);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.6) {
      const kind = ['icmp', 'udp', 'tcp'][Math.floor(r() * 3)];
      const from = r() < 0.5 ? 'ha' : 'hb';
      out.push({ op: 'send', kind, from, to: from === 'ha' ? '10.2.0.10' : '10.1.0.10', size: [56, 1200, 1372, 1400, 1450, 1473, 2000][Math.floor(r() * 7)], df: r() < 0.5 });
    } else if (p < 0.8) out.push({ op: 'fail', ref: 'link:' + g.links[Math.floor(r() * g.links.length)] });
    else if (p < 0.9) out.push({ op: 'restore-all' });
    else out.push({ op: 'power', dev: 'r' + (1 + Math.floor(r() * g.k)) });
    out.push({ op: 'wait', ms: [500, 3000, 8000][Math.floor(r() * 3)] });
  }
  return out;
}

/** Run a sequence; the tests it sent (in order) and the simulation. `paced`: frame by frame as the page plays. */
function play(g, actions, paced = false) {
  const s = new S.Simulation(model(g.yaml));
  if (paced) withClock(s);
  s.runTo(70000);
  const tests = [];
  const failed = new Set();
  const off = new Set();
  for (const a of actions) {
    if (a.op === 'send') {
      const t = s.sendTest({ from: a.from, to: a.to, kind: a.kind, size: a.size, df: a.df, port: a.kind === 'icmp' ? undefined : 7 });
      if (typeof t === 'object' && t) tests.push(t);
    } else if (a.op === 'fail') {
      if (s.fail(a.ref)) failed.add(a.ref);
    } else if (a.op === 'restore-all') {
      for (const ref of failed) s.restore(ref);
      for (const d of off) s.powerOn(d);
      failed.clear();
      off.clear();
    } else if (a.op === 'power') {
      if (s.powerOff(a.dev)) off.add(a.dev);
    } else if (a.op === 'wait') {
      if (paced) s.play(a.ms, 50);
      else s.runTo(s.now + a.ms);
    }
  }
  if (paced) s.play(30000, 50);
  else s.runTo(s.now + 30000);
  return { s, tests };
}

const owner = { '10.2.0.10': 'hb', '10.1.0.10': 'ha' };

/** The invariants: the first violated one's description, or null. */
function violated(g, actions) {
  const { s, tests } = play(g, actions);
  if (process.env.PROP_STATS) console.log('model', g.k, g.tunnel, 'tests', tests.length, tests.filter((t) => t.ok).length, tests.map((t) => t.kind + ':' + t.outcome.kind).join(' '));
  for (const t of tests) {
    if (!t.done) return `test ${t.id} never ended (30 s after the last action)`;
    if (!t.outcome) return `test ${t.id} ended without a structured outcome`;
    if ((t.outcome.kind === 'answered') !== t.ok) return `test ${t.id}: outcome ${t.outcome.kind} but ok = ${t.ok}`;
    // a reply completes only its own exchange: an answer comes from the device that has the destination address
    if (t.ok && t.outcome.by && t.outcome.by !== owner[t.dst.bytes.join('.')]) return `test ${t.id} to ${t.dst.bytes.join('.')} was answered by ${t.outcome.by}`;
    if (t.outcome.drop && t.outcome.drop.cause && t.outcome.drop.cause.pkt !== undefined && t.pktIds.indexOf(t.outcome.drop.cause.pkt) < 0 && t.outcome.drop.cause.flow && t.outcome.drop.cause.flow.indexOf(t.dst.bytes.join('.')) < 0) return `test ${t.id}: its recorded drop is of an unrelated packet (${t.outcome.drop.cause.flow})`;
  }
  // packet sizes: every frame on a cable is 18 + its outer IP packet (at least 64); an encapsulated GRE packet is its inner + 24
  // (an IPv4 outer header 20 + GRE 4, worked from RFC 2784), never computed with the helper under test
  for (const f of s.flights(s.now, 'physical', 0)) {
    const h = f.hdr;
    if (!h || !h.l3.length) continue;
    if (h.l2.bytes !== Math.max(64, 18 + h.l3[0].len)) return `frame of ${h.label}: ${h.l2.bytes} bytes for an IP packet of ${h.l3[0].len}`;
    if (h.l3.length > 1 && /GRE/.test(h.l3[0].proto) && !h.l3[0].frag && h.l3[0].len !== h.l3[1].len + 24) return `GRE packet of ${h.label}: ${h.l3[0].len} bytes around an inner ${h.l3[1].len}`;
  }
  // the static MTU boundary: with nothing failed, a DF ping of the payload the static path MTU allows is answered, one byte more is too big
  if (!actions.some((a) => a.op === 'fail' || a.op === 'power')) {
    const m = model(g.yaml);
    const st = MT.pathMtu(m, C.checkCommunication(m, { from: 'ha', to: 'hb', back: true }));
    if (process.env.PROP_STATS) console.log('mtu', g.tunnel, st && st.verdict, st && st.mtu);
    if (st && st.verdict === 'satisfied' && st.payload) {
      const fresh = new S.Simulation(m);
      fresh.runTo(70000);
      const fits = fresh.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp', size: st.payload.bytes, df: true });
      fresh.runTo(fresh.now + 8000);
      // (the first DF packet over a narrower underlay teaches the tunnel head; PMTUD then answers the next one)
      const again = fits.ok ? fits : (fresh.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp', size: st.payload.bytes, df: true }), fresh.runTo(fresh.now + 8000), fresh.tests()[0]);
      if (!again.ok) return `static path MTU ${st.mtu}: a DF ping of ${st.payload.bytes} bytes was not answered (${again.result})`;
      const over = fresh.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp', size: st.payload.bytes + 1, df: true });
      fresh.runTo(fresh.now + 8000);
      if (over.ok) return `static path MTU ${st.mtu}: a DF ping of ${st.payload.bytes + 1} bytes was answered`;
    }
  }
  return null;
}

/** Reduce a failing sequence: drop actions one at a time while the same invariant still fails (ddmin-style, bounded). */
function reduce(g, actions, why) {
  let cur = actions.slice();
  const key = (x) => (x || '').replace(/\d+/g, '#');
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds++) {
    changed = false;
    for (let i = 0; i < cur.length; i++) {
      const next = cur.slice(0, i).concat(cur.slice(i + 1));
      const v = violated(g, next);
      if (v && key(v) === key(why)) {
        cur = next;
        changed = true;
        i--;
      }
    }
  }
  return cur;
}

const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

test('property: structured outcomes, reply identity, packet sizes and the static MTU boundary hold over generated models and actions', () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const g = genModel(r);
    const actions = genActions(r, g);
    const v = violated(g, actions);
    if (v) {
      const small = reduce(g, actions, v);
      assert.fail(`seed ${seed} (deterministic settings: the simulation's defaults, its model seed from the model): ${violated(g, small) || v}\nactions: ${JSON.stringify(small)}\nmodel:\n${g.yaml}`);
    }
  }
});

test('property: the same seed gives the same outcomes, headless and played frame by frame', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    const r = rng(seed);
    const g = genModel(r);
    const actions = genActions(r, g);
    const sig = (x) => x.tests.map((t) => [t.ok, t.outcome && t.outcome.kind, t.outcome && t.outcome.drop ? t.outcome.drop.cause && t.outcome.drop.cause.kind : '', t.ended, t.retx || 0]);
    const a = sig(play(g, actions));
    assert.deepEqual(sig(play(g, actions)), a, `seed ${seed}: two headless runs differ`);
    assert.deepEqual(sig(play(g, actions, true)), a, `seed ${seed}: played frame by frame differs from headless\nactions: ${JSON.stringify(actions)}\nmodel:\n${g.yaml}`);
  }
});
