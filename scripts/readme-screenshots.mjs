// Regenerates the four README screenshots in docs/img/ from the released
// application (dist/netatlas.html, its public examples only), using headless
// Chrome/Edge/Chromium through the DevTools protocol (scripts/cdp.mjs). Run
// after "npm run build":
//
//   node scripts/readme-screenshots.mjs                         all four
//   node scripts/readme-screenshots.mjs readme-physical.png     only these
//
// Each shot is cropped to the part of the window that shows its point (the
// diagram, or the diagram with a window or the simulation panels) at a zoom
// whose labels stay readable at the README's width. Nothing is edited
// afterwards: the pictures are what the application draws.
//
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser explicitly.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'dist', 'netatlas.html');
const only = process.argv.slice(2);
const outDir = join(root, 'docs', 'img');

/** centre the diagram on some objects at a zoom (the app's own view state, as a user's pan and zoom) */
const CENTER = `const center = (refs, k) => {
  const bs = refs.map((r) => document.querySelector('#canvas [data-ref="' + r + '"]').getBBox());
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.width)), y1 = Math.max(...bs.map((b) => b.y + b.height));
  const svg = document.getElementById('canvas');
  netatlas.zoom = { k, tx: svg.clientWidth / 2 - ((x0 + x1) / 2) * k, ty: svg.clientHeight / 2 - ((y0 + y1) / 2) * k };
  netatlas.applyZoom();
};`;

// name, theme, window size, what to crop (the diagram and these elements), the steps in the page, real ms to wait
const SHOTS = [
  // an industrial cell: devices, ports and cables, zones as groups (physical view, Default)
  ['readme-physical.png', 'light', [1680, 840], [], `netatlas.loadExampleNamed('ot-network.yaml'); netatlas.setView('physical'); netatlas.fit();`],
  // a campus in the logical view, arranged with Compact: VLAN networks, the core's interfaces, routes, groups
  ['readme-logical.png', 'light', [1680, 1180], [], `netatlas.loadExampleNamed('enterprise-campus.yaml'); netatlas.setView('logical'); document.getElementById('btn-arrange-compact').click(); await new Promise((r) => setTimeout(r, 200)); netatlas.fit();`],
  // Analyze → Trace path across a hybrid cloud, with the return path: the hops marked in the diagram, the hop table
  ['readme-analysis.png', 'dark', [1680, 1000], ['#toolwin'], `netatlas.loadExampleNamed('hybrid-cloud.yaml'); netatlas.setView('physical'); localStorage.removeItem('netatlas.window.trace'); netatlas.setTraceForm({ from: 'dc-pc', to: 'web-1', back: true }); netatlas.openTrace(); netatlas.runTrace(); netatlas.fit();`],
  // a protocol simulation of the home network: five pings from the laptop to the NAS on their way, the Network events
  // form, the protocols' status and the event log
  ['readme-simulation.png', 'dark', [1440, 900], ['#sim-actions', '#sim-dock'], `netatlas.loadExampleNamed('private-house.yaml'); netatlas.setView('physical'); sessionStorage.clear(); localStorage.removeItem('netatlas.dockHeight');
    netatlas.startProtocolSimulation({ senders: ['laptop', 'nas'] }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(30000);
    const set = (id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev || 'change')); };
    set('sim-t-type', 'unicast'); set('sim-t-from', 'laptop'); set('sim-t-to', 'nas'); set('sim-t-kind', 'icmp'); set('sim-t-count', '5', 'input'); set('sim-t-interval', '1', 'input');
    document.getElementById('sim-t-send').click(); c.setPlaying(true); await new Promise((r) => setTimeout(r, 100));
    center(['device:laptop', 'device:nas', 'device:dist', 'device:core'], 0.62);`, 7000],
];

async function main() {
  if (!existsSync(html)) {
    console.error('dist/netatlas.html not found: run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, theme, [width, height], parts, steps, wait] of SHOTS) {
    if (only.length && only.indexOf(name) < 0) continue;
    const page = await openPage(pathToFileURL(html).href, { width, height });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set(${JSON.stringify(theme)}), true`);
      await page.eval(`(async () => { ${CENTER} ${steps} return true; })()`);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      await page.eval(`(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; return true; })()`);
      // the pointer out of the way (no hover marks)
      await page.mouse('mouseMoved', width - 3, height - 3);
      await page.settle(400);
      const rs = [await page.rect('#canvas-wrap')];
      for (const sel of parts) rs.push(await page.rect(sel));
      const x0 = Math.min(...rs.map((r) => r.x));
      const y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w));
      const y1 = Math.max(...rs.map((r) => r.y + r.h));
      const shot = await page.cmd('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 } });
      writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
      console.log(`wrote docs/img/${name} (${theme}, ${Math.round(x1 - x0)} × ${Math.round(y1 - y0)})`);
    } finally {
      await page.close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
