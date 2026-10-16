// The private-house example (examples/private-house.yaml): three floors, a
// DSL modem/router with NAT and a firewall policy, a Layer 3 switch core with
// VRFs, a Layer 2 distributor on the second floor and an access point on every
// floor with Internal, IoT and Guest on VLANs 10, 20 and 30 over one uplink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, validate, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const T = load('analysis/trace.js');
const F = load('analysis/failure.js');
const C = load('analysis/checks.js');
const Dv = load('model/derive.js');
const Cap = load('model/capabilities.js');

const TEXT = example('private-house.yaml');
const m = model(TEXT);
const dev = (id) => m.index.devices.get(id);
const link = (id) => m.links.find((l) => l.id === id);
const ev = (s, f) => s.events().filter(f);
const NETS = [
  ['internal', 'Home', 10],
  ['iot', 'Home-IoT', 20],
  ['guest', 'Home-Guest', 30],
];
const APS = ['ap-b', 'ap-1', 'ap-2'];

test('valid, without warnings or consistency findings', () => {
  const r = validate.loadModel(TEXT);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  assert.deepEqual(r.warnings.map((e) => e.message), []);
  assert.deepEqual(C.runChecks(m).map((f) => `${f.check}: ${f.message}`), []);
});

test('the floors: Basement, First and Second floor in the house; every device on the floor where it stands', () => {
  const g = (id) => m.groups.find((x) => x.id === id);
  assert.deepEqual(['basement', 'floor1', 'floor2'].map((id) => [g(id).label, g(id).kind, g(id).parent]), [
    ['Basement', 'floor', 'house'],
    ['First floor (above the basement)', 'floor', 'house'],
    ['Second floor (top)', 'floor', 'house'],
  ]);
  const on = (floor) => m.devices.filter((d) => d.group === floor).map((d) => d.id).sort();
  assert.deepEqual(on('basement'), ['ap-b', 'core', 'dsl-router', 'nas', 'tv']);
  assert.deepEqual(on('floor1'), ['ap-1', 'guest-phone', 'phone']);
  assert.deepEqual(on('floor2'), ['ap-2', 'dist', 'laptop', 'thermostat']);
});

test('the WAN edge is an explicit DSL modem/router (PAT, firewall policy, DNS); the Layer 3 switch only routes', () => {
  const r = dev('dsl-router');
  assert.equal(r.type, 'firewall');
  assert.equal(r.kindLabel, 'DSL modem/router');
  assert.ok(Cap.capabilities(r).firewallPolicy);
  assert.ok(r.appServices.get('nat') && r.netServices && r.netServices.dns);
  assert.deepEqual([link('l-dsl').a.device, link('l-dsl').b.device, link('l-dsl').medium], ['dsl-router', 'isp', 'dsl']);
  const core = dev('core');
  assert.equal(core.type, 'switch');
  assert.equal(core.layer3, true);
  assert.ok(!Cap.capabilities(core).firewallPolicy);
  assert.ok(!core.appServices || !core.appServices.get('nat'), 'no NAT on the switch');
  // its gateways: one per VLAN, each Wi-Fi network in its own VRF
  const svi = (id) => core.logical.find((i) => i.id === id);
  assert.deepEqual(['Vlan10', 'Vlan20', 'Vlan30', 'Vlan99'].map((id) => [svi(id).vlan, svi(id).addresses[0], svi(id).vrf || '']), [
    [10, '192.168.10.1/24', ''],
    [20, '192.168.20.1/24', 'iot'],
    [30, '192.168.30.1/24', 'guest'],
    [99, '192.168.99.1/24', ''],
  ]);
  // the default route of each VRF points at the DSL router's transit address in it
  assert.deepEqual(core.routes.map((x) => `${x.vrf || ''}>${x.via}`).sort(), ['>10.0.10.1', 'guest>10.0.30.1', 'iot>10.0.20.1']);
  const l2 = dev('dist');
  assert.equal(l2.type, 'switch');
  assert.ok(!l2.layer3);
});

test('the wiring: the Basement AP and the distributor on the core, the upper-floor APs on the distributor; one uplink per AP, the VLANs carried and tagged alike at both ends', () => {
  const pairs = m.links.filter((l) => l.medium !== 'wireless').map((l) => `${l.a.device}:${l.a.iface}-${l.b.device}:${l.b.iface}`);
  for (const want of ['core:ap-ap-b:eth0', 'core:up2-dist:up', 'dist:ap1-ap-1:eth0', 'dist:ap2-ap-2:eth0']) assert.ok(pairs.indexOf(want) >= 0, want);
  for (const ap of APS) {
    const wired = m.links.filter((l) => l.medium !== 'wireless' && (l.a.device === ap || l.b.device === ap));
    assert.equal(wired.length, 1, `${ap} has one wired uplink`);
    const l = wired[0];
    const [mine, far] = l.a.device === ap ? [l.a, l.b] : [l.b, l.a];
    const a = Dv.endL2(m, mine);
    const b = Dv.endL2(m, far);
    assert.deepEqual([a.tagged, a.untagged], [[10, 20, 30, 99], undefined], `${ap}'s port`);
    assert.deepEqual([b.tagged, b.untagged], [[10, 20, 30, 99], undefined], `the switch port of ${ap}`);
  }
  const riser = link('l-core-dist');
  assert.deepEqual([Dv.endL2(m, riser.a).tagged, Dv.endL2(m, riser.b).tagged], [[10, 20, 30, 99], [10, 20, 30, 99]]);
  const wan = link('l-router-core');
  assert.deepEqual(Dv.endL2(m, wan.b).tagged, [110, 120, 130], "the core's trunk to the DSL router carries the transit VLANs");
});

test('every access point: Internal, IoT and Guest on VLANs 10, 20, 30 of its radio, the same SSIDs everywhere; each client names a network of its access point', () => {
  for (const ap of APS) {
    const w = dev(ap).wireless;
    assert.deepEqual(w.networks.map((n) => [n.id, n.ssid, n.vlan, n.radio]), NETS.map(([id, ssid, vlan]) => [id, ssid, vlan, 'radio0']), ap);
    assert.ok(w.networks.every((n) => /^<[a-z-]+>$/.test(n.passphrase)), 'placeholders');
  }
  // the clients: on a network of the access point their connection ends at, in its VLAN
  const want = { tv: ['ap-b', 'iot', 20], phone: ['ap-1', 'internal', 10], 'guest-phone': ['ap-1', 'guest', 30], laptop: ['ap-2', 'internal', 10], thermostat: ['ap-2', 'iot', 20] };
  for (const [client, [ap, net, vlan]] of Object.entries(want)) {
    const l = m.links.find((x) => x.b.device === client);
    assert.deepEqual([l.a.device, l.a.iface, l.wirelessNetwork], [ap, 'radio0', net], client);
    assert.equal(Dv.endL2(m, l.a).untagged, vlan, client);
  }
});

test('the simulation: each client leased in its VLAN; HTTPS from every zone through PAT; the NAS by name from Internal; IoT and Guest denied at the DSL router', () => {
  const s = new S.Simulation(m);
  s.runTo(11000);
  const bound = (d) => (ev(s, (e) => e.device === d && e.what === 'Bound').map((e) => /bound to ([0-9.]+)\//.exec(e.detail)[1])[0] || '').replace(/\.\d+$/, '');
  assert.deepEqual(['laptop', 'phone', 'tv', 'thermostat', 'guest-phone'].map(bound), ['192.168.10', '192.168.10', '192.168.20', '192.168.20', '192.168.30']);
  const answered = (d, re) => ev(s, (e) => e.device === d && e.what === 'Test answered' && re.test(e.detail)).length > 0;
  const failed = (d, re) => ev(s, (e) => e.device === d && e.what === 'Test failed' && re.test(e.detail)).length > 0;
  for (const d of ['laptop', 'tv', 'guest-phone']) assert.ok(answered(d, /203\.0\.113\.80 tcp\/443/), `${d} reaches the web server`);
  assert.ok(answered('laptop', /nas\.home\.arpa tcp\/445/), 'Internal reaches the NAS by name (DNS on the DSL router)');
  for (const d of ['tv', 'guest-phone']) assert.ok(failed(d, /192\.168\.10\.20 tcp\/445/), `${d} does not reach the NAS`);
  const drops = ev(s, (e) => e.device === 'dsl-router' && e.what === 'dropped' && /→ 192\.168\.10\.20:445/.test(e.detail));
  assert.ok(drops.some((e) => /192\.168\.20\./.test(e.detail)) && drops.some((e) => /192\.168\.30\./.test(e.detail)), 'IoT and Guest dropped by its policy');
  assert.ok(drops.every((e) => /no relation of the model and no allow entry permits it/.test(e.detail)));
  // the way: IoT's SYN leaves the core by IoT's transit VLAN (its VRF), not Internal's
  assert.ok(ev(s, (e) => e.device === 'core' && e.what === 'routed' && /192\.168\.20\.\d+ → 192\.168\.10\.20: in Vlan20 .* out Vlan120/.test(e.detail)).length > 0);
  assert.ok(ev(s, (e) => e.device === 'dsl-router' && e.what === 'PAT' && /lan\.130 → wan\): 192\.168\.30\.\d+ → 203\.0\.113\.10/.test(e.detail)).length > 0);
  // the relations' HTTPS sessions through the NAT: answered (the server answers the translated address)
  assert.ok(ev(s, (e) => e.device === 'guest-phone' && e.protocol === 'https' && e.what === 'Answered').length > 0);
});

test('broadcasts stay in their VLAN: Guest reaches the Guest clients and the core’s Guest gateway, nothing of Internal or IoT', () => {
  const s = new S.Simulation(m);
  s.runTo(6000);
  const bd = s.broadcastDomain({ link: 'w-guest-phone', vlan: 30 });
  assert.equal(bd.vlan, 30);
  assert.ok(bd.devices.indexOf('core') >= 0 && bd.devices.indexOf('guest-phone') >= 0);
  for (const d of ['laptop', 'phone', 'tv', 'thermostat', 'nas', 'dsl-router']) assert.ok(bd.devices.indexOf(d) < 0, d);
  // the DHCP Discover of the guest phone is answered from the Guest scope only
  assert.ok(ev(s, (e) => e.device === 'guest-phone' && e.what === 'Bound' && /from 192\.168\.30\.1;/.test(e.detail)).length === 1);
});

test('the path tracer: inter-VLAN traffic goes through the core and the DSL router’s policy; within a VRF the core routes alone', () => {
  const t = T.tracePath(m, { from: 'core:Vlan30', to: '192.168.10.20', service: 'tcp/445' });
  assert.equal(t.paths[0].end.reason, 'denied');
  assert.match(t.paths[0].end.detail, /^dsl-router denies tcp\/445 .*no relation of the model between them and no allow entry permits it/);
  assert.deepEqual(t.paths[0].hops.map((h) => `${h.device}${h.vrf ? '[' + h.vrf + ']' : ''}`), ['core[guest]', 'dsl-router']);
  const iot = T.tracePath(m, { from: 'core:Vlan20', to: '192.168.10.20' });
  assert.ok(iot.paths[0].hops.some((h) => h.notes.some((n) => /dsl-router filters what it forwards/.test(n))), T.traceText(iot));
  const inside = T.tracePath(m, { from: 'core:Vlan99', to: '192.168.10.20' });
  assert.deepEqual(inside.paths[0].hops.map((h) => h.device), ['core', 'nas']);
});

test('the riser cable is the upper floors’ single point of failure: failing it cuts both upper-floor access points, the Basement keeps working; one cable each, no duplicate effects', () => {
  const spof = F.singlePointsOfFailure(m).find((x) => x.ref === 'link:l-core-dist');
  assert.ok(spof);
  // the two halves it leaves: the upper floors, and the Basement with the DSL router and the Internet (the smaller one, or either of two equal ones, is reported)
  const upper = ['ap-1', 'ap-2', 'dist', 'guest-phone', 'laptop', 'phone', 'thermostat'];
  const lower = ['ap-b', 'core', 'dsl-router', 'isp', 'nas', 'tv', 'web'];
  assert.equal(spof.isolated.length, 1);
  assert.ok([upper.join(), lower.join()].indexOf(spof.isolated[0].slice().sort().join()) >= 0, spof.isolated[0].join());
  // one cable between each access point and its switch (the networks share it)
  for (const ap of APS) assert.equal(m.links.filter((l) => l.medium !== 'wireless' && (l.a.device === ap || l.b.device === ap)).length, 1);
  const s = new S.Simulation(m);
  s.runTo(9000);
  s.engine.fail('link:l-core-dist');
  s.runTo(30000);
  const after = (d, what, re) => ev(s, (e) => e.t > 12000 && e.device === d && e.what === what && re.test(e.detail)).length > 0;
  assert.ok(after('laptop', 'Test failed', /203\.0\.113\.80/) && after('guest-phone', 'Test failed', /203\.0\.113\.80/), 'the upper floors lose the Internet');
  assert.ok(after('tv', 'Test answered', /203\.0\.113\.80/), 'the Basement keeps it');
  // the cable fails once, as one cable: one event for it, one carrier loss at each of its two ends
  assert.equal(ev(s, (e) => e.kind === 'link' && e.what === 'Cable failed' && /l-core-dist/.test(e.detail)).length, 1);
  assert.deepEqual(ev(s, (e) => e.kind === 'link' && / down$/.test(e.what) && /\(cable l-core-dist\)/.test(e.detail)).map((e) => e.device).sort(), ['core', 'dist']);
});
