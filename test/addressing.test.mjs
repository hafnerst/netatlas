// The Addressing overview (analysis/addressing.ts) and its table (ui/addressing.ts):
// VRF groups and the supernet tree, members and DHCP clients, gateways and
// virtual addresses, use, size, utilization (IPv4) and /64 counts (IPv6), free
// ranges and the next free address, duplicates, overlaps and addresses in no
// network; filter, sort and CSV; the Inspector's next-free choices.
// Everything must come out the same whatever the order of the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example, exampleNames } from './helpers.mjs';

const A = load('analysis/addressing.js');
const U = load('ui/addressing.js');
const I = load('analysis/ipmath.js');
const P = load('model/ip.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), [], 'valid');
  return r.model;
};

const base = `netatlas: 2
devices:
  - id: r1
    type: router
    protocols: {vrrp: {}}
    interfaces:
      - {id: e0, ip: [10.1.1.1/24, "2001:db8:1:1::1/64"], protocols: {vrrp: {group: 1, virtual_ip: 10.1.1.254}}}
      - {id: e1, ip: 10.1.2.1/24, vrf: red}
      - {id: e2, ip: 10.9.9.1/24}
      - {id: e3, ip: 10.1.0.5/16}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
  - id: r2
    type: router
    protocols: {vrrp: {}}
    interfaces:
      - {id: e0, ip: [10.1.1.2/24, "2001:db8:1:1::2/64"], protocols: {vrrp: {group: 1, virtual_ip: 10.1.1.254}}}
      - {id: e1, ip: 10.1.2.1/24, vrf: blue}
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 10}, {id: p2, vlans: 10}]
  - id: pc
    type: endpoint
    interfaces:
      - {id: eth0, ip: 10.1.1.50/24}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.1.1.254}
    dns_names:
      - {name: pc.example, interfaces: [eth0]}
  - id: laptop
    type: endpoint
    interfaces:
      - {id: wlan0, ipv4: dhcp}
links:
  - {id: l1, a: "r1:e0", b: "r2:e0"}
  - id: l2
    a: {device: sw, interface: p1}
    b: {device: laptop, interface: wlan0}
networks:
  - {id: site, cidr: 10.1.0.0/16, label: Site}
  - {id: users, cidr: 10.1.1.0/24, vlan: 10, label: Users}
  - {id: users6, cidr: "2001:db8:1:1::/64", vlan: 10}
  - {id: red-net, cidr: 10.1.2.0/24}
  - {id: empty, cidr: 192.0.2.0/30}
relations:
  - {id: vrrp-1, protocol: vrrp, endpoints: ["r1:e0", "r2:e0"], over: users}
`;

const net = (ov, vrf, id) => ov.vrfs.find((g) => g.vrf === vrf).networks.find((n) => n.id === id);

test('networks are grouped by the VRFs of their members (default table first) and nested by containing prefix', () => {
  const ov = A.addressingOverview(model(base));
  assert.deepEqual(ov.vrfs.map((g) => [g.vrf, g.name]), [['', 'the default table'], ['blue', 'VRF blue'], ['red', 'VRF red']]);
  const def = ov.vrfs[0].networks.map((n) => [n.id, n.depth, n.parent]);
  // the empty network (no member) is in the default table; the IPv6 one after the IPv4 ones
  assert.deepEqual(def, [['site', 0, null], ['users', 1, 'site'], ['empty', 0, null], ['users6', 0, null]]);
  // a network whose members are in two VRFs is listed in both, each with its own members
  assert.deepEqual(net(ov, 'red', 'red-net').members.map((u) => `${u.device}:${u.iface}`), ['r1:e1']);
  assert.deepEqual(net(ov, 'blue', 'red-net').members.map((u) => `${u.device}:${u.iface}`), ['r2:e1']);
  assert.deepEqual(net(ov, 'red', 'red-net').otherVrfs, ['blue']);
});

test('members: address, DNS names, loopback; DHCP clients on a cable carrying the network; members of nested networks counted, not repeated', () => {
  const ov = A.addressingOverview(model(base));
  const users = net(ov, '', 'users');
  assert.deepEqual(users.members.map((u) => [u.device, u.iface, u.address, u.text, u.dns]), [
    ['r1', 'e0', '10.1.1.1/24', '10.1.1.1', []],
    ['r2', 'e0', '10.1.1.2/24', '10.1.1.2', []],
    ['pc', 'eth0', '10.1.1.50/24', '10.1.1.50', ['pc.example']],
  ]);
  assert.deepEqual(users.dhcp.map((c) => [c.device, c.iface, c.link]), [['laptop', 'wlan0', 'l2']]);
  const site = net(ov, '', 'site');
  assert.deepEqual(site.members.map((u) => `${u.device}:${u.iface}`), ['r1:e3'], 'only the address no nested network holds');
  assert.equal(site.nestedUsed, 3);
  assert.equal(site.used, 5n, '10.1.0.5, the three in users and the VIP 10.1.1.254');
});

test('gateways: the virtual addresses of redundancy groups (once, with every member interface), and the next hop of default routes', () => {
  const ov = A.addressingOverview(model(base));
  const g = net(ov, '', 'users').gateways;
  assert.deepEqual(g.map((x) => [x.text, x.kind, x.source, x.refs]), [
    ['10.1.1.254', 'gateway', 'default route of pc', ['route:pc:0']],
    ['10.1.1.254', 'vip', 'VRRP group 1', ['iface:r1:e0', 'iface:r2:e0']],
  ]);
  // the supernet doesn't repeat them: they belong to the nested network (and still count as used there)
  assert.deepEqual(net(ov, '', 'site').gateways, []);
});

test('use, size and utilization: IPv4 as a percentage of the host addresses; IPv6 as the used count and the number of /64s', () => {
  const ov = A.addressingOverview(model(base));
  const users = net(ov, '', 'users');
  assert.deepEqual([users.used, users.size, users.percent, users.nets64], [4n, 254n, 1.6, null], 'r1, r2, pc and the VIP');
  assert.equal(U.utilText(users), '1.6 %');
  const v6 = net(ov, '', 'users6');
  assert.deepEqual([v6.used, v6.size, v6.percent, v6.nets64], [2n, 2n ** 64n, null, 1n]);
  assert.equal(U.utilText(v6), '1 × /64');
  assert.equal(A.countText(2n ** 64n), '2^64');
  assert.equal(A.countText(65536n), '65,536');
  const empty = net(ov, '', 'empty');
  assert.deepEqual([empty.used, empty.size, empty.percent, empty.nextFree], [0n, 2n, 0, '192.0.2.1/30']);
});

test('free ranges and the next free address: reserved addresses, used ones and nested networks excluded; IPv6 starts after the subnet-router anycast address', () => {
  const ov = A.addressingOverview(model(base));
  const users = net(ov, '', 'users');
  assert.deepEqual(users.free.map((r) => I.rangeText(r, 4)), ['10.1.1.3 – 10.1.1.49', '10.1.1.51 – 10.1.1.253']);
  assert.equal(users.nextFree, '10.1.1.3/24');
  // the supernet: the nested /24 is given away as a whole
  const site = net(ov, '', 'site');
  assert.deepEqual(site.free.map((r) => I.rangeText(r, 4)), ['10.1.0.1 – 10.1.0.4', '10.1.0.6 – 10.1.0.255', '10.1.2.0 – 10.1.255.254']);
  const v6 = net(ov, '', 'users6');
  assert.equal(v6.nextFree, '2001:db8:1:1::3/64');
  // a full network has none
  const full = A.addressingOverview(model(base.replace('{id: empty, cidr: 192.0.2.0/30}', '{id: empty, cidr: 10.9.9.1/32}'))).vrfs[0].networks.find((n) => n.id === 'empty');
  assert.deepEqual([full.free, full.nextFree], [[], null]);
  // ipmath: blocks
  const p = P.parsePrefix('10.0.0.0/29');
  assert.deepEqual(I.freeRanges(p, [3n + I.addrBig(p)], [{ first: I.addrBig(p) + 4n, last: I.addrBig(p) + 5n }]).map((r) => I.rangeText(r, 4)), ['10.0.0.1 – 10.0.0.2', '10.0.0.6']);
});

test('duplicates (per VRF), overlapping prefixes and addresses in no network', () => {
  const ov = A.addressingOverview(model(base));
  // 10.1.2.1 is on r1 (VRF red) and r2 (VRF blue): not a duplicate
  assert.deepEqual(ov.duplicates, []);
  // r1:e3 10.1.0.5/16 lies in site (/16): same size, fine
  assert.deepEqual(ov.overlaps, []);
  assert.deepEqual(ov.orphans.map((o) => [o.vrf, `${o.device}:${o.iface}`, o.address, o.loopback]), [['', 'r1:e2', '10.9.9.1/24', false], ['', 'r1:lo0', '10.255.0.1/32', true]]);
  const dup = A.addressingOverview(
    model(base.replace('{id: e0, ip: [10.1.1.2/24, "2001:db8:1:1::2/64"],', '{id: e0, ip: [10.1.1.1/24, "2001:db8:1:1::2/64"],').replace('{id: e3, ip: 10.1.0.5/16}', '{id: e3, ip: 10.1.1.9/16}').replace('{id: empty, cidr: 192.0.2.0/30}', '{id: empty, cidr: 10.1.2.0/24}')),
  );
  assert.deepEqual(dup.duplicates.map((d) => [d.vrf, d.text, d.owners.map((o) => `${o.device}:${o.iface}`)]), [['', '10.1.1.1', ['r1:e0', 'r2:e0']]]);
  assert.deepEqual(dup.overlaps.map((o) => [o.vrf, o.kind, o.message]), [
    ['', 'interface-subnet', 'r1:e3 10.1.1.9/16: its subnet 10.1.0.0/16 is larger than network users (10.1.1.0/24)'],
    ['blue', 'same-prefix', 'networks empty and red-net have the same prefix 10.1.2.0/24'],
    ['red', 'same-prefix', 'networks empty and red-net have the same prefix 10.1.2.0/24'],
  ]);
});

test('deterministic: the same overview whatever the order of devices, interfaces, networks and relations', () => {
  const reorder = (text) => {
    // reverse the list items of the top-level lists
    const parts = text.split(/\n(?=[a-z_]+:)/);
    return parts
      .map((p) => {
        const [head, ...rest] = p.split('\n');
        const items = rest.join('\n').split(/\n(?=  - )/);
        return rest.length && /^ {2}- /.test(rest[0]) ? head + '\n' + items.reverse().join('\n') : p;
      })
      .join('\n');
  };
  const a = A.addressingOverview(model(base));
  const b = A.addressingOverview(model(reorder(base) + '\n'));
  const strip = (ov) => JSON.stringify(ov, (k, v) => (typeof v === 'bigint' ? v.toString() : k === 'bytes' ? Array.from(v).join('.') : v));
  assert.equal(strip(b), strip(a));
});

test('filter and sort: matches keep the networks they are nested in (as context); other sorts are flat', () => {
  const ov = A.addressingOverview(model(base));
  const g = ov.vrfs[0];
  const st = U.newAddrViewState();
  st.filter = 'pc.example';
  assert.deepEqual(U.visibleRows(g, st).map((r) => [r.n.id, r.context]), [['site', true], ['users', false]]);
  st.filter = 'vlan 10';
  assert.deepEqual(U.visibleRows(g, st).map((r) => r.n.id), ['site', 'users', 'users6']);
  st.filter = '';
  st.sort = 'util';
  st.desc = true;
  assert.deepEqual(U.visibleRows(g, st).map((r) => r.n.id), ['users', 'site', 'empty', 'users6'], 'IPv6 has no percentage: last');
  st.sort = 'name';
  st.desc = false;
  assert.deepEqual(U.visibleRows(g, st).map((r) => r.n.label), ['empty', 'Site', 'Users', 'users6']);
  assert.match(U.shownText(ov, st), /^8 of 8 network listings shown, sorted by name\.$/);
});

test('CSV: one line per network and VRF, RFC 4180 quoting, CRLF, exact counts', () => {
  const csv = U.addressingCsv(A.addressingOverview(model(base)));
  const lines = csv.split('\r\n');
  assert.equal(lines[lines.length - 1], '', 'ends with CRLF');
  assert.equal(lines[0], 'vrf,prefix,vlan,name,network_id,nested_in,gateways,members,used,size,utilization,ipv6_64s,next_free,free_ranges');
  // site is listed in the default table and in the VRFs red and blue (it holds their addresses too)
  assert.equal(lines.length, 1 + 8 + 1);
  assert.match(lines[2], /^,10\.1\.1\.0\/24,10,Users,users,10\.1\.0\.0\/16,10\.1\.1\.254 \(gateway: default route of pc\); 10\.1\.1\.254 \(VIP: VRRP group 1\),r1:e0 10\.1\.1\.1\/24; r2:e0 10\.1\.1\.2\/24; pc:eth0 10\.1\.1\.50\/24; laptop:wlan0 dhcp,4,254,1\.6,,10\.1\.1\.3\/24,10\.1\.1\.3-10\.1\.1\.49; 10\.1\.1\.51-10\.1\.1\.253$/);
  assert.match(csv, /,2001:db8:1:1::\/64,10,users6,users6,,.*,2,18446744073709551616,,1,2001:db8:1:1::3\/64,/);
  const quoted = U.addressingCsv(A.addressingOverview(model(base.replace('label: Users}', 'label: "Users, floor 1 \\"A\\""}'))));
  assert.match(quoted, /,"Users, floor 1 ""A""",users,/);
});

test('the Inspector’s next free address: the networks of the interface’s VRF with a free address, those on its cable first', () => {
  const m = model(base);
  assert.deepEqual(A.nextFreeChoices(m, 'r1', 'e2').map((c) => [c.id, c.nextFree, c.suggested]), [['site', '10.1.0.1/16', false], ['users', '10.1.1.3/24', false], ['empty', '192.0.2.1/30', false], ['users6', '2001:db8:1:1::3/64', false]]);
  // pc's port: the networks its peer is in come first (here the cable to r1 is added)
  const cabled = model(base.replace('  - {id: l1, a: "r1:e0", b: "r2:e0"}', '  - {id: l1, a: "r1:e0", b: "r2:e0"}\n  - {id: l3, a: "r1:e2", b: "pc:eth0"}'));
  assert.deepEqual(A.nextFreeChoices(cabled, 'pc', 'eth0').map((c) => [c.id, c.suggested]).slice(0, 1), [['site', false]]);
  // the laptop's cable carries VLAN 10: users and users6 first
  assert.deepEqual(A.nextFreeChoices(m, 'laptop', 'wlan0').slice(0, 2).map((c) => [c.id, c.suggested]), [['users', true], ['users6', true]]);
  // in VRF red: the networks listed there
  assert.deepEqual(A.nextFreeChoices(m, 'r1', 'e1').map((c) => c.id), ['site', 'red-net']);
});

test('every example: the overview builds, every network is listed, and the CSV has a line per listing', () => {
  for (const f of exampleNames) {
    const r = validate.loadModel(example(f));
    if (!r.model) continue;
    const ov = A.addressingOverview(r.model);
    const listed = new Set();
    for (const g of ov.vrfs) for (const n of g.networks) listed.add(n.id);
    assert.deepEqual([...listed].sort(), r.model.networks.filter((n) => n.cidr).map((n) => n.id).sort(), f);
    const lines = U.addressingCsv(ov).split('\r\n').length - 2;
    assert.equal(lines, ov.vrfs.reduce((s, g) => s + g.networks.length, 0), f);
  }
});
