// TCP flags on the packet labels, in the browser (headless Chrome/Edge/
// Chromium through the DevTools protocol; skipped without one): a TCP Send
// test's segments are drawn as separate dots labelled TCP [S], TCP [S,A],
// TCP [A], TCP [P,A] · … in both views; each dot's label names exactly the
// flags the packet inspector lists for that dot. Both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** The labels on screen now that belong to dots (their flight ids and texts). */
const LABELS = `Array.from(document.querySelectorAll('#canvas .layer-sim-labels [data-for]')).map((g) => ({ id: Number(g.getAttribute('data-for')), text: g.textContent }))`;
const PANEL = `(() => { const p = document.querySelector('.sim-table-panel[data-table="packet"]'); return p && !p.hidden ? p.querySelector('.pi').textContent : null; })()`;
const LETTERS = { SYN: 'S', FIN: 'F', RST: 'R', PSH: 'P', ACK: 'A', URG: 'U', ECE: 'E', CWR: 'C' };
const WANT = ['[S]', '[S,A]', '[A]', '[P,A]'];
const isTestTcp = (text) => text.indexOf('Test · TCP [') === 0;

for (const [theme, view] of [['light', 'physical'], ['dark', 'logical']]) {
  test(`${theme}, ${view} view: a TCP test's [S], [S,A], [A] and data are separate dots; each label's flags are the inspector's`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('protocol-simulation.yaml'), netatlas.setView('${view}'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(30000); c.setSpeed(4); c.refresh(true); return true; })()`);
      const msg = await page.eval(`netatlas.simController().sendTest({ from: 'pc1', to: 'srv', kind: 'tcp', port: 443 })`);
      assert.match(msg, /Sent at t = /, msg);
      const seen = new Map();
      let checked = 0;
      // each label against its inspector as soon as it is on screen: the flags the inspector lists, by their letters, are the label's
      const check = async (id, text) => {
        if (!(await page.eval(`netatlas.simController().inspectFlight(${id})`))) return;
        await page.settle(30);
        const panel = (await page.eval(PANEL)) || '';
        const at = panel.indexOf('Flags[');
        assert.ok(at >= 0, `the inspector lists the flags: ${panel}`);
        const flags = panel.slice(at + 5, panel.indexOf(']', at) + 1);
        assert.ok(text.indexOf(flags) >= 0, `label "${text}" vs the inspector's ${flags}`);
        const rest = panel.slice(panel.indexOf(']', at) + 2);
        const names = rest.slice(0, rest.indexOf('Sequence') >= 0 ? rest.indexOf('Sequence') : rest.length).split(', ').map((x) => x.replace(/ \(.\)$/, '').trim());
        assert.equal('[' + names.map((n) => LETTERS[n]).join(',') + ']', flags, `the names spell the letters: ${names.join(', ')}`);
        checked++;
      };
      for (let i = 0; i < 400; i++) {
        await page.eval(`netatlas.simController().setPlaying(true), true`);
        await new Promise((r) => setTimeout(r, 100));
        await page.eval(`netatlas.simController().setPlaying(false), true`);
        await page.settle(20);
        for (const l of await page.eval(LABELS)) {
          if (!isTestTcp(l.text) || seen.has(l.id)) continue;
          seen.set(l.id, l.text);
          await check(l.id, l.text);
        }
        const texts = Array.from(seen.values());
        if (WANT.every((f) => texts.some((t) => t.indexOf('TCP ' + f) >= 0))) break;
      }
      const texts = Array.from(seen.values());
      for (const f of WANT) assert.ok(texts.some((t) => t.indexOf('TCP ' + f) >= 0), `${f} drawn: ${texts.join(' | ')}`);
      assert.ok(checked >= 4, `checked ${checked}`);
    } finally {
      await page.close();
    }
  });
}
