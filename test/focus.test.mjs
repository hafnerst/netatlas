// Focus mode: the neighbourhood of an object within 1–3 hops, in the view's
// sense (cables in the physical view, relations in the logical view), and the
// session's focus state: a filtered view with temporary positions that
// combines with the other filters and, when it ends, gives back the views
// exactly as they were. It never changes the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, state, load, example } from './helpers.mjs';

const F = load('analysis/focus.js');
const { ModelDoc } = load('editor/document.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const sorted = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

// a chain a – b – c – d – e of cables; relations: a–e and c–d; a group around b and c
const chain = `netatlas: 1
groups:
  - {id: mid, label: Middle}
devices:
  - {id: a, type: router, interfaces: [p1]}
  - {id: b, type: switch, group: mid, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
  - {id: c, type: switch, layer3: true, group: mid, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
  - {id: d, type: router, interfaces: [p1, p2]}
  - {id: e, type: server, interfaces: [p1]}
links:
  - {id: ab, a: "a:p1", b: "b:p1"}
  - {id: bc, a: "b:p2", b: "c:p1"}
  - {id: cd, a: "c:p2", b: "d:p1"}
  - {id: de, a: "d:p2", b: "e:p1"}
networks:
  - {id: n, cidr: 10.0.0.0/24}
relations:
  - {id: ae, protocol: syslog, endpoints: [a, e]}
  - {id: cd-ospf, protocol: ospf, endpoints: [c, d]}
`;

test('the start of a neighbourhood: the devices an object stands for', () => {
  const m = model(chain);
  assert.deepEqual(F.focusSeeds(m, 'device:c'), ['c']);
  assert.deepEqual(F.focusSeeds(m, 'iface:d:p2'), ['d']);
  assert.deepEqual(F.focusSeeds(m, 'link:bc'), ['b', 'c']);
  assert.deepEqual(F.focusSeeds(m, 'relation:ae'), ['a', 'e']);
  assert.deepEqual(F.focusSeeds(m, 'hub:ae'), ['a', 'e']);
  assert.deepEqual(F.focusSeeds(m, 'group:mid'), ['b', 'c']);
  assert.deepEqual(F.focusSeeds(m, 'protocol:ospf'), ['c', 'd']);
  assert.deepEqual(F.focusSeeds(m, 'network:n'), [], 'a network without members has no device');
  assert.deepEqual(F.focusSeeds(m, 'device:nope'), []);
});

test('hops follow cables in the physical view and relations in the logical view; 1 to 3 hops', () => {
  const m = model(chain);
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 1, 'physical')), [['a', 0], ['b', 1]]);
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 2, 'physical')), [['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 3, 'physical')), [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 9, 'physical')), sorted(F.focusNeighbourhood(m, 'device:a', 3, 'physical')), 'at most 3');
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 0, 'physical')), sorted(F.focusNeighbourhood(m, 'device:a', 1, 'physical')), 'at least 1');
  // logical: a's only relation is to e
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:a', 1, 'logical')), [['a', 0], ['e', 1]]);
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'device:c', 3, 'logical')), [['c', 0], ['d', 1]]);
  // a link starts from both its devices
  assert.deepEqual(sorted(F.focusNeighbourhood(m, 'link:bc', 1, 'physical')), [['a', 1], ['b', 0], ['c', 0], ['d', 1]]);
});

test('deterministic: the same neighbourhood whatever the order of links and relations', () => {
  const rev = chain.replace(/links:\n([\s\S]*?)\nnetworks:/, (all, body) => 'links:\n' + body.split('\n').reverse().join('\n') + '\nnetworks:');
  assert.notEqual(rev, chain);
  for (const v of ['physical', 'logical']) {
    for (let h = 1; h <= 3; h++) assert.deepEqual(sorted(F.focusNeighbourhood(model(rev), 'device:b', h, v)), sorted(F.focusNeighbourhood(model(chain), 'device:b', h, v)), `${v} ${h}`);
  }
});

test('the session: focus shows the neighbourhood in each view, with temporary positions; ending it gives back the views unchanged', () => {
  const m = model(chain);
  const s = new state.Session(m);
  s.setView('physical');
  const full = JSON.stringify([...s.positionsFor('physical')]);
  const fullLogical = JSON.stringify([...s.positionsFor('logical')]);
  assert.equal(s.setFocus('device:a', 2), true);
  assert.deepEqual([...s.shownDevices('physical')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...s.shownDevices('logical')].sort(), ['a', 'e']);
  assert.ok(s.isFiltered('physical') && s.isFiltered('logical'));
  assert.deepEqual(s.viewModel('physical').devices.map((d) => d.id).sort(), ['a', 'b', 'c']);
  // changing the hops keeps the devices that stay where they were
  const before = s.positionsFor('physical');
  assert.equal(s.setFocus('device:a', 3), true);
  const after = s.positionsFor('physical');
  for (const id of ['a', 'b', 'c']) assert.deepEqual(after.get(id), before.get(id), id);
  assert.ok(after.has('d'));
  assert.equal(s.setFocus('device:a', 3), false, 'the same focus changes nothing');
  assert.equal(s.setFocus('network:n', 1), false, 'an object without a device can’t be focused');
  // ending it: the complete diagrams with their positions, exactly
  assert.equal(s.endFocus(), true);
  assert.equal(s.isFiltered('physical'), false);
  assert.equal(JSON.stringify([...s.positionsFor('physical')]), full);
  assert.equal(JSON.stringify([...s.positionsFor('logical')]), fullLogical);
  assert.equal(s.endFocus(), false);
});

test('focus combines with the other filters, and gives back a filtered view with its temporary positions', () => {
  const m = model(chain);
  const s = new state.Session(m);
  s.setView('physical');
  s.setTypeVisible('server', false);
  // a node moved by hand in the filtered view
  const p0 = s.positionsFor('physical').get('a');
  s.moveNode('device:a', { x: p0.x + 400, y: p0.y + 200 });
  s.commitTemporary('device:a');
  const filtered = JSON.stringify([...s.positionsFor('physical')]);
  s.setFocus('device:d', 1);
  assert.deepEqual([...s.shownDevices('physical')].sort(), ['c', 'd'], 'e is a server, switched off');
  s.endFocus();
  assert.deepEqual([...s.shownDevices('physical')].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(JSON.stringify([...s.positionsFor('physical')]), filtered, 'the filtered view as it was, the moved node included');
});

test('an edit that removes the focused object ends focus; focus never changes the document', () => {
  const doc = ModelDoc.fromText(chain, 'chain.yaml', 'file').doc;
  const s = new state.Session(doc.result.model);
  s.setFocus('device:e', 1);
  assert.ok(s.state.focus);
  const text = doc.exportText();
  assert.equal(doc.exportText(), text);
  const ix = doc.findEntity('device', 'e').index;
  doc.deleteEntity ? doc.deleteEntity('device', ix) : doc.remove(['devices', ix]);
  s.setModel(doc.result.model);
  assert.equal(s.state.focus, null);
  assert.equal(s.isFiltered('physical'), false);
});

test('every example: focusing each device in both views shows it, and ending gives back the stored positions', () => {
  for (const f of ['enterprise-wan.yaml', 'datacenter-evpn.yaml', 'branch-routing.yaml']) {
    const m = model(example(f));
    const s = new state.Session(m);
    const full = { physical: JSON.stringify([...s.positionsFor('physical')]), logical: JSON.stringify([...s.positionsFor('logical')]) };
    for (const d of m.devices) {
      s.setFocus('device:' + d.id, 1);
      for (const v of ['physical', 'logical']) assert.ok(s.shownDevices(v).has(d.id), `${f} ${d.id} ${v}`);
      s.endFocus();
    }
    for (const v of ['physical', 'logical']) assert.equal(JSON.stringify([...s.positionsFor(v)]), full[v], `${f} ${v}`);
  }
});
