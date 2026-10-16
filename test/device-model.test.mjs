// The device model: the 15 types with their kinds, roles, modes and System
// purposes; the capability resolver every module decides by; the VPN
// Gateway and the Separation gateway with their built-in functions; and how
// the tracer, the simulation, the single points of failure and the editor
// follow them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, validate, example } from './helpers.mjs';

const Cap = load('model/capabilities.js');
const DT = load('model/device-types.js');
const Sep = load('analysis/separation.js');
const T = load('analysis/trace.js');
const S = load('analysis/sim/simulation.js');
const F = load('analysis/failure.js');
const D = load('editor/document.js');
const Q = load('model/queries.js');
const Dv = load('model/derive.js');
const L = load('diagram/legend.js');
const { deviceTier } = Cap;
const openDoc = (text) => D.ModelDoc.fromText(text, 't.yaml', 'file').doc;

const errs = (text) => validate.loadModel(text).errors.map((e) => `${e.path}: ${e.message}`);
const one = (dev, extra = '') => `netatlas: 1\ndevices:\n  - id: d1\n${dev}${extra}`;
const sim = (text) => new S.Simulation(model(text));
const ev = (s, f) => s.events().filter(f);

// ------------------------------------------------------------ the capability resolver

test('capabilities: what each type does, by its mode, Supports Layer 3, purpose and implementation', () => {
  const c = (d) => Cap.capabilities(d);
  // forwarding
  assert.ok(c({ type: 'router' }).l3Forward && !c({ type: 'router' }).l2Forward);
  assert.ok(c({ type: 'switch' }).l2Forward && !c({ type: 'switch' }).l3Forward && c({ type: 'switch', layer3: true }).l3Forward);
  assert.ok(c({ type: 'firewall' }).l3Forward && c({ type: 'firewall' }).policy, 'a firewall routes by default');
  assert.ok(c({ type: 'firewall', mode: 'transparent' }).l2Forward && !c({ type: 'firewall', mode: 'transparent' }).l3Forward && c({ type: 'firewall', mode: 'transparent' }).policy);
  assert.ok(c({ type: 'ids_ips' }).inline && c({ type: 'ids_ips' }).needsPortPairs, 'an IDS/IPS is inline by default');
  assert.ok(c({ type: 'ids_ips', mode: 'passive' }).passiveCopy && !c({ type: 'ids_ips', mode: 'passive' }).l2Transit);
  assert.ok(c({ type: 'cloud' }).externalTransit && !c({ type: 'cloud' }).ipStack);
  assert.ok(c({ type: 'vpn_gateway' }).vpnTermination && c({ type: 'vpn_gateway' }).vpnOnlyTransit);
  // a Separation gateway: nothing without an implementation, then what the implementation does
  assert.ok(!c({ type: 'separation_gateway' }).l2Forward && !c({ type: 'separation_gateway' }).l3Forward && c({ type: 'separation_gateway' }).separationGateway);
  assert.ok(c({ type: 'separation_gateway', separation: { implementation: 'filtering_bridge' } }).l2Forward);
  assert.ok(c({ type: 'separation_gateway', separation: { implementation: 'filtering_router' } }).l3Forward);
  const pb = c({ type: 'separation_gateway', separation: { implementation: 'protocol_break' } });
  assert.ok(pb.sessionBreak && !pb.l3Forward && !pb.l2Forward);
  // a System by its purpose; without one it does nothing
  assert.ok(c({ type: 'system', purpose: 'host' }).host);
  assert.ok(c({ type: 'system', purpose: 'l2_forwarder' }).l2Forward);
  assert.ok(c({ type: 'system', purpose: 'l3_forwarder' }).l3Forward);
  assert.ok(c({ type: 'system', purpose: 'inline' }).inline && c({ type: 'system', purpose: 'inline' }).needsPortPairs);
  assert.ok(c({ type: 'system', purpose: 'passive_monitor' }).passiveCopy);
  assert.ok(c({ type: 'system', purpose: 'pass_through' }).passThrough && !c({ type: 'system', purpose: 'pass_through' }).ipStack);
  assert.ok(c({ type: 'system', purpose: 'external_network' }).externalTransit);
  assert.ok(!c({ type: 'system' }).l2Forward && !c({ type: 'system' }).l3Forward && !c({ type: 'system' }).host);
  // guests and their hosts
  assert.equal(c({ type: 'vm' }).canBeGuest, 'vm');
  assert.equal(c({ type: 'container' }).canBeGuest, 'container');
  assert.deepEqual(c({ type: 'server' }).canHostGuests, { vms: true, containers: true });
  assert.deepEqual(c({ type: 'vm' }).canHostGuests, { vms: false, containers: true });
  // a capability is potential: it gives no connectivity by itself
  assert.equal(Cap.deviceRoutingRole({ type: 'storage' }), 'host');
});

test('roles: a known role gives the row; a custom one falls back to what the device does (deterministic)', () => {
  assert.equal(deviceTier({ type: 'switch', role: 'spine' }), 3);
  assert.equal(deviceTier({ type: 'switch', role: 'leaf' }), 4);
  assert.equal(deviceTier({ type: 'router', role: 'pe' }), 1);
  assert.equal(deviceTier({ type: 'switch', role: 'my-special-role' }), deviceTier({ type: 'switch' }));
  assert.equal(deviceTier({ type: 'cloud' }), 0);
  assert.equal(deviceTier({ type: 'ids_ips', mode: 'passive' }), deviceTier({ type: 'server' }));
  for (const r of DT.ROLES) assert.ok(Number.isInteger(r.tier) && r.label, r.id);
});

// ------------------------------------------------------------ kinds, roles, modes, purposes

test('kinds are optional; "other" needs its name; a kind belongs to its type', () => {
  assert.deepEqual(errs(one('    type: firewall\n    kind: ngfw\n    interfaces: [a, b]\n')), []);
  assert.deepEqual(errs(one('    type: firewall\n    interfaces: [a, b]\n')), []);
  assert.match(errs(one('    type: firewall\n    kind: plc\n    interfaces: [a]\n'))[0], /"plc" is not a kind of Firewall/);
  assert.match(errs(one('    type: switch\n    kind: other\n    interfaces: [{id: a, vlans: 1}]\n'))[0], /kind "other" needs its name: write kind_label/);
  assert.deepEqual(errs(one('    type: switch\n    kind: other\n    kind_label: Ruggedised switch\n    interfaces: [{id: a, vlans: 1}]\n')), []);
  for (const t of DT.DEVICE_TYPES) assert.ok(DT.kindsOf(t.id).some((k) => k.id === 'other'), `${t.id} offers Other`);
  const m = model(one('    type: endpoint\n    kind: other\n    kind_label: Badge reader\n    interfaces: [a]\n'));
  assert.equal(DT.deviceTypeLine(m.devices[0]), 'Endpoint · Badge reader');
});

test('roles: suggested or custom; Find and the palette find a device by its role', () => {
  const m = model(`netatlas: 1\ndevices:\n  - {id: s1, type: switch, role: core, interfaces: [{id: a, vlans: 1}]}\n  - {id: s2, type: switch, role: dmz-edge, interfaces: [{id: a, vlans: 1}]}\n`);
  assert.equal(m.devices[0].role, 'core');
  assert.equal(m.devices[1].role, 'dmz-edge');
  assert.ok(Q.search(m, 'core').some((h) => h.ref === 'device:s1'));
  assert.ok(Q.search(m, 'dmz-edge').some((h) => h.ref === 'device:s2'));
  const P = load('ui/palette.js');
  assert.match(P.objectItems(m).find((x) => x.key === 'ref:device:s1').words, /\bcore\b/);
  assert.match(errs(one('    type: switch\n    role: "core!!"\n    interfaces: [{id: a, vlans: 1}]\n'))[0], /is not a role/);
});

test('modes: a firewall, an IDS/IPS and an access point have one; no other type does', () => {
  assert.deepEqual(errs(one('    type: firewall\n    mode: transparent\n    management: [m]\n    interfaces: [a, b, {id: m, ip: 10.9.9.1/24}]\n')), []);
  assert.match(errs(one('    type: router\n    mode: transparent\n    interfaces: [a]\n'))[0], /has no mode/);
  assert.match(errs(one('    type: firewall\n    mode: bridge\n    interfaces: [a]\n'))[0], /"bridge" is not a mode of Firewall: use routed or transparent/);
  // a transparent firewall's data ports have no addresses
  assert.ok(errs(one('    type: firewall\n    mode: transparent\n    interfaces: [{id: a, ip: 10.0.0.1/24}, b]\n')).some((e) => /a transparent firewall|no address/.test(e)));
});

test('a System says what it does: its purpose is required, its icon is one of its purpose\'s', () => {
  assert.match(errs(one('    type: system\n    interfaces: [a]\n'))[0], /System "d1" needs its purpose: what it does \(host, l2_forwarder, l3_forwarder, inline, passive_monitor, pass_through, external_network\)/);
  assert.deepEqual(errs(one('    type: system\n    purpose: host\n    icon: console\n    interfaces: [a]\n')), []);
  assert.match(errs(one('    type: system\n    purpose: host\n    icon: tap\n    interfaces: [a]\n'))[0], /"tap" is not an icon of a Host System/);
  assert.match(errs(one('    type: router\n    purpose: host\n    interfaces: [a]\n'))[0], /only a System has a purpose/);
  // inline and pass-through: their port pairs are required
  assert.match(errs(one('    type: system\n    purpose: pass_through\n    interfaces: [a, b]\n'))[0], /passes traffic only between paired ports: write its port_pairs/);
  assert.deepEqual(errs(one('    type: system\n    purpose: pass_through\n    port_pairs: [{a: a, b: b, copy: [c]}]\n    interfaces: [a, b, c]\n')), []);
  assert.ok(errs(one('    type: system\n    purpose: pass_through\n    port_pairs: [{a: a, b: x}]\n    interfaces: [a, b]\n')).some((e) => /x/.test(e)));
});

test('the removed types say what they became', () => {
  assert.match(errs(one('    type: gateway\n    interfaces: [a]\n'))[0], /unknown device type "gateway" \(.*vpn_gateway.*\)/);
  assert.match(errs(one('    type: proxy\n    interfaces: [a]\n'))[0], /an application proxy is a server, vm or container; a boundary between security domains is a separation_gateway/);
});

// ------------------------------------------------------------ the VPN Gateway

const vpnGw = (vpn, more = '') => one(`    type: vpn_gateway\n${vpn}    interfaces: [{id: wan0, ip: 192.0.2.2/30}, {id: lan0, ip: 10.1.0.1/24}]\n    logical_interfaces: [{id: st0, type: tunnel, ip: 169.254.0.1/30, source: wan0, destination: 198.51.100.2}]\n${more}`);

test('VPN Gateway: its VPN gateway function is required and conditional, and nothing is chosen for it', () => {
  assert.match(errs(vpnGw(''))[0], /VPN Gateway "d1" needs its VPN gateway configuration/);
  const e = errs(vpnGw('    services:\n      vpn: {}\n'));
  assert.ok(e.some((x) => /needs its operation/.test(x)) && e.some((x) => /needs its technology/.test(x)), e.join('\n'));
  // site to site: tunnels; no listener or pool
  assert.deepEqual(errs(vpnGw('    services:\n      vpn: {operation: site_to_site, technology: ipsec, tunnels: [st0], protected: [10.1.0.0/24]}\n')), []);
  assert.ok(errs(vpnGw('    services:\n      vpn: {operation: site_to_site, technology: ipsec, protected: [10.1.0.0/24]}\n')).some((x) => /needs its tunnels/.test(x)));
  assert.ok(errs(vpnGw('    services:\n      vpn: {operation: site_to_site, technology: ipsec, tunnels: [st0], pool: 10.250.0.0/24, protected: [10.1.0.0/24]}\n')).some((x) => /"pool" is for remote access/.test(x)));
  assert.ok(errs(vpnGw('    services:\n      vpn: {operation: site_to_site, technology: ipsec, tunnels: [lan0], protected: [10.1.0.0/24]}\n')).some((x) => /a VPN tunnel is a tunnel interface/.test(x)));
  // remote access: a listener and a pool, no fixed peer
  assert.deepEqual(errs(vpnGw('    services:\n      vpn: {operation: remote_access, technology: wireguard, listener: wan0, pool: 10.250.0.0/24, protected: [10.1.0.0/24]}\n')), []);
  assert.ok(errs(vpnGw('    services:\n      vpn: {operation: remote_access, technology: wireguard, protected: [10.1.0.0/24]}\n')).some((x) => /needs its listener/.test(x)));
  // a technology NetAtlas does not support is reported, not replaced
  assert.ok(errs(vpnGw('    services:\n      vpn: {operation: site_to_site, technology: pptp, tunnels: [st0], protected: [10.1.0.0/24]}\n')).some((x) => /"pptp" is not a supported VPN technology/.test(x)));
  // only a VPN Gateway has it built in (the VPN service on other devices comes with the service registry)
  assert.ok(errs(one('    type: router\n    services:\n      vpn: {operation: site_to_site}\n    interfaces: [a]\n')).length > 0);
});

test('VPN Gateway: it forwards only to and from its VPN, in the tracer and in the simulation', () => {
  const m = model(example('wan-vpn.yaml'));
  const out = T.tracePath(m, { from: 'hq-pc', to: '192.0.2.10' });
  assert.equal(out.paths[0].end.kind, 'stopped');
  assert.equal(out.paths[0].end.reason, 'denied');
  assert.match(out.paths[0].end.detail, /hq-vpn is a VPN Gateway: it forwards only to and from its VPN \(tunnels st0\), not from lan0 to wan0/);
  const ok = T.tracePath(m, { from: 'br2-pc', to: 'hq-pc' });
  assert.equal(ok.paths[0].end.kind, 'reached');
  assert.ok(ok.paths[0].hops.some((h) => h.notes.some((n) => /forwards it through its VPN \(st0\)/.test(n))));
  const s = new S.Simulation(m);
  s.runTo(9000);
  assert.ok(ev(s, (e) => e.device === 'hq-vpn' && /is a VPN Gateway: it forwards only to and from its VPN/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'br2-pc' && e.what === 'Test answered').length >= 1, 'through the tunnel');
});

// ------------------------------------------------------------ the Separation gateway

const SEP = (impl, extra = '') => `netatlas: 1
devices:
  - id: g
    type: separation_gateway
    services:
      separation:
        implementation: ${impl}
        domains:
          - {name: A, interfaces: [a0]}
          - {name: B, interfaces: [b0]}
        directions:
          - {from: A, to: B}
${extra}    management: [m0]
    interfaces: [{id: a0${impl === 'filtering_bridge' ? '' : ', ip: 10.1.0.1/24'}}, {id: b0${impl === 'filtering_bridge' ? '' : ', ip: 10.2.0.1/24'}}, {id: m0, ip: 10.9.0.1/24}]
`;

test('Separation gateway: its configuration — an implementation (no default), exactly two domains, directions, explicit rules', () => {
  assert.match(errs(`netatlas: 1\ndevices:\n  - {id: g, type: separation_gateway, interfaces: [a]}\n`)[0], /needs its Domain separation/);
  const noImpl = errs(SEP('').replace('        implementation: \n', ''));
  assert.ok(noImpl.some((x) => /Domain separation needs its implementation/.test(x)), noImpl.join('\n'));
  assert.deepEqual(errs(SEP('filtering_router')), []);
  assert.ok(errs(SEP('filtering_router').replace('          - {name: B, interfaces: [b0]}\n', '')).some((x) => /exactly two domains/.test(x)));
  assert.ok(errs(SEP('filtering_router').replace('[b0]}', '[a0]}')).some((x) => /a0/.test(x)), 'an interface in both domains');
  assert.ok(errs(SEP('filtering_router').replace('[b0]}', '[m0]}')).some((x) => /management/.test(x)), 'a management interface in a domain');
  // a rule writes every match: nothing empty is "any"
  const rule = (r) => `        rules:\n          - ${r}\n`;
  assert.deepEqual(errs(SEP('filtering_router', rule('{id: r1, from: A, to: B, source: any, destination: 10.2.0.5, protocol: tcp, ports: "443"}'))), []);
  assert.ok(errs(SEP('filtering_router', rule('{id: r1, from: A, to: B, destination: 10.2.0.5, protocol: tcp, ports: "443"}'))).some((x) => /needs its source: an address, a prefix or "any" \(written; an empty match is never "any"\)/.test(x)));
  assert.ok(errs(SEP('filtering_router', rule('{id: r1, from: A, to: B, source: any, destination: any, protocol: tcp}'))).some((x) => /needs its destination ports/.test(x)));
  assert.ok(errs(SEP('filtering_router', rule('{id: r1, from: B, to: A, source: any, destination: any, protocol: icmp}'))).some((x) => /a direction that is not permitted/.test(x)));
  // transfer profiles are a protocol break's, and each of its rules names one
  assert.ok(errs(SEP('filtering_router', '        profiles: [{id: w, type: https, listen: {interface: a0, port: 443}, forward: {address: 10.2.0.5, port: 443}}]\n')).some((x) => /transfer profiles are a protocol break's/.test(x)));
  assert.ok(errs(SEP('protocol_break', rule('{id: r1, from: A, to: B, source: any, destination: 10.2.0.5, protocol: tcp, ports: "443"}'))).some((x) => /needs its transfer profile/.test(x)));
  assert.ok(errs(SEP('protocol_break', '        profiles: [{id: w, type: ftp, listen: {interface: a0, port: 21}, forward: {address: 10.2.0.5, port: 21}}]\n')).some((x) => /"ftp" is not a transfer NetAtlas can model/.test(x)));
  // the separation function exists only there
  assert.ok(errs(one('    type: server\n    services:\n      separation: {implementation: filtering_router}\n    interfaces: [a]\n')).length > 0);
});

test('policy semantics: rules in order, then the default deny; replies are no permission to start the other way', () => {
  const m = model(SEP('filtering_router', `        rules:
          - {id: web, from: A, to: B, source: 10.1.0.0/24, destination: 10.2.0.5, protocol: tcp, ports: "443, 8000-8080"}
          - {id: ping, from: A, to: B, source: any, destination: any, protocol: icmp}
`));
  const g = m.devices[0];
  const a = (s) => validate.loadModel ? load('model/ip.js').parseAddress(s) : null;
  const d = (src, dst, proto, dport, inI = 'a0', outI = 'b0') => Sep.decide(g, { inIface: inI, outIface: outI, src: a(src), dst: a(dst), proto, dport });
  assert.equal(d('10.1.0.7', '10.2.0.5', 'tcp', 443).rule.id, 'web');
  assert.equal(d('10.1.0.7', '10.2.0.5', 'tcp', 8080).ok, true);
  assert.equal(d('10.1.0.7', '10.2.0.5', 'tcp', 22).ok, false);
  assert.match(d('10.1.0.7', '10.2.0.5', 'tcp', 22).text, /denies it: no rule permits it A → B/);
  assert.equal(d('10.3.0.7', '10.2.0.9', 'icmp').rule.id, 'ping', 'the second rule, any to any written');
  assert.match(d('10.2.0.5', '10.1.0.7', 'icmp', undefined, 'b0', 'a0').text, /B → A is not a permitted direction/);
  assert.match(d('10.9.0.5', '10.2.0.5', 'icmp', undefined, 'm0', 'b0').text, /is in neither domain/, 'management is no way in');
  // an empty policy permits nothing
  const empty = model(SEP('filtering_router')).devices[0];
  assert.match(Sep.decide(empty, { inIface: 'a0', outIface: 'b0', src: a('10.1.0.7'), dst: a('10.2.0.5'), proto: 'icmp' }).text, /it has no rules: an empty policy permits nothing/);
});

test('filtering bridge and router: trace with and without a service; the simulation lets replies back and denies the rest', () => {
  const m = model(example('separation-filtering.yaml'));
  const tr = (from, to, service) => T.tracePath(m, { from, to, service });
  assert.equal(tr('office-ws', '10.30.0.20', 'tcp/443').paths[0].end.kind, 'reached');
  const no = tr('office-ws', '10.30.0.20', 'tcp/22').paths[0].end;
  assert.equal(no.reason, 'denied');
  assert.equal(no.device, 'fbr');
  assert.match(tr('office-ws', '10.30.0.20').paths[0].hops[0].notes.join(' '), /fbr permits only tcp 443 \(rule office-web\)/);
  assert.match(tr('lab-ws', '10.30.0.10', 'icmp').paths[0].end.detail, /Lab → Office is not a permitted direction/);
  assert.equal(tr('low-sensor', '10.40.1.10', 'udp/514').paths[0].end.kind, 'reached');
  assert.match(tr('high-col', '10.40.2.20', 'icmp').paths[0].end.detail, /HIGH → LOW is not a permitted direction/);
  assert.match(T.parseService('tcp 443x') + '', /is not a service/);
  const s = new S.Simulation(m);
  s.runTo(9000);
  assert.ok(ev(s, (e) => e.device === 'office-ws' && e.what === 'Test answered' && /tcp\/443/.test(e.detail)).length >= 1, 'the permitted transfer and its replies');
  assert.ok(ev(s, (e) => e.device === 'fbr' && e.what === 'denied' && /10\.30\.0\.20:22/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'fbr' && e.what === 'denied' && /Lab → Office is not a permitted direction/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'frt' && e.what === 'permitted' && /rule low-syslog/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'low-sensor' && e.what === 'Test failed' && /tcp\/22/.test(e.detail)).length >= 1);
});

test('protocol break: two correlated legs, never a packet through; a transfer without a rule ends at the gateway', () => {
  const m = model(example('cross-domain.yaml'));
  const t = T.tracePath(m, { from: 'red-ws', to: '10.10.0.1', service: 'tcp/443' });
  assert.equal(t.paths[0].end.kind, 'reached');
  assert.equal(t.legs.length, 1);
  assert.match(t.legs[0].note, /the https request from 10\.10\.0\.10 ends at cdg:red0 port 443 \(leg 1\); cdg starts a new TCP transfer of its own to 10\.20\.0\.80:443 \(leg 2, profile web, rule red-web/);
  assert.equal(t.legs[0].trace.paths[0].end.kind, 'reached');
  assert.match(T.traceText(t), /Leg 2 \(protocol break\): cdg → 10\.20\.0\.80, tcp\/443/);
  assert.ok(T.traceRefs(t).main.has('device:black-web'), 'leg 2 is marked with the path');
  const through = T.tracePath(m, { from: 'red-ws', to: '10.20.0.80', service: 'tcp/22' }).paths[0].end;
  assert.equal(through.reason, 'denied');
  assert.match(through.detail, /cdg is a protocol break: nothing passes through it/);
  const s = new S.Simulation(m);
  s.runTo(9000);
  assert.ok(ev(s, (e) => e.device === 'cdg' && e.what === 'leg 2' && /nothing of leg 1 crosses/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'cdg' && e.what === 'relayed').length >= 1, 'the answer goes back on leg 1');
  assert.ok(ev(s, (e) => e.device === 'red-ws' && e.what === 'Test answered' && /tcp\/443/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'cdg' && /not routed at cdg: it is a protocol break/.test(e.detail)).length >= 1);
});

test('protocol break over UDP: a DNS query is asked again by the gateway; the answer comes back', () => {
  const text = `netatlas: 1
devices:
  - {id: c, type: endpoint, interfaces: [{id: e, ip: 10.1.0.10/24}], simulation: {test_traffic: "on", test_targets: "10.1.0.1 udp/53", test_interval: 10}}
  - id: g
    type: separation_gateway
    services:
      separation:
        implementation: protocol_break
        domains: [{name: A, interfaces: [a0]}, {name: B, interfaces: [b0]}]
        directions: [{from: A, to: B}]
        profiles: [{id: q, type: dns, listen: {interface: a0, port: 53}, forward: {address: 10.2.0.53, port: 53}}]
        rules: [{id: dns, from: A, to: B, source: 10.1.0.0/24, destination: 10.2.0.53, protocol: udp, ports: "53", profile: q}]
    interfaces: [{id: a0, ip: 10.1.0.1/24}, {id: b0, ip: 10.2.0.1/24}]
  - {id: ns, type: server, interfaces: [{id: e, ip: 10.2.0.53/24}]}
links:
  - {id: l1, a: "c:e", b: "g:a0"}
  - {id: l2, a: "g:b0", b: "ns:e"}
relations:
  - {id: r, protocol: dns, endpoints: [g, ns]}
`;
  const s = sim(text);
  s.runTo(5000);
  assert.ok(ev(s, (e) => e.device === 'g' && e.what === 'leg 2' && /the dns query from 10\.1\.0\.10/i.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'c' && e.what === 'Test answered').length >= 1, 'the gateway answers on leg 1');
});

test('port pairs: an inline device keeps to its pairs, one way if set; a TAP copies to its monitor port', () => {
  const ot = model(example('ot-network.yaml'));
  const t = T.tracePath(ot, { from: 'eng-ws', to: 'plc' });
  assert.equal(t.paths[0].end.kind, 'reached');
  assert.ok(t.paths[0].hops.some((h) => h.notes.some((n) => /tap gives a copy of what passes net-a ↔ net-b to mon/.test(n))));
  const s = new S.Simulation(ot);
  s.runTo(5000);
  assert.ok(ev(s, (e) => e.device === 'ids' && e.what === 'observed' && /receives a copy at mon0 and forwards nothing/.test(e.detail)).length >= 1);
  // one way: a → b only
  const oneWay = `netatlas: 1
devices:
  - {id: x, type: endpoint, interfaces: [{id: e, ip: 10.0.0.1/24}], simulation: {test_traffic: "on", test_targets: "10.0.0.2 icmp", test_interval: 10}}
  - {id: y, type: endpoint, interfaces: [{id: e, ip: 10.0.0.2/24}]}
  - {id: dio, type: system, purpose: inline, icon: diode, port_pairs: [{a: p1, b: p2, direction: a_to_b}], interfaces: [p1, p2]}
links:
  - {id: l1, a: "x:e", b: "dio:p1"}
  - {id: l2, a: "dio:p2", b: "y:e"}
`;
  const ow = sim(oneWay);
  ow.runTo(5000);
  assert.ok(ev(ow, (e) => e.device === 'dio' && /passes traffic one way only, from p1 to p2/.test(e.detail)).length >= 1, 'the reply (and ARP) from p2 ends there');
  const back = T.tracePath(model(oneWay), { from: 'y', to: 'x' });
  assert.equal(back.paths[0].end.kind, 'stopped');
});

test('a Cloud is one opaque Layer 3 hop: the TTL drops by one; TTL-1 hellos end at it', () => {
  const m = model(example('wan-vpn.yaml'));
  const s = new S.Simulation(m);
  s.runTo(5000);
  assert.ok(ev(s, (e) => e.device === 'br1-pc' && e.what === 'Test answered').length >= 1);
  const ttl1 = `netatlas: 1
devices:
  - {id: r1, type: router, protocols: {ospf: {}}, router_id: 10.0.0.1, interfaces: [{id: g0, ip: 10.0.12.1/30}]}
  - {id: r2, type: router, protocols: {ospf: {}}, router_id: 10.0.0.2, interfaces: [{id: g0, ip: 10.0.12.2/30}]}
  - {id: net, type: cloud, interfaces: [a, b]}
links:
  - {id: a, a: "r1:g0", b: "net:a"}
  - {id: b, a: "net:b", b: "r2:g0"}
relations:
  - {id: o, protocol: ospf, endpoints: ["r1:g0", "r2:g0"], attrs: {area: 0}}
`;
  const o = sim(ttl1);
  o.runTo(15000);
  assert.ok(ev(o, (e) => e.device === 'net' && /net is a Layer 3 hop \(an external network\): .*does not cross it — run it through a tunnel/.test(e.detail)).length >= 1);
  assert.notEqual((o.status().find((r) => r.name.indexOf('o') === 0 && r.protocol === 'ospf') || {}).state, 'Full');
});

test('single points of failure follow what each device joins: domains only with a permitted transfer, pairs, no management path', () => {
  const g = (text) => model(text).devices.find((d) => d.id === 'g');
  const groups = F.portGroups(g(SEP('filtering_router', '        rules: [{id: r, from: A, to: B, source: any, destination: any, protocol: icmp}]\n')));
  assert.deepEqual(groups, [['a0', 'b0'], ['m0']]);
  assert.deepEqual(F.portGroups(g(SEP('filtering_router'))), [['a0'], ['b0'], ['m0']], 'no rule: the domains are not joined');
  const ot = model(example('ot-network.yaml'));
  assert.deepEqual(F.portGroups(ot.devices.find((d) => d.id === 'tap')), [['net-a', 'net-b', 'mon']]);
  assert.deepEqual(F.portGroups(ot.devices.find((d) => d.id === 'ids')), [['mon0']]);
  const cd = F.singlePointsOfFailure(model(example('cross-domain.yaml')));
  const gw = cd.find((x) => x.ref === 'device:cdg');
  assert.ok(gw && gw.isolated.some((grp) => grp.indexOf('red-ws') >= 0 || grp.indexOf('black-web') >= 0));
  assert.ok(!gw.isolated.some((grp) => grp.indexOf('mgmt-st') >= 0), 'the management network never reached the domains');
});

// ------------------------------------------------------------ cloud groups and cloud instances

test('cloud groups: region, VPC and VNet with their provider; VMs and containers in them are cloud instances without a host', () => {
  const m = model(example('hybrid-cloud.yaml'));
  const vpc = m.groups.find((x) => x.id === 'vpc-prod');
  assert.equal(vpc.kind, 'vpc');
  assert.equal(vpc.provider, 'aws');
  const types = load('model/types.js');
  assert.equal(types.groupKindText(vpc), 'VPC · AWS');
  assert.equal(types.groupKindText(m.groups.find((x) => x.id === 'az-weu')), 'Cloud region · Azure');
  for (const id of ['web-1', 'app-1', 'jobs']) {
    const d = m.index.devices.get(id);
    assert.ok(d.cloudInstance && d.host === undefined && d.interfaces.length === 1, id);
  }
  assert.equal(T.tracePath(m, { from: 'dc-pc', to: 'app-1' }).paths[0].end.kind, 'reached');
  // a provider is a cloud group's; a VM outside a cloud group still needs its host
  assert.match(errs('netatlas: 1\ngroups:\n  - {id: s, kind: site, provider: aws}\n')[0], /"provider" is a cloud group's/);
  assert.match(errs('netatlas: 1\ngroups:\n  - {id: s, kind: site}\ndevices:\n  - {id: v, type: vm, group: s, interfaces: [{id: e, ip: 10.0.0.1/24}]}\n').join('\n'), /needs its host/);
});

// ------------------------------------------------------------ the diagram and the editor

test('the diagram says what a port is for (its domain, management, its pair) and draws each glyph once in the legend', () => {
  const cd = model(example('cross-domain.yaml'));
  const end = (dev, iface) => Dv.endTagText(cd, { device: dev, iface });
  assert.match(end('cdg', 'red0'), /^domain Red/);
  assert.match(end('cdg', 'mgmt0'), /^management/);
  const ot = model(example('ot-network.yaml'));
  assert.equal(Dv.endRoleText(ot, { device: 'tap', iface: 'mon' }), 'copy');
  assert.equal(Dv.endRoleText(ot, { device: 'tap', iface: 'net-a' }), 'pair');
  const labels = L.legendOf(ot, 'physical').sections[0].items.map((x) => x.label);
  assert.ok(labels.some((x) => /^Endpoint · PLC/.test(x)) && labels.some((x) => /^System · Pass-through, Network TAP/.test(x)) && labels.some((x) => /^Switch|Layer 2 switch/.test(x)), labels.join(' | '));
});

test('editor: changing the type, mode, purpose or implementation lists what goes, removes it in one undo step, chooses nothing new', () => {
  const d = openDoc(example('device-types.yaml'));
  const idx = d.entities('device').find((x) => x.id === 'fw').index;
  const plan = d.deviceModelPlan(idx, 'type', 'switch');
  const texts = plan.removed.map((x) => x.text);
  assert.ok(texts.some((x) => /^kind: ngfw/.test(x)), texts.join(' | '));
  assert.ok(texts.some((x) => /static routes/.test(x)) === false, 'a switch keeps its routes (a default gateway)');
  const before = d.exportText();
  d.applyDeviceModel(idx, 'type', 'switch');
  assert.match(d.exportText(), /- id: fw\n {4}label: fw1\n {4}type: switch\n/);
  assert.doesNotMatch(d.exportText().split('- id: fw\n')[1].split('\n  - id:')[0], /kind: ngfw/);
  d.undo();
  assert.equal(d.exportText(), before, 'one undo step');
  // a System's purpose: its icon goes when it is not one of the new purpose's
  const ot = openDoc(example('ot-network.yaml'));
  const tap = ot.entities('device').find((x) => x.id === 'tap').index;
  const p2 = ot.deviceModelPlan(tap, 'purpose', 'host');
  assert.ok(p2.removed.some((x) => /^icon: tap/.test(x.text)) && p2.removed.some((x) => /port pairs/.test(x.text)), p2.removed.map((x) => x.text).join(' | '));
  // a protocol break becomes a filtering router: its profiles and the rules' profile references go, the rules stay
  const cd = openDoc(example('cross-domain.yaml'));
  const g = cd.entities('device').find((x) => x.id === 'cdg').index;
  const p3 = cd.deviceModelPlan(g, 'implementation', 'filtering_router');
  assert.deepEqual(p3.removed.map((x) => x.text), ['the transfer profiles (a protocol break’s)', 'rule red-web: profile web']);
  cd.applyDeviceModel(g, 'implementation', 'filtering_router');
  assert.match(cd.exportText(), /implementation: filtering_router/);
  assert.match(cd.exportText(), /- id: red-web/);
  // a VPN Gateway made a router: its VPN goes; a router made a VPN Gateway gets none chosen
  const w = openDoc(example('wan-vpn.yaml'));
  const hv = w.entities('device').find((x) => x.id === 'hq-vpn').index;
  assert.ok(w.deviceModelPlan(hv, 'type', 'router').removed.some((x) => /VPN gateway configuration/.test(x.text)));
  const core = w.entities('device').find((x) => x.id === 'hq-core').index;
  w.applyDeviceModel(core, 'type', 'vpn_gateway');
  assert.ok(validate.loadModel(w.exportText()).errors.some((e) => /VPN Gateway "hq-core" needs its VPN gateway configuration/.test(e.message)));
});

test('every example converts its devices by behaviour: no generic gateway or proxy; a System always says what it does', () => {
  for (const f of ['device-types.yaml', 'metro-ring.yaml', 'ot-network.yaml', 'cross-domain.yaml', 'wan-vpn.yaml']) {
    for (const d of model(example(f)).devices) {
      assert.ok(d.type !== 'gateway' && d.type !== 'proxy', `${f}: ${d.id}`);
      if (DT.hasPurpose(d.type)) assert.ok(d.purpose, `${f}: ${d.id} has its purpose`);
    }
  }
  // every type is used by the device-types example
  const used = new Set(model(example('device-types.yaml')).devices.map((d) => d.type));
  assert.deepEqual(DT.DEVICE_TYPE_IDS.filter((t) => !used.has(t)), []);
});
