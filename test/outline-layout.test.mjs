// The Objects list's section headings stand still when a section is folded
// or unfolded. The cause of the old shift was in the styles: a folded section
// had a smaller top margin (4 px instead of 10 px), so its own heading moved
// up by 6 px; the caret also changed glyph (▸ / ▾). The browser checks measure
// it (src/app/outline-check.ts, run by the self-test, the released
// application's self-test and the viewport check at every window size); this
// test keeps the rules that make it so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
const inspector = readFileSync(join(root, 'src', 'ui', 'inspector.ts'), 'utf8');

test('one spacing for open and folded sections; one caret glyph, turned by a transform; one line box for the heading', () => {
  assert.match(css, /^\.ol-section \{ margin-top: 8px; \}$/m);
  assert.doesNotMatch(css, /\.ol-section\.folded \{[^}]*(margin|padding|border|height)/, 'a folded section changes no spacing');
  assert.match(css, /^\.ol-section\.folded \.ol-caret \{ transform: rotate\(-90deg\); \}$/m);
  assert.match(css, /^\.ol-caret \{ display: inline-block; width: 10px; flex: none; font-size: 10px; text-align: center; \}$/m);
  assert.match(css, /^\.ol-toggle > \* \{ line-height: 16px; \}$/m);
  assert.match(css, /\.ol-toggle \{[^}]*line-height: 16px;/);
  // the caret is the same glyph in both states
  assert.match(inspector, /this\.e\('span', \{ class: 'ol-caret', 'aria-hidden': 'true' \}, \['▾'\]\)/);
  assert.doesNotMatch(inspector, /folded \? '▸' : '▾'/);
  // focus is an outline (no room), and the list keeps its scrollbar's room either way
  assert.match(css, /^button:focus-visible, select:focus-visible, input:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 1px; \}$/m);
  assert.match(css, /#outline \{[^}]*scrollbar-gutter: stable;/);
});

test('the keyboard focus stays on the heading (or Collapse all) it was on; the state is announced by aria-expanded', () => {
  assert.match(inspector, /this\.refocusOutline\(`\[data-act="fold"\]\[data-kind="\$\{kind\}"\]`, \(\) => this\.host\.changed\('filter'\)\);/);
  assert.match(inspector, /this\.refocusOutline\('\[data-act="fold-all"\]', \(\) => this\.host\.changed\('filter'\)\);/);
  assert.match(inspector, /'aria-expanded': folded \? 'false' : 'true', 'aria-controls': listId/);
});

test('the browser checks run it: the self-test and the released application’s self-test in both themes, the viewport check at every size', () => {
  for (const f of ['selftest.ts', 'public-selftest.ts', 'viewport-check.ts']) {
    const src = readFileSync(join(root, 'src', 'app', f), 'utf8');
    assert.match(src, /import \{ outlineStability \} from '\.\/outline-check';/, f);
    assert.match(src, /for \(const theme of \['light', 'dark'\]\)[\s\S]*outlineStability\(app, doc\)/, f);
  }
  const check = readFileSync(join(root, 'src', 'app', 'outline-check.ts'), 'utf8');
  // an empty section (no networks), populated ones, a folded section with a problem badge; by a click, by the keyboard, all at once
  assert.match(check, /links:\n  - \{id: l1, a: "d1:e0", b: "d2:nope"\}/);
  assert.doesNotMatch(check.slice(check.indexOf('OUTLINE_MODEL'), check.indexOf('`;')), /\nnetworks:/);
  assert.match(check, /for \(const keyboard of \[false, true\]\)/);
  assert.match(check, /data-act="fold-all"/);
});
