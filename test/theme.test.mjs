// Light and Dark themes, Dark by default: the design tokens (one set of
// names, WCAG 2.2 AA contrast in both themes), the diagram colours drawn for
// each theme, and, in a headless Chrome/Edge/Chromium driven through the
// DevTools protocol, the theme switch itself (Dark on first launch, stored
// choices kept or migrated, the theme in effect before the first paint, the
// toggle by mouse and keyboard, no storage) and exports in both themes. The browser part is
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
const LIGHT = tokens(':root[data-theme="light"]');
const DARK = tokens(':root, :root[data-theme="dark"]');

test('one set of semantic tokens: both themes define the same names, and nothing else in the stylesheet has a colour of its own', () => {
  assert.deepEqual([...LIGHT.keys()].sort(), [...DARK.keys()].filter((k) => k !== 'font-mono').sort());
  for (const k of ['bg', 'panel', 'canvas', 'raised', 'text', 'muted', 'border', 'control-border', 'accent', 'link', 'error', 'warn', 'ok', 'sel', 'on-accent', 'dev-stroke', 'group-stroke', 'member', 'halo', 'grid', 'shadow', 'backdrop', 'marked-bg', 'marked-bar']) assert.ok(DARK.has(k), k);
  // Dark is the default: the tokens of :root without data-theme are the dark ones
  assert.match(css, /:root, :root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
  assert.match(css, /:root\[data-theme="light"\] \{[^}]*color-scheme: light;/);
  // outside the two token blocks: no hex, rgb() or hsl() colour; and nothing anywhere picks the theme from the system
  const rest = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root\[data-theme="light"\] \{[^}]*\}/, '').replace(/:root, :root\[data-theme="dark"\] \{[^}]*\}/, '');
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,6}\b|rgba?\(|hsla?\(/);
  const html = readFileSync(join(root, 'dist', 'netatlas.html'), 'utf8');
  const code = ['ui/theme.ts', 'ui/app.ts', 'app/main.ts'].map((x) => readFileSync(join(root, 'src', x), 'utf8')).join('\n');
  assert.doesNotMatch(css + code, /prefers-color-scheme|matchMedia\('\(prefers-color/);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*<\/script>/, ''), /prefers-color-scheme/);
  // the script that sets the theme runs in <head>, before the body exists
  assert.ok(html.indexOf('<script>') < html.indexOf('<body'), 'the script is in <head>');
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
    // the selection in the Edit tab: text of every kind stays readable on its tint, and its bar is a 3:1 boundary
    for (const fg of ['text', 'muted', 'accent', 'link', 'error', 'warn', 'ok']) assert.ok(P.contrast(v(fg), v('marked-bg')) >= 4.5, `${name}: ${fg} on marked-bg ${P.contrast(v(fg), v('marked-bg')).toFixed(2)}`);
    for (const s2 of ['panel', 'canvas', 'marked-bg']) assert.ok(P.contrast(v('marked-bar'), v(s2)) >= 3, `${name}: marked-bar on ${s2}`);
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

test('the theme choice: Dark by default; a stored Light or Dark is kept, anything else is Dark; the button says the theme and what a press does', () => {
  assert.equal(T.DEFAULT_THEME, 'dark');
  assert.deepEqual([null, undefined, '', 'system', 'auto', 'LIGHT', 'dark', 'light'].map(T.storedTheme), ['dark', 'dark', 'dark', 'dark', 'dark', 'dark', 'dark', 'light']);
  assert.equal(T.otherTheme('dark'), 'light');
  assert.equal(T.otherTheme('light'), 'dark');
  assert.equal(T.themeButtonText('dark'), 'Theme: Dark. Switch to the light theme');
  assert.equal(T.themeButtonText('light'), 'Theme: Light. Switch to the dark theme');
  assert.equal(T.resolveTheme, undefined, 'no System option is left');
  assert.equal(T.nextThemePref, undefined);
  // never written into a model or an export: only this browser's storage
  const src = ['editor/document.ts', 'yaml/write.ts', 'ui/files.ts'].map((x) => readFileSync(join(root, 'src', x), 'utf8')).join('\n');
  assert.doesNotMatch(src, /data-theme|netatlas\.theme/);
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
const themeOf = (page) => page.eval(`({ theme: document.documentElement.getAttribute('data-theme'), scheme: getComputedStyle(document.documentElement).colorScheme, stored: (() => { try { return localStorage.getItem('netatlas.theme'); } catch { return 'no storage'; } })() })`);
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

/** Before anything of the page runs: record the theme in effect when the <body> is created (the first paint comes after that). */
const WATCH = `window.__atBody = null; window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message)));
new MutationObserver((ms, o) => { if (document.body) { window.__atBody = { theme: document.documentElement.getAttribute('data-theme'), scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }; o.disconnect(); } }).observe(document, { childList: true, subtree: true });`;

test('first launch is Dark; a stored Light stays Light, a stored Dark Dark; System, invalid or nothing becomes Dark; set before the first paint, whatever the OS prefers', { skip, timeout: 180000 }, async () => {
  for (const osDark of [false, true]) {
    const page = await openPage(url, { dark: osDark });
    try {
      await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
      await reload(page);
      // the first launch: nothing stored
      assert.deepEqual(await themeOf(page), { theme: 'dark', scheme: 'dark', stored: null }, `OS ${osDark ? 'dark' : 'light'}: first launch`);
      assert.deepEqual(await page.eval('window.__atBody'), { theme: 'dark', scheme: 'dark', bg: DARK.get('bg') }, 'dark from the start: no flash of the light theme');
      for (const [stored, theme, after] of [['light', 'light', 'light'], ['dark', 'dark', 'dark'], ['system', 'dark', null], ['auto', 'dark', null], ['', 'dark', null]]) {
        await page.eval(`localStorage.setItem('netatlas.theme', ${JSON.stringify(stored)}), true`);
        await reload(page);
        const what = `OS ${osDark ? 'dark' : 'light'}, stored "${stored}"`;
        assert.deepEqual(await themeOf(page), { theme, scheme: theme, stored: after }, what);
        // already in effect when the body was created: no flash of the other theme
        assert.deepEqual(await page.eval('window.__atBody'), { theme, scheme: theme, bg: (theme === 'dark' ? DARK : LIGHT).get('bg') }, what + ': before the first paint');
        assert.deepEqual(await page.eval('window.__errors'), [], what);
      }
    } finally {
      await page.close();
    }
  }
});

test('the theme button: a Light / Dark toggle at the right end of the toolbar, never in a menu; name, tooltip and icon say the theme and what a press does; mouse and keyboard; nothing else changes', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(0), netatlas.setView('logical'), netatlas.select('device:hq-rtr1'), window.__marker = 42, true`);
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
    const btn = () => page.eval(`(() => { const b = document.getElementById('theme-btn'); const tip = document.getElementById('theme-tip'); return { name: b.getAttribute('aria-label'), described: b.getAttribute('aria-describedby'), tip: tip.textContent, tipShown: getComputedStyle(tip).visibility === 'visible', role: tip.getAttribute('role'), icon: [...b.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.getAttribute('class')), svgs: b.querySelectorAll('svg').length }; })()`);
    let b = await btn();
    assert.deepEqual(b, { name: 'Theme: Dark. Switch to the light theme', described: 'theme-tip', tip: 'Theme: Dark. Switch to the light theme', tipShown: false, role: 'tooltip', icon: ['ti ti-dark'], svgs: 2 });
    await page.hover('#theme-btn');
    assert.equal((await btn()).tipShown, true, 'shown on hover');
    const before = await page.eval(STATE);
    const bg = (sel) => page.eval(`(${hex})(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor)`);
    assert.equal(await bg('#canvas-wrap'), BG.dark);
    // a press: Dark -> Light -> Dark
    await page.click('#theme-btn');
    b = await btn();
    assert.deepEqual([b.name, b.icon], ['Theme: Light. Switch to the dark theme', ['ti ti-light']]);
    assert.deepEqual(await themeOf(page), { theme: 'light', scheme: 'light', stored: 'light' });
    assert.equal(await bg('#canvas-wrap'), BG.light);
    assert.equal(await bg('body'), LIGHT.get('bg'));
    assert.deepEqual(await page.eval(STATE), before, 'nothing else changed, and the page was not reloaded');
    // the diagram is repainted: a relation colour is the light theme's
    const stroke = await page.eval(`document.querySelector('#viewport .rel .tube-outer, #viewport .rel .rel-line').getAttribute('stroke')`);
    assert.ok(P.contrast(stroke, BG.light) >= 3, stroke);
    await page.click('#theme-btn');
    assert.deepEqual(await themeOf(page), { theme: 'dark', scheme: 'dark', stored: 'dark' });
    // the keyboard: Tab from the control before it reaches it, the tooltip shows with the focus ring, Enter and Space switch
    await page.mouse('mouseMoved', 700, 600);
    await page.eval(`(() => { const all = [...document.querySelectorAll('header.topbar button, header.topbar input, header.topbar select')].filter((e) => !e.disabled && e.getClientRects().length && !e.closest('[hidden]')); all[all.indexOf(document.getElementById('theme-btn')) - 1].focus(); return true; })()`);
    await page.key('Tab', 'Tab', 9);
    assert.ok(await page.eval(`document.activeElement === document.getElementById('theme-btn')`), 'Tab reaches the theme button');
    const focus = await page.eval(`(() => { const b = document.getElementById('theme-btn'); const cs = getComputedStyle(b); return { visible: b.matches(':focus-visible'), outline: cs.outlineStyle, colour: (${hex})(cs.outlineColor) }; })()`);
    assert.ok(focus.visible && focus.outline === 'solid' && P.contrast(focus.colour, DARK.get('panel')) >= 3, JSON.stringify(focus));
    assert.equal((await btn()).tipShown, true, 'shown with the keyboard focus');
    await page.key('Enter', 'Enter', 13);
    assert.equal((await themeOf(page)).theme, 'light');
    await page.key(' ', 'Space', 32);
    assert.equal((await themeOf(page)).theme, 'dark');
    assert.equal(await page.eval(`document.activeElement === document.getElementById('theme-btn')`), true, 'the focus stays on the button');
  } finally {
    await page.close();
  }
});

test('the choice is remembered in this browser (not in the model); without storage the theme is Dark and a switch lasts for the session', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(2), true`);
    await page.click('#theme-btn');
    assert.deepEqual(await themeOf(page), { theme: 'light', scheme: 'light', stored: 'light' });
    assert.doesNotMatch(await page.eval(`netatlas.exportText()`), /theme|dark/i, 'nothing about the theme in the model');
    await reload(page);
    assert.equal((await themeOf(page)).theme, 'light');
    // no storage at all (some file:// set-ups, private windows): Dark, and switching still works
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message))); Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage denied'); } });` });
    await reload(page);
    assert.deepEqual(await themeOf(page), { theme: 'dark', scheme: 'dark', stored: 'no storage' });
    await page.click('#theme-btn');
    assert.equal((await themeOf(page)).theme, 'light');
    await page.click('#theme-btn');
    assert.equal((await themeOf(page)).theme, 'dark');
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

test('exports: Light and Dark x view x format are drawn in the theme on screen (whatever the OS prefers), with resolved colours and an opaque background', { skip, timeout: 300000 }, async () => {
  const page = await openPage(url);
  try {
    await page.eval(`netatlas.loadExample(6), netatlas.select('iface:core:lo0'), window.__marker = 7, true`);
    for (const [theme, osDark] of [['light', false], ['light', true], ['dark', false], ['dark', true]]) {
      await os(page, osDark);
      await page.eval(`netatlas.theme.set(${JSON.stringify(theme)}), true`);
      for (const view of ['physical', 'logical']) {
        await page.eval(`netatlas.setView(${JSON.stringify(view)}), true`);
        await page.settle(80);
        const before = await page.eval(STATE);
        const themeBefore = await themeOf(page);
        const x = await page.eval(EXPORT);
        const what = `${theme} (OS ${osDark ? 'dark' : 'light'}) ${view}`;
        assert.equal(x.svgTheme, theme, what);
        assert.equal(x.background, BG[theme], `${what}: SVG background`);
        assert.ok(x.backCovers && x.firstChild === 'export-background', `${what}: the background covers the whole picture`);
        assert.deepEqual(x.unresolved, [], `${what}: no stylesheet, variable or media query`);
        assert.ok(x.textFill, `${what}: text has a resolved fill`);
        for (const [what2, screen, file] of x.pairs) if (screen) assert.equal(file, screen, `${what}: ${what2} as on screen`);
        assert.equal(x.pngCorner, BG[theme], `${what}: PNG background`);
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
