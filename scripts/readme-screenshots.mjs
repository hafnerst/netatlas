// Regenerates the README screenshots in docs/img/ from the test build (build/netatlas-test.html),
// using headless Chrome/Edge/Chromium (through the DevTools protocol,
// scripts/cdp.mjs) and the page's deep links
// (#example=<n or file name>&view=<physical|logical>&select=<ref>&devices=<id,…>). Run after "npm run build":
//
//   node scripts/readme-screenshots.mjs                 every screenshot
//   node scripts/readme-screenshots.mjs a.png b.png     only these
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
// the test build: the released application, which can also load the internal test models some pictures show (npm run build writes it)
const html = resolve(root, 'build', 'netatlas-test.html');
/** the screenshots named on the command line (none: every one) */
const only = process.argv.slice(2);
const outDir = join(root, 'docs', 'img');

// file name -> theme, deep link (example numbers follow the Examples menu), and what to do before the shot
const SHOTS = [
  ['editor.png', 'dark', 'example=0&view=logical&select=device:hq-rtr1'],
  ['wan-physical.png', 'light', 'example=0&view=physical'],
  ['wan-logical-gre-selected.png', 'dark', 'example=0&view=logical&select=relation:gre-muc'],
  ['wan-physical-gre-path.png', 'light', 'example=0&view=physical&select=relation:gre-muc'],
  ['device-types.png', 'light', 'example=device-types.yaml&view=physical'],
  ['dc-physical.png', 'dark', 'example=datacenter-evpn.yaml&view=physical'],
  ['metro-physical.png', 'light', 'example=metro-ring.yaml&view=physical'],
  ['metro-logical.png', 'dark', 'example=metro-ring.yaml&view=logical'],
  ['wan-physical-filtered.png', 'light', 'example=0&view=physical&devices=inet,isp1-pe,hq-rtr1,hq-rtr2,hq-fw,hq-core1'],
  ['wan-logical-filtered.png', 'dark', 'example=0&view=logical&devices=inet,isp1-pe,hq-rtr1,hq-rtr2,hq-fw,hq-core1'],
  ['addressing-physical.png', 'light', 'example=addressing.yaml&view=physical'],
  ['addressing-logical-dark.png', 'dark', 'example=addressing.yaml&view=logical'],
  ['ports-logical.png', 'dark', 'example=port-bindings.yaml&view=logical&select=relation:ospf-s1'],
  ['ports-physical-lag.png', 'light', 'example=port-bindings.yaml&view=physical&select=iface:core-a:Po1'],
  ['routes-logical.png', 'dark', 'example=branch-routing.yaml&view=logical&select=route:br-rtr:1'],
  ['tagging-physical.png', 'light', 'example=vlan-ports.yaml&view=physical', 'netatlas.fit()'],
  ['virtualization-physical.png', 'dark', 'example=virtualization.yaml&view=physical', 'netatlas.fit()'],
  ['addressing-overview.png', 'light', 'example=addressing.yaml&view=logical', `document.getElementById('btn-addressing').click(); document.querySelector('[data-addr-toggle="|corp"]').click()`],
  // the three Auto-arrange options on one model, side by side in the README
  ['arrange-default.png', 'light', 'example=private-house.yaml&view=physical', 'netatlas.fit()'],
  ['arrange-compact.png', 'light', 'example=private-house.yaml&view=physical', `document.getElementById('btn-arrange-compact').click(); document.getElementById('toast').hidden = true; netatlas.fit()`],
  ['arrange-structured.png', 'light', 'example=private-house.yaml&view=physical', `document.getElementById('btn-arrange-structured').click(); document.getElementById('toast').hidden = true; netatlas.fit()`],
];

// the simulation layout: file name, window width and height
const SIM_SHOTS = [
  ['sim-layout-wide.png', 1440, 900],
  ['sim-layout-narrow.png', 800, 900],
  ['sim-layout-short.png', 800, 600],
];

async function main() {
  if (!existsSync(html)) {
    console.error('build/netatlas-test.html not found: run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const base = pathToFileURL(html).href;
  const page = await openPage(base, { width: 1700, height: 1050 });
  try {
    for (const [name, theme, link, action] of SHOTS) {
      if (only.length && only.indexOf(name) < 0) continue;
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
      if (action) await page.eval(`(() => { ${action}; return true; })()`);
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
  // the simulation layout (protocol-simulation.yaml, dark) at three window sizes: wide, narrow, narrow and short
  for (const [name, width, height] of SIM_SHOTS) {
    if (only.length && only.indexOf(name) < 0) continue;
    const p = await openPage(base, { width, height });
    try {
      await p.settle(200);
      const ex = 'protocol-simulation.yaml';
      await p.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.loadExampleNamed(${JSON.stringify(ex)}), netatlas.setView('physical'), netatlas.select('device:core1'), netatlas.startProtocolSimulation({ params: {}, senders: netatlas.session.model.devices.map((d) => d.id) }), netatlas.simController().setPlaying(false), netatlas.simController().runTo(25200), netatlas.fit(), true`);
      await p.eval(`(() => { const c = netatlas.simController(); for (let i = 0; i < 20; i++) c.advance(25); c.refresh(true); document.getElementById('toast').hidden = true; return true; })()`);
      await p.mouse('mouseMoved', width - 10, height - 10);
      await p.settle(400);
      const shot = await p.cmd('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
      console.log(`wrote docs/img/${name} (dark, ${width} × ${height})`);
    } finally {
      await p.close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
