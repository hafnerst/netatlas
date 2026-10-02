// Device-type visibility (the toolbar's Endpoints and Servers controls): it
// narrows what the diagrams show, combines with the device selection without
// changing it, keeps the other devices in place, and never touches the
// document or its saved layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, model, example, root } from './helpers.mjs';

const { Session } = load('diagram/session.js');
const { ModelDoc } = load('editor/document.js');
const { DEVICE_TYPES } = load('model/device-types.js');
const { exportBoxes } = load('diagram/networks-box.js');

const VIEWS = ['physical', 'logical'];
const drawn = (s) => {
  const refs = [];
  const walk = (n) => {
    const r = n.attrs && n.attrs['data-ref'];
    if (r && r.indexOf('device:') === 0 && /\bdevice\b/.test(n.attrs.class || '')) refs.push(r.slice(7));
    (n.children || []).forEach(walk);
  };
  walk(s.render().root);
  return refs.sort();
};
const ofType = (m, t) => m.devices.filter((d) => d.type === t).map((d) => d.id).sort();
const others = (m, types) => m.devices.filter((d) => types.indexOf(d.type) < 0).map((d) => d.id).sort();
const snap = (s, v) => JSON.stringify(Array.from(s.positionsFor(v)));

test('the toolbar controls name the model\'s type identifiers, and are on by default in both views', () => {
  const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  const controls = [...html.matchAll(/<label class="opt"[^>]*><input id="opt-type-([a-z_]+)" type="checkbox" data-device-type="([a-z_]+)" checked> ([^<]+)<\/label>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(controls, [['endpoint', 'endpoint', 'Endpoints'], ['server', 'server', 'Servers']]);
  for (const [, id] of controls) assert.ok(DEVICE_TYPES.some((t) => t.id === id), id);
  // shown in both views (not "logical-only"), next to Labels and Groups / Locations
  assert.ok(html.indexOf('id="opt-groups"') < html.indexOf('id="opt-type-endpoint"'));
  const s = new Session(model(example('device-types.yaml')));
  assert.equal(s.state.hiddenTypes.size, 0);
  assert.equal(s.isFiltered(), false);
});

test('switching a type off hides its devices in both views; the others stay where they were; on again restores the complete diagram exactly', () => {
  const doc = ModelDoc.fromText(example('device-types.yaml'), 'device-types.yaml', 'example').doc;
  const yaml = doc.exportText();
  const m = doc.result.model;
  const s = new Session(m);
  const eps = ofType(m, 'endpoint');
  const srv = ofType(m, 'server');
  assert.ok(eps.length >= 2 && srv.length >= 1);
  const full = Object.fromEntries(VIEWS.map((v) => [v, s.positionsFor(v)]));
  const fullSnap = Object.fromEntries(VIEWS.map((v) => [v, snap(s, v)]));
  // what each view draws without a filter (the logical view leaves out devices without logical content)
  const base = Object.fromEntries(VIEWS.map((v) => (s.setView(v), [v, drawn(s)])));
  assert.ok(eps.every((id) => base.physical.indexOf(id) >= 0));
  const without = (v, ids) => base[v].filter((id) => ids.indexOf(id) < 0);
  assert.equal(s.setTypeVisible('endpoint', false), true);
  assert.equal(s.setTypeVisible('endpoint', false), false, 'no change, nothing to do');
  assert.equal(s.isFiltered(), true);
  for (const v of VIEWS) {
    s.setView(v);
    assert.deepEqual(drawn(s), without(v, eps), v);
    // every device that is still shown keeps its place
    s.positionsFor(v).forEach((p, id) => {
      if (m.index.devices.has(id)) assert.deepEqual(p, full[v].get(id), `${v} ${id}`);
    });
  }
  s.setTypeVisible('server', false);
  for (const v of VIEWS) {
    s.setView(v);
    // (in the logical view a device whose only relations reached a hidden device has nothing left to draw)
    const now = drawn(s);
    assert.ok(now.every((id) => without(v, eps.concat(srv)).indexOf(id) >= 0), v + ' ' + now);
    if (v === 'physical') assert.deepEqual(now, without(v, eps.concat(srv)));
  }
  s.setTypeVisible('endpoint', true);
  s.setTypeVisible('server', true);
  assert.equal(s.isFiltered(), false);
  for (const v of VIEWS) assert.equal(snap(s, v), fullSnap[v], v);
  // the model and the document are never changed
  assert.equal(doc.exportText(), yaml);
  assert.equal(doc.canUndo(), null);
  assert.equal(s.model, m);
});

test('dependent elements follow the device-filter rules: cables and relations to hidden devices go, in the view and in its export', () => {
  const m = model(example('datacenter-evpn.yaml'));
  const s = new Session(m);
  const srv = ofType(m, 'server');
  s.setTypeVisible('server', false);
  for (const v of VIEWS) {
    s.setView(v);
    const vm = s.viewModel();
    assert.ok(vm.devices.every((d) => d.type !== 'server'), v);
    assert.ok(vm.links.every((l) => srv.indexOf(l.a.device) < 0 && srv.indexOf(l.b.device) < 0), v);
    assert.ok(vm.relations.every((r) => r.endpoints.every((e) => srv.indexOf(e.device) < 0)), v);
    // the export describes the scene that is drawn
    const scene = s.render();
    const text = JSON.stringify(scene.root);
    for (const id of srv) assert.ok(text.indexOf(`"device:${id}"`) < 0, `${v} ${id}`);
    const boxes = exportBoxes(vm, v, s.state, { root: scene.root, bounds: scene.bounds });
    assert.ok(boxes.viewBox.w > 0 && boxes.viewBox.h > 0);
  }
  // the complete model still has them all
  assert.equal(ofType(s.model, 'server').length, srv.length);
});

test('combined with the device selection: shown = selected and not of a hidden type; the selection itself is kept', () => {
  const m = model(example('device-types.yaml'));
  const s = new Session(m);
  const eps = ofType(m, 'endpoint');
  const srv = ofType(m, 'server');
  const router = m.devices.find((d) => d.type === 'router').id;
  const pick = [router, eps[0], srv[0]];
  s.setDevices(pick);
  const subset = snap(s, 'physical');
  s.setTypeVisible('server', false);
  assert.deepEqual([...s.selectedDevices()].sort(), pick.slice().sort(), 'the selection is unchanged');
  assert.deepEqual([...s.shownDevices()].sort(), [router, eps[0]].sort());
  assert.deepEqual(drawn(s), [router, eps[0]].sort());
  s.setTypeVisible('endpoint', false);
  assert.deepEqual(drawn(s), [router]);
  s.setTypeVisible('endpoint', true);
  s.setTypeVisible('server', true);
  assert.deepEqual(drawn(s), pick.slice().sort(), 'on again: the previous selection is back');
  // the devices of the selection keep the places they had in the filtered view
  assert.equal(snap(s, 'physical'), subset);
  // Select all while a type is off: every device but those of the hidden type
  s.setTypeVisible('endpoint', false);
  s.setDevices(m.devices.map((d) => d.id));
  assert.equal(s.state.devices, null);
  assert.deepEqual(drawn(s), others(m, ['endpoint']));
  s.setTypeVisible('endpoint', true);
  assert.equal(s.isFiltered(), false);
  // a selection made only of hidden devices shows nothing, and is still there afterwards
  s.setDevices(eps);
  s.setTypeVisible('endpoint', false);
  assert.equal(s.shownDevices().size, 0);
  assert.deepEqual(drawn(s), []);
  s.setTypeVisible('endpoint', true);
  assert.deepEqual(drawn(s), eps);
});

test('the stored layout is untouched: drags and edits while a type is off stay temporary', () => {
  const text = example('device-types.yaml');
  const doc = ModelDoc.fromText(text, 'x.yaml', 'file').doc;
  doc.arrange(['physical']);
  const yaml = doc.exportText();
  const s = new Session(doc.result.model);
  const stored = snap(s, 'physical');
  s.setTypeVisible('server', false);
  const id = s.viewModel('physical').devices[0].id;
  s.moveNode('device:' + id, { x: 5, y: 7 });
  assert.equal(s.commitTemporary('device:' + id), true, 'a move is temporary while filtered');
  assert.equal(doc.exportText(), yaml);
  // an edit keeps the type hidden and the filtered layout stable
  const before = s.positionsFor('physical').get(id);
  doc.setText(['title'], 'Renamed');
  s.setModel(doc.result.model);
  assert.ok(s.isTypeHidden('server'));
  assert.deepEqual(s.positionsFor('physical').get(id), before);
  s.setTypeVisible('server', true);
  assert.equal(snap(s, 'physical'), stored);
});
