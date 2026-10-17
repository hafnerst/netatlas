// Virtualization in the diagrams: a host's box holds its virtual switches,
// container networks and guests (a container in a VM inside the VM), with
// the wires from the vNICs / veths and from the host's ports; in the
// logical view a guest is a device that names its host, and bridge and
// overlay networks are networks behind their host. The Device types filter
// splits servers by their service; the physical view shows a guest only
// with its host. Legends for both views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, state, validate } from './helpers.mjs';
import { inside, problems } from './scene-geometry.mjs';

const V = load('model/virtual.js');
const { ModelDoc } = load('editor/document.js');
const { typeKey } = load('model/device-types.js');
const { legendOf } = load('diagram/legend.js');
const { networkMembers } = load('model/derive.js');

const all = (n, f, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (f(n)) out.push(n);
  for (const c of n.children || []) all(c, f, out);
  return out;
};
const has = (n, cls) => (' ' + ((n.attrs && n.attrs.class) || '') + ' ').indexOf(' ' + cls + ' ') >= 0;
const rectOf = (n) => ({ x: +n.attrs.x, y: +n.attrs.y, w: +n.attrs.width, h: +n.attrs.height });
const pts = (d) =>
  d
    .slice(1)
    .split(/[ML]/)
    .map((s) => s.trim().split(/[ ,]+/).map(Number))
    .map(([x, y]) => ({ x, y }));
const near = (p, r, slack = 1.5) => p.x >= r.x - slack && p.x <= r.x + r.w + slack && p.y >= r.y - slack && p.y <= r.y + r.h + slack;

const render = (m, view) => {
  const s = new state.Session(m);
  s.setView(view);
  return s.render().root;
};
/** device id -> its box in a scene */
const boxes = (root) => new Map(all(root, (n) => has(n, 'device')).map((g) => [g.attrs['data-ref'].slice(7), rectOf(g.children.find((c) => has(c, 'dev-box')))]));

test('physical view: every guest inside its host’s box (a container in a VM inside the VM), the bars and port groups inside the host; nothing overlaps', () => {
  const m = model(example('virtualization.yaml'));
  const root = render(m, 'physical');
  const b = boxes(root);
  const guests = m.devices.filter((d) => V.isGuest(d));
  assert.ok(guests.length >= 10);
  for (const g of guests) {
    assert.ok(b.has(g.id), `${g.id} is drawn`);
    assert.ok(inside(b.get(g.id), b.get(g.host)), `${g.id} inside ${g.host}`);
  }
  // metrics runs in k8s1, a VM on esx-01: inside both
  assert.ok(inside(b.get('metrics'), b.get('k8s1')) && inside(b.get('metrics'), b.get('hv1')));
  // every virtual switch and container network of a host is a bar in its box, with its port groups as pills
  const bars = all(root, (n) => has(n, 'vbar'));
  for (const d of m.devices) {
    for (const vs of (d.hypervisor && d.hypervisor.vswitches) || []) {
      const bar = bars.find((x) => x.attrs['data-ref'] === V.vswitchRef(d.id, vs.name));
      assert.ok(bar && inside(rectOf(bar.children.find((c) => has(c, 'vbar-box'))), b.get(d.id)), `${d.id} ${vs.name}`);
      for (const pg of vs.portGroups) assert.ok(all(bar, (n) => n.attrs && n.attrs['data-ref'] === V.portGroupRef(d.id, pg.name)).length === 1, `${d.id} ${pg.name}`);
    }
    for (const n of (d.containerEngine && d.containerEngine.networks) || []) {
      if (n.driver === 'host' || n.driver === 'none') continue;
      assert.ok(bars.some((x) => x.attrs['data-ref'] === V.cnetRef(d.id, n.name)), `${d.id} ${n.name}`);
    }
  }
  assert.deepEqual(problems(root), []);
  // deterministic: the same scene twice
  assert.equal(JSON.stringify(render(m, 'physical')), JSON.stringify(root));
});

test('physical view: wires from each vNIC / veth to its port group or network, uplinks from the host’s ports to their virtual switch, passthrough to the guest', () => {
  const m = model(example('virtualization.yaml'));
  const root = render(m, 'physical');
  const wires = all(root, (n) => has(n, 'vwire'));
  const rectByRef = new Map();
  for (const n of all(root, (x) => x.attrs && x.attrs['data-ref'])) {
    const ref = n.attrs['data-ref'];
    const r = n.tag === 'rect' ? rectOf(n) : n.children && n.children.find((c) => c.tag === 'rect') ? rectOf(n.children.find((c) => c.tag === 'rect')) : null;
    if (r && !rectByRef.has(ref)) rectByRef.set(ref, r);
  }
  const port = (ref) => all(root, (n) => n.tag === 'rect' && has(n, 'port') && n.attrs['data-ref'] === ref).map(rectOf)[0];
  const ends = (w) => {
    const p = pts(w.attrs.d);
    return [p[0], p[p.length - 1]];
  };
  // every vnic on a port group and every veth on a drawn network has its wire, from its entry to its pill / bar
  for (const d of m.devices.filter((x) => V.isGuest(x) || x.hypervisor)) {
    for (const i of d.logical) {
      const pg = i.type === 'vnic' ? V.vnicPortGroup(m, i) : undefined;
      const net = i.type === 'veth' ? V.vethNetwork(m, i) : undefined;
      if (!pg && !(net && net.net.driver !== 'host' && net.net.driver !== 'none')) continue;
      const ref = `iface:${d.id}:${i.id}`;
      const to = pg ? V.portGroupRef(pg.host.id, pg.pg.name) : V.cnetRef(net.owner.id, net.net.name);
      const w = wires.find((x) => x.attrs['data-ref'] === ref);
      assert.ok(w, `a wire from ${ref}`);
      assert.equal(w.attrs['data-to'], to, ref);
      const [a, z] = ends(w);
      assert.ok(near(a, rectByRef.get(ref)) || near(z, rectByRef.get(ref)), `${ref} starts at its entry`);
      assert.ok(near(a, rectByRef.get(to)) || near(z, rectByRef.get(to)), `${ref} ends at ${to}`);
    }
  }
  // uplinks: from the port on the host's side to the bar
  const ups = wires.filter((w) => has(w, 'vwire-uplink'));
  assert.ok(ups.length >= 4);
  for (const w of ups) {
    const p = port(w.attrs['data-ref']);
    const [a, z] = ends(w);
    assert.ok(p && (near(a, p) || near(z, p)), `${w.attrs['data-ref']} at its port`);
    assert.ok(near(a, rectByRef.get(w.attrs['data-to'])) || near(z, rectByRef.get(w.attrs['data-to'])));
  }
  // db1's passthrough: from esx-01's vmnic2 to the guest's interface
  const pt = wires.find((w) => has(w, 'vwire-passthrough'));
  assert.equal(pt.attrs['data-ref'], 'iface:hv1:vmnic2');
  assert.equal(pt.attrs['data-to'], 'iface:db1:eth0');
  // the macvlan network hangs from its parent port
  assert.ok(wires.some((w) => has(w, 'vwire-parent') && w.attrs['data-ref'] === 'iface:ctr1:eth1' && w.attrs['data-to'] === 'cnet:ctr1:lan'));
});

test('logical view: a guest names its host ("runs on"); bridge and overlay networks are networks of their own host, the same subnet behind two hosts two networks', () => {
  const m = model(example('virtualization.yaml'));
  const root = render(m, 'logical');
  const sub = (id) => all(root, (n) => has(n, 'device') && n.attrs['data-ref'] === 'device:' + id)[0].children.filter((c) => has(c, 'dev-sub')).map((t) => JSON.stringify(t)).join('');
  assert.match(sub('web1'), /runs on esx-01/);
  assert.match(sub('metrics'), /runs on k8s1/);
  assert.doesNotMatch(sub('hv1'), /runs on/);
  // the docker host's bridge: a dashed network, its members the host's bridge interface and the containers on it
  const lm = V.withVirtualNetworks(m);
  const nets = lm.networks.filter((n) => n.cnet);
  assert.deepEqual(nets.map((n) => n.id).sort(), ['ctr1/bridge', 'k8s1/bridge']);
  const ctr = lm.index.networks.get('ctr1/bridge');
  assert.equal(ctr.nat, 'ctr1');
  const net = all(root, (n) => has(n, 'network') && n.attrs['data-ref'] === 'network:ctr1/bridge')[0];
  assert.ok(net && has(net, 'cnet-net'));
  assert.match(JSON.stringify(net), /NAT/);
  // (cache is on the macvlan network: on the LAN, not behind the host)
  const mem = (id) => networkMembers(lm, id).map((x) => x.device + ':' + x.matches.map((y) => y.iface).join('+'));
  assert.deepEqual(mem('ctr1/bridge'), ['ctr1:docker0', 'web:eth0', 'api:eth0']);
  assert.deepEqual(mem('k8s1/bridge'), ['k8s1:cni0', 'metrics:eth0']);
  // the physical view does not draw them as networks; the model itself is untouched
  assert.ok(!m.index.networks.has('ctr1/bridge'));
  // two Docker hosts with the default bridge: each its own network, its own members
  const two = model(`netatlas: 2
devices:
  - id: a
    type: server
    services: {container_engine: {engine: docker, networks: [{name: bridge, driver: bridge, interface: docker0, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true}]}}
  - id: b
    type: server
    services: {container_engine: {engine: docker, networks: [{name: bridge, driver: bridge, interface: docker0, subnet: 172.17.0.0/16, gateway: 172.17.0.1, nat: true}]}}
  - id: ca
    type: container
    host: a
    logical_interfaces: [{id: eth0, type: veth, network: bridge, ip: 172.17.0.2}]
  - id: cb
    type: container
    host: b
    logical_interfaces: [{id: eth0, type: veth, network: bridge, ip: 172.17.0.2}]
`);
  const tm = V.withVirtualNetworks(two);
  assert.deepEqual(networkMembers(tm, 'a/bridge').map((x) => x.device), ['a', 'ca']);
  assert.deepEqual(networkMembers(tm, 'b/bridge').map((x) => x.device), ['b', 'cb']);
});

test('logical view: selecting a container network selects it (cnet) and highlights its network; Auto-arrange stores its place, valid on reload', () => {
  const m = model(example('virtualization.yaml'));
  const s = new state.Session(m);
  s.setView('logical');
  s.select('network:ctr1/bridge');
  assert.equal(s.state.selected, 'cnet:ctr1:bridge');
  const hl = s.highlight();
  assert.ok(hl.has('network:ctr1/bridge') && hl.has('device:ctr1'));
  // the place of the network is part of the logical layout, and is accepted when the file is read again
  const d = ModelDoc.fromText(example('virtualization.yaml'), 'v.yaml', 'file').doc;
  d.arrange(['logical']);
  const text = d.exportText();
  assert.match(text, /\n {4}ctr1\/bridge: \[-?\d+, -?\d+\]/);
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  assert.ok(r.model.layout.logical.has('ctr1/bridge'));
  // a place for a network that is no container network of a host is still reported
  const bad = validate.loadModel(text.replace('ctr1/bridge:', 'ctr1/nothing:'));
  assert.ok(bad.warnings.some((w) => /ctr1\/nothing/.test(w.message)));
});

test('the Device types filter: servers by their service; the physical view shows a guest only with its host and says which it leaves out; focus keeps a host’s guests', () => {
  const m = model(example('virtualization.yaml'));
  const keys = (id) => typeKey(m.index.devices.get(id));
  assert.deepEqual(['hv1', 'ctr1', 'web1', 'web'].map(keys), ['server:hypervisor', 'server:container', 'vm', 'container']);
  const s = new state.Session(m);
  s.setView('physical');
  s.setTypesVisible(['server:hypervisor'], false);
  const shown = s.shownDevices('physical');
  // the VMs on the hypervisors, and the container in one of them, go with their hosts; the docker host's containers stay
  for (const d of m.devices.filter((x) => V.isGuest(x))) assert.equal(shown.has(d.id), V.machineOf(m, d).id === 'ctr1', d.id);
  assert.deepEqual(s.hiddenWithHost('physical').sort(), m.devices.filter((x) => V.isGuest(x) && V.machineOf(m, x).id !== 'ctr1').map((x) => x.id).sort());
  // the logical view draws them: they are devices of their own there
  assert.deepEqual(s.hiddenWithHost('logical'), []);
  assert.ok(s.shownDevices('logical').has('web1'));
  // VMs off: the container in a VM has no host on screen
  s.setTypesVisible(['server:hypervisor'], true);
  s.setTypesVisible(['vm'], false);
  assert.deepEqual(s.hiddenWithHost('physical'), ['metrics']);
  s.setTypesVisible(['vm'], true);
  assert.equal(s.isFiltered(), false);
  // focus on a host in the physical view: its guests come with it (they have no cables)
  s.setFocus('device:hv2', 1);
  const f = s.shownDevices('physical');
  for (const g of V.allGuestsOf(m, 'hv2')) assert.ok(f.has(g.id), g.id);
});

test('legends: the physical view’s virtual switches, container networks, guests and wires; the logical view’s "runs on"', () => {
  const m = model(example('virtualization.yaml'));
  const sec = (view) => legendOf(m, view).sections.find((x) => x.title === 'Virtualization');
  const phys = sec('physical').items.map((i) => i.label);
  assert.ok(phys.some((l) => /^Virtual switch/.test(l)));
  assert.ok(phys.some((l) => /^Container network/.test(l)));
  assert.ok(phys.some((l) => /^Guest drawn inside its host/.test(l)));
  assert.ok(phys.some((l) => /^Virtual wire/.test(l)));
  assert.ok(phys.some((l) => /^Uplink/.test(l)));
  assert.deepEqual(sec('logical').items.map((i) => i.label), ['Guest (VM or container): "runs on" names its host']);
  // a model without virtualization has no such section
  const plain = model(example('campus-services.yaml'));
  for (const view of ['physical', 'logical']) assert.ok(!legendOf(plain, view).sections.some((x) => x.title === 'Virtualization'), view);
});

test('the simulation’s HA restarts: a VM drawn in its new host (only while set), what lies below makes room, nothing overlaps', () => {
  const m = model(example('virtualization.yaml'));
  const s = new state.Session(m);
  s.setView('physical');
  const home = boxes(s.render().root);
  assert.equal(s.setPlacement(new Map([['app1', 'hv1'], ['vr1', 'hv1'], ['lab1', 'hv1']])), true);
  assert.equal(s.setPlacement(new Map([['lab1', 'hv1'], ['app1', 'hv1'], ['vr1', 'hv1']])), false, 'the same placement changes nothing');
  const r = s.render();
  const b = boxes(r.root);
  for (const g of ['app1', 'vr1', 'lab1']) assert.ok(inside(b.get(g), b.get('hv1')), g);
  // esx-01 keeps its top edge; the model is unchanged
  assert.equal(b.get('hv1').y, home.get('hv1').y);
  assert.equal(m.index.devices.get('app1').host, 'hv2');
  assert.equal(r.conflicts, 0);
  assert.deepEqual(problems(r.root), []);
  // the logical view is not affected
  s.setView('logical');
  assert.match(JSON.stringify(s.render().root), /runs on esx-02/);
  s.setView('physical');
  s.setPlacement(null);
  const back = boxes(s.render().root);
  assert.ok(inside(back.get('app1'), back.get('hv2')));
  assert.deepEqual(back.get('hv1'), home.get('hv1'));
});
