// Static routes: the format (per device, per VRF), which device types may
// have them, validation, the route consistency checks (each positive and
// negative), editing (add, edit, duplicate, delete, undo, interface renames),
// and how routes are shown: the route tables and next-hop lines of the
// logical view, the Routes switch, details, Find and related objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, queries, panels, scene, state, load, model, byRef } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const A = load('model/addresses.js');
const F = load('model/filter.js');
const DT = load('model/device-types.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const errorsOf = (text) => validate.loadModel(text).errors.map((e) => e.message);
const findings = (text, id) => validate.loadModel(text).findings.filter((f) => !id || f.check === id);

const net = `netatlas: 1
devices:
  - id: r1
    type: router
    interfaces:
      - {id: e0, ip: 10.0.12.1/30}
      - {id: e1, ip: 10.0.13.1/30}
      - {id: e2}
    logical_interfaces:
      - {id: lo0, type: loopback, ip: 10.255.0.1/32}
    routes:
      - {prefix: 0.0.0.0/0, via: 10.0.12.2, name: primary}
      - {prefix: 0.0.0.0/0, via: 10.0.13.2, distance: 250, name: backup}
      - {prefix: 192.0.2.0/24, blackhole: true}
  - id: r2
    type: router
    interfaces:
      - {id: e0, ip: 10.0.12.2/30}
  - id: r3
    type: router
    interfaces:
      - {id: e0, ip: 10.0.13.2/30}
  - id: h1
    type: server
    interfaces:
      - {id: eth0, ip: 10.0.12.3/30}
links:
  - {id: l12, a: "r1:e0", b: "r2:e0"}
  - {id: l13, a: "r1:e1", b: "r3:e0"}
`;
const addRoute = (route) => net.replace('      - {prefix: 192.0.2.0/24, blackhole: true}\n', `      - {prefix: 192.0.2.0/24, blackhole: true}\n      - ${route}\n`);

// ------------------------------------------------------------ the format

test('routes are stored per device with prefix, next hop (address, interface, both) or blackhole, distance, metric, VRF, name', () => {
  const r = validate.loadModel(addRoute('{prefix: "2001:db8::/32", interface: e2, metric: 5, vrf: blue, name: v6, description: d, attrs: {owner: noc}}'));
  assert.deepEqual(r.errors, []);
  const rs = r.model.index.devices.get('r1').routes;
  assert.deepEqual(rs.map((x) => [x.index, x.prefix, x.via, x.iface, x.blackhole, x.distance, x.metric, x.vrf, x.name]), [
    [0, '0.0.0.0/0', '10.0.12.2', undefined, false, undefined, undefined, undefined, 'primary'],
    [1, '0.0.0.0/0', '10.0.13.2', undefined, false, 250, undefined, undefined, 'backup'],
    [2, '192.0.2.0/24', undefined, undefined, true, undefined, undefined, undefined, undefined],
    [3, '2001:db8::/32', undefined, 'e2', false, undefined, 5, 'blue', 'v6'],
  ]);
  assert.deepEqual(rs[3].attrs, [['owner', 'noc']]);
  // indexed by "device:index", the index being the place in the file's list
  assert.equal(r.model.index.routes.get('r1:1').name, 'backup');
  assert.ok(queries.refExists(r.model, 'route:r1:3') && !queries.refExists(r.model, 'route:r1:9'));
  // the same file is written back exactly
  const text = addRoute('{prefix: "2001:db8::/32", interface: e2, metric: 5}');
  assert.equal(doc(text).exportText(), text);
});

test('which device types may have routes: Layer 3+ (routers, switches, firewalls, …) and hosts; not APs, IDS/IPS, clouds or untyped devices', () => {
  assert.deepEqual(DT.ROUTE_DEVICE_TYPES, ['router', 'switch', 'firewall', 'server', 'vm', 'container', 'storage', 'load_balancer', 'proxy', 'gateway', 'endpoint', 'system']);
  assert.deepEqual(['router', 'switch', 'firewall', 'load_balancer', 'proxy', 'gateway'].map(DT.routingRole), Array(6).fill('router'));
  assert.deepEqual(['server', 'vm', 'container', 'storage', 'endpoint', 'system'].map(DT.routingRole), Array(6).fill('host'));
  for (const t of ['ap', 'ids_ips', 'cloud']) {
    const e = errorsOf(`netatlas: 1\ndevices:\n  - id: x\n    type: ${t}\n    routes:\n      - {prefix: 0.0.0.0/0, via: 10.0.0.1}\n`);
    assert.equal(e.length, 1, t);
    assert.match(e[0], /static routes are allowed on router, switch, .* devices — set the type or delete the routes/, t);
  }
  assert.match(errorsOf('netatlas: 1\ndevices:\n  - id: x\n    routes:\n      - {prefix: 0.0.0.0/0, via: 10.0.0.1}\n')[0], /device "x" has no type, which has no routing table/);
  // a host's default gateway is a static default route
  const h = validate.loadModel(net.replace('      - {id: eth0, ip: 10.0.12.3/30}\n', '      - {id: eth0, ip: 10.0.12.3/30}\n    routes:\n      - {prefix: 0.0.0.0/0, via: 10.0.12.1}\n'));
  assert.deepEqual(h.errors, []);
  assert.equal(h.model.index.devices.get('h1').routes.length, 1);
});

test('validation: prefix, next hop, interface, blackhole, distance and metric are checked; a route with errors stays in the file only', () => {
  const e = (route) => errorsOf(addRoute(route));
  assert.match(e('{via: 10.0.12.2}')[0], /missing required key "prefix"/);
  assert.match(e('{prefix: 10.0.0.0, via: 10.0.12.2}')[0], /invalid destination prefix: "10\.0\.0\.0" needs a prefix length/);
  assert.match(e('{prefix: 10.0.0.0/8}')[0], /^route 10\.0\.0\.0\/8 needs a next hop: "via" \(an address\), "interface" \(an exit interface of "r1"\), both, or "blackhole: true"/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2/30}')[0], /write the next-hop address without a prefix length: 10\.0\.12\.2/);
  assert.match(e('{prefix: 10.0.0.0/8, via: gw}')[0], /"gw" is not an IPv4 or IPv6 address/);
  assert.match(e('{prefix: 10.0.0.0/8, via: "2001:db8::1"}')[0], /the next hop 2001:db8::1 is an IPv6 address, the destination 10\.0\.0\.0\/8 an IPv4 prefix/);
  assert.match(e('{prefix: 10.0.0.0/8, interface: e9}')[0], /device "r1" has no interface "e9" — did you mean "e0"\?|device "r1" has no interface "e9"/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2, blackhole: true}')[0], /a blackhole route drops the traffic and has no next hop/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2, distance: 0}')[0], /"0" is not a valid administrative distance: use a whole number from 1 to 255/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2, distance: 256}')[0], /administrative distance/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2, metric: -1}')[0], /"-1" is not a valid metric/);
  assert.match(e('{prefix: 10.0.0.0/8, via: 10.0.12.2, gateway: x}')[0], /unknown key "gateway"/);
  // located at the field, for the Edit tab
  const r = validate.loadModel(addRoute('{prefix: 10.0.0.0/8, via: gw}'));
  assert.equal(r.errors[0].path, 'devices.r1.routes[3].via');
  // a route with an error is not in the model; the others are; the file keeps it
  assert.equal(r.model.index.devices.get('r1').routes.length, 3);
  // host bits: a warning, the route is for the whole prefix
  assert.match(validate.loadModel(addRoute('{prefix: 10.1.2.3/16, via: 10.0.12.2}')).warnings[0].message, /10\.1\.2\.3\/16 has bits set beyond \/16; the route is for the whole \/16/);
});

// ------------------------------------------------------------ the checks

test('check route-nexthop-self: the next hop is the device’s own address', () => {
  assert.deepEqual(findings(net, 'route-nexthop-self'), []);
  const f = findings(addRoute('{prefix: 10.9.0.0/16, via: 10.0.12.1}'), 'route-nexthop-self');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'error');
  assert.equal(f[0].message, 'route 10.9.0.0/16 via 10.0.12.1 on r1: the next hop 10.0.12.1 is an address of r1 itself (e0)');
  assert.deepEqual(f[0].refs, ['route:r1:3', 'iface:r1:e0']);
  assert.equal(f[0].path, 'devices.r1.routes[3].via');
});

test('check route-nexthop-unresolved: not in a connected network of the VRF, and no route resolves it', () => {
  assert.deepEqual(findings(net, 'route-nexthop-unresolved'), []);
  const f = findings(addRoute('{prefix: 10.9.0.0/16, via: 172.16.0.1}'), 'route-nexthop-unresolved');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /route 10\.9\.0\.0\/16 via 172\.16\.0\.1 on r1: the next hop is not in a network directly connected to r1 in the default table and does not resolve through another route \(no route to the next hop 172\.16\.0\.1 in the default table\)/);
  // in another VRF: said so
  const vrf = findings(addRoute('{prefix: 10.9.0.0/16, via: 10.0.12.2, vrf: red}'), 'route-nexthop-unresolved');
  assert.match(vrf[0].message, /10\.0\.12\.2 is in 10\.0\.12\.0\/30 on e0, which is in the default table, not in VRF red/);
  assert.deepEqual(vrf[0].refs, ['route:r1:3', 'iface:r1:e0']);
  // a default route never resolves a next hop
  assert.equal(findings(addRoute('{prefix: 10.9.0.0/16, via: 8.8.8.8}'), 'route-nexthop-unresolved').length, 1);
});

test('check route-nexthop-recursive: a next hop that resolves through another route (info)', () => {
  assert.deepEqual(findings(net, 'route-nexthop-recursive'), []);
  const text = addRoute('{prefix: 10.255.0.2/32, via: 10.0.12.2}').replace('      - {prefix: 10.255.0.2/32', '      - {prefix: 10.9.0.0/16, via: 10.255.0.2}\n      - {prefix: 10.255.0.2/32');
  const f = findings(text, 'route-nexthop-recursive');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /the next hop 10\.255\.0\.2 is not directly connected; it resolves recursively and leaves through e0 to 10\.0\.12\.2/);
  assert.deepEqual(findings(text, 'route-nexthop-unresolved'), []);
});

test('check route-nexthop-interface: the next hop must be in a network of the exit interface (unless it has no address)', () => {
  assert.deepEqual(findings(addRoute('{prefix: 10.9.0.0/16, via: 10.0.12.2, interface: e0}'), 'route-nexthop-interface'), []);
  const f = findings(addRoute('{prefix: 10.9.0.0/16, via: 10.0.13.2, interface: e0}'), 'route-nexthop-interface');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /the next hop 10\.0\.13\.2 is not in a network of its exit interface e0 \(10\.0\.12\.0\/30\)/);
  // an exit interface without an address of its own (unnumbered) can reach any next hop
  assert.deepEqual(findings(addRoute('{prefix: 10.9.0.0/16, via: 10.0.13.2, interface: e2}').replace('links:\n', 'links:\n  - {id: l2, a: "r1:e2", b: "h1:eth0"}\n'), 'route-nexthop-interface'), []);
});

test('check route-exit-interface: a loopback, a member port, an uncabled port or another VRF is no exit', () => {
  const lag = net.replace("      - {id: lo0, type: loopback, ip: 10.255.0.1/32}", "      - {id: lo0, type: loopback, ip: 10.255.0.1/32}\n      - {id: Po1, type: virtual, members: [e1]}");
  const msg = (text) => findings(text, 'route-exit-interface').map((f) => f.message);
  assert.deepEqual(msg(addRoute('{prefix: 10.9.0.0/16, interface: e0}')), []);
  assert.deepEqual(msg(addRoute('{prefix: 10.9.0.0/16, interface: lo0}')), ['route 10.9.0.0/16 dev lo0 on r1: lo0 is a loopback: nothing leaves the device through it']);
  assert.deepEqual(msg(addRoute('{prefix: 10.9.0.0/16, interface: e2}')), ['route 10.9.0.0/16 dev e2 on r1: e2 is a physical port without a cable in the model']);
  assert.deepEqual(msg(lag.replace('      - {prefix: 192.0.2.0/24, blackhole: true}\n', '      - {prefix: 192.0.2.0/24, blackhole: true}\n      - {prefix: 10.9.0.0/16, interface: e1}\n')), ['route 10.9.0.0/16 dev e1 on r1: e1 is a member port of Po1: route through the aggregate Po1']);
  assert.deepEqual(msg(addRoute('{prefix: 10.9.0.0/16, interface: e0, vrf: red}')), ['route 10.9.0.0/16 dev e0 on r1: e0 is in the default table, the route in VRF red']);
  assert.equal(findings(addRoute('{prefix: 10.9.0.0/16, interface: lo0}'), 'route-exit-interface')[0].path, 'devices.r1.routes[3].interface');
});

test('checks route-duplicate and route-conflict: the same route twice; a blackhole and a forwarding route, or two metrics, at one distance', () => {
  assert.deepEqual(findings(net, 'route-duplicate').concat(findings(net, 'route-conflict')), []);
  const dup = findings(addRoute('{prefix: 0.0.0.0/0, via: 10.0.12.2, name: again}'), 'route-duplicate');
  assert.deepEqual(dup.map((f) => [f.severity, f.message, f.refs.join()]), [['warning', 'route 0.0.0.0/0 via 10.0.12.2 on r1 is configured twice in the default table', 'route:r1:3,route:r1:0']]);
  // equal-cost routes to one prefix are not duplicates
  assert.deepEqual(findings(addRoute('{prefix: 0.0.0.0/0, via: 10.0.13.2}'), 'route-duplicate'), []);
  // a blackhole and a forwarding route at the same distance
  const bh = findings(addRoute('{prefix: 192.0.2.0/24, via: 10.0.12.2}'), 'route-conflict');
  assert.deepEqual(bh.map((f) => f.message), ['r1 has a blackhole route and a forwarding route to 192.0.2.0/24 with the same distance 1: they can\'t both be used']);
  // … not when the blackhole floats above it
  assert.deepEqual(findings(addRoute('{prefix: 192.0.2.0/24, via: 10.0.12.2}').replace('{prefix: 192.0.2.0/24, blackhole: true}', '{prefix: 192.0.2.0/24, blackhole: true, distance: 254}'), 'route-conflict'), []);
  // the same next hop twice with different metrics
  const mt = findings(addRoute('{prefix: 0.0.0.0/0, via: 10.0.12.2, metric: 5}'), 'route-conflict');
  assert.match(mt[0].message, /r1 has routes to 0\.0\.0\.0\/0 via the same next hop with the same distance 1 but different metrics \(0, 5\)/);
});

test('findings are attached to their place, never make a model invalid, and do not depend on the order of the file', () => {
  const text = addRoute('{prefix: 10.9.0.0/16, via: 10.0.12.1}');
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors, []);
  const d = doc(text);
  assert.ok(d.valid);
  assert.deepEqual(d.issuesAt(['devices', 0, 'routes', 3, 'via']).map((i) => i.check), ['route-nexthop-self']);
  // the same routes in the other order: the same findings
  const reordered = text.replace('      - {prefix: 0.0.0.0/0, via: 10.0.12.2, name: primary}\n', '').replace('      - {prefix: 10.9.0.0/16, via: 10.0.12.1}\n', '      - {prefix: 10.9.0.0/16, via: 10.0.12.1}\n      - {prefix: 0.0.0.0/0, via: 10.0.12.2, name: primary}\n');
  const msgs = (t) => validate.loadModel(t).findings.map((f) => f.check + ' ' + f.message);
  assert.deepEqual(msgs(reordered), msgs(text));
  // no checks while the format has errors
  assert.deepEqual(validate.loadModel(text + 'bogus: 1\n').findings, []);
});

// ------------------------------------------------------------ editing

test('editing routes: add, duplicate, delete and blackhole are undoable steps; renaming an interface updates its routes', () => {
  const d = doc(net);
  const k = d.addRoute(0, [['prefix', '10.9.0.0/16'], ['via', '10.0.12.2'], ['distance', '20'], ['name', 'lab']]);
  assert.equal(k, 3);
  assert.match(d.exportText(), /\n {6}- \{prefix: 10\.9\.0\.0\/16, via: 10\.0\.12\.2, distance: 20, name: lab\}\n/);
  assert.equal(d.canUndo(), 'Add route');
  assert.deepEqual(d.routeEntries(0)[3], { path: ['devices', 0, 'routes', 3], index: 3, prefix: '10.9.0.0/16', via: '10.0.12.2', iface: '', blackhole: false, distance: '20', metric: '', vrf: '', name: 'lab' });
  // duplicate: a copy right after it (e.g. a backup to edit)
  assert.equal(d.duplicateRoute(0, 3), 4);
  d.setText(['devices', 0, 'routes', 4, 'via'], '10.0.13.2');
  assert.equal(d.result.model.index.devices.get('r1').routes.length, 5);
  // blackhole on removes the next hop in the same step; off again removes the flag
  d.setBlackhole(['devices', 0, 'routes', 4], true);
  assert.match(d.exportText(), /\{prefix: 10\.9\.0\.0\/16, distance: 20, name: lab, blackhole: true\}|\{prefix: 10\.9\.0\.0\/16, blackhole: true, distance: 20, name: lab\}/);
  d.undo();
  assert.match(d.exportText(), /via: 10\.0\.13\.2/);
  d.deleteRoute(0, 4);
  d.deleteRoute(0, 3);
  assert.equal(d.result.model.index.devices.get('r1').routes.length, 3);
  // the last route removes the key
  const one = doc('netatlas: 1\ndevices:\n  - id: r\n    type: router\n    routes:\n      - {prefix: 0.0.0.0/0, interface: e0}\n    interfaces: [e0]\n');
  one.deleteRoute(0, 0);
  assert.doesNotMatch(one.exportText(), /routes/);
  // renaming an exit interface updates the routes that leave through it; references name them
  const e = doc(addRoute('{prefix: 10.9.0.0/16, interface: e0}'));
  assert.deepEqual(e.references('device', 'r1', 'e0').map((p) => p.join('.')).sort(), ['devices.0.routes.3.interface', 'links.0.a']);
  assert.equal(e.renameInterface(['devices', 0, 'interfaces', 0], 'ge0'), 2);
  assert.match(e.exportText(), /\{prefix: 10\.9\.0\.0\/16, interface: ge0\}/);
  assert.ok(e.valid);
});

// ------------------------------------------------------------ display

test('logical view: a route table per VRF in the device box, a line per route, a dotted next-hop line; the Routes switch hides them without moving anything', () => {
  const m = model(addRoute('{prefix: 10.9.0.0/16, interface: e2, vrf: red}').replace('      - {id: e2}', '      - {id: e2, vrf: red, ip: 172.16.0.1/30}'));
  const tables = A.routeTables(m.index.devices.get('r1'));
  assert.deepEqual(tables.map((t) => [t.header, t.lines]), [
    ['Routes', ['0.0.0.0/0 via 10.0.12.2', '0.0.0.0/0 via 10.0.13.2 AD 250', '192.0.2.0/24 blackhole']],
    ['Routes · VRF red', ['10.9.0.0/16 dev e2']],
  ]);
  assert.deepEqual(tables[0].refs, ['route:r1:0', 'route:r1:1', 'route:r1:2']);
  const s = new state.Session(m);
  s.setView('logical');
  const root = s.render().root;
  const lines = scene.findAll(root, (n) => /^route:/.test(n.attrs['data-ref'] || '') && (n.tag === 'tspan' || n.tag === 'text'));
  assert.deepEqual(lines.map((n) => n.attrs['data-ref']).sort(), ['route:r1:0', 'route:r1:1', 'route:r1:2', 'route:r1:3']);
  // the next-hop lines: to r2:e0 and r3:e0; none for the blackhole and the route out of an uncabled port
  const nh = scene.findAll(root, (n) => scene.hasClass(n, 'next-hop'));
  assert.deepEqual(nh.map((n) => `${n.attrs['data-ref']}>${n.attrs['data-target']}`).sort(), ['route:r1:0>iface:r2:e0', 'route:r1:1>iface:r3:e0']);
  // off: no tables, no lines; the boxes keep their size
  const box = (r) => scene.findAll(r, (n) => n.attrs['data-ref'] === 'device:r1' && scene.hasClass(n, 'device'))[0].children[0].attrs;
  const before = box(root);
  s.state.showRoutes = false;
  const off = s.render().root;
  assert.equal(scene.findAll(off, (n) => /^route:/.test(n.attrs['data-ref'] || '')).length, 0);
  assert.deepEqual(box(off), before);
  // the physical view never shows routes
  s.setView('physical');
  s.state.showRoutes = true;
  assert.equal(scene.findAll(s.render().root, (n) => /^route:/.test(n.attrs['data-ref'] || '')).length, 0);
  // every prefix and next hop is in the inventory of drawn addresses (logical view)
  const inv = A.addressInventory(m).filter((a) => a.owner.indexOf('route:') === 0).map((a) => `${a.owner} ${a.field} ${a.text}`);
  assert.deepEqual(inv, ['route:r1:0 prefix 0.0.0.0/0', 'route:r1:0 via 10.0.12.2', 'route:r1:1 prefix 0.0.0.0/0', 'route:r1:1 via 10.0.13.2', 'route:r1:2 prefix 192.0.2.0/24', 'route:r1:3 prefix 10.9.0.0/16']);
});

test('related objects, details, tooltip and Find include routes', () => {
  const m = model(net);
  // a route is related to its device, its exit interface and the interface (and device) of its next hop
  const rel = queries.relatedRefs(m, 'route:r1:1');
  for (const ref of ['route:r1:1', 'device:r1', 'iface:r3:e0', 'device:r3']) assert.ok(rel.has(ref), ref);
  assert.ok(!rel.has('device:r2'));
  assert.deepEqual(Array.from(queries.attachedRefs(m, 'route:r1:0')).sort(), ['iface:r2:e0', 'route:r1:0']);
  // the device highlights its routes; an interface the routes that use it
  assert.ok(queries.relatedRefs(m, 'device:r1').has('route:r1:2'));
  assert.ok(queries.relatedRefs(m, 'iface:r2:e0').has('route:r1:0'));
  // the selection context of a route is that of its device's place: the device selected, the next hop's device related
  const ctx = queries.selectionContext(m, 'route:r1:1');
  assert.equal(ctx.selected, 'device:r1');
  assert.ok(ctx.related.has('device:r3'));
  const det = scene.textOf(panels.detailsFor(m, 'route:r1:1'));
  assert.match(det, /static route/);
  assert.match(det, /destination\n0\.0\.0\.0\/0/);
  assert.match(det, /distance\n250/);
  assert.match(det, /Leaves through e1 to 10\.0\.13\.2/);
  assert.match(scene.textOf(panels.detailsFor(m, 'route:r1:0')), /distance\nnot written \(route selection takes 1\)/);
  assert.match(scene.textOf(panels.detailsFor(m, 'device:r1')), /Static routes \(3\)/);
  assert.match(panels.tooltipFor(m, 'route:r1:2').join('\n'), /r1: 192\.0\.2\.0\/24 blackhole/);
  // Find: by prefix, next hop, name
  assert.deepEqual(queries.search(m, '192.0.2').map((h) => h.ref), ['route:r1:2']);
  assert.ok(queries.search(m, '10.0.13.2').some((h) => h.ref === 'route:r1:1'));
  assert.ok(queries.search(m, 'backup').some((h) => h.ref === 'route:r1:1'));
});

test('a filtered view keeps the routes of the devices it shows; their next-hop lines only to shown devices', () => {
  const m = model(net);
  const f = F.filterModel(m, new Set(['r1', 'r2']), 'logical');
  assert.equal(f.index.devices.get('r1').routes.length, 3);
  assert.ok(f.index.routes.has('r1:1'));
  const s = new state.Session(m);
  s.setView('logical');
  s.setDevices(['r1', 'r2']);
  const nh = scene.findAll(s.render().root, (n) => scene.hasClass(n, 'next-hop'));
  assert.deepEqual(nh.map((n) => n.attrs['data-target']), ['iface:r2:e0']);
  assert.ok(byRef(s.render().root, 'route:r1:1').length > 0, 'the route itself is still in its table');
});
