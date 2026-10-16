// Device types: the format allows exactly the 15 types below (or no type).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate, model, example, exampleNames, panels, scene } from './helpers.mjs';

const types = load('model/device-types.js');
const icons = load('diagram/icons.js');
const { defaultTier } = load('layout/input.js');
const { deviceSubtitle } = load('diagram/physical.js');

// the list as specified (display name -> YAML identifier)
const SPEC = [
  ['Router', 'router'],
  ['Switch', 'switch'],
  ['Firewall', 'firewall'],
  ['Access point', 'ap'],
  ['Load balancer', 'load_balancer'],
  ['IDS/IPS', 'ids_ips'],
  ['VPN Gateway', 'vpn_gateway'],
  ['Separation gateway', 'separation_gateway'],
  ['Server', 'server'],
  ['Virtual machine', 'vm'],
  ['Container', 'container'],
  ['Storage', 'storage'],
  ['Endpoint', 'endpoint'],
  ['Cloud', 'cloud'],
  ['System', 'system'],
];

// (a switch says what its port carries: its VLANs; a VM and a container are guests of a host that runs them, without ports of their own)
const HOSTS = {
  vm: '    host: h\n    logical_interfaces: [{id: eth0, type: vnic, port_group: pg}]\n  - {id: h, type: server, services: {hypervisor: {platform: kvm, vswitches: [{name: vs, type: linux_bridge, port_groups: [{name: pg, vlans: 1}]}]}}}\n',
  container: '    host: h\n    logical_interfaces: [{id: eth0, type: veth, network: n}]\n  - {id: h, type: server, services: {container_engine: {engine: docker, networks: [{name: n, driver: none}]}}}\n',
};
// (what a type needs to be complete: an inline IDS/IPS its port pairs, a VPN Gateway its VPN, a Separation gateway its policy, a System its purpose)
const NEEDS = {
  ids_ips: '    interfaces: [eth0, eth1]\n    port_pairs: [{a: eth0, b: eth1}]\n',
  vpn_gateway: '    services: {vpn: {operation: remote_access, technology: ipsec, listener: eth0, pool: 10.250.0.0/24, protected: [10.0.0.0/8]}}\n    interfaces: [{id: eth0, ip: 192.0.2.1/24}]\n',
  separation_gateway:
    '    services: {separation: {implementation: filtering_bridge, domains: [{name: Red, interfaces: [eth0]}, {name: Black, interfaces: [eth1]}], directions: [{from: Red, to: Black}]}}\n    interfaces: [eth0, eth1]\n',
  system: '    purpose: host\n    interfaces: [eth0]\n',
};
const withType = (type) =>
  `netatlas: 1\ndevices:\n  - id: d1\n${type === undefined ? '' : `    type: ${type}\n`}` + (HOSTS[type] || NEEDS[type] || `    interfaces: [${type === 'switch' ? '{id: eth0, vlans: 1}' : 'eth0'}]\n`);

test('the device types are exactly the specified 15, in order, with their display names', () => {
  assert.deepEqual(types.DEVICE_TYPES.map((t) => [t.label, t.id]), SPEC);
  for (const [label, id] of SPEC) assert.equal(types.deviceTypeLabel(id), label);
});

test('every type is accepted and has its own icon and a default tier', () => {
  const glyphs = new Set();
  for (const [, id] of SPEC) {
    const r = validate.loadModel(withType(id));
    assert.deepEqual(r.errors, [], id);
    assert.equal(r.model.devices[0].type, id);
    assert.equal(icons.iconName(id), id, `${id} has a glyph of its own`);
    glyphs.add(id);
    assert.ok(Number.isInteger(defaultTier(id)), id);
  }
  assert.equal(glyphs.size, 15);
  // tiers keep the physical view's top-to-bottom order
  assert.ok(defaultTier('cloud') < defaultTier('router') && defaultTier('router') < defaultTier('firewall'));
  assert.ok(defaultTier('firewall') < defaultTier('switch') && defaultTier('switch') < defaultTier('ap') && defaultTier('ap') < defaultTier('server'));
  assert.equal(defaultTier('ids_ips'), defaultTier('firewall'));
  assert.equal(defaultTier('separation_gateway'), defaultTier('firewall'));
  assert.equal(defaultTier('vpn_gateway'), defaultTier('router'));
  assert.equal(defaultTier('vm'), defaultTier('server'));
  // a passive sensor sits with the hosts; a role decides where it has one (an unknown custom role falls back)
  assert.equal(defaultTier('ids_ips', { mode: 'passive' }), defaultTier('server'));
  assert.equal(defaultTier('switch', { role: 'core' }), 3);
  assert.equal(defaultTier('switch', { role: 'my own role' }), defaultTier('switch'));
});

test('type is optional: no error, generic icon, the switch row, no type shown', () => {
  const r = validate.loadModel(withType(undefined));
  assert.deepEqual(r.errors, []);
  const d = r.model.devices[0];
  assert.equal(icons.iconName(d.type), 'generic');
  assert.equal(defaultTier(d.type), defaultTier('switch'));
  assert.equal(deviceSubtitle(d.type), '');
});

test('any other value is an error at the type, with a suggestion', () => {
  const cases = [
    ['l3switch', /unknown device type "l3switch" — did you mean "switch"\?/],
    ['Router', /unknown device type "Router" — did you mean "router"\?/],
    ['load-balancer', /did you mean "load_balancer"\?/],
    ['loadbalancer', /did you mean "load_balancer"\?/],
    ['ids', /unknown device type "ids"/],
    ['hypervisor', /unknown device type "hypervisor" \(a hypervisor is a server with the Hypervisor service: type: server, and services: hypervisor\)/],
    ['host', /unknown device type "host"/],
    ['leaf', /unknown device type "leaf"/],
    ['spine', /unknown device type "spine"/],
    ['generic', /unknown device type "generic"/],
    ['"x\\" onload=\\"y"', /unknown device type "x" onload="y"/],
  ];
  for (const [value, re] of cases) {
    const r = validate.loadModel(withType(value));
    assert.equal(r.errors.length, 1, value);
    const e = r.errors[0];
    assert.match(e.message, re);
    assert.equal(e.line, 4, 'located at the type line');
    assert.equal(e.path, 'devices.d1.type');
  }
  // without a close match the allowed values are listed
  const far = validate.loadModel(withType('mainframe')).errors[0].message;
  assert.match(far, /\(known: router, switch, firewall, ap, load_balancer, ids_ips, vpn_gateway, separation_gateway, server, vm, container, storage, endpoint, cloud, system\)/);
  // the removed types say what they became
  assert.match(validate.loadModel(withType('gateway')).errors[0].message, /unknown device type "gateway" \(.*vpn_gateway.*\)/);
  assert.match(validate.loadModel(withType('proxy')).errors[0].message, /unknown device type "proxy" \(an application proxy is a server, vm or container; a boundary between security domains is a separation_gateway\)/);
  // a draft with a wrong type still has a model to draw, with the generic icon
  const r = validate.loadModel(withType('hypervisor'));
  assert.ok(r.model);
  assert.equal(icons.iconName(r.model.devices[0].type), 'generic');
});

test('display names in subtitles, details, tooltips and the legend', () => {
  const m = model(withType('load_balancer'));
  assert.equal(deviceSubtitle('load_balancer'), 'Load balancer');
  const text = (v) => scene.textOf(v);
  assert.match(text(panels.detailsFor(m, 'device:d1')), /Load balancer/);
  assert.match(text(panels.legendFor(m, 'physical', new Set())), /Load balancer/);
});

test('the examples use only the allowed types', () => {
  for (const f of exampleNames) {
    for (const d of model(example(f)).devices) assert.ok(d.type === 'generic' || types.isDeviceType(d.type), `${f}: ${d.id} has type ${d.type}`);
  }
});
