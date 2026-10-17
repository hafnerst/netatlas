// Applications in the simulation (analysis/sim/apps.ts): listeners answer with their own sizes,
// clients run only when started (Network events, or with the simulation when their start says so),
// one-way messages count at their receiver, bind interfaces restrict a listener, requests that time
// out are retried, and the address family is the application's (never a fallback). Injected clocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');

const NET = (extra = '') => `netatlas: 2
devices:
  - id: sw
    type: switch
    igmp_mld_snooping: {1: disabled}
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
  - id: plc
    type: endpoint
    kind: plc
    services:
      applications:
        - {id: registers, name: Modbus TCP, profile: tcp_server, port: 502, response_size: 300}
        - {id: config, name: Configuration, profile: udp_server, port: 7000, bind: eth1}
        - {id: alarms, name: Alarm sink, profile: udp_receiver, port: 5000}
    interfaces:
      - {id: eth0, ip: [10.0.0.10/24, 2001:db8::10/64]}
      - {id: eth1, ip: 10.0.1.10/24}
  - id: hmi
    type: endpoint
    kind: hmi
    services:
      applications:
        - {id: poll, name: Register polling, profile: tcp_client, peer: plc/registers, interval: 2s, count: 3}
        - {id: once, name: One read, profile: tcp_client, peer: plc/registers}
        - {id: alarm, name: Alarms, profile: udp_sender, peer: plc/alarms, interval: 1s, count: 2}
        - {id: cfg-app, name: Config by app, profile: udp_client, peer: plc/config}
        - {id: cfg-dev, name: Config by device, profile: udp_client, peer: plc, port: 7000}
        - {id: v6, name: Over IPv6, profile: tcp_client, peer: plc/registers, ip_version: "6"}
        - {id: v6-none, name: IPv6 to nowhere, profile: udp_client, peer: plc/config, ip_version: "6"}
        - {id: lost, name: To a silent peer, profile: udp_client, peer: 10.0.0.99, port: 9, timeout: 1s, retries: 2}
${extra}    interfaces:
      - {id: eth0, ip: [10.0.0.20/24, 2001:db8::20/64, 10.0.1.20/24]}
  - id: ghost
    type: endpoint
    interfaces: [{id: eth0, ip: 10.0.0.99/24}]
    simulation: {closed_port_reply: "off"}
links:
  - {id: l1, a: "sw:p1", b: "plc:eth0"}
  - {id: l2, a: "sw:p2", b: "hmi:eth0"}
  - {id: l3, a: "sw:p3", b: "plc:eth1"}
  - {id: l4, a: "sw:p4", b: "ghost:eth0"}
`;

const sim = (text = NET()) => withClock(new S.Simulation(model(text)));
const settle = (s, ms = 20000) => s.runTo(s.now + ms);
const view = (s, id) => s.actions().find((v) => v.id === id);
const appMsgs = (s, name) => s.events().filter((e) => e.test !== undefined && /hmi\//.test(e.detail) && e.detail.indexOf(name) >= 0);

test('nothing runs because an application exists: no application traffic until it is started', () => {
  const s = sim();
  settle(s, 30000);
  assert.equal(s.apps.runs.length, 0);
  assert.ok(!s.events().some((e) => /hmi\/(poll|once|alarm)/.test(e.detail)), 'no message of an application');
  // the listeners are open all the same: a test to the PLC's port is answered
  const t = s.sendTest({ from: 'hmi', to: '10.0.0.10', kind: 'tcp', port: 502 });
  settle(s);
  assert.equal(t.ok, true, t.result);
});

test('a TCP client and its listener: connected and answered with the listener’s response size; a series of 3 every 2 s', () => {
  const s = sim();
  settle(s, 5000);
  const a = s.actApp('hmi', 'once');
  assert.ok(!a.error, a.error);
  settle(s);
  const v = view(s, a.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.summary, '1 answered');
  assert.match(v.details.join('\n'), /connected and answered \(300 bytes\)/);
  assert.ok(s.events().some((e) => /the answer of plc\/registers \(Modbus TCP\)/.test(e.detail)), 'the answer is the application’s');
  // a series: in real time (Network events), the first at once
  const b = s.actApp('hmi', 'poll');
  assert.equal(b.app.tests.length, 1);
  s.play(4500);
  settle(s);
  const w = view(s, b.id);
  assert.equal(b.app.tests.length, 3);
  assert.equal(w.summary, '3 answered');
  assert.equal(w.status, 'completed');
  assert.deepEqual(w.progress, { done: 3, total: 3, unit: 'sent' });
});

test('periodic one-way UDP messages: received by the receiver, which answers nothing', () => {
  const s = sim();
  settle(s, 5000);
  const a = s.actApp('hmi', 'alarm');
  s.play(1500);
  settle(s);
  const v = view(s, a.id);
  assert.equal(v.summary, '2 received');
  assert.match(v.details.join('\n'), /received by plc\/alarms on UDP 5000 \(nothing comes back\)/);
  assert.match(v.outcome.basis, /reached its receiver/);
  assert.ok(!s.events().some((e) => e.what === 'UDP answer' && e.device === 'plc' && /5000/.test(e.detail)), 'the receiver never answers');
  assert.ok(s.events().some((e) => /plc\/alarms \(Alarm sink\) takes the datagram/.test(e.detail)));
});

test('a bind interface: a peer application reaches the listener on its interface; the device’s other address is refused', () => {
  const s = sim();
  settle(s, 5000);
  const ok = s.actApp('hmi', 'cfg-app');
  const bad = s.actApp('hmi', 'cfg-dev');
  settle(s);
  assert.equal(view(s, ok.id).summary, '1 answered', view(s, ok.id).details.join('\n'));
  assert.match(view(s, ok.id).details.join('\n'), /UDP answer from 10\.0\.1\.10/);
  assert.equal(view(s, bad.id).summary, '1 failed');
  assert.ok(s.events().some((e) => /udp\/7000 listens on eth1 only, not on 10\.0\.0\.10/.test(e.detail)), 'refused, with where it listens');
});

test('the address family is the application’s: IPv6 when it says so, and no fallback to IPv4 when the peer has none', () => {
  const s = sim();
  settle(s, 5000);
  const a = s.actApp('hmi', 'v6');
  settle(s);
  assert.equal(view(s, a.id).summary, '1 answered');
  assert.equal(a.app.tests[0].dst.version, 6);
  // the listener on eth1 has no IPv6 address: refused with the reason, nothing sent over IPv4
  assert.match(s.appProblem('hmi', 'v6-none'), /plc\/config: it listens on plc:eth1 only, which has no IPv6 address/);
  const b = s.actApp('hmi', 'v6-none');
  assert.match(b.error, /no IPv6 address/);
});

test('a request that times out is retried up to its retries; the run counts the message once', () => {
  const s = sim();
  settle(s, 5000);
  const a = s.actApp('hmi', 'lost');
  settle(s, 30000);
  const v = view(s, a.id);
  assert.equal(a.app.tests.length, 3, 'the first try and two retries');
  assert.deepEqual(a.app.tests.map((t) => t.retry || 0), [0, 1, 2]);
  assert.equal(v.summary, '1 failed · 2 retries');
  assert.ok(s.events().some((e) => /hmi\/lost: message 1 got no answer within its timeout: retry 1 of 2/.test(e.detail)));
});

test('several applications at once, each its own event; Stop ends a series, those on their way finish', () => {
  const s = sim(NET().replace('{id: poll, name: Register polling, profile: tcp_client, peer: plc/registers, interval: 2s, count: 3}', '{id: poll, name: Register polling, profile: tcp_client, peer: plc/registers, interval: 1s}'));
  settle(s, 5000);
  const a = s.actApp('hmi', 'poll');
  const b = s.actApp('hmi', 'alarm');
  s.play(2500);
  const va = view(s, a.id);
  const vb = view(s, b.id);
  assert.equal(va.status, 'running');
  assert.ok(vb.status === 'running' || vb.status === 'completed');
  assert.equal(va.progress.total, null, 'until stopped');
  assert.ok(s.foregroundActive());
  assert.equal(s.actionControl(a.id, 'stop'), true);
  const sent = a.app.sent;
  s.play(3000);
  settle(s);
  assert.equal(a.app.sent, sent, 'no message after Stop');
  assert.equal(view(s, a.id).status, 'stopped');
  // a second start of a running application is refused
  const c = s.actApp('hmi', 'alarm');
  if (b.app.tests.some((t) => !t.done)) assert.match(c.error || '', /running already/);
});

test('with the simulation: an application whose start says so runs from the start, as the scenario’s traffic', () => {
  const s = sim(NET().replace('{id: once, name: One read, profile: tcp_client, peer: plc/registers}', '{id: once, name: One read, profile: tcp_client, peer: plc/registers, interval: 5s, start: simulation_start}'));
  settle(s, 20000);
  const r = s.apps.runs.find((x) => x.app.id === 'once');
  assert.ok(r, 'it started');
  assert.equal(r.how, 'start');
  assert.ok(r.tests.length >= 3 && r.tests.every((t) => t.source === 'traffic'), 'background traffic, in simulated time');
  assert.ok(r.tests.some((t) => t.ok));
  // not an event of Network events; a status row instead
  assert.ok(!s.actions().some((v) => v.kind === 'app'));
  assert.ok(s.status().some((x) => x.name === 'hmi/once: One read' && /answered/.test(x.detail)));
});

test('a host name: resolved by DNS (AAAA for IPv6) before the connection', () => {
  const text = NET('').replace('  - id: ghost', `  - id: dns1
    type: server
    services:
      dns:
        zones:
          - {name: plant.example, records: [{name: plc, type: A, value: 10.0.0.10}, {name: plc, type: AAAA, value: "2001:db8::10"}]}
    interfaces: [{id: eth0, ip: 10.0.0.53/24}]
  - id: ghost`).replace('{id: eth0, ip: [10.0.0.20/24, 2001:db8::20/64, 10.0.1.20/24]}', '{id: eth0, ip: [10.0.0.20/24, 2001:db8::20/64, 10.0.1.20/24]}\n    dns_servers: [10.0.0.53]').replace('        - {id: lost,', '        - {id: byname, name: By name, profile: tcp_client, peer: plc.plant.example, port: 502}\n        - {id: byname6, name: By name over IPv6, profile: tcp_client, peer: plc.plant.example, port: 502, ip_version: "6"}\n        - {id: lost,').replace('  - {id: l4, a: "sw:p4", b: "ghost:eth0"}', '  - {id: l4, a: "sw:p4", b: "ghost:eth0"}\n  - {id: l5, a: "sw:p5", b: "dns1:eth0"}').replace('{id: p4, vlans: 1}]', '{id: p4, vlans: 1}, {id: p5, vlans: 1}]');
  const s = sim(text);
  settle(s, 5000);
  const a = s.actApp('hmi', 'byname');
  const b = s.actApp('hmi', 'byname6');
  settle(s);
  assert.equal(view(s, a.id).summary, '1 answered', view(s, a.id).details.join('\n'));
  assert.match(view(s, a.id).details.join('\n'), /plc\.plant\.example = 10\.0\.0\.10/);
  assert.equal(view(s, b.id).summary, '1 answered', view(s, b.id).details.join('\n'));
  assert.match(view(s, b.id).details.join('\n'), /plc\.plant\.example = 2001:db8::10/);
});
