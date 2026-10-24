// Runtime evidence scoped to the question (analysis/diagnosis.ts with Simulation.mqttEvidence, appEvidence, packet,
// eventKept): an MQTT run's own publications — never an earlier run's receipts, another publisher's or another topic's
// — with the broker's receipt, PUBACK and each subscriber's receipt apart; a pending PUBACK is waiting, never a failure;
// a client application's own run and its retries, said as that run; records named by their execution, so a later
// simulation's reused numbers never answer them; a packet's own record (an original or a retransmission, an outer one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const D = load('analysis/diagnosis.js');
const R = load('analysis/result.js');
const configured = R.configuredContext('Selected endpoints');

const MQ = (o = {}) => `netatlas: 1
title: mqtt
devices:
  - {id: broker, type: server, services: {mqtt_broker: {}}, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: pa, type: endpoint, services: {applications: [{id: a, name: A, profile: mqtt_client, broker: broker, publish: [s/a], interval: 1s, qos: "${o.qos === undefined ? 1 : o.qos}"}]}, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: pb, type: endpoint, services: {applications: [{id: b, name: B, profile: mqtt_client, broker: broker, publish: [s/b], interval: 1s, qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.12/24}]}
  - {id: sub, type: endpoint, services: {applications: [{id: v, name: V, profile: mqtt_client, broker: broker, subscribe: ["s/#"], qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.20/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "broker:eth0"}
  - {id: l2, a: "sw:p2", b: "pa:eth0"}
  - {id: l3, a: "sw:p3", b: "pb:eth0"}
  - {id: l4, a: "sw:p4", b: "sub:eth0"}
`;

const start = (s, dev, app) => {
  const a = s.actApp(dev, app);
  assert.ok(!a.error, a.error);
  return a;
};
const legs = (d) => ({ pub: d.legs.find((l) => /^Publisher /.test(l.label)), sub: d.legs.find((l) => /^Broker .* → subscriber sub\/v/.test(l.label)) });
const diag = (s, m) => D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]) });

test('MQTT, two publishers and an overlapping subscription: only this run’s publications count for its subscriber leg', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  const a = start(s, 'pa', 'a');
  start(s, 'pb', 'b');
  s.play(5000);
  // (stopped and settled: every publication of the run acknowledged and delivered, nothing on its way)
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(3000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  assert.ok(mq.pubs.length >= 3);
  assert.ok(mq.pubs.every((p) => p.topic === 's/a' && p.dev === 'pa' && p.run === mq.run.id), 'only pa/a’s run');
  // the subscriber received both topics; its leg counts pa's publications only
  const subC = s.mqtt.clients.find((c) => c.run.dev === 'sub');
  const all = Array.from(subC.received.values()).reduce((x, y) => x + y, 0);
  const reached = mq.pubs.filter((p) => p.brokerRx !== undefined).length;
  const got = mq.pubs.filter((p) => p.deliveries.some((x) => x.clientId === mq.subscribers[0].clientId && x.rx !== undefined)).length;
  assert.ok(all > got, `lifetime receipts (${all}, both topics) are not this question's (${got})`);
  assert.equal(got, reached, 'each reached the subscriber');
  const d = diag(s, m);
  const L = legs(d);
  assert.equal(L.pub.state, 'established', L.pub.text);
  assert.equal(L.sub.state, 'established', L.sub.text);
  assert.match(L.sub.text, new RegExp(`^received ${got} of the ${reached} publications of run #${mq.run.id} that reached the broker`));
  assert.match(d.question.run, new RegExp(`^MQTT run #${mq.run.id} of pa/a \\(started from Network events`));
});

test('MQTT, stop and start again: the new run is its own; the subscriber’s earlier receipts prove nothing of it', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const sv = start(s, 'sub', 'v');
  s.play(1500);
  const a1 = start(s, 'pa', 'a');
  s.play(4000);
  assert.ok(diag(s, m).legs.length >= 2);
  // stop both; start the publisher again without the subscriber
  assert.ok(s.actionControl(a1.id, 'stop'));
  assert.ok(s.actionControl(sv.id, 'stop'));
  s.play(3000);
  const a2 = start(s, 'pa', 'a');
  s.play(4000);
  const mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  assert.equal(mq.run.id, a2.app.id);
  assert.equal(mq.run.earlier, 1, 'the earlier run is said, not counted');
  assert.ok(mq.pubs.every((p) => p.run === a2.app.id));
  const subC = s.mqtt.clients.filter((c) => c.run.dev === 'sub');
  assert.ok(Array.from(subC[0].received.values()).reduce((x, y) => x + y, 0) > 0, 'it did receive — the earlier run’s publications');
  const L = legs(D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq }));
  assert.equal(L.sub.state, 'blocked', L.sub.text);
  assert.match(L.sub.text, /the broker passed none of the \d+ publications to it: when they arrived it had no session with a matching subscription .*its run #\d+ is stopped/);
});

test('MQTT QoS 1: a PUBACK still on its way is waiting, never a failure; a DUP is a copy of the same publication, its PUBACK completes it', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  // the broker's PUBACKs to pa are lost for 25 s (TCP sends them again, and they are lost again); then they pass
  const until = s.now + 25000;
  s.engine.impair = (l, f) => (l === 'l2' && s.engine.now < until && f.msg && f.msg.type === 'MQTT PUBACK' ? { lose: true } : null);
  const a = start(s, 'pa', 'a');
  s.play(3000);
  let mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  assert.ok(mq.pubs.length > 0 && mq.pubs.every((p) => p.acked === undefined && p.lost === undefined), 'nothing acknowledged yet, nothing lost');
  assert.ok(mq.pubs.every((p) => p.brokerRx !== undefined), 'the broker received them (recorded at the broker)');
  let L = legs(D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq }));
  assert.equal(L.pub.state, 'waiting', L.pub.text);
  assert.match(L.pub.text, /waiting for PUBACK.*the broker received \d+ of those waiting — their PUBACK has not arrived/);
  s.play(40000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(3000);
  mq = s.mqttEvidence('pa', 'a', [{ dev: 'sub', app: 'v' }]);
  const first = mq.pubs[0];
  assert.ok(first.dups >= 1, 'sent again with DUP');
  assert.ok(first.brokerRxCount >= 2, 'the broker received the copy too');
  assert.ok(first.acked !== undefined, 'acknowledged in the end');
  const dl = first.deliveries.find((x) => x.clientId === mq.subscribers[0].clientId);
  assert.ok(dl && dl.copies >= 2 && dl.rxCount >= 2, 'passed on again, as QoS 1 allows — a legitimate duplicate');
  L = legs(D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq }));
  assert.match(L.sub.text, /more than once: a QoS 1 DUP, as MQTT 3\.1\.1 allows/);
});

test('MQTT: the publisher’s leg established, the subscriber’s not — its copies are lost on its cable', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'sub', 'v');
  s.play(1500);
  s.engine.impair = (l, f) => (l === 'l4' && f.msg && f.msg.type === 'MQTT PUBLISH' ? { lose: true } : null);
  const a = start(s, 'pa', 'a');
  s.play(4000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(3000);
  const d = diag(s, m);
  const L = legs(d);
  assert.equal(L.pub.state, 'established', L.pub.text);
  // its run goes on (it is not stopped): the broker's copies are recorded as sent, their receipt not — waiting, not "received"
  assert.equal(L.sub.state, 'waiting', L.sub.text);
  assert.match(L.sub.text, /^the broker sent \d+ to it; its receipt is not recorded yet/);
  // (one leg established, one still waiting: the run's answer is waiting — provisional, never complete success)
  assert.deepEqual([d.state, d.provisional], ['waiting', true]);
});

test('MQTT QoS 0: the broker’s receipt is what the broker recorded; no PUBACK is no evidence of loss', () => {
  const m = model(MQ({ qos: 0 }));
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const a = start(s, 'pa', 'a');
  s.play(4000);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.play(2000);
  const mq = s.mqttEvidence('pa', 'a', []);
  assert.ok(mq.pubs.length && mq.pubs.every((p) => p.qos === 0 && p.acked === undefined));
  const L = legs(D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: mq }));
  assert.equal(L.pub.state, 'established', L.pub.text);
  assert.match(L.pub.text, /at QoS 0: \d+ received by the broker \(recorded at the broker\)/);
});

test('MQTT evidence expiry: publications no longer kept are said and counted neither way', () => {
  const m = model(MQ());
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  start(s, 'pa', 'a');
  s.play(3000);
  const mq = s.mqttEvidence('pa', 'a', []);
  // (as when the records' bound dropped the run's oldest publications)
  const gone = { ...mq, pubs: mq.pubs.slice(1), evicted: 1 };
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pa/a' }), context: configured, mqtt: gone });
  assert.equal(d.evidenceLimited, true);
  assert.ok(d.limits.some((x) => /^1 publication of run #\d+ is no longer kept/.test(x)));
  // the record's own bound
  const M = load('analysis/sim/mqtt.js');
  assert.ok(M.PUBS_KEPT >= 1000);
});

// ------------------------------------------------------------------ a client application's own run

const APP = `netatlas: 1
title: app
devices:
  - {id: cl, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.10/24}], services: {applications: [{id: ask, name: Ask, profile: udp_client, peer: "srv/ans", timeout: 1s, retries: 2}]}}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.20/24}], services: {applications: [{id: ans, name: Ans, profile: udp_server, port: 5000}]}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "cl:eth0", b: "sw:p1"}
  - {id: b, a: "srv:eth0", b: "sw:p2"}
`;

test('an application’s own run: its retries are one message’s attempts, said as that run — recovered after a lost request', () => {
  const m = model(APP);
  const s = new S.Simulation(m);
  s.runTo(3000);
  let n = 0;
  s.engine.impair = (l, f) => (l === 'a' && f.ip && f.ip.l4 && f.ip.l4.dport === 5000 && n++ === 0 ? { lose: true } : null);
  const a = s.actApp('cl', 'ask', 'experiment');
  assert.ok(!a.error, a.error);
  s.runTo(s.now + 6000);
  const run = s.appRunsOf('cl', 'ask')[0];
  assert.equal(run.id, a.app.id);
  assert.deepEqual(run.tests.map((t) => [t.msg, t.retry || 0, t.ok]), [[1, 0, false], [1, 1, true]]);
  const c = C.checkCommunication(m, { from: 'cl/ask' });
  const ev = s.appEvidence(run);
  assert.match(ev.subject.label, /^application run #\d+ of cl\/ask \(started by an experiment at t = 3\.0 s, to srv\/ans\)$/);
  const d = D.diagnose({ check: c, context: configured, runtime: ev });
  assert.equal(d.state, 'recovered', d.summary);
  assert.deepEqual([d.runtime.kind, d.runtime.completed, d.runtime.counts.recovered], ['app', true, 1]);
  assert.match(d.summary, /Answered at attempt 2 after 1 retry \(timed out\)/);
  assert.ok(d.chain.some((l) => l.rel === 'contributing' && /^attempt 1: it timed out/.test(l.text)), 'the lost attempt is contributing, not the outcome');
  // a send prepared like it is not its run
  s.sendPlan({ delivery: 'unicast', from: 'cl', kind: 'udp', port: 5000, to: 'srv', toIface: 'eth0', toAddr: '10.0.0.20' });
  assert.equal(s.appRunsOf('cl', 'ask')[0].id, run.id);
});

test('an application run whose every attempt fails: each attempt is said; the message fails once, its retries counted apart', () => {
  const m = model(APP);
  const s = new S.Simulation(m);
  s.runTo(3000);
  s.engine.impair = (l, f) => (l === 'a' && f.ip && f.ip.l4 && f.ip.l4.dport === 5000 ? { lose: true } : null);
  s.actApp('cl', 'ask', 'experiment');
  s.runTo(s.now + 8000);
  const run = s.appRunsOf('cl', 'ask')[0];
  assert.equal(run.tests.length, 3);
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'cl/ask' }), context: configured, runtime: s.appEvidence(run) });
  assert.equal(d.runtime.counts.failed, 1, 'one message');
  assert.equal(d.state, 'blocked', d.summary);
  assert.equal(d.chain.filter((l) => /^attempt [12]: /.test(l.text)).length, 2);
});

// ------------------------------------------------------------------ records named by their execution

test('records: a packet’s own record (original and retransmission apart, an outer packet’s frame); executions apart; an evicted event said', () => {
  const m = model(`netatlas: 1
title: two
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.10/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.20/24}], simulation: {listening: "tcp/80"}}
links:
  - {id: l, a: "pc:eth0", b: "srv:eth0"}
`);
  const s1 = new S.Simulation(m);
  const s2 = new S.Simulation(m);
  assert.notEqual(s1.exec, s2.exec);
  s1.runTo(3000);
  let first = true;
  s1.engine.impair = (l, f) => (first && f.ip && f.ip.l4 && f.ip.l4.proto === 'tcp' && (f.ip.l4.flags || []).indexOf('SYN') >= 0 ? ((first = false), { lose: true }) : null);
  const run = s1.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.0.20' });
  s1.runTo(s1.now + 8000);
  const t = run.tests[0];
  assert.equal(t.pktIds.length, 2, 'the SYN and its retransmission');
  const [p0, p1] = t.pktIds.map((id) => s1.packet(id));
  assert.ok(p0 && p1 && p0 !== p1);
  assert.equal(p0.hdr.l4.seq, p1.hdr.l4.seq, 'the same segment');
  assert.ok(p1.t > p0.t);
  // the other execution has no such record (its numbers would be its own)
  assert.equal(s2.packet(t.pktIds[1]), null);
  // an event no longer kept
  const seq = s1.events()[0].seq;
  assert.equal(s1.eventKept(seq), 'kept');
  s1.engine.log.splice(0, 3);
  assert.equal(s1.eventKept(seq), 'evicted');
  assert.equal(s1.eventKept(10 ** 9), 'unknown');
});
