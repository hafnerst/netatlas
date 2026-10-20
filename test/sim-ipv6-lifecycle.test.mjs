// The IPv6 interface lifecycle (analysis/sim/ipv6.ts): static IPv6
// addresses alone enable IPv6 on an interface — its link-local address
// (written fe80:: one, else from the MAC), tentative until duplicate
// address detection passes, without router advertisements or
// autoconfiguration — and the link-local address is interface-scoped:
// a link-local next hop is resolved on its interface, the same link-local
// address on two links is two neighbours, a duplicate on one link is
// detected. Shutdown, reboot and recovery start it over. Checked by the
// addresses' states (the analysis snapshot's too) and by delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);

/** a — r — b, static IPv6 only; r's interfaces with the written link-local addresses `ll0` / `ll1`; a and b route via fe80::1 out of eth0. */
const NET = (o = {}) => `netatlas: 1
title: v6
devices:
  - {id: a, type: endpoint, interfaces: [{id: eth0, ip: [2001:db8:1::10/64${o.a || ''}]}], routes: [{prefix: ::/0, via: fe80::1, interface: eth0}]}
  - id: r
    type: router
    interfaces:
      - {id: g0, ip: [2001:db8:1::1/64${o.ll0 === undefined ? ', fe80::1/64' : o.ll0}]}
      - {id: g1, ip: [2001:db8:2::1/64${o.ll1 === undefined ? ', fe80::1/64' : o.ll1}]}
  - {id: b, type: server, interfaces: [{id: eth0, ip: [2001:db8:2::10/64]}], routes: [{prefix: ::/0, via: fe80::1, interface: eth0}]}
links:
  - {id: l1, a: "a:eth0", b: "r:g0"}
  - {id: l2, a: "r:g1", b: "b:eth0"}
`;
const snapLl = (s, dev, iface) => s.snapshot().addresses.filter((x) => x.device === dev && x.iface === iface && x.method === 'link-local');

test('static IPv6 alone: every interface gets its link-local address (tentative, then preferred by DAD) — no RA, no SLAAC', () => {
  const s = sim(NET());
  s.runTo(2100);
  const t = snapLl(s, 'a', 'eth0');
  assert.equal(t.length, 1);
  assert.equal(t[0].state, 'tentative');
  assert.match(t[0].text, /^fe80::/);
  s.runTo(6000);
  assert.deepEqual(snapLl(s, 'a', 'eth0').map((x) => x.state), ['preferred']);
  // r's are the written ones
  assert.deepEqual([snapLl(s, 'r', 'g0')[0].text, snapLl(s, 'r', 'g1')[0].text], ['fe80::1', 'fe80::1']);
  assert.ok(s.events().some((e) => e.device === 'r' && /link-local address fe80::1\/64 \(written in the model\) is tentative .*its static IPv6 addresses enable IPv6 on it/.test(e.detail)));
  // no router advertisement anywhere
  assert.ok(!s.events().some((e) => e.what === 'Router Advertisement'));
});

test('a link-local next hop is resolved on its interface; the same link-local address on two links is two neighbours', () => {
  const s = sim(NET());
  s.runTo(6000);
  const ab = s.sendTest({ from: 'a', to: '2001:db8:2::10', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(ab.ok, true, ab.result);
  const ba = s.sendTest({ from: 'b', to: '2001:db8:1::10', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(ba.ok, true, ba.result);
  // each host has fe80::1 in its neighbour table, on its own interface, with r's MAC of that interface
  const na = s.ndTable('a').find((x) => x.ip === 'fe80::1');
  const nb = s.ndTable('b').find((x) => x.ip === 'fe80::1');
  assert.ok(na && nb);
  assert.notEqual(na.mac, nb.mac, 'two interfaces of r, two MACs');
  // and no duplicate was detected: the two fe80::1 are on different links
  assert.ok(!s.events().some((e) => e.what === 'duplicate address'));
});

test('a duplicate link-local address on one link is detected; that interface’s IPv6 stops', () => {
  const s = sim(NET({ a: ', fe80::1/64' }));
  s.runTo(8000);
  const d = s.events().filter((e) => e.what === 'duplicate address');
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /fe80::1\/64 is a duplicate/);
  assert.ok(['a', 'r'].indexOf(d[0].device) >= 0);
  const st = snapLl(s, d[0].device, d[0].device === 'a' ? 'eth0' : 'g0');
  assert.ok(st.length === 0 || st[0].state === 'duplicate');
});

test('shut, reboot and recovery: the link-local address is gone, then tentative again and preferred after DAD', () => {
  const s = sim(NET());
  s.runTo(6000);
  s.shut('r', 'g0');
  s.runTo(s.now + 500);
  assert.equal(snapLl(s, 'r', 'g0').length, 0);
  s.noShut('r', 'g0');
  s.runTo(s.now + 2100);
  assert.deepEqual(snapLl(s, 'r', 'g0').map((x) => x.state), ['tentative']);
  s.runTo(s.now + 4000);
  assert.deepEqual(snapLl(s, 'r', 'g0').map((x) => x.state), ['preferred']);
  // a reboot: nothing while off; after the boot (60 s) the address again
  s.powerOff('r');
  s.runTo(s.now + 1000);
  assert.equal(snapLl(s, 'r', 'g1').length, 0);
  s.powerOn('r');
  s.runTo(s.now + 70000);
  assert.deepEqual(snapLl(s, 'r', 'g1').map((x) => x.state), ['preferred']);
  const t = s.sendTest({ from: 'a', to: '2001:db8:2::10', kind: 'icmp' });
  s.runTo(s.now + 3000);
  assert.equal(t.ok, true, t.result);
});

/** two hosts and a router on one switch; `dup`: the second host is written with the first one's global address. */
const LAN6 = (o = {}) => `netatlas: 1
title: dad
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: [2001:db8:9::10/64]}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: [${o.dup ? '2001:db8:9::10' : '2001:db8:9::20'}/64]}]${o.h2 || ''}}
  - {id: r, type: router, interfaces: [{id: g0, ip: [2001:db8:9::1/64]}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "h1:eth0", b: "sw:p1"}
  - {id: b, a: "h2:eth0", b: "sw:p2"}
  - {id: c, a: "r:g0", b: "sw:p3"}
`;

test('static IPv6 addresses run duplicate address detection too: tentative (not used) until it passes; a duplicate found on the link is never used', () => {
  // unique: each written address is probed and usable afterwards
  const u = sim(LAN6());
  u.runTo(2100);
  assert.ok(u.events().some((e) => e.kind === 'table' && e.device === 'h1' && e.what === 'static address' && /2001:db8:9::10\/64 \(written\) is tentative/.test(e.detail)));
  u.runTo(5000);
  assert.ok(u.events().some((e) => e.kind === 'message' && e.what === 'Neighbor Solicitation' && /duplicate address detection: is 2001:db8:9::10 in use\?/.test(e.detail)), 'the written address is probed');
  assert.ok(u.events().some((e) => e.kind === 'table' && e.device === 'h1' && e.what === 'DAD passed' && /2001:db8:9::10\/64 \(static\)/.test(e.detail)));
  const ok = u.sendTest({ from: 'h1', to: '2001:db8:9::1', kind: 'icmp' });
  u.runTo(u.now + 2000);
  assert.equal(ok.ok, true, ok.result);
  // a duplicate: h2's cable comes up later; h1 defends its address, h2's copy is a duplicate and never used
  const d = sim(LAN6({ dup: true }));
  d.shut('h2', 'eth0');
  d.runTo(8000);
  d.noShut('h2', 'eth0');
  d.runTo(20000);
  assert.ok(d.events().some((e) => e.kind === 'state' && e.device === 'h2' && e.what === 'duplicate address' && /2001:db8:9::10\/64 is a duplicate/.test(e.detail)), d.events().filter((e) => e.device === 'h2' && e.protocol === 'ndp').map((e) => e.detail).join('\n'));
  assert.ok(!d.events().some((e) => e.kind === 'state' && e.device === 'h1' && e.what === 'duplicate address'), 'the first holder keeps it');
  const t = d.sendTest({ from: 'h2', to: '2001:db8:9::1', kind: 'icmp' });
  d.runTo(d.now + 3000);
  assert.ok(typeof t === 'string' ? /no IPv6 address/.test(t) : t.ok === false && /no IPv6 address/.test(t.result), 'h2 has no usable IPv6 address to send from');
  // the router reaches the address: h1 answers (its NA), never h2
  const r = d.sendTest({ from: 'r', to: '2001:db8:9::10', kind: 'icmp' });
  d.runTo(d.now + 3000);
  assert.equal(r.ok, true, r.result);
  assert.ok(d.events().some((e) => e.kind === 'message' && e.device === 'h1' && e.what === 'Echo Reply' && e.t >= r.started));
  assert.ok(!d.events().some((e) => e.kind === 'message' && e.device === 'h2' && e.what === 'Echo Reply'));
});
