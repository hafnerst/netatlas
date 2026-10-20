// Runtime identities and the random streams (analysis/sim/mac.ts, engine.ts):
// a MAC written in the model is the interface's — a duplicate too, kept as
// the fault it is (never replaced, whatever the YAML's order); a generated
// MAC comes from the model's title and the interface's own key; every
// random stream is an object's own (a device's jitter, a cable's loss), so
// that an unrelated object added changes nobody else's identity or
// timeline. Asserted by the MACs, the frames as sent and the events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, model } from './helpers.mjs';

const S = load('analysis/sim/simulation.js');
const M = load('analysis/sim/mac.js');

const LAN = (x = {}) => `netatlas: 1
title: identity
devices:
${(x.order || ['a', 'b', 'c']).map((d) => `  - {id: ${d}, type: endpoint, interfaces: [{id: eth0, ip: 10.0.0.${d.charCodeAt(0) - 96}/24${x.mac && x.mac[d] ? ', mac: "' + x.mac[d] + '"' : ''}}]}`).join('\n')}
  - {id: sw, type: switch, interfaces: [{id: p1, vlans: 1}, {id: p2, vlans: 1}, {id: p3, vlans: 1}]}
${x.extra || ''}links:
  - {id: la, a: "a:eth0", b: "sw:p1"}
  - {id: lb, a: "b:eth0", b: "sw:p2"}
  - {id: lc, a: "c:eth0", b: "sw:p3"}
`;

test('a MAC written twice is kept on both interfaces (a modeled fault), whatever the order of the devices in the file', () => {
  const dup = { a: '02:00:00:00:00:aa', b: '02:00:00:00:00:aa' };
  for (const order of [['a', 'b', 'c'], ['b', 'c', 'a'], ['c', 'b', 'a']]) {
    const macs = M.interfaceMacs(model(LAN({ mac: dup, order })));
    assert.deepEqual([macs.get('a:eth0'), macs.get('b:eth0')], [{ mac: '02:00:00:00:00:aa', simulated: false }, { mac: '02:00:00:00:00:aa', simulated: false }], order.join());
    assert.notEqual(macs.get('c:eth0').mac, '02:00:00:00:00:aa', 'a generated one is never a written one');
  }
  // in the running network both send with it: the switch sees the address on two ports
  const s = new S.Simulation(model(LAN({ mac: dup })));
  s.runTo(3000);
  for (const d of ['a', 'b']) {
    const t = s.sendTest({ from: d, to: '10.0.0.3', kind: 'icmp' });
    s.runTo(s.now + 2000);
    void t;
  }
  const srcs = s.engine.flights.filter((f) => f.view === 'physical' && f.hdr && (f.sender === 'a' || f.sender === 'b') && (f.track.ref === 'link:la' || f.track.ref === 'link:lb')).map((f) => f.hdr.l2.src);
  assert.ok(srcs.length >= 2 && srcs.every((m) => m === '02:00:00:00:00:aa'), srcs.join());
  const where = s.macTable('sw').filter((r) => r.mac === '02:00:00:00:00:aa').map((r) => r.port);
  assert.equal(where.length, 1, 'one entry, moved to the port it was last seen on');
});

test('an unrelated device added (not even cabled) changes no generated MAC and no timing of the others', () => {
  const base = model(LAN());
  const more = model(LAN({ extra: '  - {id: zz, type: server, interfaces: [{id: eth0, ip: 10.9.9.9/24}]}\n  - {id: aa0, type: router, interfaces: [{id: g0, ip: 10.8.8.8/24}]}\n' }));
  const m1 = M.interfaceMacs(base);
  const m2 = M.interfaceMacs(more);
  for (const k of m1.keys()) assert.deepEqual(m2.get(k), m1.get(k), k);
  const run = (m) => {
    const s = new S.Simulation(m);
    s.runTo(30000);
    return s.events().filter((e) => ['a', 'b', 'c', 'sw'].includes(e.device)).map((e) => `${e.t.toFixed(6)} ${e.device} ${e.what}`);
  };
  assert.deepEqual(run(more), run(base));
});
