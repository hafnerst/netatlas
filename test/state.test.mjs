// View switching, selection/highlighting and search on the DOM-free session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, panels, scene, example, model, byClass } from './helpers.mjs';

test('Session.fromYaml returns errors instead of a session for invalid input', () => {
  const { session, result } = state.Session.fromYaml('netatlas: 1\ndevices:\n  - *x\n');
  assert.equal(session, null);
  assert.match(result.errors[0].message, /aliases/);
  assert.equal(result.errors[0].line, 3);
});

test('view switching: physical <-> logical keeps model, selection and per-view positions', () => {
  const { session: s } = state.Session.fromYaml(example('enterprise-wan.yaml'));
  assert.equal(s.state.view, 'physical');
  const phys = s.render();
  assert.ok(scene.hasClass(phys.root, 'scene-physical'));
  s.select('relation:gre-muc');
  s.moveNode('device:hq-rtr1', { x: 5000, y: 5000 });
  s.setView('logical');
  const log = s.render();
  assert.ok(scene.hasClass(log.root, 'scene-logical'));
  assert.equal(s.state.selected, 'relation:gre-muc');
  assert.equal(s.state.positions.logical.size, 0, 'moving a node in one view does not move it in the other');
  s.setView('physical');
  const phys2 = s.render();
  assert.ok(phys2.bounds.x + phys2.bounds.w >= 5000, 'dragged position is kept for the physical view');
  s.resetPositions();
  assert.equal(s.state.positions.physical.size, 0);
});

test('selecting a tunnel highlights its endpoints, carriers, carried relations and physical path', () => {
  const m = model(example('enterprise-wan.yaml'));
  const hl = state.relatedRefs(m, 'relation:gre-muc');
  for (const ref of ['relation:gre-muc', 'relation:ipsec-muc', 'relation:ospf-muc', 'device:hq-rtr1', 'device:muc-rtr', 'link:l-hq-isp1', 'link:l-isp1-inet', 'link:l-muc-inet']) {
    assert.ok(hl.has(ref), ref);
  }
  assert.ok(!hl.has('link:l-hq-isp2'));
  assert.ok(!hl.has('relation:gre-ham'));
});

test('selecting a cable highlights every logical relation riding on it', () => {
  const m = model(example('enterprise-wan.yaml'));
  const hl = state.relatedRefs(m, 'link:l-hq-isp1');
  for (const r of ['ipsec-muc', 'gre-muc', 'ospf-muc', 'bgp-isp1', 'bfd-isp1']) assert.ok(hl.has('relation:' + r), r);
});

test('selecting a device / group / network highlights its neighborhood', () => {
  const m = model(example('enterprise-wan.yaml'));
  const d = state.relatedRefs(m, 'device:hq-fw');
  assert.ok(d.has('link:l-rtr1-fw') && d.has('device:hq-rtr1') && d.has('group:hq-edge') && d.has('group:hq') && d.has('network:net-transit'));
  const g = state.relatedRefs(m, 'group:hq');
  assert.ok(g.has('device:hq-core1') && g.has('group:hq-core') && !g.has('device:muc-rtr'));
  const n = state.relatedRefs(m, 'network:net-users');
  assert.ok(n.has('device:hq-core1') && n.has('relation:vrrp-users'));
});

test('invalid selections are ignored', () => {
  const { session: s } = state.Session.fromYaml(example('minimal.yaml'));
  s.select('device:nope');
  assert.equal(s.state.selected, null);
  s.select('link:cable-1');
  assert.equal(s.state.selected, 'link:cable-1');
  assert.ok(s.highlight().has('relation:gre-1'));
});

test('search finds devices by label, address and networks by CIDR', () => {
  const m = model(example('enterprise-wan.yaml'));
  assert.equal(state.search(m, 'hq-fw')[0].ref, 'device:hq-fw');
  assert.equal(state.search(m, '172.16.10.2')[0].ref, 'device:muc-rtr');
  assert.equal(state.search(m, '10.10.20.0/24')[0].ref, 'network:net-servers');
  assert.ok(state.search(m, 'gre').some((h) => h.ref === 'relation:gre-muc'));
  assert.deepEqual(state.search(m, '   '), []);
});

test('details, tooltips and legend describe the selection', () => {
  const m = model(example('enterprise-wan.yaml'));
  const det = scene.textOf(panels.detailsFor(m, 'relation:gre-muc'));
  assert.match(det, /GRE/);
  assert.match(det, /Carried over \(underlay\)/);
  assert.match(det, /IPsec/);
  assert.match(det, /mtu/);
  const port = scene.textOf(panels.detailsFor(m, 'device:hq-rtr1'));
  assert.match(port, /ge-0\/0\/0/);
  assert.match(port, /198\.51\.100\.2\/30/);
  assert.match(panels.tooltipFor(m, 'link:l-hq-isp1').join('\n'), /carries 3 logical relations/);
  const legendP = scene.textOf(panels.legendFor(m, 'physical', new Set()));
  assert.match(legendP, /Fiber/);
  assert.match(legendP, /firewall/);
  const legendL = panels.legendFor(m, 'logical', new Set(['ospf']));
  assert.match(scene.textOf(legendL), /IPsec[\s\S]*GRE[\s\S]*MACsec \*/);
  const ospfToggle = scene.findAll(legendL, (n) => n.attrs['data-proto'] === 'ospf')[0];
  assert.equal(ospfToggle.attrs.checked, undefined, 'hidden protocol is unchecked');
  assert.ok(byClass(panels.relationList(m), 'swatch').length === m.relations.length);
});
