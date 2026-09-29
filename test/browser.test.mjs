// End-to-end: runs dist/netatlas.html#selftest in headless Chrome/Edge/Chromium
// (DNS disabled) and asserts every in-page check passed. Skipped when no
// Chromium-based browser is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runSelfTest } from '../scripts/browser-selftest.mjs';

test('in-browser self-test (file picker path, view switching, rendering, offline)', { skip: findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)', timeout: 180000 }, () => {
  const res = runSelfTest();
  assert.ok(!res.error, res.error + '\n' + (res.raw || ''));
  const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || ''}`);
  assert.deepEqual(failed, []);
  assert.ok(res.checks.length >= 40);
});
