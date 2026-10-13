// Scenarios (analysis/scenario.ts, validation/scenarios.ts, the editing core):
// named, ordered steps that fail or restore devices, cables, ports, relations
// and LAGs, played as an overlay on the model. Step playback forwards and
// back, what changed since the previous step, determinism, validation of the
// `scenarios:` section (steps whose objects no longer exist are warnings),
// saving and editing scenarios as undoable edits, references that follow
// renames, and the lock that blocks every other edit during a simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const S = load('analysis/scenario.js');
const F = load('analysis/failure.js');
const { ModelDoc, EditLocked } = load('editor/document.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const step = (action, kind, id) => ({ action, target: { kind, id }, line: 0 });

test('the example’s scenarios are read: ids, labels, steps with their targets and notes', () => {
  const m = model(example('enterprise-wan.yaml'));
  assert.deepEqual(
    m.scenarios.map((s) => [s.id, s.label, s.steps.length]),
    [
      ['isp1-outage', 'ISP 1 outage', 3],
      ['core-peer-loss', 'Core peer link and core switch', 3],
      // proposed by the scenario templates and saved
      ['uplink-outage-at-hq-berlin', 'Uplink outage at HQ Berlin', 1],
      ['shared-risk-failure-duct-alexanderplatz', 'Shared-risk failure: duct-alexanderplatz', 1],
      ['vrrp-failover-of-10-10-10-1', 'VRRP failover of 10.10.10.1', 1],
      ['tunnel-failover-ham-rtr-hq-rtr2', 'Tunnel failover ham-rtr – hq-rtr2', 1],
      ['rolling-maintenance-of-hq-core1-and-hq-core2', 'Rolling maintenance of hq-core1 and hq-core2', 4],
    ],
  );
  const s = m.scenarios[0];
  assert.deepEqual(s.steps[0].target, { kind: 'cable', id: 'l-hq-isp1' });
  assert.equal(s.steps[0].note, 'the carrier reports a fibre cut');
  assert.deepEqual(s.steps.map((x) => S.stepText(m, x)), ['Fail cable l-hq-isp1', 'Fail hq-rtr1', 'Restore hq-rtr1']);
  assert.deepEqual(validate.loadModel(example('enterprise-wan.yaml')).warnings, []);
});

test('playing steps: each step is the state after the steps before it; restore takes a failure back; a LAG fails its member cables', () => {
  const m = model(example('enterprise-wan.yaml'));
  const sc = m.scenarios[1];
  assert.deepEqual(S.failedAfter(m, sc.steps, 0), []);
  assert.deepEqual(S.failedAfter(m, sc.steps, 1), ['link:l-peer1', 'link:l-peer2']);
  assert.deepEqual(S.failedAfter(m, sc.steps, 2), ['device:hq-core1', 'link:l-peer1', 'link:l-peer2']);
  assert.deepEqual(S.failedAfter(m, sc.steps, 3), ['device:hq-core1']);
  // forwards and back give the same results, whatever was computed before
  const v2 = S.stepView(m, sc.steps, 2);
  assert.equal(v2.index, 2);
  assert.equal(v2.res.relations.get('lag-peer'), 'down');
  assert.equal(v2.res.relations.get('vrrp-users'), 'degraded');
  const back = S.stepView(m, sc.steps, 1);
  assert.equal(back.res.relations.get('lag-peer'), 'down');
  assert.equal(back.res.devices.get('hq-core1'), 'degraded');
  // clamped
  assert.equal(S.stepView(m, sc.steps, 99).index, 3);
  assert.equal(S.stepView(m, sc.steps, -1).index, 0);
  // the same as the failure simulation of the same objects
  const direct = F.simulate(m, ['device:hq-core1', 'link:l-peer1', 'link:l-peer2']);
  assert.deepEqual([...v2.res.relations], [...direct.relations]);
});

test('deterministic: the order of steps that fail different objects, and earlier runs, never change a result', () => {
  const m = model(example('enterprise-wan.yaml'));
  const a = [step('fail', 'device', 'hq-core1'), step('fail', 'cable', 'l-hq-isp1'), step('fail', 'relation', 'ospf-ham')];
  const b = [a[2], a[0], a[1]];
  const va = S.stepView(m, a, 3);
  const m2 = model(example('enterprise-wan.yaml'));
  const vb = S.stepView(m2, b, 3);
  const flat = (v) => JSON.stringify({ f: v.failed, d: [...v.res.devices], l: [...v.res.links], r: [...v.res.relations], n: [...v.res.networks], rt: [...v.res.routes], lost: v.lost.pairs });
  assert.equal(flat(va), flat(vb));
  // and again on the same model (cached) the same
  assert.equal(flat(S.stepView(m, a, 3)), flat(va));
});

test('what changed since the previous step: down, degraded, recovered, device pairs lost and regained', () => {
  const m = model(example('enterprise-wan.yaml'));
  const sc = m.scenarios[0];
  const v0 = S.stepView(m, sc.steps, 0);
  const v1 = S.stepView(m, sc.steps, 1);
  const v2 = S.stepView(m, sc.steps, 2);
  const v3 = S.stepView(m, sc.steps, 3);
  const d1 = S.stepDiff(v0, v1);
  assert.ok(d1.down.includes('link:l-hq-isp1'), d1.down.join(' '));
  assert.ok(d1.down.includes('relation:ipsec-muc'));
  assert.ok(d1.degraded.includes('device:hq-rtr1'));
  assert.deepEqual(d1.recovered, []);
  assert.ok(d1.lost.some((p) => p.from === 'hq-fw' && p.to === 'muc-rtr'));
  const d2 = S.stepDiff(v1, v2);
  assert.deepEqual(d2.down.filter((r) => r.startsWith('device:')), ['device:hq-rtr1']);
  // hq-rtr1 back while its ISP cable is still cut: the router is degraded instead of down, its LAN side is up again, the tunnels stay down
  const d3 = S.stepDiff(v2, v3);
  assert.ok(d3.recovered.includes('device:hq-rtr1') && d3.recovered.includes('link:l-rtr1-fw'), d3.recovered.join(' '));
  assert.ok(!d3.recovered.includes('relation:ipsec-muc') && !d3.recovered.includes('link:l-hq-isp1'));
  assert.ok(S.diffEmpty(S.stepDiff(v1, v1)));
  // and back to the model: everything recovers, the pairs reach again
  const all = S.stepDiff(v1, v0);
  assert.ok(all.recovered.includes('link:l-hq-isp1') && all.regained.some((p) => p.from === 'hq-fw' && p.to === 'muc-rtr'));
});

test('targets: resolved to what fails, from a selection, labelled; what can’t be resolved says why and is skipped', () => {
  const m = model(example('enterprise-wan.yaml'));
  assert.deepEqual(S.resolveTarget(m, { kind: 'lag', id: 'hq-core1:Port-Channel1' }), { refs: ['link:l-peer1', 'link:l-peer2'] });
  assert.deepEqual(S.resolveTarget(m, { kind: 'port', id: 'hq-core1:Ethernet49' }), { refs: ['iface:hq-core1:Ethernet49'] });
  assert.match(S.resolveTarget(m, { kind: 'lag', id: 'hq-core1:Ethernet49' }).problem, /is not a LAG/);
  assert.match(S.resolveTarget(m, { kind: 'device', id: 'nope' }).problem, /no device "nope"/);
  assert.match(S.resolveTarget(m, { kind: 'port', id: 'hq-core1' }).problem, /device:interface/);
  assert.deepEqual(S.targetOfRef(m, 'link:l-peer1'), { kind: 'cable', id: 'l-peer1' });
  assert.deepEqual(S.targetOfRef(m, 'iface:hq-core1:Ethernet49'), { kind: 'port', id: 'hq-core1:Ethernet49' });
  assert.equal(S.targetOfRef(m, 'network:net-users'), null);
  assert.equal(S.targetLabel(m, { kind: 'lag', id: 'hq-core1:Port-Channel1' }), 'LAG hq-core1:Port-Channel1');
  assert.equal(S.targetLabel(m, { kind: 'relation', id: 'ospf-muc' }), 'OSPF ospf-muc');
  // an unresolved step is skipped
  assert.deepEqual(S.failedAfter(m, [step('fail', 'device', 'gone'), step('fail', 'cable', 'l-peer1')], 2), ['link:l-peer1']);
  assert.equal(S.scenarioId('ISP 1 outage!', ['isp1-outage']), 'isp-1-outage');
  assert.equal(S.scenarioId('ISP 1 outage', ['isp-1-outage']), 'isp-1-outage-2');
  assert.equal(S.scenarioId('***', []), 'scenario');
});

test('validation: the form of the scenarios section is checked; a step whose object is gone is a warning, not an error', () => {
  const base = 'netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l1, a: "a:e0", b: "b:e0"}\n';
  const msgs = (t) => {
    const r = validate.loadModel(base + t);
    return { errors: r.errors.map((e) => e.message), warnings: r.warnings.map((w) => `${w.path}: ${w.message}`) };
  };
  assert.deepEqual(msgs('scenarios:\n  - id: s\n    steps:\n      - fail: {cable: l1}\n      - restore: {cable: l1}\n'), { errors: [], warnings: [] });
  const gone = msgs('scenarios:\n  - id: s\n    steps:\n      - fail: {device: c}\n      - fail: {port: "a:e9"}\n');
  assert.deepEqual(gone.errors, []);
  assert.deepEqual(gone.warnings, [
    `scenarios.s.steps[0].fail.device: this step can't be played: there is no device "c" (the scenario skips it)`,
    `scenarios.s.steps[1].fail.port: this step can't be played: there is no interface "a:e9" (the scenario skips it)`,
  ]);
  assert.match(msgs('scenarios:\n  - id: s\n    steps:\n      - {fail: {cable: l1}, restore: {cable: l1}}\n').errors[0], /a step does one thing/);
  assert.match(msgs('scenarios:\n  - id: s\n    steps:\n      - note: x\n').errors[0], /a step needs what it does/);
  assert.match(msgs('scenarios:\n  - id: s\n    steps:\n      - fail: l1\n').errors[0], /mapping with one key/);
  assert.match(msgs('scenarios:\n  - id: s\n    steps:\n      - fail: {cable: l1, device: a}\n').errors[0], /acts on one object/);
  assert.match(msgs('scenarios:\n  - id: s\n    steps:\n      - fail: {cabel: l1}\n').errors[0], /unknown key "cabel".*cable/);
  assert.match(msgs('scenarios:\n  - {id: s}\n  - {id: s}\n').errors[0], /duplicate scenario id "s"/);
  assert.match(msgs('scenarios:\n  - {id: s, steps: [], colour: red}\n').errors[0], /unknown key "colour"/);
});

test('saving and editing scenarios: undoable edits of the scenarios section, written in the format; nothing else changes', () => {
  const d = ModelDoc.fromText('netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l1, a: "a:e0", b: "b:e0"}\n', 'a.yaml', 'file').doc;
  const before = d.exportText();
  d.saveScenario({ id: 'cut', label: 'Cable cut', steps: [{ ...step('fail', 'cable', 'l1'), note: 'digger' }, step('fail', 'port', 'a:e0')] });
  assert.deepEqual(d.errors, []);
  assert.equal(d.canUndo(), 'Save scenario Cable cut');
  assert.match(d.exportText(), /scenarios:\n  - id: cut\n    label: Cable cut\n    steps:\n      - fail: \{cable: l1\}\n        note: digger\n      - fail: \{port: "?a:e0"?\}\n/);
  assert.equal(d.result.model.scenarios[0].steps.length, 2);
  d.setScenarioSteps('cut', [step('fail', 'device', 'b')]);
  assert.deepEqual(d.result.model.scenarios[0].steps.map((x) => x.target), [{ kind: 'device', id: 'b' }]);
  d.undo();
  assert.equal(d.result.model.scenarios[0].steps.length, 2);
  d.deleteScenario('cut');
  assert.equal(d.exportText(), before);
  d.undo();
  d.undo();
  assert.equal(d.exportText(), before);
});

test('renaming a device, interface, cable or relation updates the scenario steps that name it', () => {
  const text = 'netatlas: 1\ndevices:\n  - {id: a, interfaces: [e0, e1]}\n  - {id: b, interfaces: [e0]}\nlinks:\n  - {id: l1, a: "a:e0", b: "b:e0"}\nscenarios:\n  - id: s\n    steps:\n      - fail: {device: a}\n      - fail: {port: "a:e0"}\n      - fail: {cable: l1}\n      - restore: {port: "a:e1"}\n';
  const d = ModelDoc.fromText(text, 'a.yaml', 'file').doc;
  assert.equal(d.renameEntity('device', 0, 'a2'), 4);
  assert.equal(d.renameEntity('link', 0, 'l9'), 1);
  d.renameInterface(['devices', 0, 'interfaces', 0], 'eth0');
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(
    d.result.model.scenarios[0].steps.map((x) => `${x.action} ${x.target.kind} ${x.target.id}`),
    ['fail device a2', 'fail port a2:eth0', 'fail cable l9', 'restore port a2:e1'],
  );
  // deleting the cable leaves a step that names nothing: reported, not removed
  d.deleteEntity('link', 0);
  assert.deepEqual(d.warnings.map((w) => w.path), ['scenarios.s.steps[2].fail.cable']);
});

test('the lock: during a simulation every edit of the network is refused and changes nothing; scenario edits and their undo still work', () => {
  const d = ModelDoc.fromText(example('enterprise-wan.yaml'), 'w.yaml', 'file').doc;
  d.setText(['title'], 'Before');
  const before = d.exportText();
  d.lock = 'A simulation is on';
  assert.throws(() => d.setText(['title'], 'X'), (e) => e instanceof EditLocked && /simulation is on/.test(e.message));
  assert.throws(() => d.deleteEntity('device', 0), EditLocked);
  assert.throws(() => d.renameEntity('device', 0, 'zz'), EditLocked);
  assert.equal(d.exportText(), before);
  // undoing the title edit is refused too
  assert.ok(d.undoLocked());
  assert.equal(d.undo(), false);
  assert.equal(d.exportText(), before);
  // a scenario is still saved, and that can be undone
  d.saveScenario({ id: 'x', label: 'X', steps: [step('fail', 'device', 'hq-fw')] });
  assert.ok(!d.undoLocked());
  assert.ok(d.undo());
  assert.equal(d.exportText(), before);
  assert.ok(d.undoLocked());
  d.lock = '';
  assert.ok(d.undo());
  assert.doesNotMatch(d.exportText(), /title: Before/);
});
