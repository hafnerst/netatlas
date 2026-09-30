// Focused tests for module APIs introduced or made explicit by the layered
// structure: editing operations, the single format schema, model queries,
// file-name helpers, and the check that the checked-in HTML is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, load, validate, queries, example, model } from './helpers.mjs';

const { ModelDoc, KEY_ORDER } = load('editor/document.js');
const { SCHEMA } = load('yaml/schema.js');
const files = load('ui/files.js');

const doc = (text) => ModelDoc.fromText(text, 't.yaml', 'file').doc;
const base = `netatlas: 2
devices:
  - id: r1   # the router
    interfaces: [eth0]
  - id: r2
    interfaces: [eth0, lo0]
links:
  - {id: l1, a: "r1:eth0", b: "r2:eth0"}
relations:
  - id: bgp
    protocol: ebgp
    endpoints: [r1, r2]
networks:
  - {id: n1, cidr: 10.0.0.0/24}
`;

// ------------------------------------------------------------ editing operations

test('text, integer, flag and value edits: canonical key order, empty removes, one undo step each', () => {
  const d = doc(base);
  d.setText(['devices', 0, 'vendor'], 'Acme');
  d.setText(['devices', 0, 'label'], 'Router 1');
  d.setInteger(['devices', 0, 'tier'], '2');
  d.setFlag(['relations', 0, 'directed'], true);
  d.setValue(['devices', 0, 'attrs'], ''); // null value, key kept
  let out = d.exportText();
  assert.match(out, /- id: r1 {3}# the router\n {4}label: Router 1\n {4}vendor: Acme\n {4}tier: 2\n {4}attrs:\n {4}interfaces: \[eth0\]/);
  assert.match(out, /directed: true/);
  d.setText(['devices', 0, 'vendor'], '');
  d.setFlag(['relations', 0, 'directed'], false);
  d.setInteger(['devices', 0, 'tier'], 'high'); // kept as text, reported by validation
  out = d.exportText();
  assert.ok(!/vendor:/.test(out) && !/directed:/.test(out));
  assert.ok(d.errors.some((e) => /tier must be an integer/.test(e.message)));
  // every operation was one undo step
  let n = 0;
  while (d.undo()) n++;
  assert.equal(n, 8);
  assert.equal(d.exportText(), doc(base).exportText());
});

test('free-form values are typed like YAML and survive export -> reload', () => {
  const d = doc(base);
  assert.equal(d.addField(['relations', 0, 'attrs'], 'asn', 'value'), 'ok');
  d.setValue(['relations', 0, 'attrs', 'asn'], '65001');
  assert.equal(d.addField(['relations', 0, 'attrs'], 'timers', 'group'), 'ok');
  d.addField(['relations', 0, 'attrs', 'timers'], 'hold', 'value');
  d.setValue(['relations', 0, 'attrs', 'timers', 'hold'], '90s');
  d.addField(['relations', 0, 'attrs'], 'families', 'list');
  d.pushItem(['relations', 0, 'attrs', 'families'], 'value');
  d.setValue(['relations', 0, 'attrs', 'families', 0], 'ipv4');
  assert.equal(d.addField(['relations', 0, 'attrs'], 'asn', 'value'), 'exists');
  assert.equal(d.renameField(['relations', 0, 'attrs'], 'asn', 'timers'), 'exists');
  assert.equal(d.renameField(['relations', 0, 'attrs'], 'asn', 'peer-as'), 'ok');
  const back = doc(d.exportText());
  assert.deepEqual(back.result.model.relations[0].attrs, [['peer-as', '65001'], ['timers.hold', '90s'], ['families', 'ipv4']]);
  assert.equal(back.get(['relations', 0, 'attrs', 'peer-as']).value, 65001, 'a number stays a number');
});

test('lists and endpoints: short forms stay short, mappings keep their keys', () => {
  const d = doc(base);
  d.appendText(['devices', 1, 'interfaces', 1, 'ip'], '10.0.0.2/32');
  d.appendText(['networks', 0, 'cidr'], '2001:db8::/64');
  assert.match(d.exportText(), /cidr: \[10\.0\.0\.0\/24, 2001:db8::\/64\]/);
  d.setEndpoint(['relations', 0, 'endpoints', 0], 'r1', 'eth0');
  d.setEndpoint(['links', 0, 'b'], 'r2', '');
  assert.match(d.exportText(), /endpoints: \[r1:eth0, r2\]/);
  assert.match(d.exportText(), /b: r2\b/);
  d.setEndpointField(['relations', 0, 'endpoints', 1, 'role'], 'rr-client');
  assert.match(d.exportText(), /endpoints: \[r1:eth0, \{device: r2, role: rr-client\}\]/);
  d.setEndpoint(['relations', 0, 'endpoints', 1], 'r2', 'lo0');
  assert.match(d.exportText(), /\{device: r2, interface: lo0, role: rr-client\}/);
  d.moveUp(['relations', 0, 'endpoints', 1]);
  assert.match(d.exportText(), /endpoints: \[\{device: r2, interface: lo0, role: rr-client\}, r1:eth0\]/);
  d.setEndpoint(['relations', 0, 'endpoints', 1], '', '');
  assert.match(d.exportText(), /endpoints: \[\{device: r2, interface: lo0, role: rr-client\}\]/);
  d.remove(['links', 0]);
  assert.ok(!/l1/.test(d.exportText()));
});

test('moving an unknown key into attrs keeps its value and clears the error', () => {
  const d = doc(base.replace('  - id: r2\n', '  - id: r2\n    colour: {r: 1}\n'));
  assert.ok(d.errors.some((e) => /unknown key "colour"/.test(e.message)));
  assert.equal(d.moveIntoAttrs(['devices', 1], 'colour'), 'ok');
  assert.ok(d.valid);
  assert.match(d.exportText(), /attrs:\n {6}colour: \{r: 1\}/);
  assert.equal(d.moveIntoAttrs(['devices', 1], 'nope'), 'missing');
});

test('schemaKindOf derives the canonical key order from a path', () => {
  const d = doc(base);
  assert.equal(d.schemaKindOf([]), 'top');
  assert.equal(d.schemaKindOf(['devices', 0]), 'device');
  assert.equal(d.schemaKindOf(['devices', 0, 'interfaces', 1]), 'interface');
  assert.equal(d.schemaKindOf(['relations', 0, 'endpoints', 0]), 'endpoint');
  assert.equal(d.schemaKindOf(['links', 0, 'a']), 'linkEnd');
  assert.equal(d.schemaKindOf(['links', 0, 'b']), 'linkEnd');
  assert.equal(d.schemaKindOf(['networks', 0, 'members', 0]), undefined);
  assert.equal(d.schemaKindOf(['devices', 0, 'attrs']), undefined);
});

// ------------------------------------------------------------ schema

test('the format schema is the single source for allowed keys and key order', () => {
  assert.equal(KEY_ORDER, SCHEMA, 'the editor uses the schema itself, not a copy');
  for (const [kind, section, sample] of [
    ['device', 'devices', '{id: d}'],
    ['link', 'links', '{id: l, a: d, b: d}'],
    ['group', 'groups', '{id: g}'],
    ['network', 'networks', '{id: n}'],
  ]) {
    const text = `netatlas: 2\ndevices:\n  - {id: d}\n${section === 'devices' ? '' : section + ':\n  - ' + sample + '\n'}`;
    const withKey = (k) => text.replace(section === 'devices' ? '{id: d}' : sample, (m) => m.replace('}', `, ${k}: x}`));
    // every key in the schema is accepted (value types aside), and nothing else
    const unknown = validate.loadModel(withKey('not_in_schema')).errors.filter((e) => /unknown key/.test(e.message));
    assert.equal(unknown.length, 1, kind);
    for (const k of SCHEMA[kind]) {
      const errs = validate.loadModel(withKey(k)).errors.filter((e) => /unknown key/.test(e.message));
      assert.deepEqual(errs, [], `${kind}.${k} should be a known key`);
    }
  }
});

// ------------------------------------------------------------ model queries

test('model queries are independent of view state', () => {
  const m = model(example('enterprise-wan.yaml'));
  assert.deepEqual(queries.splitRef('iface:r1:ge-0/0/0'), ['iface', 'r1:ge-0/0/0']);
  assert.ok(queries.refExists(m, 'iface:hq-rtr1:ge-0/0/0'));
  assert.ok(!queries.refExists(m, 'device:nope'));
  assert.ok(queries.relatedRefs(m, 'device:muc-rtr').has('relation:gre-muc'));
});

// ------------------------------------------------------------ files

test('export file names: imported files become a new "-edited" copy; typed names are made safe', () => {
  assert.equal(files.exportFileName('acme.yaml', 'file'), 'acme-edited.yaml');
  assert.equal(files.exportFileName('acme-edited.yml', 'file'), 'acme-edited.yaml');
  assert.equal(files.exportFileName('new-network.yaml', 'new'), 'new-network.yaml');
  assert.equal(files.exportFileName('', null), 'network.yaml');
  assert.equal(files.safeYamlFileName('  ', 'x.yaml'), 'x.yaml');
  assert.equal(files.safeYamlFileName('my net', 'x.yaml'), 'my net.yaml');
  assert.equal(files.safeYamlFileName('../etc/pw?.yml', 'x.yaml'), '.._etc_pw_.yml');
});

// ------------------------------------------------------------ build reproducibility

test('check:dist accepts the current build and rejects a stale HTML file', () => {
  const html = join(root, 'dist', 'netatlas.html');
  // the checked-in file (rebuilt by "npm test") matches a fresh build
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--check'], { stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'netatlas-check-'));
  const stale = join(dir, 'stale.html');
  copyFileSync(html, stale);
  appendFileSync(stale, ' ');
  assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--check', '--target', stale], { stdio: 'pipe' }));
  // the generated examples module is current as well
  execFileSync(process.execPath, [join(root, 'scripts', 'gen-examples.mjs'), '--check'], { stdio: 'pipe' });
  assert.ok(readFileSync(html, 'utf8').includes('__req("app/main")'));
});
