// "+ Port Range": creating a numbered range of physical interfaces in one
// step (editor/document.ts: portRange, planPortRange, addPortRange). The
// dialog that uses them is exercised in the browser self-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate } from './helpers.mjs';

const { ModelDoc, portRange, portIdFor, MAX_PORT_RANGE } = load('editor/document.js');
const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const names = (plan) => plan.ports.map((p) => p.name);
const base = `netatlas: 1
devices:
  - id: sw1
    interfaces:
      - {id: uplink}
      - {id: ge-1/3, label: Access 3}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.0.0.1/32}
      - {id: Vlan10, type: virtual, label: mgmt 7}
  - id: sw2
    interfaces: [ge-1/1]
`;

test('a range: the final number is the port number, everything before it is the prefix', () => {
  const p = portRange('ge 1/1', 'ge 1/24');
  assert.ok(p.ok);
  assert.equal(p.ports.length, 24);
  assert.deepEqual(names(p).slice(0, 3).concat(names(p).slice(-1)), ['ge 1/1', 'ge 1/2', 'ge 1/3', 'ge 1/24']);
  // other shapes of names
  assert.deepEqual(names(portRange('eth0', 'eth3')), ['eth0', 'eth1', 'eth2', 'eth3']);
  assert.deepEqual(names(portRange('Ethernet1/49', 'Ethernet1/52')), ['Ethernet1/49', 'Ethernet1/50', 'Ethernet1/51', 'Ethernet1/52']);
  assert.deepEqual(names(portRange('xe-0/0/9', 'xe-0/0/11')), ['xe-0/0/9', 'xe-0/0/10', 'xe-0/0/11'], 'only the last number counts');
  assert.deepEqual(names(portRange('7', '9')), ['7', '8', '9'], 'a bare number is a name too');
  assert.deepEqual(names(portRange('  p1 ', ' p2  ')), ['p1', 'p2'], 'surrounding spaces are not part of a name');
  // leading zeros keep their width
  assert.deepEqual(names(portRange('port08', 'port11')), ['port08', 'port09', 'port10', 'port11']);
  assert.deepEqual(names(portRange('p0', 'p2')), ['p0', 'p1', 'p2'], 'a single 0 is not padding');
  assert.deepEqual(names(portRange('p001', 'p003')), ['p001', 'p002', 'p003']);
  // the largest range that is allowed
  assert.equal(portRange('p1', 'p' + MAX_PORT_RANGE).ports.length, MAX_PORT_RANGE);
});

test('interface ids follow the model convention: a name that is not a valid id keeps its text as the label', () => {
  assert.equal(portIdFor('ge 1/1'), 'ge-1/1');
  assert.equal(portIdFor('ge-0/0/1'), 'ge-0/0/1');
  assert.equal(portIdFor('Gi 1 / 0 / 1'), 'Gi-1-/-0-/-1');
  const spaced = portRange('ge 1/1', 'ge 1/2').ports;
  assert.deepEqual(spaced, [{ name: 'ge 1/1', id: 'ge-1/1' }, { name: 'ge 1/2', id: 'ge-1/2' }]);
  const plain = portRange('ge-1/1', 'ge-1/2').ports;
  assert.deepEqual(plain, [{ name: 'ge-1/1', id: 'ge-1/1' }, { name: 'ge-1/2', id: 'ge-1/2' }]);
  // stable: the same input always gives the same ids, in order
  assert.deepEqual(portRange('ge 1/1', 'ge 1/24'), portRange('ge 1/1', 'ge 1/24'));
  assert.equal(new Set(portRange('ge 1/1', 'ge 1/24').ports.map((p) => p.id)).size, 24);
});

test('invalid ranges are rejected with a clear reason', () => {
  const err = (a, b) => {
    const p = portRange(a, b);
    assert.equal(p.ok, false, `${a} … ${b}`);
    assert.ok(!('ports' in p));
    return p.error;
  };
  assert.match(err('', ''), /Enter the first and the last port name/);
  assert.match(err('ge 1/1', ''), /Enter the first and the last port name/);
  // missing numeric suffix
  assert.equal(err('uplink', 'ge 1/24'), '“uplink” does not end in a port number (e.g. ge 1/1).');
  assert.equal(err('ge 1/1', 'ge 1/x'), '“ge 1/x” does not end in a port number (e.g. ge 1/24).');
  assert.match(err('ge 1/1a', 'ge 1/24a'), /does not end in a port number/);
  // different prefixes (exact match: case, spaces and separators count)
  assert.equal(err('ge 1/1', 'ge 2/24'), 'The part before the port number must be the same in both names: “ge 1/” and “ge 2/” differ.');
  assert.match(err('ge 1/1', 'Ge 1/24'), /must be the same in both names/);
  assert.match(err('ge 1/1', 'ge1/24'), /must be the same in both names/);
  assert.match(err('eth1', 'eth-4'), /must be the same in both names/);
  // the first number must be lower than the last
  assert.equal(err('ge 1/24', 'ge 1/1'), 'The first port number (24) must be lower than the last (1).');
  assert.equal(err('ge 1/5', 'ge 1/5'), 'The first port number (5) must be lower than the last (5).');
  // unreasonably large
  assert.equal(err('p1', 'p' + (MAX_PORT_RANGE + 1)), `This range has ${MAX_PORT_RANGE + 1} ports; one range can create at most ${MAX_PORT_RANGE}.`);
  assert.match(err('p1', 'p100000'), /This range has 100000 ports/);
  assert.match(err('p1', 'p99999999999999999999'), /The port number is too large/);
  // names that cannot become ids
  assert.match(err('/1', '/4'), /cannot be used as an interface name/);
  assert.match(err('a'.repeat(64) + '1', 'a'.repeat(64) + '2'), /cannot be used as an interface name: an id has 1–64 characters/);
});

test('duplicate detection: a name or id already on the device rejects the whole range', () => {
  const d = doc(base);
  const plan = (a, b) => d.planPortRange(0, a, b);
  assert.equal(plan('ge-1/1', 'ge-1/2').ok, true);
  // an existing id inside the range
  assert.equal(plan('ge-1/1', 'ge-1/8').error, 'Already on this device: ge-1/3. Nothing is created.');
  // a name whose id would collide (ge 1/3 -> ge-1/3)
  assert.equal(plan('ge 1/1', 'ge 1/8').error, 'Already on this device: ge 1/3. Nothing is created.');
  // a name that is the label of an existing interface, physical or logical
  assert.equal(plan('Access 1', 'Access 4').error, 'Already on this device: Access 3. Nothing is created.');
  assert.equal(plan('mgmt 6', 'mgmt 9').error, 'Already on this device: mgmt 7. Nothing is created.');
  // ids are one namespace across physical and logical interfaces
  assert.equal(plan('lo0', 'lo2').error, 'Already on this device: lo0. Nothing is created.');
  assert.equal(plan('Vlan9', 'Vlan11').error, 'Already on this device: Vlan10. Nothing is created.');
  // many collisions are summarized
  const again = doc(base);
  again.addPortRange(0, 'p1', 'p10');
  assert.equal(again.planPortRange(0, 'p1', 'p10').error, 'Already on this device: p1, p2, p3, p4 and 6 more. Nothing is created.');
  // another device's interfaces do not count
  assert.equal(d.planPortRange(1, 'ge-1/2', 'ge-1/8').ok, true);
  assert.equal(d.planPortRange(1, 'ge-1/1', 'ge-1/8').error, 'Already on this device: ge-1/1. Nothing is created.');
  // the device's total stays within the format's limit
  const full = doc(base);
  assert.ok(full.addPortRange(0, 'a1', 'a256').ok);
  assert.ok(full.addPortRange(0, 'b1', 'b252').ok);
  assert.equal(full.interfaceEntries(0).length, 512);
  assert.equal(full.planPortRange(0, 'c1', 'c2').error, 'The device would have 514 interfaces; the limit is 512.');
  assert.ok(full.valid);
});

test('creating a range: physical interfaces only, all or nothing, one undo step', () => {
  const d = doc(base);
  const before = d.exportText();
  // nothing at all happens for an invalid range: no partial range, no undo step, not dirty
  for (const [a, b] of [['ge 1/1', 'ge 1/8'], ['ge 1/9', 'ge 1/1'], ['x', 'y'], ['ge 1/1', 'ge 2/4'], ['p1', 'p9999']]) {
    const r = d.addPortRange(0, a, b);
    assert.equal(r.ok, false, `${a} … ${b}`);
    assert.equal(d.exportText(), before);
    assert.equal(d.canUndo(), null);
    assert.equal(d.dirty, false);
  }
  const r = d.addPortRange(0, 'ge 1/4', 'ge 1/6');
  assert.ok(r.ok);
  assert.equal(d.canUndo(), 'Add 3 ports');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  // appended to the physical list, in order; ids and (because of the space) labels; nothing else
  assert.match(
    d.exportText(),
    /    interfaces:\n      - \{id: uplink\}\n      - \{id: ge-1\/3, label: Access 3\}\n      - \{id: ge-1\/4, label: ge 1\/4\}\n      - \{id: ge-1\/5, label: ge 1\/5\}\n      - \{id: ge-1\/6, label: ge 1\/6\}\n    logical_interfaces:/,
  );
  const dev = d.result.model.devices[0];
  const made = dev.interfaces.slice(2);
  assert.deepEqual(made.map((i) => [i.id, i.label, i.type, i.addresses, i.vrf, i.mac, i.members, i.vlan, i.description, i.attrs]), [
    ['ge-1/4', 'ge 1/4', 'physical', [], undefined, undefined, [], undefined, undefined, []],
    ['ge-1/5', 'ge 1/5', 'physical', [], undefined, undefined, [], undefined, undefined, []],
    ['ge-1/6', 'ge 1/6', 'physical', [], undefined, undefined, [], undefined, undefined, []],
  ]);
  assert.equal(dev.logical.length, 2, 'no logical interface is created');
  assert.equal(d.result.model.links.length, 0, 'no link is created');
  assert.ok(!d.root.entries.has('links') && !d.root.entries.has('networks'));
  // names that are valid ids need no label
  d.addPortRange(1, 'ge-1/2', 'ge-1/4');
  assert.match(d.exportText(), /    interfaces: \[ge-1\/1, \{id: ge-1\/2\}, \{id: ge-1\/3\}, \{id: ge-1\/4\}\]\n/, 'the existing entry and the list style are left as written');
  // one undo step per range; redo brings it back
  d.undo();
  assert.equal(d.result.model.devices[1].interfaces.length, 1);
  d.undo();
  assert.equal(d.exportText(), before);
  assert.equal(d.canUndo(), null);
  d.redo();
  assert.equal(d.result.model.devices[0].interfaces.length, 5);
  // the single-interface action is unchanged and takes the next free id
  assert.equal(d.addInterface(0), 5);
  assert.equal(d.text(['devices', 0, 'interfaces', 5, 'id']), 'eth0');
  assert.equal(d.canUndo(), 'Add interface');
});

test('a device without interfaces gets its list; the display order is alphabetical, the file order is the order of creation', () => {
  const d = doc('netatlas: 1\ndevices:\n  - id: sw\n    type: switch\n');
  assert.ok(d.addPortRange(0, 'ge 1/9', 'ge 1/11').ok);
  assert.ok(d.addPortRange(0, 'ge 1/1', 'ge 1/2').ok);
  assert.deepEqual(d.result.model.devices[0].interfaces.map((i) => i.id), ['ge-1/9', 'ge-1/10', 'ge-1/11', 'ge-1/1', 'ge-1/2']);
  const { sortedByName } = load('model/order.js');
  assert.deepEqual(sortedByName(d.interfaceEntries(0), (e) => e.id).map((e) => e.id), ['ge-1/1', 'ge-1/2', 'ge-1/9', 'ge-1/10', 'ge-1/11']);
  const panels = load('ui/panels.js');
  const scene = load('diagram/scene.js');
  const rows = scene.findAll(panels.detailsFor(d.result.model, 'device:sw'), (n) => n.tag === 'tr' && n.attrs['data-iface']).map((n) => n.attrs['data-iface']);
  assert.deepEqual(rows, ['ge-1/1', 'ge-1/2', 'ge-1/9', 'ge-1/10', 'ge-1/11']);
});

test('export -> reload: generated ports round-trip and can be used like any interface', () => {
  const d = doc(base);
  d.addPortRange(0, 'ge 1/4', 'ge 1/27');
  d.addPortRange(1, 'ge-1/2', 'ge-1/24');
  const out = d.exportText();
  const back = doc(out);
  assert.ok(back.valid, back.errors.map((e) => e.message).join('\n'));
  assert.equal(back.exportText(), out);
  const flat = (m) => m.devices.map((x) => x.interfaces.map((i) => [i.id, i.label, i.type]));
  assert.deepEqual(flat(back.result.model), flat(d.result.model));
  assert.equal(back.result.model.devices[0].interfaces.length, 2 + 24);
  assert.equal(back.result.model.devices[1].interfaces.length, 1 + 23);
  assert.equal(validate.loadModel(out).warnings.length, 0);
  // they are ordinary physical interfaces: they can be cabled and be member ports
  const cabled = doc(out + 'links:\n  - {id: l1, a: "sw1:ge-1/4", b: "sw2:ge-1/2"}\n');
  assert.ok(cabled.valid, cabled.errors.map((e) => e.message).join('\n'));
  // after a reload the same range is a duplicate
  assert.match(back.planPortRange(0, 'ge 1/4', 'ge 1/27').error, /^Already on this device: ge 1\/4, ge 1\/5, ge 1\/6, ge 1\/7 and 20 more\./);
});
