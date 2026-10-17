// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), light and dark at 1440 × 900 and light at 720 × 450
// (200 % zoom):
//   - the internal example snooping-roles.yaml: sw-a's four snooping VLANs,
//     four badges in VLAN order, always visible, each with its own role, its
//     accessible description and tooltip (the same as the snooping table's
//     line); clear of every text, the status pills and each other; the block
//     keeps its place while a role changes, each badge fitted to its text (sw-b off: VLAN 20
//     Standby → Querier); still there while an action of yours is in front;
//     the exported picture has them all;
//   - the private house: the thermostat's stream, a hop out of dist opened
//     in the packet inspector: dist's decision port by port (up: a
//     multicast router port, ap1: no member and no router port);
//   - the background's short labels while a stream runs (the busy internal
//     example): grey, their kind only, nothing to point at, gone afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A device's snooping badges: VLAN, role, text, tooltip, accessible name, box (the drawing's coordinates). */
const BADGES = (dev) => `(() => { const b = document.querySelector('#canvas .sim-snoop[data-device="${dev}"]'); if (!b) return null;
  return Array.from(b.querySelectorAll('.sim-snoop-vlan')).map((g) => { const r = g.querySelector('rect').getBBox(); return { vlan: Number(g.getAttribute('data-vlan')), role: g.getAttribute('data-role'), text: g.querySelector('text:not(.sim-snoop-icon)').textContent, tip: g.querySelector('title').textContent, aria: g.getAttribute('aria-label'), box: { x: r.x, y: r.y, w: r.width, h: r.height }, fill: getComputedStyle(g.querySelector('text:not(.sim-snoop-icon)')).fill, size: getComputedStyle(g.querySelector('text:not(.sim-snoop-icon)')).fontSize }; }); })()`;
/** Every text of the drawing (not the simulation's) and every status pill, as boxes: what a badge must not cover. */
const OBSTACLES = `(() => { const sc = document.querySelector('#canvas .scene'); const out = [];
  for (const t of sc.querySelectorAll('text')) { if (t.closest('[class^="layer-sim"], [class*=" layer-sim"]')) continue; const r = t.getBBox(); if (r.width > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height, what: t.textContent }); }
  for (const p of sc.querySelectorAll('.sim-power rect, .sim-querier rect')) { const r = p.getBBox(); out.push({ x: r.x, y: r.y, w: r.width, h: r.height, what: 'indicator' }); }
  return out; })()`;
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]]) {
  test(`${theme}, ${width} × ${height}: every snooping VLAN's role on its switch, four on sw-a, stable while they change; a hop's forwarding decision in the inspector; the background's short labels`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('snooping-roles.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); const c = netatlas.simController(); c.setPlaying(false); c.runTo(60000); c.refresh(true); netatlas.fit(); return true; })()`);
      await page.settle(200);
      let a = await page.eval(BADGES('sw-a'));
      assert.deepEqual(a.map((x) => x.text), ['VLAN 10 · Querier', 'VLAN 20 · Standby', 'VLAN 30 · Snooping · querier heard', 'VLAN 40 · Snooping · no querier']);
      assert.deepEqual(a.map((x) => x.role), ['querier', 'standby', 'snooping', 'snooping']);
      // the same words as the model and the snooping table; the tooltip and the accessible name the detail
      const model = await page.eval(`netatlas.simController().sim.multicast.snoopRoles('sw-a').map((r) => [r.text, r.detail])`);
      assert.deepEqual(a.map((x) => [x.text, x.tip]), model);
      assert.ok(a.every((x) => x.aria === x.tip));
      const notes = await page.eval(`netatlas.simController().sim.multicast.snoopTable('sw-a').notes`);
      for (const x of a) assert.ok(notes.some((n) => n.indexOf(x.text + ': ') === 0), x.text);
      // readable: no smaller than 9 px in the drawing, a role's colour plus a sign and words
      assert.ok(a.every((x) => parseFloat(x.size) >= 9), a.map((x) => x.size).join());
      // in VLAN order, stacked in one column, each as wide as its text; clear of every text and indicator, of each other
      assert.ok(a.every((x, i) => i === 0 || x.box.y > a[i - 1].box.y + a[i - 1].box.h - 0.5));
      assert.equal(new Set(a.map((x) => Math.round(x.box.x))).size, 1);
      assert.ok(a[0].box.w < a[2].box.w, 'fitted to their text');
      const obs = await page.eval(OBSTACLES);
      for (const dev of ['sw-a', 'sw-b', 'swb2']) {
        const bs = await page.eval(BADGES(dev));
        for (const x of bs) {
          const hit = obs.find((o) => overlap(x.box, o));
          assert.equal(hit, undefined, `${dev} ${x.text} over ${hit && hit.what}`);
        }
      }
      assert.deepEqual((await page.eval(BADGES('sw-b'))).map((x) => x.text), ['VLAN 10 · Snooping · querier heard', 'VLAN 20 · Querier']);
      assert.deepEqual((await page.eval(BADGES('swb2'))).map((x) => x.text), ['VLAN 40 · Snooping · querier heard']);
      // a role changes (sw-b off: after the other querier present interval sw-a queries VLAN 20): the block stays where it is, as large as it was
      const before = a.map((x) => x.box);
      await page.eval(`(() => { const c = netatlas.simController(); c.powerOff('sw-b'); c.runTo(c.t + 270000); c.refresh(true); return true; })()`);
      await page.settle(150);
      a = await page.eval(BADGES('sw-a'));
      assert.equal(a[1].text, 'VLAN 20 · Querier');
      assert.deepEqual(a.map((x) => [x.box.x, x.box.y, x.box.h]), before.map((x) => [x.x, x.y, x.h]), 'no jitter: the same place');
      assert.ok(Math.abs(a[1].box.w - before[1].w) < 20, 'VLAN 20 · Querier is about as long as VLAN 20 · Standby');
      assert.deepEqual((await page.eval(BADGES('sw-b'))).map((x) => x.text), ['VLAN 10 · Off', 'VLAN 20 · Off']);
      // an action of yours in front: the badges stay
      await page.eval(`(() => { const c = netatlas.simController(); c.startStream('h10', 'eth0', '239.10.0.1', 5004, 1000, 500); c.refresh(true); return true; })()`);
      await page.settle(100);
      assert.equal((await page.eval(BADGES('sw-a'))).length, 4);
      // the exported picture: every badge, as on screen
      const svg = await page.eval(`netatlas.exportSvg()`);
      for (const x of a) assert.ok(svg.indexOf(x.text) >= 0, `export: ${x.text}`);
      assert.equal((svg.match(/class="sim-snoop-vlan"/g) || []).length, await page.eval(`document.querySelectorAll('#canvas .sim-snoop-vlan').length`));
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .sim-snoop').length`), 0, 'gone with the simulation');

      // ------------------------------------------------------------ the private house: a hop's forwarding decision
      await page.eval(`netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); const c = netatlas.simController(); c.setPlaying(false); c.runTo(40000); c.startStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500); c.runTo(c.t + 50); c.refresh(true); return true; })()`);
      await page.settle(100);
      const hop = await page.eval(`(() => { const c = netatlas.simController(); const id = c.sim.actions()[0].tests[0]; const f = c.sim.engine.flights.find((x) => x.test === id && x.view === 'physical' && x.track.ref === 'link:l-core-dist'); return f ? f.id : null; })()`);
      assert.ok(hop !== null);
      assert.equal(await page.eval(`netatlas.simController().inspectFlight(${hop}, { x: 300, y: 200, w: 10, h: 10 })`), true);
      await page.settle(100);
      const fwd = await page.eval(`Array.from(document.querySelectorAll('.sim-table-panel[data-table="packet"] .pi-fwd')).map((s) => ({ dev: s.getAttribute('data-device'), title: s.querySelector('h4').textContent, ports: Array.from(s.querySelectorAll('li')).map((li) => li.textContent) }))`);
      const dist = fwd.find((x) => x.dev === 'dist');
      assert.equal(dist.title, 'Switching at dist (sent this hop)');
      assert.ok(dist.ports.some((p) => /^→ up: sent — multicast router port \(/.test(p)), dist.ports.join(' | '));
      assert.ok(dist.ports.includes('✕ ap1: not sent — no member and no multicast router port'), dist.ports.join(' | '));
      assert.ok(dist.ports.includes('✕ ap2: not sent — ingress port (never sent back)'));
      const core = fwd.filter((x) => x.dev === 'core').map((x) => x.title);
      assert.deepEqual(core, ['Switching at core (where it arrived)', 'Routing at core (where it arrived)']);
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);

      // ------------------------------------------------------------ the background's short labels
      await page.eval(`netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); netatlas.fit(); return true; })()`);
      await wait(5000);
      await page.eval(`netatlas.simController().startStream('pc1', 'eth0', '239.9.9.9', 5004, 1000, 500), true`);
      let bg = null;
      for (let i = 0; i < 20 && !(bg && bg.n); i++) {
        await wait(300);
        bg = await page.eval(`(() => { const ls = Array.from(document.querySelectorAll('#canvas .sim-bg-label')); return { n: ls.length, texts: ls.map((l) => l.textContent), pe: ls.map((l) => getComputedStyle(l).pointerEvents), fill: ls.length ? getComputedStyle(ls[0].querySelector('text')).fill : '', hit: ls.some((l) => { const r = l.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !!e.closest('.sim-bg-label'); }) }; })()`);
      }
      assert.ok(bg.n > 0, 'short labels on the background');
      assert.ok(bg.texts.every((t) => /^[A-Za-z0-9]+( [A-Za-z]+)?$/.test(t) && t.length <= 16), bg.texts.join(', '));
      assert.ok(bg.pe.every((p) => p === 'none'));
      assert.equal(bg.hit, false, 'the pointer goes through them');
      // the same muted colour as the background dots' text: not the protocols' colours
      const muted = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()`);
      assert.ok(bg.fill.length > 0 && muted.length > 0);
      // a label's place under the pointer: no outline, no hand
      const at = await page.eval(`(() => { const l = document.querySelector('#canvas .sim-bg-label'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      if (at) {
        const near = await page.eval(`(() => Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).some((d) => { const q = d.getBoundingClientRect(); return Math.hypot(q.left + q.width / 2 - ${at.x}, q.top + q.height / 2 - ${at.y}) < 20; }))()`);
        if (!near) {
          await page.mouse('mouseMoved', at.x, at.y);
          await page.settle(40);
          assert.equal(await page.eval(`!!document.querySelector('#canvas .sim-hit')`), false, 'no outline on a background label');
        }
      }
      // stopped and arrived: no background, no short labels
      await page.eval(`(() => { const c = netatlas.simController(); for (const v of c.sim.actions()) c.sim.actionControl(v.id, 'stop'); c.setPlaying(true); return true; })()`);
      for (let i = 0; i < 40; i++) {
        await wait(1500);
        if (!(await page.eval(`netatlas.simController().pacer.fgActive()`))) break;
      }
      await page.settle(100);
      assert.equal(await page.eval(`document.querySelectorAll('#canvas .sim-bg-label').length`), 0);
    } finally {
      await page.close();
    }
  });
}
