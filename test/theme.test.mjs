// Light, Dark and System themes: the design tokens (one set of names, WCAG
// 2.2 AA contrast in both themes), the diagram colours drawn for each theme,
// and, in a headless Chrome/Edge/Chromium driven through the DevTools
// protocol, the theme switch itself (System following the operating system
// while the app runs, the button, remembering the choice, no storage) and
// exports in every combination of theme, view and format. The browser part is
// skipped when no Chromium-based browser is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
const P = load('diagram/palette.js');
const T = load('ui/theme.js');
const E = load('ui/export-style.js');
const { mediumStyle } = load('diagram/style.js');
const { builtinProtocols } = load('model/protocols.js');

/** the token declarations of a theme block, name -> value */
function tokens(selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, selector);
  const body = css.slice(at, css.indexOf('}', at));
  return new Map([...body.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const LIGHT = tokens(':root, :root[data-theme="light"]');
const DARK = tokens(':root[data-theme="dark"]');

test('one set of semantic tokens: both themes define the same names, and nothing else in the stylesheet has a colour of its own', () => {
  assert.deepEqual([...DARK.keys()].sort(), [...LIGHT.keys()].filter((k) => k !== 'font-mono').sort());
  for (const k of ['bg', 'panel', 'canvas', 'raised', 'text', 'muted', 'border', 'control-border', 'accent', 'link', 'error', 'warn', 'ok', 'sel', 'on-accent', 'dev-stroke', 'group-stroke', 'member', 'halo', 'grid', 'shadow', 'backdrop']) assert.ok(LIGHT.has(k), k);
  assert.match(css, /:root, :root\[data-theme="light"\] \{[^}]*color-scheme: light;/);
  assert.match(css, /:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
  // outside the two token blocks: no hex, rgb() or hsl() colour, and no prefers-color-scheme (the build derives that one rule)
  const rest = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root, :root\[data-theme="light"\] \{[^}]*\}/, '').replace(/:root\[data-theme="dark"\] \{[^}]*\}/, '');
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,6}\b|rgba?\(|hsla?\(|prefers-color-scheme/);
  // the system theme before the script has run: the build adds the dark tokens once more, for :root without data-theme
  const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  assert.match(html, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{/);
  // the surfaces the diagram colours are adjusted for are the canvas, panel and raised tokens
  assert.deepEqual(P.SURFACES.light, [LIGHT.get('canvas'), LIGHT.get('panel')]);
  assert.deepEqual(P.SURFACES.dark, [DARK.get('canvas'), DARK.get('panel'), DARK.get('raised')]);
});

test('WCAG 2.2 AA in both themes: 4.5:1 for text, 3:1 for control boundaries, focus rings, selection and diagram lines', () => {
  for (const [name, t] of [['light', LIGHT], ['dark', DARK]]) {
    const v = (k) => t.get(k);
    const surfaces = ['bg', 'panel', 'canvas', 'raised'];
    for (const fg of ['text', 'muted']) for (const s of surfaces) assert.ok(P.contrast(v(fg), v(s)) >= 4.5, `${name}: ${fg} on ${s} ${P.contrast(v(fg), v(s)).toFixed(2)}`);
    for (const fg of ['accent', 'link', 'error', 'warn', 'ok']) for (const s of ['panel', 'raised', 'canvas']) assert.ok(P.contrast(v(fg), v(s)) >= 4.5, `${name}: ${fg} on ${s} ${P.contrast(v(fg), v(s)).toFixed(2)}`);
    for (const fg of ['text', 'accent', 'muted']) assert.ok(P.contrast(v(fg), v('accent-soft')) >= 4.5, `${name}: ${fg} on accent-soft`);
    for (const bg of ['accent', 'error', 'warn']) assert.ok(P.contrast(v('on-accent'), v(bg)) >= 4.5, `${name}: on-accent on ${bg}`);
    for (const fg of ['control-border', 'frame', 'accent', 'sel', 'dev-stroke', 'group-stroke', 'member']) for (const s of ['panel', 'canvas', 'bg']) assert.ok(P.contrast(v(fg), v(s)) >= 3, `${name}: ${fg} on ${s} ${P.contrast(v(fg), v(s)).toFixed(2)}`);
  }
  // dark: dark grey, never pure black; off-white, never pure white; surfaces lighter as they rise
  const L = (k) => P.luminance(P.parseHex(DARK.get(k)));
  assert.ok(DARK.get('canvas') !== '#000000' && DARK.get('text') !== '#ffffff');
  assert.ok(L('canvas') > 0.005 && L('text') < 0.85);
  assert.ok(L('canvas') < L('bg') && L('bg') < L('panel') && L('panel') < L('raised'));
});

test('diagram colours per theme: every medium and protocol colour stands out (3:1) on each surface; dark ones are calmer; light ones keep their look', () => {
  const colours = new Set(['fiber', 'copper', 'dac', 'aoc', 'wireless', 'serial', 'virtual', 'unspecified'].map((m) => mediumStyle(m).color));
  for (const p of builtinProtocols().values()) colours.add(p.color);
  colours.add('#ffd43b'); // a pale custom colour
  colours.add('#101010'); // a very dark one
  // HSL saturation
  const sat = (hex) => {
    const [r, g, b] = P.parseHex(hex).map((x) => x / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    return max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  };
  for (const c of colours) {
    for (const theme of ['light', 'dark']) {
      const t = P.themedColor(c, theme);
      for (const s of P.SURFACES[theme]) assert.ok(P.contrast(t, s) >= 3, `${c} in ${theme}: ${t} on ${s} = ${P.contrast(t, s).toFixed(2)}`);
      assert.equal(P.themedColor(c, theme), t, 'deterministic');
    }
    const light = P.themedColor(c, 'light');
    // a colour that already stands out on the light canvas is kept exactly
    if (P.SURFACES.light.every((s) => P.contrast(c, s) >= 3)) assert.equal(light, c);
    // dark: less saturated than the light one, so lines don't glare on dark grey
    assert.ok(sat(P.themedColor(c, 'dark')) <= sat(c) + 0.02, `${c}: ${P.themedColor(c, 'dark')}`);
  }
  // red stays red: the hue is kept
  const hue = (hex) => {
    const [r, g, b] = P.parseHex(hex);
    return r > g && r > b ? 'r' : g > b ? 'g' : 'b';
  };
  for (const c of colours) if (sat(c) > 0.2) assert.equal(hue(P.themedColor(c, 'dark')), hue(c), c);
  assert.equal(P.themedColor('none', 'dark'), 'none');
});

test('the theme choice: System by default, then Light, Dark, System; the button says what is in effect and what a press does', () => {
  assert.equal(T.resolveTheme('system', true), 'dark');
  assert.equal(T.resolveTheme('system', false), 'light');
  assert.equal(T.resolveTheme('light', true), 'light');
  assert.equal(T.resolveTheme('dark', false), 'dark');
  assert.deepEqual(['system', 'light', 'dark'].map(T.nextThemePref), ['light', 'dark', 'system']);
  assert.equal(T.themeButtonText('system', 'dark'), 'Theme: System (dark). Switch to Light');
  assert.equal(T.themeButtonText('light', 'light'), 'Theme: Light. Switch to Dark');
  assert.equal(T.themeButtonText('dark', 'dark'), 'Theme: Dark. Switch to System (follow the operating system)');
  // never written into a model or an export: only this browser's storage
  const src = ['editor/document.ts', 'yaml/write.ts', 'ui/files.ts'].map((f) => readFileSync(join(root, 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /data-theme|netatlas\.theme|ThemePref/);
});

test('export colours: rgb()/rgba() become #rrggbb plus an opacity; other values stay as they are', () => {
  assert.deepEqual(E.resolvedPaint('rgb(21, 24, 29)'), { color: '#15181d', alpha: 1 });
  assert.deepEqual(E.resolvedPaint('rgba(255, 255, 255, 0.025)'), { color: '#ffffff', alpha: 0.025 });
  assert.deepEqual(E.resolvedPaint('rgba(0, 0, 0, 0)'), { color: 'none', alpha: 0 });
  assert.deepEqual(E.resolvedPaint('none'), { color: 'none', alpha: 1 });
});

// ------------------------------------------------------------------ browser

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const BG = { light: LIGHT.get('canvas'), dark: DARK.get('canvas') };

const os = (page, dark) => page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
const themeOf = (page) => page.eval(`({ theme: document.documentElement.getAttribute('data-theme'), pref: document.documentElement.getAttribute('data-theme-pref') })`);
/** what must not change when the theme changes or a picture is exported */
const STATE = `({ view: netatlas.session.state.view, sel: netatlas.session.state.selected, zoom: document.getElementById('viewport').getAttribute('transform'), pos: JSON.stringify([...netatlas.session.positionsFor(netatlas.session.state.view)]), dirty: netatlas.mdoc.dirty, marker: window.__marker })`;
const hex = `(v) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(v); return m ? '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('') : v; }`;

/** Reload the page and wait for the new document's app. */
async function reload(page) {
  await page.eval(`window.__old = true`);
  await page.cmd('Page.reload', {});
  for (let i = 0; i < 200; i++) {
    try {
      if (await page.eval(`!window.__old && document.readyState === 'complete' && !!window.netatlas && !!document.documentElement.getAttribute('data-theme')`)) return;
    } catch {
      /* navigating */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('page did not load');
}

test('System follows the operating system, also while the app runs: instantly, without a reload, keeping view, selection, zoom and layout', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(0), netatlas.setView('logical'), netatlas.select('device:hq-rtr1'), window.__marker = 42, true`);
    await page.settle(150);
    assert.deepEqual(await themeOf(page), { theme: 'light', pref: 'system' });
    const before = await page.eval(STATE);
    const bg = (sel) => page.eval(`(${hex})(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor)`);
    assert.equal(await bg('#canvas-wrap'), BG.light);
    await os(page, true);
    await page.settle(100);
    assert.deepEqual(await themeOf(page), { theme: 'dark', pref: 'system' });
    assert.equal(await bg('#canvas-wrap'), BG.dark);
    assert.equal(await bg('body'), DARK.get('bg'));
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).colorScheme`), 'dark');
    assert.deepEqual(await page.eval(STATE), before, 'nothing else changed, and the page was not reloaded');
    // the diagram is repainted: a cable or relation colour is the dark theme's
    const stroke = await page.eval(`document.querySelector('#viewport .rel .tube-outer, #viewport .rel .rel-line').getAttribute('stroke')`);
    assert.ok(P.contrast(stroke, BG.dark) >= 3, stroke);
    await os(page, false);
    await page.settle(100);
    assert.deepEqual(await themeOf(page), { theme: 'light', pref: 'system' });
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).colorScheme`), 'light');
  } finally {
    await page.close();
  }
});

test('the theme button: at the right end of the toolbar, never in a menu, with a name and tooltip saying the theme and what a press does; keyboard too', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(0), true`);
    await page.settle(150);
    for (const [w, h] of [[1440, 900], [1024, 768], [720, 700], [390, 800]]) {
      await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.settle(120);
      const g = await page.eval(`(() => { const b = document.getElementById('theme-btn').getBoundingClientRect(); const bar = document.querySelector('header.topbar').getBoundingClientRect(); return { b: { l: b.left, r: b.right, t: b.top, bo: b.bottom, w: b.width }, bar: { r: bar.right, bo: bar.bottom }, inMenu: !!document.getElementById('theme-btn').closest('.dropdown, [role=menu]'), last: document.querySelector('header.topbar').lastElementChild.contains(document.getElementById('theme-btn')), hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
      assert.ok(g.b.w >= 24 && g.b.l >= 0 && g.b.r <= w && g.b.t >= 0 && g.b.bo <= g.bar.bo + 0.5, `${w}x${h}: visible in the toolbar ${JSON.stringify(g)}`);
      assert.ok(g.bar.r - g.b.r <= 16, `${w}x${h}: at the right end`);
      assert.ok(!g.inMenu && g.last && !g.hscroll, `${w}x${h}: ${JSON.stringify(g)}`);
    }
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.settle(100);
    const btn = () => page.eval(`(() => { const b = document.getElementById('theme-btn'); const tip = document.getElementById('theme-tip'); return { name: b.getAttribute('aria-label'), described: b.getAttribute('aria-describedby'), tip: tip.textContent, tipShown: getComputedStyle(tip).visibility === 'visible', role: tip.getAttribute('role'), icon: [...b.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.getAttribute('class')) }; })()`);
    let b = await btn();
    assert.equal(b.name, 'Theme: System (light). Switch to Light');
    assert.equal(b.tip, b.name);
    assert.equal(b.described, 'theme-tip');
    assert.equal(b.role, 'tooltip');
    assert.deepEqual(b.icon, ['ti ti-system']);
    assert.equal(b.tipShown, false, 'the tooltip waits for the pointer or the keyboard');
    await page.hover('#theme-btn');
    assert.equal((await btn()).tipShown, true, 'shown on hover');
    // a press: System -> Light -> Dark -> System
    const seq = [];
    for (let i = 0; i < 3; i++) {
      await page.click('#theme-btn');
      b = await btn();
      seq.push([(await themeOf(page)).pref, (await themeOf(page)).theme, b.icon[0], b.name]);
    }
    assert.deepEqual(seq, [
      ['light', 'light', 'ti ti-light', 'Theme: Light. Switch to Dark'],
      ['dark', 'dark', 'ti ti-dark', 'Theme: Dark. Switch to System (follow the operating system)'],
      ['system', 'light', 'ti ti-system', 'Theme: System (light). Switch to Light'],
    ]);
    // the keyboard: Tab from the control before it reaches it, the tooltip shows with the focus ring, Enter switches
    await page.mouse('mouseMoved', 700, 600);
    await page.eval(`(() => { const all = [...document.querySelectorAll('header.topbar button, header.topbar input, header.topbar select')].filter((e) => !e.disabled && e.getClientRects().length && !e.closest('[hidden]')); all[all.indexOf(document.getElementById('theme-btn')) - 1].focus(); return true; })()`);
    await page.key('Tab', 'Tab', 9);
    assert.ok(await page.eval(`document.activeElement === document.getElementById('theme-btn')`), 'Tab reaches the theme button');
    const focus = await page.eval(`(() => { const b = document.getElementById('theme-btn'); const cs = getComputedStyle(b); return { visible: b.matches(':focus-visible'), outline: cs.outlineStyle, colour: (${hex})(cs.outlineColor) }; })()`);
    assert.ok(focus.visible && focus.outline === 'solid' && P.contrast(focus.colour, LIGHT.get('panel')) >= 3, JSON.stringify(focus));
    assert.equal((await btn()).tipShown, true, 'shown with the keyboard focus');
    await page.key('Enter', 'Enter', 13);
    assert.equal((await themeOf(page)).pref, 'light');
  } finally {
    await page.close();
  }
});

test('the choice is remembered in this browser (not in the model); without storage it simply lasts for the session', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(2), true`);
    await page.click('#theme-btn');
    await page.click('#theme-btn');
    assert.equal((await themeOf(page)).pref, 'dark');
    assert.equal(await page.eval(`localStorage.getItem('netatlas.theme')`), 'dark');
    assert.doesNotMatch(await page.eval(`netatlas.exportText()`), /theme|dark/i, 'nothing about the theme in the model');
    await reload(page);
    assert.deepEqual(await themeOf(page), { theme: 'dark', pref: 'dark' });
    await page.click('#theme-btn');
    assert.equal((await themeOf(page)).pref, 'system');
    assert.equal(await page.eval(`localStorage.getItem('netatlas.theme')`), null, 'System is the default: nothing stored');
    // no storage at all (some file:// set-ups, private windows): System, and switching still works
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message))); Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage denied'); } });` });
    await reload(page);
    assert.deepEqual(await themeOf(page), { theme: 'light', pref: 'system' });
    await page.click('#theme-btn');
    await page.click('#theme-btn');
    assert.deepEqual(await themeOf(page), { theme: 'dark', pref: 'dark' });
    assert.deepEqual(await page.eval(`window.__errors`), []);
  } finally {
    await page.close();
  }
});

/** In the page: the export of the view on screen in both formats, measured. */
const EXPORT = `(async () => {
  const toHex = ${hex};
  const svg = netatlas.exportSvg();
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const back = parsed.querySelector('rect.export-background');
  const vb = parsed.getAttribute('viewBox').split(' ').map(Number);
  // what is drawn on screen and in the file: the same colours
  const onScreen = (sel, prop) => { const e = document.querySelector('#viewport ' + sel); return e ? toHex(getComputedStyle(e)[prop]) : null; };
  const inFile = (sel, attr) => { const e = parsed.querySelector(sel); if (!e) return null; for (let x = e; x; x = x.parentElement) if (x.getAttribute && x.getAttribute(attr)) return x.getAttribute(attr); return null; };
  const pairs = [['.dev-box', 'fill', 'fill'], ['.dev-box', 'stroke', 'stroke'], ['.dev-label', 'fill', 'fill'], ['.if-entry text', 'fill', 'fill'], ['.group-box', 'stroke', 'stroke']].map(([sel, prop, attr]) => [sel + ' ' + attr, onScreen(sel, prop), inFile(sel, attr)]);
  const png = await netatlas.exportPng();
  const bmp = await createImageBitmap(png.blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const px = Array.from(ctx.getImageData(2, 2, 1, 1).data);
  return {
    svgTheme: parsed.getAttribute('data-theme'),
    background: back && back.getAttribute('fill'),
    backCovers: !!back && back.getAttribute('x') == vb[0] && back.getAttribute('y') == vb[1] && back.getAttribute('width') == vb[2] && back.getAttribute('height') == vb[3],
    firstChild: parsed.firstElementChild && parsed.firstElementChild.getAttribute('class'),
    unresolved: (svg.match(/<style|var\\(--|prefers-color-scheme|@media|currentColor/g) || []).slice(0, 3),
    textFill: /<text[^>]* fill="#[0-9a-f]{6}"/.test(svg),
    pairs,
    pngCorner: '#' + px.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''),
    pngOpaque: px[3] === 255,
    svg,
  };
})()`;

test('exports: every theme (Light, Dark, System with the OS light and dark) x view x format is drawn in the theme on screen, with resolved colours and an opaque background', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(6), netatlas.select('iface:core:lo0'), window.__marker = 7, true`);
    for (const [pref, osDark] of [['light', false], ['light', true], ['dark', false], ['dark', true], ['system', false], ['system', true]]) {
      await os(page, osDark);
      await page.eval(`netatlas.theme.set(${JSON.stringify(pref)}), true`);
      const expected = pref === 'system' ? (osDark ? 'dark' : 'light') : pref;
      for (const view of ['physical', 'logical']) {
        await page.eval(`netatlas.setView(${JSON.stringify(view)}), true`);
        await page.settle(80);
        const before = await page.eval(STATE);
        const themeBefore = await themeOf(page);
        const x = await page.eval(EXPORT);
        const what = `${pref} (OS ${osDark ? 'dark' : 'light'}) ${view}`;
        assert.equal(x.svgTheme, expected, what);
        assert.equal(x.background, BG[expected], `${what}: SVG background`);
        assert.ok(x.backCovers && x.firstChild === 'export-background', `${what}: the background covers the whole picture`);
        assert.deepEqual(x.unresolved, [], `${what}: no stylesheet, variable or media query`);
        assert.ok(x.textFill, `${what}: text has a resolved fill`);
        for (const [what2, screen, file] of x.pairs) if (screen) assert.equal(file, screen, `${what}: ${what2} as on screen`);
        assert.equal(x.pngCorner, BG[expected], `${what}: PNG background`);
        assert.ok(x.pngOpaque, `${what}: PNG is opaque`);
        // exporting changed nothing on screen
        assert.deepEqual(await page.eval(STATE), before, what);
        assert.deepEqual(await themeOf(page), themeBefore, what);
      }
    }
    // switch and export again: the new theme at once
    await page.eval(`netatlas.theme.set('light'), true`);
    assert.equal((await page.eval(EXPORT)).background, BG.light);
    await page.click('#theme-btn');
    assert.equal((await page.eval(EXPORT)).background, BG.dark);
  } finally {
    await page.close();
  }
});

test('an exported SVG looks the same in a viewer with the other colour scheme', { skip, timeout: 180000 }, async () => {
  const app = await openPage(url);
  let exports;
  try {
    await app.eval(`netatlas.loadExample(6), netatlas.setView('logical'), true`);
    exports = {};
    for (const t of ['light', 'dark']) {
      await app.eval(`netatlas.theme.set(${JSON.stringify(t)}), true`);
      await app.settle(60);
      exports[t] = (await app.eval(EXPORT)).svg;
    }
  } finally {
    await app.close();
  }
  for (const [t, viewerDark] of [['dark', false], ['light', true]]) {
    // the file opened on its own, as a top-level document, in a browser whose colour scheme is the other one
    const viewer = await openPage('data:image/svg+xml;base64,' + Buffer.from(exports[t]).toString('base64'), { dark: viewerDark });
    try {
      const seen = await viewer.eval(`(() => { const toHex = ${hex}; const fill = (sel) => toHex(getComputedStyle(document.querySelector(sel)).fill); return { scheme: matchMedia('(prefers-color-scheme: dark)').matches, back: fill('rect.export-background'), text: fill('text.dev-label') }; })()`);
      assert.equal(seen.scheme, viewerDark);
      assert.equal(seen.back, BG[t], `${t} export in a ${viewerDark ? 'dark' : 'light'} viewer`);
      assert.ok(P.contrast(seen.text, seen.back) >= 4.5, `${t}: text ${seen.text} on ${seen.back}`);
    } finally {
      await viewer.close();
    }
  }
});

/** In the page: every visible piece of text whose contrast with what is behind it is below WCAG AA. */
const CONTRAST = `(() => {
  const parse = (v) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(v); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const behind = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.namespaceURI === 'http://www.w3.org/2000/svg' && e.tagName !== 'svg') {
        // in the diagram: the nearest filled shape drawn behind the text in the same group, else the canvas
        // (the scene has no transforms, so all boxes are in the same coordinates)
        const t = el.getBBox();
        for (let s = e.previousElementSibling; s; s = s.previousElementSibling) {
          if (!/^(rect|circle)$/.test(s.tagName) || s.classList.contains('hit')) continue;
          const b = s.getBBox();
          if (b.x > t.x || b.y > t.y || b.x + b.width < t.x + t.width || b.y + b.height < t.y + t.height) continue;
          const f = parse(getComputedStyle(s).fill);
          if (f && f[3] > 0.5 && getComputedStyle(s).opacity === '1') return f;
        }
        continue;
      }
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let col = parse(getComputedStyle(document.body).backgroundColor);
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
    return col;
  };
  const bad = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    if (el.closest('[hidden], [aria-hidden="true"], script, style, #selftest, .sr-only, .tip')) continue;
    // inactive controls are exempt (WCAG 1.4.3), and so is what is dimmed on purpose around a selection
    if (el.closest('button:disabled, select:disabled, input:disabled, .opt:has(input:disabled), [aria-disabled="true"], .dim, .arrange-group:not([data-status])')) continue;
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    if (op < 0.99) continue;
    const cs = getComputedStyle(el);
    const svgText = el.namespaceURI === 'http://www.w3.org/2000/svg';
    const fg = parse(svgText ? cs.fill : cs.color);
    if (!fg) continue;
    const bg = behind(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, bg), bg);
    if (got < need) bad.push(n.textContent.trim().slice(0, 30) + ' ' + got.toFixed(2) + ' (' + cs.color + ' / ' + cs.fill + ')');
  }
  return bad;
})()`;

test('automated contrast check of the rendered application, both themes: panels, menus, dialogs, the diagram and its labels', { skip, timeout: 240000 }, async () => {
  const page = await openPage(url);
  try {
    for (const theme of ['light', 'dark']) {
      await page.eval(`netatlas.theme.set(${JSON.stringify(theme)}), true`);
      const found = [];
      const look = async (state) => {
        await page.settle(120);
        for (const x of await page.eval(CONTRAST)) found.push(`${state}: ${x}`);
      };
      await page.eval(`netatlas.closeModel && netatlas.closeModel(), true`);
      await look('start screen');
      for (const ex of [0, 6]) {
        await page.eval(`netatlas.loadExample(${ex}), netatlas.setView('physical'), true`);
        await look(`example ${ex} physical, Legend`);
        await page.eval(`netatlas.setView('logical'), true`);
        await look(`example ${ex} logical`);
      }
      await page.eval(`netatlas.select('device:core', true), true`);
      await look('a device in the Edit tab');
      await page.click('[data-tab="details"]');
      await look('Details');
      await page.click('[data-tab="yaml"]');
      await look('YAML');
      await page.click('#menu-btn');
      await look('File menu');
      await page.key('Escape', 'Escape', 27);
      await page.click('#help-btn');
      await page.click('#btn-manual');
      await look('User Manual');
      await page.key('Escape', 'Escape', 27);
      await page.click('#help-btn');
      await page.click('#btn-license');
      await look('License');
      await page.key('Escape', 'Escape', 27);
      assert.deepEqual(found, [], theme + ':\n' + found.join('\n'));
    }
  } finally {
    await page.close();
  }
});
