// Every address and identifier of a model is written in the diagram itself,
// next to what it belongs to, in full, and no text is drawn over other text:
// in both views, for every example, after Auto-arrange with each strategy,
// and (detectably) after moving nodes by hand. The browser self-test repeats
// the inventory and the overlap check with real font metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames, state, scene, byClass, byRef } from './helpers.mjs';
import { geometry, problems } from './scene-geometry.mjs';

const A = load('model/addresses.js');
const { layoutInput, layoutSignature, entryTexts } = load('layout/input.js');
const { autoPositions } = load('layout/positions.js');
const { strategyPositions } = load('layout/strategies.js');

const auto = (text) => model(text.replace(/\nlayout:[\s\S]*$/, '\n'));
const render = (m, view) => {
  const s = new state.Session(m);
  s.setView(view);
  return s.render();
};
/** every line of text a scene draws: one entry per <text> without tspans, else per <tspan> */
const drawnLines = (root) => {
  const out = [];
  scene.walk(root, (n) => {
    if (n.tag === 'text' && !n.children.length && n.text !== undefined) out.push(n.text);
    if (n.tag === 'tspan') out.push(n.text);
  });
  return out;
};
const missing = (m, view, root) => {
  const lines = drawnLines(root);
  const all = '\n' + lines.join('\n') + '\n';
  const flat = lines.join('');
  return A.addressInventory(m)
    .filter((a) => a.views.includes(view))
    .filter((a) => (a.field === 'dns_names' ? !flat.includes(a.text) : !all.includes(a.text)))
    .map((a) => `${a.owner} ${a.field} "${a.text}"`);
};

test('the address fields of the format: what the inventory finds in the addressing example, and where it is drawn', () => {
  const m = model(example('addressing.yaml'));
  const inv = A.addressInventory(m);
  const fields = new Set(inv.map((a) => a.field.replace(/^attrs\..*/, 'attrs')));
  assert.deepEqual([...fields].sort(), ['attrs', 'cable', 'cidr', 'destination', 'dns_names', 'id', 'ip', 'mac', 'members', 'source', 'vlan', 'vrf'].filter((f) => f !== 'dns_names').sort());
  const where = (owner, field) => inv.find((a) => a.owner === owner && a.field === field).views.join('+');
  // physical identifiers in the physical view, layer 3 in the logical view, both where the interface is drawn in both
  assert.equal(where('iface:core:ge-0/0/9', 'mac'), 'physical');
  assert.equal(where('iface:core:xe-0/0/0', 'ip'), 'physical+logical');
  assert.equal(where('iface:core:xe-0/0/0', 'mac'), 'physical+logical');
  assert.equal(where('iface:core:lo0', 'ip'), 'logical');
  assert.equal(where('iface:core:gr-0/0/0.0', 'destination'), 'logical');
  assert.equal(where('network:corp', 'cidr'), 'logical');
  assert.equal(where('link:wan', 'cable'), 'physical');
  assert.equal(where('relation:vrrp', 'attrs.virtual-ip'), 'logical');
  assert.equal(where('device:core', 'attrs.router-id'), 'physical+logical');
  assert.equal(where('group:branch', 'attrs.site-prefix'), 'physical+logical');
  // attrs without an address are not addresses (they stay in the details)
  assert.ok(!inv.some((a) => a.field === 'attrs.vrid' || a.field === 'attrs.peer-as'));
});

test('address-like attrs: IPv4 / IPv6 addresses and prefixes and MAC addresses, nothing else', () => {
  for (const v of ['10.1.2.3', '10.0.0.0/8', '2001:db8::1', '2001:db8::/32', '00:1c:73:aa:00:01', '001c.73aa.0001', 'fc00:0:1::, fc00:0:5::', '[192.0.2.1]']) assert.ok(A.hasAddress(v), v);
  for (const v of ['65000:100', 'aes-256-gcm', '0.0.0.10 area', '300ms', 'tcp/6514', '4789', 'RFC5424']) assert.equal(A.hasAddress(v), v === '0.0.0.10 area', v);
  // sorted by key, so the order in the file changes nothing
  assert.deepEqual(A.addressAttrLines([['vip', '10.0.0.1'], ['mode', 'active'], ['backup', '10.0.0.3']]), ['backup 10.0.0.3', 'vip 10.0.0.1']);
});

test('several addresses of an interface: a compact, ordered list (IPv4, then IPv6, numerically), dual stack together, every address whole', () => {
  assert.deepEqual(A.orderedAddresses(['2001:db8::10/64', '10.0.0.10/24', 'fe80::1/64', '10.0.0.9/24', '2001:db8::9/64', 'bogus']), ['10.0.0.9/24', '10.0.0.10/24', '2001:db8::9/64', '2001:db8::10/64', 'fe80::1/64', 'bogus']);
  const m = model(example('addressing.yaml'));
  const entry = (dev, id, view) => A.deviceEntries(m, m.index.devices.get(dev), view).find((e) => e.id === id);
  assert.deepEqual(entry('core', 'lo0', 'logical'), {
    ref: 'iface:core:lo0',
    device: 'core',
    id: 'lo0',
    kind: 'loopback',
    header: 'lo0 · Router ID',
    lines: ['10.255.255.1/32', '2001:db8:ffff:ffff::1/128'],
    // each line knows the field it is written from (the Edit tab highlights it when the line is clicked)
    fields: [{ field: 'ip', value: '10.255.255.1/32' }, { field: 'ip', value: '2001:db8:ffff:ffff::1/128' }],
  });
  assert.deepEqual(entry('core', 'ge-0/0/2.10', 'logical').fields.map((f) => f.field), ['vlan', 'ip', 'ip', 'attr', 'attr']);
  assert.deepEqual(entry('core', 'gr-0/0/0.0', 'logical').fields.map((f) => f.field), ['ip', 'ip', 'source', 'destination']);
  assert.deepEqual(entry('core', 'ge-0/0/3', 'physical').lines, ['VRF MGMT', '10.20.0.1/24', '10.20.1.1/24', 'MAC 00:1c:73:aa:00:04'], 'secondary address after the primary');
  assert.deepEqual(entry('core', 'ge-0/0/2.10', 'logical').lines, ['VLAN 10 · VRF CORP', '10.10.10.2/24', '2001:db8:10:10::2/64', 'vrrp-virtual-ip 10.10.10.1', 'vrrp-virtual-ipv6 2001:db8:10:10::1']);
  assert.deepEqual(entry('core', 'gr-0/0/0.0', 'logical').lines, ['172.31.255.1/30', 'fd00:dead:beef:0:0:0:0:1/126', 'src lo0', 'dst 2001:db8:ffff:ffff::2']);
  assert.deepEqual(entry('core', 'ae0', 'logical').lines, ['MAC 02:00:00:00:ae:00', 'members ge-0/0/6, ge-0/0/7']);
  assert.deepEqual(entry('core', 'ge-0/0/4', 'logical').lines, ['DHCP']);
  // a long IPv6 address with its prefix is one line, exactly as written
  const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334/127';
  assert.ok(entry('core', 'xe-0/0/1', 'physical').lines.includes(v6));
  for (const view of ['physical', 'logical']) assert.ok(drawnLines(render(m, view).root).includes(v6), view);
  // a port with only a MAC address is a physical matter: not in the logical view
  assert.equal(entry('core', 'ge-0/0/9', 'logical'), undefined);
  assert.ok(entry('core', 'ge-0/0/9', 'physical'));
});

test('every example, both views: every address and identifier is drawn as text, nothing shortened or summed up', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    for (const view of ['physical', 'logical']) {
      const r = render(m, view);
      assert.deepEqual(missing(m, view, r.root), [], `${f} ${view}`);
      const text = drawnLines(r.root).join('\n');
      assert.doesNotMatch(text, /…|\.\.\.|\+\d+ more|\s\+\d+$/m, `${f} ${view}: nothing is shortened`);
    }
  }
});

test('no text over other text, no label over a node, entries inside their boxes: every example and strategy, both views', () => {
  for (const f of exampleNames) {
    const m = auto(example(f));
    const input = layoutInput(m);
    for (const view of ['physical', 'logical']) {
      for (const strategy of ['default', 'compact', 'spacious']) {
        const s = new state.Session(m);
        s.setView(view);
        const pos = strategyPositions(view, input, strategy);
        s.model.layout[view] = pos;
        s.setModel(s.model);
        const r = s.render();
        assert.deepEqual(problems(r.root), [], `${f} ${view} ${strategy}`);
        assert.equal(r.conflicts, 0, `${f} ${view} ${strategy}: no label without a free place, no overlapping nodes`);
      }
    }
  }
});

test('Auto-arrange reserves the room the addresses need, and stays deterministic', () => {
  const m = auto(example('addressing.yaml'));
  const input = layoutInput(m);
  // the size of a device's entries is part of the layout input, so a box grows with its addresses
  const core = input.devices.find((d) => d.id === 'core');
  const flat = (es) => es.map((e) => [e.header].concat(e.lines)).flat();
  const longest = Math.max(...flat(entryTexts(m, m.index.devices.get('core'), 'physical')).map((l) => l.length));
  assert.ok(core.physList[0] >= longest * 10 * 0.6, `${core.physList[0]} for ${longest} characters`);
  const g = geometry(render(m, 'physical').root);
  const box = g.devices.find((d) => d.ref === 'device:core').box;
  for (const e of g.entries.filter((x) => x.ref.startsWith('iface:core:'))) assert.ok(e.box.x >= box.x && e.box.x + e.box.w <= box.x + box.w, e.ref);
  // the same model always gives the same layout and the same picture
  for (const view of ['physical', 'logical']) {
    assert.equal(JSON.stringify([...autoPositions(view, layoutInput(auto(example('addressing.yaml'))))]), JSON.stringify([...autoPositions(view, input)]));
    assert.equal(JSON.stringify(render(auto(example('addressing.yaml')), view).root), JSON.stringify(render(m, view).root));
  }
  assert.equal(layoutSignature(layoutInput(auto(example('addressing.yaml')))), layoutSignature(input));
});

test('dragging: entries and labels go with their node; an overlap made by hand is counted, Auto-arrange removes it', () => {
  const m = auto(example('addressing.yaml'));
  for (const view of ['physical', 'logical']) {
    const s = new state.Session(m);
    s.setView(view);
    const before = geometry(s.render().root);
    const core = before.devices.find((d) => d.ref === 'device:core').box;
    // moved far away: its entries move with it, and nothing overlaps
    s.moveNode('device:core', { x: core.x + core.w / 2 + 3000, y: core.y + core.h / 2 });
    const far = s.render();
    const g = geometry(far.root);
    const moved = g.devices.find((d) => d.ref === 'device:core').box;
    assert.equal(moved.x, core.x + 3000);
    for (const e of g.entries.filter((x) => x.ref.startsWith('iface:core:'))) assert.ok(e.box.x >= moved.x && e.box.x + e.box.w <= moved.x + moved.w, `${view}: ${e.ref} moved with its device`);
    assert.equal(far.conflicts, 0, view);
    // dropped onto another device: the overlap is not silent
    const dist = before.devices.find((d) => d.ref === 'device:dist').box;
    s.moveNode('device:core', { x: dist.x + dist.w / 2 + 10, y: dist.y + dist.h / 2 + 10 });
    const onTop = s.render();
    assert.ok(onTop.conflicts > 0, `${view}: ${onTop.conflicts}`);
    // Auto-arrange (dropping the hand-made positions) gives a picture without overlaps again
    s.resetPositions();
    assert.equal(s.render().conflicts, 0, view);
  }
});

test('entries are selectable interfaces: the same refs as before, in the logical view loopbacks first, then virtual and tunnel interfaces', () => {
  const m = model(example('addressing.yaml'));
  const log = render(m, 'logical').root;
  const refs = byClass(log, 'if-entry').map((n) => n.attrs['data-ref']).filter((r) => r.startsWith('iface:core:'));
  assert.deepEqual(refs, ['iface:core:lo0', 'iface:core:lo1', 'iface:core:ae0', 'iface:core:ge-0/0/2.10', 'iface:core:ge-0/0/2.20', 'iface:core:gr-0/0/0.0', 'iface:core:st0.1', 'iface:core:ge-0/0/3', 'iface:core:ge-0/0/4', 'iface:core:xe-0/0/0', 'iface:core:xe-0/0/1']);
  assert.ok(byRef(log, 'iface:core:lo0').every((n) => n.attrs['data-endpoint'] === 'iface'));
  // the device's own address lines are an entry too, but not a connection endpoint
  const own = byClass(log, 'dev-addr').find((n) => n.attrs['data-ref'] === 'device:core');
  assert.ok(own && own.attrs['data-endpoint'] === undefined);
  assert.match(scene.textOf(own), /nat-pool 203\.0\.113\.64\/28\nrouter-id 10\.255\.255\.1/);
});
