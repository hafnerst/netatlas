// DHCP on physical and logical interfaces, and DNS names of a device.
// DHCP is an explicit flag (`dhcp: true`, omitted = false) that excludes
// manual addresses and is never treated as an address. A DNS name is entered
// once per device and associated with one or more of its interfaces (by id)
// that have DHCP off. Covers validation, the editing operations (confirmation
// data, one undo step, no dangling references), details and export -> reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, derive, panels, queries, scene, load } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const { dnsNameProblem, dnsNameKey } = load('model/dns.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const errors = (text) => validate.loadModel(text).errors.map((e) => e.message);
const warnings = (text) => validate.loadModel(text).warnings.map((e) => e.message);
const iface = (d, dev, id) => d.result.model.index.interfaces.get(dev + ':' + id);

const base = `netatlas: 1
devices:
  - id: web1
    type: server
    interfaces:
      - {id: eth0, label: Front, ip: [192.0.2.10/24, 2001:db8::10/64]}
      - {id: eth1, ip: 198.51.100.10/24}
      - eth2
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.10/32}
      - {id: bond0, type: virtual, members: [eth2], ip: 203.0.113.10/24}
    dns_names:
      - {name: www.example.com, interfaces: [eth0, bond0]}
      - {name: mgmt.example.net, interfaces: [eth1]}
  - id: web2
    type: server
    interfaces:
      - {id: eth0, dhcp: true}
    logical_interfaces:
      - {id: vlan20, type: virtual, dhcp: true}
networks:
  - {id: front, cidr: 192.0.2.0/24}
  - {id: mgmt, cidr: 198.51.100.0/24}
`;

// ------------------------------------------------------------------ DHCP

test('DHCP is off unless "dhcp: true" is written, also for an interface without addresses', () => {
  const r = validate.loadModel(base);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  const ix = r.model.index.interfaces;
  // eth2 has no address and no key: that is not DHCP
  assert.equal(ix.get('web1:eth2').dhcp, false);
  assert.deepEqual(ix.get('web1:eth2').addresses, []);
  assert.equal(ix.get('web1:eth0').dhcp, false);
  // both categories can have it
  assert.equal(ix.get('web2:eth0').dhcp, true);
  assert.equal(ix.get('web2:vlan20').dhcp, true);
  assert.equal(ix.get('web2:vlan20').type, 'virtual');
  // an explicit false is the same as leaving it out
  assert.equal(validate.loadModel(base.replace('{id: eth0, dhcp: true}', '{id: eth0, dhcp: false}')).model.index.interfaces.get('web2:eth0').dhcp, false);
  // only true/false is accepted
  assert.ok(errors(base.replace('{id: eth0, dhcp: true}', '{id: eth0, dhcp: auto}')).some((m) => /true or false|boolean/i.test(m)));
});

test('new physical and logical interfaces are created with DHCP off, and nothing is written for it', () => {
  const d = doc('netatlas: 1\ndevices:\n  - {id: r1}\n');
  d.addInterface(0);
  d.addLogical(0, 'virtual');
  d.addLogical(0, 'tunnel');
  d.addLoopback(0, ['10.0.0.1/32']);
  const dev = d.result.model.devices[0];
  for (const i of dev.interfaces.concat(dev.logical)) assert.equal(i.dhcp, false, i.id);
  assert.ok(!/dhcp/.test(d.exportText()));
  for (const e of d.interfaceEntries(0)) assert.equal(d.dhcpOn(e.path), false);
});

test('"dhcp: true" together with manual addresses is rejected; neither value is discarded', () => {
  for (const [from, to] of [
    ['{id: eth1, ip: 198.51.100.10/24}', '{id: eth1, dhcp: true, ip: 198.51.100.10/24}'],
    ['{id: bond0, type: virtual, members: [eth2], ip: 203.0.113.10/24}', '{id: bond0, type: virtual, dhcp: true, members: [eth2], ip: 203.0.113.10/24}'],
  ]) {
    const text = base.replace(from, to).replace(/\n      - \{name: mgmt[^\n]*|, bond0\]/g, (m) => (m.startsWith(',') ? ']' : ''));
    const r = validate.loadModel(text);
    const msg = r.errors.map((e) => e.message).filter((m) => /has "dhcp: true" and manually configured addresses/.test(m));
    assert.equal(msg.length, 1, r.errors.map((e) => e.message).join('\n'));
    // the error is attached to the addresses, both facts are still in the model and in the document
    const id = /eth1/.test(to) ? 'web1:eth1' : 'web1:bond0';
    const i = r.model.index.interfaces.get(id);
    assert.equal(i.dhcp, true);
    assert.equal(i.addresses.length, 1);
    const d = doc(text);
    assert.equal(d.exportText(), text);
  }
});

test('DHCP is not an address: such an interface is in no network, and "ip: dhcp" says what to write instead', () => {
  const m = validate.loadModel(base).model;
  assert.deepEqual(derive.interfaceAddresses(m, 'web2', 'eth0'), []);
  assert.ok(derive.networkMembers(m, 'front').every((x) => x.device !== 'web2'));
  assert.deepEqual(derive.deviceNetworks(m, 'web2'), []);
  const w = warnings(base.replace('{id: eth0, dhcp: true}', '{id: eth0, ip: dhcp}'));
  assert.ok(w.some((x) => /"dhcp" is not an address: .*set "dhcp: true"/.test(x)), w.join('\n'));
  assert.ok(errors(base.replace('{id: lo0, type: loopback, ip: 10.255.0.10/32}', '{id: lo0, type: loopback}')).some((x) => /needs at least one/.test(x)));
});

test('a loopback cannot use DHCP: "dhcp: true" on it is an error (kept, not dropped), and the editor never turns it on', () => {
  const lo = (entry) => base.replace('{id: lo0, type: loopback, ip: 10.255.0.10/32}', entry);
  // with or without an address, the flag itself is the error; the missing address is reported as for any loopback
  const alone = errors(lo('{id: lo0, type: loopback, dhcp: true}'));
  assert.ok(alone.some((x) => /loopback "lo0" cannot obtain its address by DHCP/.test(x)), alone.join('\n'));
  assert.ok(alone.some((x) => /needs at least one/.test(x)));
  const both = errors(lo('{id: lo0, type: loopback, dhcp: true, ip: 10.255.0.10/32}'));
  assert.deepEqual(both.filter((x) => /DHCP|dhcp/.test(x)).length, 1, both.join('\n'));
  assert.equal(validate.loadModel(lo('{id: lo0, type: loopback, dhcp: true, ip: 10.255.0.10/32}')).model.index.interfaces.get('web1:lo0').dhcp, true);
  // "dhcp: false" is harmless; "ip: dhcp" on a loopback doesn't suggest the flag
  assert.deepEqual(errors(lo('{id: lo0, type: loopback, dhcp: false, ip: 10.255.0.10/32}')), []);
  const word = errors(lo('{id: lo0, type: loopback, ip: dhcp}'));
  assert.ok(word.some((x) => /a loopback cannot obtain its address by DHCP: write its address/.test(x)) && !word.some((x) => /set "dhcp: true"/.test(x)), word.join('\n'));
  // editor: refused for a loopback (nothing changes, nothing to undo), allowed for every other kind
  const d = doc(base);
  const lp = ['devices', 0, 'logical_interfaces', 0];
  assert.equal(d.dhcpAllowed(lp), false);
  assert.equal(d.dhcpAllowed(['devices', 0, 'logical_interfaces', 1]), true);
  assert.equal(d.dhcpAllowed(['devices', 0, 'interfaces', 2]), true);
  const before = d.exportText();
  d.setDhcp(lp, true);
  assert.equal(d.exportText(), before);
  assert.equal(d.canUndo(), null);
  // a file that has it can be repaired by turning it off
  const bad = doc(lo('{id: lo0, type: loopback, dhcp: true, ip: 10.255.0.10/32}'));
  bad.setDhcp(lp, false);
  assert.ok(bad.valid, bad.errors.map((e) => e.message).join());
  assert.equal(bad.canUndo(), 'Turn DHCP off');
});

test('turning DHCP on lists what it deletes, then removes the addresses and sets the flag in one undo step (physical and logical)', () => {
  for (const [list, k, id, addrs] of [
    ['interfaces', 1, 'eth1', ['198.51.100.10/24']],
    ['logical_interfaces', 1, 'bond0', ['203.0.113.10/24']],
  ]) {
    const d = doc(base);
    const before = d.exportText();
    const p = ['devices', 0, list, k];
    const imp = d.dhcpImpact(p);
    assert.deepEqual(imp.addresses, addrs);
    // nothing is changed by asking
    assert.equal(d.exportText(), before);
    assert.equal(d.canUndo(), null);
    d.setDhcp(p, true);
    const i = iface(d, 'web1', id);
    assert.equal(i.dhcp, true);
    assert.deepEqual(i.addresses, []);
    assert.equal(d.get(p.concat('ip')), undefined);
    assert.equal(d.text(p.concat('dhcp')), 'true');
    assert.equal(d.canUndo(), 'Turn DHCP on');
    assert.ok(d.valid, d.errors.map((e) => e.message).join());
    d.undo();
    assert.equal(d.exportText(), before);
  }
});

test('turning DHCP off restores manual editing but not the deleted addresses', () => {
  const d = doc(base);
  const p = ['devices', 0, 'interfaces', 1];
  d.setDhcp(p, true);
  d.setDhcp(p, false);
  assert.equal(d.canUndo(), 'Turn DHCP off');
  const i = iface(d, 'web1', 'eth1');
  assert.equal(i.dhcp, false);
  assert.deepEqual(i.addresses, []);
  assert.equal(d.get(p.concat('dhcp')), undefined, 'false is the default: the key is removed');
  d.appendText(p.concat('ip'), '198.51.100.99/24');
  assert.deepEqual(iface(d, 'web1', 'eth1').addresses, ['198.51.100.99/24']);
  assert.ok(d.valid);
  // the short form "- eth2" becomes a mapping when DHCP is turned on, and off again
  d.setDhcp(['devices', 0, 'interfaces', 2], true);
  assert.match(d.exportText(), /- \{id: eth2, dhcp: true\}/);
  d.setDhcp(['devices', 0, 'interfaces', 2], false);
  assert.match(d.exportText(), /- \{id: eth2\}/);
});

// ------------------------------------------------------------- DNS names

test('DNS name syntax', () => {
  for (const ok of ['www.example.com', 'www.example.com.', 'router1', 'a-b.c-d.example', 'xn--bcher-kva.example', '1.example.com', 'A.EXAMPLE.ORG']) assert.equal(dnsNameProblem(ok), null, ok);
  for (const bad of ['', 'www..example.com', '.example.com', 'web_1.example.com', '-a.example', 'a-.example', 'with space.example', '192.0.2.1', 'a.' + 'b'.repeat(64), ('a'.repeat(60) + '.').repeat(5) + 'com']) {
    assert.ok(dnsNameProblem(bad), JSON.stringify(bad));
  }
  assert.equal(dnsNameKey('WWW.Example.com.'), dnsNameKey('www.example.com'));
});

test('a DNS name is entered once and associated with several interfaces, physical and logical, by id', () => {
  const m = validate.loadModel(base).model;
  const d = m.index.devices.get('web1');
  assert.deepEqual(d.dnsNames.map((x) => [x.name, x.interfaces]), [
    ['www.example.com', ['eth0', 'bond0']],
    ['mgmt.example.net', ['eth1']],
  ]);
  assert.deepEqual(m.index.devices.get('web2').dnsNames, []);
});

test('DNS names: invalid syntax, duplicates, unknown or DHCP interfaces and an empty association list are errors', () => {
  const at = (entry) => base.replace('      - {name: mgmt.example.net, interfaces: [eth1]}', '      - ' + entry);
  const cases = [
    ['{name: web_1.example.com, interfaces: [eth1]}', /invalid DNS name "web_1.example.com": .*letters, digits and hyphens/],
    ['{name: WWW.example.com., interfaces: [eth1]}', /DNS name "WWW.example.com." is listed twice on device "web1"/],
    ['{name: m.example.net, interfaces: [eth9]}', /device "web1" has no interface "eth9"/],
    ['{name: m.example.net, interfaces: []}', /associated with no interface/],
    ['{name: m.example.net}', /associated with no interface/],
    ['{interfaces: [eth1]}', /name/],
    ['{name: m.example.net, interfaces: [eth1, eth1]}', /"eth1" is listed twice for this DNS name/],
    ['{name: m.example.net, interfaces: [eth1], ttl: 300}', /ttl/],
  ];
  for (const [entry, re] of cases) {
    const e = errors(at(entry));
    assert.ok(e.some((x) => re.test(x)), entry + '\n' + e.join('\n'));
  }
  // a DHCP interface can't carry a DNS name
  const dh = base.replace('    logical_interfaces:\n      - {id: vlan20, type: virtual, dhcp: true}', '    logical_interfaces:\n      - {id: vlan20, type: virtual, dhcp: true}\n    dns_names:\n      - {name: web2.example.com, interfaces: [vlan20]}');
  assert.ok(errors(dh).some((x) => /"vlan20" obtains its address by DHCP, so a DNS name can't be associated with it/.test(x)), errors(dh).join('\n'));
  // the same name on two devices is allowed, with a warning
  const two = base.replace(
    '      - {id: vlan20, type: virtual, dhcp: true}\n',
    '      - {id: vlan20, type: virtual, dhcp: true}\n      - {id: lo0, type: loopback, ip: 10.255.0.20/32}\n    dns_names:\n      - {name: www.example.com, interfaces: [lo0]}\n',
  );
  assert.deepEqual(errors(two), []);
  assert.ok(warnings(two).some((x) => /"www.example.com" is also configured on device "web1"/.test(x)));
});

test('adding a DNS name: checked first, created in one step, only interfaces with DHCP off are eligible', () => {
  const d = doc(base);
  assert.deepEqual(d.dnsEligible(1).map((e) => e.id), []);
  assert.deepEqual(d.dnsEligible(0).map((e) => e.id), ['eth0', 'eth1', 'eth2', 'lo0', 'bond0']);
  assert.match(d.dnsNameError(0, '', ['eth0']), /Enter a DNS name/);
  assert.match(d.dnsNameError(0, 'bad_name.example', ['eth0']), /Not a valid DNS name/);
  assert.match(d.dnsNameError(0, 'WWW.EXAMPLE.COM', ['eth1']), /already has the DNS name/);
  assert.match(d.dnsNameError(0, 'api.example.com', []), /Select at least one interface/);
  assert.match(d.dnsNameError(1, 'web2.example.com', ['eth0']), /Not an interface with manual addressing on this device: eth0/);
  assert.equal(d.addDnsName(1, 'web2.example.com', ['eth0']), -1);
  assert.equal(d.canUndo(), null);
  const k = d.addDnsName(0, 'api.example.com', ['lo0', 'eth2', 'eth0']);
  assert.equal(k, 2);
  assert.equal(d.canUndo(), 'Add DNS name');
  assert.ok(d.valid);
  assert.deepEqual(d.result.model.devices[0].dnsNames[2].interfaces, ['lo0', 'eth2', 'eth0']);
  assert.match(d.exportText(), /- \{name: api\.example\.com, interfaces: \[lo0, eth2, eth0\]\}/);
  // a device without names gets the list after its interface lists
  const e = doc('netatlas: 1\ndevices:\n  - id: r1\n    interfaces: [ge0]\n    logical_interfaces:\n      - {id: lo0, type: loopback, ip: 10.0.0.1/32}\n    description: x\n');
  e.addDnsName(0, 'r1.example.com', ['ge0', 'lo0']);
  assert.match(e.exportText(), /logical_interfaces:\n.*\n    description: x\n    dns_names:\n      - \{name: r1\.example\.com, interfaces: \[ge0, lo0\]\}\n$/);
  // remove: the list goes with its last entry
  e.removeDnsName(0, 0);
  assert.ok(!/dns_names/.test(e.exportText()));
});

test('turning DHCP on removes the DNS-name associations of the interface in the same step; a name left without interfaces goes', () => {
  const d = doc(base);
  const before = d.exportText();
  // eth1 is the only interface of mgmt.example.net
  const imp = d.dhcpImpact(['devices', 0, 'interfaces', 1]);
  assert.deepEqual(imp.dns, [{ name: 'mgmt.example.net', removed: true }]);
  d.setDhcp(['devices', 0, 'interfaces', 1], true);
  assert.deepEqual(d.result.model.devices[0].dnsNames.map((x) => x.name), ['www.example.com']);
  // eth0 shares www.example.com with bond0
  assert.deepEqual(d.dhcpImpact(['devices', 0, 'interfaces', 0]), { addresses: ['192.0.2.10/24', '2001:db8::10/64'], dns: [{ name: 'www.example.com', removed: false }] });
  d.setDhcp(['devices', 0, 'interfaces', 0], true);
  assert.deepEqual(d.result.model.devices[0].dnsNames.map((x) => [x.name, x.interfaces]), [['www.example.com', ['bond0']]]);
  assert.ok(d.valid, d.errors.map((e) => e.message).join());
  // the last association: the list is removed rather than left empty
  d.setDhcp(['devices', 0, 'logical_interfaces', 1], true);
  assert.ok(!/dns_names/.test(d.exportText()));
  assert.ok(d.valid);
  // each was one step
  d.undo();
  d.undo();
  d.undo();
  assert.equal(d.exportText(), before);
});

test('deleting an associated interface removes its DNS associations with it (no dangling reference); renaming updates them', () => {
  const d = doc(base);
  const before = d.exportText();
  // used by: the DNS name is listed with the other references
  assert.deepEqual(d.references('device', 'web1', 'bond0'), [['devices', 0, 'dns_names', 0, 'interfaces', 1]]);
  d.deleteInterface(['devices', 0, 'logical_interfaces', 1]);
  assert.equal(d.canUndo(), 'Delete interface');
  assert.deepEqual(d.result.model.devices[0].dnsNames.map((x) => [x.name, x.interfaces]), [
    ['www.example.com', ['eth0']],
    ['mgmt.example.net', ['eth1']],
  ]);
  assert.ok(d.valid, d.errors.map((e) => e.message).join());
  d.deleteInterface(['devices', 0, 'interfaces', 1]);
  assert.deepEqual(d.result.model.devices[0].dnsNames.map((x) => x.name), ['www.example.com']);
  assert.ok(d.valid);
  d.undo();
  d.undo();
  assert.equal(d.exportText(), before);
  // rename: the association follows the interface id
  assert.equal(d.renameInterface(['devices', 0, 'interfaces', 0], 'ens3'), 1);
  assert.deepEqual(d.result.model.devices[0].dnsNames[0].interfaces, ['ens3', 'bond0']);
  assert.ok(d.valid);
  // another device's interface of the same name is not touched
  assert.deepEqual(d.references('device', 'web2', 'ens3'), []);
});

test('details, tooltips and search show DHCP and DNS names; the diagrams stay as they are', () => {
  const m = validate.loadModel(base).model;
  const dev = scene.textOf(panels.detailsFor(m, 'device:web1'));
  assert.match(dev, /DNS names \(2\)/);
  // one row per name (alphabetically), its interfaces sorted and linked
  assert.match(dev, /\nmgmt\.example\.net\neth1\nwww\.example\.com\nbond0\n, \neth0\n/);
  assert.match(dev, /no DNS record is derived/);
  const w2 = scene.textOf(panels.detailsFor(m, 'device:web2'));
  assert.match(w2, /\neth0\nDHCP\n/);
  assert.match(w2, /\nvlan20\nVirtual\nDHCP\n/);
  assert.ok(!/DNS names/.test(w2));
  const i = scene.textOf(panels.detailsFor(m, 'iface:web2:eth0'));
  assert.match(i, /obtained by DHCP \(not known, so in no network\)/);
  assert.match(scene.textOf(panels.detailsFor(m, 'iface:web1:bond0')), /DNS names\s*www\.example\.com/);
  assert.ok(panels.tooltipFor(m, 'iface:web1:eth0').includes('www.example.com'));
  assert.ok(panels.tooltipFor(m, 'iface:web2:eth0').includes('DHCP'));
  assert.deepEqual(queries.search(m, 'mgmt.example').map((h) => h.ref), ['device:web1']);
  // nothing about DNS names in the drawn diagrams
  const { Session } = load('diagram/session.js');
  for (const view of ['physical', 'logical']) {
    const s = new Session(m);
    s.setView(view);
    assert.ok(!/example\.(com|net)/.test(scene.textOf(s.render().root)), view);
  }
});

test('DHCP and DNS names survive export -> reload unchanged', () => {
  const d = doc(base);
  d.setDhcp(['devices', 0, 'interfaces', 1], true);
  d.addDnsName(0, 'api.example.com', ['eth2', 'lo0']);
  d.appendText(['devices', 0, 'dns_names', 0, 'interfaces'], 'eth2');
  const text = d.exportText();
  const back = doc(text);
  assert.ok(back.valid, back.errors.map((e) => e.message).join());
  assert.equal(back.exportText(), text);
  const strip = (m) => JSON.stringify(m.devices.map((x) => [x.id, x.dnsNames.map((n) => [n.name, n.interfaces]), x.interfaces.concat(x.logical).map((i) => [i.id, i.dhcp, i.addresses])]));
  assert.equal(strip(back.result.model), strip(d.result.model));
  assert.equal(iface(back, 'web1', 'eth1').dhcp, true);
  assert.deepEqual(back.result.model.devices[0].dnsNames.map((n) => [n.name, n.interfaces]), [
    ['www.example.com', ['eth0', 'bond0', 'eth2']],
    ['api.example.com', ['eth2', 'lo0']],
  ]);
});
