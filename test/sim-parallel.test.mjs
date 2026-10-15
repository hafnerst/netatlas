// Parallel protocol exchanges (analysis/sim/engine.ts, protocols.ts and
// the behaviours): everything is scheduled on the simulated clock by its
// actual preconditions only. A cabled interface sends nothing before its
// link is up; what needs nothing else starts then, together (ARP, OSPF,
// PIM, VRRP, IGMP); unicast waits for its own next hop's ARP; BGP goes
// ARP → TCP → OPEN → Established → UPDATE; what runs over a tunnel waits
// for the tunnel; PIM Joins wait for their RPF route, Registers for a
// route to the RP; independent devices and protocols are never serialized,
// reconvergence included; the jitter is small, seeded and deterministic;
// the dot limit and the pacing never change a simulated time; the log
// says what waits and for what, and the packet inspector what a message
// waited for and what caused it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const E = load('analysis/sim/engine.js');
const P = load('analysis/sim/pacing.js');

const PS = example('protocol-simulation.yaml');
const sim = (text, opts) => new S.Simulation(model(text), opts);
const ev = (s, f) => s.events().filter(f);
const first = (s, f) => {
  const e = s.events().find(f);
  return e ? e.t : Infinity;
};

/** Every flight from `from` to `to` (ms), sampled often enough that none is missed. */
function flights(s, from, to, step = 50) {
  const seen = new Map();
  for (let t = from; t <= to; t += step) {
    s.runTo(t);
    for (const f of s.engine.flights) seen.set(f.id, f);
  }
  return Array.from(seen.values());
}

test('startup: ARP, OSPF Hello, PIM Hello, VRRP and IGMP start together once the links are up: their simulated intervals overlap', () => {
  const s = sim(PS);
  const all = flights(s, 0, 8000);
  const startOf = {};
  const endOf = {};
  const of = (name, f) => {
    startOf[name] = Math.min(startOf[name] === undefined ? Infinity : startOf[name], f.t0);
    endOf[name] = Math.max(endOf[name] === undefined ? -Infinity : endOf[name], f.t1);
  };
  for (const f of all) {
    if (f.view !== 'physical') continue;
    if (/^ARP (Request|Reply)/.test(f.label)) of('arp', f);
    else if (f.protocol === 'ospf' && /Hello/.test(f.label)) of('ospf', f);
    else if (f.protocol === 'pim' && /Hello/.test(f.label)) of('pim', f);
    else if (f.protocol === 'igmp') of('igmp', f);
  }
  // VRRP: its routers start (Backup, listening) as soon as their interface is up, then advertise
  const vrrp = ev(s, (e) => e.protocol === 'vrrp' && e.kind === 'state');
  assert.ok(vrrp.length, 'VRRP starts');
  startOf.vrrp = vrrp[0].t;
  endOf.vrrp = first(s, (e) => e.protocol === 'vrrp' && e.kind === 'message');
  for (const k of ['arp', 'ospf', 'pim', 'igmp', 'vrrp']) assert.ok(Number.isFinite(startOf[k]) && Number.isFinite(endOf[k]), k);
  const lateStart = Math.max(...Object.values(startOf));
  const earlyEnd = Math.min(...Object.values(endOf));
  assert.ok(lateStart < earlyEnd, `the intervals overlap: the last starts at ${lateStart}, the first ends at ${earlyEnd} (${JSON.stringify(startOf)})`);
  // and all of them within one link-up delay and less than a hop's time of each other
  const delay = s.engine.params.num('link-up-delay');
  for (const k of Object.keys(startOf)) assert.ok(startOf[k] >= delay && startOf[k] < delay + 2, `${k} starts with its link (${startOf[k]})`);
  // nothing is sent before the links are up
  assert.ok(!ev(s, (e) => e.kind === 'message' && e.t < delay).length);
});

/** pc and two hosts on one LAN (h2 never answers: it is off), r1 the gateway to srv. */
const LAN2 = `netatlas: 1
title: next hops
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.20/24}]}
  - {id: sw, type: switch, interfaces: [p1, p2, p3]}
  - id: r1
    type: router
    interfaces: [{id: g0, ip: 10.0.1.1/24}, {id: g1, ip: 10.0.2.1/24}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "h2:eth0", b: "sw:p2"}
  - {id: c, a: "r1:g0", b: "sw:p3"}
  - {id: d, a: "r1:g1", b: "srv:eth0"}
`;

test('unicast waits only for its own next hop: the packet via the gateway goes when the gateway answers, whatever another next hop does', () => {
  const s = sim(LAN2);
  s.powerOff('h2');
  s.runTo(2500);
  const stuck = s.sendTest({ from: 'pc', to: '10.0.1.20', kind: 'icmp' });
  const ok = s.sendTest({ from: 'pc', to: 'srv', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(ok.ok, true, 'answered while the other next hop is still unresolved');
  assert.ok(ok.rtt < 50, `at once (${ok.rtt} ms)`);
  // each waited for its own next hop, and said so
  assert.ok(ev(s, (e) => e.kind === 'wait' && e.device === 'pc' && /ICMP Echo → 10\.0\.1\.20 waiting for ARP 10\.0\.1\.20$/.test(e.detail)).length === 1);
  assert.ok(ev(s, (e) => e.kind === 'wait' && e.device === 'pc' && /ICMP Echo → 10\.0\.2\.10 waiting for ARP 10\.0\.1\.1$/.test(e.detail)).length === 1);
  const echo = ev(s, (e) => e.kind === 'message' && e.device === 'pc' && e.what === 'Echo Request' && e.hdr && /10\.0\.2\.10/.test(e.detail))[0];
  assert.ok(echo && echo.hdr.waited && /^ARP 10\.0\.1\.1: /.test(echo.hdr.waited[0]), JSON.stringify(echo && echo.hdr));
  assert.notEqual(stuck.ok, true);
  // packets for the same next hop wait together and go together
  const s2 = sim(LAN2);
  s2.runTo(2500);
  const a = s2.sendTest({ from: 'pc', to: 'srv', kind: 'icmp' });
  const b = s2.sendTest({ from: 'pc', to: 'srv', kind: 'udp', port: 53 });
  s2.runTo(s2.now + 1);
  const reqs = ev(s2, (e) => e.kind === 'message' && e.device === 'pc' && e.what === 'ARP Request');
  assert.equal(reqs.length, 1, 'one ARP request for the gateway');
  // the first hop of each (back to back: the second after the first's serialization time on the wire)
  const leaves = (re) => Math.min(...s2.engine.flights.filter((f) => f.view === 'physical' && re.test(f.label) && f.sender === 'pc').map((f) => f.t0));
  const [ti, tu] = [leaves(/^ICMP Echo/), leaves(/^UDP/)];
  assert.ok(Number.isFinite(ti) && Math.abs(ti - tu) < 0.01, `both leave pc as the reply arrives (${ti}, ${tu})`);
  void a;
  void b;
});

const BGP = `netatlas: 1
title: bgp
devices:
  - {id: a, type: router, interfaces: [{id: g0, ip: 10.0.0.1/30}], protocols: {bgp: {asn: 65001}}}
  - {id: b, type: router, interfaces: [{id: g0, ip: 10.0.0.2/30}], protocols: {bgp: {asn: 65002}}}
links:
  - {id: l, a: "a:g0", b: "b:g0"}
relations:
  - {id: ebgp, protocol: bgp, endpoints: ["a:g0", "b:g0"]}
`;

test('BGP: ARP, then TCP, then OPEN, then Established, then UPDATE; each step says what it waited for', () => {
  const s = sim(BGP);
  s.runTo(5000);
  const at = (f) => first(s, f);
  const arp = at((e) => e.device === 'a' && e.what === 'ARP Request');
  const syn = at((e) => e.protocol === 'bgp' && e.kind === 'message' && e.what === 'TCP SYN');
  const synAck = at((e) => e.protocol === 'bgp' && e.kind === 'message' && e.what === 'TCP SYN-ACK');
  const open = at((e) => e.protocol === 'bgp' && e.kind === 'message' && e.what === 'OPEN');
  const est = at((e) => e.protocol === 'bgp' && e.kind === 'state' && e.what === 'Established');
  const upd = at((e) => e.protocol === 'bgp' && e.kind === 'message' && e.what === 'UPDATE');
  const order = [arp, syn, synAck, open, est, upd];
  assert.ok(order.every(Number.isFinite), JSON.stringify(order));
  // the SYN is queued for ARP (it is noted when sent); the SYN-ACK comes only after the ARP reply
  assert.ok(arp >= syn - 0.001 && synAck > arp && open > synAck && est > open && upd >= est, JSON.stringify(order));
  assert.ok(ev(s, (e) => e.kind === 'wait' && /^BGP TCP SYN waiting for ARP 10\.0\.0\.2$/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.kind === 'wait' && /BGP OPEN to 10\.0\.0\.2 waiting for TCP/.test(e.detail)).length === 1);
  const om = ev(s, (e) => e.kind === 'message' && e.what === 'OPEN' && e.device === 'a')[0];
  assert.ok(om.hdr && om.hdr.waited && /^TCP connection to 10\.0\.0\.2:179: /.test(om.hdr.waited[0]), JSON.stringify(om.hdr));
  assert.match(om.hdr.causedBy || '', /^BGP TCP SYN-ACK \(sent by b\), received at t = \d+\.\d{6} s$/);
});

test('tunnels stack in order: the link, IKE_SA_INIT, IKE_AUTH (the Child SA), then GRE inside ESP, then OSPF inside the tunnel; nothing over it is dropped meanwhile', () => {
  const s = sim(PS);
  s.runTo(20000);
  const at = (f) => first(s, f);
  const linkUp = at((e) => e.device === 'r2' && e.kind === 'link' && /Interface r2:wan is up/.test(e.detail));
  const init = at((e) => e.protocol === 'ipsec' && e.what === 'IKE_SA_INIT' && e.kind === 'message');
  const auth = at((e) => e.protocol === 'ipsec' && e.what === 'IKE_AUTH' && e.kind === 'message');
  const est = at((e) => e.protocol === 'ipsec' && e.kind === 'state' && e.what === 'Established');
  const greUp = at((e) => e.protocol === 'gre' && e.kind === 'state' && e.what === 'Up');
  const tunUp = at((e) => e.kind === 'link' && /Interface (r2|br):Tunnel1 is up/.test(e.detail));
  const ospf = at((e) => e.protocol === 'ospf' && e.kind === 'message' && e.what === 'Hello' && /Tunnel1/.test(e.detail));
  const order = [linkUp, init, auth, est, greUp, tunUp, ospf];
  assert.ok(order.every(Number.isFinite), JSON.stringify(order));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], `step ${i}: ${JSON.stringify(order)}`);
  // the GRE keepalive waited for IPsec (said so), it was not dropped
  assert.ok(ev(s, (e) => e.kind === 'wait' && /^GRE Keepalive waiting for IPsec ipsec-br$/.test(e.detail)).length >= 1);
  assert.ok(!ev(s, (e) => e.kind === 'drop' && /is not up \(/.test(e.detail)).length, 'nothing dropped because the tunnel was not up yet');
  assert.ok(ev(s, (e) => e.kind === 'wait' && /Tunnel1: .*wait for the tunnel to come up/.test(e.detail)).length >= 1);
});

test('PIM: Hellos at once; a Join waits for its RPF route, a Register for a route to the RP, and each goes as soon as there is one', () => {
  const s = sim(PS);
  s.runTo(20000);
  const delay = s.engine.params.num('link-up-delay');
  assert.ok(first(s, (e) => e.protocol === 'pim' && e.what === 'Hello' && e.kind === 'message') < delay + 2);
  const jw = ev(s, (e) => e.kind === 'wait' && e.protocol === 'pim' && /^PIM Join \(\*, 239\.1\.1\.1\) at r3 waiting for an RPF route to 10\.255\.0\.1/.test(e.detail));
  assert.ok(jw.length >= 1);
  const rw = ev(s, (e) => e.kind === 'wait' && /^PIM Register \(10\.30\.0\.30, 239\.1\.1\.1\) waiting for a route to the RP 10\.255\.0\.1$/.test(e.detail));
  assert.ok(rw.length >= 1);
  // the route to the RP comes with OSPF; the waiting Register goes then, saying how long it waited
  const fl = flights(sim(PS), 0, 20000).filter((f) => /^PIM Register \(10\.30\.0\.30/.test(f.label) && f.hdr && f.hdr.waited);
  assert.ok(fl.length, 'the Register is sent once there is a route');
  assert.match(fl[0].hdr.waited[0], /^a route to the RP 10\.255\.0\.1: \d/);
  const join = first(s, (e) => e.device === 'r3' && e.protocol === 'pim' && e.what === 'Join/Prune' && e.kind === 'message');
  assert.ok(join > jw[0].t, 'the Join goes once it has its RPF route');
  assert.ok(!ev(s, (e) => e.kind === 'drop' && /cannot join/.test(e.detail)).length, 'a missing route is a wait, not a failure');
});

/** Two independent islands, each two routers with OSPF over a cable. */
const ISLANDS = `netatlas: 1
title: islands
devices:
  - {id: a1, type: router, interfaces: [{id: g0, ip: 10.1.0.1/30}]}
  - {id: a2, type: router, interfaces: [{id: g0, ip: 10.1.0.2/30}]}
  - {id: b1, type: router, interfaces: [{id: g0, ip: 10.2.0.1/30}]}
  - {id: b2, type: router, interfaces: [{id: g0, ip: 10.2.0.2/30}]}
links:
  - {id: la, a: "a1:g0", b: "a2:g0"}
  - {id: lb, a: "b1:g0", b: "b2:g0"}
relations:
  - {id: ospf-a, protocol: ospf, endpoints: ["a1:g0", "a2:g0"]}
  - {id: ospf-b, protocol: ospf, endpoints: ["b1:g0", "b2:g0"]}
`;

test('independent devices and protocols are not serialized: two islands go through the same steps at the same moments', () => {
  const s = sim(ISLANDS);
  s.runTo(30000);
  const hop = s.engine.hopTime();
  const steps = (dev) => ev(s, (e) => e.device === dev && e.protocol === 'ospf' && (e.kind === 'message' || e.kind === 'state')).map((e) => [e.what, e.t]);
  const a = steps('a1');
  const b = steps('b1');
  assert.ok(a.length > 5);
  assert.deepEqual(a.map((x) => x[0]).slice(0, 8), b.map((x) => x[0]).slice(0, 8), 'the same steps');
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(a[i][1] - b[i][1]) < 4 * hop + 1, `step ${a[i][0]} at ${a[i][1]} and ${b[i][1]}`);
  // and on the screen: the first Hellos of both are on their way at once
  const all = flights(sim(ISLANDS), 0, 3000, 1).filter((f) => f.protocol === 'ospf' && f.view === 'physical');
  const fa = all.find((f) => f.sender === 'a1' || f.sender === 'a2');
  const fb = all.find((f) => f.sender === 'b1' || f.sender === 'b2');
  assert.ok(fa && fb && fa.t0 < fb.t1 && fb.t0 < fa.t1, 'their first hops overlap in simulated time');
});

test('reconvergence runs in parallel: two failures restored at once come back together', () => {
  const s = sim(ISLANDS);
  s.runTo(60000);
  s.fail('link:la');
  s.fail('link:lb');
  s.runTo(s.now + 5000);
  const t = s.now;
  s.restore('link:la');
  s.restore('link:lb');
  s.runTo(t + 60000);
  const full = (dev) => ev(s, (e) => e.t > t && e.device === dev && e.protocol === 'ospf' && e.kind === 'state' && /^Full/.test(e.what)).map((e) => e.t)[0];
  const fa = full('a1');
  const fb = full('b1');
  assert.ok(Number.isFinite(fa) && Number.isFinite(fb), `${fa} ${fb}`);
  assert.ok(Math.abs(fa - fb) < 4 * s.engine.hopTime() + 1, `both Full together (${fa}, ${fb})`);
  // and their links come up after the link-up delay, both
  const up = ev(s, (e) => e.t > t && e.kind === 'link' && /has carrier again/.test(e.detail)).map((e) => e.t);
  assert.ok(up.length >= 4 && Math.max(...up) - Math.min(...up) < 4 * s.engine.hopTime() + 1);
});

test('the jitter is small, seeded and deterministic; ties keep their order', () => {
  const a = sim(PS);
  const b = sim(PS);
  a.runTo(30000);
  b.runTo(30000);
  const key = (s) => s.events().map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}|${e.detail}`);
  assert.deepEqual(key(a), key(b), 'the same events at the same times in the same order');
  // the jitter: less than the share of a hop's time
  const e = a.engine;
  for (let i = 0; i < 200; i++) {
    const j = e.jitter();
    assert.ok(j >= 0 && j < E.JITTER_SHARE * e.hopTime());
  }
  // events at the same moment keep the order they were made in (their sequence)
  const ev2 = a.events();
  for (let i = 1; i < ev2.length; i++) if (ev2[i].t === ev2[i - 1].t) assert.ok(ev2[i].seq > ev2[i - 1].seq);
  // another model (another seed) jitters differently, and is just as deterministic
  const c = sim(PS.replace(/^title: .*$/m, 'title: another'));
  c.runTo(30000);
  assert.notDeepEqual(key(c).slice(0, 200), key(a).slice(0, 200));
});

test('the dot limit and the pacing never change a simulated time', () => {
  const plain = sim(PS);
  plain.runTo(15000);
  const want = plain.events().filter((e) => e.t <= 14000).map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}`);
  for (const [limit, mode] of [[1, 'readable'], [48, 'readable'], [4, 'proportional']]) {
    const s = sim(PS);
    const host = { engine: s.engine, shown: (f) => f.view === 'physical', typical: () => s.engine.hopTime(), headers: (f) => f.hdr };
    const p = new P.Pacer(host, limit);
    p.mode = mode;
    p.speed = 4;
    for (let i = 0; i < 200000 && s.now < 14500; i++) p.frame(50);
    const got = s.events().filter((e) => e.t <= 14000).map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}`);
    assert.deepEqual(got, want, `limit ${limit}, ${mode}`);
    if (limit === 1) assert.ok(p.notDrawn > 0, 'with a limit of 1 some hops were not drawn, and still sent');
  }
});

test('several hops are on screen at once at the start (they are not drawn one after another)', () => {
  const s = sim(PS);
  const host = { engine: s.engine, shown: (f) => f.view === 'physical', typical: () => s.engine.hopTime(), headers: (f) => f.hdr };
  const p = new P.Pacer(host, 48);
  let most = 0;
  for (let i = 0; i < 2000 && s.now < 2500; i++) {
    p.frame(16);
    const moving = p.items.filter((it) => it.drawn && ['moving', 'transit'].includes(p.state(it).phase));
    most = Math.max(most, new Set(moving.map((it) => it.f.protocol)).size);
  }
  assert.ok(most >= 4, `dots of ${most} protocols in flight together`);
});

test('the log: what waits says for what; events of the same moment come together', () => {
  const s = sim(PS);
  s.runTo(15000);
  const waits = ev(s, (e) => e.kind === 'wait');
  assert.ok(waits.length > 10);
  assert.ok(waits.every((e) => e.what === 'waiting' && /wait(s|ing)? for /.test(e.detail)), waits.find((e) => !/wait(s|ing)? for /.test(e.detail)));
  assert.ok(waits.some((e) => /^OSPF DBD waiting for ARP 10\.\d+\.\d+\.\d+$/.test(e.detail)) || waits.some((e) => /OSPF .* waiting for ARP/.test(e.detail)), 'an OSPF exchange waits for its neighbour’s ARP');
  assert.ok(waits.some((e) => /: .* wait for the link to come up \(Layer 1: link-up delay 2 s/.test(e.detail)));
  // a moment with several events (a message and the state it causes): they are adjacent in the log
  const byT = new Map();
  for (const e of s.events()) byT.set(e.t, (byT.get(e.t) || 0) + 1);
  assert.ok(Array.from(byT.values()).some((n) => n > 1));
  const list = s.events();
  for (let i = 2; i < list.length; i++) if (list[i].t === list[i - 2].t) assert.equal(list[i - 1].t, list[i].t, 'no other moment between them');
});
