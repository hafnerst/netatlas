// Diagnosis (analysis/diagnosis.ts): the regression matrix of the evidence-driven answer. Every runtime explanation
// comes from a structured field recorded where it was decided (a test's outcome, a drop's cause, a wait, a DNS
// attempt, an equal-cost choice) — the assertions below check those fields and the diagnosis built from them, never
// the log's words alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const I = load('analysis/comm-identity.js');
const D = load('analysis/diagnosis.js');
const R = load('analysis/result.js');
const MT = load('analysis/mtu.js');

const configured = R.configuredContext('Selected endpoints');

/** Check, hand off, send in the simulation and diagnose the run: the whole workflow headless. */
function workflow(m, req, { at = 70000, wait = 8000, count, interval, s: given, before } = {}) {
  const c = C.checkCommunication(m, req);
  const id = I.commIdentity(m, c);
  const h = I.handoffOf(m, id);
  const s = given || new S.Simulation(m);
  if (!given) s.runTo(at);
  if (before) before(s);
  const plan = { delivery: 'unicast', ...h.prefill };
  if (count) Object.assign(plan, { count, interval });
  const run = s.sendPlan(plan);
  assert.equal(typeof run, 'object', String(run));
  s.runTo(s.now + wait);
  const ev = s.runEvidence(run);
  const d = D.diagnose({ check: c, context: configured, runtime: ev, canPrepare: true });
  return { c, s, run, d };
}

// ------------------------------------------------------------------ a source awaiting its address

const DHCP = `netatlas: 1
title: lease
devices:
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.10/24}], services: {dhcp: {scopes: [{network: lan, range: 10.0.0.100-10.0.0.110, gateway: 10.0.0.1, dns: [10.0.0.10]}]}}}
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ipv4: dhcp}]}
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "srv:eth0", b: "sw:p1"}
  - {id: b, a: "pc:eth0", b: "sw:p2"}
  - {id: c, a: "r1:g0", b: "sw:p3"}
networks:
  - {id: lan, cidr: 10.0.0.0/24}
`;

test('a source awaiting its address: waiting, not failed; once answered, the wait is a prerequisite that was met', () => {
  const m = model(DHCP);
  const s = new S.Simulation(m);
  s.runTo(500);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv' });
  assert.equal(c.verdict, 'indeterminate', 'the configured model has no address for pc');
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', to: 'srv', toIface: 'eth0', toAddr: '10.0.0.10' });
  s.runTo(s.now + 200);
  let d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'waiting', d.summary);
  assert.match(d.summary, /^Waiting, not failed: .*an address \(DHCP lease\)/);
  assert.equal(d.provisional, true);
  s.runTo(s.now + 30000);
  const t = run.tests[0];
  assert.equal(t.ok, true, t.result);
  d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'established', d.summary);
  const w = d.chain.find((l) => l.rel === 'prerequisite');
  assert.ok(w && /waited .* for an address \(DHCP lease\)/.test(w.text), JSON.stringify(d.chain));
});

// ------------------------------------------------------------------ a DNS fallback that succeeds

const DNS2 = `netatlas: 1
title: two resolvers
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.20/24}], dns_servers: [10.0.0.9, 10.0.0.10]}
  - {id: dead, type: server, interfaces: [{id: eth0, ip: 10.0.0.9/24}]}
  - id: ns
    type: server
    interfaces: [{id: eth0, ip: 10.0.0.10/24}]
    services: {dns: {zones: [{name: example.test, records: [{name: www, type: A, value: 10.0.0.30}]}]}}
  - {id: www, type: server, interfaces: [{id: eth0, ip: 10.0.0.30/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "dead:eth0", b: "sw:p2"}
  - {id: c, a: "ns:eth0", b: "sw:p3"}
  - {id: d, a: "www:eth0", b: "sw:p4"}
`;

test('DNS fallback: the first server lost the query, the second answered — recovered, the first server is not the final cause', () => {
  const m = model(DNS2);
  const s = new S.Simulation(m);
  s.runTo(5000);
  // the first resolver's queries are lost on its cable (an impairment of this test), so the resolver falls back
  s.engine.impair = (l, f) => (l === 'b' && f.ip && f.ip.l4 && f.ip.l4.dport === 53 ? { lose: true } : null);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', target: 'www.example.test' });
  s.runTo(s.now + 40000);
  const t = run.tests[0];
  assert.equal(t.ok, true, t.result);
  assert.deepEqual(t.dns.map((x) => [x.server, x.outcome]), [['10.0.0.9', 'lost'], ['10.0.0.9', 'lost'], ['10.0.0.10', 'answered']]);
  const c = C.checkCommunication(m, { from: 'pc', to: 'www.example.test' });
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'recovered', d.summary);
  assert.match(d.summary, /1 answered after recovering\. Answered after DNS: the query to 10\.0\.0\.9 was lost, the query to 10\.0\.0\.9 was lost; 10\.0\.0\.10 answered/);
  assert.deepEqual([d.runtime.completed, d.runtime.outcome, d.runtime.cause, d.provisional], [true, 'succeeded', 'n/a', false]);
  assert.ok(!d.blockers.some((b) => b.source === 'runtime'), 'no runtime blocker');
});

// ------------------------------------------------------------------ no route when sent, a route later

const CHAIN = `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: r1
    type: router
    interfaces: [{id: a, ip: 10.0.1.1/24}, {id: b, ip: 10.0.12.1/30}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.12.2/30}, {id: b, ip: 10.0.2.1/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80"}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l12, a: "r1:b", b: "r2:a"}
  - {id: l2, a: "r2:b", b: "srv:eth0"}
`;

test('no route when sent, a route later: the explanation is the send-time record, never the later working route', () => {
  const m = model(CHAIN);
  const s = new S.Simulation(m);
  s.runTo(70000);
  s.fail('link:l12');
  s.runTo(s.now + 3000);
  const { run, d, c } = workflow(m, { from: 'pc', to: 'srv' }, { s });
  const t = run.tests[0];
  assert.equal(t.ok, false);
  // the cable is down: r1's route via 10.0.12.2 is gone; r1 answers Net Unreachable (or the packet is dropped there)
  assert.ok(t.outcome.kind === 'unreachable' || (t.outcome.drop && /no-route|cable|iface-down/.test(t.outcome.drop.cause.kind)), JSON.stringify(t.outcome));
  assert.equal(c.verdict, 'satisfied', 'the configured model routes it');
  s.restore('link:l12');
  s.runTo(s.now + 10000);
  // later, the route works; the earlier run's diagnosis is unchanged
  const again = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(again.state, 'blocked');
  assert.equal(again.summary, d.summary);
  assert.ok(again.blockers[0].source === 'runtime' && again.blockers[0].t <= t.ended);
});

// ------------------------------------------------------------------ a written policy denies

const FW = (rules, def = 'permit') => `netatlas: 1
title: firewall
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    policy:
      default: ${def}
      rules:
${rules}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80, tcp/443"}}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
`;

test('a written policy denies: the rule (by number) and the packet are linked in the runtime cause and the static layer agrees', () => {
  const m = model(FW('        - {action: permit, proto: tcp, dport: 443}\n        - {action: deny, proto: tcp, dport: 80}'));
  const { run, d, c } = workflow(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  assert.equal(c.verdict, 'violated', c.headline);
  const t = run.tests[0];
  const cause = t.outcome.drop && t.outcome.drop.cause;
  assert.ok(cause && cause.kind === 'policy', JSON.stringify(t.outcome) + ' ' + t.result);
  assert.equal(cause.policy.device, 'fw');
  assert.equal(cause.policy.rule, 2, 'rule 2 (deny tcp/80), 1-based');
  assert.equal(cause.policy.byDefault, false);
  assert.ok(t.pktIds.indexOf(cause.pkt) >= 0, 'the denied packet is one of the test’s');
  assert.match(cause.flow, /^10\.0\.1\.10 → 10\.0\.2\.10 TCP \(6\) \d+ → 80$/);
  assert.equal(d.state, 'blocked');
  assert.ok(d.blockers[0].refs.some((r) => r.ref === 'policy:fw:2'), JSON.stringify(d.blockers[0]));
  assert.ok(d.next.some((x) => x.id === 'goto' && x.ref === 'policy:fw:2'));
  // the default action: no rule number, the default named
  const m2 = model(FW('        - {action: permit, proto: tcp, dport: 443}', 'deny'));
  const w2 = workflow(m2, { from: 'pc', to: 'srv', service: 'tcp/80' });
  const c2 = w2.run.tests[0].outcome.drop.cause;
  assert.equal(c2.policy.byDefault, true);
  assert.equal(c2.policy.rule, undefined);
});

// ------------------------------------------------------------------ a listener bound elsewhere

test('a listener bound to another address: the static listener layer names the mismatch; the runtime refusal is linked to it', () => {
  const m = model(`netatlas: 1
title: bind
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.20/24}], services: {applications: [{id: get, name: Get, profile: tcp_client, peer: "srv/web", interval: 5s}]}}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.0.0.10/24}, {id: mgmt, ip: 10.9.9.10/24}]
    services: {applications: [{id: web, name: Web, profile: tcp_server, port: 8080, bind: mgmt}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "srv:eth0", b: "sw:p2"}
`);
  // asked for the server's LAN address on the listener's port: the listener is bound to mgmt
  const c = C.checkCommunication(m, { from: 'pc', to: '10.0.0.10', service: 'tcp/8080' });
  const lis = c.layers.find((l) => l.id === 'listener');
  assert.ok(lis && lis.verdict === 'violated', JSON.stringify(c.layers.map((l) => [l.id, l.verdict, l.text])));
  const s = new S.Simulation(m);
  s.runTo(70000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 8080, target: '10.0.0.10' });
  s.runTo(s.now + 8000);
  const t = run.tests[0];
  assert.equal(t.outcome.kind, 'refused', t.result);
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'blocked');
  assert.ok(d.blockers.some((b) => b.source === 'static' && /Destination listener/.test(b.text)), 'the static listener mismatch is a blocker');
  assert.ok(d.blockers.some((b) => b.source === 'runtime' && /refused the connection with a RST/.test(b.text)), 'the runtime RST too');
});

// ------------------------------------------------------------------ a TCP retransmission that succeeds

test('a TCP retransmission that succeeds: recovered, not a failure', () => {
  const m = model(CHAIN);
  const s = new S.Simulation(m);
  s.runTo(70000);
  let lost = false;
  // the first SYN is lost once on the cable to the server
  s.engine.impair = (l, f) => (!lost && l === 'l2' && f.ip && f.ip.l4 && f.ip.l4.proto === 'tcp' && f.ip.l4.flags.indexOf('SYN') >= 0 && f.ip.l4.flags.indexOf('ACK') < 0 ? ((lost = true), { lose: true }) : null);
  const { run, d } = workflow(m, { from: 'pc', to: 'srv', service: 'tcp/80' }, { s, wait: 15000 });
  const t = run.tests[0];
  assert.equal(t.ok, true, t.result);
  assert.equal(t.retx, 1);
  assert.equal(d.state, 'recovered', d.summary);
  assert.match(d.summary, /Answered after 1 TCP retransmission/);
});

// ------------------------------------------------------------------ MQTT: the broker receives, a subscriber does not

test('MQTT: the broker acknowledges the publisher, a subscriber receives nothing — the two legs stay distinct', () => {
  const m = model(`netatlas: 1
devices:
  - {id: broker, type: server, services: {mqtt_broker: {}}, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}
  - {id: sensor, type: endpoint, services: {applications: [{id: temp, name: T, profile: mqtt_client, broker: broker, publish: [s/t], interval: 1s, qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.11/24}]}
  - {id: hmi, type: endpoint, services: {applications: [{id: view, name: V, profile: mqtt_client, broker: broker, subscribe: [s/+], qos: "1"}]}, interfaces: [{id: eth0, ip: 10.0.0.20/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: l1, a: "sw:p1", b: "broker:eth0"}
  - {id: l2, a: "sw:p2", b: "sensor:eth0"}
  - {id: l3, a: "sw:p3", b: "hmi:eth0"}
`);
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  // the subscriber is not started: nothing can reach it
  assert.ok(!s.actApp('sensor', 'temp').error);
  s.play(4000);
  const c = C.checkCommunication(m, { from: 'sensor/temp' });
  assert.ok(c.legs.length >= 1, 'the static check has the broker → subscriber leg');
  const mq = s.mqttEvidence('sensor', 'temp', [{ dev: 'hmi', app: 'view' }]);
  assert.ok(mq.pubs.length > 0 && mq.pubs.every((p) => p.brokerRx !== undefined), JSON.stringify(mq.pubs));
  assert.ok(mq.pubs.some((p) => p.acked !== undefined));
  const d = D.diagnose({ check: c, context: configured, mqtt: mq });
  const legP = d.legs.find((l) => /^Publisher sensor\/temp → broker broker \(runtime, run #\d+\)/.test(l.label));
  const legS = d.legs.find((l) => /^Broker broker → subscriber hmi\/view \(runtime/.test(l.label));
  // (its last publication may still wait for its PUBACK: waiting, never a failure)
  assert.ok(legP.state === 'established' || legP.state === 'waiting', legP.text);
  // the broker's fan-out recorded nobody for these publications: a prerequisite not met (the subscriber was not running), not "unknown"
  assert.equal(legS.state, 'blocked', legS.text);
  assert.match(legS.text, /the broker passed none of the \d+ publications? on its topics \([^)]+\) to it: when they arrived it had no session with a matching subscription .*it was not started in this simulation/);
  assert.ok(d.blockers.some((b) => b.rel === 'prerequisite' && /^Subscriber hmi\/view/.test(b.text)));
});

// ------------------------------------------------------------------ a tunnel's outer packet denied

test('a tunnel’s outer packet denied: the cause names the outer identity (IP-in-IP 4 between the tunnel ends) and the rule', () => {
  const m = model(`netatlas: 1
title: gre through a firewall
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 192.0.2.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 198.51.100.2}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}, {prefix: 198.51.100.0/30, via: 192.0.2.2}]
  - id: fw
    type: firewall
    interfaces: [{id: x, ip: 192.0.2.2/30}, {id: y, ip: 198.51.100.1/30}]
    policy:
      default: permit
      rules:
        - {action: deny, proto: any, source: 192.0.2.1, destination: 198.51.100.2}
        - {action: deny, proto: any, source: 198.51.100.2, destination: 192.0.2.1}
  - id: b
    type: router
    interfaces: [{id: wan, ip: 198.51.100.2/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}, {prefix: 192.0.2.0/30, via: 198.51.100.1}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: ha:eth0, b: a:lan}
  - {id: l2, a: a:wan, b: fw:x}
  - {id: l3, a: fw:y, b: b:wan}
  - {id: l4, a: b:lan, b: hb:eth0}
relations:
  - {id: ipip1, protocol: ipip, endpoints: ["a:tun0", "b:tun0"]}
`);
  // (both directions: a stateful firewall passes one direction's packets as the reply of a session the other opened —
  // runtime state the static policy check, which decides each direction by its rules, does not have)
  const s = new S.Simulation(m);
  s.runTo(70000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'ha', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const t = run.tests[0];
  assert.equal(t.ok, false, t.result);
  const cause = t.outcome.drop && t.outcome.drop.cause;
  assert.ok(cause && cause.kind === 'policy', JSON.stringify(t.outcome));
  assert.equal(cause.policy.device, 'fw');
  assert.equal(cause.policy.rule, 1);
  assert.equal(cause.flow, '192.0.2.1 → 198.51.100.2 IP-in-IP (4) carrying 10.1.0.10 → 10.2.0.10', 'the outer header that was decided on, and what it carried');
  const c = C.checkCommunication(m, { from: 'ha', to: 'hb' });
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  // (the outer packet carried its own: every attempt it made was dropped there — the decisive cause, with both packets linked)
  assert.equal(d.blockers[0].rel, 'cause');
  assert.match(d.blockers[0].text, /^It timed out: its packet was dropped — fw denied it 192\.0\.2\.1 → 198\.51\.100\.2 IP-in-IP \(4\) carrying 10\.1\.0\.10 → 10\.2\.0\.10 .*rule 1/);
  const refs = d.blockers[0].refs.map((r) => r.ref);
  assert.ok(refs.indexOf(`packet:${s.exec}:${cause.pkt}`) >= 0 && refs.indexOf(`packet:${s.exec}:${t.pktIds[0]}`) >= 0 && refs.indexOf('policy:fw:1') >= 0, refs.join(' '));
  assert.equal(d.state, 'blocked');
});

// ------------------------------------------------------------------ an MTU boundary with encapsulation

test('an MTU boundary with encapsulation: the diagnosis of the send one byte over the static limit is too-big at that limit', () => {
  const m = model(`netatlas: 1
title: gre mtu
devices:
  - {id: ha, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: a
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24, mtu: 1500}, {id: wan, ip: 192.0.2.1/30, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 192.0.2.2, mtu: 1476}]
    routes: [{prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: b
    type: router
    interfaces: [{id: wan, ip: 192.0.2.2/30, mtu: 1500}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 192.0.2.1, mtu: 1476}]
    routes: [{prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: hb, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: ha:eth0, b: a:lan}
  - {id: l2, a: a:wan, b: b:wan}
  - {id: l4, a: b:lan, b: hb:eth0}
relations:
  - {id: gre1, protocol: gre, endpoints: ["a:tun0", "b:tun0"]}
`);
  const c = C.checkCommunication(m, { from: 'ha', to: 'hb' });
  const mtu = MT.pathMtu(m, c);
  assert.equal(mtu.mtu, 1476);
  const sizes = MT.mtuTestSizes(mtu);
  const s = new S.Simulation(m);
  s.runTo(70000);
  const pre = I.handoffOf(m, I.commIdentity(m, c)).prefill;
  const over = s.sendPlan({ delivery: 'unicast', ...pre, size: sizes.tooBig, df: true });
  s.runTo(s.now + 8000);
  assert.equal(over.tests[0].outcome.kind, 'too-big');
  assert.equal(over.tests[0].outcome.mtu, 1476, 'the runtime limit is the static one');
  const d = D.diagnose({ check: c, context: configured, mtu, runtime: s.runEvidence(over), canPrepare: true });
  assert.equal(d.state, 'blocked');
  assert.match(d.blockers[0].text, /larger than the path takes \(1476 bytes\)/);
  const fits = s.sendPlan({ delivery: 'unicast', ...pre, size: sizes.fits, df: true });
  s.runTo(s.now + 8000);
  assert.equal(fits.tests[0].ok, true);
});

// ------------------------------------------------------------------ mixed equal-cost outcomes

test('mixed equal-cost outcomes: partial, with the branch each message took as recorded — never one explanation made from the first branch', () => {
  // r1 has two equal-cost routes to the server's LAN: via r2 (permits) and via fw (denies tcp/80)
  const m = model(`netatlas: 1
title: ecmp
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: r1
    type: router
    interfaces: [{id: a, ip: 10.0.1.1/24}, {id: b, ip: 10.0.12.1/30}, {id: c, ip: 10.0.13.1/30}]
    routes: [{prefix: 10.0.2.0/24, via: 10.0.12.2}, {prefix: 10.0.2.0/24, via: 10.0.13.2}]
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.12.2/30}, {id: b, ip: 10.0.2.2/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.12.1}]
  - id: fw
    type: firewall
    interfaces: [{id: a, ip: 10.0.13.2/30}, {id: b, ip: 10.0.2.3/24}]
    routes: [{prefix: 10.0.1.0/24, via: 10.0.13.1}]
    policy: {default: permit, rules: [{action: deny, proto: tcp, dport: 80}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.2}], simulation: {listening: "tcp/80"}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l12, a: "r1:b", b: "r2:a"}
  - {id: l13, a: "r1:c", b: "fw:a"}
  - {id: l2, a: "r2:b", b: "sw:p1"}
  - {id: l3, a: "fw:b", b: "sw:p2"}
  - {id: l4, a: "srv:eth0", b: "sw:p3"}
`);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  assert.equal(c.verdict, 'partial', c.headline);
  const s = new S.Simulation(m);
  s.runTo(70000);
  // several connections (each its own source port, so its own flow and hash)
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10', count: 8, interval: 1 });
  s.runTo(s.now + 40000);
  const oks = run.tests.filter((t) => t.ok).length;
  assert.ok(oks > 0 && oks < run.tests.length, `${oks} of ${run.tests.length} answered: both branches were taken`);
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'partial', d.summary);
  const br = d.chain.find((l) => /^Equal-cost branches taken \(as recorded\)/.test(l.text));
  assert.ok(br && /branch 1 of 2/.test(br.text) && /branch 2 of 2/.test(br.text), br && br.text);
  assert.ok(d.blockers.some((b) => b.source === 'static' && /Equal-cost alternatives differ/.test(b.text)));
});

// ------------------------------------------------------------------ Stop during an active attempt

test('Stop during an active attempt: no application-generated retry afterwards; what was not sent is cancelled', () => {
  const m = model(`netatlas: 1
title: stop
devices:
  - {id: cl, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.20/24}], services: {applications: [{id: ask, name: Ask, profile: tcp_client, peer: 10.0.0.99, port: 80, interval: 1s, timeout: 2s, retries: 3}]}}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}]}
links:
  - {id: a, a: "cl:eth0", b: "sw:p1"}
`);
  const s = withClock(new S.Simulation(m));
  s.runTo(3000);
  const a = s.actApp('cl', 'ask');
  assert.ok(!a.error, a.error);
  s.play(2500);
  s.actionControl(a.id, 'stop');
  const at = s.now;
  s.play(20000);
  const retries = s.events().filter((e) => e.t > at && e.device === 'cl' && e.what === 'retry');
  assert.equal(retries.length, 0, 'no retry after Stop');
  const sentAfter = s.events().filter((e) => e.t > at + 1 && e.device === 'cl' && e.kind === 'message' && e.protocol !== 'arp' && /SYN/.test(e.detail) && !/retransmission/.test(e.detail));
  assert.equal(sentAfter.length, 0, 'no new attempt after Stop');
});

// ------------------------------------------------------------------ the evidence retention boundary (pure)

test('the evidence retention boundary: a timeout whose events are no longer kept is evidence-limited, said, never explained', () => {
  const m = model(CHAIN);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv' });
  const t = { id: 9, msg: 1, done: true, ok: false, started: 1000, ended: 6000, result: 'no answer within 5 s (timed out)', pktIds: [3], dst: { version: 4, bytes: [10, 0, 2, 10] }, port: 0, outcome: { kind: 'timeout' } };
  const subject = { kind: 'send', id: 1, label: 'send #1 (pc → srv)', t0: 1000, stopped: false, count: 1, sent: 1, skipped: [] };
  const rt = (retained) => ({ exec: 1, subject, tests: [t], events: [], log: [], waits: () => [], retained, now: 60000 });
  const d = D.diagnose({ check: c, context: configured, runtime: rt({ first: 50000, firstSeq: 20000, dropped: 20000 }) });
  assert.equal(d.evidenceLimited, true);
  assert.ok(d.chain.some((l) => l.rel === 'hypothesis' && /no longer kept/.test(l.text)));
  assert.match(d.summary, /The recorded evidence does not establish why the exchange failed\./);
  // a finished timeout whose cause is unknown: failed — not blocked, not on its way, not provisional
  assert.equal(d.state, 'failed');
  assert.equal(d.provisional, false);
  assert.deepEqual([d.runtime.completed, d.runtime.outcome, d.runtime.cause], [true, 'failed', 'unknown']);
  // with the events kept and none of its packets dropped: not established either, without the retention note
  const d2 = D.diagnose({ check: c, context: configured, runtime: rt({ first: 0, firstSeq: 0, dropped: 0 }) });
  assert.equal(d2.evidenceLimited, false);
  assert.ok(d2.chain.some((l) => l.rel === 'hypothesis' && /no drop of its packets was recorded/.test(l.text)));
});

// ------------------------------------------------------------------ a model edited after the diagnosis (pure)

test('a model edited after the diagnosis: outdated, Refresh first; the export says so', () => {
  const m = model(CHAIN);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv' });
  const d = D.diagnose({ check: c, context: configured, outdated: true });
  assert.equal(d.outdated, true);
  assert.equal(d.next[0].id, 'refresh');
  assert.match(D.diagnosisText(d).join('\n'), /outdated: the model changed after it/);
});

// ------------------------------------------------------------------ several independent blockers (pure)

test('independent blockers: no single cause is claimed', () => {
  // two layers that each prevent it (the check's own record): both are named, neither is called the cause
  const c = { request: { from: 'pc', to: 'srv' }, verdict: 'violated', headline: 'Blocked', from: { device: 'pc', address: '10.0.1.10', text: 'pc · 10.0.1.10' }, to: { device: 'srv', address: '10.0.2.10', text: 'srv · 10.0.2.10' }, legs: [], info: {},
    layers: [
      { id: 'address', verdict: 'satisfied', text: 'The ends have addresses', detail: [], refs: [] },
      { id: 'path', verdict: 'violated', text: 'Every path stops at r1: no route', detail: [], refs: ['device:r1'] },
      { id: 'policy', verdict: 'violated', text: 'Denied at fw', detail: [], refs: ['device:fw'] },
      { id: 'runtime', verdict: 'unsupported', text: 'Not established by static analysis', detail: [], refs: [] },
    ] };
  const d = D.diagnose({ check: c, context: configured });
  assert.equal(d.blockers.filter((x) => x.rel === 'cause').length, 2);
  assert.match(d.summary, /^2 independent blockers: Network path, Policy \(no single cause\)$/);
});

// ------------------------------------------------------------------ headless versus paced variants

test('headless versus paced: the same structured outcomes, causes and waits', () => {
  const m = model(FW('        - {action: deny, proto: tcp, dport: 80}'));
  const one = (paced) => {
    const s = new S.Simulation(m);
    if (paced) withClock(s);
    s.runTo(70000);
    const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10', count: 3, interval: 1 });
    if (paced) s.play(20000, 37);
    else s.runTo(s.now + 20000);
    return run.tests.map((t) => ({ ok: t.ok, outcome: { ...t.outcome, drop: t.outcome.drop ? { cause: t.outcome.drop.cause, device: t.outcome.drop.device, t: t.outcome.drop.t } : undefined }, waits: t.waits, retx: t.retx, ended: t.ended }));
  };
  assert.deepEqual(one(true), one(false));
});
