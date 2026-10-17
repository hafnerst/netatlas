// Multicast forwarding by explicit port roles, the per-VLAN snooping roles,
// and the background's short labels (the model; a fake clock for the
// real-time streams). The private house: the thermostat's VLAN 20 stream
// and the laptop's VLAN 10 stream go to the router port up to the core (the
// snooping querier of VLANs 10, 20, 30) and stop there without a member; the
// NAS joining the laptop's group gets the running stream at its next
// datagram, learned from its own report only. Without a querier in VLAN 10
// (the example before this change) the stream stays at dist and the NAS's
// report never leaves the core: the cause, kept as a test. The internal
// example snooping-roles.yaml: one switch, four VLANs, four roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { example, load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const A = load('ui/sim-anim.js');

const sim = (text) => withClock(new S.Simulation(model(text)));
const HOUSE = example('private-house.yaml');
/** the house as it was: the core the snooping querier of the IoT VLAN only */
const HOUSE_OLD = HOUSE.replace('vlan: 10, simulation: {snooping_querier: "on"}}', 'vlan: 10}').replace('vlan: 30, simulation: {snooping_querier: "on"}}', 'vlan: 30}');
const ROLES = example('snooping-roles.yaml');

/** The cables a traffic's datagrams used after a time (physical view). */
const links = (s, traffic, after = -1) => new Set(s.engine.flights.filter((f) => f.test === traffic && f.t0 > after && f.view === 'physical' && f.protocol === 'mcast').map((f) => f.track.ref));
/** The forwarding decisions of a device for a traffic's packets. */
const decisions = (s, traffic, dev) => s.engine.flights.filter((f) => f.test === traffic && f.view === 'physical').flatMap((f) => s.engine.mcDecisions.get(f.id) || []).filter((d) => d.dev === dev);
const port = (d, p) => d.ports.find((x) => x.port === p);
const roles = (s, dev) => s.multicast.snoopRoles(dev).map((r) => r.text);

// ------------------------------------------------------------------ the private house

test('thermostat (VLAN 20, no receiver): dist switches it to its multicast router port up only — learned from the core’s queries, not from the core being Layer 3; the core is the VLAN’s querier and sends it nowhere; it routes no multicast', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  s.play(3000);
  assert.deepEqual(Array.from(links(s, st.traffic)).sort(), ['link:l-core-dist', 'link:l-dist-ap2', 'link:w-thermostat']);
  const d = decisions(s, st.traffic, 'dist')[0];
  assert.equal(d.layer, 'l2');
  assert.equal(d.vlan, 20);
  assert.equal(d.group, '239.20.0.1');
  assert.equal(d.ingress, 'ap2');
  assert.match(d.mode, /^IGMP snooping enabled in VLAN 20; unregistered multicast to the router ports only$/);
  assert.deepEqual(port(d, 'ap2'), { port: 'ap2', sent: false, why: 'ingress port (never sent back)' });
  assert.equal(port(d, 'up').sent, true);
  assert.match(port(d, 'up').why, /^multicast router port \(\d+ min( \d+ s)? left\)$/);
  assert.deepEqual(port(d, 'ap1'), { port: 'ap1', sent: false, why: 'no member and no multicast router port' });
  // the core: Layer 2 (no port) and Layer 3 (no multicast routing), each said
  const c = decisions(s, st.traffic, 'core');
  const l2 = c.find((x) => x.layer === 'l2');
  assert.ok(l2.ports.filter((p) => p.port !== 'up2').every((p) => !p.sent), JSON.stringify(l2.ports));
  assert.match(l2.text, /^core sends 239\.20\.0\.1 to no port in VLAN 20$/);
  const l3 = c.find((x) => x.layer === 'l3');
  assert.match(l3.text, /^core routes no multicast \(it runs no PIM\)/);
  // the roles: dist snoops only (it hears the core), the core is the querier of every snooping VLAN
  assert.deepEqual(roles(s, 'dist'), ['VLAN 10 · Snooping · querier heard', 'VLAN 20 · Snooping · querier heard', 'VLAN 30 · Snooping · querier heard']);
  assert.deepEqual(roles(s, 'core'), ['VLAN 10 · Querier', 'VLAN 20 · Querier', 'VLAN 30 · Querier']);
});

test('laptop (VLAN 10) as the house was: no querier in VLAN 10, so dist learned no router port there — the core being a Layer 3 switch makes none — and the stream stays at dist; the NAS’s report reaches the core only (reports go to router ports, it has none): the core shows a member, the stream never comes', () => {
  const s = sim(HOUSE_OLD);
  s.runTo(40000);
  assert.deepEqual(roles(s, 'dist'), ['VLAN 10 · Snooping · no querier', 'VLAN 20 · Snooping · querier heard', 'VLAN 30 · Snooping · no querier']);
  assert.deepEqual(s.snoopTable('dist').rows.map((r) => r.slice(0, 3)), [['20', '—', 'up']], 'a router port in VLAN 20 only');
  const st = s.actStream('laptop', 'wlan0', '239.10.0.1', 5004, 1000, 500);
  s.play(2000);
  assert.deepEqual(Array.from(links(s, st.traffic)).sort(), ['link:l-dist-ap2', 'link:w-laptop']);
  const d = decisions(s, st.traffic, 'dist')[0];
  assert.deepEqual(port(d, 'up'), { port: 'up', sent: false, why: 'no member and no multicast router port' });
  assert.match(d.text, /^dist sends 239\.10\.0\.1 to no port in VLAN 10$/);
  const j = s.actJoin('nas', 'eth0', '239.10.0.1', []);
  assert.equal(j.error, undefined);
  s.play(4000);
  assert.deepEqual(s.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['10', '239.10.0.1 (IGMP)', 'nas']]);
  // the report: from the NAS to the core and no further (no router port at the core in VLAN 10)
  const rep = s.engine.flights.filter((f) => f.test === j.traffic && f.protocol === 'igmp' && f.view === 'physical');
  assert.ok(rep.length && rep.every((f) => f.track.ref === 'link:l-core-nas'), rep.map((f) => f.track.ref).join());
  const rd = s.engine.mcDecisions.get(rep[0].id)[0];
  assert.equal(rd.dev, 'core');
  assert.ok(rd.ports.filter((p) => p.port !== 'nas').every((p) => !p.sent && /no multicast router port \(reports go to router ports only\)/.test(p.why)), JSON.stringify(rd.ports));
  assert.equal(st.stream.rx.size, 0, 'the NAS gets nothing: the stream ends at dist');
});

test('laptop (VLAN 10) now: the core queries VLAN 10 too; the stream goes to the core and stops there; the NAS joins while it runs: its report is learned at the core’s port nas (and nowhere else), and the next datagram reaches it — no restart, no extra query; it leaves: cleaned up, the stream stops reaching it', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('laptop', 'wlan0', '239.10.0.1', 5004, 1000, 500);
  s.play(3000);
  assert.deepEqual(Array.from(links(s, st.traffic)).sort(), ['link:l-core-dist', 'link:l-dist-ap2', 'link:w-laptop']);
  assert.equal(st.stream.rx.size, 0);
  const queries = () => s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query').length;
  const q0 = queries();
  const j0 = s.now;
  const j = s.actJoin('nas', 'eth0', '239.10.0.1', []);
  assert.equal(j.error, undefined);
  s.play(1100);
  // learned from the report that reached the core: the core's port nas; dist learned nothing (the report never reached it)
  assert.deepEqual(s.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['10', '239.10.0.1 (IGMP)', 'nas']]);
  assert.ok(!s.snoopTable('dist').rows.some((r) => r[1] !== '—'), 'no membership at dist');
  // the next datagram after the join, within one interval: delivered
  assert.ok(st.stream.rx.get('nas') >= 1, 'received at the next datagram');
  assert.ok(links(s, st.traffic, j0).has('link:l-core-nas'));
  assert.equal(queries(), q0, 'no query was needed');
  const atCore = decisions(s, st.traffic, 'core').filter((d) => d.t > j0 && d.layer === 'l2').pop();
  assert.equal(port(atCore, 'nas').sent, true);
  assert.match(port(atCore, 'nas').why, /^member port \(\d+ min( \d+ s)? left\)$/);
  // nothing leaks: not to the other VLANs' clients, not to the TV, not past the core; another group does not reach the NAS
  for (const no of ['link:w-thermostat', 'link:w-tv', 'link:w-guest-phone', 'link:l-router-core', 'link:l-dist-ap1']) assert.ok(!links(s, st.traffic, j0).has(no), no);
  const other = s.actStream('laptop', 'wlan0', '239.10.0.2', 5004, 1000, 500);
  s.play(2500);
  assert.ok(!links(s, other.traffic).has('link:l-core-nas'), 'not another group');
  // the NAS leaves: after the last member queries its port goes, and the stream with it
  assert.ok(s.leaveGroup('nas', 'eth0', '239.10.0.1'));
  s.play(5000);
  const t = s.now;
  s.play(3000);
  assert.ok(!links(s, st.traffic, t).has('link:l-core-nas'));
  assert.deepEqual(s.snoopTable('core').rows, []);
});

test('the NAS’s cable fails while it is a member: the member port goes at once, the stream with it; back up, it is learned again from its answer to the next query; a new simulation starts without any of it', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('laptop', 'wlan0', '239.10.0.1', 5004, 1000, 500);
  assert.equal(s.joinGroup('nas', 'eth0', '239.10.0.1', []), null);
  s.play(2000);
  assert.ok(st.stream.rx.get('nas') >= 1);
  s.fail('link:l-core-nas');
  s.play(100);
  assert.deepEqual(s.snoopTable('core').rows, []);
  let t = s.now;
  s.play(2000);
  assert.ok(!links(s, st.traffic, t).has('link:l-core-nas'));
  s.restore('link:l-core-nas');
  // the next general query (every 125 s): the NAS answers, the core learns its port again
  s.play(130000);
  assert.deepEqual(s.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['10', '239.10.0.1 (IGMP)', 'nas']]);
  t = s.now;
  s.play(2000);
  assert.ok(links(s, st.traffic, t).has('link:l-core-nas'));
  const fresh = sim(HOUSE);
  fresh.runTo(40000);
  assert.deepEqual(fresh.snoopTable('core').rows, []);
  assert.equal(fresh.engine.mcDecisions.size, 0);
});

test('the TV (VLAN 20) joins the laptop’s VLAN 10 group: its membership is learned in VLAN 20, but the core routes no multicast between VLANs (no PIM): nothing reaches it, and the core’s Layer 3 decision says why', () => {
  const s = sim(HOUSE);
  s.runTo(40000);
  const st = s.actStream('laptop', 'wlan0', '239.10.0.1', 5004, 1000, 500);
  assert.equal(s.joinGroup('tv', 'wlan0', '239.10.0.1', []), null);
  s.play(4000);
  assert.deepEqual(s.snoopTable('core').rows.map((r) => r.slice(0, 3)), [['20', '239.10.0.1 (IGMP)', 'ap']]);
  assert.equal(st.stream.rx.size, 0);
  assert.ok(!links(s, st.traffic).has('link:w-tv'));
  const l3 = decisions(s, st.traffic, 'core').find((d) => d.layer === 'l3');
  assert.match(l3.text, /^core routes no multicast \(it runs no PIM\): .* stays on Vlan10$/);
  assert.equal(l3.mode, 'Layer 3: it routes no multicast');
});

test('unregistered multicast as an explicit policy per VLAN: flood (allowed by RFC 4541) sends a group without members to every port of the VLAN at every snooping switch alike, not to other VLANs; members still count; the default sends it to the router ports only', () => {
  const s = sim(HOUSE_OLD.replace('vlan: 10}', 'vlan: 10, simulation: {unregistered_multicast: flood}}'));
  s.runTo(40000);
  assert.equal(s.multicast.unregisteredPolicy('dist', 10), 'flood');
  assert.equal(s.multicast.unregisteredPolicy('dist', 20), 'router-ports');
  const st = s.actStream('laptop', 'wlan0', '239.10.0.1', 5004, 1000, 500);
  s.play(2000);
  const l = links(s, st.traffic);
  for (const yes of ['link:l-core-dist', 'link:l-dist-ap1', 'link:l-core-nas', 'link:l-core-apb']) assert.ok(l.has(yes), yes);
  assert.ok(!l.has('link:l-router-core'), 'not into the transit VLANs');
  const d = decisions(s, st.traffic, 'dist')[0];
  assert.match(d.mode, /unregistered multicast flooded$/);
  assert.equal(port(d, 'ap1').why, 'flooded (unregistered multicast flooded)');
  assert.ok(s.snoopTable('dist').notes.some((n) => /^Snooping enabled in VLAN 10: .*flooded to every port \(unregistered_multicast: flood\)\.$/.test(n)), s.snoopTable('dist').notes.join(' | '));
  // the thermostat's VLAN 20 keeps the default: the router port only
  const th = s.actStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500);
  s.play(2000);
  assert.ok(!links(s, th.traffic).has('link:l-dist-ap1'));
});

// ------------------------------------------------------------------ per-VLAN roles

test('one switch, four snooping VLANs, four roles — querier, standby, snooping with a querier heard, snooping without one; a separate LAN with the same VLAN ID has its own querier and never lends it', () => {
  const s = sim(ROLES);
  s.runTo(1000);
  assert.deepEqual(roles(s, 'sw-a'), ['VLAN 10 · Candidate down · no querier', 'VLAN 20 · Candidate down · no querier', 'VLAN 30 · Snooping · no querier', 'VLAN 40 · Snooping · no querier']);
  s.runTo(3000);
  assert.deepEqual(roles(s, 'sw-a'), ['VLAN 10 · Querier (startup)', 'VLAN 20 · Standby', 'VLAN 30 · Snooping · querier heard', 'VLAN 40 · Snooping · no querier']);
  s.runTo(60000);
  const r = s.multicast.snoopRoles('sw-a');
  assert.deepEqual(r.map((x) => x.text), ['VLAN 10 · Querier', 'VLAN 20 · Standby', 'VLAN 30 · Snooping · querier heard', 'VLAN 40 · Snooping · no querier']);
  assert.deepEqual(r.map((x) => x.role), ['querier', 'standby', 'snooping', 'snooping']);
  // the device's own part and the querier's presence are separate facts
  assert.deepEqual(r.map((x) => (x.querier ? (x.querier.self ? 'self' : x.querier.dev) : null)), ['self', 'sw-b', 'r30', null]);
  assert.deepEqual(r.map((x) => x.routerPorts.map((p) => p.port)), [[], ['tr'], ['p30'], []], 'a router port is where a querier or router is, not the device being one');
  assert.deepEqual(roles(s, 'sw-b'), ['VLAN 10 · Snooping · querier heard', 'VLAN 20 · Querier']);
  assert.deepEqual(roles(s, 'swb2'), ['VLAN 40 · Snooping · querier heard']);
  // the details name the querier; the snooping table says the same, line by line
  assert.match(r[1].detail, /^sw-a: a standby querier candidate in VLAN 20: sw-b \(10\.20\.0\.2, behind port tr\) queries/);
  assert.match(r[2].detail, /the querier there is r30 \(10\.30\.0\.1, behind port p30\)/);
  const notes = s.snoopTable('sw-a').notes;
  for (const x of r) assert.ok(notes.some((n) => n.indexOf(x.text + ': ') === 0), x.text);
  // the roles agree with who queries: sw-a in VLAN 10, sw-b in VLAN 20, r30 in VLAN 30, nobody in VLAN 40 (LAN A)
  // (after the startup's first queries, where every candidate queries)
  const q = (dev) => s.events().filter((e) => e.protocol === 'igmp' && e.what === 'Query' && e.device === dev && e.t > 2500).map((e) => /in VLAN (\d+)/.exec(e.detail) || /from \S+ \(([\d.]+)\)/.exec(e.detail));
  assert.ok(q('sw-a').length && q('sw-a').every((m) => m && m[1] === '10'), 'sw-a queries VLAN 10 only');
  assert.ok(q('sw-b').length && q('sw-b').every((m) => m && m[1] === '20'), 'sw-b queries VLAN 20 only');
});

test('roles follow the protocol: the querier of VLAN 20 off — sw-a takes over after the other querier present interval; r30 off — VLAN 30 hears no querier once that interval is over; sw-a off — Off in every VLAN, back on — Booting, then its startup again; reset: as at the start', () => {
  const s = sim(ROLES);
  s.runTo(60000);
  s.powerOff('sw-b');
  s.runTo(s.now + 2000);
  assert.equal(roles(s, 'sw-a')[1], 'VLAN 20 · Standby', 'not before the interval is over');
  s.runTo(s.now + 260000);
  assert.equal(roles(s, 'sw-a')[1], 'VLAN 20 · Querier');
  s.powerOff('r30');
  s.runTo(s.now + 2000);
  assert.equal(roles(s, 'sw-a')[2], 'VLAN 30 · Snooping · querier heard');
  s.runTo(s.now + 260000);
  assert.equal(roles(s, 'sw-a')[2], 'VLAN 30 · Snooping · no querier');
  // sw-a powered off: it snoops nothing, every VLAN says so; back on: its startup again (VLAN 20 back to standby: sw-b is back too)
  s.powerOff('sw-a');
  s.runTo(s.now + 1000);
  assert.deepEqual(roles(s, 'sw-a'), ['VLAN 10 · Off', 'VLAN 20 · Off', 'VLAN 30 · Off', 'VLAN 40 · Off']);
  assert.ok(s.multicast.snoopRoles('sw-a').every((r) => r.querier === null && !r.routerPorts.length));
  s.powerOn('sw-a');
  s.powerOn('sw-b');
  s.runTo(s.now + 1);
  assert.deepEqual(roles(s, 'sw-a'), ['VLAN 10 · Booting', 'VLAN 20 · Booting', 'VLAN 30 · Booting', 'VLAN 40 · Booting'], 'booting is not off');
  s.runTo(s.now + 120000);
  assert.deepEqual(roles(s, 'sw-a').slice(0, 2), ['VLAN 10 · Querier', 'VLAN 20 · Standby']);
  const fresh = sim(ROLES);
  fresh.runTo(1000);
  assert.deepEqual(roles(fresh, 'sw-a'), ['VLAN 10 · Candidate down · no querier', 'VLAN 20 · Candidate down · no querier', 'VLAN 30 · Snooping · no querier', 'VLAN 40 · Snooping · no querier']);
});

test('a switch with snooping enabled nowhere has no roles; a router has none either (its querier mark is its own)', () => {
  const s = sim(HOUSE);
  s.runTo(5000);
  for (const d of ['dsl-router', 'ap-b', 'nas', 'tv']) assert.deepEqual(s.multicast.snoopRoles(d), [], d);
  const r = sim(ROLES);
  r.runTo(5000);
  assert.deepEqual(r.multicast.snoopRoles('r30'), []);
});

// ------------------------------------------------------------------ the background's labels

test('background labels: the kind in a word or two, never addresses', () => {
  assert.equal(A.bgKind('igmp', 'IGMP Query (general)'), 'IGMP Query');
  assert.equal(A.bgKind('igmp', 'IGMPv3 Report to 224.0.0.22'), 'IGMP Report');
  assert.equal(A.bgKind('igmp', 'IGMP Leave 239.1.1.1'), 'IGMP Leave');
  assert.equal(A.bgKind('arp', 'ARP Request (broadcast) who has 10.0.0.1'), 'ARP');
  assert.equal(A.bgKind('dhcp', 'DHCP Discover'), 'DHCP');
  assert.equal(A.bgKind('dns', 'DNS query nas.home.arpa A'), 'DNS');
  assert.equal(A.bgKind('mcast', 'UDP → 239.20.0.1:5004'), 'UDP');
  assert.equal(A.bgKind('ospf', 'OSPF Hello'), 'OSPF Hello');
  assert.equal(A.bgKind('vrrp', 'VRRP Advertisement'), 'VRRP');
  for (const k of ['IGMP Query', 'ARP', 'UDP']) assert.doesNotMatch(k, /\d+\.\d+/);
});
