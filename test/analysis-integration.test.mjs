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
