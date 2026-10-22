// The representative workflows of Analyze, on the public examples (and the
// internal addressing example for VRFs and overlapping addresses): a small
// network (automatic addressing, DNS, a guest-isolation expectation, safe
// static suggestions), an enterprise (VRFs and overlapping addresses,
// dual-stack and multi-interface ends, mixed equal-cost outcomes, explicit
// coverage, a rack and a room failing, a requirement surviving on another
// path) and an OT cell (an HMI to its controller, an MQTT publisher and its
// broker, timing sources, the service impact of an infrastructure device).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const C = load('analysis/communication.js');
const A = load('analysis/addressing.js');
const E = load('analysis/expectations.js');
const W = load('analysis/whatif.js');
const T = load('analysis/trace.js');
const D = load('analysis/dependencies.js');
const F = load('analysis/failure.js');
const S = load('analysis/sim/simulation.js');
const I = load('analysis/ipmath.js');

const model = (name) => {
  const r = validate.loadModel(example(name));
  assert.deepEqual(r.errors.map((e) => e.message), [], name);
  return r.model;
};

test('small network: the guest gets its address automatically, DNS is evaluated, guests are kept out of management, static suggestions stay out of the DHCP pools', () => {
  const m = model('private-house.yaml');
  // configured model: the clients' addresses are runtime facts: indeterminate, never a guess
  const conf = Object.fromEntries(E.evaluateExpectations(m).results.map((r) => [r.id, r.verdict]));
  assert.deepEqual(conf, { 'guest-no-mgmt': 'indeterminate', 'laptop-dns': 'indeterminate', 'laptop-nas': 'indeterminate', 'tv-control': 'indeterminate' });
  // a snapshot: the guest's lease, the laptop's DNS, the policy that blocks the guest
  const sim = new S.Simulation(m, {});
  sim.runTo(30000);
  const snap = sim.snapshot();
  const guest = snap.addresses.find((a) => a.device === 'guest-phone' && a.method === 'dhcpv4');
  assert.ok(guest && /^192\.168\.30\.1\d\d$/.test(guest.text), 'the guest leased an address of its scope');
  const run = Object.fromEntries(E.evaluateExpectations(m, snap).results.map((r) => [r.id, r]));
  assert.equal(run['laptop-dns'].verdict, 'satisfied');
  assert.equal(run['guest-no-mgmt'].verdict, 'satisfied');
  assert.match(run['guest-no-mgmt'].reason, /^Blocked by policy at dsl-router/);
  assert.equal(run['tv-control'].verdict, 'satisfied');
  // the DNS layer itself: the laptop's resolver comes from its DHCP scope
  const web = C.checkCommunication(m, { from: 'laptop', to: 'dsl-router/dns' }, snap);
  assert.equal(web.layers.find((l) => l.id === 'listener').verdict, 'satisfied');
  sim.close();
  // static suggestions: never in a pool
  const ov = A.addressingOverview(m);
  for (const g of ov.vrfs) {
    for (const n of g.networks) {
      if (!n.nextFree) continue;
      const v = I.addrBig(load('model/ip.js').parseAddress(n.nextFree.split('/')[0]));
      for (const p of n.pools) assert.ok(v < p.first || v > p.last, `${n.id}: ${n.nextFree} is in the pool ${p.range}`);
    }
  }
});

test('enterprise: VRFs and an address reused in two of them, dual-stack and multi-interface ends, equal-cost paths, explicit coverage', () => {
  const ad = validate.loadModel(example('addressing.yaml')).model;
  const ov = A.addressingOverview(ad);
  assert.ok(ov.vrfs.length >= 3, 'several VRFs');
  assert.ok(!ov.duplicates.some((d) => d.text === '10.1.2.1'), 'the same address in two VRFs is not a duplicate');
  // a dual-stack, multi-interface end: the source address follows the destination's family, and the end says which interface
  const ends = T.endpointChoices(ad, { kind: 'device', device: 'dist' });
  assert.ok(ends.some((e) => e.version === 4) && ends.some((e) => e.version === 6), 'dist has addresses of both families');
  const v4 = T.tracePath(ad, { from: 'dist', to: '10.10.10.2' });
  const v6 = T.tracePath(ad, { from: 'dist', to: '2001:db8:10:10::2' });
  assert.deepEqual([v4.source.iface, v4.source.address], [v4.source.iface, '10.10.10.3']);
  assert.equal(v6.source.address, '2001:db8:10:10::3');
  assert.ok(v4.source.iface && v6.source.iface, 'the interface the trace starts from is named');
  // the WAN: equal-cost paths, all of them evaluated, the coverage said
  const m = model('enterprise-wan.yaml');
  const c = C.checkCommunication(m, { from: 'hq-fw', to: 'hq-log', service: 'udp/514' });
  assert.equal(c.verdict, 'satisfied');
  assert.deepEqual(T.outcomeLines(c.outcome), ['2 evaluated paths reach hq-log:eno1']);
  const w = W.whatIf(m, ['hq-rack-a'], { reach: { kind: 'entire' } });
  assert.equal(w.reach.coverage.checked, w.reach.coverage.eligible, 'every pair of the bounded scope was checked');
});

test('enterprise: a rack failure leaves the requirement on the other core (an alternative path); the core room takes it down', () => {
  const m = model('enterprise-wan.yaml');
  const run = Object.fromEntries(E.evaluateExpectations(m).results.map((r) => [r.id, r]));
  assert.equal(run['fw-logs'].verdict, 'satisfied');
  assert.equal(run['fw-logs-rack-a'].verdict, 'satisfied', 'the equal-cost path over hq-core2 remains');
  assert.equal(run['muc-no-ssh'].verdict, 'satisfied');
  assert.match(run['muc-no-ssh'].reason, /^Blocked by policy at hq-fw/);
  const rack = W.whatIf(m, ['hq-rack-a']);
  const muc = rack.expectations.find((x) => x.after.id === 'fw-logs');
  assert.deepEqual([muc.before.verdict, muc.after.verdict, muc.alternative], ['satisfied', 'satisfied', true]);
  const room = W.whatIf(m, ['hq-core-room']);
  assert.equal(room.expectations.find((x) => x.after.id === 'fw-logs').after.verdict, 'violated');
  assert.ok(room.structural && room.structural.isolated.length > 0, 'the room cuts parts of the network off');
});

test('OT cell: the HMI reaches the controller’s listener, the PLC its broker; the broker’s loss is a service single point; the IT side is not kept out', () => {
  const m = model('ot-network.yaml');
  const run = Object.fromEntries(E.evaluateExpectations(m).results.map((r) => [r.id, r]));
  assert.equal(run['hmi-poll'].verdict, 'satisfied');
  assert.equal(run['hmi-poll'].check.layers.find((l) => l.id === 'listener').verdict, 'satisfied');
  assert.equal(run['plc-telemetry'].verdict, 'satisfied');
  assert.equal(run['it-no-modbus'].verdict, 'violated');
  assert.match(run['it-no-modbus'].reason, /^Reachable: 1 of 1 evaluated path reaches plc:eth0/);
  // the broker: no structural single point, but every MQTT client's dependency goes
  const cands = F.spofCandidates(m);
  const broker = cands.find((x) => x.ref === 'device:edge');
  assert.equal(F.structuralImpact(m, broker), null);
  const w = W.whatIf(m, ['edge']);
  assert.deepEqual(w.deps.filter((d) => d.change === 'unavailable').map((d) => d.dep.key).sort(), ['mqtt:eng-ws/alarms', 'mqtt:hmi/dashboard', 'mqtt:plc/telemetry']);
  // the cell cabinet: the polling goes too
  const cab = W.whatIf(m, ['cell-cabinet']);
  assert.equal(cab.deps.find((d) => d.dep.key === 'app:hmi/poll').change, 'unavailable');
  assert.equal(cab.info.context.scope, 'Failure domain cell-cabinet');
});

test('timing: a compatible source path, the dependency on a grandmaster and the other grandmaster as an alternative', () => {
  const m = model('timing-ptp.yaml');
  const run = Object.fromEntries(E.evaluateExpectations(m).results.map((r) => [r.id, r]));
  assert.equal(run['plc-time'].verdict, 'satisfied');
  assert.match(run['plc-time'].reason, /synchronization and its accuracy are not established/);
  assert.equal(run['plc-time-gm-a'].verdict, 'satisfied', 'gm-b remains');
  const deps = D.serviceDependencies(m).filter((d) => d.kind === 'timing').map((d) => d.consumer).sort();
  assert.ok(deps.indexOf('plc-b') >= 0 && deps.indexOf('gm-a') < 0, 'a grandmaster candidate is a source, not a dependant: ' + deps.join(' '));
  const w = W.whatIf(m, ['gm-a']);
  assert.equal(w.deps.find((d) => d.dep.key === 'timing-ptp:plc-b').change, 'alternative');
});
