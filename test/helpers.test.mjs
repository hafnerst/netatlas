// The input helpers' suggestions (analysis/helpers.ts): MTUs (with the value
// derived from a tunnel's underlay and the overhead used), a generated MAC
// address (locally administered unicast, unique, in the model's style), the
// VRFs in use (sorted, counted) and names differing only in case, VLAN IDs,
// redundancy group numbers and virtual IPs, AS numbers, router IDs from
// loopbacks, interface names that follow a device's pattern, route prefixes
// and distances. They only suggest: nothing here changes the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const H = load('analysis/helpers.js');
const { ModelDoc } = load('editor/document.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const vals = (xs) => xs.map((x) => x.value);

test('MTU: 1500 and 9000 for a port; for a tunnel also 1476 (GRE), 1400, and its underlay’s MTU less the overhead, saying which overhead', () => {
  const cc = model(example('consistency-checks.yaml'));
  const e1 = cc.index.interfaces.get('r1:e1');
  assert.deepEqual(H.mtuSuggestions(cc, e1).map((s) => s.label), ['1500', '9000 (jumbo)']);
  // the value already set is not offered
  assert.deepEqual(vals(H.mtuSuggestions(cc, cc.index.interfaces.get('r1:e6'))), ['9000']);
  // r1:tun0: GRE over e6 (MTU 1500): 1476, the same as the GRE chip, with both reasons
  const t = H.mtuSuggestions(cc, cc.index.interfaces.get('r1:tun0'));
  assert.deepEqual(vals(t), ['1476', '1400', '9000']);
  assert.match(t[0].title, /The MTU of the underlay e6 \(1500\) less 24 bytes of encapsulation: GRE: 20 IP \+ 4 GRE/);
  // GRE over IPsec in the enterprise WAN: 1500 − (24 + 73)
  const wan = model(example('enterprise-wan.yaml'));
  const st = H.mtuSuggestions(wan, wan.index.interfaces.get('hq-rtr1:st0.10'));
  assert.equal(st[0].label, '1403 (underlay 1500 − 97)');
  assert.match(st[0].title, /GRE: 20 IP \+ 4 GRE \+ IPsec ESP tunnel mode/);
});

test('MAC: random, locally administered unicast (the bits), unique in the model, in the model’s style', () => {
  const seq = (...bytes) => {
    let k = 0;
    return (n) => Uint8Array.from(bytes.slice(k, (k += n)));
  };
  const cc = model(example('consistency-checks.yaml'));
  // the style: r1 writes 00:11:22:33:44:55 and r2 00-11-22-33-44-55: a tie goes to the colon
  assert.deepEqual(H.macStyleOf(cc), { sep: ':', upper: false });
  const mac = H.generateMac(cc, seq(0xff, 1, 2, 3, 4, 5));
  assert.equal(mac, 'fe:01:02:03:04:05', 'multicast bit cleared, locally administered bit set');
  for (let i = 0; i < 200; i++) {
    const m = H.generateMac(cc, (n) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
    const b0 = parseInt(m.slice(0, 2), 16);
    assert.equal(b0 & 1, 0, m + ' is unicast');
    assert.equal(b0 & 2, 2, m + ' is locally administered');
    assert.match(m, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  }
  // unique: a draw that hits an existing address is drawn again
  const one = model('netatlas: 2\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, mac: "02:00:00:00:00:01"}\n');
  assert.equal(H.generateMac(one, seq(0x02, 0, 0, 0, 0, 1, 0x02, 0, 0, 0, 0, 2)), '02:00:00:00:00:02');
  // the model's style: Cisco dots, upper-case hyphens
  const cisco = model('netatlas: 2\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, mac: 001c.73aa.0001}\n      - {id: e1, mac: 001c.73aa.0002}\n      - {id: e2, mac: "00:1c:73:aa:00:03"}\n');
  assert.equal(H.generateMac(cisco, seq(0x10, 0x20, 0x30, 0x40, 0x50, 0x60)), '1220.3040.5060');
  const up = model('netatlas: 2\ndevices:\n  - id: a\n    interfaces:\n      - {id: e0, mac: 00-1C-73-AA-00-01}\n');
  assert.equal(H.generateMac(up, seq(0xab, 0xcd, 0xef, 1, 2, 3)), 'AA-CD-EF-01-02-03');
  // a model without MAC addresses: colons, lower case
  assert.equal(H.formatMac([2, 0, 0x5e, 0, 0x53, 0xaf], H.macStyleOf(model('netatlas: 2\n'))), '02:00:5e:00:53:af');
  // the generated address is valid in the model
  const d = ModelDoc.fromText('netatlas: 2\ndevices:\n  - id: a\n    interfaces: [e0]\n', 'a.yaml', 'file').doc;
  d.setText(['devices', 0, 'interfaces', 0, 'mac'], H.generateMac(d.result.model, seq(1, 2, 3, 4, 5, 6)));
  assert.deepEqual(d.errors, []);
  assert.match(d.exportText(), /mac: "02:02:03:04:05:06"|mac: 02:02:03:04:05:06/);
});

test('VRF: the names in use, sorted with how often each is used; a name differing only in case is a probable typo (and a check)', () => {
  const text = `netatlas: 2
devices:
  - id: r
    type: router
    interfaces:
      - {id: a, ip: 10.0.0.1/24, vrf: red}
      - {id: b, ip: 10.0.1.1/24, vrf: blue}
      - {id: c, ip: 10.0.2.1/24, vrf: red}
      - {id: d, ip: 10.0.3.1/24, vrf: Red}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.0.0.254, vrf: red}
`;
  const m = model(text);
  assert.deepEqual(H.vrfChoices(m), [{ name: 'blue', count: 1 }, { name: 'Red', count: 1 }, { name: 'red', count: 3 }]);
  assert.deepEqual(H.vrfCaseVariants(m, 'RED'), ['Red', 'red']);
  assert.deepEqual(H.vrfCaseVariants(m, 'red'), ['Red']);
  assert.deepEqual(H.vrfCaseVariants(m, 'green'), []);
  const f = validate.loadModel(text).findings.filter((x) => x.check === 'vrf-name-case');
  assert.deepEqual(f.map((x) => x.message), ['VRF "Red" differs from "red" only in case: probably a typo (VRF names are compared exactly, so these are two VRFs)']);
});

test('VLANs, redundancy groups, AS numbers, router IDs: what the model already uses, and the next free value', () => {
  const wan = model(example('enterprise-wan.yaml'));
  assert.equal(H.nextFreeVlan(wan), 2);
  // (VLAN 1: the branch switches' ports are in the default VLAN)
  assert.deepEqual(vals(H.vlanSuggestions(wan)).slice(0, 5), ['2', '1', '5', '10', '20']);
  assert.match(H.vlanSuggestions(wan)[3].label, /^10 Users$/);
  // a VRRP group on hq-core2:Vlan10's segment: join hq-core1's group 10, or the next free number
  const core2 = wan.index.interfaces.get('hq-core2:Vlan10');
  const vrrp = wan.services.get('vrrp');
  const without = structuredClone(core2);
  without.services = [];
  assert.deepEqual(H.groupSuggestions(wan, without, vrrp).map((s) => s.label), ['10 (join hq-core1:Vlan10)', '1 (next free)']);
  assert.deepEqual(vals(H.virtualIpSuggestions(wan, without, vrrp)), ['10.10.10.1']);
  // the AS numbers in use (not the device's own)
  assert.deepEqual(H.asnSuggestions(wan, 'hq-rtr1').map((s) => s.label), ['1299 (isp2-pe)', '3320 (isp1-pe)', '65010 (hq-rtr2)']);
  // router ID: the device's loopbacks with an IPv4 address (not the one already written)
  assert.deepEqual(H.routerIdSuggestions(wan, 'hq-rtr1').map((s) => s.label), ['lo0 (10.255.0.1)']);
  assert.deepEqual(H.routerIdSuggestions(wan, 'hq-rtr1', 'lo0'), []);
  assert.deepEqual(H.routerIdSuggestions(wan, 'hq-fw'), []);
});

test('IS-IS NET from the router ID (or loopback); a BGP end’s peer AS from the other device', () => {
  const m = model(`netatlas: 2
devices:
  - id: r
    type: router
    router_id: lo0
    protocols: {ospf: {}}
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.255.0.1/32}]
  - {id: s, type: router, protocols: {bgp: {asn: 65002}}}
`);
  assert.deepEqual(H.netSuggestions(m, 'r').map((s) => [s.value, s.title]), [['49.0001.0102.5500.0001.00', 'Area 49.0001, system ID 0102.5500.0001 from 10.255.0.1 (each octet as three digits)']]);
  assert.deepEqual(H.netSuggestions(m, 's'), [], 'no loopback, no router ID: nothing is guessed');
  assert.deepEqual(vals(H.peerAsSuggestions(m, 's')), ['65002']);
  assert.deepEqual(H.peerAsSuggestions(m, 'r'), []);
  // the suggestion is a valid NET
  const S = load('model/services.js');
  assert.equal(S.paramProblem(S.builtinServices().get('isis').params.find((p) => p.key === 'net'), H.netSuggestions(m, 'r')[0].value), '');
});

test('interface names follow the device’s pattern; route prefixes and distances', () => {
  const wan = model(example('enterprise-wan.yaml'));
  assert.equal(H.nextInterfaceName(wan, 'hq-fw', 'physical'), 'eth5');
  assert.equal(H.nextInterfaceName(wan, 'hq-core1', 'physical'), 'Ethernet53');
  assert.equal(H.nextInterfaceName(wan, 'hq-core1', 'virtual'), 'Vlan21');
  assert.equal(H.nextInterfaceName(wan, 'hq-rtr1', 'loopback'), 'lo1');
  // no loopback on the device: the model's most used stem, from 0
  assert.equal(H.nextInterfaceName(wan, 'hq-fw', 'loopback'), 'lo0');
  assert.equal(H.nextInterfaceName(model('netatlas: 2\ndevices:\n  - {id: a}\n'), 'a', 'tunnel'), 'tun0');
  const br = model(example('branch-routing.yaml'));
  assert.deepEqual(vals(H.routePrefixSuggestions(br, 'br-rtr')), ['0.0.0.0/0']);
  assert.deepEqual(vals(H.routePrefixSuggestions(model(example('addressing.yaml')), 'core')), ['0.0.0.0/0', '::/0']);
  assert.deepEqual(vals(H.distanceSuggestions()), ['250']);
  assert.deepEqual(H.distanceSuggestions('250'), []);
});

test('a helper applied in the editor is one undo step and is validated like typing', () => {
  const d = ModelDoc.fromText(example('enterprise-wan.yaml'), 'w.yaml', 'file').doc;
  const before = d.exportText();
  const dev = d.findEntity('device', 'hq-fw').index;
  d.setInteger(['devices', dev, 'interfaces', 0, 'mtu'], '1500');
  assert.equal(d.canUndo(), 'Edit mtu');
  d.undo();
  assert.equal(d.exportText(), before);
  // a generated MAC changes only that field
  d.setText(['devices', dev, 'interfaces', 0, 'mac'], H.generateMac(d.result.model, () => Uint8Array.from([0x02, 1, 2, 3, 4, 5])));
  // (the box grows by a line, so the positions shown are written to the layout section: nothing moves)
  const body = (t) => t.replace(/\nlayout:\n[\s\S]*$/, '\n').split('\n');
  const after = body(d.exportText());
  assert.deepEqual(after.filter((l, i) => l !== body(before)[i] && l !== ''), ['      - {id: eth1, vlans: 5, mac: 02:01:02:03:04:05}']);
  assert.deepEqual(d.errors, []);
});
