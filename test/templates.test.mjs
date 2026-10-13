// Scenario templates (analysis/templates.ts): for every template, whether it
// applies to each example and what it proposes (or why it doesn't apply);
// the proposals are playable and deterministic. Also what the templates
// need from the format: `group` and `risk` step targets, the `maintain`
// action, `risk_groups` on cables, ports and devices, and a demand's way
// back (asymmetric routing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example, exampleNames } from './helpers.mjs';

const P = load('analysis/templates.js');
const S = load('analysis/scenario.js');
const T = load('analysis/traffic.js');
const F = load('analysis/failure.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
/** "name | step; step" for an applicable proposal, "no: reason" otherwise */
const show = (m, p) => (p.applicable ? `${p.name} | ${p.steps.map((s) => S.stepText(m, s)).join('; ')}` : 'no: ' + p.reason);

test('the templates: eleven, in the menu’s order; traffic surge is left out (no load analysis yet)', () => {
  assert.deepEqual(P.TEMPLATES.map((t) => t.id), ['wan-uplink', 'fhrp', 'core', 'location', 'srlg', 'rolling', 'flap', 'vpn', 'lag', 'service', 'asymmetric']);
  assert.ok(P.TEMPLATES.every((t) => t.label && t.summary.endsWith('.')));
  assert.equal(P.propose(model(example('minimal.yaml')), 'surge'), null);
});

test('enterprise-wan: what each template proposes', () => {
  const m = model(example('enterprise-wan.yaml'));
  const got = Object.fromEntries(P.proposeAll(m).map((p) => [p.template, show(m, p)]));
  assert.deepEqual(got, {
    'wan-uplink': 'Uplink outage at HQ Berlin | Fail cable l-hq-isp1',
    fhrp: 'VRRP failover of 10.10.10.1 | Fail hq-core1',
    core: 'Loss of hq-core1 | Fail hq-core1',
    location: 'Loss of Core rack C1 | Fail location hq-core',
    srlg: 'Shared-risk failure: duct-alexanderplatz | Fail risk group duct-alexanderplatz',
    rolling: 'Rolling maintenance of hq-core1 and hq-core2 | Maintenance: hq-core1; Restore hq-core1; Maintenance: hq-core2; Restore hq-core2',
    flap: 'Flapping cable l-hq-isp2 | Fail cable l-hq-isp2; Restore cable l-hq-isp2; Fail cable l-hq-isp2; Restore cable l-hq-isp2',
    vpn: 'Tunnel failover ham-rtr – hq-rtr2 | Fail IPsec ipsec-ham',
    lag: 'Peer-link member loss on hq-core1:Port-Channel1 | Fail cable l-peer1; Fail cable l-peer2',
    service: 'Loss of server hq-log | Fail hq-log',
    asymmetric: 'no: No traffic demands in this model (the check compares their way there and their way back)',
  });
  // the details say why: the active member, the backup tunnel, the clients that lose the service
  const by = (id) => P.propose(m, id);
  assert.match(by('fhrp').description, /\(hq-core1\) fails; the gateway moves to hq-core2/);
  assert.match(by('vpn').description, /ipsec-ham, carrying the cheaper routing adjacency\) fails; wg-ham-backup is left/);
  assert.match(by('service').notes[0], /syslog-fw\): hq-fw loses it; no other Syslog server in the model/i);
  assert.match(by('lag').steps[1].note, /fewer than 1 member up: the LAG goes down/);
});

test('ospf-reroute and datacenter-evpn: what each template proposes; the asymmetric check finds a failure after which the way back differs', () => {
  const o = model(example('ospf-reroute.yaml'));
  const got = Object.fromEntries(P.proposeAll(o).map((p) => [p.template, show(o, p)]));
  assert.deepEqual(got, {
    'wan-uplink': 'Uplink outage at Site West | Fail cable l-w1-c1',
    fhrp: 'VRRP failover of 10.1.10.1 | Fail w1',
    core: 'Loss of c1 | Fail c1',
    location: 'Loss of Site West | Fail location west',
    srlg: 'no: No risk group shared by two or more cables, ports or devices (list it in their risk_groups)',
    rolling: 'Rolling maintenance of w1 and w2 | Maintenance: w1; Restore w1; Maintenance: w2; Restore w2',
    flap: 'Flapping cable l-w1-sw | Fail cable l-w1-sw; Restore cable l-w1-sw; Fail cable l-w1-sw; Restore cable l-w1-sw',
    vpn: 'no: No two sites joined by two tunnel paths (a primary and a backup tunnel between the same devices)',
    lag: 'no: No LAG with two or more cabled member ports in this model',
    service: 'no: No service relation (DNS, NTP, syslog, AAA …) in this model',
    asymmetric: 'Asymmetric routing after l-w1-c1 fails | Fail cable l-w1-c1',
  });
  // … and it is: after l-w1-c1 fails the users' traffic leaves by w1 → w2, and comes back by w2 alone
  const before = T.trafficFlows(o, null).flows.find((f) => f.id === 'dem:users-app:0');
  assert.deepEqual(before.back, { devices: ['e-srv', 'e1', 'c3', 'c1', 'w1', 'w-host'], asymmetric: false });
  const after = T.trafficFlows(o, F.simulate(o, ['link:l-w1-c1'])).flows.find((f) => f.id === 'dem:users-app:0');
  assert.equal(after.back.asymmetric, true);
  assert.deepEqual(after.devices.slice(0, 3), ['w-host', 'w1', 'w2']);
  const dc = model(example('datacenter-evpn.yaml'));
  const g2 = Object.fromEntries(P.proposeAll(dc).map((p) => [p.template, show(dc, p)]));
  assert.equal(g2.core, 'Loss of spine1 | Fail spine1');
  assert.equal(g2.srlg, 'Shared-risk failure: tray-a01 | Fail risk group tray-a01');
  assert.equal(g2.location, 'Loss of Rack A03 (border + compute) | Fail location rack-a03');
  assert.equal(g2['wan-uplink'], 'no: No dual-homed site in this model (a site, campus or building with two or more cables leaving it, or two uplinks to providers)');
});

test('a model without what a template needs: every one greyed out with its reason', () => {
  const m = model(example('minimal.yaml'));
  const ps = P.proposeAll(m);
  assert.ok(ps.every((p) => !p.applicable && p.reason && !p.steps.length));
  assert.match(ps.find((p) => p.template === 'wan-uplink').reason, /^No dual-homed site in this model/);
});

test('every proposal for every example can be played: its steps resolve, and step k is the state after k steps', () => {
  for (const f of exampleNames) {
    const m = validate.loadModel(example(f)).model;
    if (!m) continue;
    for (const p of P.proposeAll(m)) {
      if (!p.applicable) continue;
      assert.ok(p.steps.length > 0 && p.name && p.description, `${f} ${p.template}`);
      for (const s of p.steps) assert.equal(S.stepProblem(m, s), '', `${f} ${p.template}: ${S.stepText(m, s)}`);
      const v = S.stepView(m, p.steps, p.steps.length);
      assert.ok(v.index === p.steps.length, `${f} ${p.template}`);
    }
  }
});

test('deterministic: another order of the file, and repeated runs, never change a proposal', () => {
  const text = example('ospf-reroute.yaml');
  const a = JSON.stringify(P.proposeAll(model(text)));
  const lines = text.split('\n');
  for (const head of ['links:', 'relations:', 'demands:']) {
    const i = lines.indexOf(head);
    let j = i + 1;
    while (j < lines.length && (lines[j].startsWith('  - {') || lines[j].startsWith('  #'))) j++;
    const block = lines.slice(i + 1, j).filter((l) => l.startsWith('  - {')).reverse();
    lines.splice(i + 1, j - i - 1, ...block);
  }
  assert.equal(JSON.stringify(P.proposeAll(model(lines.join('\n')))), a);
  assert.equal(JSON.stringify(P.proposeAll(model(text))), a);
});

test('what the templates need from the format: group and risk targets, the maintain action, risk_groups on cables, ports and devices', () => {
  const m = model(`netatlas: 1
groups:
  - {id: site, kind: site}
  - {id: rack, kind: rack, parent: site}
devices:
  - {id: a, type: router, group: rack, risk_groups: [feed-b], interfaces: [{id: e0, risk_groups: [card-1]}, {id: e1}]}
  - {id: b, type: router, group: site, interfaces: [e0, e1]}
  - {id: c, type: router, interfaces: [e0]}
links:
  - {id: l1, a: "a:e0", b: "b:e0", risk_groups: [duct, duct-2]}
  - {id: l2, a: "a:e1", b: "b:e1", risk_groups: [duct]}
scenarios:
  - id: s
    steps:
      - fail: {group: site}
      - restore: {group: site}
      - maintain: {device: c}
      - fail: {risk: duct}
      - restore: {device: c}
`);
  assert.deepEqual(m.index.links.get('l1').riskGroups, ['duct', 'duct-2']);
  assert.deepEqual(m.index.devices.get('a').riskGroups, ['feed-b']);
  assert.deepEqual(m.index.interfaces.get('a:e0').riskGroups, ['card-1']);
  assert.deepEqual(S.riskGroupIds(m), ['card-1', 'duct', 'duct-2', 'feed-b']);
  assert.deepEqual(S.riskMembers(m, 'duct'), ['link:l1', 'link:l2']);
  // a location: its devices and those of the groups nested in it
  assert.deepEqual(S.groupDevices(m, 'site'), ['a', 'b']);
  const st = m.scenarios[0].steps;
  assert.deepEqual(st.map((x) => S.stepText(m, x)), ['Fail location site', 'Restore location site', 'Maintenance: c', 'Fail risk group duct', 'Restore c']);
  assert.deepEqual(S.failedAfter(m, st, 1), ['device:a', 'device:b']);
  assert.deepEqual(S.failedAfter(m, st, 2), []);
  // maintenance takes it out of service like a failure, and is named apart
  assert.deepEqual(S.failedAfter(m, st, 3), ['device:c']);
  assert.deepEqual(S.maintainedAfter(m, st, 3), ['device:c']);
  assert.deepEqual(S.failedAfter(m, st, 4), ['device:c', 'link:l1', 'link:l2']);
  assert.deepEqual(S.maintainedAfter(m, st, 5), []);
  // what can't be resolved: a warning, skipped
  const r = validate.loadModel(`netatlas: 1\ndevices: [{id: a}]\nscenarios:\n  - id: s\n    steps:\n      - fail: {group: nowhere}\n      - fail: {risk: none}\n`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.message.replace(/ \(the scenario skips it\)$/, '')), ['this step can\'t be played: there is no group / location "nowhere"', 'this step can\'t be played: nothing is in risk group "none" (no cable, port or device lists it in its risk_groups)']);
  // the form of risk_groups: ids, each once; not on a logical interface
  const bad = validate.loadModel(`netatlas: 1\ndevices:\n  - {id: a, risk_groups: [x, x, "two words"], logical_interfaces: [{id: lo0, type: loopback, ip: 10.0.0.1/32, risk_groups: [y]}]}\n`);
  const msgs = bad.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /risk group "x" is listed twice/);
  assert.match(msgs, /"two words" is no risk group id/);
  assert.match(msgs, /unknown key "risk_groups"/);
});
