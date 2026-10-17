// The consistency-check framework and the checks beyond routes and VLANs:
// each check has a stable id, a severity, the fields it reads, and is tested
// here positive (it finds the mistake) and negative (it stays silent on a
// consistent model and where the values it compares are missing). Also the
// promoted fields (mtu, min_links, router_id, per-end speed/duplex; the AS
// number and the VRRP groups are protocol parameters, see protocols.test.mjs)
// and the model's `checks:` section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, scene, state, panels, load, example } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const C = load('analysis/checks.js');
const M = load('analysis/checks-more.js');
const A = load('model/addresses.js');
const S = load('model/services.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const errorsOf = (text) => validate.loadModel(text).errors.map((e) => e.message);
const found = (text, id) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), [], 'the format is valid');
  return r.findings.filter((f) => f.check === id);
};

// a consistent model: every check is silent on it
const base = `netatlas: 2
devices:
  - id: r1
    type: router
    router_id: 10.255.0.1
    protocols:
      bfd: {}
      bgp: {asn: 65001}
      ospf: {}
      vrrp: {}
    interfaces:
      - {id: e0, ip: 10.0.12.1/30, mtu: 1500, mac: "00:00:00:00:00:01", protocols: {vrrp: {group: 12, virtual_ip: 10.0.12.3}}}
      - {id: e1, ip: 10.0.13.1/30, mtu: 1500}
      - e3
      - e4
      - {id: e7, ip: 10.0.17.1/30, vrf: red}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
      - {id: Po1, type: virtual, members: [e3, e4], min_links: 1}
      - {id: tun0, type: tunnel, ip: 172.16.0.1/30, mtu: 1400, source: e1, destination: 10.0.13.2}
  - id: r2
    type: router
    router_id: 10.255.0.2
    protocols:
      bfd: {}
      bgp: {asn: 65001}
      ospf: {}
      vrrp: {}
    interfaces:
      - {id: e0, ip: 10.0.12.2/30, mtu: 1500, mac: "00:00:00:00:00:02", protocols: {vrrp: {group: 12, virtual_ip: 10.0.12.3}}}
      - e3
      - e4
      - {id: e7, ip: 10.0.17.2/30, vrf: red}
  - id: r3
    type: router
    protocols:
      bgp: {asn: 65003}
    interfaces:
      - {id: e0, ip: 10.0.13.2/30, mtu: 1500}
    logical_interfaces:
      - {id: tun0, type: tunnel, ip: 172.16.0.2/30, mtu: 1400, source: e0, destination: 10.0.13.1}
links:
  - id: l12
    a: {device: r1, interface: e0, speed: 10G, duplex: full}
    b: {device: r2, interface: e0, speed: 10G, duplex: full}
    speed: 10G
  - {id: l13, a: "r1:e1", b: "r3:e0", speed: 1G}
  - {id: la, a: "r1:e3", b: "r2:e3", speed: 10G}
  - {id: lb, a: "r1:e4", b: "r2:e4", speed: 10G}
  - {id: l7, a: "r1:e7", b: "r2:e7"}
networks:
  - {id: n12, cidr: 10.0.12.0/30}
relations:
  - id: ospf-12
    protocol: ospf
    endpoints: ["r1:e0", "r2:e0"]
    attrs:
      area: {r1: 0, r2: 0.0.0.0}
      network-type: {r1: point-to-point, r2: point_to_point}
      hello: {r1: 10, r2: 10s}
  - {id: ibgp-12, protocol: ibgp, endpoints: ["r1:lo0", r2]}
  - {id: ebgp-13, protocol: ebgp, endpoints: ["r1:e1", "r3:e0"], attrs: {peer-as: {r1: 65003, r3: 65001}}}
  - {id: vrrp-12, protocol: vrrp, endpoints: ["r1:e0", "r2:e0"], over: n12}
  - {id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: l13}
  - {id: bfd-7, protocol: bfd, endpoints: ["r1:e7", "r2:e7"]}
`;

test('a consistent model: no check finds anything; every check is registered with an id, a severity, a title and what it reads', () => {
  const r = validate.loadModel(base);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  assert.deepEqual(r.findings.map((f) => f.check + ': ' + f.message), []);
  const ids = C.CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const c of C.CHECKS) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)+$/, c.id);
    assert.ok(['error', 'warning', 'info'].includes(c.severity) && c.title && c.reads, c.id);
  }
  for (const id of ['link-mtu-mismatch', 'tunnel-mtu', 'link-speed-mismatch', 'link-duplex-mismatch', 'lag-member-speed', 'lag-peer-devices', 'lag-min-links', 'link-subnet-mismatch', 'address-reserved', 'vip-outside-subnet', 'duplicate-router-id', 'duplicate-mac', 'ospf-area-mismatch', 'ospf-network-type-mismatch', 'ospf-timer-mismatch', 'bgp-peer-as', 'bgp-session-type', 'tunnel-endpoint-mismatch', 'tunnel-underlay', 'relation-vrf-mismatch', 'protocol-not-enabled', 'protocol-unused', 'fhrp-group-mismatch']) {
    assert.ok(ids.includes(id), id);
  }
});

test('the promoted fields are validated: mtu, min_links, router_id, the BGP AS number, a port’s speed and duplex', () => {
  assert.match(errorsOf(base.replace('mtu: 1500, mac: "00:00:00:00:00:01"', 'mtu: 60, mac: "00:00:00:00:00:01"'))[0], /"60" is not a valid MTU: use a whole number from 68 to 65535/);
  assert.match(errorsOf(base.replace('min_links: 1', 'min_links: 0'))[0], /minimum number of links/);
  assert.match(errorsOf(base.replace('{id: lo0, type: loopback, ip: 10.255.0.1/32}', '{id: lo0, type: loopback, ip: 10.255.0.1/32, min_links: 1}'))[0], /"min_links" applies to a virtual interface only/);
  assert.match(errorsOf(base.replace('{id: Po1, type: virtual, members: [e3, e4], min_links: 1}', '{id: Po1, type: virtual, min_links: 1}'))[0], /"min_links" applies to an aggregate: "Po1" has no member ports/);
  assert.match(errorsOf(base.replace('router_id: 10.255.0.1', 'router_id: 10.255.0.1/32'))[0], /is not a router ID: write an IPv4 address \(e\.g\. 10\.255\.0\.1\) or the id of a loopback of "r1"/);
  assert.match(errorsOf(base.replace('router_id: 10.255.0.1', 'router_id: "2001:db8::1"'))[0], /is not a router ID/);
  assert.match(errorsOf(base.replace('asn: 65003', 'asn: 0'))[0], /Local AS number must be from 1 to 4294967295/);
  assert.match(errorsOf(base.replace('r2, interface: e0, speed: 10G, duplex: full}', 'r2, interface: e0, speed: 10G, duplex: fullish}'))[0], /unknown duplex "fullish": use "full", "half" or "auto"/);
  const m = validate.loadModel(base).model;
  assert.deepEqual([m.index.devices.get('r1').routerId, S.bgpAsn(m.index.devices.get('r1')), m.index.interfaces.get('r1:e0').mtu, m.index.interfaces.get('r1:Po1').minLinks], [{ text: '10.255.0.1', address: '10.255.0.1' }, 65001, 1500, 1]);
  assert.deepEqual([m.links[0].a.speed, m.links[0].a.duplex], ['10G', 'full']);
  // the file is written back exactly
  assert.equal(doc(base).exportText(), base);
});

test('the checks section: a check can be switched off or given another severity; unknown ids and values are errors', () => {
  const bad = base.replace('min_links: 1', 'min_links: 5');
  assert.equal(found(bad, 'lag-min-links')[0].severity, 'warning');
  assert.equal(found(bad + 'checks:\n  lag-min-links: error\n', 'lag-min-links')[0].severity, 'error');
  assert.equal(found(bad + 'checks:\n  lag-min-links: info\n', 'lag-min-links')[0].severity, 'info');
  assert.deepEqual(found(bad + 'checks:\n  lag-min-links: off\n', 'lag-min-links'), []);
  assert.deepEqual(Array.from(validate.loadModel(base + 'checks:\n  lag-min-links: off\n').model.checks), [['lag-min-links', 'off']]);
  assert.match(errorsOf(base + 'checks:\n  lag-min-link: off\n')[0], /unknown check "lag-min-link" — did you mean "lag-min-links"\?/);
  assert.match(errorsOf(base + 'checks:\n  lag-min-links: disabled\n')[0], /"disabled" is not a setting for a check: use "off", "error", "warning" or "info"/);
  // editing: one undo step; the default removes the entry, and an empty section goes
  const d = doc(base);
  d.setCheck('duplicate-mac', 'off');
  assert.match(d.exportText(), /\nchecks:\n {2}duplicate-mac: off\n/);
  assert.equal(d.checkSetting('duplicate-mac'), 'off');
  d.setCheck('duplicate-mac', '');
  assert.doesNotMatch(d.exportText(), /checks:/);
  d.undo();
  assert.match(d.exportText(), /duplicate-mac: off/);
});

test('link-mtu-mismatch', () => {
  assert.deepEqual(found(base, 'link-mtu-mismatch'), []);
  const f = found(base.replace('{id: e0, ip: 10.0.12.2/30, mtu: 1500', '{id: e0, ip: 10.0.12.2/30, mtu: 9000'), 'link-mtu-mismatch');
  assert.deepEqual(f.map((x) => [x.severity, x.message, x.path]), [['warning', 'link l12: MTU 1500 at r1:e0, 9000 at r2:e0', 'devices.r2.interfaces[0].mtu']]);
  // one end without an MTU: nothing is assumed
  assert.deepEqual(found(base.replace('{id: e0, ip: 10.0.12.2/30, mtu: 1500', '{id: e0, ip: 10.0.12.2/30'), 'link-mtu-mismatch'), []);
});

test('tunnel-mtu: the overhead of every encapsulation of the stack is added, and stated', () => {
  assert.deepEqual(found(base, 'tunnel-mtu'), []);
  const f = found(base.replace('{id: tun0, type: tunnel, ip: 172.16.0.1/30, mtu: 1400', '{id: tun0, type: tunnel, ip: 172.16.0.1/30, mtu: 1480'), 'tunnel-mtu');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /tunnel r1:tun0: MTU 1480 plus 24 bytes of encapsulation is 1504, more than the MTU 1500 of its underlay e1 \(assumed overhead: GRE: 20 IP \+ 4 GRE\); the largest MTU that fits is 1476/);
  // GRE over IPsec: both overheads count
  const stacked = base.replace('{id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: l13}', '{id: ipsec-13, protocol: ipsec, endpoints: ["r1:e1", "r3:e0"], over: l13}\n  - {id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: ipsec-13}');
  assert.deepEqual(found(stacked, 'tunnel-mtu').length, 0, '1400 + 24 + 73 = 1497 fits in 1500');
  assert.match(found(stacked.replace('mtu: 1400, source: e1', 'mtu: 1450, source: e1'), 'tunnel-mtu')[0].message, /plus 97 bytes .*GRE: 20 IP \+ 4 GRE; IPsec ESP tunnel mode/);
  // an unknown encapsulation or an underlay without an MTU: nothing is assumed
  assert.deepEqual(found(base.replace('protocol: gre, endpoints: ["r1:tun0"', 'protocol: mytunnel, category: tunnel, endpoints: ["r1:tun0"').replace('mtu: 1400, source: e1', 'mtu: 1499, source: e1'), 'tunnel-mtu'), []);
  assert.deepEqual(found(base.replace('{id: e1, ip: 10.0.13.1/30, mtu: 1500}', '{id: e1, ip: 10.0.13.1/30}').replace('mtu: 1400, source: e1', 'mtu: 1499, source: e1'), 'tunnel-mtu'), []);
});

test('link-speed-mismatch and link-duplex-mismatch', () => {
  assert.deepEqual(found(base, 'link-speed-mismatch').concat(found(base, 'link-duplex-mismatch')), []);
  assert.equal(M.speedBps('10G'), 1e10);
  assert.equal(M.speedBps('1000M'), M.speedBps('1G'));
  assert.deepEqual(found(base.replace('a: {device: r1, interface: e0, speed: 10G', 'a: {device: r1, interface: e0, speed: 10000M'), 'link-speed-mismatch'), [], '10000M is 10G');
  assert.match(found(base.replace('b: {device: r2, interface: e0, speed: 10G', 'b: {device: r2, interface: e0, speed: 1G'), 'link-speed-mismatch')[0].message, /the port at r1:e0 is set to 10G, the one at r2:e0 to 1G/);
  // one end against the cable
  assert.match(found(base.replace('a: {device: r1, interface: e0, speed: 10G', 'a: {device: r1, interface: e0, speed: 25G').replace('b: {device: r2, interface: e0, speed: 10G', 'b: {device: r2, interface: e0'), 'link-speed-mismatch')[0].message, /the port at r1:e0 is set to 25G, the cable to 10G/);
  const dup = found(base.replace('b: {device: r2, interface: e0, speed: 10G, duplex: full}', 'b: {device: r2, interface: e0, speed: 10G, duplex: auto}'), 'link-duplex-mismatch');
  assert.deepEqual(dup.map((x) => [x.severity, x.message]), [['error', 'link l12: duplex full at r1:e0, auto at r2:e0 (a port set to auto facing a fixed setting usually falls back to half duplex)']]);
});

test('lag-member-speed, lag-peer-devices (unless an MLAG pairs the peers) and lag-min-links', () => {
  for (const id of ['lag-member-speed', 'lag-peer-devices', 'lag-min-links']) assert.deepEqual(found(base, id), [], id);
  assert.match(found(base.replace('{id: lb, a: "r1:e4", b: "r2:e4", speed: 10G}', '{id: lb, a: "r1:e4", b: "r2:e4", speed: 1G}'), 'lag-member-speed')[0].message, /aggregate r1:Po1: its member links have different speeds \(e3 10G, e4 1G\)/);
  const split = base.replace('{id: lb, a: "r1:e4", b: "r2:e4", speed: 10G}', '{id: lb, a: "r1:e4", b: "r3:e4", speed: 10G}').replace('      - {id: e0, ip: 10.0.13.2/30, mtu: 1500}', '      - {id: e0, ip: 10.0.13.2/30, mtu: 1500}\n      - e4');
  assert.match(found(split, 'lag-peer-devices')[0].message, /aggregate r1:Po1: its member links end on 2 devices \(r2, r3\), and no MLAG relation pairs them/);
  // an MLAG (or vPC) domain of the two peers makes it a multi-chassis aggregate
  assert.deepEqual(found(split + '  - {id: mlag-23, protocol: vpc, endpoints: [r2, r3]}\n', 'lag-peer-devices'), []);
  assert.match(found(base.replace('min_links: 1', 'min_links: 3'), 'lag-min-links')[0].message, /needs 3 links up but has 2 cabled member ports: it can never be up/);
});

test('link-subnet-mismatch and address-reserved (network and broadcast addresses; not in a /31 or /32)', () => {
  assert.deepEqual(found(base, 'link-subnet-mismatch').concat(found(base, 'address-reserved')), []);
  assert.match(found(base.replace('{id: e0, ip: 10.0.13.2/30, mtu: 1500}', '{id: e0, ip: 10.0.31.2/30, mtu: 1500}').replace('destination: 10.0.13.2}', 'destination: 10.0.31.2}').replace('destination: 10.0.13.1}', 'destination: 10.0.13.1}'), 'link-subnet-mismatch')[0].message, /link l13: the IPv4 addresses at its ends are in different subnets \(r1:e1 10\.0\.13\.1\/30; r3:e0 10\.0\.31\.2\/30\)/);
  const net = found(base.replace('{id: e7, ip: 10.0.17.1/30, vrf: red}', '{id: e7, ip: 10.0.17.0/30, vrf: red}'), 'address-reserved');
  assert.match(net[0].message, /r1:e7: 10\.0\.17\.0\/30 is the network address of 10\.0\.17\.0\/30, not a host address/);
  assert.match(found(base.replace('{id: e7, ip: 10.0.17.1/30, vrf: red}', '{id: e7, ip: 10.0.17.3/30, vrf: red}'), 'address-reserved')[0].message, /broadcast address/);
  assert.deepEqual(found(base.replace('{id: e7, ip: 10.0.17.1/30, vrf: red}', '{id: e7, ip: 10.0.17.0/31, vrf: red}').replace('{id: e7, ip: 10.0.17.2/30, vrf: red}', '{id: e7, ip: 10.0.17.1/31, vrf: red}'), 'address-reserved'), [], 'a /31 has no network or broadcast address');
  // without a prefix length: judged by the networks containing it
  assert.match(found(base.replace('{id: e0, ip: 10.0.12.1/30', '{id: e0, ip: 10.0.12.0'), 'address-reserved')[0].message, /10\.0\.12\.0 is the network address of 10\.0\.12\.0\/30/);
});

test('vip-outside-subnet and fhrp-group-mismatch: a group’s virtual address in its interface’s subnet, one group number per address', () => {
  assert.deepEqual(found(base, 'vip-outside-subnet').concat(found(base, 'fhrp-group-mismatch')), []);
  const out = found(base.replace('protocols: {vrrp: {group: 12, virtual_ip: 10.0.12.3}}}', 'protocols: {vrrp: {group: 12, virtual_ip: 10.1.1.1}}}'), 'vip-outside-subnet');
  assert.deepEqual(out.map((f) => f.message), ['r1:e0: the VRRP virtual address 10.1.1.1 is not in a subnet of the interface (10.0.12.1/30)']);
  const grp = found(base.replace('protocols: {vrrp: {group: 12, virtual_ip: 10.0.12.3}}}\n      - e3\n      - e4\n      - {id: e7, ip: 10.0.17.2', 'protocols: {vrrp: {group: 13, virtual_ip: 10.0.12.3}}}\n      - e3\n      - e4\n      - {id: e7, ip: 10.0.17.2'), 'fhrp-group-mismatch');
  assert.deepEqual(grp.map((f) => f.message), ['VRRP 10.0.12.3: the members are in different groups (r1:e0 group 12, r2:e0 group 13); one virtual address needs one group']);
});

test('duplicate-router-id and duplicate-mac', () => {
  assert.deepEqual(found(base, 'duplicate-router-id').concat(found(base, 'duplicate-mac')), []);
  // per protocol domain: r1 and r2 are joined by BGP (ibgp-12) and by OSPF (ospf-12)
  assert.deepEqual(found(base.replace('router_id: 10.255.0.2', 'router_id: 10.255.0.1'), 'duplicate-router-id').map((f) => [f.severity, f.message]), [
    ['error', 'BGP router ID 10.255.0.1 is used by r1 and r2, in one BGP domain'],
    ['error', 'OSPF router ID 10.255.0.1 is used by r1 and r2, in one OSPF domain'],
  ]);
  const mac = found(base.replace('mac: "00:00:00:00:00:02"', 'mac: "0000.0000.0001"'), 'duplicate-mac');
  assert.deepEqual(mac.map((f) => [f.severity, f.message]), [['warning', 'MAC address 0000.0000.0001 is on r1:e0 and r2:e0']], 'compared without separators and case');
});

test('ospf-area-mismatch, ospf-network-type-mismatch, ospf-timer-mismatch: per-end values only', () => {
  for (const id of ['ospf-area-mismatch', 'ospf-network-type-mismatch', 'ospf-timer-mismatch']) assert.deepEqual(found(base, id), [], id + ' (0 = 0.0.0.0, point_to_point = point-to-point, 10 = 10s)');
  assert.equal(M.areaKey('0.0.0.10'), M.areaKey('10'));
  assert.match(found(base.replace('area: {r1: 0, r2: 0.0.0.0}', 'area: {r1: 0, r2: 0.0.0.1}'), 'ospf-area-mismatch')[0].message, /OSPF ospf-12: r1 is in area 0, r2 in area 0\.0\.0\.1/);
  assert.match(found(base.replace('network-type: {r1: point-to-point, r2: point_to_point}', 'network-type: {r1: point-to-point, r2: broadcast}'), 'ospf-network-type-mismatch')[0].message, /network type point-to-point at r1, broadcast at r2/);
  assert.match(found(base.replace('hello: {r1: 10, r2: 10s}', 'hello: {r1: 10, r2: 5}'), 'ospf-timer-mismatch')[0].message, /hello interval 10 at r1, 5 at r2/);
  assert.match(found(base.replace('hello: {r1: 10, r2: 10s}', 'dead: {r1: 40, r2: 30}'), 'ospf-timer-mismatch')[0].message, /dead interval 40 at r1, 30 at r2/);
  // one shared value says both ends agree; a value at one end only compares with nothing
  assert.deepEqual(found(base.replace('area: {r1: 0, r2: 0.0.0.0}', 'area: 0').replace('hello: {r1: 10, r2: 10s}', 'hello: {r1: 10}'), 'ospf-area-mismatch').concat(found(base.replace('hello: {r1: 10, r2: 10s}', 'hello: {r1: 10}'), 'ospf-timer-mismatch')), []);
});

test('bgp-peer-as and bgp-session-type', () => {
  assert.deepEqual(found(base, 'bgp-peer-as').concat(found(base, 'bgp-session-type')), []);
  assert.deepEqual(found(base.replace('peer-as: {r1: 65003, r3: 65001}', 'peer-as: {r1: 65004, r3: 65001}'), 'bgp-peer-as').map((f) => f.message), ['BGP ebgp-13: r1 expects r3 in AS 65004, but r3 is in AS 65003']);
  assert.match(found(base.replace('asn: 65003', 'asn: 65001').replace('peer-as: {r1: 65003, r3: 65001}', 'peer-as: {r1: 65001, r3: 65001}'), 'bgp-session-type')[0].message, /ebgp-13 is eBGP, but all its devices are in AS 65001/);
  assert.match(found(base.replace('bgp: {asn: 65001}\n      ospf: {}\n      vrrp: {}\n    interfaces:\n      - {id: e0, ip: 10.0.12.2', 'bgp: {asn: 65002}\n      ospf: {}\n      vrrp: {}\n    interfaces:\n      - {id: e0, ip: 10.0.12.2'), 'bgp-session-type')[0].message, /ibgp-12 is iBGP, but its devices are in different AS numbers \(r1 AS 65001, r2 AS 65002\)/);
});

test('tunnel-endpoint-mismatch and tunnel-underlay', () => {
  assert.deepEqual(found(base, 'tunnel-endpoint-mismatch').concat(found(base, 'tunnel-underlay')), []);
  assert.match(found(base.replace('source: e1, destination: 10.0.13.2}', 'source: e1, destination: 10.0.13.9}'), 'tunnel-endpoint-mismatch')[0].message, /the destination of r1:tun0 does not match its peer: 10\.0\.13\.9 is not the address r3:tun0 is sourced from \(10\.0\.13\.2\/30\)/);
  assert.match(found(base.replace('source: e1, destination: 10.0.13.2}', 'source: e1, destination: r2}'), 'tunnel-endpoint-mismatch')[0].message, /it names r2, but the tunnel's other end is on r3/);
  assert.match(found(base.replace('{id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: l13}', '{id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: l12}'), 'tunnel-underlay')[0].message, /tunnel gre-13: what it is carried over \(l12\) does not connect r1 with r3/);
  // a network in over connects its members
  assert.deepEqual(found(base.replace('{id: gre-13, protocol: gre, endpoints: ["r1:tun0", "r3:tun0"], over: l13}', '{id: gre-12, protocol: gre, endpoints: [r1, r2], over: n12}'), 'tunnel-underlay'), []);
});

test('relation-vrf-mismatch: only where both ends name a VRF', () => {
  assert.deepEqual(found(base, 'relation-vrf-mismatch'), []);
  assert.match(found(base.replace('{id: e7, ip: 10.0.17.2/30, vrf: red}', '{id: e7, ip: 10.0.17.2/30, vrf: blue}'), 'relation-vrf-mismatch')[0].message, /relation bfd-7 joins interfaces in different VRFs \(r1:e7 in VRF red, r2:e7 in VRF blue\)/);
  // a VRF interface facing one without (a provider edge facing a customer) is normal
  assert.deepEqual(found(base.replace('{id: e7, ip: 10.0.17.2/30, vrf: red}', '{id: e7, ip: 10.0.17.2/30}'), 'relation-vrf-mismatch'), []);
});

test('the demo example finds one of each check; every other example finds nothing', () => {
  const r = validate.loadModel(example('consistency-checks.yaml'));
  assert.deepEqual(r.errors, []);
  const ids = new Set(r.findings.map((f) => f.check));
  for (const c of C.CHECKS) assert.ok(ids.has(c.id), c.id);
  assert.equal(r.findings.find((f) => f.check === 'duplicate-mac').severity, 'info', 'its checks: section downgrades one check');
});

test('router ID and AS number are written in the device box (both views) and in the details', () => {
  const m = validate.loadModel(base).model;
  const d = m.index.devices.get('r1');
  assert.deepEqual(A.deviceOwnLines(d, m.services).map((x) => x.line), ['router-id 10.255.0.1', 'AS 65001']);
  assert.ok(A.addressInventory(m).some((a) => a.owner === 'device:r1' && a.field === 'router_id' && a.text === 'router-id 10.255.0.1'));
  const s = new state.Session(m);
  for (const view of ['physical', 'logical']) {
    s.setView(view);
    assert.match(scene.textOf(s.render().root), /router-id 10\.255\.0\.1/, view);
  }
  const det = scene.textOf(panels.detailsFor(m, 'device:r1'));
  assert.match(det, /protocols\nBFD, BGP, OSPF, VRRP/);
  assert.match(det, /identity\nrouter-id 10\.255\.0\.1/);
  assert.match(det, /identity\nAS 65001/);
  assert.match(scene.textOf(panels.detailsFor(m, 'iface:r1:e0')), /MTU\n1500/);
  assert.match(scene.textOf(panels.detailsFor(m, 'link:l12')), /10G, full duplex/);
});
