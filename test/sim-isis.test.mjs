// IS-IS forms its adjacency on the link (analysis/sim/proto-routing.ts):
// its PDUs are frames, so its routers pair over the cable between them
// whatever their interfaces' IP addresses, by their identity from the
// NET (system ID, area) and their level. Asserted by the sessions' states,
// the frames sent and the routes installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const PAIR = (x) => `netatlas: 1
title: isis
devices:
  - id: r1
    type: router
    interfaces: [{id: g0, ${x.ip1}}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]
    protocols: {isis: {net: ${x.net1 || '49.0001.0000.0000.0001.00'}${x.lv1 ? ', level: ' + x.lv1 : ''}}}
  - id: r2
    type: router
    interfaces: [{id: g0, ${x.ip2}}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]
    protocols: {isis: {net: ${x.net2 || '49.0001.0000.0000.0002.00'}${x.lv2 ? ', level: ' + x.lv2 : ''}}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: igp, protocol: isis, endpoints: ["r1:g0", "r2:g0"]}
`;

const sim = (x) => new S.Simulation(model(PAIR(x)));
const states = (s) => ['r1', 'r2'].map((d) => s.sessions(d, 'isis').map((x) => x.state).join());

test('IS-IS: interfaces in different subnets — the adjacency forms on the link (the IIHs are frames); without a common subnet no IPv4 next hop, said so', () => {
  const s = sim({ ip1: 'ip: 10.0.1.1/24', ip2: 'ip: 10.0.2.2/24' });
  s.runTo(60000);
  assert.deepEqual(states(s), ['Up', 'Up']);
  // its PDUs are frames on the link: no IP header
  const iih = s.events().find((e) => e.kind === 'message' && e.protocol === 'isis' && e.what === 'IIH' && e.hdr);
  assert.ok(iih && iih.hdr.l3.length === 0 && iih.hdr.l2.dst === '01:80:c2:00:00:15', JSON.stringify(iih && iih.hdr));
  assert.ok(s.events().some((e) => e.kind === 'message' && e.protocol === 'isis' && e.what === 'LSP' && e.hdr && e.hdr.l3.length === 0));
  assert.ok(s.events().some((e) => e.kind === 'route' && e.device === 'r1' && e.protocol === 'isis' && /learned from r2/.test(e.detail)), 'the LSPs were taken');
  assert.equal(s.routeLookup('r1', '10.255.0.2').kind, 'none', 'numbered in different subnets: no next hop for IPv4');
});

test('IS-IS: unnumbered interfaces — the adjacency forms, and the routes go out of the interface to the neighbour’s own address', () => {
  const s = sim({ ip1: 'label: unnumbered', ip2: 'label: unnumbered' });
  s.runTo(60000);
  assert.deepEqual(states(s), ['Up', 'Up']);
  const r = s.routeLookup('r1', '10.255.0.2');
  assert.equal(r.kind, 'forward', r.text);
  assert.match(r.text, /out g0/);
  // and the packets go: loopback to loopback over the unnumbered link
  const t = s.sendTest({ from: 'r1', to: '10.255.0.2', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
});

test('IS-IS: its identity decides — level 1 only between areas makes no adjacency; a duplicate system ID none either; level 2 across areas does', () => {
  const l1 = sim({ ip1: 'ip: 10.0.12.1/30', ip2: 'ip: 10.0.12.2/30', net2: '49.0002.0000.0000.0002.00', lv1: 'level-1', lv2: 'level-1' });
  l1.runTo(40000);
  assert.deepEqual(states(l1), ['Down', 'Down']);
  assert.ok(l1.events().some((e) => e.kind === 'drop' && /level 1 only, and area 49\.0002 there, 49\.0001 here/.test(e.detail)));
  const dup = sim({ ip1: 'ip: 10.0.12.1/30', ip2: 'ip: 10.0.12.2/30', net2: '49.0001.0000.0000.0001.00' });
  dup.runTo(40000);
  assert.deepEqual(states(dup), ['Down', 'Down']);
  assert.ok(dup.events().some((e) => e.kind === 'drop' && /a duplicate system ID/.test(e.detail)));
  const l2 = sim({ ip1: 'ip: 10.0.12.1/30', ip2: 'ip: 10.0.12.2/30', net2: '49.0002.0000.0000.0002.00' });
  l2.runTo(40000);
  assert.deepEqual(states(l2), ['Up', 'Up']);
  assert.equal(l2.routeLookup('r1', '10.255.0.2').kind, 'forward');
});

test('IS-IS: a router with a NET and no IP address at all — the adjacency forms (no address made up for it); it has no IP next hop to offer, and says nothing it does not have', () => {
  const s = new S.Simulation(model(`netatlas: 1
title: isis without ip
devices:
  - {id: r1, type: router, interfaces: [{id: g0, label: no ip}], protocols: {isis: {net: 49.0001.0000.0000.0001.00}}}
  - id: r2
    type: router
    interfaces: [{id: g0, label: no ip}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]
    protocols: {isis: {net: 49.0001.0000.0000.0002.00}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: igp, protocol: isis, endpoints: ["r1:g0", "r2:g0"]}
`));
  s.runTo(60000);
  assert.deepEqual(states(s), ['Up', 'Up'], 'the adjacency is IS-IS’s, on the link');
  const P = s.protocols;
  const r1 = Array.from(P.sessions.values()).find((x) => x.dev === 'r1' && x.protocol === 'isis');
  assert.equal(r1.local.addr, null, 'r1 has no IP address: none is made up');
  // the frames went (no IP header)
  assert.ok(s.events().some((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'IIH' && e.hdr && e.hdr.l3.length === 0));
  // r2 learned r1's LSPs, but r1 has no IP address to be a next hop: no route through it, and r1 none to r2's loopback either
  assert.ok(s.events().some((e) => e.kind === 'route' && e.device === 'r2' && e.protocol === 'isis' && /learned from r1/.test(e.detail)));
  assert.equal(s.routeLookup('r1', '10.255.0.2').kind, 'none');
  // the routing analysis says why: the adjacency is there, the next hop is not
  const ROUTING = load('analysis/routing.js');
  const miss = ROUTING.routingAdjacencies(s.model).missing.find((m) => m.from === 'r1' && m.to === 'r2');
  assert.match(miss.detail, /the IS-IS adjacency over r1:g0 – r2:g0 has no IP next hop: r1 has no IPv4 address for its unnumbered g0 to use/);
});

test('IS-IS: an unnumbered circuit through a switch (no cable between the routers) — the adjacency forms over the bridged segment, routes and packets go through it', () => {
  const s = new S.Simulation(model(`netatlas: 1
title: isis bridged
devices:
  - id: r1
    type: router
    interfaces: [{id: g0, label: unnumbered}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]
    protocols: {isis: {net: 49.0001.0000.0000.0001.00}}
  - id: r2
    type: router
    interfaces: [{id: g0, label: unnumbered}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.2/32}]
    protocols: {isis: {net: 49.0001.0000.0000.0002.00}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: l1, a: "r1:g0", b: "sw:p1"}
  - {id: l2, a: "r2:g0", b: "sw:p2"}
relations:
  - {id: igp, protocol: isis, endpoints: ["r1:g0", "r2:g0"]}
`));
  s.runTo(60000);
  assert.deepEqual(states(s), ['Up', 'Up']);
  const r = s.routeLookup('r1', '10.255.0.2');
  assert.equal(r.kind, 'forward', r.text);
  assert.match(r.text, /out g0/);
  const t = s.sendTest({ from: 'r1', to: '10.255.0.2', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
});

// ---- one-way detection and the periodic database summary (ISO 10589 §8.4.2, §7.3.15.3; RFC 5303)

const CHAIN3 = (() => {
  const R = (n, ifs) => `  - id: r${n}
    type: router
    interfaces: [${ifs}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.${n}/32}]
    protocols: {isis: {net: 49.0001.0000.0000.000${n}.00}}
`;
  return `netatlas: 1
title: isis chain
devices:
${R(1, '{id: a, ip: 10.0.12.1/30}')}${R(2, '{id: a, ip: 10.0.12.2/30}, {id: c, ip: 10.0.23.1/30}')}${R(3, '{id: c, ip: 10.0.23.2/30}')}links:
  - {id: l12, a: "r1:a", b: "r2:a"}
  - {id: l23, a: "r2:c", b: "r3:c"}
relations:
  - {id: i12, protocol: isis, endpoints: ["r1:a", "r2:a"]}
  - {id: i23, protocol: isis, endpoints: ["r2:c", "r3:c"]}
`;
})();
const isisState = (s, dev, peer) => s.sessions(dev, 'isis').find((x) => x.peer === peer).state;

test('IS-IS one-way: r1’s IIHs lost towards r2 — r2 drops the adjacency, r2’s IIHs stop listing r1, r1 goes back to Initializing (not Up while it still hears r2) and installs nothing through it; restored, Up again', () => {
  const s = new S.Simulation(model(CHAIN3));
  s.runTo(60000);
  assert.equal(isisState(s, 'r1', 'r2'), 'Up');
  assert.equal(s.routeLookup('r1', '10.255.0.3').kind, 'forward');
  s.engine.impair = (link, f) => (link === 'l12' && f.msg.protocol === 'isis' && f.msg.type === 'IIH' && f.msg.data.from === 'r1' ? { lose: true } : null);
  s.runTo(110000);
  assert.equal(isisState(s, 'r2', 'r1'), 'Down');
  assert.equal(isisState(s, 'r1', 'r2'), 'Initializing');
  const back = s.events().find((e) => e.t > 60000 && e.kind === 'state' && e.device === 'r1' && e.what === 'Initializing');
  assert.match(back.detail, /r2's IIH no longer lists this system .*one-way/);
  assert.equal(s.routeLookup('r1', '10.255.0.3').kind, 'none', 'nothing through a one-way adjacency');
  s.engine.impair = null;
  s.runTo(160000);
  assert.deepEqual([isisState(s, 'r1', 'r2'), isisState(s, 'r2', 'r1')], ['Up', 'Up']);
  assert.equal(s.routeLookup('r1', '10.255.0.3').kind, 'forward');
});

test('IS-IS database sync is repaired by the periodic CSNPs: r3 joins late and the first CSNP (or the requested LSPs) is lost — the next CSNP brings the request; one CSNP per CSNP interval, a PSNP request only for what is missing', () => {
  for (const lost of ['CSNP', 'LSP']) {
    const s = new S.Simulation(model(CHAIN3));
    s.runTo(1000);
    s.shut('r3', 'c');
    s.runTo(60000);
    let n = 0;
    s.engine.impair = (link, f) => (link === 'l23' && f.msg.protocol === 'isis' && f.msg.type === lost && ++n === 1 ? { lose: true } : null);
    s.noShut('r3', 'c');
    s.runTo(200000);
    assert.ok(n >= 1, lost);
    assert.equal(s.routeLookup('r3', '10.255.0.1').kind, 'forward', `${lost} lost: r3 learns r1's loopback all the same`);
    // the CSNP interval: one per side every 10 s on r1-r2, which is stable — and a PSNP request only when something is missing
    const csnp = s.events().filter((e) => e.kind === 'message' && e.what === 'CSNP' && e.device === 'r1' && e.t > 100000 && e.t <= 200000);
    assert.equal(csnp.length, 10, csnp.map((e) => Math.round(e.t)).join());
    assert.equal(s.events().filter((e) => e.kind === 'message' && e.what === 'PSNP' && /requests/.test(e.detail) && e.device === 'r1' && e.t > 150000).length, 0, 'nothing missing, nothing requested');
  }
});
