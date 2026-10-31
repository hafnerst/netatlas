// Outage impact (ui/outage.ts over analysis/whatif.ts with exact refs): components chosen in a
// searchable picker — never by id precedence — made unavailable together and compared with the
// same configured architecture without them. A model without failure domains is an ordinary
// model; a saved failure set is an optional shortcut that expands visibly; what was chosen is
// told apart from what follows from it; absent checks are said, never shown as zero; an issue
// that existed before is not reported as caused; runtime addressing stays uncertain; an
// oversized condition is refused, not cut. Nothing here changes the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const O = load('ui/outage.js');
const W = load('analysis/whatif.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};

// h1 reaches srv over two uplinks (equal-cost static routes over r2 and r3); dns on the server segment
const UPLINKS = `netatlas: 1
title: Two uplinks
devices:
  - {id: h1, type: endpoint, label: Host one, interfaces: [{id: e0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}], dns_servers: [10.9.0.53]}
  - id: r1
    type: router
    label: Access router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: a, ip: 10.0.1.1/30}, {id: b, ip: 10.0.2.1/30}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.1.2}, {prefix: 10.9.0.0/24, via: 10.0.2.2}]
  - {id: r2, type: router, interfaces: [{id: a, ip: 10.0.1.2/30}, {id: c, ip: 10.9.0.2/24}], routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]}
  - {id: r3, type: router, interfaces: [{id: b, ip: 10.0.2.2/30}, {id: c, ip: 10.9.0.3/24}], routes: [{prefix: 10.1.0.0/24, via: 10.0.2.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
  - {id: srv, type: server, interfaces: [{id: e0, ip: 10.9.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.2}]}
  - id: dns
    type: server
    interfaces: [{id: e0, ip: 10.9.0.53/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.9.0.2}]
    services: {dns: {zones: [{name: corp.test}]}}
links:
  - {id: l-h1, a: "h1:e0", b: "r1:lan"}
  - {id: up-a, a: "r1:a", b: "r2:a"}
  - {id: up-b, a: "r1:b", b: "r3:b"}
  - {id: l-r2, a: "r2:c", b: "sw:p1"}
  - {id: l-r3, a: "r3:c", b: "sw:p2"}
  - {id: l-srv, a: "srv:e0", b: "sw:p3"}
  - {id: l-dns, a: "dns:e0", b: "sw:p4"}
`;
const REQS = `
expectations:
  - {id: h1-srv, name: h1 reaches srv, expect: available, from: h1, to: srv}
  - {id: h1-srv-blocked, name: h1 must not reach srv, expect: blocked, from: h1, to: srv}
`;

// the outage of these refs as the workspace runs it (exact refs, the form's run record)
const analyze = (m, picks) => {
  const pv = O.outagePreview(m, picks);
  assert.equal(pv.blocked, '', pv.blocked);
  const result = W.whatIf(m, pv.refs, { exact: true });
  return { model: m, at: 0, result, picks, depsTotal: 0, reachRunning: false };
};
const pick = (...refs) => O.addPicks([], refs, '').picks;

test('model without failure domains: a device found by its label, added, analyzed — nothing created, the model unchanged', () => {
  const m = model(UPLINKS);
  assert.equal(m.failureDomains.length, 0);
  const before = JSON.stringify(m.devices) + JSON.stringify(m.links);
  const hits = O.searchOutage(m, 'access router').items;
  assert.deepEqual(hits.map((o) => [o.ref, o.type]), [['device:r1', 'Device']], 'search by label, with the type');
  assert.match(hits[0].detail, /Access router/);
  // a cable by an endpoint, an interface by its device
  assert.ok(O.searchOutage(m, 'r3:b').items.some((o) => o.ref === 'link:up-b' && o.type === 'Cable' && o.detail === 'r1:b ↔ r3:b'));
  assert.ok(O.searchOutage(m, 'r1:a').items.some((o) => o.ref === 'iface:r1:a' && o.type === 'Interface'));
  const run = analyze(m, pick('device:r1'));
  assert.ok(run.result.result, 'evaluated');
  assert.equal(run.result.info.context.scope, 'Outage of r1');
  assert.equal(JSON.stringify(m.devices) + JSON.stringify(m.links), before, 'selection, preview and analysis do not change the model');
  assert.equal(m.failureDomains.length, 0);
});

test('one redundant uplink unavailable: the requirement survives through the other path; both together lose it', () => {
  const m = model(UPLINKS + REQS);
  const one = analyze(m, pick('link:up-a'));
  const req = (r) => r.result.expectations.find((x) => x.after.id === 'h1-srv');
  assert.equal(req(one).change, 'alternative', 'kept through the other uplink');
  assert.ok(O.outageSummary(m, one).some((l) => /1 requirement is kept through an alternative/.test(l)), O.outageSummary(m, one).join(' | '));
  const other = analyze(m, pick('link:up-b'));
  assert.notEqual(req(other).change, 'availability-lost');
  const both = analyze(m, pick('link:up-a', 'link:up-b'));
  assert.equal(req(both).change, 'availability-lost', 'the combined outage differs from either alone');
  assert.equal(both.result.deps.find((d) => d.dep.key === 'dns:h1').change, 'unavailable');
  assert.ok(O.outageSummary(m, both).some((l) => /1 requirement is no longer satisfied/.test(l)));
});

test('already-broken baseline: a requirement violated before is said apart, not counted as caused', () => {
  const m = model(UPLINKS + REQS);
  const run = analyze(m, pick('link:up-a'));
  const x = run.result.expectations.find((y) => y.after.id === 'h1-srv-blocked');
  assert.equal(x.change, 'already-violated');
  const lines = O.outageSummary(m, run);
  assert.ok(lines.some((l) => /1 requirement was already violated before the outage/.test(l)), lines.join(' | '));
  assert.ok(!lines.some((l) => /no longer satisfied/.test(l)), 'nothing newly violated');
});

test('what was chosen is told apart from what follows: a device outage takes its interfaces and cables down as consequences', () => {
  const m = model(UPLINKS);
  const run = analyze(m, pick('device:r2'));
  assert.deepEqual(run.result.result.failed, ['device:r2']);
  const prop = O.propagated(run.result).map((x) => x.ref);
  assert.ok(prop.indexOf('link:up-a') >= 0 && prop.indexOf('link:l-r2') >= 0, prop.join(' '));
  assert.ok(prop.indexOf('device:r2') < 0, 'the chosen component is no consequence');
  assert.match(O.outagePreview(m, pick('device:r2')).propagation, /a device takes its interfaces and attached cables down/);
});

test('broker unavailable: the configured MQTT dependencies become unavailable and are visible', () => {
  const m = model(example('ot-network.yaml'));
  const run = analyze(m, pick('device:edge'));
  assert.deepEqual(run.result.deps.filter((d) => d.change === 'unavailable').map((d) => d.dep.key).sort(), ['mqtt:eng-ws/alarms', 'mqtt:hmi/dashboard', 'mqtt:plc/telemetry']);
  assert.ok(O.outageSummary(m, run).some((l) => /^3 configured dependencies become unavailable/.test(l)));
  // an application is explained, not approximated: its device is the component
  const app = O.searchOutage(m, 'plc/telemetry').items.find((o) => o.type === 'Application');
  assert.match(app.unsupported, /choose plc, the device that runs it/);
});

test('basic topology without requirements or applications: structural results; absent checks said, not zero, never "no effect"', () => {
  const m = model(`netatlas: 1
devices:
  - {id: a, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.1/24}]}
  - {id: b, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.2/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: l1, a: "a:e0", b: "sw:p1"}
  - {id: l2, a: "b:e0", b: "sw:p2"}
`);
  const run = analyze(m, pick('device:sw'));
  const lines = O.outageSummary(m, run);
  assert.equal(lines[0], 'No saved requirements were available to evaluate.');
  assert.match(lines[1], /^The model configures no dependency/);
  assert.match(lines[2], /further objects go down or degrade as a consequence; \d+ devices? (is|are) disconnected/);
  assert.match(lines.join('\n'), /Device-pair connectivity was not checked/);
  assert.ok(!lines.some((l) => /^0 /.test(l)), 'no category shown as zero');
  // an outage with nothing further found says so within the checks performed
  const quiet = analyze(m, pick('iface:sw:p2'));
  const q = O.outageSummary(m, quiet);
  assert.ok(!q.some((l) => /has no effect/.test(l)));
  // device pairs in a bounded scope, with coverage
  const w = W.whatIf(m, ['device:sw'], { exact: true, reach: { kind: 'entire' } });
  assert.ok(w.reach.pairs.length === 0 || w.reach.coverage.checked === w.reach.coverage.eligible);
});

test('saved failure set: an optional shortcut that expands visibly; overlapping selections deduplicate deterministically', () => {
  const m = model(UPLINKS + `
failure_domains:
  - {id: core-room, label: Core room, kind: room, members: [r2, r3]}
`);
  const set = O.expandSet(m, 'domain:core-room');
  assert.deepEqual([set.refs, set.label, set.invalid], [['device:r2', 'device:r3'], 'saved failure set Core room', []]);
  // r2 chosen directly, then the set: r2 once, said to come from both
  let picks = O.addPicks([], ['device:r2'], '').picks;
  const r = O.addPicks(picks, set.refs, set.via);
  picks = r.picks;
  assert.deepEqual([r.added, r.already], [1, 1]);
  assert.deepEqual(picks.map((p) => [p.ref, p.via]), [['device:r2', ['', 'domain:core-room']], ['device:r3', ['domain:core-room']]]);
  const pv = O.outagePreview(m, picks);
  assert.deepEqual([pv.explicit, pv.sets], [1, [{ via: 'domain:core-room', label: 'saved failure set Core room', count: 2, also: 1 }]]);
  // the same again changes nothing; the order of the condition is the order of choice
  assert.deepEqual(O.addPicks(picks, set.refs, set.via).picks, picks);
  // a group adds its devices by explicit membership only
  assert.ok(O.searchOutage(m, 'core room').items.some((o) => o.ref === 'domain:core-room' && o.type === 'Saved failure set'));
});

test('a deleted or renamed component blocks the analysis until it is removed; nothing is analyzed in its place', () => {
  const m = model(UPLINKS);
  const pv = O.outagePreview(m, pick('device:r2', 'device:gone'));
  assert.deepEqual(pv.missing, ['device:gone']);
  assert.match(pv.blocked, /Remove what is no longer in the model: gone/);
  assert.match(O.outagePreview(m, []).blocked, /Choose at least one component/);
  // exact refs: an id shared by a device and nothing else is never resolved by precedence
  const w = W.whatIf(m, ['device:r2', 'r3'], { exact: true });
  assert.deepEqual([w.refs, w.unknown], [['device:r2'], ['r3']]);
});

test('runtime-assigned addressing: an outcome the configured model does not establish stays indeterminate', () => {
  const m = model(`netatlas: 1
devices:
  - id: gw
    type: router
    interfaces: [{id: lan, ip: 10.5.0.1/24}]
    services:
      dhcp:
        scopes:
          - {network: lan, range: 10.5.0.100-10.5.0.110, gateway: 10.5.0.1, dns: [10.5.0.1]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: nas, type: server, interfaces: [{id: eth0, ip: 10.5.0.2/24}], services: {applications: [{id: smb, name: Files, profile: tcp_server, port: 445}]}}
  - {id: laptop, type: endpoint, interfaces: [{id: wlan0, ipv4: dhcp}], services: {applications: [{id: files, name: Files, profile: tcp_client, peer: nas/smb}]}}
links:
  - {id: l1, a: "gw:lan", b: "sw:p1"}
  - {id: l2, a: "nas:eth0", b: "sw:p2"}
  - {id: l3, a: "laptop:wlan0", b: "sw:p3"}
networks:
  - {id: lan, cidr: 10.5.0.0/24, vlan: 1}
`);
  const run = analyze(m, pick('link:l1'));
  const app = run.result.deps.find((d) => d.dep.key === 'app:laptop/files');
  assert.ok(app, run.result.deps.map((d) => d.dep.key).join(' '));
  assert.ok(app.change === 'indeterminate' || app.change === 'not-before', app.change + ': ' + app.text);
  assert.notEqual(app.change, 'unavailable', 'missing information is not a newly caused failure');
});

test('an oversized condition is refused with why; nothing is cut off silently', () => {
  const devs = Array.from({ length: 70 }, (_, i) => `  - {id: d${i}, type: endpoint}`).join('\n');
  const m = model(`netatlas: 1\ndevices:\n${devs}\n`);
  const picks = pick(...Array.from({ length: 70 }, (_, i) => 'device:d' + i));
  const pv = O.outagePreview(m, picks);
  assert.equal(pv.tooLarge, true);
  assert.match(pv.blocked, /^70 components: at most 64 are evaluated together/);
  const w = W.whatIf(m, pv.refs, { exact: true });
  assert.equal(w.tooLarge, true);
  assert.equal(w.result, null, 'nothing evaluated, not the first 64');
});

test('the picker on a larger model: bounded results, exact ids first, responsive', () => {
  const m = model(example('enterprise-wan.yaml'));
  const t0 = Date.now();
  O.outageOptions(m);
  const first = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 200; i++) O.searchOutage(m, ['hq', 'core', 'cable', 'eth', 'hq-core1'][i % 5]);
  const per = (Date.now() - t1) / 200;
  assert.ok(first < 500 && per < 20, `options ${first} ms, a search ${per.toFixed(2)} ms`);
  const r = O.searchOutage(m, 'hq-core1');
  assert.equal(r.items[0].ref, 'device:hq-core1', 'the exact id first');
  assert.ok(r.items.length <= 30 && r.total >= r.items.length);
});

test('the text export names the condition, the baseline and the groups; it claims nothing dynamic', () => {
  const m = model(UPLINKS + REQS);
  const run = analyze(m, pick('link:up-a', 'link:up-b'));
  const t = O.outageText({ title: m.title, outdated: false }, run);
  assert.match(t, /Resilience: outage impact/);
  assert.match(t, /Assume unavailable:\n  up-a — Cable · r1:a ↔ r2:a\n  up-b — Cable · r1:b ↔ r3:b/);
  assert.match(t, /Compared with the same configured architecture without this outage:/);
  assert.match(t, /Requirements newly violated \(1\):/);
  assert.match(t, /Convergence and recovery times/);
});
