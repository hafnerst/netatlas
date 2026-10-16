// DHCP and DNS servers (validation/netservices.ts, analysis/checks-
// netservices.ts, analysis/sim/netsvc.ts): a server's services are off by
// default and show what they still need; scopes are checked against the
// model (inside the network, without the gateway or a static address, not
// overlapping, exclusions and reservations); zones and their records; the
// relay rule; the records the model's DNS names give a zone; a client that
// reaches no server. In the simulation: DORA at the start, in parallel,
// directly and through a relay; reservations and exclusions; renewal,
// rebinding and the end of a lease; an exhausted pool; retries with backoff
// and the link-local fallback; DNS queries, NXDOMAIN, timeouts and the
// cache; name resolution as a dependency of a connection; the lease, cache
// and zone tables; the leases the diagram marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model, example } from './helpers.mjs';

const V = load('validation/validate.js');
const S = load('analysis/sim/simulation.js');
const C = load('analysis/checks.js');
const NS = load('model/netservices.js');

const CAMPUS = example('campus-services.yaml');
const sim = (text, opts) => new S.Simulation(model(text), opts);
const ev = (s, f) => s.events().filter(f);
const errs = (t) => V.loadModel(t).errors.map((e) => e.message);
const warns = (t) => V.loadModel(t).warnings.map((e) => e.message);

/** A server in a LAN with one client; `svc` is its services block, `more` extra YAML. */
const LAN = (svc, more = {}) => `netatlas: 1
title: lan
devices:
  - {id: srv, type: ${more.type || 'server'}, interfaces: [{id: eth0, ip: 10.0.0.10/24}]${svc !== undefined ? ', services: ' + svc : ''}}
  - {id: pc, type: endpoint, interfaces: [{id: eth0, dhcp: true${more.pc || ''}}]${more.pcDev || ''}}
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}]}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
links:
  - {id: a, a: "srv:eth0", b: "sw:p1"}
  - {id: b, a: "pc:eth0", b: "sw:p2"}
  - {id: c, a: "r1:g0", b: "sw:p3"}
networks:
  - {id: lan, cidr: 10.0.0.0/24}
${more.tail || ''}`;

const SCOPE = (x = '') => `{dhcp: {scopes: [{network: lan, range: 10.0.0.100-10.0.0.110, gateway: 10.0.0.1, dns: [10.0.0.10]${x}}]}}`;

test('the services: off by default; enabled, what they still need is an error; only servers (a server, a VM, a container) run them', () => {
  assert.equal(V.loadModel(LAN()).model.index.devices.get('srv').netServices, undefined);
  assert.deepEqual(errs(LAN(SCOPE())), []);
  assert.match(errs(LAN('{dhcp: {}}')).join('|'), /the DHCP server of "srv" needs a scope: add one \(its network, range, default gateway and DNS servers\)/);
  const e = errs(LAN('{dhcp: {scopes: [{lease: 1h}]}}')).join('|');
  for (const what of ['network', 'address range', 'default gateway', 'DNS servers']) assert.match(e, new RegExp(`scope 1 of "srv" needs its ${what}`), what);
  assert.match(errs(LAN('{dns: {}}')).join('|'), /the DNS server of "srv" needs a zone: add one \(its domain name, e\.g\. hq\.example\)/);
  assert.match(errs(LAN(SCOPE(), { type: 'storage' })).join('|'), /"srv" is not a server: DHCP and DNS servers run on a server, a VM or a container/);
  // a VM and a container run them too (on their host, through its virtual networking)
  const guest = (t) => `netatlas: 1
devices:
  - {id: srv, type: ${t}, host: h, services: ${SCOPE()}, logical_interfaces: [{id: eth0, type: ${t === 'vm' ? 'vnic, port_group: pg' : 'veth, network: n'}, ip: 10.0.0.10/24}]}
  - id: h
    type: server
    services: ${t === 'vm' ? '{hypervisor: {platform: kvm, vswitches: [{name: br0, type: linux_bridge, uplinks: [eth0], teaming: active_standby, port_groups: [{name: pg, vlans: 1}]}]}}' : '{container_engine: {engine: docker, networks: [{name: n, driver: macvlan, parent: eth0, subnet: 10.0.0.0/24, gateway: 10.0.0.1, mode: bridge}]}}'}
    interfaces: [eth0]
  - {id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}]}
links:
  - {id: a, a: "h:eth0", b: "r1:g0"}
networks:
  - {id: lan, cidr: 10.0.0.0/24}
`;
  for (const t of ['vm', 'container']) assert.deepEqual(errs(guest(t)), [], t);
  // the lease time: 1 day unless written
  assert.equal(NS.DEFAULT_LEASE, 86400000);
  assert.equal(V.loadModel(LAN(SCOPE(', lease: 2h'))).model.index.devices.get('srv').netServices.dhcp.scopes[0].lease, 7200000);
});

test('scopes with the model: the range inside the network, without the gateway or a static address, no overlaps; exclusions and reservations', () => {
  const m = (x, more) => errs(LAN(`{dhcp: {scopes: [{network: lan, range: ${x.range || '10.0.0.100-10.0.0.110'}, gateway: ${x.gw || '10.0.0.1'}, dns: [10.0.0.10]${x.more || ''}}${x.second || ''}]}}`, more)).join('|');
  assert.match(m({ range: '10.0.1.5-10.0.1.9' }), /the range 10\.0\.1\.5-10\.0\.1\.9 is not inside the network lan \(10\.0\.0\.0\/24\)/);
  assert.match(m({ range: '10.0.0.1-10.0.0.9' }), /contains the default gateway 10\.0\.0\.1/);
  assert.match(m({ range: '10.0.0.5-10.0.0.20' }), /contains 10\.0\.0\.10, statically assigned to srv:eth0/);
  assert.match(m({ range: '10.0.0.110-10.0.0.100' }), /the range starts after it ends/);
  assert.match(m({ gw: '10.9.9.9' }), /the default gateway 10\.9\.9\.9 is not in the network lan/);
  assert.match(m({ second: ', {network: lan, range: 10.0.0.105-10.0.0.120, gateway: 10.0.0.1, dns: [10.0.0.10]}' }), /the range 10\.0\.0\.105-10\.0\.0\.120 overlaps scope 1 of "srv"/);
  assert.match(m({ more: ', exclude: [10.0.0.200]' }), /the excluded address 10\.0\.0\.200 is not in the range/);
  assert.match(m({ more: ', reservations: [{mac: "02:00:00:00:00:01", ip: 10.0.0.10}]' }), /the reservation of 10\.0\.0\.10 \(02:00:00:00:00:01\): the address is statically assigned to srv:eth0/);
  assert.match(m({ more: ', reservations: [{mac: nope, ip: 10.0.0.50}]' }), /"nope" is not a MAC address/);
  assert.match(errs(LAN('{dhcp: {scopes: [{network: nowhere, range: 10.0.0.100-10.0.0.110, gateway: 10.0.0.1, dns: [10.0.0.10]}]}}')).join('|'), /"nowhere" is not a network of the model/);
  assert.match(m({ more: ', simulation: {record_ttl: 60}' }), /"record_ttl" \(record ttl\) is set per DNS zone: in the zone’s simulation:, not on a DHCP scope/);
  assert.deepEqual(errs(LAN(SCOPE(', simulation: {offer_delay: 50ms, ping_check: on}'))), []);
});

test('zones: records inside the zone, no duplicates, no CNAME beside another record; values that are addresses of the model; the listening address; the records the DNS names give', () => {
  const Z = (recs, extra = '') => LAN(`{dns: {zones: [{name: lan.example, records: [${recs}]}]${extra}}}`, { tail: '' }).replace("{id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}]}", "{id: r1, type: router, interfaces: [{id: g0, ip: 10.0.0.1/24}], dns_names: [{name: gw.lan.example, interfaces: [g0]}]}");
  assert.deepEqual(errs(Z('{name: www, type: CNAME, value: gw.lan.example}')), []);
  assert.match(errs(Z('{name: x.other.example., type: A, value: 10.0.0.1}')).join('|'), /x\.other\.example\. is outside the zone lan\.example/);
  assert.match(errs(Z('{name: gw, type: A, value: 10.0.0.1}')).join('|'), /gw\.lan\.example A 10\.0\.0\.1 is written twice \(or is already derived from a DNS name of the model\)/);
  assert.match(errs(Z('{name: gw, type: CNAME, value: srv.lan.example}')).join('|'), /gw\.lan\.example: a CNAME cannot share its name with another record/);
  assert.match(errs(Z('{name: x, type: MX, value: mail}')).join('|'), /record type "MX": a record is A, AAAA or CNAME/);
  assert.match(errs(Z('{name: x, type: A, value: 2001:db8::1}')).join('|'), /an A record's value is an IPv4 address/);
  assert.match(warns(Z('{name: ghost, type: A, value: 10.0.0.77}')).join('|'), /ghost\.lan\.example A 10\.0\.0\.77: no interface of the model has this address/);
  assert.match(errs(Z('', ', listen: 10.0.0.99')).join('|'), /"srv" listens on 10\.0\.0\.99, which is not one of its addresses \(10\.0\.0\.10\)/);
  const m = model(Z(''));
  assert.deepEqual(NS.derivedRecords(m, 'lan.example').map((r) => `${r.fqdn} ${r.type} ${r.value} | ${r.source}`), ['gw.lan.example A 10.0.0.1 | r1:g0 (DNS name gw.lan.example)']);
  // a host's static DNS servers; a relay only on a routed interface with an address
  assert.deepEqual(V.loadModel(LAN(SCOPE(), { pcDev: ', dns_servers: [10.0.0.10]' })).model.index.devices.get('pc').dnsServers, ['10.0.0.10']);
  assert.match(errs(LAN(SCOPE(), { pc: ', dhcp_relay: [10.0.0.10]' })).join('|'), /a DHCP relay is a routed interface's .* "eth0" of "pc" is on a device that does not route/);
});

test('the checks: a DHCP client no server reaches (same broadcast domain or through a relay), a relay to no server', () => {
  const ids = (t) => C.runChecks(model(t)).filter((f) => /^dhcp/.test(f.check)).map((f) => f.check + ': ' + f.message);
  assert.deepEqual(ids(LAN(SCOPE())), [], 'the server is in the client’s broadcast domain');
  assert.deepEqual(ids(CAMPUS), [], 'pc2 through core’s relay');
  // without the relay, pc2 has no server
  assert.match(ids(CAMPUS.replace(', dhcp_relay: [10.10.10.10]', '')).join('|'), /dhcp-no-server: pc2:eth0 takes its address by DHCP, but no DHCP server of the model reaches it/);
  assert.match(ids(CAMPUS.replace('dhcp_relay: [10.10.10.10]', 'dhcp_relay: [10.10.10.99]')).join('|'), /dhcp-relay-no-server: core:Vlan20 relays DHCP to 10\.10\.10\.99, which is no DHCP server of the model/);
  // a model without DHCP servers says nothing (its DHCP is outside the model)
  assert.deepEqual(ids(LAN()), []);
});

test('DORA at the start: every client in parallel once its link is up, one directly, one through the relay (giaddr); the reservation and the exclusion', () => {
  const s = sim(CAMPUS);
  s.runTo(5000);
  const disc = ev(s, (e) => e.kind === 'message' && e.what === 'DHCPDISCOVER' && /from 0\.0\.0\.0:68 to 255\.255\.255\.255:67/.test(e.detail));
  assert.deepEqual(disc.map((e) => e.device).sort(), ['lap1', 'pc1', 'pc2']);
  assert.ok(Math.max(...disc.map((e) => e.t)) - Math.min(...disc.map((e) => e.t)) < 1, 'together');
  assert.ok(disc.every((e) => e.t >= 2000), 'after the link-up delay');
  assert.ok(ev(s, (e) => e.device === 'core' && /core relays DHCPDISCOVER from pc2 to the DHCP server 10\.10\.10\.10 as unicast, with giaddr 10\.10\.20\.1 \(its Vlan20\)/.test(e.detail)).length === 1);
  assert.ok(ev(s, (e) => e.device === 'core' && /core passes DHCPACK 10\.10\.20\.100 · lease 4 h from the server on to pc2 as a broadcast on Vlan20/.test(e.detail)).length === 1);
  const order = ['DHCPDISCOVER', 'DHCPOFFER', 'DHCPREQUEST', 'DHCPACK'].map((w) => ev(s, (e) => e.kind === 'message' && e.what === w && /pc1/.test(e.detail))[0].t);
  assert.ok(order.every((t, i) => i === 0 || t > order[i - 1]), JSON.stringify(order));
  assert.ok(ev(s, (e) => e.what === 'DHCPOFFER' && e.hdr && e.hdr && /^DHCPOFFER 10\.10\.10\.100 · lease 1 d$/.test(e.hdr.payload || '') || /DHCPOFFER from srv \(10\.10\.10\.10\) to pc1/.test(e.detail)).length >= 1);
  assert.deepEqual(s.leases(), [
    { dev: 'lap1', iface: 'eth0', text: '10.10.10.21/24', kind: 'dhcp' },
    { dev: 'pc1', iface: 'eth0', text: '10.10.10.100/24', kind: 'dhcp' },
    { dev: 'pc2', iface: 'eth0', text: '10.10.20.100/24', kind: 'dhcp' },
  ], 'lap1 gets its reservation');
  // the lease table of the server
  assert.deepEqual(s.leaseTable('srv').map((r) => `${r.ip} ${r.mac} ${r.client} ${r.state}`), ['10.10.10.21 02:00:00:00:10:21 lap1:eth0 bound', `10.10.10.100 ${s.leaseTable('srv')[1].mac} pc1:eth0 bound`, `10.10.20.100 ${s.leaseTable('srv')[2].mac} pc2:eth0 bound`]);
  // the model is unchanged
  assert.deepEqual(s.model.index.interfaces.get('pc1:eth0').addresses, []);
  // an excluded address is skipped
  const ex = sim(LAN(SCOPE(', exclude: [10.0.0.100]')));
  ex.runTo(4000);
  assert.deepEqual(ex.leases().map((l) => l.text), ['10.0.0.101/24']);
});

test('everything the client sends waits for its lease; a session of its relations starts with it', () => {
  const s = sim(CAMPUS);
  s.runTo(5000);
  assert.ok(ev(s, (e) => e.kind === 'wait' && /^web-pc1: HTTPS between pc1 and web waits for pc1's DHCP lease \(pc1:eth0\)$/.test(e.detail)).length === 1);
  const bound = ev(s, (e) => e.device === 'pc1' && e.what === 'Bound')[0].t;
  assert.ok(ev(s, (e) => e.device === 'pc1' && e.protocol === 'https' && e.kind === 'message').every((e) => e.t >= bound));
  // a test sent before the lease waits for it
  const s2 = sim(CAMPUS);
  s2.runTo(500);
  const t = s2.sendTest({ from: 'pc1', to: '10.10.30.10', kind: 'icmp' });
  assert.equal(t.result, 'waiting for a DHCP lease on pc1:eth0');
  s2.runTo(6000);
  assert.equal(t.ok, true, t.result);
  assert.ok(ev(s2, (e) => e.kind === 'wait' && /^Test pc1 → 10\.10\.30\.10 ICMP echo waiting for a DHCP lease on pc1:eth0$/.test(e.detail)).length === 1);
});

test('the lease lifecycle: renew at T1 (unicast), rebind at T2 (broadcast), the end of the lease (the address goes, DISCOVER again)', () => {
  const s = sim(LAN(SCOPE(', lease: 2min')));
  s.runTo(4000);
  const bound = ev(s, (e) => e.what === 'Bound')[0].t;
  s.runTo(bound + 61000);
  assert.ok(ev(s, (e) => e.what === 'DHCPREQUEST' && /renewing at T1 \(half the lease\), unicast to its server 10\.0\.0\.10/.test(e.detail)).length === 1);
  assert.ok(ev(s, (e) => e.what === 'Renewed').length === 1);
  // the server off: no renewal; rebind at 7/8; at the end the address goes
  s.engine.powerOff('srv');
  const t2 = s.now;
  s.runTo(t2 + 120000);
  assert.ok(ev(s, (e) => e.t > t2 && e.what === 'DHCPREQUEST' && /rebinding at T2 \(7\/8 of the lease\), broadcast to any server/.test(e.detail)).length >= 1);
  assert.ok(ev(s, (e) => e.what === 'Lease expired' && /the interface has no address now/.test(e.detail)).length === 1);
  assert.deepEqual(s.leases(), []);
  assert.ok(ev(s, (e) => e.t > t2 && e.what === 'DHCPDISCOVER').length >= 1);
});

test('an exhausted pool does not answer; the client retries with backoff (4, 8, 16, 32 s), pauses, and takes a link-local address when its fallback is on', () => {
  const two = LAN('{dhcp: {scopes: [{network: lan, range: 10.0.0.100-10.0.0.100, gateway: 10.0.0.1, dns: [10.0.0.10]}]}}').replace('  - {id: r1,', '  - {id: pc2, type: endpoint, interfaces: [{id: eth0, dhcp: true, simulation: {link_local_fallback: on}}]}\n  - {id: r1,').replace('{id: p3, vlans: 1}]', '{id: p3, vlans: 1}, {id: p4, vlans: 1}]').replace('links:\n', 'links:\n  - {id: d, a: "pc2:eth0", b: "sw:p4"}\n');
  const s = sim(two);
  s.runTo(70000);
  assert.equal(s.leases().filter((l) => l.kind === 'dhcp').length, 1, 'one address for two clients');
  const loser = s.leases().find((l) => l.kind === 'dhcp').dev === 'pc' ? 'pc2' : 'pc';
  assert.ok(ev(s, (e) => e.kind === 'drop' && /scope 1 \(10\.0\.0\.0\/24\) has no free address left \(pool exhausted; like ISC dhcpd, no DHCPOFFER\)/.test(e.detail)).length >= 1);
  const d = ev(s, (e) => e.device === loser && e.what === 'DHCPDISCOVER').map((e) => Math.round((e.t - 2000) / 1000));
  assert.deepEqual(d.slice(0, 4), [0, 4, 12, 28], 'the waits double');
  assert.ok(ev(s, (e) => e.device === loser && e.what === 'no DHCP server' && /starts again in 5 min/.test(e.detail)).length === 1);
  if (loser === 'pc2') assert.match(s.leases().find((l) => l.dev === 'pc2').text, /^169\.254\.\d+\.\d+\/16$/);
  else assert.ok(!s.leases().some((l) => l.dev === 'pc'), 'without the fallback it stays without an address');
});

test('DNS: an A query answered from the zone (a CNAME followed), NXDOMAIN, a timeout with retries, the cache for the record TTL; the zone and cache tables', () => {
  const s = sim(CAMPUS);
  s.runTo(4000);
  const a = s.sendTest({ from: 'lap1', to: 'www.campus.example', kind: 'icmp' });
  assert.equal(a.result, 'resolving www.campus.example');
  s.runTo(s.now + 2000);
  assert.equal(a.ok, true, a.result);
  assert.match(a.resolved, /^www\.campus\.example = 10\.10\.30\.10 \(DNS: /);
  assert.ok(ev(s, (e) => e.device === 'srv' && /to 10\.10\.10\.21: NOERROR www\.campus\.example \(CNAME web\.campus\.example\) A 10\.10\.30\.10, TTL 5 min/.test(e.detail)).length === 1);
  // the connection waits for the answer: the echo goes after the DNS response arrived
  const resp = ev(s, (e) => e.what === 'Response' && e.protocol === 'dns' && /to 10\.10\.10\.21/.test(e.detail))[0].t;
  const echo = ev(s, (e) => e.device === 'lap1' && e.what === 'Echo Request')[0].t;
  assert.ok(echo > resp);
  // the cache: no query the second time
  const q = ev(s, (e) => e.device === 'lap1' && e.what === 'Query').length;
  s.sendTest({ from: 'lap1', to: 'www.campus.example', kind: 'icmp' });
  s.runTo(s.now + 2000);
  assert.equal(ev(s, (e) => e.device === 'lap1' && e.what === 'Query').length, q);
  assert.deepEqual(s.dnsCache('lap1').map((r) => `${r.name} ${r.type} ${r.value}`), ['www.campus.example A 10.10.30.10']);
  // NXDOMAIN
  const nx = s.sendTest({ from: 'lap1', to: 'nope.campus.example', kind: 'icmp' });
  s.runTo(s.now + 2000);
  assert.equal(nx.result, 'DNS: nope.campus.example does not exist (NXDOMAIN from 10.10.10.10)');
  // the server off: two attempts 5 s apart, then a timeout
  s.engine.powerOff('srv');
  const to = s.sendTest({ from: 'lap1', to: 'other.campus.example', kind: 'icmp' });
  s.runTo(s.now + 11000);
  assert.match(to.result, /^DNS: no answer for other\.campus\.example from 10\.10\.10\.10 \(2 × 5 s each; timed out\)$/);
  // the zone table: the derived records with their source, the zone's own, the TTL
  const z = s.dnsZone('srv').map((r) => `${r.name} ${r.type} ${r.value} | ${r.source} | ${r.ttl}`);
  assert.ok(z.includes('web.campus.example A 10.10.30.10 | web:eth0 (DNS name web.campus.example) | 5 min'), z.join('\n'));
  assert.ok(z.includes('www.campus.example CNAME web.campus.example | zone record | 5 min'));
});

test('a deterministic timeline with DHCP and DNS', () => {
  const run = () => {
    const s = sim(CAMPUS);
    s.runTo(30000);
    return s.events().map((e) => `${e.t}|${e.device}|${e.what}|${e.detail}`);
  };
  assert.deepEqual(run(), run());
});
