// Relations and links are attached to the interfaces they reference: the
// geometry of both views, measured on the rendered scene (the same VNode tree
// the page and the SVG export are made from). The browser self-test repeats
// the main checks with real font metrics, in both themes, and on the
// exported SVG file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, model, example, exampleNames, errorsOf, state, scene, load, validate } from './helpers.mjs';
import { logicalBindingProblems, logicalScene, physicalBindingProblems, problems, sideOf } from './scene-geometry.mjs';

const { layoutInput } = load('layout/input.js');
const { strategyPositions } = load('layout/strategies.js');
const { bindingOn } = load('layout/bundles.js');
const { attachedRefs } = load('model/queries.js');

const all = (v, p) => scene.findAll(v, p);
const has = (n, c) => scene.hasClass(n, c);
/** the model without its stored layout: what Auto-arrange gives */
const fresh = (f) => model(example(f).replace(/\nlayout:[\s\S]*$/, '\n'));

function session(m, view, strategy = 'default') {
  const s = new state.Session(m);
  s.setView(view);
  if (strategy !== 'default') {
    s.model.layout[view] = strategyPositions(view, layoutInput(m), strategy);
    s.setModel(s.model);
  }
  return s;
}

// ------------------------------------------------------------------ logical

test('long-labels.yaml: the branch router\'s GRE and OSPF leave from the port of Tunnel10, nothing from Tunnel20', () => {
  const m = fresh('long-labels.yaml');
  const root = session(m, 'logical').render().root;
  const L = logicalScene(root);
  // the bindings of the file, as written: GRE and OSPF on the tunnel interfaces, IPsec on the devices
  const r = (id) => m.index.relations.get(id);
  assert.equal(bindingOn(r('gre-br'), 'br-rtr'), 'Tunnel10');
  assert.equal(bindingOn(r('ospf-br'), 'br-rtr'), 'Tunnel10');
  assert.equal(bindingOn(r('ipsec-br'), 'br-rtr'), undefined);
  const t10 = L.rows.get('br-rtr:Tunnel10');
  const t20 = L.rows.get('br-rtr:Tunnel20');
  const box = L.boxes.get('br-rtr');
  const atBr = (lane) => [lane.pts[0], lane.pts[lane.pts.length - 1]].find((p) => sideOf(L.boxes, p) && sideOf(L.boxes, p).id === 'br-rtr');
  for (const id of ['gre-br', 'ospf-br']) {
    const lane = L.lanes.find((l) => l.ref === 'relation:' + id);
    const p = atBr(lane);
    assert.ok(p && p.y > t10.top && p.y < t10.bottom, `${id} ends beside Tunnel10: ${JSON.stringify(p)} ${JSON.stringify(t10)}`);
    assert.ok(p.y < t20.top - 3, `${id} is well clear of Tunnel20`);
  }
  // the device-level relations leave from the name part, above both tunnels
  for (const id of ['ipsec-br', 'bgp-br', 'bfd-br', 'syslog-br']) {
    const p = atBr(L.lanes.find((l) => l.ref === 'relation:' + id));
    assert.ok(p.y >= box.y && p.y < t10.top, id);
  }
  // Tunnel20 has no relation: no port, no end label
  assert.ok(!L.ports.some((p) => p.ref === 'iface:br-rtr:Tunnel20'));
  assert.ok(!L.endLabels.some((e) => e.ref === 'iface:br-rtr:Tunnel20'));
  // the end label at Tunnel10 names it and the underlay it is sourced from
  const e = L.endLabels.find((x) => x.ref === 'iface:br-rtr:Tunnel10');
  assert.deepEqual(e.lines, ['Tunnel10', 'src: GigabitEthernet0/0/0']);
  const fwLabel = L.endLabels.find((x) => x.ref === 'iface:fw:tunnel.10');
  assert.deepEqual(fwLabel.lines, ['tunnel.10', 'src: ethernet1/1 10.10.0.1']);
  // the underlay line is the "source" field of the interface (the Edit tab highlights it when clicked)
  const t = all(root, (n) => n.tag === 'text' && has(n, 'end-label') && n.attrs['data-ref'] === 'iface:br-rtr:Tunnel10')[0];
  assert.equal(t.children[1].attrs['data-field'], 'source');
  assert.deepEqual(logicalBindingProblems(m, root), []);
  assert.deepEqual(L.leaders, []);
});

test('logical view, every example: each end in the port area of its interface, no lane across a row, end labels beside their ports and clear of text and lines', () => {
  for (const f of exampleNames) {
    for (const strategy of ['default', 'compact', 'spacious']) {
      const m = fresh(f);
      const s = session(m, 'logical', strategy);
      const r = s.render();
      assert.deepEqual(logicalBindingProblems(m, r.root), [], `${f} ${strategy}`);
      assert.deepEqual(problems(r.root), [], `${f} ${strategy}`);
      assert.equal(r.conflicts, 0, `${f} ${strategy}`);
      assert.deepEqual(logicalScene(r.root).leaders.filter((x) => /^iface:/.test(x)), [], `${f} ${strategy}: every end label at its port`);
    }
  }
});

test('the stress example: several tunnels and subinterfaces per device, three relations on one interface, sources, device-level relations, a LAG', () => {
  const m = fresh('port-bindings.yaml');
  const root = session(m, 'logical').render().root;
  const L = logicalScene(root);
  assert.deepEqual(logicalBindingProblems(m, root), []);
  // three lanes leave the port of hub-rtr:Tunnel10, side by side: distinct parallel lines
  const t10 = L.rows.get('hub-rtr:Tunnel10');
  const atHub = (id) =>
    L.lanes
      .filter((l) => l.ref === 'relation:' + id)
      .map((l) => [l.pts[0], l.pts[l.pts.length - 1]].find((p) => (sideOf(L.boxes, p) || {}).id === 'hub-rtr'));
  const ys = ['ipsec-s1', 'bfd-s1'].map((id) => atHub(id)[0].y);
  assert.ok(ys.every((y) => y > t10.top && y < t10.bottom));
  assert.notEqual(ys[0], ys[1]);
  // OSPF rides inside the IPsec tube (both on Tunnel10), on its path
  const ipsec = all(root, (n) => has(n, 'rel') && n.attrs['data-ref'] === 'relation:ipsec-s1')[0];
  const ospf = all(root, (n) => has(n, 'rel') && n.attrs['data-ref'] === 'relation:ospf-s1')[0];
  assert.equal(ospf.children.find((c) => has(c, 'hit')).attrs.d, ipsec.children.find((c) => has(c, 'hit')).attrs.d);
  // tunnels sourced from an interface and from an address: the end label says which
  const label = (ref) => L.endLabels.find((e) => e.ref === ref).lines;
  assert.deepEqual(label('iface:hub-rtr:Tunnel10'), ['Tunnel10', 'src: Gi0/0 203.0.113.1']);
  // (an address of the device's own interface is resolved to that interface: both are named)
  assert.deepEqual(label('iface:hub-rtr:Tunnel30'), ['Tunnel30', 'src: Gi0/0 203.0.113.1']);
  assert.deepEqual(label('iface:spoke2:Tunnel30'), ['Tunnel30', 'src: Gi0/0 198.51.100.22']);
  // subinterfaces have their own ports
  assert.ok(L.ports.some((p) => p.ref === 'iface:hub-rtr:Gi0/1.100') && L.ports.some((p) => p.ref === 'iface:hub-rtr:Gi0/1.200'));
  // device-level relations: a device-level port, no end label
  assert.ok(L.ports.some((p) => p.ref === 'device:hub-rtr' && p.dev) && L.ports.some((p) => p.ref === 'device:core-a' && p.dev));
  assert.ok(!L.endLabels.some((e) => /^device:/.test(e.ref)));
  // the LAG's relation is bound to Po1 on both switches
  assert.ok(L.ports.some((p) => p.ref === 'iface:core-a:Po1') && L.ports.some((p) => p.ref === 'iface:core-b:Po1'));
});

test('dragging a device keeps every end at the port of its interface', () => {
  for (const [f, moves] of [
    ['long-labels.yaml', [['device:br-rtr', 1400, 300], ['device:br-rtr', -900, 900], ['device:fw', 1500, -400]]],
    ['port-bindings.yaml', [['device:spoke1', 0, 700], ['device:hub-rtr', 0, -900], ['device:core-b', 1300, 900], ['device:spoke2', -2600, 1600]]],
    ['enterprise-wan.yaml', [['device:hq-rtr2', -2400, 0], ['device:muc-rtr', 2600, -2000]]],
  ]) {
    const m = fresh(f);
    const s = session(m, 'logical');
    for (const [ref, dx, dy] of moves) {
      const n = s.logicalLayout().nodes.get(ref);
      s.moveNode(ref, { x: n.cx + dx, y: n.cy + dy });
      const r = s.render();
      // (moved to a free place: boxes dropped onto each other are reported as overlaps, and no route can avoid them)
      assert.equal(r.conflicts, 0, `${f}: ${ref} moved to a free place`);
      assert.deepEqual(logicalBindingProblems(m, r.root), [], `${f} after moving ${ref}`);
    }
  }
});

test('ports and end labels are deterministic, and do not depend on the order of the file', () => {
  const text = example('port-bindings.yaml');
  const a = JSON.stringify(session(model(text), 'logical').render().root);
  assert.equal(JSON.stringify(session(model(text), 'logical').render().root), a);
  // the relations and the interfaces of a device in the opposite order
  const lines = text.split('\n');
  const start = lines.indexOf('relations:');
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  - /.test(lines[i])) items.push([lines[i]]);
    else if (items.length && lines[i] !== '') items[items.length - 1].push(lines[i]);
  }
  const reordered = lines.slice(0, start + 1).concat(...items.filter((it) => !/^  #/.test(it[0])).reverse()).join('\n') + '\n';
  const m2 = model(reordered);
  assert.equal(m2.relations[0].id, 'snmp-core');
  const lanes = (m) => {
    const L = logicalScene(session(m, 'logical').render().root);
    return JSON.stringify([L.lanes.map((l) => l.ref + JSON.stringify(l.pts)).sort(), L.ports.map((p) => p.ref + JSON.stringify(p.r)).sort(), L.endLabels.map((e) => e.ref + JSON.stringify(e.rect)).sort()]);
  };
  assert.equal(lanes(m2), lanes(model(text)));
});

test('labels off and protocols hidden: the ports stay where they are, every end still at its port', () => {
  const m = fresh('port-bindings.yaml');
  const s = session(m, 'logical');
  const before = logicalScene(s.render().root).ports.map((p) => p.ref + JSON.stringify(p.r));
  s.state.showLabels = false;
  let root = s.render().root;
  assert.deepEqual(logicalScene(root).endLabels, []);
  assert.deepEqual(logicalScene(root).ports.map((p) => p.ref + JSON.stringify(p.r)), before);
  assert.deepEqual(logicalBindingProblems(m, root), []);
  s.state.showLabels = true;
  s.toggleProtocol('ospf', false);
  root = s.render().root;
  assert.ok(!all(root, (n) => has(n, 'rel') && /ospf/.test(n.attrs['data-ref'])).length);
  assert.deepEqual(logicalBindingProblems(m, root), []);
});

test('a reference to an interface that does not exist is an error, and nothing is attached in its place', () => {
  const text = 'netatlas: 1\ndevices:\n  - {id: r1, type: router, logical_interfaces: [{id: tun0, type: tunnel}, {id: tun1, type: tunnel}]}\n  - {id: r2, type: router, logical_interfaces: [{id: tun0, type: tunnel}]}\nrelations:\n  - {id: gre, protocol: gre, endpoints: ["r1:tun9", "r2:tun0"]}\n';
  const errs = errorsOf(text);
  assert.ok(errs.some((e) => /device "r1" has no interface "tun9"/.test(e.message)), JSON.stringify(errs));
  // the model the page still draws (with the error marked) has no line for it, and no port on r1
  const res = validate.loadModel(text);
  const s = new state.Session(res.model);
  s.setView('logical');
  const root = s.render().root;
  assert.equal(all(root, (n) => has(n, 'rel')).length, 0);
  assert.ok(!all(root, (n) => has(n, 'lport') && /r1/.test(n.attrs['data-ref'])).length);
});

// ----------------------------------------------------------------- physical

test('physical view, every example: each cable end at the port of its interface, on its device\'s side, across no other port; LAG brackets hold members only', () => {
  for (const f of exampleNames) {
    for (const strategy of ['default', 'compact', 'spacious']) {
      const m = fresh(f);
      const r = session(m, 'physical', strategy).render();
      assert.deepEqual(physicalBindingProblems(m, r.root), [], `${f} ${strategy}`);
      assert.deepEqual(problems(r.root), [], `${f} ${strategy}`);
    }
  }
  // the LAG of the stress example: one bracket on each switch, named Po1, around Et1 and Et2
  const m = fresh('port-bindings.yaml');
  const root = session(m, 'physical').render().root;
  const marks = all(root, (n) => has(n, 'lag-mark')).map((n) => n.attrs['data-ref']).sort();
  assert.deepEqual(marks, ['iface:core-a:Po1', 'iface:core-b:Po1']);
  assert.deepEqual(all(root, (n) => has(n, 'lag-label')).map((n) => n.text), ['Po1', 'Po1']);
  // a cable plugged into a device as a whole ends in a hollow square
  assert.equal(all(root, (n) => has(n, 'dev-end')).length, 3);
});

test('physical view: dragging keeps each cable at its ports', () => {
  const m = fresh('port-bindings.yaml');
  const s = session(m, 'physical');
  for (const [ref, dx, dy] of [['device:core-b', -600, 400], ['device:hub-rtr', 700, 0], ['device:inet', -900, 800]]) {
    const b = s.physicalLayout().boxes.get(ref.slice(7));
    s.moveNode(ref, { x: b.cx + dx, y: b.cy + dy });
    assert.deepEqual(physicalBindingProblems(m, s.render().root), [], `after moving ${ref}`);
  }
});

// -------------------------------------------------------------- interaction

test('pointing at an interface marks its relations and cable; at a relation or link, the interfaces at its ends', () => {
  const m = fresh('port-bindings.yaml');
  const t10 = attachedRefs(m, 'iface:hub-rtr:Tunnel10');
  for (const r of ['ipsec-s1', 'ospf-s1', 'bfd-s1']) assert.ok(t10.has('relation:' + r), r);
  assert.ok(!t10.has('relation:gre-s2') && !t10.has('iface:hub-rtr:Tunnel20'));
  assert.deepEqual([...attachedRefs(m, 'relation:ospf-s1')].sort(), ['hub:ospf-s1', 'iface:hub-rtr:Tunnel10', 'iface:spoke1:Tunnel10', 'relation:ospf-s1']);
  // a device-level relation: the devices themselves
  assert.ok(attachedRefs(m, 'relation:syslog-hub').has('device:hub-rtr') && attachedRefs(m, 'relation:syslog-hub').has('iface:nms:eth0'));
  // a link: its ports and the aggregate they belong to; the aggregate: the cables of its members
  assert.deepEqual([...attachedRefs(m, 'link:lag-1')].sort(), ['iface:core-a:Et1', 'iface:core-a:Po1', 'iface:core-b:Et1', 'iface:core-b:Po1', 'link:lag-1']);
  const po = attachedRefs(m, 'iface:core-a:Po1');
  assert.ok(po.has('link:lag-1') && po.has('link:lag-2') && po.has('relation:lacp-po1'));
  assert.equal(attachedRefs(m, 'device:hub-rtr'), null);
  // every mark has something to land on: each ref is drawn in the view it belongs to
  const drawn = new Set(all(session(m, 'logical').render().root, (n) => !!n.attrs['data-ref']).map((n) => n.attrs['data-ref']));
  for (const ref of t10) assert.ok(drawn.has(ref) || /^hub:/.test(ref), ref);
});

test('selecting a relation or link highlights the interfaces at both ends (port, entry, end label)', () => {
  const m = fresh('long-labels.yaml');
  const s = session(m, 'logical');
  s.select('relation:ospf-br');
  const keep = s.highlight();
  assert.ok(keep.has('iface:br-rtr:Tunnel10') && keep.has('iface:fw:tunnel.10') && !keep.has('iface:br-rtr:Tunnel20'));
  const root = s.render().root;
  const kinds = new Set(all(root, (n) => n.attrs['data-ref'] === 'iface:br-rtr:Tunnel10').map((n) => (has(n, 'lport') ? 'port' : has(n, 'end-label') ? 'label' : has(n, 'if-entry') ? 'entry' : '?')));
  assert.deepEqual([...kinds].sort(), ['entry', 'label', 'port']);
});

test('the ports and end labels have their own styles in both themes (contrast is checked in theme.test.mjs and the self-test)', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.lport \{[^}]*fill: var\(--text\)/);
  assert.match(css, /\.lport\.dev-port \{[^}]*fill: var\(--canvas\)[^}]*stroke: var\(--text\)/);
  assert.match(css, /\.end-label \{[^}]*fill: var\(--text\)/);
  assert.match(css, /\.lag-mark \{[^}]*stroke: var\(--text\)/);
  // the marks of what is pointed at or selected are outlines and weights, not colours alone
  assert.match(css, /\.hover-hl\.end-label[^{]*\{[^}]*text-decoration: underline/);
  assert.match(css, /\.has-selection rect\.hl\.lport[^{]*\{[^}]*stroke-width/);
});
