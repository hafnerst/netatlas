// IPv6 host configuration in the simulation (analysis/sim/ipv6.ts): link-local addresses with duplicate
// address detection, router solicitation and advertisement, SLAAC with its lifetimes and the two-hour
// rule, default routers and their expiry, RDNSS, stateful and stateless DHCPv6 with renewal, rebinding
// and expiry, several routers, dual stack, reset on interface failure. Injected clocks, no sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock, errorsOf, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

/** a router r1 advertising on its LAN port, a switch, hosts; a server beyond the router */
const LAN = (o = {}) => `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces:
      - id: lan
        ip: [10.0.0.1/24, 2001:db8:10::1/64]
        ipv6_ra: {prefixes: [2001:db8:10::/64]${o.ra || ''}}
      - {id: wan, ip: 2001:db8:99::1/64}
${o.r2 || ''}  - id: sw
    type: switch
    igmp_mld_snooping: {1: enabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]
  - id: pc
    type: endpoint
    interfaces:
      - {id: eth0, ipv6: ${o.method || 'slaac'}${o.pc || ''}}
  - id: pc2
    type: endpoint
    interfaces:
      - {id: eth0, ipv4: dhcp, ipv6: slaac}
  - id: srv
    type: server
${o.srv || ''}    interfaces:
      - {id: eth0, ip: 2001:db8:99::10/64}
    routes: [{prefix: "::/0", via: "2001:db8:99::1"}]
links:
  - {id: l1, a: "r1:lan", b: "sw:p1"}
  - {id: l2, a: "sw:p2", b: "pc:eth0"}
  - {id: l3, a: "sw:p3", b: "pc2:eth0"}
  - {id: l4, a: "r1:wan", b: "srv:eth0"}
${o.links || ''}`;

const sim = (text) => withClock(new S.Simulation(model(text)));
const settle = (s, ms) => s.runTo(s.now + ms);
const host = (s, dev, iface = 'eth0') => s.ipv6.hosts.get(dev + ':' + iface);
const formatted = (a) => a.sa.text;
const addrsOf = (s, dev, iface = 'eth0') => s.engine.net.devices.get(dev).l3.get(iface).addrs.map((a) => a.text);

test('the format: methods, advertisements only on a router’s routing interface, explicit prefixes, /64 for SLAAC, no DHCPv6 gateway', () => {
  assert.deepEqual(errorsOf(LAN()), []);
  assert.ok(errorsOf(LAN({ method: 'auto' })).some((e) => /"auto" is not an IPv6 method/.test(e.message)));
  assert.ok(errorsOf(LAN().replace('ipv6_ra: {prefixes: [2001:db8:10::/64]}', 'ipv6_ra: {}')).some((e) => /need the prefixes they advertise: none is chosen for them/.test(e.message)));
  assert.ok(errorsOf(LAN().replace('ipv6_ra: {prefixes: [2001:db8:10::/64]}', 'ipv6_ra: {prefixes: [2001:db8:10::/56]}')).some((e) => /SLAAC forms addresses in \/64 prefixes only/.test(e.message)));
  assert.deepEqual(errorsOf(LAN().replace('ipv6_ra: {prefixes: [2001:db8:10::/64]}', 'ipv6_ra: {prefixes: [2001:db8:10::/56], autonomous: false, managed: true}')), []);
  assert.ok(errorsOf(LAN().replace('      - {id: eth0, ipv4: dhcp, ipv6: slaac}', '      - {id: eth0, ipv4: dhcp, ipv6: slaac, ipv6_ra: {prefixes: [2001:db8:10::/64]}}')).some((e) => /router advertisements are a router’s: "pc2" routes nothing/.test(e.message)));
  assert.ok(errorsOf(LAN({ method: 'static' })).some((e) => /has no IPv6 address to be static with/.test(e.message)));
  assert.ok(errorsOf(LAN().replace('ipv6_ra: {prefixes: [2001:db8:10::/64]}', 'ipv6_ra: {prefixes: [2001:db8:10::/64], preferred_lifetime: 2h, valid_lifetime: 1h}')).some((e) => /the preferred lifetime is longer than the valid lifetime/.test(e.message)));
  // DHCPv6: no gateway option, a stateless scope needs its DNS servers
  const v6scope = (x) => LAN({ srv: `    services:\n      dhcp:\n        scopes:\n          - {network: v6lan${x}}\n` }) + 'networks:\n  - {id: v6lan, cidr: "2001:db8:99::/64"}\n';
  assert.ok(errorsOf(v6scope(', range: 2001:db8:99::100-2001:db8:99::1ff, gateway: 2001:db8:99::1')).some((e) => /DHCPv6 gives no default gateway — hosts learn their default router from router advertisements/.test(e.message)));
  assert.ok(errorsOf(v6scope('')).some((e) => /as a stateless DHCPv6 server it needs the DNS servers it gives/.test(e.message)));
  assert.deepEqual(errorsOf(v6scope(', dns: ["2001:db8:99::53"]')), []);
  // static IPv6 with written addresses is the default; nothing automatic is assumed
  const m = model(LAN());
  assert.equal(m.index.interfaces.get('srv:eth0').ipv6, 'static');
  assert.equal(m.index.interfaces.get('r1:lan').ra.prefixes[0], '2001:db8:10::/64');
});

test('SLAAC: link-local address after DAD, Router Solicitation, Router Advertisement, an address after its own DAD, a default router; reachable beyond the router', () => {
  const s = sim(LAN());
  settle(s, 3500);
  const h = host(s, 'pc');
  assert.ok(h.ll, 'a link-local address (once the link is up: its link-up delay)');
  assert.match(h.ll.sa.text, /^fe80::/);
  // nothing usable before DAD is done
  assert.ok(!addrsOf(s, 'pc').some((a) => a.indexOf('2001:db8:10:') === 0));
  settle(s, 10000);
  const ev = s.events();
  assert.ok(ev.some((e) => e.what === 'Router Solicitation' && e.device === 'pc'));
  assert.ok(ev.some((e) => e.what === 'Router Advertisement' && e.device === 'r1'));
  assert.ok(ev.some((e) => /NDP NS DAD|duplicate address detection: is/.test(e.detail) && e.device === 'pc'), 'DAD probes');
  const a = addrsOf(s, 'pc');
  assert.ok(a.some((x) => /^2001:db8:10:[0-9a-f:]+\/64$/.test(x)), a.join(', '));
  assert.equal(h.routers.size, 1);
  assert.match(s.ipv6.status('pc', 'eth0'), /^2001:db8:10:[0-9a-f:]+ \(SLAAC\)$/);
  const t = s.sendTest({ from: 'pc', to: '2001:db8:99::10', kind: 'icmp' });
  settle(s, 5000);
  assert.equal(t.ok, true, t.result);
  // the default route goes to the router's link-local address
  const tab = s.ipv6.table('pc');
  assert.ok(tab.notes.some((n) => /default router r1 \(fe80::/.test(n)), tab.notes.join('\n'));
});

test('a dual-stack host: its IPv4 DHCP lease and its IPv6 SLAAC address side by side, each family on its own', () => {
  const s = sim(LAN({ srv: '    services:\n      dhcp:\n        scopes:\n          - {network: lan4, range: 10.0.0.100-10.0.0.110, gateway: 10.0.0.1, dns: [10.0.0.53]}\n' }).replace('      - {id: eth0, ip: 2001:db8:99::10/64}', '      - {id: eth0, ip: [2001:db8:99::10/64, 10.0.0.53/24]}').replace('  - {id: l4, a: "r1:wan", b: "srv:eth0"}', '  - {id: l4, a: "sw:p4", b: "srv:eth0"}') + 'networks:\n  - {id: lan4, cidr: 10.0.0.0/24}\n');
  settle(s, 15000);
  const a = addrsOf(s, 'pc2');
  assert.ok(a.some((x) => /^10\.0\.0\.1\d\d\/24$/.test(x)), a.join(', '));
  assert.ok(a.some((x) => /^2001:db8:10:/.test(x)), a.join(', '));
});

test('lifetimes: the address is deprecated after its preferred lifetime, gone after its valid one; the router expires without advertisements; the two-hour rule', () => {
  const s = sim(LAN({ ra: ', preferred_lifetime: 20s, valid_lifetime: 40s, router_lifetime: 30s, interval: 10s' }));
  settle(s, 8000);
  const h = host(s, 'pc');
  const a = h.addrs[0];
  assert.equal(a.state, 'preferred');
  // the router goes quiet: shut its LAN port
  s.shut('r1', 'lan');
  settle(s, 20000);
  assert.equal(a.state, 'deprecated');
  assert.match(s.ipv6.status('pc', 'eth0'), /Address deprecated|No default router/);
  settle(s, 15000);
  assert.equal(h.routers.size, 0, 'the router lifetime is over');
  settle(s, 10000);
  assert.ok(!h.addrs.includes(a), 'its valid lifetime is over');
  assert.ok(s.events().some((e) => /is no longer a default router: no advertisement within its router lifetime/.test(e.detail)));
  assert.ok(s.events().some((e) => /is deprecated \(its preferred lifetime ended\)/.test(e.detail)));
  // two-hour rule (RFC 4862 §5.5.3 e): a short valid lifetime does not cut a long-lived address below two hours
  const s2 = sim(LAN({ ra: ', interval: 10s' }));
  settle(s2, 8000);
  const b = host(s2, 'pc').addrs[0];
  const r = s2.ipv6.routers.get('r1:lan');
  r.ra.validLifetime = 60000;
  r.ra.preferredLifetime = 30000;
  settle(s2, 25000);
  assert.ok(b.validUntil - s2.now > 7000 * 1000 - 30000, 'kept at two hours, not cut to 60 s');
});

test('duplicate address detection: a node that has the address answers, the newcomer’s address is a duplicate and never used', () => {
  // pc forms 2001:db8:10::ff:fe00:1 from its MAC 02:00:00:00:00:01 (modified EUI-64); the squatter has it written
  const text = LAN({ pc: ', mac: "02:00:00:00:00:01"', r2: '  - id: squatter\n    type: endpoint\n    interfaces: [{id: eth0, ip: "2001:db8:10::ff:fe00:1/64"}]\n', links: '  - {id: l5, a: "sw:p5", b: "squatter:eth0"}\n' });
  const s = sim(text);
  settle(s, 10000);
  const h = host(s, 'pc');
  assert.equal(formatted(h.addrs[0]), '2001:db8:10::ff:fe00:1/64');
  assert.equal(h.addrs[0].state, 'duplicate');
  assert.equal(s.ipv6.status('pc', 'eth0'), 'Duplicate address 2001:db8:10::ff:fe00:1');
  assert.ok(!addrsOf(s, 'pc').some((a) => a.indexOf('2001:db8:10:') === 0), 'not used');
  assert.ok(s.events().some((e) => e.device === 'squatter' && /it defends its address/.test(e.detail)));
});

test('stateful DHCPv6: Solicit, Advertise, Request, Reply; DAD of the /128; renewal at T1, rebinding at T2, expiry; the default router from the advertisements', () => {
  const text = LAN({ method: 'dhcpv6', ra: ', managed: true, autonomous: false', r2: `  - id: dhcp6
    type: server
    services:
      dhcp:
        scopes:
          - {network: lan6, range: 2001:db8:10::100-2001:db8:10::1ff, dns: ["2001:db8:10::53"], lease: 60s}
    interfaces: [{id: eth0, ip: 2001:db8:10::5/64}]
`, links: '  - {id: l5, a: "sw:p5", b: "dhcp6:eth0"}\n' }) + 'networks:\n  - {id: lan6, cidr: "2001:db8:10::/64"}\n';
  const s = sim(text);
  settle(s, 10000);
  const h = host(s, 'pc');
  const types = s.events().filter((e) => e.protocol === 'dhcpv6').map((e) => e.what);
  for (const t of ['Solicit', 'Advertise', 'Request', 'Reply']) assert.ok(types.includes(t), `${t} in ${types.join(', ')}`);
  assert.equal(h.dhcp.state, 'BOUND');
  assert.ok(addrsOf(s, 'pc').some((a) => a === '2001:db8:10::100/128'), addrsOf(s, 'pc').join(', '));
  assert.equal(h.addrs.length, 0, 'no SLAAC address: the prefix is not autonomous and the method is dhcpv6');
  assert.equal(h.routers.size, 1, 'the default router from the advertisement, not from DHCPv6');
  assert.ok(Array.from(h.dns.keys()).includes('2001:db8:10::53'));
  settle(s, 30000);
  assert.ok(s.events().some((e) => e.what === 'Renew' && e.device === 'pc'), 'Renew at T1 (half the preferred lifetime)');
  // the server goes away: Rebind at T2, then the address goes at its valid lifetime
  s.powerOff('dhcp6');
  settle(s, 60000);
  assert.ok(s.events().some((e) => e.what === 'Rebind' && e.device === 'pc'));
  assert.ok(!addrsOf(s, 'pc').some((a) => a === '2001:db8:10::100/128'), 'expired');
  assert.match(s.ipv6.status('pc', 'eth0'), /DHCPv6 pending/);
});

test('stateless DHCPv6: a SLAAC host asks for DNS when the router sets the other-configuration flag; RDNSS too', () => {
  const text = LAN({ ra: ', other: true, dns: ["2001:db8:10::54"]', r2: `  - id: dhcp6
    type: server
    services:
      dhcp:
        scopes:
          - {network: lan6, dns: ["2001:db8:10::53"]}
    interfaces: [{id: eth0, ip: 2001:db8:10::5/64}]
`, links: '  - {id: l5, a: "sw:p5", b: "dhcp6:eth0"}\n' }) + 'networks:\n  - {id: lan6, cidr: "2001:db8:10::/64"}\n';
  const s = sim(text);
  settle(s, 12000);
  const h = host(s, 'pc');
  assert.ok(s.events().some((e) => e.what === 'Information-request' && e.device === 'pc'));
  assert.equal(h.info.state, 'INFORMED');
  assert.deepEqual(Array.from(h.dns.keys()).sort(), ['2001:db8:10::53', '2001:db8:10::54']);
  assert.deepEqual(s.netsvc.dnsServers('pc').map((x) => x.bytes.length), [16, 16], 'the resolver asks them');
});

test('two routers: an address in each advertised prefix; the default route via one router; losing it leaves the other', () => {
  const text = LAN({ r2: `  - id: r2
    type: router
    interfaces:
      - {id: lan, ip: 2001:db8:20::1/64, ipv6_ra: {prefixes: [2001:db8:20::/64], router_lifetime: 30s, interval: 10s}}
`, links: '  - {id: l5, a: "sw:p5", b: "r2:lan"}\n' }).replace('ipv6_ra: {prefixes: [2001:db8:10::/64]}', 'ipv6_ra: {prefixes: [2001:db8:10::/64], router_lifetime: 30s, interval: 10s}');
  const s = sim(text);
  settle(s, 10000);
  const h = host(s, 'pc');
  assert.equal(h.routers.size, 2);
  const a = addrsOf(s, 'pc');
  assert.ok(a.some((x) => x.indexOf('2001:db8:10:') === 0) && a.some((x) => x.indexOf('2001:db8:20:') === 0), a.join(', '));
  s.powerOff('r1');
  settle(s, 40000);
  assert.equal(h.routers.size, 1);
  assert.equal(Array.from(h.routers.values())[0].dev, 'r2');
});

test('interface down: what it learned is gone at once, its timers do nothing; up again it starts over', () => {
  const s = sim(LAN());
  settle(s, 10000);
  const h = host(s, 'pc');
  assert.ok(h.addrs.length);
  s.shut('pc', 'eth0');
  settle(s, 2000);
  assert.equal(h.addrs.length, 0);
  assert.equal(h.routers.size, 0);
  assert.equal(h.ll, undefined);
  assert.ok(!addrsOf(s, 'pc').some((a) => a.indexOf('2001:db8:10:') === 0));
  s.noShut('pc', 'eth0');
  settle(s, 15000);
  assert.ok(host(s, 'pc').addrs.some((x) => x.state === 'preferred'), 'learned again');
});

test('an application over IPv6 uses the SLAAC address; before it exists the message says so (no fallback to IPv4)', () => {
  const text = LAN({ pc: '' , srv: '    services:\n      applications:\n        - {id: web, name: Web, profile: tcp_server, port: 443}\n' }).replace('  - id: pc\n    type: endpoint\n    interfaces:', '  - id: pc\n    type: endpoint\n    services:\n      applications:\n        - {id: get, name: Get, profile: tcp_client, peer: srv/web, ip_version: "6"}\n    interfaces:');
  const s = sim(text);
  settle(s, 500);
  const early = s.actApp('pc', 'get');
  settle(s, 5000);
  const v0 = s.actions().find((v) => v.id === early.id);
  assert.match(v0.details.join('\n'), /no IPv6 address to send from/);
  settle(s, 10000);
  const late = s.actApp('pc', 'get');
  settle(s, 5000);
  assert.equal(s.actions().find((v) => v.id === late.id).summary, '1 answered');
});

test('private-house.yaml: Internal is dual-stack: the laptop and the phone form SLAAC addresses in fd00:10::/64 beside their IPv4 leases', () => {
  const s = withClock(new S.Simulation(model(example('private-house.yaml'))));
  s.runTo(20000);
  for (const d of ['laptop', 'phone']) assert.match(s.ipv6.status(d, 'wlan0'), /^fd00:10:[0-9a-f:]+ \(SLAAC\)$/, d);
  // its SLAAC address (ready before the DHCP lease) releases no IPv4 test: they wait for the lease, then go
  assert.ok(!s.events().some((e) => e.device === 'laptop' && /has no IPv4 address to send from/.test(e.detail || '')), 'no IPv4 test sent before the lease');
  assert.ok(s.status().some((x) => x.name === 'laptop → 203.0.113.80 tcp/443' && x.state === 'Answered'));
  assert.ok(s.status().some((x) => x.name === 'laptop → nas.home.arpa tcp/445' && x.state === 'Answered'));
});
