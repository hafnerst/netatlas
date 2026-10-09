// Takes the screenshots of Help → User Manual from the real application:
// it opens dist/netatlas.html in headless Chrome/Edge/Chromium, drives the UI
// into each state (menus open, a device selected, a connection being drawn …)
// with real pointer and keyboard input, and saves cropped WebP images to
// docs/img/manual/. "npm run build" then embeds them (scripts/gen-help.mjs).
//
//   npm run build && node scripts/manual-screenshots.mjs && npm run build
//
// The browser is controlled through the DevTools protocol (scripts/cdp.mjs).
// Set NETATLAS_BROWSER=/path/to/chrome to choose the browser.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = resolve(root, 'dist', 'netatlas.html');
const outDir = join(root, 'docs', 'img', 'manual');

/** a box around some rectangles, with a margin */
const around = (rs, m = 12) => {
  const x = Math.min(...rs.map((r) => r.x)) - m;
  const y = Math.min(...rs.map((r) => r.y)) - m;
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) + m - x, h: Math.max(...rs.map((r) => r.y + r.h)) + m - y };
};

async function main() {
  if (!existsSync(html)) {
    console.error('dist/netatlas.html not found: run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const page = await openPage(pathToFileURL(html).href);
  const saved = [];
  const save = async (name, clip, opts) => {
    const data = await page.shot(clip, opts);
    writeFileSync(join(outDir, name + '.webp'), data);
    saved.push(`${name}.webp ${(data.length / 1024).toFixed(1)} KiB`);
  };
  try {
    // the start screen
    await page.settle(200);
    const start = await page.rect('#empty .start');
    await save('start', around([start], 20));

    // the enterprise WAN example, physical view
    await page.eval('netatlas.loadExample(0), netatlas.setView("physical"), true');
    await page.settle(200);
    await page.key('f', 'KeyF', 70);
    // the File menu
    await page.click('#menu-btn');
    await save('file-menu', around([await page.rect('#menu-btn'), await page.rect('#main-menu')], 10));
    await page.key('Escape', 'Escape', 27);
    // the Export menu with its submenu
    await page.click('#export-btn');
    await page.click('#btn-export-as');
    await save('export-menu', around([await page.rect('#export-btn'), await page.rect('#export-menu')], 10));
    await page.key('Escape', 'Escape', 27);
    await page.key('Escape', 'Escape', 27);
    await page.mouse('mouseMoved', 700, 890);
    await page.eval('document.activeElement && document.activeElement.blur(), true');
    await page.settle();

    // the whole window, physical view
    await save('physical', { x: 0, y: 0, w: 1440, h: 900 }, { scale: 0.75, quality: 80 });

    // the logical view of the metro ring example
    await page.eval('netatlas.loadExample(3), netatlas.setView("logical"), true');
    await page.settle(200);
    await page.key('f', 'KeyF', 70);
    await page.key('+', 'Equal', 187);
    await page.key('+', 'Equal', 187);
    await page.mouse('mouseMoved', 1430, 890);
    {
      // the drawing (not the empty canvas around it), as far as it is on screen
      const c = await page.rect('#canvas-wrap');
      const v = await page.rect('#viewport');
      const x = Math.max(c.x, v.x - 16);
      const y = Math.max(c.y, v.y - 16);
      await save('logical', { x, y, w: Math.min(c.x + c.w, v.x + v.w + 16) - x, h: Math.min(c.y + c.h, v.y + v.h + 16) - y });
    }
    await page.eval('netatlas.loadExample(0), netatlas.setView("logical"), true');
    await page.settle(200);

    // Find in diagram, with matches
    await page.click('#find-btn');
    await page.click('#btn-find');
    await page.type('hq-r');
    await save('find', around([await page.rect('#find-bar'), await page.rect('#search-results')], 12));
    await page.key('Escape', 'Escape', 27);

    // Filter object list
    await page.click('#find-btn');
    await page.click('#btn-outline-filter');
    await page.type('muc');
    const outline = await page.rect('#outline');
    const lastRow = await page.eval(`(() => { const rs = document.querySelectorAll('#outline .ol-item'); const r = rs[rs.length - 1].getBoundingClientRect(); return r.bottom; })()`);
    await save('filter-list', { x: 0, y: outline.y, w: outline.w, h: lastRow - outline.y + 6 });
    await page.key('Escape', 'Escape', 27);

    // the Edit tab of a device
    await page.eval('netatlas.setView("physical"), netatlas.select("device:hq-rtr1", true), true');
    await page.click('[data-tab="edit"]');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(150);
    const side = await page.rect('#side');
    await save('edit', { x: side.x, y: side.y, w: side.w, h: Math.min(560, side.h) });

    // the quick actions on the row under the pointer (a different row than the selected one)
    await page.hover('#outline .ol-item[data-ref="device:hq-fw"]');
    const row = await page.rect('#outline .ol-item[data-ref="device:hq-fw"]');
    const sec = await page.rect('#outline [data-section="device"]');
    await save('quick-actions', { x: 0, y: sec.y - 4, w: outline.w, h: Math.min(row.y + row.h + 70, sec.y + sec.h) - sec.y + 8 });

    // a connection being drawn in the physical view
    await page.key('Escape', 'Escape', 27);
    await page.eval('netatlas.select(null), document.activeElement && document.activeElement.blur(), true');
    await page.key('f', 'KeyF', 70);
    await page.settle(100);
    await page.click('#viewport [data-ref="device:muc-rtr"]', 'right');
    {
      // the dashed line follows the pointer, here over empty background between the branch and headquarters
      const c = await page.rect('#canvas-wrap');
      await page.mouse('mouseMoved', c.x + c.w * 0.27, c.y + c.h * 0.6);
    }
    await page.settle(100);
    await save('connect', around([await page.rect('#canvas-wrap')], 0), { scale: 0.85 });
    await page.key('Escape', 'Escape', 27);

    // the View, Auto-arrange and Filters groups of the toolbar
    await page.mouse('mouseMoved', 700, 890);
    await page.settle();
    await save('toolbar-groups', around([await page.rect('#view-group'), await page.rect('#filters-group')], 8));

    // the addresses of a router in the logical view, at 100 % (addressing example)
    await page.eval('netatlas.loadExample(6), netatlas.setView("logical"), netatlas.select("device:core", true), netatlas.select(null), true');
    await page.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.getElementById('viewport').getAttribute('transform')); netatlas.zoomBy(1 / Number(m[1])); return true; })()`);
    await page.eval('netatlas.select("device:core", true), netatlas.select(null), true');
    await page.mouse('mouseMoved', 700, 890);
    // (a message left over from the connection above is not part of this picture)
    await page.eval("document.getElementById('toast').hidden = true");
    await page.settle(200);
    {
      const c = await page.rect('#canvas-wrap');
      const b = await page.rect('#viewport [data-ref="device:core"] .dev-box');
      const x = Math.max(c.x, b.x - 150);
      const y = Math.max(c.y, b.y - 20);
      await save('addresses', { x, y, w: Math.min(c.x + c.w, b.x + b.w + 150) - x, h: Math.min(c.y + c.h, y + 470) - y });
    }

    // the Edit tab marks what was clicked: an address of an interface (addressing example, logical view)
    await page.eval('netatlas.showTab("edit"), netatlas.select("iface:core:lo0", true), netatlas.select(null), true');
    await page.settle(150);
    await page.click('#viewport [data-ref="iface:core:lo0"] tspan[data-value="2001:db8:ffff:ffff::1/128"]');
    await page.mouse('mouseMoved', 700, 890);
    await page.settle(700);
    {
      const card = await page.rect('#side-body details.card[open]');
      const mark = await page.rect('#side-body .sel-mark');
      const side = await page.rect('#side');
      const y = Math.max(side.y, Math.min(card.y, mark.y - 140) - 6);
      await save('edit-mark', { x: side.x, y, w: side.w, h: Math.min(mark.y + mark.h + 24, side.y + side.h) - y });
    }

    // the theme switch with its tooltip, in the dark theme (the default)
    await page.hover('#theme-btn');
    await page.settle(150);
    {
      const bar = await page.rect('header.topbar');
      const tip = await page.rect('#theme-tip');
      const x = Math.min(tip.x, bar.x + bar.w - 380);
      await save('theme', { x, y: 0, w: bar.x + bar.w - x, h: tip.y + tip.h + 10 });
    }
  } finally {
    await page.close();
  }
  for (const s of saved) console.log('wrote docs/img/manual/' + s);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
