// End-to-end in headless Chrome/Edge/Chromium (DNS disabled): the full in-page
// self-test on the test build (build/netatlas-test.html#selftest, public and
// internal examples), and the released application's own self-test
// (dist/netatlas.html#selftest, its public examples) at a desktop size, a
// narrow window and a zoomed page. Skipped when no Chromium-based browser is
// installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runSelfTest, runPublicSelfTest } from '../scripts/browser-selftest.mjs';

const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

test('in-browser self-test (file picker path, view switching, rendering, offline)', { skip, timeout: 360000 }, () => {
  const res = runSelfTest();
  assert.ok(!res.error, res.error + '\n' + (res.raw || ''));
  const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || ''}`);
  assert.deepEqual(failed, []);
  assert.ok(res.checks.length >= 40);
});

for (const [name, size] of [
  ['desktop', '1600,1000'],
  ['narrow (under 860px)', '800,640'],
  ['1600x900 zoomed to 200%', '800,450'],
]) {
  test(`the released application's self-test (dist/netatlas.html#selftest), ${name}: its public examples in both themes, the Objects list, offline`, { skip, timeout: 360000 }, () => {
    const res = runPublicSelfTest(size);
    assert.ok(!res.error, res.error + '\n' + (res.raw || ''));
    assert.equal(res.scope, 'public');
    const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || ''}`);
    assert.deepEqual(failed, []);
    // per theme: every example loads and draws in both views, the type names, the Objects list
    assert.ok(res.checks.some((c) => /Objects list: folding and unfolding/.test(c.name)));
    assert.ok(res.checks.some((c) => /private-house\.yaml, logical view/.test(c.name)));
  });
}
