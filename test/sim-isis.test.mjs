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
