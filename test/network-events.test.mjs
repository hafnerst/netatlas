// Network events as operations (analysis/sim/actions.ts): every send, join,
// stream, shut and flapping is one event with a stable id, its state read
// from the simulation (queued, in progress, completed, failed, stopped,
// cancelled), its progress and outcome; a series is one event; a pending
// message is never a failure; a broadcast without an answer is unknown, not
// a failure; a command that leaves a state (shut, join) completes and shows
// that state with its way back; finished events stay, up to a limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, withClock } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const A = load('analysis/sim/actions.js');

/** (with a fake real clock: a stream of Network events sends on real time; `s.play(ms)` moves both on) */
const sim = (text, opts) => withClock(new S.Simulation(model(text), opts));
const view = (s, id) => s.actions().find((v) => v.id === id);

/** One LAN: a multicast router (the querier), a switch, h1 a member of 239.2.2.2, h2 and h3 not. */
const MC = (q = true) => `netatlas: 1
title: lan
devices:
${q ? '  - {id: q1, type: router, protocols: {pim: {}}, interfaces: [{id: g0, ip: 10.5.0.1/24}]}\n' : '  - {id: q1, type: server, interfaces: [{id: g0, ip: 10.5.0.1/24}]}\n'}  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}, {id: p5, vlans: 1}]}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.11/24, multicast: {join: [239.2.2.2]}}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.12/24}]}
  - {id: h3, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.13/24}]}
links:
  - {id: l1, a: "q1:g0", b: "sw:p1"}
  - {id: l3, a: "h1:eth0", b: "sw:p3"}
  - {id: l4, a: "h2:eth0", b: "sw:p4"}
  - {id: l5, a: "h3:eth0", b: "sw:p5"}
`;

test('every operation is one event with a stable id; one refused by the simulation is a failed event with the reason', () => {
  const s = sim(MC());
  s.runTo(5000);
  const ids = [
    s.actSend({ delivery: 'unicast', from: 'h3', to: 'h1', toIface: 'eth0', toAddr: '10.5.0.11', kind: 'icmp' }).id,
    s.actJoin('h2', 'eth0', '239.2.2.2', []).id,
    s.actStream('h3', 'eth0', '239.2.2.2', 5004, 1000, 1316).id,
    s.actShut('h2', 'eth0').id,
    s.actFlap('iface:h1:eth0').id,
  ];
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  const v = s.actions();
  assert.deepEqual(v.map((x) => [x.id, x.kind, x.title]), [[5, 'flap', 'Flapping'], [4, 'shut', 'Shut interface'], [3, 'stream', 'Multicast stream'], [2, 'join', 'Join multicast group'], [1, 'send', 'Send network packets']]);
  assert.deepEqual(v.map((x) => x.target), ['h1:eth0', 'h2:eth0', 'h3:eth0 → 239.2.2.2:5004', 'h2:eth0 → 239.2.2.2', 'h3 → h1 ICMP echo']);
  // the same ids later
  s.runTo(s.now + 3000);
  assert.deepEqual(s.actions().map((x) => x.id), [5, 4, 3, 2, 1]);
  // refused: listed, failed, with the simulation's reason; nothing started
  const bad = s.actJoin('h2', 'eth0', '224.0.0.5', []);
  assert.equal(view(s, bad.id).status, 'failed');
  assert.equal(view(s, bad.id).summary, '224.0.0.5 is a link-local group: it is never joined');
  assert.equal(view(s, s.actShut('h2', 'eth0').id).summary, 'h2:eth0 is shut already');
  assert.equal(view(s, s.actFlap('iface:h1:eth0').id).summary, 'h1:eth0 is flapping already');
  assert.equal(view(s, s.actSend({ delivery: 'unicast', from: 'sw', to: 'h1', toIface: 'eth0', toAddr: '10.5.0.11', kind: 'icmp' }).id).status, 'failed');
  // a send by the older programmatic way is an event too
  const t = s.sendTest({ from: 'h1', to: 'h3', kind: 'icmp' });
  assert.ok(s.actions().some((x) => x.kind === 'send' && x.tests[0] === t.id));
});

test('a series is one event: its progress (sent of requested), its outcome counts; a pending message is no failure; the success rate of those finished', () => {
  const s = sim(MC());
  s.runTo(5000);
  const a = s.actSend({ delivery: 'unicast', from: 'h3', to: 'h1', toIface: 'eth0', toAddr: '10.5.0.11', kind: 'icmp', count: 20, interval: 0.5 });
  s.runTo(a.run.t0 + 2200);
  let v = view(s, a.id);
  assert.equal(s.actions().filter((x) => x.kind === 'send').length, 1, 'one event for 20 messages');
  assert.equal(v.status, 'running');
  assert.deepEqual(v.progress, { done: 5, total: 20, unit: 'sent' });
  assert.equal(v.outcome.failed, 0, 'pending messages are not failures');
  assert.equal(v.outcome.ok + v.outcome.pending, 5);
  assert.equal(v.outcome.rate, true);
  assert.match(v.outcome.basis, /answered/);
  assert.deepEqual(v.controls, [{ op: 'stop', label: 'Stop' }]);
  s.runTo(a.run.t0 + 15000);
  v = view(s, a.id);
  assert.equal(v.status, 'completed');
  assert.deepEqual([v.outcome.ok, v.outcome.failed, v.outcome.pending], [20, 0, 0]);
  assert.equal(v.ended, a.run.tests[19].ended);
  assert.deepEqual(v.controls, []);
  assert.equal(v.tests.length, 20);
  // completed with failures is still completed: success is the outcome, not the state (a closed UDP port: an ICMP error back)
  const lost = s.actSend({ delivery: 'unicast', from: 'h3', to: 'h1', toIface: 'eth0', toAddr: '10.5.0.11', kind: 'udp', port: 9, count: 2, interval: 1 });
  s.runTo(s.now + 9000);
  v = view(s, lost.id);
  assert.equal(v.status, 'completed');
  assert.deepEqual([v.outcome.ok, v.outcome.failed], [0, 2]);
});

test('a broadcast has no success rate: an answer is a receipt, no answer is unknown (not a failure); a group counts its members apart from the messages', () => {
  const s = sim(MC());
  s.runTo(5000);
  const b = s.actSend({ delivery: 'broadcast', from: 'h3', scope: 'subnet', kind: 'icmp', count: 2, interval: 1 });
  s.runTo(s.now + 8000);
  let v = view(s, b.id);
  assert.equal(v.outcome.rate, false);
  assert.deepEqual([v.outcome.ok, v.outcome.failed, v.outcome.unknown], [0, 0, 2]);
  assert.match(v.summary, /2 unanswered \(receipt unknown\)/);
  assert.match(v.outcome.basis, /^No success rate/);
  // a group: per message received or not; the members over all messages apart
  const m = s.actSend({ delivery: 'multicast', from: 'h3', group: '239.2.2.2', kind: 'udp', port: 5004, count: 3, interval: 1 });
  s.runTo(s.now + 9000);
  v = view(s, m.id);
  assert.deepEqual([v.outcome.ok, v.outcome.failed, v.progress.done, v.progress.total], [3, 0, 3, 3]);
  assert.match(v.summary, /^3 received · received by h1$/);
  assert.ok(v.details.some((d) => /^Counts are of the messages sent from the source/.test(d)));
});

test('queued until anything leaves: a DHCP client’s send waits for its lease, then runs and completes; Stop while queued cancels it (nothing sent later)', () => {
  const s = sim(example('private-house.yaml'), { params: {} });
  const a = s.actSend({ delivery: 'unicast', from: 'laptop', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'icmp' });
  assert.equal(view(s, a.id).status, 'queued');
  s.runTo(9000);
  const v = view(s, a.id);
  assert.ok(v.status === 'completed' || v.status === 'running', v.status);
  s.runTo(15000);
  assert.equal(view(s, a.id).status, 'completed');
  // Stop before anything was sent: cancelled, and no message later
  const h = sim(example('private-house.yaml'), { params: {} });
  const q = h.actSend({ delivery: 'unicast', from: 'laptop', to: 'nas', toIface: 'eth0', toAddr: '192.168.10.20', kind: 'icmp', count: 5, interval: 1 });
  assert.equal(view(h, q.id).status, 'queued');
  assert.equal(h.actionControl(q.id, 'stop'), true);
  h.runTo(20000);
  const c = view(h, q.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.outcome.cancelled, 1);
  assert.equal(q.run.tests.length, 1);
  assert.ok(!h.events().some((e) => e.test === q.run.tests[0].id && e.kind === 'message'), 'nothing of it on the wire');
});

test('a join completes when a multicast router records it, and its membership stays (Leave group); without a router it completes after its reports', () => {
  const s = sim(MC());
  s.runTo(5000);
  const a = s.actJoin('h2', 'eth0', '239.2.2.2', []);
  let v = view(s, a.id);
  assert.equal(v.status, 'running', 'the report is on its way: not completed on submission');
  s.runTo(s.now + 200);
  v = view(s, a.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.summary, 'membership recorded by q1:g0');
  assert.ok(v.ended > a.at && v.ended < a.at + 200);
  assert.equal(v.state, 'member of 239.2.2.2');
  assert.deepEqual(v.controls, [{ op: 'leave', label: 'Leave group' }]);
  // a long time later: still completed (the membership is a state, not the operation)
  s.runTo(s.now + 120000);
  assert.equal(view(s, a.id).status, 'completed');
  assert.equal(s.actionControl(a.id, 'leave'), true);
  v = view(s, a.id);
  assert.match(v.state, /^not a member \(left at t = /);
  assert.deepEqual(v.controls, []);
  // no multicast router on the segment: completed once its unsolicited reports are sent (IGMPv3: 1 s apart), saying so
  const n = sim(MC(false));
  n.runTo(5000);
  const j = n.actJoin('h2', 'eth0', '239.2.2.2', []);
  n.runTo(n.now + 500);
  assert.equal(view(n, j.id).status, 'running');
  n.runTo(n.now + 3000);
  v = view(n, j.id);
  assert.equal(v.status, 'completed');
  assert.equal(v.summary, 'no multicast router recorded it: a member on its own segment only');
});

test('a stream runs until Stop stream: datagrams generated and those received per member counted apart; stopped, it sends no more', () => {
  const s = sim(MC());
  s.runTo(5000);
  const a = s.actStream('h3', 'eth0', '239.2.2.2', 5004, 1000, 1316);
  s.play(5500);
  let v = view(s, a.id);
  assert.equal(v.status, 'running');
  assert.deepEqual(v.progress, { done: 6, total: null, unit: 'datagrams sent' });
  assert.match(v.summary, /^6 datagrams sent, every 1 s of simulated time · received by h1 \(6\)$/);
  assert.equal(a.stream.rx.has('h2'), false, 'not a member: nothing counted');
  assert.equal(s.actionControl(a.id, 'stop'), true);
  const sent = a.stream.sent;
  s.play(5000);
  v = view(s, a.id);
  assert.equal(v.status, 'stopped');
  assert.equal(a.stream.sent, sent);
  assert.deepEqual(v.controls, []);
  assert.equal(s.actionControl(a.id, 'stop'), false);
});

test('Shut interface completes at once and shows the interface down, with No shut; flapping runs its cycles, or stops', () => {
  const s = sim(MC());
  s.runTo(5000);
  const a = s.actShut('h2', 'eth0');
  let v = view(s, a.id);
  assert.deepEqual([v.status, v.state, v.ended], ['completed', 'interface down (shut)', a.at]);
  assert.deepEqual(v.controls, [{ op: 'noshut', label: 'No shut' }]);
  // the list doesn't show the shut twice: the event stands for it
  assert.ok(!s.otherEvents().some((e) => e.kind === 'shut'));
  s.runTo(s.now + 60000);
  assert.equal(view(s, a.id).status, 'completed', 'never "in progress" while it stays down');
  assert.equal(s.actionControl(a.id, 'noshut'), true);
  v = view(s, a.id);
  assert.match(v.state, /^interface up again \(no shut at t = 65 s\)$/);
  // flapping: down 5 s, up 10 s, 3 cycles (the defaults)
  const f = s.actFlap('iface:h3:eth0');
  s.runTo(s.now + 1000);
  v = view(s, f.id);
  assert.equal(v.status, 'running');
  assert.deepEqual(v.progress, { done: 0, total: 3, unit: 'cycles' });
  assert.equal(v.summary, 'now down · cycle 1 of 3');
  s.runTo(f.at + 36000);
  v = view(s, f.id);
  assert.equal(v.status, 'completed');
  assert.deepEqual(v.progress, { done: 3, total: 3, unit: 'cycles' });
  assert.equal(v.ended, f.at + 35000, "down 5, up 10, down 5, up 10, down 5: up again at 35 s");
  // stopped part way
  const g = s.actFlap('iface:h3:eth0');
  s.runTo(s.now + 7000);
  assert.equal(s.actionControl(g.id, 'stop'), true);
  v = view(s, g.id);
  assert.deepEqual([v.status, v.summary], ['stopped', '1 cycle done'], 'down 5 s, up again: one cycle; stopped at 7 s');
});

test('the other state changes in effect stay in the list (a failed cable, a device off); paused or run in steps, the states are the same', () => {
  const s = sim(MC());
  s.runTo(5000);
  s.fail('link:l4');
  s.powerOff('h3');
  assert.deepEqual(s.otherEvents().map((e) => [e.kind, e.ref]), [['power', 'device:h3'], ['fail', 'link:l4']]);
  const states = (step) => {
    const x = sim(MC());
    x.runTo(5000);
    const ids = [x.actSend({ delivery: 'unicast', from: 'h3', to: 'h1', toIface: 'eth0', toAddr: '10.5.0.11', kind: 'icmp', count: 4, interval: 1 }).id, x.actJoin('h2', 'eth0', '239.2.2.2', []).id, x.actFlap('iface:h1:eth0').id];
    const seen = [];
    for (let t = 5000; t <= 52000; t += step) {
      x.runTo(t);
      if (t % 4000 === 0) seen.push(ids.map((id) => view(x, id).status).join(','));
    }
    return seen;
  };
  assert.deepEqual(states(250), states(1000));
});

test('kept when finished, up to the limit: the oldest finished go first, those in progress stay; Clear finished keeps only those in progress', () => {
  const s = sim(MC());
  s.runTo(5000);
  const stream = s.actStream('h3', 'eth0', '239.2.2.2', 5004, 1000, 1316);
  for (let i = 0; i < A.MAX_ACTIONS + 10; i++) s.actShut('h2', 'eth0'), s.noShut('h2', 'eth0');
  const v = s.actions();
  assert.equal(v.length, A.MAX_ACTIONS);
  assert.ok(v.some((x) => x.id === stream.id), 'in progress: kept');
  assert.equal(v[0].id, A.MAX_ACTIONS + 11, 'the newest first');
  assert.equal(s.clearFinished(), A.MAX_ACTIONS - 1);
  assert.deepEqual(s.actions().map((x) => x.id), [stream.id]);
  // a new simulation (Exit and start again) has none
  assert.deepEqual(sim(MC()).actions(), []);
});

test('the user-facing states and their icons are distinct words, not colours', () => {
  const st = ['queued', 'running', 'completed', 'failed', 'stopped', 'cancelled'];
  assert.deepEqual(st.map((k) => A.STATUS_LABEL[k]), ['Queued', 'In progress', 'Completed', 'Failed', 'Stopped', 'Cancelled']);
  assert.equal(new Set(st.map((k) => A.STATUS_ICON[k])).size, 6);
});
