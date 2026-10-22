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

// ------------------------------------------------------------------ a written rule base and the relations through it

test('a written rule base decides the packets of a relation through the firewall too, as the path tracer does: an ntp relation of the model denied by rule 1 never answers; permitted, it does', () => {
  const T = (action) => `netatlas: 1
title: a relation through a rule base
devices:
  - {id: cl, type: server, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: 10.1.0.1/24}, {id: out, ip: 10.2.0.254/24}]
    policy:
      default: permit
      rules:
        - {action: ${action}, destination: 10.2.0.1/32, proto: udp, dport: 123}
  - {id: srv, type: server, interfaces: [{id: eth0, ip: 10.2.0.1/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.254}]}
links:
  - {id: a, a: "cl:eth0", b: "fw:in"}
  - {id: b, a: "fw:out", b: "srv:eth0"}
relations:
  - {id: n, protocol: ntp, endpoints: ["cl", "srv"]}
`;
  const m = model(T('deny'));
  assert.equal(layer(check(m, 'cl', '10.2.0.1', 'udp/123'), 'policy').verdict, 'violated');
  const s = new S.Simulation(m);
  s.runTo(150000);
  assert.ok(s.events().some((e) => e.kind === 'drop' && e.device === 'fw' && /10\.2\.0\.1:123.*rule 1/.test(e.detail)), 'the firewall drops the relation’s requests by its rule');
  assert.equal(s.events().filter((e) => e.kind === 'message' && e.what === 'Server response').length, 0);
  const p = new S.Simulation(model(T('permit')));
  p.runTo(150000);
  assert.ok(p.events().filter((e) => e.kind === 'message' && e.what === 'Server response').length >= 2);
});

test('equal-cost paths to two holders of one address: asked for srvB, the path to srvX does not count as reaching it — partial, never “satisfied” on the strength of a permission judged for srvB on both; the simulation’s flows split the same way', () => {
  const t = ECMP(true)
    .replace('policy: {default: permit, rules: []}', 'policy:\n      default: deny\n      rules:\n        - {action: permit, destination: srvB, proto: tcp, dport: 80}')
    .replace(/\{id: srv([BX]), type: server,/g, '{id: srv$1, type: server, simulation: {listening: "tcp/80"},');
  const m = model(t);
  const c = check(m, 'hostB', 'srvB');
  assert.equal(c.verdict, 'partial', c.headline);
  const ends = c.trace.paths.map((p) => `${p.end.kind}:${p.end.device}`).sort();
  assert.deepEqual(ends, ['reached:srvB', 'stopped:srvX']);
  assert.match(c.trace.paths.find((p) => p.end.device === 'srvX').end.detail, /srvX has 10\.8\.0\.10 too: this path reaches srvX, not srvB/);
  // the address alone: which holder can't be told — indeterminate, as before
  assert.equal(layer(check(m, 'hostB', '10.8.0.10'), 'policy').verdict, 'indeterminate');
  // the simulation: flows over o1 reach srvB (permitted), flows over o2 are srvX's (no rule permits them): both kinds occur
  const s = new S.Simulation(m);
  s.runTo(5000);
  const r = [];
  for (let k = 0; k < 6; k++) r.push(tcp(s, 'hostB', '10.8.0.10'));
  assert.ok(r.some((x) => x.ok) && r.some((x) => !x.ok), r.map((x) => x.ok).join(','));
  assert.ok(r.filter((x) => !x.ok).every((x) => /dropped at fw: .*no rule matches/.test(x.result)));
});

// ------------------------------------------------------------------ the owner is local in the routing context walked; the packet's own next hop

// the firewall forwards in blue to r (its blue interface); r has 10.8.0.10 on a red loopback and routes it in blue to srvB
const VRFLO = (rule, def = 'deny', o = {}) => `netatlas: 1
title: owner local in another VRF
devices:
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.7.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - {id: srvB, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - id: fw
    type: firewall
    interfaces:
      - {id: b-in, ip: 10.7.0.1/24}
      - {id: b-out, ip: 10.0.0.1/30}
    routes: [{prefix: 10.8.0.0/24, via: 10.0.0.2}]
    policy:
      default: ${def}
      rules:
${rule}
  - id: r
    type: router
    interfaces:
      - {id: blue-in, ip: 10.0.0.2/30}
      - {id: blue-out, ip: 10.8.0.1/24}
    logical_interfaces: [{id: ${o.loName || 'lo-red'}, type: loopback, ip: 10.8.0.10/32, vrf: red}]
    routes: [{prefix: 10.7.0.0/24, via: 10.0.0.1}]
links:
  - {id: a, a: "hostB:eth0", b: "fw:b-in"}
  - {id: c, a: "fw:b-out", b: "r:blue-in"}
  - {id: f, a: "r:blue-out", b: "srvB:eth0"}
`;

test('the owner several hops away is local in the routing context walked: r has 10.8.0.10 only in red, the blue flow is srvB’s — a rule naming srvB permits it (and one denying srvB denies it), whatever r’s loopback is called; static, simulation, snapshot', () => {
  const a = IP.parseAddress('10.8.0.10');
  for (const loName of ['lo-red', 'a-lo-red', 'zz-lo-red']) {
    const m = model(VRFLO('        - {action: permit, destination: srvB, proto: tcp, dport: 80}', 'deny', { loName }));
    const s = new S.Simulation(m);
    s.runTo(5000);
    assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'b-out', IP.parseAddress('10.0.0.2')), 'srvB', loName);
    assert.equal(tcp(s, 'hostB', '10.8.0.10').ok, true, `${loName}: permitted to srvB`);
    assert.equal(check(m, 'hostB', 'srvB').verdict, 'satisfied');
    const snap = s.snapshot();
    assert.equal(check(m, 'hostB', 'srvB', 'tcp/80', snap).verdict, 'satisfied');
    const d = new S.Simulation(model(VRFLO('        - {action: deny, destination: srvB, proto: tcp, dport: 80}', 'permit', { loName })));
    d.runTo(5000);
    const t = tcp(d, 'hostB', '10.8.0.10');
    assert.equal(t.ok, false, `${loName}: denied to srvB`);
    assert.match(t.result, /dropped at fw: .*rule 1/);
  }
});

test('the owner local in the current context: r has 10.8.0.10 on a blue loopback (another device has it elsewhere) — the flow is r’s; srvB’s link failing never makes r the owner of a red-only address', () => {
  const a = IP.parseAddress('10.8.0.10');
  // (srvB keeps 10.8.0.10; r's loopback in blue now: r answers for it in blue — local, the owner)
  const blue = model(VRFLO('        - {action: permit, destination: r, proto: icmp}', 'deny').replace('ip: 10.8.0.10/32, vrf: red', 'ip: 10.8.0.10/32'));
  const s = new S.Simulation(blue);
  s.runTo(5000);
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'b-out', IP.parseAddress('10.0.0.2')), 'r');
  // red only: srvB's link down — no owner on the blue side (r has it only in red), not r
  const red = new S.Simulation(model(VRFLO('        - {action: permit, destination: srvB, proto: tcp, dport: 80}')));
  red.runTo(5000);
  red.fail('link:f');
  red.runTo(red.now + 5000);
  assert.equal(red.engine.ownerSeenFrom('fw', '', a, 'b-out', IP.parseAddress('10.0.0.2')), null);
  red.restore('link:f');
  red.runTo(red.now + 5000);
  assert.equal(red.engine.ownerSeenFrom('fw', '', a, 'b-out', IP.parseAddress('10.0.0.2')), 'srvB');
  assert.equal(tcp(red, 'hostB', '10.8.0.10').ok, true);
});

// two equal-cost gateways on one LAN behind the firewall's one interface: dr1 leads to srvB, dr2 to srvX, both 10.8.0.10
const SHARED = `netatlas: 1
title: two gateways on one LAN
devices:
  - {id: hostB, type: endpoint, interfaces: [{id: eth0, ip: 10.7.0.5/24}], routes: [{prefix: 0.0.0.0/0, via: 10.7.0.1}]}
  - {id: srvB, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - {id: srvX, type: server, simulation: {listening: "tcp/80"}, interfaces: [{id: eth0, ip: 10.8.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.8.0.1}]}
  - id: fw
    type: firewall
    interfaces: [{id: b-in, ip: 10.7.0.1/24}, {id: o1, ip: 10.0.1.1/24}]
    routes: [{prefix: 10.8.0.0/24, via: 10.0.1.2}, {prefix: 10.8.0.0/24, via: 10.0.1.3}]
    policy:
      default: deny
      rules:
        - {action: permit, destination: srvB, proto: tcp, dport: 80}
  - {id: dr1, type: router, interfaces: [{id: in, ip: 10.0.1.2/24}, {id: out, ip: 10.8.0.1/24}], routes: [{prefix: 10.7.0.0/24, via: 10.0.1.1}]}
  - {id: dr2, type: router, interfaces: [{id: in, ip: 10.0.1.3/24}, {id: out, ip: 10.8.0.1/24}], routes: [{prefix: 10.7.0.0/24, via: 10.0.1.1}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "hostB:eth0", b: "fw:b-in"}
  - {id: s1, a: "fw:o1", b: "sw:p1"}
  - {id: s2, a: "dr1:in", b: "sw:p2"}
  - {id: s3, a: "dr2:in", b: "sw:p3"}
  - {id: x1, a: "dr1:out", b: "srvB:eth0"}
  - {id: x2, a: "dr2:out", b: "srvX:eth0"}
`;

test('two equal-cost gateways sharing the firewall’s interface, towards two holders of 10.8.0.10: the owner follows the packet’s own next hop (not merely its interface) — flows through dr1 are srvB’s and permitted, flows through dr2 srvX’s and denied by the rule, none left undecided', () => {
  const a = IP.parseAddress('10.8.0.10');
  const s = new S.Simulation(model(SHARED));
  s.runTo(5000);
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'o1'), null, 'the interface alone: both gateways, two owners — not guessed');
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'o1', IP.parseAddress('10.0.1.2')), 'srvB');
  assert.equal(s.engine.ownerSeenFrom('fw', '', a, 'o1', IP.parseAddress('10.0.1.3')), 'srvX');
  const r = [];
  for (let k = 0; k < 8; k++) r.push(tcp(s, 'hostB', '10.8.0.10'));
  assert.ok(r.some((x) => x.ok) && r.some((x) => !x.ok), r.map((x) => x.ok).join(','));
  for (const x of r.filter((y) => !y.ok)) assert.match(x.result, /dropped at fw: .*no rule matches/, 'srvX’s: no rule permits it — decided, not undecided');
  assert.equal(s.events().filter((e) => e.kind === 'drop' && e.device === 'fw' && /by which device an address is|can't be told/.test(e.detail)).length, 0);
});

// ------------------------------------------------------------------ a written rule base and IP protocols without ports (GRE …)

// a GRE tunnel between r1 and r2 whose outer packets cross the firewall; h1 and h2 talk through the tunnel
const GRE = (rules, def = 'deny') => `netatlas: 1
title: gre through a firewall
devices:
  - id: r1
    type: router
    interfaces: [{id: wan, ip: 198.51.100.1/30}, {id: lan, ip: 10.1.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 203.0.113.1}]
    routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}, {prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: r2
    type: router
    interfaces: [{id: wan, ip: 203.0.113.1/30}, {id: lan, ip: 10.2.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}]
    routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}, {prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - id: fw
    type: firewall
    interfaces: [{id: a, ip: 198.51.100.2/30}, {id: b, ip: 203.0.113.2/30}]
    policy:
      default: ${def}
      rules:${rules ? '\n' + rules : ' []'}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: "r1:wan", b: "fw:a"}
  - {id: l2, a: "fw:b", b: "r2:wan"}
  - {id: la, a: "r1:lan", b: "h1:eth0"}
  - {id: lb, a: "r2:lan", b: "h2:eth0"}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
`;

test('a written rule base decides an IP protocol without ports too: default deny with no rules drops the GRE tunnel’s outer packets (it stays down, h1 cannot reach h2); a proto-any address rule permits them (a stateful session by their address pair, the tunnel up, the traffic through); a tcp rule does not match them — static and simulation alike', () => {
  const run = (rules) => {
    const m = model(GRE(rules));
    const s = new S.Simulation(m);
    s.runTo(30000);
    const t = s.sendTest({ from: 'h1', to: '10.2.0.10', kind: 'icmp' });
    s.runTo(s.now + 5000);
    return { m, s, t, c: check(m, 'h1', 'h2', 'icmp') };
  };
  // default deny, no rules
  let r = run('');
  const drop = r.s.events().find((e) => e.kind === 'drop' && e.device === 'fw' && /GRE Keepalive/.test(e.detail));
  assert.ok(drop, 'the firewall decided the outer packet');
  assert.match(drop.detail, /drops IP protocol 47 198\.51\.100\.1 → 203\.0\.113\.1 \(GRE Keepalive\): no rule matches \(its default action, deny\)/);
  assert.equal(r.s.sessions('r1', 'gre')[0].state, 'Down');
  assert.equal(r.t.ok, false);
  assert.equal(r.c.verdict, 'violated', r.c.headline);
  assert.match(r.c.trace.paths[0].end.detail, /the tunnel's outer packet \(198\.51\.100\.1 → 203\.0\.113\.1\) is denied/);
  // permitted by address, proto any — one direction written, the answers by the session
  r = run('        - {action: permit, source: 198.51.100.1, destination: 203.0.113.1, proto: any}');
  assert.ok(r.s.events().some((e) => e.kind === 'table' && e.device === 'fw' && /opens a session IP protocol 47 198\.51\.100\.1 → 203\.0\.113\.1 \(permit 198\.51\.100\.1 → 203\.0\.113\.1/.test(e.detail)));
  assert.equal(r.s.sessions('r1', 'gre')[0].state, 'Up');
  assert.equal(r.t.ok, true, r.t.result);
  assert.equal(r.c.verdict, 'satisfied', r.c.headline);
  assert.ok(r.s.sessionTable('fw').some((x) => x.proto === 'other' && /^IP protocol 47 198\.51\.100\.1 → 203\.0\.113\.1$/.test(x.flow)), JSON.stringify(r.s.sessionTable('fw')));
  // a tcp rule says nothing about GRE: still the default
  r = run('        - {action: permit, source: 198.51.100.1, destination: 203.0.113.1, proto: tcp}');
  assert.equal(r.s.sessions('r1', 'gre')[0].state, 'Down');
  assert.equal(r.t.ok, false);
  assert.equal(r.c.verdict, 'violated', r.c.headline);
});

// ------------------------------------------------------------------ portless protocols keep their identity in a stateful policy

// r1 and r2 through fw: a GRE tunnel (tun0) and an IP-in-IP tunnel (tun1) between the same outer addresses
const TWO = (rules, ipip, o = {}) => `netatlas: 1
title: two portless protocols between one address pair
devices:
  - id: r1
    type: router
    interfaces: [{id: wan, ip: 198.51.100.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 203.0.113.1}, {id: tun1, type: tunnel, ip: 172.16.1.1/30, source: wan, destination: 203.0.113.1}]
    routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}]
  - id: r2
    type: router
    interfaces: [{id: wan, ip: 203.0.113.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}, {id: tun1, type: tunnel, ip: 172.16.1.2/30, source: wan, destination: 198.51.100.1}]
    routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}]
  - id: fw
    type: firewall
    interfaces: [{id: a, ip: 198.51.100.2/30}, {id: b, ip: 203.0.113.2/30}]
    policy:
      default: deny${o.stateless ? '\n      stateful: false' : ''}
      rules:
${rules}
links:
  - {id: l1, a: "r1:wan", b: "fw:a"}
  - {id: l2, a: "fw:b", b: "r2:wan"}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
  - ${ipip}
`;
const R1R2 = '        - {action: permit, source: r1, destination: r2}';
const fwDrops = (s, re) => s.events().filter((e) => e.kind === 'drop' && e.device === 'fw' && re.test(e.detail));

test('a stateful policy keeps portless IP protocols apart: a GRE session r1 → r2 (permitted, proto any) lets GRE’s answers back but not IP-in-IP from r2 between the same two addresses — that is decided by the rules (no rule: the default deny); IP-in-IP r1 → r2 opens a session of its own, and its own answers pass by it', () => {
  // the IP-in-IP tunnel one way only, r2 → r1: the reverse of the GRE session
  let s = new S.Simulation(model(TWO(R1R2, '{id: ipip, protocol: ipip, direction: unidirectional, endpoints: ["r2:tun1", "r1:tun1"]}')));
  s.runTo(30000);
  assert.deepEqual(['r1', 'r2'].map((d) => s.sessions(d, 'gre')[0].state), ['Up', 'Up'], 'GRE’s keepalives and their answers (one session)');
  const gre = s.sessionTable('fw').filter((x) => x.proto === 'other');
  assert.deepEqual(gre.map((x) => x.flow), ['IP protocol 47 198.51.100.1 → 203.0.113.1'], 'one session, GRE’s, by its protocol number');
  const ipipDrops = fwDrops(s, /drops IP protocol 4 203\.0\.113\.1 → 198\.51\.100\.1 \(IP-in-IP IP-in-IP packet\): no rule matches \(its default action, deny\)/);
  assert.ok(ipipDrops.length >= 5, `every IP-in-IP packet r2 → r1 is decided by the rules and dropped (${ipipDrops.length})`);
  assert.ok(!s.events().some((e) => e.kind === 'route' && e.device === 'fw' && e.protocol === 'ipip'), 'none forwarded by the GRE session');
  assert.ok(!s.events().some((e) => e.kind === 'state' && e.device === 'r1' && e.protocol === 'ipip' && e.what === 'Up'), 'r1 receives no IP-in-IP');
  // both ways: r1 → r2 opens IP-in-IP's own session (the rule), r2's packets pass by it
  s = new S.Simulation(model(TWO(R1R2, '{id: ipip, protocol: ipip, endpoints: ["r1:tun1", "r2:tun1"]}')));
  s.runTo(30000);
  assert.deepEqual(s.sessionTable('fw').filter((x) => x.proto === 'other').map((x) => x.flow), ['IP protocol 4 198.51.100.1 → 203.0.113.1', 'IP protocol 47 198.51.100.1 → 203.0.113.1']);
  assert.ok(s.events().some((e) => e.kind === 'route' && e.device === 'fw' && e.protocol === 'ipip' && /routes 203\.0\.113\.1 → 198\.51\.100\.1/.test(e.detail)), 'r2’s IP-in-IP passes by its own session');
  assert.ok(s.events().some((e) => e.kind === 'state' && e.device === 'r1' && e.protocol === 'ipip' && e.what === 'Up'));
});

test('a stateless policy decides each portless packet by the rules: GRE’s answers r2 → r1 and IP-in-IP r2 → r1 are both dropped without a rule for them (no session table); a rule for each way permits both protocols', () => {
  let s = new S.Simulation(model(TWO(R1R2, '{id: ipip, protocol: ipip, direction: unidirectional, endpoints: ["r2:tun1", "r1:tun1"]}', { stateless: true })));
  s.runTo(30000);
  assert.deepEqual(s.sessionTable('fw'), []);
  assert.ok(fwDrops(s, /drops IP protocol 47 203\.0\.113\.1 → 198\.51\.100\.1 \(GRE Keepalive reply\): no rule matches/).length > 0, 'GRE’s answers: no rule');
  assert.ok(fwDrops(s, /drops IP protocol 4 203\.0\.113\.1 → 198\.51\.100\.1 .*no rule matches/).length > 0);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Down');
  s = new S.Simulation(model(TWO(R1R2 + '\n        - {action: permit, source: r2, destination: r1}', '{id: ipip, protocol: ipip, direction: unidirectional, endpoints: ["r2:tun1", "r1:tun1"]}', { stateless: true })));
  s.runTo(30000);
  assert.equal(fwDrops(s, /IP protocol/).length, 0);
  assert.equal(s.sessions('r1', 'gre')[0].state, 'Up');
  assert.ok(s.events().some((e) => e.kind === 'state' && e.device === 'r1' && e.protocol === 'ipip' && e.what === 'Up'));
});

// the same outer addresses in two VRFs of fw: GRE r1 ↔ r2 in red, IP-in-IP r4 → r3 (one way) in blue
const VRF2 = `netatlas: 1
title: two routing contexts with the same outer addresses
devices:
  - {id: r1, type: router, interfaces: [{id: wan, ip: 198.51.100.1/30}], logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: wan, destination: 203.0.113.1}], routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}]}
  - {id: r2, type: router, interfaces: [{id: wan, ip: 203.0.113.1/30}], logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}], routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}]}
  - {id: r3, type: router, interfaces: [{id: wan, ip: 198.51.100.1/30}], logical_interfaces: [{id: tun1, type: tunnel, ip: 172.16.1.1/30, source: wan, destination: 203.0.113.1}], routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}]}
  - {id: r4, type: router, interfaces: [{id: wan, ip: 203.0.113.1/30}], logical_interfaces: [{id: tun1, type: tunnel, ip: 172.16.1.2/30, source: wan, destination: 198.51.100.1}], routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}]}
  - id: fw
    type: firewall
    interfaces:
      - {id: ra, ip: 198.51.100.2/30, vrf: red}
      - {id: rb, ip: 203.0.113.2/30, vrf: red}
      - {id: ba, ip: 198.51.100.2/30, vrf: blue}
      - {id: bb, ip: 203.0.113.2/30, vrf: blue}
    policy:
      default: deny
      rules:
        - {action: permit, source: 198.51.100.1, destination: 203.0.113.1}
links:
  - {id: l1, a: "r1:wan", b: "fw:ra"}
  - {id: l2, a: "fw:rb", b: "r2:wan"}
  - {id: l3, a: "r3:wan", b: "fw:ba"}
  - {id: l4, a: "fw:bb", b: "r4:wan"}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
  - {id: ipip, protocol: ipip, direction: unidirectional, endpoints: ["r4:tun1", "r3:tun1"]}
`;

test('overlapping routing contexts: the same outer address pair in red (GRE r1 ↔ r2, a session) and in blue (IP-in-IP r4 → r3) — blue’s packets inherit nothing from red’s session; red’s GRE is up', () => {
  const s = new S.Simulation(model(VRF2));
  s.runTo(30000);
  assert.deepEqual(['r1', 'r2'].map((d) => s.sessions(d, 'gre')[0].state), ['Up', 'Up']);
  assert.ok(fwDrops(s, /drops IP protocol 4 203\.0\.113\.1 → 198\.51\.100\.1 .*no rule matches/).length > 0);
  assert.ok(!s.events().some((e) => e.kind === 'state' && e.device === 'r3' && e.protocol === 'ipip' && e.what === 'Up'));
  assert.deepEqual(s.sessionTable('fw').map((x) => x.flow), ['IP protocol 47 198.51.100.1 → 203.0.113.1']);
});

// ------------------------------------------------------------------ related ICMP errors about an echo

// h1 → fw (stateful, default deny; h1's ICMP permitted) → r → a 1280-byte link → h2
const PMTU = (v6, extra = '') => `netatlas: 1
title: related errors about an echo
devices:
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: ${v6 ? '2001:db8:1::10/64' : '10.1.0.10/24'}}], routes: [{prefix: ${v6 ? '::/0' : '0.0.0.0/0'}, via: ${v6 ? '2001:db8:1::1' : '10.1.0.1'}}]}
  - id: fw
    type: firewall
    interfaces: [{id: in, ip: ${v6 ? '2001:db8:1::1/64' : '10.1.0.1/24'}}, {id: out, ip: ${v6 ? '2001:db8:2::1/64' : '10.2.0.1/24'}}]
    routes: [{prefix: ${v6 ? '2001:db8:3::/64' : '10.3.0.0/24'}, via: ${v6 ? '2001:db8:2::2' : '10.2.0.2'}}]
    policy:
      default: deny
      rules:
        - {action: permit, source: h1, proto: icmp}
        - {action: permit, source: h1, proto: udp, dport: 9999}
  - {id: r, type: router, interfaces: [{id: a, ip: ${v6 ? '2001:db8:2::2/64' : '10.2.0.2/24'}}, {id: b, ip: ${v6 ? '2001:db8:3::1/64' : '10.3.0.1/24'}, mtu: 1280}], routes: [{prefix: ${v6 ? '2001:db8:1::/64' : '10.1.0.0/24'}, via: ${v6 ? '2001:db8:2::1' : '10.2.0.1'}}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: ${v6 ? '2001:db8:3::10/64' : '10.3.0.10/24'}, mtu: 1280}], routes: [{prefix: ${v6 ? '::/0' : '0.0.0.0/0'}, via: ${v6 ? '2001:db8:3::1' : '10.3.0.1'}}]}
links:
  - {id: l1, a: "h1:eth0", b: "fw:in"}
  - {id: l2, a: "fw:out", b: "r:a"}
  - {id: l3, a: "r:b", b: "h2:eth0"}
${extra}`;

test('related ICMP errors through a stateful default-deny firewall: an IPv4 Fragmentation Needed and an IPv6 Packet Too Big about a permitted echo belong to its session (the quoted echo by its identifier, RFC 1191 / 8201, RFC 4890 §4.3.1) and reach h1; a Port Unreachable about a permitted UDP datagram likewise', () => {
  for (const v6 of [false, true]) {
    const s = new S.Simulation(model(PMTU(v6)));
    s.runTo(10000);
    const dst = v6 ? '2001:db8:3::10' : '10.3.0.10';
    const t = s.sendTest({ from: 'h1', to: dst, kind: 'icmp', size: 1400, df: true });
    s.runTo(s.now + 5000);
    const err = v6 ? 'Packet Too Big' : 'Frag Needed';
    assert.match(t.result, new RegExp(`^${err} from ${v6 ? '2001:db8:2::2' : '10\\.2\\.0\\.2'} \\(r\\): the packet is too big for the path and DF is set \\(path MTU 1280\\)`), `IPv${v6 ? 6 : 4}: ${t.result}`);
    assert.equal(fwDrops(s, /./).length, 0, 'fw drops nothing');
    assert.ok(s.sessionTable('fw').some((x) => x.proto === 'icmp' && /\(echo 1\)$/.test(x.flow)), 'the echo’s session, by its identifier');
    // an echo that fits: answered, its session as before
    const ok = s.sendTest({ from: 'h1', to: dst, kind: 'icmp' });
    s.runTo(s.now + 5000);
    assert.equal(ok.ok, true, ok.result);
    // UDP to a port h2 does not listen on: its Port Unreachable passes by the datagram's session
    const u = s.sendTest({ from: 'h1', to: dst, kind: 'udp', port: 9999 });
    s.runTo(s.now + 5000);
    assert.match(u.result, /Port Unreachable/, u.result);
    assert.equal(fwDrops(s, /./).length, 0);
  }
});

// ------------------------------------------------------------------ a tunnel carried in UDP through a written policy

// r1 and r2 through fw (default deny), the tunnel's relation of the protocol given; the source and destination forms vary
const UDPTUN = (proto, rules, o = {}) => `netatlas: 1
title: a UDP tunnel through a firewall
devices:
  - id: r1
    type: router
    interfaces: [{id: wan, ip: 198.51.100.1/30}, {id: lan, ip: 10.1.0.1/24}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.1/30, source: ${o.src || 'wan'}, destination: ${o.dst || '203.0.113.1'}}]
    routes: [{prefix: 203.0.113.0/30, via: 198.51.100.2}, {prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: r2
    type: router
    interfaces: [{id: lan, ip: 10.2.0.1/24}, {id: wan, ip: 203.0.113.1/30}]
    logical_interfaces: [{id: tun0, type: tunnel, ip: 172.16.0.2/30, source: wan, destination: 198.51.100.1}]
    routes: [{prefix: 198.51.100.0/30, via: 203.0.113.2}, {prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - id: fw
    type: firewall
    interfaces: [{id: a, ip: 198.51.100.2/30}, {id: b, ip: 203.0.113.2/30}]
    policy:
      default: deny
      rules:
${rules}
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: l1, a: "r1:wan", b: "fw:a"}
  - {id: l2, a: "fw:b", b: "r2:wan"}
  - {id: la, a: "r1:lan", b: "h1:eth0"}
  - {id: lb, a: "r2:lan", b: "h2:eth0"}
relations:
  - {id: t, protocol: ${proto}, endpoints: ["r1:tun0", "r2:tun0"]}
`;
const both = (port, src = 'r1', dst = 'r2') => `        - {action: permit, source: ${src}, destination: ${dst}, proto: udp, dport: ${port}}\n        - {action: permit, source: ${dst}, destination: ${src}, proto: udp, dport: ${port}}`;
const ping = (s) => {
  const t = s.sendTest({ from: 'h1', to: '10.2.0.10', kind: 'icmp' });
  s.runTo(s.now + 5000);
  return t;
};

test('a tunnel carried in UDP (WireGuard 51820, VXLAN 4789) through a default-deny policy that permits its outer UDP port: the outer packets are UDP to that port between the tunnel’s source and destination — the simulation’s handshakes, keepalives and data, and the path tracer’s outer walk alike; another port permitted: denied in both', () => {
  for (const [proto, port] of [['wireguard', 51820], ['vxlan', 4789]]) {
    const m = model(UDPTUN(proto, both(port)));
    const s = new S.Simulation(m);
    s.runTo(30000);
    const t = ping(s);
    assert.equal(t.ok, true, `${proto}: ${t.result}`);
    const rows = s.sessionTable('fw');
    assert.ok(rows.length > 0 && rows.every((x) => x.proto === 'udp' && new RegExp(`:${port}$`).test(x.flow)), `${proto}: ${JSON.stringify(rows.map((x) => x.flow))}`);
    assert.equal(fwDrops(s, /./).length, 0, `${proto}: nothing dropped`);
    const c = check(m, 'h1', 'h2', 'icmp');
    assert.equal(c.verdict, 'satisfied', `${proto}: ${c.headline}`);
    // another port: the outer packets match no rule
    const m2 = model(UDPTUN(proto, both(port + 1)));
    const s2 = new S.Simulation(m2);
    s2.runTo(30000);
    assert.equal(ping(s2).ok, false);
    assert.ok(fwDrops(s2, new RegExp(`drops UDP 198\\.51\\.100\\.1:\\d+ → 203\\.0\\.113\\.1:${port} .*no rule matches`)).length > 0, proto);
    const c2 = check(m2, 'h1', 'h2', 'icmp');
    assert.equal(c2.verdict, 'violated', c2.headline);
    assert.match(end(c2).detail, /the tunnel's outer packet \(198\.51\.100\.1 → 203\.0\.113\.1\) is denied: fw denies udp\/\d+ from r1 to r2: no rule matches/);
  }
});

test('the tunnel’s source written as an address and its destination as a device: the outer packet is from that address to the far end’s tunnel source, in the simulation and the path tracer — a rule naming the addresses decides it', () => {
  const rules = both(51820, '198.51.100.1', '203.0.113.1');
  for (const o of [{ src: '198.51.100.1' }, { dst: 'r2' }, { src: '198.51.100.1', dst: 'r2' }]) {
    const m = model(UDPTUN('wireguard', rules, o));
    const s = new S.Simulation(m);
    s.runTo(30000);
    assert.equal(ping(s).ok, true, JSON.stringify(o));
    const c = check(m, 'h1', 'h2', 'icmp');
    assert.equal(c.verdict, 'satisfied', `${JSON.stringify(o)}: ${c.headline}`);
    const hop = c.trace.paths[0].hops.find((h) => h.underlay);
    assert.ok(hop, 'the outer packet traced');
    assert.deepEqual([hop.underlay.hops[0].device, hop.underlay.end.device], ['r1', 'r2']);
  }
});

// ------------------------------------------------------------------ a tunnel's underlay over equal-cost alternatives

// r1's tunnel source (lo0) reaches r2's over fwA and fwB, equal cost; one firewall permits everything, the other denies
const ECMP_UNDER = (denyA, o = {}) => `netatlas: 1
title: a tunnel underlay over two equal-cost paths
devices:
  - id: r1
    type: router
    interfaces: [{id: a, ip: 10.0.1.1/30, mtu: 1500}, {id: b, ip: 10.0.2.1/30, mtu: 1500}, {id: lan, ip: 10.1.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 192.0.2.1/32}, {id: tun0, type: tunnel, ip: 172.16.0.1/30, source: lo0, destination: 192.0.2.2}]
    routes: [{prefix: 192.0.2.2/32, via: 10.0.1.2}, {prefix: 192.0.2.2/32, via: 10.0.2.2}, {prefix: 10.2.0.0/24, via: 172.16.0.2}]
  - id: fwA
    type: firewall
    interfaces: [{id: i, ip: 10.0.1.2/30, mtu: 1500}, {id: o, ip: 10.0.3.1/30, mtu: 1500}]
    routes: [{prefix: 192.0.2.2/32, via: 10.0.3.2}, {prefix: 192.0.2.1/32, via: 10.0.1.1}]
    policy: {default: ${denyA ? 'deny' : 'permit'}, rules: []}
  - id: fwB
    type: firewall
    interfaces: [{id: i, ip: 10.0.2.2/30, mtu: 1500}, {id: o, ip: 10.0.4.1/30, mtu: 1500}]
    routes: [{prefix: 192.0.2.2/32, via: 10.0.4.2}, {prefix: 192.0.2.1/32, via: 10.0.2.1}]
    policy: {default: ${denyA || o.both ? 'permit' : 'deny'}, rules: []}
  - id: r2
    type: router
    interfaces: [{id: a, ip: 10.0.3.2/30, mtu: 1500}, {id: b, ip: 10.0.4.2/30, mtu: ${o.mtuB || 1500}}, {id: lan, ip: 10.2.0.1/24, mtu: 1500}]
    logical_interfaces: [{id: lo0, type: loopback, ip: 192.0.2.2/32}, {id: tun0, type: tunnel, ip: 172.16.0.2/30, source: lo0, destination: 192.0.2.1}]
    routes: [{prefix: 192.0.2.1/32, via: 10.0.3.1}, {prefix: 192.0.2.1/32, via: 10.0.4.1}, {prefix: 10.1.0.0/24, via: 172.16.0.1}]
  - {id: h1, type: endpoint, interfaces: [{id: eth0, ip: 10.1.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - {id: h2, type: endpoint, interfaces: [{id: eth0, ip: 10.2.0.10/24, mtu: 1500}], routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]}
links:
  - {id: la, a: "r1:a", b: "fwA:i", speed: 100M}
  - {id: lb, a: "r1:b", b: "fwB:i", speed: 100M}
  - {id: lc, a: "fwA:o", b: "r2:a", speed: 100M}
  - {id: ld, a: "fwB:o", b: "r2:b", speed: 100M}
  - {id: l1, a: "r1:lan", b: "h1:eth0", speed: 1G}
  - {id: l2, a: "r2:lan", b: "h2:eth0", speed: 1G}
relations:
  - {id: gre, protocol: gre, endpoints: ["r1:tun0", "r2:tun0"]}
${o.demand ? 'demands:\n  - {id: d, source: h1, destination: h2, bandwidth: 10M}\n' : ''}`;
const MTU = load('analysis/mtu.js');
const CAP = load('analysis/capacity.js');

test('a tunnel whose outer packet has two equal-cost underlay paths, one permitted and one denied: the trace evaluates both (partial: one path reaches h2, one stops at the denial), whichever firewall is the denying one — never satisfied or violated by the first alternative alone', () => {
  const sig = (c) => c.trace.paths.map((p) => (p.end.kind === 'reached' ? 'reached ' + p.end.device : `${p.end.reason}: ${/fw[AB]/.exec(p.end.detail)[0]}`)).sort();
  const a = check(model(ECMP_UNDER(false)), 'h1', 'h2', 'icmp');
  const b = check(model(ECMP_UNDER(true)), 'h1', 'h2', 'icmp');
  assert.equal(a.verdict, 'partial', a.headline);
  assert.equal(b.verdict, 'partial', b.headline);
  assert.deepEqual(sig(a), ['denied: fwB', 'reached h2']);
  assert.deepEqual(sig(b), ['denied: fwA', 'reached h2']);
  for (const c of [a, b]) {
    const hops = c.trace.paths.map((p) => p.hops.find((h) => h.underlay));
    assert.deepEqual(hops.map((h) => h.underlay.hops[1].device).sort(), ['fwA', 'fwB'], 'each path its own underlay alternative');
    assert.ok(hops.every((h) => h.notes.some((n) => /the outer packet has 2 equal-cost alternatives/.test(n))));
  }
});

test('a tunnel’s underlay alternatives each count for the path MTU and the capacity: the second alternative’s smaller MTU (r2:b 1400) limits the path MTU and is said to differ; a demand over the tunnel loads the cables of both alternatives', () => {
  const m = model(ECMP_UNDER(false, { both: true, mtuB: 1400, demand: true }));
  const c = check(m, 'h1', 'h2', 'icmp');
  assert.equal(c.verdict, 'satisfied', c.headline);
  assert.equal(c.trace.paths.length, 2);
  const pm = MTU.pathMtu(m, c);
  assert.equal(pm.forward.length, 2);
  assert.equal(pm.mtu, 1400 - 24, pm.text);
  assert.ok(pm.differs.some((x) => /The equal-cost paths differ/.test(x)), pm.differs.join(' | '));
  const res = CAP.capacityAnalysis(m);
  const loaded = new Set(res.loads.filter((l) => l.worst > 0).map((l) => l.resource.id));
  for (const id of ['link:la', 'link:lb', 'link:lc', 'link:ld']) assert.ok(loaded.has(id), `${id} carries the demand: ${Array.from(loaded).join(', ')}`);
});
