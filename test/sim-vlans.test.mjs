// Port VLANs in the simulation: access ports send and take untagged frames,
// trunks tag every VLAN but the native one (the packet inspector shows the
// tag), a VLAN interface is reached through any bridge port of its VLAN and
// the MAC tables learn per VLAN; ARP on the VLAN interface and routing
// between VLANs; routed ports act at Layer 3; a VLAN a port doesn't allow
// is dropped and a native mismatch leaks, both explained in the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const sim = (text) => new S.Simulation(model(text));
const ev = (s, f) => s.events().filter(f);
const run = (s, t, ms = 3000) => {
  s.sendTest(t);
  s.runTo(s.now + ms);
  const all = s.tests();
  return all[all.length - 1];
};

// access switch sw (h1 in VLAN 10, h2 in VLAN 20, a trunk uplink with native VLAN 10) and a Layer 3 core:
// its VLAN interfaces route between the VLANs; h3 reaches Vlan10 through another access port; a routed uplink to r
const NET = (o = {}) => `netatlas: 1
title: vlans
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.20/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.30/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 20}, {id: up, vlans: [10, 20], native: 10}]
  - id: core
    type: switch
    layer3: true
    interfaces: [{id: down, vlans: ${o.core || '[10, 20], native: 10'}}, {id: p5, vlans: 10}, {id: wan, routed: true, ip: 10.9.0.1/30}]
    logical_interfaces:
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.1/24}
      - {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24}
  - {id: r, type: router, interfaces: [{id: g0, ip: 10.9.0.2/30}], routes: [{prefix: 10.0.0.0/8, via: 10.9.0.1}]}
networks:
  - {id: n10, cidr: 10.1.0.0/24, vlan: 10}
  - {id: n20, cidr: 10.2.0.0/24, vlan: 20}
links:
  - {id: a1, a: "h1:eth0", b: "sw:p1"}
  - {id: a2, a: "h2:eth0", b: "sw:p2"}
  - {id: tr, a: "sw:up", b: "core:down"}
  - {id: a3, a: "h3:eth0", b: "core:p5"}
  - {id: w, a: "core:wan", b: "r:g0"}
`;

test('access ports untagged, trunks tagged except the native VLAN; inter-VLAN routing on the VLAN interfaces', () => {
  const s = sim(NET());
  s.runTo(2500);
  assert.equal(run(s, { from: 'h1', to: 'h2', kind: 'icmp' }).result, 'Echo Reply from 10.2.0.20');
  const echo = (link) => s.engine.flights.filter((f) => f.track.ref === 'link:' + link && /^ICMP Echo → /.test(f.label) && f.hdr);
  // h1's request: untagged on its access port and on the trunk (VLAN 10 is native); routed into VLAN 20: tagged 20 on the trunk, untagged to h2
  assert.ok(echo('a1').length && echo('a1').every((f) => f.hdr.l2.vlan === null));
  assert.deepEqual(echo('tr').map((f) => f.hdr.l2.vlan), [null, 20]);
  assert.ok(echo('a2').every((f) => f.hdr.l2.vlan === null));
  // routed: TTL down by one at the core
  const toH2 = echo('a2')[0];
  assert.equal(toH2.hdr.l3[0].ttl, 63);
});

test('a VLAN interface is reached through any of its bridge ports; ARP on it; the MAC tables learn per VLAN', () => {
  const s = sim(NET());
  s.runTo(2500);
  assert.equal(run(s, { from: 'h3', to: '10.1.0.1', kind: 'icmp' }).result, 'Echo Reply from 10.1.0.1', 'through the access port p5');
  assert.equal(run(s, { from: 'h1', to: '10.1.0.1', kind: 'icmp' }).result, 'Echo Reply from 10.1.0.1', 'through the trunk');
  assert.ok(s.engine.flights.some((f) => f.protocol === 'arp' && /who has 10\.1\.0\.1\?/.test(f.label)));
  run(s, { from: 'h1', to: 'h2', kind: 'icmp' });
  const table = s.macTable('core');
  const own = table.filter((r) => /^CPU \(Vlan(10|20)\)$/.test(r.port)).map((r) => r.vlan).sort();
  assert.deepEqual(own, [10, 20], 'its VLAN interfaces, each in its VLAN');
  const learned = table.filter((r) => r.type === 'dynamic');
  assert.ok(learned.some((r) => r.vlan === 10 && r.port === 'down') && learned.some((r) => r.vlan === 20 && r.port === 'down') && learned.some((r) => r.vlan === 10 && r.port === 'p5'), JSON.stringify(learned));
  // on the access switch: h1 in VLAN 10 at p1, h2 in VLAN 20 at p2
  const sw = s.macTable('sw').filter((r) => r.type === 'dynamic');
  assert.ok(sw.some((r) => r.vlan === 10 && r.port === 'p1') && sw.some((r) => r.vlan === 20 && r.port === 'p2'), JSON.stringify(sw));
});

test('a routed port acts at Layer 3: its frames have no VLAN', () => {
  const s = sim(NET());
  s.runTo(2500);
  assert.equal(run(s, { from: 'h1', to: '10.9.0.2', kind: 'icmp' }).result, 'Echo Reply from 10.9.0.2');
  const f = s.engine.flights.filter((x) => x.track.ref === 'link:w' && x.hdr);
  assert.ok(f.length && f.every((x) => x.hdr.l2.vlan === null));
  assert.ok(!s.macTable('core').some((r) => r.port === 'wan'), 'not a bridge port');
});

test('a VLAN the port does not allow is dropped, and the log says which VLANs the port has', () => {
  const s = sim(NET({ core: '10' }));
  s.runTo(2500);
  assert.match(run(s, { from: 'h2', to: '10.2.0.1', kind: 'icmp' }, 10000).result, /does not answer ARP/);
  const drops = ev(s, (e) => e.kind === 'drop' && /VLAN 20 is not allowed on the port/.test(e.detail));
  assert.ok(drops.length, s.events().filter((e) => e.kind === 'drop').map((e) => e.detail).join('\n'));
  assert.match(drops[0].detail, /^dropped at core:down: VLAN 20 is not allowed on the port \(access port, VLAN 10\) \(ARP Request \(broadcast\): who has 10\.2\.0\.1\?\)$/);
});

test('a native VLAN mismatch leaks frames between the VLANs, and the log explains it', () => {
  const s = sim(NET({ core: '[10, 20], native: 20' }));
  s.runTo(2500);
  run(s, { from: 'h1', to: 'h2', kind: 'icmp' });
  const leaks = ev(s, (e) => e.what === 'VLAN mismatch');
  assert.ok(leaks.length);
  assert.match(leaks[0].detail, /left sw:up untagged in VLAN 10 and arrives untagged in VLAN 20 — it leaks from VLAN 10 into VLAN 20 \(the native or access VLANs of the two ports differ\)|left core:down untagged in VLAN 20 and arrives untagged in VLAN 10 — it leaks from VLAN 20 into VLAN 10/);
});

test('spanning tree runs per bridge port: a second trunk between the switches is blocked, a routed port is not part of it', () => {
  const s = sim(NET().replace('{id: up, vlans: [10, 20], native: 10}]', '{id: up, vlans: [10, 20], native: 10}, {id: up2, vlans: [10, 20], native: 10}]').replace('{id: wan, routed: true', '{id: down2, vlans: [10, 20], native: 10}, {id: wan, routed: true').replace('  - {id: a3,', '  - {id: tr2, a: "sw:up2", b: "core:down2"}\n  - {id: a3,'));
  s.runTo(2500);
  const t = s.engine.tree(10);
  assert.equal(t.blocked.size, 1, JSON.stringify([...t.blocked]));
  assert.ok(!Array.from(t.blocked).some((k) => /wan/.test(k)));
  assert.equal(run(s, { from: 'h1', to: 'h2', kind: 'icmp' }).result, 'Echo Reply from 10.2.0.20');
});
