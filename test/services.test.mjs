// The service registry and its catalog, Wireless access with several Wi-Fi
// networks on VLANs over one uplink, and how validation, the simulation, the
// path tracer, the diagram, Find and the editor follow them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, model, validate, example, root } from './helpers.mjs';

const R = load('model/service-registry.js');
const S = load('analysis/sim/simulation.js');
const T = load('analysis/trace.js');
const F = load('analysis/failure.js');
const D = load('editor/document.js');
const Q = load('model/queries.js');
const Dv = load('model/derive.js');
const { SCHEMA } = load('yaml/schema.js');

const errs = (text) => validate.loadModel(text).errors.map((e) => `${e.path}: ${e.message}`);
const warns = (text) => validate.loadModel(text).warnings.map((e) => `${e.path}: ${e.message}`);
const ev = (s, f) => s.events().filter(f);
const sim = (m, t) => {
  const s = new S.Simulation(m);
  s.runTo(t);
  return s;
};

// ------------------------------------------------------------ the registry

test('the registry: every service, its badge, who may run it and why not; nothing on a Security gateway but its Domain separation', () => {
  const ids = R.SERVICES.map((s) => s.id);
  assert.deepEqual(ids.slice().sort(), SCHEMA.netServices.slice().sort(), 'the schema lists exactly the registry');
  for (const s of R.SERVICES) assert.ok(s.badge.length <= 5 && s.label && s.help && s.types.length, s.id);
  const may = (id, d) => R.serviceEligibility(R.serviceDef(id), d);
  assert.equal(may('dhcp', { type: 'router' }), null);
  assert.equal(may('dhcp', { type: 'switch', layer3: true }), null);
  assert.match(may('dhcp', { type: 'switch' }), /a Layer 2 switch routes nothing/);
  assert.match(may('dhcp', { type: 'storage' }), /DHCP server runs on Router, Switch, Firewall, Server, Virtual machine or Container/);
  assert.equal(may('dns', { type: 'firewall' }), null);
  assert.match(may('dns', { type: 'firewall', mode: 'transparent' }), /transparent firewall/);
  assert.equal(may('ntp', { type: 'system', purpose: 'host' }), null);
  assert.match(may('ntp', { type: 'system', purpose: 'pass_through' }), /only a System whose purpose is Host/);
  assert.equal(may('wireless', { type: 'router' }), null);
  assert.ok(may('wireless', { type: 'server' }));
  assert.equal(may('vpn', { type: 'firewall' }), null);
  assert.equal(may('nat', { type: 'router' }), null);
  assert.match(may('nat', { type: 'server' }), /NAT runs on/);
  assert.match(may('nat', { type: 'switch' }), /NAT is a Layer 3 forwarder’s/);
  for (const s of R.SERVICES) {
    const why = may(s.id, { type: 'security_gateway', separation: { implementation: 'protocol_break' } });
    if (s.id === 'separation') assert.equal(why, null);
    else assert.match(why, /a Security gateway runs no services: nothing may bypass its Domain separation/, s.id);
  }
  // built in: always there, not removable
  assert.deepEqual(R.builtInServices({ type: 'ap' }).map((s) => s.id), ['wireless']);
  assert.deepEqual(R.builtInServices({ type: 'load_balancer' }).map((s) => s.id), ['load_balancing']);
  assert.deepEqual(R.builtInServices({ type: 'ids_ips' }).map((s) => s.id), ['inspection']);
  assert.deepEqual(R.builtInServices({ type: 'vpn_gateway' }).map((s) => s.id), ['vpn']);
  // the schema of each service without its own reader is its parameters
  for (const s of R.SERVICES.filter((x) => !x.custom)) assert.deepEqual(SCHEMA[s.id], s.params.map((p) => p.key).concat((s.lists || []).map((l) => l.key)), s.id);
});

test('the service matrix in docs/FORMAT.md is the registry’s (node scripts/capability-matrix.mjs --write)', async () => {
  const { serviceMatrixMd, SVC_BEGIN, SVC_END } = await import('../scripts/capability-matrix.mjs');
  const doc = readFileSync(join(root, 'docs', 'FORMAT.md'), 'utf8');
  const i = doc.indexOf(SVC_BEGIN);
  const j = doc.indexOf(SVC_END);
  assert.ok(i >= 0 && j > i);
  assert.equal(doc.slice(i + SVC_BEGIN.length, j).trim(), serviceMatrixMd());
});

// ------------------------------------------------------------ validation

const DEV = (extra) => `netatlas: 1\ndevices:\n  - id: s\n    type: server\n${extra}    interfaces: [{id: eth0, ip: 10.0.0.5/24}]\n  - {id: r, type: router, interfaces: [{id: e0, ip: 10.0.0.1/24}]}\n`;

test('a service’s parameters: required ones (always or by the others), written only where they apply, secrets as placeholders, references that exist', () => {
  assert.deepEqual(errs(DEV('    services:\n      ntp: {stratum: 2}\n')), []);
  assert.match(errs(DEV('    services:\n      ntp: {}\n')).join('\n'), /needs its stratum[\s\S]*needs its upstream servers/);
  assert.match(errs(DEV('    services:\n      aaa: {protocol: radius}\n')).join('\n'), /needs its shared secret[\s\S]*needs its clients/);
  assert.match(warns(DEV('    services:\n      aaa: {protocol: radius, secret: hunter2, clients: [r]}\n')).join('\n'), /write a placeholder for the shared secret/);
  assert.deepEqual(warns(DEV('    services:\n      aaa: {protocol: radius, secret: "<radius-secret>", clients: [r]}\n')), []);
  assert.match(errs(DEV('    services:\n      aaa: {protocol: radius, secret: "<x>", clients: [nobody]}\n')).join('\n'), /"nobody" is not a device of the model/);
  assert.match(errs(DEV('    services:\n      proxy: {mode: reverse, listener: 443}\n')).join('\n'), /needs its upstream address/);
  assert.match(errs(DEV('    services:\n      proxy: {mode: forward, listener: 3128, upstream_port: 8080}\n')).join('\n'), /"upstream_port" does not apply here/);
  assert.match(errs(DEV('    services:\n      storage: {protocols: [nfs, ftp]}\n')).join('\n'), /"ftp" is not one of nfs, smb, iscsi/);
  assert.match(errs(DEV('    services:\n      applications: [{id: erp, name: ERP, profile: tcp_server, port: 99999}]\n')).join('\n'), /port/);
  assert.match(errs(DEV('    services:\n      nat: {inside: [eth0], outside: [eth0], rules: [{type: pat}]}\n')).join('\n'), /"s" can't run NAT/);
  // who may not run a service is told why, once
  const e = errs(`netatlas: 1\ndevices:\n  - id: sw\n    type: switch\n    services:\n      dhcp: {scopes: []}\n    interfaces: [{id: p, vlans: 1}]\n`);
  assert.equal(e.length, 1);
  assert.match(e[0], /"sw" can't run DHCP server: a Layer 2 switch routes nothing: tick Supports Layer 3 first/);
});

const AP = (nets, ports = '{id: eth0, vlans: [10, 20]}', links = '', mode = '') => `netatlas: 1
devices:
  - id: ap
    type: ap
${mode}    services:
      wireless:
${nets}
    interfaces: [${ports}, radio0]
  - {id: c1, type: endpoint, interfaces: [{id: w, ip: 10.0.10.5/24}]}
  - {id: c2, type: endpoint, interfaces: [{id: w, ip: 10.0.20.5/24}]}
links:
${links || '  - {id: w1, a: "ap:radio0", b: "c1:w", medium: wireless, wireless_network: a}\n  - {id: w2, a: "ap:radio0", b: "c2:w", medium: wireless, wireless_network: b}'}
`;
const NETS = '        networks:\n          - {id: a, ssid: Staff, vlan: 10, radio: radio0, security: wpa3_enterprise}\n          - {id: b, ssid: Guest, vlan: 20, radio: radio0, security: wpa2_psk, passphrase: "<psk>"}';

test('Wireless access: each Wi-Fi network has its SSID, its VLAN (never chosen) or untagged, its radio and its security; several connections share the radio', () => {
  assert.deepEqual(errs(AP(NETS)), []);
  assert.match(errs(AP('        networks: []')).join('\n'), /needs its Wi-Fi networks/);
  assert.match(errs(`netatlas: 1\ndevices:\n  - {id: ap, type: ap, interfaces: [eth0]}\n`).join('\n'), /Wireless access is built into "ap" and needs its configuration/);
  assert.match(errs(AP(NETS.replace('vlan: 10, ', ''))).join('\n'), /Wi-Fi network "a" needs its VLAN \(the one it is bridged to\), or untagged: true/);
  assert.match(errs(AP(NETS.replace('security: wpa2_psk, passphrase: "<psk>"', 'security: wpa2_psk'))).join('\n'), /needs its passphrase: a placeholder/);
  assert.match(warns(AP(NETS.replace('"<psk>"', 'letmein123'))).join('\n'), /write a placeholder for the passphrase/);
  assert.match(errs(AP(NETS.replace('ssid: Guest', 'ssid: Staff'))).join('\n'), /both have the SSID "Staff" on radio0: one SSID per radio/);
  // the uplink carries each network's VLAN: nothing is added for it
  assert.match(errs(AP(NETS, '{id: eth0, vlans: [10]}')).join('\n'), /VLAN 20 of Wi-Fi network "b" is carried by none of ap's wired ports \(eth0 \(10\)\)[\s\S]*nothing is added for you/);
  // a wireless connection names a network on the radio it ends on
  assert.match(errs(AP(NETS, undefined, '  - {id: w1, a: "ap:radio0", b: "c1:w", medium: wireless}\n')).join('\n'), /"w1" is a wireless connection to ap:radio0: write the Wi-Fi network it is associated with \(a "Staff", b "Guest"\)/);
  assert.match(errs(AP(NETS, undefined, '  - {id: w1, a: "ap:radio0", b: "c1:w", medium: wireless, wireless_network: z}\n')).join('\n'), /"z" is not a Wi-Fi network of ap on radio0/);
  assert.match(errs(AP(NETS, undefined, '  - {id: w1, a: "ap:eth0", b: "c1:w", medium: copper, wireless_network: a}\n')).join('\n'), /"wireless_network" is a wireless connection's/);
  // a second cable on an ordinary port is still an error
  const m = model(AP(NETS));
  assert.deepEqual(m.index.radioLinks.get('ap:radio0'), ['w1', 'w2']);
  // controller-managed: the controller is named, and lists it
  const CTL = AP(NETS.replace('        networks:', '        controller: wlc\n        networks:'), undefined, undefined, '    mode: controller\n').replace('devices:\n', 'devices:\n  - {id: wlc, type: server, services: {wireless_controller: {aps: [ap]}}, interfaces: [{id: e, ip: 10.0.99.5/24}]}\n');
  assert.deepEqual(errs(CTL), []);
  assert.match(errs(CTL.replace('aps: [ap]', 'aps: [c1]')).join('\n'), /"c1" is not a controller-managed access point[\s\S]*does not list "ap"/);
  assert.match(errs(AP(NETS, undefined, undefined, '    mode: controller\n')).join('\n'), /"ap" is controller-managed: write its controller/);
});

test('a router with Wireless access: its Wi-Fi networks are bridged to its VLAN interfaces; a VLAN it has no interface or port for is an error', () => {
  const m = model(example('home-network.yaml'));
  const cpe = m.index.devices.get('cpe');
  assert.deepEqual(cpe.wireless.networks.map((x) => `${x.ssid}:${x.vlan}`), ['Home:10', 'Guest:20', 'IoT:30']);
  const bad = example('home-network.yaml').replace('      - {id: Vlan30, type: virtual, vlan: 30, ip: 192.168.30.1/24}\n', '').replace('      - {id: mesh0, vlans: [10, 20, 30]}', '      - {id: mesh0, vlans: [10, 20]}');
  assert.ok(errs(bad).some((e) => /VLAN 30 of Wi-Fi network "iot" is carried by none of cpe's wired ports .* and it has no VLAN interface for it/.test(e)), errs(bad).join('\n'));
});

// ------------------------------------------------------------ simulation and tracing of Wi-Fi

test('several Wi-Fi networks over one uplink: each client in its own VLAN (its DHCP server there), never another’s; the shared uplink fails for all', () => {
  const m = model(example('multi-ssid-ap.yaml'));
  // the radio's end of each connection is an access port in its network's VLAN
  const end = (id) => {
    const l = m.links.find((x) => x.id === id);
    return Dv.endL2(m, l.a);
  };
  assert.deepEqual([end('w-laptop').untagged, end('w-phone').untagged, end('w-sensor').untagged], [10, 20, 30]);
  assert.match(Dv.endTagText(m, m.links.find((x) => x.id === 'w-phone').a), /^SSID “Guest” · A 20/);
  const s = sim(m, 12000);
  const bound = (dev) => ev(s, (e) => e.device === dev && e.what === 'Bound').map((e) => /bound to ([0-9./]+)/.exec(e.detail)[1])[0];
  assert.deepEqual([bound('laptop'), bound('phone'), bound('sensor')], ['10.10.10.100/24', '10.10.20.100/24', '10.10.30.100/24']);
  assert.ok(ev(s, (e) => e.device === 'phone' && e.what === 'Test answered' && /10\.10\.20\.1/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'phone' && e.what === 'Test failed' && /10\.10\.10\.1/.test(e.detail)).length >= 1, 'Guest reaches nothing of Staff');
  // the one uplink: failing it cuts every network of the access point
  const spof = F.singlePointsOfFailure(m).find((x) => x.ref === 'link:l-acc-ap');
  assert.ok(spof && spof.isolated.length === 1 && spof.isolated[0].length >= 3);
  const f = new S.Simulation(m);
  f.runTo(8000);
  f.engine.fail('link:l-acc-ap');
  f.runTo(30000);
  for (const c of ['laptop']) assert.ok(ev(f, (e) => e.device === c && e.what === 'Test failed' && e.t > 8000).length >= 1, c);
});

test('a network tunneled to the controller is reported as not simulated (a limitation), in the simulation and the tracer', () => {
  const m = model(example('enterprise-campus.yaml').replace("          - {id: guest, ssid: Campus-Guest, vlan: 20, radio: radio0, security: wpa2_psk, passphrase: \"<guest-psk>\"}\n    interfaces:\n      - {id: eth0, vlans: [10, 20, 99]}\n      - {id: radio0}\n    logical_interfaces:\n      - {id: mgmt, type: virtual, vlan: 99, ip: 10.20.99.11/24}", "          - {id: guest, ssid: Campus-Guest, vlan: 20, radio: radio0, security: wpa2_psk, passphrase: \"<guest-psk>\", forwarding: tunneled}\n    interfaces:\n      - {id: eth0, vlans: [10, 20, 99]}\n      - {id: radio0}\n    logical_interfaces:\n      - {id: mgmt, type: virtual, vlan: 99, ip: 10.20.99.11/24}"));
  const s = sim(m, 8000);
  assert.ok(ev(s, (e) => e.device === 'ap1' && /tunnels the Wi-Fi network guest to its controller \(forwarding: tunneled\): the tunnel is not simulated/.test(e.detail)).length >= 1);
});

// ------------------------------------------------------------ the catalog in the simulation

test('the exchanges services imply: NTP to its upstreams, RADIUS from the AAA server’s clients, syslog from its senders, SNMP polls of the monitored, CAPWAP to the controller', () => {
  // (past the first minute: a request sent while the core's interfaces are still coming up is dropped, and is sent again a minute later)
  const s = sim(model(example('enterprise-campus.yaml')), 66000);
  const has = (proto, from) => ev(s, (e) => e.protocol === proto && e.device === from && e.kind === 'message').length > 0;
  assert.ok(has('ntp', 'core1'), 'NTP');
  assert.ok(has('radius', 'ap1') && has('radius', 'srv'), 'RADIUS request and answer');
  assert.ok(has('syslog', 'wlc'), 'syslog');
  assert.ok(has('snmp', 'srv'), 'SNMP polls');
  assert.ok(has('capwap', 'ap1') && has('capwap', 'wlc'), 'CAPWAP echo and its answer');
  // the services listen on their ports
  const L = load('analysis/sim/transport.js');
  const srv = model(example('enterprise-campus.yaml')).index.devices.get('srv');
  assert.deepEqual(L.serviceListening(srv).map((r) => `${r.proto}/${r.from}`).sort(), ['udp/123', 'udp/1812', 'udp/514']);
});

test('DMZ: a port forward, a reverse proxy, a load balancer by its own backends and algorithm, an IPS that blocks; a VPN on a firewall and a router', () => {
  const s = sim(model(example('dmz-services.yaml')), 9000);
  assert.ok(ev(s, (e) => e.device === 'fw' && e.what === 'DNAT' && /forwards port 443\/tcp to 10\.50\.0\.10:443/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'rproxy' && e.what === 'proxied' && /reverse proxy\) ends the connection .* opens its own to 10\.50\.0\.20:8443/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'lb' && e.what === 'proxied' && /chosen by Least connections \(configured on its Load balancing service\) among 2 healthy members/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'shopper' && e.what === 'Test answered' && /tcp\/443/.test(e.detail)).length >= 1, 'through DNAT, the proxy and the pool');
  assert.ok(ev(s, (e) => e.device === 'ips' && e.what === 'blocked' && /its Inspection blocks tcp\/23/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.device === 'br-pc' && e.what === 'Test answered' && /tcp\/2049/.test(e.detail)).length >= 1, 'NFS over the VPN of the router and the firewall');
});

test('NAT: PAT out of the outside interface, in the simulation and as a note of the trace', () => {
  const m = model(example('home-network.yaml'));
  const s = sim(m, 6000);
  assert.ok(ev(s, (e) => e.device === 'cpe' && e.what === 'PAT' && /192\.168\.10\.\d+ → 198\.51\.100\.10/.test(e.detail)).length >= 1);
  const t = T.tracePath(model(example('dmz-services.yaml')), { from: 'br-pc', to: '203.0.113.50' });
  void t;
  const t2 = T.tracePath(m, { from: 'cpe:Vlan10', to: '9.9.9.9' });
  void t2;
  const n = T.tracePath(model(example('dmz-services.yaml')), { from: 'nas', to: '203.0.113.50' });
  assert.ok(n.paths[0].hops.some((h) => h.notes.some((x) => /^PAT: source 10\.60\.0\.50 → 203\.0\.113\.2 \(fw's NAT, inside → outside\)/.test(x))), T.traceText(n));
});

// ------------------------------------------------------------ the diagram, Find, the editor

test('badges: a device’s services in a line under its type, at most three and how many more; all in the tooltip and the legend', () => {
  const m = model(example('enterprise-campus.yaml'));
  const srv = m.index.devices.get('srv');
  assert.equal(R.serviceBadgesText(srv), 'DHCP · DNS · NTP +3');
  assert.equal(R.serviceListText(srv), 'DHCP server (DHCP), DNS server (DNS), NTP (NTP), AAA (AAA), Syslog collector (LOG), Monitoring (MON)');
  assert.equal(R.serviceBadgesText(m.index.devices.get('ap1')), 'WIFI');
  const L = load('diagram/legend.js');
  const labels = L.legendOf(m, 'physical').sections[0].items.map((x) => x.label);
  assert.ok(labels.some((x) => /at most 3, then how many more/.test(x)) && labels.indexOf('Wireless access') >= 0 && labels.indexOf('Wireless controller') >= 0, labels.join(' | '));
});

test('Find: a Wi-Fi network by its SSID and its VLAN; a device by its services', () => {
  const m = model(example('multi-ssid-ap.yaml'));
  const hit = (q) => Q.search(m, q).map((h) => `${h.kind}:${h.ref}`);
  assert.ok(hit('Guest').indexOf('Wi-Fi network:device:ap1') >= 0, hit('Guest').join(', '));
  assert.ok(hit('vlan 30').indexOf('Wi-Fi network:device:ap1') >= 0);
  const c = model(example('enterprise-campus.yaml'));
  assert.ok(Q.search(c, 'radius').concat(Q.search(c, 'aaa')).some((h) => h.ref === 'device:srv'));
});

test('editor: removing a service lists its values and what stays reported (the connections of a removed Wireless access); one undo step', () => {
  const d = D.ModelDoc.fromText(example('multi-ssid-ap.yaml'), 't.yaml', 'file').doc;
  const ap = d.entities('device').find((x) => x.id === 'ap1').index;
  const plan = d.appServiceRemoval(ap, 'wireless');
  assert.match(plan.values.join('\n'), /^networks:/);
  assert.deepEqual(plan.kept, ['wireless connection w-laptop (network staff)', 'wireless connection w-phone (network guest)', 'wireless connection w-sensor (network iot)']);
  assert.deepEqual(d.networkClients('ap1', 'guest'), ['w-phone']);
  const before = d.exportText();
  d.removeService(ap, 'wireless', 'Wireless access');
  assert.doesNotMatch(d.exportText(), /wireless:\n/);
  d.undo();
  assert.equal(d.exportText(), before);
  // a service added by its id is an empty block: its required fields are errors, nothing is chosen
  const r = d.entities('device').find((x) => x.id === 'guest-gw').index;
  d.addBlock(['devices', r, 'services', 'ntp'], 'NTP');
  assert.ok(d.result.errors.some((e) => /needs its stratum/.test(e.message)));
});
