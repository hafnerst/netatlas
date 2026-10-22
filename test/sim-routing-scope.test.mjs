// What a router learns stays within the routing instance that brought it
// (analysis/sim/protocols.ts): a database per protocol and VRF, filled
// only by that protocol's own advertisements, flooded only over its own
// sessions; and taken only when the protocol's state machine allows it
// (OSPF from Exchange on, BGP in Established …). Asserted by the routes
// each router installs, the sessions' states and what was delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

/** r1 — r2 on one cable, OSPF and eBGP between them; r2's loopback is advertised by BGP only (OSPF: the link only). */
const PAIR = `netatlas: 1
title: ospf and bgp
devices:
  - id: r1
    type: router
    router_id: 10.1.1.1
    interfaces: [{id: g0, ip: 10.0.12.1/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.1.1.1/32}]
    protocols: {ospf: {advertise: [10.0.12.0/30]}, bgp: {asn: 65001, advertise: [10.1.1.1/32]}}
  - id: r2
    type: router
    router_id: 10.9.9.9
    interfaces: [{id: g0, ip: 10.0.12.2/30}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.9.9.9/32}]
    protocols: {ospf: {advertise: [10.0.12.0/30]}, bgp: {asn: 65002, advertise: [10.9.9.9/32]}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: igp, protocol: ospf, endpoints: ["r1:g0", "r2:g0"]}
  - {id: peering, protocol: ebgp, endpoints: ["r1:g0", "r2:g0"]}
`;

const state = (s, dev, protocol) => s.sessions(dev, protocol).map((x) => x.state);

test('BGP UPDATEs blocked, OSPF working: OSPF’s floods never make BGP’s routes appear; once an UPDATE arrives, they do', () => {
  const s = new S.Simulation(model(PAIR));
  // every BGP UPDATE from r2 is lost on the cable (the transport retransmits it, in vain)
  let blocked = 0;
  s.engine.impair = (link, f) => {
    if (link === 'l1' && f.msg.protocol === 'bgp' && f.msg.type === 'UPDATE' && f.ip && f.ip.src.version === 4 && f.msg.data && f.msg.data.from === 'r2') {
      blocked++;
      return { lose: true };
    }
    return null;
  };
  s.runTo(90000);
  assert.ok(blocked > 0, 'UPDATEs were sent and lost');
  assert.deepEqual(state(s, 'r1', 'ospf'), ['Full']);
  assert.deepEqual(state(s, 'r1', 'bgp'), ['Established'], 'the session is up: KEEPALIVEs pass');
  // r1 learned r2's OSPF record (LSUs passed) — and nothing of BGP from it
  assert.ok(s.events().some((e) => e.kind === 'route' && e.device === 'r1' && e.protocol === 'ospf' && /learned from r2/.test(e.detail)));
  assert.equal(s.events().filter((e) => e.kind === 'route' && e.device === 'r1' && e.protocol === 'bgp' && /learned from r2/.test(e.detail)).length, 0);
  assert.equal(s.routeLookup('r1', '10.9.9.9').kind, 'none', s.routeLookup('r1', '10.9.9.9').text);
  // r2 got r1's UPDATE: its route to r1's loopback is BGP's
  assert.equal(s.routeLookup('r2', '10.1.1.1').kind, 'forward');
  // the UPDATEs pass again: the next one (the transport's retransmission) brings the route
  s.engine.impair = null;
  s.runTo(s.now + 150000);
  assert.equal(s.routeLookup('r1', '10.9.9.9').kind, 'forward', s.routeLookup('r1', '10.9.9.9').text);
});

test('the same model without the loss: r1 has its BGP route to r2’s loopback (the scenario above is the loss, nothing else)', () => {
  const s = new S.Simulation(model(PAIR));
  s.runTo(90000);
  assert.equal(s.routeLookup('r1', '10.9.9.9').kind, 'forward', s.routeLookup('r1', '10.9.9.9').text);
});

test('learning follows the state machine: an UPDATE arriving after the session went down teaches nothing', () => {
  const s = new S.Simulation(model(PAIR));
  s.runTo(90000);
  const P = s.protocols;
  const r1 = P.sessions && Array.from(P.sessions.values()).find((x) => x.dev === 'r1' && x.protocol === 'bgp');
  assert.ok(r1, 'r1’s BGP session');
  // a late UPDATE with a newer record of r2 (one more adjacency) while r1's session is not Established
  const rec = { origin: 'r2', inst: P.instanceOf(r1), seq: 999, at: s.now, adj: ['peering|r1', 'other|r9'], up: ['g0', 'lo0'] };
  r1.state = 'Idle';
  const n = s.events().length;
  P.learn(r1, { protocol: 'bgp', type: 'UPDATE', label: 'BGP UPDATE', detail: '', data: { db: [rec] } });
  const after = s.events().slice(n);
  assert.ok(after.some((e) => e.kind === 'drop' && /takes nothing from r2's UPDATE in state Idle/.test(e.detail)), after.map((e) => e.detail).join('\n'));
  assert.ok(!after.some((e) => e.kind === 'route'));
  // another instance's record is not taken by BGP either (an OSPF record in a BGP UPDATE)
  r1.state = 'Established';
  P.learn(r1, { protocol: 'bgp', type: 'UPDATE', label: 'BGP UPDATE', detail: '', data: { db: [{ ...rec, inst: 'ospf|' }] } });
  assert.ok(!s.events().slice(n).some((e) => e.kind === 'route'));
  // a stale record (an older sequence number) changes nothing
  const known = P.viewOf('r1').find((x) => x.origin === 'r2' && x.inst === P.instanceOf(r1));
  P.learn(r1, { protocol: 'bgp', type: 'UPDATE', label: 'BGP UPDATE', detail: '', data: { db: [{ ...known, seq: known.seq - 1, adj: [] }] } });
  assert.deepEqual(P.viewOf('r1').find((x) => x.origin === 'r2' && x.inst === P.instanceOf(r1)).adj, known.adj);
});

test('a route keeps what its own protocol last said: r2’s loopback goes down while BGP UPDATEs are lost — OSPF’s newer record of r2 does not withdraw the BGP route', () => {
  const s = new S.Simulation(model(PAIR));
  s.runTo(90000);
  assert.equal(s.routeLookup('r1', '10.9.9.9').kind, 'forward', 'learned by BGP first');
  // from now on r2's BGP UPDATEs are lost; OSPF's LSUs pass
  let blocked = 0;
  s.engine.impair = (link, f) => {
    if (link === 'l1' && f.msg.protocol === 'bgp' && f.msg.type === 'UPDATE' && f.msg.data && f.msg.data.from === 'r2') {
      blocked++;
      return { lose: true };
    }
    return null;
  };
  const ospfBefore = s.events().filter((e) => e.kind === 'route' && e.device === 'r1' && e.protocol === 'ospf' && /learned from r2/.test(e.detail)).length;
  assert.ok(s.shut('r2', 'lo0'));
  s.runTo(s.now + 60000);
  assert.ok(blocked > 0, 'r2 sent its UPDATE (lost)');
  // r1 learned r2's newer OSPF record (lo0 down) …
  assert.ok(s.events().filter((e) => e.kind === 'route' && e.device === 'r1' && e.protocol === 'ospf' && /learned from r2/.test(e.detail)).length > ospfBefore, 'an OSPF LSU from r2 arrived');
  const P = s.protocols;
  const ospfRec = P.viewOf('r1').find((x) => x.origin === 'r2' && x.inst.startsWith('ospf|'));
  const bgpRec = P.viewOf('r1').find((x) => x.origin === 'r2' && x.inst.startsWith('bgp|'));
  assert.ok(ospfRec.up.indexOf('lo0') < 0 && bgpRec.up.indexOf('lo0') >= 0, 'OSPF says lo0 down, BGP still up');
  assert.ok(ospfRec.at > bgpRec.at, 'the OSPF record is the newer one');
  // … and its BGP route stays what BGP last advertised (nothing of BGP said otherwise)
  const l = s.routeLookup('r1', '10.9.9.9');
  assert.equal(l.kind, 'forward', l.text);
  // the UPDATEs pass again: BGP's withdrawal arrives with the transport's retransmission, and the route goes
  s.engine.impair = null;
  s.runTo(s.now + 150000);
  assert.equal(s.routeLookup('r1', '10.9.9.9').kind, 'none', s.routeLookup('r1', '10.9.9.9').text);
});

test('a VRF name is the router’s own: routers whose OSPF runs in differently named VRFs learn each other’s routes (the session decides, not the name)', () => {
  const s = new S.Simulation(model(`netatlas: 1
title: vrf names
devices:
  - id: r1
    type: router
    router_id: 10.1.1.1
    interfaces: [{id: g0, ip: 10.0.12.1/30, vrf: red}, {id: g1, ip: 10.1.0.1/24, vrf: red}]
    protocols: {ospf: {}}
  - id: r2
    type: router
    router_id: 10.9.9.9
    interfaces: [{id: g0, ip: 10.0.12.2/30, vrf: blue}, {id: g1, ip: 10.9.0.1/24, vrf: blue}]
    protocols: {ospf: {}}
links:
  - {id: l1, a: "r1:g0", b: "r2:g0"}
relations:
  - {id: igp, protocol: ospf, endpoints: ["r1:g0", "r2:g0"]}
`));
  s.runTo(90000);
  assert.deepEqual(state(s, 'r1', 'ospf'), ['Full']);
  const P = s.protocols;
  assert.ok(P.viewOf('r1').some((x) => x.origin === 'r2' && x.inst === 'ospf|blue'), 'r2’s record (its own instance name) held in r1’s red instance');
  const l = s.routeLookup('r1', '10.9.0.1', 'red');
  assert.equal(l.kind, 'forward', l.text);
});
