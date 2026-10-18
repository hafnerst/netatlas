// Analysis correctness and integration: VLAN-scoped segments (one
// definition with the simulation), DHCP dependencies with relays, policy
// and listeners, blocked expectations under a failure and their
// enforcement, communication identity across Analyze and Simulate, saved
// experiments, path MTU, routing and network policy, capacity, execution
// scopes and saved views, NTP/PTP source selection. Model-level: the
// behaviour, not the pixels; deterministic (the order of the file never
// matters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, root } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SC = load('analysis/scope.js');
const D = load('analysis/dependencies.js');
const A = load('analysis/addressing.js');
const TI = load('analysis/timing.js');
const N = load('analysis/sim/net.js');
const E = load('analysis/expectations.js');
const W = load('analysis/whatif.js');
const F = load('analysis/failure.js');
const S = load('analysis/sim/simulation.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.equal(r.errors.map((e) => `${e.path}: ${e.message}`).join(' | '), '', 'valid');
  return r.model;
};

// ------------------------------------------------------------------ VLAN scope

// two VLANs on one switch: a DHCP client, a DHCP server (also a PTP grandmaster) and a PTP receiver, a link-local address used in each VLAN;
// a Wi-Fi network per VLAN on an access point, VMs on two port groups of a virtual switch, containers on two networks
const vlans = `netatlas: 1
title: Isolated VLANs on one switch
devices:
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 20}, {id: p3, vlans: 10}, {id: p4, vlans: [10, 20]}, {id: p5, vlans: [10, 20]}]
  - id: c1
    type: endpoint
    interfaces: [{id: eth0, ipv4: dhcp}]
  - id: srv
    type: server
    services:
      dhcp:
        scopes: [{network: v10, range: 10.0.10.100-10.0.10.199, gateway: 10.0.10.1, dns: [10.0.20.5]}]
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}
    interfaces: [{id: eth0, ip: [10.0.20.5/24, "fe80::1/64"]}]
  - id: h1
    type: endpoint
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: receiver_only}
    interfaces: [{id: eth0, ip: [10.0.10.5/24, "fe80::1/64"]}]
  - id: ap
    type: ap
    services:
      wireless:
        networks:
          - {id: staff, ssid: Staff, vlan: 10, radio: wlan0, security: wpa3_enterprise}
          - {id: guest, ssid: Guest, vlan: 20, radio: wlan0, security: wpa3_enterprise}
    interfaces: [{id: up, vlans: [10, 20]}, {id: wlan0}]
  - id: phone
    type: endpoint
    interfaces: [{id: wlan0, ip: "fe80::7/64"}]
  - id: tablet
    type: endpoint
    interfaces: [{id: wlan0, ip: "fe80::7/64"}]
  - id: hv
    type: server
    interfaces: [{id: eth1}]
    services:
      hypervisor:
        platform: kvm
        vswitches:
          - name: vs0
            type: standard
            uplinks: [eth1]
            teaming: active_standby
            port_groups: [{name: pg10, vlans: 10}, {name: pg20, vlans: 20}]
  - id: vm-a
    type: vm
    host: hv
    logical_interfaces: [{id: eth0, type: vnic, port_group: pg10, ip: "fe80::9/64"}]
  - id: vm-b
    type: vm
    host: hv
    logical_interfaces: [{id: eth0, type: vnic, port_group: pg20, ip: "fe80::9/64"}]
links:
  - {id: l1, a: c1:eth0, b: sw:p1}
  - {id: l2, a: srv:eth0, b: sw:p2}
  - {id: l3, a: h1:eth0, b: sw:p3}
  - {id: l4, a: ap:up, b: sw:p4}
  - {id: l5, a: hv:eth1, b: sw:p5}
  - {id: w1, a: ap:wlan0, b: phone:wlan0, medium: wireless, wireless_network: staff}
  - {id: w2, a: ap:wlan0, b: tablet:wlan0, medium: wireless, wireless_network: guest}
networks:
  - {id: v10, cidr: 10.0.10.0/24, vlan: 10}
  - {id: v20, cidr: 10.0.20.0/24, vlan: 20}
`;

test('VLAN scope: isolated VLANs on one switch are separate segments (access ports, Wi-Fi networks, port groups)', () => {
  const m = model(vlans);
  const seg = SC.segmentOf(m, 'c1', 'eth0');
  assert.ok(seg.has('h1:eth0') && seg.has('sw:p1') && seg.has('sw:p3'), 'VLAN 10 on the switch');
  assert.ok(!seg.has('srv:eth0'), 'the server in VLAN 20 is not on the segment of a VLAN 10 client');
  assert.ok(seg.has('phone:wlan0') && !seg.has('tablet:wlan0'), 'the Staff Wi-Fi network is VLAN 10, the Guest one VLAN 20');
  assert.ok(seg.has('vm-a:eth0') && !seg.has('vm-b:eth0'), 'port group pg10 is VLAN 10, pg20 VLAN 20');
  assert.equal(SC.segmentInfo(m, 'c1', 'eth0').vlan, 10, 'the segment says its VLAN');
  // a trunk port names no VLAN context: not known (never every VLAN), unless one is named
  const trunk = SC.segmentInfo(m, 'sw', 'p4');
  assert.equal(trunk.members, null);
  assert.match(trunk.unknown, /trunk of VLANs 10,20.*name the VLAN/);
  assert.ok(SC.segmentOf(m, 'sw', 'p4', 20).has('srv:eth0'), 'the trunk in VLAN 20');
  // a radio with several Wi-Fi networks: not known without a VLAN
  assert.equal(SC.segmentOf(m, 'ap', 'wlan0'), null);
});

test('VLAN scope: one definition with the simulation (the broadcast domain is the same set)', () => {
  const m = model(vlans);
  const net = N.netOf(m);
  const peers = N.broadcastPeers(net, 'c1', 'eth0').map((p) => `${p.dev}:${p.l3.id}`).sort();
  assert.deepEqual(peers, ['h1:eth0', 'phone:wlan0', 'vm-a:eth0']);
  const s = new S.Simulation(m);
  s.runTo(5000);
  const bd = s.broadcastDomain({ dev: 'c1', iface: 'eth0' });
  assert.ok(bd.devices.includes('h1') && !bd.devices.includes('srv') && !bd.devices.includes('tablet') && !bd.devices.includes('vm-b'));
});

test('VLAN scope: no shared address-conflict scope, DHCP provider or PTP source path across isolated VLANs', () => {
  const m = model(vlans);
  // link-local fe80::1 in VLAN 10 and in VLAN 20; fe80::7 on two Wi-Fi networks; fe80::9 on two port groups
  const ov = A.addressingOverview(m);
  assert.deepEqual(ov.duplicates.filter((d) => /^fe80/.test(d.text)).map((d) => d.text), [], 'no conflicts across VLANs');
  // the DHCP server's scope is for VLAN 10's network, but it sits in VLAN 20 with no relay
  const dep = D.serviceDependencies(m).find((d) => d.key === 'dhcp:c1:eth0');
  assert.ok(dep, 'the scope of its network makes it a candidate');
  const st = D.evaluateDependency(m, dep);
  assert.equal(st.verdict, 'violated');
  assert.match(st.text, /not on the broadcast domain of c1:eth0 \(VLAN 10\), and no relay there forwards to it/);
  // a PTP grandmaster in VLAN 20 is no source of a receiver in VLAN 10
  const t = TI.ptpSource(m, 'h1');
  assert.equal(t.verdict, 'violated');
  // the same address twice in one VLAN does conflict
  const same = model(vlans.replace('{id: p2, vlans: 20}', '{id: p2, vlans: 10}').replace('ip: [10.0.20.5/24, "fe80::1/64"]', 'ip: [10.0.10.6/24, "fe80::1/64"]'));
  assert.deepEqual(A.addressingOverview(same).duplicates.filter((d) => d.text === 'fe80::1').map((d) => d.certainty), ['conflict']);
});

// ------------------------------------------------------------------ DHCP

// a client in VLAN 10; r1 and r2 relay to srv; r1's way to the server crosses a firewall that permits HTTPS only, r2's a plain router
const relays = `netatlas: 1
title: DHCP relays
devices:
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 10}]
  - id: c
    type: endpoint
    interfaces: [{id: eth0, ipv4: dhcp}]
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.2/24, dhcp_relay: [10.9.0.10]}, {id: up, ip: 10.0.1.1/30}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.1.2}]
  - id: fw
    type: firewall
    simulation: {allow: "tcp/443"}
    interfaces: [{id: a, ip: 10.0.1.2/30}, {id: b, ip: 10.9.0.2/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]
  - id: r2
    type: router
    interfaces: [{id: lan, ip: 10.1.0.3/24, dhcp_relay: [10.9.0.10]}, {id: up, ip: 10.0.2.1/30}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.2.2}]
  - id: rc
    type: router
    interfaces: [{id: a, ip: 10.0.2.2/30}, {id: b, ip: 10.9.0.1/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]
  - id: s2
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
  - id: srv
    type: server
    services:
      dhcp:
        scopes: [{network: n10, range: 10.1.0.100-10.1.0.199, gateway: 10.1.0.1, dns: [10.9.0.10]}]
    interfaces: [{id: eth0, ip: 10.9.0.10/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.9.0.1}]
  - id: other
    type: server
    services:
      dhcp:
        scopes: [{network: n99, range: 10.99.0.100-10.99.0.199, gateway: 10.99.0.1, dns: [10.9.0.10]}]
    interfaces: [{id: eth0, ip: 10.9.0.20/24}]
links:
  - {id: l-c, a: c:eth0, b: sw:p1}
  - {id: l-r1, a: r1:lan, b: sw:p2}
  - {id: l-r2, a: r2:lan, b: sw:p3}
  - {id: l-r1-fw, a: r1:up, b: fw:a}
  - {id: l-r2-rc, a: r2:up, b: rc:a}
  - {id: l-fw, a: fw:b, b: s2:p1}
  - {id: l-rc, a: rc:b, b: s2:p2}
  - {id: l-srv, a: srv:eth0, b: s2:p3}
  - {id: l-other, a: other:eth0, b: s2:p4}
networks:
  - {id: n10, cidr: 10.1.0.0/24, vlan: 10}
  - {id: n99, cidr: 10.99.0.0/24}
`;

test('DHCP: a relay path that a policy denies is no provider; a second relay is an alternative, with the failed one as evidence', () => {
  // r1 only: its unicast to the server crosses the firewall that permits HTTPS only (a route alone is no proof)
  const one = model(relays.replace('{id: lan, ip: 10.1.0.3/24, dhcp_relay: [10.9.0.10]}', '{id: lan, ip: 10.1.0.3/24}'));
  const dep1 = D.serviceDependencies(one).find((d) => d.key === 'dhcp:c:eth0');
  assert.deepEqual(dep1.options.map((o) => o.provider), ['srv'], 'a reachable server without a scope for the network is no provider');
  const s1 = D.evaluateDependency(one, dep1);
  assert.equal(s1.verdict, 'violated');
  assert.match(s1.text, /the relay r1:lan to srv \(10\.9\.0\.10\): Policy: .*fw/);
  // with r2 too: available through r2, r1's failure kept as evidence of the way that does not work
  const two = model(relays);
  const dep2 = D.serviceDependencies(two).find((d) => d.key === 'dhcp:c:eth0');
  const s2 = D.evaluateDependency(two, dep2);
  assert.equal(s2.verdict, 'satisfied');
  assert.match(s2.text, /the relay r2:lan forwards to srv \(10\.9\.0\.10, scope n10\)/);
  assert.equal(s2.way, '0|relay r2:lan>10.9.0.10');
  // a relay whose server has no scope for the relay's network is no way either
  const noScope = model(relays.replace('{id: lan, ip: 10.1.0.3/24, dhcp_relay: [10.9.0.10]}', '{id: lan, ip: 10.1.0.3/24, dhcp_relay: [10.9.0.20]}').replace('{id: lan, ip: 10.1.0.2/24, dhcp_relay: [10.9.0.10]}', '{id: lan, ip: 10.1.0.2/24}'));
  const dep3 = D.serviceDependencies(noScope).find((d) => d.key === 'dhcp:c:eth0');
  assert.equal(D.evaluateDependency(noScope, dep3).verdict, 'violated');
});

test('DHCP: a failed first relay does not hide a working one, and the change says it is an alternative', () => {
  const m = model(relays.replace('simulation: {allow: "tcp/443"}', 'simulation: {allow: "tcp/443, udp/67"}'));
  const deps = D.serviceDependencies(m);
  const base = D.dependencyBaseline(m, deps);
  assert.match(base.get('dhcp:c:eth0').text, /relay r1:lan/, 'the first relay serves it in the configured model');
  const res = F.simulate(m, ['device:r1']);
  const hit = new Set(Array.from(F.failureRefs(res).keys()));
  const ch = D.compareDependencies(m, deps, base, res.ctx, hit, (d) => res.devices.get(d) === 'down').find((c) => c.dep.key === 'dhcp:c:eth0');
  assert.equal(ch.change, 'alternative');
  assert.match(ch.text, /relay r2:lan/);
});


// ------------------------------------------------------------------ what if: isolation and endpoint state

// pc reaches srv through the firewall (it permits HTTPS, not SSH); a floating static route on r1 takes the way through r2 when the firewall fails
const guard = `netatlas: 1
title: Isolation under failures
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: a, ip: 10.0.1.1/30}, {id: b, ip: 10.0.2.1/30}]
    routes:
      - {prefix: 10.9.0.0/24, via: 10.0.1.2}
      - {prefix: 10.9.0.0/24, via: 10.0.2.2, distance: 200}
  - id: fw
    type: firewall
    simulation: {allow: "tcp/443"}
    interfaces: [{id: a, ip: 10.0.1.2/30}, {id: b, ip: 10.9.0.2/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.2.2/30}, {id: b, ip: 10.9.0.3/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]
  - id: s2
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]
  - id: srv
    type: server
    simulation: {listening: "tcp/22, tcp/443"}
    interfaces: [{id: eth0, ip: 10.9.0.10/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.9.0.2}]
links:
  - {id: l-pc, a: pc:eth0, b: r1:lan}
  - {id: l-fw, a: r1:a, b: fw:a}
  - {id: l-r2, a: r1:b, b: r2:a}
  - {id: l-fw-s, a: fw:b, b: s2:p1}
  - {id: l-r2-s, a: r2:b, b: s2:p2}
  - {id: l-srv, a: srv:eth0, b: s2:p3}
expectations:
  - {id: no-ssh, name: No SSH from the PC to the server, expect: blocked, from: pc, to: srv, service: tcp/22}
  - {id: https, name: The PC reaches the server over HTTPS, expect: available, from: pc, to: srv, service: tcp/443}
`;

test('what if: blocked expectations are compared too; a failure that changes the selected path exposes a forbidden one', () => {
  const m = model(guard);
  const w = W.whatIf(m, ['fw']);
  const by = new Map(w.expectations.map((x) => [x.after.id, x]));
  assert.equal(by.get('no-ssh').before.verdict, 'satisfied', 'the firewall blocks SSH without the failure');
  assert.equal(by.get('no-ssh').change, 'isolation-violated', 'the floating route takes the way around the firewall');
  assert.equal(by.get('https').change, 'alternative', 'HTTPS is kept, through r2');
  assert.deepEqual(w.expectations.map((x) => x.change), ['isolation-violated', 'alternative'], 'what the failure breaks first');
  // a failure that leaves the control in place preserves the isolation
  const keep = W.whatIf(m, ['r2']);
  assert.equal(keep.expectations.find((x) => x.after.id === 'no-ssh').change, 'unchanged');
  // a failure that breaks the required availability
  const cut = W.whatIf(m, ['l-pc']);
  assert.equal(cut.expectations.find((x) => x.after.id === 'https').change, 'availability-lost');
});

test('what if: an endpoint the failure takes down leaves the isolation control unexercised, never proven', () => {
  const m = model(guard);
  const w = W.whatIf(m, ['pc']);
  const ssh = w.expectations.find((x) => x.after.id === 'no-ssh');
  assert.equal(ssh.after.verdict, 'indeterminate');
  assert.equal(ssh.change, 'indeterminate');
  assert.equal(ssh.after.reason, 'Source unavailable under this failure condition (pc is down): no traffic originates, so the isolation control is not exercised');
  assert.deepEqual(ssh.after.unavailable, { end: 'source', what: 'pc' });
  const https = w.expectations.find((x) => x.after.id === 'https');
  assert.equal(https.after.verdict, 'violated');
  assert.equal(https.after.reason, 'Source unavailable under this failure condition (pc is down)');
  assert.equal(https.change, 'availability-lost');
  // the destination too
  const d = W.whatIf(m, ['srv']).expectations.find((x) => x.after.id === 'no-ssh');
  assert.ok(d.after.reason.startsWith('Destination unavailable under this failure condition (srv is down)'), d.after.reason);
  // missing information is not unavailability: an end that names nothing stays indeterminate with its own reason
  const e = E.evaluateExpectation(m, { id: 'x', name: 'x', expect: 'blocked', from: 'nowhere', to: 'srv', failure: ['fw'], line: 0 });
  assert.equal(e.verdict, 'indeterminate');
  assert.ok(!e.unavailable);
});

// ------------------------------------------------------------------ support statements

test('support: one catalog for the manual and docs/SUPPORT.md; no statement contradicts it', () => {
  const SCAT = load('model/support-catalog.js');
  const cat = SCAT.supportCatalog();
  assert.ok(cat.length > 50 && cat.every((e) => e.support.does && e.support.not), 'every entry says what it does and leaves out');
  assert.ok(SCAT.ANALYSIS_SUPPORT.every((a) => a.does && a.not));
  // docs/SUPPORT.md is generated from it
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-support.mjs'), '--check'], { stdio: 'pipe' });
  // DHCPv6 is modeled (on the server's own link): nothing may say DHCP is IPv4 only
  const dhcp = cat.find((e) => e.id === 'dhcp');
  assert.match(dhcp.support.does, /DHCPv6/);
  const texts = [readFileSync(join(root, 'docs', 'LIMITATIONS.md'), 'utf8'), readFileSync(join(root, 'docs', 'FORMAT.md'), 'utf8'), readFileSync(join(root, 'src', 'ui', 'help.ts'), 'utf8')];
  for (const t of texts) {
    assert.ok(!/IPv4 only for DHCP|DHCP is IPv4 only|\(no DHCPv6\)/.test(t), 'no "DHCP is IPv4 only"');
    assert.ok(!/NAT only for container bridges|NAT is modelled for container bridges and the NAT\s+service only/.test(t), 'NAT is described per workflow');
    assert.ok(!/VLAN separation on one switch is not taken into account/.test(t), 'the VLAN-scoped segment is not denied');
  }
});

// ------------------------------------------------------------------ communication identity

const I = load('analysis/comm-identity.js');
const C = load('analysis/communication.js');
const ex = (name) => model(readFileSync(join(root, 'test', 'examples', name), 'utf8'));

// a dual-stack host with two interfaces, a router, a server whose application listens on eth0 (bound), a DHCP client
const dual = `netatlas: 1
title: Dual-stack identity
devices:
  - id: h1
    type: endpoint
    interfaces:
      - {id: eth0, ip: [10.0.0.10/24, "2001:db8::10/64"]}
      - {id: eth1, ip: 10.0.1.10/24}
    routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}, {prefix: "::/0", via: "2001:db8::1"}]
  - id: r
    type: router
    interfaces:
      - {id: a, ip: [10.0.0.1/24, "2001:db8::1/64"]}
      - {id: b, ip: [10.9.0.1/24, "2001:db8:9::1/64"]}
      - {id: c, ip: 10.0.1.1/24}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: [10.9.0.10/24, "2001:db8:9::10/64"]}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}, {prefix: "::/0", via: "2001:db8:9::1"}]
    services:
      applications:
        - {id: api, name: API, profile: tcp_server, port: 8443, bind: eth0}
  - id: dh
    type: endpoint
    interfaces: [{id: eth0, ipv4: dhcp}]
links:
  - {id: l1, a: h1:eth0, b: r:a}
  - {id: l2, a: srv:eth0, b: r:b}
  - {id: l3, a: h1:eth1, b: r:c}
`;

test('identity: the check’s own choices (source interface, family, destination, port) are what the handoff carries', () => {
  const m = model(dual);
  const c = C.checkCommunication(m, { from: 'h1:eth0', to: 'srv/api', family: 6 });
  assert.equal(c.verdict, 'satisfied', c.headline);
  const id = I.commIdentity(m, c);
  assert.deepEqual([id.source.device, id.source.iface, id.source.address, id.family], ['h1', 'eth0', '2001:db8::10', 6]);
  assert.deepEqual([id.destination.device, id.destination.iface, id.destination.address, id.destination.binding, id.destination.app], ['srv', 'eth0', '2001:db8:9::10', 'interface', 'srv/api']);
  assert.deepEqual(id.service, { proto: 'tcp', port: 8443 });
  const h = I.handoffOf(m, id);
  assert.deepEqual(h.prefill, { from: 'h1', kind: 'tcp', via: 'eth0', port: 8443, to: 'srv', toIface: 'eth0', toAddr: '2001:db8:9::10' }, 'nothing chosen again');
  // the family asked for decides; an address of the other family is a contradiction, said so
  assert.equal(I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth0', to: 'srv/api', family: 4 })).destination.address, '10.9.0.10');
  assert.match(C.checkCommunication(m, { from: 'h1', to: '10.9.0.10', family: 6 }).error, /Destination: 10\.9\.0\.10 is an IPv4 address, not IPv6/);
  // a VRF the simulation can't take for a send is said, not dropped silently
  const v = I.handoffOf(m, I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth0', to: 'srv/api', vrf: '' })));
  assert.ok(!v.notTransferred.some((t) => /^VRF/.test(t)), 'the source interface’s own VRF is carried as it is');
  const blue = I.handoffOf(m, I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth0', to: 'srv/api', vrf: 'blue' })));
  assert.ok(blue.notTransferred.some((t) => /^VRF: the simulation sends in the VRF of h1:eth0 \(the default table\); the VRF chosen here \(blue\)/.test(t)), blue.notTransferred.join(' | '));
});

test('identity: a written address is that exact address, a device or interface follows its effective address (a lease too), a name is resolved when sent', () => {
  const m = model(dual);
  const fixed = I.handoffOf(m, I.commIdentity(m, C.checkCommunication(m, { from: 'h1', to: '10.9.0.10', service: 'tcp/8443' })));
  assert.equal(fixed.prefill.target, '10.9.0.10');
  assert.equal(fixed.prefill.to, undefined);
  const lease = I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth1', to: 'dh' }));
  assert.equal(lease.destination.binding, 'interface');
  assert.match(lease.destination.note, /dh:eth0 takes its address at runtime/);
  const lp = I.handoffOf(m, lease).prefill;
  assert.deepEqual([lp.to, lp.toIface, lp.toAddr], ['dh', 'eth0', 'dhcp'], 'its lease when the message is sent');
  // the source a lease gives: the interface, never an address picked by the analysis
  const camp = ex('campus-services.yaml');
  const src = I.commIdentity(camp, C.checkCommunication(camp, { from: 'pc2', to: 'web', service: 'tcp/443' }));
  assert.deepEqual([src.source.iface, src.source.address], ['eth0', undefined]);
  assert.equal(I.handoffOf(camp, src).prefill.via, 'eth0');
  // a host name is resolved when sent
  const byName = I.commIdentity(camp, C.checkCommunication(camp, { from: 'pc1', to: 'www.campus.example', service: 'tcp/443' }));
  assert.equal(byName.destination.binding, 'name');
  assert.equal(I.handoffOf(camp, byName).prefill.target, 'www.campus.example');
  // a client application is started with its own configuration
  const app = model(dual.replace('        - {id: api, name: API, profile: tcp_server, port: 8443, bind: eth0}', '        - {id: api, name: API, profile: tcp_server, port: 8443, bind: eth0}\n  - id: cl\n    type: endpoint\n    interfaces: [{id: eth0, ip: 10.0.0.30/24}]\n    routes: [{prefix: 0.0.0.0/0, via: 10.0.0.1}]\n    services:\n      applications:\n        - {id: poll, name: Poll, profile: tcp_client, peer: srv/api}'));
  const ha = I.handoffOf(app, I.commIdentity(app, C.checkCommunication(app, { from: 'cl/poll' })));
  assert.deepEqual([ha.kind, ha.device, ha.app], ['app', 'cl', 'poll']);
});

test('identity: a stale reference stops the handoff; a saved expectation takes the fields without entering them again', () => {
  const m = model(dual);
  const id = I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth0', to: 'srv/api' }));
  assert.equal(I.staleProblem(m, id), null);
  const renamed = model(dual.split('srv').join('server2'));
  assert.match(I.staleProblem(renamed, id), /^The destination srv is not in the model the simulation runs/);
  const noIf = model(dual.replace('{id: eth1, ip: 10.0.1.10/24}', '{id: eth9, ip: 10.0.1.10/24}').replace('a: h1:eth1', 'a: h1:eth9'));
  const id1 = I.commIdentity(m, C.checkCommunication(m, { from: 'h1:eth1', to: 'srv' }));
  assert.match(I.staleProblem(noIf, id1), /^h1 has no interface eth1/);
  assert.deepEqual(I.expectationFields(id), { from: 'h1:eth0', to: 'srv/api', expect: 'available', service: 'tcp/8443' });
  const v4 = I.commIdentity(m, C.checkCommunication(m, { from: 'h1', to: 'srv', family: 4 }));
  assert.equal(I.expectationFields(v4).family, 4);
});

test('identity: the static result beside the simulation’s send, a difference explained from recorded state only', () => {
  // DHCP: the configured model has no source address (indeterminate); the simulation delivered with its lease
  const camp = ex('campus-services.yaml');
  const c = C.checkCommunication(camp, { from: 'pc2', to: 'web', service: 'tcp/443' });
  const id = I.commIdentity(camp, c);
  const s = new S.Simulation(camp);
  s.runTo(1000);
  const h = I.handoffOf(camp, id);
  assert.equal(s.testRuns().length, 0, 'preparing a handoff sends nothing');
  s.sendPlan({ delivery: 'unicast', ...h.prefill });
  s.runTo(60000);
  const run = s.testRuns()[0];
  assert.ok(I.planMatches(id, run.plan));
  const k = I.compareRun(camp, c, run, s.snapshot());
  assert.deepEqual([k.expected, k.runtime, k.agree], ['indeterminate', 'delivered', false]);
  assert.match(k.lines[0], /^Address acquired at runtime: the configured model has none to check with; at t = 60\.0 s pc2:eth0 has 10\.10\.20\.\d+ \(DHCPv4, bound\)/);
  // a route the configured model has but the simulation had not learned yet when the message was sent
  const ospf = ex('ospf-reroute.yaml');
  const c2 = C.checkCommunication(ospf, { from: 'w-host', to: 'e-srv' });
  assert.equal(c2.verdict, 'satisfied');
  const s2 = new S.Simulation(ospf);
  const p2 = I.handoffOf(ospf, I.commIdentity(ospf, c2)).prefill;
  s2.sendPlan({ delivery: 'unicast', ...p2 });
  s2.runTo(40000);
  const k2 = I.compareRun(ospf, c2, s2.testRuns()[0], s2.snapshot());
  assert.deepEqual([k2.runtime, k2.agree], ['failed', false]);
  assert.match(k2.lines[0], /^Route not there when sent \(t = 0\.0 s\): w-host had no route to 10\.2\.0\.10; the configured model routes it, and the simulation’s state at t = 40\.0 s does too: it was learned after the send/);
  // a later send agrees
  s2.sendPlan({ delivery: 'unicast', ...p2 });
  s2.runTo(60000);
  const k3 = I.compareRun(ospf, c2, s2.testRuns()[0], s2.snapshot());
  assert.deepEqual([k3.runtime, k3.agree, k3.lines], ['delivered', true, []]);
});

test('identity: an expectation’s address family is saved, validated and evaluated', () => {
  const m = model(dual + 'expectations:\n  - {id: v6, name: IPv6 to the API, expect: available, from: h1, to: srv/api, family: 6}\n');
  assert.equal(m.expectations[0].family, 6);
  const r = E.evaluateExpectation(m, m.expectations[0]);
  assert.equal(r.verdict, 'satisfied');
  assert.equal(r.check.from.address, '2001:db8::10');
  const bad = validate.loadModel(dual + 'expectations:\n  - {id: v5, name: x, expect: available, from: h1, to: srv, family: 5}\n');
  assert.match(bad.errors.map((e) => e.message).join('|'), /"5" is no address family: use 4 \(IPv4\) or 6 \(IPv6\)/);
});

// ------------------------------------------------------------------ isolation enforcement

const withExp = (yaml, lines) => yaml + 'expectations:\n' + lines.map((l) => '  - ' + l).join('\n') + '\n';
const guardOnly = guard.slice(0, guard.indexOf('expectations:'));

test('enforcement: denied by policy needs an evaluated policy’s denial; a missing route is no denial, and leaves it not exercised', () => {
  const m = model(withExp(guardOnly, [
    '{id: ssh-pol, name: SSH denied by policy, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: policy}',
    '{id: ssh-any, name: SSH unreachable, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: unreachable}',
    '{id: nowhere-pol, name: No route counts?, expect: blocked, from: pc, to: 10.77.0.1, enforce: policy}',
    '{id: nowhere-any, name: No route is enough, expect: blocked, from: pc, to: 10.77.0.1}',
    '{id: ssh-fw, name: SSH denied at the firewall, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: boundary, boundary: fw}',
    '{id: ssh-r2, name: SSH denied at r2, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: boundary, boundary: r2}',
  ]));
  const by = new Map(m.expectations.map((e) => [e.id, E.evaluateExpectation(m, e)]));
  assert.equal(by.get('ssh-pol').verdict, 'satisfied');
  assert.match(by.get('ssh-pol').reason, /^Denied by policy on the evaluated path: fw — /, 'the denial names where, and its rule');
  assert.equal(by.get('ssh-pol').enforcement.paths[0].outcome, 'denied');
  assert.match(by.get('ssh-any').reason, /^Unreachable \(any prevention is enough\): Blocked by policy at fw/);
  // a missing route: enough for "unreachable", never for "denied by policy"
  assert.equal(by.get('nowhere-any').verdict, 'satisfied');
  assert.equal(by.get('nowhere-pol').verdict, 'indeterminate');
  assert.match(by.get('nowhere-pol').reason, /^Denied by policy is not established: not exercised: it stops at r1 \(no route.*\) before any policy decides; a missing route is no denial/);
  // the selected boundary
  assert.equal(by.get('ssh-fw').verdict, 'satisfied');
  assert.match(by.get('ssh-fw').reason, /^Denied at fw on the evaluated path/);
  assert.equal(by.get('ssh-r2').verdict, 'violated');
  assert.match(by.get('ssh-r2').reason, /denied at fw, not at the selected boundary r2 \(the path does not cross r2\)/);
});

test('enforcement: a missing listener proves no isolation; a policy that permits and a later stop is no denial; partial ECMP is no isolation', () => {
  // the firewall permits TCP 8080 to the server, which listens on nothing there
  const open = model(withExp(guardOnly.replace('simulation: {allow: "tcp/443"}', 'simulation: {allow: "tcp/443, tcp/8080"}').replace('      - {prefix: 10.9.0.0/24, via: 10.0.1.2}', '      - {prefix: 10.9.0.0/24, via: 10.0.1.2}\n      - {prefix: 10.50.0.0/16, via: 10.0.1.2}').replace('    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]\n  - id: r2', '    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}, {prefix: 10.50.0.0/16, via: 10.9.0.3}]\n  - id: r2'), [
    '{id: alt, name: No 8080, expect: blocked, from: pc, to: srv, service: tcp/8080, enforce: policy}',
    '{id: other, name: No HTTPS beyond the server network, expect: blocked, from: pc, to: 10.50.0.5, service: tcp/443, enforce: policy}',
  ]));
  const alt = E.evaluateExpectation(open, open.expectations[0]);
  assert.equal(alt.verdict, 'violated');
  assert.match(alt.reason, /nothing listens there .* but no policy blocks the traffic/);
  const other = E.evaluateExpectation(open, open.expectations[1]);
  assert.equal(other.verdict, 'violated', other.reason);
  assert.match(other.reason, /fw permits it; it stops at r2 for another reason \(no route.*\), which is no denial by policy$/);
  // equal-cost paths, one through the firewall (denied), one through r2 (it passes): never complete isolation
  const ecmp = model(withExp(guardOnly.replace('      - {prefix: 10.9.0.0/24, via: 10.0.2.2, distance: 200}', '      - {prefix: 10.9.0.0/24, via: 10.0.2.2}'), [
    '{id: e1, name: SSH by policy, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: policy}',
    '{id: e2, name: SSH at all, expect: blocked, from: pc, to: srv, service: tcp/22}',
  ]));
  for (const e of ecmp.expectations) {
    const r = E.evaluateExpectation(ecmp, e);
    assert.equal(r.verdict, 'violated', r.reason);
    assert.match(r.reason, /1 of 2 evaluated paths/);
  }
});

test('enforcement: evaluated in what-if too; validation; the boundary follows a rename', () => {
  const m = model(withExp(guardOnly, ['{id: p, name: SSH by policy, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: policy}', '{id: b, name: SSH at fw, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: boundary, boundary: fw}']));
  const w = W.whatIf(m, ['fw']);
  assert.deepEqual(w.expectations.map((x) => [x.after.id, x.change]), [['b', 'isolation-violated'], ['p', 'isolation-violated']]);
  const r2 = W.whatIf(m, ['r1']).expectations.find((x) => x.after.id === 'p');
  assert.equal(r2.after.verdict, 'indeterminate', 'the source can’t reach any policy: not exercised, never proven');
  const errs = (lines) => validate.loadModel(withExp(guardOnly, lines)).errors.map((e) => e.message).join(' | ');
  assert.match(errs(['{id: a, name: a, expect: available, from: pc, to: srv, enforce: policy}']), /only a blocked expectation is enforced/);
  assert.match(errs(['{id: a, name: a, expect: blocked, from: pc, to: srv, enforce: wall}']), /"wall" is no enforcement: use unreachable, policy, boundary/);
  assert.match(errs(['{id: a, name: a, expect: blocked, from: pc, to: srv, enforce: boundary}']), /enforce: boundary needs the boundary/);
  assert.match(errs(['{id: a, name: a, expect: blocked, from: pc, to: srv, boundary: fw}']), /a boundary goes with "enforce: boundary"/);
  const warn = validate.loadModel(withExp(guardOnly, ['{id: a, name: a, expect: blocked, from: pc, to: srv, enforce: boundary, boundary: nofw}'])).warnings.map((x) => x.message).join(' | ');
  assert.match(warn, /"nofw" is no device of the model/);
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(withExp(guardOnly, ['{id: b, name: SSH at fw, expect: blocked, from: pc, to: srv, service: tcp/22, enforce: boundary, boundary: fw}']), 'x.yaml', 'file').doc;
  d.renameEntity('device', d.findEntity('device', 'fw').index, 'fw-edge');
  assert.equal(d.result.model.expectations[0].boundary, 'fw-edge');
  assert.deepEqual(d.analysisUsers(d.references('device', 'fw-edge')), ['expectation b']);
  // written through the editor: enforce and boundary in their place, removed again by an empty value
  d.updateExpectation(0, { enforce: 'policy', boundary: '' });
  assert.equal(d.result.model.expectations[0].enforce, 'policy');
  assert.equal(d.result.model.expectations[0].boundary, undefined);
});

// ------------------------------------------------------------------ timing: method and NTP source chains

// one LAN: an NTP reference, a chain a → ref, b → a, c → b (and an upstream outside the model), a cycle x ⇄ y,
// a clock with both PTP (receiver) and NTP, a PTP grandmaster
const ntpLan = `netatlas: 1
title: NTP chains
devices:
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}, {id: p6, vlans: 1}, {id: p7, vlans: 1}, {id: p8, vlans: 1}, {id: p9, vlans: 1}]
  - id: ref
    type: server
    services: {ntp: {stratum: 1}}
    interfaces: [{id: eth0, ip: 10.0.0.1/24}]
  - id: a
    type: server
    services: {ntp: {upstreams: [10.0.0.1]}}
    interfaces: [{id: eth0, ip: 10.0.0.2/24}]
  - id: b
    type: server
    services: {ntp: {upstreams: [10.0.0.2]}}
    interfaces: [{id: eth0, ip: 10.0.0.3/24}]
  - id: c
    type: server
    services: {ntp: {upstreams: [203.0.113.5, 10.0.0.3]}}
    interfaces: [{id: eth0, ip: 10.0.0.4/24}]
  - id: x
    type: server
    services: {ntp: {upstreams: [10.0.0.8]}}
    interfaces: [{id: eth0, ip: 10.0.0.7/24}]
  - id: y
    type: server
    services: {ntp: {upstreams: [10.0.0.7]}}
    interfaces: [{id: eth0, ip: 10.0.0.8/24}]
  - id: ext
    type: server
    services: {ntp: {upstreams: [203.0.113.5]}}
    interfaces: [{id: eth0, ip: 10.0.0.9/24}]
  - id: both
    type: server
    services:
      ntp: {upstreams: [10.0.0.1]}
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: receiver_only}
    interfaces: [{id: eth0, ip: 10.0.0.10/24}]
  - id: gm
    type: server
    services:
      ptp: {clock: ordinary, profile: default_e2e_udp4, domain: 0, interfaces: [eth0], role: source_capable}
    interfaces: [{id: eth0, ip: 10.0.0.11/24}]
links:
  - {id: l1, a: ref:eth0, b: sw:p1}
  - {id: l2, a: a:eth0, b: sw:p2}
  - {id: l3, a: b:eth0, b: sw:p3}
  - {id: l4, a: c:eth0, b: sw:p4}
  - {id: l5, a: x:eth0, b: sw:p5}
  - {id: l6, a: y:eth0, b: sw:p6}
  - {id: l7, a: ext:eth0, b: sw:p7}
  - {id: l8, a: both:eth0, b: sw:p8}
  - {id: l9, a: gm:eth0, b: sw:p9}
`;

test('timing: an NTP source chain to a modeled reference, alternatives, cycles and upstreams outside the model, said apart', () => {
  const m = model(ntpLan);
  const c = TI.ntpSource(m, 'c');
  assert.equal(c.verdict, 'satisfied');
  assert.deepEqual(c.chain, ['c', 'b', 'a', 'ref']);
  assert.match(c.text, /^A structurally valid NTP source chain exists: c → b → a → ref \(a configured reference, stratum 1\); runtime synchronization is not established; accuracy is not evaluated$/);
  assert.deepEqual(c.ntp.map((x) => [x.upstream, x.state]), [['203.0.113.5', 'external'], ['10.0.0.3', 'root']], 'each upstream with where it ends');
  assert.deepEqual(c.levels, { upstream: 'satisfied', chain: 'satisfied' });
  // a cycle without a reference: upstreams reachable, no source chain
  const x = TI.ntpSource(m, 'x');
  assert.equal(x.verdict, 'violated');
  assert.match(x.text, /^No structurally valid NTP source chain: a cycle: x → y → x \(no reference on the way\) \(an upstream is reachable, but that is not a source chain\)$/);
  assert.deepEqual(x.levels, { upstream: 'satisfied', chain: 'violated' });
  // only an upstream outside the model: beyond modeled scope, never satisfied
  assert.equal(TI.ntpSource(m, 'ext').verdict, 'beyond');
  // the reference itself
  assert.match(TI.ntpSource(m, 'ref').text, /ref is a configured reference \(stratum 1\)/);
});

test('timing: the method is explicit (PTP, NTP, either); each configured method is a dependency of its own', () => {
  const m = model(ntpLan);
  assert.equal(TI.timingSource(m, 'both', {}, 'ptp').protocol, 'PTP');
  assert.equal(TI.timingSource(m, 'both', {}, 'ntp').protocol, 'NTP');
  const either = TI.timingSource(m, 'both', {}, 'either');
  assert.equal(either.protocol, 'PTP or NTP');
  assert.equal(either.parts.length, 2, 'both evaluated, both reported');
  assert.match(either.text, /^PTP: A compatible PTP source path exists.*\. NTP: A structurally valid NTP source chain exists: both → ref/);
  // NTP is never hidden behind PTP: two dependencies
  const deps = D.serviceDependencies(m).filter((d) => d.consumer === 'both' && d.kind === 'timing').map((d) => d.key);
  assert.deepEqual(deps, ['timing-ntp:both', 'timing-ptp:both']);
  // a method the device is not configured for: unsupported, never the other one instead
  const onlyPtp = m.devices.find((d) => d.id === 'gm');
  assert.ok(onlyPtp);
  const e = E.evaluateExpectation(m, { id: 't', name: 't', expect: 'timing', from: 'gm', method: 'ntp', failure: [], line: 0 });
  assert.equal(e.verdict, 'unsupported');
  assert.match(e.reason, /gm has no NTP service: there is no NTP source chain to check/);
  // validation: a timing expectation needs its method; only a timing expectation has one
  const errs = (l) => validate.loadModel(ntpLan + 'expectations:\n  - ' + l + '\n').errors.map((x) => x.message).join(' | ');
  assert.match(errs('{id: t, name: t, expect: timing, from: c}'), /a timing expectation needs its method: ptp, ntp, or either/);
  assert.match(errs('{id: t, name: t, expect: blocked, from: c, to: a, method: ntp}'), /only a timing expectation has a method/);
  assert.match(errs('{id: t, name: t, expect: timing, from: c, method: gps}'), /"gps" is no timing method/);
  const ok = model(ntpLan + 'expectations:\n  - {id: t, name: t, expect: timing, from: c, method: ntp, to: ref}\n');
  const r = E.evaluateExpectation(ok, ok.expectations[0]);
  assert.equal(r.verdict, 'satisfied');
});

test('timing: a snapshot adds the synchronization the simulation observed; accuracy is never evaluated', () => {
  const m = model(ntpLan);
  const s = new S.Simulation(m);
  s.runTo(400000);
  const snap = s.snapshot();
  const t = TI.timingSource(m, 'c', snap.ctx, 'ntp', snap);
  assert.match(t.observed, /^at t = 400\.0 s c is synchronized \(synchronized to 10\.0\.0\.3/);
  assert.match(t.text, /the snapshot: at t = 400\.0 s c is synchronized .*; accuracy is not evaluated$/);
  const cyc = TI.timingSource(m, 'x', snap.ctx, 'ntp', snap);
  assert.match(cyc.observed, /x is not synchronized/);
});

// ------------------------------------------------------------------ path MTU

const MT = load('analysis/mtu.js');

// h1 → r1, then two equal-cost ways to the server LAN: via r2 (9000 between the routers) and via r3 (1400 on r1's port to r3); the server answers via r2
const mtuNet = `netatlas: 1
title: Path MTU
devices:
  - id: h1
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: b, ip: 10.0.2.1/30, mtu: 9000}, {id: c, ip: 10.0.3.1/30, mtu: 1400}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.2.2}, {prefix: 10.9.0.0/24, via: 10.0.3.2}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.2.2/30, mtu: 9000}, {id: lan, ip: 10.9.0.2/24, mtu: 1500}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]
  - id: r3
    type: router
    interfaces: [{id: a, ip: 10.0.3.2/30, mtu: 1500}, {id: lan, ip: 10.9.0.3/24, mtu: 1500}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.3.1}]
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 1, mtu: 1500}, {id: p2, vlans: 1, mtu: 1500}, {id: p3, vlans: 1, mtu: 1500}]
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.9.0.10/24, mtu: 1500}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.2}]
links:
  - {id: l-h1, a: h1:eth0, b: r1:lan}
  - {id: l-r2, a: r1:b, b: r2:a}
  - {id: l-r3, a: r1:c, b: r3:a}
  - {id: l-sw2, a: r2:lan, b: sw:p1}
  - {id: l-sw3, a: r3:lan, b: sw:p2}
  - {id: l-srv, a: srv:eth0, b: sw:p3}
`;

test('path MTU: the limiting component, every equal-cost branch and the return path apart, the payload apart from the MTU', () => {
  const m = model(mtuNet);
  const c = C.checkCommunication(m, { from: 'h1', to: 'srv', service: 'tcp/443', back: true });
  const r = MT.pathMtu(m, c);
  assert.equal(r.verdict, 'satisfied', r.text);
  assert.equal(r.mtu, 1400);
  assert.match(r.text, /^Path MTU 1400 bytes \(limited by r1:c\); payload up to 1360 bytes \(TCP MSS: 1400 − \(20 IPv4 \+ 20 TCP \(without options\)\)\)$/);
  assert.deepEqual(r.forward.map((p) => p.mtu).sort(), [1400, 1500], 'each branch with its own limit');
  assert.ok(r.differs.some((x) => /^The equal-cost paths differ: path 1 1500 bytes, path 2 1400 bytes/.test(x)), r.differs.join(' | '));
  assert.deepEqual(r.reverse.map((p) => p.mtu), [1500]);
  // a port on the way limits too (a switch port the frame crosses)
  const port = model(mtuNet.replace('{id: p3, vlans: 1, mtu: 1500}', '{id: p3, vlans: 1, mtu: 1280}'));
  const rp = MT.pathMtu(port, C.checkCommunication(port, { from: 'h1', to: 'srv', service: 'udp/53' }));
  assert.equal(rp.mtu, 1280);
  assert.match(rp.text, /limited by sw:p3 \(a port on the way\)\); payload up to 1252 bytes \(UDP payload/);
  // unknown MTUs are not taken as known: an upper bound, said so
  const unknown = model(mtuNet.replace(/, mtu: \d+/g, (x, k) => (x.indexOf('1400') >= 0 ? x : '')));
  const ru = MT.pathMtu(unknown, C.checkCommunication(unknown, { from: 'h1', to: 'srv' }));
  assert.equal(ru.verdict, 'indeterminate');
  assert.match(ru.text, /^At most 1400 bytes \(limited by r1:c\); \d+ components on the way have no known MTU, so the limit may be lower/);
  const none = model(mtuNet.replace(/, mtu: \d+/g, ''));
  assert.match(MT.pathMtu(none, C.checkCommunication(none, { from: 'h1', to: 'srv' })).text, /^The path MTU is not known: no MTU is written on the way/);
});

test('path MTU: nested encapsulation (GRE over IPsec) is the underlay less the overheads added up', () => {
  const wan = model(readFileSync(join(root, 'examples', 'enterprise-wan.yaml'), 'utf8').replace('mtu: 1400, source: wan0', 'source: wan0').replace('{id: st0.10, type: tunnel, ip: 172.16.10.1/30, mtu: 1400,', '{id: st0.10, type: tunnel, ip: 172.16.10.1/30,'));
  const c = C.checkCommunication(wan, { from: 'muc-rtr:lan0', to: 'hq-core1' });
  const r = MT.pathMtu(wan, c);
  const p = r.forward[0];
  assert.deepEqual(p.overheads.map((o) => o.bytes), [24, 73], 'GRE, then IPsec ESP (worst case)');
  const tun = p.constraints.find((x) => x.kind === 'tunnel');
  assert.equal(tun.mtu, 1500 - 97);
  assert.match(tun.what, /^gre-muc over ipsec-muc: underlay 1500 \(hq-rtr1:ge-0\/0\/0\) − 97 bytes of encapsulation$/);
  assert.equal(r.mtu, 1403);
  assert.equal(p.limiting.kind, 'tunnel');
});

test('path MTU: the simulation fragments without DF, drops with DF (Fragmentation Needed) and the comparison says so', () => {
  // one way only (via r3: 1400), so the simulation takes the path the analysis limits
  const one = model(mtuNet.replace('    routes: [{prefix: 10.9.0.0/24, via: 10.0.2.2}, {prefix: 10.9.0.0/24, via: 10.0.3.2}]', '    routes: [{prefix: 10.9.0.0/24, via: 10.0.3.2}]').replace("    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.2}]\nlinks", "    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.3}]\nlinks"));
  const c = C.checkCommunication(one, { from: 'h1', to: 'srv' });
  const r = MT.pathMtu(one, c);
  assert.equal(r.mtu, 1400);
  assert.deepEqual(MT.mtuTestSizes(r), { fits: 1372, tooBig: 1373 });
  const id = I.commIdentity(one, c);
  const pre = I.handoffOf(one, id).prefill;
  const s = new S.Simulation(one);
  s.runTo(15000);
  s.sendPlan({ delivery: 'unicast', ...pre, size: 1373, df: true });
  s.runTo(30000);
  const big = s.testRuns()[0];
  assert.equal(big.tests[0].ok, false);
  assert.match(big.tests[0].result, /too big|MTU/i);
  const k = I.compareRun(one, c, big, s.snapshot());
  assert.equal(k.agree, false);
  assert.match(k.lines[0], /^Packet too big when sent/);
  s.sendPlan({ delivery: 'unicast', ...pre, size: 1372, df: true });
  s.runTo(45000);
  assert.equal(s.testRuns()[0].tests[0].ok, true, 'the payload the static path MTU allows fits');
  s.sendPlan({ delivery: 'unicast', ...pre, size: 1373, df: false });
  s.runTo(60000);
  assert.equal(s.testRuns()[0].tests[0].ok, true, 'IPv4 without DF: fragmented and delivered');
  assert.ok(s.events().some((e) => /r1 fragments/.test(e.detail)), 'the fragmentation is in the event log');
});

// ------------------------------------------------------------------ routing policy

const RT = load('analysis/routing.js');
const IPM = load('model/ip.js');
const I_ADDR = (t) => IPM.parseAddress(t);

// HQ (AS 65000) with two internal networks, a branch (AS 65100) over eBGP
const bgpWan = (hqBgp = '{asn: 65000}', brBgp = '{asn: 65100}', hqRoutes = '') => `netatlas: 1
title: Branch routing policy
devices:
  - id: hq
    type: router
    protocols:
      bgp: ${hqBgp}
    interfaces: [{id: lan1, ip: 10.10.1.1/24}, {id: lan2, ip: 10.10.2.1/24}, {id: wan, ip: 172.16.0.1/30}]${hqRoutes}
  - id: br
    type: router
    protocols:
      bgp: ${brBgp}
    interfaces: [{id: lan, ip: 10.20.0.1/24}, {id: wan, ip: 172.16.0.2/30}]
links:
  - {id: l-wan, a: hq:wan, b: br:wan}
relations:
  - {id: bgp-hq-br, protocol: ebgp, endpoints: [hq, br]}
`;
const learned = (m, dev) => RT.ribOf(m, dev, '').filter((e) => e.kind === 'dynamic').map((e) => `${e.net.version === 4 ? e.net.bytes.join('.') : '?'}/${e.net.prefix}`).sort();

test('routing policy: without one, every connected network is advertised (as before)', () => {
  const m = model(bgpWan());
  assert.deepEqual(learned(m, 'br'), ['10.10.1.0/24', '10.10.2.0/24']);
  const e = RT.ribOf(m, 'br', '').find((x) => x.kind === 'dynamic');
  assert.deepEqual([e.origin.device, e.origin.how, e.asPath, e.localPref], ['hq', 'connected', [65000], 100]);
});

test('routing policy: a branch gets a default route without every internal prefix (by export at HQ, or by import at the branch)', () => {
  const byExport = model(bgpWan('\n        asn: 65000\n        default_route: always\n        export:\n          - {peer: br, prefix: 0.0.0.0/0, action: permit}\n          - {peer: br, action: deny}\n          - {action: permit}'));
  assert.deepEqual(learned(byExport, 'br'), ['0.0.0.0/0']);
  const d = RT.ribOf(byExport, 'br', '').find((x) => x.kind === 'dynamic');
  assert.equal(d.origin.how, 'default');
  assert.deepEqual(d.policy, ['hq export rule 1 (permit 0.0.0.0/0 to br)']);
  // the branch still reaches HQ's networks, by the default route
  const dec = RT.lookup(byExport, 'br', '', I_ADDR('10.10.2.5'));
  assert.equal(dec.kind, 'forward');
  assert.equal(dec.hops[0].entry.net.prefix, 0);
  const byImport = model(bgpWan('\n        asn: 65000\n        default_route: always', '\n        asn: 65100\n        import:\n          - {prefix: 0.0.0.0/0, action: permit}\n          - {action: deny}'));
  assert.deepEqual(learned(byImport, 'br'), ['0.0.0.0/0']);
  assert.match(RT.ribOf(byImport, 'br', '').find((x) => x.kind === 'dynamic').policy.join(), /br import rule 1 \(permit 0\.0\.0\.0\/0\)/);
});

test('routing policy: explicit advertisement replaces every connected network; prefix filters with ge/le; the implicit deny', () => {
  const summary = model(bgpWan('\n        asn: 65000\n        advertise: [10.10.0.0/16]', undefined, '\n    routes: [{prefix: 10.10.0.0/16, blackhole: true}]'));
  assert.deepEqual(learned(summary, 'br'), ['10.10.0.0/16'], 'the summary only; the /24s are not advertised');
  assert.equal(RT.ribOf(summary, 'br', '').find((x) => x.kind === 'dynamic').origin.how, 'advertised');
  // a filter: /24s inside 10.10.0.0/16 permitted from hq up to /24, nothing else (implicit deny)
  const ge = model(bgpWan('{asn: 65000}', '\n        asn: 65100\n        import:\n          - {prefix: 10.10.0.0/16, ge: 24, le: 24, action: permit, peer: hq}'));
  assert.deepEqual(learned(ge, 'br'), ['10.10.1.0/24', '10.10.2.0/24']);
  const deny2 = model(bgpWan('{asn: 65000}', '\n        asn: 65100\n        import:\n          - {prefix: 10.10.2.0/24, action: deny}\n          - {action: permit}'));
  assert.deepEqual(learned(deny2, 'br'), ['10.10.1.0/24'], 'first match wins');
  // the consistency check: a missing catch-all, an advertised prefix the device does not have
  const CK = load('analysis/checks.js');
  const msgs = (m) => CK.runChecks(m).filter((f) => f.check === 'routing-policy').map((f) => f.message).join(' | ');
  assert.match(msgs(ge), /br bgp import filter has no catch-all rule/);
  assert.match(msgs(model(bgpWan('\n        asn: 65000\n        advertise: [10.99.0.0/16]'))), /hq advertises 10\.99\.0\.0\/16 into bgp, but has no connected network or static route 10\.99\.0\.0\/16: it is not advertised/);
});

test('routing policy: BGP prefers local preference, then the shorter AS path, then the cost; a path with its own AS is refused', () => {
  // the branch is dual-homed: AS 65001 directly to HQ's network, AS 65002 via another AS; local preference overrides the shorter path
  const dual = (brImport) => `netatlas: 1
title: Dual-homed branch
devices:
  - id: dst
    type: router
    protocols: {bgp: {asn: 65000}}
    interfaces: [{id: lan, ip: 10.50.0.1/24}, {id: a, ip: 172.16.1.1/30}, {id: b, ip: 172.16.2.1/30}]
  - id: ispa
    type: router
    protocols: {bgp: {asn: 65001}}
    interfaces: [{id: d, ip: 172.16.1.2/30}, {id: br, ip: 172.16.3.1/30}]
  - id: mid
    type: router
    protocols: {bgp: {asn: 65003}}
    interfaces: [{id: d, ip: 172.16.2.2/30}, {id: b, ip: 172.16.4.1/30}]
  - id: ispb
    type: router
    protocols: {bgp: {asn: 65002}}
    interfaces: [{id: m, ip: 172.16.4.2/30}, {id: br, ip: 172.16.5.1/30}]
  - id: br
    type: router
    protocols:
      bgp:
        asn: 65100${brImport}
    interfaces: [{id: a, ip: 172.16.3.2/30}, {id: b, ip: 172.16.5.2/30}]
links:
  - {id: l1, a: dst:a, b: ispa:d}
  - {id: l2, a: dst:b, b: mid:d}
  - {id: l3, a: mid:b, b: ispb:m}
  - {id: l4, a: ispa:br, b: br:a}
  - {id: l5, a: ispb:br, b: br:b}
relations:
  - {id: s1, protocol: ebgp, endpoints: [dst, ispa]}
  - {id: s2, protocol: ebgp, endpoints: [dst, mid]}
  - {id: s3, protocol: ebgp, endpoints: [mid, ispb]}
  - {id: s4, protocol: ebgp, endpoints: [ispa, br]}
  - {id: s5, protocol: ebgp, endpoints: [ispb, br]}
`;
  const plain = model(dual(''));
  const r1 = RT.ribOf(plain, 'br', '').filter((e) => e.kind === 'dynamic' && e.net.bytes[1] === 50);
  assert.deepEqual(r1.map((e) => [e.peer, e.asPath.join(' ')]), [['ispa', '65001 65000']], 'the shorter AS path');
  const pref = model(dual('\n        import:\n          - {peer: ispb, action: permit, local_pref: 200}\n          - {action: permit}'));
  const r2 = RT.ribOf(pref, 'br', '').filter((e) => e.kind === 'dynamic' && e.net.bytes[1] === 50);
  assert.deepEqual(r2.map((e) => [e.peer, e.localPref, e.asPath.join(' ')]), [['ispb', 200, '65002 65003 65000']], 'local preference first');
  // the hop evidence names the origin, the AS path and the rule
  const T = load('analysis/trace.js');
  const t = T.tracePath(pref, { from: 'br', to: '10.50.0.1' });
  assert.match(t.paths[0].hops[0].via.text, /BGP route 10\.50\.0\.0\/24 over s5 \(cost 3, distance 20; AS path 65002 65003 65000, local preference 200; br import rule 1 \(permit any route from ispb, local-pref 200\)/);
  // a prepend makes a path longer
  const pre = model(dual('').replace("    protocols: {bgp: {asn: 65001}}", "    protocols:\n      bgp:\n        asn: 65001\n        export:\n          - {peer: br, action: permit, prepend: 3}\n          - {action: permit}"));
  const r3 = RT.ribOf(pre, 'br', '').filter((e) => e.kind === 'dynamic' && e.net.bytes[1] === 50);
  assert.deepEqual(r3.map((e) => e.peer), ['ispb'], 'four times 65001 is longer than 65002 65003');
});

test('routing policy: redistribution between protocols keeps its origin history (no loop back); validation of the subset', () => {
  // R1 and R2 run OSPF between them and RIP to their own sides, each redistributing both ways
  const red = `netatlas: 1
title: Mutual redistribution
devices:
  - id: rip-a
    type: router
    protocols: {rip: {}}
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: u, ip: 10.0.1.1/30}]
  - id: r1
    type: router
    router_id: 1.1.1.1
    protocols:
      rip:
        redistribute: [ospf]
      ospf:
        redistribute: [rip]
    interfaces: [{id: d, ip: 10.0.1.2/30}, {id: o, ip: 10.0.9.1/30}]
  - id: r2
    type: router
    router_id: 2.2.2.2
    protocols:
      rip:
        redistribute: [ospf]
      ospf:
        redistribute: [rip]
    interfaces: [{id: o, ip: 10.0.9.2/30}, {id: d, ip: 10.0.2.1/30}]
  - id: rip-b
    type: router
    protocols: {rip: {}}
    interfaces: [{id: u, ip: 10.0.2.2/30}, {id: lan, ip: 10.2.0.1/24}]
links:
  - {id: l1, a: rip-a:u, b: r1:d}
  - {id: l2, a: r1:o, b: r2:o}
  - {id: l3, a: r2:d, b: rip-b:u}
relations:
  - {id: rip1, protocol: rip, endpoints: [rip-a, r1]}
  - {id: ospf12, protocol: ospf, endpoints: [r1, r2]}
  - {id: rip2, protocol: rip, endpoints: [r2, rip-b]}
`;
  const m = model(red);
  // rip-a's LAN reaches rip-b through OSPF, redistributed at both ends
  const atB = RT.ribOf(m, 'rip-b', '').find((e) => e.kind === 'dynamic' && e.net.bytes[1] === 1 && e.net.prefix === 24);
  assert.ok(atB, 'learned');
  assert.deepEqual(atB.origin.history, ['rip@r1', 'ospf@r1'], 'its way: rip-a’s RIP domain, then OSPF, then rip-b’s RIP domain (another one) at r2');
  // never back into a domain it came through: r2 does not take rip-b’s routes back into OSPF once they came from OSPF
  const atA = RT.ribOf(m, 'rip-a', '').find((e) => e.kind === 'dynamic' && e.net.bytes[1] === 2 && e.net.prefix === 24);
  assert.deepEqual(atA.origin.history, ['rip@r2', 'ospf@r1']);
  // r1 never takes it back from OSPF into RIP: its RIP route is the original one, from rip-a
  const atR1 = RT.ribOf(m, 'r1', '').filter((e) => e.kind === 'dynamic' && e.net.bytes[1] === 1 && e.net.prefix === 24);
  assert.deepEqual(atR1.map((e) => [e.protocol, e.peer]), [['rip', 'rip-a']]);
  // validation: an export filter on a link-state protocol, a bad rule, redistributing itself
  const errs = (y) => validate.loadModel(y).errors.map((e) => e.message).join(' | ');
  assert.match(errs(red.replace('      ospf:\n        redistribute: [rip]\n    interfaces: [{id: d, ip: 10.0.1.2/30}', '      ospf:\n        export: [{action: deny}]\n    interfaces: [{id: d, ip: 10.0.1.2/30}')), /OSPF floods what it learns: it has no export filter/);
  assert.match(errs(bgpWan('\n        asn: 65000\n        export: [{prefix: 10.0.0.0/8}]')), /a filter rule needs its action: permit or deny/);
  assert.match(errs(bgpWan('\n        asn: 65000\n        redistribute: [bgp]')), /BGP can't redistribute itself/);
  assert.match(errs(bgpWan('\n        asn: 65000\n        import: [{action: permit, prepend: 2}]')), /prepend is set by a BGP export rule only/);
  assert.match(errs(bgpWan('\n        asn: 65000\n        export: [{prefix: 10.0.0.0/8, ge: 30, le: 24, action: permit}]')), /ge is larger than le/);
});

test('routing policy: the simulation installs the same routes (one routing computation, its adjacencies as they come up)', () => {
  const m = model(bgpWan('\n        asn: 65000\n        default_route: always\n        export:\n          - {peer: br, prefix: 0.0.0.0/0, action: permit}\n          - {action: deny}'));
  const s = new S.Simulation(m);
  s.runTo(120000);
  const snap = s.snapshot();
  const now = RT.ribOf(m, 'br', '', snap.ctx).filter((e) => e.kind === 'dynamic').map((e) => e.net.prefix);
  assert.deepEqual(now, [0], 'the branch learns the default route only, in the simulation too');
  // the ED renames a filter's peer with the device
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(bgpWan('\n        asn: 65000\n        export:\n          - {peer: br, action: deny}\n          - {action: permit}'), 'x.yaml', 'file').doc;
  d.renameEntity('device', d.findEntity('device', 'br').index, 'branch1');
  const hq = d.result.model.devices.find((x) => x.id === 'hq');
  assert.equal(hq.services.find((x) => x.id === 'bgp').policy.export[0].peer, 'branch1');
});

// ------------------------------------------------------------------ network policy

const PO = load('analysis/policy.js');

// pc — r1 (an ACL) — srv; the server listens on SSH and HTTPS
const acl = (policy) => `netatlas: 1
title: Router ACL
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: pc2
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.20/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 10.9.0.1/24}]
${policy}
  - id: srv
    type: server
    simulation: {listening: "tcp/22, tcp/443"}
    interfaces: [{id: eth0, ip: 10.9.0.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]
links:
  - {id: l-pc, a: pc:eth0, b: sw:p1}
  - {id: l-pc2, a: pc2:eth0, b: sw:p2}
  - {id: l-r1, a: r1:lan, b: sw:p3}
  - {id: l-srv, a: srv:eth0, b: r1:wan}
networks:
  - {id: users, cidr: 10.1.0.0/24}
`;
const sshAcl = acl(`    policy:
      default: permit
      rules:
        - {name: admin ssh, action: permit, source: pc2, destination: srv, proto: tcp, dport: 22}
        - {action: deny, source: users, destination: srv, proto: tcp, dport: "22"}`);

test('network policy: a router ACL in order (first match wins, an explicit default); the tracer names the rule', () => {
  const m = model(sshAcl);
  const ssh = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/22' });
  assert.equal(ssh.verdict, 'violated');
  assert.match(ssh.layers.find((l) => l.id === 'policy').text, /^Denied at r1: r1 denies tcp\/22 from pc to srv: rule 2 \(deny tcp users → srv dport 22\)/);
  const admin = C.checkCommunication(m, { from: 'pc2', to: 'srv', service: 'tcp/22' });
  assert.equal(admin.verdict, 'satisfied');
  assert.match(admin.layers.find((l) => l.id === 'policy').detail.join(), /r1 permits tcp\/22 from pc2 to srv: rule 1 \(admin ssh: permit tcp pc2 → srv dport 22\)/);
  const https = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/443' });
  assert.equal(https.verdict, 'satisfied');
  assert.match(https.layers.find((l) => l.id === 'policy').detail.join(), /no rule matches \(its default action, permit\)/);
  // without a service the decision is said to depend on it, never guessed
  const any = C.checkCommunication(m, { from: 'pc', to: 'srv' });
  assert.equal(any.layers.find((l) => l.id === 'policy').verdict, 'indeterminate');
  // an enforcement requirement is met by the ACL's denial, named with its rule
  const e = E.evaluateExpectation(m, { id: 'x', name: 'x', expect: 'blocked', from: 'pc', to: 'srv', service: 'tcp/22', enforce: 'policy', failure: [], line: 0 });
  assert.equal(e.verdict, 'satisfied');
  assert.match(e.reason, /Denied by policy on the evaluated path: r1 — r1 denies tcp\/22 from pc to srv: rule 2/);
});

test('network policy: the simulation applies the same rules (one engine)', () => {
  const m = model(sshAcl);
  const s = new S.Simulation(m);
  s.runTo(15000);
  s.sendPlan({ delivery: 'unicast', from: 'pc', to: 'srv', toIface: 'eth0', toAddr: '10.9.0.10', kind: 'tcp', port: 22 });
  s.runTo(40000);
  const denied = s.testRuns()[0].tests[0];
  assert.equal(denied.ok, false);
  assert.ok(s.events().some((x) => x.kind === 'drop' && /^r1 drops TCP 10\.1\.0\.10:\d+ → 10\.9\.0\.10:22 .*rule 2 \(deny tcp users → srv dport 22\)/.test(x.detail)), 'the drop names the rule');
  s.sendPlan({ delivery: 'unicast', from: 'pc2', to: 'srv', toIface: 'eth0', toAddr: '10.9.0.10', kind: 'tcp', port: 22 });
  s.runTo(60000);
  assert.equal(s.testRuns()[0].tests[0].ok, true, 'rule 1 permits pc2; the router is stateless and its default permits the answers');
});

test('network policy: zones and a stateful firewall; stateless, the return direction needs its own rule', () => {
  const fwPolicy = (stateful) => acl(`    policy:
      default: deny${stateful === undefined ? '' : '\n      stateful: ' + stateful}
      zones:
        - {name: inside, interfaces: [lan]}
        - {name: outside, interfaces: wan}
      rules:
        - {action: permit, from_zone: inside, to_zone: outside, proto: tcp, dport: 443}`).replace('  - id: r1\n    type: router', '  - id: r1\n    type: firewall');
  const m = model(fwPolicy());
  const there = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/443' });
  assert.equal(there.verdict, 'satisfied');
  const back = C.checkCommunication(m, { from: 'srv', to: 'pc', service: 'tcp/443' });
  assert.equal(back.verdict, 'violated', 'statically each direction is decided by the rules: outside → inside is not permitted');
  // the simulation: a firewall's sessions let the answers back; stateless they are dropped
  const run = (mm) => {
    const s = new S.Simulation(mm);
    s.runTo(15000);
    s.sendPlan({ delivery: 'unicast', from: 'pc', to: 'srv', toIface: 'eth0', toAddr: '10.9.0.10', kind: 'tcp', port: 443 });
    s.runTo(60000);
    return s.testRuns()[0].tests[0];
  };
  assert.equal(run(m).ok, true, 'stateful (a firewall’s sessions): the answer belongs to the session');
  const stateless = run(model(fwPolicy(false)));
  assert.equal(stateless.ok, false, 'stateless: the answer from outside to inside matches no rule');
  assert.equal(PO.policyStateful(model(fwPolicy(false)).devices.find((d) => d.id === 'r1'), true), false);
});

test('network policy: validation and renames', () => {
  const errs = (policy) => validate.loadModel(acl(policy)).errors.map((e) => e.message).join(' | ');
  assert.match(errs('    policy:\n      rules: [{action: deny}]'), /a policy needs its default action: permit or deny/);
  assert.match(errs('    policy:\n      default: deny\n      rules: [{action: permit, proto: icmp, dport: 8}]'), /dport goes with tcp or udp/);
  assert.match(errs('    policy:\n      default: deny\n      rules: [{action: permit, in: ge-9}]'), /"r1" has no interface "ge-9"/);
  assert.match(errs('    policy:\n      default: deny\n      rules: [{action: permit, source: nowhere}]'), /"nowhere" is no prefix, address, device, network or device:interface/);
  assert.match(errs('    policy:\n      default: deny\n      rules: [{action: permit, from_zone: dmz}]'), /the policy defines no zone "dmz"/);
  assert.match(errs('    policy:\n      default: deny\n      rules: [{action: permit, proto: tcp, dport: 70000}]'), /out of 1–65535/);
  const sw = validate.loadModel(acl('').replace("    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]", "    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]\n    policy: {default: deny}"));
  assert.match(sw.errors.map((e) => e.message).join(), /"sw" forwards no IP: a network policy applies on a router, a Layer 3 switch or a firewall/);
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(sshAcl.replace('rules:', 'zones: [{name: in, interfaces: [lan]}]\n      rules:'), 'x.yaml', 'file').doc;
  d.renameEntity('device', d.findEntity('device', 'srv').index, 'server1');
  d.renameEntity('device', d.findEntity('device', 'pc2').index, 'admin-pc');
  const r1i = d.findEntity('device', 'r1').index;
  d.renameInterface(['devices', r1i, 'interfaces', 0], 'lan0');
  const pol = d.result.model.devices.find((x) => x.id === 'r1').policy;
  assert.deepEqual(pol.rules.map((r) => [r.source, r.destination]), [[['admin-pc'], ['server1']], [['users'], ['server1']]]);
  assert.deepEqual(pol.zones[0].interfaces, ['lan0']);
  // the editor starts a policy with the default chosen, and writes a short list as text
  const d2 = ED.ModelDoc.fromText(acl(''), 'y.yaml', 'file').doc;
  d2.addNetPolicy(d2.findEntity('device', 'r1').index, 'deny');
  d2.addRule(['devices', d2.findEntity('device', 'r1').index, 'policy', 'rules'], 'permit');
  d2.setTextList(['devices', d2.findEntity('device', 'r1').index, 'policy', 'rules', 0, 'source'], 'pc, pc2');
  assert.match(d2.exportText(), /policy:\n\s+default: deny\n\s+rules:\n\s+- \{action: permit, source: \[pc, pc2\]\}/);
});

// ------------------------------------------------------------------ capacity

const CA = load('analysis/capacity.js');

// two switches joined by a LAG of two 1G members carrying VLANs 10 and 20; a host pair per VLAN on 10G
const lagNet = (demands, extra = '') => `netatlas: 1
title: Capacity
devices:
  - id: s1
    type: switch
    interfaces: [{id: m1}, {id: m2}, {id: h1, vlans: 10}, {id: h3, vlans: 20}]
    logical_interfaces: [{id: ae0, type: virtual, members: [m1, m2], vlans: [10, 20]}]
  - id: s2
    type: switch
    interfaces: [{id: m1}, {id: m2}, {id: h2, vlans: 10}, {id: h4, vlans: 20}]
    logical_interfaces: [{id: ae0, type: virtual, members: [m1, m2], vlans: [10, 20]}]
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.0.10.1/24}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.0.10.2/24}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.0.20.3/24}]}
  - {id: h4, type: endpoint, interfaces: [{id: eth0, ip: 10.0.20.4/24}]}${extra}
links:
  - {id: lm1, a: s1:m1, b: s2:m1, speed: 1G}
  - {id: lm2, a: s1:m2, b: s2:m2, speed: 1G}
  - {id: l1, a: h1:eth0, b: s1:h1, speed: 10G}
  - {id: l2, a: h2:eth0, b: s2:h2, speed: 10G}
  - {id: l3, a: h3:eth0, b: s1:h3, speed: 10G}
  - {id: l4, a: h4:eth0, b: s2:h4, speed: 10G}
networks:
  - {id: v10, cidr: 10.0.10.0/24, vlan: 10}
  - {id: v20, cidr: 10.0.20.0/24, vlan: 20}
${demands}`;

test('capacity: an aggregate’s surviving members, a single flow’s limit, overload although still carried', () => {
  const m = model(lagNet('demands:\n  - {id: bulk, label: Bulk copy, source: h1, destination: h2, bandwidth: 1500M}\n'));
  const base = CA.capacityAnalysis(m);
  assert.equal(base.evaluated, true);
  const d = base.demands[0];
  assert.deepEqual([d.connectivity, d.verdict], ['retained', 'fits']);
  assert.match(d.text, /fits s1:ae0 \(2 of 2 members up\): 1\.5 Gbit\/s split equally, 1\.5 Gbit\/s on one path, of 2 Gbit\/s/);
  assert.match(d.perFlow, /1\.5 Gbit\/s is more than one member of s1:ae0 .* carries \(1 Gbit\/s\): it fits only as several flows/);
  // one member fails: still carried, now more than the aggregate's surviving capacity
  const w = W.whatIf(m, ['lm1']);
  const ch = w.capacity.changes.find((x) => x.demand.id === 'demand:bulk');
  assert.equal(ch.change, 'overload');
  assert.equal(ch.after.connectivity, 'retained');
  assert.match(ch.after.text, /^exceeds s1:ae0 \(1 of 2 members up\): 1\.5 Gbit\/s split equally/);
});

test('capacity: VLANs on one uplink share it (counted once); without stated traffic it is not evaluated; a missing speed is insufficient information', () => {
  const m = model(lagNet('demands:\n  - {id: a, source: h1, destination: h2, bandwidth: 1200M}\n  - {id: b, source: h3, destination: h4, bandwidth: 1200M}\n'));
  const r = CA.capacityAnalysis(m);
  const lag = r.loads.find((l) => l.resource.id === 'lag:s1:ae0');
  assert.equal(lag.worst, 2.4e9, 'both VLANs’ demands on the one bundle');
  assert.equal(lag.verdict, 'exceeds');
  assert.deepEqual(r.demands.map((x) => x.verdict), ['exceeds', 'exceeds']);
  const none = CA.capacityAnalysis(model(lagNet('')));
  assert.equal(none.evaluated, false);
  assert.match(none.text, /^Capacity is not evaluated: the model states no traffic/);
  const noSpeed = CA.capacityAnalysis(model(lagNet('demands:\n  - {id: a, source: h1, destination: h2, bandwidth: 100M}\n').replace('{id: l1, a: h1:eth0, b: s1:h1, speed: 10G}', '{id: l1, a: h1:eth0, b: s1:h1}')));
  assert.equal(noSpeed.demands[0].verdict, 'unknown');
  assert.match(noSpeed.demands[0].text, /^insufficient information: l1 has no speed written/);
  // an application with an interval states its traffic; one without states none
  const app = model(lagNet('').replace('  - {id: h4, type: endpoint, interfaces: [{id: eth0, ip: 10.0.20.4/24}]}', '  - id: h4\n    type: endpoint\n    interfaces: [{id: eth0, ip: 10.0.20.4/24}]\n    services:\n      applications:\n        - {id: tx, name: Telemetry, profile: udp_sender, peer: h2, port: 5000, interval: 100ms, request_size: 1250}\n        - {id: tx2, name: No rate stated, profile: udp_sender, peer: h2, port: 5001}'));
  const ad = CA.capacityDemands(app);
  assert.deepEqual(ad.map((x) => [x.from, x.to, x.bps, x.source]), [['h4', 'h2', 100000, 'application']], '1250 bytes every 100 ms; the one without an interval states nothing');
});

test('capacity: equal-cost paths are not assumed to share the load equally: fits split, exceeds on one path → depends on the distribution', () => {
  const m = model(mtuNet.replace('{id: r1, ', '{id: r1, ').replace("  - {id: l-r2, a: r1:b, b: r2:a}\n  - {id: l-r3, a: r1:c, b: r3:a}", "  - {id: l-r2, a: r1:b, b: r2:a, speed: 1G}\n  - {id: l-r3, a: r1:c, b: r3:a, speed: 1G}") + 'demands:\n  - {id: d1, source: h1, destination: srv, bandwidth: 1500M}\n');
  const r = CA.capacityAnalysis(m);
  const branch = r.loads.filter((l) => l.resource.id === 'link:l-r2' || l.resource.id === 'link:l-r3');
  assert.deepEqual(branch.map((l) => [l.equal, l.worst, l.verdict]), [[7.5e8, 1.5e9, 'distribution'], [7.5e8, 1.5e9, 'distribution']]);
});

// ------------------------------------------------------------------ saved experiments

const EX = load('analysis/sim/experiment.js');
const FPR = load('model/fingerprint.js');

// The way there moves to r2 when the firewall fails (r1's floating route), but the server still answers via the firewall:
// its route's next hop is on a connected network, so without tracking the route stays and the answer is lost. The experiment
// says so (the static check of the way there says available; the run finds the reply lost).
const withExperiment = guardOnly + `experiments:
  - id: fw-loss
    name: HTTPS after the firewall's loss
    duration: 90s
    params: {link_up_delay: 1s}
    actions:
      - {id: before, at: 10s, do: send, target: pc, to: srv, service: tcp/443}
      - {id: ssh, at: 10s, do: send, target: pc, to: srv, service: tcp/22}
      - {at: 30s, do: fail, target: fw}
      - {id: after, at: 40s, do: send, target: pc, to: srv, service: tcp/443}
    observe:
      - {at: 25s, of: send, target: before, expect: delivered}
      - {at: 25s, of: send, target: ssh, expect: failed}
      - {at: 35s, of: device, target: fw, expect: off}
      - {at: 45s, of: reach, target: pc, to: srv, service: tcp/443, expect: available}
      - {of: send, target: after, expect: failed}
`;

test('experiments: a clean run on scenario time, actions at the same time applied in their written order, observations after them', () => {
  const m = model(withExperiment);
  const exp = m.experiments[0];
  assert.deepEqual([exp.duration, exp.actions.length, exp.observations.length, exp.params.map((p) => p.key)], [90000, 4, 5, ['link-up-delay']]);
  const r = new EX.ExperimentRunner(m, exp, FPR.modelFingerprint(m)).runAll();
  assert.equal(r.state, 'done');
  assert.equal(r.timing, 'scenario');
  assert.deepEqual(r.actions.map((a) => [a.at, a.action.id || a.action.do, a.ok]), [[10000, 'before', true], [10000, 'ssh', true], [30000, 'fail', true], [40000, 'after', true]]);
  assert.deepEqual(r.observations.map((o) => [o.obs.of, o.outcome]), [['send', 'met'], ['send', 'met'], ['device', 'met'], ['reach', 'met'], ['send', 'met']], r.observations.map((o) => o.actual).join(' | '));
  assert.match(r.summary, /^5 observations: 5 met$/);
  // repeatable: a second run from a clean start gives the same result
  const r2 = new EX.ExperimentRunner(m, exp, FPR.modelFingerprint(m)).runAll();
  assert.deepEqual(r2.observations.map((o) => o.actual), r.observations.map((o) => o.actual));
  assert.deepEqual(r2.events, r.events);
});

test('experiments: Stop ends a run where it is (what was not reached is said); runners never share state', () => {
  const m = model(withExperiment);
  const exp = m.experiments[0];
  let fake = 0;
  const clock = () => (fake += 30);
  const a = new EX.ExperimentRunner(m, exp, 'x');
  const b = new EX.ExperimentRunner(m, exp, 'x');
  assert.notEqual(a.gen, b.gen, 'each run its own generation');
  assert.equal(a.step(40, clock), false, 'a slice, not the whole run');
  a.cancel();
  const ra = a.result();
  assert.equal(ra.state, 'stopped');
  assert.ok(ra.observations.every((o) => o.outcome === 'indeterminate' && /not reached: the run was stopped/.test(o.actual)));
  assert.equal(a.step(), true, 'a stopped run does nothing more');
  const rb = b.runAll();
  assert.equal(rb.state, 'done', 'the other runner is unaffected');
});

test('experiments: a baseline and a changed run compared (the model changed: a policy denies HTTPS)', () => {
  const m = model(withExperiment);
  const base = new EX.ExperimentRunner(m, m.experiments[0], FPR.modelFingerprint(m)).runAll();
  const changed = model(withExperiment.replace('simulation: {allow: "tcp/443"}', 'simulation: {allow: "tcp/8443"}'));
  const now = new EX.ExperimentRunner(changed, changed.experiments[0], FPR.modelFingerprint(changed)).runAll();
  const c = EX.compareRuns(base, now);
  assert.equal(c.modelChanged, true);
  const before = c.observations.find((x) => x.obs.target === 'before');
  assert.deepEqual([before.before.outcome, before.after.outcome], ['met', 'not-met']);
  assert.ok(c.diverge, 'the event sequences part');
  assert.match(c.lines.join('\n'), /^Both runs on scenario time \(the simulated clock\), from a clean start, on different versions of the model\./);
});

test('experiments: validation, references that follow renames, and a round trip of the section', () => {
  const errs = (y) => validate.loadModel(y).errors.map((e) => e.message).join(' | ');
  const one = (body) => guardOnly + 'experiments:\n  - id: e\n    name: E\n' + body;
  assert.match(errs(one('    actions: []\n')), /an experiment needs its duration/);
  assert.match(errs(one('    duration: 30s\n    actions:\n      - {at: 10s, do: stream, target: pc}\n')), /"stream" is no action \(a stream runs on real time and is no experiment action\)/);
  assert.match(errs(one('    duration: 30s\n    actions:\n      - {at: 40s, do: power_off, target: pc}\n')), /40s is after the end of the experiment \(30s\)/);
  assert.match(errs(one('    duration: 30s\n    observe:\n      - {of: device, target: pc, expect: up}\n')), /A device’s state expects on or off/);
  assert.match(errs(one('    duration: 30s\n    params: {warp: 2}\n')), /"warp" is no simulation parameter/);
  const w = validate.loadModel(one('    duration: 30s\n    actions:\n      - {at: 1s, do: power_off, target: nowhere}\n')).warnings.map((x) => x.message).join(' | ');
  assert.match(w, /"nowhere" is nothing of the model: this action can't be run/);
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(withExperiment, 'x.yaml', 'file').doc;
  assert.equal(d.exportText(), withExperiment, 'written back as it was');
  d.renameEntity('device', d.findEntity('device', 'srv').index, 'web');
  d.renameEntity('device', d.findEntity('device', 'fw').index, 'fw1');
  const e = d.result.model.experiments[0];
  assert.deepEqual(e.actions.map((a) => [a.target, a.to || '']), [['pc', 'web'], ['pc', 'web'], ['fw1', ''], ['pc', 'web']]);
  assert.equal(e.observations.find((o) => o.of === 'device').target, 'fw1');
});

// ------------------------------------------------------------------ execution scopes

const XS = load('analysis/exec-scope.js');

test('execution scopes: a communication runs its evaluated paths (every alternative, the switch between), the rest is its boundary', () => {
  const m = model(guardOnly);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/443' });
  const s = XS.communicationScope(m, c);
  assert.deepEqual(Array.from(s.devices).sort(), ['fw', 'pc', 'r1', 'srv', 's2'].sort(), 'the path through the firewall, the switch behind it; not the floating way through r2');
  assert.deepEqual(s.boundary.map((b) => `${b.device}:${b.iface}>${b.outside}`), ['r1:b>r2', 's2:p2>r2']);
  assert.deepEqual(s.cannot, []);
  assert.equal(XS.entireScope(m).devices.size, m.devices.length);
});

test('execution scopes: a group, a VLAN and a failure domain; an empty one says it can’t run', () => {
  const m = model(guardOnly.replace('title: Isolation under failures\n', 'title: Isolation under failures\ngroups:\n  - {id: site, label: Site}\n  - {id: dmz, parent: site}\n').replace('  - id: srv\n    type: server\n', '  - id: srv\n    type: server\n    group: dmz\n').replace('  - id: fw\n    type: firewall\n', '  - id: fw\n    type: firewall\n    group: site\n') + 'failure_domains:\n  - {id: cab, label: Cabinet, kind: rack, members: [r2, s2]}\n');
  assert.deepEqual(Array.from(XS.groupScope(m, 'site').devices).sort(), ['fw', 'srv'], 'its subgroups too');
  assert.deepEqual(Array.from(XS.domainScope(m, 'cab').devices).sort(), ['r2', 's2']);
  assert.ok(XS.vlanScope(m, 1).devices.has('s2'));
  assert.match(XS.vlanScope(m, 77).cannot.join(), /no device carries VLAN 77/);
});

test('execution scopes: the scoped simulation runs only the scope; traffic out of it is said to leave it, never answered', () => {
  const m = model(guardOnly);
  const s = XS.groupScope(m, 'nothing');
  assert.equal(s.devices.size, 0);
  const scope = { ...XS.communicationScope(m, C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/443' })) };
  const sub = XS.scopedModel(m, scope);
  assert.deepEqual(sub.devices.map((d) => d.id).sort(), ['fw', 'pc', 'r1', 's2', 'srv']);
  assert.ok(!sub.links.some((l) => l.id === 'l-r2' || l.id === 'l-r2-s'), 'the cables to r2 are its boundary');
  assert.equal(m.devices.length, 6, 'the model itself is unchanged');
  const sim = new S.Simulation(sub);
  sim.engine.run(20000);
  const notes = sim.engine.log.map((e) => e.detail).join('\n');
  assert.match(notes, /leaves the execution scope at (r1:b|s2:p2): r2 is outside it/);
});

// ------------------------------------------------------------------ saved views

test('saved views: validated (diagram, focus, filters, viewport), display state only, references follow renames', () => {
  const base = guardOnly + 'views:\n  - id: fw-close\n    name: The firewall\n    view: logical\n    focus: {target: fw, hops: 2}\n    devices: [pc, fw, srv]\n    hide_types: [switch]\n    options: {labels: false}\n    viewport: {x: 100, y: 50, zoom: 1.5}\n';
  const m = model(base);
  const v = m.views[0];
  assert.deepEqual([v.view, v.focus.target, v.focus.hops, v.devices.join(), v.hideTypes.join(), v.options.labels, v.viewport.zoom], ['logical', 'fw', 2, 'pc,fw,srv', 'switch:l2,switch:l3', false, 1.5], 'a type stands for each of its kinds');
  const errs = (y) => validate.loadModel(y).errors.map((e) => e.message).join(' | ');
  const one = (body) => guardOnly + 'views:\n  - id: v\n    name: V\n' + body;
  assert.match(errs(one('')), /a saved view needs its diagram: physical or logical/);
  assert.match(errs(one('    view: logical\n    focus: {target: fw, context: vlan}\n')), /a VLAN focus needs its VLAN/);
  assert.match(errs(one('    view: logical\n    hide_types: [toaster]\n')), /"toaster" is no device type/);
  assert.match(errs(one('    view: logical\n    viewport: {x: 1, y: 2, zoom: 9}\n')), /"9" is no zoom \(0\.05 to 6\)/);
  assert.match(validate.loadModel(one('    view: logical\n    focus: {target: nowhere}\n')).warnings.map((w) => w.message).join(), /"nowhere" is nothing of the model: the view opens without its focus/);
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(base, 'x.yaml', 'file').doc;
  assert.equal(d.exportText(), base, 'written back as it was');
  d.renameEntity('device', d.findEntity('device', 'fw').index, 'fw1');
  const w = d.result.model.views[0];
  assert.deepEqual([w.focus.target, w.devices.join()], ['fw1', 'pc,fw1,srv']);
});

// ------------------------------------------------------------------ collapsed groups

test('collapsed groups: one box per outermost group; boundary cables and relations go to it, the inside ones are counted', () => {
  const CO = load('model/collapse.js');
  const m = model(guardOnly.replace('title: Isolation under failures\n', 'title: Isolation under failures\ngroups:\n  - {id: site, label: Site}\n  - {id: dmz, parent: site}\n').replace('  - id: srv\n    type: server\n', '  - id: srv\n    type: server\n    group: dmz\n').replace('  - id: s2\n    type: switch\n', '  - id: s2\n    type: switch\n    group: dmz\n').replace('  - id: fw\n    type: firewall\n', '  - id: fw\n    type: firewall\n    group: site\n'));
  const c = CO.collapseGroups(m, new Set(['site', 'dmz']));
  const box = c.devices.find((d) => d.id === '⊞site');
  assert.ok(box, 'the outermost collapsed group is the box');
  assert.ok(!c.devices.some((d) => ['fw', 'srv', 's2'].includes(d.id)) && !c.devices.some((d) => d.id === '⊞dmz'));
  assert.match(box.label, /^Site: 3 devices, 2 cables inside \(collapsed\)$/);
  assert.deepEqual(c.links.filter((l) => l.a.device === '⊞site' || l.b.device === '⊞site').map((l) => l.id).sort(), ['l-fw', 'l-r2-s']);
  assert.ok(!c.links.some((l) => l.id === 'l-srv' || l.id === 'l-fw-s'), 'the cables inside are not drawn');
  assert.ok(box.interfaces.some((i) => i.id === 'fw-a') && box.interfaces.some((i) => i.id === 's2-p2'), 'a port per inside end');
  assert.equal(CO.collapsedGroup('⊞site'), 'site');
  assert.equal(m.devices.length, 6, 'the model itself is unchanged');
  assert.equal(CO.collapseGroups(m, new Set()), m);
});

// ------------------------------------------------------------------ bulk port edits

test('bulk port edit: planned with a preview (before, after, what is left and why), applied as one undo step', () => {
  const BP = load('model/bulk-ports.js');
  const ED = load('editor/document.js');
  const y = 'netatlas: 1\ntitle: Bulk\ndevices:\n  - id: sw\n    type: switch\n    interfaces:\n      - {id: p1, vlans: 10}\n      - {id: p2, vlans: 10}\n      - {id: p3, vlans: [10, 20], native: 10}\n      - {id: p4, vlans: 30}\n';
  const d = ED.ModelDoc.fromText(y, 'b.yaml', 'file').doc;
  const sw = d.result.model.index.devices.get('sw');
  const add = BP.planPortEdit(sw, ['p1', 'p2', 'p3'], { kind: 'add', vlan: 20 });
  assert.deepEqual(add.map((r) => [r.port, r.before, r.after, r.note || '']), [
    ['p1', 'access 10', 'trunk 10, 20 (native 10)', ''],
    ['p2', 'access 10', 'trunk 10, 20 (native 10)', ''],
    ['p3', 'trunk 10, 20 (native 10)', 'trunk 10, 20 (native 10)', 'already carries VLAN 20'],
  ], 'an access port keeps its untagged VLAN as the native');
  const before = d.exportText();
  assert.equal(d.applyPortPlan(0, add, 'Add VLAN 20 to 3 ports'), 2);
  assert.match(d.exportText(), /- \{id: p1, vlans: \[10, 20\], native: 10\}\n {6}- \{id: p2, vlans: \[10, 20\], native: 10\}/);
  d.undo();
  assert.equal(d.exportText(), before, 'one undo step for every port');
  const rm = BP.planPortEdit(sw, ['p3', 'p4'], { kind: 'remove', vlan: 10 });
  assert.deepEqual(rm.map((r) => [r.port, r.after, r.note || '']), [['p3', 'access 20', ''], ['p4', 'access 30', 'does not carry VLAN 10']]);
  const tr = BP.planPortEdit(sw, ['p4'], { kind: 'trunk', vlans: [30, 31, 32, 33], native: 99 });
  d.applyPortPlan(0, tr, 'trunk');
  assert.match(d.exportText(), /- \{id: p4, vlans: \["?30-33"?, 99\], native: 99\}/);
});
