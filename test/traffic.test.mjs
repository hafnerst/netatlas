// Simulated traffic (analysis/traffic.ts): which flows the model implies per
// protocol and their direction, demands traced with equal-cost splitting,
// one-way cables, rerouting under failure, lost traffic, the changes from
// step to step, and determinism. Also the `demands:` section and a link's
// `direction` in the format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const T = load('analysis/traffic.js');
const F = load('analysis/failure.js');
const R = load('analysis/trace.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  return r.model;
};
const ids = (st, of) => st.flows.filter((f) => f.of === of).map((f) => f.id);
const reroute = example('ospf-reroute.yaml');

test('control traffic per protocol: routing adjacencies and BFD both ways, VRRP from its active member, a service from its clients, a one-way relation one way, a hub group per member', () => {
  const wan = model(example('enterprise-wan.yaml'));
  const st = T.trafficFlows(wan, null);
  assert.deepEqual(ids(st, 'relation:ospf-muc'), ['rel:ospf-muc:hq-rtr1>muc-rtr', 'rel:ospf-muc:muc-rtr>hq-rtr1']);
  assert.deepEqual(ids(st, 'relation:bfd-isp1'), ['rel:bfd-isp1:hq-rtr1>isp1-pe', 'rel:bfd-isp1:isp1-pe>hq-rtr1']);
  // VRRP: advertisements from the active member (priority 200) only
  const vrrp = st.flows.filter((f) => f.of === 'relation:vrrp-users');
  assert.deepEqual(vrrp.map((f) => f.id), ['rel:vrrp-users:hq-core1>hq-core2']);
  assert.match(vrrp[0].what, /advertisements from hq-core1/);
  // syslog is one-way: the firewall to the server
  assert.deepEqual(ids(st, 'relation:syslog-fw'), ['rel:syslog-fw:hq-fw>hq-log']);
  // a relation of five devices: each member to the group and back, over the hub
  const area = st.flows.filter((f) => f.of === 'relation:ospf-hq-area0');
  assert.equal(area.length, 10);
  assert.deepEqual(area.find((f) => f.id === 'rel:ospf-hq-area0:hq-fw>hub').logical, [{ ref: 'relation:ospf-hq-area0', from: 'hq-fw', to: 'hub' }]);
  // a bidirectional service: clients to the server (the last endpoint) and the replies
  const svc = model(reroute.replace('{id: span-ids, protocol: span, direction: unidirectional, endpoints: ["e-sw:p3", "e-ids:mon0"], over: l-tap}', '{id: dns, protocol: dns, endpoints: ["w-host:eth0", "w-cam:eth0", "e-srv:eth0"]}'));
  const dns = T.trafficFlows(svc, null).flows.filter((f) => f.of === 'relation:dns');
  assert.deepEqual(dns.map((f) => f.id), ['rel:dns:e-srv>w-cam', 'rel:dns:e-srv>w-host', 'rel:dns:w-cam>e-srv', 'rel:dns:w-host>e-srv']);
  assert.match(dns[0].what, /client → e-srv and replies/);
  // the lanes run between the two devices, in the flow's direction
  const o = st.flows.find((f) => f.id === 'rel:ospf-muc:muc-rtr>hq-rtr1');
  assert.deepEqual(o.logical, [{ ref: 'relation:ospf-muc', from: 'muc-rtr', to: 'hq-rtr1' }]);
  // its cables: the GRE over IPsec over the internet underneath, from muc-rtr
  assert.equal(o.physical[0].ref, 'link:l-muc-inet');
  assert.equal(o.physical[0].from, 'a');
});

test('demands: traced like Trace path, through the networks and the relations used; the rate grows with the bandwidth', () => {
  const m = model(reroute);
  const st = T.trafficFlows(m, null);
  const users = st.flows.find((f) => f.id === 'dem:users-app:0');
  assert.equal(users.state, 'up');
  assert.deepEqual(users.devices, ['w-host', 'w1', 'c1', 'c3', 'e1', 'e-srv']);
  assert.deepEqual(
    users.logical.map((t) => `${t.ref} ${t.from}>${t.to}`),
    ['network:net-users w-host>net', 'network:net-users net>w1', 'relation:ospf-w1-c1 w1>c1', 'relation:ospf-c1-c3 c1>c3', 'relation:ospf-c3-e1 c3>e1', 'network:net-east e1>net', 'network:net-east net>e-srv'],
  );
  assert.deepEqual(users.physical.map((t) => `${t.ref.slice(5)}:${t.from}`), ['l-host:a', 'l-w1-sw:b', 'l-w1-c1:a', 'l-c1-c3:a', 'l-c3-e1:a', 'l-e1-sw:a', 'l-srv:b']);
  const cam = st.flows.find((f) => f.id === 'dem:cam-video:0');
  assert.ok(users.rate > cam.rate, `${users.rate} > ${cam.rate}`);
  assert.ok(T.demandRate(10e9, 1) <= 4.5 && T.demandRate(1e3, 1) >= 0.4);
  // demand flows come first, then the control traffic, each by id
  const kinds = st.flows.map((f) => f.kind);
  assert.equal(kinds.lastIndexOf('demand') < kinds.indexOf('control'), true);
});

test('equal-cost paths share a demand equally', () => {
  // c1 → c3 now costs as much as c1 → c2 → c3
  const m = model(reroute.replace('{area: 0, cost: 10}}\n  - {id: ospf-c2-c3', '{area: 0, cost: 20}}\n  - {id: ospf-c2-c3').replace('label: backup, endpoints: ["c2:ge1", "c3:ge1"], over: l-c2-c3, attrs: {area: 0, cost: 30}', 'label: backup, endpoints: ["c2:ge1", "c3:ge1"], over: l-c2-c3, attrs: {area: 0, cost: 10}'));
  const fl = T.trafficFlows(m, null).flows.filter((f) => f.of === 'demand:users-app');
  assert.equal(fl.length, 2);
  assert.deepEqual(fl.map((f) => f.share), [0.5, 0.5]);
  assert.deepEqual(fl.map((f) => f.bps), [200e6, 200e6]);
  assert.match(fl[0].label, /path 1 of 2: 50 %/);
  assert.notDeepEqual(fl[0].devices, fl[1].devices);
});

test('a one-way cable: traffic only from end a to end b — the tracer never uses it backwards, and its dots run a → b', () => {
  const m = model(`netatlas: 1
devices:
  - {id: r1, type: router, interfaces: [{id: e0, ip: 10.0.0.1/30}]}
  - {id: r2, type: router, interfaces: [{id: e0, ip: 10.0.0.2/30}]}
links:
  - {id: l1, a: "r1:e0", b: "r2:e0", direction: unidirectional}
demands:
  - {id: there, source: r1, destination: 10.0.0.2, bandwidth: 1G}
  - {id: back, source: r2, destination: 10.0.0.1, bandwidth: 1G}
`);
  assert.equal(m.index.links.get('l1').direction, 'unidirectional');
  assert.equal(R.tracePath(m, { from: 'r1', to: '10.0.0.2' }).paths[0].end.kind, 'reached');
  assert.equal(R.tracePath(m, { from: 'r2', to: '10.0.0.1' }).paths[0].end.kind, 'stopped');
  const st = T.trafficFlows(m, null);
  const there = st.flows.find((f) => f.of === 'demand:there');
  const back = st.flows.find((f) => f.of === 'demand:back');
  assert.deepEqual([there.state, there.physical], ['up', [{ ref: 'link:l1', from: 'a', to: 'b' }]]);
  assert.equal(back.state, 'lost');
  assert.equal(back.stop.device, 'r2');
  // orienting cables never runs a one-way cable backwards
  assert.deepEqual(T.orientCables(m, ['l1'], 'r2'), []);
  assert.deepEqual(T.orientCables(m, ['l1'], 'r1'), [{ ref: 'link:l1', from: 'a', to: 'b' }]);
  // the format: anything else than the two directions is an error
  const bad = validate.loadModel(`netatlas: 1\ndevices: [{id: a}, {id: b}]\nlinks:\n  - {id: l1, a: a, b: b, direction: oneway}\n`);
  assert.match(bad.errors[0].message, /unknown direction "oneway": use "bidirectional" \(the default\) or "unidirectional" \(from end a to end b\)/);
});

test('the primary link fails, then w1’s LAN: rerouted, VRRP failing over, the camera lost where it stops, and back to the preferred path; the changes from one state to the next', () => {
  const m = model(reroute);
  // what is failed at each stage: nothing; the primary link; and w1's LAN; the primary link again; nothing
  const failed = [[], ['link:l-c1-c3'], ['link:l-c1-c3', 'link:l-w1-sw'], ['link:l-c1-c3'], []];
  const at = (k) => T.trafficFlows(m, failed[k].length ? F.simulate(m, failed[k]) : null);
  const path = (st, d) => st.flows.find((f) => f.of === 'demand:' + d);
  const steps = [0, 1, 2, 3, 4].map(at);
  assert.deepEqual(path(steps[0], 'users-app').devices, ['w-host', 'w1', 'c1', 'c3', 'e1', 'e-srv']);
  // 1: the primary link fails: over c2
  assert.deepEqual(path(steps[1], 'users-app').devices, ['w-host', 'w1', 'c1', 'c2', 'c3', 'e1', 'e-srv']);
  let d = T.trafficDiff(steps[0], steps[1]);
  assert.deepEqual(d.filter((x) => x.of.startsWith('demand:')).map((x) => x.kind), ['rerouted', 'rerouted']);
  assert.ok(d.some((x) => x.of === 'relation:ospf-c1-c3' && x.kind === 'stopped'));
  const r = d.find((x) => x.of === 'demand:users-app');
  assert.ok(r.before.physical.some((t) => t.ref === 'link:l-c1-c3') && !r.after.physical.some((t) => t.ref === 'link:l-c1-c3'), 'the old way (faded) and the new one (emphasized)');
  // 2: w1 loses its LAN: VRRP fails over to w2; the camera, routed only by w1, is lost at the camera
  assert.deepEqual(path(steps[2], 'users-app').devices, ['w-host', 'w2', 'c2', 'c3', 'e1', 'e-srv']);
  const cam = path(steps[2], 'cam-video');
  assert.equal(cam.state, 'lost');
  assert.equal(cam.stop.device, 'w-cam');
  assert.deepEqual(cam.physical, []);
  // no advertisements to a member whose interface is down
  assert.deepEqual(ids(steps[2], 'relation:vrrp-users'), []);
  assert.deepEqual(ids(steps[0], 'relation:vrrp-users'), ['rel:vrrp-users:w1>w2']);
  d = T.trafficDiff(steps[1], steps[2]);
  assert.match(d.find((x) => x.of === 'demand:cam-video' && x.kind === 'lost').text, /^Demand cam-video is lost at w-cam: /);
  // 3 and 4: restored; at the end the preferred path again
  assert.equal(T.trafficDiff(steps[2], steps[3]).find((x) => x.of === 'demand:cam-video').kind, 'restored');
  assert.deepEqual(path(steps[4], 'users-app').devices, path(steps[0], 'users-app').devices);
  assert.deepEqual(steps[4].flows, steps[0].flows, 'with both links back the original traffic is back exactly');
});

test('deterministic: another order of the file, earlier runs and the failure order never change the flows', () => {
  const m = model(reroute);
  const a = JSON.stringify(T.trafficFlows(m, null));
  // the relations and demands listed in reverse
  const lines = reroute.split('\n');
  const rev = (start, end) => {
    const i = lines.indexOf(start);
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('  - {')) j++;
    const block = lines.slice(i + 1, j).reverse();
    lines.splice(i + 1, block.length, ...block);
  };
  rev('relations:');
  rev('demands:');
  const m2 = model(lines.join('\n'));
  assert.equal(JSON.stringify(T.trafficFlows(m2, null)), a);
  assert.equal(JSON.stringify(T.trafficFlows(m, null)), a, 'a second run');
  const f1 = F.simulate(m, ['link:l-c1-c3', 'link:l-w1-sw']);
  const f2 = F.simulate(m, ['link:l-w1-sw', 'link:l-c1-c3']);
  assert.equal(JSON.stringify(T.trafficFlows(m, f1)), JSON.stringify(T.trafficFlows(m, f2)));
});

test('the demands section: its form is checked; an end that names nothing is a warning, never an error', () => {
  const base = 'netatlas: 1\ndevices:\n  - {id: r1, type: router, interfaces: [{id: e0, ip: 10.0.0.1/30}]}\n';
  const msgs = (d) => {
    const r = validate.loadModel(base + 'demands:\n' + d);
    return { errors: r.errors.map((e) => e.message), warnings: r.warnings.map((e) => e.message), demands: r.model ? r.model.demands : [] };
  };
  let r = msgs('  - {id: d1, source: r1, destination: 10.0.0.2, bandwidth: 1.5G, class: video, label: Video}\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.demands.map((d) => [d.id, d.label, d.bps, d.class]), [['d1', 'Video', 1.5e9, 'video']]);
  r = msgs('  - {id: d1, source: r1, destination: 10.0.0.2}\n');
  assert.match(r.errors[0], /a demand needs its bandwidth, e\.g\. bandwidth: 200M/);
  r = msgs('  - {id: d1, source: r1, destination: 10.0.0.2, bandwidth: lots}\n');
  assert.match(r.errors[0], /"lots" is no bandwidth/);
  r = msgs('  - {id: d1, destination: r1, bandwidth: 1G}\n');
  assert.match(r.errors[0], /a demand needs its source/);
  r = msgs('  - {id: d1, source: nowhere, destination: r1, bandwidth: 1G, colour: red}\n');
  assert.match(r.errors[0], /unknown key "colour"/);
  r = msgs('  - {id: d1, source: nowhere, destination: r1, bandwidth: 1G}\n  - {id: d1, source: r1, destination: r1, bandwidth: 1G}\n');
  assert.ok(r.warnings.some((w) => /this demand can't be traced: .*nowhere/.test(w)), r.warnings.join('; '));
  assert.ok(r.errors.some((e) => /duplicate demand id "d1"/.test(e)));
  // a demand that can't be traced is a lost flow, with why
  const m = validate.loadModel(base + 'demands:\n  - {id: d1, source: nowhere, destination: r1, bandwidth: 1G}\n').model;
  const fl = T.trafficFlows(m, null).flows.find((f) => f.of === 'demand:d1');
  assert.equal(fl.state, 'lost');
  assert.match(fl.pathText, /nowhere/);
});

test('orienting cables: the walk from a device, a LAG member the same way as its sibling, unknown order both ways', () => {
  const m = model(example('enterprise-wan.yaml'));
  // hq-core1 → hq-core2 over both peer-link members, then on to the access switch
  assert.deepEqual(T.orientCables(m, ['l-core2-acc', 'l-peer2', 'l-peer1'], 'hq-core1'), [
    { ref: 'link:l-peer2', from: 'a', to: 'b' },
    { ref: 'link:l-peer1', from: 'a', to: 'b' },
    { ref: 'link:l-core2-acc', from: 'a', to: 'b' },
  ]);
  // a cable the walk never reaches: both ways
  assert.deepEqual(T.orientCables(m, ['l-muc-sw'], 'hq-core1'), [
    { ref: 'link:l-muc-sw', from: 'a', to: 'b' },
    { ref: 'link:l-muc-sw', from: 'b', to: 'a' },
  ]);
});
