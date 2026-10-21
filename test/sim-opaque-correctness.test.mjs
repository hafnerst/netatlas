// Non-IP route discovery, transfers on their way, retention and the
// interconnects' own traffic (analysis/sim/opaque.ts):
//   - the search admits a hop only when its interconnect's rule allows it, so
//     an invalid alternative (lexically first) never ends the search before a
//     valid one; cycles end; refusals are deterministic;
//   - a failure while a hop is on its way (an interconnect, an attachment, a
//     port, an endpoint or a transit device off) stops that transfer there
//     and then — before departure, mid-hop, on the final hop, between transit
//     hops, at the arrival's own timestamp — and a restore before the hop's
//     end does not revive it; headless and paced runs agree;
//   - what a series keeps is bounded; finished series leave the list; the
//     inspector's rows go with the dots;
//   - `traffic:` of an interconnect runs with the simulation, as the scenario's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, errorsOf } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');
const O = load('analysis/sim/opaque.js');

// a source on bus b1 reaches dst on bus b2 through one of two transit Systems: "asw" (sorted first) only sends on b1,
// so the hop into it is invalid; "zsw" is valid. Optionally a third bus b3 makes a cycle (b1 ↔ b2 ↔ b3 ↔ b1).
const TWO_WAYS = (x = {}) => `netatlas: 1
title: two ways
devices:
  - {id: src, type: system, purpose: host, interfaces: [{id: p, stack: opaque}]}
  - {id: dst, type: endpoint, interfaces: [{id: p, stack: opaque}]}
  - id: asw
    type: system
    purpose: host
    interfaces: [{id: a, stack: opaque}, {id: b, stack: opaque}${x.cycle ? ', {id: c, stack: opaque}' : ''}]
    opaque_transit: [{ports: [a, b${x.cycle ? ', c' : ''}]}]
  - id: zsw
    type: system
    purpose: host
    interfaces: [{id: a, stack: opaque}, {id: b, stack: opaque}${x.cycle ? ', {id: c, stack: opaque}' : ''}]
    opaque_transit: [{ports: [a, b${x.cycle ? ', c' : ''}]}]
interconnects:
  - id: b1
    topology: shared
    technology: {name: CAN}
    endpoints:
      - {port: "src:p"}
      - {port: "asw:a", data: send}
      - {port: "zsw:a"${x.zbad ? ', data: send' : ''}}
  - id: b2
    topology: shared
    technology: {name: CAN}
    endpoints:
      - {port: "asw:b"}
      - {port: "zsw:b"}
      - {port: "dst:p"}
${x.cycle ? `  - id: b3
    topology: shared
    technology: {name: CAN}
    endpoints:
      - {port: "asw:c"}
      - {port: "zsw:c"}
` : ''}`;

const send = (s, initiator, from, to, extra = {}) => s.actOpaque({ initiator, from, to: Array.isArray(to) ? to : [to], count: 1, interval: 1000, size: 16, ...extra });
const one = (a) => a.opaque.deliveries[0];

test('route: an invalid alternative sorted first is passed over, the valid one later is found (fewest hops, deterministic)', () => {
  const s = new S.Simulation(model(TWO_WAYS()));
  const r = s.opaque.route('src:p', 'dst:p', 'src:p');
  assert.ok(Array.isArray(r), `a way is found: ${r}`);
  assert.deepEqual(r.map((h) => `${h.from.device}:${h.from.port}>${h.to.device}:${h.to.port}`), ['src:p>zsw:a', 'zsw:b>dst:p']);
  s.runTo(2000);
  const a = send(s, 'src:p', 'src:p', 'dst:p');
  s.runTo(s.now + 100);
  assert.deepEqual([one(a).ok, one(a).path], [true, 'src:p → zsw:a → dst:p']);
  // the same answer every time
  for (let i = 0; i < 3; i++) assert.deepEqual(new S.Simulation(model(TWO_WAYS())).opaque.route('src:p', 'dst:p', 'src:p').map((h) => h.to.device), ['zsw', 'dst']);
});

test('route: every alternative invalid — refused with the first refusal, nothing taken; a cycle of transits ends', () => {
  const s = new S.Simulation(model(TWO_WAYS({ zbad: true })));
  const r = s.opaque.route('src:p', 'dst:p', 'src:p');
  assert.equal(typeof r, 'string');
  assert.match(r, /no modelled connection from src:p to dst:p .*refused on the way: asw:a only sends on b1/);
  // a ring of three buses through both transits: found, and the search ends either way
  const c = new S.Simulation(model(TWO_WAYS({ cycle: true })));
  assert.deepEqual(c.opaque.route('src:p', 'dst:p', 'src:p').map((h) => h.to.device), ['zsw', 'dst']);
  const cb = new S.Simulation(model(TWO_WAYS({ cycle: true, zbad: true })));
  assert.equal(typeof cb.opaque.route('src:p', 'dst:p', 'src:p'), 'string');
  // a refusal on the recipient's own hop is the answer (the direct rule), as before
  const ic = new S.Simulation(model(example('interconnects.yaml')));
  assert.equal(ic.opaque.route('ctl:com1', 'gps:com1', 'ctl:com1'), 'ctl:com1 only receives on gps-serial');
});

const IC = () => new S.Simulation(model(example('interconnects.yaml')));
/** run a transfer, doing `act(s)` at scenario time t0 + dt (scheduled in the simulation, so headless and paced agree) */
function during(dt, act, o = {}) {
  const s = o.sim ? o.sim() : IC();
  s.runTo(2000);
  const t0 = s.now;
  if (dt !== null) s.engine.at(t0 + dt, () => act(s));
  const a = send(s, o.initiator || 'payload1:f0', o.from || 'payload1:f0', o.to || 'payload2:f0');
  s.runTo(t0 + 50);
  if (o.after) o.after(s);
  s.runTo(t0 + 100);
  return { s, a, d: one(a) };
}

test('a failure while a hop is on its way stops the transfer there: mid-hop, on the final hop, between transit hops, before departure', () => {
  // the fabric: payload1:f0 → fsw:f1 (fab1), fsw:f2 → payload2:f0 (fab2); each hop takes OPAQUE_HOP_MS
  const H = O.OPAQUE_HOP_MS;
  const mid1 = during(H / 2, (s) => s.actOpaqueFail('interconnect', 'fab1'));
  assert.equal(mid1.d.ok, false);
  assert.match(mid1.d.why, /stopped on its way \(payload1:f0 → fsw:f1\): the interconnect fab1 is failed/);
  const last = during(H + H / 2, (s) => s.actOpaqueFail('interconnect', 'fab2'));
  assert.equal(last.d.ok, false, 'the final hop does not succeed');
  assert.match(last.d.why, /stopped on its way \(fsw:f2 → payload2:f0\)/);
  const transit = during(H / 2, (s) => s.powerOff('fsw'));
  assert.match(transit.d.why, /fsw is powered off/);
  const endpoint = during(H + H / 4, (s) => s.powerOff('payload2'));
  assert.match(endpoint.d.why, /stopped on its way \(fsw:f2 → payload2:f0\): payload2 is powered off/);
  const port = during(H / 2, (s) => s.actOpaqueFail('port', 'fsw:f1'));
  assert.match(port.d.why, /fsw:f1 is shut/);
  const before = during(0, (s) => s.actOpaqueFail('interconnect', 'fab1'));
  assert.match(before.d.why, /stopped at payload1:f0: the interconnect fab1 is failed/, 'scheduled before it: it never leaves');
  // nothing goes on downstream of a stopped transfer: no dot on fab2
  assert.ok(!mid1.s.engine.flights.some((f) => f.track.ref === 'interconnect:fab2' && !f.hidden));
  // its dot is lost where it was (the presentation's hold goes with it)
  const lost = mid1.s.engine.flights.filter((f) => f.track.ref === 'interconnect:fab1');
  assert.ok(lost.length && lost.every((f) => f.dropped !== undefined || f.hidden));
});

test('a restore before the hop would have arrived does not revive it; the next transfer goes again', () => {
  const H = O.OPAQUE_HOP_MS;
  const r = during(H * 0.3, (s) => {
    const f = s.actOpaqueFail('interconnect', 'fab1');
    s.engine.at(s.now + H * 0.3, () => s.actionControl(f.id, 'restore'));
  });
  assert.equal(r.d.ok, false);
  assert.ok(!r.s.opaque.failed.has('fab1'), 'restored meanwhile');
  const again = send(r.s, 'payload1:f0', 'payload1:f0', 'payload2:f0');
  r.s.runTo(r.s.now + 100);
  assert.equal(one(again).ok, true);
});

test('equal timestamps: a failure at the arrival’s own time stops it when it comes first in the order of events, not when it comes after', () => {
  const H = O.OPAQUE_HOP_MS;
  // scheduled before the transfer: at the same time as the first hop's arrival, earlier in the order → the hop is cut
  const first = during(H, (s) => s.actOpaqueFail('interconnect', 'fab1'));
  assert.equal(first.d.ok, false);
  assert.match(first.d.why, /stopped on its way \(payload1:f0 → fsw:f1\)/);
  const dot = first.s.engine.flights.find((f) => f.track.ref === 'interconnect:fab1');
  assert.equal(dot.dropped, dot.t1, 'lost at its end, its delivery never processed');
  // scheduled after the arrival at the same time (from within the transfer's own moment): the hop arrived, the next one stops
  const s = IC();
  s.runTo(2000);
  const a = send(s, 'payload1:f0', 'payload1:f0', 'payload2:f0');
  s.runTo(s.now + 0.0001);
  s.engine.at(s.now + H - 0.0001, () => s.engine.at(s.now, () => s.actOpaqueFail('interconnect', 'fab1')));
  s.runTo(s.now + 100);
  assert.equal(one(a).ok, true, 'fab1 failed after its hop arrived: fab2 is fine');
});

test('attachment-only versus a whole bus: a recipient detached mid-hop stops its own transfer, the other recipient’s goes on; the bus failed stops both', () => {
  const H = O.OPAQUE_HOP_MS;
  const opt = { initiator: 'ecu1:can0', from: 'ecu1:can0', to: ['ecu2:can0', 'logger:can0'] };
  const det = during(H * 0.75, (s) => s.actOpaqueFail('attachment', 'ecu2:can0'), opt);
  assert.deepEqual(det.a.opaque.deliveries.map((d) => [d.to, d.ok]), [['ecu2:can0', false], ['logger:can0', true]]);
  // its first half (up the sender's tap) had arrived; the second half is lost where it was
  const halves = det.s.engine.flights.filter((f) => f.track.ref === 'interconnect:can' && (f.track.to === 'ecu2:can0' || f.track.from === 'ecu1:can0'));
  assert.ok(halves.some((f) => f.track.to === 'ecu2:can0' && f.dropped !== undefined));
  const bus = during(H * 0.25, (s) => s.actOpaqueFail('interconnect', 'can'), opt);
  assert.deepEqual(bus.a.opaque.deliveries.map((d) => d.ok), [false, false]);
  // cut during the first half: the second half is never drawn
  assert.ok(bus.s.engine.flights.filter((f) => f.track.ref === 'interconnect:can' && f.track.from === 'bus').every((f) => f.hidden));
});

test('headless and paced runs of the same failures at the same scenario times: the same transfers, reasons and times', () => {
  const H = O.OPAQUE_HOP_MS;
  const run = (paced) => {
    const s = IC();
    const pacer = paced ? new P.Pacer({ engine: s.engine, shown: () => true, typical: () => s.engine.hopTime(), headers: (f) => f.hdr }, 8) : null;
    s.runTo(2000);
    const t0 = s.now;
    s.engine.at(t0 + H / 2, () => s.actOpaqueFail('interconnect', 'fab1'));
    s.engine.at(t0 + 900 + H / 2, () => s.actOpaqueFail('attachment', 'ecu2:can0'));
    s.engine.at(t0 + 1500, () => s.actionControl(s.actions().find((v) => v.title === 'Non-IP failure' && /fab1/.test(v.target)).id, 'restore'));
    send(s, 'payload1:f0', 'payload1:f0', 'payload2:f0', { count: 3, interval: 800 });
    send(s, 'ecu1:can0', 'ecu1:can0', ['ecu2:can0', 'logger:can0'], { count: 2, interval: 900 });
    if (pacer) for (let i = 0; i < 3000 && s.now < t0 + 4000; i++) pacer.frame(16);
    s.runTo(t0 + 4000);
    return s.events().filter((e) => e.protocol === 'opaque').map((e) => `${e.t.toFixed(3)} ${e.kind} ${e.detail}`);
  };
  const headless = run(false);
  assert.ok(headless.some((x) => /stops on its way/.test(x)));
  assert.deepEqual(run(true), headless);
});

test('retention: a long series keeps what is on its way and its last transfers (its counts all of them); finished series leave the list; the inspector rows go with the dots', () => {
  const s = IC();
  s.runTo(2000);
  const a = send(s, 'ctl:usb0', 'ctl:usb0', 'scope:usb0', { count: 400, interval: 100 });
  assert.equal(s.opaque.runs.length, 1);
  s.runTo(s.now + 400 * 100 + 1000);
  const r = a.opaque;
  assert.equal(r.delivered, 400);
  assert.ok(r.deliveries.length <= 2 * O.OPAQUE_KEEP, `kept ${r.deliveries.length}`);
  assert.equal(r.deliveries[r.deliveries.length - 1].n, 399, 'the latest are the ones kept');
  assert.equal(s.opaque.runs.length, 0, 'finished: only its Network event keeps it');
  const v = s.actions().find((x) => x.id === a.id);
  assert.deepEqual([v.status, v.outcome.ok, v.progress.done, v.progress.total], ['completed', 400, 400, 400]);
  // the dots carry their rows; the engine's retention prunes old flights, and the rows with them (nothing else holds them)
  const kept = s.engine.flights.filter((f) => f.protocol === 'opaque');
  assert.ok(kept.length < 400 && kept.every((f) => f.illustrative && f.illustrative.notice === O.OPAQUE_NOTICE));
  assert.equal(s.opaque.info, undefined, 'no table of rows beside the flights');
  // clearing finished events lets the series go
  assert.ok(s.clearFinished() >= 1);
  assert.ok(!s.actions().some((x) => x.id === a.id));
  // a stopped series leaves the list too
  const b = send(s, 'ctl:usb0', 'ctl:usb0', 'scope:usb0', { count: 50, interval: 100 });
  s.runTo(s.now + 250);
  s.actionControl(b.id, 'stop');
  s.runTo(s.now + 100);
  assert.equal(s.opaque.runs.length, 0);
});

const TRAFFIC = `netatlas: 1
title: traffic
devices:
  - {id: ctl, type: system, purpose: host, interfaces: [{id: usb0, stack: opaque}, {id: rs485, stack: opaque}]}
  - {id: scope, type: endpoint, interfaces: [{id: usb0, stack: opaque}]}
  - {id: m1, type: endpoint, interfaces: [{id: rs485, stack: opaque}]}
  - {id: m2, type: endpoint, interfaces: [{id: rs485, stack: opaque}]}
interconnects:
  - id: usb
    topology: point_to_point
    technology: {name: USB, version: "2.0"}
    access: controller_target
    endpoints: [{port: "ctl:usb0", role: controller}, {port: "scope:usb0", role: target}]
    traffic:
      - {initiator: "ctl:usb0", from: "scope:usb0", to: "ctl:usb0", interval: 2s, size: 512}
  - id: bus
    topology: shared
    technology: {name: RS-485}
    access: controller_target
    endpoints: [{port: "ctl:rs485", role: controller}, {port: "m1:rs485", role: target}, {port: "m2:rs485", role: target}]
    traffic:
      - {initiator: "ctl:rs485", to: ["m1:rs485", "m2:rs485"], interval: 1s, count: 3, size: 0}
`;

test('traffic: an interconnect’s own illustrative data runs with the simulation — every interval, its count or until the end; the background, no Network event; bounded', () => {
  const s = new S.Simulation(model(TRAFFIC));
  s.runTo(60000);
  const ev = s.events().filter((e) => e.protocol === 'opaque' && /reached/.test(e.detail));
  const usb = ev.filter((e) => /reached ctl:usb0/.test(e.detail));
  assert.ok(usb.length >= 28 && usb.length <= 29, `a read every 2 s from 3 s on: ${usb.length}`);
  assert.equal(ev.filter((e) => /reached m[12]:rs485/.test(e.detail)).length, 6, 'three writes to two meters');
  assert.ok(ev.every((e) => e.test === undefined), 'the scenario’s: no Network event id');
  assert.equal(s.actions().length, 0, 'not in Active events');
  assert.ok(s.engine.flights.filter((f) => f.protocol === 'opaque').every((f) => f.test === undefined && f.illustrative.rows.some(([k, v]) => k === 'Started by' && /the model \((usb|bus)\.traffic\[0\]\)/.test(v))));
  // size 0 is a size (no default for it)
  assert.ok(s.engine.flights.some((f) => f.label === 'RS-485 data · 0 B'));
  // one series still running (the reads), the counted one finished and gone
  assert.equal(s.opaque.runs.length, 1);
  s.runTo(600000);
  assert.ok(s.opaque.runs[0].deliveries.length <= 2 * O.OPAQUE_KEEP);
  // its dots are a flow: drawn every time, never the steady state, never waited for
  const p = new P.Pacer({ engine: s.engine, shown: () => true, typical: () => s.engine.hopTime(), headers: (f) => f.hdr }, 48);
  for (let i = 0; i < 600; i++) p.frame(16);
  const its = p.items.filter((it) => it.f.protocol === 'opaque');
  assert.ok(its.length > 0 && its.every((it) => it.drawn && !it.gate));
});

test('traffic: validation — its initiator and data source are endpoints of its own interconnect, its recipients opaque ports, an interval', () => {
  const bad = (t) => errorsOf(TRAFFIC.replace('{initiator: "ctl:usb0", from: "scope:usb0", to: "ctl:usb0", interval: 2s, size: 512}', t)).map((e) => e.message);
  assert.match(bad('{initiator: "m1:rs485", to: "ctl:usb0", interval: 2s}').join('\n'), /"m1:rs485" is not an endpoint of interconnect "usb"/);
  assert.match(bad('{initiator: "ctl:usb0", to: "ctl:eth9", interval: 2s}').join('\n'), /"ctl:eth9" is no opaque port of the model/);
  assert.match(bad('{initiator: "ctl:usb0", to: "scope:usb0"}').join('\n'), /missing required key "interval"/);
  assert.match(bad('{initiator: "ctl:usb0", to: "ctl:usb0", interval: 2s}').join('\n'), /"ctl:usb0" is the data source itself/);
  assert.match(bad('{initiator: "ctl:usb0", to: "scope:usb0", interval: 2s, rate: 9}').join('\n'), /unknown key "rate"/);
  assert.deepEqual(errorsOf(TRAFFIC), []);
});

test('vme-rack.yaml: a reference for a mixed architecture — every interconnect configuration, each carrying data with the simulation, the IP side its applications, nothing refused', () => {
  const m = model(example('vme-rack.yaml'));
  const ics = new Map(m.interconnects.map((ic) => [ic.id, ic]));
  const has = (pred, what) => assert.ok(m.interconnects.some(pred), what);
  has((ic) => ic.topology === 'shared' && ic.access === 'controller_target' && ic.endpoints.some((e) => e.systemController) && ic.endpoints.filter((e) => e.role === 'controller_target').length >= 2, 'a backplane: several controller-and-target cards, a system controller');
  has((ic) => ic.topology === 'shared' && ic.access === 'controller_target' && ic.endpoints.some((e) => e.role === 'monitor'), 'a command/response bus with a monitor');
  has((ic) => ic.topology === 'shared' && ic.access === 'peer' && ic.endpoints.some((e) => e.data === 'receive') && !!ic.protocol, 'a bus of peers with a receive-only node and its protocol');
  has((ic) => ic.topology === 'point_to_point' && ic.access === 'peer' && ic.endpoints.every((e) => e.data === 'both'), 'a serial line both ways');
  has((ic) => ic.topology === 'point_to_point' && ic.endpoints.some((e) => e.data === 'send') && ic.endpoints.some((e) => e.data === 'receive') && !!ic.protocol, 'a serial line one way, with its protocol');
  has((ic) => ic.topology === 'point_to_point' && ic.access === 'controller_target' && /USB/.test(ic.technology.name), 'USB: a host and a device');
  const fsw = m.index.devices.get('fsw');
  assert.ok(fsw.opaqueTransit.length === 1 && fsw.opaqueTransit[0].ports.length === 3 && fsw.opaquePorts.some((p) => fsw.opaqueTransit[0].ports.indexOf(p.id) < 0), 'an overlay fabric through a switch card: an explicit transit group, a port outside it');
  assert.ok(m.devices.some((d) => d.opaquePorts.length && d.interfaces.some((i) => i.addresses.length)), 'opaque ports beside IP interfaces on one board');
  // the simulation: every interconnect with traffic carries it, every transfer delivered; the applications answered
  const s = new S.Simulation(m);
  const reached = new Set();
  const e = s.engine;
  const fl = e.flight.bind(e);
  e.flight = (...a) => {
    const x = fl(...a);
    if (x.protocol === 'opaque') reached.add(x.track.ref.slice('interconnect:'.length));
    return x;
  };
  s.runTo(60000);
  const withTraffic = m.interconnects.filter((ic) => ic.traffic.length).map((ic) => ic.id);
  assert.ok(withTraffic.length >= 9);
  for (const id of withTraffic) assert.ok(reached.has(id), `${id} carries data`);
  // the fabric's transit: the lanes without traffic of their own are crossed through the switch card
  assert.ok(reached.has('fab-cpu1') && ics.get('fab-cpu1').traffic.length === 0);
  const opaque = s.events().filter((x) => x.protocol === 'opaque');
  assert.ok(opaque.some((x) => /reached cpu1:p0: delivered along the modelled connection \(adc:p0 → fsw:f3 → cpu1:p0\)/.test(x.detail)), 'through the switch card');
  assert.deepEqual(opaque.filter((x) => x.kind === 'drop').map((x) => x.detail), [], 'nothing refused or stopped');
  const apps = s.apps.runs.map((r) => [r.dev + '/' + r.app.id, r.tests.length > 0 && r.tests.every((t) => t.ok)]);
  assert.deepEqual(apps.sort(), [['cpu1/syslog', true], ['cpu2/syslog', true], ['ews/console', true], ['ews/poll', true]]);
  assert.ok(s.events().some((x) => x.protocol === 'tcp' && x.kind === 'message'), 'real TCP traffic, not only ARP');
  // the setup's list offers the non-IP data like a protocol (shown or hidden)
  const entry = S.protocolEntriesOf(m).find((x) => x.id === 'opaque');
  assert.deepEqual([entry.label, entry.group, entry.uses, entry.unit, entry.support.level], ['Non-IP data', 'Traffic', m.interconnects.length, 'interconnect', 'configured']);
  assert.equal(S.protocolEntriesOf(model(example('private-house.yaml'))).some((x) => x.id === 'opaque'), false, 'only where there are interconnects');
});
