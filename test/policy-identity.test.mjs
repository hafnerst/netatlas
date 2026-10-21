// Policy identity and uncertainty, end to end through routed topologies that
// cross the policy device: a rule naming a device whose address another
// device in another VRF also has (destination ownership from the actual
// forwarding context, in the static check, the simulation and a snapshot);
// and an undecided decision carried as structured evidence into the
// communication check and expectations — never read from its text, never
// taken as permitted, never caused by a rule a known service can't match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const C = load('analysis/communication.js');
const S = load('analysis/sim/simulation.js');
const PO = load('analysis/policy.js');
const E = load('analysis/expectations.js');
const IP = load('model/ip.js');

// a firewall with two VRFs whose servers have the same address: srvR (red) and srvB (blue) are both 10.8.0.10; the clients differ
const DUP = (rules, def = 'deny') => `netatlas: 1
title: duplicate destinations
devices:
  - {id: hostR, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.7.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - {id: srvR, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - {id: srvB, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.254}]}
  - id: fw
    type: firewall
    interfaces:
      - {id: r-in, ip: 10.9.0.1/24, vrf: red}
      - {id: r-out, ip: 10.8.0.1/24, vrf: red}
      - {id: b-in, ip: 10.7.0.1/24, vrf: blue}
      - {id: b-out, ip: 10.8.0.254/24, vrf: blue}
    policy:
      default: ${def}
      rules:
${rules}
links:
  - {id: a, a: "hostR:eth0", b: "fw:r-in"}
  - {id: b, a: "hostB:eth0", b: "fw:b-in"}
  - {id: c, a: "fw:r-out", b: "srvR:eth0"}
  - {id: d, a: "fw:b-out", b: "srvB:eth0"}
`;

const check = (m, from, to, svc = 'tcp/80', snap = null) => C.checkCommunication(m, { from, to, service: svc }, snap);
const layer = (c, id) => c.layers.find((l) => l.id === id);
const end = (c) => (c.trace && c.trace.paths[0] ? c.trace.paths[0].end : null);
function tcp(s, from, to) {
  const t = s.sendTest({ from, to, kind: 'tcp', port: 80 });
  assert.equal(typeof t, 'object', String(t));
  s.runTo(s.now + 10000);
  return t;
}

test('destination identity: a rule naming srvR does not permit traffic to srvB with the same address in another VRF — static, simulation and snapshot; the path reaches the device asked for', () => {
  for (const spec of ['srvR', '"srvR:eth0"']) {
    const m = model(DUP(`        - {action: permit, destination: ${spec}, proto: tcp, dport: 80}`));
    const r = check(m, 'hostR', 'srvR');
    assert.equal(r.verdict, 'satisfied', `${spec}: ${r.headline}`);
    assert.deepEqual([end(r).kind, end(r).device], ['reached', 'srvR']);
    const b = check(m, 'hostB', 'srvB');
    assert.equal(layer(b, 'policy').verdict, 'violated', `${spec}: ${b.headline}`);
    assert.match(layer(b, 'policy').text, /fw denies tcp\/80 .*no rule matches/);
    // the destination reached is srvB (the blue segment), not srvR (the tracer's first holder before)
    assert.equal(b.trace.dest.device, 'srvB');
    // the simulation: the same decisions, per packet
    const s = new S.Simulation(m);
    s.runTo(5000);
    assert.equal(tcp(s, 'hostR', 'srvR').ok, true);
    const t = tcp(s, 'hostB', 'srvB');
    assert.equal(t.ok, false);
    assert.match(t.result, /fw/);
    // a snapshot: the same
    const snap = s.snapshot();
    assert.equal(check(m, 'hostR', 'srvR', 'tcp/80', snap).verdict, 'satisfied');
    assert.equal(layer(check(m, 'hostB', 'srvB', 'tcp/80', snap), 'policy').verdict, 'violated');
  }
  // deny the one, permit the rest: srvB stays reachable, srvR is denied
  const d = model(DUP('        - {action: deny, destination: srvR, proto: tcp, dport: 80}', 'permit'));
  assert.equal(check(d, 'hostB', 'srvB').verdict, 'satisfied');
  assert.equal(layer(check(d, 'hostR', 'srvR'), 'policy').verdict, 'violated');
  const s = new S.Simulation(d);
  s.runTo(5000);
  assert.equal(tcp(s, 'hostB', 'srvB').ok, true);
  assert.equal(tcp(s, 'hostR', 'srvR').ok, false);
  // a literal address rule is the address, in both VRFs
  const lit = model(DUP('        - {action: permit, destination: 10.8.0.10, proto: tcp, dport: 80}'));
  assert.equal(check(lit, 'hostB', 'srvB').verdict, 'satisfied');
  assert.equal(check(lit, 'hostR', 'srvR').verdict, 'satisfied');
});

test('destination identity: only an address given, and several devices have it — which one is not guessed: undecided (indeterminate), never every holder', () => {
  const m = model(DUP('        - {action: permit, destination: srvR, proto: tcp, dport: 80}'));
  const c = check(m, 'hostB', '10.8.0.10');
  assert.equal(layer(c, 'policy').verdict, 'indeterminate', c.headline);
  assert.match(layer(c, 'policy').text, /by which device an address is/);
  assert.notEqual(c.verdict, 'satisfied');
  // the engine's view: several holders, no owner → unknown; the owner known → that device only
  const ids = PO.configuredIds(m);
  const a = IP.parseAddress('10.8.0.10');
  assert.deepEqual(ids.holders(a).sort(), ['srvB', 'srvR']);
  assert.equal(PO.specMatches(m, 'srvR', a, ids, null), 'unknown');
  assert.equal(PO.specMatches(m, 'srvR', a, ids, 'srvB'), false);
  assert.equal(PO.specMatches(m, 'srvR', a, ids, 'srvR'), true);
});

// pc takes its address by DHCP behind fw; st and srv are on the other side; the fw's rules name pc
const UNK = (rules, def = 'permit') => `netatlas: 1
title: undecided
devices:
  - {id: pc, type: endpoint, interfaces: [{id: eth0, ipv4: dhcp}]}
  - id: dsrv
    type: server
    services:
      dhcp:
        scopes: [{network: lan, range: 10.1.0.100-10.1.0.199, gateway: 10.1.0.1, dns: [10.1.0.5]}]
    interfaces: [{id: eth0, ip: 10.1.0.5/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - id: fw
    type: firewall
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: wan, ip: 10.9.0.1/24}]
    policy:
      default: ${def}
      rules:
${rules}
  - {id: st, type: server, simulation: {listening: "tcp/80, udp/53"}, interfaces: [{id: eth0, ip: 10.9.0.20/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
links:
  - {id: l1, a: "pc:eth0", b: "sw:p1"}
  - {id: l2, a: "dsrv:eth0", b: "sw:p2"}
  - {id: l3, a: "fw:lan", b: "sw:p3"}
  - {id: l4, a: "fw:wan", b: "st:eth0"}
networks:
  - {id: lan, cidr: 10.1.0.0/24}
expectations:
  - {id: x, name: st reaches the pool, expect: available, from: st, to: 10.1.0.150, service: tcp/80}
`;

test('policy uncertainty: a runtime identity reaches the policy layer as indeterminate (structured, not by its text); permission is never claimed without evidence; expectations keep it', () => {
  const m = model(UNK('        - {action: deny, destination: pc, proto: tcp, dport: 80}'));
  const c = check(m, 'st', '10.1.0.150');
  // the walk crossed fw and recorded what it could not decide
  const hop = c.trace.paths[0].hops.find((h) => h.device === 'fw');
  assert.deepEqual(hop.why.policyUndecided.map((u) => [u.device, u.by]), [['fw', 'identity']]);
  assert.equal(layer(c, 'policy').verdict, 'indeterminate', layer(c, 'policy').text);
  assert.notEqual(c.verdict, 'satisfied');
  // a saved expectation keeps the uncertainty
  const r = E.evaluateExpectation(m, m.expectations[0]);
  assert.notEqual(r.verdict, 'satisfied', r.text || r.verdict);
  // a snapshot knows pc's lease: decided
  const s = new S.Simulation(m);
  s.runTo(30000);
  const lease = s.engine.effectiveAddrs('pc').find((x) => x.addr.version === 4);
  const atPc = check(m, 'st', lease.addr.bytes.join('.'), 'tcp/80', s.snapshot());
  assert.equal(layer(atPc, 'policy').verdict, 'violated', atPc.headline);
});

test('policy uncertainty: a rule a known service can’t match (TCP/80 for UDP/53) decides nothing; an earlier undecided rule stops a later definite one; mixed specification lists', () => {
  const m = model(UNK('        - {action: deny, destination: pc, proto: tcp, dport: 80}'));
  const u = check(m, 'st', '10.1.0.150', 'udp/53');
  assert.equal(layer(u, 'policy').verdict, 'satisfied', layer(u, 'policy').text);
  assert.equal(c0(u), undefined);
  // ordered first match: the undecided rule 1 comes before rule 2's definite permit — no definite answer
  const two = model(UNK(`        - {action: deny, destination: pc, proto: tcp, dport: 80}
        - {action: permit, proto: tcp, dport: 80}`, 'deny'));
  const t = check(two, 'st', '10.1.0.150');
  assert.equal(layer(t, 'policy').verdict, 'indeterminate');
  // mixed lists: a literal that matches decides (the rule applies); a device that is someone else's and one unknown stay unknown
  const lit = model(UNK('        - {action: deny, destination: [pc, 10.1.0.150], proto: tcp, dport: 80}'));
  assert.equal(layer(check(lit, 'st', '10.1.0.150'), 'policy').verdict, 'violated');
  const mix = model(UNK('        - {action: deny, destination: [pc, dsrv], proto: tcp, dport: 80}'));
  assert.equal(layer(check(mix, 'st', '10.1.0.150'), 'policy').verdict, 'indeterminate');
  assert.equal(layer(check(mix, 'st', 'dsrv'), 'policy').verdict, 'violated', 'dsrv is named and known');
  // the missing service and source stay what they are
  const ns = C.checkCommunication(m, { from: 'st', to: '10.1.0.150' });
  assert.equal(layer(ns, 'policy').verdict, 'indeterminate');
  assert.match(layer(ns, 'policy').text, /give a service/);
});

function c0(c) {
  const h = c.trace ? c.trace.paths[0].hops.find((x) => x.device === 'fw') : null;
  return h && h.why.policyUndecided ? h.why.policyUndecided : undefined;
}

// ------------------------------------------------------------------ the owner across several hops (Engine.ownerSeenFrom)

// the firewall's next hop is a router that reuses 10.0.0.2 (and 10.8.0.1) in red and in blue; srvR and srvB beyond it share
// 10.8.0.10 — the router's interfaces listed red first or blue first
const MH = (order, rule = '        - {action: permit, destination: srvR, proto: tcp, dport: 80}') => `netatlas: 1
title: multihop duplicates
devices:
  - {id: hostR, type: endpoint, interfaces: [{id: eth0, ip: 10.9.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.7.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - {id: srvR, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - {id: srvB, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - id: fw
    type: firewall
    interfaces:
      - {id: r-in, ip: 10.9.0.1/24, vrf: red}
      - {id: r-out, ip: 10.0.0.1/30, vrf: red}
      - {id: b-in, ip: 10.7.0.1/24, vrf: blue}
      - {id: b-out, ip: 10.0.0.1/30, vrf: blue}
    routes: [{prefix: 10.8.0.0/24, via: 10.0.0.2, vrf: red}, {prefix: 10.8.0.0/24, via: 10.0.0.2, vrf: blue}]
    policy:
      default: deny
      rules:
${rule}
  - id: dr
    type: router
    interfaces:
${(order === 'red-first' ? ['red', 'blue'] : ['blue', 'red']).map((v) => `      - {id: ${v}-in, ip: 10.0.0.2/30, vrf: ${v}}\n      - {id: ${v}-out, ip: 10.8.0.1/24, vrf: ${v}}`).join('\n')}
    routes: [{prefix: 10.9.0.0/24, via: 10.0.0.1, vrf: red}, {prefix: 10.7.0.0/24, via: 10.0.0.1, vrf: blue}]
links:
  - {id: a, a: "hostR:eth0", b: "fw:r-in"}
  - {id: b, a: "hostB:eth0", b: "fw:b-in"}
  - {id: c, a: "fw:r-out", b: "dr:red-in"}
  - {id: d, a: "fw:b-out", b: "dr:blue-in"}
  - {id: e, a: "dr:red-out", b: "srvR:eth0"}
  - {id: f, a: "dr:blue-out", b: "srvB:eth0"}
`;

test('the owner several hops away: a downstream router reusing its address in two VRFs — the blue flow is srvB’s, the red flow srvR’s, whichever of the router’s interfaces is listed first (simulation, static, snapshot; permit and deny)', () => {
  const a = IP.parseAddress('10.8.0.10');
  for (const order of ['red-first', 'blue-first']) {
    const m = model(MH(order));
    const s = new S.Simulation(m);
    s.runTo(5000);
    assert.equal(s.engine.ownerSeenFrom('fw', 'blue', a), 'srvB', order);
    assert.equal(s.engine.ownerSeenFrom('fw', 'red', a), 'srvR', order);
    const b = tcp(s, 'hostB', '10.8.0.10');
    assert.equal(b.ok, false, `${order}: the rule naming srvR permits nothing to srvB`);
    assert.match(b.result, /dropped at fw: .*no rule matches/);
    assert.equal(tcp(s, 'hostR', '10.8.0.10').ok, true, `${order}: srvR reached, permitted`);
    assert.equal(layer(check(m, 'hostB', 'srvB'), 'policy').verdict, 'violated');
    assert.equal(check(m, 'hostR', 'srvR').verdict, 'satisfied');
    const snap = s.snapshot();
    assert.equal(layer(check(m, 'hostB', 'srvB', 'tcp/80', snap), 'policy').verdict, 'violated');
    assert.equal(check(m, 'hostR', 'srvR', 'tcp/80', snap).verdict, 'satisfied');
    // deny srvR, permit the rest: the blue flow passes, the red one is denied
    const d = new S.Simulation(model(MH(order, '        - {action: deny, destination: srvR, proto: tcp, dport: 80}').replace('default: deny', 'default: permit')));
    d.runTo(5000);
    assert.equal(tcp(d, 'hostB', '10.8.0.10').ok, true, `${order}: srvB is not srvR`);
    assert.equal(tcp(d, 'hostR', '10.8.0.10').ok, false, `${order}: srvR denied`);
  }
});

test('the owner across a failure and its recovery: srvB’s link down — no owner on the blue side (not guessed to be srvR), back up — srvB again; the red side unaffected', () => {
  const a = IP.parseAddress('10.8.0.10');
  const s = new S.Simulation(model(MH('red-first')));
  s.runTo(5000);
  s.fail('link:f');
  s.runTo(s.now + 5000);
  assert.equal(s.engine.ownerSeenFrom('fw', 'blue', a), null);
  assert.equal(s.engine.ownerSeenFrom('fw', 'red', a), 'srvR');
  s.restore('link:f');
  s.runTo(s.now + 5000);
  assert.equal(s.engine.ownerSeenFrom('fw', 'blue', a), 'srvB');
});

// equal-cost next hops from the firewall: through dr1 and dr2 to one LAN (srvB alone has 10.8.0.10 there), or to two LANs
// where srvB and srvX both have it
const ECMP = (split) => `netatlas: 1
title: ecmp owners
devices:
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.7.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - {id: srvB, type: server, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.2}]}
${split ? '  - {id: srvX, type: server, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.3}]}\n' : ''}  - id: fw
    type: firewall
    interfaces:
      - {id: b-in, ip: 10.7.0.1/24}
      - {id: o1, ip: 10.0.1.1/30}
      - {id: o2, ip: 10.0.2.1/30}
    routes: [{prefix: 10.8.0.0/24, via: 10.0.1.2}, {prefix: 10.8.0.0/24, via: 10.0.2.2}]
    policy: {default: permit, rules: []}
  - {id: dr1, type: router, interfaces: [{id: in, ip: 10.0.1.2/30}, {id: out, ip: 10.8.0.2/24}], routes: [{prefix: 10.7.0.0/24, via: 10.0.1.1}]}
  - {id: dr2, type: router, interfaces: [{id: in, ip: 10.0.2.2/30}, {id: out, ip: 10.8.0.3/24}], routes: [{prefix: 10.7.0.0/24, via: 10.0.2.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
${split ? '  - {id: sw2, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}]}\n' : ''}links:
  - {id: a, a: "hostB:eth0", b: "fw:b-in"}
  - {id: c1, a: "fw:o1", b: "dr1:in"}
  - {id: c2, a: "fw:o2", b: "dr2:in"}
  - {id: s1, a: "dr1:out", b: "sw:p1"}
  - {id: s3, a: "srvB:eth0", b: "sw:p3"}
${split ? '  - {id: s2, a: "dr2:out", b: "sw2:p1"}\n  - {id: s4, a: "srvX:eth0", b: "sw2:p2"}' : '  - {id: s2, a: "dr2:out", b: "sw:p2"}'}
`;

test('the owner over equal-cost next hops: both lead to srvB — srvB; they lead to srvB and srvX — not one owner, unless the packet’s own egress is given (the forwarding choice made)', () => {
  const a = IP.parseAddress('10.8.0.10');
  let s = new S.Simulation(model(ECMP(false)));
  s.runTo(5000);
  assert.equal(s.engine.ownerSeenFrom('fw', '', a), 'srvB');
  s = new S.Simulation(model(ECMP(true)));
  s.runTo(5000);
  assert.equal(s.engine.ownerSeenFrom('fw', '', a), null, 'two owners behind two next hops: which one is not guessed');
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'o1'), 'srvB', 'leaving by o1: srvB');
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'o2'), 'srvX', 'leaving by o2: srvX');
});
