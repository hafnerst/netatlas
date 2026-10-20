// First-hop redundancy, each protocol its own way (analysis/sim/proto-other.ts
// installFhrp): HSRP elects an Active and a Standby that both send Hellos
// (UDP 1985, TTL 1) while the others Listen, the Standby takes over, a new
// Standby comes from the listeners, preemption only when configured (Coup,
// Resign); VRRP's master alone advertises (IP 112, TTL 255, only TTL 255
// taken), its address owner is master at once with priority 255.
// Asserted by states, the headers as sent and which router holds the
// virtual address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const LAN = (proto, prios, x = {}) => `netatlas: 1
title: ${proto}
devices:
${prios
  .map(
    (p, i) => `  - id: r${i + 1}
    type: router
    protocols: {${proto}: {}}
    interfaces: [{id: lan, ip: 10.0.0.${i + 2}/24, protocols: {${proto}: {group: 1, virtual_ip: ${x.vip || '10.0.0.1'}, priority: ${p}}}}]`,
  )
  .join('\n')}
  - {id: h, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.100/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: sw, type: switch, interfaces: [${prios.map((_, i) => `{id: p${i + 1}, vlans: 1}`).join(', ')}, {id: ph, vlans: 1}]}
links:
${prios.map((_, i) => `  - {id: l${i + 1}, a: "r${i + 1}:lan", b: "sw:p${i + 1}"}`).join('\n')}
  - {id: lh, a: "h:eth0", b: "sw:ph"}
relations:
  - {id: fhrp, protocol: ${proto}, endpoints: [${prios.map((_, i) => `"r${i + 1}:lan"`).join(', ')}]${x.attrs ? ', attrs: ' + x.attrs : ''}}
`;

const sim = (t) => new S.Simulation(model(t));
const state = (s, dev) => s.status().find((r) => r.device === dev && /^group 1/.test(r.name)).state;
const hellos = (s, dev, t0) => s.events().filter((e) => e.kind === 'message' && e.device === dev && e.what === 'Hello' && e.t >= t0);

test('HSRP: one Active and one Standby, both saying hello (UDP 1985, TTL 1); the third router Listens silently', () => {
  const s = sim(LAN('hsrp', [120, 110, 100]));
  s.runTo(60000);
  assert.deepEqual(['r1', 'r2', 'r3'].map((d) => state(s, d)), ['Active', 'Standby', 'Listen']);
  const t0 = s.now;
  s.runTo(t0 + 15000);
  assert.ok(hellos(s, 'r1', t0).length >= 4 && hellos(s, 'r2', t0).length >= 4, 'the Active and the Standby say hello');
  assert.equal(hellos(s, 'r3', t0).length, 0, 'a listening router is silent');
  const h = hellos(s, 'r1', t0)[0].hdr;
  assert.deepEqual([h.l3[0].dst, h.l3[0].ttl, h.l4.proto, h.l4.dport], ['224.0.0.2', 1, 'udp', 1985]);
  assert.equal(h.l2.src, '00:00:0c:07:ac:01', 'the Active sends from the virtual MAC');
  assert.notEqual(hellos(s, 'r2', t0)[0].hdr.l2.src, '00:00:0c:07:ac:01', 'the Standby from its own');
  // the host's gateway answers: the Active holds the address
  const t = s.sendTest({ from: 'h', to: '10.0.0.1', kind: 'icmp' });
  s.runTo(s.now + 2000);
  assert.equal(t.ok, true, t.result);
});

test('HSRP: the Active fails — the Standby takes over after the hold time, the listener becomes Standby; no preemption when it returns (the default)', () => {
  const s = sim(LAN('hsrp', [120, 110, 100]));
  s.runTo(60000);
  const t0 = s.now;
  s.powerOff('r1');
  s.runTo(t0 + 40000);
  assert.deepEqual(['r2', 'r3'].map((d) => state(s, d)), ['Active', 'Standby']);
  const took = s.events().find((e) => e.t >= t0 && e.kind === 'state' && e.device === 'r2' && e.what === 'Active');
  assert.ok(took.t - t0 >= 9000 && took.t - t0 <= 14000, `after the hold time (${took.t - t0} ms)`);
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'state' && e.device === 'r3' && e.what === 'Speak'), 'the listener speaks first');
  // r1 back: it stays out of the Active role (no preempt)
  s.powerOn('r1');
  s.runTo(s.now + 120000);
  assert.equal(state(s, 'r2'), 'Active');
  assert.notEqual(state(s, 'r1'), 'Active');
});

test('HSRP with preempt: the returning higher-priority router takes over with a Coup; the old Active resigns', () => {
  const s = sim(LAN('hsrp', [120, 110], { attrs: '{preempt: true}' }));
  s.runTo(60000);
  assert.equal(state(s, 'r1'), 'Active');
  s.powerOff('r1');
  s.runTo(s.now + 30000);
  assert.equal(state(s, 'r2'), 'Active');
  const t0 = s.now;
  s.powerOn('r1');
  s.runTo(t0 + 150000);
  assert.equal(state(s, 'r1'), 'Active');
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'message' && e.device === 'r1' && e.what === 'Coup'));
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'message' && e.device === 'r2' && e.what === 'Resign'));
});

test('VRRP: the master alone advertises (IP 112, TTL 255); the address owner is master at once with priority 255; an advertisement with another TTL is discarded', () => {
  // r1 owns 10.0.0.2 (its own address): priority 255
  const s = sim(LAN('vrrp', [100, 200], { vip: '10.0.0.2' }));
  s.runTo(4000);
  assert.equal(state(s, 'r1'), 'Master', 'the owner: master without waiting');
  assert.ok(s.status().find((r) => r.device === 'r1' && /^group 1/.test(r.name)).detail.startsWith('priority 255 (address owner)'));
  s.runTo(30000);
  assert.equal(state(s, 'r2'), 'Backup', 'priority 200 does not outrank the owner');
  const ads = s.events().filter((e) => e.kind === 'message' && e.what === 'Advertisement');
  assert.ok(ads.length > 5 && ads.every((e) => e.device === 'r1'), 'the master alone');
  const h = ads[ads.length - 1].hdr;
  assert.deepEqual([h.l3[0].dst, h.l3[0].ttl, h.l4.num, h.l2.src], ['224.0.0.18', 255, 112, '00:00:5e:00:01:01']);
  // an advertisement that crossed a router (TTL 254) is not taken
  const P = s.protocols;
  const ip = load('model/ip.js');
  const n = s.events().length;
  const pkt = s.engine.newPacket(ip.parseAddress('10.0.0.9'), ip.parseAddress('224.0.0.18'), '', { protocol: 'vrrp', type: 'Advertisement', label: 'VRRP Advertisement', detail: '', data: { from: 'rx', key: 'vrrp||1|10.0.0.2', prio: 254, ip: '10.0.0.9' } }, [], 254);
  P.handlers.get('vrrp')('r2', s.engine.net.devices.get('r2').l3.get('lan'), pkt.msg, pkt);
  assert.ok(s.events().slice(n).some((e) => e.kind === 'drop' && /with TTL 254 \(RFC 5798 §7\.1: only TTL 255\)/.test(e.detail)));
});
