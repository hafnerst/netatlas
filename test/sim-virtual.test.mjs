// Virtualization in the protocol simulation: virtual switches are bridges
// without a spanning tree (split horizon, teaming, failover with RARP),
// a host takes its guests with it (an HA cluster restarts its VMs on
// another member), container networks (bridge with NAT, published ports,
// macvlan), the container engine's start time and the restart policies,
// and the new events: stop / start the container engine, a host's uplink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const N = load('analysis/sim/net.js');

const V = example('virtualization.yaml');
const sim = (text = V) => new S.Simulation(model(text));
const events = (s, f) => s.events().filter(f);
/** Run one Send test… and its answer. */
function probe(s, from, to, kind = 'icmp', port) {
  const t = s.sendTest({ from, to, kind, port });
  assert.equal(typeof t, 'object', String(t));
  s.runTo(s.now + 8000);
  return s.tests().find((x) => x.id === t.id).result;
}

test('the simulated network: a bridge per virtual switch and container network, virtual links to the vNICs and veths, none in the spanning tree', () => {
  const s = sim();
  const net = s.engine.net;
  for (const id of ['hv1/vSwitch0', 'hv1/vSwitch1', 'hv2/vSwitch0', 'ctr1/bridge', 'ctr1/lan', 'k8s1/bridge']) assert.ok(net.devices.get(id) && net.devices.get(id).virt, id);
  const vs = net.devices.get('hv1/vSwitch0');
  assert.deepEqual(vs.virt.uplinks, ['vmnic0', 'vmnic1']);
  // the cables of the uplinks end at the virtual switch; db1's passthrough port at db1
  assert.equal(net.ends.get('hv1/vSwitch0|vmnic0').link, 'hv1-a');
  assert.equal(net.ends.get('db1|eth0').link, 'hv1-pt');
  assert.deepEqual(net.moved.get('hv1|vmnic2'), { device: 'db1', port: 'eth0' });
  // a vNIC's port: its port group's VLAN; the uplinks: every port group's VLAN tagged
  assert.deepEqual(vs.bridgePorts.get('web1.eth0').vlans, { mode: 'access', untagged: 10, tagged: [] });
  assert.equal(vs.bridgePorts.get('vmnic0').vlans.tagged, 'all');
  assert.deepEqual(net.links.get('~web1~eth0').a, { device: 'hv1/vSwitch0', iface: 'web1.eth0' });
  // an HA standby: web1's parked link at hv2
  assert.ok(net.links.has('~web1~eth0@hv2') && net.standby.get('web1').has('hv2'));
  // no virtual switch takes part in the spanning tree
  const tree = N.spanningTree(net, 10, () => false);
  assert.ok(tree.ports.size > 0 && Array.from(tree.ports).every((k) => !net.devices.get(k.split('|')[0]).virt));
  // its MAC table is listed
  assert.ok(s.tableDevices().some((d) => d.id === 'hv1/vSwitch0' && d.mac));
});

test('guests talk across hosts and inside one; the vSwitch learns its guests, not its uplinks; a frame never goes from one uplink to the other', () => {
  const s = sim();
  s.runTo(30000);
  assert.match(probe(s, 'web1', 'app1'), /^Echo Reply/);
  assert.match(probe(s, 'web1', 'db1'), /^Echo Reply/);
  // lab1 and vr1 on the internal vSwitch1: no cable carries their frames
  const t0 = s.now;
  assert.match(probe(s, 'lab1', 'vr1:eth1'), /^Echo Reply/);
  const flights = s.engine.flights.filter((f) => f.t0 >= t0 && f.view === 'physical' && f.protocol === 'icmp');
  assert.ok(flights.length && flights.every((f) => f.track.ref.indexOf('link:~') === 0), flights.map((f) => f.track.ref).join(' '));
  const macs = s.engine.macs.get('hv1/vSwitch0');
  const ports = new Set(Array.from(macs.values()).map((e) => e.port));
  assert.ok(!ports.has('vmnic0') && !ports.has('vmnic1'), 'nothing learned on the uplinks');
  assert.ok(ports.has('web1.eth0'));
});

test('teaming: an uplink down fails over after the failover detection, with a RARP per guest; back up, it fails back', () => {
  const s = sim();
  s.runTo(30000);
  const t0 = s.now;
  // the host's port is shut where its cable ends (at the virtual switch); the events name the host's port
  assert.equal(s.shut('hv1', 'vmnic0'), true);
  assert.ok(s.netEvents().some((e) => e.kind === 'shut' && e.ref === 'iface:hv1:vmnic0'));
  s.runTo(s.now + 3000);
  const fo = events(s, (e) => e.t >= t0 && e.what === 'Failover' && e.device === 'hv1/vSwitch0');
  assert.equal(fo.length, 1);
  assert.match(fo[0].detail, /vmnic0 is down \(failover detection 1 s \(default\)\); it sends by vmnic1 now \(was vmnic0\)/);
  const rarps = events(s, (e) => e.t >= t0 && e.what === 'RARP' && e.device === 'hv1/vSwitch0');
  assert.ok(rarps.some((e) => /web1:eth0 \(00:50:56:01:00:21\) on its new uplink vmnic1/.test(e.detail)));
  assert.match(probe(s, 'web1', 'pc1'), /^Echo Reply/);
  const t1 = s.now;
  s.noShut('hv1', 'vmnic0');
  s.runTo(s.now + 5000);
  assert.ok(events(s, (e) => e.t >= t1 && e.what === 'Uplink back' || (e.t >= t1 && e.what === 'Failover' && /vmnic0 is up again/.test(e.detail))).length);
  assert.match(probe(s, 'web1', 'pc1'), /^Echo Reply/);
});

test('a host powered off takes its guests; its HA cluster restarts the VMs on the other member after the VM restart time (not a VM with passthrough)', () => {
  const s = sim();
  s.runTo(30000);
  s.powerOff('hv2');
  for (const g of ['app1', 'vr1', 'lab1']) assert.ok(!s.engine.deviceOn(g), g);
  assert.ok(s.netEvents().some((e) => e.ref === 'device:app1' && e.hosted && /down with its host hv2/.test(e.state)));
  // vm_restart: 30 s on hv2's Hypervisor service, then the VM's boot time
  s.runTo(s.now + 30000 + 70000);
  for (const g of ['app1', 'vr1', 'lab1']) {
    assert.ok(s.engine.deviceOn(g), g);
    assert.equal(s.engine.hostNow(g), 'hv1', g);
  }
  assert.ok(events(s, (e) => e.device === 'app1' && /app1 is restarted on hv1 by its HA cluster after the VM restart time 30 s/.test(e.detail)).length);
  assert.match(probe(s, 'pc1', 'app1'), /^Echo Reply/);
  assert.match(probe(s, 'lab1', 'pc1'), /^Echo Reply/);
  // hv1 off: db1 (passthrough) is not restarted elsewhere; its parked links stay down
  const t = sim();
  t.runTo(30000);
  t.powerOff('hv1');
  t.runTo(t.now + 200000);
  assert.ok(!t.engine.deviceOn('db1'));
  assert.ok(t.engine.deviceOn('web1') && t.engine.hostNow('web1') === 'hv2');
  // the container in k8s1 comes back with its VM (restart policy always)
  assert.ok(t.engine.deviceOn('metrics'));
});

test('containers: SNAT out of their host, the reply back; published ports to their container and back; no way in otherwise', () => {
  const s = sim();
  s.runTo(30000);
  const t0 = s.now;
  assert.match(probe(s, 'web', 'pc1'), /^Echo Reply/);
  assert.ok(events(s, (e) => e.t >= t0 && e.what === 'SNAT' && /172\.17\.0\.2 → 10\.20\.0\.50 out of eth0/.test(e.detail)).length);
  assert.ok(events(s, (e) => e.t >= t0 && e.what === 'NAT reply' && /10\.20\.0\.50 → 172\.17\.0\.2/.test(e.detail)).length);
  // the host's address on a published port: on to web:80 and back as the host's 8080
  const t1 = s.now;
  assert.match(probe(s, 'pc1', 'ctr1', 'tcp', 8080), /^connected/);
  assert.ok(events(s, (e) => e.t >= t1 && e.what === 'DNAT' && /published port 8080\/tcp to web \(172\.17\.0\.2:80\)/.test(e.detail)).length);
  assert.ok(events(s, (e) => e.t >= t1 && e.what === 'NAT reply' && /172\.17\.0\.2:80 → 10\.20\.0\.50:8080/.test(e.detail)).length);
  // a port nobody publishes: refused by the host; the container's own address: not routed from outside
  assert.match(probe(s, 'pc1', 'ctr1', 'tcp', 9999), /refused/);
  assert.match(probe(s, 'pc1', 'web'), /Unreachable/);
  // a container in a VM: the VM masquerades
  assert.match(probe(s, 'metrics', 'pc1'), /^Echo Reply/);
  // macvlan: cache has its own address on the LAN
  assert.match(probe(s, 'cache', 'pc1'), /^Echo Reply/);
});

test('macvlan: the host can’t reach its own containers on the network’s parent', () => {
  const s = sim(`netatlas: 2
devices:
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}]
  - id: ch
    type: server
    services:
      container_engine:
        engine: docker
        networks:
          - {name: lan, driver: macvlan, parent: eth0, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}
    interfaces: [{id: eth0, ip: 10.10.0.5/24}]
  - id: c1
    type: container
    host: ch
    logical_interfaces: [{id: eth0, type: veth, network: lan, ip: 10.10.0.20}]
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.10.0.30/24}]
links:
  - {id: l1, a: "sw:p1", b: "ch:eth0"}
  - {id: l2, a: "sw:p2", b: "pc:eth0"}
networks:
  - {id: n10, cidr: 10.10.0.0/24, vlan: 10}
`);
  s.runTo(20000);
  assert.match(probe(s, 'pc', 'c1'), /^Echo Reply/);
  assert.match(probe(s, 'pc', 'ch'), /^Echo Reply/);
  assert.doesNotMatch(probe(s, 'ch', 'c1'), /^Echo Reply/);
});

test('the container engine: stopped, its containers stop; started, they start after its start time as their restart policy says', () => {
  const s = sim();
  s.runTo(30000);
  assert.equal(s.stopEngine('ctr1'), true);
  assert.ok(s.netEvents().some((e) => e.kind === 'engine' && e.ref === 'device:ctr1'));
  for (const c of ['web', 'api', 'cache']) assert.ok(!s.engine.deviceOn(c), c);
  s.startEngine('ctr1');
  const t0 = s.now;
  s.runTo(s.now + 20000);
  assert.ok(s.engine.deviceOn('web'), 'always');
  assert.ok(!s.engine.deviceOn('api'), 'on-failure');
  assert.ok(events(s, (e) => e.t >= t0 && e.device === 'api' && /not started again \(restart policy On failure/.test(e.detail)).length);
  assert.ok(s.engine.deviceOn('cache'), 'unless-stopped, not stopped by hand');
  // started after the engine's container start time (default)
  const started = events(s, (e) => e.t >= t0 && e.device === 'web' && e.what === 'Powered on');
  assert.ok(started.length);
  // a container stopped by hand with unless-stopped: not started with the engine
  s.powerOff('cache');
  s.stopEngine('ctr1');
  s.startEngine('ctr1');
  s.runTo(s.now + 20000);
  assert.ok(!s.engine.deviceOn('cache'));
  assert.ok(s.engine.deviceOn('web'));
});
