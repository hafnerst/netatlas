// The traffic of Network events' multicast operations, and interface actions'
// states. A join's reports and a stream's datagrams carry their operation's
// id (as a send's messages carry their test's): drawn whatever protocols and
// senders are ticked, in the log, found by their event. They follow the
// simulation's own forwarding: replicated where it replicates, stopped where
// it stops (said in the event), never to devices it doesn't reach. Shut
// interface ends a flapping first; a shut interface can't start flapping;
// Stop flapping cancels the flap's later transitions and leaves the cable as
// it would be without it; an interface's state is administrative and
// operational apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const sim = (text, opts) => new S.Simulation(model(text), opts);
const view = (s, id) => s.actions().find((v) => v.id === id);
const flightsOf = (s, tag, from = 0) => s.engine.flights.filter((f) => f.test === tag && f.t0 >= from);

/** One LAN: a multicast router (querier), a switch with snooping, h1 a member of 239.2.2.2, h2 and h3 not. */
const MC = `netatlas: 1
title: lan
devices:
  - {id: q1, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: 10.5.0.1/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.11/24, multicast: {join: [239.2.2.2]}}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.12/24}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.13/24}]}
links:
  - {id: l1, a: "q1:g0", b: "sw:p1"}
  - {id: l3, a: "h1:eth0", b: "sw:p3"}
  - {id: l4, a: "h2:eth0", b: "sw:p4"}
  - {id: l5, a: "h3:eth0", b: "sw:p5"}
`;

test('the private house has no multicast protocol to tick: a join’s reports and a stream’s datagrams carry their event’s id, so they are drawn whatever is ticked', () => {
  const s = sim(example('private-house.yaml'), { params: {} });
  const ids = s.protocolEntries().map((e) => e.id);
  assert.ok(ids.indexOf('igmp') < 0 && ids.indexOf('mcast') < 0, 'nothing to tick: why they were not drawn before');
  s.runTo(9000);
  const j = s.actJoin('tv', 'wlan0', '239.1.1.1', []);
  const st = s.actStream('nas', 'eth0', '239.1.1.1', 5004, 1000, 1316);
  assert.ok(j.traffic !== undefined && st.traffic !== undefined && j.traffic !== st.traffic);
  // never the id of a test
  assert.ok(!s.tests().some((t) => t.id === j.traffic || t.id === st.traffic));
  s.runTo(11500);
  // the join: its membership reports (control traffic, never datagrams), from tv's Wi-Fi interface into VLAN 20
  const jr = flightsOf(s, j.traffic, 9000);
  assert.ok(jr.length > 0);
  assert.ok(jr.every((f) => f.protocol === 'igmp' && /^IGMP Report 239\.1\.1\.1/.test(f.label)), jr.map((f) => f.label).join(' | '));
  assert.ok(jr.some((f) => f.track.ref === 'link:w-tv' && f.sender === 'tv'), 'from the TV over its Wi-Fi link');
  const reports = s.events().filter((e) => e.test === j.traffic && e.kind === 'message');
  assert.equal(reports.length, 2, 'the unsolicited report and its repetition');
  assert.match(reports[0].detail, /^IGMPv3 Report from tv \(192\.168\.20\.\d+\) to 224\.0\.0\.22: IS_EX \(239\.1\.1\.1, \{\}\)/);
  assert.ok(!flightsOf(s, j.traffic).some((f) => f.protocol === 'mcast'));
  // the stream: from the NAS, replicated through VLAN 10 by the switches; the core routes no multicast: it stops there
  const sf = flightsOf(s, st.traffic, 9000);
  assert.ok(sf.every((f) => f.protocol === 'mcast'));
  assert.ok(sf.some((f) => f.track.ref === 'link:l-core-nas' && f.sender === 'nas'), 'it leaves the NAS');
  const links = new Set(sf.map((f) => f.track.ref));
  assert.ok(links.has('link:l-core-dist') && links.has('link:l-dist-ap2'), 'copies on the VLAN 10 path');
  for (const no of ['link:w-tv', 'link:w-guest-phone', 'link:w-thermostat', 'link:l-router-core']) assert.ok(!links.has(no), `no copy towards ${no}: another VLAN, or past the core`);
  // originating datagrams counted apart from their copies
  assert.equal(st.stream.sent, 3);
  assert.ok(sf.length > 3 * 3, `${sf.length} flights for 3 datagrams`);
  const v = view(s, st.id);
  assert.match(v.summary, /^3 datagrams sent · no member received any yet · stops at core$/);
  assert.ok(v.details.some((d) => /^Last stopped at core: core routes no multicast \(it runs no PIM\)/.test(d)), v.details.join(' | '));
  assert.deepEqual(v.tests, [st.traffic]);
  // in the log, found by the event's id: the first datagram (a message with its headers: the packet inspector)
  const first = s.events().find((e) => e.test === st.traffic && e.kind === 'message' && e.hdr);
  assert.match(first.detail, /^multicast datagram 1 from nas \(192\.168\.10\.20\) to 239\.1\.1\.1:5004/);
});

test('with a multicast router and a member: the stream reaches the member only; the join is recorded; Stop ends the datagrams; the model’s own traffic is not marked', () => {
  const s = sim(MC);
  s.runTo(5000);
  const st = s.actStream('h3', 'eth0', '239.2.2.2', 5004, 500, 1000);
  s.runTo(7600);
  const sf = flightsOf(s, st.traffic, 5000);
  const to = new Set(sf.map((f) => f.track.ref));
  assert.ok(to.has('link:l5') && to.has('link:l3'), 'from h3 to the member h1');
  assert.ok(!to.has('link:l4'), 'not to h2: snooping knows it is no member');
  assert.equal(st.stream.rx.get('h1'), st.stream.sent);
  assert.match(view(s, st.id).summary, /^\d+ datagrams sent · received by h1 \(\d+\)$/);
  // Stop: no datagram of it after the stop; those on their way arrive
  s.actionControl(st.id, 'stop');
  const at = s.now;
  s.runTo(at + 5000);
  assert.equal(flightsOf(s, st.traffic, at + 1).length, 0);
  // a join: reports from h2, recorded by q1; the model's own reports (h1's answers to queries) carry no id
  const j = s.actJoin('h2', 'eth0', '239.2.2.2', []);
  s.runTo(s.now + 2000);
  assert.ok(flightsOf(s, j.traffic).some((f) => f.sender === 'h2' && f.protocol === 'igmp'));
  assert.equal(view(s, j.id).summary, 'membership recorded by q1:g0');
  s.runTo(s.now + 130000);
  assert.ok(s.engine.flights.filter((f) => f.protocol === 'igmp' && f.sender === 'h1').every((f) => f.test === undefined), 'h1’s reports are the model’s');
  // the join's answers to later queries belong to the membership, not to the join
  const later = s.events().filter((e) => e.test === j.traffic && e.kind === 'message' && e.t > j.at + 3000);
  assert.deepEqual(later, []);
  // Leave group: its leave report is the event's too
  s.actionControl(j.id, 'leave');
  s.runTo(s.now + 100);
  assert.ok(s.events().some((e) => e.test === j.traffic && /leaves the group/.test(e.detail)));
});

test('a stream is scheduled by the simulation: its datagrams at its interval of simulated time, the same whether run at once or in steps; none while the clock stands', () => {
  const times = (step) => {
    const s = sim(MC);
    s.runTo(5000);
    const st = s.actStream('h3', 'eth0', '239.2.2.2', 5004, 750, 1000);
    for (let t = 5000; t <= 9000; t += step) s.runTo(t);
    return s.events().filter((e) => e.test === st.traffic && e.kind === 'message').map((e) => e.t).concat([st.stream.sent]);
  };
  assert.deepEqual(times(37), times(4000));
  const s = sim(MC);
  s.runTo(5000);
  const st = s.actStream('h3', 'eth0', '239.2.2.2', 5004, 750, 1000);
  s.runTo(5000 + 3100);
  assert.equal(st.stream.sent, 5, 'at 5, 5.75, 6.5, 7.25 and 8 s (each with the timers’ small jitter)');
  // the clock standing (paused): nothing more
  const n = s.engine.flights.length;
  s.runTo(s.now);
  assert.equal(s.engine.flights.length, n);
});

test('interface states: administrative and operational apart; Shut interface ends a flapping first; a shut interface can’t flap; one flapping per cable; Stop flapping cancels its later transitions', () => {
  const s = sim(example('private-house.yaml'), { params: {} });
  s.runTo(9000);
  const E = s.engine;
  assert.deepEqual(E.portStatus('core', 'wan'), { admin: 'up', oper: 'up', why: '' });
  // flapping, then an explicit shut: the flapping stops first (no later transition brings it up), the shut stands
  const f = s.actFlap('iface:core:wan');
  s.runTo(s.now + 1000);
  assert.equal(E.portStatus('core', 'wan').why, 'flapping (down)');
  assert.equal(s.actFlap('iface:dsl-router:lan').error, 'dsl-router:lan is flapping already', 'one flapping per cable, from either end');
  const sh = s.actShut('core', 'wan');
  assert.equal(sh.error, undefined);
  assert.equal(view(s, f.id).status, 'stopped');
  assert.equal(view(s, sh.id).status, 'completed');
  assert.deepEqual(E.portStatus('core', 'wan'), { admin: 'down', oper: 'down', why: 'shut' });
  const t0 = s.now;
  s.runTo(t0 + 60000);
  assert.deepEqual(E.portStatus('core', 'wan'), { admin: 'down', oper: 'down', why: 'shut' }, 'still down: no flap transition undid the shut');
  assert.ok(!s.events().some((e) => e.t > t0 && /^Flap (up|down)$/.test(e.what)));
  // a shut interface can't start flapping
  assert.equal(s.actFlap('iface:core:wan').error, 'core:wan is shut: bring it up first');
  // Bring interface up (No shut): administratively up at once, the link up after its link-up delay
  assert.equal(s.actionControl(sh.id, 'noshut'), true);
  assert.equal(E.portStatus('core', 'wan').admin, 'up');
  s.runTo(s.now + 10000);
  assert.deepEqual(E.portStatus('core', 'wan'), { admin: 'up', oper: 'up', why: '' });
  assert.match(view(s, sh.id).state, /^interface up again \(no shut at t = /);
  // Stop flapping in its down phase: the cable comes up again (as without the flapping), no later transition
  const g = s.actFlap('iface:core:wan');
  s.runTo(s.now + 1000);
  assert.equal(E.portStatus('core', 'wan').oper, 'down');
  s.actionControl(g.id, 'stop');
  const t1 = s.now;
  s.runTo(t1 + 60000);
  assert.equal(E.portStatus('core', 'wan').oper, 'up');
  assert.ok(!s.events().some((e) => e.t > t1 && /^Flap (up|down)$/.test(e.what)));
  // administratively up, but its peer is off: the operational state says why
  s.powerOff('dsl-router');
  s.runTo(s.now + 5000);
  assert.deepEqual(E.portStatus('core', 'wan'), { admin: 'up', oper: 'down', why: 'dsl-router is off' });
  // a port without a cable; a logical interface
  assert.equal(E.portStatus('core', 'Vlan10').oper, 'up');
});
