// The title of the left panel: "Objects", with a one-line note of what can be
// done there, compact, and the same name for assistive technology (a
// complementary region named by a level-2 heading). Checked in the markup and,
// through the DevTools protocol, in the browser's accessibility tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const html = readFileSync(join(root, 'src', 'index.html'), 'utf8');

test('markup: the left panel is a region named by its heading "Objects", with a short note; the right panel is named "Inspector"', () => {
  assert.match(html, /<aside id="outline" aria-labelledby="outline-title" aria-describedby="outline-sub">\s*<div class="ol-header"><h2 id="outline-title" class="ol-heading">Objects<\/h2><span id="outline-sub" class="ol-sub">Select, duplicate, or delete<\/span><\/div>\s*<div id="outline-body"><\/div>/);
  assert.match(html, /<aside id="side" aria-label="Inspector">/);
  assert.doesNotMatch(html, /Model outline/);
});

const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

test('in the browser: announced as the region "Objects" with a level-2 heading; one compact row that stays visible at every width', { skip, timeout: 120000 }, async () => {
  const page = await openPage(pathToFileURL(join(root, 'dist', 'netatlas.html')).href);
  try {
    await page.eval(`netatlas.loadExample(0), true`);
    await page.settle(150);
    await page.cmd('Accessibility.enable');
    const { nodes } = await page.cmd('Accessibility.getFullAXTree');
    const val = (n, k) => (n[k] && n[k].value) || '';
    const prop = (n, k) => ((n.properties || []).find((p) => p.name === k) || { value: {} }).value.value;
    const regions = nodes.filter((n) => val(n, 'role') === 'complementary').map((n) => val(n, 'name'));
    assert.deepEqual(regions.sort(), ['Inspector', 'Objects']);
    const heading = nodes.find((n) => val(n, 'role') === 'heading' && val(n, 'name') === 'Objects');
    assert.ok(heading, 'a heading "Objects"');
    assert.equal(prop(heading, 'level'), 2);
    const region = nodes.find((n) => val(n, 'role') === 'complementary' && val(n, 'name') === 'Objects');
    assert.equal(val(region, 'description'), 'Select, duplicate, or delete');
    for (const [w, h] of [[1440, 900], [1024, 768], [800, 700]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.settle(120);
      const g = await page.eval(`(() => { const head = document.querySelector('#outline .ol-header').getBoundingClientRect(); const panel = document.getElementById('outline').getBoundingClientRect(); const first = document.querySelector('#outline-body').getBoundingClientRect(); return { h: head.height, inside: head.left >= panel.left && head.right <= panel.right + 0.5 && head.top >= panel.top, above: head.bottom <= first.top + 0.5, title: getComputedStyle(document.getElementById('outline-title')).fontSize }; })()`);
      // one row (two at the narrowest panel), so the list keeps its room
      assert.ok(g.h <= 40 && g.inside && g.above, `${w}x${h}: ${JSON.stringify(g)}`);
      assert.equal(g.title, '13px');
    }
  } finally {
    await page.close();
  }
});
