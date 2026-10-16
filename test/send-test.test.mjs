// Send test…: every device is a source, able to send or listed with the
// reason it can't (the capability resolver: an IP stack; an interface with an
// address or DHCP). A DHCP client sends once its lease is there, from the
// lease's address in its network's VLAN; its state is computed from the
// simulation each time; DHCP that gets no answer ends the test with the
// reason. A source can be an interface of its own. A test to a destination
// the policy denies is sent and ends where it is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const HOUSE = example('private-house.yaml');
const src = (s, id) => s.testSources().find((x) => x.id === id);

test('every device of the model is a source: those with an IP stack and an address or DHCP can send, the others are listed with the reason', () => {
  const m = model(HOUSE);
  const s = new S.Simulation(m);
  const all = s.testSources();
  assert.deepEqual(all.map((x) => x.id), m.devices.map((d) => d.id).sort());
  // the regression: guest-phone (a DHCP client without a static address) was not offered
  for (const id of ['guest-phone', 'laptop', 'phone', 'tv', 'thermostat']) assert.equal(src(s, id).ok, true, id);
  // a Cloud forwards: it has no IP stack of its own, and says so
  assert.equal(src(s, 'isp').ok, false);
  assert.match(src(s, 'isp').reason, /^it has no IP stack of its own \(Cloud · ISP \/ carrier\): it forwards or observes traffic and sends none$/);
  assert.match(s.sendTest({ from: 'isp', to: 'web', kind: 'icmp' }), /^isp can't send a test: it has no IP stack of its own/);
  // a pass-through TAP and a passive IDS gain no host behaviour; a switch without an address explains what it lacks
  const ot = new S.Simulation(model(example('ot-network.yaml')));
  for (const id of ['tap', 'ids']) {
    assert.equal(src(ot, id).ok, false, id);
    assert.match(src(ot, id).reason, /no IP stack of its own/, id);
    assert.equal(typeof ot.sendTest({ from: id, to: 'plc1', kind: 'icmp' }), 'string', id);
  }
  assert.match(src(ot, 'cell-sw').reason, /^no interface with an address or DHCP/);
});

test('a DHCP client: no lease yet (its test waits for it), then its lease with gateway, DNS and its Wi-Fi network and VLAN; the test is sent from the leased address', () => {
  const s = new S.Simulation(model(HOUSE));
  const before = src(s, 'guest-phone');
  assert.deepEqual(before.ifaces.map((i) => [i.id, i.dhcp, i.ready]), [['wlan0', true, false]]);
  assert.match(before.ifaces[0].status, /^DHCP: no lease, its link is not up .* · Wi-Fi network “Home-Guest” of ap-1 \(VLAN 30\)$/);
  // sent before the lease: it waits for it, and says so; nothing is invented meanwhile
  const t = s.sendTest({ from: 'guest-phone', to: 'web', kind: 'tcp', port: 443 });
  assert.equal(typeof t, 'object');
  assert.match(t.result, /^waiting for a DHCP lease on guest-phone:wlan0$/);
  s.runTo(9000);
  const now = src(s, 'guest-phone');
  assert.equal(now.ifaces[0].ready, true);
  assert.match(now.ifaces[0].status, /^DHCP: 192\.168\.30\.\d+\/24 from 192\.168\.30\.1, gateway 192\.168\.30\.1, DNS 10\.0\.30\.1, lease 24 h · Wi-Fi network “Home-Guest” of ap-1 \(VLAN 30\)$/);
  assert.equal(t.done && t.ok, true, t.result);
  // its packets left from the lease's address (the DSL router translated that one)
  const lease = /DHCP: (192\.168\.30\.\d+)\//.exec(now.ifaces[0].status)[1];
  assert.ok(s.events().some((e) => e.test === t.id && e.what === 'PAT' && e.detail.indexOf(lease + ' → 203.0.113.10') >= 0));
});

test('a policy-denied destination: the Guest phone can send its test; it ends where the DSL router drops it, not as a missing source', () => {
  const s = new S.Simulation(model(HOUSE));
  s.runTo(9000);
  const t = s.sendTest({ from: 'guest-phone', to: '192.168.10.20', kind: 'tcp', port: 445 });
  assert.equal(typeof t, 'object');
  s.runTo(16000);
  assert.equal(t.ok, false);
  assert.match(t.result, /^no answer within 5 s \(default\) \(timed out\); the last of its packets was dropped at dsl-router: dsl-router drops TCP 192\.168\.30\.\d+:\d+ → 192\.168\.10\.20:445 .*no relation of the model and no allow entry permits it/);
  // an unreachable address is a different outcome: the DSL router's own test leaves the model at its next hop
  const u = s.sendTest({ from: 'dsl-router', to: '198.18.0.1', kind: 'icmp' });
  s.runTo(23000);
  assert.match(u.result, /; the last of its packets was dropped at dsl-router: leaves the model at dsl-router: the next hop 203\.0\.113\.1 is outside it/);
});

test('DHCP without an answer: a waiting test fails with the reason, the device stays a source and says what happened', () => {
  // no Guest scope: the Guest phone's DHCPDISCOVERs get no offer
  const text = HOUSE.replace(/          - \{network: guest,[^\n]*\n/, '');
  const s = new S.Simulation(model(text));
  s.runTo(1000);
  const t = s.sendTest({ from: 'guest-phone', to: 'web', kind: 'icmp' });
  s.runTo(80000);
  assert.equal(t.ok, false);
  assert.match(t.result, /^not sent: guest-phone:wlan0 has no DHCP lease \(no DHCPOFFER after \d+ DHCPDISCOVERs; it tries again in 5 min\)$/);
  const g = src(s, 'guest-phone');
  assert.equal(g.ok, true);
  assert.match(g.ifaces[0].status, /^DHCP: no lease, no DHCPOFFER after \d+ DHCPDISCOVERs; it tries again in 5 min/);
  // the other zones are unaffected
  assert.equal(src(s, 'laptop').ifaces[0].ready, true);
});

test('no stale lease: a client whose link goes down has no lease (a test waits again); back up, it is leased again', () => {
  const s = new S.Simulation(model(HOUSE));
  s.runTo(9000);
  assert.equal(src(s, 'guest-phone').ifaces[0].ready, true);
  s.engine.fail('link:w-guest-phone');
  s.runTo(10000);
  const down = src(s, 'guest-phone').ifaces[0];
  assert.equal(down.ready, false);
  assert.match(down.status, /^DHCP: no lease, its link is not up/);
  const t = s.sendTest({ from: 'guest-phone', to: 'web', kind: 'tcp', port: 443 });
  assert.match(t.result, /^waiting for a DHCP lease on guest-phone:wlan0$/);
  s.engine.restore('link:w-guest-phone');
  s.runTo(30000);
  assert.equal(src(s, 'guest-phone').ifaces[0].ready, true);
  assert.equal(t.ok, true, t.result);
});

test('an interface chosen as the source: its address and VRF; a device with several interfaces lists them; an unknown one is refused', () => {
  const s = new S.Simulation(model(HOUSE));
  assert.deepEqual(src(s, 'core').ifaces.map((i) => i.id), ['Vlan10', 'Vlan110', 'Vlan120', 'Vlan130', 'Vlan20', 'Vlan30', 'Vlan99']);
  s.runTo(5000);
  // from the Guest gateway (VRF guest) to the NAS: through the DSL router, whose policy drops it
  const t = s.sendTest({ from: 'core', via: 'Vlan30', to: '192.168.10.20', kind: 'icmp' });
  assert.equal(t.series, 'core:Vlan30 → 192.168.10.20 ICMP echo');
  s.runTo(12000);
  assert.ok(s.events().some((e) => e.test === t.id && e.device === 'core' && /core routes 192\.168\.30\.1 → 192\.168\.10\.20: .*out Vlan130/.test(e.detail) || (e.test === t.id && e.device === 'dsl-router')));
  assert.match(t.result, /dropped at dsl-router/);
  // from the Internal gateway: the core reaches the NAS itself
  const i = s.sendTest({ from: 'core', via: 'Vlan10', to: '192.168.10.20', kind: 'icmp' });
  s.runTo(19000);
  assert.equal(i.ok, true, i.result);
  assert.match(s.sendTest({ from: 'core', via: 'Gi9', to: 'nas', kind: 'icmp' }), /^core has no interface Gi9 with an IP address or DHCP$/);
});
