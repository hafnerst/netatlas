// Diagnosis faithful to its evidence (analysis/diagnosis.ts): the operation's completion, its observed outcome and the
// certainty about its cause are answered apart; a RST, a later working route, the last recorded drop, a neighbour
// failure or a missing service say only what the records establish; several causes in one series stay several; the
// prerequisite behind a missing route or tunnel is the recorded state change, with the recorded fate of the session's own
// packets. The assertions read structured fields; changing a record's words never changes a classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const C = load('analysis/communication.js');
const I = load('analysis/comm-identity.js');
const D = load('analysis/diagnosis.js');
const R = load('analysis/result.js');
const T = load('ui/trace.js');

const configured = R.configuredContext('Selected endpoints');

// ------------------------------------------------------------------ the outcome / certainty matrix (pure)

const CHAIN = `netatlas: 1
title: chain
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: r1, type: router, interfaces: [{id: a, ip: 10.0.1.1/24}, {id: b, ip: 10.0.2.1/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}], simulation: {listening: "tcp/80"}}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l2, a: "r1:b", b: "srv:eth0"}
`;

const DST = { version: 4, bytes: [10, 0, 2, 10] };
let tid = 100;
/** A test as the transport records it (only the fields the diagnosis reads). */
function T0(o) {
  const id = ++tid;
  return { id, msg: o.msg || 1, kind: 'tcp', port: 80, target: '10.0.2.10', dst: DST, pktIds: o.pktIds || [id * 10], started: o.started || 1000, ended: o.done === false ? undefined : (o.started || 1000) + 5000, done: o.done !== false, ok: !!o.ok, result: o.result || (o.ok ? 'connected and answered' : 'no answer within 5 s (timed out)'), outcome: o.outcome, retx: o.retx, waits: o.waits, answers: [], ...(o.extra || {}) };
}
const DROP = (pkt, extra = {}) => ({ seq: 42, t: 1200, device: 'r1', cause: { kind: 'loss', link: 'l2', pkt }, text: 'lost on l2', attempt: true, ...extra });
function rt(tests, o = {}) {
  return { exec: 7, subject: { kind: 'send', id: 1, label: 'send #1 (pc → srv tcp/80)', t0: 1000, stopped: !!o.stopped, count: o.count !== undefined ? o.count : tests.length, sent: o.sent !== undefined ? o.sent : tests.length, skipped: o.skipped || [] }, tests, events: [], log: [], waits: () => [], retained: o.retained || { first: 0, firstSeq: 0, dropped: 0 }, now: 60000 };
}

test('completion, outcome and cause certainty are answered apart — structured, and in the labels the window shows', () => {
  const m = model(CHAIN);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  const dx = (tests, o) => D.diagnose({ check: c, context: configured, runtime: rt(tests, o) });
  const row = (d) => [d.state, d.runtime.completed, d.runtime.outcome, d.runtime.cause, d.provisional];
  const timeoutKnown = () => { const t = T0({ outcome: { kind: 'timeout', attempts: 1, logFrom: 0 } }); t.outcome.drops = [DROP(t.pktIds[0])]; return t; };
  const cases = [
    // [what, tests, opts, expected row]
    ['pending, waiting for its lease', [T0({ done: false, waits: [{ cond: 'lease', why: 'pc:eth0', since: 1000 }] })], {}, ['waiting', false, 'none', 'n/a', true]],
    ['pending, on its way', [T0({ done: false })], {}, ['in-progress', false, 'none', 'n/a', true]],
    ['completed, answered', [T0({ ok: true, outcome: { kind: 'answered' } })], {}, ['established', true, 'succeeded', 'n/a', false]],
    ['completed, answered after a retransmission', [T0({ ok: true, retx: 1, outcome: { kind: 'answered' } })], {}, ['recovered', true, 'succeeded', 'n/a', false]],
    ['completed, timed out, cause known (its only attempt dropped)', [timeoutKnown()], {}, ['blocked', true, 'failed', 'established', false]],
    ['completed, timed out, cause unknown (nothing recorded)', [T0({ outcome: { kind: 'timeout', attempts: 1, logFrom: 0 } })], {}, ['failed', true, 'failed', 'unknown', false]],
    ['completed, timed out, evidence missing (log trimmed before it)', [T0({ outcome: { kind: 'timeout', attempts: 1, logFrom: 50000 } })], {}, ['failed', true, 'failed', 'unknown', false]],
    ['completed, cancelled', [T0({ outcome: { kind: 'cancelled', unsent: true } })], { stopped: true }, ['cancelled', true, 'cancelled', 'n/a', false]],
    ['completed, answered and cancelled', [T0({ ok: true, outcome: { kind: 'answered' } }), T0({ msg: 2, outcome: { kind: 'cancelled', unsent: true } })], { stopped: true }, ['partial', true, 'mixed', 'n/a', false]],
    ['failed and still pending', [timeoutKnown(), T0({ msg: 2, done: false })], {}, ['partial', false, 'failed', 'established', true]],
    ['answered and still pending', [T0({ ok: true, outcome: { kind: 'answered' } }), T0({ msg: 2, done: false })], {}, ['in-progress', false, 'succeeded', 'n/a', true]],
    ['answered, one more to send', [T0({ ok: true, outcome: { kind: 'answered' } })], { count: 2, sent: 1 }, ['in-progress', false, 'succeeded', 'n/a', true]],
    ['failed: one cause known, one unknown', [timeoutKnown(), T0({ msg: 2, outcome: { kind: 'timeout', attempts: 1, logFrom: 0 } })], {}, ['failed', true, 'failed', 'partly', false]],
  ];
  for (const [what, tests, o, want] of cases) {
    const d = dx(tests, o);
    assert.deepEqual(row(d), want, `${what}: ${d.summary}`);
    // the label shown is the state's, never "Blocked" for a cause the records don't establish
    const label = T.DIAG_STATE[d.state].label;
    if (d.runtime.cause === 'unknown' || d.runtime.cause === 'partly') assert.notEqual(label, 'Blocked', what);
  }
  assert.equal(T.DIAG_STATE.failed.label, 'Not completed — cause not established');
  assert.equal(T.DIAG_STATE['in-progress'].label, 'In progress');
  // an unknown cause of a finished run is said, and the run is not "on its way"
  const u = dx([T0({ outcome: { kind: 'timeout', attempts: 1, logFrom: 0 } })], {});
  assert.match(u.summary, /1 not completed \(cause not established\)\. The recorded evidence does not establish why the exchange failed\./);
  assert.ok(!/on (its|their) way/.test(u.summary));
  const ev = dx([T0({ outcome: { kind: 'timeout', attempts: 1, logFrom: 50000 } })], {});
  assert.equal(ev.evidenceLimited, true);
  // static and runtime are kept apart: the static check says reachable, the run says not completed
  assert.equal(u.static.state, 'established');
  assert.match(D.diagnosisText(u).join('\n'), /^Static analysis: established — /m);
  assert.match(D.diagnosisText(u).join('\n'), /^Simulation: finished; observed failed; cause unknown — /m);
});

// ------------------------------------------------------------------ the last recorded drop is not the cause by itself

const FWREJ = (rules, srv = '') => `netatlas: 1
title: firewall
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.0.1.1/24}, {id: out, ip: 10.0.2.1/24}]
    simulation: {default_action: reject}
    policy:
      default: permit
      rules:
${rules}
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.0.2.10/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]
    services: {applications: [{id: web, name: Web, profile: tcp_server, port: 80}${srv}]}
links:
  - {id: l1, a: "pc:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "srv:eth0"}
`;

test('a firewall’s RST while a listener exists: the rejecting device and its rule, never “nothing listens”', () => {
  const m = model(FWREJ('        - {action: deny, proto: tcp, dport: 80}'));
  const s = new S.Simulation(m);
  s.runTo(5000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' });
  s.runTo(s.now + 5000);
  const t = run.tests[0];
  assert.deepEqual([t.outcome.kind, t.outcome.by, t.outcome.byAddr, t.outcome.reason], ['refused', 'fw', '10.0.2.10', 'policy'], JSON.stringify(t.outcome));
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  const d = D.diagnose({ check: c, context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'blocked');
  const b = d.blockers[0];
  assert.match(b.text, /^Fw refused the connection: its policy rejected it \(rule 1 \(deny tcp any → any dport 80\)\) and answered with a RST \(from 10\.0\.2\.10\)/i);
  assert.ok(!/nothing listens|no listener|closed/.test(d.blockers.map((x) => x.text).join(' ') + d.summary), d.summary);
  assert.ok(b.refs.some((r) => r.ref === 'policy:fw:1'));
  assert.ok(b.refs.some((r) => r.ref === `event:${s.exec}:${t.outcome.event}`), 'the decision’s own log line');
  // the static policy layer denies it too: the comparison agrees, with nothing to explain
  const k = I.compareRun(m, c, run, s.snapshot());
  assert.deepEqual([c.verdict, k.runtime, k.agree, k.lines.length], ['violated', 'failed', true, 0]);
});

test('a closed port’s own RST: said as its sender recorded it (the port is closed there), by the destination itself', () => {
  const m = model(FWREJ('        - {action: deny, proto: udp, dport: 9}'));
  const s = new S.Simulation(m);
  s.runTo(5000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 81, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' });
  s.runTo(s.now + 5000);
  const t = run.tests[0];
  assert.deepEqual([t.outcome.kind, t.outcome.by, t.outcome.reason], ['refused', 'srv', 'closed']);
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/81' }), context: configured, runtime: s.runEvidence(run) });
  assert.match(d.blockers[0].text, /^Srv refused the connection with a RST \(from 10\.0\.2\.10\): TCP port 81 is closed there/);
});

test('one lost attempt, then a different final failure: the rejection decides, the loss is contributing — not the cause', () => {
  const m = model(FWREJ('        - {action: deny, proto: tcp, dport: 80}'));
  const s = new S.Simulation(m);
  s.runTo(5000);
  // the first SYN is lost on pc's cable; the retransmitted one reaches fw and is rejected
  let lost = false;
  s.engine.impair = (l, f) => (!lost && l === 'l1' && f.ip && f.ip.l4 && f.ip.l4.proto === 'tcp' && (f.ip.l4.flags || []).indexOf('SYN') >= 0 ? ((lost = true), { lose: true }) : null);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' });
  s.runTo(s.now + 10000);
  const t = run.tests[0];
  assert.equal(t.retx, 1, t.result);
  assert.equal(t.outcome.kind, 'refused');
  const kinds = t.outcome.drops.map((x) => x.cause.kind);
  assert.deepEqual(kinds, ['loss', 'policy'], 'both recorded in its exchange');
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' }), context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.runtime.groups.length, 1);
  assert.match(d.runtime.groups[0].text, /^Fw refused the connection: its policy rejected it/);
  assert.ok(!d.blockers.some((b) => /lost on cable/.test(b.text)), 'the earlier loss is no blocker');
  // and a timeout whose last drop covers only one of two attempts: that drop is contributing, the cause not established
  const s2 = new S.Simulation(model(CHAIN));
  s2.runTo(5000);
  let n = 0;
  s2.engine.impair = (l, f) => (l === 'l1' && f.ip && f.ip.l4 && f.ip.l4.proto === 'tcp' && (f.ip.l4.flags || []).indexOf('SYN') >= 0 && n++ === 0 ? { lose: true } : null);
  const r2 = s2.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10' });
  s2.runTo(s2.now + 20000);
  assert.equal(r2.tests[0].ok, true, 'the retransmission is answered');
  const d2 = D.diagnose({ check: C.checkCommunication(model(CHAIN), { from: 'pc', to: 'srv', service: 'tcp/80' }), context: configured, runtime: s2.runEvidence(r2) });
  assert.equal(d2.state, 'recovered');
});

test('a timeout whose drops cover only some attempts: they are contributing, the decisive cause is not established', () => {
  const m = model(CHAIN);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  const t = T0({ pktIds: [1, 2, 3], retx: 2, outcome: { kind: 'timeout', attempts: 3, logFrom: 0 } });
  t.outcome.drops = [DROP(2)];
  const d = D.diagnose({ check: c, context: configured, runtime: rt([t]) });
  assert.equal(d.state, 'failed');
  assert.ok(d.chain.some((l) => l.rel === 'contributing' && /lost on cable l2/.test(l.text)));
  assert.ok(d.chain.some((l) => l.rel === 'hypothesis' && /1 of its 3 attempts has a recorded drop — the records do not establish what decided the outcome/.test(l.text)));
  assert.ok(!d.blockers.some((b) => b.rel === 'cause'));
  // every attempt dropped: established, each attempt named
  const t2 = T0({ pktIds: [1, 2], retx: 1, outcome: { kind: 'timeout', attempts: 2, logFrom: 0 } });
  t2.outcome.drops = [DROP(1), DROP(2, { seq: 43, t: 2200 })];
  const d2 = D.diagnose({ check: c, context: configured, runtime: rt([t2]) });
  assert.equal(d2.state, 'blocked');
  assert.match(d2.blockers[0].text, /each of its 2 attempts was dropped — it was lost on cable l2/);
});

test('identical structured evidence with different words: the same classification', () => {
  const m = model(FWREJ('        - {action: deny, proto: tcp, dport: 80}'));
  const s = new S.Simulation(m);
  s.runTo(5000);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'tcp', port: 80, to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10', count: 2, interval: 1 });
  s.runTo(s.now + 8000);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/80' });
  const ev = s.runEvidence(run);
  const shape = (d) => ({ state: d.state, rt: [d.runtime.completed, d.runtime.outcome, d.runtime.cause], groups: d.runtime.groups.map((g) => [g.rel, g.count, g.refs.map((r) => r.ref).join(',')]), rels: d.chain.map((l) => l.rel) });
  const a = shape(D.diagnose({ check: c, context: configured, runtime: ev }));
  // every word of the records changed: results, drop texts, the log's details
  const reworded = { ...ev, tests: ev.tests.map((t) => ({ ...t, result: 'XYZ ' + t.result.split('').reverse().join(''), outcome: { ...t.outcome, drops: (t.outcome.drops || []).map((x) => ({ ...x, text: 'something else entirely' })), drop: t.outcome.drop ? { ...t.outcome.drop, text: 'other words' } : undefined } })), events: ev.events.map((e) => ({ ...e, detail: 'reworded' })) };
  const b = shape(D.diagnose({ check: c, context: configured, runtime: reworded }));
  assert.deepEqual(b, a);
});

// ------------------------------------------------------------------ neighbour versus route; a later working state

const LAN = `netatlas: 1
title: neighbour
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ip: 10.0.1.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.1.1}]}
  - {id: r1, type: router, interfaces: [{id: a, ip: 10.0.1.1/24}, {id: b, ip: 10.0.2.1/24}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.2.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.0.2.1}]}
links:
  - {id: l1, a: "pc:eth0", b: "r1:a"}
  - {id: l2, a: "r1:b", b: "srv:eth0"}
`;

test('a neighbour that does not answer, with a valid route: said as such — never “no route”', () => {
  const m = model(LAN);
  const s = new S.Simulation(m);
  s.runTo(5000);
  // 10.0.2.99 is in r1's connected network (a route), and nobody has it (no ARP answer)
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', target: '10.0.2.99' });
  s.runTo(s.now + 10000);
  const t = run.tests[0];
  assert.equal(t.ok, false, t.result);
  const drop = (t.outcome.drops || []).find((x) => x.cause && x.cause.kind === 'neighbor');
  assert.ok(drop, JSON.stringify(t.outcome));
  assert.deepEqual([drop.device, drop.cause.neighbor, drop.cause.iface], ['r1', '10.0.2.99', 'b']);
  const c = C.checkCommunication(m, { from: 'pc', to: '10.0.2.99' });
  const k = I.compareRun(m, c, run, s.snapshot());
  const d = D.diagnose({ check: c, context: configured, runtime: { ...s.runEvidence(run), comparison: k } });
  const words = d.blockers.map((b) => b.text).concat(k.lines).join(' | ');
  assert.ok(!/no route|Route not there/.test(words), words);
  assert.ok(/Host Unreachable|could not resolve its next hop 10\.0\.2\.99/.test(words), words);
});

test('no service given: the question says so; an ICMP echo is the prepared send’s proposal, not the question', () => {
  const m = model(LAN);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv' });
  const d = D.diagnose({ check: c, context: configured, canPrepare: true });
  assert.equal(d.question.service, 'none given');
  assert.ok(d.question.unresolved.some((x) => /^Service: none given — a send prepared from this question proposes an ICMP echo \(a test choice, not part of the question\)$/.test(x)));
  const h = I.handoffOf(m, I.commIdentity(m, c));
  assert.ok(h.carried.some((x) => /^Protocol: ICMP \(ping\).* — proposed: the question gives no service$/.test(x)), h.carried.join(' | '));
  // an explicit ICMP question is ICMP
  const d2 = D.diagnose({ check: C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'icmp' }), context: configured, canPrepare: true });
  assert.equal(d2.question.service.split(' ')[0], 'ICMP');
});

// ------------------------------------------------------------------ several causes in one series

test('a series with two different causes and one answer: both causes kept, counted, each with its messages; no single cause', () => {
  const m = model(CHAIN);
  const s = new S.Simulation(m);
  s.runTo(5000);
  // message 2's echo request is lost on l1, message 3's on l2 (the messages are 2 s apart); message 1 is answered
  const t0 = s.now;
  const nth = (f) => (f.ip && f.ip.l4 && f.ip.l4.icmpType === 8 ? Math.floor((s.engine.now - t0 + 500) / 2000) : -1);
  s.engine.impair = (l, f) => {
    const k = nth(f);
    return (k === 1 && l === 'l1') || (k === 2 && l === 'l2') ? { lose: true } : null;
  };
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', to: 'srv', toIface: 'eth0', toAddr: '10.0.2.10', count: 3, interval: 2 });
  s.runTo(s.now + 20000);
  assert.deepEqual(run.tests.map((t) => t.ok), [true, false, false], run.tests.map((t) => t.result).join(' | '));
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pc', to: 'srv' }), context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'partial');
  assert.deepEqual([d.runtime.completed, d.runtime.outcome, d.runtime.cause], [true, 'mixed', 'established']);
  const g = d.runtime.groups;
  assert.equal(g.length, 2, g.map((x) => x.text).join(' | '));
  assert.deepEqual(g.map((x) => [x.rel, x.count, x.messages.map((r) => r.label)]), [['cause', 1, ['message 2']], ['cause', 1, ['message 3']]]);
  assert.match(g[0].text, /lost on cable l1/);
  assert.match(g[1].text, /lost on cable l2/);
  assert.match(d.summary, /1 answered, 2 not completed\. 2 distinct causes, no single one: /);
  // the chain shows each distinct outcome once
  assert.equal(d.chain.filter((l) => /^Message \d/.test(l.text)).length, 3);
});

// ------------------------------------------------------------------ the prerequisite chain: a tunnel down, its keepalives denied

const GRE = `netatlas: 1
title: gre through a firewall
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 198.51.100.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 203.0.113.1}]
    routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}, {prefix: 10.2.0.0/24, via: 172.16.0.2}]
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
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}]
    routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}, {prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l0, a: "h1:eth0", b: "r1:lan"}
  - {id: l1, a: "r1:wan", b: "fw:a"}
  - {id: l2, a: "fw:b", b: "r2:wan"}
  - {id: l3, a: "r2:lan", b: "h2:eth0"}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
`;

test('GRE down because its keepalives’ answers are denied: the send’s tunnel-down drop → the tunnel never up → the denied answers, linked by records', () => {
  const m = model(GRE);
  const s = new S.Simulation(m);
  s.runTo(40000);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Down');
  const run = s.sendPlan({ delivery: 'unicast', from: 'h1', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const t = run.tests[0];
  // (the tunnel down, its subnet's connected route is gone: r1 has no route, and answers Net Unreachable — its drop line the decision)
  assert.deepEqual([t.outcome.kind, t.outcome.by, t.outcome.icmp], ['unreachable', 'r1', 'Net Unreachable']);
  const nr = t.outcome.drops.find((x) => x.seq === t.outcome.event);
  assert.ok(nr && nr.cause.kind === 'no-route' && nr.device === 'r1', JSON.stringify(t.outcome));
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'h1', to: 'h2' }), context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.state, 'blocked');
  const pre = d.chain.find((l) => l.rel === 'prerequisite' && /^gre had not come up at r1/.test(l.text));
  assert.ok(pre, d.chain.map((l) => `[${l.rel}] ${l.text}`).join('\n'));
  const why = d.chain.find((l) => /^It heard nothing because the packets its peer sent to r1 were dropped/.test(l.text));
  assert.ok(why, d.chain.map((l) => `[${l.rel}] ${l.text}`).join('\n'));
  assert.equal(why.rel, 'cause');
  assert.match(why.text, /fw denied it .*no rule matches|fw denied it .*default action/);
  assert.ok(why.refs.some((r) => r.ref === 'policy:fw:default'), why.refs.map((r) => r.ref).join(' '));
  // and a later session state that came up does not explain the earlier send: nothing is said of "learned after"
  assert.ok(!d.chain.some((l) => /learned after/.test(l.text)));
});

test('a session that went down: the recorded transition, then its silence — the peer’s packets dropped in that interval', () => {
  // the firewall first permits both ways (GRE up), then the answers are denied: the keepalive's dead timer takes it down
  const m = model(GRE.replace('        - {action: permit, source: r1, destination: r2}', '        - {action: permit, source: r1, destination: r2}\n        - {action: permit, source: r2, destination: r1}'));
  const s = new S.Simulation(m);
  s.runTo(30000);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Up');
  // from now on r2's packets to r1 are lost on l2 (an impairment, recorded as loss)
  s.engine.impair = (l, f) => (l === 'l2' && f.ip && f.ip.src.bytes[0] === 203 ? { lose: true } : null);
  s.runTo(s.now + 60000);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Down');
  const run = s.sendPlan({ delivery: 'unicast', from: 'h1', kind: 'icmp', target: '10.2.0.10' });
  s.runTo(s.now + 8000);
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'h1', to: 'h2' }), context: configured, runtime: s.runEvidence(run) });
  const down = d.chain.find((l) => l.rel === 'prerequisite' && /^gre went down at t = .* at r1 \(recorded: nothing heard for/.test(l.text));
  assert.ok(down, d.chain.map((l) => `[${l.rel}] ${l.text}`).join('\n'));
  assert.ok(down.refs.some((r) => /^event:\d+:\d+$/.test(r.ref)));
  const why = d.chain.find((l) => /heard nothing because the packets its peer sent to r1 were dropped/.test(l.text) || /Some of the packets its peer sent to r1 were dropped/.test(l.text));
  assert.ok(why, d.chain.map((l) => `[${l.rel}] ${l.text}`).join('\n'));
  assert.match(why.text, /lost on cable l2/);
});

// ------------------------------------------------------------------ an address not acquired: its recorded failure

test('no address: the lease’s recorded failure is the prerequisite, linked by its log line', () => {
  const m = model(`netatlas: 1
title: no dhcp server
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ipv4: dhcp}]}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.0.0.10/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}
links:
  - {id: a, a: "pc:eth0", b: "sw:p1"}
  - {id: b, a: "srv:eth0", b: "sw:p2"}
`);
  const s = new S.Simulation(m);
  s.runTo(500);
  const run = s.sendPlan({ delivery: 'unicast', from: 'pc', kind: 'icmp', to: 'srv', toIface: 'eth0', toAddr: '10.0.0.10' });
  s.runTo(s.now + 120000);
  const t = run.tests[0];
  assert.equal(t.outcome.kind, 'no-address', t.result);
  assert.equal(t.outcome.down, 'pc:eth0');
  const ev = s.events().find((e) => e.seq === t.outcome.event);
  assert.ok(ev && ev.protocol === 'dhcp' && /got no DHCPOFFER/.test(ev.detail), 'the lease failure’s own line');
  const d = D.diagnose({ check: C.checkCommunication(m, { from: 'pc', to: 'srv' }), context: configured, runtime: s.runEvidence(run) });
  assert.equal(d.runtime.groups[0].rel, 'prerequisite');
  assert.ok(d.runtime.groups[0].refs.some((r) => r.ref === `event:${s.exec}:${t.outcome.event}`));
  assert.equal(d.state, 'blocked');
});
