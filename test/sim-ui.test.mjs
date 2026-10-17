// The protocol simulation's UI logic without a browser: Start simulation…
// and Exit simulation in their three states (no model; a model, nothing
// running; a simulation running), the same in the menu and the palette
// (one registry); and where the dots' labels go (never on a text, a box
// or another label).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, root } from './helpers.mjs';

const C = load('ui/commands.js');
const Lb = load('ui/sim-labels.js');
const A = load('ui/sim-anim.js');

const cmds = new Map(C.buildCommands().map((c) => [c.id, c]));
const fake = (model, running) => ({ hasModel: () => model, simulationOn: () => running, toolWindow: () => (running ? 'sim' : ''), mdoc: model ? {} : null, session: model ? {} : null });

test('Start simulation… and Exit simulation: the three states, with the reasons', () => {
  const start = cmds.get('sim.start');
  const exit = cmds.get('sim.exit');
  assert.equal(start.label, 'Start simulation…');
  assert.ok(!cmds.has('sim.protocol'), 'the old “Protocol simulation…” is gone');
  // no model: both unavailable, the reason in the tooltip
  assert.deepEqual([start.state(fake(false, false)).enabled, start.state(fake(false, false)).reason], [false, 'Open or create a model first']);
  assert.equal(exit.state(fake(false, false)).enabled, false);
  // a model, nothing running: Start, not Exit
  assert.equal(start.state(fake(true, false)).enabled, true);
  assert.equal(exit.state(fake(true, false)).enabled, false);
  assert.equal(exit.state(fake(true, false)).reason, 'No simulation is on');
  // running: Exit (also Esc), not Start
  assert.deepEqual([start.state(fake(true, true)).enabled, start.state(fake(true, true)).reason], [false, 'A simulation is already running']);
  assert.equal(exit.state(fake(true, true)).enabled, true);
  // the menu shows the registry's entries (no availability of its own)
  const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');
  assert.match(html, /<button id="btn-sim-start" type="button" role="menuitem" data-command="sim\.start" aria-haspopup="dialog"[^>]*><span class="mi-label">Start simulation…<\/span>/);
  assert.match(html, /data-command="sim\.exit"[^>]*><span class="mi-label">Exit simulation<\/span><span class="mi-hint">Esc<\/span>/);
});

test('labels: the first place around a dot that touches no text, no box and no other label; none: the dot is not drawn', () => {
  const obstacles = new Lb.BoxIndex();
  const placed = new Lb.BoxIndex();
  // a text right where the first candidate would go
  const cands = Lb.candidates(100, 100, 1, 0, 40, 14, 1);
  obstacles.add(cands[0]);
  const a = Lb.placeLabel(cands, obstacles, placed);
  assert.ok(a && !Lb.overlaps(a, cands[0]));
  placed.add(a);
  // a second label at the same dot: another place, not on the first
  const b = Lb.placeLabel(Lb.candidates(100, 100, 1, 0, 40, 14, 1), obstacles, placed);
  assert.ok(b && !Lb.overlaps(a, b, 1));
  // everything taken: no place
  const full = new Lb.BoxIndex();
  full.add({ x: 0, y: 0, w: 400, h: 400 });
  assert.equal(Lb.placeLabel(Lb.candidates(100, 100, 1, 0, 40, 14, 1), full, new Lb.BoxIndex()), null);
  assert.ok(A.MAX_DOTS > 10 && A.MAX_DOTS <= 60);
});
