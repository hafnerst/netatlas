// DNS names in the logical view: each name once under its device, sized
// into the layout, hidden with Labels and with the device, and part of the
// logical export (with a legend entry only when names are drawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, scene, example } from './helpers.mjs';

const { Session } = load('diagram/session.js');
const { exportBoxes } = load('diagram/networks-box.js');
const { exportLegendSections } = load('diagram/legend.js');
const { dnsNameLines, dnsShown, dnsSize, DNS_LINE_CHARS, MAX_DNS } = load('layout/sizes.js');
const { logicalSpecs } = load('layout/logical.js');
const { layoutInput } = load('layout/input.js');

const LONG = 'a-rather-long-host-name.with-a-long-subdomain.example.com';
const net = `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces: [{id: e0, ip: 10.0.0.1/24}, {id: e1, ip: 10.0.1.1/24}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.9.9.1/32}]
    dns_names:
      - {name: r1.example.com, interfaces: [e0, e1, lo0]}
      - {name: ${LONG}, interfaces: [e0]}
      - {name: mgmt.example.com, interfaces: [lo0]}
  - id: r2
    type: router
    interfaces: [{id: e0, ip: 10.0.0.2/24}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.9.9.2/32}]
    dns_names:
      - {name: r2.example.com, interfaces: [e0]}
  - id: plain
    type: switch
    logical_interfaces: [{id: lo0, type: loopback, ip: 10.9.9.3/32}]
relations:
  - {id: ospf, protocol: ospf, endpoints: [{device: r1, interface: lo0}, {device: r2, interface: lo0}]}
`;

const chips = (root) => {
  const out = [];
  const walk = (n) => {
    if (/(^| )dns-chip( |$)/.test(n.attrs.class || '')) out.push({ ref: n.attrs['data-ref'], name: n.attrs['data-dns'], text: n.children.filter((c) => c.tag === 'text').map((c) => c.text).join('') });
    n.children.forEach(walk);
  };
  walk(root);
  return out;
};
const textOf = (root) => scene.textOf(root);

test('sizes: each name once, sorted, at most two, long names broken after a dot and never shortened', () => {
  assert.deepEqual(dnsShown(['b.x', 'a.x', 'b.x', 'c.x']), { names: ['a.x', 'b.x'], more: 1 });
  assert.equal(MAX_DNS, 2);
  const lines = dnsNameLines(LONG);
  assert.ok(lines.length >= 2 && lines.every((l) => l.length <= DNS_LINE_CHARS), lines.join(' | '));
  assert.equal(lines.join(''), LONG, 'nothing is cut off');
  assert.ok(lines.slice(0, -1).every((l) => l.endsWith('.')), 'broken after dots');
  const label = 'x'.repeat(70) + '.example';
  assert.equal(dnsNameLines(label).join(''), label);
  assert.ok(dnsNameLines(label).every((l) => l.length <= DNS_LINE_CHARS));
  assert.deepEqual(dnsNameLines('short.example'), ['short.example']);
  // rows: the lines of the shown names plus a "+N more" row
  assert.equal(dnsSize(['a.x', 'b.x', 'c.x']).rows, 3);
  assert.equal(dnsSize([]).rows, 0);
});

test('the logical view writes each name once under its device; the physical view has none', () => {
  const s = new Session(model(net));
  assert.equal(chips(s.render().root).length, 0, 'physical');
  s.setView('logical');
  const root = s.render().root;
  const c = chips(root);
  // r1: two of its three names (sorted), then "+1 more name"; r2: its one name
  assert.deepEqual(c.map((x) => `${x.ref}=${x.name}`), [`device:r1=${LONG}`, 'device:r1=mgmt.example.com', 'device:r2=r2.example.com']);
  assert.equal(c[0].text, LONG, 'a long name is written in full, over several lines');
  assert.match(textOf(root), /\+1 more name\b/);
  // r1.example.com (three interfaces) is the third name: counted in "+1 more", not written per interface
  assert.equal(textOf(root).split('r1.example.com').length - 1, 0);
  assert.equal(textOf(root).split('r2.example.com').length - 1, 1);
  // the node is sized for the names: r1's node is taller than plain's, whose only chip is a loopback
  const specs = logicalSpecs(layoutInput(s.model));
  const h = (id) => specs.find((x) => x.ref === 'device:' + id).h;
  assert.ok(h('r1') > h('plain') && h('r2') > h('plain'), `${h('r1')} ${h('r2')} ${h('plain')}`);
});

test('Labels off hides the names (nothing moves); a device left out by the filter takes its names along', () => {
  const s = new Session(model(net));
  s.setView('logical');
  const before = JSON.stringify(Array.from(s.positionsFor('logical')));
  s.state.showLabels = false;
  assert.equal(chips(s.render().root).length, 0);
  assert.equal(JSON.stringify(Array.from(s.positionsFor('logical'))), before);
  s.state.showLabels = true;
  s.setDevices(['r2', 'plain']);
  assert.deepEqual(chips(s.render().root).map((x) => x.name), ['r2.example.com']);
});

test('the logical export carries the names, and its legend lists them only when they are drawn', () => {
  const s = new Session(model(net));
  s.setView('logical');
  const sc = s.render();
  const boxes = exportBoxes(s.viewModel(), 'logical', s.state, sc);
  assert.match(textOf(boxes.legend.root), /DNS name \(as configured, not looked up\)/);
  assert.match(textOf(sc.root), /mgmt\.example\.com/);
  s.state.showLabels = false;
  const sc2 = s.render();
  assert.doesNotMatch(textOf(exportBoxes(s.viewModel(), 'logical', s.state, sc2).legend.root), /DNS name/);
  // the physical legend never has it
  const phys = exportLegendSections(s.model, 'physical', { hiddenProtocols: new Set(), showNetworks: true });
  assert.ok(!phys.some((sec) => sec.items.some((i) => /DNS name/.test(i.label))));
  // the example: hq-rtr1.acme.example belongs to two interfaces and is written once
  const w = new Session(model(example('enterprise-wan.yaml')));
  w.setView('logical');
  const t = textOf(w.render().root);
  assert.equal(t.split('hq-rtr1.acme.example').length - 1, 1);
  assert.match(t, /vpn1\.acme\.example/);
});
