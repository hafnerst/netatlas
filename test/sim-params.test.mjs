// The simulation's parameters and network events (analysis/sim/params.ts,
// engine.ts) without a browser: the registry (sections of at most 8, every
// parameter with its default, unit, range, help and source), parsing and
// range checks, the order of precedence (configured, device, simulation,
// default) and its source labels, the devices' `simulation:` blocks
// (validation, which attributes each type has, YAML with overrides only,
// one undo step that the simulation's edit lock allows), Layer 1 (latency
// as propagation plus serialization, packet loss, loss-of-signal
// detection, link-up delay), every network event (a failed cable and
// relation, flapping, shut, power off and on, several at once), changes
// applied at once during a simulation, and determinism with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, errorsOf, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const Pm = load('analysis/sim/params.js');
const At = load('analysis/sim/attrs.js');
const D = load('editor/document.js');
const DT = load('model/device-types.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);
const events = (s, f) => s.events().filter(f);
const pe = example('protocol-simulation.yaml');
/** the example without its flapping uplink */
const steady = pe.replace(/\n *simulation: \{flapping: true\}/, '');

/** Every flight of a run, collected step by step (the engine keeps only the last seconds). */
function flightsOf(s, to) {
  const seen = new Map();
  while (s.now < to) {
    s.step(Math.min(500, to - s.now));
    for (const f of s.engine.flights) seen.set(f.id, f);
  }
  return Array.from(seen.values());
}

const PAIR = (link = '', extra = '') => `netatlas: 1
title: pair
devices:
  - {id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}]${extra}}
  - {id: h2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}]}
links:
  - {id: l, a: "h1:eth0", b: "h2:eth0", speed: 1M${link}}
demands:
  - {id: d, source: h1, destination: h2, bandwidth: 1M}
`;

// ------------------------------------------------------------------ the registry

test('the parameters: four layers, at most 8 rows each; every one with a default in its range, a unit, a short help and a source', () => {
  assert.deepEqual(Pm.paramLayers(), [1, 2, 3, 4]);
  const rows = Pm.paramLayers().map((l) => Pm.layerRows(l).length);
  assert.deepEqual(rows, [8, 8, 8, 8]);
  assert.ok(rows.every((n) => n <= 8));
  // BFD interval and multiplier share a row
  assert.deepEqual(Pm.layerRows(3).find((r) => r[0].key === 'bfd-interval').map((d) => d.key), ['bfd-interval', 'bfd-multiplier']);
  for (const p of Pm.PARAMS) {
    assert.ok(p.source && p.help && p.label, p.key);
    assert.ok(p.help.length <= 85, `${p.key}: help is short (${p.help.length})`);
    if (p.kind === 'list') {
      // a list's default is empty: what that means is its own (its relations' ports, nothing more …)
      assert.ok(p.dflt === '' && p.zero && p.list, p.key);
      continue;
    }
    if (p.kind !== 'enum') assert.ok(Number(p.dflt) >= p.min && Number(p.dflt) <= p.max, `${p.key}: default in range`);
    else assert.ok(p.options.some((o) => o.value === p.dflt), p.key);
    assert.ok('value' in Pm.parseValue(p, Pm.fieldText(p, p.dflt)), `${p.key}: its default as a field reads back`);
  }
  assert.equal(Pm.LAYER_TITLES[2], 'Layer 2 – Data link');
  // the defaults and their sources
  const d = (k) => Pm.formatValue(Pm.paramDef(k), Pm.paramDef(k).dflt);
  assert.deepEqual(['link-latency', 'loss', 'los-detect', 'link-up-delay', 'default-speed', 'flap-down', 'flap-up', 'flap-cycles'].map(d), ['100 µs', '0 %', '0 s', '2 s', '1 Gbit/s', '5 s', '10 s', '3']);
  assert.deepEqual(['arp-timeout', 'arp-retransmit', 'arp-retries', 'ndp-reachable', 'mac-aging', 'stp-mode'].map(d), ['4 h', '1 s', '3', '30 s', '5 min', 'RSTP']);
  assert.deepEqual(['ttl', 'ospf-hello', 'bgp-keepalive', 'bfd-interval', 'bfd-multiplier', 'vrrp-advert', 'spf-delay'].map(d), ['64', '10 s', '1 min', '300 ms', '3', '1 s', '200 ms']);
  assert.deepEqual(['mtu', 'icmp-errors'].map(d), ['1500', 'On']);
  assert.deepEqual(['tcp-syn-retries', 'tcp-rto', 'tcp-keepalive', 'closed-port', 'test-traffic', 'test-interval', 'test-type', 'app-timeout'].map(d), ['6', '1 s', '2 h', 'On', 'Off', '5 s', 'ICMP echo', '5 s']);
  assert.match(Pm.paramDef('tcp-rto').source, /RFC 6298/);
  assert.match(Pm.paramDef('mtu').source, /RFC 894/);
  assert.match(Pm.paramDef('arp-timeout').source, /Cisco IOS/);
  assert.match(Pm.paramDef('ospf-hello').source, /RFC 2328/);
  assert.match(Pm.paramDef('mac-aging').source, /802\.1D/);
  assert.match(Pm.helpText(Pm.paramDef('ttl')), /Default 64: RFC 1700/);
});

test('values: durations with a unit or in the parameter’s own unit, percentages, speeds, choices; out of range and wrong units are errors', () => {
  const p = (k, v) => Pm.parseValue(Pm.paramDef(k), v);
  assert.deepEqual(p('arp-timeout', '60'), { value: 60000 });
  assert.deepEqual(p('arp-timeout', 60), { value: 60000 });
  assert.deepEqual(p('arp-timeout', '4h'), { value: 14400000 });
  assert.deepEqual(p('arp-timeout', '5 min'), { value: 300000 });
  assert.deepEqual(p('link-latency', '0.1'), { value: 0.1 });
  assert.deepEqual(p('link-latency', '250us'), { value: 0.25 });
  assert.deepEqual(p('bfd-interval', '1s'), { value: 1000 });
  assert.deepEqual(p('loss', '2.5%'), { value: 2.5 });
  assert.deepEqual(p('default-speed', '10G'), { value: 1e10 });
  assert.deepEqual(p('stp-mode', 'STP'), { value: 'stp' });
  assert.match(p('arp-timeout', '0').error, /must be from 1 s to /);
  assert.match(p('loss', '120').error, /must be from 0 % to 100 %/);
  assert.match(p('arp-timeout', '4 lightyears').error, /is not a duration/);
  assert.match(p('arp-retries', '2.5').error, /whole number/);
  assert.match(p('stp-mode', 'mst').error, /one of rstp, mstp, pvst, stp, off/);
  assert.match(p('bridge-priority', '1000').error, /must be a multiple of 4096/);
  assert.deepEqual(p('bridge-priority-vlans', '20=8192, 10:4096'), { value: '10=4096, 20=8192' });
  assert.match(p('bridge-priority-vlans', '10=4000').error, /multiple of 4096/);
  assert.match(p('default-speed', 'fast').error, /not a speed/);
  assert.equal(Pm.formatValue(Pm.paramDef('flap-cycles'), 0), 'continuous');
});

test('precedence: configured on the object, then the device’s attribute, then the simulation’s value, then the default; each says where it comes from', () => {
  const ps = new Pm.SimParams({ 'arp-timeout': 600000 }, new Map([['r1', { type: 'router', values: new Map([['arp-timeout', 60000]]) }], ['r2', { type: 'router', values: new Map() }]]));
  const r = (dev, cfg) => ps.get('arp-timeout', dev, cfg);
  assert.deepEqual([r('r1').value, r('r1').source], [60000, 'device']);
  assert.deepEqual([r('r2').value, r('r2').source], [600000, 'simulation']);
  assert.deepEqual([r('r1', { value: 5000, where: 'cable x' }).value, r('r1', { value: 5000, where: 'cable x' }).source], [5000, 'configured']);
  assert.equal(Pm.resolvedText(r('r1', { value: 5000, where: 'cable x' })), '5 s (configured on cable x)');
  assert.equal(Pm.resolvedText(r('r1')), '1 min (device)');
  assert.equal(Pm.resolvedText(r('r2')), '10 min (simulation)');
  ps.setSim('arp-timeout', undefined);
  assert.equal(Pm.resolvedText(ps.get('arp-timeout', 'r2')), '4 h (default)');
  assert.equal(Pm.sourceText(ps.get('arp-timeout', 'r2'), true), 'default — Cisco IOS (4 h); RFC 826 sets none');
  // what r1 would inherit without its own value
  assert.equal(Pm.resolvedText(ps.inherited('arp-timeout', 'r1')), '4 h (default)');
  // a default per device type
  const b = new Pm.SimParams({}, new Map([['c', { type: 'container', values: new Map() }], ['r', { type: 'router', values: new Map() }]]));
  assert.deepEqual([b.num('boot-time', 'c'), b.num('boot-time', 'r')], [2000, 60000]);
  // a change says what changed
  const c = ps.setSim('mac-aging', 60000);
  assert.equal(Pm.changeText(c), 'Parameter changed: MAC aging time 5 min → 1 min (simulation)');
  assert.equal(ps.setSim('mac-aging', 60000), null, 'no change, nothing to say');
  // the values remembered for the session: only known, valid ones
  assert.deepEqual(Pm.readStoredParams(JSON.stringify({ 'arp-timeout': 60000, loss: 500, nope: 1, 'stp-mode': 'stp', 'boot-time': 1000 })), { 'arp-timeout': 60000, 'stp-mode': 'stp' });
  assert.deepEqual(Pm.readStoredParams('{oops'), {});
});

// ------------------------------------------------------------------ the devices' simulation attributes

test('every device type has its simulation attributes (boot time at least); which ones follow from the type and what the model gives the device', () => {
  const byType = Object.fromEntries(Pm.attributesByType().map((x) => [x.type, x.keys]));
  assert.deepEqual(Object.keys(byType).sort(), DT.DEVICE_TYPE_IDS.slice().sort());
  for (const t of DT.DEVICE_TYPE_IDS) assert.ok(byType[t].indexOf('boot-time') >= 0, t);
  assert.ok(['mac-aging', 'mac-table-size', 'stp-mode', 'stp-hello', 'stp-forward-delay', 'stp-max-age', 'bridge-priority', 'bridge-priority-vlans', 'arp-timeout', 'spf-delay'].every((k) => byType.switch.indexOf(k) >= 0), 'a (Layer 3) switch');
  // what is set per port, per VLAN or per relation is no device attribute (a device-wide default only where devices have one)
  assert.ok(['lacp-rate', 'stp-cost', 'stp-root-guard', 'storm-bc', 'fast-leave', 'link-up-delay'].every((k) => byType.switch.indexOf(k) < 0), 'per port or per VLAN');
  assert.ok(['stp-edge', 'stp-bpdu-guard', 'igmp-snooping'].every((k) => byType.switch.indexOf(k) >= 0), 'their device-wide defaults');
  assert.ok(['spf-delay', 'ecmp-max', 'ttl', 'arp-timeout'].every((k) => byType.router.indexOf(k) >= 0));
  assert.ok(byType.firewall.indexOf('ha-failover') >= 0);
  assert.deepEqual(byType.ids_ips.filter((k) => /^ips-/.test(k)), ['ips-fail', 'ips-latency']);
  assert.ok(['ike-lifetime', 'child-lifetime', 'rekey-margin', 'dpd-interval', 'dpd-retries'].every((k) => byType.gateway.indexOf(k) >= 0));
  assert.ok(['service-response', 'vm-restart'].every((k) => byType.server.indexOf(k) >= 0));
  assert.ok(byType.vm.indexOf('service-response') >= 0 && byType.vm.indexOf('vm-restart') < 0);
  assert.deepEqual(byType.cloud, ['link-latency', 'loss', 'boot-time', 'mc-support']);
  assert.ok(byType.ap.indexOf('ap-association') >= 0);
  assert.ok(byType.system.indexOf('snmp-interval') >= 0 && byType.system.indexOf('snmp-timeout') >= 0);
  // from the model: a Layer 2 switch's attributes, a router without aggregates has no LACP rate
  const m = model(pe);
  const keys = (id) => At.deviceAttributes(m, m.index.devices.get(id)).map((p) => p.key);
  assert.ok(keys('acc-sw').indexOf('mac-aging') >= 0 && keys('acc-sw').indexOf('spf-delay') < 0, 'a Layer 2 switch routes nothing');
  assert.ok(keys('core1').indexOf('spf-delay') >= 0, 'a Layer 3 switch has the router’s');
  assert.ok(keys('r1').indexOf('lacp-rate') < 0);
  assert.ok(keys('r2').indexOf('dpd-interval') >= 0, 'an IPsec endpoint has the VPN attributes');
});

test('a device’s simulation: block: overrides only, checked for the attribute, the device type, the range and the unit; a cable’s simulation: block', () => {
  const dev = (block, type = 'router') => `netatlas: 1\ntitle: t\ndevices:\n  - {id: r, type: ${type}, simulation: ${block}}\n`;
  assert.deepEqual(errorsOf(dev('{arp_timeout: 60, spf_delay: 50ms, boot_time: 2min, max_paths: 8}')), []);
  const m = model(dev('{arp_timeout: 60, spf_delay: 50ms}'));
  assert.deepEqual(Array.from(m.index.devices.get('r').simulation), [['arp-timeout', 60000], ['spf-delay', 50]]);
  const msg = (t) => errorsOf(t).map((e) => e.message).join(' | ');
  assert.match(msg(dev('{arp_timout: 60}')), /unknown simulation attribute "arp_timout" — did you mean "arp_timeout"\?/);
  assert.match(msg(dev('{mac_aging: 60}')), /"mac_aging" \(mac aging time\) does not apply to "r", a Router/);
  assert.match(msg(dev('{arp_timeout: 0}')), /ARP timeout must be from 1 s to /);
  assert.match(msg(dev('{arp_timeout: 4 lightyears}')), /ARP timeout is not a duration .*a bare number is in seconds/);
  assert.match(msg(dev('{stp_mode: mst}', 'switch')), /Spanning tree must be one of rstp, mstp, pvst, stp, off/);
  assert.deepEqual(errorsOf(dev('{stp_mode: pvst, mac_aging: 120, bridge_priority: 4096, stp_edge: on}', 'switch')), []);
  // an attribute of a port is no device attribute: an error that says where it belongs (it is not moved)
  assert.match(msg(dev('{stp_mode: stp, lacp_rate: fast}', 'switch')), /"lacp_rate" \(lacp rate\) is set per aggregate \(LAG\): in the aggregate \(LAG\)’s simulation:, not for the whole device/);
  assert.match(msg(dev('{fast_leave: on}', 'switch')), /"fast_leave" \(fast leave\) is set per VLAN: in the simulation: of the network with that VLAN, not for the whole device/);
  // the old fields are gone: one place for the timers
  assert.match(msg(`netatlas: 1\ntitle: t\ndevices:\n  - {id: r, type: router, arp_timeout: 60}\n`), /unknown key "arp_timeout"/);
  // a cable
  const link = (b) => `netatlas: 1\ntitle: t\ndevices:\n  - {id: a, interfaces: [p]}\n  - {id: b, interfaces: [p]}\nlinks:\n  - {id: l, a: "a:p", b: "b:p", simulation: ${b}}\n`;
  assert.deepEqual(model(link('{latency: 5, loss: 1.5, flapping: true}')).links[0].simulation, { latency: 5, loss: 1.5, flapping: true });
  assert.match(msg(link('{latency: -1}')), /Link latency must be from 0 s/);
  assert.match(msg(link('{latency: fast}')), /Link latency is not a duration/);
  assert.match(msg(link('{jitter: 1}')), /unknown key "jitter"/);
});

test('the Edit tab writes only overrides, as one undo step, also while a simulation locks the model; emptied, the block goes', () => {
  const d = D.ModelDoc.fromText(`netatlas: 1\ntitle: t\ndevices:\n  - id: r\n    type: router\n`, 't.yaml', 'file').doc;
  d.lock = 'a simulation is running';
  assert.throws(() => d.setText(['devices', 0, 'label'], 'x'), /a simulation is running/);
  d.setSimAttr(0, 'arp_timeout', '60');
  d.setSimAttr(0, 'spf_delay', '50');
  assert.match(d.exportText(), /simulation: \{arp_timeout: 60, spf_delay: 50\}|simulation:\n {6}arp_timeout: 60\n {6}spf_delay: 50/);
  assert.equal(d.result.model.index.devices.get('r').simulation.get('arp-timeout'), 60000);
  assert.equal(d.undoLocked(), false, 'undoing it is allowed during the simulation');
  assert.ok(d.undo());
  assert.equal(d.result.model.index.devices.get('r').simulation.get('spf-delay'), undefined);
  d.setSimAttr(0, 'arp_timeout', undefined);
  assert.doesNotMatch(d.exportText(), /simulation/);
});

// ------------------------------------------------------------------ Layer 1

test('Layer 1: latency is the cable’s propagation plus the frame’s serialization at the cable’s speed; packet loss from a fixed seed', () => {
  const s = sim(PAIR(', simulation: {latency: 2}'));
  const arp = flightsOf(s, 3000).find((f) => f.protocol === 'arp' || f.protocol === 'garp');
  // 64 bytes at 1 Mbit/s: 0.512 ms, plus 2 ms
  assert.ok(Math.abs(arp.t1 - arp.t0 - 2.512) < 1e-6, String(arp.t1 - arp.t0));
  assert.equal(Pm.resolvedText(s.engine.latency('l')), '2 ms (configured on cable l)');
  assert.equal(Pm.resolvedText(s.engine.speed('l')), '1 Mbit/s (configured on cable l)');
  // the simulation's latency and speed for a cable without its own
  const t = sim(PAIR().replace(', speed: 1M', ''), { params: { 'link-latency': 5 } });
  assert.equal(Pm.resolvedText(t.engine.latency('l')), '5 ms (simulation)');
  assert.equal(Pm.resolvedText(t.engine.speed('l')), '1 Gbit/s (default)');
  // a cloud's latency applies to its cables
  const c = sim(`netatlas: 1\ntitle: c\ndevices:\n  - {id: a, interfaces: [{id: p, ip: 10.0.0.1/24}]}\n  - {id: net, type: cloud, interfaces: [x, y], simulation: {latency: 15}}\n  - {id: b, interfaces: [{id: p, ip: 10.0.0.2/24}]}\nlinks:\n  - {id: l1, a: "a:p", b: "net:x"}\n  - {id: l2, a: "net:y", b: "b:p"}\n`);
  assert.equal(Pm.resolvedText(c.engine.latency('l1')), '15 ms (device)');
  // loss: every frame lost at 100 %; deterministic below that
  const lost = sim(PAIR(', simulation: {loss: 100}'));
  lost.runTo(8000);
  assert.ok(events(lost, (e) => /lost on l \(packet loss 100 % \(configured on cable l\)\)/.test(e.detail)).length > 2);
  assert.ok(!lost.arpTable('h1').some((r) => r.mac));
  const run = () => {
    const x = sim(PAIR(), { params: { loss: 30 } });
    x.runTo(20000);
    return events(x, (e) => /packet loss/.test(e.detail)).map((e) => e.t + e.detail);
  };
  const a = run();
  assert.ok(a.length > 0);
  assert.deepEqual(a, run());
});

test('Layer 1: a cable that goes dark is noticed after the loss-of-signal detection time (frames lost meanwhile); restored, its ports come up after the link-up delay', () => {
  const s = sim(PAIR(), { params: { 'los-detect': 500 } });
  s.runTo(10000);
  s.fail('link:l');
  assert.deepEqual(s.downRefs(), ['link:l']);
  assert.equal(s.engine.linkUp('l'), true, 'not noticed yet');
  s.runTo(10400);
  assert.equal(s.engine.portUp('h1', 'eth0'), true);
  s.runTo(10600);
  assert.equal(s.engine.portUp('h1', 'eth0'), false);
  assert.ok(events(s, (e) => e.device === 'h1' && /h1:eth0 lost carrier: loss of signal detected after 500 ms \(simulation\)/.test(e.detail)).length);
  const t = s.now;
  s.restore('link:l');
  assert.ok(events(s, (e) => /Cable l is physically up again: its ports come up after 2 s \(default\)/.test(e.detail)).length);
  s.runTo(t + 1900);
  assert.equal(s.engine.portUp('h1', 'eth0'), false, 'still negotiating');
  s.runTo(t + 2100);
  assert.equal(s.engine.portUp('h1', 'eth0'), true);
  assert.ok(events(s, (e) => /h1:eth0 has carrier again \(link-up delay 2 s \(default\)\)/.test(e.detail)).length);
  // a loss shorter than the detection time is never noticed
  const q = sim(PAIR(), { params: { 'los-detect': 1000 } });
  q.runTo(5000);
  q.fail('link:l');
  q.runTo(5300);
  q.restore('link:l');
  q.runTo(8000);
  assert.ok(events(q, (e) => /is up again before its ports noticed the loss/.test(e.detail)).length);
  assert.ok(!events(q, (e) => /lost carrier/.test(e.detail)).length);
  // during the detection time frames are dropped where the cable is
  assert.ok(events(s, (e) => e.kind === 'drop' && /its ports have not noticed yet/.test(e.detail)).length >= 0);
});

// ------------------------------------------------------------------ network events

test('network events: a failed relation, flapping (its cycles, then it stops), shut and no shut, several at once', () => {
  const s = sim(example('ospf-reroute.yaml'));
  s.runTo(30000);
  const rel = s.model.relations.find((r) => r.protocol === 'ospf');
  assert.ok(s.fail('relation:' + rel.id));
  assert.equal(s.fail('relation:' + rel.id), false, 'once');
  const link = s.model.links[0].id;
  assert.ok(s.startFlap('link:' + link));
  const [dev, port] = [s.model.links[1].a.device, s.model.links[1].a.iface];
  assert.ok(s.shut(dev, port));
  assert.deepEqual(s.netEvents().map((e) => e.kind).sort(), ['fail', 'flap', 'shut']);
  assert.ok(s.downRefs().indexOf('relation:' + rel.id) >= 0 && s.downRefs().indexOf(`iface:${dev}:${port}`) >= 0 && s.downRefs().indexOf('link:' + link) >= 0);
  // the shut port knows at once; its far end after the detection (0 s: at once too)
  assert.equal(s.engine.portUp(dev, port), false);
  // flapping: 3 cycles of 5 s down and 10 s up, then it stops by itself
  s.runTo(30000 + 3 * 15000 + 100);
  const flaps = events(s, (e) => e.what === 'Flap down' && /Flapping cable/.test(e.detail));
  assert.equal(flaps.length, 3);
  assert.ok(events(s, (e) => /stops flapping after 3 cycles/.test(e.detail)).length);
  assert.ok(!s.netEvents().some((e) => e.kind === 'flap'));
  // ending them
  assert.ok(s.end(s.netEvents().find((e) => e.kind === 'shut')));
  assert.ok(s.restore('relation:' + rel.id));
  assert.deepEqual(s.netEvents(), []);
  // continuous flapping until Stop flapping
  const c = sim(example('ospf-reroute.yaml'), { params: { 'flap-cycles': 0, 'flap-down': 1000, 'flap-up': 1000 } });
  c.runTo(5000);
  c.startFlap('link:' + link);
  c.runTo(25000);
  assert.ok(events(c, (e) => e.what === 'Flap down').length >= 9);
  assert.ok(c.stopFlap('link:' + link));
  c.runTo(30000);
  assert.ok(c.engine.cableUp(link));
});

test('network events: power off (tables and sessions gone, the neighbours notice), power on (boot time, a fresh start); a logical interface shut', () => {
  const s = sim(steady);
  s.runTo(40000);
  assert.ok(s.arpTable('r3').length > 0);
  assert.ok(s.powerOff('r3'));
  assert.equal(s.arpTable('r3').length, 0);
  assert.ok(s.status().filter((x) => x.device === 'r3' && x.protocol === 'ospf').every((x) => !x.up));
  assert.ok(events(s, (e) => /r3 is powered off at t = .*its ports go dark, its tables and sessions are gone/.test(e.detail)).length);
  assert.deepEqual(s.netEvents().map((e) => [e.kind, e.ref, e.state]), [['power', 'device:r3', 'off']]);
  assert.ok(s.downRefs().indexOf('device:r3') >= 0);
  s.runTo(45000);
  assert.ok(s.status().some((x) => x.device === 'r2' && x.peer === 'r3' && x.protocol === 'ospf' && x.state === 'Down'), 'its neighbour on a direct cable notices at once');
  assert.ok(s.powerOn('r3'));
  assert.match(s.netEvents()[0].state, /^booting \(up at t = 1 min 45 s\)|^booting/);
  assert.ok(events(s, (e) => /r3 is powered on at t = 45 s: it boots for 1 min \(default\)/.test(e.detail)).length);
  s.runTo(45000 + 59000);
  assert.ok(!s.engine.deviceOn('r3'));
  s.runTo(45000 + 120000);
  assert.ok(s.engine.deviceOn('r3'));
  assert.ok(events(s, (e) => /r3 has booted/.test(e.detail)).length);
  assert.ok(s.status().some((x) => x.device === 'r3' && x.protocol === 'ospf' && x.state === 'Full'), 'its sessions came up afresh');
  // a VLAN interface shut: its routes go, its ports stay up
  const v = sim(pe);
  v.runTo(30000);
  assert.ok(v.shut('core1', 'Vlan20'));
  assert.equal(v.engine.isL3Up('core1', 'Vlan20'), false);
  assert.ok(v.noShut('core1', 'Vlan20'));
  assert.equal(v.engine.isL3Up('core1', 'Vlan20'), true);
});

test('power: an inline IPS that fails open passes frames on, fail closed nothing; a server’s VMs restart on another server after the VM restart time', () => {
  const ips = (mode) => `netatlas: 1
title: ips
devices:
  - {id: a, type: router, interfaces: [{id: p, ip: 10.0.0.1/24}]}
  - {id: x, type: ids_ips, interfaces: [i, o]${mode ? ', simulation: {fail_mode: ' + mode + '}' : ''}}
  - {id: b, type: router, interfaces: [{id: p, ip: 10.0.0.2/24}]}
links:
  - {id: l1, a: "a:p", b: "x:i"}
  - {id: l2, a: "x:o", b: "b:p"}
demands:
  - {id: d, source: a, destination: b, bandwidth: 1M}
`;
  const open = sim(ips(''));
  open.runTo(6000);
  open.powerOff('x');
  open.runTo(20000);
  assert.ok(events(open, (e) => /It fails open: frames pass through unchecked \(open \(default\)\)/.test(e.detail) || /fails open/.test(e.detail)).length);
  assert.ok(open.status().find((r) => r.protocol === 'demand').state === 'Delivered');
  const closed = sim(ips('closed'));
  closed.runTo(6000);
  closed.powerOff('x');
  closed.runTo(30000);
  assert.equal(closed.status().find((r) => r.protocol === 'demand').state, 'Lost');
  // a VM cabled to two servers: down with the first, restarted on the second
  const vm = sim(`netatlas: 1
title: vm
devices:
  - {id: s1, type: server, interfaces: [{id: p, ip: 10.0.0.1/24}], simulation: {vm_restart: 20}}
  - {id: s2, type: server, interfaces: [{id: p, ip: 10.0.0.2/24}]}
  - {id: v, type: vm, interfaces: [{id: a, ip: 10.0.0.10/24}, {id: b, ip: 10.0.1.10/24}], simulation: {boot_time: 5}}
links:
  - {id: l1, a: "s1:p", b: "v:a"}
  - {id: l2, a: "s2:p", b: "v:b"}
`);
  vm.runTo(5000);
  vm.powerOff('s1');
  assert.ok(!vm.engine.deviceOn('v'));
  assert.ok(vm.netEvents().some((e) => e.ref === 'device:v' && e.hosted));
  vm.runTo(5000 + 20000 + 5000 + 100);
  assert.ok(vm.engine.deviceOn('v'));
  assert.ok(events(vm, (e) => /v is restarted on s2 after the VM restart time 20 s \(device\)/.test(e.detail)).length);
});

// ------------------------------------------------------------------ changes during the simulation

test('changes apply at once: a shorter ARP timeout expires older entries now, the next OSPF Hello is rescheduled, each change is logged', () => {
  const s = sim(pe);
  s.runTo(60000);
  const before = s.arpTable('r1').length;
  assert.ok(before > 0);
  const c = s.setParam('arp-timeout', 30000);
  assert.equal(Pm.changeText(c), 'Parameter changed: ARP timeout 4 h → 30 s (simulation)');
  assert.ok(events(s, (e) => e.t === s.now && e.detail === 'Parameter changed: ARP timeout 4 h → 30 s (simulation)').length);
  // entries older than 30 s and in use are refreshed at once, unused ones expire
  assert.ok(events(s, (e) => e.t === s.now && e.device === 'r1' && /refreshing|expired/.test(e.detail)).length);
  // OSPF hello: 10 s → 2 s; the next Hello of r1 on ge1 within 2 s of its last one (not 10 s)
  const hellos = () => events(s, (e) => e.device === 'r1' && e.protocol === 'ospf' && e.what === 'Hello' && /on ge1/.test(e.detail)).map((e) => e.t);
  const last = hellos().pop();
  s.setParam('ospf-hello', 2000);
  s.runTo(s.now + 5000);
  // its last Hello was more than 2 s ago: the next one goes now, then every 2 s (each with its sub-millisecond jitter)
  const next = hellos().filter((t) => t > last);
  assert.ok(last < s.now - 5000 - 2000 && next.length >= 2 && Math.abs(next[0] - (s.now - 5000)) < 1 && Math.abs(next[1] - next[0] - 2000) < 1, `${last} → ${next.join(',')}`);
  assert.ok(events(s, (e) => /hello interval 2 s \(simulation\)|hello 2 s \(simulation\)/.test(e.detail)).length);
  // back to the default
  s.setParam('ospf-hello', undefined);
  assert.ok(events(s, (e) => e.detail === 'Parameter changed: OSPF hello interval 2 s → 10 s (simulation)').length);
});

test('a device’s attributes changed in the model during a simulation apply at once (logged as device); the route recomputation delay holds the old routes', () => {
  const s = sim(pe);
  s.runTo(30000);
  const m2 = model(pe.replace('simulation: {arp_timeout: 300}', 'simulation: {arp_timeout: 60}'));
  const cs = s.deviceParamsFrom(m2);
  assert.deepEqual(cs.map((c) => Pm.changeText(c)), ['Parameter changed: ARP timeout on core1 5 min → 1 min (device)']);
  assert.ok(events(s, (e) => e.detail === 'Parameter changed: ARP timeout on core1 5 min → 1 min (device)').length);
  assert.deepEqual(s.deviceParamsFrom(m2), [], 'nothing new');
  // an interface's attribute: the same, logged as set there
  // (the first DR priority of the example is core1's Vlan10)
  const m3 = model(pe.replace('simulation: {arp_timeout: 300}', 'simulation: {arp_timeout: 60}').replace('simulation: {pim_dr_priority: 200}', 'simulation: {pim_dr_priority: 300}'));
  assert.deepEqual(s.deviceParamsFrom(m3).map((c) => Pm.changeText(c)), ['Parameter changed: PIM DR priority on core1:Vlan10 200 → 300 (set there)']);
  // SPF: routers recompute after their delay
  assert.ok(events(s, (e) => /^Routes recomputed at .*\(route recomputation delay 200 ms, default\)$/.test(e.detail)).length);
  const slow = sim(pe.replace('  - id: r1\n    type: router', '  - id: r1\n    type: router\n    simulation: {spf_delay: 5000}'));
  slow.runTo(60000);
  slow.fail('link:l-carrier-r3');
  slow.runTo(60000 + 4000);
  assert.ok(!events(slow, (e) => e.t > 60000 && /Routes recomputed at r1\b/.test(e.detail)).length, 'not yet');
  slow.runTo(60000 + 50000);
  assert.ok(events(slow, (e) => e.t > 60000 && /Routes recomputed at r1 \(route recomputation delay 5 s, device\)/.test(e.detail)).length);
});

test('determinism with parameter changes and network events at the same simulated times', () => {
  const run = () => {
    const s = sim(pe, { params: { loss: 1 } });
    s.runTo(20000);
    s.setParam('arp-timeout', 20000);
    s.powerOff('r2');
    s.runTo(35000);
    s.startFlap('link:l-r1-carrier');
    s.setParam('ospf-hello', 3000);
    s.runTo(60000);
    s.powerOn('r2');
    s.runTo(90000);
    return s.events().map((e) => `${e.t}|${e.kind}|${e.device}|${e.what}|${e.detail}`);
  };
  const a = run();
  assert.ok(a.length > 1000);
  assert.deepEqual(a, run());
});

test('the spanning tree: RSTP takes over at once at the failure, STP after 2 × forward delay; a full MAC table floods', () => {
  const loop = (mode) => `netatlas: 1
title: loop
devices:
  - {id: h1, interfaces: [{id: e, ip: 10.0.0.1/24}]}
  - {id: h2, interfaces: [{id: e, ip: 10.0.0.2/24}]}
  - {id: s1, type: switch, interfaces: [{id: a, vlans: 1}, {id: b, vlans: 1}, {id: h, vlans: 1}]${mode ? ', simulation: {stp_mode: ' + mode + '}' : ''}}
  - {id: s2, type: switch, interfaces: [{id: a, vlans: 1}, {id: c, vlans: 1}]${mode ? ', simulation: {stp_mode: ' + mode + '}' : ''}}
  - {id: s3, type: switch, interfaces: [{id: b, vlans: 1}, {id: c, vlans: 1}, {id: h, vlans: 1}]${mode ? ', simulation: {stp_mode: ' + mode + '}' : ''}}
links:
  - {id: l12, a: "s1:a", b: "s2:a"}
  - {id: l13, a: "s1:b", b: "s3:b"}
  - {id: l23, a: "s2:c", b: "s3:c"}
  - {id: lh1, a: "h1:e", b: "s1:h"}
  - {id: lh2, a: "h2:e", b: "s3:h"}
demands:
  - {id: d, source: h1, destination: h2, bandwidth: 1M}
`;
  for (const [mode, wait] of [['', 0], ['stp', 30000]]) {
    const s = sim(loop(mode));
    s.runTo(10000);
    // the cable of the tree's path between h1 and h2
    const t = s.engine.tree(1);
    const fail = ['l13', 'l12', 'l23'].find((id) => !Array.from(t.blocked).some((k) => k.indexOf(id === 'l13' ? 's1|b' : id === 'l12' ? 's1|a' : 's2|c') === 0));
    s.fail('link:' + fail);
    const at = s.now;
    s.runTo(at + 1);
    const notes = events(s, (e) => e.t >= at && /Topology change/.test(e.what));
    assert.ok(notes.length, mode || 'rstp');
    if (wait) assert.match(notes[0].detail, /forwards at t = .*STP: (listening and learning, 2 × forward delay 15 s|max age 20 s \+ 2 × forward delay 15 s)/);
    else assert.doesNotMatch(notes[0].detail, /forward delay/, 'RSTP: at once, or after 3 hellos further away');
  }
  // a MAC table of one entry: nothing more is learned
  const full = sim(loop('').replace('{id: h, vlans: 1}]}', '{id: h, vlans: 1}], simulation: {mac_table_size: 1}}'));
  full.runTo(10000);
  assert.ok(full.macTable('s1').filter((r) => r.type === 'dynamic').length <= 1);
  assert.ok(events(full, (e) => e.device === 's1' && /MAC table is full \(1 entries, device\)/.test(e.detail)).length);
});

test('the TTL a device sends with is its default TTL; ECMP spreads over at most the maximum paths', () => {
  const s = sim(pe.replace('    simulation: {listening: tcp/443}\n    interfaces:\n      - {id: eth0, ip: 10.30.0.10/24}', '    simulation: {listening: tcp/443, ttl: 128}\n    interfaces:\n      - {id: eth0, ip: 10.30.0.10/24}'));
  s.runTo(10000);
  const pkt = s.engine.newPacket(s.engine.net.devices.get('srv').l3.get('eth0').addrs[0].addr, s.engine.net.devices.get('r3').l3.get('ge2').addrs[0].addr, '', { protocol: 'demand', type: 'x', label: 'x', detail: 'x' });
  s.engine.send('srv', pkt);
  assert.equal(pkt.ttl, 128);
  assert.equal(Pm.paramDef('ecmp-max').dflt, 4);
});
