// Illustrative data on the non-IP interconnects (analysis/sim/opaque.ts):
// abstract transfers along the modelled connections, apart from everything
// IP — no header is made, no protocol of the interconnect simulated. The
// rules a transfer follows (roles, data directions, explicit transit), its
// failures (an interconnect, an attachment, a port, a device) and their
// scope, its lifecycle, and that the display's pacing changes nothing of
// what happens. Asserted by the deliveries, the reasons and the dots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example, travelOf } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const P = load('analysis/sim/pacing.js');

const sim = () => new S.Simulation(model(example('interconnects.yaml')));
/** one transfer, run to its end: its deliveries */
function send(s, initiator, from, to, extra = {}) {
  const a = s.actOpaque({ initiator, from, to: Array.isArray(to) ? to : [to], count: 1, interval: 1000, size: 64, ...extra });
  s.runTo(s.now + (extra.count || 1) * (extra.interval || 1000) + 100);
  return a;
}
const results = (a) => (a.opaque ? a.opaque.deliveries.map((d) => [d.to, d.ok, d.why]) : a.error);

test('USB: the controller’s data reaches the target along the line — dots on the interconnect only, no Ethernet / IP / TCP header, delivered as such', () => {
  const s = sim();
  s.runTo(2000);
  const n = s.engine.flights.length;
  const a = send(s, 'ctl:usb0', 'ctl:usb0', 'scope:usb0');
  assert.deepEqual(results(a), [['scope:usb0', true, 'delivered along the modelled connection']]);
  const fl = s.engine.flights.slice(n).filter((f) => f.protocol === 'opaque');
  assert.equal(fl.length, 1);
  assert.deepEqual([fl[0].view, fl[0].track.ref, fl[0].track.from, fl[0].track.to], ['physical', 'interconnect:scope-usb', 'ctl:usb0', 'scope:usb0']);
  assert.equal(fl[0].hdr, undefined, 'no headers');
  assert.equal(fl[0].illustrative.notice, 'Illustrative traffic — protocol behaviour not simulated.');
  // nothing of it on a cable, nothing answered (bidirectional makes no reply)
  assert.ok(!s.engine.flights.slice(n).some((f) => f.protocol !== 'opaque' && f.test === a.opaque.traffic));
  assert.ok(!fl.some((f) => f.track.from === 'scope:usb0'), 'no automatic reply');
  assert.ok(s.events().some((e) => e.protocol === 'opaque' && /reached scope:usb0: delivered along the modelled connection/.test(e.detail)));
  assert.ok(!s.events().some((e) => e.protocol === 'opaque' && /acknowledged|transaction successful|accepted/i.test(e.detail)));
});

test('direction: a serial line from the GPS to the controller — that way delivered, the reverse refused (the endpoints’ order means nothing)', () => {
  const s = sim();
  s.runTo(2000);
  assert.equal(results(send(s, 'gps:com1', 'gps:com1', 'ctl:com1'))[0][1], true);
  assert.deepEqual(results(send(s, 'ctl:com1', 'ctl:com1', 'gps:com1')), [['gps:com1', false, 'ctl:com1 only receives on gps-serial']]);
});

test('Controller / Target: the controller writes to a target and reads from one (target → controller); a transfer between two targets is refused', () => {
  const s = sim();
  s.runTo(2000);
  assert.equal(results(send(s, 'ctl:rs485', 'ctl:rs485', 'meter1:rs485'))[0][1], true, 'a write');
  assert.equal(results(send(s, 'ctl:rs485', 'meter1:rs485', 'ctl:rs485'))[0][1], true, 'a read: the target’s data, initiated by the controller');
  assert.match(results(send(s, 'ctl:rs485', 'meter1:rs485', 'meter2:rs485'))[0][2], /the controller ctl:rs485 is neither the source nor the recipient/);
  assert.match(results(send(s, 'meter1:rs485', 'meter1:rs485', 'ctl:rs485'))[0][2], /meter1:rs485 is target \(slave\) on meter-bus: only a controller initiates a transfer/);
});

test('VME: two controllers both initiate (no arbitration simulated); targets are not receive-only', () => {
  const s = sim();
  s.runTo(2000);
  for (const c of ['sbc1:vme', 'sbc2:vme']) {
    assert.equal(results(send(s, c, c, 'io1:vme'))[0][1], true, c + ' writes');
    assert.equal(results(send(s, c, 'io1:vme', c))[0][1], true, c + ' reads');
  }
  // at the same moment: both delivered, no contention
  const a = s.actOpaque({ initiator: 'sbc1:vme', from: 'sbc1:vme', to: ['io1:vme'], count: 1, interval: 0, size: 8 });
  const b = s.actOpaque({ initiator: 'sbc2:vme', from: 'sbc2:vme', to: ['io1:vme'], count: 1, interval: 0, size: 8 });
  s.runTo(s.now + 100);
  assert.deepEqual([results(a)[0][1], results(b)[0][1]], [true, true]);
});

test('CAN: a peer’s data reaches the other peer and the monitor; a monitor sends nothing; peers send their own data only', () => {
  const s = sim();
  s.runTo(2000);
  assert.deepEqual(results(send(s, 'ecu1:can0', 'ecu1:can0', ['ecu2:can0', 'logger:can0'])).map((x) => x[1]), [true, true]);
  assert.match(results(send(s, 'logger:can0', 'logger:can0', 'ecu1:can0'))[0][2], /logger:can0 is a monitor on can: it only receives/);
  assert.match(results(send(s, 'ecu1:can0', 'ecu2:can0', 'ecu1:can0'))[0][2], /between peers the sender starts its own transfer/);
  // a bus's dots: up the sender's tap, down the recipient's
  const n = s.engine.flights.length;
  send(s, 'ecu1:can0', 'ecu1:can0', 'ecu2:can0');
  assert.deepEqual(s.engine.flights.slice(n).filter((f) => f.protocol === 'opaque').map((f) => [f.track.from, f.track.to]), [['ecu1:can0', 'bus'], ['bus', 'ecu2:can0']]);
});

test('separate connections stay separate, transit only where written: two RS-232 lines never join; the fabric switch passes SRIO between its group only, never to its console port', () => {
  const s = sim();
  s.runTo(2000);
  assert.match(results(send(s, 'gps:com1', 'gps:com1', 'plc:com1'))[0][2], /no modelled connection from gps:com1 to plc:com1/);
  const via = send(s, 'payload1:f0', 'payload1:f0', 'payload2:f0');
  assert.equal(results(via)[0][1], true);
  assert.equal(via.opaque.deliveries[0].path, 'payload1:f0 → fsw:f1 → payload2:f0');
  assert.match(results(send(s, 'payload1:f0', 'payload1:f0', 'plc:com1'))[0][2], /no modelled connection/);
});

test('failures and their scope: a failed point-to-point link stops what crosses it only; a detached participant alone is cut off; a device off stops its hops; each restored', () => {
  const s = sim();
  s.runTo(2000);
  const f = s.actOpaqueFail('interconnect', 'fab2');
  assert.match(results(send(s, 'payload1:f0', 'payload1:f0', 'payload2:f0'))[0][2], /stopped at fsw:f2: the interconnect fab2 is failed/);
  assert.equal(results(send(s, 'payload1:f0', 'payload1:f0', 'payload3:f0'))[0][1], true, 'the other path of the fabric still works');
  assert.ok(s.actionControl(f.id, 'restore'));
  assert.equal(results(send(s, 'payload1:f0', 'payload1:f0', 'payload2:f0'))[0][1], true);
  // a bus participant detached: the others go on
  const d = s.actOpaqueFail('attachment', 'meter2:rs485');
  assert.match(results(send(s, 'ctl:rs485', 'ctl:rs485', 'meter2:rs485'))[0][2], /meter2:rs485 is detached from meter-bus/);
  assert.equal(results(send(s, 'ctl:rs485', 'ctl:rs485', 'meter1:rs485'))[0][1], true);
  assert.ok(s.actionControl(d.id, 'restore'));
  // a device powered off; a passive interconnect has no power of its own
  assert.ok(s.powerOff('meter1'));
  assert.match(results(send(s, 'ctl:rs485', 'ctl:rs485', 'meter1:rs485'))[0][2], /meter1 is powered off/);
  assert.equal(results(send(s, 'ctl:rs485', 'ctl:rs485', 'meter2:rs485'))[0][1], true);
  // an opaque port shut
  const p = s.actOpaqueFail('port', 'scope:usb0');
  assert.match(results(send(s, 'ctl:usb0', 'ctl:usb0', 'scope:usb0'))[0][2], /scope:usb0 is shut/);
  assert.ok(s.actionControl(p.id, 'restore'));
  assert.equal(results(send(s, 'ctl:usb0', 'ctl:usb0', 'scope:usb0'))[0][1], true);
});

test('lifecycle: a series stopped sends nothing more; a device switched off mid-series stops the rest there; a new simulation has none of it', () => {
  const s = sim();
  s.runTo(2000);
  const a = s.actOpaque({ initiator: 'ctl:usb0', from: 'ctl:usb0', to: ['scope:usb0'], count: 10, interval: 1000, size: 64 });
  s.runTo(s.now + 2500);
  assert.ok(s.actionControl(a.id, 'stop'));
  s.runTo(s.now + 20000);
  assert.equal(a.opaque.sent, 3);
  const v = s.actions().find((x) => x.id === a.id);
  assert.equal(v.status, 'stopped');
  const b = s.actOpaque({ initiator: 'ctl:usb0', from: 'ctl:usb0', to: ['scope:usb0'], count: 4, interval: 1000, size: 64 });
  s.runTo(s.now + 1500);
  s.powerOff('scope');
  s.runTo(s.now + 5000);
  assert.deepEqual(b.opaque.deliveries.map((d) => d.ok), [true, true, false, false]);
  assert.equal(new S.Simulation(model(example('interconnects.yaml'))).opaque.runs.length, 0);
});

test('pacing changes the presentation only: the same transfers, reasons and times with or without the display', () => {
  const run = (paced) => {
    const s = sim();
    const pacer = paced ? new P.Pacer({ engine: s.engine, shown: () => true, travel: travelOf(s.engine), headers: (f) => f.hdr }, 2) : null;
    s.runTo(2000);
    s.actOpaque({ initiator: 'ecu1:can0', from: 'ecu1:can0', to: ['ecu2:can0', 'logger:can0'], count: 3, interval: 700, size: 32 });
    s.actOpaque({ initiator: 'payload1:f0', from: 'payload1:f0', to: ['payload2:f0'], count: 2, interval: 900, size: 32 });
    if (pacer) for (let i = 0; i < 2000; i++) pacer.frame(16);
    else s.runTo(s.now + 5000);
    s.runTo(Math.max(s.now, 7000));
    return s.events().filter((e) => e.protocol === 'opaque').map((e) => `${Math.round(e.t)} ${e.detail}`);
  };
  assert.deepEqual(run(true), run(false));
});
