// End-to-end in headless Chrome/Edge/Chromium (DNS disabled): the full in-page
// self-test on the test build (build/netatlas-test.html#selftest, public and
// internal examples). The released application's own self-test is in
// public-artifact.test.mjs. Skipped when no Chromium-based browser is
// installed (scripts/run-tests.mjs --strict makes that a failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runSelfTest } from '../scripts/browser-selftest.mjs';

const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

test('in-browser self-test (file picker path, view switching, rendering, offline)', { skip, timeout: 360000 }, () => {
  const res = runSelfTest();
  assert.ok(!res.error, res.error + '\n' + (res.raw || ''));
  const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || ''}`);
  assert.deepEqual(failed, []);
  assert.ok(res.checks.length >= 40);
});
