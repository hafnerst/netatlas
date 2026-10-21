// First-hop redundancy: what a router recognizes as its group, and when a
// VRRP backup takes over (analysis/sim/proto-other.ts installFhrp).
//
// A received advertisement or Hello is matched by what the protocol carries
// — its group (VRID) in its address family, on the interface it arrived on
// (RFC 5798 §7.1, RFC 2281 §5) — never by the receiver's VRF name: two
// routers whose LAN interfaces are in differently named VRFs are one group,
// and groups reusing a number and a virtual address on two LANs stay apart.
//
// VRRP preemption follows RFC 5798 §6.4.2 / §6.4.3: a Backup accepts an
// advertisement of an equal or higher priority (an equal priority from a
// lower address included — it does not preempt), discards a lower one when
// it preempts and becomes Master when its master down timer (3 × the
// interval + its skew) expires; a Master steps down for a higher priority,
// or an equal one from a higher primary address; the address owner is
// Master at once. Asserted by the states, the timing, which router holds
// the virtual address, the gratuitous ARPs and which router answers the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

/** routers on one LAN: [{p: priority, ip: last octet, vrf}], a host using the virtual address */
const LAN = (proto, rs, x = {}) => `netatlas: 1
title: ${proto}
devices:
${rs
  .map(
    (r, i) => `  - id: r${i + 1}
    type: router
    protocols: {${proto}: {}}
    interfaces: [{id: lan, ip: 10.0.0.${r.ip || i + 2}/24${r.vrf ? ', vrf: ' + r.vrf : ''}, protocols: {${proto}: {group: 1, virtual_ip: ${x.vip || '10.0.0.1'}, priority: ${r.p}}}}]`,
  )
  .join('\n')}
  - {id: h, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.100/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]}
  - {id: sw, type: switch, interfaces: [${rs.map((_, i) => `{id: p${i + 1}, vlans: 1}`).join(', ')}, {id: ph, vlans: 1}]}
links:
${rs.map((_, i) => `  - {id: l${i + 1}, a: "r${i + 1}:lan", b: "sw:p${i + 1}"}`).join('\n')}
  - {id: lh, a: "h:eth0", b: "sw:ph"}
relations:
  - {id: fhrp, protocol: ${proto}, endpoints: [${rs.map((_, i) => `"r${i + 1}:lan"`).join(', ')}]${x.attrs ? ', attrs: ' + x.attrs : ''}}
`;

const sim = (t) => new S.Simulation(model(t));
const state = (s, dev, iface = 'lan') => s.status().find((r) => r.device === dev && r.name.endsWith(`: ${dev}:${iface}`)).state;
/** the routers holding the virtual address on their interface now */
const holders = (s, devs, vip = '10.0.0.1', iface = 'lan') => devs.filter((d) => s.protocols.owns(d, iface).some((v) => v.addr.version && String(v.addr.bytes) === String(load('model/ip.js').parseAddress(vip).bytes)));
/** which router answers the host's ping to an address (the echo reply's sender) */
function answers(s, to = '10.0.0.1', from = 'h') {
  const n = s.events().length;
  const t = s.sendTest({ from, to, kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
  return s
    .events()
    .slice(n)
    .filter((e) => e.kind === 'message' && e.what === 'Echo Reply')
    .map((e) => e.device);
}
const transitions = (s, dev, what, t0) => s.events().filter((e) => e.t >= t0 && e.kind === 'state' && e.device === dev && e.what === what);
const garps = (s, dev, t0) => s.events().filter((e) => e.t >= t0 && e.kind === 'message' && e.device === dev && e.what === 'Gratuitous ARP' && /00:00:5e:00:01:01|00:00:0c:07:ac:01/.test(e.detail));

// ------------------------------------------------------------------ group identity

for (const proto of ['vrrp', 'hsrp']) {
  const [hi, lo] = proto === 'vrrp' ? ['Master', 'Backup'] : ['Active', 'Standby'];
  test(`${proto.toUpperCase()}: routers whose LAN interfaces are in differently named VRFs are one group — one ${hi}, the other ${lo}, one holder; the ${lo} takes over when the ${hi} fails`, () => {
    const s = sim(LAN(proto, [{ p: 120, vrf: 'red' }, { p: 110, vrf: 'blue' }]));
    s.runTo(60000);
    assert.deepEqual([state(s, 'r1'), state(s, 'r2')], [hi, lo]);
    assert.deepEqual(holders(s, ['r1', 'r2']), ['r1'], 'one holder of the virtual address');
    assert.deepEqual(answers(s), ['r1'], 'the host reaches it');
    const t0 = s.now;
    s.powerOff('r1');
    s.runTo(t0 + 30000);
    assert.equal(state(s, 'r2'), hi);
    assert.ok(garps(s, 'r2', t0).length >= 1, `the new ${hi} announces the address`);
    assert.deepEqual(answers(s), ['r2']);
  });
}

test('VRRP in IPv6 across differently named VRFs: one Master, advertisements from the link-local address to ff02::12, hop limit 255, the virtual address in 16 bytes; the host reaches the Master', () => {
  const t = LAN('vrrp', [{ p: 120, vrf: 'red' }, { p: 110, vrf: 'blue' }], { vip: '2001:db8::1' })
    .replace(/ip: 10\.0\.0\.(\d+)\/24/g, 'ip: 2001:db8::$1/64')
    .replace(', routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]', '');
  const s = sim(t);
  s.runTo(30000);
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Backup']);
  const ad = s
    .events()
    .filter((e) => e.kind === 'message' && e.protocol === 'vrrp')
    .pop();
  assert.equal(ad.device, 'r1');
  assert.match(ad.hdr.l3[0].src, /^fe80::/, 'RFC 5798 §5.1.2.1: the link-local address');
  assert.deepEqual([ad.hdr.l3[0].dst, ad.hdr.l3[0].ttl, ad.hdr.l3[0].len, ad.hdr.l2.src], ['ff02::12', 255, 40 + 8 + 16, '00:00:5e:00:02:01']);
  assert.deepEqual(answers(s, '2001:db8::1'), ['r1']);
});

test('one router, two LANs reusing group 1 and 10.0.0.1 (in two VRFs): each LAN elects its own Master; a failure on one LAN leaves the other as it was', () => {
  const t = `netatlas: 1
title: two LANs
devices:
  - id: r1
    type: router
    protocols: {vrrp: {}}
    interfaces:
      - {id: lan1, ip: 10.0.0.2/24, vrf: a, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 120}}}
      - {id: lan2, ip: 10.0.0.2/24, vrf: b, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 110}}}
  - id: r2
    type: router
    protocols: {vrrp: {}}
    interfaces:
      - {id: lan1, ip: 10.0.0.3/24, vrf: a, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 110}}}
      - {id: lan2, ip: 10.0.0.3/24, vrf: b, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1, priority: 120}}}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.100/24}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.100/24}]}
  - {id: sw1, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: ph, vlans: 1}]}
  - {id: sw2, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: ph, vlans: 1}]}
links:
  - {id: a1, a: "r1:lan1", b: "sw1:p1"}
  - {id: a2, a: "r2:lan1", b: "sw1:p2"}
  - {id: ah, a: "h1:eth0", b: "sw1:ph"}
  - {id: b1, a: "r1:lan2", b: "sw2:p1"}
  - {id: b2, a: "r2:lan2", b: "sw2:p2"}
  - {id: bh, a: "h2:eth0", b: "sw2:ph"}
relations:
  - {id: g-a, protocol: vrrp, endpoints: ["r1:lan1", "r2:lan1"]}
  - {id: g-b, protocol: vrrp, endpoints: ["r1:lan2", "r2:lan2"]}
`;
  const s = sim(t);
  s.runTo(30000);
  assert.deepEqual([state(s, 'r1', 'lan1'), state(s, 'r2', 'lan1'), state(s, 'r1', 'lan2'), state(s, 'r2', 'lan2')], ['Master', 'Backup', 'Backup', 'Master']);
  assert.deepEqual(holders(s, ['r1', 'r2'], '10.0.0.1', 'lan1'), ['r1']);
  assert.deepEqual(holders(s, ['r1', 'r2'], '10.0.0.1', 'lan2'), ['r2']);
  assert.deepEqual(answers(s, '10.0.0.1', 'h1'), ['r1']);
  assert.deepEqual(answers(s, '10.0.0.1', 'h2'), ['r2']);
  // LAN b's Master's cable fails: r1 takes over on LAN b only; LAN a is unchanged
  const t0 = s.now;
  s.fail('link:b2');
  s.runTo(t0 + 10000);
  assert.deepEqual([state(s, 'r1', 'lan1'), state(s, 'r2', 'lan1'), state(s, 'r1', 'lan2')], ['Master', 'Backup', 'Master']);
  assert.equal(transitions(s, 'r1', 'Master', t0).length, 1, 'one transition, on LAN b');
  assert.deepEqual(answers(s, '10.0.0.1', 'h2'), ['r1']);
  assert.deepEqual(answers(s, '10.0.0.1', 'h1'), ['r1']);
  // restored: r2 (120) preempts on LAN b again after its master down interval; LAN a still unchanged
  s.restore('link:b2');
  s.runTo(s.now + 15000);
  assert.deepEqual([state(s, 'r1', 'lan1'), state(s, 'r1', 'lan2'), state(s, 'r2', 'lan2')], ['Master', 'Backup', 'Master']);
  assert.deepEqual(answers(s, '10.0.0.1', 'h2'), ['r2']);
});

test('a different virtual address under the same group is logged (VRRP: RFC 5798 §7.1, not discarded) — one group, one Master', () => {
  const t = LAN('vrrp', [{ p: 120 }, { p: 110 }]).replace(/virtual_ip: 10\.0\.0\.1, priority: 110/, 'virtual_ip: 10.0.0.9, priority: 110');
  const s = sim(t);
  s.runTo(20000);
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Backup']);
  assert.ok(s.events().some((e) => e.device === 'r2' && /names virtual address 10\.0\.0\.1, here 10\.0\.0\.9 — a misconfiguration, logged/.test(e.detail)));
});

// ------------------------------------------------------------------ VRRP preemption (RFC 5798 §6.4.2, §6.4.3)

/** r1 Master alone; r2 (its priority, its address) returns; what happens after */
function returning(r1, r2, attrs) {
  const s = sim(LAN('vrrp', [r1, r2], { attrs }));
  s.runTo(2000);
  s.shut('r2', 'lan');
  s.runTo(20000);
  assert.equal(state(s, 'r1'), 'Master');
  const t0 = s.now;
  s.noShut('r2', 'lan');
  s.runTo(t0 + 20000);
  return { s, t0 };
}

test('VRRP: an equal-priority Backup with a higher address returns — it stays Backup (an equal priority is accepted, §6.4.2); the Master keeps the address, no gratuitous ARP from the Backup', () => {
  const { s, t0 } = returning({ p: 100, ip: 2 }, { p: 100, ip: 3 });
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Backup']);
  assert.equal(transitions(s, 'r2', 'Master', t0).length, 0);
  assert.equal(garps(s, 'r2', t0).length, 0);
  assert.deepEqual(holders(s, ['r1', 'r2']), ['r1']);
  assert.deepEqual(answers(s), ['r1']);
});

test('VRRP: a higher-priority Backup returns — it discards the lower advertisements and becomes Master when its master down interval expires (3 × 1 s + (256 − 120) / 256 s), not at the first advertisement; the old Master steps down', () => {
  const { s, t0 } = returning({ p: 100 }, { p: 120 });
  const up = transitions(s, 'r2', 'Backup', t0)[0].t;
  const took = transitions(s, 'r2', 'Master', t0);
  assert.equal(took.length, 1);
  assert.ok(Math.abs(took[0].t - up - (3000 + Math.round((136 / 256) * 1000))) < 1, `after the master down interval: ${took[0].t - up} ms`);
  const discarded = s.events().filter((e) => e.t >= up && e.t < took[0].t && e.kind === 'drop' && e.device === 'r2' && /discards r1's advertisement with priority 100/.test(e.detail));
  assert.ok(discarded.length >= 3, `r1's advertisements discarded meanwhile (${discarded.length})`);
  assert.match(took[0].detail, /preempts r1 \(priority 120 > 100\)/);
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Backup', 'Master']);
  assert.equal(garps(s, 'r2', t0).length, 1);
  assert.deepEqual(holders(s, ['r1', 'r2']), ['r2']);
  assert.deepEqual(answers(s), ['r2']);
});

test('VRRP: a lower-priority Backup returns — it stays Backup; with preemption off a higher-priority one does too', () => {
  let { s } = returning({ p: 120 }, { p: 100, ip: 3 });
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Backup']);
  ({ s } = returning({ p: 100 }, { p: 120 }, '{preempt: false}'));
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Backup']);
  assert.deepEqual(answers(s), ['r1']);
});

test('VRRP: the address owner returns — Master at once (priority 255, §6.4.1); the Master steps down at its first advertisement', () => {
  const { s, t0 } = returning({ p: 200 }, { p: 100, ip: 1 });
  const m = transitions(s, 'r2', 'Master', t0);
  const up = s.events().find((e) => e.t >= t0 && e.kind === 'link' && e.device === 'r2' && /has carrier/.test(e.detail));
  assert.equal(m.length, 1);
  assert.equal(m[0].t, up.t, 'at once, when its interface came up');
  assert.equal(transitions(s, 'r2', 'Backup', t0).length, 0, 'never Backup');
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Backup', 'Master']);
  assert.deepEqual(holders(s, ['r1', 'r2']), ['r2']);
});

test('VRRP: two Masters after a partition heals — the lower priority steps down at the other’s first advertisement (§6.4.3), the higher stays Master; on equal priorities the higher address stays', () => {
  for (const [r1, r2, keep] of [
    [{ p: 120 }, { p: 110 }, 'r1'],
    [{ p: 100, ip: 2 }, { p: 100, ip: 3 }, 'r2'],
  ]) {
    // r2 behind a second switch: the cable between the switches partitions the LAN, both routers' interfaces stay up
    const t = LAN('vrrp', [r1, r2])
      .replace('  - {id: h,', '  - {id: sw2, type: switch, interfaces: [{id: p2, vlans: 1}, {id: up, vlans: 1}]}\n  - {id: h,')
      .replace('b: "sw:p2"}', 'b: "sw2:p2"}\n  - {id: trunk, a: "sw2:up", b: "sw:p2"}');
    const s = sim(t);
    s.runTo(20000);
    const other = keep === 'r1' ? 'r2' : 'r1';
    s.fail('link:trunk');
    s.runTo(s.now + 10000);
    assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Master', 'Master'], 'partitioned: both');
    const t0 = s.now;
    s.restore('link:trunk');
    s.runTo(t0 + 5000);
    assert.equal(state(s, keep), 'Master');
    assert.equal(state(s, other), 'Backup');
    const down = transitions(s, other, 'Backup', t0);
    assert.equal(down.length, 1);
    const healed = s.events().find((e) => e.t >= t0 && e.kind === 'link' && /has carrier again/.test(e.detail)).t;
    const first = s.events().find((e) => e.t >= healed && e.kind === 'message' && e.device === keep && e.what === 'Advertisement').t;
    assert.ok(down[0].t > first && down[0].t - first < 5, `at the first advertisement after the heal (${down[0].t - first} ms after it)`);
    assert.equal(transitions(s, keep, 'Backup', t0).length, 0, 'the better one never steps down');
    assert.deepEqual(holders(s, ['r1', 'r2']), [keep]);
    assert.deepEqual(answers(s), [keep]);
  }
});

test('VRRP: lost advertisements — the Backup becomes Master exactly one master down interval after the last one it heard', () => {
  const s = sim(LAN('vrrp', [{ p: 120 }, { p: 110 }]));
  s.runTo(20000);
  const t0 = s.now;
  s.fail('link:l1');
  s.runTo(t0 + 10000);
  const last = s
    .events()
    .filter((e) => e.t <= t0 && e.kind === 'message' && e.device === 'r1' && e.what === 'Advertisement')
    .pop();
  const took = transitions(s, 'r2', 'Master', t0)[0];
  const down = 3000 + Math.round((146 / 256) * 1000);
  // heard one hop after it was sent
  assert.ok(took.t - last.t >= down && took.t - last.t <= down + 5, `${took.t - last.t} ms after the last advertisement (master down ${down} ms)`);
});

// ------------------------------------------------------------------ headers as sent, each protocol its own way

test('every protocol: the TTL / hop limit, port and group the text names are the ones in the packet sent (GLBP: TTL 255, not the text’s former TTL 1)', () => {
  for (const proto of ['vrrp', 'hsrp', 'glbp', 'carp']) {
    const s = sim(LAN(proto, [{ p: 120 }, { p: 110 }]));
    s.runTo(40000);
    const sent = s.events().filter((e) => e.kind === 'message' && e.protocol === proto && e.hdr);
    assert.ok(sent.length > 3, proto);
    for (const e of sent) {
      const l3 = e.hdr.l3[0];
      assert.ok(e.detail.includes(`TTL ${l3.ttl}`), `${proto}: ${e.detail} — sent with TTL ${l3.ttl}`);
      assert.ok(e.detail.includes(`to ${l3.dst} `), `${proto}: ${e.detail}`);
      if (e.hdr.l4 && e.hdr.l4.dport) assert.ok(e.detail.includes(`UDP ${e.hdr.l4.dport}`), `${proto}: ${e.detail}`);
    }
    assert.equal(sent[0].hdr.l3[0].ttl, proto === 'hsrp' ? 1 : 255, proto);
  }
});

test('HSRP version 2 where version 1 can’t carry it: group 300 to 224.0.0.102 with the virtual MAC 0000.0c9f.f12c; in IPv6 UDP 2029 to ff02::66 from the link-local address, the virtual MAC 0005.73a0.0001 — the host reaches the Active', () => {
  let s = sim(LAN('hsrp', [{ p: 120 }, { p: 110 }]).replace(/group: 1,/g, 'group: 300,'));
  s.runTo(60000);
  let a = s.events().filter((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Hello').pop();
  assert.deepEqual([a.hdr.l3[0].dst, a.hdr.l3[0].ttl, a.hdr.l4.dport, a.hdr.l2.src], ['224.0.0.102', 1, 1985, '00:00:0c:9f:f1:2c']);
  assert.match(a.detail, /^HSRP version 2 Hello: group 300/);
  assert.deepEqual(answers(s), ['r1']);
  const t = LAN('hsrp', [{ p: 120 }, { p: 110 }], { vip: '2001:db8::1' })
    .replace(/ip: 10\.0\.0\.(\d+)\/24/g, 'ip: 2001:db8::$1/64')
    .replace(', routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]', '');
  s = sim(t);
  s.runTo(60000);
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')], ['Active', 'Standby']);
  a = s.events().filter((e) => e.kind === 'message' && e.device === 'r1' && e.what === 'Hello').pop();
  assert.match(a.hdr.l3[0].src, /^fe80::/);
  assert.deepEqual([a.hdr.l3[0].dst, a.hdr.l4.dport, a.hdr.l2.src], ['ff02::66', 2029, '00:05:73:a0:00:01']);
  assert.deepEqual(answers(s, '2001:db8::1'), ['r1']);
});

test('HSRP keeps its own rule (RFC 2281 §5.1: an equal priority is decided by the higher address): with preempt, a returning equal-priority router with the higher address takes over with a Coup — unlike VRRP', () => {
  const s = sim(LAN('hsrp', [{ p: 100, ip: 2 }, { p: 100, ip: 3 }], { attrs: '{preempt: true}' }));
  s.runTo(2000);
  s.shut('r2', 'lan');
  s.runTo(60000);
  assert.equal(state(s, 'r1'), 'Active');
  const t0 = s.now;
  s.noShut('r2', 'lan');
  s.runTo(t0 + 60000);
  assert.deepEqual([state(s, 'r1'), state(s, 'r2')].sort(), ['Active', 'Standby'].sort());
  assert.equal(state(s, 'r2'), 'Active');
  assert.ok(s.events().some((e) => e.t >= t0 && e.kind === 'message' && e.device === 'r2' && e.what === 'Coup'));
  assert.deepEqual(answers(s), ['r2']);
});
