// Experiments, the second part: the duration control's units (one canonical
// value, conversions that keep the duration), the cold start (devices off,
// then their normal boot; guests after their host; passive and external
// objects untouched; an action waiting for its device, said), the
// observations that read state the simulation keeps (an address acquired, a
// neighbor resolved, a route, a protocol session, a timing state, an MQTT
// delivery, a reception with a minimum), what already held versus what was
// reached, and which traffic is the experiment's — shown while it plays, the
// rest hidden and never holding it back — with the same result shown or not
// (analysis/sim/experiment.ts, relevance.ts, pacing.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, load, root } from './helpers.mjs';

const EX = load('analysis/sim/experiment.js');
const ME = load('model/experiments.js');
const P = load('analysis/sim/pacing.js');
const DI = load('ui/duration-input.js');

const example = (f) => readFileSync(join(root, 'examples', f), 'utf8');
const model = (text) => {
  const r = validate.loadModel(text);
  assert.equal(r.errors.map((e) => `${e.path}: ${e.message}`).join(' | '), '', 'valid');
  return r.model;
};
/** an example with its experiments replaced by these */
const withExp = (file, exp) => model(example(file).replace(/\nexperiments:\n[\s\S]*?(?=\n[a-z_]+:|$)/, '\n') + '\nexperiments:\n' + exp);
const run = (m, id) => new EX.ExperimentRunner(m, m.experiments.find((e) => e.id === id), 'fp').runAll();

test('durations: one canonical value in ms; a unit only shows it, and converting keeps the duration exactly', () => {
  assert.equal(ME.durationIn(60000, 'min'), 1, '60 sec → 1 min');
  assert.equal(ME.durationIn(120000, 'sec'), 120, '2 min → 120 sec');
  assert.equal(ME.durationIn(5400000, 'min'), 90, '1.5 hours → 90 min');
  assert.equal(ME.durationMs('1.5', 'hours'), 5400000);
  assert.equal(ME.durationMs('0.25', 'sec'), 250, 'a fraction');
  assert.equal(ME.durationMs('1,5', 'min'), 90000, 'a decimal comma');
  // no rounding that changes it: 1 s shown in hours and back is 1 s
  assert.equal(ME.durationMs(String(ME.durationIn(1000, 'hours')), 'hours'), 1000);
  for (const bad of ['', 'abc', '-1', '1e3', 'Infinity', '1.2.3']) assert.equal(ME.durationMs(bad, 'sec'), null, bad);
  // the unit shown when none was chosen: the largest whole one
  assert.deepEqual([ME.durationUnit(7200000), ME.durationUnit(90000), ME.durationUnit(120000), ME.durationUnit(1500)], ['hours', 'sec', 'min', 'sec']);
  // written canonically, and read back the same
  assert.deepEqual([ME.durationYaml(7200000), ME.durationYaml(120000), ME.durationYaml(90000), ME.durationYaml(1500), ME.durationYaml(0)], ['2h', '2min', '90s', '1500ms', '0s']);
  // the control's check: nothing invalid or missing is written, the range said
  const spec = { min: 1000, max: 3600000, required: true };
  assert.deepEqual(DI.checkDuration('', 'sec', spec), { ms: null, why: 'Required: enter a number.' });
  assert.match(DI.checkDuration('x', 'sec', spec).why, /Enter a number/);
  assert.match(DI.checkDuration('0.5', 'sec', spec).why, /At least 1 s/);
  assert.match(DI.checkDuration('2', 'hours', spec).why, /At most 1 h/);
  assert.deepEqual(DI.checkDuration('1.5', 'min', spec), { ms: 90000, why: '' });
  assert.deepEqual(DI.checkDuration('', 'sec', { min: 0, max: 10 }), { ms: null, why: '' }, 'an optional field may be emptied');
});

test('the model: start cold, For on actions with a duration, the new fields, the targets scope; what is wrong is an error, what is missing a warning', () => {
  const head = 'netatlas: 1\ntitle: T\ndevices:\n  - {id: h, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.1/24}]}\n  - {id: r, type: router, interfaces: [{id: e0, ip: 10.0.0.254/24}]}\nlinks:\n  - {id: l, a: "h:e0", b: "r:e0"}\nexperiments:\n  - id: e\n    name: E\n    duration: 60s\n';
  const errs = (y) => validate.loadModel(head + y).errors.map((e) => e.message).join(' | ');
  assert.match(errs('    start: warm\n'), /"warm" is no start: booted \(the default\) or cold/);
  assert.match(errs('    start: cold\n    settle: 30s\n'), /a cold start boots at the start: it does not settle first/);
  assert.match(errs('    actions:\n      - {at: 1s, do: power_off, target: h, for: soon}\n'), /"soon" is no duration/);
  assert.match(errs('    observe:\n      - {of: address, target: "h:e0", family: ipx, expect: acquired}\n'), /"ipx" is no address family/);
  assert.match(errs('    observe:\n      - {of: timing, target: h, protocol: ospf, expect: synchronized}\n'), /a timing state is of ptp or ntp/);
  assert.match(errs('    scope: nearby\n'), /"nearby" is no scope/);
  const m = model(head + '    start: cold\n    scope: targets\n    actions:\n      - {at: 1s, do: power_off, target: h, for: 20s}\n    observe:\n      - {of: session, target: r, protocol: ospf, expect: established}\n      - {of: neighbor, target: r, to: h, expect: resolved}\n');
  const e = m.experiments[0];
  assert.deepEqual([e.start, e.scope.kind, e.actions[0].for, e.observations[0].protocol], ['cold', 'targets', 20000, 'ospf']);
  assert.equal(ME.actionText(e.actions[0]), 'At 1 s: Power off h for 20 s');
  // For on an action without a duration: not taken (a warning, never used)
  const w = validate.loadModel(head + '    actions:\n      - {at: 1s, do: power_on, target: h, for: 20s}\n    observe:\n      - {of: device, target: h, expect: on}\n').warnings.map((x) => x.message).join(' | ');
  assert.match(w, /has no for: it is not used/);
  // the targets scope: the steps' devices and their dependencies
  assert.deepEqual(Array.from(EX.experimentScope(m, e).devices).sort(), ['h', 'r']);
  // a required field missing: kept, said, not runnable (never a whole-architecture default)
  const d = validate.loadModel(head + '    observe:\n      - {of: address, expect: acquired}\n');
  assert.equal(d.errors.length, 0);
  assert.ok(d.model.experiments[0].problems.some((p) => /its target is not configured yet/.test(p)));
});

test('cold start: every device with a power lifecycle off, then booting as it normally does; boot time is experiment time; an action waits for its device, said', () => {
  const m = withExp('private-house.yaml', `  - id: c
    name: C
    duration: 2min
    start: cold
    actions:
      - {id: ctl, at: 0s, do: start_app, target: tv/control}
      - {at: 5s, do: power_off, target: laptop}
    observe:
      - {id: off, at: 0s, of: device, target: tv, expect: booting}
      - {id: up, at: 0s, within: 60s, of: device, target: tv, expect: operational}
      - {id: lease, at: 0s, within: 90s, of: address, target: "tv:wlan0", family: ipv4, expect: acquired}
      - {id: msgs, of: app, target: ctl, expect: delivered}
`);
  const r = run(m, 'c');
  const by = new Map(r.observations.map((o) => [o.obs.id, o]));
  assert.equal(r.start, 'cold');
  assert.ok(r.cold.devices >= 10, `${r.cold.devices} devices booted from off`);
  // at the start the TV is booting (never operational at t = 0)
  assert.equal(by.get('off').outcome, 'satisfied', by.get('off').actual);
  assert.equal(by.get('off').held, 'already');
  // operational after its boot time: the evidence's own time
  assert.equal(by.get('up').outcome, 'satisfied');
  assert.equal(by.get('up').held, 'reached');
  assert.ok(by.get('up').at > 0 && by.get('up').at <= 60000, String(by.get('up').at));
  assert.match(by.get('up').actual, /tv is operational — reached at t = \d+\.\d s/);
  // the lease after the boot, at its binding time
  assert.equal(by.get('lease').outcome, 'satisfied');
  assert.ok(by.get('lease').at > by.get('up').at, 'the address after the device is up');
  assert.match(by.get('lease').actual, /^DHCPv4 address acquired · tv:wlan0 · 192\.168\.\d+\.\d+\/24/);
  // the application waited for the TV (said), then was submitted; its messages were delivered
  const ctl = r.actions.find((a) => a.index === 0);
  assert.equal(ctl.state, 'submitted');
  assert.equal(ctl.due, 0);
  assert.equal(ctl.at, by.get('up').at, 'submitted when the TV was up');
  assert.match(ctl.text, /after waiting \d+ s for tv to come up/);
  assert.equal(by.get('msgs').outcome, 'satisfied', by.get('msgs').actual);
  // an action on the power itself never waits
  assert.equal(r.actions.find((a) => a.index === 1).at, 5000);
  // the same run again: the same result (scenario time)
  assert.deepEqual(run(m, 'c').observations.map((o) => [o.outcome, o.at, o.actual]), r.observations.map((o) => [o.outcome, o.at, o.actual]));
  // the saved model is not changed by a cold start
  assert.ok(!m.devices.some((d) => d.simulation && d.simulation.get && d.simulation.get('power') === 'off'));
});

test('cold start: guests after their host; passive and external objects have no lifecycle to start (never powered, a device observation says so)', () => {
  const m = withExp('virtualization.yaml', `  - id: v
    name: V
    duration: 3min
    start: cold
    observe:
      - {id: host, at: 0s, within: 170s, of: device, target: hv1, expect: operational}
      - {id: vm, at: 0s, within: 170s, of: device, target: web1, expect: operational}
      - {id: early, at: 1s, of: device, target: web1, expect: off}
`);
  const r = run(m, 'v');
  const by = new Map(r.observations.map((o) => [o.obs.id, o]));
  assert.ok(r.cold.guests > 0, 'guests went down with their hosts');
  assert.equal(by.get('host').outcome, 'satisfied');
  assert.equal(by.get('vm').outcome, 'satisfied');
  assert.ok(by.get('vm').at > by.get('host').at, `the VM (${by.get('vm').at}) after its host (${by.get('host').at})`);
  assert.match(by.get('early').actual, /web1 is off \(down with its host hv1\)/);
  // an external network: no lifecycle — not powered off, and a device observation can't read one
  const w = withExp('private-house.yaml', `  - id: x
    name: X
    duration: 30s
    start: cold
    observe:
      - {of: device, target: isp, expect: operational}
`);
  const isp = w.devices.find((d) => d.id === 'isp');
  assert.ok(isp, 'the example has its provider');
  const rx = run(w, 'x');
  assert.equal(rx.observations[0].outcome, 'unsupported', rx.observations[0].actual);
  assert.match(rx.observations[0].actual, /has no power lifecycle of its own/);
});

test('observations from state the simulation keeps: neighbor, route, session, timing, MQTT delivery, reception with a minimum; sent is not received', () => {
  const ph = withExp('private-house.yaml', `  - id: s
    name: S
    duration: 60s
    settle: 1min
    actions:
      - {id: st, at: 2s, do: start_stream, target: "thermostat:wlan0", group: 239.20.1.1, interval: 1s, for: 50s}
      - {id: j, at: 5s, do: join, target: "tv:wlan0", group: 239.20.1.1}
      - {at: 30s, do: leave, target: "tv:wlan0", group: 239.20.1.1}
    observe:
      - {id: before, at: 0s, within: 4s, of: receive, target: "tv:wlan0", group: 239.20.1.1, expect: not received}
      - {id: got, at: 1s, after: j, within: 20s, of: receive, target: "tv:wlan0", group: 239.20.1.1, min: 3, expect: received}
      - {id: many, at: 1s, after: j, within: 20s, of: receive, target: "tv:wlan0", group: 239.20.1.1, min: 1000, expect: received}
      - {id: arp, at: 0s, of: neighbor, target: tv, to: "192.168.20.1", expect: resolved}
      - {id: route, at: 0s, of: route, target: tv, to: "203.0.113.80", expect: present}
`);
  const r = run(ph, 's');
  const by = new Map(r.observations.map((o) => [o.obs.id, o]));
  // the stream was sent before the join: sent, not received
  assert.equal(by.get('before').outcome, 'satisfied', by.get('before').actual);
  assert.equal(by.get('got').outcome, 'satisfied', by.get('got').actual);
  assert.match(by.get('got').actual, /^received: \d+ datagrams of 239\.20\.1\.1 at tv:wlan0 within 20 s \(at least 3 expected\)$/);
  assert.equal(by.get('many').outcome, 'violated', 'a minimum not reached is no reception');
  assert.match(by.get('arp').actual, /^neighbor resolved · tv · 192\.168\.20\.1 is at /);
  assert.match(by.get('route').actual, /route available · tv → 203\.0\.113\.80: 0\.0\.0\.0\/0/);
  // the stream's For: stopped after 50 s (logged as undone)
  assert.ok(r.actions.some((a) => a.index === 0 && a.state === 'undone' && a.at === 52000), JSON.stringify(r.actions.map((a) => [a.index, a.state, a.at])));
  // MQTT: what the subscriber received from its broker
  const ot = withExp('ot-network.yaml', `  - id: m
    name: M
    duration: 60s
    settle: 30s
    actions:
      - {id: d, at: 0s, do: start_app, target: hmi/dashboard}
      - {id: t, at: 5s, do: start_app, target: plc/telemetry}
    observe:
      - {id: temps, at: 5s, within: 30s, of: mqtt, target: hmi/dashboard, topic: plant/cell1/plc-1/temperature, min: 2, expect: delivered}
      - {id: alarms, at: 5s, within: 30s, of: mqtt, target: hmi/dashboard, topic: plant/cell1/plc-1/alarm, expect: not delivered}
`);
  const rm = run(ot, 'm');
  const bm = new Map(rm.observations.map((o) => [o.obs.id, o]));
  assert.equal(bm.get('temps').outcome, 'satisfied', bm.get('temps').actual);
  assert.match(bm.get('temps').actual, /^delivered: \d+ publications on plant\/cell1\/plc-1\/temperature received by hmi\/dashboard within 30 s/);
  assert.equal(bm.get('alarms').outcome, 'satisfied', 'nothing published there: not delivered');
  // a session: OSPF over the Munich tunnel
  const wan = withExp('enterprise-wan.yaml', `  - id: o
    name: O
    duration: 2min
    observe:
      - {id: ospf, at: 0s, within: 110s, of: session, target: muc-rtr, protocol: ospf, to: hq-rtr1, expect: established}
`);
  const ro = run(wan, 'o').observations[0];
  assert.equal(ro.outcome, 'satisfied', ro.actual);
  assert.match(ro.actual, /^OSPF session established · /);
  assert.equal(ro.held, 'reached');
  // a timing state: a protocol state, never an accuracy
  const tp = withExp('timing-ptp.yaml', `  - id: t
    name: T
    duration: 2min
    start: cold
    observe:
      - {id: ptp, at: 0s, within: 110s, of: timing, target: plc-b, protocol: ptp, expect: synchronized}
`);
  const rt = run(tp, 't').observations[0];
  assert.equal(rt.outcome, 'satisfied', rt.actual);
  assert.match(rt.actual, /PTP synchronized \(a protocol state: no accuracy is computed or promised\)/);
});

test('which traffic is the experiment’s: its operations, what they cause and need; a host’s other traffic and the rest of the network hidden', () => {
  const m = model(example('private-house.yaml'));
  const e = m.experiments.find((x) => x.id === 'cold-tv');
  const r = new EX.ExperimentRunner(m, e, 'fp');
  r.prepare();
  const eng = r.simulation.engine;
  let ser = eng.flightSerial;
  const seen = [];
  while (!r.over) {
    r.simulation.runTo(Math.min(r.endTime, eng.now + 500));
    for (const f of eng.flightsSince(ser).reverse()) seen.push([f, r.relevance.classify(f)]);
    ser = eng.flightSerial;
  }
  const count = (pred) => seen.filter(pred).length;
  // the TV's application: its operation
  assert.ok(count(([f, c]) => c === 'action' && f.origin === 'tv' && f.protocol === 'tcp') > 0, 'its messages are the action');
  // what the TV needed for it: its DHCP and its address resolution
  assert.ok(count(([f, c]) => c === 'prerequisite' && f.protocol === 'dhcp' && f.origin === 'tv') > 0, 'its DHCP');
  assert.ok(count(([f, c]) => c !== null && f.protocol === 'arp' && f.origin === 'tv') > 0, 'its ARP');
  // the TV's own scenario traffic (its test traffic to the web server and the NAS) is not the experiment's
  assert.equal(count(([f, c]) => c !== null && (f.protocol === 'https' || f.protocol === 'icmp') && f.origin === 'tv'), 0);
  assert.equal(count(([f, c]) => c !== null && f.protocol === 'tcp' && f.origin === 'tv' && f.test === undefined), 0, 'its untagged TCP (the scenario’s) hidden');
  // the other hosts' DHCP, the laptop's traffic: hidden (a connected network is no reason)
  assert.equal(count(([f, c]) => c !== null && (f.origin === 'laptop' || f.origin === 'phone' || f.origin === 'guest-phone')), 0);
  assert.ok(r.relevance.counts.hidden > r.relevance.counts.action + r.relevance.counts.prerequisite, JSON.stringify(r.relevance.counts));
});

test('played with the pacing (only its traffic shown) or run at once: the same result; hidden traffic never holds it, so it needs no more display time than with everything shown', () => {
  const m = model(example('private-house.yaml'));
  const e = m.experiments.find((x) => x.id === 'cold-tv');
  const headless = new EX.ExperimentRunner(m, e, 'fp').runAll();
  const play = (filtered) => {
    const r = new EX.ExperimentRunner(m, e, 'fp');
    r.prepare();
    const pacer = new P.Pacer({ engine: r.simulation.engine, shown: (f) => !filtered || r.relevance.classify(f) !== null, typical: () => 1, until: () => r.endTime }, 48);
    if (filtered) {
      pacer.mute = false;
      pacer.hiddenHoldsNothing = true;
    }
    let frames = 0;
    while (!r.over && frames < 100000) {
      pacer.frame(100);
      frames++;
    }
    assert.ok(r.simulation.now <= r.endTime + 1e-6, 'the clock stops at the end');
    return { res: r.result(), frames };
  };
  const shown = play(true);
  const all = play(false);
  const sig = (x) => JSON.stringify([x.observations.map((o) => [o.index, o.outcome, o.at, o.actual]), x.actions.map((a) => [a.index, a.state, a.at])]);
  assert.equal(sig(shown.res), sig(headless), 'the same verdicts, times and evidence as run at once');
  assert.equal(sig(all.res), sig(headless), 'whatever is shown');
  // (its own traffic is drawn whole — an exchange on screen is never cut in the middle — so it may take as long as everything shown, never longer)
  assert.ok(shown.frames <= all.frames + 1, `only its traffic shown: ${shown.frames} frames; everything shown: ${all.frames}`);
});

test('lifecycle: Stop ends it where it is (what was not reached said, nothing runs on), a new run starts from the defined start; a stopped runner’s events never touch its result', () => {
  const m = model(example('private-house.yaml'));
  const e = m.experiments.find((x) => x.id === 'cold-tv');
  const r = new EX.ExperimentRunner(m, e, 'fp');
  r.prepare();
  r.simulation.runTo(10000);
  r.cancel();
  const snap = JSON.stringify(r.result());
  // its simulation goes on (as a stale timer would): nothing is added to the stopped result
  r.simulation.runTo(120000);
  assert.equal(JSON.stringify(r.result()), snap);
  assert.equal(r.result().state, 'stopped');
  assert.equal(r.result().observations.length, e.observations.length, 'every observation said');
  assert.ok(r.result().observations.every((o) => o.outcome !== 'satisfied' || o.at <= 10000));
  assert.ok(r.result().observations.some((o) => /the run was stopped at t = 10\.0 s/.test(o.actual)));
  // a new run: from the cold start again, its own result
  const again = new EX.ExperimentRunner(m, e, 'fp').runAll();
  assert.equal(again.state, 'done');
  assert.equal(again.summary, '4 observations: 4 satisfied');
});

test('the public examples’ experiments: a cold-start host gets an address and its application exchange succeeds; a receiver joins, receives and leaves; an MQTT subscriber gets the publications', () => {
  const ph = model(example('private-house.yaml'));
  const ot = model(example('ot-network.yaml'));
  const summary = (m, id) => run(m, id).summary;
  assert.equal(summary(ph, 'cold-tv'), '4 observations: 4 satisfied');
  assert.equal(summary(ph, 'tv-stream'), '2 observations: 2 satisfied');
  assert.equal(summary(ot, 'dashboard'), '2 observations: 2 satisfied');
  assert.equal(summary(ot, 'cabinet-outage'), '5 observations: 5 satisfied');
  // tv-stream runs only its targets and their dependencies, and says so
  const sc = EX.experimentScope(ph, ph.experiments.find((x) => x.id === 'tv-stream'));
  assert.ok(sc.devices.has('tv') && sc.devices.has('thermostat') && sc.devices.size < ph.devices.length, Array.from(sc.devices).join(', '));
});
