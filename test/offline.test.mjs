// The offline contract of the shipped dist/netatlas.html, observed from
// outside the page: a headless Chrome/Edge/Chromium driven through the
// DevTools protocol records every request the page's own target makes
// (scripts/cdp.mjs, observe), however it ends, and every Content Security
// Policy report, while the page runs representative workflows: the start
// screen, every public example in both views and both themes, Help (the
// manual with its pictures, the license), Analyze, a protocol simulation, an
// experiment and the PNG export. The only requests allowed are the page
// itself and data:/blob: URLs it makes. The browser's own background traffic
// (updates, safe browsing) belongs to no page and is not counted; it is also
// switched off (--disable-background-networking) and DNS is disabled.
//
// A control proves that the observation works: requests to an external host
// made from the page are seen (and blocked by its CSP).
//
// This complements what the page checks itself (its CSP, no resource timing
// entries: the public self-test) and the static audit (test/build.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** Requests that are not the page itself or something it made in memory. */
const external = (requests) => requests.filter((r) => !(r.url.split('#')[0] === url || /^(data|blob|about):/.test(r.url)));

test('dist/netatlas.html makes no request beyond itself through its workflows, in both themes', { skip, timeout: 240000 }, async () => {
  for (const dark of [false, true]) {
    const page = await openPage(url, { width: 1440, height: 900, dark, observe: true });
    try {
      await page.settle(150);
      // the start screen, then every public example, both views
      const n = await page.eval('netatlas.examples ? netatlas.examples().length : document.querySelectorAll("#menu-examples .mi-label").length');
      assert.ok(n >= 5, `${n} public examples`);
      for (let i = 0; i < n; i++) {
        await page.eval(`netatlas.loadExample(${i}), netatlas.setView('physical'), true`);
        await page.settle(30);
        await page.eval(`netatlas.setView('logical'), true`);
        await page.settle(30);
      }
      // Help: the manual with its embedded pictures, and the license
      // (openHelp's promise settles when Help is closed: not awaited)
      await page.eval(`void netatlas.openHelp('manual'), true`);
      await page.settle(300);
      const pics = await page.eval(`[...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length`);
      assert.ok(pics > 0, 'the manual shows its embedded pictures');
      await page.key('Escape', 'Escape', 27);
      await page.eval(`void netatlas.openHelp('license'), true`);
      await page.settle(100);
      await page.key('Escape', 'Escape', 27);
      // Analyze, a protocol simulation, an experiment, the PNG export, on the private house
      await page.eval(`netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(60);
      for (const id of ['analyze.checks', 'analyze.spof', 'analyze.addressing']) await page.eval(`netatlas.runCommand(${JSON.stringify(id)}), true`);
      await page.settle(100);
      await page.eval(`netatlas.exitWorkspace().then(() => true)`);
      await page.eval(`netatlas.startProtocolSimulation(), netatlas.simController().setPlaying(false), netatlas.simController().runTo(30000), true`);
      await page.settle(100);
      await page.eval(`netatlas.exitSimulation(), true`);
      const run = await page.eval(`(() => { const r = netatlas.runExperimentNow('cold-tv'); return r ? r.observations.length : -1; })()`);
      assert.ok(run > 0, 'the experiment ran');
      const png = await page.eval(`netatlas.exportPng().then((p) => p && p.blob ? p.blob.size : p ? 1 : 0)`);
      assert.ok(png > 0, 'a PNG was made');
      await page.settle(200);
      const ext = external(page.requests);
      assert.deepEqual(ext, [], `${dark ? 'dark' : 'light'}: requests beyond the page`);
      assert.deepEqual(page.violations, [], 'no Content Security Policy report');
      assert.ok(page.requests.some((r) => r.url.split('#')[0] === url), 'the observation saw the page itself load');
    } finally {
      await page.close();
    }
  }
});

test('control: a request to an external host from the page is observed (and refused by its CSP)', { skip, timeout: 60000 }, async () => {
  const page = await openPage(url, { width: 1000, height: 700, observe: true });
  try {
    await page.settle(100);
    await page.eval(`fetch('https://netatlas-offline-check.invalid/x').catch(() => 0), (new Image()).src = 'http://netatlas-offline-check.invalid/i.png', true`);
    await page.settle(300);
    const seen = external(page.requests).map((r) => r.url);
    const reported = page.violations.map((v) => v.text).join('\n');
    // each attempt is seen as a request, or (where the browser refuses it before it is one) as a CSP report
    for (const host of ['https://netatlas-offline-check.invalid/x', 'http://netatlas-offline-check.invalid/i.png']) assert.ok(seen.includes(host) || reported.includes(host), `${host} was not observed:\n${JSON.stringify(page.requests)}\n${reported}`);
    assert.ok(page.violations.length > 0, 'the CSP refused them');
  } finally {
    await page.close();
  }
});
