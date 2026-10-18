// Application instances (services.applications): who may run them, how they are read and checked,
// and the editing operations (add, duplicate, rename with its references, remove), each one undo step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, validate } from './helpers.mjs';

const { ModelDoc } = load('editor/document.js');
const reg = load('model/service-registry.js');
const apps = load('model/applications.js');

const errs = (text) => validate.loadModel(text).errors.map((e) => `${e.path}: ${e.message}`);
const doc = (text) => {
  const r = ModelDoc.fromText(text, 'm.yaml', 'file');
  assert.ok(r.doc, JSON.stringify(r.errors));
  return r.doc;
};

const BASE = `netatlas: 1
devices:
  - id: plc
    type: endpoint
    kind: plc
    services:
      applications:
        - {id: registers, name: Modbus TCP, profile: tcp_server, port: 502}
        - {id: web, name: Management, profile: tcp_server, port: 443}
    interfaces:
      - {id: eth0, ip: 10.0.0.10/24}
      - {id: eth1, ip: 10.0.1.10/24}
  - id: hmi
    type: endpoint
    kind: hmi
    services:
      applications:
        - {id: poll, name: Register polling, profile: tcp_client, peer: plc/registers, interval: 5s}
        - {id: alarms, name: Alarms, profile: udp_sender, peer: 10.0.0.30, port: 5000, interval: 1s, count: 3}
    interfaces:
      - {id: eth0, ip: 10.0.0.20/24}
  - id: scada
    type: server
    services:
      applications:
        - {id: alarms, name: Alarm sink, profile: udp_receiver, port: 5000}
    interfaces:
      - {id: eth0, ip: 10.0.0.30/24}
`;

test('application instances are read by their profile: several per device, each with its id, name and fields', () => {
  const r = validate.loadModel(BASE);
  assert.deepEqual(r.errors.map((e) => e.message), []);
  const plc = r.model.index.devices.get('plc');
  assert.deepEqual(plc.applications.map((a) => [a.id, a.name, a.profile, a.port]), [
    ['registers', 'Modbus TCP', 'tcp_server', 502],
    ['web', 'Management', 'tcp_server', 443],
  ]);
  const hmi = r.model.index.devices.get('hmi');
  assert.equal(hmi.applications[0].peer, 'plc/registers');
  assert.equal(hmi.applications[0].interval, 5000);
  assert.equal(hmi.applications[0].start, 'manual', 'nothing starts by itself');
  assert.equal(hmi.applications[1].count, 3);
  // the summaries of the collapsed entries
  assert.equal(apps.appSummary(plc.applications[1]), 'Management · TCP listener · 443');
  assert.equal(apps.appSummary(hmi.applications[0]), 'Register polling · TCP request/response · plc/registers');
  assert.equal(apps.appSummary(hmi.applications[1]), 'Alarms · UDP messages · 10.0.0.30:5000');
  assert.equal(apps.appSummary({ id: 't', name: 'Telemetry', profile: 'mqtt_client', broker: 'broker', publish: ['sensors/room1'], subscribe: [] }), 'Telemetry · MQTT publisher · broker / sensors/room1');
  // one badge for all of them, with their number; the tooltip says how many
  assert.match(reg.serviceBadgesText(plc), /^APP×2$/);
  assert.match(reg.serviceListText(plc), /2 applications \(APP\)/);
});

test('eligibility: host-capable endpoints, servers, VMs, containers, storage and host Systems run applications; nothing passive, forwarding-only or a Security gateway', () => {
  const def = reg.serviceDef('applications');
  for (const d of [{ type: 'endpoint' }, { type: 'endpoint', kind: 'plc' }, { type: 'server' }, { type: 'vm' }, { type: 'container' }, { type: 'storage' }, { type: 'system', purpose: 'host' }]) assert.equal(reg.serviceEligibility(def, d), null, JSON.stringify(d));
  for (const d of [{ type: 'system', purpose: 'pass_through' }, { type: 'system', purpose: 'l2_forwarder' }, { type: 'cloud' }, { type: 'switch' }, { type: 'router' }, { type: 'ap' }, { type: 'security_gateway' }, { type: 'ids_ips', mode: 'passive' }]) assert.notEqual(reg.serviceEligibility(def, d), null, JSON.stringify(d));
  // a PLC need not become a Server: its type stays, the validator agrees
  const plc = errs(`netatlas: 1\ndevices:\n  - id: plc\n    type: endpoint\n    kind: plc\n    services:\n      applications: [{id: a, name: A, profile: udp_server, port: 2222}]\n    interfaces: [{id: eth0, ip: 10.0.0.1/24}]\n`);
  assert.deepEqual(plc, []);
  const patch = errs(`netatlas: 1\ndevices:\n  - id: pp\n    type: system\n    purpose: pass_through\n    port_pairs: [{a: p1, b: p2}]\n    services:\n      applications: [{id: a, name: A, profile: udp_server, port: 2222}]\n    interfaces: [p1, p2]\n`);
  assert.ok(patch.some((x) => /"pp" can't run Applications/.test(x)), patch.join('\n'));
  // the separation device stays without services
  const sg = errs(`netatlas: 1\ndevices:\n  - id: sg\n    type: security_gateway\n    services:\n      applications: [{id: a, name: A, profile: udp_server, port: 2222}]\n      separation: {implementation: filtering_router}\n    interfaces: [{id: a0, ip: 10.0.0.1/24}]\n`);
  assert.ok(sg.some((x) => /can't run Applications: a Security gateway runs no services/.test(x)), sg.join('\n'));
  // the services it was not given before stay out of reach: an endpoint is no DHCP server
  assert.notEqual(reg.serviceEligibility(reg.serviceDef('dhcp'), { type: 'endpoint' }), null);
  assert.notEqual(reg.serviceEligibility(reg.serviceDef('hypervisor'), { type: 'endpoint' }), null);
});

test('validation: ids, required fields, fields of another profile, peers and their profiles, a count without an interval', () => {
  const one = (entry, more = '') => errs(BASE.replace('        - {id: web, name: Management, profile: tcp_server, port: 443}', '        - ' + entry + more));
  assert.ok(one('{id: registers, name: X, profile: tcp_server, port: 80}').some((x) => /duplicate application "registers" on "plc"/.test(x)));
  assert.ok(one('{id: web, name: X}').some((x) => /needs its profile/.test(x)));
  assert.ok(one('{id: web, name: X, profile: tcp_server}').some((x) => /needs its port/.test(x)));
  assert.ok(one('{id: web, profile: tcp_server, port: 80}').some((x) => /needs its name/.test(x)));
  assert.ok(one('{id: web, name: X, profile: tcp_server, port: 80, peer: hmi}').some((x) => /"peer" does not apply here/.test(x)));
  assert.ok(one('{id: web, name: X, profile: ftp, port: 21}').some((x) => /"ftp" is not a profile/.test(x)));
  assert.ok(one('{id: "a/b", name: X, profile: tcp_server, port: 80}').some((x) => /is not an application id/.test(x)));
  const h = (entry) => errs(BASE.replace('        - {id: poll, name: Register polling, profile: tcp_client, peer: plc/registers, interval: 5s}', '        - ' + entry));
  assert.ok(h('{id: poll, name: P, profile: tcp_client}').some((x) => /needs its peer/.test(x)));
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: plc/nothing}').some((x) => /"plc" has no application "nothing"/.test(x)));
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: ghost/x}').some((x) => /"ghost" is not a device of the model/.test(x)));
  assert.ok(h('{id: poll, name: P, profile: udp_client, peer: plc/registers}').some((x) => /is a TCP listener \(request\/response\): a UDP client \(request\/response\) needs a UDP listener/.test(x)));
  // an application peer brings its own port: writing one is an error; a device, address or name needs it
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: plc/registers, port: 502}').some((x) => /"port" does not apply here/.test(x)));
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: plc}').some((x) => /needs its port/.test(x)));
  assert.deepEqual(h('{id: poll, name: P, profile: tcp_client, peer: plc, port: 502}'), []);
  assert.deepEqual(h('{id: poll, name: P, profile: tcp_client, peer: plc.example.net, port: 502}'), []);
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: 10.0.0.10, port: 502, ip_version: "6"}').some((x) => /is an IPv4 address: it is reached by IPv4/.test(x)));
  assert.ok(h('{id: poll, name: P, profile: tcp_client, peer: plc/registers, count: 4}').some((x) => /sends 4 messages each time it is started: write the interval/.test(x)));
});

test('listener bindings: the same port twice on all addresses, or on one interface and on all, is a conflict; on two explicit interfaces it is fine', () => {
  const pair = (a, b) => errs(BASE.replace('        - {id: registers, name: Modbus TCP, profile: tcp_server, port: 502}\n        - {id: web, name: Management, profile: tcp_server, port: 443}', `        - ${a}\n        - ${b}`).replace('peer: plc/registers', 'peer: plc/a'));
  assert.ok(pair('{id: a, name: A, profile: tcp_server, port: 502}', '{id: b, name: B, profile: tcp_server, port: 502}').some((x) => /"b" and "a" both listen on TCP 502 on all addresses/.test(x)));
  assert.ok(pair('{id: a, name: A, profile: tcp_server, port: 502, bind: eth0}', '{id: b, name: B, profile: tcp_server, port: 502}').some((x) => /both listen on TCP 502 \(one on all addresses, the other on eth0\)|both listen on TCP 502 \(one on eth0/.test(x)));
  assert.deepEqual(pair('{id: a, name: A, profile: tcp_server, port: 502, bind: eth0}', '{id: b, name: B, profile: tcp_server, port: 502, bind: eth1}'), []);
  // TCP and UDP on the same port number are two listeners
  assert.deepEqual(pair('{id: a, name: A, profile: tcp_server, port: 502}', '{id: b, name: B, profile: udp_server, port: 502}'), []);
  assert.ok(pair('{id: a, name: A, profile: tcp_server, port: 502, bind: eth9}', '{id: b, name: B, profile: tcp_server, port: 80}').some((x) => /"plc" has no interface "eth9"/.test(x)));
  // a port a service of the device listens on
  const ntp = errs(BASE.replace('    type: server\n    services:\n', '    type: server\n    services:\n      ntp: {stratum: 2}\n').replace('{id: alarms, name: Alarm sink, profile: udp_receiver, port: 5000}', '{id: alarms, name: Alarm sink, profile: udp_receiver, port: 123}'));
  assert.ok(ntp.some((x) => /"alarms" and the NTP both listen on UDP 123/.test(x)), ntp.join('\n'));
});

test('the earlier single application is an unknown service, never read as an instance', () => {
  const e = errs(`netatlas: 1\ndevices:\n  - id: s\n    type: server\n    services:\n      application: {name: ERP, ports: [tcp/443]}\n    interfaces: [{id: eth0, ip: 10.0.0.1/24}]\n`);
  assert.ok(e.some((x) => /unknown key "application" — did you mean "applications"/.test(x)), e.join('\n'));
  const m = validate.loadModel(`netatlas: 1\ndevices:\n  - id: s\n    type: server\n    services:\n      application: {name: ERP, ports: [tcp/443]}\n    interfaces: [{id: eth0, ip: 10.0.0.1/24}]\n`).model;
  assert.ok(!m || !m.index.devices.get('s').applications || m.index.devices.get('s').applications.length === 0);
});

test('editing: add (a free id, the profile left to choose), duplicate, change the profile, each one undo step', () => {
  const d = doc(BASE);
  const before = d.exportText();
  const k = d.addApplication(0);
  assert.equal(k, 2);
  assert.equal(d.text(['devices', 0, 'services', 'applications', 2, 'id']), 'app1');
  assert.equal(d.text(['devices', 0, 'services', 'applications', 2, 'profile']), undefined, 'the profile is the user’s choice');
  assert.equal(d.canUndo(), 'Add application');
  // a second one on a device without applications: the block and the list come with it
  const j = d.addApplication(2);
  assert.equal(j, 1);
  d.undo();
  d.undo();
  assert.equal(d.exportText(), before);
  const fresh = doc('netatlas: 1\ndevices:\n  - {id: tv, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.5/24}]}\n');
  fresh.addApplication(0);
  assert.match(fresh.exportText(), /services: \{applications: \[\{id: app1, name: Application 1\}\]\}/);
  fresh.undo();
  assert.ok(!/services/.test(fresh.exportText()));
  // duplicate: right after it, its own id
  const c = d.duplicateApplication(0, 1);
  assert.equal(c, 2);
  assert.equal(d.text(['devices', 0, 'services', 'applications', 2, 'id']), 'web-2');
  assert.equal(d.text(['devices', 0, 'services', 'applications', 2, 'name']), 'Management (copy)');
  assert.ok(d.errors.some((e) => /both listen on TCP 443/.test(e.message)), 'the copy listens on the same port: reported');
  d.undo();
  // a profile change removes what belongs to no profile of its kind any more
  const gone = d.setAppProfile(['devices', 1, 'services', 'applications', 1], 'udp_receiver');
  assert.deepEqual(gone, ['peer', 'interval', 'count']);
  assert.equal(d.text(['devices', 1, 'services', 'applications', 1, 'port']), '5000', 'what the new profile has stays');
  assert.equal(d.canUndo(), 'Set application profile');
  d.undo();
  assert.equal(d.exportText(), before);
});

test('references: renaming an application updates its peers; removing it removes them (listed first); a device rename and an interface rename follow', () => {
  const d = doc(BASE);
  const before = d.exportText();
  assert.deepEqual(d.applicationRefTexts('plc', 'registers'), ['hmi/poll (its peer)']);
  assert.equal(d.renameApplication(0, 0, 'regs'), 1);
  assert.equal(d.text(['devices', 1, 'services', 'applications', 0, 'peer']), 'plc/regs');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  assert.equal(d.canUndo(), 'Rename application');
  d.undo();
  assert.equal(d.exportText(), before);
  d.removeApplication(0, 0);
  assert.equal(d.get(['devices', 1, 'services', 'applications', 0, 'peer']), undefined);
  assert.ok(d.errors.some((e) => /needs its peer/.test(e.message)), 'the client is reported until it gets another peer');
  assert.equal(d.canUndo(), 'Remove application');
  d.undo();
  assert.equal(d.exportText(), before);
  // the device's rename: "plc/registers" → "controller/registers"
  d.renameEntity('device', 0, 'controller');
  assert.equal(d.text(['devices', 1, 'services', 'applications', 0, 'peer']), 'controller/registers');
  assert.ok(d.valid, d.errors.map((e) => e.message).join('\n'));
  d.undo();
  // a bind interface follows its interface's rename
  const b = doc(BASE.replace('{id: web, name: Management, profile: tcp_server, port: 443}', '{id: web, name: Management, profile: tcp_server, port: 443, bind: eth1}'));
  b.renameInterface(['devices', 0, 'interfaces', 1], 'mgmt0');
  assert.equal(b.text(['devices', 0, 'services', 'applications', 1, 'bind']), 'mgmt0');
  assert.ok(b.valid, b.errors.map((e) => e.message).join('\n'));
});

test('topic matching (MQTT 3.1.1 §4.7): + one level, # the rest and its parent, $ topics never by a leading wildcard', () => {
  const m = apps.topicMatches;
  assert.ok(m('sensors/+/temperature', 'sensors/room1/temperature'));
  assert.ok(!m('sensors/+/temperature', 'sensors/room1/humidity'));
  assert.ok(!m('sensors/+', 'sensors/room1/temperature'));
  assert.ok(m('sensors/#', 'sensors/room1/temperature'));
  assert.ok(m('sensors/#', 'sensors'));
  assert.ok(!m('sensors/+', 'sensors'));
  assert.ok(m('#', 'a/b'));
  assert.ok(!m('#', '$SYS/broker'));
  assert.ok(!m('+/broker', '$SYS/broker'));
  assert.ok(m('$SYS/#', '$SYS/broker'));
  assert.equal(apps.topicFilterProblem('sensors/#/x'), 'has # elsewhere than as its whole last level');
  assert.equal(apps.topicFilterProblem('sensors/ro+'), 'has + inside a level (it must be the whole level)');
  assert.equal(apps.topicNameProblem('sensors/+'), 'has a wildcard (+ or #): a publication goes to one topic');
});
