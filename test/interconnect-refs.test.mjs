// Configured non-IP traffic takes part in reference maintenance and execution
// scopes: renaming a device or an opaque port updates every `traffic:`
// reference (initiator, source, a scalar or listed recipient, a recipient
// beyond a transit) as one undoable step, nothing else; deleting reports them;
// and a scoped model keeps only the transfers whose every end it keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, model, root, validate } from './helpers.mjs';

const ED = load('editor/document.js');
const ES = load('analysis/exec-scope.js');
const IC = load('model/interconnect.js');
const S = load('analysis/sim/simulation.js');
const VME = readFileSync(join(root, 'examples', 'vme-rack.yaml'), 'utf8').replace(/\r\n/g, '\n');
const doc = (t = VME) => ED.ModelDoc.fromText(t, 'vme-rack.yaml', 'file').doc;
const errors = (t) => validate.loadModel(t).errors.map((e) => `${e.path}: ${e.message}`);
const trafficOf = (t) => model(t).interconnects.flatMap((ic) => ic.traffic.map((x) => `${ic.id}: ${x.initiator} ${x.from} → ${x.to.join(', ')}`));

test('renaming a device updates its traffic references — initiator, source, scalar and listed recipients, a recipient beyond the fabric switch — and nothing else; undo and redo; export and reload', () => {
  const d = doc();
  const before = d.exportText();
  const n = d.renameEntity('device', d.findEntity('device', 'cpu1').index, 'sbc1');
  assert.ok(n > 0);
  const t = d.exportText();
  assert.deepEqual(errors(t), []);
  // every traffic reference to cpu1 follows (on vmebus, on the fabric lanes beyond the switch card, on the console line)
  assert.ok(!/"cpu1:/.test(t), 'no reference to cpu1 left');
  const tr = trafficOf(t).join('\n');
  assert.match(tr, /vmebus: sbc1:vme adc:vme → sbc1:vme/);
  assert.match(tr, /fab-adc: adc:p0 adc:p0 → sbc1:p0/);
  assert.match(tr, /fab-cpu2: cpu2:p0 cpu2:p0 → sbc1:p0/);
  assert.match(tr, /console-1: sbc1:com1 sbc1:com1 → cons:s1/);
  // labels, descriptions and comments are not references: "SBC 1" and the comments stay as they were
  assert.match(t, /label: SBC 1 \(system controller\)/);
  assert.match(t, /# a read \(the target's data to the controller that initiates it\) and a write/);
  // one undoable step
  assert.ok(d.undo());
  assert.equal(d.exportText(), before);
  assert.ok(d.redo());
  assert.equal(d.exportText(), t);
  // export and reload: the same model, its traffic intact
  const again = doc(t);
  assert.equal(again.exportText(), t);
  assert.deepEqual(trafficOf(again.exportText()), trafficOf(t));
});

test('renaming an opaque port updates its traffic references (a listed recipient, a remote one), not the same port name of other devices', () => {
  const d = doc();
  const dev = d.findEntity('device', 'mon');
  const ifs = d.interfaceEntries(dev.index);
  const busA = ifs.find((e) => e.id === 'bus-a');
  d.renameInterface(busA.path, 'listen');
  let t = d.exportText();
  assert.deepEqual(errors(t), []);
  assert.match(trafficOf(t).join('\n'), /mil-bus: mil:bus-a mil:bus-a → act:bus-a, mon:listen/);
  assert.match(t, /"mil:bus-a"/, 'mil:bus-a is another device’s port');
  // a port reached through the switch card's transit
  const d2 = doc();
  const c1 = d2.interfaceEntries(d2.findEntity('device', 'cpu1').index).find((e) => e.id === 'p0');
  d2.renameInterface(c1.path, 'vxs');
  t = d2.exportText();
  assert.deepEqual(errors(t), []);
  assert.match(trafficOf(t).join('\n'), /fab-adc: adc:p0 adc:p0 → cpu1:vxs/);
  assert.match(trafficOf(t).join('\n'), /fab-cpu2: cpu2:p0 cpu2:p0 → cpu1:vxs/);
});

test('deleting a device reports its traffic references (they would break)', () => {
  const d = doc();
  const refs = d.references('device', 'stick').map((p) => p.join('.'));
  assert.ok(refs.some((p) => /^interconnects\.\d+\.traffic\.0\.to$/.test(p)), refs.join(' | '));
  const refs2 = d.references('device', 'act').map((p) => p.join('.'));
  assert.ok(refs2.some((p) => /^interconnects\.\d+\.traffic\.1\.to\.0$/.test(p)), refs2.join(' | '));
});

// ------------------------------------------------------------------ execution scopes

// bus A: src, x and the fabric switch's f1; bus B: the switch's f2, rcv and y; the switch passes A ↔ B
const FAB = `netatlas: 1
title: scoped traffic
devices:
  - {id: src, type: server, interfaces: [{id: p, stack: opaque}]}
  - {id: x, type: server, interfaces: [{id: p, stack: opaque}]}
  - {id: rcv, type: server, interfaces: [{id: p, stack: opaque}]}
  - {id: y, type: server, interfaces: [{id: p, stack: opaque}]}
  - id: fsw
    type: system
    purpose: host
    interfaces: [{id: f1, stack: opaque}, {id: f2, stack: opaque}]
    opaque_transit: [{ports: [f1, f2]}]
interconnects:
  - id: A
    topology: shared
    technology: {name: CAN}
    endpoints: [{port: "src:p"}, {port: "x:p"}, {port: "fsw:f1"}]
    traffic:
      - {initiator: "src:p", to: ["rcv:p", "x:p"], interval: 1s, size: 8}
      - {initiator: "x:p", to: "src:p", interval: 1s, size: 8}
  - id: B
    topology: shared
    technology: {name: CAN}
    endpoints: [{port: "fsw:f2"}, {port: "rcv:p"}, {port: "y:p"}]
`;
const scoped = (m, devs) => {
  const sc = ES.explicitScope(m, 'test', new Set(devs));
  return { sc, sm: ES.scopedModel(m, sc) };
};
const tr = (m) => m.interconnects.flatMap((ic) => ic.traffic.map((x) => `${ic.id}: ${x.initiator} → ${x.to.join(', ')}`)).sort();

test('execution scope: every endpoint of A kept, a recipient beyond the transit left out — the transfer to it is not kept (said), the rest of the list is; never a dangling reference', () => {
  const m = model(FAB);
  const { sc, sm } = scoped(m, ['src', 'x', 'fsw']);
  // A unchanged in its attachments, its traffic not: rcv is outside
  assert.equal(sm.interconnects.find((ic) => ic.id === 'A').endpoints.length, 3);
  assert.deepEqual(tr(sm), ['A: src:p → x:p', 'A: x:p → src:p']);
  assert.ok(sc.caveats.some((c) => /illustrative transfers? of the interconnects' traffic leaves? the scope .*A: src:p → rcv:p \(the recipient is outside\)/.test(c)), sc.caveats.join(' | '));
  // every reference of the scoped model's traffic resolves in it, and it runs without a refusal
  for (const ic of sm.interconnects) for (const t of ic.traffic) for (const k of [t.initiator, t.from, ...t.to]) assert.ok(sm.index.opaquePorts.has(k), k);
  const s = new S.Simulation(sm);
  s.runTo(10000);
  assert.deepEqual(s.events().filter((e) => e.protocol === 'opaque' && e.kind === 'drop').map((e) => e.detail), []);
});

test('execution scope: the transit device outside — both ends inside, the way not: left out; the initiator or the source outside: the transfer left out; the same scope twice, the same model', () => {
  const m = model(FAB);
  const t = scoped(m, ['src', 'x', 'rcv', 'y']);
  assert.deepEqual(tr(t.sm), ['A: src:p → x:p', 'A: x:p → src:p'], 'src → rcv crosses fsw, which is outside: that recipient only is left out');
  assert.ok(t.sc.caveats.some((c) => /src:p → rcv:p \(its way crosses a device outside\)/.test(c)));
  const noSrc = scoped(m, ['x', 'fsw', 'rcv', 'y']);
  assert.deepEqual(tr(noSrc.sm), []);
  assert.ok(noSrc.sc.caveats.some((c) => /its initiator is outside/.test(c)));
  // deterministic and self-consistent
  assert.deepEqual(JSON.stringify(tr(scoped(m, ['src', 'x', 'fsw']).sm)), JSON.stringify(tr(scoped(m, ['fsw', 'x', 'src']).sm)));
  // a display filter keeps traffic consistent too (and never feeds the simulation)
  const kept = IC.keptInterconnects(m.interconnects, (d) => d !== 'rcv');
  assert.deepEqual(kept.find((ic) => ic.id === 'A').traffic.map((x) => x.to.join()), ['x:p', 'src:p']);
  // the entire scope: everything, unchanged
  const all = scoped(m, ['src', 'x', 'rcv', 'y', 'fsw']);
  assert.deepEqual(tr(all.sm), tr(m));
});
