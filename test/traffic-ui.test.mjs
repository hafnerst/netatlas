// The traffic animation in a real browser (headless Chrome/Edge/Chromium
// through the DevTools protocol; skipped without one): reduced motion shows
// static direction arrows instead of moving dots, at most MAX_DOTS move at
// once however many flows there are (demands first), the animation stops
// while the page is hidden, and it never moves a node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, load, example } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'dist', 'netatlas.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const { MAX_DOTS } = load('ui/traffic.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(page, text, scenario = 'ospf-reroute', step = 1) {
  await page.eval(`(() => { const o = netatlas.loadText(${JSON.stringify(text)}, 'traffic.yaml'); netatlas.setView('physical'); netatlas.playScenario(${JSON.stringify(scenario)}); netatlas.simGo(${step}); return o.opened; })()`);
  await page.settle(150);
}

test('reduced motion: static direction arrows instead of moving dots; Pause is not needed and says so', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await play(page, example('ospf-reroute.yaml'));
    await wait(800);
    const s = await page.eval(`({ dots: netatlas.trafficDots(), circles: document.querySelectorAll('#viewport .traffic-dot').length, arrows: document.querySelectorAll('#viewport .traffic-arrow.demand').length, control: document.querySelectorAll('#viewport .traffic-arrow.control').length, pause: document.getElementById('sim-traffic-pause').disabled, note: /Reduced motion is on: arrows show the direction/.test(document.querySelector('#side-body .sim-traffic').textContent) })`);
    assert.deepEqual(s, { dots: 0, circles: 0, arrows: s.arrows, control: s.control, pause: true, note: true });
    assert.ok(s.arrows >= 6 && s.control > 0, JSON.stringify(s));
    // the arrows don't move: the same picture a second later
    const a = await page.eval(`[...document.querySelectorAll('#viewport .traffic-arrow')].map((p) => p.getAttribute('d')).join('|')`);
    await wait(700);
    assert.equal(await page.eval(`[...document.querySelectorAll('#viewport .traffic-arrow')].map((p) => p.getAttribute('d')).join('|')`), a);
  } finally {
    await page.close();
  }
});

test(`the dot limit: at most ${MAX_DOTS} dots move at once, demands first; nodes never move`, { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    // 120 demands of 100G each between the two sites: far more dots than allowed
    const many = Array.from({ length: 120 }, (_, i) => `  - {id: d${i}, source: w-host, destination: e-srv, bandwidth: 100G}`).join('\n');
    const text = example('ospf-reroute.yaml').replace(/\ndemands:\n[\s\S]*?\n\nscenarios:/, `\ndemands:\n${many}\n\nscenarios:`);
    await play(page, text, 'ospf-reroute', 0);
    const boxes = `[...document.querySelectorAll('#viewport g.node')].map((g) => { const b = g.getBBox(); return [g.getAttribute('data-ref'), Math.round(b.x), Math.round(b.y)].join(); }).join('|')`;
    const nodes = await page.eval(boxes);
    let most = 0;
    for (let i = 0; i < 12; i++) {
      await wait(250);
      most = Math.max(most, await page.eval(`netatlas.trafficDots()`));
    }
    assert.ok(most > MAX_DOTS * 0.8 && most <= MAX_DOTS, `${most} dots`);
    const kinds = await page.eval(`({ demand: document.querySelectorAll('#viewport .traffic-dot.demand').length, control: document.querySelectorAll('#viewport .traffic-dot.control').length })`);
    assert.ok(kinds.demand > kinds.control, JSON.stringify(kinds));
    assert.equal(await page.eval(boxes), nodes, 'the animation never moves a node');
  } finally {
    await page.close();
  }
});

test('a hidden page: the animation stops (no frames), and goes on when it is shown again', { skip, timeout: 120000 }, async () => {
  const page = await openPage(url, { width: 1440, height: 900 });
  try {
    await play(page, example('ospf-reroute.yaml'), 'ospf-reroute', 0);
    await wait(600);
    const pos = `[...document.querySelectorAll('#viewport .traffic-dot')].map((c) => c.getAttribute('cx')).join()`;
    await page.eval(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), true`);
    const p1 = await page.eval(pos);
    await wait(500);
    assert.equal(await page.eval(pos), p1, 'no frame while hidden');
    await page.eval(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }), document.dispatchEvent(new Event('visibilitychange')), true`);
    await wait(500);
    assert.notEqual(await page.eval(pos), p1, 'moving again');
  } finally {
    await page.close();
  }
});
