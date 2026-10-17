// A device's lifecycle in the simulation (Engine.powerState,
// Simulation.deviceState): operational, powered off, booting, from the same
// state packet processing reads; the way through a power-on (booting until
// its boot time is over, never earlier, a stale boot never completing a
// later one); a guest down with its host; nothing of an interface, a cable
// or a peer makes a device "off"; an external network or a patch panel has
// no lifecycle of its own (neutral); a new simulation starts with every
// device operational.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const SM = S;
const PS = example('protocol-simulation.yaml');
const sim = (text) => new S.Simulation(model(text));
const st = (s, d) => s.deviceState(d).state;

test('operational, powered off, booting, operational again: the state packet processing has, with its words', () => {
  const s = sim(PS);
  s.runTo(5000);
  assert.deepEqual(s.deviceState('srv'), { state: 'operational', label: 'Operational', detail: 'Operational: powered on and booted (its interfaces, cables and peers have their own state)' });
  assert.ok(s.powerOff('srv'));
  assert.deepEqual(s.deviceState('srv'), { state: 'off', label: 'Powered off', detail: 'Powered off at t = 5 s' });
  assert.equal(s.engine.deviceOn('srv'), false, 'the same state as packet processing');
  s.runTo(7000);
  assert.ok(s.powerOn('srv'));
  // a server boots for 30 s: booting until then, and it takes no part
  const v = s.deviceState('srv');
  assert.equal(v.state, 'booting');
  assert.equal(v.label, 'Booting');
  assert.equal(v.detail, 'Booting: powered on, up at t = 37 s; it takes no part until then');
  assert.equal(s.engine.deviceOn('srv'), false);
  s.runTo(36999);
  assert.equal(st(s, 'srv'), 'booting', 'not before its boot time is over');
  s.runTo(37001);
  assert.equal(st(s, 'srv'), 'operational');
  assert.equal(s.engine.deviceOn('srv'), true);
  // every state in the map, the same words
  const all = s.deviceStates();
  assert.equal(all.size, s.model.devices.length);
  assert.deepEqual(all.get('srv'), s.deviceState('srv'));
});

test('powered off while booting, then on again: the first boot never completes the second (a stale callback)', () => {
  const s = sim(PS);
  s.runTo(5000);
  s.powerOff('srv');
  s.powerOn('srv');
  // up at 35 s, but switched off at 10 s and on at 20 s: up at 50 s, not 35
  s.runTo(10000);
  s.powerOff('srv');
  assert.equal(st(s, 'srv'), 'off');
  s.runTo(20000);
  s.powerOn('srv');
  s.runTo(36000);
  assert.equal(st(s, 'srv'), 'booting', 'still booting after the first boot’s time');
  assert.equal(s.engine.deviceOn('srv'), false);
  s.runTo(50001);
  assert.equal(st(s, 'srv'), 'operational');
});

test('nothing but the device itself: a shut interface, a cable failed, a peer powered off leave a device operational', () => {
  const s = sim(PS);
  s.runTo(5000);
  assert.ok(s.shut('srv', 'eth0'));
  assert.equal(st(s, 'srv'), 'operational', 'an interface shut');
  const cable = s.model.links.find((l) => l.a.device === 'pc1' || l.b.device === 'pc1');
  assert.ok(s.fail('link:' + cable.id));
  assert.equal(st(s, 'pc1'), 'operational', 'its cable failed');
  assert.ok(s.powerOff('r3'));
  assert.equal(st(s, 'r3'), 'off');
  assert.equal(st(s, 'srv'), 'operational', 'its gateway off');
  // the diagram's marks: only r3 is powered off
  const off = Array.from(s.deviceStates()).filter((x) => x[1].state !== 'operational' && x[1].state !== 'external');
  assert.deepEqual(off.map((x) => x[0]), ['r3']);
});

test('an external network has no lifecycle of its own: External, no Power off, unless it was powered off all the same; a patch panel is Passive', () => {
  const s = sim(PS);
  s.runTo(5000);
  assert.deepEqual(s.deviceState('inet'), { state: 'external', label: 'External', detail: 'External: a network outside the model (one hop); it has no power state of its own' });
  assert.equal(SM.hasLifecycle(s.deviceState('inet')), false);
  assert.equal(SM.hasLifecycle(s.deviceState('srv')), true);
  // a device the simulation doesn't have: Unknown, never left out
  assert.deepEqual(SM.deviceStateView(null, 'unknown'), { state: 'unknown', label: 'Unknown', detail: 'Unknown: the simulation has no state for it' });
  assert.equal(SM.deviceStateView(null).label, 'Passive');
  // (the simulation's API still can: then it says so, as packet processing has it)
  s.powerOff('inet');
  assert.equal(st(s, 'inet'), 'off');
});

test('a guest down with its host says so; a new simulation (another model, Exit and start again) starts with every device operational', () => {
  const s = sim(example('virtualization.yaml'));
  s.runTo(5000);
  s.powerOff('hv2');
  assert.equal(st(s, 'hv2'), 'off');
  assert.match(s.deviceState('app1').detail, /^Powered off at t = 5 s \(down with its host hv2\)$/);
  const fresh = sim(example('virtualization.yaml'));
  assert.ok(Array.from(fresh.deviceStates().values()).every((v) => v.state === 'operational' || v.state === 'external' || v.state === 'passive'));
});
