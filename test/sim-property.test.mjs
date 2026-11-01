// Property tests of the simulation's shared semantics: bounded, seeded models — a chain of one to three routers between
// two hosts; cable MTUs written or not; IPv4 or dual stack; a tunnel across the chain or not (GRE, WireGuard over UDP,
// IP-in-IP, or GRE over an IPsec relation); two equal-cost links; a third host in another VRF reusing hb's address; a host
// that takes its address by DHCP; a UDP client application with a timeout and a retry — and legal action sequences
// (sends of every kind and size with and without DF, bursts of concurrent sends, cable failures and restores, power off
// and on, starting and stopping the application). After each sequence the invariants below must hold. A failure is
// reported reproducibly — the seed, the model, the deterministic settings, the action sequence and the invariant —
// after reducing the sequence to the actions it still needs. Every refused action is classified as an expected refusal
// or a generator failure (never ignored); every branch the generator is meant to reach is counted and must be reached;
// a test is followed by the reference the simulation returned, never by its place in a list. Expected sizes are worked
// by hand from the specifications. The generator and the reducer are test-only (nothing of this is in the shipped HTML).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const MT = load('analysis/mtu.js');
const D = load('analysis/diagnosis.js');
const R = load('analysis/result.js');
const A = load('analysis/sim/apps.js');

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

/** A model (see the module comment); `g` says which branches it took. */
function genModel(r) {
  const k = 1 + Math.floor(r() * 3);
  const tunnel = k >= 2 && r() < 0.5 ? ['gre', 'wireguard', 'ipip', 'gre-ipsec'][Math.floor(r() * 4)] : '';
  const v6 = r() < 0.4;
  const ecmp = k >= 2 && !tunnel && r() < 0.5;
  const reuse = r() < 0.35;
  const dhcp = r() < 0.3;
  const app = r() < 0.45;
  // (a lossy cable on hb's side: an exchange can fail with its answer lost — a cause the records do not establish)
  const lossy = r() < 0.3;
  // (half the models write every MTU, so the static path MTU is established and its boundary is checked at run time)
  const all = r() < 0.5;
  const mtu = () => (!all && r() < 0.25 ? '' : `, mtu: ${[1500, 1500, 1450, 1400][Math.floor(r() * 4)]}`);
  const ip = (v4, v6a) => (v6 && v6a ? `ip: [${v4}, "${v6a}"]` : `ip: ${v4}`);
  const dev = [];
  const r6 = (pfx, via) => (v6 ? [`{prefix: "${pfx}", via: "${via}"}`] : []);
  dev.push(`  - {id: ha, type: endpoint, interfaces: [{id: eth0, ${dhcp ? 'ipv4: dhcp' + (v6 ? ', ip: "2001:db8:a::10/64"' : '') : ip('10.1.0.10/24', '2001:db8:a::10/64')}${mtu()}}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}${r6('::/0', '2001:db8:a::1').map((x) => ', ' + x).join('')}]${app ? ', services: {applications: [{id: q, name: Q, profile: udp_client, peer: "hb/ans", timeout: 1s, retries: 1, interval: 2s, count: 3}]}' : ''}}`);
  dev.push(`  - {id: hb, type: endpoint, interfaces: [{id: eth0, ${ip('10.2.0.10/24', '2001:db8:b::10/64')}${mtu()}}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}${r6('::/0', '2001:db8:b::1').map((x) => ', ' + x).join('')}], services: {applications: [{id: ans, name: Ans, profile: udp_server, port: 7}]}}`);
  if (reuse) dev.push(`  - {id: hc, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}`);
  const links = ['  - {id: la, a: "ha:eth0", b: "r1:lana"}', `  - {id: lb, a: "hb:eth0", b: "r${k}:lanb"${lossy ? ', simulation: {loss: 40}' : ''}}`];
  if (reuse) links.push(`  - {id: lc, a: "hc:eth0", b: "r${k}:lanc"}`);
  // link i (1-based) joins r_i and r_(i+1): 192.0.i.0/30 (and 2001:db8:i::/64); with ecmp a second one, 192.0.10i.0/30
  for (let i = 1; i <= k; i++) {
    const ifs = [];
    if (i === 1) ifs.push(`{id: lana, ${ip('10.1.0.1/24', '2001:db8:a::1/64')}${mtu()}}`);
    if (i === k) ifs.push(`{id: lanb, ${ip('10.2.0.1/24', '2001:db8:b::1/64')}${mtu()}}`);
    if (i === k && reuse) ifs.push(`{id: lanc, ip: 10.2.0.1/24, vrf: blue}`);
    if (i > 1) ifs.push(`{id: w${i - 1}, ${ip(`192.0.${i - 1}.2/30`, `2001:db8:${i - 1}::2/64`)}${mtu()}}`);
    if (i < k) ifs.push(`{id: w${i}, ${ip(`192.0.${i}.1/30`, `2001:db8:${i}::1/64`)}${mtu()}}`);
    if (ecmp && i === 1) ifs.push(`{id: x1, ip: 192.0.101.1/30${mtu()}}`);
    if (ecmp && i === 2) ifs.push(`{id: x1, ip: 192.0.101.2/30${mtu()}}`);
    const routes = [];
    const logical = [];
    const toB = i < k ? `192.0.${i}.2` : null;
    const toA = i > 1 ? `192.0.${i - 1}.1` : null;
    const toB6 = `2001:db8:${i}::2`;
    const toA6 = `2001:db8:${i - 1}::1`;
    // (equal cost: r1 reaches beyond r2 by both links, r2 reaches back to r1's side by both)
    const via = (pfx, gw, alt) => [`{prefix: ${pfx}, via: ${gw}}`].concat(alt ? [`{prefix: ${pfx}, via: ${alt}}`] : []);
    const altB = ecmp && i === 1 ? '192.0.101.2' : null;
    const altA = ecmp && i === 2 ? '192.0.101.1' : null;
    for (let j = 1; j < k; j++) {
      if (j === i || j === i - 1) continue;
      routes.push(...via(`192.0.${j}.0/30`, j > i ? toB : toA, j > i ? altB : altA));
      if (v6) routes.push(`{prefix: "2001:db8:${j}::/64", via: "${j > i ? toB6 : toA6}"}`);
    }
    if (tunnel && (i === 1 || i === k)) {
      const far = i === 1 ? `192.0.${k - 1}.2` : '192.0.1.1';
      const src = i === 1 ? 'w1' : `w${k - 1}`;
      logical.push(`{id: tun0, type: tunnel, ip: 172.16.0.${i === 1 ? 1 : 2}/30, source: ${src}, destination: ${far}}`);
      routes.push(`{prefix: ${i === 1 ? '10.2.0.0/24' : '10.1.0.0/24'}, via: 172.16.0.${i === 1 ? 2 : 1}}`);
      if (v6) routes.push(i === 1 ? `{prefix: "2001:db8:b::/64", via: "${toB6}"}` : `{prefix: "2001:db8:a::/64", via: "${toA6}"}`);
    } else {
      if (i < k) routes.push(...via('10.2.0.0/24', toB, altB));
      if (i > 1) routes.push(...via('10.1.0.0/24', toA, altA));
      if (v6 && i < k) routes.push(`{prefix: "2001:db8:b::/64", via: "${toB6}"}`);
      if (v6 && i > 1) routes.push(`{prefix: "2001:db8:a::/64", via: "${toA6}"}`);
    }
    const svc = dhcp && i === 1 ? `\n    services: {dhcp: {scopes: [{network: lan-a, range: 10.1.0.100-10.1.0.120, gateway: 10.1.0.1, dns: [10.1.0.1]}]}}` : '';
    dev.push(`  - id: r${i}\n    type: router\n    interfaces: [${ifs.join(', ')}]${logical.length ? `\n    logical_interfaces: [${logical.join(', ')}]` : ''}${routes.length ? `\n    routes: [${routes.join(', ')}]` : ''}${svc}`);
    if (i < k) links.push(`  - {id: l${i}, a: "r${i}:w${i}", b: "r${i + 1}:w${i}"}`);
  }
  if (ecmp) links.push('  - {id: l1b, a: "r1:x1", b: "r2:x1"}');
  const rels = [];
  if (tunnel === 'gre-ipsec') {
    rels.push(`  - {id: ipsec1, protocol: ipsec, endpoints: ["r1:w1", "r${k}:w${k - 1}"]}`);
    rels.push(`  - {id: t1, protocol: gre, endpoints: ["r1:tun0", "r${k}:tun0"], over: [ipsec1]}`);
  } else if (tunnel) rels.push(`  - {id: t1, protocol: ${tunnel}, endpoints: ["r1:tun0", "r${k}:tun0"]}`);
  const nets = dhcp ? 'networks:\n  - {id: lan-a, cidr: 10.1.0.0/24}\n' : '';
  const yaml = `netatlas: 1\ntitle: generated\ndevices:\n${dev.join('\n')}\nlinks:\n${links.join('\n')}\n${rels.length ? 'relations:\n' + rels.join('\n') + '\n' : ''}${nets}`;
  return { yaml, k, tunnel, v6, ecmp, reuse, dhcp, app, all, lossy, links: links.map((l) => /id: ([\w-]+)/.exec(l)[1]) };
}

/** A legal action sequence over a model. */
function genActions(r, g, ri = () => 1) {
  const n = 3 + Math.floor(r() * 6);
  const out = [];
  // (a cable's frames duplicated or delayed for a while: from a stream of its own, so the other draws stay as they were)
  if (ri() < 0.35) out.push({ op: 'impair', link: g.links[Math.floor(ri() * g.links.length)], mode: ri() < 0.5 ? 'dup' : 'delay', ms: [5, 400, 2500][Math.floor(ri() * 3)] });
  const send = () => {
    const kind = ['icmp', 'udp', 'tcp'][Math.floor(r() * 3)];
    const from = r() < 0.5 ? 'ha' : 'hb';
    const six = g.v6 && r() < 0.5;
    // (to ha: by its address, or — a DHCP client's — as the device, its lease when sent)
    const to = from === 'ha' ? (six ? '2001:db8:b::10' : '10.2.0.10') : six ? '2001:db8:a::10' : g.dhcp ? 'ha' : '10.1.0.10';
    return { op: 'send', kind, from, to, size: [56, 1200, 1372, 1400, 1450, 1473, 2000][Math.floor(r() * 7)], df: r() < 0.5 };
  };
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.45) out.push(send());
    else if (p < 0.55) out.push(send(), send(), send());
    else if (p < 0.7) out.push({ op: 'fail', ref: 'link:' + g.links[Math.floor(r() * g.links.length)] });
    else if (p < 0.78) out.push({ op: 'restore-all' });
    else if (p < 0.85) out.push({ op: 'power', dev: 'r' + (1 + Math.floor(r() * g.k)) });
    else if (g.app) out.push({ op: 'app-start' }, { op: 'wait', ms: [500, 2500][Math.floor(r() * 2)] }, { op: r() < 0.6 ? 'app-stop' : 'wait', ms: 0 });
    else out.push(send());
    out.push({ op: 'wait', ms: [0, 500, 3000, 8000][Math.floor(r() * 4)] });
  }
  return out;
}

/** What a refusal of the simulation may legitimately say, for an action the generator made (anything else: its failure). */
const EXPECTED_REFUSAL = [/is powered off/, /^ha has no address$/, /is running already/, /has no IPv[46] address/, /is not running/, /waiting for its DHCP lease/, /is booting/, /^already failed$/, /^already off$/];

/** Run a sequence; the tests it sent (the references returned), the application runs, the refusals. `paced`: frame by frame. */
function play(g, actions, paced = false) {
  const s = new S.Simulation(model(g.yaml));
  if (paced) withClock(s);
  s.runTo(70000);
  const tests = [];
  const refused = [];
  const runs = [];
  const failed = new Set();
  const off = new Set();
  const impaired = new Set();
  let appAct = null;
  for (const a of actions) {
    if (a.op === 'send') {
      const t = s.sendTest({ from: a.from, to: a.to, kind: a.kind, size: a.size, df: a.df, port: a.kind === 'icmp' ? undefined : 7 });
      if (typeof t === 'string') refused.push({ a, why: t });
      else tests.push(t);
    } else if (a.op === 'fail') {
      // (a refusal is classified: failing what already failed is the simulation's answer; anything else is not legal)
      if (s.fail(a.ref)) failed.add(a.ref);
      else refused.push({ a, why: failed.has(a.ref) ? 'already failed' : `${a.ref} could not be failed` });
    } else if (a.op === 'restore-all') {
      for (const ref of failed) if (!s.restore(ref)) refused.push({ a, why: `${ref} could not be restored` });
      for (const d of off) if (!s.powerOn(d)) refused.push({ a, why: `${d} could not be powered on` });
      failed.clear();
      off.clear();
      s.engine.impair = null;
    } else if (a.op === 'power') {
      if (s.powerOff(a.dev)) off.add(a.dev);
      else refused.push({ a, why: off.has(a.dev) ? 'already off' : `${a.dev} could not be powered off` });
    } else if (a.op === 'impair') {
      // a cable's frames duplicated, or delayed by a.ms, until the next restore (frames are never lost by it)
      s.engine.impair = (l) => (l !== a.link ? null : a.mode === 'dup' ? { dup: true } : { delay: a.ms });
      impaired.add(a.mode);
    } else if (a.op === 'app-start') {
      const x = s.actApp('ha', 'q', 'experiment');
      if (x.error) refused.push({ a, why: x.error });
      else {
        appAct = x;
        runs.push(x.app);
      }
    } else if (a.op === 'app-stop') {
      // (stopping what is not going on is refused, said: that is the simulation's answer, not a failure of the generator)
      if (!appAct || !s.actionControl(appAct.id, 'stop')) refused.push({ a, why: `${appAct ? 'ha/q is not running' : 'ha/q is not running (never started)'}` });
    } else if (a.op === 'wait') {
      if (paced) s.play(a.ms, 50);
      else s.runTo(s.now + a.ms);
    }
  }
  if (paced) s.play(30000, 50);
  else s.runTo(s.now + 30000);
  return { s, tests, refused, runs, impaired };
}

/** The device that has an address in hb's or ha's default routing context (hc reuses hb's address in VRF blue: never it). */
const OWNER = { '10.2.0.10': 'hb', '10.1.0.10': 'ha', '2001:db8:b::10': 'hb', '2001:db8:a::10': 'ha' };

/** Hand-worked bytes a tunnel layer puts around its inner packet, by the outer header's protocol (IPv4 outer). */
function around(proto, inner) {
  if (/GRE/.test(proto)) return 24; // 20 IPv4 + 4 GRE (RFC 2784)
  if (/IP-in-IP|IPv6 in IP/.test(proto)) return 20; // the outer header (RFC 2003, RFC 4213)
  if (/UDP/.test(proto)) return 60; // WireGuard: 20 + 8 UDP + 16 header + 16 tag (padding not counted)
  if (/ESP/.test(proto)) return 20 + 24 + Math.ceil((inner + 2) / 16) * 16 - inner + 12; // RFC 4303, AES-CBC, HMAC-SHA1-96
  return null;
}

/** The counts of what the sequences reached (each must be reached at least once over the seeds). */
const reached = {};
const saw = (k) => (reached[k] = (reached[k] || 0) + 1);

/** The invariants: the first violated one's description, or null. */
function violated(g, actions, count = false) {
  const { s, tests, refused, runs, impaired } = play(g, actions);
  const note = count ? saw : () => {};
  for (const m of impaired) note('impair:' + m);
  for (const [k, on] of Object.entries({ v6: g.v6, ecmp: g.ecmp, reuse: g.reuse, dhcp: g.dhcp, app: g.app, lossy: g.lossy, ['tunnel-' + (g.tunnel || 'none')]: true })) if (on) note('model:' + k);
  // refusals: each expected, else the generator made an action that is not legal
  for (const x of refused) {
    if (!EXPECTED_REFUSAL.some((re) => re.test(x.why))) return `the generator's action ${JSON.stringify(x.a)} was refused unexpectedly: ${x.why}`;
    note('refused');
  }
  const byId = new Map(tests.map((t) => [t.id, t]));
  const sent = new Map();
  for (const t of tests) for (const p of t.pktIds) sent.set(p, t.id);
  for (const t of tests) {
    // a test still waiting at the end must be waiting for its lease (DHCP), never stuck
    if (!t.done) {
      if ((t.waits || []).some((w) => w.cond === 'lease' && w.until === undefined)) {
        note('waiting-for-lease');
        continue;
      }
      return `test ${t.id} never ended (30 s after the last action), waiting for nothing recorded`;
    }
    if (!t.outcome) return `test ${t.id} ended without a structured outcome`;
    if ((t.outcome.kind === 'answered') !== t.ok) return `test ${t.id}: outcome ${t.outcome.kind} but ok = ${t.ok}`;
    note('outcome:' + t.outcome.kind);
    // a reply completes only its own exchange: an answer comes from the device that has the destination address in the
    // sender's context (hc, reusing hb's address in VRF blue, never answers ha)
    const own = t.target === 'ha' ? 'ha' : OWNER[t.target];
    if (!own) return `test ${t.id}: the generator sent to ${t.target}, which no device owns`;
    // (at the packet boundary: the answer records its sender and the address it came from — required, never optional)
    if (t.ok && (t.outcome.by === undefined || t.outcome.byAddr === undefined)) return `test ${t.id} to ${t.target} was answered without its sender recorded (${JSON.stringify(t.outcome)})`;
    if (t.ok && t.outcome.by !== own) return `test ${t.id} to ${t.target} was answered by ${t.outcome.by}, not ${own}`;
    if (t.ok && t.target !== 'ha' && t.outcome.byAddr !== t.target) return `test ${t.id} to ${t.target}: its answer came from ${t.outcome.byAddr}`;
    if (t.ok && t.target === 'ha' && !/^10\.1\.0\./.test(t.outcome.byAddr)) return `test ${t.id} to ha (its lease): its answer came from ${t.outcome.byAddr}`;
    if (t.ok && impaired.size) note('answered-impaired');
    if (t.ok && g.reuse && t.target === '10.2.0.10') note('reuse-answered');
    // its recorded drops are of its own exchange, within its time
    for (const d of t.outcome.drops || []) {
      if (d.t < t.started - 1e-6 || (t.ended !== undefined && d.t > t.ended + 1e-6)) return `test ${t.id}: a drop recorded outside its time (${d.t})`;
      if (d.attempt && d.cause && !(t.pktIds.indexOf(d.cause.pkt) >= 0 || (d.cause.carried || []).some((p) => t.pktIds.indexOf(p) >= 0))) return `test ${t.id}: a drop marked as its attempt is of another packet`;
    }
    // the diagnosis of it on its own: never established for a failure; blocked only for an established cause
    const ev = { exec: s.exec, subject: { kind: 'send', id: t.id, label: 'send', t0: t.started, stopped: false, count: 1, sent: 1, skipped: [] }, tests: [t], events: [], log: s.events(), waits: (id) => s.engine.waitsOf(id), retained: { first: s.events().length ? s.events()[0].t : 0, firstSeq: 0, dropped: s.engine.logDropped }, now: s.now };
    const dg = D.diagnose({ check: { request: { from: t.from }, verdict: 'indeterminate', headline: '', layers: [], legs: [], info: {} }, context: R.configuredContext('x'), runtime: ev });
    if (!dg.runtime.completed) return `test ${t.id}: done, but its diagnosis is not finished`;
    if (t.ok !== (dg.runtime.outcome === 'succeeded')) return `test ${t.id}: ok ${t.ok}, diagnosis outcome ${dg.runtime.outcome}`;
    if (!t.ok && (dg.state === 'established' || dg.state === 'recovered')) return `test ${t.id}: failed, diagnosed ${dg.state}`;
    if (dg.state === 'blocked' && dg.runtime.cause !== 'established') return `test ${t.id}: blocked without an established cause`;
    if (dg.state === 'failed') note('diag:cause-unknown');
    if (dg.state === 'blocked') note('diag:blocked');
  }
  // structured evidence attaches to its own line: a drop's packet is its event's; a packet a test sent is never noted for another
  for (const e of s.events()) {
    if (e.kind === 'route' && e.route) note('ecmp-choice');
    if (e.kind !== 'drop' || !e.cause) continue;
    if (e.cause.pkt !== undefined && e.pkt !== e.cause.pkt) return `drop event ${e.seq}: its cause names packet ${e.cause.pkt}, the event ${e.pkt}`;
    const of = [e.cause.pkt].concat(e.cause.carried || []).map((p) => sent.get(p)).find((x) => x !== undefined);
    if (of !== undefined && e.test !== undefined && e.test !== of && byId.has(e.test)) return `drop event ${e.seq} of test ${of}'s packet is noted for test ${e.test}`;
  }
  // packet sizes: every frame on a cable is 18 + its outer IP packet (at least 64); each tunnel layer its hand-worked bytes
  for (const f of s.flights(s.now, 'physical', 0)) {
    const h = f.hdr;
    if (!h || !h.l3.length) continue;
    if (h.l2.bytes !== Math.max(64, 18 + h.l3[0].len)) return `frame of ${h.label}: ${h.l2.bytes} bytes for an IP packet of ${h.l3[0].len}`;
    for (let i = 0; i + 1 < h.l3.length; i++) {
      if (h.l3[i].frag || h.l3[i].version !== 4) continue;
      const want = around(h.l3[i].proto, h.l3[i + 1].len);
      if (want !== null && h.l3[i].len !== h.l3[i + 1].len + want) return `${h.l3[i].proto} packet of ${h.label}: ${h.l3[i].len} bytes around an inner ${h.l3[i + 1].len} (want +${want})`;
      if (want !== null) note('size:' + h.l3[i].proto.split(' ')[0]);
    }
  }
  // the application's run: after Stop nothing more starts; its messages and retries within its configuration
  for (const run of runs) {
    if (run.stoppedAt !== undefined && run.tests.some((t) => t.started > run.stoppedAt + 1e-6)) return `application run ${run.id}: a message started after Stop`;
    if (run.tests.some((t) => (t.retry || 0) > 1)) return `application run ${run.id}: more retries than configured`;
    const msgs = new Set(run.tests.map((t) => t.msg).concat(run.skipped.map((x) => x.n)));
    const o = A.appOutcome(run);
    if (o.ok + o.failed + o.pending + o.cancelled !== msgs.size) return `application run ${run.id}: ${msgs.size} messages, outcomes ${JSON.stringify(o)}`;
    if (run.tests.some((t) => t.retry)) note('app-retry');
    if (run.stoppedAt !== undefined) note('app-stopped');
  }
  // the static MTU boundary: with nothing failed, every MTU written and the source's address configured, the static path
  // MTU is established — and a DF ping of the payload it allows is answered, one byte more is too big
  if (!actions.some((a) => a.op === 'fail' || a.op === 'power') && g.all && !g.dhcp && !g.lossy) {
    const m = model(g.yaml);
    const st = MT.pathMtu(m, C.checkCommunication(m, { from: 'ha', to: 'hb', back: true }));
    if (!st || st.verdict !== 'satisfied' || !st.payload) return `every MTU written, nothing failed: the static path MTU is not established (${st ? st.verdict + ': ' + st.text : 'none'})`;
    note('mtu-boundary');
    const fresh = new S.Simulation(m);
    fresh.runTo(70000);
    const ping = (size) => {
      const t = fresh.sendTest({ from: 'ha', to: '10.2.0.10', kind: 'icmp', size, df: true });
      if (typeof t === 'string') throw new Error('the boundary send was refused: ' + t);
      fresh.runTo(fresh.now + 8000);
      return t;
    };
    // (the first DF packet over a narrower underlay teaches the tunnel head; PMTUD then answers the next one)
    const first = ping(st.payload.bytes);
    const fits = first.ok ? first : ping(st.payload.bytes);
    if (!fits.ok) return `static path MTU ${st.mtu}: a DF ping of ${st.payload.bytes} bytes was not answered (${fits.result})`;
    const over = ping(st.payload.bytes + 1);
    if (over.ok) return `static path MTU ${st.mtu}: a DF ping of ${st.payload.bytes + 1} bytes was answered`;
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

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

/** What the generator is meant to reach over the seeds: each must be reached (a branch never exercised is no property). */
const MUST = ['model:lossy', 'model:v6', 'model:ecmp', 'model:reuse', 'model:dhcp', 'model:app', 'model:tunnel-gre', 'model:tunnel-wireguard', 'model:tunnel-ipip', 'model:tunnel-gre-ipsec', 'model:tunnel-none', 'outcome:answered', 'outcome:timeout', 'outcome:too-big', 'outcome:refused', 'refused', 'reuse-answered', 'ecmp-choice', 'size:GRE', 'size:UDP', 'size:ESP', 'app-retry', 'app-stopped', 'mtu-boundary', 'diag:blocked', 'diag:cause-unknown', 'impair:dup', 'impair:delay', 'answered-impaired'];

test('property: structured outcomes, reply identity, evidence attachment, sizes, application runs, the diagnosis and the static MTU boundary hold over generated models and actions', () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const g = genModel(r);
    const actions = genActions(r, g, rng(seed + 7919));
    const v = violated(g, actions, true);
    if (v) {
      const small = reduce(g, actions, v);
      assert.fail(`seed ${seed} (deterministic settings: the simulation's defaults, its model seed from the model): ${violated(g, small) || v}\nactions: ${JSON.stringify(small)}\nmodel:\n${g.yaml}`);
    }
  }
  const missing = MUST.filter((k) => !reached[k]);
  assert.deepEqual(missing, [], `branches never exercised over ${SEEDS.length} seeds: ${missing.join(', ')} (reached: ${JSON.stringify(reached)})`);
});

test('property: the same seed gives the same outcomes, headless and played frame by frame', () => {
  for (const seed of SEEDS.slice(0, 10)) {
    const r = rng(seed);
    const g = genModel(r);
    const actions = genActions(r, g, rng(seed + 7919));
    // (the same schedule both ways: every action at the same simulated moment, the application on scenario time)
    const sig = (x) => x.tests.map((t) => [t.ok, t.outcome && t.outcome.kind, t.outcome && t.outcome.drop ? t.outcome.drop.cause && t.outcome.drop.cause.kind : '', t.ended, t.retx || 0]).concat(x.runs.map((u) => [u.id, u.tests.length, JSON.stringify(A.appOutcome(u))]));
    const a = sig(play(g, actions));
    assert.deepEqual(sig(play(g, actions)), a, `seed ${seed}: two headless runs differ`);
    assert.deepEqual(sig(play(g, actions, true)), a, `seed ${seed}: played frame by frame differs from headless\nactions: ${JSON.stringify(actions)}\nmodel:\n${g.yaml}`);
  }
});
