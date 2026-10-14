// The routing services of a device (model/services.ts): the registry that
// defines each protocol's parameters (type, scope, mandatory, validation,
// suggestions) and its use of the router ID; protocols the model defines
// itself; the rules of applicability (a router ID or an AS number only with
// a protocol that uses it, protocols only on Layer 3+ devices); mandatory
// parameters; the suggestions from relations; enabling and disabling with
// one undo step; and what the checks, the path tracer and the diagram read
// from the enabled protocols.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, load, example, exampleNames } from './helpers.mjs';

const S = load('model/services.js');
const I = load('analysis/identity.js');
const R = load('analysis/routing.js');
const T = load('analysis/trace.js');
const A = load('model/addresses.js');
const Q = load('model/queries.js');
const { ModelDoc } = load('editor/document.js');

const msgs = (text) => {
  const r = validate.loadModel(text);
  return r.errors.concat(r.warnings).map((e) => e.message);
};
const model = (text) => {
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors.concat(r.warnings).map((e) => e.message), []);
  return r.model;
};
const dev = (body, type = 'router') => `netatlas: 1\ndevices:\n  - id: r1\n    type: ${type}\n${body}`;
const LOOP = '    logical_interfaces:\n      - {id: lo0, type: loopback, ip: [10.255.0.1/32]}\n    interfaces:\n      - {id: e0, ip: 10.0.0.1/24}\n';

test('the registry: every built-in protocol declares its parameters with a type, a scope and a validation rule, and its use of the router ID', () => {
  const reg = S.builtinServices();
  assert.deepEqual(Array.from(reg.keys()).sort(), ['bfd', 'bgp', 'carp', 'eigrp', 'glbp', 'hsrp', 'isis', 'ldp', 'ospf', 'pim', 'rip', 'vrrp']);
  for (const s of reg.values()) {
    assert.ok(s.label && ['required', 'optional', 'none'].includes(s.routerId), s.id);
    for (const p of s.params) {
      assert.ok(p.key && p.label && S.PARAM_TYPES.includes(p.type) && S.PARAM_SCOPES.includes(p.scope), `${s.id}.${p.key}`);
      if (p.type === 'int') assert.ok(p.min !== undefined && p.max !== undefined, `${s.id}.${p.key} range`);
      if (p.type === 'enum') assert.ok(p.values.length > 0, `${s.id}.${p.key} values`);
      // a suggestion is always a valid value
      for (const v of p.suggest || []) assert.equal(S.paramProblem(p, v), '', `${s.id}.${p.key} = ${v}`);
    }
  }
  // the shared identity values each protocol uses
  assert.deepEqual(['bgp', 'ospf', 'isis', 'eigrp', 'ldp', 'vrrp'].map((id) => reg.get(id).routerId), ['optional', 'required', 'none', 'optional', 'optional', 'none']);
  // static routes are a device's routes, never a protocol
  assert.equal(reg.has('static'), false);
  const p = (svc, key) => reg.get(svc).params.find((x) => x.key === key);
  assert.deepEqual([p('bgp', 'asn').scope, p('bgp', 'asn').required], ['device', true]);
  assert.deepEqual([p('isis', 'net').scope, p('isis', 'level').values], ['device', ['level-1', 'level-2', 'level-1-2']]);
  assert.deepEqual([p('vrrp', 'group').scope, p('vrrp', 'virtual_ip').required], ['interface', true]);
  assert.deepEqual([p('ospf', 'area').scope, p('ospf', 'area').suggest], ['endpoint', ['0.0.0.0']]);
  // validation rules
  assert.equal(S.paramProblem(p('bgp', 'asn'), '0'), 'Local AS number must be from 1 to 4294967295');
  assert.equal(S.paramProblem(p('isis', 'net'), '49.0001.1921.6800.1001.00'), '');
  assert.match(S.paramProblem(p('isis', 'net'), '49.0001.1921.6800.1001'), /must be a NET/);
  assert.equal(S.paramProblem(p('ospf', 'area'), '0.0.0.1'), '');
  assert.match(S.paramProblem(p('vrrp', 'virtual_ip'), '10.0.0.1/24'), /without a prefix length/);
  assert.equal(S.netSystemId('49.0001.1921.6800.1001.00'), '1921.6800.1001');
});

test('applicability: a router ID only with a protocol that uses one; the AS number belongs to BGP; protocols only on Layer 3+ devices', () => {
  // a router ID and no protocol that uses it: not applicable (a warning)
  assert.deepEqual(msgs(dev('    router_id: 10.255.0.1\n')), ['router_id is not applicable: none of the protocols "r1" enables uses a router ID (BGP, OSPF, EIGRP, LDP do); enable one or remove it']);
  assert.match(msgs(dev('    router_id: 10.255.0.1\n    protocols: {bfd: {}}\n'))[0], /router_id is not applicable/);
  assert.deepEqual(msgs(dev('    router_id: lo0\n    protocols: {ospf: {}}\n' + LOOP)), []);
  // an AS number on the device: it is BGP's
  assert.deepEqual(msgs(dev('    asn: 65001\n')), ['unknown key "asn" (the AS number belongs to BGP: enable it with protocols: {bgp: {asn: …}})']);
  // an AS number of a protocol that has none, a parameter in the wrong place
  assert.match(msgs(dev('    protocols: {ospf: {asn: 1}}\n    router_id: 10.0.0.1\n'))[0], /^unknown key "asn"/);
  assert.match(msgs(dev('    protocols: {vrrp: {group: 1}}\n'))[0], /Group is set per interface, in the interface's protocols:/);
  assert.match(msgs(dev('    router_id: 10.0.0.1\n    protocols: {ospf: {area: 0}}\n'))[0], /Area is set on OSPF relations, in their attrs \(per device: area: \{r1: …\}\)/);
  assert.match(msgs(dev('    protocols: {bfd: {router_id: 10.0.0.1}}\n'))[0], /BFD uses no router ID/);
  // static routing is no protocol: a device's routes are always in effect; "static" is reported like any unknown protocol
  assert.match(msgs(dev('    protocols: {static: {}}\n'))[0], /"static" is not a routing service \(known: bgp, ospf, isis/);
  assert.doesNotMatch(msgs(dev('    protocols: {static: {}}\n'))[0], /known: [^)]*static/);
  // not a Layer 3+ device: the same list as for static routes' routers
  for (const t of ['server', 'endpoint', 'ap', 'cloud']) assert.match(msgs(dev('    protocols: {bgp: {asn: 1}}\n', t))[0], /only Layer 3\+ devices \(router, firewall, load_balancer, proxy, gateway; a switch with layer3: true\) run routing protocols/, t);
  for (const t of ['router', 'firewall', 'load_balancer', 'proxy', 'gateway']) assert.deepEqual(msgs(dev('    protocols: {bgp: {asn: 1}}\n', t)), [], t);
  // a switch only with layer3: true (a Layer 3 switch); a Layer 2 switch is told so
  assert.deepEqual(msgs(dev('    layer3: true\n    protocols: {bgp: {asn: 1}}\n', 'switch')), [], 'Layer 3 switch');
  assert.match(msgs(dev('    protocols: {bgp: {asn: 1}}\n', 'switch'))[0], /"r1" is a Layer 2 switch: it runs no routing protocols \(set layer3: true to make it a Layer 3 switch\)/);
  // an unknown protocol
  assert.match(msgs(dev('    protocols: {bpg: {asn: 1}}\n'))[0], /"bpg" is not a routing service \(known: bgp, ospf, isis/);
  // interface settings need the protocol enabled on the device
  assert.match(msgs(dev('    interfaces:\n      - {id: e0, ip: 10.0.0.2/24, protocols: {vrrp: {group: 1, virtual_ip: 10.0.0.1}}}\n'))[0], /VRRP is not enabled on "r1": enable it in the device's protocols: first/);
  assert.match(msgs(dev('    protocols: {bgp: {asn: 1}}\n    interfaces:\n      - {id: e0, protocols: {bgp: {}}}\n'))[0], /BGP has no settings per interface/);
});

test('mandatory parameters are errors until filled in; nothing is chosen for the user', () => {
  assert.deepEqual(msgs(dev('    protocols: {bgp: {}}\n')), ['BGP needs local AS number (asn): The device’s own AS (1–4294967295); iBGP or eBGP follows from both ends.']);
  assert.deepEqual(msgs(dev('    protocols:\n      ospf: {}\n')), ["OSPF needs a router ID: set the device's router_id (a loopback or an IPv4 address), or OSPF's own router_id"]);
  assert.match(msgs(dev('    protocols: {isis: {level: level-2}}\n'))[0], /IS-IS needs nET \(system ID\) \(net\)|IS-IS needs/);
  const vrrp = msgs(dev('    protocols: {vrrp: {}}\n    interfaces:\n      - {id: e0, ip: 10.0.0.2/24, protocols: {vrrp: {group: 1}}}\n'));
  assert.equal(vrrp.length, 1);
  assert.match(vrrp[0], /VRRP needs virtual IP \(virtual_ip\)/);
  // values are validated by their type
  assert.match(msgs(dev('    protocols: {bgp: {asn: 70000000000}}\n'))[0], /Local AS number must be from 1 to 4294967295/);
  assert.match(msgs(dev('    protocols: {rip: {version: 3}}\n'))[0], /Version must be one of 1, 2, ng/);
  // a protocol's own router ID instead of the device's
  const m = model(dev('    protocols: {ospf: {router_id: 10.9.9.9}, bgp: {asn: 65001}}\n' + LOOP));
  const d = m.devices[0];
  assert.equal(S.routerIdFor(d, 'ospf').address, '10.9.9.9');
  assert.equal(S.routerIdFor(d, 'bgp'), undefined);
  assert.equal(S.bgpAsn(d), 65001);
  assert.deepEqual(d.services.map((s) => s.id), ['bgp', 'ospf'], 'sorted by id');
  // the shared router ID from a loopback
  const m2 = model(dev('    router_id: lo0\n    protocols: {bgp: {asn: 65001}, ospf: {}}\n' + LOOP));
  assert.equal(S.routerIdFor(m2.devices[0], 'ospf').address, '10.255.0.1');
  assert.equal(S.routerIdFor(m2.devices[0], 'bgp').iface, 'lo0');
});

test('a protocol of the model declares its parameters like the built-in ones, and is validated the same way', () => {
  const head = `netatlas: 1
protocols:
  - id: macsec
    label: MACsec
    category: other
    params:
      - {key: cipher, type: enum, values: [gcm-aes-128, gcm-aes-xpn-256], required: true, description: The cipher suite}
      - {key: replay-window, type: int, min: 0, max: 4294967295, scope: endpoint}
  - id: myigp
    category: adjacency
    router_id: required
    params: []
`;
  const m = model(head + 'devices:\n  - id: r1\n    type: router\n    router_id: 10.0.0.1\n    protocols: {macsec: {cipher: gcm-aes-128}, myigp: {}}\n');
  assert.equal(m.services.get('macsec').params[0].required, true);
  assert.equal(m.services.get('macsec').builtin, false);
  assert.equal(m.services.get('myigp').routerId, 'required');
  assert.match(msgs(head + 'devices:\n  - id: r1\n    type: router\n    protocols: {macsec: {cipher: aes}}\n')[0], /cipher must be one of gcm-aes-128, gcm-aes-xpn-256/);
  assert.match(msgs(head + 'devices:\n  - id: r1\n    type: router\n    protocols: {macsec: {}}\n')[0], /MACsec needs cipher \(cipher\): The cipher suite/);
  assert.match(msgs(head + 'devices:\n  - id: r1\n    type: router\n    protocols: {myigp: {}}\n')[0], /myigp needs a router ID/);
  // a declaration that isn't one
  assert.match(msgs('netatlas: 1\nprotocols:\n  - {id: x, category: other, params: [{key: k, type: color}]}\n')[0], /unknown parameter type "color"/);
  assert.match(msgs('netatlas: 1\nprotocols:\n  - {id: bgp, category: adjacency, params: []}\n')[0], /"bgp" is a built-in routing service: its parameters are fixed/);
});

test('suggestions from relations: a protocol used by a device’s relations but not enabled, one enabled but unused, static routes without static routing', () => {
  const text = `netatlas: 1
devices:
  - id: r1
    type: router
    protocols: {bgp: {asn: 65001}, rip: {}}
    interfaces: [{id: e0, ip: 10.0.0.1/30}]
    routes: [{prefix: 0.0.0.0/0, via: 10.0.0.2}]
  - id: r2
    type: router
    protocols: {bgp: {asn: 65002}}
    interfaces: [{id: e0, ip: 10.0.0.2/30}]
  - {id: srv, type: server, interfaces: [{id: e0, ip: 10.0.1.3/24}]}
relations:
  - {id: ebgp, protocol: ebgp, endpoints: ["r1:e0", "r2:e0"]}
  - {id: ospf, protocol: ospf, endpoints: ["r1:e0", "r2:e0", srv]}
`;
  const r = validate.loadModel(text);
  assert.deepEqual(r.errors, []);
  const f = r.findings.map((x) => `${x.check} ${x.severity}: ${x.message}`).sort();
  assert.deepEqual(f, [
    'protocol-not-enabled warning: r1 is an endpoint of OSPF ospf, but OSPF is not enabled on it: enable OSPF in its protocols',
    'protocol-not-enabled warning: r2 is an endpoint of OSPF ospf, but OSPF is not enabled on it: enable OSPF in its protocols',
    'protocol-unused info: RIP is enabled on r1, but no RIP relation has it as an endpoint',
  ]);
  // r1's static route needs no protocol: only OSPF is suggested
  assert.deepEqual(I.suggestedServices(r.model, 'r1'), [{ service: 'ospf', relations: ['ospf'] }]);
  // a server is never asked to enable a routing protocol
  assert.deepEqual(I.suggestedServices(r.model, 'srv'), []);
});

test('enabling and disabling: one undo step each; disabling removes the values (listed first), and the router ID when no other protocol uses it', () => {
  const src = dev('    router_id: lo0\n    protocols:\n      bfd: {}\n      vrrp: {}\n' + LOOP.replace('{id: e0, ip: 10.0.0.1/24}', '{id: e0, ip: 10.0.0.1/24, protocols: {vrrp: {group: 7, virtual_ip: 10.0.0.254}}}'));
  const d = ModelDoc.fromText(src, 'r.yaml', 'file').doc;
  // the router ID is not applicable here (BFD and VRRP use none): enable OSPF, which uses it
  d.enableService(0, 'ospf');
  assert.match(d.exportText(), /\n {4}protocols:\n {6}bfd: \{\}\n {6}ospf: \{\}\n {6}vrrp: \{\}\n/, 'in id order');
  assert.equal(d.canUndo(), 'Enable OSPF');
  d.enableService(0, 'bgp');
  d.setInteger(['devices', 0, 'protocols', 'bgp', 'asn'], '65001');
  assert.match(d.exportText(), /bgp: \{asn: 65001\}/);
  assert.deepEqual(d.valid, true);
  // what disabling VRRP removes: its settings on e0
  assert.deepEqual(d.serviceRemoval(0, 'vrrp'), ['e0: {group: 7, virtual_ip: 10.0.0.254}']);
  d.disableService(0, 'vrrp');
  assert.doesNotMatch(d.exportText(), /vrrp/);
  assert.equal(d.canUndo(), 'Disable VRRP');
  d.undo();
  assert.match(d.exportText(), /protocols: \{vrrp: \{group: 7, virtual_ip: 10\.0\.0\.254\}\}/);
  // the last protocols that use the router ID take it with them
  assert.deepEqual(d.serviceRemoval(0, 'bgp'), ['asn: 65001']);
  d.disableService(0, 'bgp');
  assert.deepEqual(d.serviceRemoval(0, 'ospf'), ['router_id: lo0 (no other enabled protocol uses a router ID)']);
  d.disableService(0, 'ospf');
  assert.doesNotMatch(d.exportText(), /router_id/);
  d.disableService(0, 'bfd');
  d.disableService(0, 'vrrp');
  assert.doesNotMatch(d.exportText(), /protocols/, 'an empty block goes');
  // every step undoes to the file as it was
  while (d.canUndo()) d.undo();
  assert.equal(d.exportText(), src);
  // interface settings: added and removed, one step each
  const e = ModelDoc.fromText(src, 'r.yaml', 'file').doc;
  e.setIfaceService(['devices', 0, 'interfaces', 0], 'vrrp', false);
  assert.doesNotMatch(e.exportText(), /group: 7/);
  e.undo();
  assert.equal(e.exportText(), src);
});

test('the checks, the path tracer and the diagram read the enabled protocols', () => {
  const two = (p1, p2, extra = '') => `netatlas: 1
devices:
  - {id: a, type: router, router_id: 10.255.0.1, protocols: ${p1}, interfaces: [{id: e0, ip: 10.0.0.1/30}, {id: lan, ip: 10.1.0.1/24}]}
  - {id: b, type: router, router_id: 10.255.0.2, protocols: ${p2}, interfaces: [{id: e0, ip: 10.0.0.2/30}, {id: lan, ip: 10.2.0.1/24}]}
relations:
  - {id: s, protocol: ${extra || 'ospf'}, endpoints: ["a:e0", "b:e0"]}
`;
  // OSPF enabled on both: the route is learned
  const on = validate.loadModel(two('{ospf: {}}', '{ospf: {}}')).model;
  assert.deepEqual(T.tracePath(on, { from: 'a:lan', to: 'b:lan' }).paths[0].hops.map((h) => h.device), ['a', 'b']);
  // not enabled on b: no adjacency, and the tracer says why
  const off = validate.loadModel(two('{ospf: {}}', '{bgp: {asn: 1}}')).model;
  const miss = R.routingAdjacencies(off).missing.find((x) => x.from === 'a');
  assert.equal(miss.detail, 'OSPF is not enabled on b');
  const t = T.tracePath(off, { from: 'a:lan', to: 'b:lan' }).paths[0].end;
  assert.deepEqual([t.reason, t.device], ['no-adjacency', 'a']);
  assert.match(t.detail, /OSPF is not enabled on b/);
  // iBGP or eBGP from the two local AS numbers: the distance of the learned route
  const dist = (asA, asB) => R.dynamicEntries(validate.loadModel(two(`{bgp: {asn: ${asA}}}`, `{bgp: {asn: ${asB}}}`, 'bgp')).model, 'a', '').find((x) => x.protocol === 'bgp').distance;
  assert.equal(dist(65001, 65001), 200);
  assert.equal(dist(65001, 65002), 20);
  // the diagram: the router ID and AS where they apply, a protocol's own router ID with its name
  const m = model(dev('    router_id: lo0\n    protocols: {bgp: {asn: 65001}, ospf: {router_id: 10.9.9.9}}\n' + LOOP));
  assert.deepEqual(A.identityLines(m.devices[0], m.services).map((x) => [x.line, x.field.field]), [
    ['router-id 10.255.0.1', 'router_id'],
    ['AS 65001', 'protocols.bgp.asn'],
    ['OSPF router-id 10.9.9.9', 'protocols.ospf.router_id'],
  ]);
  // no protocol that uses it: no router ID line (it is reported instead)
  const na = validate.loadModel(dev('    router_id: 10.255.0.1\n')).model;
  assert.deepEqual(A.identityLines(na.devices[0], na.services), []);
  // Find: by protocol, AS number, router ID and virtual address
  const wan = model(example('enterprise-wan.yaml'));
  const refs = (q) => Q.search(wan, q, 50).map((h) => h.ref);
  assert.ok(refs('as 65010').includes('device:hq-rtr1') && refs('as 65010').includes('device:hq-rtr2'));
  assert.ok(refs('router-id 10.255.0.11').includes('device:hq-core1'));
  assert.ok(refs('vrrp').includes('device:hq-core2'));
  assert.ok(refs('10.10.20.1').includes('iface:hq-core1:Vlan20'));
});

test('the examples: routers with BGP and OSPF, a switch without routing protocols, a firewall with static routes and no protocol; every router ID applies', () => {
  const wan = model(example('enterprise-wan.yaml'));
  const svc = (m, id) => m.index.devices.get(id).services.map((s) => s.id);
  assert.deepEqual(svc(wan, 'hq-rtr1'), ['bfd', 'bgp', 'ospf']);
  assert.deepEqual(svc(wan, 'hq-acc1'), [], 'the access switch runs no routing protocol');
  const dt = model(example('device-types.yaml'));
  assert.deepEqual(svc(dt, 'fw'), []);
  assert.ok(dt.index.devices.get('fw').routes.length > 0, 'its routes are in effect without a protocol');
  // no example enables "static" any more
  for (const f of exampleNames) assert.doesNotMatch(example(f), /^\s+static: \{/m, f);
  for (const f of exampleNames) {
    const m = validate.loadModel(example(f)).model;
    if (!m) continue;
    for (const d of m.devices) if (d.routerId) assert.ok(S.routerIdServices(m, d).length > 0, `${f}: ${d.id}`);
  }
});
