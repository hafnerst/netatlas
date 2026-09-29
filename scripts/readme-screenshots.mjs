// Regenerates the README screenshots in docs/img/ from dist/netatlas.html,
// using headless Chrome/Edge/Chromium and the page's deep links
// (#example=<n>&view=<physical|logical>&select=<ref>). Run after "npm run build":
//
//   node scripts/readme-screenshots.mjs
//
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser explicitly.
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, run } from './browser-selftest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'dist', 'netatlas.html');
const outDir = join(root, 'docs', 'img');

// file name -> deep link (example numbers follow the Examples menu)
const SHOTS = [
  ['editor.png', 'example=0&view=logical&select=device:hq-rtr1'],
  ['wan-physical.png', 'example=0&view=physical'],
  ['wan-logical-gre-selected.png', 'example=0&view=logical&select=relation:gre-muc'],
  ['wan-physical-gre-path.png', 'example=0&view=physical&select=relation:gre-muc'],
  ['device-types.png', 'example=7&view=physical'],
  ['dc-physical.png', 'example=1&view=physical'],
  ['metro-physical.png', 'example=6&view=physical'],
  ['metro-logical.png', 'example=6&view=logical'],
];

const browser = findBrowser();
if (!browser) {
  console.error('no Chrome/Edge/Chromium found (set NETATLAS_BROWSER=/path/to/browser)');
  process.exit(2);
}
if (!existsSync(html)) {
  console.error('dist/netatlas.html not found: run "npm run build" first');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const [name, link] of SHOTS) {
  const file = join(outDir, name);
  run(browser, pathToFileURL(html).href + '#' + link, ['--window-size=1700,1050', '--hide-scrollbars', `--screenshot=${file}`]);
  console.log('wrote docs/img/' + name);
}
