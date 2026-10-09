// Regenerates the README screenshots in docs/img/ from dist/netatlas.html,
// using headless Chrome/Edge/Chromium (through the DevTools protocol,
// scripts/cdp.mjs) and the page's deep links
// (#example=<n>&view=<physical|logical>&select=<ref>&devices=<id,…>). Run after "npm run build":
//
//   node scripts/readme-screenshots.mjs
//
// Each shot names its theme: the page is opened with that choice stored, as a
// user who chose it would see it (Dark is the default). The README shows both.
//
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser explicitly.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'dist', 'netatlas.html');
const outDir = join(root, 'docs', 'img');

// file name -> theme, deep link (example numbers follow the Examples menu)
const SHOTS = [
  ['editor.png', 'dark', 'example=0&view=logical&select=device:hq-rtr1'],
  ['wan-physical.png', 'light', 'example=0&view=physical'],
  ['wan-logical-gre-selected.png', 'dark', 'example=0&view=logical&select=relation:gre-muc'],
  ['wan-physical-gre-path.png', 'light', 'example=0&view=physical&select=relation:gre-muc'],
  ['device-types.png', 'light', 'example=4&view=physical'],
  ['dc-physical.png', 'dark', 'example=1&view=physical'],
  ['metro-physical.png', 'light', 'example=3&view=physical'],
  ['metro-logical.png', 'dark', 'example=3&view=logical'],
  ['wan-physical-filtered.png', 'light', 'example=0&view=physical&devices=inet,isp1-pe,hq-rtr1,hq-rtr2,hq-fw,hq-core1'],
  ['wan-logical-filtered.png', 'dark', 'example=0&view=logical&devices=inet,isp1-pe,hq-rtr1,hq-rtr2,hq-fw,hq-core1'],
  ['addressing-physical.png', 'light', 'example=6&view=physical'],
  ['addressing-logical-dark.png', 'dark', 'example=6&view=logical'],
];

async function main() {
  if (!existsSync(html)) {
    console.error('dist/netatlas.html not found: run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const base = pathToFileURL(html).href;
  const page = await openPage(base, { width: 1700, height: 1050 });
  try {
    for (const [name, theme, link] of SHOTS) {
      await page.eval(`localStorage.setItem('netatlas.theme', ${JSON.stringify(theme)}), window.__old = true`);
      // a new document each time (a changed '#…' alone would not load the page again)
      await page.cmd('Page.navigate', { url: base + '?' + name + '#' + link });
      for (let i = 0; i < 200; i++) {
        try {
          if (await page.eval(`!window.__old && document.readyState === 'complete' && !!window.netatlas && !!netatlas.session`)) break;
        } catch {
          /* navigating */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await page.mouse('mouseMoved', 1690, 1040);
      await page.settle(300);
      const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
      console.log(`wrote docs/img/${name} (${theme})`);
    }
  } finally {
    await page.eval(`localStorage.removeItem('netatlas.theme'), true`).catch(() => {});
    await page.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
