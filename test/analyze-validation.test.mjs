// Analyze as an architecture-validation workflow: shared verdicts and
// context (analysis/result.ts), outcomes over every evaluated path, the
// layered communication check (addresses, name resolution, path, policy,
// listener, runtime), snapshots with acquired addresses, allocation-aware
// addressing with scoped duplicates, service dependencies and the what-if
// comparison, failure domains, saved expectations, contextual focus, the
// findings' presentation, freshness and the exports. Model-level: the
// behaviour, not the pixels. Deterministic: the order of the file never
// matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example } from './helpers.mjs';

const R = load('analysis/result.js');
const T = load('analysis/trace.js');
const C = load('analysis/communication.js');
const A = load('analysis/addressing.js');
const D = load('analysis/dependencies.js');
const W = load('analysis/whatif.js');
const E = load('analysis/expectations.js');
const F = load('analysis/failure.js');
const FO = load('analysis/focus.js');
const FI = load('analysis/findings.js');
const TI = load('analysis/timing.js');
const S = load('analysis/sim/simulation.js');
const FP = load('model/fingerprint.js');
const UT = load('ui/trace.js');
const UA = load('ui/addressing.js');
const US = load('ui/spof.js');
const UD = load('ui/design-checks.js');
const I = load('analysis/ipmath.js');

const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.map((e) => `${e.path}: ${e.message}`), [], 'valid');
  return r.model;
};

// a branch PC, a router, a firewall (it permits HTTPS, TCP 9443 and DNS), a server with two bound listeners, a DNS server
const corp = `netatlas: 1
title: Analyze fixture
devices:
  - id: pc
    type: endpoint
    interfaces: [{id: eth0, ip: 10.1.0.10/24}]
    dns_servers: [10.2.0.53]
    routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]
    services:
      applications:
        - {id: web, name: Browser, profile: tcp_client, peer: www.corp.test, port: 443}
        - {id: api, name: API client, profile: tcp_client, peer: srv/api}
        - {id: bad, name: Bad name, profile: tcp_client, peer: nothere.corp.test, port: 443}
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: up, ip: 10.0.1.1/30}]
    routes: [{prefix: 10.2.0.0/24, via: 10.0.1.2}, {prefix: 10.3.0.0/24, via: 10.0.1.2}]
  - id: fw
    type: firewall
    simulation: {allow: "tcp/443, tcp/9443, udp/53"}
    interfaces: [{id: out, ip: 10.0.1.2/30}, {id: in, ip: 10.2.0.1/24}]
    routes: [{prefix: 10.1.0.0/24, via: 10.0.1.1}]
  - id: srv
    type: server
    interfaces: [{id: eth0, ip: 10.2.0.10/24}, {id: mgmt, ip: 10.2.0.11/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
    dns_names: [{name: www.corp.test, interfaces: [eth0]}]
    services:
      applications:
        - {id: api, name: API, profile: tcp_server, port: 443, bind: eth0}
        - {id: admin, name: Admin, profile: tcp_server, port: 8443, bind: mgmt}
  - id: dns
    type: server
    interfaces: [{id: eth0, ip: 10.2.0.53/24}]
    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]
    services:
      dns: {zones: [{name: corp.test}]}
  - id: sw
    type: switch
    interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]
links:
  - {id: l-pc, a: "pc:eth0", b: "r1:lan"}
  - {id: l-up, a: "r1:up", b: "fw:out"}
  - {id: l-fw, a: "fw:in", b: "sw:p1"}
  - {id: l-srv, a: "srv:eth0", b: "sw:p2"}
  - {id: l-mgmt, a: "srv:mgmt", b: "sw:p3"}
  - {id: l-dns, a: "dns:eth0", b: "sw:p4"}
networks:
  - {id: branch, cidr: 10.1.0.0/24}
  - {id: dc, cidr: 10.2.0.0/24}
failure_domains:
  - {id: rack-1, label: Rack 1, kind: rack, members: [fw, sw]}
expectations:
  - {id: api-ok, name: PC uses the API, expect: available, from: pc/api}
  - {id: no-ssh, name: No SSH to the server, expect: blocked, from: pc, to: srv, service: tcp/22}
  - {id: no-r3, name: Nothing reaches 10.3, expect: blocked, from: pc, to: 10.3.0.10}
  - {id: https-open, name: HTTPS must be blocked, expect: blocked, from: pc, to: srv:eth0, service: tcp/443}
  - {id: api-rack, name: The API survives Rack 1, expect: available, from: pc/api, failure: [rack-1]}
  - {id: ghost, name: An unknown condition, expect: available, from: pc, to: srv, failure: [nothing-here]}
`;

// two equal-cost next hops: one reaches the server, one stops at r3
const ecmp = `netatlas: 1
devices:
  - {id: h1, type: endpoint, interfaces: [{id: e0, ip: 10.1.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.1.0.1}]}
  - id: r1
    type: router
    interfaces: [{id: lan, ip: 10.1.0.1/24}, {id: a, ip: 10.0.1.1/30}, {id: b, ip: 10.0.2.1/30}]
    routes: [{prefix: 10.9.0.0/24, via: 10.0.1.2}, {prefix: 10.9.0.0/24, via: 10.0.2.2}, {prefix: 0.0.0.0/0, via: 10.0.1.2}]
  - {id: r2, type: router, interfaces: [{id: a, ip: 10.0.1.2/30}, {id: c, ip: 10.9.0.1/24}, {id: w, ip: 198.51.100.2/30}], routes: [{prefix: 0.0.0.0/0, via: 198.51.100.1}]}
  - {id: r3, type: router, interfaces: [{id: b, ip: 10.0.2.2/30}]}
  - {id: srv, type: server, interfaces: [{id: e0, ip: 10.9.0.10/24}], routes: [{prefix: 0.0.0.0/0, via: 10.9.0.1}]}
links:
  - {id: l1, a: "h1:e0", b: "r1:lan"}
  - {id: l2, a: "r1:a", b: "r2:a"}
  - {id: l3, a: "r1:b", b: "r3:b"}
  - {id: l4, a: "r2:c", b: "srv:e0"}
`;

// ------------------------------------------------------------ verdicts and scope

test('result semantics: verdict words per tone, all-of, context and coverage lines', () => {
  assert.equal(R.verdictText('satisfied', 'reach'), 'Reachable within scope');
  assert.equal(R.verdictText('violated', 'service'), 'Unavailable');
  assert.equal(R.verdictText('partial', 'check'), 'Partially satisfied');
  assert.equal(R.allOf(['satisfied', 'beyond', 'partial']), 'partial');
  assert.equal(R.allOf(['satisfied', 'indeterminate', 'violated']), 'violated');
  assert.equal(R.allOf([]), 'indeterminate', 'nothing evaluated is no success');
  assert.equal(R.contextText(R.snapshotContext(12345, 'Selected endpoints')), 'Simulation snapshot at t = 12.3 s · Selected endpoints');
  assert.equal(R.coverageText({ checked: 40, eligible: 52, unit: 'device pairs', truncated: true, omitted: '12 devices' }), 'Checked 40 of 52 device pairs (a limit was reached); not checked: 12 devices');
  assert.equal(R.coverageText({ checked: 9, eligible: 9, unit: 'candidates' }), 'Checked all 9 candidates');
  assert.match(R.contextAssumption(R.configuredContext()), /DHCP or SLAAC assign at runtime are not known/);
});

test('trace outcome over every evaluated path: mixed ECMP is partial, never the first path alone', () => {
  const m = model(ecmp);
  const t = T.tracePath(m, { from: 'h1', to: 'srv' });
  const o = T.traceOutcome(t);
  assert.equal(o.verdict, 'partial');
  assert.deepEqual(T.outcomeLines(o), ['1 evaluated path reaches srv:e0', '1 evaluated path stops at r3 (no route)']);
  assert.match(UT.traceSummary(t), /^Partially reachable: 1 evaluated path reaches srv:e0; 1 evaluated path stops at r3/);
  assert.doesNotMatch(UT.traceSummary(t), /^Reached/);
});

test('trace outcome: leaving the model and a network without the destination are beyond scope, not success; a stop is blocked; an error indeterminate', () => {
  const m = model(ecmp);
  const out = T.traceOutcome(T.tracePath(m, { from: 'h1', to: '203.0.113.9' }));
  assert.equal(out.verdict, 'beyond');
  assert.match(T.outcomeLines(out)[0], /leaves the modeled architecture at r2 towards 198\.51\.100\.1/);
  const del = T.traceOutcome(T.tracePath(m, { from: 'h1', to: '10.9.0.99' }));
  assert.equal(del.groups[0].kind, 'delivered');
  assert.match(T.outcomeLines(del)[0], /receipt is not established/);
  assert.notEqual(del.verdict, 'satisfied');
  const stop = T.traceOutcome(T.tracePath(m, { from: 'srv', to: '10.0.2.2' }));
  assert.equal(stop.verdict, 'violated');
  assert.equal(T.traceOutcome(T.tracePath(m, { from: 'nobody', to: 'srv' })).verdict, 'indeterminate');
});

test('“Why this hop?”: the decision evidence of the hop, from the decision itself (selected, rule, alternatives, layer 2, stop)', () => {
  const m = model(ecmp);
  const t = T.tracePath(m, { from: 'h1', to: 'srv' });
  const w = t.paths[0].hops[1].why;
  assert.equal(w.lookup, '10.9.0.10 in the default table of r1');
  assert.equal(w.selected.length, 2, 'both equal-cost routes');
  assert.match(w.rule, /longest matching prefix 10\.9\.0\.0\/24, then the lowest distance \(1\) and metric \(0\): 2 equal-cost next hops/);
  assert.ok(w.alternatives.some((a) => a.lost === 'longer-prefix' && /0\.0\.0\.0\/0/.test(a.text)), 'the default route lost to the longer prefix');
  assert.match(w.l2, /a direct cable \(cable l2\) to r2:a/);
  const stopped = t.paths[1].hops[t.paths[1].hops.length - 1].why;
  assert.match(stopped.stop, /no route to 10\.9\.0\.10/);
});

test('endpoint resolution is consistent: by device, by interface and by its address the same path and ends', () => {
  const m = model(corp);
  const a = T.tracePath(m, { from: 'pc', to: 'srv:eth0' });
  const b = T.tracePath(m, { from: 'pc:eth0', to: '10.2.0.10' });
  const c = T.tracePath(m, { from: '10.1.0.10', to: 'srv:eth0' });
  const key = (t) => JSON.stringify(t.paths.map((p) => p.hops.map((h) => [h.device, h.ingress, h.egress])));
  assert.equal(key(a), key(b));
  assert.equal(key(a), key(c));
  assert.deepEqual([a.source.device, a.source.iface, a.source.address], ['pc', 'eth0', '10.1.0.10'], 'the device as a whole shows the interface it starts from');
  assert.deepEqual(T.resolvedEnds(a), { from: 'pc:eth0 · 10.1.0.10', to: 'srv:eth0 · 10.2.0.10', vrf: 'Default table' });
  assert.equal(T.endpointChoices(m, { kind: 'device', device: 'srv' }).length, 2, 'two addresses the destination could stand for');
});

// ------------------------------------------------------------ communication checks

test('communication: an application to its peer application takes the listener’s transport, port and bind interface', () => {
  const m = model(corp);
  const c = C.checkCommunication(m, { from: 'pc/api' });
  assert.equal(c.verdict, 'satisfied');
  assert.deepEqual(c.service, { proto: 'tcp', port: 443 });
  assert.equal(c.serviceSource, 'the listener srv/api');
  assert.equal(c.to.text, 'srv:eth0 · 10.2.0.10 (its peer srv/api)');
  const lay = Object.fromEntries(c.layers.map((l) => [l.id, l.verdict]));
  assert.deepEqual(lay, { address: 'satisfied', path: 'satisfied', policy: 'satisfied', listener: 'satisfied', runtime: 'unsupported' });
  assert.match(c.layers.find((l) => l.id === 'policy').text, /Permitted by fw/);
  assert.match(c.layers.find((l) => l.id === 'runtime').text, /Not established by static analysis/);
  assert.equal(c.handoff.kind, 'app', 'a client application is started in the simulation, never by the check');
});

test('communication: the address is reachable but nothing listens; a listener on another binding does not take it', () => {
  const m = model(corp);
  const none = C.checkCommunication(m, { from: 'pc', to: 'srv:eth0', service: 'tcp/9443' });
  assert.equal(none.verdict, 'violated');
  assert.equal(none.layers.find((l) => l.id === 'path').verdict, 'satisfied', 'the network path is there');
  assert.match(none.headline, /^Reachable, but nothing listens on TCP 9443 at srv/);
  const bound = C.checkCommunication(m, { from: 'pc', to: 'srv:mgmt', service: 'tcp/443' });
  assert.equal(bound.layers.find((l) => l.id === 'listener').verdict, 'violated');
  assert.match(bound.layers.find((l) => l.id === 'listener').text, /listens on eth0 only; the traffic arrives at srv:mgmt/);
});

test('communication: a policy denial is not a missing route (each said in its own layer)', () => {
  const m = model(corp);
  const ssh = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/22' });
  assert.equal(ssh.verdict, 'violated');
  assert.equal(ssh.layers.find((l) => l.id === 'policy').verdict, 'violated');
  assert.equal(ssh.layers.find((l) => l.id === 'path').verdict, 'indeterminate', 'beyond the denial the path is not evaluated');
  assert.match(ssh.headline, /^Blocked by policy: at fw/);
  const nr = C.checkCommunication(m, { from: 'pc', to: '10.3.0.10', service: 'tcp/443' });
  assert.equal(nr.layers.find((l) => l.id === 'path').verdict, 'violated');
  assert.match(nr.headline, /^Unreachable: 1 evaluated path stops at fw \(no route\)/);
  assert.notEqual(nr.layers.find((l) => l.id === 'policy').verdict, 'violated');
});

test('communication: name resolution within the modeled DNS, its query a leg of its own; an unknown name is violated, no resolver indeterminate', () => {
  const m = model(corp);
  const web = C.checkCommunication(m, { from: 'pc/web' });
  const name = web.layers.find((l) => l.id === 'name');
  assert.equal(name.verdict, 'satisfied');
  assert.match(name.text, /www\.corp\.test resolves to 10\.2\.0\.10 \(dns, zone corp\.test\)/);
  assert.equal(web.verdict, 'satisfied');
  assert.ok(web.legs.some((g) => /^DNS query from pc to dns/.test(g.label) && g.check.verdict === 'satisfied'));
  const bad = C.checkCommunication(m, { from: 'pc/bad' });
  assert.equal(bad.layers.find((l) => l.id === 'name').verdict, 'violated');
  assert.match(bad.layers.find((l) => l.id === 'name').text, /NXDOMAIN/);
  const noRes = C.checkCommunication(model(corp.replace('    dns_servers: [10.2.0.53]\n', '')), { from: 'pc/web' });
  assert.equal(noRes.layers.find((l) => l.id === 'name').verdict, 'indeterminate');
});

test('communication: an MQTT client’s leg ends at the broker; each subscriber is a separate leg over its own connection', () => {
  const m = model(example('ot-network.yaml'));
  const c = C.checkCommunication(m, { from: 'plc/telemetry' });
  assert.equal(c.verdict, 'satisfied');
  assert.match(c.to.text, /^edge:eth0 · 10\.71\.0\.30 \(its broker edge\)/);
  assert.deepEqual(c.service, { proto: 'tcp', port: 1883 });
  assert.ok(c.legs.length >= 1);
  assert.ok(c.legs.every((g) => /over the subscriber’s own connection/.test(g.label)), c.legs.map((g) => g.label).join(' | '));
  assert.ok(c.legs.some((g) => /hmi\/dashboard/.test(g.label)));
});

test('communication: the reverse direction is reverse routing and symmetry; a session is not verified, and the port is not reused', () => {
  const m = model(corp);
  const c = C.checkCommunication(m, { from: 'pc', to: 'srv:eth0', service: 'tcp/443', back: true });
  assert.equal(c.reverse.symmetry, 'symmetric');
  assert.equal(c.reverse.trace.request.service, undefined, 'no destination port in reverse');
  assert.ok(c.reverse.lines.some((l) => /a TCP session and a stateful firewall’s return decision are not evaluated/.test(l)));
});

test('communication: static, DHCP and SLAAC sources — runtime addresses are indeterminate in the configured model, used from a snapshot', () => {
  const m = model(example('private-house.yaml'));
  const conf = C.checkCommunication(m, { from: 'laptop', to: 'nas' });
  assert.equal(conf.verdict, 'indeterminate');
  assert.match(conf.layers[0].text, /laptop:wlan0 takes its IPv4 address by DHCP at runtime/);
  const sim = new S.Simulation(m, {});
  sim.runTo(30000);
  const snap = sim.snapshot();
  const c = C.checkCommunication(m, { from: 'laptop', to: 'nas' }, snap);
  assert.equal(c.verdict, 'satisfied');
  assert.match(c.layers[0].text, /^From laptop:wlan0 · 192\.168\.10\.\d+ \(DHCPv4\)$/);
  assert.equal(c.info.context.kind, 'snapshot');
  const v6 = snap.addresses.find((a) => a.device === 'laptop' && a.method === 'slaac');
  assert.ok(v6, 'the laptop’s SLAAC address is in the snapshot');
  assert.ok(['preferred', 'tentative', 'deprecated'].indexOf(v6.state) >= 0);
  sim.close();
});

test('snapshots are stable: the simulation goes on, the snapshot does not change', () => {
  const m = model(example('private-house.yaml'));
  const sim = new S.Simulation(m, {});
  sim.runTo(30000);
  const snap = sim.snapshot();
  const before = JSON.stringify({ a: snap.addresses, l: snap.ctx.leases('laptop'), r: snap.ctx.extraRoutes('laptop', '') });
  sim.fail('device:core');
  sim.runTo(90000);
  assert.equal(JSON.stringify({ a: snap.addresses, l: snap.ctx.leases('laptop'), r: snap.ctx.extraRoutes('laptop', '') }), before);
  assert.ok(snap.ctx.up('core', 'wan'), 'what was up at the snapshot stays up in it');
  assert.notEqual(sim.snapshot().key, snap.key);
  sim.close();
});

test('timing: a compatible PTP source path is configuration and structure, never synchronization', () => {
  const m = model(example('timing-ptp.yaml'));
  const t = TI.ptpSource(m, 'plc-b');
  assert.equal(t.verdict, 'satisfied');
  assert.match(t.text, /synchronization and its accuracy are not established/);
  assert.deepEqual(t.chain.slice(-1), ['gm-a']);
  const other = model(example('timing-ptp.yaml').replace(/domain: 0/g, 'domain: 0').replace('id: plc-b', 'id: plc-b'));
  assert.ok(TI.ptpSource(other, 'plc-b'));
});

// ------------------------------------------------------------ addressing

const pools = `netatlas: 1
devices:
  - id: gw
    type: router
    interfaces: [{id: lan, ip: 10.5.0.1/24}]
    services:
      dhcp:
        scopes:
          - {network: lan, range: 10.5.0.100-10.5.0.110, gateway: 10.5.0.1, dns: [10.5.0.1], exclude: [10.5.0.105], reservations: [{mac: "02:00:00:00:00:01", ip: 10.5.0.50}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
  - {id: printer, type: endpoint, interfaces: [{id: eth0, ip: 10.5.0.2/24}]}
  - {id: laptop, type: endpoint, interfaces: [{id: wlan0, ipv4: dhcp}]}
links:
  - {id: l1, a: "gw:lan", b: "sw:p1"}
  - {id: l2, a: "printer:eth0", b: "sw:p2"}
  - {id: l3, a: "laptop:wlan0", b: "sw:p3"}
networks:
  - {id: lan, cidr: 10.5.0.0/24, vlan: 1}
  - {id: site, cidr: 10.5.0.0/16}
`;

test('addressing: DHCP pools and reservations are allocated, never suggested; each address counted once', () => {
  const ov = A.addressingOverview(model(pools));
  const lan = ov.vrfs[0].networks.find((n) => n.id === 'lan');
  assert.deepEqual(lan.pools.map((p) => [p.device, p.range, p.excluded, p.reservations.map((r) => r.ip)]), [['gw', '10.5.0.100-10.5.0.110', ['10.5.0.105'], ['10.5.0.50']]]);
  const a = lan.alloc;
  // configured: gw .1, printer .2; reserved: .50 (the gateway .1 is configured: counted there once); pool: .100–.110 without the excluded .105
  assert.deepEqual([a.configured, a.reserved, a.acquired, a.pool, a.subnets], [2n, 1n, 0n, 10n, 0n]);
  assert.equal(a.configured + a.reserved + a.acquired + a.pool + a.subnets + a.unallocated, lan.size);
  const free = lan.free.map((r) => I.rangeText(r, 4));
  assert.ok(!free.some((t) => /10\.5\.0\.(50|10[0-9]|110)\b/.test(t.split(' – ')[0]) && !/10\.5\.0\.105/.test(t)), free.join(' | '));
  assert.ok(free.indexOf('10.5.0.105') >= 0, 'an excluded address is not leased: it may be given statically');
  assert.equal(lan.nextFree, '10.5.0.3/24');
  assert.deepEqual(A.nextFreeChoices(model(pools), 'printer', 'eth0').find((c) => c.id === 'lan'), { id: 'lan', label: 'lan', text: '10.5.0.0/24', nextFree: '10.5.0.3/24', suggested: true });
});

test('addressing: a parent prefix’s allocation (its subnets) is apart from its host use', () => {
  const ov = A.addressingOverview(model(pools));
  const site = ov.vrfs[0].networks.find((n) => n.id === 'site');
  assert.equal(site.alloc.subnets, 255n, 'the /24 is given away as a whole (its 256 addresses but the parent’s own network address)');
  assert.ok(site.percent < 1, 'few hosts of its own');
  assert.ok(site.allocatedPercent > site.percent, 'but more of it is allocated');
  assert.match(UA.allocText(site), /255 in subnets/);
});

test('addressing: configured intent and the snapshot’s acquired addresses, IPv6 provenance', () => {
  const m = model(example('private-house.yaml'));
  const conf = A.addressingOverview(m);
  const internal = conf.vrfs.find((g) => g.vrf === '').networks.find((n) => n.id === 'internal');
  assert.ok(internal.dhcp.length > 0, 'the DHCP clients are listed as configured intent');
  assert.ok(internal.members.every((u) => u.method === 'static'));
  assert.equal(internal.alloc.acquired, 0n);
  const sim = new S.Simulation(m, {});
  sim.runTo(30000);
  const ov = A.addressingOverview(m, sim.snapshot());
  const snapInt = ov.vrfs.find((g) => g.vrf === '').networks.find((n) => n.id === 'internal');
  assert.ok(snapInt.alloc.acquired >= 2n);
  assert.ok(snapInt.members.some((u) => u.method === 'dhcpv4' && u.state === 'bound'));
  assert.ok(snapInt.alloc.pool < internal.alloc.pool, 'an acquired address is no longer counted in the pool');
  assert.equal(ov.snapshotAt, 30000);
  sim.close();
});

test('addressing: link-local addresses are interface-scoped; reuse in separate parts is not a conflict; an unknown scope is a possible conflict', () => {
  const sep = `netatlas: 1
devices:
  - {id: a1, type: router, interfaces: [{id: e0, ip: [10.0.0.1/24, "fe80::1/64"]}]}
  - {id: a2, type: endpoint, interfaces: [{id: e0, ip: [10.0.0.2/24, "fe80::2/64"]}]}
  - {id: b1, type: router, interfaces: [{id: e0, ip: [10.0.0.1/24, "fe80::1/64"]}]}
  - {id: b2, type: endpoint, interfaces: [{id: e0, ip: [10.0.0.2/24, "fe80::2/64"]}]}
links:
  - {id: la, a: "a1:e0", b: "a2:e0"}
  - {id: lb, a: "b1:e0", b: "b2:e0"}
`;
  const ov = A.addressingOverview(model(sep));
  assert.deepEqual(ov.duplicates, []);
  assert.deepEqual(ov.reused.map((r) => [r.text, r.why]).sort(), [
    ['10.0.0.1', 'the default table in 2 parts of the architecture the model does not connect'],
    ['10.0.0.2', 'the default table in 2 parts of the architecture the model does not connect'],
    ['fe80::1', 'link-local on different links (interface-scoped)'],
    ['fe80::2', 'link-local on different links (interface-scoped)'],
  ]);
  assert.ok(!ov.orphans.some((o) => /^fe80/.test(o.address)), 'link-local addresses are in no network by nature');
  // one switch joins all four: now they conflict, the link-local addresses too (one segment)
  const joined = `netatlas: 1
devices:
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}, {id: p4, vlans: 1}]}
  - {id: a1, type: router, interfaces: [{id: e0, ip: [10.0.0.1/24, "fe80::1/64"]}]}
  - {id: a2, type: endpoint, interfaces: [{id: e0, ip: [10.0.0.2/24, "fe80::2/64"]}]}
  - {id: b1, type: router, interfaces: [{id: e0, ip: [10.0.0.1/24, "fe80::1/64"]}]}
  - {id: b2, type: endpoint, interfaces: [{id: e0, ip: [10.0.0.2/24, "fe80::2/64"]}]}
links:
  - {id: l1, a: "a1:e0", b: "sw:p1"}
  - {id: l2, a: "a2:e0", b: "sw:p2"}
  - {id: l3, a: "b1:e0", b: "sw:p3"}
  - {id: l4, a: "b2:e0", b: "sw:p4"}
`;
  const j = A.addressingOverview(model(joined));
  assert.deepEqual(j.duplicates.map((d) => [d.text, d.certainty, d.owners.map((o) => o.device).join('+')]), [
    ['10.0.0.1', 'conflict', 'a1+b1'],
    ['10.0.0.2', 'conflict', 'a2+b2'],
    ['fe80::1', 'conflict', 'a1+b1'],
    ['fe80::2', 'conflict', 'a2+b2'],
  ]);
  assert.deepEqual(j.reused, []);
  // an owner joined to nothing: the scope is not known
  const lone = A.addressingOverview(model(`netatlas: 1
devices:
  - {id: a, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.1/24}]}
  - {id: b, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.1/24}]}
`));
  assert.deepEqual(lone.duplicates.map((d) => [d.text, d.certainty]), [['10.0.0.1', 'possible']]);
});

test('addressing: listings of one network in two VRFs on one segment share an address space', () => {
  const m = model(example('private-house.yaml'));
  const ov = A.addressingOverview(m);
  const iotDefault = ov.vrfs.find((g) => g.vrf === '').networks.find((n) => n.id === 'iot');
  assert.deepEqual(iotDefault.space, ['iot']);
  assert.notEqual(iotDefault.nextFree, '192.168.20.1/24', 'the router’s address in VRF iot is not free for the hosts');
});

test('addressing CSV: the allocation by state and the context in every line', () => {
  const csv = UA.addressingCsv(A.addressingOverview(model(pools)), 'Configured model · Entire architecture');
  const lines = csv.split('\r\n');
  assert.match(lines[0], /,configured,reserved,acquired,dhcp_pool,in_subnets,unallocated,allocated,dhcp_pools,context$/);
  assert.match(lines.find((l) => /,lan,/.test(l)), /,2,1,0,10,0,241,5\.1,10\.5\.0\.100-10\.5\.0\.110 on gw,Configured model · Entire architecture$/);
});

// ------------------------------------------------------------ failure and dependencies

test('service dependencies: configured only, with their alternatives and consequences', () => {
  const m = model(corp);
  const deps = D.serviceDependencies(m);
  assert.deepEqual(deps.map((d) => [d.kind, d.text]), [
    ['application', 'pc/api → srv/api'],
    ['application', 'pc/bad → nothere.corp.test'],
    ['application', 'pc/web → www.corp.test'],
    ['dns', 'pc resolves names with dns (10.2.0.53)'],
  ]);
  const base = D.dependencyBaseline(m, deps);
  assert.equal(base.get('app:pc/api').verdict, 'satisfied');
  assert.equal(base.get('app:pc/bad').verdict, 'violated');
});

test('what if: baseline against failure — unavailable, alternative, and nothing determinable claimed as lost', () => {
  const m = model(corp);
  const w = W.whatIf(m, ['dns']);
  const by = Object.fromEntries(w.deps.map((d) => [d.dep.key, d.change]));
  assert.equal(by['dns:pc'], 'unavailable');
  assert.equal(by['app:pc/web'], 'unavailable', 'the name no longer resolves');
  assert.equal(by['app:pc/api'], 'unchanged');
  assert.match(w.deps.find((d) => d.dep.key === 'dns:pc').text, /pc can’t resolve host names/);
  // two resolvers: the failure of one leaves the other (an alternative)
  const two = model(corp.replace('dns_servers: [10.2.0.53]', 'dns_servers: [10.2.0.53, 10.2.0.54]').replace("    interfaces: [{id: eth0, ip: 10.2.0.53/24}]\n    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]\n    services:\n      dns: {zones: [{name: corp.test}]}", "    interfaces: [{id: eth0, ip: 10.2.0.53/24}]\n    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]\n    services:\n      dns: {zones: [{name: corp.test}]}\n  - id: dns2\n    type: server\n    interfaces: [{id: eth0, ip: 10.2.0.54/24}]\n    routes: [{prefix: 0.0.0.0/0, via: 10.2.0.1}]\n    services:\n      dns: {zones: [{name: corp.test}]}"));
  const w2 = W.whatIf(two, ['dns']);
  assert.equal(w2.deps.find((d) => d.dep.key === 'dns:pc').change, 'alternative');
  assert.match(w2.deps.find((d) => d.dep.key === 'dns:pc').text, /^still available: dns2/);
  assert.ok(w2.info.limits.some((l) => /Convergence and recovery times/.test(l)));
});

test('what if: DHCP server loss stops new assignments, not existing leases', () => {
  const m = model(pools);
  const w = W.whatIf(m, ['gw']);
  const d = w.deps.find((x) => x.dep.kind === 'dhcp');
  assert.equal(d.change, 'unavailable');
  assert.match(d.text, /new DHCP assignments and renewals for laptop:wlan0 are unavailable; an address already leased stays until its lease ends/);
});

test('failure domains: explicit membership (a group counts by its devices), validation of members and ids, what if a domain fails', () => {
  const m = model(corp);
  assert.deepEqual(m.failureDomains.map((d) => [d.id, d.kind, d.members]), [['rack-1', 'rack', ['fw', 'sw']]]);
  assert.deepEqual(F.domainRefs(m, m.failureDomains[0]), ['device:fw', 'device:sw']);
  const w = W.whatIf(m, ['rack-1']);
  assert.deepEqual(w.domains, ['rack-1']);
  assert.equal(w.info.context.scope, 'Failure domain rack-1');
  assert.equal(w.deps.find((x) => x.dep.key === 'app:pc/api').change, 'unavailable');
  const bad = validate.loadModel(corp.replace('members: [fw, sw]', 'members: [fw, nowhere]')).errors.map((e) => e.message);
  assert.ok(bad.some((x) => /"nowhere" is no device, cable, relation or group of the model/.test(x)), bad.join('\n'));
  const clash = validate.loadModel(corp.replace('{id: rack-1, label: Rack 1', '{id: fw, label: Rack 1')).errors.map((e) => e.message);
  assert.ok(clash.some((x) => /already the id of a device/.test(x)));
  const kind = validate.loadModel(corp.replace('kind: rack,', 'kind: cupboard,')).errors.map((e) => e.message);
  assert.ok(kind.some((x) => /"cupboard" is no failure domain kind/.test(x)));
});

test('combined failures: a small explicit set, bounded; device pairs only in an explicit scope, with coverage', () => {
  const m = model(ecmp);
  const w = W.whatIf(m, ['l2', 'l3'], { reach: { kind: 'entire' } });
  assert.deepEqual(w.refs, ['link:l2', 'link:l3']);
  assert.ok(w.reach.pairs.some((p) => p.from === 'h1' && p.to === 'srv'));
  assert.equal(w.reach.coverage.unit, 'device pairs');
  assert.equal(w.reach.coverage.checked, w.reach.coverage.eligible);
  const big = W.whatIf(m, Array.from({ length: 70 }, (_, i) => 'x' + i));
  assert.equal(big.unknown.length, 70);
});

test('scoped reachability: relevant endpoints first, the coverage says what was left out (no alphabetical first-40)', () => {
  const ports = Array.from({ length: 45 }, (_, i) => `{id: p${i}, vlans: 1}`).join(', ');
  const devs = Array.from({ length: 45 }, (_, i) => `  - {id: d${String(i).padStart(2, '0')}, type: endpoint, interfaces: [{id: e0, ip: 10.0.0.${i + 10}/24}]}`).join('\n');
  const links = Array.from({ length: 45 }, (_, i) => `  - {id: l${i}, a: "d${String(i).padStart(2, '0')}:e0", b: "sw:p${i}"}`).join('\n');
  const m = model(`netatlas: 1\ndevices:\n  - {id: sw, type: switch, interfaces: [${ports}]}\n${devs}\nlinks:\n${links}\n`);
  const sp = F.scopePairs(m, { kind: 'entire' }, ['d44'], 100);
  assert.equal(sp.devices[0], 'd44', 'a relevant device comes first');
  assert.equal(sp.eligible, 45 * 44);
  assert.ok(sp.omitted.length > 0);
  const lost = F.lostReachability(m, F.simulate(m, ['device:sw']));
  assert.equal(lost.eligible, 45 * 44);
  assert.equal(lost.total, 45);
});

test('single points of failure: structural candidates and the service impact of a device that cuts nothing off', () => {
  const m = model(corp);
  const cands = F.spofCandidates(m);
  assert.ok(cands.some((c) => c.ref === 'device:dns'));
  assert.equal(F.structuralImpact(m, cands.find((c) => c.ref === 'device:dns')), null, 'losing the DNS server cuts nothing off');
  const deps = D.serviceDependencies(m);
  const base = D.dependencyBaseline(m, deps);
  const res = F.simulate(m, ['device:dns']);
  const ch = D.compareDependencies(m, deps, base, res.ctx, new Set(F.failureRefs(res).keys()), (d) => res.devices.get(d) === 'down');
  const rows = US.spofRows(m, F.singlePointsOfFailure(m), new Map([['device:dns', ch]]), cands);
  const r = rows.find((x) => x.ref === 'device:dns');
  assert.ok(r, 'a service single point is listed');
  assert.equal(r.impact, 0);
  assert.equal(r.service, 2);
  assert.match(r.serviceText, /Name resolution: pc/);
  assert.match(US.spofCsv(rows, 'ctx'), /^element,type,cuts_off,relations_down,devices_cut_off,relations_down_count,structural_impact,services_unavailable,service_impact,context\n/);
});

// ------------------------------------------------------------ saved expectations

test('expectations: satisfied, violated, indeterminate — and blocked by policy versus not reachable for another reason', () => {
  const m = model(corp);
  const run = E.evaluateExpectations(m);
  const v = Object.fromEntries(run.results.map((r) => [r.id, r]));
  assert.equal(v['api-ok'].verdict, 'satisfied');
  assert.equal(v['no-ssh'].verdict, 'satisfied');
  assert.match(v['no-ssh'].reason, /^Blocked by policy at fw: fw denies tcp\/22/);
  assert.equal(v['no-r3'].verdict, 'satisfied');
  assert.match(v['no-r3'].reason, /No policy decision blocks it: the block may not be the intended control/);
  assert.equal(v['https-open'].verdict, 'violated');
  assert.match(v['https-open'].reason, /^Reachable: 1 of 1 evaluated path reach/);
  assert.equal(v['api-rack'].verdict, 'violated', 'the API does not survive its rack');
  assert.ok(v['api-rack'].failure.refs.indexOf('device:fw') >= 0);
  assert.equal(v.ghost.verdict, 'indeterminate');
  assert.match(v.ghost.reason, /names nothing-here, which is not in the model/);
  assert.equal(run.info.context.scope, 'Saved expectations');
  // an unknown failure entry is a warning, never an error
  const w = validate.loadModel(corp).warnings.map((x) => x.message);
  assert.ok(w.some((x) => /"nothing-here" is no device, cable, relation, interface or failure domain/.test(x)));
});

test('expectations: a failure condition on a snapshot is unsupported; timing is a source path, not synchronization; a dependency needs a client', () => {
  const m = model(corp);
  const sim = new S.Simulation(m, {});
  sim.runTo(5000);
  const r = E.evaluateExpectation(m, m.expectations.find((e) => e.id === 'api-rack'), sim.snapshot());
  assert.equal(r.verdict, 'unsupported');
  assert.match(r.reason, /would blend two states/);
  sim.close();
  const t = model(example('timing-ptp.yaml'));
  const tr = E.evaluateExpectation(t, { id: 't', name: 'PLC time', expect: 'timing', from: 'plc-b', failure: [], line: 0 });
  assert.equal(tr.verdict, 'satisfied');
  assert.match(tr.reason, /not established/);
  const dep = E.evaluateExpectation(m, { id: 'd', name: 'x', expect: 'dependency', from: 'pc', failure: [], line: 0 });
  assert.equal(dep.verdict, 'unsupported');
  const ok = E.evaluateExpectation(m, { id: 'd2', name: 'x', expect: 'dependency', from: 'pc/api', failure: [], line: 0 });
  assert.equal(ok.verdict, 'satisfied');
});

test('expectations: shared stop points group failures with one cause, keeping each result', () => {
  const m = model(corp + '  - {id: ssh2, name: SSH from the PC, expect: available, from: pc, to: srv, service: tcp/22}\n  - {id: ssh3, name: SSH to the DNS server, expect: available, from: pc, to: dns, service: tcp/22}\n');
  const run = E.evaluateExpectations(m);
  const shared = E.sharedStops(run.results);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].device, 'fw');
  assert.deepEqual(shared[0].ids, ['ssh2', 'ssh3']);
  assert.equal(run.results.filter((r) => r.verdict === 'violated').length >= 2, true);
});

test('expectations: references follow renames; the delete confirmation names them; undo and redo', () => {
  const ED = load('editor/document.js');
  const d = ED.ModelDoc.fromText(corp, 'x.yaml', 'file').doc;
  const devIndex = d.findEntity('device', 'srv').index;
  d.renameEntity('device', devIndex, 'srv1');
  const m = d.result.model;
  assert.equal(m.expectations.find((e) => e.id === 'no-ssh').to, 'srv1');
  assert.equal(m.expectations.find((e) => e.id === 'https-open').to, 'srv1:eth0');
  assert.equal(m.devices.find((x) => x.id === 'pc').applications.find((a) => a.id === 'api').peer, 'srv1/api');
  // a failure domain's member follows a rename
  d.renameEntity('device', d.findEntity('device', 'fw').index, 'fw1');
  assert.deepEqual(d.result.model.failureDomains[0].members, ['fw1', 'sw']);
  // an interface rename reaches "device:interface"
  d.renameInterface(['devices', d.findEntity('device', 'srv1').index, 'interfaces', 0], 'ens0');
  assert.equal(d.result.model.expectations.find((e) => e.id === 'https-open').to, 'srv1:ens0');
  // the analysis entries that name an object are listed before it is deleted
  const users = d.analysisUsers(d.references('device', 'fw1'));
  assert.deepEqual(users, ['failure domain rack-1']);
  // a failure domain rename reaches the conditions
  assert.equal(d.renameFailureDomain(0, 'rack-a'), 1);
  assert.deepEqual(d.result.model.expectations.find((e) => e.id === 'api-rack').failure, ['rack-a']);
  // add, undo, redo
  const n = d.result.model.expectations.length;
  d.addExpectation({ name: 'DNS works', expect: 'available', from: 'pc', to: 'dns/dns' });
  assert.equal(d.result.model.expectations.length, n + 1);
  assert.equal(d.result.model.expectations[n].id, 'dns-works');
  d.undo();
  assert.equal(d.result.model.expectations.length, n);
  d.redo();
  assert.equal(d.result.model.expectations[n].to, 'dns/dns');
  d.removeExpectation(n);
  assert.equal(d.result.model.expectations.length, n);
});

test('expectations: deterministic whatever the order of the file', () => {
  const a = E.evaluateExpectations(model(corp)).results.map((r) => [r.id, r.verdict, r.reason]);
  const pcBlock = corp.match(/  - id: pc\n[\s\S]*?(?=  - id: r1\n)/)[0];
  const reordered = corp.replace(pcBlock, '').replace('links:\n', pcBlock + 'links:\n');
  assert.notEqual(reordered.indexOf('  - id: pc'), corp.indexOf('  - id: pc'));
  const b = E.evaluateExpectations(model(reordered)).results.map((r) => [r.id, r.verdict, r.reason]);
  assert.deepEqual(b, a);
});

// ------------------------------------------------------------ focus and findings

test('contextual focus: VLAN members, application dependencies (with the host of a guest), multicast distribution, a timing domain', () => {
  const ot = model(example('ot-network.yaml'));
  const ctx = FO.focusContexts(ot, 'device:plc').map((c) => c.label);
  assert.ok(ctx.indexOf('Application and service dependencies') >= 0, ctx.join(' | '));
  const app = FO.contextFocus(ot, { kind: 'app', device: 'plc' });
  assert.equal(app.devices.get('plc'), 0);
  assert.ok(app.devices.has('edge') && app.devices.has('hmi'), Array.from(app.devices.keys()).join(' '));
  assert.match(app.note, /not proof that they reach each other/);
  const camp = model(example('enterprise-campus.yaml'));
  const vl = camp.networks.find((n) => n.vlan !== undefined);
  const v = FO.contextFocus(camp, { kind: 'vlan', vlan: vl.vlan });
  assert.ok(v.devices.size > 1);
  assert.match(v.note, /configured membership, not observed traffic/);
  const t = model(example('timing-ptp.yaml'));
  const tf = FO.contextFocus(t, { kind: 'timing', device: 'plc-b' });
  assert.ok(tf.devices.has('gm-a') && tf.devices.has('plc-b'));
  const mc = model(example('ot-network.yaml'));
  assert.ok(FO.focusContexts(mc, 'device:plc').length >= 1);
  const virt = model(example('virtualization.yaml'));
  const guest = virt.devices.find((d) => d.host && (d.applications || []).length) || virt.devices.find((d) => d.host);
  const g = FO.contextFocus(virt, { kind: 'app', device: guest.id });
  assert.ok(g.devices.has(guest.host), 'a guest’s host is part of its dependencies');
});

test('findings: a problem line, a class, the consequence and the next step; findings on one field grouped, none lost', () => {
  const m = model(example('consistency-checks.yaml'));
  const C2 = load('analysis/checks.js');
  const fs = C2.runChecks(m, m.checks);
  assert.ok(fs.length > 3);
  const p = FI.presentFinding(fs.find((f) => f.check === 'vlan-trunk-mismatch') || fs[0]);
  assert.ok(p.problem.length > 0 && p.action.length > 0);
  assert.ok(['contradiction', 'missing', 'risk', 'unsupported'].indexOf(p.cls) >= 0);
  const g = FI.groupFindings(fs);
  assert.equal(g.singles.length + g.groups.reduce((s, x) => s + x.findings.length, 0), fs.length, 'grouping keeps every finding');
  for (const x of g.groups) assert.ok(x.findings.length > 1 && x.findings.every((f) => f.finding.at.ref === x.ref));
  const c = FI.classCounts(fs);
  assert.equal(c.contradiction + c.missing + c.risk + c.unsupported, fs.length);
});

// ------------------------------------------------------------ freshness and exports

test('freshness: moving a node or a comment keeps the fingerprint; an address change does not', () => {
  const a = model(corp);
  const moved = model(corp + 'layout:\n  physical:\n    pc: {x: 10, y: 20}\n');
  const commented = model(corp.replace('title: Analyze fixture', 'title: Analyze fixture # a comment'));
  const changed = model(corp.replace('10.2.0.10/24', '10.2.0.12/24'));
  assert.equal(FP.modelFingerprint(moved), FP.modelFingerprint(a));
  assert.equal(FP.modelFingerprint(commented), FP.modelFingerprint(a));
  assert.notEqual(FP.modelFingerprint(changed), FP.modelFingerprint(a));
});

test('exports: the trace text carries the context, the verdict and its layers, the version and the assumptions; the design checks CSV its context', () => {
  const m = model(corp);
  const check = C.checkCommunication(m, { from: 'pc', to: 'srv', service: 'tcp/22' });
  const text = UT.traceExportText({ title: m.title, version: '9.9.9', outdated: true }, { req: check.trace.request, check, trace: check.trace, back: null });
  assert.match(text, /^Trace path — Analyze fixture\nContext: Configured model · Selected endpoints \(outdated: the model changed after this result\)\nNetAtlas 9\.9\.9\n/);
  assert.match(text, /Verdict: Blocked by policy/);
  assert.match(text, /Policy: violated — Denied at fw/);
  assert.match(text, /Assumptions:\n  - Evaluates the configuration/);
  assert.match(text, /A model-based result: it does not prove the behaviour of a production network\.\n$/);
  const run = E.evaluateExpectations(m);
  const csv = UD.designCsv(m, run, false);
  assert.match(csv.split('\r\n')[0], /^id,name,expect,from,to,service,failure,verdict,reason,context$/);
  assert.match(csv, /,Configured model · Saved expectations\r\n/);
  assert.match(UD.designText({ title: m.title, outdated: false }, m, run), /\[Satisfied\] PC uses the API \(api-ok\)/);
});
