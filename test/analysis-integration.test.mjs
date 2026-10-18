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
import { validate, load } from './helpers.mjs';

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
