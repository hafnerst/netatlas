// MQTT 3.1.1 in the simulation (analysis/sim/mqtt.ts): broker-mediated publish / subscribe over TCP.
// Connection and subscription lifecycle, exact and wildcard filters, delivery only through the broker
// and only to matching subscribers, QoS 0 and QoS 1 (PUBACK, DUP retries), a second client with the
// same identifier, keep alive and reconnection, unsubscribe and disconnect, network failures and policy,
// counts; no IGMP state. Injected clocks, no sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock, errorsOf, validate, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const NET = (clients, extra = '') => `netatlas: 1
devices:
  - id: sw
    type: switch
    igmp_mld_snooping: {1: enabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
  - id: broker
    type: server
    services:
      mqtt_broker: {}
    interfaces: [{id: eth0, ip: 10.0.0.5/24}]
  - id: sensor
    type: endpoint
    kind: iot
    services:
      applications:
${clients.sensor}
    interfaces: [{id: eth0, ip: 10.0.0.11/24}]
  - id: hmi
    type: endpoint
    kind: hmi
    services:
      applications:
${clients.hmi}
    interfaces: [{id: eth0, ip: 10.0.0.20/24}]
  - id: logger
    type: server
    services:
      applications:
${clients.logger}
    interfaces: [{id: eth0, ip: 10.0.0.30/24}]
${extra}links:
  - {id: l1, a: "sw:p1", b: "broker:eth0"}
  - {id: l2, a: "sw:p2", b: "sensor:eth0"}
  - {id: l3, a: "sw:p3", b: "hmi:eth0"}
  - {id: l4, a: "sw:p4", b: "logger:eth0"}
`;

const BASE = {
  sensor: '        - {id: temp, name: Room temperature, profile: mqtt_client, broker: broker, publish: [sensors/room1/temperature], interval: 1s, qos: "1"}',
  hmi: '        - {id: view, name: Temperatures, profile: mqtt_client, broker: broker, subscribe: [sensors/+/temperature], qos: "1"}',
  logger: '        - {id: hum, name: Humidity log, profile: mqtt_client, broker: broker, subscribe: [sensors/+/humidity]}\n        - {id: all, name: Everything, profile: mqtt_client, broker: broker, subscribe: ["sensors/#"]}',
};

const sim = (text = NET(BASE)) => withClock(new S.Simulation(model(text)));
const settle = (s, ms = 5000) => s.runTo(s.now + ms);
const client = (s, dev, app) => s.mqtt.clients.find((c) => c.run.dev === dev && c.run.app.id === app);
const view = (s, id) => s.actions().find((v) => v.id === id);

test('the format: a broker service on a host, clients with a broker reference, unique client identifiers, valid topics', () => {
  assert.deepEqual(errorsOf(NET(BASE)), []);
  const e = errorsOf(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: logger, subscribe: [a/#]}' }));
  assert.ok(e.some((x) => /"logger" runs no MQTT broker service/.test(x.message)));
  const dup = errorsOf(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, client_id: sensor-temp, subscribe: [a/#]}' }));
  assert.ok(dup.some((x) => /the client identifier "sensor-temp" is already used at the broker broker by sensor\/temp/.test(x.message)));
  const bad = errorsOf(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, subscribe: ["a/#/b"], publish: [a/+]}' }));
  assert.ok(bad.some((x) => /the topic filter "a\/#\/b" has # elsewhere/.test(x.message)));
  assert.ok(bad.some((x) => /the topic "a\/\+" has a wildcard/.test(x.message)));
  assert.ok(errorsOf(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker}' })).some((x) => /needs a topic to publish to or a topic filter/.test(x.message)));
  // an endpoint runs no broker (it is a host's service, not every endpoint's)
  const ep = errorsOf(NET(BASE).replace('    kind: iot\n    services:\n', '    kind: iot\n    services:\n      mqtt_broker: {}\n'));
  assert.ok(ep.some((x) => /"sensor" can't run MQTT broker/.test(x.message)));
});

test('nothing connects until a client is started; then CONNECT / CONNACK and SUBSCRIBE / SUBACK with the granted QoS', () => {
  const s = sim();
  settle(s, 10000);
  assert.equal(s.mqtt.clients.length, 0);
  assert.ok(!s.events().some((e) => e.protocol === 'mqtt' && /CONNECT/.test(e.what || '')));
  const a = s.actApp('hmi', 'view');
  assert.ok(!a.error, a.error);
  settle(s);
  const c = client(s, 'hmi', 'view');
  assert.equal(c.state, 'Connected');
  assert.deepEqual(Array.from(c.granted.entries()), [['sensors/+/temperature', 1]]);
  const types = s.events().filter((e) => e.protocol === 'mqtt').map((e) => e.what);
  assert.ok(types.includes('MQTT CONNECT') && types.includes('MQTT CONNACK') && types.includes('MQTT SUBSCRIBE') && types.includes('MQTT SUBACK'), types.join(', '));
  assert.match(view(s, a.id).summary, /^connected · 0 received$/);
  assert.match(s.mqttBrokerTable('broker').rows[0].join(' | '), /^hmi-view \| hmi\/view .* \| sensors\/\+\/temperature \(QoS 1\) \| 1 min/);
});

test('publish through the broker: exact and wildcard subscribers get it, a nonmatching one does not; QoS 1 acknowledged both ways', () => {
  const s = sim();
  settle(s, 3000);
  for (const [d, x] of [['hmi', 'view'], ['logger', 'hum'], ['logger', 'all']]) assert.ok(!s.actApp(d, x).error);
  settle(s, 3000);
  const pub = s.actApp('sensor', 'temp');
  // (5.5 s of simulated time: publications at 0, 1, 2, 3, 4 and 5 s — the simulated clock, as every repeating thing)
  s.play(3500);
  settle(s, 2000);
  const p = client(s, 'sensor', 'temp');
  const hmi = client(s, 'hmi', 'view');
  const hum = client(s, 'logger', 'hum');
  const all = client(s, 'logger', 'all');
  assert.equal(p.published, 6, 'one at once, then one a second');
  assert.equal(p.pubacked, 6, 'QoS 1: each PUBACKed by the broker');
  assert.equal(hmi.received.get('sensors/room1/temperature'), 6);
  assert.equal(all.received.get('sensors/room1/temperature'), 6, '# matches too');
  assert.equal(hum.received.size, 0, 'the humidity filter does not match: nothing reaches it');
  // the subscriber acknowledges its QoS 1 deliveries; the QoS 0 subscriber (all) gets QoS 0
  const b = s.mqtt.brokers.get('broker');
  assert.equal(b.received, 6);
  assert.equal(b.delivered, 12);
  const hmiSess = b.sessions.get('hmi-view');
  assert.equal(hmiSess.acked, 6);
  assert.equal(b.sessions.get('logger-all').subs.get('sensors/#'), 0);
  // broker-mediated: every publication goes to the broker, never straight to a subscriber; no IGMP membership
  const pubs = s.events().filter((e) => e.what === 'MQTT PUBLISH' && e.device === 'sensor');
  assert.ok(pubs.length >= 4);
  assert.ok(s.events().some((e) => /the publication of sensor-temp to sensors\/room1\/temperature goes to hmi-view \(QoS 1\), logger-all \(QoS 0\)/.test(e.detail)));
  assert.equal(s.multicast.joined('hmi').length, 0, 'a subscription is no IGMP membership');
  assert.match(view(s, pub.id).summary, /^connected · 6 published \(6 acknowledged\)$/);
});

test('QoS 1 without PUBACK: sent again with DUP after the retry interval, by the client and by the broker; lost with a connection that closes', () => {
  const text = NET({ ...BASE, sensor: '        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: [sensors/room1/temperature], interval: 3s, qos: "1", retry_interval: 2s}' }).replace('      mqtt_broker: {}', '      mqtt_broker: {retry_interval: 2s}');
  const s = sim(text);
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 2000);
  s.engine.withTest(null, () => {});
  const a = s.actApp('sensor', 'temp');
  const c = client(s, 'sensor', 'temp');
  for (let i = 0; i < 200 && !(c.published === 1 && c.pubacked === 1); i++) s.runTo(s.now + 10);
  assert.equal(c.pubacked, 1);
  // the subscriber's cable fails: the broker's next QoS 1 delivery gets no PUBACK, and goes again with DUP
  s.fail('link:l3');
  s.play(3200);
  settle(s, 3000);
  assert.ok(s.events().some((e) => /PUBLISH from the broker broker to hmi-view again: sensors\/room1\/temperature, QoS 1, packet \d+, DUP/.test(e.detail)), 'the broker retries');
  // the publisher's cable fails: its next publication gets no PUBACK, and goes again with DUP
  s.fail('link:l2');
  s.play(3200);
  settle(s, 3000);
  assert.ok(c.run.retried >= 1, 'at least one DUP from the client');
  assert.ok(s.events().some((e) => /PUBLISH from sensor-temp to sensors\/room1\/temperature again: QoS 1, packet \d+, DUP/.test(e.detail)));
  void a;
});

test('keep alive: a client whose broker is gone stops hearing PINGRESP, closes, and reconnects once the broker is back', () => {
  const s = sim(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, subscribe: [sensors/#], keepalive: 10s}' }));
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 3000);
  const c = client(s, 'hmi', 'view');
  assert.equal(c.state, 'Connected');
  settle(s, 25000);
  assert.ok(s.events().some((e) => e.what === 'MQTT PINGREQ') && s.events().some((e) => e.what === 'MQTT PINGRESP'), 'keep alive exchanged while idle');
  s.powerOff('broker');
  settle(s, 30000);
  assert.notEqual(c.state, 'Connected');
  assert.ok(s.events().some((e) => /no PINGRESP within 10 s: it closes the connection/.test(e.detail) || /connection (refused|reset)|timed out|its connection is gone/.test(e.detail)));
  s.powerOn('broker');
  settle(s, 120000);
  assert.equal(c.state, 'Connected', 'reconnected');
  assert.ok(c.connects >= 2);
  assert.deepEqual(Array.from(c.granted.keys()), ['sensors/#'], 'subscribed again (a clean session)');
});

test('the broker drops a client it hears nothing from for 1.5 × its keep alive', () => {
  const s = sim(NET({ ...BASE, hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, subscribe: [sensors/#], keepalive: 10s}' }));
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 3000);
  // the client's cable fails: nothing from it any more
  s.fail('link:l3');
  settle(s, 20000);
  assert.ok(s.events().some((e) => /nothing from hmi-view for 15 s \(1\.5 × its keep alive\)/.test(e.detail)));
  assert.equal(s.mqtt.brokers.get('broker').sessions.has('hmi-view'), false);
});

test('a second client with the same identifier takes the session over; the first is disconnected (MQTT 3.1.1 §3.1.4)', () => {
  // (validation reports the duplicate identifier; the broker's behaviour when it comes twice all the same)
  const text = NET({ ...BASE, logger: '        - {id: hum, name: H, profile: mqtt_client, broker: broker, client_id: shared, subscribe: [a/#]}', hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, client_id: shared, subscribe: [b/#]}' });
  const r = validate.loadModel(text);
  assert.ok(r.errors.some((e) => /the client identifier "shared" is already used/.test(e.message)));
  const s = withClock(new S.Simulation(r.model));
  settle(s, 3000);
  s.actApp('logger', 'hum');
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 3000);
  const b = s.mqtt.brokers.get('broker');
  assert.equal(b.takeovers, 1);
  assert.equal(b.sessions.get('shared').dev, 'hmi', 'the newer connection holds the session');
  assert.ok(s.events().some((e) => /a new CONNECT with the client identifier shared .* it closes the existing connection of logger\/hum/.test(e.detail)));
  assert.notEqual(client(s, 'logger', 'hum').state, 'Connected', 'the first is disconnected (and reconnects: the two take turns, as real clients with one identifier do)');
});

test('Stop: UNSUBSCRIBE / UNSUBACK, DISCONNECT, and the broker ends the session; nothing more is received', () => {
  const s = sim();
  settle(s, 3000);
  const a = s.actApp('hmi', 'view');
  s.actApp('sensor', 'temp');
  s.play(2000);
  settle(s, 1000);
  assert.equal(s.actionControl(a.id, 'stop'), true);
  settle(s, 5000);
  const types = s.events().filter((e) => e.device === 'hmi' && e.protocol === 'mqtt').map((e) => e.what);
  assert.ok(types.includes('MQTT UNSUBSCRIBE') && types.includes('MQTT DISCONNECT'), types.join(', '));
  assert.equal(s.mqtt.brokers.get('broker').sessions.has('hmi-view'), false);
  const n = client(s, 'hmi', 'view').received.get('sensors/room1/temperature') || 0;
  s.play(3000);
  settle(s, 2000);
  assert.equal(client(s, 'hmi', 'view').received.get('sensors/room1/temperature') || 0, n, 'nothing after Stop');
  assert.equal(view(s, a.id).status, 'stopped');
});

test('a publisher with a count disconnects once its publications are acknowledged; a firewall that drops TCP 1883 keeps it unconnected', () => {
  const s = sim(NET({ ...BASE, sensor: '        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: [sensors/room1/temperature], interval: 1s, count: 2, qos: "1"}' }));
  settle(s, 3000);
  const a = s.actApp('sensor', 'temp');
  s.play(2500);
  settle(s, 5000);
  const c = client(s, 'sensor', 'temp');
  assert.equal(c.published, 2);
  assert.equal(c.pubacked, 2);
  assert.equal(c.state, 'Stopped');
  assert.equal(view(s, a.id).status, 'completed');
  // policy: a routed firewall between the client and the broker without a rule for MQTT drops the SYN
  const fw = `netatlas: 1
devices:
  - id: fw
    type: firewall
    simulation: {default_action: drop}
    interfaces: [{id: in, ip: 10.1.0.1/24}, {id: out, ip: 10.2.0.1/24}]
  - id: broker
    type: server
    services: {mqtt_broker: {}}
    interfaces: [{id: eth0, ip: 10.2.0.5/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
  - id: sensor
    type: endpoint
    services:
      applications:
        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: [a/b]}
    interfaces: [{id: eth0, ip: 10.1.0.11/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
links:
  - {id: l1, a: "fw:out", b: "broker:eth0"}
  - {id: l2, a: "fw:in", b: "sensor:eth0"}
`;
  const f = withClock(new S.Simulation(model(fw)));
  f.runTo(5000);
  f.actApp('sensor', 'temp');
  f.runTo(f.now + 20000);
  const fc = f.mqtt.clients[0];
  assert.notEqual(fc.state, 'Connected');
  assert.ok(f.events().some((e) => e.kind === 'drop' && e.device === 'fw'), 'dropped by the firewall’s policy');
});

test('ot-network.yaml: the PLC publishes telemetry; the HMI subscribed to the temperatures gets them, the alarm log nothing; the HMI polls the PLC', () => {
  const s = withClock(new S.Simulation(model(example('ot-network.yaml'))));
  s.runTo(5000);
  for (const [d, a] of [['plc', 'telemetry'], ['hmi', 'dashboard'], ['eng-ws', 'alarms'], ['hmi', 'poll']]) s.actApp(d, a);
  s.play(20000);
  const hmi = s.mqttClientTable('hmi').rows[0];
  assert.match(hmi[5], /^plant\/cell1\/plc-1\/temperature: \d+$/, 'only the temperature reaches the dashboard');
  assert.equal(s.mqttClientTable('eng-ws').rows[0][5], '—', 'nothing matches plant/cell1/+/alarm');
  // the HMI's polls of the PLC are answered (the newest may be on its way when the clock stops)
  assert.ok(s.actions().some((a) => /poll/.test(a.target) && /^(\d+) answered/.test(a.summary) && Number(/^(\d+)/.exec(a.summary)[1]) >= 5), JSON.stringify(s.actions().map((a) => a.summary)));
});

// ------------------------------------------------------------------ a periodic publisher across reconnections

const REC = {
  sensor: '        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: [s/t], interval: 1s, qos: "1", keepalive: 10s}',
  hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, subscribe: [s/#], qos: "1", keepalive: 10s}',
  logger: '        - {id: hum, name: H, profile: mqtt_client, broker: broker, subscribe: [x/#]}',
};
const got = (c) => c.received.get('s/t') || 0;
// both connected again (the subscriber subscribed: SUBACK), within a limit — after the publisher's new connection
// (connects: more than c0) when given: its old connection may look Connected until it notices it is gone
const untilBoth = (s, p, h, c0 = 0, ms = 180000) => {
  const end = s.now + ms;
  while (s.now < end && p.connects <= c0) s.runTo(s.now + 100);
  assert.ok(p.connects > c0, `a new connection (${p.connects})`);
  while (s.now < end && !(p.state === 'Connected' && h.state === 'Connected' && h.granted.get('s/#') === 1)) s.runTo(s.now + 100);
  assert.ok(p.state === 'Connected' && h.state === 'Connected', `connected again (${p.state}, ${h.state})`);
};
// publications and receipts over 10 s of a recovered pair: the run's cadence (one a second), nothing duplicated
const cadence = (s, p, h, what) => {
  s.runTo(s.now + 1500);
  const p0 = p.published;
  const r0 = got(h);
  s.runTo(s.now + 10000);
  assert.equal(p.published - p0, 10, `${what}: one publication a second after the reconnection — one schedule, not none, not two`);
  assert.equal(got(h) - r0, 10, `${what}: the subscriber receives each`);
};
const pair = (text = NET(REC)) => {
  const s = sim(text);
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 2000);
  s.actApp('sensor', 'temp');
  settle(s, 5000);
  const p = client(s, 'sensor', 'temp');
  const h = client(s, 'hmi', 'view');
  assert.ok(p.published >= 5 && got(h) >= 5, 'publishing before the interruption');
  return { s, p, h };
};

test('a periodic publisher goes on publishing after its connection recovers — the broker restarted, the publisher’s cable failed and restored, the publisher power-cycled: its publications reach the subscriber again, one a second (MQTT 3.1.1 §3.1: a new connection; the run’s schedule is its own)', () => {
  for (const kind of ['broker restart', 'cable', 'power cycle']) {
    const { s, p, h } = pair();
    const c0 = p.connects;
    if (kind === 'broker restart') {
      s.powerOff('broker');
      settle(s, 30000);
      s.powerOn('broker');
    } else if (kind === 'cable') {
      s.fail('link:l2');
      settle(s, 40000);
      s.restore('link:l2');
    } else {
      s.powerOff('sensor');
      settle(s, 5000);
      s.powerOn('sensor');
    }
    untilBoth(s, p, h, c0);
    cadence(s, p, h, kind);
    assert.equal(s.mqtt.brokers.get('broker').sessions.get('sensor-temp').inflight.size, 0);
  }
});

test('repeated reconnections: the publisher power-cycled three times — after each it publishes again at its cadence, never with a second schedule; the rounds it was not connected for are said and not published', () => {
  const { s, p, h } = pair();
  for (let k = 1; k <= 3; k++) {
    const c0 = p.connects;
    s.powerOff('sensor');
    settle(s, 4000);
    s.powerOn('sensor');
    untilBoth(s, p, h, c0);
    cadence(s, p, h, `cycle ${k}`);
  }
  assert.equal(p.connects, 4, 'one connection per boot');
  assert.ok(p.missed >= 3, `${p.missed} rounds not published while disconnected`);
  assert.ok(s.events().some((e) => /sensor-temp .*: not connected at its publication time — the round is not published/.test(e.detail)));
});

test('a reconnection before the first publication: the publisher started with its cable down publishes its first round once connected, then at its cadence', () => {
  const s = sim(NET(REC));
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 2000);
  s.fail('link:l2');
  s.actApp('sensor', 'temp');
  settle(s, 20000);
  const p = client(s, 'sensor', 'temp');
  const h = client(s, 'hmi', 'view');
  assert.equal(p.published, 0, 'nothing published unconnected');
  assert.ok(p.connects >= 3, `it tries again every 5 s (${p.connects} attempts): a connection that failed at once is not left Connecting`);
  assert.ok(s.events().some((e) => /sensor-temp .*: could not connect \(connection failed: no route to 10\.0\.0\.5/.test(e.detail)));
  s.restore('link:l2');
  untilBoth(s, p, h, p.connects);
  s.runTo(s.now + 500);
  assert.ok(p.published >= 1 && got(h) >= 1, 'the first round once connected');
  cadence(s, p, h, 'first connection late');
});

test('interrupted near the end of a finite count: count 5, the publisher power-cycled after its 4th — the 5th is published and received after the reconnection and the run completes; the last round lost with its connection ends the run on reconnection, the loss counted', () => {
  const FIN = { ...REC, sensor: '        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: [s/t], interval: 1s, count: 5, qos: "1", keepalive: 10s}' };
  const s = sim(NET(FIN));
  settle(s, 3000);
  const hv = s.actApp('hmi', 'view');
  settle(s, 2000);
  const a = s.actApp('sensor', 'temp');
  const p = client(s, 'sensor', 'temp');
  const h = client(s, 'hmi', 'view');
  for (let i = 0; i < 1000 && !(p.published === 4 && p.pubacked === 4); i++) s.runTo(s.now + 10);
  assert.equal(p.published, 4);
  s.powerOff('sensor');
  settle(s, 3000);
  s.powerOn('sensor');
  // (its boot: 30 s; it connects after its reconnect delay)
  for (let i = 0; i < 1200 && p.state !== 'Stopped'; i++) s.runTo(s.now + 100);
  settle(s, 5000);
  assert.equal(p.published, 5, 'the 5th after the reconnection, no more');
  assert.equal(p.pubacked, 5);
  assert.equal(got(h), 5, 'the subscriber has all five');
  assert.equal(p.state, 'Stopped');
  assert.equal(view(s, a.id).status, 'completed');
  void hv;
  // the last round published, its PUBACK lost with the connection (the cable fails at once): on reconnection the run ends
  const t = sim(NET(FIN));
  settle(t, 3000);
  t.actApp('hmi', 'view');
  settle(t, 2000);
  const b = t.actApp('sensor', 'temp');
  const q = client(t, 'sensor', 'temp');
  for (let i = 0; i < 10000 && !(q.published === 4 && q.pubacked === 4); i++) t.runTo(t.now + 1);
  // (the broker's PUBACK of the 5th lost, each time TCP sends it again, until the cable fails)
  t.engine.impair = (link, f) => (f.msg && f.msg.type === 'MQTT PUBACK' && link === 'l2' ? { lose: true } : null);
  for (let i = 0; i < 10000 && q.published < 5; i++) t.runTo(t.now + 1);
  assert.equal(q.published, 5);
  settle(t, 500);
  assert.equal(q.pubacked, 4, 'the 5th unacknowledged');
  t.fail('link:l2');
  t.engine.impair = null;
  settle(t, 60000);
  assert.notEqual(q.state, 'Stopped', 'unacknowledged: not done yet');
  t.restore('link:l2');
  for (let i = 0; i < 1800 && q.state !== 'Stopped'; i++) t.runTo(t.now + 100);
  settle(t, 5000);
  assert.equal(q.published, 5, 'nothing published again (a clean session: the lost one is lost)');
  assert.equal(q.state, 'Stopped', 'the run ends once connected again');
  assert.equal(view(t, b.id).status, 'completed');
  assert.ok(q.lost + q.pubacked >= 5, `lost ${q.lost}, acknowledged ${q.pubacked}`);
});

// ------------------------------------------------------------------ packet identifiers

const pidsOf = (s, re) => {
  const seen = new Set();
  return s.events().filter((e) => {
    if (e.what !== 'MQTT PUBLISH' || !re.test(e.detail) || /DUP/.test(e.detail)) return false;
    // (a TCP retransmission repeats a segment — its sequence number — and is no new PUBLISH)
    const k = /TCP (\S+ → \S+) \S+ seq (\d+)/.exec(e.detail);
    const key = k ? k[1] + '|' + k[2] : String(e.seq);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((e) => Number(/packet (\d+)/.exec(e.detail)[1]));
};

test('packet identifiers are 16 bits and never 0 (MQTT 3.1.1 §2.3.1): the client’s QoS 1 publications wrap from 65535 to 1, each PUBACK completes its own; the broker’s deliveries count in their own space', () => {
  const { s, p, h } = pair();
  p.nextPid = 65534;
  const p0 = p.pubacked;
  settle(s, 4000);
  const ids = pidsOf(s, /^MQTT PUBLISH from sensor-temp to s\/t/);
  const i = ids.indexOf(65534);
  assert.ok(i >= 0, ids.join(','));
  assert.deepEqual(ids.slice(i, i + 4), [65534, 65535, 1, 2]);
  assert.ok(ids.every((x) => x >= 1 && x <= 65535));
  assert.equal(p.inflight.size, 0, 'every one acknowledged');
  assert.equal(p.pubacked, p.published, 'each acknowledged: every PUBACK matched its own publication');
  assert.ok(p.pubacked > p0);
  // the broker's own identifiers towards the subscriber are its own space (not the publisher's)
  const sess = s.mqtt.brokers.get('broker').sessions.get('hmi-view');
  sess.nextPid = 65535;
  settle(s, 2000);
  const bids = pidsOf(s, /^MQTT PUBLISH from the broker broker to hmi-view/);
  const j = bids.indexOf(65535);
  assert.deepEqual(bids.slice(j, j + 2), [65535, 1]);
  assert.equal(sess.inflight.size, 0);
  assert.equal(sess.acked, sess.delivered);
  void h;
});

test('an identifier still in flight is skipped: the broker’s QoS 1 delivery 1 unacknowledged (the subscriber’s cable down), the next ones after the wrap go as 65535, 2 — each PUBACK completes its own delivery, none is taken for another', () => {
  const s = sim(NET(REC));
  settle(s, 3000);
  s.actApp('hmi', 'view');
  settle(s, 2000);
  const sess = s.mqtt.brokers.get('broker').sessions.get('hmi-view');
  const h = client(s, 'hmi', 'view');
  s.fail('link:l3');
  s.actApp('sensor', 'temp');
  for (let i = 0; i < 2000 && !sess.inflight.has(1); i++) s.runTo(s.now + 5);
  assert.ok(sess.inflight.has(1), 'delivery 1 waits for its PUBACK');
  sess.nextPid = 65535;
  settle(s, 3100);
  const bids = pidsOf(s, /^MQTT PUBLISH from the broker broker to hmi-view/);
  assert.deepEqual(bids.slice(0, 4), [1, 65535, 2, 3], 'packet 1 skipped while in flight');
  s.restore('link:l3');
  settle(s, 30000);
  assert.equal(sess.inflight.size, 0, 'each acknowledged');
  assert.equal(sess.acked, sess.delivered);
  assert.ok(got(h) >= sess.delivered, 'the subscriber has each (DUPs may come twice at QoS 1)');
});

test('SUBSCRIBE / UNSUBSCRIBE identifiers: a SUBACK or UNSUBACK of another identifier completes nothing; Stop’s UNSUBSCRIBE takes 65535 and its UNSUBACK ends the run; a clean-session reconnection starts identifiers over with nothing in flight; all 65535 in flight — the next publication is not sent, said', () => {
  const s = sim(NET(REC));
  settle(s, 3000);
  const a = s.actApp('hmi', 'view');
  settle(s, 2000);
  const h = client(s, 'hmi', 'view');
  assert.equal(h.subPid, null, 'its SUBACK came');
  // (a SUBACK it is not waiting for: ignored — the state machine directly)
  h.granted.clear();
  s.mqtt.clientIn(h, h.sock, { type: 'MQTT SUBACK', data: { pid: 4711, codes: [1] } });
  assert.equal(h.granted.size, 0, 'a SUBACK of another identifier is not taken');
  h.nextPid = 65535;
  assert.equal(s.actionControl(a.id, 'stop'), true);
  settle(s, 5000);
  assert.ok(s.events().some((e) => /MQTT UNSUBSCRIBE \(packet 65535\) from hmi-view/.test(e.detail)));
  assert.ok(s.events().some((e) => /MQTT UNSUBACK \(packet 65535\)/.test(e.detail)));
  assert.equal(h.state, 'Stopped');
  // clean session: the publisher reconnected starts at 1 again, nothing of the last connection in flight
  const { s: t, p } = pair();
  p.nextPid = 40000;
  settle(t, 2000);
  const c0 = p.connects;
  t.powerOff('sensor');
  settle(t, 3000);
  t.powerOn('sensor');
  for (let i = 0; i < 1200 && !(p.connects > c0 && p.state === 'Connected'); i++) t.runTo(t.now + 100);
  settle(t, 3000);
  assert.equal(p.state, 'Connected');
  const ids = pidsOf(t, /^MQTT PUBLISH from sensor-temp to s\/t/);
  assert.ok(ids.lastIndexOf(1) > ids.indexOf(40000), 'identifiers start over with the new session');
  assert.equal(p.inflight.size <= 1, true);
  // exhaustion: every identifier waits for PUBACK — nothing is sent with an identifier in use
  for (let k = 1; k <= 65535; k++) p.inflight.set(k, { topic: 's/t', bytes: 0, tries: 0, gen: p.gen });
  const n = p.published;
  settle(t, 1500);
  assert.equal(p.published, n, 'not published');
  assert.ok(t.events().some((e) => /no packet identifier free \(all 65535 wait for PUBACK\): the publication to s\/t is not sent/.test(e.detail)));
});

// ------------------------------------------------------------------ string sizes in UTF-8

const M = load('analysis/sim/mqtt.js');
const segBytes = (s, re) => s.events().filter((e) => re.test(e.detail)).map((e) => Number(/, (\d+) bytes$/.exec(e.detail)[1]));

test('MQTT strings are counted in UTF-8 bytes (3.1.1 §1.5.3): ASCII 1, é 2, € 3, 😀 4 — CONNECT, SUBSCRIBE and PUBLISH sizes of a client identifier, topic filter and topic with them; the remaining length takes a second byte at 128', () => {
  assert.equal(M.utf8Bytes('abc'), 3);
  assert.equal(M.utf8Bytes('é'), 2);
  assert.equal(M.utf8Bytes('€'), 3);
  assert.equal(M.utf8Bytes('😀'), 4);
  assert.equal(M.utf8Bytes('a/é/€/😀'), 1 + 1 + 2 + 1 + 3 + 1 + 4);
  // (client identifiers are letters, digits, '_', '.' and '-' by the format's validation — ASCII: one byte each, as before)
  // topic 'häus/€/😀' = 14 bytes in UTF-8 (9 UTF-16 code units: the emoji is a surrogate pair)
  const U = {
    sensor: '        - {id: temp, name: T, profile: mqtt_client, broker: broker, client_id: zaehler-1, publish: ["häus/€/😀"], qos: "1", payload_size: 98}',
    hmi: '        - {id: view, name: V, profile: mqtt_client, broker: broker, subscribe: ["häus/+/😀"], qos: "1"}',
    logger: REC.logger,
  };
  const s = sim(NET(U));
  settle(s, 3000);
  s.actApp('hmi', 'view');
  s.actApp('sensor', 'temp');
  settle(s, 4000);
  // CONNECT: 10 + (2 + 9) = 21 remaining → 23
  assert.deepEqual(segBytes(s, /^MQTT CONNECT from zaehler-1/), [23]);
  // SUBSCRIBE: packet id 2 + filter 'häus/+/😀' (2 + 12) + QoS 1 = 17 remaining → 19 (code units would have said 17)
  assert.deepEqual(segBytes(s, /^MQTT SUBSCRIBE \(packet 1\) from hmi-view/), [19]);
  // PUBLISH: topic (2 + 14) + packet id 2 + payload 98 = 116 remaining → 118 (in UTF-16 code units: 111 → 113)
  assert.deepEqual(segBytes(s, /^MQTT PUBLISH from zaehler-1 to häus\/€\/😀: QoS 1/).slice(0, 1), [118]);
  assert.equal(client(s, 'hmi', 'view').received.get('häus/€/😀'), 1, 'delivered: the filter matches by its characters');
  // the remaining length's second byte: payload 110 → 128 remaining → 1 + 2 + 128 = 131 (in code units 123: one byte, 125)
  const V = { ...U, sensor: U.sensor.replace('payload_size: 98', 'payload_size: 110') };
  const v = sim(NET(V));
  settle(v, 3000);
  v.actApp('sensor', 'temp');
  settle(v, 3000);
  assert.deepEqual(segBytes(v, /^MQTT PUBLISH from zaehler-1 to häus\/€\/😀: QoS 1/).slice(0, 1), [131]);
});

test('a PUBLISH whose UTF-8 size passes the MSS goes in two TCP segments where its UTF-16 length would have fit one: 1460 bytes of TCP payload at most (MTU 1500)', () => {
  // topic of 100 '€' = 300 bytes (100 code units); QoS 0: remaining = 302 + payload; packet = 1 + 2 + remaining
  const topic = '€'.repeat(100);
  // UTF-8: 1 + 2 + 302 + 1160 = 1465 > 1460 → two segments; in code units 1 + 2 + 102 + 1160 = 1265 would have fit one
  const W = {
    sensor: `        - {id: temp, name: T, profile: mqtt_client, broker: broker, publish: ["${topic}"], payload_size: 1160}`,
    hmi: REC.hmi,
    logger: REC.logger,
  };
  const s = sim(NET(W));
  settle(s, 3000);
  s.actApp('sensor', 'temp');
  settle(s, 3000);
  // (the PUBLISH's segments: "… ack N, 1460 bytes … (segment 1 of 2)")
  const segs = s.events().filter((e) => e.device === 'sensor' && e.kind === 'message' && /→ 10\.0\.0\.5:1883 .*\(segment \d+ of \d+\)$/.test(e.detail)).map((e) => Number(/ack \d+, (\d+) bytes/.exec(e.detail)[1]));
  assert.equal(segs.length, 2, `segments: ${segs.join(', ')}`);
  assert.equal(segs.reduce((x, y) => x + y, 0), 1465, segs.join(' + '));
  assert.ok(segs.every((x) => x <= 1460));
});
