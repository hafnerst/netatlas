// Rendering tests on the DOM-free scene graph: what each view draws, how
// protocols and tunnels are styled, and that labels are only ever text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, scene, example, model, byClass, byRef } from './helpers.mjs';

function sessionFor(text) {
  return new state.Session(model(text));
}

const wan = () => sessionFor(example('enterprise-wan.yaml'));

test('physical view: every device, cable and port; no logical relations', () => {
  const s = wan();
  const m = s.model;
  const v = s.render().root;
  assert.equal(byClass(v, 'device').length, m.devices.length);
  assert.equal(byClass(v, 'cable').length, m.links.length);
  assert.equal(byClass(v, 'port').length, m.links.length * 2);
  assert.equal(byClass(v, 'rel').length, 0, 'tunnels/adjacencies must not be drawn as cables');
  assert.equal(byClass(v, 'group').length, m.groups.length);
  // port labels carry the interface names
  const text = scene.textOf(v);
  assert.match(text, /ge-0\/0\/0/);
  assert.match(text, /Ethernet49/);
});

test('physical view: device boxes do not overlap and sit inside their group box', () => {
  const s = wan();
  const L = s.physicalLayout();
  const boxes = Array.from(L.boxes.entries());
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [, a] = boxes[i];
      const [, b] = boxes[j];
      const overlap = Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2;
      assert.ok(!overlap, `${boxes[i][0]} overlaps ${boxes[j][0]}`);
    }
  }
  const v = s.render().root;
  const grp = byRef(v, 'group:hq-edge')[0].children[0].attrs;
  const b = L.boxes.get('hq-rtr1');
  assert.ok(b.cx - b.w / 2 >= +grp.x && b.cx + b.w / 2 <= +grp.x + +grp.width);
});

test('physical view: link style reflects medium and speed', () => {
  const v = wan().render().root;
  const fiber = byRef(v, 'link:l-fw-core1')[0];
  assert.ok(scene.hasClass(fiber, 'medium-fiber'));
  const lte = byRef(v, 'link:l-ham-lte')[0];
  assert.ok(scene.hasClass(lte, 'medium-wireless'));
  assert.ok(lte.children[1].attrs['stroke-dasharray'], 'radio links are dashed');
  const w = (ref) => +byRef(v, ref)[0].children[1].attrs['stroke-width'];
  assert.ok(w('link:l-peer1') > w('link:l-muc-inet'), '100G drawn thicker than 250M');
});

test('logical view: relations drawn, no cables; tunnels are tubes, adjacencies lines', () => {
  const s = wan();
  s.setView('logical');
  const v = s.render().root;
  assert.equal(byClass(v, 'cable').length, 0);
  const rels = byClass(v, 'rel');
  assert.equal(rels.length, s.model.relations.length);
  for (const r of s.model.relations.filter((x) => x.category === 'tunnel')) {
    const g = byRef(v, 'relation:' + r.id).find((n) => scene.hasClass(n, 'rel'));
    assert.ok(scene.hasClass(g, 'style-tube'), r.id);
    assert.equal(byClass(g, 'tube-outer').length >= 1, true);
    assert.equal(byClass(g, 'tube-inner').length >= 1, true, 'hollow center distinguishes tunnels from cables');
  }
  const bgp = byRef(v, 'relation:bgp-isp1').find((n) => scene.hasClass(n, 'rel'));
  assert.ok(scene.hasClass(bgp, 'cat-adjacency') && byClass(bgp, 'rel-line').length === 1 && byClass(bgp, 'tube-outer').length === 0);
  const vrrp = byRef(v, 'relation:vrrp-users').find((n) => scene.hasClass(n, 'rel'));
  assert.ok(scene.hasClass(vrrp, 'style-dotted'));
});

test('logical view: OSPF nested inside GRE (same ports, same path, narrower); IPsec, bound to the underlay port, runs from it', () => {
  const s = wan();
  s.setView('logical');
  const v = s.render().root;
  const path = (id, cls) => byClass(byRef(v, 'relation:' + id).find((n) => scene.hasClass(n, 'rel')), cls)[0].attrs;
  const ipsec = path('ipsec-muc', 'tube-outer');
  const gre = path('gre-muc', 'tube-outer');
  const ospf = path('ospf-muc', 'rel-line');
  // GRE and OSPF are bound to hq-rtr1:st0.10 and muc-rtr:Tunnel10: one strand, OSPF inside the GRE tube
  assert.equal(ospf.d, gre.d);
  assert.ok(+ospf['stroke-width'] < +gre['stroke-width']);
  // IPsec is bound to hq-rtr1:ge-0/0/0 and muc-rtr:wan0: it leaves from those ports, not from the tunnel's
  assert.notEqual(gre.d, ipsec.d);
  // the labels summarise each stack, and GRE says what it is carried over
  assert.match(scene.textOf(v), /GRE › OSPF \(over IPsec\)/);
  assert.match(scene.textOf(v), /IPsec · IKEv2 site-to-site/);
});

test('logical view: parallel relations between the same devices get distinct lanes', () => {
  const s = wan();
  s.setView('logical');
  const v = s.render().root;
  // hq-rtr1 <-> isp1-pe carries eBGP and BFD side by side
  const d1 = byClass(byRef(v, 'relation:bgp-isp1').find((n) => scene.hasClass(n, 'rel')), 'rel-line')[0].attrs.d;
  const d2 = byClass(byRef(v, 'relation:bfd-isp1').find((n) => scene.hasClass(n, 'rel')), 'rel-line')[0].attrs.d;
  assert.notEqual(d1, d2);
  // WireGuard backup and the IPsec stack to Hamburg: separate lanes, too
  const wg = byClass(byRef(v, 'relation:wg-ham-backup').find((n) => scene.hasClass(n, 'rel')), 'tube-outer')[0].attrs.d;
  const ips = byClass(byRef(v, 'relation:ipsec-ham').find((n) => scene.hasClass(n, 'rel')), 'tube-outer')[0].attrs.d;
  assert.notEqual(wg, ips);
});

test('logical view: multipoint relations use a hub; networks are nodes with membership lines', () => {
  const s = sessionFor(example('datacenter-evpn.yaml'));
  s.setView('logical');
  const v = s.render().root;
  const hubRel = byRef(v, 'relation:vxlan-10100').find((n) => scene.hasClass(n, 'rel'));
  assert.ok(scene.hasClass(hubRel, 'hub-rel'));
  assert.equal(byClass(hubRel, 'hub').length, 1);
  // one IP network; its four members (the leaves) follow from their Vlan100 addresses
  assert.equal(byClass(v, 'network').length, 1);
  assert.equal(byClass(v, 'member').length, 4);
  // custom protocol from the file's "protocols" section
  const srv6 = byRef(v, 'relation:srv6-dci').find((n) => scene.hasClass(n, 'rel'));
  assert.ok(scene.hasClass(srv6, 'cat-tunnel'));
  assert.equal(byClass(srv6, 'tube-outer')[0].attrs.stroke, '#e03131');
});

test('logical view options: hide protocols, networks and group frames; there is no underlay', () => {
  const s = wan();
  s.setView('logical');
  s.toggleProtocol('ospf', false);
  let v = s.render().root;
  assert.equal(byClass(v, 'proto-ospf').length, 0);
  assert.ok(byClass(v, 'proto-gre').length > 0);
  assert.ok(byClass(v, 'group').length > 0, 'groups are framed in the logical view');
  const devicesBefore = byClass(v, 'device').length;
  s.state.showNetworks = false;
  s.state.showGroups = false;
  v = s.render().root;
  assert.equal(byClass(v, 'network').length, 0);
  assert.equal(byClass(v, 'group').length, 0);
  assert.equal(byClass(v, 'device').length, devicesBefore, 'hiding frames keeps their devices');
  assert.equal(byClass(v, 'underlay').length, 0);
  assert.ok(!('showUnderlay' in s.state));
});

test('representative protocol and tunnel rendering (built-in, alias, unknown, custom)', () => {
  const text = `netatlas: 1
protocols:
  - {id: quic-tun, category: tunnel, color: "#aa00aa"}
devices:
  - {id: a}
  - {id: b}
relations:
  - {id: t-gre, protocol: gre, endpoints: [a, b]}
  - {id: t-ipsec, protocol: ipsec, endpoints: [a, b]}
  - {id: t-wg, protocol: wireguard, endpoints: [a, b]}
  - {id: t-vx, protocol: vxlan, endpoints: [a, b]}
  - {id: t-bgp, protocol: iBGP, endpoints: [a, b]}
  - {id: t-ospf, protocol: ospf, endpoints: [a, b]}
  - {id: t-lacp, protocol: lacp, endpoints: [a, b]}
  - {id: t-dns, protocol: dns, direction: unidirectional, endpoints: [a, b]}
  - {id: t-custom, protocol: quic-tun, endpoints: [a, b]}
  - {id: t-unknown, protocol: mysterious, endpoints: [a, b]}
  - {id: t-unknown-tun, protocol: vendor-x, category: tunnel, endpoints: [a, b]}
`;
  const s = sessionFor(text);
  s.setView('logical');
  const v = s.render().root;
  const g = (id) => byRef(v, 'relation:' + id).find((n) => scene.hasClass(n, 'rel'));
  const expect = {
    't-gre': 'style-tube', 't-ipsec': 'style-tube', 't-wg': 'style-tube', 't-custom': 'style-tube', 't-unknown-tun': 'style-tube',
    't-vx': 'style-dashed', 't-bgp': 'style-solid', 't-ospf': 'style-solid', 't-lacp': 'style-dotted', 't-dns': 'style-dashdot', 't-unknown': 'style-dashdot',
  };
  for (const [id, cls] of Object.entries(expect)) assert.ok(scene.hasClass(g(id), cls), `${id} should have ${cls}: ${g(id).attrs.class}`);
  assert.equal(byClass(g('t-dns'), 'arrow').length, 1, 'a unidirectional relation has an arrow');
  // 11 relations between the same two devices -> 11 distinct lanes
  const ds = new Set(Object.keys(expect).map((id) => byClass(g(id), 'hit')[0].attrs.d));
  assert.equal(ds.size, 11);
});

test('untrusted text only ever becomes text nodes; class names are sanitized', () => {
  const s = sessionFor(`netatlas: 1
devices:
  - {id: a, label: "<img src=x onerror=alert(1)>", type: server}
  - {id: b, label: "</text><script>alert(2)</script>"}
links:
  - {id: l1, a: a, b: b, medium: "fiber\\" style=\\"x", label: "<b>bold</b>"}
`);
  for (const view of ['physical', 'logical']) {
    s.setView(view);
    const v = s.render().root;
    scene.walk(v, (n) => {
      assert.ok(/^[a-z]+$/i.test(n.tag), 'tag from code only: ' + n.tag);
      for (const [k, val] of Object.entries(n.attrs)) {
        assert.ok(!/^on/i.test(k), 'no event handler attributes');
        if (k === 'class') assert.match(val, /^[a-z0-9 _-]*$/, 'class tokens are sanitized: ' + val);
      }
    });
  }
  s.setView('physical');
  assert.match(scene.textOf(s.render().root), /<img src=x onerror=alert\(1\)>/);
});

test('layouts are deterministic', () => {
  const a = wan();
  const b = wan();
  a.setView('logical');
  b.setView('logical');
  assert.deepEqual(a.render().root, b.render().root);
});

test('larger generated input renders within a reasonable time', () => {
  let t = 'netatlas: 1\ngroups:\n';
  for (let g = 0; g < 10; g++) t += `  - {id: site${g}, kind: site}\n`;
  t += 'devices:\n';
  for (let i = 0; i < 300; i++) t += `  - {id: d${i}, type: ${i % 10 === 0 ? 'router' : 'switch'}, group: site${i % 10}, interfaces: [p1, p2, p3]}\n`;
  t += 'links:\n';
  for (let i = 1; i < 300; i++) t += `  - {id: l${i}, a: "d${i}:p1", b: "d${Math.floor(i / 2)}:p${i % 2 ? 2 : 3}"}\n`;
  t += 'relations:\n';
  for (let i = 0; i < 300; i += 10) t += `  - {id: r${i}, protocol: gre, endpoints: [d${i}, d${(i + 10) % 300}]}\n`;
  const t0 = Date.now();
  const s = sessionFor(t);
  s.render();
  s.setView('logical');
  s.render();
  const ms = Date.now() - t0;
  assert.ok(ms < 15000, `took ${ms} ms`);
});
