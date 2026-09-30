// The application shell fits the browser viewport: the document itself never
// scrolls, and long content scrolls inside its own panel. The layout rules
// are checked in the stylesheet, and the behaviour is measured in a real
// browser at several window sizes (the in-page check is src/app/viewport-check.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';
import { VIEWPORTS, findBrowser, runViewportCheck } from '../scripts/browser-selftest.mjs';

const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
/** declarations of the first rule with exactly this selector, outside media queries */
const rule = (selector) => {
  const m = new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css);
  assert.ok(m, 'no rule for ' + selector);
  return m[1];
};

test('stylesheet: the shell is sized by the viewport and the document cannot scroll', () => {
  // no scrolling document: clipped, not merely hidden (a hidden box still scrolls on focus or by script)
  assert.match(rule('html, body'), /height: 100%;[^}]*overflow: hidden; overflow: clip;/);
  const body = rule('body');
  assert.match(body, /grid-template-rows: auto minmax\(0, 1fr\) auto;/, 'the middle row may shrink below its content');
  assert.match(body, /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(body, /height: 100dvh;/);
  // no fixed pixel height anywhere in the shell
  for (const sel of ['html, body', 'body', 'main', '#side', '#side-body', '#outline']) assert.doesNotMatch(rule(sel), /(?:^|[;\s])(?:min-|max-)?height: [0-9.]+px/, sel);
  assert.match(rule('main'), /grid-template-rows: minmax\(0, 1fr\);[^}]*min-height: 0;[^}]*overflow: hidden;/);
  // the panels are the scrolling regions, and the containing blocks of what they scroll
  assert.match(rule('#side-body'), /flex: 1 1 0; min-height: 0; overflow: auto;/);
  assert.match(rule('#outline'), /overflow: auto;[^}]*min-height: 0;/);
  assert.match(rule('#outline, #side-body'), /position: relative;/);
  assert.match(rule('#side'), /display: flex; flex-direction: column; min-height: 0;[^}]*overflow: hidden;/);
  // the toolbar wraps and never takes the whole window; dialogs stay inside it
  assert.match(css, /\.topbar \{[^}]*flex-wrap: wrap;[^}]*max-height: 45dvh; overflow-y: auto;/);
  assert.match(rule('dialog#modal'), /max-height: calc\(100dvh - 24px\);/);
  // the narrow layout keeps both rows shrinkable
  assert.match(css, /@media \(max-width: 860px\) \{\s*main \{[^}]*grid-template-rows: minmax\(0, 1fr\) minmax\(0, 45%\);/);
});

test('the viewport check is part of the built page and covers the documented window sizes', () => {
  const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  assert.match(html, /viewportcheck/);
  assert.ok(VIEWPORTS.length >= 8);
  const sizes = VIEWPORTS.map((v) => v.size.split(',').map(Number));
  assert.ok(sizes.some(([w, h]) => w >= 1900 && h >= 1000), 'a maximized window');
  assert.ok(sizes.some(([w]) => w < 860) && sizes.some(([w]) => w >= 860 && w < 1100), 'both narrow layouts');
  assert.ok(sizes.some(([, h]) => h <= 450), 'a short window (the viewport of a zoomed page)');
});

for (const v of VIEWPORTS) {
  test(`in the browser, ${v.name} (${v.size.replace(',', 'x')}): no document scrollbar, panels scroll inside, controls reachable`, { skip: findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)', timeout: 180000 }, () => {
    const res = runViewportCheck(v);
    assert.ok(!res.error, res.error + '\n' + (res.raw || ''));
    assert.deepEqual(res.failed.map((c) => `${c.name}: ${c.detail}`), []);
    // opening a long form, focusing its last field, both views, every tab, long lists, a dialog
    assert.ok(res.total >= 18, String(res.total));
    for (const want of ['long device form (all cards open)', 'focusing the last field of the form', 'logical view with the form open', 'side panel tab "yaml"', 'a dialog is open']) {
      assert.ok(res.checks.some((c) => c.name === want && c.ok), want);
    }
  });
}
