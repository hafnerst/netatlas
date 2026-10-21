// On screen (headless Chrome/Edge/Chromium through the DevTools protocol;
// skipped without one), light and dark at 1440 × 900 and light at 720 × 450
// (200 % zoom):
//   - moving packet labels keep the place they got when their dot appeared
//     (the same slot all the way, never more than a label's distance from
//     the dot), every moving foreground dot has its label, background labels
//     keep their dot too; a foreground dot still opens the inspector;
//   - the private house: a join shows on the TV's cable within a few frames;
//     after a leave the port goes 2 s later and no new dot heads there;
//   - the per-VLAN snooping badges fit their text (a few pixels of padding,
//     no trailing space), short ones shorter than long ones, all visible,
//     clear of the drawing's texts and indicators; a role change keeps the
//     block where it is.
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

/** The moving labels now: whose, their slot, how far their box is from their dot (diagram units). */
const LABELS = `(() => { const out = [];
  for (const l of document.querySelectorAll('#canvas .layer-sim-labels [data-for]')) {
    const id = l.getAttribute('data-for'); const d = document.querySelector('#canvas .layer-sim [data-flight="' + id + '"]') || null;
    const r = l.querySelector('rect').getBBox(); let dist = null;
    if (d) { const b = d.getBBox(); const cx = b.x + b.width / 2, cy = b.y + b.height / 2; const dx = Math.max(r.x - cx, 0, cx - (r.x + r.width)); const dy = Math.max(r.y - cy, 0, cy - (r.y + r.height)); dist = Math.hypot(dx, dy); }
    out.push({ id, slot: l.getAttribute('data-slot'), bg: l.classList.contains('sim-bg-label'), dist });
  }
  const dots = Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).map((d) => d.getAttribute('data-flight'));
  return { labels: out, dots }; })()`;

const BADGES = (dev) => `(() => Array.from(document.querySelectorAll('#canvas .sim-snoop[data-device="${dev}"] .sim-snoop-vlan')).map((g) => { const r = g.querySelector('rect').getBBox(); const t = g.querySelector('text:not(.sim-snoop-icon)'); const tb = t.getBBox(); const i = { x: Number(g.querySelector('.sim-snoop-icon').getAttribute('x')) };
  return { text: t.textContent, x: r.x, y: r.y, w: r.width, h: r.height, textRight: tb.x + tb.width, textLen: t.getComputedTextLength(), iconLeft: i.x }; }))()`;
const OBSTACLES = `(() => { const sc = document.querySelector('#canvas .scene'); const out = [];
  for (const t of sc.querySelectorAll('text')) { if (t.closest('[class^="layer-sim"], [class*=" layer-sim"]')) continue; const r = t.getBBox(); if (r.width > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height, what: t.textContent }); }
  for (const p of sc.querySelectorAll('.sim-power rect, .sim-querier rect')) { const r = p.getBBox(); out.push({ x: r.x, y: r.y, w: r.width, h: r.height, what: 'indicator' }); }
  return out; })()`;
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 720, 450]]) {
  test(`${theme}, ${width} × ${height}: moving labels keep their place beside their dot; snooping badges fit their text`, { skip, timeout: 300000 }, async () => {
    const page = await openPage(url, { width, height });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); netatlas.fit(); return true; })()`);
      await wait(3000);
      // a send across several routers (in front) and the scenario behind it
      await page.eval(`(() => { const c = netatlas.simController(); c.sim.actSend({ delivery: 'unicast', from: 'pc1', target: '10.10.20.22', kind: 'icmp', count: 3, interval: 1 }); c.pacer.take(); return true; })()`);
      const slots = new Map();
      let frames = 0;
      let unlabelled = 0;
      for (let i = 0; i < 40; i++) {
        await wait(150);
        const s = await page.eval(LABELS);
        frames++;
        for (const l of s.labels) {
          const k = (l.bg ? 'bg:' : '') + l.id;
          if (!slots.has(k)) slots.set(k, l.slot);
          assert.equal(l.slot, slots.get(k), `label of ${k}: the same place all the way`);
          if (l.dist !== null) assert.ok(l.dist <= 40, `label of ${k} ${l.dist.toFixed(1)} from its dot`);
        }
        // every moving foreground dot has its label (none left out for lack of room)
        const fg = new Set(s.labels.filter((l) => !l.bg).map((l) => l.id));
        unlabelled += s.dots.filter((d) => !fg.has(d)).length;
      }
      assert.ok(slots.size > 5, `${slots.size} labels followed over ${frames} frames`);
      assert.equal(unlabelled, 0, 'every moving foreground dot labelled');
      assert.ok(Array.from(slots.keys()).some((k) => k.indexOf('bg:') === 0), 'background labels too');
      // a foreground dot still opens the inspector
      await page.eval(`netatlas.simController().setPlaying(false), true`);
      await page.settle(60);
      const id = await page.eval(`(() => { const d = document.querySelector('#canvas .layer-sim [data-flight]'); return d ? Number(d.getAttribute('data-flight')) : null; })()`);
      assert.ok(id !== null);
      assert.equal(await page.eval(`netatlas.simController().inspectFlight(${id}, { x: 300, y: 200, w: 10, h: 10 })`), true);
      await page.settle(60);
      assert.ok(await page.eval(`!!document.querySelector('.sim-table-panel[data-table="packet"] .pi')`));
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);

      // ------------------------------------------------------------ the private house: a join and a leave on screen
      await page.eval(`netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); const c = netatlas.simController(); c.runTo(40000); c.refresh(true); netatlas.fit(); c.setPlaying(true); c.startStream('thermostat', 'wlan0', '239.20.0.1', 5004, 1000, 500); return true; })()`);
      await wait(2500);
      const TV = `(() => { const c = netatlas.simController(); return Array.from(document.querySelectorAll('#canvas .layer-sim [data-flight]')).map((d) => c.pacer.find(Number(d.getAttribute('data-flight')))).filter((it) => it && it.f.protocol === 'mcast' && it.f.track.ref === 'link:w-tv').length; })()`;
      assert.equal(await page.eval(TV), 0, 'nobody joined: nothing towards the TV');
      await page.eval(`netatlas.simController().sim.joinGroup('tv', 'wlan0', '239.20.0.1', []), true`);
      // (polled: the stream's example datagram is shown hop by hop first, the simulation waiting for it)
      let n = 0;
      for (let i = 0; i < 300 && !n; i++) {
        await wait(200);
        n = await page.eval(TV);
      }
      assert.ok(n > 0, 'after the join: on the TV’s cable');
      // (the leave's own moment, read in the same turn: the clock goes on between two calls)
      const t0 = await page.eval(`(() => { const s = netatlas.simController().sim; s.actLeave('tv', 'wlan0', '239.20.0.1'); return s.now; })()`);
      // the pending leave (2 s of simulated time), then the last copies' cable (a hop's time): nothing new towards the TV
      // (polled: a loaded machine's simulation may run behind real time)
      let gone = null;
      for (let i = 0; i < 480 && gone === null; i++) {
        await wait(250);
        gone = await page.eval(`(() => { const e = netatlas.simController().sim.events().find((x) => x.device === 'core' && x.what === 'member port expired' && x.t >= ${t0}); return e ? e.t : null; })()`);
      }
      assert.ok(gone !== null && Math.abs(gone - t0 - 2000) < 1, `removed 2 s after the leave (${gone})`);
      let left = 1;
      for (let i = 0; i < 60 && left; i++) {
        await wait(250);
        left = await page.eval(TV);
      }
      assert.equal(left, 0, 'no dot towards the TV any more');
      assert.equal(await page.eval(`netatlas.simController().sim.engine.flights.filter((f) => f.track.ref === 'link:w-tv' && f.protocol === 'mcast' && f.t0 >= ${gone}).length`), 0);
      await page.eval(`netatlas.exitSimulation(), true`);
      await page.settle(100);

      // ------------------------------------------------------------ the badges fit their text
      await page.eval(`netatlas.loadExampleNamed('snooping-roles.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation(); const c = netatlas.simController(); c.setPlaying(false); c.runTo(60000); c.refresh(true); netatlas.fit(); return true; })()`);
      await page.settle(200);
      const a = await page.eval(BADGES('sw-a'));
      assert.deepEqual(a.map((x) => x.text), ['VLAN 10 · Querier', 'VLAN 20 · Standby', 'VLAN 30 · Snooping · querier heard', 'VLAN 40 · Snooping · no querier']);
      for (const x of a) {
        // 4 px before the sign (where it is set), 5 px after the text: no trailing empty space
        assert.ok(x.iconLeft - x.x >= 2 && x.iconLeft - x.x <= 6, `${x.text}: ${(x.iconLeft - x.x).toFixed(1)} px before its sign`);
        const trail = x.x + x.w - x.textRight;
        assert.ok(trail >= 2 && trail <= 8, `${x.text}: ${trail.toFixed(1)} px after its text`);
      }
      assert.ok(a[0].w < a[2].w - 40, 'a short badge is short');
      assert.equal(new Set(a.map((x) => Math.round(x.x))).size, 1, 'one column');
      const obs = await page.eval(OBSTACLES);
      for (const dev of ['sw-a', 'sw-b', 'swb2']) for (const x of await page.eval(BADGES(dev))) {
        const hit = obs.find((o) => overlap(x, o));
        assert.equal(hit, undefined, `${dev} ${x.text} over ${hit && hit.what}`);
      }
      // one VLAN: one badge, fitted too
      const one = await page.eval(BADGES('swb2'));
      assert.equal(one.length, 1);
      assert.ok(one[0].x + one[0].w - one[0].textRight <= 8);
      // a role changes: the block stays, the badge refits
      await page.eval(`(() => { const c = netatlas.simController(); c.powerOff('sw-b'); c.runTo(c.t + 270000); c.refresh(true); return true; })()`);
      await page.settle(150);
      const b = await page.eval(BADGES('sw-a'));
      assert.equal(b[1].text, 'VLAN 20 · Querier');
      assert.deepEqual(b.map((x) => [Math.round(x.x), Math.round(x.y)]), a.map((x) => [Math.round(x.x), Math.round(x.y)]), 'the same place');
      assert.ok(b[1].x + b[1].w - b[1].textRight <= 8, 'refitted');
    } finally {
      await page.close();
    }
  });
}
