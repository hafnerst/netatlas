// Send test as the form describes it (Simulation.sendPlan): a delivery type
// (unicast, multicast, local or directed broadcast) with the protocols it
// offers and the destination it asks for; a port only for TCP and UDP; a
// number of messages sent an interval apart on the simulated timeline. The
// rules are shared (test-plan.ts): what the form offers, what blocks Send
// (planCheck) and what is sent can't disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/test-plan.js');

const sim = (text, opts) => new S.Simulation(model(text), opts);
const HOUSE = example('private-house.yaml');

/** One LAN with two multicast routers, a switch, two members of 239.2.2.2 (dual stack) and a host that is none. */
const MC = `netatlas: 1
title: lan
devices:
  - {id: q1, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: [10.5.0.1/24, "2001:db8:5::1/64"]}]}
  - {id: q2, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: [10.5.0.2/24, "2001:db8:5::2/64"]}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: [10.5.0.11/24, "2001:db8:5::11/64"], multicast: {join: [239.2.2.2]}}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: [10.5.0.12/24, "2001:db8:5::12/64"], multicast: {join: [239.2.2.2]}}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.13/24}]}
links:
  - {id: l1, a: "q1:g0", b: "sw:p1"}
  - {id: l2, a: "q2:g0", b: "sw:p2"}
  - {id: l3, a: "h1:eth0", b: "sw:p3"}
  - {id: l4, a: "h2:eth0", b: "sw:p4"}
  - {id: l5, a: "h3:eth0", b: "sw:p5"}
`;

/** Two switches, h1 (answers broadcast pings) and h2 on 10.0.0.0/24, r1 to h9 on 10.9.0.0/24; directed broadcasts per r1:g0. */
const LAN = (r = '') => `netatlas: 1
title: lan
devices:
  - {id: sw1, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
  - {id: sw2, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: h1, type: server, interfaces: [{id: eth0, ip: 10.0.0.1/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.254}], simulation: {respond_to_broadcast_ping: "on"}}
  - {id: h2, type: server, interfaces: [{id: eth0, ip: 10.0.0.2/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.0.254}]}
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.254/24${r}}, {id: g1, ip: 10.9.0.1/24}]}
  - {id: h9, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.9/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
links:
  - {id: a, a: "sw1:p1", b: "sw2:p1"}
  - {id: b, a: "sw1:p2", b: "sw2:p2"}
  - {id: c, a: "sw1:p3", b: "h1:eth0"}
  - {id: d, a: "sw2:p3", b: "h2:eth0"}
  - {id: e, a: "sw1:p4", b: "r1:g0"}
  - {id: g, a: "r1:g1", b: "h9:eth0"}
`;

/** The Echo Requests / UDP requests a device sent itself (originating, not forwarded copies or replies), from the log. */
const originated = (s, dev, type) => s.events().filter((e) => e.kind === 'message' && e.device === dev && e.what === type);

test('the shared rules: the protocols of each delivery type, ports only for TCP and UDP, the order of what is missing', () => {
  assert.deepEqual(P.kindsFor('unicast'), ['icmp', 'tcp', 'udp']);
  assert.deepEqual(P.kindsFor('multicast'), ['udp']);
  assert.deepEqual(P.kindsFor('broadcast'), ['icmp', 'udp']);
  assert.deepEqual(P.kindsFor('directed'), ['icmp', 'udp']);
  for (const d of P.DELIVERIES) assert.ok(d === 'unicast' || P.kindsFor(d).indexOf('tcp') < 0, `no TCP for ${d}`);
  assert.equal(P.usesPorts('icmp'), false);
  assert.equal(P.usesPorts('tcp') && P.usesPorts('udp'), true);
  const base = { delivery: 'unicast', from: 'a', to: 'b', toIface: 'eth0', toAddr: '10.0.0.1' };
  assert.equal(P.planProblem({ ...base, delivery: '' }), 'Choose a delivery type.');
  assert.equal(P.planProblem({ ...base, from: '' }), 'Choose the device to send from.');
  assert.equal(P.planProblem({ ...base, via: '' }), 'Choose the interface to send from.');
  // the protocol unselected: no port is asked for or assumed
  assert.equal(P.planProblem({ ...base, kind: '' }), 'Choose a protocol.');
  assert.equal(P.planProblem({ ...base, kind: '', port: 80 }), 'Choose a protocol.');
  assert.equal(P.planProblem({ ...base, kind: 'udp' }), 'Enter the destination port.');
  assert.equal(P.planProblem({ ...base, kind: 'udp', port: 70000 }), 'The port is a whole number from 1 to 65535.');
  assert.equal(P.planProblem({ ...base, kind: 'icmp', port: 80 }), 'ICMP (ping) has no ports.');
  assert.equal(P.planProblem({ ...base, kind: 'icmp' }), null);
  assert.equal(P.planProblem({ ...base, kind: 'udp', port: 53, keep: true }), 'Keep open is for TCP only.');
  assert.match(P.planProblem({ delivery: 'multicast', from: 'a', group: '239.1.1.1', kind: 'tcp', port: 80 }), /^TCP connects to one host: not for multicast\.$/);
  assert.match(P.planProblem({ delivery: 'broadcast', from: 'a', scope: 'limited', kind: 'tcp', port: 80 }), /^TCP connects to one host/);
  assert.equal(P.planProblem({ delivery: 'multicast', from: 'a', group: '239.1.1.1', kind: 'icmp' }), 'ICMP (ping) is not offered for multicast.');
  // destinations
  assert.equal(P.planProblem({ delivery: 'unicast', from: 'a', kind: 'icmp' }), 'Choose the destination.');
  assert.equal(P.planProblem({ delivery: 'unicast', from: 'a', to: 'b', kind: 'icmp' }), 'Choose the destination interface.');
  assert.equal(P.planProblem({ delivery: 'unicast', from: 'a', target: '', kind: 'icmp' }), 'Enter the address or host name.');
  assert.equal(P.planProblem({ delivery: 'unicast', from: 'a', target: '239.1.1.1', kind: 'icmp' }), '239.1.1.1 is a group: choose Multicast.');
  assert.equal(P.planProblem({ delivery: 'multicast', from: 'a', group: '10.1.1.1', kind: 'udp', port: 5004 }), '10.1.1.1 is not a multicast group (224.0.0.0/4, ff00::/8).');
  assert.equal(P.planProblem({ delivery: 'multicast', from: 'a', group: 'ff15::1', kind: 'udp', port: 5004 }), null);
  assert.equal(P.planProblem({ delivery: 'broadcast', from: 'a', kind: 'icmp' }), 'Choose the broadcast scope.');
  assert.equal(P.planProblem({ delivery: 'directed', from: 'a', subnet: '', kind: 'icmp' }), 'Enter the target subnet (e.g. 10.1.2.0/24) or its broadcast address.');
  assert.equal(P.planProblem({ delivery: 'directed', from: 'a', subnet: '2001:db8::/64', kind: 'icmp' }), 'IPv6 has no broadcast: choose Multicast (ff02::1 reaches every node of a link).');
  assert.equal(P.planProblem({ delivery: 'directed', from: 'a', subnet: '10.0.0.0/31', kind: 'icmp' }), 'A /31 has no broadcast address.');
  assert.equal(P.planProblem({ delivery: 'directed', from: 'a', subnet: '255.255.255.255', kind: 'icmp' }), '255.255.255.255 is the limited broadcast: choose Local broadcast.');
  const dt = P.directedTarget('10.1.2.0/23');
  assert.deepEqual(dt.bytes, [10, 1, 3, 255]);
  assert.deepEqual(P.directedTarget('10.1.2.255').bytes, [10, 1, 2, 255], 'a bare address is taken as written, never widened');
});

test('message count and interval: whole numbers from 1 to the limit, a positive interval only when more than one message', () => {
  const ok = { delivery: 'unicast', from: 'a', to: 'b', toIface: 'eth0', toAddr: '10.0.0.1', kind: 'icmp' };
  const msg = `The number of messages is a whole number from 1 to ${P.MAX_MESSAGES}.`;
  for (const count of [0, -1, 1.5, NaN, P.MAX_MESSAGES + 1]) assert.equal(P.planProblem({ ...ok, count, interval: 1 }), msg, String(count));
  const iv = `The interval is a number of seconds from ${P.MIN_INTERVAL} to ${P.MAX_INTERVAL}.`;
  for (const interval of [undefined, 0, -1, NaN, Infinity, P.MAX_INTERVAL + 1, 0.001]) assert.equal(P.planProblem({ ...ok, count: 2, interval }), iv, String(interval));
  assert.equal(P.planProblem({ ...ok, count: 1 }), null, 'one message: no interval');
  assert.equal(P.planProblem({ ...ok, count: 100, interval: 1 }), null);
  assert.equal(P.planProblem({ ...ok, count: P.MAX_MESSAGES, interval: 0.5 }), null);
  assert.equal(P.messageTime(2000, 1, 1), 2000);
  assert.equal(P.messageTime(2000, 100, 1), 101000);
  assert.equal(P.messageTime(0, 3, 0.25), 500);
});

test('the source and destination labels: each interface "name - address", a DHCP client with its lease now, short reasons', () => {
  const s = sim(HOUSE, { params: {} });
  const src = (id) => s.testSources().find((x) => x.id === id);
  // the ISP cloud can't send: a short reason (the long one stays for the error)
  assert.equal(src('isp').ok, false);
  assert.equal(src('isp').short, 'Cannot send IP packets');
  assert.match(src('isp').reason, /no IP stack of its own/);
  assert.deepEqual(src('core').ifaces.map((i) => i.label), ['Vlan10 - 192.168.10.1', 'Vlan110 - 10.0.10.2', 'Vlan120 - 10.0.20.2', 'Vlan130 - 10.0.30.2', 'Vlan20 - 192.168.20.1', 'Vlan30 - 192.168.30.1', 'Vlan99 - 192.168.99.1']);
  // a DHCP client before and after its lease
  assert.deepEqual(src('guest-phone').ifaces.map((i) => [i.label, i.usable, i.ready]), [['wlan0 - No DHCP lease', true, false]]);
  s.runTo(9000);
  const gp = src('guest-phone').ifaces[0];
  assert.match(gp.label, /^wlan0 - 192\.168\.30\.\d+ \(DHCP\)$/);
  assert.equal(gp.bcast, '192.168.30.255');
  const lease = /192\.168\.30\.\d+/.exec(gp.label)[0];
  // destinations: every device but the source, one option per address, a DHCP client's lease
  const dests = s.testDestinations('laptop');
  assert.ok(!dests.some((d) => d.id === 'laptop'));
  assert.deepEqual(dests.find((d) => d.id === 'isp'), { id: 'isp', ok: false, short: 'Cannot receive IP packets', options: [] });
  assert.deepEqual(dests.find((d) => d.id === 'guest-phone').options, [{ value: 'wlan0|dhcp', iface: 'wlan0', addr: 'dhcp', label: `wlan0 - ${lease} (DHCP)`, ok: true }]);
  assert.deepEqual(dests.find((d) => d.id === 'dsl-router').options.map((o) => o.label), ['lan.110 - 10.0.10.1', 'lan.120 - 10.0.20.1', 'lan.130 - 10.0.30.1', 'wan - 203.0.113.10']);
  // two addresses on one interface: two options, one each
  const mc = sim(MC);
  assert.deepEqual(mc.testDestinations('h3').find((d) => d.id === 'h1').options.map((o) => o.label), ['eth0 - 10.5.0.11', 'eth0 - 2001:db8:5::11']);
  assert.deepEqual(mc.testSources().find((x) => x.id === 'h1').ifaces.map((i) => i.label), ['eth0 - 10.5.0.11, 2001:db8:5::11']);
  // a switch without an address: no IP address
  const sw = mc.testSources().find((x) => x.id === 'sw');
  assert.equal(sw.ok, false);
  assert.ok(['No IP address', 'No interfaces'].indexOf(sw.short) >= 0, sw.short);
});

test('unicast: the destination interface chosen is the target (also a DHCP lease, found when the message is sent); several need a choice', () => {
  const s = sim(HOUSE, { params: {} });
  // before the lease: the guest phone is no destination yet
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', via: 'Vlan30', to: 'guest-phone', toIface: 'wlan0', toAddr: 'dhcp', kind: 'icmp' }), 'guest-phone:wlan0 has no DHCP lease now.');
  s.runTo(9000);
  const lease = /192\.168\.30\.\d+/.exec(s.testSources().find((x) => x.id === 'guest-phone').ifaces[0].label)[0];
  const r = s.sendPlan({ delivery: 'unicast', from: 'core', via: 'Vlan30', to: 'guest-phone', toIface: 'wlan0', toAddr: 'dhcp', kind: 'icmp' });
  assert.equal(typeof r, 'object', r);
  assert.equal(r.tests[0].target, 'guest-phone');
  assert.equal(r.tests[0].series, 'core:Vlan30 → guest-phone ICMP echo');
  s.runTo(s.now + 3000);
  assert.equal(r.tests[0].result, `Echo Reply from ${lease}`);
  // the DSL router has four addresses: one must be chosen; the one chosen is the target
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', to: 'dsl-router', kind: 'icmp' }), 'Choose the destination interface.');
  const w = s.sendPlan({ delivery: 'unicast', from: 'core', to: 'dsl-router', toIface: 'wan', toAddr: '203.0.113.10', kind: 'icmp' });
  assert.equal(w.tests[0].target, 'dsl-router:wan');
  assert.deepEqual(w.tests[0].dst.bytes, [203, 0, 113, 10]);
  // an address that interface does not have: refused, not replaced by another
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', to: 'dsl-router', toIface: 'wan', toAddr: '10.0.10.1', kind: 'icmp' }), 'dsl-router:wan has no address 10.0.10.1.');
  // an address or a host name written in: as before; a device's name there is refused (choose it under To)
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', target: '203.0.113.80', kind: 'tcp', port: 443 }), null);
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', target: 'nas', kind: 'icmp' }), 'nas is a device: choose it under To.');
  assert.equal(s.planCheck({ delivery: 'unicast', from: 'core', target: '192.168.10.255', kind: 'icmp' }), '192.168.10.255 is a subnet’s broadcast address: choose Local or Directed broadcast.');
});

test('ports: none for ICMP (the packets carry none), the one chosen for TCP and UDP; nothing sent for a plan that has a stale port', () => {
  const s = sim(HOUSE, { params: {} });
  s.runTo(9000);
  const ping = s.sendPlan({ delivery: 'unicast', from: 'laptop', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'icmp' });
  assert.equal(ping.tests[0].port, 0);
  s.runTo(s.now + 2000);
  const req = s.events().filter((e) => e.test === ping.tests[0].id && e.hdr && e.hdr.l4);
  assert.ok(req.length && req.every((e) => e.hdr.l4.sport === undefined && e.hdr.l4.dport === undefined), JSON.stringify(req.map((e) => e.hdr.l4)));
  assert.equal(s.sendPlan({ delivery: 'unicast', from: 'laptop', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'icmp', port: 80 }), 'ICMP (ping) has no ports.');
  const udp = s.sendPlan({ delivery: 'unicast', from: 'laptop', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'udp', port: 5353 });
  assert.equal(udp.tests[0].port, 5353);
  assert.equal(udp.series, 'laptop → nas udp/5353');
});

test('100 messages at 1 s: exactly 100 originating echo requests, message n at t0 + (n − 1) s, not waiting for replies; deterministic and quick', () => {
  const plan = { delivery: 'unicast', from: 'h2', to: 'h9', toIface: 'eth0', toAddr: '10.9.0.9', kind: 'icmp', count: 100, interval: 1 };
  const go = () => {
    const s = sim(LAN());
    s.runTo(3000);
    const t0 = Date.now();
    const r = s.sendPlan(plan);
    s.runTo(s.now + 110000);
    return { s, r, ms: Date.now() - t0 };
  };
  const { s, r, ms } = go();
  assert.equal(typeof r, 'object', r);
  assert.equal(r.count, 100);
  assert.equal(r.sent, 100);
  assert.equal(r.tests.length, 100);
  assert.deepEqual(r.tests.map((t) => t.msg), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(r.tests.map((t) => t.started - r.t0), Array.from({ length: 100 }, (_, i) => i * 1000));
  assert.equal(r.tests[99].started, r.t0 + 99000, 'the last at t0 + 99 s');
  assert.ok(r.tests.every((t) => t.done && t.ok), r.tests.filter((t) => !t.ok).map((t) => t.result).join(' | '));
  // the count is of originating messages: replies and forwarded copies are not more of them
  const sent = originated(s, 'h2', 'Echo Request').filter((e) => r.tests.some((t) => t.id === e.test));
  assert.equal(sent.length, 100);
  // deterministic: the same plan, the same events
  const again = go();
  const key = (x) => x.s.events().map((e) => `${e.t}|${e.device}|${e.what}|${e.detail}`).join('\n');
  assert.equal(key(again), key({ s }));
  assert.ok(ms < 5000, `${ms} ms`);
});

test('a series does not wait for replies: an unanswered destination still gets one message per interval', () => {
  const s = sim(LAN());
  s.runTo(3000);
  // r1 drops the directed broadcast; the echo to an address nobody has times out after 5 s, the interval is 1 s
  const r = s.sendPlan({ delivery: 'unicast', from: 'h2', target: '10.0.0.77', kind: 'icmp', count: 4, interval: 1 });
  s.runTo(r.t0 + 2500);
  assert.equal(r.sent, 3, 'messages 1–3 sent while message 1 waits');
  assert.ok(r.tests.every((t) => !t.done));
  s.runTo(r.t0 + 12000);
  assert.equal(r.sent, 4);
  assert.ok(r.tests.every((t) => t.done && !t.ok));
});

test('Stop ends a series: nothing more is sent, those on their way finish; the clock running in steps (pause and play) changes nothing', () => {
  const s = sim(LAN());
  s.runTo(3000);
  const r = s.sendPlan({ delivery: 'unicast', from: 'h2', to: 'h1', toIface: 'eth0', toAddr: '10.0.0.1', kind: 'udp', port: 9, count: 50, interval: 0.5 });
  s.runTo(r.t0 + 4600);
  assert.equal(r.sent, 10);
  assert.equal(s.stopRun(r.id), true);
  assert.equal(s.stopRun(r.id), false, 'once');
  s.runTo(r.t0 + 60000);
  assert.equal(r.sent, 10);
  assert.equal(r.tests.length, 10);
  assert.equal(r.stopped, true);
  assert.equal(r.stoppedAt, r.t0 + 4600);
  assert.equal(originated(s, 'h2', 'UDP request').filter((e) => r.tests.some((t) => t.id === e.test)).length, 10, 'no originating send after Stop');
  assert.ok(r.tests.every((t) => t.done));
  // a finished series can't be stopped; stopRuns stops every one still sending
  assert.equal(s.stopRun(r.id), false);
  const a = s.sendPlan({ delivery: 'unicast', from: 'h2', to: 'h1', toIface: 'eth0', toAddr: '10.0.0.1', kind: 'icmp', count: 5, interval: 1 });
  const b = s.sendPlan({ delivery: 'unicast', from: 'h1', to: 'h2', toIface: 'eth0', toAddr: '10.0.0.2', kind: 'icmp', count: 5, interval: 1 });
  assert.equal(s.stopRuns(), 2);
  s.runTo(s.now + 10000);
  assert.deepEqual([a.sent, b.sent], [1, 1]);
  // the same series run in small steps (paused and played again) and at once: the same times
  const times = (steps) => {
    const x = sim(LAN());
    x.runTo(3000);
    const q = x.sendPlan({ delivery: 'unicast', from: 'h2', to: 'h1', toIface: 'eth0', toAddr: '10.0.0.1', kind: 'icmp', count: 6, interval: 0.75 });
    for (let t = x.now; t < q.t0 + 8000; t += steps) x.runTo(t);
    x.runTo(q.t0 + 8000);
    return q.tests.map((t) => [t.started - q.t0, t.result]);
  };
  assert.deepEqual(times(37), times(8000));
  assert.deepEqual(times(37).map((x) => x[0]), [0, 750, 1500, 2250, 3000, 3750]);
});

test('multicast: members of the group receive it, a host that is none does not; UDP only; the group must be one', () => {
  const s = sim(MC);
  s.runTo(5000);
  assert.equal(s.planCheck({ delivery: 'multicast', from: 'h3', group: '239.2.2.2', kind: 'tcp', port: 80 }), 'TCP connects to one host: not for multicast.');
  const r = s.sendPlan({ delivery: 'multicast', from: 'h3', group: '239.2.2.2', kind: 'udp', port: 5004, count: 3, interval: 1 });
  assert.equal(typeof r, 'object', r);
  assert.equal(r.series, 'h3:eth0 → 239.2.2.2 udp/5004');
  s.runTo(r.t0 + 9000);
  assert.equal(r.sent, 3);
  for (const t of r.tests) assert.equal(t.result, 'received by 2 members: h1, h2');
  // the replicas the switch made are not more messages: three from h3
  assert.equal(originated(s, 'h3', 'UDP request').filter((e) => r.tests.some((t) => t.id === e.test)).length, 3);
  // a group nobody joined: nobody takes it (not delivered to everyone)
  const none = s.sendPlan({ delivery: 'multicast', from: 'h3', group: '239.9.9.9', kind: 'udp', port: 5004 });
  s.runTo(s.now + 6000);
  assert.match(none.tests[0].result, /^no member received it within 5 s/);
  // an IPv6 group from a host with IPv4 only: said so
  assert.equal(s.planCheck({ delivery: 'multicast', from: 'h3', group: 'ff15::1', kind: 'udp', port: 5004 }), 'h3:eth0 has no IPv6 address for an IPv6 group.');
  assert.equal(s.planCheck({ delivery: 'multicast', from: 'h1', group: 'ff15::1', kind: 'udp', port: 5004 }), null);
});

test('local broadcast: limited or the interface’s subnet, within its broadcast domain (its VLAN), never routed; a source with several interfaces names one', () => {
  const s = sim(LAN());
  s.runTo(3000);
  const r = s.sendPlan({ delivery: 'broadcast', from: 'h2', scope: 'subnet', kind: 'icmp' });
  assert.equal(r.tests[0].target, '10.0.0.255');
  s.runTo(s.now + 6000);
  assert.equal(r.tests[0].result, '1 answer: 10.0.0.1 (h1)');
  const lim = s.sendPlan({ delivery: 'broadcast', from: 'h2', scope: 'limited', kind: 'udp', port: 9 });
  assert.equal(lim.tests[0].target, '255.255.255.255');
  s.runTo(s.now + 6000);
  assert.ok(!s.events().some((e) => e.test === lim.tests[0].id && e.device === 'h9'), 'never past r1');
  // several interfaces: the one it leaves
  assert.equal(s.planCheck({ delivery: 'broadcast', from: 'r1', scope: 'subnet', kind: 'icmp' }), 'Choose the interface to send from.');
  assert.equal(s.sendPlan({ delivery: 'broadcast', from: 'r1', via: 'g1', scope: 'subnet', kind: 'icmp' }).tests[0].target, '10.9.0.255');
  // the private house: from the laptop (VLAN 10) the guest phone (VLAN 30) hears nothing of it
  const h = sim(HOUSE, { params: {} });
  h.runTo(9000);
  const b = h.sendPlan({ delivery: 'broadcast', from: 'laptop', scope: 'limited', kind: 'udp', port: 9 });
  h.runTo(h.now + 6000);
  const at = new Set(h.events().filter((e) => e.test === b.tests[0].id).map((e) => e.device));
  assert.ok(at.has('nas') || at.has('phone'), Array.from(at).join(', '));
  assert.ok(!at.has('guest-phone') && !at.has('tv') && !at.has('thermostat'), Array.from(at).join(', '));
});

test('directed broadcast: the subnet written explicitly, one of the model and not the source’s own; dropped where routers don’t forward them, delivered where they do', () => {
  const s = sim(LAN());
  s.runTo(3000);
  assert.equal(s.planCheck({ delivery: 'directed', from: 'h9', subnet: '10.0.0.0/24', kind: 'icmp' }), null);
  assert.equal(s.planCheck({ delivery: 'directed', from: 'h9', subnet: '10.0.0.0/25', kind: 'icmp' }), '10.0.0.127 is not the broadcast address of a subnet of the model.');
  assert.equal(s.planCheck({ delivery: 'directed', from: 'h9', subnet: '10.9.0.0/24', kind: 'icmp' }), '10.9.0.255 is the broadcast address of h9’s own subnet: choose Local broadcast.');
  assert.equal(s.planCheck({ delivery: 'directed', from: 'h9', subnet: '10.0.0.0/24', kind: 'tcp', port: 80 }), 'TCP connects to one host: not for directed broadcast.');
  const off = s.sendPlan({ delivery: 'directed', from: 'h9', subnet: '10.0.0.0/24', kind: 'icmp' });
  s.runTo(s.now + 6000);
  assert.match(off.tests[0].result, /^no answer within 5 s .*dropped at r1: r1 drops the directed broadcast to 10\.0\.0\.255 \(forward directed broadcasts Off \(default\); RFC 2644\)/);
  // on r1:g0: sent on as a broadcast (the router's setting, never turned on by the test)
  const on = sim(LAN(', simulation: {directed_broadcast: "on"}'));
  on.runTo(3000);
  const ok = on.sendPlan({ delivery: 'directed', from: 'h9', subnet: '10.0.0.255', kind: 'icmp', count: 2, interval: 1 });
  on.runTo(on.now + 8000);
  assert.deepEqual(ok.tests.map((t) => t.result), ['1 answer: 10.0.0.1 (h1)', '1 answer: 10.0.0.1 (h1)']);
});

test('a source that can’t send: refused with the short reason, nothing scheduled', () => {
  const s = sim(HOUSE, { params: {} });
  assert.equal(s.sendPlan({ delivery: 'unicast', from: 'isp', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'icmp', count: 5, interval: 1 }), 'isp: Cannot send IP packets.');
  assert.equal(s.testRuns().length, 0);
});
