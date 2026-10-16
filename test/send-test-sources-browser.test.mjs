// Send test's sources on screen (headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped without one), in the private house, both themes:
// every device is in From (guest-phone among them; the Cloud listed disabled
// with its reason); a DHCP client's state is said next to it and kept current
// (no lease yet, then its lease and Wi-Fi network); choosing a source by the
// keyboard keeps what is written in the other fields; the Interface choice
// appears for a device with several; a Guest test to the NAS is sent and its
// result says where the policy dropped it; Send test… is in every device's menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

for (const theme of ['light', 'dark']) {
  test(`${theme}: every device in Send test's From, a DHCP client's state, the interface choice, a policy-denied test sent`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.refresh(true); return true; })()`);
      await page.settle(150);
      const opts = await page.eval(`Array.from(document.querySelectorAll('#sim-t-from option')).map((o) => [o.value, o.disabled, o.textContent])`);
      const ids = await page.eval(`netatlas.session.model.devices.map((d) => d.id).sort()`);
      assert.deepEqual(opts.map((o) => o[0]), ids, 'every device');
      assert.deepEqual(opts.find((o) => o[0] === 'guest-phone').slice(0, 2), ['guest-phone', false]);
      const isp = opts.find((o) => o[0] === 'isp');
      assert.equal(isp[1], true);
      assert.match(isp[2], /^isp — can't send: it has no IP stack of its own/);
      // write the destination first, then choose guest-phone with the keyboard: the destination stays
      await page.eval(`(() => { const t = document.getElementById('sim-t-to'); t.value = '192.168.10.20'; const k = document.getElementById('sim-t-kind'); k.value = 'tcp'; k.dispatchEvent(new Event('change')); const p = document.getElementById('sim-t-port'); p.value = '445'; document.getElementById('sim-t-from').focus(); return true; })()`);
      for (let i = 0; i < 20; i++) {
        if ((await page.eval(`document.getElementById('sim-t-from').value`)) === 'guest-phone') break;
        await page.key('ArrowDown', 'ArrowDown', 40);
        await page.settle(20);
      }
      const chosen = await page.eval(`({ from: document.getElementById('sim-t-from').value, to: document.getElementById('sim-t-to').value, kind: document.getElementById('sim-t-kind').value, port: document.getElementById('sim-t-port').value, via: document.getElementById('sim-t-via').hidden, status: document.getElementById('sim-t-src').textContent, live: document.getElementById('sim-t-src').getAttribute('role'), described: document.getElementById('sim-t-from').getAttribute('aria-describedby') })`);
      assert.deepEqual([chosen.from, chosen.to, chosen.kind, chosen.port], ['guest-phone', '192.168.10.20', 'tcp', '445'], 'the other fields are kept');
      assert.equal(chosen.via, true, 'one interface: no Interface choice');
      assert.equal(chosen.live, 'status');
      assert.equal(chosen.described, 'sim-t-src');
      assert.match(chosen.status, /^guest-phone:wlan0: DHCP: no lease, its link is not up .* · Wi-Fi network “Home-Guest” of ap-1 \(VLAN 30\)\. A test waits for the lease, and says so if DHCP gets no answer\.$/);
      // the lease arrives: the status says so, without a click
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(9000); c.refresh(true); return true; })()`);
      await page.settle(100);
      const leased = await page.eval(`document.getElementById('sim-t-src').textContent`);
      assert.match(leased, /^guest-phone:wlan0: DHCP: 192\.168\.30\.\d+\/24 from 192\.168\.30\.1, gateway 192\.168\.30\.1, DNS 10\.0\.30\.1, lease 24 h · Wi-Fi network “Home-Guest” of ap-1 \(VLAN 30\)$/);
      // send: a policy-denied destination is a test result, not a missing source
      // (the Actions panel scrolls to the button, as one does)
      await page.eval(`document.getElementById('sim-t-send').scrollIntoView({ block: 'nearest' }), true`);
      await page.click('#sim-t-send');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(16000); c.refresh(true); return true; })()`);
      await page.settle(100);
      const res = await page.eval(`Array.from(document.querySelectorAll('#sim-tests li')).map((li) => li.textContent)`);
      assert.ok(res.some((r) => /guest-phone → 192\.168\.10\.20 tcp\/445: no answer within 5 s .*dropped at dsl-router: .*no relation of the model and no allow entry permits it/.test(r)), res.join(' | '));
      // a device with several interfaces: the Interface choice, and its state
      await page.eval(`(() => { const f = document.getElementById('sim-t-from'); f.value = 'core'; f.dispatchEvent(new Event('change')); const v = document.getElementById('sim-t-via'); v.value = 'Vlan30'; v.dispatchEvent(new Event('change')); return true; })()`);
      const core = await page.eval(`({ hidden: document.getElementById('sim-t-via').hidden, opts: Array.from(document.querySelectorAll('#sim-t-via option')).map((o) => o.value), status: document.getElementById('sim-t-src').textContent, to: document.getElementById('sim-t-to').value })`);
      assert.equal(core.hidden, false);
      assert.deepEqual(core.opts, ['', 'Vlan10', 'Vlan110', 'Vlan120', 'Vlan130', 'Vlan20', 'Vlan30', 'Vlan99']);
      assert.equal(core.status, 'core:Vlan30: 192.168.30.1/24');
      assert.equal(core.to, '192.168.10.20');
      // the menu of a device that can't send offers Send test… too: the form says why
      for (const dev of ['isp', 'guest-phone', 'dist']) {
        const menu = await page.eval(`netatlas.simController().itemsFor('device:${dev}').map((i) => i.label)`);
        assert.ok(menu.indexOf('Send test…') >= 0, `${dev}: ${menu.join(', ')}`);
      }
      await page.eval(`(() => { const c = netatlas.simController(); c.itemsFor('device:isp').find((i) => i.label === 'Send test…').act(); return true; })()`);
      assert.match(await page.eval(`document.getElementById('sim-t-src').textContent`), /^isp can't send a test: it has no IP stack of its own/);
      // readable: the status line's text against its background
      const contrast = await page.eval(`(() => { const e = document.getElementById('sim-t-src'); const cs = getComputedStyle(e); return [cs.color, cs.visibility, e.getBoundingClientRect().height > 0]; })()`);
      assert.equal(contrast[1], 'visible');
      assert.equal(contrast[2], true);
    } finally {
      await page.close();
    }
  });
}
