// The Send test form on screen (headless Chrome/Edge/Chromium through the
// DevTools protocol; skipped without one), in the private house, both themes:
// the delivery type first (From and To disabled until then, Send too, with a
// short reason); every device in From (the ISP listed disabled, "Cannot send
// IP packets"); interfaces as options "name - address" (a DHCP client's lease
// as it is now; one interface as text, no long summary); the destination's
// interface (several: a choice; one: shown); protocols by delivery type, a
// port only for TCP and UDP, cleared when it stops applying; the message
// count and interval; a series listed with its counts and Stop; every control
// named; Send test… from a device's menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './helpers.mjs';
import { findBrowser } from '../scripts/browser-selftest.mjs';
import { openPage } from '../scripts/cdp.mjs';

const url = pathToFileURL(join(root, 'build', 'netatlas-test.html')).href;
const skip = findBrowser() ? false : 'no Chromium-based browser found (set NETATLAS_BROWSER)';

/** The form's state: what is shown, enabled and chosen, and what blocks Send. */
const STATE = `(() => {
  const g = (id) => document.getElementById(id);
  const row = (id) => !g(id).closest('[data-row]').hidden && !g(id).hidden;
  const opts = (id) => Array.from(g(id).options).map((o) => (o.disabled ? '(' + o.textContent + ')' : o.textContent));
  return {
    type: g('sim-t-type').value, help: !g('sim-t-type-help').hidden,
    from: g('sim-t-from').value, fromOff: g('sim-t-from').disabled, toOff: g('sim-t-to').disabled,
    via: row('sim-t-via') ? opts('sim-t-via') : null, viaValue: g('sim-t-via').value, viaOne: row('sim-t-via-one') ? g('sim-t-via-one').textContent : null,
    to: row('sim-t-to') ? g('sim-t-to').value : null, toif: row('sim-t-toif') ? opts('sim-t-toif') : null, toifValue: g('sim-t-toif').value, toifOne: row('sim-t-toif-one') ? g('sim-t-toif-one').textContent : null,
    addr: row('sim-t-addr'), group: row('sim-t-group') ? g('sim-t-group').value : null, scope: row('sim-t-scope') ? opts('sim-t-scope') : null, subnet: row('sim-t-subnet') ? g('sim-t-subnet').value : null,
    kinds: row('sim-t-kind') ? opts('sim-t-kind') : null, kind: g('sim-t-kind').value,
    port: row('sim-t-port') ? g('sim-t-port').value : null, portValue: g('sim-t-port').value,
    count: row('sim-t-count') ? g('sim-t-count').value : null, intervalOff: g('sim-t-interval').disabled,
    need: g('sim-t-need').textContent, send: !g('sim-t-send').disabled, msg: g('sim-t-msg').textContent,
    longHelp: !!g('sim-t-src'),
  };
})()`;

for (const theme of ['light', 'dark']) {
  test(`${theme}: Send test asks for the delivery type first, then only what it uses; concise interface options; ports only where they apply; a series with Stop`, { skip, timeout: 240000 }, async () => {
    const page = await openPage(url, { width: 1440, height: 900 });
    const set = (id, v, ev = 'change') => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)})); return true; })()`);
    const st = () => page.eval(STATE);
    try {
      await page.settle(150);
      await page.eval(`localStorage.clear(), sessionStorage.clear(), netatlas.theme.set('${theme}'), netatlas.loadExampleNamed('private-house.yaml'), netatlas.setView('physical'), true`);
      await page.settle(150);
      await page.eval(`(() => { netatlas.startProtocolSimulation({ params: {} }); const c = netatlas.simController(); c.setPlaying(false); c.refresh(true); return true; })()`);
      await page.settle(150);
      // nothing chosen: the delivery type first; From and To disabled (and greyed), Send too
      let s = await st();
      assert.equal(s.type, '');
      assert.equal(s.help, true);
      assert.deepEqual([s.fromOff, s.toOff, s.send], [true, true, false]);
      assert.equal(s.kinds, null, 'no protocol before the delivery type');
      assert.equal(s.need, '', 'the hint above says it once');
      assert.equal(s.longHelp, false, 'no summary line of interfaces');
      const grey = await page.eval(`[getComputedStyle(document.getElementById('sim-t-from')).opacity, getComputedStyle(document.querySelector('label[for="sim-t-from"]')).opacity]`);
      assert.ok(Number(grey[0]) < 1 && Number(grey[1]) < 1, grey.join(','));
      assert.equal(await page.eval(`document.getElementById('sim-t-from').getAttribute('aria-describedby')`), 'sim-t-type-help');
      // unicast: From and To enabled; every device in From, the ISP disabled with a short reason
      await set('sim-t-type', 'unicast');
      s = await st();
      assert.deepEqual([s.help, s.fromOff, s.toOff], [false, false, false]);
      assert.equal(s.need, 'Choose the device to send from.');
      const from = await page.eval(`Array.from(document.querySelectorAll('#sim-t-from option')).map((o) => [o.value, o.disabled, o.textContent])`);
      const ids = await page.eval(`netatlas.session.model.devices.map((d) => d.id).sort()`);
      assert.deepEqual(from.slice(1).map((o) => o[0]), ids, 'every device');
      assert.deepEqual(from.find((o) => o[0] === 'isp'), ['isp', true, 'isp — Cannot send IP packets']);
      assert.deepEqual(s.kinds, ['Select…', 'ICMP (ping)', 'TCP', 'UDP']);
      assert.equal(s.port, null, 'no port before a protocol');
      assert.equal(s.portValue, '', 'and none assumed');
      // the guest phone: one interface, shown as text: its DHCP state, then its lease
      await set('sim-t-from', 'guest-phone');
      s = await st();
      assert.equal(s.via, null);
      assert.equal(s.viaOne, 'wlan0 - No DHCP lease');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(9000); c.refresh(true); return true; })()`);
      s = await st();
      assert.match(s.viaOne, /^wlan0 - 192\.168\.30\.\d+ \(DHCP\)$/);
      // core: its interfaces as options "name - address"; for unicast also "Chosen by routing"
      await set('sim-t-from', 'core');
      s = await st();
      assert.deepEqual(s.via, ['Select…', 'Chosen by routing', 'Vlan10 - 192.168.10.1', 'Vlan110 - 10.0.10.2', 'Vlan120 - 10.0.20.2', 'Vlan130 - 10.0.30.2', 'Vlan20 - 192.168.20.1', 'Vlan30 - 192.168.30.1', 'Vlan99 - 192.168.99.1']);
      assert.equal(s.need, 'Choose the interface to send from.');
      await set('sim-t-via', 'Vlan30');
      // the destination: the guest phone's one interface shown; the DSL router's four a choice, cleared with another device
      await set('sim-t-to', 'guest-phone');
      s = await st();
      assert.equal(s.toif, null);
      assert.match(s.toifOne, /^wlan0 - 192\.168\.30\.\d+ \(DHCP\)$/);
      assert.equal(s.need, 'Choose a protocol.');
      await set('sim-t-to', 'dsl-router');
      s = await st();
      assert.deepEqual(s.toif, ['Select…', 'lan.110 - 10.0.10.1', 'lan.120 - 10.0.20.1', 'lan.130 - 10.0.30.1', 'wan - 203.0.113.10']);
      assert.equal(s.need, 'Choose the destination interface.');
      await set('sim-t-toif', 'wan|203.0.113.10');
      await set('sim-t-to', 'nas');
      s = await st();
      assert.equal(s.toifOne, 'eth0 - 192.168.10.20');
      assert.equal(s.toifValue, 'eth0|192.168.10.20', 'the other device’s interface is gone');
      await set('sim-t-to', 'dsl-router');
      assert.equal((await st()).toifValue, '', 'nothing carried over to a device with several');
      // "Address or host name…": a text field
      await set('sim-t-to', '*');
      assert.equal((await st()).addr, true);
      await set('sim-t-to', 'nas');
      // the protocol: a port only for TCP and UDP, emptied when it stops applying
      await set('sim-t-kind', 'tcp');
      s = await st();
      assert.equal(s.port, '');
      assert.equal(s.need, 'Enter the destination port.');
      assert.equal(s.send, false);
      await set('sim-t-port', '445', 'input');
      s = await st();
      assert.deepEqual([s.need, s.send], ['', true]);
      await set('sim-t-kind', 'icmp');
      s = await st();
      assert.deepEqual([s.port, s.portValue], [null, '']);
      await set('sim-t-kind', 'udp');
      assert.equal((await st()).port, '', 'the old port is not back');
      // messages: one, the interval greyed; several, the interval applies
      s = await st();
      assert.deepEqual([s.count, s.intervalOff], ['1', true]);
      await set('sim-t-count', '3', 'input');
      assert.equal((await st()).intervalOff, false);
      await set('sim-t-count', '0', 'input');
      await set('sim-t-port', '53', 'input');
      assert.equal((await st()).need, 'The number of messages is a whole number from 1 to 1000.');
      await set('sim-t-count', '1', 'input');
      // another delivery type: what doesn't fit is cleared (no TCP for a group, the destination), what fits stays
      await set('sim-t-kind', 'tcp');
      await set('sim-t-port', '445', 'input');
      await set('sim-t-via', '*');
      assert.equal((await st()).need, '', 'Chosen by routing: a unicast source');
      await set('sim-t-type', 'multicast');
      s = await st();
      assert.deepEqual(s.kinds, ['Select…', 'UDP']);
      assert.deepEqual([s.kind, s.port, s.portValue, s.to, s.group], ['', null, '', null, '']);
      assert.equal(s.viaValue, '', 'Chosen by routing is no source for a group');
      assert.ok(s.via.indexOf('Chosen by routing') < 0);
      await set('sim-t-kind', 'udp');
      await set('sim-t-port', '5004', 'input');
      await set('sim-t-type', 'broadcast');
      s = await st();
      assert.deepEqual([s.kind, s.portValue], ['udp', '5004'], 'UDP and its port fit a broadcast too');
      assert.deepEqual(s.kinds, ['Select…', 'ICMP (ping)', 'UDP']);
      await set('sim-t-from', 'laptop');
      s = await st();
      assert.deepEqual(s.scope, ['Select…', 'Limited (255.255.255.255)', 'Subnet (192.168.10.255)']);
      await set('sim-t-type', 'directed');
      s = await st();
      assert.equal(s.subnet, '');
      await set('sim-t-subnet', '192.168.30.0/24', 'input');
      assert.deepEqual([(await st()).need, (await st()).send], ['', true]);
      await set('sim-t-subnet', '10.9.9.0/24', 'input');
      assert.equal((await st()).need, '10.9.9.255 is not the broadcast address of a subnet of the model.');
      await set('sim-t-type', 'unicast');
      assert.equal((await st()).to, '', 'the destination starts empty again');
      // the guest phone to the NAS on TCP 445: sent, dropped by the DSL router's policy
      await set('sim-t-from', 'guest-phone');
      await set('sim-t-to', 'nas');
      await set('sim-t-kind', 'tcp');
      await set('sim-t-port', '445', 'input');
      await page.eval(`document.getElementById('sim-t-send').scrollIntoView({ block: 'nearest' }), true`);
      await page.click('#sim-t-send');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 7000); c.refresh(true); return true; })()`);
      await page.settle(100);
      let res = await page.eval(`Array.from(document.querySelectorAll('#sim-tests li')).map((li) => li.textContent)`);
      assert.ok(res.some((r) => /guest-phone → nas tcp\/445: no answer within 5 s .*dropped at dsl-router: .*no relation of the model and no allow entry permits it/.test(r)), res.join(' | '));
      // a series: three pings a second apart, listed with its counts and Stop until the last is sent
      await set('sim-t-from', 'laptop');
      await set('sim-t-to', 'nas');
      await set('sim-t-kind', 'icmp');
      await set('sim-t-count', '3', 'input');
      await set('sim-t-interval', '1', 'input');
      await page.eval(`document.getElementById('sim-t-send').scrollIntoView({ block: 'nearest' }), true`);
      await page.click('#sim-t-send');
      assert.match(await page.eval(`document.getElementById('sim-t-msg').textContent`), /^Message 1 of 3 sent at t = [\d.]+ s, then one every 1 s: laptop → nas ICMP echo\. It starts when the simulation plays\.$/);
      res = await page.eval(`(() => { const li = document.querySelector('#sim-tests li'); const b = li.querySelector('button'); return [li.textContent, b ? b.textContent : null, b ? b.getAttribute('aria-label') : null]; })()`);
      assert.match(res[0], /laptop → nas ICMP echo, 3 messages every 1 s: 1 of 3 sent, 1 on its way/);
      assert.deepEqual(res.slice(1), ['Stop', 'Stop laptop → nas ICMP echo (1 of 3 sent)']);
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 5000); c.refresh(true); return true; })()`);
      res = await page.eval(`(() => { const li = document.querySelector('#sim-tests li'); return [li.textContent, !!li.querySelector('button'), li.getAttribute('data-ok')]; })()`);
      assert.match(res[0], /3 of 3 sent, 3 answered\. Latest: Echo Reply from 192\.168\.10\.20/);
      assert.deepEqual(res.slice(1), [false, 'true']);
      // Stop: a longer series stops where it is
      await set('sim-t-count', '20', 'input');
      await page.click('#sim-t-send');
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 2500); c.refresh(true); return true; })()`);
      await page.eval(`document.querySelector('#sim-tests li button').click(), true`);
      await page.eval(`(() => { const c = netatlas.simController(); c.runTo(c.t + 30000); c.refresh(true); return true; })()`);
      res = await page.eval(`document.querySelector('#sim-tests li').textContent`);
      assert.match(res, /: 3 of 20 sent, 3 answered, stopped at t = /);
      // every control of the form has a name; nothing in it is wider than the panel
      const unnamed = await page.eval(`Array.from(document.querySelectorAll('#sim-test select, #sim-test input, #sim-test button')).filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.textContent.trim()).map((e) => e.id)`);
      assert.deepEqual(unnamed, []);
      const wide = await page.eval(`(() => { const box = document.getElementById('sim-test').getBoundingClientRect(); return Array.from(document.querySelectorAll('#sim-test *')).filter((e) => e.getBoundingClientRect().right > box.right + 1).map((e) => e.id || e.tagName); })()`);
      assert.deepEqual(wide, []);
      // Send test… in a device's menu: it becomes the source; one that can't send says so in a few words
      await page.eval(`(() => { const c = netatlas.simController(); c.itemsFor('device:isp').find((i) => i.label === 'Send test…').act(); return true; })()`);
      s = await st();
      assert.equal(s.from, 'isp');
      assert.equal(s.need, 'isp: Cannot send IP packets.');
      assert.equal(s.send, false);
    } finally {
      await page.close();
    }
  });
}
