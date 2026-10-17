// Simulation attributes at the level real devices configure them
// (analysis/sim/params.ts, validation/simulation.ts, engine.ts): every
// attribute has its level (device, interface, VLAN, relation); the device's
// block holds only device-wide ones (and the device-wide defaults of a few
// object attributes); the order of precedence object → device → simulation
// → default; an attribute written at the wrong level, or on an object it
// does not apply to, is an error that says where it belongs (never moved);
// per-port spanning tree settings act in the simulation (edge port, BPDU
// guard, root guard, port cost, bridge priority, per-VLAN priorities with
// PVST, a shared link); the Edit tab writes an object's attribute as one
// undo step, a shorthand interface becoming a mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const Pm = load('analysis/sim/params.js');
const S = load('analysis/sim/simulation.js');
const Cap = load('model/capabilities.js');
const V = load('validation/validate.js');
const D = load('editor/document.js');

// The switches below are written with bare ports (their attributes are what is tested);
// every switch port is given VLAN 1 (an access port) when the text is read.
const split = (list) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === ',' && !depth) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const portOf = (x) => (x.startsWith('{') ? (/\bvlans:/.test(x) ? x : x.replace(/^\{id: ([^,}]+)/, '{id: $1, vlans: 1')) : `{id: ${x}, vlans: 1}`);
const ports = (line) => {
  const at = line.indexOf('interfaces: [');
  if (at < 0 || !/type: switch/.test(line)) return line;
  let depth = 0;
  let end = at + 'interfaces: '.length;
  for (; end < line.length; end++) {
    if (line[end] === '[') depth++;
    if (line[end] === ']' && !--depth) break;
  }
  const inner = line.slice(at + 'interfaces: ['.length, end);
  return line.slice(0, at) + 'interfaces: [' + split(inner).map(portOf).join(', ') + line.slice(end);
};
const l2 = (text) => text.split('\n').map(ports).join('\n');
const sim = (text, opts) => new S.Simulation(model(l2(text)), opts);
const ev = (s, f) => s.events().filter(f);
const errs = (text) => V.loadModel(l2(text)).errors.map((e) => e.message);

test('every attribute has its level: per device, per interface, per VLAN, per relation (the audit)', () => {
  const lv = (k) => Pm.paramDef(k).level || 'device';
  for (const k of ['boot-time', 'ecmp-max', 'spf-delay', 'ttl', 'icmp-rate', 'bcast-ping', 'tcp-syn-retries', 'mac-aging', 'mac-table-size', 'stp-mode', 'stp-hello', 'stp-forward-delay', 'stp-max-age', 'bridge-priority', 'bridge-priority-vlans', 'mrouter-aging', 'spt-switchover', 'fw-action', 'fw-tcp', 'ha-failover', 'ips-fail', 'restart-policy', 'snmp-interval', 'ap-association', 'ap-idle', 'listening', 'test-traffic', 'test-targets', 'app-timeout']) assert.equal(lv(k), 'device', k);
  for (const k of ['arp-timeout', 'arp-retransmit', 'arp-retries', 'ndp-reachable', 'ping', 'icmp-errors', 'link-up-delay', 'los-detect', 'flapping', 'storm-bc', 'storm-mc', 'stp-port', 'stp-cost', 'stp-port-priority', 'stp-edge', 'stp-bpdu-guard', 'stp-root-guard', 'stp-link-type', 'lacp-rate', 'igmp-version', 'igmp-unsolicited', 'igmp-querier', 'igmp-query', 'igmp-max-resp', 'igmp-robustness', 'igmp-lmqi', 'pim-dr-priority', 'directed-broadcast', 'mc-passthrough', 'mc-to-unicast', 'ap-beacon']) assert.equal(lv(k), 'interface', k);
  for (const k of ['snoop-querier', 'fast-leave']) assert.equal(lv(k), 'vlan', k);
  // IGMP / MLD snooping itself is no simulation attribute: the switch's configuration (igmp_mld_snooping)
  for (const k of ['igmp-snooping', 'unknown-mc']) assert.throws(() => Pm.paramDef(k), /unknown simulation parameter/);
  // a hypervisor's VM restart time, a virtual switch's failover detection, a container engine's start time: per service object
  for (const [k, svc] of [['vm-restart', 'hypervisor'], ['failover-detect', 'vswitch'], ['container-start', 'container_engine']]) assert.deepEqual([lv(k), Pm.paramDef(k).svc], ['service', svc], k);
  for (const k of ['vrrp-advert', 'ike-lifetime', 'child-lifetime', 'rekey-margin', 'dpd-interval', 'dpd-retries', 'mc-tunnel', 'lb-hc-interval', 'lb-hc-timeout', 'lb-hc-fall', 'lb-persistence', 'lb-algorithm', 'service-response']) assert.equal(lv(k), 'relation', k);
  // a device-wide default only where real devices have one
  const dd = Pm.PARAMS.filter((p) => p.level && p.level !== 'device' && p.devDefault).map((p) => p.key).sort();
  assert.deepEqual(dd, ['arp-retransmit', 'arp-retries', 'arp-timeout', 'child-lifetime', 'dpd-interval', 'dpd-retries', 'icmp-errors', 'igmp-lmqi', 'igmp-max-resp', 'igmp-querier', 'igmp-query', 'igmp-robustness', 'igmp-unsolicited', 'igmp-version', 'ike-lifetime', 'mc-tunnel', 'ndp-reachable', 'ping', 'rekey-margin', 'service-response', 'stp-bpdu-guard', 'stp-edge', 'dhcp-offer-delay', 'dhcp-ping-check'].sort());
  // where each kind of object's attributes apply
  const sw = { id: 's', type: 'switch', caps: Cap.capabilities({ type: 'switch' }), ip: false, routes: false, aggregate: true, ipsec: false, snmpManager: false, hypervisor: false };
  const port = { port: true, ip: false, dhcp: false, lag: false, bridgePort: true, radio: false };
  assert.deepEqual(Pm.interfaceParams(sw, port).map((p) => p.key), ['los-detect', 'flapping', 'link-up-delay', 'stp-port', 'stp-cost', 'stp-port-priority', 'stp-edge', 'stp-bpdu-guard', 'stp-root-guard', 'stp-link-type', 'storm-bc', 'storm-mc']);
  assert.ok(Pm.interfaceParams(sw, { ...port, port: false, lag: true }).some((p) => p.key === 'lacp-rate'));
  const r = { id: 'r', type: 'router', caps: Cap.capabilities({ type: 'router' }), ip: true, routes: true, aggregate: false, ipsec: false, snmpManager: false, hypervisor: false };
  const routed = { port: true, ip: true, dhcp: false, lag: false, bridgePort: false, radio: false };
  const rk = Pm.interfaceParams(r, routed).map((p) => p.key);
  assert.ok(['arp-timeout', 'igmp-querier', 'pim-dr-priority', 'directed-broadcast', 'link-up-delay'].every((k) => rk.includes(k)) && !rk.includes('stp-edge'));
  assert.deepEqual(Pm.relationParams({ base: 'ipsec', lbService: false, serverService: false }).map((p) => p.key), ['ike-lifetime', 'child-lifetime', 'rekey-margin', 'dpd-interval', 'dpd-retries', 'mc-tunnel']);
  assert.deepEqual(Pm.relationParams({ base: 'vrrp', lbService: false, serverService: false }).map((p) => p.key), ['vrrp-advert']);
});

test('the order of precedence: configured → object → device → simulation → default; "Inherited: device" for an object', () => {
  const ps = new Pm.SimParams({ 'arp-timeout': 600000 }, new Map([['r1', { type: 'router', values: new Map([['arp-timeout', 300000]]) }]]));
  ps.setObject(Pm.ifaceRef('r1', 'ge1'), 'r1', new Map([['arp-timeout', 60000]]));
  const at = (iface) => ps.get('arp-timeout', 'r1', null, Pm.ifaceRef('r1', iface));
  assert.deepEqual([at('ge1').value, at('ge1').source, at('ge1').where], [60000, 'object', 'r1:ge1']);
  assert.deepEqual([at('ge2').value, at('ge2').source], [300000, 'device'], 'another interface: the device’s default');
  assert.deepEqual([ps.get('arp-timeout', 'r2', null, Pm.ifaceRef('r2', 'ge1')).value, ps.get('arp-timeout', 'r2').source], [600000, 'simulation']);
  assert.equal(ps.get('arp-timeout', 'r1', { value: 1000, where: 'x' }, Pm.ifaceRef('r1', 'ge1')).source, 'configured');
  assert.equal(Pm.resolvedText(at('ge1')), '1 min (set on r1:ge1)');
  assert.deepEqual([ps.inheritedAt('arp-timeout', 'r1').value, ps.inheritedAt('arp-timeout', 'r1').source], [300000, 'device']);
  // an object attribute without a device-wide default: the device's value is not consulted
  const q = new Pm.SimParams({}, new Map([['s', { type: 'switch', values: new Map([['stp-cost', 5]]) }]]));
  assert.equal(q.get('stp-cost', 's', null, Pm.ifaceRef('s', 'p1')).source, 'default');
  // a VLAN: the untagged frames are VLAN 1
  assert.equal(Pm.vlanRef(0), 'vlan:1');
  q.setObject(Pm.vlanRef(10), undefined, new Map([['fast-leave', 'on']]));
  assert.equal(q.str('fast-leave', 's', Pm.vlanRef(10)), 'on');
  assert.equal(q.str('fast-leave', 's', Pm.vlanRef(20)), 'off');
});

const SW = (x = {}) => `netatlas: 2
title: l2
devices:
  - {id: sw1, type: switch, interfaces: [${x.p1 || 'p1'}, p2, p3]${x.sw1 || ''}}
  - {id: sw2, type: switch, interfaces: [${x.q1 || 'p1'}, p2, p3]${x.sw2 || ''}}
  - {id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}
  - {id: h2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
  - {id: c, a: "sw1:p3", b: "h1:eth0"}
  - {id: d, a: "sw2:p3", b: "h2:eth0"}
${x.more || ''}`;

test('wrong level: a port’s attribute on the device, a device’s on a port, a VLAN attribute without a VLAN, one that does not apply: errors that say where it belongs, never moved', () => {
  assert.deepEqual(errs(SW({ p1: '{id: p1, simulation: {stp_edge: on, stp_cost: 4}}', sw1: ', simulation: {stp_mode: rstp, bridge_priority: 4096}' })), []);
  const m = model(l2(SW({ p1: '{id: p1, simulation: {stp_edge: on, stp_cost: 4}}' })));
  assert.deepEqual(Array.from(m.index.interfaces.get('sw1:p1').simulation), [['stp-edge', 'on'], ['stp-cost', 4]]);
  assert.match(errs(SW({ sw1: ', simulation: {stp_cost: 4}' })).join('|'), /"stp_cost" \(port path cost\) is set per switch port: in the switch port’s simulation:, not for the whole device/);
  assert.match(errs(SW({ p1: '{id: p1, simulation: {stp_mode: stp}}' })).join('|'), /"stp_mode" \(spanning tree\) is set per device: in the device’s simulation:, not on an interface/);
  assert.match(errs(SW({ p1: '{id: p1, simulation: {fast_leave: on}}' })).join('|'), /"fast_leave" \(fast leave\) is set per VLAN: in the simulation: of the network with that VLAN, not on an interface/);
  assert.match(errs(SW({ more: 'networks:\n  - {id: n, cidr: 10.0.0.0/24, simulation: {fast_leave: on}}\n' })).join('|'), /network "n" has simulation attributes of a VLAN but no VLAN: give it its "vlan:"/);
  assert.deepEqual(errs(SW({ more: 'networks:\n  - {id: n, cidr: 10.0.0.0/24, vlan: 1, simulation: {fast_leave: on}}\n' })), []);
  // the removed attributes say where snooping is configured now
  assert.match(errs(SW({ more: 'networks:\n  - {id: n, cidr: 10.0.0.0/24, vlan: 1, simulation: {igmp_snooping: off}}\n' })).join('|'), /unknown simulation attribute "igmp_snooping": IGMP \/ MLD snooping is the switch’s own configuration — igmp_mld_snooping on each switch, enabled or disabled per VLAN/);
  assert.match(errs(SW({ sw1: ', simulation: {igmp_snooping: off}' })).join('|'), /unknown simulation attribute "igmp_snooping": IGMP \/ MLD snooping is the switch’s own configuration/);
  assert.match(errs(SW({ more: 'networks:\n  - {id: n, cidr: 10.0.0.0/24, vlan: 1, simulation: {unknown_multicast: drop}}\n' })).join('|'), /unknown simulation attribute "unknown_multicast": with IGMP \/ MLD snooping enabled a group without members goes to the multicast router ports only/);
  // on an object it does not apply to
  assert.match(errs(SW().replace('{id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]}', '{id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24, simulation: {stp_edge: on}}]}')).join('|'), /"stp_edge" \(edge port \(portfast\)\) does not apply to h1:eth0, a port with an address/);
  assert.match(errs(SW({ more: 'relations:\n  - {id: x, protocol: ssh, endpoints: [h1, h2], simulation: {ike_lifetime: 1h}}\n' })).join('|'), /"ike_lifetime" \(ike sa lifetime\) does not apply to relation "x"/);
  assert.match(errs(SW({ more: 'relations:\n  - {id: x, protocol: ssh, endpoints: [h1, h2], simulation: {stp_cost: 4}}\n' })).join('|'), /"stp_cost" \(port path cost\) is set per switch port: in the switch port’s simulation:, not on a relation/);
});

test('per-port spanning tree: bridge priority elects the root, port cost picks the root port, root guard blocks a port with a better root behind it', () => {
  // without settings: sw1 or sw2 by MAC; with bridge priority 4096 sw2 is the root
  const s = sim(SW({ sw2: ', simulation: {bridge_priority: 4096}' }));
  s.runTo(2500);
  assert.equal(s.engine.tree(1).root, 'sw2');
  // sw1's root port: p1 (lower port id) unless p2 is cheaper
  assert.deepEqual(Array.from(s.engine.tree(1).rootPorts), ['sw1|p1']);
  assert.deepEqual(Array.from(s.engine.tree(1).blocked), ['sw1|p2']);
  const c = sim(SW({ sw2: ', simulation: {bridge_priority: 4096}', p1: '{id: p1, simulation: {stp_cost: 200000}}' }));
  c.runTo(2500);
  assert.deepEqual(Array.from(c.engine.tree(1).rootPorts), ['sw1|p2'], 'the cheaper path');
  assert.deepEqual(Array.from(c.engine.tree(1).blocked), ['sw1|p1']);
  // root guard on sw1's ports towards the better root: they are blocked (root-inconsistent), sw1 stays its own root
  const g = sim(SW({ sw2: ', simulation: {bridge_priority: 4096}', p1: '{id: p1, simulation: {stp_root_guard: on}}' }).replace('[{id: p1, simulation: {stp_root_guard: on}}, p2, p3]', '[{id: p1, simulation: {stp_root_guard: on}}, {id: p2, simulation: {stp_root_guard: on}}, p3]'));
  g.runTo(2500);
  const t = g.engine.tree(1);
  assert.ok(t.inconsistent.has('sw1|p1') && t.inconsistent.has('sw1|p2') && t.blocked.has('sw1|p1') && t.blocked.has('sw1|p2'), JSON.stringify([...t.blocked]));
  assert.ok(ev(g, (e) => e.what === 'Root guard' && /sw1:p1 is root-inconsistent .*root guard blocks the port/.test(e.detail)).length === 1);
  // a port without spanning tree is never blocked: the loop over it storms
  const off = sim(SW({ p1: '{id: p1, simulation: {stp: off}}' }).replace('{id: sw1, type: switch, interfaces: [{id: p1, simulation: {stp: off}}, p2, p3]}', '{id: sw1, type: switch, interfaces: [{id: p1, simulation: {stp: off}}, {id: p2, simulation: {stp: off}}, p3]}'));
  off.runTo(2500);
  assert.equal(off.engine.tree(1).blocked.size, 0);
});

test('PVST and MSTP: a priority per VLAN gives each VLAN its own root; RSTP keeps the bridge priority for every VLAN', () => {
  const Y = (mode) => `netatlas: 2
title: pvst
devices:
  - {id: sw1, type: switch, interfaces: [{id: p1, vlans: [10, 20]}, {id: p2, vlans: [10, 20]}], simulation: {stp_mode: ${mode}, bridge_priority_vlans: "10=4096"}}
  - {id: sw2, type: switch, interfaces: [{id: p1, vlans: [10, 20]}, {id: p2, vlans: [10, 20]}], simulation: {stp_mode: ${mode}, bridge_priority_vlans: "20=4096"}}
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
`;
  const p = sim(Y('pvst'));
  p.runTo(2500);
  assert.deepEqual([p.engine.tree(10).root, p.engine.tree(20).root], ['sw1', 'sw2']);
  const r = sim(Y('rstp'));
  r.runTo(2500);
  assert.equal(r.engine.tree(10).root, r.engine.tree(20).root, 'one priority for all VLANs');
});

test('an edge port forwards at once with STP; a host port without it listens and learns for 2 × forward delay; BPDU guard err-disables a port that hears a bridge', () => {
  const stp = (p3) => SW({ sw1: ', simulation: {stp_mode: stp}', sw2: ', simulation: {stp_mode: stp}' }).replace('{id: sw1, type: switch, interfaces: [p1, p2, p3]', `{id: sw1, type: switch, interfaces: [p1, p2, ${p3}]`);
  const plain = sim(stp('p3'));
  plain.runTo(2500);
  assert.ok(ev(plain, (e) => e.what === 'Listening' && /sw1:p3 \(to h1\) listens and learns for 2 × forward delay 15 s \(STP; edge port Off \(default\)\): it forwards at t = 32/.test(e.detail)).length === 1);
  assert.equal(plain.engine.blocked('sw1', 'p3', 1), true);
  plain.runTo(33000);
  assert.equal(plain.engine.blocked('sw1', 'p3', 1), false);
  const edge = sim(stp('{id: p3, simulation: {stp_edge: on}}'));
  edge.runTo(2500);
  assert.equal(edge.engine.blocked('sw1', 'p3', 1), false, 'forwarding at once');
  assert.ok(!ev(edge, (e) => e.what === 'Listening' && e.device === 'sw1' && /sw1:p3/.test(e.detail)).length);
  // the device-wide default (PortFast default) applies to its ports
  const all = sim(stp('p3').replace('simulation: {stp_mode: stp}}', 'simulation: {stp_mode: stp, stp_edge: on}}'));
  all.runTo(2500);
  assert.equal(all.engine.blocked('sw1', 'p3', 1), false);
  // BPDU guard on a port that hears a bridge: err-disabled (shut) until no shut
  const guard = sim(SW({ p1: '{id: p1, simulation: {stp_bpdu_guard: on}}' }));
  guard.runTo(3000);
  assert.ok(ev(guard, (e) => e.what === 'BPDU guard' && /BPDU guard on sw1:p1 \(On \(set on sw1:p1\)\): a BPDU from sw2:p1, a bridge where a host was expected; the port is err-disabled/.test(e.detail)).length === 1);
  assert.ok(guard.engine.shutPorts.has('sw1|p1'));
  guard.engine.noShut('sw1', 'p1');
  assert.ok(!guard.engine.shutPorts.has('sw1|p1'));
  // on a host port it does nothing
  const quiet = sim(SW().replace('{id: sw1, type: switch, interfaces: [p1, p2, p3]', '{id: sw1, type: switch, interfaces: [p1, p2, {id: p3, simulation: {stp_bpdu_guard: on}}]'));
  quiet.runTo(3000);
  assert.ok(!quiet.engine.shutPorts.has('sw1|p3'));
});

test('a shared link waits like STP even with RSTP; storm control and the link-up delay are a port’s', () => {
  const sh = sim(SW({ q1: '{id: p1, simulation: {stp_link_type: shared}}' }));
  sh.runTo(2500);
  // a port opened on the shared link waits 2 × forward delay
  sh.fail('link:a');
  sh.runTo(sh.now + 200);
  const tc = ev(sh, (e) => e.what === 'Topology change' && e.t > 2500).map((e) => e.detail).join(' | ');
  void tc;
  sh.restore('link:a');
  sh.runTo(sh.now + 3000);
  const waits = ev(sh, (e) => e.what === 'Topology change' && /on a shared link: listening and learning, 2 × forward delay 15 s/.test(e.detail));
  assert.ok(waits.length >= 1, ev(sh, (e) => e.what === 'Topology change').map((e) => e.detail).join('\n'));
  // the link-up delay: the slower of the cable's two ports
  const slow = sim(SW({ p1: '{id: p1, simulation: {link_up_delay: 5}}' }));
  slow.runTo(4000);
  assert.ok(!slow.engine.linkUp('a') && slow.engine.linkUp('b'));
  slow.runTo(5500);
  assert.ok(slow.engine.linkUp('a'));
});

test('the Edit tab: an interface’s attribute is written in its simulation: block (a shorthand interface becomes a mapping), one undo step; Reset removes it', () => {
  const d = D.ModelDoc.fromText(l2(SW()), 't.yaml', 'file').doc;
  d.setSimAttrAt(['devices', 0, 'interfaces', 0], 'stp_edge', 'on');
  assert.match(d.exportText(), /- \{?id: p1,? ?\n?\s*simulation: \{stp_edge: on\}|id: p1\n\s+simulation:\n\s+stp_edge: on|\{id: p1, (vlans: 1, )?simulation: \{stp_edge: on\}\}/);
  assert.equal(d.result.model.index.interfaces.get('sw1:p1').simulation.get('stp-edge'), 'on');
  assert.deepEqual(d.result.errors, []);
  d.setSimAttrAt(['devices', 0, 'interfaces', 0], 'stp_edge', undefined);
  assert.equal(d.result.model.index.interfaces.get('sw1:p1').simulation, undefined);
  assert.doesNotMatch(d.exportText(), /simulation/);
  // a network's (VLAN) and a relation's
  const n = D.ModelDoc.fromText(l2(SW({ more: 'networks:\n  - {id: n, cidr: 10.0.0.0/24, vlan: 1}\nrelations:\n  - {id: v, protocol: vrrp, endpoints: [h1, h2]}\n' })), 't.yaml', 'file').doc;
  n.setSimAttrAt(['networks', 0], 'fast_leave', 'on');
  n.setSimAttrAt(['relations', 0], 'vrrp_advert', '3');
  assert.equal(n.result.model.networks[0].simulation.get('fast-leave'), 'on');
  assert.equal(n.result.model.relations[0].simulation.get('vrrp-advert'), 3000);
  assert.deepEqual(n.result.errors, []);
});
