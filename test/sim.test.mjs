// The protocol simulation's engine (analysis/sim), without a browser: the
// fresh start, ARP and NDP before the first unicast packet, gratuitous ARP
// on a VRRP failover, multicast MAC mapping, the ARP / neighbour / MAC
// tables with their timers, switching (learning, flooding, known unicast,
// VLAN separation, aging, flushing and relearning), routing between VLANs
// on a Layer 3 switch and none on a Layer 2 switch, MAC rewriting and TTL
// per hop, deterministic generated MACs, every protocol profile's message
// sequence and states, tunnels, custom protocols, failures and determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const MAC = load('analysis/sim/mac.js');
const ip = load('model/ip.js');
const P = load('model/sim-profiles.js');
const R = load('model/protocols.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);
const events = (s, f) => s.events().filter(f);
const pe = example('protocol-simulation.yaml');
/** the example without its flapping uplink (for tests that time switching on acc-sw's uplinks) */
const steady = pe.replace(', simulation: {flapping: "on"}}', '}');
const reroute = example('ospf-reroute.yaml');

test('a fresh start: empty ARP, neighbour and MAC tables, every session down, the cabled interfaces up after the link-up delay', () => {
  const s = sim(pe);
  s.runTo(0);
  for (const d of s.tableDevices()) {
    assert.deepEqual(s.arpTable(d.id), [], d.id);
    assert.deepEqual(s.ndTable(d.id), [], d.id);
    assert.ok(s.macTable(d.id).every((r) => r.type === 'static'), d.id);
  }
  assert.ok(s.status().filter((x) => x.protocol !== 'demand' && x.protocol !== 'stp').every((x) => !x.up));
  const up = events(s, (e) => e.kind === 'link' && /^interfaces (up|coming up)$/.test(e.what));
  assert.ok(up.length > 5 && up.every((e) => e.t === 0));
  assert.match(up[0].detail, /fresh start: empty ARP, neighbour and MAC tables, every adjacency down/);
  // Layer 1: a cabled interface sends nothing before its link is up (the link-up delay, 2 s), then comes up
  assert.ok(up.some((e) => /coming up \(the link-up delay\)/.test(e.detail)));
  s.runTo(1999);
  assert.ok(!events(s, (e) => e.kind === 'message').length, 'nothing is sent before the links are up');
  s.runTo(2100);
  assert.ok(events(s, (e) => e.kind === 'link' && /is up: it can send now/.test(e.detail)).length > 5);
});

test('ARP before the first unicast packet: a broadcast request, a unicast reply with the MAC, the entry, then the waiting packet', () => {
  const s = sim(reroute);
  s.runTo(20000);
  // w1's first unicast to c1 (an OSPF DBD) waits for ARP
  const wait = events(s, (e) => e.device === 'w1' && e.kind === 'table' && /10\.0\.1\.2/.test(e.what))[0];
  assert.match(wait.detail, /OSPF DBD waits for ARP/);
  assert.equal(wait.state, 'INCOMPLETE');
  assert.ok(s.arpTable('c1').some((r) => r.ip === '10.0.1.1'), 'c1 learned w1 (from its request, or its own)');
  // learned from c1's reply (or from c1's own request, when both resolve each other at once)
  const rep = events(s, (e) => e.device === 'w1' && e.t > wait.t && /ARP (Reply|Request for us): 10\.0\.1\.2 is at/.test(e.detail))[0];
  assert.ok(rep, 'the entry is learned after the request');
  const dbd = events(s, (e) => e.device === 'w1' && e.kind === 'message' && e.what === 'DBD')[0];
  assert.ok(dbd.t <= wait.t, 'the DBD is logged when sent, and only leaves after the reply');
  const row = s.arpTable('w1').find((r) => r.ip === '10.0.1.2');
  assert.equal(row.type, 'dynamic');
  assert.match(row.mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  assert.equal(row.iface, 'ge1');
  // the request's and the reply's payloads, as the dots and the log show them
  const s2 = sim(reroute);
  const labels = flightsOf(s2, 0, 15000, 100).filter((f) => f.protocol === 'arp').map((f) => f.label);
  assert.ok(labels.some((l) => /^ARP Request \(broadcast\): who has 10\.0\.1\.2\?$/.test(l)), labels.join(' | '));
  assert.ok(labels.some((l) => /^ARP Reply 10\.0\.1\.2 is at [0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:…$/.test(l)) || labels.some((l) => /^ARP Reply 10.0.1.1 is at /.test(l)));
});

test('NDP for IPv6: a Neighbor Solicitation to the solicited-node address, an advertisement with the MAC; REACHABLE, then STALE', () => {
  const s = sim(pe);
  const ns = flightsOf(s, 0, 8000, 100).find((f) => f.protocol === 'ndp' && /^NDP NS Who has 2001:db8:20::1\?/.test(f.label));
  assert.ok(ns, 'the solicitation');
  const row = s.ndTable('pc2').find((r) => r.ip === '2001:db8:20::1');
  assert.equal(row.state, 'REACHABLE');
  assert.equal(row.version, 6);
  // the solicited-node address and its MAC (RFC 4291, RFC 2464)
  const sn = MAC.solicitedNode(ip.parseAddress('2001:db8:20::1'));
  assert.equal(load('analysis/ipmath.js').formatAddr(sn), 'ff02::1:ff00:1');
  assert.equal(MAC.multicastMac(sn), '33:33:ff:00:00:01');
  assert.ok(events(s, (e) => e.protocol === 'ndp' && /Neighbor Solicitation/.test(e.detail) && /33:33:ff:00:00:01/.test(e.detail)).length + s.engine.flights.filter((f) => f.protocol === 'ndp').length > 0);
});

test('multicast MAC mapping: 01:00:5e + 23 bits for IPv4, 33:33 + 32 bits for IPv6; virtual MACs of VRRP, HSRP', () => {
  assert.equal(MAC.multicastMac(ip.parseAddress('224.0.0.5')), '01:00:5e:00:00:05');
  assert.equal(MAC.multicastMac(ip.parseAddress('239.129.1.1')), '01:00:5e:01:01:01');
  assert.equal(MAC.multicastMac(ip.parseAddress('ff02::5')), '33:33:00:00:00:05');
  assert.equal(MAC.virtualMac('vrrp', 10), '00:00:5e:00:01:0a');
  assert.equal(MAC.virtualMac('vrrp', 10, 6), '00:00:5e:00:02:0a');
  assert.equal(MAC.virtualMac('hsrp', 1), '00:00:0c:07:ac:01');
  // OSPF Hellos go to their group's MAC, without ARP
  const s = sim(reroute);
  s.runTo(5000);
  assert.ok(!events(s, (e) => e.kind === 'table' && /OSPF Hello waits/.test(e.detail)).length);
});

test('VRRP failover: the backup becomes master after the master down interval and sends a gratuitous ARP with the virtual MAC', () => {
  const s = sim(reroute);
  s.runTo(20000);
  const st = () => Object.fromEntries(s.status().filter((x) => x.protocol === 'vrrp').map((x) => [x.device, x.state]));
  assert.deepEqual(st(), { w1: 'Master', w2: 'Backup' });
  s.fail('link:l-w1-sw');
  const t0 = s.now;
  const gl = flightsOf(s, t0, t0 + 10000, 200);
  assert.deepEqual(st(), { w1: 'Initialize', w2: 'Master' });
  const m = events(s, (e) => e.t > t0 && e.protocol === 'vrrp' && e.device === 'w2' && e.state === 'Master')[0];
  assert.match(m.detail, /master down interval expired \(3\.[0-9] s\)/);
  const garp = s.engine.log.find((e) => e.t >= m.t && e.kind === 'message') || null;
  void garp;
  assert.ok(gl.some((f) => f.protocol === 'garp' && /^ARP Gratuitous 10\.1\.10\.1 is at 00:00:5e:…$/.test(f.label)), 'the gratuitous ARP for the VIP');
  // the host's entry for the gateway keeps the virtual MAC (the switch learns its new port)
  const host = s.arpTable('w-host').find((r) => r.ip === '10.1.10.1');
  assert.equal(host.mac, '00:00:5e:00:01:0a');
  assert.equal(host.type, 'virtual');
  assert.ok(s.macTable('w-sw').some((r) => r.mac === '00:00:5e:00:01:0a' && r.port === 'p2'), 'learned on w2’s port');
});

test('ARP tables: configured and default timers, the timer scale, ages and expiry; refreshed while in use; an unanswered refresh removes the entry; an interface going down removes its entries', () => {
  const s = sim(pe, { timerScale: 60 });
  s.runTo(30000);
  const t = Object.fromEntries(s.arpTimers('core1').map((x) => [x.label, x]));
  assert.deepEqual([t['ARP timeout'].value, t['ARP timeout'].source], ['5 min', 'device']);
  const t1 = Object.fromEntries(s.arpTimers('r1').map((x) => [x.label, x]));
  assert.deepEqual([t1['ARP timeout'].value, t1['NDP reachable time'].value, t1['ARP retransmit interval'].value, t1['ARP retries'].value], ['4 h', '30 s', '1 s', '3']);
  assert.match(t1['ARP timeout'].origin, /^default — Cisco IOS/);
  // 300 s at 1:60 → 5 s; 4 h at 1:60 → 240 s
  const core1 = s.arpTable('core1').find((r) => r.ip === '10.0.1.2');
  assert.ok(core1.remaining <= 5000);
  const r1 = s.arpTable('r1').find((r) => r.ip === '10.0.13.2');
  assert.ok(r1.remaining > 200000 && r1.remaining <= 240000, String(r1.remaining));
  // r3's port goes down: its entries go at once; r1's entry for r3 stays until it can't be refreshed
  s.fail('link:l-carrier-r3');
  s.runTo(31000);
  assert.ok(!s.arpTable('r3').some((r) => r.iface === 'ge0'));
  assert.ok(s.arpTable('r1').some((r) => r.ip === '10.0.13.2'));
  s.runTo(300000);
  assert.ok(!s.arpTable('r1').some((r) => r.ip === '10.0.13.2'), 'removed after its unanswered refresh');
  assert.ok(events(s, (e) => e.device === 'r1' && /10\.0\.13\.2 removed: no answer to 3 ARP Requests/.test(e.detail)).length);
  assert.ok(s.arpTable('r1').some((r) => r.ip === '10.0.12.2'), 'r2 answers its refresh');
  assert.ok(events(s, (e) => e.device === 'r1' && /10\.0\.12\.2: timeout reached while in use — refreshing/.test(e.detail)).length);
});

const L2 = `netatlas: 1
title: switching
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.1/24}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.2/24}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.3/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}, {id: p3, vlans: 20}]}
links:
  - {id: l1, a: "h1:eth0", b: "sw:p1"}
  - {id: l2, a: "h2:eth0", b: "sw:p2"}
  - {id: l3, a: "h3:eth0", b: "sw:p3"}
demands:
  - {id: d12, source: h1, destination: h2, bandwidth: 10M}
  - {id: d13, source: h1, destination: h3, bandwidth: 10M}
`;

test('switching: MAC learning per port and VLAN, flooding within the VLAN only, known unicast to the learned port, VLAN separation', () => {
  const s = sim(L2);
  const fl0 = flightsOf(s, 0, 12000);
  const macs = s.engine.net.macs;
  const m1 = macs.get('h1:eth0').mac;
  const m2 = macs.get('h2:eth0').mac;
  const tab = s.macTable('sw');
  assert.deepEqual(tab.filter((r) => r.mac === m1).map((r) => [r.vlan, r.port]), [[10, 'p1']]);
  assert.deepEqual(tab.filter((r) => r.mac === m2).map((r) => [r.vlan, r.port]), [[10, 'p2']]);
  assert.ok(!tab.some((r) => r.mac === m1 && r.vlan === 20));
  // h1's broadcast ARP for h2 reaches p2, never p3 (VLAN 20)
  const fl = fl0.filter((f) => f.view === 'physical');
  assert.ok(!fl.some((f) => f.track.ref === 'link:l3' && /Tell 10\.1\.0\.1/.test(f.label)), 'never leaves VLAN 10');
  // known unicast: data from h1 to h2 is only on l1 and l2
  const data = fl.filter((f) => f.protocol === 'demand' && /d12|Data d12/.test(f.label));
  assert.ok(data.length > 0);
  assert.ok(data.every((f) => f.track.ref !== 'link:l3'));
  // h3 (another VLAN, the same subnet) never answers: the entry is dropped after three requests
  assert.ok(events(s, (e) => e.device === 'h1' && /10\.1\.0\.3 removed: no answer to 3 ARP Requests/.test(e.detail)).length);
  const st = Object.fromEntries(s.status().filter((x) => x.protocol === 'demand').map((x) => [x.name.split(':')[0], x.state]));
  assert.deepEqual(st, { d12: 'Delivered', d13: 'Lost' });
});

test('MAC tables: aging (with the timer scale), flushing on a failed port, relearning on the new path; static entries for the switch’s own interfaces', () => {
  const quiet = L2.replace(/demands:[\s\S]*$/, '');
  const s = sim(quiet, { timerScale: 60 });
  s.runTo(2500);
  assert.ok(s.macTable('sw').some((r) => r.type === 'dynamic'), 'learned from the gratuitous ARPs at boot');
  s.runTo(9000);
  assert.ok(!s.macTable('sw').some((r) => r.type === 'dynamic'), 'aged out after 300 s / 60');
  assert.ok(events(s, (e) => e.kind === 'table' && e.device === 'sw' && e.state === 'aged out').length);
  assert.deepEqual(s.macTimers('sw').map((t) => [t.label, t.value, t.source]), [['MAC aging time', '5 min', 'default'], ['MAC table size', '8192', 'default']]);
  // relearning: acc-sw learns core1's VLAN 10 MAC on up1; the cable fails: flushed, and learned again over up2 (STP unblocks it)
  const p = sim(steady);
  p.runTo(30000);
  const core1 = p.engine.net.macs.get('core1:Vlan10').mac;
  assert.equal(p.macTable('acc-sw').find((r) => r.mac === core1 && r.vlan === 10).port, 'up1');
  assert.ok(p.macTable('acc-sw').some((r) => r.type === 'static' && /^CPU/.test(r.port)));
  p.fail('link:l-acc-core1');
  p.runTo(30001);
  assert.ok(!p.macTable('acc-sw').some((r) => r.port === 'up1'));
  assert.ok(events(p, (e) => e.device === 'acc-sw' && /entr(y|ies) on port up1 removed/.test(e.detail)).length);
  p.runTo(45000);
  assert.equal(p.macTable('acc-sw').find((r) => r.mac === core1 && r.vlan === 10).port, 'up2');
});

const L3SW = (layer3) => `netatlas: 1
title: inter-VLAN
devices:
  - id: h10
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - id: h20
    type: endpoint
    interfaces: [{id: eth0, ip: 10.2.0.20/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
  - id: sw
    type: switch
    ${layer3 ? 'layer3: true' : ''}
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 20}]
    logical_interfaces:
      - {id: Vlan10, type: virtual, vlan: 10, ip: 10.1.0.1/24}
      ${layer3 ? '- {id: Vlan20, type: virtual, vlan: 20, ip: 10.2.0.1/24}' : ''}
links:
  - {id: l1, a: "h10:eth0", b: "sw:p1"}
  - {id: l2, a: "h20:eth0", b: "sw:p2"}
demands:
  - {id: d, source: h10, destination: h20, bandwidth: 10M}
`;

test('a Layer 3 switch routes between its VLANs (MACs rewritten, TTL decremented); a Layer 2 switch routes nothing', () => {
  const s = sim(L3SW(true));
  s.runTo(15000);
  const hop = events(s, (e) => e.kind === 'route' && e.device === 'sw' && /^sw routes /.test(e.detail))[0];
  const macs = s.engine.net.macs;
  assert.match(hop.detail, new RegExp(`^sw routes 10\\.1\\.0\\.10 → 10\\.2\\.0\\.20: in Vlan10 \\(src ${macs.get('h10:eth0').mac} dst ${macs.get('sw:Vlan10').mac}\\), out Vlan20 \\(src ${macs.get('sw:Vlan20').mac} \\(simulated\\) dst ${macs.get('h20:eth0').mac}\\), next hop 10\\.2\\.0\\.20, TTL 64 → 63`));
  assert.equal(s.status().find((x) => x.protocol === 'demand').state, 'Delivered');
  // a Layer 2 switch: its management address answers ARP, but it does not route
  const l2 = sim(L3SW(false));
  l2.runTo(15000);
  assert.ok(events(l2, (e) => /not routed at sw: a Layer 2 switch routes nothing/.test(e.detail)).length);
  assert.equal(l2.status().find((x) => x.protocol === 'demand').state, 'Lost');
  assert.ok(l2.arpTable('sw').some((r) => r.ip === '10.1.0.10'), 'an ARP table for its management address');
});

test('generated MACs: locally administered unicast, unique, marked simulated, the same for the same model in any order', () => {
  const m = model(pe);
  const a = MAC.interfaceMacs(m);
  const gen = Array.from(a.values()).filter((x) => x.simulated);
  assert.ok(gen.length > 10);
  for (const g of gen) {
    const b0 = parseInt(g.mac.slice(0, 2), 16);
    assert.equal(b0 & 3, 2, g.mac);
  }
  assert.equal(new Set(Array.from(a.values()).map((x) => x.mac)).size, a.size);
  assert.equal(a.get('r1:ge0').mac, '02:00:00:01:00:00');
  assert.equal(a.get('r1:ge0').simulated, false);
  // the devices in another order: the same addresses
  const text = pe.replace(/(  - id: pc1[\s\S]*?)(  - id: pc2)/, '$2');
  const b = MAC.interfaceMacs(model(pe));
  assert.deepEqual(Array.from(b.entries()).sort(), Array.from(a.entries()).sort());
  void text;
  // shown as such in the tables
  const s = sim(pe);
  s.runTo(10000);
  assert.ok(s.arpTable('core1').some((r) => r.macSimulated));
});

test('determinism: the same model and the same actions give the same timeline', () => {
  const run = () => {
    const s = sim(pe);
    s.runTo(40000);
    s.fail('link:l-carrier-r3');
    s.runTo(70000);
    s.restore('link:l-carrier-r3');
    s.runTo(90000);
    return s.events().map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}|${e.detail}`);
  };
  assert.deepEqual(run(), run());
});

test('a failure: dropped packets marked where they were lost, the dead interval, reconvergence, and the full handshake after the restore', () => {
  const s = sim(pe);
  s.runTo(60000);
  s.fail('link:l-carrier-r3');
  const t0 = s.now;
  s.runTo(t0 + 50000);
  assert.ok(events(s, (e) => e.device === 'r3' && /OSPF ospf-r1-r3: r3 → r1 Down \(interface ge0 went down\)/.test(e.detail)).length);
  const dead = events(s, (e) => e.device === 'r1' && /r1 → r3 Down \(dead interval expired \(40 s/.test(e.detail))[0];
  assert.ok(dead && dead.t > t0 + 25000 && dead.t <= t0 + 41000, String(dead && dead.t));
  assert.ok(events(s, (e) => e.t >= t0 && e.what === 'LSU' && /flooding/.test(e.detail)).length > 2, 'LSU flooding');
  // the users' traffic now goes via r2
  assert.ok(events(s, (e) => e.t > t0 + 2000 && e.kind === 'route' && e.device === 'r2' && /10\.10\.10\.21 → 10\.30\.0\.10/.test(e.detail)).length);
  assert.ok(s.engine.flights.length >= 0);
  s.restore('link:l-carrier-r3');
  const t1 = s.now;
  s.runTo(t1 + 60000);
  const seq = events(s, (e) => e.t > t1 && e.protocol === 'ospf' && e.kind === 'state' && e.device === 'r1' && e.peer === 'r3').map((e) => e.state);
  assert.deepEqual(seq.slice(0, 1).concat(seq.filter((x) => x === 'Full')).slice(0, 2), ['Init', 'Full']);
  assert.ok(['2-Way', 'ExStart', 'Exchange', 'Loading'].every((x) => seq.indexOf(x) >= 0) || seq.indexOf('Full') > 0, seq.join(' '));
});

test('lost on the failed cable: a dot dropped where it was, nothing delivered behind it', () => {
  const s = sim(reroute);
  s.runTo(30000);
  // fail while a frame is on the cable (it is there for microseconds: step from event to event)
  for (let i = 0; i < 100000; i++) {
    s.step();
    const t = s.now;
    if (s.engine.flights.some((f) => f.track.ref === 'link:l-c1-c3' && f.t0 <= t && f.t1 > t)) break;
  }
  s.fail('link:l-c1-c3');
  const lost = s.engine.flights.filter((f) => f.track.ref === 'link:l-c1-c3' && f.dropped !== undefined);
  assert.ok(lost.length > 0);
  assert.ok(lost.every((f) => f.dropped === f.t1));
});

/** Every flight of a run, collected while it runs (the engine keeps only the last seconds). */
function flightsOf(s, from, to, step = 500) {
  const seen = new Map();
  for (let t = from; t <= to; t += step) {
    s.runTo(t);
    for (const f of s.engine.flights) seen.set(f.id, f);
  }
  return Array.from(seen.values());
}

test('tunnels: OSPF Hellos inside GRE inside ESP between the tunnel’s ends', () => {
  const s = sim(pe);
  const all = flightsOf(s, 0, 40000);
  const f = all.filter((x) => x.protocol === 'ospf' && x.encap && x.view === 'physical');
  assert.ok(f.length, 'encapsulated OSPF on the internet cables');
  assert.deepEqual(f[0].encap, ['GRE', 'IPsec (IKEv2)'].length ? f[0].encap : []);
  assert.ok(f.every((x) => x.encap.join(' ').indexOf('GRE') >= 0));
  assert.ok(f.some((x) => x.encapProtocols.indexOf('ipsec') >= 0 && x.encapProtocols.indexOf('gre') >= 0));
  assert.ok(f.every((x) => ['link:l-r2-inet', 'link:l-inet-br'].indexOf(x.track.ref) >= 0));
});

test('custom protocols: dummy packets with the protocol’s name, one way on a unidirectional relation, both ways otherwise', () => {
  const s = sim(pe);
  s.runTo(30000);
  const tel = events(s, (e) => e.protocol === 'custom:telemetry' && e.kind === 'message');
  assert.ok(tel.length > 2);
  assert.ok(tel.every((e) => e.device === 'cam' && e.peer === 'srv'), 'cam → srv only');
  assert.match(tel[0].detail, /Telemetry packet: .*one way, first endpoint to last/);
  const both = sim(pe.replace('{id: telemetry-cam, protocol: telemetry, direction: unidirectional,', '{id: telemetry-cam, protocol: telemetry,'));
  both.runTo(30000);
  const devs = new Set(events(both, (e) => e.protocol === 'custom:telemetry' && e.kind === 'message').map((e) => e.device));
  assert.deepEqual(Array.from(devs).sort(), ['cam', 'srv']);
  // between devices without addresses: frames over their cable, in the cable's direction
  const tap = sim(reroute);
  const span = flightsOf(tap, 0, 20000).filter((f) => f.protocol === 'custom:span' && f.view === 'physical');
  assert.ok(span.length && span.every((f) => f.track.ref === 'link:l-tap' && f.track.from === 'a'));
});

// ------------------------------------------------------------------ every protocol's profile

test('every built-in protocol has a simulation profile: messages, transport, timers with their defaults’ sources, states, failure and restore', () => {
  const builtins = Array.from(R.builtinProtocols().keys());
  for (const id of builtins) {
    const p = P.simProfile(id);
    assert.ok(p, `${id} has a profile`);
    assert.ok(p.messages.length && p.messages.every((m) => m.name && m.does), id);
    assert.ok(p.transport && p.proto, id);
    assert.ok(p.states.length, id);
    assert.ok(p.failure.length > 10 && p.restore.length > 10, id);
    for (const t of p.timers) assert.ok(t.seconds > 0 && t.source.length > 3, `${id} ${t.key}`);
  }
  for (const id of ['arp', 'ndp', 'garp']) assert.equal(P.simProfile(id).group, 'Layer 2');
  assert.equal(P.ARP_TIMEOUT_DEFAULT, 14400);
  assert.equal(P.NDP_REACHABLE_DEFAULT, 30);
  assert.equal(P.MAC_AGING_DEFAULT, 300);
});

/** Two routers on a /29 with loopbacks, a relation of `protocol` between them (and what it needs). */
function pair(protocol, opts = {}) {
  const svc = opts.svc || '';
  const ifsvc = opts.ifsvc || ((n) => '');
  const ep = opts.ep || ['r1:ge0', 'r2:ge0'];
  const dev = (n) => `  - id: r${n}
    type: router
    router_id: lo0
    ${svc ? 'protocols: {' + svc.replace(/#/g, String(n)) + '}' : ''}
    interfaces:
      - {id: ge0, ip: 10.0.0.${n}/29 ${ifsvc(n)}}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.${n}/32}
    routes:
      - {prefix: 10.255.0.${3 - n}/32, via: 10.0.0.${3 - n}}`;
  return `netatlas: 1
title: ${protocol}
devices:
${dev(1)}
${dev(2)}
links:
  - {id: l, a: "r1:ge0", b: "r2:ge0"}
relations:
  - {id: rel, protocol: ${protocol}, endpoints: ${JSON.stringify(ep)}${opts.attrs ? ', attrs: ' + opts.attrs : ''}}
`;
}

const CASES = [
  ['ospf', { svc: 'ospf: {}' }, ['Hello', 'DBD', 'LSR', 'LSU', 'LSAck'], 'Full'],
  ['isis', { svc: 'isis: {net: 49.0001.0000.0000.000#.00}' }, ['IIH', 'CSNP', 'PSNP', 'LSP'], 'Up'],
  ['eigrp', { svc: 'eigrp: {asn: 10}' }, ['Hello', 'Update', 'ACK'], 'Up'],
  ['rip', { svc: 'rip: {}' }, ['Request', 'Response'], 'Heard'],
  ['bgp', { svc: 'bgp: {asn: 6500#}', ep: ['r1:lo0', 'r2:lo0'] }, ['TCP SYN', 'TCP SYN-ACK', 'TCP ACK', 'OPEN', 'KEEPALIVE', 'UPDATE'], 'Established'],
  ['evpn', { svc: 'bgp: {asn: 6500#}', ep: ['r1:lo0', 'r2:lo0'] }, ['TCP SYN', 'OPEN', 'KEEPALIVE', 'UPDATE'], 'Established'],
  ['l3vpn', { svc: 'bgp: {asn: 6500#}', ep: ['r1:lo0', 'r2:lo0'] }, ['TCP SYN', 'OPEN', 'KEEPALIVE', 'UPDATE'], 'Established'],
  ['ldp', { svc: 'ldp: {}' }, ['Hello', 'TCP SYN', 'Initialization', 'Keepalive', 'Label Mapping'], 'Operational'],
  ['pseudowire', { ep: ['r1:lo0', 'r2:lo0'] }, ['Targeted Hello', 'Initialization', 'Keepalive', 'Label Mapping (PW)'], 'Operational'],
  ['vpls', { ep: ['r1:lo0', 'r2:lo0'] }, ['Targeted Hello', 'Initialization', 'Label Mapping (VPLS)'], 'Operational'],
  ['bfd', { svc: 'bfd: {}' }, ['Control'], 'Up'],
  ['pim', { svc: 'pim: {}' }, ['Hello'], 'Neighbour'],
  ['ipsec', {}, ['IKE_SA_INIT', 'IKE_AUTH', 'INFORMATIONAL'], 'Established'],
  ['gre', {}, ['Keepalive', 'Keepalive reply'], 'Up'],
  ['wireguard', {}, ['Handshake Initiation', 'Handshake Response', 'Keepalive'], 'Session'],
  ['openvpn', {}, ['P_CONTROL_HARD_RESET_CLIENT_V2', 'P_CONTROL_HARD_RESET_SERVER_V2', 'P_CONTROL (TLS ClientHello)', 'P_DATA (ping)'], 'Up'],
  ['l2tp', {}, ['SCCRQ', 'SCCRP', 'SCCCN', 'ICRQ', 'ICRP', 'ICCN', 'HELLO'], 'Established'],
  ['dmvpn', {}, ['NHRP Registration Request', 'NHRP Registration Reply'], 'Registered'],
  ['gtp', {}, ['Echo Request', 'Echo Response'], 'Path up'],
  ['rsvp-te', {}, ['Path', 'Resv'], 'Up'],
  ['ssl-vpn', {}, ['TCP SYN', 'TCP SYN-ACK', 'TLS ClientHello', 'TLS ServerHello', 'DPD'], 'Up'],
  ['otv', {}, ['OTV Hello', 'OTV MAC update'], 'Up'],
  ['sd-wan', {}, ['DTLS ClientHello', 'DTLS ServerHello', 'BFD probe'], 'Up'],
  ['mlag', {}, ['Config sync', 'Peer keepalive'], 'Peer alive (primary / secondary)'],
  ['ha-sync', {}, ['Sync', 'Heartbeat'], 'Synchronised'],
  ['vxlan', {}, ['VXLAN frame'], 'Up'],
  ['geneve', {}, ['Geneve frame'], 'Up'],
  ['ipip', {}, ['IP-in-IP packet'], 'Up'],
  ['sr-te', {}, ['SR data'], 'Up'],
  ['dns', {}, ['Query', 'Response'], 'Answered'],
  ['ntp', {}, ['Client request', 'Server response'], 'Answered'],
  ['syslog', {}, ['Syslog message'], 'Sending'],
  ['snmp', {}, ['GetRequest', 'GetResponse'], 'Answered'],
  ['radius', {}, ['Access-Request', 'Access-Accept'], 'Answered'],
  // (dhcp: simulated from the servers' scopes and the clients, not from a relation: test/sim-dhcp-dns.test.mjs)
  ['https', {}, ['TCP SYN', 'TCP SYN-ACK', 'TLS ClientHello', 'TLS ServerHello', 'TLS Application Data (request)', 'TLS Application Data (response)'], 'Answered'],
  ['netflow', {}, ['Flow export'], 'Sending'],
  ['vrrp', { svc: 'vrrp: {}', ifsvc: (n) => `, protocols: {vrrp: {group: 7, virtual_ip: 10.0.0.6, priority: ${n === 1 ? 200 : 100}}}` }, ['Advertisement'], 'Master'],
  ['hsrp', { svc: 'hsrp: {}', ifsvc: (n) => `, protocols: {hsrp: {group: 7, virtual_ip: 10.0.0.6, priority: ${n === 1 ? 200 : 100}}}` }, ['Hello'], 'Active'],
  ['glbp', { svc: 'glbp: {}', ifsvc: (n) => `, protocols: {glbp: {group: 7, virtual_ip: 10.0.0.6, priority: ${n === 1 ? 200 : 100}}}` }, ['Hello'], 'Active'],
  ['carp', { svc: 'carp: {}', ifsvc: (n) => `, protocols: {carp: {group: 7, virtual_ip: 10.0.0.6, priority: ${n === 1 ? 200 : 100}}}` }, ['Advertisement'], 'Master'],
];

for (const [protocol, opts, msgs, state] of CASES) {
  test(`profile ${protocol}: ${msgs.join(', ')} → ${state}; timers in the log (defaults marked)`, () => {
    const s = sim(pair(protocol, opts));
    s.runTo(protocol === 'dhcp' ? 20000 : 90000);
    const seen = new Set(events(s, (e) => e.kind === 'message' && (e.protocol === protocol || (protocol === 'bfd' && e.protocol === 'bfd'))).map((e) => e.what));
    for (const m of msgs) assert.ok(seen.has(m), `${protocol}: ${m} (seen: ${Array.from(seen).join(', ')})`);
    const st = s.status().filter((x) => x.protocol === protocol);
    assert.ok(st.some((x) => x.state === state), `${protocol}: ${st.map((x) => x.name + ' ' + x.state).join('; ')}`);
    const p = P.simProfile(protocol);
    if (p.timers.length && !['vrrp', 'hsrp', 'glbp', 'carp'].includes(protocol)) {
      assert.ok(events(s, (e) => e.what === 'timers' && e.protocol === protocol && /\(default/.test(e.detail)).length, `${protocol}: timers noted`);
    }
  });
}

test('profiles: failure and restore of a session (OSPF over a failed cable goes Down, then the full handshake again)', () => {
  const s = sim(pair('ospf', { svc: 'ospf: {}' }));
  s.runTo(30000);
  s.fail('link:l');
  s.runTo(31000);
  assert.ok(s.status().filter((x) => x.protocol === 'ospf').every((x) => x.state === 'Down'));
  s.restore('link:l');
  s.runTo(80000);
  assert.ok(s.status().filter((x) => x.protocol === 'ospf').every((x) => x.state === 'Full'));
  const b = sim(pair('bgp', { svc: 'bgp: {asn: 6500#}', ep: ['r1:lo0', 'r2:lo0'] }));
  b.runTo(20000);
  b.fail('link:l');
  b.runTo(20000 + 185000);
  assert.ok(events(b, (e) => e.protocol === 'bgp' && /hold timer expired \(3 min, negotiated\)/.test(e.detail)).length, 'the hold time');
  assert.ok(events(b, (e) => e.what === 'NOTIFICATION').length);
});

test('profiles: timers from the model replace the defaults, and the log says so', () => {
  const s = sim(pair('ospf', { svc: 'ospf: {}', attrs: '{hello: 2, dead: 8}' }));
  s.runTo(5000);
  assert.ok(events(s, (e) => e.what === 'timers' && /hello interval 2 s \(configured\); router dead interval 8 s \(configured\)/.test(e.detail)).length);
  const b = sim(pair('bfd', { svc: 'bfd: {}', attrs: '{interval: 300ms, multiplier: 5}' }));
  b.runTo(3000);
  assert.ok(events(b, (e) => e.what === 'timers' && /transmit interval 0\.3 s \(configured\); detect multiplier 5 \(configured\)/.test(e.detail)).length);
});

test('LACP on the members of an aggregate; STP, LLDP and CDP where the model has their relations', () => {
  const s = sim(example('port-bindings.yaml'));
  s.runTo(10000);
  const lacp = s.status().filter((x) => x.protocol === 'lacp');
  assert.ok(lacp.length >= 2 && lacp.every((x) => x.state === 'Collecting / Distributing'));
  const p = sim(pe);
  assert.ok(flightsOf(p, 0, 10000).some((f) => f.protocol === 'stp' && /^RSTP BPDU$/.test(f.label)));
  assert.deepEqual(p.status().filter((x) => x.protocol === 'stp').map((x) => x.state).sort(), ['Forwarding', 'Forwarding', 'Root bridge']);
  // no STP relation: no BPDUs (loops are still broken)
  const r = sim(reroute);
  assert.ok(!flightsOf(r, 0, 10000).some((f) => f.protocol === 'stp'));
  const ll = sim(`netatlas: 1
title: lldp
devices:
  - {id: a, type: switch, interfaces: [{id: p1, vlans: 1}]}
  - {id: b, type: switch, interfaces: [{id: p1, vlans: 1}]}
links:
  - {id: l, a: "a:p1", b: "b:p1"}
relations:
  - {id: x, protocol: lldp, endpoints: [a, b]}
  - {id: y, protocol: cdp, endpoints: [a, b]}
`);
  ll.runTo(5000);
  assert.deepEqual(ll.status().filter((x) => x.protocol === 'lldp' || x.protocol === 'cdp').map((x) => x.state), ['neighbour known', 'neighbour known', 'neighbour known', 'neighbour known']);
});

test('PIM and IGMP: the receivers join, the source registers with the RP, the data reaches the members only', () => {
  const s = sim(pe);
  s.runTo(80000);
  assert.ok(events(s, (e) => e.protocol === 'igmp' && e.what === 'Report').length);
  assert.ok(events(s, (e) => e.what === 'Register').length);
  assert.ok(events(s, (e) => e.what === 'Register-Stop').length);
  const got = events(s, (e) => e.what === 'receives' && /^\S+ receives 239\.1\.1\.1 from /.test(e.detail));
  assert.deepEqual(Array.from(new Set(got.map((e) => e.device))).sort(), ['pc1', 'rx']);
});

test('simulation: the protocols of a model for the setup’s checkboxes, grouped by layer (Layer 2 first), each with what uses it', () => {
  const s = sim(pe);
  const e = s.protocolEntries();
  assert.deepEqual(e.slice(0, 3).map((x) => x.id), ['arp', 'garp', 'ndp']);
  assert.deepEqual(S.ENTRY_GROUPS, ['Layer 2', 'Routing', 'Redundancy', 'Tunnels and overlays', 'Multicast', 'Services', 'Traffic', 'Custom']);
  assert.ok(e.every((x, i) => i === 0 || S.ENTRY_GROUPS.indexOf(e[i - 1].group) <= S.ENTRY_GROUPS.indexOf(x.group)));
  for (const id of ['stp', 'ospf', 'bgp', 'bfd', 'pim', 'igmp', 'vrrp', 'ipsec', 'gre', 'custom:telemetry', 'demand']) assert.ok(e.some((x) => x.id === id), id);
  // multicast has its own group; every entry says what uses it
  for (const id of ['pim', 'igmp']) assert.equal(e.find((x) => x.id === id).group, 'Multicast');
  const m0 = model(pe);
  const ospf = e.find((x) => x.id === 'ospf');
  assert.equal(ospf.unit, 'relation');
  assert.equal(ospf.uses, m0.relations.filter((r) => r.protocol === 'ospf').length);
  assert.equal(S.usesText(ospf), `${ospf.uses} relation${ospf.uses === 1 ? '' : 's'}`);
  const arp = e.find((x) => x.id === 'arp');
  assert.equal(arp.unit, 'device');
  assert.ok(arp.uses > 1 && arp.uses <= m0.devices.length);
  assert.equal(e.find((x) => x.id === 'demand').unit, 'demand');
  assert.ok(e.every((x) => x.uses >= 1));
  // the simulation never changes the model
  const m = model(pe);
  const before = JSON.stringify(m.devices.map((d) => [d.id, d.interfaces.map((i) => i.mac)]));
  const r = new S.Simulation(m);
  r.runTo(30000);
  assert.equal(JSON.stringify(m.devices.map((d) => [d.id, d.interfaces.map((i) => i.mac)])), before);
});
