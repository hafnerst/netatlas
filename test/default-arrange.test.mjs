// Default stays exactly what it was before Compact and Structured were reworked: for every example and both
// views, the Auto-arrange positions and the drawn scene (cables, relations, ports, labels) are compared with
// a snapshot taken from the earlier Default. Run with UPDATE_SNAPSHOTS=1 only for a deliberate change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, model, example, exampleNames, root } from './helpers.mjs';

const { layoutInput } = load('layout/input.js');
const { strategyPositions } = load('layout/strategies.js');
const { Session } = load('diagram/session.js');

const FILE = join(root, 'test', 'snapshots', 'default-arrange.json');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function snapshot() {
  const out = {};
  for (const f of exampleNames) {
    const m = model(example(f));
    const input = layoutInput(m);
    for (const view of ['physical', 'logical']) {
      const pos = strategyPositions(view, input, 'default');
      const s = new Session(m);
      s.state.view = view;
      const r = s.render();
      out[`${f} ${view}`] = {
        positions: Array.from(pos.entries()).sort((p, q) => (p[0] < q[0] ? -1 : 1)).map(([id, p]) => `${id} ${p.x} ${p.y}`),
        scene: sha(JSON.stringify(r.root)),
      };
    }
  }
  return out;
}

test('Default is unchanged: positions and the drawn scene of every example, both views, match the snapshot', () => {
  const now = snapshot();
  if (process.env.UPDATE_SNAPSHOTS) writeFileSync(FILE, JSON.stringify(now, null, 1) + '\n');
  const was = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(now).sort(), Object.keys(was).sort());
  for (const k of Object.keys(was)) {
    assert.deepEqual(now[k].positions, was[k].positions, k + ' positions');
    assert.equal(now[k].scene, was[k].scene, k + ' scene');
  }
});
