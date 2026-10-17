// Virtualization in the analyses: the path tracer through virtual switches
// (teaming, passthrough, guest tagging, traffic that stays inside a host),
// container networks (bridge with SNAT, DNAT to published ports, macvlan)
// and the limited NAT model; failures of hosts (HA restart), uplinks and
// passthrough ports; the single points of failure of virtual networking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const T = load('analysis/trace.js');
const F = load('analysis/failure.js');
const R = load('analysis/routing.js');
const U = load('ui/spof.js');

const V = model(example('virtualization.yaml'));
const trace = (m, from, to, ctx) => T.tracePath(m, { from, to }, ctx);
const main = (t) => {
  assert.equal(t.error, undefined, t.error);
  return t.paths[0];
};
const devices = (p) => p.hops.map((h) => h.device);

test('a vNIC leaves through its port group’s virtual switch and the active uplink; guests on one virtual switch meet inside the host', () => {
  // web1 (esx-01, port group Servers) to app1 (esx-02, Apps): through the active uplinks and the core switch
  const p = main(trace(V, 'web1', 'app1'));
  assert.deepEqual(devices(p), ['web1', 'core1', 'app1']);
  assert.equal(p.end.kind, 'reached');
  assert.deepEqual(p.hops[0].virtual.filter((r) => !/^iface:/.test(r)), ['portgroup:hv1:Servers', 'vswitch:hv1:vSwitch0']);
  assert.ok(p.hops[0].virtual.includes('iface:hv1:vmnic0'), 'the active uplink');
  assert.ok(p.hops[0].links.includes('hv1-a'));
  assert.ok(p.hops[0].notes.some((n) => /vSwitch0: vmnic0 active \(vmnic1 standby\)/.test(n)));
  // the refs mark the port group, the virtual switch and the uplink in the diagram
  const refs = T.pathRefs(p);
  for (const r of ['portgroup:hv1:Servers', 'vswitch:hv1:vSwitch0', 'iface:hv1:vmnic0', 'portgroup:hv2:Apps']) assert.ok(refs.has(r), r);
  // lab1 to the virtual router on the internal switch vSwitch1: inside esx-02, no cable
  const q = main(trace(V, 'lab1', 'vr1:eth1'));
  assert.deepEqual(devices(q), ['lab1', 'vr1']);
  assert.deepEqual(q.hops[0].links, []);
  assert.ok(q.hops[0].notes.some((n) => /inside esx-02: on vSwitch1, no cable/.test(n)));
  // a guest-tagged subinterface reaches a VM in its VLAN on the same virtual switch, inside the host
  const g = main(trace(V, 'tagger:eth0.10', 'web1'));
  assert.deepEqual(g.hops[0].links, []);
  assert.ok(g.hops[0].virtual.includes('portgroup:hv1:VGT'));
});

test('passthrough leaves by its host port; a VM in another VLAN on the same virtual switch is not reached directly', () => {
  const p = main(trace(V, 'web1', 'db1'));
  assert.ok(p.hops[0].links.includes('hv1-pt'), 'db1’s cable is the host port bound to it');
  assert.ok(p.hops[0].notes.some((n) => /passthrough of esx-01:vmnic2/.test(n)));
  // two port groups of different VLANs on one virtual switch, addressed as if in one network: no layer-2 way
  const m = model(`netatlas: 2
devices:
  - id: hv
    type: server
    services:
      hypervisor:
        platform: kvm
        vswitches:
          - {name: br0, type: linux_bridge, uplinks: [], port_groups: [{name: a, vlans: 10}, {name: b, vlans: 20}]}
  - id: v1
    type: vm
    host: hv
    logical_interfaces: [{id: eth0, type: vnic, port_group: a, ip: 10.0.0.1/24}]
  - id: v2
    type: vm
    host: hv
    logical_interfaces: [{id: eth0, type: vnic, port_group: b, ip: 10.0.0.2/24}]
`);
  const t = trace(m, 'v1', 'v2');
  assert.equal(t.paths[0].end.kind, 'stopped');
  assert.match(t.paths[0].end.detail, /v1:eth0 \(VLAN 10\) and v2:eth0 \(VLAN 20\) are on br0 in different VLANs/);
});

test('teaming: when the active uplink is down the standby takes over; with every uplink down the guest is cut off', () => {
  const one = F.simulate(V, ['iface:hv1:vmnic0']);
  const p = main(trace(V, 'web1', 'pc1', one.ctx));
  assert.ok(p.hops[0].virtual.includes('iface:hv1:vmnic1'));
  assert.ok(p.hops[0].notes.some((n) => /vmnic0 down: vSwitch0 fails over to vmnic1/.test(n)));
  assert.equal(one.ifaces.get('web1:eth0'), 'degraded');
  const both = F.simulate(V, ['iface:hv1:vmnic0', 'iface:hv1:vmnic1']);
  assert.equal(both.ifaces.get('web1:eth0'), 'down');
  assert.match(both.why.get('iface:web1:eth0'), /every uplink of vSwitch0 on hv1 is down/);
  const t = trace(V, 'web1', 'pc1', both.ctx);
  assert.ok(t.error || t.paths[0].end.kind === 'stopped');
});

test('containers: the bridge’s default route, SNAT out of the host; DNAT to a published port; no way in without one; macvlan and its host', () => {
  // out: the container's default route via the bridge's gateway, the host masquerades
  const out = main(trace(V, 'web', 'pc1'));
  assert.deepEqual(devices(out), ['web', 'ctr1', 'core1', 'pc1']);
  assert.match(out.hops[0].via.text, /default route via 172\.17\.0\.1 \(the gateway of the network bridge\)/);
  assert.equal(out.hops[1].nat, 'snat');
  assert.ok(out.hops[1].notes.some((n) => /SNAT: source 172\.17\.0\.2 → 10\.20\.0\.50/.test(n)));
  // a container in a VM: the VM forwards and masquerades
  const k = main(trace(V, 'metrics', 'pc1'));
  assert.deepEqual(devices(k), ['metrics', 'k8s1', 'core1', 'pc1']);
  assert.equal(k.hops[1].nat, 'snat');
  // in: at the host's address, then the DNAT hop to the container
  const t = trace(V, 'pc1', 'web');
  const inn = main(t);
  assert.equal(t.dest.address, '172.17.0.2');
  assert.deepEqual(devices(inn), ['pc1', 'core1', 'ctr1', 'web']);
  assert.equal(inn.hops[2].nat, 'dnat');
  assert.match(inn.hops[2].via.text, /^DNAT: 10\.20\.0\.50 \(published 8080→80\/tcp\) → 172\.17\.0\.2$/);
  assert.equal(inn.end.kind, 'reached');
  // the host itself and a container on the same bridge reach it directly
  assert.deepEqual(devices(main(trace(V, 'ctr1', 'web'))), ['ctr1', 'web']);
  assert.deepEqual(devices(main(trace(V, 'api', 'web'))), ['api', 'web']);
  // without published ports: not from outside
  const closed = model(example('virtualization.yaml').replace('        ip: 172.17.0.2\n        publish:\n          - {host_port: 8080, port: 80, protocol: tcp}\n', '        ip: 172.17.0.2\n'));
  assert.equal((closed.index.interfaces.get('web:eth0').publish || []).length, 0);
  assert.match(trace(closed, 'pc1', 'web').error, /behind the NAT of docker-01 \(network bridge\) and publishes no ports/);
  // macvlan: on the LAN through the parent port; the host can't reach it directly on that LAN
  const mv = main(trace(V, 'cache', 'pc1'));
  assert.ok(mv.hops[0].links.includes('ctr1-b'));
  assert.ok(mv.hops[0].notes.some((n) => /macvlan lan on docker-01:eth1/.test(n)));
});

test('the macvlan host can’t reach its own children on their LAN; a written default route wins over the implicit one', () => {
  const m = model(`netatlas: 2
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
  const t = trace(m, 'ch', 'c1');
  assert.equal(t.paths[0].end.kind, 'stopped');
  assert.match(t.paths[0].end.detail, /ch can't reach its own macvlan \/ ipvlan containers/);
  // a neighbour on the LAN reaches it through the switch
  const p = main(trace(m, 'pc', 'c1'));
  assert.deepEqual(p.hops[0].links, ['l2', 'l1']);
  // the implicit default route of a container: via its network's gateway; a written one takes its place
  const rib = R.ribOf(m, 'c1', '');
  assert.ok(rib.some((e) => e.implicit && /default route via 10\.10\.0\.1/.test(e.implicit)));
  const w = model(`netatlas: 2
devices:
  - id: ch
    type: server
    services: {container_engine: {engine: docker, networks: [{name: b, driver: bridge, interface: docker0, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true}]}}
  - id: c1
    type: container
    host: ch
    logical_interfaces: [{id: eth0, type: veth, network: b, ip: 172.17.0.2}]
    routes: [{prefix: 0.0.0.0/0, via: 172.17.0.9}]
`);
  assert.ok(!R.ribOf(w, 'c1', '').some((e) => e.implicit));
  assert.ok(R.ribOf(w, 'c1', '').some((e) => e.route && e.net.prefix === 0));
});

test('failures: a host takes its guests down; in an HA cluster its VMs restart on another member (not with passthrough), and the tracer follows them', () => {
  const r = F.simulate(V, ['device:hv1']);
  assert.equal(r.devices.get('web1'), 'degraded');
  assert.match(r.why.get('device:web1'), /its host hv1 failed: restarts on hv2 \(HA cluster prod\)/);
  assert.equal(r.devices.get('db1'), 'down');
  assert.match(r.why.get('device:db1'), /passthrough port HA can't restart it elsewhere/);
  // a container in a restarted VM moves with it
  assert.equal(r.devices.get('metrics'), 'degraded');
  assert.match(r.why.get('device:metrics'), /moves with k8s1/);
  // the tracer: web1 now leaves through esx-02
  const p = main(trace(V, 'web1', 'pc1', r.ctx));
  assert.ok(p.hops[0].virtual.includes('vswitch:hv2:vSwitch0'));
  assert.ok(p.hops[0].links.includes('hv2-a'));
  // without a spare member: down
  const c = F.simulate(V, ['device:ctr1']);
  for (const id of ['web', 'api', 'cache']) assert.equal(c.devices.get(id), 'down', id);
  assert.match(c.why.get('device:web'), /its host ctr1 failed/);
  // both members down: nothing to restart on
  const both = F.simulate(V, ['device:hv1', 'device:hv2']);
  assert.equal(both.devices.get('web1'), 'down');
  // a passthrough port takes its VM's vNIC with it
  const pt = F.simulate(V, ['iface:hv1:vmnic2']);
  assert.equal(pt.ifaces.get('db1:eth0'), 'down');
});

test('single points of failure: a host for its guests (unless HA can restart them), a passthrough port; a virtual switch with one uplink or uplinks to one switch', () => {
  const rows = U.spofRows(V, F.singlePointsOfFailure(V));
  const row = (type, el) => rows.find((r) => r.type === type && r.element === el);
  // the Docker host has no cluster: its containers go with it
  assert.equal(row('Device', 'ctr1').cuts, 'guests: api, cache, web');
  // esx-01 is in a cluster: only db1 (passthrough) can't be restarted
  assert.equal(row('Device', 'hv1').cuts, 'guests: db1');
  assert.equal(row('Passthrough port', 'hv1:vmnic2').cuts, 'guests: db1');
  // two uplinks to two switches: no virtual switch of the example is one
  assert.ok(!rows.some((r) => r.type === 'Virtual switch'));
  // one uplink; uplinks to one switch
  const one = model(example('virtualization.yaml').replace('uplinks: [vmnic0, vmnic1]', 'uplinks: [vmnic0]'));
  const r1 = U.spofRows(one, F.singlePointsOfFailure(one)).filter((r) => r.type === 'Virtual switch');
  assert.deepEqual(r1.map((r) => [r.element, r.cuts]), [['hv1 vSwitch0 (one uplink (vmnic0))', 'guests: k8s1, tagger, web1']]);
  const same = model(
    example('virtualization.yaml')
      .replace('{id: hv1-b, a: "tor2:Gi1/0/1", b: "hv1:vmnic1"', '{id: hv1-b, a: "tor1:Gi1/0/6", b: "hv1:vmnic1"')
      .replace('      - {id: Gi1/0/5, vlans: 10,', '      - {id: Gi1/0/6, vlans: [10, 20, 30, 99]}\n      - {id: Gi1/0/5, vlans: 10,'),
  );
  const r2 = U.spofRows(same, F.singlePointsOfFailure(same)).filter((r) => r.type === 'Virtual switch');
  assert.ok(r2.some((r) => /its uplinks all go to tor1/.test(r.element)), JSON.stringify(r2));
  // the impact counts the guests
  assert.equal(row('Device', 'ctr1').impact, 3);
});
