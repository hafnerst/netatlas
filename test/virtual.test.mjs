// Virtualization in the format: guests (VMs and containers) bound to their
// host, the Hypervisor service (virtual switches, teaming, port groups,
// host interfaces, an HA cluster) and the Container engine service
// (container networks of every driver, published ports); the hypervisor
// is no device type of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, model, example, queries, load } from './helpers.mjs';

const V = load('model/virtual.js');
const { ModelDoc } = load('editor/document.js');
const C = load('model/connect.js');
const H = load('analysis/helpers.js');
const doc = (t) => ModelDoc.fromText(t, 't.yaml', 'file').doc;

const errs = (t) => validate.loadModel(t).errors.map((e) => `${e.path}: ${e.message}`);
const ok = (t) => {
  const r = validate.loadModel(t);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => `${e.path}: ${e.message}`), []);
  return r.model;
};

// a switch with two trunks and an access port to a KVM host (a Linux bridge on two uplinks, three port groups,
// a management interface), a VM on it, and a Docker host with a bridge, a macvlan, a host and a none network and a container
export const BASE = `netatlas: 1
groups:
  - {id: dc, kind: site}
devices:
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: [10, 20]}, {id: p2, vlans: [10, 20]}, {id: p3, vlans: 10}]
  - id: hv
    type: server
    group: dc
    services:
      hypervisor:
        platform: kvm
        vswitches:
          - name: br0
            type: linux_bridge
            uplinks: [eno1, eno2]
            teaming: active_standby
            port_groups:
              - {name: v10, vlans: 10}
              - {name: trunk, vlans: [10, 20], native: 10}
              - {name: vgt, guest_tagging: true}
    interfaces: [eno1, eno2, eno3]
    logical_interfaces:
      - {id: mgmt0, type: vnic, port_group: v10, role: management, ip: 10.10.0.5/24}
  - id: vm1
    type: vm
    host: hv
    logical_interfaces:
      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}
  - id: ch
    type: server
    services:
      container_engine:
        engine: docker
        networks:
          - {name: bridge, driver: bridge, interface: docker0, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true, range: 172.17.0.100-172.17.0.110}
          - {name: lan, driver: macvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}
          - {name: host, driver: host}
          - {name: none, driver: none}
    interfaces: [{id: eth0, ip: 10.20.0.50/24}, eth1]
  - id: c1
    type: container
    host: ch
    logical_interfaces:
      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: tcp}]}
links:
  - {id: l1, a: "sw:p1", b: "hv:eno1"}
  - {id: l2, a: "sw:p2", b: "hv:eno2"}
  - {id: l3, a: "sw:p3", b: "hv:eno3"}
networks:
  - {id: n10, cidr: 10.10.0.0/24, vlan: 10}
  - {id: n20, cidr: 10.20.0.0/24, vlan: 20}
`;
export const rep = (a, b, t = BASE) => {
  assert.ok(t.includes(a), a);
  return t.replace(a, b);
};
const VM1 = '  - id: vm1\n    type: vm\n    host: hv\n';
const one = (t) => {
  const e = errs(t);
  assert.equal(e.length, 1, e.join('\n'));
  return e[0];
};

test('the model: a guest has its host; the services hold their virtual switches, port groups and networks; a bridge network creates its interface', () => {
  const m = ok(BASE);
  const hv = m.index.devices.get('hv');
  assert.equal(hv.hypervisor.platform, 'kvm');
  const br0 = hv.hypervisor.vswitches[0];
  assert.deepEqual([br0.name, br0.type, br0.uplinks, br0.teaming], ['br0', 'linux_bridge', ['eno1', 'eno2'], 'active_standby']);
  assert.deepEqual(br0.portGroups.map((p) => [p.name, p.vlans, p.native, p.guestTagging]), [
    ['v10', [{ from: 10, to: 10 }], undefined, false],
    ['trunk', [{ from: 10, to: 10 }, { from: 20, to: 20 }], 10, false],
    ['vgt', [], undefined, true],
  ]);
  assert.deepEqual([m.index.interfaces.get('hv:mgmt0').type, m.index.interfaces.get('hv:mgmt0').portGroup, m.index.interfaces.get('hv:mgmt0').role], ['vnic', 'v10', 'management']);
  const vm = m.index.devices.get('vm1');
  assert.equal(vm.host, 'hv');
  assert.deepEqual(vm.interfaces, [], 'no ports');
  assert.equal(vm.group, 'dc', 'its location is its host’s');
  assert.equal(m.index.interfaces.get('vm1:eth0').portGroup, 'v10');
  // the container engine and its networks; the bridge network's interface is derived on the host
  const ch = m.index.devices.get('ch');
  assert.deepEqual(ch.containerEngine.networks.map((n) => [n.name, n.driver]), [['bridge', 'bridge'], ['lan', 'macvlan'], ['host', 'host'], ['none', 'none']]);
  const docker0 = m.index.interfaces.get('ch:docker0');
  assert.deepEqual([docker0.type, docker0.addresses, docker0.derived], ['bridge', ['172.17.0.1/16'], 'bridge']);
  assert.ok(ch.logical.includes(docker0));
  const br = ch.containerEngine.networks[0];
  assert.deepEqual([br.subnet, br.gateway, br.nat, br.range, br.start, br.end], ['172.17.0.0/16', '172.17.0.1', true, '172.17.0.100-172.17.0.110', '172.17.0.100', '172.17.0.110']);
  const c1 = m.index.interfaces.get('c1:eth0');
  assert.deepEqual([c1.type, c1.network, c1.publish.map((p) => [p.hostPort, p.port, p.protocol])], ['veth', 'bridge', [[8080, 80, 'tcp']]]);
  // a bridge network's interface is never written back
  assert.ok(!/docker0:|id: docker0/.test(BASE.replace('interface: docker0', '')));
});

test('a guest needs its host, and the host its service', () => {
  assert.equal(one(rep('    host: hv\n', '')), 'devices.vm1.host: VM "vm1" needs its host: a server with the Hypervisor service (or, as a cloud instance, a cloud group: a cloud_region, vpc or vnet)');
  assert.equal(one(rep('    host: ch\n', '')), 'devices.c1.host: container "c1" needs its host: a server or a VM with the Container engine service (or, as a cloud instance, a cloud group: a cloud_region, vpc or vnet)');
  assert.equal(one(rep('    host: hv\n', '    host: hvx\n')), 'devices.vm1.host: unknown host "hvx" — did you mean "hv"?');
  assert.equal(one(rep('    host: hv\n', '    host: ch\n')), 'devices.vm1.host: the host of VM "vm1" is a server with the Hypervisor service; "ch" has no Hypervisor service (enable it in its Services)');
  assert.match(one(rep('    host: ch\n', '    host: vm1\n')), /^devices\.c1\.host: the host of container "c1" is a server or a VM with the Container engine service; "vm1" has no Container engine service/);
  assert.match(one(rep('    host: ch\n', '    host: sw\n')), /"sw" is a switch$/);
  assert.equal(one(rep('  - id: ch\n    type: server\n', '  - id: ch\n    type: server\n    host: hv\n')), 'devices.ch.host: only a VM or a container has a host; "ch" is a server — delete "host"');
  // a VM may run containers (its own container engine): a container's host can be a VM
  const inVm = rep(VM1, VM1 + '    services: {container_engine: {engine: podman, networks: [{name: b, driver: bridge, interface: podman0, subnet: 10.88.0.0/16, gateway: 10.88.0.1, nat: true}]}}\n') + '  - {id: c2, type: container, host: vm1, logical_interfaces: [{id: eth0, type: veth, network: b, ip: 10.88.0.5}]}\n';
  const m = ok(inVm.replace('links:\n', '  - {id: c2, type: container, host: vm1, logical_interfaces: [{id: eth0, type: veth, network: b, ip: 10.88.0.5}]}\nlinks:\n').replace(/\n {2}- \{id: c2[^\n]*\n$/, '\n'));
  assert.equal(m.index.devices.get('c2').group, 'dc', 'in a VM: the VM’s host’s location');
  assert.match(one(rep(VM1, VM1 + '    services: {hypervisor: {platform: kvm, vswitches: []}}\n')), /the Hypervisor service runs on a server; "vm1" is a virtual machine \(nested virtualization is not modelled\)/);
});

test('a guest has no ports, no cables and no location of its own', () => {
  assert.match(one(rep(VM1, VM1 + '    interfaces: [eth9]\n')), /^devices\.vm1\.interfaces\[0\]: VM "vm1" has no physical interfaces: its network interfaces are virtual NICs \(logical_interfaces with type: vnic/);
  assert.match(one(rep('  - id: c1\n    type: container\n    host: ch\n', '  - id: c1\n    type: container\n    host: ch\n    interfaces: [eth9]\n')), /container "c1" has no physical interfaces: its network interfaces are attachments to its host's container networks \(logical_interfaces with type: veth\)/);
  assert.equal(one(rep(VM1, VM1 + '    group: dc\n')), 'devices.vm1.group: VM "vm1" is where its host is: its location is the host\'s — delete "group" (set the host\'s location instead)');
  assert.equal(one(rep('  - {id: l3, a: "sw:p3", b: "hv:eno3"}\n', '  - {id: l3, a: "sw:p3", b: vm1}\n')), 'links.l3.b: "vm1" is a VM: a guest has no cables — it reaches the network through its host ("hv") (cable the host\'s ports)');
  // the guest fields belong to their type
  assert.match(one(rep('  - id: ch\n    type: server\n', '  - id: ch\n    type: server\n    vcpu: 4\n')), /"vcpu" is a VM's; "ch" is a server/);
  assert.match(one(rep(VM1, VM1 + '    image: nginx\n')), /"image" is a container's; "vm1" is a virtual machine/);
  assert.match(one(rep(VM1, VM1 + '    ram: lots\n')), /"lots" is not a size: write a number with a unit, e.g. 16G or 512M/);
  const m = ok(rep(VM1, VM1 + '    guest_os: Debian 12\n    vcpu: 4\n    ram: 8G\n'));
  assert.deepEqual([m.index.devices.get('vm1').guestOs, m.index.devices.get('vm1').vcpu, m.index.devices.get('vm1').ram], ['Debian 12', 4, '8G']);
});

test('the hypervisor is no device type: a server with the Hypervisor service; its VM restart time is the service’s', () => {
  assert.match(errs(BASE.replace('  - id: hv\n    type: server\n', '  - id: hv\n    type: hypervisor\n'))[0], /unknown device type "hypervisor" \(a hypervisor is a server with the Hypervisor service: type: server, and services: hypervisor\)/);
  assert.equal(one(rep('    group: dc\n    services:', '    group: dc\n    simulation: {vm_restart: 30}\n    services:')), 'devices.hv.simulation.vm_restart: "vm_restart" (vm restart time) is set per Hypervisor service: in services.hypervisor.simulation:, not for the whole device');
  const m = ok(rep('        platform: kvm\n', '        platform: kvm\n        simulation: {vm_restart: 30}\n'));
  assert.equal(m.index.devices.get('hv').hypervisor.simulation.get('vm-restart'), 30000);
  assert.match(one(rep('            teaming: active_standby\n', '            teaming: active_standby\n            simulation: {vm_restart: 3}\n')), /"vm_restart" \(vm restart time\) is not an attribute of a virtual switch/);
  const v = ok(rep('            teaming: active_standby\n', '            teaming: active_standby\n            simulation: {failover_detection: 2s}\n'));
  assert.equal(v.index.devices.get('hv').hypervisor.vswitches[0].simulation.get('failover-detect'), 2000);
  // only a server runs it; a container engine runs on a server or a VM
  assert.match(one(rep('  - id: sw\n    type: switch\n', '  - id: sw\n    type: switch\n    services: {container_engine: {engine: docker, networks: [{name: n, driver: none}]}}\n')), /the Container engine service runs on a server or a VM; "sw" is a switch/);
});

test('the Hypervisor service: what it needs is reported until written; virtual switches, uplinks, teaming, port groups', () => {
  const svc = (t) => errs(t).filter((e) => /services\.hypervisor/.test(e));
  assert.deepEqual(svc(rep('        platform: kvm\n', '')), ['devices.hv.services.hypervisor.platform: the Hypervisor service of "hv" needs its platform (kvm, esxi, hyperv, proxmox, xen, other)']);
  assert.match(svc(rep('platform: kvm', 'platform: vbox'))[0], /"vbox" is not a hypervisor platform: use "kvm", "esxi", "hyperv", "proxmox", "xen", "other"/);
  assert.match(errs(rep('            teaming: active_standby\n', ''))[0], /virtual switch 1 of "hv" needs its teaming \(active_standby, load_based, source_based, lacp\): how it uses its uplinks/);
  assert.match(errs(rep('uplinks: [eno1, eno2]', 'uplinks: [eno1, eno9]'))[0], /uplinks\[1\]: "hv" has no port "eno9" — did you mean "eno1"\?/);
  assert.match(errs(rep('uplinks: [eno1, eno2]', 'uplinks: [eno1, mgmt0]'))[0], /"mgmt0" is a vnic interface: a virtual switch's uplinks are the host's physical ports or aggregates \(bonds\)/);
  assert.match(errs(rep('teaming: active_standby', 'teaming: lacp'))[0], /LACP teaming needs one aggregate \(a bond of the host\) as the uplink of "br0"; it has eno1, eno2/);
  // LACP on a bond is fine
  const lacp = rep('uplinks: [eno1, eno2]', 'uplinks: [bond0]', rep('teaming: active_standby', 'teaming: lacp')).replace('    interfaces: [eno1, eno2, eno3]\n    logical_interfaces:\n', '    interfaces: [eno1, eno2, eno3]\n    logical_interfaces:\n      - {id: bond0, type: virtual, members: [eno1, eno2]}\n');
  assert.deepEqual(errs(lacp), []);
  // an internal virtual switch has no uplinks (and so no teaming)
  assert.deepEqual(errs(rep('            uplinks: [eno1, eno2]\n            teaming: active_standby\n', '')).filter((e) => /teaming|uplinks/.test(e)), []);
  assert.match(errs(rep('            uplinks: [eno1, eno2]\n', ''))[0], /teaming is how a virtual switch uses its uplinks: "br0" has none \(an internal switch\)/);
  // port groups: a VLAN mode, names unique on the host
  assert.match(errs(rep('{name: v10, vlans: 10}', '{name: v10}'))[0], /port group "v10" needs its VLAN mode: "vlans" \(one VLAN: access; several: a trunk\) or "guest_tagging: true"/);
  assert.match(errs(rep('{name: trunk, vlans: [10, 20], native: 10}', '{name: v10, vlans: [10, 20], native: 10}'))[0], /"hv" has two port groups named "v10" \(also on br0\): a VM names its port group, so the names are unique on a host/);
  assert.match(errs(rep('{name: vgt, guest_tagging: true}', '{name: vgt, guest_tagging: true, vlans: 5}'))[0], /port group "vgt" has VLANs and guest tagging/);
  assert.match(errs(rep('{name: trunk, vlans: [10, 20], native: 10}', '{name: trunk, vlans: [10, 20], native: 30}'))[0], /the native VLAN 30 is not one of the VLANs of port group "trunk" \(10, 20\)/);
  assert.match(errs(rep('{name: v10, vlans: 10}', '{name: v10, vlans: 5000}'))[0], /"5000" is not a VLAN ID or range/);
  assert.match(errs(rep('    services:\n      hypervisor:\n        platform: kvm\n', '    services:\n      hypervisor:\n        platform: kvm\n        cluster: prod\n        cpu: 32\n        ram: 256G\n')).join('|') || 'none', /^none$/);
});

test('virtual NICs: a port group of the host, or passthrough of a host port (exclusive, never an uplink); guest tagging', () => {
  assert.equal(one(rep('port_group: v10, ip: 10.10.0.21/24', 'port_group: v11, ip: 10.10.0.21/24')), 'devices.vm1.logical_interfaces[0].port_group: host "hv" has no port group "v11" — did you mean "v10"?');
  assert.equal(one(rep('{id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}', '{id: eth0, type: vnic, ip: 10.10.0.21/24}')), 'devices.vm1.logical_interfaces[0].port_group: vnic "eth0" of "vm1" needs its port group (a port group of its host\'s virtual switches) or a passthrough port');
  assert.match(one(rep('port_group: v10, ip', 'port_group: v10, passthrough: eno3, ip')), /"eth0" has a port group and a passthrough port: a vnic is on a port group or bound to a host port/);
  // passthrough: a physical port of the host, used once, never an uplink
  const pt = (x) => rep('      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}\n', x);
  assert.deepEqual(errs(pt('      - {id: eth0, type: vnic, passthrough: eno3, ip: 10.10.0.21/24}\n')), []);
  assert.equal(one(pt('      - {id: eth0, type: vnic, passthrough: eno1, ip: 10.10.0.21/24}\n')), 'devices.vm1.logical_interfaces[0].passthrough: eno1 of "hv" is the uplink of br0: a port used for passthrough can\'t be an uplink');
  assert.match(one(pt('      - {id: eth0, type: vnic, passthrough: eno3}\n      - {id: eth1, type: vnic, passthrough: eno3}\n')), /eno3 of "hv" is already the passthrough of vm1:eth0: a passthrough port is used once/);
  assert.match(one(pt('      - {id: eth0, type: vnic, passthrough: eno7}\n')), /host "hv" has no physical port "eno7"/);
  // SR-IOV: virtual functions of one port, each once
  assert.deepEqual(errs(pt('      - {id: eth0, type: vnic, passthrough: eno3, vf: 1}\n      - {id: eth1, type: vnic, passthrough: eno3, vf: 2}\n')), []);
  assert.match(one(pt('      - {id: eth0, type: vnic, passthrough: eno3, vf: 1}\n      - {id: eth1, type: vnic, passthrough: eno3, vf: 1}\n')), /eno3 \(virtual function 1\) of "hv" is already the passthrough of vm1:eth0/);
  assert.match(one(pt('      - {id: eth0, type: vnic, port_group: v10, vf: 1}\n')), /"vf" is the SR-IOV virtual function of a passthrough port: "eth0" has no passthrough/);
  // a host interface: on its own port groups, with a role; never passthrough
  assert.match(one(rep('{id: mgmt0, type: vnic, port_group: v10, role: management, ip: 10.10.0.5/24}', '{id: mgmt0, type: vnic, port_group: v10, role: backup, ip: 10.10.0.5/24}')), /"backup" is not a host interface role: use management, migration, storage/);
  assert.match(one(rep('port_group: v10, ip: 10.10.0.21/24', 'port_group: v10, role: storage, ip: 10.10.0.21/24')), /"role" is a hypervisor's host interface's/);
  assert.match(one(rep('  - id: ch\n    type: server\n', '  - id: ch\n    type: server\n    logical_interfaces: [{id: v0, type: vnic, port_group: x}]\n')), /a server's vnic is a host interface on its own virtual switch: "ch" has no Hypervisor service/);
  // guest tagging (or a trunk port group): VLAN subinterfaces of the vnic; on an access port group they are an error
  const sub = (pg) => rep('      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}\n', `      - {id: eth0, type: vnic, port_group: ${pg}}\n      - {id: eth0.20, type: virtual, ip: 10.20.0.9/24}\n`);
  assert.deepEqual(errs(sub('vgt')), []);
  assert.deepEqual(errs(sub('trunk')), []);
  assert.equal(one(sub('v10')), 'devices.vm1.logical_interfaces[1]: "eth0.20" is a VLAN subinterface of vnic "eth0", whose port group "v10" is an access port group (VLAN 10): the guest\'s tags need guest tagging or a trunk port group');
  // the keys belong to their interface type
  assert.match(one(rep('{id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}', '{id: eth0, type: veth, network: bridge}')), /a veth is a container's attachment to a container network; "vm1" is a virtual machine/);
  assert.match(one(rep('      - {id: mgmt0, ', '      - {id: lo0, type: loopback, ip: 10.255.0.1/32, port_group: v10}\n      - {id: mgmt0, ')), /"port_group" applies to a vnic \(a VM's virtual NIC, a hypervisor's host interface\); "lo0" is a loopback interface/);
  assert.match(one(rep('    interfaces: [eno1, eno2, eno3]\n', '    interfaces: [eno1, eno2, {id: eno3, port_group: v10}]\n')), /unknown key "port_group"/);
  // a VM may be a virtual router (Supports Layer 3, as a Layer 3 switch)
  const r = ok(rep(VM1, VM1 + '    layer3: true\n'));
  assert.equal(r.index.devices.get('vm1').layer3, true);
  assert.match(one(rep('  - id: ch\n    type: server\n', '  - id: ch\n    type: server\n    layer3: true\n')), /layer3 is for switches and VMs/);
});

test('the Container engine: networks of every driver, what each needs; bridge interface; IPAM range', () => {
  const svc = (t) => errs(t).filter((e) => /container_engine/.test(e));
  assert.deepEqual(svc(rep('{name: bridge, driver: bridge, interface: docker0, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true, range: 172.17.0.100-172.17.0.110}', '{name: bridge, driver: bridge}')), [
    'devices.ch.services.container_engine.networks[0].interface: container network "bridge" of "ch" needs its bridge interface (the interface it creates on the host, e.g. docker0)',
    'devices.ch.services.container_engine.networks[0].subnet: container network "bridge" of "ch" needs its subnet (e.g. 172.17.0.0/16)',
    'devices.ch.services.container_engine.networks[0].gateway: container network "bridge" of "ch" needs its gateway (the bridge interface’s address on the host, e.g. 172.17.0.1)',
    'devices.ch.services.container_engine.networks[0].nat: container network "bridge" of "ch" needs its NAT setting (nat: true to masquerade to the host’s address, false to route)',
  ]);
  assert.deepEqual(svc(rep('{name: lan, driver: macvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}', '{name: lan, driver: macvlan}')).map((e) => e.replace(/^[^:]*\.(\w+): .*/, '$1')), ['subnet', 'gateway', 'parent', 'mode']);
  assert.match(errs(rep('driver: macvlan', 'driver: macvlan2'))[0], /"macvlan2" is not a network driver: use "bridge", "host", "macvlan", "ipvlan", "overlay", "none"/);
  assert.match(errs(rep('mode: bridge}', 'mode: l3}'))[0], /"l3" is not a macvlan mode: use "bridge", "private", "vepa", "passthru"/);
  assert.deepEqual(errs(rep('{name: lan, driver: macvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}', '{name: lan, driver: ipvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: l3}')), []);
  assert.match(errs(rep('{name: host, driver: host}', '{name: host, driver: host, subnet: 10.0.0.0/8}'))[0], /a host network has no "subnet" \(its containers use the host’s interfaces and addresses\)/);
  assert.match(errs(rep('{name: none, driver: none}', '{name: none, driver: none, gateway: 1.2.3.4}'))[0], /a none network has no "gateway" \(its containers have no network\)/);
  assert.match(errs(rep('parent: eth1', 'parent: eth7'))[0], /networks\[1\]\.parent: "ch" has no interface "eth7" — did you mean "eth0"\?/);
  assert.match(errs(rep('interface: docker0', 'interface: eth0'))[0], /"ch" already has an interface "eth0": the bridge network creates its own interface/);
  assert.match(errs(rep('gateway: 172.17.0.1', 'gateway: 172.18.0.1'))[0], /the gateway 172\.18\.0\.1 is not in the subnet 172\.17\.0\.0\/16/);
  assert.match(errs(rep('subnet: 172.17.0.0/16', 'subnet: 172.17.0.5/16'))[0], /"172\.17\.0\.5\/16" has host bits set: the subnet is 172\.17\.0\.0\/16/);
  assert.match(errs(rep('range: 172.17.0.100-172.17.0.110', 'range: 172.17.0.100-172.18.0.110'))[0], /is not inside the subnet 172\.17\.0\.0\/16/);
  // overlay: the other hosts that take part, each with an engine
  const ov = rep('{name: none, driver: none}', '{name: none, driver: none}\n          - {name: ov, driver: overlay, subnet: 10.0.9.0/24, hosts: [hv]}');
  assert.match(errs(ov)[0], /networks\[4\]\.hosts\[0\]: "hv" has no Container engine service/);
});

test('containers: their network on the host (or an overlay that lists it), addresses in the subnet, host and none networks, published ports', () => {
  const veth = (x) => rep('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: tcp}]}\n', x);
  assert.equal(one(veth('      - {id: eth0, type: veth, network: brdge, ip: 172.17.0.2}\n')), 'devices.c1.logical_interfaces[0].network: host "ch" has no container network "brdge" — did you mean "bridge"?');
  assert.match(one(veth('      - {id: eth0, type: veth, ip: 172.17.0.2}\n')), /veth "eth0" of "c1" needs its container network/);
  assert.equal(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.18.0.2}\n')), 'devices.c1.logical_interfaces[0].ip: 172.18.0.2 is not in the subnet 172.17.0.0/16 of container network "bridge"');
  assert.equal(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.1}\n')), 'devices.c1.logical_interfaces[0].ip: 172.17.0.1 is the gateway of container network "bridge" (the host\'s docker0): a container needs another address');
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2/24}\n')), /172\.17\.0\.2\/24 has another prefix length than the subnet 172\.17\.0\.0\/16/);
  assert.deepEqual(errs(veth('      - {id: eth0, type: veth, network: lan, ip: 10.10.0.70/24}\n')), []);
  assert.match(one(veth('      - {id: eth0, type: veth, network: host, ip: 10.20.0.9/24}\n')), /"host" is a host network: the container shares its host's interfaces and addresses — delete its own address/);
  assert.deepEqual(errs(veth('      - {id: eth0, type: veth, network: host}\n')), []);
  assert.match(one(veth('      - {id: eth0, type: veth, network: none, ip: 10.9.9.9/24}\n')), /"none" is a none network: the container has no network there/);
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ipv4: dhcp}\n')), /DHCP is modelled on macvlan networks only/);
  // published ports: a bridge network's, each host port and protocol once per host address
  assert.match(one(veth('      - {id: eth0, type: veth, network: lan, ip: 10.10.0.70/24, publish: [{host_port: 80, port: 80, protocol: tcp}]}\n')), /published ports are a bridge network's \(DNAT on the host\): "lan" is a macvlan network/);
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: tcp}]}\n      - {id: eth1, type: veth, network: bridge, ip: 172.17.0.3, publish: [{host_port: 8080, port: 81, protocol: tcp}]}\n')), /tcp\/8080 on every address of "ch" is already published by c1:eth0/);
  assert.deepEqual(errs(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: tcp}]}\n      - {id: eth1, type: veth, network: bridge, ip: 172.17.0.3, publish: [{host_port: 8080, port: 81, protocol: udp}]}\n')), [], 'another protocol');
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_ip: 10.99.0.1, host_port: 8080, port: 80, protocol: tcp}]}\n')), /10\.99\.0\.1 is not an address of host "ch"/);
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: sctp}]}\n')), /"sctp" is not a protocol for a published port: use tcp or udp/);
  assert.match(one(veth('      - {id: eth0, type: veth, network: bridge, ip: 172.17.0.2, publish: [{port: 80, protocol: tcp}]}\n')), /a published port needs its host port/);
  // an overlay network of another host that lists this one
  const m = ok(rep('{name: none, driver: none}', '{name: none, driver: none}\n          - {name: ov, driver: overlay, subnet: 10.0.9.0/24}').replace('  - id: ch\n', '  - id: ch2\n    type: server\n    services: {container_engine: {engine: docker, networks: [{name: ov2, driver: overlay, subnet: 10.0.8.0/24, hosts: [ch]}]}}\n  - id: ch\n').replace('network: bridge, ip: 172.17.0.2, publish: [{host_port: 8080, port: 80, protocol: tcp}]}', 'network: ov2, ip: 10.0.8.5}'));
  assert.equal(m.index.interfaces.get('c1:eth0').network, 'ov2');
});

test('the examples: the virtualization example is valid and uses every part; nothing is cabled to a guest', () => {
  const m = ok(example('virtualization.yaml'));
  const types = (t) => m.devices.filter((d) => d.type === t).map((d) => d.id);
  assert.deepEqual(types('vm'), ['web1', 'db1', 'tagger', 'k8s1', 'app1', 'vr1', 'lab1']);
  assert.deepEqual(types('container'), ['web', 'api', 'cache', 'metrics']);
  assert.deepEqual(m.devices.filter((d) => d.hypervisor).map((d) => [d.id, d.hypervisor.cluster]), [['hv1', 'prod'], ['hv2', 'prod']]);
  assert.equal(m.index.devices.get('vr1').layer3, true);
  assert.equal(m.index.interfaces.get('db1:eth0').passthrough, 'vmnic2');
  assert.equal(m.index.devices.get('metrics').host, 'k8s1');
  assert.ok(m.links.every((l) => !m.index.devices.get(l.a.device).host && !m.index.devices.get(l.b.device).host));
  // every example: no guest is cabled, every guest has its host
  for (const f of ['device-types.yaml', 'virtualization.yaml']) {
    const x = model(example(f));
    for (const d of x.devices) if (d.type === 'vm' || d.type === 'container') assert.ok(d.host && d.interfaces.length === 0, `${f}: ${d.id}`);
  }
});

// ------------------------------------------------------------ the checks

const findings = (t, id) => validate.loadModel(t).findings.filter((f) => f.check === id).map((f) => `${f.severity} ${f.message}`);

test('check vswitch-uplink-vlan: a port group VLAN the switch port at an uplink does not carry', () => {
  assert.deepEqual(findings(BASE, 'vswitch-uplink-vlan'), []);
  const f = findings(rep('{id: p2, vlans: [10, 20]}', '{id: p2, vlans: 20}'), 'vswitch-uplink-vlan');
  assert.deepEqual(f, [
    'error port group "trunk" of hv br0 (VLAN 10): sw:p2, the switch port at uplink eno2, doesn\'t carry it — its frames are dropped there',
    'error port group "v10" of hv br0 (VLAN 10): sw:p2, the switch port at uplink eno2, doesn\'t carry it — its frames are dropped there',
  ]);
  // located at the port group's VLANs, for the editor
  const r = validate.loadModel(rep('{id: p2, vlans: [10, 20]}', '{id: p2, vlans: 20}'));
  assert.deepEqual(r.findings.filter((x) => x.check === 'vswitch-uplink-vlan').map((x) => x.path), ['devices.hv.services.hypervisor.vswitches[0].port_groups[1].vlans', 'devices.hv.services.hypervisor.vswitches[0].port_groups[0].vlans']);
  // guest tagging and an internal switch say nothing; an uplink without a cable says nothing
  assert.deepEqual(findings(rep('  - {id: l2, a: "sw:p2", b: "hv:eno2"}\n', ''), 'vswitch-uplink-vlan'), []);
});

test('check vnic-network-vlan: a guest address in another VLAN than its port group’s (or its passthrough port’s)', () => {
  assert.deepEqual(findings(BASE, 'vnic-network-vlan'), []);
  assert.deepEqual(findings(rep('port_group: v10, ip: 10.10.0.21/24', 'port_group: v10, ip: 10.20.0.21/24'), 'vnic-network-vlan'), ['warning vm1:eth0 has 10.20.0.21 in network n20 (VLAN 20), but port group "v10" puts it in VLAN 10']);
  const pt = rep('      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}\n', '      - {id: eth0, type: vnic, passthrough: eno3, ip: 10.20.0.21/24}\n');
  assert.deepEqual(findings(pt, 'vnic-network-vlan'), ['warning vm1:eth0 has 10.20.0.21 in network n20 (VLAN 20), but its passthrough port hv:eno3 (at sw:p3) puts it in VLAN 10']);
  // a subinterface's VLAN must pass a trunk port group; guest tagging passes every VLAN
  const sub = (pg, a) => rep('      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}\n', `      - {id: eth0, type: vnic, port_group: ${pg}}\n      - {id: eth0.30, type: virtual, ip: ${a}}\n`).replace('\nnetworks:\n', '\nnetworks:\n  - {id: n30, cidr: 10.30.0.0/24, vlan: 30}\n');
  assert.deepEqual(findings(sub('trunk', '10.30.0.9/24'), 'vnic-network-vlan'), ['warning vm1:eth0.30 has 10.30.0.9 in network n30 (VLAN 30), which port group "trunk" doesn\'t carry (VLAN 10, 20)']);
  assert.deepEqual(findings(sub('vgt', '10.30.0.9/24'), 'vnic-network-vlan'), []);
});

test('check container-parent-vlan: a macvlan network in another VLAN than its parent', () => {
  // ch's eth1 is cabled to sw:p3 (an access port in VLAN 10); the macvlan network lan is 10.10.0.0/24 (VLAN 10)
  const cab = rep('  - {id: l3, a: "sw:p3", b: "hv:eno3"}\n', '  - {id: l3, a: "sw:p3", b: "ch:eth1"}\n');
  assert.deepEqual(findings(cab, 'container-parent-vlan'), []);
  const other = cab.replace('{name: lan, driver: macvlan, parent: eth1, subnet: 10.10.0.0/24, gateway: 10.10.0.1, mode: bridge}', '{name: lan, driver: macvlan, parent: eth1, subnet: 10.20.0.0/24, gateway: 10.20.0.1, mode: bridge}').replace('{id: eth0, ip: 10.20.0.50/24}', '{id: eth0, ip: 10.99.0.50/24}');
  assert.deepEqual(findings(other, 'container-parent-vlan'), ['warning container network "lan" of ch: its subnet 10.20.0.0/24 is in network n20 (VLAN 20), but its parent eth1 (at sw:p3) is in VLAN 10']);
});

test('check ha-restart-portgroup and hypervisor-overcommit (info)', () => {
  const cl = (x) => rep('        platform: kvm\n', '        platform: kvm\n        cluster: ha1\n' + x);
  const second = '  - {id: hv2, type: server, services: {hypervisor: {platform: kvm, cluster: ha1, vswitches: [{name: br0, type: linux_bridge, port_groups: [{name: other, vlans: 10}]}]}}}\n';
  const t = cl('').replace('  - id: vm1\n', second + '  - id: vm1\n');
  assert.deepEqual(findings(t, 'ha-restart-portgroup'), ['warning vm1 can\'t restart on hv2 (cluster ha1): it has no port group "v10"']);
  assert.deepEqual(findings(t.replace('{name: other, vlans: 10}', '{name: v10, vlans: 10}'), 'ha-restart-portgroup'), []);
  // overcommit: only when both the inventory and the VMs' sizes are given
  assert.deepEqual(findings(cl('        cpu: 2\n'), 'hypervisor-overcommit'), [], 'no VM gives its vCPUs');
  assert.deepEqual(findings(cl('        cpu: 2\n        ram: 4G\n').replace(VM1, VM1 + '    vcpu: 6\n    ram: 6G\n'), 'hypervisor-overcommit'), [
    'info the VMs of hv have 6 GiB of memory, more than its 4G',
    'info the VMs of hv have 6 vCPUs, more than its 2 cores (overcommitted 3.0:1)',
  ]);
});

// ------------------------------------------------------------ related objects, selection, Find

test('related objects: a guest and its host, port group, virtual switch, container network, both ways', () => {
  const m = model(example('virtualization.yaml'));
  const rel = (r) => queries.relatedRefs(m, r);
  const has = (r, xs) => {
    const got = rel(r);
    for (const x of xs) assert.ok(got.has(x), `${r} → ${x}`);
  };
  has('device:web1', ['device:hv1', 'portgroup:hv1:Servers', 'vswitch:hv1:vSwitch0']);
  has('device:hv2', ['device:app1', 'device:vr1', 'device:lab1', 'vswitch:hv2:vSwitch1', 'portgroup:hv2:Lab']);
  has('portgroup:hv2:Lab', ['device:hv2', 'device:vr1', 'device:lab1', 'iface:vr1:eth1', 'vswitch:hv2:vSwitch1']);
  has('vswitch:hv1:vSwitch0', ['iface:hv1:vmnic0', 'iface:hv1:vmnic1', 'link:hv1-a', 'link:hv1-b', 'device:web1', 'iface:hv1:vmk0']);
  assert.ok(!rel('vswitch:hv1:vSwitch0').has('device:db1'), 'a passthrough VM is not on the virtual switch');
  has('iface:db1:eth0', ['iface:hv1:vmnic2', 'link:hv1-pt']);
  has('iface:hv1:vmnic2', ['iface:db1:eth0', 'device:db1']);
  has('cnet:ctr1:bridge', ['device:ctr1', 'iface:ctr1:docker0', 'device:web', 'device:api']);
  assert.ok(!rel('cnet:ctr1:bridge').has('device:cache'));
  has('device:metrics', ['device:k8s1', 'cnet:k8s1:bridge']);
  // the Objects list: a guest's host and a host's guests are related; a port group selects its host
  const ctx = queries.selectionContext(m, 'device:web1');
  assert.ok(ctx.related.has('device:hv1'));
  assert.ok(queries.selectionContext(m, 'device:hv2').related.has('device:lab1'));
  const pg = queries.selectionContext(m, 'portgroup:hv1:Apps');
  assert.deepEqual([pg.selected, Array.from(pg.related).sort()], ['device:hv1', ['device:k8s1']]);
  assert.ok(queries.refExists(m, 'vswitch:hv1:vSwitch0') && !queries.refExists(m, 'vswitch:hv1:vSwitch9') && queries.refExists(m, 'cnet:ctr1:lan'));
});

test('Find: guests by their host, port group and container network; virtual switches, port groups and container networks', () => {
  const m = model(example('virtualization.yaml'));
  const find = (q) => queries.search(m, q, 100).map((x) => x.ref);
  assert.deepEqual(find('on esx-02').sort(), ['device:app1', 'device:lab1', 'device:vr1']);
  assert.ok(['device:web1', 'device:db1', 'device:tagger', 'device:k8s1', 'vswitch:hv1:vSwitch0', 'portgroup:hv1:Servers'].every((r) => find('hv1').includes(r)));
  assert.deepEqual(find('Lab').filter((r) => !/^(network|route):/.test(r)).sort(), ['device:lab1', 'device:vr1', 'portgroup:hv1:Lab', 'portgroup:hv2:Lab']);
  assert.ok(find('docker0').includes('cnet:ctr1:bridge') && find('macvlan').includes('cnet:ctr1:lan'));
  const hit = queries.search(m, 'vSwitch1', 10).find((x) => x.ref === 'vswitch:hv2:vSwitch1');
  assert.deepEqual([hit.kind, hit.label], ['virtual switch', 'hv2 · vSwitch1']);
  // the helpers behind it
  assert.deepEqual(V.guestsOf(m, 'hv1').map((d) => d.id), ['web1', 'db1', 'tagger', 'k8s1']);
  assert.deepEqual(V.allGuestsOf(m, 'hv1').map((d) => d.id), ['web1', 'db1', 'tagger', 'k8s1', 'metrics']);
  assert.equal(V.machineOf(m, m.index.devices.get('metrics')).id, 'hv1');
  assert.deepEqual(V.clusterMembers(m, 'prod').map((d) => d.id), ['hv1', 'hv2']);
  assert.equal(V.portGroupText(V.portGroupOf(m.index.devices.get('hv1'), 'VGT').pg), 'Guest tagging (VGT)');
  assert.equal(V.vnicVlan(m, m.index.interfaces.get('app1:eth0')), 20);
  assert.equal(V.runsOnText(m, m.index.devices.get('app1')), 'runs on esx-02');
});

// ------------------------------------------------------------ editing

test('renaming a host updates its guests (and an overlay’s hosts); renaming a host port updates uplinks, parents and passthrough', () => {
  const d = doc(rep('{name: none, driver: none}', '{name: none, driver: none}\n          - {name: ov, driver: overlay, subnet: 10.0.9.0/24}').replace('  - id: ch\n', '  - id: ch2\n    type: server\n    services: {container_engine: {engine: docker, networks: [{name: ov2, driver: overlay, subnet: 10.0.8.0/24, hosts: [ch]}]}}\n  - id: ch\n'));
  assert.deepEqual(d.errors, []);
  const hv = d.findEntity('device', 'hv').index;
  assert.equal(d.renameEntity('device', hv, 'kvm-01'), 4, 'the guest’s host, and its three cables');
  assert.match(d.exportText(), /- id: vm1\n {4}type: vm\n {4}host: kvm-01\n/);
  const ch = d.findEntity('device', 'ch').index;
  d.renameEntity('device', ch, 'docker-01');
  assert.match(d.exportText(), /host: docker-01\n/);
  assert.match(d.exportText(), /hosts: \[docker-01\]/, 'an overlay network of another host lists it');
  assert.deepEqual(d.errors, []);
  // a host port: the uplink that names it
  const kvm = d.findEntity('device', 'kvm-01').index;
  d.renameInterface(['devices', kvm, 'interfaces', 0], 'enp1s0');
  assert.match(d.exportText(), /uplinks: \[enp1s0, eno2\]/);
  // a macvlan network's parent, and a passthrough port
  const dk = d.findEntity('device', 'docker-01').index;
  d.renameInterface(['devices', dk, 'interfaces', 1], 'enp2s0');
  assert.match(d.exportText(), /parent: enp2s0/);
  const pt = doc(rep('      - {id: eth0, type: vnic, port_group: v10, ip: 10.10.0.21/24}\n', '      - {id: eth0, type: vnic, passthrough: eno3, ip: 10.10.0.21/24}\n'));
  pt.renameInterface(['devices', pt.findEntity('device', 'hv').index, 'interfaces', 2], 'eno7');
  assert.match(pt.exportText(), /passthrough: eno7/);
  assert.deepEqual(pt.errors, []);
});

test('deleting a host or disabling its service: its guests are named; their references break and are reported, never removed', () => {
  const d = doc(BASE);
  assert.deepEqual(d.guestsOfHost('hv'), [{ index: 2, id: 'vm1', type: 'vm' }]);
  assert.deepEqual(d.guestsOfHost('ch'), [{ index: 4, id: 'c1', type: 'container' }]);
  assert.ok(d.references('device', 'hv').some((p) => p.join('.') === 'devices.2.host'), 'the delete confirmation counts it');
  d.deleteEntity('device', d.findEntity('device', 'hv').index);
  assert.match(d.exportText(), /host: hv\n/, 'the guest keeps its reference');
  assert.ok(d.errors.some((e) => /unknown host "hv"/.test(e.message)));
  d.undo();
  // disabling the Hypervisor: the guests stay, their host is reported
  d.setNetService(d.findEntity('device', 'hv').index, 'hypervisor', false);
  assert.ok(!/hypervisor:/.test(d.exportText()));
  assert.ok(d.errors.some((e) => /the host of VM "vm1" is a server with the Hypervisor service; "hv" has no Hypervisor service/.test(e.message)));
  assert.equal(d.canUndo(), 'Disable the Hypervisor');
  d.undo();
  assert.deepEqual(d.errors, []);
  // enabling one: empty, what it needs is reported (nothing is chosen)
  d.setNetService(d.findEntity('device', 'ch').index, 'hypervisor', true);
  assert.match(d.exportText(), /services:\n {6}hypervisor: \{\}\n {6}container_engine:/);
  assert.deepEqual(d.errors.map((e) => e.message).filter((m) => /Hypervisor/.test(m)), ['the Hypervisor service of "ch" needs its platform (kvm, esxi, hyperv, proxmox, xen, other)', 'the Hypervisor service of "ch" needs a virtual switch: add one (its name, type and port groups)']);
});

test('+ VM and + Container: a guest already assigned to its host, after its other guests, one undo step', () => {
  const d = doc(BASE);
  const hv = d.findEntity('device', 'hv').index;
  const i = d.addGuest(hv, 'vm');
  assert.equal(i, hv + 2, 'after the host and its VM');
  assert.equal(d.canUndo(), 'Add VM');
  assert.match(d.exportText(), /- \{id: vm2, type: vm, host: hv\}|- id: vm2\n {4}type: vm\n {4}host: hv\n/);
  // its network interface is the user's to add: nothing is chosen
  const k = d.addLogical(i, 'vnic', [], 'eth0');
  assert.match(d.exportText(), /- \{id: eth0, type: vnic\}/);
  assert.ok(d.errors.some((e) => /vnic "eth0" of "vm2" needs its port group/.test(e.message)));
  d.setText(['devices', i, 'logical_interfaces', k, 'port_group'], 'v10');
  assert.deepEqual(d.errors, []);
  const c = d.addGuest(d.findEntity('device', 'ch').index, 'container');
  assert.equal(d.text(['devices', c, 'host']), 'ch');
  assert.equal(d.text(['devices', c, 'type']), 'container');
});

test('editing the services: port group VLANs as on ports, guest tagging, NAT; key order; a container network’s next free address', () => {
  const d = doc(BASE);
  const hv = d.findEntity('device', 'hv').index;
  const pg = ['devices', hv, 'services', 'hypervisor', 'vswitches', 0, 'port_groups', 1];
  d.setPortVlans(pg, '20, 10 30');
  assert.match(d.exportText(), /\{name: trunk, vlans: \[10, 20, 30\], native: 10\}/);
  d.setGuestTagging(pg, true);
  assert.match(d.exportText(), /\{name: trunk, guest_tagging: true\}/, 'the VLANs and the native VLAN go in the same step');
  assert.equal(d.canUndo(), 'Guest tagging on');
  d.undo();
  // a new virtual switch and port group: in the format's key order
  d.addServiceItem(['devices', hv, 'services', 'hypervisor', 'vswitches'], 'virtual switch');
  d.setText(['devices', hv, 'services', 'hypervisor', 'vswitches', 1, 'type'], 'ovs');
  d.setText(['devices', hv, 'services', 'hypervisor', 'vswitches', 1, 'name'], 'br1');
  assert.match(d.exportText(), /- name: br1\n {12}type: ovs\n/);
  // NAT: yes, no, or not written
  const ch = d.findEntity('device', 'ch').index;
  const nat = ['devices', ch, 'services', 'container_engine', 'networks', 0, 'nat'];
  d.setYesNo(nat, 'false');
  assert.match(d.exportText(), /gateway: 172\.17\.0\.1\n {12}nat: false\n/);
  d.setYesNo(nat, '');
  assert.ok(d.errors.some((e) => /needs its NAT setting/.test(e.message)));
  // the next free address of a network: from its range, not one in use
  const m = model(BASE);
  const br = m.index.devices.get('ch').containerEngine.networks[0];
  assert.equal(H.nextFreeContainerAddr(m, br), '172.17.0.100');
  assert.equal(H.nextFreeContainerAddr(m, { subnet: '172.17.0.0/16', gateway: '172.17.0.1' }), '172.17.0.3', 'without a range: the subnet, past the gateway and c1');
  // a platform's MAC prefix
  const mac = H.generateMac(m, () => Uint8Array.from([7, 7, 7, 0xff, 2, 3]), undefined, H.platformOui('esxi').oui);
  assert.match(mac, /^00:50:56:3f:02:03$/i, 'VMware’s manual range');
  assert.equal(H.platformOui('kvm').name, 'KVM 52:54:00');
});

test('Connect: a guest is never cabled; its relations are made in the logical view', () => {
  const m = model(BASE);
  assert.match(C.endpointProblem(m, 'physical', { device: 'vm1' }), /“vm1” is a VM: a guest has no cables — cable its host \(“hv”\) instead/);
  assert.equal(C.endpointProblem(m, 'logical', { device: 'vm1', iface: 'eth0' }), '');
  assert.ok(!C.compatibleEndpoints(m, 'physical', { device: 'sw', iface: 'p3' }).some((e) => e.device === 'vm1' || e.device === 'c1'));
});
