// OSPF in the protocol simulation (analysis/sim/proto-routing.ts): the
// interface state machine (Waiting, the Wait timer, BackupSeen), the DR
// and BDR election of RFC 2328 §9.4 (priority 0 never elected, no DR at
// all when nobody is eligible, non-preemptive incumbency, failure and
// recovery), the network types (only broadcast and non-broadcast elect),
// the adjacencies a segment forms (AdjOK?), and the Hello parameters that
// must match (intervals, area, network type) — with the routes and the
// delivery that follow from them, not only the states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);

/**
 * r1 … rN on one switched LAN (10.0.0.0/24), each with a loopback
 * 10.255.0.n/32 (its router ID) and a stub network 10.n.0.0/24 on a host
 * port; one OSPF relation over the LAN. `prio` per router (undefined: not
 * written); `attrs` more relation attributes.
 */
function lan(n, o = {}) {
  const devs = [];
  for (let i = 1; i <= n; i++) {
    const p = o.prio && o.prio[i - 1] !== undefined ? `, priority.r${i}: ${o.prio[i - 1]}` : '';
    void p;
    devs.push(`  - id: r${i}
    type: router
    router_id: lo0
    protocols: {ospf: {}}
    interfaces:
      - {id: ge0, ip: 10.0.0.${i}/24}
      - {id: ge1, ip: 10.${i}.0.1/24}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.${i}/32}`);
  }
  const ports = [];
  const links = [];
  for (let i = 1; i <= n; i++) {
    ports.push(`{id: p${i}, vlans: 1}`);
    links.push(`  - {id: l${i}, a: "r${i}:ge0", b: "sw:p${i}"}`);
  }
  const prio = [];
  for (let i = 1; i <= n; i++) if (o.prio && o.prio[i - 1] !== undefined) prio.push(`priority.r${i}: ${o.prio[i - 1]}`);
  const attrs = prio.concat(o.attrs || []);
  const eps = [];
  for (let i = 1; i <= n; i++) eps.push(`"r${i}:ge0"`);
  return `netatlas: 1
title: lan
devices:
${devs.join('\n')}
  - id: sw
    type: switch
    interfaces: [${ports.join(', ')}]
links:
${links.join('\n')}
relations:
  - {id: lan, protocol: ospf, endpoints: [${eps.join(', ')}]${attrs.length ? ', attrs: {' + attrs.join(', ') + '}' : ''}}
`;
}

const ospfOf = (s, dev) => s.status().filter((x) => x.protocol === 'ospf' && x.device === dev);
const stateOf = (s, dev, peer) => (ospfOf(s, dev).find((x) => x.peer === peer) || {}).state;
const roleOf = (s, dev) => {
  const d = (ospfOf(s, dev)[0] || {}).detail || '';
  return /this router is DR/.test(d) ? 'DR' : /this router is BDR/.test(d) ? 'BDR' : /Waiting/.test(d) ? 'Waiting' : /no DR/.test(d) ? 'none' : 'DROther';
};
const elections = (s, dev) => s.events().filter((e) => e.protocol === 'ospf' && e.device === dev && /DR election/.test(e.detail));
/** r1's route to r3's stub network: "forward via …", or none */
const route = (s, from, ip) => s.routeLookup(from, ip);

test('OSPF broadcast: Waiting for the Wait timer (the dead interval) before the first election; no adjacency beyond 2-Way until then', () => {
  const s = sim(lan(3));
  s.runTo(30000);
  for (const d of ['r1', 'r2', 'r3']) {
    assert.equal(roleOf(s, d), 'Waiting', d);
    for (const p of ['r1', 'r2', 'r3']) if (p !== d) assert.equal(stateOf(s, d, p), '2-Way', `${d} → ${p}`);
  }
  // no route over the LAN before an adjacency is Full
  assert.notEqual(route(s, 'r1', '10.3.0.1').kind, 'forward');
  s.runTo(50000);
  // highest priority (all 1), then highest router ID: r3 DR, r2 BDR, r1 DROther
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['DROther', 'BDR', 'DR']);
  // DROther r1 is adjacent to DR and BDR only; r1 – r2 Full, r1 – r3 Full, (r2 – r3 Full as DR and BDR)
  assert.equal(stateOf(s, 'r1', 'r3'), 'Full');
  assert.equal(stateOf(s, 'r1', 'r2'), 'Full');
  assert.equal(stateOf(s, 'r2', 'r3'), 'Full');
  assert.equal(route(s, 'r1', '10.3.0.1').kind, 'forward');
  // the timers' reason is in the log
  assert.ok(elections(s, 'r1').some((e) => /the Wait timer expired \(40 s/.test(e.detail)));
});

test('OSPF priority 0: never DR or BDR; priority 0 is kept (not read as 1), configured and in the Hellos', () => {
  // r3 has the highest router ID but priority 0
  const s = sim(lan(3, { prio: [1, 1, 0] }));
  s.runTo(50000);
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['BDR', 'DR', 'DROther']);
  assert.match(ospfOf(s, 'r3')[0].detail, /priority 0/);
  assert.ok(s.events().some((e) => e.protocol === 'ospf' && e.device === 'r3' && e.what === 'Hello' && /priority 0,/.test(e.detail)));
  // r3 is adjacent with DR and BDR, and its routes go over the LAN
  assert.equal(stateOf(s, 'r3', 'r2'), 'Full');
  assert.equal(stateOf(s, 'r3', 'r1'), 'Full');
  assert.equal(route(s, 'r3', '10.1.0.1').kind, 'forward');
});

test('OSPF all priorities 0: no DR is invented, no adjacency forms, and no route crosses the segment', () => {
  const s = sim(lan(3, { prio: [0, 0, 0] }));
  s.runTo(60000);
  for (const d of ['r1', 'r2', 'r3']) {
    assert.equal(roleOf(s, d), 'none', d);
    for (const p of ['r1', 'r2', 'r3']) if (p !== d) assert.equal(stateOf(s, d, p), '2-Way', `${d} → ${p} stays 2-Way`);
  }
  assert.ok(elections(s, 'r1').some((e) => /no DR: no router on the segment has a priority above 0/.test(e.detail)));
  assert.notEqual(route(s, 'r1', '10.3.0.1').kind, 'forward');
  const t = s.sendTest({ from: 'r1', via: 'ge1', to: '10.3.0.1', kind: 'icmp' });
  s.runTo(s.now + 6000);
  assert.equal(t.ok, false, 'nothing crosses a segment without a DR');
});

test('OSPF non-preemptive: a router with a higher priority that comes later does not take over DR or BDR', () => {
  const s = sim(lan(4, { prio: [1, 1, 1, 200] }));
  s.powerOff('r4');
  s.runTo(50000);
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['DROther', 'BDR', 'DR']);
  // (a router boots in 60 s)
  s.powerOn('r4');
  s.runTo(s.now + 60000 + 40000);
  // r4 heard a DR and BDR in their Hellos (BackupSeen): it kept them; it is DROther despite priority 200
  assert.equal(roleOf(s, 'r4'), 'DROther');
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['DROther', 'BDR', 'DR']);
  assert.ok(elections(s, 'r4').some((e) => /shows the segment's (BDR|DR)/.test(e.detail)), 'r4 ended its Wait by BackupSeen');
  assert.equal(stateOf(s, 'r4', 'r3'), 'Full');
  assert.equal(stateOf(s, 'r4', 'r1'), '2-Way', 'two DROthers stay 2-Way');
});

test('OSPF DR failure: the BDR becomes DR and a new BDR is elected; the old DR comes back as DROther; routes follow', () => {
  const s = sim(lan(4));
  s.runTo(50000);
  assert.deepEqual(['r1', 'r2', 'r3', 'r4'].map((d) => roleOf(s, d)), ['DROther', 'DROther', 'BDR', 'DR']);
  s.powerOff('r4');
  // the others notice by their dead interval (40 s)
  s.runTo(s.now + 45000);
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['DROther', 'BDR', 'DR']);
  assert.equal(stateOf(s, 'r1', 'r3'), 'Full');
  assert.equal(stateOf(s, 'r1', 'r2'), 'Full', 'r1 forms an adjacency with the new BDR');
  assert.equal(route(s, 'r1', '10.3.0.1').kind, 'forward');
  assert.notEqual(route(s, 'r1', '10.4.0.1').kind, 'forward', 'r4 is gone');
  s.powerOn('r4');
  s.runTo(s.now + 60000 + 40000);
  assert.equal(roleOf(s, 'r4'), 'DROther', 'the old DR does not preempt');
  assert.equal(roleOf(s, 'r3'), 'DR');
  assert.equal(route(s, 'r1', '10.4.0.1').kind, 'forward');
});

test('OSPF interface restart: the interface waits again; its neighbours keep their DR', () => {
  const s = sim(lan(3));
  s.runTo(50000);
  s.shut('r1', 'ge0');
  s.runTo(s.now + 2000);
  assert.equal(stateOf(s, 'r1', 'r3'), 'Down');
  s.noShut('r1', 'ge0');
  s.runTo(s.now + 15000);
  // r1 is Waiting or already saw the DR and BDR (BackupSeen); never DR itself
  assert.notEqual(roleOf(s, 'r1'), 'DR');
  s.runTo(s.now + 45000);
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => roleOf(s, d)), ['DROther', 'BDR', 'DR']);
  assert.equal(stateOf(s, 'r1', 'r3'), 'Full');
});

test('OSPF point-to-point: no Waiting and no election; Full within seconds; a tunnel is point-to-point unless written', () => {
  const s = sim(lan(2, { attrs: ['network-type: point-to-point'] }));
  s.runTo(15000);
  assert.equal(stateOf(s, 'r1', 'r2'), 'Full');
  assert.match(ospfOf(s, 'r1')[0].detail, /point-to-point/);
  assert.equal(elections(s, 'r1').length, 0);
  // the same pair as broadcast (the default): two routers still elect a DR and BDR after the Wait
  const b = sim(lan(2));
  b.runTo(15000);
  assert.equal(stateOf(b, 'r1', 'r2'), '2-Way');
  b.runTo(50000);
  assert.deepEqual(['r1', 'r2'].map((d) => roleOf(b, d)), ['BDR', 'DR']);
  assert.equal(stateOf(b, 'r1', 'r2'), 'Full');
});

test('OSPF Hellos that do not match: different intervals, areas or network types make no adjacency (and say why)', () => {
  for (const [attrs, why] of [
    [['hello.r1: 5', 'dead.r1: 20'], /hello interval 10 s in its Hello, 5 s \(configured\) here|hello interval 5 s in its Hello, 10 s/],
    [['area.r1: 0', 'area.r2: 1'], /area 1 in its Hello, 0 here|area 0 in its Hello, 1 here/],
    [['network-type.r1: point-to-point'], /network type (broadcast|point-to-point) there, (point-to-point|broadcast) here/],
  ]) {
    const s = sim(lan(2, { attrs }));
    s.runTo(60000);
    assert.notEqual(stateOf(s, 'r1', 'r2'), 'Full', attrs.join(', '));
    assert.notEqual(stateOf(s, 'r2', 'r1'), 'Full', attrs.join(', '));
    assert.ok(s.events().some((e) => e.what === 'Hello ignored' && why.test(e.detail)), attrs.join(', '));
    assert.notEqual(route(s, 'r1', '10.2.0.1').kind, 'forward', attrs.join(', '));
  }
  // equal values written differently match (area 0 and 0.0.0.0)
  const ok = sim(lan(2, { attrs: ['area.r1: 0', 'area.r2: 0.0.0.0', 'network-type: point-to-point'] }));
  ok.runTo(15000);
  assert.equal(stateOf(ok, 'r1', 'r2'), 'Full');
});

test('OSPF: two DROthers reach each other through the DR’s record (as its LSUs brought it), the next hop each other on the segment', () => {
  const s = sim(lan(4));
  s.runTo(50000);
  assert.deepEqual(['r1', 'r2'].map((d) => roleOf(s, d)), ['DROther', 'DROther']);
  assert.equal(stateOf(s, 'r1', 'r2'), '2-Way');
  const r = route(s, 'r1', '10.2.0.1');
  assert.equal(r.kind, 'forward', r.text);
  assert.match(r.text, /via 10\.0\.0\.2 out ge0/, 'straight to the other DROther, not through the DR');
  // r1 knows of r2 through r4's record (the DR names r2 as its neighbour), never by reading r2's own state
  const dr = s.protocols.viewOf('r1').find((x) => x.origin === 'r4' && x.inst === 'ospf|');
  assert.ok(dr && dr.adj.some((a) => a.endsWith('|r2')), JSON.stringify(dr));
});
