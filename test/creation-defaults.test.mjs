// New elements get no values the user did not choose (no router / subnet /
// bgp / site / other defaults), and existing values are never changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, load, example, exampleNames } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const style = load('diagram/style.js');

const empty = () => ModelDoc.create();

test('New starts with an empty, valid model', () => {
  const d = empty();
  assert.equal(d.exportText(), 'netatlas: 1\ntitle: New network\n');
  assert.ok(d.valid);
  assert.deepEqual(d.result.model.devices, []);
});

test('every kind of new element gets only an id (a relation also an empty endpoint list)', () => {
  const d = empty();
  for (const k of ['group', 'device', 'link', 'network', 'relation', 'protocol']) d.addEntity(k);
  // (the diagram positions of the new nodes are stored under layout:, as for any edit)
  assert.equal(
    d.exportText().replace(/\n+layout:[\s\S]*$/, '\n'),
    [
      'netatlas: 1',
      'title: New network',
      'protocols:',
      '  - {id: custom1}',
      'groups:',
      '  - id: site1',
      'devices:',
      '  - id: device1',
      'links:',
      '  - {id: link1}',
      'networks:',
      '  - id: net1',
      'relations:',
      '  - id: rel1',
      '    endpoints: []',
      '',
    ].join('\n'),
  );
  assert.ok(!/type:|kind:|protocol:|category:/.test(d.exportText()));
});

test('incomplete new elements: required values are reported, optional ones are simply unset', () => {
  const d = empty();
  d.addEntity('device');
  d.addEntity('network');
  d.addEntity('group');
  d.addEntity('protocol');
  d.addEntity('relation');
  d.addEntity('link');
  const errs = d.errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(errs.some((e) => /^relations\.rel1: missing required key "protocol"/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /^relations\.rel1\.endpoints: a relation needs at least 2 endpoints/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /^links\.link1: missing required key "a"/.test(e)));
  assert.ok(errs.some((e) => /^links\.link1: missing required key "b"/.test(e)));
  assert.ok(d.warnings.some((w) => /protocol "custom1" has no category/.test(w.message)));
  // device type, network kind and group kind are optional: no error, and no value invented
  assert.ok(!errs.some((e) => /device1|net1|site1/.test(e)), errs.join('\n'));
  const m = d.result.model;
  assert.equal(m.devices[0].type, 'generic', 'no device type (drawn with the generic icon)');
  assert.equal(m.networks[0].kind, '', 'no network kind (not "subnet")');
  assert.equal(m.groups[0].kind, '', 'no group kind (not "site")');
  // the issue is located at the relation, for the inline field feedback
  const e = d.errors.find((x) => /missing required key "protocol"/.test(x.message));
  assert.equal(e.key, 'protocol');
  assert.deepEqual(d.issueEntity(e), { kind: 'relation', index: 0 });
});

test('choosing a value saves exactly that value; clearing it removes the key again', () => {
  const d = empty();
  d.addEntity('device');
  d.addEntity('network');
  d.addEntity('relation');
  d.addEntity('group');
  d.addEntity('protocol');
  d.setText(['devices', 0, 'type'], 'firewall');
  d.setText(['networks', 0, 'kind'], 'vlan');
  d.setText(['relations', 0, 'protocol'], 'ospf');
  d.setText(['groups', 0, 'kind'], 'rack');
  d.setText(['protocols', 0, 'category'], 'service');
  const out = d.exportText();
  assert.match(out, /- id: device1\n {4}type: firewall\n/);
  assert.match(out, /- id: net1\n {4}kind: vlan\n/);
  assert.match(out, /- id: rel1\n {4}protocol: ospf\n {4}endpoints: \[\]\n/);
  assert.match(out, /- id: site1\n {4}kind: rack\n/);
  assert.match(out, /- \{id: custom1, category: service\}/);
  const m = d.result.model;
  assert.equal(m.devices[0].type, 'firewall');
  assert.equal(m.networks[0].kind, 'vlan');
  assert.equal(m.groups[0].kind, 'rack');
  assert.equal(m.protocols.get('custom1').category, 'service');
  d.setText(['devices', 0, 'type'], '');
  d.setText(['networks', 0, 'kind'], '');
  assert.ok(!/type:/.test(d.exportText()) && !/kind: vlan/.test(d.exportText()));
});

test('an empty kind is not drawn as a subnet or a site', () => {
  assert.equal(style.networkColor(''), '#868e96');
  assert.notEqual(style.networkColor(''), style.networkColor('subnet'));
  assert.deepEqual(style.groupKindStyle(''), { strong: false });
  assert.deepEqual(style.groupKindStyle('site'), { strong: true });
});

test('duplicating keeps the source element\'s values (only the id changes)', () => {
  const text = example('enterprise-wan.yaml').replace(/\r\n/g, '\n');
  const d = ModelDoc.fromText(text, 'e.yaml', 'file').doc;
  for (const kind of ['device', 'network', 'relation', 'group', 'protocol', 'link']) {
    const src = d.entities(kind)[0];
    const i = d.duplicateEntity(kind, src.index);
    const sec = { device: 'devices', network: 'networks', relation: 'relations', group: 'groups', protocol: 'protocols', link: 'links' }[kind];
    const a = d.get([sec, src.index]);
    const b = d.get([sec, i]);
    const keys = (n) => [...n.entries.keys()];
    assert.deepEqual(keys(b), keys(a), kind);
    for (const k of keys(a)) if (k !== 'id') assert.equal(d.text([sec, i, k]), d.text([sec, src.index, k]), `${kind}.${k}`);
    assert.notEqual(d.text([sec, i, 'id']), d.text([sec, src.index, 'id']));
  }
});

test('importing existing models leaves their values unchanged', () => {
  for (const f of exampleNames) {
    const text = readFileSync(join(root, 'examples', f), 'utf8').replace(/\r\n/g, '\n');
    const d = ModelDoc.fromText(text, f, 'file').doc;
    assert.equal(d.exportText(), text, `${f} is written back byte-for-byte`);
    const m = d.result.model;
    // model values come from the file only: present keys keep their value, absent ones stay empty
    for (const [i, g] of m.groups.entries()) assert.equal(g.kind, (d.text(['groups', i, 'kind']) || '').toLowerCase(), `${f} group ${g.id}`);
    for (const [i, n] of m.networks.entries()) assert.equal(n.kind, (d.text(['networks', i, 'kind']) || '').toLowerCase(), `${f} network ${n.id}`);
    for (const [i, dv] of m.devices.entries()) assert.equal(dv.type, d.text(['devices', i, 'type']) || 'generic', `${f} device ${dv.id}`);
    for (const [i, r] of m.relations.entries()) assert.equal(r.protocol, (d.text(['relations', i, 'protocol']) || '').toLowerCase(), `${f} relation ${r.id}`);
  }
});
