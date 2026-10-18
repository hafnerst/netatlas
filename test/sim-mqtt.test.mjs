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
  s.play(3500);
  settle(s, 2000);
  const p = client(s, 'sensor', 'temp');
  const hmi = client(s, 'hmi', 'view');
  const hum = client(s, 'logger', 'hum');
  const all = client(s, 'logger', 'all');
  assert.equal(p.published, 4, 'one at once, then one a second');
  assert.equal(p.pubacked, 4, 'QoS 1: each PUBACKed by the broker');
  assert.equal(hmi.received.get('sensors/room1/temperature'), 4);
  assert.equal(all.received.get('sensors/room1/temperature'), 4, '# matches too');
  assert.equal(hum.received.size, 0, 'the humidity filter does not match: nothing reaches it');
  // the subscriber acknowledges its QoS 1 deliveries; the QoS 0 subscriber (all) gets QoS 0
  const b = s.mqtt.brokers.get('broker');
  assert.equal(b.received, 4);
  assert.equal(b.delivered, 8);
  const hmiSess = b.sessions.get('hmi-view');
  assert.equal(hmiSess.acked, 4);
  assert.equal(b.sessions.get('logger-all').subs.get('sensors/#'), 0);
  // broker-mediated: every publication goes to the broker, never straight to a subscriber; no IGMP membership
  const pubs = s.events().filter((e) => e.what === 'MQTT PUBLISH' && e.device === 'sensor');
  assert.ok(pubs.length >= 4);
  assert.ok(s.events().some((e) => /the publication of sensor-temp to sensors\/room1\/temperature goes to hmi-view \(QoS 1\), logger-all \(QoS 0\)/.test(e.detail)));
  assert.equal(s.multicast.joined('hmi').length, 0, 'a subscription is no IGMP membership');
  assert.match(view(s, pub.id).summary, /^connected · 4 published \(4 acknowledged\)$/);
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
  assert.ok(s.status().some((x) => x.name === 'hmi/poll → plc/registers tcp/502' && x.state === 'Answered'));
});
