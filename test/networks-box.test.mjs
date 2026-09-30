// The "Networks" overview drawn into exported SVG files (diagram/networks-box.ts):
// which networks are relevant to each view, and a box that sits beside the
// legend without covering the diagram or being clipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, exampleNames, fixture, state, scene } from './helpers.mjs';

const nb = load('diagram/networks-box.js');
const legend = load('diagram/legend.js');
const { textWidth } = load('layout/geometry.js');

const ALL = { hiddenProtocols: new Set(), showNetworks: true, showUnderlay: false };
const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w + 0.01 && inner.y + inner.h <= outer.y + outer.h + 0.01;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Export a view as the app does: render the scene, then add the legend and the networks box. */
function exported(m, view, opts = ALL) {
  const s = new state.Session(m);
  s.setView(view);
  s.state.showNetworks = opts.showNetworks;
  s.state.hiddenProtocols = opts.hiddenProtocols;
  const sc = s.render();
  return { bounds: sc.bounds, scene: sc, ...nb.exportBoxes(m, view, opts, sc) };
}
const ids = (m, view, opts) => scene.findAll(exported(m, view, opts).networks.root, (n) => scene.hasClass(n, 'nw-entry')).map((n) => n.attrs['data-network']);
/** every line of text in a box: [x, text, font size] */
function lines(root) {
  const out = [];
  for (const t of scene.findAll(root, (n) => n.tag === 'text')) {
    const size = t.attrs['font-size'] ? Number(t.attrs['font-size']) : scene.hasClass(t, 'lg-heading') ? 13 : scene.hasClass(t, 'lg-title') ? 11 : 12;
    if (t.children.length) for (const c of t.children) out.push([Number(c.attrs.x), c.text, size, Number(c.attrs.y)]);
    else out.push([Number(t.attrs.x), t.text, size, Number(t.attrs.y)]);
  }
  return out;
}

// one network per way of being (or not being) associated with what a view draws
const nets = `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces:
      - {id: eth0, ip: 10.1.0.1/24}
      - {id: eth9, ip: 10.9.0.1/24}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
      - {id: Vlan20, type: virtual, ip: 10.20.0.1/24}
      - {id: bond0, type: virtual, members: [eth0], ip: 10.50.0.1/24}
      - {id: tun0, type: tunnel, source: eth0, ip: 172.16.0.1/30}
  - id: r2
    type: router
    interfaces:
      - {id: eth0, ip: 10.1.0.2/24}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.2/32}
      - {id: tun0, type: tunnel, source: eth0, ip: 172.16.0.2/30}
  - id: sw
    type: switch
    interfaces: [p1, p2]
links:
  - {id: c1, a: {device: r1, interface: eth0, vlans: [20]}, b: {device: r2, interface: eth0, vlans: [20]}}
  - {id: c2, a: {device: sw, interface: p1, vlans: [30, 31]}, b: {device: r2, vlans: [30, 31]}}
networks:
  - {id: port-net, label: Core link, cidr: 10.1.0.0/24}
  - {id: sub-net, label: VLAN interface, cidr: 10.20.0.0/24, vlan: 20}
  - {id: agg-net, label: Bond segment, cidr: 10.50.0.0/24}
  - {id: tun-net, label: Tunnel transit, cidr: 172.16.0.0/30}
  - {id: lo-net, label: Loopbacks, cidr: 10.255.0.0/24}
  - {id: vlan-net, label: Trunked VLAN, cidr: 10.30.0.0/24, vlan: 30}
  - {id: rel-net, label: VRRP segment, cidr: 10.40.0.0/24, vlan: 40}
  - {id: uncabled-net, label: Spare port, cidr: 10.9.0.0/24}
  - {id: orphan, label: Unused, cidr: 10.99.0.0/24, vlan: 99}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"], over: c1}
  - {id: vrrp, protocol: vrrp, endpoints: [r1, r2], network: rel-net}
  - {id: ospf, protocol: ospf, endpoints: [r1, r2], over: port-net}
`;

test('relevance: the physical picture lists the networks of its ports and cables, not every network in the file', () => {
  const m = model(nets);
  // ports, the virtual interfaces that use them (an aggregate's members, a VLAN carried on the port) and the VLANs permitted on the cables
  assert.deepEqual(ids(m, 'physical').sort(), ['agg-net', 'port-net', 'sub-net', 'vlan-net']);
  // not: networks reached only through a loopback, a tunnel interface, a relation or an uncabled interface
  for (const out of ['lo-net', 'tun-net', 'rel-net', 'uncabled-net', 'orphan']) assert.ok(!ids(m, 'physical').includes(out), out);
  // cabling the spare port brings its network in; removing the VLAN from the cable takes that one out
  const recabled = model(nets.replace('b: {device: r2, vlans: [30, 31]}', 'b: {device: r1, interface: eth9, vlans: [31]}').replace('vlans: [30, 31]}', 'vlans: [31]}'));
  assert.deepEqual(ids(recabled, 'physical').sort(), ['agg-net', 'port-net', 'sub-net', 'uncabled-net']);
});

test('relevance: the logical picture lists the networks it draws; without network nodes, only what its relations and loopbacks use', () => {
  const m = model(nets);
  // network nodes are part of the logical picture, so each drawn network is listed
  assert.deepEqual(ids(m, 'logical').sort(), ['agg-net', 'lo-net', 'orphan', 'port-net', 'rel-net', 'sub-net', 'tun-net', 'uncabled-net', 'vlan-net']);
  const noNodes = { ...ALL, showNetworks: false };
  // gre: its tunnel interfaces' network; vrrp: its "network"; ospf: "over" a network; devices: their loopbacks
  assert.deepEqual(ids(m, 'logical', noNodes).sort(), ['lo-net', 'port-net', 'rel-net', 'tun-net']);
  // a hidden protocol is not in the picture, so neither are the networks only it uses
  assert.deepEqual(ids(m, 'logical', { ...noNodes, hiddenProtocols: new Set(['vrrp', 'gre']) }).sort(), ['lo-net', 'port-net']);
  assert.deepEqual(ids(m, 'logical', { ...noNodes, hiddenProtocols: new Set(['vrrp', 'gre', 'ospf']) }), ['lo-net']);
  // the two views differ, and neither is "all networks of the file"
  assert.notDeepEqual(ids(m, 'physical').sort(), ids(m, 'logical', noNodes).sort());
  assert.ok(ids(m, 'physical').length < m.networks.length && ids(m, 'logical', noNodes).length < m.networks.length);
});

test('relevance is decided from the drawn elements (the scene), not from the model alone', () => {
  const m = model(nets);
  const pick = (view, refs) => nb.viewNetworks(m, view, new Set(refs)).map((n) => n.id);
  assert.deepEqual(pick('physical', []), []);
  assert.deepEqual(pick('physical', ['device:r1', 'device:r2', 'device:sw', 'group:x']), [], 'a device box alone brings no network');
  assert.deepEqual(pick('physical', ['iface:r1:eth0']), ['agg-net', 'port-net', 'sub-net'], 'the port, the aggregate it is a member of, the VLAN interface it carries; not the tunnel sourced from it');
  assert.deepEqual(pick('physical', ['iface:r2:eth0']), ['port-net'], 'r2 has no interface of VLAN 20');
  assert.deepEqual(pick('physical', ['iface:r1:eth9']), ['uncabled-net']);
  assert.deepEqual(pick('physical', ['link:c2']), ['vlan-net']);
  assert.deepEqual(pick('logical', ['device:r1']), ['lo-net']);
  assert.deepEqual(pick('logical', ['relation:vrrp']), ['rel-net']);
  assert.deepEqual(pick('logical', ['hub:vrrp', 'network:orphan', 'network:nope', 'iface:r1:nope']), ['orphan', 'rel-net']);
  const s = new state.Session(m);
  const refs = nb.sceneRefs(s.render().root);
  assert.ok(refs.has('iface:r1:eth0') && refs.has('link:c1') && refs.has('device:sw') && !refs.has('iface:r1:lo0') && !refs.has('iface:r1:eth9') && !refs.has('network:port-net'));
});

test('content: a titled box per view with name, prefix and VLAN of each network, sorted by name', () => {
  const m = model(nets);
  const p = exported(m, 'physical');
  const t = lines(p.networks.root).map((l) => l[1]);
  assert.deepEqual(t, ['Networks — physical view', '4 of 9 in the model: those used by what is shown', 'Bond segment', '10.50.0.0/24', 'Core link', '10.1.0.0/24', 'Trunked VLAN', '10.30.0.0/24 · VLAN 30', 'VLAN interface', '10.20.0.0/24 · VLAN 20']);
  assert.equal(lines(exported(m, 'logical').networks.root)[0][1], 'Networks — logical view');
  assert.equal(p.networks.root.attrs.class, 'svg-networks');
  assert.equal(p.networks.root.attrs['data-count'], '4');
  // it is a box of its own, separate from the legend, drawn in the same style (same frame class, heading and label classes)
  assert.equal(p.legend.root.attrs.class, 'svg-legend');
  assert.equal(scene.findAll(p.legend.root, (n) => scene.hasClass(n, 'nw-entry')).length, 0);
  for (const cls of ['lg-box', 'lg-heading', 'lg-label', 'lg-title']) assert.ok(scene.findAll(p.networks.root, (n) => scene.hasClass(n, cls)).length > 0 && scene.findAll(p.legend.root, (n) => scene.hasClass(n, cls)).length > 0, cls);
  // several prefixes, no prefix, and two networks with the same name (told apart by their ids)
  const same = model('netatlas: 1\ndevices:\n  - {id: a, interfaces: [{id: e0, ip: [10.0.0.1/24, 10.0.1.1/24, "2001:db8::1/64", 10.5.0.1/24]}]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l, a: {device: a, interface: e0, vlans: [7]}, b: "b:e0"}\nnetworks:\n  - {id: n2, label: Users, cidr: 10.0.1.0/24, vlan: 12}\n  - {id: n1, label: Users, cidr: [10.0.0.0/24, "2001:db8::/64"], vlan: 11}\n  - {id: n3, vlan: 7}\n  - {id: n10, cidr: 10.5.0.0/24}\n');
  assert.deepEqual(lines(exported(same, 'physical').networks.root).slice(2).map((l) => l[1]), ['n3', 'no prefix · VLAN 7', 'n10', '10.5.0.0/24', 'Users', 'id n1 · 10.0.0.0/24, 2001:db8::/64 · VLAN 11', 'Users', 'id n2 · 10.0.1.0/24 · VLAN 12']);
  assert.equal(nb.networkIdentity(same.networks[1], false), '10.0.0.0/24, 2001:db8::/64 · VLAN 11');
});

test('empty state: a view without relevant networks says so', () => {
  const none = model(example('minimal.yaml'));
  for (const view of ['physical', 'logical']) {
    const x = exported(none, view);
    assert.deepEqual(lines(x.networks.root).map((l) => l[1]), [`Networks — ${view} view`, 'The model defines no networks.']);
    assert.equal(x.networks.root.attrs['data-count'], '0');
  }
  // networks exist, but nothing drawn in the physical view uses one
  const m = model('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0], logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.1/32}]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l, a: "a:e0", b: "b:e0"}\nnetworks:\n  - {id: loops, cidr: 10.0.0.0/24}\n');
  assert.deepEqual(lines(exported(m, 'physical').networks.root).map((l) => l[1]), ['Networks — physical view', 'No network is used by the elements', 'shown in this view.']);
  assert.deepEqual(ids(m, 'logical'), ['loops']);
});

test('every example, both views: the box is beside the legend, covers nothing, and is not clipped', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    for (const view of ['physical', 'logical']) {
      for (const opts of [ALL, { ...ALL, showNetworks: false }]) {
        const x = exported(m, view, opts);
        const where = `${f} ${view}${opts.showNetworks ? '' : ' (no network nodes)'}`;
        const box = x.networks.box;
        assert.ok(!overlap(box, x.bounds), where + ': covers the diagram');
        assert.ok(!overlap(box, x.legend.box), where + ': covers the legend');
        assert.ok(box.x >= x.legend.box.x + x.legend.box.w + legend.LEGEND_GAP - 0.01, where + ': right of the legend, with a gap');
        assert.ok(inside(box, x.viewBox) && inside(x.legend.box, x.viewBox) && inside(x.bounds, x.viewBox), where + ': something is outside the viewBox');
        assert.ok(x.viewBox.x + x.viewBox.w - (box.x + box.w) >= legend.LEGEND_GAP - 0.01 && x.viewBox.y + x.viewBox.h - (box.y + box.h) >= legend.LEGEND_GAP - 0.01, where + ': margin');
        // the frame is as large as the reported rectangle, and every line of text lies inside it
        const frame = scene.findAll(x.networks.root, (n) => scene.hasClass(n, 'lg-box'))[0];
        assert.deepEqual([Number(frame.attrs.width), Number(frame.attrs.height)], [box.w, box.h], where);
        for (const [tx, text, size, ty] of lines(x.networks.root)) {
          assert.ok(tx >= 0 && tx + textWidth(text, size) <= box.w, `${where}: "${text}" is wider than the box`);
          assert.ok(ty > 0 && ty < box.h, `${where}: "${text}" is outside the box vertically`);
        }
        // exactly the relevant networks, each once
        const want = nb.viewNetworks(m, view, nb.sceneRefs(x.scene.root)).map((n) => n.id);
        assert.deepEqual(scene.findAll(x.networks.root, (n) => scene.hasClass(n, 'nw-entry')).map((n) => n.attrs['data-network']), want, where);
        assert.equal(new Set(want).size, want.length);
        // nothing in it refers to content outside the file
        assert.equal(scene.findAll(x.networks.root, (n) => n.tag === 'use' || n.tag === 'image' || n.tag === 'foreignObject' || 'href' in n.attrs).length, 0);
      }
    }
  }
  // the examples show both situations: a view-specific list, and the same list in both views
  const lab = model(fixture('editor-new-network.yaml'));
  assert.deepEqual(ids(lab, 'physical'), ['net-core', 'net-mgmt']);
  assert.deepEqual(ids(lab, 'logical'), ['net-core', 'net-mgmt', 'net-loopbacks']);
  assert.deepEqual(ids(lab, 'logical', { ...ALL, showNetworks: false }), ['net-loopbacks']);
});

test('long names wrap inside the box instead of widening it without bound', () => {
  const long = 'Customer access network for the north-east metropolitan region including the legacy frame-relay migration sites and/or_a_very_long_unbroken_identifier_that_has_no_spaces_at_all';
  const m = model(`netatlas: 1\ndevices:\n  - {id: a, interfaces: [{id: e0, ip: 10.0.0.1/24}]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l, a: "a:e0", b: "b:e0"}\nnetworks:\n  - id: n\n    label: ${long}\n    cidr: [10.0.0.0/24, 10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24, 10.0.4.0/24, "2001:db8:aaaa:bbbb::/64", "2001:db8:cccc:dddd::/64"]\n    vlan: 4000\n`);
  const x = exported(m, 'physical');
  const entry = scene.findAll(x.networks.root, (n) => scene.hasClass(n, 'nw-entry'))[0];
  const name = scene.findAll(entry, (n) => scene.hasClass(n, 'nw-name'))[0];
  const sub = scene.findAll(entry, (n) => scene.hasClass(n, 'nw-sub'))[0];
  assert.ok(name.children.length >= 4 && sub.children.length >= 2, 'both the name and the prefixes wrap');
  // nothing is shortened: every word and every prefix is there
  assert.equal(name.children.map((c) => c.text).join(' ').replace(/ /g, ''), long.replace(/ /g, ''));
  assert.match(sub.children.map((c) => c.text).join(' '), /10\.0\.4\.0\/24.*2001:db8:cccc:dddd::\/64 · VLAN 4000$/);
  assert.ok(!/…/.test(scene.textOf(x.networks.root)));
  assert.ok(x.networks.box.w <= 300, String(x.networks.box.w));
  for (const [tx, text, size] of lines(x.networks.root)) assert.ok(tx + textWidth(text, size) <= x.networks.box.w, text);
  // the lines of one entry do not run into the next line
  const ys = lines(entry).map((l) => l[3]);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 13, 'line spacing');
});

test('a large list continues in further columns; every network is listed once, readable and unclipped', () => {
  // 150 VLAN interfaces on one switch, all carried on its uplink
  let t = 'netatlas: 1\ndevices:\n  - id: a\n    interfaces: [e0]\n    logical_interfaces:\n';
  for (let i = 0; i < 150; i++) t += `      - {id: Vlan${100 + i}, type: virtual, ip: 10.${i}.0.1/24}\n`;
  t += `  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l, a: {device: a, interface: e0, vlans: [${Array.from({ length: 150 }, (_, i) => 100 + i).join(', ')}]}, b: "b:e0"}\nnetworks:\n`;
  for (let i = 0; i < 150; i++) t += `  - {id: n${i}, label: "Segment ${i} of the campus", cidr: 10.${i}.0.0/24, vlan: ${100 + i}}\n`;
  const m = model(t);
  const x = exported(m, 'physical');
  const entries = scene.findAll(x.networks.root, (n) => scene.hasClass(n, 'nw-entry'));
  assert.equal(entries.length, 150);
  // sorted by name, numbers by value
  assert.deepEqual(entries.slice(0, 3).map((e) => e.attrs['data-network']), ['n0', 'n1', 'n2']);
  assert.equal(entries[149].attrs['data-network'], 'n149');
  const at = entries.map((e) => lines(e)[0]);
  const columns = [...new Set(at.map((l) => l[0]))];
  assert.ok(columns.length >= 3, `${columns.length} columns`);
  assert.ok(x.networks.box.h <= 800 && x.networks.box.w < 300 * columns.length, `${x.networks.box.w} x ${x.networks.box.h}`);
  // within a column entries go down without overlapping; columns do not overlap
  for (const cx of columns) {
    const col = entries.filter((e) => lines(e)[0][0] === cx).map((e) => lines(e).map((l) => l[3]));
    for (let i = 1; i < col.length; i++) assert.ok(col[i][0] - col[i - 1][col[i - 1].length - 1] >= 14, 'entries overlap');
    const widest = Math.max(...entries.filter((e) => lines(e)[0][0] === cx).flatMap((e) => lines(e).map((l) => l[0] + textWidth(l[1], l[2]))));
    const next = columns.filter((c) => c > cx).sort((p, q) => p - q)[0];
    assert.ok(widest <= (next === undefined ? x.networks.box.w : next - 10), 'columns overlap');
  }
  assert.ok(!overlap(x.networks.box, x.bounds) && !overlap(x.networks.box, x.legend.box) && inside(x.networks.box, x.viewBox));
  // the same sizes whatever the list: text is in diagram units, like the legend's
  assert.ok(scene.findAll(x.networks.root, (n) => scene.hasClass(n, 'nw-name')).every((n) => n.attrs['font-size'] === '12'));
});

test('the box is a function of the model and the view: the same export twice gives the same box', () => {
  const m = model(example('enterprise-wan.yaml'));
  for (const view of ['physical', 'logical']) assert.deepEqual(exported(m, view).networks, exported(m, view).networks);
});
