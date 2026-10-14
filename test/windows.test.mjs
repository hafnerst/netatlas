// The Analyze windows' content and what this version removed. Pure (no
// browser): the Single points of failure table (rows, impact, sorting,
// filtering, CSV, text), the Trace path table's columns, the commands of
// the tool windows; and the removal of scenarios (a `scenarios:` key is an
// unknown key), risk groups, X and the step keys. The windows themselves,
// in a browser: test/toolwindow.test.mjs and the self-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validate, load, example, root } from './helpers.mjs';

const W = load('ui/spof.js');
const F = load('analysis/failure.js');
const Tr = load('ui/trace.js');
const C = load('ui/commands.js');

const wan = validate.loadModel(example('enterprise-wan.yaml')).model;

test('Single points of failure: one row per point, with element, type, what it cuts off, the relations that go down and the impact, most impact first', () => {
  const rows = W.spofRows(wan, F.singlePointsOfFailure(wan));
  assert.ok(rows.length > 5);
  const fw = rows.find((r) => r.ref === 'device:hq-fw');
  assert.equal(fw.type, 'Device');
  assert.match(fw.cuts, /hq-acc1, hq-core1, hq-core2, hq-log/);
  assert.equal(fw.impact, fw.devicesCut + fw.relationsDown);
  const lag = rows.find((r) => r.type === 'LAG');
  assert.match(lag.element, /\(2 cables\)$/);
  // the default view: most impact first (ties keep the report's order)
  const shown = W.shownSpofRows(rows, W.newSpofViewState());
  assert.ok(shown.every((r, i) => i === 0 || shown[i - 1].impact >= r.impact));
});

test('sorting by any column, both ways; filtering by words (all must occur)', () => {
  const rows = W.spofRows(wan, F.singlePointsOfFailure(wan));
  const by = (sort, desc) => W.shownSpofRows(rows, { sort, desc, filter: '' });
  const names = by('element', false).map((r) => r.element.toLowerCase());
  assert.deepEqual(names, names.slice().sort());
  assert.deepEqual(by('element', true).map((r) => r.element.toLowerCase()), names.slice().reverse());
  const types = by('type', false).map((r) => r.type);
  assert.deepEqual(types, types.slice().sort());
  assert.ok(by('relations', true).every((r, i, a) => i === 0 || a[i - 1].relationsDown >= r.relationsDown));
  assert.ok(by('cuts', false).every((r, i, a) => i === 0 || a[i - 1].devicesCut <= r.devicesCut));
  const f = W.shownSpofRows(rows, { sort: 'impact', desc: true, filter: 'cable  ham' });
  assert.ok(f.length >= 1 && f.every((r) => r.type === 'Cable' && /ham/i.test(`${r.element} ${r.cuts} ${r.relations}`)));
  assert.deepEqual(W.shownSpofRows(rows, { sort: 'impact', desc: true, filter: 'nothing-like-this' }), []);
});

test('the table as CSV (quoted where needed) and as text', () => {
  const rows = W.spofRows(wan, F.singlePointsOfFailure(wan));
  const csv = W.spofCsv(rows);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'element,type,cuts_off,relations_down,devices_cut_off,relations_down_count,impact');
  assert.equal(lines.length, rows.length + 1);
  assert.match(csv, /^hq-fw,Device,"hq-acc1, hq-core1, hq-core2, hq-log/m);
  const text = W.spofText(wan, rows);
  assert.match(text, /^Single points of failure — ACME Corp — enterprise WAN\n\d+ single points of failure, most impact first\./);
  assert.match(text, /Device hq-fw \(impact \d+\)\n  cuts off: hq-acc1, hq-core1, hq-core2, hq-log/);
  // a model without any
  const ring = validate.loadModel(example('metro-ring.yaml')).model;
  const none = W.spofRows(ring, []);
  assert.equal(W.spofCsv(none).trim().split('\n').length, 1);
});

test('Trace path: the hop table’s columns; the tool windows’ commands (F6, Close) and the Analyze entries that open them', () => {
  assert.deepEqual(Tr.HOP_COLUMNS, ['#', 'Device', 'In', 'Out', 'Addresses', 'Route or relation', 'Encapsulation']);
  const cmds = new Map(C.buildCommands().map((c) => [c.id, c]));
  assert.equal(C.keyLabel(cmds.get('window.focus').keys), 'F6');
  assert.equal(cmds.get('window.focus').keys.whileTyping, true, 'F6 works while typing in a field');
  for (const id of ['analyze.addressing', 'focus.window', 'trace.open', 'analyze.spof', 'sim.start']) assert.match(cmds.get(id).label, /…$/, id);
  assert.equal(C.keyLabel(cmds.get('analyze.addressing').keys), 'I');
  assert.equal(C.keyLabel(cmds.get('focus.window').keys), 'Shift+F');
  assert.equal(C.keyLabel(cmds.get('trace.open').keys), 'T');
});

test('removed: scenarios (a scenarios: key is unknown), their templates and steps, risk groups and maintenance, X and the step keys, the Analysis and Simulation tabs', () => {
  const r = validate.loadModel('netatlas: 1\ndevices: [{id: a}]\nscenarios:\n  - id: s\n    steps: [{fail: {device: a}}]\n');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /^unknown key "scenarios"/);
  const rg = validate.loadModel('netatlas: 1\ndevices: [{id: a, risk_groups: [x]}]\n');
  assert.match(rg.errors[0].message, /^unknown key "risk_groups"/);
  assert.equal('scenarios' in validate.loadModel('netatlas: 1\n').model, false);
  for (const m of ['analysis/scenario.ts', 'analysis/templates.ts', 'validation/scenarios.ts', 'ui/simulation.ts', 'ui/templates.ts', 'ui/traffic.ts']) assert.equal(existsSync(join(root, 'src', m)), false, m);
  const ids = C.buildCommands().map((c) => c.id);
  for (const id of ['sim.add', 'sim.prev', 'sim.next', 'sim.save', 'sim.templates', 'sim.traffic', 'sim.trafficPause', 'panel.analysis', 'panel.simulation']) assert.ok(ids.indexOf(id) < 0, id);
  const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="(analysis|simulation)"/);
  assert.doesNotMatch(html, /mi-hint">(X|\[|\])</);
  // nothing in the examples still writes them
  for (const f of ['enterprise-wan.yaml', 'datacenter-evpn.yaml', 'ospf-reroute.yaml']) assert.doesNotMatch(example(f), /^(scenarios:|\s+risk_groups:)/m, f);
});
