// Selection context for the element lists: direct relationships only,
// derived from model ids and references (model/queries.ts selectionContext).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, example, exampleNames, queries, panels, scene, state } from './helpers.mjs';

const wan = model(example('enterprise-wan.yaml'));
const ctxOf = (m, ref) => {
  const c = queries.selectionContext(m, ref);
  return c && { selected: c.selected, related: [...c.related].sort() };
};

/** Every list entity of a model, as refs (protocols: only those defined in the file). */
function entityRefs(m) {
  return [
    ...m.devices.map((d) => 'device:' + d.id),
    ...m.links.map((l) => 'link:' + l.id),
    ...m.networks.map((n) => 'network:' + n.id),
    ...m.relations.map((r) => 'relation:' + r.id),
    ...m.groups.map((g) => 'group:' + g.id),
    ...[...m.protocols.values()].filter((p) => p.custom).map((p) => 'protocol:' + p.id),
  ];
}

test('each element type: selected entity and its direct relationships', () => {
  assert.deepEqual(ctxOf(wan, 'device:muc-sw'), { selected: 'device:muc-sw', related: ['group:branch-muc', 'link:l-muc-ap', 'link:l-muc-sw'] });
  assert.deepEqual(ctxOf(wan, 'link:l-muc-sw'), { selected: 'link:l-muc-sw', related: ['device:muc-rtr', 'device:muc-sw'] });
  assert.deepEqual(ctxOf(wan, 'network:net-transit'), {
    selected: 'network:net-transit',
    related: ['device:hq-fw', 'device:hq-rtr1', 'device:hq-rtr2', 'relation:ibgp-hq', 'relation:ospf-hq-area0'],
  });
  assert.deepEqual(ctxOf(wan, 'relation:gre-muc'), {
    selected: 'relation:gre-muc',
    related: ['device:hq-rtr1', 'device:muc-rtr', 'relation:ipsec-muc', 'relation:ospf-muc'],
  });
  assert.deepEqual(ctxOf(wan, 'relation:ipsec-muc'), {
    selected: 'relation:ipsec-muc',
    related: ['device:hq-rtr1', 'device:muc-rtr', 'link:l-hq-isp1', 'link:l-isp1-inet', 'link:l-muc-inet', 'relation:gre-muc'],
  });
  assert.deepEqual(ctxOf(wan, 'group:hq-core'), {
    selected: 'group:hq-core',
    related: ['device:hq-acc1', 'device:hq-core1', 'device:hq-core2', 'device:hq-log', 'group:hq'],
  });
  assert.deepEqual(ctxOf(wan, 'group:hq'), { selected: 'group:hq', related: ['group:hq-core', 'group:hq-edge'] });
  assert.deepEqual(ctxOf(wan, 'protocol:macsec'), { selected: 'protocol:macsec', related: ['relation:macsec-peer'] });
  assert.ok(ctxOf(wan, 'relation:macsec-peer').related.includes('protocol:macsec'), 'a relation is related to its file-defined protocol');
});

test('direct versus indirect relationships', () => {
  const sw = ctxOf(wan, 'device:muc-sw').related;
  assert.ok(!sw.includes('device:muc-rtr'), 'a neighbour reached only through a cable is indirect');
  assert.ok(!sw.includes('relation:ospf-muc'), 'relations of the neighbour are indirect');
  const core = ctxOf(wan, 'device:hq-core1').related;
  assert.ok(core.includes('group:hq-core') && !core.includes('group:hq'), 'only the own group, not the enclosing site');
  assert.ok(!ctxOf(wan, 'relation:gre-muc').related.includes('link:l-muc-inet'), 'the cables under IPsec are not direct for GRE-over-IPsec');
  assert.ok(!ctxOf(wan, 'group:hq').related.includes('device:hq-core1'), 'devices of a sub-group are indirect');
  assert.ok(!ctxOf(wan, 'relation:gre-muc').related.some((r) => r.startsWith('protocol:')), 'built-in protocols have no list entry');
});

test('ports, hubs and unknown refs', () => {
  assert.deepEqual(ctxOf(wan, 'iface:muc-rtr:wan0'), { selected: 'device:muc-rtr', related: ['link:l-muc-inet', 'relation:ipsec-muc'] });
  const hubRel = wan.relations.find((r) => r.endpoints.length > 2);
  if (hubRel) assert.deepEqual(ctxOf(wan, 'hub:' + hubRel.id), ctxOf(wan, 'relation:' + hubRel.id));
  assert.equal(queries.selectionContext(wan, 'device:nope'), null);
  assert.equal(queries.selectionContext(wan, 'protocol:nope'), null);
  const c = queries.selectionContext(wan, 'device:muc-sw');
  assert.equal(queries.contextState(null, 'device:muc-sw'), null);
  assert.equal(queries.contextState(c, 'device:muc-sw'), 'selected');
  assert.equal(queries.contextState(c, 'link:l-muc-sw'), 'related');
  assert.equal(queries.contextState(c, 'device:hq-fw'), 'unrelated');
});

test('in every example the relationship is symmetric and a subset of the diagram highlight', () => {
  for (const f of exampleNames) {
    const m = model(example(f));
    const refs = entityRefs(m);
    const ifaceRefs = [...m.index.interfaces.keys()].map((k) => 'iface:' + k);
    for (const ref of refs) {
      const c = queries.selectionContext(m, ref);
      assert.ok(c, `${f}: ${ref}`);
      assert.equal(c.selected, ref);
      assert.ok(!c.related.has(ref));
      for (const other of c.related) {
        assert.ok(refs.includes(other), `${f}: ${ref} -> ${other} is a list entry`);
        assert.ok(queries.selectionContext(m, other).related.has(ref), `${f}: ${ref} <-> ${other} must be symmetric`);
      }
    }
    for (const ref of refs.concat(ifaceRefs)) {
      const c = queries.selectionContext(m, ref);
      const keep = queries.relatedRefs(m, ref);
      for (const r of [c.selected, ...c.related]) assert.ok(keep.has(r), `${f}: diagram highlight of ${ref} should include ${r}`);
    }
  }
});

test('the context is view-independent and follows the session selection', () => {
  const s = new state.Session(wan);
  s.select('relation:gre-muc');
  const before = ctxOf(s.model, s.state.selected);
  s.setView('logical');
  assert.deepEqual(ctxOf(s.model, s.state.selected), before);
  assert.deepEqual([...s.highlight()].sort(), [...queries.relatedRefs(wan, 'relation:gre-muc')].sort());
  s.select('protocol:macsec');
  assert.equal(s.state.selected, 'protocol:macsec', 'protocols can be selected (from the list)');
  assert.ok(s.highlight().has('relation:macsec-peer'), 'the diagram highlights the relations of a selected protocol');
  s.select(null);
  assert.equal(s.highlight(), null);
});

test('the right-hand Relations list shows the same states, with text for screen readers', () => {
  const c = queries.selectionContext(wan, 'relation:gre-muc');
  const v = panels.relationList(wan, c);
  const li = (ref) => scene.findAll(v, (n) => n.tag === 'li' && scene.findAll(n, (x) => x.attrs['data-goto'] === ref).length > 0)[0];
  assert.equal(li('relation:gre-muc').attrs.class, 'ctx-selected');
  assert.equal(li('relation:ipsec-muc').attrs.class, 'ctx-related');
  assert.equal(li('relation:syslog-fw').attrs.class, 'ctx-unrelated');
  assert.match(scene.textOf(li('relation:syslog-fw')), /\(not related\)/);
  const plain = panels.relationList(wan, null);
  assert.equal(scene.findAll(plain, (n) => /ctx-/.test(n.attrs.class || '')).length, 0, 'no selection: normal prominence');
});
