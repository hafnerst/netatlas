// Saved experiments: the configuration a step keeps while it is incomplete,
// its timing (after the start, after an earlier action was submitted), its
// evaluation window, the starting state and the execution scope, the
// multicast actions and observation, the saved expectations as an
// observation with its coverage, and the runner's lifecycle — on the shared
// simulation engine (analysis/sim/experiment.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load } from './helpers.mjs';

const EX = load('analysis/sim/experiment.js');
const ME = load('model/experiments.js');
const ED = load('editor/document.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.equal(r.errors.map((e) => `${e.path}: ${e.message}`).join(' | '), '', 'valid');
  return r.model;
};
const run = (m, id) => new EX.ExperimentRunner(m, m.experiments.find((e) => e.id === id), 'fp').runAll();

const lan = `netatlas: 1
title: One switch
groups:
  - {id: left, label: Left}
devices:
  - {id: src, type: endpoint, group: left, interfaces: [{id: e0, ip: 10.0.0.1/24}]}
  - {id: rx, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.2/24}]}
  - {id: sw, type: switch, group: left, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: l1, a: "src:e0", b: "sw:p1"}
  - {id: l2, a: "rx:e0", b: "sw:p2"}
`;

test('timing: a step after an earlier action was submitted (its time plus its delay); a cycle or an unknown action is said, never guessed', () => {
  const m = model(lan + `experiments:
  - id: mc
    name: Stream to a receiver
    duration: 30s
    actions:
      - {id: join, at: 5s, do: join, target: "rx:e0", group: 239.1.1.1}
      - {id: stream, at: 2s, after: join, do: start_stream, target: "src:e0", group: 239.1.1.1, interval: 500ms}
      - {at: 20s, do: stop_stream, target: "src:e0", group: 239.1.1.1}
    observe:
      - {id: gets, at: 3s, after: join, within: 10s, of: receive, target: "rx:e0", group: 239.1.1.1, expect: received}
      - {id: quiet, at: 22s, within: 5s, of: receive, target: "rx:e0", group: 239.1.1.1, expect: not received}
`);
  const e = m.experiments[0];
  assert.deepEqual(ME.stepTimes(e), { actions: [5000, 7000, 20000], observations: [8000, 22000] });
  assert.equal(ME.actionText(e.actions[1]), '2 s after “join” is submitted: Start stream from src:e0 → 239.1.1.1');
  const r = run(m, 'mc');
  assert.deepEqual(r.actions.map((a) => [a.at, a.action.do, a.state]), [[5000, 'join', 'submitted'], [7000, 'start_stream', 'submitted'], [20000, 'stop_stream', 'submitted']]);
  assert.deepEqual(r.observations.map((o) => [o.obs.id, o.outcome, o.from, o.to]), [['gets', 'satisfied', 8000, 18000], ['quiet', 'satisfied', 22000, 27000]]);
  assert.match(r.observations[0].actual, /^received: \d+ datagrams of 239\.1\.1\.1 at rx:e0 within 10 s$/);
  assert.match(r.observations[1].actual, /^not received: no datagram of 239\.1\.1\.1 arrived at rx:e0 within 5 s$/);
  // a cycle, an unknown action: problems, not times
  const bad = validate.loadModel(lan + 'experiments:\n  - id: c\n    name: C\n    duration: 30s\n    actions:\n      - {id: a, after: b, at: 1s, do: power_off, target: src}\n      - {id: b, after: a, at: 1s, do: power_off, target: rx}\n      - {after: nothing, at: 1s, do: power_on, target: src}\n    observe:\n      - {of: device, target: src, expect: on}\n').model.experiments[0];
  assert.ok(bad.problems.some((p) => /a cycle of "after"/.test(p)), bad.problems.join(' | '));
  assert.ok(bad.problems.some((p) => /no action has the id "nothing"/.test(p)));
  const refused = new EX.ExperimentRunner(m, bad, 'fp');
  assert.equal(refused.result().state, 'refused');
  assert.match(refused.result().summary, /^Not run: /);
});

test('windows: a state is satisfied as soon as it holds within its window, violated when it does not by its end; without a window it is read at once', () => {
  const m = model(lan + `experiments:
  - id: w
    name: Windows
    duration: 30s
    actions:
      - {at: 5s, do: power_off, target: rx}
    observe:
      - {id: soon, at: 1s, within: 10s, of: device, target: rx, expect: off}
      - {id: never, at: 1s, within: 3s, of: device, target: rx, expect: off}
      - {id: now, at: 2s, of: device, target: rx, expect: off}
`);
  const r = run(m, 'w');
  const by = new Map(r.observations.map((o) => [o.obs.id, o]));
  assert.deepEqual([by.get('soon').outcome, by.get('soon').at], ['satisfied', 5000], 'decided when it held');
  assert.deepEqual([by.get('never').outcome, by.get('never').at], ['violated', 4000]);
  assert.match(by.get('never').actual, /^rx is operational \(throughout 3 s\)$/);
  assert.deepEqual([by.get('now').outcome, by.get('now').at], ['violated', 2000]);
});

test('starting state: a settled network (its settle time first, not the experiment’s); a freshly booted one otherwise', () => {
  const exp = (settle) => lan + `experiments:
  - id: s
    name: Start
    duration: 10s
${settle ? '    settle: 20s\n' : ''}    observe:
      - {at: 0s, of: link, target: l2, expect: up}
`;
  const fresh = run(model(exp(false)), 's');
  const settled = run(model(exp(true)), 's');
  assert.equal(fresh.observations[0].outcome, 'violated', 'at t = 0 of a freshly booted network the cable is still coming up');
  assert.equal(settled.observations[0].outcome, 'satisfied');
  assert.equal(settled.settle, 20000);
  assert.ok(settled.events.every((x) => x.t >= 0), 'the events of the settling are not the experiment’s');
});

test('scope: a run of a group runs only it (and what it needs); a step outside it is refused, an observation outside it indeterminate', () => {
  const m = model(lan + `experiments:
  - id: g
    name: Group
    duration: 10s
    scope: {group: left}
    actions:
      - {at: 1s, do: power_off, target: rx}
      - {at: 1s, do: power_off, target: src}
    observe:
      - {at: 2s, of: device, target: rx, expect: off}
      - {at: 2s, of: device, target: src, expect: off}
`);
  const r = run(m, 'g');
  assert.match(r.scope, /^Group left: \d of 3 devices run$/);
  assert.deepEqual(r.actions.map((a) => [a.action.target, a.state]), [['rx', 'refused'], ['src', 'submitted']]);
  assert.match(r.actions[0].text, /rx is outside the experiment's scope/);
  assert.deepEqual(r.observations.map((o) => o.outcome), ['indeterminate', 'satisfied']);
  assert.match(validate.loadModel(lan + 'experiments:\n  - id: x\n    name: X\n    duration: 10s\n    scope: {group: nowhere}\n    observe:\n      - {of: device, target: src, expect: on}\n').warnings.map((w) => w.message).join(), /"nowhere" is no group of the model/);
});

test('the saved expectations as an observation: those the model has (all, or by id), on the run’s state, with what could not be decided — none invented', () => {
  const guard = `netatlas: 1
title: Guarded
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: a, ip: 10.0.1.1/30}, {id: b, ip: 10.0.2.1/30}]
    routes:
      - {prefix: 10.9.0.0/24, via: 10.0.1.2}
      - {prefix: 10.9.0.0/24, via: 10.0.2.2, distance: 200}
  - id: fw
    type: firewall
    simulation: {allow: "tcp/443"}
    interfaces: [{id: a, ip: 10.0.1.2/30}, {id: b, ip: 10.9.0.2/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.2.2/30}, {id: b, ip: 10.9.0.3/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]
  - {id: s2, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: srv
    type: server
    simulation: {listening: "tcp/22, tcp/443"}
    interfaces: [{id: eth0, ip: 10.9.0.10/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.9.0.2}]
links:
  - {id: l-pc, a: pc:eth0, b: r1:lan}
  - {id: l-fw, a: r1:a, b: fw:a}
  - {id: l-r2, a: r1:b, b: r2:a}
  - {id: l-fw-s, a: fw:b, b: s2:p1}
  - {id: l-r2-s, a: r2:b, b: s2:p2}
  - {id: l-srv, a: srv:eth0, b: s2:p3}
expectations:
  - {id: no-ssh, name: No SSH, expect: blocked, from: pc, to: srv, service: tcp/22}
  - {id: https, name: HTTPS, expect: available, from: pc, to: srv, service: tcp/443}
experiments:
  - id: x
    name: The firewall fails
    duration: 60s
    actions:
      - {at: 30s, do: fail, target: fw}
    observe:
      - {id: before, at: 20s, of: expectations, target: "*", expect: satisfied}
      - {id: after, at: 40s, of: expectations, target: "no-ssh", expect: satisfied}
`;
  const m = model(guard);
  const r = run(m, 'x');
  const by = new Map(r.observations.map((o) => [o.obs.id, o]));
  assert.equal(by.get('before').outcome, 'satisfied', by.get('before').actual);
  assert.match(by.get('before').actual, /^satisfied: all 2 \(no-ssh, https\) — already so when the window opened \(t = 20\.0 s\)$/);
  assert.equal(by.get('after').outcome, 'violated', 'without the firewall the floating route takes SSH around it');
  assert.match(by.get('after').actual, /^violated: no-ssh — 1 of 1 evaluated$/);
  // a model without saved expectations: the observation says so, the experiment can't run
  const none = validate.loadModel(guard.replace(/expectations:\n[\s\S]*?\nexperiments:/, 'experiments:')).model.experiments[0];
  assert.ok(none.problems.some((p) => /the model has no saved expectations/.test(p)));
});

test('the editor’s steps: a kind chosen is kept while the step is incomplete; another kind keeps what it can take and says what it clears; one undo step each; a round trip', () => {
  const d = ED.ModelDoc.fromText(lan, 'x.yaml', 'file').doc;
  d.addExperiment('Draft', '60s');
  assert.equal(d.addStep(0, 'actions', 'power_off'), 0);
  const e = () => d.result.model.experiments[0];
  assert.deepEqual(e().actions.map((a) => [a.do, a.target, a.missing.join()]), [['power_off', '', 'target']], 'kept, incomplete');
  assert.deepEqual(d.setStepKind(0, 'actions', 0, 'shut'), []);
  d.setText(['experiments', 0, 'actions', 0, 'target'], 'rx:e0');
  assert.deepEqual(d.setStepKind(0, 'actions', 0, 'join'), [], 'the interface is a join’s target too');
  assert.deepEqual(e().actions[0].missing, ['group']);
  assert.deepEqual(d.setStepKind(0, 'actions', 0, 'power_off'), ['target'], 'an interface is no device: cleared, and said');
  d.setText(['experiments', 0, 'actions', 0, 'target'], 'rx');
  d.addStep(0, 'observe', 'device', 'rx');
  assert.equal(e().observations[0].expect, 'operational', 'the usual outcome preset');
  d.setStepAfter(0, 'observe', 0, 0);
  assert.deepEqual([e().actions[0].id, e().observations[0].after], ['step-1', 'step-1'], 'the action got an id to be named by');
  const y = d.exportText();
  d.undo();
  assert.equal(e().observations[0].after, undefined, 'one undo step for the id and the dependency');
  d.redo();
  assert.equal(d.exportText(), y);
  assert.equal(ED.ModelDoc.fromText(y, 'x.yaml', 'file').doc.exportText(), y, 'written back as it was');
  d.setExperimentScope(0, 'group', 'left');
  assert.deepEqual(e().scope, { kind: 'group', value: 'left' });
  d.setExperimentScope(0, 'entire', '');
  assert.deepEqual(e().scope, { kind: 'entire', value: '' });
});
