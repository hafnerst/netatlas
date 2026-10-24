// What a comparison and a diagnosis may claim (analysis/comm-identity.ts, analysis/diagnosis.ts, Simulation.mqttEvidence):
// a host name's check matches only the send of its own family; an application's run answers only the communication it
// actually made; a subscriber's leg counts only the publications its own filters ask for; publication records that aged
// out are kept as an authoritative tally or said unavailable, never silently replaced by the retained tail; a stopped
// MQTT run is cancelled, not "none"; a missing route names its configured alternatives without picking the first; and a
// session's silence is "because its packets were dropped" only when each of its messages has its own recorded drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const D = load('analysis/diagnosis.js');
const I = load('analysis/comm-identity.js');
const R = load('analysis/result.js');
const M = load('analysis/sim/mqtt.js');
const configured = R.configuredContext('Selected endpoints');

// ------------------------------------------------------------------ a host name and its family

const DUAL = `netatlas: 1
title: dual
devices:
  - id: dns1
    type: server
    services: {dns: {zones: [{name: lab.example, records: [{name: web, type: A, value: 10.0.0.20}, {name: web, type: AAAA, value: "2001:db8::20"}]}]}}
    interfaces: [{id: eth0, ip: 10.0.0.53/24}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: [10.0.0.20/24, "2001:db8::20/64"]}], simulation: {listening: "tcp/80, tcp/443"}}
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: [10.0.0.30/24, "2001:db8::30/64"]}], dns_servers: [10.0.0.53]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "dns1:eth0"}
  - {id: l2, a: "sw:p2", b: "srv:eth0"}
  - {id: l3, a: "sw:p3", b: "pc:eth0"}
`;

/** The check, its identity and handoff, and the send it prepares run in a simulation. */
function nameCase(family, service = 'tcp/80') {
  const m = model(DUAL);
  const c = C.checkCommunication(m, { from: 'pc', to: 'web.lab.example', service, family });
  const id = I.commIdentity(m, c);
  const h = I.handoffOf(m, id);
  return { m, c, id, h };
}

test('a host name checked for IPv6: its AAAA send matches and compares; an IPv4 one never does, nor another service', () => {
  const v6 = nameCase(6);
  assert.equal(v6.id.destination.binding, 'name');
  assert.equal(v6.h.prefill.family, 6);
  const s = new S.Simulation(v6.m);
  s.runTo(5000);
  const run6 = s.sendPlan({ delivery: 'unicast', ...v6.h.prefill });
  s.runTo(s.now + 6000);
  assert.equal(run6.tests[0].qtype, 'AAAA');
  assert.equal(run6.tests[0].ok, true, run6.tests[0].result);
  assert.equal(run6.tests[0].dst.version, 6);
  assert.equal(I.planMatches(v6.id, run6.plan, v6.m), true, 'the IPv6 name check matches its AAAA send');
  assert.equal(I.runMatches(v6.id, run6, v6.m), true);
  const cmp = I.compareRun(v6.m, v6.c, run6, s.snapshot());
  assert.equal(cmp.agree, true, cmp.lines.join(' | '));
  // the IPv4 question and the IPv4 send of the same name
  const v4 = nameCase(4);
  const run4 = s.sendPlan({ delivery: 'unicast', ...v4.h.prefill });
  s.runTo(s.now + 6000);
  assert.equal(run4.tests[0].dst.version, 4);
  assert.equal(I.runMatches(v4.id, run4, v4.m), true);
  assert.equal(I.runMatches(v4.id, run6, v4.m), false, 'an IPv4 name check is not the IPv6 send of the same name');
  assert.equal(I.runMatches(v6.id, run4, v6.m), false, 'an IPv6 name check is not the IPv4 send of the same name');
  // a plan without a family resolves A: an IPv6 question never takes it
  assert.equal(I.planMatches(v6.id, { ...run6.plan, family: undefined }, v6.m), false);
  // the same name, another service
  const tls = nameCase(6, 'tcp/443');
  assert.equal(I.runMatches(tls.id, run6, tls.m), false, 'the same name and family, another port');
});

test('a host name is bound when sent: its address changing between messages is the same check; a record of the other family is not', () => {
  const v6 = nameCase(6);
  const s = new S.Simulation(v6.m);
  s.runTo(5000);
  const run = s.sendPlan({ delivery: 'unicast', ...v6.h.prefill, count: 2, interval: 1 });
  s.runTo(s.now + 8000);
  assert.equal(run.tests.length, 2);
  // as if the name's AAAA record had moved between the two messages (another address of the same family)
  const moved = { ...run, tests: [run.tests[0], { ...run.tests[1], dst: { ...run.tests[1].dst, bytes: run.tests[1].dst.bytes.map((b, i) => (i === 15 ? 21 : b)) } }] };
  assert.equal(I.runMatches(v6.id, moved, v6.m), true, 'name binding: whichever address it resolved to when sent');
  // one message resolved to an IPv4 address (an A answer): not this IPv6 check's run
  const v4dst = { version: 4, bytes: [10, 0, 0, 20] };
  const wrong = { ...run, tests: [run.tests[0], { ...run.tests[1], dst: v4dst }] };
  assert.equal(I.runMatches(v6.id, wrong, v6.m), false, 'a message sent to an IPv4 address is not an IPv6 check’s');
  // a message whose name was never resolved has no destination of its own: not evidence either way
  const unresolved = { ...run, tests: [run.tests[0], { ...run.tests[1], resolved: undefined, dst: v4dst, done: true, ok: false, outcome: { kind: 'name' } }] };
  assert.equal(I.runMatches(v6.id, unresolved, v6.m), true, 'an unresolved name’s placeholder address is no runtime identity');
});

// ------------------------------------------------------------------ an application's run answers its own communication

const APP = `netatlas: 1
title: app
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.10/24}], services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web"}]}}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.20/24}], services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}, {id: tls, name: TLS, profile: tcp_server, port: 443}]}}
  - {id: other, type: server, interfaces: [{id: eth0, ip: 10.0.0.30/24}], services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}]}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "srv:eth0", b: "sw:p2"}
  - {id: c, a: "other:eth0", b: "sw:p3"}
`;

test('an application run answers only its own communication: another destination or service is refused, with why', () => {
  const m = model(APP);
  const s = new S.Simulation(m);
  s.runTo(3000);
  const a = s.actApp('pc', 'get', 'experiment');
  assert.ok(!a.error, a.error);
  s.runTo(s.now + 5000);
  const run = s.appRunsOf('pc', 'get')[0];
  assert.ok(run && run.tests.length && run.tests[0].ok, 'the application ran');
  const ask = (rq) => I.commIdentity(m, C.checkCommunication(m, { from: 'pc/get', ...rq }));
  assert.equal(I.appRunProblem(m, ask({}), run), null, 'its own question');
  assert.equal(I.appRunProblem(m, ask({ to: 'srv' }), run), null, 'its peer’s device, the same service');
  assert.match(I.appRunProblem(m, ask({ to: 'other' }), run) || '', /destination/i);
  assert.match(I.appRunProblem(m, ask({ service: 'tcp/443' }), run) || '', /TCP 443/);
  assert.match(I.appRunProblem(m, ask({ to: 'srv', service: 'tcp/443' }), run) || '', /TCP 443/);
  assert.match(I.appRunProblem(m, ask({ family: 6 }), run) || '', /IPv6/);
});

// ------------------------------------------------------------------ MQTT

const MQ = (o = {}) => `netatlas: 1
title: mqtt
devices:
  - {id: broker, type: server, services: {mqtt_broker: {}}, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: pa, type: endpoint, services: {applications: [{id: a, name: A, profile: mqtt_client, broker: broker, publish: [${o.topics || 's/a'}], interval: ${o.interval || '1s'}, qos: "${o.qos === undefined ? 1 : o.qos}"${o.count ? ', count: ' + o.count : ''}}]}, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: sub, type: endpoint, services: {applications: [{id: v, name: V, profile: mqtt_client, broker: broker, subscribe: [${o.filters || '"s/#"'}], qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.20/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p4, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "broker:eth0"}
  - {id: l2, a: "sw:p2", b: "pa:eth0"}
  - {id: l4, a: "sw:p4", b: "sub:eth0"}
`;
const start = (s, dev, app) => {
  const a = s.actApp(dev, app);
  assert.ok(!a.error, a.error);
  return a;
};
const legsOf = (d) => ({ pub: d.legs.find((l) => /^Publisher /.test(l.label)), sub: d.legs.find((l) => /^Broker .* → subscriber sub\/v/.test(l.label)) });
const mqDiag = (s, m) => D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]) });

test('MQTT topic scope: a subscriber of s/a only is established when every s/a publication reached it — s/b is not its', () => {
  const m = model(MQ({ topics: 's/a, s/b', filters: 's/a' }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  const a = start(s, 'pa', 'a');
  s.play(5000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(3000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  const topics = new Set(mq.pubs.map((p) => p.topic));
  assert.deepEqual(Array.from(topics).sort(), ['s/a', 's/b'], 'the run published both topics');
  const forSub = mq.pubs.filter((p) => p.topic === 's/a' && p.brokerRx !== undefined);
  assert.ok(forSub.length >= 3);
  assert.ok(forSub.every((p) => p.deliveries.some((x) => x.clientId === mq.subscribers[0].clientId && x.rx !== undefined)), 'each s/a publication received');
  assert.ok(mq.pubs.filter((p) => p.topic === 's/b').every((p) => !p.deliveries.some((x) => x.clientId === mq.subscribers[0].clientId)), 'the broker rightly passed no s/b to it');
  const d = mqDiag(s, m);
  const L = legsOf(d);
  assert.equal(L.sub.state, 'established', L.sub.text);
  assert.match(L.sub.text, new RegExp(`^received ${forSub.length} of the ${forSub.length} publications of run #${mq.run.id} on its topics \\(s/a\\)`));
  assert.equal(d.state, 'established', d.summary);
});

test('MQTT topic scope: a refused subscription stays a real condition — the broker passing it nothing is its prerequisite', () => {
  // a filter the broker refuses: an empty level separator is still a valid filter, so the refusal is forced at the broker
  const m = model(MQ({ topics: 's/a', filters: 's/a' }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const sa = start(s, 'sub', 'v');
  s.play(1500);
  // (refused as the broker answers 0x80: the client's granted table says so)
  const subC = s.mqtt.clients.find((c) => c.run.dev === 'sub');
  const b = s.mqtt.brokers.values().next().value;
  for (const bs of b.sessions.values()) bs.subs.clear();
  subC.granted.set('s/a', 0x80);
  const a = start(s, 'pa', 'a');
  s.play(4000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(3000);
  const L = legsOf(mqDiag(s, m));
  assert.equal(L.sub.state, 'blocked', L.sub.text);
  assert.match(L.sub.text, /s\/a → refused/);
  assert.ok(sa);
});

test('MQTT stop before connecting, and before the first publication: the run is cancelled, never "none"', () => {
  const m = model(MQ({ interval: '10s' }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  // stopped at once: before its CONNACK
  const a = start(s, 'pa', 'a');
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(2000);
  let d = mqDiag(s, m);
  let L = legsOf(d);
  assert.equal(L.pub.state, 'cancelled', L.pub.text);
  assert.equal(L.sub.state, 'cancelled', L.sub.text);
  assert.deepEqual([d.runtime.completed, d.runtime.outcome, d.state], [true, 'cancelled', 'cancelled'], d.summary);
  // stopped before its first publication: the broker can't be reached (its first round goes with its CONNACK), Stop after
  // its attempts to connect
  s.engine.impair = (l) => (l === 'l1' ? { lose: true } : null);
  const b = start(s, 'pa', 'a');
  s.play(3000);
  const c = s.mqtt.clients.filter((x) => x.run.dev === 'pa').pop();
  assert.equal(c.published, 0, 'nothing published yet');
  assert.ok(s.actionControl(b.id, 'stop'));
  s.play(2000);
  d = mqDiag(s, m);
  L = legsOf(d);
  assert.equal(L.pub.state, 'cancelled', L.pub.text);
  assert.deepEqual([d.runtime.completed, d.runtime.outcome, d.state], [true, 'cancelled', 'cancelled'], d.summary);
});

test('MQTT mixed outcomes: the publisher established, the subscriber blocked — mixed, not succeeded; a subscriber still receiving keeps it open', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  // the subscriber's cable loses everything the broker sends it
  s.engine.impair = (l, f) => (l === 'l4' && f.ip && f.ip.l4 && f.ip.l4.sport === 1883 ? { lose: true } : null);
  const a = start(s, 'pa', 'a');
  s.play(4000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(500);
  // stopped, its copies to the subscriber still being retransmitted: not completed
  let d = mqDiag(s, m);
  let L = legsOf(d);
  assert.equal(L.pub.state, 'established', L.pub.text);
  assert.ok(L.sub.state === 'waiting' || L.sub.state === 'in-progress', L.sub.state + ': ' + L.sub.text);
  assert.equal(d.runtime.completed, false, 'a delivery that can still complete keeps the run open');
  // the subscriber stops: its leg is terminal, not delivered
  const sv = s.mqtt.clients.find((x) => x.run.dev === 'sub');
  s.actionControl(sv.run.id, 'stop');
  s.play(3000);
  d = mqDiag(s, m);
  L = legsOf(d);
  assert.ok(['failed', 'blocked'].indexOf(L.sub.state) >= 0, L.sub.state + ': ' + L.sub.text);
  assert.equal(d.runtime.completed, true);
  assert.equal(d.runtime.outcome, 'mixed');
  assert.notEqual(d.state, 'established');
});

/** A run's tally summed over its topics. */
const sum = (tally) => Object.values(tally).reduce((t, x) => ({ n: t.n + x.n, acked: t.acked + x.acked, lost: t.lost + x.lost, cancelled: t.cancelled + x.cancelled, rx: t.rx + x.rx, open: t.open + x.open }), { n: 0, acked: 0, lost: 0, cancelled: 0, rx: 0, open: 0 });

test('MQTT retention at its real bound: records that aged out are the run’s tally — all succeeded is every publication, said so', () => {
  assert.equal(M.PUBS_KEPT, 2000);
  const m = model(MQ({ interval: '100ms', qos: 1 }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  const a = start(s, 'pa', 'a');
  // past the bound: more publications than the records keep
  s.runTo(s.now + (M.PUBS_KEPT + 300) * 100);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.runTo(s.now + 5000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  const t = sum(mq.tally);
  assert.equal(mq.pubs.length, M.PUBS_KEPT);
  assert.ok(t.n >= 250, `some aged out (${t.n})`);
  assert.equal(t.n + mq.pubs.length, mq.run.published, 'every publication counted once: kept, or in the tally');
  assert.deepEqual([t.acked, t.open, t.lost], [t.n, 0, 0], 'they had all settled, acknowledged');
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq });
  const L = legsOf(d);
  assert.equal(L.pub.state, 'established', L.pub.text);
  assert.match(L.pub.text, new RegExp(`^${mq.run.published} publications \\(${t.n} of them aged out of the records: counted from the run’s tally\\), ${mq.run.published} acknowledged`));
  assert.equal(L.sub.state, 'established', L.sub.text);
  assert.match(L.sub.text, new RegExp(`^received ${mq.run.published} of the ${mq.run.published} publications`));
  assert.equal(d.evidenceLimited, false, 'the tally is authoritative: nothing is unknown');
  assert.ok(d.limits.some((x) => new RegExp(`^${t.n} publications of run #[0-9]+ aged out of the records .*counted from the run’s tally, as they had settled`).test(x)), d.limits.join(' | '));
  // the text export says the same as the legs (scope and certainty)
  const txt = D.diagnosisText(d).join('\n');
  assert.match(txt, /aged out of the records: counted from the run’s tally/);
});

test('MQTT retention: an earlier failure followed by enough successes to cross the bound stays counted — not "established" from the retained tail', () => {
  const m = model(MQ({ interval: '100ms', qos: 1 }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const sv = start(s, 'sub', 'v');
  s.play(1500);
  const a = start(s, 'pa', 'a');
  s.runTo(s.now + 2000);
  // the subscriber stops for 3 s: the broker passes it nothing then (no session with a matching subscription)
  assert.ok(s.actionControl(sv.id, 'stop'));
  s.runTo(s.now + 3000);
  start(s, 'sub', 'v');
  s.runTo(s.now + (M.PUBS_KEPT + 300) * 100);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.runTo(s.now + 5000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  const cid = mq.subscribers[0].clientId;
  const kept = mq.pubs.filter((p) => p.brokerRx !== undefined);
  assert.ok(kept.every((p) => p.deliveries.some((x) => x.clientId === cid && x.rx !== undefined)), 'every retained publication reached it');
  const t = mq.tally['s/a'];
  assert.ok(t.rx - t.subs[cid].got - t.subs[cid].open >= 20, `the tally keeps those it was not passed (${JSON.stringify(t)})`);
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq });
  const L = legsOf(d);
  assert.equal(L.pub.state, 'established', L.pub.text);
  assert.equal(L.sub.state, 'partial', L.sub.text);
  assert.match(L.sub.text, /not passed to it by the broker/);
  assert.equal(d.state, 'partial', d.summary);
});

test('MQTT retention: unsettled records that age out are unavailable — every retained one acknowledged is not the whole run', () => {
  const m = model(MQ({ interval: '100ms', qos: 1 }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  const a = start(s, 'pa', 'a');
  s.runTo(s.now + 3000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.runTo(s.now + 3000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  // as a tally holds them when records aged out before they settled (forced out past twice the bound)
  const open = { ...mq, tally: { 's/a': { n: 3, acked: 0, lost: 0, cancelled: 0, rx: 3, open: 3, subs: { [mq.subscribers[0].clientId]: { got: 0, open: 3 } } } } };
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: open });
  const L = legsOf(d);
  assert.equal(L.pub.state, 'indeterminate', L.pub.text);
  assert.match(L.pub.text, /every retained publication acknowledged; 3 earlier publications’ outcomes are unavailable/);
  assert.equal(L.sub.state, 'indeterminate', L.sub.text);
  assert.match(L.sub.text, /^received every retained one of the/);
  assert.notEqual(d.state, 'established');
  assert.equal(d.runtime.outcome, 'none', 'not succeeded: some outcomes are unavailable');
  assert.equal(d.evidenceLimited, true);
  assert.match(D.diagnosisText(d).join('\n'), /3 earlier publications’ outcomes are unavailable/);
});

test('MQTT retention keeps records still open: a publication waiting for its PUBACK at the bound is not aged out before it settles', () => {
  const m = model(MQ({ interval: '100ms', qos: 1 }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const a = start(s, 'pa', 'a');
  s.runTo(s.now + 1000);
  const mqtt = s.mqtt;
  // (as a record whose PUBACK is outstanding: the oldest record held open)
  const first = mqtt.pubs[0];
  const saved = first.acked;
  first.acked = undefined;
  s.runTo(s.now + (M.PUBS_KEPT + 50) * 100);
  assert.ok(mqtt.pubs.includes(first), 'the open record stays while settled ones age out');
  assert.equal(mqtt.pubs.length, M.PUBS_KEPT);
  first.acked = saved;
  assert.ok(s.actionControl(a.id, 'stop'));
  s.runTo(s.now + 3000);
  const t = sum(s.mqttEvidence('pa', 'a', []).tally);
  assert.equal(t.open, 0, 'nothing unsettled aged out');
});

// ------------------------------------------------------------------ prerequisites: recorded identity, not a first path or a count

// h1 — r1 ==(gre, gre2: two tunnels through fw)== r2 — h2; fw lets only r1's packets through, so neither tunnel comes up
const TWO = `netatlas: 1
title: two tunnels
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 198.51.100.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 203.0.113.1}, {id: tun1, type: tunnel, ip: 172.16.1.1/30, source: wan, destination: 203.0.113.1}]
    routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}, {prefix: 10.2.0.0/24, via: 172.16.0.2}, {prefix: 10.2.0.0/24, via: 172.16.1.2}]
  - id: fw
    type: firewall
    interfaces: [{id: a, ip: 198.51.100.2/30}, {id: b, ip: 203.0.113.2/30}]
    policy:
      default: deny
      stateful: false
      rules:
        - {action: permit, source: r1, destination: r2}
  - id: r2
    type: router
    interfaces: [{id: wan, ip: 203.0.113.1/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}, {id: tun1, type: tunnel, ip: 172.16.1.2/30, source: wan, destination: 198.51.100.1}]
    routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}, {prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l0, a: "h1:eth0", b: "r1:lan"}
  - {id: l1, a: "r1:wan", b: "fw:a"}
  - {id: l2, a: "fw:b", b: "r2:wan"}
  - {id: l3, a: "r2:lan", b: "h2:eth0"}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"], attrs: {key: 1}}
  - {id: gre2, protocol: gre, endpoints: ["r1:tun1", "r2:tun1"], attrs: {key: 2}}
`;

const chainText = (d) => d.chain.map((l) => `[${l.rel}] ${l.text}`).join('\n');

test('no route with two configured alternatives, both unusable: each is named from the recorded decision, neither picked as the one it needed', () => {
  const m = model(TWO);
  const s = new S.Simulation(m);
  s.runTo(40000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'h1', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const t = run.tests[0];
  const nr = t.outcome.drops.find((x) => x.seq === t.outcome.event);
  assert.ok(nr && nr.cause.kind === 'no-route', JSON.stringify(t.outcome));
  // the device's own decision, recorded: both routes, each with its tunnel
  assert.deepEqual(nr.cause.unusable.map((u) => [u.iface, u.relation]).sort(), [['tun0', 'gre'], ['tun1', 'gre2']]);
  const c = C.checkCommunication(m, { from: 'h1', to: 'h2' });
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  const about = (r) => d.chain.filter((l) => l.refs.some((x) => x.ref === 'relation:' + r));
  for (const r of ['gre', 'gre2']) {
    assert.ok(about(r).length, `${r} named: ${chainText(d)}`);
    assert.ok(about(r).every((l) => l.rel !== 'prerequisite' && l.rel !== 'cause'), `${r}: one alternative is not the prerequisite\n${chainText(d)}`);
    assert.ok(about(r).some((l) => /one of its routes to it .* could not be used at the drop/.test(l.text)), chainText(d));
  }
});

test('no route without a recorded decision: every configured alternative is named as related, the first path not picked', () => {
  const m = model(TWO);
  const s = new S.Simulation(m);
  s.runTo(40000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'h1', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const ev = s.runEvidence(run);
  // (a drop that recorded no route decision: only the configured model's paths are left as a clue)
  for (const x of ev.tests[0].outcome.drops) delete x.cause.unusable;
  const c = C.checkCommunication(m, { from: 'h1', to: 'h2' });
  assert.ok(c.trace.paths.length >= 2, 'two configured alternatives');
  const d = D.diagnose({ check: c, context: configured, runtime: ev });
  for (const r of ['gre', 'gre2']) {
    const ls = d.chain.filter((l) => l.refs.some((x) => x.ref === 'relation:' + r));
    assert.ok(ls.length, `${r} named: ${chainText(d)}`);
    assert.ok(ls.every((l) => l.rel === 'related' || l.rel === 'hypothesis'), `${r} stays related\n${chainText(d)}`);
  }
  assert.ok(!d.chain.some((l) => l.rel === 'prerequisite' && l.refs.some((x) => x.ref.indexOf('relation:') === 0)), chainText(d));
  assert.ok(!d.chain.some((l) => l.rel === 'cause' && /heard nothing/.test(l.text)), 'a session of a static alternative never becomes the cause');
});

// a crafted record (test-only, deterministic): a send whose only attempt met gre down at r1; gre went down at 8 s,
// having last heard r2 at 2 s; r2's keepalives in that interval and their drops are `msgs` and `drops`
function sessionCase(msgs, drops) {
  const m = model(TWO);
  const c = C.checkCommunication(m, { from: 'h1', to: 'h2' });
  const test = { id: 1, msg: 1, kind: 'icmp', port: 0, target: '10.2.0.10', dst: { version: 4, bytes: [10, 2, 0, 10] }, pktIds: [500], started: 9000, ended: 14000, done: true, ok: false, result: 'no answer (timed out)', answers: [] };
  test.outcome = { kind: 'timeout', attempts: 1, logFrom: 0, drops: [{ seq: 90, t: 9000, device: 'r1', cause: { kind: 'tunnel-down', relation: 'gre', iface: 'tun0', pkt: 500 }, text: 'gre is down at r1', attempt: true }] };
  const log = [];
  for (const [seq, t] of msgs) log.push({ seq, t, kind: 'message', protocol: 'gre', device: 'r2', peer: 'r1', what: 'keepalive', state: '', detail: 'r2 → r1 keepalive', relation: 'gre' });
  for (const [seq, t, msg, extra] of drops) log.push({ seq, t, kind: 'drop', protocol: 'gre', device: 'fw', peer: '', what: 'keepalive', state: '', detail: 'fw denied it', cause: { kind: 'policy', session: 'gre', from: 'r2', msg, policy: { device: 'fw', action: 'deny', byDefault: true, text: 'default deny' }, ...(extra || {}) } });
  log.push({ seq: 80, t: 8000, kind: 'state', protocol: 'gre', device: 'r1', peer: 'r2', what: 'Down', state: 'Down', detail: 'gre down', transition: { ref: 'relation:gre', up: false, reason: 'nothing heard for 6 s', device: 'r1', lastHeard: 2000 } });
  log.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const ev = { exec: 7, subject: { kind: 'send', id: 1, label: 'send #1', t0: 9000, stopped: false, count: 1, sent: 1, skipped: [] }, tests: [test], events: [], log, waits: () => [], retained: { first: 0, firstSeq: 0, dropped: 0 }, now: 20000 };
  const d = D.diagnose({ check: c, context: configured, runtime: ev });
  return d.chain.find((l) => /heard nothing|were dropped/.test(l.text));
}

test('a session’s silence by identity: each message with a drop of its own is the cause; duplicate drops of one message, a copy, or an earlier message never cover another', () => {
  // two keepalives, each dropped (the first twice: a duplicate observation) — every message covered, one cause
  let l = sessionCase([[30, 3000], [50, 5000]], [[31, 3001, 30], [32, 3002, 30], [51, 5001, 50]]);
  assert.equal(l.rel, 'cause', l.text);
  assert.match(l.text, /^It heard nothing because the packets its peer sent to r1 were dropped .*\(2 of 2 messages with a drop of its own recorded; 3 drops in all\)/);
  // as many drops as messages, but both of the first one: the second message's fate is not recorded — contributing
  l = sessionCase([[30, 3000], [50, 5000]], [[31, 3001, 30], [32, 3002, 30]]);
  assert.equal(l.rel, 'contributing', l.text);
  assert.match(l.text, /^Some of .*\(1 of 2 messages with a drop of its own recorded; 2 drops in all\)/);
  // a multicast copy dropped on one way is no loss of the message
  l = sessionCase([[30, 3000]], [[31, 3001, 30, { copy: true }]]);
  assert.equal(l.rel, 'contributing', l.text);
  // a message sent before the interval, dropped in it (delayed), covers nothing of the interval's own messages
  l = sessionCase([[10, 1000], [30, 3000], [50, 5000]], [[33, 3500, 10], [51, 5001, 50]]);
  assert.equal(l.rel, 'contributing', l.text);
  assert.match(l.text, /\(1 of 2 messages with a drop of its own recorded; 2 drops in all\)/);
  // equal timestamps: a message at the interval's start (when it was last heard) is not in it; one at its end is
  l = sessionCase([[20, 2000], [30, 3000], [79, 8000]], [[31, 3001, 30], [79.5, 8000, 79]]);
  assert.equal(l.rel, 'cause', l.text);
  assert.match(l.text, /2 of 2 messages/);
});

test('the real session that went down: its silence is the cause only with every message of the interval dropped, said by identity', () => {
  const m = model(TWO.replace('        - {action: permit, source: r1, destination: r2}', '        - {action: permit, source: r1, destination: r2}\n        - {action: permit, source: r2, destination: r1}'));
  const s = new S.Simulation(m);
  s.runTo(30000);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Up');
  s.engine.impair = (l, f) => (l === 'l2' && f.ip && f.ip.src.bytes[0] === 203 ? { lose: true } : null);
  s.runTo(s.now + 60000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'h1', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'h1', to: 'h2' }), context: configured, runtime: s.runEvidence(run) });
  const why = d.chain.filter((l) => /heard nothing|were dropped/.test(l.text));
  assert.ok(why.length, chainText(d));
  for (const l of why) {
    const [, k, n] = /\((\d+) of (\d+) messages? with a drop of its own recorded/.exec(l.text) || [];
    assert.ok(n !== undefined, l.text);
    assert.equal(l.rel === 'cause' || l.rel === 'related', k === n, `${l.rel}: ${l.text}`);
  }
});
