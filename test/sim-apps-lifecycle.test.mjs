// Applications across the device lifecycle and their runs' bookkeeping
// (analysis/sim/apps.ts): what starts with the simulation starts when its
// device is operational (not one try 3 s after the start), once; the
// runs' history drops finished runs only, never one still going on; a
// run's outcomes are one per original message whatever its retries; Stop
// works while the last message is still on its way, and no retry follows
// it. Full simulations, injected clocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const EX = load('analysis/sim/experiment.js');
const A = load('analysis/sim/apps.js');

/** srv: a TCP server, a UDP receiver, a UDP server answering late, an MQTT broker; cl: the clients (its applications as given); hmi: an MQTT subscriber */
const LAB = (clApps, o = {}) => `netatlas: 1
devices:
  - id: sw
    type: switch
    igmp_mld_snooping: {1: disabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]
  - id: srv
    type: server
    services:
      mqtt_broker: {}
      applications:
        - {id: regs, name: Registers, profile: tcp_server, port: 502}
        - {id: alarms, name: Alarm sink, profile: udp_receiver, port: 5000}
        - {id: slow, name: Slow answer, profile: udp_server, port: 7000, response_delay: 3s}
    interfaces: [{id: eth0, ip: 10.0.0.10/24}]
  - id: cl
    type: endpoint
    simulation: {boot_time: ${o.boot || '30s'}}
    services:
      applications:
${clApps}
    interfaces: [{id: eth0${o.dhcp ? ', ipv4: dhcp' : ', ip: 10.0.0.20/24'}}]
  - id: hmi
    type: endpoint
    services:
      applications:
        - {id: view, name: View, profile: mqtt_client, broker: srv, subscribe: [plant/#], qos: "1", start: simulation_start}
    interfaces: [{id: eth0, ip: 10.0.0.30/24}]
links:
  - {id: l1, a: "sw:p1", b: "srv:eth0"}
  - {id: l2, a: "sw:p2", b: "cl:eth0"}
  - {id: l3, a: "sw:p3", b: "hmi:eth0"}
`;

const POLL = '        - {id: poll, name: Polling, profile: tcp_client, peer: srv/regs, interval: 2s, count: 3, start: simulation_start}';
const ALARM = '        - {id: alarm, name: Alarms, profile: udp_sender, peer: srv/alarms, interval: 1s, count: 2, start: simulation_start}';
const TEMP = '        - {id: temp, name: Temperature, profile: mqtt_client, broker: srv, publish: [plant/temp], interval: 1s, count: 5, qos: "1", start: simulation_start}';
const CONFIGURED = [POLL, ALARM, TEMP].join('\n');

const sim = (text) => withClock(new S.Simulation(model(text)));
const runsOf = (s, dev, id) => s.apps.runs.filter((r) => r.dev === dev && r.app.id === id);
const notes = (s, re) => s.events().filter((e) => re.test(e.detail));
const mqttOf = (s, dev, id) => s.mqtt.clients.find((c) => c.run.dev === dev && c.run.app.id === id);

// ------------------------------------------------------------------ R3: started when the device is operational

test('R3: cl powered on at 1 s and booting for 30 s — its TCP client, UDP sender and MQTT client start once it is up (not refused at 3 s for good): each once, their messages answered, received, delivered to the subscriber; waiting said and shown meanwhile', () => {
  const s = sim(LAB(CONFIGURED));
  s.runTo(1000);
  assert.ok(s.powerOff('cl'));
  assert.ok(s.powerOn('cl'));
  s.runTo(10000);
  // at 3 s: not operational — waiting, not refused
  for (const id of ['poll', 'alarm', 'temp']) assert.equal(runsOf(s, 'cl', id).length, 0, `${id}: not started while cl boots`);
  assert.equal(notes(s, /does not start with the simulation/).length, 0, 'nothing refused');
  assert.equal(notes(s, /cl\/poll \(Polling\) starts with the simulation once cl is operational: cl is booting \(up at t = 31(\.0)? s\)/).length, 1, 'the wait said once');
  const waiting = s.status().filter((x) => x.device === 'cl' && x.state === 'Waiting').map((x) => x.name).sort();
  assert.deepEqual(waiting, ['cl/alarm: Alarms', 'cl/poll: Polling', 'cl/temp: Temperature']);
  s.runTo(60000);
  const poll = runsOf(s, 'cl', 'poll');
  const alarm = runsOf(s, 'cl', 'alarm');
  assert.equal(poll.length, 1, 'the TCP client started once');
  assert.equal(alarm.length, 1, 'the UDP sender started once');
  assert.ok(poll[0].t0 >= 31000 + 3000 && poll[0].t0 < 31000 + 4000, `3 s after the boot (${poll[0].t0} ms)`);
  assert.equal(A.appOutcome(poll[0]).ok, 3, A.appSummaryText(poll[0]));
  assert.equal(A.appOutcome(alarm[0]).ok, 2, A.appSummaryText(alarm[0]));
  // the MQTT client: one session, its publications delivered to the subscriber that waited for nothing
  assert.equal(runsOf(s, 'cl', 'temp').length, 1, 'the MQTT client started once');
  const temp = mqttOf(s, 'cl', 'temp');
  assert.equal(temp.connects, 1, 'one connection');
  assert.equal(temp.published, 5, 'its five publications');
  assert.equal(mqttOf(s, 'hmi', 'view').received.get('plant/temp'), 5, 'every publication received');
  assert.ok(!s.status().some((x) => x.state === 'Waiting'), 'no longer waiting');
});

test('R3: repeated readiness — cl up at 5 s, power-cycled at 6 s (up again at 8 s), and readiness notified twice more: each application still starts once, after the last notification', () => {
  const s = sim(LAB(CONFIGURED, { boot: '4s' }));
  s.runTo(1000);
  s.powerOff('cl');
  s.powerOn('cl');
  // booting at 3 s: waiting; up at 5 s → an attempt due at about 8 s; power-cycled at 6 s, up again at 8 s → that attempt is void
  s.runTo(6000);
  s.powerOff('cl');
  s.powerOn('cl');
  s.runTo(8500);
  assert.equal(runsOf(s, 'cl', 'poll').length, 0, 'not started by the attempt of the earlier boot');
  // two more notifications that it is up (as a hook sees them): only the latest attempt counts
  for (let k = 0; k < 2; k++) for (const h of s.protocols.deviceHooks) h('cl', true);
  s.runTo(40000);
  for (const id of ['poll', 'alarm', 'temp']) assert.equal(runsOf(s, 'cl', id).length, 1, `${id}: started once`);
  assert.ok(runsOf(s, 'cl', 'poll')[0].t0 >= 8500 + 3000, `after the last notification (${runsOf(s, 'cl', 'poll')[0].t0} ms)`);
  assert.equal(A.appOutcome(runsOf(s, 'cl', 'poll')[0]).ok, 3);
  assert.equal(notes(s, /does not start with the simulation/).length, 0);
});

test('R3: a device never operational before the end — no run, the wait said and shown as Waiting (not "not started"); powered on at last, it starts then', () => {
  const s = sim(LAB(ALARM));
  s.runTo(1000);
  s.powerOff('cl');
  s.runTo(60000);
  assert.equal(runsOf(s, 'cl', 'alarm').length, 0);
  assert.equal(notes(s, /cl\/alarm \(Alarms\) starts with the simulation once cl is operational: cl is powered off/).length, 1);
  assert.equal(notes(s, /does not start with the simulation/).length, 0);
  const row = s.status().find((x) => x.name === 'cl/alarm: Alarms');
  assert.equal(row.state, 'Waiting');
  assert.equal(row.up, false);
  s.powerOn('cl');
  s.runTo(120000);
  assert.equal(runsOf(s, 'cl', 'alarm').length, 1);
  assert.equal(A.appOutcome(runsOf(s, 'cl', 'alarm')[0]).ok, 2);
});

test('R3: a run going on is not doubled by a reboot (its messages skipped while off, then sent again); a configuration error is refused once, said, and not tried again after a boot', () => {
  const s = sim(LAB('        - {id: beat, name: Heartbeat, profile: udp_sender, peer: srv/alarms, interval: 1s, start: simulation_start}\n        - {id: bad, name: Nowhere, profile: udp_sender, peer: srv/alarms, ip_version: "6", interval: 1s, start: simulation_start}', { boot: '2s' }));
  s.runTo(8000);
  assert.equal(runsOf(s, 'cl', 'beat').length, 1);
  s.powerOff('cl');
  s.powerOn('cl');
  s.runTo(30000);
  const beat = runsOf(s, 'cl', 'beat');
  assert.equal(beat.length, 1, 'the same run, not a second one after the boot');
  assert.ok(beat[0].tests.some((t) => t.started > 12000 && t.ok), 'sent again after the boot');
  assert.equal(runsOf(s, 'cl', 'bad').length, 0);
  assert.equal(notes(s, /cl\/bad \(Nowhere\) does not start with the simulation: srv\/alarms: srv has no IPv6 address/).length, 1, 'refused once, said');
  assert.ok(!s.status().some((x) => x.name.startsWith('cl/bad')), 'not shown as waiting');
});

test('R3: an experiment’s cold start (every device booting from off, cl for 30 s): the applications that start with the simulation start once cl is operational; an explicit start_app still waits for its device, said', () => {
  const text = LAB(CONFIGURED + '\n        - {id: once, name: Once, profile: tcp_client, peer: srv/regs}') + `experiments:
  - id: cold
    name: Cold
    duration: 90s
    start: cold
    actions:
      - {id: go, at: 0s, do: start_app, target: cl/once}
    observe:
      - {id: up, at: 0s, within: 60s, of: device, target: cl, expect: operational}
`;
  const m = model(text);
  const runner = new EX.ExperimentRunner(m, m.experiments[0], 'fp');
  const r = runner.runAll();
  const s = runner.sim;
  for (const id of ['poll', 'alarm', 'temp']) assert.equal(runsOf(s, 'cl', id).length, 1, `${id}: started once`);
  assert.equal(A.appOutcome(runsOf(s, 'cl', 'poll')[0]).ok, 3);
  assert.equal(A.appOutcome(runsOf(s, 'cl', 'alarm')[0]).ok, 2);
  assert.ok(mqttOf(s, 'hmi', 'view').received.get('plant/temp') >= 1, 'publications delivered after the cold start');
  assert.equal(notes(s, /does not start with the simulation/).length, 0);
  const go = r.actions.find((a) => a.index === 0);
  assert.equal(go.state, 'submitted');
  assert.match(go.text, /after waiting \d+ s for cl to come up/);
});

const VMNET = `netatlas: 1
devices:
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: [10, 99]}, {id: p2, vlans: 10}]}
  - id: h1
    type: server
    simulation: {boot_time: 20s}
    services: {hypervisor: {platform: kvm, vswitches: [{name: br0, type: linux_bridge, uplinks: [eth0], teaming: active_standby, port_groups: [{name: lan, vlans: 10}]}]}}
    interfaces: [eth0]
  - id: srv
    type: server
    services:
      applications:
        - {id: alarms, name: Alarm sink, profile: udp_receiver, port: 5000}
    interfaces: [{id: eth0, ip: 10.0.0.10/24}]
  - id: v
    type: vm
    host: h1
    simulation: {boot_time: 5s}
    services:
      applications:
        - {id: alarm, name: Alarms, profile: udp_sender, peer: srv/alarms, interval: 1s, count: 2, start: simulation_start}
    logical_interfaces: [{id: eth0, type: vnic, port_group: lan, ip: 10.0.0.20/24}]
links:
  - {id: l1, a: "sw:p1", b: "h1:eth0"}
  - {id: l2, a: "sw:p2", b: "srv:eth0"}
`;

test('R3: a guest whose host is restarted at 1 s: it waits for its host (said), boots after it, and its application starts then — once', () => {
  const s = sim(VMNET);
  s.runTo(1000);
  s.powerOff('h1');
  s.powerOn('h1');
  s.runTo(10000);
  assert.equal(runsOf(s, 'v', 'alarm').length, 0);
  assert.equal(notes(s, /v\/alarm \(Alarms\) starts with the simulation once v is operational: v is powered off/).length, 1, 'waiting for its host, said');
  s.runTo(60000);
  const r = runsOf(s, 'v', 'alarm');
  assert.equal(r.length, 1);
  assert.ok(r[0].t0 >= 21000 + 5000 + 3000, `after the host and the guest booted (${r[0].t0} ms)`);
  assert.equal(A.appOutcome(r[0]).ok, 2, A.appSummaryText(r[0]) + ' ' + r[0].tests.map((t) => t.result).join(' | ') + JSON.stringify(r[0].skipped));
});

// ------------------------------------------------------------------ R8: the history keeps what is going on

test('R8: 205 later one-message runs cross the history’s bound while an early run until stopped goes on — it stays (its traffic, its control), a second start of it is refused, the finished history stays bounded', () => {
  const s = sim(LAB('        - {id: beat, name: Heartbeat, profile: udp_sender, peer: srv/alarms, interval: 1s}\n        - {id: once, name: Once, profile: tcp_client, peer: srv/regs}', { boot: '2s' }));
  s.runTo(5000);
  const early = s.actApp('cl', 'beat');
  assert.ok(early.app);
  for (let k = 0; k < 205; k++) {
    const a = s.actApp('cl', 'once');
    assert.ok(a.app, a.error);
    s.runTo(s.now + 200);
  }
  assert.ok(s.apps.runs.includes(early.app), 'the active run is kept');
  const done = s.apps.runs.filter((r) => !s.apps.active(r));
  assert.ok(done.length <= 200, `${done.length} finished runs kept`);
  assert.ok(s.apps.runs.length <= 200, `${s.apps.runs.length} runs kept`);
  const again = s.actApp('cl', 'beat');
  assert.match(again.error || '', /running already/, 'a second concurrent start refused');
  const before = early.app.tests.length;
  s.runTo(s.now + 5000);
  assert.ok(early.app.tests.length >= before + 4, 'its traffic goes on');
  assert.ok(A.appOutcome(early.app).ok >= early.app.sent - 1, A.appSummaryText(early.app));
  assert.equal(s.actionControl(early.id, 'stop'), true, 'still controllable');
  assert.equal(early.app.stopped, true);
});

// ------------------------------------------------------------------ R9: one outcome per original message

test('R9: outcomes per original message — a retry that could not be sent (cl powered off at its moment) fails the message once; retries counted apart', () => {
  const s = sim(LAB('        - {id: ask, name: Ask, profile: udp_client, peer: 10.0.0.99, port: 9, timeout: 1s, retries: 2}', { boot: '2s' }));
  s.runTo(5000);
  const a = s.actApp('cl', 'ask');
  // the first try times out at about 6 s: cl is off then — its retry is not sent
  s.runTo(5500);
  s.powerOff('cl');
  s.runTo(20000);
  const r = a.app;
  assert.ok(r.skipped.length >= 1, JSON.stringify(r.skipped));
  const o = A.appOutcome(r);
  assert.equal(o.ok + o.failed + o.pending + o.cancelled, 1, `one original message: ${JSON.stringify(o)}`);
  assert.equal(o.failed, 1);
  assert.equal(o.retries, r.retried);
});

test('R9: outcomes per original message — every retry timed out (one failure, two retries); three messages each retried (three failures, six retries); a retry answered (one answered)', () => {
  const s = sim(LAB('        - {id: ask, name: Ask, profile: udp_client, peer: 10.0.0.99, port: 9, timeout: 1s, retries: 2}\n        - {id: ask3, name: Ask 3, profile: udp_client, peer: 10.0.0.99, port: 9, timeout: 1s, retries: 2, interval: 5s, count: 3}\n        - {id: slow, name: Slow, profile: udp_client, peer: srv/slow, timeout: 2s, retries: 1}', { boot: '2s' }));
  s.runTo(5000);
  const a = s.actApp('cl', 'ask');
  const b = s.actApp('cl', 'ask3');
  s.runTo(40000);
  assert.deepEqual(A.appOutcome(a.app), { ok: 0, failed: 1, pending: 0, cancelled: 0, retries: 2 });
  assert.deepEqual(A.appOutcome(b.app), { ok: 0, failed: 3, pending: 0, cancelled: 0, retries: 6 });
  // the slow server answers after 3 s: the first try times out at 2 s, its retry's answer (or the first's, late) counts once
  const c = s.actApp('cl', 'slow');
  s.runTo(s.now + 20000);
  const o = A.appOutcome(c.app);
  assert.equal(o.ok + o.failed, 1, JSON.stringify(o));
  assert.equal(o.retries, 1);
});

test('R9: pending and cancelled count once per original message too — a message waiting for its DHCP lease, then Stop', () => {
  const s = sim(LAB('        - {id: ask, name: Ask, profile: udp_client, peer: srv/slow, timeout: 1s, retries: 2}', { boot: '2s', dhcp: true }));
  s.runTo(5000);
  const a = s.actApp('cl', 'ask');
  s.runTo(6000);
  assert.deepEqual(A.appOutcome(a.app), { ok: 0, failed: 0, pending: 1, cancelled: 0, retries: 0 });
  assert.equal(s.actionControl(a.id, 'stop'), true);
  assert.deepEqual(A.appOutcome(a.app), { ok: 0, failed: 0, pending: 0, cancelled: 1, retries: 0 });
});

// ------------------------------------------------------------------ R10: Stop while the last message is on its way

/** Stop a one-message application after ms; no retry of it follows, and the action view agrees */
function stopDuring(apps, ms, o = {}) {
  const s = sim(LAB(apps, { boot: '2s', ...o }));
  s.runTo(5000);
  const a = s.actApp('cl', 'ask');
  assert.ok(a.app, a.error);
  s.runTo(5000 + ms);
  assert.equal(a.app.sent, 1);
  assert.ok(s.apps.active(a.app), 'its message is still on its way');
  const v = s.actions().find((x) => x.id === a.id);
  assert.ok(v.controls.some((c) => c.op === 'stop'), 'Stop offered');
  assert.equal(s.actionControl(a.id, 'stop'), true, 'Stop accepted');
  assert.equal(a.app.stopped, true);
  const tries = a.app.tests.length;
  s.runTo(s.now + 30000);
  assert.equal(a.app.tests.length, tries, 'no retry after Stop');
  assert.ok(!s.events().some((e) => e.t > 5000 + ms && /retry \d+ of/.test(e.detail)), 'no retry said after Stop');
  return { s, a };
}

test('R10: Stop while the only message waits for its DHCP lease — accepted, the message not sent (cancelled), no retry', () => {
  const { s, a } = stopDuring('        - {id: ask, name: Ask, profile: udp_client, peer: srv/slow, timeout: 1s, retries: 2}', 500, { dhcp: true });
  assert.deepEqual(A.appOutcome(a.app), { ok: 0, failed: 0, pending: 0, cancelled: 1, retries: 0 });
  assert.equal(s.actions().find((x) => x.id === a.id).status, 'cancelled');
});

test('R10: Stop while ARP resolves the peer (no such host) — accepted, no retry; its one message ends as it does, counted once', () => {
  const { s, a } = stopDuring('        - {id: ask, name: Ask, profile: udp_client, peer: 10.0.0.99, port: 9, timeout: 5s, retries: 2}', 1);
  s.runTo(s.now + 10000);
  const o = A.appOutcome(a.app);
  assert.equal(o.ok + o.failed + o.cancelled + o.pending, 1, JSON.stringify(o));
  assert.equal(o.retries, 0);
});

test('R10: Stop while the TCP connection is being established (a silent peer) — accepted, no retry', () => {
  const { a } = stopDuring('        - {id: ask, name: Ask, profile: tcp_client, peer: 10.0.0.99, port: 502, timeout: 2s, retries: 2}', 300);
  assert.equal(A.appOutcome(a.app).retries, 0);
});

test('R10: Stop while waiting for the answer (it comes after 3 s, the timeout is 1 s, 2 retries) — accepted; the request already sent finishes, no retry follows the timeout', () => {
  const { s, a } = stopDuring('        - {id: ask, name: Ask, profile: udp_client, peer: srv/slow, timeout: 1s, retries: 2}', 500);
  const o = A.appOutcome(a.app);
  assert.equal(o.failed, 1, JSON.stringify(o));
  assert.equal(o.retries, 0);
  assert.equal(s.actions().find((x) => x.id === a.id).status, 'stopped');
});

test('R10: Stop between a timeout and its configured retry — the retry goes at the timeout itself; Stop during the retry’s own wait: no further retry', () => {
  const s = sim(LAB('        - {id: ask, name: Ask, profile: udp_client, peer: srv/slow, timeout: 1s, retries: 3}', { boot: '2s' }));
  s.runTo(5000);
  const a = s.actApp('cl', 'ask');
  s.runTo(6500);
  // the first try timed out at 6 s and its retry 1 went then: Stop now (retry 1 waits for its answer)
  assert.equal(a.app.tests.length, 2, a.app.tests.map((t) => t.result).join(' | '));
  assert.equal(s.actionControl(a.id, 'stop'), true);
  s.runTo(30000);
  assert.equal(a.app.tests.length, 2, 'no retry 2 after Stop');
  assert.equal(A.appOutcome(a.app).retries, 1);
});
