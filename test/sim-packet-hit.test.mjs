// A packet's hit area: a radius in screen pixels around its dot (the same at
// every zoom), the nearest dot within it wins, a tie goes to the lower flight
// id (the earlier message); nothing beyond the radius.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const A = load('ui/sim-anim.js');

test('the nearest dot within the hit radius (screen pixels, any zoom); ties to the earlier message; none beyond it', () => {
  const dots = [{ id: 7, x: 100, y: 100 }, { id: 3, x: 120, y: 100 }, { id: 9, x: 300, y: 300 }];
  assert.equal(A.HIT_PX, 12);
  // at 100 %: 12 px is 12 units
  assert.equal(A.nearestDot(dots, 108, 100, 1).id, 7);
  assert.equal(A.nearestDot(dots, 113, 100, 1).id, 3);
  assert.equal(A.nearestDot(dots, 110, 100, 1).id, 3, 'equally near: the lower id');
  assert.equal(A.nearestDot(dots, 100, 113, 1), null, 'beyond 12 px');
  // zoomed out to 50 %: 12 px on screen are 24 units of the diagram
  assert.equal(A.nearestDot(dots, 100, 122, 0.5).id, 7);
  assert.equal(A.nearestDot(dots, 100, 125, 0.5), null);
  // zoomed in to 200 %: 6 units
  assert.equal(A.nearestDot(dots, 105, 100, 2).id, 7);
  assert.equal(A.nearestDot(dots, 107, 100, 2), null);
  assert.equal(A.nearestDot([], 0, 0, 1), null);
});
