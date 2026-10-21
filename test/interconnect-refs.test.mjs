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
