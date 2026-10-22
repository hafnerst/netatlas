// Network events on screen (headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped without one), in the private house, both themes,
// a wide and a narrow window: the five actions in order with their own forms
// (no object to choose first, no table viewer among them; the tables stay in
// the diagram's menus and the panel's status side); Active events below
// them, one event per operation with its state, progress, outcome and
// controls; the diagram's selection never overwrites a form; the focus and
// open details stay put while events update; nothing wider than the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

const EVENTS = `Array.from(document.querySelectorAll('#sim-events > li')).map((li) => ({ act: li.getAttribute('data-act'), kind: li.getAttribute('data-kind') || li.getAttribute('data-event'), status: li.getAttribute('data-status'), title: (li.querySelector('.sim-ev-title') || {}).textContent, word: (li.querySelector('.sim-ev-status') || {}).textContent, icon: (li.querySelector('.sim-ev-icon') || {}).textContent, summary: (li.querySelector('.sim-ev-summary') || {}).textContent, buttons: Array.from(li.querySelectorAll(':scope > .sim-ev-actions > button')).map((b) => b.textContent) }))`;

for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 640]]) {
  test(`${theme}, ${width} px: Network events: four direct actions, then Active events with one event per operation; the selection never overwrites a form; focus and details kept on updates`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width, height: 900 });
    const set = (id, v, ev = 'change') => page.call((id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev)); return true; }, id, v, ev);
    const click = async (id) => {
      await page.eval(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'nearest' }), true`);
      await page.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`);
      await page.settle(40);
    };
    const run = (ms) => page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + ${ms}); c.refresh(true); return true; })()`);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.runTo(9000); c.refresh(true); if (document.getElementById('spt-actions')) document.getElementById('spt-actions').click(); return true; })()`);
      await page.settle(150);
      // the structure: five actions in order, each a heading with its button; no object list; Active events after them
      const S = await page.eval(`(() => { const net = document.getElementById('sim-act-net'); return {
        actions: Array.from(net.querySelectorAll('.sim-ne-h button')).map((b) => [b.querySelector('span:last-child').textContent, b.getAttribute('aria-expanded'), b.getAttribute('aria-controls')]),
        heading: Array.from(net.querySelectorAll('.sim-ne-h')).every((h) => h.tagName === 'H4'),
        obj: !!document.getElementById('sim-obj'), shows: /Show /.test(net.textContent),
        after: !!(net.compareDocumentPosition(document.getElementById('sim-act-events')) & Node.DOCUMENT_POSITION_FOLLOWING),
        none: document.getElementById('sim-failed').textContent }; })()`);
      assert.deepEqual(S.actions, [['Send network packets', 'true', 'sim-ne-send'], ['Join multicast group', 'false', 'sim-ne-join'], ['Leave multicast group', 'false', 'sim-ne-leave'], ['Start multicast stream', 'false', 'sim-ne-stream'], ['Interface actions', 'false', 'sim-ne-iface'], ['Start application', 'false', 'sim-ne-app']]);
      assert.deepEqual([S.heading, S.obj, S.shows, S.after], [true, false, false, true]);
      assert.equal(S.none, 'None yet: start one above, or from the diagram’s menus.');
      // the tables stay where they belong: the device's menu, the panel's status side
      assert.ok((await page.eval(`netatlas.simController().itemsFor('device:core').map((i) => i.label)`)).indexOf('Show ARP table') >= 0);
      await page.eval(`netatlas.simController().showTable('arp', 'core'), true`);
      await page.settle(60);
      assert.equal(await page.eval(`document.querySelector('#sd-sttabs [aria-pressed="true"]').textContent`), 'ARP');
      // open the other three; each chooses its own device and interface, with Select… first
      for (const id of ['sim-ne-join-toggle', 'sim-ne-stream-toggle', 'sim-ne-iface-toggle']) await click(id);
      const F = await page.eval(`['sim-j', 'sim-s', 'sim-i'].map((p) => [document.getElementById(p + '-dev').value, document.getElementById(p + '-if').disabled, document.getElementById(p + '-need').textContent])`);
      assert.deepEqual(F, [['', true, 'Choose a host.'], ['', true, 'Choose a host.'], ['', true, 'Choose a device.']]);
      assert.equal(await page.eval(`document.getElementById('sim-i-shut').disabled && document.getElementById('sim-i-flap').disabled && document.getElementById('sim-j-go').disabled`), true);
      // the join form: the TV's Wi-Fi interface (its one, chosen and shown), a group
      await set('sim-j-dev', 'tv');
      assert.match(await page.eval(`document.getElementById('sim-j-if').selectedOptions[0].textContent`), /^wlan0 - 192\.168\.20\.\d+ \(DHCP\)$/);
      await set('sim-j-group', '239.1.1.1', 'input');
      // the diagram's selection does not overwrite what was chosen
      await page.eval(`netatlas.select('device:nas'), true`);
      await page.settle(60);
      assert.deepEqual(await page.eval(`[document.getElementById('sim-j-dev').value, document.getElementById('sim-j-group').value]`), ['tv', '239.1.1.1']);
      assert.equal(await page.eval(`document.getElementById('sim-j-need').textContent`), '');
      await click('sim-j-go');
      // a stream from the NAS; a shut and a flap on the core's port; a series of pings
      await set('sim-s-dev', 'nas');
      await set('sim-s-group', '239.1.1.1', 'input');
      assert.equal(await page.eval(`document.getElementById('sim-s-need').textContent`), 'Enter the UDP port.');
      await set('sim-s-port', '5004', 'input');
      await click('sim-s-go');
      // (ports off the laptop's way to the NAS: the core's uplink to the DSL router, dist's port to ap-1)
      const port = 'wan';
      await set('sim-i-dev', 'core');
      await set('sim-i-if', port);
      assert.match(await page.eval(`document.getElementById('sim-i-times').textContent`), /^Flapping: down 5 s, up 10 s, 3 cycles \(the Layer 1 parameters of the setup\)\.$/);
      await click('sim-i-flap');
      // flapping: not twice; its button is Stop flapping now
      assert.equal(await page.eval(`document.getElementById('sim-i-flap').textContent`), 'Stop flapping');
      assert.equal(await page.eval(`document.getElementById('sim-i-need').textContent`), 'Shut interface stops the flapping first.');
      const other = 'ap1';
      await set('sim-i-dev', 'dist');
      await set('sim-i-if', other);
      await click('sim-i-shut');
      await page.eval(`(() => { const set = (id, v, ev) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(ev || 'change')); }; set('sim-t-type', 'unicast'); set('sim-t-from', 'laptop'); set('sim-t-to', 'nas'); set('sim-t-kind', 'icmp'); set('sim-t-count', '10', 'input'); return true; })()`);
      await click('sim-t-send');
      let E = await page.eval(EVENTS);
      assert.deepEqual(E.map((e) => e.title), ['Send network packets', 'Shut interface', 'Flapping', 'Multicast stream', 'Join multicast group'], JSON.stringify(E));
      // states as they are: the send queued? no: sent at once, in progress; the shut completed at once, the interface down; the join waiting for a router
      const by = (k) => E.find((e) => e.kind === k);
      assert.deepEqual([by('send').status, by('send').word, by('send').icon], ['running', 'In progress', '▶']);
      assert.deepEqual([by('shut').status, by('shut').word, by('shut').icon], ['completed', 'Completed', '✓']);
      assert.match(by('shut').summary, /interface down \(shut\)$/);
      assert.deepEqual(by('shut').buttons, ['No shut']);
      assert.deepEqual(by('flap').buttons, ['Stop flapping']);
      assert.deepEqual(by('stream').buttons, ['Stop stream']);
      // a progress bar with its numbers, named
      assert.deepEqual(await page.eval(`(() => { const p = document.querySelector('#sim-events li[data-kind="send"] progress'); return [p.value, p.max, p.getAttribute('aria-label')]; })()`), [1, 10, '1 of 10 sent']);
      // paused: nothing moves on, nothing is completed by itself
      await page.settle(500);
      assert.equal((await page.eval(EVENTS)).find((e) => e.kind === 'send').status, 'running');
      // the details open, the focus on them: kept while the events update
      await page.eval(`(() => { const d = document.querySelector('#sim-events li[data-kind="send"] details'); d.open = true; d.querySelector('summary').focus(); return true; })()`);
      for (let i = 0; i < 4; i++) await run(1000);
      const keep = await page.eval(`(() => { const a = document.activeElement; const li = a.closest('li'); return [a.tagName, li && li.getAttribute('data-kind'), li.querySelector('details').open, li.querySelector('progress').value]; })()`);
      assert.deepEqual(keep, ['SUMMARY', 'send', true, 5]);
      // the details: the basis of the success rate, the messages; the inspector opens from there
      const det = await page.eval(`Array.from(document.querySelectorAll('#sim-events li[data-kind="send"] details li')).map((x) => x.textContent)`);
      assert.ok(det.some((d) => /^Success: answered/.test(d)) && det.some((d) => /^#1 at t = 9 s: Echo Reply from 192\.168\.10\.20$/.test(d)), det.join(' | '));
      await page.eval(`document.querySelector('#sim-events li[data-kind="send"] button[data-op="first"]').click(), true`);
      await page.settle(80);
      assert.ok(await page.eval(`!!document.querySelector('.sim-table-panel[data-table="packet"] .pi')`), 'the packet inspector');
      await page.eval(`document.querySelector('.sim-table-panel[data-table="packet"] .st-close').click(), true`);
      // Stop on the stream: its button goes, the focus stays in its event
      await page.eval(`(() => { const b = document.querySelector('#sim-events li[data-kind="stream"] button[data-op="stop"]'); b.focus(); b.click(); return true; })()`);
      await page.settle(60);
      E = await page.eval(EVENTS);
      assert.deepEqual([by('stream') && E.find((e) => e.kind === 'stream').status, E.find((e) => e.kind === 'stream').word], ['stopped', 'Stopped']);
      assert.equal(await page.eval(`document.activeElement.closest('li') && document.activeElement.closest('li').getAttribute('data-kind')`), 'stream');
      // No shut: completed stays completed; the state says the interface is up again
      await page.eval(`document.querySelector('#sim-events li[data-kind="shut"] button[data-op="noshut"]').click(), true`);
      await run(10000);
      E = await page.eval(EVENTS);
      assert.match(E.find((e) => e.kind === 'shut').summary, /interface up again \(no shut at t = [\d.]+ s\)$/);
      assert.equal(E.find((e) => e.kind === 'send').status, 'completed');
      assert.match(await page.eval(`document.querySelector('#sim-events li[data-kind="send"] .sim-ev-bar').getAttribute('aria-label')`), /^Outcome of 10 messages: 10 succeeded, 0 failed, 0 pending; 100 % of those finished succeeded$/);
      // a failed cable from the diagram's menu: in the same list, with Restore
      await page.eval(`netatlas.simController().failLink('link:' + netatlas.session.model.links[0].id), true`);
      await run(100);
      E = await page.eval(EVENTS);
      assert.ok(E.some((e) => e.kind === 'fail' && e.buttons[0] === 'Restore'), JSON.stringify(E));
      // Clear finished: what is in progress stays (the flapping); the states in effect too: the failed cable, and the
      // TV's membership (its join completed and cleared, the membership with Leave group)
      await page.eval(`document.getElementById('sim-ev-clear').click(), true`);
      await page.settle(60);
      E = await page.eval(EVENTS);
      assert.deepEqual(E.map((e) => e.kind).sort(), ['fail', 'flap', 'join']);
      assert.deepEqual(E.find((e) => e.kind === 'join').buttons, ['Leave group']);
      assert.equal(E.find((e) => e.kind === 'join').status, 'state');
      assert.equal(await page.eval(`document.activeElement.id`), 'sim-act-events-h');
      // nothing wider than the panel, the page not scrolling sideways; the bar and status readable (not colour alone)
      const wide = await page.eval(`(() => { const box = document.getElementById('sim-actions').getBoundingClientRect(); return Array.from(document.querySelectorAll('#sim-actions *')).filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > box.right + 1).map((e) => e.id || e.className || e.tagName); })()`);
      assert.deepEqual(wide, []);
      assert.equal(await page.eval(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
      // every control of the actions named
      const unnamed = await page.eval(`Array.from(document.querySelectorAll('#sim-act-net select, #sim-act-net input, #sim-act-net button, #sim-act-events button')).filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.textContent.trim()).map((e) => e.id)`);
      assert.deepEqual(unnamed, []);
    } finally {
      await page.close();
    }
  });
}
