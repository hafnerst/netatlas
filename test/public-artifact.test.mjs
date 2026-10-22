// The shipped application, dist/netatlas.html, as it is committed: the
// release package check (no test payload, one inline script, strict CSP, its
// version, the size budget; scripts/release-check.mjs), and its own
// self-test (dist/netatlas.html#selftest, its public examples in both themes,
// the Objects list, offline) in headless Chrome/Edge/Chromium at a desktop
// size, a narrow window and a zoomed page (approximated by the smaller
// viewport a zoomed window has; see VIEWPORTS in scripts/browser-selftest.mjs).
// Nothing here builds: it tests the committed file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, runPublicSelfTest } from '../scripts/browser-selftest.mjs';
import { inspectRelease, internalNames } from '../scripts/release-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

test('the release package check accepts the committed dist/netatlas.html', () => {
  const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.deepEqual(inspectRelease(html, { version, internal: internalNames() }), []);
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
